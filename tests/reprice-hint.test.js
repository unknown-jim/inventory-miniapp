const assert = require('assert')
const inv = require('../utils/inventory')
const { savedSaleOf, repriceHint } = require('../utils/reprice-hint')

// 一张单行销售 + 一次退货。文案里的钱必须和引擎真正落库的钱是同一个数，
// 所以下面每一档都拿 inv.updateRecord 跑一遍对表，而不是只比字符串。
function tee() {
  return inv.createProduct({
    name: 'T恤', sku: 'T-1', costPrice: 10, salePrice: 25, stock: 100
  }, 1000, 'p1')
}

function saleWithReturn(paidAmount, returnQty) {
  let n = 0
  const sold = inv.applySaleOrder([tee()], [], {
    items: [{ productId: 'p1', qty: 4, unitPrice: 25 }],
    customerId: 'c1',
    customerName: '客户',
    paidAmount: paidAmount
  }, 1000, 'sale1', function () { n += 1; return 'sale1-l' + n })
  return inv.applyReturn(sold.products, sold.records, {
    saleOrderId: 'sale1', saleLineId: 'sale1-l1', qty: returnQty
  }, 2000, 'ret1', sold.skus)
}

// 改完价之后引擎真正记下的现金退款额。文案里的「改成 ¥X」说的就是它。
function cashAfterSave(state, unitPrice, paidAmount) {
  const saved = inv.updateRecord(state.products, state.records, {
    id: 'sale1',
    items: [{ id: 'sale1-l1', qty: 4, unitPrice: unitPrice }],
    paidAmount: paidAmount,
    customerId: 'c1',
    customerName: '客户'
  }, 3000, state.skus, null)
  return saved.records.find(function (item) { return item.id === 'ret1' }).paidAmount
}

function hintOf(state, unitPrice, paidAmount) {
  const sale = state.records.find(function (item) { return item.id === 'sale1' })
  return repriceHint(savedSaleOf(sale), [
    { id: 'sale1-l1', qty: '4', unitPrice: String(unitPrice) }
  ], String(paidAmount))
}

// —— 档一：涨价，账上记的现金退款额变少 ——
// 卖 4@25=100、实收 90 → 退 2 件，当场退现金 40。改成 30：应收 120，退货额 60，
// 先冲欠款 30，账上只剩 30 算退现金。抽屉里少的仍是 40，账上少记 10。
const partial = saleWithReturn(90, 2)
assert.strictEqual(partial.records.find(function (item) {
  return item.id === 'ret1'
}).paidAmount, 40)
assert.strictEqual(cashAfterSave(partial, 30, 90), 30)
const up = hintOf(partial, 30, 90)
assert.ok(up.indexOf('退过 2 件') >= 0, up)
assert.ok(up.indexOf('从 ¥50.00 重算成 ¥60.00') >= 0, up)
// 四件事都要说到：改前 40、改后 30、差 10、差额怎么补。
assert.ok(up.indexOf('¥40.00 → ¥30.00') >= 0, up)
assert.ok(up.indexOf('少记的 ¥10.00') >= 0, up)
assert.ok(up.indexOf('收回来') >= 0, up)
// 这一头不能叫店主去记收款：收款只会把已经偏低的欠款推得更低。
assert.ok(up.indexOf('收款') < 0, up)

// —— 档二：改成 0 元赠品，整笔现金退款额被抹平 ——
// 卖 4@25=100、实收 100 → 退 2 件，退现金 50。改 0 元（实收也得改成 0，
// 否则页面先被「实收比应收多」拦下）：账上现金退款额 50 → 0。
const full = saleWithReturn(100, 2)
assert.strictEqual(full.records.find(function (item) {
  return item.id === 'ret1'
}).paidAmount, 50)
assert.strictEqual(cashAfterSave(full, 0, 0), 0)
const zero = hintOf(full, 0, 0)
assert.ok(zero.indexOf('从 ¥50.00 重算成 ¥0.00') >= 0, zero)
assert.ok(zero.indexOf('¥50.00 → ¥0.00') >= 0, zero)
assert.ok(zero.indexOf('少记的 ¥50.00') >= 0, zero)

