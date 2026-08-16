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

  onShow() {
    this.refresh()
  },

  refresh() {
    const skus = store.getSkus()
    const list = inventory.filterProducts(store.getProducts(), this.data.keyword, skus).map(function (item) {
      return util.withView(item, skus)
    })
    this.setData({ list: list })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + e.currentTarget.dataset.id })
  },

  goPurchase(e) {
    getApp().setSelectedProduct(e.currentTarget.dataset.id)
    wx.switchTab({ url: '/pages/purchase/purchase' })
  },

  goSale(e) {
    getApp().setSelectedProduct(e.currentTarget.dataset.id)
    wx.switchTab({ url: '/pages/sale/sale' })
  },

  goConvert(e) {
    wx.navigateTo({ url: '/pages/convert/convert?id=' + e.currentTarget.dataset.id })
  }
})
