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

// 商品图 image：云存储 fileID，空串 = 无图；老数据没有该字段由读端兜底
assert.strictEqual(sampleProduct().image, '', '不传 image 时是空串')
const imaged = inv.createProduct({
  name: '带图牛奶',
  costPrice: 1,
  salePrice: 2,
  stock: 3,
  image: '  cloud://env-1.bucket-2/shops/s-1/products/a.jpg  '
}, 1000, 'p-img')
assert.strictEqual(imaged.image, 'cloud://env-1.bucket-2/shops/s-1/products/a.jpg',
  'image 透传并 trim')
assert.throws(function () {
  inv.createProduct({
    name: '超长图',
    costPrice: 1,
    salePrice: 2,
    stock: 1,
    image: 'cloud://' + new Array(601).join('x')
  }, 1000, 'p-long-img')
}, /商品图地址过长/)
assert.strictEqual(
  inv.updateProduct(imaged, { name: '带图牛奶改' }, 2000).image,
  'cloud://env-1.bucket-2/shops/s-1/products/a.jpg',
  'input.image 缺省时保留 existing.image')
assert.strictEqual(
  inv.updateProduct(imaged, {
    name: '带图牛奶改',
    image: 'cloud://env-1.bucket-2/shops/s-1/products/b.jpg'
  }, 2000).image,
  'cloud://env-1.bucket-2/shops/s-1/products/b.jpg',
  'input.image 传入时覆盖')
assert.strictEqual(
  inv.updateProduct(imaged, { name: '带图牛奶改', image: '' }, 2000).image,
  '',
  'image 传空串等于清除')

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

// 超收不再报错：单头夹在应收以内，溢出的 0.5 记成预收（G1）
const overPaid = sale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 1,
  unitPrice: 4.5,
  customerId: 'c1',
  customerName: '张三超市',
  paidAmount: 5
}, 8100, 'r-over-paid')
assert.strictEqual(overPaid.record.amount, 4.5)
assert.strictEqual(overPaid.record.paidAmount, 4.5, '实收仍夹在应收以内')
assert.strictEqual(overPaid.record.prepayAdded, 0.5, '溢出记预收')
assert.strictEqual(
  inv.summarizeCustomerAccount(overPaid.records, 'c1').prepay, 0.5)
assert.strictEqual(
  inv.summarizeCustomerAccount(overPaid.records, 'c1').receivable, 0,
  '超收不制造负欠款')

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

// 收款超欠款不再报错：欠 5 收 6，冲欠 5、余 1 记预收（G1）
const payOver = inv.applyPayment(paid.records, {
  customerId: 'c1',
  customerName: '张三超市',
  amount: 6
}, 8400, 'r-pay-over')
assert.strictEqual(payOver.record.amount, 6, '单头记的是收到的总额')
assert.strictEqual(payOver.record.prepayAdded, 1, '超出欠款的部分记预收')
const afterPayOver = inv.summarizeCustomerAccount(payOver.records, 'c1')
assert.strictEqual(afterPayOver.receivable, 0, '欠款冲平，不折成负数')
assert.strictEqual(afterPayOver.prepay, 1, '预收余额 1')

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
// 期初欠款那一侧同理：欠 50 收 51，冲欠 50、余 1 记预收
const openPayOver = inv.applyPayment(openPaid.records, {
  customerId: 'c-open',
  amount: 51
}, 8440, 'r-open-pay-over')
assert.strictEqual(openPayOver.record.prepayAdded, 1)
assert.strictEqual(
  inv.summarizeCustomerAccount(openPayOver.records, 'c-open').receivable, 0)
assert.strictEqual(
  inv.summarizeCustomerAccount(openPayOver.records, 'c-open').prepay, 1)

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

// 改收款单同理：这张单原本冲欠 4，除本条外还欠 9；改成 20 → 冲 9、余 11 记预收
const editedPayOver = inv.updateRecord(paid.products || purchased.products, paid.records, {
  id: 'r-pay',
  amount: 20
}, 2700, [])
assert.strictEqual(editedPayOver.record.amount, 20)
assert.strictEqual(editedPayOver.record.prepayAdded, 11)
assert.strictEqual(
  inv.summarizeCustomerAccount(editedPayOver.records, 'c1').receivable, 0)
assert.strictEqual(
  inv.summarizeCustomerAccount(editedPayOver.records, 'c1').prepay, 11)

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

// ---------------------------------------------------------------------------
// 阶段 3 补口（3.1）：待加工拆分在「改单 / 删单」这条路上的完整来回。
// 卖 5 = 现货 3 + 待加工 2；行成本必须是**加权**值，改单还回再重扣、删单整单还原，
// 每一步商品库存都要等于全部规格格之和。
// ---------------------------------------------------------------------------
const bsMade = inv.applyProductSkus(inv.createProduct({
  name: '加工衫', costPrice: 4, salePrice: 20, stock: 10, alertQty: 1,
  colors: ['黑', '白'], sizes: ['M', 'L'], blankProcess: true
}, 3000, 'p-bsplit'), [], [
  { color: '黑', size: 'M', stock: 3, costPrice: 10, salePrice: 20 },
  { color: '黑', size: 'L', stock: 0, costPrice: 10, salePrice: 20 },
  { color: '白', size: 'M', stock: 0, costPrice: 10, salePrice: 20 },
  { color: '白', size: 'L', stock: 0, costPrice: 10, salePrice: 20 }
], 3100, idFactory())
const bsBlackM = inv.findSkuBySpec(bsMade.skus, 'p-bsplit', '黑', 'M')
const bsBlank = inv.findBlankSku(bsMade.skus, 'p-bsplit')
assert.strictEqual(bsBlackM.stock, 3)
assert.strictEqual(bsBlackM.costPrice, 10)
assert.strictEqual(bsBlank.stock, 10)
assert.strictEqual(bsBlank.costPrice, 4, '待加工格的成本来自商品成本价')
assert.strictEqual(bsMade.product.stock, 13, '现货 3 + 待加工 10')

const bsSold = sale([bsMade.product], [], {
  productId: 'p-bsplit', skuId: bsBlackM.id, qty: 5, unitPrice: 20
}, 3200, 'r-bs-sold', bsMade.skus)
assert.deepStrictEqual(line0(bsSold.record).allocations, [
  { skuId: bsBlackM.id, qty: 3, source: 'ready', color: '黑', size: 'M', costPrice: 10 },
  { skuId: bsBlank.id, qty: 2, source: 'blank', color: '', size: '', costPrice: 4 }
], '3.1：先吃现货 3，差 2 件才动待加工')
assert.strictEqual(line0(bsSold.record).costPrice, 7.6,
  '3.1：行成本 = (3×10 + 2×4) / 5 —— 加权，不是简单平均 7，也不是待加工自己的 4')
assert.strictEqual(inv.findSkuBySpec(bsSold.skus, 'p-bsplit', '黑', 'M').stock, 0)
assert.strictEqual(inv.findBlankSku(bsSold.skus, 'p-bsplit').stock, 8)
assert.strictEqual(bsSold.products[0].stock, inv.productStockFromSkus(bsSold.skus, 'p-bsplit'),
  '3.1：商品库存 === Σ 全部规格格（卖后）')
assert.strictEqual(bsSold.products[0].stock, 8)

// 改单 5 -> 2：allocations 原样还回（现货 +3、待加工 +2），再按新数量重扣
const bsEdited = inv.updateRecord(bsSold.products, bsSold.records, {
  id: 'r-bs-sold', qty: 2, unitPrice: 20
}, 3300, bsSold.skus)
assert.strictEqual(inv.findSkuBySpec(bsEdited.skus, 'p-bsplit', '黑', 'M').stock, 1,
  '3.1：还回 3 再重扣 2，现货格剩 1')
assert.strictEqual(inv.findBlankSku(bsEdited.skus, 'p-bsplit').stock, 10,
  '3.1：重扣的 2 件全部由现货出，待加工格回到 10')
assert.deepStrictEqual(line0(bsEdited.record).allocations, [
  { skuId: bsBlackM.id, qty: 2, source: 'ready', color: '黑', size: 'M', costPrice: 10 }
], '3.1：改单后的 allocations 只剩现货那份')
assert.strictEqual(line0(bsEdited.record).costPrice, 10,
  '3.1：重扣只吃现货，行成本回到现货自己的 10')
assert.strictEqual(bsEdited.products[0].stock, inv.productStockFromSkus(bsEdited.skus, 'p-bsplit'),
  '3.1：商品库存 === Σ 全部规格格（改单后）')
assert.strictEqual(bsEdited.products[0].stock, 11)

// 删单：按 allocations 整单还原
const bsDeleted = inv.deleteRecord(bsEdited.products, bsEdited.records, 'r-bs-sold', 3400, bsEdited.skus)
assert.strictEqual(inv.findSkuBySpec(bsDeleted.skus, 'p-bsplit', '黑', 'M').stock, 3)
assert.strictEqual(inv.findBlankSku(bsDeleted.skus, 'p-bsplit').stock, 10)
assert.strictEqual(bsDeleted.products[0].stock, inv.productStockFromSkus(bsDeleted.skus, 'p-bsplit'),
  '3.1：商品库存 === Σ 全部规格格（删单后）')
assert.strictEqual(bsDeleted.products[0].stock, 13)

