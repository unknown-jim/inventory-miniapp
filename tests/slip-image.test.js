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
assert.ok(text.indexOf('序号') < 0)
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

// detail ≡ 默认态的钉子：sampleSlip 只有 1 行，节内行数不满足矩阵条件 2，'summary' 态本就
// 退回平铺，所以两态必须逐字相同。这条钉的是「detail 不会走出一条自己的路」。
//
// 它**不能**顺带证明「默认态 ≡ 改动前」：上面那批老断言是 indexOf 之类的内容检查，钉不住
// 逐字节。那条性质靠的是评审期把 baseline 的 utils/slip-image.js 单独加载成对照模块、
// 比 JSON.stringify(layout)（三轮审计各自独立验过一次，老形态夹具全部逐字节相等）。
// 仓库里留不住 baseline 模块，所以这条只能是评审期证据，不是常驻钉子。
assert.deepStrictEqual(layout, slipImage.layoutSlip(slip, null, { exportStyle: 'detail' }))

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
// 货号列量出来更宽，居中表头会右移，并把它右边的品名列整体右推
assert.ok(headX(longSku, '货号') > headX(shortSku, '货号'))
assert.ok(headX(longSku, '品名') > headX(shortSku, '品名'))

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

assert.strictEqual(slipImage.dataUrlPayload('data:image/png;base64,abc'), 'abc')
assert.strictEqual(slipImage.dataUrlPayload('nope'), '')

const hiDpr = slipImage.exportScales(1700, 1955, 3)
assert.strictEqual(hiDpr.length, 3)
assert.strictEqual(hiDpr[0], 3)
assert.strictEqual(hiDpr[1], 1)
assert.ok(hiDpr[2] < 1)
assert.ok(Math.ceil(1955 * hiDpr[2]) <= slipImage.CANVAS_2D_SAFE_PX)
assert.ok(Math.ceil(1700 * hiDpr[2]) <= slipImage.CANVAS_2D_SAFE_PX)

const loDpr = slipImage.exportScales(1700, 1955, 1)
assert.strictEqual(loDpr.length, 2)
assert.strictEqual(loDpr[0], 1)
assert.ok(loDpr[1] < 1)

const small = slipImage.exportScales(1000, 1000, 3)
assert.deepStrictEqual(small, [3, 1])

// ---------------------------------------------------------------------------
// 批 1：送货单导出「汇总/明细」两态。上面所有断言一条都没改——按 1.3 的矩阵化判定，
// 前面用到的夹具（sampleSlip 1 行、many 三个不同商品各 1 行、mixedLines 两个不同商品
// 各 1 行）每节都只有 1 行，条件 2「该节行数 ≥ 2」先就不满足，一律退回平铺，所以默认
// exportStyle: 'summary' 不会改变它们任何一条结果。
// ---------------------------------------------------------------------------

function specLine(overrides) {
  return Object.assign({
    id: 'l',
    productName: '短袖 T恤',
    sku: 'TS-005',
    qtyText: '1',
    priceText: '59.00',
    amountText: '59.00'
  }, overrides || {})
}

// 按 颜色 × 尺码 铺满一个货号的矩阵夹具；skip(color, size) 返回 true 的组合不生成（缺货）。
function gridLines(colors, sizes, skip, unitPrice) {
  const price = unitPrice == null ? 59 : unitPrice
  const lines = []
  let n = 1
  colors.forEach(function (color) {
    sizes.forEach(function (size) {
      if (skip && skip(color, size)) return
      const qty = n++
      lines.push(specLine({
        id: color + '-' + size,
        specParts: [{ name: '颜色', value: color }, { name: '尺码', value: size }],
        qtyText: String(qty),
        priceText: price.toFixed(2),
        amountText: (qty * price).toFixed(2)
      }))
    })
  })
  return lines
}

function matrixFixtureSlip(lines, overrides) {
  // hasCustomer: false + operatorText 显式给值：避免「经手人」缺省兜底的 '—' 混进
  // 「矩阵缺格画 —」的断言里，两个 '—' 来源不一样，不能靠字符串搜索混着判。
  return sampleSlip(Object.assign({ lines: lines, hasCustomer: false, remark: '', operatorText: '小李' }, overrides || {}))
}

function textCmds(layout) {
  return layout.commands.filter(function (item) {
    return item.type === 'text'
  })
}

function hasText(layout, text) {
  return textCmds(layout).some(function (item) {
    return item.text === text
  })
}

function labelValueText(layout, label) {
  const texts = textCmds(layout)
  const index = texts.findIndex(function (item) {
    return item.text === label
  })
  return index >= 0 ? texts[index + 1].text : undefined
}

// 1) 分节函数：A、B、A 三行 -> 两节，第一节 2 行（顺序不变，不连续的同货号行仍归一节）
const sliced = slipImage.sliceLineSections([
  specLine({ id: 'a1', productName: 'A商品', sku: 'A1' }),
  specLine({ id: 'b1', productName: 'B商品', sku: 'B1' }),
  specLine({ id: 'a2', productName: 'A商品', sku: 'A1' })
])
assert.strictEqual(sliced.length, 2)
assert.strictEqual(sliced[0].lines.length, 2)
assert.strictEqual(sliced[0].lines[0].id, 'a1')
assert.strictEqual(sliced[0].lines[1].id, 'a2')
assert.strictEqual(sliced[1].lines.length, 1)
assert.strictEqual(sliced[1].lines[0].id, 'b1')

// 2) 矩阵路径：3 色 × 3 码卖 8 格（缺 1 格）。R=3、N=8，2+3=5<8，有压缩收益，矩阵成立。
const matrixLines = gridLines(['黑色', '白色', '蓝色'], ['S', 'M', 'L'], function (color, size) {
  return color === '蓝色' && size === 'L'
})
const matrixSlip = matrixFixtureSlip(matrixLines)
const matrixLayout = slipImage.layoutSlip(matrixSlip)
assert.ok(hasText(matrixLayout, '颜色')) // 行轴名
;['S', 'M', 'L'].forEach(function (size) {
  assert.ok(hasText(matrixLayout, size)) // 列轴各取值
})
assert.ok(hasText(matrixLayout, '小计'))
assert.ok(hasText(matrixLayout, '—')) // 缺的那格（蓝色 × L）画 —，不留空白

// 3) 同一份数据 exportStyle: 'detail' -> 没有「小计」、没有「—」、行数回到 8。
// exportStyle 不是 'summary' 时分节/矩阵判定整段都不跑（见 layoutSlip），直接复用未改动
// 过的 tableColumns/fitColumns/layoutTable——用两个结构特征证明这一点，而不是「碰巧长得
// 像」：轴仍分列（颜色、尺码不合并）、全表只有一份表头（「货号」只出现一次，证明没有像
// 矩阵路径那样按节反复画表头）。
const detailLayout = slipImage.layoutSlip(matrixSlip, null, { exportStyle: 'detail' })
assert.ok(!hasText(detailLayout, '小计'))
assert.ok(!hasText(detailLayout, '—'))
const detailSkuCells = textCmds(detailLayout).filter(function (item) {
  return item.text === 'TS-005'
})
assert.strictEqual(detailSkuCells.length, matrixLines.length)
assert.ok(hasText(detailLayout, '颜色'))
assert.ok(hasText(detailLayout, '尺码'))
const detailHeadCount = textCmds(detailLayout).filter(function (item) {
  return item.text === '货号'
}).length
assert.strictEqual(detailHeadCount, 1)

// 4) 两种形态总件数、总金额相等——底部汇总区不看表格形态，只看 slip.lines 现算。
assert.strictEqual(labelValueText(matrixLayout, '总数'), labelValueText(detailLayout, '总数'))
assert.strictEqual(labelValueText(matrixLayout, '应收'), labelValueText(detailLayout, '应收'))
assert.strictEqual(labelValueText(matrixLayout, '实收'), labelValueText(detailLayout, '实收'))

