const store = require('../../utils/store')
const util = require('../../utils/util')

// 稿 Screen/01b 要补货·完整列表 7:270。从看板「全部 ›」进入（caption 7:269）。
// UX注释/要补货 9:45 逐字：「行可点 → 商品详情（看库存、发起进货），
// 列表不内嵌改数 —— 改数走详情的库存修正或「盘一遍这个商品」，避免双入口打架」。
// 9:47：「批量生成进货单不在本期；此页只负责『看清缺什么』」。
Page({
  data: {
    rows: [],
    summaryText: '',
    pageLoading: true,
    // `store.readyOrFailure()` 失败时屏上留的错误卡（稿 state/error 3:759 /
    // state/error/blocking（不可重试）4:1041）。`loadErrorText` 空串 = 没出错。
    // 可重试与不可重试是**两种**错误态，不可重试的那种不给重试按钮
    //（docs/ui-scale.md「新页面要」第 5 条）。三句话都由 store 给，本页不自己写。
    loadErrorTitle: '',
    loadErrorText: '',
    loadErrorRetry: false
  },

  async onShow() {
    // 上一轮的错误卡先收掉：onShow 每次都跑，留着它会盖在这次取回来的数据上。
    if (this.data.loadErrorText) this.setData({ loadErrorTitle: '', loadErrorText: '', loadErrorRetry: false })
    if (!store.isReady()) this.setData({ pageLoading: true })
    // `ready()` 只说「不行」；`readyOrFailure()` 还说为什么 —— 没选店 / 被移出店铺
    // 那一类点重试不会好，对它们写「检查网络后重试」是错的诊断。文案与看板的阻断卡
    // 同源，取舍写在 utils/store.js 的 readyOrFailure 上。报错仍然只报一次：
    // showError 在 store 里已经报过，这里只负责别把屏留成一张空列表。
    const failure = await store.readyOrFailure()
    if (failure) {
      this.setData({
        pageLoading: false,
        loadErrorTitle: failure.title,
        loadErrorText: failure.text,
        loadErrorRetry: failure.retryable
      })
      return
    }
    // 排序、粒度、行文案与看板那一屏同一个函数，两屏不可能各排一套
    const rows = util.lowStockRows(store.getProducts(), store.getSkus())
    this.setData({
      pageLoading: false,
      rows: rows,
      summaryText: '共 ' + rows.length + ' 种低于预警线 · 点行进商品详情'
    })
  },

  // 错误卡上那枚「重试」。整条 onShow 重走一遍，不另开一条加载路径 —— 另开一条就
  // 会有「重试成功了但页面没按 onShow 的样子装好」这种两说。
  reload() {
    return this.onShow()
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/product-detail/product-detail?id=' + e.currentTarget.dataset.id })
  }
})
