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

Shop.prototype.ledger = async function () {
  const res = await this.call('getLedger', {})
  return res.ledger
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

  const EXPECTED_ERRORS = /库存不足|请选择规格|规格不存在|收款不能超过当前欠款|改完后收款会超过赊账|可退数量|退货数量必须大于|销售数量必须大于|进货数量必须大于|调整数量必须大于|改规格数量必须大于|期初欠款必须大于|收款金额必须大于|请选择不同的规格|待加工库存不能改规格|请先删除退货记录|流水不存在|商品不存在|客户不存在|商品已删除|请选择客户|赊账必须选择客户|数量不能小于已退货|请填写退货数量|请先加入商品|不能改调整方向|退货请指明销售单|分规格现货没有待加工格|选择其他时请填写备注|待加工库存不存在|一次退货只能退同一张销售单|请选择原因|普通商品不用改规格/

  let ledger = await shop.ledger()
  // 模拟客户端那份流水缓存：记账回传只给 recordDelta，客户端用 mergeRecordDelta
  // 合进来。整个随机序列从此**由客户端缓存驱动**，这是对 mergeRecordDelta 最强的检验。
  let clientRecords = ledger.records.slice()
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
    // 随机序列的语料是**客户端缓存**，不是服务端回传的流水（记账回传已经不带流水）
    const plan = nextMutation(rng, Object.assign({}, ledger, { records: clientRecords }))
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

    // ★ 客户端缓存：服务端往集合里写什么，客户端就往缓存里合什么
    const merged = apply.mergeRecordDelta(clientRecords, res.recordDelta)
    assert.strictEqual(merged.complete, true,
      'step ' + step + ' ' + plan.action + '：客户端缓存条数和服务端对不上')
    clientRecords = merged.records

    // ★ 客户端缓存必须逐条、逐顺序等于集合里的全量
    const collection = await recordsModule
      .recordStore(shop.db.recordsCtx(), ledger.bookId, shop.shopId).readAll()
    assert.deepStrictEqual(clientRecords, collection,
      'step ' + step + ' ' + plan.action + '：客户端缓存和集合逐条对不上')

    // ★ 漂移守门员：文档里增量维护出来的累加器，必须等于对全部记录的全量折叠
    assert.deepStrictEqual(ledger.accounts, inv.foldAccountTerms(clientRecords),
      'step ' + step + ' ' + plan.action + '：accounts 增量维护和全量折叠对不上')
    assert.deepStrictEqual(ledger.aggregate, inv.foldTotalTerms(clientRecords),
      'step ' + step + ' ' + plan.action + '：aggregate 增量维护和全量折叠对不上')
    assert.deepStrictEqual(ledger.totals, inv.summarizeRecords(clientRecords),
      'step ' + step + '：totals 投影对不上')
    assert.strictEqual(ledger.aggregate.count, clientRecords.length,
      'step ' + step + '：聚合条数和集合条数对不上')

    const expectedAccounts = inv.summarizeAllCustomerAccounts(clientRecords)
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
  assert.strictEqual(docs.length, clientRecords.length)
  docs.forEach(function (doc) {
    assert.strictEqual(doc._id, bookId + '_' + doc.id)
    assert.strictEqual(doc.sortKey, apply.makeSortKey(doc.createdAt, doc.id))
    assert.strictEqual(doc.shopId, shop.shopId)
  })
  // 序列末尾必须仍在 COMPAT_MAX_RECORDS 之内，否则下面 getLedger 会直接报错
  assert.ok(clientRecords.length < recordsModule.COMPAT_MAX_RECORDS,
    '随机序列的流水条数必须留在兼容上限之内，实际 ' + clientRecords.length)
  // 只读路径拿到的整本流水，必须逐条等于客户端一路合出来的那份
  assert.deepStrictEqual((await shop.ledger()).records, clientRecords,
    'getLedger 的整份替换和 recordDelta 一路合出来的必须是同一份')

  console.log('漂移守门员：3000 步跑完，记成 ' + applied + ' 笔、按业务规则拒绝 '
    + refused + ' 笔，最终 ' + clientRecords.length + ' 条流水，覆盖动作 '
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
  const l1 = (await callOn('u1', 'getLedger', s1)).ledger
  const l2 = (await callOn('u2', 'getLedger', s2)).ledger
  assert.strictEqual(l1.records.length, 1)
  assert.strictEqual(l2.records.length, 1)
  assert.strictEqual(Object.keys(twoShopDb.records).length, 2, '两店各一条，_id 不能撞')
  assert.notStrictEqual(l1.records[0].lines[0].productName, l2.records[0].lines[0].productName)

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
  assert.strictEqual(legacyRead.records.length, 1, '老的按行流水读时归并成一单一条')
  assert.strictEqual(legacyRead.records[0].lines.length, 2)
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
  assert.strictEqual(switchedRead.records.length, 1, '切开关之后只读集合，读不到老数组')
  assert.strictEqual(switchedRead.records[0].type, 'in')

  // 清回老路径：清掉 recordsMigratedAt，读写立刻退回老数组，用户无感
  legacyDb.ledgers[legacyShopId] = Object.assign({}, switched, { recordsMigratedAt: 0 })
  const rolledBack = (await legacyCall('getLedger')).ledger
  assert.strictEqual(rolledBack.recordsPendingMigration, true)
  assert.strictEqual(rolledBack.records.length, 1)
  assert.strictEqual(rolledBack.records[0].id, 'ord1', '回滚之后看到的是迁移前那张单')

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
  // 分片上传只回最后一片：客户端按条数发现对不上，自己再拉一次全量
  const doneMerged = apply.mergeRecordDelta([], done.recordDelta)
  assert.strictEqual(doneMerged.complete, false, '只有最后一片，条数必然对不上')
  assert.strictEqual(doneMerged.records.length, impRecords.length - 2)
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
  // 一次性上传时全部流水随 delta 回来，零次读库 —— 客户端一合就完整
  const oneShotMerged = apply.mergeRecordDelta([], oneShotRes.recordDelta)
  assert.strictEqual(oneShotMerged.complete, true)
  assert.strictEqual(oneShotMerged.records.length, impRecords.length)
  assert.deepStrictEqual(oneShotRes.ledger.accounts, inv.foldAccountTerms(oneShotMerged.records))

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

  const allDesc = await qStore.readAll()
  assert.deepStrictEqual(
    allDesc.map(function (item) { return item.id }),
    qLedger.records.map(function (item) { return item.id }),
    'readAll 的顺序就是 getLedger 回传的顺序'
  )
  for (let i = 1; i < allDesc.length; i++) {
    const prev = apply.makeSortKey(allDesc[i - 1].createdAt, allDesc[i - 1].id)
    const cur = apply.makeSortKey(allDesc[i].createdAt, allDesc[i].id)
    assert.ok(prev > cur, 'readAll 必须按 sortKey 严格倒序')
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

  // 每一步都要成功，且回传形状是「不带流水 + 带 delta」
  async function noReadStep(action, payload) {
    const res = await noReadShop.call(action, payload)
    assert.strictEqual(res.ledger.records, undefined, action + ' 的回传不该带整本流水')
    assert.ok(res.recordDelta, action + ' 的回传必须带 recordDelta')
    assert.ok(Array.isArray(res.recordDelta.writes), action + ' 的 writes 必须是数组')
    assert.strictEqual(typeof res.recordDelta.count, 'number', action + ' 的 count 必须是数字')
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
  assert.ok(Array.isArray(nrAfter.records), 'getLedger 仍然回传整本流水')
  assert.ok(sentinelReads > 0, 'getLedger 必须真的读集合，否则上面的断言不成立')
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
  // 14) 超过兼容上限的店：**仍然能记账**，只是 getLedger 打不开
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
  assert.strictEqual(bigPay.recordDelta.count, 5001, '5000 条的店照样能记账')
  const bigSale = await bigShop.call('addSale', {
    payType: 'cash', items: [{ productId: bigProduct.id, qty: 1, unitPrice: 3 }]
  })
  assert.strictEqual(bigSale.recordDelta.count, 5002)
  assert.strictEqual(bigShop.docsOfBook(bigBookId).length, 5002)

  // getLedger 一次比较就报错，**不烧掉 20 次分页往返**
  const bigRealCtx = bigShop.db.recordsCtx
  let bigCtxCalls = 0
  bigShop.db.recordsCtx = function () {
    bigCtxCalls += 1
    return bigRealCtx.call(bigShop.db)
  }
  await rejects(function () { return bigShop.ledger() }, /超过 2000 条/)
  assert.strictEqual(bigCtxCalls, 0, '前置检查失败就不该再去分页')

  // 前置检查失效（聚合漂移）时，硬上限仍在 readAll 里
  bigShop.db.ledgers[bigShop.shopId] = Object.assign({}, bigShop.db.ledgers[bigShop.shopId], {
    aggregate: Object.assign(inv.emptyTerms(), bigShop.db.ledgers[bigShop.shopId].aggregate, { count: 0 })
  })
  await rejects(function () { return bigShop.ledger() }, /超过 2000 条/)
  assert.ok(bigCtxCalls > 0, '这一次必须真的走到 readAll 才报错')
  bigShop.db.recordsCtx = bigRealCtx

  // -------------------------------------------------------------------------
  // 15) 上限边界 / off-by-one：判条数不判页数
  //     正好 PAGE_LIMIT 的整数倍是老实现漏掉的那个点（名义 5000 实际 4999）
  // -------------------------------------------------------------------------
  assert.strictEqual(recordsModule.COMPAT_MAX_RECORDS, 2000, '兼容上限不要随手调大')
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
  assert.strictEqual((await capStore.readAll(capCount + 1)).length, capCount, 'cap-1 条要能读完')
  assert.strictEqual((await capStore.readAll(capCount)).length, capCount, '正好 cap 条也要能读完')
  await rejects(function () { return capStore.readAll(capCount - 1) }, /超过 2000 条/)
  assert.strictEqual((await capStore.suffixOfCustomer('cc1', '', capCount)).length, capCount,
    'suffixOfCustomer 同款：正好 cap 条要能读完')
  await rejects(function () {
    return capStore.suffixOfCustomer('cc1', '', capCount - 1)
  }, /流水太多/)

  // -------------------------------------------------------------------------
  // 16) 换账套三条路的客户端缓存（clearAll / loadSeed / restoreCleared）
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
  let swCache = swLists.records.slice()
  assert.strictEqual(swCache.length, 1)

  const swCleared = await swShop.call('clearAll', {})
  assert.strictEqual(swCleared.recordDelta.bookChanged, true)
  assert.strictEqual(swCleared.recordDelta.count, 0)
  let swMerged = apply.mergeRecordDelta(swCache, swCleared.recordDelta)
  assert.deepStrictEqual(swMerged.records, [], 'clearAll 之后客户端缓存清空')
  assert.strictEqual(swMerged.complete, true)
  swCache = swMerged.records

  const swSeed = await swShop.call('loadSeed', {})
  assert.strictEqual(swSeed.recordDelta.bookChanged, true)
  assert.ok(swSeed.recordDelta.writes.length > 0, '种子流水随 delta 回来，零次读库')
  swMerged = apply.mergeRecordDelta(swCache, swSeed.recordDelta)
  assert.strictEqual(swMerged.complete, true)
  assert.strictEqual(swMerged.records.length, swSeed.recordDelta.writes.length)
  swCache = swMerged.records
  assert.deepStrictEqual((await swShop.ledger()).records, swCache)

  // restoreCleared：writes 为空但 count > 0 -> complete=false -> 客户端自动重拉
  await swShop.call('clearAll', {})
  const swRestored = await swShop.call('restoreCleared', {})
  assert.strictEqual(swRestored.recordDelta.bookChanged, true)
  assert.strictEqual(swRestored.recordDelta.writes.length, 0)
  assert.ok(swRestored.recordDelta.count > 0)
  swMerged = apply.mergeRecordDelta([], swRestored.recordDelta)
  assert.strictEqual(swMerged.complete, false, '恢复出来的流水不在 delta 里，必须重拉')
  // 重拉：getLedger 对「完整」有最终解释权
  const swRefilled = (await swShop.ledger()).records
  assert.strictEqual(swRefilled.length, swRestored.recordDelta.count)
  assert.deepStrictEqual(swRefilled, swCache, '恢复回来的就是 clear 之前那一份')

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
  // 挡住之后一笔账都没记
  assert.strictEqual((await verShop.ledger()).records.length, 0)
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
  const winLegacy = winLists.records
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