// 5) 逐条覆盖矩阵化的否决条件。
//
// 【2026-09-03 修】判据换成**翻转测试**：把这条夹具声称在测的那个条件改坏（让它不再
// return null），这条夹具必须从「平铺」翻成「矩阵化」。改坏了还是平铺，说明另有否决路径
// 也在拦它，这条夹具就没测到它声称测的东西。
// 改动前这里 7 条里有 5 条翻不动——夹具只有 1~2 行，全部栽在条件 6（2 + R < N，少于 4 行
// 的节一律否决）上，注释写的「每条只差这一条」不成立。下面的夹具逐条实测过翻转。
//
// 翻转测试的实测结果（2026-09-03，在 bf4c016 + 本次改动上跑；跑法见报告）：
//   单价不一致    改坏条件4(sectionPriceText 恒返回首行单价) -> 翻转 ✅
//   轴数为1       改坏条件3(lineAxisPair 允许 1 根轴)        -> 翻转 ✅
//   轴数为3       改坏条件3(lineAxisPair 只取前两根轴)       -> 翻转 ✅
//   节内轴名不一致 改坏条件3(sectionAxisPair 不比对轴名)      -> 翻转 ✅
//   列轴7个取值   改坏条件5(MATRIX_COL_LIMIT 调大)          -> 翻转 ✅
//   无压缩收益    改坏条件6(去掉压缩收益判定)                -> 翻转 ✅
//   只有1行       改坏条件2(去掉行数判定)                    -> **翻不动** ❌
// 「只有1行」翻不动是条件本身的性质，不是夹具没造好：条件 6 要求 2 + R < N，R ≥ 1 时
// N ≥ 4，行数少于 4 一律否决，所以条件 2 被条件 6 完全吞掉、删掉它结果不变（死条件）。
// 那一条保留为**行为钉子**，不再声称它隔离了条件 2。
//
// 另外给每条配一个**对照组**：把被测的那一条改回满足、其余原样，同一份夹具必须真的
// 矩阵化。对照组是常驻的防空转保证——翻转测试是一次性的手工验证，对照组每次跑测试都在。
function assertFlatFallback(lines, label) {
  const layout = slipImage.layoutSlip(matrixFixtureSlip(lines))
  assert.ok(!hasText(layout, '小计'), label + '：不该有矩阵小计')
  assert.ok(!hasText(layout, '—'), label + '：不该有矩阵缺格占位')
}
function assertMatrixed(lines, label) {
  const layout = slipImage.layoutSlip(matrixFixtureSlip(lines))
  assert.ok(hasText(layout, '小计'), label + '：对照组必须真的矩阵化，否则上面那条否决断言是空转的')
}

// 条件 2（节行数 ≥ 2）：只有 1 行。翻不动，见上面的说明——这条钉行为，不钉条件。
assertFlatFallback([
  specLine({ specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] })
], '只有1行')

// 条件 4（节内单价逐字相同）：2 色 × 3 码共 6 行，只有最后一行单价不同。
// R=2、N=6，2+2=4<6，条件 6 满足；对照组 = 同样 6 行、单价全一致。
const priceControlLines = gridLines(['黑色', '白色'], ['S', 'M', 'L'])
const priceMismatchLines = priceControlLines.slice(0, 5).concat([
  Object.assign({}, priceControlLines[5], { priceText: '65.00', amountText: '390.00' })
])
assertFlatFallback(priceMismatchLines, '单价不一致')
assertMatrixed(priceControlLines, '单价不一致-对照组')

// 条件 3 之一（轴恰好 2 根）：只有 1 根轴。
// 6 行、3 个颜色各 2 行——这样 R=3、N=6，2+3=5<6，条件 6 才不会抢在前面否决；
// 用 2 行 2 色（改动前那样）时条件 6 也会拦，翻转测试翻不动。
const oneAxisLines = ['黑色', '白色', '蓝色'].reduce(function (list, color, ci) {
  return list.concat([0, 1].map(function (k) {
    const qty = ci * 2 + k + 1
    return specLine({
      id: 'q' + ci + '-' + k,
      specParts: [{ name: '颜色', value: color }],
      qtyText: String(qty),
      amountText: (qty * 59).toFixed(2)
    })
  }))
}, [])
assertFlatFallback(oneAxisLines, '轴数为1')

// 条件 3 之二：轴数为 3。2 色 × 3 码共 6 行，每行多一根恒定的「季节」轴；
// 对照组 = 同样 6 行、去掉第三根轴。
const threeAxisLines = gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, {
    specParts: line.specParts.concat([{ name: '季节', value: '夏' }])
  })
})
assertFlatFallback(threeAxisLines, '轴数为3')
assertMatrixed(gridLines(['黑色', '白色'], ['S', 'M', 'L']), '轴数为3-对照组')

// 条件 3 之三：节内轴名不一致。5 行里最后一行把「尺码」换成「克数」。R=2、N=5，2+2=4<5。
const axisPairControlLines = [
  specLine({ id: 's1', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }], qtyText: '1', amountText: '59.00' }),
  specLine({ id: 's2', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }], qtyText: '2', amountText: '118.00' }),
  specLine({ id: 's3', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'L' }], qtyText: '3', amountText: '177.00' }),
  specLine({ id: 's4', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'S' }], qtyText: '4', amountText: '236.00' }),
  specLine({ id: 's5', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'M' }], qtyText: '5', amountText: '295.00' })
]
const axisMismatchLines = axisPairControlLines.slice(0, 4).concat([
  Object.assign({}, axisPairControlLines[4], {
    specParts: [{ name: '颜色', value: '白色' }, { name: '克数', value: '50g' }]
  })
])
assertFlatFallback(axisMismatchLines, '节内轴名不一致')
assertMatrixed(axisPairControlLines, '节内轴名不一致-对照组')

// 条件 5（列轴去重取值 ≤ MATRIX_COL_LIMIT=6）：7 个尺码，R=1、N=7，2+1=3<7。
// 这条原本就有 7 行，翻转测试本来就过；对照组 = 砍到 6 个尺码。
const sizeList = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL']
function sizeOnlyLines(sizes) {
  return sizes.map(function (size, index) {
    return specLine({
      id: 'sz' + index,
      specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: size }],
      qtyText: String(index + 1),
      amountText: ((index + 1) * 59).toFixed(2)
    })
  })
}
assertFlatFallback(sizeOnlyLines(sizeList), '列轴7个取值')
assertMatrixed(sizeOnlyLines(sizeList.slice(0, 6)), '列轴7个取值-对照组')

// 条件 6（有压缩收益）：2 色 × 2 码卖 3 格，R=2、N=3，2+2=4 不小于 3。
// 对照组 = 再卖两格（5 行），2+2=4<5。
assertFlatFallback([
  specLine({ id: 't1', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }] }),
  specLine({ id: 't2', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] }),
  specLine({ id: 't3', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'S' }] })
], '无压缩收益')
assertMatrixed(axisPairControlLines, '无压缩收益-对照组')

// 6) 混排：A 货号满足矩阵，B 货号单价不一致退回平铺，两者出现在同一张单里互不干扰。
const mixedMatrixLines = gridLines(['黑色', '白色'], ['S', 'M', 'L']) // 2 色 × 3 码全卖，R=2、N=6，矩阵成立
const mixedFlatLines = [
  specLine({ id: 'bb1', productName: '绿茶', sku: 'GT-1', specParts: [{ name: '口味', value: '原味' }, { name: '克数', value: '50g' }], qtyText: '2', priceText: '20.00', amountText: '40.00' }),
  specLine({ id: 'bb2', productName: '绿茶', sku: 'GT-1', specParts: [{ name: '口味', value: '原味' }, { name: '克数', value: '100g' }], qtyText: '1', priceText: '25.00', amountText: '25.00' })
]
const mixedLayoutBatch1 = slipImage.layoutSlip(matrixFixtureSlip(mixedMatrixLines.concat(mixedFlatLines)))
assert.ok(hasText(mixedLayoutBatch1, '小计')) // A 节矩阵化
const teaNameCells = textCmds(mixedLayoutBatch1).filter(function (item) {
  return item.text === '绿茶'
})
assert.strictEqual(teaNameCells.length, mixedFlatLines.length) // B 节仍逐行列出品名，没被矩阵合并

// 7) 货号为空的节：节头只画品名，不出现「未填」（与 blankSku 那条老断言同款要求）
const blankSkuMatrixLines = gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, { sku: '未填' })
})
const blankSkuMatrixLayout = slipImage.layoutSlip(matrixFixtureSlip(blankSkuMatrixLines))
const blankSkuMatrixText = textsOf(blankSkuMatrixLayout)
assert.ok(blankSkuMatrixText.indexOf('未填') < 0)
assert.ok(blankSkuMatrixText.indexOf('短袖 T恤') >= 0)

