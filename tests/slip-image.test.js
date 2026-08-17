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
      specParts: [
        { name: '颜色', value: '黑色' },
        { name: '尺码', value: 'M' }
      ],
      specText: '颜色 黑色 · 尺码 M',
      sku: 'TS-005',
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
assert.strictEqual(layout.width, 1760)
assert.ok(layout.height > 400)
assert.ok(layout.width > layout.height)
assert.ok(text.indexOf('送货单') >= 0)
assert.ok(text.indexOf('SH20260815-AB12') >= 0)
assert.ok(text.indexOf('张三超市') >= 0)
assert.ok(text.indexOf('黑色') >= 0)
assert.ok(text.indexOf('TS-005') >= 0)
assert.ok(text.indexOf('赊账') >= 0)
assert.ok(text.indexOf('门口放') >= 0)
assert.ok(text.indexOf('¥118.00') >= 0)
assert.ok(text.indexOf('序号') >= 0)
assert.ok(text.indexOf('货号') >= 0)
assert.ok(text.indexOf('品名') >= 0)
assert.ok(text.indexOf('颜色') >= 0)
assert.ok(text.indexOf('尺码') >= 0)
assert.ok(text.indexOf('规格') < 0)
assert.ok(text.indexOf('数量') >= 0)
assert.ok(text.indexOf('单价') >= 0)
assert.ok(text.indexOf('金额') >= 0)
assert.ok(text.indexOf('合计') >= 0)
const totalLabel = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '合计'
})
const qtyHead = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '数量'
})
const nameHead = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '品名'
})
assert.strictEqual(totalLabel.align, 'right')
assert.ok(totalLabel.x > nameHead.x)
assert.ok(totalLabel.x <= qtyHead.x)
assert.ok(text.indexOf('客户签收') >= 0)
assert.ok(text.indexOf('件 ×') < 0)
assert.ok(text.indexOf('未填') < 0)
assert.ok(text.indexOf('毛利') < 0)
assert.ok(text.indexOf('进价') < 0)
assert.ok(text.indexOf('内部备注') < 0)

const drawn = []
slipImage.drawSlip({
  fillStyle: '',
  font: '',
  textAlign: '',
  textBaseline: '',
  strokeStyle: '',
  lineWidth: 1,
  fillRect: function () { drawn.push('fillRect') },
  fillText: function () { drawn.push('fillText') },
  strokeRect: function () { drawn.push('strokeRect') },
  beginPath: function () {},
  moveTo: function () {},
  lineTo: function () {},
  stroke: function () { drawn.push('stroke') },
  save: function () {},
  restore: function () {},
  setLineDash: function () {}
}, layout)
assert.ok(drawn.indexOf('fillText') >= 0)
assert.ok(drawn.indexOf('strokeRect') >= 0)
assert.ok(drawn.indexOf('stroke') >= 0)

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
assert.ok(walkinText.indexOf('经手人') >= 0)
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
    sku: 'MK-001',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 9)
const orderLayout = slipImage.layoutSlip(fromOrder)
assert.ok(textsOf(orderLayout).indexOf('李记便利') >= 0)
assert.ok(textsOf(orderLayout).indexOf('送货单') >= 0)
assert.ok(textsOf(orderLayout).indexOf('MK-001') >= 0)
assert.strictEqual(fromOrder.lines[0].sku, 'MK-001')
assert.ok(textsOf(orderLayout).indexOf('颜色') < 0)
assert.ok(textsOf(orderLayout).indexOf('规格') < 0)

const unlabeled = slipImage.layoutSlip(sampleSlip({
  lines: [{
    id: 'u1',
    productName: '短袖 T恤',
    specText: '黑色 · M',
    qtyText: '1',
    priceText: '59.00',
    amountText: '59.00'
  }]
}))
const unlabeledText = textsOf(unlabeled)
assert.ok(unlabeledText.indexOf('规格') >= 0)
assert.ok(unlabeledText.indexOf('黑色 · M') >= 0)

