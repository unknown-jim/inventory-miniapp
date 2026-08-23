// 阶段 2a：流水改成「一张单一条记录，明细内嵌 lines[]」
// 这里只放三类断言：记账不变量、老数据迁移、老/新形状聚合一致。
const assert = require('assert')
const inv = require('../utils/inventory')
const util = require('../utils/util')
const apply = require('../utils/ledger-apply')
const MemoryBook = require('./memory-db').MemoryBook

function idFactory(prefix) {
  let n = 0
  return function () {
    n += 1
    return (prefix || 'id') + '-' + n
  }
}

function totalStock(skus, productId) {
  return inv.productStockFromSkus(skus, productId)
}

function pickTotals(totals) {
  return {
    salesAmount: totals.salesAmount,
    purchaseAmount: totals.purchaseAmount,
    profit: totals.profit,
    receivable: totals.receivable
  }
}

// ---------------------------------------------------------------------------
// 不变量 1：件数守恒
// 进货 N 件 → 卖 / 退 / 改规格 / 库存调整 → 库存件数恒等于进出相抵的结果
// ---------------------------------------------------------------------------

function makeHoodie(nextId) {
  const product = inv.createProduct({
    name: '卫衣',
    costPrice: 45,
    salePrice: 99,
    stock: 0,
    alertQty: 5,
    colors: ['白色', '红色'],
    sizes: ['M'],
    blankProcess: true
  }, 1000, 'p-hoodie')
  return inv.applyProductSkus(product, [], null, 1000, nextId)
}

const keepIds = idFactory('keep')
const keepMade = makeHoodie(keepIds)
const keepWhiteM = inv.findSkuBySpec(keepMade.skus, 'p-hoodie', '白色', 'M')
const keepRedM = inv.findSkuBySpec(keepMade.skus, 'p-hoodie', '红色', 'M')

let keepState = inv.applyPurchase([keepMade.product], [], {
  productId: 'p-hoodie',
  qty: 10,
  unitPrice: 40
}, 2000, 'in-1', keepMade.skus)
assert.strictEqual(totalStock(keepState.skus, 'p-hoodie'), 10)

keepState = inv.applySaleOrder(keepState.products, keepState.records, {
  items: [{ productId: 'p-hoodie', skuId: keepWhiteM.id, qty: 4, unitPrice: 99 }],
  payType: 'cash'
}, 3000, 'out-1', keepIds, keepState.skus)
assert.strictEqual(totalStock(keepState.skus, 'p-hoodie'), 6)
assert.strictEqual(inv.findBlankSku(keepState.skus, 'p-hoodie').stock, 6)

const keepSaleLine = inv.firstLine(keepState.records[0])
keepState = inv.applyReturnOrder(keepState.products, keepState.records, {
  items: [{ saleOrderId: 'out-1', saleLineId: keepSaleLine.lineId, qty: 1 }]
}, 4000, keepIds, keepState.skus)
assert.strictEqual(totalStock(keepState.skus, 'p-hoodie'), 7)

// ---------------------------------------------------------------------------
// 不变量 2：退货原样入库 —— 卖待加工，退回来落在卖出时那一格，不回待加工
// ---------------------------------------------------------------------------

assert.strictEqual(inv.findSkuBySpec(keepState.skus, 'p-hoodie', '白色', 'M').stock, 1)
assert.strictEqual(inv.findBlankSku(keepState.skus, 'p-hoodie').stock, 6)
assert.strictEqual(inv.firstLine(keepState.record).saleOrderId, 'out-1')
assert.strictEqual(inv.firstLine(keepState.record).saleLineId, keepSaleLine.lineId)

// 退货行和销售行的 returnedQty 双向一致
const keepSaleAfterReturn = keepState.records.find(function (item) {
  return item.id === 'out-1'
})
assert.strictEqual(keepSaleAfterReturn.lines[0].returnedQty, 1)
assert.strictEqual(inv.returnableQty(keepSaleAfterReturn.lines[0]), 3)

// 删掉退货，销售行的已退数量要减回去，库存也回到退货前
const keepReturnId = keepState.record.id
const keepReturnDeleted = inv.deleteRecord(keepState.products, keepState.records, keepReturnId, 4500, keepState.skus)
assert.strictEqual(keepReturnDeleted.records.find(function (item) {
  return item.id === 'out-1'
}).lines[0].returnedQty, 0)
assert.strictEqual(totalStock(keepReturnDeleted.skus, 'p-hoodie'), 6)
assert.strictEqual(inv.findSkuBySpec(keepReturnDeleted.skus, 'p-hoodie', '白色', 'M').stock, 0)

// 有退货挂着的销售单不能直接删
assert.throws(function () {
  inv.deleteRecord(keepState.products, keepState.records, 'out-1', 4600, keepState.skus)
}, /退货/)

// 改规格只换格不增减件数
keepState = inv.applyConvert(keepState.products, keepState.records, {
  productId: 'p-hoodie',
  fromSkuId: keepWhiteM.id,
  toSkuId: keepRedM.id,
  qty: 1
}, 5000, 'cv-1', keepState.skus)
assert.strictEqual(totalStock(keepState.skus, 'p-hoodie'), 7)
assert.strictEqual(inv.findSkuBySpec(keepState.skus, 'p-hoodie', '白色', 'M').stock, 0)
assert.strictEqual(inv.findSkuBySpec(keepState.skus, 'p-hoodie', '红色', 'M').stock, 1)

