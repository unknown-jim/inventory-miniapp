// 客户详情首卡四档（pages/customer-detail/customer-detail.js 的 cardOf）。
//
// 这四档此前**一条测试都没有**。它们不是记账逻辑，改错了不会让钱算错，但会让店主
// **读错数**——B 档和 C 档的 hero 数字一个是预收一个是欠款，看混了就会以为客户还欠着
// 或者已经清了。源码注释自己都写着「B 与 C 的差别是本批最容易做错的一处」，却没人守。
//
// 逐字取自稿：A 4:369 / B 7:251 + 7:253 / C 9:5 + 9:7 / D 28:1（2026-09-05 补画）。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(
  path.join(__dirname, '..', 'pages', 'customer-detail', 'customer-detail.js'), 'utf8')

// 从源码里抠出 cardOf 的真身，不复刻一份——复刻的那份改了这里不会知道。
// 用 indexOf 找而不是正则：本文件第一版用 new RegExp 写判据，写文件的工具把反斜杠折掉
// 了一层，括号的转义变成了捕获组、整条匹配不上，报出来却是「missing method cardOf」，
// 看着像源码改名了。**判据自己出错时要能分辨得出来**，所以这里换成不需要转义的写法。
function pageMethod(name) {
  const needle = String.fromCharCode(10) + '  ' + name + '('
  const at = src.indexOf(needle)
  assert.ok(at >= 0, 'missing method ' + name + '——它改名或改了签名，下面测的就不是源码了')
  let i = src.indexOf('{', at)
  assert.ok(i > 0, name + ' 后面找不到函数体的左花括号')
  i += 1
  let depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') depth -= 1
    i += 1
  }
  assert.strictEqual(depth, 0, name + ' 的花括号没配平，抠出来的不是完整函数体')
  return src.slice(at + 1, i)
}

const util = require('../utils/util')

// 把 SyntaxError 翻译成人话。**扫描器不跳字符串和注释**：cardOf 里出现一个游离的
// 左/右花括号（注释里、或将来某个 hint 字符串里）就会静默越界，抠出半截函数体，
// 报出来是 `SyntaxError: Unexpected token`，看着像源码写坏了。下面那条「花括号没配平」
// 只在**不配平一直延续到文件末尾**时才响——复审实测的边界，如实写在这儿。
// pageMethod 留在 try **外面**：它自己那三条断言（找不到方法 / 找不到左括号 /
// 花括号没配平）说的就是源码的事，落进下面的 catch 会被贴上「多半是提取器的问题」，
// 方向正好反了（复审实测：真·改名会被翻译成提取器的锅）。
const cardOfSrc = pageMethod('cardOf')
let cardOf
try {
  cardOf = new Function('util', 'return { ' + cardOfSrc + ' }').call(null, util).cardOf
} catch (e) {
  assert.fail('从源码里抠 cardOf 抠出了一段编译不了的东西：' + e.message
    + String.fromCharCode(10)
    + '——这多半是**提取器**的问题不是源码的问题：它按花括号配对扫，不跳字符串和'
    + '注释，cardOf 里多一个游离的 { 或 } 就会截错位置。先去看那段源码有没有这种'
    + '字符，再怀疑源码本身。')
}
assert.strictEqual(typeof cardOf, 'function', '抠出来的应当是个函数')

// --- A 默认：只有欠款 -------------------------------------------------------
{
  const a = cardOf(1500, 0)
  assert.strictEqual(a.label, '当前欠款', '稿 4:369')
  assert.strictEqual(a.amountText, util.money(1500), 'hero 数字是欠款')
  assert.strictEqual(a.amountClass, 'debt', '欠款是红的')
  assert.strictEqual(a.hint, '', 'A 档稿上没有 hint')
}

// --- B 预收变体：欠款已清、有预收 -------------------------------------------
{
  const b = cardOf(0, 200)
  assert.strictEqual(b.label, '预收款（收超欠款部分）', '稿 7:251')
  assert.strictEqual(b.amountText, util.money(200), 'B 档 hero 数字是**预收**')
  assert.strictEqual(b.amountClass, 'prepay', '预收是绿的，不能跟欠款一个色')
  assert.ok(b.hint.indexOf('欠款已清') === 0, '稿 7:253 的 hint，实为「' + b.hint + '」')
}

// --- C 并存：既欠款又有预收 -------------------------------------------------
// **这一条是本文件最要紧的。** 源码注释写着「B 与 C 的差别是本批最容易做错的一处：
// C 的 hero 数字是欠款不是预收」——把它钉住，别只留一句注释。
{
  const c = cardOf(84, 200)
  assert.strictEqual(c.label, '当前欠款（另有预收待抵扣）', '稿 9:5')
  assert.strictEqual(c.amountText, util.money(84),
    'C 档 hero 数字必须是**欠款 84**，不是预收 200——写成 200 的话，一个还欠着 84 的客户'
      + '屏上会显示一个绿色的 200，店主会以为不用收钱了')
  assert.strictEqual(c.amountClass, 'debt', 'C 档金额仍是欠款、仍是红的')
  assert.ok(c.hint.indexOf('预收 ¥' + util.money(200)) === 0,
    '稿 9:7 的 hint 要把预收数报出来，实为「' + c.hint + '」')
}

