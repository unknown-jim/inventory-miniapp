// 客户端账本缓存（utils/store.js）的 node 测试。
//
// 为什么要有这个文件：2b-1 之后「已提交的写绝不能报失败」这条性质完全落在
// utils/store.js 上（settleResponse / refillRecords 的两层 try/catch），而
// utils/store.js 在 node 侧一行测试都没有 —— 删掉那两个 try/catch，npm test 全绿。
// 这里用 wx 存根把真实的 utils/store.js 跑起来，云端换成 tests/memory-db.js +
// 真实的 ledger-core.dispatch，所以走的是**真实的整条回写路径**，不是替身。
//
// 覆盖：
//   1 settleResponse 绝不抛：落盘失败 / 回写本身抛异常，mutate 仍然返回成功
//   2 refillRecords 绝不抛：delta 条数对不上且重拉也失败，mutate 仍然成功，
//     但 isReady() 变 false、recordsForMoney() 报错
//   3 mergeRecordDelta 在客户端这条路上真的被用了（正常 delta -> complete）
//   4 新客户端 + 老云函数（回传整本 ledger.records）走整份替换分支
//   5 ready() 蕴含 complete
//   6 B1 回归：缓存残缺时客户页的欠款必须等于服务端权威值，不能显示一个偏小的数
const assert = require('assert')
const core = require('../cloudfunctions/ledger/ledger-core')
const apply = require('../utils/ledger-apply')
const inventory = require('../utils/inventory')
const util = require('../utils/util')
const memory = require('./memory-db')

const MemoryDb = memory.MemoryDb

const STORE_PATH = require.resolve('../utils/store')
const CUSTOMER_EDIT_PATH = require.resolve('../pages/customer-edit/customer-edit')

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

// ---------------------------------------------------------------------------
// wx 存根 + 假云端
// ---------------------------------------------------------------------------

