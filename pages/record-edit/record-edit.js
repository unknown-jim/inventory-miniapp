const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const slipActions = require('../../utils/slip-actions')

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
    canReturn: false,
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
    payType: 'cash',
    customerId: '',
    customerName: '散客（可不选）',
    customerPhone: '',
    customerAddress: '',
    showCustomerPicker: false,
    showPicker: false,
    customerKeyword: '',
    filteredCustomers: [],
    hasOrder: false,
    isMulti: false,
    lines: [],
    showSlip: false,
    slip: null,
    exporting: false
  },

  onLoad(query) {
    const record = store.getRecord(query.id)
    if (!record) {
      wx.showToast({ title: '流水不存在', icon: 'none' })
      return
    }
    const view = util.withRecordView(record)
    const all = store.getRecords()
    let title = '修改销售'
    if (view.isPay) title = '修改收款'
    else if (view.isOpening) title = '修改期初欠款'
    else if (view.isIn) title = '修改进货'
    else if (view.isReturn) title = '修改退货'
    else if (view.isConvert) title = '修改改规格'
    wx.setNavigationBarTitle({ title: title })
    this.costPrice = record.costPrice
    let lines = []
    let canReturn = view.isOut && inventory.returnableQty(all, record) > 0
    let amountText = util.money(record.amount)
    let profitText = view.isOut || view.isReturn ? util.money(record.profit) : '0.00'
    let productName = record.productName
    let specText = view.specText
    if (view.isOut) {
      const order = inventory.buildSaleOrder(all, record)
      lines = order.records.map(function (item) {
        const spec = inventory.specText(item.color, item.size)
        return {
          id: item.id,
          productName: item.productName,
          specText: spec,
          hasSpec: !!spec,
          qty: String(item.qty),
          unitPrice: String(item.unitPrice),
          amountText: util.money(item.amount),
          profitText: util.money(item.profit),
          costText: util.money(item.costPrice),
          costPrice: item.costPrice
        }
      })
      canReturn = order.records.some(function (item) {
        return inventory.returnableQty(all, item) > 0
      })
      amountText = util.money(order.amount)
      profitText = util.money(order.profit)
      productName = lines.length === 1 ? lines[0].productName : '本单 ' + lines.length + ' 种商品'
      specText = lines.length === 1 ? lines[0].specText : ''
    }
    this.setData({
      id: record.id,
      type: record.type,
      typeText: view.typeText,
      isIn: view.isIn,
      isOut: view.isOut,
      isPay: view.isPay,
      isOpening: view.isOpening,
      isReturn: view.isReturn,
      isConvert: view.isConvert,
      isMulti: lines.length > 1,
      canReturn: canReturn,
      productName: productName,
      specText: specText,
      timeText: util.formatDateTime(record.createdAt),
      qty: view.isPay || view.isOpening ? '' : String(record.qty),
      unitPrice: view.isPay || view.isOpening || view.isConvert ? '' : String(record.unitPrice),
      amount: view.isPay || view.isOpening ? String(record.amount) : '',
      amountText: amountText,
      profitText: profitText,
      remark: record.remark || '',
      payType: record.payType === 'credit' ? 'credit' : 'cash',
      customerId: record.customerId || '',
      customerName: record.customerName || (view.isOut ? '散客（可不选）' : (record.customerName || '')),
      customerPhone: record.customerPhone || '',
      customerAddress: record.customerAddress || '',
      costText: view.isOut || view.isReturn ? util.money(record.costPrice) : '',
      hasOrder: !!(record.orderId),
      lines: lines
    })
  },

  refreshAmount() {
    if (this.data.isPay || this.data.isOpening) {
      const amount = inventory.round2(this.data.amount)
      this.setData({ amountText: util.money(amount), profitText: '0.00' })
      return
    }
    if (this.data.isOut) {
      const amount = this.data.lines.reduce(function (sum, item) {
        return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
      }, 0)
      const profit = this.data.lines.reduce(function (sum, item) {
        return sum + (inventory.toNumber(item.unitPrice) - inventory.toNumber(item.costPrice)) * inventory.toNumber(item.qty)
      }, 0)
      this.setData({
        amountText: util.money(amount),
        profitText: util.money(profit)
      })
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
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
    this.refreshAmount()
  },

  onLineField(e) {
    const id = e.currentTarget.dataset.id
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const lines = this.data.lines.map(function (item) {
      if (item.id !== id) return item
      const next = Object.assign({}, item)
      next[field] = value
      const qty = inventory.toNumber(next.qty)
      const price = inventory.toNumber(next.unitPrice)
      next.amountText = util.money(qty * price)
      next.profitText = util.money((price - inventory.toNumber(item.costPrice)) * qty)
      return next
    })
    const amount = lines.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
    }, 0)
    const profit = lines.reduce(function (sum, item) {
      return sum + (inventory.toNumber(item.unitPrice) - inventory.toNumber(item.costPrice)) * inventory.toNumber(item.qty)
    }, 0)
    this.setData({
      lines: lines,
      amountText: util.money(amount),
      profitText: util.money(profit)
    })
  },

  setPayType(e) {
    this.setData({ payType: e.currentTarget.dataset.type })
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

  onShow() {
    const selectedCustomerId = getApp().consumeSelectedCustomer()
    if (this.expectCustomer && selectedCustomerId) {
      this.expectCustomer = false
      this.selectCustomer(selectedCustomerId)
    }
  },

  openSlip() {
    try {
      const record = store.getRecord(this.data.id)
      const slipView = util.withSlipViewFromRecord(store.getRecords(), record)
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

  save() {
    try {
      if (this.data.isPay || this.data.isOpening) {
        store.updateRecord(this.data.id, {
          amount: this.data.amount,
          remark: this.data.remark
        })
      } else if (this.data.isOut) {
        store.updateRecord(this.data.id, {
          remark: this.data.remark,
          payType: this.data.payType,
          customerId: this.data.customerId,
          items: this.data.lines.map(function (item) {
            return {
              id: item.id,
              qty: item.qty,
              unitPrice: item.unitPrice
            }
          })
        })
      } else if (this.data.isReturn || this.data.isConvert) {
        store.updateRecord(this.data.id, {
          qty: this.data.qty,
          remark: this.data.remark
        })
      } else {
        store.updateRecord(this.data.id, {
          qty: this.data.qty,
          unitPrice: this.data.unitPrice,
          remark: this.data.remark,
          payType: this.data.payType,
          customerId: this.data.customerId
        })
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
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
            : (this.data.isOut
              ? '删除后会把本单全部商品的库存改回去。记错商品时用这个，然后重新开单。'
              : '删除后会把库存改回去。记错商品时用这个，然后重新开单。')))),
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        try {
          store.deleteRecord(this.data.id)
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
