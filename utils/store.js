const inventory = require('./inventory')
const apply = require('./ledger-apply')
const cloudConfig = require('./cloud-config')
const util = require('./util')

const KEYS = {
  products: 'inv_products',
  records: 'inv_records',
  customers: 'inv_customers',
  skus: 'inv_skus',
  categories: 'inv_categories'
}

const SHOP_ID_KEY = 'inv_shop_id'
const SHOP_NAME_KEY = 'inv_shop_name'
const REVISION_KEY = 'inv_revision'
const HAS_BACKUP_KEY = 'inv_has_cleared_backup'
const ARCHIVE_KEY = 'inv_clear_archive'
const LAST_RESTORED_KEY = 'inv_last_restored_clear_at'
const MEMORY_FLAG = 'inv_test_memory_ledger'
const PENDING_MIGRATE_KEY = 'inv_pending_migrate'
// 内存模式的 ledger_records 替身：文档形状和云上一样，带 bookId / sortKey
const MEMORY_RECORDS_KEY = 'inv_record_docs'
const MEMORY_BOOK_KEY = 'inv_book_id'
const MEMORY_ACCOUNTS_KEY = 'inv_accounts'
const MEMORY_AGGREGATE_KEY = 'inv_aggregate'
const MIGRATED_KEY = 'inv_local_migrated'
const SNAPSHOT_DONE_KEY = 'inv_local_snapshot_done'

const cache = {
  shopId: '',
  products: [],
  skus: [],
  records: [],
  customers: [],
  categories: [],
  revision: 0,
  hasClearedBackup: false,
  totals: null,
  // 「这份流水缓存的条数和服务端对得上」。算钱的地方（欠款、送货单）只认它为真
  // 才敢用缓存，见 recordsForMoney。
  recordsComplete: false,
  ready: false
}

