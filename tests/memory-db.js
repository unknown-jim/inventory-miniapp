// 云函数 db 适配层的内存替身，被 tests/ledger.test.js / tests/ledger-records.test.js /
// tests/record-shape.test.js 共用。不是测试文件本身，不进 npm test 的清单。

const apply = require('../utils/ledger-apply')
const inventory = require('../utils/inventory')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// ledger_records 集合的内存替身。
//
// 没有它，2b-1 之后的所有东西在本机都无法验证：跑不了 test:ui，也没有云环境。
// 只实现 ledger-records.js 真正用到的那几种查询，多余的一律抛错 —— 悄悄放过一种
// 没实现的查询，测试就会给出假绿。
// ---------------------------------------------------------------------------

function memCommand(op) {
  return function (value) {
    return { __cmd: op, value: value }
  }
}

const MEMORY_COMMAND = {
  lt: memCommand('lt'),
  lte: memCommand('lte'),
  gt: memCommand('gt'),
  gte: memCommand('gte'),
  in: memCommand('in')
}

function memMatches(doc, where) {
  return Object.keys(where || {}).every(function (key) {
    const want = where[key]
    const got = doc[key]
    if (want && typeof want === 'object' && want.__cmd) {
      if (want.__cmd === 'lt') return got < want.value
      if (want.__cmd === 'lte') return got <= want.value
      if (want.__cmd === 'gt') return got > want.value
      if (want.__cmd === 'gte') return got >= want.value
      if (want.__cmd === 'in') return (want.value || []).indexOf(got) >= 0
      throw new Error('MemoryDb: unsupported command ' + want.__cmd)
    }
    return got === want
  })
}

function MemoryDoc(bag, id) {
  this.bag = bag
  this.id = String(id)
}

MemoryDoc.prototype.get = async function () {
  if (!Object.prototype.hasOwnProperty.call(this.bag, this.id)) {
    throw new Error('document.get document does not exist')
  }
  return { data: clone(this.bag[this.id]) }
}

MemoryDoc.prototype.set = async function (options) {
  const data = clone((options && options.data) || {})
  data._id = this.id
  this.bag[this.id] = data
  return { stats: { updated: 1 } }
}

MemoryDoc.prototype.remove = async function () {
  if (!Object.prototype.hasOwnProperty.call(this.bag, this.id)) {
    throw new Error('document.remove document does not exist')
  }
  delete this.bag[this.id]
  return { stats: { removed: 1 } }
}

function MemoryQuery(bag, where, order, max) {
  this.bag = bag
  this._where = where || {}
  this._order = order || null
  this._limit = max || 0
}

MemoryQuery.prototype.orderBy = function (field, direction) {
  return new MemoryQuery(this.bag, this._where, { field: field, desc: direction === 'desc' }, this._limit)
}

MemoryQuery.prototype.limit = function (max) {
  return new MemoryQuery(this.bag, this._where, this._order, max)
}

MemoryQuery.prototype._rows = function () {
  const bag = this.bag
  const self = this
  const rows = Object.keys(bag).map(function (key) {
    return bag[key]
  }).filter(function (doc) {
    return memMatches(doc, self._where)
  })
  if (this._order) {
    const field = this._order.field
    const sign = this._order.desc ? -1 : 1
    rows.sort(function (a, b) {
      if (a[field] === b[field]) return 0
      return a[field] > b[field] ? sign : -sign
    })
  }
  return rows
}

MemoryQuery.prototype.get = async function () {
  const rows = this._rows()
  const limited = this._limit ? rows.slice(0, this._limit) : rows
  return { data: limited.map(clone) }
}

MemoryQuery.prototype.count = async function () {
  return { total: this._rows().length }
}

function MemoryCollection(bag) {
  this.bag = bag
}

MemoryCollection.prototype.doc = function (id) {
  return new MemoryDoc(this.bag, id)
}

MemoryCollection.prototype.where = function (cond) {
  return new MemoryQuery(this.bag, cond, null, 0)
}

function memRecordsCtx(bag) {
  return { collection: new MemoryCollection(bag), command: MEMORY_COMMAND }
}

function MemoryDb(options) {
  this.shops = {}
  this.members = {}
  this.ledgers = {}
  this.clears = {}
  this.records = {}
  // 平台运营方白名单（platform_admins 的替身）。**不进 snapshot() / 事务**：
  // 它不参与事务，是事务外的只读白名单，运维动作的门直接读 db.getPlatformAdmin。
  this.platformAdmins = {}
  this._rev = 0
  this.hooks = (options && options.hooks) || {}
}

// 浅拷贝够用，而且 3000 步随机序列跑得动：每个写接口（putLedger / setShop /
// setMember / putClearSnapshot / MemoryDoc.set）都是「整条替换 + clone」，
// 没有一处就地改文档，所以换掉 map 的引用就完成了回滚隔离。
function shallow(bag) {
  return Object.assign({}, bag)
}

