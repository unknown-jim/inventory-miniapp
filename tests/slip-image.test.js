const assert = require('assert')
const util = require('../utils/util')
const slipImage = require('../utils/slip-image')

function sampleSlip(overrides) {
  return Object.assign({
    docNo: 'SH20260815-AB12',
    timeText: '2026-08-15 21:08',
    lines: [{
      id: 'l1',
      productName: '短袖 T恤',
      specText: '黑色 · M',
      qtyText: '2',
      priceText: '59.00',
      amountText: '118.00'
    }],
    amountText: '118.00',
    remark: '门口放',
    hasCustomer: true,
    customerName: '张三超市',
    customerPhone: '13800138000',
    customerAddress: '建设路12号',
    isCredit: true,
    payText: '赊账',
    prevDebtText: '17.00',
    thisDebtText: '118.00',
    receivableText: '135.00',
    hasDebt: true
  }, overrides || {})
}

function textsOf(layout) {
  return layout.commands.filter(function (item) {
    return item.type === 'text'
  }).map(function (item) {
    return item.text
  }).join('\n')
}

assert.deepStrictEqual(slipImage.wrapText('短袖', 1000, function (text) {
  return slipImage.estimateWidth(text, '28px sans-serif')
}), ['短袖'])

const wrapped = slipImage.wrapText('纯牛奶250ml纯牛奶250ml纯牛奶250ml', 120, function (text) {
  return slipImage.estimateWidth(text, '28px sans-serif')
})
assert.ok(wrapped.length > 1)

const slip = sampleSlip()
const layout = slipImage.layoutSlip(slip)
const text = textsOf(layout)
assert.ok(layout.height > 400)
assert.ok(text.indexOf('送货单') >= 0)
assert.ok(text.indexOf('SH20260815-AB12') >= 0)
assert.ok(text.indexOf('张三超市') >= 0)
assert.ok(text.indexOf('黑色 · M') >= 0)
assert.ok(text.indexOf('赊账') >= 0)
assert.ok(text.indexOf('门口放') >= 0)
assert.ok(text.indexOf('¥118.00') >= 0)
assert.ok(text.indexOf('毛利') < 0)
assert.ok(text.indexOf('进价') < 0)
assert.ok(text.indexOf('内部备注') < 0)

const walkin = slipImage.layoutSlip(sampleSlip({
  hasCustomer: false,
  customerName: '',
  payText: '现结',
  isCredit: false,
  remark: ''
}))
const walkinText = textsOf(walkin)
assert.ok(walkinText.indexOf('收货人') < 0)
assert.ok(walkinText.indexOf('累计欠款') < 0)
assert.ok(walkin.height < layout.height)

const many = slipImage.layoutSlip(sampleSlip({
  lines: [
    { id: 'a', productName: '纯牛奶 250ml', specText: '', qtyText: '6', priceText: '4.50', amountText: '27.00' },
    { id: 'b', productName: '全麦面包', specText: '', qtyText: '2', priceText: '9.90', amountText: '19.80' },
    { id: 'c', productName: '短袖 T恤', specText: '白色 · L', qtyText: '1', priceText: '59.00', amountText: '59.00' }
  ]
}))
assert.ok(many.height > layout.height)

const fromOrder = util.withSlipView({
  id: 'order-1',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  payType: 'credit',
  remark: '',
  customerName: '李记便利',
  customerPhone: '13900139000',
  customerAddress: '中山街88号',
  records: [{
    id: 'r1',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 9)
const orderLayout = slipImage.layoutSlip(fromOrder)
assert.ok(textsOf(orderLayout).indexOf('李记便利') >= 0)
assert.ok(textsOf(orderLayout).indexOf('送货单') >= 0)

const reprintRecords = [
  {
    id: 'pay-1',
    type: 'pay',
    customerId: 'c1',
    amount: 18.9,
    createdAt: 2000
  },
  {
    id: 'r-b',
    type: 'out',
    orderId: 'order-1',
    productName: '全麦面包',
    qty: 1,
    unitPrice: 9.9,
    amount: 9.9,
    payType: 'credit',
    customerId: 'c1',
    customerName: '李记便利',
    createdAt: 1000
  },
  {
    id: 'r-a',
    type: 'out',
    orderId: 'order-1',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    payType: 'credit',
    customerId: 'c1',
    customerName: '李记便利',
    createdAt: 1000
  }
]
const reprint = util.withSlipViewFromRecord(reprintRecords, reprintRecords[1])
assert.strictEqual(reprint.lines.length, 2)
assert.strictEqual(reprint.lines[0].productName, '纯牛奶 250ml')
assert.strictEqual(reprint.payText, '赊账')
assert.strictEqual(reprint.thisDebtText, '18.90')
assert.strictEqual(reprint.prevDebtText, '0.00')
assert.strictEqual(reprint.receivableText, '18.90')

const openingThenSale = [
  {
    id: 'open-1',
    type: 'opening',
    customerId: 'c1',
    amount: 50,
    createdAt: 500
  },
  {
    id: 'r-open-sale',
    type: 'out',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    payType: 'credit',
    customerId: 'c1',
    customerName: '李记便利',
    createdAt: 1000
  }
]
const openingSlip = util.withSlipViewFromRecord(openingThenSale, openingThenSale[1])
assert.strictEqual(openingSlip.prevDebtText, '50.00')
assert.strictEqual(openingSlip.thisDebtText, '9.00')
assert.strictEqual(openingSlip.receivableText, '59.00')

console.log('slip-image tests passed')
