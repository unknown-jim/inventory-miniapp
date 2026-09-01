const inventory = require('./inventory')

function reservedQtyOfSku(reservedItems, skuId) {
  return (reservedItems || []).reduce(function (sum, item) {
    return item.skuId === skuId ? sum + inventory.toNumber(item.qty) : sum
  }, 0)
}

// selectedSizes 是选中集合（数组），不是单值——销售页规格二支持多选（批 2/2026-09-02）。
// sizeOptions[].on 由 includes 判定：单选形态传 0/1 个元素的数组，效果与旧的严格相等等价。
// 新增 sizeOptions[].ready：待加工商品的「现货」（不含半成品池），供多选态逐格 hint 用
// （裁定 B：hint 只许写「现货 N」，不许写「可出 N」）；非待加工商品 ready 就是 stock 本身。
function saleSpecOptions(product, skus, selectedColor, selectedSizes, reservedItems) {
  const colors = (product && product.colors) || []
  const sizes = (product && product.sizes) || []
  const blankProcess = inventory.isBlankProcess(product)
  const selected = selectedSizes || []
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
        : { total: 0, ready: 0 }
      return {
        value: size,
        stock: avail.total,
        ready: avail.ready,
        on: selected.indexOf(size) >= 0,
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
      ready: stock,
      on: selected.indexOf(size) >= 0,
      low: !!(sku && stock <= sku.alertQty)
    }
  })
  return { colorOptions: colorOptions, sizeOptions: sizeOptions }
}

// H5：不同格的 ready 互不影响，逐格 max(0, qty − ready) 求和就是这批要从半成品池扣的件数
// ——不做跨行滚动累积（那样会让后面的格误吃前面格已经算过的短缺）。
// H3 的第二道守卫：非待加工商品直接返回 0（页面侧 isBlankProcess 判断是第一道）。
// lines 形状与购物车行一致，只用到 color / size / qty 三个字段。
function blankShortOf(product, skus, lines, reservedItems) {
  if (!inventory.isBlankProcess(product)) return 0
  const sum = (lines || []).reduce(function (total, line) {
    const avail = inventory.blankAvailability(product, skus, line.color, line.size, reservedItems)
    const short = inventory.round2(inventory.toNumber(line.qty) - inventory.toNumber(avail.ready))
    return total + (short > 0 ? short : 0)
  }, 0)
  return inventory.round2(sum)
}

module.exports = {
  saleSpecOptions: saleSpecOptions,
  blankShortOf: blankShortOf
}
