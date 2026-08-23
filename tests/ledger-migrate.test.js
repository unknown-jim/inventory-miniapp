// 阶段 2b-1b：账本升级的三个动作（checkAggregates / migrateRecords /
// recomputeAggregates）。
//
// 跑的是**完整云函数栈**（core.dispatch + MemoryDb 里的 ledger_records 替身），
// require 的是 cloudfunctions/ledger/* 那一份副本 —— 不是 utils/。做变异验证时
// 两份孪生文件要一起改，只改 utils/ 会得到假结论。
//
// 覆盖 M3–M16。M1 / M1b / M1c / M2 / M2b 在 tests/ledger-terms.test.js，
// M13（migrateLocal 也吃修复）在 tests/ledger-records.test.js。
//
// **夹具坑**：Shop 的时钟是从 1000 起步的合成时钟，不是 Date.now()。任何依赖
// 真实时间语义的断言（dayStart / today）必须显式传 now，否则会写出一条看似
// 通过实则无效的断言。这个文件一处都不传 dayStart，today 一律为 null。
const assert = require('assert')
const inv = require('../cloudfunctions/ledger/inventory')
const apply = require('../cloudfunctions/ledger/ledger-apply')
const core = require('../cloudfunctions/ledger/ledger-core')
const migrate = require('../cloudfunctions/ledger/ledger-migrate')
const memory = require('./memory-db')

const MemoryDb = memory.MemoryDb

function idFactory(prefix) {
  let n = 0
  return function () {
    n += 1
    return (prefix || 'id') + '-' + n
  }
}

function Shop(options) {
  options = options || {}
  this.db = options.db || new MemoryDb()
  this.ids = options.ids || idFactory('g')
  this.openid = options.openid || 'user-a'
  this.clock = options.now || 1000
  this.shopId = ''
}

Shop.prototype.call = function (action, payload, now) {
  return this.callRaw(action, payload, now, core.API_VERSION)
}

Shop.prototype.callRaw = function (action, payload, now, apiVersion) {
  if (now == null) {
    this.clock += 10
    now = this.clock
  }
  return core.dispatch({
    db: this.db,
    makeId: this.ids,
    openid: this.openid,
    action: action,
    shopId: this.shopId,
    apiVersion: apiVersion,
    payload: payload || {},
    now: now
  })
}

Shop.prototype.open = async function (name) {
  const res = await core.dispatch({
    db: this.db,
    makeId: this.ids,
    openid: this.openid,
    action: 'createShop',
    shopId: '',
    apiVersion: core.API_VERSION,
    payload: { name: name || '升级测试店' },
    now: this.clock
  })
  this.shopId = res.shop.id
  return this
}

Shop.prototype.doc = function () {
  return this.db.ledgers[this.shopId]
}

// 带外改账本文档（模拟控制台手改 / 上一轮尝试的残骸）
Shop.prototype.patchDoc = function (patch) {
  this.db.ledgers[this.shopId] = Object.assign({}, this.db.ledgers[this.shopId], patch)
  return this
}

Shop.prototype.docsOfBook = function (bookId) {
  const db = this.db
  return Object.keys(db.records).map(function (key) {
    return db.records[key]
  }).filter(function (doc) {
    return doc.bookId === bookId
  })
}

Shop.prototype.collectionAll = function (bookId) {
  return this.docsOfBook(bookId).slice().sort(function (a, b) {
    if (a.sortKey === b.sortKey) return 0
    return a.sortKey > b.sortKey ? -1 : 1
  }).map(apply.fromRecordDoc)
}

Shop.prototype.pagedAll = async function (options) {
  options = options || {}
  const out = []
  let cursor = ''
  for (let page = 0; page < 1000; page++) {
    const res = await this.call('listRecords', {
      type: options.type || '', customerId: options.customerId || '',
      cursor: cursor, limit: options.limit || 100
    })
    res.records.forEach(function (item) { out.push(item) })
    if (!res.hasMore) break
    // 空页时服务端回 ''，直接赋值会把游标冲回开头
    cursor = res.cursor || cursor
  }
  return out
}

// 循环调 migrateRecords 到 done / failed。上限防止写出无限循环的测试。
Shop.prototype.runMigration = async function (payload, maxCalls) {
  const cap = maxCalls == null ? 500 : maxCalls
  let last = null
  let first = true
  for (let i = 0; i < cap; i++) {
    last = await this.call('migrateRecords', first
      ? (payload || {})
      : Object.assign({}, payload || {}, { restart: false, newBook: false }))
    first = false
    if (last.state === 'done' || last.state === 'failed') return last
  }
  throw new Error('migrateRecords 调了 ' + cap + ' 次还没收敛：' + JSON.stringify(last))
}

