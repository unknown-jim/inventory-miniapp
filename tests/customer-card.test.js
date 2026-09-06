// 客户详情首卡四档（pages/customer-detail/customer-detail.js 的 cardOf）。
//
// 这四档此前**一条测试都没有**。它们不是记账逻辑，改错了不会让钱算错，但会让店主
// **读错数**——B 档和 C 档的 hero 数字一个是预收一个是欠款，看混了就会以为客户还欠着
// 或者已经清了。源码注释自己都写着「B 与 C 的差别是本批最容易做错的一处」，却没人守。
//
// 逐字取自稿：A 4:369 / B 7:251 + 7:253 / C 9:5 + 9:7 / D 28:1（2026-09-05 补画）。
// 【这些判据防什么、不防什么】
//
// 防的是**误改**：有人改 cardOf 或 fillCustomer 时不小心把四档的值、颜色、接线、
// 模板绑定弄错——这是真实会发生的事，本文件每一条都对着一个实测过的这类形态。
//
// **不防刻意伪装**。一个想让改动躲过测试的编辑者总能做到：把代码藏进字符串里让剥注释
// 那步吃掉（执行用原文之后这条被行为钉子逮住，但静态判据仍被骗）、用计算键
// `['card' + 'Label']` 绕开键名计数、把分支阈值卡在行为钉子的取样点之间。这些复审都
// 实测过，一一列在各条旁边。**堵不完**——静态文本判据对着刻意伪装是打不赢的，
// 每加一层都会带出新的缝和新的假红。
//
// 所以这里的取舍是：行为钉子（真跑 fillCustomer）当主防线，静态判据守它够不着的层
// （模板绑定、data 初值、接线处不许做计算），**每条都写清自己盖不到什么**，不写
// 「这一类都守住了」。

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
// 抠两份：静态判据用剥过注释的，**执行**用原文。
// 上一版两边都用剥过的，于是一个含 /* 的字符串就能让真代码在测试眼里消失——
// `const OPEN = "/*" … const CLOSE = "*/"` 中间那几行连同引号一起被当成块注释吃掉，
// 剥完语法仍合法、四档照常绿，而生产上整条修复被撤销（复审实测，全套 EXIT=0）。
// 「这一条真跑」那句自述在那条通道上不成立。
//
// 互校：「先剥再抠」与「先抠再剥」必须一致。
// **它只覆盖一种情况**：被吃掉的那段里花括号不配平（两条路径的抠取边界因此分叉）。
// 伪装如果整段落在同一个方法体内且花括号配平，两边删的是同一段，`a === b` 恒成立，
// 互校静默放行——复审实测过，`// "/*"` 包一段重复键，四条静态判据全过而生产行为已错。
// 真正挡住那条通道的是**执行用原文**（下面 return 的那份）：伪装的代码会真的跑起来，
// 由行为钉子逮住。互校只是多一道诊断，不是那条通道的防线。
function pageMethod(name) {
  const a = extractBody(stripJsComments(src), name)
  const b = stripJsComments(extractBody(src, name))
  assert.strictEqual(a, b,
    '方法 ' + name + '「先剥再抠」与「先抠再剥」结果不同——多半是注释标记藏在字符串里，'
      + '剥注释那一步把真代码吃掉了。这会让下面「真跑一遍」跑的不是文件里的程序')
  return extractBody(src, name)
}
function extractBody(source, name) {
  const needle = String.fromCharCode(10) + '  ' + name + '('
  const clean = source
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
  // 扫描时**跳过注释**：原文那条路径上，注释里一个落单的 { 或 } 会让扫描越界，
  // 而互校报出来的是「剥注释那步吃掉了真代码」——方向正好相反（复审实测）。
  const SL = String.fromCharCode(47)
  const QU = String.fromCharCode(39)
  const BT = String.fromCharCode(96)
  // 跳注释和跳字符串**必须成对做**：只跳注释的话，字符串里一个 `https://` 会让扫描从
  // `//` 一路跳到行尾、把同一行后面的花括号一起吃掉，于是合法源码被判红，而诊断说的是
  // 「游离的 { 或 }」——方向指错（复审实测，这条假红是上一轮新引入的）。
  while (i < clean.length && depth > 0) {
    const c = clean[i]
    if (c === QU || c === '"' || c === BT) {
      const q = c
      i += 1
      while (i < clean.length) {
        if (clean[i] === String.fromCharCode(92)) { i += 2; continue }
        if (clean[i] === q) { i += 1; break }
        i += 1
      }
      continue
    }
    if (c === SL && clean[i + 1] === SL) {
      while (i < clean.length && clean[i] !== String.fromCharCode(10)) i += 1
      continue
    }
    if (c === SL && clean[i + 1] === '*') {
      i += 2
      while (i < clean.length && !(clean[i] === '*' && clean[i + 1] === SL)) i += 1
      i += 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
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

// 把 SyntaxError 翻译成人话。扫描器**跳注释也跳字符串**（两者必须成对跳，只跳一半就是
// 把假红从一个形态挪到另一个形态），但它仍可能被别的形态截错位，抠出半截函数体，
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
    // 每个键在 fillCustomer 体内**只许出现一次**：valueOf 取的是第一处，前面先摆一个
    // `const shape = { cardLabel: card.label, … }` 当诱饵，真 setData 里那四格就能随便
    // 算而判据改判在诱饵上（复审实测，全套 EXIT=0）。多出来直接红，不猜哪个是真的。
    let keyHits = 0
    let keyScan = body.indexOf(pair[0] + ':')
    while (keyScan >= 0) { keyHits += 1; keyScan = body.indexOf(pair[0] + ':', keyScan + 1) }
    assert.strictEqual(keyHits, 1,
      'fillCustomer 里 ' + pair[0] + ' 出现了 ' + keyHits + ' 次，应当只有 1 次'
        + '——多出来的那份会让下面这条断言改判在它身上')
    const seg = valueOf(body, pair[0])
    assert.strictEqual(seg, pair[1],
      'fillCustomer 里 ' + pair[0] + ' 应当就是 ' + pair[1] + '，实为「' + seg + '」——'
        + '这四格只许写纯引用，任何计算（三元、拼串、包一层函数、|| 兜底）都要搬进 '
        + 'cardOf。在接线处算，cardOf 的四档就说了不算，而屏上跟着变')
  })
  // 规则的后半句（「所有计算都在 cardOf 里」）单独钉：拿到 card 之后、setData 之前
  // 改它的字段，上面四条看到的仍是纯引用，行为钉子也够不着（替身的客户名恒定）。
  // 对 card 的写操作：点号赋值、下标赋值、Object.assign 三种都拦。
  // 上一版只拦点号赋值：`card['label'] = …` 和 `Object.assign(card, {…})` **挂一个替身
  // 看不见的条件时**全过（无条件写会被行为钉子逮住——这个区别上一版没写清，又是一次
  // 「从一个样本泛化」）；
  // 而且子串匹配把 `card.label === '已结清'` 这种纯比较也判红（假红）。两头都实测过。
  const bs2 = String.fromCharCode(92)
  // `=` 前面允许一个复合运算符：上一版只认裸 `=`，`card.label += x` 匹配不上（复审实测，
  // 挂一个替身看不见的条件就全逃）。后面的 `(?!=)` 仍排除 `==`/`===`。
  const assignRe = new RegExp('card' + bs2 + '.(label|amountText|amountClass|hint)'
    + bs2 + 's*(?:[+' + bs2 + '-*/%|&^]|' + bs2 + '*' + bs2 + '*|' + bs2 + '?' + bs2 + '?|'
    + bs2 + '|' + bs2 + '||&&)?=(?!=)')
  const m = assignRe.exec(body)
  assert.ok(!m, 'fillCustomer 里不许写 `card.X = ...`，实为「' + (m ? m[0] : '') + '」'
    + '——cardOf 算出来的东西在这里被改掉的话，四档就说了不算，'
    + '而上面那几条断言看到的仍是纯引用')
  // 下标形态也判**赋值**，不是判「出现过 card[」：上一版纯读 `card['label'] === '已结清'`
  // 也判红（假红）——而同一个 commit 刚给点号形态加了 (?!=) 就是为了修这个毛病。
  const idxRe = new RegExp('card' + bs2 + '[[^' + bs2 + ']]*' + bs2 + ']' + bs2 + 's*=(?!=)')
  const mi = idxRe.exec(body)
  assert.ok(!mi, 'fillCustomer 里不许用下标写 card，实为「' + (mi ? mi[0] : '') + '」——同上')
  assert.ok(body.indexOf('Object.assign(card') < 0,
    'fillCustomer 里不许 Object.assign 到 card 上——同上')
  // **这三条盖不到**：先起别名再写（`const c = card; c.label = …`）。挂条件时行为钉子
  // 也够不着（替身的 customer 只有 id/name/account）。属已知缺口，不再加第四条判据去追。
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

// data 初值这一节**改成真跑**：`global.Page` 挂钩，require 一次页面模块，读它交上来的
// 那个 data 对象，和 cardOf(0, 0) 比。
//
// 上一版是文本匹配，缝一直在挪：全文第一个 cardLabel → 全文第一个 `data: {` → 块内第一处
// → 块内「恰好 4 空格缩进」的第一处。复审每轮换个形态就绕过去——缩进多打两格、
// 字符串里藏注释标记、计算键 `['card' + 'Label']`，三条都能让运行时初值整条回到 A 档
// 而全套绿。**这一层至今没有行为钉子兜底，是全文件唯一还在纯文本判据上的一层。**
// 真跑之后这三条一起关掉，也不再锁缩进和引号风格。
;(function assertDataDefaultsAreZeroState() {
  const prevPage = global.Page
  const prevGetApp = global.getApp
  const prevWx = global.wx
  let captured = null
  global.Page = function (o) { captured = o }
  global.getApp = global.getApp || function () { return { globalData: {} } }
  global.wx = global.wx || { setStorageSync: function () {}, getStorageSync: function () {} }
  const modPath = require.resolve('../pages/customer-detail/customer-detail.js')
  delete require.cache[modPath]
  try {
    require(modPath)
  } finally {
    global.Page = prevPage
    global.getApp = prevGetApp
    global.wx = prevWx
    delete require.cache[modPath]
  }
  assert.ok(captured && captured.data, '页面模块应当把 data 交给 Page()')

  const zero = cardOf(0, 0)
  const pairs = [
    ['cardLabel', zero.label],
    ['cardAmountText', zero.amountText],
    ['cardAmountClass', zero.amountClass],
    ['cardHint', zero.hint]
  ]
  pairs.forEach(function (pair) {
    assert.strictEqual(captured.data[pair[0]], pair[1],
      'data 的 ' + pair[0] + ' 初值应当等于 cardOf(0, 0) 给的「' + pair[1] + '」，实为「'
        + captured.data[pair[0]] + '」——零态该长 cardOf(0, 0) 的样子。'
        + '在 store.ready() 失败那条路上这个初值是屏上看得见的')
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
    // 第五组守的是「cardOf **内部**按阈值分支」这一类**里 200000 能落进去的那些**：
    // 阈值 ≤ 200000 的分支（`> 100000`、`>= 200000`）会被它抓到；阈值**高于** 200000
    // （`> 200000`、`> 300000`）或落在四档取样点之间（`> 300 && < 1000`）的同类分支
    // 它看不见——行为钉子按输入取样，天生盖不住连续区间，加几组输入也堵不完。
    // （上一版这句写反了：写的是「阈值高于 200000 时会被它抓到」，实测正相反。）
    // 上一版这里写「那一类」，是又一次「从一个样本泛化成一类」。
    // （上一版这里写「接管被删掉的 pairs」——pairs 本轮已恢复，那是悬空引用。）
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
