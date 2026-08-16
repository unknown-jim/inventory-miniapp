const store = require('../../utils/store')
const util = require('../../utils/util')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
  data: {
    openid: '',
    shops: [],
    currentShopId: '',
    shopName: '',
    newShopName: '',
    canMigrate: false,
    blockedMessage: '',
    configured: true
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
  }
})
