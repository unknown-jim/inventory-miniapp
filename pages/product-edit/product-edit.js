const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    sku: '',
    barcode: '',
    costPrice: '',
    salePrice: '',
    stock: '',
    alertQty: '5',
    stockText: '',
    marginText: '0.00',
    rateText: '0%'
  },

  onLoad(query) {
    if (!query.id) {
      wx.setNavigationBarTitle({ title: '新增商品' })
      return
    }
    const product = store.getProduct(query.id)
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      return
    }
    const margin = inventory.calcMargin(product.costPrice, product.salePrice)
    this.setData({
      id: product.id,
      isEdit: true,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      costPrice: String(product.costPrice),
      salePrice: String(product.salePrice),
      alertQty: String(product.alertQty),
      stockText: String(product.stock),
      marginText: util.money(margin.profit),
      rateText: margin.rate + '%'
    })
    wx.setNavigationBarTitle({ title: '编辑商品' })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
    this.refreshMargin()
  },

  refreshMargin() {
    const margin = inventory.calcMargin(this.data.costPrice, this.data.salePrice)
    this.setData({
      marginText: util.money(margin.profit),
      rateText: margin.rate + '%'
    })
  },

  save() {
    try {
      store.saveProduct({
        id: this.data.id,
        name: this.data.name,
        sku: this.data.sku,
        barcode: this.data.barcode,
        costPrice: this.data.costPrice,
        salePrice: this.data.salePrice,
        stock: this.data.isEdit ? 0 : this.data.stock,
        alertQty: this.data.alertQty
      })
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
      title: '删除商品',
      content: '历史流水会保留，只是不再显示这个商品。',
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        store.deleteProduct(this.data.id)
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(function () {
          wx.navigateBack()
        }, 400)
      }
    })
  }
})
