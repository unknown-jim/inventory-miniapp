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

  async onShow() {
    if (!(await store.ready())) return
    const filter = getApp().consumePendingInventoryFilter()
    if (filter === 'alert') {
      this.setData({ onlyAlert: true })
    } else if (filter === 'all') {
      this.setData({ onlyAlert: false })
    }
    this.refresh()
  },

  refresh() {
    const skus = store.getSkus()
    const products = inventory.filterProducts(store.getProducts(), this.data.keyword, skus)
    const alerts = products.filter(function (item) {
      return inventory.isLowStock(item, skus)
    })
    const source = this.data.onlyAlert ? alerts : products
    this.setData({
      list: source.map(function (item) {
        const view = util.withView(item, skus)
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
  },

  goConvert(e) {
    wx.navigateTo({ url: '/pages/convert/convert?id=' + e.currentTarget.dataset.id })
  }
})
