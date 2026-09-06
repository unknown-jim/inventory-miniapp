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
// 默认（不传 options）解析成汇总态，而汇总态**没有规格列**——规格进了数量格的胶囊。
// 所以「货号 / 颜色 / 尺码」这几个**表头**的断言要对着明细态提，不能对着默认那份提。
// 上一版这几条写在默认那份上，胶囊改动一上来就红——红得对：它们钉的是矩阵版的列结构。
const detailLayout = slipImage.layoutSlip(slip, null, { exportStyle: 'detail' })
const detailText = textsOf(detailLayout)
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
assert.ok(text.indexOf('规格') < 0)
// 两态共有的四个表头
assert.ok(text.indexOf('品名') >= 0)
assert.ok(text.indexOf('数量') >= 0)
assert.ok(text.indexOf('单价') >= 0)
assert.ok(text.indexOf('金额') >= 0)
// 明细态：规格各占一列，货号也自成一列
assert.ok(detailText.indexOf('货号') >= 0)
assert.ok(detailText.indexOf('颜色') >= 0)
assert.ok(detailText.indexOf('尺码') >= 0)
assert.ok(detailText.indexOf('TS-005') >= 0)
// 汇总态：**没有**规格列的表头，规格在胶囊里；货号仍然要印得出来（在品名格第二行）。
// 「货号整个不见了」是本批实测过的回归：上一版为了省 65px 只在「≥2 条规格」时才印
// 第二行，单商品单规格的单子（也就是最常见的那种）货号就没了。
assert.ok(text.indexOf('颜色') < 0, '汇总态不该有「颜色」表头——规格进了胶囊')
assert.ok(text.indexOf('尺码') < 0, '汇总态不该有「尺码」表头')
assert.ok(text.indexOf('TS-005') >= 0, '汇总态也必须印得出货号，省版面不能省掉单据字段')
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
assert.ok(totalLabel.y > qtyHead.y)
assert.ok(amountLabel.x > totalLabel.x)
// 这里原来还有一条 `totalLabel.x < nameHead.x`。它成立只是因为矩阵/明细态第一列是货号、
// 品名被推到第二列（x=302）；汇总态没有货号列，品名就是第一列（x=60），而合计块的左内边距
// 是 68 —— 不等式跟着翻了个面。它本来想说的是「合计不在表格里」，所以直接钉那件事，
// 两态各钉一遍：合计块整个落在货物表格外框的下沿之下。
;[['汇总态', layout], ['明细态', detailLayout]].forEach(function (entry) {
  const box = entry[1].commands.filter(function (item) {
    return item.type === 'stroke'
  })
  assert.strictEqual(box.length, 1, entry[0] + '：货物表格应当恰好画一个外框')
  const total = entry[1].commands.find(function (item) {
    return item.type === 'text' && item.text === '总数'
  })
  assert.ok(total.y > box[0].y + box[0].h,
    entry[0] + '：合计块要落在货物表格外框（下沿 ' + (box[0].y + box[0].h) + '）之下，实测 y=' + total.y)
})
// 两态第一列不是同一列：汇总态是品名（贴左内边距），明细态是货号，品名被推到它右边。
assert.strictEqual(nameHead.x, 36 + 24, '汇总态品名是第一列，表头应贴左内边距')
assert.ok(
  detailLayout.commands.find(function (item) {
    return item.type === 'text' && item.text === '品名'
  }).x > nameHead.x,
  '明细态品名在货号列右边，表头 x 应大于汇总态'
)
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
// 每次 fillText 连当时的 textBaseline 一起记下来：胶囊文字走中线对齐这件事是在
// drawSlip 里落地的（layoutSlip 只在指令上标 baseline:'middle'），得有人看着它真的翻译过去。
const drawnText = []
const fakeCtx = {
  fillStyle: '',
  font: '',
  textAlign: '',
  textBaseline: '',
  strokeStyle: '',
  lineWidth: 1,
  fillRect: function () { drawn.push('fillRect') },
  fillText: function (t) { drawn.push('fillText'); drawnText.push({ text: t, baseline: fakeCtx.textBaseline }) },
  strokeRect: function () { drawn.push('strokeRect') },
  beginPath: function () {},
  moveTo: function () {},
  lineTo: function () {},
  // 胶囊底走 arc + fill 拼路径（微信旧版 CanvasContext 没有 roundRect）。
  arc: function () { drawn.push('arc') },
  closePath: function () {},
  fill: function () { drawn.push('fill') },
  stroke: function () { drawn.push('stroke') },
  save: function () {},
  restore: function () {},
  setLineDash: function () {}
}
slipImage.drawSlip(fakeCtx, layout)
assert.ok(drawn.indexOf('fillText') >= 0)
assert.ok(drawn.indexOf('strokeRect') >= 0)
assert.ok(drawn.indexOf('stroke') >= 0)
// 胶囊真的画了：arc（两端半圆）+ fill（底色）。汇总态一定有胶囊，前面已经钉过。
assert.ok(drawn.indexOf('arc') >= 0, 'drawSlip 必须用 arc 拼胶囊两端的半圆')
assert.ok(drawn.indexOf('fill') >= 0, 'drawSlip 必须给胶囊填底色')
// 胶囊文字画的时候 textBaseline 必须是 'middle'，别的文字必须是 'top'，而且画完要复位——
// 不复位的话它后面所有文字都会跟着往上跳半个字。
const pillTexts = layout.commands.filter(function (item) {
  return item.type === 'text' && item.baseline === 'middle'
}).map(function (item) {
  return item.text
})
assert.ok(pillTexts.length > 0, '汇总态应当有中线对齐的胶囊文字，否则下面两条是空转的')
drawnText.forEach(function (item, index) {
  const want = pillTexts.indexOf(item.text) >= 0 ? 'middle' : 'top'
  assert.strictEqual(item.baseline, want,
    '第' + index + '条 fillText「' + item.text + '」画的时候 textBaseline 应为 ' + want
      + '，实测 ' + item.baseline + '（胶囊文字走中线，其余走顶端，画完必须复位）')
})

