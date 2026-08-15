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

function uniqueSpecs(list) {
  const seen = {}
  const out = []
  ;(list || []).forEach(function (item) {
    const value = String(item || '').trim()
    if (!value || seen[value]) return
    seen[value] = true
    out.push(value)
  })
  return out
}

function specKey(color, size) {
  return String(color || '').trim() + '\u0001' + String(size || '').trim()
}

function specText(color, size) {
  const parts = []
  if (String(color || '').trim()) parts.push(String(color).trim())
  if (String(size || '').trim()) parts.push(String(size).trim())
  return parts.join(' · ')
}

function productHasSpecs(product) {
  return !!(product && ((product.colors && product.colors.length) || (product.sizes && product.sizes.length)))
}

function specSelectHint(product) {
  const needColor = !!(product && product.colors && product.colors.length)
  const needSize = !!(product && product.sizes && product.sizes.length)
  if (needColor && needSize) return '请选择颜色和尺码'
  if (needColor) return '请选择颜色'
  if (needSize) return '请选择尺码'
  return ''
}

function skuCombos(colors, sizes) {
  const colorList = uniqueSpecs(colors)
  const sizeList = uniqueSpecs(sizes)
  if (!colorList.length && !sizeList.length) return []
  const c = colorList.length ? colorList : ['']
  const s = sizeList.length ? sizeList : ['']
  const out = []
  c.forEach(function (color) {
    s.forEach(function (size) {
      out.push({ color: color, size: size })
    })
  })
  return out
}

function skusOfProduct(skus, productId) {
  return (skus || []).filter(function (item) {
    return item.productId === productId
  })
}

function findSkuBySpec(skus, productId, color, size) {
  const key = specKey(color, size)
  return skusOfProduct(skus, productId).find(function (item) {
    return !item.isBlank && specKey(item.color, item.size) === key
  }) || null
}

function isBlankProcess(product) {
  return !!(product && product.blankProcess && productHasSpecs(product))
}

function isBlankSku(sku) {
  return !!(sku && sku.isBlank)
}

function findBlankSku(skus, productId) {
  return skusOfProduct(skus, productId).find(function (item) {
    return item.isBlank
  }) || null
}

function cloneList(list) {
  return (list || []).map(function (item) {
    return Object.assign({}, item)
  })
}

function saleReturnQty(records, saleRecordId) {
  const id = String(saleRecordId || '')
  if (!id) return 0
  return round2((records || []).reduce(function (sum, item) {
    return item.type === 'return' && item.saleRecordId === id
      ? sum + toNumber(item.qty)
      : sum
  }, 0))
}

function returnableQty(records, saleRecord) {
  if (!saleRecord || saleRecord.type !== 'out') return 0
  return round2(toNumber(saleRecord.qty) - saleReturnQty(records, saleRecord.id))
}

function addSkuStock(skuList, skuId, qty, now, costPrice, product) {
  const skuIndex = skuList.findIndex(function (item) {
    return item.id === skuId
  })
  if (skuIndex < 0) {
    throw new Error('规格不存在')
  }
  const sku = Object.assign({}, skuList[skuIndex])
  const delta = round2(qty)
  const nextStock = round2(sku.stock + delta)
  if (nextStock < 0) {
    throw new Error(stockLabel(product || { name: '' }, sku) + ' 库存不足，当前库存 ' + sku.stock)
  }
  if (delta > 0 && costPrice != null && nextStock > 0) {
    sku.costPrice = round2((toNumber(sku.stock) * toNumber(sku.costPrice) + delta * toNumber(costPrice)) / nextStock)
  }
  sku.stock = nextStock
  sku.updatedAt = now
  skuList[skuIndex] = sku
  return sku
}

function restoreAllocations(skuList, allocations, now, product) {
  ;(allocations || []).forEach(function (row) {
    addSkuStock(skuList, row.skuId, row.qty, now, null, product)
  })
}

function resolveSaleSpec(product, skus, payload) {
  if (payload.skuId) {
    const sku = (skus || []).find(function (item) {
      return item.id === payload.skuId
    })
    if (!sku || sku.productId !== product.id || sku.isBlank) {
      throw new Error(specSelectHint(product) || '请选择颜色和尺码')
    }
    return { color: sku.color, size: sku.size, sku: sku }
  }
  const color = String(payload.color || '').trim()
  const size = String(payload.size || '').trim()
  const needColor = !!(product.colors && product.colors.length)
  const needSize = !!(product.sizes && product.sizes.length)
  if ((needColor && !color) || (needSize && !size)) {
    throw new Error(specSelectHint(product) || '请选择颜色和尺码')
  }
  const sku = findSkuBySpec(skus, product.id, color, size)
  if (!sku) {
    throw new Error('规格不存在')
  }
  return { color: sku.color, size: sku.size, sku: sku }
}

function allocateBlankLine(product, skuList, color, size, qty, now) {
  const allocations = []
  let left = round2(qty)
  const ready = findSkuBySpec(skuList, product.id, color, size)
  if (!ready) {
    throw new Error('规格不存在')
  }
  const takeReady = round2(Math.min(toNumber(ready.stock), left))
  if (takeReady > 0) {
    const costPrice = ready.costPrice
    addSkuStock(skuList, ready.id, -takeReady, now, null, product)
    allocations.push({
      skuId: ready.id,
      qty: takeReady,
      source: 'ready',
      color: ready.color,
      size: ready.size,
      costPrice: costPrice
    })
    left = round2(left - takeReady)
  }
  if (left > 0) {
    const blank = findBlankSku(skuList, product.id)
    if (!blank) {
      throw new Error('白坯不存在')
    }
    const takeBlank = round2(Math.min(toNumber(blank.stock), left))
    if (takeBlank > 0) {
      const costPrice = blank.costPrice
      addSkuStock(skuList, blank.id, -takeBlank, now, null, product)
      allocations.push({
        skuId: blank.id,
        qty: takeBlank,
        source: 'blank',
        color: '',
        size: '',
        costPrice: costPrice
      })
      left = round2(left - takeBlank)
    }
  }
  if (left > 0) {
    throw new Error(product.name + ' ' + specText(color, size) + ' 库存不足，可出 ' + round2(qty - left))
  }
  const costSum = allocations.reduce(function (sum, item) {
    return sum + toNumber(item.costPrice) * toNumber(item.qty)
  }, 0)
  return {
    allocations: allocations,
    costPrice: round2(costSum / qty),
    skuId: ready.id,
    color: ready.color,
    size: ready.size,
    skuCode: ready.sku || product.sku
  }
}

function blankAvailability(product, skus, color, size, reservedItems) {
  const working = cloneList(skus)
  try {
    ;(reservedItems || []).forEach(function (item) {
      if (item.productId !== product.id) return
      const spec = resolveSaleSpec(product, working, item)
      allocateBlankLine(product, working, spec.color, spec.size, round2(item.qty), 0)
    })
  } catch (error) {
    return { total: 0, ready: 0, blank: 0 }
  }
  const ready = findSkuBySpec(working, product.id, color, size)
  const blank = findBlankSku(working, product.id)
  const readyQty = round2(ready ? ready.stock : 0)
  const blankQty = round2(blank ? blank.stock : 0)
  return {
    total: round2(readyQty + blankQty),
    ready: readyQty,
    blank: blankQty
  }
}

