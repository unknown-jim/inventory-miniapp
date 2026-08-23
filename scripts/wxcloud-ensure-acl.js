const path = require('path')
const env = require('./wxcloud-env')
const indexes = require('./wxcloud-ensure-indexes')

const root = path.join(__dirname, '..')

// 与 docs/cloud-ledger.md 必须一致。ADMINONLY = 仅管理端可读写。
// platform_admins 是运维白名单（_id = openid），漏设 ADMINONLY 等于把名单暴露给客户端。
const COLLECTIONS = ['shops', 'members', 'ledgers', 'ledger_records', 'ledger_clears', 'platform_admins']
const ACL_TAG = 'ADMINONLY'

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

async function main() {
  env.loadDotEnv(root)
  env.requirePrivateKey()
  const wx = loadWxcloud()
  const state = await ensureLogin(wx)
  wx.initCloudAPI(state.appid)
  const db = await indexes.resolveDb(wx)
  console.log('env', db.envId)
  await ensureAcl(wx.api, { envId: db.envId })
}

module.exports = {
  COLLECTIONS: COLLECTIONS,
  ACL_TAG: ACL_TAG,
  collectionsNeedingAcl: collectionsNeedingAcl,
  ensureAcl: ensureAcl,
  describeAcl: describeAcl
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error.message || error)
    process.exit(1)
  })
}
