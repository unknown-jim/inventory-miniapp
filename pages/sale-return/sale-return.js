const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const messages = require('../../utils/messages')

// 退货入库。设计稿 Screen/08 退货入库 4:135、Screen/08b 退货·全部可退 0 7:366、
// UX注释/退货入库 4:271。
//
// 入口两个（本批都不改，都带 ?id=<销售单 id>）：
//   pages/record-edit/record-edit.js:554   销售流水详情的「退货入库」
//   components/record-sheet/index.js:217   记一笔面板的「退货 -> 选原单」
// 稿注释 4:273：从销售详情进入，原单信息只读；**不开空白退货单**。
//
// 记账规矩（docs/accounting-vs-policy.md、docs/blank-process.md）：
//   · 退货原样入库：按当时卖掉的那一格回到现货、不夹带换格。这件事全部由服务端
//     utils/inventory.js 的 applyReturnOrder -> restockLine 完成，本页只收数量。
//   · 退货先冲这张单没收到的钱，冲不掉的才算退现金；完整顺序是 欠款 -> 现金 -> 预收
//     （splitBeyondDebt）。**这一刀切在服务端写路径**，结果记在退货单单头的
//     paidAmount（退现金）与 prepayRefund（回流预收）上。
//   · 整单共享待加工的口径不受本页影响：退的是成品格，待加工池不动（稿注释 4:276）。
//
// 本页发给服务端的 payload 只有 items[]（saleOrderId / saleLineId / qty）与 remark。
// **屏上算出来的任何金额都不回传**，服务端不认也不该认。

// 数量解析。返回 null = 这一格现在不是一个合法数量（空框、或打了非法字符）。
// 只收 0 和正数、最多两位小数：件数是「有几件」，没有负数这一档；两位小数是全仓的
// 量纲（inventory.round2）。写法与 pages/stock-take 的 parseTake 同源。
function parseQty(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  return Number(raw)
}

// 本次退货里能冲掉多少「这张单还没收到的钱」。
//
// 【为什么客户端敢算这一格】它逐字复用服务端 returnCashRefund 的前两步，而这两步
// 用到的量全部由**已导出**的纯函数给出：
//     D（本单欠款基准）      = 单据金额 − inventory.creditedAmount(销售单)
//     O（除本次以外已退货值） = inventory.returnedAmountOfSale(销售单)
//     left = D − O
//     冲欠款 = left <= 0 ? 0 : min(left, 本次退货额)
// 与 utils/inventory.js:1067-1069 的 debt / left / beyondDebt 取补即同一式子。
// 两个前提各自成立：
//   · creditedAmount 只读 amount / paidAmount / prepayUsed / prepayRefund，与已退货值
//     无关，所以「补丁前的销售单」算出的 D 和服务端「补丁后的销售单」算出的 D 相同；
//   · 服务端传的 othersReturned = returnedAmountOfSale(补丁后) − 本次退货额，正是
//     returnedAmountOfSale(补丁前)。
//
// 【为什么到此为止】再往下把「冲不掉的那部分」拆成 退现金 / 回预收 要走
// splitBeyondDebt，而它和 returnCashRefund **都没有 module.exports**。在页面里抄一份
// 就成了同一条规则的第三份实现 —— utils/inventory.js:1041 的注释点名过这件事
//（单条 append 和整组重算必须共用同一份定义，否则两条路会算出两套数）。
// 所以拆分只在两种情况下说死：销售单没用过预收时冲不掉的必然全是现金（prepayLeft
// 恒为 0）；用过预收时预览只说「退款」，真值以提交后服务端回传的单头为准。
function splitPreview(sale, amount) {
  const amt = inventory.round2(amount)
  if (!sale || amt <= 0) {
    return { amount: amt > 0 ? amt : 0, offset: 0, beyond: amt > 0 ? amt : 0 }
  }
  const debt = inventory.round2(
    inventory.toNumber(sale.amount) - inventory.creditedAmount(sale)
  )
  const left = inventory.round2(debt - inventory.returnedAmountOfSale(sale))
  const offset = left <= 0 ? 0 : (left >= amt ? amt : left)
  const rounded = inventory.round2(offset)
  return { amount: amt, offset: rounded, beyond: inventory.round2(amt - rounded) }
}

