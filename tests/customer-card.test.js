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
// **在剥过注释的那份上抠**，不是抠出来之后再剥：剥在抠之后的话，在真方法前面塞一段
// 写着完整实现的块注释，pageMethod 会把注释里那份当源码抠走——A/B/C/D 四条、data 初值
// 四条、wiring 一条全部改判在诱饵上（复审实测，整个修复能撤销而全绿）。
// 另加一条自检：同名方法只许出现一次，出现两次说明还有别的东西在冒充它。
function pageMethod(name) {
  const needle = String.fromCharCode(10) + '  ' + name + '('
  const clean = stripJsComments(src)
  let hits = 0
  let scan = clean.indexOf(needle)
  while (scan >= 0) { hits += 1; scan = clean.indexOf(needle, scan + 1) }
  assert.strictEqual(hits, 1,
    '方法 ' + name + ' 在剥过注释的源码里出现了 ' + hits + ' 次，应当只有 1 次'
      + '——多出来的那份多半是在冒充它')
  const at = clean.indexOf(needle)
  assert.ok(at >= 0, 'missing method ' + name + '——它改名或改了签名，下面测的就不是源码了')
  let i = clean.indexOf('{', at)
  assert.ok(i > 0, name + ' 后面找不到函数体的左花括号')
  i += 1
  let depth = 1
  while (i < clean.length && depth > 0) {
    if (clean[i] === '{') depth += 1
    else if (clean[i] === '}') depth -= 1
    i += 1
  }
  assert.strictEqual(depth, 0, name + ' 的花括号没配平，抠出来的不是完整函数体')
  return clean.slice(at + 1, i)
}

const util = require('../utils/util')

// 剥注释再判——注释诱饵是本仓实测过的逃逸：真代码写死、把原来的 token 留在注释里，
// 全文 indexOf 照样命中（复审两次都从这儿绕过去）。
function stripJsComments(text) {
  const bs = String.fromCharCode(92)
  const block = new RegExp(bs + '/' + bs + '*[' + bs + 's' + bs + 'S]*?' + bs + '*' + bs + '/', 'g')
  const line = new RegExp('(^|[^:])' + bs + '/' + bs + '/[^' + bs + 'n]*', 'g')
  return text.replace(block, ' ').replace(line, '$1')
}
function stripWxmlComments(text) {
  const bs = String.fromCharCode(92)
  return text.replace(new RegExp('<!--[' + bs + 's' + bs + 'S]*?-->', 'g'), ' ')
}

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
// 这一节的判据在下面 assertDataDefaultsAreZeroState 里，四格一起核、且在剥过注释的
// 那份上切。上一版这里另有一条只核 cardLabel、取全文第一个匹配、不剥注释的断言——
// **它是第三个逃逸口**（注释诱饵直接放行），已删。

// --- 账号 → 屏上文案这一段也要有人守 -----------------------------------------
// 复审实测两条逃逸，上面那些断言一条都拦不住：
//   1. 把 fillCustomer 里的 `this.cardOf(receivable, prepay)` 换成写死的 A 档对象，
//      四档全塌回「当前欠款」红字，完整 npm test **全绿**。上面测的是从源码抠出来的
//      纯函数 cardOf，没有任何一条检查 fillCustomer 还在调它。
//   2. data 初值四格里只有 cardLabel 被钉住。把 cardAmountText/Class/Hint 改成 A 档的值，
//      也是全绿——而注释声称「初值取 D 档、与 cardOf(0, 0) 的返回一致」。
// 两条都用静态判据补上：纯函数对不对是一回事，**它有没有被接上**是另一回事。
;(function assertCardOfIsActuallyWired() {
  // 判据必须和断言文字一个范围。上一版说「fillCustomer 里」却扫全文，于是把原写法
  // 搬进一个没人调的方法当诱饵就能全绿（复审实测）。
  //
  // **这一条现在没有独占杀伤**：行为钉子进来之后，把 cardOf 换成写死对象它照样红
  // （复审实测剪掉本条仍红）。留着是为了更早、更直白地报错——「fillCustomer 里没有
  // 那一行」比「B 档 label 实为当前欠款」更指得出问题在哪。
  const body = stripJsComments(pageMethod('fillCustomer'))
  assert.ok(body.indexOf('const card = this.cardOf(receivable, prepay)') >= 0,
    'fillCustomer 里应当有 `const card = this.cardOf(receivable, prepay)`——'
      + '换成写死的对象或别的算法，上面那些断言一条都拦不住：它们测的是纯函数，'
      + '不是它有没有被接上')
  // 逐**对**核，不只查字符串在不在：复审实测把 cardAmountClass 与 cardHint 对调，
  // 四个字符串都还在、照样全绿，而屏上会把 hint 当成 class 涂上去。
  const pairs = [
    ['cardLabel', 'card.label'],
    ['cardAmountText', 'card.amountText'],
    ['cardAmountClass', 'card.amountClass'],
    ['cardHint', 'card.hint']
  ]
  pairs.forEach(function (pair) {
    // 要求后面跟一个**非标识符字符**：光前缀会把 `card.hintText` 当成 `card.hint`
    // 命中（card 上没这个字段，屏上 hint 直接消失）；而硬要结尾逗号又会在「挪到最后
    // 一格」这种行为不变的改版上误报。两头的坑复审都实测过。
    // 把「键: 」之后到下一个逗号/换行/右花括号之间的**整段**切出来比，不看「下一个
    // 字符」。上一版把空格算进终止符，于是 `card.hint && ''`、`card.label + '（…）'`
    // 这类继续往下写的表达式照样放行（复审实测，B/C 的 hint 全没了而全套绿）。
    const head = pair[0] + ': '
    const at = body.indexOf(head)
    let seg = ''
    if (at >= 0) {
      const from = at + head.length
      let end = from
      const STOP = ',' + String.fromCharCode(10) + String.fromCharCode(13) + '}'
      while (end < body.length && STOP.indexOf(body.charAt(end)) < 0) end += 1
      seg = body.slice(from, end).trim()
    }
    assert.strictEqual(seg, pair[1],
      'fillCustomer 里 ' + pair[0] + ' 应当就是 ' + pair[1] + '，实为「' + seg + '」'
        + '——接错格子、接到不存在的字段、在后面接着写表达式、或者只把原写法留在注释里，'
        + '屏上都会串位或空掉')
  })
})()

