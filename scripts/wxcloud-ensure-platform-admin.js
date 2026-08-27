const path = require('path')
const env = require('./wxcloud-env')
const indexes = require('./wxcloud-ensure-indexes')
const acl = require('./wxcloud-ensure-acl')
const wxload = require('./wxcloud-load-cli')

const root = path.join(__dirname, '..')
const COLLECTION = 'platform_admins'

// platform_admins 是账本升级三个运维 action 的门（docs/cloud-ledger.md 的
// 「账本升级」），上线硬依赖：必须在部署新云函数**之前**建好并写入运营方 openid，
// 否则新代码上线那一刻（fail-closed）三个运维 action 对所有人拒绝。名单空了 /
// 被删了导致锁死时也是用这条命令恢复——门每次调用都现读集合，插回文档即可，
// 不需要重新部署云函数。文档形状 {_id: openid, openid, note, createdAt}，
// _id 就是 openid，所以云函数侧是一次 doc(openid).get()，不需要索引。
const USAGE = [
  '用法: node scripts/wxcloud-ensure-platform-admin.js <openid> [--note 备注]',
  '    或 WXCLOUD_PLATFORM_ADMIN_OPENID=<openid> node scripts/wxcloud-ensure-platform-admin.js [--note 备注]',
  '',
  '幂等：集合缺了先建（CLI 建的表默认已是 ADMINONLY，脚本仍会核对权限），',
  '同 _id 文档已存在就跳过、不覆盖。跑完打印集合现状。',
  '不带 openid（也不带环境变量）只打印用法，不登录、不写。'
].join('\n')

function parseArgs(argv) {
  const out = { openid: '', note: '', help: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--note') {
      out.note = argv[i + 1] || ''
      i++
    } else {
      rest.push(arg)
    }
  }
  out.openid = String(rest[0] || process.env.WXCLOUD_PLATFORM_ADMIN_OPENID || '').trim()
  return out
}

// loadWxcloud 走 wxcloud-load-cli.js 的共享份；ensureLogin 不跟去（spawnSync
// 的写法过不了写入侧安全钩子，见共享模块顶注），仍是本地副本；resolveDb
// 直接复用 wxcloud-ensure-indexes.js 导出的那份，tag 的推导（databases[0]
// .instanceId || ENV_ID）只有一处定义。

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

async function listAdmins(api, opts) {
  return api.flexdbQuery({
    region: opts.region,
    tag: opts.tag,
    tableName: opts.tableName || COLLECTION,
    mgoLimit: 100
  })
}

function findAdmin(docs, openid) {
  return (docs || []).some(function (doc) {
    return String(doc._id) === String(openid)
  })
}

// mgoDocs 是 JSON 字符串的数组（flexdbPutItem 的参数形状，实测过）。
function adminDoc(openid, note) {
  return { _id: openid, openid: openid, note: note || '', createdAt: Date.now() }
}

// 存在性判断按 `_id` 直揥查，**不能拿 `listAdmins` 扫前 100 条代替**：
// 名单长到第 101 条之后，一个已在名单里的 openid 会被判成「不在」，
// 于是走到 flexdbPutItem 把那条文档**覆盖掉**——`createdAt` 和 `note` 当场丢失，
// 而脉络里那句 'already present 不覆盖' 从来不会打印，看日志看不出发生过覆盖。
// 现在的名单只有 2 条，所以这是预防性的；但代价只是一条 mgoQuery。
//
// `mgoQuery` 的形状是 **JSON 字符串**（2026-08-24 在真集合上只读实测过：
// 不带过滤 total=2；`{"_id": <已存在>}` total=1 且命中那条；`{"_id": <不存在>}` total=0）。
// **新用一个 flexdb 参数形状先在只读调用上验**，不要直接拿写接口试——
// 本仓有过教训：`flexdbDeleteItem` 的形状没验就用，当场删错了两条成员记录。
async function adminExists(api, opts, openid) {
  const res = await api.flexdbQuery({
    region: opts.region,
    tag: opts.tag,
    tableName: opts.tableName || COLLECTION,
    mgoLimit: 1,
    mgoQuery: JSON.stringify({ _id: String(openid) })
  })
  return ((res && res.data) || []).length > 0
}

async function ensurePlatformAdmin(api, opts) {
  const openid = opts.openid
  if (await adminExists(api, opts, openid)) {
    console.log('platform admin already present', openid, '—— 不覆盖')
    return { created: false, doc: null }
  }
  const doc = adminDoc(openid, opts.note)
  await api.flexdbPutItem({
    region: opts.region,
    tag: opts.tag,
    tableName: opts.tableName || COLLECTION,
    mgoDocs: [JSON.stringify(doc)]
  })
  console.log('inserted platform admin', openid)
  return { created: true, doc: doc }
}

function printAdmins(listed) {
  const data = listed.data || []
  const total = listed.pager && listed.pager.total != null ? listed.pager.total : data.length
  console.log('platform_admins 现状：' + total + ' 条')
  data.forEach(function (doc) {
    const when = doc.createdAt ? ' ' + new Date(doc.createdAt).toISOString() : ''
    const note = doc.note ? ' (' + doc.note + ')' : ''
    console.log('  - ' + doc._id + when + note)
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
  if (!args.openid) {
    // 没有明确 openid 就停在用法上，绝不走到写路径
    console.log(USAGE)
    process.exitCode = 1
    return
  }
  env.loadDotEnv(root)
  env.requirePrivateKey()
  const wx = wxload.loadWxcloud()
  const state = await ensureLogin(wx)
  wx.initCloudAPI(state.appid)
  const db = await indexes.resolveDb(wx)
  console.log('env', db.envId, 'region', db.region, 'tag', db.tag)
  await ensureTable(wx.api, db)
  acl.assertAclOk(await acl.ensureAcl(wx.api, { envId: db.envId, collections: [COLLECTION] }))
  await ensurePlatformAdmin(wx.api, {
    region: db.region,
    tag: db.tag,
    openid: args.openid,
    note: args.note
  })
  printAdmins(await listAdmins(wx.api, db))
}

module.exports = {
  COLLECTION: COLLECTION,
  USAGE: USAGE,
  parseArgs: parseArgs,
  adminDoc: adminDoc,
  findAdmin: findAdmin,
  adminExists: adminExists,
  ensureTable: ensureTable,
  listAdmins: listAdmins,
  ensurePlatformAdmin: ensurePlatformAdmin
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(error.message || error)
    process.exit(1)
  })
}
