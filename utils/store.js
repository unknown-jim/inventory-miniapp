const inventory = require('./inventory')
const apply = require('./ledger-apply')
const cloudConfig = require('./cloud-config')
const util = require('./util')
const shard = require('./ledger-shard')
const maintenance = require('./maintenance')

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
const SLIP_EXPORT_STYLE_PREFIX = 'inv_slip_export_style_'

// 首页「最近流水」要几条。20 是 RECORD_PAGE_DEFAULT；limit 非法时服务端给缺省
// 20、超过上限才钳到 100（apply.clampPageLimit）。
const RECENT_LIMIT = 20

const cache = {
  shopId: '',
  products: [],
  skus: [],
  customers: [],
  categories: [],
  revision: 0,
  hasClearedBackup: false,
  totals: null,
  // 2b-2b：客户端**没有流水全集**了。这里只有服务端给的一页 recent 和
  // 一份今日三项投影，两个都只能拿来显示，绝不能拿来算钱。
  recent: [],
  today: null,
  todayComplete: false,
  // 当前账套号。换账套（清空 / 恢复 / 填示例数据）时用来把上一本账的
  // recent / today 当场清掉，见 applyLedgerLists。
  bookId: '',
  // 服务端 getLedger 时比对 aggregate.count 和集合条数报的漂移哨兵（只比条数，
  // 纯金额漂移它看不见）。首页 / 流水页挂提示条用；只在 getLedger 回包里有，
  // 记账回包不带（不重拉），所以它一直是「上一次拉账本时」的值。
  aggregatesStale: false,
  // 最近一份清空快照的元信息 { savedAt, recordCount }（recordCount 缺失为 null）。
  // 店铺页「恢复清空前数据」的弹窗要说清恢复的是哪一份。
  latestClear: null,
  // 上一次 getLedger 用的那个零点，和当时的 mutationSeq。refreshIfStale 靠它
  // 判断「跨午夜了」和「记过账了」。
  dayStart: 0,
  fetchedSeq: 0,
  ready: false
}

// 「服务端那份数据被我改过几次」。页面用它当脏标记：翻到第 5 页点进详情再
// 返回，列表不该被清回第 1 页；但只要改过账就**必须**重来 —— 删掉的那条不能
// 还留在列表里。跨设备的实时性今天也没有（ready() 会短路），这不是回退。
let mutationSeq = 0

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

// 送货单导出样式（汇总/明细）是纯本地的 UI 偏好，按客户记，不走 ledger 云函数那条路
// （tests/no-client-cloud-db.test.js 挡的是业务集合，这个 key 从不碰它们）。
// key 里带 shopId 和 customerId 两段：多店隔离是硬约束，同名客户在不同店不能互相串。
function slipExportStyleKey(customerId) {
  return SLIP_EXPORT_STYLE_PREFIX + getShopId() + '_' + customerId
}

// 散客（customerId 为空）不读记忆，恒为 'summary'；非法值（不是这两个字符串之一）
// 也按 'summary' 兜底。
function getSlipExportStyle(customerId) {
  if (!customerId) return 'summary'
  const value = wx.getStorageSync(slipExportStyleKey(customerId))
  return value === 'detail' ? 'detail' : 'summary'
}