// ---------------------------------------------------------------------------
// 阶段 3 补口（3.2）：退货入库的移动加权成本。退货按**卖出时那一行**的成本
// 原样回格（restockLine -> addSkuStock 的加权分支）。构造：
//   先卖 2 件吃光现货（行成本 20）-> 再卖 3 件纯待加工（行成本 4）
//   -> 先退 2 件 @20（空格，成本变 20）-> 再退 3 件 @4
// 格上 (2×20 + 3×4) / 5 = 10.4 —— 不是覆盖成 4，也不是简单平均 12。
// ---------------------------------------------------------------------------
const mwMade = inv.applyProductSkus(inv.createProduct({
  name: '加权衫', costPrice: 4, salePrice: 20, stock: 10, alertQty: 1,
  colors: ['黑'], sizes: ['M', 'L'], blankProcess: true
}, 3500, 'p-mw'), [], [
  { color: '黑', size: 'M', stock: 2, costPrice: 20, salePrice: 20 },
  { color: '黑', size: 'L', stock: 0, costPrice: 20, salePrice: 20 }
], 3600, idFactory())
const mwBlackM = inv.findSkuBySpec(mwMade.skus, 'p-mw', '黑', 'M')
// 第一笔：恰好卖光现货格，行成本 = 现货 20
const mwSoldReady = sale([mwMade.product], [], {
  productId: 'p-mw', skuId: mwBlackM.id, qty: 2, unitPrice: 20
}, 3700, 'r-mw-ready', mwMade.skus)
assert.strictEqual(line0(mwSoldReady.record).costPrice, 20, '3.2 前提：这笔全部来自现货')
// 第二笔：现货空了，3 件全部来自待加工 @4
const mwSoldBlank = sale(mwSoldReady.products, mwSoldReady.records, {
  productId: 'p-mw', skuId: mwBlackM.id, qty: 3, unitPrice: 20
}, 3800, 'r-mw-blank', mwSoldReady.skus)
assert.strictEqual(line0(mwSoldBlank.record).costPrice, 4, '3.2 前提：这笔全部来自待加工')
// 退货按各自销售行的成本回格
const mwRetReady = inv.applyReturn(mwSoldBlank.products, mwSoldBlank.records, {
  saleOrderId: 'r-mw-ready', saleLineId: line0(mwSoldReady.record).lineId, qty: 2
}, 3900, 'r-mw-ret-ready', mwSoldBlank.skus)
assert.strictEqual(inv.findSkuBySpec(mwRetReady.skus, 'p-mw', '黑', 'M').stock, 2)
assert.strictEqual(inv.findSkuBySpec(mwRetReady.skus, 'p-mw', '黑', 'M').costPrice, 20,
  '3.2 前提：空格退 2 件 @20，格成本就是 20')
const mwRetBlank = inv.applyReturn(mwRetReady.products, mwRetReady.records, {
  saleOrderId: 'r-mw-blank', saleLineId: line0(mwSoldBlank.record).lineId, qty: 3
}, 4000, 'r-mw-ret-blank', mwRetReady.skus)
const mwGridAfter = inv.findSkuBySpec(mwRetBlank.skus, 'p-mw', '黑', 'M')
assert.strictEqual(mwGridAfter.stock, 5)
assert.strictEqual(mwGridAfter.costPrice, 10.4,
  '3.2：(2×20 + 3×4) / 5 —— 移动加权；覆盖成 4 或简单平均 12 都是错的')

// ---------------------------------------------------------------------------
// 阶段 3 补口（3.3）：整单共享待加工 —— assertSaleItems 直测。
// 它是 pages/sale 提交前的整单预扫（sale.js:539），之前没有任何测试直接钉它。
// 两行各要 12、待加工只有 22：单看每一行都出得了（12 ≤ 22），只有整单一起算
// 才知道差 2 件。逐行独立判的写法在这里会放行。
// ---------------------------------------------------------------------------
const shMade = inv.applyProductSkus(inv.createProduct({
  name: '共享衫', costPrice: 5, salePrice: 20, stock: 22, alertQty: 1,
  colors: ['黑', '白'], sizes: ['M'], blankProcess: true
}, 4100, 'p-share'), [], null, 4200, idFactory())
const shBlackM = inv.findSkuBySpec(shMade.skus, 'p-share', '黑', 'M')
const shWhiteM = inv.findSkuBySpec(shMade.skus, 'p-share', '白', 'M')
assert.strictEqual(inv.findBlankSku(shMade.skus, 'p-share').stock, 22)
assert.throws(function () {
  inv.assertSaleItems([shMade.product], shMade.skus, [
    { productId: 'p-share', skuId: shBlackM.id, qty: 12, unitPrice: 20 },
    { productId: 'p-share', skuId: shWhiteM.id, qty: 12, unitPrice: 20 }
  ])
}, /共享衫 白 · M 库存不足，可出 10/,
  '3.3：第一行吃掉 12 之后第二行只剩 10，报的是「可出 10」不是当前库存 22')
// 放行侧：整单 20 ≤ 22 必须过，别把预扫写成一刀切
inv.assertSaleItems([shMade.product], shMade.skus, [
  { productId: 'p-share', skuId: shBlackM.id, qty: 10, unitPrice: 20 },
  { productId: 'p-share', skuId: shWhiteM.id, qty: 10, unitPrice: 20 }
])

// ---------------------------------------------------------------------------
// 阶段 3 补口（3.4）：负库存守卫的四条路，都用分规格商品（走 addSkuStock /
// adjustStock 的格守卫）。非规格那几条路上面 heavySale 已经钉过一条。
// 铺底：进货 5 到黑M，卖 3，格上剩 2。
// ---------------------------------------------------------------------------
const gdMade = inv.applyProductSkus(inv.createProduct({
  name: '守卫衫', costPrice: 6, salePrice: 20, stock: 0, alertQty: 1,
  colors: ['黑'], sizes: ['M', 'L']
}, 4300, 'p-guard'), [], [
  { color: '黑', size: 'M', stock: 0, costPrice: 6, salePrice: 20 },
  { color: '黑', size: 'L', stock: 0, costPrice: 6, salePrice: 20 }
], 4400, idFactory())
const gdBlackM = inv.findSkuBySpec(gdMade.skus, 'p-guard', '黑', 'M')
const gdBlackL = inv.findSkuBySpec(gdMade.skus, 'p-guard', '黑', 'L')
const gdBought = inv.applyPurchase([gdMade.product], [], {
  productId: 'p-guard', skuId: gdBlackM.id, qty: 5, unitPrice: 6
}, 4500, 'r-gd-in', gdMade.skus)
const gdSold = sale(gdBought.products, gdBought.records, {
  productId: 'p-guard', skuId: gdBlackM.id, qty: 3, unitPrice: 20
}, 4600, 'r-gd-sold', gdBought.skus)
assert.strictEqual(inv.findSkuBySpec(gdSold.skus, 'p-guard', '黑', 'M').stock, 2, '3.4 铺底：格上剩 2')

assert.throws(function () {
  inv.applyAdjust(gdSold.products, gdSold.records, {
    productId: 'p-guard', skuId: gdBlackM.id, direction: 'out', reason: 'damage', qty: 3
  }, 4700, 'r-gd-adj', gdSold.skus)
}, /库存不足/, '3.4 路 1：调整出库不许把格扣成负数')
assert.throws(function () {
  inv.deleteRecord(gdSold.products, gdSold.records, 'r-gd-in', 4800, gdSold.skus)
}, /库存不足/, '3.4 路 2：已卖掉的进货不许删')
assert.throws(function () {
  inv.updateRecord(gdSold.products, gdSold.records, {
    id: 'r-gd-in', qty: 1, unitPrice: 6
  }, 4900, gdSold.skus)
}, /库存不足/, '3.4 路 3：进货改小到低于已卖出量不许')
assert.throws(function () {
  inv.applyConvert(gdSold.products, gdSold.records, {
    productId: 'p-guard', fromSkuId: gdBlackM.id, toSkuId: gdBlackL.id, qty: 3
  }, 5000, 'r-gd-conv', gdSold.skus)
}, /库存不足/, '3.4 路 4：改规格不许超过来源格')
assert.strictEqual(inv.findSkuBySpec(gdSold.skus, 'p-guard', '黑', 'M').stock, 2,
  '3.4：四条都被拒，格上库存一点没动')

// 路 5 走的是**另一道**守卫：路 1–3 撞在 adjustStock 里那条内联判断上，
// 删退货（restockLine 负数）撞在 addSkuStock 自己的负库存判断上。退回的货
// 又卖出去之后再删退货单，那 3 件已经不在格上了，必须拦。
const gdReturn = inv.applyReturn(gdSold.products, gdSold.records, {
  saleOrderId: 'r-gd-sold', saleLineId: line0(gdSold.record).lineId, qty: 3
}, 5100, 'r-gd-ret', gdSold.skus)
assert.strictEqual(inv.findSkuBySpec(gdReturn.skus, 'p-guard', '黑', 'M').stock, 5,
  '3.4 路 5 铺底：退货入库后格上有 5')
const gdResold = sale(gdReturn.products, gdReturn.records, {
  productId: 'p-guard', skuId: gdBlackM.id, qty: 3, unitPrice: 20
}, 5200, 'r-gd-sold2', gdReturn.skus)
assert.strictEqual(inv.findSkuBySpec(gdResold.skus, 'p-guard', '黑', 'M').stock, 2,
  '3.4 路 5 铺底：退回来的 3 件又卖出去了，格上剩 2')
assert.throws(function () {
  inv.deleteRecord(gdResold.products, gdResold.records, 'r-gd-ret', 5300, gdResold.skus)
}, /库存不足/, '3.4 路 5：退回的货已再卖掉，删退货不许把格扣成负数')

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

// —— 退货拆分的整体重算（守卫已删：改销售单 / 改删任一张退货单都放行并重算）——

// 场景 1：有退货的单改金额（实收不变），且累计退货额跨过欠款线
// （退 75 > 原欠款 60 —— 先记的那张退货单头上冻结的现金退款额是 0、后记的是 15）。
// 旧守卫会拦；现在放行并把两张退货单的份额整体重算：新欠款 160 盖得住全部退货，
// 后记那张（r-partial-return-2）的 paidAmount 从 15 拨回 0。
// 欠款逐分等于 main #47 读时口径 max(0, 200 − 40 − 75) = 85。
const moreSaleEdited = inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
  id: 'r-partial',
  items: [{ id: 'r-partial-l1', qty: 8, unitPrice: 25 }],
  paidAmount: 40,
  customerId: 'c-partial',
  customerName: '半款客户'
}, 40400, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(moreSaleEdited.records, 'c-partial').receivable, 85)
assert.strictEqual(moreSaleEdited.records.find(function (item) {
  return item.id === 'r-partial-return-2'
}).paidAmount, 0)

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

