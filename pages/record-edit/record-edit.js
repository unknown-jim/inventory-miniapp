const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const slipActions = require('../../utils/slip-actions')
const memberChips = require('../../utils/member-chips').memberChips
const repriceHintView = require('../../utils/reprice-hint')

function navTitle(view, editing) {
  if (view.isPay) return editing ? '修改收款' : '收款详情'
  if (view.isOpening) return editing ? '修改期初欠款' : '期初欠款详情'
  if (view.isIn) return editing ? '修改进货' : '进货详情'
  if (view.isReturn) return editing ? '修改退货' : '退货详情'
  if (view.isConvert) return editing ? '修改改规格' : '改规格详情'
  if (view.isAdjust) return editing ? '修改调整' : '调整详情'
  return editing ? '修改销售' : '销售详情'
}

Page({
  data: {
    id: '',
    type: '',
    typeText: '',
    isIn: false,
    isOut: false,
    isPay: false,
    isOpening: false,
    isReturn: false,
    isConvert: false,
    isAdjust: false,
    canReturn: false,
    editing: false,
    productName: '',
    specText: '',
    timeText: '',
    qty: '',
    unitPrice: '',
    amount: '',
    amountText: '0.00',
    profitText: '0.00',
    priceText: '0.00',
    costText: '',
    remark: '',
    paidAmount: '',
    paidTouched: false,
    debtText: '0.00',
    hasNewDebt: false,
    paidOver: false,
    overText: '0.00',
    // 【7a】只读态（稿 Screen/07）新增的槽。
    docNoText: '',
    tagClass: '',
    directionTagText: '',
    // 稿 card/实收 4:212 的「已退」两行（UX注释 n6 4:282）
    hasReturned: false,
    returnedText: '0.00',
    returnSplitText: '',
    // 稿 row/欠款 4:220 / 欠款变体 13:282：当前口径 = 应收 − 已结清 − 已退，夹断到 0
    debtNowText: '¥0.00（已清）',
    debtNowAmountText: '0.00',
    hasDebtNow: false,
    // 「去收款」桥（稿 btn/去收款 13:446）。只在**仍有剩余欠款**时出现，
    // 冲完即清不带桥（docs/design-file.md 的铁律）。
    canCollect: false,
    // 【G1】本单抵掉的预收。B6 已经给送货单加了这一格，详情页同步显示。
    hasPrepayUsed: false,
    prepayUsedText: '0.00',
    // 【G1】编辑态：要收的现金上限 = 应收 − 抵扣，「收满」chip 上印的就是它
    cashDueText: '0.00',
    paidNote: '本单已收讫',
    paidNoteTone: 'done',
    paidBlocked: false,
    paidBlockToast: '',
    customerId: '',
    customerName: '散客（可不选）',
    customerPhone: '',
    customerAddress: '',
    operatorOpenid: '',
    operatorName: '',
    members: [],
    myOpenid: '',
    showCustomerPicker: false,
    showPicker: false,
    customerKeyword: '',
    filteredCustomers: [],
    isMulti: false,
    directionText: '',
    reason: '',
    reasonOptions: [],
    adjustHint: '',
    lines: [],
    showSlip: false,
    slip: null,
    exporting: false,
    slipCanvasWidth: 1760,
    slipCanvasHeight: 4000
  },

  async onLoad(query) {
    if (!(await store.ready())) return
    await this.loadRecord(query.id)
  },

  async loadRecord(id) {
    // 分页之后本地缓存里不一定有这条流水（可能是客户页的往来记录，也可能是
    // 流水页翻到第 5 页的那条），一律按 id 去服务端取。
    // try/catch 必须在这里面：onLoad 和 cancelEdit 都是 fire-and-forget，
    // 抛出去没有人接，只会变成一个静默的未处理 rejection。
    let record = null
    try {
      record = await store.fetchRecord(id)
    } catch (error) {
      util.showError(error)
      return
    }
    if (!record) {
      wx.showToast({ title: '流水不存在', icon: 'none' })
      return
    }
    const view = util.withRecordView(record)
    const recordLines = inventory.recordLines(record)
    const firstLine = inventory.firstLine(record)
    wx.setNavigationBarTitle({ title: navTitle(view, false) })
    this.costPrice = firstLine.costPrice
    let lines = []
    let canReturn = false
    const amountText = util.money(record.amount)
    const profitText = view.isOut || view.isReturn ? util.money(record.profit) : '0.00'
    let productName = view.productName
    let specText = view.specText
    let orderDue = 0
    let orderPaid = 0
    if (view.isOut) {
      orderDue = inventory.toNumber(record.amount)
      orderPaid = inventory.settledAmount(record)
    }
    if (view.isOut || view.isReturn) {
      lines = recordLines.map(function (item) {
        const spec = inventory.specText(item.color, item.size)
        // 稿 清单行 4:209 的 sub：「白色/1.8m · ¥128.00 × 2」，有退货再接「· 已退 1」
        // （稿 4:211 与 UX注释 n1 4:230：「清单行标已退数量（已退 1）」）。
        const returnedQty = inventory.round2(inventory.toNumber(item.returnedQty))
        const parts = []
        if (spec) parts.push(spec)
        parts.push('¥' + util.money(item.unitPrice) + ' × ' + item.qty)
        if (returnedQty > 0) parts.push('已退 ' + returnedQty)
        return {
          id: item.lineId,
          productName: item.productName,
          specText: spec,
          hasSpec: !!spec,
          subText: parts.join(' · '),
          qty: String(item.qty),
          unitPrice: String(item.unitPrice),
          priceText: util.money(item.unitPrice),
          amountText: util.money(item.amount),
          profitText: util.money(item.profit),
          costText: util.money(item.costPrice),
          costPrice: item.costPrice
        }
      })
    }
    // 改之前这张单长什么样，给保存前那句提示用（见 utils/reprice-hint.js）。
    // data.lines 和实收都会被编辑改掉，所以要在这里另存一份。
    this.saleBefore = view.isOut ? repriceHintView.savedSaleOf(record) : null
    this.repriceConfirmed = false
    if (view.isOut) {
      canReturn = recordLines.some(function (item) {
        return inventory.returnableQty(item) > 0
      })
      productName = lines.length === 1 ? lines[0].productName : '本单 ' + lines.length + ' 种商品'
      specText = lines.length === 1 ? lines[0].specText : ''
    }
    let members = []
    let myOpenid = ''
    if (view.isOut) {
      try {
        myOpenid = await store.whoami()
        const res = await store.listMembers()
        this._members = res.members || []
        members = memberChips(this._members, record.operatorOpenid || '', myOpenid)
      } catch (error) {
        this._members = []
        util.showError(error)
      }
    }
    // 【7a】只读态要的派生量。全部用 utils/inventory.js 的现成纯函数算，
    // **不在页面里从流水折钱**（tests/no-client-cloud-db.test.js 的 T-S3 禁令）。
    //
    // credited = 现金实收 + 抵掉的预收（inventory.js:1010-1019）；
    // returned = 这张销售单已退掉的货值（inventory.js:1024）；
    // 当前欠款 = 应收 − credited − returned，夹断到 0
    //   —— 稿 UX注释 n6 4:282 原话「应收−实收−已退，夹断到 0」。
    const credited = view.isOut ? inventory.creditedAmount(record) : 0
    const returned = view.isOut ? inventory.returnedAmountOfSale(record) : 0
    const debtNow = view.isOut
      ? Math.max(0, inventory.round2(inventory.toNumber(record.amount) - credited - returned))
      : 0
    // 退货去向（稿 13:273「冲欠款 ¥84.00 · 退现金 ¥12.00」）。这两格由服务端在
    // 写退货单时定死（returnCashRefund），本页只是把销售单侧的合计读出来：
    // 冲欠款 = 已退货值 − 已退现金，而已退现金这一半客户端拿不到逐张明细，
    // 所以这里只印**已退货值**总额，不拆分；拆分那一行只在能算出来时才印。
    // —— 见规格 §6 偏差 ③ 与 [OPEN-Q-4]。
    // 【G1】本单抵掉的预收
    const prepayUsed = inventory.round2(inventory.toNumber(record.prepayUsed))
    this.prepayUsed = prepayUsed
    this.setData(Object.assign({
      id: record.id,
      type: record.type,
      typeText: view.typeText,
      // 稿 card/单据信息 4:196：tag ＋ 单号。tag 的映射在 utils/util.js 里，
      // 与流水列表同一份（同一张单在两屏上不该长两样）。
      tagClass: view.tagClass,
      directionTagText: view.isAdjust ? view.typeText : '',
      docNoText: '单号 ' + util.formatDocNo(record,
        view.isOut ? 'S' : (view.isIn ? 'RK' : (view.isReturn ? 'TH' : (view.isPay ? 'SK' : (view.isOpening ? 'QC' : (view.isConvert ? 'GG' : 'TZ')))))),
      hasReturned: returned > 0,
      returnedText: util.money(returned),
      returnSplitText: returned > 0 ? '已退货值合计，明细见退货单' : '',
      hasDebtNow: debtNow > 0,
      debtNowText: debtNow > 0 ? '¥' + util.money(debtNow) : '¥0.00（已清）',
      debtNowAmountText: util.money(debtNow),
      // 「去收款」桥：仍有剩余欠款、且这张单挂在某个客户名下才出。
      // 欠款不可能挂在散客名下（服务端 assertCustomerForDebt 挡着），
      // 这里仍然双判，是为了让「桥点进去必然有款可收」在页面这一侧也成立。
      canCollect: debtNow > 0 && !!record.customerId,
      hasPrepayUsed: prepayUsed > 0,
      prepayUsedText: util.money(prepayUsed),
      priceText: util.money(view.unitPrice),
      isIn: view.isIn,
      isOut: view.isOut,
      isPay: view.isPay,
      isOpening: view.isOpening,
      isReturn: view.isReturn,
      isConvert: view.isConvert,
      isAdjust: view.isAdjust,
      isMulti: lines.length > 1,
      canReturn: canReturn,
      editing: false,
      productName: productName,
      specText: specText,
      timeText: util.formatDateTime(record.createdAt),
      qty: view.isPay || view.isOpening ? '' : String(view.qty),
      unitPrice: view.isPay || view.isOpening || view.isConvert || view.isAdjust ? '' : String(view.unitPrice),
      amount: view.isPay || view.isOpening ? String(record.amount) : '',
      amountText: amountText,
      profitText: profitText,
      remark: record.remark || '',
      paidAmount: view.isOut ? util.money(orderPaid) : '',
      paidTouched: false,
      customerId: record.customerId || '',
      customerName: record.customerName || (view.isOut ? '散客（可不选）' : (record.customerName || '')),
      customerPhone: record.customerPhone || '',
      customerAddress: record.customerAddress || '',
      operatorOpenid: record.operatorOpenid || '',
      operatorName: record.operatorName || '',
      members: members,
      myOpenid: myOpenid,
      costText: view.isOut || view.isReturn ? util.money(firstLine.costPrice) : '',
      directionText: view.isAdjust ? (record.type === 'adjust_out' ? '出库' : '入库') : '',
      reason: view.reason,
      reasonOptions: view.isAdjust
        ? inventory.adjustReasons(record.type).map(function (item) {
          return Object.assign({}, item, { on: item.value === view.reason })
        })
        : [],
      adjustHint: record.type === 'adjust_out'
        ? '不计入销售和毛利，不开送货单'
        : '不计入进货、不改进价',
      lines: lines,
      showCustomerPicker: false
    }, this.paidPatch(orderDue, orderPaid)))
  },

  // 实收和应收的差额。【G1】「实收不能超过应收」那道闸门已经拆了：
  // 多收的钱不是错误，是**预收**（utils/inventory.js:1822-1861 的
  // resolvePaidAmount 把溢出写进 prepayAdded；updateRecord 的 out 分支
  // :2832-2834 同样接受）。所以这里从「拦下来」改成「说清去向」。
  //
  // 判定基准是 cashDue = 应收 − 本单已抵扣的预收，不是应收本身
  // ——「超收判定基准 = 应收 − 预收抵扣」是 B6 定的口径（稿 3:769 n7）。
  // 本页没有开关抵扣的控件，抵扣值原样保留（服务端 resolvePaidAmount 的
  // fallback 会把它带过去，见 :1827-1832 的注释）。
  //
  // 仍然要拦的只有两种，判据逐条对齐服务端的 throw，文案照 B6：
  //   ① 既抵扣又超收 —— utils/inventory.js:1849-1855
  //   ② 散客超收（预收挂不到人头上）—— utils/inventory.js:2832-2834
  paidPatch(dueAmount, paidValue) {
    const due = inventory.round2(dueAmount)
    const usedRaw = inventory.round2(inventory.toNumber(this.prepayUsed))
    const used = usedRaw > due ? due : usedRaw
    const cashDue = inventory.round2(due - used)
    const paid = inventory.round2(paidValue)
    const debt = inventory.round2(cashDue - paid)
    const over = debt < 0 ? inventory.round2(-debt) : 0
    let note = '本单已收讫'
    let tone = 'done'
    let blocked = false
    let toast = ''
    if (debt > 0) {
      note = '本单欠款 ¥' + util.money(debt)
      tone = 'debt'
    } else if (over > 0) {
      if (used > 0) {
        note = '已抵扣预收，实收最多 ¥' + util.money(cashDue) + '；要多收请先关掉抵扣'
        tone = 'block'
        blocked = true
        toast = '实收最多 ¥' + util.money(cashDue)
      } else if (!this.data.customerId) {
        note = '散客需收满 ¥' + util.money(cashDue) + ' · 多收 ¥' + util.money(over) + ' 请先选客户记预收'
        tone = 'block'
        blocked = true
        toast = '散客需收满，多收请先选客户'
      } else {
        note = '多收 ¥' + util.money(over) + ' · 记为' + (this.data.customerName || '该客户') + '预收'
        tone = 'prepay'
      }
    }
    return {
      cashDueText: util.money(cashDue),
      debtText: util.money(debt > 0 ? debt : 0),
      hasNewDebt: debt > 0,
      paidOver: over > 0,
      overText: util.money(over),
      paidNote: note,
      paidNoteTone: tone,
      paidBlocked: blocked,
      paidBlockToast: toast
    }
  },

  // 改数量或售价之后的应收。这里不让实收自动跟着变：原来收了多少是既成事实，
  // 改单不等于又收了钱。差额会立刻显示成欠款，要改就点「收满」或手填。
  orderDue(lines) {
    return inventory.round2((lines || this.data.lines).reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
    }, 0))
  },

  startEdit() {
    if (this.data.editing) return
    this.setData({ editing: true })
    wx.setNavigationBarTitle({ title: navTitle(this.data, true) })
  },

  cancelEdit() {
    if (!this.data.editing) return
    this.loadRecord(this.data.id)
  },

  refreshAmount() {
    if (this.data.isPay || this.data.isOpening) {
      const amount = inventory.round2(this.data.amount)
      this.setData({ amountText: util.money(amount), profitText: '0.00' })
      return
    }
    if (this.data.isOut || (this.data.isReturn && this.data.isMulti)) {
      const sign = this.data.isReturn ? -1 : 1
      const amount = this.data.lines.reduce(function (sum, item) {
        return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
      }, 0)
      const profit = this.data.lines.reduce(function (sum, item) {
        return sum + (inventory.toNumber(item.unitPrice) - inventory.toNumber(item.costPrice)) * inventory.toNumber(item.qty) * sign
      }, 0)
      this.setData(Object.assign(this.paidPatch(amount, this.data.paidAmount), {
        amountText: util.money(amount),
        profitText: util.money(profit)
      }))
      return
    }
    const qty = inventory.toNumber(this.data.qty)
    const price = inventory.toNumber(this.data.unitPrice)
    const amount = inventory.round2(qty * price)
    const profit = this.data.isOut || this.data.isReturn
      ? inventory.round2((price - inventory.toNumber(this.costPrice)) * qty * (this.data.isReturn ? -1 : 1))
      : 0
    this.setData({
      amountText: util.money(amount),
      profitText: util.money(profit)
    })
  },

  onField(e) {
    if (!this.data.editing) return
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
    this.refreshAmount()
  },

  onOperatorName(e) {
    if (!this.data.editing) return
    const name = e.detail.value
    const selectedOpenid = this.data.operatorOpenid
    const selected = (this._members || []).find(function (item) {
      return item.openid === selectedOpenid
    })
    const selectedName = selected ? String(selected.displayName || '').trim() : ''
    const patch = { operatorName: name }
    if (selectedOpenid && name !== selectedName) {
      patch.operatorOpenid = ''
    }
    patch.members = memberChips(
      this._members,
      patch.operatorOpenid != null ? patch.operatorOpenid : selectedOpenid,
      this.data.myOpenid
    )
    this.setData(patch)
  },

  pickOperator(e) {
    if (!this.data.editing) return
    const openid = e.currentTarget.dataset.openid
    const member = (this._members || []).find(function (item) {
      return item.openid === openid
    })
    this.setData({
      operatorOpenid: openid,
      operatorName: member ? String(member.displayName || '').trim() : '',
      members: memberChips(this._members, openid, this.data.myOpenid)
    })
  },

  onLineField(e) {
    if (!this.data.editing) return
    const id = e.currentTarget.dataset.id
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const sign = this.data.isReturn ? -1 : 1
    const lines = this.data.lines.map(function (item) {
      if (item.id !== id) return item
      const next = Object.assign({}, item)
      next[field] = value
      const qty = inventory.toNumber(next.qty)
      const price = inventory.toNumber(next.unitPrice)
      next.amountText = util.money(qty * price)
      next.profitText = util.money((price - inventory.toNumber(item.costPrice)) * qty * sign)
      return next
    })
    const amount = lines.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
    }, 0)
    const profit = lines.reduce(function (sum, item) {
      return sum + (inventory.toNumber(item.unitPrice) - inventory.toNumber(item.costPrice)) * inventory.toNumber(item.qty) * sign
    }, 0)
    this.setData(Object.assign(this.paidPatch(amount, this.data.paidAmount), {
      lines: lines,
      amountText: util.money(amount),
      profitText: util.money(profit)
    }))
  },

  onPaidInput(e) {
    if (!this.data.editing) return
    const value = e.detail.value
    this.setData(Object.assign({
      paidAmount: value,
      paidTouched: true
    }, this.paidPatch(this.orderDue(), value)))
  },

  fillPaidFull() {
    if (!this.data.editing) return
    const due = this.orderDue()
    this.setData(Object.assign({
      paidAmount: util.money(due),
      paidTouched: true
    }, this.paidPatch(due, due)))
  },

  fillPaidNone() {
    if (!this.data.editing) return
    const due = this.orderDue()
    this.setData(Object.assign({
      paidAmount: '0',
      paidTouched: true
    }, this.paidPatch(due, 0)))
  },

  pickReason(e) {
    if (!this.data.editing) return
    const reason = e.currentTarget.dataset.value
    this.setData({
      reason: reason,
      reasonOptions: this.data.reasonOptions.map(function (item) {
        return Object.assign({}, item, { on: item.value === reason })
      })
    })
  },

  applyCustomerFilter(keyword) {
    this.setData({
      customerKeyword: keyword,
      filteredCustomers: inventory.sortCustomers(
        inventory.filterCustomers(store.getCustomers(), keyword)
      )
    })
  },

  openCustomerPicker() {
    if (!this.data.editing) return
    this.setData({ showCustomerPicker: true })
    this.applyCustomerFilter(this.data.customerKeyword)
  },

  closeCustomerPicker() {
    this.setData({ showCustomerPicker: false })
  },

  closePickerKeep() {},

  onCustomerSearch(e) {
    this.applyCustomerFilter(e.detail.value)
  },

  selectCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      this.clearCustomer()
      return
    }
    this.setData({
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      showCustomerPicker: false
    })
    // 【7a】换客户会改变「散客超收」那一档的判据和「记为 XX 预收」里的名字，
    // 所以要重算一次实收反馈。setData 是异步的，但 paidPatch 读的是
    // this.data，上面那次 setData 的同步部分已经写进去了。
    this.refreshPaidNote()
  },

  onPickCustomer(e) {
    this.selectCustomer(e.currentTarget.dataset.id)
  },

  clearCustomer() {
    this.setData({
      customerId: '',
      customerName: '散客（可不选）',
      customerPhone: '',
      customerAddress: '',
      showCustomerPicker: false
    })
    this.refreshPaidNote()
  },

  // 只重算实收反馈，不动 lines / 金额。换客户、以及任何只改「谁」不改「多少」
  // 的操作走它。
  refreshPaidNote() {
    if (!this.data.editing || !this.data.isOut) return
    this.setData(this.paidPatch(this.orderDue(), this.data.paidAmount))
  },

  goAddCustomer() {
    this.expectCustomer = true
    this.setData({ showCustomerPicker: false })
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?select=1' })
  },

  async onShow() {
    if (!(await store.ready())) return
    const selectedCustomerId = getApp().consumeSelectedCustomer()
    if (this.expectCustomer && selectedCustomerId) {
      this.expectCustomer = false
      this.selectCustomer(selectedCustomerId)
    }
  },

  async openSlip() {
    try {
      // 重印老单要按**当时**的欠款算。客户端没有流水全集，这个数只有服务端
      // 算得出来（当前欠款减去该单之后的后缀）。**算不出来就不开单** ——
      // 宁可打不出单，也不能在客户手上的单据上印一个错数。
      const slip = await store.getSlip(this.data.id)
      const slipView = util.withSlipView(slip.record, slip.receivable, store.getProducts(), store.getShopName())
      this.slipImagePath = ''
      this.setData({
        showSlip: true,
        showCustomerPicker: false,
        slip: slipView
      })
      slipActions.prepareSlipImage(this, slipView)
    } catch (error) {
      util.showError(error)
    }
  },

  exportSlip() {
    slipActions.exportSlip(this)
  },

  closeSlip() {
    slipActions.closeSlip(this)
  },

  async save() {
    if (!this.data.editing) return
    try {
      if (this.data.isPay || this.data.isOpening) {
        await store.updateRecord(this.data.id, {
          amount: this.data.amount,
          remark: this.data.remark
        })
      } else if (this.data.isOut) {
        if (!String(this.data.paidAmount).trim()) {
          wx.showToast({ title: '请填实收，没收到就填 0', icon: 'none' })
          return
        }
        // 【G1】超收本身不再拦：多收的钱进客户预收
        // （utils/inventory.js:1856-1861，updateRecord 的 out 分支 :2832-2834）。
        // 只拦服务端一定会拒的那两种（既抵扣又超收 / 散客超收），判据和文案
        // 都在 paidPatch 里算好了。屏上那行 .paid-note 已经写着完整原因，
        // 所以 toast 只给短句 —— showToast 装不下长句，会被截断。
        if (this.data.paidBlocked) {
          wx.showToast({ title: this.data.paidBlockToast, icon: 'none' })
          return
        }
        const hint = repriceHintView.repriceHint(
          this.saleBefore, this.data.lines, this.data.paidAmount)
        if (hint && !this.repriceConfirmed) {
          wx.showModal({
            title: '这张单有退货',
            content: hint,
            confirmText: '继续保存',
            cancelText: '再想想',
            success: (res) => {
              if (!res.confirm) return
              this.repriceConfirmed = true
              this.save()
            }
          })
          return
        }
        await store.updateRecord(this.data.id, {
          remark: this.data.remark,
          paidAmount: inventory.round2(this.data.paidAmount),
          customerId: this.data.customerId,
          operatorOpenid: this.data.operatorOpenid,
          operatorName: this.data.operatorName,
          items: this.data.lines.map(function (item) {
            return {
              id: item.id,
              qty: item.qty,
              unitPrice: item.unitPrice
            }
          })
        })
      } else if (this.data.isAdjust) {
        await store.updateRecord(this.data.id, {
          qty: this.data.qty,
          remark: this.data.remark,
          reason: this.data.reason
        })
      } else if (this.data.isReturn && this.data.isMulti) {
        await store.updateRecord(this.data.id, {
          remark: this.data.remark,
          items: this.data.lines.map(function (item) {
            return { id: item.id, qty: item.qty }
          })
        })
      } else if (this.data.isReturn || this.data.isConvert) {
        await store.updateRecord(this.data.id, {
          qty: this.data.qty,
          remark: this.data.remark
        })
      } else {
        await store.updateRecord(this.data.id, {
          qty: this.data.qty,
          unitPrice: this.data.unitPrice,
          remark: this.data.remark,
          customerId: this.data.customerId
        })
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      // 保存失败（比如「数量不能小于已退货」）后还停在编辑态，店主会接着改。
      // 不复位的话同一页里再改一次单价就不再提示了。
      this.repriceConfirmed = false
      util.showError(error)
    }
  },

  goReturn() {
    wx.navigateTo({ url: '/pages/sale-return/sale-return?id=' + this.data.id })
  },

  // 「去收款」桥（稿 btn/去收款 13:446）。落点是客户详情页的收款弹层 ——
  // 和客户列表那颗「收款」钮走**同一条 URL**（pages/customers/customers.js:53-57
  // 的 goCollect：`?id=<客户>&pay=1`），customer-edit 那边 `query.pay === '1'`
  // 时自动开收款弹层（customer-edit.js:33 / :76-78），且只在 hasDebt 时开。
  // 收款额本身归 B9，本批只负责把人送过去。
  goCollect() {
    if (!this.data.canCollect) return
    wx.navigateTo({
      url: '/pages/customer-edit/customer-edit?id=' + this.data.customerId + '&pay=1'
    })
  },

  remove() {
    wx.showModal({
      title: '删除流水',
      content: this.data.isPay
        ? '删除后这笔收款会从欠款里去掉。'
        : (this.data.isOpening
          ? '删除后这笔期初欠款会从欠款里去掉。若已经收过款，可能要先改收款。'
          : (this.data.isReturn
          ? '删除后退货入库会改回去。'
          : (this.data.isConvert
            ? '删除后规格会改回原来的那一格。'
            : (this.data.isAdjust
              ? '删除后会把这件商品这一格的件数改回去。'
            : (this.data.isOut
              ? '删除后会把本单全部商品的库存改回去。记错商品时用这个，然后重新开单。'
              : '删除后会把库存改回去。记错商品时用这个，然后重新开单。'))))),
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteRecord(this.data.id)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(function () {
            wx.navigateBack()
          }, 400)
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
