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

function applyLedger(ledger) {
  const lists = apply.listsOf(ledger || apply.emptyLedger())
  cache.products = lists.products
  cache.skus = lists.skus
  cache.records = lists.records
  cache.customers = lists.customers
  cache.categories = lists.categories
  cache.revision = lists.revision
  cache.ready = true
  writeList(KEYS.products, cache.products)
  writeList(KEYS.skus, cache.skus)
  writeList(KEYS.records, cache.records)
  writeList(KEYS.customers, cache.customers)
  writeList(KEYS.categories, cache.categories)
  wx.setStorageSync(REVISION_KEY, cache.revision)
  cache.hasClearedBackup = apply.hasClearedBackup(ledger) || !!(ledger && ledger.hasClearedBackup)
  wx.setStorageSync(HAS_BACKUP_KEY, cache.hasClearedBackup)
  if (ledger && ledger.lastRestoredClearAt != null) {
    wx.setStorageSync(LAST_RESTORED_KEY, ledger.lastRestoredClearAt)
  }
}

function loadCacheFromStorage() {
  cache.products = readList(KEYS.products)
  cache.skus = readList(KEYS.skus)
  cache.records = readList(KEYS.records)
  cache.customers = readList(KEYS.customers)
  cache.categories = readList(KEYS.categories)
  cache.revision = wx.getStorageSync(REVISION_KEY) || 0
  cache.hasClearedBackup = !!wx.getStorageSync(HAS_BACKUP_KEY)
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

function memoryLedger() {
  const archive = readArchive()
  return {
    products: readList(KEYS.products),
    skus: readList(KEYS.skus),
    records: readList(KEYS.records),
    customers: readList(KEYS.customers),
    categories: readList(KEYS.categories),
    revision: wx.getStorageSync(REVISION_KEY) || 0,
    clearSnapshots: archive.map(function (item) {
      return { id: item.id, savedAt: item.savedAt }
    }),
    lastRestoredClearAt: Number(wx.getStorageSync(LAST_RESTORED_KEY) || 0)
  }
}

function memoryMutate(action, payload) {
  payload = payload || {}
  const ledger = memoryLedger()
  if (action === 'restoreCleared') {
    const archive = readArchive()
    payload = Object.assign({}, payload, {
      snapshot: archive.length ? archive[archive.length - 1] : null
    })
  }
  const applied = apply.applyMutation(ledger, action, payload, Date.now(), uid)
  if (applied.result && applied.result.clearSnapshot) {
    writeArchive(readArchive().concat([applied.result.clearSnapshot]))
    delete applied.result.clearSnapshot
  }
  applyLedger(applied.ledger)
  return applied
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
        createdAt: 0
      }]
    }
  }
  if (action === 'addMember' || action === 'removeMember') {
    throw new Error('本地测试账本不能改成员')
  }
  if (action === 'getLedger') {
    loadCacheFromStorage()
    const ledger = memoryLedger()
    const lists = apply.listsOf(ledger)
    lists.hasClearedBackup = apply.hasClearedBackup(ledger)
    lists.archivedClearCount = ((ledger.clearSnapshots) || []).length
    return { ledger: lists }
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
    applyLedger(res.ledger)
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

function getCustomers() {
  return lists().customers
}

function getCategories() {
  return lists().categories
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
  try {
    const res = await request(action, payload)
    if (res && res.ledger) applyLedger(res.ledger)
    return res
  } finally {
    hideBusy()
  }
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
  return inventory.getDashboard(data.products, data.records, Date.now(), data.skus)
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

async function listMembers() {
  await ensureReady()
  const res = await request('listMembers', {})
  return res
}

async function addMember(openid, role) {
  showBusy()
  try {
    return await request('addMember', { openid: openid, role: role })
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

async function migrateLocal() {
  const pending = getPendingMigrate()
  if (!pending) {
    throw new Error('没有可上传的本机账本')
  }
  showBusy()
  try {
    const res = await request('migrateLocal', { ledger: pending })
    if (res && res.ledger) applyLedger(res.ledger)
    markMigrated()
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
  getShopId: getShopId,
  getShopName: getShopName,
  getProducts: getProducts,
  getRecords: getRecords,
  getCustomers: getCustomers,
  getCategories: getCategories,
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
  listMembers: listMembers,
  addMember: addMember,
  removeMember: removeMember,
  migrateLocal: migrateLocal
}
