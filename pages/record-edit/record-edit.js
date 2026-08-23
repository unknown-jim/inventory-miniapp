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
    costText: '',
    remark: '',
    paidAmount: '',
    paidTouched: false,
    debtText: '0.00',
    hasNewDebt: false,
    paidOver: false,
    overText: '0.00',
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
    exporting: false
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
        return {
          id: item.lineId,
          productName: item.productName,
          specText: spec,
          hasSpec: !!spec,
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
    this.setData(Object.assign({
      id: record.id,
      type: record.type,
      typeText: view.typeText,
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

  // 实收和应收的差额，跟销售页一套算法：欠款就是差额，多收要拦下来。
  paidPatch(dueAmount, paidValue) {
    const debt = inventory.round2(inventory.round2(dueAmount) - inventory.round2(paidValue))
    return {
      debtText: util.money(debt > 0 ? debt : 0),
      hasNewDebt: debt > 0,
      paidOver: debt < 0,
      overText: util.money(debt < 0 ? -debt : 0)
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
        if (this.data.paidOver) {
          wx.showToast({ title: '实收比应收多，请改实收', icon: 'none' })
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
