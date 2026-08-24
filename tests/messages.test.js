// 店员话术层（utils/messages.js）和事务失败分流（ledger-core.js 的
// classifyTransactionError）的测试。
//
// 第 1 组是这套规则最重要的一条：匹配拿正则扫中文原文，服务端改一个字就静默失配，
// 所以每条规则声明它的来源文件（source）和原文片段（literal），这里逐条去那个
// 文件里找 —— 找不到就红。这条测试钉不住的（微信 SDK 自己的 errMsg、原文没变
// 但语义变了）见 utils/messages.js 头部注释的老实交代。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const messages = require('../utils/messages')
const core = require('../cloudfunctions/ledger/ledger-core')

const root = path.join(__dirname, '..')
const RULES = messages.RULES
const forStaff = messages.forStaff

// ---------------------------------------------------------------------------
// 1) 规则不失配：每条 literal 必须还能在它声明的 source 文件里找到
// ---------------------------------------------------------------------------
RULES.forEach(function (rule) {
  const src = fs.readFileSync(path.join(root, rule.source), 'utf8')
  assert.ok(
    src.indexOf(rule.literal) >= 0,
    '规则失配：「' + rule.literal + '」在 ' + rule.source
    + ' 里找不到了。服务端改了原文就把规则的 literal / match 一起同步改，'
    + '不要删规则 —— 删了店员就会看见原文。'
  )
})

// ---------------------------------------------------------------------------
// 2) 规则自洽：每条 match 必须匹配自己的 literal
// ---------------------------------------------------------------------------
RULES.forEach(function (rule) {
  assert.ok(
    rule.match.test(rule.literal),
    '规则不自洽：match 匹配不了自己的 literal（「' + rule.literal + '」）'
  )
})

// ---------------------------------------------------------------------------
// 3) 不互相遮蔽：对每条 literal 调 forStaff，命中的必须是它自己
//    （按话术文本判同一性 —— 11 条话术互不相同）
// ---------------------------------------------------------------------------
RULES.forEach(function (rule) {
  const got = forStaff(rule.literal)
  assert.strictEqual(got.matched, true, 'literal 必须命中规则：「' + rule.literal + '」')
  assert.strictEqual(
    got.text, rule.text,
    'literal 被别的规则遮蔽了：「' + rule.literal + '」拿到的话术是「' + got.text + '」'
  )
})

// ---------------------------------------------------------------------------
// 4) 不吞：不认识的错误原样透传（matched === false 且 text === raw）。
//    forStaff 对未命中会 console.warn（开发时让「该加规则却没加」可见），
//    收下来别淹输出，顺手断言它真的打了。
// ---------------------------------------------------------------------------
const warns = []
const origWarn = console.warn
console.warn = function () {
  warns.push(Array.prototype.slice.call(arguments).join(' '))
}
try {
  const stranger = forStaff('随便一个没见过的错误 xyz')
  assert.strictEqual(stranger.matched, false, '没见过的错误不该命中任何规则')
  assert.strictEqual(stranger.text, '随便一个没见过的错误 xyz', '翻译不出来就原样透传')
  assert.strictEqual(stranger.raw, '随便一个没见过的错误 xyz')
  assert.strictEqual(stranger.modal, false)

  const strangerErr = forStaff(new Error('库存不足'))
  assert.strictEqual(strangerErr.matched, false)
  assert.strictEqual(strangerErr.text, '库存不足', 'Error 入参也一样：不吞原文')
} finally {
  console.warn = origWarn
}
assert.ok(
  warns.some(function (line) { return line.indexOf('没有话术规则') >= 0 }),
  '未命中要 console.warn 一份原文'
)

// ---------------------------------------------------------------------------
// 5) raw 永远在；Error 和字符串两种入参给同一个结果
// ---------------------------------------------------------------------------
const asError = forStaff(new Error('还没有选择店铺。请先建店，或等老板把你的 openid 加进白名单。'))
const asString = forStaff('还没有选择店铺。请先建店，或等老板把你的 openid 加进白名单。')
assert.strictEqual(
  asError.raw, '还没有选择店铺。请先建店，或等老板把你的 openid 加进白名单。',
  'raw 必须是原始 message，不是话术'
)
assert.strictEqual(asError.matched, true)
assert.strictEqual(asError.text, asString.text, 'Error 和字符串两种入参结果一致')
assert.strictEqual(asError.title, asString.title)
assert.strictEqual(asError.modal, asString.modal)
assert.notStrictEqual(asError.text, asError.raw, '命中时 text 是话术，不是原文')

// ---------------------------------------------------------------------------
// 6) 长句走 modal：这三条话术远超 toast 两行，必须 wx.showModal 不截断
// ---------------------------------------------------------------------------
;['请更新小程序到最新版本',
  '本店账本还没完成流水升级，暂时不能记账',
  '这张单牵连的记录太多，一次改不完'].forEach(function (literal) {
  const rule = RULES.find(function (item) { return item.literal === literal })
  assert.ok(rule, '规则表里少了这一条：' + literal)
  assert.strictEqual(
    rule.modal, true,
    '长话术必须 modal（showToast 在真机上会被腰斩成半句话）：' + literal
  )
})

// ---------------------------------------------------------------------------
// 7) 事务分流（ledger-core.js 的纯函数，index.js 顶部有 wx-server-sdk 所以放那边）
// ---------------------------------------------------------------------------
assert.strictEqual(core.classifyTransactionError('TransactionNotExist', 12000), 'too-big',
  '实测那类失败 11–16 秒就炸，远没到 30 秒，判确定性失败')
