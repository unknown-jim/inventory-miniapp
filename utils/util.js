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
  const thisDebt = order.payType === 'credit' ? amount : 0
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
    remark: order.remark || '',
    hasCustomer: !!order.customerName,
    customerName: order.customerName || '',
    customerPhone: order.customerPhone || '',
    customerAddress: order.customerAddress || '',
    isCredit: order.payType === 'credit',
    payText: order.payType === 'credit' ? '赊账' : '现结',
    prevDebtText: money(prevDebt),
    thisDebtText: money(thisDebt),
    receivableText: money(totalDebt),
    hasDebt: totalDebt > 0
  }
}

function withSlipViewFromRecord(records, record, products, shopName) {
  if (!record || record.type !== 'out') {
    throw new Error('不是销售流水')
  }
  // 欠款一律按当前流水重算：改/删更早的记录后，重印的送货单必须跟账面对得上。
  // 写入时冻结的快照做不到（见 2a 审计 B1），所以不存这个字段。
  // 2b 之后 records 不再整份在内存里，这个调用点必须换成云函数按客户查一段流水再算。
  const list = records || []
  const missing = record.customerId && !list.some(function (item) {
    return item.id === record.id
  })
  if (missing) {
    throw new Error('流水不完整，无法算欠款')
  }
  return withSlipView(
    record,
    inventory.receivableAt(list, record.customerId, record.createdAt),
    products,
    shopName
  )
}

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
  const isCredit = isOut && record.payType === 'credit'
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
  withSlipViewFromRecord: withSlipViewFromRecord,
  showError: showError
}
