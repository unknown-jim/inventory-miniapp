const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    phone: '',
    address: '',
    remark: '',
    openingAmount: '',
    saleCount: 0,
    saleAmountText: '0.00',
    receivable: 0,
    receivableText: '0.00',
    hasDebt: false,
    ledger: [],
    showPay: false,
    payAmount: '',
    payRemark: '',
    showOpening: false,
    openingRemark: ''
  },

  onLoad(query) {
    this.selectAfterSave = query.select === '1'
    this.openPayAfter = query.pay === '1'
    if (!query.id) {
      wx.setNavigationBarTitle({ title: '新增客户' })
      return
    }
    this.setData({ id: query.id, isEdit: true })
    wx.setNavigationBarTitle({ title: '编辑客户' })
  },

  async onShow() {
    if (!this.data.id) return
    if (!(await store.ready())) return
    this.fillCustomer(this.data.id)
  },

  fillCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      wx.showToast({ title: '客户不存在', icon: 'none' })
      return
    }
    const summary = inventory.summarizeCustomerAccount(store.getRecords(), id)
    const hasDebt = summary.receivable > 0
    this.setData({
      id: customer.id,
      isEdit: true,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      remark: customer.remark,
      saleCount: summary.count,
      saleAmountText: util.money(summary.amount),
      receivable: summary.receivable,
      receivableText: util.money(summary.receivable),
      hasDebt: hasDebt,
      ledger: summary.ledger.slice(0, 20).map(util.withRecordView)
    }, () => {
      if (this.openPayAfter) {
        this.openPayAfter = false
        if (hasDebt) this.openPay()
      }
    })
  },

  goRecord(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  openPay() {
    if (!(this.data.receivable > 0)) {
      wx.showToast({ title: '当前没有欠款', icon: 'none' })
      return
    }
    this.setData({
      showPay: true,
      showOpening: false,
      payAmount: util.money(this.data.receivable),
      payRemark: ''
    })
  },

  closePay() {
    this.setData({ showPay: false })
  },

  keepPay() {},

  async submitPay() {
    try {
      await store.addPayment({
        customerId: this.data.id,
        amount: this.data.payAmount,
        remark: this.data.payRemark
      })
      this.setData({ showPay: false })
      this.fillCustomer(this.data.id)
      wx.showToast({ title: '已收款', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  },

  openOpening() {
    this.setData({
      showOpening: true,
      showPay: false,
      openingAmount: '',
      openingRemark: ''
    })
  },

  closeOpening() {
    this.setData({ showOpening: false })
  },

  keepOpening() {},

  async submitOpening() {
    try {
      await store.addOpening({
        customerId: this.data.id,
        amount: this.data.openingAmount,
        remark: this.data.openingRemark
      })
      this.setData({ showOpening: false })
      this.fillCustomer(this.data.id)
      wx.showToast({ title: '已记账', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  },

  async save() {
    try {
      const openingText = String(this.data.openingAmount || '').trim()
      let opening = 0
      if (!this.data.isEdit && openingText) {
        opening = inventory.round2(openingText)
        if (opening <= 0) {
          throw new Error('期初欠款必须大于 0')
        }
      }
      const saved = await store.saveCustomer({
        id: this.data.id,
        name: this.data.name,
        phone: this.data.phone,
        address: this.data.address,
        remark: this.data.remark
      })
      if (opening > 0) {
        await store.addOpening({
          customerId: saved.id,
          amount: opening,
          remark: '上线前欠款'
        })
      }
      if (this.selectAfterSave) {
        getApp().setSelectedCustomer(saved.id)
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      util.showError(error)
    }
  },

  callPhone() {
    if (!this.data.phone) {
      wx.showToast({ title: '还没有电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: this.data.phone })
  },

  remove() {
    if (this.data.hasDebt) {
      wx.showModal({
        title: '还有欠款',
        content: '当前欠款 ¥' + this.data.receivableText + '，请先收款后再删除。',
        showCancel: false
      })
      return
    }
    wx.showModal({
      title: '删除客户',
      content: '历史送货记录会保留当时的客户信息，只是以后不能再选这个客户。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteCustomer(this.data.id)
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
