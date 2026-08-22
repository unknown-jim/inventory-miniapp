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

// 注释里提到函数名不算违规，所以先把注释剥掉再扫
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// 从流水折钱的纯函数：页面里出现任何一个都是错的
// 后三个（recordTerms / addTerms / emptyTerms）是手工攒累加器的零件：
// let t = emptyTerms(); list.forEach(r => t = addTerms(t, recordTerms(r), 1))
// 绕开上面那些折叠函数，一样能从一页流水里折出一个偏小的欠款。
const MONEY_FROM_RECORDS = /\b(summarizeCustomerAccount|summarizeAllCustomerAccounts|receivableAt|receivableDelta|getTotalReceivable|summarizeRecords|computeTotals|foldAccountTerms|foldTotalTerms|totalsOf|recordTerms|addTerms|emptyTerms)\s*\(/
// accountOf(null) 是「空账户」的构造器，不碰流水，customer-edit 的 B1 修复在用；
// 传别的东西进去就是在投影一份自己攒的累加器，同样不该出现在页面里
const ACCOUNT_OF_MISUSE = /\baccountOf\s*\(\s*(?!null\s*\))/
// 已经删掉的 store API：留着调用点会静默拿到 undefined
const DEAD_STORE_API = /store\s*\.\s*(getRecords|recordsForMoney|getRecord)\s*\(/

const pageFiles = []
walk(path.join(root, 'pages'), pageFiles)

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
  'T-S3：页面不许有任何从流水现算钱的路径（钱一律读 accounts/totals，'
  + '老单据的当时欠款只有服务端 getSlip 一条路）：\n' + moneyHits.join('\n')
)

// 自检：禁令的正则真的能抓到东西，否则上面那条断言是假绿
assert.ok(MONEY_FROM_RECORDS.test('inventory.summarizeCustomerAccount(list, id)'))
assert.ok(MONEY_FROM_RECORDS.test('receivableAt(list, id, at)'))
assert.ok(!MONEY_FROM_RECORDS.test('// 口径和 summarizeCustomerAccount 相等'))
assert.ok(ACCOUNT_OF_MISUSE.test('inventory.accountOf(terms)'))
assert.ok(!ACCOUNT_OF_MISUSE.test('inventory.accountOf(null)'))
assert.ok(DEAD_STORE_API.test('store.recordsForMoney()'))
assert.ok(DEAD_STORE_API.test('store.getRecord(id)'))
assert.ok(!DEAD_STORE_API.test('store.getRecentRecords()'))

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
  + pageFiles.length + ' 个页面文件通过')