MemoryDb.prototype.snapshot = function () {
  return {
    shops: shallow(this.shops),
    members: shallow(this.members),
    ledgers: shallow(this.ledgers),
    clears: shallow(this.clears),
    records: shallow(this.records)
  }
}

MemoryDb.prototype.recordsCtx = function () {
  return memRecordsCtx(this.records)
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

// 平台运营方白名单（index.js 的 createDb() 同名方法）。和 getClearSnapshot 一样：
// 查不到就返回 null，不抛 —— 「文档不存在」和「读失败」在真云上都被折成 null，
// requirePlatformAdmin 对两种一律拒绝（fail-closed）。
MemoryDb.prototype.getPlatformAdmin = async function (openid) {
  const key = String(openid || '')
  return this.platformAdmins[key] ? clone(this.platformAdmins[key]) : null
}

// 事务外读一份清空快照（账本升级的 mode:'snapshots' 用）。和 index.js 的
// createDb() 一样：找不到就返回 null，不抛。
MemoryDb.prototype.getClearSnapshot = async function (id) {
  return this.clears[id] ? clone(this.clears[id]) : null
}

MemoryDb.prototype.runTransaction = async function (fn) {
  const max = 8
  for (let attempt = 0; attempt < max; attempt++) {
    const baseRev = this._rev
    const snap = this.snapshot()
    const self = this
    const tx = {
      recordsCtx() {
        return memRecordsCtx(snap.records)
      },
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
      async removeShop(shopId) {
        delete snap.shops[shopId]
      },
      async setMember(member) {
        snap.members[member._id] = clone(member)
      },
      async removeMember(memberId) {
        delete snap.members[memberId]
      },
      async removeLedger(shopId) {
        delete snap.ledgers[shopId]
      },
      async listClearSnapshotsByShop(shopId) {
        return Object.keys(snap.clears).map(function (key) {
          return snap.clears[key]
        }).filter(function (item) {
          return item.shopId === shopId
        })
      },
      async removeClearSnapshot(id) {
        delete snap.clears[id]
      }
    }
    const result = await fn(tx)
    if (this._rev !== baseRev) continue
    this.shops = snap.shops
    this.members = snap.members
    this.ledgers = snap.ledgers
    this.clears = snap.clears
    this.records = snap.records
    this._rev += 1
    return result
  }
  throw new Error('库存刚被别人改过，请再提交')
}

// ---------------------------------------------------------------------------
// MemoryBook：不带鉴权和事务的记账台，给纯函数层的测试用。
//
// 记账主体和 ledger-core.js 的事务体一模一样（加载 → applyMutation → 落盘写记录），
// 区别只有两个：没有成员校验，以及所有 IO 是同步的（这样测试文件不用整体改成 async）。
// 流水存的是 toRecordDoc 出来的文档，所以文档往返也一起验了。
// ---------------------------------------------------------------------------

// fetchNeeded 的同步版。两轮收敛和 recordsNeeded 都是从 ledger-apply 直接取的，
// 「要捞哪几条」这件唯一会算错的事在两条路径上是同一份代码。
function fetchSyncInto(store, need, loaded) {
  need.ids.forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(loaded.byId, id)) return
    loaded.byId[id] = store.byId(id)
  })
  need.saleOrderIds.forEach(function (saleId) {
    const known = loaded.saleOrders.some(function (item) {
      return item.id === saleId
    })
    if (known) return
    const order = store.saleOrder(saleId)
    if (order) loaded.saleOrders.push(order)
  })
  need.purchases.forEach(function (key) {
    store.latestPurchases(key.productId, key.skuId).forEach(function (record) {
      const known = loaded.latestPurchases.some(function (item) {
        return item.id === record.id
      })
      if (!known) loaded.latestPurchases.push(record)
    })
  })
  need.saleReturns.forEach(function (saleId) {
    const known = loaded.saleReturns.some(function (item) {
      return String((inventory.recordLines(item)[0] || {}).saleOrderId || '') === saleId
    })
    if (known) return
    store.returnsOfSale(saleId).forEach(function (record) {
      const seen = loaded.saleReturns.some(function (item) {
        return item.id === record.id
      })
      if (!seen) loaded.saleReturns.push(record)
    })
  })
  return loaded
}

function prepareSync(store, action, payload) {
  let loaded = { byId: {}, saleOrders: [], latestPurchases: [], saleReturns: [] }
  loaded = fetchSyncInto(store, apply.recordsNeeded(action, payload, null), loaded)
  loaded = fetchSyncInto(store, apply.recordsNeeded(action, payload, loaded), loaded)
  return loaded
}

