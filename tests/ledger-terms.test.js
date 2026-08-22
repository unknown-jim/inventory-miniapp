// 阶段 2b-0：聚合改成「单条记录贡献折叠」。
// 这里只验证一件事：新算法（recordTerms/foldAccountTerms/foldTotalTerms/
// accountOf/totalsOf/applyTermsDelta）在任何输入下都和老算法算出同一个数，
// 以及「增量维护」和「全量重折叠」永远相等。存储没有变，这文件只测算术。
const assert = require('assert')
const inv = require('../utils/inventory')

// ---------------------------------------------------------------------------
// 0) 参照实现：2b-0 重构前 utils/inventory.js 里的老算法，原样誊抄在这里当
//    唯一的比对基准。刻意不复用 inv.round2/inv.toNumber ——即使将来那两个
//    函数被误改，这份参照实现也不会跟着漂移，比对才有意义。
// ---------------------------------------------------------------------------

function legacyToNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback)
}
function legacyRound2(value) {
  return Math.round((legacyToNumber(value) + Number.EPSILON) * 100) / 100
}
function legacyIsCreditSale(record) {
  return record && record.type === 'out' && record.payType === 'credit'
}
function legacyIsCreditReturn(record) {
  return record && record.type === 'return' && record.payType === 'credit'
}
function legacyIsOpening(record) {
  return record && record.type === 'opening'
}
function legacyIsCustomerAccountRecord(record) {
  return record && (
    record.type === 'out'
    || record.type === 'pay'
    || record.type === 'return'
    || record.type === 'opening'
  )
}

function legacySummarizeAllCustomerAccounts(records) {
  const stats = Object.create(null)
  function ensure(customerId) {
    if (!stats[customerId]) {
      stats[customerId] = {
        creditSalesSum: 0,
        openingsSum: 0,
        creditReturnsSum: 0,
        paidSum: 0,
        salesSum: 0,
        returnsSum: 0,
        saleCount: 0
      }
    }
    return stats[customerId]
  }
  records.forEach(function (item) {
    if (!item.customerId || !legacyIsCustomerAccountRecord(item)) return
    const entry = ensure(item.customerId)
    if (item.type === 'out') {
      entry.salesSum += legacyToNumber(item.amount)
      if (legacyIsCreditSale(item)) {
        entry.creditSalesSum += legacyToNumber(item.amount)
      }
      entry.saleCount += 1
    } else if (item.type === 'return') {
      entry.returnsSum += legacyToNumber(item.amount)
      if (legacyIsCreditReturn(item)) {
        entry.creditReturnsSum += legacyToNumber(item.amount)
      }
    } else if (item.type === 'pay') {
      entry.paidSum += legacyToNumber(item.amount)
    } else if (legacyIsOpening(item)) {
      entry.openingsSum += legacyToNumber(item.amount)
    }
  })
  const result = {}
  Object.keys(stats).forEach(function (customerId) {
    const entry = stats[customerId]
    const creditAmount = legacyRound2(entry.creditSalesSum + entry.openingsSum - entry.creditReturnsSum)
    const paidAmount = legacyRound2(entry.paidSum)
    result[customerId] = {
      count: entry.saleCount,
      amount: legacyRound2(entry.salesSum - entry.returnsSum),
      creditAmount: creditAmount,
      paidAmount: paidAmount,
      receivable: legacyRound2(creditAmount - paidAmount)
    }
  })
  return result
}

function legacyGetTotalReceivable(records) {
  return legacyRound2(records.reduce(function (sum, item) {
    if (legacyIsCreditSale(item) || legacyIsOpening(item)) return sum + legacyToNumber(item.amount)
    if (legacyIsCreditReturn(item)) return sum - legacyToNumber(item.amount)
    if (item.type === 'pay') return sum - legacyToNumber(item.amount)
    return sum
  }, 0))
}

function legacySummarizeRecords(records) {
  const sales = records.filter(function (item) { return item.type === 'out' })
  const returns = records.filter(function (item) { return item.type === 'return' })
  const purchases = records.filter(function (item) { return item.type === 'in' })
  return {
    salesAmount: legacyRound2(
      sales.reduce(function (sum, item) { return sum + legacyToNumber(item.amount) }, 0)
      - returns.reduce(function (sum, item) { return sum + legacyToNumber(item.amount) }, 0)
    ),
    purchaseAmount: legacyRound2(purchases.reduce(function (sum, item) {
      return sum + legacyToNumber(item.amount)
    }, 0)),
    profit: legacyRound2(
      sales.reduce(function (sum, item) { return sum + legacyToNumber(item.profit) }, 0)
      + returns.reduce(function (sum, item) { return sum + legacyToNumber(item.profit) }, 0)
    ),
    receivable: legacyGetTotalReceivable(records),
    count: records.length
  }
}

