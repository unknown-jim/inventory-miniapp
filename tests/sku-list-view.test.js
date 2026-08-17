const assert = require('assert')
const inv = require('../utils/inventory')
const { specLineText, skuListView } = require('../utils/sku-list-view')

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
}

function makeReady(input, skuInputs, id) {
  const product = inv.createProduct(Object.assign({
    name: '短袖',
    costPrice: 28,
    salePrice: 59,
    stock: 0,
    alertQty: 4
  }, input), 1000, id || 'p-ready')
  return inv.applyProductSkus(product, [], skuInputs, 1100, idFactory())
}

function makeBlank(input, id) {
  const product = inv.createProduct(Object.assign({
    name: '卫衣',
    costPrice: 45,
    salePrice: 99,
    stock: 20,
    alertQty: 5,
    colors: ['黑色', '白色', '红色'],
    sizes: ['M', 'L'],
    blankProcess: true
  }, input), 1000, id || 'p-blank')
  return inv.applyProductSkus(product, [], null, 1100, idFactory())
}

assert.strictEqual(specLineText(6, 0), '6 个规格')
assert.strictEqual(specLineText(6, 2), '2 格低于预警')
assert.strictEqual(specLineText(3, 1), '1 格低于预警')
assert.ok(specLineText(6, 2).indexOf('个规格') < 0)

const twoAxis = makeReady({
  colors: ['黑色', '白色'],
  sizes: ['M', 'L']
}, [
  { color: '黑色', size: 'M', stock: 6, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '黑色', size: 'L', stock: 2, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '白色', size: 'M', stock: 8, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '白色', size: 'L', stock: 0, costPrice: 28, salePrice: 59, alertQty: 4 }
], 'p-two')
const twoView = skuListView(twoAxis.product, twoAxis.skus)
assert.strictEqual(twoView.specCount, 4)
assert.strictEqual(twoView.lowCellCount, 2)
assert.strictEqual(twoView.specLineText, '2 格低于预警')
assert.strictEqual(twoView.specGroups.length, 2)
assert.strictEqual(twoView.specGroups[0].key, '黑色')
assert.strictEqual(twoView.specGroups[0].title, '黑色')
assert.deepStrictEqual(twoView.specGroups[0].chips.map(function (chip) {
  return { label: chip.label, low: chip.low }
}), [
  { label: 'M 6', low: false },
  { label: 'L 2', low: true }
])
assert.strictEqual(twoView.specGroups[1].key, '白色')
assert.strictEqual(twoView.specGroups[1].title, '白色')
assert.deepStrictEqual(twoView.specGroups[1].chips.map(function (chip) {
  return { label: chip.label, low: chip.low }
}), [
  { label: 'M 8', low: false }
])
assert.ok(twoView.specGroups[0].chips[0].key)
assert.strictEqual(
  twoView.specGroups[0].chips[0].key,
  inv.findSkuBySpec(twoAxis.skus, 'p-two', '黑色', 'M').id
)

const zeroFiltered = twoView.specGroups.every(function (group) {
  return group.chips.every(function (chip) {
    return chip.label.indexOf(' 0') < 0 && chip.label !== '0'
  })
})
assert.ok(zeroFiltered, '0 库存格不应出现在展开 chip 里')
assert.ok(!twoView.specGroups.some(function (group) {
  return group.chips.some(function (chip) { return chip.label === 'L 0' })
}))

const allZero = makeReady({
  colors: ['黑色', '白色'],
  sizes: ['M', 'L']
}, [
  { color: '黑色', size: 'M', stock: 0, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '黑色', size: 'L', stock: 0, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '白色', size: 'M', stock: 0, costPrice: 28, salePrice: 59, alertQty: 4 },
  { color: '白色', size: 'L', stock: 0, costPrice: 28, salePrice: 59, alertQty: 4 }
], 'p-zero')
const zeroView = skuListView(allZero.product, allZero.skus)
assert.strictEqual(zeroView.specCount, 4)
assert.strictEqual(zeroView.lowCellCount, 4)
assert.strictEqual(zeroView.specLineText, '4 格低于预警')
assert.deepStrictEqual(zeroView.specGroups, [])

const hoodie = makeBlank({}, 'p-hoodie')
const hoodieView = skuListView(hoodie.product, hoodie.skus)
assert.strictEqual(hoodieView.specCount, 6)
assert.strictEqual(hoodieView.lowCellCount, 0)
assert.strictEqual(hoodieView.specLineText, '6 个规格')
assert.strictEqual(hoodieView.specGroups.length, 1)
assert.strictEqual(hoodieView.specGroups[0].key, '__blank__')
assert.strictEqual(hoodieView.specGroups[0].title, inv.blankStockLabel())
assert.strictEqual(hoodieView.specGroups[0].title, '待加工')
assert.strictEqual(hoodieView.specGroups[0].chips.length, 1)
assert.strictEqual(hoodieView.specGroups[0].chips[0].label, '20')
assert.strictEqual(hoodieView.specGroups[0].chips[0].low, false)
assert.strictEqual(
  hoodieView.specGroups[0].chips[0].key,
  inv.findBlankSku(hoodie.skus, 'p-hoodie').id
)

