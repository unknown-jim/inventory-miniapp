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
    isEmpty: false,
    pageLoading: true,
    blocked: false,
    blockedMessage: '',
    shopName: ''
  },

  async onShow() {
    const status = store.getStatus()
    if (!status.canBookkeep) {
      this.setData({
        pageLoading: false,
        blocked: true,
        blockedMessage: status.message,
        shopName: '',
        dateText: util.formatDate(Date.now()),
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
        isEmpty: false
      })
      return
    }
    if (!store.isReady()) {
      this.setData({ pageLoading: true, blocked: false })
    }
    try {
      await store.ensureReady()
    } catch (error) {
      this.setData({
        pageLoading: false,
        blocked: true,
        blockedMessage: error.message || '无法记账',
        isEmpty: false
      })
      return
    }
    this.setData({
      blocked: false,
      blockedMessage: '',
      shopName: status.shopName
    })
    this.refresh()
  },

  refresh() {
    const dash = store.dashboard()
    const skus = store.getSkus()
    this.setData({
      pageLoading: false,
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
    this.openGoods('all')
  },

  goInventory() {
    this.openGoods('all')
  },

  goAlerts() {
    this.openGoods('alert')
  },

  openGoods(filter) {
    getApp().setPendingInventoryFilter(filter)
    wx.switchTab({ url: '/pages/products/products' })
  },

  goAddProduct() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  goCustomers() {
    wx.switchTab({ url: '/pages/customers/customers' })
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
  },

  onAlertTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + id })
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  },

  async seedDemo() {
    try {
      await store.loadSeed()
      this.refresh()
      wx.showToast({ title: '已填入示例数据', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
