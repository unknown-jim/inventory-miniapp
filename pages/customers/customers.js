const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
  data: {
    keyword: '',
    list: []
  },

  async onShow() {
    if (!(await store.ready())) return
    this.refresh()
  },

  refresh() {
    const records = store.getRecords()
    const list = inventory.sortCustomers(
      inventory.filterCustomers(store.getCustomers(), this.data.keyword)
    ).map(function (item) {
      return util.withCustomerView(item, inventory.summarizeCustomerAccount(records, item.id))
    }).sort(function (a, b) {
      const debtDiff = inventory.toNumber(b.receivable) - inventory.toNumber(a.receivable)
      if (debtDiff) return debtDiff
      return 0
    })
    this.setData({ list: list })
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
