const store = require('../../utils/store')
const util = require('../../utils/util')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
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
    isEmpty: true,
    canRestore: false,
    blocked: false,
    blockedMessage: '',
    shopName: ''
  },

  async onShow() {
    const status = store.getStatus()
    if (!status.canBookkeep) {
      this.setData({
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
        isEmpty: true,
        canRestore: false
      })
      return
    }
    try {
      await store.ensureReady()
    } catch (error) {
      this.setData({
        blocked: true,
        blockedMessage: error.message || '无法记账',
        isEmpty: true,
        canRestore: false
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
      isEmpty: dash.productCount === 0,
      canRestore: store.hasClearedBackup()
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

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
  },

  goMembers() {
    wx.navigateTo({ url: '/pages/members/members' })
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
  },

  clearData() {
    wx.showModal({
      title: '清空全部数据',
      content: '商品、客户、种类模板和流水都会从当前店删掉。最近一次可以用「恢复清空前数据」免费找回；更早的清空记录会留在云端。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.clearAll()
          this.refresh()
          wx.showToast({ title: '已清空', icon: 'success' })
        } catch (error) {
          util.showError(error)
        }
      }
    })
  },

  restoreCleared() {
    wx.showModal({
      title: '恢复清空前数据',
      content: '将恢复到最近一次清空前的账本。清空之后新记的账会丢掉。更早的清空记录仍保存在云端。',
      confirmColor: '#0F766E',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.restoreCleared()
          this.refresh()
          wx.showToast({ title: '已恢复', icon: 'success' })
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
