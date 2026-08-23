const assert = require('assert')
const inv = require('../utils/inventory')
const { savedReturnsOf, repriceHint } = require('../utils/reprice-hint')

// 销售单一行卖 4 件 @25，其中 2 件已退（当时记 50）
const saved = savedReturnsOf([
  { lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 2, returnedAmount: 50 },
  { lineId: 'l2', unitPrice: 8, qty: 1, returnedQty: 0, returnedAmount: 0 }
])
assert.strictEqual(saved.l1.returnedAmount, 50)
assert.strictEqual(saved.l1.unitPrice, 25)

// 单价没动就不弹：改数量、改实收都不产生两套价这件事。
assert.strictEqual(repriceHint(saved, [
  { id: 'l1', unitPrice: '25', qty: '8' },
  { id: 'l2', unitPrice: '8', qty: '1' }
]), '')

// 改了没退过货的那一行也不弹：没有退货就没有要重算的东西。
assert.strictEqual(repriceHint(saved, [
  { id: 'l1', unitPrice: '25', qty: '4' },
  { id: 'l2', unitPrice: '9', qty: '1' }
]), '')

// 改了有退货那一行的单价才弹，并且把旧已退金额和按新价重算后的金额都摆出来。
const hint = repriceHint(saved, [
  { id: 'l1', unitPrice: '10', qty: '4' },
  { id: 'l2', unitPrice: '8', qty: '1' }
])
assert.ok(hint.indexOf('已经退了 2 件') >= 0, hint)
assert.ok(hint.indexOf('¥50.00') >= 0, hint)
assert.ok(hint.indexOf('¥20.00') >= 0, hint)
assert.ok(hint.indexOf('现金不会变') >= 0, hint)

// 改成 0 元赠品也要弹：这一档正是缺陷最显眼的地方，新已退金额是 0。
const zeroHint = repriceHint(saved, [
  { id: 'l1', unitPrice: '0', qty: '4' },
  { id: 'l2', unitPrice: '8', qty: '1' }
])
assert.ok(zeroHint.indexOf('¥0.00') >= 0, zeroHint)

// 老流水缺 returnedAmount：按 returnedQty × 当时单价回推，和数据层同一条兜底。
const legacySaved = savedReturnsOf([
  { lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 2 }
])
assert.strictEqual(legacySaved.l1.returnedAmount, 50)
assert.strictEqual(legacySaved.l1.returnedAmount, inv.round2(2 * 25))

// 没有任何一行退过货就恒不弹（大多数单子走这条）。
assert.strictEqual(repriceHint(savedReturnsOf([
  { lineId: 'l1', unitPrice: 25, qty: 4, returnedQty: 0, returnedAmount: 0 }
]), [{ id: 'l1', unitPrice: '99', qty: '4' }]), '')

console.log('reprice-hint tests passed')
