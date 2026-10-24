const assert = require('assert')
const cd = require('../utils/confirm-dialog')

const discard = cd.discardOpts()
assert.strictEqual(discard.title, '放弃未保存的改动？')
assert.strictEqual(discard.confirmText, '放弃')

const member = cd.removeMemberOpts('小陈')
assert.ok(member.title.indexOf('小陈') >= 0)
assert.ok(member.impactLines.some(function (l) { return l.indexOf('不再关联') >= 0 }))
assert.strictEqual(member.confirmText, '移出')

const blocked = cd.deleteSaleOpts({ hasReturned: true, returnCount: 2 })
assert.strictEqual(blocked.showConfirm, false)
assert.strictEqual(blocked.cancelText, '知道了')
assert.ok(blocked.impactLines[0].indexOf('2 条退货') >= 0)

const ok = cd.deleteSaleOpts({
  hasReturned: false,
  customerName: '李老板',
  docNo: 'S20260820-003',
  timeText: '2026-08-20',
  amount: 2300,
  paidAmount: 1500,
  debtBefore: 800,
  debtAfter: 700
})
assert.strictEqual(ok.title, '删除这张销售单？')
assert.ok(ok.body.indexOf('应收') >= 0)
assert.ok(ok.impactLines.some(function (l) { return l.indexOf('退回库存') >= 0 }))
assert.ok(ok.impactLines.some(function (l) { return l.indexOf('欠款少') >= 0 }))
assert.ok(ok.impactLines.some(function (l) { return l.indexOf('现金不退回') >= 0 }))
assert.strictEqual(ok.note, '删除不可撤销。')

console.log('confirm-dialog.test.js ok')
