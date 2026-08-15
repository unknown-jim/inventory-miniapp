function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback)
}

function round2(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function calcMargin(costPrice, salePrice) {
  const cost = toNumber(costPrice)
  const sale = toNumber(salePrice)
  const profit = round2(sale - cost)
  const rate = sale === 0 ? 0 : round2((profit / sale) * 100)
  return { profit, rate }
}

function isLowStock(product) {
  return toNumber(product.stock) <= toNumber(product.alertQty)
}

function createProduct(input, now, id) {
  const name = String(input.name || '').trim()
  if (!name) {
    throw new Error('请填写商品名称')
  }

  const costPrice = round2(input.costPrice)
  const salePrice = round2(input.salePrice)
  if (costPrice < 0 || salePrice < 0) {
    throw new Error('价格不能为负数')
  }

  const stock = round2(input.stock)
  if (stock < 0) {
    throw new Error('库存不能为负数')
  }

  const alertQty = input.alertQty === '' || input.alertQty == null
    ? 5
    : round2(input.alertQty)
  if (alertQty < 0) {
    throw new Error('预警数量不能为负数')
  }

  return {
    id: id,
    name: name,
    sku: String(input.sku || '').trim(),
    barcode: String(input.barcode || '').trim(),
    costPrice: costPrice,
    salePrice: salePrice,
    stock: stock,
    alertQty: alertQty,
    createdAt: now,
    updatedAt: now
  }
}

function updateProduct(existing, input, now) {
  if (!existing) {
    throw new Error('商品不存在')
  }
  const next = createProduct({
    name: input.name,
    sku: input.sku,
    barcode: input.barcode,
    costPrice: input.costPrice,
    salePrice: input.salePrice,
    alertQty: input.alertQty,
    stock: existing.stock
  }, now, existing.id)
  next.createdAt = existing.createdAt
  next.stock = existing.stock
  return next
}

function applyPurchase(products, records, payload, now, id) {
  const qty = round2(payload.qty)
  const unitPrice = round2(payload.unitPrice)
  if (qty <= 0) {
    throw new Error('进货数量必须大于 0')
  }
  if (unitPrice < 0) {
    throw new Error('进价不能为负数')
  }

  const index = products.findIndex(function (item) {
    return item.id === payload.productId
  })
  if (index < 0) {
    throw new Error('商品不存在')
  }

  const product = Object.assign({}, products[index])
  product.stock = round2(product.stock + qty)
  product.costPrice = unitPrice
  product.updatedAt = now

  const nextProducts = products.slice()
  nextProducts[index] = product

  const record = {
    id: id,
    type: 'in',
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    qty: qty,
    unitPrice: unitPrice,
    costPrice: unitPrice,
    amount: round2(qty * unitPrice),
    profit: 0,
    remark: String(payload.remark || '').trim(),
    createdAt: now
  }

  return {
    products: nextProducts,
    records: [record].concat(records),
    record: record
  }
}

function applySale(products, records, payload, now, id) {
  const qty = round2(payload.qty)
  const unitPrice = round2(payload.unitPrice)
  if (qty <= 0) {
    throw new Error('销售数量必须大于 0')
  }
  if (unitPrice < 0) {
    throw new Error('售价不能为负数')
  }

  const index = products.findIndex(function (item) {
    return item.id === payload.productId
  })
  if (index < 0) {
    throw new Error('商品不存在')
  }

  const product = Object.assign({}, products[index])
  if (product.stock < qty) {
    throw new Error('库存不足，当前库存 ' + product.stock)
  }

  product.stock = round2(product.stock - qty)
  product.updatedAt = now

  const nextProducts = products.slice()
  nextProducts[index] = product

  const record = {
    id: id,
    type: 'out',
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    qty: qty,
    unitPrice: unitPrice,
    costPrice: product.costPrice,
    amount: round2(qty * unitPrice),
    profit: round2((unitPrice - product.costPrice) * qty),
    remark: String(payload.remark || '').trim(),
    createdAt: now
  }

  return {
    products: nextProducts,
    records: [record].concat(records),
    record: record
  }
}

function getDashboard(products, records, now) {
  const start = startOfDay(now)
  const todayOut = records.filter(function (item) {
    return item.type === 'out' && item.createdAt >= start
  })
  const todayIn = records.filter(function (item) {
    return item.type === 'in' && item.createdAt >= start
  })
  const alerts = products.filter(isLowStock).sort(function (a, b) {
    return a.stock - b.stock
  })

  return {
    productCount: products.length,
    totalStock: round2(products.reduce(function (sum, item) {
      return sum + toNumber(item.stock)
    }, 0)),
    todaySalesAmount: round2(todayOut.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    todayProfit: round2(todayOut.reduce(function (sum, item) {
      return sum + toNumber(item.profit)
    }, 0)),
    todayInAmount: round2(todayIn.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    alertCount: alerts.length,
    alerts: alerts,
    recent: records.slice(0, 10)
  }
}

function filterProducts(products, keyword) {
  const query = String(keyword || '').trim().toLowerCase()
  if (!query) {
    return products.slice()
  }
  return products.filter(function (item) {
    return item.name.toLowerCase().indexOf(query) >= 0
      || (item.sku && item.sku.toLowerCase().indexOf(query) >= 0)
      || (item.barcode && item.barcode.toLowerCase().indexOf(query) >= 0)
  })
}

function filterRecords(records, type) {
  if (!type || type === 'all') {
    return records.slice()
  }
  return records.filter(function (item) {
    return item.type === type
  })
}

function summarizeRecords(records) {
  const sales = records.filter(function (item) {
    return item.type === 'out'
  })
  const purchases = records.filter(function (item) {
    return item.type === 'in'
  })
  return {
    salesAmount: round2(sales.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    purchaseAmount: round2(purchases.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    profit: round2(sales.reduce(function (sum, item) {
      return sum + toNumber(item.profit)
    }, 0)),
    count: records.length
  }
}

function buildSeed(now, nextId) {
  const templates = [
    { name: '纯牛奶 250ml', sku: 'MK-001', barcode: '690123400001', costPrice: 2.8, salePrice: 4.5, stock: 48, alertQty: 12 },
    { name: '全麦面包', sku: 'BD-002', barcode: '690123400002', costPrice: 5.5, salePrice: 9.9, stock: 8, alertQty: 10 },
    { name: '鸡蛋 30枚', sku: 'EG-003', barcode: '690123400003', costPrice: 16, salePrice: 22.8, stock: 20, alertQty: 6 },
    { name: '矿泉水 550ml', sku: 'WT-004', barcode: '690123400004', costPrice: 0.8, salePrice: 2, stock: 3, alertQty: 24 }
  ]

  const products = templates.map(function (item, index) {
    return createProduct(item, now - (index + 1) * 3600000, nextId())
  })

  let records = []
  let working = products

  const saleMilk = applySale(working, records, {
    productId: products[0].id,
    qty: 6,
    unitPrice: 4.5,
    remark: '示例销售'
  }, now - 40 * 60000, nextId())
  working = saleMilk.products
  records = saleMilk.records

  const saleBread = applySale(working, records, {
    productId: products[1].id,
    qty: 2,
    unitPrice: 9.9,
    remark: '示例销售'
  }, now - 25 * 60000, nextId())
  working = saleBread.products
  records = saleBread.records

  const purchaseWater = applyPurchase(working, records, {
    productId: products[3].id,
    qty: 12,
    unitPrice: 0.8,
    remark: '示例进货'
  }, now - 10 * 60000, nextId())

  return {
    products: purchaseWater.products,
    records: purchaseWater.records
  }
}

module.exports = {
  toNumber: toNumber,
  round2: round2,
  startOfDay: startOfDay,
  calcMargin: calcMargin,
  isLowStock: isLowStock,
  createProduct: createProduct,
  updateProduct: updateProduct,
  applyPurchase: applyPurchase,
  applySale: applySale,
  getDashboard: getDashboard,
  filterProducts: filterProducts,
  filterRecords: filterRecords,
  summarizeRecords: summarizeRecords,
  buildSeed: buildSeed
}
