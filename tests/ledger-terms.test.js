// 阶段 2b-0：聚合改成「单条记录贡献折叠」。
// 这里只验证一件事：新算法（recordTerms/foldAccountTerms/foldTotalTerms/
// accountOf/totalsOf/applyTermsDelta）在任何输入下都和老算法算出同一个数，
// 以及「增量维护」和「全量重折叠」永远相等。存储没有变，这文件只测算术。
const assert = require('assert')
const inv = require('../utils/inventory')
const apply = require('../utils/ledger-apply')

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
// #47 起结算从「现结 / 赊账」两档换成了金额 paidAmount，migrateRecordShape 写出来的
// 也是新字段（老 payType 会被抹掉）。参照实现必须跟着把定义域扩到新字段，否则拿
// 只认 payType 的老口径去量一份新形状的流水，会把赊账单当成收满、算出负欠款。
// 仍然**不复用 inv.settledAmount**：这里是独立誊抄的一份，比对才有意义。
// 只有 paidAmount 缺失时才回推老的 payType —— 在只有 payType 的输入上，
// 下面两个函数与被它们替换掉的 legacyIsCreditSale / legacyIsCreditReturn 分支恒等。
function legacySettledAmount(record) {
  if (!record) return 0
  const amount = legacyToNumber(record.amount)
  if (record.paidAmount == null || record.paidAmount === '') {
    return record.payType === 'credit' ? 0 : amount
  }
  const paid = legacyRound2(record.paidAmount)
  if (paid <= 0) return 0
  return paid > amount ? amount : paid
}
// 刻意不在这里 round：老口径是「先浮点累加、最后四舍五入一次」，
// 逐条先取整就把 (c) 段那条亚分分歧掩盖掉了。
function legacySaleDebt(record) {
  if (!record || record.type !== 'out') return 0
  return legacyToNumber(record.amount) - legacySettledAmount(record)
}
function legacyReturnDebt(record) {
  if (!record || record.type !== 'return') return 0
  return legacyToNumber(record.amount) - legacySettledAmount(record)
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
      entry.creditSalesSum += legacySaleDebt(item)
      entry.saleCount += 1
    } else if (item.type === 'return') {
      entry.returnsSum += legacyToNumber(item.amount)
      entry.creditReturnsSum += legacyReturnDebt(item)
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
    if (item.type === 'out') return sum + legacySaleDebt(item)
    if (legacyIsOpening(item)) return sum + legacyToNumber(item.amount)
    if (item.type === 'return') return sum - legacyReturnDebt(item)
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
// 迁移是「写」：payType 被抹掉、换成 paidAmount。换字段不许换钱 —— 归并前后
// 每个客户的钱必须一模一样（count 例外：一张单 N 行归并成 1 条，本来就该变）。
const migratedAccounts = inv.summarizeAllCustomerAccounts(migratedForTerms)
const preMigrateAccounts = legacySummarizeAllCustomerAccounts(legacyStored)
assert.deepStrictEqual(Object.keys(migratedAccounts).sort(), Object.keys(preMigrateAccounts).sort())
Object.keys(preMigrateAccounts).forEach(function (customerId) {
  ;['amount', 'creditAmount', 'paidAmount', 'receivable'].forEach(function (field) {
    assert.strictEqual(migratedAccounts[customerId][field], preMigrateAccounts[customerId][field],
      'migrateRecordShape 不许改动 ' + customerId + ' 的 ' + field)
  })
})
assert.strictEqual(
  inv.getTotalReceivable(migratedForTerms),
  legacyGetTotalReceivable(legacyStored),
  'migrateRecordShape 不许改动全店欠款'
)
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
  // 第三档产 paidAmount（#47 的部分收款），把新叶子的 paidAmount 分支也量进来
  const roll = rndFuzz()
  const amount = randomAmount2dp(rndFuzz, 0, 2000)
  const settle = (type === 'out' || type === 'return')
    ? (roll < 0.34 ? { payType: 'credit' }
      : roll < 0.67 ? { payType: 'cash' }
      : { paidAmount: [-1, 0, Math.round(amount * roll * 100) / 100, amount,
          Math.round(amount * 150) / 100][index % 5] })
    : { payType: 'cash' }
  const profit = (type === 'out' || type === 'return')
    ? inv.round2((rndFuzz() < 0.25 ? -1 : 1) * rndFuzz() * amount * 0.4)
    : 0
  return rec(Object.assign({ id: id, type: type, customerId: customerId, amount: amount, profit: profit, createdAt: 1000 + index }, settle))
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
//
// **2b-2b 把这条分歧的影响面扩大了一处**：首页今日三项从 getDashboard 的
// round2 浮点累加换成了 todayTotals 的整数分累加，用的就是这里的新口径。
// 所以存量有亚分金额的店，首页数字会**跳一次**。这是个用户可见的变化，
// 迁移预检 checkAggregates 要顺带查一遍哪些店有亚分金额（那个动作还没实现）。
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
  // 第三档产 paidAmount（#47 的部分收款），把新叶子的 paidAmount 分支也量进来
  const roll = rndIncr()
  const amount = randomAmount2dp(rndIncr, 0.01, 999.99)
  const rotor = Math.floor(rndIncr() * 5)
  const settle = (type === 'out' || type === 'return')
    ? (roll < 0.34 ? { payType: 'credit' }
      : roll < 0.67 ? { payType: 'cash' }
      : { paidAmount: [-1, 0, Math.round(amount * roll * 100) / 100, amount,
          Math.round(amount * 150) / 100][rotor % 5] })
    : { payType: 'cash' }
  const profit = (type === 'out' || type === 'return')
    ? inv.round2((rndIncr() < 0.3 ? -1 : 1) * rndIncr() * amount * 0.4)
    : 0
  return rec(Object.assign({ id: id, type: type, customerId: customerId, amount: amount, profit: profit, createdAt: createdAt }, settle))
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

// ---------------------------------------------------------------------------
// 2b-2b 删掉了 mergeRecordDelta（连同记账回传里的 recordDelta）：分页之后
// 客户端每个列表都是服务端取的、每个金额都来自 accounts / totals 投影，没有
// 任何一处消费 delta。这里原来那一整节用例跟着删 —— 留着一个没人用的算钱
// 机制的测试，只会让下一个人以为它还在被依赖（方案 C-2，用户已明确点头）。
// 它顶下来的覆盖面由 tests/ledger-records.test.js 的 T-B1 接手：3000 步守门员
// 每步用 listRecords 翻页对账，覆盖面比原来更大。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-A1（方案 D:\work\inventory-miniapp-handoffs\2b-2-pagination-design-2026-08-23.md
// §五）：pageRecords 纯函数 —— 空数组 / 非法 limit / 七种 type / 游标翻页不重
// 不漏 / 同毫秒全序 / 整页倍数 hasMore / 空页 cursor。
// 集合查询与内存模式的等价性在 tests/ledger-records.test.js 的 T-A2 里核对，
// 这里只测这一份定义本身。
// ---------------------------------------------------------------------------

function paRecord(id, type, createdAt, customerId) {
  return {
    id: id, type: type, amount: 1, profit: 0, remark: '',
    customerId: customerId || '', createdAt: createdAt, lines: []
  }
}

// 空数组
assert.deepStrictEqual(apply.pageRecords([], {}), { records: [], cursor: '', hasMore: false })
assert.deepStrictEqual(apply.pageRecords([], { type: 'out', customerId: 'x', limit: 5 }),
  { records: [], cursor: '', hasMore: false })

// 非法 limit：clampPageLimit 缺省 20，上限 100，非法一律给缺省值
assert.strictEqual(apply.clampPageLimit(undefined), 20)
assert.strictEqual(apply.clampPageLimit(null), 20)
assert.strictEqual(apply.clampPageLimit(0), 20)
assert.strictEqual(apply.clampPageLimit(-5), 20)
assert.strictEqual(apply.clampPageLimit(NaN), 20)
assert.strictEqual(apply.clampPageLimit('abc'), 20)
assert.strictEqual(apply.clampPageLimit(1), 1)
assert.strictEqual(apply.clampPageLimit(3.7), 3, '非整数向下取整')
assert.strictEqual(apply.clampPageLimit(100), 100)
assert.strictEqual(apply.clampPageLimit(101), 100, '超过上限钳到 100')
assert.strictEqual(apply.clampPageLimit(100000), 100)

const paCorpus = [
  paRecord('pa-out-1', 'out', 1000, 'cust-a'),
  paRecord('pa-out-2', 'out', 1000, 'cust-b'),   // 和 pa-out-1 同毫秒，靠 id 排先后
  paRecord('pa-out-3', 'out', 3000, 'cust-a'),
  paRecord('pa-in-1', 'in', 1500, ''),
  paRecord('pa-in-2', 'in', 4000, ''),
  paRecord('pa-return-1', 'return', 2000, 'cust-a'),
  paRecord('pa-return-2', 'return', 4500, 'cust-b'),
  paRecord('pa-pay-1', 'pay', 2500, 'cust-a'),
  paRecord('pa-pay-2', 'pay', 5000, 'cust-b'),
  paRecord('pa-opening-1', 'opening', 100, 'cust-a'),   // 不在「七种」之内，混进来验证不会被误算进别的桶
  paRecord('pa-convert-1', 'convert', 2200, ''),
  paRecord('pa-convert-2', 'convert', 4200, ''),
  paRecord('pa-adjin-1', 'adjust_in', 2700, ''),
  paRecord('pa-adjin-2', 'adjust_in', 4700, ''),
  paRecord('pa-adjout-1', 'adjust_out', 2900, ''),
  paRecord('pa-adjout-2', 'adjust_out', 4900, '')
]

function paIds(list) {
  return list.map(function (r) { return r.id }).sort()
}

// 七种 type：all / in / out / pay / return / convert / adjust（和 pages/records/records.js
// onLoad 里认识的 type 一一对应，adjust 合并 adjust_in / adjust_out 两种）
const paExpectedByType = {
  all: paCorpus,
  in: paCorpus.filter(function (r) { return r.type === 'in' }),
  out: paCorpus.filter(function (r) { return r.type === 'out' }),
  pay: paCorpus.filter(function (r) { return r.type === 'pay' }),
  return: paCorpus.filter(function (r) { return r.type === 'return' }),
  convert: paCorpus.filter(function (r) { return r.type === 'convert' }),
  adjust: paCorpus.filter(function (r) { return r.type === 'adjust_in' || r.type === 'adjust_out' })
}
Object.keys(paExpectedByType).forEach(function (type) {
  const got = apply.pageRecords(paCorpus, { type: type, limit: 100 })
  assert.deepStrictEqual(paIds(got.records), paIds(paExpectedByType[type]),
    'pageRecords type=' + type + ' 结果不对')
})

// 边界：customerId 传 ''（散客）不过滤 —— 防止有人以为能用它单独查出散客单
assert.strictEqual(apply.pageRecords(paCorpus, { customerId: '', limit: 100 }).records.length,
  paCorpus.length, "customerId 传空字符串不应该过滤任何记录")
assert.strictEqual(apply.pageRecords(paCorpus, { customerId: 'cust-a', limit: 100 }).records.length,
  paCorpus.filter(function (r) { return r.customerId === 'cust-a' }).length)

// 全量倒序参照（sortKey 倒序，同毫秒靠 id 拿到全序）
const paFullDesc = paCorpus.slice().sort(function (a, b) {
  const ka = apply.makeSortKey(a.createdAt, a.id)
  const kb = apply.makeSortKey(b.createdAt, b.id)
  if (ka === kb) return 0
  return ka > kb ? -1 : 1
}).map(function (r) { return r.id })

// 同毫秒全序：pa-out-1 / pa-out-2 必须相邻且顺序由 id 决定，不能并列
const msIndexA = paFullDesc.indexOf('pa-out-1')
const msIndexB = paFullDesc.indexOf('pa-out-2')
assert.notStrictEqual(msIndexA, msIndexB)
assert.strictEqual(Math.abs(msIndexA - msIndexB), 1, '同毫秒的两条必须相邻且有全序')

// 游标翻页不重不漏：小 limit 逐页翻完，必须逐条等于整份倒序
let paCursor = ''
const paPaged = []
for (let i = 0; i < 50; i++) {
  const got = apply.pageRecords(paCorpus, { cursor: paCursor, limit: 3 })
  got.records.forEach(function (r) { paPaged.push(r.id) })
  if (!got.hasMore) break
  paCursor = got.cursor
}
assert.deepStrictEqual(paPaged, paFullDesc, 'pageRecords 分页翻完必须和整份倒序逐条相同')

// 整页倍数 hasMore + 空页 cursor：6 条、limit=3，翻到第 3 页应该是 0 条 + hasMore:false + cursor:''
const paEven = paCorpus.slice(0, 6)
const paPage1 = apply.pageRecords(paEven, { limit: 3 })
assert.strictEqual(paPage1.records.length, 3)
assert.strictEqual(paPage1.hasMore, true)
const paPage2 = apply.pageRecords(paEven, { limit: 3, cursor: paPage1.cursor })
assert.strictEqual(paPage2.records.length, 3)
assert.strictEqual(paPage2.hasMore, true, '正好整页倍数时，翻完之前那页 hasMore 仍为 true')
const paPage3 = apply.pageRecords(paEven, { limit: 3, cursor: paPage2.cursor })
assert.strictEqual(paPage3.records.length, 0, '正好整页倍数，翻完之后再翻一页应为 0 条')
assert.strictEqual(paPage3.hasMore, false)
assert.strictEqual(paPage3.cursor, '', '空页 cursor 必须是空字符串')

// ---------------------------------------------------------------------------
// 6) 退货份额整体重算：repairReturnSplits（挂在 apply.legacyRecordsOf 里）
//
//    库里三代形状（见 utils/inventory.js 的 settledAmount 注释）：
//      代 A  销售有 payType，退货也有 payType（开退货单时从销售单抄）
//      代 B  销售有 paidAmount，退货**两个结算字段都没有**
//      代 C  销售和退货都有 paidAmount（returnCashRefund 写的单头）
//
//    B1：代 B 的退货落进 settledAmount 的「缺字段」分支，被保守回推成
//        「整笔退了现金」→ 一分都不冲欠款 → 欠款算大。
//    B2：退货单头的 customerId 是开单当时抄的，改过销售单客户之后就过期了 →
//        一个客户少算、另一个多算（后者常常是负欠款，会卡死全店写路径）。
//
//    判据是【拆分不变量】：每张销售单上 Σ(rᵢ − settledAmount(rᵢ)) == min(D, Σrᵢ)，
//    D = 该销售单欠款基准 = amount − settledAmount(sale)。
// ---------------------------------------------------------------------------

function splitLine(overrides) {
  return Object.assign({
    lineId: '', productId: 'sp1', productName: '货', sku: '', skuId: '', color: '', size: '',
    qty: 1, unitPrice: 0, costPrice: 0, amount: 0, profit: 0
  }, overrides)
}

// 刻意不复用上面的 rec()：它给 payType 一个 'cash' 缺省值，而这一节的全部意义
// 就在于「哪些结算字段在、哪些不在」，缺省值会把代 B 语料悄悄变成代 A。
function splitSale(overrides) {
  const amount = overrides.amount != null ? overrides.amount : 100
  const record = {
    id: overrides.id || 'ss-1',
    type: 'out',
    customerId: 'sc1', customerName: '甲', customerPhone: '13800000000', customerAddress: '甲街 1 号',
    amount: amount, profit: 0, createdAt: overrides.createdAt != null ? overrides.createdAt : 2000,
    lines: [splitLine({ lineId: (overrides.id || 'ss-1') + '-l1', unitPrice: amount, amount: amount, allocations: [], returnedQty: 0, returnedAmount: 0 })]
  }
  return Object.assign(record, overrides)
}

function splitReturn(overrides) {
  const amount = overrides.amount != null ? overrides.amount : 30
  const saleOrderId = overrides.saleOrderId != null ? overrides.saleOrderId : 'ss-1'
  const record = {
    id: overrides.id || 'sr-1',
    type: 'return',
    customerId: 'sc1', customerName: '甲', customerPhone: '13800000000', customerAddress: '甲街 1 号',
    amount: amount, profit: 0, createdAt: overrides.createdAt != null ? overrides.createdAt : 3000,
    lines: [splitLine({ lineId: (overrides.id || 'sr-1') + '-l1', unitPrice: amount, amount: amount, saleOrderId: saleOrderId, saleLineId: saleOrderId + '-l1' })]
  }
  const next = Object.assign(record, overrides)
  delete next.saleOrderId
  return next
}

function splitReceivable(records, customerId) {
  const accounts = inv.summarizeAllCustomerAccounts(apply.legacyRecordsOf({ records: records }))
  return accounts[customerId] ? accounts[customerId].receivable : 0
}

// 返回破坏【拆分不变量】的销售单 id 列表。没有退货的销售单不参与。
function splitViolations(records) {
  const bad = []
  ;(records || []).forEach(function (sale) {
    if (!sale || sale.type !== 'out') return
    const debt = inv.round2(inv.toNumber(sale.amount) - inv.settledAmount(sale))
    const rets = records.filter(function (item) {
      return item && item.type === 'return'
        && String((inv.recordLines(item)[0] || {}).saleOrderId || '') === sale.id
    })
    if (!rets.length) return
    const sumReturn = inv.round2(rets.reduce(function (acc, item) {
      return acc + inv.toNumber(item.amount)
    }, 0))
    const offset = inv.round2(rets.reduce(function (acc, item) {
      return acc + (inv.toNumber(item.amount) - inv.settledAmount(item))
    }, 0))
    if (offset !== Math.min(debt, sumReturn)) bad.push(sale.id)
  })
  return bad
}

// --- M1：三代形状语料逐条过 legacyRecordsOf，欠款等于手算值 -----------------
// 每一格都是「赊账/现结卖 100、退 30」，右列是手算的正确欠款。
const m1Cases = [
  ['代A credit', [splitSale({ payType: 'credit' }), splitReturn({ payType: 'credit' })], 70],
  ['代A cash', [splitSale({ payType: 'cash' }), splitReturn({ payType: 'cash' })], 0],
  ['代B 实收0', [splitSale({ paidAmount: 0 }), splitReturn({})], 70],
  ['代B 实收40', [splitSale({ paidAmount: 40 }), splitReturn({})], 30],
  ['代B 实收90', [splitSale({ paidAmount: 90 }), splitReturn({})], 0],
  ['代B 双退货 实收0', [splitSale({ paidAmount: 0 }),
    splitReturn({ id: 'sr-1', amount: 30, createdAt: 3000 }),
    splitReturn({ id: 'sr-2', amount: 50, createdAt: 4000 })], 20],
  ['代B 双退货 实收90', [splitSale({ paidAmount: 90 }),
    splitReturn({ id: 'sr-1', amount: 30, createdAt: 3000 }),
    splitReturn({ id: 'sr-2', amount: 50, createdAt: 4000 })], 0],
  ['代C 实收40', [splitSale({ paidAmount: 40 }), splitReturn({ paidAmount: 0 })], 30],
  ['代C 实收90', [splitSale({ paidAmount: 90 }), splitReturn({ paidAmount: 20 })], 0]
]
m1Cases.forEach(function (row) {
  const label = row[0]
  const repaired = apply.legacyRecordsOf({ records: row[1] })
  assert.strictEqual(splitReceivable(row[1], 'sc1'), row[2], 'M1 ' + label + '：欠款必须等于手算值')
  assert.deepStrictEqual(splitViolations(repaired), [], 'M1 ' + label + '：修复后拆分不变量必须成立')
  assert.doesNotThrow(function () {
    inv.assertAccountsValid(inv.foldAccountTerms(repaired))
  }, 'M1 ' + label + '：修复后不许出现负账户')
})

// M1 孤儿退货：lines[0].saleOrderId 为空，份额无从算起。原样保留 settledAmount
// 的保守回推值（欠款偏大、方向可补救），**不许**被改成 0 折出负欠款。
const m1Orphan = [splitSale({ paidAmount: 0 }), splitReturn({ saleOrderId: '' })]
const m1OrphanOut = apply.legacyRecordsOf({ records: m1Orphan })
assert.strictEqual(splitReceivable(m1Orphan, 'sc1'), 100,
  'M1 孤儿退货：份额修不了，保持「整笔退现金」的保守值，欠款仍是 100')
assert.strictEqual(m1OrphanOut[1].paidAmount, undefined, 'M1 孤儿退货：不许被塞进 paidAmount')
assert.doesNotThrow(function () {
  inv.assertAccountsValid(inv.foldAccountTerms(m1OrphanOut))
}, 'M1 孤儿退货：保守值不许折出负账户')

// M1 B2：退货单头挂着改客户之前的旧 customerId（代 A）。
// 修好之后：新客户拿到正确欠款、旧客户从 accounts 里消失、退货单头四个客户字段全部拨过来。
const m1B2 = [
  splitSale({ payType: 'credit' }),
  splitReturn({ payType: 'credit', customerId: 'sc9', customerName: '旧甲', customerPhone: '13900000000', customerAddress: '旧街 9 号' })
]
const m1B2Out = apply.legacyRecordsOf({ records: m1B2 })
const m1B2Accounts = inv.summarizeAllCustomerAccounts(m1B2Out)
assert.strictEqual(m1B2Accounts.sc1.receivable, 70, 'M1 B2：新客户欠款 100 − 30 = 70')
assert.ok(!Object.prototype.hasOwnProperty.call(m1B2Accounts, 'sc9'),
  'M1 B2：旧客户必须从 accounts 里消失，不能留一个 −30 的负账户')
const m1B2Return = m1B2Out.find(function (item) { return item.type === 'return' })
assert.strictEqual(m1B2Return.customerId, 'sc1', 'M1 B2：customerId 要拨到销售单当前值')
assert.strictEqual(m1B2Return.customerName, '甲', 'M1 B2：四个客户字段要整组拨，不能只拨 id')
assert.strictEqual(m1B2Return.customerPhone, '13800000000')
assert.strictEqual(m1B2Return.customerAddress, '甲街 1 号')
assert.strictEqual(m1B2Return.payType, undefined, 'M1 B2：重写过的退货单不许留着老 payType')

// M1 幂等：代 C（已 materialize 且客户字段已对齐）零改动，返回**入参本身**。
// 这是把 repairReturnSplits 放在读路径上的前提：不改动时零分配。
const m1GenC = [splitSale({ paidAmount: 40 }), splitReturn({ paidAmount: 0 })]
const m1GenCOut = inv.repairReturnSplits(m1GenC)
assert.strictEqual(m1GenCOut, m1GenC, 'M1 代C：无改动时必须返回入参本身（引用相等）')
m1GenC.forEach(function (item, at) {
  assert.strictEqual(m1GenCOut[at], item, 'M1 代C：引用必须逐条不变')
})
// 再跑一次仍然零改动 —— 幂等
assert.strictEqual(inv.repairReturnSplits(m1GenCOut), m1GenC, 'M1 代C：repairReturnSplits 必须幂等')
// 混进一条代 B 时，只有那一条被换掉，其余引用不动
const m1Mixed = [
  splitSale({ id: 'ss-1', paidAmount: 40 }), splitReturn({ id: 'sr-1', paidAmount: 0 }),
  splitSale({ id: 'ss-2', paidAmount: 0, amount: 200, createdAt: 5000 }),
  splitReturn({ id: 'sr-2', amount: 60, createdAt: 6000, saleOrderId: 'ss-2' })
]
const m1MixedOut = inv.repairReturnSplits(m1Mixed)
assert.notStrictEqual(m1MixedOut, m1Mixed, 'M1 混合：有改动时必须返回新数组')
assert.strictEqual(m1MixedOut[0], m1Mixed[0], 'M1 混合：销售单不被重写')
assert.strictEqual(m1MixedOut[1], m1Mixed[1], 'M1 混合：已 materialize 的退货单引用不动')
assert.strictEqual(m1MixedOut[2], m1Mixed[2])
assert.notStrictEqual(m1MixedOut[3], m1Mixed[3], 'M1 混合：只有代 B 那条被换掉')
assert.strictEqual(m1MixedOut[3].paidAmount, 0, 'M1 混合：ss-2 欠 200、退 60，全额冲欠款、不退现金')

// --- M1b：拆分不变量 fuzz 400 组 -------------------------------------------
// 每组一张销售单 + 1..3 张退货单，退货单的「代」随机（代 B 无字段 / 代 C 已
// materialize / 代 A 有 payType），其中一部分挂着过期的 customerId（B2）。
// 修复前必须真的破坏、真的折出负账户（否则这两条断言是假绿），
// 修复后 0 组破坏、且 assertAccountsValid 一次都不抛。
const rndSplit = mulberry32(20260825)
let m1bBrokenBefore = 0
let m1bNegativeBefore = 0
for (let g = 0; g < 400; g++) {
  const amount = randomAmount2dp(rndSplit, 10, 2000)
  const paid = [0, inv.round2(amount * rndSplit()), amount][g % 3]
  const sale = splitSale({ id: 'fs-' + g, amount: amount, paidAmount: paid, customerId: 'fc-' + (g % 7) })
  const retCount = 1 + Math.floor(rndSplit() * 3)
  const corpus = [sale]
  let leftQty = amount
  for (let k = 0; k < retCount && leftQty > 0.02; k++) {
    const retAmount = k === retCount - 1
      ? inv.round2(leftQty * (rndSplit() < 0.3 ? 1 : rndSplit()))
      : inv.round2(leftQty * rndSplit() * 0.6)
    if (retAmount <= 0) break
    leftQty = inv.round2(leftQty - retAmount)
    // 三代形状按 roll 混着来：代 B 占一半（B1 的主战场），其余是代 C / 代 A
    const roll = rndSplit()
    const shape = roll < 0.5 ? {}
      : roll < 0.7 ? { paidAmount: 0 }
        : roll < 0.85 ? { payType: 'credit' } : { payType: 'cash' }
    // 30% 的退货单挂着改客户之前的旧 id —— B2
    const stale = rndSplit() < 0.3 ? { customerId: 'fc-stale-' + (g % 7) } : {}
    corpus.push(splitReturn(Object.assign({
      id: 'fr-' + g + '-' + k, amount: retAmount, saleOrderId: 'fs-' + g,
      createdAt: 3000 + k, customerId: sale.customerId
    }, shape, stale)))
  }
  if (corpus.length < 2) continue
  if (splitViolations(corpus).length) m1bBrokenBefore++
  let negativeBefore = false
  try { inv.assertAccountsValid(inv.foldAccountTerms(corpus)) } catch (err) { negativeBefore = true }
  if (negativeBefore) m1bNegativeBefore++

  const repaired = apply.legacyRecordsOf({ records: corpus })
  assert.deepStrictEqual(splitViolations(repaired), [],
    'M1b 第 ' + g + ' 组：修复后拆分不变量必须成立')
  assert.doesNotThrow(function () {
    inv.assertAccountsValid(inv.foldAccountTerms(repaired))
  }, 'M1b 第 ' + g + ' 组：修复后不许出现负账户')
  // 二次重算是恒等变换
  assert.strictEqual(inv.repairReturnSplits(repaired), repaired,
    'M1b 第 ' + g + ' 组：修复后再跑一次必须零改动')
}
assert.ok(m1bBrokenBefore > 0, 'M1b 自检：修复前必须真的有组破坏拆分不变量，否则这条 fuzz 是假绿')
// 负账户主要来自「代 A 退货 payType 与销售过期」那一类，不只是 B2 ——
// 审计实测：把 B2 完全去掉，这条自检仍然绿。B2 自身的覆盖在 M1 和 M13 里有硬断言。
assert.ok(m1bNegativeBefore > 0, 'M1b 自检：修复前必须真的有组折出负账户，否则负账户断言是假绿')

// --- M1c：「纯代 A 且退货 payType 与销售一致」600 组，0 组欠款变化 ----------
// 生产上的 12 家店就是这一类（代 A、退货 payType 从销售单抄过去）。这一条把
// 「这次重算在生产数据上是恒等变换」钉住 —— 已经正确的账一分都不许动。
const rndGenA = mulberry32(20260826)
for (let g = 0; g < 600; g++) {
  const payType = rndGenA() < 0.5 ? 'credit' : 'cash'
  const amount = randomAmount2dp(rndGenA, 10, 2000)
  const customerId = 'ac-' + (g % 5)
  const sale = splitSale({ id: 'as-' + g, amount: amount, payType: payType, customerId: customerId })
  const corpus = [sale]
  let left = amount
  const retCount = Math.floor(rndGenA() * 3)   // 0..2 张退货
  for (let k = 0; k < retCount && left > 0.02; k++) {
    const retAmount = inv.round2(left * rndGenA() * 0.8)
    if (retAmount <= 0) break
    left = inv.round2(left - retAmount)
    corpus.push(splitReturn({
      id: 'ar-' + g + '-' + k, amount: retAmount, saleOrderId: 'as-' + g,
      createdAt: 3000 + k, customerId: customerId, payType: payType
    }))
  }
  // 掺一笔收款和一笔期初，确保比对的不只是销售/退货两项
  corpus.push(rec({ id: 'ap-' + g, type: 'pay', customerId: customerId, amount: inv.round2(amount * 0.1), createdAt: 4000 }))
  const before = inv.summarizeAllCustomerAccounts(corpus)
  const after = inv.summarizeAllCustomerAccounts(apply.legacyRecordsOf({ records: corpus }))
  assert.deepStrictEqual(after, before,
    'M1c 第 ' + g + ' 组：纯代 A 且 payType 一致时，整体重算必须是恒等变换')
}

// --- M2：settledAmount 六格分支表 -------------------------------------------
// 这张表是「不许把退货缺两个字段那一格改成 0」的护栏。改动 settledAmount 之前
// 先读它上面的注释，再读下面的 M2b。
const m2Table = [
  ['① paidAmount 缺 + payType=credit', { amount: 100, payType: 'credit' }, 0],
  ['② paidAmount 缺 + payType=cash', { amount: 100, payType: 'cash' }, 100],
  ['③ 两个字段都缺（代 B 的退货单）', { amount: 100 }, 100],
  ['④ paidAmount = 0', { amount: 100, paidAmount: 0 }, 0],
  ['⑤ paidAmount 正常', { amount: 100, paidAmount: 40 }, 40],
  ['⑥ paidAmount 超额，封顶到 amount', { amount: 100, paidAmount: 150 }, 100]
]
m2Table.forEach(function (row) {
  assert.strictEqual(inv.settledAmount(row[1]), row[2], 'M2 ' + row[0])
})
// paidAmount 的「算不算缺」判据：null / '' 算缺（退回 payType），0 不算缺
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: null, payType: 'credit' }), 0, 'M2 null 算缺，退回 payType')
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: '', payType: 'credit' }), 0, 'M2 空串算缺，退回 payType')
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: null }), 100, 'M2 null + 无 payType 仍是保守值 amount')
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: '' }), 100, 'M2 空串 + 无 payType 仍是保守值 amount')
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: 0 }), 0, 'M2 数字 0 不算缺，就是「一分没收」')
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: -5 }), 0, 'M2 负数钳到 0')
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: '40' }), 40, 'M2 字符串数字按数字算')
assert.strictEqual(inv.settledAmount({ amount: 100, payType: 'somethingElse' }), 100, 'M2 认不出的 payType 也走保守值')
assert.strictEqual(inv.settledAmount(null), 0, 'M2 空记录')
assert.strictEqual(inv.settledAmount(undefined), 0, 'M2 undefined')
// 返回值必须是 round2 的输出（recordTerms 的整数分等价性依赖这一条）
assert.strictEqual(inv.settledAmount({ amount: 100, paidAmount: 33.333 }), inv.round2(33.333), 'M2 返回值必须是 round2 的输出')