let readyState = {
  shopId: '',
  promise: null,
  ok: false
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function readList(key) {
  const value = wx.getStorageSync(key)
  return Array.isArray(value) ? value : []
}

function writeList(key, value) {
  wx.setStorageSync(key, value)
}

function isMemoryMode() {
  return !!wx.getStorageSync(MEMORY_FLAG)
}

function getShopId() {
  return String(wx.getStorageSync(SHOP_ID_KEY) || '').trim()
}

function getShopName() {
  return String(wx.getStorageSync(SHOP_NAME_KEY) || '').trim()
}

function setShopMeta(shopId, shopName) {
  wx.setStorageSync(SHOP_ID_KEY, shopId || '')
  if (shopName != null) wx.setStorageSync(SHOP_NAME_KEY, shopName || '')
}

function snapshotLocalIfNeeded() {
  if (wx.getStorageSync(SNAPSHOT_DONE_KEY) || wx.getStorageSync(MIGRATED_KEY)) return
  if (isMemoryMode()) {
    wx.setStorageSync(SNAPSHOT_DONE_KEY, true)
    return
  }
  const snapshot = {
    products: readList(KEYS.products),
    skus: readList(KEYS.skus),
    records: readList(KEYS.records),
    customers: readList(KEYS.customers),
    categories: readList(KEYS.categories)
  }
  const hasData = snapshot.products.length
    || snapshot.skus.length
    || snapshot.records.length
    || snapshot.customers.length
    || snapshot.categories.length
  if (hasData) {
    wx.setStorageSync(PENDING_MIGRATE_KEY, snapshot)
  }
  wx.setStorageSync(SNAPSHOT_DONE_KEY, true)
}

function getPendingMigrate() {
  const value = wx.getStorageSync(PENDING_MIGRATE_KEY)
  if (!value || typeof value !== 'object') return null
  const hasData = (value.products && value.products.length)
    || (value.skus && value.skus.length)
    || (value.records && value.records.length)
    || (value.customers && value.customers.length)
    || (value.categories && value.categories.length)
  return hasData ? value : null
}

function markMigrated() {
  wx.removeStorageSync(PENDING_MIGRATE_KEY)
  wx.setStorageSync(MIGRATED_KEY, true)
}

// 落盘只是缓存。写失败（storage 满 / 超过单 key 1 MB）不能把已经记成的账变成
// 「记账失败」。云模式下这份存储从来没人读回来：lists() 走内存，
// loadCacheFromStorage 只在内存模式用，snapshotLocalIfNeeded 只在迁云前跑一次。
// 所以云模式干脆不写流水 —— 2000 条 × 500 B 每次记账序列化一遍是白花的卡顿。
function persist() {
  try {
    writeList(KEYS.products, cache.products)
    writeList(KEYS.skus, cache.skus)
    writeList(KEYS.customers, cache.customers)
    writeList(KEYS.categories, cache.categories)
    if (isMemoryMode()) writeList(KEYS.records, cache.records)
    wx.setStorageSync(REVISION_KEY, cache.revision)
    wx.setStorageSync(HAS_BACKUP_KEY, cache.hasClearedBackup)
  } catch (error) {
    console.warn('[ledger] 本地缓存落盘失败', error)
  }
}

function applyLedgerLists(ledger) {
  const lists = apply.listsOf(ledger || apply.emptyLedger())
  cache.products = lists.products
  cache.skus = lists.skus
  cache.customers = lists.customers
  cache.categories = lists.categories
  cache.revision = lists.revision
  cache.totals = lists.totals || null
  cache.ready = true
  cache.hasClearedBackup = apply.hasClearedBackup(ledger) || !!(ledger && ledger.hasClearedBackup)
  if (ledger && ledger.lastRestoredClearAt != null) {
    try { wx.setStorageSync(LAST_RESTORED_KEY, ledger.lastRestoredClearAt) } catch (e) {}
  }
}

// 三种形状都要认，顺序不能换：
//  1) ledger.records 是数组  -> 整份替换（getLedger；也兼容还没升级的云函数）
//  2) 有 recordDelta        -> 按 delta 合并（2b-1 起的记账返回）
//  3) 两个都没有            -> 不猜，标记不完整，让上层重拉
function applyRecords(res) {
  if (res && res.ledger && Array.isArray(res.ledger.records)) {
    cache.records = res.ledger.records
    cache.recordsComplete = true
    return
  }
  if (res && res.recordDelta) {
    const merged = apply.mergeRecordDelta(cache.records, res.recordDelta)
    cache.records = merged.records
    cache.recordsComplete = merged.complete
    return
  }
  cache.recordsComplete = false
}

// 已经拿到成功响应 = 账已经记上了。从这里往后无论出什么问题都只能降级，
// 绝不能抛 —— 抛出去就是「记账失败」，店员照着提示再点一次，账就记两遍。
function settleResponse(res) {
  try {
    if (res && res.ledger) applyLedgerLists(res.ledger)
    applyRecords(res)
    persist()
  } catch (error) {
    cache.recordsComplete = false
    console.warn('[ledger] 回写本地缓存失败', error)
  }
}

// 保留给 deleteShop / 内存模式重置：整份替换语义
function applyLedger(ledger) {
  applyLedgerLists(ledger)
  cache.records = (ledger && Array.isArray(ledger.records)) ? ledger.records : []
  cache.recordsComplete = true
  persist()
}

function loadCacheFromStorage() {
  cache.products = readList(KEYS.products)
  cache.skus = readList(KEYS.skus)
  cache.records = readList(KEYS.records)
  cache.customers = readList(KEYS.customers)
  cache.categories = readList(KEYS.categories)
  cache.revision = wx.getStorageSync(REVISION_KEY) || 0
  cache.hasClearedBackup = !!wx.getStorageSync(HAS_BACKUP_KEY)
  cache.totals = inventory.computeTotals(cache.records)
  // 只有内存模式走这条路，本机存储就是权威来源，读回来就是完整的
  cache.recordsComplete = true
  cache.ready = true
}

function getStatus() {
  if (isMemoryMode()) {
    return {
      mode: 'memory',
      configured: true,
      canBookkeep: true,
      shopId: getShopId() || 'ui-test-shop',
      shopName: getShopName() || '测试店',
      message: ''
    }
  }
  if (!cloudConfig.isConfigured()) {
    return {
      mode: 'cloud',
      configured: false,
      canBookkeep: false,
      shopId: '',
      shopName: '',
      message: cloudConfig.missingMessage()
    }
  }
  const shopId = getShopId()
  if (!shopId) {
    return {
      mode: 'cloud',
      configured: true,
      canBookkeep: false,
      shopId: '',
      shopName: '',
      message: '还没有选择店铺。请先建店，或等老板把你的 openid 加进白名单。'
    }
  }
  return {
    mode: 'cloud',
    configured: true,
    canBookkeep: true,
    shopId: shopId,
    shopName: getShopName(),
    message: ''
  }
}

function mapCloudError(error) {
  if (error && error.message && /库存|成员|店铺|openid|欠款|不足|提交|配置|选择/i.test(error.message)) {
    return error
  }
  const msg = String((error && (error.errMsg || error.message)) || '')
  if (/conflict|transaction/i.test(msg)) {
    return new Error('库存刚被别人改过，请再提交')
  }
  if (/-501000|Environment not found|INVALID_ENV/i.test(msg)) {
    return new Error('找不到云环境。请核对 cloud-config.js 是否等于开发者工具「云开发」里的环境 ID。')
  }
  if (/-601034|开通云开发|云托管/i.test(msg)) {
    return new Error('当前小程序还不能用这个云环境。请在开发者工具点「云开发」开通，并确认 AppID 不是测试号。')
  }
  if (error && error.message) return error
  return new Error(msg || '记账失败')
}

function callCloud(action, shopId, payload) {
  if (!wx.cloud || !wx.cloud.callFunction) {
    return Promise.reject(new Error('当前基础库不支持云开发，无法记账'))
  }
  return wx.cloud.callFunction({
    name: 'ledger',
    data: {
      action: action,
      shopId: shopId || '',
      // 服务端对会回传账本的 action 设了版本门。新客户端对**新旧两版云函数都能用**：
      // 老云函数忽略 apiVersion、照旧回传整本 ledger.records，走整份替换分支。
      // 这是「先发小程序、再部署云函数」这个上线顺序的依据。
      apiVersion: 2,
      payload: payload || {}
    }
  }).then(function (res) {
    const result = res && res.result
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || '记账失败')
    }
    return result
  }).catch(function (error) {
    throw mapCloudError(error)
  })
}