const keepBlankSku = inv.findBlankSku(keepState.skus, 'p-hoodie')
keepState = inv.applyAdjust(keepState.products, keepState.records, {
  productId: 'p-hoodie',
  skuId: keepBlankSku.id,
  direction: 'in',
  reason: 'surplus',
  qty: 2
}, 6000, 'aj-1', keepState.skus)
keepState = inv.applyAdjust(keepState.products, keepState.records, {
  productId: 'p-hoodie',
  skuId: keepBlankSku.id,
  direction: 'out',
  reason: 'damage',
  qty: 1
}, 7000, 'aj-2', keepState.skus)

// 进 10 + 盘盈 2 - 报损 1 - 卖 4 + 退 1 = 8
assert.strictEqual(totalStock(keepState.skus, 'p-hoodie'), 8)
assert.strictEqual(keepState.products[0].stock, 8)

// ---------------------------------------------------------------------------
// 不变量 3：整单共享待加工 —— 一张单两行都要同一商品的待加工，
// 总量超过库存时必须整单拒绝，不能两行各把待加工算满
// ---------------------------------------------------------------------------

const shareIds = idFactory('share')
const shareMade = makeHoodie(shareIds)
const shareWhiteM = inv.findSkuBySpec(shareMade.skus, 'p-hoodie', '白色', 'M')
const shareRedM = inv.findSkuBySpec(shareMade.skus, 'p-hoodie', '红色', 'M')
const shareStocked = inv.applyPurchase([shareMade.product], [], {
  productId: 'p-hoodie',
  qty: 5,
  unitPrice: 40
}, 2000, 'share-in', shareMade.skus)
assert.strictEqual(inv.findBlankSku(shareStocked.skus, 'p-hoodie').stock, 5)

assert.throws(function () {
  inv.applySaleOrder(shareStocked.products, shareStocked.records, {
    items: [
      { productId: 'p-hoodie', skuId: shareWhiteM.id, qty: 5, unitPrice: 99 },
      { productId: 'p-hoodie', skuId: shareRedM.id, qty: 1, unitPrice: 99 }
    ],
    payType: 'cash'
  }, 3000, 'share-over', shareIds, shareStocked.skus)
}, /库存不足/)
// 整单被拒之后库存一件没动
assert.strictEqual(inv.findBlankSku(shareStocked.skus, 'p-hoodie').stock, 5)
assert.strictEqual(totalStock(shareStocked.skus, 'p-hoodie'), 5)

const shareOk = inv.applySaleOrder(shareStocked.products, shareStocked.records, {
  items: [
    { productId: 'p-hoodie', skuId: shareWhiteM.id, qty: 3, unitPrice: 99 },
    { productId: 'p-hoodie', skuId: shareRedM.id, qty: 2, unitPrice: 99 }
  ],
  payType: 'cash'
}, 3000, 'share-ok', shareIds, shareStocked.skus)
assert.strictEqual(inv.findBlankSku(shareOk.skus, 'p-hoodie').stock, 0)
assert.strictEqual(shareOk.record.lines.length, 2)
assert.strictEqual(shareOk.record.amount, 495)

// 改单也不能两行各算满：本单已占 5 件，两行都想加到 5 件时必须报库存不足
assert.throws(function () {
  inv.updateRecord(shareOk.products, shareOk.records, {
    id: 'share-ok',
    items: [
      { id: shareOk.record.lines[0].lineId, qty: 5, unitPrice: 99 },
      { id: shareOk.record.lines[1].lineId, qty: 5, unitPrice: 99 }
    ],
    payType: 'cash',
    customerId: ''
  }, 4000, shareOk.skus)
}, /库存不足/)

// ---------------------------------------------------------------------------
// 多行退货单：一次退两行是一条退货记录，改 / 删都要和销售行的 returnedQty 对上
// ---------------------------------------------------------------------------

const twoLineReturn = inv.applyReturnOrder(shareOk.products, shareOk.records, {
  items: [
    { saleOrderId: 'share-ok', saleLineId: shareOk.record.lines[0].lineId, qty: 2 },
    { saleOrderId: 'share-ok', saleLineId: shareOk.record.lines[1].lineId, qty: 1 }
  ]
}, 5000, shareIds, shareOk.skus)
assert.strictEqual(twoLineReturn.record.lines.length, 2)
assert.strictEqual(twoLineReturn.record.amount, 297)
assert.strictEqual(twoLineReturn.recordsCreated.length, 1)
const soldAfterTwo = twoLineReturn.records.find(function (item) {
  return item.id === 'share-ok'
})
assert.strictEqual(soldAfterTwo.lines[0].returnedQty, 2)
assert.strictEqual(soldAfterTwo.lines[1].returnedQty, 1)
assert.strictEqual(inv.findSkuBySpec(twoLineReturn.skus, 'p-hoodie', '白色', 'M').stock, 2)
assert.strictEqual(inv.findSkuBySpec(twoLineReturn.skus, 'p-hoodie', '红色', 'M').stock, 1)

