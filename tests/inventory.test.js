const assert = require('assert')
const inv = require('../utils/inventory')

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
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
  inv.applySale([created], [], { productId: 'p1', qty: 11, unitPrice: 4.5 }, 4000, 'r2')
}, /库存不足/)

const sold = inv.applySale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 4,
  unitPrice: 4.5
}, 5000, 'r3')
assert.strictEqual(sold.products[0].stock, 11)
assert.strictEqual(sold.record.profit, 7.6)
assert.strictEqual(sold.record.amount, 18)
assert.strictEqual(sold.record.payType, 'cash')

const low = sampleProduct({ stock: 5, alertQty: 5 })
assert.strictEqual(inv.isLowStock(low), true)
assert.strictEqual(inv.isLowStock(sampleProduct({ stock: 6, alertQty: 5 })), false)

const now = new Date('2026-08-15T12:00:00').getTime()
const sameDayPurchase = inv.applyPurchase([created], [], {
  productId: 'p1',
  qty: 5,
  unitPrice: 2.6
}, now - 3600000, 'r-day-in')
const sameDaySale = inv.applySale(sameDayPurchase.products, sameDayPurchase.records, {
  productId: 'p1',
  qty: 4,
  unitPrice: 4.5
}, now - 1800000, 'r-day-out')
const dashboard = inv.getDashboard(sameDaySale.products, sameDaySale.records, now)
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

const soldToCustomer = inv.applySale(purchased.products, purchased.records, {
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
  inv.applySale(purchased.products, purchased.records, {
    productId: 'p1',
    qty: 1,
    unitPrice: 4.5,
    payType: 'credit'
  }, 8100, 'r-credit-no-customer')
}, /客户/)

const creditSale = inv.applySale(purchased.products, purchased.records, {
  productId: 'p1',
  qty: 2,
  unitPrice: 4.5,
  customerId: 'c1',
  customerName: '张三超市',
  payType: 'credit'
}, 8200, 'r-credit')
assert.strictEqual(creditSale.record.payType, 'credit')
assert.strictEqual(inv.summarizeCustomerAccount(creditSale.records, 'c1').receivable, 9)

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
    payType: 'credit'
  },
  9100,
  'order-1',
  idFactory()
)
assert.strictEqual(multi.order.records.length, 2)
assert.strictEqual(multi.order.amount, 18.9)
assert.strictEqual(multi.order.records[0].orderId, 'order-1')
assert.strictEqual(multi.order.records[1].orderId, 'order-1')
assert.strictEqual(multi.products.find(function (item) { return item.id === 'p1' }).stock, 13)
assert.strictEqual(multi.products.find(function (item) { return item.id === 'p2' }).stock, 7)
assert.strictEqual(inv.summarizeCustomerAccount(multi.records, 'c1').receivable, 18.9)

const rebuiltOrder = inv.buildSaleOrder(multi.records, multi.order.records[1])
assert.strictEqual(rebuiltOrder.id, 'order-1')
assert.strictEqual(rebuiltOrder.records.length, 2)
assert.strictEqual(rebuiltOrder.records[0].id, multi.order.records[0].id)
assert.strictEqual(rebuiltOrder.records[1].id, multi.order.records[1].id)
assert.strictEqual(rebuiltOrder.amount, 18.9)
assert.throws(function () {
  inv.buildSaleOrder(multi.records, { type: 'pay', id: 'x' })
}, /销售/)

const grouped = inv.groupRecords(multi.records)
assert.strictEqual(grouped.length, 2)
assert.strictEqual(grouped[0].type, 'out')
assert.strictEqual(grouped[0].lineCount, 2)
assert.strictEqual(grouped[0].amount, 18.9)
assert.strictEqual(grouped[0].qty, 3)
assert.strictEqual(grouped[0].productName, '纯牛奶、全麦面包')
assert.strictEqual(grouped.filter(function (item) {
  return item.type === 'out'
}).length, 1)
assert.strictEqual(inv.summarizeCustomerAccount(multi.records, 'c1').count, 1)
assert.strictEqual(inv.getDashboard(multi.products, multi.records, 9100).recent[0].lineCount, 2)

const orderItemsEdit = inv.updateRecord(multi.products, multi.records, {
  id: multi.order.records[0].id,
  items: [
    { id: multi.order.records[0].id, qty: 3, unitPrice: 4.5 },
    { id: multi.order.records[1].id, qty: 1, unitPrice: 9.9 }
  ],
  payType: 'credit',
  customerId: 'c1',
  customerName: '张三超市',
  remark: '整单备注'
}, 9110, [])
assert.strictEqual(orderItemsEdit.products.find(function (item) { return item.id === 'p1' }).stock, 12)
assert.ok(orderItemsEdit.records.filter(function (item) {
  return item.orderId === 'order-1'
}).every(function (item) {
  return item.remark === '整单备注'
}))