// ---------------------------------------------------------------------------
// 通用测试工具
// ---------------------------------------------------------------------------

function rec(overrides) {
  return Object.assign({
    id: '',
    type: '',
    customerId: '',
    payType: 'cash',
    amount: 0,
    profit: 0,
    createdAt: 0,
    lines: []
  }, overrides)
}

// mulberry32：确定性种子随机数，跑多少次结果都一样，出问题能复现
function mulberry32(seed) {
  let a = seed | 0
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)]
}

function randomAmount2dp(rnd, min, max) {
  return inv.round2(rnd() * (max - min) + min)
}

function isAcctType(type) {
  return type === 'out' || type === 'pay' || type === 'return' || type === 'opening'
}

// ---------------------------------------------------------------------------
// 1) 语料比对：仿 tests/ledger-aggregates.test.js 的 mixedRecords（多客户、
//    多行单、赊账/现结混合、部分退货、部分收款、期初欠款、无客户记录、库存
//    调整）+ 仿 tests/record-shape.test.js 的老形状语料（经 migrateRecordShape
//    归并后的记录），新算法与老算法逐字段 ===
// ---------------------------------------------------------------------------

function outLine(overrides) {
  return Object.assign({
    lineId: '', productId: 'p', productName: '货', qty: 1, unitPrice: 0,
    costPrice: 0, amount: 0, profit: 0, allocations: [], returnedQty: 0
  }, overrides)
}

const mixedRecords = [
  rec({
    id: 'o1', type: 'out', customerId: 'c1', payType: 'credit', amount: 150, profit: 40,
    lines: [
      outLine({ lineId: 'o1-l1', amount: 100, profit: 30, returnedQty: 1 }),
      outLine({ lineId: 'o1-l2', amount: 50, profit: 10 })
    ]
  }),
  rec({ id: 'o2', type: 'out', customerId: 'c1', payType: 'cash', amount: 40, profit: 8,
    lines: [outLine({ lineId: 'o2-l1', amount: 40, profit: 8 })] }),
  rec({ id: 'ret1', type: 'return', customerId: 'c1', payType: 'credit', amount: 20, profit: -6,
    lines: [outLine({ lineId: 'ret1-l1', amount: 20, profit: -6, saleOrderId: 'o1', saleLineId: 'o1-l1' })] }),
  rec({ id: 'pay1', type: 'pay', customerId: 'c1', amount: 30 }),
  rec({ id: 'open1', type: 'opening', customerId: 'c1', amount: 15 }),
  rec({ id: 'o3', type: 'out', customerId: 'c2', payType: 'cash', amount: 60, profit: 12,
    lines: [outLine({ lineId: 'o3-l1', amount: 60, profit: 12, returnedQty: 1 })] }),
  rec({ id: 'ret2', type: 'return', customerId: 'c2', payType: 'cash', amount: 60, profit: -12,
    lines: [outLine({ lineId: 'ret2-l1', amount: 60, profit: -12, saleOrderId: 'o3', saleLineId: 'o3-l1' })] }),
  rec({ id: 'pay2', type: 'pay', customerId: 'c2', amount: 5 }),
  rec({ id: 'o4', type: 'out', customerId: 'c3', payType: 'credit', amount: 200, profit: 50,
    lines: [outLine({ lineId: 'o4-l1', amount: 200, profit: 50 })] }),
  rec({ id: 'p1', type: 'in', amount: 500, profit: 0, lines: [outLine({ lineId: 'p1-l1', amount: 500 })] }),
  rec({ id: 'adj1', type: 'adjust_in', amount: 0, profit: 0, lines: [outLine({ lineId: 'adj1-l1' })] }),
  rec({ id: 'adj2', type: 'adjust_out', amount: 0, profit: 0, lines: [outLine({ lineId: 'adj2-l1' })] }),
  rec({ id: 'noCust', type: 'out', customerId: '', payType: 'cash', amount: 999, profit: 999,
    lines: [outLine({ lineId: 'noCust-l1', amount: 999, profit: 999 })] })
]

