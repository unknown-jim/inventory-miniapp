const assert = require('assert')
const fs = require('fs')
const path = require('path')
const core = require('../cloudfunctions/ledger/ledger-core')

const root = path.join(__dirname, '..')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

assert.strictEqual(
  read('utils/inventory.js'),
  read('cloudfunctions/ledger/inventory.js'),
  'cloudfunctions/ledger/inventory.js 与 utils/inventory.js 不一致，请运行 npm run sync:ledger-inventory'
)
assert.strictEqual(
  read('utils/ledger-apply.js'),
  read('cloudfunctions/ledger/ledger-apply.js'),
  'cloudfunctions/ledger/ledger-apply.js 与 utils/ledger-apply.js 不一致，请运行 npm run sync:ledger-inventory'
)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
}

function MemoryDb(options) {
  this.shops = {}
  this.members = {}
  this.ledgers = {}
  this.clears = {}
  this._rev = 0
  this.hooks = (options && options.hooks) || {}
}

MemoryDb.prototype.snapshot = function () {
  return {
    shops: clone(this.shops),
    members: clone(this.members),
    ledgers: clone(this.ledgers),
    clears: clone(this.clears)
  }
}

MemoryDb.prototype.listMembersByOpenid = async function (openid) {
  const self = this
  return Object.keys(this.members).map(function (key) {
    return self.members[key]
  }).filter(function (item) {
    return item.openid === openid
  })
}

MemoryDb.prototype.listShopsByIds = async function (ids) {
  const self = this
  return (ids || []).map(function (id) {
    return self.shops[id]
  }).filter(Boolean)
}

MemoryDb.prototype.listMembersByShop = async function (shopId) {
  const self = this
  return Object.keys(this.members).map(function (key) {
    return self.members[key]
  }).filter(function (item) {
    return item.shopId === shopId
  })
}

MemoryDb.prototype.getLedger = async function (shopId) {
  return this.ledgers[shopId] ? clone(this.ledgers[shopId]) : null
}

MemoryDb.prototype.runTransaction = async function (fn) {
  const max = 8
  for (let attempt = 0; attempt < max; attempt++) {
    const baseRev = this._rev
    const snap = this.snapshot()
    const self = this
    const tx = {
      async getLedger(shopId) {
        if (self.hooks.afterGetLedger) {
          await self.hooks.afterGetLedger(shopId, snap)
        }
        return snap.ledgers[shopId] ? clone(snap.ledgers[shopId]) : null
      },
      async putLedger(shopId, ledger) {
        snap.ledgers[shopId] = clone(ledger)
      },
      async getClearSnapshot(id) {
        return snap.clears[id] ? clone(snap.clears[id]) : null
      },
      async putClearSnapshot(id, snapshot) {
        snap.clears[id] = clone(snapshot)
      },
      async listMembersByShop(shopId) {
        return Object.keys(snap.members).map(function (key) {
          return snap.members[key]
        }).filter(function (item) {
          return item.shopId === shopId
        })
      },
      async getShop(shopId) {
        return snap.shops[shopId] ? clone(snap.shops[shopId]) : null
      },
      async setShop(shop) {
        snap.shops[shop._id] = clone(shop)
      },
      async setMember(member) {
        snap.members[member._id] = clone(member)
      },
      async removeMember(memberId) {
        delete snap.members[memberId]
      }
    }
    const result = await fn(tx)
    if (this._rev !== baseRev) continue
    this.shops = snap.shops
    this.members = snap.members
    this.ledgers = snap.ledgers
    this.clears = snap.clears
    this._rev += 1
    return result
  }
  throw new Error('库存刚被别人改过，请再提交')
}

async function call(db, makeId, openid, action, shopId, payload, now) {
  return core.dispatch({
    db: db,
    makeId: makeId,
    openid: openid,
    action: action,
    shopId: shopId,
    payload: payload || {},
    now: now || 1000
  })
}

async function rejects(promise, re) {
  try {
    await promise
  } catch (error) {
    assert.ok(re.test(error.message), 'unexpected error: ' + error.message)
    return
  }
  assert.fail('expected to reject ' + re)
}

