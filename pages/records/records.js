const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 一页 20 条 = RECORD_PAGE_DEFAULT。limit 不传 / 非法（NaN、0、负数）时服务端
// 一律给缺省 20，超过上限才钳到 100（apply.clampPageLimit）。
const PAGE_SIZE = 20

// 认得的筛选类型。'all' 不在表里：它是缺省值，不需要被外部带进来。
// onLoad（扫码 / scene 直达带 query）和 onShow（tab 内跳转带暂存）共用这一张表。
//
// 'opening'（期初）是按稿 filter-chips 4:144 的第 8 枚 chip 加的。零后端改动：
// 集合侧 cloudfunctions/ledger/ledger-records.js:214-216 走等值分支命中索引 #3
// （bookId + type + sortKey），纯函数侧 utils/ledger-apply.js:256-262 同构。
const VALID_TYPES = ['in', 'out', 'pay', 'return', 'convert', 'adjust', 'opening']

// 稿 filter-chips 4:144 的 8 枚，顺序逐字照稿。
const TYPE_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'in', label: '进货' },
  { key: 'out', label: '销售' },
  { key: 'pay', label: '收款' },
  { key: 'return', label: '退货' },
  { key: 'convert', label: '改规格' },
  { key: 'adjust', label: '调整' },
  { key: 'opening', label: '期初' }
]

// 时间段三档。稿 UX注释 n8 4:839 逐字：「今日 = 演示今天；本月 = 自然月；
// 全部 = 开店至今。静态默认本月。」
const WINDOW_KEYS = ['today', 'month', 'all']
const WINDOW_LABELS = { today: '今日', month: '本月', all: '全部' }
const DEFAULT_WINDOW = 'month'

// 算不出来时显示「—」，不显示 0。0 是会被当真的错数，和「今日三项算不出来」
// 同一条规矩（utils/store.js:941-942）。
const DASH = '—'