// --- D 已结清：两清 ---------------------------------------------------------
// 2026-09-05 补画（稿 28:1）。在此之前代码回落成 A 的形状，两清的客户屏上写着
// 「当前欠款 ¥0.00」——一眼扫过去像是还欠着钱。
{
  const d = cardOf(0, 0)
  assert.strictEqual(d.label, '已结清',
    '稿 28:1 的 label 28:2——退回补画之前的「当前欠款」这里就红。'
      + '（上一版在下面另挂了一条 notStrictEqual 说「回退到它这条要红」，'
      + '实测它永远跑不到：上一行先红。零独占杀伤，已删。）')
  assert.strictEqual(d.amountText, util.money(0), '¥0.00')
  assert.strictEqual(d.amountClass, '',
    '中性色，不是欠款红也不是预收绿——稿 28:3 的 fill 直绑 neutral/900 (3:23)')
  assert.strictEqual(d.hint, '', 'D 档稿上没有 hint')
}

// --- 边界：负数不该掉进 D 档 ------------------------------------------------
// 判据写的是 `> 0`。欠款为负（多收了但没走预收路径）时会落到 D，屏上写「已结清」。
// 这不是本次要改的东西，但**把现状钉住**，免得以后有人改了 cardOf 却没发现这一支。
{
  const neg = cardOf(-50, 0)
  assert.strictEqual(neg.label, '已结清',
    '负欠款目前落 D 档（判据是 > 0）。这是现状不是主张——真要区分得先改稿。'
      + '（不写它「什么时候会发生」：utils/inventory.js 的 assertAccountsValid 直接拒收'
      + ' receivable < 0 的账，所以正常路径上到不了这里。钉着是防判据被改坏。）')
}

// --- data 初值也得是 D 档 ---------------------------------------------------
// 正常路径上看不见这个初值：fillCustomer 把 pageLoading:false 与 cardLabel 写在同一次
// setData 里，两者同时翻，没有中间帧。真正看得见它的是 onShow 里 store.ready() 失败那条
// return——那条路上首卡说什么都是错的（见 customer-detail.js 里同一段说明）。
{
  const m = /cardLabel:\s*'([^']*)'/.exec(src)
  assert.ok(m, 'data 里应当有 cardLabel 初值')
  assert.strictEqual(m[1], '已结清',
    'data 的 cardLabel 初值应当是 D 档的「已结清」，实为「' + m[1] + '」'
      + '——零态该长 cardOf(0, 0) 的样子')
}

// --- 账号 → 屏上文案这一段也要有人守 -----------------------------------------
// 复审实测两条逃逸，上面那些断言一条都拦不住：
//   1. 把 fillCustomer 里的 `this.cardOf(receivable, prepay)` 换成写死的 A 档对象，
//      四档全塌回「当前欠款」红字，完整 npm test **全绿**。上面测的是从源码抠出来的
//      纯函数 cardOf，没有任何一条检查 fillCustomer 还在调它。
//   2. data 初值四格里只有 cardLabel 被钉住。把 cardAmountText/Class/Hint 改成 A 档的值，
//      也是全绿——而注释声称「初值取 D 档、与 cardOf(0, 0) 的返回一致」。
// 两条都用静态判据补上：纯函数对不对是一回事，**它有没有被接上**是另一回事。
;(function assertCardOfIsActuallyWired() {
  assert.ok(src.indexOf('const card = this.cardOf(receivable, prepay)') >= 0,
    'fillCustomer 里应当有 `const card = this.cardOf(receivable, prepay)`——'
      + '换成写死的对象或别的算法，上面那些断言一条都拦不住：它们测的是纯函数，'
      + '不是它有没有被接上')
  const fields = ['card.label', 'card.amountText', 'card.amountClass', 'card.hint']
  fields.forEach(function (f) {
    assert.ok(src.indexOf(f) >= 0,
      '首卡的 ' + f + ' 应当从 cardOf 的返回里取——取不到就意味着这一格是另算的，'
        + 'cardOf 说了不算')
  })
})()

;(function assertDataDefaultsAreZeroState() {
  const zero = cardOf(0, 0)
  const pairs = [
    ['cardLabel', zero.label],
    ['cardAmountText', zero.amountText],
    ['cardAmountClass', zero.amountClass],
    ['cardHint', zero.hint]
  ]
  const q = String.fromCharCode(39)
  pairs.forEach(function (pair) {
    const at = src.indexOf(pair[0] + ': ' + q)
    assert.ok(at >= 0, 'data 里应当有 ' + pair[0] + ' 初值')
    const from = at + (pair[0] + ': ' + q).length
    const got = src.slice(from, src.indexOf(q, from))
    assert.strictEqual(got, pair[1],
      'data 的 ' + pair[0] + ' 初值应当等于 cardOf(0, 0) 给的「' + pair[1] + '」，'
        + '实为「' + got + '」——四格里只钉一格的话，另外三格可以悄悄改成 A 档的值，'
        + '在 store.ready() 失败那条路上会渲染出「已结清 ¥1,500.00」这种自相矛盾的卡')
  })
})()

console.log('customer-card tests passed')
