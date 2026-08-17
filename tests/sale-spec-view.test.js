const assert = require('assert')
const fs = require('fs')
const path = require('path')
const inv = require('../utils/inventory')
const { saleSpecOptions } = require('../utils/sale-spec-view')

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
}

function pageMethod(src, name) {
  const re = new RegExp('\\n  (async )?' + name + '\\([^)]*\\) \\{')
  const match = re.exec(src)
  assert.ok(match, 'missing method ' + name)
  let i = match.index + match[0].length
  let depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') depth -= 1
    i += 1
  }
  return src.slice(match.index, i)
}

function makeReady() {
  const product = inv.createProduct({
    name: '短袖',
    costPrice: 28,
    salePrice: 59,
    stock: 0,
    alertQty: 4,
    colors: ['黑色', '白色'],
    sizes: ['M', 'L']
  }, 1000, 'p-ready')
  return inv.applyProductSkus(product, [], [
    { color: '黑色', size: 'M', stock: 6, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '黑色', size: 'L', stock: 2, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'M', stock: 8, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'L', stock: 5, costPrice: 28, salePrice: 59, alertQty: 4 }
  ], 1100, idFactory())
}

function makeBlank() {
  const product = inv.createProduct({
    name: '卫衣',
    costPrice: 45,
    salePrice: 99,
    stock: 20,
    alertQty: 5,
    colors: ['黑色', '白色'],
    sizes: ['M', 'L'],
    blankProcess: true
  }, 1000, 'p-blank')
  return inv.applyProductSkus(product, [], null, 1100, idFactory())
}

function sizeStock(options, size) {
  const found = options.sizeOptions.find(function (item) {
    return item.value === size
  })
  return found ? found.stock : null
}

const ready = makeReady()
const blackM = inv.findSkuBySpec(ready.skus, ready.product.id, '黑色', 'M')
const before = saleSpecOptions(ready.product, ready.skus, '黑色', 'M', [])
assert.strictEqual(sizeStock(before, 'M'), 6)
assert.strictEqual(sizeStock(before, 'L'), 2)
assert.strictEqual(before.sizeOptions[0].low, false)
assert.strictEqual(before.sizeOptions[1].low, true)

const afterCart = saleSpecOptions(ready.product, ready.skus, '黑色', 'M', [
  { productId: ready.product.id, skuId: blackM.id, color: '黑色', size: 'M', qty: 1 }
])
assert.strictEqual(sizeStock(afterCart, 'M'), 5)
assert.strictEqual(sizeStock(afterCart, 'L'), 2)
assert.strictEqual(afterCart.sizeOptions[0].low, false)

const afterLow = saleSpecOptions(ready.product, ready.skus, '黑色', 'M', [
  { productId: ready.product.id, skuId: blackM.id, color: '黑色', size: 'M', qty: 2 }
])
assert.strictEqual(sizeStock(afterLow, 'M'), 4)
assert.strictEqual(afterLow.sizeOptions[0].low, true)

const blank = makeBlank()
const blankReady = inv.findSkuBySpec(blank.skus, blank.product.id, '黑色', 'M')
const blankBefore = saleSpecOptions(blank.product, blank.skus, '黑色', 'M', [])
assert.strictEqual(sizeStock(blankBefore, 'M'), 20)
assert.strictEqual(sizeStock(blankBefore, 'L'), 20)

const blankAfter = saleSpecOptions(blank.product, blank.skus, '黑色', 'M', [
  { productId: blank.product.id, skuId: blankReady.id, color: '黑色', size: 'M', qty: 4 }
])
assert.strictEqual(sizeStock(blankAfter, 'M'), 16)
assert.strictEqual(sizeStock(blankAfter, 'L'), 16)

const saleJs = fs.readFileSync(path.join(__dirname, '../pages/sale/sale.js'), 'utf8')
;['addCart', 'removeCart', 'submit'].forEach(function (name) {
  const body = pageMethod(saleJs, name)
  assert.ok(body.indexOf('stockPatch') >= 0, name + ' should refresh size chips via stockPatch')
})

console.log('sale-spec-view tests passed')
