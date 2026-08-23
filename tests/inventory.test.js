const assert = require('assert')
const inv = require('../utils/inventory')

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
}

// 单行销售的写法糖：一张单一条记录，行号从单号派生，方便断言
function sale(products, records, payload, now, id, skus) {
  let n = 0
  return inv.applySaleOrder(products, records, Object.assign({}, payload, {
    items: [{
      productId: payload.productId,
      skuId: payload.skuId,
      color: payload.color,
      size: payload.size,
      qty: payload.qty,
      unitPrice: payload.unitPrice
    }]
  }), now, id, function () {
    n += 1
    return id + '-l' + n
  }, skus)
}

function line0(record) {
  return inv.firstLine(record)
}

function sampleProduct(overrides) {
  return inv.createProduct(Object.assign({
    name: '纯牛奶',
    sku: 'MK-001',
    costPrice: 2.8,
    salePrice: 4.5,
    stock: 10,
    alertQty: 5
  }, overrides || {}), 1000, 'p1')
}

assert.strictEqual(inv.round2(2.005), 2.01)
assert.strictEqual(inv.calcMargin(2.8, 4.5).profit, 1.7)
assert.strictEqual(inv.calcMargin(2.8, 4.5).rate, 37.78)

assert.throws(function () {
  inv.createProduct({ name: '  ', costPrice: 1, salePrice: 2, stock: 1 }, 1, 'x')
}, /商品名称/)

assert.throws(function () {
  inv.createProduct({ name: 'A', costPrice: -1, salePrice: 2, stock: 1 }, 1, 'x')
}, /价格/)

assert.throws(function () {
  inv.createProduct({
    name: '卫衣',
    costPrice: 45,
    salePrice: 99,
    stock: 20,
    blankProcess: true
  }, 1000, 'p-no-spec')
}, /规格/)

const created = sampleProduct()
assert.strictEqual(created.alertQty, 5)
assert.strictEqual(created.stock, 10)

const updated = inv.updateProduct(created, {
  name: '纯牛奶 250ml',
  sku: 'MK-001',
  costPrice: 3,
  salePrice: 5,
  alertQty: 4,
  stock: 99
}, 2000)
assert.strictEqual(updated.stock, 10)
assert.strictEqual(updated.costPrice, 3)
assert.strictEqual(updated.name, '纯牛奶 250ml')

const purchased = inv.applyPurchase([created], [], {
  productId: 'p1',
  qty: 5,
  unitPrice: 2.6,
  remark: '到货'
}, 3000, 'r1')
assert.strictEqual(purchased.products[0].stock, 15)
assert.strictEqual(purchased.products[0].costPrice, 2.6)
assert.strictEqual(purchased.record.type, 'in')
assert.strictEqual(purchased.record.amount, 13)
assert.strictEqual(purchased.record.profit, 0)

assert.throws(function () {
  sale([created], [], { productId: 'p1', qty: 11, unitPrice: 4.5 }, 4000, 'r2')
}, /库存不足/)

const sold = sale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 4,
  unitPrice: 4.5
}, 5000, 'r3')
assert.strictEqual(sold.products[0].stock, 11)
assert.strictEqual(sold.record.profit, 7.6)
assert.strictEqual(sold.record.amount, 18)
assert.strictEqual(sold.record.paidAmount, 18)
assert.strictEqual(sold.record.payType, undefined)
assert.strictEqual(sold.record.operatorOpenid, '')
assert.strictEqual(sold.record.operatorName, '')

const low = sampleProduct({ stock: 5, alertQty: 5 })
assert.strictEqual(inv.isLowStock(low), true)
assert.strictEqual(inv.isLowStock(sampleProduct({ stock: 6, alertQty: 5 })), false)

const now = new Date('2026-08-15T12:00:00').getTime()
const sameDayPurchase = inv.applyPurchase([created], [], {
  productId: 'p1',
  qty: 5,
  unitPrice: 2.6
}, now - 3600000, 'r-day-in')
const sameDaySale = sale(sameDayPurchase.products, sameDayPurchase.records, {
  productId: 'p1',
  qty: 4,
  unitPrice: 4.5
}, now - 1800000, 'r-day-out')
// T-B6：2b-2b 起 getDashboard 的签名是 (products, recent, now, skus, totals, today)。
// 今日三项不再由它从整本流水现折 —— 那是服务端按客户端给的 dayStart 算好的
// todayTotals 投影，这里把同一份纯函数当语料喂进去，口径一致。
const dashboard = inv.getDashboard(
  sameDaySale.products, sameDaySale.records, now, undefined, null,
  inv.todayTotals(sameDaySale.records, inv.startOfDay(now))
)
assert.strictEqual(dashboard.productCount, 1)
assert.strictEqual(dashboard.totalStock, 11)
assert.strictEqual(dashboard.todaySalesAmount, 18)
assert.strictEqual(dashboard.todayProfit, 7.6)
assert.strictEqual(dashboard.todayInAmount, 13)
assert.strictEqual(dashboard.alertCount, 0)
assert.strictEqual(dashboard.totalReceivable, 0)

const filtered = inv.filterProducts([
  created,
  sampleProduct({ name: '矿泉水', sku: 'WT-004', barcode: '123' })
], 'wt')
assert.strictEqual(filtered.length, 1)
assert.strictEqual(filtered[0].sku, 'WT-004')

const summary = inv.summarizeRecords(sold.records)
assert.strictEqual(summary.count, 2)
assert.strictEqual(summary.profit, 7.6)

const seed = inv.buildSeed(now, idFactory())
assert.strictEqual(seed.products.length, 6)
assert.ok(seed.records.length >= 3)
assert.ok(seed.products.some(inv.isLowStock))
assert.ok(seed.skus.length >= 4)
const seedTee = seed.products.find(function (item) {
  return item.name === '短袖 T恤'
})
assert.ok(inv.productHasSpecs(seedTee))
assert.ok(inv.isLowStock(seedTee, seed.skus))
const milk = seed.products.find(function (item) {
  return item.name.indexOf('纯牛奶') >= 0
})
assert.strictEqual(inv.productHasSpecs(milk), false)
assert.strictEqual(seed.customers.length, 2)
assert.ok(seed.categories.length >= 2)
assert.ok(seed.categories.some(function (item) {
  return item.name === '纺织' && item.productKind === 'finished'
}))
assert.ok(seed.records.some(function (item) {
  return item.type === 'out' && item.customerName === '张三超市'
}))
const seedZhang = seed.customers.find(function (item) {
  return item.name === '张三超市'
})
assert.strictEqual(inv.summarizeCustomerAccount(seed.records, seedZhang.id).receivable, 17)

assert.throws(function () {
  inv.createCustomer({ name: '  ' }, 1, 'c0')
}, /客户名称/)

const customer = inv.createCustomer({
  name: '张三超市',
  phone: '13800138000',
  address: '建设路12号',
  remark: '内部备注'
}, 6000, 'c1')
assert.strictEqual(customer.phone, '13800138000')
assert.strictEqual(customer.lastSaleAt, 0)

const updatedCustomer = inv.updateCustomer(customer, {
  name: '张三超市（总店）',
  phone: '13800138000',
  address: '建设路12号'
}, 7000)
assert.strictEqual(updatedCustomer.name, '张三超市（总店）')
assert.strictEqual(updatedCustomer.lastSaleAt, 0)
assert.strictEqual(updatedCustomer.createdAt, 6000)

const soldToCustomer = sale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 1,
  unitPrice: 4.5,
  customerId: 'c1',
  customerName: '张三超市',
  customerPhone: '13800138000',
  customerAddress: '建设路12号'
}, 8000, 'r4')
assert.strictEqual(soldToCustomer.record.customerName, '张三超市')
assert.strictEqual(sold.record.customerName, '')

assert.throws(function () {
  sale(purchased.products, purchased.records, {
    productId: 'p1',
    qty: 1,
    unitPrice: 4.5,
    paidAmount: 0
  }, 8100, 'r-credit-no-customer')
}, /客户/)

assert.throws(function () {
  sale(purchased.products, purchased.records, {
    productId: 'p1',
    qty: 1,
    unitPrice: 4.5,
    customerId: 'c1',
    customerName: '张三超市',
    paidAmount: 5
  }, 8100, 'r-over-paid')
}, /实收不能超过应收/)

const creditSale = sale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 2,
  unitPrice: 4.5,
  customerId: 'c1',
  customerName: '张三超市',
  paidAmount: 0
}, 8200, 'r-credit')
assert.strictEqual(creditSale.record.paidAmount, 0)
assert.strictEqual(inv.summarizeCustomerAccount(creditSale.records, 'c1').receivable, 9)

// 老流水只有 payType 没有实收：读的时候按现结收满、赊账一分未收回推。
const legacyCredit = { id: 'legacy-credit', type: 'out', customerId: 'c-legacy', amount: 100, qty: 1, unitPrice: 100, payType: 'credit', orderId: 'legacy-credit', createdAt: 1 }
const legacyCash = { id: 'legacy-cash', type: 'out', customerId: 'c-legacy', amount: 60, qty: 1, unitPrice: 60, payType: 'cash', orderId: 'legacy-cash', createdAt: 2 }
assert.strictEqual(inv.settledAmount(legacyCredit), 0)
assert.strictEqual(inv.settledAmount(legacyCash), 60)
assert.strictEqual(inv.summarizeCustomerAccount([legacyCredit, legacyCash], 'c-legacy').receivable, 100)
assert.strictEqual(inv.getTotalReceivable([legacyCredit, legacyCash]), 100)

const paid = inv.applyPayment(creditSale.records, {
  customerId: 'c1',
  customerName: '张三超市',
  amount: 4
}, 8300, 'r-pay')
assert.strictEqual(paid.record.type, 'pay')
assert.strictEqual(inv.summarizeCustomerAccount(paid.records, 'c1').receivable, 5)

assert.throws(function () {
  inv.applyPayment(paid.records, {
    customerId: 'c1',
    customerName: '张三超市',
    amount: 6
  }, 8400, 'r-pay-over')
}, /超过/)

assert.throws(function () {
  inv.applyOpening([], { amount: 80 }, 8410, 'r-open-no-customer')
}, /客户/)
assert.throws(function () {
  inv.applyOpening([], { customerId: 'c1', amount: 0 }, 8415, 'r-open-zero')
}, /期初欠款/)

