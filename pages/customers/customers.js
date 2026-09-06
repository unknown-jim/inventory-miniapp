const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 客户列表。设计稿 Screen/09 客户 4:291、UX注释/客户 4:362。
//
// 行内无按钮，整行可点进客户详情（稿 n2 4:365 逐字：「行内无按钮，整行可点进
// 客户详情（右侧 chevron）；收款 / 去销售在详情内」）。所以本页只剩两个跳转：
// 新增（进 09b 表单）与看详情（进 Screen/10）。
//
// 钱一分都不在这里折：欠款与预收余额一律读服务端投影 customers[].account
//（utils/ledger-apply.js 的 withAggregates 挂的那一份）。
Page({
  data: {
    keyword: '',
    list: [],
    sumText: '',
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
    this.refresh()
  },

  // 错误卡上那枚「重试」。整条 onShow 重走一遍，不另开一条加载路径 —— 另开一条就
  // 会有「重试成功了但页面没按 onShow 的样子装好」这种两说。
  reload() {
    return this.onShow()
  },

  refresh() {
    const list = inventory.sortCustomers(
      inventory.filterCustomers(store.getCustomers(), this.data.keyword)
    ).map(function (item) {
      // accountOf(null) 是「空账户」构造器，是 tests/no-client-cloud-db.test.js
      // 明文放行的唯一用法（传别的东西进去就是在投影一份自己攒的累加器）。
      const account = item.account || inventory.accountOf(null)
      const view = util.withCustomerView(item, account)
      const prepay = inventory.round2(inventory.toNumber(account.prepay))
      const meta = [item.phone, item.address].filter(function (one) {
        return !!String(one || '').trim()
      }).join(' · ')
      return Object.assign(view, {
        prepay: prepay,
        prepayText: util.money(prepay),
        // 稿 sub 4:307：「138 0013 6688 · 城东建材街」
        metaText: meta || '未填电话 / 地址',
        // 稿 nodebt 4:357 逐字：「无欠款 · 预收 ¥200.00 可抵」。
        // **有欠款时这一格根本不渲染**（wxml 里走 debt-row 那一支），
        // 预收不与欠款并列 —— 稿注释 10:139 与 pages/sale/sale.js:604 同一条裁定。
        nodebtText: prepay > 0
          ? ('无欠款 · 预收 ¥' + util.money(prepay) + ' 可抵')
          : '无欠款'
      })
    }).sort(function (a, b) {
      // 稿标题 4:363「客户 · 欠款优先的熟人账」：欠得多的排前面。
      // 同欠款保持 sortCustomers 的次序（最近成交优先），所以这里返回 0。
      return inventory.toNumber(b.receivable) - inventory.toNumber(a.receivable)
    })
    const debtSum = list.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.receivable)
    }, 0)
    this.setData({
      pageLoading: false,
      list: list,
      // 稿 sum/客户欠款 13:354：「4 位客户 · 欠款共 ¥2,960.00」。
      // 数的是**当前屏上这一份**（搜过之后就是搜出来的那几位）。
      sumText: list.length + ' 位客户 · 欠款共 ¥' + util.money(debtSum)
    })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit' })
  },

  goDetail(e) {
    wx.navigateTo({
      url: '/pages/customer-detail/customer-detail?id=' + e.currentTarget.dataset.id
    })
  }
})
