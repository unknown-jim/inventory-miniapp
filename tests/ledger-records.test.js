// 阶段 2b-1：流水搬进 ledger_records 集合。
//
// 这个文件跑的是**完整云函数栈**（core.dispatch + MemoryDb 里的 ledger_records
// 替身），不是纯函数层。覆盖：
//   1 漂移守门员：3000 步随机记账，每步断言账本文档里的 accounts / aggregate
//     == 对集合里全部记录跑 foldAccountTerms / foldTotalTerms
//   2 四条记账不变量原样重跑
//   3 returnedQty 跨文档双向一致性
//   4 latestPurchase 取 2 条够用
//   6 bulk：clear → 记新账 → restore
//   7 getSlip 与 receivableAt 等价
// 外加：文档往返、账套隔离、迁移前写路径必须停下来、migrateLocal 分片接收端。
const assert = require('assert')
const inv = require('../utils/inventory')
const apply = require('../utils/ledger-apply')
const core = require('../cloudfunctions/ledger/ledger-core')
const recordsModule = require('../cloudfunctions/ledger/ledger-records')
const memory = require('./memory-db')

const MemoryDb = memory.MemoryDb

function idFactory(prefix) {
  let n = 0
  return function () {
    n += 1
    return (prefix || 'id') + '-' + n
  }
}

// 固定种子的伪随机：失败可复现
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng, list) {
  if (!list || !list.length) return null
  return list[Math.floor(rng() * list.length) % list.length]
}

function Shop(options) {
  options = options || {}
  this.db = new MemoryDb()
  this.ids = options.ids || idFactory('c')
  this.openid = 'user-a'
  this.clock = options.now || 1000
  this.shopId = ''
}

// 默认带 apiVersion（新客户端）。不带的那一版是 callRaw，专门给版本门用例。
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
    payload: { name: name || '测试店' },
    now: this.clock
  })
  this.shopId = res.shop.id
  return this
}

// 2b-2b：getLedger 不再回传整本流水（含未迁移的店）。
//
// 老断言的语料仍然需要「整本」，所以这里由 listRecords 翻完全本补上 ——
// 于是**分页协议进了这个文件里每一条老断言的路径**：翻页只要漏一条、重一条、
// 或者被空页的 cursor='' 冲回开头，四条记账不变量、returnedQty 双向一致性、
// getSlip 等价性会一起变红。顺带把「线上不许再出现 ledger.records」钉死。
Shop.prototype.ledger = async function () {
  const res = await this.call('getLedger', {})
  assert.strictEqual(res.ledger.records, undefined,
    'T-B2：getLedger 不许再回传整本流水')
  res.ledger.records = await this.pagedAll()
  return res.ledger
}

// listRecords 翻完全本。maxPages 只翻前几页（守门员每步用它省钱）。
Shop.prototype.pagedAll = async function (options, maxPages) {
  options = options || {}
  const limit = options.limit || recordsModule.PAGE_LIMIT
  const cap = maxPages == null ? Infinity : maxPages
  const out = []
  let cursor = ''
  for (let page = 0; page < cap; page++) {
    const res = await this.call('listRecords', {
      type: options.type || '',
      customerId: options.customerId || '',
      cursor: cursor,
      limit: limit
    })
    res.records.forEach(function (item) { out.push(item) })
    if (!res.hasMore) break
    // 空页时服务端回 ''，直接赋值会把游标冲回开头 —— 客户端那条保护也是这么写的
    cursor = res.cursor || cursor
  }
  return out
}

// 集合里这本账套的全部流水，按 sortKey 倒序。
// **不经过任何查询层**：直接读 MemoryDb 的文档袋，所以它是分页结果的独立
// 参照物（oracle），不会跟着 page() 一起错。
Shop.prototype.collectionAll = function (bookId) {
  return this.docsOfBook(bookId).slice().sort(function (a, b) {
    if (a.sortKey === b.sortKey) return 0
    return a.sortKey > b.sortKey ? -1 : 1
  }).map(apply.fromRecordDoc)
}

// 集合里这本账套的全部记录（不经过 ledgers 文档）
Shop.prototype.docsOfBook = function (bookId) {
  const db = this.db
  return Object.keys(db.records).map(function (key) {
    return db.records[key]
  }).filter(function (doc) {
    return doc.bookId === bookId
  })
}

// listRecords 翻完全本，给不走 Shop 夹具的裸 dispatch 用（老账本 / 迁移窗口）
async function pagedAllVia(callFn, options) {
  options = options || {}
  const out = []
  let cursor = ''
  for (let page = 0; page < 1000; page++) {
    const res = await callFn('listRecords', {
      type: options.type || '',
      customerId: options.customerId || '',
      cursor: cursor,
      limit: options.limit || 100
    })
    res.records.forEach(function (item) { out.push(item) })
    if (!res.hasMore) break
    cursor = res.cursor || cursor
  }
  return out
}

function rejects(fn, re) {
  return fn().then(function () {
    assert.fail('expected to reject ' + re)
  }, function (error) {
    assert.ok(re.test(error.message), 'unexpected error: ' + error.message)
  })
}

function totalStock(skus, productId) {
  return inv.productStockFromSkus(skus, productId)
}

