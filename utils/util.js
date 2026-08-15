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

function formatDateTime(ts) {
  const d = new Date(ts)
  return formatDate(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function formatDocNo(record, prefix) {
  const d = new Date(record.createdAt)
  const ymd = String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate())
  const kind = prefix || (record.type === 'in' ? 'RK' : 'CK')
  const tail = String(record.orderId || record.id || '').slice(-4).toUpperCase()
  return kind + ymd + '-' + tail
}

function withSlipView(order, receivable) {
  const records = order.records && order.records.length ? order.records : [order]
  const first = records[0]
  const amount = order.amount != null
    ? inventory.toNumber(order.amount)
    : inventory.round2(records.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.amount)
    }, 0))
  const thisDebt = (order.payType || first.payType) === 'credit' ? amount : 0
  const totalDebt = inventory.toNumber(receivable)
  const prevDebt = inventory.round2(totalDebt - thisDebt)
  return {
    docNo: formatDocNo({
      createdAt: order.createdAt || first.createdAt,
      type: 'out',
      id: order.id || first.id,
      orderId: order.id || first.orderId
    }, 'SH'),
    timeText: formatDateTime(order.createdAt || first.createdAt),
    lines: records.map(function (item) {
      return {
        id: item.id,
        productName: item.productName,
        specText: inventory.specText(item.color, item.size),
        sku: item.sku || '未填',
        qtyText: String(item.qty),
        priceText: money(item.unitPrice),
        amountText: money(item.amount)
      }
    }),
    amountText: money(amount),
    remark: order.remark || first.remark || '',
    hasCustomer: !!(order.customerName || first.customerName),
    customerName: order.customerName || first.customerName || '',
    customerPhone: order.customerPhone || first.customerPhone || '',
    customerAddress: order.customerAddress || first.customerAddress || '',
    isCredit: (order.payType || first.payType) === 'credit',
    payText: (order.payType || first.payType) === 'credit' ? '赊账' : '现结',
    prevDebtText: money(prevDebt),
    thisDebtText: money(thisDebt),
    receivableText: money(totalDebt),
    hasDebt: totalDebt > 0
  }
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function withView(product, skus) {
  const margin = inventory.calcMargin(product.costPrice, product.salePrice)
  const hasSpecs = inventory.productHasSpecs(product)
  return Object.assign({}, product, {
    hasSpecs: hasSpecs,
    lowStock: inventory.isLowStock(product, skus),
    profitText: money(margin.profit),
    rateText: margin.rate + '%',
    costText: money(product.costPrice),
    saleText: money(product.salePrice),
    stockText: String(product.stock),
    skuSummary: hasSpecs ? inventory.skuSummaryText(product, skus) : '',
    specHint: hasSpecs && inventory.isLowStock(product, skus) ? '部分规格低于预警' : ''
  })
}

function withRecordView(record) {
  const isIn = record.type === 'in'
  const isOut = record.type === 'out'
  const isPay = record.type === 'pay'
  const isCredit = isOut && record.payType === 'credit'
  const spec = inventory.specText(record.color, record.size)
  let typeText = '销售'
  if (isIn) typeText = '进货'
  else if (isPay) typeText = '收款'
  else if (isCredit) typeText = '赊账'
  return Object.assign({}, record, {
    isIn: isIn,
    isOut: isOut,
    isPay: isPay,
    isCredit: isCredit,
    typeText: typeText,
    tagClass: isPay ? 'tag-pay' : (isIn ? 'tag-in' : (isCredit ? 'tag-credit' : 'tag-out')),
    timeText: formatTime(record.createdAt),
    amountText: money(record.amount),
    priceText: money(record.unitPrice),
    profitText: money(record.profit),
    qtyText: isPay ? '' : String(record.qty),
    customerText: record.customerName || '',
    specText: spec,
    hasSpec: !!spec
  })
}

function withCustomerView(customer, summary) {
  const saleCount = summary ? summary.count : 0
  const saleAmount = summary ? summary.amount : 0
  const receivable = summary ? summary.receivable : 0
  return Object.assign({}, customer, {
    phoneText: customer.phone || '未填电话',
    addressText: customer.address || '未填地址',
    saleCount: saleCount,
    saleAmountText: money(saleAmount),
    receivable: receivable,
    receivableText: money(receivable),
    hasDebt: receivable > 0
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
  formatDateTime: formatDateTime,
  formatDocNo: formatDocNo,
  withView: withView,
  withRecordView: withRecordView,
  withCustomerView: withCustomerView,
  withSlipView: withSlipView,
  showError: showError
}