// 销售单用过预收时的去向说明。不硬报现金数的理由见 splitPreview 上方。
const PREPAY_NOTE = '退款先退现金，现金不够的部分回抵这张单用掉的预收；实际拆分以提交结果为准。'

// 预览措辞。稿 4:284 与措辞样张 7:352 的拼装规则（caption 7:351 原话：
// 「先冲本单欠款再退现金；欠款冲完则省略「冲欠款」段」）：
//   · 冲欠款 > 0 且冲不掉 > 0 —— 样张 B 7:358 逐字：
//       本次退货 ¥96.00 · 先冲欠款 ¥84.00，再退现金 ¥12.00
//   · 冲欠款 = 0            —— 样张 A 7:353 逐字：
//       本次退货 ¥128.00 · 本单欠款已冲完，退现金 ¥128.00
//   · 冲不掉 = 0（全额冲欠款）—— 稿上没有样张，按同一条规则镜像推出来：
//       本次退货 ¥50.00 · 冲欠款 ¥50.00
//     「冲欠款」这个词取自退货① toast 13:322 的原文，不新造词。
// 冲欠款那一格用 text/debt 红（稿 7:362 绑 $7:346）。
function previewOf(split, prepayUsed) {
  const parts = [{ t: '本次退货 ', a: '¥' + util.money(split.amount), debt: false }]
  if (split.amount <= 0) return parts
  const cashWord = prepayUsed > 0 ? '退款 ' : '退现金 '
  if (split.beyond <= 0) {
    parts.push({ t: ' · 冲欠款 ', a: '¥' + util.money(split.offset), debt: true })
  } else if (split.offset > 0) {
    parts.push({ t: ' · 先冲欠款 ', a: '¥' + util.money(split.offset), debt: true })
    parts.push({ t: '，再' + cashWord, a: '¥' + util.money(split.beyond), debt: false })
  } else {
    parts.push({ t: ' · 本单欠款已冲完，' + cashWord, a: '¥' + util.money(split.beyond), debt: false })
  }
  return parts
}

// 完成 toast。**这里读的是服务端刚写进去的退货单单头，不是屏上的预览** ——
// paidAmount = 退出去的现金，prepayRefund = 回流预收（为 0 时服务端不写这个键，
// utils/inventory.js:2328），冲欠款 = 退货额 − 现金 − 回预收。
// 稿 toast/退货完成 7:92「已退货 · 退现金 ¥128.00」与 toast/退货① 13:322
//「已退货 · 冲欠款 ¥84.00 · 退现金 ¥12.00」合起来给出的规则：各段只在 > 0 时出现。
function toastOf(record) {
  if (!record) return '已退货入库'
  const amount = inventory.round2(inventory.toNumber(record.amount))
  const cash = inventory.round2(inventory.toNumber(record.paidAmount))
  const back = inventory.round2(inventory.toNumber(record.prepayRefund))
  const offset = inventory.round2(amount - cash - back)
  let text = '已退货'
  if (offset > 0) text += ' · 冲欠款 ¥' + util.money(offset)
  if (cash > 0) text += ' · 退现金 ¥' + util.money(cash)
  if (back > 0) text += ' · 回预收 ¥' + util.money(back)
  return text
}