// --- M2b：反向断言，把「为什么不能改成 0」变成可执行的 ----------------------
// 只在这条测试里存在的假想实现：把 M2 表里第 ③ 格改成 0。
function settledAmountIfReturnsZero(record) {
  if (!record) return 0
  const amount = inv.toNumber(record.amount)
  if (record.paidAmount == null || record.paidAmount === '') {
    if (record.payType === 'credit') return 0
    if (record.payType === 'cash') return amount
    return 0                                  // ← 被否掉的那个改法
  }
  const paid = inv.round2(record.paidAmount)
  if (paid <= 0) return 0
  return paid > amount ? amount : paid
}
// 现结卖 100 / 退 30，退货单两个结算字段都没有，而且是**孤儿退货**
// （lines[0].saleOrderId 为空）—— 这是 repairReturnSplits 结构上修不了的那一类，
// 所以 settledAmount 的回推值就是最终值，改错了没有第二道防线。
const m2bSale = splitSale({ id: 'zs-1', amount: 100, payType: 'cash' })
const m2bReturn = splitReturn({ id: 'zr-1', amount: 30, saleOrderId: '' })
const m2bCorpus = apply.legacyRecordsOf({ records: [m2bSale, m2bReturn] })

// 现状（回推成 amount）：账是保守的、非负的，全店写路径畅通
assert.strictEqual(inv.settledAmount(m2bCorpus[1]), 30, 'M2b 现状：缺字段的退货回推成整笔现金')
assert.doesNotThrow(function () {
  inv.assertAccountsValid(inv.foldAccountTerms(m2bCorpus))
}, 'M2b 现状：assertAccountsValid 不抛，退货/改单/删单三条写路径畅通')