const opened = inv.applyOpening(purchased.records, {
  customerId: 'c-open',
  customerName: '旧账客户',
  amount: 80,
  remark: '上线前欠款'
}, 8420, 'r-open')
assert.strictEqual(opened.record.type, 'opening')
assert.strictEqual(opened.record.profit, 0)
assert.strictEqual(inv.summarizeCustomerAccount(opened.records, 'c-open').receivable, 80)
assert.strictEqual(inv.summarizeCustomerAccount(opened.records, 'c-open').count, 0)
assert.strictEqual(inv.summarizeCustomerAccount(opened.records, 'c-open').amount, 0)
assert.strictEqual(inv.getTotalReceivable(opened.records), 80)
assert.strictEqual(purchased.products[0].stock, 15)

const openDash = inv.getDashboard(
  purchased.products, opened.records, now, undefined,
  inv.summarizeRecords(opened.records),
  inv.todayTotals(opened.records, inv.startOfDay(now))
)
assert.strictEqual(openDash.todaySalesAmount, 0)
assert.strictEqual(openDash.todayProfit, 0)
assert.strictEqual(openDash.totalReceivable, 80)
// totals 缺席时不再有 getTotalReceivable(records) 兜底：分页之后 records 只剩
// 一页，兜底会算出一个偏小的欠款 —— 比没有更糟，所以给 0 并让 today 为 null
const noTotalsDash = inv.getDashboard(purchased.products, opened.records, now)
assert.strictEqual(noTotalsDash.totalReceivable, 0,
  'T-B6：没有 totals 就不许现折欠款')
assert.strictEqual(noTotalsDash.todayAvailable, false)
assert.strictEqual(noTotalsDash.todaySalesAmount, null,
  'T-B6：今日三项算不出来给 null，页面显示「—」而不是 0')
assert.strictEqual(noTotalsDash.todayProfit, null)
assert.strictEqual(noTotalsDash.todayInAmount, null)

const openPaid = inv.applyPayment(opened.records, {
  customerId: 'c-open',
  customerName: '旧账客户',
  amount: 30
}, 8430, 'r-open-pay')
assert.strictEqual(inv.summarizeCustomerAccount(openPaid.records, 'c-open').receivable, 50)
assert.throws(function () {
  inv.applyPayment(openPaid.records, {
    customerId: 'c-open',
    amount: 51
  }, 8440, 'r-open-pay-over')
}, /超过/)

const openEdited = inv.updateRecord(purchased.products, openPaid.records, {
  id: 'r-open',
  amount: 90
}, 8450, [])
assert.strictEqual(inv.summarizeCustomerAccount(openEdited.records, 'c-open').receivable, 60)

assert.throws(function () {
  inv.updateRecord(purchased.products, openPaid.records, {
    id: 'r-open',
    amount: 20
  }, 8460, [])
}, /超过赊账/)

assert.throws(function () {
  inv.deleteRecord(purchased.products, openPaid.records, 'r-open', 8470, [])
}, /超过赊账/)

const openDeleted = inv.deleteRecord(purchased.products, opened.records, 'r-open', 8480, [])
assert.strictEqual(inv.summarizeCustomerAccount(openDeleted.records, 'c-open').receivable, 0)
assert.strictEqual(openDeleted.products[0].stock, 15)

const mixedOpen = inv.applyOpening(creditSale.records, {
  customerId: 'c1',
  customerName: '张三超市',
  amount: 10
}, 8490, 'r-open-c1')
assert.strictEqual(inv.summarizeCustomerAccount(mixedOpen.records, 'c1').receivable, 19)
assert.strictEqual(inv.summarizeCustomerAccount(mixedOpen.records, 'c1').amount, 9)
assert.strictEqual(inv.summarizeCustomerAccount(mixedOpen.records, 'c1').count, 1)

const customerSales = inv.summarizeCustomerAccount(soldToCustomer.records, 'c1')
assert.strictEqual(customerSales.count, 1)
assert.strictEqual(customerSales.amount, 4.5)

const foundCustomers = inv.filterCustomers([customer, inv.createCustomer({
  name: '李记便利',
  phone: '13900139000'
}, 9000, 'c2')], '139')
assert.strictEqual(foundCustomers.length, 1)
assert.strictEqual(foundCustomers[0].name, '李记便利')

assert.throws(function () {
  inv.applySaleOrder([created], [], { items: [] }, 9000, 'o0', idFactory())
}, /加入商品/)

const bread = inv.createProduct({
  name: '全麦面包',
  sku: 'BD-002',
  costPrice: 5.5,
  salePrice: 9.9,
  stock: 8,
  alertQty: 10
}, 1000, 'p2')

const multi = inv.applySaleOrder(
  [purchased.products[0], bread],
  purchased.records,
  {
    items: [
      { productId: 'p1', qty: 2, unitPrice: 4.5 },
      { productId: 'p2', qty: 1, unitPrice: 9.9 }
    ],
    customerId: 'c1',
    customerName: '张三超市',
    paidAmount: 0
  },
  9100,
  'order-1',
  idFactory()
)
// 一张单一条记录：两行商品在同一条 records 里
assert.strictEqual(multi.order.id, 'order-1')
assert.strictEqual(multi.order.lines.length, 2)
assert.strictEqual(multi.order.amount, 18.9)
assert.strictEqual(multi.order, multi.records[0])
assert.strictEqual(multi.records.filter(function (item) {
  return item.type === 'out'
}).length, 1)
assert.strictEqual(multi.order.lines[0].productId, 'p1')
assert.strictEqual(multi.order.lines[1].productId, 'p2')
assert.strictEqual(multi.order.lines[0].returnedQty, 0)
assert.strictEqual(multi.products.find(function (item) { return item.id === 'p1' }).stock, 13)
assert.strictEqual(multi.products.find(function (item) { return item.id === 'p2' }).stock, 7)
assert.strictEqual(inv.summarizeCustomerAccount(multi.records, 'c1').receivable, 18.9)
assert.ok(!Object.prototype.hasOwnProperty.call(multi.order, 'receivableSnapshot'))
assert.strictEqual(inv.receivableAt(multi.records, 'c1', multi.order.createdAt), 18.9)

assert.strictEqual(inv.orderProductTitle(multi.order.lines), '纯牛奶、全麦面包')
assert.strictEqual(inv.summarizeCustomerAccount(multi.records, 'c1').count, 1)
// recent 现在是服务端给的一页，getDashboard 只做 slice(0,10)
assert.strictEqual(inv.getDashboard(multi.products, multi.records, 9100).recent[0].lines.length, 2)
assert.strictEqual(inv.getDashboard(multi.products, undefined, 9100).recent.length, 0,
  'T-B6：没有 recent 时不许炸，给空列表')

const cookie = inv.createProduct({
  name: '苏打饼干',
  sku: 'CK-003',
  costPrice: 3,
  salePrice: 6,
  stock: 20
}, 1000, 'p-cookie')
const juice = inv.createProduct({
  name: '橙汁',
  costPrice: 4,
  salePrice: 8,
  stock: 0,
  colors: ['原味', '加糖']
}, 1000, 'p-juice')
const juiceSkus = inv.applyProductSkus(juice, [], [
  { color: '原味', size: '', stock: 10, costPrice: 4, salePrice: 8, alertQty: 2 },
  { color: '加糖', size: '', stock: 10, costPrice: 4, salePrice: 8, alertQty: 2 }
], 1100, idFactory())
const titleOrder = inv.applySaleOrder(
  [sampleProduct({ stock: 10 }), bread, cookie, juiceSkus.product],
  [],
  {
    items: [
      { productId: 'p1', qty: 1, unitPrice: 4.5 },
      { productId: 'p2', qty: 1, unitPrice: 9.9 },
      { productId: 'p-cookie', qty: 1, unitPrice: 6 },
      { productId: 'p-juice', skuId: juiceSkus.skus[0].id, qty: 1, unitPrice: 8 },
      { productId: 'p-juice', skuId: juiceSkus.skus[1].id, qty: 1, unitPrice: 8 }
    ]
  },
  9200,
  'order-title-lines',
  idFactory(),
  juiceSkus.skus
)
assert.strictEqual(titleOrder.order.lines.length, 5)
assert.strictEqual(inv.orderProductTitle(titleOrder.order.lines), '纯牛奶、全麦面包 等5种')

const orderItemsEdit = inv.updateRecord(multi.products, multi.records, {
  id: 'order-1',
  items: [
    { id: multi.order.lines[0].lineId, qty: 3, unitPrice: 4.5 },
    { id: multi.order.lines[1].lineId, qty: 1, unitPrice: 9.9 }
  ],
  paidAmount: 0,
  customerId: 'c1',
  customerName: '张三超市',
  remark: '整单备注'
}, 9110, [])
assert.strictEqual(orderItemsEdit.products.find(function (item) { return item.id === 'p1' }).stock, 12)
assert.strictEqual(orderItemsEdit.record.remark, '整单备注')
assert.strictEqual(orderItemsEdit.record.amount, 23.4)
assert.strictEqual(orderItemsEdit.record.lines.length, 2)
assert.throws(function () {
  inv.updateRecord(multi.products, multi.records, {
    id: 'order-1',
    items: [{ id: 'not-a-line', qty: 1, unitPrice: 1 }],
    payType: 'cash',
    customerId: 'c1'
  }, 9111, [])
}, /流水不存在/)

const deletedOrder = inv.deleteRecord(multi.products, multi.records, 'order-1', 9120, [])
assert.strictEqual(deletedOrder.records.filter(function (item) {
  return item.id === 'order-1'
}).length, 0)
assert.strictEqual(deletedOrder.products.find(function (item) { return item.id === 'p1' }).stock, 15)
assert.strictEqual(deletedOrder.products.find(function (item) { return item.id === 'p2' }).stock, 8)

const paidAll = inv.applyPayment(multi.records, {
  customerId: 'c1',
  customerName: '张三超市',
  amount: 18.9
}, 10000, 'r-pay-all')
assert.strictEqual(inv.summarizeCustomerAccount(paidAll.records, 'c1').receivable, 0)
assert.strictEqual(inv.receivableAt(paidAll.records, 'c1', 9100), 18.9)

assert.throws(function () {
  inv.applySaleOrder([created], [], {
    items: [
      { productId: 'p1', qty: 6, unitPrice: 4.5 },
      { productId: 'p1', qty: 6, unitPrice: 4.5 }
    ]
  }, 9200, 'order-2', idFactory())
}, /库存不足/)
assert.strictEqual(created.stock, 10)

