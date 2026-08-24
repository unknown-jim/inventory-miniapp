// 店员话术层：把服务端和底层抛出的**技术准确**的错误消息，翻成店员能照着做的话。
//
// **它不吞任何东西。** 原始 message 一个字都没改：服务端照旧抛它、云函数日志里
// 照旧是它、回包 result.error 里照旧是它、这里还会 console.warn 一次。这一层只换
// 「最后显示给店员的那一句」。翻译不出来时**原样显示原文** —— 宁可让店员看见
// 一句技术话，也不要给他一句编造的、和真实原因无关的话。
//
// 为什么不改服务端原文：那批技术话术散在 5 个文件里、被 5 个测试文件约 27 处断言
// 钉着；其中 ledger-migrate.js 的 28 条**本来就不该改**（受众是平台运营方，那些代号
// 对他们是准确的诊断信息）。改显示层能在不动任何一条原文的前提下换掉店员看到的话，
// 技术细节全程保留。
//
// **这套匹配天生是脆的**：拿正则扫中文原文，服务端改一个字规则就静默失配。
// 脆性由 tests/messages.test.js 钉住 —— 每条规则都声明它的来源文件和原文片段，
// 测试逐条去那个文件里找，找不到就红。**钉不住的**：微信 SDK 自己的英文 errMsg
//（不在本仓源码里），以及原文没变但语义变了的情况。别把这层当成全覆盖。
//
// 话术只有一条标准：说清「发生了什么、我该做什么、要等多久」，不暴露内部机制。
// **不许编造时长** —— 说不出准确的等待时间就别说，给出「找谁」比给一个假的分钟数诚实。
// **也不许给店员做不到的事**（ledger-records.js 的 SALE_RETURNS_MAX 注释①：
// 「错误文案不许写成『请先删掉一些退货单』——那是店主做不到的事」）。

// 规则形状：{ source, literal, match, title, text, modal }。按表自上而下取**第一条命中**。
// source / literal 是给 tests/messages.test.js 的锚：测试逐条去 source 文件里找 literal，
// 服务端原文改了字而规则没跟上时当场红。match 只需匹配自己的 literal（测试也钉了
// 这一条），运行时拿它扫真实错误消息。
// modal: true 的话术走 wx.showModal（title + content，不截断）；否则走 wx.showToast。
// **长句必须 modal**：showToast 的 title 在真机上约两行封顶，超出会被腰斩成半句话，
// 而话术恰恰比技术原文长。
const RULES = [
  {
    source: 'cloudfunctions/ledger/ledger-core.js',
    literal: '请更新小程序到最新版本',
    match: /请更新小程序到最新版本/,
    title: '小程序需要更新',
    text: '小程序需要更新到新版本才能继续用。请先退出小程序，等几秒再重新打开；如果还是这样，把微信也退出重开一次。仍然不行请联系店主，先不要反复重试。',
    modal: true
  },
  {
    source: 'cloudfunctions/ledger/ledger-core.js',
    literal: '本店账本还没完成流水升级，暂时不能记账',
    match: /本店账本还没完成流水升级，暂时不能记账/,
    title: '账目正在整理',
    text: '本店的账目正在后台整理，整理期间不能记账。查账、查库存、翻流水都不受影响。请稍后再试；如果一直是这样，请联系店主。',
    modal: true
  },
  {
    // source 指 ledger-core.js 而不是 index.js：这两句的**常量本体**在
    // ledger-core.js（TX_TOO_BIG_MESSAGE / TX_CONFLICT_MESSAGE），index.js 里
    // 只有注释散文提到它们 —— 锚在 index.js 上，改常量时 tripwire 一声不响。
    source: 'cloudfunctions/ledger/ledger-core.js',
    literal: '这张单牵连的记录太多，一次改不完',
    match: /这张单牵连的记录太多，一次改不完/,
    title: '这一单没有记上',
    // **不说「退货单太多」**：判据只有「TransactionNotExist 且没到 30 秒」，
    // 而 index.js 那段实测注释自己写了「条数或体积两者还没分开、那个区间
    // 可能只对大账本成立」。大账本店里一张零退货单的普通销售单也可能落进这里，
    // 那时「退货单太多」就是一句对不上的诊断。只说我们真的知道的那部分。
    text: '这张单要改的记录太多，系统一次改不完，再点几次也不会成功。账没有记错，这一单没记上。请先停下来，把这张单的单号发给店主。',
    modal: true
  },
  {
    source: 'cloudfunctions/ledger/ledger-core.js',
    literal: '库存刚被别人改过，请再提交',
    match: /库存刚被别人改过，请再提交/,
    title: '',
    text: '这一单没记上，账没有记错。请再点一次提交；连着两三次都失败就别再试了，把单号发给店主。',
    modal: false
  },
  {
    source: 'cloudfunctions/ledger/ledger-core.js',
    literal: '店铺账本不存在',
    match: /店铺账本不存在/,
    title: '',
    text: '没找到这家店的账本。请退出小程序重新进入；还是这样请联系店主。',
    modal: false
  },
  {
    source: 'utils/store.js',
    literal: '还没有选择店铺',
    match: /还没有选择店铺/,
    title: '',
    text: '还没有进入任何店铺。可以自己创建一家店；如果你是店员，请在「店铺」页复制你的身份发给老板，老板把你加进店里就能记账。',
    modal: false
  },
  {
    source: 'utils/cloud-config.js',
    literal: '未配置云环境 ID',
    match: /未配置云环境 ID/,
    title: '',
    text: '小程序还没配置好，暂时不能记账。请联系店主处理。',
    modal: false
  },
  {
    source: 'utils/store.js',
    literal: '当前基础库不支持云开发',
    match: /当前基础库不支持云开发/,
    title: '',
    text: '当前微信版本太旧，用不了这个小程序。请在微信里更新到最新版本再进来。',
    modal: false
  },
  {
    source: 'utils/store.js',
    literal: '找不到云环境',
    match: /找不到云环境/,
    title: '',
    // 这条的根因是构建配置对不上，退出重进不会有任何变化——**给不出有用的
    // 第一步就别给**，一句做了也没用的动作只会让店员白折腾一轮。
    text: '连不上店里的账本服务，这不是你操作的问题。请联系店主处理。',
    modal: false
  },
  {
    source: 'utils/store.js',
    literal: '当前小程序还不能用这个云环境',
    match: /当前小程序还不能用这个云环境/,
    title: '',
    text: '账本服务还没开通，暂时不能记账。请联系店主处理。',
    modal: false
  },
  {
    source: 'utils/store.js',
    literal: '账本没取到，请重试',
    match: /账本没取到，请重试/,
    title: '',
    text: '账本没读出来。请退出这个页面重新进来试一次。',
    modal: false
  }
]