// 有退货的单改单价：退货行的单价是 applyReturnOrder 从销售行复制来的派生值，
// 销售行改了价，同单退货行跟着按新价重算（repriceSaleReturns），returnedAmount
// 随之等于 Σ新退货额。退 1 件、25 → 70：退货额 25 → 70，D = 240 盖得住退货，
// c 恒 0，欠款 = max(0, 280 − 40 − 70) = 170。
//
// 这里原来断言的是 215（退货冻在旧价 25）。215 是销售行按 70、退货行按 25
// 拼出来的数：误差 = 已退件数 ×（新单价 − 旧单价）= 1 × 45 = 45，没有上界。
const priceChanged = inv.updateRecord(partialReturn.products, partialReturn.records, {
  id: 'r-partial',
  items: [{ id: 'r-partial-l1', qty: 4, unitPrice: 70 }],
  paidAmount: 40,
  customerId: 'c-partial',
  customerName: '半款客户'
}, 40415, partialReturn.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(priceChanged.records, 'c-partial').receivable, 170)
assert.strictEqual(priceChanged.records.find(function (item) {
  return item.id === 'r-partial'
}).lines[0].returnedAmount, 70)
// 退货单自己也被拨到新价：单价、金额、毛利三项一起走，不能只改销售行的镜像字段。
const partialRetAfter = priceChanged.records.find(function (item) {
  return item.id === 'r-partial-return'
})
assert.strictEqual(partialRetAfter.lines[0].unitPrice, 70)
assert.strictEqual(partialRetAfter.amount, 70)
assert.strictEqual(partialRetAfter.profit, -60)

// 一分未收的单改单价：退 2 件、25 → 30，退货额 50 → 60。
// D = 120 盖得住退 60 → c 恒 0，欠款 = max(0, 120 − 0 − 60) = 60。
const noneRepriced = inv.updateRecord(nonePaidReturn.products, nonePaidReturn.records, {
  id: 'r-paid-none',
  items: [{ id: 'r-paid-none-l1', qty: 4, unitPrice: 30 }],
  paidAmount: 0,
  customerId: 'c-none',
  customerName: '全欠客户'
}, 40370, nonePaidReturn.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(noneRepriced.records, 'c-none').receivable, 60)
assert.strictEqual(noneRepriced.records.find(function (item) {
  return item.id === 'r-paid-none'
}).lines[0].returnedAmount, 60)

// 全款单改成 0 元行（赠品）：退货跟着变成 0 元，销售额、毛利、客户「累计销售」
// 三项一起归位。0 元行是这个 app 的一等公民（赠品走销售、售价填 0），不是构造
// 出来的极端值 —— 这条正是缺陷最显眼的一档。
//
// 这里原来断言 returnedAmount 保持 50、退货单 paidAmount 保持 50。那组数配上
// amount = 0 的销售行，算出来是 销售额 −50 / 毛利 −60 / 客户累计销售 −50：
// pages/customers/customers.wxml 会直接印出「累计销售 ¥−50」。
const fullZeroed = inv.updateRecord(fullPaidReturn.products, fullPaidReturn.records, {
  id: 'r-paid-full',
  items: [{ id: 'r-paid-full-l1', qty: 4, unitPrice: 0 }],
  paidAmount: 0,
  customerId: 'c-full',
  customerName: '付清客户'
}, 40380, fullPaidReturn.skus, null)
const fullZeroedAccount = inv.summarizeCustomerAccount(fullZeroed.records, 'c-full')
assert.strictEqual(fullZeroedAccount.receivable, 0)
assert.strictEqual(fullZeroedAccount.amount, 0)
assert.strictEqual(fullZeroed.records.find(function (item) {
  return item.id === 'r-paid-full'
}).lines[0].returnedAmount, 0)
assert.strictEqual(fullZeroed.records.find(function (item) {
  return item.id === 'r-full-return'
}).paidAmount, 0)
// 销售额和毛利也要跟着归位。进价 10、卖 4 件改成 0 元、退回 2 件：
// 销售额 0 − 0 = 0，毛利 (0−10)×4 + (0−10)×2×(−1) = −20。
const fullZeroedTotals = inv.computeTotals(fullZeroed.records)
assert.strictEqual(fullZeroedTotals.salesAmount, 0)
assert.strictEqual(fullZeroedTotals.profit, -20)

// 口径钉死：改单价的结果必须和店主手工的「先删退货 → 改价 → 重录退货」逐分
// 一致。这条是 repriceSaleReturns 的定义，比单看几个数更难写错。
const zeroedByHand = (function () {
  const dropped = inv.deleteRecord(fullPaidReturn.products, fullPaidReturn.records,
    'r-full-return', 40381, fullPaidReturn.skus, null)
  const repriced = inv.updateRecord(dropped.products, dropped.records, {
    id: 'r-paid-full',
    items: [{ id: 'r-paid-full-l1', qty: 4, unitPrice: 0 }],
    paidAmount: 0,
    customerId: 'c-full',
    customerName: '付清客户'
  }, 40382, dropped.skus, null)
  return inv.applyReturn(repriced.products, repriced.records, {
    saleOrderId: 'r-paid-full',
    saleLineId: 'r-paid-full-l1',
    qty: 2
  }, 40383, 'r-full-return-redo', repriced.skus)
})()
const zeroedByHandTotals = inv.computeTotals(zeroedByHand.records)
assert.strictEqual(zeroedByHandTotals.salesAmount, fullZeroedTotals.salesAmount)
assert.strictEqual(zeroedByHandTotals.profit, fullZeroedTotals.profit)
assert.strictEqual(inv.summarizeCustomerAccount(zeroedByHand.records, 'c-full').amount,
  fullZeroedAccount.amount)
assert.strictEqual(inv.summarizeCustomerAccount(zeroedByHand.records, 'c-full').receivable,
  fullZeroedAccount.receivable)

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
// 单价没动就一个字段都别碰：拨价只在单价真的变了的时候发生，改数量不许连累退货单。
assert.deepStrictEqual(fullPaidGrown.records.find(function (item) {
  return item.id === 'r-full-return'
}), fullPaidReturn.records.find(function (item) {
  return item.id === 'r-full-return'
}))

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

// 场景 2：同一张销售单有两张退货单时，改先记的那张。旧守卫会拦；现在放行并把
// 两张一起重算：改后 r₁ = 50、r₂ = 50、D = 60 → c₁ = 0、c₂ = 40，
// 欠款 = max(0, 100 − 40 − 100) = 0。
const firstReturnEdited = inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
  id: 'r-partial-return',
  items: [{ id: 'r-partial-return-1', qty: 2 }]
}, 40420, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(firstReturnEdited.records, 'c-partial').receivable, 0)
assert.strictEqual(firstReturnEdited.records.find(function (item) {
  return item.id === 'r-partial-return-2'
}).paidAmount, 40)
// 改先记的那张自己也按整体重算拨份额：c₁ = max(0, 50 − 60) = 0。
assert.strictEqual(firstReturnEdited.records.find(function (item) {
  return item.id === 'r-partial-return'
}).paidAmount, 0)

// 改后那张退货单自己再改回去（最后一张路径不再特殊，一样走整体重算）：
// 累计退 50 < 欠款 60 → 两张 c 都拨 0，欠款 = max(0, 100 − 40 − 50) = 10。
const lastReturnEdited = inv.updateRecord(partialReturnMore.products, partialReturnMore.records, {
  id: 'r-partial-return-2',
  items: [{ id: 'r-partial-return-2-1', qty: 1 }]
}, 40430, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(lastReturnEdited.records, 'c-partial').receivable, 10)

// 场景 3：删先记的那张。旧守卫会拦；现在放行并重算剩余兄弟：剩 r = 50 < D = 60
// → c = 0，欠款 = max(0, 100 − 40 − 50) = 10。
const firstReturnDeleted = inv.deleteRecord(partialReturnMore.products, partialReturnMore.records,
  'r-partial-return', 40440, partialReturnMore.skus, null)
assert.strictEqual(inv.summarizeCustomerAccount(firstReturnDeleted.records, 'c-partial').receivable, 10)
assert.strictEqual(firstReturnDeleted.records.find(function (item) {
  return item.id === 'r-partial-return-2'
}).paidAmount, 0)

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

// —— 改销售单客户：退货单头的客户字段整组跟着拨 ——
// 退货单头的 id / 姓名 / 电话 / 地址四个都继承自被退销售单，不是各自录入的。
// 只拨 customerId 会让这条记录自相矛盾：挂在新客户账下，客户页和送货单却印着
// 旧客户的名字和地址。钱在两种写法下都是对的，所以只有这条用例守着它。
const movedSale = inv.updateRecord(partialReturn.products, partialReturn.records, {
  id: 'r-partial',
  items: [{ id: 'r-partial-l1', qty: 4, unitPrice: 25 }],
  paidAmount: 40,
  customerId: 'c-moved',
  customerName: '改挂客户',
  customerPhone: '13900000000',
  customerAddress: '新地址'
}, 40460, partialReturn.skus, null)
const movedReturn = movedSale.records.find(function (item) {
  return item.id === 'r-partial-return'
})
assert.strictEqual(movedReturn.customerId, 'c-moved')
assert.strictEqual(movedReturn.customerName, '改挂客户', '退货单头的客户名要跟着销售单拨')
assert.strictEqual(movedReturn.customerPhone, '13900000000')
assert.strictEqual(movedReturn.customerAddress, '新地址')
// 钱跟着一起走：旧客户清零，新客户 = max(0, 100 − 40 − 25) = 35
assert.strictEqual(inv.summarizeCustomerAccount(movedSale.records, 'c-partial').receivable, 0)
assert.strictEqual(inv.summarizeCustomerAccount(movedSale.records, 'c-moved').receivable, 35)

