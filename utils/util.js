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
  const tail = String(record.id || '').slice(-4).toUpperCase()
  return kind + ymd + '-' + tail
}

function productById(products) {
  const map = {}
  ;(products || []).forEach(function (item) {
    if (item && item.id) map[item.id] = item
  })
  return map
}

function withSlipView(order, receivable, products, shopName) {
  const lines = inventory.recordLines(order)
  const amount = order.amount != null
    ? inventory.toNumber(order.amount)
    : inventory.round2(lines.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.amount)
    }, 0))
  // amount 允许从 lines[] 求和补出来，settledAmount 却按 record.amount 收口；
  // 不把补出来的 amount 递给它，缺 amount 的单据实收会被夹成 0，送货单印错。
  const paidAmount = inventory.settledAmount(Object.assign({}, order, { amount: amount }))
  const thisDebt = inventory.round2(amount - paidAmount)
  const totalDebt = inventory.toNumber(receivable)
  const prevDebt = inventory.round2(totalDebt - thisDebt)
  const productsMap = productById(products)
  const operatorName = String(order.operatorName || '').trim()
  return {
    docNo: formatDocNo({
      createdAt: order.createdAt,
      type: 'out',
      id: order.id
    }, 'SH'),
    timeText: formatDateTime(order.createdAt),
    shopName: String(shopName || '').trim(),
    operatorName: operatorName,
    operatorText: operatorName || '—',
    lines: lines.map(function (item) {
      const parts = inventory.specParts(item, productsMap[item.productId])
      return {
        id: item.lineId,
        productName: item.productName,
        specParts: parts,
        specText: inventory.specLabelText(parts),
        sku: item.sku || '',
        qtyText: String(item.qty),
        priceText: money(item.unitPrice),
        amountText: money(item.amount)
      }
    }),
    amountText: money(amount),
    // 应收恒等于货物总额；实收是开单时填的那个数，欠款是两者之差。
    dueText: money(amount),
    paidText: money(paidAmount),
    remark: order.remark || '',
    hasCustomer: !!order.customerName,
    customerName: order.customerName || '',
    customerPhone: order.customerPhone || '',
    customerAddress: order.customerAddress || '',
    isCredit: thisDebt > 0,
    prevDebtText: money(prevDebt),
    thisDebtText: money(thisDebt),
    receivableText: money(totalDebt),
    hasDebt: totalDebt > 0
  }
}

// 2b-2b 删掉了 withSlipViewFromRecord。
// 「截断到某张老单据时刻的欠款」现在唯一的算法在服务端 getSlip：客户端没有
// 流水全集，也就没有任何现算钱的路径 —— 由 tests/no-client-cloud-db.test.js
// 的结构禁令保证，不再靠运行时守卫。页面拿到 { record, receivable } 之后
// 直接调 withSlipView。

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function withView(product, skus) {
  const margin = inventory.calcMargin(product.costPrice, product.salePrice)
  const hasSpecs = inventory.productHasSpecs(product)
  const blankProcess = inventory.isBlankProcess(product)
  return Object.assign({}, product, {
    hasSpecs: hasSpecs,
    blankProcess: blankProcess,
    specTag: inventory.specKindTag(product),
    specAxis1: inventory.specAxis1Name(product),
    specAxis2: inventory.specAxis2Name(product),
    lowStock: inventory.isLowStock(product, skus),
    profitText: money(margin.profit),
    rateText: margin.rate + '%',
    costText: money(product.costPrice),
    saleText: money(product.salePrice),
    stockText: String(product.stock),
    skuSummary: hasSpecs ? inventory.skuSummaryText(product, skus) : '',
    specHint: hasSpecs && inventory.isLowStock(product, skus)
      ? (blankProcess ? '待加工低于预警' : '部分规格低于预警')
      : ''
  })
}

function withRecordView(record) {
  const isIn = record.type === 'in'
  const isOut = record.type === 'out'
  const isPay = record.type === 'pay'
  const isOpening = record.type === 'opening'
  const isReturn = record.type === 'return'
  const isConvert = record.type === 'convert'
  const isAdjust = inventory.isAdjust(record)
  const paidAmount = isOut ? inventory.settledAmount(record) : 0
  const debtAmount = isOut ? inventory.round2(inventory.toNumber(record.amount) - paidAmount) : 0
  const isCredit = debtAmount > 0
  const lines = inventory.recordLines(record)
  const line = lines[0] || {}
  const single = lines.length === 1
  const lineCount = lines.length || 1
  const isMulti = lines.length > 1
  const qty = inventory.round2(lines.reduce(function (sum, item) {
    return sum + inventory.toNumber(item.qty)
  }, 0))
  const spec = single ? inventory.specText(line.color, line.size) : ''
  const fromSpec = single ? inventory.specText(line.fromColor, line.fromSize) : ''
  let typeText = '销售'
  if (isIn) typeText = '进货'
  else if (isPay) typeText = '收款'
  else if (isOpening) typeText = '期初'
  else if (isReturn) typeText = '退货'
  else if (isConvert) typeText = '改规格'
  else if (isAdjust) typeText = inventory.adjustTypeText(record)
  else if (isCredit) typeText = '赊账'
  let specText = spec
  if (isConvert) specText = fromSpec + ' → ' + spec
  if ((isIn || isAdjust) && !spec && line.skuId) specText = inventory.blankStockLabel()
  let productName = ''
  if (isPay) productName = '收款'
  else if (isOpening) productName = '期初欠款'
  else if (isOut || isReturn) productName = inventory.orderProductTitle(lines)
  else productName = line.productName || ''
  const view = Object.assign({}, record, {
    productName: productName,
    sku: single ? (line.sku || '') : '',
    skuId: single ? (line.skuId || '') : '',
    color: single ? (line.color || '') : '',
    size: single ? (line.size || '') : '',
    qty: qty,
    unitPrice: single ? inventory.toNumber(line.unitPrice) : 0,
    costPrice: inventory.toNumber(line.costPrice),
    reason: line.reason || '',
    isIn: isIn,
    isOut: isOut,
    isPay: isPay,
    isOpening: isOpening,
    isReturn: isReturn,
    isConvert: isConvert,
    isAdjust: isAdjust,
    isCredit: isCredit,
    isMulti: isMulti,
    lineCount: lineCount,
    typeText: typeText,
    tagClass: isAdjust
      ? 'tag-adjust'
      : (isPay
      ? 'tag-pay'
      : (isOpening || isCredit ? 'tag-credit' : (isIn ? 'tag-in' : (isReturn ? 'tag-return' : (isConvert ? 'tag-convert' : 'tag-out'))))),
    timeText: formatTime(record.createdAt),
    amountText: money(record.amount),
    paidText: money(paidAmount),
    debtText: money(debtAmount),
    hasDebt: debtAmount > 0,
    priceText: money(single ? line.unitPrice : 0),
    profitText: money(record.profit),
    qtyText: isPay || isOpening ? '' : String(qty),
    customerText: record.customerName || '',
    specText: specText,
    hasSpec: !!specText
  })
  // 列表只渲染单头，明细和 openid 不必进 setData
  delete view.lines
  delete view.operatorOpenid
  return view
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
