const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    keyword: '',
    onlyAlert: false,
    list: [],
    alertCount: 0
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const products = inventory.filterProducts(store.getProducts(), this.data.keyword)
    const alerts = products.filter(inventory.isLowStock)
    const source = this.data.onlyAlert ? alerts : products
    this.setData({
      list: source.map(function (item) {
        const view = util.withView(item)
        const cap = item.alertQty * 3 || 1
        view.barWidth = Math.max(8, Math.min(100, Math.round(item.stock / cap * 100)))
        return view
      }),
      alertCount: alerts.length
    })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  toggleAlert() {
    this.setData({ onlyAlert: !this.data.onlyAlert })
    this.refresh()
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + e.currentTarget.dataset.id })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  }
})