const deletedOrder = inv.deleteRecord(multi.products, multi.records, multi.order.records[1].id, 9120, [])
assert.strictEqual(deletedOrder.records.filter(function (item) {
  return item.orderId === 'order-1'
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
  inv.applySale([teeSkus.product], [], {
    productId: 'p-tee',
    qty: 1,
    unitPrice: 59
  }, 1500, 'r-spec-miss', teeSkus.skus)
}, /规格一和规格二/)

const blackM = teeSkus.skus.find(function (item) {
  return item.color === '黑色' && item.size === 'M'
})
const soldTee = inv.applySale([teeSkus.product], [], {
  productId: 'p-tee',
  skuId: blackM.id,
  qty: 2,
  unitPrice: 59
}, 1600, 'r-tee', teeSkus.skus)
assert.strictEqual(soldTee.record.color, '黑色')
assert.strictEqual(soldTee.record.size, 'M')
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
assert.strictEqual(specOrder.order.records.length, 2)
assert.strictEqual(specOrder.order.records[0].size, 'M')
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
assert.strictEqual(editedSale.record.qty, 2)
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

const heavySale = inv.applySale(purchased.products, purchased.records, {
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

const orderEdit = inv.updateRecord(multi.products, multi.records, {
  id: multi.order.records[0].id,
  qty: 2,
  unitPrice: 4.5,
  payType: 'cash',
  customerId: 'c1',
  customerName: '张三超市'
}, 2900, [])
assert.strictEqual(orderEdit.record.payType, 'cash')
assert.ok(orderEdit.records.filter(function (item) {
  return item.orderId === 'order-1'
}).every(function (item) {
  return item.payType === 'cash'
}))

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

const soldWhite = inv.applySale(boughtBlank.products, boughtBlank.records, {
  productId: 'p-hoodie',
  skuId: whiteM.id,
  qty: 3,
  unitPrice: 99
}, 1300, 'r-hoodie-out', boughtBlank.skus)
assert.strictEqual(inv.findBlankSku(soldWhite.skus, 'p-hoodie').stock, 22)
assert.strictEqual(inv.findSkuBySpec(soldWhite.skus, 'p-hoodie', '白色', 'M').stock, 0)
assert.strictEqual(soldWhite.record.color, '白色')
assert.strictEqual(soldWhite.record.size, 'M')
assert.strictEqual(soldWhite.record.allocations[0].source, 'blank')
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
  saleRecordId: sharedOrder.order.records[0].id,
  qty: 2
}, 1600, 'r-hoodie-return', sharedOrder.skus)
assert.strictEqual(inv.findSkuBySpec(returned.skus, 'p-hoodie', '白色', 'M').stock, 2)
assert.strictEqual(inv.findBlankSku(returned.skus, 'p-hoodie').stock, 2)
assert.strictEqual(returned.products[0].stock, 4)
assert.throws(function () {
  inv.applyReturn(returned.products, returned.records, {
    saleRecordId: sharedOrder.order.records[0].id,
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
const soldBlackFromBlank = inv.applySale(converted.products, converted.records, {
  productId: 'p-hoodie',
  skuId: blackMHoodie.id,
  qty: 1,
  unitPrice: 99
}, 1750, 'r-no-auto-recolor', converted.skus)
assert.strictEqual(soldBlackFromBlank.record.allocations[0].source, 'blank')
assert.strictEqual(inv.findSkuBySpec(soldBlackFromBlank.skus, 'p-hoodie', '红色', 'M').stock, 1)
assert.strictEqual(inv.findBlankSku(soldBlackFromBlank.skus, 'p-hoodie').stock, 1)

const soldReadyFirst = inv.applySale(soldBlackFromBlank.products, soldBlackFromBlank.records, {
  productId: 'p-hoodie',
  skuId: redM.id,
  qty: 1,
  unitPrice: 99
}, 1800, 'r-ready-first', soldBlackFromBlank.skus)
assert.strictEqual(soldReadyFirst.record.allocations[0].source, 'ready')
assert.strictEqual(inv.findSkuBySpec(soldReadyFirst.skus, 'p-hoodie', '红色', 'M').stock, 0)
assert.strictEqual(inv.findBlankSku(soldReadyFirst.skus, 'p-hoodie').stock, 1)

const undoneReady = inv.deleteRecord(soldReadyFirst.products, soldReadyFirst.records, 'r-ready-first', 1900, soldReadyFirst.skus)
assert.strictEqual(inv.findSkuBySpec(undoneReady.skus, 'p-hoodie', '红色', 'M').stock, 1)

assert.throws(function () {
  inv.deleteRecord(returned.products, returned.records, sharedOrder.order.records[0].id, 2000, returned.skus)
}, /退货/)

const creditBlank = inv.applySale([hoodieMade.product], [], {
  productId: 'p-hoodie',
  skuId: whiteM.id,
  qty: 1,
  unitPrice: 99,
  customerId: 'c-blank',
  customerName: '测试客户',
  payType: 'credit'
}, 2100, 'r-credit-blank', hoodieMade.skus)
assert.strictEqual(inv.summarizeCustomerAccount(creditBlank.records, 'c-blank').receivable, 99)
const creditReturn = inv.applyReturn(creditBlank.products, creditBlank.records, {
  saleRecordId: 'r-credit-blank',
  qty: 1
}, 2200, 'r-credit-return', creditBlank.skus)
assert.strictEqual(inv.summarizeCustomerAccount(creditReturn.records, 'c-blank').receivable, 0)
assert.strictEqual(inv.findSkuBySpec(creditReturn.skus, 'p-hoodie', '白色', 'M').stock, 1)

const avail = inv.blankAvailability(hoodieMade.product, hoodieMade.skus, '黑色', 'M', [
  { productId: 'p-hoodie', skuId: whiteM.id, qty: 8 }
])
assert.strictEqual(avail.total, 12)
assert.strictEqual(avail.blank, 12)

console.log('inventory tests passed')
