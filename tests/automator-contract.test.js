// miniprogram-automator 的行为契约 + 页面 pageLoading 字段的契约。
//
// 缘起：tests/ui.test.js 的等待逻辑全部建立在几条「automator 到底怎么等」的事实上，
// 而这些事实以前只活在口口相传里，排查时被猜错过两次：
//   · 猜「navigateBack() 返回就等于退栈完成」——> 其实那 3 秒是固定 sleep、不是完成信号；
//     反过来，早先给它包轮询时又把**基准取在了 navigateBack 之后**（那时栈往往已经变浅），
//     于是拿变浅后的值去等「比这更浅」，永远等不到而挂死。教训是「基准取晚了」，
//     **不是「不该包等待」** —— 现在 tests/ui.test.js 的 goBackTo 正是包了等待的，
//     基准取在 navigateBack 之前，详见那个函数上方的长注释；
//   · 猜「page.waitFor(800) 是在等这个页面」——> 其实就是 sleep(800)，跟页面无关；
//   · 猜「等页面加载完成超时 = 页面没加载完」——> 其实是那个页面根本没有 pageLoading 字段。
// 所以把这几条从经验变成 npm test 里会红的断言。**红了不代表本仓有 bug**，
// 多半是 automator 升级或页面改了字段：每条断言下面都写了红了之后该改哪里。
//
// 判据是静态读源码，不是实测耗时 —— 不受机器快慢影响，也不需要开发者工具。
// automator 的 out/*.js 是压缩过的，所以匹配的是压缩后的形状；升级后形状变了就会红，
// 那正是需要有人重新读一遍源码的时候。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const automatorVersion = require('miniprogram-automator/package.json').version
const miniProgramSrc = fs.readFileSync(require.resolve('miniprogram-automator/out/MiniProgram'), 'utf8')
const pageSrc = fs.readFileSync(require.resolve('miniprogram-automator/out/Page'), 'utf8')

const why = '（automator ' + automatorVersion + '）'

// 从 src 里 needle 处开始，按大括号配平截出一段。压缩代码里字符串含大括号会骗到它，
// 但下面截的这几段实测不含，骗到了也是红 —— 红了就该有人重新读源码，正合本文件的用意。
function braceBlock(src, needle) {
  const at = src.indexOf(needle)
  assert.ok(at >= 0, '在源码里找不到 ' + JSON.stringify(needle) + ' ' + why)
  const open = src.indexOf('{', at + needle.length - 1)
  assert.ok(open >= 0, JSON.stringify(needle) + ' 后面没有函数体 ' + why)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(JSON.stringify(needle) + ' 的大括号没配平 ' + why)
}

// ---------------------------------------------------------------------------
// F1：五个路由方法全都委托给 changeRoute，而 changeRoute 自带 3 秒硬等待。
//     out/MiniProgram.js:
//       async changeRoute(t,e){const i=await this.currentPage();...
//         await this.callWxMethod(t,{url:e});return await sleep(3e3),await this.currentPage()}
//     所以 miniProgram.navigateTo/redirectTo/navigateBack/reLaunch/switchTab
//     **不是发令不等**：每次固定至少 3 秒，返回值是 3 秒之后的当前页。
//
// 注意这 3 秒是**固定睡眠，不是完成信号**：睡够就返回，不管跳转成没成。所以
// tests/ui.test.js 不信这些方法的返回值，一律过 goto / goBackTo 自己确认到位。
// 这条红了 = 路由方法连这 3 秒兜底都没有了，那时 goto / goBackTo 的等待窗口要重新评估
// （它们各自的 deadline 是按「3 秒之后才开始轮询」这个前提定的）。
// ---------------------------------------------------------------------------
const changeRouteBody = braceBlock(miniProgramSrc, 'async changeRoute(')