const mixedLines = [
  {
    id: 't1',
    productName: '短袖 T恤',
    specParts: [
      { name: '颜色', value: '白色' },
      { name: '尺码', value: 'L' }
    ],
    specText: '颜色 白色 · 尺码 L',
    qtyText: '1',
    priceText: '59.00',
    amountText: '59.00'
  },
  {
    id: 'tea1',
    productName: '绿茶',
    specParts: [
      { name: '口味', value: '原味' },
      { name: '克数', value: '50g' }
    ],
    specText: '口味 原味 · 克数 50g',
    qtyText: '2',
    priceText: '20.00',
    amountText: '40.00'
  }
]
assert.deepStrictEqual(slipImage.specAxisNames(mixedLines), ['颜色', '尺码', '口味', '克数'])
const mixedText = textsOf(slipImage.layoutSlip(sampleSlip({ lines: mixedLines })))
assert.ok(mixedText.indexOf('颜色') >= 0)
assert.ok(mixedText.indexOf('尺码') >= 0)
assert.ok(mixedText.indexOf('口味') >= 0)
assert.ok(mixedText.indexOf('克数') >= 0)
assert.ok(mixedText.indexOf('原味') >= 0)
assert.ok(mixedText.indexOf('白色') >= 0)

const named = util.withSlipView({
  id: 'order-named',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 118,
  payType: 'credit',
  customerName: '李记便利',
  records: [{
    id: 'r-tee',
    productId: 'p-tee',
    productName: '短袖 T恤',
    color: '黑色',
    size: 'M',
    sku: 'TS-005',
    qty: 2,
    unitPrice: 59,
    amount: 118,
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 118, [{ id: 'p-tee', specAxis1: '颜色', specAxis2: '尺码' }])
assert.strictEqual(named.lines[0].specText, '颜色 黑色 · 尺码 M')
assert.strictEqual(named.lines[0].specParts[0].name, '颜色')
assert.ok(textsOf(slipImage.layoutSlip(named)).indexOf('尺码') >= 0)

const blankSku = util.withSlipView({
  id: 'order-blank-sku',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  payType: 'cash',
  records: [{
    id: 'r-blank',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 0)
assert.strictEqual(blankSku.lines[0].sku, '')
assert.ok(textsOf(slipImage.layoutSlip(blankSku)).indexOf('未填') < 0)

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

const namedShop = util.withSlipView({
  id: 'order-shop',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  payType: 'cash',
  operatorOpenid: 'oxxxxxxxxxxxxxxxxxx',
  operatorName: '小李',
  records: [{
    id: 'r-shop',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    operatorOpenid: 'oxxxxxxxxxxxxxxxxxx',
    operatorName: '小李',
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 0, [], '甲店')
assert.strictEqual(namedShop.shopName, '甲店')
assert.strictEqual(namedShop.operatorName, '小李')
assert.strictEqual(namedShop.operatorText, '小李')
assert.strictEqual(namedShop.operatorOpenid, undefined)
const namedShopLayout = slipImage.layoutSlip(namedShop)
const namedShopText = textsOf(namedShopLayout)
assert.ok(namedShopText.indexOf('甲店') >= 0)
assert.ok(namedShopText.indexOf('送货单') >= 0)
assert.ok(namedShopText.indexOf('经手人') >= 0)
assert.ok(namedShopText.indexOf('小李') >= 0)
assert.ok(namedShopText.indexOf('oxxxxxxxxxxxxxxxxxx') < 0)
const shopTitle = namedShopLayout.commands.find(function (item) {
  return item.type === 'text' && item.text === '甲店'
})
const slipTitle = namedShopLayout.commands.find(function (item) {
  return item.type === 'text' && item.text === '送货单'
})
assert.strictEqual(shopTitle.font, slipImage.FONT.title)
assert.strictEqual(slipTitle.font, slipImage.FONT.head)
const defaultTitle = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '送货单'
})
assert.strictEqual(defaultTitle.font, slipImage.FONT.title)

const emptyOperator = util.withSlipView({
  id: 'order-empty-op',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  payType: 'cash',
  records: [{
    id: 'r-empty-op',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 0)
assert.strictEqual(emptyOperator.shopName, '')
assert.strictEqual(emptyOperator.operatorText, '—')
assert.ok(textsOf(slipImage.layoutSlip(emptyOperator)).indexOf('—') >= 0)

console.log('slip-image tests passed')
