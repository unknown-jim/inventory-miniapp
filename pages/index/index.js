const store = require('../../utils/store')
const util = require('../../utils/util')
const messages = require('../../utils/messages')

Page({
  data: {
    dateText: '',
    productCount: 0,
    totalStock: 0,
    todaySalesAmount: '0.00',
    todayProfit: '0.00',
    todayInAmount: '0.00',
    // 今日三项算不出来时显示「—」而不是 0：0 是会被当真的错数
    todayAvailable: true,
    totalReceivable: '0.00',
    hasReceivable: false,
    alertCount: 0,
    alerts: [],
    recent: [],
    isEmpty: false,
    // 聚合漂移哨兵（服务端 getLedger 比对 aggregate.count 和集合条数）。
    // 真了就说明页面上的金额可能不准，提示条要说清是什么、该找谁。
    aggregatesStale: false,
    pageLoading: true,
    showRecordSheet: false,
    blocked: false,
    // 阻断态四件套。kind 决定图标（components/state-blocking），title / action 来自
    // utils/messages.js 的 BLOCKING 表，blockedMessage 仍然是话术层那一句。
    blockedKind: 'generic',
    blockedTitle: '',
    blockedMessage: '',
    blockedAction: '',
    shopName: ''
  },

  async onShow() {
    const status = store.getStatus()
    if (!status.canBookkeep) {
      // 整页阻断位是**技术文案最刺眼的落点**：它不是一闪而过的 toast，而是占满首页。
      // 过一层 utils/messages.js 换成店员话术；原文仍在 error.message 上，
      // console 里也还看得到（forStaff 里 warn 了），排查不受影响。
      // blockingFor 在话术之外还给出「是哪一种阻断」和「给不给按钮」，
      // 正文 body 就是 forStaff().text，没有第二份文案。
      const blocking = messages.blockingFor(status.message)
      this.setData({
        pageLoading: false,
        blocked: true,
        blockedKind: blocking.kind,
        blockedTitle: blocking.title,
        blockedMessage: blocking.body,
        blockedAction: blocking.action,
        shopName: '',
        dateText: util.formatDate(Date.now()),
        productCount: 0,
        totalStock: 0,
        todaySalesAmount: '0.00',
        todayProfit: '0.00',
        todayInAmount: '0.00',
        todayAvailable: true,
        totalReceivable: '0.00',
        hasReceivable: false,
        alertCount: 0,
        alerts: [],
        recent: [],
        aggregatesStale: false,
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
      const blocking = messages.blockingFor(error)
      this.setData({
        pageLoading: false,
        blocked: true,
        blockedKind: blocking.kind,
        blockedTitle: blocking.title,
        blockedMessage: blocking.body || '暂时不能记账',
        blockedAction: blocking.action,
        isEmpty: false
      })
      return
    }
    // 今日三项和最近流水是服务端按 dayStart 现算的读时投影：记过账就过期，
    // 跨了午夜也过期。refreshIfStale 自己判断要不要重取，**失败也不抛** ——
    // 显示旧数据好过白屏，下一次 ensureReady 会诚实报错。
    await store.refreshIfStale()
    this.setData({
      blocked: false,
      blockedKind: 'generic',
      blockedTitle: '',
      blockedMessage: '',
      blockedAction: '',
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
      todayAvailable: dash.todayAvailable,
      todaySalesAmount: dash.todayAvailable ? util.money(dash.todaySalesAmount) : '—',
      todayProfit: dash.todayAvailable ? util.money(dash.todayProfit) : '—',
      todayInAmount: dash.todayAvailable ? util.money(dash.todayInAmount) : '—',
      totalReceivable: util.money(dash.totalReceivable),
      hasReceivable: dash.totalReceivable > 0,
      alertCount: dash.alertCount,
      alerts: dash.alerts.slice(0, 4).map(function (item) {
        return util.withView(item, skus)
      }),
      recent: dash.recent.slice(0, 6).map(util.withRecordView),
      aggregatesStale: store.getAggregatesStale(),
      isEmpty: dash.productCount === 0
    })
  },

  openRecordSheet() {
    this.setData({ showRecordSheet: true })
  },

  closeRecordSheet() {
    this.setData({ showRecordSheet: false })
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/records' })
  },

  goTodaySales() {
    // 流水是 tab 页，switchTab 不支持 query，类型只能走 app 全局暂存交接
    // （同 openGoods 用 setPendingInventoryFilter 带筛选进商品 tab 的既有做法）。
    getApp().setPendingRecordType('out')
    wx.switchTab({ url: '/pages/records/records' })
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
      // 走 onShow 而不是直接 refresh：换账套后若回写异常导致缓存残缺，
      // refresh 会拿老账套的流水算出偏小的今日三项，并在「最近记录」里
      // 列出已经不存在的幽灵流水。onShow 有 ready 门，残缺时会重拉。
      await this.onShow()
      wx.showToast({ title: '已填入示例数据', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
