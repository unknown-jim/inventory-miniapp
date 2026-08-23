// 冷启动提示更新（微信官方 wx.getUpdateManager 三段式）。
// 账本升级的冻结窗口长度 = 店主多快把小程序更到新版（docs/cloud-ledger.md 的
// 上线顺序），所以这提醒不是可有可无的装饰：老客户端一直撞「请更新小程序到
// 最新版本」，店就一直停摆。只在冷启动时问一次，不弹在营业操作中间；
// applyUpdate 会杀掉当前会话重新打开，选在 onUpdateReady（包已下好）才弹，
// 用户点「立即重启」时新版本已经在本地了。
// 低版本基础库没有 getUpdateManager（canIUse 兜底），静默跳过 —— 那部分用户
// 还是能收到「请更新小程序到最新版本」的报错文案，死路算留了路标。
function setupUpdateManager() {
  if (!wx.canIUse || !wx.canIUse('getUpdateManager')) return
  const manager = wx.getUpdateManager()
  // 检查结束只回一个 hasUpdate，包还没下好；真正行动的是下面两段。
  manager.onCheckForUpdate(function () {})
  manager.onUpdateReady(function () {
    wx.showModal({
      title: '更新提示',
      content: '新版本已经准备好，是否重启应用？',
      success: function (res) {
        if (res.confirm) {
          manager.applyUpdate()
        }
      }
    })
  })
  manager.onUpdateFailed(function () {
    // 下载失败不重弹（重弹也一样失败），留一条 toast 告诉路在哪
    wx.showToast({ title: '新版本下载失败，请检查网络后重启小程序', icon: 'none' })
  })
}

App({
  globalData: {
    selectedProductId: '',
    selectedCustomerId: '',
    pendingInventoryFilter: '',
    cloudInit: null
  },
  onLaunch() {
    const store = require('./utils/store')
    this.globalData.cloudInit = store.initCloud()
    setupUpdateManager()
  },
  setSelectedProduct(id) {
    this.globalData.selectedProductId = id || ''
  },
  consumeSelectedProduct() {
    const id = this.globalData.selectedProductId
    this.globalData.selectedProductId = ''
    return id
  },
  setSelectedCustomer(id) {
    this.globalData.selectedCustomerId = id || ''
  },
  consumeSelectedCustomer() {
    const id = this.globalData.selectedCustomerId
    this.globalData.selectedCustomerId = ''
    return id
  },
  setPendingInventoryFilter(filter) {
    this.globalData.pendingInventoryFilter = filter || ''
  },
  consumePendingInventoryFilter() {
    const filter = this.globalData.pendingInventoryFilter
    this.globalData.pendingInventoryFilter = ''
    return filter
  }
})
