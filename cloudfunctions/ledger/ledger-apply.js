const inventory = require('./inventory')

const MUTATIONS = [
  'saveProduct',
  'deleteProduct',
  'saveCustomer',
  'deleteCustomer',
  'saveCategory',
  'deleteCategory',
  'appendCategoryValue',
  'addPurchase',
  'addSale',
  'addReturn',
  'addConvert',
  'addAdjust',
  'addPayment',
  'addOpening',
  'updateRecord',
  'deleteRecord',
  'loadSeed',
  'clearAll',
  'restoreCleared'
]

// 流水文档比 2a 的 record 多出来的字段，全是单头派生物（索引和游标用）。
// fromRecordDoc 把它们剥掉就回到 record 原样，所以往返不会改形状。
const RECORD_DOC_KEYS = ['_id', 'bookId', 'shopId', 'sortKey', 'saleOrderId', 'productId', 'skuId']

// 单行单：lines[0] 的商品和规格可以安全地提到单头做索引。
// out / return 是多行，单头留空 —— 唯一用到这条索引的 latestPurchase 只查 in。
const SINGLE_LINE_TYPES = ['in', 'convert', 'adjust_in', 'adjust_out']

function emptyLedger() {
  return {
    products: [],
    skus: [],
    // 遗留字段。2b-1 起流水在 ledger_records 集合里，这里恒为空数组；
    // 迁移期用「非空 + 没有 recordsMigratedAt」判定「这本账还没搬」，见 recordsPending。
    // 2b-3 观察一周后删字段。
    records: [],
    customers: [],
    categories: [],
    bookId: '',
    revision: 0,
    clearSnapshots: [],
    lastRestoredClearAt: 0,
    accounts: {},
    aggregate: inventory.emptyTerms(),
    totals: { salesAmount: 0, purchaseAmount: 0, profit: 0, receivable: 0, count: 0 }
  }
}

function cloneList(list) {
  return (list || []).map(function (item) {
    return Object.assign({}, item)
  })
}

function cloneTerms(terms) {
  return Object.assign(inventory.emptyTerms(), terms || {})
}

function cloneAccounts(accounts) {
  const out = {}
  Object.keys(accounts || {}).forEach(function (customerId) {
    out[customerId] = cloneTerms(accounts[customerId])
  })
  return out
}

function emptyCustomerAccount() {
  return { count: 0, amount: 0, creditAmount: 0, paidAmount: 0, receivable: 0 }
}

// ---------------------------------------------------------------------------
// 流水文档形状（纯映射，没有 IO）。
// 放在这里而不是 cloudfunctions/ledger/ledger-records.js，是因为云函数和小程序
// 内存模式都要用同一份定义；「去数据库找哪几条」才是 ledger-records.js 的事。
// ---------------------------------------------------------------------------

// createdAt 补齐到 13 位十进制，2286 年之前都够用；超出就原样返回，
// 那时候的排序前缀会变长，但同长度内仍然有序。
function pad13(value) {
  let text = String(Math.max(0, Math.floor(inventory.toNumber(value))))
  while (text.length < 13) {
    text = '0' + text
  }
  return text
}

// sortKey = pad13(createdAt) + '_' + id。
// createdAt 和 id 在 updateRecord 里都不可改（type 同理），所以它是两个不可变
// 字段的纯派生物，不可能和来源脱节。同毫秒记录靠 id 拿到全序。
function makeSortKey(createdAt, id) {
  return pad13(createdAt) + '_' + String(id == null ? '' : id)
}

// _id 用 bookId 前缀：两家店的 nextId() 撞号时后果是跨租户覆盖数据。
function recordDocId(bookId, id) {
  return String(bookId == null ? '' : bookId) + '_' + String(id == null ? '' : id)
}

