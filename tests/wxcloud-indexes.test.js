const assert = require('assert')
const fs = require('fs')
const path = require('path')
const indexes = require('../scripts/wxcloud-ensure-indexes')

const wanted = indexes.INDEXES.map(function (item) {
  return indexes.keysSignature(item.keys)
})

assert.deepStrictEqual(wanted, [
  'bookId:1,sortKey:-1',
  'bookId:1,customerId:1,sortKey:-1',
  'bookId:1,type:1,sortKey:-1',
  'bookId:1,saleOrderId:1,sortKey:1',
  'bookId:1,type:1,productId:1,skuId:1,sortKey:-1',
  'shopId:1'
])

assert.strictEqual(indexes.COLLECTION, 'ledger_records')
assert.strictEqual(indexes.INDEXES.length, 6)

const existing = [
  { name: '_id_', keys: [{ name: '_id', direction: '1' }] },
  { name: 'bookId_sortKey', keys: indexes.INDEXES[0].keys }
]
const missing = indexes.missingIndexes(existing, indexes.INDEXES)
assert.deepStrictEqual(
  missing.map(function (item) {
    return item.indexName
  }),
  [
    'bookId_customerId_sortKey',
    'bookId_type_sortKey',
    'bookId_saleOrderId_sortKey',
    'bookId_type_productId_skuId_sortKey',
    'shopId'
  ]
)
assert.deepStrictEqual(indexes.missingIndexes(existing.concat(indexes.INDEXES), indexes.INDEXES), [])

const comment = fs.readFileSync(
  path.join(__dirname, '../cloudfunctions/ledger/ledger-records.js'),
  'utf8'
)
assert.ok(comment.indexOf('wxcloud-ensure-indexes.js') >= 0)
assert.ok(comment.indexOf('bookId ASC, sortKey DESC') >= 0)
assert.ok(comment.indexOf('bookId ASC, saleOrderId ASC, sortKey ASC') >= 0)
// #6 从 2b-3 起不再是「预留」索引：注释里必须写清它服务的是哪一条查询，
// 不然下一个人看见「当前无查询使用」会以为它可以删。
assert.ok(comment.indexOf('shopId ASC') >= 0)
assert.ok(comment.indexOf('purgeByShop') >= 0)

console.log('wxcloud-indexes: ok')