function MemoryBook(options) {
  options = options || {}
  let seq = 0
  this.shopId = options.shopId || 'book-shop'
  this.nextId = options.nextId || function () {
    seq += 1
    return 'mb-' + seq
  }
  this.docs = {}
  this.clears = {}
  this.ledger = apply.emptyLedger()
  this.ledger.bookId = this.shopId
  this.ledger.recordsMigratedAt = 1
}

MemoryBook.prototype.storeFor = function (bookId) {
  const docs = this.docs
  const shopId = this.shopId
  const book = String(bookId)

  function rows() {
    return Object.keys(docs).map(function (key) {
      return docs[key]
    }).filter(function (doc) {
      return doc.bookId === book
    })
  }

  function descending(list) {
    return list.slice().sort(function (a, b) {
      if (a.sortKey === b.sortKey) return 0
      return a.sortKey > b.sortKey ? -1 : 1
    })
  }

  function byId(id) {
    const doc = docs[apply.recordDocId(book, id)]
    return doc ? apply.fromRecordDoc(clone(doc)) : null
  }

  return {
    bookId: book,
    byId: byId,
    saleOrder: function (id) {
      const record = byId(id)
      return record && record.type === 'out' ? record : null
    },
    latestPurchases: function (productId, skuId) {
      return descending(rows().filter(function (doc) {
        return doc.type === 'in'
          && doc.productId === String(productId || '')
          && doc.skuId === String(skuId || '')
      })).slice(0, 2).map(function (doc) {
        return apply.fromRecordDoc(clone(doc))
      })
    },
    // 一张销售单名下的全部退货单，升序 = 记账顺序（整体重算用）
    returnsOfSale: function (saleOrderId) {
      return rows().filter(function (doc) {
        return doc.type === 'return'
          && doc.saleOrderId === String(saleOrderId || '')
      }).slice().sort(function (a, b) {
        if (a.sortKey === b.sortKey) return 0
        return a.sortKey < b.sortKey ? -1 : 1
      }).map(function (doc) {
        return apply.fromRecordDoc(clone(doc))
      })
    },
    set: function (record) {
      const doc = apply.toRecordDoc(record, book, shopId)
      docs[doc._id] = doc
    },
    remove: function (id) {
      const key = apply.recordDocId(book, id)
      if (!Object.prototype.hasOwnProperty.call(docs, key)) {
        throw new Error('记录不存在，删不掉：' + key)
      }
      delete docs[key]
    },
    countAll: function () {
      return rows().length
    },
    all: function () {
      return descending(rows()).map(function (doc) {
        return apply.fromRecordDoc(clone(doc))
      })
    }
  }
}

// 把一批已经是「一单一条」形状的流水灌进当前账套，聚合按全量折叠给定。
// 迁移动作（下一趟做）落地时应该产出同样的状态。
MemoryBook.prototype.seed = function (records, lists) {
  const store = this.storeFor(this.ledger.bookId)
  ;(records || []).forEach(function (record) {
    store.set(record)
  })
  const merged = Object.assign({}, this.ledger, lists || {})
  merged.accounts = inventory.foldAccountTerms(records || [])
  merged.aggregate = inventory.foldTotalTerms(records || [])
  this.ledger = apply.listsOf(merged)
  this.ledger.bookId = merged.bookId
  this.ledger.recordsMigratedAt = 1
  return this
}

MemoryBook.prototype.mutate = function (action, payload, now) {
  const store = this.storeFor(this.ledger.bookId)
  let mutationPayload = payload || {}
  const loaded = prepareSync(store, action, mutationPayload)
  if (action === 'restoreCleared') {
    const meta = apply.latestClearMeta(this.ledger)
    mutationPayload = Object.assign({}, mutationPayload, {
      snapshot: meta ? this.clears[meta.id] : null
    })
  }
  const applied = apply.applyMutation(this.ledger, action, mutationPayload, now, this.nextId, loaded)
  if (applied.result && applied.result.clearSnapshot) {
    this.clears[applied.result.clearSnapshot.id] = applied.result.clearSnapshot
    delete applied.result.clearSnapshot
  }
  const writeStore = this.storeFor(applied.ledger.bookId)
  applied.recordWrites.forEach(function (write) {
    if (write.op === 'remove') {
      writeStore.remove(write.id)
      return
    }
    writeStore.set(write.record)
  })
  this.ledger = applied.ledger
  return applied.result
}

MemoryBook.prototype.records = function () {
  return this.storeFor(this.ledger.bookId).all()
}

MemoryBook.prototype.lists = function () {
  const lists = apply.listsOf(this.ledger)
  lists.records = this.records()
  return lists
}

module.exports = {
  MemoryDb: MemoryDb,
  MemoryBook: MemoryBook,
  MEMORY_COMMAND: MEMORY_COMMAND,
  memRecordsCtx: memRecordsCtx,
  prepareSync: prepareSync,
  clone: clone
}
