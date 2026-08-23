const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    phone: '',
    address: '',
    remark: '',
    openingAmount: '',
    saleCount: 0,
    saleAmountText: '0.00',
    receivable: 0,
    receivableText: '0.00',
    hasDebt: false,
    ledger: [],
    ledgerCursor: '',
    ledgerHasMore: false,
    ledgerLoading: false,
    ledgerUnavailable: false,
    showPay: false,
    payAmount: '',
    payRemark: '',
    showOpening: false,
    openingRemark: ''
  },

  onLoad(query) {
    this.selectAfterSave = query.select === '1'
    this.openPayAfter = query.pay === '1'
    if (!query.id) {
      wx.setNavigationBarTitle({ title: '新增客户' })
      return
    }
    this.setData({ id: query.id, isEdit: true })
    wx.setNavigationBarTitle({ title: '编辑客户' })
  },

  async onShow() {
    if (!this.data.id) return
    if (!(await store.ready())) return
    this.fillCustomer(this.data.id)
  },

  fillCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      wx.showToast({ title: '客户不存在', icon: 'none' })
      return
    }
    // 金额三项（累计销售笔数 / 累计销售额 / 当前欠款）一律用服务端权威的
    // customers[].account，不要拿流水缓存现算：submitPay / submitOpening 直接调
    // 这里，**不经过 store.ready() 的门**，缓存这时可能还没补齐（delta 条数对不上
    // 且重拉又失败），现算出来会是一个偏小的欠款。account 的字段口径与
    // summarizeCustomerAccount 逐字段相等，见 tests/ledger-terms.test.js。
    const account = customer.account || inventory.accountOf(null)
    const hasDebt = account.receivable > 0
    // fillCustomer 保持**同步**：submitPay / submitOpening 记完账直接调它，
    // 金额必须当场就对。往来明细是分页取的，异步跟在后面，取不到也只影响明细。
    this.setData({
      id: customer.id,
      isEdit: true,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      remark: customer.remark,
      saleCount: account.count,
      saleAmountText: util.money(account.amount),
      receivable: account.receivable,
      receivableText: util.money(account.receivable),
      hasDebt: hasDebt
    }, () => {
      if (this.openPayAfter) {
        this.openPayAfter = false
        if (hasDebt) this.openPay()
      }
    })
    // 返回 promise 只为可测：金额那几项在上面已经**同步**设好了，
    // tests/store.test.js 正是先断言金额、再 await 这个 promise 断言明细。
    return this.reloadLedger()
  },

  // 往来明细：listRecords({customerId}) 触底加载。
  // 口径和 summarizeCustomerAccount(...).ledger 相等 —— 只有 out / pay /
  // return / opening 四种记录带 customerId，而 isCustomerAccountRecord 恰好
  // 就是这四种，由 tests/ledger-records.test.js 的 T-A4 钉住。
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
      this.setData({
        ledger: this.data.ledger.concat(res.records.map(util.withRecordView)),
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

  // 返回 promise 只为可测（tests/store.test.js），小程序不看返回值
  onReachBottom() {
    return this.loadLedgerPage(false)
  },

  retryLedger() {
    return this.reloadLedger()
  },

  goRecord(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  openPay() {
    if (!(this.data.receivable > 0)) {
      wx.showToast({ title: '当前没有欠款', icon: 'none' })
      return
    }
    this.setData({
      showPay: true,
      showOpening: false,
      payAmount: util.money(this.data.receivable),
      payRemark: ''
    })
  },

  closePay() {
    this.setData({ showPay: false })
  },

  keepPay() {},

  async submitPay() {
    try {
      await store.addPayment({
        customerId: this.data.id,
        amount: this.data.payAmount,
        remark: this.data.payRemark
      })
      this.setData({ showPay: false })
      this.fillCustomer(this.data.id)
      wx.showToast({ title: '已收款', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  },

  openOpening() {
    this.setData({
      showOpening: true,
      showPay: false,
      openingAmount: '',
      openingRemark: ''
    })
  },

  closeOpening() {
    this.setData({ showOpening: false })
  },

  keepOpening() {},

  async submitOpening() {
    try {
      await store.addOpening({
        customerId: this.data.id,
        amount: this.data.openingAmount,
        remark: this.data.openingRemark
      })
      this.setData({ showOpening: false })
      this.fillCustomer(this.data.id)
      wx.showToast({ title: '已记账', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  },

  async save() {
    try {
      const openingText = String(this.data.openingAmount || '').trim()
      let opening = 0
      if (!this.data.isEdit && openingText) {
        opening = inventory.round2(openingText)
        if (opening <= 0) {
          throw new Error('期初欠款必须大于 0')
        }
      }
      const saved = await store.saveCustomer({
        id: this.data.id,
        name: this.data.name,
        phone: this.data.phone,
        address: this.data.address,
        remark: this.data.remark
      })
      if (opening > 0) {
        await store.addOpening({
          customerId: saved.id,
          amount: opening,
          remark: '上线前欠款'
        })
      }
      if (this.selectAfterSave) {
        getApp().setSelectedCustomer(saved.id)
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      util.showError(error)
    }
  },

  callPhone() {
    if (!this.data.phone) {
      wx.showToast({ title: '还没有电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: this.data.phone })
  },

  remove() {
    if (this.data.hasDebt) {
      wx.showModal({
        title: '还有欠款',
        content: '当前欠款 ¥' + this.data.receivableText + '，请先收款后再删除。',
        showCancel: false
      })
      return
    }
    wx.showModal({
      title: '删除客户',
      content: '历史送货记录会保留当时的客户信息，只是以后不能再选这个客户。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteCustomer(this.data.id)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(function () {
            wx.navigateBack()
          }, 400)
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
