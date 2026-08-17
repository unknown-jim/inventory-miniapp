const inventory = require('./inventory')

function reservedQtyOfSku(reservedItems, skuId) {
  return (reservedItems || []).reduce(function (sum, item) {
    return item.skuId === skuId ? sum + inventory.toNumber(item.qty) : sum
  }, 0)
}

function saleSpecOptions(product, skus, selectedColor, selectedSize, reservedItems) {
  const colors = (product && product.colors) || []
  const sizes = (product && product.sizes) || []
  const blankProcess = inventory.isBlankProcess(product)
  const colorOptions = colors.map(function (color) {
    const related = inventory.skusOfProduct(skus, product.id).filter(function (item) {
      return !item.isBlank && item.color === color
    })
    const stock = related.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.stock)
    }, 0)
    return { value: color, stock: stock, on: color === selectedColor }
  })
  const sizeOptions = sizes.map(function (size) {
    if (blankProcess) {
      const avail = selectedColor
        ? inventory.blankAvailability(product, skus, selectedColor, size, reservedItems)
        : { total: 0 }
      return {
        value: size,
        stock: avail.total,
        on: size === selectedSize,
        low: false
      }
    }
    const sku = inventory.findSkuBySpec(skus, product.id, selectedColor || '', size)
    const stock = sku
      ? inventory.round2(inventory.toNumber(sku.stock) - reservedQtyOfSku(reservedItems, sku.id))
      : 0
    return {
      value: size,
      stock: stock,
      on: size === selectedSize,
      low: !!(sku && stock <= sku.alertQty)
    }
  })
  return { colorOptions: colorOptions, sizeOptions: sizeOptions }
}

module.exports = {
  saleSpecOptions: saleSpecOptions
}