function assertSaleItems(products, skus, items) {
  let workingProducts = cloneList(products)
  let workingSkus = cloneList(skus)
  ;(items || []).forEach(function (item) {
    const consumed = consumeSaleLine(workingProducts, workingSkus, item, 0)
    workingProducts = consumed.products
    workingSkus = consumed.skus
  })
}

function consumeSaleLine(products, skus, payload, now) {
  const qty = round2(payload.qty)
  const index = products.findIndex(function (item) {
    return item.id === payload.productId
  })
  if (index < 0) {
    throw new Error('商品不存在')
  }

  const product = Object.assign({}, products[index])
  const skuList = (skus || []).slice()
  let costPrice = product.costPrice
  let skuCode = product.sku
  let skuId = ''
  let color = ''
  let size = ''
  let allocations = []

  if (isBlankProcess(product)) {
    const spec = resolveSaleSpec(product, skuList, payload)
    const allocated = allocateBlankLine(product, skuList, spec.color, spec.size, qty, now)
    allocations = allocated.allocations
    costPrice = allocated.costPrice
    skuId = allocated.skuId
    color = allocated.color
    size = allocated.size
    skuCode = allocated.skuCode
    product.stock = productStockFromSkus(skuList, product.id)
  } else if (productHasSpecs(product)) {
    const spec = resolveSaleSpec(product, skuList, payload)
    if (spec.sku.stock < qty) {
      throw new Error(product.name + ' ' + specText(spec.sku.color, spec.sku.size) + ' 库存不足，当前库存 ' + spec.sku.stock)
    }
    const sku = Object.assign({}, spec.sku)
    sku.stock = round2(sku.stock - qty)
    sku.updatedAt = now
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === sku.id
    })
    skuList[skuIndex] = sku
    product.stock = productStockFromSkus(skuList, product.id)
    costPrice = sku.costPrice
    skuCode = sku.sku || product.sku
    skuId = sku.id
    color = sku.color
    size = sku.size
  } else {
    if (product.stock < qty) {
      throw new Error(product.name + ' 库存不足，当前库存 ' + product.stock)
    }
    product.stock = round2(product.stock - qty)
  }

  product.updatedAt = now
  const nextProducts = products.slice()
  nextProducts[index] = product
  return {
    products: nextProducts,
    skus: skuList,
    product: product,
    costPrice: costPrice,
    skuCode: skuCode,
    skuId: skuId,
    color: color,
    size: size,
    allocations: allocations
  }
}

function productStockFromSkus(skus, productId) {
  return round2(skusOfProduct(skus, productId).reduce(function (sum, item) {
    return sum + toNumber(item.stock)
  }, 0))
}

function isLowStock(product, skus) {
  if (isBlankProcess(product) && Array.isArray(skus)) {
    const blank = findBlankSku(skus, product.id)
    if (blank) {
      return toNumber(blank.stock) <= toNumber(product.alertQty)
    }
  }
  if (productHasSpecs(product) && Array.isArray(skus)) {
    const list = skusOfProduct(skus, product.id).filter(function (item) {
      return !item.isBlank
    })
    if (list.length) {
      return list.some(function (sku) {
        return toNumber(sku.stock) <= toNumber(sku.alertQty)
      })
    }
  }
  return toNumber(product.stock) <= toNumber(product.alertQty)
}

function skuSummaryText(product, skus) {
  const list = skusOfProduct(skus, product.id)
  if (!list.length) return ''
  const parts = []
  if (isBlankProcess(product)) {
    const blank = findBlankSku(skus, product.id)
    parts.push('白坯 ' + (blank ? blank.stock : 0))
    list.forEach(function (item) {
      if (item.isBlank || toNumber(item.stock) <= 0) return
      parts.push(specText(item.color, item.size) + ' ' + item.stock)
    })
  } else {
    list.forEach(function (item) {
      parts.push(specText(item.color, item.size) + ' ' + item.stock)
    })
  }
  const head = parts.slice(0, 4).join(' · ')
  return parts.length > 4 ? head + ' …' : head
}

function createSku(input, now, id) {
  const productId = String(input.productId || '')
  if (!productId) {
    throw new Error('商品不存在')
  }
  const isBlank = !!input.isBlank
  const color = isBlank ? '' : String(input.color || '').trim()
  const size = isBlank ? '' : String(input.size || '').trim()
  if (!isBlank && !color && !size) {
    throw new Error('请填写颜色或尺码')
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
    productId: productId,
    color: color,
    size: size,
    sku: String(input.sku || '').trim(),
    barcode: String(input.barcode || '').trim(),
    costPrice: costPrice,
    salePrice: salePrice,
    stock: stock,
    alertQty: alertQty,
    isBlank: isBlank,
    createdAt: now,
    updatedAt: now
  }
}

function updateSku(existing, input, now) {
  if (!existing) {
    throw new Error('规格不存在')
  }
  const next = createSku({
    productId: existing.productId,
    isBlank: existing.isBlank,
    color: existing.isBlank ? '' : (input.color != null ? input.color : existing.color),
    size: existing.isBlank ? '' : (input.size != null ? input.size : existing.size),
    sku: input.sku != null ? input.sku : existing.sku,
    barcode: input.barcode != null ? input.barcode : existing.barcode,
    costPrice: input.costPrice != null ? input.costPrice : existing.costPrice,
    salePrice: input.salePrice != null ? input.salePrice : existing.salePrice,
    stock: existing.stock,
    alertQty: input.alertQty != null ? input.alertQty : existing.alertQty
  }, now, existing.id)
  next.createdAt = existing.createdAt
  next.stock = existing.stock
  return next
}