Page({
  data: {
    pageLoading: true,
    // 空串 = 没出错。可重试与不可重试是两种错误态，不可重试的那种不给重试按钮
    //（docs/ui-scale.md「新页面要」第 5 条）。
    loadErrorText: '',
    loadErrorRetry: false,
    orderId: '',
    docNoText: '',
    customerName: '',
    timeText: '',
    remark: '',
    lines: [],
    // 稿 Screen/08b：整单每一行的可退数量都是 0。空 lines 也落这一档。
    allZero: false,
    previewParts: [],
    previewNote: '',
    canSubmit: false,
    submitText: '确认退货',
    submitting: false
  },

  onLoad(query) {
    this.orderId = String((query && query.id) || '')
    this.sale = null
    this.load()
  },

  reload() {
    this.load()
  },

  async load() {
    this.setData({ pageLoading: true, loadErrorText: '', loadErrorRetry: false })
    if (!this.orderId) {
      // 稿注释 4:273：不开空白退货单。没有原单就把话说明白，别留一张能点的空表。
      this.setData({
        pageLoading: false,
        loadErrorText: '退货要绑原销售单。请从销售流水详情的「退货入库」进来。',
        loadErrorRetry: false
      })
      return
    }
    const failure = await store.readyOrFailure()
    if (failure) {
      // store 内部已经用 util.showError 报过一次具体原因，这里不再报第二遍。
      // **两类失败要分开**（G322）：没选店 / 被移出店铺那一类点重试不会好，
      // 从前一律写「检查网络后重试」，对它们是错的诊断 —— 对的诊断当时只在那个
      // 一闪而过的 toast 里。可重试那一半保留本页自己的话：它说的是「这张单」，
      // 比 store 给的通用那句更准。
      this.setData({
        pageLoading: false,
        loadErrorText: failure.retryable ? '账本没读到，检查网络后重试。' : failure.text,
        loadErrorRetry: failure.retryable
      })
      return
    }
    // 分页之后缓存里不一定有这条销售单，一律按 id 去服务端取。
    let record = null
    try {
      record = await store.fetchRecord(this.orderId)
    } catch (error) {
      this.setData({
        pageLoading: false,
        loadErrorText: messages.forStaff(error).text || '这张单没读到，稍后再试。',
        loadErrorRetry: true
      })
      return
    }
    if (!record || record.type !== 'out') {
      this.setData({
        pageLoading: false,
        loadErrorText: '这条流水不在了，或者它不是销售单 —— 只有销售单能退货。',
        loadErrorRetry: false
      })
      return
    }
    this.sale = record
    const lines = inventory.recordLines(record).map(function (item) {
      const remain = inventory.returnableQty(item)
      const unitPrice = inventory.toNumber(item.unitPrice)
      return {
        id: String(item.lineId || ''),
        productName: item.productName,
        specText: inventory.specText(item.color, item.size),
        // 稿 meta 4:249 逐字：「已卖 2 · 已退 0 · 可退 2」
        metaText: '已卖 ' + inventory.round2(inventory.toNumber(item.qty))
          + ' · 已退 ' + inventory.round2(inventory.toNumber(item.returnedQty))
          + ' · 可退 ' + remain,
        // 稿 price 7:29 逐字：「单价 ¥128.00/件」
        priceText: '单价 ¥' + util.money(unitPrice) + '/件',
        unitPrice: unitPrice,
        remain: remain,
        // 预填 = 可退件数（全退）。tests/ui.test.js 的 returnWholeOrder 把这一条
        // 当前提断言，改它要连带改测试。
        qty: remain > 0 ? String(remain) : '0',
        disabled: remain <= 0,
        canDec: false,
        canInc: false
      }
    })
    const allZero = lines.every(function (line) {
      return line.remain <= 0
    })
    this.setData(Object.assign({
      pageLoading: false,
      orderId: record.id,
      // 单号前缀与 pages/record-edit 同一份（销售单 = 'S'），同一张单在两屏上不该长两样。
      docNoText: util.formatDocNo(record, 'S'),
      customerName: record.customerName || '散客',
      timeText: util.formatDateTime(record.createdAt),
      allZero: allZero
    }, this.fold(lines)))
  },

  // 把每行的 qty 折成 canDec / canInc、合计、预览与按钮文案。纯计算。
  // 合计的取整口径与服务端一致：**先按行 round2(qty × 单价)，再对和 round2**
  //（服务端 applyReturnOrder 每行写 amount: round2(qty * unitPrice)，单头走 sumBy）。
  fold(lines) {
    const sale = this.sale
    let sum = 0
    const next = lines.map(function (line) {
      const parsed = parseQty(line.qty)
      const qty = parsed === null ? 0 : parsed
      sum += inventory.round2(qty * line.unitPrice)
      return Object.assign({}, line, {
        canDec: !line.disabled && qty > 0,
        canInc: !line.disabled && qty < line.remain
      })
    })
    const amount = inventory.round2(sum)
    const prepayUsed = inventory.round2(inventory.toNumber(sale && sale.prepayUsed))
    const split = splitPreview(sale, amount)
    return {
      lines: next,
      canSubmit: amount > 0,
      // 稿 4:270 的 label「确认退货 · ¥128.00」；没得退时退回 08b 禁用样张的「确认退货」。
      submitText: amount > 0 ? ('确认退货 · ¥' + util.money(amount)) : '确认退货',
      previewParts: previewOf(split, prepayUsed),
      previewNote: (prepayUsed > 0 && split.beyond > 0) ? PREPAY_NOTE : ''
    }
  },

  onQty(e) {
    const id = e.currentTarget.dataset.id
    const raw = String(e.detail.value == null ? '' : e.detail.value)
    const lines = this.data.lines.map(function (line) {
      if (line.id !== id) return line
      const qty = parseQty(raw)
      // 非法输入不落进 data：空框留空（店员在清了重填），别的一律弹回上一次的合法值。
      if (qty === null) {
        return Object.assign({}, line, { qty: raw.trim() ? line.qty : '' })
      }
      // 稿注释 4:274：每行上限 = 可退数量。超了就地夹住，不等服务端抛错。
      if (qty > line.remain) {
        return Object.assign({}, line, { qty: String(line.remain) })
      }
      return Object.assign({}, line, { qty: raw })
    })
    this.setData(this.fold(lines))
  },

  stepUp(e) {
    this.step(e, 1)
  },

  stepDown(e) {
    this.step(e, -1)
  },

  step(e, delta) {
    const id = e.currentTarget.dataset.id
    const lines = this.data.lines.map(function (line) {
      if (line.id !== id || line.disabled) return line
      const parsed = parseQty(line.qty)
      const base = parsed === null ? 0 : parsed
      let next = inventory.round2(base + delta)
      if (next < 0) next = 0
      if (next > line.remain) next = line.remain
      return Object.assign({}, line, { qty: String(next) })
    })
    this.setData(this.fold(lines))
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  // 稿 08b 底栏 13:326。正常路径是从销售详情 navigateTo 过来的，退一页就回到那一屏；
  // 被人直接带 id 打开时栈里没有上一页，就 redirectTo 到那张单的详情 ——
  // 不留一个退不出去的屏。
  backToSale() {
    const pages = getCurrentPages()
    if (pages && pages.length > 1) {
      wx.navigateBack()
      return
    }
    if (this.data.orderId) {
      wx.redirectTo({ url: '/pages/record-edit/record-edit?id=' + this.data.orderId })
      return
    }
    wx.switchTab({ url: '/pages/records/records' })
  },

  async submit() {
    if (this.data.submitting || !this.data.canSubmit) return
    const orderId = this.data.orderId
    const items = []
    this.data.lines.forEach(function (line) {
      const qty = parseQty(line.qty)
      if (qty === null || qty <= 0) return
      items.push({ saleOrderId: orderId, saleLineId: line.id, qty: qty })
    })
    if (!items.length) {
      wx.showToast({ title: '请先填退货数量', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const created = await store.addReturn({
        items: items,
        remark: this.data.remark
      })
      // 成功之后**不复位 submitting**：页面马上就要退掉，让按钮在这 400ms 里保持
      // 不可点，堵住「连点两次记两笔」。
      wx.showToast({ title: toastOf(created && created[0]), icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      this.setData({ submitting: false })
      util.showError(error)
    }
  }
})
