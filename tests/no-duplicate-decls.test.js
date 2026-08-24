// 同一文件里第 0 列的重复顶层声明守卫。
//
// 缘起：真实发生过一次合并缝 —— 两侧各自给 tests/ui.test.js 加了一个 waitFor，
// 同名不同契约（一份委托 automator 原生 page.waitFor(target)，target 可以是
// 选择器 / 毫秒数 / 条件函数；另一份只吃选择器、内部走 page.$$(target)）。
// 函数声明提升让后面那份静默盖掉前面那份，27 个调用点里 8 处传的是条件函数，
// page.$$(函数) 序列化成空选择器，整轮 UI 测试第四步就断在
// querySelectorAll 'The provided selector is empty'。
// 当时 npm test 全绿：no-babel-helpers / no-client-cloud-db 都是文本级扫描，
// 对「同一文件里两个同名顶层声明」不可见；而 function 对 function、var 对
// function 这类重复在 JS 里合法，解析器不报错，只能靠守卫在合并前拦。
//
// 判据（零依赖的窄扫描，不是 AST —— 边界见文件末尾）：
//   本仓所有自己写的 JS，顶层声明一律写在第 0 列。据此逐行匹配
//     function NAME( / async function NAME(
//     const NAME = / let NAME = / var NAME =
//     class NAME
//   同一文件里同名出现 ≥2 次即报错。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

// 剥注释抄自 tests/no-client-cloud-db.test.js 的 stripComments —— 那边是脚本
// 不是模块（没有 module.exports），require 它会连整个测试再跑一遍，所以只能
// 抄而不是共享。唯一的差别：块注释换成等量空白而不是整段删掉（no-babel-helpers
// 里 stripNoise 的做法），因为本测试要报行号，先删换行会让后面的行号全漂。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (block) {
      return block.replace(/[^\n]/g, ' ')
    })
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const DECL_PATTERNS = [
  /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^class\s+([A-Za-z_$][\w$]*)/
]

// 只返回同名 ≥2 次的名字：[{ name, lines: [行号...] }]
function duplicateTopDecls(src) {
  const at = Object.create(null)
  stripComments(src).split('\n').forEach(function (line, idx) {
    for (let i = 0; i < DECL_PATTERNS.length; i++) {
      const hit = DECL_PATTERNS[i].exec(line)
      if (hit) {
        (at[hit[1]] || (at[hit[1]] = [])).push(idx + 1)
        break
      }
    }
  })
  return Object.keys(at).filter(function (name) {
    return at[name].length >= 2
  }).map(function (name) {
    return { name: name, lines: at[name] }
  })
}

function walkJs(dir, out) {
  if (!fs.existsSync(dir)) return
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    // 不是自己写的代码，不在判据的世界里
    if (entry.isDirectory()
      && (entry.name === 'node_modules' || entry.name === 'miniprogram_npm')) {
      return
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkJs(full, out)
      return
    }
    if (path.extname(entry.name) === '.js') out.push(full)
  })
}

// 扫描面：仓库里所有自己写的 .js（含本文件自己 —— 样本字符串都缩在引号后面，
// 不落在第 0 列，扫到自己也是绿的）。tests/ui.test.js 只读不 require，
// 在扫描面里也不会被 automator 依赖拖住。cloudfunctions 扫整个目录而不是只扫
// cloudfunctions/ledger：将来加第二个云函数目录也要在同一张网里，别等出了
// 合并缝才发现新目录没被扫。
const files = []
;['utils', 'cloudfunctions', 'tests', 'pages', 'components', 'scripts'].forEach(function (rel) {
  walkJs(path.join(root, rel), files)
})
const appJs = path.join(root, 'app.js')
if (fs.existsSync(appJs)) files.push(appJs)

const hits = []
files.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  duplicateTopDecls(fs.readFileSync(file, 'utf8')).forEach(function (dup) {
    hits.push(rel + '：顶层声明 ' + dup.name + ' 出现 ' + dup.lines.length + ' 次（'
      + dup.lines.join(' / ') + ' 行）—— 函数声明提升会让后面那份静默盖掉前面那份')
  })
})

assert.strictEqual(
  hits.length,
  0,
  '同一文件里的重复顶层声明（多半是合并缝）：\n' + hits.join('\n')
)

// ---------------------------------------------------------------------------
// 自检：正负样本。样本全部用「字符串数组 + join」内联 —— 样本行在本文件里
// 行首是引号或空格，不落在第 0 列，自检样本不会把本文件自己扫红。
// ---------------------------------------------------------------------------
function joinLines(lines) {
  return lines.join('\n')
}

// 正样本①：那次事故的原形 —— 两个第 0 列 async function waitFor
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'async function waitFor(page, target, label) {',
    '  return page.waitFor(target)',
    '}',
    'async function waitFor(page, target, label) {',
    '  return page.$$(target)',
    '}'
  ])),
  [{ name: 'waitFor', lines: [1, 4] }],
  '自检：两个第 0 列 async function waitFor 必须被抓（那次合并缝的原形）'
)
// 正样本②：const 形态的同名重复
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'const waitFor = function (page, target) {',
    '  return page.$$(target)',
    '}',
    'const waitFor = 1'
  ])),
  [{ name: 'waitFor', lines: [1, 4] }],
  '自检：const 形态的同名重复也要抓'
)
// 正样本③：function 和 var 混着同名，一样是覆盖
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'function waitFor(page, target) {}',
    'var waitFor = 1'
  ])),
  [{ name: 'waitFor', lines: [1, 2] }],
  '自检：function 和 var 混着同名也要抓'
)
// 负样本①：只有单个声明
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'function waitFor(page, target, label) {',
    '  return page.waitFor(target)',
    '}',
    'function other(page) {}'
  ])),
  [],
  '自检：单个声明不许被抓'
)
// 负样本②：字符串里含 function foo( —— 只出现一次，凑不成「同名 ≥2」
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'const help = `用法示例：',
    'function foo(x) {}`'
  ])),
  [],
  '自检：字符串里的单个出现不许被抓'
)