assert.deepStrictEqual(inv.skuCombos(['黑', '白'], ['M', 'L']).length, 4)
assert.deepStrictEqual(inv.skuCombos(['黑'], []), [{ color: '黑', size: '' }])
assert.strictEqual(inv.specText('黑色', 'M'), '黑色 · M')
assert.deepStrictEqual(inv.specParts({ color: '黑色', size: 'M' }, { specAxis1: '颜色', specAxis2: '尺码' }), [
  { name: '颜色', value: '黑色' },
  { name: '尺码', value: 'M' }
])
assert.strictEqual(inv.specLabelText(inv.specParts({ color: '原味' }, { specAxis1: '口味' })), '口味 原味')
assert.strictEqual(inv.specLabelText(inv.specParts({ color: '黑色', size: 'M' })), '黑色 · M')
assert.strictEqual(inv.specAxis1Name({}), '规格一')
assert.strictEqual(inv.specAxis2Name({ specAxis2: '容量' }), '容量')
assert.strictEqual(inv.specKindTag({}), '')

const tea = inv.createProduct({
  name: '绿茶',
  costPrice: 10,
  salePrice: 20,
  stock: 0,
  specAxis1: '口味',
  specAxis2: '克数',
  colors: ['原味', '茉莉'],
  sizes: ['50g', '100g']
}, 1000, 'p-tea')
assert.strictEqual(tea.specAxis1, '口味')
assert.strictEqual(tea.specAxis2, '克数')
assert.strictEqual(inv.specSelectHint(tea), '请选择口味和克数')
assert.strictEqual(inv.specKindTag(tea), '分规格现货')

const blankTea = inv.createProduct({
  name: '待炒绿茶',
  costPrice: 8,
  salePrice: 18,
  stock: 12,
  specAxis1: '口味',
  colors: ['原味'],
  blankProcess: true
}, 1000, 'p-blank-tea')
assert.strictEqual(inv.specKindTag(blankTea), '待加工')
assert.strictEqual(inv.specSelectHint(blankTea), '请选择口味')
assert.strictEqual(inv.specAxis2Name(blankTea), '规格二')

const tee = inv.createProduct({
  name: '短袖',
  costPrice: 28,
  salePrice: 59,
  stock: 10,
  alertQty: 4,
  colors: ['黑色', '白色'],
  sizes: ['M', 'L']
}, 1000, 'p-tee')
const teeSkus = inv.applyProductSkus(tee, [], [
  { color: '黑色', size: 'M', stock: 6, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '黑色', size: 'L', stock: 2, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '白色', size: 'M', stock: 8, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '白色', size: 'L', stock: 5, costPrice: 28, salePrice: 59, alertQty: 4 }
], 1100, idFactory())
assert.strictEqual(teeSkus.product.stock, 21)
assert.strictEqual(teeSkus.skus.length, 4)
assert.strictEqual(inv.isLowStock(teeSkus.product, teeSkus.skus), true)

const migrated = inv.applyProductSkus(inv.createProduct({
  name: '旧衣服',
  costPrice: 10,
  salePrice: 20,
  stock: 12,
  colors: ['红'],
  sizes: ['S']
}, 1200, 'p-old'), [], null, 1300, idFactory())
assert.strictEqual(migrated.skus[0].stock, 12)
assert.strictEqual(migrated.product.stock, 12)

assert.throws(function () {
  inv.applyProductSkus(inv.updateProduct(teeSkus.product, {
    name: '短袖',
    costPrice: 28,
    salePrice: 59,
    alertQty: 4,
    colors: ['白色'],
    sizes: ['M', 'L']
  }, 1400), teeSkus.skus, null, 1400, idFactory())
}, /还有库存/)

assert.throws(function () {
  sale([teeSkus.product], [], {
    productId: 'p-tee',
    qty: 1,
    unitPrice: 59
  }, 1500, 'r-spec-miss', teeSkus.skus)
}, /规格一和规格二/)

const blackM = teeSkus.skus.find(function (item) {
  return item.color === '黑色' && item.size === 'M'
})
const soldTee = sale([teeSkus.product], [], {
  productId: 'p-tee',
  skuId: blackM.id,
  qty: 2,
  unitPrice: 59
}, 1600, 'r-tee', teeSkus.skus)
assert.strictEqual(line0(soldTee.record).color, '黑色')
assert.strictEqual(line0(soldTee.record).size, 'M')
assert.strictEqual(soldTee.record.profit, 62)
assert.strictEqual(soldTee.skus.find(function (item) { return item.id === blackM.id }).stock, 4)
assert.strictEqual(soldTee.products[0].stock, 19)

const boughtTee = inv.applyPurchase(soldTee.products, soldTee.records, {
  productId: 'p-tee',
  skuId: blackM.id,
  qty: 3,
  unitPrice: 30
}, 1700, 'r-tee-in', soldTee.skus)
assert.strictEqual(boughtTee.skus.find(function (item) { return item.id === blackM.id }).stock, 7)
assert.strictEqual(boughtTee.skus.find(function (item) { return item.id === blackM.id }).costPrice, 30)
assert.strictEqual(boughtTee.products[0].stock, 22)
assert.strictEqual(boughtTee.products[0].costPrice, 28)

const folded = inv.applyProductSkus(inv.updateProduct(boughtTee.products[0], {
  name: '短袖',
  costPrice: 28,
  salePrice: 59,
  alertQty: 4,
  colors: [],
  sizes: []
}, 1800), boughtTee.skus, [], 1800, idFactory())
assert.strictEqual(inv.productHasSpecs(folded.product), false)
assert.strictEqual(folded.product.stock, 22)
assert.strictEqual(folded.skus.length, 0)

const specOrder = inv.applySaleOrder(
  soldTee.products.concat([created]),
  [],
  {
    items: [
      { productId: 'p-tee', skuId: blackM.id, qty: 1, unitPrice: 59 },
      { productId: 'p1', qty: 1, unitPrice: 4.5 }
    ]
  },
  1900,
  'order-spec',
  idFactory(),
  soldTee.skus
)
assert.strictEqual(specOrder.order.lines.length, 2)
assert.strictEqual(specOrder.order.lines[0].size, 'M')
assert.strictEqual(specOrder.skus.find(function (item) { return item.id === blackM.id }).stock, 3)

const colorOnly = inv.filterProducts([teeSkus.product], '黑色', teeSkus.skus)
assert.strictEqual(colorOnly.length, 1)

assert.throws(function () {
  inv.updateRecord([created], [], { id: 'missing', qty: 1, unitPrice: 1 }, 2000, [])
}, /流水不存在/)

const editedSale = inv.updateRecord(sold.products, sold.records, {
  id: 'r3',
  qty: 2,
  unitPrice: 4.5
}, 2100, [])
assert.strictEqual(editedSale.products[0].stock, 13)
assert.strictEqual(line0(editedSale.record).qty, 2)
assert.strictEqual(editedSale.record.amount, 9)
assert.strictEqual(editedSale.record.profit, 3.8)

assert.throws(function () {
  inv.updateRecord(sold.products, sold.records, {
    id: 'r3',
    qty: 20,
    unitPrice: 4.5
  }, 2200, [])
}, /库存不足/)

const editedPurchase = inv.updateRecord(purchased.products, purchased.records, {
  id: 'r1',
  qty: 8,
  unitPrice: 2.4
}, 2300, [])
assert.strictEqual(editedPurchase.products[0].stock, 18)
assert.strictEqual(editedPurchase.products[0].costPrice, 2.4)
assert.strictEqual(editedPurchase.record.amount, 19.2)

const deletedSale = inv.deleteRecord(sold.products, sold.records, 'r3', 2400, [])
assert.strictEqual(deletedSale.products[0].stock, 15)
assert.strictEqual(deletedSale.records.some(function (item) { return item.id === 'r3' }), false)

const heavySale = sale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 12,
  unitPrice: 4.5
}, 2450, 'r-heavy')
assert.throws(function () {
  inv.deleteRecord(heavySale.products, heavySale.records, 'r1', 2500, [])
}, /库存不足/)

const editedPay = inv.updateRecord(paid.products || purchased.products, paid.records, {
  id: 'r-pay',
  amount: 3
}, 2600, [])
assert.strictEqual(editedPay.record.amount, 3)
assert.strictEqual(inv.summarizeCustomerAccount(editedPay.records, 'c1').receivable, 6)

assert.throws(function () {
  inv.updateRecord(paid.products || purchased.products, paid.records, {
    id: 'r-pay',
    amount: 20
  }, 2700, [])
}, /超过/)

assert.throws(function () {
  inv.deleteRecord(creditSale.products, paid.records, 'r-credit', 2800, [])
}, /超过赊账/)

// 多行单不给 items 就没法定位改哪一行
assert.throws(function () {
  inv.updateRecord(multi.products, multi.records, {
    id: 'order-1',
    qty: 2,
    unitPrice: 4.5,
    payType: 'cash',
    customerId: 'c1'
  }, 2890, [])
}, /请逐行填写/)

const orderEdit = inv.updateRecord(multi.products, multi.records, {
  id: 'order-1',
  items: [
    { id: multi.order.lines[0].lineId, qty: 2, unitPrice: 4.5 },
    { id: multi.order.lines[1].lineId, qty: 1, unitPrice: 9.9 }
  ],
  paidAmount: 9,
  customerId: 'c1',
  customerName: '张三超市'
}, 2900, [])
assert.strictEqual(orderEdit.record.amount, 18.9)
assert.strictEqual(orderEdit.record.paidAmount, 9)
assert.strictEqual(orderEdit.record.payType, undefined)

const specEdited = inv.updateRecord(soldTee.products, soldTee.records, {
  id: 'r-tee',
  qty: 1,
  unitPrice: 59
}, 3000, soldTee.skus)
assert.strictEqual(specEdited.skus.find(function (item) { return item.id === blackM.id }).stock, 5)
assert.strictEqual(specEdited.products[0].stock, 20)

function blankHoodie() {
  const product = inv.createProduct({
    name: '卫衣',
    costPrice: 45,
    salePrice: 99,
    stock: 20,
    alertQty: 5,
    colors: ['黑色', '白色', '红色'],
    sizes: ['M', 'L'],
    blankProcess: true
  }, 1000, 'p-hoodie')
  return inv.applyProductSkus(product, [], null, 1100, idFactory())
}

const hoodieMade = blankHoodie()
assert.strictEqual(hoodieMade.product.blankProcess, true)
assert.strictEqual(inv.specKindTag(hoodieMade.product), '待加工')
assert.ok(inv.skuSummaryText(hoodieMade.product, hoodieMade.skus).indexOf('待加工') === 0)
assert.strictEqual(hoodieMade.product.stock, 20)
const hoodieBlank = inv.findBlankSku(hoodieMade.skus, 'p-hoodie')
assert.ok(hoodieBlank)
assert.strictEqual(hoodieBlank.stock, 20)
assert.strictEqual(inv.isLowStock(hoodieMade.product, hoodieMade.skus), false)
const whiteM = inv.findSkuBySpec(hoodieMade.skus, 'p-hoodie', '白色', 'M')
assert.strictEqual(whiteM.stock, 0)

