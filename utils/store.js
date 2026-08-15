const inventory = require('./inventory')

const KEYS = {
  products: 'inv_products',
  records: 'inv_records'
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

function getProduct(id) {
  return getProducts().find(function (item) {
    return item.id === id
  }) || null
}

function saveProduct(input) {
  const products = getProducts()
  const now = Date.now()
  if (input.id) {
    const index = products.findIndex(function (item) {
      return item.id === input.id
    })
    if (index < 0) {
      throw new Error('商品不存在')
    }
    products[index] = inventory.updateProduct(products[index], input, now)
  } else {
    products.unshift(inventory.createProduct(input, now, uid()))
  }
  writeList(KEYS.products, products)
  return products
}

function deleteProduct(id) {
  writeList(KEYS.products, getProducts().filter(function (item) {
    return item.id !== id
  }))
}

function addPurchase(payload) {
  const result = inventory.applyPurchase(getProducts(), getRecords(), payload, Date.now(), uid())
  writeList(KEYS.products, result.products)
  writeList(KEYS.records, result.records)
  return result.record
}

function addSale(payload) {
  const result = inventory.applySale(getProducts(), getRecords(), payload, Date.now(), uid())
  writeList(KEYS.products, result.products)
  writeList(KEYS.records, result.records)
  return result.record
}

function loadSeed() {
  const seed = inventory.buildSeed(Date.now(), uid)
  writeList(KEYS.products, seed.products)
  writeList(KEYS.records, seed.records)
  return seed
}

function clearAll() {
  writeList(KEYS.products, [])
  writeList(KEYS.records, [])
}

function dashboard() {
  return inventory.getDashboard(getProducts(), getRecords(), Date.now())
}

module.exports = {
  getProducts: getProducts,
  getRecords: getRecords,
  getProduct: getProduct,
  saveProduct: saveProduct,
  deleteProduct: deleteProduct,
  addPurchase: addPurchase,
  addSale: addSale,
  loadSeed: loadSeed,
  clearAll: clearAll,
  dashboard: dashboard
}