// 退多了要拦住（第一行只卖了 3 件，已退 2 件）
assert.throws(function () {
  inv.applyReturnOrder(twoLineReturn.products, twoLineReturn.records, {
    items: [{ saleOrderId: 'share-ok', saleLineId: shareOk.record.lines[0].lineId, qty: 2 }]
  }, 5100, shareIds, twoLineReturn.skus)
}, /可退数量 1/)

// 一次退货不跨销售单
assert.throws(function () {
  inv.applyReturnOrder(twoLineReturn.products, twoLineReturn.records, {
    items: [
      { saleOrderId: 'share-ok', saleLineId: shareOk.record.lines[0].lineId, qty: 1 },
      { saleOrderId: 'nope', saleLineId: 'nope-l1', qty: 1 }
    ]
  }, 5100, shareIds, twoLineReturn.skus)
}, /销售流水不存在/)

// 改退货数量：库存和销售行的已退数量一起动
const returnEdited = inv.updateRecord(twoLineReturn.products, twoLineReturn.records, {
  id: twoLineReturn.record.id,
  items: [
    { id: twoLineReturn.record.lines[0].lineId, qty: 1 },
    { id: twoLineReturn.record.lines[1].lineId, qty: 2 }
  ]
}, 5200, twoLineReturn.skus)
const soldAfterEdit = returnEdited.records.find(function (item) {
  return item.id === 'share-ok'
})
assert.strictEqual(soldAfterEdit.lines[0].returnedQty, 1)
assert.strictEqual(soldAfterEdit.lines[1].returnedQty, 2)
assert.strictEqual(returnEdited.record.amount, 297)
assert.strictEqual(inv.findSkuBySpec(returnEdited.skus, 'p-hoodie', '白色', 'M').stock, 1)
assert.strictEqual(inv.findSkuBySpec(returnEdited.skus, 'p-hoodie', '红色', 'M').stock, 2)

// 改到超过可退数量要拦住（第二行只卖了 2 件）
assert.throws(function () {
  inv.updateRecord(twoLineReturn.products, twoLineReturn.records, {
    id: twoLineReturn.record.id,
    items: [
      { id: twoLineReturn.record.lines[0].lineId, qty: 2 },
      { id: twoLineReturn.record.lines[1].lineId, qty: 3 }
    ]
  }, 5300, twoLineReturn.skus)
}, /可退数量 2/)

// 删整张退货单：两行的已退数量都要减回去
const returnDropped = inv.deleteRecord(returnEdited.products, returnEdited.records, twoLineReturn.record.id, 5400, returnEdited.skus)
const soldAfterDrop = returnDropped.records.find(function (item) {
  return item.id === 'share-ok'
})
assert.strictEqual(soldAfterDrop.lines[0].returnedQty, 0)
assert.strictEqual(soldAfterDrop.lines[1].returnedQty, 0)
assert.strictEqual(inv.findSkuBySpec(returnDropped.skus, 'p-hoodie', '白色', 'M').stock, 0)
assert.strictEqual(inv.findSkuBySpec(returnDropped.skus, 'p-hoodie', '红色', 'M').stock, 0)
assert.strictEqual(totalStock(returnDropped.skus, 'p-hoodie'), 0)

// 有退货挂着时不能改小销售数量
assert.throws(function () {
  inv.updateRecord(twoLineReturn.products, twoLineReturn.records, {
    id: 'share-ok',
    items: [
      { id: shareOk.record.lines[0].lineId, qty: 1, unitPrice: 99 },
      { id: shareOk.record.lines[1].lineId, qty: 2, unitPrice: 99 }
    ],
    payType: 'cash',
    customerId: ''
  }, 5500, twoLineReturn.skus)
}, /不能小于已退货 2/)

// ---------------------------------------------------------------------------
// 不变量 4：库存调整只改件数，不进销售 / 毛利 / 欠款，也不改进价
// ---------------------------------------------------------------------------

const adjProduct = inv.createProduct({
  name: '调整货',
  costPrice: 10,
  salePrice: 20,
  stock: 5,
  alertQty: 1
}, 1000, 'p-adj')
const adjBought = inv.applyPurchase([adjProduct], [], {
  productId: 'p-adj',
  qty: 2,
  unitPrice: 12
}, 2000, 'adj-in')
const beforeAdjust = inv.computeTotals(adjBought.records)
const adjIn = inv.applyAdjust(adjBought.products, adjBought.records, {
  productId: 'p-adj',
  direction: 'in',
  reason: 'gift',
  qty: 3
}, 3000, 'adj-1')
const adjOut = inv.applyAdjust(adjIn.products, adjIn.records, {
  productId: 'p-adj',
  direction: 'out',
  reason: 'damage',
  qty: 1
}, 4000, 'adj-2')
const afterAdjust = inv.computeTotals(adjOut.records)
assert.deepStrictEqual(pickTotals(afterAdjust), pickTotals(beforeAdjust))
assert.strictEqual(adjOut.products[0].stock, 9)
assert.strictEqual(adjOut.products[0].costPrice, 12)
assert.strictEqual(adjOut.record.amount, 0)
assert.strictEqual(adjOut.record.profit, 0)
assert.ok(!adjOut.record.customerId)
assert.deepStrictEqual(inv.summarizeAllCustomerAccounts(adjOut.records), {})