// 8) R1（2026-09-02）新增条件 7：矩阵化不得让画布比平铺更宽。用列轴取值的字数控制矩阵节
// 会把画布撑多宽——原来这里只有一条「6 列 × 4 字」的越界钉子（3 色 × 6 码，每个取值 4 个
// 中文字，曾经会把「小计」整列画到画布外）；R1 之后这个组合不再矩阵化、直接退回平铺，
// 越界也就无从谈起，所以拆成三条：
//   8a) 6 列 × 3 字：撑不过平铺基准（1700），矩阵化仍然成立——越界钉子的原有价值留在
//       这条组合上：断言矩阵路径没有任何绘制指令画到画布右边界外。
//   8b) 6 列 × 4 字：会把画布撑宽（方案 R1 实测到 2009），条件 7 生效，退回平铺。
//   8c) 6 列 × 13 字：病态用例，撑得更宽（方案 R1 实测到 4733），同样退回平铺。
// 断言越界必须真的抓住越界，不能写成恒真：align:'right' 的指令 x 本身就是右边界，
// align:'center' 要把文字宽度折算成右边界，align:'left'（含 rect/stroke/line）按左边+宽度算。
function nCharSizes(n, charCount) {
  const digits = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  const list = []
  for (let i = 0; i < n; i++) list.push(digits[i] + '码'.repeat(charCount - 1))
  return list
}
function rightEdgeOf(cmd, measure) {
  if (cmd.type === 'text') {
    const w = measure(cmd.text, cmd.font)
    if (cmd.align === 'right') return cmd.x
    if (cmd.align === 'center') return cmd.x + w / 2
    return cmd.x + w
  }
  if (cmd.type === 'rect' || cmd.type === 'stroke') return cmd.x + cmd.w
  if (cmd.type === 'line') return Math.max(cmd.x1, cmd.x2)
  return 0
}

// 8a) 6 列 × 3 字：矩阵化仍成立，画布不撑宽。
const col3Lines = gridLines(['黑色', '白色', '蓝色'], nCharSizes(6, 3))
const col3Layout = slipImage.layoutSlip(matrixFixtureSlip(col3Lines))
assert.ok(hasText(col3Layout, '小计'), '6列×3字应仍矩阵化')
assert.strictEqual(col3Layout.width, 1700, '6列×3字不该撑宽画布')
const col3Offenders = col3Layout.commands.filter(function (cmd) {
  return rightEdgeOf(cmd, slipImage.estimateWidth) > col3Layout.width + 0.5
})
assert.deepStrictEqual(col3Offenders, [], '矩阵节有指令画到画布右边界外: ' + JSON.stringify(col3Offenders))

// 8b) 6 列 × 4 字：条件 7 生效，退回平铺——没有「小计」，画布回落到平铺基准 1700。
const col4Lines = gridLines(['黑色', '白色', '蓝色'], nCharSizes(6, 4))
const col4Layout = slipImage.layoutSlip(matrixFixtureSlip(col4Lines))
assert.ok(!hasText(col4Layout, '小计'), '6列×4字撑宽画布，应退回平铺')
assert.strictEqual(col4Layout.width, 1700, '退回平铺后画布应回落到平铺基准')

// 8c) 病态用例：6 列 × 13 字，撑宽程度更严重，同样退回平铺。
const col13Lines = gridLines(['黑色', '白色', '蓝色'], nCharSizes(6, 13))
const col13Layout = slipImage.layoutSlip(matrixFixtureSlip(col13Lines))
assert.ok(!hasText(col13Layout, '小计'), '6列×13字应退回平铺')
assert.strictEqual(col13Layout.width, 1700, '6列×13字退回平铺后画布应回落到平铺基准')

// 9) 本质不变量（R1 明确要求）：汇总态画布永远不比明细态更宽。挑几组已经构造好的矩阵/混排
// 夹具一起过一遍——这条比逐个阈值断言都硬，不管矩阵内部算法怎么变，只要哪天矩阵化又把
// 画布撑宽，这条会先红，不用等具体阈值断言凑巧覆盖到那个组合。
;[
  matrixSlip,
  matrixFixtureSlip(col3Lines),
  matrixFixtureSlip(col4Lines),
  matrixFixtureSlip(col13Lines),
  matrixFixtureSlip(mixedMatrixLines.concat(mixedFlatLines))
].forEach(function (fixtureSlip, index) {
  const summaryWidth = slipImage.layoutSlip(fixtureSlip).width
  const detailWidth = slipImage.layoutSlip(fixtureSlip, null, { exportStyle: 'detail' }).width
  assert.ok(
    summaryWidth <= detailWidth,
    '不变量钉子第' + index + '组: summary(' + summaryWidth + ') > detail(' + detailWidth + ')'
  )
})

// ---------------------------------------------------------------------------
// 批 3（2026-09-02）：清空前两批留下的非阻塞项。
// ---------------------------------------------------------------------------

// 10) 【最要紧】分节路径下的平铺节要复用整表的列定义，不能各节自己算——整表轴数超过
//     SPEC_AXIS_LIMIT 时会把规格并成一列，某个平铺节自己轴数少，per-section 算法会拆回
//     两列，比整表口径宽出一截；单行金额位数多时，这一截差值会把内容画到画布右边界外，
//     画布完整、内容静默消失。这条钉子直接复现该失效形态：矩阵节（服装）+ 平铺节（钢材，
//     自己只有 2 轴、整表 4 轴）+ 9 位数金额撑窄可用宽度，断言没有任何绘制指令画到画布外。
const overflowMatrixLines = gridLines(['黑色', '白色'], ['S', 'M', 'L'])
const overflowFlatLines = [
  specLine({
    id: 'steel-1',
    productName: '钢材钢材钢材钢材钢材',
    sku: 'ST-00000001',
    specParts: [{ name: '材质', value: '碳钢A型号' }, { name: '规格', value: '6.0毫米规格' }],
    qtyText: '123456',
    priceText: '123456789.00',
    amountText: '123456789123.00'
  }),
  specLine({
    id: 'steel-2',
    productName: '钢材钢材钢材钢材钢材',
    sku: 'ST-00000001',
    specParts: [{ name: '材质', value: '碳钢A型号' }, { name: '规格', value: '8.0毫米规格' }],
    qtyText: '654321',
    priceText: '987654321.00',
    amountText: '987654321987.00'
  })
]
const overflowLayout = slipImage.layoutSlip(matrixFixtureSlip(overflowMatrixLines.concat(overflowFlatLines)))
assert.ok(hasText(overflowLayout, '小计'), '服装节应仍矩阵化')
const overflowOffenders = overflowLayout.commands.filter(function (cmd) {
  return rightEdgeOf(cmd, slipImage.estimateWidth) > overflowLayout.width + 0.5
})
assert.deepStrictEqual(overflowOffenders, [], '平铺节复用整表列宽后不该再有指令画到画布右边界外: ' + JSON.stringify(overflowOffenders))

// 11) 相邻的平铺节要合并成一次 layoutTable，只共用一次表头。两个都是「货号」表头的独立商品
//     （各自都因为行数不足 2 退回平铺），紧挨着排在一个矩阵节之前——合并后表头只出现一次。
function singleLineFlat(id, productName, sku) {
  return specLine({ id: id, productName: productName, sku: sku, qtyText: '1' })
}
const mergeFlatFirst = [singleLineFlat('mf-a', 'AA商品', 'AA1')]
const mergeFlatSecond = [singleLineFlat('mf-b', 'BB商品', 'BB1')]
const mergeMatrixThird = gridLines(['红色', '蓝色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, { productName: 'CC商品', sku: 'CC1' })
})
const mergedLayout = slipImage.layoutSlip(matrixFixtureSlip(
  mergeFlatFirst.concat(mergeFlatSecond).concat(mergeMatrixThird)
))
const mergedHeadCount = textCmds(mergedLayout).filter(function (item) {
  return item.text === '货号'
}).length
assert.strictEqual(mergedHeadCount, 1, '两个连续的平铺节应合并成一次 layoutTable，只画一次表头')
assert.ok(hasText(mergedLayout, 'AA商品') && hasText(mergedLayout, 'BB商品'), '合并后两个商品的品名都要画出来')
assert.ok(hasText(mergedLayout, '小计'), 'CC商品节应矩阵化')

// 12) 不连续的平铺节（被矩阵节隔开）不该被并起来，各自重新画一次表头——读者需要重新对齐列义。
const splitMatrixFirst = gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, { productName: 'DD商品', sku: 'DD1' })
})
const splitFlatMiddle = [singleLineFlat('sf-a', 'EE商品', 'EE1')]
const splitMatrixSecond = gridLines(['黄色', '绿色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, { productName: 'FF商品', sku: 'FF1' })
})
const splitFlatLast = [singleLineFlat('sf-b', 'GG商品', 'GG1')]
const splitLayout = slipImage.layoutSlip(matrixFixtureSlip(
  splitMatrixFirst.concat(splitFlatMiddle).concat(splitMatrixSecond).concat(splitFlatLast)
))
const splitHeadCount = textCmds(splitLayout).filter(function (item) {
  return item.text === '货号'
}).length
assert.strictEqual(splitHeadCount, 2, '矩阵节隔开的两段平铺节不连续，各自应该重新画一次表头')
const splitSubtotalCount = textCmds(splitLayout).filter(function (item) {
  return item.text === '小计'
}).length
assert.strictEqual(splitSubtotalCount, 2, '两个矩阵节都应矩阵化成立')