function assertMatchesLegacy(records, label) {
  assert.deepStrictEqual(
    inv.summarizeAllCustomerAccounts(records),
    legacySummarizeAllCustomerAccounts(records),
    label + ': summarizeAllCustomerAccounts 应与老算法逐字段一致'
  )
  assert.strictEqual(
    inv.getTotalReceivable(records),
    legacyGetTotalReceivable(records),
    label + ': getTotalReceivable 应与老算法一致'
  )
  assert.deepStrictEqual(
    inv.summarizeRecords(records),
    legacySummarizeRecords(records),
    label + ': summarizeRecords 应与老算法逐字段一致'
  )
  assert.deepStrictEqual(
    inv.computeTotals(records),
    legacySummarizeRecords(records),
    label + ': computeTotals 应与老算法逐字段一致'
  )
}

assertMatchesLegacy(mixedRecords, 'mixedRecords')

// summarizeCustomerAccount 保留原实现不动，断言它与 accountOf(foldAccountTerms) 逐字段相等
const mixedTerms = inv.foldAccountTerms(mixedRecords);
['c1', 'c2', 'c3'].forEach(function (customerId) {
  const single = inv.summarizeCustomerAccount(mixedRecords, customerId)
  const viaTerms = inv.accountOf(mixedTerms[customerId])
  assert.strictEqual(single.count, viaTerms.count, 'summarizeCustomerAccount.count 应与 accountOf 一致：' + customerId)
  assert.strictEqual(single.amount, viaTerms.amount, 'summarizeCustomerAccount.amount 应与 accountOf 一致：' + customerId)
  assert.strictEqual(single.creditAmount, viaTerms.creditAmount, 'creditAmount 不一致：' + customerId)
  assert.strictEqual(single.paidAmount, viaTerms.paidAmount, 'paidAmount 不一致：' + customerId)
  assert.strictEqual(single.receivable, viaTerms.receivable, 'receivable 不一致：' + customerId)
})

// 老形状语料：仿 record-shape.test.js 的 legacyRecord，经 migrateRecordShape 归并
function legacyFlatRecord(overrides) {
  return Object.assign({
    id: '', type: '', productId: 'p1', productName: '货', sku: '', qty: 0,
    unitPrice: 0, costPrice: 0, amount: 0, profit: 0, remark: '',
    customerId: '', customerName: '', createdAt: 0
  }, overrides)
}

const legacyStored = [
  legacyFlatRecord({ id: 'op1', type: 'opening', productId: '', productName: '期初欠款', amount: 15, unitPrice: 15, customerId: 'c1', customerName: '甲', createdAt: 6000 }),
  legacyFlatRecord({ id: 'pay1', type: 'pay', productId: '', productName: '收款', amount: 20, unitPrice: 20, payType: 'cash', customerId: 'c1', customerName: '甲', createdAt: 5000 }),
  legacyFlatRecord({ id: 'ret1', type: 'return', orderId: 'order-1', saleRecordId: 'oa', qty: 1, unitPrice: 50, costPrice: 20, amount: 50, profit: -30, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 4000 }),
  legacyFlatRecord({ id: 'oc', type: 'out', qty: 1, unitPrice: 40, costPrice: 32, amount: 40, profit: 8, payType: 'cash', customerId: 'c2', customerName: '乙', createdAt: 3000 }),
  legacyFlatRecord({ id: 'ob', type: 'out', orderId: 'order-1', productName: '面包', qty: 1, unitPrice: 50, costPrice: 40, amount: 50, profit: 10, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 2000, operatorName: '小李' }),
  legacyFlatRecord({ id: 'oa', type: 'out', orderId: 'order-1', productName: '牛奶', qty: 2, unitPrice: 50, costPrice: 35, amount: 100, profit: 30, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 2000, operatorName: '小李', allocations: [{ skuId: 's1', qty: 2, source: 'ready', color: '白', size: 'M', costPrice: 35 }] }),
  legacyFlatRecord({ id: 'r1', type: 'in', qty: 5, unitPrice: 30, costPrice: 30, amount: 150, createdAt: 1000 })
]
const migratedForTerms = inv.migrateRecordShape(legacyStored)
assertMatchesLegacy(migratedForTerms, 'migratedForTerms')
// 迁移前的老形状本身也走同一套折叠（老算法一直支持按 orderId 混进来的散记录）
assertMatchesLegacy(legacyStored, 'legacyStored（未归并）')

