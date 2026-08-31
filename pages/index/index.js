const store = require('../../utils/store')
const util = require('../../utils/util')
const messages = require('../../utils/messages')

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 稿 hero-head 的 date 槽 4:115：「今天 8月25日 周二」。
// 不动 util.formatDate（'YYYY-MM-DD'，另有 6 处消费方），这一句只有看板用。
function todayLabel(ts) {
  const d = new Date(ts)
  return '今天 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEKDAYS[d.getDay()]
}

// 稿 stat/block 3:569 的 delta 槽：「毛利率 28.6%」。
// 分母是今日应收（= todaySalesAmount），与 hero 那行「今日应收」是同一个数，
// 不另算一份（utils/inventory.js:3157 的同一条理由：开两份就多一处要对账的地方）。
// 样张自证：1180 / 4120 = 28.64% -> 28.6%。应收为 0 时不写百分号。
function rateText(profit, sales) {
  const base = Number(sales) || 0
  if (!base) return '—'
  return (Math.round((Number(profit) / base) * 1000) / 10) + '%'
}

// 稿 card/流水行组 3:742 的行：左 tag、中「客户名 / 时间 · 商品 ×件数」、右带号金额。
// 正负号只给稿上有样张的两种：销售 3:575 是 +¥352.00、退货 3:574 是 −¥96.00。
// 进货 / 收款 / 期初 / 改规格 / 库存调整稿上没有样张，一律不加号，见 OQ-5。
// 那个减号是 U+2212 MINUS SIGN，与稿上一致，不是 ASCII 连字符。
function recentView(record) {
  const item = util.withRecordView(record)
  const qty = (item.isOut || item.isReturn || item.isIn) && item.qtyText ? ' ×' + item.qtyText : ''
  const detail = item.productName + qty
  const sign = item.isOut ? '+' : (item.isReturn ? '−' : '')
  return Object.assign({}, item, {
    rowTitle: item.customerText || detail,
    rowSub: item.customerText ? (item.timeText + ' · ' + detail) : item.timeText,
    amountSigned: sign + '¥' + item.amountText
  })
}

// 稿 card/空店引导 4:821 的三步。文案逐字取自 4:859 / 4:864 / 4:869。
function guideSteps(hasShop, hasProduct, hasRecord) {
  return [
    { n: 1, name: '创建或选择店铺', done: !!hasShop },
    { n: 2, name: '从模板建第一个商品或填充示例数据', done: !!hasProduct },
    { n: 3, name: '记第一笔销售', done: !!hasRecord }
  ]
}