// detail ≡ 默认态的钉子：sampleSlip 只有 1 行，节内行数不满足矩阵条件 2，'summary' 态本就
// 退回平铺，所以两态必须逐字相同。这条钉的是「detail 不会走出一条自己的路」。
//
// 它**不能**顺带证明「默认态 ≡ 改动前」：上面那批老断言是 indexOf 之类的内容检查，钉不住
// 逐字节。那条性质靠的是评审期把 baseline 的 utils/slip-image.js 单独加载成对照模块、
// 比 JSON.stringify(layout)（三轮审计各自独立验过一次，老形态夹具全部逐字节相等）。
// 仓库里留不住 baseline 模块，所以这条只能是评审期证据，不是常驻钉子。
// 这里原来是 `deepStrictEqual(layout, detailLayout)`：sampleSlip 只有 1 行，矩阵条件 2
// （节行数 ≥ 2）不满足、汇总态本就退回平铺，两态逐字相同。**胶囊版这条不再成立**——
// 汇总态一行也画胶囊。它本来钉的是「detail 不会走出一条自己的路」，换成直接钉明细态的
// 形态：一条 pill 指令都没有；后面那条阳性对照保证这不是空转。
assert.deepStrictEqual(
  detailLayout.commands.filter(function (item) {
    return item.type === 'pill'
  }),
  [],
  '明细态不该有任何胶囊指令'
)
assert.ok(
  layout.commands.some(function (item) {
    return item.type === 'pill'
  }),
  '汇总态必须画胶囊——否则上面那条「明细态没有胶囊」是空转的'
)

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
// 「规格」是**列表头**，只有明细态有；汇总态规格进了胶囊，所以这条对着明细态提。
assert.ok(textsOf(slipImage.layoutSlip(sampleSlip({
  lines: [{
    id: 'u1',
    productName: '短袖 T恤',
    specText: '黑色 · M',
    qtyText: '1',
    priceText: '59.00',
    amountText: '59.00'
  }]
}), null, { exportStyle: 'detail' })).indexOf('规格') >= 0)
// 取值两态都要印得出来：明细态在规格列，汇总态在胶囊文字里（「黑色 · M ×1」）。
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
// 同上：四轴并成的那一列叫「规格」，是明细态的列表头。
assert.ok(textsOf(slipImage.layoutSlip(sampleSlip({ lines: mixedLines }), null,
  { exportStyle: 'detail' })).indexOf('规格') >= 0)
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
// 「尺码」是轴名，明细态才当列表头印；汇总态胶囊里只有取值（「黑色/M ×2」）。
assert.ok(textsOf(slipImage.layoutSlip(named, null, { exportStyle: 'detail' })).indexOf('尺码') >= 0)
assert.ok(textsOf(slipImage.layoutSlip(named)).indexOf('黑色/M ×2') >= 0)

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
const longSkuSlip = sampleSlip({
  lines: [Object.assign({}, sampleSlip().lines[0], { sku: 'TS-005-EXTRA-LONG-CODE' })]
})
// 货号列量出来更宽，居中表头会右移，并把它右边的品名列整体右推。
// **货号列只有明细态有**（汇总态货号在品名格第二行，不占列），所以这两条对着明细态提。
const shortSkuDetail = slipImage.layoutSlip(sampleSlip(), null, { exportStyle: 'detail' })
const longSkuDetail = slipImage.layoutSlip(longSkuSlip, null, { exportStyle: 'detail' })
assert.ok(headX(longSkuDetail, '货号') > headX(shortSkuDetail, '货号'))
assert.ok(headX(longSkuDetail, '品名') > headX(shortSkuDetail, '品名'))

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
// 汇总态：规格胶囊（2026-09-07 由矩阵版逐块迁过来）
//
// 形态换了：不再是「行=规格一取值、列=规格二取值、格内件数」的交叉表，而是
// **一个商品 + 一个单价 = 一行，规格进数量格画成等宽胶囊**。所以汇总态
// **没有货号列、没有规格列**，四列是 品名 / 数量 / 单价 / 金额；货号在品名格第二行；
// 胶囊文字形如「黑色/M ×3」；一格 2 枚以上时末尾多一枚深底白字的合计胶囊「小计 N 件」。
//
// 每删掉一块之前都先问「它防的那件事在胶囊版上还会不会发生」。会，就换个形态留下来；
// 不会，把原因记在这儿——**跟着矩阵一起消失的判据，逐条在案**：
//
//  · 矩阵化的六条否决条件（节行数 >= 2 / 轴恰好 2 根 / 节内轴名一致 / 列轴取值数 <= 6 /
//    压缩收益 / 不得撑宽画布）连同它们的翻转夹具和对照组一起删了。交叉表要付「节头 +
//    表头 + 节尾」三行固定开销，才需要「压缩收益」那道闸；它把规格摊在**横轴**上，才需要
//    列数上限和「不许比平铺更宽」。胶囊几乎零开销、而且是**纵向**排的，这些闸门连同它们
//    要挡的那件事一起不存在了。
//    **只有单价那一条活了下来，而且换了身份**：不再是「不同价就不矩阵化」，而是
//    「不同价拆成两行」——见下面第 3 节。
//  · 「分节表格」的一整套（平铺节复用整表列定义 / 相邻平铺节合并表头 / 不连续平铺节各画
//    一次表头）删了：胶囊版全表只有一张表、一套列定义、一份表头，多节表格这个结构没了。
//    结构没了不等于判据没了——「全表恒一份表头」下面钉着；当年那条会让内容画到画布外的
//    夹具（钢材 9 位数金额）也留着，进了越界扫描。
//  · 矩阵格寻址 grid[行轴值][列轴值] 删了，针对 grid 的那部分 Object.prototype 钉子跟着删。
//    **判据留着**：拿用户数据当对象键这件事胶囊版还在做一次（slicePillGroups 按 priceText
//    分组），钉子挪到那个键上，见第 15 节。
//
// 本段所有几何判据都落在 layoutSlip 吐出的坐标上，**不看渲染结果**。这一轮预览器骗过两次
// （一次横向出框、一次竖向错位），两次都是预览器自己的失真，布局坐标是对的。
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

// 按 颜色 x 尺码 铺满一个商品的规格；skip(color, size) 返回 true 的组合不生成（缺货）。
// 件数按生成顺序 1、2、3…，所以「第 k 个组合的件数 = k」，手算期望值时用得上。
// 金额恒等于 件数 x 单价 —— 下面「金额 = 件数之和 x 单价」那条不变量靠这个前提。
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