const hoodieFolded = inv.applyProductSkus(inv.updateProduct(hoodieMade.product, {
  name: '卫衣',
  costPrice: 45,
  salePrice: 99,
  alertQty: 5,
  colors: [],
  sizes: [],
  blankProcess: false
}, 1150), hoodieMade.skus, [], 1150, idFactory())
assert.strictEqual(hoodieFolded.product.blankProcess, false)
assert.strictEqual(hoodieFolded.product.stock, 20)
assert.strictEqual(hoodieFolded.skus.length, 0)

const boughtBlank = inv.applyPurchase([hoodieMade.product], [], {
  productId: 'p-hoodie',
  qty: 5,
  unitPrice: 40
}, 1200, 'r-hoodie-in', hoodieMade.skus)
assert.strictEqual(inv.findBlankSku(boughtBlank.skus, 'p-hoodie').stock, 25)
assert.strictEqual(boughtBlank.products[0].stock, 25)

const soldWhite = sale(boughtBlank.products, boughtBlank.records, {
  productId: 'p-hoodie',
  skuId: whiteM.id,
  qty: 3,
  unitPrice: 99
}, 1300, 'r-hoodie-out', boughtBlank.skus)
assert.strictEqual(inv.findBlankSku(soldWhite.skus, 'p-hoodie').stock, 22)
assert.strictEqual(inv.findSkuBySpec(soldWhite.skus, 'p-hoodie', '白色', 'M').stock, 0)
assert.strictEqual(line0(soldWhite.record).color, '白色')
assert.strictEqual(line0(soldWhite.record).size, 'M')
assert.strictEqual(line0(soldWhite.record).allocations[0].source, 'blank')
assert.strictEqual(soldWhite.products[0].stock, 22)

assert.throws(function () {
  inv.applySaleOrder(soldWhite.products, soldWhite.records, {
    items: [
      { productId: 'p-hoodie', skuId: whiteM.id, qty: 12, unitPrice: 99 },
      { productId: 'p-hoodie', skuId: inv.findSkuBySpec(soldWhite.skus, 'p-hoodie', '黑色', 'L').id, qty: 12, unitPrice: 99 }
    ]
  }, 1400, 'order-blank-over', idFactory(), soldWhite.skus)
}, /库存不足/)

const sharedOrder = inv.applySaleOrder(soldWhite.products, soldWhite.records, {
  items: [
    { productId: 'p-hoodie', skuId: whiteM.id, qty: 10, unitPrice: 99 },
    { productId: 'p-hoodie', skuId: inv.findSkuBySpec(soldWhite.skus, 'p-hoodie', '黑色', 'L').id, qty: 10, unitPrice: 99 }
  ]
}, 1500, 'order-blank-ok', idFactory(), soldWhite.skus)
assert.strictEqual(inv.findBlankSku(sharedOrder.skus, 'p-hoodie').stock, 2)

const returned = inv.applyReturn(sharedOrder.products, sharedOrder.records, {
  saleOrderId: 'order-blank-ok',
  saleLineId: sharedOrder.order.lines[0].lineId,
  qty: 2
}, 1600, 'r-hoodie-return', sharedOrder.skus)
// 退货行记回被退的销售行，销售行的已退数量同步涨
assert.strictEqual(line0(returned.record).saleOrderId, 'order-blank-ok')
assert.strictEqual(returned.records.find(function (item) {
  return item.id === 'order-blank-ok'
}).lines[0].returnedQty, 2)
assert.strictEqual(inv.findSkuBySpec(returned.skus, 'p-hoodie', '白色', 'M').stock, 2)
assert.strictEqual(inv.findBlankSku(returned.skus, 'p-hoodie').stock, 2)
assert.strictEqual(returned.products[0].stock, 4)
assert.throws(function () {
  inv.applyReturn(returned.products, returned.records, {
    saleOrderId: 'order-blank-ok',
    saleLineId: sharedOrder.order.lines[0].lineId,
    qty: 9
  }, 1610, 'r-too-much', returned.skus)
}, /可退/)

const redM = inv.findSkuBySpec(returned.skus, 'p-hoodie', '红色', 'M')
const converted = inv.applyConvert(returned.products, returned.records, {
  productId: 'p-hoodie',
  fromSkuId: whiteM.id,
  toSkuId: redM.id,
  qty: 1
}, 1700, 'r-convert', returned.skus)
assert.strictEqual(inv.findSkuBySpec(converted.skus, 'p-hoodie', '白色', 'M').stock, 1)
assert.strictEqual(inv.findSkuBySpec(converted.skus, 'p-hoodie', '红色', 'M').stock, 1)
assert.strictEqual(converted.products[0].stock, 4)
assert.throws(function () {
  inv.applyConvert(converted.products, converted.records, {
    productId: 'p-hoodie',
    fromSkuId: inv.findBlankSku(converted.skus, 'p-hoodie').id,
    toSkuId: redM.id,
    qty: 1
  }, 1710, 'r-convert-blank', converted.skus)
}, /待加工库存不能改规格/)

const blackMHoodie = inv.findSkuBySpec(converted.skus, 'p-hoodie', '黑色', 'M')
const soldBlackFromBlank = sale(converted.products, converted.records, {
  productId: 'p-hoodie',
  skuId: blackMHoodie.id,
  qty: 1,
  unitPrice: 99
}, 1750, 'r-no-auto-recolor', converted.skus)
assert.strictEqual(line0(soldBlackFromBlank.record).allocations[0].source, 'blank')
assert.strictEqual(inv.findSkuBySpec(soldBlackFromBlank.skus, 'p-hoodie', '红色', 'M').stock, 1)
assert.strictEqual(inv.findBlankSku(soldBlackFromBlank.skus, 'p-hoodie').stock, 1)

const soldReadyFirst = sale(soldBlackFromBlank.products, soldBlackFromBlank.records, {
  productId: 'p-hoodie',
  skuId: redM.id,
  qty: 1,
  unitPrice: 99
}, 1800, 'r-ready-first', soldBlackFromBlank.skus)
assert.strictEqual(line0(soldReadyFirst.record).allocations[0].source, 'ready')
assert.strictEqual(inv.findSkuBySpec(soldReadyFirst.skus, 'p-hoodie', '红色', 'M').stock, 0)
assert.strictEqual(inv.findBlankSku(soldReadyFirst.skus, 'p-hoodie').stock, 1)

const undoneReady = inv.deleteRecord(soldReadyFirst.products, soldReadyFirst.records, 'r-ready-first', 1900, soldReadyFirst.skus)
assert.strictEqual(inv.findSkuBySpec(undoneReady.skus, 'p-hoodie', '红色', 'M').stock, 1)

assert.throws(function () {
  inv.deleteRecord(returned.products, returned.records, 'order-blank-ok', 2000, returned.skus)
}, /退货/)

const creditBlank = sale([hoodieMade.product], [], {
  productId: 'p-hoodie',
  skuId: whiteM.id,
  qty: 1,
  unitPrice: 99,
  customerId: 'c-blank',
  customerName: '测试客户',
  paidAmount: 0
}, 2100, 'r-credit-blank', hoodieMade.skus)
assert.strictEqual(inv.summarizeCustomerAccount(creditBlank.records, 'c-blank').receivable, 99)
const creditReturn = inv.applyReturn(creditBlank.products, creditBlank.records, {
  saleOrderId: 'r-credit-blank',
  saleLineId: line0(creditBlank.record).lineId,
  qty: 1
}, 2200, 'r-credit-return', creditBlank.skus)
assert.strictEqual(inv.summarizeCustomerAccount(creditReturn.records, 'c-blank').receivable, 0)
assert.strictEqual(inv.findSkuBySpec(creditReturn.skus, 'p-hoodie', '白色', 'M').stock, 1)

const avail = inv.blankAvailability(hoodieMade.product, hoodieMade.skus, '黑色', 'M', [
  { productId: 'p-hoodie', skuId: whiteM.id, qty: 8 }
])
assert.strictEqual(avail.total, 12)
assert.strictEqual(avail.blank, 12)

assert.throws(function () {
  inv.createCategory({ name: '  ' }, 1, 'c0')
}, /种类名称/)
assert.throws(function () {
  inv.createCategory({ name: '纺织', productKind: 'finished' }, 1, 'c-no-spec')
}, /规格/)

const textile = inv.createCategory({
  name: '纺织',
  names: ['卫衣'],
  specAxis1: '颜色',
  specAxis2: '尺码',
  colors: ['黑色'],
  sizes: ['M', 'L'],
  productKind: 'finished'
}, 1000, 'cat-1')
assert.strictEqual(textile.sharedPrice, true)
assert.strictEqual(inv.categoryKindTag(textile), '分规格现货')

const withGreen = inv.appendCategoryValue(textile, 'colors', '墨绿', 1100)
assert.deepStrictEqual(withGreen.colors, ['黑色', '墨绿'])
assert.strictEqual(inv.appendCategoryValue(withGreen, 'colors', '黑色', 1200), withGreen)

const daily = inv.createCategory({
  name: '日用',
  names: ['纯牛奶'],
  productKind: 'plain'
}, 1000, 'cat-2')
assert.strictEqual(daily.productKind, 'plain')
assert.deepStrictEqual(daily.colors, [])
assert.strictEqual(inv.categoryKindTag(daily), '普通')

assert.strictEqual(inv.skuPricesMatch([
  { costPrice: 10, salePrice: 20 },
  { costPrice: 10, salePrice: 20 }
]), true)
assert.strictEqual(inv.skuPricesMatch([
  { costPrice: 10, salePrice: 20 },
  { costPrice: 11, salePrice: 20 }
]), false)

const sharedProduct = inv.createProduct({
  name: '短袖同价',
  costPrice: 28,
  salePrice: 59,
  colors: ['黑'],
  sizes: ['M', 'L']
}, 1000, 'p-share')
assert.strictEqual(sharedProduct.sharedPrice, true)
const unshared = inv.updateProduct(sharedProduct, {
  name: '短袖同价',
  costPrice: 28,
  salePrice: 59,
  colors: ['黑'],
  sizes: ['M', 'L'],
  sharedPrice: false
}, 1100)
assert.strictEqual(unshared.sharedPrice, false)