// 散客不写记忆；写入前同样把非法值夹回 'summary'。
function setSlipExportStyle(customerId, style) {
  if (!customerId) return
  wx.setStorageSync(slipExportStyleKey(customerId), style === 'detail' ? 'detail' : 'summary')
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
// 流水一条都不落盘：内存模式的流水在 MEMORY_RECORDS_KEY 的文档里，云模式
// 客户端根本没有流水全集。
function persist() {
  try {
    writeList(KEYS.products, cache.products)
    writeList(KEYS.skus, cache.skus)
    writeList(KEYS.customers, cache.customers)
    writeList(KEYS.categories, cache.categories)
    wx.setStorageSync(REVISION_KEY, cache.revision)
    wx.setStorageSync(HAS_BACKUP_KEY, cache.hasClearedBackup)
  } catch (error) {
    console.warn('[ledger] 本地缓存落盘失败', error)
  }
}

function applyLedgerLists(ledger) {
  const lists = apply.listsOf(ledger || apply.emptyLedger())
  // 换账套（清空数据 / 恢复 / 填示例数据）之后，手上这份 recent / today 属于
  // 上一本账。它们只在 getLedger 时更新，而 refreshIfStale 是**不抛**的：
  // 换账套那一次恰好网络抖动，首页就会一边显示已归零的欠款、一边显示清空前的
  // 今日销售和最近流水。钱是对的，旁边那几个数是上一本账的 —— 比空着更误导。
  // aggregatesStale 一起清：它是 attachRecent 比对**上一本账**比出来的，记账
  // 回包不带这个字段（applyRecent 只在有 recent 时才动它），不主动清的话
  // 旧账套的「账目正在核对中」提示条会一直挂到新账套下一次 getLedger。
  // 账套变了就当场清掉，等下一次 getLedger 拿新的。
  const nextBookId = String((lists && lists.bookId) || '')
  if (nextBookId && cache.bookId && nextBookId !== cache.bookId) {
    cache.recent = []
    cache.today = null
    cache.todayComplete = false
    cache.aggregatesStale = false
  }
  if (nextBookId) cache.bookId = nextBookId
  cache.products = lists.products
  cache.skus = lists.skus
  cache.customers = lists.customers
  cache.categories = lists.categories
  cache.revision = lists.revision
  cache.totals = lists.totals || null
  // latestClear 每个回包都带（publicListsOf 从账本文档的 clearSnapshots 现算），
  // 记账回包也不例外 —— clearAll 之后马上点恢复，弹窗拿到的就是刚存的那份。
  cache.latestClear = (ledger && ledger.latestClear) || null
  cache.ready = true
  cache.hasClearedBackup = apply.hasClearedBackup(ledger) || !!(ledger && ledger.hasClearedBackup)
  if (ledger && ledger.lastRestoredClearAt != null) {
    try { wx.setStorageSync(LAST_RESTORED_KEY, ledger.lastRestoredClearAt) } catch (e) {}
  }
}

// getLedger 回传的 recent / today 是服务端按客户端给的 dayStart 现算的**读时
// 投影**，不落库，直接收下。记账回传里没有这两个字段（事务提交后零 IO），
// 所以它们只在这里更新，其余时候靠 mutationSeq 标脏、refreshIfStale 重取。
// aggregatesStale 同理：只有 getLedger 走过 attachRecent 那次比对才有这个字段，
// 也只在这里收。漂移不会因为记了一笔账自己好掉（增量维护会把漂移原样带下去），
// 所以下一次 getLedger 之前一直显示是诚实的。
function applyRecent(ledger) {
  if (!ledger || !Array.isArray(ledger.recent)) return
  cache.recent = ledger.recent
  cache.today = ledger.today || null
  cache.todayComplete = !!ledger.todayComplete
  cache.aggregatesStale = !!ledger.aggregatesStale
}

// 已经拿到成功响应 = 账已经记上了。从这里往后无论出什么问题都只能降级，
// 绝不能抛 —— 抛出去就是「记账失败」，店员照着提示再点一次，账就记两遍。
function settleResponse(res) {
  try {
    if (res && res.ledger) applyLedgerLists(res.ledger)
    applyRecent(res && res.ledger)
    persist()
  } catch (error) {
    // 回写到一半就断了，这份缓存的四张表可能只补进去一部分。作废 ready，
    // 下一次 store.ready() 会重新拉一遍；**那一次是纯读路径，报错是诚实的**。
    invalidateReady()
    console.warn('[ledger] 回写本地缓存失败', error)
  }
}

// 保留给 deleteShop / 内存模式重置：整份替换语义
function applyLedger(ledger) {
  applyLedgerLists(ledger)
  cache.recent = (ledger && Array.isArray(ledger.recent)) ? ledger.recent : []
  cache.today = null
  cache.todayComplete = false
  cache.aggregatesStale = false
  cache.dayStart = 0
  persist()
}

function loadCacheFromStorage() {
  cache.products = readList(KEYS.products)
  cache.skus = readList(KEYS.skus)
  cache.customers = readList(KEYS.customers)
  cache.categories = readList(KEYS.categories)
  cache.revision = wx.getStorageSync(REVISION_KEY) || 0
  cache.hasClearedBackup = !!wx.getStorageSync(HAS_BACKUP_KEY)
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
  // 下面这条 /conflict|transaction/ 会把 TransactionNotExist 一起吃掉，
  // **这是有意的，别在这里加前置分支把它拆出来**：
  //
  // 服务端敢拆，是因为它拿得到 (错误文本, 事务耗时) 两个入参 —— 没到 30 秒就炸
  // 才判「单事务写入量超限」那一类（ledger-core.js 的 classifyTransactionError）。
  // **客户端拿不到事务耗时**，少了判据就不该判：一次真跑满 30 秒的超时和一次
  // 写入量超限，在这里长得一模一样，而两者该给的建议正相反。
  //
  // 而且这条路上本来也见不到原始的 TransactionNotExist：云函数已经在
  // index.js 的 runTransaction catch 里把它拆成「这张单牵连的记录太多，一次改不完」
  // 或「库存刚被别人改过，请再提交」了，客户端从 result.error 收到的是拆好的那句，
  // 会被上面第一条白名单（含「提交」二字）或末尾的 `return error` 原样放行。
  // 这里只兜**没经过云函数改写**的 SDK 层错误，那种没有耗时可量，归进可重试
  // 是正确的保守选择 —— 和 classifyTransactionError 在 elapsedMs 缺失时一致。
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
    // 维护标志在成功和失败两条路上都要收：维护开着时服务端每一个回包都带它，
    // 这就是「已经在用小程序的用户也能收到提示」的机制本身（不轮询）。
    //
    // **必须 try/catch 包住。** 这行处在每一次云调用成功路径的正中间：note() 里
    // 会调 wx.showModal，它一旦同步抛错，异常就会穿到下面的 .catch(mapCloudError)，
    // 把**一次已经提交成功的记账报成失败**，店员会再点一次、同一笔账落两遍。
    // 这正是 ledger-core.js 事务段那条「提交之后不许再有可能失败的一步」要防的
    // 同一类事故。弹窗是锦上添花，绝不能让它有本事否定一次成功的提交。
    try {
      maintenance.note(result && result.maintenance)
    } catch (error) {
      console.warn('[ledger] 维护提示失败（不影响这次请求的结果）', error)
    }
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || '记账失败')
    }
    return result
  }).catch(function (error) {
    throw mapCloudError(error)
  })
}

