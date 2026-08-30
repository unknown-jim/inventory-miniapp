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

console.log('wxss/wxml static checks passed（' + wxssFiles.length + ' 个 wxss，'
  + wxmlFiles.length + ' 个 wxml）')
