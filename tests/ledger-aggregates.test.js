const assert = require('assert')
const inv = require('../utils/inventory')
const apply = require('../utils/ledger-apply')

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
}

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

// ---------------------------------------------------------------------------
// 1) summarizeAllCustomerAccounts 与 summarizeCustomerAccount 逐字段一致
// ---------------------------------------------------------------------------

function outLine(overrides) {
  return Object.assign({
    lineId: '',
    productId: 'p',
    productName: '货',
    qty: 1,
    unitPrice: 0,
    costPrice: 0,
    amount: 0,
    profit: 0,
    allocations: [],
    returnedQty: 0
  }, overrides)
}

const mixedRecords = [
  // 客户 c1：一笔赊账两行（一张单一条记录）+ 一笔现结 + 部分退货(赊账) + 部分收款 + 期初欠款
  rec({
    id: 'o1',
    type: 'out',
    customerId: 'c1',
    payType: 'credit',
    amount: 150,
    profit: 40,
    lines: [
      outLine({ lineId: 'o1-l1', amount: 100, profit: 30, returnedQty: 1 }),
      outLine({ lineId: 'o1-l2', amount: 50, profit: 10 })
    ]
  }),
  rec({
    id: 'o2',
    type: 'out',
    customerId: 'c1',
    payType: 'cash',
    amount: 40,
    profit: 8,
    lines: [outLine({ lineId: 'o2-l1', amount: 40, profit: 8 })]
  }),
  rec({
    id: 'ret1',
    type: 'return',
    customerId: 'c1',
    payType: 'credit',
    amount: 20,
    profit: -6,
    lines: [outLine({ lineId: 'ret1-l1', amount: 20, profit: -6, saleOrderId: 'o1', saleLineId: 'o1-l1' })]
  }),
  rec({ id: 'pay1', type: 'pay', customerId: 'c1', amount: 30 }),
  rec({ id: 'open1', type: 'opening', customerId: 'c1', amount: 15 }),

  // 客户 c2：现结整单退货 + 小额收款（本无欠款，收款会让 receivable 变负，用来检验字段独立不互相污染）
  rec({
    id: 'o3',
    type: 'out',
    customerId: 'c2',
    payType: 'cash',
    amount: 60,
    profit: 12,
    lines: [outLine({ lineId: 'o3-l1', amount: 60, profit: 12, returnedQty: 1 })]
  }),
  rec({
    id: 'ret2',
    type: 'return',
    customerId: 'c2',
    payType: 'cash',
    amount: 60,
    profit: -12,
    lines: [outLine({ lineId: 'ret2-l1', amount: 60, profit: -12, saleOrderId: 'o3', saleLineId: 'o3-l1' })]
  }),
  rec({ id: 'pay2', type: 'pay', customerId: 'c2', amount: 5 }),

  // 客户 c3：只有一笔赊账，无退货无收款
  rec({
    id: 'o4',
    type: 'out',
    customerId: 'c3',
    payType: 'credit',
    amount: 200,
    profit: 50,
    lines: [outLine({ lineId: 'o4-l1', amount: 200, profit: 50 })]
  }),

  // 与客户账无关的记录：进货、库存调整、无客户的销售（应计入 computeTotals 但不计入任何客户账）
  rec({ id: 'p1', type: 'in', amount: 500, profit: 0, lines: [outLine({ lineId: 'p1-l1', amount: 500 })] }),
  rec({ id: 'adj1', type: 'adjust_in', amount: 0, profit: 0, lines: [outLine({ lineId: 'adj1-l1' })] }),
  rec({
    id: 'noCust',
    type: 'out',
    customerId: '',
    payType: 'cash',
    amount: 999,
    profit: 999,
    lines: [outLine({ lineId: 'noCust-l1', amount: 999, profit: 999 })]
  })
]

const allAccounts = inv.summarizeAllCustomerAccounts(mixedRecords);
['c1', 'c2', 'c3'].forEach(function (customerId) {
  const single = inv.summarizeCustomerAccount(mixedRecords, customerId)
  assert.deepStrictEqual(allAccounts[customerId], {
    count: single.count,
    amount: single.amount,
    creditAmount: single.creditAmount,
    paidAmount: single.paidAmount,
    receivable: single.receivable
  }, '客户 ' + customerId + ' 的聚合结果应与逐个计算完全一致')
})

// 一张单一条记录：c1 的 o1（两行）算 1 单，加上 o2 共 2 单
assert.strictEqual(allAccounts.c1.count, 2)
// 无客户的销售不进入任何客户账
assert.ok(!Object.prototype.hasOwnProperty.call(allAccounts, ''), '空 customerId 不应生成账户条目')

// ---------------------------------------------------------------------------
// 2) computeTotals 与 summarizeRecords 深相等
// ---------------------------------------------------------------------------