;(async function () {
  const db = new MemoryDb()
  const ids = idFactory()

  const shopARes = await call(db, ids, 'user-a', 'createShop', '', { name: '甲店' })
  const shopBRes = await call(db, ids, 'user-b', 'createShop', '', { name: '乙店' })
  const shopA = shopARes.shop.id
  const shopB = shopBRes.shop.id

  await rejects(
    call(db, ids, 'user-b', 'getLedger', shopA),
    /不是该店成员/
  )
  await rejects(
    call(db, ids, 'user-b', 'addSale', shopA, {
      payType: 'cash',
      items: [{ productId: 'missing', qty: 1, unitPrice: 1 }]
    }),
    /不是该店成员/
  )

  await call(db, ids, 'user-a', 'saveProduct', shopA, {
    name: '铜轴',
    costPrice: 10,
    salePrice: 20,
    stock: 1
  })

  const ledgerB = await call(db, ids, 'user-b', 'getLedger', shopB)
  assert.strictEqual(ledgerB.ledger.products.length, 0, 'shop B should not see shop A products')

  const ledgerA = await call(db, ids, 'user-a', 'getLedger', shopA)
  assert.strictEqual(ledgerA.ledger.products.length, 1)
  const productId = ledgerA.ledger.products[0].id
  assert.strictEqual(ledgerA.ledger.products[0].stock, 1)

  await call(db, ids, 'user-a', 'addSale', shopA, {
    payType: 'cash',
    items: [{ productId: productId, qty: 1, unitPrice: 20 }]
  })
  await rejects(
    call(db, ids, 'user-a', 'addSale', shopA, {
      payType: 'cash',
      items: [{ productId: productId, qty: 1, unitPrice: 20 }]
    }),
    /库存不足/
  )

  const after = await call(db, ids, 'user-a', 'getLedger', shopA)
  assert.strictEqual(after.ledger.products[0].stock, 0)
  assert.strictEqual(after.ledger.records.filter(function (item) {
    return item.type === 'out'
  }).length, 1)

  const who = await call(db, ids, 'user-a', 'whoami')
  assert.strictEqual(who.openid, 'user-a')

  const shops = await call(db, ids, 'user-a', 'listShops')
  assert.strictEqual(shops.shops.length, 1)
  assert.strictEqual(shops.shops[0].name, '甲店')

  await call(db, ids, 'user-a', 'addMember', shopA, { openid: 'staff-c' })
  const members = await call(db, ids, 'staff-c', 'listMembers', shopA)
  assert.strictEqual(members.members.length, 2)
  await rejects(
    call(db, ids, 'staff-c', 'addMember', shopA, { openid: 'staff-d' }),
    /只有店主能改成员/
  )

  const dbRetry = new MemoryDb()
  const retryIds = idFactory()
  const shopRetry = await call(dbRetry, retryIds, 'user-a', 'createShop', '', { name: '并发店' })
  const shopId = shopRetry.shop.id
  await call(dbRetry, retryIds, 'user-a', 'saveProduct', shopId, {
    name: '铜轴',
    costPrice: 10,
    salePrice: 20,
    stock: 5
  })
  const stockProduct = (await call(dbRetry, retryIds, 'user-a', 'getLedger', shopId)).ledger.products[0]

  let phase = 'wait-t1-read'
  let resumeT1
  const t1Paused = new Promise(function (resolve) {
    resumeT1 = resolve
  })
  let t1ReadStarted
  const t1Read = new Promise(function (resolve) {
    t1ReadStarted = resolve
  })
  dbRetry.hooks.afterGetLedger = async function () {
    if (phase === 'wait-t1-read') {
      phase = 't1-paused'
      t1ReadStarted()
      await t1Paused
    }
  }

  const salePayload = {
    payType: 'cash',
    items: [{ productId: stockProduct.id, qty: 2, unitPrice: 20 }]
  }
  const t1 = call(dbRetry, retryIds, 'user-a', 'addSale', shopId, salePayload, 2000)
  await t1Read
  await call(dbRetry, retryIds, 'user-a', 'addSale', shopId, salePayload, 3000)
  resumeT1()
  await t1

  const retryLedger = await call(dbRetry, retryIds, 'user-a', 'getLedger', shopId)
  assert.strictEqual(retryLedger.ledger.products[0].stock, 1)
  assert.strictEqual(retryLedger.ledger.records.filter(function (item) {
    return item.type === 'out'
  }).length, 2)

  const dbShort = new MemoryDb()
  const shortIds = idFactory()
  const shopShort = await call(dbShort, shortIds, 'user-a', 'createShop', '', { name: '抢货店' })
  await call(dbShort, shortIds, 'user-a', 'saveProduct', shopShort.shop.id, {
    name: '铜轴',
    costPrice: 10,
    salePrice: 20,
    stock: 1
  })
  const shortProduct = (await call(dbShort, shortIds, 'user-a', 'getLedger', shopShort.shop.id)).ledger.products[0]
  let shortPhase = 'wait-t1-read'
  let resumeShort
  const shortPaused = new Promise(function (resolve) {
    resumeShort = resolve
  })
  let shortReadStarted
  const shortRead = new Promise(function (resolve) {
    shortReadStarted = resolve
  })
  dbShort.hooks.afterGetLedger = async function () {
    if (shortPhase === 'wait-t1-read') {
      shortPhase = 't1-paused'
      shortReadStarted()
      await shortPaused
    }
  }
  const shortSale = {
    payType: 'cash',
    items: [{ productId: shortProduct.id, qty: 1, unitPrice: 20 }]
  }
  const shortT1 = call(dbShort, shortIds, 'user-a', 'addSale', shopShort.shop.id, shortSale, 4000)
  await shortRead
  await call(dbShort, shortIds, 'user-a', 'addSale', shopShort.shop.id, shortSale, 5000)
  resumeShort()
  await rejects(shortT1, /库存不足/)
  const shortLedger = await call(dbShort, shortIds, 'user-a', 'getLedger', shopShort.shop.id)
  assert.strictEqual(shortLedger.ledger.products[0].stock, 0)
  assert.strictEqual(shortLedger.ledger.records.filter(function (item) {
    return item.type === 'out'
  }).length, 1)

  const dbUndo = new MemoryDb()
  const undoIds = idFactory()
  const shopUndo = await call(dbUndo, undoIds, 'user-a', 'createShop', '', { name: '恢复店' })
  const undoShop = shopUndo.shop.id
  await call(dbUndo, undoIds, 'user-a', 'saveProduct', undoShop, {
    name: '铜轴',
    costPrice: 10,
    salePrice: 20,
    stock: 3
  })
  const undoProduct = (await call(dbUndo, undoIds, 'user-a', 'getLedger', undoShop)).ledger.products[0]
  await call(dbUndo, undoIds, 'user-a', 'clearAll', undoShop)
  const cleared = await call(dbUndo, undoIds, 'user-a', 'getLedger', undoShop)
  assert.strictEqual(cleared.ledger.products.length, 0)
  assert.strictEqual(cleared.ledger.hasClearedBackup, true)
  assert.strictEqual(cleared.ledger.archivedClearCount, 1)
  assert.ok(!cleared.ledger.clearedBackup, 'getLedger must not send backup payload')
  assert.ok(!cleared.ledger.clearSnapshots, 'getLedger must not send snapshot list')
  await call(dbUndo, undoIds, 'user-a', 'saveProduct', undoShop, {
    name: '清空后新货',
    costPrice: 1,
    salePrice: 2,
    stock: 9
  })
  await call(dbUndo, undoIds, 'user-a', 'clearAll', undoShop)
  assert.strictEqual(Object.keys(dbUndo.clears).length, 2)
  await call(dbUndo, undoIds, 'user-a', 'restoreCleared', undoShop)
  const restored = await call(dbUndo, undoIds, 'user-a', 'getLedger', undoShop)
  assert.strictEqual(restored.ledger.products.length, 1)
  assert.strictEqual(restored.ledger.products[0].name, '清空后新货')
  assert.strictEqual(restored.ledger.products[0].stock, 9)
  assert.strictEqual(restored.ledger.hasClearedBackup, false)
  assert.strictEqual(restored.ledger.archivedClearCount, 2)
  const archived = Object.keys(dbUndo.clears).map(function (id) {
    return dbUndo.clears[id]
  })
  const firstArchive = archived.find(function (item) {
    return item.products && item.products[0] && item.products[0].id === undoProduct.id
  })
  assert.ok(firstArchive, 'older clear snapshot must stay on server')
  assert.strictEqual(firstArchive.products[0].stock, 3)
  await rejects(
    call(dbUndo, undoIds, 'user-a', 'restoreCleared', undoShop),
    /没有可恢复的数据/
  )
  await rejects(
    call(dbUndo, undoIds, 'user-b', 'restoreCleared', undoShop),
    /不是该店成员/
  )

  console.log('ledger tests passed')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