// hasCustomer: false + operatorText 显式给值：避免「经手人」缺省兜底的 '—' 混进按字符串
// 搜索的断言里。remark 清空，免得备注文字混进表格的文本序列。
function pillFixtureSlip(lines, overrides) {
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

function pillCmds(layout) {
  return layout.commands.filter(function (item) {
    return item.type === 'pill'
  })
}

function uniq(list) {
  const out = []
  list.forEach(function (item) {
    if (out.indexOf(item) < 0) out.push(item)
  })
  return out
}

// 画布常量。slip-image.js 没导出，这里照抄——和本文件里已有的 1700 硬编码同一个待遇。
const PAD = 36
const CELL_PAD_X = 24
const LINE_H = 65

function fontSizeOf(font) {
  return Number(/(\d+)px/.exec(font)[1])
}

// ---------------------------------------------------------------------------
// 把 layoutSlip 的指令流解回「表格行」。绘制顺序是固定的（见 layoutTable）：先画外框和
// 横分隔线，再画表头文字，然后逐行逐列画内容，列序是 品名 / 数量 / 单价 / 金额。
// 行的上下沿取自**画出来的横分隔线**，所以这个解析器本身就在核对「内容落在自己那一行里」。
// ---------------------------------------------------------------------------
function tableBands(layout, label) {
  const box = layout.commands.filter(function (item) {
    return item.type === 'stroke'
  })
  assert.strictEqual(box.length, 1, label + '：货物表格应当恰好画一个外框，实测 ' + box.length + ' 个')
  const top = box[0].y
  const bottom = box[0].y + box[0].h
  const seps = layout.commands.filter(function (item) {
    return item.type === 'line' && item.y1 === item.y2 && item.y1 > top + 0.5 && item.y1 <= bottom + 0.5
  }).map(function (item) {
    return item.y1
  }).sort(function (a, b) {
    return a - b
  })
  assert.ok(seps.length >= 2,
    label + '：表格里至少要有「表头下沿 + 一行下沿」两条横线，实测 ' + seps.length + ' 条')
  const bands = []
  for (let i = 0; i < seps.length - 1; i++) bands.push({ top: seps[i], bottom: seps[i + 1] })
  return { boxTop: top, boxBottom: bottom, headH: seps[0] - top, bands: bands }
}

// 一行解成 { name: [品名格逐行文字], pills: [{box, text}], price, amount, plainQty }。
// 胶囊按绘制序取，紧跟每条 pill 指令的那条中线文字就是它的文字（pushPillOf 保证相邻）。
function summaryRowsOf(layout, label) {
  const info = tableBands(layout, label)
  return info.bands.map(function (band) {
    const inBand = layout.commands.filter(function (item) {
      const y = item.type === 'line' ? item.y1 : item.y
      return y > band.top - 0.5 && y < band.bottom + 0.5
    })
    const pills = []
    inBand.forEach(function (item, index) {
      if (item.type !== 'pill') return
      const next = inBand[index + 1]
      assert.ok(next && next.type === 'text' && next.baseline === 'middle',
        label + '：每枚胶囊后面都应紧跟一条中线对齐的文字，实测 ' + JSON.stringify(next))
      pills.push({ box: item, text: next })
    })
    const texts = inBand.filter(function (item) {
      return item.type === 'text' && item.baseline !== 'middle'
    })
    const rights = texts.filter(function (item) {
      return item.align === 'right'
    }).sort(function (a, b) {
      return a.x - b.x
    })
    return {
      band: band,
      name: texts.filter(function (item) {
        return item.align === 'left'
      }).sort(function (a, b) {
        return a.y - b.y
      }).map(function (item) {
        return item.text
      }),
      pills: pills,
      pillTexts: pills.map(function (item) {
        return item.text.text
      }),
      plainQty: texts.filter(function (item) {
        return item.align === 'center'
      }).map(function (item) {
        return item.text
      }),
      price: rights[0] && rights[0].text,
      amount: rights[1] && rights[1].text
    }
  })
}

// ---------------------------------------------------------------------------
// 几何自检。本次改动最容易出错的两件事，原来只是 scratchpad 里的一次性脚本，收成常驻断言。
// 只读坐标，不经过任何渲染器：
//   1) 胶囊两两不重叠
//   2) 每条胶囊文字的盒子落在自己那枚胶囊框内（baseline:'middle'，所以文字盒顶端 = y - 字号/2）
// estimateWidth 就是 layoutSlip 排版时用的那个度量函数（测试传 measure=null 时的默认值），
// 所以这里算出来的文字宽度和排版时用的**是同一个数**，不是近似。
// ---------------------------------------------------------------------------
function assertPillGeometry(layout, label) {
  const pills = pillCmds(layout)
  // 阳性对照：这条自检只对真有胶囊的单据有意义，一枚都没有说明夹具或导出模式给错了。
  assert.ok(pills.length > 0, label + '：这张单一枚胶囊都没有，几何自检会空跑')

  for (let i = 0; i < pills.length; i++) {
    for (let j = i + 1; j < pills.length; j++) {
      const a = pills[i]
      const b = pills[j]
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      assert.ok(!hit, label + '：第 ' + i + ' 枚胶囊 (' + a.x + ',' + a.y + ' ' + a.w + 'x' + a.h
        + ') 和第 ' + j + ' 枚 (' + b.x + ',' + b.y + ' ' + b.w + 'x' + b.h + ') 重叠了')
    }
  }

  const cmds = layout.commands
  let paired = 0
  cmds.forEach(function (cmd, index) {
    if (cmd.type !== 'pill') return
    const t = cmds[index + 1]
    assert.ok(t && t.type === 'text' && t.baseline === 'middle',
      label + '：第 ' + paired + ' 枚胶囊后面没有紧跟中线对齐的文字')
    paired++
    const w = slipImage.estimateWidth(t.text, t.font)
    const h = fontSizeOf(t.font)
    const left = t.align === 'center' ? t.x - w / 2 : t.x
    const top = t.y - h / 2
    assert.ok(left >= cmd.x - 0.5,
      label + '：胶囊文字「' + t.text + '」左边出框 ' + (cmd.x - left).toFixed(1) + 'px')
    assert.ok(left + w <= cmd.x + cmd.w + 0.5,
      label + '：胶囊文字「' + t.text + '」右边出框 ' + (left + w - cmd.x - cmd.w).toFixed(1) + 'px')
    assert.ok(top >= cmd.y - 0.5,
      label + '：胶囊文字「' + t.text + '」上边出框 ' + (cmd.y - top).toFixed(1) + 'px')
    assert.ok(top + h <= cmd.y + cmd.h + 0.5,
      label + '：胶囊文字「' + t.text + '」下边出框 ' + (top + h - cmd.y - cmd.h).toFixed(1) + 'px')
  })
  assert.strictEqual(paired, pills.length,
    label + '：配对到的胶囊 ' + paired + ' 枚，实际 ' + pills.length + ' 枚')
}

// ---------------------------------------------------------------------------
// 越界扫描：任何一条绘制指令都不许画到画布外。画布外的东西在导出图上直接不存在。
// **pill 也要算进来**——矩阵版没有这个指令类型，漏掉它整列胶囊就是扫描的盲区。
// 断言越界必须真的抓住越界，不能写成恒真：align:'right' 的指令 x 本身就是右边界，
// align:'center' 要把文字宽度折算成右边界，align:'left'（含 rect/stroke/pill/line）按左边 + 宽度算。
// ---------------------------------------------------------------------------
function rightEdgeOf(cmd, measure) {
  if (cmd.type === 'text') {
    const w = measure(cmd.text, cmd.font)
    if (cmd.align === 'right') return cmd.x
    if (cmd.align === 'center') return cmd.x + w / 2
    return cmd.x + w
  }
  if (cmd.type === 'rect' || cmd.type === 'stroke' || cmd.type === 'pill') return cmd.x + cmd.w
  if (cmd.type === 'line') return Math.max(cmd.x1, cmd.x2)
  return 0
}
function leftEdgeOf(cmd, measure) {
  if (cmd.type === 'text') {
    const w = measure(cmd.text, cmd.font)
    if (cmd.align === 'right') return cmd.x - w
    if (cmd.align === 'center') return cmd.x - w / 2
    return cmd.x
  }
  if (cmd.type === 'rect' || cmd.type === 'stroke' || cmd.type === 'pill') return cmd.x
  if (cmd.type === 'line') return Math.min(cmd.x1, cmd.x2)
  return 0
}
function assertInside(layout, label) {
  const over = layout.commands.filter(function (cmd) {
    return rightEdgeOf(cmd, slipImage.estimateWidth) > layout.width + 0.5
  })
  assert.deepStrictEqual(over, [], label + '：有 ' + over.length + ' 条指令画到画布右边界('
    + layout.width + ')外 -> ' + JSON.stringify(over.slice(0, 6)))
  const under = layout.commands.filter(function (cmd) {
    return leftEdgeOf(cmd, slipImage.estimateWidth) < -0.5
  })
  assert.deepStrictEqual(under, [], label + '：有 ' + under.length + ' 条指令画到画布左边界外 -> '
    + JSON.stringify(under.slice(0, 6)))
}

// ---------------------------------------------------------------------------
// 1) 分节：A、B、A 三行 -> 两节，第一节 2 行（顺序不变，不连续的同商品行仍归一节）。
//    胶囊版复用的就是这个 sliceLineSections，这条判据原样成立。
// ---------------------------------------------------------------------------
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

// 分节按 productId，不按「品名 + 货号」。品名没有唯一性校验（createProduct 只校验非空）、
// 货号可空，两个**不同商品**同名且都没填货号时，旧 key 会把它们并进同一组：一行印一个品名、
// 合计跨商品求和。pages/sale/sale.js 的 mergeLines 挡不住——它按 product.id + specKey 合并，
// 只在单个商品内去重，跨商品的同名碰撞它看不见。
assert.strictEqual(slipImage.sliceLineSections([
  specLine({ id: 'n1', productId: 'p-1', productName: '短袖', sku: '' }),
  specLine({ id: 'n2', productId: 'p-2', productName: '短袖', sku: '' })
]).length, 2, '两个同名且都没填货号的商品必须按 productId 分成两节')
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

// 分节 key 的分隔符一直是 U+0000（源码里写转义形式、不写裸字节，理由见 4-7）。
// 这条钉子防的是有人把它退回空格：品名本身含空格时，两个不同的 (品名,货号) 组合会拼出
// 同一个字符串（'短袖 T'+'TS' 与 '短袖'+'T TS' 都拼成 '短袖 T TS'），那时才会被并成一节。
// 它查的是**分组行为**；4-7 查的是**字节**，两回事，都要留着。
assert.strictEqual(slipImage.sliceLineSections([
  specLine({ id: 'coll-a', productName: '短袖 T', sku: 'TS' }),
  specLine({ id: 'coll-b', productName: '短袖', sku: 'T TS' })
]).length, 2, '品名+货号拼接后撞车的两个不同商品不该被并成一节')

// withSlipView 要把 productId 带下来，否则上面那条分节永远走不到 id 分支。
const twoProductSlip = util.withSlipView({
  id: 'order-two-product',
  createdAt: new Date('2026-08-15T12:00:00').getTime(),
  amount: 118,
  paidAmount: 118,
  lines: [
    { lineId: 'tp1', productId: 'p-1', productName: '短袖', qty: 1, unitPrice: 59, amount: 59 },
    { lineId: 'tp2', productId: 'p-2', productName: '短袖', qty: 1, unitPrice: 59, amount: 59 }
  ]
}, 0)
assert.strictEqual(twoProductSlip.lines[0].productId, 'p-1', 'withSlipView 要把 productId 带到送货单行上')
assert.strictEqual(twoProductSlip.lines[1].productId, 'p-2', 'withSlipView 要把 productId 带到送货单行上')
// 只加这一个字段，别的取值一个都不许动。
assert.strictEqual(twoProductSlip.lines[0].productName, '短袖')
assert.strictEqual(twoProductSlip.lines[0].qtyText, '1')
assert.strictEqual(twoProductSlip.lines[0].priceText, '59.00')
assert.strictEqual(twoProductSlip.lines[0].amountText, '59.00')
assert.strictEqual(twoProductSlip.lines[0].sku, '')
assert.strictEqual(slipImage.sliceLineSections(twoProductSlip.lines).length, 2,
  'withSlipView 出来的两个同名无货号商品要分成两节')

// ---------------------------------------------------------------------------
// 2) 汇总态的形态：四列，没有货号列和规格列，规格进胶囊。
// ---------------------------------------------------------------------------
const gridLines2x2 = gridLines(['黑色', '白色'], ['M', 'L'])
const layout2x2 = slipImage.layoutSlip(pillFixtureSlip(gridLines2x2))

assert.ok(!hasText(layout2x2, '货号'), '汇总态没有货号列——货号在品名格第二行')
assert.ok(!hasText(layout2x2, '颜色'), '汇总态没有规格列——「颜色」是轴名，只有明细态当表头印')
assert.ok(!hasText(layout2x2, '尺码'), '汇总态没有规格列——「尺码」同上')
;['品名', '数量', '单价', '金额'].forEach(function (title) {
  assert.strictEqual(textCmds(layout2x2).filter(function (item) {
    return item.text === title
  }).length, 1, '汇总态全表恒一份表头，「' + title + '」应当只出现一次')
})

// 逐值断言：把整张表按绘制顺序展开，和手算的期望值 deepStrictEqual，改任何一个数都会红在
// 具体位置上。件数按 gridLines 的生成顺序 1..4：黑M=1 黑L=2 白M=3 白L=4，合计 10 件，
// 单价 59.00，金额 (1+2+3+4) x 59 = 590.00。
// 这条同时替掉矩阵版的「列口径保真」：品名/货号/胶囊/单价/金额按列序连续出现，
// 串到别的行会打断这串连续。
const texts2x2 = textCmds(layout2x2).map(function (item) {
  return item.text
})
const head2x2 = texts2x2.indexOf('品名')
assert.ok(head2x2 >= 0, '2色x2码：文本序列里找不到表头「品名」')
assert.deepStrictEqual(
  texts2x2.slice(head2x2, head2x2 + 13),
  [
    '品名', '数量', '单价', '金额',
    '短袖 T恤', 'TS-005',
    '黑色/M ×1', '黑色/L ×2', '白色/M ×3', '白色/L ×4', '小计 10 件',
    '59.00', '590.00'
  ],
  '2色x2码：汇总态画出来的文本序列和逐格手算的期望值不一致'
)

// 同一份数据的明细态：一行一条原始流水、规格分列、货号自成一列、一条 pill 指令都没有。
const detail2x2 = slipImage.layoutSlip(pillFixtureSlip(gridLines2x2), null, { exportStyle: 'detail' })
assert.deepStrictEqual(pillCmds(detail2x2), [], '明细态不该有胶囊')
assert.ok(hasText(detail2x2, '货号') && hasText(detail2x2, '颜色') && hasText(detail2x2, '尺码'),
  '明细态货号、规格轴各自成列')
assert.strictEqual(textCmds(detail2x2).filter(function (item) {
  return item.text === 'TS-005'
}).length, gridLines2x2.length, '明细态每一行都印一次货号')
assert.strictEqual(textCmds(detail2x2).filter(function (item) {
  return item.text === '货号'
}).length, 1, '明细态也只画一份表头')

// 两种形态总件数、总金额相等——底部汇总区不看表格形态，只看 slip.lines 现算。
assert.strictEqual(labelValueText(layout2x2, '总数'), labelValueText(detail2x2, '总数'))
assert.strictEqual(labelValueText(layout2x2, '应收'), labelValueText(detail2x2, '应收'))
assert.strictEqual(labelValueText(layout2x2, '实收'), labelValueText(detail2x2, '实收'))

// ---------------------------------------------------------------------------
// 3) 分组：同一商品的多条规格并成一行；**单价不同的规格拆成两行**。
//    这是矩阵版「条件 4（节内单价逐字相同）」唯一活下来的那条判据，换了身份：
//    从「不同价就不矩阵化」变成「不同价拆成两行」。理由没变——单价并进一行之后，
//    客户核单的算式就是「胶囊件数之和 x 单价 = 金额」，单价不统一这条算式不成立。
// ---------------------------------------------------------------------------
const twoPriceLines = [
  specLine({ id: 'pp1', productId: 'P', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }], qtyText: '2', priceText: '59.00', amountText: '118.00' }),
  specLine({ id: 'pp2', productId: 'P', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'L' }], qtyText: '3', priceText: '59.00', amountText: '177.00' }),
  specLine({ id: 'pp3', productId: 'P', specParts: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'M' }], qtyText: '4', priceText: '65.00', amountText: '260.00' })
]
const twoPriceLayout = slipImage.layoutSlip(pillFixtureSlip(twoPriceLines))
const twoPriceRows = summaryRowsOf(twoPriceLayout, '同商品两种单价')
assert.strictEqual(twoPriceRows.length, 2,
  '同一商品的两种单价必须拆成两行，实测 ' + twoPriceRows.length + ' 行')
