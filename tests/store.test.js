// 客户端账本缓存（utils/store.js）和四个页面的 node 测试。
//
// 为什么要有这个文件：2b-2b 之后，「分页」的全部客户端逻辑都落在 utils/store.js
// 和四个页面上 —— 游标累积、在飞响应的丢弃、触底连发的锁、dataVersion 脏标记、
// 「算不出当时欠款就不开单」。这些 **npm run test:ui 跑不了**（要开发者工具），
// 所以这里是它们**唯一**的落点：用 wx 存根把真实的 utils/store.js 和真实的
// Page({...}) 跑起来，云端换成 tests/memory-db.js + 真实的 ledger-core.dispatch，
// 走的是真实的整条链路，不是替身。
//
// 覆盖（方案 §六 的 T-B5，11 组）：
//    1 分页累积不重不漏
//    2 正好整页倍数：空页 cursor='' 不许把游标冲回开头（F6/F7）
//    3 切类型重置列表
//    4 在飞的旧响应必须丢弃（没写 reqToken 保护时必挂）
//    5 onReachBottom 连发只发一次（实例级锁，不能用 data.loading）；
//      手动「加载更多」（onLoadMore / onLoadMoreLedger）连点走同一套锁
//    6 dataVersion 语义：读不涨、记账涨、页面据此决定要不要重来
//    7 记账之后不再重拉整本（recordDelta / refillRecords 都已删）
//    8 customer-edit：明细取不到时金额仍是服务端权威值（2b-1a 的 B1 回归）
//    9 record-edit：算不出当时欠款就不开单
//   10 打开一张不在任何已加载页里的单
//   11 内存模式一整节（memoryRecordStore.page / getRecord / getSlip / today）
//   12 换账套之后，上一本账的 recent / today 必须当场清掉
//   13 聚合漂移哨兵（aggregatesStale）和 latestClear 的客户端落点
//   14 本机账本分片上传一整节（planShards 原子组切法 / 分片 vs 一次性逐项相等 /
//      中途失败本机原件不删 / 小账本和孤儿退货退回一次性上传 / planShards 单元）
// 外加原有的：settleResponse 绝不抛、ready() 的语义。
const assert = require('assert')
const core = require('../cloudfunctions/ledger/ledger-core')
const apply = require('../utils/ledger-apply')
const inventory = require('../utils/inventory')
const util = require('../utils/util')
const shard = require('../utils/ledger-shard')
const memory = require('./memory-db')

const MemoryDb = memory.MemoryDb

const STORE_PATH = require.resolve('../utils/store')
const CUSTOMER_EDIT_PATH = require.resolve('../pages/customer-edit/customer-edit')
const RECORDS_PATH = require.resolve('../pages/records/records')
const RECORD_EDIT_PATH = require.resolve('../pages/record-edit/record-edit')
const INDEX_PATH = require.resolve('../pages/index/index')

// 流水页一页 20 条，和 pages/records/records.js 的 PAGE_SIZE 一致
const PAGE_SIZE = 20

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function idFactory(prefix) {
  let n = 0
  return function () {
    n += 1
    return (prefix || 'id') + '-' + n
  }
}

// 把控制权交回事件循环，让在飞的 promise 走到下一个 await
function tick(times) {
  let p = Promise.resolve()
  for (let i = 0; i < (times || 3); i++) {
    p = p.then(function () {})
  }
  return p
}

// ---------------------------------------------------------------------------
// wx 存根 + 假云端
// ---------------------------------------------------------------------------

function newHarness(options) {
  options = options || {}
  const h = {
    db: options.db || new MemoryDb(),
    openid: options.openid || 'owner-openid',
    makeId: options.ids || idFactory('c'),
    // **用真实时钟**：客户端给的 dayStart 是 startOfDay(Date.now())，而服务端的
    // isValidDayStart 会拿它和 now 比。夹具用从 1000 起步的合成时钟时，任何真实
    // 的 dayStart 都会被判成「远超今天」，today 恒为 null —— 那样今日三项这条
    // 线根本演示不出来。需要「很久以前的流水」时显式给 createdAt。
    clock: options.clock || Date.now(),
    storage: {},
    toasts: [],
    calls: [],
    // { [action]: { times, message } }，times 次之内直接拒绝，模拟网络抖动
    failures: {},
    // 落盘全部失败（storage 满 / 单 key 超 1 MB）
    storageThrows: false,
    // 改写服务端回包，用来模拟畸形回包
    rewrite: null,
    // 返回一个 promise 就把这次回包按住，直到它 resolve（造在飞的旧响应）
    gate: null
  }

  h.wx = {
    getStorageSync: function (key) {
      return Object.prototype.hasOwnProperty.call(h.storage, key) ? clone(h.storage[key]) : ''
    },
    setStorageSync: function (key, value) {
      if (h.storageThrows) throw new Error('存储空间已满')
      h.storage[key] = clone(value)
    },
    removeStorageSync: function (key) {
      delete h.storage[key]
    },
    showLoading: function () {},
    hideLoading: function () {},
    showToast: function (o) { h.toasts.push(o) },
    showModal: function () {},
    setNavigationBarTitle: function () {},
    navigateTo: function () {},
    cloud: {
      // 和 cloudfunctions/ledger/index.js 的 exports.main 同形状：
      // 成功回 { ok: true, ...result }，失败回 { ok: false, error }
      callFunction: function (args) {
        const data = (args && args.data) || {}
        h.calls.push(clone(data))
        const fail = h.failures[data.action]
        if (fail && fail.times > 0) {
          fail.times -= 1
          return Promise.reject(new Error(fail.message || '网络抖动'))
        }
        h.clock += 10
        const held = h.gate ? h.gate(data) : null
        return core.dispatch({
          db: h.db,
          makeId: h.makeId,
          openid: h.openid,
          action: data.action,
          shopId: data.shopId,
          apiVersion: data.apiVersion,
          payload: data.payload || {},
          now: h.clock
        }).then(function (result) {
          const shaped = h.rewrite ? h.rewrite(data, result, h) : result
          const packed = { result: Object.assign({ ok: true }, shaped) }
          return held ? held.then(function () { return packed }) : packed
        }, function (error) {
          const packed = { result: { ok: false, error: (error && error.message) || '记账失败' } }
          return held ? held.then(function () { return packed }) : packed
        })
      }
    }
  }
  return h
}

// 服务端直连：模拟「另一台设备」，客户端缓存对它完全不感知
function serverCall(h, action, payload) {
  h.clock += 10
  return core.dispatch({
    db: h.db,
    makeId: h.makeId,
    openid: h.openid,
    action: action,
    shopId: h.shopId,
    apiVersion: core.API_VERSION,
    payload: payload || {},
    now: h.clock
  })
}

function countCalls(h, action) {
  return h.calls.filter(function (item) {
    return item.action === action
  }).length
}

// 集合里当前账套的全部流水，按 sortKey 倒序。**不经过任何查询层** ——
// 直接读 MemoryDb 的文档袋，所以它是分页结果的独立参照物。
function serverRecords(h) {
  const ledger = h.db.ledgers[h.shopId]
  const bookId = ledger && ledger.bookId
  const docs = Object.keys(h.db.records).map(function (key) {
    return h.db.records[key]
  }).filter(function (doc) {
    return doc.bookId === bookId
  })
  docs.sort(function (a, b) {
    if (a.sortKey === b.sortKey) return 0
    return a.sortKey > b.sortKey ? -1 : 1
  })
  return docs.map(apply.fromRecordDoc)
}

// 直接往集合里灌流水：图的是能自由控制条数（整页倍数）、type 分布和 createdAt，
// 比走一遍业务动作快得多，也更好控制边界。
function seedRecords(h, count, options) {
  options = options || {}
  const ledger = h.db.ledgers[h.shopId]
  const bookId = ledger.bookId
  const types = options.types || ['opening']
  const made = []
  for (let i = 0; i < count; i++) {
    const type = types[i % types.length]
    const withCustomer = !!options.customerId && (type === 'opening' || type === 'out')
    made.push({
      id: (options.prefix || 'seed') + '-' + i,
      type: type,
      amount: 1,
      profit: 0,
      remark: '',
      customerId: withCustomer ? options.customerId : '',
      customerName: withCustomer ? '播种客户' : '',
      customerPhone: '',
      customerAddress: '',
      payType: 'cash',
      // 很久以前：不能落进「今天」，否则今日三项那几条断言会被它污染
      createdAt: 1000000 + i,
      lines: []
    })
  }
  made.forEach(function (record) {
    const doc = apply.toRecordDoc(record, bookId, h.shopId)
    h.db.records[doc._id] = doc
  })
  h.db.ledgers[h.shopId] = Object.assign({}, ledger, {
    customers: options.customerId
      ? [{ id: options.customerId, name: '播种客户', phone: '', address: '' }]
      : ledger.customers,
    accounts: inventory.foldAccountTerms(made),
    aggregate: inventory.foldTotalTerms(made)
  })
  return made
}