// ---------------------------------------------------------------------------
// 迁移：老的「一行一条」归并成「一张单一条」
// ---------------------------------------------------------------------------

function legacyRecord(overrides) {
  return Object.assign({
    id: '',
    type: '',
    productId: 'p1',
    productName: '货',
    sku: '',
    qty: 0,
    unitPrice: 0,
    costPrice: 0,
    amount: 0,
    profit: 0,
    remark: '',
    customerId: '',
    customerName: '',
    createdAt: 0
  }, overrides)
}

// 按写入顺序：进货 → 两行同 orderId 的销售 → 无 orderId 的散销售 → 退货 → 收款 → 期初
// 实际存储是 unshift，所以数组里是倒序
const legacyStored = [
  legacyRecord({ id: 'op1', type: 'opening', productId: '', productName: '期初欠款', amount: 15, unitPrice: 15, customerId: 'c1', customerName: '甲', createdAt: 6000 }),
  legacyRecord({ id: 'pay1', type: 'pay', productId: '', productName: '收款', amount: 20, unitPrice: 20, payType: 'cash', customerId: 'c1', customerName: '甲', createdAt: 5000 }),
  legacyRecord({ id: 'ret1', type: 'return', orderId: 'order-1', saleRecordId: 'oa', qty: 1, unitPrice: 50, costPrice: 20, amount: 50, profit: -30, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 4000 }),
  legacyRecord({ id: 'oc', type: 'out', qty: 1, unitPrice: 40, costPrice: 32, amount: 40, profit: 8, payType: 'cash', customerId: 'c2', customerName: '乙', createdAt: 3000 }),
  legacyRecord({ id: 'ob', type: 'out', orderId: 'order-1', productName: '面包', qty: 1, unitPrice: 50, costPrice: 40, amount: 50, profit: 10, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 2000, operatorName: '小李' }),
  legacyRecord({ id: 'oa', type: 'out', orderId: 'order-1', productName: '牛奶', qty: 2, unitPrice: 50, costPrice: 35, amount: 100, profit: 30, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 2000, operatorName: '小李', allocations: [{ skuId: 's1', qty: 2, source: 'ready', color: '白', size: 'M', costPrice: 35 }] }),
  legacyRecord({ id: 'r1', type: 'in', qty: 5, unitPrice: 30, costPrice: 30, amount: 150, createdAt: 1000 })
]

assert.strictEqual(inv.needsRecordMigration(legacyStored), true)
const migrated = inv.migrateRecordShape(legacyStored)
assert.strictEqual(inv.needsRecordMigration(migrated), false)

// 6 条：期初 / 收款 / 退货 / 散销售 / order-1 / 进货
assert.strictEqual(migrated.length, 6)
assert.deepStrictEqual(migrated.map(function (item) {
  return item.id
}), ['op1', 'pay1', 'ret1', 'oc', 'order-1', 'r1'])

const migratedOrder = migrated.find(function (item) {
  return item.id === 'order-1'
})
// 归并后行顺序恢复成开单顺序，lineId 用老记录的 id
assert.strictEqual(migratedOrder.lines.length, 2)
assert.deepStrictEqual(migratedOrder.lines.map(function (line) {
  return line.lineId
}), ['oa', 'ob'])
assert.strictEqual(migratedOrder.amount, 150)
assert.strictEqual(migratedOrder.profit, 40)
assert.strictEqual(migratedOrder.paidAmount, 0)
assert.strictEqual(migratedOrder.customerId, 'c1')
assert.strictEqual(migratedOrder.operatorName, '小李')
assert.strictEqual(migratedOrder.createdAt, 2000)
// allocations 逐行保留，退货原样入库全靠它
assert.strictEqual(migratedOrder.lines[0].allocations.length, 1)
assert.strictEqual(migratedOrder.lines[0].allocations[0].source, 'ready')
assert.deepStrictEqual(migratedOrder.lines[1].allocations, [])

// 无 orderId 的散记录以自身 id 单独成单，不能被并进别人
const migratedLoose = migrated.find(function (item) {
  return item.id === 'oc'
})
assert.strictEqual(migratedLoose.lines.length, 1)
assert.strictEqual(migratedLoose.lines[0].lineId, 'oc')

// 退货指回销售行；销售行的 returnedQty 回填
const migratedReturn = migrated.find(function (item) {
  return item.id === 'ret1'
})
assert.strictEqual(migratedReturn.lines[0].saleOrderId, 'order-1')
assert.strictEqual(migratedReturn.lines[0].saleLineId, 'oa')
assert.strictEqual(migratedOrder.lines[0].returnedQty, 1)
assert.strictEqual(migratedOrder.lines[1].returnedQty, 0)
assert.strictEqual(inv.returnableQty(migratedOrder.lines[0]), 1)

// 收款 / 期初没有商品，lines 为空，金额留在单头
assert.deepStrictEqual(migrated[0].lines, [])
assert.strictEqual(migrated[0].amount, 15)
assert.deepStrictEqual(migrated[1].lines, [])
assert.strictEqual(migrated[1].amount, 20)