const hoodieLow = makeBlank({ stock: 3, alertQty: 5 }, 'p-hoodie-low')
const hoodieLowView = skuListView(hoodieLow.product, hoodieLow.skus)
assert.strictEqual(hoodieLowView.specCount, 6)
assert.strictEqual(hoodieLowView.lowCellCount, 1)
assert.strictEqual(hoodieLowView.specLineText, '1 格低于预警')
assert.strictEqual(hoodieLowView.specGroups[0].chips[0].low, true)
assert.strictEqual(hoodieLowView.specGroups[0].chips[0].label, '3')

const hoodieEmptyBlank = makeBlank({ stock: 0 }, 'p-hoodie-empty')
const hoodieEmptyView = skuListView(hoodieEmptyBlank.product, hoodieEmptyBlank.skus)
assert.strictEqual(hoodieEmptyView.specCount, 6)
assert.ok(!hoodieEmptyView.specGroups.some(function (group) {
  return group.key === '__blank__'
}), '待加工 0 库存不应列出')
assert.deepStrictEqual(hoodieEmptyView.specGroups, [])

const hoodieFinished = makeBlank({ stock: 20 }, 'p-hoodie-fin')
const finishedSku = inv.findSkuBySpec(hoodieFinished.skus, 'p-hoodie-fin', '白色', 'M')
const blankSku = inv.findBlankSku(hoodieFinished.skus, 'p-hoodie-fin')
finishedSku.stock = 2
blankSku.stock = 18
hoodieFinished.product.stock = 20
const hoodieFinView = skuListView(hoodieFinished.product, hoodieFinished.skus)
assert.strictEqual(hoodieFinView.specCount, 6)
assert.strictEqual(hoodieFinView.lowCellCount, 0)
assert.strictEqual(hoodieFinView.specLineText, '6 个规格')
assert.strictEqual(hoodieFinView.specGroups[0].key, '__blank__')
assert.strictEqual(hoodieFinView.specGroups[0].chips[0].label, '18')
const whiteGroup = hoodieFinView.specGroups.find(function (group) {
  return group.key === '白色'
})
assert.ok(whiteGroup)
assert.strictEqual(whiteGroup.title, '白色')
assert.strictEqual(whiteGroup.chips.length, 1)
assert.strictEqual(whiteGroup.chips[0].label, 'M 2')
assert.strictEqual(whiteGroup.chips[0].low, false)
assert.strictEqual(inv.toNumber(finishedSku.alertQty), 0)
assert.ok(hoodieFinView.specGroups[0].key === '__blank__', '待加工组应在最前')

const flavor = makeReady({
  name: '绿茶',
  specAxis1: '口味',
  colors: ['原味', '茉莉'],
  sizes: []
}, [
  { color: '原味', size: '', stock: 7, costPrice: 10, salePrice: 20, alertQty: 4 },
  { color: '茉莉', size: '', stock: 1, costPrice: 10, salePrice: 20, alertQty: 4 }
], 'p-flavor')
const flavorView = skuListView(flavor.product, flavor.skus)
assert.strictEqual(flavorView.specCount, 2)
assert.strictEqual(flavorView.lowCellCount, 1)
assert.strictEqual(flavorView.specLineText, '1 格低于预警')
assert.strictEqual(flavorView.specGroups.length, 1)
assert.strictEqual(flavorView.specGroups[0].key, '__flat__')
assert.strictEqual(flavorView.specGroups[0].title, '')
assert.deepStrictEqual(flavorView.specGroups[0].chips.map(function (chip) {
  return { label: chip.label, low: chip.low }
}), [
  { label: '原味 7', low: false },
  { label: '茉莉 1', low: true }
])

const sizeOnly = makeReady({
  name: '杯子',
  colors: [],
  sizes: ['S', 'M']
}, [
  { color: '', size: 'S', stock: 3, costPrice: 8, salePrice: 18, alertQty: 2 },
  { color: '', size: 'M', stock: 9, costPrice: 8, salePrice: 18, alertQty: 2 }
], 'p-size')
const sizeView = skuListView(sizeOnly.product, sizeOnly.skus)
assert.strictEqual(sizeView.specCount, 2)
assert.strictEqual(sizeView.lowCellCount, 0)
assert.strictEqual(sizeView.specLineText, '2 个规格')
assert.strictEqual(sizeView.specGroups.length, 1)
assert.strictEqual(sizeView.specGroups[0].key, '__flat__')
assert.strictEqual(sizeView.specGroups[0].title, '')
assert.deepStrictEqual(sizeView.specGroups[0].chips.map(function (chip) {
  return chip.label
}), ['S 3', 'M 9'])

const plain = inv.createProduct({
  name: '纯牛奶',
  sku: 'MK-001',
  costPrice: 2.8,
  salePrice: 4.5,
  stock: 10,
  alertQty: 5
}, 1000, 'p-plain')
const plainView = skuListView(plain, [])
assert.deepStrictEqual(plainView, {
  specCount: 0,
  lowCellCount: 0,
  specLineText: '',
  specGroups: []
})

const noSkuRecords = inv.createProduct({
  name: '新衣服',
  costPrice: 10,
  salePrice: 20,
  stock: 0,
  colors: ['红', '蓝'],
  sizes: ['S', 'M']
}, 1000, 'p-nosku')
const noSkuView = skuListView(noSkuRecords, [])
assert.strictEqual(noSkuView.specCount, 4)
assert.strictEqual(noSkuView.lowCellCount, 0)
assert.strictEqual(noSkuView.specLineText, '4 个规格')
assert.deepStrictEqual(noSkuView.specGroups, [])

console.log('sku-list-view tests passed')