assert.deepStrictEqual(
  twoPriceRows.map(function (row) {
    return { name: row.name, pills: row.pillTexts, price: row.price, amount: row.amount }
  }),
  [
    { name: ['短袖 T恤', 'TS-005'], pills: ['黑色/M ×2', '黑色/L ×3', '小计 5 件'], price: '59.00', amount: '295.00' },
    { name: ['短袖 T恤', 'TS-005'], pills: ['白色/M ×4'], price: '65.00', amount: '260.00' }
  ],
  '拆出来的两行：各自只放自己那个单价的规格，金额是本行各条流水金额之和'
)
// 拆开之后**单价列每行恒定一个值**——这就是拆行想换来的那件事，直接钉住：
// 画出来的那个单价，在这一行对应的流水里必须条条都是它。
twoPriceRows.forEach(function (row, index) {
  const own = twoPriceLines.filter(function (line) {
    return line.priceText === row.price
  })
  assert.ok(own.length > 0, '第' + index + '行的单价 ' + row.price + ' 在夹具里找不到对应流水')
  assert.strictEqual(row.pillTexts.filter(function (text) {
    return !/^小计 .+ 件$/.test(text)
  }).length, own.length,
  '第' + index + '行的规格胶囊数应等于该单价下的流水条数')
})
// 同一商品**同一单价**的多条规格必须并成一行（否则上面那条「拆」是空话）。
assert.strictEqual(summaryRowsOf(layout2x2, '2色x2码').length, 1,
  '同一商品同一单价的 4 条规格必须并成一行')

// ---------------------------------------------------------------------------
// 4) 合计胶囊：一格 2 枚以上才出；只有一枚时**不出**（合计等于它自己，纯废话）。
//    文字是「小计 N 件」，N 等于这一组各胶囊件数之和。
//    长相也不一样：深底白字，规格胶囊浅底深字；字号字重必须相同——加粗会让文字比量出来的
//    盒子宽，又变回「文字超出胶囊」。
// ---------------------------------------------------------------------------
function totalPillOf(row) {
  const hits = row.pills.filter(function (item) {
    return /^小计 .+ 件$/.test(item.text.text)
  })
  assert.ok(hits.length <= 1, '一格里最多一枚合计胶囊，实测 ' + hits.length + ' 枚')
  return hits[0]
}
function specPillsOf(row) {
  return row.pills.filter(function (item) {
    return !/^小计 .+ 件$/.test(item.text.text)
  })
}
function pillQty(item, label) {
  const m = / ×(\d+(?:\.\d+)?)$/.exec(item.text.text)
  assert.ok(m, label + '：胶囊文字「' + item.text.text + '」不是「规格 ×件数」的形状')
  return Number(m[1])
}
function assertTotalPill(row, label) {
  const spec = specPillsOf(row)
  const total = totalPillOf(row)
  if (spec.length < 2) {
    assert.strictEqual(total, undefined,
      label + '：这一格只有 ' + spec.length + ' 枚规格胶囊，不该出合计胶囊')
    return
  }
  assert.ok(total, label + '：这一格有 ' + spec.length + ' 枚规格胶囊，应当出合计胶囊')
  // N 由各枚胶囊文字里的「×件数」相加得出——从**画出来的字**反解，不抄夹具。
  const sum = spec.reduce(function (acc, item) {
    return acc + pillQty(item, label)
  }, 0)
  assert.strictEqual(total.text.text, '小计 ' + sum + ' 件',
    label + '：合计胶囊应为各枚胶囊件数之和 ' + sum + '，实测「' + total.text.text + '」')
  assert.strictEqual(row.pills[row.pills.length - 1], total, label + '：合计胶囊要排在这一格的最后')
  assert.notStrictEqual(total.box.fill, spec[0].box.fill, label + '：合计胶囊底色应与规格胶囊不同')
  assert.notStrictEqual(total.text.color, spec[0].text.color, label + '：合计胶囊字色应与规格胶囊不同')
  assert.strictEqual(total.text.font, spec[0].text.font,
    label + '：合计胶囊字号字重与规格胶囊必须相同——加粗会让文字比量出来的盒子宽、又出框')
}
summaryRowsOf(layout2x2, '2色x2码').forEach(function (row) {
  assertTotalPill(row, '2色x2码')
})
twoPriceRows.forEach(function (row, index) {
  assertTotalPill(row, '同商品两种单价第' + index + '行')
})
// 只有一枚：单商品单规格。**默认导出样式就是汇总，这是最常见的那种单子**，单独钉一条。
const singleSpecLines = [specLine({
  specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }],
  qtyText: '2',
  amountText: '118.00'
})]
const singleSpecLayout = slipImage.layoutSlip(pillFixtureSlip(singleSpecLines))
const singleSpecRows = summaryRowsOf(singleSpecLayout, '单商品单规格')
assert.strictEqual(singleSpecRows.length, 1)
assert.deepStrictEqual(singleSpecRows[0].pillTexts, ['黑色/M ×2'],
  '单商品单规格：只画一枚规格胶囊，不出合计胶囊')