// —— 多行单只拨被改价的那一行 ——
// 退货行按 saleLineId 认回销售行，改甲的价不许动乙那一行的退货。
const twoLineA = inv.createProduct({
  name: '两行货甲', costPrice: 4, salePrice: 10, stock: 20, alertQty: 1
}, 40700, 'p-two-a')
const twoLineB = inv.createProduct({
  name: '两行货乙', costPrice: 6, salePrice: 20, stock: 20, alertQty: 1
}, 40701, 'p-two-b')
let twoSeq = 0
const twoSale = inv.applySaleOrder([twoLineA, twoLineB], [], {
  items: [
    { productId: 'p-two-a', qty: 3, unitPrice: 10 },
    { productId: 'p-two-b', qty: 2, unitPrice: 20 }
  ],
  customerId: 'c-two', customerName: '两行客户', paidAmount: 0
}, 40710, 'r-two', function () { twoSeq += 1; return 'r-two-l' + twoSeq }, [])
let twoRetSeq = 0
const twoReturned = inv.applyReturnOrder(twoSale.products, twoSale.records, {
  items: [
    { saleOrderId: 'r-two', saleLineId: 'r-two-l1', qty: 1 },
    { saleOrderId: 'r-two', saleLineId: 'r-two-l2', qty: 1 }
  ]
}, 40720, function () { twoRetSeq += 1; return 'r-two-ret-' + twoRetSeq }, twoSale.skus, null)
// 只把甲那一行 10 → 4。
const twoRepriced = inv.updateRecord(twoReturned.products, twoReturned.records, {
  id: 'r-two',
  items: [
    { id: 'r-two-l1', qty: 3, unitPrice: 4 },
    { id: 'r-two-l2', qty: 2, unitPrice: 20 }
  ],
  paidAmount: 0,
  customerId: 'c-two', customerName: '两行客户'
}, 40730, twoReturned.skus, null)
const twoRetAfter = twoRepriced.records.find(function (item) {
  return item.id === twoReturned.record.id
})
assert.strictEqual(twoRetAfter.lines[0].unitPrice, 4, '甲那一行的退货跟着拨价')
assert.strictEqual(twoRetAfter.lines[1].unitPrice, 20, '乙那一行没改价，退货原样不动')
assert.strictEqual(twoRetAfter.amount, 24)
const twoSaleAfter = twoRepriced.records.find(function (item) {
  return item.id === 'r-two'
})
assert.strictEqual(twoSaleAfter.lines[0].returnedAmount, 4)
assert.strictEqual(twoSaleAfter.lines[1].returnedAmount, 20)
// 销售额 = 留在客户手上的货 × 当前单价 = 2 × 4 + 1 × 20 = 28。
assert.strictEqual(inv.computeTotals(twoRepriced.records).salesAmount, 28)
assert.strictEqual(inv.summarizeCustomerAccount(twoRepriced.records, 'c-two').receivable, 28)

// —— 分位恒等：returnedAmount 让「已退货值」由构造等于 Σ退货额 ——
// 小数数量下逐张取整会分岔：round2(0.5×7.77)×2 = 7.78 ≠ round2(1×7.77) = 7.77。
// 旧口径按 returnedQty × 当前单价现算，退两张 0.5 的单会把已退货值记小 1 分，
// 那 1 分随后会静默算进欠款。returnedAmount 按退货单实际金额累加，不再分岔。
const fracProduct = inv.createProduct({
  name: '分位货', costPrice: 1, salePrice: 8, stock: 5, alertQty: 1
}, 40500, 'p-frac')
const fracSale = sale([fracProduct], [], {
  productId: 'p-frac', qty: 1, unitPrice: 7.77,
  customerId: 'c-frac', customerName: '分位客户', paidAmount: 3.77
}, 40510, 'r-frac')
const fracRet1 = inv.applyReturn(fracSale.products, fracSale.records, {
  saleOrderId: 'r-frac', saleLineId: 'r-frac-l1', qty: 0.5
}, 40520, 'r-frac-ret-1', fracSale.skus)
const fracRet2 = inv.applyReturn(fracRet1.products, fracRet1.records, {
  saleOrderId: 'r-frac', saleLineId: 'r-frac-l1', qty: 0.5
}, 40530, 'r-frac-ret-2', fracRet1.skus)
assert.strictEqual(fracRet2.records.find(function (item) {
  return item.id === 'r-frac'
}).lines[0].returnedAmount, 7.78)
assert.strictEqual(fracRet2.records.find(function (item) {
  return item.id === 'r-frac-ret-2'
}).paidAmount, 3.78)
assert.strictEqual(inv.summarizeCustomerAccount(fracRet2.records, 'c-frac').receivable, 0)

// —— 改单价后再退：旧退货跟着拨价，新退货的基准仍是 returnedAmount ——
const fracRepriced = inv.updateRecord(fracRet2.products, fracRet2.records, {
  id: 'r-frac',
  items: [{ id: 'r-frac-l1', qty: 2, unitPrice: 9.99 }],
  paidAmount: 3.77,
  customerId: 'c-frac', customerName: '分位客户'
}, 40540, fracRet2.skus, null)
// 改完先核对整体重算：两张旧退货跟着拨到新单价，各 round2(0.5 × 9.99) = 5，
// Σr = 10（returnedAmount 仍由构造等于 Σ退货额，分位恒等在新价上照样成立）。
// D = 19.98 − 3.77 = 16.21 盖得住 Σr 10 → 两张的 paidAmount 全是 0（第二张原是 3.78）。
assert.strictEqual(fracRepriced.records.find(function (item) {
  return item.id === 'r-frac-ret-2'
}).paidAmount, 0)
assert.strictEqual(fracRepriced.records.find(function (item) {
  return item.id === 'r-frac'
}).lines[0].returnedAmount, 10)
assert.strictEqual(inv.summarizeCustomerAccount(fracRepriced.records, 'c-frac').receivable, 6.21)
// 再按可退余量退 1 件：othersReturned = 10 → left = 16.21 − 10 = 6.21 →
// c₃ = 9.99 − 6.21 = 3.78；欠款 = max(0, 19.98 − 3.77 − 19.99) = 0。
// Σ退货额 19.99 比单据金额 19.98 多 1 分，正是分位取整的那一分：已退货值跟着
// 实际退货额走，不去凑 qty × 单价。
const fracRet3 = inv.applyReturn(fracRepriced.products, fracRepriced.records, {
  saleOrderId: 'r-frac', saleLineId: 'r-frac-l1', qty: 1
}, 40550, 'r-frac-ret-3', fracRepriced.skus)
assert.strictEqual(fracRet3.record.paidAmount, 3.78)
assert.strictEqual(fracRet3.records.find(function (item) {
  return item.id === 'r-frac'
}).lines[0].returnedAmount, 19.99)
assert.strictEqual(inv.summarizeCustomerAccount(fracRet3.records, 'c-frac').receivable, 0)

// —— 老数据回退：销售行缺 returnedAmount 时按 returnedQty × 当前单价兜底 ——
// 上一版写出的流水只有 returnedQty。价格没变过时回退口径与持久口径一致，
// 再退一张的 paidAmount 不受影响（账不飞）。
const legacyProduct = inv.createProduct({
  name: '老数据货', costPrice: 1, salePrice: 10, stock: 5, alertQty: 1
}, 40600, 'p-legacy')
const legacySale = sale([legacyProduct], [], {
  productId: 'p-legacy', qty: 2, unitPrice: 10,
  customerId: 'c-legacy', customerName: '老数据客户', paidAmount: 0
}, 40610, 'r-legacy')
const legacyRet1 = inv.applyReturn(legacySale.products, legacySale.records, {
  saleOrderId: 'r-legacy', saleLineId: 'r-legacy-l1', qty: 1
}, 40620, 'r-legacy-ret-1', legacySale.skus)
// 手工模拟老数据：删掉销售行上的 returnedAmount
const legacyRecords = JSON.parse(JSON.stringify(legacyRet1.records))
delete legacyRecords.find(function (item) { return item.id === 'r-legacy' }).lines[0].returnedAmount
// 再退 1 件（10 元）：回退底数 = round2(1 × 10) = 10，left = 20 − 10 = 10 盖得住
// r₂ → c₂ = 0；欠款 = max(0, 20 − 0 − 20) = 0。
const legacyRet2 = inv.applyReturn(legacyRet1.products, legacyRecords, {
  saleOrderId: 'r-legacy', saleLineId: 'r-legacy-l1', qty: 1
}, 40630, 'r-legacy-ret-2', legacyRet1.skus)
assert.strictEqual(legacyRet2.record.paidAmount, 0)
assert.strictEqual(inv.summarizeCustomerAccount(legacyRet2.records, 'c-legacy').receivable, 0)
// patch 的底数也走回退：删掉第二张退货，returnedAmount 回到只剩第一张的 10。
const legacyDropped = inv.deleteRecord(legacyRet2.products, legacyRet2.records,
  'r-legacy-ret-2', 40640, legacyRet2.skus)
assert.strictEqual(legacyDropped.records.find(function (item) {
  return item.id === 'r-legacy'
}).lines[0].returnedAmount, 10)
// 缺字段的老数据也能改单价：updateRecord 先按 returnedQty × **改价前**的单价把
// returnedAmount 落成显式值（正是持久字段该有的数），再让同单退货跟着拨价。
// 所以「缺字段」和「有字段」两条路在改单价上逐分相同 —— 下面两段对着跑一遍。
// 残留的可观察差别只剩分位那一档（两张 0.5 的退货 Σ = 7.78，回退口径回推成 7.77）；
// 迁移自愈（legacyLine / backfillReturnedQty）会把字段补齐，新流水一律带字段。
const legacyRecords2 = JSON.parse(JSON.stringify(legacyRet1.records))
delete legacyRecords2.find(function (item) { return item.id === 'r-legacy' }).lines[0].returnedAmount
const legacyRepriced = inv.updateRecord(legacyRet1.products, legacyRecords2, {
  id: 'r-legacy',
  items: [{ id: 'r-legacy-l1', qty: 2, unitPrice: 18 }],
  paidAmount: 16,
  customerId: 'c-legacy', customerName: '老数据客户'
}, 40650, legacyRet1.skus, null)
// 已退 1 件、10 → 18：退货单跟着拨到 18，已退金额 10 → 18。
assert.strictEqual(legacyRepriced.records.find(function (item) {
  return item.id === 'r-legacy'
}).lines[0].returnedAmount, 18)
assert.strictEqual(legacyRepriced.records.find(function (item) {
  return item.id === 'r-legacy-ret-1'
}).amount, 18)
const legacyRet3 = inv.applyReturn(legacyRepriced.products, legacyRepriced.records, {
  saleOrderId: 'r-legacy', saleLineId: 'r-legacy-l1', qty: 0.5
}, 40660, 'r-legacy-ret-3', legacyRepriced.skus)
// D = 36 − 16 = 20，othersReturned = 18 → left = 2 → c₃ = 9 − 2 = 7。
assert.strictEqual(legacyRet3.record.paidAmount, 7)
// 带着持久字段把同一条路再跑一遍：逐分相同。
const legacyKept = inv.updateRecord(legacyRet1.products, legacyRet1.records, {
  id: 'r-legacy',
  items: [{ id: 'r-legacy-l1', qty: 2, unitPrice: 18 }],
  paidAmount: 16,
  customerId: 'c-legacy', customerName: '老数据客户'
}, 40655, legacyRet1.skus, null)
assert.strictEqual(legacyKept.records.find(function (item) {
  return item.id === 'r-legacy'
}).lines[0].returnedAmount, 18)
const legacyKeptRet3 = inv.applyReturn(legacyKept.products, legacyKept.records, {
  saleOrderId: 'r-legacy', saleLineId: 'r-legacy-l1', qty: 0.5
}, 40665, 'r-legacy-ret-4', legacyKept.skus)
assert.strictEqual(legacyKeptRet3.record.paidAmount, legacyRet3.record.paidAmount)