// 时间段边界。**由客户端算**：服务端不知道这家店在哪个时区，日 / 月的边界
// 只有客户端定得了（docs/cloud-ledger.md「时间段筛选与期间汇总」）。
// 区间是 [from, to) 闭开、毫秒时间戳。
//
// 'all' 回两个 null = 不设界 —— 但**这一档不会被拿去调 getRecordSummary**
// （无界汇总会被服务端 normalizeWindow(payload, true) 抛错），只喂 listRecords。
function windowRange(key, now) {
  if (key === 'today') {
    const from = inventory.startOfDay(now)
    const next = new Date(from)
    // 用 setDate(+1) 而不是 from + 86400000：跨夏令时的那一天差一小时。
    next.setDate(next.getDate() + 1)
    return { from: from, to: next.getTime() }
  }
  if (key === 'month') {
    const d = new Date(now)
    // new Date(y, m + 1, 1) 在 12 月会自然进位到次年 1 月，不用特判。
    return {
      from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
      to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
    }
  }
  return { from: null, to: null }
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

// 流水列表用相对时间。稿 9:18 演示账对照表逐字：「流水列表用相对时间
// 「今天/昨天」，单据详情与原单用绝对日期」。所以这一句只有本页用，
// util.formatTime / util.formatDateTime 一个字都不动（另有 6 处消费方）。
// 样张：13:504「今天 15:10」、4:171「昨天 16:40」、9:123「08-20 · …」——
// 比昨天更早的只写 MM-DD，不带时分。
function listTimeText(ts, now) {
  const d = new Date(ts)
  const day = inventory.startOfDay(ts)
  const today = inventory.startOfDay(now)
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  if (day === today) return '今天 ' + hm
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === yesterday.getTime()) return '昨天 ' + hm
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// 稿 card/流水列表 4:152 的行：左 tag、中「对手方 / 相对时间 · 明细」、右带号金额，
// 再往下按类型挂一行说明。「列表与右侧样张一律对手方打头」是演示账对照表 9:18 原话。
//
// 带号规则（稿上有样张的四种全部覆盖）：
//   销售 4:158 +¥352.00 ／ 收款 4:172 +¥500.00 ＝ 钱进店，'+'
//   进货 4:165 −¥2,375.00 ／ 退货 13:507 −¥96.00 ＝ 钱出店，'−'
//   期初 / 改规格不带号（期初不是现金流，只是把旧账记进来）；
//   调整**连金额都不显示**（稿 n3 4:192：「调整单只记件数不带金额」）。
// 那个减号是 U+2212 MINUS SIGN，与稿一致，不是 ASCII 连字符。
function rowView(record, now) {
  const item = util.withRecordView(record)
  const amount = inventory.round2(inventory.toNumber(record.amount))
  let sign = ''
  if (item.isOut || item.isPay) sign = '+'
  else if (item.isIn || item.isReturn) sign = '−'

  // 明细：有对手方时标题被客户名占用，明细写商品；没有对手方时标题就是商品，
  // 明细写件数。收款 / 期初没有商品，明细写类型名（稿 4:171「昨天 16:40 · 收款」）。
  let detail = ''
  if (item.isPay || item.isOpening) {
    detail = item.typeText
  } else if (item.customerText) {
    detail = item.productName + (item.isMulti || !item.qtyText ? '' : ' ×' + item.qtyText)
  } else if (item.qtyText) {
    detail = item.qtyText + ' 件'
  }

  // 「现结」后缀：稿 13:291「今天 11:05 · 枕芯 ×1 · 现结」。判据是**开单当时
  // 就收齐了**（credited >= 应收），不是「现在不欠钱」——王姐 014 是退货①冲欠
  // 之后才不欠的，稿 4:157 那一行就没有「现结」。
  if (item.isOut && item.creditedAmount >= amount) {
    detail = detail ? detail + ' · 现结' : '现结'
  }

  // 行内说明。两种，色不同：
  //   销售挂欠  → 「欠 ¥800.00 · 未收清」红（样张 9:124 绑 text/debt）
  //   退货去向  → 「冲欠 ¥84.00 · 退现金 ¥12.00」muted（样张 13:505 绑 $3:79）
  let noteText = ''
  let noteDebt = false
  if (item.isOut) {
    // 当前口径 = 应收 − 已结清 − 已退货值，夹断到 0（稿 UX注释 4:282 原话，
    // 与 docs/accounting-vs-policy.md 的单据欠款口径同源）。
    // 退货①冲欠之后这一行就不再出现 —— 演示账对照表 9:18 明确要求。
    const debt = inventory.round2(amount - item.creditedAmount - item.returnedAmount)
    if (debt > 0) {
      noteText = '欠 ¥' + util.money(debt) + ' · 未收清'
      noteDebt = true
    }
  } else if (item.isReturn) {
    // 退货单头的 paidAmount 就是「退出去的现金」（docs/cloud-ledger.md 的结算口径），
    // 冲欠款那一份 = 退货额 − 现金。两格都由服务端写入时定死，这里只是读出来。
    const cash = item.creditedAmount
    const offset = inventory.round2(amount - cash)
    const parts = []
    if (offset > 0) parts.push('冲欠 ¥' + util.money(offset))
    if (cash > 0) parts.push('退现金 ¥' + util.money(cash))
    noteText = parts.join(' · ')
  }

  return Object.assign({}, item, {
    rowTitle: item.customerText || item.productName,
    rowSub: detail ? listTimeText(record.createdAt, now) + ' · ' + detail
      : listTimeText(record.createdAt, now),
    hasAmount: !item.isAdjust,
    amountSigned: sign + '¥' + item.amountText,
    noteText: noteText,
    noteDebt: noteDebt
  })
}

Page({
  data: {
    type: 'all',
    typeOptions: TYPE_OPTIONS,
    windowKey: DEFAULT_WINDOW,
    windowLabel: WINDOW_LABELS[DEFAULT_WINDOW],
    list: [],
    cursor: '',
    hasMore: false,
    loading: false,
    loaded: false,
    // 摘要三项。算不出来是 '—'，不是 '0.00'。
    purchaseText: DASH,
    salesText: DASH,
    profitText: DASH,
    showRecordSheet: false,
    // 聚合漂移哨兵：摘要三项来自服务端 totals 投影，漂了这三项都可疑。
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
    this.refreshSummary()
    // 翻到第 5 页 → 点进详情 → 返回，列表被清回第 1 页很难受，所以默认不重来。
    // 但只要改过账就**必须**重来：删掉的那条不能还留在列表里，改过的那条不能
    // 还显示旧金额。dataVersion() 就是这个判据。换了筛选类型同样必须重来。
    if (!typeChanged && this.data.loaded && this.dataVersion === store.dataVersion()) return
    return this.reload()
  },

  // 当前时间段的 [from, to)。每次现算，不缓存：跨午夜 / 跨月时缓存会过期。
  currentRange() {
    return windowRange(this.data.windowKey, Date.now())
  },

  // 摘要条。三档取数分两条路，这是 G2 定死的：
  //   今日 / 本月 → getRecordSummary({from, to})，服务端翻窗口现折。
  //   全部       → getTotals()，accounts / aggregate 的**零查询**权威投影。
  //                **不许**给 getRecordSummary 一个无界窗口去重算同一个数：
  //                normalizeWindow(payload, true) 会抛「汇总必须给时间段」。
  //                依据：docs/cloud-ledger.md「『全部』那一档不调这个 action」。
  // 回包 complete 为假时 totals 是 null，三项一律显示 '—'，**不显示 0**。
  async refreshSummary() {
    const stale = store.getAggregatesStale()
    if (this.data.windowKey === 'all') {
      const totals = store.getTotals()
      this.setData({
        purchaseText: totals ? '¥' + util.money(totals.purchaseAmount) : DASH,
        salesText: totals ? '¥' + util.money(totals.salesAmount) : DASH,
        profitText: totals ? '¥' + util.money(totals.profit) : DASH,
        aggregatesStale: stale
      })
      return
    }
    // 摘要请求也要 token：切档切得快时旧回包必须整份丢弃，否则「今日」的数字
    // 会挂在「本月」标签底下 —— 和列表那条 reqToken 是同一个病。
    const token = (this.sumToken || 0) + 1
    this.sumToken = token
    this.setData({ purchaseText: DASH, salesText: DASH, profitText: DASH, aggregatesStale: stale })
    const range = this.currentRange()
    try {
      const res = await store.getRecordSummary({ from: range.from, to: range.to })
      if (token !== this.sumToken) return
      if (!res.complete || !res.totals) return
      this.setData({
        purchaseText: '¥' + util.money(res.totals.purchaseAmount),
        salesText: '¥' + util.money(res.totals.salesAmount),
        profitText: '¥' + util.money(res.totals.profit)
      })
    } catch (error) {
      // 摘要算不出来就停在「—」。**不弹错**：列表还在，这一条是附加信息，
      // 为它打断整屏不划算；显示「—」本身已经说清了「这个数现在没有」。
      if (token === this.sumToken) return
    }
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
    const range = this.currentRange()
    const now = Date.now()
    try {
      const res = await store.listRecords({
        type: this.data.type === 'all' ? '' : this.data.type,
        cursor: isFirst ? '' : this.data.cursor,
        limit: PAGE_SIZE,
        // 时间段和 cursor 都是 sortKey 上的界，服务端会把两个上界合并成
        // min(cursor, to) 发一次查询（cloudfunctions/ledger/ledger-records.js:228-238）。
        // 'all' 档两个都是 null = 不设界，回包与不带时间段时逐条相同。
        from: range.from,
        to: range.to
      })
      if (token !== this.reqToken) return
      this.setData({
        list: this.data.list.concat(res.records.map(function (record) {
          return rowView(record, now)
        })),
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
    const type = e.currentTarget.dataset.type
    if (type === this.data.type) return
    this.setData({ type: type })
    return this.reload()
  },

  // 稿 pill/时间段 4:1007 的「本月 ⌄」。三档互斥、无第四种，所以用微信原生
  // 的 showActionSheet：不新增弹层标记、不与本页那条「chip 单行横滑」的
  // 纵向预算打架，每一项的热区由平台保证。
  // **不要**改成 .seg 分段开关：那会再吃掉一整行高度，而本页的纵向预算正是
  // 「类型 chip 折行会吃掉列表」这条本页专属裁定要省下来的东西。
  openWindowPicker() {
    const self = this
    wx.showActionSheet({
      itemList: WINDOW_KEYS.map(function (key) { return WINDOW_LABELS[key] }),
      success: function (res) {
        self.applyWindow(WINDOW_KEYS[res.tapIndex])
      },
      fail: function () {}
    })
  },

  // 单独抽出来是给 tests/ui.test.js 用的：showActionSheet 是原生弹层，
  // automator 点不到里面的选项，用例走 page.callMethod('applyWindow', 'all')。
  applyWindow(key) {
    if (WINDOW_KEYS.indexOf(key) < 0) return
    if (key === this.data.windowKey) return
    this.setData({ windowKey: key, windowLabel: WINDOW_LABELS[key] })
    this.refreshSummary()
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