function showBusy() {
  if (isMemoryMode()) return
  wx.showLoading({ title: '提交中', mask: true })
}

function hideBusy() {
  if (isMemoryMode()) return
  wx.hideLoading()
}

function readArchive() {
  const value = wx.getStorageSync(ARCHIVE_KEY)
  return Array.isArray(value) ? value : []
}

function writeArchive(list) {
  wx.setStorageSync(ARCHIVE_KEY, list)
}

// ---------------------------------------------------------------------------
// 内存模式的流水仓：接口和 cloudfunctions/ledger/ledger-records.js 的 recordStore
// 一致，存的也是同一份 toRecordDoc 文档（账套号 bookId 一样有效）。
//
// **这段代码本身没有自动化测试**：内存模式只有 tests/ui.test.js 走，而它要开发者
// 工具才能跑。被测过的是同一套接口的另外两份实现（tests/memory-db.js 的
// MemoryBook 和 MemoryDb），以及它们下面的 applyMutation / recordsNeeded。
// 改这里之后请手动跑一次 npm run test:ui。
// ---------------------------------------------------------------------------

function readRecordDocs() {
  const value = wx.getStorageSync(MEMORY_RECORDS_KEY)
  return Array.isArray(value) ? value : []
}

function writeRecordDocs(list) {
  wx.setStorageSync(MEMORY_RECORDS_KEY, list)
}

function memoryBookId() {
  return String(wx.getStorageSync(MEMORY_BOOK_KEY) || '') || (getShopId() || 'ui-test-shop')
}