// 迁移后的老单不带冻结欠款字段，送货单按当前流水现算
assert.ok(!Object.prototype.hasOwnProperty.call(migratedOrder, 'receivableSnapshot'))
assert.strictEqual(inv.receivableAt(migrated, 'c1', 2000), 150)

// 聚合值迁移前后一致。count 单独比：老形状下 summarizeAllCustomerAccounts 靠
// orderId 去重才得到 1 单，新形状下一张单本来就是一条记录，结果同样是 1 单。
function pickAccount(account) {
  return {
    amount: account.amount,
    creditAmount: account.creditAmount,
    paidAmount: account.paidAmount,
    receivable: account.receivable
  }
}
const legacyAccounts = inv.summarizeAllCustomerAccounts(legacyStored)
const migratedAccounts = inv.summarizeAllCustomerAccounts(migrated)
assert.deepStrictEqual(Object.keys(migratedAccounts).sort(), Object.keys(legacyAccounts).sort())
Object.keys(migratedAccounts).forEach(function (customerId) {
  assert.deepStrictEqual(pickAccount(migratedAccounts[customerId]), pickAccount(legacyAccounts[customerId]),
    '客户 ' + customerId + ' 迁移前后金额必须一致')
})
assert.strictEqual(migratedAccounts.c1.count, 1)
assert.strictEqual(migratedAccounts.c2.count, 1)
assert.strictEqual(migratedAccounts.c1.receivable, 95)
assert.deepStrictEqual(
  pickTotals(inv.computeTotals(migrated)),
  pickTotals(inv.computeTotals(legacyStored))
)

// 已经是新形状的记录混进来时原样带过，不会被重复回填 returnedQty
const mixed = inv.migrateRecordShape([
  migratedOrder,
  migratedReturn,
  legacyRecord({ id: 'r2', type: 'in', qty: 1, unitPrice: 1, amount: 1, createdAt: 500 })
])
assert.strictEqual(mixed[0].lines[0].returnedQty, 1)
assert.strictEqual(mixed[2].lines.length, 1)

// ---------------------------------------------------------------------------
// 老形状重放 vs 新形状重放：totals 和每客户 account 必须相等
// ---------------------------------------------------------------------------

function toLegacyShape(records) {
  const out = []
  records.forEach(function (record) {
    const lines = inv.recordLines(record)
    const shared = {
      type: record.type,
      remark: record.remark || '',
      customerId: record.customerId || '',
      customerName: record.customerName || '',
      customerPhone: record.customerPhone || '',
      customerAddress: record.customerAddress || '',
      operatorOpenid: record.operatorOpenid,
      operatorName: record.operatorName,
      createdAt: record.createdAt
    }
    if (!lines.length) {
      out.push(Object.assign({}, shared, {
        id: record.id,
        productId: '',
        productName: record.type === 'pay' ? '收款' : '期初欠款',
        sku: '',
        qty: 0,
        unitPrice: record.amount,
        costPrice: 0,
        amount: record.amount,
        profit: record.profit
      }))
      return
    }
    // 老形状一行一记录，整单的结算金额要拆到每一行上；欠款贡献是线性的
    // （Σ(amount − paid)），怎么切都不影响聚合，所以贪心填满就行。
    let paidLeft = inv.round2(record.paidAmount != null
      ? record.paidAmount
      : (record.payType === 'credit' ? 0 : record.amount))
    // 老数据是 unshift 进数组的，同一单的行倒着存
    lines.slice().reverse().forEach(function (line) {
      const rowPaid = Math.min(inv.round2(line.amount), paidLeft)
      paidLeft = inv.round2(paidLeft - rowPaid)
      out.push(Object.assign({}, shared, {
        id: line.lineId,
        orderId: record.type === 'out' ? record.id : record.id,
        productId: line.productId,
        productName: line.productName,
        sku: line.sku,
        skuId: line.skuId,
        color: line.color,
        size: line.size,
        qty: line.qty,
        unitPrice: line.unitPrice,
        costPrice: line.costPrice,
        amount: line.amount,
        profit: line.profit,
        paidAmount: rowPaid,
        allocations: line.allocations,
        saleRecordId: line.saleLineId,
        reason: line.reason
      }))
    })
  })
  return out
}

const replayIds = idFactory('replay')
// 2b-1 起流水不在账本文档里，记账要先把牵连到的那几条从流水仓捞出来。
// MemoryBook 的记账主体和 ledger-core.js 的事务体一样，只是同步、不鉴权。
const book = new MemoryBook({ shopId: 'replay-shop', nextId: replayIds })
let clock = 1000

function mut(action, payload) {
  clock += 10
  return book.mutate(action, payload, clock)
}

const milk = mut('saveProduct', { name: '牛奶', costPrice: 2, salePrice: 5, stock: 100, alertQty: 5 }).product
const bread = mut('saveProduct', { name: '面包', costPrice: 5, salePrice: 10, stock: 100, alertQty: 5 }).product
const custA = mut('saveCustomer', { name: '甲店' }).customer
const custB = mut('saveCustomer', { name: '乙店' }).customer