// ---------------------------------------------------------------------------
// 2) 随机 fuzz：2000 条真实两位小数金额的记录，新旧算法逐字段一致
// ---------------------------------------------------------------------------

const rndFuzz = mulberry32(20260822)
const fuzzCustomers = ['fc1', 'fc2', 'fc3', 'fc4', 'fc5', 'fc-ghost', '']
const fuzzTypes = ['out', 'return', 'pay', 'opening', 'in', 'adjust_in', 'adjust_out']

function makeFuzzRecord(id, index) {
  const type = pick(rndFuzz, fuzzTypes)
  const acct = isAcctType(type)
  const customerId = acct ? pick(rndFuzz, fuzzCustomers) : ''
  const payType = (type === 'out' || type === 'return') ? (rndFuzz() < 0.5 ? 'credit' : 'cash') : 'cash'
  const amount = randomAmount2dp(rndFuzz, 0, 2000)
  const profit = (type === 'out' || type === 'return')
    ? inv.round2((rndFuzz() < 0.25 ? -1 : 1) * rndFuzz() * amount * 0.4)
    : 0
  return rec({ id: id, type: type, customerId: customerId, payType: payType, amount: amount, profit: profit, createdAt: 1000 + index })
}

const fuzzRecords = []
for (let i = 0; i < 2000; i++) {
  fuzzRecords.push(makeFuzzRecord('fz-' + i, i))
}
assertMatchesLegacy(fuzzRecords, 'fuzzRecords(2000, 两位小数)')

// ---------------------------------------------------------------------------
// 边界情况
// ---------------------------------------------------------------------------

// (a) 已删客户仍留有流水：accounts 里仍要有这个 key（与 summarizeAllCustomerAccounts
//     一直以来的语义一致——这两个函数从不读 customers[] 列表，只看流水本身）
const ghostRecords = [
  rec({ id: 'g1', type: 'out', customerId: 'ghost-customer', payType: 'credit', amount: 88, profit: 20 })
]
const ghostAccounts = inv.summarizeAllCustomerAccounts(ghostRecords)
assert.ok(Object.prototype.hasOwnProperty.call(ghostAccounts, 'ghost-customer'),
  '已删客户仍有流水时，accounts 里必须保留这个 key')
assert.strictEqual(ghostAccounts['ghost-customer'].receivable, 88)

// (b) 散客单（customerId 为空）：不进 accounts，但进 aggregate
const walkinRecords = [
  rec({ id: 'w1', type: 'out', customerId: '', payType: 'cash', amount: 66, profit: 15 })
]
assert.deepStrictEqual(inv.summarizeAllCustomerAccounts(walkinRecords), {},
  '散客单不应生成任何 accounts 条目')
assert.strictEqual(inv.computeTotals(walkinRecords).salesAmount, 66,
  '散客单仍要计入全店汇总')

// (c) 金额小数位异常的老数据（半分值）——D2 唯一的真实风险。
//     单条记录：cents()/round2() 逐值验证过 200 万个 half-cent 边界值零分歧，
//     这里再断言一次单记录场景确实一致。
const singleHalfCent = [rec({ id: 'h1', type: 'out', customerId: 'hc', payType: 'credit', amount: 0.005, profit: 0 })]
assertMatchesLegacy(singleHalfCent, '单条半分值记录')