;(async function () {
  // -------------------------------------------------------------------------
  // 0) 文档往返：toRecordDoc -> fromRecordDoc 必须逐字段回到原样，
  //    多出来的只有派生字段，而派生字段都取自不可变来源
  // -------------------------------------------------------------------------
  const sampleReturn = {
    id: 'r-1',
    type: 'return',
    amount: 12.5,
    profit: -3,
    remark: '备注',
    customerId: 'c1',
    customerName: '甲',
    customerPhone: '',
    customerAddress: '',
    payType: 'credit',
    createdAt: 1699999999999,
    lines: [{ lineId: 'l1', productId: 'p1', skuId: 's1', qty: 1, saleOrderId: 'o1', saleLineId: 'ol1' }]
  }
  const sampleDoc = apply.toRecordDoc(sampleReturn, 'book-1', 'shop-1')
  assert.strictEqual(sampleDoc._id, 'book-1_r-1')
  assert.strictEqual(sampleDoc.sortKey, '1699999999999_r-1')
  assert.strictEqual(sampleDoc.saleOrderId, 'o1', 'return 的单头 saleOrderId 提上来才能不用多键索引')
  assert.strictEqual(sampleDoc.productId, '', 'return 是多行单，单头不放商品')
  assert.deepStrictEqual(apply.fromRecordDoc(sampleDoc), sampleReturn)

  const samplePurchase = {
    id: 'in-1', type: 'in', amount: 20, profit: 0, remark: '', createdAt: 7,
    lines: [{ lineId: 'in-1', productId: 'p9', skuId: 's9', qty: 10, unitPrice: 2, costPrice: 2, amount: 20, profit: 0 }]
  }
  const purchaseDoc = apply.toRecordDoc(samplePurchase, 'book-1', 'shop-1')
  assert.strictEqual(purchaseDoc.productId, 'p9')
  assert.strictEqual(purchaseDoc.skuId, 's9')
  assert.strictEqual(purchaseDoc.sortKey, '0000000000007_in-1', 'createdAt 要补到 13 位才有字典序')
  assert.deepStrictEqual(apply.fromRecordDoc(purchaseDoc), samplePurchase)

  // 同毫秒也要有全序
  assert.ok(apply.makeSortKey(5, 'a') < apply.makeSortKey(5, 'b'))
  assert.ok(apply.makeSortKey(5, 'zzz') < apply.makeSortKey(6, 'aaa'))
  // getSlip 的后缀边界：createdAt <= at 的一律小于 pad13(at+1) + '_'
  assert.ok(apply.makeSortKey(5, 'zzzzzzzzzz') < apply.makeSortKey(6, ''))

  // -------------------------------------------------------------------------
  // 1) 漂移守门员：3000 步随机记账，每步比对增量维护的聚合和集合的全量折叠
  // -------------------------------------------------------------------------
  const rng = mulberry32(20260822)
  const shop = await new Shop({ ids: idFactory('r') }).open('随机店')

  await shop.call('saveProduct', { name: '普通货', costPrice: 2, salePrice: 5, stock: 200, alertQty: 5 })
  await shop.call('saveProduct', {
    name: '分规格货',
    costPrice: 8,
    salePrice: 20,
    colors: ['黑', '白'],
    sizes: ['M', 'L'],
    productKind: 'finished',
    skus: [
      { color: '黑', size: 'M', stock: 60, costPrice: 8, salePrice: 20 },
      { color: '黑', size: 'L', stock: 60, costPrice: 8, salePrice: 20 },
      { color: '白', size: 'M', stock: 60, costPrice: 8, salePrice: 20 },
      { color: '白', size: 'L', stock: 60, costPrice: 8, salePrice: 20 }
    ]
  })
  await shop.call('saveProduct', {
    name: '待加工货',
    costPrice: 30,
    salePrice: 99,
    blankProcess: true,
    colors: ['红', '蓝'],
    sizes: ['S', 'M'],
    productKind: 'blank',
    stock: 80,
    alertQty: 4
  })
  await shop.call('saveCustomer', { name: '客户甲' })
  await shop.call('saveCustomer', { name: '客户乙' })
  await shop.call('saveCustomer', { name: '客户丙' })

  const EXPECTED_ERRORS = /库存不足|请选择规格|规格不存在|收款不能超过当前欠款|改完后收款会超过赊账|可退数量|退货数量必须大于|销售数量必须大于|进货数量必须大于|调整数量必须大于|改规格数量必须大于|期初欠款必须大于|收款金额必须大于|请选择不同的规格|待加工库存不能改规格|请先删除退货记录|流水不存在|商品不存在|客户不存在|商品已删除|请选择客户|赊账必须选择客户|数量不能小于已退货|请填写退货数量|请先加入商品|不能改调整方向|退货请指明销售单|分规格现货没有待加工格|选择其他时请填写备注|待加工库存不存在|一次退货只能退同一张销售单|请选择原因|普通商品不用改规格|这张销售单的退货单太多/

  let ledger = await shop.ledger()
  const shopBookId = (await shop.db.getLedger(shop.shopId)).bookId
  // T-B1：客户端镜像换成「listRecords 翻完全本」。
  //
  // 2b-2b 删掉 recordDelta / mergeRecordDelta 之后，「客户端那份缓存」这个
  // 概念没有了，所以镜像的对象改成**分页协议本身**：每一步都翻前 3 页对头部，
  // 每 100 步翻一次全本。参照物 collectionAll() 直接读文档袋、不经过查询层，
  // 所以分页漏一条 / 重一条 / 空页把游标冲回开头，都会在这里当场变红。
  //
  // 成本（本机实测，末尾约 1950 条）：
  //   每步都翻全本            44 s —— 太贵，慢机器上会顶到超时
  //   前 3 页 + 每 10 步全本  10 s  ← 选这个
  //   前 3 页 + 每 25 步全本   7 s
  //   前 3 页 + 每 100 步全本  7 s（方案里给的降频档）
  // 每 10 步一次 = 300 次全本核对，比方案给的 30 次强 10 倍，而整个 npm test
  // 仍在 15 秒以内。真要再降频就改 FULL_EVERY，别去动 HEAD_PAGES ——
  // 前几页是每一步都要对的那部分。
  const HEAD_PAGES = 3
  const HEAD_LIMIT = 20
  const FULL_EVERY = 10
  let bookRecords = shop.collectionAll(shopBookId)
  let applied = 0
  let refused = 0
  const usedActions = {}

  function randomSaleItems(rng2, lists, count) {
    const items = []
    for (let i = 0; i < count; i++) {
      const product = pick(rng2, lists.products)
      if (!product) continue
      const skus = inv.skusOfProduct(lists.skus, product.id).filter(function (sku) {
        return !sku.isBlank
      })
      const item = {
        productId: product.id,
        qty: 1 + Math.floor(rng2() * 3),
        unitPrice: Math.round(rng2() * 5000) / 100
      }
      if (inv.productHasSpecs(product)) {
        const sku = pick(rng2, skus)
        if (!sku) continue
        item.skuId = sku.id
        item.color = sku.color
        item.size = sku.size
      }
      items.push(item)
    }
    return items
  }

  function nextMutation(rng2, lists) {
    const roll = rng2()
    const records = lists.records
    const customers = lists.customers
    const products = lists.products
    const product = pick(rng2, products)
    const customer = pick(rng2, customers)

    if (roll < 0.16) {
      const skus = product ? inv.skusOfProduct(lists.skus, product.id) : []
      const payload = {
        productId: product ? product.id : 'missing',
        qty: 1 + Math.floor(rng2() * 20),
        unitPrice: Math.round(rng2() * 4000) / 100
      }
      if (product && inv.productHasSpecs(product) && !inv.isBlankProcess(product)) {
        const sku = pick(rng2, skus.filter(function (item) { return !item.isBlank }))
        if (sku) payload.skuId = sku.id
      }
      return { action: 'addPurchase', payload: payload }
    }
    if (roll < 0.40) {
      const credit = rng2() < 0.5 && customer
      return {
        action: 'addSale',
        payload: {
          payType: credit ? 'credit' : 'cash',
          customerId: credit ? customer.id : (rng2() < 0.5 && customer ? customer.id : ''),
          items: randomSaleItems(rng2, lists, 1 + Math.floor(rng2() * 2))
        }
      }
    }
    if (roll < 0.52) {
      const sale = pick(rng2, records.filter(function (item) {
        return item.type === 'out' && inv.recordLines(item).some(function (line) {
          return inv.returnableQty(line) > 0
        })
      }))
      if (!sale) return null
      const line = pick(rng2, inv.recordLines(sale).filter(function (row) {
        return inv.returnableQty(row) > 0
      }))
      return {
        action: 'addReturn',
        payload: {
          items: [{
            saleOrderId: sale.id,
            saleLineId: line.lineId,
            qty: 1 + Math.floor(rng2() * inv.returnableQty(line))
          }]
        }
      }
    }
    if (roll < 0.60) {
      if (!customer) return null
      return {
        action: 'addPayment',
        payload: { customerId: customer.id, amount: Math.round(rng2() * 8000) / 100 }
      }
    }
    if (roll < 0.65) {
      if (!customer) return null
      return {
        action: 'addOpening',
        payload: { customerId: customer.id, amount: Math.round(rng2() * 6000) / 100 }
      }
    }
    if (roll < 0.70) {
      if (!product || !inv.productHasSpecs(product)) return null
      const solid = inv.skusOfProduct(lists.skus, product.id).filter(function (sku) {
        return !sku.isBlank
      })
      const from = pick(rng2, solid)
      const to = pick(rng2, solid)
      if (!from || !to || from.id === to.id) return null
      return {
        action: 'addConvert',
        payload: { productId: product.id, fromSkuId: from.id, toSkuId: to.id, qty: 1 + Math.floor(rng2() * 2) }
      }
    }
    if (roll < 0.76) {
      if (!product) return null
      const direction = rng2() < 0.5 ? 'in' : 'out'
      const reasons = inv.adjustReasons(direction === 'in' ? 'adjust_in' : 'adjust_out')
      const reason = pick(rng2, reasons.filter(function (item) { return item.value !== 'other' }))
      const payload = {
        productId: product.id,
        direction: direction,
        reason: reason.value,
        qty: 1 + Math.floor(rng2() * 3)
      }
      if (inv.productHasSpecs(product)) {
        const skus = inv.skusOfProduct(lists.skus, product.id)
        const sku = pick(rng2, inv.isBlankProcess(product) ? skus : skus.filter(function (item) {
          return !item.isBlank
        }))
        if (!sku) return null
        payload.skuId = sku.id
      }
      return { action: 'addAdjust', payload: payload }
    }
    if (roll < 0.90) {
      const record = pick(rng2, records)
      if (!record) return null
      const lines = inv.recordLines(record)
      if (record.type === 'out') {
        // 有时候换客户：换客户要从旧客户扣、往新客户加，两条余额线都得对
        const moved = rng2() < 0.35 ? pick(rng2, customers) : null
        const nextCustomer = moved ? moved.id : (record.customerId || '')
        return {
          action: 'updateRecord',
          payload: {
            id: record.id,
            payType: nextCustomer ? record.payType : 'cash',
            customerId: nextCustomer,
            items: lines.map(function (line) {
              return {
                id: line.lineId,
                qty: Math.max(inv.toNumber(line.returnedQty), 1) + Math.floor(rng2() * 3),
                unitPrice: Math.round(rng2() * 5000) / 100
              }
            })
          }
        }
      }
      if (record.type === 'in') {
        return {
          action: 'updateRecord',
          payload: { id: record.id, qty: 1 + Math.floor(rng2() * 10), unitPrice: Math.round(rng2() * 4000) / 100 }
        }
      }
      if (record.type === 'pay' || record.type === 'opening') {
        return {
          action: 'updateRecord',
          payload: { id: record.id, amount: Math.round(rng2() * 6000) / 100 }
        }
      }
      if (record.type === 'return') {
        return {
          action: 'updateRecord',
          payload: {
            id: record.id,
            items: lines.map(function (line) {
              return { id: line.lineId, qty: 1 + Math.floor(rng2() * 2) }
            })
          }
        }
      }
      if (record.type === 'convert') {
        return { action: 'updateRecord', payload: { id: record.id, qty: 1 + Math.floor(rng2() * 2) } }
      }
      return {
        action: 'updateRecord',
        payload: { id: record.id, qty: 1 + Math.floor(rng2() * 3), reason: lines[0] ? lines[0].reason : '' }
      }
    }
    if (roll < 0.98) {
      const record = pick(rng2, records)
      if (!record) return null
      return { action: 'deleteRecord', payload: { id: record.id } }
    }
    if (roll < 0.99) {
      return { action: 'saveCustomer', payload: { name: '客户' + Math.floor(rng2() * 1000) } }
    }
    const doomed = pick(rng2, customers)
    if (!doomed) return null
    // 已删客户仍留有流水：accounts 里应当仍有这个 key（刻意保留的语义）
    return { action: 'deleteCustomer', payload: { id: doomed.id } }
  }

  for (let step = 0; step < 3000; step++) {
    const plan = nextMutation(rng, Object.assign({}, ledger, { records: bookRecords }))
    if (!plan) continue
    let res = null
    try {
      res = await shop.call(plan.action, plan.payload)
      applied += 1
      usedActions[plan.action] = (usedActions[plan.action] || 0) + 1
    } catch (error) {
      refused += 1
      assert.ok(EXPECTED_ERRORS.test(error.message),
        'step ' + step + ' ' + plan.action + ' unexpected error: ' + error.message)
      continue
    }
    ledger = res.ledger
    assert.strictEqual(ledger.records, undefined,
      'step ' + step + '：记账回传不许带整本流水（带了就说明提交后又读了库）')
    // T-B3：recordDelta 已经删了。留着一个没人消费的算钱字段就是给下一个人留坑，
    // 所以这里反过来钉死「不许再出现」，而不是钉住它的形状。
    assert.strictEqual(res.recordDelta, undefined,
      'step ' + step + '：记账回传不许再带 recordDelta（2b-2b 已删，方案 C-2）')

    // 参照物：直接读文档袋，不经过查询层
    bookRecords = shop.collectionAll(ledger.bookId)

    // ★ T-B1：分页协议本身进了守门员。每步只翻前 3 页（省钱），
    //   每 FULL_EVERY 步翻一次全本（覆盖到尾页、空页 cursor、整页倍数）。
    const head = await shop.pagedAll({ limit: HEAD_LIMIT }, HEAD_PAGES)
    assert.deepStrictEqual(head, bookRecords.slice(0, head.length),
      'step ' + step + ' ' + plan.action + '：listRecords 前 ' + HEAD_PAGES + ' 页和集合对不上')
    assert.strictEqual(head.length, Math.min(HEAD_PAGES * HEAD_LIMIT, bookRecords.length),
      'step ' + step + '：前 ' + HEAD_PAGES + ' 页应该正好装满或者把全本翻完')
    if (step % FULL_EVERY === 0) {
      assert.deepStrictEqual(await shop.pagedAll({ limit: HEAD_LIMIT }), bookRecords,
        'step ' + step + ' ' + plan.action + '：listRecords 翻完全本和集合逐条对不上')
    }

    // ★ 漂移守门员：文档里增量维护出来的累加器，必须等于对全部记录的全量折叠
    assert.deepStrictEqual(ledger.accounts, inv.foldAccountTerms(bookRecords),
      'step ' + step + ' ' + plan.action + '：accounts 增量维护和全量折叠对不上')
    assert.deepStrictEqual(ledger.aggregate, inv.foldTotalTerms(bookRecords),
      'step ' + step + ' ' + plan.action + '：aggregate 增量维护和全量折叠对不上')
    assert.deepStrictEqual(ledger.totals, inv.summarizeRecords(bookRecords),
      'step ' + step + '：totals 投影对不上')
    assert.strictEqual(ledger.aggregate.count, bookRecords.length,
      'step ' + step + '：聚合条数和集合条数对不上')

    const expectedAccounts = inv.summarizeAllCustomerAccounts(bookRecords)
    ledger.customers.forEach(function (customer) {
      const want = expectedAccounts[customer.id] || {
        count: 0, amount: 0, creditAmount: 0, paidAmount: 0, receivable: 0
      }
      assert.deepStrictEqual(customer.account, want,
        'step ' + step + '：客户 ' + customer.name + ' 的落库账目和现算对不上')
    })
  }

  assert.ok(applied > 1200, '随机序列至少要真正记成一大半，实际 ' + applied)
  const coveredActions = Object.keys(usedActions)
  ;['addPurchase', 'addSale', 'addReturn', 'addPayment', 'addOpening',
    'addConvert', 'addAdjust', 'updateRecord', 'deleteRecord'].forEach(function (action) {
    assert.ok(usedActions[action] > 0, '随机序列没有覆盖 ' + action)
  })

  // 每条流水都真的在集合里，_id 和 sortKey 形状正确
  const bookId = (await shop.db.getLedger(shop.shopId)).bookId
  const docs = shop.docsOfBook(bookId)
  assert.strictEqual(docs.length, bookRecords.length)
  docs.forEach(function (doc) {
    assert.strictEqual(doc._id, bookId + '_' + doc.id)
    assert.strictEqual(doc.sortKey, apply.makeSortKey(doc.createdAt, doc.id))
    assert.strictEqual(doc.shopId, shop.shopId)
  })
  // 分页翻完全本，逐条等于集合。序列末尾**不再有任何条数上限** ——
  // COMPAT_MAX_RECORDS 那道悬崖是 2b-2b 的主要收益，它已经不存在了。
  assert.deepStrictEqual(await shop.pagedAll({ limit: HEAD_LIMIT }), bookRecords,
    'listRecords 翻完全本必须逐条等于集合')
  assert.deepStrictEqual((await shop.ledger()).records, bookRecords,
    'getLedger + 分页拼出来的必须就是集合里那一份')

  console.log('漂移守门员：3000 步跑完，记成 ' + applied + ' 笔、按业务规则拒绝 '
    + refused + ' 笔，最终 ' + bookRecords.length + ' 条流水，覆盖动作 '
    + coveredActions.length + ' 种')

  // 哨兵：带外删掉一条记录，getLedger 要报告聚合不一致而不是装作没事。
  // 下面那行 [ledger] aggregate drift 是**故意打出来的**，不是测试失败。
  console.log('（下一行的 aggregate drift 警告是哨兵测试故意触发的）')
  const victim = docs[0]
  delete shop.db.records[victim._id]
  const stale = await shop.ledger()
  assert.strictEqual(stale.aggregatesStale, true, 'countAll 和 aggregate.count 对不上时必须报告')
  shop.db.records[victim._id] = victim
  const healthy = await shop.ledger()
  assert.ok(!healthy.aggregatesStale)

  // -------------------------------------------------------------------------
  // 2) 四条记账不变量原样重跑
  // -------------------------------------------------------------------------
  const invShop = await new Shop({ ids: idFactory('v') }).open('不变量店')
  await invShop.call('saveProduct', {
    name: '卫衣',
    costPrice: 40,
    salePrice: 99,
    blankProcess: true,
    colors: ['白色', '红色'],
    sizes: ['M'],
    productKind: 'blank',
    stock: 0,
    alertQty: 1
  })
  let vLedger = await invShop.ledger()
  const hoodie = vLedger.products[0]
  await invShop.call('addPurchase', { productId: hoodie.id, qty: 10, unitPrice: 40 })
  vLedger = await invShop.ledger()
  assert.strictEqual(totalStock(vLedger.skus, hoodie.id), 10)
  assert.strictEqual(inv.findBlankSku(vLedger.skus, hoodie.id).stock, 10)

  const whiteM = inv.findSkuBySpec(vLedger.skus, hoodie.id, '白色', 'M')
  const redM = inv.findSkuBySpec(vLedger.skus, hoodie.id, '红色', 'M')
  const vSale = (await invShop.call('addSale', {
    payType: 'cash',
    items: [{ productId: hoodie.id, skuId: whiteM.id, color: '白色', size: 'M', qty: 4, unitPrice: 99 }]
  })).result.order
  vLedger = await invShop.ledger()
  // 不变量 1：件数守恒 —— 卖 4 件，总件数从 10 变 6
  assert.strictEqual(totalStock(vLedger.skus, hoodie.id), 6)
  assert.strictEqual(inv.findBlankSku(vLedger.skus, hoodie.id).stock, 6)

  await invShop.call('addReturn', {
    items: [{ saleOrderId: vSale.id, saleLineId: vSale.lines[0].lineId, qty: 1 }]
  })
  vLedger = await invShop.ledger()
  // 不变量 2：退货原样入库 —— 回到卖出时那一格（白色 M），不回待加工
  assert.strictEqual(totalStock(vLedger.skus, hoodie.id), 7)
  assert.strictEqual(inv.findSkuBySpec(vLedger.skus, hoodie.id, '白色', 'M').stock, 1)
  assert.strictEqual(inv.findBlankSku(vLedger.skus, hoodie.id).stock, 6)

  // 不变量 3：整单共享待加工 —— 两行都要同一份待加工时不能各算满一遍
  await rejects(function () {
    return invShop.call('addSale', {
      payType: 'cash',
      items: [
        { productId: hoodie.id, skuId: whiteM.id, color: '白色', size: 'M', qty: 4, unitPrice: 99 },
        { productId: hoodie.id, skuId: redM.id, color: '红色', size: 'M', qty: 4, unitPrice: 99 }
      ]
    })
  }, /库存不足/)
  const shared = (await invShop.call('addSale', {
    payType: 'cash',
    items: [
      { productId: hoodie.id, skuId: whiteM.id, color: '白色', size: 'M', qty: 4, unitPrice: 99 },
      { productId: hoodie.id, skuId: redM.id, color: '红色', size: 'M', qty: 3, unitPrice: 99 }
    ]
  })).result.order
  assert.strictEqual(shared.lines.length, 2)
  vLedger = await invShop.ledger()
  assert.strictEqual(totalStock(vLedger.skus, hoodie.id), 0)

  // 不变量 4：库存调整只改件数，不进进货 / 销售 / 毛利 / 欠款
  const beforeAdjust = vLedger.totals
  await invShop.call('addAdjust', {
    productId: hoodie.id, skuId: redM.id, direction: 'in', reason: 'surplus', qty: 5
  })
  vLedger = await invShop.ledger()
  assert.strictEqual(totalStock(vLedger.skus, hoodie.id), 5)
  assert.strictEqual(vLedger.totals.purchaseAmount, beforeAdjust.purchaseAmount)
  assert.strictEqual(vLedger.totals.salesAmount, beforeAdjust.salesAmount)
  assert.strictEqual(vLedger.totals.profit, beforeAdjust.profit)
  assert.strictEqual(vLedger.totals.receivable, beforeAdjust.receivable)
  assert.strictEqual(inv.findSkuBySpec(vLedger.skus, hoodie.id, '红色', 'M').costPrice, 40,
    '库存调整不改进价')

  // -------------------------------------------------------------------------
  // 3) returnedQty 跨文档双向一致性：加退货 / 改退货数量 / 删退货 / 删销售单
  // -------------------------------------------------------------------------
  const rqShop = await new Shop({ ids: idFactory('q') }).open('退货店')
  await rqShop.call('saveProduct', { name: '牛奶', costPrice: 2, salePrice: 5, stock: 100, alertQty: 1 })
  await rqShop.call('saveCustomer', { name: '甲' })
  let rqLedger = await rqShop.ledger()
  const milk = rqLedger.products[0]
  const rqCustomer = rqLedger.customers[0]
  const rqSale = (await rqShop.call('addSale', {
    payType: 'credit',
    customerId: rqCustomer.id,
    items: [
      { productId: milk.id, qty: 6, unitPrice: 5 },
      { productId: milk.id, qty: 4, unitPrice: 5 }
    ]
  })).result.order

  function saleOrderOf(lists) {
    return lists.records.find(function (item) {
      return item.id === rqSale.id
    })
  }

  const rqReturn = (await rqShop.call('addReturn', {
    items: [
      { saleOrderId: rqSale.id, saleLineId: rqSale.lines[0].lineId, qty: 2 },
      { saleOrderId: rqSale.id, saleLineId: rqSale.lines[1].lineId, qty: 1 }
    ]
  })).result.recordsCreated[0]
  rqLedger = await rqShop.ledger()
  assert.strictEqual(saleOrderOf(rqLedger).lines[0].returnedQty, 2, '加退货：销售行已退数量要涨')
  assert.strictEqual(saleOrderOf(rqLedger).lines[1].returnedQty, 1)
  // 退货单和被退销售单必须在同一个事务里写：两份文档都要落地
  assert.strictEqual(rqShop.docsOfBook(rqLedger.bookId).length, rqLedger.records.length)

  await rqShop.call('updateRecord', {
    id: rqReturn.id,
    items: [
      { id: rqReturn.lines[0].lineId, qty: 5 },
      { id: rqReturn.lines[1].lineId, qty: 4 }
    ]
  })
  rqLedger = await rqShop.ledger()
  assert.strictEqual(saleOrderOf(rqLedger).lines[0].returnedQty, 5, '改退货数量：已退数量要跟着改')
  assert.strictEqual(saleOrderOf(rqLedger).lines[1].returnedQty, 4)

  await rejects(function () {
    return rqShop.call('updateRecord', {
      id: rqReturn.id,
      items: [
        { id: rqReturn.lines[0].lineId, qty: 7 },
        { id: rqReturn.lines[1].lineId, qty: 4 }
      ]
    })
  }, /可退数量 6/)

  // 有退货挂着的销售单不能直接删
  await rejects(function () {
    return rqShop.call('deleteRecord', { id: rqSale.id })
  }, /请先删除退货记录/)

  await rqShop.call('deleteRecord', { id: rqReturn.id })
  rqLedger = await rqShop.ledger()
  assert.strictEqual(saleOrderOf(rqLedger).lines[0].returnedQty, 0, '删退货：已退数量要减回去')
  assert.strictEqual(saleOrderOf(rqLedger).lines[1].returnedQty, 0)
  assert.strictEqual(rqLedger.products[0].stock, 90, '删退货：库存回到只卖出 10 件时的样子')

  // 删销售单：退货清零之后才能删，删完账目和库存都归零
  await rqShop.call('deleteRecord', { id: rqSale.id })
  rqLedger = await rqShop.ledger()
  assert.strictEqual(rqLedger.records.filter(function (item) {
    return item.type === 'out'
  }).length, 0)
  assert.strictEqual(rqLedger.products[0].stock, 100)
  assert.deepStrictEqual(rqLedger.accounts, inv.foldAccountTerms(rqLedger.records))
  assert.strictEqual(rqLedger.customers[0].account.receivable, 0)

  // -------------------------------------------------------------------------
  // 3b) 退货拆分整体重算：改销售单 / 改删退货单，同单其余退货单的份额一并拨对
  // -------------------------------------------------------------------------

  // ① recordsNeeded 的形状：谁要加载 saleReturns、谁不要
  const needOutWithReturns = apply.recordsNeeded('updateRecord', { id: 'o1' }, {
    byId: { o1: { id: 'o1', type: 'out', lines: [{ lineId: 'l1', returnedQty: 1 }] } }
  })
  assert.deepStrictEqual(needOutWithReturns.saleReturns, ['o1'], '改有退货的销售单要同单退货')
  const needOutClean = apply.recordsNeeded('updateRecord', { id: 'o2' }, {
    byId: { o2: { id: 'o2', type: 'out', lines: [{ lineId: 'l1', returnedQty: 0 }] } }
  })
  assert.deepStrictEqual(needOutClean.saleReturns, [], '没退货的销售单不加载退货')
  const needReturn = apply.recordsNeeded('deleteRecord', { id: 'r9' }, {
    byId: { r9: { id: 'r9', type: 'return', lines: [{ lineId: 'x1', saleOrderId: 'o1' }] } }
  })
  assert.deepStrictEqual(needReturn.saleOrderIds, ['o1'])
  assert.deepStrictEqual(needReturn.saleReturns, ['o1'], '改/删退货单要同单全部退货')
  const needAdd = apply.recordsNeeded('addReturn', {
    items: [{ saleOrderId: 'o1', saleLineId: 'l1', qty: 1 }]
  }, null)
  assert.deepStrictEqual(needAdd.saleOrderIds, ['o1'])
  assert.deepStrictEqual(needAdd.saleReturns, [], 'addReturn 不需要 saleReturns：份额由销售行 returnedAmount 现推')

  // ② 整条链路（dispatch → MemoryDb）：部分收款销售 + 两张退货 + 改销售单金额，
  //    两张退货单的 paidAmount 都被重算，一次事务写 1 个账本文档 + 3 条记录。
  const spShop = await new Shop({ ids: idFactory('sp') }).open('拆分店')
  await spShop.call('saveProduct', { name: '拆分货', costPrice: 1, salePrice: 25, stock: 50, alertQty: 1 })
  await spShop.call('saveCustomer', { name: '拆分客户' })
  let spLists = await spShop.ledger()
  const spProduct = spLists.products[0]
  const spCustomer = spLists.customers[0]
  const spSale = (await spShop.call('addSale', {
    customerId: spCustomer.id,
    paidAmount: 40,
    items: [{ productId: spProduct.id, qty: 4, unitPrice: 25 }]
  }, 1000)).result.order
  const spRet1 = (await spShop.call('addReturn', {
    items: [{ saleOrderId: spSale.id, saleLineId: spSale.lines[0].lineId, qty: 1 }]
  }, 2000)).result.recordsCreated[0]
  const spRet2 = (await spShop.call('addReturn', {
    items: [{ saleOrderId: spSale.id, saleLineId: spSale.lines[0].lineId, qty: 2 }]
  }, 3000)).result.recordsCreated[0]
  spLists = await spShop.ledger()
  assert.strictEqual(spRet1.paidAmount, 0)
  assert.strictEqual(spRet2.paidAmount, 15, '欠款 60 冲掉先退的 25，后退的 50 里有 15 只能退现金')

  function docSnapshot(shop, bookId) {
    const out = {}
    shop.docsOfBook(bookId).forEach(function (doc) {
      out[doc._id] = JSON.stringify(doc)
    })
    return out
  }
  const spBookId = spLists.bookId
  const beforeEdit = docSnapshot(spShop, spBookId)
  const ledgerBefore = JSON.stringify(spShop.db.ledgers[spShop.shopId])
  // 改成一分不欠（40 收满 40）：D 60 → 0，两张退货单都变成纯退现金，
  // 份额 0→25、15→50 双双被重算（有一张份额没变时它会按 skip 规则不重写）。
  await spShop.call('updateRecord', {
    id: spSale.id,
    items: [{ id: spSale.lines[0].lineId, qty: 4, unitPrice: 10 }],
    paidAmount: 40,
    customerId: spCustomer.id
  }, 4000)
  spLists = await spShop.ledger()
  const retDoc = function (id) {
    return spLists.records.find(function (item) { return item.id === id })
  }
  assert.strictEqual(retDoc(spRet1.id).paidAmount, 25)
  assert.strictEqual(retDoc(spRet2.id).paidAmount, 50, '改销售单后 D=0，两张退货单都重算成纯退现金')
  assert.strictEqual(spLists.customers[0].account.receivable, 0)
  assert.deepStrictEqual(spLists.accounts, inv.foldAccountTerms(spLists.records))
  assert.strictEqual(retDoc(spSale.id).lines[0].returnedAmount, 75, '已退金额按退货单实际金额累加')
  // 一次事务的写入量：账本文档 1 个 + 记录 3 条（销售单 + 两张退货单）
  const afterEdit = docSnapshot(spShop, spBookId)
  const changedIds = Object.keys(afterEdit).filter(function (key) {
    return afterEdit[key] !== beforeEdit[key]
  })
  assert.deepStrictEqual(changedIds.sort(), [spBookId + '_' + spRet1.id, spBookId + '_' + spRet2.id, spBookId + '_' + spSale.id].sort(),
    '改销售单要连带重写两张退货单文档')
  assert.notStrictEqual(JSON.stringify(spShop.db.ledgers[spShop.shopId]), ledgerBefore,
    '账本文档（revision/聚合）也要写')

  // ③ returnedAmount 的文档往返：toRecordDoc / fromRecordDoc 后逐分不变
  const sampleSaleLine = {
    lineId: 'sl1', productId: 'p1', qty: 3, unitPrice: 7.77, costPrice: 1, amount: 23.31,
    profit: 20.31, allocations: [], returnedQty: 1.5, returnedAmount: 11.66
  }
  const sampleSaleRecord = {
    id: 's-rt', type: 'out', amount: 23.31, profit: 20.31, remark: '', customerId: 'c1',
    customerName: '甲', createdAt: 42, paidAmount: 0, lines: [sampleSaleLine]
  }
  assert.deepStrictEqual(apply.fromRecordDoc(apply.toRecordDoc(sampleSaleRecord, 'b-rt', 'sh-rt')), sampleSaleRecord,
    'returnedAmount 必须原样活过文档往返')

  // ④ returnsOfSale 升序 = 记账顺序：createdAt 乱序录入，取回按 (createdAt, id) 升序
  const roShop = await new Shop({ ids: idFactory('ro') }).open('顺序店')
  await roShop.call('saveProduct', { name: '顺序货', costPrice: 1, salePrice: 10, stock: 50, alertQty: 1 })
  const roLists = await roShop.ledger()
  const roProduct = roLists.products[0]
  const roSale = (await roShop.call('addSale', {
    payType: 'cash', customerId: '',
    items: [{ productId: roProduct.id, qty: 6, unitPrice: 10 }]
  }, 1000)).result.order
  await roShop.call('addReturn', {
    items: [{ saleOrderId: roSale.id, saleLineId: roSale.lines[0].lineId, qty: 1 }]
  }, 5000)
  await roShop.call('addReturn', {
    items: [{ saleOrderId: roSale.id, saleLineId: roSale.lines[0].lineId, qty: 1 }]
  }, 3000)
  await roShop.call('addReturn', {
    items: [{ saleOrderId: roSale.id, saleLineId: roSale.lines[0].lineId, qty: 1 }]
  }, 4000)
  const roBook = (await roShop.db.getLedger(roShop.shopId)).bookId
  const roStore = recordsModule.recordStore(roShop.db.recordsCtx(), roBook, roShop.shopId)
  const roReturns = await roStore.returnsOfSale(roSale.id)
  assert.deepStrictEqual(roReturns.map(function (item) {
    return item.createdAt
  }), [3000, 4000, 5000], 'returnsOfSale 必须按记账顺序（sortKey 升序）返回')
  assert.strictEqual((await roStore.returnsOfSale('missing')).length, 0)
  assert.strictEqual(recordsModule.SALE_RETURNS_MAX, 200)

  // -------------------------------------------------------------------------
  // 4) latestPurchase 取 2 条够用：3 条同 (productId, skuId) 进货，
  //    删中间 / 删最新 / 改最新，进价都要恢复正确
  // -------------------------------------------------------------------------
  async function threePurchases(name) {
    const s = await new Shop({ ids: idFactory(name) }).open(name)
    await s.call('saveProduct', { name: '轴', costPrice: 1, salePrice: 9, stock: 0, alertQty: 1 })
    const lists = await s.ledger()
    const p = lists.products[0]
    const a = (await s.call('addPurchase', { productId: p.id, qty: 1, unitPrice: 10 }, 1000)).result.record
    const b = (await s.call('addPurchase', { productId: p.id, qty: 1, unitPrice: 20 }, 2000)).result.record
    const c = (await s.call('addPurchase', { productId: p.id, qty: 1, unitPrice: 30 }, 3000)).result.record
    const after = await s.ledger()
    assert.strictEqual(after.products[0].costPrice, 30, '最新一条进货定进价')
    return { shop: s, productId: p.id, a: a, b: b, c: c }
  }

  const lpMid = await threePurchases('lp-mid')
  await lpMid.shop.call('deleteRecord', { id: lpMid.b.id })
  assert.strictEqual((await lpMid.shop.ledger()).products[0].costPrice, 30,
    '删中间那条，进价仍是最新那条的 30')

  const lpNew = await threePurchases('lp-new')
  await lpNew.shop.call('deleteRecord', { id: lpNew.c.id })
  assert.strictEqual((await lpNew.shop.ledger()).products[0].costPrice, 20,
    '删最新那条，进价回落到第二新的 20')

  const lpEdit = await threePurchases('lp-edit')
  await lpEdit.shop.call('updateRecord', { id: lpEdit.c.id, qty: 1, unitPrice: 77 })
  assert.strictEqual((await lpEdit.shop.ledger()).products[0].costPrice, 77,
    '改最新那条，进价跟着改')

  // 删到只剩一条，再删完
  const lpAll = await threePurchases('lp-all')
  await lpAll.shop.call('deleteRecord', { id: lpAll.c.id })
  await lpAll.shop.call('deleteRecord', { id: lpAll.b.id })
  assert.strictEqual((await lpAll.shop.ledger()).products[0].costPrice, 10)
  await lpAll.shop.call('deleteRecord', { id: lpAll.a.id })
  assert.strictEqual((await lpAll.shop.ledger()).products[0].costPrice, 10,
    '一条进货都不剩时保留最后的进价，与 2a 行为一致')

  // -------------------------------------------------------------------------
  // 5) 欠款上限：applyPayment / updateRecord 的 pay 分支现在拿账本里的累加器算
  //    上限（不再扫全量流水），这条线错了会静默多收钱，所以逐条钉死
  // -------------------------------------------------------------------------
  const capShop = await new Shop({ ids: idFactory('cap') }).open('欠款店')
  await capShop.call('saveProduct', { name: '糖', costPrice: 1, salePrice: 4, stock: 100, alertQty: 1 })
  await capShop.call('saveCustomer', { name: '欠款客户' })
  let capLists = await capShop.ledger()
  const candy = capLists.products[0]
  const capCustomer = capLists.customers[0]
  await capShop.call('addSale', {
    payType: 'credit', customerId: capCustomer.id,
    items: [{ productId: candy.id, qty: 10, unitPrice: 4 }]
  })
  capLists = await capShop.ledger()
  assert.strictEqual(capLists.customers[0].account.receivable, 40)

  await rejects(function () {
    return capShop.call('addPayment', { customerId: capCustomer.id, amount: 40.01 })
  }, /收款不能超过当前欠款 40/)
  const capPay = (await capShop.call('addPayment', { customerId: capCustomer.id, amount: 40 })).result.record
  capLists = await capShop.ledger()
  assert.strictEqual(capLists.customers[0].account.receivable, 0, '收满之后欠款精确归零')
  assert.deepStrictEqual(capLists.accounts, inv.foldAccountTerms(capLists.records))

  // 收满之后再收一分钱都不行
  await rejects(function () {
    return capShop.call('addPayment', { customerId: capCustomer.id, amount: 0.01 })
  }, /收款不能超过当前欠款 0/)

  // 改这条收款单：上限是「除本条之外的欠款」= 当前欠款 + 本条金额
  await rejects(function () {
    return capShop.call('updateRecord', { id: capPay.id, amount: 40.01 })
  }, /收款不能超过当前欠款 40/)
  await capShop.call('updateRecord', { id: capPay.id, amount: 25 })
  capLists = await capShop.ledger()
  assert.strictEqual(capLists.customers[0].account.receivable, 15)
  assert.deepStrictEqual(capLists.accounts, inv.foldAccountTerms(capLists.records))

  // 删掉赊账销售单会让收款超过赊账，必须拦住（assertAccountsValid 走 ctx.accounts）
  const capSale = capLists.records.find(function (item) {
    return item.type === 'out'
  })
  await rejects(function () {
    return capShop.call('deleteRecord', { id: capSale.id })
  }, /改完后收款会超过赊账/)
  // 把销售单改小到低于已收也要拦住
  await rejects(function () {
    return capShop.call('updateRecord', {
      id: capSale.id,
      payType: 'credit',
      customerId: capCustomer.id,
      items: [{ id: capSale.lines[0].lineId, qty: 5, unitPrice: 4 }]
    })
  }, /改完后收款会超过赊账/)
  // 把销售单从赊账改成现金同样会让欠款变负
  await rejects(function () {
    return capShop.call('updateRecord', {
      id: capSale.id,
      payType: 'cash',
      customerId: capCustomer.id,
      items: [{ id: capSale.lines[0].lineId, qty: 10, unitPrice: 4 }]
    })
  }, /改完后收款会超过赊账/)
  // 拦住之后账目一点没动
  const capAfter = await capShop.ledger()
  assert.strictEqual(capAfter.customers[0].account.receivable, 15)
  assert.deepStrictEqual(capAfter.accounts, inv.foldAccountTerms(capAfter.records))
  assert.strictEqual(capAfter.records.length, capLists.records.length)

  // 退货把赊账退到低于已收也要拦住
  await rejects(function () {
    return capShop.call('addReturn', {
      items: [{ saleOrderId: capSale.id, saleLineId: capSale.lines[0].lineId, qty: 10 }]
    })
  }, /改完后收款会超过赊账/)

  // -------------------------------------------------------------------------
  // 6) bulk：clear → 记新账 → restore，账目和库存都要回到 clear 之前
  // -------------------------------------------------------------------------
  const bulkShop = await new Shop({ ids: idFactory('b') }).open('清空店')
  await bulkShop.call('saveProduct', { name: '面包', costPrice: 5, salePrice: 10, stock: 50, alertQty: 1 })
  await bulkShop.call('saveCustomer', { name: '老客户' })
  let bulk = await bulkShop.ledger()
  const bread = bulk.products[0]
  const oldCustomer = bulk.customers[0]
  await bulkShop.call('addSale', {
    payType: 'credit', customerId: oldCustomer.id,
    items: [{ productId: bread.id, qty: 5, unitPrice: 10 }]
  })
  await bulkShop.call('addPayment', { customerId: oldCustomer.id, amount: 20 })
  bulk = await bulkShop.ledger()
  const beforeClear = {
    totals: bulk.totals,
    accounts: bulk.accounts,
    recordIds: bulk.records.map(function (item) { return item.id }).sort(),
    stock: bulk.products[0].stock,
    bookId: bulk.bookId
  }
  assert.strictEqual(beforeClear.totals.receivable, 30)

  const clearedDocCount = bulkShop.docsOfBook(beforeClear.bookId).length
  await bulkShop.call('clearAll', {})
  const cleared = await bulkShop.ledger()
  assert.strictEqual(cleared.records.length, 0, '清空后当前账套没有流水')
  assert.strictEqual(cleared.products.length, 0)
  assert.strictEqual(cleared.customers.length, 0)
  assert.strictEqual(cleared.totals.receivable, 0)
  assert.deepStrictEqual(cleared.accounts, {})
  assert.notStrictEqual(cleared.bookId, beforeClear.bookId, '清空 = 换账套')
  assert.strictEqual(bulkShop.docsOfBook(beforeClear.bookId).length, clearedDocCount,
    '老账套的流水一条都不该被删或复制')
  const clearSnapshotDoc = Object.keys(bulkShop.db.clears).map(function (key) {
    return bulkShop.db.clears[key]
  })[0]
  assert.ok(!clearSnapshotDoc.records, '快照只装四张有界的表 + 聚合，不再复制整份流水')
  assert.strictEqual(clearSnapshotDoc.bookId, beforeClear.bookId)

  // 清空之后记新账，不能串到老账套里
  await bulkShop.call('saveProduct', { name: '清空后新货', costPrice: 1, salePrice: 2, stock: 9, alertQty: 1 })
  await bulkShop.call('saveCustomer', { name: '新客户' })
  let fresh = await bulkShop.ledger()
  await bulkShop.call('addSale', {
    payType: 'credit', customerId: fresh.customers[0].id,
    items: [{ productId: fresh.products[0].id, qty: 2, unitPrice: 2 }]
  })
  fresh = await bulkShop.ledger()
  assert.strictEqual(fresh.records.length, 1, '新账套只看得见新账')
  assert.strictEqual(fresh.totals.receivable, 4)
  assert.deepStrictEqual(fresh.accounts, inv.foldAccountTerms(fresh.records))

  await bulkShop.call('restoreCleared', {})
  const restored = await bulkShop.ledger()
  assert.strictEqual(restored.bookId, beforeClear.bookId, '恢复 = 指针指回去')
  assert.deepStrictEqual(restored.totals, beforeClear.totals)
  assert.deepStrictEqual(restored.accounts, beforeClear.accounts)
  assert.deepStrictEqual(restored.records.map(function (item) {
    return item.id
  }).sort(), beforeClear.recordIds)
  assert.strictEqual(restored.products[0].stock, beforeClear.stock)
  assert.strictEqual(restored.customers[0].id, oldCustomer.id)
  // 恢复出来的聚合仍要和流水对得上（封存的账套此后不变，所以直接取回是对的）
  assert.deepStrictEqual(restored.accounts, inv.foldAccountTerms(restored.records))
  assert.deepStrictEqual(restored.aggregate, inv.foldTotalTerms(restored.records))
  assert.strictEqual(restored.hasClearedBackup, false)

  // 恢复之后继续记账仍然落在恢复回来的那本账套里
  await bulkShop.call('addPayment', { customerId: oldCustomer.id, amount: 10 })
  const afterRestore = await bulkShop.ledger()
  assert.strictEqual(afterRestore.totals.receivable, 20)
  assert.deepStrictEqual(afterRestore.accounts, inv.foldAccountTerms(afterRestore.records))

  // -------------------------------------------------------------------------
  // 7) getSlip 与 receivableAt 等价（含同毫秒、散客、改删更早的记录之后）
  // -------------------------------------------------------------------------
  const slipShop = await new Shop({ ids: idFactory('s') }).open('送货单店')
  await slipShop.call('saveProduct', { name: '米', costPrice: 3, salePrice: 5, stock: 10000, alertQty: 1 })
  await slipShop.call('saveCustomer', { name: '甲' })
  await slipShop.call('saveCustomer', { name: '乙' })
  let slipLists = await slipShop.ledger()
  const rice = slipLists.products[0]
  const slipA = slipLists.customers.find(function (item) { return item.name === '甲' })
  const slipB = slipLists.customers.find(function (item) { return item.name === '乙' })

  // 同毫秒也要能分出先后（sortKey 靠 id 拿到全序）
  await slipShop.call('addSale', {
    payType: 'credit', customerId: slipA.id,
    items: [{ productId: rice.id, qty: 20, unitPrice: 5 }]
  }, 1000)
  await slipShop.call('addSale', {
    payType: 'credit', customerId: slipA.id,
    items: [{ productId: rice.id, qty: 10, unitPrice: 5 }]
  }, 1000)
  await slipShop.call('addPayment', { customerId: slipA.id, amount: 30 }, 1500)
  await slipShop.call('addSale', {
    payType: 'credit', customerId: slipA.id,
    items: [{ productId: rice.id, qty: 4, unitPrice: 5 }]
  }, 2000)
  await slipShop.call('addSale', {
    payType: 'cash', customerId: '',
    items: [{ productId: rice.id, qty: 1, unitPrice: 5 }]
  }, 2500)
  await slipShop.call('addOpening', { customerId: slipB.id, amount: 88 }, 2600)

  async function assertSlipsMatch(label) {
    const lists = await slipShop.ledger()
    for (let i = 0; i < lists.records.length; i++) {
      const record = lists.records[i]
      const res = await slipShop.call('getSlip', { recordId: record.id })
      const expected = record.customerId
        ? inv.receivableAt(lists.records, record.customerId, record.createdAt)
        : 0
      assert.strictEqual(res.receivable, expected,
        label + '：流水 ' + record.id + '（' + record.type + '）的送货单欠款和 receivableAt 对不上')
      assert.strictEqual(res.record.id, record.id)
    }
    return lists
  }

  let slipState = await assertSlipsMatch('初始')
  // 同毫秒：receivableAt 的口径是 createdAt <= at（含同毫秒的同伴），
  // 后缀是 sortKey >= pad13(at + 1)，两者严格互补 —— 所以同毫秒的两张单
  // **必须**算出同一个欠款，而且必须等于 receivableAt。这不是巧合，是口径定义。
  const sameMs = slipState.records.filter(function (item) {
    return item.type === 'out' && item.createdAt === 1000
  })
  assert.strictEqual(sameMs.length, 2)
  const sameMsSlips = []
  for (let i = 0; i < sameMs.length; i++) {
    sameMsSlips.push((await slipShop.call('getSlip', { recordId: sameMs[i].id })).receivable)
  }
  assert.strictEqual(sameMsSlips[0], sameMsSlips[1])
  assert.strictEqual(sameMsSlips[0], inv.receivableAt(slipState.records, slipA.id, 1000))
  // 但两条记录在集合里仍然有全序，不会互相盖掉
  assert.notStrictEqual(
    apply.makeSortKey(sameMs[0].createdAt, sameMs[0].id),
    apply.makeSortKey(sameMs[1].createdAt, sameMs[1].id)
  )
  assert.strictEqual(new Set(slipState.records.map(function (item) {
    return apply.makeSortKey(item.createdAt, item.id)
  })).size, slipState.records.length, 'sortKey 必须是全序，同毫秒也不能撞')

  // 改更早的收款单
  const earlyPay = slipState.records.find(function (item) {
    return item.type === 'pay'
  })
  await slipShop.call('updateRecord', { id: earlyPay.id, amount: 60 })
  slipState = await assertSlipsMatch('改更早的收款单之后')

  // 删更早的销售单
  const earliestSale = slipState.records.filter(function (item) {
    return item.type === 'out' && item.customerId === slipA.id
  }).sort(function (a, b) {
    return a.createdAt - b.createdAt
  })[0]
  await slipShop.call('deleteRecord', { id: earliestSale.id })
  await assertSlipsMatch('删更早的销售单之后')

  await rejects(function () {
    return slipShop.call('getSlip', { recordId: 'nope' })
  }, /流水不存在/)

  // -------------------------------------------------------------------------
  // 8) 账套隔离和多店隔离：_id 带 bookId 前缀，撞号也不会跨租户覆盖
  // -------------------------------------------------------------------------
  const twoShopDb = new MemoryDb()
  const sharedIds = (function () {
    let n = 0
    return function () {
      n += 1
      return 'same-' + n
    }
  })()
  async function callOn(openid, action, shopId, payload, now) {
    return core.dispatch({
      db: twoShopDb, makeId: sharedIds, openid: openid, action: action,
      shopId: shopId, apiVersion: core.API_VERSION,
      payload: payload || {}, now: now || 1000
    })
  }
  const s1 = (await callOn('u1', 'createShop', '', { name: '一店' })).shop.id
  const s2 = (await callOn('u2', 'createShop', '', { name: '二店' })).shop.id
  await callOn('u1', 'saveProduct', s1, { name: '货一', costPrice: 1, salePrice: 2, stock: 10 })
  await callOn('u2', 'saveProduct', s2, { name: '货二', costPrice: 1, salePrice: 2, stock: 10 })
  const p1 = (await callOn('u1', 'getLedger', s1)).ledger.products[0]
  const p2 = (await callOn('u2', 'getLedger', s2)).ledger.products[0]
  await callOn('u1', 'addSale', s1, { payType: 'cash', items: [{ productId: p1.id, qty: 1, unitPrice: 2 }] })
  await callOn('u2', 'addSale', s2, { payType: 'cash', items: [{ productId: p2.id, qty: 1, unitPrice: 2 }] })
  const r1 = (await callOn('u1', 'listRecords', s1, { limit: 100 })).records
  const r2 = (await callOn('u2', 'listRecords', s2, { limit: 100 })).records
  assert.strictEqual(r1.length, 1)
  assert.strictEqual(r2.length, 1)
  assert.strictEqual(Object.keys(twoShopDb.records).length, 2, '两店各一条，_id 不能撞')
  assert.notStrictEqual(r1[0].lines[0].productName, r2[0].lines[0].productName)

  // -------------------------------------------------------------------------
  // 9) 迁移前的老账本：读得到，但写路径必须停下来报错
  // -------------------------------------------------------------------------
  const legacyDb = new MemoryDb()
  const legacyIds = idFactory('lg')
  const legacyShopId = (await core.dispatch({
    db: legacyDb, makeId: legacyIds, openid: 'u1', action: 'createShop',
    shopId: '', apiVersion: core.API_VERSION, payload: { name: '老账本店' }, now: 1000
  })).shop.id
  legacyDb.ledgers[legacyShopId] = Object.assign({}, legacyDb.ledgers[legacyShopId], {
    recordsMigratedAt: 0,
    products: [{ id: 'p1', name: '牛奶', costPrice: 2, salePrice: 5, stock: 10, alertQty: 5, colors: [], sizes: [] }],
    customers: [{ id: 'c1', name: '甲店' }],
    records: [
      { id: 'l2', type: 'out', orderId: 'ord1', productId: 'p1', productName: '牛奶', qty: 1, unitPrice: 5, costPrice: 2, amount: 5, profit: 3, payType: 'credit', customerId: 'c1', customerName: '甲店', createdAt: 2000 },
      { id: 'l1', type: 'out', orderId: 'ord1', productId: 'p1', productName: '牛奶', qty: 2, unitPrice: 5, costPrice: 2, amount: 10, profit: 6, payType: 'credit', customerId: 'c1', customerName: '甲店', createdAt: 2000 }
    ]
  })
  async function legacyCall(action, payload) {
    return core.dispatch({
      db: legacyDb, makeId: legacyIds, openid: 'u1', action: action,
      shopId: legacyShopId, apiVersion: core.API_VERSION,
      payload: payload || {}, now: 5000
    })
  }
  const legacyRead = (await legacyCall('getLedger')).ledger
  assert.strictEqual(legacyRead.recordsPendingMigration, true)
  // T-B2：未迁移的店也不再回传整本流水，流水一律走 listRecords（方案 Q1：
  // 线上只存在一种线协议形态）
  assert.strictEqual(legacyRead.records, undefined,
    'T-B2：未迁移的店 getLedger 也不许回传整本流水')
  const legacyPaged = await pagedAllVia(legacyCall)
  assert.strictEqual(legacyPaged.length, 1, '老的按行流水读时归并成一单一条')
  assert.strictEqual(legacyPaged[0].lines.length, 2)
  const legacySlip = await legacyCall('getSlip', { recordId: 'ord1' })
  assert.strictEqual(legacySlip.receivable, 15, '没搬完的账本 getSlip 走老口径')
  await rejects(function () {
    return legacyCall('addSale', { payType: 'cash', items: [{ productId: 'p1', qty: 1, unitPrice: 5 }] })
  }, /还没完成流水升级/)
  await rejects(function () {
    return legacyCall('clearAll', {})
  }, /还没完成流水升级/)

  // 切开关之后（下一趟的 migrateRecords 会这么写）：老数组**故意留着**当回滚路，
  // 记账不能把它和 recordsMigratedAt 抹掉，否则 O(1) 回滚就没了。
  const keptRecords = legacyDb.ledgers[legacyShopId].records
  legacyDb.ledgers[legacyShopId] = Object.assign({}, legacyDb.ledgers[legacyShopId], {
    recordsMigratedAt: 4000,
    accounts: {},
    aggregate: inv.emptyTerms()
  })
  await legacyCall('addPurchase', { productId: 'p1', qty: 3, unitPrice: 2 })
  const switched = legacyDb.ledgers[legacyShopId]
  assert.strictEqual(switched.recordsMigratedAt, 4000, 'recordsMigratedAt 必须活过每一次记账')
  assert.deepStrictEqual(switched.records, keptRecords, '老数组是回滚路，记账不能抹掉它')
  const switchedRead = (await legacyCall('getLedger')).ledger
  assert.ok(!switchedRead.recordsPendingMigration)
  const switchedPaged = await pagedAllVia(legacyCall)
  assert.strictEqual(switchedPaged.length, 1, '切开关之后只读集合，读不到老数组')
  assert.strictEqual(switchedPaged[0].type, 'in')

  // 清回老路径：清掉 recordsMigratedAt，读写立刻退回老数组，用户无感
  legacyDb.ledgers[legacyShopId] = Object.assign({}, switched, { recordsMigratedAt: 0 })
  const rolledBack = (await legacyCall('getLedger')).ledger
  assert.strictEqual(rolledBack.recordsPendingMigration, true)
  const rolledBackPaged = await pagedAllVia(legacyCall)
  assert.strictEqual(rolledBackPaged.length, 1)
  assert.strictEqual(rolledBackPaged[0].id, 'ord1', '回滚之后看到的是迁移前那张单')

  // -------------------------------------------------------------------------
  // 10) migrateLocal 分片接收端：切换是最后一片的一次原子写
  // -------------------------------------------------------------------------
  const localSource = new MemoryBookSource()
  const impShop = await new Shop({ ids: idFactory('m') }).open('导入店')
  const impRecords = localSource.records
  const firstShard = await impShop.call('migrateLocal', {
    token: 'tok-1',
    seq: 0,
    ledger: localSource.lists,
    records: impRecords.slice(0, 2)
  })
  assert.ok(!firstShard.ledger, '还没收完不给账本')
  assert.strictEqual(firstShard.importing.nextSeq, 1)
  const midway = await impShop.ledger()
  assert.strictEqual(midway.records.length, 0, '切换之前店里完全看不见半成品')
  assert.strictEqual(midway.products.length, 0)

  // 重发同一片：幂等跳过，聚合不能重复加
  const replayShard = await impShop.call('migrateLocal', {
    token: 'tok-1', seq: 0, ledger: localSource.lists, records: impRecords.slice(0, 2)
  })
  assert.strictEqual(replayShard.skipped, true)
  assert.strictEqual(replayShard.importing.nextSeq, 1)

  await rejects(function () {
    return impShop.call('migrateLocal', {
      token: 'tok-1', seq: 5, records: impRecords.slice(2)
    })
  }, /分片顺序不对/)

  const done = await impShop.call('migrateLocal', {
    token: 'tok-1', seq: 1, final: true, records: impRecords.slice(2)
  })
  assert.ok(done.ledger)
  assert.strictEqual(done.ledger.records, undefined, '分片回传也不带整本流水')
  assert.strictEqual(done.recordDelta, undefined, 'T-B3：分片回传也不许再带 recordDelta')
  const imported = await impShop.ledger()
  assert.strictEqual(imported.records.length, impRecords.length)
  assert.deepStrictEqual(imported.accounts, inv.foldAccountTerms(imported.records),
    '分片导入攒出来的聚合要等于全量折叠')
  assert.deepStrictEqual(imported.aggregate, inv.foldTotalTerms(imported.records))
  assert.strictEqual(imported.products.length, localSource.lists.products.length)
  await rejects(function () {
    return impShop.call('migrateLocal', { ledger: localSource.lists, records: impRecords })
  }, /云上已有账本/)

  // 老客户端的一次性上传仍然能用（2b-1 的小程序还是这么调）
  const oneShot = await new Shop({ ids: idFactory('o') }).open('一次性导入店')
  const oneShotRes = await oneShot.call('migrateLocal', {
    ledger: Object.assign({}, localSource.lists, { records: impRecords })
  })
  assert.strictEqual(oneShotRes.ledger.records, undefined)
  assert.strictEqual(oneShotRes.recordDelta, undefined, 'T-B3：一次性上传也不许再带 recordDelta')
  // 迁完之后要看流水就分页取，不靠回传
  const oneShotPaged = await oneShot.pagedAll()
  assert.strictEqual(oneShotPaged.length, impRecords.length)
  assert.deepStrictEqual(oneShotRes.ledger.accounts, inv.foldAccountTerms(oneShotPaged))

  // 分片上传不许把退货单和它的销售单切到两片里：切开之后退货行的 saleOrderId
  // 是空的，可退上限从此没有着落（审计阻塞 2 的两条现实路径之一）
  const splitShop = await new Shop({ ids: idFactory('sp') }).open('切坏片店')
  const legacyPair = [
    { id: 'ls1', type: 'out', orderId: 'ls1', productId: 'lp1', productName: '本机货', qty: 5, unitPrice: 6, costPrice: 3, amount: 30, profit: 15, payType: 'cash', createdAt: 300 },
    { id: 'lr1', type: 'return', saleRecordId: 'ls1', productId: 'lp1', productName: '本机货', qty: 1, unitPrice: 6, costPrice: 3, amount: 6, profit: -3, payType: 'cash', createdAt: 400 }
  ]
  await splitShop.call('migrateLocal', {
    token: 'tok-split', seq: 0, ledger: localSource.lists, records: [legacyPair[0]]
  })
  await rejects(function () {
    return splitShop.call('migrateLocal', {
      token: 'tok-split', seq: 1, final: true, records: [legacyPair[1]]
    })
  }, /退货单和它的销售单必须在同一片里上传/)
  // 同一片里就没问题
  const pairedShop = await new Shop({ ids: idFactory('pr') }).open('同片店')
  const pairedRes = await pairedShop.call('migrateLocal', {
    token: 'tok-paired', seq: 0, final: true, ledger: localSource.lists, records: legacyPair
  })
  assert.ok(pairedRes.ledger)
  const pairedRecords = (await pairedShop.ledger()).records
  const pairedReturn = pairedRecords.find(function (item) { return item.type === 'return' })
  assert.strictEqual(pairedReturn.lines[0].saleOrderId, 'ls1', '同片里 backfill 补得上 saleOrderId')

  // -------------------------------------------------------------------------
  // 11) recordStore 的查询层：分页游标、按类型 / 按客户过滤、count。
  //     这几条查询各自对应索引清单里的一条，走的是和云上同一份代码。
  // -------------------------------------------------------------------------
  const qLedger = await slipShop.ledger()
  const qStore = recordsModule.recordStore(slipShop.db.recordsCtx(), qLedger.bookId, slipShop.shopId)
  assert.strictEqual(await qStore.countAll(), qLedger.records.length)

  // 2b-2b：readAll 已经删了，「整本」现在只有一个来源 —— 分页翻完。
  const allDesc = qLedger.records
  assert.deepStrictEqual(
    allDesc.map(function (item) { return item.id }),
    slipShop.collectionAll(qLedger.bookId).map(function (item) { return item.id }),
    '分页翻完的顺序就是集合按 sortKey 倒序的顺序'
  )
  for (let i = 1; i < allDesc.length; i++) {
    const prev = apply.makeSortKey(allDesc[i - 1].createdAt, allDesc[i - 1].id)
    const cur = apply.makeSortKey(allDesc[i].createdAt, allDesc[i].id)
    assert.ok(prev > cur, '分页翻完必须按 sortKey 严格倒序')
  }

  // 分页游标：一页两条翻完，和一次读完逐条相同，不重不漏
  const paged = []
  let pageCursor = ''
  for (let i = 0; i < 50; i++) {
    const got = await qStore.page({ cursor: pageCursor, limit: 2 })
    got.records.forEach(function (item) { paged.push(item.id) })
    if (!got.hasMore) break
    pageCursor = got.cursor
  }
  assert.deepStrictEqual(paged, allDesc.map(function (item) { return item.id }))

  // 按类型（索引 3）
  const outPage = await qStore.page({ type: 'out', limit: 100 })
  assert.deepStrictEqual(
    outPage.records.map(function (item) { return item.id }).sort(),
    allDesc.filter(function (item) { return item.type === 'out' })
      .map(function (item) { return item.id }).sort()
  )
  // 按客户（索引 2）：散客单不能混进来
  const custPage = await qStore.page({ customerId: slipA.id, limit: 100 })
  assert.ok(custPage.records.length > 0)
  custPage.records.forEach(function (item) {
    assert.strictEqual(item.customerId, slipA.id)
  })
  assert.strictEqual(custPage.records.length, allDesc.filter(function (item) {
    return item.customerId === slipA.id
  }).length)

  // 「调整」筛选走 _.in（索引 3）：这条查询在云上要实测能不能吃索引，
  // 退路是加 typeGroup 派生字段 —— 语义先在这里钉住
  await slipShop.call('addAdjust', {
    productId: rice.id, direction: 'in', reason: 'surplus', qty: 3
  }, 4000)
  await slipShop.call('addAdjust', {
    productId: rice.id, direction: 'out', reason: 'damage', qty: 1
  }, 4100)
  const adjustStore = recordsModule.recordStore(
    slipShop.db.recordsCtx(), (await slipShop.ledger()).bookId, slipShop.shopId
  )
  const adjustPage = await adjustStore.page({ type: 'adjust', limit: 100 })
  assert.strictEqual(adjustPage.records.length, 2)
  adjustPage.records.forEach(function (item) {
    assert.ok(item.type === 'adjust_in' || item.type === 'adjust_out')
  })

  // latestPurchases 只认同一 (productId, skuId)，且严格取最新两条
  const lpStore = recordsModule.recordStore(
    lpMid.shop.db.recordsCtx(),
    (await lpMid.shop.ledger()).bookId,
    lpMid.shop.shopId
  )
  const lpTop = await lpStore.latestPurchases(lpMid.productId, '')
  assert.strictEqual(lpTop.length, 2)
  assert.ok(lpTop[0].createdAt > lpTop[1].createdAt)

  // -------------------------------------------------------------------------
  // 12) 结构断言：**事务提交之后一次都不许读集合**（审计阻塞 3）
  //
  //     事务内走 tx.recordsCtx()，事务外走 MemoryDb.prototype.recordsCtx ——
  //     是两个不同的方法，所以「事务外一次都没读」可以被精确断言。
  //     这条用例在修复前必挂：老实现的记账返回是「事务提交之后再 await 一次读库」。
  // -------------------------------------------------------------------------
  const noReadShop = await new Shop({ ids: idFactory('nr') }).open('提交后不读库店')
  await noReadShop.call('saveProduct', { name: '普通货', costPrice: 2, salePrice: 10, stock: 200, alertQty: 1 })
  await noReadShop.call('saveProduct', {
    name: '分规格货', costPrice: 8, salePrice: 20,
    colors: ['黑', '白'], sizes: ['M'], productKind: 'finished',
    skus: [
      { color: '黑', size: 'M', stock: 30, costPrice: 8, salePrice: 20 },
      { color: '白', size: 'M', stock: 30, costPrice: 8, salePrice: 20 }
    ]
  })
  await noReadShop.call('saveCustomer', { name: '甲' })
  const nrLists = await noReadShop.ledger()
  const nrPlain = nrLists.products.find(function (item) { return item.name === '普通货' })
  const nrSpec = nrLists.products.find(function (item) { return item.name === '分规格货' })
  const nrSkus = inv.skusOfProduct(nrLists.skus, nrSpec.id).filter(function (s) { return !s.isBlank })
  const nrCustomer = nrLists.customers[0]

  const realRecordsCtx = noReadShop.db.recordsCtx
  let outsideReads = 0
  noReadShop.db.recordsCtx = function () {
    outsideReads += 1
    throw new Error('事务提交之后不该再读集合')
  }

  // 每一步都要成功，且回传形状是「四张表 + 聚合投影，流水一条都没有」。
  // T-B3：recordDelta 也不许再出现 —— 分页之后零消费者。
  async function noReadStep(action, payload) {
    const res = await noReadShop.call(action, payload)
    assert.strictEqual(res.ledger.records, undefined, action + ' 的回传不该带整本流水')
    assert.strictEqual(res.recordDelta, undefined, action + ' 的回传不该再带 recordDelta')
    assert.ok(res.ledger.aggregate, action + ' 的回传必须带聚合投影')
    return res
  }

  const nrPurchase = (await noReadStep('addPurchase', {
    productId: nrPlain.id, qty: 10, unitPrice: 2
  })).result.record
  const nrOrder = (await noReadStep('addSale', {
    payType: 'credit', customerId: nrCustomer.id,
    items: [{ productId: nrPlain.id, qty: 5, unitPrice: 10 }]
  })).result.order
  await noReadStep('addReturn', {
    items: [{ saleOrderId: nrOrder.id, saleLineId: nrOrder.lines[0].lineId, qty: 1 }]
  })
  await noReadStep('addConvert', {
    productId: nrSpec.id, fromSkuId: nrSkus[0].id, toSkuId: nrSkus[1].id, qty: 1
  })
  const nrAdjust = (await noReadStep('addAdjust', {
    productId: nrPlain.id, direction: 'in', reason: 'surplus', qty: 2
  })).result.record
  await noReadStep('addPayment', { customerId: nrCustomer.id, amount: 1 })
  await noReadStep('addOpening', { customerId: nrCustomer.id, amount: 5 })
  await noReadStep('updateRecord', { id: nrPurchase.id, qty: 11, unitPrice: 2 })
  await noReadStep('deleteRecord', { id: nrAdjust.id })
  const nrDoomedProduct = (await noReadStep('saveProduct', {
    name: '待删货', costPrice: 1, salePrice: 2, stock: 3, alertQty: 1
  })).result.product
  const nrDoomedCustomer = (await noReadStep('saveCustomer', { name: '乙' })).result.customer
  await noReadStep('deleteCustomer', { id: nrDoomedCustomer.id })
  const nrCategory = (await noReadStep('saveCategory', { name: '种类甲' })).result.category
  await noReadStep('appendCategoryValue', { id: nrCategory.id, field: 'names', value: '短袖' })
  await noReadStep('deleteCategory', { id: nrCategory.id })
  await noReadStep('deleteProduct', { id: nrDoomedProduct.id })
  await noReadStep('loadSeed', {})
  await noReadStep('clearAll', {})
  await noReadStep('restoreCleared', {})

  assert.strictEqual(outsideReads, 0, '记账路径在事务提交之后一次都不该读集合')
  noReadShop.db.recordsCtx = realRecordsCtx
  // 恢复之后 getLedger 正常，并且**确实**读了集合（否则上面的断言是假绿）
  let sentinelReads = 0
  noReadShop.db.recordsCtx = function () {
    sentinelReads += 1
    return realRecordsCtx.call(noReadShop.db)
  }
  const nrAfter = await noReadShop.ledger()
  assert.ok(Array.isArray(nrAfter.records), '只读路径分页取得到流水')
  assert.ok(sentinelReads > 0,
    'getLedger / listRecords 必须真的读集合（attachRecent 的 recent + countAll 哨兵），'
    + '否则上面「提交后一次都没读」的断言是假绿')
  noReadShop.db.recordsCtx = realRecordsCtx

  // -------------------------------------------------------------------------
  // 13) 提交之后的读失败绝不能变成「记账失败」；同时钉住「本方案不提供幂等」
  // -------------------------------------------------------------------------
  const jitterShop = await new Shop({ ids: idFactory('jt') }).open('抖动店')
  await jitterShop.call('saveProduct', { name: '牛奶', costPrice: 2, salePrice: 5, stock: 100, alertQty: 1 })
  const jtLists = await jitterShop.ledger()
  const jtMilk = jtLists.products[0]
  const jtBook = jtLists.bookId
  const jtSale = {
    payType: 'cash', items: [{ productId: jtMilk.id, qty: 3, unitPrice: 5 }]
  }
  const jtRealCtx = jitterShop.db.recordsCtx
  jitterShop.db.recordsCtx = function () { throw new Error('boom') }
  const jtRes = await jitterShop.call('addSale', jtSale)
  assert.ok(jtRes.result.order, '提交后的读失败绝不能变成记账失败')
  jitterShop.db.recordsCtx = jtRealCtx
  function jtOutCount() {
    return jitterShop.docsOfBook(jtBook).filter(function (d) { return d.type === 'out' }).length
  }
  assert.strictEqual(jtOutCount(), 1)
  assert.strictEqual((await jitterShop.ledger()).products[0].stock, 97)

  // 本方案**不提供幂等**：用户手动再点一次仍然会记第二笔。
  // 这条断言钉住当前语义 —— 将来做请求幂等键时它会失败，正好提醒一起更新。
  await jitterShop.call('addSale', jtSale)
  assert.strictEqual(jtOutCount(), 2)
  assert.strictEqual((await jitterShop.ledger()).products[0].stock, 94)

  // -------------------------------------------------------------------------
  // 14) T-B4：**那道悬崖没了**。
  //     2b-2b 之前，5000 条流水的店 getLedger 直接报「超过 2000 条」，账本
  //     打不开、迁移完就是块砖头。删掉 COMPAT_MAX_RECORDS / readAll 之后，
  //     同一家店必须能正常打开、能翻完、能继续记账。
  // -------------------------------------------------------------------------
  const bigShop = await new Shop({ ids: idFactory('bg') }).open('大店')
  const bigBookId = (await bigShop.db.getLedger(bigShop.shopId)).bookId
  const bigRecords = []
  for (let i = 0; i < 5000; i++) {
    const rec = {
      id: 'big-' + i, type: 'opening', amount: 1, profit: 0, remark: '',
      customerId: 'bc1', customerName: '大客户', customerPhone: '', customerAddress: '',
      createdAt: 1000000 + i, lines: []
    }
    bigRecords.push(rec)
    const doc = apply.toRecordDoc(rec, bigBookId, bigShop.shopId)
    bigShop.db.records[doc._id] = doc
  }
  bigShop.db.ledgers[bigShop.shopId] = Object.assign({}, bigShop.db.ledgers[bigShop.shopId], {
    customers: [{ id: 'bc1', name: '大客户', phone: '', address: '' }],
    accounts: inv.foldAccountTerms(bigRecords),
    aggregate: inv.foldTotalTerms(bigRecords)
  })
  await bigShop.call('saveProduct', { name: '大货', costPrice: 1, salePrice: 3, stock: 50, alertQty: 1 })
  const bigProduct = bigShop.db.ledgers[bigShop.shopId].products[0]

  const bigPay = await bigShop.call('addPayment', { customerId: 'bc1', amount: 2 })
  assert.ok(bigPay.result.record, '5000 条的店照样能记账')
  await bigShop.call('addSale', {
    payType: 'cash', items: [{ productId: bigProduct.id, qty: 1, unitPrice: 3 }]
  })
  assert.strictEqual(bigShop.docsOfBook(bigBookId).length, 5002)

  // getLedger 打得开：不再有任何条数上限，回包里也不再有整本流水
  const bigLedgerRes = await bigShop.call('getLedger', {})
  assert.strictEqual(bigLedgerRes.ledger.records, undefined)
  assert.strictEqual(bigLedgerRes.ledger.aggregate.count, 5002)
  assert.ok(!bigLedgerRes.ledger.aggregatesStale, '5002 条时聚合和集合仍然对得上')
  // recent 只回一页，不是 5002 条
  assert.strictEqual(bigLedgerRes.ledger.recent.length, apply.RECORD_PAGE_DEFAULT)

  // 翻得完：5002 条逐条等于集合
  const bigPaged = await bigShop.pagedAll()
  assert.strictEqual(bigPaged.length, 5002, 'T-B4：5002 条必须翻得完，不该再有 2000 条的悬崖')
  assert.deepStrictEqual(bigPaged, bigShop.collectionAll(bigBookId))

  // -------------------------------------------------------------------------
  // 15) 上限边界 / off-by-one：判条数不判页数
  //     正好 PAGE_LIMIT 的整数倍是老实现漏掉的那个点（名义 5000 实际 4999）。
  //     COMPAT_MAX_RECORDS / readAll 已经删了，样板只剩 suffixOfCustomer 一份。
  // -------------------------------------------------------------------------
  assert.strictEqual(recordsModule.COMPAT_MAX_RECORDS, undefined,
    'T-B4：兼容上限已经删了，不要再加回来 —— 悬崖没了才是 2b-2 的主要收益')
  assert.strictEqual(recordsModule.SUFFIX_MAX_RECORDS, 5000, 'getSlip 倒推上限语义不同，别跟着改')
  const capBag = {}
  const capCount = recordsModule.PAGE_LIMIT   // 正好一整页
  for (let i = 0; i < capCount; i++) {
    const rec = {
      id: 'cap-' + i, type: 'opening', amount: 1, profit: 0, remark: '',
      customerId: 'cc1', customerName: '边界客户', customerPhone: '', customerAddress: '',
      createdAt: 2000000 + i, lines: []
    }
    const doc = apply.toRecordDoc(rec, 'capbook', 'capshop')
    capBag[doc._id] = doc
  }
  const capStore = recordsModule.recordStore(memory.memRecordsCtx(capBag), 'capbook', 'capshop')
  assert.strictEqual(capStore.readAll, undefined, 'T-B4：readAll 已经删了')
  // 整页倍数：最后一页 0 条 + hasMore:false，游标为 ''。分页翻完仍要拿到全部。
  const capLastPage = await capStore.page({
    cursor: apply.makeSortKey(2000000, 'cap-0'), limit: capCount
  })
  assert.strictEqual(capLastPage.records.length, 0, '整页倍数时最后一页是空页')
  assert.strictEqual(capLastPage.hasMore, false)
  assert.strictEqual(capLastPage.cursor, '', '空页的 cursor 是 ——「直接赋值会冲回开头」的来源')
  assert.strictEqual((await capStore.suffixOfCustomer('cc1', '', capCount)).length, capCount,
    'suffixOfCustomer 同款：正好 cap 条要能读完')
  await rejects(function () {
    return capStore.suffixOfCustomer('cc1', '', capCount - 1)
  }, /流水太多/)

  // -------------------------------------------------------------------------
  // 16) 换账套三条路（clearAll / loadSeed / restoreCleared）：分页永远只看得见
  //     **当前账套**。2b-2b 之前这一节测的是 mergeRecordDelta 的 bookChanged
  //     分支；delta 删掉之后，「换账套」对客户端就是「listRecords 换了一本账」，
  //     所以直接对分页结果断言。
  // -------------------------------------------------------------------------
  const swShop = await new Shop({ ids: idFactory('sw') }).open('换账套店')
  await swShop.call('saveProduct', { name: '面包', costPrice: 5, salePrice: 10, stock: 50, alertQty: 1 })
  await swShop.call('saveCustomer', { name: '老客户' })
  let swLists = await swShop.ledger()
  await swShop.call('addSale', {
    payType: 'credit', customerId: swLists.customers[0].id,
    items: [{ productId: swLists.products[0].id, qty: 5, unitPrice: 10 }]
  })
  swLists = await swShop.ledger()
  const swBefore = swLists.records.slice()
  const swBookBefore = swLists.bookId
  assert.strictEqual(swBefore.length, 1)

  const swCleared = await swShop.call('clearAll', {})
  assert.strictEqual(swCleared.ledger.records, undefined)
  assert.notStrictEqual(swCleared.ledger.bookId, swBookBefore, 'clearAll = 换账套')
  assert.deepStrictEqual(await swShop.pagedAll(), [], 'clearAll 之后当前账套翻不出流水')

  const swSeed = await swShop.call('loadSeed', {})
  assert.notStrictEqual(swSeed.ledger.bookId, swCleared.ledger.bookId, 'loadSeed = 再换一本')
  const swSeedPaged = await swShop.pagedAll()
  assert.ok(swSeedPaged.length > 0, '种子账套翻得出流水')
  assert.strictEqual(swSeedPaged.length, swSeed.ledger.aggregate.count,
    '分页翻完的条数必须等于聚合里的条数')
  assert.deepStrictEqual(swSeedPaged, swShop.collectionAll(swSeed.ledger.bookId))

  // 再清一次，然后恢复：恢复的是**最近一次**清空的那本（种子账套），不是最早那本
  await swShop.call('clearAll', {})
  const swRestored = await swShop.call('restoreCleared', {})
  assert.strictEqual(swRestored.ledger.bookId, swSeed.ledger.bookId,
    '恢复 = 指针指回最近一次清空前的那本')
  assert.notStrictEqual(swRestored.ledger.bookId, swBookBefore)
  const swRefilled = await swShop.pagedAll()
  assert.strictEqual(swRefilled.length, swRestored.ledger.aggregate.count)
  assert.deepStrictEqual(swRefilled, swSeedPaged, '恢复回来的就是 clear 之前那一份')
  // 最早那本一条都没被动过：清空只是换指针，O(1)
  assert.deepStrictEqual(swShop.collectionAll(swBookBefore), swBefore,
    '换账套不许碰老账套里的流水')

  // -------------------------------------------------------------------------
  // 17) apiVersion 门：老客户端拿到不带流水的回传会把缓存清空并印 0.00 的前欠，
  //     所以直接挡住，而不是让它静默印错钱
  // -------------------------------------------------------------------------
  const verShop = await new Shop({ ids: idFactory('ver') }).open('版本店')
  await verShop.call('saveProduct', { name: '货', costPrice: 1, salePrice: 2, stock: 10, alertQty: 1 })
  const verProduct = (await verShop.ledger()).products[0]
  await rejects(function () { return verShop.callRaw('getLedger', {}) }, /请更新小程序/)
  await rejects(function () { return verShop.callRaw('getLedger', {}, null, 1) }, /请更新小程序/)
  await rejects(function () { return verShop.callRaw('getSlip', { recordId: 'x' }) }, /请更新小程序/)
  await rejects(function () { return verShop.callRaw('migrateLocal', {}) }, /请更新小程序/)
  await rejects(function () {
    return verShop.callRaw('addSale', {
      payType: 'cash', items: [{ productId: verProduct.id, qty: 1, unitPrice: 2 }]
    })
  }, /请更新小程序/)
  await rejects(function () { return verShop.callRaw('listRecords', {}) }, /请更新小程序/)
  await rejects(function () { return verShop.callRaw('getRecord', { recordId: 'x' }) }, /请更新小程序/)
  // 挡住之后一笔账都没记
  assert.strictEqual((await verShop.pagedAll()).length, 0)
  // 不回传账本的 action 必须放行，否则老客户端连店都列不出来
  assert.ok((await verShop.callRaw('whoami', {})).openid)
  assert.ok((await verShop.callRaw('listShops', {})).shops)
  assert.ok((await verShop.callRaw('listMembers', {})).members)
  assert.ok((await core.dispatch({
    db: verShop.db, makeId: verShop.ids, openid: verShop.openid,
    action: 'createShop', shopId: '', payload: { name: '不带版本号也能建店' }, now: 9000
  })).shop.id)
  // 带上版本号就正常
  assert.ok((await verShop.callRaw('getLedger', {}, null, core.API_VERSION)).ledger)

  // -------------------------------------------------------------------------
  // 18) 迁移窗口内的老账本：totals 和 customers[].account 必须等于对 legacy
  //     数组的全量折叠，并且和同一状态下 getSlip 算出来的欠款自洽（审计阻塞 1）
  // -------------------------------------------------------------------------
  const winDb = new MemoryDb()
  const winIds = idFactory('win')
  const winShopId = (await core.dispatch({
    db: winDb, makeId: winIds, openid: 'u1', action: 'createShop',
    shopId: '', apiVersion: core.API_VERSION, payload: { name: '迁移窗口店' }, now: 1000
  })).shop.id
  // 2a 形状：流水还在数组里，**没有** accounts / aggregate 这两个 2b 才有的累加器
  const winDoc = Object.assign({}, winDb.ledgers[winShopId], {
    recordsMigratedAt: 0,
    products: [{ id: 'p1', name: '牛奶', costPrice: 2, salePrice: 5, stock: 10, alertQty: 5, colors: [], sizes: [] }],
    customers: [{ id: 'c1', name: '甲' }],
    records: [
      { id: 'l1', type: 'out', orderId: 'ord1', productId: 'p1', productName: '牛奶', qty: 60, unitPrice: 5, costPrice: 2, amount: 300, profit: 180, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 1000 },
      { id: 'l2', type: 'in', productId: 'p1', productName: '牛奶', qty: 90, unitPrice: 2, costPrice: 2, amount: 180, profit: 0, createdAt: 2000 },
      { id: 'l3', type: 'pay', amount: 100, profit: 0, customerId: 'c1', customerName: '甲', payType: 'cash', createdAt: 3000 }
    ]
  })
  delete winDoc.accounts
  delete winDoc.aggregate
  winDb.ledgers[winShopId] = winDoc
  function winCall(action, payload) {
    return core.dispatch({
      db: winDb, makeId: winIds, openid: 'u1', action: action, shopId: winShopId,
      apiVersion: core.API_VERSION, payload: payload || {}, now: 5000
    })
  }
  const winLists = (await winCall('getLedger')).ledger
  assert.strictEqual(winLists.recordsPendingMigration, true)
  assert.strictEqual(winLists.records, undefined,
    'T-B2：迁移窗口内的店同样不许回传整本流水')
  const winLegacy = await pagedAllVia(winCall)
  assert.strictEqual(winLegacy.length, 3)
  assert.deepStrictEqual(winLists.totals, inv.summarizeRecords(winLegacy),
    '迁移窗口内 totals 必须等于对 legacy 数组的全量折叠，不能回传全 0')
  assert.deepStrictEqual(winLists.accounts, inv.foldAccountTerms(winLegacy))
  assert.deepStrictEqual(winLists.aggregate, inv.foldTotalTerms(winLegacy))
  assert.strictEqual(winLists.totals.receivable, 200)
  const winCustomer = winLists.customers.find(function (item) { return item.id === 'c1' })
  assert.deepStrictEqual(winCustomer.account, inv.summarizeAllCustomerAccounts(winLegacy)['c1'])
  assert.strictEqual(winCustomer.account.receivable, 200)
  // 和 getSlip 自洽：末端那张单的「当时欠款」必须落在同一条余额线上
  const winSlip = await winCall('getSlip', { recordId: 'ord1' })
  assert.strictEqual(winSlip.receivable, inv.receivableAt(winLegacy, 'c1', 1000))
  const winLastSlip = await winCall('getSlip', { recordId: 'l3' })
  assert.strictEqual(winLastSlip.receivable, winCustomer.account.receivable,
    '最后一张单的当时欠款 = 客户页显示的当前欠款，两边不能自相矛盾')

  // -------------------------------------------------------------------------
  // 19) saleOrderId 为空的退货单：改数量必须被拒，库存和金额一点不动（审计阻塞 2）
  // -------------------------------------------------------------------------
  const holeShop = await new Shop({ ids: idFactory('hl') }).open('退货洞店')
  await holeShop.call('saveProduct', { name: '牛奶', costPrice: 2, salePrice: 10, stock: 100, alertQty: 1 })
  await holeShop.call('saveCustomer', { name: '甲' })
  let holeLists = await holeShop.ledger()
  const holeSale = (await holeShop.call('addSale', {
    payType: 'cash', customerId: holeLists.customers[0].id,
    items: [{ productId: holeLists.products[0].id, qty: 10, unitPrice: 10 }]
  })).result.order
  const holeReturn = (await holeShop.call('addReturn', {
    items: [{ saleOrderId: holeSale.id, saleLineId: holeSale.lines[0].lineId, qty: 1 }]
  })).result.recordsCreated[0]
  holeLists = await holeShop.ledger()
  assert.strictEqual(holeLists.products[0].stock, 91)

  // legacyLine() 对老退货行写死 saleOrderId=''，只有 backfillReturnedQty 在同一批里
  // 找到被退销售单才补得上 —— 跨片 / 分批迁移会大面积产生这个形状
  const holeDocId = apply.recordDocId(holeLists.bookId, holeReturn.id)
  holeShop.db.records[holeDocId].saleOrderId = ''
  holeShop.db.records[holeDocId].lines[0].saleOrderId = ''

  await rejects(function () {
    return holeShop.call('updateRecord', {
      id: holeReturn.id,
      items: [{ id: holeReturn.lines[0].lineId, qty: 500 }]
    })
  }, /退货请指明销售单/)

  const holeAfter = await holeShop.ledger()
  assert.strictEqual(holeAfter.products[0].stock, 91, '被拒之后库存一点不动')
  const holeReturnAfter = holeAfter.records.find(function (r) { return r.id === holeReturn.id })
  assert.strictEqual(holeReturnAfter.lines[0].qty, 1, '退货数量一点不动')
  assert.strictEqual(holeReturnAfter.amount, 10, '退货单金额一点不动')
  const holeSaleAfter = holeAfter.records.find(function (r) { return r.id === holeSale.id })
  assert.strictEqual(holeSaleAfter.lines[0].returnedQty, 1)
  assert.deepStrictEqual(holeAfter.accounts, inv.foldAccountTerms(holeAfter.records))

  // -------------------------------------------------------------------------
  // 2b-2a：分页 API（客户端一行不改）。方案 D:\work\inventory-miniapp-handoffs\
  // 2b-2-pagination-design-2026-08-23.md §五 的 T-A1..T-A8。
  // -------------------------------------------------------------------------

  // T-A3（2b-2b 改造）：整本回传那个 oracle 已经没了 —— getLedger 不再回
  // records，readAll 也删了。换成**不经过查询层**的文档袋作参照物，仍然是三方
  // 对照：recordStore.page（集合查询）/ listRecords（完整云函数栈）/ 文档袋。
  const a3Ledger = await shop.ledger()
  const a3Truth = shop.collectionAll(a3Ledger.bookId)
  const a3Store = recordsModule.recordStore(shop.db.recordsCtx(), a3Ledger.bookId, shop.shopId)
  const a3StorePaged = []
  let a3StoreCursor = ''
  for (;;) {
    const got = await a3Store.page({ cursor: a3StoreCursor, limit: 17 }) // 故意选不整除的 limit
    got.records.forEach(function (item) { a3StorePaged.push(item) })
    if (!got.hasMore) break
    a3StoreCursor = got.cursor
  }
  assert.deepStrictEqual(a3StorePaged, a3Truth,
    'T-A3：recordStore.page 分页翻完必须逐条等于集合')
  const a3ListPaged = []
  let a3ListCursor = ''
  for (;;) {
    const listRes = await shop.call('listRecords', { cursor: a3ListCursor, limit: 13 })
    listRes.records.forEach(function (item) { a3ListPaged.push(item) })
    if (!listRes.hasMore) break
    a3ListCursor = listRes.cursor
  }
  assert.deepStrictEqual(a3ListPaged, a3Truth,
    'T-A3：listRecords 分页（走完整云函数栈）翻完也必须逐条等于集合')
  console.log('T-A3：recordStore.page / listRecords / 集合文档袋，'
    + a3Truth.length + ' 条三方一致')

  // T-A2：pageRecords（纯函数）== recordStore.page（集合查询），本步骤的核心
  // 交付物。{type}×7 × {customerId}×3 × {limit}×4 的笛卡尔积逐页翻完，逐字段
  // deepStrictEqual。数据直接合成写入集合（绕开 applyMutation 的业务规则），
  // 图的是能自由控制 type / customerId / 同毫秒分布，覆盖面比走业务动作更全。
  async function comparePagedEquivalence(fullRecords, store, options) {
    let cursor = ''
    for (let round = 0; round < 1000; round++) {
      const withCursor = Object.assign({}, options, { cursor: cursor })
      const pure = apply.pageRecords(fullRecords, withCursor)
      const coll = await store.page(withCursor)
      assert.deepStrictEqual(pure, coll,
        'T-A2：pageRecords 与 recordStore.page 不等，options=' + JSON.stringify(withCursor))
      if (!pure.hasMore) return
      cursor = pure.cursor
    }
    assert.fail('T-A2：翻页 1000 轮还没翻完，可能死循环：' + JSON.stringify(options))
  }

  const pgShop = await new Shop({ ids: idFactory('pg') }).open('分页对拍店')
  const pgBookId = (await pgShop.db.getLedger(pgShop.shopId)).bookId
  const pgCustomers = ['pg-cust-a', 'pg-cust-b']
  const pgTypesPool = ['out', 'in', 'return', 'pay', 'opening', 'convert', 'adjust_in', 'adjust_out']
  const pgRaw = []
  for (let i = 0; i < 320; i++) {
    const type = pgTypesPool[i % pgTypesPool.length]
    // 每 3 条撞一次同毫秒，钉住「同毫秒也要有全序」
    const createdAt = 1000 + Math.floor(i / 3) * 10
    const hasCustomer = type === 'out' || type === 'pay' || type === 'return' || type === 'opening'
    const customerId = hasCustomer ? pgCustomers[i % 2] : ''
    pgRaw.push({
      id: 'pg-' + i,
      type: type,
      amount: 1,
      profit: 0,
      remark: '',
      customerId: customerId,
      customerName: customerId ? '客户' : '',
      customerPhone: '',
      customerAddress: '',
      payType: hasCustomer ? 'credit' : 'cash',
      createdAt: createdAt,
      lines: []
    })
  }
  pgRaw.forEach(function (record) {
    const doc = apply.toRecordDoc(record, pgBookId, pgShop.shopId)
    pgShop.db.records[doc._id] = doc
  })
  const pgFull = pgRaw.slice()
  const pgQStore = recordsModule.recordStore(pgShop.db.recordsCtx(), pgBookId, pgShop.shopId)

  // 边界：customerId 传 ''（散客）不过滤 —— 结果必须和不传 customerId 完全一样，
  // 防止有人以为能用它单独查出散客单。limit 用 100（clampPageLimit 的上限），
  // 不用一个会被钳掉的超大值，否则「一页装不下 320 条」会被误当成过滤生效。
  assert.deepStrictEqual(
    apply.pageRecords(pgFull, { customerId: '', limit: 100 }),
    apply.pageRecords(pgFull, { limit: 100 }),
    'T-A2 边界：customerId 传空字符串和不传必须结果一致（纯函数，不过滤）'
  )
  assert.deepStrictEqual(
    await pgQStore.page({ customerId: '', limit: 100 }),
    await pgQStore.page({ limit: 100 }),
    'T-A2 边界：customerId 传空字符串和不传必须结果一致（集合查询，不过滤）'
  )
  // 边界：cursor 传一个不存在的 sortKey，两边都按 < 比较，必须一致
  const ghostCursor = '0000000001005_ghost'
  assert.deepStrictEqual(
    apply.pageRecords(pgFull, { cursor: ghostCursor, limit: 100 }),
    await pgQStore.page({ cursor: ghostCursor, limit: 100 }),
    'T-A2 边界：cursor 传不存在的 sortKey 两边必须一致（都用 <）'
  )

  const a2Types = ['all', 'in', 'out', 'pay', 'return', 'convert', 'adjust']
  const a2Customers = ['', pgCustomers[0], pgCustomers[1]]
  const a2Limits = [1, 3, 20, 100]
  let a2Combos = 0
  for (let ti = 0; ti < a2Types.length; ti++) {
    for (let ci = 0; ci < a2Customers.length; ci++) {
      for (let li = 0; li < a2Limits.length; li++) {
        await comparePagedEquivalence(pgFull, pgQStore, {
          type: a2Types[ti], customerId: a2Customers[ci], limit: a2Limits[li]
        })
        a2Combos += 1
      }
    }
  }
  assert.strictEqual(a2Combos, a2Types.length * a2Customers.length * a2Limits.length)
  console.log('T-A2：pageRecords 与 recordStore.page 笛卡尔积等价性通过，' + a2Combos + ' 组合全部逐页核对')

  // T-B7：pageRecords 的 type 语义必须和 filterRecords 逐条一致。
  //
  // 为什么单列一条：2b-2b 之前流水页用的是 filterRecords（本地过滤整本），
  // 之后换成 listRecords 的 type 参数。两处对 'adjust' 的理解一旦分叉
  // （一个认 adjust_in/adjust_out 两种、另一个只认字面量 'adjust'），
  // 「调整」这个 chip 会静默变成空列表，而没有任何断言会红。
  const b7Types = ['all', 'in', 'out', 'pay', 'return', 'convert', 'adjust',
    'adjust_in', 'adjust_out', 'opening']
  b7Types.forEach(function (type) {
    const viaFilter = inv.filterRecords(pgFull, type).map(function (item) {
      return item.id
    }).sort()
    const viaPage = []
    let cursor = ''
    for (let round = 0; round < 1000; round++) {
      const got = apply.pageRecords(pgFull, { type: type, cursor: cursor, limit: 100 })
      got.records.forEach(function (item) { viaPage.push(item.id) })
      if (!got.hasMore) break
      cursor = got.cursor
    }
    assert.deepStrictEqual(viaPage.sort(), viaFilter,
      'T-B7：type=' + type + ' 时 pageRecords 和 filterRecords 的口径必须一致')
  })
  // 语料真的覆盖到了「调整」这两种，否则上面那条 adjust 是空对空
  assert.ok(inv.filterRecords(pgFull, 'adjust').length > 0,
    'T-B7 语料必须含 adjust_in / adjust_out，否则 adjust 那条断言没有意义')

  // T-A4：listRecords({customerId}) 翻完 == summarizeCustomerAccount(all, cid).ledger
  // 把 F18（只有 out/pay/return/opening 带 customerId）的推导钉成可执行断言。
  const a4Expected = inv.summarizeCustomerAccount(allDesc, slipA.id).ledger
  const a4Paged = []
  let a4Cursor = ''
  for (;;) {
    const listRes = await slipShop.call('listRecords', { customerId: slipA.id, cursor: a4Cursor, limit: 2 })
    listRes.records.forEach(function (item) { a4Paged.push(item) })
    if (!listRes.hasMore) break
    a4Cursor = listRes.cursor
  }
  assert.ok(a4Paged.length > 0, 'T-A4：语料必须包含客户甲的往来记录，否则测试没有意义')
  assert.deepStrictEqual(a4Paged, a4Expected,
    'T-A4：listRecords({customerId}) 翻完必须等于 summarizeCustomerAccount(...).ledger')

  // T-A6：getRecord 两条路（已迁移 store.byId / 未迁移 legacy find）+ 跨账套取不到
  const a6MigratedExpected = allDesc[0]
  const a6MigratedRes = await slipShop.call('getRecord', { recordId: a6MigratedExpected.id })
  assert.deepStrictEqual(a6MigratedRes.record, a6MigratedExpected,
    'T-A6：已迁移账本 getRecord 必须等于 store.byId 那条')
  await rejects(function () {
    return slipShop.call('getRecord', { recordId: nrPurchase.id }) // 属于 noReadShop 的记录 id
  }, /流水不存在/)
  await rejects(function () {
    return slipShop.call('getRecord', { recordId: 'definitely-not-exist' })
  }, /流水不存在/)

  // T-A7：listRecords 的 type 和 customerId 不能同时非默认（无索引查询，方案 §3.1）
  await rejects(function () {
    return slipShop.call('listRecords', { type: 'out', customerId: slipA.id })
  }, /不支持同时按类型和客户筛选/)
  // type='all' 不算「非默认」，可以和 customerId 同时给
  const a7Ok = await slipShop.call('listRecords', { type: 'all', customerId: slipA.id, limit: 100 })
  assert.ok(Array.isArray(a7Ok.records))

  // T-A5：today / recent 与全量折叠相等；跨日语料；单页装不下当天（130 条同日
  // 逼出翻页，PAGE_LIMIT=100）仍 todayComplete；dayStart 非法只发一次查询。
  function taRec(id, type, createdAt, amount, profit) {
    return {
      id: id, type: type, amount: amount, profit: profit, remark: '',
      customerId: '', customerName: '', customerPhone: '', customerAddress: '',
      payType: 'cash', createdAt: createdAt, lines: []
    }
  }
  const taShop = await new Shop({ ids: idFactory('ta') }).open('今日聚合店')
  const taBookId = (await taShop.db.getLedger(taShop.shopId)).bookId
  const taDayStart = 500000
  const taOlder = []
  for (let i = 0; i < 25; i++) {
    taOlder.push(taRec('ta-old-' + i, 'out', taDayStart - 1000 + i, 10, 4))
  }
  const taToday = []
  for (let i = 0; i < 80; i++) {
    taToday.push(taRec('ta-out-' + i, 'out', taDayStart + i, 10, 4))
  }
  for (let i = 0; i < 20; i++) {
    taToday.push(taRec('ta-ret-' + i, 'return', taDayStart + 80 + i, 5, -2))
  }
  for (let i = 0; i < 30; i++) {
    taToday.push(taRec('ta-in-' + i, 'in', taDayStart + 100 + i, 8, 0))
  }
  assert.strictEqual(taToday.length, 130, 'T-A5 语料准备：today 桶要够 130 条（>PAGE_LIMIT）才能逼出多页')
  const taAll = taOlder.concat(taToday)
  taAll.forEach(function (record) {
    const doc = apply.toRecordDoc(record, taBookId, taShop.shopId)
    taShop.db.records[doc._id] = doc
  })
  taShop.db.ledgers[taShop.shopId] = Object.assign({}, taShop.db.ledgers[taShop.shopId], {
    aggregate: inv.foldTotalTerms(taAll),
    accounts: inv.foldAccountTerms(taAll)
  })

  const taProbeQuery = taShop.db.recordsCtx().collection.where({})
  const taQueryProto = Object.getPrototypeOf(taProbeQuery)
  const taOriginalGet = taQueryProto.get

  const taStore = recordsModule.recordStore(taShop.db.recordsCtx(), taBookId, taShop.shopId)
  const taRecentLimit = 10

  // dayStart 非法（null）：只取 recent 那一页，一次查询就完事
  let a5InvalidCalls = 0
  taQueryProto.get = function () {
    a5InvalidCalls += 1
    return taOriginalGet.apply(this, arguments)
  }
  const a5Invalid = await recordsModule.recentAndToday(taStore, null, taRecentLimit)
  taQueryProto.get = taOriginalGet
  assert.strictEqual(a5InvalidCalls, 1, 'T-A5：dayStart 非法时 recentAndToday 只应该发一次查询')
  assert.strictEqual(a5Invalid.today, null)
  assert.strictEqual(a5Invalid.todayComplete, false)
  assert.strictEqual(a5Invalid.recent.length, taRecentLimit)

  // 跨日语料 + 130 条当日记录逼出多页：today 仍要 complete，且和全量折叠相等
  let a5ValidCalls = 0
  taQueryProto.get = function () {
    a5ValidCalls += 1
    return taOriginalGet.apply(this, arguments)
  }
  const a5Valid = await recordsModule.recentAndToday(taStore, taDayStart, taRecentLimit)
  taQueryProto.get = taOriginalGet
  assert.ok(a5ValidCalls >= 2,
    'T-A5：today 桶超过 PAGE_LIMIT 时必须翻多页才能跨过 dayStart，实际查询 ' + a5ValidCalls + ' 次')
  assert.strictEqual(a5Valid.todayComplete, true,
    'T-A5：today 桶 130 条（>PAGE_LIMIT）逼出多页翻页，仍要 todayComplete')
  assert.deepStrictEqual(a5Valid.today, inv.todayTotals(taAll, taDayStart),
    'T-A5：today 必须等于对全量语料的折叠，且不能被跨日的 taOlder 污染')
  assert.deepStrictEqual(a5Valid.recent, apply.pageRecords(taAll, { limit: taRecentLimit }).records,
    'T-A5：recent 必须等于 pageRecords 纯函数切出来的同一页')
  console.log('T-A5：today 桶 130 条逼出 ' + a5ValidCalls + ' 次查询，todayComplete 仍为 true')

  // 端到端：走 getLedger（2b-2a 仍然回整本 + 新增 recent/today），三个口径互相印证
  const taGetLedgerRes = await taShop.call('getLedger', { dayStart: taDayStart, recentLimit: taRecentLimit })
  assert.strictEqual(taGetLedgerRes.ledger.todayComplete, true)
  assert.deepStrictEqual(taGetLedgerRes.ledger.today, inv.todayTotals(taAll, taDayStart))
  assert.deepStrictEqual(taGetLedgerRes.ledger.recent, apply.pageRecords(taAll, { limit: taRecentLimit }).records)

  // dayStart 非法（0 / 远超 now）：getLedger 必须显示 today:null，不能回退现算
  const taZeroDay = await taShop.call('getLedger', { dayStart: 0, recentLimit: 5 })
  assert.strictEqual(taZeroDay.ledger.today, null, 'T-A5：dayStart=0 必须给 today:null，不能悄悄现算')
  assert.strictEqual(taZeroDay.ledger.todayComplete, false)
  const taFarFuture = await taShop.call('getLedger', {
    dayStart: Date.now() + 30 * 24 * 60 * 60 * 1000, recentLimit: 5
  })
  assert.strictEqual(taFarFuture.ledger.today, null, 'T-A5：远超今天的 dayStart 必须给 today:null')
  assert.strictEqual(taFarFuture.ledger.todayComplete, false)

  // dayStart 的下界比上界更要紧：设备时钟停在 1970 时它是个很小的正数，
  // 没有下界就会一路翻到没有更多流水，把**整本账当成「今天」**返回，
  // 而且标着 todayComplete: true —— 一个标着「完整」的错数，比 null 危险得多。
  // 这两条必须显式传一个真实的 now：夹具默认用从 1000 起步的合成时钟，
  // 那种 now 下「1970 年」和「一周前」都落在合法区间里，下界根本演示不出来。
  const taRealNow = Date.now()
  const taStaleClock = await taShop.call('getLedger', { dayStart: 1, recentLimit: 5 }, taRealNow)
  assert.strictEqual(taStaleClock.ledger.today, null,
    'T-A5：1970 年的 dayStart 必须给 today:null，绝不能把整本账当成今天')
  assert.strictEqual(taStaleClock.ledger.todayComplete, false,
    'T-A5：算不出来就不能标 complete')
  const taWeekAgo = await taShop.call('getLedger', {
    dayStart: taRealNow - 7 * 24 * 60 * 60 * 1000, recentLimit: 5
  }, taRealNow)
  assert.strictEqual(taWeekAgo.ledger.today, null, 'T-A5：一周前的 dayStart 同样要拒绝')
  // 正常情况下（dayStart 就是当天零点）仍然要算得出来，别把下界写成了一刀切
  const taTodayOk = await taShop.call('getLedger', {
    dayStart: inv.startOfDay(taRealNow), recentLimit: 5
  }, taRealNow)
  assert.ok(taTodayOk.ledger.today, 'T-A5：合法的当天零点必须算得出来')
  assert.strictEqual(taTodayOk.ledger.todayComplete, true)

  // T-A8：未迁移店的分页 —— recordsPendingMigration + 翻完 == legacy 倒序 +
  // 写路径仍被挡（复用 18) 的 winShop / winLegacy 迁移窗口夹具）
  const a8Expected = apply.pageRecords(winLegacy, { limit: 100 }).records
  const a8Paged = []
  let a8Cursor = ''
  for (;;) {
    const listRes = await winCall('listRecords', { cursor: a8Cursor, limit: 2 })
    assert.strictEqual(listRes.recordsPendingMigration, true,
      'T-A8：未迁移店 listRecords 必须标 recordsPendingMigration')
    listRes.records.forEach(function (item) { a8Paged.push(item) })
    if (!listRes.hasMore) break
    a8Cursor = listRes.cursor
  }
  assert.deepStrictEqual(a8Paged, a8Expected, 'T-A8：未迁移店翻页完整结果必须等于 legacy 数组的倒序')
  await rejects(function () {
    return winCall('addPayment', { customerId: 'c1', amount: 1 })
  }, /本店账本还没完成流水升级/)

  console.log('ledger records tests passed')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})

