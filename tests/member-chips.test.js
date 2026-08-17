const assert = require('assert')
const { memberChipLabel, memberChips } = require('../utils/member-chips')

assert.strictEqual(memberChipLabel({ displayName: '张姐', role: 'owner' }, 'me'), '张姐')
assert.strictEqual(memberChipLabel({ displayName: '  小李  ', role: 'staff' }, 'me'), '小李')
assert.strictEqual(memberChipLabel({ openid: 'me', displayName: '', role: 'owner' }, 'me'), '我')
assert.strictEqual(memberChipLabel({ openid: 'boss', displayName: '', role: 'owner' }, 'me'), '店主')
assert.strictEqual(memberChipLabel({ openid: 'staff', displayName: '', role: 'staff' }, 'me'), '店员')
assert.strictEqual(memberChipLabel({ openid: 'staff', displayName: '   ', role: 'staff' }, 'me'), '店员')

const chips = memberChips(
  [
    { openid: 'me', displayName: '', role: 'owner' },
    { openid: 'staff', displayName: '小李', role: 'staff' }
  ],
  'staff',
  'me'
)
assert.deepStrictEqual(chips, [
  { openid: 'me', displayName: '', label: '我', on: false },
  { openid: 'staff', displayName: '小李', label: '小李', on: true }
])

console.log('member-chips tests passed')
