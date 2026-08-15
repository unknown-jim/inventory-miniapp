const inventory = require('./inventory')

const KEYS = {
  products: 'inv_products',
  records: 'inv_records',
  customers: 'inv_customers',
  skus: 'inv_skus',
  categories: 'inv_categories'
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

function getProducts() {
  return readList(KEYS.products)
}

function getRecords() {
  return readList(KEYS.records)
}

function getCustomers() {
  return readList(KEYS.customers)
}

function getCategories() {
  return readList(KEYS.categories)
}

function getSkus() {
  return readList(KEYS.skus)
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

function saveProduct(input) {
  const products = getProducts()
  const now = Date.now()
  let product
  let index = -1
  if (input.id) {
    index = products.findIndex(function (item) {
      return item.id === input.id
    })
    if (index < 0) {
      throw new Error('商品不存在')
    }
    product = inventory.updateProduct(products[index], input, now)
  } else {
    product = inventory.createProduct(input, now, uid())
  }
  const applied = inventory.applyProductSkus(product, getSkus(), input.skus, now, uid)
  product = applied.product
  if (index >= 0) {
    products[index] = product
  } else {
    products.unshift(product)
  }
  writeList(KEYS.products, products)
  writeList(KEYS.skus, applied.skus)
  return products
}

function deleteProduct(id) {
  writeList(KEYS.products, getProducts().filter(function (item) {
    return item.id !== id
  }))
  writeList(KEYS.skus, getSkus().filter(function (item) {
    return item.productId !== id
  }))
}

function saveCustomer(input) {
  const customers = getCustomers()
  const now = Date.now()
  let saved
  if (input.id) {
    const index = customers.findIndex(function (item) {
      return item.id === input.id
    })
    if (index < 0) {
      throw new Error('客户不存在')
    }
    saved = inventory.updateCustomer(customers[index], input, now)
    customers[index] = saved
  } else {
    saved = inventory.createCustomer(input, now, uid())
    customers.unshift(saved)
  }
  writeList(KEYS.customers, customers)
  return saved
}

function deleteCustomer(id) {
  writeList(KEYS.customers, getCustomers().filter(function (item) {
    return item.id !== id
  }))
}

function saveCategory(input) {
  const categories = getCategories()
  const now = Date.now()
  let saved
  if (input.id) {
    const index = categories.findIndex(function (item) {
      return item.id === input.id
    })
    if (index < 0) {
      throw new Error('种类不存在')
    }
    saved = inventory.updateCategory(categories[index], input, now)
    categories[index] = saved
  } else {
    saved = inventory.createCategory(input, now, uid())
    categories.unshift(saved)
  }
  writeList(KEYS.categories, categories)
  return saved
}

function deleteCategory(id) {
  writeList(KEYS.categories, getCategories().filter(function (item) {
    return item.id !== id
  }))
}

function appendCategoryValue(id, field, value) {
  const category = getCategory(id)
  if (!category) return null
  const saved = inventory.appendCategoryValue(category, field, value, Date.now())
  if (saved === category) return category
  const categories = getCategories()
  const index = categories.findIndex(function (item) {
    return item.id === id
  })
  if (index < 0) return null
  categories[index] = saved
  writeList(KEYS.categories, categories)
  return saved
}

function markCustomerSold(id, now) {
  const customers = getCustomers()
  const index = customers.findIndex(function (item) {
    return item.id === id
  })
  if (index < 0) return
  customers[index] = Object.assign({}, customers[index], { lastSaleAt: now })
  writeList(KEYS.customers, customers)
}

function addPurchase(payload) {
  const result = inventory.applyPurchase(getProducts(), getRecords(), payload, Date.now(), uid(), getSkus())
  writeList(KEYS.products, result.products)
  writeList(KEYS.skus, result.skus)
  writeList(KEYS.records, result.records)
  return result.record
}

function addSale(payload) {
  const extra = {}
  if (payload.customerId) {
    const customer = getCustomer(payload.customerId)
    if (!customer) {
      throw new Error('客户不存在')
    }
    extra.customerId = customer.id
    extra.customerName = customer.name
    extra.customerPhone = customer.phone
    extra.customerAddress = customer.address
  }
  const now = Date.now()
  const result = inventory.applySaleOrder(
    getProducts(),
    getRecords(),
    Object.assign({}, extra, {
      payType: payload.payType,
      remark: payload.remark,
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
    uid(),
    uid,
    getSkus()
  )
  writeList(KEYS.products, result.products)
  writeList(KEYS.skus, result.skus)
  writeList(KEYS.records, result.records)
  if (extra.customerId) {
    markCustomerSold(extra.customerId, now)
  }
  return result.order
}

function addReturn(payload) {
  const result = inventory.applyReturnOrder(
    getProducts(),
    getRecords(),
    payload,
    Date.now(),
    uid,
    getSkus()
  )
  writeList(KEYS.products, result.products)
  writeList(KEYS.skus, result.skus)
  writeList(KEYS.records, result.records)
  return result.recordsCreated
}

function addConvert(payload) {
  const result = inventory.applyConvert(
    getProducts(),
    getRecords(),
    payload,
    Date.now(),
    uid(),
    getSkus()
  )
  writeList(KEYS.products, result.products)
  writeList(KEYS.skus, result.skus)
  writeList(KEYS.records, result.records)
  return result.record
}

function addPayment(payload) {
  const customer = getCustomer(payload.customerId)
  if (!customer) {
    throw new Error('客户不存在')
  }
  const result = inventory.applyPayment(getRecords(), {
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerAddress: customer.address,
    amount: payload.amount,
    remark: payload.remark
  }, Date.now(), uid())
  writeList(KEYS.records, result.records)
  return result.record
}

function addOpening(payload) {
  const customer = getCustomer(payload.customerId)
  if (!customer) {
    throw new Error('客户不存在')
  }
  const result = inventory.applyOpening(getRecords(), {
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerAddress: customer.address,
    amount: payload.amount,
    remark: payload.remark
  }, Date.now(), uid())
  writeList(KEYS.records, result.records)
  return result.record
}

function customerSnapshot(customerId) {
  if (!customerId) {
    return {
      customerId: '',
      customerName: '',
      customerPhone: '',
      customerAddress: ''
    }
  }
  const customer = getCustomer(customerId)
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

function updateRecord(id, payload) {
  const extra = {}
  const existing = getRecord(id)
  if (!existing) {
    throw new Error('流水不存在')
  }
  if (existing.type === 'out') {
    Object.assign(extra, customerSnapshot(payload.customerId))
  }
  const now = Date.now()
  const result = inventory.updateRecord(
    getProducts(),
    getRecords(),
    Object.assign({}, payload, extra, { id: id }),
    now,
    getSkus()
  )
  writeList(KEYS.products, result.products)
  writeList(KEYS.skus, result.skus)
  writeList(KEYS.records, result.records)
  if (extra.customerId) {
    markCustomerSold(extra.customerId, now)
  }
  return result.record
}

function deleteRecord(id) {
  const result = inventory.deleteRecord(getProducts(), getRecords(), id, Date.now(), getSkus())
  writeList(KEYS.products, result.products)
  writeList(KEYS.skus, result.skus)
  writeList(KEYS.records, result.records)
}

function loadSeed() {
  const seed = inventory.buildSeed(Date.now(), uid)
  writeList(KEYS.products, seed.products)
  writeList(KEYS.skus, seed.skus || [])
  writeList(KEYS.records, seed.records)
  writeList(KEYS.customers, seed.customers || [])
  writeList(KEYS.categories, seed.categories || [])
  return seed
}

function clearAll() {
  writeList(KEYS.products, [])
  writeList(KEYS.skus, [])
  writeList(KEYS.records, [])
  writeList(KEYS.customers, [])
  writeList(KEYS.categories, [])
}

function dashboard() {
  return inventory.getDashboard(getProducts(), getRecords(), Date.now(), getSkus())
}

module.exports = {
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
  dashboard: dashboard
}
