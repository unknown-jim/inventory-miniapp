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

function specParts(item, product) {
  const parts = []
  const axis1 = String(item && item.color || '').trim()
  const axis2 = String(item && item.size || '').trim()
  if (axis1) {
    parts.push({
      name: product ? specAxis1Name(product) : '',
      value: axis1
    })
  }
  if (axis2) {
    parts.push({
      name: product ? specAxis2Name(product) : '',
      value: axis2
    })
  }
  return parts
}

function specLabelText(parts) {
  return (parts || []).map(function (part) {
    if (part.name) return part.name + ' ' + part.value
    return part.value
  }).join(' · ')
}

function productHasSpecs(product) {
  return !!(product && ((product.colors && product.colors.length) || (product.sizes && product.sizes.length)))
}

function specAxisName(value, fallback) {
  const name = String(value || '').trim()
  return name || fallback
}

function specAxis1Name(product) {
  return specAxisName(product && product.specAxis1, '规格一')
}

function specAxis2Name(product) {
  return specAxisName(product && product.specAxis2, '规格二')
}

function blankStockLabel() {
  return '待加工'
}

function specSelectHint(product) {
  const needColor = !!(product && product.colors && product.colors.length)
  const needSize = !!(product && product.sizes && product.sizes.length)
  const axis1 = specAxis1Name(product)
  const axis2 = specAxis2Name(product)
  if (needColor && needSize) return '请选择' + axis1 + '和' + axis2
  if (needColor) return '请选择' + axis1
  if (needSize) return '请选择' + axis2
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

function specKindTag(product) {
  if (isBlankProcess(product)) return '待加工'
  if (productHasSpecs(product)) return '分规格现货'
  return ''
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

function recordLines(record) {
  return (record && Array.isArray(record.lines)) ? record.lines : []
}

function firstLine(record) {
  return recordLines(record)[0] || {}
}

function sumBy(list, key) {
  return round2((list || []).reduce(function (sum, item) {
    return sum + toNumber(item[key])
  }, 0))
}

function returnableQty(saleLine) {
  if (!saleLine) return 0
  return round2(toNumber(saleLine.qty) - toNumber(saleLine.returnedQty))
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
      throw new Error(specSelectHint(product) || '请选择规格')
    }
    return { color: sku.color, size: sku.size, sku: sku }
  }
  const color = String(payload.color || '').trim()
  const size = String(payload.size || '').trim()
  const needColor = !!(product.colors && product.colors.length)
  const needSize = !!(product.sizes && product.sizes.length)
  if ((needColor && !color) || (needSize && !size)) {
    throw new Error(specSelectHint(product) || '请选择规格')
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
      throw new Error('待加工库存不存在')
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
    parts.push(blankStockLabel() + ' ' + (blank ? blank.stock : 0))
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
    throw new Error('请填写规格')
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
    throw new Error('还有待加工库存，不能改成分规格现货')
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
    throw new Error('待加工请添加规格')
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
    specAxis1: hasSpecs ? String(input.specAxis1 || '').trim() : '',
    specAxis2: hasSpecs ? String(input.specAxis2 || '').trim() : '',
    blankProcess: hasSpecs && !!input.blankProcess,
    sharedPrice: hasSpecs && input.sharedPrice !== false,
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
    specAxis1: input.specAxis1 != null ? input.specAxis1 : existing.specAxis1,
    specAxis2: input.specAxis2 != null ? input.specAxis2 : existing.specAxis2,
    blankProcess: input.blankProcess != null ? input.blankProcess : existing.blankProcess,
    sharedPrice: input.sharedPrice != null ? input.sharedPrice : existing.sharedPrice
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
  const line = {
    lineId: id,
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    skuId: '',
    color: '',
    size: '',
    qty: qty,
    unitPrice: unitPrice,
    costPrice: unitPrice,
    amount: round2(qty * unitPrice),
    profit: 0
  }
  const record = {
    id: id,
    type: 'in',
    amount: line.amount,
    profit: 0,
    remark: String(payload.remark || '').trim(),
    createdAt: now,
    lines: [line]
  }

  if (isBlankProcess(product)) {
    const blank = findBlankSku(skuList, product.id)
    if (!blank) {
      throw new Error('待加工库存不存在')
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
    line.skuId = sku.id
    line.sku = sku.sku || product.sku
    line.costPrice = unitPrice
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
    line.skuId = sku.id
    line.color = sku.color
    line.size = sku.size
    line.sku = sku.sku || product.sku
    line.costPrice = unitPrice
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

function normalizeProductKind(value, hasSpecs) {
  if (value === 'plain' || value === 'blank' || value === 'finished') return value
  return hasSpecs ? 'finished' : 'plain'
}

function categoryKindTag(category) {
  if (category && category.productKind === 'blank') return '待加工'
  if (category && category.productKind === 'finished') return '分规格现货'
  return '普通'
}

function skuPricesMatch(skus) {
  const rows = (skus || []).filter(function (item) {
    return !isBlankSku(item)
  })
  if (rows.length <= 1) return true
  const cost = round2(rows[0].costPrice)
  const sale = round2(rows[0].salePrice)
  return rows.every(function (item) {
    return round2(item.costPrice) === cost && round2(item.salePrice) === sale
  })
}

function createCategory(input, now, id) {
  const name = String(input.name || '').trim()
  if (!name) {
    throw new Error('请填写种类名称')
  }

  const colors = uniqueSpecs(input.colors)
  const sizes = uniqueSpecs(input.sizes)
  const hasSpecs = !!(colors.length || sizes.length)
  const productKind = normalizeProductKind(input.productKind, hasSpecs)
  if (productKind !== 'plain' && !hasSpecs) {
    throw new Error('请添加规格')
  }
  if (productKind === 'blank' && !hasSpecs) {
    throw new Error('待加工请添加规格')
  }

  return {
    id: id,
    name: name,
    names: uniqueSpecs(input.names),
    specAxis1: hasSpecs ? String(input.specAxis1 || '').trim() : '',
    specAxis2: hasSpecs ? String(input.specAxis2 || '').trim() : '',
    colors: productKind === 'plain' ? [] : colors,
    sizes: productKind === 'plain' ? [] : sizes,
    productKind: productKind,
    sharedPrice: productKind !== 'plain' && input.sharedPrice !== false,
    createdAt: now,
    updatedAt: now
  }
}

function updateCategory(existing, input, now) {
  if (!existing) {
    throw new Error('种类不存在')
  }
  const next = createCategory({
    name: input.name != null ? input.name : existing.name,
    names: input.names != null ? input.names : existing.names,
    specAxis1: input.specAxis1 != null ? input.specAxis1 : existing.specAxis1,
    specAxis2: input.specAxis2 != null ? input.specAxis2 : existing.specAxis2,
    colors: input.colors != null ? input.colors : existing.colors,
    sizes: input.sizes != null ? input.sizes : existing.sizes,
    productKind: input.productKind != null ? input.productKind : existing.productKind,
    sharedPrice: input.sharedPrice != null ? input.sharedPrice : existing.sharedPrice
  }, now, existing.id)
  next.createdAt = existing.createdAt
  return next
}

function appendCategoryValue(existing, field, value, now) {
  if (!existing) {
    throw new Error('种类不存在')
  }
  const nextValue = String(value || '').trim()
  if (!nextValue) return existing
  const key = field === 'names' || field === 'colors' || field === 'sizes' ? field : ''
  if (!key) return existing
  const list = uniqueSpecs(existing[key]).slice()
  if (list.indexOf(nextValue) >= 0) return existing
  const patch = {}
  patch[key] = list.concat([nextValue])
  return updateCategory(existing, patch, now)
}

function filterCategories(categories, keyword) {
  const query = String(keyword || '').trim().toLowerCase()
  if (!query) {
    return (categories || []).slice()
  }
  return (categories || []).filter(function (item) {
    if (item.name.toLowerCase().indexOf(query) >= 0) return true
    return (item.names || []).some(function (name) {
      return String(name).toLowerCase().indexOf(query) >= 0
    })
  })
}

function isCreditSale(record) {
  return record && record.type === 'out' && record.payType === 'credit'
}

function isCreditReturn(record) {
  return record && record.type === 'return' && record.payType === 'credit'
}

function isOpening(record) {
  return record && record.type === 'opening'
}

function isAdjust(record) {
  return record && (record.type === 'adjust_in' || record.type === 'adjust_out')
}

function isInboundStock(record) {
  return record && (record.type === 'in' || record.type === 'adjust_in')
}

function adjustReasons(type) {
  if (type === 'adjust_in') {
    return [
      { value: 'surplus', label: '盘盈' },
      { value: 'gift', label: '赠品' },
      { value: 'other', label: '其他' }
    ]
  }
  if (type === 'adjust_out') {
    return [
      { value: 'damage', label: '报损' },
      { value: 'shortage', label: '盘亏' },
      { value: 'gift', label: '赠品' },
      { value: 'other', label: '其他' }
    ]
  }
  return []
}

function adjustReasonAllowed(type, reason) {
  return adjustReasons(type).some(function (item) {
    return item.value === reason
  })
}

function adjustTypeText(record) {
  if (!record) return '调整'
  const reason = record.reason != null ? record.reason : firstLine(record).reason
  if (record.type === 'adjust_in') {
    if (reason === 'surplus') return '盘盈'
    if (reason === 'gift') return '赠品入库'
    if (reason === 'other') return '其他入库'
    return '调整入库'
  }
  if (record.type === 'adjust_out') {
    if (reason === 'damage') return '报损'
    if (reason === 'shortage') return '盘亏'
    if (reason === 'gift') return '赠品出库'
    if (reason === 'other') return '其他出库'
    return '调整出库'
  }
  return '调整'
}

function isCustomerAccountRecord(record) {
  return record && (
    record.type === 'out'
    || record.type === 'pay'
    || record.type === 'return'
    || record.type === 'opening'
  )
}

// 聚合累加器用整数分存：增量维护要反复加减，浮点会漂，整数在 2^53 内精确
// （约 9 万亿元）。
//
// 等价性的前提（不是"fuzz 试过很多次没炸"，是可证的）：所有记录的 amount /
// profit 都是 round2() 或 sumBy() 的输出，而 cents(round2(n/100)) 对整数 n
// 恒等，所以「先转分再累加」与「先累加再 round2」在这类输入上必然同解。
//
// 前提一旦被破坏就会静默算错账：金额若带第三位小数，误差 =
// Σ(逐条舍入误差) − 整体舍入误差，随记录条数线性增长、无上界、方向不固定。
// **新增写入路径不得绕过 round2 往记录上写 amount / profit。**
// 反例已钉在 tests/ledger-terms.test.js 的「边界情况 (c)」。
function cents(value) {
  return Math.round(toNumber(value) * 100)
}

function yuan(c) {
  return round2(c / 100)
}

function emptyTerms() {
  return {
    saleCount: 0,
    salesSum: 0,
    returnsSum: 0,
    creditSalesSum: 0,
    creditReturnsSum: 0,
    openingsSum: 0,
    paidSum: 0,
    purchaseSum: 0,
    profitSum: 0,
    count: 0
  }
}

// 单条流水对聚合的贡献，单位「分」。
// 全量重算和增量维护共用这一份定义 —— 两者不可能算出不同的数。
function recordTerms(record) {
  const amount = cents(record && record.amount)
  const profit = cents(record && record.profit)
  const type = record && record.type
  return {
    saleCount: type === 'out' ? 1 : 0,
    salesSum: type === 'out' ? amount : 0,
    returnsSum: type === 'return' ? amount : 0,
    creditSalesSum: isCreditSale(record) ? amount : 0,
    creditReturnsSum: isCreditReturn(record) ? amount : 0,
    openingsSum: isOpening(record) ? amount : 0,
    paidSum: type === 'pay' ? amount : 0,
    purchaseSum: type === 'in' ? amount : 0,
    profitSum: (type === 'out' || type === 'return') ? profit : 0,
    count: 1
  }
}

function termsCustomerId(record) {
  return (isCustomerAccountRecord(record) && record.customerId) || ''
}

// sign = +1 记入，-1 冲销。返回新对象，不改动入参。
function addTerms(target, terms, sign) {
  const t = target || emptyTerms()
  const s = sign < 0 ? -1 : 1
  return {
    saleCount: t.saleCount + s * terms.saleCount,
    salesSum: t.salesSum + s * terms.salesSum,
    returnsSum: t.returnsSum + s * terms.returnsSum,
    creditSalesSum: t.creditSalesSum + s * terms.creditSalesSum,
    creditReturnsSum: t.creditReturnsSum + s * terms.creditReturnsSum,
    openingsSum: t.openingsSum + s * terms.openingsSum,
    paidSum: t.paidSum + s * terms.paidSum,
    purchaseSum: t.purchaseSum + s * terms.purchaseSum,
    profitSum: t.profitSum + s * terms.profitSum,
    count: t.count + s * terms.count
  }
}

// terms -> 单个客户账户的对外形状（元）。summarizeAllCustomerAccounts /
// summarizeCustomerAccount 的字段完全靠这份投影定义，两者不能各算一套。
function accountOf(terms) {
  const t = terms || emptyTerms()
  const creditAmount = t.creditSalesSum + t.openingsSum - t.creditReturnsSum
  return {
    count: t.saleCount,
    amount: yuan(t.salesSum - t.returnsSum),
    creditAmount: yuan(creditAmount),
    paidAmount: yuan(t.paidSum),
    receivable: yuan(creditAmount - t.paidSum)
  }
}

// terms -> 全店汇总的对外形状（元）。computeTotals / summarizeRecords 共用。
function totalsOf(terms) {
  const t = terms || emptyTerms()
  return {
    salesAmount: yuan(t.salesSum - t.returnsSum),
    purchaseAmount: yuan(t.purchaseSum),
    profit: yuan(t.profitSum),
    receivable: yuan(t.creditSalesSum + t.openingsSum - t.creditReturnsSum - t.paidSum),
    count: t.count
  }
}

// -> { [customerId]: terms }，跳过 customerId 为空或非客户账记录的流水
function foldAccountTerms(records) {
  const stats = Object.create(null)
  ;(records || []).forEach(function (record) {
    const customerId = termsCustomerId(record)
    if (!customerId) return
    stats[customerId] = addTerms(stats[customerId], recordTerms(record), 1)
  })
  const result = {}
  Object.keys(stats).forEach(function (customerId) {
    result[customerId] = stats[customerId]
  })
  return result
}

// -> terms，全量流水折叠成一份全店汇总
function foldTotalTerms(records) {
  let terms = emptyTerms()
  ;(records || []).forEach(function (record) {
    terms = addTerms(terms, recordTerms(record), 1)
  })
  return terms
}

// 唯一的聚合改动入口。before / after 至少一个非空：
// before 为空 = 新增；after 为空 = 删除；都非空 = 就地改（含换客户）。
// state = { accounts: {cid: terms}, aggregate: terms }
// 某客户的 terms 冲销到 count === 0 时删掉该 key，
// 以保持与 foldAccountTerms（只给有流水的客户建条目）逐字段一致。
function applyTermsDelta(state, before, after) {
  const accounts = Object.assign({}, state && state.accounts)
  let aggregate = (state && state.aggregate) || emptyTerms()

  function bump(record, sign) {
    if (!record) return
    const terms = recordTerms(record)
    aggregate = addTerms(aggregate, terms, sign)
    const customerId = termsCustomerId(record)
    if (!customerId) return
    const next = addTerms(accounts[customerId], terms, sign)
    if (next.count === 0) {
      delete accounts[customerId]
    } else {
      accounts[customerId] = next
    }
  }

  bump(before, -1)
  bump(after, 1)

  return { accounts: accounts, aggregate: aggregate }
}

// 一段流水对某客户欠款的净贡献，口径与 summarizeCustomerAccount 完全一致。单位「元」。
// 送货单欠款用它从「当前欠款」倒推「截断到某时刻的欠款」，见 receivableAt。
function receivableDelta(records, customerId) {
  if (!customerId) return 0
  let terms = emptyTerms()
  ;(records || []).forEach(function (record) {
    if (termsCustomerId(record) !== customerId) return
    terms = addTerms(terms, recordTerms(record), 1)
  })
  return accountOf(terms).receivable
}

function summarizeCustomerAccount(records, customerId) {
  const related = records.filter(function (item) {
    return item.customerId === customerId && isCustomerAccountRecord(item)
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
  const openings = related.filter(isOpening)
  const creditAmount = round2(
    sales.reduce(function (sum, item) {
      return isCreditSale(item) ? sum + toNumber(item.amount) : sum
    }, 0) + openings.reduce(function (sum, item) {
      return sum + toNumber(item.amount)
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

function summarizeAllCustomerAccounts(records) {
  const terms = foldAccountTerms(records)
  const result = {}
  Object.keys(terms).forEach(function (customerId) {
    result[customerId] = accountOf(terms[customerId])
  })
  return result
}

function getTotalReceivable(records) {
  return totalsOf(foldTotalTerms(records)).receivable
}

// ctx（可选）= { accounts: {customerId: terms} }。给了就用账本里的累加器算欠款上限，
// records 只当「调用方已加载的相关流水」用（这个动作一条都不需要，生产路径传 []）。
// 不给就退回老口径：从整份 records 现算。两条路口径完全一致，见 accountOf。
function receivableOf(ctx, records, customerId) {
  if (ctx && ctx.accounts) {
    return accountOf(ctx.accounts[customerId]).receivable
  }
  return summarizeCustomerAccount(records, customerId).receivable
}

// 收款不能超过欠款这条线，改完之后要重新检查一遍。
// 有 ctx 就按「老聚合 ± 本条记录的贡献」查，没有就按老口径全量重折叠。
function assertAccountsValid(accounts) {
  Object.keys(accounts || {}).forEach(function (customerId) {
    if (accountOf(accounts[customerId]).receivable < 0) {
      throw new Error('改完后收款会超过赊账，请先改收款记录')
    }
  })
}

function assertAccountsAfter(ctx, records, before, after) {
  if (ctx && ctx.accounts) {
    assertAccountsValid(applyTermsDelta({ accounts: ctx.accounts }, before, after).accounts)
    return
  }
  assertReceivableValid(records)
}

function applyPayment(records, payload, now, id, ctx) {
  const customerId = String(payload.customerId || '')
  if (!customerId) {
    throw new Error('请选择客户')
  }
  const amount = round2(payload.amount)
  if (amount <= 0) {
    throw new Error('收款金额必须大于 0')
  }
  const receivable = receivableOf(ctx, records, customerId)
  if (amount > receivable) {
    throw new Error('收款不能超过当前欠款 ' + receivable)
  }

  const record = {
    id: id,
    type: 'pay',
    amount: amount,
    profit: 0,
    remark: String(payload.remark || '').trim(),
    customerId: customerId,
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    customerAddress: String(payload.customerAddress || '').trim(),
    payType: 'cash',
    createdAt: now,
    lines: []
  }

  return {
    records: [record].concat(records),
    record: record
  }
}

function applyOpening(records, payload, now, id) {
  const customerId = String(payload.customerId || '')
  if (!customerId) {
    throw new Error('请选择客户')
  }
  const amount = round2(payload.amount)
  if (amount <= 0) {
    throw new Error('期初欠款必须大于 0')
  }

  const record = {
    id: id,
    type: 'opening',
    amount: amount,
    profit: 0,
    remark: String(payload.remark || '').trim(),
    customerId: customerId,
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    customerAddress: String(payload.customerAddress || '').trim(),
    createdAt: now,
    lines: []
  }

  return {
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

  items.forEach(function (item) {
    if (round2(item.qty) <= 0) {
      throw new Error('销售数量必须大于 0')
    }
    if (round2(item.unitPrice) < 0) {
      throw new Error('售价不能为负数')
    }
  })

  // 整单预扫：同一张单里的待加工要整单一起算，不能两行各把待加工算满。
  // 记录形状改了也要留着——它保证的是「整单能不能出货」的原子校验。
  let previewProducts = cloneList(products)
  let previewSkus = cloneList(skus || [])
  items.forEach(function (item) {
    const consumed = consumeSaleLine(previewProducts, previewSkus, item, now)
    previewProducts = consumed.products
    previewSkus = consumed.skus
  })

  let workingProducts = products
  let workingSkus = skus || []
  const lines = items.map(function (item) {
    const qty = round2(item.qty)
    const unitPrice = round2(item.unitPrice)
    const consumed = consumeSaleLine(workingProducts, workingSkus, item, now)
    workingProducts = consumed.products
    workingSkus = consumed.skus
    return {
      lineId: nextId(),
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
      allocations: consumed.allocations || [],
      returnedQty: 0
    }
  })

  const record = {
    id: String(orderId || ''),
    type: 'out',
    amount: sumBy(lines, 'amount'),
    profit: sumBy(lines, 'profit'),
    remark: String(payload.remark || '').trim(),
    customerId: customerId,
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    customerAddress: String(payload.customerAddress || '').trim(),
    payType: payType,
    operatorOpenid: String(payload.operatorOpenid || ''),
    operatorName: String(payload.operatorName || '').trim().slice(0, 32),
    createdAt: now,
    lines: lines
  }

  const nextRecords = [record].concat(records)

  return {
    products: workingProducts,
    skus: workingSkus,
    records: nextRecords,
    record: record,
    order: record
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
    throw new Error('待加工库存不能改规格，请在销售时选规格')
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
    amount: 0,
    profit: 0,
    remark: String(payload.remark || '').trim(),
    createdAt: now,
    lines: [{
      lineId: id,
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
      profit: 0
    }]
  }

  return {
    products: nextProducts,
    skus: skuList,
    records: [record].concat(records),
    record: record
  }
}

function applyAdjust(products, records, payload, now, id, skus) {
  const direction = payload && payload.direction
  if (direction !== 'in' && direction !== 'out') {
    throw new Error('请选择入库或出库')
  }
  const type = direction === 'out' ? 'adjust_out' : 'adjust_in'
  const qty = round2(payload.qty)
  if (qty <= 0) {
    throw new Error('调整数量必须大于 0')
  }
  const reason = String(payload.reason || '').trim()
  if (!adjustReasonAllowed(type, reason)) {
    throw new Error('请选择原因')
  }
  const remark = String(payload.remark || '').trim()
  if (reason === 'other' && !remark) {
    throw new Error('选择其他时请填写备注')
  }

  const index = products.findIndex(function (item) {
    return item.id === payload.productId
  })
  if (index < 0) {
    throw new Error('商品不存在')
  }
  const product = products[index]
  const line = {
    lineId: id,
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    skuId: '',
    color: '',
    size: '',
    qty: qty,
    unitPrice: 0,
    costPrice: 0,
    amount: 0,
    profit: 0,
    reason: reason
  }
  const record = {
    id: id,
    type: type,
    amount: 0,
    profit: 0,
    remark: remark,
    createdAt: now,
    lines: [line]
  }

  if (productHasSpecs(product)) {
    if (!payload.skuId) {
      throw new Error(specSelectHint(product) || '请选择规格')
    }
    const sku = (skus || []).find(function (item) {
      return item.id === payload.skuId
    })
    if (!sku || sku.productId !== product.id) {
      throw new Error('规格不存在')
    }
    if (!isBlankProcess(product) && sku.isBlank) {
      throw new Error('分规格现货没有待加工格')
    }
    line.skuId = sku.id
    line.sku = sku.sku || product.sku
    if (!sku.isBlank) {
      line.color = sku.color
      line.size = sku.size
    }
  }

  const stockDelta = type === 'adjust_in' ? qty : -qty
  const adjusted = adjustStock(products, skus, line, stockDelta, now)
  return {
    products: adjusted.products,
    skus: adjusted.skus,
    records: [record].concat(records),
    record: record
  }
}

function restockLine(products, skus, line, qty, now, costPrice) {
  const index = products.findIndex(function (item) {
    return item.id === line.productId
  })
  if (index < 0) {
    throw new Error('商品已删除，不能改库存')
  }
  const product = Object.assign({}, products[index])
  const skuList = (skus || []).slice()
  const delta = round2(qty)
  if (line.skuId) {
    addSkuStock(skuList, line.skuId, delta, now, delta > 0 ? costPrice : null, product)
    product.stock = productStockFromSkus(skuList, product.id)
  } else if (productHasSpecs(product)) {
    throw new Error(specSelectHint(product) || '请选择规格')
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

// records 是「调用方已加载好的销售单」，不是全量流水：2b-1 起流水在 ledger_records
// 集合里，按 lines[] 里的字段全表找一条销售行需要多键索引。所以 saleOrderId 必填，
// 缺了直接报错，不再退化成全表扫描。
function findSaleLine(records, saleOrderId, saleLineId) {
  const orderId = String(saleOrderId || '')
  const lineId = String(saleLineId || '')
  if (!orderId) {
    throw new Error('退货请指明销售单')
  }
  let found = null
  ;(records || []).forEach(function (item) {
    if (found || item.type !== 'out') return
    if (orderId && item.id !== orderId) return
    const lines = recordLines(item)
    if (!lineId) {
      if (!orderId || lines.length !== 1) return
      found = { record: item, line: lines[0] }
      return
    }
    const line = lines.find(function (row) {
      return String(row.lineId || '') === lineId
    })
    if (line) found = { record: item, line: line }
  })
  if (!found) {
    throw new Error('销售流水不存在')
  }
  return found
}

// returnedQty 是销售行和退货行之间的双向一致性：新增退货加、删退货减、改退货同步改。
function patchSaleLineReturned(records, saleOrderId, saleLineId, delta) {
  const orderId = String(saleOrderId || '')
  const lineId = String(saleLineId || '')
  if (!orderId || !lineId || !delta) return records
  return records.map(function (item) {
    if (item.type !== 'out' || item.id !== orderId) return item
    return Object.assign({}, item, {
      lines: recordLines(item).map(function (line) {
        if (String(line.lineId || '') !== lineId) return line
        return Object.assign({}, line, {
          returnedQty: round2(toNumber(line.returnedQty) + toNumber(delta))
        })
      })
    })
  })
}

// records = 调用方已加载的被退销售单（生产路径最多 1 张，因为一次退货不跨单）。
// ctx（可选）= { accounts }，见 assertAccountsAfter。
function applyReturnOrder(products, records, payload, now, nextId, skus, ctx) {
  const items = (payload.items || []).filter(function (item) {
    return round2(item.qty) > 0
  })
  if (!items.length) {
    throw new Error('请填写退货数量')
  }

  let workingProducts = products
  let workingSkus = skus || []
  let nextRecords = (records || []).slice()
  let saleOrderId = ''
  let saleHead = null
  const lines = []

  items.forEach(function (item) {
    const located = findSaleLine(nextRecords, item.saleOrderId, item.saleLineId || item.saleRecordId)
    if (saleOrderId && located.record.id !== saleOrderId) {
      throw new Error('一次退货只能退同一张销售单')
    }
    saleOrderId = located.record.id
    saleHead = located.record
    const qty = round2(item.qty)
    const remain = returnableQty(located.line)
    if (qty > remain) {
      throw new Error('退货不能超过可退数量 ' + remain)
    }
    // 退货原样入库：按卖出时那一格回到现货，不夹带换格。
    const restocked = restockLine(workingProducts, workingSkus, located.line, qty, now, located.line.costPrice)
    workingProducts = restocked.products
    workingSkus = restocked.skus
    nextRecords = patchSaleLineReturned(nextRecords, located.record.id, located.line.lineId, qty)
    const unitPrice = toNumber(located.line.unitPrice)
    const costPrice = toNumber(located.line.costPrice)
    lines.push({
      lineId: nextId(),
      productId: located.line.productId,
      productName: located.line.productName,
      sku: located.line.sku || '',
      skuId: located.line.skuId || '',
      color: located.line.color || '',
      size: located.line.size || '',
      qty: qty,
      unitPrice: unitPrice,
      costPrice: costPrice,
      amount: round2(qty * unitPrice),
      profit: round2((unitPrice - costPrice) * qty * -1),
      saleOrderId: located.record.id,
      saleLineId: String(located.line.lineId || '')
    })
  })

  const record = {
    id: nextId(),
    type: 'return',
    amount: sumBy(lines, 'amount'),
    profit: sumBy(lines, 'profit'),
    remark: String(payload.remark || '').trim(),
    customerId: saleHead.customerId || '',
    customerName: saleHead.customerName || '',
    customerPhone: saleHead.customerPhone || '',
    customerAddress: saleHead.customerAddress || '',
    payType: saleHead.payType === 'credit' ? 'credit' : 'cash',
    createdAt: now,
    lines: lines
  }
  nextRecords = [record].concat(nextRecords)
  assertAccountsAfter(ctx, nextRecords, null, record)
  return {
    products: workingProducts,
    skus: workingSkus,
    records: nextRecords,
    record: record,
    recordsCreated: [record]
  }
}

function applyReturn(products, records, payload, now, id, skus) {
  const qty = round2(payload.qty)
  if (qty <= 0) {
    throw new Error('退货数量必须大于 0')
  }
  // applyReturnOrder 先取行号再取单号：第一次给行、第二次把 id 留给退货单本身
  let calls = 0
  return applyReturnOrder(products, records, {
    remark: payload.remark,
    items: [{
      saleOrderId: payload.saleOrderId,
      saleLineId: payload.saleLineId || payload.saleRecordId,
      qty: qty
    }]
  }, now, function () {
    calls += 1
    return calls === 1 ? String(id) + '-1' : String(id)
  }, skus)
}

function orderProductTitle(lines) {
  const names = []
  ;(lines || []).forEach(function (item) {
    const name = item.productName || ''
    if (name && names.indexOf(name) < 0) names.push(name)
  })
  const lineCount = (lines || []).length
  if (names.length <= 2) return names.join('、')
  return names[0] + '、' + names[1] + ' 等' + lineCount + '种'
}

// ---------------------------------------------------------------------------
// 老数据读时自愈：把「一行商品一条记录」归并成「一张单一条记录」
// ---------------------------------------------------------------------------

function needsRecordMigration(records) {
  return (records || []).some(function (item) {
    return !Array.isArray(item && item.lines)
  })
}

function legacyLine(old) {
  const line = {
    lineId: String((old && old.id) || ''),
    productId: (old && old.productId) || '',
    productName: (old && old.productName) || '',
    sku: (old && old.sku) || '',
    skuId: (old && old.skuId) || '',
    color: (old && old.color) || '',
    size: (old && old.size) || '',
    qty: round2(old && old.qty),
    unitPrice: round2(old && old.unitPrice),
    costPrice: round2(old && old.costPrice),
    amount: round2(old && old.amount),
    profit: round2(old && old.profit)
  }
  if (old.type === 'out') {
    line.allocations = (old.allocations || []).map(function (row) {
      return Object.assign({}, row)
    })
    line.returnedQty = 0
  } else if (old.type === 'return') {
    line.saleOrderId = ''
    line.saleLineId = String(old.saleRecordId || '')
  } else if (old.type === 'convert') {
    line.fromSkuId = old.fromSkuId || ''
    line.fromColor = old.fromColor || ''
    line.fromSize = old.fromSize || ''
    line.toSkuId = old.toSkuId || ''
  } else if (old.type === 'adjust_in' || old.type === 'adjust_out') {
    line.reason = old.reason || ''
  }
  return line
}

function legacyOrder(items) {
  const first = items[0]
  const type = first.type
  const moneyOnly = type === 'pay' || type === 'opening'
  const record = {
    id: type === 'out'
      ? String(first.orderId || first.id || '')
      : String(first.id || ''),
    type: type,
    amount: sumBy(items, 'amount'),
    profit: sumBy(items, 'profit'),
    remark: first.remark || '',
    createdAt: toNumber(first.createdAt),
    lines: moneyOnly ? [] : items.map(legacyLine)
  }
  // 进货 / 改规格 / 库存调整没有客户，不给单头塞空字段
  if (isCustomerAccountRecord(record)) {
    record.customerId = first.customerId || ''
    record.customerName = first.customerName || ''
    record.customerPhone = first.customerPhone || ''
    record.customerAddress = first.customerAddress || ''
  }
  if (type === 'out' || type === 'return' || type === 'pay') {
    record.payType = first.payType === 'credit' ? 'credit' : 'cash'
  }
  if (type === 'out') {
    record.operatorOpenid = first.operatorOpenid || ''
    record.operatorName = String(first.operatorName || '').trim().slice(0, 32)
  }
  return record
}

// 老退货行用 saleRecordId 指向老销售行的 id，迁移后那个 id 变成了 line.lineId。
function backfillReturnedQty(records, converted) {
  const index = Object.create(null)
  records.forEach(function (record) {
    if (record.type !== 'out') return
    recordLines(record).forEach(function (line) {
      const key = String(line.lineId || '')
      if (key) index[key] = { record: record, line: line }
    })
  })
  records.forEach(function (record, at) {
    if (record.type !== 'return' || !converted[at]) return
    recordLines(record).forEach(function (line) {
      const found = index[String(line.saleLineId || '')]
      if (!found) return
      line.saleOrderId = found.record.id
      found.line.returnedQty = round2(toNumber(found.line.returnedQty) + toNumber(line.qty))
    })
  })
}

function migrateRecordShape(records) {
  const groups = []
  const byKey = Object.create(null)
  ;(records || []).forEach(function (item, at) {
    if (item && Array.isArray(item.lines)) {
      groups.push({ items: [item], ready: true })
      return
    }
    // 只有销售是多行的：老退货 / 老改规格等各自成单，和现在列表里看到的一样。
    // 兜底规则照抄老的 saleOrderIdOf：orderId || id，否则老单会静默散架。
    const key = item.type === 'out'
      ? 'out' + String(item.orderId || item.id || '')
      : 'one' + String(item.id || at)
    if (byKey[key]) {
      byKey[key].items.push(item)
      return
    }
    const group = { items: [item], ready: false }
    byKey[key] = group
    groups.push(group)
  })

  const converted = groups.map(function (group) {
    return !group.ready
  })
  const migrated = groups.map(function (group) {
    if (group.ready) return group.items[0]
    // 老记录是 unshift 进数组的，组内倒着排；反过来才是开单时的行顺序
    return legacyOrder(group.items.slice().reverse())
  })
  backfillReturnedQty(migrated, converted)
  return migrated
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
    return (product && product.name ? product.name : '') + ' ' + blankStockLabel()
  }
  if (sku) {
    const spec = specText(sku.color, sku.size)
    return spec ? product.name + ' ' + spec : product.name
  }
  return product.name
}

function adjustStock(products, skus, line, delta, now) {
  const qtyDelta = round2(delta)
  if (!qtyDelta) {
    return { products: products, skus: skus || [] }
  }

  const index = products.findIndex(function (item) {
    return item.id === line.productId
  })
  if (index < 0) {
    throw new Error('商品已删除，不能改数量')
  }

  const product = Object.assign({}, products[index])
  const skuList = (skus || []).slice()

  if (line.skuId) {
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === line.skuId
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
    throw new Error(specSelectHint(product) || '请选择规格')
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
    if (item.type !== 'in') return false
    const line = firstLine(item)
    return line.productId === productId && (line.skuId || '') === skuKey
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
  const latestPrice = firstLine(latest).unitPrice
  if (skuId) {
    const skuIndex = skuList.findIndex(function (item) {
      return item.id === skuId
    })
    if (skuIndex >= 0) {
      skuList[skuIndex] = Object.assign({}, skuList[skuIndex], {
        costPrice: latestPrice,
        updatedAt: now
      })
    }
  } else if (!productHasSpecs(product)) {
    product.costPrice = latestPrice
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
  assertAccountsValid(foldAccountTerms(records))
}

function syncProductStock(products, skus, productId, now) {
  const index = products.findIndex(function (item) {
    return item.id === productId
  })
  if (index < 0) return products
  const next = products.slice()
  next[index] = Object.assign({}, next[index], {
    stock: productStockFromSkus(skus, productId),
    updatedAt: now
  })
  return next
}

// 把某一条销售行的库存还回去：待加工按 allocations 原样退回各格，其余按规格格加回。
function releaseSaleLine(products, skus, line, now) {
  if (line.allocations && line.allocations.length) {
    const product = products.find(function (item) {
      return item.id === line.productId
    })
    const nextSkus = skus.slice()
    restoreAllocations(nextSkus, line.allocations, now, product)
    return {
      products: product ? syncProductStock(products, nextSkus, product.id, now) : products,
      skus: nextSkus
    }
  }
  const owner = products.find(function (item) {
    return item.id === line.productId
  })
  if (!owner) return { products: products, skus: skus }
  return adjustStock(products, skus, line, round2(line.qty), now)
}

function collectLineUpdates(existing, payload, missingMessage) {
  const lines = recordLines(existing)
  const updates = Object.create(null)
  if (payload.items && payload.items.length) {
    payload.items.forEach(function (item) {
      const lineId = String(item.id || item.lineId || '')
      const hit = lines.some(function (line) {
        return String(line.lineId || '') === lineId
      })
      if (!hit) {
        throw new Error('流水不存在')
      }
      updates[lineId] = item
    })
    return updates
  }
  if (lines.length !== 1) {
    throw new Error(missingMessage)
  }
  updates[String(lines[0].lineId || '')] = payload
  return updates
}

// records = 调用方已加载的相关流水（目标 1 条 + 被退销售单 ≤1 张 + 进货候选 ≤2 条），
// 不再是全量流水。ctx（可选）= { accounts }，见 assertAccountsAfter。
function updateRecord(products, records, payload, now, skus, ctx) {
  const id = String(payload.id || '')
  const index = records.findIndex(function (item) {
    return item.id === id
  })
  if (index < 0) {
    throw new Error('流水不存在')
  }

  const existing = records[index]
  const existingLines = recordLines(existing)

  let next = Object.assign({}, existing)
  let nextProducts = products
  let nextSkus = skus || []
  let nextRecords = records.slice()

  if (existing.type === 'pay') {
    const amount = round2(payload.amount)
    if (amount <= 0) {
      throw new Error('收款金额必须大于 0')
    }
    // 「除本条之外的欠款」= 当前欠款 + 本条收款额（本条 pay 已经算进 accounts 了）
    const cap = ctx && ctx.accounts
      ? round2(accountOf(ctx.accounts[existing.customerId]).receivable + toNumber(existing.amount))
      : summarizeCustomerAccount(records.filter(function (item) {
        return item.id !== existing.id
      }), existing.customerId).receivable
    if (amount > cap) {
      throw new Error('收款不能超过当前欠款 ' + cap)
    }
    next.amount = amount
    next.remark = String(payload.remark || '').trim()
  } else if (existing.type === 'opening') {
    const amount = round2(payload.amount)
    if (amount <= 0) {
      throw new Error('期初欠款必须大于 0')
    }
    next.amount = amount
    next.remark = String(payload.remark || '').trim()
  } else if (existing.type === 'in') {
    const line = Object.assign({}, firstLine(existing))
    const qty = round2(payload.qty)
    const unitPrice = round2(payload.unitPrice)
    if (qty <= 0) {
      throw new Error('进货数量必须大于 0')
    }
    if (unitPrice < 0) {
      throw new Error('进价不能为负数')
    }
    const adjusted = adjustStock(nextProducts, nextSkus, line, round2(qty - line.qty), now)
    nextProducts = adjusted.products
    nextSkus = adjusted.skus
    line.qty = qty
    line.unitPrice = unitPrice
    line.costPrice = unitPrice
    line.amount = round2(qty * unitPrice)
    line.profit = 0
    next.lines = [line]
    next.amount = line.amount
    next.profit = 0
    next.remark = String(payload.remark || '').trim()
  } else if (existing.type === 'out') {
    const updates = collectLineUpdates(existing, payload, '请逐行填写数量和售价')
    const payType = payload.payType === 'credit' ? 'credit' : 'cash'
    const customerId = String(payload.customerId || '')
    if (payType === 'credit' && !customerId) {
      throw new Error('赊账必须选择客户')
    }
    // 逐行就地改：每行先把自己占的货还回去，再按新数量重扣，
    // 所以两行都要同一商品的待加工时也不会各算满一遍。
    const nextLines = existingLines.map(function (line) {
      const patch = updates[String(line.lineId || '')]
      if (!patch) return line
      const qty = round2(patch.qty)
      const unitPrice = round2(patch.unitPrice)
      if (qty <= 0) {
        throw new Error('销售数量必须大于 0')
      }
      if (unitPrice < 0) {
        throw new Error('售价不能为负数')
      }
      const returned = round2(toNumber(line.returnedQty))
      if (qty < returned) {
        throw new Error('数量不能小于已退货 ' + returned)
      }
      const nextLine = Object.assign({}, line)
      if (line.allocations && line.allocations.length) {
        const released = releaseSaleLine(nextProducts, nextSkus, line, now)
        nextProducts = released.products
        nextSkus = released.skus
        const consumed = consumeSaleLine(nextProducts, nextSkus, {
          productId: line.productId,
          skuId: line.skuId,
          color: line.color,
          size: line.size,
          qty: qty
        }, now)
        nextProducts = consumed.products
        nextSkus = consumed.skus
        nextLine.allocations = consumed.allocations
        nextLine.costPrice = consumed.costPrice
        nextLine.profit = round2((unitPrice - consumed.costPrice) * qty)
      } else {
        const adjusted = adjustStock(nextProducts, nextSkus, line, round2(line.qty - qty), now)
        nextProducts = adjusted.products
        nextSkus = adjusted.skus
        nextLine.profit = round2((unitPrice - toNumber(line.costPrice)) * qty)
      }
      nextLine.qty = qty
      nextLine.unitPrice = unitPrice
      nextLine.amount = round2(qty * unitPrice)
      return nextLine
    })
    next.lines = nextLines
    next.amount = sumBy(nextLines, 'amount')
    next.profit = sumBy(nextLines, 'profit')
    next.remark = String(payload.remark || '').trim()
    next.payType = payType
    next.customerId = customerId
    next.customerName = String(payload.customerName || '').trim()
    next.customerPhone = String(payload.customerPhone || '').trim()
    next.customerAddress = String(payload.customerAddress || '').trim()
    if (Object.prototype.hasOwnProperty.call(payload, 'operatorOpenid')) {
      next.operatorOpenid = String(payload.operatorOpenid || '')
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'operatorName')) {
      next.operatorName = String(payload.operatorName || '').trim().slice(0, 32)
    }
  } else if (existing.type === 'return') {
    const updates = collectLineUpdates(existing, payload, '请逐行填写退货数量')
    const nextLines = existingLines.map(function (line) {
      const patch = updates[String(line.lineId || '')]
      if (!patch) return line
      const qty = round2(patch.qty)
      if (qty <= 0) {
        throw new Error('退货数量必须大于 0')
      }
      // 找不到被退销售行就必须停下来，**不能吞成 sale = null 放行**：
      // 吞掉的话可退上限检查和 patchSaleLineReturned 双双被跳过，改一下数量就能
      // 凭空入库、把退货单金额抬到任意值，而被退销售行的 returnedQty 原样不动
      // （见 2b-1a 审计阻塞 2）。老退货行 saleOrderId 为空时宁可改不了，
      // 也不能算错一笔钱和一批货。
      const sale = findSaleLine(nextRecords, line.saleOrderId, line.saleLineId)
      // 本条退货已经算进销售行的 returnedQty 里，加回来才是「除本条外」的可退数量
      const remain = round2(returnableQty(sale.line) + toNumber(line.qty))
      if (qty > remain) {
        throw new Error('退货不能超过可退数量 ' + remain)
      }
      const delta = round2(qty - toNumber(line.qty))
      const restocked = restockLine(nextProducts, nextSkus, line, delta, now, line.costPrice)
      nextProducts = restocked.products
      nextSkus = restocked.skus
      nextRecords = patchSaleLineReturned(nextRecords, sale.record.id, sale.line.lineId, delta)
      const unitPrice = toNumber(line.unitPrice)
      const costPrice = toNumber(line.costPrice)
      return Object.assign({}, line, {
        qty: qty,
        amount: round2(qty * unitPrice),
        profit: round2((unitPrice - costPrice) * qty * -1),
        saleOrderId: sale.record.id
      })
    })
    next.lines = nextLines
    next.amount = sumBy(nextLines, 'amount')
    next.profit = sumBy(nextLines, 'profit')
    next.remark = String(payload.remark || '').trim()
  } else if (existing.type === 'convert') {
    const line = Object.assign({}, firstLine(existing))
    const qty = round2(payload.qty)
    if (qty <= 0) {
      throw new Error('改规格数量必须大于 0')
    }
    const product = nextProducts.find(function (item) {
      return item.id === line.productId
    })
    nextSkus = nextSkus.slice()
    addSkuStock(nextSkus, line.toSkuId, -line.qty, now, null, product)
    addSkuStock(nextSkus, line.fromSkuId, line.qty, now, line.costPrice, product)
    addSkuStock(nextSkus, line.fromSkuId, -qty, now, null, product)
    addSkuStock(nextSkus, line.toSkuId, qty, now, line.costPrice, product)
    if (product) {
      nextProducts = syncProductStock(nextProducts, nextSkus, product.id, now)
    }
    line.qty = qty
    next.lines = [line]
    next.remark = String(payload.remark || '').trim()
  } else if (isAdjust(existing)) {
    const line = Object.assign({}, firstLine(existing))
    if (payload.type && payload.type !== existing.type) {
      throw new Error('不能改调整方向，请删除后重记')
    }
    if (payload.direction === 'in' || payload.direction === 'out') {
      const nextType = payload.direction === 'out' ? 'adjust_out' : 'adjust_in'
      if (nextType !== existing.type) {
        throw new Error('不能改调整方向，请删除后重记')
      }
    }
    if (payload.productId && payload.productId !== line.productId) {
      throw new Error('不能改调整方向，请删除后重记')
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'skuId')
      && String(payload.skuId || '') !== String(line.skuId || '')) {
      throw new Error('不能改调整方向，请删除后重记')
    }
    const qty = round2(payload.qty)
    if (qty <= 0) {
      throw new Error('调整数量必须大于 0')
    }
    const reason = payload.reason != null ? String(payload.reason).trim() : line.reason
    if (!adjustReasonAllowed(existing.type, reason)) {
      throw new Error('请选择原因')
    }
    const remark = String(payload.remark != null ? payload.remark : (existing.remark || '')).trim()
    if (reason === 'other' && !remark) {
      throw new Error('选择其他时请填写备注')
    }
    const stockDelta = isInboundStock(existing)
      ? round2(qty - line.qty)
      : round2(line.qty - qty)
    const adjusted = adjustStock(nextProducts, nextSkus, line, stockDelta, now)
    nextProducts = adjusted.products
    nextSkus = adjusted.skus
    line.qty = qty
    line.reason = reason
    line.unitPrice = 0
    line.costPrice = 0
    line.amount = 0
    line.profit = 0
    next.lines = [line]
    next.remark = remark
    next.amount = 0
    next.profit = 0
  } else {
    throw new Error('流水不存在')
  }

  const at = nextRecords.findIndex(function (item) {
    return item.id === existing.id
  })
  nextRecords[at] = next

  if (existing.type === 'in') {
    const line = firstLine(next)
    const costed = applyLatestPurchaseCost(nextProducts, nextSkus, nextRecords, line.productId, line.skuId, now)
    nextProducts = costed.products
    nextSkus = costed.skus
  }

  assertAccountsAfter(ctx, nextRecords, existing, next)

  return {
    products: nextProducts,
    skus: nextSkus,
    records: nextRecords,
    record: next
  }
}

function restoreRecordStock(products, skus, existing, now) {
  let nextProducts = products
  let nextSkus = (skus || []).slice()
  const type = existing.type

  recordLines(existing).forEach(function (line) {
    if (type === 'out') {
      const released = releaseSaleLine(nextProducts, nextSkus, line, now)
      nextProducts = released.products
      nextSkus = released.skus
      return
    }
    if (type === 'in' || isAdjust(existing)) {
      const product = nextProducts.find(function (item) {
        return item.id === line.productId
      })
      if (!product) return
      const stockDelta = isInboundStock(existing) ? round2(-line.qty) : round2(line.qty)
      const adjusted = adjustStock(nextProducts, nextSkus, line, stockDelta, now)
      nextProducts = adjusted.products
      nextSkus = adjusted.skus
      return
    }
    if (type === 'return') {
      const restocked = restockLine(nextProducts, nextSkus, line, round2(-line.qty), now, line.costPrice)
      nextProducts = restocked.products
      nextSkus = restocked.skus
      return
    }
    if (type === 'convert') {
      const product = nextProducts.find(function (item) {
        return item.id === line.productId
      })
      addSkuStock(nextSkus, line.toSkuId, -line.qty, now, null, product)
      addSkuStock(nextSkus, line.fromSkuId, line.qty, now, line.costPrice, product)
      if (product) {
        nextProducts = syncProductStock(nextProducts, nextSkus, product.id, now)
      }
    }
  })

  return {
    products: nextProducts,
    skus: nextSkus
  }
}

// records 口径同 updateRecord：调用方已加载的相关流水，不是全量。
function deleteRecord(products, records, id, now, skus, ctx) {
  const existing = records.find(function (item) {
    return item.id === id
  })
  if (!existing) {
    throw new Error('流水不存在')
  }

  if (existing.type === 'out') {
    const hasReturn = recordLines(existing).some(function (line) {
      return toNumber(line.returnedQty) > 0
    })
    if (hasReturn) {
      throw new Error('请先删除退货记录')
    }
  }

  const restored = restoreRecordStock(products, skus || [], existing, now)
  let nextProducts = restored.products
  let nextSkus = restored.skus

  let nextRecords = records.filter(function (item) {
    return item.id !== existing.id
  })

  // 删退货要把被退销售行的已退数量减回去，否则可退数量会算错还不报错
  if (existing.type === 'return') {
    recordLines(existing).forEach(function (line) {
      nextRecords = patchSaleLineReturned(nextRecords, line.saleOrderId, line.saleLineId, round2(-line.qty))
    })
  }

  if (existing.type === 'in') {
    const line = firstLine(existing)
    const costed = applyLatestPurchaseCost(nextProducts, nextSkus, nextRecords, line.productId, line.skuId, now)
    nextProducts = costed.products
    nextSkus = costed.skus
  }

  assertAccountsAfter(ctx, nextRecords, existing, null)

  return {
    products: nextProducts,
    skus: nextSkus,
    records: nextRecords
  }
}

// 2b-2b：首页看板不再吃「整本流水」。
//
//   recent —— 服务端按 sortKey 倒序给的**一页**，只用来列「最近流水」。
//   today  —— 服务端按客户端给的 dayStart 现算的今日三项（todayTotals），
//             算不出来时传 null，页面显示「—」而**不是 0**（0 是会被当真的错数）。
//   totals —— accounts / aggregate 的投影，全店欠款的唯一来源。
//
// **不再有 getTotalReceivable(records) 兜底**：分页之后 records 只剩一页，
// 兜底会算出一个偏小的欠款，比没有更糟。
//
// now 留在签名里只为调用点稳定：今日的口径已经整个搬到服务端（它拿的是客户端
// 给的 dayStart），这里一个时间判断都不做了。
function getDashboard(products, recent, now, skus, totals, today) {
  const alerts = products.filter(function (item) {
    return isLowStock(item, skus)
  }).sort(function (a, b) {
    return a.stock - b.stock
  })
  const todayAvailable = !!today

  return {
    productCount: products.length,
    totalStock: round2(products.reduce(function (sum, item) {
      return sum + toNumber(item.stock)
    }, 0)),
    todayAvailable: todayAvailable,
    todaySalesAmount: todayAvailable ? today.salesAmount : null,
    todayProfit: todayAvailable ? today.profit : null,
    todayInAmount: todayAvailable ? today.inAmount : null,
    totalReceivable: totals ? totals.receivable : 0,
    alertCount: alerts.length,
    alerts: alerts,
    recent: (recent || []).slice(0, 10)
  }
}

// 「今日三项」的定义：销售额（扣退货）/毛利/进货额，截至 dayStart 及之后的记录。
// 用 cents/yuan 累加（recordTerms 那一套整数分算法），不用 round2 反复叠加浮点 ——
// 理由和 recordTerms 顶部注释一致：金额都是 round2() 的输出，先转分再累加与先
// 累加再 round2 在这类输入上必然同解；不这样做就会重演那条已钉住的浮点分歧。
// 2b-2b 起 getDashboard 的今日三项就来自这里（服务端算，客户端一行都不算）。
//
// **存量亚分金额的店，首页数字会跳一次**：老 getDashboard 用 round2 浮点累加，
// 这里用整数分累加，在亚分金额上必然分岔（1000 × 0.001 → 老 1 新 0；
// 2 × 0.005 → 老 0.02 新 0.01）。这是仓库里已钉住的 D2 分歧，方案有意选了
// 分口径；迁移预检要顺带查一遍哪些店有亚分金额。
function todayTotals(records, dayStart) {
  const start = toNumber(dayStart)
  let salesCents = 0
  let returnsCents = 0
  let profitCents = 0
  let inCents = 0
  ;(records || []).forEach(function (record) {
    if (toNumber(record && record.createdAt) < start) return
    const type = record && record.type
    if (type === 'out') {
      salesCents += cents(record.amount)
      profitCents += cents(record.profit)
    } else if (type === 'return') {
      returnsCents += cents(record.amount)
      profitCents += cents(record.profit)
    } else if (type === 'in') {
      inCents += cents(record.amount)
    }
  })
  return {
    salesAmount: yuan(salesCents - returnsCents),
    profit: yuan(profitCents),
    inAmount: yuan(inCents)
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
  if (type === 'adjust') {
    return records.filter(isAdjust)
  }
  return records.filter(function (item) {
    return item.type === type
  })
}

function summarizeRecords(records) {
  return totalsOf(foldTotalTerms(records))
}

function computeTotals(records) {
  return summarizeRecords(records)
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
    sizes: ['M', 'L'],
    specAxis1: '颜色',
    specAxis2: '尺码'
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
    specAxis1: '颜色',
    specAxis2: '尺码',
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

  const saleMilk = applySaleOrder(working, records, {
    items: [{ productId: products[0].id, qty: 6, unitPrice: 4.5 }],
    remark: '示例销售',
    customerId: customerA.id,
    customerName: customerA.name,
    customerPhone: customerA.phone,
    customerAddress: customerA.address,
    payType: 'credit'
  }, now - 40 * 60000, nextId(), nextId, skus)
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

  const saleBread = applySaleOrder(working, records, {
    items: [{ productId: products[1].id, qty: 2, unitPrice: 9.9 }],
    remark: '示例销售',
    customerId: customerB.id,
    customerName: customerB.name,
    customerPhone: customerB.phone,
    customerAddress: customerB.address,
    payType: 'cash'
  }, now - 25 * 60000, nextId(), nextId, skus)
  working = saleBread.products
  records = saleBread.records
  skus = saleBread.skus

  const blackM = skus.find(function (item) {
    return item.productId === teeApplied.product.id && item.color === '黑色' && item.size === 'M'
  })
  const saleTee = applySaleOrder(working, records, {
    items: [{ productId: teeApplied.product.id, skuId: blackM.id, qty: 1, unitPrice: 59 }],
    remark: '示例销售',
    customerId: customerB.id,
    customerName: customerB.name,
    customerPhone: customerB.phone,
    customerAddress: customerB.address,
    payType: 'cash'
  }, now - 18 * 60000, nextId(), nextId, skus)
  working = saleTee.products
  records = saleTee.records
  skus = saleTee.skus

  const hoodieWhiteM = skus.find(function (item) {
    return item.productId === hoodieApplied.product.id && item.color === '白色' && item.size === 'M'
  })
  const saleHoodie = applySaleOrder(working, records, {
    items: [{ productId: hoodieApplied.product.id, skuId: hoodieWhiteM.id, qty: 2, unitPrice: 99 }],
    remark: '示例待加工销售',
    customerId: customerB.id,
    customerName: customerB.name,
    customerPhone: customerB.phone,
    customerAddress: customerB.address,
    payType: 'cash'
  }, now - 16 * 60000, nextId(), nextId, skus)
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
    customers: [customerA, customerB],
    categories: [
      createCategory({
        name: '纺织',
        names: ['短袖 T恤', '卫衣'],
        specAxis1: '颜色',
        specAxis2: '尺码',
        colors: ['黑色', '白色'],
        sizes: ['M', 'L'],
        productKind: 'finished',
        sharedPrice: true
      }, now - 7 * 3600000, nextId()),
      createCategory({
        name: '日用',
        names: ['纯牛奶', '全麦面包', '矿泉水'],
        productKind: 'plain'
      }, now - 8 * 3600000, nextId())
    ]
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
  specParts: specParts,
  specLabelText: specLabelText,
  productHasSpecs: productHasSpecs,
  specAxis1Name: specAxis1Name,
  specAxis2Name: specAxis2Name,
  specKindTag: specKindTag,
  blankStockLabel: blankStockLabel,
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
  recordLines: recordLines,
  firstLine: firstLine,
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
  createCategory: createCategory,
  updateCategory: updateCategory,
  appendCategoryValue: appendCategoryValue,
  filterCategories: filterCategories,
  categoryKindTag: categoryKindTag,
  skuPricesMatch: skuPricesMatch,
  summarizeCustomerAccount: summarizeCustomerAccount,
  summarizeAllCustomerAccounts: summarizeAllCustomerAccounts,
  getTotalReceivable: getTotalReceivable,
  emptyTerms: emptyTerms,
  recordTerms: recordTerms,
  addTerms: addTerms,
  accountOf: accountOf,
  totalsOf: totalsOf,
  foldAccountTerms: foldAccountTerms,
  foldTotalTerms: foldTotalTerms,
  applyTermsDelta: applyTermsDelta,
  receivableDelta: receivableDelta,
  assertAccountsValid: assertAccountsValid,
  assertReceivableValid: assertReceivableValid,
  isCreditSale: isCreditSale,
  isOpening: isOpening,
  isAdjust: isAdjust,
  isInboundStock: isInboundStock,
  adjustReasons: adjustReasons,
  adjustReasonAllowed: adjustReasonAllowed,
  adjustTypeText: adjustTypeText,
  applyPurchase: applyPurchase,
  applySaleOrder: applySaleOrder,
  applyConvert: applyConvert,
  applyAdjust: applyAdjust,
  applyReturn: applyReturn,
  applyReturnOrder: applyReturnOrder,
  findSaleLine: findSaleLine,
  orderProductTitle: orderProductTitle,
  needsRecordMigration: needsRecordMigration,
  migrateRecordShape: migrateRecordShape,
  receivableAt: receivableAt,
  applyPayment: applyPayment,
  applyOpening: applyOpening,
  updateRecord: updateRecord,
  deleteRecord: deleteRecord,
  getDashboard: getDashboard,
  todayTotals: todayTotals,
  filterProducts: filterProducts,
  filterRecords: filterRecords,
  summarizeRecords: summarizeRecords,
  computeTotals: computeTotals,
  buildSeed: buildSeed
}