mut('addPurchase', { productId: milk.id, qty: 20, unitPrice: 2.5 })
const orderA = mut('addSale', {
  customerId: custA.id,
  payType: 'credit',
  items: [
    { productId: milk.id, qty: 4, unitPrice: 5 },
    { productId: bread.id, qty: 2, unitPrice: 10 }
  ]
}).order
mut('addSale', {
  customerId: custB.id,
  payType: 'cash',
  items: [{ productId: bread.id, qty: 3, unitPrice: 10 }]
})
mut('addPayment', { customerId: custA.id, amount: 12 })
mut('addReturn', { items: [{ saleOrderId: orderA.id, saleLineId: orderA.lines[0].lineId, qty: 1 }] })
mut('addOpening', { customerId: custB.id, amount: 30 })
mut('addAdjust', { productId: milk.id, direction: 'in', reason: 'surplus', qty: 2 })

const newLists = book.lists()
// 老形状的同一批流水，归并回来之后聚合必须逐字段相等。
// 2b-1 起账本文档里的 accounts / aggregate 是增量维护出来的，所以这里比的是
// 「增量维护的结果」和「老形状全量重折叠的结果」—— 比 2a 更强的一条断言。
const legacyRecords = apply.legacyRecordsOf({ records: toLegacyShape(newLists.records) })
const legacyTotals = inv.summarizeRecords(legacyRecords)
const legacyAccountsReplay = inv.summarizeAllCustomerAccounts(legacyRecords)

assert.strictEqual(inv.needsRecordMigration(newLists.records), false)
assert.strictEqual(legacyRecords.length, newLists.records.length)
assert.deepStrictEqual(pickTotals(legacyTotals), pickTotals(newLists.totals))
assert.strictEqual(legacyTotals.count, newLists.totals.count)
newLists.customers.forEach(function (customer) {
  const legacyAccount = legacyAccountsReplay[customer.id] || {
    count: 0, amount: 0, creditAmount: 0, paidAmount: 0, receivable: 0
  }
  assert.deepStrictEqual(legacyAccount, customer.account,
    '客户 ' + customer.name + ' 迁移前后账目必须一致')
})
assert.ok(newLists.totals.receivable > 0)

// 逐条比对形状：老数据归并回来的单，和新代码直接写出来的单一模一样。
// 唯一对不上的是退货单号：老数据没有「退货单」这个对象，只有一行行退货记录，
// 归并时只能拿第一行的 id 当单号（就是 saleOrderIdOf 的 orderId || id 兜底）。
function normalizeIds(records) {
  return records.map(function (record) {
    if (record.type !== 'return') return record
    return Object.assign({}, record, { id: '<return>' })
  })
}
assert.deepStrictEqual(normalizeIds(legacyRecords), normalizeIds(newLists.records))
newLists.records.forEach(function (record, at) {
  if (record.type === 'return') {
    assert.strictEqual(legacyRecords[at].id, record.lines[0].lineId)
    return
  }
  assert.strictEqual(legacyRecords[at].id, record.id)
})

// ---------------------------------------------------------------------------
// 老账本文档首次读写即自愈，不需要迁移脚本
// ---------------------------------------------------------------------------

const oldDoc = {
  revision: 7,
  products: [{ id: 'p1', name: '牛奶', costPrice: 2, salePrice: 5, stock: 10, alertQty: 5, colors: [], sizes: [] }],
  skus: [],
  customers: [{ id: 'c1', name: '甲店' }],
  categories: [],
  records: [
    { id: 'l2', type: 'out', orderId: 'ord1', productId: 'p1', productName: '牛奶', qty: 1, unitPrice: 5, costPrice: 2, amount: 5, profit: 3, payType: 'credit', customerId: 'c1', customerName: '甲店', createdAt: 2000 },
    { id: 'l1', type: 'out', orderId: 'ord1', productId: 'p1', productName: '牛奶', qty: 2, unitPrice: 5, costPrice: 2, amount: 10, profit: 6, payType: 'credit', customerId: 'c1', customerName: '甲店', createdAt: 2000 },
    { id: 'in1', type: 'in', productId: 'p1', productName: '牛奶', qty: 10, unitPrice: 2, costPrice: 2, amount: 20, profit: 0, createdAt: 1000 }
  ]
}

const oldRead = apply.legacyRecordsOf(oldDoc)
assert.strictEqual(oldRead.length, 2)
assert.strictEqual(inv.needsRecordMigration(oldRead), false)
const oldAccounts = inv.summarizeAllCustomerAccounts(oldRead)
assert.strictEqual(oldAccounts.c1.receivable, 15)
assert.strictEqual(oldAccounts.c1.count, 1)

// 2b-1 起「读时自愈」只管读：写路径见到没搬完的账本要停下来报错，
// 不能新账进集合、老账留数组。归并仍然是同一份 migrateRecordShape。
assert.strictEqual(apply.recordsPending(oldDoc), true)