function toRecordDoc(record, bookId, shopId) {
  const doc = {}
  Object.keys(record || {}).forEach(function (key) {
    if (RECORD_DOC_KEYS.indexOf(key) >= 0) return
    doc[key] = record[key]
  })
  const id = String((record && record.id) || '')
  const type = String((record && record.type) || '')
  const lines = inventory.recordLines(record)
  const head = lines.length ? lines[0] : {}
  doc.id = id
  doc.type = type
  doc.createdAt = inventory.toNumber(record && record.createdAt)
  doc._id = recordDocId(bookId, id)
  doc.bookId = String(bookId == null ? '' : bookId)
  doc.shopId = String(shopId == null ? '' : shopId)
  doc.sortKey = makeSortKey(doc.createdAt, id)
  // 一张退货单只能退同一张销售单，所以 saleOrderId 能提到单头（见 docs/cloud-ledger.md）
  doc.saleOrderId = type === 'return' ? String(head.saleOrderId || '') : ''
  const single = SINGLE_LINE_TYPES.indexOf(type) >= 0
  doc.productId = single ? String(head.productId || '') : ''
  doc.skuId = single ? String(head.skuId || '') : ''
  return doc
}

function fromRecordDoc(doc) {
  const record = {}
  Object.keys(doc || {}).forEach(function (key) {
    if (RECORD_DOC_KEYS.indexOf(key) >= 0) return
    record[key] = doc[key]
  })
  return record
}

// ---------------------------------------------------------------------------
// 一页流水的定义（2b-2）。三处实现必须给出逐条相同的结果：集合查询
// （cloudfunctions/ledger/ledger-records.js 的 recordStore.page）、未迁移老
// 账本的内存切片、小程序内存模式的 memoryRecordStore.page —— 所以只写这一份，
// 索引化实现和内存模式都调它或对它做等价性校验（tests/ledger-records.test.js
// 的 T-A2）。
// ---------------------------------------------------------------------------

const RECORD_PAGE_DEFAULT = 20
const RECORD_PAGE_LIMIT = 100

// 不传 / 非法（NaN、<=0）一律给缺省值 20；超过上限钳到 100。
function clampPageLimit(limit) {
  const n = Math.floor(inventory.toNumber(limit))
  if (!n || n < 1) return RECORD_PAGE_DEFAULT
  return Math.min(n, RECORD_PAGE_LIMIT)
}

// records 是调用方已经在内存里的**全部**候选流水（未迁移老账本的数组，或小
// 程序内存模式的整份流水）。倒序分页，语义必须和 recordStore.page 逐条对齐：
// hasMore = 本页条数 >= limit（正好整页倍数时最后一页 0 条 + hasMore:false），
// 本页为空时 cursor 为 ''。cursor 传一个不存在的 sortKey 也按 < 比较，和集合
// 查询的 _.lt 语义一致。customerId 传 ''（散客）不过滤 —— 散客单没有独立的
// 查询口径，不能靠这个参数单独查出来，和 recordStore.page 一致。
function pageRecords(records, options) {
  options = options || {}
  const limit = clampPageLimit(options.limit)
  const type = String(options.type || '')
  const customerId = String(options.customerId || '')
  const cursorKey = String(options.cursor || '')
  const filtered = (records || []).filter(function (record) {
    if (type && type !== 'all') {
      if (type === 'adjust') {
        if (!inventory.isAdjust(record)) return false
      } else if ((record && record.type) !== type) {
        return false
      }
    }
    if (customerId && (record && record.customerId) !== customerId) return false
    return true
  })
  const sorted = filtered.slice().sort(function (a, b) {
    const ka = makeSortKey(a && a.createdAt, a && a.id)
    const kb = makeSortKey(b && b.createdAt, b && b.id)
    if (ka === kb) return 0
    return ka > kb ? -1 : 1
  })
  const afterCursor = cursorKey
    ? sorted.filter(function (record) {
      return makeSortKey(record && record.createdAt, record && record.id) < cursorKey
    })
    : sorted
  const page = afterCursor.slice(0, limit)
  return {
    records: page,
    cursor: page.length ? makeSortKey(page[page.length - 1].createdAt, page[page.length - 1].id) : '',
    hasMore: page.length >= limit
  }
}

