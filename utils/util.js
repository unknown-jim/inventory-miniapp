const inventory = require('./inventory')
const messages = require('./messages')

function money(value) {
  return inventory.round2(value).toFixed(2)
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
  const normalized = Object.assign({}, order, { amount: amount })
  const paidAmount = inventory.settledAmount(normalized)
  // 【G1】本次欠款要按「已结清额」算，不是按现金实收：抵掉的预收也是结清了的。
  // 不这么改，一张「应收 352 = 现金 152 + 抵预收 200」的单会在送货单上印出
  // 本次欠款 ¥200.00 —— 屏上和客户账上都是 0，只有这张纸是错的。
  // 口径读 inventory.creditedAmount（G1 契约定的那个函数，带取小），
  // 不在这里另写算式。实收那一格仍然只印现金，预收抵扣单独占一行。
  const prepayUsed = inventory.round2(inventory.toNumber(order.prepayUsed))
  const thisDebt = inventory.round2(amount - inventory.creditedAmount(normalized))
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
    // 【G1】预收抵扣。为 0 时 hasPrepayUsed 为 false，送货单与导出图**逐字段
    // 与改动前相同** —— 老单据（以及全部没抵过预收的单）不受影响。
    prepayUsedText: money(prepayUsed),
    hasPrepayUsed: prepayUsed > 0,
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
  // 【7a】原来这里还有一档 `else if (isCredit) typeText = '赊账'`，去掉了。
  // 稿上没有「赊账」这个 tag：欠款未清的销售单（样张 9:118）打的仍是中性的
  // 「销售」tag，欠不欠钱写在副行红字「欠 ¥800.00 · 未收清」里（Screen/06 的
  // UX注释 4:192 原话）。tag 说的是**这是哪种单**，不是**这单收没收到钱**——
  // 把两件事挤进同一个槽，结果就是同一张单在收款前后换一个 tag。
  let specText = spec
  if (isConvert) specText = fromSpec + ' → ' + spec
  if ((isIn || isAdjust) && !spec && line.skuId) specText = inventory.blankStockLabel()
  let productName = ''
  if (isPay) productName = '收款'
  else if (isOpening) productName = '期初欠款'
  else if (isOut || isReturn) productName = inventory.orderProductTitle(lines)
  else productName = line.productName || ''
  // 【9a】这条流水对**这个客户欠款**的影响（元，带符号）。客户详情的往来记录
  // （稿 Screen/10 的 card/往来记录 4:375）右侧那一列印的就是它：现结销售那行是
  // ¥0.00、应收 2300 实收 1500 那行是 +¥800.00、收款那行是 -¥300.00。
  //
  // **定义只有一份**：utils/inventory.js 里「单条流水折成累加器」+「累加器投影成
  // 客户账户」那一对纯函数 —— 服务端把每条流水折进 customers[].account 用的就是
  // 它们（foldAccountTerms），所以这一列**逐条相加恒等于**客户详情首卡那个
  // 「当前欠款」。不要在页面里按 amount / creditedAmount / prepayAdded 自己拼一遍：
  // 那是同一条规则的第二份实现，四种流水的符号改一处就错。
  //
  // 为什么算在这里而不是页面里：tests/no-client-cloud-db.test.js 的 T-S3 禁止
  // pages/ 与 components/ 出现这两个名字（扫描面**不含 utils/**，理由写在该文件的
  // 注释里）；T-S3b 禁的是把它们**导出**（判据是「出现在 module.exports 之后」），
  // 而这里导出的是算好的数和字符串，页面拿不到任何折钱的零件。
  // 同一层已有先例：下面 creditedAmount / returnedAmount 两格也是这么算的（7a 批）。
  const debtDelta = inventory.accountOf(inventory.recordTerms(record)).receivable
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
    // 【7a】两处改动，都照稿 Section/标签与胶囊 3:210：
    //   ① 期初从 'tag-credit'（红）改成 'tag-opening'（中性）—— 稿 9:83：
    //      「期初与销售同中性档，不上独立色（上线前一次性结转，不占色位）」。
    //   ② isCredit 不再进这个映射 —— 赊账的销售单打中性「销售」tag，见上面
    //      typeText 那一段。`.tag-credit` 本身**保持不动**：pages/customers 用它
    //      当「欠款」角标（customers.wxml:21），那是欠款语义、不是流水类型。
    tagClass: isAdjust
      ? 'tag-adjust'
      : (isPay
      ? 'tag-pay'
      : (isOpening ? 'tag-opening' : (isIn ? 'tag-in' : (isReturn ? 'tag-return' : (isConvert ? 'tag-convert' : 'tag-out'))))),
    timeText: formatTime(record.createdAt),
    amountText: money(record.amount),
    paidText: money(paidAmount),
    debtText: money(debtAmount),
    hasDebt: debtAmount > 0,
    // 【9a】见上面 debtDelta 那一段。零的时候不带符号（稿 13:658 是「¥0.00」）。
    debtDelta: debtDelta,
    debtDeltaText: (debtDelta > 0 ? '+' : (debtDelta < 0 ? '-' : ''))
      + '¥' + money(Math.abs(debtDelta)),
    // 【7a】列表行要的两个派生量。都用 utils/inventory.js 的现成纯函数算，
    // **不在页面里从流水折钱**（tests/no-client-cloud-db.test.js 的 T-S3 禁令）。
    //
    // creditedAmount = 现金实收 + 抵掉的预收（utils/inventory.js:1010-1019）。
    // 「本单结清了没有」要按它判，不能按 settledAmount：一张「应收 352 =
    // 现金 152 + 抵预收 200」的单，按现金判会显示欠 200，而客户账上是 0。
    creditedAmount: isOut || isReturn ? inventory.creditedAmount(record) : 0,
    // 这张销售单已经退掉的货值（老流水缺 returnedAmount 时函数自己按
    // returnedQty × 单价兜底，读时兜底、不写迁移）。
    returnedAmount: isOut ? inventory.returnedAmountOfSale(record) : 0,
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

// ---------------------------------------------------------------------------
// 「要补货」的行集合。稿 Screen/01 的 card/要补货 4:807 与 Screen/01b 的 7:275
// 用的是**同一份数据、同一套排序**，看板只露第 1 条（UX注释/看板 4:826 逐字：
// 「首屏只露第 1 条」「无预警不显示整段」）。
//
// 粒度是**规格**不是商品：稿上行文案是「全棉斜纹布 · 本白/2.0m」，
// 标题上的「3 种」= 本函数返回的行数，01b 的摘要「共 3 种低于预警线」同源。
//
// 三条分支**逐字镜像** inventory.isLowStock（utils/inventory.js:394-412）的分支顺序：
//   1. 待加工（isBlankProcess 且找得到 blank sku）：blank.stock 对 **product.alertQty**
//   2. 分规格且有非 blank 规格：每枚 sku 自己的 stock 对自己的 alertQty
//   3. 其余：product.stock 对 product.alertQty
// 不要「优化」成一条 filter —— 三条分支的阈值来源互不相同，合并必然改判。
//
// 排序逐字取自 UX注释/要补货 9:46：缺口（预警 − 剩）大优先；同缺口按商品名
// zh-CN 音序（localeCompare('zh-CN')）；同商品名再按规格名同一套音序。
// localeCompare 在没有 ICU 的运行时会退化成码位序 —— 这是**展示顺序不是账**，
// 退化了也不会算错钱，所以不做 polyfill、不加兜底表。
function lowStockRow(product, spec, stock, alertQty) {
  const left = inventory.round2(inventory.toNumber(stock))
  const line = inventory.round2(inventory.toNumber(alertQty))
  return {
    key: String(product.id) + '|' + String(spec),
    productId: product.id,
    productName: String(product.name || ''),
    specText: String(spec || ''),
    name: spec ? String(product.name || '') + ' · ' + spec : String(product.name || ''),
    stock: left,
    alertQty: line,
    gap: inventory.round2(line - left),
    remainText: '剩 ' + left,
    thresholdText: '/ 预警 ' + line
  }
}

function lowStockRows(products, skus) {
  const rows = []
  ;(products || []).forEach(function (product) {
    const blank = inventory.isBlankProcess(product)
      ? inventory.findBlankSku(skus, product.id)
      : null
    if (blank) {
      if (inventory.toNumber(blank.stock) <= inventory.toNumber(product.alertQty)) {
        rows.push(lowStockRow(product, inventory.blankStockLabel(), blank.stock, product.alertQty))
      }
      return
    }
    const list = inventory.productHasSpecs(product)
      ? inventory.skusOfProduct(skus, product.id).filter(function (sku) {
        return !sku.isBlank
      })
      : []
    if (list.length) {
      list.forEach(function (sku) {
        if (inventory.toNumber(sku.stock) > inventory.toNumber(sku.alertQty)) return
        rows.push(lowStockRow(product, inventory.specText(sku.color, sku.size), sku.stock, sku.alertQty))
      })
      return
    }
    if (inventory.toNumber(product.stock) <= inventory.toNumber(product.alertQty)) {
      rows.push(lowStockRow(product, '', product.stock, product.alertQty))
    }
  })
  return rows.sort(function (a, b) {
    const gapDiff = b.gap - a.gap
    if (gapDiff) return gapDiff
    const nameDiff = a.productName.localeCompare(b.productName, 'zh-CN')
    if (nameDiff) return nameDiff
    return a.specText.localeCompare(b.specText, 'zh-CN')
  })
}

// docs/ui-scale.md「金额按位数自动降档」那张表。入参是**屏上可见的那一串字**
// （含 ¥、千分位逗号、小数点，算不出来时是「—」），返回该挂哪一个 class。
// 549 万那家店的 ¥5,490,000.00 是 13 个字符，看板 hero 走中间那档。
// **不许用 CSS transform: scale 或 fit-text 之类的运行时缩放**（文档明令：
// 那会让同屏金额的视觉字重不一致，rpx 布局下还容易半像素模糊）。
function heroAmountClass(text) {
  const n = String(text == null ? '' : text).length
  if (n >= 14) return 'amount-hero-sm'
  if (n >= 11) return 'amount-hero-md'
  return 'amount-hero'
}

function statAmountClass(text) {
  const n = String(text == null ? '' : text).length
  if (n >= 13) return 'amount-stat-sm'
  if (n >= 10) return 'amount-stat-md'
  return 'amount-stat'
}

// 报错的统一出口：先过 utils/messages.js 的店员话术层，命中的按话术显示
//（长话术走 modal，toast 会被真机腰斩），没命中保持今天的行为 —— toast + 原文，
// 一个字节不变。两种情况都把原文 console.warn 一份，排查不受影响。
function showError(error) {
  const staff = messages.forStaff(error)
  if (staff.raw && staff.raw !== staff.text) console.warn('[ledger] 原始错误:', staff.raw)
  if (staff.modal) {
    wx.showModal({
      title: staff.title || '暂时不能操作',
      content: staff.text, showCancel: false, confirmText: '知道了',
      // **弹不出来就退回 toast，绝不能什么都不显示。** 微信在屏上已经有一个
      // modal 时会对第二个回 fail（utils/maintenance.js 那边记过同一个坑），
      // 而最容易撞上的正是 app.js 的更新提示 —— 它出现在「新包已下好、当前
      // 仍跑老代码」的窗口里，也就是服务端抛「请更新小程序到最新版本」的
      // 同一时刻。不兜底的话，规则 1 恰好在它唯一该出现的场景里被静默吞掉，
      // 而改动前那里是 toast、和 modal 能共存、一定看得见。
      // toast 会把长话术腰斩，但半句话远好过一句都没有。
      fail: function () {
        wx.showToast({ title: staff.text || '操作失败', icon: 'none' })
      }
    })
    return
  }
  wx.showToast({ title: staff.text || '操作失败', icon: 'none' })
}

module.exports = {
  money: money,
  formatTime: formatTime,
  formatDate: formatDate,
  formatDateTime: formatDateTime,
  formatDocNo: formatDocNo,
  withView: withView,
  withRecordView: withRecordView,
  withCustomerView: withCustomerView,
  withSlipView: withSlipView,
  lowStockRows: lowStockRows,
  heroAmountClass: heroAmountClass,
  statAmountClass: statAmountClass,
  showError: showError
}
