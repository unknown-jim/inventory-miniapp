const assert = require('assert')
const preview = require('../utils/ledger-export-preview')

const now = new Date(2026, 7, 25, 12, 0, 0).getTime() // 2026-08-25

const month = preview.exportWindowRange('month', now)
assert.strictEqual(month.from, new Date(2026, 7, 1).getTime())
assert.strictEqual(month.to, new Date(2026, 8, 1).getTime())

const last = preview.exportWindowRange('lastMonth', now)
assert.strictEqual(last.from, new Date(2026, 6, 1).getTime())
assert.strictEqual(last.to, new Date(2026, 7, 1).getTime())

const follow = preview.exportWindowRange('follow', now, 'today')
assert.strictEqual(follow.from, preview.exportWindowRange('today', now).from)

const records = [
  { type: 'out', amount: 100 },
  { type: 'out', amount: 50.5 },
  { type: 'in', amount: 80 },
  { type: 'pay', amount: 20 }
]
const all = preview.aggregateByType(records, ['all'])
const out = all.find(function (b) { return b.type === 'out' })
const inn = all.find(function (b) { return b.type === 'in' })
assert.strictEqual(out.count, 2)
assert.strictEqual(out.amount, 150.5)
assert.strictEqual(inn.count, 1)

const onlyPay = preview.aggregateByType(records, ['pay'])
assert.strictEqual(onlyPay.find(function (b) { return b.type === 'pay' }).count, 1)
assert.strictEqual(onlyPay.find(function (b) { return b.type === 'out' }).count, 0)

const lines = preview.previewLines(all, function (n) { return '¥' + n.toFixed(2) })
assert.ok(lines.some(function (l) { return l.indexOf('销售 2 笔') >= 0 && l.indexOf('应收') >= 0 }))
assert.ok(lines.some(function (l) { return l.indexOf('进货') >= 0 }))

assert.strictEqual(preview.previewTitle('本月', ['all']), '预览 · 本月 · 全部类型')
assert.ok(preview.shareText('本月', ['all'], lines).indexOf('账本导出') === 0)

console.log('ledger-export-preview.test.js ok')