const adjPlain = inv.createProduct({
  name: '调整牛奶',
  sku: 'ADJ-001',
  costPrice: 10,
  salePrice: 20,
  stock: 5,
  alertQty: 1
}, 20000, 'p-adj')
assert.strictEqual(adjPlain.stock, 5)
const adjPlainSkus = inv.applyProductSkus(adjPlain, [], null, 20000, idFactory())
assert.ok(!Object.prototype.hasOwnProperty.call(adjPlainSkus, 'records'))

const beforeAdjSummary = inv.summarizeRecords([])
const beforeAdjDash = inv.getDashboard([adjPlain], [], 20000, [],
  inv.summarizeRecords([]), inv.todayTotals([], inv.startOfDay(20000)))
const adjIn = inv.applyAdjust([adjPlain], [], {
  productId: 'p-adj',
  direction: 'in',
  reason: 'surplus',
  qty: 2,
  unitPrice: 99
}, 20010, 'r-adj-in')
assert.strictEqual(adjIn.products[0].stock, 7)
assert.strictEqual(adjIn.products[0].costPrice, 10)
assert.strictEqual(adjIn.record.type, 'adjust_in')
assert.strictEqual(line0(adjIn.record).reason, 'surplus')
assert.strictEqual(line0(adjIn.record).unitPrice, 0)
assert.strictEqual(line0(adjIn.record).costPrice, 0)
assert.strictEqual(adjIn.record.amount, 0)
assert.strictEqual(adjIn.record.profit, 0)
assert.ok(!adjIn.record.customerId)
assert.ok(!line0(adjIn.record).skuId)
const afterAdjSummary = inv.summarizeRecords(adjIn.records)
assert.strictEqual(afterAdjSummary.purchaseAmount, beforeAdjSummary.purchaseAmount)
assert.strictEqual(afterAdjSummary.salesAmount, beforeAdjSummary.salesAmount)
assert.strictEqual(afterAdjSummary.profit, beforeAdjSummary.profit)
assert.strictEqual(afterAdjSummary.receivable, beforeAdjSummary.receivable)
// 不变量 4 在看板这一层：库存调整只改件数，今日三项和欠款一点不动
const afterAdjDash = inv.getDashboard(adjIn.products, adjIn.records, 20010, adjIn.skus,
  inv.summarizeRecords(adjIn.records), inv.todayTotals(adjIn.records, inv.startOfDay(20010)))
assert.strictEqual(afterAdjDash.todayInAmount, beforeAdjDash.todayInAmount)
assert.strictEqual(afterAdjDash.todaySalesAmount, beforeAdjDash.todaySalesAmount)
assert.strictEqual(afterAdjDash.todayProfit, beforeAdjDash.todayProfit)
assert.strictEqual(afterAdjDash.totalReceivable, beforeAdjDash.totalReceivable)
assert.strictEqual(afterAdjDash.totalStock, 7)
assert.strictEqual(inv.filterRecords(adjIn.records, 'adjust').length, 1)
assert.strictEqual(inv.filterRecords(adjIn.records, 'in').length, 0)
assert.strictEqual(inv.filterRecords(adjIn.records, 'adjust_in').length, 1)

const adjOut = inv.applyAdjust(adjIn.products, adjIn.records, {
  productId: 'p-adj',
  direction: 'out',
  reason: 'damage',
  qty: 1
}, 20020, 'r-adj-out', adjIn.skus)
assert.strictEqual(adjOut.products[0].stock, 6)
assert.strictEqual(adjOut.products[0].costPrice, 10)
assert.strictEqual(adjOut.record.type, 'adjust_out')
assert.strictEqual(inv.filterRecords(adjOut.records, 'adjust').length, 2)
assert.strictEqual(inv.filterRecords(adjOut.records, 'out').length, 0)
assert.strictEqual(inv.summarizeRecords(adjOut.records).salesAmount, 0)
assert.ok(!adjOut.record.customerId)

const giftIn = inv.applyAdjust(adjOut.products, adjOut.records, {
  productId: 'p-adj',
  direction: 'in',
  reason: 'gift',
  qty: 1
}, 20030, 'r-adj-gift-in', adjOut.skus)
assert.strictEqual(giftIn.record.remark, '')
const giftOut = inv.applyAdjust(giftIn.products, giftIn.records, {
  productId: 'p-adj',
  direction: 'out',
  reason: 'gift',
  qty: 1
}, 20040, 'r-adj-gift-out', giftIn.skus)
assert.strictEqual(giftOut.products[0].stock, 6)

const editedIn = inv.updateRecord(giftOut.products, giftOut.records, {
  id: 'r-adj-in',
  qty: 4,
  reason: 'surplus',
  remark: ''
}, 20050, giftOut.skus)
assert.strictEqual(editedIn.products[0].stock, 8)
assert.strictEqual(editedIn.products[0].costPrice, 10)
assert.strictEqual(line0(editedIn.record).qty, 4)

const editedReason = inv.updateRecord(editedIn.products, editedIn.records, {
  id: 'r-adj-in',
  qty: 4,
  reason: 'gift'
}, 20060, editedIn.skus)
assert.strictEqual(editedReason.products[0].stock, 8)
assert.strictEqual(line0(editedReason.record).reason, 'gift')

assert.throws(function () {
  inv.updateRecord(editedReason.products, editedReason.records, {
    id: 'r-adj-out',
    qty: 20,
    reason: 'damage'
  }, 20070, editedReason.skus)
}, /库存不足/)
assert.strictEqual(editedReason.products[0].stock, 8)

assert.throws(function () {
  inv.updateRecord(editedReason.products, editedReason.records, {
    id: 'r-adj-in',
    qty: 4,
    type: 'in'
  }, 20080, editedReason.skus)
}, /不能改调整方向/)
assert.throws(function () {
  inv.updateRecord(editedReason.products, editedReason.records, {
    id: 'r-adj-in',
    qty: 4,
    skuId: 'nope'
  }, 20090, editedReason.skus)
}, /不能改调整方向/)

const deletedIn = inv.deleteRecord(editedReason.products, editedReason.records, 'r-adj-in', 20100, editedReason.skus)
assert.strictEqual(deletedIn.products[0].stock, 4)
assert.strictEqual(deletedIn.products[0].costPrice, 10)
const deletedOut = inv.deleteRecord(deletedIn.products, deletedIn.records, 'r-adj-out', 20110, deletedIn.skus)
assert.strictEqual(deletedOut.products[0].stock, 5)

assert.throws(function () {
  inv.applyAdjust([adjPlain], [], {
    productId: 'p-adj',
    direction: 'in',
    reason: 'surplus',
    qty: 0
  }, 20120, 'r-adj-zero')
}, /调整数量必须大于 0/)
assert.throws(function () {
  inv.applyAdjust([adjPlain], [], {
    productId: 'p-adj',
    direction: 'in',
    reason: 'surplus',
    qty: -1
  }, 20121, 'r-adj-neg')
}, /调整数量必须大于 0/)
assert.throws(function () {
  inv.applyAdjust([adjPlain], [], {
    productId: 'p-adj',
    reason: 'surplus',
    qty: 1
  }, 20122, 'r-adj-dir')
}, /请选择入库或出库/)
assert.throws(function () {
  inv.applyAdjust([adjPlain], [], {
    productId: 'p-adj',
    direction: 'in',
    reason: 'damage',
    qty: 1
  }, 20123, 'r-adj-reason')
}, /请选择原因/)
assert.throws(function () {
  inv.applyAdjust([adjPlain], [], {
    productId: 'p-adj',
    direction: 'in',
    reason: 'other',
    qty: 1
  }, 20124, 'r-adj-other')
}, /选择其他时请填写备注/)
assert.throws(function () {
  inv.applyAdjust([adjPlain], [], {
    productId: 'p-adj',
    direction: 'out',
    reason: 'damage',
    qty: 99
  }, 20125, 'r-adj-lack')
}, /库存不足/)
// 2b-1 起 saleOrderId 必填：流水搬进 ledger_records 之后，只给行号全表找一条
// 销售行需要多键索引。缺了直接报错，不再退化成全表扫描。
assert.throws(function () {
  inv.applyReturn([adjPlain], [], { qty: 1 }, 20126, 'r-adj-free-return')
}, /退货请指明销售单/)

const lockP = inv.createProduct({
  name: '对照进价',
  costPrice: 1,
  salePrice: 10,
  stock: 0
}, 21000, 'p-lock')
const boughtLock = inv.applyPurchase([lockP], [], {
  productId: 'p-lock',
  qty: 2,
  unitPrice: 3
}, 21010, 'r-lock-in')
assert.strictEqual(boughtLock.products[0].costPrice, 3)
const adjLock = inv.applyAdjust(boughtLock.products, boughtLock.records, {
  productId: 'p-lock',
  direction: 'in',
  reason: 'surplus',
  qty: 4,
  unitPrice: 99
}, 21020, 'r-lock-adj', boughtLock.skus)
assert.strictEqual(adjLock.products[0].costPrice, 3)
assert.strictEqual(adjLock.products[0].stock, 6)
assert.strictEqual(inv.summarizeRecords(adjLock.records).purchaseAmount, 6)
const soldLock = sale(adjLock.products, adjLock.records, {
  productId: 'p-lock',
  qty: 1,
  unitPrice: 10
}, 21030, 'r-lock-out', adjLock.skus)
assert.strictEqual(soldLock.record.profit, 7)
assert.strictEqual(inv.summarizeRecords(soldLock.records).salesAmount, 10)

const soldAdjIn = inv.applyAdjust([inv.createProduct({
  name: '卖掉调整',
  costPrice: 8,
  salePrice: 16,
  stock: 0
}, 22000, 'p-adj-sold')], [], {
  productId: 'p-adj-sold',
  direction: 'in',
  reason: 'surplus',
  qty: 5
}, 22010, 'r-adj-sold-in')
const soldAfterAdj = sale(soldAdjIn.products, soldAdjIn.records, {
  productId: 'p-adj-sold',
  qty: 5,
  unitPrice: 16
}, 22020, 'r-adj-sold-out', soldAdjIn.skus)
assert.throws(function () {
  inv.deleteRecord(soldAfterAdj.products, soldAfterAdj.records, 'r-adj-sold-in', 22030, soldAfterAdj.skus)
}, /库存不足/)
assert.ok(soldAfterAdj.records.some(function (item) {
  return item.id === 'r-adj-sold-in'
}))