function showBusy(title) {
  if (isMemoryMode()) return
  // 重复调用 showLoading 会更新标题：分片上传靠这一条逐片刷进度，
  // 一本几千条的账要发几十次云函数调用，一直显示「提交中」会让人以为卡死。
  wx.showLoading({ title: title || '提交中', mask: true })
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
// 2b-2b 起 tests/store.test.js 有一整节用 node 驱动**真实的这段代码**（内存模式
// 那一节），所以它不再是「只有跑不了的 test:ui 才碰得到」的死角。分页走
// apply.pageRecords —— 和云上的集合查询、未迁移老账本切片是同一份定义。
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
    // 一张销售单名下的全部退货单，升序 = 记账顺序（整体重算用），同云上 recordStore.returnsOfSale
    returnsOfSale: function (saleOrderId) {
      return rows().filter(function (doc) {
        return doc.type === 'return'
          && doc.saleOrderId === String(saleOrderId || '')
      }).slice().sort(function (a, b) {
        if (a.sortKey === b.sortKey) return 0
        return a.sortKey < b.sortKey ? -1 : 1
      }).map(apply.fromRecordDoc)
    },
    countAll: function () {
      return rows().length
    },
    all: function () {
      return descending(rows()).map(apply.fromRecordDoc)
    },
    // 一页流水**只有一份定义**：apply.pageRecords。云上的索引化查询、未迁移
    // 老账本的内存切片、这里，三处必须给出逐条相同的结果（方案 §四）。
    page: function (options) {
      return apply.pageRecords(rows().map(apply.fromRecordDoc), options)
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
      // recordCount：内存模式的快照一定带 aggregate（snapshotLists 从带聚合的
      // 内存账本克隆的），aggregate.count 就是那份账套的流水数；老格式兜底按
      // records 数组行数，和云上 snapshotRecordCount 的口径一致。
      return {
        id: item.id,
        savedAt: item.savedAt,
        recordCount: item.aggregate
          ? inventory.toNumber(item.aggregate.count)
          : ((item.records || []).length)
      }
    }),
    lastRestoredClearAt: Number(wx.getStorageSync(LAST_RESTORED_KEY) || 0)
  }
}

