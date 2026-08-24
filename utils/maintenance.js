// 维护状态的接收端 + 弹窗去重。
//
// 状态**只随云函数回包到达**（utils/store.js 的 callCloud 在成功和失败两条路上
// 都调 note()），外加 App.onShow 里 store.checkMaintenance() 打的那一次 whoami。
// 用户只要还在操作——翻页、开单、查账——下一次请求就把维护状态带回来，
// 立刻弹窗，零额外往返。
//
// **诚实边界**：一个用户盯着静态页面完全不动、一个请求都不发，是收不到弹窗的。
// 覆盖不是 100%，别让下一个人以为是。这不构成风险——他在不发请求的情况下也
// 写不进任何东西，写的门在服务端 ledger-core.js 的 dispatch 里。
// **不要因为这条边界就去加轮询**：轮询买到的只是「弹窗更及时一点」，
// 代价是全天候的空转请求，而漏弹的那部分本来就写不进东西。

let current = null      // 最近一次已知的维护状态；null = 没在维护
let shownKey = ''       // 已经弹过的那一版（on + message），用来去重
let showing = false     // 弹窗在屏上，别叠第二个

function keyOf(state) {
  return state ? '1|' + String(state.message || '') : ''
}

// 云函数回包里的 maintenance 字段。**没有这个字段就是没在维护** ——
// 服务端只在维护开着时才加它（维护关着时回包和今天一模一样），
// 老云函数没有这个字段，同样落在「没在维护」这一侧，这是有意的 fail-open。
function note(state) {
  const on = !!(state && state.on === true)
  if (!on) {
    current = null
    shownKey = ''   // 清掉记忆：下一次真的开了要重新弹
    return false
  }
  current = { on: true, message: String(state.message || '') || '系统正在维护，暂时不能记账，请稍后再试。' }
  show()
  return true
}

function show() {
  if (!current) return
  const key = keyOf(current)
  if (showing || key === shownKey) return
  showing = true
  shownKey = key
  wx.showModal({
    title: '后台维护中',
    content: current.message,
    showCancel: false,
    confirmText: '知道了',
    // 没弹出来就不算弹过。微信在屏上已经有一个 modal 时（比如 app.js 的
    // onUpdateReady 那个更新提示）会对第二个 showModal 回 fail —— 若不在这里
    // 把 shownKey 清掉，这一版文案会被记成「弹过了」，此后同一版再也不弹。
    fail: function () { shownKey = '' },
    complete: function () { showing = false }
  })
}

function isOn() { return !!current }
function currentState() { return current }
// 只给测试用：清掉进程内的记忆
function reset() { current = null; shownKey = ''; showing = false }

module.exports = {
  note: note,
  isOn: isOn,
  currentState: currentState,
  reset: reset
}