// 老单归并进流水仓之后继续做业务：退 1 件，已退数量落到对应的行上
const healIds = idFactory('heal')
const healBook = new MemoryBook({ shopId: 'heal-shop', nextId: healIds }).seed(oldRead, {
  products: oldDoc.products,
  skus: oldDoc.skus,
  customers: oldDoc.customers,
  categories: oldDoc.categories
})
healBook.mutate('addReturn', {
  items: [{ saleOrderId: 'ord1', saleLineId: 'l1', qty: 1 }]
}, 5000)
const healedLists = healBook.lists()
const healedOrder = healedLists.records.find(function (item) {
  return item.id === 'ord1'
})
assert.strictEqual(inv.needsRecordMigration(healedLists.records), false)
assert.strictEqual(healedOrder.lines[0].returnedQty, 1)
assert.strictEqual(healedOrder.lines[1].returnedQty, 0)
assert.strictEqual(healedLists.products[0].stock, 11)
assert.strictEqual(healedLists.customers[0].account.receivable, 10)
assert.throws(function () {
  healBook.mutate('addReturn', {
    items: [{ saleOrderId: 'ord1', saleLineId: 'l1', qty: 2 }]
  }, 6000)
}, /可退数量 1/)

// ---------------------------------------------------------------------------
// 视图层：列表只渲染单头，明细和 openid 不进 setData
// ---------------------------------------------------------------------------

const orderRecord = newLists.records.find(function (item) {
  return item.type === 'out' && item.lines.length > 1
})
const orderView = util.withRecordView(orderRecord)
assert.ok(!Object.prototype.hasOwnProperty.call(orderView, 'lines'))
assert.ok(!Object.prototype.hasOwnProperty.call(orderView, 'operatorOpenid'))
assert.strictEqual(orderView.lineCount, 2)
assert.strictEqual(orderView.isMulti, true)
assert.strictEqual(orderView.qty, 6)
assert.strictEqual(orderView.productName, '牛奶、面包')
assert.strictEqual(orderView.amountText, util.money(orderRecord.amount))

const payView = util.withRecordView(newLists.records.find(function (item) {
  return item.type === 'pay'
}))
assert.strictEqual(payView.productName, '收款')
assert.strictEqual(payView.qtyText, '')
const openingView = util.withRecordView(newLists.records.find(function (item) {
  return item.type === 'opening'
}))
assert.strictEqual(openingView.productName, '期初欠款')

const adjustView = util.withRecordView(newLists.records.find(function (item) {
  return item.type === 'adjust_in'
}))
assert.strictEqual(adjustView.typeText, '盘盈')
assert.strictEqual(adjustView.qtyText, '2')

// ---------------------------------------------------------------------------
// B1：改 / 删更早的记录后，晚些那张单重印的送货单要跟账面对得上
// 欠款一律按当前流水重算，不能用写入时冻结的值
// ---------------------------------------------------------------------------

// 2b-2b 删掉了 util.withSlipViewFromRecord：生产上「截断到某张老单据时刻的
// 欠款」唯一的算法在服务端 getSlip（当前欠款减去该单之后的后缀），客户端拿不到
// 流水全集，也就没有任何现算钱的路径。
//
// 但 B1 那四个回归场景要验的是**口径本身**（改 / 删更早的记录之后，重印的
// 送货单必须跟账面对得上），和它是在哪一端算的无关。所以那两行搬进测试本地，
// 下面的断言一个都不改。服务端那条路的等价性由 tests/ledger-records.test.js
// 的「getSlip 与 receivableAt 等价」钉住。
function slipFromRecord(records, record, products, shopName) {
  if (!record || record.type !== 'out') {
    throw new Error('不是销售流水')
  }
  const list = records || []
  const missing = record.customerId && !list.some(function (item) {
    return item.id === record.id
  })
  if (missing) {
    throw new Error('流水不完整，无法算欠款')
  }
  return util.withSlipView(
    record,
    inv.receivableAt(list, record.customerId, record.createdAt),
    products,
    shopName
  )
}

function slipOf(records, products, id) {
  return slipFromRecord(records, records.find(function (item) {
    return item.id === id
  }), products, '店')
}

// 甲：t=1000 赊账 100（20×5）→ t=2000 赊账 50（10×5）
function twoCreditSales() {
  const product = inv.createProduct({
    name: '牛奶', costPrice: 3, salePrice: 5, stock: 1000, alertQty: 1
  }, 1, 'sp1')
  const first = inv.applySaleOrder([product], [], {
    customerId: 'c1', customerName: '甲', payType: 'credit',
    items: [{ productId: 'sp1', qty: 20, unitPrice: 5 }]
  }, 1000, 'oA', idFactory('la'), [])
  const second = inv.applySaleOrder(first.products, first.records, {
    customerId: 'c1', customerName: '甲', payType: 'credit',
    items: [{ productId: 'sp1', qty: 10, unitPrice: 5 }]
  }, 2000, 'oB', idFactory('lb'), first.skus)
  return {
    products: second.products,
    skus: second.skus,
    records: second.records,
    lineA: first.record.lines[0].lineId,
    orderB: second.record
  }
}

const slipBase = twoCreditSales()
assert.ok(!Object.prototype.hasOwnProperty.call(slipBase.orderB, 'receivableSnapshot'))
const slipBeforeEdit = slipOf(slipBase.records, slipBase.products, 'oB')
assert.strictEqual(slipBeforeEdit.prevDebtText, '100.00')
assert.strictEqual(slipBeforeEdit.thisDebtText, '50.00')
assert.strictEqual(slipBeforeEdit.receivableText, '150.00')

