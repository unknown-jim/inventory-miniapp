const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    keyword: '',
    list: []
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const list = inventory.filterProducts(store.getProducts(), this.data.keyword).map(util.withView)
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
  }
})
