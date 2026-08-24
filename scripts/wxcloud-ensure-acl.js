const path = require('path')
const env = require('./wxcloud-env')
const indexes = require('./wxcloud-ensure-indexes')

const root = path.join(__dirname, '..')

// 与 docs/cloud-ledger.md 必须一致。ADMINONLY = 仅管理端可读写。
// platform_admins 是运维白名单（_id = openid），漏设 ADMINONLY 等于把名单暴露给客户端。
const COLLECTIONS = ['shops', 'members', 'ledgers', 'ledger_records', 'ledger_clears', 'platform_admins']
const ACL_TAG = 'ADMINONLY'

// 云存储（商品图）的 ACL。要的是「所有用户可读、仅创建者可读写」：
// 店员客户端要能直接拿 cloud:// fileID 渲染 <image>（可读），
// 上传者是创建者所以能传（可写）——上传在客户端做，不绕云函数。
//
// **它的标签叫 `READONLY`，不叫 `READWRITE`。** 这一条是 2026-08-25 在控制台
// 人工选中「所有用户可读，仅创建者可读写」之后、用 `tcbGetStorageACL` 读回来实测的：
//
//   控制台「所有用户可读，仅创建者可读写」 -> READONLY   ← 要的就是它
//   控制台「仅创建者可读写」             -> PRIVATE
//   控制台「所有用户可读」                 -> ADMINWRITE（**禁客户端直传**）
//   控制台「所有用户不可读写」             -> ADMINONLY
//
// 和上面表 ACL 那套词汇是同一套（见 docs/cloud-ledger.md 的标签对照），
// **`READWRITE` 根本不在这套词汇里**。写成 READWRITE 的后果不是报错就完事：
// 幂等判断会永远不相等，于是**每次部署都去改一次已经设对的权限**。
//
// 另：控制台给「所有用户可读」标的适用场景写着「文章配图、商品图片等」，
// 看上去正是我们要的，**但它把写权限收给了管理端**，客户端 `wx.cloud.uploadFile`
// 直传会失效。别被那行提示带偏。
const STORAGE_ACL_TAG = 'READONLY'

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

async function ensureAcl(api, opts) {
  const envId = opts.envId
  const wanted = opts.collections || COLLECTIONS
  const tag = opts.aclTag || ACL_TAG
  const updated = []
  const skipped = []
  for (let i = 0; i < wanted.length; i++) {
    const name = wanted[i]
    const current = await describeAcl(api, envId, name)
    if (current === tag) {
      console.log('acl already', tag, name)
      skipped.push(name)
      continue
    }
    await api.tcbModifyDatabaseACL({
      envId: envId,
      collectionName: name,
      aclTag: tag
    })
    console.log('acl set', tag, name, 'was', current)
    updated.push(name)
  }
  return { updated: updated, skipped: skipped }
}

// 云存储的桶名。`tcbGetStorageACL` / `tcbModifyStorageACL` 两个接口都**必须**带
// `Bucket`，不带当场报 `MissingParameter: The request is missing the required
// parameter \`Bucket\``。桶名从 `tcbGetEnvironments` 的 `storages[0].bucket` 取，
// 形如 `636c-<envId>-<uin>`，**推导不出来，只能问接口**。
//
// 这里踩过一次：原实现把表 ACL 那条「**不传 region**」的经验直接推广到了
// 存储 ACL 上，顺手把 `bucket` 也省了，于是部署脚本每次都红在最后一步。
// 两个参数不是同一回事：`region` 可省（实测带不带都返回同一个 `aclTag`），
// `bucket` 不可省。
async function resolveStorageBucket(api, envId) {
  const { envList } = await api.tcbGetEnvironments({})
  const cur = (envList || []).find(function (item) { return item.envId === envId })
  const bucket = cur && (cur.storages || [])[0] && cur.storages[0].bucket
  if (!bucket) {
    throw new Error('环境 ' + envId + ' 里没找到云存储桶（storages[0].bucket），'
      + '无法设存储权限')
  }
  return bucket
}

async function describeStorageAcl(api, envId, bucket) {
  const res = await api.tcbGetStorageACL({ envId: envId, bucket: bucket })
  return res && res.aclTag
}

// 云存储整库只有一份 ACL（不像集合逐张设）。幂等：已经是想要的 tag 就跳过；
// 改完再 describe 一次核对 —— Modify 在云上是异步任务，可能立即读还是旧值，
// 仍不一致就 warn 提示人工到开发者工具「云开发」面板确认，不硬重试。
// **region 可省，`bucket` 不可省**——别把这两个当成同一回事（见上面
// resolveStorageBucket 那段；表 ACL 那条「不传 region」见
// .cursor/skills/wxcloud-cli/SKILL.md）。
async function ensureStorageAcl(api, opts) {
  const envId = opts.envId
  const tag = opts.aclTag || STORAGE_ACL_TAG
  const bucket = opts.bucket || await resolveStorageBucket(api, envId)
  const current = await describeStorageAcl(api, envId, bucket)
  if (current === tag) {
    console.log('storage acl already', tag)
    return { updated: false, was: current }
  }
  try {
    await api.tcbModifyStorageACL({
      envId: envId,
      bucket: bucket,
      aclTag: tag
    })
  } catch (error) {
    // 套餐不允许改存储权限是**环境事实**，不是代码故障，不该把整条
    // 部署拖红（云函数本身已经部署成功了）。但后果得说清楚：
    // 2026-08-25 实测本环境返回 `OperationDenied.FreePackageDenied`，存储权限
    // 停在 `PRIVATE`（仅创建者可读写）。**那意味着同店另一个店员看不见
    // 同事传的商品图**——商品图功能在这个套餐下是残的，不是“以后再说”。
    // 其它错误照旧抛：它们才是真故障。
    const msg = String((error && (error.message || error.code)) || error || '')
    if (/FreePackageDenied|OperationDenied/i.test(msg)) {
      console.warn('storage acl 设不了（当前套餐不允许），仍是 ' + current + '：' + msg)
      console.warn('  后果：商品图只有**上传者自己**看得见，同店其他店员渲染不出来。')
      console.warn('  要么升级套餐、要么改成云函数发临时链接，两条都不是这个脚本能定的事。')
      return { updated: false, was: current, denied: true, error: msg }
    }
    throw error
  }
  console.log('storage acl set', tag, 'was', current)
  const after = await describeStorageAcl(api, envId, bucket)
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
  await ensureAcl(wx.api, { envId: db.envId })
  await ensureStorageAcl(wx.api, { envId: db.envId })
}

module.exports = {
  COLLECTIONS: COLLECTIONS,
  ACL_TAG: ACL_TAG,
  resolveStorageBucket: resolveStorageBucket,
  STORAGE_ACL_TAG: STORAGE_ACL_TAG,
  collectionsNeedingAcl: collectionsNeedingAcl,
  ensureAcl: ensureAcl,
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