// 接受 Error 或字符串。永远返回 { text, title, modal, raw, matched }。
// raw 永远是原文（给日志和排查用，不显示给店员）。
// matched 为假时 text === raw —— 翻译不出来就原样透传，不吞。
// **raw 只认字符串和 error.message，别的一律空串。** 从前这里写的是
// `String(x.message || x || '')`，于是一个没有 message 的对象会被 stringify 成
// `[object Object]` 端到店员眼前 —— 而这正是真实路径：product-edit 的相册授权
// 失败和 slip-actions 的导出失败都直接把 wx 的 `{errMsg:...}` 传进 showError。
// 旧 showError 只读 .message、读不到就显示「操作失败」，这一层必须保持那个行为，
// 否则「改显示层不改行为」就成了空话，而且换来的恰恰是本次要消灭的技术噪音。
// **不去读 errMsg**：那是英文原生串（`saveImageToPhotosAlbum:fail auth deny`），
// 显示它比显示「操作失败」更糟；它仍然进下面那行 console.warn，排查不受影响。
function rawOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value.message === 'string') return value.message
  return ''
}

function forStaff(errorOrMessage) {
  const raw = rawOf(errorOrMessage)
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i]
    if (rule.match.test(raw)) {
      return {
        text: rule.text,
        title: rule.title || '',
        modal: !!rule.modal,
        raw: raw,
        matched: true
      }
    }
  }
  // 未命中也要留一行 warn：让「该加规则却没加」在开发时可见，而不是静默把
  // 技术原文端给店员。这行 warn 就是原文的第三次留存（服务端日志、result.error
  // 之外），不是吞错。
  console.warn('[messages] 没有话术规则:', errorOrMessage)
  return { text: raw, title: '', modal: false, raw: raw, matched: false }
}

module.exports = { RULES: RULES, forStaff: forStaff, rawOf: rawOf }