// 假想改法（回推成 0）：同一份语料折出 −30 的负账户
assert.strictEqual(settledAmountIfReturnsZero(m2bCorpus[1]), 0, 'M2b 自检：假想实现确实把第 ③ 格改成了 0')
const m2bZeroAccounts = {}
m2bCorpus.forEach(function (record) {
  if (record.type !== 'out' && record.type !== 'return') return
  const cid = record.customerId
  const credit = inv.toNumber(record.amount) - settledAmountIfReturnsZero(record)
  m2bZeroAccounts[cid] = inv.addTerms(m2bZeroAccounts[cid], Object.assign(inv.emptyTerms(), {
    creditSalesSum: record.type === 'out' ? Math.round(credit * 100) : 0,
    creditReturnsSum: record.type === 'return' ? Math.round(credit * 100) : 0,
    count: 1
  }), 1)
})
assert.strictEqual(inv.accountOf(m2bZeroAccounts.sc1).receivable, -30,
  'M2b：把第 ③ 格改成 0 会折出 −30 的欠款')
assert.throws(function () {
  inv.assertAccountsValid(m2bZeroAccounts)
}, /改完后收款会超过赊账/,
'M2b：负账户会让 assertAccountsValid 抛错 —— assertAccountsValid 是**全账户扫描**'
+ '（inventory.js 的 assertAccountsValid，被 applyReturnOrder / updateRecord / deleteRecord'
+ ' 三处调用），一个负账户 = 这家店从此退不了货、改不了单、删不了单。'
+ '这就是「退货缺两个字段时不许回推成 0」的第一条理由。')