// --- 屏上那张卡真的在读这四个字段吗 -----------------------------------------
// 复审实测：把 wxml 的 `{{cardLabel}}` 写死成「当前欠款」——**等于把这次修复整个撤销**
// ——完整 npm test 仍然 EXIT=0。上面所有断言测的都是 js 侧，没有一条看 wxml。
// 补这条之前，tests/ 全仓 grep `hero-label` / `hero-num` 是零命中的。ui.test.js **已经在
// 这张卡上点按钮**（js-pay-open / js-detail-sale 就长在这张卡里），但从没读过卡上的文案。
;(function assertHeroCardReadsTheFields() {
  const wxml = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'customer-detail', 'customer-detail.wxml'), 'utf8')
  const body = stripWxmlComments(wxml)
  // 判**成对形态**，不是全文有没有这个 token：复审实测两条绕过——把原 token 留在
  // wxml 注释里、或者把 {{cardLabel}} 挪到别的节点上，全文 indexOf 都照样命中。
  // 判「带这个 class 的节点里，正文就是这个绑定」，不锁属性顺序 / 个数 / 折行——
  // 上一版把整串写死，加一个属性或折一行就误报（复审实测）。假红不如没有，但也别过紧。
  const need = [
    ['hero-label', 'cardLabel', 'label 那一行'],
    ['js-detail-amount', 'cardAmountText', '金额本身'],
    ['js-detail-hint', 'cardHint', 'hint 那一行']
  ]
  const bs = String.fromCharCode(92)
  need.forEach(function (item) {
    const re = new RegExp('class="[^"]*' + item[0] + '[^"]*"[^>]*>[^<]*' + bs + '{' + bs + '{'
      + item[1] + bs + '}' + bs + '}')
    assert.ok(re.test(body),
      '首卡的' + item[2] + '应当就地绑 {{' + item[1] + '}}（在带 ' + item[0]
        + ' 的那个节点里）——写死文案的话 cardOf 算得再对，屏上也不跟着走，'
        + '而 js 侧的断言一条都拦不住')
  })
  // 收进「带 js-detail-amount 的那个节点的 class 属性里」——上一版扫全文，把它挪到
  // 一个无关节点上（四档颜色全丢）照样绿，与本轮阻塞 2 同型（复审实测）。
  // 先把带 js-detail-amount 的那个节点的 class 属性整段取出来，再在里面找绑定——
  // class token 顺序无意义，上一版把顺序也锁了，行为等价的重排会误报（复审实测）。
  const attrRe = new RegExp('class="([^"]*js-detail-amount[^"]*)"')
  const attr = attrRe.exec(body)
  assert.ok(attr, '应当找得到带 js-detail-amount 的那个节点')
  assert.ok(attr[1].indexOf('{{cardAmountClass}}') >= 0,
    '金额那一行的颜色 class 应当就地绑 {{cardAmountClass}}（在带 js-detail-amount 的那个'
      + '节点的 class 里）——挪到别处或写死，四档颜色都不跟着走了')
  // **这条盖不到**：`wx:if` 把整块挡掉、兄弟节点覆盖、wxss 隐藏、藏一个写着绑定的
  // 诱饵节点再让真节点写死。准确说它只保证「**存在**一个带这个 class 的节点写的是绑定」，
  // 不保证屏上显示的就是它——那要 test:ui 才看得见。
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
  // 只在 data 块里找：全文第一个 `cardLabel: '` 现在恰好在 data 里，但只要将来有别的
  // 字面量排到它前面，这四条就会静默去核错的那个值。
  // **在剥过注释的那份上切**：不剥的话把四格整体退回 A 档、注释里留一份原值，
  // 这四条照样全绿——等于本分支要修的那个 bug 可以整条撤销而没人拦（复审实测）。
  const clean = stripJsComments(src)
  const dataAt = clean.indexOf('data: {')
  assert.ok(dataAt >= 0, '应当找得到 data 块')
  const dataBlock = clean.slice(dataAt, clean.indexOf(String.fromCharCode(10) + '  },', dataAt))
  pairs.forEach(function (pair) {
    const at = dataBlock.indexOf(pair[0] + ': ' + q)
    assert.ok(at >= 0, 'data 里应当有 ' + pair[0] + ' 初值')
    const from = at + (pair[0] + ': ' + q).length
    const got = dataBlock.slice(from, dataBlock.indexOf(q, from))
    assert.strictEqual(got, pair[1],
      'data 的 ' + pair[0] + ' 初值应当等于 cardOf(0, 0) 给的「' + pair[1] + '」，'
        + '实为「' + got + '」——四格里只钉一格的话，另外三格可以悄悄改成 A 档的值，'
        + '在 store.ready() 失败那条路上会渲染出「已结清 ¥1,500.00」这种自相矛盾的卡')
  })
})()