// —— 档三：降价，账上记的现金退款额变多 ——
// 卖 4@25=100、实收 60 → 退 2 件：欠款 40 吃掉 40，只有 10 算退现金。
// 降到 20：应收 80、欠款 20、退货额 40 → 20 算退现金。账上多记 10，
// 这一头才是 docs/accounting-vs-policy.md 说的「补记一笔收款就对上」。
const half = saleWithReturn(60, 2)
assert.strictEqual(half.records.find(function (item) {
  return item.id === 'ret1'
}).paidAmount, 10)
assert.strictEqual(cashAfterSave(half, 20, 60), 20)
const down = hintOf(half, 20, 60)
assert.ok(down.indexOf('¥10.00 → ¥20.00') >= 0, down)
assert.ok(down.indexOf('多记的 ¥10.00') >= 0, down)
assert.ok(down.indexOf('补记一笔收款') >= 0, down)

// —— 档四：一分没收的单，改价不动现金，就别提现金 ——
// 卖 4@25=100、实收 0 → 退 2 件：欠款盖得住退货，现金退款额恒 0。
const none = saleWithReturn(0, 2)
assert.strictEqual(cashAfterSave(none, 30, 0), 0)
const noCash = hintOf(none, 30, 0)
assert.ok(noCash.indexOf('从 ¥50.00 重算成 ¥60.00') >= 0, noCash)
assert.ok(noCash.indexOf('退款现金不变') >= 0, noCash)
assert.ok(noCash.indexOf('账上的退款现金 ¥') < 0, noCash)

// —— 手搓快照：文案的触发条件 ——
const saved = savedSaleOf({
  amount: 108,
  paidAmount: 108,
  lines: [
    { lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 2, returnedAmount: 50 },
    { lineId: 'l2', unitPrice: 8, qty: 1, returnedQty: 0, returnedAmount: 0 }
  ]
})
assert.strictEqual(saved.lines.l1.returnedAmount, 50)
assert.strictEqual(saved.lines.l1.unitPrice, 25)
assert.strictEqual(saved.amount, 108)
assert.strictEqual(saved.settled, 108)
assert.strictEqual(saved.returnedAmount, 50)

// 单价没动就不弹：改数量、改实收都不产生两套价这件事。
assert.strictEqual(repriceHint(saved, [
  { id: 'l1', unitPrice: '25', qty: '8' },
  { id: 'l2', unitPrice: '8', qty: '1' }
], '108'), '')

// 改了没退过货的那一行也不弹：没有退货就没有要重算的东西。
assert.strictEqual(repriceHint(saved, [
  { id: 'l1', unitPrice: '25', qty: '4' },
  { id: 'l2', unitPrice: '9', qty: '1' }
], '109'), '')

// 没有任何一行退过货就恒不弹（大多数单子走这条）。
assert.strictEqual(repriceHint(savedSaleOf({
  amount: 100,
  paidAmount: 100,
  lines: [{ lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 0, returnedAmount: 0 }]
}), [{ id: 'l1', unitPrice: '99', qty: '4' }], '100'), '')