function newHarness(options) {
  options = options || {}
  const h = {
    db: options.db || new MemoryDb(),
    openid: options.openid || 'owner-openid',
    makeId: options.ids || idFactory('c'),
    clock: options.clock || 1000,
    storage: {},
    toasts: [],
    calls: [],
    // { [action]: { times, message } }，times 次之内直接拒绝，模拟网络抖动
    failures: {},
    // 落盘全部失败（storage 满 / 单 key 超 1 MB）
    storageThrows: false,
    // 改写服务端回包，用来模拟老云函数、畸形 delta
    rewrite: null
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
          return { result: Object.assign({ ok: true }, shaped) }
        }, function (error) {
          return { result: { ok: false, error: (error && error.message) || '记账失败' } }
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

// 集合里当前账套的全部流水，顺序和服务端 readAll 一致（sortKey 倒序）
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
  // 3) mergeRecordDelta 在客户端这条路上真的被用了
  //    正常一笔记账：条数对得上 -> complete -> **不重拉**
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('a') })
    await openShop(h)
    const store = loadStore(h)

    assert.strictEqual(await store.ready(), true, 'getLedger 正常时 ready() 必须是 true')
    assert.strictEqual(store.isReady(), true)
    const customer = await store.saveCustomer({ name: '甲' })
    await store.addOpening({ customerId: customer.id, amount: 1000, remark: '上线前欠款' })

    const before = store.recordsForMoney().length
    const getLedgerBefore = countCalls(h, 'getLedger')
    const record = await store.addPayment({ customerId: customer.id, amount: 100 })

    assert.strictEqual(
      countCalls(h, 'getLedger'), getLedgerBefore,
      'delta 条数对得上就不该重拉 —— 重拉了说明合并没生效，这条路又退回整本回传'
    )
    const after = store.recordsForMoney()
    assert.strictEqual(after.length, before + 1, 'delta 必须把新记录合进缓存')
    assert.ok(after.some(function (item) { return item.id === record.id }))
    // 顺序要和服务端 readAll 一致，否则「刚记完」和「重开小程序」排出来不一样
    assert.deepStrictEqual(
      after.map(function (item) { return item.id }),
      serverRecords(h).map(function (item) { return item.id }),
      '合并后的顺序必须和服务端 sortKey 倒序一致'
    )
    assert.strictEqual(store.getCustomer(customer.id).account.receivable, 900)
    // 每一次调用都必须带 apiVersion，否则服务端版本门会把新客户端也挡了
    h.calls.forEach(function (item) {
      assert.strictEqual(item.apiVersion, 2, 'callCloud 必须带 apiVersion: 2')
    })
  }

  // -------------------------------------------------------------------------
  // 4) 新客户端 + 老云函数：回包里没有 recordDelta、带整本 ledger.records
  //    -> 走整份替换分支。这是「先发小程序、再部署云函数」的依据。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('b') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '乙' })
    await store.addOpening({ customerId: customer.id, amount: 500 })

    // 从这里开始，服务端表现得像还没升级的老云函数
    h.rewrite = function (data, result, harness) {
      if (!result || !result.ledger) return result
      const copy = Object.assign({}, result)
      delete copy.recordDelta
      copy.ledger = Object.assign({}, result.ledger, { records: serverRecords(harness) })
      return copy
    }

    const getLedgerBefore = countCalls(h, 'getLedger')
    await store.addPayment({ customerId: customer.id, amount: 200 })
    assert.strictEqual(
      countCalls(h, 'getLedger'), getLedgerBefore,
      '整份替换分支本身就是完整的，不该触发重拉'
    )
    assert.strictEqual(store.isReady(), true)
    assert.deepStrictEqual(
      store.recordsForMoney().map(function (item) { return item.id }),
      serverRecords(h).map(function (item) { return item.id }),
      '老云函数回传整本时必须整份替换'
    )
    assert.strictEqual(store.getCustomer(customer.id).account.receivable, 300)
  }

  // -------------------------------------------------------------------------
  // 5) ready() 蕴含 complete
  //    getLedger 既没给 records 也没给 delta -> 不猜，ready() 必须失败，
  //    否则页面的 onShow 门就白设了：进了门却拿到残缺流水。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('d') })
    await openShop(h)
    const store = loadStore(h)
    h.rewrite = function (data, result) {
      if (data.action !== 'getLedger' || !result || !result.ledger) return result
      const copy = Object.assign({}, result)
      copy.ledger = Object.assign({}, result.ledger)
      delete copy.ledger.records
      return copy
    }
    assert.strictEqual(await store.ready(), false, '流水没取全时 ready() 必须是 false')
    assert.strictEqual(store.isReady(), false)
    await rejects(function () { return store.ensureReady() }, /没取全/)
    assert.throws(function () { store.recordsForMoney() }, /流水不完整/)
    assert.ok(h.toasts.length, 'ready() 失败要给用户一句话')
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
    assert.ok(store.recordsForMoney().some(function (item) { return item.id === record.id }))
  }

  // -------------------------------------------------------------------------
  // 1b) settleResponse 绝不抛：回写本身抛异常（畸形 delta）
  //     这条是给变异测试用的 —— 删掉 settleResponse 的 try/catch 它必挂。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('f') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '丁' })
    await store.addOpening({ customerId: customer.id, amount: 400 })

    h.rewrite = function (data, result) {
      if (!result || !result.recordDelta) return result
      // writes 不是数组：mergeRecordDelta 里的 .forEach 会直接抛 TypeError
      return Object.assign({}, result, {
        recordDelta: Object.assign({}, result.recordDelta, { writes: 7 })
      })
    }
    h.failures.getLedger = { times: 99, message: '网络抖动' }

    const record = await store.addPayment({ customerId: customer.id, amount: 40 })
    assert.ok(record && record.id, '回写抛异常也不能把已经记成的账变成记账失败')
    assert.strictEqual(takeWarns(/回写本地缓存失败/).length, 1, '回写异常要被 settleResponse 吞成 warn')
    assert.strictEqual(store.isReady(), false, '回写失败要作废 ready，下次 onShow 自愈')
    assert.throws(function () { store.recordsForMoney() }, /流水不完整/)
    // 账真的记上了（期初 1 条 + 收款 1 条；saveCustomer 不产生流水）
    assert.strictEqual(serverRecords(h).length, 2)
  }

  // -------------------------------------------------------------------------
  // 2 + 6) refillRecords 绝不抛，且客户页不许显示一个偏小的欠款
  //
  // 复审给的失败场景，逐步复现：
  //   店主进店，甲欠 1000（缓存 1 条，complete）
  //   店员在另一台设备赊了两笔各 400（店主这边不感知，服务端 3 条）
  //   店主收款 100 -> 服务端记上了，回传 count=4、writes 只有这一条
  //   合并后 2 条 != 4 -> complete=false -> 重拉，重拉撞网络抖动，按设计不抛
  //   submitPay 紧接着调 fillCustomer —— **不经过 store.ready() 的门**
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('g') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '甲' })
    await store.saveProduct({ name: '普通货', costPrice: 2, salePrice: 5, stock: 200, alertQty: 5 })
    await store.addOpening({ customerId: customer.id, amount: 1000, remark: '上线前欠款' })
    assert.strictEqual(store.recordsForMoney().length, 1)
    const productId = store.getProducts()[0].id

    // 另一台设备：赊两笔各 400
    for (let i = 0; i < 2; i += 1) {
      await serverCall(h, 'addSale', {
        customerId: customer.id,
        customerName: '甲',
        payType: 'credit',
        items: [{ productId: productId, qty: 80, unitPrice: 5 }]
      })
    }
    assert.strictEqual(serverRecords(h).length, 3, '服务端此时 3 条')

    // 收款 100：服务端记上了，客户端合并后条数对不上；重拉又撞网络抖动
    h.failures.getLedger = { times: 99, message: '网络抖动' }
    const paid = await store.addPayment({ customerId: customer.id, amount: 100 })
    assert.ok(paid && paid.id, 'refillRecords 失败不能把已经记成的账变成记账失败')
    assert.strictEqual(takeWarns(/刷新流水失败/).length, 1, '重拉失败要被 refillRecords 吞成 warn')
    assert.strictEqual(serverRecords(h).length, 4, '账真的记上了')
    assert.strictEqual(store.isReady(), false, '重拉失败要作废 ready')
    assert.throws(function () { store.recordsForMoney() }, /流水不完整/)

    // 缓存此时是残缺的 2 条：期初 1000 + 收款 100，现算欠款只有 900
    const stale = inventory.summarizeCustomerAccount(store.getRecords(), customer.id)
    assert.strictEqual(store.getRecords().length, 2, '缓存停在残缺的 2 条')
    assert.strictEqual(stale.receivable, 900, '拿残缺缓存现算就是这个偏小的数')

    // 服务端权威值（settleResponse 已经把它写进缓存）
    const account = store.getCustomer(customer.id).account
    assert.strictEqual(account.receivable, 1700)
    assert.strictEqual(account.count, 2)
    assert.strictEqual(account.amount, 800)

    // 客户页：submitPay / submitOpening 都直接调 fillCustomer，不经过 ready() 的门
    const page = mountPage(loadPage(CUSTOMER_EDIT_PATH), { id: customer.id, isEdit: true })
    page.fillCustomer(customer.id)
    assert.strictEqual(
      page.data.receivable, 1700,
      '客户页的欠款必须等于服务端权威值，绝不能显示 900'
    )
    assert.strictEqual(page.data.receivableText, '1700.00')
    assert.strictEqual(page.data.saleCount, 2)
    assert.strictEqual(page.data.saleAmountText, '800.00')
    assert.strictEqual(page.data.hasDebt, true)
    // 明细拿不到就必须标成不可用，不能装成「还没有往来记录」
    assert.strictEqual(page.data.ledgerUnavailable, true)
    assert.deepStrictEqual(page.data.ledger, [])

    // 恢复网络：下一次 onShow 走 ready() 自愈，明细回来，金额不变
    h.failures.getLedger = { times: 0 }
    assert.strictEqual(await store.ready(), true)
    assert.strictEqual(store.recordsForMoney().length, 4)
    page.fillCustomer(customer.id)
    assert.strictEqual(page.data.receivable, 1700)
    assert.strictEqual(page.data.ledgerUnavailable, false)
    assert.strictEqual(page.data.ledger.length, 4)
  }

  // -------------------------------------------------------------------------
  // 6b) 缓存完整时，客户页的三项金额必须和现算逐字段相等 ——
  //     换成服务端权威值不是换了一套口径。
  // -------------------------------------------------------------------------
  {
    const h = newHarness({ ids: idFactory('i') })
    await openShop(h)
    const store = loadStore(h)
    await store.ready()
    const customer = await store.saveCustomer({ name: '戊' })
    await store.saveProduct({ name: '普通货', costPrice: 2, salePrice: 5, stock: 200, alertQty: 5 })
    const productId = store.getProducts()[0].id
    await store.addOpening({ customerId: customer.id, amount: 120 })
    await store.addSale({
      customerId: customer.id,
      customerName: '戊',
      payType: 'credit',
      items: [{ productId: productId, qty: 10, unitPrice: 5 }]
    })
    await store.addSale({
      customerId: customer.id,
      customerName: '戊',
      payType: 'cash',
      items: [{ productId: productId, qty: 3, unitPrice: 5 }]
    })
    await store.addPayment({ customerId: customer.id, amount: 30 })

    const summary = inventory.summarizeCustomerAccount(store.recordsForMoney(), customer.id)
    const page = mountPage(loadPage(CUSTOMER_EDIT_PATH), { id: customer.id, isEdit: true })
    page.fillCustomer(customer.id)
    assert.strictEqual(page.data.receivable, summary.receivable)
    assert.strictEqual(page.data.saleCount, summary.count)
    assert.strictEqual(page.data.saleAmountText, util.money(summary.amount))
    assert.strictEqual(page.data.ledgerUnavailable, false)
    assert.strictEqual(page.data.ledger.length, summary.ledger.length)
  }

  console.log('store.test.js ok')
})().catch(function (error) {
  console.error(error)
  process.exit(1)
})
