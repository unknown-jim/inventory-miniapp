const path = require('path')
const env = require('./wxcloud-env')
const indexes = require('./wxcloud-ensure-indexes')
const acl = require('./wxcloud-ensure-acl')

const root = path.join(__dirname, '..')
const COLLECTION = 'platform_config'

// platform_config 是平台级维护开关的家（docs/cloud-ledger.md 的「维护模式」），
// 只有一条文档：_id 'maintenance'。**和 platform_admins 相反，它不是上线硬依赖**：
// 开关读不出来 = fail-open = 当作没在维护 = 和今天一样，先部署后建表也不会锁死
// 任何人（platform_admins 顺序反了会把三个运维 action 对所有人拒绝）。
// 幂等地插一条**关着的**初始文档：已存在就跳过、不覆盖——不能把正开着的维护
// 开关关掉，也不能把关着的打开。改开关走云函数 setMaintenance（平台运营方
// 白名单），不走这个脚本。
const USAGE = [
  '用法: node scripts/wxcloud-ensure-platform-config.js [--help]',
  '',
  '建集合 platform_config、设 ADMINONLY、插入初始文档',
  '{ _id: "maintenance", on: false, message: "", updatedAt, updatedBy: "" }。',
  '文档已存在就跳过、不覆盖（不会动正开着的维护开关）。跑完打印集合现状。',
  '',
  '这个集合不是上线硬依赖：集合没建 = 开关读不出来 = fail-open = 和今天一样，',
  '部署新云函数之前之后跑都行（对比：platform_admins 必须在部署之前建好）。'
].join('\n')

function parseArgs(argv) {
  const out = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
    }
  }
  return out
}

// loadWxcloud / ensureLogin 与 wxcloud-ensure-platform-admin.js /
// wxcloud-ensure-indexes.js / wxcloud-ensure-acl.js 里是同一份（那边没导出，
// 本仓惯例是各持一份副本）；resolveDb 直接复用 wxcloud-ensure-indexes.js
// 导出的那份，tag 的推导（databases[0].instanceId || ENV_ID）只有一处定义。
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

async function ensureTable(api, opts) {
  const tableName = opts.tableName || COLLECTION
  const listed = await api.flexdbListTables({
    region: opts.region,
    tag: opts.tag,
    mgoLimit: 100,
    mgoOffset: 0
  })
  const tables = (listed.tables || []).map(function (item) {
    return item.tableName
  })
  if (tables.indexOf(tableName) >= 0) return false
  try {
    await api.flexdbCreateTable({ region: opts.region, tag: opts.tag, tableName: tableName })
    console.log('created table', tableName)
    return true
  } catch (error) {
    console.log('create table', tableName, error.message || error.code || error)
    return false
  }
}

async function listDocs(api, opts) {
  return api.flexdbQuery({
    region: opts.region,
    tag: opts.tag,
    tableName: opts.tableName || COLLECTION,
    mgoLimit: 100
  })
}

function findMaintenance(docs) {
  return (docs || []).some(function (doc) {
    return String(doc._id) === 'maintenance'
  })
}

// mgoDocs 是 JSON 字符串的数组（flexdbPutItem 的参数形状，实测过）。
function maintenanceDoc() {
  return { _id: 'maintenance', on: false, message: '', updatedAt: Date.now(), updatedBy: '' }
}

async function ensureMaintenance(api, opts) {
  const current = await listDocs(api, opts)
  if (findMaintenance(current.data)) {
    console.log('maintenance doc already present —— 不覆盖（不会动正开着的开关）')
    return { created: false, doc: null }
  }
  const doc = maintenanceDoc()
  await api.flexdbPutItem({
    region: opts.region,
    tag: opts.tag,
    tableName: opts.tableName || COLLECTION,
    mgoDocs: [JSON.stringify(doc)]
  })
  console.log('inserted maintenance doc (on: false)')
  return { created: true, doc: doc }
}

function printDocs(listed) {
  const data = listed.data || []
  const total = listed.pager && listed.pager.total != null ? listed.pager.total : data.length
  console.log('platform_config 现状：' + total + ' 条')
  data.forEach(function (doc) {
    const when = doc.updatedAt ? ' ' + new Date(doc.updatedAt).toISOString() : ''
    const state = doc.on === true ? '维护中' : '未维护'
    console.log('  - ' + doc._id + ' [' + state + ']' + when + (doc.message ? ' ' + doc.message : ''))
  })
  if (total > data.length) {
    console.log('  …（共 ' + total + ' 条，只列出前 ' + data.length + ' 条）')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  env.loadDotEnv(root)
  env.requirePrivateKey()
  const wx = loadWxcloud()
  const state = await ensureLogin(wx)
  wx.initCloudAPI(state.appid)
  const db = await indexes.resolveDb(wx)
  console.log('env', db.envId, 'region', db.region, 'tag', db.tag)
  await ensureTable(wx.api, db)
  acl.assertAclOk(await acl.ensureAcl(wx.api, { envId: db.envId, collections: [COLLECTION] }))
  await ensureMaintenance(wx.api, db)
  printDocs(await listDocs(wx.api, db))
}

module.exports = {
  COLLECTION: COLLECTION,
  USAGE: USAGE,
  parseArgs: parseArgs,
  maintenanceDoc: maintenanceDoc,
  findMaintenance: findMaintenance,
  ensureTable: ensureTable,
  listDocs: listDocs,
  ensureMaintenance: ensureMaintenance
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error.message || error)
    process.exit(1)
  })
}
