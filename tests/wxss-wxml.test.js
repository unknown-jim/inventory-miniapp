// WXSS / WXML 的静态检查。**纯 Node，不开开发者工具**，跟着 npm test 一起跑。
//
// ---------------------------------------------------------------------------
// 【为什么要有这个文件】2026-08-30，PR #93 新建的商品详情页，WXSS 第一行注释是：
//
//     /* 只读详情页。共用类（.card/.btn-*/.action-strip）来自 app.wxss，这里只写本页布局。 */
//
// 里面那个 `.btn-*/` 的 `*/` **把块注释提前闭合了**，后半句 `.action-strip）来自
// app.wxss，这里只写本页布局。 */` 掉进 CSS 正文，成了非法 CSS。后果是一条长链：
//     整页 WXSS 编译失败 → 开发者工具**不显式报错**、整个工程构建不出来
//   → automator 第一步就抛 `Cannot destructure property 'rawPath' of
//     't.getPageMetaByWebviewId(...)' as it is null`
// 那句话看上去完全像路由或环境问题。实际定位花了 4 次真机运行 + 逐文件二分。
//
// 而 `npm test` 那二十几项**一行 WXSS 都不编译**，24 项全绿也发现不了。
// 这个文件就是补这一格：一次 O(文件大小) 的扫描，把「注释提前闭合」「大括号不平衡」
// 这类会让整页编译失败的低垂果实，在开工具之前就拦下来。
//
// 【它不做什么，别高估】这不是 WXSS / WXML 编译器：
//   · 不查选择器合法性、不查属性名、不查值的单位；
//   · 不查 wxss 的 @import 目标是否存在；
//   · 不做 wxml 的表达式求值。
// 它只查「结构层面自洽」——恰好是 #93 那条 bug 所在的层，也是编译器失败时最不给
// 线索的那一层。
//
// 【怎么证明它有效】改完之后把 #93 那行原始注释放回
// pages/product-detail/product-detail.wxss，本文件必须变红；还原之后必须变绿。
// 不做这一步就等于没测 —— 本项目已经用血换过两次（fuzz 生成器天然满足被测约束、
// `>>>` 静默降级）。本轮的变异验证结果记在 PR 正文里。
// ---------------------------------------------------------------------------

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function walk(dir, out) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    return out
  }
  names.forEach(function (name) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      walk(full, out)
    } else {
      out.push(full)
    }
  })
  return out
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

// 收集范围：pages/** 与 components/** 下的全部 wxss/wxml，外加根上的 app.wxss。
// **不要**收 node_modules 和 miniprogram_npm：那不是我们写的。
function collect(ext) {
  const files = walk(path.join(root, 'pages'), []).concat(walk(path.join(root, 'components'), []))
  const hit = files.filter(function (file) {
    return file.toLowerCase().endsWith(ext)
  })
  const appLevel = path.join(root, 'app' + ext)
  if (fs.existsSync(appLevel)) hit.push(appLevel)
  return hit.sort()
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line += 1
  }
  return line
}

