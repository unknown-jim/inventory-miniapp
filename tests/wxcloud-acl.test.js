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
  'platform_admins',
  'platform_config'
])
assert.strictEqual(acl.ACL_TAG, 'ADMINONLY')

// 云存储（商品图）：READWRITE = 所有用户可读、仅创建者可写读。
// 客户端直接拿 cloud:// fileID 渲染 <image>，上传者是创建者可传，不绕云函数。
assert.strictEqual(acl.STORAGE_ACL_TAG, 'READWRITE')
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
      platform_admins: 'ADMINONLY',
      platform_config: 'PRIVATE'
    },
    acl.COLLECTIONS,
    acl.ACL_TAG
  ),
  ['shops', 'ledgers', 'ledger_clears', 'platform_config']
)
assert.deepStrictEqual(
  acl.collectionsNeedingAcl(
    {
      shops: 'ADMINONLY',
      members: 'ADMINONLY',
      ledgers: 'ADMINONLY',
      ledger_records: 'ADMINONLY',
      ledger_clears: 'ADMINONLY',
      platform_admins: 'ADMINONLY',
      platform_config: 'ADMINONLY'
    },
    acl.COLLECTIONS,
    acl.ACL_TAG
  ),
  []
)

// ---------------------------------------------------------------------------
// 建表清单和 ACL 清单必须是**同一份**。
//
// 真吃过这个亏：加 platform_config 时只改了这里的 COLLECTIONS，
// wxcloud-deploy-ledger.js 里另有一份手抄的建表数组没跟上。后果不是「少建一张表」
// 那么轻——部署脚本先建表、再设 ACL，而 describeAcl 没有 catch：走到清单里那张
// 不存在的集合就抛出去、main().catch 里 exit(1)，函数代码已经上传、索引已经补完，
// 却停在 ensureStorageAcl 之前，云存储权限没设，商品图渲染不出来。
//
// 修法不是「记得两边一起改」，是把两份清单合成一份：要设 ADMINONLY 的集合，
// 必然先得存在。这条断言钉住那份合并——部署脚本里再出现手抄的集合名数组就红。
const deploySrc = fs.readFileSync(path.join(__dirname, '../scripts/wxcloud-deploy-ledger.js'), 'utf8')
// **锚到行尾**：不锚的话 `acl.COLLECTIONS.slice(0, 6)` 照样匹配，
// 而那就是同一个漂移换个写法（实测过，不锚时这种写法全绿）。
assert.ok(
  /const names = acl\.COLLECTIONS\s*$/m.test(deploySrc),
  'wxcloud-deploy-ledger.js 的建表清单必须整份取 wxcloud-ensure-acl.js 的 COLLECTIONS，'
  + '不许另抄一份、也不许 slice 掉几个——抄的那份漂开过一次，'
  + '代价是部署中断在设云存储权限之前'
)
// 缩短传给 ensureAcl 的清单，后果比漏建表严重：那几张表**不会**被设成 ADMINONLY，
// 等于把小程序挡在业务库外面的那道门开了，而且没有任何运行时信号。
assert.ok(
  !/ensureAcl\([^)]*collections:/.test(deploySrc),
  'wxcloud-deploy-ledger.js 里 ensureAcl 不许传缩短的 collections——'
  + '漏设的那几张表就是敞开的业务库，没有任何运行时信号会告诉你'
)
// 失败必须被报出来：ensureAcl 现在只收集失败不抛，调用方漏了 assertAclOk
// 就等于把「某张表没设成 ADMINONLY」静默咽掉。
assert.ok(
  /assertAclOk\(/.test(deploySrc),
  'wxcloud-deploy-ledger.js 必须调 acl.assertAclOk 报出没设成功的集合'
)
assert.ok(
  !/names\s*=\s*\[\s*'shops'/.test(deploySrc),
  'wxcloud-deploy-ledger.js 里不许再出现手抄的集合名数组'
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
