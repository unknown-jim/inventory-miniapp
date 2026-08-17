const inventory = require('./inventory')

function specLineText(specCount, lowCellCount) {
  if (lowCellCount > 0) return lowCellCount + ' 格低于预警'
  return specCount + ' 个规格'
}

function isReadySku(sku) {
  return !inventory.isBlankSku(sku)
}

function skuInStock(sku) {
  return inventory.toNumber(sku.stock) > 0
}

function skuLow(sku) {
  return inventory.toNumber(sku.stock) <= inventory.toNumber(sku.alertQty)
}

function skuListView(product, skus) {
  if (!inventory.productHasSpecs(product)) {
    return {
      specCount: 0,
      lowCellCount: 0,
      specLineText: '',
      specGroups: []
    }
  }

  const ready = inventory.skusOfProduct(skus, product.id).filter(isReadySku)
  const blank = inventory.findBlankSku(skus, product.id)
  const specCount = ready.length || inventory.skuCombos(product.colors, product.sizes).length
  const blankProcess = inventory.isBlankProcess(product)
  let lowCellCount = 0
  if (blankProcess) {
    lowCellCount = blank && inventory.toNumber(blank.stock) <= inventory.toNumber(product.alertQty)
      ? 1
      : 0
  } else {
    lowCellCount = ready.filter(skuLow).length
  }

  const specGroups = []
  if (blank && skuInStock(blank)) {
    specGroups.push({
      key: '__blank__',
      title: inventory.blankStockLabel(),
      chips: [{
        key: blank.id,
        label: String(blank.stock),
        low: inventory.toNumber(blank.stock) <= inventory.toNumber(product.alertQty)
      }]
    })
  }

  const inStock = ready.filter(skuInStock)
  const colors = product.colors || []
  const sizes = product.sizes || []
  const has1 = colors.length > 0
  const has2 = sizes.length > 0

  if (has1 && has2) {
    colors.forEach(function (color) {
      const chips = []
      sizes.forEach(function (size) {
        const sku = inStock.find(function (item) {
          return item.color === color && item.size === size
        })
        if (!sku) return
        chips.push({
          key: sku.id,
          label: size + ' ' + sku.stock,
          low: !blankProcess && skuLow(sku)
        })
      })
      if (chips.length) {
        specGroups.push({
          key: color,
          title: color,
          chips: chips
        })
      }
    })
  } else {
    const axis = has1 ? colors : sizes
    const chips = []
    axis.forEach(function (value) {
      const sku = inStock.find(function (item) {
        return (has1 ? item.color : item.size) === value
      })
      if (!sku) return
      chips.push({
        key: sku.id,
        label: value + ' ' + sku.stock,
        low: !blankProcess && skuLow(sku)
      })
    })
    if (chips.length) {
      specGroups.push({
        key: '__flat__',
        title: '',
        chips: chips
      })
    }
  }

  return {
    specCount: specCount,
    lowCellCount: lowCellCount,
    specLineText: specLineText(specCount, lowCellCount),
    specGroups: specGroups
  }
}

module.exports = {
  specLineText: specLineText,
  skuListView: skuListView
}