function applyProductSkus(product, allSkus, skuInputs, now, nextId) {
  const existing = skusOfProduct(allSkus, product.id)
  if (!productHasSpecs(product)) {
    const nextProduct = Object.assign({}, product, { blankProcess: false })
    if (existing.length) {
      nextProduct.stock = productStockFromSkus(existing, product.id)
      nextProduct.updatedAt = now
    }
    return {
      product: nextProduct,
      skus: (allSkus || []).filter(function (item) {
        return item.productId !== product.id
      })
    }
  }

  const combos = skuCombos(product.colors, product.sizes)
  const inputList = skuInputs == null ? existing : skuInputs
  const blankProcess = isBlankProcess(product)
  const existingBlank = existing.find(function (item) {
    return item.isBlank
  })

  if (!blankProcess && existingBlank && toNumber(existingBlank.stock) > 0) {
    throw new Error('还有白坯库存，不能改成成衣现货')
  }

  existing.forEach(function (old) {
    if (old.isBlank) return
    const kept = combos.some(function (combo) {
      return specKey(combo.color, combo.size) === specKey(old.color, old.size)
    })
    if (!kept && toNumber(old.stock) > 0) {
      throw new Error('「' + specText(old.color, old.size) + '」还有库存，不能删除该规格')
    }
  })

  let nextForProduct = combos.map(function (combo) {
    const key = specKey(combo.color, combo.size)
    const row = inputList.find(function (item) {
      return !item.isBlank && specKey(item.color, item.size) === key
    })
    const prev = existing.find(function (item) {
      return !item.isBlank && specKey(item.color, item.size) === key
    })
    const payload = {
      productId: product.id,
      color: combo.color,
      size: combo.size,
      sku: row && row.sku != null ? row.sku : (prev ? prev.sku : ''),
      barcode: row && row.barcode != null ? row.barcode : (prev ? prev.barcode : ''),
      costPrice: row && row.costPrice != null ? row.costPrice : (prev ? prev.costPrice : product.costPrice),
      salePrice: row && row.salePrice != null ? row.salePrice : (prev ? prev.salePrice : product.salePrice),
      stock: prev ? prev.stock : (row && row.stock != null ? row.stock : 0),
      alertQty: blankProcess
        ? 0
        : (row && row.alertQty != null ? row.alertQty : (prev ? prev.alertQty : product.alertQty))
    }
    if (prev) {
      return updateSku(prev, payload, now)
    }
    return createSku(payload, now, nextId())
  })

  if (blankProcess) {
    const blankStock = existingBlank
      ? existingBlank.stock
      : (!existing.filter(function (item) { return !item.isBlank }).length ? round2(product.stock) : 0)
    const blankPayload = {
      productId: product.id,
      isBlank: true,
      color: '',
      size: '',
      costPrice: existingBlank ? existingBlank.costPrice : product.costPrice,
      salePrice: product.salePrice,
      stock: blankStock,
      alertQty: product.alertQty
    }
    const blankSku = existingBlank
      ? updateSku(existingBlank, blankPayload, now)
      : createSku(blankPayload, now, nextId())
    blankSku.stock = blankStock
    nextForProduct = [blankSku].concat(nextForProduct)
  } else if (!existing.filter(function (item) { return !item.isBlank }).length && toNumber(product.stock) > 0) {
    const hasAny = nextForProduct.some(function (item) {
      return toNumber(item.stock) > 0
    })
    if (!hasAny) {
      nextForProduct[0].stock = round2(product.stock)
    }
  }

  const nextProduct = Object.assign({}, product, {
    stock: round2(nextForProduct.reduce(function (sum, item) {
      return sum + toNumber(item.stock)
    }, 0)),
    updatedAt: now
  })

  return {
    product: nextProduct,
    skus: (allSkus || []).filter(function (item) {
      return item.productId !== product.id
    }).concat(nextForProduct)
  }
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

  const colors = uniqueSpecs(input.colors)
  const sizes = uniqueSpecs(input.sizes)
  const hasSpecs = !!(colors.length || sizes.length)
  if (input.blankProcess && !hasSpecs) {
    throw new Error('白坯加工请添加颜色或尺码')
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
    colors: colors,
    sizes: sizes,
    blankProcess: hasSpecs && !!input.blankProcess,
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
    stock: existing.stock,
    colors: input.colors != null ? input.colors : existing.colors,
    sizes: input.sizes != null ? input.sizes : existing.sizes,
    blankProcess: input.blankProcess != null ? input.blankProcess : existing.blankProcess
  }, now, existing.id)
  next.createdAt = existing.createdAt
  next.stock = existing.stock
  return next
}

function applyPurchase(products, records, payload, now, id, skus) {
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
  const skuList = (skus || []).slice()
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

  if (isBlankProcess(product)) {
    const blank = findBlankSku(skuList, product.id)
    if (!blank) {
      throw new Error('白坯不存在')
    }
    const sku = Object.assign({}, blank)
    sku.stock = round2(sku.stock + qty)
    sku.costPrice = unitPrice
    sku.updatedAt = now
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === blank.id
    })
    skuList[skuIndex] = sku
    product.stock = productStockFromSkus(skuList, product.id)
    product.costPrice = unitPrice
    product.updatedAt = now
    record.skuId = sku.id
    record.sku = sku.sku || product.sku
    record.costPrice = unitPrice
  } else if (productHasSpecs(product)) {
    if (!payload.skuId) {
      throw new Error(specSelectHint(product))
    }
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === payload.skuId
    })
    if (skuIndex < 0 || skuList[skuIndex].productId !== product.id) {
      throw new Error('规格不存在')
    }
    const sku = Object.assign({}, skuList[skuIndex])
    sku.stock = round2(sku.stock + qty)
    sku.costPrice = unitPrice
    sku.updatedAt = now
    skuList[skuIndex] = sku
    product.stock = productStockFromSkus(skuList, product.id)
    product.updatedAt = now
    record.skuId = sku.id
    record.color = sku.color
    record.size = sku.size
    record.sku = sku.sku || product.sku
    record.costPrice = unitPrice
  } else {
    product.stock = round2(product.stock + qty)
    product.costPrice = unitPrice
    product.updatedAt = now
  }

  const nextProducts = products.slice()
  nextProducts[index] = product

  return {
    products: nextProducts,
    skus: skuList,
    records: [record].concat(records),
    record: record
  }
}

function createCustomer(input, now, id) {
  const name = String(input.name || '').trim()
  if (!name) {
    throw new Error('请填写客户名称')
  }

  return {
    id: id,
    name: name,
    phone: String(input.phone || '').trim(),
    address: String(input.address || '').trim(),
    remark: String(input.remark || '').trim(),
    lastSaleAt: toNumber(input.lastSaleAt),
    createdAt: now,
    updatedAt: now
  }
}

function updateCustomer(existing, input, now) {
  if (!existing) {
    throw new Error('客户不存在')
  }
  const next = createCustomer({
    name: input.name,
    phone: input.phone,
    address: input.address,
    remark: input.remark,
    lastSaleAt: existing.lastSaleAt
  }, now, existing.id)
  next.createdAt = existing.createdAt
  return next
}

function filterCustomers(customers, keyword) {
  const query = String(keyword || '').trim().toLowerCase()
  if (!query) {
    return customers.slice()
  }
  return customers.filter(function (item) {
    return item.name.toLowerCase().indexOf(query) >= 0
      || (item.phone && item.phone.toLowerCase().indexOf(query) >= 0)
      || (item.address && item.address.toLowerCase().indexOf(query) >= 0)
  })
}

function sortCustomers(customers) {
  return customers.slice().sort(function (a, b) {
    const saleDiff = toNumber(b.lastSaleAt) - toNumber(a.lastSaleAt)
    if (saleDiff) return saleDiff
    return toNumber(b.updatedAt) - toNumber(a.updatedAt)
  })
}

function isCreditSale(record) {
  return record && record.type === 'out' && record.payType === 'credit'
}

function isCreditReturn(record) {
  return record && record.type === 'return' && record.payType === 'credit'
}