// —— 客户改挂：退货单头的 customerId 跟着销售单走 ——
// 退货单头继承自被退销售单；改销售单客户后不拨，这笔退货会一直挂在旧客户账上。
const moveProduct = inv.createProduct({
  name: '改挂货', costPrice: 5, salePrice: 25, stock: 10, alertQty: 1
}, 40700, 'p-move')
const moveSale = sale([moveProduct], [], {
  productId: 'p-move', qty: 4, unitPrice: 25,
  customerId: 'c-move-1', customerName: '客户一', paidAmount: 40
}, 40710, 'r-move')
const moveRet = inv.applyReturn(moveSale.products, moveSale.records, {
  saleOrderId: 'r-move', saleLineId: 'r-move-l1', qty: 1
}, 40720, 'r-move-ret', moveSale.skus)
assert.strictEqual(inv.summarizeCustomerAccount(moveRet.records, 'c-move-1').receivable, 35)
const moveEdited = inv.updateRecord(moveRet.products, moveRet.records, {
  id: 'r-move',
  items: [{ id: 'r-move-l1', qty: 4, unitPrice: 25 }],
  paidAmount: 40,
  customerId: 'c-move-2', customerName: '客户二'
}, 40730, moveRet.skus, null)
assert.strictEqual(moveEdited.records.find(function (item) {
  return item.id === 'r-move-ret'
}).customerId, 'c-move-2')
// 退货的贡献跟着销售单走：客户一清零，客户二欠 max(0, 100 − 40 − 25) = 35。
assert.strictEqual(inv.summarizeCustomerAccount(moveEdited.records, 'c-move-1').receivable, 0)
assert.strictEqual(inv.summarizeCustomerAccount(moveEdited.records, 'c-move-2').receivable, 35)

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

// 改流水时超收同样转预收：应收 100，实收填 120 → 单头 100 + 预收 20
const editedOver = inv.updateRecord(partialOrder.products, partialOrder.records, {
  id: 'order-partial',
  items: [
    { id: partialOrder.record.lines[0].lineId, qty: 2, unitPrice: 25 },
    { id: partialOrder.record.lines[1].lineId, qty: 5, unitPrice: 10 }
  ],
  paidAmount: 120,
  customerId: 'c-partial-order',
  customerName: '半款客户二'
}, 40700, [])
assert.strictEqual(editedOver.record.amount, 100)
assert.strictEqual(editedOver.record.paidAmount, 100, '单头实收仍夹在应收以内')
assert.strictEqual(editedOver.record.prepayAdded, 20)
assert.strictEqual(
  inv.summarizeCustomerAccount(editedOver.records, 'c-partial-order').receivable, 0)
assert.strictEqual(
  inv.summarizeCustomerAccount(editedOver.records, 'c-partial-order').prepay, 20)

console.log('inventory tests passed')

// —— 拆分不变量 fuzzer（常驻守门员）——
//
// 手写用例只能钉住想得到的那几条路径。「改单价埋下的分岔要等到后来改实收才
// 发作」这种跨两步的洞，第 3 轮是随机漫步抓出来的，所以收编成常驻。
//
// 不变量一（欠款）：任何一次**被放行**的写入之后，客户欠款必须逐分等于 main #47
// 的读时口径 max(0, 应收 − 实收 − Σ退货额)。这条恒等式就是【拆分不变量】的外部
// 表现（Σ(r−c) == min(D, Σr) ⟺ 欠款 == max(0, D − Σr)），比逐条断言冻结值更难写错。
//
// 不变量二（一套价）：销售额和毛利必须逐分等于「留在客户手上的货 × 当前单价」。
// 不变量一两边都拿**实际**退货额，所以看不见「销售行按新价、退货行按旧价」这种
// 分岔；那正是改单价时不给同单退货拨价留下的洞（PR #53 之后 main 上的阻塞级
// 缺陷：改成 0 元赠品能把销售额和客户「累计销售」算成负数）。
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
// 放行次数的下限。整体重算取代守卫后，原来被「这张单有退货 / 后面还有别的退货单」
// 拦掉的写入全部放行，这个数只会涨；「全拦住」和「全算对」在断言上长得一模一样，
// 必须另外钉住功能还在。当前 6649。
const FUZZ_MIN_ALLOWED = 6300
const FUZZ_EXPECTED_ERRORS = /退货不能超过可退数量|改完后收款会超过赊账|数量不能小于已退货|销售数量必须大于|退货数量必须大于|实收不能超过应收|售价不能为负数/
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
    // 不变量二：进价恒为 1（两笔进货都是 unitPrice 1），所以毛利也能这样现推。
    const fuzzNet = inv.recordLines(after).reduce(function (acc, line) {
      const left = inv.toNumber(line.qty) - inv.toNumber(line.returnedQty)
      acc.amount += left * inv.toNumber(line.unitPrice)
      acc.profit += left * (inv.toNumber(line.unitPrice) - 1)
      return acc
    }, { amount: 0, profit: 0 })
    const fuzzTotals = inv.computeTotals(cur.records)
    assert.strictEqual(fuzzTotals.salesAmount, inv.round2(fuzzNet.amount),
      '一套价被破坏（销售额，trial ' + trial + ' step ' + step + ' ' + op + '）：算出 '
      + fuzzTotals.salesAmount + '，按当前单价现推 ' + inv.round2(fuzzNet.amount))
    assert.strictEqual(fuzzTotals.profit, inv.round2(fuzzNet.profit),
      '一套价被破坏（毛利，trial ' + trial + ' step ' + step + ' ' + op + '）：算出 '
      + fuzzTotals.profit + '，按当前单价现推 ' + inv.round2(fuzzNet.profit))
  }
}
assert.ok(fuzzAllowed >= FUZZ_MIN_ALLOWED, '拆分 fuzzer 放行次数塌到 ' + fuzzAllowed
  + '（下限 ' + FUZZ_MIN_ALLOWED + '）：守卫可能被收紧成一刀切，不变量恒成立但功能没了')
console.log('拆分不变量 fuzzer：500 局 × 14 步，放行 ' + fuzzAllowed
  + ' 次，全部与 main #47 口径逐分一致')

// ---------------------------------------------------------------------------
// G3 · 看板今日五数的「实收 / 未收」
//
// 口径写在 docs/accounting-vs-policy.md「看板今日五数」，一句话：
//     今日实收 = Σ今日销售单实收 − Σ今日退货单退现金
//     今日未收 = Σ今日销售单欠款 − Σ今日退货单冲欠
//     恒等式    实收 + 未收 ≡ 应收（= salesAmount），逐分成立
// 收款（pay）与期初欠款（opening）不进这三个数。
// ---------------------------------------------------------------------------

const T3_DAY = 1756051200000 // 演示账 2026-08-25 的零点，只当刻度用
function t3Sale(id, amount, paid, profit, at) {
  return {
    id: id, type: 'out', amount: amount, paidAmount: paid, profit: profit,
    customerId: 'c-' + id, createdAt: at,
    lines: [{ lineId: id + '-l1', productId: 'p', qty: 1, unitPrice: amount, amount: amount }]
  }
}
function t3In(id, amount, at) {
  return { id: id, type: 'in', amount: amount, profit: 0, createdAt: at, lines: [] }
}
// 退货单头：amount = 退货货值，paidAmount = 退现金（冲欠 = amount − paidAmount）
function t3Return(id, amount, cash, profit, at) {
  return {
    id: id, type: 'return', amount: amount, paidAmount: cash, profit: profit,
    customerId: 'c-r', createdAt: at, lines: [{ lineId: id + '-l1', saleOrderId: 'x' }]
  }
}

// (a) 演示账对照表复算 —— 本条是 G3 的验收点。
// 表里逐笔声明的只有王姐 014（应收 352 / 实收 268 / 欠 84）与李老板枕芯（128 现结），
// 其余是背景账；背景账那一块自己也必须闭合：
//   应收 4120 − 352 − 128 = 3640，实收 3860 − 268 − 128 = 3464，未收 260 − 84 = 176，
//   而 3640 = 3464 + 176 ✓ —— 三个数是同一套账，不是三处各编一个。
const t3Demo = [
  t3Sale('S014', 352, 268, 100, T3_DAY + 52320000),   // 王姐 14:32
  t3Sale('S013', 128, 128, 33, T3_DAY + 39900000),    // 李老板枕芯 11:05 现结
  t3Sale('S011', 2000, 1900, 600, T3_DAY + 32400000), // 背景账
  t3Sale('S012', 1640, 1564, 447, T3_DAY + 36000000), // 背景账
  t3In('P001', 2375, T3_DAY + 34200000),              // 09:30 样张进货单
  t3In('P002', 300, T3_DAY + 28800000),
  t3In('P003', 200, T3_DAY + 30600000),
  // 昨天 16:40 王姐收款：跨日，被 dayStart 挡在外面
  {
    id: 'PAY-y', type: 'pay', amount: 300, profit: 0, customerId: 'c-S014',
    createdAt: T3_DAY - 27000000, lines: []
  }
]
const t3 = inv.todayTotals(t3Demo, T3_DAY)
assert.strictEqual(t3.salesAmount, 4120, '演示账今日应收')
assert.strictEqual(t3.receivedAmount, 3860, '演示账 hero 今日实收')
assert.strictEqual(t3.unreceivedAmount, 260, '演示账 hero 今日未收')
assert.strictEqual(t3.profit, 1180, '演示账今日毛利')
assert.strictEqual(t3.inAmount, 2875, '演示账今日进货')
assert.strictEqual(t3.inCount, 3,
  '演示账今日进货 3 笔 —— 笔 = 单据，对照表里 25 件的样张进货单算一笔')
