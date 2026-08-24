const path = require('path')
const env = require('./wxcloud-env')
const indexes = require('./wxcloud-ensure-indexes')

const root = path.join(__dirname, '..')

// 与 docs/cloud-ledger.md 必须一致。ADMINONLY = 仅管理端可读写。
// platform_admins 是运维白名单（_id = openid），漏设 ADMINONLY 等于把名单暴露给客户端。
// platform_config 是平台级维护开关，漏设 ADMINONLY 等于让客户端能直接改开关。
const COLLECTIONS = ['shops', 'members', 'ledgers', 'ledger_records', 'ledger_clears', 'platform_admins', 'platform_config']
const ACL_TAG = 'ADMINONLY'

// 云存储（商品图）的 ACL。READWRITE = 所有用户可读、仅创建者可写读：
// 店员客户端要能直接拿 cloud:// fileID 渲染 <image>（可读），
// 上传者是创建者所以能传（可写）——上传在客户端做，不绕云函数。
const STORAGE_ACL_TAG = 'READWRITE'

function collectionsNeedingAcl(currentByName, wanted, tag) {
  const names = wanted || COLLECTIONS
  const expect = tag || ACL_TAG
  return names.filter(function (name) {
    return String((currentByName && currentByName[name]) || '') !== expect
  })
}

function loadWxcloud() {
  const cliRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@wxcloud', 'cli')
  try {
    return {
      api: require(path.join(cliRoot, 'lib/api/cloudapi/src/index')),
      initCloudAPI: require(path.join(cliRoot, 'lib/api/adapter')).initCloudAPI,
      readLoginState: require(path.join(cliRoot, 'lib/utils/auth')).readLoginState
    }
  } catch (error) {
    throw new Error('未找到 @wxcloud/cli。先执行 npm install -g @wxcloud/cli，再 node scripts/wxcloud-login.js')
  }
}

async function ensureLogin(wx) {
  try {
    const state = await wx.readLoginState()
    if (state && state.appid) return state
  } catch (error) {
    /* not logged in */
  }
  const { spawnSync } = require('child_process')
  const login = spawnSync(process.execPath, [path.join(__dirname, 'wxcloud-login.js')], {
    stdio: 'inherit'
  })
  if (login.status) process.exit(login.status)
  return wx.readLoginState()
}

async function describeAcl(api, envId, collectionName) {
  const res = await api.tcbDescribeDatabaseACL({
    envId: envId,
    collectionName: collectionName
  })
  return res && res.aclTag
}

// 逐张设权限。**一张失败不许带走整轮**，这条是吃过亏改的：
//
// 从前 describeAcl 没有 catch、ensureAcl 也没有，于是清单里只要有一张集合还没建
// 出来（新增 platform_config 那次就是），第一次 describe 就抛出去、调用方
// `main().catch` 里 exit(1) —— 而在 wxcloud-deploy-ledger.js 里，那一刻函数代码
// 已经上传、索引已经补完，却停在 ensureStorageAcl **之前**，云存储权限没设，
// 商品图渲染不出来。一张表的小问题炸掉了整条部署路径的后半段。
//
// 现在的做法：describe 失败**不当结论**，直接去试 modify（幂等，本来就要设）；
// modify 也失败就记进 failed 继续下一张，**跑完再由调用方决定怎么报**。
// 这样后面的步骤（云存储 ACL）一定跑得到，而失败又不会被悄悄咽下去
// —— 悄悄咽下去比抛出去更危险：一张业务表没设成 ADMINONLY，就是把客户端
// 挡在外面的那道门开了，而没人会发现。**调用方必须检查 failed。**
async function ensureAcl(api, opts) {
  const envId = opts.envId
  const wanted = opts.collections || COLLECTIONS
  const tag = opts.aclTag || ACL_TAG
  const updated = []
  const skipped = []
  const failed = []
  for (let i = 0; i < wanted.length; i++) {
    const name = wanted[i]
    let current = null
    try {
      current = await describeAcl(api, envId, name)
    } catch (error) {
      // 读不到当前值可能是集合不存在，也可能是一次瞬时失败。两种都不是结论 ——
      // 下面照样试着设一次，让 modify 去回答「这张集合到底在不在」。
      console.log('acl describe failed', name, error.message || error)
    }
    if (current === tag) {
      console.log('acl already', tag, name)
      skipped.push(name)
      continue
    }
    try {
      await api.tcbModifyDatabaseACL({
        envId: envId,
        collectionName: name,
        aclTag: tag
      })
    } catch (error) {
      console.warn('acl set FAILED', name, error.message || error)
      failed.push({ name: name, error: String((error && error.message) || error) })
      continue
    }
    console.log('acl set', tag, name, 'was', current)
    updated.push(name)
  }
  return { updated: updated, skipped: skipped, failed: failed }
}