function summarizeCustomerAccount(records, customerId) {
  const related = records.filter(function (item) {
    return item.customerId === customerId && (item.type === 'out' || item.type === 'pay' || item.type === 'return')
  })
  const sales = related.filter(function (item) {
    return item.type === 'out'
  })
  const returns = related.filter(function (item) {
    return item.type === 'return'
  })
  const payments = related.filter(function (item) {
    return item.type === 'pay'
  })
  const creditAmount = round2(
    sales.reduce(function (sum, item) {
      return isCreditSale(item) ? sum + toNumber(item.amount) : sum
    }, 0) - returns.reduce(function (sum, item) {
      return isCreditReturn(item) ? sum + toNumber(item.amount) : sum
    }, 0)
  )
  const paidAmount = round2(payments.reduce(function (sum, item) {
    return sum + toNumber(item.amount)
  }, 0))
  const saleAmount = round2(
    sales.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0) - returns.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)
  )
  return {
    count: sales.length,
    amount: saleAmount,
    creditAmount: creditAmount,
    paidAmount: paidAmount,
    receivable: round2(creditAmount - paidAmount),
    records: sales,
    ledger: related
  }
}

function getTotalReceivable(records) {
  return round2(records.reduce(function (sum, item) {
    if (isCreditSale(item)) return sum + toNumber(item.amount)
    if (isCreditReturn(item)) return sum - toNumber(item.amount)
    if (item.type === 'pay') return sum - toNumber(item.amount)
    return sum
  }, 0))
}

function applyPayment(records, payload, now, id) {
  const customerId = String(payload.customerId || '')
  if (!customerId) {
    throw new Error('请选择客户')
  }
  const amount = round2(payload.amount)
  if (amount <= 0) {
    throw new Error('收款金额必须大于 0')
  }
  const receivable = summarizeCustomerAccount(records, customerId).receivable
  if (amount > receivable) {
    throw new Error('收款不能超过当前欠款 ' + receivable)
  }

  const record = {
    id: id,
    type: 'pay',
    productId: '',
    productName: '收款',
    sku: '',
    qty: 0,
    unitPrice: amount,
    costPrice: 0,
    amount: amount,
    profit: 0,
    remark: String(payload.remark || '').trim(),
    customerId: customerId,
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    customerAddress: String(payload.customerAddress || '').trim(),
    payType: 'cash',
    createdAt: now
  }

  return {
    records: [record].concat(records),
    record: record
  }
}

function applySale(products, records, payload, now, id, skus) {
  const qty = round2(payload.qty)
  const unitPrice = round2(payload.unitPrice)
  if (qty <= 0) {
    throw new Error('销售数量必须大于 0')
  }
  if (unitPrice < 0) {
    throw new Error('售价不能为负数')
  }

  const payType = payload.payType === 'credit' ? 'credit' : 'cash'
  const customerId = String(payload.customerId || '')
  if (payType === 'credit' && !customerId) {
    throw new Error('赊账必须选择客户')
  }

  const consumed = consumeSaleLine(products, skus, payload, now)
  const record = {
    id: id,
    type: 'out',
    productId: consumed.product.id,
    productName: consumed.product.name,
    sku: consumed.skuCode,
    skuId: consumed.skuId,
    color: consumed.color,
    size: consumed.size,
    qty: qty,
    unitPrice: unitPrice,
    costPrice: consumed.costPrice,
    amount: round2(qty * unitPrice),
    profit: round2((unitPrice - consumed.costPrice) * qty),
    remark: String(payload.remark || '').trim(),
    customerId: customerId,
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    customerAddress: String(payload.customerAddress || '').trim(),
    payType: payType,
    orderId: String(payload.orderId || id),
    allocations: consumed.allocations || [],
    createdAt: now
  }

  return {
    products: consumed.products,
    skus: consumed.skus,
    records: [record].concat(records),
    record: record
  }
}

function applySaleOrder(products, records, payload, now, orderId, nextId, skus) {
  const items = payload.items || []
  if (!items.length) {
    throw new Error('请先加入商品')
  }

  const payType = payload.payType === 'credit' ? 'credit' : 'cash'
  const customerId = String(payload.customerId || '')
  if (payType === 'credit' && !customerId) {
    throw new Error('赊账必须选择客户')
  }

  let previewProducts = cloneList(products)
  let previewSkus = cloneList(skus || [])
  items.forEach(function (item) {
    const consumed = consumeSaleLine(previewProducts, previewSkus, item, now)
    previewProducts = consumed.products
    previewSkus = consumed.skus
  })

  let workingProducts = products
  let workingRecords = records
  let workingSkus = skus || []
  const orderRecords = []
  const shared = {
    customerId: customerId,
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerAddress: payload.customerAddress,
    payType: payType,
    remark: payload.remark,
    orderId: orderId
  }

  items.forEach(function (item) {
    const result = applySale(workingProducts, workingRecords, Object.assign({}, shared, {
      productId: item.productId,
      skuId: item.skuId,
      color: item.color,
      size: item.size,
      qty: item.qty,
      unitPrice: item.unitPrice
    }), now, nextId(), workingSkus)
    workingProducts = result.products
    workingRecords = result.records
    workingSkus = result.skus
    orderRecords.push(result.record)
  })

  return {
    products: workingProducts,
    skus: workingSkus,
    records: workingRecords,
    order: makeSaleOrder(orderId, orderRecords, {
      payType: payType,
      remark: payload.remark,
      customerId: customerId,
      customerName: payload.customerName,
      customerPhone: payload.customerPhone,
      customerAddress: payload.customerAddress
    }, now)
  }
}

function applyConvert(products, records, payload, now, id, skus) {
  const qty = round2(payload.qty)
  if (qty <= 0) {
    throw new Error('改规格数量必须大于 0')
  }

  const index = products.findIndex(function (item) {
    return item.id === payload.productId
  })
  if (index < 0) {
    throw new Error('商品不存在')
  }
  const product = Object.assign({}, products[index])
  if (!productHasSpecs(product)) {
    throw new Error('普通商品不用改规格')
  }

  const skuList = (skus || []).slice()
  const from = skuList.find(function (item) {
    return item.id === payload.fromSkuId
  })
  const to = skuList.find(function (item) {
    return item.id === payload.toSkuId
  })
  if (!from || !to || from.productId !== product.id || to.productId !== product.id) {
    throw new Error('规格不存在')
  }
  if (from.isBlank || to.isBlank) {
    throw new Error('白坯不能改规格，请在销售时选色码')
  }
  if (from.id === to.id) {
    throw new Error('请选择不同的规格')
  }
  if (from.stock < qty) {
    throw new Error(stockLabel(product, from) + ' 库存不足，当前库存 ' + from.stock)
  }

  const costPrice = from.costPrice
  addSkuStock(skuList, from.id, -qty, now, null, product)
  addSkuStock(skuList, to.id, qty, now, costPrice, product)
  product.stock = productStockFromSkus(skuList, product.id)
  product.updatedAt = now
  const nextProducts = products.slice()
  nextProducts[index] = product

  const record = {
    id: id,
    type: 'convert',
    productId: product.id,
    productName: product.name,
    sku: to.sku || product.sku,
    skuId: to.id,
    color: to.color,
    size: to.size,
    fromSkuId: from.id,
    fromColor: from.color,
    fromSize: from.size,
    toSkuId: to.id,
    qty: qty,
    unitPrice: 0,
    costPrice: costPrice,
    amount: 0,
    profit: 0,
    remark: String(payload.remark || '').trim(),
    createdAt: now
  }

  return {
    products: nextProducts,
    skus: skuList,
    records: [record].concat(records),
    record: record
  }
}