console.log('退货份额整体重算：M1 ' + (m1Cases.length + 3) + ' 组语料、M1b fuzz 400 组'
  + '（修复前 ' + m1bBrokenBefore + ' 组破坏拆分不变量、' + m1bNegativeBefore + ' 组折出负账户）'
  + '、M1c 恒等 600 组，全部通过')

// 阶段 3 补口：非客户账记录（in / convert / adjust）不许折进任何客户 ——
// 哪怕单头挂着 customerId。折进去会把一笔进货算成客户的「已付」，
// 欠款凭空少一截。
assert.deepStrictEqual(
  inv.foldAccountTerms([
    { id: 'nc-in', type: 'in', amount: 15, profit: 0, remark: '', customerId: 'c1', createdAt: 1, lines: [] }
  ]),
  {},
  'foldAccountTerms：非客户账记录不进任何客户的账户（结果连键都不该有）'
);
assert.strictEqual(
  inv.accountOf(inv.foldAccountTerms([
    { id: 'nc-out', type: 'out', amount: 15, profit: 0, remark: '', customerId: 'c1', paidAmount: 0, createdAt: 1, lines: [] }
  ]).c1).receivable,
  15,
  '自检：out 带 customerId 正常折进 c1（paidAmount: 0 赊销 15）—— 上一条不是「怎么折都是空」的假绿'
);

console.log('ledger terms tests passed')