// 亚分金额（第三位及以后小数非零）落进同一个累加桶时，"先转整数分再逐条
// 累加"（新）与"先浮点累加再四舍五入"（老）不保证给出同一个数。这是 D2
// 认定的唯一真实风险，此处如实钉住，而不是放松断言去掩盖。
//
// 误差的形状（不要按下面这个 1 分的例子去估上界）：
//   误差 = Σ(逐条舍入误差) − 整体舍入误差
// 所以它随亚分记录条数**线性增长、无上界**，方向取决于第三位小数的分布：
//   5000 条 ¥0.005 -> 老 25 元 / 新 50 元，差 +25 元
//   1000 条 ¥0.001 -> 老  1 元 / 新  0 元，差 −1 元（方向相反）
// 下面只是最小可复现例，不是风险上界。
//
// 见方案 §3.2：这类数据是否在生产的 12 家店里真实存在，要在迁移预检
// checkAggregates 里逐店核实。**预检若出现 equal:false，必须逐字段看 diff
// 的绝对值，不能假定只差一分。**
//
// 2b-0 审计已用闭合论证确认生产不可达：inventory.js 全部写入路径的
// amount / profit 都是 round2() 或 sumBy() 的输出，且 cents(round2(n/100))
// 对整数 n 恒等。新增写入路径若绕过 round2，这条前提就没了。
const multiHalfCent = [
  rec({ id: 'hc1', type: 'out', customerId: 'hc2', payType: 'credit', amount: 0.005, profit: 0 }),
  rec({ id: 'hc2', type: 'out', customerId: 'hc2', payType: 'credit', amount: 0.005, profit: 0 })
]
const legacyHalfCent = legacySummarizeAllCustomerAccounts(multiHalfCent).hc2
const newHalfCent = inv.summarizeAllCustomerAccounts(multiHalfCent).hc2
assert.strictEqual(legacyHalfCent.amount, 0.01, '老算法：0.005+0.005 四舍五入一次 = 0.01（已知基准，锁死不许变）')
assert.strictEqual(newHalfCent.amount, 0.02, '新算法：0.005+0.005 逐条转分再求和 = 0.02（已知且预期内的分歧，见上方注释）')
assert.notStrictEqual(legacyHalfCent.amount, newHalfCent.amount,
  '亚分金额累加场景下新旧算法确实会分歧——这是已知风险，不是本次改动引入的 bug')

// 反向例：0.001 级金额下新算法系统性偏低，证明误差是双向的、不是单向进位
const manyTenthCent = []
for (let i = 0; i < 1000; i++) {
  manyTenthCent.push(rec({
    id: 'tc' + i, type: 'out', customerId: 'tc', payType: 'credit', amount: 0.001, profit: 0
  }))
}
const legacyTenthCent = legacySummarizeAllCustomerAccounts(manyTenthCent).tc
const newTenthCent = inv.summarizeAllCustomerAccounts(manyTenthCent).tc
assert.strictEqual(legacyTenthCent.amount, 1, '老算法：1000 × 0.001 先浮点累加 = 1 元')
assert.strictEqual(newTenthCent.amount, 0, '新算法：1000 × 0.001 逐条舍入到分全为 0 = 0 元')
assert.ok(newTenthCent.amount < legacyTenthCent.amount,
  '误差方向不固定：0.001 级金额下新算法反而偏低，所以不能把误差当成单向进位')

console.log('亚分金额分歧已钉住：0.005×2 老=' + legacyHalfCent.amount + ' 新=' + newHalfCent.amount
  + '；0.001×1000 老=' + legacyTenthCent.amount + ' 新=' + newTenthCent.amount
  + '（误差无上界且双向，D2 已知风险，详见方案 §3.2 迁移预检）')

// ---------------------------------------------------------------------------
// 3) 增量等价性：3000 步随机「加一条/改一条/删一条/换客户」，每步比对
//    applyTermsDelta 的运行状态与对当前全部记录跑 foldAccountTerms/
//    foldTotalTerms 的结果——这是「聚合不漂移」的核心保证，常驻 npm test。
// ---------------------------------------------------------------------------

const rndIncr = mulberry32(20260823)
const incrCustomers = ['ic1', 'ic2', 'ic3', 'ic4', 'ic5', '']
const incrTypes = ['out', 'return', 'pay', 'opening', 'in', 'adjust_in', 'adjust_out']

function makeIncrRecord(id, createdAt, forceType) {
  const type = forceType || pick(rndIncr, incrTypes)
  const acct = isAcctType(type)
  const customerId = acct ? pick(rndIncr, incrCustomers) : ''
  const payType = (type === 'out' || type === 'return') ? (rndIncr() < 0.5 ? 'credit' : 'cash') : 'cash'
  const amount = randomAmount2dp(rndIncr, 0.01, 999.99)
  const profit = (type === 'out' || type === 'return')
    ? inv.round2((rndIncr() < 0.3 ? -1 : 1) * rndIncr() * amount * 0.4)
    : 0
  return rec({ id: id, type: type, customerId: customerId, payType: payType, amount: amount, profit: profit, createdAt: createdAt })
}

let incrRecords = []
let incrState = { accounts: {}, aggregate: inv.emptyTerms() }
let incrNextId = 1
let incrClock = 1000
const INCR_STEPS = 3000

