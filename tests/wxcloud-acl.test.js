const assert = require('assert')
const fs = require('fs')
const path = require('path')
const acl = require('../scripts/wxcloud-ensure-acl')

assert.deepStrictEqual(acl.COLLECTIONS, [
  'shops',
  'members',
  'ledgers',
  'ledger_records',
  'ledger_clears'
])
assert.strictEqual(acl.ACL_TAG, 'ADMINONLY')

assert.deepStrictEqual(
  acl.collectionsNeedingAcl(
    {
      shops: 'PRIVATE',
      members: 'ADMINONLY',
      ledgers: 'PRIVATE',
      ledger_records: 'ADMINONLY',
      ledger_clears: 'PRIVATE'
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
      ledger_clears: 'ADMINONLY'
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