assert.strictEqual(inv.round2(t3.receivedAmount + t3.unreceivedAmount), t3.salesAmount,
  '恒等式：实收 + 未收 = 应收')

// (b) 退货照口径是要进这三个数的。演示账把 15:10 退货①（96 = 冲欠 84 + 退现金 12）
// 挡在五数之外，那是「今日五数是背景账、不参与逐笔勾稽」这条裁定放行的**演示账特例**，
// 不是公式的反例。公式算出来是下面这组，恒等式照样成立。
const t3WithReturn = t3Demo.concat([
  t3Return('R001', 96, 12, -34, T3_DAY + 54600000)
])
const t3r = inv.todayTotals(t3WithReturn, T3_DAY)
assert.strictEqual(t3r.salesAmount, 4024, '退货冲减应收：4120 − 96')
assert.strictEqual(t3r.receivedAmount, 3848, '退现金 12 从实收里出去：3860 − 12')
assert.strictEqual(t3r.unreceivedAmount, 176, '冲欠 84 把未收压下去：260 − 84')
assert.strictEqual(inv.round2(t3r.receivedAmount + t3r.unreceivedAmount), t3r.salesAmount)

// (c) 收款与期初欠款不进这三个数：今天收了昨天的欠款，hero 三个数一动不动。
// 那笔钱走看板的欠款横幅（totals.receivable），不是丢了。
const t3WithPay = t3Demo.concat([
  {
    id: 'PAY-t', type: 'pay', amount: 3000, profit: 0, customerId: 'c-old',
    createdAt: T3_DAY + 57600000, lines: []
  },
  {
    id: 'OPEN-t', type: 'opening', amount: 500, profit: 0, customerId: 'c-old2',
    createdAt: T3_DAY + 61200000, lines: [{ lineId: 'o1', opening: true }]
  }
])
const t3p = inv.todayTotals(t3WithPay, T3_DAY)
assert.strictEqual(t3p.receivedAmount, 3860, '今日收款 3000 不抬今日实收')
assert.strictEqual(t3p.unreceivedAmount, 260, '今日期初欠款 500 不抬今日未收')
assert.strictEqual(t3p.salesAmount, 4120)

// (d) 走真实写路径：口径不是靠手搭的记录形状撑起来的。
// 卖 200 收 100 再退 50 —— 退的先冲这张单没收到的 100，冲得掉，不退现金。
const t3Prod = inv.createProduct({
  name: 'G3 货', costPrice: 1, salePrice: 100, stock: 100, alertQty: 1
}, T3_DAY, 'p-g3')
let t3Seq = 0
const t3SaleA = inv.applySaleOrder([t3Prod], [], {
  items: [{ productId: 'p-g3', qty: 2, unitPrice: 100 }],
  customerId: 'c-g3', customerName: 'G3 客户', paidAmount: 100
}, T3_DAY + 3600000, 'r-g3-a', function () { t3Seq += 1; return 'r-g3-a-l' + t3Seq }, [])
const t3RetA = inv.applyReturnOrder(t3SaleA.products, t3SaleA.records, {
  items: [{ saleOrderId: 'r-g3-a', saleLineId: 'r-g3-a-l1', qty: 0.5 }]
}, T3_DAY + 7200000, function () { return 'r-g3-a-ret' }, t3SaleA.skus, null)
const t3a = inv.todayTotals(t3RetA.records, T3_DAY)
assert.strictEqual(t3a.salesAmount, 150, '应收 200 − 退货 50')
assert.strictEqual(t3a.receivedAmount, 100, '退货冲得掉欠款，没退现金，实收不动')
assert.strictEqual(t3a.unreceivedAmount, 50, '欠款 100 被冲掉 50')
assert.strictEqual(inv.round2(t3a.receivedAmount + t3a.unreceivedAmount), t3a.salesAmount)
// 当天开单当天退货，今日未收就等于这个客户的欠款净增 —— 两条路必须同解
assert.strictEqual(inv.summarizeCustomerAccount(t3RetA.records, 'c-g3').receivable, 50,
  '今日未收与 max(0, 应收 − 实收 − 已退) 在同日场景下同解')

// 卖 100 收 40 再退 80：欠款只有 60，冲不掉的 20 才算退现金（AGENTS.md 那条规矩）。
let t3Seq2 = 0
const t3SaleB = inv.applySaleOrder([t3Prod], [], {
  items: [{ productId: 'p-g3', qty: 1, unitPrice: 100 }],
  customerId: 'c-g3b', customerName: 'G3 客户乙', paidAmount: 40
}, T3_DAY + 3600000, 'r-g3-b', function () { t3Seq2 += 1; return 'r-g3-b-l' + t3Seq2 }, [])
const t3RetB = inv.applyReturnOrder(t3SaleB.products, t3SaleB.records, {
  items: [{ saleOrderId: 'r-g3-b', saleLineId: 'r-g3-b-l1', qty: 0.8 }]
}, T3_DAY + 7200000, function () { return 'r-g3-b-ret' }, t3SaleB.skus, null)
const t3b = inv.todayTotals(t3RetB.records, T3_DAY)
assert.strictEqual(t3b.salesAmount, 20, '应收 100 − 退货 80')
assert.strictEqual(t3b.receivedAmount, 20, '实收 40 − 退现金 20')
assert.strictEqual(t3b.unreceivedAmount, 0, '欠款 60 被冲光')
assert.strictEqual(inv.round2(t3b.receivedAmount + t3b.unreceivedAmount), t3b.salesAmount)
assert.strictEqual(inv.summarizeCustomerAccount(t3RetB.records, 'c-g3b').receivable, 0)

// (e) 昨天赊的货今天退掉：今日一笔销售都没有，三个数一起变负。
// 这不是新的怪相 —— 今日销售额（salesAmount）本来就会在这种日子变负，
// 恒等式仍然成立，看板照实显示即可。
const t3CrossDay = [
  t3Sale('S-yst', 100, 0, 30, T3_DAY - 3600000),
  t3Return('R-tdy', 100, 0, -30, T3_DAY + 3600000)
]
const t3c = inv.todayTotals(t3CrossDay, T3_DAY)
assert.strictEqual(t3c.salesAmount, -100)
assert.strictEqual(t3c.receivedAmount, 0, '当初一分没收，今天也退不出现金')
assert.strictEqual(t3c.unreceivedAmount, -100, '冲掉的是昨天的欠款')
assert.strictEqual(inv.round2(t3c.receivedAmount + t3c.unreceivedAmount), t3c.salesAmount)

// (f) getDashboard 把两个数原样投影出去；算不出来时给 null 而不是 0。
const t3Dash = inv.getDashboard([], [], T3_DAY, undefined, null, t3)
assert.strictEqual(t3Dash.todayReceivedAmount, 3860)
assert.strictEqual(t3Dash.todayUnreceivedAmount, 260)
assert.strictEqual(t3Dash.todaySalesAmount, 4120, 'hero 的「今日应收」就是这个字段')
assert.strictEqual(t3Dash.todayInCount, 3)
const t3DashNull = inv.getDashboard([], [], T3_DAY)
assert.strictEqual(t3DashNull.todayReceivedAmount, null,
  '今日算不出来时实收给 null，页面显示「—」而不是 0')
assert.strictEqual(t3DashNull.todayUnreceivedAmount, null)
assert.strictEqual(t3DashNull.todayInCount, null, '笔数算不出来也给 null，不是 0')

// (h) 进货笔数的单位是**单据**，不是行、不是件：一张 3 行的进货单记 1 笔。
// 这条钉的就是对照表那句「共 3 笔……其中样张进货单 25 件 ¥2,375.00」——
// 25 件那张算一笔，与 recordTerms 的 saleCount 同单位。
const t3MultiLineIn = inv.todayTotals([
  {
    id: 'P-multi', type: 'in', amount: 600, profit: 0, createdAt: T3_DAY + 3600000,
    lines: [
      { lineId: 'l1', qty: 10, unitPrice: 20, amount: 200 },
      { lineId: 'l2', qty: 10, unitPrice: 20, amount: 200 },
      { lineId: 'l3', qty: 10, unitPrice: 20, amount: 200 }
    ]
  },
  t3In('P-single', 100, T3_DAY + 7200000)
], T3_DAY)
assert.strictEqual(t3MultiLineIn.inAmount, 700)
assert.strictEqual(t3MultiLineIn.inCount, 2, '3 行的进货单 + 1 行的进货单 = 2 笔，不是 4 笔')

// (g) 恒等式的随机复算：整数分累加 +「未收 = 应收 − 实收」由构造成立，
// 任何一天的任何一组销售 / 退货都不该拆散它。
let t3FuzzSeed = 20260825
function t3Rand(n) {
  t3FuzzSeed = (t3FuzzSeed * 1103515245 + 12345) % 2147483648
  return t3FuzzSeed % n
}
for (let t3Trial = 0; t3Trial < 300; t3Trial += 1) {
  const bag = []
  const n = 1 + t3Rand(8)
  for (let k = 0; k < n; k += 1) {
    const amount = inv.round2((1 + t3Rand(50000)) / 100)
    const settled = inv.round2(t3Rand(Math.round(amount * 100) + 1) / 100)
    const at = T3_DAY + t3Rand(86400000)
    if (t3Rand(3) === 0) {
      bag.push(t3Return('rf' + t3Trial + '-' + k, amount, settled, -1, at))
    } else {
      bag.push(t3Sale('sf' + t3Trial + '-' + k, amount, settled, 1, at))
    }
  }
  const got = inv.todayTotals(bag, T3_DAY)
  assert.strictEqual(inv.round2(got.receivedAmount + got.unreceivedAmount), got.salesAmount,
    'G3 恒等式被破坏（trial ' + t3Trial + '）：实收 ' + got.receivedAmount
    + ' + 未收 ' + got.unreceivedAmount + ' ≠ 应收 ' + got.salesAmount)
}
console.log('G3 今日实收 / 未收：演示账 4120 = 3860 + 260 复算通过，恒等式 300 局随机复算通过')