// 13) 分节路径下，全表只有平铺节这个组合走不到 layoutSectionedTable（hasMatrix 恒为
//     false，直接退回批 1 之前没改过的老路径），所以这里只用它证明 flatSectionColumns 的
//     取值口径没有跑偏：矩阵节 + 单一平铺节混排时，平铺节里各列展示的值必须仍然对应
//     该节自己的行，不能因为改成读整表的列结构就串到别的行/别的节上。数字故意取跟矩阵节
//     （qty 1~6、单价 59.00）不重叠的值，货号/品名/数量/单价/金额要按序连续出现——
//     顺序连续本身就是「index 对上了自己这一行」的证据，串行读到别的行会打断这串连续。
const columnFidelityFlat = [
  specLine({ id: 'cf-1', productName: '货品甲', sku: 'JIA-1', qtyText: '777', priceText: '88.88', amountText: '68997.76' })
]
const columnFidelityMatrix = gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, { productName: '货品乙', sku: 'YI-1' })
})
const columnFidelityLayout = slipImage.layoutSlip(matrixFixtureSlip(columnFidelityMatrix.concat(columnFidelityFlat)))
const columnFidelityTexts = textCmds(columnFidelityLayout).map(function (item) {
  return item.text
})
const skuIndex = columnFidelityTexts.indexOf('JIA-1')
assert.ok(skuIndex >= 0, '平铺节的货号应画出来')
// 这一行没有 specParts，规格列（不管合没合并成一列）取值都是空串，wrapCell 对空串直接
// 不产出文字指令——所以货号后面下一个有内容的列就是数量，紧跟着单价、金额。
assert.deepStrictEqual(
  columnFidelityTexts.slice(skuIndex, skuIndex + 5),
  ['JIA-1', '货品甲', '777', '88.88', '68997.76'],
  '平铺节这一行的货号/品名/数量/单价/金额应按列序连续出现，串到别的行会打断这个序列'
)

// 14) 同一 (行,列) 组合出现多行时格内要累加，不能被后写的行覆盖先写的——覆盖会导致
//     「可见格之和 ≠ 行小计」，这种算不平的错在单据上代价很高。(黑色,S) 故意给两行
//     （件数 2 和 3），断言：格内显示两行之和 5，且行小计、节尾小计都能对上。
const dupCellLines = [
  specLine({ id: 'dup-a', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }], qtyText: '2' }),
  specLine({ id: 'dup-b', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }], qtyText: '3' }),
  specLine({ id: 'dup-c', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }], qtyText: '4' }),
  specLine({ id: 'dup-d', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'S' }], qtyText: '1' }),
  specLine({ id: 'dup-e', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'M' }], qtyText: '6' })
]
const dupLayout = slipImage.layoutSlip(matrixFixtureSlip(dupCellLines))
assert.ok(hasText(dupLayout, '小计'), '矩阵仍应成立（2+2=4 < 5，有压缩收益）')
assert.ok(hasText(dupLayout, '5'), '(黑色,S) 两行应合并显示为两行之和 5')
assert.ok(!hasText(dupLayout, '3'), '格内不该只显示后写行的 3，应合并显示为两行之和')
assert.ok(hasText(dupLayout, '9'), '黑色行小计应为 2+3+4=9')
assert.ok(hasText(dupLayout, '7'), '白色行小计应为 1+6=7')
assert.ok(hasText(dupLayout, '小计 16 件'), '节尾小计应为全部行之和 2+3+4+1+6=16')

// 15) 分节 key 的分隔符一直是 U+0000，U+0000 在源码里要写成转义形式，不要写裸字节
//     （运行时等价，但从此可见、可 grep——裸字节曾让 grep 把整个 slip-image.js 当二进制）。
//     这条钉子防的是有人把它退回空格：品名本身含空格时，两个不同的 (品名,货号) 组合会拼出
//     同一个字符串（'短袖 T'+'TS' 与 '短袖'+'T TS' 都拼成 '短袖 T TS'），那时才会被并成一节。
//     写清楚这一点是因为「防退化」和「修 bug」不是一回事，别让后来人以为这里修过一个真 bug。
const collisionLines = [
  specLine({ id: 'coll-a', productName: '短袖 T', sku: 'TS' }),
  specLine({ id: 'coll-b', productName: '短袖', sku: 'T TS' })
]
const collisionSections = slipImage.sliceLineSections(collisionLines)
assert.strictEqual(collisionSections.length, 2, '品名+货号拼接后撞车的两个不同商品不该被并成一节')

// ---------------------------------------------------------------------------
// 批 4（2026-09-03）：把矩阵表印出来的每一个数钉住 + 分节按商品身份 + 节头长品名不越界。
//
// 【为什么补】批 3 之前的断言只查「小计」这个**标签字符串**在不在，矩阵里印出来的数几乎
// 一个都没查。在批 3 的基线（bf4c016）上实测，下面这些改坏法**全部绿着通过**：
//   · 节尾金额 amountSumText(section.lines) -> '0.00'，或多印一位
//   · 节头单价 '¥' + matrix.priceText      -> 固定 '¥1.00'
//   · 数据行行轴取值 matrix.rowValues       -> 一律空串
//   · 格内件数 qtyTotalText(cellLines)      -> 一律 +1
// 批 3 的 14 号能抓住「覆盖 / 取第一行 / 行小计换成整节总数」，靠的是 hasText(layout, '5')
// 这种**全表找一个孤立字符串**的写法：夹具里恰好没有别的地方出现 '5'，换个夹具就抓不住，
// 而且抓住时报的是 "The expression evaluated to a falsy value"，看不出哪个数错了。
//
// 这一批用两条互相独立的路子钉：
//   A. 逐值断言——把整段矩阵文本序列（节头 / 列表头 / 每个格 / 行小计 / 节尾）按绘制顺序
//      展开，和手算的期望值 deepStrictEqual，改任何一个数都会红在具体位置上。
//   B. 算术不变量——从**实际画出来的文本**反解出矩阵，检查四层口径对得上：
//      各格之和 == 行小计、各行小计之和 == 节尾件数、节尾金额 == 节尾件数 × 节头单价、
//      各节件数之和 == 单据总数。这条不依赖手算期望值，加夹具不用改断言。
// ---------------------------------------------------------------------------

// 画布常量。slip-image.js 没导出，这里照抄——和本文件里已有的 1700 硬编码同一个待遇。
const B4_HEAD_TEXT_X = 36 + 24
const B4_LINE_H = 65

function b4Texts(layout) {
  return textCmds(layout).map(function (item) {
    return item.text
  })
}

function b4LeftEdge(cmd, measure) {
  if (cmd.type === 'text') {
    const w = measure(cmd.text, cmd.font)
    if (cmd.align === 'right') return cmd.x - w
    if (cmd.align === 'center') return cmd.x - w / 2
    return cmd.x
  }
  if (cmd.type === 'rect' || cmd.type === 'stroke') return cmd.x
  if (cmd.type === 'line') return Math.min(cmd.x1, cmd.x2)
  return 0
}

// 越界扫描：任何一条绘制指令都不许画到画布外。画布外的东西在导出图上直接不存在。
// 批 3 的 10 号钉子已经盖住「混排时平铺节各自算列」那一种形态，这里把同一条判据推到
// **全部**矩阵/混排夹具上、两态各跑一遍，免得下次换个形态又漏出去。
function b4AssertInside(layout, label) {
  const over = layout.commands.filter(function (cmd) {
    return rightEdgeOf(cmd, slipImage.estimateWidth) > layout.width + 0.5
  })
  assert.deepStrictEqual(over, [], label + '：有 ' + over.length + ' 条指令画到画布右边界('
    + layout.width + ')外 -> ' + JSON.stringify(over.slice(0, 6)))
  const under = layout.commands.filter(function (cmd) {
    return b4LeftEdge(cmd, slipImage.estimateWidth) < -0.5
  })
  assert.deepStrictEqual(under, [], label + '：有 ' + under.length + ' 条指令画到画布左边界外 -> '
    + JSON.stringify(under.slice(0, 6)))
}