Page({
  data: {
    dateText: '',
    shopName: '',
    // 今日各项算不出来时显示「—」而不是 0：0 是会被当真的错数。
    todayAvailable: true,
    // 下面三个是 util.money() 的原始输出（或「—」），tests/store.test.js 逐字钉着，
    // 不要改名、不要在这里加 ¥。屏上显示的是 receivedText / profitText / inText。
    todaySalesAmount: '0.00',
    todayProfit: '0.00',
    todayInAmount: '0.00',
    todayReceivedAmount: '0.00',
    todayUnreceivedAmount: '0.00',
    receivedText: '—',
    receivedClass: 'amount-hero',
    todaySubText: '',
    profitText: '—',
    profitClass: 'amount-stat',
    profitRateText: '',
    inText: '—',
    inClass: 'amount-stat',
    inCountText: '',
    hasReceivable: false,
    debtBannerText: '',
    lowStockCount: 0,
    lowStockTop: [],
    recent: [],
    isEmpty: false,
    guideSteps: guideSteps(true, false, false),
    // 聚合漂移哨兵（服务端 getLedger 比对 aggregate.count 和集合条数）。
    // 真了就说明页面上的金额可能不准，提示条要说清是什么、该找谁。
    aggregatesStale: false,
    pageLoading: true,
    showRecordSheet: false,
    blocked: false,
    // 阻断态四件套（B1）。kind 决定图标（components/state-blocking），
    // title / action 来自 utils/messages.js 的 BLOCKING 表，
    // blockedMessage 仍然是话术层那一句。
    blockedKind: 'generic',
    blockedTitle: '',
    blockedMessage: '',
    blockedAction: ''
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
        dateText: todayLabel(Date.now()),
        todayAvailable: true,
        todaySalesAmount: '0.00',
        todayProfit: '0.00',
        todayInAmount: '0.00',
        todayReceivedAmount: '0.00',
        todayUnreceivedAmount: '0.00',
        receivedText: '—',
        receivedClass: 'amount-hero',
        todaySubText: '',
        profitText: '—',
        profitClass: 'amount-stat',
        profitRateText: '',
        inText: '—',
        inClass: 'amount-stat',
        inCountText: '',
        hasReceivable: false,
        debtBannerText: '',
        lowStockCount: 0,
        lowStockTop: [],
        recent: [],
        aggregatesStale: false,
        isEmpty: false,
        // 稿 Screen/01c 无店 15:260：三步全「待做」
        guideSteps: guideSteps(false, false, false)
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
        isEmpty: false,
        guideSteps: guideSteps(false, false, false)
      })
      return
    }
    // 今日各项和最近流水是服务端按 dayStart 现算的读时投影：记过账就过期，
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
    const rows = util.lowStockRows(store.getProducts(), store.getSkus())
    // 人数与 pages/customers 判「谁有欠款」用的是同一份 account 投影，两屏不会各说各话。
    // 金额仍取 totals.receivable —— 全店欠款唯一的权威来源（utils/store.js:853-858）。
    const debtors = store.getCustomers().filter(function (item) {
      return item.account && Number(item.account.receivable) > 0
    }).length
    const available = dash.todayAvailable
    const sales = available ? util.money(dash.todaySalesAmount) : '—'
    const profit = available ? util.money(dash.todayProfit) : '—'
    const inAmount = available ? util.money(dash.todayInAmount) : '—'
    const received = available ? util.money(dash.todayReceivedAmount) : '—'
    const unreceived = available ? util.money(dash.todayUnreceivedAmount) : '—'
    const receivedText = available ? '¥' + received : '—'
    const profitText = available ? '¥' + profit : '—'
    const inText = available ? '¥' + inAmount : '—'
    const receivableText = util.money(dash.totalReceivable)
    const isEmpty = dash.productCount === 0
    this.setData({
      pageLoading: false,
      dateText: todayLabel(Date.now()),
      todayAvailable: available,
      todaySalesAmount: sales,
      todayProfit: profit,
      todayInAmount: inAmount,
      todayReceivedAmount: received,
      todayUnreceivedAmount: unreceived,
      receivedText: receivedText,
      // docs/ui-scale.md 的降档表：按屏上可见字符数挑 class，不缩放
      receivedClass: util.heroAmountClass(receivedText),
      todaySubText: available
        ? ('今日应收 ¥' + sales + ' · 其中未收 ¥' + unreceived)
        : '',
      profitText: profitText,
      profitClass: util.statAmountClass(profitText),
      profitRateText: available ? ('毛利率 ' + rateText(dash.todayProfit, dash.todaySalesAmount)) : '',
      inText: inText,
      inClass: util.statAmountClass(inText),
      inCountText: available ? (dash.todayInCount + ' 笔进货单') : '',
      hasReceivable: dash.totalReceivable > 0,
      // 人数投影为 0 而金额 > 0 时不写「0 位客户」，退化成不带人数的一句
      debtBannerText: debtors > 0
        ? (debtors + ' 位客户欠款共 ¥' + receivableText)
        : ('客户欠款共 ¥' + receivableText),
      lowStockCount: rows.length,
      // 稿 UX注释 4:826：「首屏只露第 1 条」，其余同序在 Screen/01b
      lowStockTop: rows.slice(0, 1),
      recent: dash.recent.slice(0, 6).map(recentView),
      aggregatesStale: store.getAggregatesStale(),
      isEmpty: isEmpty,
      guideSteps: guideSteps(true, !isEmpty, dash.recent.length > 0)
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

  goCustomers() {
    wx.switchTab({ url: '/pages/customers/customers' })
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
  },

  goAddProduct() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  // 稿 caption 7:269：看板要补货「全部 ›」进入完整列表（Screen/01b）
  goLowStock() {
    wx.navigateTo({ url: '/pages/low-stock/low-stock' })
  },

  // 稿 UX注释 7:261：要补货行可点 → **商品详情**（看库存、发起进货），不是编辑页。
  // 列表直进编辑容易误改，这是 docs/ui-scale.md 密度规则最后一条的同一条裁定。
  onRestockTap(e) {
    wx.navigateTo({ url: '/pages/product-detail/product-detail?id=' + e.currentTarget.dataset.id })
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  },

  async seedDemo() {
    try {
      await store.loadSeed()
      // 走 onShow 而不是直接 refresh：换账套后若回写异常导致缓存残缺，
      // refresh 会拿老账套的流水算出偏小的今日各项，并在「最新流水」里
      // 列出已经不存在的幽灵流水。onShow 有 ready 门，残缺时会重拉。
      await this.onShow()
      wx.showToast({ title: '已填入示例数据', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