function sameRecord(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function indexById(records) {
  const out = {}
  ;(records || []).forEach(function (record) {
    const id = String((record && record.id) || '')
    if (!id) return
    out[id] = record
  })
  return out
}

// 把「调用方加载进来的那几条」和「纯函数算完之后的那几条」对齐成写操作。
// 纯函数对没碰过的记录返回同一个引用，所以不会有假阳性写；
// 真改过的记录 JSON 一定不同，所以也不会有假阴性漏写。
function diffRecords(before, after) {
  const beforeById = indexById(before)
  const afterById = indexById(after)
  const writes = []
  const deltas = []
  Object.keys(afterById).forEach(function (id) {
    const now = afterById[id]
    const was = beforeById[id] || null
    if (was && sameRecord(was, now)) return
    writes.push({ op: 'set', record: now })
    deltas.push({ before: was, after: now })
  })
  Object.keys(beforeById).forEach(function (id) {
    if (afterById[id]) return
    writes.push({ op: 'remove', id: id })
    deltas.push({ before: beforeById[id], after: null })
  })
  return { writes: writes, deltas: deltas }
}

function mergeRecords(lists) {
  const seen = {}
  const out = []
  ;(lists || []).forEach(function (list) {
    ;(list || []).forEach(function (record) {
      const id = String((record && record.id) || '')
      if (!id || seen[id]) return
      seen[id] = true
      out.push(record)
    })
  })
  return out
}

// ---------------------------------------------------------------------------
// 账本文档的四张表 + 聚合累加器
// ---------------------------------------------------------------------------

// 存进文档的是累加器（accounts / aggregate，单位分），回传客户端的
// customers[].account / totals 是从累加器投影出来的元。
// 2b-1 起累加器由 applyTermsDelta 增量维护，不再每次全量重折叠；
// 「增量 == 全量」由 tests/ledger-records.test.js 的 3000 步随机序列常驻守门。
function withAggregates(lists) {
  const accounts = lists.accounts || {}
  lists.customers = (lists.customers || []).map(function (customer) {
    const terms = accounts[customer.id]
    return Object.assign({}, customer, {
      account: terms ? inventory.accountOf(terms) : emptyCustomerAccount()
    })
  })
  lists.totals = inventory.totalsOf(lists.aggregate)
  return lists
}

function listsOf(ledger) {
  return withAggregates({
    products: cloneList(ledger && ledger.products),
    skus: cloneList(ledger && ledger.skus),
    customers: cloneList(ledger && ledger.customers),
    categories: cloneList(ledger && ledger.categories),
    revision: (ledger && ledger.revision) || 0,
    bookId: String((ledger && ledger.bookId) || ''),
    accounts: cloneAccounts(ledger && ledger.accounts),
    aggregate: cloneTerms(ledger && ledger.aggregate)
  })
}

// 迁移前的老账本：流水还在文档数组里。读时自愈成「一单一条」，
// 和 2a 的 listsOf 行为一致，只用于兼容读和迁移动作。
//
// 两步，口径不同，**不能合并成一步**：
//   ① migrateRecordShape —— 归并。「一行商品一条」变「一张单一条」，
//      换字段不许换钱。tests/ledger-terms.test.js 有常驻断言钉着这一条。
//   ② repairReturnSplits —— 退货份额整体重算。它就是来改钱的：修 B1（代 B 的
//      退货单没有结算字段，被保守回推成「整笔退现金」、一分不冲欠款）和
//      B2（改过销售单客户后，退货单头留着旧 customerId，一个客户少算另一个多算）。
//      塞进 ① 里会让那条绿着的断言要么变红要么被稀释。
//
// ② 对 needsRecordMigration 真假**都要跑**：库里三代形状混着（见 inventory.js
// 的 settledAmount 注释），代 B / B2 的记录本身已经是 lines 形状，① 会原样放行。
// 代 C 已 materialize，重算是恒等变换、返回入参本身（引用相等），所以放在读路径
// 上安全。
//
// 挂在这里（五个调用点的共同入口）而不是只挂在迁移动作上，理由有三：
//   1. migrateLocalShard 走的就是它。本机账本可能是任意一代形状，不修就把错值
//      永久写进 ledger_records。
//   2. 不修一半。窗口期内 getSlip 走 receivableAt(legacy)、客户页走
//      foldAccountTerms(legacy)，只修一条路会出现「送货单印 200、客户页显示 0」。
//   3. 一份定义，五个调用点零改动。
function legacyRecordsOf(ledger) {
  const records = cloneList(ledger && ledger.records)
  const merged = inventory.needsRecordMigration(records)
    ? inventory.migrateRecordShape(records)
    : records
  return inventory.repairReturnSplits(merged)
}

// 「这本账的流水还没搬进 ledger_records」。写路径见了它必须停下来报错，
// 否则新流水写进集合、老流水留在数组里，两边都不是完整的账。
function recordsPending(ledger) {
  if (!ledger) return false
  if (ledger.recordsMigratedAt) return false
  return !!(Array.isArray(ledger.records) && ledger.records.length)
}

function recordCountOf(lists) {
  if (!lists) return 0
  if (lists.aggregate && lists.aggregate.count) return lists.aggregate.count
  return (lists.records && lists.records.length) || 0
}

function listsHaveData(lists) {
  if (!lists) return false
  return !!(
    (lists.products && lists.products.length)
    || (lists.skus && lists.skus.length)
    || (lists.customers && lists.customers.length)
    || (lists.categories && lists.categories.length)
    || recordCountOf(lists)
  )
}

// 清空快照只装四张有界的表 + 聚合累加器 + 账套号，不复制流水：
// 老账套原地不动，清空只是把指针换到新账套（O(1)）。
//
// 把 accounts / aggregate 冻进快照不是「冻结派生字段」：它们是那个账套被封存
// 那一刻的完整聚合，而**被封存的账套此后不再变化**，所以永远正确。
// 将来若允许改历史账套，这条前提就没了，必须改成恢复时重算。
function snapshotLists(ledger, now) {
  const snapshot = {
    products: cloneList(ledger && ledger.products),
    skus: cloneList(ledger && ledger.skus),
    customers: cloneList(ledger && ledger.customers),
    categories: cloneList(ledger && ledger.categories),
    accounts: cloneAccounts(ledger && ledger.accounts),
    aggregate: cloneTerms(ledger && ledger.aggregate),
    bookId: String((ledger && ledger.bookId) || ''),
    savedAt: now || 0
  }
  // 升级前的备份（clearedBackup / 迁移前的账本）流水还在数组里，原样带走不能丢。
  const legacy = (ledger && ledger.records) || []
  if (legacy.length) {
    snapshot.records = cloneList(legacy)
  }
  return snapshot
}

function latestClearMeta(ledger) {
  const snaps = (ledger && ledger.clearSnapshots) || []
  return snaps.length ? snaps[snaps.length - 1] : null
}

function hasClearedBackup(ledger) {
  const latest = latestClearMeta(ledger)
  if (latest) {
    return latest.savedAt > ((ledger && ledger.lastRestoredClearAt) || 0)
  }
  return listsHaveData(ledger && ledger.clearedBackup)
}

function findById(list, id) {
  return (list || []).find(function (item) {
    return item.id === id
  }) || null
}

function markCustomerSold(customers, id, now) {
  const index = customers.findIndex(function (item) {
    return item.id === id
  })
  if (index < 0) return
  customers[index] = Object.assign({}, customers[index], { lastSaleAt: now })
}

function customerSnapshot(customers, customerId) {
  if (!customerId) {
    return {
      customerId: '',
      customerName: '',
      customerPhone: '',
      customerAddress: ''
    }
  }
  const customer = findById(customers, customerId)
  if (!customer) {
    throw new Error('客户不存在')
  }
  return {
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerAddress: customer.address
  }
}

// ---------------------------------------------------------------------------
// 「这次记账要先去数据库捞哪几条流水」—— 纯函数，两轮收敛。
// 第一轮不知道目标记录长什么样，只能按 payload 猜；
// 第二轮拿到目标记录之后才知道要不要连带捞销售单 / 进货候选。
// ---------------------------------------------------------------------------

function pushUnique(list, value) {
  if (!value || list.indexOf(value) >= 0) return
  list.push(value)
}

function recordsNeeded(action, payload, loaded) {
  payload = payload || {}
  const need = { ids: [], saleOrderIds: [], purchases: [], saleReturns: [] }

  if (action === 'addReturn') {
    ;(payload.items || []).forEach(function (item) {
      pushUnique(need.saleOrderIds, String((item && item.saleOrderId) || ''))
    })
    return need
  }

  if (action !== 'updateRecord' && action !== 'deleteRecord') {
    return need
  }

  const id = String(payload.id || '')
  const existing = loaded && loaded.byId ? loaded.byId[id] : null
  if (!existing) {
    pushUnique(need.ids, id)
    return need
  }

  if (existing.type === 'return') {
    // 退货单和被退销售单必须在同一个事务里写，否则 returnedQty 会跨文档半写。
    // 同时要这张销售单的**全部退货单**：改退货会挪动同单其余退货单的份额，
    // 整体重算（inventory.recomputeSaleReturns）需要它们都在场。
    inventory.recordLines(existing).forEach(function (line) {
      pushUnique(need.saleOrderIds, String((line && line.saleOrderId) || ''))
    })
    pushUnique(need.saleReturns, String((inventory.firstLine(existing) || {}).saleOrderId || ''))
  } else if (existing.type === 'in') {
    // 「集合去掉一个元素之后的最大值」由原集合前 2 名一定能确定，所以取 2 条
    const line = inventory.firstLine(existing)
    need.purchases.push({
      productId: String((line && line.productId) || ''),
      skuId: String((line && line.skuId) || '')
    })
  } else if (existing.type === 'out') {
    // 有退货的销售单：改欠款基准（金额 / 实收 / 单价 / 客户）会让冻结在退货单头
    // 的现金退款份额失效，全部加载进来一起重算。没退货的单不加载。
    if (inventory.recordLines(existing).some(function (line) {
      return inventory.toNumber(line && line.returnedQty) > 0
    })) {
      pushUnique(need.saleReturns, existing.id)
    }
  }
  return need
}

function emptyLoaded() {
  return { byId: {}, saleOrders: [], latestPurchases: [], saleReturns: [] }
}

// store 由调用方注入（云函数是 ledger-records.js 的 recordStore，
// 内存模式是 store.js 里的同接口实现）。本文件自己不碰数据库。
async function fetchNeeded(store, need, loaded) {
  loaded = loaded || emptyLoaded()
  for (let i = 0; i < need.ids.length; i++) {
    const id = need.ids[i]
    if (Object.prototype.hasOwnProperty.call(loaded.byId, id)) continue
    loaded.byId[id] = await store.byId(id)
  }
  for (let i = 0; i < need.saleOrderIds.length; i++) {
    const saleId = need.saleOrderIds[i]
    const known = loaded.saleOrders.some(function (item) {
      return item.id === saleId
    })
    if (known) continue
    const order = await store.saleOrder(saleId)
    if (order) loaded.saleOrders.push(order)
  }
  for (let i = 0; i < need.purchases.length; i++) {
    const key = need.purchases[i]
    const found = await store.latestPurchases(key.productId, key.skuId)
    for (let n = 0; n < found.length; n++) {
      const record = found[n]
      const known = loaded.latestPurchases.some(function (item) {
        return item.id === record.id
      })
      if (!known) loaded.latestPurchases.push(record)
    }
  }
  for (let i = 0; i < need.saleReturns.length; i++) {
    const saleId = need.saleReturns[i]
    const known = loaded.saleReturns.some(function (item) {
      return String((inventory.recordLines(item)[0] || {}).saleOrderId || '') === saleId
    })
    if (known) continue
    const found = await store.returnsOfSale(saleId)
    for (let n = 0; n < found.length; n++) {
      const record = found[n]
      const seen = loaded.saleReturns.some(function (item) {
        return item.id === record.id
      })
      if (!seen) loaded.saleReturns.push(record)
    }
  }
  return loaded
}

async function prepareMutation(store, action, payload) {
  let loaded = emptyLoaded()
  loaded = await fetchNeeded(store, recordsNeeded(action, payload, null), loaded)
  loaded = await fetchNeeded(store, recordsNeeded(action, payload, loaded), loaded)
  return loaded
}

// ---------------------------------------------------------------------------

function applyMutation(ledger, action, payload, now, nextId, loaded) {
  payload = payload || {}
  loaded = loaded || emptyLoaded()
  const loadedById = loaded.byId || {}
  const loadedSales = loaded.saleOrders || []
  const loadedPurchases = loaded.latestPurchases || []
  const loadedSaleReturns = loaded.saleReturns || []

  const next = listsOf(ledger)
  next.clearSnapshots = cloneList(ledger && ledger.clearSnapshots)
  next.lastRestoredClearAt = (ledger && ledger.lastRestoredClearAt) || 0
  // 迁移用的字段原样带过去，记账不该把它们抹掉：
  // - records：迁移后**故意不删**的老数组。它是「切回老路径」这条 O(1) 回滚路的
  //   全部依仗（见方案 §3.2 第 ⑤ 步）。这里只传引用不复制，不给记账加 O(n)。
  //   2b-3 观察一周后连同这行一起删。
  // - recordsMigratedAt：清掉它就回老路径，所以它必须活过每一次记账。
  // - importing：分片导入中途有人记了一笔账，不能把没收完的批次弄丢。
  next.records = (ledger && ledger.records) || []
  if (ledger && ledger.recordsMigratedAt) {
    next.recordsMigratedAt = ledger.recordsMigratedAt
  }
  if (ledger && ledger.migratedFromLocal) {
    next.migratedFromLocal = true
  }
  if (ledger && ledger.importing) {
    next.importing = ledger.importing
  }
  const result = {}
  let recordWrites = []
  let deltas = []

  // 唯一的流水写入口：把「加载进来的那几条」和「算完的那几条」一比，
  // 得到写操作和聚合增量。漏调增量在结构上做不到 —— 写和增量是同一次比对的产物。
  function commitRecords(before, after) {
    const diff = diffRecords(before, after)
    recordWrites = recordWrites.concat(diff.writes)
    deltas = deltas.concat(diff.deltas)
  }

  // 换账套：老账套的流水原地不动，新账套从零开始，聚合直接给定。
  // 迁移前的老数组属于被换掉的那一本，clearAll 已经把它存进快照，这里必须清掉，
  // 不然它会一直挂在新账套上把 listsHaveData / ledgerHasData 一路带成 true。
  function switchBook(records) {
    next.records = []
    next.bookId = nextId()
    next.accounts = inventory.foldAccountTerms(records)
    next.aggregate = inventory.foldTotalTerms(records)
    ;(records || []).forEach(function (record) {
      recordWrites.push({ op: 'set', record: record })
    })
  }

  if (action === 'saveProduct') {
    const products = next.products
    let product
    let index = -1
    if (payload.id) {
      index = products.findIndex(function (item) {
        return item.id === payload.id
      })
      if (index < 0) {
        throw new Error('商品不存在')
      }
      product = inventory.updateProduct(products[index], payload, now)
    } else {
      product = inventory.createProduct(payload, now, nextId())
    }
    const applied = inventory.applyProductSkus(product, next.skus, payload.skus, now, nextId)
    product = applied.product
    if (index >= 0) {
      products[index] = product
    } else {
      products.unshift(product)
    }
    next.products = products
    next.skus = applied.skus
    result.product = product
    result.products = products
  } else if (action === 'deleteProduct') {
    const id = payload.id
    next.products = next.products.filter(function (item) {
      return item.id !== id
    })
    next.skus = next.skus.filter(function (item) {
      return item.productId !== id
    })
  } else if (action === 'saveCustomer') {
    const customers = next.customers
    let saved
    if (payload.id) {
      const index = customers.findIndex(function (item) {
        return item.id === payload.id
      })
      if (index < 0) {
        throw new Error('客户不存在')
      }
      saved = inventory.updateCustomer(customers[index], payload, now)
      customers[index] = saved
    } else {
      saved = inventory.createCustomer(payload, now, nextId())
      customers.unshift(saved)
    }
    next.customers = customers
    result.customer = saved
  } else if (action === 'deleteCustomer') {
    const id = payload.id
    next.customers = next.customers.filter(function (item) {
      return item.id !== id
    })
  } else if (action === 'saveCategory') {
    const categories = next.categories
    let saved
    if (payload.id) {
      const index = categories.findIndex(function (item) {
        return item.id === payload.id
      })
      if (index < 0) {
        throw new Error('种类不存在')
      }
      saved = inventory.updateCategory(categories[index], payload, now)
      categories[index] = saved
    } else {
      saved = inventory.createCategory(payload, now, nextId())
      categories.unshift(saved)
    }
    next.categories = categories
    result.category = saved
  } else if (action === 'deleteCategory') {
    const id = payload.id
    next.categories = next.categories.filter(function (item) {
      return item.id !== id
    })
  } else if (action === 'appendCategoryValue') {
    const category = findById(next.categories, payload.id)
    if (!category) {
      result.category = null
    } else {
      const saved = inventory.appendCategoryValue(category, payload.field, payload.value, now)
      if (saved !== category) {
        const index = next.categories.findIndex(function (item) {
          return item.id === payload.id
        })
        next.categories[index] = saved
      }
      result.category = saved
    }
  } else if (action === 'addPurchase') {
    const applied = inventory.applyPurchase(
      next.products,
      [],
      payload,
      now,
      nextId(),
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    commitRecords([], [applied.record])
    result.record = applied.record
  } else if (action === 'addSale') {
    const extra = customerSnapshot(next.customers, payload.customerId)
    const applied = inventory.applySaleOrder(
      next.products,
      [],
      Object.assign({}, extra, {
        paidAmount: payload.paidAmount,
        payType: payload.payType,
        remark: payload.remark,
        operatorOpenid: payload.operatorOpenid,
        operatorName: payload.operatorName,
        items: payload.items || [{
          productId: payload.productId,
          skuId: payload.skuId,
          color: payload.color,
          size: payload.size,
          qty: payload.qty,
          unitPrice: payload.unitPrice
        }]
      }),
      now,
      nextId(),
      nextId,
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    commitRecords([], [applied.record])
    if (extra.customerId) {
      markCustomerSold(next.customers, extra.customerId, now)
    }
    result.order = applied.order
  } else if (action === 'addReturn') {
    const applied = inventory.applyReturnOrder(
      next.products,
      loadedSales,
      payload,
      now,
      nextId,
      next.skus,
      { accounts: next.accounts }
    )
    next.products = applied.products
    next.skus = applied.skus
    // applied.records = 新退货单 + 被退销售单（returnedQty 已同步）
    commitRecords(loadedSales, applied.records)
    result.recordsCreated = applied.recordsCreated
  } else if (action === 'addConvert') {
    const applied = inventory.applyConvert(
      next.products,
      [],
      payload,
      now,
      nextId(),
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    commitRecords([], [applied.record])
    result.record = applied.record
  } else if (action === 'addAdjust') {
    const applied = inventory.applyAdjust(
      next.products,
      [],
      payload,
      now,
      nextId(),
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    commitRecords([], [applied.record])
    result.record = applied.record
  } else if (action === 'addPayment') {
    const extra = customerSnapshot(next.customers, payload.customerId)
    const applied = inventory.applyPayment([], Object.assign({}, extra, {
      amount: payload.amount,
      remark: payload.remark
    }), now, nextId(), { accounts: next.accounts })
    commitRecords([], [applied.record])
    result.record = applied.record
  } else if (action === 'addOpening') {
    const extra = customerSnapshot(next.customers, payload.customerId)
    const applied = inventory.applyOpening([], Object.assign({}, extra, {
      amount: payload.amount,
      remark: payload.remark
    }), now, nextId())
    commitRecords([], [applied.record])
    result.record = applied.record
  } else if (action === 'updateRecord') {
    const existing = loadedById[String(payload.id || '')]
    if (!existing) {
      throw new Error('流水不存在')
    }
    // 同单退货单一并进 working：整体重算改到它们，diffRecords 才会产出写操作。
    // existing 在前，dedupe 时目标单优先。
    const working = mergeRecords([[existing], loadedSales, loadedPurchases, loadedSaleReturns])
    const extra = {}
    if (existing.type === 'out') {
      Object.assign(extra, customerSnapshot(next.customers, payload.customerId))
    }
    const applied = inventory.updateRecord(
      next.products,
      working,
      Object.assign({}, payload, extra, { id: payload.id }),
      now,
      next.skus,
      { accounts: next.accounts }
    )
    next.products = applied.products
    next.skus = applied.skus
    commitRecords(working, applied.records)
    if (extra.customerId) {
      markCustomerSold(next.customers, extra.customerId, now)
    }
    result.record = applied.record
  } else if (action === 'deleteRecord') {
    const existing = loadedById[String(payload.id || '')]
    if (!existing) {
      throw new Error('流水不存在')
    }
    const working = mergeRecords([[existing], loadedSales, loadedPurchases, loadedSaleReturns])
    const applied = inventory.deleteRecord(
      next.products,
      working,
      payload.id,
      now,
      next.skus,
      { accounts: next.accounts }
    )
    next.products = applied.products
    next.skus = applied.skus
    commitRecords(working, applied.records)
  } else if (action === 'loadSeed') {
    const seed = inventory.buildSeed(now, nextId)
    next.products = seed.products
    next.skus = seed.skus || []
    next.customers = seed.customers || []
    next.categories = seed.categories || []
    switchBook(seed.records)
    result.seed = seed
  } else if (action === 'clearAll') {
    if (listsHaveData(ledger)) {
      const snapshot = snapshotLists(ledger, now)
      snapshot.id = nextId()
      result.clearSnapshot = snapshot
      next.clearSnapshots = next.clearSnapshots.concat([{
        id: snapshot.id,
        savedAt: snapshot.savedAt
      }])
    }
    next.products = []
    next.skus = []
    next.customers = []
    next.categories = []
    switchBook([])
  } else if (action === 'restoreCleared') {
    const snapshot = payload.snapshot
    const snapshotId = snapshot && (snapshot.id || snapshot._id)
    const latest = latestClearMeta(next)
    if (!latest || !snapshot || snapshotId !== latest.id) {
      throw new Error('没有可恢复的数据')
    }
    if (latest.savedAt <= next.lastRestoredClearAt) {
      throw new Error('没有可恢复的数据')
    }
    if (!snapshot.bookId) {
      // 升级前的快照把流水装在数组里，恢复要逐条写回集合，不是一次事务能做完的事。
      // 宁可报错，也不要恢复出一本没有流水的账。
      //
      // 没有 bookId **只说明这份快照还没转换过**，不是「转不了」：转换是
      // migrateRecords 的 mode:'snapshots'（活账套迁完之后紧接着的一步，
      // 见 cloudfunctions/ledger/ledger-migrate.js 的 convertSnapshots）。
      // 所以文案要指出这条路 —— 光说「请联系开发者」是条死路，而这件事有解。
      // 这句会原样进 wx.showToast（pages/shop/shop.js -> util.showError），
      // 店主看的是「找谁」、开发者看的是「跑哪个动作」，两个都要在一句话里。
      // 哪几家店还有没转的快照，由**本地预检脚本带 --clears** 报出（P11）。
      // 云上的 checkAggregates 拿不到 ledger_clears，P11 只会回 known:false —— 别指望
      // 它能确认「转过了」，那一步只能看 mode:'snapshots' 自己返回的 failed === 0。
      throw new Error('这份备份是账本升级前存的，请让开发者先跑 mode:"snapshots" 转换')
    }
    next.products = cloneList(snapshot.products)
    next.skus = cloneList(snapshot.skus)
    next.customers = cloneList(snapshot.customers)
    next.categories = cloneList(snapshot.categories)
    next.records = []
    // 指针指回封存时的账套，流水一条没动过，所以聚合原样取回即可，不用重算
    next.bookId = String(snapshot.bookId)
    next.accounts = cloneAccounts(snapshot.accounts)
    next.aggregate = cloneTerms(snapshot.aggregate)
    next.lastRestoredClearAt = latest.savedAt
  } else {
    throw new Error('未知操作')
  }

  let state = { accounts: next.accounts, aggregate: next.aggregate }
  deltas.forEach(function (item) {
    state = inventory.applyTermsDelta(state, item.before, item.after)
  })
  next.accounts = state.accounts
  next.aggregate = state.aggregate

  next.revision = ((ledger && ledger.revision) || 0) + 1
  return {
    ledger: withAggregates(next),
    result: result,
    recordWrites: recordWrites
  }
}

module.exports = {
  MUTATIONS: MUTATIONS,
  RECORD_PAGE_DEFAULT: RECORD_PAGE_DEFAULT,
  RECORD_PAGE_LIMIT: RECORD_PAGE_LIMIT,
  clampPageLimit: clampPageLimit,
  pageRecords: pageRecords,
  emptyLedger: emptyLedger,
  listsOf: listsOf,
  withAggregates: withAggregates,
  listsHaveData: listsHaveData,
  legacyRecordsOf: legacyRecordsOf,
  recordsPending: recordsPending,
  snapshotLists: snapshotLists,
  latestClearMeta: latestClearMeta,
  hasClearedBackup: hasClearedBackup,
  makeSortKey: makeSortKey,
  recordDocId: recordDocId,
  toRecordDoc: toRecordDoc,
  fromRecordDoc: fromRecordDoc,
  recordsNeeded: recordsNeeded,
  fetchNeeded: fetchNeeded,
  prepareMutation: prepareMutation,
  applyMutation: applyMutation
}
