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
  const ownerDoc = Object.keys(db.members).map(function (key) {
    return db.members[key]
  }).find(function (item) {
    return item.shopId === shopA && item.openid === 'user-a'
  })
  assert.ok(ownerDoc)
  assert.ok(!Object.prototype.hasOwnProperty.call(ownerDoc, 'displayName'))

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
  const firstOut = after.ledger.records.find(function (item) {
    return item.type === 'out'
  })
  assert.ok(firstOut)
  assert.strictEqual(firstOut.operatorOpenid, 'user-a')
  assert.strictEqual(firstOut.operatorName, '')
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
  const listedOwner = members.members.find(function (item) {
    return item.openid === 'user-a'
  })
  const listedStaff = members.members.find(function (item) {
    return item.openid === 'staff-c'
  })
  assert.strictEqual(listedOwner.displayName, '')
  assert.strictEqual(listedStaff.displayName, '')
  await rejects(
    call(db, ids, 'staff-c', 'addMember', shopA, { openid: 'staff-d' }),
    /只有店主能改成员/
  )
  await rejects(
    call(db, ids, 'staff-c', 'updateMember', shopA, { openid: 'user-a', displayName: '老板' }),
    /只能改自己的称呼/
  )
  const selfNamed = await call(db, ids, 'staff-c', 'updateMember', shopA, { displayName: '小李' })
  assert.strictEqual(selfNamed.member.displayName, '小李')
  await call(db, ids, 'staff-c', 'updateMember', shopA, { openid: '', displayName: '店员小李' })
  await call(db, ids, 'user-a', 'updateMember', shopA, { openid: 'staff-c', displayName: '小李' })
  await call(db, ids, 'user-a', 'addMember', shopA, { openid: 'staff-d', displayName: '小李' })
  const namedMembers = await call(db, ids, 'user-a', 'listMembers', shopA)
  assert.strictEqual(namedMembers.members.filter(function (item) {
    return item.displayName === '小李'
  }).length, 2)
  await rejects(
    call(db, ids, 'user-a', 'updateMember', shopA, {
      displayName: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲乙丙'
    }),
    /称呼最多 32 个字/
  )
  await call(db, ids, 'user-a', 'saveProduct', shopA, {
    name: '经手人货',
    costPrice: 1,
    salePrice: 2,
    stock: 10
  })
  const opLedger = await call(db, ids, 'user-a', 'getLedger', shopA)
  const opProduct = opLedger.ledger.products.find(function (item) {
    return item.name === '经手人货'
  })
  await call(db, ids, 'user-a', 'updateMember', shopA, { displayName: '老板甲' })
  const stamped = await call(db, ids, 'user-a', 'addSale', shopA, {
    payType: 'cash',
    items: [{ productId: opProduct.id, qty: 1, unitPrice: 2 }]
  })
  assert.strictEqual(stamped.result.order.operatorOpenid, 'user-a')
  assert.strictEqual(stamped.result.order.operatorName, '老板甲')
  const namedSale = await call(db, ids, 'user-a', 'addSale', shopA, {
    payType: 'cash',
    operatorName: '临时工',
    items: [{ productId: opProduct.id, qty: 1, unitPrice: 2 }]
  })
  assert.strictEqual(namedSale.result.order.operatorOpenid, '')
  assert.strictEqual(namedSale.result.order.operatorName, '临时工')
  const memberSale = await call(db, ids, 'user-a', 'addSale', shopA, {
    payType: 'cash',
    operatorOpenid: 'staff-c',
    items: [{ productId: opProduct.id, qty: 1, unitPrice: 2 }]
  })
  assert.strictEqual(memberSale.result.order.operatorOpenid, 'staff-c')
  assert.strictEqual(memberSale.result.order.operatorName, '小李')
  const overrideSale = await call(db, ids, 'user-a', 'addSale', shopA, {
    payType: 'cash',
    operatorOpenid: 'staff-c',
    operatorName: '现场帮忙',
    items: [{ productId: opProduct.id, qty: 1, unitPrice: 2 }]
  })
  assert.strictEqual(overrideSale.result.order.operatorOpenid, 'staff-c')
  assert.strictEqual(overrideSale.result.order.operatorName, '现场帮忙')
  const leftSale = await call(db, ids, 'user-a', 'addSale', shopA, {
    payType: 'cash',
    operatorOpenid: 'gone-user',
    operatorName: '老王',
    items: [{ productId: opProduct.id, qty: 1, unitPrice: 2 }]
  })
  assert.strictEqual(leftSale.result.order.operatorOpenid, 'gone-user')
  assert.strictEqual(leftSale.result.order.operatorName, '老王')
  const stampId = stamped.result.order.records[0].id
  await call(db, ids, 'user-a', 'updateMember', shopA, { displayName: '新老板' })
  const kept = await call(db, ids, 'user-a', 'updateRecord', shopA, {
    id: stampId,
    qty: 1,
    unitPrice: 2
  })
  assert.strictEqual(kept.result.record.operatorOpenid, 'user-a')
  assert.strictEqual(kept.result.record.operatorName, '老板甲')
  const rewritten = await call(db, ids, 'user-a', 'updateRecord', shopA, {
    id: stampId,
    qty: 1,
    unitPrice: 2,
    operatorOpenid: '',
    operatorName: ''
  })
  assert.strictEqual(rewritten.result.record.operatorOpenid, '')
  assert.strictEqual(rewritten.result.record.operatorName, '')

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

  await call(db, ids, 'user-a', 'saveProduct', shopA, {
    name: '调整轴',
    costPrice: 8,
    salePrice: 16,
    stock: 4
  })
  const ledgerAdjust = await call(db, ids, 'user-a', 'getLedger', shopA)
  const adjustProduct = ledgerAdjust.ledger.products.find(function (item) {
    return item.name === '调整轴'
  })
  assert.ok(adjustProduct)
  await call(db, ids, 'user-a', 'addAdjust', shopA, {
    productId: adjustProduct.id,
    direction: 'in',
    reason: 'surplus',
    qty: 2
  })
  const afterAdjust = await call(db, ids, 'user-a', 'getLedger', shopA)
  const adjusted = afterAdjust.ledger.products.find(function (item) {
    return item.id === adjustProduct.id
  })
  assert.strictEqual(adjusted.stock, 6)
  assert.strictEqual(adjusted.costPrice, 8)
  assert.ok(afterAdjust.ledger.records.some(function (item) {
    return item.type === 'adjust_in'
  }))
  const ledgerBAfter = await call(db, ids, 'user-b', 'getLedger', shopB)
  assert.strictEqual(ledgerBAfter.ledger.records.filter(function (item) {
    return item.type === 'adjust_in' || item.type === 'adjust_out'
  }).length, 0)
  await rejects(
    call(db, ids, 'user-b', 'addAdjust', shopA, {
      productId: adjustProduct.id,
      direction: 'out',
      reason: 'damage',
      qty: 1
    }),
    /不是该店成员/
  )

  console.log('ledger tests passed')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