function memoryRecordStore(bookId) {
  const book = String(bookId || '')

  function rows() {
    return readRecordDocs().filter(function (doc) {
      return String(doc.bookId || '') === book
    })
  }

  function descending(list) {
    return list.slice().sort(function (a, b) {
      if (a.sortKey === b.sortKey) return 0
      return a.sortKey > b.sortKey ? -1 : 1
    })
  }

  function byId(id) {
    const key = apply.recordDocId(book, id)
    const doc = readRecordDocs().find(function (item) {
      return item._id === key
    })
    return doc ? apply.fromRecordDoc(doc) : null
  }

  return {
    byId: function (id) {
      return byId(id)
    },
    saleOrder: function (id) {
      const record = byId(id)
      return record && record.type === 'out' ? record : null
    },
    latestPurchases: function (productId, skuId) {
      return descending(rows().filter(function (doc) {
        return doc.type === 'in'
          && doc.productId === String(productId || '')
          && doc.skuId === String(skuId || '')
      })).slice(0, 2).map(apply.fromRecordDoc)
    },
    countAll: function () {
      return rows().length
    },
    all: function () {
      return descending(rows()).map(apply.fromRecordDoc)
    },
    set: function (record) {
      const doc = apply.toRecordDoc(record, book, getShopId() || 'ui-test-shop')
      const list = readRecordDocs().filter(function (item) {
        return item._id !== doc._id
      })
      list.push(doc)
      writeRecordDocs(list)
    },
    remove: function (id) {
      const key = apply.recordDocId(book, id)
      writeRecordDocs(readRecordDocs().filter(function (item) {
        return item._id !== key
      }))
    }
  }
}

function applyRecordWrites(store, writes) {
  ;(writes || []).forEach(function (write) {
    if (write.op === 'remove') {
      store.remove(write.id)
      return
    }
    store.set(write.record)
  })
}

function resetMemoryBook(bookId) {
  writeRecordDocs([])
  wx.setStorageSync(MEMORY_BOOK_KEY, bookId || '')
  wx.setStorageSync(MEMORY_ACCOUNTS_KEY, {})
  wx.setStorageSync(MEMORY_AGGREGATE_KEY, inventory.emptyTerms())
}

function memoryLedger() {
  const archive = readArchive()
  return {
    products: readList(KEYS.products),
    skus: readList(KEYS.skus),
    customers: readList(KEYS.customers),
    categories: readList(KEYS.categories),
    revision: wx.getStorageSync(REVISION_KEY) || 0,
    bookId: memoryBookId(),
    recordsMigratedAt: 1,
    accounts: wx.getStorageSync(MEMORY_ACCOUNTS_KEY) || {},
    aggregate: wx.getStorageSync(MEMORY_AGGREGATE_KEY) || inventory.emptyTerms(),
    clearSnapshots: archive.map(function (item) {
      return { id: item.id, savedAt: item.savedAt }
    }),
    lastRestoredClearAt: Number(wx.getStorageSync(LAST_RESTORED_KEY) || 0)
  }
}

// 和云上的 publicListsOf 同形状：四张表 + 聚合投影 + 备份元信息，**不带流水**。
// lastRestoredClearAt 是内存模式专有的：memoryLedger() 要从 storage 读回它，
// 云模式没人读（服务端自己存着）。
function memoryPublicLists(ledger) {
  const lists = apply.listsOf(ledger)
  lists.hasClearedBackup = apply.hasClearedBackup(ledger)
  lists.archivedClearCount = ((ledger && ledger.clearSnapshots) || []).length
  lists.lastRestoredClearAt = (ledger && ledger.lastRestoredClearAt) || 0
  return lists
}

function memoryLists(ledger) {
  const lists = memoryPublicLists(ledger)
  lists.records = memoryRecordStore(ledger.bookId).all()
  return lists
}