// 从画出来的文本序列反解矩阵节。绘制顺序是固定的（见 layoutMatrixSection）：
//   节头品名(可能折成多行) / ¥单价 / 行轴名 + 各列取值 + 「小计」/ 每行(行轴取值 + 各格 + 行小计) / 「小计 N 件」/ ¥金额
// 从节尾往回找最近的裸「小计」定位列表头末尾，再往回找最近的「¥」定位节头单价，
// 两者之间的个数解出列数，剩下的按 (列数+2) 一行行切。
function b4MatrixSections(layout, label) {
  const texts = b4Texts(layout)
  const out = []
  texts.forEach(function (t, f) {
    const foot = /^小计 (.+) 件$/.exec(t)
    if (!foot) return
    let h = -1
    for (let i = f - 1; i >= 0; i--) {
      if (texts[i] === '小计') { h = i; break }
    }
    assert.ok(h > 0, label + '：节尾「' + t + '」前面找不到列表头的「小计」')
    let p = -1
    for (let i = h - 1; i >= 0; i--) {
      if (texts[i].charAt(0) === '¥') { p = i; break }
    }
    assert.ok(p >= 0, label + '：节尾「' + t + '」前面找不到节头单价')
    const colCount = h - p - 2
    assert.ok(colCount >= 1, label + '：解出来的列数不合法 ' + colCount)
    const stride = colCount + 2
    const body = texts.slice(h + 1, f)
    assert.strictEqual(body.length % stride, 0,
      label + '：数据区 ' + body.length + ' 条文本不是每行 ' + stride + ' 条的整数倍')
    const rows = []
    for (let i = 0; i < body.length; i += stride) {
      rows.push({
        value: body[i],
        cells: body.slice(i + 1, i + 1 + colCount),
        subtotal: body[i + 1 + colCount]
      })
    }
    out.push({
      priceText: texts[p].slice(1),
      rowAxis: texts[p + 1],
      colValues: texts.slice(p + 2, h),
      rows: rows,
      footQtyText: foot[1],
      footAmountText: String(texts[f + 1] || '').slice(1)
    })
  })
  return out
}

// 四层口径的算术不变量。缺格画的「—」不参与求和（那格没卖过）。
// priceTimesQty：这批夹具的 amountText 是不是「件数 × 单价」——gridLines 造出来的都是；
// 只给了 qtyText、amountText 用 specLine 默认值的夹具不是，那种就不查金额这一层。
function b4AssertArithmetic(layout, label, expectSectionCount, priceTimesQty) {
  const sections = b4MatrixSections(layout, label)
  assert.strictEqual(sections.length, expectSectionCount,
    label + '：矩阵节数不对，期望 ' + expectSectionCount + ' 实际 ' + sections.length)
  let slipQty = 0
  sections.forEach(function (section, si) {
    let sectionQty = 0
    section.rows.forEach(function (row) {
      const cellSum = row.cells.reduce(function (sum, cell) {
        if (cell === '—') return sum
        const n = Number(cell)
        assert.ok(isFinite(n),
          label + '：第' + si + '节「' + row.value + '」行有非数字格 ' + JSON.stringify(cell))
        return sum + n
      }, 0)
      const subtotal = Number(row.subtotal)
      assert.ok(isFinite(subtotal),
        label + '：第' + si + '节「' + row.value + '」行小计不是数字 ' + JSON.stringify(row.subtotal))
      assert.strictEqual(cellSum, subtotal,
        label + '：第' + si + '节「' + row.value + '」行各格之和 ' + cellSum + ' != 行小计 ' + subtotal
          + '（各格：' + JSON.stringify(row.cells) + '）')
      sectionQty += subtotal
    })
    const footQty = Number(section.footQtyText)
    assert.strictEqual(sectionQty, footQty,
      label + '：第' + si + '节各行小计之和 ' + sectionQty + ' != 节尾件数 ' + footQty)
    if (priceTimesQty) {
      const expectAmount = (Math.round(footQty * Number(section.priceText) * 100) / 100).toFixed(2)
      assert.strictEqual(section.footAmountText, expectAmount,
        label + '：第' + si + '节节尾金额 ' + section.footAmountText + ' != 节尾件数 ' + footQty
          + ' × 节头单价 ' + section.priceText + ' = ' + expectAmount)
    }
    slipQty += footQty
  })
  return slipQty
}

// 全表都是矩阵节（没有平铺节的「货号」表头）时，各节件数之和必须等于底部汇总区的「总数」。
function b4AssertQtyClosure(layout, label, expectSectionCount, priceTimesQty) {
  assert.ok(!hasText(layout, '货号'), label + '：这条闭合断言只对「没有平铺节」的单据成立')
  const qty = b4AssertArithmetic(layout, label, expectSectionCount, priceTimesQty)
  assert.strictEqual(qty + ' 件', labelValueText(layout, '总数'),
    label + '：各节件数之和 ' + qty + ' 件 != 单据总数 ' + labelValueText(layout, '总数'))
}

// ---- 4-1 逐值断言：3 色 × 3 码缺一格（就是上面 matrixLayout 那张）-----------------
// matrixLines 的件数按生成顺序 1..8：黑S=1 黑M=2 黑L=3 / 白S=4 白M=5 白L=6 / 蓝S=7 蓝M=8，
// 蓝L 没卖 -> 画「—」。行小计 6 / 15 / 15，节尾 36 件，单价 59.00，金额 36 × 59 = 2124.00。
const b4ExpectedMatrix = [
  'TS-005 短袖 T恤', '¥59.00',
  '颜色', 'S', 'M', 'L', '小计',
  '黑色', '1', '2', '3', '6',
  '白色', '4', '5', '6', '15',
  '蓝色', '7', '8', '—', '15',
  '小计 36 件', '¥2124.00'
]
const b4MatrixTexts = b4Texts(matrixLayout)
const b4MatrixStart = b4MatrixTexts.indexOf('TS-005 短袖 T恤')
assert.ok(b4MatrixStart >= 0, '3色×3码：文本序列里找不到节头「TS-005 短袖 T恤」')
assert.deepStrictEqual(
  b4MatrixTexts.slice(b4MatrixStart, b4MatrixStart + b4ExpectedMatrix.length),
  b4ExpectedMatrix,
  '3色×3码缺一格：矩阵表画出来的文本序列和逐格手算的期望值不一致'
)
b4AssertQtyClosure(matrixLayout, '3色×3码缺一格', 1, true)

// ---- 4-2 算术不变量铺到已有的矩阵夹具 ------------------------------------------
b4AssertQtyClosure(slipImage.layoutSlip(matrixFixtureSlip(col3Lines)), '6列×3字', 1, true)
b4AssertQtyClosure(slipImage.layoutSlip(matrixFixtureSlip(blankSkuMatrixLines)), '货号为空的矩阵节', 1, true)
// 批 3 的 14 号夹具（同一格两行）：它只给了 qtyText，金额一律是 specLine 的默认 59.00，
// 不是「件数 × 单价」，所以这里不查金额那一层，只查件数三层。
b4AssertQtyClosure(dupLayout, '同格两行累加', 1, false)
// 批 3 的 12 号夹具：两个矩阵节被平铺节隔开，含平铺节所以不做总数闭合，只查每节内部。
b4AssertArithmetic(splitLayout, '矩阵节被平铺节隔开', 2, true)

// ---- 4-3 缺陷 2：分节按 productId，不按「品名 + 货号」 --------------------------
// 品名没有唯一性校验（createProduct 只校验非空）、货号可空，两个**不同商品**同名且都没填
// 货号时，旧 key 会把它们并进同一节：节头只印一个品名、小计跨商品求和。
// pages/sale/sale.js 的 mergeLines 挡不住——它按 product.id + specKey 合并，只在单个商品内去重。
const b4TwoProductSections = slipImage.sliceLineSections([
  specLine({ id: 'n1', productId: 'p-1', productName: '短袖', sku: '' }),
  specLine({ id: 'n2', productId: 'p-2', productName: '短袖', sku: '' })
])
assert.strictEqual(b4TwoProductSections.length, 2,
  '两个同名且都没填货号的商品必须按 productId 分成两节，实际分了 ' + b4TwoProductSections.length + ' 节')
// 同一个商品被拆成两行（不同规格）仍然只有一节——别把「按 id 分」写成「一行一节」。
assert.strictEqual(slipImage.sliceLineSections([
  specLine({ id: 'n3', productId: 'p-1', productName: '短袖', sku: '' }),
  specLine({ id: 'n4', productId: 'p-1', productName: '短袖', sku: '' })
]).length, 1, '同一个 productId 的两行必须还在同一节')
// 老流水没有 productId：退回「品名 + 货号」，行为和改动前一样。
assert.strictEqual(slipImage.sliceLineSections([
  specLine({ id: 'o1', productName: '短袖', sku: '' }),
  specLine({ id: 'o2', productName: '短袖', sku: '' })
]).length, 1, '没有 productId 的老流水必须退回「品名 + 货号」分组，不能一行一节')