assert.strictEqual(core.classifyTransactionError('TransactionNotExist', 31000), 'conflict',
  '耗时的够 30 秒了：可能是一次真超时，退回可重试')
assert.strictEqual(core.classifyTransactionError('TransactionNotExist', undefined), 'conflict',
  '少了耗时这个判据就不判 too-big，退回今天的行为')
assert.strictEqual(core.classifyTransactionError('write conflict', 12000), 'conflict')
assert.strictEqual(core.classifyTransactionError('DATABASE_TRANSACTION_CONFLICT', 12000), 'conflict')
assert.strictEqual(core.classifyTransactionError('库存不足', 12000), '',
  '不是事务类失败，调用方原样抛原错误')
assert.strictEqual(core.classifyTransactionError('transaction does not exist', 12000), 'too-big',
  '顺序回归：TransactionNotExist 带着单词 transaction，先跑通用冲突正则会误判成 conflict')
assert.strictEqual(core.classifyTransactionError('TransactionNotExist', 24999), 'too-big',
  '阈值边界：25 秒之内都算「明显没到」')
assert.strictEqual(core.classifyTransactionError('TransactionNotExist', 25000), 'conflict',
  '阈值边界：恰好 25 秒不判 too-big —— 只在明显没到时才判确定性失败')
assert.strictEqual(core.TX_TIMEOUT_FLOOR_MS, 25000)
assert.strictEqual(core.TX_TOO_BIG_MESSAGE, '这张单牵连的记录太多，一次改不完')
assert.strictEqual(core.TX_CONFLICT_MESSAGE, '库存刚被别人改过，请再提交')

// ---------------------------------------------------------------------------
// 8) raw 的提取式：**对象不许被 stringify**。
//
//    从前是 String(x.message || x || '')，于是一个没有 message 的对象会变成
//    「[object Object]」端给店员。真实路径：pages/product-edit 的相册授权失败和
//    utils/slip-actions 的导出失败都直接把 wx 的 {errMsg:...} 传进 showError，
//    而旧 showError 只读 .message、读不到就显示「操作失败」。
//    这一层必须保持那个行为，否则「改显示层不改行为」就是空话。
// ---------------------------------------------------------------------------
;[
  { errMsg: 'saveImageToPhotosAlbum:fail auth deny' },
  {},
  { message: 123 },
  null,
  undefined
].forEach(function (input) {
  const staff = messages.forStaff(input)
  assert.strictEqual(staff.raw, '', 'raw 不许把对象 stringify：' + JSON.stringify(input))
  assert.strictEqual(staff.text, '', 'text 跟着为空，交给 showError 的「操作失败」兜底')
  assert.strictEqual(staff.matched, false)
  assert.ok(staff.raw.indexOf('[object') < 0)
})
assert.strictEqual(messages.forStaff('一句字符串').raw, '一句字符串', '字符串入参照旧')
assert.strictEqual(messages.forStaff(new Error('一个 Error')).raw, '一个 Error')

// ---------------------------------------------------------------------------
// 9) showError 的 modal 弹不出来时必须退回 toast。
//
//     微信在屏上已经有一个 modal 时会对第二个回 fail，而最容易撞上的正是
//     app.js 的更新提示 —— 它出现在「新包已下好、当前仍跑老代码」的窗口里，
//     也就是服务端抛「请更新小程序到最新版本」（规则 1，modal:true）的同一时刻。
//     不兜底的话，这条规则恰好在它唯一该出现的场景里被静默吞掉，
//     而改动前那里是 toast、和 modal 能共存、一定看得见。
// ---------------------------------------------------------------------------
;(function () {
  const g = global
  const hadWx = Object.prototype.hasOwnProperty.call(g, 'wx')
  const prevWx = g.wx
  const toasts = []
  const modals = []
  g.wx = {
    showToast: function (o) { toasts.push(o) },
    showModal: function (o) { modals.push(o); if (o && o.fail) o.fail({ errMsg: 'showModal:fail' }) }
  }
  try {
    delete require.cache[require.resolve('../utils/util')]
    const util = require('../utils/util')
    util.showError(new Error('请更新小程序到最新版本'))
    assert.strictEqual(modals.length, 1, '先试 modal')
    assert.strictEqual(toasts.length, 1, 'modal 被微信挡掉时必须退回 toast，不许什么都不显示')
    assert.ok(toasts[0].title.indexOf('退出小程序') >= 0, 'toast 里是同一句话术')
    // 没有规则命中的错误保持今天的行为：toast + 原文
    toasts.length = 0
    modals.length = 0
    util.showError(new Error('一句没人认识的错误'))
    assert.strictEqual(modals.length, 0, '未命中不走 modal')
    assert.strictEqual(toasts[0].title, '一句没人认识的错误', '未命中原样透传，不吞')
    // 对象错误：不许出现 [object Object]
    toasts.length = 0
    util.showError({ errMsg: 'chooseImage:fail auth deny' })
    assert.strictEqual(toasts[0].title, '操作失败', '取不到 message 时回到今天的「操作失败」')
  } finally {
    delete require.cache[require.resolve('../utils/util')]
    if (hadWx) g.wx = prevWx
    else delete g.wx
  }
})()

console.log('messages tests passed')