// 记账主体和 cloudfunctions/ledger/ledger-core.js 的事务体一样：
// 先按 recordsNeeded 把牵连到的那几条捞出来，再 applyMutation，最后落盘写记录。
// 返回值也和云上同形状（ledger 不带 records + recordDelta），这样内存模式和
// 云模式走**同一条回写路径** settleResponse，不再各写一套。
async function memoryMutate(action, payload) {
  payload = payload || {}
  const ledger = memoryLedger()
  const bookIdBefore = ledger.bookId
  if (action === 'restoreCleared') {
    const archive = readArchive()
    payload = Object.assign({}, payload, {
      snapshot: archive.length ? archive[archive.length - 1] : null
    })
  }
  const loaded = await apply.prepareMutation(memoryRecordStore(ledger.bookId), action, payload)
  const applied = apply.applyMutation(ledger, action, payload, Date.now(), uid, loaded)
  if (applied.result && applied.result.clearSnapshot) {
    writeArchive(readArchive().concat([applied.result.clearSnapshot]))
    delete applied.result.clearSnapshot
  }
  // loadSeed / clearAll 会换账套，写进去的必须是「改后」的那一本
  applyRecordWrites(memoryRecordStore(applied.ledger.bookId), applied.recordWrites)
  wx.setStorageSync(MEMORY_BOOK_KEY, applied.ledger.bookId || '')
  wx.setStorageSync(MEMORY_ACCOUNTS_KEY, applied.ledger.accounts || {})
  wx.setStorageSync(MEMORY_AGGREGATE_KEY, applied.ledger.aggregate || inventory.emptyTerms())
  return {
    ledger: memoryPublicLists(applied.ledger),      // 不带 records，和云上一样
    recordDelta: {
      bookId: String(applied.ledger.bookId || ''),
      bookChanged: applied.ledger.bookId !== bookIdBefore,
      count: (applied.ledger.aggregate && applied.ledger.aggregate.count) || 0,
      writes: applied.recordWrites || []
    },
    result: applied.result
  }
}

async function memoryCall(action, shopId, payload) {
  if (action === 'whoami') {
    return { openid: 'ui-test-openid' }
  }
  if (action === 'listShops') {
    const id = shopId || getShopId() || 'ui-test-shop'
    return { shops: [{ id: id, name: getShopName() || '测试店', role: 'owner', createdAt: 0 }] }
  }
  if (action === 'createShop') {
    const id = uid()
    const name = String((payload && payload.name) || '').trim()
    if (!name) throw new Error('请填写店铺名称')
    setShopMeta(id, name)
    wx.removeStorageSync(ARCHIVE_KEY)
    wx.removeStorageSync(LAST_RESTORED_KEY)
    resetMemoryBook(id)
    applyLedger(apply.emptyLedger())
    readyState = { shopId: id, promise: null, ok: true }
    return { shop: { id: id, name: name, role: 'owner', createdAt: Date.now() } }
  }
  if (action === 'listMembers') {
    return {
      role: 'owner',
      members: [{
        id: (shopId || getShopId()) + '_ui-test-openid',
        shopId: shopId || getShopId(),
        openid: 'ui-test-openid',
        role: 'owner',
        displayName: '测试店主',
        createdAt: 0
      }]
    }
  }
  if (action === 'addMember' || action === 'removeMember' || action === 'updateMember') {
    throw new Error('本地测试账本不能改成员')
  }
  if (action === 'deleteShop') {
    throw new Error('本地测试账本不能删店')
  }
  if (action === 'getLedger') {
    loadCacheFromStorage()
    const ledger = memoryLedger()
    return { ledger: memoryLists(ledger) }
  }
  if (action === 'migrateLocal') {
    throw new Error('本地测试账本不用迁云')
  }
  return memoryMutate(action, payload)
}

async function request(action, payload, options) {
  options = options || {}
  const shopId = options.shopId != null ? options.shopId : getShopId()
  if (isMemoryMode()) {
    return memoryCall(action, shopId, payload)
  }
  return callCloud(action, shopId, payload)
}