assert.ok(
  /sleep\(3e3\)|sleep\(3000\)/.test(changeRouteBody),
  'changeRoute 里找不到 sleep(3000) —— 路由方法可能不再自带 3 秒等待了 ' + why
    + '。tests/ui.test.js 里「navigateBack 不用再包轮询」的前提就靠这一条，'
    + '请重新读一遍 out/MiniProgram.js#changeRoute 再决定怎么等。\n实际函数体：' + changeRouteBody
)

assert.ok(
  /await this\.callWxMethod\(\w+,\{url:\w+\}\)/.test(changeRouteBody),
  'changeRoute 里找不到下发 wx 方法那一句 ' + why + '，形状变了，请重新读源码。\n实际函数体：' + changeRouteBody
)

;['navigateTo', 'redirectTo', 'navigateBack', 'reLaunch', 'switchTab'].forEach(function (name) {
  const re = new RegExp('async ' + name + '\\([^)]*\\)\\{return await this\\.changeRoute\\("' + name + '"')
  assert.ok(
    re.test(miniProgramSrc),
    'MiniProgram.' + name + ' 不再是直接委托给 changeRoute 了 ' + why
      + '，它自带 3 秒等待这条结论对它可能不再成立，请重新读源码'
  )
})

// ---------------------------------------------------------------------------
// F2：Page 对象有一层永不失效的 pageMap 缓存，Page.path 是创建时的快照。
//     out/Page.js:
//       static create(t,e,a){if(a.get(e.id))return a.get(e.id);const i=new Page(t,e);return a.set(e.id,i),i}
//     构造函数里 this.path 只赋值一次，全文件再没有第二处更新它。
//     currentPage() / pageStack() 返回的都是过这层缓存的对象，pageMap 挂在
//     MiniProgram 实例上、整轮测试期间从不清理；小程序的 pageId 页面销毁后会复用。
//
// 这条红了（缓存没了 / path 会自己更新）= tests/ui.test.js 的 waitForPage 里
// 那段「删掉 pageMap 这一条再重建」的代码可以拿掉，路径判定也可以改回信 page.path。
// ---------------------------------------------------------------------------
assert.ok(
  /static create\([^)]*\)\{if\((\w+)\.get\((\w+)\.id\)\)return \1\.get\(\2\.id\)/.test(pageSrc),
  'Page.create 里那句「命中 pageMap 就直接返回旧对象」不见了 ' + why
    + ' —— tests/ui.test.js 里删缓存重建那段可以重新评估了'
)

assert.ok(
  /this\.path=\w+\.path/.test(braceBlock(pageSrc, 'class Page{constructor(')),
  'Page 构造函数里找不到 this.path=e.path ' + why + '，形状变了，请重新读源码'
)

assert.strictEqual(
  (pageSrc.match(/this\.path=/g) || []).length,
  2,
  'out/Page.js 里 this.path 的赋值处不再是 2 处（构造函数里的 ""  初始化 + 实参赋值）' + why
    + ' —— 多出来的那处可能是「path 会自己更新」，那样 waitForPage 里防 pageMap 陈旧的那段就多余了'
)