for (let step = 0; step < INCR_STEPS; step++) {
  incrClock += 1
  const acctIndexes = []
  incrRecords.forEach(function (item, at) {
    if (isAcctType(item.type)) acctIndexes.push(at)
  })

  let action = 'add'
  if (incrRecords.length > 0) {
    action = pick(rndIncr, ['add', 'add', 'update', 'update', 'delete', 'switch'])
    if (action === 'switch' && acctIndexes.length === 0) action = 'add'
  }

  if (action === 'add') {
    const record = makeIncrRecord('ti-' + (incrNextId++), incrClock)
    incrRecords.push(record)
    incrState = inv.applyTermsDelta(incrState, null, record)
  } else if (action === 'delete') {
    const at = Math.floor(rndIncr() * incrRecords.length)
    const removed = incrRecords[at]
    incrRecords.splice(at, 1)
    incrState = inv.applyTermsDelta(incrState, removed, null)
  } else if (action === 'update') {
    const at = Math.floor(rndIncr() * incrRecords.length)
    const before = incrRecords[at]
    const after = makeIncrRecord(before.id, before.createdAt, before.type)
    incrRecords[at] = after
    incrState = inv.applyTermsDelta(incrState, before, after)
  } else {
    // switch：只换客户，其余字段不变（updateRecord 里 type 永远不可改，
    // 但 customerId 可以改——见 docs/cloud-ledger.md 和 inventory.js:2111 附近）
    const at = pick(rndIncr, acctIndexes)
    const before = incrRecords[at]
    const after = Object.assign({}, before, { customerId: pick(rndIncr, incrCustomers) })
    incrRecords[at] = after
    incrState = inv.applyTermsDelta(incrState, before, after)
  }

  const freshAccounts = inv.foldAccountTerms(incrRecords)
  const freshAggregate = inv.foldTotalTerms(incrRecords)
  assert.deepStrictEqual(incrState.accounts, freshAccounts,
    '第 ' + step + ' 步（' + action + '）后 accounts 增量与全量折叠不一致')
  assert.deepStrictEqual(incrState.aggregate, freshAggregate,
    '第 ' + step + ' 步（' + action + '）后 aggregate 增量与全量折叠不一致')
}

console.log('增量等价性：' + INCR_STEPS + ' 步全部通过，记录数最终为 ' + incrRecords.length)

// ---------------------------------------------------------------------------
// 4) receivableDelta 与 receivableAt 互推：
//    receivableAt(all, cid, t) === round2(current.receivable − receivableDelta(suffix, cid))
//    500 组随机 (customerId, 时间点)，语料里大量记录共享同一毫秒时间戳
// ---------------------------------------------------------------------------

const rndSlip = mulberry32(20260824)
const slipTimestamps = []
for (let i = 0; i < 25; i++) slipTimestamps.push(2000 + i * 10)
const slipCustomers = ['sc1', 'sc2', 'sc3']

const slipRecords = []
for (let i = 0; i < 800; i++) {
  const type = pick(rndSlip, ['out', 'return', 'pay', 'opening'])
  const customerId = pick(rndSlip, slipCustomers)
  const payType = (type === 'out' || type === 'return') ? (rndSlip() < 0.6 ? 'credit' : 'cash') : 'cash'
  const amount = randomAmount2dp(rndSlip, 0.01, 500)
  const profit = (type === 'out' || type === 'return')
    ? inv.round2((rndSlip() < 0.2 ? -1 : 1) * rndSlip() * amount * 0.3)
    : 0
  // 时间戳故意只从 25 个值里选，制造大量同毫秒记录
  const createdAt = pick(rndSlip, slipTimestamps)
  slipRecords.push(rec({ id: 'sl-' + i, type: type, customerId: customerId, payType: payType, amount: amount, profit: profit, createdAt: createdAt }))
}

const slipProbePoints = slipTimestamps.concat([1999, 2241, 9999])

for (let trial = 0; trial < 500; trial++) {
  const customerId = pick(rndSlip, slipCustomers)
  const at = pick(rndSlip, slipProbePoints)
  const current = inv.summarizeCustomerAccount(slipRecords, customerId).receivable
  const suffix = slipRecords.filter(function (item) {
    return inv.toNumber(item.createdAt) > at
  })
  const delta = inv.receivableDelta(suffix, customerId)
  const expected = inv.receivableAt(slipRecords, customerId, at)
  assert.strictEqual(
    inv.round2(current - delta),
    expected,
    'receivableDelta 互推失败：customerId=' + customerId + ' at=' + at
    + ' current=' + current + ' delta=' + delta + ' expected=' + expected
  )
}

console.log('ledger terms tests passed')