assertTotalPill(singleSpecRows[0], '单商品单规格')

// ---------------------------------------------------------------------------
// 5) 货号：**每一组都要印**，包括只有一条规格的组。
//    上一版为省 65px 写了「只在 >=2 条规格时才印品名格第二行」，结果单商品单规格的单子
//    货号整个不见了——而默认导出样式就是汇总，那是最常见的单子。省版面不能省掉单据字段。
// ---------------------------------------------------------------------------
assert.deepStrictEqual(singleSpecRows[0].name, ['短袖 T恤', 'TS-005'],
  '单规格的组也要印货号（品名第一行、货号第二行）')
summaryRowsOf(layout2x2, '2色x2码').forEach(function (row) {
  assert.deepStrictEqual(row.name, ['短袖 T恤', 'TS-005'], '多规格的组同样印货号')
})
// 货号为空的组：只印品名，不出现「未填」（与前面 blankSku 那条老断言同款要求）。
const blankSkuLines = gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
  return Object.assign({}, line, { sku: '未填' })
})
const blankSkuLayout = slipImage.layoutSlip(pillFixtureSlip(blankSkuLines))
assert.deepStrictEqual(summaryRowsOf(blankSkuLayout, '货号为空')[0].name, ['短袖 T恤'],
  '货号为空的组品名格只有一行，不印「未填」')
assert.ok(textsOf(blankSkuLayout).indexOf('未填') < 0)

// ---------------------------------------------------------------------------
// 6) 等宽：同一次导出里所有胶囊宽度相同（每排枚数因此固定、上下排对齐成列）。
// ---------------------------------------------------------------------------
function assertEqualPillWidth(layout, label) {
  const pills = pillCmds(layout)
  assert.ok(pills.length > 0, label + '：一枚胶囊都没有，等宽断言会空转')
  const widths = uniq(pills.map(function (item) {
    return item.w
  }))
  assert.strictEqual(widths.length, 1,
    label + '：同一次导出里胶囊宽度应当全部相同，实测 ' + JSON.stringify(widths))
  const heights = uniq(pills.map(function (item) {
    return item.h
  }))
  assert.strictEqual(heights.length, 1,
    label + '：胶囊高度应当全部相同（高度是常量，不随文字长短变），实测 ' + JSON.stringify(heights))
}

// ---------------------------------------------------------------------------
// 7) 同一规格出现多行时**不许合并、不许覆盖**。矩阵版这里防的是「同一 (行,列) 格被后写的行
//    覆盖先写的」，代价是「可见格之和 != 小计」。胶囊版没有格，但同一个失效形态换个门进来
//    仍然可能：有人给胶囊按规格去重，两条 (黑色,S) 就只剩一枚、件数丢一半。
// ---------------------------------------------------------------------------
const dupSpecLines = [
  specLine({ id: 'dup-a', productId: 'D', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }], qtyText: '2', amountText: '118.00' }),
  specLine({ id: 'dup-b', productId: 'D', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'S' }], qtyText: '3', amountText: '177.00' }),
  specLine({ id: 'dup-c', productId: 'D', specParts: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'M' }], qtyText: '4', amountText: '236.00' })
]
const dupLayout = slipImage.layoutSlip(pillFixtureSlip(dupSpecLines))
assert.deepStrictEqual(
  summaryRowsOf(dupLayout, '同规格两行')[0].pillTexts,
  ['黑色/S ×2', '黑色/S ×3', '黑色/M ×4', '小计 9 件'],
  '同规格的两条流水各出一枚胶囊，不许合并或覆盖；合计是全部之和 2+3+4=9'
)

// ---------------------------------------------------------------------------
// 8) 无规格的行：数量格退回纯数字，不画胶囊；和有规格的商品混排时互不干扰。
//    （矩阵版这里是「A 节矩阵化、B 节退回平铺，两者同表互不干扰」，同一件事换了形态。）
// ---------------------------------------------------------------------------
const mixedShapeLines = gridLines(['黑色', '白色'], ['S', 'M', 'L']).concat([
  specLine({ id: 'milk', productId: 'MILK', productName: '纯牛奶 250ml', sku: 'MK-001', qtyText: '6', priceText: '4.50', amountText: '27.00' })
])
const mixedShapeLayout = slipImage.layoutSlip(pillFixtureSlip(mixedShapeLines))
const mixedShapeRows = summaryRowsOf(mixedShapeLayout, '有规格+无规格混排')
assert.strictEqual(mixedShapeRows.length, 2)
assert.strictEqual(mixedShapeRows[0].pillTexts.length, 7, '有规格那组：6 枚规格胶囊 + 1 枚合计')
assert.deepStrictEqual(mixedShapeRows[1].pillTexts, [], '无规格那组一枚胶囊都不画')
assert.deepStrictEqual(mixedShapeRows[1].plainQty, ['6'], '无规格那组数量格退回纯数字')
assert.deepStrictEqual(mixedShapeRows[1].name, ['纯牛奶 250ml', 'MK-001'])