function rejects(fn, re) {
  return fn().then(function () {
    assert.fail('expected to reject ' + re)
  }, function (error) {
    assert.ok(re.test(error.message), 'unexpected error: ' + error.message)
  })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// 三代形状混着的老账本语料。**一份定义，M4–M16 全部共用**，
// 所以每条断言里的数字都能对回同一张手算表：
//
//   代A + B2   A-ord  赊账卖 100（两行）给 nc1，退 30，退货行还挂着旧客户 oldc
//              修复前 nc1 欠 100、oldc 欠 −30（负账户！）；修复后 nc1 欠 70、oldc 消失
//   代B (B1)   B-s    卖 200 实收 40（欠 160），B-r 退 60，退货单两个结算字段都没有
//              修复前被回推成整笔退现金 -> 一分不冲欠款，欠 160；修复后欠 100
//   代C        C-s    卖 80 一分没收，C-r 退 20 且 paidAmount 已经是 0（正确）
//              修复是**恒等变换**，一个字段都不动
//   收款       A-pay  nc1 还了 20
// ---------------------------------------------------------------------------
function legacyCorpus() {
  return [
    // 老记录是 unshift 进数组的，组内倒着排：A-l2 在前，A-l1 在后
    { id: 'A-l2', type: 'out', orderId: 'A-ord', productId: 'p1', productName: '牛奶', qty: 1, unitPrice: 40, costPrice: 25, amount: 40, profit: 15, payType: 'credit', customerId: 'nc1', customerName: '甲', customerPhone: '13800000001', customerAddress: '甲街 1 号', createdAt: 2000 },
    { id: 'A-l1', type: 'out', orderId: 'A-ord', productId: 'p1', productName: '牛奶', qty: 2, unitPrice: 30, costPrice: 20, amount: 60, profit: 20, payType: 'credit', customerId: 'nc1', customerName: '甲', customerPhone: '13800000001', customerAddress: '甲街 1 号', createdAt: 2000 },
    { id: 'A-r', type: 'return', saleRecordId: 'A-l1', productId: 'p1', productName: '牛奶', qty: 1, unitPrice: 30, costPrice: 20, amount: 30, profit: -10, payType: 'credit', customerId: 'oldc', customerName: '旧客户', customerPhone: '13900000009', customerAddress: '旧街 9 号', createdAt: 2500 },
    {
      id: 'B-s', type: 'out', amount: 200, profit: 60, remark: '', createdAt: 4000,
      customerId: 'nc2', customerName: '乙', customerPhone: '13800000002', customerAddress: '乙街 2 号',
      paidAmount: 40, operatorOpenid: '', operatorName: '',
      lines: [{ lineId: 'B-s-l1', productId: 'p2', productName: '面包', sku: '', skuId: '', color: '', size: '', qty: 4, unitPrice: 50, costPrice: 35, amount: 200, profit: 60, allocations: [], returnedQty: 1, returnedAmount: 60 }]
    },
    {
      id: 'B-r', type: 'return', amount: 60, profit: -18, remark: '', createdAt: 5000,
      customerId: 'nc2', customerName: '乙', customerPhone: '13800000002', customerAddress: '乙街 2 号',
      lines: [{ lineId: 'B-r-l1', productId: 'p2', productName: '面包', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 60, costPrice: 35, amount: 60, profit: -18, saleOrderId: 'B-s', saleLineId: 'B-s-l1' }]
    },
    {
      id: 'C-s', type: 'out', amount: 80, profit: 20, remark: '', createdAt: 6000,
      customerId: 'nc3', customerName: '丙', customerPhone: '', customerAddress: '',
      paidAmount: 0, operatorOpenid: '', operatorName: '',
      lines: [{ lineId: 'C-s-l1', productId: 'p3', productName: '鸡蛋', sku: '', skuId: '', color: '', size: '', qty: 4, unitPrice: 20, costPrice: 15, amount: 80, profit: 20, allocations: [], returnedQty: 1, returnedAmount: 20 }]
    },
    {
      id: 'C-r', type: 'return', amount: 20, profit: -5, remark: '', createdAt: 7000,
      customerId: 'nc3', customerName: '丙', customerPhone: '', customerAddress: '', paidAmount: 0,
      lines: [{ lineId: 'C-r-l1', productId: 'p3', productName: '鸡蛋', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 20, costPrice: 15, amount: 20, profit: -5, saleOrderId: 'C-s', saleLineId: 'C-s-l1' }]
    },
    { id: 'A-pay', type: 'pay', amount: 20, remark: '还款', customerId: 'nc1', customerName: '甲', customerPhone: '13800000001', customerAddress: '甲街 1 号', createdAt: 8000 }
  ]
}

// 同一家店的多份快照必须落到**不同**账套。用同一份语料测不出这件事：记录 id 相同，
// 账套号写死的话三份会互相覆盖成一本，而 countAll 仍然等于 6，撞号被藏住。
// 给每份加 tag（记录 id 和单号都带上），撞号就会变成「一本账套里 18 条」而被校验抓住。
function taggedCorpus(tag) {
  return legacyCorpus().map(function (record) {
    const copy = Object.assign({}, record)
    copy.id = tag + '-' + copy.id
    if (copy.orderId) copy.orderId = tag + '-' + copy.orderId
    if (copy.saleRecordId) copy.saleRecordId = tag + '-' + copy.saleRecordId
    if (Array.isArray(copy.lines)) {
      copy.lines = copy.lines.map(function (line) {
        const l = Object.assign({}, line)
        if (l.lineId) l.lineId = tag + '-' + l.lineId
        if (l.saleOrderId) l.saleOrderId = tag + '-' + l.saleOrderId
        if (l.saleLineId) l.saleLineId = tag + '-' + l.saleLineId
        return l
      })
    }
    return copy
  })
}

function corpusLists() {
  return {
    products: [
      { id: 'p1', name: '牛奶', costPrice: 20, salePrice: 30, stock: 20, alertQty: 2, colors: [], sizes: [] },
      { id: 'p2', name: '面包', costPrice: 35, salePrice: 50, stock: 20, alertQty: 2, colors: [], sizes: [] },
      { id: 'p3', name: '鸡蛋', costPrice: 15, salePrice: 20, stock: 20, alertQty: 2, colors: [], sizes: [] }
    ],
    skus: [],
    customers: [
      { id: 'nc1', name: '甲' }, { id: 'nc2', name: '乙' },
      { id: 'nc3', name: '丙' }, { id: 'oldc', name: '旧客户' }
    ],
    categories: []
  }
}

// 把一份老账本装进店里（recordsMigratedAt 清零 = 还没搬）
function installLegacy(shop, records, lists) {
  const use = lists || corpusLists()
  shop.patchDoc({
    recordsMigratedAt: 0,
    accounts: {},
    aggregate: inv.emptyTerms(),
    products: use.products, skus: use.skus,
    customers: use.customers, categories: use.categories,
    records: records || legacyCorpus()
  })
  return shop
}

async function openLegacyShop(prefix, records) {
  const shop = await new Shop({ ids: idFactory(prefix) }).open(prefix + ' 店')
  installLegacy(shop, records)
  return shop
}

// 升级前存下来的清空快照，**老 clearDoc 的形状**（2b-1 之前那一版）：流水装在
// records 数组里，没有 bookId / accounts / aggregate。真实导出里的三份就长这样
// （keys = _id,id,shopId,savedAt,products,skus,records,customers,categories）。
function legacyClearDoc(shopId, id, savedAt, records, lists) {
  const use = lists || corpusLists()
  return {
    _id: id,
    id: id,
    shopId: shopId,
    savedAt: savedAt,
    products: clone(use.products),
    skus: clone(use.skus),
    records: clone(records || []),
    customers: clone(use.customers),
    categories: clone(use.categories)
  }
}

// 带外把老快照塞进 ledger_clears + 账本的 clearSnapshots 元数据
//（旧云函数存的就是这个样子，新云函数没有任何路径能造出它来）
function installLegacyClears(shop, docs) {
  docs.forEach(function (doc) {
    shop.db.clears[doc._id] = clone(doc)
  })
  shop.patchDoc({
    clearSnapshots: docs.map(function (doc) {
      return { id: doc.id, savedAt: doc.savedAt }
    }),
    lastRestoredClearAt: 0
  })
  return shop
}

// 循环调 mode:'snapshots' 到 done，返回每一次调用的返回包
Shop.prototype.runSnapshots = async function (payload, maxCalls) {
  const cap = maxCalls == null ? 100 : maxCalls
  const calls = []
  for (let i = 0; i < cap; i++) {
    const res = await this.call('migrateRecords', Object.assign({}, payload || {}, { mode: 'snapshots' }))
    calls.push(res)
    if (res.state === 'done') return calls
  }
  throw new Error('mode:"snapshots" 调了 ' + cap + ' 次还没收敛：' + JSON.stringify(calls[calls.length - 1]))
}

function receivableOf(accounts, customerId) {
  return inv.accountOf((accounts || {})[customerId]).receivable
}

;(async function () {
  // =========================================================================
  // M3 纯函数层：auditRecords 对 V4–V12 各造一条坏数据，
  //             各自被抓，且**只**被对应那项抓到
  // =========================================================================
  function cleanSet() {
    return [
      {
        id: 'S1', type: 'out', amount: 100, profit: 40, remark: '', createdAt: 1000,
        customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', paidAmount: 0,
        lines: [{ lineId: 'S1-l1', productId: 'p1', productName: '货', sku: '', skuId: '', color: '', size: '', qty: 2, unitPrice: 50, costPrice: 30, amount: 100, profit: 40, allocations: [], returnedQty: 1, returnedAmount: 50 }]
      },
      {
        id: 'R1', type: 'return', amount: 50, profit: -20, remark: '', createdAt: 2000,
        customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', paidAmount: 0,
        lines: [{ lineId: 'R1-l1', productId: 'p1', productName: '货', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 50, costPrice: 30, amount: 50, profit: -20, saleOrderId: 'S1', saleLineId: 'S1-l1' }]
      },
      {
        id: 'IN1', type: 'in', amount: 60, profit: 0, remark: '', createdAt: 500,
        lines: [{ lineId: 'IN1-l1', productId: 'p1', productName: '货', sku: '', skuId: '', color: '', size: '', qty: 2, unitPrice: 30, costPrice: 30, amount: 60, profit: 0 }]
      },
      {
        id: 'PAY1', type: 'pay', amount: 20, profit: 0, remark: '', createdAt: 3000,
        customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', lines: []
      }
    ]
  }

  const CHECK_LISTS = ['duplicateIds', 'orphanReturns', 'returnedMismatch',
    'splitViolations', 'subCent', 'negativeAccounts']

  const baseAudit = migrate.auditRecords(cleanSet())
  CHECK_LISTS.forEach(function (name) {
    assert.deepStrictEqual(baseAudit[name], [], 'M3 基线语料必须干净：' + name)
  })
  assert.strictEqual(baseAudit.emptyIds, 0, 'M3 基线语料必须干净：emptyIds')
  assert.strictEqual(baseAudit.count, 4)
  assert.strictEqual(baseAudit.lineCount, 3, 'M3 基线：收款没有明细行')
  assert.strictEqual(receivableOf(baseAudit.accounts, 'c1'), 30, 'M3 基线：100 − 50 − 20 = 30')

  const M3_CASES = [
    {
      name: 'V4 销售行 returnedQty 和退货行对不上',
      hit: 'returnedMismatch',
      mutate: function (list) { list[0].lines[0].returnedQty = 2 }
    },
    {
      name: 'V5 拆分不变量：退货被记成整笔退现金',
      hit: 'splitViolations',
      mutate: function (list) { list[1].paidAmount = 50 }
    },
    {
      name: 'V6 退货挂在没有销售的客户名下 -> 负账户',
      hit: 'negativeAccounts',
      mutate: function (list) { list[1].customerId = 'c9' }
    },
    {
      name: 'V8 重复 id',
      hit: 'duplicateIds',
      mutate: function (list) { list.push(Object.assign({}, list[2])) }
    },
    {
      name: 'V11 孤儿退货：指向一张不在这本账里的销售单',
      hit: 'orphanReturns',
      mutate: function (list) {
        list.push({
          id: 'R9', type: 'return', amount: 10, profit: -4, remark: '', createdAt: 2500,
          customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', paidAmount: 10,
          lines: [{ lineId: 'R9-l1', productId: 'p1', productName: '货', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 10, costPrice: 5, amount: 10, profit: -4, saleOrderId: 'S-missing', saleLineId: 'S-missing-l1' }]
        })
      }
    },
    {
      name: 'V12 亚分金额',
      hit: 'subCent',
      mutate: function (list) { list[0].profit = 40.005 }
    }
  ]

  M3_CASES.forEach(function (item) {
    const list = cleanSet()
    item.mutate(list)
    const audit = migrate.auditRecords(list)
    assert.ok(audit[item.hit].length > 0, 'M3 ' + item.name + '：' + item.hit + ' 必须抓到')
    CHECK_LISTS.forEach(function (name) {
      if (name === item.hit) return
      assert.deepStrictEqual(audit[name], [],
        'M3 ' + item.name + '：不该顺带触发 ' + name + '（' + JSON.stringify(audit[name]) + '）')
    })
    assert.strictEqual(audit.emptyIds, 0, 'M3 ' + item.name + '：不该顺带触发 emptyIds')
  })

  // V8 的另一半：空 id
  const emptyIdSet = cleanSet()
  emptyIdSet.push({ id: '', type: 'in', amount: 1, profit: 0, remark: '', createdAt: 600, lines: [] })
  const emptyIdAudit = migrate.auditRecords(emptyIdSet)
  assert.strictEqual(emptyIdAudit.emptyIds, 1, 'M3 V8：空 id 要报出来')
  assert.deepStrictEqual(emptyIdAudit.duplicateIds, [], 'M3 V8：空 id 不算重复 id')

  // V9 / V10：归并前后的结构守恒。两条判据分开验。
  const flatPair = [
    { id: 'f2', type: 'out', orderId: 'f-ord', productId: 'p1', qty: 1, unitPrice: 10, costPrice: 5, amount: 10, profit: 5, payType: 'cash', createdAt: 100 },
    { id: 'f1', type: 'out', orderId: 'f-ord', productId: 'p1', qty: 1, unitPrice: 20, costPrice: 8, amount: 20, profit: 12, payType: 'cash', createdAt: 100 },
    { id: 'f3', type: 'return', saleRecordId: 'f1', productId: 'p1', qty: 1, unitPrice: 20, costPrice: 8, amount: 20, profit: -12, payType: 'cash', createdAt: 200 }
  ]
  const flatMerged = apply.legacyRecordsOf({ records: clone(flatPair) })
  const okShape = migrate.mergeShapeChecks(flatPair, flatMerged)
  assert.deepStrictEqual(okShape.problems, [], 'M3 V9/V10：正常归并不许报问题')
  assert.strictEqual(okShape.drop, 1)
  assert.strictEqual(okShape.outDrop, 1)
  assert.strictEqual(okShape.lineBefore, 3)
  assert.strictEqual(okShape.lineAfter, 3)
  // V10：退货被并进销售单（条数少了一张退货单）
  const eatenReturn = flatMerged.filter(function (item) { return item.type !== 'return' })
  const v10 = migrate.mergeShapeChecks(flatPair, eatenReturn)
  assert.ok(v10.problems.some(function (item) { return item.check === 'V10' && item.type === 'return' }),
    'M3 V10：非 out 被并掉必须报出来')
  // V9：行丢了
  const lostLine = clone(flatMerged)
  lostLine[0].lines = lostLine[0].lines.slice(0, 1)
  const v9 = migrate.mergeShapeChecks(flatPair, lostLine)
  assert.ok(v9.problems.some(function (item) { return item.check === 'V9' }), 'M3 V9：行数不等必须报出来')

  // V7 + V2：verifyChunk 的派生字段和往返深比对
  const sample = flatMerged[0]
  const goodDoc = apply.toRecordDoc(sample, 'bk', 'sh')
  assert.deepStrictEqual(migrate.verifyChunk([sample], [goodDoc], 'bk', 'sh'), [],
    'M3 V2/V7：原样往返不许报问题')
  const badSort = Object.assign({}, goodDoc, { sortKey: '0000000000000_x' })
  assert.ok(migrate.verifyChunk([sample], [badSort], 'bk', 'sh').some(function (item) {
    return item.check === 'V7' && item.field === 'sortKey'
  }), 'M3 V7：sortKey 和来源脱节必须抓到')
  const badBook = Object.assign({}, goodDoc, { bookId: 'other' })
  assert.ok(migrate.verifyChunk([sample], [badBook], 'bk', 'sh').some(function (item) {
    return item.check === 'V7' && item.field === 'bookId'
  }), 'M3 V7：写错账套必须抓到')
  const badMoney = Object.assign({}, goodDoc, { amount: 999 })
  const moneyProblems = migrate.verifyChunk([sample], [badMoney], 'bk', 'sh')
  assert.ok(moneyProblems.some(function (item) {
    return item.check === 'V2' && item.fields.indexOf('amount') >= 0
  }), 'M3 V2：字段往返丢失必须指出是哪个字段')
  // undefined ≡ 缺字段，key 顺序无关
  assert.ok(migrate.stableEqual({ a: 1, b: undefined }, { a: 1 }), 'M3：undefined 等价于缺字段')
  assert.ok(migrate.stableEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), 'M3：key 顺序无关')
  assert.ok(!migrate.stableEqual({ a: null }, { a: undefined }), 'M3：null 不是缺字段')
  assert.ok(!migrate.stableEqual({ a: [1, 2] }, { a: [2, 1] }), 'M3：数组顺序有关')

  // P4 的三类归因 + 第四类必须显形（movingChangesOf）
  function retOf(extra) {
    return Object.assign({
      id: 'mr', type: 'return', amount: 30, profit: -10, createdAt: 10,
      customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '',
      lines: [{ lineId: 'mr-l1', saleOrderId: 'S1', saleLineId: 'S1-l1', qty: 1, unitPrice: 30, amount: 30, profit: -10 }]
    }, extra)
  }
  const reasons = {}
  ;[
    [retOf({ paidAmount: 30, customerId: 'oldc' }), retOf({ paidAmount: 30 }), 'B2'],
    [retOf({}), retOf({ paidAmount: 0 }), 'genB'],
    [retOf({ payType: 'cash' }), retOf({ paidAmount: 0 }), 'payTypeStale'],
    [retOf({ paidAmount: 30 }), retOf({ paidAmount: 0 }), 'other']
  ].forEach(function (row) {
    const got = migrate.movingChangesOf([row[0]], [row[1]])
    assert.strictEqual(got.length, 1, 'M3 P4：' + row[2] + ' 必须算作一次会动钱的改动')
    assert.strictEqual(got[0].reason, row[2], 'M3 P4：归因应为 ' + row[2])
    reasons[row[2]] = true
  })
  assert.strictEqual(Object.keys(reasons).length, 4, 'M3 P4：四类归因全部覆盖')
  // 不动钱的改动不进 movingChanges（代 C 幂等、只改备注之类）
  assert.deepStrictEqual(
    migrate.movingChangesOf([retOf({ paidAmount: 0 })], [retOf({ paidAmount: 0, remark: '改了备注' })]),
    [], 'M3 P4：不动钱的改动不该进 movingChanges'
  )

  // =========================================================================
  // M4 三代混合未迁移账本 -> checkAggregates，P 字段逐个对上手算值
  // =========================================================================
  const m4 = await openLegacyShop('m4')
  const p = await m4.call('checkAggregates', {})
  assert.strictEqual(p.recordsPending, true)
  assert.strictEqual(p.migrated, false)
  // P1
  assert.strictEqual(p.legacyCount, 8, 'P1：老记录 8 条')
  assert.strictEqual(p.mergedCount, 7, 'P1：归并后 7 单（两行销售并成一张）')
  assert.strictEqual(p.lineCount, 7, 'P1：7 行（收款没有明细行）')
  // P2：形状按**未归并的原始记录**数，否则归并会把每张单都补成「代 C」
  assert.deepStrictEqual(p.shapes, {
    salePaid: 2, salePayType: 2, saleNeither: 0,
    returnPaid: 1, returnPayType: 1, returnNeither: 1
  }, 'P2：三代形状各自数得出来')
  // P3
  assert.deepStrictEqual(p.subCent, [], 'P3：不许有亚分金额')
  assert.deepStrictEqual(p.subCentRaw, [], 'P3：原始记录也不许有亚分金额')
  // P4：迁移会改动 nc1 / oldc / nc2 三家的数字，nc3（代 C）一分不动
  assert.strictEqual(p.before.receivable.nc1, 80, 'P4 修复前：nc1 欠 100 还了 20 = 80')
  assert.strictEqual(p.before.receivable.oldc, -30, 'P4 修复前：退货挂旧客户，折出 −30')
  assert.strictEqual(p.before.receivable.nc2, 160, 'P4 修复前：B1 让退货一分不冲欠款')
  assert.strictEqual(p.before.receivable.nc3, 60, 'P4 修复前：代 C 本来就是对的')
  assert.strictEqual(p.after.receivable.nc1, 50, 'P4 修复后：(100 − 30) − 20 = 50')
  assert.ok(!Object.prototype.hasOwnProperty.call(p.after.receivable, 'oldc'),
    'P4 修复后：旧客户从 accounts 里消失')
  assert.strictEqual(p.after.receivable.nc2, 100, 'P4 修复后：160 − 60 = 100')
  assert.strictEqual(p.after.receivable.nc3, 60, 'P4 修复后：代 C 恒等')
  assert.strictEqual(p.before.totals.receivable, 270)
  assert.strictEqual(p.after.totals.receivable, 210)
  assert.deepStrictEqual(p.movingChanges.map(function (item) {
    return item.id + ':' + item.reason
  }).sort(), ['A-r:B2', 'B-r:genB'], 'P4：两张会动钱的退货单，各自归到 B2 / genB')
  assert.deepStrictEqual(p.unexplainedChanges, [], 'P4：不许出现第四类')
  // P5
  assert.deepStrictEqual(p.negativeBefore.map(function (item) { return item.customerId }), ['oldc'],
    'P5：修复前有一个负账户')
  assert.deepStrictEqual(p.negativeAfter, [], 'P5：修复后必须为空')
  // P6 / P7 / P8 / P9
  assert.deepStrictEqual(p.orphanReturns, [], 'P6：这份语料没有孤儿退货')
  assert.deepStrictEqual(p.splitViolationsBefore.map(function (item) { return item.saleId }), ['B-s'],
    'P7：修复前代 B 那张单破坏拆分不变量')
  assert.deepStrictEqual(p.splitViolationsAfter, [], 'P7：修复后必须为空')
  assert.deepStrictEqual(p.returnedMismatch, [], 'P8：必须为空')
  assert.deepStrictEqual(p.duplicateIds, [], 'P9：必须为空')
  assert.strictEqual(p.emptyIds, 0, 'P9：必须为空')
  // P10
  assert.deepStrictEqual(p.multiLineOrders.map(function (item) { return item.id }), ['A-ord'],
    'P10：只有归并出来的那张是多行单')
  assert.deepStrictEqual(p.mergeProblems, [], 'V9/V10：归并结构守恒')
  // P11 / P12 / P13
  assert.strictEqual(p.clearSnapshots.count, 0)
  assert.ok(p.docBytes > 0, 'P12：要给出账本文档字节数')
  assert.strictEqual(p.collectionCount, 0, 'P13：目标账套必须没有残骸')
  assert.deepStrictEqual(p.blocking, [], 'M4：这份语料不该有阻塞项')

  // P4 的第三类「payType 过期」必须在**完整的 checkLedger 上**也归得对。
  // 这条是回归护栏：归并（legacyOrder）会给每张 out / return 补上 paidAmount，
  // 在归并结果上归因就会把这张单看成「本来就有 paidAmount、值却变了」——
  // 落到第四类 other，于是一次完全正常的预检被报成「方案有洞、停下来」。
  // 归因必须看**未归并的原始记录**。
  const staleShapes = migrate.checkLedger({
    _id: 'stale-shop',
    recordsMigratedAt: 0,
    products: [], skus: [], customers: [], categories: [],
    records: [
      // 赊账卖 100（老扁平形状），退 30 —— 退货单的 payType 还停在改档之前的 cash
      { id: 'st-s', type: 'out', orderId: 'st-s', productId: 'p1', productName: '货', qty: 2, unitPrice: 50, costPrice: 30, amount: 100, profit: 40, payType: 'credit', customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', createdAt: 1000 },
      { id: 'st-r', type: 'return', saleRecordId: 'st-s', productId: 'p1', productName: '货', qty: 1, unitPrice: 30, costPrice: 20, amount: 30, profit: -10, payType: 'cash', customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', createdAt: 2000 }
    ]
  })
  assert.deepStrictEqual(staleShapes.movingChanges.map(function (item) {
    return item.id + ':' + item.reason
  }), ['st-r:payTypeStale'], 'P4：payType 过期必须归到第三类，不许落进 other')
  assert.deepStrictEqual(staleShapes.unexplainedChanges, [],
    'P4：payType 过期不是第四类，不许把一次正常预检报成「方案有洞」')
  assert.deepStrictEqual(staleShapes.blocking, [], 'P4：payType 过期不该变成阻塞项')
  assert.deepStrictEqual(staleShapes.splitViolationsBefore.map(function (item) { return item.saleId }),
    ['st-s'], 'P4 自检：这张单迁移前确实破坏拆分不变量（否则上面是假绿）')
  assert.deepStrictEqual(staleShapes.splitViolationsAfter, [])
  assert.strictEqual(staleShapes.before.receivable.c1, 100, 'P4 自检：修复前退货一分不冲欠款')
  assert.strictEqual(staleShapes.after.receivable.c1, 70, 'P4：修复后 100 − 30 = 70')

  // P11：升级前存的快照（没有 bookId）会让「恢复清空前数据」永久报错
  const p11 = migrate.checkLedger(
    { _id: 's-p11', records: [], clearSnapshots: [{ id: 'cs-1', savedAt: 10 }] },
    { clears: [{ _id: 'cs-1', shopId: 's-p11', savedAt: 10, records: [{ id: 'x' }] }] }
  )
  assert.strictEqual(p11.clearSnapshots.latestHasBookId, false,
    'P11：老快照没有 bookId，这家店迁移后恢复不了')
  const p11ok = migrate.checkLedger(
    { _id: 's-p11', records: [], clearSnapshots: [{ id: 'cs-2', savedAt: 20 }] },
    { clears: [{ _id: 'cs-2', shopId: 's-p11', savedAt: 20, bookId: 'bk-9' }] }
  )
  assert.strictEqual(p11ok.clearSnapshots.latestHasBookId, true)
  // 文案要指出**能走通**的那条路：没有 bookId 只说明这份快照还没转换过，
  // 转换是 migrateRecords 的 mode:'snapshots'。「请联系开发者」是条死路。
  assert.throws(function () {
    apply.applyMutation(
      { clearSnapshots: [{ id: 'cs-1', savedAt: 10 }], lastRestoredClearAt: 0, records: [] },
      'restoreCleared',
      { snapshot: { id: 'cs-1', savedAt: 10, products: [] } },
      100, function () { return 'x' }, null
    )
  }, /mode:"snapshots"/, 'M4/P11：升级前的快照要指一条走得通的路')

  // =========================================================================
  // M5 迁移不改变已印出的单据。**最强的一条端到端断言**：
  //    同时覆盖 receivableAt 路径和「当前欠款 − 后缀」路径的等价性。
  // =========================================================================
  const m5 = await openLegacyShop('m5')
  const slipIds = ['A-ord', 'B-s', 'C-s']
  const slipBefore = []
  for (let i = 0; i < slipIds.length; i++) {
    slipBefore.push((await m5.call('getSlip', { recordId: slipIds[i] })).receivable)
  }
  // 先钉住这几个数不是 0，否则「前后相等」可能是两边都算不出来的假绿。
  // 送货单印的是**截断到单据时刻**的欠款，所以是开单当时的数：
  //   A-ord@2000 赊账 100（退货 2500 和收款 8000 都在它之后）
  //   B-s@4000   200 − 实收 40 = 160（退货 5000 在它之后）
  //   C-s@6000   80 一分没收（退货 7000 在它之后）
  // 三张单后面都还有流水 -> 迁移后走的「当前欠款 − 后缀」那条路后缀非空，
  // 这条断言才真的在比两条算法。
  assert.deepStrictEqual(slipBefore, [100, 160, 80],
    'M5 自检：迁移前的三张送货单欠款（走 receivableAt）')
  const m5done = await m5.runMigration({ limit: 3 })
  assert.strictEqual(m5done.state, 'done', 'M5：迁移必须跑到 done')
  const slipAfter = []
  for (let i = 0; i < slipIds.length; i++) {
    slipAfter.push((await m5.call('getSlip', { recordId: slipIds[i] })).receivable)
  }
  assert.deepStrictEqual(slipAfter, slipBefore,
    'M5：迁移前后同一张送货单印出来的欠款必须逐张相等')

  // =========================================================================
  // M6 循环调到 done：集合、分页、聚合、老数组、开关，五项一起对
  // =========================================================================
  const m6 = await openLegacyShop('m6')
  const m6Legacy = clone(m6.doc().records)
  const m6Merged = apply.legacyRecordsOf({ records: clone(m6Legacy) })
  const m6Done = await m6.runMigration({ limit: 2 })
  assert.strictEqual(m6Done.state, 'done')
  assert.strictEqual(m6Done.total, m6Merged.length)
  assert.strictEqual(m6Done.written, m6Merged.length)
  assert.strictEqual(m6Done.verified, m6Merged.length)
  const m6Doc = m6.doc()
  assert.strictEqual(m6.docsOfBook(m6Doc.bookId).length, m6Merged.length,
    'M6：集合条数 == 归并条数')
  const m6Paged = await m6.pagedAll()
  assert.deepStrictEqual(m6Paged, migrate.sortDesc(m6Merged),
    'M6：listRecords 翻完全本 == 归并结果')
  assert.deepStrictEqual(m6Doc.accounts, inv.foldAccountTerms(m6Merged),
    'M6：账本里的 accounts == 对归并结果全量折叠')
  assert.deepStrictEqual(m6Doc.aggregate, inv.foldTotalTerms(m6Merged))
  const m6Ledger = (await m6.call('getLedger', {})).ledger
  assert.ok(!m6Ledger.aggregatesStale, 'M6：不许有漂移哨兵')
  assert.strictEqual(m6Ledger.totals.receivable, 210, 'M6：全店欠款是修复后的 210')
  assert.deepStrictEqual(m6Doc.records, m6Legacy,
    'M6：老数组**故意留着**，它是 O(1) 回滚路的全部依仗')
  assert.ok(m6Doc.recordsMigratedAt > 0, 'M6：recordsMigratedAt 已写')
  assert.strictEqual(m6Doc.migration.phase, 'done')

  // M14 B2 端到端：新客户 70，旧客户从 accounts 里消失，且逐字段等于 foldAccountTerms
  assert.strictEqual(receivableOf(m6Doc.accounts, 'nc1'), 50, 'M14：nc1 = (100 − 30) − 20')
  assert.ok(!Object.prototype.hasOwnProperty.call(m6Doc.accounts, 'oldc'),
    'M14：旧客户从 accounts 里消失，不留负账户')
  const m6Nc1 = m6Ledger.customers.find(function (item) { return item.id === 'nc1' })
  assert.strictEqual(m6Nc1.account.receivable, 50, 'M14：回传给客户端的投影也是 50')
  const m6MovedReturn = m6Paged.find(function (item) { return item.id === 'A-r' })
  assert.strictEqual(m6MovedReturn.customerId, 'nc1', 'M14：退货单头的 customerId 拨到销售单当前值')
  assert.strictEqual(m6MovedReturn.customerName, '甲', 'M14：客户四字段整组拨')
  assert.strictEqual(m6MovedReturn.customerPhone, '13800000001')
  assert.strictEqual(m6MovedReturn.customerAddress, '甲街 1 号')
  assert.strictEqual(m6MovedReturn.payType, undefined, 'M14：落库的流水不许留着老 payType')
  assert.strictEqual(m6Paged.find(function (item) { return item.id === 'B-r' }).paidAmount, 0,
    'M14：代 B 退货单落库时补上 paidAmount = 0')
  // 代 C 一个字段都没动
  assert.deepStrictEqual(
    m6Paged.find(function (item) { return item.id === 'C-r' }),
    m6Legacy.find(function (item) { return item.id === 'C-r' }),
    'M14：代 C 的退货单是恒等变换，一个字段都不动'
  )
  // verifyMigrated 是「一次拿到全部文档」的整体版：分阶段那条路按页跑 verifyChunk
  // 再在末尾补 V1 / V3，两条路的判据必须是同一份代码，所以在同一份落库结果上对一遍。
  assert.deepStrictEqual(
    migrate.verifyMigrated(m6Merged, m6.docsOfBook(m6Doc.bookId), m6Doc.bookId, m6.shopId),
    [], 'M6：整体版校验也必须全过'
  )
  const brokenDocs = clone(m6.docsOfBook(m6Doc.bookId))
  brokenDocs[0].amount = brokenDocs[0].amount + 1
  const brokenProblems = migrate.verifyMigrated(m6Merged, brokenDocs, m6Doc.bookId, m6.shopId)
  assert.ok(brokenProblems.some(function (item) { return item.check === 'V2' }),
    'M6 自检：整体版真的会抓到改坏的字段')
  assert.ok(brokenProblems.some(function (item) { return item.check === 'V3' }),
    'M6 自检：改坏一条钱之后读回折叠也对不上')

  // 迁完之后 checkAggregates 走的是「已迁移」那条分支
  const m6Check = await m6.call('checkAggregates', {})
  assert.strictEqual(m6Check.migrated, true)
  assert.strictEqual(m6Check.collectionCount, m6Merged.length)
  assert.deepStrictEqual(m6Check.aggregateDiffs, [], 'M6：迁完之后聚合和集合逐字段一致')
  assert.strictEqual(m6Check.aggregatesStale, false)

  // =========================================================================
  // M7 写路径解冻
  // =========================================================================
  const m7 = await openLegacyShop('m7')
  await rejects(function () {
    return m7.call('addSale', { paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }] })
  }, /还没完成流水升级/)
  await m7.runMigration({ limit: 50 })
  const m7Sale = await m7.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 2, unitPrice: 30 }]
  })
  assert.ok(m7Sale.result.order, 'M7：迁移之后记账必须成功')
  const m7SaleId = m7Sale.result.order.id
  const m7SaleRecord = (await m7.call('getRecord', { recordId: m7SaleId })).record
  await m7.call('addReturn', {
    items: [{ saleOrderId: m7SaleId, saleLineId: m7SaleRecord.lines[0].lineId, qty: 1 }]
  })
  const m7All = await m7.pagedAll()
  assert.deepStrictEqual(migrate.auditRecords(m7All).splitViolations, [],
    'M7：新单加退货，拆分不变量仍然成立')
  assert.deepStrictEqual(migrate.auditRecords(m7All).negativeAccounts, [],
    'M7：新单加退货，不许折出负账户')
  const m7Doc = m7.doc()
  assert.deepStrictEqual(m7Doc.accounts, inv.foldAccountTerms(m7All),
    'M7：解冻之后增量维护的聚合仍然等于全量折叠')

  // =========================================================================
  // M8 幂等 / 中断：limit:1 逐条，同 chunk 重发三次
  // =========================================================================
  const m8a = await openLegacyShop('m8a')
  const m8aDone = await m8a.runMigration({ limit: 1 })
  assert.strictEqual(m8aDone.state, 'done')

  const m8b = await openLegacyShop('m8b')
  // 第一次调用是 init（不写记录），随后每次写一条
  let m8State = await m8b.call('migrateRecords', { limit: 1 })
  assert.strictEqual(m8State.phase, 'writing')
  assert.strictEqual(m8State.cursor, 0)
  let replays = 0
  for (let i = 0; i < 400; i++) {
    m8State = await m8b.call('migrateRecords', { limit: 1 })
    if (m8State.state === 'done' || m8State.state === 'failed') break
    if (m8State.phase === 'writing' && m8State.cursor > 0 && replays < 3) {
      // 中断态自检：开关没切，读写都还在老路上
      const midDoc = m8b.doc()
      assert.ok(!midDoc.recordsMigratedAt, 'M8：中断态不许写 recordsMigratedAt')
      assert.strictEqual((await m8b.call('getLedger', {})).ledger.recordsPendingMigration, true,
        'M8：中断态仍然走老数组')
      await rejects(function () {
        return m8b.call('addSale', { paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }] })
      }, /还没完成流水升级/)
      // 同 chunk 重发两次：把 cursor 拨回去，让上一片原样再写一遍
      for (let n = 0; n < 2; n++) {
        m8b.patchDoc({
          migration: Object.assign({}, m8b.doc().migration, {
            cursor: m8State.cursor - 1, written: m8State.written - 1
          })
        })
        await m8b.call('migrateRecords', { limit: 1 })
      }
      replays += 1
    }
  }
  assert.strictEqual(replays, 3, 'M8：必须真的重发过三次')
  assert.strictEqual(m8State.state, 'done', 'M8：重发之后仍然收敛到 done')
  const m8aDoc = m8a.doc()
  const m8bDoc = m8b.doc()
  assert.deepStrictEqual(m8bDoc.accounts, m8aDoc.accounts, 'M8：重发不改变最终 accounts')
  assert.deepStrictEqual(m8bDoc.aggregate, m8aDoc.aggregate, 'M8：重发不改变最终 aggregate')
  assert.deepStrictEqual(
    m8b.collectionAll(m8bDoc.bookId).map(function (item) { return JSON.stringify(item) }),
    m8a.collectionAll(m8aDoc.bookId).map(function (item) { return JSON.stringify(item) }),
    'M8：重发不改变集合里的任何一条'
  )
  assert.strictEqual(m8bDoc.migration.total, m8aDoc.migration.total)

  // CAS：cursor 被别人推进过就不许再写
  const m8c = await openLegacyShop('m8c')
  await m8c.call('migrateRecords', { limit: 1 })
  await m8c.call('migrateRecords', { limit: 1 })
  const stale = clone(m8c.doc().migration)
  // CAS 防的是**两次调用交错**：我读到进度 S、写完这一片，回头要推进 cursor 时
  // 发现库里已经不是 S 了。带外改文档模拟不出这个时序（下一次调用读的就是新值），
  // 所以用 hooks 在事务读账本的那一刻偷改一次。
  m8c.db.hooks.afterGetLedger = function (shopId, snap) {
    m8c.db.hooks.afterGetLedger = null
    snap.ledgers[shopId] = Object.assign({}, snap.ledgers[shopId], {
      migration: Object.assign({}, stale, { cursor: stale.cursor + 1 })
    })
  }
  await rejects(function () {
    return m8c.call('migrateRecords', { limit: 1 })
  }, /被另一次调用推进过/)
  m8c.db.hooks.afterGetLedger = null

  // =========================================================================
  // M9 校验不过绝不切开关
  // =========================================================================
  const m9 = await openLegacyShop('m9')
  let m9State = await m9.call('migrateRecords', { limit: 50 })  // init
  m9State = await m9.call('migrateRecords', { limit: 50 })      // 写完一整片
  assert.strictEqual(m9State.phase, 'writing')
  assert.strictEqual(m9State.cursor, m9State.total)
  m9State = await m9.call('migrateRecords', { limit: 50 })      // writing -> verifying
  assert.strictEqual(m9State.phase, 'verifying', 'M9：writing→verifying 单独占一次调用')
  // 带外改坏一条：校验读的是已提交数据，所以这一改一定会被逐条比对抓到
  const m9Book = m9.doc().bookId
  const victimKey = Object.keys(m9.db.records).find(function (key) {
    return m9.db.records[key].bookId === m9Book && m9.db.records[key].id === 'B-s'
  })
  m9.db.records[victimKey] = Object.assign({}, m9.db.records[victimKey], { amount: 999 })
  m9State = await m9.call('migrateRecords', { limit: 50 })
  assert.strictEqual(m9State.state, 'failed', 'M9：校验不过必须 failed')
  assert.ok(/V2|V3|V1/.test(JSON.stringify(m9State.problems)), 'M9：要给出具体 diff')
  assert.ok(m9State.problems.some(function (item) {
    return item.check === 'V2' && item.id === 'B-s' && item.fields.indexOf('amount') >= 0
  }), 'M9：diff 要指到具体哪条记录的哪个字段')
  const m9Doc = m9.doc()
  assert.ok(!m9Doc.recordsMigratedAt, 'M9：校验不过绝不写 recordsMigratedAt')
  assert.strictEqual(m9Doc.migration.phase, 'failed')
  assert.strictEqual((await m9.call('getLedger', {})).ledger.recordsPendingMigration, true,
    'M9：读仍然走老路径')
  await rejects(function () {
    return m9.call('addSale', { paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }] })
  }, /还没完成流水升级/)
  // failed 之后不带 restart 再调，要报一条说得清怎么办的错
  await rejects(function () {
    return m9.call('migrateRecords', { limit: 50 })
  }, /要重来请带 restart/)

  // =========================================================================
  // M10 restart / newBook / rollback 三条恢复路
  // =========================================================================
  // restart：同账套重写，把 M9 改坏的那条盖回去（_id 确定，set 幂等，直接覆盖）
  const m10Done = await m9.runMigration({ limit: 50, restart: true })
  assert.strictEqual(m10Done.state, 'done', 'M10 restart：同账套重写之后必须能跑完')
  assert.strictEqual(m9.doc().bookId, m9Book, 'M10 restart：账套号不变')
  assert.deepStrictEqual(m9.doc().accounts, inv.foldAccountTerms(await m9.pagedAll()))

  // newBook：换一本新账套，老半成品不可达（O(1) 回滚）
  const m10b = await openLegacyShop('m10b')
  await m10b.call('migrateRecords', { limit: 1 })
  await m10b.call('migrateRecords', { limit: 1 })
  const oldBook = m10b.doc().bookId
  assert.strictEqual(m10b.docsOfBook(oldBook).length, 1, 'M10 newBook：老账套里有一条半成品')
  const m10bDone = await m10b.runMigration({ limit: 50, newBook: true })
  assert.strictEqual(m10bDone.state, 'done')
  const newBook = m10b.doc().bookId
  assert.notStrictEqual(newBook, oldBook, 'M10 newBook：账套号必须换掉')
  assert.strictEqual(m10b.docsOfBook(oldBook).length, 1, 'M10 newBook：老半成品原地不动、不可达')
  assert.strictEqual(m10b.docsOfBook(newBook).length, m10bDone.total)
  assert.deepStrictEqual((await m10b.pagedAll()).map(function (item) { return item.id }).sort(),
    migrate.sortDesc(apply.legacyRecordsOf({ records: clone(m10b.doc().records) }))
      .map(function (item) { return item.id }).sort(),
    'M10 newBook：读到的是新账套那一份')

  // rollback：只清 recordsMigratedAt 和 migration，老数组还在，读写立刻退回老路径
  const m10c = await openLegacyShop('m10c')
  const m10cLegacy = clone(m10c.doc().records)
  await m10c.runMigration({ limit: 50 })
  assert.ok(m10c.doc().recordsMigratedAt > 0)
  const rolled = await m10c.call('migrateRecords', { mode: 'rollback' })
  assert.strictEqual(rolled.state, 'rolledBack')
  assert.strictEqual(rolled.legacyCount, m10cLegacy.length)
  assert.strictEqual(m10c.doc().recordsMigratedAt, 0)
  assert.strictEqual(m10c.doc().migration, null)
  assert.deepStrictEqual(m10c.doc().records, m10cLegacy, 'M10 rollback：老数组一条不动')
  assert.strictEqual((await m10c.call('getLedger', {})).ledger.recordsPendingMigration, true,
    'M10 rollback：读立刻退回老路径')
  await rejects(function () {
    return m10c.call('addSale', { paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }] })
  }, /还没完成流水升级/)
  // 集合里的文档留着，重跑时原样覆盖
  const m10cAgain = await m10c.runMigration({ limit: 50, restart: true })
  assert.strictEqual(m10cAgain.state, 'done', 'M10 rollback：回滚之后还能再迁一次')

  // =========================================================================
  // M11 recomputeAggregates
  // =========================================================================
  console.log('（下面两行 aggregate drift 警告是 M11 故意带外增删流水触发的）')
  const m11 = await openLegacyShop('m11')
  await m11.runMigration({ limit: 50 })
  const m11Book = m11.doc().bookId
  // 带外塞一条：哨兵应当报漂
  const extra = apply.toRecordDoc({
    id: 'ghost', type: 'out', amount: 33, profit: 11, remark: '', createdAt: 9000,
    customerId: 'nc1', customerName: '甲', customerPhone: '13800000001', customerAddress: '甲街 1 号',
    paidAmount: 0, operatorOpenid: '', operatorName: '',
    lines: [{ lineId: 'ghost-l1', productId: 'p1', productName: '牛奶', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 33, costPrice: 22, amount: 33, profit: 11, allocations: [], returnedQty: 0, returnedAmount: 0 }]
  }, m11Book, m11.shopId)
  m11.db.records[extra._id] = extra
  assert.strictEqual((await m11.call('getLedger', {})).ledger.aggregatesStale, true,
    'M11：带外塞一条之后哨兵必须报漂')
  // dryRun 只算不写
  const dry = await m11.call('recomputeAggregates', { dryRun: true })
  assert.strictEqual(dry.dryRun, true)
  assert.strictEqual(dry.changed, true)
  assert.ok(dry.diffs.length > 0, 'M11：返回包永远带 before/after diff')
  assert.strictEqual(dry.before.receivable.nc1, 50)
  assert.strictEqual(dry.after.receivable.nc1, 83, 'M11：塞进去那 33 元赊账要算进去')
  assert.deepStrictEqual(m11.doc().accounts, inv.foldAccountTerms(
    m11.collectionAll(m11Book).filter(function (item) { return item.id !== 'ghost' })
  ), 'M11：dryRun 一个字节都不许写')
  // 真跑
  const fixed = await m11.call('recomputeAggregates', {})
  assert.strictEqual(fixed.changed, true)
  assert.strictEqual(fixed.count, m11.docsOfBook(m11Book).length)
  assert.deepStrictEqual(m11.doc().accounts, inv.foldAccountTerms(m11.collectionAll(m11Book)),
    'M11：重算之后 accounts == 集合全量折叠')
  assert.deepStrictEqual(m11.doc().aggregate, inv.foldTotalTerms(m11.collectionAll(m11Book)))
  assert.ok(!(await m11.call('getLedger', {})).ledger.aggregatesStale, 'M11：哨兵消失')
  // 带外删一条
  delete m11.db.records[extra._id]
  assert.strictEqual((await m11.call('getLedger', {})).ledger.aggregatesStale, true)
  await m11.call('recomputeAggregates', {})
  assert.deepStrictEqual(m11.doc().accounts, inv.foldAccountTerms(m11.collectionAll(m11Book)))
  assert.ok(!(await m11.call('getLedger', {})).ledger.aggregatesStale)
  // 没漂的时候跑一次：changed=false，也不该白写一版
  const revBefore = m11.doc().revision
  const noop = await m11.call('recomputeAggregates', {})
  assert.strictEqual(noop.changed, false)
  assert.strictEqual(m11.doc().revision, revBefore, 'M11：没漂就不写，不白涨 revision')
  // 未迁移的账本要报错
  const m11Pending = await openLegacyShop('m11p')
  await rejects(function () {
    return m11Pending.call('recomputeAggregates', {})
  }, /还没完成流水升级/)
  // 超上限报错，不做无界翻页
  const m11Big = await new Shop({ ids: idFactory('m11big') }).open('大店')
  const bigBook = m11Big.doc().bookId
  for (let i = 0; i <= migrate.RECOMPUTE_MAX_RECORDS; i++) {
    const doc = apply.toRecordDoc({
      id: 'big-' + i, type: 'in', amount: 1, profit: 0, remark: '', createdAt: 1000 + i,
      lines: [{ lineId: 'big-' + i, productId: 'p1', skuId: '', qty: 1, unitPrice: 1, costPrice: 1, amount: 1, profit: 0 }]
    }, bigBook, m11Big.shopId)
    m11Big.db.records[doc._id] = doc
  }
  await rejects(function () {
    return m11Big.call('recomputeAggregates', { dryRun: true })
  }, /超出一次能扫完的范围/)
  await rejects(function () {
    return m11Big.call('checkAggregates', {})
  }, /超出一次能扫完的范围/)

  // =========================================================================
  // M12 权限与门
  // =========================================================================
  const m12 = await openLegacyShop('m12')
  const outsider = new Shop({ db: m12.db, ids: idFactory('m12o'), openid: 'stranger' })
  outsider.shopId = m12.shopId
  const staff = new Shop({ db: m12.db, ids: idFactory('m12s'), openid: 'staff-1' })
  staff.shopId = m12.shopId
  await m12.call('addMember', { openid: 'staff-1', role: 'staff' })
  ;['checkAggregates', 'migrateRecords', 'recomputeAggregates'].forEach(function (action) {
    assert.ok(migrate.OPS_ACTIONS.indexOf(action) >= 0)
  })
  for (let i = 0; i < migrate.OPS_ACTIONS.length; i++) {
    const action = migrate.OPS_ACTIONS[i]
    await rejects(function () {
      return outsider.call(action, {})
    }, /不是该店成员/)
    await rejects(function () {
      return staff.call(action, {})
    }, /只有店主能做账本升级/)
    await rejects(function () {
      return m12.callRaw(action, {}, null, 1)
    }, /请更新小程序到最新版本/)
  }
  // 三个动作都不进 MUTATIONS：它们改的是迁移状态和聚合本身，不是一笔账
  migrate.OPS_ACTIONS.forEach(function (action) {
    assert.ok(apply.MUTATIONS.indexOf(action) < 0,
      'M12：' + action + ' 不许进 MUTATIONS（那会让它走 applyMutation）')
  })

  // =========================================================================
  // M15 特例：空 records（stamp-only）/ 已迁移再调 / 目标账套有残骸
  // =========================================================================
  // 空 records 且没有 recordsMigratedAt：只补戳，accounts 不许被清零
  const m15 = await new Shop({ ids: idFactory('m15') }).open('空账本店')
  await m15.call('saveProduct', { name: '货', costPrice: 2, salePrice: 5, stock: 10, alertQty: 1 })
  await m15.call('saveCustomer', { name: '客户' })
  const m15Ledger = (await m15.call('getLedger', {})).ledger
  await m15.call('addSale', {
    paidAmount: 0, customerId: m15Ledger.customers[0].id,
    items: [{ productId: m15Ledger.products[0].id, qty: 2, unitPrice: 5 }]
  })
  const m15Accounts = clone(m15.doc().accounts)
  const m15Aggregate = clone(m15.doc().aggregate)
  assert.ok(Object.keys(m15Accounts).length, 'M15 自检：这本账已经有活流水和正确聚合')
  m15.patchDoc({ recordsMigratedAt: 0, records: [] })
  const stamped = await m15.call('migrateRecords', {})
  assert.strictEqual(stamped.state, 'done')
  assert.strictEqual(stamped.stampOnly, true, 'M15：空 records 走 stamp-only')
  assert.strictEqual(stamped.total, 0)
  assert.deepStrictEqual(m15.doc().accounts, m15Accounts, 'M15：stamp-only 不许清零 accounts')
  assert.deepStrictEqual(m15.doc().aggregate, m15Aggregate)
  assert.ok(m15.doc().recordsMigratedAt > 0)
  // 已迁移再调要报错，并指出退路
  await rejects(function () {
    return m15.call('migrateRecords', {})
  }, /已经完成流水升级/)
  await rejects(function () {
    return m6.call('migrateRecords', {})
  }, /已经完成流水升级/)
  // 目标账套里已经有文档 -> init 报错，指出 restart / newBook 两条路
  const m15b = await openLegacyShop('m15b')
  const junk = apply.toRecordDoc({
    id: 'junk', type: 'in', amount: 5, profit: 0, remark: '', createdAt: 100,
    lines: [{ lineId: 'junk-l1', productId: 'p1', skuId: '', qty: 1, unitPrice: 5, costPrice: 5, amount: 5, profit: 0 }]
  }, m15b.doc().bookId, m15b.shopId)
  m15b.db.records[junk._id] = junk
  await rejects(function () {
    return m15b.call('migrateRecords', {})
  }, /上次尝试的残骸/)
  // restart 允许覆盖同账套的残骸 —— 但残骸本身不在归并结果里，V1 会抓住它
  const m15bFail = await m15b.runMigration({ limit: 50, restart: true })
  assert.strictEqual(m15bFail.state, 'failed', 'M15：残骸没清掉，V1 条数校验必须拦住')
  assert.ok(/V1/.test(JSON.stringify(m15bFail.problems)))
  assert.ok(!m15b.doc().recordsMigratedAt, 'M15：拦住之后不许切开关')
  // 换一本干净账套就能过
  const m15bDone = await m15b.runMigration({ limit: 50, newBook: true })
  assert.strictEqual(m15bDone.state, 'done')

  // =========================================================================
  // M16 dropLegacy
  // =========================================================================
  const m16 = await openLegacyShop('m16')
  await rejects(function () {
    return m16.call('migrateRecords', { mode: 'dropLegacy' })
  }, /还没完成流水升级/)
  await m16.runMigration({ limit: 50 })
  const m16Before = clone(m16.doc())
  const dropped = await m16.call('migrateRecords', { mode: 'dropLegacy' })
  assert.strictEqual(dropped.state, 'dropped')
  assert.strictEqual(dropped.dropped, m16Before.records.length)
  const m16After = m16.doc()
  assert.deepStrictEqual(m16After.records, [], 'M16：老数组被清空')
  assert.deepStrictEqual(m16After.accounts, m16Before.accounts, 'M16：其余一律不动')
  assert.deepStrictEqual(m16After.aggregate, m16Before.aggregate)
  assert.strictEqual(m16After.recordsMigratedAt, m16Before.recordsMigratedAt)
  assert.strictEqual(m16After.bookId, m16Before.bookId)
  assert.strictEqual((await m16.pagedAll()).length, m16Before.migration.total,
    'M16：流水还在集合里，读得到')
  // 跑完就没有 O(1) 回滚了
  await rejects(function () {
    return m16.call('migrateRecords', { mode: 'rollback' })
  }, /没有可回滚的老流水/)
  // 未知模式要报错，不要静默当成 run
  await rejects(function () {
    return m16.call('migrateRecords', { mode: 'nope' })
  }, /未知的升级模式/)

  // =========================================================================
  // 截断：明细只在带 IO 的壳里截断，纯函数返回全量
  // =========================================================================
  const manyOrphans = []
  for (let i = 0; i < 60; i++) {
    manyOrphans.push({
      id: 'orp-' + i, type: 'return', amount: 1, profit: 0, remark: '', createdAt: 1000 + i,
      customerId: '', customerName: '', customerPhone: '', customerAddress: '', paidAmount: 1,
      lines: [{ lineId: 'orp-' + i + '-l1', productId: 'p1', qty: 1, unitPrice: 1, costPrice: 1, amount: 1, profit: 0, saleOrderId: '', saleLineId: '' }]
    })
  }
  const orphanShop = await openLegacyShop('orp')
  installLegacy(orphanShop, manyOrphans)
  const orphanReport = await orphanShop.call('checkAggregates', {})
  assert.strictEqual(orphanReport.orphanReturns.length, migrate.REPORT_LIST_LIMIT,
    '返回包里的明细要截断到 REPORT_LIST_LIMIT')
  assert.strictEqual(orphanReport.orphanReturnsTotal, 60, '截断之后要给出总数')
  assert.strictEqual(
    migrate.checkLedger(orphanShop.doc(), { shopId: orphanShop.shopId }).orphanReturns.length, 60,
    '纯函数返回全量，截断只发生在壳里'
  )
  // V11 是**非阻塞**的：孤儿退货份额无从算起，报数人工确认，不许拦住迁移
  assert.deepStrictEqual(orphanReport.blocking, [], '孤儿退货不许变成阻塞项')
  const orphanDone = await orphanShop.runMigration({ limit: 50 })
  assert.strictEqual(orphanDone.state, 'done', '有孤儿退货也要能迁完')
  assert.strictEqual(orphanDone.report.orphanReturnsTotal, 60, '迁完的报告里要带孤儿清单')

  // =========================================================================
  // S1–S8 老清空快照转换（mode:'snapshots'）
  //
  // 目的**不是**「三个字段补上了」，是「恢复清空前数据这条路真的能走通」——
  // S3 是这一组的判据，其余几条围着它。
  // =========================================================================

  // ---- S5 前置条件：活账套没迁完就调，要明确报错 -------------------------
  const s5 = await openLegacyShop('s5')
  installLegacyClears(s5, [legacyClearDoc(s5.shopId, 's5-c1', 3000, legacyCorpus())])
  await rejects(function () {
    return s5.call('migrateRecords', { mode: 'snapshots' })
  }, /活账套还没完成流水升级/)
  assert.strictEqual(s5.db.clears['s5-c1'].bookId, undefined,
    'S5：报错的那次不许偷偷改快照')
  // 迁完活账套之后同一句调用就能过
  await s5.runMigration({ limit: 50 })
  const s5Ok = await s5.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s5Ok.state, 'done')
  assert.strictEqual(s5Ok.converted, 1)

  // ---- S1 转换后三个字段都在，且等于对 merged 的全量折叠 -----------------
  const s1 = await openLegacyShop('s1')
  const s1Legacy = legacyCorpus()
  installLegacyClears(s1, [legacyClearDoc(s1.shopId, 's1-c1', 3000, s1Legacy)])
  await s1.runMigration({ limit: 50 })
  const s1Res = await s1.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s1Res.state, 'done')
  assert.deepStrictEqual(
    { converted: s1Res.converted, skipped: s1Res.skipped, failed: s1Res.failed, remaining: s1Res.remaining, total: s1Res.total },
    { converted: 1, skipped: 0, failed: 0, remaining: 0, total: 1 }, 'S1：一份转过来，没有跳过也没有失败')
  const s1Merged = apply.legacyRecordsOf({ records: clone(s1Legacy) })
  const s1Book = migrate.snapshotBookId('s1-c1')
  const s1Doc = s1.db.clears['s1-c1']
  assert.strictEqual(s1Doc.bookId, s1Book, 'S1：快照发到了自己的账套')
  assert.notStrictEqual(s1Doc.bookId, s1.doc().bookId, 'S1：快照账套不能和活账套是同一本')
  assert.deepStrictEqual(s1Doc.accounts, inv.foldAccountTerms(s1Merged),
    'S1：accounts == 对 merged 的全量折叠')
  assert.deepStrictEqual(s1Doc.aggregate, inv.foldTotalTerms(s1Merged),
    'S1：aggregate == 对 merged 的全量折叠')
  assert.strictEqual(s1.docsOfBook(s1Book).length, s1Merged.length,
    'S1：集合里有这份快照的流水')
  assert.deepStrictEqual(s1.collectionAll(s1Book), migrate.sortDesc(s1Merged),
    'S1：落库的流水逐条等于归并 + 重算的结果')
  assert.deepStrictEqual(s1Doc.records, s1Legacy,
    'S1：records 数组**保留不删** —— 和 ledgers.records 同一个理由，那是回滚路')
  assert.deepStrictEqual(s1Res.report.map(function (item) { return item.status }), ['converted'])

  // ---- S2 幂等：再跑一次 converted === 0，快照文档逐字段不变 -------------
  const s2Before = clone(s1.db.clears['s1-c1'])
  const s2DocsBefore = clone(s1.docsOfBook(s1Book))
  const s2Res = await s1.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s2Res.state, 'done')
  assert.deepStrictEqual(
    { converted: s2Res.converted, skipped: s2Res.skipped, failed: s2Res.failed },
    { converted: 0, skipped: 1, failed: 0 }, 'S2：第二次全是跳过')
  assert.deepStrictEqual(s1.db.clears['s1-c1'], s2Before, 'S2：快照文档逐字段不变')
  assert.deepStrictEqual(s1.docsOfBook(s1Book), s2DocsBefore, 'S2：集合里的文档也逐字段不变')

  // ---- S3 端到端：转换之后 restoreCleared 真的能成功 ---------------------
  // 「清空之前」那本账：流水语料和活账套一样（所以每个数都能对回同一张手算表），
  // 但商品库存和客户名单是清空那一刻的样子 —— 这样才验得出「回来的是快照自己
  // 的东西」，而不是「现在这本账本来就长这样」。
  const s3 = await openLegacyShop('s3')
  const s3Lists = corpusLists()
  s3Lists.products = s3Lists.products.map(function (item, at) {
    return Object.assign({}, item, { stock: 100 + at })
  })
  s3Lists.customers = s3Lists.customers.concat([{ id: 'gone', name: '清空前才有的客户' }])
  const s3Legacy = legacyCorpus()
  installLegacyClears(s3, [legacyClearDoc(s3.shopId, 's3-c1', 3000, s3Legacy, s3Lists)])
  const s3Merged = apply.legacyRecordsOf({ records: clone(s3Legacy) })
  const s3WantAccounts = inv.foldAccountTerms(s3Merged)
  const s3WantAggregate = inv.foldTotalTerms(s3Merged)
  await s3.runMigration({ limit: 50 })
  // 迁完之后再记一笔账，让「现在」和「清空之前」不一样，否则下面的相等是假绿
  const s3Sale = await s3.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  })
  const s3SaleId = s3Sale.result.order.id
  const s3Now = (await s3.call('getLedger', {})).ledger
  assert.strictEqual(s3Now.totals.receivable, 240, 'S3 自检：现在欠 240（210 + 新卖的 30）')
  assert.strictEqual(s3Now.hasClearedBackup, true, 'S3 自检：「恢复清空前数据」按钮此刻能点')
  // 转换之前恢复要报错，而且要指出能走通的那条路
  await rejects(function () {
    return s3.call('restoreCleared', {})
  }, /mode:"snapshots"/)
  assert.strictEqual(s3.doc().bookId, s3Now.bookId, 'S3：恢复失败之后账套不许被动过')
  // 转换 -> 恢复
  const s3Conv = await s3.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s3Conv.converted, 1)
  await s3.call('restoreCleared', {})
  const s3Doc = s3.doc()
  const s3After = (await s3.call('getLedger', {})).ledger
  assert.strictEqual(s3Doc.bookId, migrate.snapshotBookId('s3-c1'),
    'S3：账本的指针换到了快照那本账套')
  assert.deepStrictEqual(s3Doc.products, s3Lists.products, 'S3：商品和库存等于清空之前')
  // 账本文档里的 customers 带着 withAggregates 挂上去的 account 投影，比 id / 名字
  assert.deepStrictEqual(s3Doc.customers.map(function (item) {
    return { id: item.id, name: item.name }
  }), s3Lists.customers, 'S3：客户名单等于清空之前')
  assert.deepStrictEqual(s3Doc.accounts, s3WantAccounts, 'S3：每个客户的欠款等于清空之前')
  assert.deepStrictEqual(s3Doc.aggregate, s3WantAggregate, 'S3：全店汇总等于清空之前')
  const s3Records = await s3.pagedAll()
  assert.deepStrictEqual(s3Records, migrate.sortDesc(s3Merged), 'S3：流水逐条等于清空之前')
  assert.ok(!s3Records.some(function (item) { return item.id === s3SaleId }),
    'S3：清空之后记的那笔账不许出现在恢复出来的账套里')
  assert.strictEqual(s3After.totals.receivable, 210, 'S3：全店欠款回到 210（修复后的口径）')
  assert.strictEqual(receivableOf(s3Doc.accounts, 'nc1'), 50, 'S3：nc1 = (100 − 30) − 20')
  assert.strictEqual(receivableOf(s3Doc.accounts, 'nc2'), 100, 'S3：nc2 = 200 − 40 − 60')
  assert.strictEqual(receivableOf(s3Doc.accounts, 'nc3'), 60, 'S3：nc3 = 80 − 20')
  assert.ok(!Object.prototype.hasOwnProperty.call(s3Doc.accounts, 'oldc'),
    'S3：恢复出来的账里也不许有 B2 留下的负账户')
  assert.ok(!s3After.aggregatesStale, 'S3：恢复之后聚合和集合不许有漂')
  assert.strictEqual(s3After.hasClearedBackup, false, 'S3：恢复之后按钮消失')
  // 恢复出来的账仍然能记账（它是一本正常的、已迁移的账套）
  const s3Again = await s3.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  })
  assert.ok(s3Again.result.order, 'S3：恢复出来的账套写路径是通的')

  // ---- S4 空 records 的快照走 stamp-only --------------------------------
  const s4 = await openLegacyShop('s4')
  installLegacyClears(s4, [legacyClearDoc(s4.shopId, 's4-c1', 3000, [])])
  await s4.runMigration({ limit: 50 })
  const s4Res = await s4.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s4Res.converted, 1, 'S4：stamp-only 也算转过来了')
  assert.deepStrictEqual(s4Res.report.map(function (item) { return item.status }), ['stamped'])
  const s4Book = migrate.snapshotBookId('s4-c1')
  const s4Doc = s4.db.clears['s4-c1']
  assert.strictEqual(s4Doc.bookId, s4Book)
  assert.deepStrictEqual(s4Doc.accounts, {}, 'S4：空账套的 accounts 是空的')
  assert.deepStrictEqual(s4Doc.aggregate, inv.emptyTerms(), 'S4：空账套的 aggregate 是空累加器')
  assert.strictEqual(s4.docsOfBook(s4Book).length, 0, 'S4：一条流水都不写')
  // 恢复出来就是一本空账，不是报错
  await s4.call('restoreCleared', {})
  const s4After = (await s4.call('getLedger', {})).ledger
  assert.strictEqual(s4After.bookId, s4Book)
  assert.strictEqual(s4After.totals.receivable, 0)
  assert.deepStrictEqual(await s4.pagedAll(), [], 'S4：恢复出来的空账套翻不出流水')

  // ---- S6 一份坏数据不影响其他份 ----------------------------------------
  // 第二份的元数据指着一份 ledger_clears 里根本不存在的快照（悬空引用）。
  const s6 = await openLegacyShop('s6')
  const s6Docs = [
    legacyClearDoc(s6.shopId, 's6-c1', 3000, legacyCorpus()),
    legacyClearDoc(s6.shopId, 's6-c2', 4000, legacyCorpus()),
    legacyClearDoc(s6.shopId, 's6-c3', 5000, legacyCorpus())
  ]
  installLegacyClears(s6, s6Docs)
  delete s6.db.clears['s6-c2']
  await s6.runMigration({ limit: 50 })
  const s6Res = await s6.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s6Res.state, 'done', 'S6：一份坏的不许让整轮卡住不收敛')
  assert.deepStrictEqual(
    { converted: s6Res.converted, skipped: s6Res.skipped, failed: s6Res.failed, remaining: s6Res.remaining },
    { converted: 2, skipped: 0, failed: 1, remaining: 0 }, 'S6：坏的记一笔 failed，其余照转')
  assert.deepStrictEqual(s6Res.report.map(function (item) { return item.id + ':' + item.status }),
    ['s6-c1:converted', 's6-c2:failed', 's6-c3:converted'], 'S6：坏的那份要进 report')
  assert.ok(/找不到/.test(s6Res.report[1].reason), 'S6：report 要说清坏在哪')
  const s6Merged = apply.legacyRecordsOf({ records: legacyCorpus() })
  assert.strictEqual(s6.db.clears['s6-c1'].bookId, migrate.snapshotBookId('s6-c1'))
  assert.strictEqual(s6.db.clears['s6-c3'].bookId, migrate.snapshotBookId('s6-c3'))
  assert.strictEqual(s6.docsOfBook(migrate.snapshotBookId('s6-c1')).length, s6Merged.length)
  assert.strictEqual(s6.docsOfBook(migrate.snapshotBookId('s6-c3')).length, s6Merged.length)
  // 最近一份（s6-c3）转好了，所以这家店的「恢复清空前数据」照样能用
  await s6.call('restoreCleared', {})
  assert.strictEqual(s6.doc().bookId, migrate.snapshotBookId('s6-c3'),
    'S6：坏掉的那份不许把还能恢复的那份也拖下水')
  // 坏数据 + 小 limit：失败**不许吃预算**，否则一份修不好的快照会把预算吃光，
  // remaining 永远归不了零，循环调不收敛（runSnapshots 会撞上 100 次上限报错）。
  const s6b = await openLegacyShop('s6b')
  installLegacyClears(s6b, [
    legacyClearDoc(s6b.shopId, 's6b-c1', 3000, legacyCorpus()),
    legacyClearDoc(s6b.shopId, 's6b-c2', 4000, legacyCorpus()),
    legacyClearDoc(s6b.shopId, 's6b-c3', 5000, legacyCorpus())
  ])
  delete s6b.db.clears['s6b-c2']
  await s6b.runMigration({ limit: 50 })
  const s6bCalls = await s6b.runSnapshots({ limit: 1 })
  assert.strictEqual(s6bCalls.length, 2, 'S6：坏的那份不吃预算，两次调用就收敛')
  assert.strictEqual(s6bCalls[s6bCalls.length - 1].failed, 1, 'S6：收敛之后仍然如实报 failed')
  assert.strictEqual(s6b.db.clears['s6b-c3'].bookId, migrate.snapshotBookId('s6b-c3'),
    'S6：坏的那份后面的快照照样转得到')

  // ---- S7 limit 分批：最终状态与一次性跑相同 -----------------------------
  async function threeSnapshotShop(prefix) {
    const shop = await openLegacyShop(prefix)
    installLegacyClears(shop, [
      // 三份语料**内容各不相同**（见 taggedCorpus 的注释）：账套号写死的话它们会
      // 挤进同一本账套，countAll 立刻对不上。用同一份语料这条就测不出来。
      legacyClearDoc(shop.shopId, prefix + '-c1', 3000, taggedCorpus('t1')),
      legacyClearDoc(shop.shopId, prefix + '-c2', 4000, taggedCorpus('t2')),
      legacyClearDoc(shop.shopId, prefix + '-c3', 5000, taggedCorpus('t3'))
    ])
    await shop.runMigration({ limit: 50 })
    return shop
  }
  function snapshotStateOf(shop, ids) {
    return ids.map(function (id) {
      const doc = shop.db.clears[id]
      return {
        bookId: doc.bookId,
        accounts: doc.accounts,
        aggregate: doc.aggregate,
        legacyRecords: doc.records,
        // 集合内容用 fromRecordDoc 比：_id / bookId / shopId / sortKey 是派生字段，
        // 两家店本来就不一样，比它们只会比出「不是同一家店」
        records: shop.collectionAll(doc.bookId)
      }
    })
  }
  const s7a = await threeSnapshotShop('s7a')
  const s7b = await threeSnapshotShop('s7b')
  const s7Calls = await s7a.runSnapshots({ limit: 1 })
  assert.strictEqual(s7Calls.length, 3, 'S7：limit:1 三份要三次调用')
  assert.deepStrictEqual(s7Calls.map(function (item) {
    return item.converted + '/' + item.skipped + '/' + item.remaining
  }), ['1/0/2', '1/1/1', '1/2/0'], 'S7：逐份推进，已转好的下一次白跳过')
  assert.deepStrictEqual(s7Calls.map(function (item) { return item.state }),
    ['running', 'running', 'done'])
  const s7One = await s7b.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s7One.converted, 3, 'S7 自检：一次性跑一次就转完三份')
  assert.deepStrictEqual(
    snapshotStateOf(s7a, ['s7a-c1', 's7a-c2', 's7a-c3']).map(function (item, at) {
      return Object.assign({}, item, { bookId: item.bookId.replace('s7a-c' + (at + 1), 'X') })
    }),
    snapshotStateOf(s7b, ['s7b-c1', 's7b-c2', 's7b-c3']).map(function (item, at) {
      return Object.assign({}, item, { bookId: item.bookId.replace('s7b-c' + (at + 1), 'X') })
    }),
    'S7：分批跑完的最终状态和一次性跑完的相同'
  )

  // 三份必须落到三本**不同**的账套，各自只装自己那 6 条。账套号写死的话它们会挤
  // 进同一本，这两条断言当场红。
  const s7Books = ['s7a-c1', 's7a-c2', 's7a-c3'].map(function (id) {
    return s7a.db.clears[id].bookId
  })
  assert.strictEqual(new Set(s7Books).size, 3, 'S7：三份快照的账套号必须互不相同')
  s7Books.forEach(function (bookId, at) {
    const docs = Object.keys(s7a.db.records).filter(function (key) {
      return s7a.db.records[key].bookId === bookId
    })
    const tag = 't' + (at + 1)
    // 条数从语料算出来，不写死：归并会把同 orderId 的销售行并成一单
    const expected = apply.legacyRecordsOf({ records: taggedCorpus(tag) }).length
    assert.strictEqual(docs.length, expected,
      'S7：账套 ' + bookId + ' 只该装自己那 ' + expected + ' 条，装了 ' + docs.length + ' 条')
    docs.forEach(function (key) {
      assert.ok(String(s7a.db.records[key].id).indexOf(tag + '-') === 0,
        'S7：账套 ' + bookId + ' 里混进了别份快照的流水 ' + s7a.db.records[key].id)
    })
  })

  // ---- S8 转换后的快照流水也吃到了份额重算 -------------------------------
  // 「退货 payType 与销售过期」：赊账卖 100，退 30，退货单的 payType 还停在
  // 改档之前的 cash。不重算 -> 退货一分不冲欠款，恢复出来欠 100（错账）。
  const s8 = await openLegacyShop('s8')
  const s8Legacy = [
    { id: 'st-s', type: 'out', orderId: 'st-s', productId: 'p1', productName: '货', qty: 2, unitPrice: 50, costPrice: 30, amount: 100, profit: 40, payType: 'credit', customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', createdAt: 1000 },
    { id: 'st-r', type: 'return', saleRecordId: 'st-s', productId: 'p1', productName: '货', qty: 1, unitPrice: 30, costPrice: 20, amount: 30, profit: -10, payType: 'cash', customerId: 'c1', customerName: '甲', customerPhone: '', customerAddress: '', createdAt: 2000 }
  ]
  const s8Lists = corpusLists()
  s8Lists.customers = [{ id: 'c1', name: '甲' }]
  installLegacyClears(s8, [legacyClearDoc(s8.shopId, 's8-c1', 3000, s8Legacy, s8Lists)])
  // 自检：不重算的话这份快照折出来是 100，重算之后才是 70
  assert.strictEqual(
    receivableOf(inv.foldAccountTerms(migrate.mergeOnly(clone(s8Legacy))), 'c1'), 100,
    'S8 自检：只归并不重算，欠款是错的 100'
  )
  await s8.runMigration({ limit: 50 })
  const s8Res = await s8.call('migrateRecords', { mode: 'snapshots' })
  assert.strictEqual(s8Res.converted, 1)
  assert.strictEqual(receivableOf(s8.db.clears['s8-c1'].accounts, 'c1'), 70,
    'S8：快照的 accounts 是重算之后的 70')
  await s8.call('restoreCleared', {})
  const s8After = (await s8.call('getLedger', {})).ledger
  assert.strictEqual(s8After.totals.receivable, 70, 'S8：恢复出来的欠款是修好的值')
  assert.strictEqual(
    (await s8.pagedAll()).find(function (item) { return item.id === 'st-r' }).paidAmount, 0,
    'S8：退货单落库时的现金退款额是重算出来的 0，不是回推的 30'
  )
  assert.deepStrictEqual(migrate.auditRecords(await s8.pagedAll()).splitViolations, [],
    'S8：恢复出来的账套里拆分不变量成立')

  console.log('ledger-migrate tests passed')
  console.log('M3 纯函数 V4–V12 逐项隔离、M4 三代混合预检 P1–P13、M5 送货单前后逐张相等、'
    + 'M6/M14 端到端、M7 解冻、M8 幂等重发 ×3、M9 校验不过不切开关、'
    + 'M10 restart/newBook/rollback、M11 重算与上限、M12 权限与版本门、M15 三个特例、M16 dropLegacy')
  console.log('老清空快照转换 S1 三字段与集合、S2 幂等、S3 端到端恢复（商品/库存/流水/欠款回到清空之前）、'
    + 'S4 stamp-only、S5 前置条件、S6 一份坏的不拖累其他份、S7 limit 分批、S8 份额重算')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