// ---------------------------------------------------------------------------
// G1 · 预收（客户余额 / 超收转预收 / 开单抵扣 / 退货回流）
//
// 契约见 docs/accounting-vs-policy.md。四组，分工不同，谁也不冒充谁：
//   G1-A 演示账主链  —— 设计稿上那几个数必须算得出来
//   G1-B 退货三格    —— 欠款 → 现金 → 预收，含拆分不变量
//   G1-C no-op       —— 老记录（一格预收字段都不带）逐分退化成旧公式
//   G1-D 取小是支点  —— 手搭反证 + 边界扫描，**这一组管的是 creditedAmount 那行取小**
//
// G1-D 的存在理由：G1-B 的随机语料天然满足 paidAmount + prepayUsed <= amount
// （生成器就是这么写的），所以它跑绿跟那行取小在不在**没有关系**。实测把取小
// 注释掉，G1-A/B/C 全绿、只有 G1-D 变红。别把 G1-D 当成冗余的边界用例删掉。
// ---------------------------------------------------------------------------

// —— G1-A：演示账主链（设计稿 9:18 对照表）——
// 昨天王姐欠 300 → 收款 500（冲欠 300 + 预收 200）→ 今日单 014 应收 352
const g1Prod = inv.createProduct({
  name: '四件套', costPrice: 60, salePrice: 128, stock: 100, alertQty: 1
}, 50000, 'g1-p')
function g1Sale(records, payload, at, id) {
  return inv.applySaleOrder([g1Prod], records, Object.assign({
    customerId: 'g1-c', customerName: '王姐'
  }, payload), at, id, function () { return id + '-l' }, [])
}

const g1Debt = g1Sale([], {
  items: [{ productId: 'g1-p', qty: 1, unitPrice: 300 }], paidAmount: 0
}, 50100, 'g1-old')
assert.strictEqual(inv.summarizeCustomerAccount(g1Debt.records, 'g1-c').receivable, 300)

const g1Pay = inv.applyPayment(g1Debt.records, {
  customerId: 'g1-c', customerName: '王姐', amount: 500
}, 50200, 'g1-pay')
assert.strictEqual(g1Pay.record.amount, 500, '流水上是一条「收款 ¥500」，不拆成两行')
assert.strictEqual(g1Pay.record.prepayAdded, 200)
const g1AfterPay = inv.summarizeCustomerAccount(g1Pay.records, 'g1-c')
assert.strictEqual(g1AfterPay.receivable, 0, '欠款清零')
assert.strictEqual(g1AfterPay.prepay, 200, '预收 200 = 500 − 300')

// 分支 A：预收未用，实收 268 → 欠 84。欠款和预收**并存不对消**
const g1BranchA = g1Sale(g1Pay.records, {
  items: [{ productId: 'g1-p', qty: 1, unitPrice: 352 }], paidAmount: 268
}, 50300, 'g1-014a')
const g1A = inv.summarizeCustomerAccount(g1BranchA.records, 'g1-c')
assert.strictEqual(g1A.receivable, 84, '分支 A：欠 84')
assert.strictEqual(g1A.prepay, 200, '预收 200 原封不动 —— 并存态，净成 −116 就丢信息了')

// 分支 B：抵预收 200、现金 152 → 收满，欠 0、预收归 0
const g1BranchB = g1Sale(g1Pay.records, {
  items: [{ productId: 'g1-p', qty: 1, unitPrice: 352 }], paidAmount: 152, prepayUsed: 200
}, 50300, 'g1-014b')
assert.strictEqual(g1BranchB.record.amount, 352, 'amount 仍是整单应收')
assert.strictEqual(g1BranchB.record.paidAmount, 152, '「收满 ¥152.00」= 应收 − 抵扣')
assert.strictEqual(g1BranchB.record.prepayUsed, 200)
const g1B = inv.summarizeCustomerAccount(g1BranchB.records, 'g1-c')
assert.strictEqual(g1B.receivable, 0, '分支 B：收满不欠')
assert.strictEqual(g1B.prepay, 0, '预收被抵光')

// G3 联锁：今日实收只认现金，预收是别的日子收的钱
assert.strictEqual(inv.todayTotals([g1BranchB.record], 50000).receivedAmount, 152,
  '抵扣不抬今日实收（否则那 200 会被算成今天进的抽屉）')
assert.strictEqual(inv.todayTotals([g1BranchB.record], 50000).salesAmount, 352)

// 超收样张：应收 352、实收框填 400 → 单头 352 + 预收 48
const g1Over = g1Sale([], {
  items: [{ productId: 'g1-p', qty: 1, unitPrice: 352 }], paidAmount: 400
}, 50400, 'g1-over')
assert.strictEqual(g1Over.record.paidAmount, 352)
assert.strictEqual(g1Over.record.prepayAdded, 48, '超收 48 = 400 − 352')
assert.strictEqual(inv.todayTotals([g1Over.record], 50000).receivedAmount, 352,
  '超收也不抬今日实收')

// 一张单不许既抵预收又超收
assert.throws(function () {
  g1Sale(g1Pay.records, {
    items: [{ productId: 'g1-p', qty: 1, unitPrice: 352 }], paidAmount: 200, prepayUsed: 200
  }, 50500, 'g1-both')
}, /已抵扣预收/)

// 抵扣超过客户预收余额要拦住（全账户扫描，不是按单校验）
assert.throws(function () {
  g1Sale(g1Pay.records, {
    items: [{ productId: 'g1-p', qty: 1, unitPrice: 352 }], paidAmount: 0, prepayUsed: 300
  }, 50600, 'g1-toomuch')
}, /预收/)

// —— G1-B：退货三格（欠款 → 现金 → 预收）——
// 分支 B 那张单 352 = 现金 152 + 抵预收 200、欠 0。全额退货必须退现金 152 +
// 回流预收 200，**不是**退现金 352 —— 客户当初只掏了 152 现钞。
function g1Ret(products, records, qty, at, id, skus) {
  return inv.applyReturn(products, records, {
    saleOrderId: 'g1-014b', saleLineId: 'g1-014b-l', qty: qty
  }, at, id, skus)
}
const g1FullRet = g1Ret(g1BranchB.products, g1BranchB.records, 1, 50700, 'g1-r1', g1BranchB.skus)
const g1FullRetRec = g1FullRet.records.find(function (r) { return r.id === 'g1-r1' })
assert.strictEqual(g1FullRetRec.paidAmount, 152, '退现金 = 当初收的现金')
assert.strictEqual(g1FullRetRec.prepayRefund, 200, '抵掉的预收回流')
const g1AfterRet = inv.summarizeCustomerAccount(g1FullRet.records, 'g1-c')
assert.strictEqual(g1AfterRet.receivable, 0)
assert.strictEqual(g1AfterRet.prepay, 200, '全退之后预收余额回到 200')

// 部分退货：欠款 0，先退现金，预收不动
const g1Half = g1Sale(g1Pay.records, {
  items: [{ productId: 'g1-p', qty: 2, unitPrice: 176 }], paidAmount: 152, prepayUsed: 200
}, 50800, 'g1-014c')
const g1PartRet = inv.applyReturn(g1Half.products, g1Half.records, {
  saleOrderId: 'g1-014c', saleLineId: 'g1-014c-l', qty: 0.5
}, 50810, 'g1-r2', g1Half.skus)
const g1PartRec = g1PartRet.records.find(function (r) { return r.id === 'g1-r2' })
assert.strictEqual(g1PartRec.paidAmount, 88, '退 88 全走现金（现金额度还有 152）')
assert.strictEqual(g1PartRec.prepayRefund, undefined, '没动到预收就不写这个字段')

// 三张退货按记账顺序分份额：现金先吃光，再吃预收
let g1Multi = g1Sale(g1Pay.records, {
  items: [{ productId: 'g1-p', qty: 4, unitPrice: 88 }], paidAmount: 152, prepayUsed: 200
}, 50900, 'g1-014d')
const g1MultiShares = []
;[1, 1, 2].forEach(function (qty, i) {
  g1Multi = inv.applyReturn(g1Multi.products, g1Multi.records, {
    saleOrderId: 'g1-014d', saleLineId: 'g1-014d-l', qty: qty
  }, 50910 + i, 'g1-m' + i, g1Multi.skus)
  const rec = g1Multi.records.find(function (r) { return r.id === 'g1-m' + i })
  g1MultiShares.push([rec.paidAmount, inv.round2(inv.toNumber(rec.prepayRefund))])
})
assert.deepStrictEqual(g1MultiShares, [[88, 0], [64, 24], [0, 176]],
  '现金 152 先被吃光（88 + 64），之后才动预收 200（24 + 176）')
const g1AfterMulti = inv.summarizeCustomerAccount(g1Multi.records, 'g1-c')
assert.strictEqual(g1AfterMulti.receivable, 0)
assert.strictEqual(g1AfterMulti.prepay, 200, '全退完预收整整回来 200')

// 拆分不变量：Σ冲欠款 == min(D, Σ退货额)，Σ现金 <= 当初收的现金，D >= 0
const g1MultiSale = g1Multi.records.find(function (r) { return r.id === 'g1-014d' })
const g1D = inv.round2(inv.toNumber(g1MultiSale.amount) - inv.creditedAmount(g1MultiSale))
assert.ok(g1D >= 0, 'D >= 0')
const g1Rets = g1Multi.records.filter(function (r) {
  return r.type === 'return' && (r.lines[0] || {}).saleOrderId === 'g1-014d'
})
const g1SumR = inv.round2(g1Rets.reduce(function (s, r) { return s + inv.toNumber(r.amount) }, 0))
const g1SumOffset = inv.round2(g1Rets.reduce(function (s, r) {
  return s + inv.toNumber(r.amount) - inv.toNumber(r.paidAmount) - inv.toNumber(r.prepayRefund)
}, 0))
assert.strictEqual(g1SumOffset, inv.round2(Math.min(g1D, g1SumR)), 'Σ冲欠款 == min(D, Σr)')
const g1SumCash = inv.round2(g1Rets.reduce(function (s, r) { return s + inv.toNumber(r.paidAmount) }, 0))
assert.ok(g1SumCash <= inv.settledAmount(g1MultiSale) + 0.005, 'Σ现金 <= 销售单 paidAmount')