assert.deepStrictEqual(inv.computeTotals(mixedRecords), inv.summarizeRecords(mixedRecords))
assert.deepStrictEqual(inv.computeTotals([]), inv.summarizeRecords([]))

// ---------------------------------------------------------------------------
// 3) 落库：applyMutation 跑若干笔 addSale(credit)/addPayment/addReturn 后
//    ledger.customers[].account 与 totals 应与现算结果一致
// ---------------------------------------------------------------------------

const nextId = idFactory()
let now = 1000
let ledger = apply.emptyLedger()

function mut(action, payload) {
  now += 10
  const res = apply.applyMutation(ledger, action, payload, now, nextId)
  ledger = res.ledger
  return res.result
}

const product = mut('saveProduct', {
  name: '测试商品',
  sku: 'T-001',
  costPrice: 10,
  salePrice: 20,
  stock: 1000,
  alertQty: 5
}).product

const custA = mut('saveCustomer', { name: '客户甲', phone: '13800000001' }).customer
const custB = mut('saveCustomer', { name: '客户乙', phone: '13800000002' }).customer

const orderA = mut('addSale', {
  customerId: custA.id,
  customerName: custA.name,
  payType: 'credit',
  items: [{ productId: product.id, qty: 3, unitPrice: 20 }]
}).order
const saleLineIdA = orderA.lines[0].lineId

mut('addSale', {
  customerId: custB.id,
  customerName: custB.name,
  payType: 'credit',
  items: [{ productId: product.id, qty: 2, unitPrice: 20 }]
})

mut('addPayment', { customerId: custA.id, amount: 20 })

mut('addReturn', {
  items: [{ saleOrderId: orderA.id, saleLineId: saleLineIdA, qty: 1 }]
})

ledger.customers.forEach(function (customer) {
  const expected = inv.summarizeCustomerAccount(ledger.records, customer.id)
  assert.strictEqual(customer.account.receivable, expected.receivable,
    '客户 ' + customer.name + ' 的落库 receivable 应与现算一致')
  assert.deepStrictEqual(customer.account, {
    count: expected.count,
    amount: expected.amount,
    creditAmount: expected.creditAmount,
    paidAmount: expected.paidAmount,
    receivable: expected.receivable
  })
})
assert.strictEqual(ledger.totals.receivable, inv.getTotalReceivable(ledger.records))

// ---------------------------------------------------------------------------
// 4) 边界：空账本 totals/账户全 0；全额收款后 receivable 为 0 而非负数或 NaN
// ---------------------------------------------------------------------------

const blankLedger = apply.emptyLedger()
assert.deepStrictEqual(blankLedger.totals, {
  salesAmount: 0,
  purchaseAmount: 0,
  profit: 0,
  receivable: 0,
  count: 0
})

const blankLedgerResult = apply.applyMutation(blankLedger, 'saveCustomer', { name: '零流水客户' }, 2000, nextId)
const blankCustomer = blankLedgerResult.ledger.customers.find(function (item) {
  return item.id === blankLedgerResult.result.customer.id
})
assert.deepStrictEqual(blankCustomer.account, {
  count: 0,
  amount: 0,
  creditAmount: 0,
  paidAmount: 0,
  receivable: 0
})

// custB 目前欠 40（赊账 2 件 x 20），补齐全款后应精确归零
mut('addPayment', { customerId: custB.id, amount: 40 })
const custBAfterPayoff = ledger.customers.find(function (item) {
  return item.id === custB.id
})
assert.strictEqual(custBAfterPayoff.account.receivable, 0)
assert.ok(!Number.isNaN(custBAfterPayoff.account.receivable))
assert.ok(custBAfterPayoff.account.receivable >= 0)

// ---------------------------------------------------------------------------
// 5) assertReceivableValid 行为不变：收款超过赊账时仍抛出原错误信息
// ---------------------------------------------------------------------------

// assertReceivableValid 本身不导出，通过内部会调用它的 updateRecord 间接触发：
// 期初欠款 80 全额收款后，把期初金额改小到 20，会让 receivable 变负，
// 校验重写为单遍聚合后错误信息仍然一字不差。
const openingBase = inv.applyOpening([], {
  customerId: 'c-over',
  customerName: '测试客户',
  amount: 80
}, 9000, 'r-open-over')
const openingPaid = inv.applyPayment(openingBase.records, {
  customerId: 'c-over',
  customerName: '测试客户',
  amount: 80
}, 9010, 'r-pay-over')
assert.throws(function () {
  inv.updateRecord([], openingPaid.records, {
    id: 'r-open-over',
    amount: 20
  }, 9020, [])
}, function (error) {
  return error.message === '改完后收款会超过赊账，请先改收款记录'
})

console.log('ledger aggregates tests passed')