// withSlipView 要把 productId 带下来，否则上面那条分节永远走不到 id 分支。
const b4TwoProductSlip = util.withSlipView({
  id: 'order-two-product',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 118,
  paidAmount: 118,
  lines: [
    { lineId: 'tp1', productId: 'p-1', productName: '短袖', qty: 1, unitPrice: 59, amount: 59 },
    { lineId: 'tp2', productId: 'p-2', productName: '短袖', qty: 1, unitPrice: 59, amount: 59 }
  ]
}, 0)
assert.strictEqual(b4TwoProductSlip.lines[0].productId, 'p-1', 'withSlipView 要把 productId 带到送货单行上')
assert.strictEqual(b4TwoProductSlip.lines[1].productId, 'p-2', 'withSlipView 要把 productId 带到送货单行上')
// 只加这一个字段，别的取值一个都不许动。
assert.strictEqual(b4TwoProductSlip.lines[0].productName, '短袖')
assert.strictEqual(b4TwoProductSlip.lines[0].qtyText, '1')
assert.strictEqual(b4TwoProductSlip.lines[0].priceText, '59.00')
assert.strictEqual(b4TwoProductSlip.lines[0].amountText, '59.00')
assert.strictEqual(b4TwoProductSlip.lines[0].sku, '')
assert.strictEqual(slipImage.sliceLineSections(b4TwoProductSlip.lines).length, 2,
  'withSlipView 出来的两个同名无货号商品要分成两节')

// 端到端：两个同名无货号商品各自 2 色 × 3 码、单价都是 59。
// 旧 key 会把 12 行并成一节（R=4、N=12，条件全过），画出一张跨商品的矩阵、只印一个品名、
// 节尾小计 78 件；按 productId 分节则是两节，节尾各 21 / 57 件。
function b4ProductGrid(productId, colors, startQty) {
  const lines = []
  let n = startQty
  colors.forEach(function (color) {
    ;['S', 'M', 'L'].forEach(function (size) {
      const qty = n++
      lines.push(specLine({
        id: productId + '-' + color + '-' + size,
        productId: productId,
        productName: '短袖',
        sku: '',
        specParts: [{ name: '颜色', value: color }, { name: '尺码', value: size }],
        qtyText: String(qty),
        priceText: '59.00',
        amountText: (qty * 59).toFixed(2)
      }))
    })
  })
  return lines
}
const b4SameNameLines = b4ProductGrid('p-1', ['黑色', '白色'], 1).concat(b4ProductGrid('p-2', ['红色', '蓝色'], 7))
const b4SameNameLayout = slipImage.layoutSlip(matrixFixtureSlip(b4SameNameLines))
assert.deepStrictEqual(
  b4Texts(b4SameNameLayout).filter(function (t) { return /^小计 .+ 件$/.test(t) }),
  ['小计 21 件', '小计 57 件'],
  '两个同名无货号商品必须各自成节、各自算小计，不能并成一节求和'
)
b4AssertQtyClosure(b4SameNameLayout, '同名不同商品', 2, true)

// ---- 4-4 缺陷 3：矩阵节头长品名不许压到单价上、更不许画出画布 --------------------
// 明细态品名走 wrapCell 受列宽约束，节头这一行没有列，得自己算可用宽。
function b4LongNameLines(name) {
  return gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
    return Object.assign({}, line, { productName: name, sku: '' })
  })
}
// 取节头那几行文字：从 ¥单价 往回收，收到不是「贴左边距的 left 文本」为止。
function b4AssertHeadFits(layout, priceText, fullName, label) {
  const cmds = textCmds(layout)
  const at = cmds.findIndex(function (c) {
    return c.align === 'right' && c.text === '¥' + priceText
  })
  assert.ok(at > 0, label + '：找不到矩阵节头单价 ¥' + priceText)
  const price = cmds[at]
  const pieces = []
  for (let i = at - 1; i >= 0; i--) {
    if (cmds[i].align !== 'left' || cmds[i].x !== B4_HEAD_TEXT_X) break
    pieces.unshift(cmds[i])
  }
  assert.ok(pieces.length > 0, label + '：节头没画出品名')
  assert.strictEqual(pieces.map(function (c) { return c.text }).join(''), fullName,
    label + '：节头品名被截断/改写了，画出来的是 '
      + JSON.stringify(pieces.map(function (c) { return c.text })))
  const priceLeft = price.x - slipImage.estimateWidth(price.text, price.font)
  pieces.forEach(function (piece, index) {
    const right = piece.x + slipImage.estimateWidth(piece.text, piece.font)
    assert.ok(right <= priceLeft + 0.5,
      label + '：节头第' + index + '行右边界 ' + right.toFixed(1)
        + ' 压到单价左边界 ' + priceLeft.toFixed(1) + ' 上了')
    assert.ok(right <= layout.width + 0.5,
      label + '：节头第' + index + '行右边界 ' + right.toFixed(1)
        + ' 画到画布(' + layout.width + ')外了')
  })
  // 折出来的行不许压到下面那行列表头上：节头高度要跟着行数长。
  const last = pieces[pieces.length - 1]
  assert.ok(last.y + B4_LINE_H <= cmds[at + 1].y + 0.5,
    label + '：节头最后一行 y=' + last.y + ' 压到列表头 y=' + cmds[at + 1].y
      + ' 上了（节头高度没跟着行数长）')
  return pieces
}
// 阈值是实测出来的，不是估的：在改动前那版「51px 单行硬画」上扫 1..60 个汉字，
// 单价 ¥59.00、画布 1700 时 **28 字起**节头右边界压过单价左边界、**33 字起**画出画布。
// 所以下面挑 28（压单价的第一个）和 36（已经出画布）两个点，外加 60 个字看折行。
// 别把这两个数当常量用：阈值随单价位数走，单价越长越早出事。
const b4Name28 = '超'.repeat(28)
const b4Long28 = slipImage.layoutSlip(matrixFixtureSlip(b4LongNameLines(b4Name28)))
b4AssertHeadFits(b4Long28, '59.00', b4Name28, '28字品名节头')
b4AssertInside(b4Long28, '28字品名节头')
// 36 个汉字：改动前整段画到画布 1700 外。
const b4Name36 = '超长'.repeat(18)
const b4Long36 = slipImage.layoutSlip(matrixFixtureSlip(b4LongNameLines(b4Name36)))
b4AssertHeadFits(b4Long36, '59.00', b4Name36, '36字品名节头')
b4AssertInside(b4Long36, '36字品名节头')
// 60 个汉字：降到最小字号也塞不下，必须折行，节头跟着变高。
const b4Name60 = '超长'.repeat(30)
const b4Long60 = slipImage.layoutSlip(matrixFixtureSlip(b4LongNameLines(b4Name60)))
const b4Long60Pieces = b4AssertHeadFits(b4Long60, '59.00', b4Name60, '60字品名节头')
assert.ok(b4Long60Pieces.length >= 2,
  '60字品名节头：应当折行，实际只画了 ' + b4Long60Pieces.length + ' 行')
b4AssertInside(b4Long60, '60字品名节头')
assert.ok(b4Long60.contentHeight > b4Long36.contentHeight,
  '60字品名节头：折行把节头撑高了，整张图应当更高')
// 短品名不受影响：还是单行、还是 FONT.head，不许被这条改动顺手降了字号。
const b4ShortHead = textCmds(matrixLayout).find(function (c) {
  return c.text === 'TS-005 短袖 T恤'
})
assert.strictEqual(b4ShortHead.font, slipImage.FONT.head, '短品名节头不该被降字号')

