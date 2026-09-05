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
// 从 `key:` 起，扫到**同层**的逗号或右花括号为止：括号/方括号/引号里的逗号不算。
// 上一版按「下一个终止字符」切，于是值里含逗号（`f(a, b)`）会切歪、换行续写会漏。
function valueOf(body, key) {
  let i = body.indexOf(key + ':')
  if (i < 0) return ''
  i += key.length + 1
  let depth = 0
  let quote = ''
  let out = ''
  while (i < body.length) {
    const ch = body.charAt(i)
    if (quote) {
      out += ch
      if (ch === quote) quote = ''
    } else if (ch === String.fromCharCode(39) || ch === '"' || ch === '`') {
      quote = ch; out += ch
    } else if ('([{'.indexOf(ch) >= 0) {
      depth += 1; out += ch
    } else if (')]'.indexOf(ch) >= 0) {
      depth -= 1; out += ch
    } else if (ch === '}') {
      if (depth === 0) break
      depth -= 1; out += ch
    } else if (ch === ',' && depth === 0) {
      break
    } else {
      out += ch
    }
    i += 1
  }
  return out.trim()
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

// --- 四档的值由下面的行为钉子守 ----------------------------------------------
// 这里原本有 A/B/C/D 四块直接调 cardOf 的静态断言。复审跑变异矩阵实测，
// **四块的独占杀伤为零**，单独关、一起关都没有一条由红变绿——因为行为钉子喂给
// fillCustomer 的那几组输入，经 round2/toNumber 之后覆盖了这四块的全部四组，而且金额那格
// 行为钉子写的是字面量、这四块写的是 util.money(...)（money 自己被改坏时两边一起变、
// 反而不响）。**行为钉子严格强于它们**，不是「各守一摊」。
//
// 上一版这里写着「它不能顶掉上面那些…都有行为钉子够不着的地方」——那是把一句吹过头的
// 自述换成了一句方向相反、同样不成立的自述。既然实测是纯冗余，就删掉，不留着装门面：
// 冗余判据会制造「守得很严」的错觉，而且每一条都是将来「声称 ≠ 实际」的新机会。

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
  // --- 接线处不许做计算 -------------------------------------------------------
  // 规则：首卡这四格必须是**纯 `card.X` 引用**，所有计算都在 cardOf 里。
  //
  // 上一轮我把这组删了，理由是「5 条独占里 4 条假红」（`String(card.amountText)`、
  // `card.hint || ''`、`.join('')`、冒号后少个空格）。**删过头了**：它杀的是「值不是
  // 纯引用」这**一整类**，我拿矩阵里出现过的一个样本（`receivable > 100000 ? …`）当成
  // 了那一类，删完之后同类的别的写法全逃——换个阈值、换个字段、按客户名分支，复审实测
  // 四种全绿。行为钉子按输入组取样，天生盖不住一个连续区间。
  //
  // 这一版把规则挑明：在**这里**做计算就是红的，哪怕行为等价。所以 `String(...)` 包装
  // 之类不再算「假红」——它们确实违反这条规则，计算该搬进 cardOf。真正要修的是当初那个
  // 糙切法（按「下一个终止字符」切），现在改成**同层逗号扫描**：跳过成对括号与引号里的
  // 逗号，冒号后的空白也不写死。
  const pairs = [
    ['cardLabel', 'card.label'],
    ['cardAmountText', 'card.amountText'],
    ['cardAmountClass', 'card.amountClass'],
    ['cardHint', 'card.hint']
  ]
  pairs.forEach(function (pair) {
    const seg = valueOf(body, pair[0])
    assert.strictEqual(seg, pair[1],
      'fillCustomer 里 ' + pair[0] + ' 应当就是 ' + pair[1] + '，实为「' + seg + '」——'
        + '这四格只许写纯引用，任何计算（三元、拼串、包一层函数、|| 兜底）都要搬进 '
        + 'cardOf。在接线处算，cardOf 的四档就说了不算，而屏上跟着变')
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
    // 前后都不许有别的文案：只管绑定**前**那一段的话，
    // `<view class="hero-label">当前欠款 {{cardLabel}}</view>` 和
    // `...>¥{{cardAmountText}} 欠款</view>` 都能过（复审实测），屏上会变成「当前欠款 已结清」。
    const re = new RegExp('class="[^"]*' + item[0] + '[^"]*"[^>]*>[' + bs + 's¥]*' + bs + '{' + bs + '{'
      + item[1] + bs + '}' + bs + '}' + bs + 's*<')
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
  // `data: {` 只许出现一次：取第一处的话，在 Page({ 后面塞一个返回 `{ data: {…正确四格…} }`
  // 的方法当诱饵，真 data 块就能整条改成 A 档而全绿（复审实测）。上一版把洞从「全文第一个
  // cardLabel」挪到了「全文第一个 data: {」，没堵住。
  let dataHits = 0
  let dataScan = clean.indexOf('data: {')
  while (dataScan >= 0) { dataHits += 1; dataScan = clean.indexOf('data: {', dataScan + 1) }
  assert.strictEqual(dataHits, 1,
    '源码里 `data: {` 出现了 ' + dataHits + ' 次，应当只有 1 次——多出来的那份多半是在冒充它')
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
// **它顶不掉的是 wxml 那一层**（屏上绑的是不是死文案）和 data 初值那一节——它只看
// fillCustomer 跑出来的 data，看不见模板。cardOf 那四块与 pairs 的关系见上面各自的
// 说明：四块是纯冗余已删，pairs 守的是「接线处不许做计算」，行为钉子按输入取样、
// 盖不住连续区间，两者互补。
;(function assertFillCustomerProducesZeroState() {
  const inventory = require('../utils/inventory')
  // 四个字段**每档都钉**，期望值写死（不从 cardOf 算回来，否则实现改了期望跟着改，
  // 断言就恒真）。上一版只钉 label 与 class，把金额和 hint 留在 D 档那两个退化值
  // （'0.00' / ''）上——于是一行 `card.amountText = util.money(prepay)` 就能把「C 档
  // hero 数字是欠款不是预收」这条本文件自称最要紧的事撤销掉，而全套绿（复审实测）。
  const cases = [
    { name: 'A 只有欠款', receivable: 1500, prepay: 0,
      label: '当前欠款', cls: 'debt', amount: '1500.00', hint: '' },
    { name: 'B 只有预收', receivable: 0, prepay: 200,
      label: '预收款（收超欠款部分）', cls: 'prepay', amount: '200.00',
      hint: '欠款已清 · 下次开单可抵 · 点收款可继续记预收' },
    { name: 'C 并存', receivable: 84, prepay: 200,
      label: '当前欠款（另有预收待抵扣）', cls: 'debt', amount: '84.00',
      hint: '预收 ¥200.00 不自动冲欠款。下次开单会带出抵扣行，可改；要收款先冲这 ¥84.00' },
    { name: 'D 两清', receivable: 0, prepay: 0,
      label: '已结清', cls: '', amount: '0.00', hint: '' },
    // 第五组接管被删掉的 pairs 判据那条唯一真杀伤：把某一格改成依赖输入的表达式
    // （`receivable > 100000 ? '大额' : card.amountText` 之类）。四档输入都够不着它。
    { name: 'A 大额', receivable: 200000, prepay: 0,
      label: '当前欠款', cls: 'debt', amount: '200000.00', hint: '' }
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
    // 替身要**收下并调用**第二个参数：fillCustomer 真的传了成功回调，丢掉它的话
    // 回调里再写一次 setData 就完全逃逸（复审实测，全套绿）。
    page.setData = function (o, cb) { Object.assign(page.data, o); if (cb) cb() }
    page.reloadLedger = function () {}
    page.openPay = function () {}   // 回调那条路真跑起来时别崩成 TypeError
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
    // hint 钉**整串**，不只钉开头：只钉开头的话尾巴可以改成语义相反的话而全绿——
    // 复审实测把 C 档尾巴换成「已自动冲抵，无需再收款」（与「预收不自动冲欠款」这条
    // 账法口径正相反）全套仍绿。稿号 B 7:253 / C 9:7。
    assert.strictEqual(page.data.cardHint, c.hint,
      c.name + '：hint 应当逐字是「' + c.hint + '」，实为「' + page.data.cardHint + '」')
  })

})()

console.log('customer-card tests passed')