// 调用方共用的报错口径：跑完全部集合、也跑完云存储之后再抛。
// 抛出来而不是只 warn —— 一张业务表没设成 ADMINONLY 是安全问题，不许静默通过。
function assertAclOk(result) {
  const failed = (result && result.failed) || []
  if (!failed.length) return result
  throw new Error('这几张集合的权限没设成 ' + ACL_TAG + '：'
    + failed.map(function (item) { return item.name + '（' + item.error + '）' }).join('、')
    + '。集合不存在就先建出来（node scripts/wxcloud-deploy-ledger.js 会建全部，'
    + '或 node scripts/wxcloud-ensure-platform-config.js 只建维护开关那张），再重跑本脚本。')
}

async function describeStorageAcl(api, envId) {
  const res = await api.tcbGetStorageACL({ envId: envId })
  return res && res.aclTag
}

// 云存储整库只有一份 ACL（不像集合逐张设）。幂等：已经是想要的 tag 就跳过；
// 改完再 describe 一次核对 —— Modify 在云上是异步任务，可能立即读还是旧值，
// 仍不一致就 warn 提示人工到开发者工具「云开发」面板确认，不硬重试。
// **不传 region**：和表 ACL 同一个坑（见 .cursor/skills/wxcloud-cli/SKILL.md）。
async function ensureStorageAcl(api, opts) {
  const envId = opts.envId
  const tag = opts.aclTag || STORAGE_ACL_TAG
  const current = await describeStorageAcl(api, envId)
  if (current === tag) {
    console.log('storage acl already', tag)
    return { updated: false, was: current }
  }
  await api.tcbModifyStorageACL({
    envId: envId,
    aclTag: tag
  })
  console.log('storage acl set', tag, 'was', current)
  const after = await describeStorageAcl(api, envId)
  if (after !== tag) {
    console.warn('storage acl 修改后核对仍不是 ' + tag + '（当前 ' + after
      + '），Modify 可能是异步任务，请稍后重跑或到开发者工具「云开发」面板人工确认')
  }
  return { updated: true, was: current, now: after }
}

async function main() {
  env.loadDotEnv(root)
  env.requirePrivateKey()
  const wx = loadWxcloud()
  const state = await ensureLogin(wx)
  wx.initCloudAPI(state.appid)
  const db = await indexes.resolveDb(wx)
  console.log('env', db.envId)
  // 先把两件事都做完，再报表 ACL 的失败：云存储权限不该被某一张集合的问题连累。
  const acl = await ensureAcl(wx.api, { envId: db.envId })
  await ensureStorageAcl(wx.api, { envId: db.envId })
  assertAclOk(acl)
}

module.exports = {
  COLLECTIONS: COLLECTIONS,
  ACL_TAG: ACL_TAG,
  STORAGE_ACL_TAG: STORAGE_ACL_TAG,
  collectionsNeedingAcl: collectionsNeedingAcl,
  ensureAcl: ensureAcl,
  assertAclOk: assertAclOk,
  describeAcl: describeAcl,
  describeStorageAcl: describeStorageAcl,
  ensureStorageAcl: ensureStorageAcl
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error.message || error)
    process.exit(1)
  })
}