// 造一份「本机账本」当 migrateLocal 的原料：用纯函数直接生成，
// 不经过云函数，模拟小程序本地存的那份数据。
function MemoryBookSource() {
  const ids = idFactory('local')
  const product = inv.createProduct({
    name: '本机货', costPrice: 3, salePrice: 6, stock: 100, alertQty: 1
  }, 100, 'lp1')
  const customer = inv.createCustomer({ name: '本机客户' }, 100, 'lc1')
  const purchase = inv.applyPurchase([product], [], {
    productId: 'lp1', qty: 10, unitPrice: 3
  }, 200, 'lin1', [])
  const sale = inv.applySaleOrder(purchase.products, purchase.records, {
    customerId: 'lc1', customerName: '本机客户', payType: 'credit',
    items: [{ productId: 'lp1', qty: 5, unitPrice: 6 }]
  }, 300, 'lout1', ids, purchase.skus)
  const pay = inv.applyPayment(sale.records, {
    customerId: 'lc1', customerName: '本机客户', amount: 10
  }, 400, 'lpay1')
  const opening = inv.applyOpening(pay.records, {
    customerId: 'lc1', customerName: '本机客户', amount: 7
  }, 500, 'lopen1')
  this.records = opening.records
  this.lists = {
    products: sale.products,
    skus: sale.skus,
    customers: [customer],
    categories: []
  }
}
