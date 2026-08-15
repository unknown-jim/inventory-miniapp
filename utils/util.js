const inventory = require('./inventory')

function money(value) {
  return inventory.round2(value).toFixed(2)
}

function moneyText(value) {
  return '¥' + money(value)
}

function formatTime(ts) {
  const d = new Date(ts)
  const month = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const hour = pad(d.getHours())
  const minute = pad(d.getMinutes())
  return month + '-' + day + ' ' + hour + ':' + minute
}

function formatDate(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function withView(product) {
  const margin = inventory.calcMargin(product.costPrice, product.salePrice)
  return Object.assign({}, product, {
    lowStock: inventory.isLowStock(product),
    profitText: money(margin.profit),
    rateText: margin.rate + '%',
    costText: money(product.costPrice),
    saleText: money(product.salePrice),
    stockText: String(product.stock)
  })
}

function withRecordView(record) {
  return Object.assign({}, record, {
    isIn: record.type === 'in',
    typeText: record.type === 'in' ? '进货' : '销售',
    timeText: formatTime(record.createdAt),
    amountText: money(record.amount),
    priceText: money(record.unitPrice),
    profitText: money(record.profit),
    qtyText: String(record.qty)
  })
}

function showError(error) {
  wx.showToast({
    title: (error && error.message) || '操作失败',
    icon: 'none'
  })
}

module.exports = {
  money: money,
  moneyText: moneyText,
  formatTime: formatTime,
  formatDate: formatDate,
  withView: withView,
  withRecordView: withRecordView,
  showError: showError
}
