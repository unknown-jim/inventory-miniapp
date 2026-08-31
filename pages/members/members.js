const store = require('../../utils/store')
const util = require('../../utils/util')

// 与 pages/shop/shop.js 同一个理由：wx.showModal 的 confirmColor 只吃字面量。
// 稿 red/600 3:37 = #DB2626（= app.wxss 的 --color-red-600）。
const DANGER_RED = '#DB2626'

Page({
  data: {
    openid: '',
    members: [],
    isOwner: false,
    newOpenid: '',
    newDisplayName: '',
    shopName: '',
    pageLoading: true
  },

  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    try {
      const openid = await store.whoami()
      const res = await store.listMembers()
      const isOwner = res.role === 'owner'
      this.setData({
        pageLoading: false,
        openid: openid,
        shopName: store.getShopName(),
        isOwner: isOwner,
        members: (res.members || []).map(function (item) {
          const displayName = String(item.displayName || '').trim()
          const isOwnerRole = item.role === 'owner'
          const isMe = item.openid === openid
          // 稿 15:253 逐字：「称呼可选，留空显示「还没写称呼」，之后随时「改称呼」」。
          // 「还没写称呼」这五个字被 tests/ui-scale.test.js:195 钉着，不许改。
          return Object.assign({}, item, {
            displayName: displayName,
            displayTitle: displayName || '还没写称呼',
            // 稿 tag/role 4:543 的样张就是「店主 · 我」，自称口径同 docs/ui-scale.md
            roleTagText: (isOwnerRole ? '店主' : '店员') + (isMe ? ' · 我' : ''),
            isOwnerRole: isOwnerRole,
            isMe: isMe,
            // 服务端 updateMember 允许「owner 或本人」（ledger-core.js:756-758）。
            // 稿注 4:582 把它写窄成「仅店主」，但同一份稿的 15:253 又不限角色，
            // 两条打架时取与服务端一致的那条（规格 5.7）。
            canEditName: isOwner || isMe,
            editing: false,
            editName: displayName
          })
        })
      })
    } catch (error) {
      this.setData({ pageLoading: false })
      util.showError(error)
    }
  },

  onNewOpenid(e) {
    this.setData({ newOpenid: e.detail.value })
  },

  onNewDisplayName(e) {
    this.setData({ newDisplayName: e.detail.value })
  },

  // 稿 15:251 逐字：「状态机：身份码为空报「请填写店员 openid」；重复添加报
  // 「已经是本店成员」；成功 toast「已添加店员」，列表多一行」。三句都由服务端给
  // （ledger-core.js:721 / :728），客户端不预判、不在页面里另写一份校验 ——
  // 写了就是第二份实现，而且两份迟早会分叉。
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

  // 稿 dialog/移出成员 7:267（本体 dialog/confirm-danger 4:1017）：
  // 标题点名、正文列三条连带影响、末行「移出不影响已经记下的账。」，确认钮写「移出」。
  // 移出是危险三级里最轻的一级（可逆：把身份码再发一次就能加回），所以视觉是红字链、
  // 确认只有一道；但**这一道不能省** —— 服务端只挡「不是店主」和「最后一位店主」，
  // 挡不住点错人，而列表里两行名字可能只差一个字。
  // 第二条影响稿上写的是「历史流水里经手人仍显示「小陈」」，这里改成不带名字的说法：
  // 没写称呼的成员会读成「仍显示「还没写称呼」」，而不带名字的句子在所有情况下都成立。
  removeMember(e) {
    const openid = e.currentTarget.dataset.openid
    const member = this.data.members.find(function (item) {
      return item.openid === openid
    })
    const who = (member && member.displayName) || '这位店员'
    wx.showModal({
      title: '移出成员' + who + '？',
      content: '移出后' + who + '将无法进入这家店的账本。移出后会连带发生：\n'
        + '· ' + who + '的账号不再关联本店\n'
        + '· 历史流水里的经手人仍显示原来的称呼\n'
        + '· 把身份码再发给店主即可加回\n\n'
        + '移出不影响已经记下的账。',
      confirmText: '移出',
      confirmColor: DANGER_RED,
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
