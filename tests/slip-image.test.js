const assert = require('assert')
const inv = require('../utils/inventory')
const util = require('../utils/util')
const slipImage = require('../utils/slip-image')

// 2b-2b 删掉了 util.withSlipViewFromRecord：生产上「截断到某张老单据时刻的
// 欠款」唯一的算法在服务端 getSlip，客户端拿不到流水全集。这里搬进本地的是
// 同一份口径，下面的送货单渲染断言一个都不改。
function slipFromRecord(records, record, products, shopName) {
  if (!record || record.type !== 'out') {
    throw new Error('不是销售流水')
  }
  const list = records || []
  const missing = record.customerId && !list.some(function (item) {
    return item.id === record.id
  })
  if (missing) {
    throw new Error('流水不完整，无法算欠款')
  }
  return util.withSlipView(
    record,
    inv.receivableAt(list, record.customerId, record.createdAt),
    products,
    shopName
  )
}

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
    dueText: '118.00',
    paidText: '0.00',
    remark: '门口放',
    hasCustomer: true,
    customerName: '张三超市',
    customerPhone: '13800138000',
    customerAddress: '建设路12号',
    isCredit: true,
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
assert.strictEqual(layout.width, 1700)
assert.ok(layout.height > 400)
// 竖版：高比宽大，手机预览时上下黑边才压得住
assert.ok(layout.height > layout.width)
// 最小高度托底，内容不够高就补白
assert.ok(layout.height >= Math.round(layout.width * 1.15))
assert.ok(layout.contentHeight <= layout.height)
assert.ok(text.indexOf('请核对后签收') < 0)
assert.ok(text.indexOf('SH20260815-AB12') >= 0)
assert.ok(text.indexOf('张三超市') >= 0)
assert.ok(text.indexOf('黑色') >= 0)
assert.ok(text.indexOf('TS-005') >= 0)
// 结算方式不再单独写：应收/实收两个数已经说明是赊账还是现结
assert.ok(text.indexOf('赊账') < 0)
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
// 合计和结算并成一块：总数 / 应收 / 实收
assert.ok(text.indexOf('总数') >= 0)
assert.ok(text.indexOf('应收') >= 0)
assert.ok(text.indexOf('实收') >= 0)
assert.ok(text.indexOf('合计') < 0)
assert.ok(text.indexOf('结算方式') < 0)
const totalLabel = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '总数'
})
const amountLabel = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '应收'
})
const qtyHead = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '数量'
})
const nameHead = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '品名'
})
// 合计搬出表格：不再挤在数量列旁边受列宽约束
assert.strictEqual(totalLabel.align, 'left')
assert.strictEqual(amountLabel.align, 'left')
assert.ok(totalLabel.x < nameHead.x)
assert.ok(totalLabel.y > qtyHead.y)
assert.ok(amountLabel.x > totalLabel.x)
// 签收区去掉，欠款三项并成一行小字
assert.ok(text.indexOf('客户签收') < 0)
assert.ok(text.indexOf('之前欠款') >= 0)
assert.ok(text.indexOf('本次欠款') >= 0)
assert.ok(text.indexOf('累计欠款') >= 0)
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
  paidText: '118.00',
  isCredit: false,
  remark: ''
}))
const walkinText = textsOf(walkin)
assert.ok(walkinText.indexOf('收货人') < 0)
assert.ok(walkinText.indexOf('累计欠款') < 0)
assert.ok(walkinText.indexOf('之前欠款') < 0)
assert.ok(walkinText.indexOf('实收') >= 0)
assert.ok(walkinText.indexOf('经手人') >= 0)
// 有最小高度托底后两张图可能一样高，比内容高度才看得出差别
assert.ok(walkin.contentHeight < layout.contentHeight)

