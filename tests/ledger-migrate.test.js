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
    'splitViolations', 'subCent', 'negativeAccounts', 'mixedPrice']

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
      // 迁移不修单价，只修份额。这类单搬进集合之后销售额和毛利仍然是两套价拼的，
      // 而迁移后 legacyRecordsOf 不再跑，没有第二次读时修复的机会 —— 所以要在
      // 预检就拦住，让店主先在小程序里把那几张单改一下（写路径会拨回一致）。
      name: 'P14 同一件商品两套价：销售行改过价、退货行还挂旧价',
      hit: 'mixedPrice',
      mutate: function (list) { list[1].lines[0].unitPrice = 99 }
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

  // V12 专项（阶段 3）：现有 M3 语料的亚分值只放在**单头**。subCentOf 对行上
  // 另有一份键（MONEY_LINE_KEYS：amount / profit / unitPrice / costPrice /
  // returnedAmount），哪边少一个键名，放在那儿的亚分值就会被静默放行。
  const lineSubCent = cleanSet()
  lineSubCent[0].lines[0].unitPrice = 50.005
  assert.ok(migrate.auditRecords(lineSubCent).subCent.some(function (item) {
    return item.field === 'lines[0].unitPrice'
  }), 'V12 专项：亚分值放在行上也要报，且指出是哪个字段')

  // 容差必须还是 1e-9，不是 1e-2：centDiff 落在 (1e-9, 1e-2) 区间里的值
  // （10.00001 ×100 后差 0.001）只有 1e-9 的容差会报；放宽到 1e-2 它就静默过掉。
  const tightSubCent = cleanSet()
  tightSubCent[0].amount = 110.00001
  assert.ok(migrate.auditRecords(tightSubCent).subCent.some(function (item) {
    return item.field === 'amount' && item.id === 'S1'
  }), 'V12 专项：centDiff 0.001 也要报 —— 容差是 1e-9，不是 1e-2')

  // 反向：round2 的合法输出必须放行。0.07 ×100 = 7.000000000000001，
  // centDiff 约 1e-15。这道容差存在的意义就是吃掉这类浮点表示误差。
  const benignCents = cleanSet()
  benignCents[0].amount = 0.07
  benignCents[0].lines[0].amount = 0.07
  assert.deepStrictEqual(migrate.auditRecords(benignCents).subCent, [],
    'V12 专项：round2 的输出不许被当成亚分（否则整条 V12 都没法用）')

  // V4 专项（阶段 3）：数量对得上、金额对不上。现有 M3 语料只造了 returnedQty
  // 不一致，returnedAmount 那半（stored vs Σ退货额）从没以失败形态跑过。
  const amountMismatch = cleanSet()
  amountMismatch[0].lines[0].returnedAmount = 999
  const amountAudit = migrate.auditRecords(amountMismatch)
  assert.ok(amountAudit.returnedMismatch.some(function (item) {
    return item.field === 'returnedAmount' && item.stored === 999 && item.fromReturns === 50
  }), 'V4 专项：returnedAmount 对不上必须报，且给出两边的数')
  assert.ok(amountAudit.returnedMismatch.every(function (item) {
    return item.field !== 'returnedQty'
  }), 'V4 专项：数量是一致的（1 == 1），不许顺带报 returnedQty')

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
  // M9b（阶段 3）四份脏语料各跑一遍**完整迁移**：verifyPhase 翻完页之后那道
  //       总门（recordFailures 的 V4/V5/V6/V8/V12 + foldProblems 的 V3 + 条数
  //       的 V1）从来没有以失败形态被跑过 —— M9 只测了 per-chunk 的 V2，
  //       M15b 只测了 init 之前就存在的残骸。
  //
  // 语料构造原则：脏的地方全在「单的内容」上，集合往返逐条相等，per-chunk
  // 校验（V1/V2/V7 的逐条比对）必然干净，失败只能来自翻完后的总门。
  // 唯一的例外是重复 id 那份，见下面它自己的注释。
  // =========================================================================
  function subCentLegacy() {
    return [{
      id: 'SC-s', type: 'out', amount: 10.005, profit: 4, remark: '', createdAt: 2000,
      customerId: 'nc1', customerName: '甲', customerPhone: '', customerAddress: '',
      paidAmount: 0, operatorOpenid: '', operatorName: '',
      lines: [{ lineId: 'SC-s-l1', productId: 'p1', productName: '牛奶', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 10.005, costPrice: 6, amount: 10.005, profit: 4, allocations: [], returnedQty: 0, returnedAmount: 0 }]
    }]
  }

  function negativeAccountLegacy() {
    // 负账户要「份额重算改了钱」才显形（实测：孤儿退货**折不出负账户**——
    // settledAmount 对两个结算字段都没有的退货保守回推成整笔退现金，贡献 0）。
    // 这份语料和 10c-V6 同构：赊销 100 ＋ 无结算字段的退货 30 ＋ 收款 100。
    // 重算前：退货被当整笔退现金，欠款 100 − 100 = 0，那笔收款当时合法；
    // 重算把退货拨成全部冲欠款，欠款变成 100 − 30 − 100 = −30。
    return [
      { id: 'NA-pay', type: 'pay', amount: 100, remark: '', customerId: 'nc2', customerName: '乙', customerPhone: '', customerAddress: '', createdAt: 3000 },
      { id: 'NA-r', type: 'return', saleRecordId: 'NA-l1', productId: 'p1', productName: '牛奶', qty: 1, unitPrice: 30, costPrice: 20, amount: 30, profit: -10, customerId: 'nc2', customerName: '乙', customerPhone: '', customerAddress: '', createdAt: 2000 },
      { id: 'NA-l1', type: 'out', orderId: 'NA-ord', productId: 'p1', productName: '牛奶', qty: 1, unitPrice: 100, costPrice: 60, amount: 100, profit: 40, payType: 'credit', customerId: 'nc2', customerName: '乙', customerPhone: '', customerAddress: '', createdAt: 1000 }
    ]
  }

  function duplicateIdLegacy() {
    function row(id, createdAt) {
      return {
        id: id, type: 'in', amount: 20, profit: 0, remark: '', createdAt: createdAt,
        lines: [{ lineId: id + '-l1', productId: 'p1', productName: '牛奶', sku: '', skuId: '', color: '', size: '', qty: 2, unitPrice: 10, costPrice: 10, amount: 20, profit: 0 }]
      }
    }
    return [row('DUP-a', 2000), row('DUP-a', 3000)]
  }

  function returnedLieLegacy() {
    // 销售行谎报 returnedQty: 5，整份账本里没有任何指向它的退货单。
    // returnedAmount 记 0（和 Σ退货额 0 一致），只踩 returnedQty 那半。
    return [{
      id: 'LIE-s', type: 'out', amount: 100, profit: 40, remark: '', createdAt: 2000,
      customerId: 'nc1', customerName: '甲', customerPhone: '', customerAddress: '',
      paidAmount: 0, operatorOpenid: '', operatorName: '',
      lines: [{ lineId: 'LIE-s-l1', productId: 'p1', productName: '牛奶', sku: '', skuId: '', color: '', size: '', qty: 2, unitPrice: 50, costPrice: 30, amount: 100, profit: 40, allocations: [], returnedQty: 5, returnedAmount: 0 }]
    }]
  }

  const M9B_CORPORA = [
    { name: 'V12 亚分金额', make: subCentLegacy, check: 'V12' },
    { name: 'V6 负账户', make: negativeAccountLegacy, check: 'V6' },
    { name: 'V8 重复 id', make: duplicateIdLegacy, check: null },
    { name: 'V4 returnedQty 谎报', make: returnedLieLegacy, check: 'V4' }
  ]
  for (let i = 0; i < M9B_CORPORA.length; i++) {
    const item = M9B_CORPORA[i]
    const shop = await openLegacyShop('m9b' + i, item.make())
    const done = await shop.runMigration({ limit: 50 })
    assert.strictEqual(done.state, 'failed',
      'M9b（' + item.name + '）：完整迁移必须 failed，不许带着病切开关')
    assert.ok(!shop.doc().recordsMigratedAt,
      'M9b（' + item.name + '）：failed 之后绝不写 recordsMigratedAt')
    assert.strictEqual((await shop.call('getLedger', {})).ledger.recordsPendingMigration, true,
      'M9b（' + item.name + '）：读路径仍然走老数组')
    await rejects(function () {
      return shop.call('addSale', {
        paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
      })
    }, /还没完成流水升级/)
    if (item.check) {
      // problems 会被 REPORT_LIST_LIMIT 截断、多项可能同时命中，只做存在性断言
      assert.ok(done.problems.some(function (p) { return p && p.check === item.check }),
        'M9b（' + item.name + '）：problems 里必须有 check === ' + item.check)
    }
  }

  // 重复 id 那份单独说明：迁移路上它**到不了**总门的 V8。两条记录同一个 id
  // → 集合里被 set() 覆盖成一条 → per-chunk 的逐条比对先错位（V1/V2/V7 之一）
  // → failMigration 在翻页阶段就发生。所以这里只断言「failed + 没切开关 +
  // 确实报了问题」，不断言 V8 —— V8 的失败形态由下面 M4b 的纯函数路（P9）
  // 钉住。实测这份语料在迁移路上报的是 V2（第二条把第一条盖掉，逐条比对
  // 发现字段对不上）。
  {
    const dupShop = await openLegacyShop('m9b-dup', duplicateIdLegacy())
    const dupDone = await dupShop.runMigration({ limit: 50 })
    assert.strictEqual(dupDone.state, 'failed')
    assert.ok(!dupShop.doc().recordsMigratedAt)
    assert.ok(dupDone.problemsTotal > 0 && dupDone.problems.length > 0,
      'M9b 重复 id：虽然到不了 V8，逐条比对必须把这次失败报出来')
  }

  // =========================================================================
  // M4b（阶段 3）同一批脏语料只跑预检：blocking 必须非空且**点名**。
  //       M4 只断言过干净语料 blocking === []，blockingOf 里逐项 add 去掉
  //       任何一行测试都还是绿的（变异 H02：开头 return []）。
  // =========================================================================
  const M4B_CORPORA = [
    { name: 'V12 亚分金额', make: subCentLegacy, blocking: 'P3 亚分金额' },
    { name: 'V6 负账户', make: negativeAccountLegacy, blocking: 'P5 迁移后仍有负账户' },
    { name: 'V8 重复 id', make: duplicateIdLegacy, blocking: 'P9 重复 id' },
    { name: 'V4 returnedQty 谎报', make: returnedLieLegacy, blocking: 'P8 returnedQty/Amount 跨行不一致' }
  ]
  for (let i = 0; i < M4B_CORPORA.length; i++) {
    const item = M4B_CORPORA[i]
    const shop = await openLegacyShop('m4b' + i, item.make())
    const report = await shop.call('checkAggregates', {})
    assert.ok(report.blocking.length > 0,
      'M4b（' + item.name + '）：blocking 必须非空，否则预检会说「可以迁」')
    assert.ok(report.blocking.some(function (b) { return b && b.check === item.blocking }),
      'M4b（' + item.name + '）：blocking 必须点名 ' + item.blocking)
  }

  // =========================================================================
  // M9c（阶段 3）V1 专项：删掉集合里**排在最后**（最老）的那条文档。
  //       剩下的 6 条恰好还是 wanted 的前 6 条，per-chunk 逐条比对全部对齐，
  //       失败只能来自翻完页之后的两条条数判定（nextVerified ≠ total、
  //       collectionCount ≠ total）。这是总门里 V1 的失败形态；M15b 那条
  //       （残骸 createdAt 更小、也排在最后）走的其实是同一形态，但那份语料
  //       的残骸是 init 之前就在的，这里钉的是「迁移过程中丢一条」。
  // =========================================================================
  const m9c = await openLegacyShop('m9c')
  await m9c.call('migrateRecords', { limit: 50 })   // init
  await m9c.call('migrateRecords', { limit: 50 })   // 一片写完
  let m9cState = await m9c.call('migrateRecords', { limit: 50 })   // writing -> verifying
  assert.strictEqual(m9cState.phase, 'verifying')
  const m9cBook = m9c.doc().bookId
  const m9cMerged = apply.legacyRecordsOf({ records: clone(m9c.doc().records) })
  const m9cOldest = migrate.sortDesc(m9cMerged)[m9cMerged.length - 1]   // A-ord（createdAt 2000）
  const m9cKey = Object.keys(m9c.db.records).find(function (key) {
    return m9c.db.records[key].bookId === m9cBook && m9c.db.records[key].id === m9cOldest.id
  })
  delete m9c.db.records[m9cKey]
  m9cState = await m9c.call('migrateRecords', { limit: 50 })
  assert.strictEqual(m9cState.state, 'failed', 'M9c：少了一条必须 failed')
  assert.ok(m9cState.problems.some(function (p) { return p && p.check === 'V1' }),
    'M9c：problems 里必须有 V1（条数和归并条数不等）')
  assert.ok(!m9c.doc().recordsMigratedAt, 'M9c：failed 之后绝不写 recordsMigratedAt')

  // =========================================================================
  // M9d（阶段 3）V3 专项：只漂**一个客户**时，diff 必须点名那个 customerId。
  //       M6 的 brokenDocs 改的是 docs[0]，受影响的是哪个客户取决于文档袋的
  //       key 顺序，从来没断言过「报出来的就是漂了的那个客户」。
  //       两条路各钉一次：verifyMigrated（纯函数）和已迁移店的 checkAggregates
  //      （账本存的 accounts vs 集合全量折叠，aggregateDiffs）。
  // =========================================================================
  const m9dDocs = clone(m6.docsOfBook(m6.doc().bookId))
  const m9dVictim = m9dDocs.find(function (doc) { return doc.id === 'B-s' })   // nc2 的销售单
  m9dVictim.amount = m9dVictim.amount + 1
  const m9dProblems = migrate.verifyMigrated(m6Merged, m9dDocs, m6.doc().bookId, m6.shopId)
  assert.ok(m9dProblems.some(function (item) {
    return item.check === 'V3' && item.customerId === 'nc2'
  }), 'M9d：verifyMigrated 的 V3 必须点名漂了的那个 customerId')

  const m9dAccountsBefore = clone(m6.doc().accounts)
  m6.patchDoc({
    accounts: Object.assign({}, m9dAccountsBefore, { nc2: inv.emptyTerms() })
  })
  const m9dCheck = await m6.call('checkAggregates', {})
  assert.strictEqual(m9dCheck.aggregatesStale, true, 'M9d：单客户漂移必须点亮哨兵')
  assert.ok(m9dCheck.aggregateDiffs.some(function (item) {
    return item.customerId === 'nc2' && item.field === 'salesSum'
  }), 'M9d：aggregateDiffs 必须点名 nc2 的具体字段')
  assert.ok(!m9dCheck.aggregateDiffs.some(function (item) {
    return item.customerId && item.customerId !== 'nc2'
  }), 'M9d：只漂了 nc2，别的客户不许被点名')
  m6.patchDoc({ accounts: m9dAccountsBefore })

  // =========================================================================
  // M9e（阶段 3）clampChunk 上界：limit 传 9999，一次 writing 只许写 500
  //       （MIGRATE_CHUNK_MAX）。下界（limit:1）和缺省 M8 已测。
  //       clampChunk 没有导出，从返回包的 cursor 读实际生效值。
  // =========================================================================
  const m9eLegacy = []
  for (let i = 0; i < 520; i++) {
    m9eLegacy.push({
      id: 'm9e-' + i, type: 'in', amount: 1, profit: 0, remark: '', createdAt: 2000 + i,
      lines: [{ lineId: 'm9e-' + i + '-l1', productId: 'p1', productName: '牛奶', sku: '', skuId: '', color: '', size: '', qty: 1, unitPrice: 1, costPrice: 1, amount: 1, profit: 0 }]
    })
  }
  const m9e = await openLegacyShop('m9e', clone(m9eLegacy))
  await m9e.call('migrateRecords', { limit: 9999 })   // init
  const m9eWrite = await m9e.call('migrateRecords', { limit: 9999 })
  assert.strictEqual(m9eWrite.total, 520, 'M9e 前提：归并后 520 条（每张进货各自成单）')
  assert.strictEqual(m9eWrite.phase, 'writing')
  assert.strictEqual(m9eWrite.cursor, 500,
    'M9e：limit 9999 必须被钳到 500，一次 writing 只前进 500')
  assert.strictEqual(m9eWrite.written, 500)

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

  // -------------------------------------------------------------------------
  // M10d 回滚守卫：迁完之后记过账，不带 force 必须拒绝
  // -------------------------------------------------------------------------
  // 夹具坑：语料里的 createdAt 是 3000..8000，而 Shop 的合成时钟从 1000 起步。
  // 这里显式传 now = 9000，让新记的这笔账真的排在最新一页最前面 —— 否则测的是
  // 「一页装得下全部」的退化情形，验不到「新账在前缀」这条性质。
  const m10d = await openLegacyShop('m10d')
  await m10d.runMigration({ limit: 50 })
  const m10dMerged = apply.legacyRecordsOf({ records: clone(m10d.doc().records) }).length
  const m10dSale = await m10d.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  }, 9000)
  // addSale 的回包里那条流水挂在 result.order 上（applyMutation 写的是
  // `result.order = applied.order`，而 applySaleOrder 的 order 就是 record 本身），
  // **不是** result.record —— 别照着 addPurchase 的写法抄。
  const m10dNewId = m10dSale.result.order.id
  await rejects(function () {
    return m10d.call('migrateRecords', { mode: 'rollback' })
  }, /迁完之后动过/)
  assert.ok(m10d.doc().recordsMigratedAt > 0, 'M10d：被拒绝的回滚一个字都不许改账本')
  // 迁完之后记一笔账，ledgers.migration **必须还在**（2b-1b 审计 A6：以前
  // applyMutation 只带 records / recordsMigratedAt / migratedFromLocal / importing
  // 四个字段，第一笔销售就把它抹了，dropLegacy 当场没了出路）。钉在 M16b。

  const m10dForced = await m10d.call('migrateRecords', { mode: 'rollback', force: true })
  assert.strictEqual(m10dForced.state, 'rolledBack')
  assert.strictEqual(m10dForced.forced, true)
  assert.strictEqual(m10dForced.foreignCount, 1, 'M10d：最新一页里有一条不在老数组')
  assert.strictEqual(m10dForced.foreignMore, false)
  assert.strictEqual(m10dForced.foreignSample[0].id, m10dNewId)
  assert.strictEqual(m10dForced.mergedCount, m10dMerged)
  assert.strictEqual(m10dForced.collectionCount, m10dMerged + 1)
  assert.strictEqual(m10dForced.discarded, 1)
  assert.strictEqual(m10dForced.probeError, '')
  assert.strictEqual(m10dForced.countError, '')
  assert.strictEqual(m10d.doc().recordsMigratedAt, 0, 'M10d：force 之后确实回滚了')

  // -------------------------------------------------------------------------
  // M10e 条数骗得过、id 骗不过 —— 只比条数的守卫会在这里放行
  // -------------------------------------------------------------------------
  const m10e = await openLegacyShop('m10e')
  await m10e.runMigration({ limit: 50 })
  const m10eMerged = apply.legacyRecordsOf({ records: clone(m10e.doc().records) }).length
  await m10e.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  }, 9000)
  await m10e.call('deleteRecord', { id: 'A-pay' })   // 删掉一条老账，条数抹平
  const m10eForced = await m10e.call('migrateRecords', { mode: 'rollback', force: true })
  assert.strictEqual(m10eForced.collectionCount, m10eMerged,
    'M10e 前提：删一条加一条之后集合条数和归并条数相等，只比条数的守卫在这里是瞎的')
  assert.strictEqual(m10eForced.foreignCount, 1, 'M10e：id 比对仍然抓得到那笔新账')
  assert.strictEqual(m10eForced.discarded, 1)

  // 同一场景不带 force 必须被拒（上一句已经把 m10e 回滚掉了，另开一家店重跑）
  const m10e2 = await openLegacyShop('m10e2')
  await m10e2.runMigration({ limit: 50 })
  await m10e2.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  }, 9000)
  await m10e2.call('deleteRecord', { id: 'A-pay' })
  await rejects(function () {
    return m10e2.call('migrateRecords', { mode: 'rollback' })
  }, /迁完之后动过/)

  // -------------------------------------------------------------------------
  // M10f B-1 回归：**事务内不许依赖 count()**
  // -------------------------------------------------------------------------
  // wx-server-sdk 的 Transaction.Collection 有没有实现 count() 是未实测项，而
  // rollbackMigration 是全店停摆窗口里唯一的紧急出路。这里把「事务快照那一侧」的
  // count() 换成抛错（事务外那一份不动，它是当晚已经跑过的那一份），整条回滚路
  // 必须表现得和 M10d 一模一样。谁把 countAll() 挪回事务里，这条当场变红。
  const m10f = await openLegacyShop('m10f')
  await m10f.runMigration({ limit: 50 })
  await m10f.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  }, 9000)
  const m10fProto = Object.getPrototypeOf(m10f.db.recordsCtx().collection.where({}))
  const m10fRealCount = m10fProto.count
  // 事务里拿到的是 snapshot 里那份 bag（runTransaction 提交时会整份换掉 db.records，
  // 所以这里必须**每次调用时**去读 m10f.db.records，不能提前存下来）
  m10fProto.count = async function () {
    if (this.bag !== m10f.db.records) {
      throw new TypeError('transaction.collection(...).where(...).count is not a function')
    }
    return m10fRealCount.apply(this, arguments)
  }
  try {
    await rejects(function () {
      return m10f.call('migrateRecords', { mode: 'rollback' })
    }, /迁完之后动过/)
    const m10fForced = await m10f.call('migrateRecords', { mode: 'rollback', force: true })
    assert.strictEqual(m10fForced.foreignCount, 1)
    assert.strictEqual(m10fForced.probeError, '', 'M10f：事务内探针不许碰 count()')
    assert.strictEqual(m10fForced.countError, '', 'M10f：事务外那一次 count() 应当照常')
    assert.strictEqual(m10f.doc().recordsMigratedAt, 0)
  } finally {
    m10fProto.count = m10fRealCount
  }

  // -------------------------------------------------------------------------
  // M10g 整页都是外来的 -> foreignMore
  // -------------------------------------------------------------------------
  const m10g = await openLegacyShop('m10g')
  await m10g.runMigration({ limit: 50 })
  const m10gBook = m10g.doc().bookId
  const m10gMerged = apply.legacyRecordsOf({ records: clone(m10g.doc().records) }).length
  for (let i = 0; i < 100; i++) {
    // 带外塞（模拟迁移后记了一整页以上的账），createdAt 全都大于语料里的最大值
    const doc = apply.toRecordDoc({
      id: 'm10g-ghost-' + i, type: 'pay', amount: 1, remark: '', createdAt: 10000 + i,
      customerId: 'nc1', customerName: '甲', customerPhone: '', customerAddress: '', lines: []
    }, m10gBook, m10g.shopId)
    m10g.db.records[doc._id] = doc
  }
  await rejects(function () {
    return m10g.call('migrateRecords', { mode: 'rollback' })
  }, /迁完之后动过/)
  const m10gForced = await m10g.call('migrateRecords', { mode: 'rollback', force: true })
  assert.strictEqual(m10gForced.foreignCount, 100, 'M10g：最新一页 100 条全是外来的')
  assert.strictEqual(m10gForced.foreignMore, true, 'M10g：整页装满就要说「还有更多」')
  assert.strictEqual(m10gForced.foreignSample.length, 5, 'M10g：样本最多 5 条')
  assert.strictEqual(m10gForced.collectionCount, m10gMerged + 100)
  assert.strictEqual(m10gForced.discarded, 100)

  // -------------------------------------------------------------------------
  // M10h 信号②的牙：残骸埋在最新一页**之外**
  // -------------------------------------------------------------------------
  // 这条是回滚守卫「双信号」这个说法的**唯一**证据。M10d/e/e2/f/g 里的外来记录
  // 全部落在最新一页，信号①一个人就能让它们五条全绿 —— 2b-1b 审计把信号②整段
  // 拆掉之后 npm test 照样 EXIT=0。
  //
  // 验收标准（改这段的人必须自己跑一遍）：把 rollbackMigration 里的
  //   const extra = (guard.collectionCount == null || guard.mergedCount == null) ? null : Math.max(...)
  // 改成 `const extra = 0`（= 拆掉信号②的牙），**M10h 必须当场变红**
  //（不带 force 那次不再抛，rejects 里的 assert.fail 触发）。实测确实如此。
  //
  // 场景：老数组 130 条（createdAt 2000..2129）迁完之后，带外塞进 2 条
  // createdAt=500 的文档 —— sortKey 倒序排在 130 条老账**后面**，最新一页
  // （ROLLBACK_PROBE_LIMIT=100 条）里一条都看不见，①在这里是瞎的；
  // 集合 132 条、归并 130 条，②一眼看出多 2 条。
  //
  // 夹具坑：Shop 的合成时钟从 1000 起步，所以 createdAt=500 真的比老数组还早。
  const m10hLegacy = []
  for (let i = 0; i < 130; i++) {
    m10hLegacy.push({
      id: 'm10h-s' + i, type: 'out', amount: 10, profit: 2, remark: '', createdAt: 2000 + i,
      customerId: 'nc1', customerName: '甲', customerPhone: '13800000001', customerAddress: '甲街 1 号',
      paidAmount: 10, operatorOpenid: '', operatorName: '',
      lines: [{
        lineId: 'm10h-s' + i + '-l1', productId: 'p1', productName: '牛奶', sku: '', skuId: '',
        color: '', size: '', qty: 1, unitPrice: 10, costPrice: 8, amount: 10, profit: 2,
        allocations: [], returnedQty: 0, returnedAmount: 0
      }]
    })
  }
  const m10h = await openLegacyShop('m10h', clone(m10hLegacy))
  await m10h.runMigration({ limit: 50 })
  const m10hBook = m10h.doc().bookId
  const m10hMerged = apply.legacyRecordsOf({ records: clone(m10h.doc().records) }).length
  assert.strictEqual(m10hMerged, 130, 'M10h 前提：老数组归并后 130 条，比探针的一页（100）多')
  for (let i = 0; i < 2; i++) {
    // createdAt=500：比老数组里最早的一条（2000）还早，sortKey 倒序排在最后
    const doc = apply.toRecordDoc({
      id: 'm10h-ghost-' + i, type: 'pay', amount: 1, remark: '', createdAt: 500 + i,
      customerId: 'nc1', customerName: '甲', customerPhone: '', customerAddress: '', lines: []
    }, m10hBook, m10h.shopId)
    m10h.db.records[doc._id] = doc
  }
  await rejects(function () {
    return m10h.call('migrateRecords', { mode: 'rollback' })
  }, /迁完之后动过/)
  assert.ok(m10h.doc().recordsMigratedAt > 0, 'M10h：被拒绝的回滚一个字都不许改账本')
  const m10hForced = await m10h.call('migrateRecords', { mode: 'rollback', force: true })
  assert.strictEqual(m10hForced.foreignCount, 0,
    'M10h 前提：外来文档排在最新一页之外，信号①在这里是瞎的（这一条塌了整条用例就不测②了）')
  assert.strictEqual(m10hForced.foreignMore, false, 'M10h：一条都没看见，谈不上还有更多')
  assert.strictEqual(m10hForced.mergedCount, m10hMerged)
  assert.strictEqual(m10hForced.collectionCount, m10hMerged + 2, 'M10h：集合比归并多 2 条')
  assert.strictEqual(m10hForced.discarded, 2, 'M10h：抹掉条数的下界由②给出')
  assert.strictEqual(m10hForced.probeError, '')
  assert.strictEqual(m10hForced.countError, '')
  assert.strictEqual(m10h.doc().recordsMigratedAt, 0, 'M10h：force 之后确实回滚了')

  // -------------------------------------------------------------------------
  // M10i 两个探针都瞎时 discarded 是 null，不是 0
  // -------------------------------------------------------------------------
  // 0 读起来像「什么都没丢」。两个探针都读不到数的时候我们什么都不知道，
  // 回包必须说「不知道」。
  const m10i = await openLegacyShop('m10i')
  await m10i.runMigration({ limit: 50 })
  await m10i.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }] }, 9000)
  const m10iQuery = Object.getPrototypeOf(m10i.db.recordsCtx().collection.where({}))
  const m10iGet = m10iQuery.get
  const m10iCount = m10iQuery.count
  m10iQuery.get = async function () { throw new Error('翻页炸了') }
  m10iQuery.count = async function () { throw new Error('数数炸了') }
  try {
    await rejects(function () {
      return m10i.call('migrateRecords', { mode: 'rollback' })
    }, /回滚守卫读不到数[\s\S]*force: true/)
    const m10iForced = await m10i.call('migrateRecords', { mode: 'rollback', force: true })
    assert.strictEqual(m10iForced.state, 'rolledBack', 'M10i：两个探针都瞎，force 照样出得去')
    assert.strictEqual(m10iForced.discarded, null, 'M10i：两个都瞎时 discarded 必须是 null')
    assert.ok(/翻页炸了/.test(m10iForced.probeError), 'M10i：①失败的原因原样回包')
    assert.ok(/数数炸了/.test(m10iForced.countError), 'M10i：②失败的原因原样回包')
    assert.strictEqual(m10i.doc().recordsMigratedAt, 0)
  } finally {
    m10iQuery.get = m10iGet
    m10iQuery.count = m10iCount
  }

  // -------------------------------------------------------------------------
  // M10j 守卫机器**不许**把紧急出路一起带走
  // -------------------------------------------------------------------------
  // 合同：「守卫可以失灵，这条出路不许失灵」。2b-1b 审计阻塞 1 就是事务外那次
  // db.getLedger 漏在 try 外面 —— 真云的 getLedger 把一切异常吞成 null，一次瞬时
  // 读失败就变成「店铺账本不存在」，**带不带 force 都一样报错**。
  // 这里把守卫机器的三个零件逐个弄坏，每一个都要：不带 force -> 拒绝且点名 force；
  // 带 force -> 回滚成功。
  const brokenParts = [
    {
      name: '事务外 getLedger 返回 null',
      // 真云 index.js 的 createDb().getLedger 是 catch (error) { return null }
      install: function (shop) {
        const real = shop.db.getLedger
        shop.db.getLedger = async function () { return null }
        return function () { shop.db.getLedger = real }
      }
    },
    {
      name: '事务外 getLedger 抛错',
      install: function (shop) {
        const real = shop.db.getLedger
        shop.db.getLedger = async function () { throw new Error('读账本超时') }
        return function () { shop.db.getLedger = real }
      }
    },
    {
      name: '老数组归并抛错',
      // legacyRecordsOf 是纯函数，但它也是守卫机器的一部分，不该有能力带走 force
      install: function () {
        const real = apply.legacyRecordsOf
        apply.legacyRecordsOf = function () { throw new Error('归并炸了') }
        return function () { apply.legacyRecordsOf = real }
      }
    }
  ]
  for (let i = 0; i < brokenParts.length; i++) {
    const part = brokenParts[i]
    const shop = await openLegacyShop('m10j' + i)
    await shop.runMigration({ limit: 50 })
    assert.ok(shop.doc().recordsMigratedAt > 0)
    const restore = part.install(shop)
    try {
      await rejects(function () {
        return shop.call('migrateRecords', { mode: 'rollback' })
      }, /回滚守卫读不到数[\s\S]*force: true/)
      assert.ok(shop.doc().recordsMigratedAt > 0,
        'M10j（' + part.name + '）：被拒绝的回滚一个字都不许改账本')
      const forced = await shop.call('migrateRecords', { mode: 'rollback', force: true })
      assert.strictEqual(forced.state, 'rolledBack',
        'M10j（' + part.name + '）：force 必须出得去')
      assert.strictEqual(shop.doc().recordsMigratedAt, 0,
        'M10j（' + part.name + '）：force 之后确实回滚了')
      assert.strictEqual(shop.doc().migration, null)
    } finally {
      restore()
    }
  }

  // -------------------------------------------------------------------------
  // M10j 的第四个零件：**事务内** tx.getLedger 返回 null。它和前三个不一样——
  // 前三个是守卫机器坏了，force 必须出得去；这一个测的是「要不要回滚」这个决定
  // 本身的前提（cur 都没读到），**force 也必须出不去**。真云的 tx.getLedger
  // （index.js 的事务适配器）把读失败也吞成 null，在这里和「账本文档不存在」
  // 分不开；而 cur 没读到还往下走，putLedger 就是整文档 set()，会毁账本，拒绝
  // 是对的。代价是这条路上 force 无效、只能重试，所以文案必须把两种可能都点到、
  // 给出「再调一次」的指引，不许断言「店铺账本不存在」——那会让凌晨两点的人
  // 以为账本真没了、跑去控制台手改文档。
  // -------------------------------------------------------------------------
  const m10jTxShop = await openLegacyShop('m10j-tx')
  await m10jTxShop.runMigration({ limit: 50 })
  assert.ok(m10jTxShop.doc().recordsMigratedAt > 0)
  const m10jTxRun = m10jTxShop.db.runTransaction
  m10jTxShop.db.runTransaction = async function (fn) {
    return m10jTxRun.call(m10jTxShop.db, function (tx) {
      tx.getLedger = async function () { return null }
      return fn(tx)
    })
  }
  try {
    await rejects(function () {
      return m10jTxShop.call('migrateRecords', { mode: 'rollback' })
    }, /再调一次/)
    assert.ok(m10jTxShop.doc().recordsMigratedAt > 0,
      'M10j（事务内读失败）：不带 force，被拒的回滚一个字都不许改账本')
    // force 在这条路上**不该**有效果 —— 和前三个零件正好相反（有意）
    await rejects(function () {
      return m10jTxShop.call('migrateRecords', { mode: 'rollback', force: true })
    }, /再调一次/)
    assert.ok(m10jTxShop.doc().recordsMigratedAt > 0,
      'M10j（事务内读失败）：带 force 也必须出不去，recordsMigratedAt 一动不动')
    assert.ok(m10jTxShop.doc().migration,
      'M10j（事务内读失败）：migration 也不许被清')
  } finally {
    m10jTxShop.db.runTransaction = m10jTxRun
  }

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
  // M12b：deleteShop 不带 apiVersion 必须被拒。它不回传账本（那批放行名单的判据），
  // 但它是不可逆动作 —— 冻结窗口里店主到处撞「请更新小程序到最新版本」、最容易
  // 乱点的时候，删店按钮就在同一个店铺页上。老客户端发起的不可逆动作要当场挡住，
  // 不是「回传了什么」能换的。全量放行名单的实测钉在 M12c。
  await rejects(function () {
    return m12.callRaw('deleteShop', {}, null, 0)
  }, /请更新小程序到最新版本/, 'M12b：deleteShop 不带 apiVersion 必须被版本门挡住')
  await rejects(function () {
    return m12.callRaw('deleteShop', {}, null, 1)
  }, /请更新小程序到最新版本/, 'M12b：apiVersion 1（老客户端）同样挡住')
  // M12c：把「不带 apiVersion 到底放行哪几个」整个钉住。docs/cloud-ledger.md 的
  // 放行清单是从这里抄的，名单再变（新 action 忘了进 VERSIONED_READS / 新增
  // 不可逆 action 忘了进 VERSIONED_DESTRUCTIVE）测试当场红，不用等审计来数。
  const ALL_ACTIONS = ['whoami', 'listShops', 'createShop', 'listMembers', 'addMember',
    'updateMember', 'removeMember', 'deleteShop', 'getLedger', 'getSlip', 'getRecord',
    'listRecords', 'migrateLocal'].concat(migrate.OPS_ACTIONS).concat(apply.MUTATIONS)
  const m12Allowed = []
  for (let i = 0; i < ALL_ACTIONS.length; i++) {
    const action = ALL_ACTIONS[i]
    let message = ''
    try {
      await core.dispatch({
        db: new MemoryDb(), makeId: idFactory('m12v'), openid: 'user-a',
        action: action, shopId: 'shop-1', apiVersion: 0,
        payload: action === 'createShop' ? { name: '店' } : {}, now: 1000
      })
    } catch (error) {
      message = String((error && error.message) || error)
    }
    // 过了门但因缺参数等报别的错 = 放行；报「请更新」= 被挡
    if (message.indexOf('请更新小程序到最新版本') < 0) m12Allowed.push(action)
  }
  assert.deepStrictEqual(m12Allowed.sort(),
    ['addMember', 'createShop', 'listMembers', 'listShops', 'removeMember', 'updateMember', 'whoami'],
    'M12c：版本门的放行名单就是这 7 个（deleteShop 必须不在里面）')

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

  // -------------------------------------------------------------------------
  // M16b dropLegacy 必须活过「上线清单自己写的那个顺序」
  // -------------------------------------------------------------------------
  // docs/cloud-ledger.md 阶段 2 的顺序是：迁完 -> 记一笔 1 元测试销售确认写路径
  // 解冻 -> 再删掉 -> 账本文档 > 3 MB 的店跑 dropLegacy。2b-1b 审计 A6：那一笔
  // 测试账会把 ledgers.migration 抹掉（applyMutation 只带 records /
  // recordsMigratedAt / migratedFromLocal / importing），而老 dropLegacy 要
  // migration.phase === 'done'，于是需要它的那家店必然卡死，app 内没有出路。
  // 修法有两半，这条用例把两半都钉住。
  const m16b = await openLegacyShop('m16b')
  await m16b.runMigration({ limit: 50 })
  const m16bMigration = clone(m16b.doc().migration)
  assert.strictEqual(m16bMigration.phase, 'done')
  const m16bSale = await m16b.call('addSale', {
    paidAmount: 0, customerId: 'nc1', items: [{ productId: 'p1', qty: 1, unitPrice: 30 }]
  }, 9000)
  // 半一：migration 活过记账（applyMutation 把它原样带过去）
  assert.deepStrictEqual(m16b.doc().migration, m16bMigration,
    'M16b：记一笔账不许把 ledgers.migration 抹掉')
  await m16b.call('deleteRecord', { id: m16bSale.result.order.id })
  assert.deepStrictEqual(m16b.doc().migration, m16bMigration,
    'M16b：删一笔账也不许把它抹掉')
  // 半二：dropLegacy 的前置条件不再看 migration，只看 recordsMigratedAt + 集合非空
  const m16bDropped = await m16b.call('migrateRecords', { mode: 'dropLegacy' })
  assert.strictEqual(m16bDropped.state, 'dropped',
    'M16b：按上线清单的顺序走完，dropLegacy 必须能跑')
  assert.strictEqual(m16bDropped.collectionCount, m16bDropped.mergedCount,
    'M16b：回包里带上「集合 N 条 / 归并 M 条」，当晚不用再猜')
  assert.strictEqual(m16bDropped.shortfall, 0)
  assert.deepStrictEqual(m16b.doc().records, [], 'M16b：老数组被清空')

  // -------------------------------------------------------------------------
  // M16c dropLegacy 的新闸：集合是空的 = 老数组是唯一副本，不许删
  // -------------------------------------------------------------------------
  // 老前置条件（migration.phase === 'done'）挡不住这一种：migration 好好写着、
  // recordsMigratedAt 也写着，但集合里一条都没有（bookId 被改过 / newBook 换过
  // 账套 / 集合被清过）。这时候删老数组就是把唯一一份副本删掉。
  const m16c = await openLegacyShop('m16c')
  await m16c.runMigration({ limit: 50 })
  assert.strictEqual(m16c.doc().migration.phase, 'done', 'M16c 前提：老前置条件在这里是满足的')
  m16c.db.records = {}   // 带外把集合清空
  await rejects(function () {
    return m16c.call('migrateRecords', { mode: 'dropLegacy' })
  }, /一条流水都没有[\s\S]*唯一/)
  assert.ok(m16c.doc().records.length, 'M16c：被拒绝的 dropLegacy 一条都不许删')

  // -------------------------------------------------------------------------
  // M16d dropLegacy 数不着条数就报错，**不给 force**
  // -------------------------------------------------------------------------
  // 和 rollback 不同：rollback 是紧急出路，堵死它等于把店锁死，所以给 force；
  // dropLegacy 是优化，堵一次什么都没坏，下次再调就行 —— 给一条不可逆操作配
  // 「绕过唯一一道闸」的开关才是错的。
  const m16d = await openLegacyShop('m16d')
  await m16d.runMigration({ limit: 50 })
  const m16dQuery = Object.getPrototypeOf(m16d.db.recordsCtx().collection.where({}))
  const m16dCount = m16dQuery.count
  m16dQuery.count = async function () { throw new Error('数数炸了') }
  try {
    await rejects(function () {
      return m16d.call('migrateRecords', { mode: 'dropLegacy' })
    }, /先数一遍集合[\s\S]*数数炸了/)
    // force 在这条路上**不该**有效果
    await rejects(function () {
      return m16d.call('migrateRecords', { mode: 'dropLegacy', force: true })
    }, /先数一遍集合/)
    assert.ok(m16d.doc().records.length, 'M16d：两次都不许删')
  } finally {
    m16dQuery.count = m16dCount
  }

  // -------------------------------------------------------------------------
  // M16e migration 已经被抹掉的账本，dropLegacy 照样要能跑
  // -------------------------------------------------------------------------
  // 这不是假想：2b-1b 那一版部署上去之后，只要哪家店迁完再记过一笔账，
  // ledgers.migration 就永久没了 —— applyMutation 带 migration 的修法**不会**
  // 把它补回来。所以 dropLegacy 的前置条件必须**结构上**不依赖 migration，
  // 而不是「靠 A6 的另一半兜着」。谁把 migration.phase === 'done' 加回前置条件，
  // 这条当场变红。
  const m16e = await openLegacyShop('m16e')
  await m16e.runMigration({ limit: 50 })
  m16e.patchDoc({ migration: null })
  assert.ok(m16e.doc().recordsMigratedAt > 0, 'M16e 前提：迁移确实成功过')
  const m16eDropped = await m16e.call('migrateRecords', { mode: 'dropLegacy' })
  assert.strictEqual(m16eDropped.state, 'dropped',
    'M16e：dropLegacy 的前置条件不许依赖 ledgers.migration')
  assert.deepStrictEqual(m16e.doc().records, [])

  // -------------------------------------------------------------------------
  // M16f preCountProbe 的 known 标志有牙（rollback 守卫的账套号漂移闸）
  // -------------------------------------------------------------------------
  // known 回答的是「事务外那次读，读没读到账本」。它守着两件事，缺一不可：
  //   ① 读到了（known=true）才有资格比对「事务外数的那本 == 事务里这本」——
  //     数完之后账套号被并发 clearAll / loadSeed 换掉时，守卫必须作废那次计数、
  //     点名「账套号变了」，而不是拿老账套的条数当数。
  //   ② 没读到（known=false，pre.bookId 是 ''）时**不许**做那个比对——'' 和任何
  //     真实账套号都不相等，不判 known 就会把「数不着」误报成「账套号变了」，
  //     因果是错的。
  // 变异验证的靶子：把 preCountProbe 里 out.known = true 改成 false（整个机制
  // 作废），第一段当场变红——漂移检查被跳过，守卫拿老账套的条数当数，一次连
  // bookId 都被换掉的回滚静默放行。反过来把 rollbackGuard 里 if 条件的
  // pre.known && 删掉，第二段当场变红。
  const m16f = await openLegacyShop('m16f')
  await m16f.runMigration({ limit: 50 })
  // 第一段：读到了 + 事务里账套号被换掉 -> 必须拒绝并点名「账套号变了」。
  // hook 挂在 MemoryDb 的 tx.getLedger 上：事务外 preCountProbe 数完老账套之后、
  // 事务里读到的那一份才被换 bookId，正是这道闸要拦的窗口。
  m16f.db.hooks.afterGetLedger = function (shopId, snap) {
    snap.ledgers[shopId] = Object.assign({}, snap.ledgers[shopId], { bookId: 'm16f-drift' })
  }
  try {
    await rejects(function () {
      return m16f.call('migrateRecords', { mode: 'rollback' })
    }, /账套号在读数和事务之间变了[\s\S]*再调一次/)
    assert.ok(m16f.doc().recordsMigratedAt > 0,
      'M16f：被拒绝的回滚一个字都不许改账本')
  } finally {
    delete m16f.db.hooks.afterGetLedger
  }
  // 第二段：事务外没读到账本（真云的 getLedger 把读失败吞成 null）-> 报的必须是
  // 「数不着」那条文案，**不是**「账套号变了」。
  const m16fBlindGet = m16f.db.getLedger
  m16f.db.getLedger = async function () { return null }
  try {
    let m16fBlindError = null
    try {
      await m16f.call('migrateRecords', { mode: 'rollback' })
    } catch (error) {
      m16fBlindError = error
    }
    assert.ok(m16fBlindError, 'M16f：盲探针的回滚必须被拒绝')
    assert.ok(/事务外没读到账本文档/.test(m16fBlindError.message),
      'M16f：报的是「数不着」那条文案')
    assert.ok(!/账套号在读数和事务之间变了/.test(m16fBlindError.message),
      'M16f：不许把「数不着」误报成「账套号变了」（known=false 时 bookId 是空串，不做 known 判断就会）')
    assert.ok(m16f.doc().recordsMigratedAt > 0,
      'M16f：盲探针的回滚也不许改账本')
  } finally {
    m16f.db.getLedger = m16fBlindGet
  }

  // -------------------------------------------------------------------------
  // M16g dropLegacy 的账套号漂移闸有牙
  // -------------------------------------------------------------------------
  // 场景：事务外数完条数（老账套，数得着、非空）之后、事务开始之前，账套号被
  // 并发 clearAll / loadSeed 换到一个**空集合**的新账套。闸在：拒绝并点名
  // 「账套号在数条数和事务之间变了」。删掉那个 throw 试试：pre.count 是老账套
  // 的数、非零，后面两道检查（数得着、非空）全过，事务一路走到清空老数组——
  // 而当前账套是空的，账本里那份数当场消失，老账套的文档虽还在集合里、却已经
  // 没有任何账本指向它。变异验证：删 throw，这条必须变红（dropLegacy 会放行）。
  const m16g = await openLegacyShop('m16g')
  await m16g.runMigration({ limit: 50 })
  assert.ok(m16g.doc().records.length, 'M16g 前提：老数组还在')
  m16g.db.hooks.afterGetLedger = function (shopId, snap) {
    snap.ledgers[shopId] = Object.assign({}, snap.ledgers[shopId], { bookId: 'm16g-empty-book' })
  }
  try {
    await rejects(function () {
      return m16g.call('migrateRecords', { mode: 'dropLegacy' })
    }, /账套号在数条数和事务之间变了[\s\S]*再调一次/)
    assert.ok(m16g.doc().records.length, 'M16g：被拒绝的 dropLegacy 一条都不许删')
    assert.ok(m16g.doc().recordsMigratedAt > 0, 'M16g：recordsMigratedAt 也不许动')
  } finally {
    delete m16g.db.hooks.afterGetLedger
  }

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
  // 转换把归并条数回填进账本 clearSnapshots 的元数据：「恢复清空前数据」弹窗
  // 要报的数（pages/shop/shop.js）。老元数据只有 {id, savedAt}（installLegacyClears
  // 装的就是这个形状），records 数组按行数又**不等于**归并条数（同 orderId 的行
  // 并成一张单），全店只有转换这里拿得到归并结果。
  assert.strictEqual(s1.doc().clearSnapshots[0].recordCount, s1Merged.length,
    'S1：元数据回填 recordCount = 归并条数（不是 records 行数）')
  const s1View = (await s1.call('getLedger', {})).ledger
  assert.deepStrictEqual(s1View.latestClear, { savedAt: 3000, recordCount: s1Merged.length },
    'S1：latestClear 带日期和归并条数回传给客户端')

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
  assert.strictEqual(s3Now.latestClear.recordCount, null,
    'S3 自检：老元数据还没有 recordCount（转换之前），弹窗退化成只带日期')
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
  assert.strictEqual(s3After.latestClear.recordCount, s3Merged.length,
    'S3：转换把归并条数回填进元数据，恢复之后弹窗照样报得出条数')
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
  console.log('阶段 3 补口：V12 行上亚分与 1e-9 容差、V4 金额那半（M3 专项）、'
    + 'M9b 四份脏语料完整迁移必须 failed（末尾总门的失败形态）、M4b 同批语料预检 '
    + 'blocking 点名、M9c 删最老一条走终局 V1、M9d 单客户漂移报 customerId、'
    + 'M9e clampChunk 上界 500')
  console.log('M3 纯函数 V4–V12 逐项隔离、M4 三代混合预检 P1–P13、M5 送货单前后逐张相等、'
    + 'M6/M14 端到端、M7 解冻、M8 幂等重发 ×3、M9 校验不过不切开关、'
    + 'M10 restart/newBook/rollback + 回滚守卫双信号（M10d-g，②的牙在 M10h，探针不许带走 force 在 M10i/j、事务内读失败带 force 也出不去是 M10j 第四个零件）、M11 重算与上限、M12 权限与版本门、M15 三个特例、M16 dropLegacy（M16b 上线清单顺序、M16c 集合空、M16d 数不着不给 force、M16e 不依赖 migration、M16f known 标志、M16g 账套号漂移闸）')
  console.log('老清空快照转换 S1 三字段与集合、S2 幂等、S3 端到端恢复（商品/库存/流水/欠款回到清空之前）、'
    + 'S4 stamp-only、S5 前置条件、S6 一份坏的不拖累其他份、S7 limit 分批、S8 份额重算')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
