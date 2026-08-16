const store = require('../../utils/store')
const util = require('../../utils/util')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
  data: {
    openid: '',
    members: [],
    isOwner: false,
    newOpenid: '',
    shopName: ''
  },

  async onShow() {
    if (!(await store.ready())) return
    try {
      const openid = await store.whoami()
      const res = await store.listMembers()
      this.setData({
        openid: openid,
        shopName: store.getShopName(),
        isOwner: res.role === 'owner',
        members: (res.members || []).map(function (item) {
          return Object.assign({}, item, {
            roleText: item.role === 'owner' ? '店主' : '店员',
            isMe: item.openid === openid
          })
        })
      })
    } catch (error) {
      util.showError(error)
    }
  },

  onNewOpenid(e) {
    this.setData({ newOpenid: e.detail.value })
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

  async addMember() {
    try {
      await store.addMember(this.data.newOpenid)
      this.setData({ newOpenid: '' })
      wx.showToast({ title: '已加入白名单', icon: 'success' })
      this.onShow()
    } catch (error) {
      util.showError(error)
    }
  },

  removeMember(e) {
    const openid = e.currentTarget.dataset.openid
    wx.showModal({
      title: '移出本店',
      content: '移出后对方不能再记账。可再加回来。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.removeMember(openid)
          wx.showToast({ title: '已移出', icon: 'success' })
          this.onShow()
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
