const assert = require('assert')
const fs = require('fs')
const path = require('path')
const skuCardView = require('../utils/sku-card-view').skuCardView

const zeroRow = { stock: '0' }
const stockRow = { stock: '2' }

const sharedEmpty = skuCardView('blank', true, [zeroRow])
assert.strictEqual(sharedEmpty.showBlankPriceCard, false)
assert.strictEqual(sharedEmpty.showBlankStockCard, false)
assert.strictEqual(sharedEmpty.blankStockRows.length, 0)

const splitEmpty = skuCardView('blank', false, [zeroRow])
assert.strictEqual(splitEmpty.showBlankPriceCard, true)
assert.strictEqual(splitEmpty.showBlankStockCard, false)

const sharedStock = skuCardView('blank', true, [zeroRow, stockRow])
assert.strictEqual(sharedStock.showBlankPriceCard, false)
assert.strictEqual(sharedStock.showBlankStockCard, true)
assert.strictEqual(sharedStock.blankStockRows.length, 1)
assert.strictEqual(sharedStock.blankStockRows[0].stock, '2')

const splitStock = skuCardView('blank', false, [zeroRow, stockRow])
assert.strictEqual(splitStock.showBlankPriceCard, true)
assert.strictEqual(splitStock.showBlankStockCard, true)

const finished = skuCardView('finished', true, [zeroRow])
assert.strictEqual(finished.showFinishedSkuCard, true)
assert.strictEqual(finished.showBlankPriceCard, false)
assert.strictEqual(finished.showBlankStockCard, false)

const wxml = fs.readFileSync(
  path.join(__dirname, '../pages/product-edit/product-edit.wxml'),
  'utf8'
)
assert.strictEqual((wxml.match(/'销售规格'/g) || []).length, 1)
assert.ok(wxml.indexOf('各规格售价') >= 0)
assert.ok(wxml.indexOf('showBlankPriceCard') >= 0)
assert.ok(wxml.indexOf('showBlankStockCard') >= 0)
assert.ok(wxml.indexOf('showFinishedSkuCard') >= 0)
assert.ok(wxml.indexOf('blankStockRows') >= 0)
assert.ok(wxml.indexOf('现货只在退货或改规格后才会有数') < 0)
assert.ok(wxml.indexOf("productKind === 'blank' ? '销售规格' : '规格库存'") < 0)
assert.ok(wxml.indexOf('库存调整') >= 0)
assert.ok(wxml.indexOf('不计入进货、不改进价') >= 0)
assert.ok(wxml.indexOf('通过进货 / 销售变动') < 0)

// 商品图：选图入口和压缩画布钉在 wxml，require 钉在 js
assert.ok(wxml.indexOf('pickImage') >= 0)
assert.ok(wxml.indexOf('image-canvas') >= 0)
assert.ok(wxml.indexOf('id="imageCanvas"') >= 0)
const editJs = fs.readFileSync(
  path.join(__dirname, '../pages/product-edit/product-edit.js'),
  'utf8'
)
assert.ok(editJs.indexOf('product-image') >= 0)

const productsWxml = fs.readFileSync(
  path.join(__dirname, '../pages/products/products.wxml'),
  'utf8'
)
assert.ok(productsWxml.indexOf('action-strip') >= 0)
assert.ok(productsWxml.indexOf('stat-grid') >= 0)
assert.ok(productsWxml.indexOf('goods-spec-toggle') >= 0)
assert.ok(productsWxml.indexOf('查看规格') >= 0)
assert.ok(productsWxml.indexOf('收起规格') >= 0)
assert.ok(productsWxml.indexOf('catchtap="toggleSpecs"') >= 0)
assert.ok(productsWxml.indexOf('skuSummary') < 0)
assert.ok(productsWxml.indexOf('bar-fill') < 0)
assert.ok(productsWxml.indexOf('barWidth') < 0)
assert.ok(productsWxml.indexOf('item.specTag') < 0)
assert.ok(productsWxml.indexOf('profitText') < 0)
assert.ok(productsWxml.indexOf('rateText') < 0)
assert.ok(productsWxml.indexOf('毛利') < 0)
assert.ok(productsWxml.indexOf("item.sku || '未填'") < 0)
assert.ok(productsWxml.indexOf('库存调整') < 0)
// 商品图：卡片左缩略图，失败回落首字占位
assert.ok(productsWxml.indexOf('goods-thumb') >= 0)
assert.ok(productsWxml.indexOf('lazy-load') >= 0)
assert.ok(productsWxml.indexOf('thumb-empty') >= 0)
const productsCard = productsWxml.slice(productsWxml.indexOf('class="card goods-card"'))
assert.ok(productsCard.indexOf('条码') < 0)

const productsJs = fs.readFileSync(
  path.join(__dirname, '../pages/products/products.js'),
  'utf8'
)
assert.ok(productsJs.indexOf('expandedId') >= 0)
assert.ok(productsJs.indexOf('toggleSpecs') >= 0)
assert.ok(productsJs.indexOf('skuListView') >= 0)
assert.ok(productsJs.indexOf('barWidth') < 0)

// 商品图：选货弹层行内缩略图，sale / purchase 同构；无图不渲染，不加占位灰块
const saleWxml = fs.readFileSync(
  path.join(__dirname, '../pages/sale/sale.wxml'),
  'utf8'
)
const purchaseWxml = fs.readFileSync(
  path.join(__dirname, '../pages/purchase/purchase.wxml'),
  'utf8'
)
assert.ok(saleWxml.indexOf('sheet-thumb') >= 0)
assert.ok(purchaseWxml.indexOf('sheet-thumb') >= 0)

const recordsWxml = fs.readFileSync(
  path.join(__dirname, '../pages/records/records.wxml'),
  'utf8'
)
assert.ok(recordsWxml.indexOf('>调整</view>') >= 0 || recordsWxml.indexOf('调整') >= 0)
assert.ok(recordsWxml.indexOf('data-type="adjust"') >= 0)

console.log('product-edit tests passed')
