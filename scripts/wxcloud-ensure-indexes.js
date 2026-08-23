const path = require('path')
const env = require('./wxcloud-env')

const root = path.join(__dirname, '..')
const COLLECTION = 'ledger_records'

// 与 cloudfunctions/ledger/ledger-records.js 顶部注释、docs/cloud-ledger.md 必须一致。
// direction 用字符串 '1' / '-1'（升序 / 降序），这是 FlexDB UpdateTable 的合法值。
const INDEXES = [
  {
    indexName: 'bookId_sortKey',
    keys: [
      { name: 'bookId', direction: '1' },
      { name: 'sortKey', direction: '-1' }
    ]
  },
  {
    indexName: 'bookId_customerId_sortKey',
    keys: [
      { name: 'bookId', direction: '1' },
      { name: 'customerId', direction: '1' },
      { name: 'sortKey', direction: '-1' }
    ]
  },
  {
    indexName: 'bookId_type_sortKey',
    keys: [
      { name: 'bookId', direction: '1' },
      { name: 'type', direction: '1' },
      { name: 'sortKey', direction: '-1' }
    ]
  },
  {
    indexName: 'bookId_saleOrderId_sortKey',
    keys: [
      { name: 'bookId', direction: '1' },
      { name: 'saleOrderId', direction: '1' },
      { name: 'sortKey', direction: '1' }
    ]
  },
  {
    indexName: 'bookId_type_productId_skuId_sortKey',
    keys: [
      { name: 'bookId', direction: '1' },
      { name: 'type', direction: '1' },
      { name: 'productId', direction: '1' },
      { name: 'skuId', direction: '1' },
      { name: 'sortKey', direction: '-1' }
    ]
  },
  {
    indexName: 'shopId',
    keys: [{ name: 'shopId', direction: '1' }]
  }
]

function keysSignature(keys) {
  return (keys || [])
    .map(function (key) {
      return String(key.name) + ':' + String(key.direction)
    })
    .join(',')
}

function missingIndexes(existing, wanted) {
  const have = {}
  ;(existing || []).forEach(function (idx) {
    have[keysSignature(idx.keys)] = true
  })
  return (wanted || []).filter(function (item) {
    return !have[keysSignature(item.keys)]
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

async function resolveDb(wx) {
  const ENV_ID = env.readEnvId(root)
  const { envList } = await wx.api.tcbGetEnvironments({})
  const currentEnv = envList.find(function (item) {
    return item.envId === ENV_ID
  })
  if (!currentEnv) {
    throw new Error(
      '环境不在该 AppID 下: ' +
        ENV_ID +
        ' / ' +
        envList
          .map(function (item) {
            return item.envId
          })
          .join(',')
    )
  }
  const region = currentEnv.functions[0].region
  const db = currentEnv.databases && currentEnv.databases[0]
  const tag = (db && db.instanceId) || ENV_ID
  return { envId: ENV_ID, region: region, tag: tag }
}

async function ensureIndexes(api, opts) {
  const region = opts.region
  const tag = opts.tag
  const tableName = opts.tableName || COLLECTION
  const wanted = opts.indexes || INDEXES
  const described = await api.flexdbDescribeTable({
    region: region,
    tag: tag,
    tableName: tableName
  })
  const existing = described.indexes || []
  const missing = missingIndexes(existing, wanted)
  if (!missing.length) {
    console.log('indexes already present', tableName, existing.length)
    return { created: [], skipped: wanted.length, existing: existing }
  }
  for (let i = 0; i < missing.length; i++) {
    const item = missing[i]
    await api.flexdbUpdateTable({
      region: region,
      tag: tag,
      tableName: tableName,
      createIndexes: [
        {
          indexName: item.indexName,
          mgoKeySchema: {
            mgoIndexKeys: item.keys,
            mgoIsUnique: false
          }
        }
      ]
    })
    console.log('created index', tableName, item.indexName, keysSignature(item.keys))
  }
  return { created: missing, skipped: wanted.length - missing.length, existing: existing }
}

async function main() {
  env.loadDotEnv(root)
  env.requirePrivateKey()
  const wx = loadWxcloud()
  const state = await ensureLogin(wx)
  wx.initCloudAPI(state.appid)
  const db = await resolveDb(wx)
  console.log('env', db.envId, 'region', db.region, 'tag', db.tag)
  await ensureIndexes(wx.api, db)
}

module.exports = {
  COLLECTION: COLLECTION,
  INDEXES: INDEXES,
  keysSignature: keysSignature,
  missingIndexes: missingIndexes,
  ensureIndexes: ensureIndexes,
  resolveDb: resolveDb
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error.message || error)
    process.exit(1)
  })
}