// ---- 4-5 越界扫描铺到全部矩阵/混排夹具（含平铺节），两态各跑一遍 ------------------
;[
  ['3色×3码缺一格', matrixSlip],
  ['6列×3字', matrixFixtureSlip(col3Lines)],
  ['6列×4字(退回平铺)', matrixFixtureSlip(col4Lines)],
  ['6列×13字(退回平铺)', matrixFixtureSlip(col13Lines)],
  ['混排:矩阵节+平铺节', matrixFixtureSlip(mixedMatrixLines.concat(mixedFlatLines))],
  ['混排:钢材9位数金额', matrixFixtureSlip(overflowMatrixLines.concat(overflowFlatLines))],
  ['两个平铺节合并', matrixFixtureSlip(mergeFlatFirst.concat(mergeFlatSecond).concat(mergeMatrixThird))],
  ['矩阵节隔开两段平铺', matrixFixtureSlip(splitMatrixFirst.concat(splitFlatMiddle).concat(splitMatrixSecond).concat(splitFlatLast))],
  ['列口径保真', matrixFixtureSlip(columnFidelityMatrix.concat(columnFidelityFlat))],
  ['货号为空的矩阵节', matrixFixtureSlip(blankSkuMatrixLines)],
  ['同格两行累加', matrixFixtureSlip(dupCellLines)],
  ['同名不同商品各成一节', matrixFixtureSlip(b4SameNameLines)],
  ['28字品名节头', matrixFixtureSlip(b4LongNameLines(b4Name28))],
  ['36字品名节头', matrixFixtureSlip(b4LongNameLines(b4Name36))],
  ['60字品名节头', matrixFixtureSlip(b4LongNameLines(b4Name60))],
  ['单价不一致(平铺)', matrixFixtureSlip(priceMismatchLines)],
  ['轴数为3(平铺)', matrixFixtureSlip(threeAxisLines)],
  ['列轴7个取值(平铺)', matrixFixtureSlip(sizeOnlyLines(sizeList))]
].forEach(function (entry) {
  b4AssertInside(slipImage.layoutSlip(entry[1]), '越界扫描/' + entry[0])
  b4AssertInside(slipImage.layoutSlip(entry[1], null, { exportStyle: 'detail' }), '越界扫描(detail)/' + entry[0])
})
// 上面这批里必须真有「矩阵节 + 平铺节」同时出现的，否则「盖到平铺节」是空话。
;[
  ['混排:矩阵节+平铺节', mixedMatrixLines.concat(mixedFlatLines)],
  ['混排:钢材9位数金额', overflowMatrixLines.concat(overflowFlatLines)],
  ['矩阵节隔开两段平铺', splitMatrixFirst.concat(splitFlatMiddle).concat(splitMatrixSecond).concat(splitFlatLast)]
].forEach(function (entry) {
  const layout = slipImage.layoutSlip(matrixFixtureSlip(entry[1]))
  assert.ok(hasText(layout, '小计'), entry[0] + '：应当有矩阵节')
  assert.ok(hasText(layout, '货号'), entry[0] + '：应当有平铺节（平铺节才画「货号」表头）')
})

// ---- 4-6 缺陷 5：exportStyle 的取值语义按事实钉住 ------------------------------
// 老注释写「不传 = 老路径、一条分节逻辑都不会跑」，实际是「不传 -> summary -> 照样分节」。
assert.deepStrictEqual(
  slipImage.layoutSlip(matrixSlip),
  slipImage.layoutSlip(matrixSlip, null, { exportStyle: 'summary' }),
  '不传 options 必须和显式 summary 逐字段相同'
)
assert.deepStrictEqual(
  slipImage.layoutSlip(matrixSlip),
  slipImage.layoutSlip(matrixSlip, null, { exportStyle: '不认识的值' }),
  '不认识的 exportStyle 必须夹成 summary'
)
assert.notDeepStrictEqual(
  slipImage.layoutSlip(matrixSlip),
  slipImage.layoutSlip(matrixSlip, null, { exportStyle: 'detail' }),
  '不传 options 不等于 detail —— 它会分节、会矩阵化'
)
assert.ok(hasText(slipImage.layoutSlip(matrixSlip), '小计'),
  '不传 options 时矩阵化照跑（这就是「不传 != 老路径」的直接证据）')

// ---- 4-6b 规格取值撞上 Object.prototype 的成员名 ------------------------
// 矩阵格子用 `grid[行轴值][列轴值]` 寻址，而规格取值是店主自由输入的字符串。
// 用 `{}` 做容器时，取值正好叫 `constructor` / `toString` / `valueOf` /
// `hasOwnProperty` / `__proto__` 会从原型上读到一个真值，
// `if (!grid[r][c])` 判假、不初始化成数组，下一行 `.push` 直接抛
// `grid[r][c].push is not a function`——**整张送货单导不出来**。
//
// **会抛异常的只有列轴**——这是下面两轴都要测的原因。
// **但行轴不是无害**（这里曾经写的是「行轴撞上无害」，错的，而且它读起来
// 像结论）：`__proto__` 那一支会把格子数组写到 `Object.prototype` 上，
// **同一张单当场就印错**（两行都印 5/7/9）、且会泄到下一张。
// `constructor` 那一支不印错、也不跨单泄漏，只污染全局 `Object`。
// 详见下面 assertNoCrossSlipLeak 那段的说明。
// 所以下面两轴都要测：只测行轴会结构性地漏掉真正会崩的那一支。
const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

PROTO_NAMES.forEach(function (name) {
  // 列轴（规格二）取名为原型名——会崩的那一支
  const colLines = gridLines(['黑色', '白色'], [name, 'M', 'L'])
  assert.doesNotThrow(function () {
    slipImage.layoutSlip(matrixFixtureSlip(colLines))
  }, '列轴取值叫「' + name + '」时不得抛异常：'
    + 'grid 用 {} 会从原型读到真值、跳过数组初始化，'
    + '.push 当场抛，整张送货单导不出来')

  // 行轴（规格一）取名为原型名——当前不崩，一并钉住防回归
  const rowLines = gridLines([name, '白色'], ['S', 'M', 'L'])
  assert.doesNotThrow(function () {
    slipImage.layoutSlip(matrixFixtureSlip(rowLines))
  }, '行轴取值叫「' + name + '」时不得抛异常')
})

// 行轴撞上原型名不崩，但危害更隐蔽：`grid['constructor']` 拿到的是全局
// `Object` 构造函数，于是 `grid[r][c] = []` 直接**写到全局 `Object` 身上**。
// 后果分两支（别混）：
//   · `__proto__` 写到 `Object.prototype`——下一张单新建的 `{}` 会从原型继承到
//     上一张的行，**客户可能在自己的单子上看到别人的货**。静默、持续整个 app 会话。
//   · `constructor` 写到 `Object` 本体，**不跨单泄漏**，只污染全局 `Object`。
// （上一版把「客户看到别人的货」这个后果用逗号接在「不跨单泄漏」后面，
//   按标点读等于说不泄漏的那一支会让客户看到别人的货。实测不会。）
//
// ---- 单行节头不得变高 ------------------------------------------------
// 节头折行那一改曾经把高度写成 `Math.max(headH, CELL_PAD_Y*2 + n*LINE_H)`，
// n=1 时是 `max(98, 111)` = 111——**每一张既有矩阵单的节头都无条件长高 13px**，
// 而旁边的注释声称「单行时与改动前逐字相同」。审计逐条指令对比拉出来的：
// 49 条里 31 条不同、contentHeight 1218→1231。
//
// 当时这个回归**没有任何断言拦**——改对了行为不补守卫，下次还会回来。
;(function assertSingleLineHeadUnchanged() {
  const lines = gridLines(['\u9ed1\u8272', '\u767d\u8272'], ['S', 'M', 'L'])
  const layout = slipImage.layoutSlip(matrixFixtureSlip(lines))

  // 按**对象字段**过滤，不对 JSON.stringify 跑正则——rect 的字段序是
  // {type,x,y,w,h,fill}，`"type":"rect"[^}]*"h":(\d+)` 这种写法在 fill 之前就停了，
  // 拿不到颜色。节头用 COLORS.header (#F3F4F6)，列表头/合计用 COLORS.total (#FAFAFA)。
  //
  // 【为什么这段重写了两次】最早那版是把**全表所有** rect 的 h 收进来、
  // 再断言「98 在里面」——而列表头本来就是 98，所以那条**恒真**；
  // 真正干活的只有「不得出现 111」，而它只是一条**针对字面量 111 的牲线**：
  // 实测 `sectionHeadH = headH + 5`（=103）或 `headH - 10`（=88）时，不但这条绿，
  // **整个 `npm test` 都是 exit 0**——因为折行那条断言比的是两张图的**相对**高度，
  // 均匀平移时两边同增同减、差值不变，结构上就抓不到。
  const headRects = layout.commands.filter(function (c) {
    return c.type === 'rect' && c.fill === '#F3F4F6'
  })

  // 阳性对照：过滤一旦失效，下面的 forEach 会空跑、一条不断——那就是假绿。
  assert.strictEqual(
    headRects.length, 1,
    '前提：这张单只有一个矩阵节，应当恰好抓到 1 条 #F3F4F6 的节头底色条，'
      + '实测 ' + headRects.length + ' 条。抓不到就说明过滤失效，下面那条断言是假绿'
  )
  assert.strictEqual(
    headRects[0].h, 98,
    '单行节头的底色条高度必须**严格等于** 98（与折行改动前逐字相同），'
      + '实测 ' + headRects[0].h + '。写成 Math.max(headH, CELL_PAD_Y*2 + n*LINE_H) 的话 '
      + 'n=1 也会得到 111，每一张既有矩阵单都会无声息长高 13px。'
      + '（用严格相等而不是「≠111」：后者只是针对 111 的牲线，103 / 88 都能溦过去。）'
  )
})()

