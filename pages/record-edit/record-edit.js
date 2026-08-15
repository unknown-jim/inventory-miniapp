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
    const title = view.isPay ? '修改收款' : (view.isIn ? '修改进货' : '修改销售')
    wx.setNavigationBarTitle({ title: title })
    this.costPrice = record.costPrice
    this.setData({
      id: record.id,
      type: record.type,
      typeText: view.typeText,
      isIn: view.isIn,
      isOut: view.isOut,
      isPay: view.isPay,
      productName: record.productName,
      specText: view.specText,
      timeText: util.formatDateTime(record.createdAt),
      qty: view.isPay ? '' : String(record.qty),
      unitPrice: view.isPay ? '' : String(record.unitPrice),
      amount: view.isPay ? String(record.amount) : '',
      amountText: util.money(record.amount),
      profitText: view.isOut ? util.money(record.profit) : '0.00',
      remark: record.remark || '',
      payType: record.payType === 'credit' ? 'credit' : 'cash',
      customerId: record.customerId || '',
      customerName: record.customerName || (view.isOut ? '散客（可不选）' : (record.customerName || '')),
      customerPhone: record.customerPhone || '',
      customerAddress: record.customerAddress || '',
      costText: view.isOut ? util.money(record.costPrice) : '',
      hasOrder: !!(record.orderId)
    })
  },

  refreshAmount() {
    if (this.data.isPay) {
      const amount = inventory.round2(this.data.amount)
      this.setData({ amountText: util.money(amount), profitText: '0.00' })
      return
    }
    const qty = inventory.toNumber(this.data.qty)
    const price = inventory.toNumber(this.data.unitPrice)
    const amount = inventory.round2(qty * price)
    const profit = this.data.isOut
      ? inventory.round2((price - inventory.toNumber(this.costPrice)) * qty)
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
      if (this.data.isPay) {
        store.updateRecord(this.data.id, {
          amount: this.data.amount,
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

  remove() {
    wx.showModal({
      title: '删除流水',
      content: this.data.isPay
        ? '删除后这笔收款会从欠款里去掉。'
        : '删除后会把库存改回去。记错商品时用这个，然后重新开单。',
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
