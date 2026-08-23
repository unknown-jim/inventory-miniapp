const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cloudConfig = require('../utils/cloud-config')

if (cloudConfig.isConfigured()) {
  assert.ok(cloudConfig.getCloudEnvId().length > 0)
} else {
  assert.ok(cloudConfig.missingMessage().indexOf('无法记账') >= 0)
  assert.ok(cloudConfig.missingMessage().indexOf('cloud-config.js') >= 0)
}

const root = path.join(__dirname, '..')
const forbidden = /wx\.cloud\.database\s*\(/

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      return
    }
    if (path.extname(entry.name) === '.js') out.push(full)
  })
}

const files = []
walk(path.join(root, 'pages'), files)
walk(path.join(root, 'utils'), files)
const appJs = path.join(root, 'app.js')
if (fs.existsSync(appJs)) files.push(appJs)

const hits = []
files.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = fs.readFileSync(file, 'utf8')
  if (forbidden.test(src)) hits.push(rel)
})

assert.strictEqual(
  hits.length,
  0,
  'miniprogram must not call wx.cloud.database() on business collections:\n' + hits.join('\n')
)

// ---------------------------------------------------------------------------
// T-S3 结构禁令：客户端**没有任何代码路径**能从流水现算钱。
//
// 2b-2b 删掉了 store.recordsForMoney() 那道运行时守卫。护栏不换成另一个运行时
// 检查，而是换成这条结构禁令：守卫要求调用者记得调它，结构禁令不给写错的机会。
//
// 为什么这是**更强**的护栏：分页之后页面手上只有一页流水，任何「从流水折钱」
// 的写法都会算出一个偏小的欠款，而偏小的欠款会被印在客户手上的单据上。
// 当前的钱一律读服务端投影（customers[].account / totals）；「截断到某张老单据
// 时刻的欠款」只有服务端 getSlip 一条路。
// ---------------------------------------------------------------------------

// 注释里提到函数名不算违规，所以先把注释剥掉再扫。
// 两种注释都剥：/* */ 块注释和 // 行注释。(^|[^:]) 那个捕获组是为了放过
// URL 里的 '//'（http://x）——剥过头会把字符串切成两半，自检见下。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// 从流水折钱的纯函数：页面里出现任何一个都是错的
// 后三个（recordTerms / addTerms / emptyTerms）是手工攒累加器的零件：
// let t = emptyTerms(); list.forEach(r => t = addTerms(t, recordTerms(r), 1))
// 绕开上面那些折叠函数，一样能从一页流水里折出一个偏小的欠款。
// 末两个（repairReturnSplits / recomputeSaleReturns）不折钱，但**改钱**：退货份额
// 只有把同一张销售单名下的退货单**整组**拿到一起才算得对。在页面里跑，组是
// 不完整的（缺被退销售单、或只翻到一半的退货单），会静默算出错的 paidAmount ——
// 和 foldAccountTerms 同一类危险，一并禁掉。份额重算只有服务端 legacyRecordsOf
// 一条路。
const MONEY_NAMES = [
  'summarizeCustomerAccount', 'summarizeAllCustomerAccounts', 'receivableAt', 'receivableDelta',
  'getTotalReceivable', 'summarizeRecords', 'computeTotals', 'foldAccountTerms', 'foldTotalTerms',
  'totalsOf', 'recordTerms', 'addTerms', 'emptyTerms', 'repairReturnSplits', 'recomputeSaleReturns'
]
// 裸名字匹配，**不要求名字后面跟 '('**：方括号取值 inventory['foldAccountTerms'](x)、
// 解构别名 const f = inventory.foldAccountTerms; f(x) 都只是让名字出现一次，
// 老写法（名字后必须紧跟括号）这两种都漏掉。剥过注释之后，名字出现即违规。
const MONEY_FROM_RECORDS = new RegExp('\\b(' + MONEY_NAMES.join('|') + ')\\b')
// accountOf(null) 是「空账户」的构造器，不碰流水，customer-edit 的 B1 修复在用；
// 传别的东西进去就是在投影一份自己攒的累加器，同样不该出现在页面里
const ACCOUNT_OF_MISUSE = /\baccountOf\s*\(\s*(?!null\s*\))/
// 已经删掉的 store API：留着调用点会静默拿到 undefined
const DEAD_STORE_API = /store\s*\.\s*(getRecords|recordsForMoney|getRecord)\s*\(/

// 扫描面：pages/ + components/ + app.js。组件和 app.js 和页面一样跑在小程序端、
// 一样 import 得到 store，漏掉它们就是给「从流水现算钱」留后门。
// **不要**把 utils/ 纳进来：utils/store.js 合法地用 inventory.receivableAt 维护
// 小程序内存模式（那是对**本地整本**流水的折叠，不是「从云端拿到的一页」，
// 禁令管的是后者）；纳进来会永久假红，而为了消红把 receivableAt 从名单里
// 删掉更是把真禁令拆了。utils/ 这扇门由下面 T-S3b 的转发禁令单独把守。
const pageFiles = []
walk(path.join(root, 'pages'), pageFiles)
walk(path.join(root, 'components'), pageFiles)
if (fs.existsSync(appJs)) pageFiles.push(appJs)

const moneyHits = []
pageFiles.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  if (MONEY_FROM_RECORDS.test(src)) moneyHits.push(rel + ' 从流水现算钱')
  if (ACCOUNT_OF_MISUSE.test(src)) moneyHits.push(rel + ' accountOf 只允许 accountOf(null)')
  if (DEAD_STORE_API.test(src)) moneyHits.push(rel + ' 用了已删除的 store API')
})
assert.strictEqual(
  moneyHits.length,
  0,
  'T-S3：小程序端不许有任何从流水现算钱的路径（钱一律读 accounts/totals，'
  + '老单据的当时欠款只有服务端 getSlip 一条路）：\n' + moneyHits.join('\n')
)

