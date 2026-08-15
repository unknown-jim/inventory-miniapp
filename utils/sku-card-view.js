const inventory = require('./inventory')

function skuCardView(kind, sharedPrice, skuRows) {
  const rows = skuRows || []
  const blankStockRows = kind === 'blank'
    ? rows.filter(function (row) {
      return inventory.toNumber(row.stock) > 0
    })
    : []
  return {
    blankStockRows: blankStockRows,
    showBlankPriceCard: kind === 'blank' && !sharedPrice && rows.length > 0,
    showBlankStockCard: blankStockRows.length > 0,
    showFinishedSkuCard: kind === 'finished' && rows.length > 0
  }
}

module.exports = {
  skuCardView: skuCardView
}
