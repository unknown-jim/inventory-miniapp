const store = require('../../utils/store')
const util = require('../../utils/util')

Page({
  data: {
    openid: '',
    members: [],
    isOwner: false,
    newOpenid: '',
    newDisplayName: '',
    shopName: ''
  },

  async onShow() {
    if (!(await store.ready())) return
    try {
      const openid = await store.whoami()
      const res = await store.listMembers()
      const isOwner = res.role === 'owner'
      this.setData({
        openid: openid,
        shopName: store.getShopName(),
        isOwner: isOwner,
        members: (res.members || []).map(function (item) {
          const displayName = String(item.displayName || '').trim()
          return Object.assign({}, item, {
            displayName: displayName,
            displayTitle: displayName || '还没写称呼',
            roleText: item.role === 'owner' ? '店主' : '店员',
            isMe: item.openid === openid,
            canEditName: isOwner || item.openid === openid,
            editing: false,
            editName: displayName
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

  onNewDisplayName(e) {
    this.setData({ newDisplayName: e.detail.value })
  },

  async addMember() {
    try {
      await store.addMember(this.data.newOpenid, '', this.data.newDisplayName)
      this.setData({ newOpenid: '', newDisplayName: '' })
      wx.showToast({ title: '已添加店员', icon: 'success' })
      this.onShow()
    } catch (error) {
      util.showError(error)
    }
  },

  startEditName(e) {
    const openid = e.currentTarget.dataset.openid
    this.setData({
      members: this.data.members.map(function (item) {
        const editing = item.openid === openid
        return Object.assign({}, item, {
          editing: editing,
          editName: editing ? item.displayName : item.editName
        })
      })
    })
  },

  onEditName(e) {
    const openid = e.currentTarget.dataset.openid
    const value = e.detail.value
    this.setData({
      members: this.data.members.map(function (item) {
        if (item.openid !== openid) return item
        return Object.assign({}, item, { editName: value })
      })
    })
  },

  cancelEditName() {
    this.setData({
      members: this.data.members.map(function (item) {
        return Object.assign({}, item, { editing: false, editName: item.displayName })
      })
    })
  },

  async saveDisplayName(e) {
    const openid = e.currentTarget.dataset.openid
    const member = this.data.members.find(function (item) {
      return item.openid === openid
    })
    try {
      await store.updateMember(openid, member ? member.editName : '')
      wx.showToast({ title: '已保存称呼', icon: 'success' })
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