// 两个同名无货号商品各自 2 色 x 3 码：必须各成一组、各自算合计（21 / 57 件），
// 不能因为品名相同被并成一组求和（78 件）。
function productGrid(productId, colors, startQty) {
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
const sameNameLines = productGrid('p-1', ['黑色', '白色'], 1).concat(productGrid('p-2', ['红色', '蓝色'], 7))
const sameNameLayout = slipImage.layoutSlip(pillFixtureSlip(sameNameLines))
assert.deepStrictEqual(
  textCmds(sameNameLayout).filter(function (item) {
    return /^小计 .+ 件$/.test(item.text)
  }).map(function (item) {
    return item.text
  }),
  ['小计 21 件', '小计 57 件'],
  '两个同名无货号商品必须各自成组、各自算合计，不能并成一组求和'
)

// ---------------------------------------------------------------------------
// 9) 算术不变量：从**实际画出来的文本**反解，检查三层口径对得上——
//      各胶囊件数之和 == 合计胶囊 N（在 assertTotalPill 里）
//      各行件数之和   == 底部汇总区「总数」
//      各行金额之和   == 各条流水金额之和
//    再加一条客户在单子上真会做的算式：**本行金额 == 本行件数之和 x 本行单价**。
//    最后这条只对「金额 == 件数 x 单价」的夹具成立，所以由调用方声明（priceTimesQty）。
//    这一层不依赖手算期望值，加夹具不用改断言。
// ---------------------------------------------------------------------------
function assertArithmetic(lines, label, priceTimesQty) {
  const layout = slipImage.layoutSlip(pillFixtureSlip(lines))
  const rows = summaryRowsOf(layout, label)
  let slipQty = 0
  rows.forEach(function (row, index) {
    const spec = specPillsOf(row)
    let qty
    if (spec.length) {
      qty = spec.reduce(function (acc, item) {
        return acc + pillQty(item, label + ' 第' + index + '行')
      }, 0)
      assertTotalPill(row, label + ' 第' + index + '行')
    } else {
      assert.strictEqual(row.plainQty.length, 1,
        label + '：第' + index + '行没有胶囊，数量格应当恰好一个数字，实测 ' + JSON.stringify(row.plainQty))
      qty = Number(row.plainQty[0])
    }
    if (priceTimesQty) {
      const expect = (Math.round(qty * Number(row.price) * 100) / 100).toFixed(2)
      assert.strictEqual(row.amount, expect,
        label + '：第' + index + '行金额 ' + row.amount + ' != 件数之和 ' + qty
          + ' x 单价 ' + row.price + ' = ' + expect
          + '（这就是客户拿着单子核账的那条算式，对不上代价很高）')
    }
    slipQty += qty
  })
  assert.strictEqual(slipQty + ' 件', labelValueText(layout, '总数'),
    label + '：各行件数之和 ' + slipQty + ' 件 != 单据总数 ' + labelValueText(layout, '总数'))
  const drawnSum = rows.reduce(function (acc, row) {
    return acc + Number(row.amount)
  }, 0)
  const lineSum = lines.reduce(function (acc, line) {
    return acc + Number(line.amountText)
  }, 0)
  assert.strictEqual(Math.round(drawnSum * 100), Math.round(lineSum * 100),
    label + '：各行金额之和 ' + drawnSum.toFixed(2) + ' != 各条流水金额之和 ' + lineSum.toFixed(2))
}

// ---------------------------------------------------------------------------
// 夹具定义。下面 10) 和 11) 两节共用。里面既有本节新造的，也有矩阵版留下来、当年抓过真
// bug 的那几个（钢材 9 位数单价、长品名、6 列长取值）——矩阵形态没了但夹具还危险，留着。
// ---------------------------------------------------------------------------
function nCharSizes(n, charCount) {
  const digits = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  const list = []
  for (let i = 0; i < n; i++) list.push(digits[i] + '码'.repeat(charCount - 1))
  return list
}
const col3Lines = gridLines(['黑色', '白色', '蓝色'], nCharSizes(6, 3))
const col13Lines = gridLines(['黑色', '白色', '蓝色'], nCharSizes(6, 13))
// 钢材：长品名 + 长货号 + 9 位数单价 + 12 位数金额，一起把可用宽度挤到底。
// 金额取整数倍，好让「金额 == 件数 x 单价」那条不变量在这条夹具上也成立。
const steelLines = [
  specLine({
    id: 'steel-1',
    productId: 'STEEL',
    productName: '钢材钢材钢材钢材钢材',
    sku: 'ST-00000001',
    specParts: [{ name: '材质', value: '碳钢A型号' }, { name: '规格', value: '6.0毫米规格' }],
    qtyText: '1000',
    priceText: '123456789.00',
    amountText: '123456789000.00'
  }),
  specLine({
    id: 'steel-2',
    productId: 'STEEL',
    productName: '钢材钢材钢材钢材钢材',
    sku: 'ST-00000001',
    specParts: [{ name: '材质', value: '碳钢A型号' }, { name: '规格', value: '8.0毫米规格' }],
    qtyText: '2000',
    priceText: '123456789.00',
    amountText: '246913578000.00'
  })
]
const longName20 = '超'.repeat(20)
const longName36 = '超长'.repeat(18)
const longName60 = '超长'.repeat(30)
function longNameLines(name) {
  return gridLines(['黑色', '白色'], ['S', 'M', 'L']).map(function (line) {
    return Object.assign({}, line, { productName: name, sku: 'TS-005' })
  })
}
const grid3x4 = gridLines(['黑色', '白色', '灰色'], ['S', 'M', 'L', 'XL'])
const grid5x6 = gridLines(['黑', '白', '灰', '红', '蓝'].map(function (c) {
  return c + '色'
}), ['S', 'M', 'L', 'XL', '2XL', '3XL'])

// ---------------------------------------------------------------------------
// 10) 长品名：不许压到数量列的胶囊上，更不许画出画布。
//     矩阵版这条钉的是「节头长品名压到节头单价上」。胶囊版没有节头、品名回到了列里，
//     但**同一个失效形态换了个门进来**：汇总态品名格走的是 col.textLines（品名 / 货号两行），
//     而 layoutTable 原本对 textLines 是照搬不折行的——列宽是 fitColumns 压过的，
//     20 个汉字就已经盖住数量列（实测右边界 1180 > 品名列右边界 868），
//     36 个字直接画到画布外（右边界 2076 > 画布 1700），导出图上那截字就没了。
//     明细态品名走 wrapCell 没这个毛病，是汇总态改用 textLines 之后新出的。
//     **这是本次迁移逮到的实现缺陷，已在 utils/slip-image.js 的 layoutTable 里修掉。**
// ---------------------------------------------------------------------------
function assertNameCellFits(layout, fullName, label) {
  // 品名列的右边界 = 最左边那条竖分隔线（layoutTable 给 defs.slice(1) 每列画一条）。
  const bounds = layout.commands.filter(function (item) {
    return item.type === 'line' && item.x1 === item.x2
  }).map(function (item) {
    return item.x1
  }).sort(function (a, b) {
    return a - b
  })
  assert.ok(bounds.length >= 3, label + '：四列表格应当有三条竖分隔线，实测 ' + bounds.length + ' 条')
  const nameRight = bounds[0]
  const pieces = textCmds(layout).filter(function (item) {
    return item.align === 'left' && item.x === PAD + CELL_PAD_X && /^[超长]+$/.test(item.text)
  })
  assert.ok(pieces.length > 0, label + '：品名一个字都没画出来')
  assert.strictEqual(pieces.map(function (item) {
    return item.text
  }).join(''), fullName,
  label + '：品名被截断/改写了，画出来的是 ' + JSON.stringify(pieces.map(function (c) {
    return c.text
  })))
  const bands = tableBands(layout, label).bands
  pieces.forEach(function (piece, index) {
    const right = piece.x + slipImage.estimateWidth(piece.text, piece.font)
    assert.ok(right <= nameRight + 0.5,
      label + '：品名第' + index + '行右边界 ' + right.toFixed(1)
        + ' 越过品名列右边界 ' + nameRight + '，盖到数量列的胶囊上了')
    assert.ok(right <= layout.width + 0.5,
      label + '：品名第' + index + '行右边界 ' + right.toFixed(1)
        + ' 画到画布(' + layout.width + ')外了')
    // 竖向也要装得下：品名折出来的行不许越过本行下沿。
    // **别把这条当成「行高跟着行数长」的守卫**——那件事真正的守卫是下面 90 字品名那条
    // contentHeight 断言（实测过：把品名块的量高改坏，先红的是它）。这一条是**冗余的**：
    // summaryRowsOf 按横分隔线分带取内容，任何一行文字跑出自己那一带都会让 row.name 变形，
    // 上面每一条 row.name 断言都会先响。留着它只是为了在长品名这几个夹具上把「文字在本行内」
    // 这句话直接写出来、失败时报的是坐标而不是「名字数组对不上」。
    const band = bands.find(function (b) {
      return piece.y > b.top - 0.5 && piece.y < b.bottom + 0.5
    })
    assert.ok(band, label + '：品名第' + index + '行 y=' + piece.y + ' 落在任何一行的上下沿之外')
    assert.ok(piece.y + LINE_H <= band.bottom + 0.5,
      label + '：品名第' + index + '行底端 ' + (piece.y + LINE_H)
        + ' 越过本行下沿 ' + band.bottom + '（行高没跟着折行的行数长）')
  })
  return pieces
}
const long20Layout = slipImage.layoutSlip(pillFixtureSlip(longNameLines(longName20)))
const long36Layout = slipImage.layoutSlip(pillFixtureSlip(longNameLines(longName36)))
const long60Layout = slipImage.layoutSlip(pillFixtureSlip(longNameLines(longName60)))
const long20Pieces = assertNameCellFits(long20Layout, longName20, '20字品名')
const long36Pieces = assertNameCellFits(long36Layout, longName36, '36字品名')
const long60Pieces = assertNameCellFits(long60Layout, longName60, '60字品名')
assert.ok(long20Pieces.length >= 2, '20字品名：应当折行，实际只画了 ' + long20Pieces.length + ' 行')
assert.ok(long60Pieces.length > long36Pieces.length,
  '60字品名：折出来的行数应当比 36 字更多，实测 ' + long60Pieces.length + ' vs ' + long36Pieces.length)
// **这里不能写「品名越长图越高」**：这批夹具的行高是**胶囊块**决定的（6 枚规格 + 1 枚合计
// 一枚一排 = 7 排 x 74 = 518），品名折到 7 行（455）都还没顶到它，36 / 60 字实测**一样高**
// （contentHeight 都是 1364）。要看到「行高跟着品名长」，得让品名块真的超过胶囊块：
// 90 个汉字折 7 行 = 455 + 上下内边距，这时整张图才多出 2px（实测 1364 -> 1366）。
const longName90 = '超长'.repeat(45)
const long90Layout = slipImage.layoutSlip(pillFixtureSlip(longNameLines(longName90)))
assertNameCellFits(long90Layout, longName90, '90字品名')
assert.strictEqual(long36Layout.contentHeight, long60Layout.contentHeight,
  '36 字和 60 字品名的行高都由胶囊块决定，整张图应当一样高')
assert.ok(long90Layout.contentHeight > long60Layout.contentHeight,
  '90字品名：品名块终于超过胶囊块，行高必须跟着长，实测 '
    + long90Layout.contentHeight + ' vs ' + long60Layout.contentHeight)
// 短品名不受影响：还是一行、还是 FONT.name，不许被这条改动顺手降了字号。
const shortNameCmd = textCmds(layout2x2).find(function (item) {
  return item.text === '短袖 T恤'
})
assert.strictEqual(shortNameCmd.font, slipImage.FONT.name, '短品名不该被降字号')

// ---------------------------------------------------------------------------
// 11) 夹具清单扫描：几何自检 / 等宽 / 越界扫描 / 算术闭合铺到全部夹具上，越界扫描两态各跑
//     一遍。**放在 10) 之后**：越界扫描是粗筛（只看画布边界），长品名那条是细筛（还看列
//     边界）；顺序反过来的话 36 字品名会先红在越界扫描上，那条专用钉子永远轮不到自己响。
// ---------------------------------------------------------------------------
const PILL_FIXTURES = [
  ['单商品单规格', singleSpecLines],
  ['2色x2码', gridLines2x2],
  ['3色x4码', grid3x4],
  ['5色x6码', grid5x6],
  ['同商品两种单价', twoPriceLines],
  ['同规格两行', dupSpecLines],
  ['货号为空', blankSkuLines],
  ['同名不同商品', sameNameLines],
  ['有规格+无规格混排', mixedShapeLines],
  ['6列x3字', col3Lines],
  ['6列x13字', col13Lines],
  ['钢材9位数单价', gridLines(['黑色', '白色'], ['S', 'M', 'L']).concat(steelLines)],
  ['20字品名', longNameLines(longName20)],
  ['36字品名', longNameLines(longName36)],
  ['60字品名', longNameLines(longName60)]
]

PILL_FIXTURES.forEach(function (entry) {
  const label = entry[0]
  const layout = slipImage.layoutSlip(pillFixtureSlip(entry[1]))
  assertPillGeometry(layout, '几何自检/' + label)
  assertEqualPillWidth(layout, '等宽/' + label)
  assertInside(layout, '越界扫描/' + label)
  assertInside(slipImage.layoutSlip(pillFixtureSlip(entry[1]), null, { exportStyle: 'detail' }),
    '越界扫描(detail)/' + label)
  // 夹具全部满足「金额 == 件数 x 单价」：gridLines 是这么造的，手写的几条也照着对齐了。
  assertArithmetic(entry[1], '算术闭合/' + label, true)
})


// ---------------------------------------------------------------------------
// 12) 高度：这就是改动想换来的东西。**按实测钉，不钉一个没验证过的不等式。**
//     一组里有 2 条以上规格时汇总态更矮（规格并进一行，省掉的是行）。
//     **单商品单规格反而更高，而且正好高一个 LINE_H(65px)**——那是货号第二行的钱：
//     明细态货号自成一列、和品名同一行；汇总态货号在品名格第二行，行高多一行。
//     一分不多一分不少，所以用严格相等钉，不写「大约」。
// ---------------------------------------------------------------------------
;[
  ['2色x2码', gridLines2x2],
  ['3色x4码', grid3x4],
  ['5色x6码', grid5x6],
  ['同名不同商品', sameNameLines],
  ['货号为空', blankSkuLines]
].forEach(function (entry) {
  const su = slipImage.layoutSlip(pillFixtureSlip(entry[1]))
  const de = slipImage.layoutSlip(pillFixtureSlip(entry[1]), null, { exportStyle: 'detail' })
  assert.ok(su.contentHeight < de.contentHeight,
    '高度/' + entry[0] + '：每组都有 2 条以上规格，汇总态应当更矮，'
      + '实测 汇总 ' + su.contentHeight + ' vs 明细 ' + de.contentHeight)
})
;[
  ['单商品单规格', singleSpecLines],
  ['单商品单规格(长货号)', [specLine({
    id: 'z',
    productId: 'Z',
    productName: '纯牛奶 250ml',
    sku: 'MK-000123',
    specParts: [{ name: '口味', value: '原味' }],
    qtyText: '6',
    priceText: '4.50',
    amountText: '27.00'
  })]]
].forEach(function (entry) {
  const su = slipImage.layoutSlip(pillFixtureSlip(entry[1]))
  const de = slipImage.layoutSlip(pillFixtureSlip(entry[1]), null, { exportStyle: 'detail' })
  assert.strictEqual(su.contentHeight - de.contentHeight, LINE_H,
    '高度/' + entry[0] + '：单规格的组，汇总态比明细态**正好高一个 LINE_H(' + LINE_H + ')**，'
      + '那是货号第二行的高度，别的开销一分都不该有。实测 汇总 ' + su.contentHeight
      + ' - 明细 ' + de.contentHeight + ' = ' + (su.contentHeight - de.contentHeight))
})

// 行高不许无声长高。矩阵版这条钉的是「单行节头的底色条严格等于 98」——当年一个
// Math.max(headH, CELL_PAD_Y*2 + n*LINE_H) 让每一张既有单据的节头无条件长了 13px，而旁边
// 的注释声称「单行时逐字相同」，没有任何断言拦。胶囊版没有节头，等价物是**表头带 + 行高**：
// 这两个数一动，每一张单据都跟着变高。
// 用**字面量严格相等**，不写「!= 某个坏值」——后者只是针对那一个坏值的绊线；也不从常量
// 重新推一遍——那等于把生产代码抄进测试再断言自己写的东西。
;[['汇总态', layout2x2], ['明细态', detail2x2]].forEach(function (entry) {
  const headRects = entry[1].commands.filter(function (item) {
    return item.type === 'rect' && item.fill === '#F3F4F6'
  })
  // 阳性对照：过滤一旦失效，下面那条就是假绿。
  assert.strictEqual(headRects.length, 1,
    entry[0] + '：应当恰好抓到 1 条 #F3F4F6 的表头底色条，实测 ' + headRects.length
      + ' 条。抓不到就说明过滤失效，下面那条断言是假绿')
  assert.strictEqual(headRects[0].h, 98, entry[0] + '：表头带高度必须严格等于 98')
  assert.strictEqual(tableBands(entry[1], entry[0]).headH, 98,
    entry[0] + '：表头下沿到表格上沿的距离也必须是 98（底色条和分隔线不许对不上）')
})
function rowHeightsOf(layout, label) {
  return summaryRowsOf(layout, label).map(function (row) {
    return row.band.bottom - row.band.top
  })
}
assert.deepStrictEqual(rowHeightsOf(layout2x2, '2色x2码'), [194],
  '2色x2码汇总行高必须严格等于 194（= 上下内边距 46 + 两排胶囊 2x74）。'
    + '胶囊高度或排距一动，每一张汇总单都跟着变高，这条会红')
assert.deepStrictEqual(rowHeightsOf(singleSpecLayout, '单商品单规格'), [176],
  '单商品单规格汇总行高必须严格等于 176（= 46 + 品名格两行 2x65；两行品名比一排胶囊的 74 高，'
    + '所以是品名格决定行高）')
assert.deepStrictEqual(rowHeightsOf(detail2x2, '2色x2码明细'), [111, 111, 111, 111],
  '明细态行高必须严格等于 111（= 46 + 一行文字 65），一行一条流水')

// ---------------------------------------------------------------------------
// 13) 画布宽度：汇总态不该比明细态更宽（更宽 = 全单字号变小，那是这次改动最不想付的代价）。
//     矩阵版这条是「R1 明确要求」的本质不变量。胶囊版**只在常规规格取值下成立**：胶囊列的
//     下限是「最宽的那一枚」（再窄就要截断规格，单据上不许），所以规格串长到一定程度就会把
//     画布撑宽。实测（2026-09-07，3 个行取值 x 6 个列取值）：
//       每个规格取值 <= 13 个汉字 -> 汇总 1700 == 明细 1700
//       14 个汉字起              -> 汇总 1732 >  明细 1700
//     所以这条钉在 <=13 字这一段上（含 6列x13字 这个已经很极端的组合）。14 字以上撑宽是
//     **已知且尚未定夺的取舍**，不在这里钉一个假的不等式；越界扫描仍然盖着那一段，
//     所以撑宽只会让字变小，不会让内容消失。
// ---------------------------------------------------------------------------
;[
  ['单商品单规格', singleSpecLines],
  ['2色x2码', gridLines2x2],
  ['3色x4码', grid3x4],
  ['同商品两种单价', twoPriceLines],
  ['有规格+无规格混排', mixedShapeLines],
  ['6列x3字', col3Lines],
  ['6列x13字', col13Lines],
  ['60字品名', longNameLines(longName60)]
].forEach(function (entry) {
  const su = slipImage.layoutSlip(pillFixtureSlip(entry[1])).width
  const de = slipImage.layoutSlip(pillFixtureSlip(entry[1]), null, { exportStyle: 'detail' }).width
  assert.ok(su <= de, '画布宽度/' + entry[0] + '：汇总(' + su + ') 不该比明细(' + de + ')更宽')
})

// ---------------------------------------------------------------------------
// 14) exportStyle 的取值语义：**只认字面 'detail'**，其余一切取值——包括不传 options、
//     传 undefined、传别的字符串——都解析成 'summary'。这条从矩阵版就成立，换成胶囊之后照旧。
// ---------------------------------------------------------------------------
const styleSlip = pillFixtureSlip(gridLines2x2)
assert.deepStrictEqual(
  slipImage.layoutSlip(styleSlip),
  slipImage.layoutSlip(styleSlip, null, { exportStyle: 'summary' }),
  '不传 options 必须和显式 summary 逐字段相同'
)
assert.deepStrictEqual(
  slipImage.layoutSlip(styleSlip),
  slipImage.layoutSlip(styleSlip, null, { exportStyle: '不认识的值' }),
  '不认识的 exportStyle 必须夹成 summary'
)
assert.notDeepStrictEqual(
  slipImage.layoutSlip(styleSlip),
  slipImage.layoutSlip(styleSlip, null, { exportStyle: 'detail' }),
  '不传 options 不等于 detail'
)
// 直接证据：不传 options 时胶囊照画。上面那条 notDeepStrictEqual 只说明「两者不同」，
// 不说明「默认走的是汇总态」。
assert.ok(pillCmds(slipImage.layoutSlip(styleSlip)).length > 0,
  '不传 options 时胶囊照画——这就是「不传 = summary」的直接证据')

// ---------------------------------------------------------------------------
// 15) 单价 / 规格取值撞上 Object.prototype 的成员名。
//     矩阵版这里防的是 grid[行轴值][列轴值]：用 {} 做容器时，取值正好叫 constructor /
//     toString / valueOf / hasOwnProperty / __proto__ 会从原型上读到一个真值，
//     `if (!grid[r][c])` 判假、不初始化成数组，下一行 .push 直接抛——**整张送货单导不出来**；
//     __proto__ 那一支还会把格子写到 Object.prototype 上，泄到下一张单，
//     客户可能在自己的单子上看到别人的货。
//     grid 随交叉表一起删了，但**拿用户数据当对象键这件事胶囊版还在做一次**：
//     slicePillGroups 按 priceText 分组。所以判据整条搬过来，钉到那个键上。
//     （实测：把 slicePillGroups 里的 Object.create(null) 改回 {}，下面这批当场抛
//      "Cannot read properties of undefined (reading 'push')"。）
//
//     sliceLineSections 的 key 带 'id' / 'name' 前缀，撞不上原型成员名，所以那一处不在这条
//     断言的射程里——但品名和规格取值仍然是店主自由输入，一并跑一遍「不崩且真的画出来」，
//     防的是有人哪天把前缀去掉。
// ---------------------------------------------------------------------------
const PROTO_NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

PROTO_NAMES.forEach(function (name) {
  // 单价撞名——会崩的那一支（slicePillGroups 的分组键）。
  // 两条流水、单价一个正常一个叫原型名：分组要真的分成两行，不能崩、也不能并成一行。
  const priceLines = [
    specLine({ id: 'pn1', productId: 'PN', specParts: [{ name: '颜色', value: '黑色' }], qtyText: '1', priceText: '59.00', amountText: '59.00' }),
    specLine({ id: 'pn2', productId: 'PN', specParts: [{ name: '颜色', value: '白色' }], qtyText: '2', priceText: name, amountText: '0.00' })
  ]
  let priceLayout
  assert.doesNotThrow(function () {
    priceLayout = slipImage.layoutSlip(pillFixtureSlip(priceLines))
  }, '单价叫「' + name + '」时不得抛异常：分组容器用 {} 会从原型读到真值、跳过数组初始化，'
    + '.push 当场抛，整张送货单导不出来')
  assert.strictEqual(summaryRowsOf(priceLayout, '单价撞名/' + name).length, 2,
    '单价叫「' + name + '」时仍应分成两行，不能并成一行')
  assert.ok(hasText(priceLayout, name),
    '单价叫「' + name + '」时这一行必须真的印出来，不能靠静默丢行来"不报错"')

  // 规格取值 / 品名撞名——当前不崩，一并钉住防回归；并且要求真的画出来
  // （否则"不抛异常"可以靠静默丢掉这一枚来满足，那是另一种丢数）。
  const specLines = gridLines(['黑色', '白色'], [name, 'M', 'L'])
  let specLayout
  assert.doesNotThrow(function () {
    specLayout = slipImage.layoutSlip(pillFixtureSlip(specLines))
  }, '规格取值叫「' + name + '」时不得抛异常')
  assert.ok(hasText(specLayout, '黑色/' + name + ' ×1'),
    '规格取值叫「' + name + '」时这一枚胶囊必须真的画出来，不能靠静默丢掉来"不报错"')
  assert.doesNotThrow(function () {
    slipImage.layoutSlip(pillFixtureSlip([
      specLine({ id: 'pn3', productName: name, sku: '', specParts: [{ name: '颜色', value: '黑色' }] })
    ]))
  }, '品名叫「' + name + '」时不得抛异常')
})

// 直接钉全局污染：同时查 Object 本体和 Object.prototype——写坏的那一支写到前者
// （grid['constructor'] 拿到的是 Object 函数本体），另一支写到后者（grid['__proto__']）。
// 后者才是会跨单据泄漏的那支：下一张单新建的 {} 从 Object.prototype 继承，上一张单的数会
// 印到这一张上。只查一个会漏，所以两个都查。
//
// **查的是「本单的数据值有没有变成 Object 上的属性名」**，不是 PROTO_NAMES 本身——
// constructor / toString / valueOf / hasOwnProperty / __proto__ 本来就是 Object.prototype
// 自己的属性，把它们列进来这条断言会恒红（写这一版时当场踩到）。污染发生时冒出来的是
// **内层的 key**：上面那些夹具里当过键或取值的字符串。
//
// 胶囊版的 slicePillGroups 只有一层键（priceText），单层写坏只会当场抛、不会污染全局，
// 所以这条现在是**纵深防御**：哪天有人再引入「用户数据当两层键」的容器，它顶上。
;(function assertNoGlobalPollution() {
  const suspects = ['59.00', '0.00', '65.00', '4.50', 'S', 'M', 'L', '黑色', '白色', '红色', '蓝色']
  const dirty = []
  ;[Object, Object.prototype].forEach(function (target, i) {
    Object.getOwnPropertyNames(target).forEach(function (k) {
      if (suspects.indexOf(k) >= 0) dirty.push((i === 0 ? 'Object.' : 'Object.prototype.') + k)
    })
  })
  assert.deepStrictEqual(dirty, [],
    '排版不得在全局 Object / Object.prototype 上写属性（实测多出：' + dirty.join(', ') + '）')
})()

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