// ---------------------------------------------------------------------------
// WXSS 扫描器
//
// 逐字符走一遍，维护三个状态：正文 / 块注释里 / 字符串里。为什么不用正则一把梭：
//   · 只用非贪婪 `/\*[\s\S]*?\*\//g` 剥注释，确实能抓到 #93（剥完会剩一个 `*/`），
//     但它分不清 `content: "*/"` 这种字符串里的 `*/`，会误报；
//   · 大括号计数同样必须排除注释和字符串里的括号。
// 状态机把这三件事一次做完，而且能报出**行号**，比「文件里有个残留的 */」有用得多。
// ---------------------------------------------------------------------------
function scanWxss(src) {
  const problems = []
  let depth = 0
  let deepestNegativeAt = -1
  let i = 0
  let commentStart = -1
  let stringStart = -1
  let quote = ''
  const openBraces = []
  while (i < src.length) {
    const two = src.substr(i, 2)
    if (commentStart >= 0) {
      if (two === '*/') {
        commentStart = -1
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (stringStart >= 0) {
      if (src[i] === '\\') {
        i += 2
        continue
      }
      if (src[i] === quote) {
        stringStart = -1
        quote = ''
      }
      // wxss 里的字符串不跨行；跨了多半是引号没闭合，报出来比一路吞到文件尾好。
      if (src[i] === '\n') {
        problems.push({
          at: stringStart,
          what: '字符串没闭合（起自第 ' + lineOf(src, stringStart) + ' 行的 ' + quote + '），'
            + '引号吞掉了后面的内容，后半个文件都不会被当成 CSS'
        })
        stringStart = -1
        quote = ''
      }
      i += 1
      continue
    }
    if (two === '/*') {
      commentStart = i
      i += 2
      continue
    }
    // 【这就是 #93 那条 bug 的精确特征】正文里出现 `*/`：块注释在此之前已经闭合过一次，
    // 说明注释里本来写着的 `*/`（例如 `.btn-*/`）把注释提前关掉了，从那一刻起
    // 后半句注释文字已经掉进 CSS 正文，整页编译失败。
    if (two === '*/') {
      problems.push({
        at: i,
        what: '正文里出现了多余的 `*/`（不在任何块注释内）。'
          + '几乎总是因为块注释里写了含 `*/` 的文本（例如 `.btn-*` 后面紧跟 `/`），'
          + '注释被提前闭合，后半句掉进 CSS 正文 —— 这正是 2026-08-30 PR #93 那条 bug。'
          + '把注释里的 `*/` 拆开（写成 `.btn-*` 和 `/` 之间加空格，或改用顿号列举）即可'
      })
      i += 2
      continue
    }
    if (src[i] === '"' || src[i] === "'") {
      stringStart = i
      quote = src[i]
      i += 1
      continue
    }
    if (src[i] === '{') {
      openBraces.push(i)
      depth += 1
    } else if (src[i] === '}') {
      depth -= 1
      if (depth < 0 && deepestNegativeAt < 0) deepestNegativeAt = i
      if (openBraces.length) openBraces.pop()
    }
    i += 1
  }
  if (commentStart >= 0) {
    problems.push({
      at: commentStart,
      what: '块注释没有闭合（`/*` 之后再没有 `*/`），从这里到文件末尾整段都被当成注释吞掉了'
    })
  }
  if (stringStart >= 0) {
    problems.push({ at: stringStart, what: '字符串没闭合（' + quote + '）' })
  }
  if (deepestNegativeAt >= 0) {
    problems.push({ at: deepestNegativeAt, what: '多出来一个 `}`（此处右括号没有配对的左括号）' })
  }
  if (depth > 0) {
    problems.push({
      at: openBraces.length ? openBraces[0] : 0,
      what: '少了 ' + depth + ' 个 `}`（这个 `{` 及其后共有 ' + depth + ' 个左括号没闭合）'
    })
  }
  return problems
}

// ---------------------------------------------------------------------------
// WXML 扫描器
//
// 只做两件低垂果实：标签配对、wx:for 缺 wx:key。**不做**完整 HTML 解析。
// 自闭合（`<image ... />`）、注释（`<!-- -->`）、`<wxs>` 里的 JS 都要认出来，
// 否则会成片误报 —— 误报的静态检查会被人关掉，那比没有还糟。
// ---------------------------------------------------------------------------

// wxml 没有 HTML 那套 void 元素（<img>、<br> 之类）：内置组件一律要么成对、要么自闭合。
// 真出现单标签写法的话，与其在这里维护一张白名单，不如让它红一次、人看一眼。
const TAG_RE = /<(\/?)([a-zA-Z][-a-zA-Z0-9_]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

function scanWxml(src) {
  const problems = []
  const stack = []
  // 注释和 wxs 段先挖成等长空白：保持偏移不变，行号才还是对的。
  const blanked = src
    .replace(/<!--[\s\S]*?-->/g, function (block) { return block.replace(/[^\n]/g, ' ') })
    .replace(/<wxs\b[\s\S]*?<\/wxs>/g, function (block) { return block.replace(/[^\n]/g, ' ') })
  let m = null
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(blanked)) !== null) {
    const closing = m[1] === '/'
    const name = m[2]
    const attrs = m[3] || ''
    const selfClosing = m[4] === '/'
    if (!closing && /\bwx:for\b/.test(attrs) && !/\bwx:key\b/.test(attrs)) {
      problems.push({
        at: m.index,
        what: '<' + name + '> 用了 wx:for 却没有 wx:key。列表项一变动，'
          + '没有 key 的节点会整段重建：输入框里打了一半的字会丢、选中态会串行'
      })
    }
    if (selfClosing) continue
    if (closing) {
      if (!stack.length) {
        problems.push({ at: m.index, what: '多出来一个 </' + name + '>，前面没有对应的 <' + name + '>' })
        continue
      }
      const top = stack[stack.length - 1]
      if (top.name !== name) {
        problems.push({
          at: m.index,
          what: '</' + name + '> 和最近的未闭合标签对不上：栈顶是第 '
            + lineOf(blanked, top.at) + ' 行的 <' + top.name + '>'
        })
        // 容错一次：如果栈里更深处有同名标签，就当中间那些漏写了闭合，弹到它为止，
        // 免得一处笔误把后面所有标签都报成错。
        let found = -1
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === name) { found = k; break }
        }
        if (found >= 0) stack.length = found
        continue
      }
      stack.pop()
      continue
    }
    stack.push({ name: name, at: m.index })
  }
  stack.forEach(function (item) {
    problems.push({ at: item.at, what: '<' + item.name + '> 没有闭合' })
  })
  return problems
}

