const store = require('../../utils/store')
const util = require('../../utils/util')
const messages = require('../../utils/messages')

Page({
  data: {
    openid: '',
    shops: [],
    pageLoading: true,
    shopsLoadError: false,
    currentShopId: '',
    shopName: '',
    currentRoleText: '',
    newShopName: '',
    canMigrate: false,
    blockedMessage: '',
    configured: true,
    canBookkeep: false,
    isEmpty: false,
    canRestore: false,
    showLedgerReset: false,
    canDeleteShop: false,
    hasCurrentShop: false,
    showCreate: false,
    showIdentity: false
  },

  refreshLedgerReset(canBookkeep) {
    const bookkeep = !!canBookkeep
    const isEmpty = bookkeep ? store.getProducts().length === 0 : true
    const canRestore = bookkeep ? store.hasClearedBackup() : false
    this.setData({
      canBookkeep: bookkeep,
      isEmpty: isEmpty,
      canRestore: canRestore,
      showLedgerReset: bookkeep && (!isEmpty || canRestore)
    })
  },

  async onShow() {
    const status = store.getStatus()
    if (!status.configured && status.mode !== 'memory') {
      // 和看板页同一个阻断位（shop.wxml 的 blockedMessage）：走 utils/messages.js
      // 的店员话术层，不然看板页说人话、店铺页说 openid 白名单，两套说法。
      this.setData({
        pageLoading: false,
        configured: false,
        blockedMessage: messages.forStaff(status.message).text,
        currentShopId: status.shopId,
        shopName: status.shopName,
        canMigrate: !!store.getPendingMigrate(),
        shopsLoadError: false,
        hasCurrentShop: false,
        canDeleteShop: false
      })
      this.refreshLedgerReset(false)
      return
    }
    this.setData({
      pageLoading: true,
      configured: true,
      blockedMessage: '',
      currentShopId: status.shopId,
      shopName: status.shopName,
      canMigrate: !!store.getPendingMigrate(),
      shopsLoadError: false
    })
    if (status.canBookkeep) {
      try {
        await store.ensureReady()
        this.refreshLedgerReset(true)
      } catch (error) {
        this.refreshLedgerReset(false)
        util.showError(error)
      }
    } else {
      this.refreshLedgerReset(false)
    }
    try {
      const openid = await store.whoami()
      this.setData({ openid: openid })
    } catch (error) {
      util.showError(error)
    }
    try {
      const shops = await store.listShops()
      const current = shops.find(function (item) {
        return item.id === status.shopId
      })
      this.setData({
        pageLoading: false,
        shopsLoadError: false,
        shops: shops.map(function (item) {
          return Object.assign({}, item, { current: item.id === status.shopId })
        }),
        canDeleteShop: !!(current && current.role === 'owner'),
        hasCurrentShop: !!current,
        shopName: current ? current.name : status.shopName,
        currentRoleText: current
          ? (current.role === 'owner' ? '店主' : '店员')
          : ''
      })
    } catch (error) {
      const shops = (this.data.shops || []).map(function (item) {
        return Object.assign({}, item, { current: item.id === status.shopId })
      })
      const current = shops.find(function (item) {
        return item.id === status.shopId
      })
      this.setData({
        pageLoading: false,
        shopsLoadError: true,
        shops: shops,
        hasCurrentShop: !!status.shopId,
        shopName: (current && current.name) || status.shopName,
        canDeleteShop: !!(current && current.role === 'owner'),
        currentRoleText: current
          ? (current.role === 'owner' ? '店主' : '店员')
          : ''
      })
      util.showError(error)
    }
  },

  onShopName(e) {
    this.setData({ newShopName: e.detail.value })
  },

  toggleCreate() {
    this.setData({ showCreate: !this.data.showCreate })
  },

  toggleIdentity() {
    this.setData({ showIdentity: !this.data.showIdentity })
  },

  retryShops() {
    this.onShow()
  },

  async createShop() {
    try {
      await store.createShop(this.data.newShopName)
      this.setData({ newShopName: '', showCreate: false })
      wx.showToast({ title: '已创建店铺', icon: 'success' })
      this.onShow()
    } catch (error) {
      util.showError(error)
    }
  },

  async selectShop(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    try {
      await store.selectShop(id, name)
      wx.showToast({ title: '已切换店铺', icon: 'success' })
      this.onShow()
    } catch (error) {
      util.showError(error)
    }
  },

  copyOpenid() {
    if (!this.data.openid) {
      wx.showToast({ title: '还没有可复制的身份', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.openid,
      success: function () {
        wx.showToast({ title: '已复制身份', icon: 'success' })
      }
    })
  },

  async migrateLocal() {
    try {
      await store.migrateLocal()
      this.setData({ canMigrate: false })
      wx.showToast({ title: '已上传本机账本', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  },

  goMembers() {
    wx.navigateTo({ url: '/pages/members/members' })
  },

  deleteShop() {
    const name = this.data.shopName || '当前店铺'
    wx.showModal({
      title: '删除店铺',
      content: '将删除「' + name + '」以及本店账本、成员和清空记录。删掉后不能从本程序找回。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteShop()
          wx.showToast({ title: '已删除店铺', icon: 'success' })
          this.onShow()
        } catch (error) {
          util.showError(error)
        }
      }
    })
  },

  clearData() {
    wx.showModal({
      title: '清空全部数据',
      content: '商品、客户、种类模板和流水都会从当前店删掉。最近一次可以用「恢复清空前数据」免费找回；更早的清空记录会留在云端。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.clearAll()
          this.refreshLedgerReset(true)
          wx.showToast({ title: '已清空', icon: 'success' })
        } catch (error) {
          util.showError(error)
        }
      }
    })
  },

  restoreCleared() {
    // 弹窗要说清恢复的是**哪一份**：哪天存的、多少条流水。光警告「清空之后新记
    // 的账会丢掉」，店主还是不知道按下去会回到什么状态。recordCount 缺失（升级前
    // 存的老快照，还没被 mode:'snapshots' 转换过）退化成只带日期。
    const latest = store.getLatestClear()
    let which = '最近一次清空前的账本'
    if (latest && latest.savedAt) {
      which = util.formatDate(latest.savedAt) + ' 存的那份账本'
        + (latest.recordCount != null ? '（' + latest.recordCount + ' 条流水）' : '')
    }
    wx.showModal({
      title: '恢复清空前数据',
      content: '将恢复到 ' + which + '。清空之后新记的账会全部丢掉。更早的清空记录仍保存在云端。',
      confirmColor: '#0F766E',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.restoreCleared()
          this.refreshLedgerReset(true)
          wx.showToast({ title: '已恢复', icon: 'success' })
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
