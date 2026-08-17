const store = require('../../utils/store')
const util = require('../../utils/util')

Page({
  data: {
    openid: '',
    shops: [],
    currentShopId: '',
    shopName: '',
    newShopName: '',
    canMigrate: false,
    blockedMessage: '',
    configured: true,
    canBookkeep: false,
    isEmpty: true,
    canRestore: false,
    showLedgerReset: false
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
    this.setData({
      currentShopId: status.shopId,
      shopName: status.shopName,
      configured: status.configured,
      blockedMessage: status.configured ? '' : status.message,
      canMigrate: !!store.getPendingMigrate()
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
    if (!status.configured && status.mode !== 'memory') return
    try {
      const openid = await store.whoami()
      const shops = await store.listShops()
      this.setData({
        openid: openid,
        shops: shops.map(function (item) {
          return Object.assign({}, item, { current: item.id === status.shopId })
        })
      })
    } catch (error) {
      util.showError(error)
    }
  },

  onShopName(e) {
    this.setData({ newShopName: e.detail.value })
  },

  async createShop() {
    try {
      await store.createShop(this.data.newShopName)
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
      wx.showToast({ title: '还没有 openid', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.openid,
      success: function () {
        wx.showToast({ title: '已复制 openid', icon: 'success' })
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
    wx.showModal({
      title: '恢复清空前数据',
      content: '将恢复到最近一次清空前的账本。清空之后新记的账会丢掉。更早的清空记录仍保存在云端。',
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