const blankAdjMade = inv.applyProductSkus(inv.createProduct({
  name: '调整卫衣',
  costPrice: 40,
  salePrice: 80,
  stock: 10,
  colors: ['白', '黑'],
  sizes: ['M'],
  blankProcess: true
}, 23000, 'p-adj-blank'), [], null, 23010, idFactory())
const blankAdjSku = inv.findBlankSku(blankAdjMade.skus, 'p-adj-blank')
const whiteAdjSku = inv.findSkuBySpec(blankAdjMade.skus, 'p-adj-blank', '白', 'M')
const blackAdjSku = inv.findSkuBySpec(blankAdjMade.skus, 'p-adj-blank', '黑', 'M')
assert.throws(function () {
  inv.applyAdjust([blankAdjMade.product], [], {
    productId: 'p-adj-blank',
    direction: 'in',
    reason: 'surplus',
    qty: 2
  }, 23020, 'r-adj-blank-nosku', blankAdjMade.skus)
}, /请选择/)
const blankIn = inv.applyAdjust([blankAdjMade.product], [], {
  productId: 'p-adj-blank',
  skuId: blankAdjSku.id,
  direction: 'in',
  reason: 'surplus',
  qty: 3
}, 23030, 'r-adj-blank-in', blankAdjMade.skus)
assert.strictEqual(inv.findBlankSku(blankIn.skus, 'p-adj-blank').stock, 13)
assert.strictEqual(inv.findSkuBySpec(blankIn.skus, 'p-adj-blank', '白', 'M').stock, 0)
assert.strictEqual(blankIn.products[0].costPrice, 40)
assert.strictEqual(inv.findBlankSku(blankIn.skus, 'p-adj-blank').costPrice, blankAdjSku.costPrice)
assert.strictEqual(line0(blankIn.record).skuId, blankAdjSku.id)
assert.ok(!line0(blankIn.record).color)
assert.ok(!line0(blankIn.record).size)
const readyIn = inv.applyAdjust(blankIn.products, blankIn.records, {
  productId: 'p-adj-blank',
  skuId: whiteAdjSku.id,
  direction: 'in',
  reason: 'surplus',
  qty: 2
}, 23040, 'r-adj-ready-in', blankIn.skus)
assert.strictEqual(inv.findBlankSku(readyIn.skus, 'p-adj-blank').stock, 13)
assert.strictEqual(inv.findSkuBySpec(readyIn.skus, 'p-adj-blank', '白', 'M').stock, 2)
assert.strictEqual(inv.findSkuBySpec(readyIn.skus, 'p-adj-blank', '黑', 'M').stock, 0)

const specAdjMade = inv.applyProductSkus(inv.createProduct({
  name: '调整T恤',
  costPrice: 20,
  salePrice: 50,
  stock: 0,
  colors: ['红', '蓝']
}, 24000, 'p-adj-spec'), [], [
  { color: '红', size: '', stock: 4, costPrice: 20, salePrice: 50 },
  { color: '蓝', size: '', stock: 6, costPrice: 22, salePrice: 50 }
], 24010, idFactory())
const redAdjSku = inv.findSkuBySpec(specAdjMade.skus, 'p-adj-spec', '红', '')
const blueAdjSku = inv.findSkuBySpec(specAdjMade.skus, 'p-adj-spec', '蓝', '')
const specAdjIn = inv.applyAdjust([specAdjMade.product], [], {
  productId: 'p-adj-spec',
  skuId: redAdjSku.id,
  direction: 'in',
  reason: 'surplus',
  qty: 1
}, 24020, 'r-adj-spec-in', specAdjMade.skus)
assert.strictEqual(inv.findSkuBySpec(specAdjIn.skus, 'p-adj-spec', '红', '').stock, 5)
assert.strictEqual(inv.findSkuBySpec(specAdjIn.skus, 'p-adj-spec', '蓝', '').stock, 6)
assert.strictEqual(inv.findSkuBySpec(specAdjIn.skus, 'p-adj-spec', '红', '').costPrice, 20)
assert.strictEqual(inv.findSkuBySpec(specAdjIn.skus, 'p-adj-spec', '蓝', '').costPrice, 22)
assert.throws(function () {
  inv.applyAdjust([specAdjMade.product], [], {
    productId: 'p-adj-spec',
    direction: 'in',
    reason: 'surplus',
    qty: 1
  }, 24030, 'r-adj-spec-nosku', specAdjMade.skus)
}, /请选择/)
assert.throws(function () {
  inv.applyAdjust([specAdjMade.product], [], {
    productId: 'p-adj-spec',
    skuId: 'sku-blank-fake',
    direction: 'in',
    reason: 'surplus',
    qty: 1
  }, 24040, 'r-adj-spec-blank', specAdjMade.skus.concat([{
    id: 'sku-blank-fake',
    productId: 'p-adj-spec',
    isBlank: true,
    stock: 3,
    color: '',
    size: ''
  }]))
}, /待加工格|规格不存在/)

const opProduct = inv.createProduct({
  name: '经手人货',
  costPrice: 1,
  salePrice: 2,
  stock: 20
}, 30000, 'p-op')
const longOperator = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲乙丙'
assert.strictEqual(longOperator.length > 32, true)
const opSale = sale([opProduct], [], {
  productId: 'p-op',
  qty: 1,
  unitPrice: 2,
  operatorOpenid: 'staff-1',
  operatorName: '  小李  '
}, 30010, 'r-op')
assert.strictEqual(opSale.record.operatorOpenid, 'staff-1')
assert.strictEqual(opSale.record.operatorName, '小李')
const opLong = sale(opSale.products, opSale.records, {
  productId: 'p-op',
  qty: 1,
  unitPrice: 2,
  operatorName: longOperator
}, 30020, 'r-op-long')
assert.strictEqual(opLong.record.operatorOpenid, '')
assert.strictEqual(opLong.record.operatorName, longOperator.slice(0, 32))
assert.strictEqual(opLong.record.operatorName.length, 32)

const opOrder = inv.applySaleOrder(opLong.products, opLong.records, {
  items: [
    { productId: 'p-op', qty: 1, unitPrice: 2 },
    { productId: 'p-op', qty: 1, unitPrice: 2 }
  ],
  operatorOpenid: 'staff-1',
  operatorName: '小李'
}, 30030, 'order-op', idFactory())
assert.strictEqual(opOrder.order.operatorOpenid, 'staff-1')
assert.strictEqual(opOrder.order.operatorName, '小李')
// 经手人是整单共享字段，只在单头一份，不重复进每一行
assert.strictEqual(opOrder.order.lines.length, 2)
assert.ok(opOrder.order.lines.every(function (item) {
  return !Object.prototype.hasOwnProperty.call(item, 'operatorOpenid')
    && !Object.prototype.hasOwnProperty.call(item, 'operatorName')
}))

const opKept = inv.updateRecord(opSale.products, opSale.records, {
  id: 'r-op',
  qty: 1,
  unitPrice: 2
}, 30040, [])
assert.strictEqual(opKept.record.operatorOpenid, 'staff-1')
assert.strictEqual(opKept.record.operatorName, '小李')

const opRenamed = inv.updateRecord(opSale.products, opSale.records, {
  id: 'r-op',
  qty: 1,
  unitPrice: 2,
  operatorName: '只改称呼'
}, 30050, [])
assert.strictEqual(opRenamed.record.operatorOpenid, 'staff-1')
assert.strictEqual(opRenamed.record.operatorName, '只改称呼')

const opItemsEdit = inv.updateRecord(opOrder.products, opOrder.records, {
  id: 'order-op',
  items: [
    { id: opOrder.order.lines[0].lineId, qty: 1, unitPrice: 2 },
    { id: opOrder.order.lines[1].lineId, qty: 1, unitPrice: 2 }
  ],
  operatorOpenid: 'boss',
  operatorName: '老板'
}, 30060, [])
assert.strictEqual(opItemsEdit.record.operatorOpenid, 'boss')
assert.strictEqual(opItemsEdit.record.operatorName, '老板')
assert.strictEqual(opItemsEdit.records.find(function (item) {
  return item.id === 'order-op'
}).operatorName, '老板')

// —— 部分付款 ——
// 以前只有「全付」和「全欠」两种，现在实收可以落在中间。下面三段分别盯住
// 欠款计算、退货怎么冲、以及改流水时整单实收怎么摊回每一行。

const partialTee = inv.createProduct({
  name: '部分付款样品',
  costPrice: 10,
  salePrice: 25,
  stock: 20,
  alertQty: 1
}, 40000, 'p-partial')

// 1）欠款计算：卖 100 只收 40，欠款就是 60。
const partialSale = sale([partialTee], [], {
  productId: 'p-partial',
  qty: 4,
  unitPrice: 25,
  customerId: 'c-partial',
  customerName: '半款客户',
  paidAmount: 40
}, 40100, 'r-partial')
assert.strictEqual(partialSale.record.amount, 100)
assert.strictEqual(partialSale.record.paidAmount, 40)
const partialAccount = inv.summarizeCustomerAccount(partialSale.records, 'c-partial')
assert.strictEqual(partialAccount.creditAmount, 60)
assert.strictEqual(partialAccount.receivable, 60)
assert.strictEqual(inv.getTotalReceivable(partialSale.records), 60)
assert.strictEqual(inv.summarizeAllCustomerAccounts(partialSale.records)['c-partial'].receivable, 60)

// 收满不欠、一分不收全欠，两头也要对。
const paidInFull = sale([partialTee], [], {
  productId: 'p-partial',
  qty: 4,
  unitPrice: 25,
  customerId: 'c-full',
  customerName: '付清客户',
  paidAmount: 100
}, 40110, 'r-paid-full')
assert.strictEqual(inv.summarizeCustomerAccount(paidInFull.records, 'c-full').receivable, 0)
const paidNone = sale([partialTee], [], {
  productId: 'p-partial',
  qty: 4,
  unitPrice: 25,
  customerId: 'c-none',
  customerName: '全欠客户',
  paidAmount: 0
}, 40120, 'r-paid-none')
assert.strictEqual(inv.summarizeCustomerAccount(paidNone.records, 'c-none').receivable, 100)

// 有欠款就必须挂到客户名下，散客不能欠钱。
assert.throws(function () {
  sale([partialTee], [], {
    productId: 'p-partial',
    qty: 4,
    unitPrice: 25,
    paidAmount: 40
  }, 40130, 'r-partial-walkin')
}, /客户/)

// 收款仍然只冲欠款：再收 25，欠款剩 35。
const partialPay = inv.applyPayment(partialSale.records, {
  customerId: 'c-partial',
  customerName: '半款客户',
  amount: 25
}, 40140, 'r-partial-pay')
assert.strictEqual(inv.summarizeCustomerAccount(partialPay.records, 'c-partial').receivable, 35)