// 场景 1：改更早的销售单 100 → 200
const caseEdit = twoCreditSales()
const editedEarlier = inv.updateRecord(caseEdit.products, caseEdit.records, {
  id: 'oA',
  payType: 'credit',
  customerId: 'c1',
  customerName: '甲',
  items: [{ id: caseEdit.lineA, qty: 40, unitPrice: 5 }]
}, 3000, caseEdit.skus)
const slipAfterEdit = slipOf(editedEarlier.records, editedEarlier.products, 'oB')
assert.strictEqual(slipAfterEdit.prevDebtText, '200.00')
assert.strictEqual(slipAfterEdit.thisDebtText, '50.00')
assert.strictEqual(slipAfterEdit.receivableText, '250.00')
assert.strictEqual(
  slipAfterEdit.receivableText,
  util.money(inv.summarizeCustomerAccount(editedEarlier.records, 'c1').receivable)
)

// 场景 2：删更早的销售单
const caseDelete = twoCreditSales()
const removedEarlier = inv.deleteRecord(
  caseDelete.products, caseDelete.records, 'oA', 3000, caseDelete.skus
)
const slipAfterDelete = slipOf(removedEarlier.records, removedEarlier.products, 'oB')
assert.strictEqual(slipAfterDelete.prevDebtText, '0.00')
assert.strictEqual(slipAfterDelete.receivableText, '50.00')
assert.strictEqual(
  slipAfterDelete.receivableText,
  util.money(inv.summarizeCustomerAccount(removedEarlier.records, 'c1').receivable)
)

// 场景 3：改更早的收款单 30 → 60
const payProduct = inv.createProduct({
  name: '牛奶', costPrice: 3, salePrice: 5, stock: 1000, alertQty: 1
}, 1, 'sp1')
const payFirst = inv.applySaleOrder([payProduct], [], {
  customerId: 'c1', customerName: '甲', payType: 'credit',
  items: [{ productId: 'sp1', qty: 20, unitPrice: 5 }]
}, 1000, 'oA', idFactory('la'), [])
const payMid = inv.applyPayment(payFirst.records, {
  customerId: 'c1', customerName: '甲', amount: 30
}, 1500, 'pay-1')
const paySecond = inv.applySaleOrder(payFirst.products, payMid.records, {
  customerId: 'c1', customerName: '甲', payType: 'credit',
  items: [{ productId: 'sp1', qty: 10, unitPrice: 5 }]
}, 2000, 'oB', idFactory('lb'), payFirst.skus)
const slipWithPay = slipOf(paySecond.records, paySecond.products, 'oB')
assert.strictEqual(slipWithPay.prevDebtText, '70.00')
assert.strictEqual(slipWithPay.receivableText, '120.00')

const editedPay = inv.updateRecord(paySecond.products, paySecond.records, {
  id: 'pay-1', amount: 60
}, 3000, paySecond.skus)
const slipAfterPayEdit = slipOf(editedPay.records, editedPay.products, 'oB')
assert.strictEqual(slipAfterPayEdit.prevDebtText, '40.00')
assert.strictEqual(slipAfterPayEdit.thisDebtText, '50.00')
assert.strictEqual(slipAfterPayEdit.receivableText, '90.00')
assert.strictEqual(
  slipAfterPayEdit.receivableText,
  util.money(inv.summarizeCustomerAccount(editedPay.records, 'c1').receivable)
)

// 场景 4：迁移出来的老数据同样按当前流水算
const legacySlipStored = [
  legacyRecord({ id: 'lb1', type: 'out', productId: 'lp1', orderId: 'order-B', qty: 10, unitPrice: 5, costPrice: 3, amount: 50, profit: 20, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 2000 }),
  legacyRecord({ id: 'la1', type: 'out', productId: 'lp1', orderId: 'order-A', qty: 20, unitPrice: 5, costPrice: 3, amount: 100, profit: 40, payType: 'credit', customerId: 'c1', customerName: '甲', createdAt: 1000 })
]
const legacySlipProduct = inv.createProduct({
  name: '货', costPrice: 3, salePrice: 5, stock: 10, alertQty: 1
}, 1, 'lp1')
const migratedSlip = inv.migrateRecordShape(legacySlipStored)
const migratedOrderB = migratedSlip.find(function (item) {
  return item.id === 'order-B'
})
assert.ok(!Object.prototype.hasOwnProperty.call(migratedOrderB, 'receivableSnapshot'))
const migratedSlipView = slipOf(migratedSlip, [legacySlipProduct], 'order-B')
assert.strictEqual(migratedSlipView.prevDebtText, '100.00')
assert.strictEqual(migratedSlipView.receivableText, '150.00')

const legacyDeleted = inv.deleteRecord([legacySlipProduct], migratedSlip, 'order-A', 3000, [])
const migratedSlipAfter = slipOf(legacyDeleted.records, legacyDeleted.products, 'order-B')
assert.strictEqual(migratedSlipAfter.prevDebtText, '0.00')
assert.strictEqual(migratedSlipAfter.receivableText, '50.00')
assert.strictEqual(
  migratedSlipAfter.receivableText,
  util.money(inv.summarizeCustomerAccount(legacyDeleted.records, 'c1').receivable)
)

console.log('record shape tests passed')
