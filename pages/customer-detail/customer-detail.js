const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 客户详情。设计稿 Screen/10 客户详情 4:297（content 4:300）、UX注释/客户详情 4:406。
// 首卡三个变体：默认 card/当前欠款 4:368、预收变体 7:250、欠款预收并存 9:4。
// 弹层两枚：sheet/收款·默认态 13:450（空值禁用态 9:26）、
//          sheet/记期初欠款·默认态 13:451（空值禁用态 9:27）。
//
// 钱一分都不在本页折：
//   · 欠款与预收余额读服务端投影 customers[].account（withAggregates 挂的那一份）
//   · 往来记录每行「对欠款的影响」读 utils/util.js 的 withRecordView 给的 debtDeltaText
//   · 收款超收的拆分只是**预览**，真值是 store.addPayment 回包上的 prepayAdded
Page({
  data: {
    id: '',
    name: '',
    phone: '',
    address: '',
    phoneText: '未填',
    addressText: '未填',

    // 首卡（稿 4:368 / 7:250 / 9:4 三档 + 稿未画的第四档）
    receivable: 0,
    receivableText: '0.00',
    prepay: 0,
    prepayText: '0.00',
    hasDebt: false,
    hasPrepay: false,
    // 初值就是 D 档（稿 28:1）：还没拿到数之前，屏上不该先写「当前欠款」——
    // reloadCustomer 之前这一瞬间是看得见的。
    cardLabel: '已结清',
    cardAmountText: '0.00',
    cardAmountClass: '',
    cardHint: '',
    saleCount: 0,
    saleAmountText: '0.00',

    // 往来记录（分页）
    ledger: [],
    ledgerCursor: '',
    ledgerHasMore: false,
    ledgerLoading: false,
    ledgerUnavailable: false,

    // 收款 sheet
    showPay: false,
    payAmount: '',
    payRemark: '',
    payFullText: '0.00',
    payHalfText: '0.00',
    payFullOn: false,
    payHalfOn: false,
    payFeedback: '',
    payFeedbackOk: false,
    payConfirmText: '确认收款',
    payCanSubmit: false,
    paySubmitting: false,

    // 记期初 sheet
    showOpening: false,
    openingAmount: '',
    openingRemark: '',
    openingCanSubmit: false,
    openingSubmitting: false,

    pageLoading: true,
    notFound: false
  },

  onLoad(query) {
    // 两个入口带 &pay=1（记一笔面板的收款 picker、流水详情的「去收款」桥）。
    // G1 之后**无条件**开层：零欠款客户也能收款，全额转预收（稿注释 7:254）。
    this.openPayAfter = query.pay === '1'
    this.setData({ id: String(query.id || '') })
  },

  async onShow() {
    if (!this.data.id) {
      this.setData({ pageLoading: false, notFound: true })
      return
    }
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    this.fillCustomer(this.data.id)
  },

  // 金额几项（累计销售笔数 / 累计销售额 / 当前欠款 / 预收余额）一律用服务端权威的
  // customers[].account，不拿流水缓存现算：submitPay / submitOpening 直接调这里、
  // **不经过 store.ready() 的门**，缓存这时可能还没补齐（delta 条数对不上且重拉又
  // 失败），现算出来会是一个偏小的欠款。account 的字段口径见 tests/ledger-terms.test.js。
  //
  // 本函数保持**同步**：submitPay / submitOpening 记完账直接调它，金额必须当场就对。
  // 往来明细是分页取的，异步跟在后面，取不到也只影响明细。
  // 返回 promise 只为可测：tests/store.test.js 正是先断言金额、再 await 它断言明细。
  fillCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      this.setData({ pageLoading: false, notFound: true })
      return Promise.resolve()
    }
    // accountOf(null) 是「空账户」构造器，是 tests/no-client-cloud-db.test.js
    // 明文放行的唯一用法。
    const account = customer.account || inventory.accountOf(null)
    const receivable = inventory.round2(inventory.toNumber(account.receivable))
    const prepay = inventory.round2(inventory.toNumber(account.prepay))
    const card = this.cardOf(receivable, prepay)
    this.setData({
      pageLoading: false,
      notFound: false,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      phoneText: customer.phone || '未填',
      addressText: customer.address || '未填',
      receivable: receivable,
      receivableText: util.money(receivable),
      prepay: prepay,
      prepayText: util.money(prepay),
      hasDebt: receivable > 0,
      hasPrepay: prepay > 0,
      cardLabel: card.label,
      cardAmountText: card.amountText,
      cardAmountClass: card.amountClass,
      cardHint: card.hint,
      saleCount: account.count,
      saleAmountText: util.money(account.amount)
    }, () => {
      if (this.openPayAfter) {
        this.openPayAfter = false
        this.openPay()
      }
    })
    return this.reloadLedger()
  },

  // 首卡四档。A / B / C 三档的 label 与 hint 逐字取自稿：
  //   A 默认      4:369「当前欠款」，无 hint
  //   B 预收变体  7:251「预收款（收超欠款部分）」+ 7:253 hint，金额绿（green/700）
  //   C 并存变体  9:5「当前欠款（另有预收待抵扣）」+ 9:7 hint，金额仍是**欠款**、红
  // D 档（既没欠款也没预收）2026-09-05 补进稿：28:1「card/当前欠款·已结清」——
  //   label 28:2「已结清」、金额 ¥0.00 用 text/strong（3:23）不是欠款红、不出 hint、
  //   按钮行与「记期初欠款」链接照留。
  //   在此之前它回落成 A 的形状，两清的客户屏上写着「当前欠款 ¥0.00」——一眼扫过去
  //   像是还欠着钱。这不是记账错误，是读数错误，但同样会让人误判。
  // **B 与 C 的差别是本批最容易做错的一处：C 的 hero 数字是欠款不是预收。**
  cardOf(receivable, prepay) {
    if (receivable > 0 && prepay > 0) {
      return {
        label: '当前欠款（另有预收待抵扣）',
        amountText: util.money(receivable),
        amountClass: 'debt',
        hint: '预收 ¥' + util.money(prepay)
          + ' 不自动冲欠款。下次开单会带出抵扣行，可改；要收款先冲这 ¥' + util.money(receivable)
      }
    }
    if (receivable > 0) {
      return {
        label: '当前欠款',
        amountText: util.money(receivable),
        amountClass: 'debt',
        hint: ''
      }
    }
    if (prepay > 0) {
      return {
        label: '预收款（收超欠款部分）',
        amountText: util.money(prepay),
        amountClass: 'prepay',
        hint: '欠款已清 · 下次开单可抵 · 点收款可继续记预收'
      }
    }
    return { label: '已结清', amountText: util.money(0), amountClass: '', hint: '' }
  },

  // ---------------------------------------------------------------------------
  // 往来明细：listRecords({customerId}) 触底加载。
  // 口径和 summarize 那一套相等 —— 只有 out / pay / return / opening 四种记录带
  // customerId，由 tests/ledger-records.test.js 的 T-A4 钉住。
  // 这一整段与 main 上 pages/customer-edit 的那一份逐字相同，只是搬了个家。
  // ---------------------------------------------------------------------------
  reloadLedger() {
    this.ledgerToken = (this.ledgerToken || 0) + 1
    this.ledgerLock = false
    this.setData({
      ledger: [],
      ledgerCursor: '',
      ledgerHasMore: false,
      ledgerUnavailable: false
    })
    return this.loadLedgerPage(true)
  },

  async loadLedgerPage(isFirst) {
    if (!this.data.id) return
    // 实例级的锁，不能用 data.ledgerLoading：setData 异步，触底连发会重复请求
    if (this.ledgerLock) return
    if (!isFirst && !this.data.ledgerHasMore) return
    this.ledgerLock = true
    const token = this.ledgerToken
    this.setData({ ledgerLoading: true })
    try {
      const res = await store.listRecords({
        customerId: this.data.id,
        cursor: isFirst ? '' : this.data.ledgerCursor,
        limit: 20
      })
      if (token !== this.ledgerToken) return
      const rows = res.records.map(this.ledgerRow)
      this.setData({
        ledger: this.data.ledger.concat(rows),
        // 空页时服务端回 ''，直接赋值会把游标冲回开头
        ledgerCursor: res.cursor || this.data.ledgerCursor,
        ledgerHasMore: res.hasMore,
        ledgerUnavailable: false
      })
    } catch (error) {
      // 明细拿不到就明确标成不可用 —— 直接给空数组会被界面说成
      // 「还没有往来记录」，那是在撒谎。上面的金额来自服务端权威值，仍然是准的。
      if (token === this.ledgerToken) this.setData({ ledgerUnavailable: true })
    } finally {
      if (token === this.ledgerToken) {
        this.ledgerLock = false
        this.setData({ ledgerLoading: false })
      }
    }
  },

  // 一行往来记录的展示串。稿 row/销售 4:383 是「tag ／ 标题 ／ 副行 ／ 右侧金额」，
  // 右侧金额由 withRecordView 的 debtDeltaText 给（那是账法层的定义，不在这里算）。
  // 副行只做**串接**，不做任何金额判断：应收 / 实收 / 抵预收 / 转预收 四个数
  // 全是单头上现成的字段。
  ledgerRow(record) {
    const view = util.withRecordView(record)
    let sub = view.timeText
    if (view.isOut) {
      sub = view.timeText + ' · 应收 ¥' + view.amountText + ' · 实收 ¥' + view.paidText
      const used = inventory.round2(inventory.toNumber(view.prepayUsed))
      if (used > 0) sub += ' · 抵预收 ¥' + util.money(used)
    } else if (view.isReturn) {
      sub = view.timeText + ' · 货值 ¥' + view.amountText
    } else if (view.isPay) {
      const added = inventory.round2(inventory.toNumber(view.prepayAdded))
      if (added > 0) sub = view.timeText + ' · 其中 ¥' + util.money(added) + ' 记预收'
    } else if (view.isOpening) {
      sub = view.timeText + ' · 上线前旧账'
    }
    return Object.assign(view, { subText: sub })
  },

  // 返回 promise 只为可测（tests/store.test.js），小程序不看返回值
  onReachBottom() {
    return this.loadLedgerPage(false)
  },

  // 手动「加载更多」：和 onReachBottom 走**同一个** loadLedgerPage(false)，不复制逻辑。
  onLoadMoreLedger() {
    return this.loadLedgerPage(false)
  },

  retryLedger() {
    return this.reloadLedger()
  },

  // ---------------------------------------------------------------------------
  // 收款 sheet（稿 13:450 / 空值禁用态 9:26）
  // ---------------------------------------------------------------------------

  // G1 之后「收款不能超过当前欠款」那道 throw 在服务端已经删了
  //（docs/accounting-vs-policy.md:57），本页也**不再**按 hasDebt 拦：
  // 零欠款客户的入口仍然叫「收款」，多收的自动记预收 —— 不要造「记预收」这个动词。
  // 金额默认 = 当前欠款（稿 input 的 hint「默认 = 当前欠款」）；零欠款时留空，
  // 走稿 9:26 的空值禁用态。
  openPay() {
    this.applyPay({
      showPay: true,
      showOpening: false,
      payAmount: this.data.receivable > 0 ? util.money(this.data.receivable) : '',
      payRemark: ''
    })
  },

  closePay() {
    this.setData({ showPay: false })
  },

  keepSheet() {},

  onPayAmount(e) {
    this.applyPay({ payAmount: e.detail.value })
  },

  onPayRemark(e) {
    this.setData({ payRemark: e.detail.value })
  },

  fillPayFull() {
    this.applyPay({ payAmount: util.money(this.data.receivable) })
  },

  fillPayHalf() {
    this.applyPay({ payAmount: util.money(inventory.round2(this.data.receivable / 2)) })
  },

  // 收款 sheet 的联动。**这一段是本批唯一会算错钱的地方，逐字照抄，不要改形状。**
  //
  // 超收拆分只是**预览**：真值是 store.addPayment 回来的那条收款单单头上的
  // prepayAdded。服务端 utils/inventory.js 的 applyPayment 按**记账当时**的欠款拆，
  // 本页用的是上一次 ready() 拿到的投影，两台设备同时记账时会差一笔。
  //
  // 公式与服务端 applyPayment:1763-1764 那两行逐字同构：
  //     const receivable = receivableOf(ctx, records, customerId)
  //     const prepayAdded = amount > receivable ? round2(amount - Math.max(0, receivable)) : 0
  //
  // 基准是**当前欠款**，不是「当前欠款 − 预收余额」：预收不自动冲欠款
  //（稿 9:7、docs/accounting-vs-policy.md:19「软件里没有『把预收划去冲欠款』这个操作」）。
  applyPay(patch) {
    const next = Object.assign({}, this.data, patch || {})
    const receivable = inventory.round2(inventory.toNumber(next.receivable))
    const raw = String(next.payAmount == null ? '' : next.payAmount).trim()
    const amount = raw === '' ? 0 : inventory.round2(raw)
    const over = amount > receivable ? inventory.round2(amount - Math.max(0, receivable)) : 0
    const offset = inventory.round2(amount - over)
    const left = inventory.round2(Math.max(0, receivable - offset))
    const full = inventory.round2(receivable)
    const half = inventory.round2(receivable / 2)
    let feedback = ''
    let feedbackOk = false
    if (amount > 0) {
      if (over > 0) {
        // 稿收款侧没画超收样张；措辞跟销售侧 toast 10:204 的「多收 ¥X 记预收」同词
        feedback = '收下后' + next.name + '还欠 ¥0.00（已清） · 多收 ¥'
          + util.money(over) + ' 记预收'
        feedbackOk = true
      } else if (left <= 0) {
        // 稿 feedback 13:450;4:1085 逐字
        feedback = '收下后' + next.name + '还欠 ¥0.00（已清）'
        feedbackOk = true
      } else {
        feedback = '收下后' + next.name + '还欠 ¥' + util.money(left)
      }
    }
    this.setData(Object.assign({}, patch || {}, {
      payFullText: util.money(full),
      payHalfText: util.money(half),
      payFullOn: amount > 0 && amount === full,
      payHalfOn: amount > 0 && amount === half,
      payFeedback: feedback,
      payFeedbackOk: feedbackOk,
      // 稿：默认态 label 带金额、空值禁用态 label 只写「确认收款」
      payConfirmText: amount > 0 ? ('确认收款 · ¥' + util.money(amount)) : '确认收款',
      payCanSubmit: amount > 0
    }))
  },

  async submitPay() {
    if (!this.data.payCanSubmit || this.data.paySubmitting) return
    this.setData({ paySubmitting: true })
    try {
      // payload 只有这三个键，**多一个字段都不许加**：超收怎么拆是服务端的事
      //（applyPayment 里那两行），客户端算出来的那个数只用来画预览。
      const record = await store.addPayment({
        customerId: this.data.id,
        amount: this.data.payAmount,
        remark: this.data.payRemark
      })
      this.setData({ showPay: false, paySubmitting: false })
      this.fillCustomer(this.data.id)
      // 提示语一律读服务端回传的单头，**不许**用屏上的预览重算：
      // 服务端按记账当时的欠款拆，预览按上一次投影拆，两者可能不同。
      const paid = inventory.round2(inventory.toNumber(record && record.amount))
      const added = inventory.round2(inventory.toNumber(record && record.prepayAdded))
      // 稿 toast/收款完成 7:317：「已收款 ¥1,500.00 · 李老板已清」。
      // 各段只在成立时出现，段间用 ' · ' 连。
      let title = '已收款 ¥' + util.money(paid)
      if (added > 0) title += ' · 多收 ¥' + util.money(added) + ' 记预收'
      else if (!(this.data.receivable > 0)) title += ' · ' + this.data.name + '已清'
      // 长文案用 icon: 'none'：success 图标那一档会把标题腰斩
      wx.showToast({ title: title, icon: 'none' })
    } catch (error) {
      this.setData({ paySubmitting: false })
      util.showError(error)
    }
  },

  // ---------------------------------------------------------------------------
  // 记期初 sheet（稿 13:451 / 空值禁用态 9:27）
  // ---------------------------------------------------------------------------
  openOpening() {
    // 稿上那枚 hint「默认 = 当前欠款」是 visible:false —— 期初**不预填**。
    this.applyOpening({
      showOpening: true,
      showPay: false,
      openingAmount: '',
      openingRemark: ''
    })
  },

  closeOpening() {
    this.setData({ showOpening: false })
  },

  onOpeningAmount(e) {
    this.applyOpening({ openingAmount: e.detail.value })
  },

  onOpeningRemark(e) {
    this.setData({ openingRemark: e.detail.value })
  },

  applyOpening(patch) {
    const next = Object.assign({}, this.data, patch || {})
    const raw = String(next.openingAmount == null ? '' : next.openingAmount).trim()
    const amount = raw === '' ? 0 : inventory.round2(raw)
    this.setData(Object.assign({}, patch || {}, { openingCanSubmit: amount > 0 }))
  },

  async submitOpening() {
    if (!this.data.openingCanSubmit || this.data.openingSubmitting) return
    this.setData({ openingSubmitting: true })
    try {
      const record = await store.addOpening({
        customerId: this.data.id,
        amount: this.data.openingAmount,
        remark: this.data.openingRemark
      })
      this.setData({ showOpening: false, openingSubmitting: false })
      this.fillCustomer(this.data.id)
      const amount = inventory.round2(inventory.toNumber(record && record.amount))
      wx.showToast({ title: '已记期初 ¥' + util.money(amount), icon: 'none' })
    } catch (error) {
      this.setData({ openingSubmitting: false })
      util.showError(error)
    }
  },

  // ---------------------------------------------------------------------------
  // 桥
  // ---------------------------------------------------------------------------
  goRecord(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?id=' + this.data.id })
  },

  // 稿注释 7:39：去销售 = 带这个客户进销售页
  goSale() {
    getApp().setSelectedCustomer(this.data.id)
    wx.navigateTo({ url: '/pages/sale/sale' })
  },

  callPhone() {
    if (!this.data.phone) {
      wx.showToast({ title: '还没有电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: this.data.phone })
  },

  goBack() {
    wx.navigateBack()
  }
})