// 每个场景都要一份全新的 store：模块级 cache 是单例，不重载会串场
function loadStore(h) {
  global.wx = h.wx
  delete require.cache[STORE_PATH]
  return require(STORE_PATH)
}

// 开一家店并把客户端指向它。createShop 走服务端直连，省掉一轮客户端建店流程。
async function openShop(h, name) {
  const res = await serverCall(h, 'createShop', { name: name || '测试店' })
  h.shopId = res.shop.id
  h.storage['inv_shop_id'] = h.shopId
  h.storage['inv_shop_name'] = res.shop.name
  return h.shopId
}

// store.js 的降级路径全靠 console.warn 记一笔。收下来既是断言材料，
// 也免得把 npm test 的输出淹掉 —— 这些异常都是用例自己造的。
const warns = []
console.warn = function () {
  warns.push(Array.prototype.slice.call(arguments).join(' '))
}

function takeWarns(re) {
  const hit = warns.filter(function (line) { return re.test(line) })
  warns.length = 0
  return hit
}

async function rejects(fn, re) {
  try {
    await fn()
  } catch (error) {
    assert.ok(re.test(error.message), '错误信息对不上: ' + error.message)
    return error
  }
  assert.fail('本该抛错: ' + re)
}

// ---------------------------------------------------------------------------
// 被测页面：Page({...}) 的 options 抓出来，配一个最小的 setData
// ---------------------------------------------------------------------------

function loadPage(modulePath) {
  let captured = null
  global.Page = function (options) { captured = options }
  delete require.cache[modulePath]
  require(modulePath)
  assert.ok(captured, '页面没有调用 Page()')
  return captured
}

function mountPage(options, initialData) {
  const inst = Object.assign({}, options)
  inst.data = Object.assign(clone(options.data) || {}, initialData || {})
  inst.setData = function (patch, cb) {
    Object.assign(inst.data, patch)
    if (cb) cb()
  }
  return inst
}

function tapType(type) {
  return { currentTarget: { dataset: { type: type } } }
}

// 云模式测试只需要「环境 ID 已配置」这个前提，不该和真实的部署配置绑在一起：
// 按 docs/cloud-ledger.md，CLOUD_ENV_ID 空着是合法状态，那时不该让单测变红。
require('../utils/cloud-config')
require.cache[require.resolve('../utils/cloud-config')].exports = {
  CLOUD_ENV_ID: 'test-env',
  getCloudEnvId: function () { return 'test-env' },
  isConfigured: function () { return true },
  missingMessage: function () { return '未配置云环境 ID，无法记账。' }
}