// 和云上的 publicListsOf 同形状：四张表 + 聚合投影 + 备份元信息（含 latestClear），
// **不带流水**。lastRestoredClearAt 是内存模式专有的：memoryLedger() 要从
// storage 读回它，云模式没人读（服务端自己存着）。
function memoryPublicLists(ledger) {
  const lists = apply.listsOf(ledger)
  lists.hasClearedBackup = apply.hasClearedBackup(ledger)
  lists.archivedClearCount = ((ledger && ledger.clearSnapshots) || []).length
  lists.lastRestoredClearAt = (ledger && ledger.lastRestoredClearAt) || 0
  const latestClear = apply.latestClearView(ledger)
  if (latestClear) {
    lists.latestClear = latestClear
  }
  return lists
}

// getLedger 的内存版：四张表 + 聚合投影 + 最近一页 + 今日三项，**不带流水**，
// 和云上的形状逐字段一致。
//
// dayStart 这里不做「远超今天 / 1970 年」的健全性检查：云上那道检查是因为
// dayStart 来自另一台设备、服务端没有第二个时钟可以对照；内存模式里发请求的
// 和处理请求的是同一个 Date.now()，没有第二个口径可以分岔。
function memoryLedgerView(ledger, payload) {
  const all = memoryRecordStore(ledger.bookId).all()
  const lists = memoryPublicLists(ledger)
  lists.recent = apply.pageRecords(all, { limit: payload && payload.recentLimit }).records
  const dayStart = Number((payload && payload.dayStart) || 0)
  if (dayStart > 0) {
    lists.today = inventory.todayTotals(all, dayStart)
    lists.todayComplete = true
  } else {
    lists.today = null
    lists.todayComplete = false
  }
  return lists
}