// 这一段重写过（2026-09-03）——上一版的「第二张单不得继承第一张」那条是**空转**的，
// 而注释还把真正在干活的那条（全局污染）贬为「实现细节」。成因：
// 夹具用的行轴名是 `constructor`，`grid['constructor']` 拿到的是 **`Object` 这个函数对象**，
// 于是写到 `Object.S`；而第二张单新建的 `{}` 是从 **`Object.prototype`** 找属性，
// 根本找不到 `Object.S`——所以那条断言在任何实现下都恒绿，**结构性不可能红**。
//
// 真正会跨单据泄漏的是 `__proto__` 当行轴：它写到 `Object.prototype`，而那正是
// 下一张单的 `{}` 会继承的地方。实测（修复前）：
//   干净的第二张单：  ["100","101","102","303","103","104","105","312"]
//   被污染的第二张：  ["208","212","216","303","208","212","216","312"]
// 格子印的是**上一张单的数**，而行小计还是本单的——格之和 ≠ 小计。
//
// 教训：断言文案声称自己在盯「实际危害」，不等于它真的盯得住。
// 判据仍然是那句：**存不存在一个状态，能让正确实现和错误实现给出不同结果？**
//
// 下面两条断言**各守一种变异**，不是一条主一条副（实测出来的，不是推的）：
//   · **只把外层改回 `{}`**：`grid['__proto__']` 读到 `Object.prototype`，写成
//     `Object.prototype.S`——但第二张单的**内层仍是 null 原型**，找不到它，
//     所以**不会跨单泄漏**。这一支的实际危害就是全局污染本身，
//     能抳住它的只有下面那条 `dirty` 断言。
//   · **两处都改回 `{}`**：第二张单的内层 `{}` 从 `Object.prototype` 继承到
//     上一张的格子数组，这才是跨单泄漏。**但在完整套件里轮不到它来抳**：
//     上游那条列轴 `doesNotThrow` 会先响、进程当场退出。数字序列这条是**纵深防御**：
//     列轴那条哪天被放宽了它顶上（实测：删掉列轴那条后，它单独能红）。
// 两条都不能删。
;(function assertNoCrossSlipLeak() {
  // 用 __proto__ 而不是 constructor：只有它写到 Object.prototype，才会被下一张单继承。
  const rowName = '__proto__'
  // 两张单的**列取值必须重叠**（都是 S/M/L），否则继承来的格子 key 对不上、泄漏不可观测。
  const cols = ['S', 'M', 'L']
  const first = slipImage.layoutSlip(
    matrixFixtureSlip(gridLines([rowName, '\u767d\u8272'], cols))
  )
  assert.ok(first, '第一张单应当能正常排版')

  // 第二张：不同的行轴取值，相同的列轴取值。把它画出来的数字序列拿出来比。
  function digitsOf(layout) {
    const out = []
    JSON.stringify(layout).replace(/"text":"([^"]*)"/g, function (_, t) {
      if (/^[0-9]+$/.test(t)) out.push(t)
      return ''
    })
    return out
  }
  const secondLines = gridLines(['\u7ea2\u8272', '\u7eff\u8272'], cols)
  const second = digitsOf(slipImage.layoutSlip(matrixFixtureSlip(secondLines)))

  // 基准：同一份第二张单在**没有跑过第一张**时的数字序列。
  // 这里不能重新跑一遍（环境已经被污染了），所以直接拿这份夹具自己的件数算。
  // 按**序列逐位**比，不是「值出现过就算」——后者在泄漏后的数值恰好覆盖
  // 得住期望集时会假绿（复审指出：上一版里 `'6'` 其实是被行小计满足的、
  // 并非格子里的数，只是恰好还有别的值缺失才红）。
  // 期望序列要按真实版式构造：**行小计是夹在格子中间的**
  // （一行的几个格 → 该行小计 → 下一行…）。直接 slice 前 N 个会对不上——
  // 我第一版就是那么写的，当场红在 ["1","2","3","6"] vs ["1","2","3","4"]。
  const byRow = {}
  const rowOrder = []
  secondLines.forEach(function (l) {
    const rv = l.specParts[0].value
    if (!byRow[rv]) { byRow[rv] = []; rowOrder.push(rv) }
    byRow[rv].push(l.qtyText)
  })
  const expected = []
  rowOrder.forEach(function (rv) {
    byRow[rv].forEach(function (q) { expected.push(q) })
    expected.push(String(byRow[rv].reduce(function (a, b) { return a + Number(b) }, 0)))
  })
  assert.ok(expected.length > 0, '前提：第二张单夹具要有行')
  const head = second.slice(0, expected.length)
  assert.deepStrictEqual(
    head, expected,
    '第二张单的矩阵数字序列（格子 + 行小计）应当是 ' + JSON.stringify(expected)
      + '，实测 ' + JSON.stringify(head)
      + '——对不上就是上一张单的格子通过 Object.prototype 泄漏过来了'
  )

  // 直接钉全局污染：同时查 Object 本体和 Object.prototype——
  // constructor 那一支污染前者，__proto__ 那一支污染后者，只查一个会漏。
  const dirty = []
  ;[Object, Object.prototype].forEach(function (target, i) {
    Object.getOwnPropertyNames(target).forEach(function (k) {
      if (cols.indexOf(k) >= 0) dirty.push((i === 0 ? 'Object.' : 'Object.prototype.') + k)
    })
  })
  assert.deepStrictEqual(
    dirty, [],
    '排版不得在全局 Object / Object.prototype 上写属性（实测多出：'
      + dirty.join(', ') + '）'
  )
})()

// 不只要求不崩，还要求真的把那一列画出来（否则“不抛异常”可以靠
// 静默丢掉这列来满足，那是另一种丢数）。
const protoColLayout = slipImage.layoutSlip(
  matrixFixtureSlip(gridLines(['黑色', '白色'], ['constructor', 'M', 'L']))
)
assert.ok(
  hasText(protoColLayout, 'constructor'),
  '列轴取值叫「constructor」时，这一列必须真的被画出来，'
    + '不能靠静默丢列来“不报错”'
)

// ---- 4-7 源码钉子：这两个文件里都不许出现裸 NUL 字节 ----------------------------
// 裸 NUL 会让 grep / rg 把整个文件判成 binary、拒绝输出任何匹配，搜的人会以为里面什么
// 都没有。转义写法运行时完全等价。
// 批 3 把 utils/slip-image.js 里那个裸字节改掉了，但**在本文件的注释里又写进去一个**
// （2026-09-03 发现并清掉），所以这条钉子两个文件都查——只钉源码那一个是不够的。
// 它查的是**字节**；批 3 的 15 号查的是分组行为，两回事，都要留着。
;['utils/slip-image.js', 'tests/slip-image.test.js'].forEach(function (rel) {
  assert.ok(
    require('fs').readFileSync(require('path').join(__dirname, '..', rel)).indexOf(0) < 0,
    rel + ' 里出现了裸 NUL 字节：grep / rg 会把整个文件判成 binary，要写成转义形式'
  )
})

// ---------------------------------------------------------------------------
// 送货单弹层组件的**可测性**钉子（和 tests/record-sheet.test.js 末尾那条同形）。
//
// 【背景】slip-overlay 从 2026-08-23 到 2026-08-31 一直开着 virtualHost。开了它，
// 页面侧压根没有宿主节点，automator 三种写法（page.$$('.js-slip')、
// 'slip-overlay >>> .js-slip'、selectComponent）实测**全是 0**，于是 tests/ui.test.js
// 的送货单用例只能退化成核对页面 data —— 屏幕上显示成什么样，那版用例查不出来。
// 2026-08-31 摘掉 virtualHost 并给两个引用点加 id，用例才升回核对渲染。
//
// 这条钉子看着两件事：virtualHost 没被加回来、两个宿主的 id 还在。任一被改掉，
// UI 测试会在开开发者工具十分钟之后才失败，而这里两秒钟就红。
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
function readRepo(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
}
const slipJs = readRepo('components/slip-overlay/index.js')
assert.ok(
  !/virtualHost\s*:\s*true/.test(slipJs),
  'slip-overlay 不许开 virtualHost：开了页面侧就没有宿主节点，UI 测试够不到弹层里的任何元素，'
    + '那条用例只能退回核对页面 data（字段绑错、屏幕上不显示，就查不出来了）'
)
;['pages/sale/sale.wxml', 'pages/record-edit/record-edit.wxml'].forEach(function (rel) {
  const src = readRepo(rel)
  assert.ok(
    src.indexOf('<slip-overlay') >= 0,
    rel + ' 里找不到 <slip-overlay> 了 —— 引用点改了的话这条钉子要跟着改'
  )
  assert.ok(
    /<slip-overlay\s*\n\s*id="slip-overlay"/.test(src),
    rel + ' 的 <slip-overlay> 要带 id="slip-overlay"：UI 测试靠 page.$(\'#slip-overlay\') '
      + '取组件实例，再在实例上查 .js-slip-* 子元素'
  )
})

console.log('slip-image tests passed')