async function ensureReady() {
  snapshotLocalIfNeeded()
  if (isMemoryMode()) {
    if (!getShopId()) setShopMeta('ui-test-shop', '测试店')
    loadCacheFromStorage()
    cache.shopId = getShopId()
    readyState = { shopId: cache.shopId, promise: null, ok: true }
    return
  }
  const status = getStatus()
  if (!status.canBookkeep) {
    throw new Error(status.message)
  }
  const shopId = status.shopId
  if (readyState.ok && readyState.shopId === shopId) return
  if (readyState.promise && readyState.shopId === shopId) {
    await readyState.promise
    return
  }
  const promise = request('getLedger', {}, { shopId: shopId }).then(function (res) {
    settleResponse(res)
    // ready 必须蕴含「流水是完整的」：所有页面的 onShow 都以 ready 为门，
    // 有了这条，页面里拿到的流水要么完整要么根本没进门。
    if (!cache.recordsComplete) throw new Error('账本流水没取全，请重试')
    cache.shopId = shopId
    readyState.ok = true
  })
  readyState = { shopId: shopId, promise: promise, ok: false }
  await promise
}

async function ready() {
  try {
    await ensureReady()
    return true
  } catch (error) {
    util.showError(error)
    return false
  }
}

function invalidateReady() {
  readyState = { shopId: '', promise: null, ok: false }
  cache.ready = false
}

function isReady() {
  if (isMemoryMode()) return !!(readyState.ok && cache.ready)
  const shopId = getShopId()
  return !!(shopId && readyState.ok && readyState.shopId === shopId && cache.ready)
}

function lists() {
  if (isMemoryMode()) {
    return {
      products: readList(KEYS.products),
      skus: readList(KEYS.skus),
      records: readList(KEYS.records),
      customers: readList(KEYS.customers),
      categories: readList(KEYS.categories)
    }
  }
  return {
    products: cache.products,
    skus: cache.skus,
    records: cache.records,
    customers: cache.customers,
    categories: cache.categories
  }
}

function getProducts() {
  return lists().products
}

function getRecords() {
  return lists().records
}

// 只给「要算钱」的地方用：欠款、送货单。缓存不完整就报错，不给一个错数。
// 2a-b1 那条原则的直接应用：宁可打不出单，也不能在客户手上的单据上印错数。
function recordsForMoney() {
  if (!cache.recordsComplete) {
    throw new Error('流水不完整，无法算欠款，请退出重进小程序')
  }
  return getRecords()
}

function getCustomers() {
  return lists().customers
}

function getCategories() {
  return lists().categories
}

function getTotals() {
  return cache.totals || null
}

function getSkus() {
  return lists().skus
}

function getProduct(id) {
  return getProducts().find(function (item) {
    return item.id === id
  }) || null
}

function getRecord(id) {
  return getRecords().find(function (item) {
    return item.id === id
  }) || null
}

function getSku(id) {
  return getSkus().find(function (item) {
    return item.id === id
  }) || null
}

function getSkusByProduct(productId) {
  return inventory.skusOfProduct(getSkus(), productId)
}

function getCustomer(id) {
  return getCustomers().find(function (item) {
    return item.id === id
  }) || null
}

function getCategory(id) {
  return getCategories().find(function (item) {
    return item.id === id
  }) || null
}

async function mutate(action, payload) {
  await ensureReady()
  showBusy()
  let res
  try {
    res = await request(action, payload)   // 只有这一句失败等于「没记上」
  } finally {
    hideBusy()
  }
  settleResponse(res)
  if (!cache.recordsComplete) await refillRecords()
  return res
}

// 缓存条数和服务端对不上（换账套、服务端没给 delta、合并出错）。重新拉一次全量。
// **失败也不抛**：账已经记上了，报失败会诱发重复提交。作废 ready 状态，
// 下一次 store.ready() 会自己再拉一次；那一次是纯读路径，报错是诚实的。
async function refillRecords() {
  try {
    const res = await request('getLedger', {})
    settleResponse(res)
  } catch (error) {
    console.warn('[ledger] 记账后刷新流水失败', error)
  }
  if (!cache.recordsComplete) invalidateReady()
}