// 记账主体和 cloudfunctions/ledger/ledger-core.js 的事务体一样：
// 先按 recordsNeeded 把牵连到的那几条捞出来，再 applyMutation，最后落盘写记录。
// 返回值也和云上同形状（ledger 不带 records、也不带 recordDelta），这样内存模式
// 和云模式走**同一条回写路径** settleResponse，不再各写一套。
async function memoryMutate(action, payload) {
  payload = payload || {}
  const ledger = memoryLedger()
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
    // 与云上共用同一条校验，免得内存替身比真云宽松（同上）
    const name = inventory.normalizeShopName(payload && payload.name)
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
  // 改名在内存模式下是**支持**的（不像加减成员和删店那样直接抛）：它只动
  // SHOP_NAME_KEY，不换账套、不碰账本，内存替身完全做得到。所以 UI 冒烟能端到端
  // 验一次改名，而不是只验到那句抛错。
  // 校验走 inventory.normalizeShopName —— 与云上同一份实现。
  // tests/memory-db.js 顶部那条教训是「替身宽松一分，测试就假绿一分」，
  // 这里照真云最严的一侧写。
  if (action === 'renameShop') {
    const name = inventory.normalizeShopName(payload && payload.name)
    const id = shopId || getShopId() || 'ui-test-shop'
    setShopMeta(id, name)
    return { shop: { id: id, name: name, role: 'owner', createdAt: 0 } }
  }
  if (action === 'deleteShop') {
    throw new Error('本地测试账本不能删店')
  }
  if (action === 'getLedger') {
    loadCacheFromStorage()
    return { ledger: memoryLedgerView(memoryLedger(), payload) }
  }
  if (action === 'listRecords') {
    const type = String((payload && payload.type) || '')
    const customerId = String((payload && payload.customerId) || '')
    // 和云上同一条边界：同时按类型和客户筛在云上是一条无索引查询，
    // 内存模式跑得动不代表线上跑得动，所以这里也拒绝，别让它变成
    // 「开发者工具里好好的，一上线就超时」。
    if (type && type !== 'all' && customerId) {
      throw new Error('不支持同时按类型和客户筛选')
    }
    return memoryRecordStore(memoryBookId()).page({
      type: type,
      customerId: customerId,
      cursor: (payload && payload.cursor) || '',
      limit: payload && payload.limit,
      from: payload && payload.from,
      to: payload && payload.to
    })
  }
  // 时间段汇总（2b-4）。内存模式一次折完，没有上界可撞，所以 complete 恒真。
  // 「必须给时间段」这条和云上同一份判据（apply.normalizeWindow 的 required），
  // 别让它变成「开发者工具里好好的，一上线就报错」。
  if (action === 'getRecordSummary') {
    apply.normalizeWindow(payload || {}, true)
    // 和云上同一条边界：摘要条不跟类型 chip 走，悄悄忽略掉这两个参数会让调用方
    // 拿一个全类型的数当「本月进货」用
    const sumType = String((payload && payload.type) || '')
    if (sumType && sumType !== 'all') {
      throw new Error('窗口汇总不支持按类型筛选')
    }
    if (String((payload && payload.customerId) || '')) {
      throw new Error('窗口汇总不支持按客户筛选')
    }
    const inWindow = apply.filterWindow(
      memoryRecordStore(memoryBookId()).all(), payload || {})
    return {
      totals: inventory.summarizeWindow(inWindow),
      complete: true,
      scanned: inWindow.length
    }
  }
  if (action === 'getRecord') {
    const record = memoryRecordStore(memoryBookId()).byId(String((payload && payload.recordId) || ''))
    if (!record) throw new Error('流水不存在')
    return { record: record }
  }
  if (action === 'getSlip') {
    const all = memoryRecordStore(memoryBookId()).all()
    const wanted = String((payload && payload.recordId) || '')
    const record = all.find(function (item) { return item.id === wanted }) || null
    if (!record) throw new Error('流水不存在')
    const customerId = String(record.customerId || '')
    if (!customerId) return { record: record, receivable: 0 }
    // 这里**故意**用 receivableAt 全量现算，而不是照抄云上的「当前欠款 − 后缀」：
    // 那两条正是 tests/ledger-records.test.js 钉住的等价性的两端，两边用同一份
    // 实现反而失去交叉验证。内存模式流水都在手上，全量现算零成本。
    return {
      record: record,
      receivable: inventory.receivableAt(all, customerId, record.createdAt)
    }
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

// getLedger 的入参只有两个，都是纯数据：
//   dayStart —— 今天的零点由**客户端**给（跨午夜时客户端自己知道要重取）。
//               服务端只做健全性检查，非法就回 today: null，绝不回退到服务端
//               时区现算 —— 那正是「悄悄给一个错数」。
//   recentLimit —— 首页要几条最近流水。
function ledgerPayload() {
  return {
    dayStart: inventory.startOfDay(Date.now()),
    recentLimit: RECENT_LIMIT
  }
}

// 拉一次账本并回写缓存。dayStart / fetchedSeq 只在**确实拉到了**之后才记，
// 否则 refreshIfStale 会把一次失败的刷新当成「已经是最新的」。
async function fetchLedger(options) {
  const payload = ledgerPayload()
  const res = await request('getLedger', payload, options)
  settleResponse(res)
  if (cache.ready) {
    cache.dayStart = payload.dayStart
    cache.fetchedSeq = mutationSeq
  }
  return res
}

async function ensureReady() {
  snapshotLocalIfNeeded()
  if (isMemoryMode()) {
    if (!getShopId()) setShopMeta('ui-test-shop', '测试店')
    const shopId = getShopId()
    // 内存模式不短路：本机存储就是权威来源，每次都重新读一遍最便宜也最诚实。
    await fetchLedger({ shopId: shopId })
    cache.shopId = shopId
    readyState = { shopId: shopId, promise: null, ok: true }
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
  const promise = fetchLedger({ shopId: shopId }).then(function () {
    // 2b-2b：ready 不再蕴含「流水缓存是完整的」—— 客户端根本没有流水全集了。
    // 它蕴含的是「四张表 + 聚合投影已经到手」，而钱一律读 accounts / totals。
    // settleResponse 中途出错会 invalidateReady()，cache.ready 就是那个信号。
    if (!cache.ready) throw new Error('账本没取到，请重试')
    cache.shopId = shopId
    readyState.ok = true
  })
  readyState = { shopId: shopId, promise: promise, ok: false }
  await promise
}

// 首页的今日三项和最近流水是服务端按 dayStart 现算的读时投影：记过账就过期，
// 跨了午夜也过期。**不抛** —— 首页显示旧数据好过白屏，下一次 ensureReady
// 是纯读路径，那一次报错才是诚实的。
async function refreshIfStale() {
  if (!isReady()) return false
  const dayStart = inventory.startOfDay(Date.now())
  if (cache.fetchedSeq === mutationSeq && cache.dayStart === dayStart) return false
  try {
    await fetchLedger()
    return true
  } catch (error) {
    console.warn('[ledger] 刷新今日看板失败', error)
    return false
  }
}

function dataVersion() {
  return mutationSeq
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
      customers: readList(KEYS.customers),
      categories: readList(KEYS.categories)
    }
  }
  return {
    products: cache.products,
    skus: cache.skus,
    customers: cache.customers,
    categories: cache.categories
  }
}

function getProducts() {
  return lists().products
}

// 服务端给的**最近一页**流水，只够首页列个「最近流水」。
//
// **不许拿它算钱**：它只有一页，拿它折欠款 / 折汇总必然偏小，而偏小的欠款
// 是会被印在客户手上单据上的错数。当前的钱一律读 getTotals() / customer.account。
// **也不许拿它找单**：要按 id 打开某张单请用 fetchRecord —— 那条单很可能根本
// 不在这一页里（客户往来记录、流水页翻到第 5 页）。
function getRecentRecords() {
  return cache.recent
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

// 聚合漂移哨兵（见 cache.aggregatesStale 的注释）。首页 / 流水页挂提示条用：
// 金额一律来自 accounts / totals 投影，漂了就是「页面上每个数都可能不准」，
// 这时候要让人知道该找谁，而不是把错数当真。
function getAggregatesStale() {
  return !!cache.aggregatesStale
}

// 最近一份清空快照的 { savedAt, recordCount }（recordCount 缺失为 null）。
// 「恢复清空前数据」的弹窗用它说清恢复的是哪一天、多少条。
function getLatestClear() {
  return cache.latestClear || null
}

function getSkus() {
  return lists().skus
}

function getProduct(id) {
  return getProducts().find(function (item) {
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
  // 记账成功 = 服务端那份流水变了，客户端手上的 recent / today 立刻过期。
  // **但不在这里重拉**：提交之后再发一次可能失败的请求，就又回到「账记上了
  // 却报失败」。改成脏标记，页面 onShow 时按 dataVersion() 决定要不要重取。
  mutationSeq += 1
  return res
}

// 分页取流水的唯一入口。返回 { records, cursor, hasMore }。
//
// **cursor 的空页语义要记牢**：本页为空时服务端回 ''，调用方直接赋值就会把
// 游标冲回开头、从第一页重来（总数正好是 limit 整数倍时必然踩到）。
// 正确写法是 `res.cursor || 手上那个`，见 pages/records/records.js。
async function listRecords(options) {
  await ensureReady()
  options = options || {}
  const res = await request('listRecords', {
    type: options.type || '',
    customerId: options.customerId || '',
    cursor: options.cursor || '',
    limit: options.limit,
    from: options.from,
    to: options.to
  })
  return {
    records: (res && res.records) || [],
    cursor: (res && res.cursor) || '',
    hasMore: !!(res && res.hasMore)
  }
}

// 一个时间段 [from, to) 的汇总（2b-4）：流水页顶上的「本月」摘要条。
// 回 { totals: {salesAmount, purchaseAmount, profit, count} | null, complete }。
//
// **complete 为假时 totals 是 null，页面必须显示「—」，不许显示 0**——和「今日
// 三项算不出来」同一条规矩，0 是会被当真的错数。
//
// **「全部」那一档不调这个**：全店累计就是 getTotals()（服务端 accounts /
// aggregate 的投影，零查询）。调这个只会扫一遍集合去重算同一个数。
// **欠款也不在这里**：回包里没有 receivable，欠款是存量，读 getTotals()。
async function getRecordSummary(options) {
  await ensureReady()
  options = options || {}
  // type / customerId **原样转发**，不在这里挑掉：服务端会拒绝它们（摘要条不跟
  // 类型 chip 走），挑掉就变成静默忽略 —— 调用方拿一个全类型的数当「本月进货」
  // 用，而且一路没有任何提示。和 listRecords 的「type + customerId 同禁」一样，
  // 规则只有服务端那一份，客户端只负责把话带到。
  const res = await request('getRecordSummary', {
    from: options.from,
    to: options.to,
    type: options.type,
    customerId: options.customerId
  })
  return {
    totals: (res && res.totals) || null,
    complete: !!(res && res.complete)
  }
}

// 按 id 取一条流水。分页之后缓存里**不一定**有这条（可能来自客户页的往来
// 记录，或流水页翻到很后面的一页），所以一律去服务端取，不在本地找。
async function fetchRecord(id) {
  await ensureReady()
  const res = await request('getRecord', { recordId: String(id || '') })
  return (res && res.record) || null
}

// 送货单：「截断到某张老单据时刻的欠款」唯一的算法在服务端（当前欠款减去
// 该单之后的后缀）。客户端拿不到流水全集，也就没有任何现算钱的路径。
//
// **算不出当时欠款就不开单**：宁可打不出单，也不能在客户手上的单据上印一个
// 错数。所以这里对回包挑剔到底——少了 receivable 就报错，不默认成 0。
async function getSlip(recordId) {
  await ensureReady()
  const res = await request('getSlip', { recordId: String(recordId || '') })
  if (!res || !res.record) {
    throw new Error('流水不存在')
  }
  // 挑剔到 typeof：null / undefined / '' 走 Number() 都会变成 0，而 0.00 的
  // 前欠会被当成「这个客户不欠钱」印在单据上。**必须是服务端算出来的数字。**
  const receivable = res.receivable
  if (typeof receivable !== 'number' || !isFinite(receivable)) {
    throw new Error('算不出这张单当时的欠款，暂时不能打单')
  }
  return { record: res.record, receivable: receivable }
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

// 今日三项来自服务端的读时投影；算不出来就传 null，页面显示「—」而不是 0
// （0 是会被当真的错数）。最近流水是服务端给的一页，不是整本。
function dashboard() {
  const data = lists()
  return inventory.getDashboard(
    data.products,
    cache.recent,
    Date.now(),
    data.skus,
    getTotals(),
    cache.todayComplete ? cache.today : null
  )
}

async function whoami() {
  const res = await request('whoami', {}, { shopId: '' })
  return res.openid
}

// App.onShow 的维护检查：从后台切回前台时补一次。
// 借 whoami 这个最便宜的现成 action——维护开着时它的回包自带 maintenance
// （回包携带的机制见 cloudfunctions/ledger/ledger-core.js 的 dispatch）。
// **不新增专用 action，也不轮询。**
// 失败一律静默：断网 / 没配云环境时不该弹任何东西（fail-open）。
async function checkMaintenance() {
  try {
    await request('whoami', {}, { shopId: '' })
    return maintenance.isOn()
  } catch (error) {
    return false
  }
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

// 改店名。**刻意不调 invalidateReady / ensureReady** —— 那两个是给「换店 / 换账套」
// 用的（createShop 和 selectShop 调它们是因为 shopId 变了）。改名不换账套、不动账本，
// 调它们只会白白触发一次整本账的重拉。
//
// setShopMeta 只能放在 await 成功**之后**：改名失败（店员点了、断网、维护期）时
// 本地缓存必须原封不动，否则屏上会显示一个云端根本不存在的店名。
// shopId 原样传回去，只换名字。
async function renameShop(name) {
  const shopId = getShopId()
  if (!shopId) {
    throw new Error('请选择店铺')
  }
  showBusy()
  try {
    const res = await request('renameShop', { name: name }, { shopId: shopId })
    setShopMeta(shopId, res.shop.name)
    return res.shop
  } finally {
    hideBusy()
  }
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

// 本机账本上传到云端。一本大账会撞两堵墙（请求体大小、事务生命周期），所以
// 先用 ledger-shard 的 planShards 切片、逐片走服务端的分片接收端
//（ledger-core.js 的 migrateLocalShard）；切法保证一张销售单和它的全部退货单
// 落在同一片里，服务端逐片归并出来的钱和整本一次性上传逐项相等。
//
// 一片就一片、或有孤儿退货（saleOrderId 为空 / 指向的销售单整本账里都不存在）
// 时，发不带 token 的一次性上传：线协议和 2b-1 完全一致，小账本零行为变化；
// 孤儿退货在那条路上今天就放行，而带 token 的路上 assertReturnsPaired 不区分
// 「客户端切坏的」和「源数据本来就是孤儿」，任何切法都会被拒——退回一次性
// 上传不是回归，改成硬报错才是（一本今天传得上去的小账本就传不上去了）。
//
// **不加自动重试**：中途失败时本机原件还在，店主再点一次就是一个新 token、
// 新账套，半成品账套不可达（服务端那边没切账套指针，O(1) 回滚）；加重试会把
// 一次确定性的服务端拒绝（「本机账本有问题，没有上传：…」）重复三遍，
// 收益不抵复杂度。
async function migrateLocal() {
  const pending = getPendingMigrate()
  if (!pending) {
    throw new Error('没有可上传的本机账本')
  }
  const lists = {
    products: pending.products || [],
    skus: pending.skus || [],
    customers: pending.customers || [],
    categories: pending.categories || []
  }
  // 第一片除了流水还驮着四张表，字符预算要先把它们扣掉。
  const plan = shard.planShards(pending.records, {
    firstChars: shard.SHARD_CHARS - JSON.stringify(lists).length
  })
  showBusy()
  try {
    if (plan.oversized.length) {
      // 一张销售单和它的全部退货单是不可切开的原子组，组本身超限时只能自成一片。
      // 真撞上事务上限时错误里只有 TransactionNotExist，日志里留一条能对上号的线索。
      // 必须排在下面「一片 / 孤儿退货 → 一次性上传」的 early return 之前：整本
      // 只切出一片但那片本身超限、或孤儿退货导致整本走一次性上传时，排后面就
      // 一句都不警告了——而那两种情况恰恰最需要这条线索。
      console.warn('[ledger] 有 ' + plan.oversized.length + ' 个原子组超过单片上限，只能整组一片',
        plan.oversized)
    }
    // 一片就发一次性上传（不带 token）：线协议和 2b-1 完全一致，小账本零行为变化。
    // 有孤儿退货时也走这条：带 token 的路上 assertReturnsPaired 不区分「客户端切坏的」
    // 和「源数据本来就是孤儿」，任何切法都会被拒，而一次性上传今天就放行它们。
    if (plan.shards.length <= 1 || plan.orphanReturns.length) {
      if (plan.orphanReturns.length && plan.shards.length > 1) {
        console.warn('[ledger] 本机账本里有找不到被退销售单的退货单，只能一次性上传',
          plan.orphanReturns.length)
      }
      return finishMigrate(await request('migrateLocal', { ledger: pending }))
    }
    const token = uid()
    let res = null
    for (let i = 0; i < plan.shards.length; i++) {
      const final = i === plan.shards.length - 1
      showBusy('上传中 ' + (i + 1) + '/' + plan.shards.length)
      const payload = { token: token, seq: i, records: plan.shards[i] }
      // 四张表只在第一片发；之后服务端从 ledgers.importing.lists 取。
      if (i === 0) payload.ledger = lists
      if (final) payload.final = true
      res = await request('migrateLocal', payload)
      // 老云函数不认 token，会把第一片当成整本收下并回 ledger。再往下发就是往一本
      // 已经切好的账套上撞「云上已有账本」，还不如当场停手——本机数据没删。
      if (!final && res && res.ledger) {
        throw new Error('云函数还不支持分片上传，请先部署新版云函数。本机数据没有删。')
      }
    }
    if (!res || !res.ledger) {
      throw new Error('账本没有全部上传成功，本机数据没有删，请重新上传')
    }
    return finishMigrate(res)
  } finally {
    hideBusy()
  }
}

// **顺序不可换（R-4）**：markMigrated() 会删掉 PENDING_MIGRATE_KEY，那是本机
// 唯一一份原始数据，所以它必须排在「服务端确认**整本**账本收下了」之后——分片时就是
// 最后一片回了 ledger 之后，中途任何一片失败都不许走到这里。
// 但它同样必须排在**回写本地缓存之前**：回写失败就跳过 markMigrated 的话，云上已有
// 账本、本机 pending 还在，重传永远撞「云上已有账本，不能再上传本机数据」，
// 上传按钮永久失效。
function finishMigrate(res) {
  markMigrated()
  settleResponse(res)
  // 迁完之后流水在集合里，客户端要看就走 listRecords 分页取。
  // 这里标脏即可，不在提交之后再发一次可能失败的请求。
  mutationSeq += 1
  return res.ledger
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
  refreshIfStale: refreshIfStale,
  dataVersion: dataVersion,
  getShopId: getShopId,
  getShopName: getShopName,
  getSlipExportStyle: getSlipExportStyle,
  setSlipExportStyle: setSlipExportStyle,
  getProducts: getProducts,
  getRecentRecords: getRecentRecords,
  getCustomers: getCustomers,
  getCategories: getCategories,
  getTotals: getTotals,
  getAggregatesStale: getAggregatesStale,
  getLatestClear: getLatestClear,
  getSkus: getSkus,
  getProduct: getProduct,
  getSku: getSku,
  getSkusByProduct: getSkusByProduct,
  getCustomer: getCustomer,
  getCategory: getCategory,
  listRecords: listRecords,
  getRecordSummary: getRecordSummary,
  fetchRecord: fetchRecord,
  getSlip: getSlip,
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
  checkMaintenance: checkMaintenance,
  listShops: listShops,
  createShop: createShop,
  selectShop: selectShop,
  renameShop: renameShop,
  deleteShop: deleteShop,
  listMembers: listMembers,
  addMember: addMember,
  updateMember: updateMember,
  removeMember: removeMember,
  migrateLocal: migrateLocal
}
