const assert = require('assert')
const fs = require('fs')
const path = require('path')
const acl = require('../scripts/wxcloud-ensure-acl')

assert.deepStrictEqual(acl.COLLECTIONS, [
  'shops',
  'members',
  'ledgers',
  'ledger_records',
  'ledger_clears',
  'platform_admins'
])
assert.strictEqual(acl.ACL_TAG, 'ADMINONLY')

// 云存储（商品图）：要的是「所有用户可读、仅创建者可读写」——
// 客户端直接拿 cloud:// fileID 渲染 <image>，上传者是创建者可传，不绕云函数。
// **它的标签叫 `READONLY`**：2026-08-25 在控制台选中那一项之后用
// `tcbGetStorageACL` 读回来实测的。完整映射见 scripts/wxcloud-ensure-acl.js
// 里 STORAGE_ACL_TAG 顶上那段。
//
// 这条断言不是形式主义：写错标签不会报错，而是让幂等判断永远不相等，
// 于是**每次部署都去改一次已经设对的生产权限**。改它之前先去控制台核对。
assert.strictEqual(acl.STORAGE_ACL_TAG, 'READONLY')
assert.strictEqual(typeof acl.ensureStorageAcl, 'function')
assert.strictEqual(typeof acl.describeStorageAcl, 'function')
// 钉住脚本真的设了存储权限：删掉 tcbModifyStorageACL / tcbGetStorageACL 调用，
// 这两条会先红。
const aclSource = fs.readFileSync(path.join(__dirname, '../scripts/wxcloud-ensure-acl.js'), 'utf8')
assert.ok(aclSource.indexOf('tcbModifyStorageACL') >= 0)
assert.ok(aclSource.indexOf('tcbGetStorageACL') >= 0)

assert.deepStrictEqual(
  acl.collectionsNeedingAcl(
    {
      shops: 'PRIVATE',
      members: 'ADMINONLY',
      ledgers: 'PRIVATE',
      ledger_records: 'ADMINONLY',
      ledger_clears: 'PRIVATE',
      platform_admins: 'ADMINONLY'
    },
    acl.COLLECTIONS,
    acl.ACL_TAG
  ),
  ['shops', 'ledgers', 'ledger_clears']
)
assert.deepStrictEqual(
  acl.collectionsNeedingAcl(
    {
      shops: 'ADMINONLY',
      members: 'ADMINONLY',
      ledgers: 'ADMINONLY',
      ledger_records: 'ADMINONLY',
      ledger_clears: 'ADMINONLY',
      platform_admins: 'ADMINONLY'
    },
    acl.COLLECTIONS,
    acl.ACL_TAG
  ),
  []
)

const skill = fs.readFileSync(path.join(__dirname, '../.cursor/skills/wxcloud-cli/SKILL.md'), 'utf8')
assert.ok(skill.indexOf('wxcloud-ensure-acl.js') >= 0)
assert.ok(skill.indexOf('tcbModifyDatabaseACL') >= 0)
assert.ok(skill.indexOf('不要传 region') >= 0)

const docs = fs.readFileSync(path.join(__dirname, '../docs/cloud-ledger.md'), 'utf8')
assert.ok(docs.indexOf('wxcloud-ensure-acl.js') >= 0)
assert.ok(docs.indexOf('ADMINONLY') >= 0)

console.log('wxcloud-acl: ok')

// npm test 的清单不含 tests/ui.test.js（只有 test:all / test:ui 会跑它）。
// 挂在本文件末尾，是因为 test 脚本以本文件收尾——提醒只在整轮跑完后出现一次。
// 真实吃过这个亏：一次合并缝让 npm test 全绿、test:ui 红（两侧各加了一个同名
// waitFor，函数声明提升让后一份静默盖掉前一份），唯一原因就是 npm test 不跑 UI。
// 提醒不设条件：「改动涉及页面交互才跑」这种按改动猜的启发式，恰好是
// docs/commit-and-pr.md 否掉的那种判断方式——合并缝不在改动面上，一律跑。
console.log('注意：npm test 不含 tests/ui.test.js（需要微信开发者工具）。'
  + '合并前一律跑 npm run test:all，与这次改动碰没碰页面无关')