async function saveProduct(input) {
  const res = await mutate('saveProduct', input)
  return (res.result && res.result.products) || getProducts()
}

async function deleteProduct(id) {
  await mutate('deleteProduct', { id: id })
}

async function saveCustomer(input) {
  const res = await mutate('saveCustomer', input)
  return res.result && res.result.customer
}

async function deleteCustomer(id) {
  await mutate('deleteCustomer', { id: id })
}

async function saveCategory(input) {
  const res = await mutate('saveCategory', input)
  return res.result && res.result.category
}

async function deleteCategory(id) {
  await mutate('deleteCategory', { id: id })
}

async function appendCategoryValue(id, field, value) {
  const res = await mutate('appendCategoryValue', { id: id, field: field, value: value })
  return res.result && res.result.category
}

async function addPurchase(payload) {
  const res = await mutate('addPurchase', payload)
  return res.result && res.result.record
}

async function addSale(payload) {
  const res = await mutate('addSale', payload)
  return res.result && res.result.order
}

async function addReturn(payload) {
  const res = await mutate('addReturn', payload)
  return res.result && res.result.recordsCreated
}

async function addConvert(payload) {
  const res = await mutate('addConvert', payload)
  return res.result && res.result.record
}

async function addAdjust(payload) {
  const res = await mutate('addAdjust', payload)
  return res.result && res.result.record
}

async function addPayment(payload) {
  const res = await mutate('addPayment', payload)
  return res.result && res.result.record
}

async function addOpening(payload) {
  const res = await mutate('addOpening', payload)
  return res.result && res.result.record
}

async function updateRecord(id, payload) {
  const res = await mutate('updateRecord', Object.assign({}, payload, { id: id }))
  return res.result && res.result.record
}

async function deleteRecord(id) {
  await mutate('deleteRecord', { id: id })
}

async function loadSeed() {
  const res = await mutate('loadSeed', {})
  return res.result && res.result.seed
}

async function clearAll() {
  await mutate('clearAll', {})
}

async function restoreCleared() {
  await mutate('restoreCleared', {})
}

function hasClearedBackup() {
  return !!cache.hasClearedBackup
}

function dashboard() {
  const data = lists()
  return inventory.getDashboard(data.products, data.records, Date.now(), data.skus, getTotals())
}

async function whoami() {
  const res = await request('whoami', {}, { shopId: '' })
  return res.openid
}

async function listShops() {
  const res = await request('listShops', {}, { shopId: '' })
  return res.shops || []
}

async function createShop(name) {
  showBusy()
  try {
    const res = await request('createShop', { name: name }, { shopId: '' })
    setShopMeta(res.shop.id, res.shop.name)
    invalidateReady()
    await ensureReady()
    return res.shop
  } finally {
    hideBusy()
  }
}

async function selectShop(shopId, shopName) {
  setShopMeta(shopId, shopName || '')
  invalidateReady()
  await ensureReady()
}

async function deleteShop() {
  const shopId = getShopId()
  if (!shopId) {
    throw new Error('请选择店铺')
  }
  showBusy()
  try {
    const res = await request('deleteShop', {}, { shopId: shopId })
    setShopMeta('', '')
    wx.removeStorageSync(ARCHIVE_KEY)
    wx.removeStorageSync(LAST_RESTORED_KEY)
    applyLedger(apply.emptyLedger())
    cache.shopId = ''
    invalidateReady()
    return res
  } finally {
    hideBusy()
  }
}

async function listMembers() {
  await ensureReady()
  const res = await request('listMembers', {})
  return res
}

async function addMember(openid, role, displayName) {
  showBusy()
  try {
    return await request('addMember', { openid: openid, role: role, displayName: displayName })
  } finally {
    hideBusy()
  }
}

async function updateMember(openid, displayName) {
  showBusy()
  try {
    return await request('updateMember', { openid: openid, displayName: displayName })
  } finally {
    hideBusy()
  }
}