// ---------------------------------------------------------------------------
// 这条守卫挡得住什么、挡不住什么 —— 老实说清（窄扫描，不是 AST）：
//   挡得住：同一文件里第 0 列的同名顶层声明 ≥2 次（function / const / let /
//           var / class，混搭也算）。合并缝最容易造出来的就是这个形状。
//   挡不住（已知盲区 / 已知假阳性，不是意外）：
//     · 缩进过的嵌套同名声明 —— 不同作用域，合法，不是本守卫要管的；
//     · 模板字符串 / 普通字符串里恰好出现第 0 列 function foo( —— 只出现一次
//       不会被抓（负样本②），但配上文件里真的一份同名声明就会被当成重复：
//       stripComments 只剥注释不剥字符串，下面的钉子把这个已知假阳性演示
//       出来。不为了消它把规则放宽（比如要求两处形态一致、或给文件开白名单）
//       —— 误报看一眼行号就能排除，漏报就是再一次 waitFor；
//     · 动态赋值（obj[name] = fn）造成的覆盖；
//     · 字符串里的 /* 配上几行外的 */ —— 漏报方向：stripComments 只认注释不认
//       字符串，两个记号之间的真代码（闭合记号往往还在另一个字符串里）会被整段
//       抹成空白，正好盖住一份重复声明时那一份漏报。实测形状钉在文件末尾。本仓
//       当前吃不到真代码（写这条时清点过：剩下的裸 /* 都满足「同行有 */ 或全
//       文件无配对」）。哪天加了剥字符串，记得连这条和钉子一起翻；
//     · function* 生成器声明和解构声明（const {a} = ...）不在判据里。
// ---------------------------------------------------------------------------
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'function foo(x) {}',
    'const help = `用法示例：',
    'function foo(x) {}`'
  ])),
  [{ name: 'foo', lines: [1, 3] }],
  '自检（钉住已知假阳性）：字符串里第 0 列的一份 + 真声明一份确实会被抓'
    + ' —— 这是本守卫承认的误报，不是意外；哪天加了剥字符串，记得连这条一起翻'
)

// 已知漏报的钉子：字符串里的 /* 配上几行外的 */，中间的真代码（这里是第一份
// function foo）被 stripComments 整段抹掉，扫描器只看得见第二份 —— 不报是
// 当前行为；哪天加了剥字符串，这里会变红，提醒连上面边界声明那条一起翻。
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'const a = "/*"',
    'function foo(){}',
    'const b = "*/"',
    'function foo(){}'
  ])),
  [],
  '自检（钉住已知漏报）：字符串里的 /* 配上几行外的 */，两份 function foo '
    + '被抹掉一份 —— 这是本守卫承认的盲区，不是意外'
)

// 已知漏报的钉子（二）：**行注释**里的 /* 配上几行外的 */。
// 机制和上一条一样（stripComments 先剥块注释、后剥行注释，所以行注释里的 /*
// 在第一轮就能和后面真块注释的 */ 配对），但**入口不同，修法也不同**：
// 上一条加一道「剥字符串」就好了，这一条剥字符串**修不好**——得改成先剥行注释再剥块注释，
// 而那样又会把块注释里的 // 弄错。两条分开钉，别以为修了一条另一条也好了。
//
// **光有行注释里的 /* 不会出问题**（块注释正则要求闭合 */），
// 必须后面还有一个真实块注释的 */ 来配对——触发条件比「行注释里写了 /*」窄得多，
// 这个用例就是按实测的触发条件写的。
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    '// 说明一下：块注释是 /* 开头的',
    'function foo(){}',
    '/* 这是一个真的块注释 */',
    'function foo(){}'
  ])),
  [],
  '自检（钉住已知漏报）：行注释里的 /* 配上后面块注释的 */，'
    + '中间那份 function foo 被抹掉 —— 本守卫承认的盲区'
)

// 已知漏报的钉子（三）：`const NAME` 换行之后才有 `=`。
// DECL_PATTERNS 里那条 /^(?:const|let|var)\s+NAME\s*=/ 要求 `=` 和名字**在同一行**，
// 所以换行写的声明根本不被当成声明。这和上面两条不是同一回事：
// 那两条是剥注释抹多了，这一条是正则本身看不见。本仓当前没有这么写的代码，
// 但 prettier 在长初始化表达式上会换出这种形状，写在这里免得下一个人以为守卫盖得住。
assert.deepStrictEqual(
  duplicateTopDecls(joinLines([
    'const NAME',
    '  = 1',
    'const NAME',
    '  = 2'
  ])),
  [],
  '自检（钉住已知漏报）：`const NAME` 换行后才有 `=`，'
    + '正则压根不当它是声明 —— 本守卫承认的盲区'
)

console.log('no-duplicate-decls: ' + files.length + ' files ok')
