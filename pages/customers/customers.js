const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    keyword: '',
    list: [],
    pageLoading: true
  },

  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    this.refresh()
  },

  refresh() {
    const list = inventory.sortCustomers(
      inventory.filterCustomers(store.getCustomers(), this.data.keyword)
    ).map(function (item) {
      return util.withCustomerView(item, item.account || {
        count: 0,
        amount: 0,
        creditAmount: 0,
        paidAmount: 0,
        receivable: 0
      })
    }).sort(function (a, b) {
      const debtDiff = inventory.toNumber(b.receivable) - inventory.toNumber(a.receivable)
      if (debtDiff) return debtDiff
      return 0
    })
    this.setData({ pageLoading: false, list: list })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit' })
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + e.currentTarget.dataset.id })
  },

  goCollect(e) {
    wx.navigateTo({
      url: '/pages/customer-edit/customer-edit?id=' + e.currentTarget.dataset.id + '&pay=1'
    })
  },

  goSale(e) {
    getApp().setSelectedCustomer(e.currentTarget.dataset.id)
    wx.switchTab({ url: '/pages/sale/sale' })
  }
})