;(async function () {

  // -------------------------------------------------------------------------
  // 0) 基本形态：ready() 之后有四张表 + 权威 totals，但**没有**流水全集。
  //    每一次调用都必须带 apiVersion，否则服务端版本门会把新客户端也挡了。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('a') })
    await openShop(h)
    const store = loadStore(h)

    assert.strictEqual(await store.ready(), true, 'getLedger 正常时 ready() 必须是 true')
    assert.strictEqual(store.isReady(), true)
    assert.strictEqual(typeof store.getRecords, 'undefined', 'getRecords 已删')
    assert.strictEqual(typeof store.recordsForMoney, 'undefined', 'recordsForMoney 已删')
    assert.deepStrictEqual(store.getRecentRecords(), [], '空账本的 recent 是空列表')

    const customer = await store.saveCustomer({ name: '甲' })
    await store.addOpening({ customerId: customer.id, amount: 1000, remark: '上线前欠款' })
    assert.strictEqual(store.getCustomer(customer.id).account.receivable, 1000)
    assert.strictEqual(store.getTotals().receivable, 1000)
    assert.strictEqual(store.getTotals().count, 1)

    h.calls.forEach(function (item) {
      assert.strictEqual(item.apiVersion, 2, 'callCloud 必须带 apiVersion: 2')
    })
    // getLedger 的入参必须带 dayStart / recentLimit，否则今日三项永远算不出来
    const ledgerCall = h.calls.filter(function (item) { return item.action === 'getLedger' })[0]
    assert.ok(ledgerCall.payload.dayStart > 0, 'getLedger 必须带 dayStart')
    assert.strictEqual(ledgerCall.payload.dayStart, inventory.startOfDay(ledgerCall.payload.dayStart))
    assert.ok(ledgerCall.payload.recentLimit > 0, 'getLedger 必须带 recentLimit')
  }

  // -------------------------------------------------------------------------
  // 7) 记账之后**不再重拉整本**。
  //    2b-2b 删掉了 recordDelta / mergeRecordDelta / refillRecords，记账回传
  //    只有四张表 + 聚合投影。所以一笔记账 = 一次往返，一次都不能多。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('b') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '乙' })

    const getLedgerBefore = countCalls(h, 'getLedger')
    const listBefore = countCalls(h, 'listRecords')
    const versionBefore = store.dataVersion()
    const record = await store.addPayment({ customerId: customer.id, amount: 0 })
      .catch(function () { return null })
    // 上面这笔会被业务规则拒（没有欠款），换一笔合法的
    assert.strictEqual(record, null)
    await store.addOpening({ customerId: customer.id, amount: 500 })
    await store.addPayment({ customerId: customer.id, amount: 100 })

    assert.strictEqual(countCalls(h, 'getLedger'), getLedgerBefore,
      '记账之后不该再拉一次 getLedger —— 提交之后再发一次可能失败的请求，'
      + '就又回到「账记上了却报失败」')
    assert.strictEqual(countCalls(h, 'listRecords'), listBefore,
      '记账之后也不该顺手去翻流水')
    // 6) dataVersion：记账涨、纯读不涨
    assert.strictEqual(store.dataVersion(), versionBefore + 2,
      '每一笔记成的账让 dataVersion 涨 1（被拒的那笔不算）')
    const versionAfter = store.dataVersion()
    await store.listRecords({ limit: 5 })
    await store.ready()
    assert.strictEqual(store.dataVersion(), versionAfter, '纯读不许改 dataVersion')
    // 钱一律读服务端投影
    assert.strictEqual(store.getCustomer(customer.id).account.receivable, 400)
  }

  // -------------------------------------------------------------------------
  //  1 + 2) 分页累积不重不漏；正好整页倍数时空页的 cursor 不许把游标冲回开头。
  //
  //  语料条数刻意取 PAGE_SIZE 的整数倍：那时最后一页是 0 条 + hasMore:false，
  //  服务端回的 cursor 是 ''。客户端要是写成 `cursor: res.cursor` 而不是
  //  `res.cursor || 手上那个`，下一次触底就会从第一页重来（列表里出现重复）。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('p') })
    await openShop(h)
    const seeded = seedRecords(h, PAGE_SIZE * 2, { prefix: 'pg' })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(RECORDS_PATH))
    await page.onShow()
    assert.strictEqual(page.data.list.length, PAGE_SIZE, '第一页正好一整页')
    assert.strictEqual(page.data.hasMore, true, '整页倍数时第一页 hasMore 必须为真')
    const cursorAfterFirst = page.data.cursor
    assert.ok(cursorAfterFirst, '第一页要给出游标')

    await page.onReachBottom()
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 2)
    assert.strictEqual(page.data.hasMore, true, '第二页也是整页，hasMore 仍为真')
    const cursorAfterSecond = page.data.cursor
    assert.notStrictEqual(cursorAfterSecond, cursorAfterFirst)

    // 第三页是空页：cursor 回 ''，客户端必须**保住**手上那个游标
    await page.onReachBottom()
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 2, '空页不该往列表里加东西')
    assert.strictEqual(page.data.hasMore, false)
    assert.strictEqual(page.data.cursor, cursorAfterSecond,
      '空页的 cursor 是 ——，直接赋值会把游标冲回开头，下一次触底就从第一页重来')

    // 不重不漏：逐条等于集合
    assert.deepStrictEqual(
      page.data.list.map(function (item) { return item.id }),
      serverRecords(h).map(function (item) { return item.id }),
      '翻完的列表必须逐条、逐顺序等于集合'
    )
    assert.strictEqual(
      new Set(page.data.list.map(function (item) { return item.id })).size,
      seeded.length,
      '不许有重复'
    )

    // 汇总四项来自服务端权威 totals，不是列表现折
    assert.strictEqual(page.data.count, seeded.length, '「全部 N」用 totals.count')
    assert.strictEqual(page.data.receivable, util.money(store.getTotals().receivable))

    // 到底了之后再触底：一次请求都不许发
    const before = countCalls(h, 'listRecords')
    await page.onReachBottom()
    assert.strictEqual(countCalls(h, 'listRecords'), before, '没有更多了就不该再发请求')
  }

  // -------------------------------------------------------------------------
  // 3) 切类型重置列表：不能把上一个筛选的结果留在列表里
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('t') })
    await openShop(h)
    seedRecords(h, 30, { prefix: 'ty', types: ['out', 'in', 'convert'] })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(RECORDS_PATH))
    await page.onShow()
    assert.strictEqual(page.data.list.length, PAGE_SIZE)

    await page.setType(tapType('in'))
    assert.strictEqual(page.data.type, 'in')
    assert.strictEqual(page.data.list.length, 10, '30 条里 10 条 in')
    page.data.list.forEach(function (item) {
      assert.strictEqual(item.type, 'in', '切类型之后列表里不许留别的类型')
    })
    assert.strictEqual(page.data.hasMore, false)

    await page.setType(tapType('all'))
    assert.strictEqual(page.data.list.length, PAGE_SIZE, '切回全部要从第一页重来，不是接着拼')
    assert.strictEqual(page.data.hasMore, true)
  }

  // -------------------------------------------------------------------------
  // 4) 在飞的旧响应必须丢弃。**没写 reqToken 保护时这条必挂。**
  //
  //    场景：进页面发出「全部」第一页 -> 还没回来，用户点了「销售」->
  //    「销售」先回来渲染上 -> 「全部」这才回来。没有 token 保护的话，
  //    「全部」那 20 条会被 concat 进「销售」的列表里。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('f') })
    await openShop(h)
    seedRecords(h, 30, { prefix: 'fl', types: ['out', 'in', 'convert'] })
    const store = loadStore(h)
    await store.ready()

    let releaseFirst = null
    const firstHeld = new Promise(function (resolve) { releaseFirst = resolve })
    let seen = 0
    h.gate = function (data) {
      if (data.action !== 'listRecords') return null
      seen += 1
      return seen === 1 ? firstHeld : null
    }

    const page = mountPage(loadPage(RECORDS_PATH))
    const first = page.onShow()
    await tick(6)
    assert.strictEqual(page.data.list.length, 0, '第一页还按在路上')

    await page.setType(tapType('out'))
    assert.strictEqual(page.data.list.length, 10, '「销售」这一页先回来了')
    page.data.list.forEach(function (item) {
      assert.strictEqual(item.type, 'out')
    })

    releaseFirst()
    await first
    await tick(6)
    assert.strictEqual(page.data.list.length, 10,
      '在飞的旧响应必须整份丢弃：它拼进来就是 30 条里混着别的类型')
    page.data.list.forEach(function (item) {
      assert.strictEqual(item.type, 'out', '旧响应污染了新列表')
    })
    assert.strictEqual(page.data.type, 'out')
    h.gate = null
  }

  // -------------------------------------------------------------------------
  // 5) onReachBottom 连发只发一次。
  //    锁必须是**实例级**的：setData 是异步的，用 data.loading 当锁时第二次
  //    读到的还是旧值，同一页会被请求两遍、列表里出现重复。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('l') })
    await openShop(h)
    seedRecords(h, PAGE_SIZE * 3, { prefix: 'lk' })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(RECORDS_PATH))
    await page.onShow()
    const before = countCalls(h, 'listRecords')

    // 连发三次，中间一次 await 都不给
    const burst = [page.onReachBottom(), page.onReachBottom(), page.onReachBottom()]
    await Promise.all(burst)
    assert.strictEqual(countCalls(h, 'listRecords'), before + 1,
      '触底连发只该发一次请求，实际 ' + (countCalls(h, 'listRecords') - before) + ' 次')
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 2)
    assert.strictEqual(
      new Set(page.data.list.map(function (item) { return item.id })).size,
      PAGE_SIZE * 2,
      '连发之后列表里不许有重复'
    )
  }

  // -------------------------------------------------------------------------
  // 5b) 手动「加载更多」按钮（onLoadMore）。触底在真机上到底会不会触发没实测
  //     过，这个按钮是列表翻页的兜底出路，连点行为必须和触底同一套：
  //     只发一次请求、列表不重、游标不回退。锁在 loadPage 里，这里钉的是它
  //     对手动按钮同样成立。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('m') })
    await openShop(h)
    seedRecords(h, PAGE_SIZE * 3, { prefix: 'ml' })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(RECORDS_PATH))
    await page.onShow()
    const before = countCalls(h, 'listRecords')

    // 连点三次「加载更多」，中间一次 await 都不给
    const burst = [page.onLoadMore(), page.onLoadMore(), page.onLoadMore()]
    await Promise.all(burst)
    assert.strictEqual(countCalls(h, 'listRecords'), before + 1,
      '手动加载连点三次只该发一次请求，实际 ' + (countCalls(h, 'listRecords') - before) + ' 次')
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 2, '连点只翻一页')
    assert.strictEqual(
      new Set(page.data.list.map(function (item) { return item.id })).size,
      PAGE_SIZE * 2,
      '连点之后列表里不许有重复'
    )

    // 翻满第三整页，再一次点到空页：游标必须保住、不许再发请求
    await page.onLoadMore()
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 3)
    assert.strictEqual(page.data.hasMore, true, '第三页也是整页，hasMore 仍为真')
    const cursorAfterThird = page.data.cursor
    await page.onLoadMore()
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 3, '空页不该往列表里加东西')
    assert.strictEqual(page.data.hasMore, false)
    assert.strictEqual(page.data.cursor, cursorAfterThird,
      '空页回 cursor 空串，直接赋值会把游标冲回开头、从第一页重来')
    const beforeEnd = countCalls(h, 'listRecords')
    await page.onLoadMore()
    assert.strictEqual(countCalls(h, 'listRecords'), beforeEnd, '没有更多了就不该再发请求')
  }

  // -------------------------------------------------------------------------
  // 6) dataVersion 在页面这一层的语义：
  //    翻到第 3 页 -> 点进详情 -> 返回（onShow），列表**不该**被清回第 1 页；
  //    但改过账之后 onShow **必须**重来 —— 删掉的那条不能还留在列表里。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('v') })
    await openShop(h)
    seedRecords(h, PAGE_SIZE * 3 + 5, { prefix: 'dv' })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(RECORDS_PATH))
    await page.onShow()
    await page.onReachBottom()
    await page.onReachBottom()
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 3)

    // 返回：没改过账，列表原样留着
    const before = countCalls(h, 'listRecords')
    await page.onShow()
    assert.strictEqual(page.data.list.length, PAGE_SIZE * 3,
      '没改过账就不该把用户翻到第 3 页的列表清回第 1 页')
    assert.strictEqual(countCalls(h, 'listRecords'), before, '也不该重新请求')

    // 记一笔账（另一条路径：直接走 store），再回来必须重来
    await store.saveCustomer({ name: '丙' })
    await page.onShow()
    assert.strictEqual(page.data.list.length, PAGE_SIZE,
      '改过账之后必须从第 1 页重来，否则删掉的那条会还留在列表里')
    assert.ok(countCalls(h, 'listRecords') > before)
  }

  // -------------------------------------------------------------------------
  // 10) 打开一张**不在任何已加载页里**的单。
  //     分页之后 store 缓存里必然没有它（recent 只有一页），所以 record-edit
  //     必须按 id 去服务端取。缓存里找就是随机报「流水不存在」。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('o') })
    await openShop(h)
    const seeded = seedRecords(h, 200, { prefix: 'far', customerId: 'far-cust' })
    const store = loadStore(h)
    await store.ready()

    const oldest = seeded[0]          // createdAt 最小，排在最后一页
    assert.ok(!store.getRecentRecords().some(function (item) {
      return item.id === oldest.id
    }), 'recent 只有一页，这条必须不在里面 —— 否则用例没有意义')

    const page = mountPage(loadPage(RECORD_EDIT_PATH))
    await page.loadRecord(oldest.id)
    assert.strictEqual(page.data.id, oldest.id, '不在缓存里的单也要打得开')
    assert.strictEqual(page.data.isOpening, true)
    assert.strictEqual(page.data.amountText, '1.00')

    // 取不到的 id：报错，不给一个空壳页面
    const missing = mountPage(loadPage(RECORD_EDIT_PATH))
    h.toasts.length = 0
    await missing.loadRecord('definitely-not-exist')
    assert.strictEqual(missing.data.id, '')
    assert.ok(h.toasts.length, '取不到要给用户一句话')
  }

  // -------------------------------------------------------------------------
  // 9) record-edit：**算不出当时欠款就不开单**。
  //    宁可打不出单，也不能在客户手上的单据上印一个错数。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('s') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '丁' })
    await store.saveProduct({ name: '米', costPrice: 3, salePrice: 5, stock: 100, alertQty: 1 })
    const productId = store.getProducts()[0].id
    await store.addOpening({ customerId: customer.id, amount: 60 })
    const order = await store.addSale({
      customerId: customer.id,
      customerName: '丁',
      payType: 'credit',
      items: [{ productId: productId, qty: 4, unitPrice: 5 }]
    })

    const page = mountPage(loadPage(RECORD_EDIT_PATH), { id: order.id })

    // a) 服务端算得出来：正常开单，前欠 / 本次 / 合计都来自服务端那一个数
    await page.openSlip()
    assert.strictEqual(page.data.showSlip, true)
    assert.strictEqual(page.data.slip.receivableText, '80.00')
    assert.strictEqual(page.data.slip.prevDebtText, '60.00')
    assert.strictEqual(page.data.slip.thisDebtText, '20.00')

    // b) getSlip 失败：不开单
    const closed = mountPage(loadPage(RECORD_EDIT_PATH), { id: order.id })
    h.failures.getSlip = { times: 99, message: '流水太多，暂时算不出当时欠款' }
    h.toasts.length = 0
    await closed.openSlip()
    assert.strictEqual(closed.data.showSlip, false, '算不出当时欠款就不许开单')
    assert.strictEqual(closed.data.slip, null)
    assert.ok(h.toasts.length, '不开单要给用户一句话')
    h.failures.getSlip = { times: 0 }

    // c) 回包里没有 receivable：同样不开单，**绝不能默认成 0** ——
    //    0.00 的前欠会被当成「这个客户不欠钱」印在单据上
    const holey = mountPage(loadPage(RECORD_EDIT_PATH), { id: order.id })
    h.rewrite = function (data, result) {
      if (data.action !== 'getSlip') return result
      const copy = Object.assign({}, result)
      delete copy.receivable
      return copy
    }
    h.toasts.length = 0
    await holey.openSlip()
    assert.strictEqual(holey.data.showSlip, false, '回包缺 receivable 时不许开单')
    assert.ok(h.toasts.length)
    h.rewrite = null

    // d) store.getSlip 这一层也要直接抛，不给调用方一个 0
    await rejects(function () {
      h.rewrite = function (data, result) {
        if (data.action !== 'getSlip') return result
        return Object.assign({}, result, { receivable: null })
      }
      return store.getSlip(order.id)
    }, /算不出/)
    h.rewrite = null

    // e) 散客单：服务端显式回 0，这是**算出来的 0**，允许开单
    const cashOrder = await store.addSale({
      payType: 'cash',
      items: [{ productId: productId, qty: 1, unitPrice: 5 }]
    })
    const cashPage = mountPage(loadPage(RECORD_EDIT_PATH), { id: cashOrder.id })
    await cashPage.openSlip()
    assert.strictEqual(cashPage.data.showSlip, true, '散客单的 0 是算出来的，允许开单')
    assert.strictEqual(cashPage.data.slip.receivableText, '0.00')
  }

  // -------------------------------------------------------------------------
  // 8) customer-edit：明细取不到时金额仍是服务端权威值（2b-1a 的 B1 回归）。
  //
  //    submitPay / submitOpening 记完账直接调 fillCustomer，**不经过
  //    store.ready() 的门**。金额三项必须当场就对。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('g') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '甲' })
    await store.saveProduct({ name: '普通货', costPrice: 2, salePrice: 5, stock: 200, alertQty: 5 })
    await store.addOpening({ customerId: customer.id, amount: 1000, remark: '上线前欠款' })
    const productId = store.getProducts()[0].id

    // 另一台设备：赊两笔各 400。客户端对它完全不感知。
    for (let i = 0; i < 2; i += 1) {
      await serverCall(h, 'addSale', {
        customerId: customer.id,
        customerName: '甲',
        payType: 'credit',
        items: [{ productId: productId, qty: 80, unitPrice: 5 }]
      })
    }
    await store.addPayment({ customerId: customer.id, amount: 100 })

    // 服务端权威值：期初 1000 + 赊 800 − 收 100
    const account = store.getCustomer(customer.id).account
    assert.strictEqual(account.receivable, 1700)
    assert.strictEqual(account.count, 2)
    assert.strictEqual(account.amount, 800)

    // 明细取不到（网络抖动）：金额三项照样是权威值，明细明确标成不可用
    h.failures.listRecords = { times: 99, message: '网络抖动' }
    const page = mountPage(loadPage(CUSTOMER_EDIT_PATH), { id: customer.id, isEdit: true })
    const pending = page.fillCustomer(customer.id)
    // fillCustomer 是同步的：金额当场就对，**不等明细**（下面才 await）
    assert.strictEqual(page.data.receivable, 1700, '客户页的欠款必须等于服务端权威值')
    assert.strictEqual(page.data.receivableText, '1700.00')
    assert.strictEqual(page.data.saleCount, 2)
    assert.strictEqual(page.data.saleAmountText, '800.00')
    assert.strictEqual(page.data.hasDebt, true)
    await pending
    assert.strictEqual(page.data.ledgerUnavailable, true,
      '明细拿不到就必须标成不可用，不能装成「还没有往来记录」')
    assert.deepStrictEqual(page.data.ledger, [])
    assert.strictEqual(page.data.receivable, 1700, '明细失败不许把金额也带崩')

    // 恢复网络：重试按钮把明细拉回来，金额一点不动
    h.failures.listRecords = { times: 0 }
    await page.retryLedger()
    assert.strictEqual(page.data.ledgerUnavailable, false)
    assert.strictEqual(page.data.receivable, 1700)

    // 口径：明细必须逐条等于 summarizeCustomerAccount(...).ledger
    const expected = inventory.summarizeCustomerAccount(serverRecords(h), customer.id).ledger
    assert.strictEqual(page.data.ledger.length, expected.length)
    assert.deepStrictEqual(
      page.data.ledger.map(function (item) { return item.id }),
      expected.map(function (item) { return item.id }),
      'customer-edit 的往来明细必须和 summarizeCustomerAccount 口径一致'
    )
  }

  // -------------------------------------------------------------------------
  // 8b) customer-edit 的明细也会触底加载：条数超过一页时翻得下去
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('cl') })
    await openShop(h)
    const seeded = seedRecords(h, 45, { prefix: 'cust', customerId: 'cust-1' })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(CUSTOMER_EDIT_PATH), { id: 'cust-1', isEdit: true })
    await page.fillCustomer('cust-1')
    assert.strictEqual(page.data.ledger.length, 20, '明细第一页 20 条')
    assert.strictEqual(page.data.ledgerHasMore, true)
    await page.onReachBottom()
    await page.onReachBottom()
    assert.strictEqual(page.data.ledger.length, 45, '触底翻得完')
    assert.strictEqual(page.data.ledgerHasMore, false)
    assert.strictEqual(
      new Set(page.data.ledger.map(function (item) { return item.id })).size, 45,
      '明细也不许有重复'
    )
    assert.deepStrictEqual(
      page.data.ledger.map(function (item) { return item.id }),
      seeded.slice().reverse().map(function (item) { return item.id }),
      '明细按 sortKey 倒序'
    )
  }

  // -------------------------------------------------------------------------
  // 8c) customer-edit 的手动「加载更多」（onLoadMoreLedger）：连点走和触底
  //     同一套锁，不重复加载；翻到部分页之后游标不回退、不再发请求。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('cm') })
    await openShop(h)
    seedRecords(h, 45, { prefix: 'cmr', customerId: 'cm-1' })
    const store = loadStore(h)
    await store.ready()

    const page = mountPage(loadPage(CUSTOMER_EDIT_PATH), { id: 'cm-1', isEdit: true })
    await page.fillCustomer('cm-1')
    assert.strictEqual(page.data.ledger.length, 20, '明细第一页 20 条')
    const before = countCalls(h, 'listRecords')

    // 连点两次，中间一次 await 都不给
    const burst = [page.onLoadMoreLedger(), page.onLoadMoreLedger()]
    await Promise.all(burst)
    assert.strictEqual(countCalls(h, 'listRecords'), before + 1,
      '手动加载连点只该发一次请求，实际 ' + (countCalls(h, 'listRecords') - before) + ' 次')
    assert.strictEqual(page.data.ledger.length, 40, '连点只翻一页')
    assert.strictEqual(
      new Set(page.data.ledger.map(function (item) { return item.id })).size, 40,
      '连点之后明细里不许有重复'
    )

    // 第三页只剩 5 条：翻完 hasMore 落 false，游标停在最后一个 sortKey 上不回退
    await page.onLoadMoreLedger()
    assert.strictEqual(page.data.ledger.length, 45, '翻完全部')
    assert.strictEqual(page.data.ledgerHasMore, false)
    assert.ok(page.data.ledgerCursor, '部分页的服务端游标非空，客户端要原样保住')
    const beforeEnd = countCalls(h, 'listRecords')
    await page.onLoadMoreLedger()
    assert.strictEqual(countCalls(h, 'listRecords'), beforeEnd, '没有更多了就不该再发请求')
  }

  // -------------------------------------------------------------------------
  // 1a) settleResponse 绝不抛：落盘失败
  //     账已经记上了，报「记账失败」店员会再点一次，账就记两遍。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('e') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '丙' })
    await store.addOpening({ customerId: customer.id, amount: 300 })

    h.storageThrows = true
    const record = await store.addPayment({ customerId: customer.id, amount: 50 })
    assert.ok(record && record.id, '落盘失败不能把已经记成的账变成记账失败')
    h.storageThrows = false
    assert.strictEqual(takeWarns(/落盘失败/).length, 1, '落盘失败要留一行 warn')
    assert.strictEqual(store.isReady(), true, '落盘只是缓存，失败不该作废 ready')
    assert.strictEqual(store.getCustomer(customer.id).account.receivable, 250)
  }

  // -------------------------------------------------------------------------
  // 1b) settleResponse 绝不抛：回写本身抛异常（畸形账本）
  //     这条是给变异测试用的 —— 删掉 settleResponse 的 try/catch 它必挂。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('m') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '丁' })
    await store.addOpening({ customerId: customer.id, amount: 400 })

    h.rewrite = function (data, result) {
      if (!result || !result.ledger) return result
      // products 不是数组：apply.listsOf 里的 .map 会直接抛 TypeError
      return Object.assign({}, result, {
        ledger: Object.assign({}, result.ledger, { products: 7 })
      })
    }
    h.failures.getLedger = { times: 99, message: '网络抖动' }

    const record = await store.addPayment({ customerId: customer.id, amount: 40 })
    assert.ok(record && record.id, '回写抛异常也不能把已经记成的账变成记账失败')
    assert.strictEqual(takeWarns(/回写本地缓存失败/).length, 1, '回写异常要被 settleResponse 吞成 warn')
    assert.strictEqual(store.isReady(), false, '回写失败要作废 ready，下次 onShow 自愈')
    // 账真的记上了（期初 1 条 + 收款 1 条；saveCustomer 不产生流水）
    assert.strictEqual(serverRecords(h).length, 2)
    h.rewrite = null
  }

  // -------------------------------------------------------------------------
  // 5') ready() 的语义：2b-2b 起它蕴含的是「四张表 + 聚合投影到手」，
  //     不再是「流水完整」（客户端根本没有流水全集了）。
  //     回包里连 ledger 都没有 -> 不猜，ready() 必须失败，否则页面的 onShow
  //     门就白设了：进了门却拿到一份空账本，欠款显示成 0。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('d') })
    await openShop(h)
    const store = loadStore(h)
    h.rewrite = function (data, result) {
      if (data.action !== 'getLedger') return result
      const copy = Object.assign({}, result)
      delete copy.ledger
      return copy
    }
    assert.strictEqual(await store.ready(), false, '账本没取到时 ready() 必须是 false')
    assert.strictEqual(store.isReady(), false)
    await rejects(function () { return store.ensureReady() }, /账本没取到/)
    assert.ok(h.toasts.length, 'ready() 失败要给用户一句话')
    h.rewrite = null
  }

  // -------------------------------------------------------------------------
  // 首页：今日三项来自服务端投影；算不出来显示「—」而不是 0；
  //       记过账之后 refreshIfStale 会重取，而且**失败也不抛**。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('i') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    await store.saveProduct({ name: '米', costPrice: 3, salePrice: 5, stock: 100, alertQty: 1 })
    const productId = store.getProducts()[0].id
    await store.addSale({
      payType: 'cash', items: [{ productId: productId, qty: 4, unitPrice: 5 }]
    })

    const page = mountPage(loadPage(INDEX_PATH))
    const getLedgerBefore = countCalls(h, 'getLedger')
    await page.onShow()
    assert.ok(countCalls(h, 'getLedger') > getLedgerBefore,
      '记过账之后首页 onShow 必须重取今日三项（dataVersion 脏标记）')
    assert.strictEqual(page.data.todayAvailable, true)
    assert.strictEqual(page.data.todaySalesAmount, '20.00')
    assert.strictEqual(page.data.todayProfit, '8.00')
    assert.strictEqual(page.data.recent.length, 1)

    // 没改过账就不该再重取
    const stable = countCalls(h, 'getLedger')
    await page.onShow()
    assert.strictEqual(countCalls(h, 'getLedger'), stable, '没改过账不该反复重取')

    // 服务端算不出今日（dayStart 被判非法）：显示「—」，**不是 0**
    h.rewrite = function (data, result) {
      if (data.action !== 'getLedger' || !result.ledger) return result
      return Object.assign({}, result, {
        ledger: Object.assign({}, result.ledger, { today: null, todayComplete: false })
      })
    }
    await store.saveCustomer({ name: '戊' })   // 标脏，逼一次重取
    await page.onShow()
    assert.strictEqual(page.data.todayAvailable, false)
    assert.strictEqual(page.data.todaySalesAmount, '—', '算不出来要显示「—」，0 是会被当真的错数')
    assert.strictEqual(page.data.todayProfit, '—')
    h.rewrite = null

    // refreshIfStale 失败也不抛：显示旧数据好过白屏
    await store.saveCustomer({ name: '己' })
    h.failures.getLedger = { times: 99, message: '网络抖动' }
    assert.strictEqual(await store.refreshIfStale(), false, 'refreshIfStale 失败要返回 false，不抛')
    assert.strictEqual(takeWarns(/刷新今日看板失败/).length, 1)
    h.failures.getLedger = { times: 0 }
  }

  // -------------------------------------------------------------------------
  // 11) 内存模式一整节。
  //
  //     这一节是 2b-2b 新增的：内存模式那段代码（memoryRecordStore /
  //     memoryCall）原来只有 npm run test:ui 走得到，而它要开发者工具才能跑 ——
  //     等于没有测试。现在用 node 驱动**真实的 utils/store.js**，
  //     分页 / getRecord / getSlip / 今日三项全部走一遍。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('mem') })
    h.storage['inv_test_memory_ledger'] = true
    const store = loadStore(h)

    assert.strictEqual(store.getStatus().mode, 'memory')
    assert.strictEqual(await store.ready(), true)
    // 内存模式一次云调用都不该发
    assert.strictEqual(h.calls.length, 0, '内存模式不许调云函数')

    await store.loadSeed()
    const seedCount = store.getTotals().count
    assert.ok(seedCount > 0, '种子账本要有流水')

    // a) 分页翻完 == 全量，且不重不漏。
    //    memoryRecordStore.page 走的是 apply.pageRecords —— 和云上的集合查询、
    //    未迁移老账本的切片是同一份定义。
    const paged = []
    let cursor = ''
    for (let i = 0; i < 100; i++) {
      const res = await store.listRecords({ cursor: cursor, limit: 3 })
      res.records.forEach(function (item) { paged.push(item) })
      if (!res.hasMore) break
      cursor = res.cursor || cursor
    }
    assert.strictEqual(paged.length, seedCount, '内存模式分页要翻得完')
    assert.strictEqual(new Set(paged.map(function (item) { return item.id })).size, seedCount)
    for (let i = 1; i < paged.length; i++) {
      assert.ok(
        apply.makeSortKey(paged[i - 1].createdAt, paged[i - 1].id)
          > apply.makeSortKey(paged[i].createdAt, paged[i].id),
        '内存模式的分页也必须按 sortKey 严格倒序'
      )
    }

    // b) 按类型筛：口径和 filterRecords 一致
    const outPaged = []
    let outCursor = ''
    for (let i = 0; i < 100; i++) {
      const res = await store.listRecords({ type: 'out', cursor: outCursor, limit: 3 })
      res.records.forEach(function (item) { outPaged.push(item) })
      if (!res.hasMore) break
      outCursor = res.cursor || outCursor
    }
    assert.deepStrictEqual(
      outPaged.map(function (item) { return item.id }).sort(),
      inventory.filterRecords(paged, 'out').map(function (item) { return item.id }).sort()
    )
    // 同时按类型和客户筛：云上是一条无索引查询，内存模式也必须拒绝，
    // 别让它变成「开发者工具里好好的，一上线就超时」
    await rejects(function () {
      return store.listRecords({ type: 'out', customerId: 'x' })
    }, /不支持同时按类型和客户筛选/)

    // c) getRecord：取得到、取不到就报错
    const target = paged[paged.length - 1]
    assert.deepStrictEqual(await store.fetchRecord(target.id), target)
    await rejects(function () { return store.fetchRecord('nope') }, /流水不存在/)

    // d) getSlip：内存模式**故意**用 receivableAt 全量现算，
    //    它是云上「当前欠款 − 后缀」那条等价性的另一端
    const creditSale = paged.find(function (item) {
      return item.type === 'out' && item.customerId && item.payType === 'credit'
    })
    if (creditSale) {
      const slip = await store.getSlip(creditSale.id)
      assert.strictEqual(slip.record.id, creditSale.id)
      assert.strictEqual(
        slip.receivable,
        inventory.receivableAt(paged, creditSale.customerId, creditSale.createdAt),
        '内存模式的 getSlip 必须等于 receivableAt'
      )
    }
    const cashSale = paged.find(function (item) {
      return item.type === 'out' && !item.customerId
    })
    if (cashSale) {
      assert.strictEqual((await store.getSlip(cashSale.id)).receivable, 0, '散客单没有欠款线')
    }

    // e) recent / today：由 memoryLedgerView 现算，形状和云上一致
    assert.ok(store.getRecentRecords().length > 0)
    assert.deepStrictEqual(
      store.getRecentRecords().map(function (item) { return item.id }),
      paged.slice(0, store.getRecentRecords().length).map(function (item) { return item.id }),
      'recent 就是分页的第一页'
    )
    const dash = store.dashboard()
    assert.strictEqual(dash.todayAvailable, true, '内存模式今天算得出来')
    assert.deepStrictEqual(
      { salesAmount: dash.todaySalesAmount, profit: dash.todayProfit, inAmount: dash.todayInAmount },
      inventory.todayTotals(paged, inventory.startOfDay(Date.now())),
      '内存模式的今日三项必须等于 todayTotals 对全量的折叠'
    )
    assert.strictEqual(dash.totalReceivable, store.getTotals().receivable)

    // f) 记账之后：dataVersion 涨，重新 ready() 之后 recent / totals 跟着变
    const before = store.dataVersion()
    const memProduct = store.getProducts()[0]
    await store.addAdjust({
      productId: memProduct.id, direction: 'in', reason: 'surplus', qty: 1
    })
    assert.strictEqual(store.dataVersion(), before + 1)
    await store.ready()
    assert.strictEqual(store.getTotals().count, seedCount + 1)
    assert.strictEqual(store.getRecentRecords()[0].type, 'adjust_in',
      '刚记的那条要排在 recent 最前面')

    // g) 流水页在内存模式下也走同一条分页路径
    const page = mountPage(loadPage(RECORDS_PATH))
    await page.onShow()
    assert.ok(page.data.list.length > 0)
    assert.strictEqual(page.data.count, store.getTotals().count)
  }

  // -------------------------------------------------------------------------
  // 12) 换账套之后，上一本账的 recent / today 必须当场清掉
  //
  // recent / today 只在 getLedger 时更新，而记账后的 refreshIfStale 是**不抛**的。
  // 清空数据那一次恰好网络抖动，首页就会一边显示已归零的欠款（来自记账回包的
  // totals，是对的），一边显示清空前的今日销售和最近流水 —— 钱对、旁边那几个数
  // 是上一本账的，比空着更误导。
  // -------------------------------------------------------------------------
  {
    const h = newHarness()
    const store = loadStore(h)
    await openShop(h, '换账套店')
    await store.saveProduct({ name: '货', costPrice: 3, salePrice: 5, stock: 10, alertQty: 1 })
    const product = store.getProducts()[0]
    await store.addSale({
      payType: 'cash',
      items: [{ productId: product.id, qty: 2, unitPrice: 5 }]
    })
    // 记账回传里没有 recent / today（事务提交后零 IO），ready() 又会短路，
    // 所以要显式让它按脏标记重取一次 —— 这正是首页 onShow 走的那条路。
    await store.refreshIfStale()
    assert.ok(store.dashboard().todayAvailable, '前提：清空之前今日三项算得出来')
    assert.ok(store.getRecentRecords().length > 0, '前提：清空之前 recent 非空')
    const beforeSales = store.dashboard().todaySalesAmount
    assert.ok(beforeSales > 0)

    // clearAll 换账套，紧接着的 refreshIfStale 撞上网络抖动
    h.failures.getLedger = { times: 99, message: '网络抖动' }
    await store.clearAll()
    await store.refreshIfStale()
    h.failures.getLedger = { times: 0 }

    assert.deepStrictEqual(store.getRecentRecords(), [],
      '换账套后 recent 必须清空，不能留着上一本账的流水')
    const dash = store.dashboard()
    assert.strictEqual(dash.todayAvailable, false,
      '换账套后今日三项要显示「—」，不能显示上一本账的数')
    assert.strictEqual(dash.totalReceivable, 0, '欠款来自记账回包的 totals，本来就是对的')

    // 网络恢复后自愈：refreshIfStale 失败时没有更新 fetchedSeq，所以下一次
    // onShow 还会重试（这是首页走的那条路，不是 ready() —— ready() 会短路）。
    const healed = await store.refreshIfStale()
    assert.strictEqual(healed, true, '网络恢复后下一次 onShow 必须能自愈')
    const after = store.dashboard()
    assert.strictEqual(after.todayAvailable, true, '恢复后今日三项要能算出来')
    assert.strictEqual(after.todaySalesAmount, 0, '新账套里今天还没卖过东西')
    assert.deepStrictEqual(store.getRecentRecords(), [], '新账套里也确实没有流水')
  }

  // -------------------------------------------------------------------------
  // 13) 聚合漂移哨兵（aggregatesStale）和 latestClear 的客户端落点
  //
  //     attachRecent 的哨兵此前只落在云函数日志里，没人盯等于没有；latestClear
  //     是「恢复清空前数据」弹窗的依据。两条都要从 getLedger 回包落进 store
  //     缓存、被页面读得到，才算有消费者（阶段 4 的 B3 / B1）。
  //     recordCount 缺失回 null 的退化分支钉在 tests/ledger.test.js（latestClear）。
  // -------------------------------------------------------------------------
  {
    // a) 云模式：服务端报 aggregatesStale，store 要收下、首页/流水页要亮提示条；
    //    下一次干净的 getLedger 把它压回去
    const h = newHarness({ ids: idFactory('s13') })
    let drift = true
    h.rewrite = function (data, result) {
      if (data.action !== 'getLedger' || !result || !result.ledger) return result
      return Object.assign({}, result, {
        ledger: Object.assign({}, result.ledger, { aggregatesStale: drift })
      })
    }
    const store = loadStore(h)
    await openShop(h, '哨兵店')
    assert.strictEqual(store.getAggregatesStale(), false, '没拉过账本时哨兵是关的')
    // saveProduct 内部会走 ensureReady -> fetchLedger，那是第一次拉账本，
    // rewrite 从这一次起就把漂移塞进回包
    await store.saveProduct({ name: '货', costPrice: 3, salePrice: 5, stock: 10, alertQty: 1 })
    const product = store.getProducts()[0]
    await store.ready()
    assert.strictEqual(store.getAggregatesStale(), true, 'getLedger 报漂移，store 要收下')

    const home = mountPage(loadPage(INDEX_PATH))
    await home.onShow()
    assert.strictEqual(home.data.aggregatesStale, true, '首页要亮「账目正在核对中」提示条')
    const recordsPage = mountPage(loadPage(RECORDS_PATH))
    recordsPage.onLoad({})
    await recordsPage.onShow()
    assert.strictEqual(recordsPage.data.aggregatesStale, true, '流水页也要亮（汇总四项都来自 totals 投影）')

    drift = false
    await store.addSale({ payType: 'cash', items: [{ productId: product.id, qty: 1, unitPrice: 5 }] })
    const fetched = await store.refreshIfStale()
    assert.ok(fetched, '前提：记过账之后 refreshIfStale 真的重取了')
    assert.strictEqual(store.getAggregatesStale(), false, '下一次干净的 getLedger 要把哨兵压回去')
    await home.onShow()
    assert.strictEqual(home.data.aggregatesStale, false, '提示条要跟着消失')

    // b) 云模式：clearAll 之后 latestClear 带日期和条数（弹窗文案的依据）
    await store.clearAll()
    const latest = store.getLatestClear()
    assert.ok(latest && latest.savedAt > 0, 'latestClear 带快照时间')
    assert.strictEqual(latest.recordCount, 1, '清空前那本账有 1 条销售，条数要报得出')

    // c) 内存模式：memoryPublicLists 和云上的 publicListsOf 同源（latestClearView
    //    一份定义），清空/恢复之后弹窗照样拿得到
    const hm = newHarness({ ids: idFactory('s13m') })
    hm.storage['inv_test_memory_ledger'] = true
    const memStore = loadStore(hm)
    await memStore.ready()
    await memStore.loadSeed()
    const memCount = memStore.getTotals().count
    await memStore.clearAll()
    const memLatest = memStore.getLatestClear()
    assert.ok(memLatest && memLatest.savedAt > 0, '内存模式清空之后也有 latestClear')
    assert.strictEqual(memLatest.recordCount, memCount,
      '条数 = 清空前那本账的流水数（aggregate.count）')
    await memStore.restoreCleared()
    assert.strictEqual(memStore.getLatestClear().recordCount, memCount,
      '恢复之后 latestClear 还在（元数据不动）')
  }

  // -------------------------------------------------------------------------
  // 14) 本机账本分片上传（2b-3）
  //
  //     切法本身会改钱：把退货单和它的被退销售单切到两片里，
  //     repairReturnSplits 会把那组份额一分都不重算（docs/cloud-ledger.md
  //     「不要做」里实测欠款翻倍那条）。这一节钉住：planShards 的切法不会
  //     拆开它们、分片上传的最终账和一次性上传逐项相等、中途失败本机原件
  //     不删、小账本 / 孤儿退货退回一次性上传（不带 token）。
  // -------------------------------------------------------------------------
  {
    // 一份**代 B 形状**（已经是 lines 数组）的本机账本，90 条：
    //   下标 39 = 销售单 s-hot：amount 100 / paidAmount 40（欠 60），
    //             lines[0] 带已退痕迹 returnedQty 3 / returnedAmount 30
    //   下标 41 = 退货单 r-hot：amount 30，**单头既没有 paidAmount 也没有
    //             payType**（代 B 的 B1 形状，会被 settledAmount 保守回推成
    //             「整笔退现金」），lines[0] 指回 s-hot / sl1
    //   其余 88 条 = type 'in' 的进货单（不挂客户、不影响 accounts），
    //             id 'f-<i>'、lineId 'fl-<i>'、amount 1、createdAt 递增
    // 同片上传时 repairReturnSplits 会把退货的 paidAmount 拨成 0（欠款 60 ≥
    // 退货 30），于是客户 c1 的欠款 = (100−40) − (30−0) = 30。切两片就是 60
    // （docs/cloud-ledger.md「不要做」里实测的那条）。
    function hotFixture() {
      const records = []
      for (let i = 0; i < 90; i++) {
        records.push({
          id: 'f-' + i, type: 'in', amount: 1, profit: 0, remark: '', createdAt: 100000 + i,
          lines: [{
            lineId: 'fl-' + i, productId: 'p1', productName: '散货', sku: '', skuId: '',
            color: '', size: '', qty: 1, unitPrice: 1, costPrice: 1, amount: 1, profit: 0
          }]
        })
      }
      records[39] = {
        id: 's-hot', type: 'out', amount: 100, profit: 40, remark: '', createdAt: 100039,
        paidAmount: 40, customerId: 'c1', customerName: '客一', customerPhone: '', customerAddress: '',
        lines: [{
          lineId: 'sl1', productId: 'p1', productName: '散货', sku: '', skuId: '',
          color: '', size: '', qty: 10, unitPrice: 10, costPrice: 6, amount: 100, profit: 40,
          allocations: [], returnedQty: 3, returnedAmount: 30
        }]
      }
      records[41] = {
        id: 'r-hot', type: 'return', amount: 30, profit: -18, remark: '', createdAt: 100041,
        customerId: 'c1', customerName: '客一', customerPhone: '', customerAddress: '',
        lines: [{
          lineId: 'rl1', productId: 'p1', productName: '散货', sku: '', skuId: '',
          color: '', size: '', qty: 3, unitPrice: 10, costPrice: 6, amount: 30, profit: -18,
          saleOrderId: 's-hot', saleLineId: 'sl1'
        }]
      }
      return records
    }

    function pendingLedgerOf(records) {
      return {
        products: [{ id: 'p1', name: '散货', costPrice: 1, salePrice: 10, stock: 100, alertQty: 1, colors: [], sizes: [] }],
        skus: [],
        customers: [{ id: 'c1', name: '客一', phone: '', address: '' }],
        categories: [],
        records: records
      }
    }

    // 照抄服务端 assertReturnsPaired 的判据：片里每张退货单的每一行 saleOrderId
    // 都能在**同一片**（归并后）里找到那张 out。片里装的是原始流水，先归并再判。
    function returnsPairedInShard(rawShard) {
      const merged = inventory.needsRecordMigration(rawShard)
        ? inventory.migrateRecordShape(rawShard)
        : rawShard
      const saleIds = {}
      merged.forEach(function (record) {
        if (record && record.type === 'out') saleIds[String(record.id || '')] = true
      })
      let paired = true
      merged.forEach(function (record) {
        if (!record || record.type !== 'return') return
        inventory.recordLines(record).forEach(function (line) {
          const saleId = String((line && line.saleOrderId) || '')
          if (!saleId || !saleIds[saleId]) paired = false
        })
      })
      return paired
    }

    // a) planShards 的切法不会把退货和销售切开
    const records = hotFixture()
    const plan = shard.planShards(records)
    assert.ok(plan.shards.length >= 2, '90 条默认上限 40，必须真的切了，切了 ' + plan.shards.length)
    assert.strictEqual(plan.mergedCount, 90)
    assert.strictEqual(plan.orphanReturns.length, 0)
    plan.shards.forEach(function (one, i) {
      assert.ok(returnsPairedInShard(one), '第 ' + i + ' 片里退货单必须找得到同片的销售单')
    })
    // s-hot 和 r-hot 必须落在同一片
    const hotShard = plan.shards.filter(function (one) {
      return one.some(function (r) { return r.id === 's-hot' })
    })
    assert.strictEqual(hotShard.length, 1)
    assert.ok(hotShard[0].some(function (r) { return r.id === 'r-hot' }), 's-hot 和 r-hot 必须同片')

    // 自检：这份语料真的会被朴素切法切开。朴素两片 slice(0,40)/slice(40) 把
    // s-hot（下标 39）和 r-hot（下标 41）分进两片——服务端必须拒：
    //   · 销售单那半片（seq 0 先发）先撞 V4：销售行记着 returnedQty、本片里
    //     却一条退货都没有（ledger-core.js 注释里实测的「哪一片先报错」）；
    //   · 退货单那半片按 seq 0 单独发（新店、新 token），撞的才是
    //     assertReturnsPaired 本尊——两个方向都拒，证明这份语料对切法真的
    //     敏感，上面那组断言不是「碰巧没切开」。
    const hn = newHarness({ ids: idFactory('n14') })
    await openShop(hn, '朴素切法销售侧店')
    await rejects(function () {
      return serverCall(hn, 'migrateLocal', {
        token: 'naive-0', seq: 0, ledger: pendingLedgerOf(records.slice(0, 40)), records: records.slice(0, 40)
      })
    }, /本机账本有问题，没有上传/)
    await openShop(hn, '朴素切法退货侧店')
    await rejects(function () {
      return serverCall(hn, 'migrateLocal', {
        token: 'naive-1', seq: 0, final: true, ledger: pendingLedgerOf([]), records: records.slice(40)
      })
    }, /退货单和它的销售单必须在同一片里上传/)

    // b) 分片上传的最终欠款和一次性上传逐项相等（判据的另一半）
    //    A 店走真实的 store.migrateLocal()（客户端分片），B 店直连发一次性上传
    const ha = newHarness({ ids: idFactory('a14') })
    const storeA = loadStore(ha)
    await openShop(ha, '分片上传店')
    ha.storage['inv_pending_migrate'] = pendingLedgerOf(records)
    const migrated = await storeA.migrateLocal()
    assert.ok(migrated, '分片上传最后必须回 ledger')

    const hb = newHarness({ ids: idFactory('b14') })
    await openShop(hb, '一次性上传参照店')
    await serverCall(hb, 'migrateLocal', { ledger: pendingLedgerOf(records) })

    const ledgerA = (await serverCall(ha, 'getLedger', {})).ledger
    const ledgerB = (await serverCall(hb, 'getLedger', {})).ledger
    assert.deepStrictEqual(ledgerA.accounts, ledgerB.accounts,
      '分片上传的 accounts 必须和一次性上传逐项相等')
    assert.deepStrictEqual(ledgerA.aggregate, ledgerB.aggregate,
      '分片上传的 aggregate 必须和一次性上传逐项相等')
    assert.strictEqual(inventory.accountOf(ledgerA.accounts.c1).receivable, 30,
      '同片重算份额：欠款 (100−40)−30 = 30，不是切坏后的 60')
    // 落库流水逐条相等（fromRecordDoc 已剥掉 bookId/shopId/sortKey 等单头派生物）
    const byId = function (a, b) { return a.id < b.id ? -1 : 1 }
    const docsA = serverRecords(ha).sort(byId)
    const docsB = serverRecords(hb).sort(byId)
    assert.deepStrictEqual(docsA, docsB, '两店落库的流水必须逐条相等')
    assert.strictEqual(docsA.length, plan.mergedCount)
    assert.strictEqual(docsB.length, plan.mergedCount)

    // 线协议：次数 = 片数、同一个 token、seq 连续、只有最后一片 final、只有第一片带 ledger
    const wireCalls = ha.calls.filter(function (item) { return item.action === 'migrateLocal' })
    assert.strictEqual(wireCalls.length, plan.shards.length, 'migrateLocal 调用次数 = 片数')
    const wireTokens = {}
    wireCalls.forEach(function (item, i) {
      assert.ok(item.payload.token, '第 ' + i + ' 片必须带 token')
      wireTokens[item.payload.token] = true
      assert.strictEqual(item.payload.seq, i, 'seq 必须从 0 连续递增')
      if (i === 0) {
        assert.ok(item.payload.ledger && item.payload.ledger.products, '只有第一片带四张表')
      } else {
        assert.ok(!item.payload.ledger, '第 ' + i + ' 片不该再带四张表')
      }
      if (i === wireCalls.length - 1) {
        assert.strictEqual(item.payload.final, true, '只有最后一片 final')
      } else {
        assert.ok(!item.payload.final, '第 ' + i + ' 片不该是 final')
      }
    })
    assert.strictEqual(Object.keys(wireTokens).length, 1, '全程同一个 token')
    assert.ok(!ha.storage['inv_pending_migrate'], '上传成功后本机 pending 必须删掉')
    assert.strictEqual(ha.storage['inv_local_migrated'], true)

    // c) 分片中途失败：本机原件不能在整本落库确认之前被删
    const hc = newHarness({ ids: idFactory('c14') })
    const storeC = loadStore(hc)
    await openShop(hc, '中途断电店')
    hc.storage['inv_pending_migrate'] = pendingLedgerOf(records)
    hc.rewrite = function (data, result) {
      if (data.action === 'migrateLocal' && data.payload.seq === 1) {
        return { ok: false, error: '网络断了' }
      }
      return result
    }
    await rejects(function () { return storeC.migrateLocal() }, /网络断了/)
    assert.ok(hc.storage['inv_pending_migrate'], '中途失败后本机 pending 必须还在')
    assert.ok(!hc.storage['inv_local_migrated'], '中途失败后不许标记已迁移')
    // 店里完全看不见半成品：bookId 还指着空账套，四张表和流水都是 0
    const midLedger = (await serverCall(hc, 'getLedger', {})).ledger
    assert.strictEqual(midLedger.products.length, 0)
    assert.strictEqual(midLedger.aggregate.count, 0)

    // 清掉故障重传：新 token、新账套，最终账仍然和一次性上传参照逐项相等
    hc.rewrite = null
    const retried = await storeC.migrateLocal()
    assert.ok(retried, '重传必须成功')
    const retryCalls = hc.calls.filter(function (item) { return item.action === 'migrateLocal' })
    const allTokens = []
    retryCalls.forEach(function (item) {
      if (item.payload.token) allTokens.push(item.payload.token)
    })
    // 两次尝试各自从头到尾用同一个 token，两次之间必须换新 token
    const tokenSeq = allTokens.slice()
    let switched = 0
    for (let i = 1; i < tokenSeq.length; i++) {
      if (tokenSeq[i] !== tokenSeq[i - 1]) switched += 1
    }
    assert.strictEqual(switched, 1, '两次上传之间必须换过且只换一次 token')
    const ledgerC = (await serverCall(hc, 'getLedger', {})).ledger
    assert.deepStrictEqual(ledgerC.accounts, ledgerB.accounts,
      '重传成功后的 accounts 仍必须和一次性上传参照逐项相等')
    assert.deepStrictEqual(ledgerC.aggregate, ledgerB.aggregate)

    // d) 小账本仍走一次性上传（不带 token）——防回归
    const small = records.slice(0, 3)
    const hd = newHarness({ ids: idFactory('d14') })
    const storeD = loadStore(hd)
    await openShop(hd, '小账本店')
    hd.storage['inv_pending_migrate'] = pendingLedgerOf(small)
    const smallLedger = await storeD.migrateLocal()
    assert.ok(smallLedger)
    const smallCalls = hd.calls.filter(function (item) { return item.action === 'migrateLocal' })
    assert.strictEqual(smallCalls.length, 1, '3 条流水只发一次调用')
    assert.ok(smallCalls[0].payload.token === undefined, '一次性上传不带 token')
    assert.strictEqual(smallCalls[0].payload.ledger.records.length, 3, '走的是整本 ledger.records 协议')

    // e) 孤儿退货退回一次性上传。把 r-hot 指向整本账里都不存在的 's-missing'；
    //    同时把 s-hot 行上的已退痕迹清零——不然销售行记着 returnedQty 3、本片
    //    （整本）里却没有一张退货指向它，那是 V4 的「数据自相矛盾」，不是
    //    「孤儿退货」（孤儿是被退销售单**整本不在**：跨账套 / 已删，销售侧根本
    //    没有那张单）。清零后这份语料才是今天一次性上传放行的那种孤儿。
    const orphanRecords = hotFixture()
    orphanRecords[41].lines[0].saleOrderId = 's-missing'
    orphanRecords[39].lines[0].returnedQty = 0
    orphanRecords[39].lines[0].returnedAmount = 0
    const orphanPlan = shard.planShards(orphanRecords)
    assert.strictEqual(orphanPlan.orphanReturns.length, 1)
    assert.deepStrictEqual(orphanPlan.orphanReturns[0], { id: 'r-hot', saleOrderId: 's-missing' })

    const he = newHarness({ ids: idFactory('e14') })
    const storeE = loadStore(he)
    await openShop(he, '孤儿退货店')
    he.storage['inv_pending_migrate'] = pendingLedgerOf(orphanRecords)
    const orphanLedger = await storeE.migrateLocal()
    assert.ok(orphanLedger, '孤儿退货走一次性上传，必须和今天一样放行')
    const orphanCalls = he.calls.filter(function (item) { return item.action === 'migrateLocal' })
    assert.strictEqual(orphanCalls.length, 1, '退回一次性上传：只发一次调用')
    assert.ok(orphanCalls[0].payload.token === undefined, '不带 token')
    assert.ok(takeWarns(/只能一次性上传/).length >= 1, '要留一条 warn 说明为什么退回一次性上传')

    // f) planShards 单元用例：不走云端，直接调纯函数，给小上限
    //    同 id 的两条记录必须同片（limit: 1 也要同片）
    const dupPlan = shard.planShards([
      { id: 'dup', type: 'in', amount: 1, profit: 0, remark: '', createdAt: 1, lines: [{ lineId: 'd1' }] },
      { id: 'dup', type: 'pay', amount: 1, remark: '', createdAt: 2, lines: [] }
    ], { limit: 1 })
    assert.strictEqual(dupPlan.shards.length, 1, '同 id 必须同片，limit 1 也不拆')
    assert.strictEqual(dupPlan.shards[0].length, 2)

    // 代 A（扁平、无 lines）语料：退货行 saleRecordId → 归并后视图里接线成
    // saleOrderId，必须和销售单同片——证明「代 A 靠归并后视图接线」真的接上了
    const genAPlan = shard.planShards([
      { id: 'a1', type: 'out', orderId: 'ord', productId: 'p1', productName: '货', qty: 2, unitPrice: 10, costPrice: 6, amount: 20, profit: 8, payType: 'cash', createdAt: 10 },
      { id: 'a2', type: 'return', saleRecordId: 'a1', productId: 'p1', productName: '货', qty: 1, unitPrice: 10, costPrice: 6, amount: 10, profit: -4, createdAt: 11 }
    ], { limit: 1 })
    assert.strictEqual(genAPlan.shards.length, 1, '代 A 的退货靠归并后视图接线，必须和销售单同片')
    assert.strictEqual(genAPlan.mergedCount, 2)

    // 同一张销售单的多条原始行（同 orderId）永远同片，且归并后算**一条**（mergedCount）
    const saleRowsPlan = shard.planShards([
      { id: 'x1', type: 'out', orderId: 'so', productId: 'p1', productName: '货', qty: 1, unitPrice: 10, costPrice: 6, amount: 10, profit: 4, payType: 'cash', createdAt: 1 },
      { id: 'x2', type: 'out', orderId: 'so', productId: 'p1', productName: '货', qty: 2, unitPrice: 10, costPrice: 6, amount: 20, profit: 8, payType: 'cash', createdAt: 2 },
      { id: 'y1', type: 'in', amount: 1, profit: 0, remark: '', createdAt: 3, lines: [{ lineId: 'y1l' }] }
    ], { limit: 1 })
    const xShard = saleRowsPlan.shards.find(function (one) {
      return one.some(function (r) { return r.id === 'x1' })
    })
    assert.ok(xShard.some(function (r) { return r.id === 'x2' }), '同一张销售单的多条原始行永远同片')
    assert.strictEqual(saleRowsPlan.mergedCount, 2, 'so 两条原始行归并后只算一条，加 y1 共两条')

    // 单个原子组自己就超限时自成一片，并且出现在 oversized 里
    const fat = []
    for (let i = 0; i < 3; i++) {
      fat.push({ id: 'big', type: 'pay', amount: 1, remark: '', createdAt: i + 1, lines: [] })
    }
    fat.push({ id: 'solo', type: 'pay', amount: 1, remark: '', createdAt: 9, lines: [] })
    const fatPlan = shard.planShards(fat, { limit: 2 })
    assert.strictEqual(fatPlan.oversized.length, 1, '三条同 id 的原子组自己超限，要进 oversized')
    assert.strictEqual(fatPlan.oversized[0].mergedCount, 3)
    assert.ok(fatPlan.shards.some(function (one) { return one.length === 3 }), '超限原子组自成一片')
    assert.strictEqual(fatPlan.shards.length, 2)
  }

  console.log('store.test.js ok')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