// —— G1-C：no-op —— 老记录一格预收字段都不带，新公式必须逐分退化成旧公式 ——
//
// 这一条是「改账法在存量上是恒等变换」的证明。旧公式写死在这里当参照实现，
// **不许从新实现抄一个值过来**——抄过来就成了自证。
// （另一份更强的守门在 tests/ledger-terms.test.js 的 assertMatchesLegacy：
// 2000 条两位小数 fuzz + 三代形状语料，逐字段比对并断言 prepay 恒为 0。）
function g1LegacyCredited(rec) {
  const amount = inv.round2(inv.toNumber(rec.amount))
  const paid = inv.round2(inv.toNumber(rec.paidAmount))
  if (paid <= 0) return 0
  return paid > amount ? amount : paid
}
let g1NoopSeed = 20260830
function g1Rand() {
  g1NoopSeed = (g1NoopSeed * 1103515245 + 12345) & 0x7fffffff
  return g1NoopSeed / 0x7fffffff
}
for (let i = 0; i < 5000; i += 1) {
  const amount = inv.round2(g1Rand() * 1000 + 0.01)
  const legacy = {
    type: 'out', amount: amount,
    paidAmount: inv.round2(g1Rand() * amount)
  }
  assert.strictEqual(inv.creditedAmount(legacy), g1LegacyCredited(legacy),
    'no-op：老记录上 creditedAmount 必须等于旧的 settledAmount')
  const terms = inv.recordTerms(legacy)
  assert.strictEqual(terms.prepaySum, 0, 'no-op：老记录不得折出预收')
  assert.strictEqual(terms.prepayUsedSum, 0, 'no-op：老记录不得折出预收抵扣')
  assert.strictEqual(inv.accountOf(terms).prepay, 0)
}

// —— G1-D：creditedAmount 那行取小是 D >= 0 的支点（守门员，别删）——
//
// 上面 G1-B 的语料天然满足 paidAmount + prepayUsed <= amount，所以它对这行取小
// **完全无效**。实测：把取小注释掉，G1-A/B/C 全绿，只有下面这两组变红。

// D-1 手搭反证：一条 paidAmount + prepayUsed > amount 的畸形记录。
// 写路径挡着，但改单、老数据兜底、云函数与小程序版本错位都造得出来。
const g1Bad = { type: 'out', amount: 352, paidAmount: 300, prepayUsed: 200 }
assert.strictEqual(inv.creditedAmount(g1Bad), 352,
  '取小生效：夹到 352，不是 500')
assert.strictEqual(inv.round2(inv.toNumber(g1Bad.amount) - inv.creditedAmount(g1Bad)), 0,
  '于是 D = 0，没有折负')
// 去掉取小会怎样：D = 352 − 500 = −148，returnCashRefund 走 left <= 0 分支、
// Σ冲欠款得 0，而 min(D, Σr) = −148。两个数不等，但没有任何断言会响——
// assertAccountsValid 只在**账户**折负时才拦，单据层的 D < 0 它看不见。
const g1NoClamp = inv.round2(inv.settledAmount(g1Bad) + inv.toNumber(g1Bad.prepayUsed))
assert.strictEqual(inv.round2(inv.toNumber(g1Bad.amount) - g1NoClamp), -148,
  '反证：不取小就是 −148')

// D-2 边界扫描：P 与 U 独立采样、故意让 P + U 常常越过 A，把边界扫成一条线
let g1SweepOver = 0
for (let i = 0; i < 5000; i += 1) {
  const amount = inv.round2(g1Rand() * 1000 + 0.01)
  const paid = inv.round2(g1Rand() * amount * 1.4)
  const used = inv.round2(g1Rand() * amount * 1.4)
  const rec = { type: 'out', amount: amount, paidAmount: paid, prepayUsed: used }
  if (inv.round2(paid + used) > amount) g1SweepOver += 1
  assert.strictEqual(inv.creditedAmount(rec),
    inv.round2(Math.min(inv.round2(paid + used), amount)),
    'creditedAmount 必须恒等于 min(paidAmount + prepayUsed, amount)')
  assert.ok(inv.round2(amount - inv.creditedAmount(rec)) >= 0,
    'D >= 0 在任何 P/U 组合下都要成立')
}
assert.ok(g1SweepOver > 1500,
  '边界要真的被扫到：越界组合太少这一组就退化成摆设，实际 ' + g1SweepOver)

console.log('G1 预收：演示账主链（欠 84 / 预收 200 并存、分支 B 收满 152、超收 48）'
  + '、退货三格、no-op 5000 组、取小边界扫描 ' + g1SweepOver + '/5000 越界，全部通过')

// ---------------------------------------------------------------------------
// 货号对商品、条码对规格（2026-09-01 裁定）
// ---------------------------------------------------------------------------
// 此前两级都有 sku + barcode，且 skuCode = sku.sku || product.sku 让规格级货号
// 能盖掉商品级。UI 上从来没有规格级货号的录入口（规格矩阵只有 规格/库存/预警/售价），
// 种子数据也只填商品级，所以那个字段实际恒空 —— 收敛它零数据影响。
// 条码**保留**在规格级：一件毛衣的红色 M 码和蓝色 L 码本来就该各有条码。
;(function () {
  const nextId = idFactory()
  const product = inv.createProduct(
    { name: '毛衣', sku: 'MY-001', barcode: '690000000001', colors: ['红'], sizes: ['M'] },
    1000, nextId()
  )
  const sku = inv.createSku(
    { productId: product.id, color: '红', size: 'M', sku: '不该被接受的规格级货号',
      barcode: '690000000002', costPrice: 10, salePrice: 20, stock: 5 },
    1000, nextId()
  )
  assert.ok(!('sku' in sku),
    '规格上不该再有 sku 字段：货号对商品、条码对规格。实为 ' + JSON.stringify(sku.sku))
  assert.strictEqual(sku.barcode, '690000000002',
    '条码要留在规格级 —— 同一商品的不同规格各有条码')

  // 流水行上的货号快照一律取商品级。**写入点全仓六处，六处都要覆盖** ——
  // allocateBlankLine / consumeSaleLine / applyPurchase 两个分支 / applyConvert /
  // applyAdjust。它们是彼此独立的代码，验一条不代表别条也对。
  //
  // 这一组前后返工过两次，都栽在同一个病灶的不同形态：第一版只走 applySaleOrder，
  // 变异打不中；第二版清单只列了三处，另外三处变异存活 —— 其中 applyAdjust 还被
  // 当时的注释写成「已覆盖」。**「我验过了」和「我把该验的都列全了」是两件事。**
  //
  // 另需说准：真正承重的是上面那条 !('sku' in sku)。把这里的写法改回旧的
  // `sku.sku || product.sku` 变异是**存活**的 —— createSku 已不产出 sku，|| 直接
  // 落回 product.sku。下面这几条只在「读纯规格级字段」时才红。
  const perPath = []
  const out = sale([product], [], {
    payType: 'cash', productId: product.id, skuId: sku.id, qty: 1, unitPrice: 20
  }, 2000, 'o1', [sku])
  perPath.push(['销售 consumeSaleLine', line0(out.records[0]).sku])

  const bought = inv.applyPurchase([product], [], {
    productId: product.id, skuId: sku.id, color: '红', size: 'M', qty: 2, unitPrice: 10
  }, 3000, 'r1', [sku])
  perPath.push(['进货 applyPurchase', bought.record.lines[0].sku])

  const adjusted = inv.applyAdjust(bought.products, bought.records, {
    productId: product.id, skuId: sku.id, direction: 'in', reason: 'surplus', qty: 1
  }, 4000, 'r2', bought.skus)
  perPath.push(['库存修正 applyAdjust', adjusted.record.lines[0].sku])

  const sku2 = inv.createSku(
    { productId: product.id, color: '蓝', size: 'M', barcode: '690000000003',
      costPrice: 10, salePrice: 20, stock: 0 }, 1000, nextId()
  )
  const convWorking = adjusted.skus.concat([sku2])
  const converted = inv.applyConvert(adjusted.products, adjusted.records, {
    productId: product.id, fromSkuId: sku.id, toSkuId: sku2.id, qty: 1
  }, 5000, 'r3', convWorking)
  perPath.push(['换规格 applyConvert', converted.record.lines[0].sku])

  // 进货有两个分支，只走分规格那条会漏掉待加工那条（:756）—— 逐点变异实测确认过。
  const blankProd = inv.createProduct(
    { name: '毛坯布', sku: 'MP-002', costPrice: 5, salePrice: 9, stock: 0,
      specAxis1: '色', colors: ['本白'], blankProcess: true }, 1000, nextId()
  )
  const blankSkus = inv.rebuildSkus
    ? inv.rebuildSkus(blankProd, [], {})
    : [inv.createSku({ productId: blankProd.id, isBlank: true, costPrice: 5,
        salePrice: 9, stock: 0 }, 1000, nextId())]
  const blankBought = inv.applyPurchase([blankProd], [], {
    productId: blankProd.id, qty: 3, unitPrice: 5
  }, 3500, 'rb1', blankSkus)
  assert.strictEqual(blankBought.record.lines[0].sku, 'MP-002',
    '待加工进货行的货号要取商品级 product.sku，实为 '
      + JSON.stringify(blankBought.record.lines[0].sku))

  perPath.forEach(function (pair) {
    assert.strictEqual(pair[1], 'MY-001',
      pair[0] + ' 的货号要取商品级 product.sku，实为 ' + JSON.stringify(pair[1]))
  })
})()