// ---------------------------------------------------------------------------
// T-S3b 转发禁令：名单里的函数不许从 utils/store.js / utils/util.js 导出。
//
// 页面拿不到这些函数是**结构性保证**（上面的扫描不含 utils/，见扫描面注释）。
// 在 utils/ 里加一个转发、页面再调 store.xxx(...)，等于从旁边把门打开 ——
// 这条禁令盯的就是那扇门。判据取「名字出现在 module.exports 赋值之后」
// （这两个文件的导出都是末尾一个对象字面量，出现在那里就是导出面的一部分，
// 当 key 还是当 value 都一样）或「exports.<name> = 赋值」。
// ---------------------------------------------------------------------------
const FORWARD_FILES = ['utils/store.js', 'utils/util.js']
const forwardHits = []
FORWARD_FILES.forEach(function (rel) {
  const src = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'))
  const exportAt = src.search(/module\.exports\s*=/)
  const exportText = exportAt >= 0 ? src.slice(exportAt) : ''
  MONEY_NAMES.forEach(function (name) {
    const nameRe = new RegExp('\\b' + name + '\\b')
    if (nameRe.test(exportText)
      || new RegExp('(?:module\\.)?exports\\s*\\.\\s*' + name + '\\s*=').test(src)) {
      forwardHits.push(rel + ' 把折钱函数 ' + name + ' 转发给了页面')
    }
  })
})
assert.strictEqual(
  forwardHits.length,
  0,
  'T-S3b：折钱函数不许从 utils/store.js / utils/util.js 转发出去'
  + '（页面拿不到它们是结构性保证，加转发等于开门）：\n' + forwardHits.join('\n')
)

// 自检①：扫描面真的含 components/ 和 app.js，否则上面两条断言对它们是空话
const scannedRel = pageFiles.map(function (file) {
  return path.relative(root, file).replace(/\\/g, '/')
})
assert.ok(scannedRel.indexOf('app.js') >= 0, '自检：app.js 必须在 T-S3 扫描面里')
assert.ok(scannedRel.some(function (rel) { return rel.indexOf('components/') === 0 }),
  '自检：components/ 必须在 T-S3 扫描面里')

// 自检②：禁令的正则真的能抓到东西，否则上面那条断言是假绿
assert.ok(MONEY_FROM_RECORDS.test('inventory.summarizeCustomerAccount(list, id)'))
assert.ok(MONEY_FROM_RECORDS.test('receivableAt(list, id, at)'))
assert.ok(MONEY_FROM_RECORDS.test('inventory.repairReturnSplits(page.records)'))
assert.ok(MONEY_FROM_RECORDS.test('recomputeSaleReturns(list, sale)'))
// 绕过写法 ①：components 里的直接调用（老扫描面只有 pages/，看不见它）
assert.ok(MONEY_FROM_RECORDS.test('const t = inventory.foldTotalTerms(this.data.records)'))
// 绕过写法 ③：方括号取值 —— 名字后面不是 '('，老正则（要求 \s*\(）漏掉
assert.ok(MONEY_FROM_RECORDS.test("inventory['foldAccountTerms'](records)"))
// 绕过写法 ④：解构别名再调用 —— 同上
assert.ok(MONEY_FROM_RECORDS.test('const f = inventory.foldAccountTerms; f(records)'))
// 注释里提到名字不算：剥掉注释之后必须干净（两种注释都验）
assert.ok(!MONEY_FROM_RECORDS.test(stripComments('// 口径和 summarizeCustomerAccount 相等')))
assert.ok(!MONEY_FROM_RECORDS.test(stripComments('/* foldAccountTerms 折出来的 */ const a = 1')))
assert.ok(stripComments('const u = "http://x" // foldAccountTypes 备注').indexOf('http://x') >= 0,
  '自检：stripComments 不许把 URL 里的 // 当注释切掉')