const many = slipImage.layoutSlip(sampleSlip({
  lines: [
    { id: 'a', productName: '纯牛奶 250ml', specText: '', qtyText: '6', priceText: '4.50', amountText: '27.00' },
    { id: 'b', productName: '全麦面包', specText: '', qtyText: '2', priceText: '9.90', amountText: '19.80' },
    { id: 'c', productName: '短袖 T恤', specText: '白色 · L', qtyText: '1', priceText: '59.00', amountText: '59.00' }
  ]
}))
assert.ok(many.contentHeight > layout.contentHeight)

const fromOrder = util.withSlipView({
  id: 'order-1',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  paidAmount: 0,
  remark: '',
  customerName: '李记便利',
  customerPhone: '13900139000',
  customerAddress: '中山街88号',
  lines: [{
    lineId: 'r1',
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
// 四轴超过上限：并成一列「规格」，轴名不再各占一个表头，值用 · 串起来
const mixedText = textsOf(slipImage.layoutSlip(sampleSlip({ lines: mixedLines })))
assert.ok(mixedText.indexOf('规格') >= 0)
assert.ok(mixedText.indexOf('颜色') < 0)
assert.ok(mixedText.indexOf('克数') < 0)
assert.ok(mixedText.indexOf('原味') >= 0)
assert.ok(mixedText.indexOf('白色') >= 0)

const named = util.withSlipView({
  id: 'order-named',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 118,
  paidAmount: 0,
  customerName: '李记便利',
  lines: [{
    lineId: 'r-tee',
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
  paidAmount: 9,
  lines: [{
    lineId: 'r-blank',
    productName: '纯牛奶 250ml',
    qty: 2,
    unitPrice: 4.5,
    amount: 9,
    createdAt: new Date('2026-08-15T12:00:00').getTime()
  }]
}, 0)
assert.strictEqual(blankSku.lines[0].sku, '')
assert.ok(textsOf(slipImage.layoutSlip(blankSku)).indexOf('未填') < 0)

// 补打送货单：欠款一律按当前流水、按单据时间截断重算（不存冻结快照，见 2a 审计 B1）
const reprintRecords = [
  {
    id: 'pay-1',
    type: 'pay',
    customerId: 'c1',
    amount: 18.9,
    createdAt: 2000,
    lines: []
  },
  {
    id: 'order-1',
    type: 'out',
    amount: 18.9,
    payType: 'credit',
    customerId: 'c1',
    customerName: '李记便利',
    createdAt: 1000,
    lines: [
      { lineId: 'r-a', productName: '纯牛奶 250ml', qty: 2, unitPrice: 4.5, amount: 9 },
      { lineId: 'r-b', productName: '全麦面包', qty: 1, unitPrice: 9.9, amount: 9.9 }
    ]
  }
]
const reprint = slipFromRecord(reprintRecords, reprintRecords[1])
assert.strictEqual(reprint.lines.length, 2)
assert.strictEqual(reprint.lines[0].productName, '纯牛奶 250ml')
assert.strictEqual(reprint.dueText, '18.90')
assert.strictEqual(reprint.paidText, '0.00')
assert.strictEqual(reprint.thisDebtText, '18.90')
assert.strictEqual(reprint.prevDebtText, '0.00')
assert.strictEqual(reprint.receivableText, '18.90')

// 流水不完整就报错，不能拿残缺数据算欠款印在单据上
assert.throws(function () {
  slipFromRecord([], reprintRecords[1])
}, /不完整/)

assert.throws(function () {
  slipFromRecord(reprintRecords, reprintRecords[0])
}, /销售/)

const openingThenSale = [
  {
    id: 'open-1',
    type: 'opening',
    customerId: 'c1',
    amount: 50,
    createdAt: 500,
    lines: []
  },
  {
    id: 'r-open-sale',
    type: 'out',
    amount: 9,
    payType: 'credit',
    customerId: 'c1',
    customerName: '李记便利',
    createdAt: 1000,
    lines: [
      { lineId: 'r-open-sale-l1', productName: '纯牛奶 250ml', qty: 2, unitPrice: 4.5, amount: 9 }
    ]
  }
]
const openingSlip = slipFromRecord(openingThenSale, openingThenSale[1])
assert.strictEqual(openingSlip.prevDebtText, '50.00')
assert.strictEqual(openingSlip.thisDebtText, '9.00')
assert.strictEqual(openingSlip.receivableText, '59.00')

const namedShop = util.withSlipView({
  id: 'order-shop',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  paidAmount: 9,
  operatorOpenid: 'oxxxxxxxxxxxxxxxxxx',
  operatorName: '小李',
  lines: [{
    lineId: 'r-shop',
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
// 抬头只留店名，不再叠一行「送货单」
assert.ok(namedShopText.indexOf('送货单') < 0)
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
assert.strictEqual(slipTitle, undefined)
// 没填店名才用「送货单」兜底，同样走大标题字号
const defaultTitle = layout.commands.find(function (item) {
  return item.type === 'text' && item.text === '送货单'
})
assert.strictEqual(defaultTitle.font, slipImage.FONT.title)

const emptyOperator = util.withSlipView({
  id: 'order-empty-op',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 9,
  paidAmount: 9,
  lines: [{
    lineId: 'r-empty-op',
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

// 列宽按本单内容量出来，不再写死：货号长的单子货号列就宽些
function headX(layout, title) {
  return layout.commands.find(function (item) {
    return item.type === 'text' && item.text === title
  }).x
}
const shortSku = slipImage.layoutSlip(sampleSlip())
const longSku = slipImage.layoutSlip(sampleSlip({
  lines: [Object.assign({}, sampleSlip().lines[0], { sku: 'TS-005-EXTRA-LONG-CODE' })]
}))
// 货号列量出来更宽，把它右边的品名列整体右推；左边的序号列不受影响
assert.ok(headX(longSku, '品名') > headX(shortSku, '品名'))
assert.strictEqual(headX(longSku, '序号'), headX(shortSku, '序号'))

// 规格轴多到折行也救不回来时，画布变宽保信息完整，不缩字号
const fourAxes = slipImage.layoutSlip(sampleSlip({
  lines: [{
    id: 'l1',
    productName: '薯片',
    specParts: [
      { name: '颜色', value: '藏青色' },
      { name: '尺码', value: 'XXL' },
      { name: '口味', value: '原味' },
      { name: '克数', value: '200g' }
    ],
    sku: 'MK-001',
    qtyText: '2',
    priceText: '59.00',
    amountText: '118.00'
  }]
}))
assert.ok(fourAxes.width > 1550)
assert.strictEqual(slipImage.FONT.num, '56px sans-serif')

// 最小高度可调，调大只补白不动内容
const tall = slipImage.layoutSlip(sampleSlip(), null, { minHeightRatio: 2.16 })
assert.strictEqual(tall.width, shortSku.width)
assert.strictEqual(tall.contentHeight, shortSku.contentHeight)
assert.ok(tall.height > shortSku.height)
assert.strictEqual(tall.height, Math.round(tall.width * 2.16))

// 部分付款：送货单的应收 / 实收 / 本次欠款要能表达「收了一半」。
const partialSlip = util.withSlipView({
  id: 'order-partial-slip',
  type: 'out',
  createdAt: 1000,
  amount: 118,
  paidAmount: 50,
  customerId: 'c-partial',
  customerName: '半款客户',
  lines: [{ lineId: 'r-partial-slip', productName: '短袖 T恤', qty: 2, unitPrice: 59, amount: 118 }]
}, 68)
assert.strictEqual(partialSlip.dueText, '118.00')
assert.strictEqual(partialSlip.paidText, '50.00')
assert.strictEqual(partialSlip.thisDebtText, '68.00')
assert.strictEqual(partialSlip.isCredit, true)
const partialSlipText = textsOf(slipImage.layoutSlip(partialSlip))
assert.ok(partialSlipText.indexOf('应收') >= 0)
assert.ok(partialSlipText.indexOf('实收') >= 0)

console.log('slip-image tests passed')