function restockRecord(products, skus, record, qty, now, costPrice) {
  const index = products.findIndex(function (item) {
    return item.id === record.productId
  })
  if (index < 0) {
    throw new Error('商品已删除，不能改库存')
  }
  const product = Object.assign({}, products[index])
  const skuList = (skus || []).slice()
  const delta = round2(qty)
  if (record.skuId) {
    addSkuStock(skuList, record.skuId, delta, now, delta > 0 ? costPrice : null, product)
    product.stock = productStockFromSkus(skuList, product.id)
  } else if (productHasSpecs(product)) {
    throw new Error(specSelectHint(product) || '请选择颜色和尺码')
  } else {
    const nextStock = round2(product.stock + delta)
    if (nextStock < 0) {
      throw new Error(product.name + ' 库存不足，当前库存 ' + product.stock)
    }
    product.stock = nextStock
  }
  product.updatedAt = now
  const nextProducts = products.slice()
  nextProducts[index] = product
  return { products: nextProducts, skus: skuList }
}

function applyReturn(products, records, payload, now, id, skus) {
  const sale = (records || []).find(function (item) {
    return item.id === payload.saleRecordId && item.type === 'out'
  })
  if (!sale) {
    throw new Error('销售流水不存在')
  }
  const qty = round2(payload.qty)
  if (qty <= 0) {
    throw new Error('退货数量必须大于 0')
  }
  const remain = returnableQty(records, sale)
  if (qty > remain) {
    throw new Error('退货不能超过可退数量 ' + remain)
  }

  const restocked = restockRecord(products, skus, sale, qty, now, sale.costPrice)
  const record = {
    id: id,
    type: 'return',
    productId: sale.productId,
    productName: sale.productName,
    sku: sale.sku,
    skuId: sale.skuId || '',
    color: sale.color || '',
    size: sale.size || '',
    qty: qty,
    unitPrice: sale.unitPrice,
    costPrice: sale.costPrice,
    amount: round2(qty * toNumber(sale.unitPrice)),
    profit: round2((toNumber(sale.unitPrice) - toNumber(sale.costPrice)) * qty * -1),
    remark: String(payload.remark || '').trim(),
    customerId: sale.customerId || '',
    customerName: sale.customerName || '',
    customerPhone: sale.customerPhone || '',
    customerAddress: sale.customerAddress || '',
    payType: sale.payType === 'credit' ? 'credit' : 'cash',
    orderId: sale.orderId || sale.id,
    saleRecordId: sale.id,
    createdAt: now
  }
  const nextRecords = [record].concat(records)
  assertReceivableValid(nextRecords)
  return {
    products: restocked.products,
    skus: restocked.skus,
    records: nextRecords,
    record: record
  }
}

function applyReturnOrder(products, records, payload, now, nextId, skus) {
  const items = (payload.items || []).filter(function (item) {
    return round2(item.qty) > 0
  })
  if (!items.length) {
    throw new Error('请填写退货数量')
  }
  let workingProducts = products
  let workingRecords = records
  let workingSkus = skus || []
  const returnRecords = []
  items.forEach(function (item) {
    const result = applyReturn(workingProducts, workingRecords, {
      saleRecordId: item.saleRecordId,
      qty: item.qty,
      remark: payload.remark
    }, now, nextId(), workingSkus)
    workingProducts = result.products
    workingRecords = result.records
    workingSkus = result.skus
    returnRecords.push(result.record)
  })
  return {
    products: workingProducts,
    skus: workingSkus,
    records: workingRecords,
    recordsCreated: returnRecords
  }
}

function saleOrderIdOf(record) {
  return String((record && record.orderId) || (record && record.id) || '')
}

function saleOrderRecords(records, record) {
  const orderId = saleOrderIdOf(record)
  return records.filter(function (item) {
    return item.type === 'out' && saleOrderIdOf(item) === orderId
  }).reverse()
}

function makeSaleOrder(orderId, orderRecords, fields, createdAt) {
  return {
    id: orderId,
    records: orderRecords,
    amount: round2(orderRecords.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    profit: round2(orderRecords.reduce(function (sum, item) {
      return sum + toNumber(item.profit)
    }, 0)),
    payType: fields.payType === 'credit' ? 'credit' : 'cash',
    remark: String(fields.remark || '').trim(),
    customerId: String(fields.customerId || ''),
    customerName: String(fields.customerName || '').trim(),
    customerPhone: String(fields.customerPhone || '').trim(),
    customerAddress: String(fields.customerAddress || '').trim(),
    createdAt: createdAt
  }
}

function buildSaleOrder(records, record) {
  if (!record || record.type !== 'out') {
    throw new Error('不是销售流水')
  }
  const orderRecords = saleOrderRecords(records, record)
  if (!orderRecords.length) {
    throw new Error('流水不存在')
  }
  const first = orderRecords[0]
  return makeSaleOrder(saleOrderIdOf(first), orderRecords, first, first.createdAt)
}

function receivableAt(records, customerId, at) {
  if (!customerId) return 0
  const ts = toNumber(at)
  return summarizeCustomerAccount(records.filter(function (item) {
    return toNumber(item.createdAt) <= ts
  }), customerId).receivable
}

function stockLabel(product, sku) {
  if (sku && sku.isBlank) {
    return (product && product.name ? product.name : '') + ' 白坯'
  }
  if (sku) {
    const spec = specText(sku.color, sku.size)
    return spec ? product.name + ' ' + spec : product.name
  }
  return product.name
}

function adjustStock(products, skus, record, delta, now) {
  const qtyDelta = round2(delta)
  if (!qtyDelta) {
    return { products: products, skus: skus || [] }
  }

  const index = products.findIndex(function (item) {
    return item.id === record.productId
  })
  if (index < 0) {
    throw new Error('商品已删除，不能改数量')
  }

  const product = Object.assign({}, products[index])
  const skuList = (skus || []).slice()

  if (record.skuId) {
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === record.skuId
    })
    if (skuIndex < 0 || skuList[skuIndex].productId !== product.id) {
      throw new Error('规格不存在')
    }
    const sku = Object.assign({}, skuList[skuIndex])
    const nextStock = round2(sku.stock + qtyDelta)
    if (nextStock < 0) {
      throw new Error(stockLabel(product, sku) + ' 库存不足，当前库存 ' + sku.stock)
    }
    sku.stock = nextStock
    sku.updatedAt = now
    skuList[skuIndex] = sku
    product.stock = productStockFromSkus(skuList, product.id)
  } else if (productHasSpecs(product)) {
    throw new Error(specSelectHint(product) || '请选择颜色和尺码')
  } else {
    const nextStock = round2(product.stock + qtyDelta)
    if (nextStock < 0) {
      throw new Error(product.name + ' 库存不足，当前库存 ' + product.stock)
    }
    product.stock = nextStock
  }

  product.updatedAt = now
  const nextProducts = products.slice()
  nextProducts[index] = product
  return {
    products: nextProducts,
    skus: skuList
  }
}