function report(file, src, problems) {
  return problems.map(function (item) {
    return '  ' + rel(file) + ':' + lineOf(src, item.at) + '  ' + item.what
  }).join('\n')
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const wxssFiles = collect('.wxss')
assert.ok(
  wxssFiles.length >= 10,
  '一个 wxss 都没扫到（实为 ' + wxssFiles.length + ' 个）—— 目录约定变了的话这个测试是假绿的，'
    + '请一起改 collect()'
)

const wxssBad = []
wxssFiles.forEach(function (file) {
  const src = fs.readFileSync(file, 'utf8')
  const problems = scanWxss(src)
  if (problems.length) wxssBad.push(report(file, src, problems))
})
assert.strictEqual(
  wxssBad.length,
  0,
  '这些 wxss 结构上就不自洽，开发者工具会整页编译失败而且**不显式报错**（现场是\n'
    + "automator 第一步抛 Cannot destructure property 'rawPath' ...，看着像路由问题）：\n"
    + wxssBad.join('\n')
)

const wxmlFiles = collect('.wxml')
assert.ok(
  wxmlFiles.length >= 10,
  '一个 wxml 都没扫到（实为 ' + wxmlFiles.length + ' 个）—— 同上，collect() 要一起改'
)

const wxmlBad = []
wxmlFiles.forEach(function (file) {
  const src = fs.readFileSync(file, 'utf8')
  const problems = scanWxml(src)
  if (problems.length) wxmlBad.push(report(file, src, problems))
})
assert.strictEqual(
  wxmlBad.length,
  0,
  '这些 wxml 有标签配对或 wx:key 的问题：\n' + wxmlBad.join('\n')
)

// ---------------------------------------------------------------------------
// 扫描器自检：拿手搭的坏样本喂进去，确认它**真的会报**。
//
// 【为什么必须有这一段】上面两条断言在仓库干净时恒绿 —— 而「恒绿」和「有效」是两回事。
// 扫描器哪天被改坏成 `return []`，上面两条照样全绿，保护静默消失。这段就是钉那个洞：
// 每一类问题各喂一个最小样本，报不出来就当场红。
//
// 第一个样本**就是 #93 的原文**（`.btn-*` 紧跟 `/`），所以这条钉子同时也是那条 bug
// 的回归用例：真把那行注释放回 product-detail.wxss，上面的扫描和这里的自检说的是同一件事。
// ---------------------------------------------------------------------------
const BAD_CSS = [
  ['#93 原文：注释里的 `.btn-*` 紧跟 `/` 把块注释提前闭合',
    '/* 只读详情页。共用类（.card/.btn-*' + '/.action-strip）来自 app.wxss。 */\n.main-card { color: red; }\n'],
  ['块注释没闭合', '/* 开了没关\n.main-card { color: red; }\n'],
  ['多一个右括号', '.a { color: red; }\n}\n'],
  ['少一个右括号', '.a { color: red;\n']
]
BAD_CSS.forEach(function (pair) {
  assert.ok(
    scanWxss(pair[1]).length > 0,
    '扫描器自检失败：这种坏 wxss 应当被报出来，实际一条都没报 —— ' + pair[0]
  )
})
// 反向：正常写法不许误报。字符串里的 `*/`、注释里的 `{`、@media 嵌套都要放行。
const GOOD_CSS = [
  ['字符串里的 */', '.a::after { content: "*/"; }\n'],
  ['注释里的花括号', '/* { 这里有个左括号 */\n.a { color: red; }\n'],
  ['@media 嵌套', '@media (min-width: 100px) { .a { color: red; } }\n'],
  ['转义引号', ".a::after { content: '\\'*/'; }\n"]
]
GOOD_CSS.forEach(function (pair) {
  const problems = scanWxss(pair[1])
  assert.strictEqual(
    problems.length,
    0,
    '扫描器误报：这是合法 wxss —— ' + pair[0] + '，却报了 ' + JSON.stringify(problems)
  )
})

const BAD_WXML = [
  ['标签没闭合', '<view class="page">\n  <text>a</text>\n'],
  ['闭合标签对不上', '<view>\n  <text>a</view>\n</text>\n'],
  ['wx:for 缺 wx:key', '<view wx:for="{{list}}">{{item.name}}</view>\n']
]
BAD_WXML.forEach(function (pair) {
  assert.ok(
    scanWxml(pair[1]).length > 0,
    '扫描器自检失败：这种坏 wxml 应当被报出来，实际一条都没报 —— ' + pair[0]
  )
})
const GOOD_WXML = [
  ['自闭合组件', '<view>\n  <image src="{{a}}" mode="aspectFill" />\n</view>\n'],
  ['注释里的假标签', '<!-- <view> 这是注释里的 -->\n<view>a</view>\n'],
  ['属性值里的尖括号', '<view data-tip="a > b">x</view>\n'],
  ['wx:for 带 wx:key', '<view wx:for="{{list}}" wx:key="id">{{item.name}}</view>\n'],
  ['wxs 段里的 JS', '<wxs module="m">\nvar a = 1 < 2\n</wxs>\n<view>a</view>\n']
]
GOOD_WXML.forEach(function (pair) {
  const problems = scanWxml(pair[1])
  assert.strictEqual(
    problems.length,
    0,
    '扫描器误报：这是合法 wxml —— ' + pair[0] + '，却报了 ' + JSON.stringify(problems)
  )
})

// ---------------------------------------------------------------------------
// 【内联 SVG 的颜色】wxss 里有一批图标是 `background-image: url("data:image/svg+xml,...")`，
// 颜色以 URL 编码写在里面（`stroke='%23A3A3A3'`）。这个位置有个讨厌的性质：
// 主题色 grep 搜 `#A3A3A3` 搜不到它（是 `%23` 不是 `#`），tab 图标那套逐像素颜色
// 断言也够不着它（那是 PNG，这是 CSS 文本）。于是 2026-08-31 那 13 个批次一路改主题色，
// 把这里的 `#0F756E` 和一处低于对比度地板的 `#A3A3A3` 完整地留了下来，
// 直到 2026-09-02 手工扫 wxss 才发现——**藏了 13 轮，没有任何一条断言路过它**。
//
// 【这条断言被审计打穿过三轮，每一轮的教训都不一样，别退回去】
//   一轮：只匹配「%23 + 6 位 hex」→ 5 条通道（rgb() / 具名色 / 三位简写 / 裸 # /
//         补一个 stroke-opacity 静默掉档）。教训：查取值，别查某种写法。
//   二轮：改成解析取值 → 又 8 条（换引号、style='stroke:…'、内嵌 <style>、;utf8、
//         ;charset=、;base64、style='opacity:…'、双引号 stroke-opacity）。
//         其中 `;base64` 一类最狠——**它让整条 URI 从计数里消失**，「扫不到就报红」
//         那条兜不住：现存的还在，隐身的那条不进计数。教训：**别按写法拉黑，
//         拉黑永远有下一个变体**；改卡形状白名单。
//   三轮：又 2 条。`%22` / `%27` 百分号编码的属性引号——这是 encodeURIComponent()
//         的标准产物、业界内联 SVG 最常见的写法，形状白名单放行、URI 计数还会涨，
//         颜色却完全看不见；以及 `URL(` 大写绕过外层正则，直接跳过白名单本身。
//         教训：**归一化，而不是再加一条分支**——所以现在整段 decodeURIComponent
//         之后再匹配，`%22`/`%27`/`%3C`/`%20` 一次性全归位，以后的编码变体自动覆盖。
//
// 判据是 WCAG 1.4.11：非文字的 UI 部件边界，白底上要 ≥ 3:1。
// role 有两种，**不要混**：
//   ui           —— 部件边界/图标，必须过地板，且**不许再叠 opacity**（叠了就是静默掉档）
//   illustration —— 装饰性插画，按裁定豁免地板，可以叠 opacity，但**落点被 allowedIn 钉死**
// 把豁免件写成「达标」是审计抓到的真问题：`6B7280` 原先注着 4.83:1，可它实际带
// `fill-opacity='0.5'`，合成约 #B5B9BF ≈ 1.97:1——那个 4.83 是渲染不出来的数字，
// 却又是自检赖以「通过」的数字。豁免就写豁免，不要拿一个好看的数字给它背书。
// allowedIn 也是审计提的：否则把坏色登记成 illustration 就能用在真部件上，逃生舱无人看守。
//
// 【它盖不到什么，别高估】把边界写清楚，是因为二轮的注释写了句「别的写法一律报红」，
// 当场被 8 条通道证伪。**断言的注释声称的能力超过断言实际的能力，跟把稿的现状写成
// 稿的意图是同一个错误**，只是换了个位置——那正是本分支第一条 commit 要修的毛病。
//   ✓ 呈现属性 fill= / stroke=（单双引号、%22/%27 编码引号、大小写、= 旁空格）
//   ✓ 内联 style="fill:...;stroke:..." 声明
//   ✓ opacity / fill-opacity / stroke-opacity（= 与 : 两种写法，编码引号同样归一）
//   ✓ 形状白名单：url( 大小写不限，值以 data: 开头就必须是 data:image/svg+xml, 明文
//   ✓ 内嵌 <style> 块直接拒（解码后才可靠地认得出它）
//   ✗ **不查 CSS 字符串引号是否配对**。把 url("...") 外层换成 ' 而内层属性仍用 '，
//     URI 会在第一个内部引号处提前截断。不堆这一条是因为那本就是非法 CSS：整条
//     background-image 会被丢弃、图标根本不渲染，不是可用的绕过路径。真实的引号
//     风格互换（外 ' + 内层属性全用 "）**是真通道**，已由 quote-aware 的 urlRe 拦住——
//     别把那段 urlRe 当多余复杂度删掉。
//   ✗ 不管元素外部的 CSS opacity（`.rs-search { opacity: .4 }` 这种整体降透明）。
//   ✗ 不解析 <style> 块内容（直接拒，不是能解析）。
//   ✗ 只看 wxss 里的 data URI；wxml 内联 style、js 拼出来的图标都不在范围内。
const SVG_COLOR_ALLOW = {
  '0F756E': { role: 'illustration', allowedIn: /^\.empty-icon-/,
    why: '品牌青绿。裁定允许它做非语义点缀，落点仅限空态插画描边（.empty-icon-*）' },
  '171717': { role: 'ui', why: 'neutral/900，主文字色' },
  '8B8B8B': { role: 'ui', surface: 'F5F5F5',
    why: 'text/faint（#171717 @50% 合成）。rs-chevron 与 rs-search 同用，两者都坐在 '
      + '--color-neutral-100 (#F5F5F5) 上，所以按 #F5F5F5 算而不是白底（3.13:1，不是 3.41:1）' },
  '6B7280': { role: 'illustration', allowedIn: /^\.thumb-camera\b/,
    why: '商品卡无图占位的相机角标，带 fill-opacity 0.5，合成约 #B5B9BF ≈ 1.97:1。'
      + '按 docs/ui-scale.md 的裁定它是占位插画、不是控件，故走豁免——不是「达标」' },
  '6F6F6F': { role: 'ui',
    why: 'text/muted（#171717 @62% 合成）。目前只有 PNG 侧的 tab 未选中图标用它，'
      + 'wxss 内联 SVG 尚无落点；预留登记，免得下次用到时又得重新论证一遍' }
}
// A3A3A3（neutral/400）**故意不在清单里**：白底 2.52:1，低于 3:1。
// 稿上 2026-09-02 已把它从搜索图标与 tab off 图标上撤掉。

function relLum(hex) {
  const ch = [0, 2, 4].map(function (i) {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
function contrast(hex, surface) {
  const a = relLum(hex) + 0.05
  const b = relLum(surface || 'FFFFFF') + 0.05
  return a > b ? a / b : b / a
}

// 自检：登记为 ui 的每个颜色都得真的过地板（在它自己声明的底色上）。
// illustration 明确跳过地板，但必须写明理由**并钉死落点**，不许空着混过去。
Object.keys(SVG_COLOR_ALLOW).forEach(function (hex) {
  const e = SVG_COLOR_ALLOW[hex]
  assert.ok(e.role === 'ui' || e.role === 'illustration', '#' + hex + ' 的 role 必须是 ui 或 illustration')
  assert.ok(e.why && e.why.length > 10, '#' + hex + ' 必须写明凭什么被登记')
  if (e.role === 'illustration') {
    assert.ok(e.allowedIn instanceof RegExp,
      '#' + hex + ' 登记为 illustration（豁免 3:1 地板）就必须用 allowedIn 钉死落点，'
        + '否则这是个无人看守的逃生舱：把任意坏色标成 illustration 就能用在真部件上')
    return
  }
  const c = contrast(hex, e.surface)
  assert.ok(c >= 3,
    '允许清单自相矛盾：#' + hex + ' 在 #' + (e.surface || 'FFFFFF') + ' 上只有 '
      + c.toFixed(2) + ':1，低于 3:1 地板，不该登记为 ui')
})

// 注释先剥掉再找边界（用等长空格替换，行号与下标全部不变）。
// 反过来「先找边界再剥注释」是坏的：lastIndexOf('}' | ';') 会落进注释内部，
// 剩下的注释尾巴没有配对的 /*，剥不掉就被拼进选择器——对 ui 色只是文案难看，
// 对 illustration 色是**误报**（选择器不以 . 开头，allowedIn 直接判红）。
function blankComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, function (m) {
    return m.replace(/[^\n]/g, ' ')
  })
}
// 取所在规则的选择器。prev 也要考虑上一个 '{'，否则 @media 包裹时会把
// `@media (...) { .rs-search` 整串当成选择器。
function selectorAt(clean, i) {
  const open = clean.lastIndexOf('{', i)
  if (open < 0) return '(顶层)'
  const prev = Math.max(
    clean.lastIndexOf('}', open),
    clean.lastIndexOf(';', open),
    open > 0 ? clean.lastIndexOf('{', open - 1) : -1,
    -1
  )
  return clean.slice(prev + 1, open).trim().replace(/\s+/g, ' ')
}
// 逗号分组要**逐段**匹配：`.empty-icon-products, .rs-search { }` 只要豁免选择器
// 排在前面，整串前缀匹配就会放行，等于把豁免色带到真部件上。
function everySegment(sel, re) {
  return sel.split(',').every(function (seg) { return re.test(seg.trim()) })
}

const svgBad = []
let svgUriSeen = 0
let svgColorSeen = 0
wxssFiles.forEach(function (file) {
  const src = fs.readFileSync(file, 'utf8')
  const clean = blankComments(src)
  // url( 大小写不限（CSS 函数名 ASCII 大小写不敏感）；引号内外三种形态分开收，
  // 带引号时值里可以有 ')'。
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi
  let u
  while ((u = urlRe.exec(clean)) !== null) {
    const raw = u[1] !== undefined ? u[1] : (u[2] !== undefined ? u[2] : u[3])
    if (!/^data:/i.test(raw)) continue          // 本地/远程资源不归这条管
    const where = path.relative(root, file) + ':' + clean.slice(0, u.index).split('\n').length
    const sel = selectorAt(clean, u.index)
    if (!/^data:image\/svg\+xml,/.test(raw)) {
      svgBad.push(where + '（' + sel + '）的 data URI 形状不在白名单里：「'
        + raw.slice(0, 40) + '…」\n    只接受 `data:image/svg+xml,` 开头的明文形式。'
        + 'base64 / ;utf8 / ;charset= 都能正常渲染，却会让这条 URI 里的颜色'
        + '从文本扫描里彻底消失——连「扫不到就报红」都兜不住，因为现存的还在、'
        + '隐身的那条不进计数。')
      continue
    }
    svgUriSeen += 1
    // **整段解码后再匹配**，而不是逐个补 %22 / %27 分支。encodeURIComponent()
    // 会把属性引号写成 %22，那是最常见的内联写法，逐条拉黑永远追不完。
    let uri
    try {
      uri = decodeURIComponent(raw)
    } catch (err) {
      svgBad.push(where + '（' + sel + '）的 data URI 无法 decodeURIComponent（'
        + err.message + '）——百分号编码写坏了，图标多半也渲染不出来')
      continue
    }
    if (/<\s*style/i.test(uri)) {
      svgBad.push(where + '（' + sel + '）的 SVG 里内嵌了 <style> 块——'
        + '本检查只解析呈现属性与 style="" 内联声明，内嵌样式表会绕过去。'
        + '请改用 fill= / stroke= 属性。')
      continue
    }
    const paints = []
    let m
    const attrRe = /\b(fill|stroke)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
    while ((m = attrRe.exec(uri)) !== null) {
      paints.push([m[1], m[2] !== undefined ? m[2] : m[3]])
    }
    const styleRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
    while ((m = styleRe.exec(uri)) !== null) {
      const decl = m[1] !== undefined ? m[1] : m[2]
      const dRe = /\b(fill|stroke)\s*:\s*([^;]+)/gi
      let d
      while ((d = dRe.exec(decl)) !== null) paints.push([d[1], d[2].trim()])
    }
    const roles = []
    paints.forEach(function (pv) {
      const val = pv[1]
      if (val === 'none') return
      svgColorSeen += 1
      // 解码之后 %23 已经还原成 #，所以这里认的是 #RRGGBB。
      const hit = /^#([0-9A-Fa-f]{6})$/.exec(val)
      if (!hit) {
        svgBad.push(where + '（' + sel + '）的 ' + pv[0] + ' 写成了 [' + val
          + ']——解码后只接受 none 或 #RRGGBB 六位。'
          + '（rgb() / 具名色 / 三位简写都能正常渲染，但会绕过这条检查，所以一律不收）')
        return
      }
      const hex = hit[1].toUpperCase()
      const e = SVG_COLOR_ALLOW[hex]
      if (!e) {
        svgBad.push(where + '（' + sel + '）用了未登记的 #' + hex
          + '（白底 ' + contrast(hex).toFixed(2) + ':1）')
        return
      }
      if (e.role === 'illustration' && !everySegment(sel, e.allowedIn)) {
        svgBad.push(where + ' 把豁免色 #' + hex + ' 用在了「' + sel + '」上——'
          + '它按 illustration 登记、不受 3:1 地板约束，落点因此被 ' + e.allowedIn
          + ' 钉死（逗号分组要每一段都匹配）。这里若是真部件，请改用登记为 ui 的颜色。')
        return
      }
      roles.push({ hex: hex, role: e.role })
    })
    // opacity 会把已登记的颜色静默拉到地板下面，所以 ui 件一律不许叠。
    // `=` 与 `:` 都算（属性写法与 style 内联写法）；引号已在解码时归一。
    const op = /(?:fill-|stroke-)?opacity\s*[=:]\s*["']?([0-9.]+)/i.exec(uri)
    if (op) {
      const uiOnes = roles.filter(function (r) { return r.role === 'ui' })
      if (uiOnes.length) {
        svgBad.push(where + '（' + sel + '）给 ui 件叠了 opacity=' + op[1] + '（涉及 '
          + uiOnes.map(function (r) { return '#' + r.hex }).join(' / ')
          + '）——登记的对比度是不带 opacity 的值，叠上去就静默掉到地板下了。'
          + '若这枚确实是装饰件，请在 SVG_COLOR_ALLOW 里按 illustration 登记并钉死落点')
      }
    }
  }
})
assert.strictEqual(
  svgBad.length,
  0,
  '内联 SVG 的颜色有问题：\n  ' + svgBad.join('\n  ')
)
// 扫不到东西就是假绿。注意这条**只兜得住「现存的被改瞎」，兜不住「新增一条隐身 URI」**
// ——后者由上面的形状白名单负责。两条各管一头，别指望其中一条包打。
assert.ok(
  svgUriSeen >= 8 && svgColorSeen >= 10,
  '内联 SVG 几乎没扫到（URI ' + svgUriSeen + ' 个、颜色 ' + svgColorSeen
    + ' 处）——写法变了的话这条断言是假绿的'
)

console.log('wxss/wxml static checks passed（' + wxssFiles.length + ' 个 wxss，'
  + wxmlFiles.length + ' 个 wxml）')
