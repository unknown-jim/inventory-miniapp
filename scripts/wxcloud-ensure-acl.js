const path = require('path')
const env = require('./wxcloud-env')
const indexes = require('./wxcloud-ensure-indexes')

const root = path.join(__dirname, '..')

// 与 docs/cloud-ledger.md 必须一致。ADMINONLY = 仅管理端可读写。
// platform_admins 是运维白名单（_id = openid），漏设 ADMINONLY 等于把名单暴露给客户端。
const COLLECTIONS = ['shops', 'members', 'ledgers', 'ledger_records', 'ledger_clears', 'platform_admins']
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
  await ensureAcl(wx.api, { envId: db.envId })
  await ensureStorageAcl(wx.api, { envId: db.envId })
}

module.exports = {
  COLLECTIONS: COLLECTIONS,
  ACL_TAG: ACL_TAG,
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