function latestPurchase(records, productId, skuId) {
  const skuKey = skuId || ''
  return records.filter(function (item) {
    return item.type === 'in' && item.productId === productId && (item.skuId || '') === skuKey
  }).sort(function (a, b) {
    return toNumber(b.createdAt) - toNumber(a.createdAt)
  })[0] || null
}

function applyLatestPurchaseCost(products, skus, records, productId, skuId, now) {
  const latest = latestPurchase(records, productId, skuId)
  if (!latest) {
    return { products: products, skus: skus || [] }
  }
  const index = products.findIndex(function (item) {
    return item.id === productId
  })
  if (index < 0) {
    return { products: products, skus: skus || [] }
  }
  const product = Object.assign({}, products[index])
  const skuList = (skus || []).slice()
  if (skuId) {
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === skuId
    })
    if (skuIndex >= 0) {
      skuList[skuIndex] = Object.assign({}, skuList[skuIndex], {
        costPrice: latest.unitPrice,
        updatedAt: now
      })
    }
  } else if (!productHasSpecs(product)) {
    product.costPrice = latest.unitPrice
    product.updatedAt = now
  }
  const nextProducts = products.slice()
  nextProducts[index] = product
  return {
    products: nextProducts,
    skus: skuList
  }
}

function assertReceivableValid(records) {
  const seen = {}
  records.forEach(function (item) {
    if (item.customerId && (item.type === 'out' || item.type === 'pay' || item.type === 'return')) {
      seen[item.customerId] = true
    }
  })
  Object.keys(seen).forEach(function (customerId) {
    const account = summarizeCustomerAccount(records, customerId)
    if (account.receivable < 0) {
      throw new Error('改完后收款会超过赊账，请先改收款记录')
    }
  })
}

function patchOrderCustomer(records, orderId, fields) {
  if (!orderId) return records
  return records.map(function (item) {
    if (item.type !== 'out' || item.orderId !== orderId) return item
    return Object.assign({}, item, fields)
  })
}

function updateRecord(products, records, payload, now, skus) {
  const id = String(payload.id || '')
  const index = records.findIndex(function (item) {
    return item.id === id
  })
  if (index < 0) {
    throw new Error('流水不存在')
  }

  const existing = records[index]
  let next = Object.assign({}, existing)
  let nextProducts = products
  let nextSkus = skus || []

  if (existing.type === 'pay') {
    const amount = round2(payload.amount)
    if (amount <= 0) {
      throw new Error('收款金额必须大于 0')
    }
    const others = records.filter(function (item) {
      return item.id !== existing.id
    })
    const cap = summarizeCustomerAccount(others, existing.customerId).receivable
    if (amount > cap) {
      throw new Error('收款不能超过当前欠款 ' + cap)
    }
    next.amount = amount
    next.unitPrice = amount
    next.remark = String(payload.remark || '').trim()
  } else if (existing.type === 'in' || existing.type === 'out') {
    const qty = round2(payload.qty)
    const unitPrice = round2(payload.unitPrice)
    if (qty <= 0) {
      throw new Error(existing.type === 'in' ? '进货数量必须大于 0' : '销售数量必须大于 0')
    }
    if (unitPrice < 0) {
      throw new Error(existing.type === 'in' ? '进价不能为负数' : '售价不能为负数')
    }

    if (existing.type === 'out') {
      const returned = saleReturnQty(records, existing.id)
      if (qty < returned) {
        throw new Error('数量不能小于已退货 ' + returned)
      }
    }

    if (existing.type === 'out' && existing.allocations && existing.allocations.length) {
      const product = nextProducts.find(function (item) {
        return item.id === existing.productId
      })
      nextSkus = nextSkus.slice()
      restoreAllocations(nextSkus, existing.allocations, now, product)
      if (product) {
        const idx = nextProducts.findIndex(function (item) {
          return item.id === product.id
        })
        const synced = Object.assign({}, nextProducts[idx], {
          stock: productStockFromSkus(nextSkus, product.id),
          updatedAt: now
        })
        nextProducts = nextProducts.slice()
        nextProducts[idx] = synced
      }
      const consumed = consumeSaleLine(nextProducts, nextSkus, {
        productId: existing.productId,
        skuId: existing.skuId,
        color: existing.color,
        size: existing.size,
        qty: qty
      }, now)
      nextProducts = consumed.products
      nextSkus = consumed.skus
      next.allocations = consumed.allocations
      next.costPrice = consumed.costPrice
      next.profit = round2((unitPrice - consumed.costPrice) * qty)
    } else {
      const stockDelta = existing.type === 'in'
        ? round2(qty - existing.qty)
        : round2(existing.qty - qty)
      const adjusted = adjustStock(nextProducts, nextSkus, existing, stockDelta, now)
      nextProducts = adjusted.products
      nextSkus = adjusted.skus
      if (existing.type === 'out') {
        next.profit = round2((unitPrice - toNumber(existing.costPrice)) * qty)
      }
    }

    next.qty = qty
    next.unitPrice = unitPrice
    next.amount = round2(qty * unitPrice)
    next.remark = String(payload.remark || '').trim()

    if (existing.type === 'in') {
      next.costPrice = unitPrice
      next.profit = 0
    } else {
      const payType = payload.payType === 'credit' ? 'credit' : 'cash'
      const customerId = String(payload.customerId || '')
      if (payType === 'credit' && !customerId) {
        throw new Error('赊账必须选择客户')
      }
      if (!(existing.allocations && existing.allocations.length)) {
        next.profit = round2((unitPrice - toNumber(existing.costPrice)) * qty)
      }
      next.payType = payType
      next.customerId = customerId
      next.customerName = String(payload.customerName || '').trim()
      next.customerPhone = String(payload.customerPhone || '').trim()
      next.customerAddress = String(payload.customerAddress || '').trim()
    }
  } else if (existing.type === 'return') {
    const qty = round2(payload.qty)
    if (qty <= 0) {
      throw new Error('退货数量必须大于 0')
    }
    const sale = records.find(function (item) {
      return item.id === existing.saleRecordId && item.type === 'out'
    })
    const others = records.filter(function (item) {
      return item.id !== existing.id
    })
    const remain = sale ? round2(returnableQty(others, sale) ) : qty
    if (qty > remain) {
      throw new Error('退货不能超过可退数量 ' + remain)
    }
    const restocked = restockRecord(nextProducts, nextSkus, existing, round2(qty - existing.qty), now, existing.costPrice)
    nextProducts = restocked.products
    nextSkus = restocked.skus
    next.qty = qty
    next.amount = round2(qty * toNumber(existing.unitPrice))
    next.profit = round2((toNumber(existing.unitPrice) - toNumber(existing.costPrice)) * qty * -1)
    next.remark = String(payload.remark || '').trim()
  } else if (existing.type === 'convert') {
    const qty = round2(payload.qty)
    if (qty <= 0) {
      throw new Error('改规格数量必须大于 0')
    }
    const product = nextProducts.find(function (item) {
      return item.id === existing.productId
    })
    nextSkus = nextSkus.slice()
    addSkuStock(nextSkus, existing.toSkuId, -existing.qty, now, null, product)
    addSkuStock(nextSkus, existing.fromSkuId, existing.qty, now, existing.costPrice, product)
    addSkuStock(nextSkus, existing.fromSkuId, -qty, now, null, product)
    addSkuStock(nextSkus, existing.toSkuId, qty, now, existing.costPrice, product)
    if (product) {
      const idx = nextProducts.findIndex(function (item) {
        return item.id === product.id
      })
      nextProducts = nextProducts.slice()
      nextProducts[idx] = Object.assign({}, nextProducts[idx], {
        stock: productStockFromSkus(nextSkus, product.id),
        updatedAt: now
      })
    }
    next.qty = qty
    next.remark = String(payload.remark || '').trim()
  } else {
    throw new Error('流水不存在')
  }

  let nextRecords = records.slice()
  nextRecords[index] = next

  if (existing.type === 'out') {
    nextRecords = patchOrderCustomer(nextRecords, existing.orderId, {
      payType: next.payType,
      customerId: next.customerId,
      customerName: next.customerName,
      customerPhone: next.customerPhone,
      customerAddress: next.customerAddress
    })
  }

  if (existing.type === 'in') {
    const costed = applyLatestPurchaseCost(nextProducts, nextSkus, nextRecords, existing.productId, existing.skuId, now)
    nextProducts = costed.products
    nextSkus = costed.skus
  }

  assertReceivableValid(nextRecords)

  return {
    products: nextProducts,
    skus: nextSkus,
    records: nextRecords,
    record: nextRecords.find(function (item) {
      return item.id === next.id
    })
  }
}