// --- 行为钉子：真跑一遍 fillCustomer -----------------------------------------
// 上面那些全是**对源码文本的静态匹配**。复审连着六轮从新形态绕过去（注释诱饵、死方法
// 诱饵、前缀诱饵、setData 之后再补一次、拿到 card 之后改字段…），每堵一个就冒一个新的
// ——因为静态匹配守的是「代码长什么样」，而我们真正要的是「屏上那四个字段是什么」。
//
// 这一条真跑：拿 store 替身喂 fillCustomer，断言最终落进 data 的值。
//
// **它不能顶掉上面那些**（上一版这么写过，是过头的自述）：cardOf 那四组守的是纯函数
// 本身、pairs 守的是接错格子、wxml 那组守的是屏上绑的是不是死文案——都有行为钉子够
// 不着的地方。它只是把「跑出来是什么」这一层补上，不是把静态那一层顶掉。
;(function assertFillCustomerProducesZeroState() {
  const inventory = require('../utils/inventory')
  // 四个字段**每档都钉**，期望值写死（不从 cardOf 算回来，否则实现改了期望跟着改，
  // 断言就恒真）。上一版只钉 label 与 class，把金额和 hint 留在 D 档那两个退化值
  // （'0.00' / ''）上——于是一行 `card.amountText = util.money(prepay)` 就能把「C 档
  // hero 数字是欠款不是预收」这条本文件自称最要紧的事撤销掉，而全套绿（复审实测）。
  const cases = [
    { name: 'A 只有欠款', receivable: 1500, prepay: 0,
      label: '当前欠款', cls: 'debt', amount: '1500.00', hintHead: '' },
    { name: 'B 只有预收', receivable: 0, prepay: 200,
      label: '预收款（收超欠款部分）', cls: 'prepay', amount: '200.00', hintHead: '欠款已清' },
    { name: 'C 并存', receivable: 84, prepay: 200,
      label: '当前欠款（另有预收待抵扣）', cls: 'debt', amount: '84.00', hintHead: '预收 ¥200.00' },
    { name: 'D 两清', receivable: 0, prepay: 0,
      label: '已结清', cls: '', amount: '0.00', hintHead: '' }
  ]
  cases.forEach(function (c) {
    const store = {
      getCustomer: function () {
        return { id: 'c1', name: '张三', account: { receivable: c.receivable, prepay: c.prepay, count: 0, amount: 0 } }
      }
    }
    const page = new Function('store', 'inventory', 'util',
      'return { ' + cardOfSrc + ',' + pageMethod('fillCustomer') + ' }')(store, inventory, util)
    page.data = {}
    page.setData = function (o) { Object.assign(page.data, o) }
    page.reloadLedger = function () {}
    page.fillCustomer('c1')

    assert.strictEqual(page.data.cardLabel, c.label,
      c.name + '：屏上 label 应当是「' + c.label + '」，实为「' + page.data.cardLabel + '」'
        + '——这一条真跑 fillCustomer，静态匹配骗不过它')
    assert.strictEqual(page.data.cardAmountClass, c.cls,
      c.name + '：金额颜色 class 应当是「' + c.cls + '」，实为「' + page.data.cardAmountClass + '」')
    assert.strictEqual(page.data.cardAmountText, c.amount,
      c.name + '：屏上金额应当是 ¥' + c.amount + '，实为 ¥' + page.data.cardAmountText
        + '——C 档尤其要紧：hero 数字是**欠款**不是预收，写成预收的话一个还欠 84 的客户'
        + '屏上会显示 200，店主会以为不用收钱了')
    if (c.hintHead === '') {
      assert.strictEqual(page.data.cardHint, '', c.name + '：这一档不出 hint')
    } else {
      assert.ok(String(page.data.cardHint).indexOf(c.hintHead) === 0,
        c.name + '：hint 应当以「' + c.hintHead + '」开头，实为「' + page.data.cardHint + '」')
    }
  })

})()

console.log('customer-card tests passed')