// ---------------------------------------------------------------------------
// F4：page.waitFor(数字) 就是 sleep(数字)，跟页面毫无关系。
//     out/Page.js: async waitFor(t){isNum(t)?await sleep(t):isFn(t)?await waitUntil(t):...}
//     写成 page.waitFor 只是让它看起来像在等这个页面 —— 这是最容易读错的地方，
//     tests/ui.test.js 里 4 处「等跳转」曾经就是这么写的。
//
// 这条红了 = 数字参数有了新语义，tests/ui.test.js 里保留的那处 200 毫秒等待要重看。
// ---------------------------------------------------------------------------
assert.ok(
  /async waitFor\((\w+)\)\{isNum_1\.default\(\1\)\?await sleep_1\.default\(\1\)/.test(pageSrc),
  'page.waitFor 对数字参数不再是直接 sleep 了 ' + why + '，请重新读源码'
)

// ---------------------------------------------------------------------------
// F5：哪些页面的 data 里有 pageLoading。
//     tests/ui.test.js 的 waitPageReady 判据是 data.pageLoading === false。
//     对没有这个字段的页面，undefined === false 恒为 false，会一路轮询到单步超时，
//     然后报一句「等『页面加载完成 pages/xxx』超时（30 秒）」——
//     跟真实原因（上一步没走到预期的页面）毫无关系，排查被它带偏过一次。
//     所以 waitPageReady 现在先探一次字段在不在，不在就直说是用错了地方。
//
// 下面这两张名单红了 = 页面侧加了/删了这个字段：
//   · NO_PAGE_LOADING 里某个页面加上了 —— 可以放宽 waitPageReady 的守卫，也可以
//     开始对那个页面用 waitPageReady；
//   · HAS_PAGE_LOADING 里某个页面删掉了 —— 现有 waitPageReady 调用点会开始假报错，
//     必须同步改调用点。
// 判据是「data: {...} 这个块里出现 pageLoading」——文本级，不是 AST。
// ---------------------------------------------------------------------------
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (block) { return block.replace(/[^\n]/g, ' ') })
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function dataBlock(rel) {
  const full = path.join(root, rel)
  assert.ok(fs.existsSync(full), '页面不存在了：' + rel)
  const src = stripComments(fs.readFileSync(full, 'utf8'))
  const at = src.indexOf('\n  data: {')
  assert.ok(at >= 0, rel + ' 里找不到顶层的 data: { 块（页面写法变了，本测试的判据要跟着改）')
  return braceBlock(src.slice(at), 'data: {')
}

const HAS_PAGE_LOADING = [
  'pages/index/index.js',
  'pages/customers/customers.js',
  'pages/shop/shop.js',
  'pages/sale/sale.js',
  // 2026-08-31 这一批新进 tests/ui.test.js 的落点，都调了 waitPageReady
  'pages/purchase/purchase.js',
  'pages/products/products.js',
  'pages/product-detail/product-detail.js',
  'pages/members/members.js'
]

// tests/ui.test.js 现在不对这几个页面调 waitPageReady —— 调了就会撞上那句假报错。
const NO_PAGE_LOADING = [
  'pages/record-edit/record-edit.js',
  'pages/customer-edit/customer-edit.js',
  'pages/records/records.js',
  // 同一批新进的落点，但**没有**这个字段：用例里一律等各自的业务字段
  //（如 adjust 等 productId、sale-return 等 lines.length）
  'pages/adjust/adjust.js',
  'pages/convert/convert.js',
  'pages/sale-return/sale-return.js',
  'pages/product-edit/product-edit.js',
  'pages/categories/categories.js',
  'pages/category-edit/category-edit.js'
]

HAS_PAGE_LOADING.forEach(function (rel) {
  assert.ok(
    dataBlock(rel).indexOf('pageLoading') >= 0,
    rel + ' 的 data 里没有 pageLoading 了 —— tests/ui.test.js 里对它调 waitPageReady 的地方'
      + '会开始报「等『页面加载完成』超时」这种假原因，请同步改调用点'
  )
})

NO_PAGE_LOADING.forEach(function (rel) {
  assert.ok(
    dataBlock(rel).indexOf('pageLoading') < 0,
    rel + ' 的 data 里加上 pageLoading 了 —— tests/ui.test.js 的 waitPageReady 守卫可以放宽，'
      + '这个页面也可以开始用 waitPageReady 等加载完成了'
  )
})

// 自检（钉住判据本身）：dataBlock 截的确实是 data 块、不是整个文件。
// index.js 的 onShow 里也 setData 了 pageLoading，如果截错成整文件，
// 下面这条「data 块里没有 setData」就会红。
assert.ok(
  dataBlock('pages/index/index.js').indexOf('setData') < 0,
  '自检：dataBlock 截出来的不该包含 setData —— 大括号配平截错了，上面几条断言的结论都不作数'
)

console.log('automator-contract: automator ' + automatorVersion + ' 行为契约 + '
  + (HAS_PAGE_LOADING.length + NO_PAGE_LOADING.length) + ' 个页面的 pageLoading 名单 ok')