function deleteRecord(products, records, id, now, skus) {
  const existing = records.find(function (item) {
    return item.id === id
  })
  if (!existing) {
    throw new Error('流水不存在')
  }

  if (existing.type === 'out' && saleReturnQty(records, existing.id) > 0) {
    throw new Error('请先删除退货记录')
  }

  let nextProducts = products
  let nextSkus = (skus || []).slice()
  const nextRecords = records.filter(function (item) {
    return item.id !== id
  })

  if (existing.type === 'out' && existing.allocations && existing.allocations.length) {
    const product = products.find(function (item) {
      return item.id === existing.productId
    })
    restoreAllocations(nextSkus, existing.allocations, now, product)
    if (product) {
      const idx = nextProducts.findIndex(function (item) {
        return item.id === product.id
      })
      nextProducts = nextProducts.slice()
      nextProducts[idx] = Object.assign({}, nextProducts[idx], {
        stock: productStockFromSkus(nextSkus, product.id),
        updatedAt: now
      })
    }
  } else if (existing.type === 'in' || existing.type === 'out') {
    const product = products.find(function (item) {
      return item.id === existing.productId
    })
    if (product) {
      const stockDelta = existing.type === 'in' ? round2(-existing.qty) : round2(existing.qty)
      const adjusted = adjustStock(nextProducts, nextSkus, existing, stockDelta, now)
      nextProducts = adjusted.products
      nextSkus = adjusted.skus
    }
  } else if (existing.type === 'return') {
    const restocked = restockRecord(nextProducts, nextSkus, existing, round2(-existing.qty), now, existing.costPrice)
    nextProducts = restocked.products
    nextSkus = restocked.skus
  } else if (existing.type === 'convert') {
    const product = products.find(function (item) {
      return item.id === existing.productId
    })
    addSkuStock(nextSkus, existing.toSkuId, -existing.qty, now, null, product)
    addSkuStock(nextSkus, existing.fromSkuId, existing.qty, now, existing.costPrice, product)
    if (product) {
      const idx = nextProducts.findIndex(function (item) {
        return item.id === product.id
      })
      nextProducts = nextProducts.slice()
      nextProducts[idx] = Object.assign({}, nextProducts[idx], {
        stock: productStockFromSkus(nextSkus, product.id),
        updatedAt: now
      })
    }
  }

  if (existing.type === 'in') {
    const costed = applyLatestPurchaseCost(nextProducts, nextSkus, nextRecords, existing.productId, existing.skuId, now)
    nextProducts = costed.products
    nextSkus = costed.skus
  }

  assertReceivableValid(nextRecords)

  return {
    products: nextProducts,
    skus: nextSkus,
    records: nextRecords
  }
}

