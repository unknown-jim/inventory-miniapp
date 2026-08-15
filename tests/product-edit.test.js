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

console.log('product-edit tests passed')
