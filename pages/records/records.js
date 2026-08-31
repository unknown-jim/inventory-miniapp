const store = require('../../utils/store')
const util = require('../../utils/util')

// 一页 20 条 = RECORD_PAGE_DEFAULT。limit 不传 / 非法（NaN、0、负数）时服务端
// 一律给缺省 20，超过上限才钳到 100（apply.clampPageLimit）。
const PAGE_SIZE = 20

// 认得的筛选类型。'all' 不在表里：它是缺省值，不需要被外部带进来。
// onLoad（扫码 / scene 直达带 query）和 onShow（tab 内跳转带暂存）共用这一张表。
const VALID_TYPES = ['in', 'out', 'pay', 'return', 'convert', 'adjust']

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
    count: 0,
    showRecordSheet: false,
    // 聚合漂移哨兵：汇总四项都来自服务端 totals 投影，漂了这四项都可疑。
    aggregatesStale: false
  },

  onLoad(options) {
    const type = options && options.type
    if (VALID_TYPES.indexOf(type) >= 0) {
      this.setData({ type: type })
    }
  },

  async onShow() {
    // 本页是 tab 页：switchTab 不带 query，onLoad 也只在第一次进来时跑一次。
    // 所以看板「今日销售」带过来的类型走 app 全局暂存，并且**必须在这里取**——
    // 取在 onLoad 里的话，第二次点「今日销售」就不会生效了。
    // typeof 兜一手：tests/store.test.js 的最小 harness 没有 getApp 全局，
    // 真机页面上下文里一定有；兜底取 '' 等于「没有带进来的类型」。
    const pendingType = typeof getApp === 'function' ? getApp().consumePendingRecordType() : ''
    const typeChanged = VALID_TYPES.indexOf(pendingType) >= 0 && pendingType !== this.data.type
    if (typeChanged) this.setData({ type: pendingType })
    if (!(await store.ready())) return
    this.refreshTotals()
    // 翻到第 5 页 → 点进详情 → 返回，列表被清回第 1 页很难受，所以默认不重来。
    // 但只要改过账就**必须**重来：删掉的那条不能还留在列表里，改过的那条不能
    // 还显示旧金额。dataVersion() 就是这个判据。换了筛选类型同样必须重来。
    if (!typeChanged && this.data.loaded && this.dataVersion === store.dataVersion()) return
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
      count: (totals && totals.count) || 0,
      aggregatesStale: store.getAggregatesStale()
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

  // 手动「加载更多」：和 onReachBottom 走**同一个** loadPage(false)，不复制逻辑。
  // 触底加载在真机上到底会不会触发只有代码层面的推断，从没实测过；万一不触发，
  // 这个按钮是列表翻页的唯一出路。锁和 hasMore 判断都在 loadPage 里，连点安全。
  onLoadMore() {
    return this.loadPage(false)
  },

  setType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
    return this.reload()
  },

  openRecordSheet() {
    this.setData({ showRecordSheet: true })
  },

  closeRecordSheet() {
    this.setData({ showRecordSheet: false })
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  }
})