function getDashboard(products, records, now, skus) {
  const start = startOfDay(now)
  const todayOut = records.filter(function (item) {
    return item.type === 'out' && item.createdAt >= start
  })
  const todayReturn = records.filter(function (item) {
    return item.type === 'return' && item.createdAt >= start
  })
  const todayIn = records.filter(function (item) {
    return item.type === 'in' && item.createdAt >= start
  })
  const alerts = products.filter(function (item) {
    return isLowStock(item, skus)
  }).sort(function (a, b) {
    return a.stock - b.stock
  })

  return {
    productCount: products.length,
    totalStock: round2(products.reduce(function (sum, item) {
      return sum + toNumber(item.stock)
    }, 0)),
    todaySalesAmount: round2(
      todayOut.reduce(function (sum, item) {
        return sum + toNumber(item.amount)
      }, 0) - todayReturn.reduce(function (sum, item) {
        return sum + toNumber(item.amount)
      }, 0)
    ),
    todayProfit: round2(
      todayOut.reduce(function (sum, item) {
        return sum + toNumber(item.profit)
      }, 0) + todayReturn.reduce(function (sum, item) {
        return sum + toNumber(item.profit)
      }, 0)
    ),
    todayInAmount: round2(todayIn.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    totalReceivable: getTotalReceivable(records),
    alertCount: alerts.length,
    alerts: alerts,
    recent: records.slice(0, 10)
  }
}

function filterProducts(products, keyword, skus) {
  const query = String(keyword || '').trim().toLowerCase()
  if (!query) {
    return products.slice()
  }
  return products.filter(function (item) {
    if (item.name.toLowerCase().indexOf(query) >= 0
      || (item.sku && item.sku.toLowerCase().indexOf(query) >= 0)
      || (item.barcode && item.barcode.toLowerCase().indexOf(query) >= 0)) {
      return true
    }
    return skusOfProduct(skus, item.id).some(function (sku) {
      return (sku.sku && sku.sku.toLowerCase().indexOf(query) >= 0)
        || (sku.barcode && sku.barcode.toLowerCase().indexOf(query) >= 0)
        || (sku.color && sku.color.toLowerCase().indexOf(query) >= 0)
        || (sku.size && sku.size.toLowerCase().indexOf(query) >= 0)
    })
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
  const returns = records.filter(function (item) {
    return item.type === 'return'
  })
  const purchases = records.filter(function (item) {
    return item.type === 'in'
  })
  return {
    salesAmount: round2(
      sales.reduce(function (sum, item) {
        return sum + toNumber(item.amount)
      }, 0) - returns.reduce(function (sum, item) {
        return sum + toNumber(item.amount)
      }, 0)
    ),
    purchaseAmount: round2(purchases.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
    }, 0)),
    profit: round2(
      sales.reduce(function (sum, item) {
        return sum + toNumber(item.profit)
      }, 0) + returns.reduce(function (sum, item) {
        return sum + toNumber(item.profit)
      }, 0)
    ),
    receivable: getTotalReceivable(records),
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

  const tee = createProduct({
    name: '短袖 T恤',
    sku: 'TS-005',
    costPrice: 28,
    salePrice: 59,
    stock: 0,
    alertQty: 4,
    colors: ['黑色', '白色'],
    sizes: ['M', 'L']
  }, now - 5 * 3600000, nextId())
  const teeApplied = applyProductSkus(tee, [], [
    { color: '黑色', size: 'M', stock: 6, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '黑色', size: 'L', stock: 2, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'M', stock: 8, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'L', stock: 5, costPrice: 28, salePrice: 59, alertQty: 4 }
  ], now - 5 * 3600000, nextId)
  products.push(teeApplied.product)

  const hoodie = createProduct({
    name: '卫衣',
    sku: 'HD-006',
    costPrice: 45,
    salePrice: 99,
    stock: 20,
    alertQty: 5,
    colors: ['黑色', '白色', '红色'],
    sizes: ['M', 'L'],
    blankProcess: true
  }, now - 6 * 3600000, nextId())
  const hoodieApplied = applyProductSkus(hoodie, teeApplied.skus, null, now - 6 * 3600000, nextId)
  products.push(hoodieApplied.product)

  const customerA = createCustomer({
    name: '张三超市',
    phone: '13800138000',
    address: '建设路12号',
    remark: '月底结账，送货单不要写内部备注'
  }, now - 2 * 86400000, nextId())
  const customerB = createCustomer({
    name: '李记便利',
    phone: '13900139000',
    address: '中山街88号'
  }, now - 86400000, nextId())

  let records = []
  let working = products
  let skus = hoodieApplied.skus

  const saleMilk = applySale(working, records, {
    productId: products[0].id,
    qty: 6,
    unitPrice: 4.5,
    remark: '示例销售',
    customerId: customerA.id,
    customerName: customerA.name,
    customerPhone: customerA.phone,
    customerAddress: customerA.address,
    payType: 'credit'
  }, now - 40 * 60000, nextId(), skus)
  working = saleMilk.products
  records = saleMilk.records
  skus = saleMilk.skus

  const payMilk = applyPayment(records, {
    customerId: customerA.id,
    customerName: customerA.name,
    customerPhone: customerA.phone,
    customerAddress: customerA.address,
    amount: 10,
    remark: '示例收款'
  }, now - 32 * 60000, nextId())
  records = payMilk.records

  const saleBread = applySale(working, records, {
    productId: products[1].id,
    qty: 2,
    unitPrice: 9.9,
    remark: '示例销售',
    customerId: customerB.id,
    customerName: customerB.name,
    customerPhone: customerB.phone,
    customerAddress: customerB.address,
    payType: 'cash'
  }, now - 25 * 60000, nextId(), skus)
  working = saleBread.products
  records = saleBread.records
  skus = saleBread.skus

  const blackM = skus.find(function (item) {
    return item.productId === teeApplied.product.id && item.color === '黑色' && item.size === 'M'
  })
  const saleTee = applySale(working, records, {
    productId: teeApplied.product.id,
    skuId: blackM.id,
    qty: 1,
    unitPrice: 59,
    remark: '示例销售',
    customerId: customerB.id,
    customerName: customerB.name,
    customerPhone: customerB.phone,
    customerAddress: customerB.address,
    payType: 'cash'
  }, now - 18 * 60000, nextId(), skus)
  working = saleTee.products
  records = saleTee.records
  skus = saleTee.skus

  const hoodieWhiteM = skus.find(function (item) {
    return item.productId === hoodieApplied.product.id && item.color === '白色' && item.size === 'M'
  })
  const saleHoodie = applySale(working, records, {
    productId: hoodieApplied.product.id,
    skuId: hoodieWhiteM.id,
    qty: 2,
    unitPrice: 99,
    remark: '示例白坯销售',
    customerId: customerB.id,
    customerName: customerB.name,
    customerPhone: customerB.phone,
    customerAddress: customerB.address,
    payType: 'cash'
  }, now - 16 * 60000, nextId(), skus)
  working = saleHoodie.products
  records = saleHoodie.records
  skus = saleHoodie.skus

  const purchaseWater = applyPurchase(working, records, {
    productId: products[3].id,
    qty: 12,
    unitPrice: 0.8,
    remark: '示例进货'
  }, now - 10 * 60000, nextId(), skus)

  customerA.lastSaleAt = now - 40 * 60000
  customerB.lastSaleAt = now - 18 * 60000

  return {
    products: purchaseWater.products,
    skus: purchaseWater.skus,
    records: purchaseWater.records,
    customers: [customerA, customerB]
  }
}

module.exports = {
  toNumber: toNumber,
  round2: round2,
  startOfDay: startOfDay,
  calcMargin: calcMargin,
  uniqueSpecs: uniqueSpecs,
  specKey: specKey,
  specText: specText,
  productHasSpecs: productHasSpecs,
  specSelectHint: specSelectHint,
  skuCombos: skuCombos,
  skusOfProduct: skusOfProduct,
  findSkuBySpec: findSkuBySpec,
  productStockFromSkus: productStockFromSkus,
  skuSummaryText: skuSummaryText,
  isLowStock: isLowStock,
  isBlankProcess: isBlankProcess,
  isBlankSku: isBlankSku,
  findBlankSku: findBlankSku,
  blankAvailability: blankAvailability,
  assertSaleItems: assertSaleItems,
  saleReturnQty: saleReturnQty,
  returnableQty: returnableQty,
  isCreditReturn: isCreditReturn,
  createProduct: createProduct,
  updateProduct: updateProduct,
  createSku: createSku,
  updateSku: updateSku,
  applyProductSkus: applyProductSkus,
  createCustomer: createCustomer,
  updateCustomer: updateCustomer,
  filterCustomers: filterCustomers,
  sortCustomers: sortCustomers,
  summarizeCustomerAccount: summarizeCustomerAccount,
  getTotalReceivable: getTotalReceivable,
  isCreditSale: isCreditSale,
  applyPurchase: applyPurchase,
  applySale: applySale,
  applySaleOrder: applySaleOrder,
  applyConvert: applyConvert,
  applyReturn: applyReturn,
  applyReturnOrder: applyReturnOrder,
  buildSaleOrder: buildSaleOrder,
  receivableAt: receivableAt,
  applyPayment: applyPayment,
  updateRecord: updateRecord,
  deleteRecord: deleteRecord,
  getDashboard: getDashboard,
  filterProducts: filterProducts,
  filterRecords: filterRecords,
  summarizeRecords: summarizeRecords,
  buildSeed: buildSeed
}
