const store = require('../../utils/store')
const inventory = require('../../utils/inventory')

Page({
  data: {
    keyword: '',
    onlyAlert: false,
    list: [],
    alertCount: 0,
    pageLoading: true
  },

  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    const filter = getApp().consumePendingInventoryFilter()
    if (filter === 'alert') {
      this.setData({ onlyAlert: true, keyword: '' })
    } else if (filter === 'all') {
      this.setData({ onlyAlert: false, keyword: '' })
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
      pageLoading: false,
      list: source.map(function (item) {
        // Array.from 按码位取首字：emoji 开头的商品名不会切出半个代理对
        return Object.assign({}, item, {
          lowStock: inventory.isLowStock(item, skus),
          thumbText: Array.from(String(item.name || ''))[0] || '品'
        })
      }),
      alertCount: alerts.length
    })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  showAll() {
    this.setData({ onlyAlert: false })
    this.refresh()
  },

  showAlert() {
    this.setData({ onlyAlert: true })
    this.refresh()
  },

  // 商品图加载失败只换占位首字，不删 item.image，下次刷新还会再试。
  // 动态路径走「先建空对象再赋键」：对象字面量里写 ['list[' + i + ']'] 是计算属性，
  // 会被微信 babel 编成 @babel/runtime helper（tests/no-babel-helpers.test.js 禁）。
  onThumbError(e) {
    const i = e.currentTarget.dataset.index
    const patch = {}
    patch['list[' + i + '].imageFailed'] = true
    this.setData(patch)
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + e.currentTarget.dataset.id })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  }
})
