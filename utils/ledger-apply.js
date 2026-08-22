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

function emptyLedger() {
  return {
    products: [],
    skus: [],
    records: [],
    customers: [],
    categories: [],
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

function emptyCustomerAccount() {
  return { count: 0, amount: 0, creditAmount: 0, paidAmount: 0, receivable: 0 }
}

function withAggregates(lists) {
  // 累加器（分）算好之后存进 lists.accounts / lists.aggregate —— 这两个字段
  // 会随 lists 一起落库，是账本的缓存值。回传给客户端的 customers[].account /
  // totals 是从累加器投影出来的元。2b-0 里这份累加器仍是每次全量重折叠，
  // 不做增量维护；增量入口 applyTermsDelta 只在测试里验证等价性。
  const accounts = inventory.foldAccountTerms(lists.records)
  const aggregate = inventory.foldTotalTerms(lists.records)
  lists.accounts = accounts
  lists.aggregate = aggregate
  lists.customers = (lists.customers || []).map(function (customer) {
    const terms = accounts[customer.id]
    return Object.assign({}, customer, {
      account: terms ? inventory.accountOf(terms) : emptyCustomerAccount()
    })
  })
  lists.totals = inventory.totalsOf(aggregate)
  return lists
}

function listsOf(ledger) {
  // 先把老的「一行一条」流水归并成「一单一条」，再算聚合值：
  // 聚合值读的是单头字段，形状不对会算错。老文档首次读写即自愈，不需要迁移脚本。
  const records = cloneList(ledger && ledger.records)
  return withAggregates({
    products: cloneList(ledger && ledger.products),
    skus: cloneList(ledger && ledger.skus),
    records: inventory.needsRecordMigration(records)
      ? inventory.migrateRecordShape(records)
      : records,
    customers: cloneList(ledger && ledger.customers),
    categories: cloneList(ledger && ledger.categories),
    revision: (ledger && ledger.revision) || 0
  })
}

function listsHaveData(lists) {
  if (!lists) return false
  return !!(
    (lists.products && lists.products.length)
    || (lists.skus && lists.skus.length)
    || (lists.records && lists.records.length)
    || (lists.customers && lists.customers.length)
    || (lists.categories && lists.categories.length)
  )
}

function snapshotLists(ledger, now) {
  return {
    products: cloneList(ledger && ledger.products),
    skus: cloneList(ledger && ledger.skus),
    records: cloneList(ledger && ledger.records),
    customers: cloneList(ledger && ledger.customers),
    categories: cloneList(ledger && ledger.categories),
    savedAt: now || 0
  }
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

function applyMutation(ledger, action, payload, now, nextId) {
  payload = payload || {}
  const next = listsOf(ledger)
  next.clearSnapshots = cloneList(ledger && ledger.clearSnapshots)
  next.lastRestoredClearAt = (ledger && ledger.lastRestoredClearAt) || 0
  const result = {}

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
      next.records,
      payload,
      now,
      nextId(),
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    next.records = applied.records
    result.record = applied.record
  } else if (action === 'addSale') {
    const extra = customerSnapshot(next.customers, payload.customerId)
    const applied = inventory.applySaleOrder(
      next.products,
      next.records,
      Object.assign({}, extra, {
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
    next.records = applied.records
    if (extra.customerId) {
      markCustomerSold(next.customers, extra.customerId, now)
    }
    result.order = applied.order
  } else if (action === 'addReturn') {
    const applied = inventory.applyReturnOrder(
      next.products,
      next.records,
      payload,
      now,
      nextId,
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    next.records = applied.records
    result.recordsCreated = applied.recordsCreated
  } else if (action === 'addConvert') {
    const applied = inventory.applyConvert(
      next.products,
      next.records,
      payload,
      now,
      nextId(),
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    next.records = applied.records
    result.record = applied.record
  } else if (action === 'addAdjust') {
    const applied = inventory.applyAdjust(
      next.products,
      next.records,
      payload,
      now,
      nextId(),
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    next.records = applied.records
    result.record = applied.record
  } else if (action === 'addPayment') {
    const extra = customerSnapshot(next.customers, payload.customerId)
    const applied = inventory.applyPayment(next.records, Object.assign({}, extra, {
      amount: payload.amount,
      remark: payload.remark
    }), now, nextId())
    next.records = applied.records
    result.record = applied.record
  } else if (action === 'addOpening') {
    const extra = customerSnapshot(next.customers, payload.customerId)
    const applied = inventory.applyOpening(next.records, Object.assign({}, extra, {
      amount: payload.amount,
      remark: payload.remark
    }), now, nextId())
    next.records = applied.records
    result.record = applied.record
  } else if (action === 'updateRecord') {
    const existing = findById(next.records, payload.id)
    if (!existing) {
      throw new Error('流水不存在')
    }
    const extra = {}
    if (existing.type === 'out') {
      Object.assign(extra, customerSnapshot(next.customers, payload.customerId))
    }
    const applied = inventory.updateRecord(
      next.products,
      next.records,
      Object.assign({}, payload, extra, { id: payload.id }),
      now,
      next.skus
    )
    next.products = applied.products
    next.skus = applied.skus
    next.records = applied.records
    if (extra.customerId) {
      markCustomerSold(next.customers, extra.customerId, now)
    }
    result.record = applied.record
  } else if (action === 'deleteRecord') {
    const applied = inventory.deleteRecord(next.products, next.records, payload.id, now, next.skus)
    next.products = applied.products
    next.skus = applied.skus
    next.records = applied.records
  } else if (action === 'loadSeed') {
    const seed = inventory.buildSeed(now, nextId)
    next.products = seed.products
    next.skus = seed.skus || []
    next.records = seed.records
    next.customers = seed.customers || []
    next.categories = seed.categories || []
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
    next.records = []
    next.customers = []
    next.categories = []
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
    next.products = cloneList(snapshot.products)
    next.skus = cloneList(snapshot.skus)
    next.records = cloneList(snapshot.records)
    next.customers = cloneList(snapshot.customers)
    next.categories = cloneList(snapshot.categories)
    next.lastRestoredClearAt = latest.savedAt
  } else {
    throw new Error('未知操作')
  }

  next.revision = ((ledger && ledger.revision) || 0) + 1
  return {
    ledger: withAggregates(next),
    result: result
  }
}

module.exports = {
  MUTATIONS: MUTATIONS,
  emptyLedger: emptyLedger,
  listsOf: listsOf,
  listsHaveData: listsHaveData,
  snapshotLists: snapshotLists,
  latestClearMeta: latestClearMeta,
  hasClearedBackup: hasClearedBackup,
  applyMutation: applyMutation
}
