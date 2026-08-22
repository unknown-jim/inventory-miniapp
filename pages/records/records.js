const store = require('../../utils/store')
const util = require('../../utils/util')

// 一页 20 条 = RECORD_PAGE_DEFAULT。服务端会把 limit 钳到 [1,100]。
const PAGE_SIZE = 20

Page({
  data: {
    type: 'all',
    list: [],
    cursor: '',
    hasMore: false,
    loading: false,
    loaded: false,
    salesAmount: '0.00',
    purchaseAmount: '0.00',
    profit: '0.00',
    receivable: '0.00',
    count: 0
  },

  onLoad(options) {
    const type = options && options.type
    if (type === 'in' || type === 'out' || type === 'pay' || type === 'return' || type === 'convert' || type === 'adjust') {
      this.setData({ type: type })
    }
  },

  async onShow() {
    if (!(await store.ready())) return
    this.refreshTotals()
    // 翻到第 5 页 → 点进详情 → 返回，列表被清回第 1 页很难受，所以默认不重来。
    // 但只要改过账就**必须**重来：删掉的那条不能还留在列表里，改过的那条不能
    // 还显示旧金额。dataVersion() 就是这个判据。
    if (this.data.loaded && this.dataVersion === store.dataVersion()) return
    return this.reload()
  },

  // 汇总四项一律来自服务端权威的 totals（accounts / aggregate 的投影）。
  // 不拿列表现折 —— 列表只有已经翻出来的那几页，折出来必然偏小。
  refreshTotals() {
    const totals = store.getTotals()
    this.setData({
      salesAmount: util.money(totals ? totals.salesAmount : 0),
      purchaseAmount: util.money(totals ? totals.purchaseAmount : 0),
      profit: util.money(totals ? totals.profit : 0),
      receivable: util.money(totals ? totals.receivable : 0),
      count: (totals && totals.count) || 0
    })
  },

  reload() {
    this.dataVersion = store.dataVersion()
    // 换筛选 / 重来时换一个 token：在飞的旧响应回来时 token 已经对不上，
    // 整份丢弃。没有这道保护，切类型切得快一点就会把上一个筛选的流水拼进来。
    this.reqToken = (this.reqToken || 0) + 1
    this.loadingLock = false
    this.setData({ list: [], cursor: '', hasMore: false, loaded: false })
    return this.loadPage(true)
  },

  async loadPage(isFirst) {
    // 实例级的锁，**不能用 data.loading**：setData 是异步的，onReachBottom
    // 连发两次时第二次读到的还是旧值，同一页会被请求两遍、列表里出现重复。
    if (this.loadingLock) return
    if (!isFirst && (!this.data.loaded || !this.data.hasMore)) return
    this.loadingLock = true
    const token = this.reqToken
    this.setData({ loading: true })
    try {
      const res = await store.listRecords({
        type: this.data.type === 'all' ? '' : this.data.type,
        cursor: isFirst ? '' : this.data.cursor,
        limit: PAGE_SIZE
      })
      if (token !== this.reqToken) return
      this.setData({
        list: this.data.list.concat(res.records.map(util.withRecordView)),
        // 本页为空时服务端回 ''，直接赋值会把游标冲回开头、从第一页重来。
        // 总数正好是 PAGE_SIZE 整数倍时最后一页必然是空页，必然踩到。
        cursor: res.cursor || this.data.cursor,
        hasMore: res.hasMore,
        loaded: true
      })
    } catch (error) {
      if (token === this.reqToken) util.showError(error)
    } finally {
      // 只有还在飞的那一次才有资格解锁：旧响应回来时新的一轮已经自己重置过锁了
      if (token === this.reqToken) {
        this.loadingLock = false
        this.setData({ loading: false })
      }
    }
  },

  // 这两个都把 promise 返回出去：小程序不看返回值，但 tests/store.test.js
  // 要靠它 await 到这一轮请求结束（触底连发、在飞响应丢弃两组用例）
  onReachBottom() {
    return this.loadPage(false)
  },

  setType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
    return this.reload()
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  }
})