async function removeMember(openid) {
  showBusy()
  try {
    return await request('removeMember', { openid: openid })
  } finally {
    hideBusy()
  }
}

// 本机账本上传到云端。
//
// **顺序不可换（R-4）**：`markMigrated()` 会删掉 PENDING_MIGRATE_KEY，那是本机
// 唯一一份原始数据。所以它必须排在「**服务端确认整份账本收下了**」之后 —— 现在是
// 一次调用就传完，最后一片就是唯一一片，所以请求成功返回就算收下。
//
// 但它同样必须排在**回写本地缓存之前**：回写失败就跳过 markMigrated 的话，
// 云上已有账本、本机 pending 还在，重传永远撞「云上已有账本，不能再上传本机
// 数据」，上传按钮永久失效。
//
// 2b-2 把这里改成分片上传时（服务端的接收端已经在 ledger-core.js 的
// migrateLocalShard 里了），必须是**全部片都成功**之后才 markMigrated()。
// 中途任何一片失败都不能删本机数据：服务端那边没切账套指针，半成品账套不可达，
// 换个 token 重来就行；而本机数据删掉就没了。
async function migrateLocal() {
  const pending = getPendingMigrate()
  if (!pending) {
    throw new Error('没有可上传的本机账本')
  }
  showBusy()
  try {
    const res = await request('migrateLocal', { ledger: pending })
    markMigrated()
    settleResponse(res)
    if (!cache.recordsComplete) await refillRecords()
    return res.ledger
  } finally {
    hideBusy()
  }
}

function initCloud() {
  snapshotLocalIfNeeded()
  if (isMemoryMode()) return { ok: true, mode: 'memory' }
  if (!wx.cloud) {
    return { ok: false, message: '当前基础库不支持云开发，无法记账' }
  }
  if (!cloudConfig.isConfigured()) {
    return { ok: false, message: cloudConfig.missingMessage() }
  }
  wx.cloud.init({
    env: cloudConfig.getCloudEnvId(),
    traceUser: true
  })
  return { ok: true, mode: 'cloud' }
}

module.exports = {
  KEYS: KEYS,
  MEMORY_FLAG: MEMORY_FLAG,
  getStatus: getStatus,
  snapshotLocalIfNeeded: snapshotLocalIfNeeded,
  getPendingMigrate: getPendingMigrate,
  initCloud: initCloud,
  ensureReady: ensureReady,
  ready: ready,
  isReady: isReady,
  getShopId: getShopId,
  getShopName: getShopName,
  getProducts: getProducts,
  getRecords: getRecords,
  recordsForMoney: recordsForMoney,
  getCustomers: getCustomers,
  getCategories: getCategories,
  getTotals: getTotals,
  getSkus: getSkus,
  getProduct: getProduct,
  getSku: getSku,
  getSkusByProduct: getSkusByProduct,
  getCustomer: getCustomer,
  getCategory: getCategory,
  getRecord: getRecord,
  saveProduct: saveProduct,
  deleteProduct: deleteProduct,
  saveCustomer: saveCustomer,
  deleteCustomer: deleteCustomer,
  saveCategory: saveCategory,
  deleteCategory: deleteCategory,
  appendCategoryValue: appendCategoryValue,
  addPurchase: addPurchase,
  addSale: addSale,
  addReturn: addReturn,
  addConvert: addConvert,
  addAdjust: addAdjust,
  addPayment: addPayment,
  addOpening: addOpening,
  updateRecord: updateRecord,
  deleteRecord: deleteRecord,
  loadSeed: loadSeed,
  clearAll: clearAll,
  restoreCleared: restoreCleared,
  hasClearedBackup: hasClearedBackup,
  dashboard: dashboard,
  whoami: whoami,
  listShops: listShops,
  createShop: createShop,
  selectShop: selectShop,
  deleteShop: deleteShop,
  listMembers: listMembers,
  addMember: addMember,
  updateMember: updateMember,
  removeMember: removeMember,
  migrateLocal: migrateLocal
}