assert.ok(ACCOUNT_OF_MISUSE.test('inventory.accountOf(terms)'))
assert.ok(!ACCOUNT_OF_MISUSE.test('inventory.accountOf(null)'))
assert.ok(DEAD_STORE_API.test('store.recordsForMoney()'))
assert.ok(DEAD_STORE_API.test('store.getRecord(id)'))
assert.ok(!DEAD_STORE_API.test('store.getRecentRecords()'))

// 自检③（T-S3b）：六种绕过写法里的 ⑥ —— utils 转发必须被抓。
// 用和真检查同一条规则对假代码跑，确认判据有牙；反例（合法使用、不导出）
// 不许被抓。
function forwardSelfCheck(src) {
  const exportAt = src.search(/module\.exports\s*=/)
  const exportText = exportAt >= 0 ? src.slice(exportAt) : ''
  return MONEY_NAMES.some(function (name) {
    return new RegExp('\\b' + name + '\\b').test(exportText)
      || new RegExp('(?:module\\.)?exports\\s*\\.\\s*' + name + '\\s*=').test(src)
  })
}
assert.ok(forwardSelfCheck(
  'const wrapped = function (records) { return inventory.foldAccountTerms(records) }\nmodule.exports = { wrapped: wrapped, foldAccountTerms: wrapped }'
), '自检：名字出现在导出字面量里（哪怕只是当 value）必须算转发')
assert.ok(forwardSelfCheck(
  'module.exports.getTotals = x\nexports.foldAccountTerms = inventory.foldAccountTerms'
), '自检：exports.<name> = 赋值必须算转发')
// 反例：utils/store.js 里**使用** receivableAt（内存模式）不许被抓 —— 它不导出
assert.ok(!forwardSelfCheck(
  'const t = inventory.receivableAt(all, customerId, at)\nmodule.exports = { getTotals: getTotals, getSlip: getSlip }'
), '自检：合法的使用（不出现在导出面）不许被转发禁令抓到')

// ---------------------------------------------------------------------------
// 这条禁令挡得住什么、挡不住什么 —— 老实说清，别让人以为它是全覆盖的：
//   挡得住：调用 / 引用名单里的任何一个折钱函数（圆括号、方括号、别名都一样，
//           名字出现就算），以及经 utils/store.js / utils/util.js 的转发（T-S3b）。
//   挡不住：手写 reduce 从一页流水折钱、一个名单里的名字都不出现，例如
//             function debtFromPage(rows, cid) { return (rows || []).reduce(...) }
//           正则天生看不见这种写法；utils 里用**无关名字**包一层再导出
//             （module.exports = { wrapped }，wrapped 内部调 foldAccountTerms）
//           同样看不见；还有把名字拆开拼字符串
//             inventory['summarize' + 'CustomerAccount'](x)
//   后两类只能靠 code review 和「客户端手上只有一页流水」这条认知把关。
//   docs/cloud-ledger.md「不要做」里那条说的是同一件事，两处一起改。
// ---------------------------------------------------------------------------
assert.ok(!MONEY_FROM_RECORDS.test("inventory['summarize' + 'CustomerAccount'](x)"),
  '自检（钉住已知盲区）：拆名拼串确实抓不到 —— 这是本禁令承认的洞，不是意外')

// util.js 不再有 withSlipViewFromRecord：2a-b1 给它的使命（「让 2b 漏改时报错」）
// 已经由更强的东西接手 —— 客户端根本拿不到流水去算。
const utilSrc = fs.readFileSync(path.join(root, 'utils/util.js'), 'utf8')
assert.ok(
  !/function\s+withSlipViewFromRecord|withSlipViewFromRecord\s*:/.test(utilSrc),
  'T-S3：utils/util.js 不该再有 withSlipViewFromRecord'
)

// store.js 不该再有整本流水那套东西
const storeSrc = fs.readFileSync(path.join(root, 'utils/store.js'), 'utf8')
;['recordsForMoney', 'refillRecords', 'mergeRecordDelta', 'recordsComplete'].forEach(function (name) {
  assert.ok(
    storeSrc.indexOf(name) < 0,
    'T-S3：utils/store.js 不该再出现 ' + name + '（2b-2b 已删）'
  )
})

console.log('no-client-cloud-db: ' + files.length + ' files ok；T-S3 结构禁令 '
  + pageFiles.length + ' 个小程序端文件（pages/ + components/ + app.js）通过，'
  + 'utils 转发禁令 ' + FORWARD_FILES.length + ' 个文件通过')
