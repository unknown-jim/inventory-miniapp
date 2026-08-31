const store = require('../../utils/store')
const util = require('../../utils/util')
const messages = require('../../utils/messages')

// wx.showModal 的 confirmColor 只吃颜色字面量，取不到 app.wxss 里的
// var(--color-red-600) / var(--color-text-primary)，所以在这里各写一份同值常量。
// DANGER_RED  = 稿 red/600 3:37 = #DB2626（= app.wxss 的 --color-red-600）。
//   main 上原来写的是 #DC2626，与稿差一个色阶，本批顺手对齐。
// NEUTRAL_BLACK = 稿 neutral/900 3:23 = #171717（= app.wxss 的 --color-fill-action）。
//   「恢复清空前数据」按稿 4:576 是中性档不是红档，确认色跟着走中性黑；
//   main 上它是 #0F766E，那是 A1 之前的品牌青绿遗留。
const DANGER_RED = '#DB2626'
const NEUTRAL_BLACK = '#171717'

Page({
  data: {
    openid: '',
    shops: [],
    pageLoading: true,
    shopsLoadError: false,
    currentShopId: '',
    shopName: '',
    currentRoleText: '',
    // 稿注 4:583 与 13:601 都写着「危险操作 owner-gated」。服务端对 clearAll /
    // restoreCleared 只有 requireMember（cloudfunctions/ledger/ledger-core.js:1087-1089），
    // 没有 owner 闸，所以清空 / 恢复这道闸只有客户端这一份 —— 因此默认 false，
    // 只有 listShops 明确回 role === 'owner' 才翻真（fail-safe 方向）。
    isOwner: false,
    newShopName: '',
    canMigrate: false,
    // 阻断态三件套。kind / title 来自 utils/messages.js 的 BLOCKING 表，
    // body 仍然是话术层那一句（blockingFor 的 body 逐字等于 forStaff().text）。
    // 刻意没有 blockedAction：兜底档的按钮文案是「去店铺页」，而本屏就是那个
    // 目的地，按钮点了原地不动；本页是 navigateTo 进来的二级页，返回箭头就是出口。
    blockedKind: 'generic',
    blockedTitle: '',
    blockedMessage: '',
    configured: true,
    canBookkeep: false,
    isEmpty: false,
    canRestore: false,
    showLedgerReset: false,
    canDeleteShop: false,
    hasCurrentShop: false,
    showCreate: false,
    showJoin: false,
    // 稿 Screen/14c 加入别人的店 15:177 的 card/怎么进店 15:188 三步，
    // 文案逐字取自 15:192 / 15:197 / 15:202。
    // 【为什么没有状态列】稿方在交付当日的复审里把它删了
    // （shop-onboarding-design-2026-08-31.md 第 5 节第 5 条，删的是 15:193 / 15:198 / 15:203）：
    // 三步对应的都是屏外动作（复制 → 微信发送 → 店主添加），加入者这一侧唯一可观测的
    // 迁移点是「已成为成员」，而那一刻整个流程已经结束 —— 状态列在任何实现里都只能
    // 永远挂「待做」，比没有状态更误导。**不要加 done 字段，不要给这三行加 bindtap。**
    // （区别于看板空店引导 4:821 的三步：那三步有可推导的数据面 —— 有店 / 有商品 / 有流水。）
    joinSteps: [
      { n: 1, name: '复制身份码，微信发给店主' },
      { n: 2, name: '店主在成员页粘贴添加' },
      { n: 3, name: '「我加入的店」出现这家店，点它进入记账' }
    ]
  },

  // 这一支先于 listShops 跑，拿不到角色，所以只算「有没有东西可清 / 可恢复」。
  // owner 闸写在 wxml 的条件里（isOwner && showLedgerReset）——危险区整张卡只在
  // pageLoading === false 之后才渲染，那时 isOwner 已经和 pageLoading 同一次 setData 落定。
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
      // 和看板页同一个阻断位：走 utils/messages.js，不然看板页说人话、
      // 店铺页说 openid 白名单，两套说法。B1（commit 0c6e0e1）把看板那一半换成了
      // 共用卡 components/state-blocking 并把本页点名交给 B11，这里接上。
      // blockingFor 的 body 逐字等于原来的 forStaff(x).text，屏上文案零变化；
      // 多出来的是「哪一种阻断」和卡片标题（兜底档标题就是原先写死的「还不能记账」）。
      const blocking = messages.blockingFor(status.message)
      this.setData({
        pageLoading: false,
        configured: false,
        blockedKind: blocking.kind,
        blockedTitle: blocking.title,
        blockedMessage: blocking.body,
        currentShopId: status.shopId,
        shopName: status.shopName,
        canMigrate: !!store.getPendingMigrate(),
        shopsLoadError: false,
        hasCurrentShop: false,
        isOwner: false,
        canDeleteShop: false
      })
      this.refreshLedgerReset(false)
      return
    }
    this.setData({
      pageLoading: true,
      configured: true,
      blockedKind: 'generic',
      blockedTitle: '',
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
      const isOwner = !!(current && current.role === 'owner')
      this.setData({
        pageLoading: false,
        shopsLoadError: false,
        shops: shops.map(function (item) {
          return Object.assign({}, item, { current: item.id === status.shopId })
        }),
        isOwner: isOwner,
        canDeleteShop: isOwner,
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
      const isOwner = !!(current && current.role === 'owner')
      this.setData({
        pageLoading: false,
        shopsLoadError: true,
        shops: shops,
        hasCurrentShop: !!status.shopId,
        shopName: (current && current.name) || status.shopName,
        isOwner: isOwner,
        canDeleteShop: isOwner,
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

  // 稿把「再建一家店」4:563 与「加入别人的店」4:568 画成两张独立屏
  // （Screen/14b 15:123 / Screen/14c 15:177）。
  // shop-onboarding-design-2026-08-31.md 第 6 节第 2 条逐字授权
  // 「实现可做 navigateTo 也可维持折叠」，两处折叠互相独立，谁都能单独换掉。
  //
  // 【B13 的裁定：不拆，维持折叠】这条 B11 留下的 OPEN-Q-5 在 B13 结掉了，理由存档在此，
  // 免得下一个人再推一遍：
  //   1. 稿方明写两种实现都行，且注释 15:143 / 15:282 自己把 14b / 14c 的落点
  //      钉回「店铺页这张表单」「店铺页「加入别人的店」」，不是钉在两张新页面上；
  //   2. 拆了要动 tests/ui.test.js 的 runShopAndMembers（.js-shop-create-toggle →
  //      showCreate → .js-shop-name → .js-shop-create 四个东西都挂在同一个页面对象上）
  //      外加 waitForPage 计数钉子 28→29，而 UI 冒烟是这一轮改版的关键路径；
  //   3. 两屏都没有独立的数据加载、状态机和返回语义 —— 一个是「提示 + 输入框 + 按钮」，
  //      另一个是「三句说明」。AGENTS.md 有一条「不要为了用时注入去硬拆页面」；
  //   4. 无店分支（wxml 里 !shops.length && !hasCurrentShop 那一支）的建店表单是常驻展开的，
  //      拆页面之后那里要么多跳一次、要么留第二份表单实现。
  // 真要拆的时候接口仍然在原处：换掉这两个方法 + wxml 里对应的两块折叠体。
  toggleCreate() {
    this.setData({ showCreate: !this.data.showCreate })
  },

  toggleJoin() {
    this.setData({ showJoin: !this.data.showJoin })
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

  // 删除店铺是全站最不可逆的动作：shops / members / ledgers / ledger_clears 全删，
  // 该店的流水也在提交之后按 shopId 清掉（cloudfunctions/ledger/ledger-core.js:790-880），
  // 「恢复清空前数据」救不回来。所以闸门是两道，不是一道：
  //   第一道 讲清后果（稿 dialog/confirm-typed 4:1030 的 title 4:1031 + body 4:1032）
  //   第二道 要店主把店名一字不差地打出来（稿 label 4:1033「输入店名确认」
  //          + input 占位 4:1035 = $13:51「请输入店铺名称」）
  // **不要把两层合成一层**：wx.showModal 开了 editable 之后只剩一个文本槽，
  // 而 content 在 editable 模式下的语义（提示正文还是输入框初值）本仓没有实测过，
  // 不能在一个不可逆动作上赌没验过的 API 语义。第二层的 content 传空串，
  // 不论哪种语义输入框都是空的、提示都在 title 上。
  // **也不要把第二道去掉**：服务端那道 owner-gated（ledger-core.js:799-801）
  // 只挡「不是店主」，挡不住「店主点错了」。
  deleteShop() {
    const name = this.data.shopName || '未命名店铺'
    wx.showModal({
      title: '删除店铺「' + name + '」？',
      content: '本店的商品、库存、客户、流水、成员和清空记录都会一起删掉。'
        + '「恢复清空前数据」也找不回，本程序里再也找不回来。',
      confirmText: '继续',
      confirmColor: DANGER_RED,
      success: (res) => {
        if (!res.confirm) return
        this.confirmDeleteShop(name)
      }
    })
  },

  // 第二道闸。稿上打对之前确认钮是 danger 禁用档（4:1036 的 13:46，red/100 底 + red/600 字）；
  // wx.showModal 的按钮不能禁用，所以改成「打错了给一句 toast、不重开弹窗」——
  // 闸门强度不变（打不对就是删不掉），只是反馈从「钮灰着」变成「点完告诉你」。
  // 不自动重开：一个不可逆动作不该把人困在弹窗循环里。
  // 标题里再写一遍店名，是因为两层弹窗是先后出现的，第二层弹出时第一层已经消失、
  // 页面也被遮住，店主看不到要打什么。
  confirmDeleteShop(name) {
    wx.showModal({
      title: '输入「' + name + '」确认删除',
      content: '',
      editable: true,
      placeholderText: '请输入店铺名称',
      confirmText: '删除店铺',
      confirmColor: DANGER_RED,
      success: async (res) => {
        if (!res.confirm) return
        if (String(res.content || '').trim() !== name) {
          wx.showToast({ title: '店名不对，没有删除', icon: 'none' })
          return
        }
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

  // 清空是危险三级的中间档（稿 4:574 白底红描边）：它比删店铺轻，因为最近一次
  // 可以用「恢复清空前数据」免费找回；比移出成员重，因为它动的是整本账。
  // 弹窗正文一个字不改 —— 它已经把「能免费找回一次」这个关键事实说清了。
  clearData() {
    wx.showModal({
      title: '清空本店数据',
      content: '商品、客户、种类模板和流水都会从当前店删掉。最近一次可以用「恢复清空前数据」免费找回；更早的清空记录会留在云端。',
      confirmText: '清空',
      confirmColor: DANGER_RED,
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

  // 弹窗要说清恢复的是**哪一份**：哪天存的、多少条流水。光警告「清空之后新记
  // 的账会丢掉」，店主还是不知道按下去会回到什么状态。recordCount 缺失（升级前
  // 存的老快照，还没被 mode:'snapshots' 转换过）退化成只带日期。
  // 恢复不是破坏动作，是唯一一条把清空撤回来的路，所以按稿 4:576 走中性档，
  // 确认色是 neutral/900 不是红 —— 把撤销染成红色会让人在真正需要撤销时犹豫。
  restoreCleared() {
    const latest = store.getLatestClear()
    let which = '最近一次清空前的账本'
    if (latest && latest.savedAt) {
      which = util.formatDate(latest.savedAt) + ' 存的那份账本'
        + (latest.recordCount != null ? '（' + latest.recordCount + ' 条流水）' : '')
    }
    wx.showModal({
      title: '恢复清空前数据',
      content: '将恢复到 ' + which + '。清空之后新记的账会全部丢掉。更早的清空记录仍保存在云端。',
      confirmText: '恢复',
      confirmColor: NEUTRAL_BLACK,
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