// 2）退货：退的钱先冲这张单没收到的部分，冲不掉的才算退现金。
const partialReturn = inv.applyReturn(partialSale.products, partialSale.records, {
  saleOrderId: 'r-partial',
  saleLineId: 'r-partial-l1',
  qty: 1
}, 40200, 'r-partial-return', partialSale.skus)
assert.strictEqual(inv.summarizeCustomerAccount(partialReturn.records, 'c-partial').receivable, 35)
// 送货单要按单据时刻截断算欠款：退货的冲抵挂在退货单自己的时间点上，
// 不能倒回去改销售单当时的欠款。
assert.strictEqual(inv.receivableAt(partialReturn.records, 'c-partial', 40100), 60)
assert.strictEqual(inv.receivableAt(partialReturn.records, 'c-partial', 40200), 35)
// 再退两件（累计退 75 > 欠款 60）：欠款冲到 0 就停，不会做成负数。
const partialReturnMore = inv.applyReturn(partialReturn.products, partialReturn.records, {
  saleOrderId: 'r-partial',
  saleLineId: 'r-partial-l1',
  qty: 2
}, 40300, 'r-partial-return-2', partialReturn.skus)
assert.strictEqual(inv.summarizeCustomerAccount(partialReturnMore.records, 'c-partial').receivable, 0)
// 全额收讫的单退货不产生欠款；一分未收的单退货全额冲欠款（和改造前一致）。
const fullPaidReturn = inv.applyReturn(paidInFull.products, paidInFull.records, {
  saleOrderId: 'r-paid-full',
  saleLineId: 'r-paid-full-l1',
  qty: 2
}, 40310, 'r-full-return', paidInFull.skus)
assert.strictEqual(inv.summarizeCustomerAccount(fullPaidReturn.records, 'c-full').receivable, 0)
const nonePaidReturn = inv.applyReturn(paidNone.products, paidNone.records, {
  saleOrderId: 'r-paid-none',
  saleLineId: 'r-paid-none-l1',
  qty: 2
}, 40320, 'r-none-return', paidNone.skus)
assert.strictEqual(inv.summarizeCustomerAccount(nonePaidReturn.records, 'c-none').receivable, 50)

// —— 退货拆分的三条守卫（第一轮漏掉的三条静默算错欠款的路径）——

// 场景 1：有退货的单改金额（实收不变），且累计退货额已经跨过欠款线
// （退 75 > 欠款 60 —— 先记的那张退货单头上冻结的现金退款额是 0、后记的是 15）。
// 第一轮会静默把欠款算成 100（main #47 读时口径是 85），现在拦下来。
assert.throws(function () {
  inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
    id: 'r-partial',
    items: [{ id: 'r-partial-l1', qty: 8, unitPrice: 25 }],
    paidAmount: 40,
    customerId: 'c-partial',
    customerName: '半款客户'
  }, 40400, partialReturnMore.skus, null)
}, /这张单有退货/)

// 反过来，累计退货额还盖在欠款里面（退 25 ≤ 欠款 60）时，每张退货单的现金
// 退款额恒为 0，改销售单不牵动它们，**必须放行** —— 而且逐值等于 main #47 的
// 读时口径 max(0, 200 − 40 − 25) = 135。这条是防止守卫被收紧成一刀切的钉子。
const partialScaled = inv.updateRecord(partialReturn.products, partialReturn.records, {
  id: 'r-partial',
  items: [{ id: 'r-partial-l1', qty: 8, unitPrice: 25 }],
  paidAmount: 40,
  customerId: 'c-partial',
  customerName: '半款客户'
}, 40405, partialReturn.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(partialScaled.records, 'c-partial').receivable, 135)

// 有退货的单改单价：会挪动「已退货值」这个基准，将来再退货时 othersReturned
// 会算错、把欠款静默算大。部分收款的单一律不许改单价。
assert.throws(function () {
  inv.updateRecord(partialReturn.products, partialReturn.records, {
    id: 'r-partial',
    items: [{ id: 'r-partial-l1', qty: 4, unitPrice: 70 }],
    paidAmount: 40,
    customerId: 'c-partial',
    customerName: '半款客户'
  }, 40415, partialReturn.skus, null)
}, /这张单有退货/)

// 一分未收的单也不例外：改已退货行的单价会让「已退货值」和实际退货额分岔，
// 这张单以后一旦收了钱（改实收是放行的），分岔就会把将来那笔退货的冲抵算小、
// 欠款算大。所以「有退货就不许改单价」不看收没收钱。
assert.throws(function () {
  inv.updateRecord(nonePaidReturn.products, nonePaidReturn.records, {
    id: 'r-paid-none',
    items: [{ id: 'r-paid-none-l1', qty: 4, unitPrice: 30 }],
    paidAmount: 0,
    customerId: 'c-none',
    customerName: '全欠客户'
  }, 40370, nonePaidReturn.skus, null)
}, /这张单有退货/)

// 全款单也不例外：把有退货那行的单价改成 0（赠品）会把「已退货值」压成 0，
// 这张单以后一旦变成部分收款，档② 就会拿着这个被压小的基准把欠款静默算大。
// 0 元行是这个 app 的一等公民（赠品走销售、售价填 0），不是构造出来的极端值。
assert.throws(function () {
  inv.updateRecord(fullPaidReturn.products, fullPaidReturn.records, {
    id: 'r-paid-full',
    items: [{ id: 'r-paid-full-l1', qty: 4, unitPrice: 0 }],
    paidAmount: 0,
    customerId: 'c-full',
    customerName: '付清客户'
  }, 40380, fullPaidReturn.skus, null)
}, /这张单有退货/)

// 必须放行：全款单有退货，涨数量并且把钱收满 —— 已退货值没变、改前改后都一分
// 不欠，冻结值不受影响。这条钉住「全款单改数量并收满」这条日常路径（档① 与
// 档③ 共同覆盖：档① 加上「已退货值没变」之后恒被档③ 包含），别让它被收紧掉。
const fullPaidGrown = inv.updateRecord(fullPaidReturn.products, fullPaidReturn.records, {
  id: 'r-paid-full',
  items: [{ id: 'r-paid-full-l1', qty: 8, unitPrice: 25 }],
  paidAmount: 200,
  customerId: 'c-full',
  customerName: '付清客户'
}, 40390, fullPaidReturn.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(fullPaidGrown.records, 'c-full').receivable, 0)

// 档③ 必须放行：Σ退货已经超过欠款（档② 在这里不成立）、但改动后欠款一分没变
// —— 只改客户名这类。这条钉住档③，它现在没有任何用例守着。
// 期望值按 main #47 口径 max(0, 应收 − 实收 − Σ退货额) 手工复算：Σ退货额是
// r-partial-return(25) + r-partial-return-2(50) = 75，max(0, 100 − 40 − 75) = 0；
// 与实测一致（不是 25 —— 这张单欠款早已被两次退货冲光，见 partialReturnMore 的
// receivable 断言）。
const moreReturnRenamed = inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
  id: 'r-partial',
  items: partialReturnMore.records.find(function (item) {
    return item.id === 'r-partial'
  }).lines.map(function (line) {
    return { id: line.lineId, qty: inv.toNumber(line.qty), unitPrice: inv.toNumber(line.unitPrice) }
  }),
  paidAmount: 40,
  customerId: 'c-partial',
  customerName: '半款客户改名'
}, 40395, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(moreReturnRenamed.records, 'c-partial').receivable, 0)

// 但「数量和实收一起改、欠款正好不变」不该被误伤：冻结值本来就还对。
const partialGrown = inv.updateRecord(partialReturn.products, partialReturn.records, {
  id: 'r-partial',
  items: [{ id: 'r-partial-l1', qty: 8, unitPrice: 25 }],
  paidAmount: 140,
  customerId: 'c-partial',
  customerName: '半款客户'
}, 40410, partialReturn.skus, null)
assert.strictEqual(partialGrown.record.amount, 200)
assert.strictEqual(inv.summarizeCustomerAccount(partialGrown.records, 'c-partial').receivable, 35)

// 场景 2：同一张销售单有两张退货单时，改先记的那张。第一轮会静默算成 40。
assert.throws(function () {
  inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
    id: 'r-partial-return',
    items: [{ id: 'r-partial-return-1', qty: 2 }]
  }, 40420, partialReturnMore.skus, null)
}, /后面还有别的退货单/)

// 最后一张仍然改得动，改完欠款按「先冲欠款」重算：累计退 50 < 欠款 60 → 欠 10。
const lastReturnEdited = inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
  id: 'r-partial-return-2',
  items: [{ id: 'r-partial-return-2-1', qty: 1 }]
}, 40430, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(lastReturnEdited.records, 'c-partial').receivable, 10)

// 场景 3：删先记的那张。第一轮会静默算成 50。
assert.throws(function () {
  inv.deleteRecord(partialReturnMore.products, partialReturnMore.records,
    'r-partial-return', 40440, partialReturnMore.skus, null)
}, /后面还有别的退货单/)

// 删最后一张仍然删得掉：只剩退 25，欠 100 − 40 − 25 = 35。
const lastReturnDeleted = inv.deleteRecord(partialReturnMore.products, partialReturnMore.records,
  'r-partial-return-2', 40450, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(lastReturnDeleted.records, 'c-partial').receivable, 35)

// —— 不许误伤：全赊单和全款单退两次，删先记的那张必须放行 ——

// 全赊：欠款盖得住全部退货，每张退货单的现金退款额恒为 0，互不牵连。
const nonePaidReturn2 = inv.applyReturn(nonePaidReturn.products, nonePaidReturn.records, {
  saleOrderId: 'r-paid-none',
  saleLineId: 'r-paid-none-l1',
  qty: 1
}, 40330, 'r-none-return-2', nonePaidReturn.skus)
const nonePaidFirstGone = inv.deleteRecord(nonePaidReturn2.products, nonePaidReturn2.records,
  'r-none-return', 40340, nonePaidReturn2.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(nonePaidFirstGone.records, 'c-none').receivable, 75)

// 全款：一分不欠，每张退货单都是纯退现金，也互不牵连。
const fullPaidReturn2 = inv.applyReturn(fullPaidReturn.products, fullPaidReturn.records, {
  saleOrderId: 'r-paid-full',
  saleLineId: 'r-paid-full-l1',
  qty: 1
}, 40350, 'r-full-return-2', fullPaidReturn.skus)
const fullPaidFirstGone = inv.deleteRecord(fullPaidReturn2.products, fullPaidReturn2.records,
  'r-full-return', 40360, fullPaidReturn2.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(fullPaidFirstGone.records, 'c-full').receivable, 0)