// 老流水缺 returnedAmount：快照按 returnedQty × 当时单价回推，和数据层
//（returnedAmountOfSale）同一条兜底口径。**正因为同口径，两套价那条判据
//（|returnedAmount − returnedQty × unitPrice|）在这里恒为 0**，抓不到它，
// 所以 savedSaleOf 单独打一个 returnedAmountMissing 标记，靠它出文案。
//
// 这里从前断言的是 ''（静默）—— 钉的是 A5 那个错误行为：店主打开这张单一个字
// 不改直接保存，同单退货行会被拨到现价、returnedAmount 落成 Σ退货额，而当初那几
// 张退货单开的可能是另一套价，差额直接落在销售额、毛利和欠款上，一句提示都没有。
const legacy = savedSaleOf({
  amount: 100,
  paidAmount: 100,
  lines: [{ lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 2 }]
})
assert.strictEqual(legacy.lines.l1.returnedAmount, inv.round2(2 * 25))
assert.strictEqual(legacy.lines.l1.returnedAmountMissing, true)
const legacyHint = repriceHint(legacy, [{ id: 'l1', unitPrice: '25', qty: '4' }], '100')
assert.ok(legacyHint.indexOf('账上没记当时的退货金额') >= 0, legacyHint)
// 保存后的两个数是准的（Σ退货额由构造 = 已退件数 × 现价，退款现金跟着它现算），
// 报得出来；改前那一头账上压根没记，详情页也 fetch 不到那几张退货单，如实说看不
// 出来 —— 报一个可能是错的「改前 ¥X」比不报更糟。
assert.ok(legacyHint.indexOf('退货额记成 ¥50.00') >= 0, legacyHint)
assert.ok(legacyHint.indexOf('退款现金记成 ¥50.00') >= 0, legacyHint)
assert.ok(legacyHint.indexOf('看不出来') >= 0, legacyHint)
// 同一张单只要 returnedAmount 记着就不走这条：不缺字段、也不是两套价，恒不弹。
assert.strictEqual(repriceHint(savedSaleOf({
  amount: 100,
  paidAmount: 100,
  lines: [{ lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 2, returnedAmount: 50 }]
}), [{ id: 'l1', unitPrice: '25', qty: '4' }], '100'), '')

// —— 老数据的两套价：单价一个字没改也要说一声 ——
// main 上被改出来的单：销售行 0 元、退货行还按 25 记着 50。保存会把退货行拨回
// 0 元（是修复），但账上的现金退款额 50 → 0 一样会动，不说店主毫无预期。
const mixed = savedSaleOf({
  amount: 0,
  paidAmount: 0,
  lines: [{ lineId: 'l1', unitPrice: 0, qty: 4, returnedQty: 2, returnedAmount: 50 }]
})
const mixedHint = repriceHint(mixed, [{ id: 'l1', unitPrice: '0', qty: '4' }], '0')
assert.ok(mixedHint.indexOf('历史遗留') >= 0, mixedHint)
assert.ok(mixedHint.indexOf('¥50.00 → ¥0.00') >= 0, mixedHint)
assert.ok(mixedHint.indexOf('账上的退款现金 ¥50.00 → ¥0.00') >= 0, mixedHint)
assert.ok(mixedHint.indexOf('少记的 ¥50.00') >= 0, mixedHint)
// 这次真改了价的时候用改价那套说法，不要再说「不是这次改的」。
const alsoChanged = repriceHint(mixed, [{ id: 'l1', unitPrice: '9', qty: '4' }], '0')
assert.ok(alsoChanged.indexOf('历史遗留') < 0, alsoChanged)
assert.ok(alsoChanged.indexOf('从 ¥50.00 重算成 ¥18.00') >= 0, alsoChanged)

// 小数件数下 returnedAmount（逐张退货 round2 累加）和 round2(合计 × 单价)
// 本来就能差 1 分，那是舍入不是两套价，不许拿它弹窗。
const rounding = savedSaleOf({
  amount: 0.2,
  paidAmount: 0.2,
  lines: [{ lineId: 'l1', unitPrice: 0.05, qty: 4, returnedQty: 1, returnedAmount: 0.06 }]
})
assert.strictEqual(repriceHint(rounding, [{ id: 'l1', unitPrice: '0.05', qty: '4' }], '0.2'), '')
// 差得比一分多就是真的两套价，照弹。
const reallyMixed = savedSaleOf({
  amount: 0.2,
  paidAmount: 0.2,
  lines: [{ lineId: 'l1', unitPrice: 0.05, qty: 4, returnedQty: 1, returnedAmount: 0.08 }]
})
assert.ok(repriceHint(reallyMixed, [{ id: 'l1', unitPrice: '0.05', qty: '4' }], '0.2')
  .indexOf('历史遗留') >= 0)

console.log('reprice-hint tests passed')
