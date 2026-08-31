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
    pageLoading: true
  },

  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
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

  goDetail(e) {
    wx.navigateTo({ url: '/pages/product-detail/product-detail?id=' + e.currentTarget.dataset.id })
  }
})