// 3）改流水：整单实收按各行金额摊回去，合计等于填进去的实收。
const partialBread = inv.createProduct({
  name: '部分付款面包',
  costPrice: 5,
  salePrice: 10,
  stock: 20,
  alertQty: 1
}, 40000, 'p-partial-2')
const partialOrder = inv.applySaleOrder([partialTee, partialBread], [], {
  items: [
    { productId: 'p-partial', qty: 2, unitPrice: 25 },
    { productId: 'p-partial-2', qty: 5, unitPrice: 10 }
  ],
  customerId: 'c-partial-order',
  customerName: '半款客户二',
  paidAmount: 30
}, 40400, 'order-partial', idFactory(), [])
assert.strictEqual(partialOrder.record.amount, 100)
assert.strictEqual(partialOrder.record.paidAmount, 30)
assert.strictEqual(inv.round2(partialOrder.record.amount - partialOrder.record.paidAmount), 70)
assert.strictEqual(inv.summarizeCustomerAccount(partialOrder.records, 'c-partial-order').receivable, 70)

const partialEdit = inv.updateRecord(partialOrder.products, partialOrder.records, {
  id: 'order-partial',
  items: [
    { id: partialOrder.record.lines[0].lineId, qty: 2, unitPrice: 25 },
    { id: partialOrder.record.lines[1].lineId, qty: 5, unitPrice: 10 }
  ],
  paidAmount: 80,
  customerId: 'c-partial-order',
  customerName: '半款客户二'
}, 40500, [])
assert.strictEqual(partialEdit.record.amount, 100)
assert.strictEqual(partialEdit.record.paidAmount, 80)
assert.strictEqual(inv.summarizeCustomerAccount(partialEdit.records, 'c-partial-order').receivable, 20)

// 改数量把应收压到实收以下：实收自动收口到新的应收，不会记成负欠款。
const shrunk = inv.updateRecord(paidInFull.products, paidInFull.records, {
  id: 'r-paid-full',
  qty: 2,
  unitPrice: 25,
  customerId: 'c-full',
  customerName: '付清客户'
}, 40600, [])
assert.strictEqual(shrunk.record.amount, 50)
assert.strictEqual(shrunk.record.paidAmount, 50)
assert.strictEqual(inv.summarizeCustomerAccount(shrunk.records, 'c-full').receivable, 0)

// 实收不能超过应收，改流水也一样。
assert.throws(function () {
  inv.updateRecord(partialOrder.products, partialOrder.records, {
    id: 'order-partial',
    items: [
      { id: partialOrder.record.lines[0].lineId, qty: 2, unitPrice: 25 },
      { id: partialOrder.record.lines[1].lineId, qty: 5, unitPrice: 10 }
    ],
    paidAmount: 120,
    customerId: 'c-partial-order',
    customerName: '半款客户二'
  }, 40700, [])
}, /实收不能超过应收/)

console.log('inventory tests passed')

// —— 拆分不变量 fuzzer（常驻守门员）——
//
// 手写用例只能钉住想得到的那几条路径。「改单价埋下的分岔要等到后来改实收才
// 发作」这种跨两步的洞，第 3 轮是随机漫步抓出来的，所以收编成常驻。
//
// 不变量：任何一次**被放行**的写入之后，客户欠款必须逐分等于 main #47 的读时
// 口径 max(0, 应收 − 实收 − Σ退货额)。这条恒等式就是【拆分不变量】的外部表现
// （Σ(r−c) == min(D, Σr) ⟺ 欠款 == max(0, D − Σr)），比逐条断言冻结值更难写错。
//
// 只造一张多行销售单：跨退货单的分配耦合全部发生在同一张销售单内部；多客户、
// 收款、期初这些线性项由上面的手写用例覆盖。500 局 × 14 步，本机约 0.2 秒。
function splitFuzzRandom(seed) {
  let a = seed
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const fuzzRnd = splitFuzzRandom(777)
function fuzzPick(list) {
  return list[Math.floor(fuzzRnd() * list.length)]
}
// 放行次数的下限。守卫一旦被收紧成一刀切，不变量会永远成立而这个数会塌下来 ——
// 「全拦住」和「全算对」在断言上长得一模一样，必须另外钉住功能还在。当前 6112。
const FUZZ_MIN_ALLOWED = 5500
const FUZZ_EXPECTED_ERRORS = /这张单有退货|后面还有别的退货单|退货不能超过可退数量|改完后收款会超过赊账|数量不能小于已退货|销售数量必须大于|退货数量必须大于|实收不能超过应收|售价不能为负数/
let fuzzAllowed = 0
for (let trial = 0; trial < 500; trial++) {
  let fuzzSeq = 0
  const nextFuzzId = function () {
    fuzzSeq += 1
    return 'fz' + trial + '-' + fuzzSeq
  }
  const in1 = inv.applyPurchase([
    { id: 'fp1', name: '甲货', stock: 0, costPrice: 0, price: 25, specs: null },
    { id: 'fp2', name: '乙货', stock: 0, costPrice: 0, price: 9, specs: null }
  ], [], { productId: 'fp1', qty: 9999, unitPrice: 1 }, 1000, 'fi1-' + trial, [])
  const in2 = inv.applyPurchase(in1.products, in1.records,
    { productId: 'fp2', qty: 9999, unitPrice: 1 }, 1001, 'fi2-' + trial, in1.skus)
  const fuzzItems = [
    { productId: 'fp1', qty: 1 + Math.floor(fuzzRnd() * 5), unitPrice: fuzzPick([10, 25, 12.5, 0]) },
    { productId: 'fp2', qty: 1 + Math.floor(fuzzRnd() * 5), unitPrice: fuzzPick([9, 7.77, 20, 0]) }
  ]
  const fuzzDue = inv.round2(fuzzItems.reduce(function (sum, item) {
    return sum + item.qty * item.unitPrice
  }, 0))
  const started = inv.applySaleOrder(in2.products, in2.records, {
    items: fuzzItems,
    customerId: 'fc1',
    customerName: '随机客户',
    paidAmount: fuzzPick([0, fuzzDue, inv.round2(fuzzDue * fuzzRnd())])
  }, 2000, 'fs' + trial, nextFuzzId, in2.skus)
  let cur = { products: started.products, records: started.records, skus: started.skus }
  const fuzzSaleId = started.record.id
  const fuzzLineIds = started.record.lines.map(function (line) { return line.lineId })
  let fuzzTs = 3000
  for (let step = 0; step < 14; step++) {
    fuzzTs += 100
    const saleNow = cur.records.find(function (item) { return item.id === fuzzSaleId })
    if (!saleNow) break
    const retsNow = cur.records.filter(function (item) { return item.type === 'return' })
    const op = fuzzPick(['addReturn', 'editReturn', 'delReturn', 'editSale', 'editSale'])
    let done = null
    try {
      if (op === 'addReturn') {
        const target = saleNow.lines[Math.floor(fuzzRnd() * saleNow.lines.length)]
        const remain = inv.returnableQty(target)
        if (remain <= 0) continue
        done = inv.applyReturnOrder(cur.products, cur.records, {
          items: [{
            saleOrderId: fuzzSaleId,
            saleLineId: target.lineId,
            qty: 1 + Math.floor(fuzzRnd() * remain)
          }]
        }, fuzzTs, nextFuzzId, cur.skus, null)
      } else if (op === 'editReturn' && retsNow.length) {
        const target = fuzzPick(retsNow)
        done = inv.updateRecord(cur.products, cur.records, {
          id: target.id,
          items: target.lines.map(function (line) {
            return { id: line.lineId, qty: 1 + Math.floor(fuzzRnd() * 4) }
          })
        }, fuzzTs, cur.skus, null)
      } else if (op === 'delReturn' && retsNow.length) {
        done = inv.deleteRecord(cur.products, cur.records, fuzzPick(retsNow).id,
          fuzzTs, cur.skus, null)
      } else {
        const nextItems = saleNow.lines.map(function (line, at) {
          return {
            id: fuzzLineIds[at],
            qty: Math.max(inv.round2(inv.toNumber(line.returnedQty)), 1) + Math.floor(fuzzRnd() * 4),
            unitPrice: fuzzPick([
              inv.toNumber(line.unitPrice),
              inv.round2(inv.toNumber(line.unitPrice) * (0.3 + fuzzRnd() * 2)),
              0
            ])
          }
        })
        const due = inv.round2(nextItems.reduce(function (sum, item) {
          return sum + item.qty * item.unitPrice
        }, 0))
        done = inv.updateRecord(cur.products, cur.records, {
          id: fuzzSaleId,
          items: nextItems,
          paidAmount: Math.min(fuzzPick([0, due, inv.round2(due * fuzzRnd()),
            inv.toNumber(saleNow.paidAmount)]), due),
          customerId: 'fc1',
          customerName: '随机客户'
        }, fuzzTs, cur.skus, null)
      }
    } catch (error) {
      // 拦下来是允许的结果，但不许拦出一条没人认识的错
      assert.ok(FUZZ_EXPECTED_ERRORS.test(error.message),
        '拆分 fuzzer 撞到意料之外的错误：' + error.message)
      continue
    }
    if (!done) continue
    fuzzAllowed += 1
    cur = { products: done.products, records: done.records, skus: done.skus }
    const after = cur.records.find(function (item) { return item.id === fuzzSaleId })
    if (!after) continue
    const returnedSum = inv.round2(cur.records.filter(function (item) {
      return item.type === 'return'
    }).reduce(function (sum, item) {
      return sum + inv.toNumber(item.amount)
    }, 0))
    const mainWay = Math.max(0, inv.round2(
      inv.toNumber(after.amount) - inv.settledAmount(after) - returnedSum))
    const got = inv.round2(inv.summarizeCustomerAccount(cur.records, 'fc1').receivable)
    assert.strictEqual(got, mainWay, '拆分不变量被破坏（trial ' + trial
      + ' step ' + step + ' ' + op + '）：算出 ' + got + '，main #47 口径 ' + mainWay)
  }
}
assert.ok(fuzzAllowed >= FUZZ_MIN_ALLOWED, '拆分 fuzzer 放行次数塌到 ' + fuzzAllowed
  + '（下限 ' + FUZZ_MIN_ALLOWED + '）：守卫可能被收紧成一刀切，不变量恒成立但功能没了')
console.log('拆分不变量 fuzzer：500 局 × 14 步，放行 ' + fuzzAllowed
  + ' 次，全部与 main #47 口径逐分一致')
