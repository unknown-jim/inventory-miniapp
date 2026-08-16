const store = require('../../utils/store')
const util = require('../../utils/util')

Page({
  data: {
    dateText: '',
    productCount: 0,
    totalStock: 0,
    todaySalesAmount: '0.00',
    todayProfit: '0.00',
    todayInAmount: '0.00',
    totalReceivable: '0.00',
    hasReceivable: false,
    alertCount: 0,
    alerts: [],
    recent: [],
    isEmpty: true
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const dash = store.dashboard()
    const skus = store.getSkus()
    this.setData({
      dateText: util.formatDate(Date.now()),
      productCount: dash.productCount,
      totalStock: dash.totalStock,
      todaySalesAmount: util.money(dash.todaySalesAmount),
      todayProfit: util.money(dash.todayProfit),
      todayInAmount: util.money(dash.todayInAmount),
      totalReceivable: util.money(dash.totalReceivable),
      hasReceivable: dash.totalReceivable > 0,
      alertCount: dash.alertCount,
      alerts: dash.alerts.slice(0, 4).map(function (item) {
        return util.withView(item, skus)
      }),
      recent: dash.recent.slice(0, 6).map(util.withRecordView),
      isEmpty: dash.productCount === 0
    })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  },

  goTodaySales() {
    wx.navigateTo({ url: '/pages/records/records?type=out' })
  },

  goProducts() {
    wx.switchTab({ url: '/pages/products/products' })
  },

  goInventory() {
    this.openInventory('all')
  },

  goAlerts() {
    this.openInventory('alert')
  },

  openInventory(filter) {
    getApp().setPendingInventoryFilter(filter)
    wx.switchTab({ url: '/pages/inventory/inventory' })
  },

  goPurchase() {
    wx.switchTab({ url: '/pages/purchase/purchase' })
  },

  goSale() {
    wx.switchTab({ url: '/pages/sale/sale' })
  },

  goAddProduct() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  goCustomers() {
    wx.navigateTo({ url: '/pages/customers/customers' })
  },

  goCategories() {
    wx.navigateTo({ url: '/pages/categories/categories' })
  },

  onAlertTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + id })
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  },

  seedDemo() {
    store.loadSeed()
    this.refresh()
    wx.showToast({ title: '已填入示例数据', icon: 'success' })
  },

  clearData() {
    wx.showModal({
      title: '清空全部数据',
      content: '商品、客户、种类模板和流水都会删除，且无法恢复。',
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        store.clearAll()
        this.refresh()
        wx.showToast({ title: '已清空', icon: 'success' })
      }
    })
  }
})
