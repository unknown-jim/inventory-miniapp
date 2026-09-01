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

// 5) 逐条覆盖 1.3 的 6 个否决条件，每条只差这一条，断言退回平铺（无「小计」、无「—」）。
function assertFlatFallback(lines, label) {
  const layout = slipImage.layoutSlip(matrixFixtureSlip(lines))
  assert.ok(!hasText(layout, '小计'), label + '：不该有矩阵小计')
  assert.ok(!hasText(layout, '—'), label + '：不该有矩阵缺格占位')
}

// 只有 1 行（条件 2）
assertFlatFallback([
  specLine({ specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] })
], '只有1行')

// 单价不一致（条件 4）
assertFlatFallback([
  specLine({ id: 'p1', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }] }),
  specLine({ id: 'p2', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }], priceText: '65.00', amountText: '65.00' })
], '单价不一致')

// 轴数为 1（条件 3）
assertFlatFallback([
  specLine({ id: 'q1', specParts: [{ name: '颜色', value: '黑色' }] }),
  specLine({ id: 'q2', specParts: [{ name: '颜色', value: '白色' }] })
], '轴数为1')

// 轴数为 3（条件 3）
assertFlatFallback([
  specLine({ id: 'r1', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }, { name: '季节', value: '夏' }] }),
  specLine({ id: 'r2', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'M' }, { name: '季节', value: '夏' }] })
], '轴数为3')

// 节内轴名不一致（条件 3）
assertFlatFallback([
  specLine({ id: 's1', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] }),
  specLine({ id: 's2', specParts: [{ name: '颜色', value: '白色' }, { name: '克数', value: '50g' }] })
], '节内轴名不一致')

// 列轴 7 个取值，超 MATRIX_COL_LIMIT=6（条件 5）
assertFlatFallback(['S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL'].map(function (size, index) {
  return specLine({
    id: 'sz' + index,
    specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: size }],
    qtyText: String(index + 1),
    amountText: ((index + 1) * 59).toFixed(2)
  })
}), '列轴7个取值')

// 无压缩收益：2 色 × 2 码卖 3 格，R=2、N=3，2+2=4 不小于 3（条件 6）
assertFlatFallback([
  specLine({ id: 't1', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }] }),
  specLine({ id: 't2', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }] }),
  specLine({ id: 't3', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'S' }] })
], '无压缩收益')

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
