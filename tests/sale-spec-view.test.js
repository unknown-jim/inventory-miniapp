const assert = require('assert')
const fs = require('fs')
const path = require('path')
const inv = require('../utils/inventory')
const util = require('../utils/util')
const { saleSpecOptions, blankShortOf } = require('../utils/sale-spec-view')

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'id-' + n
  }
}

function pageMethod(src, name) {
  const re = new RegExp('\\n  (async )?' + name + '\\([^)]*\\) \\{')
  const match = re.exec(src)
  assert.ok(match, 'missing method ' + name)
  let i = match.index + match[0].length
  let depth = 1
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') depth -= 1
    i += 1
  }
  return src.slice(match.index, i)
}

function makeReady() {
  const product = inv.createProduct({
    name: '短袖',
    costPrice: 28,
    salePrice: 59,
    stock: 0,
    alertQty: 4,
    colors: ['黑色', '白色'],
    sizes: ['M', 'L']
  }, 1000, 'p-ready')
  return inv.applyProductSkus(product, [], [
    { color: '黑色', size: 'M', stock: 6, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '黑色', size: 'L', stock: 2, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'M', stock: 8, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'L', stock: 5, costPrice: 28, salePrice: 59, alertQty: 4 }
  ], 1100, idFactory())
}

function makeBlank() {
  const product = inv.createProduct({
    name: '卫衣',
    costPrice: 45,
    salePrice: 99,
    stock: 20,
    alertQty: 5,
    colors: ['黑色', '白色'],
    sizes: ['M', 'L'],
    blankProcess: true
  }, 1000, 'p-blank')
  return inv.applyProductSkus(product, [], null, 1100, idFactory())
}

function sizeStock(options, size) {
  const found = options.sizeOptions.find(function (item) {
    return item.value === size
  })
  return found ? found.stock : null
}

// selectedSizes 现在是选中集合（数组），不是单值——签名变更同步这里的既有调用。
const ready = makeReady()
const blackM = inv.findSkuBySpec(ready.skus, ready.product.id, '黑色', 'M')
const before = saleSpecOptions(ready.product, ready.skus, '黑色', ['M'], [])
assert.strictEqual(sizeStock(before, 'M'), 6)
assert.strictEqual(sizeStock(before, 'L'), 2)
assert.strictEqual(before.sizeOptions[0].low, false)
assert.strictEqual(before.sizeOptions[1].low, true)

const afterCart = saleSpecOptions(ready.product, ready.skus, '黑色', ['M'], [
  { productId: ready.product.id, skuId: blackM.id, color: '黑色', size: 'M', qty: 1 }
])
assert.strictEqual(sizeStock(afterCart, 'M'), 5)
assert.strictEqual(sizeStock(afterCart, 'L'), 2)
assert.strictEqual(afterCart.sizeOptions[0].low, false)

const afterLow = saleSpecOptions(ready.product, ready.skus, '黑色', ['M'], [
  { productId: ready.product.id, skuId: blackM.id, color: '黑色', size: 'M', qty: 2 }
])
assert.strictEqual(sizeStock(afterLow, 'M'), 4)
assert.strictEqual(afterLow.sizeOptions[0].low, true)

const blank = makeBlank()
const blankReady = inv.findSkuBySpec(blank.skus, blank.product.id, '黑色', 'M')
const blankBefore = saleSpecOptions(blank.product, blank.skus, '黑色', ['M'], [])
assert.strictEqual(sizeStock(blankBefore, 'M'), 20)
assert.strictEqual(sizeStock(blankBefore, 'L'), 20)

const blankAfter = saleSpecOptions(blank.product, blank.skus, '黑色', ['M'], [
  { productId: blank.product.id, skuId: blankReady.id, color: '黑色', size: 'M', qty: 4 }
])
assert.strictEqual(sizeStock(blankAfter, 'M'), 16)
assert.strictEqual(sizeStock(blankAfter, 'L'), 16)

// 多选 on 判定：selectedSizes 传两个值时，两个都要判 on=true；只传一个时另一个 on=false。
const multiOn = saleSpecOptions(ready.product, ready.skus, '黑色', ['M', 'L'], [])
assert.strictEqual(multiOn.sizeOptions[0].on, true, 'M 应当在选中集合里')
assert.strictEqual(multiOn.sizeOptions[1].on, true, 'L 应当在选中集合里')
const singleOn = saleSpecOptions(ready.product, ready.skus, '黑色', ['M'], [])
assert.strictEqual(singleOn.sizeOptions[0].on, true)
assert.strictEqual(singleOn.sizeOptions[1].on, false)
const noneOn = saleSpecOptions(ready.product, ready.skus, '黑色', [], [])
assert.strictEqual(noneOn.sizeOptions[0].on, false)
assert.strictEqual(noneOn.sizeOptions[1].on, false)

// 裁定 B：非待加工商品的 ready 就是 stock 本身（逐格 hint 用它，不看待加工池）。
assert.strictEqual(before.sizeOptions[0].ready, before.sizeOptions[0].stock)

// blankShortOf：H5 的三种池态。fixture 用 makeBlank()（全新待加工商品，全部 20 件都在
// 半成品池里，任何格现货都是 0），再手工把 黑色/M 现货改成 5（模拟一次退货），
// 让「现货够 / 不够但池补得全 / 池补不全」三种情况都能用干净的数字表达。
const blankFixture = makeBlank()
const blackMReadySku = inv.findSkuBySpec(blankFixture.skus, blankFixture.product.id, '黑色', 'M')
blackMReadySku.stock = 5

// P1：现货都够（黑色/M 现货 5、要 5；黑色/L 现货 0、要 0），短缺应为 0。
const p1Lines = [
  { color: '黑色', size: 'M', qty: 5 },
  { color: '黑色', size: 'L', qty: 0 }
]
assert.strictEqual(blankShortOf(blankFixture.product, blankFixture.skus, p1Lines, []), 0)

// P2：黑色/M 要 8（现货 5，短 3），黑色/L 要 10（现货 0，短 10），合计短缺 13；
// 池仍有 20 件待加工，13 <= 20，池补得全（H5：两格短缺各自独立求和，不做跨行滚动累积）。
const p2Lines = [
  { color: '黑色', size: 'M', qty: 8 },
  { color: '黑色', size: 'L', qty: 10 }
]
const p2Short = blankShortOf(blankFixture.product, blankFixture.skus, p2Lines, [])
assert.strictEqual(p2Short, 13)
const p2Pool = inv.blankAvailability(blankFixture.product, blankFixture.skus, '', '', []).blank
assert.ok(p2Short <= p2Pool, 'P2 前提：短缺应当补得进池子（实为短缺 ' + p2Short + '，池 ' + p2Pool + '）')

// P3：黑色/M 要 8（短 3），黑色/L 要 30（短 30），合计短缺 33 > 池 20，补不全。
const p3Lines = [
  { color: '黑色', size: 'M', qty: 8 },
  { color: '黑色', size: 'L', qty: 30 }
]
const p3Short = blankShortOf(blankFixture.product, blankFixture.skus, p3Lines, [])
assert.strictEqual(p3Short, 33)
const p3Pool = inv.blankAvailability(blankFixture.product, blankFixture.skus, '', '', []).blank
assert.ok(p3Short > p3Pool, 'P3 前提：短缺应当补不进池子（实为短缺 ' + p3Short + '，池 ' + p3Pool + '）')

// P4「先短后余」：H5 那句「两格短缺各自独立求和，不做跨行滚动累积」**只有这一组
// 夹具能检验**。P1/P2/P3 三组里没有一格现货有富余，于是「逐格 max(0, qty−ready) 求和」
// 和「跨行滚动累积（后面格的富余去抵前面格的短缺）」给出完全相同的数，改成滚动累积
// 三条断言照绿——那是这条约束此前从未被真正检验的原因。
//
// 这一组把有富余的格排在短缺格**之后**：
//   黑色/M 现货 0、要 10 → 短 10
//   黑色/L 现货 8、要  5 → 富余 3，独立求和不许拿它去抵前面那 10
// 独立求和 = 10；滚动累积 = (10−0) + (5−8) = 7。两者第一次分得开。
const rollFixture = makeBlank()
inv.findSkuBySpec(rollFixture.skus, rollFixture.product.id, '黑色', 'L').stock = 8
const p4Lines = [
  { color: '黑色', size: 'M', qty: 10 },
  { color: '黑色', size: 'L', qty: 5 }
]
// 前提先钉死，免得夹具哪天被改成「两格都短缺」又变回分不开的样子
assert.strictEqual(
  inv.blankAvailability(rollFixture.product, rollFixture.skus, '黑色', 'M', []).ready, 0,
  'P4 前提：黑色/M 现货必须是 0（短缺格）')
assert.strictEqual(
  inv.blankAvailability(rollFixture.product, rollFixture.skus, '黑色', 'L', []).ready, 8,
  'P4 前提：黑色/L 现货必须是 8，且要的 5 比它少（富余格，排在短缺格之后）')
assert.strictEqual(
  blankShortOf(rollFixture.product, rollFixture.skus, p4Lines, []), 10,
  'H5：两格短缺各自独立求和，只有黑色/M 那 10 件要从半成品池扣；'
  + '黑色/L 富余的 3 件不许去抵前面那一格（跨行滚动累积会算成 7）')

// H3 第二道守卫：非待加工商品直接返回 0，即使传进去的数量再大。
assert.strictEqual(
  blankShortOf(ready.product, ready.skus, [{ color: '黑色', size: 'M', qty: 999 }], []),
  0
)

const saleJs = fs.readFileSync(path.join(__dirname, '../pages/sale/sale.js'), 'utf8')
;['addCart', 'removeCart', 'submit'].forEach(function (name) {
  const body = pageMethod(saleJs, name)
  assert.ok(body.indexOf('stockPatch') >= 0, name + ' should refresh size chips via stockPatch')
})

// H1：submit() 是 currentLines / mergeLines 的第三个调用点。这两个方法改名之后，最容易
// 悄悄留下对旧名 currentLine() / mergeLine() 的悬空调用——npm test 抓不到运行期
// ReferenceError，只能靠这条静态钉子在方法体文本里直接核对调用的是新名字。
const submitBody = pageMethod(saleJs, 'submit')
assert.ok(submitBody.indexOf('this.currentLines(') >= 0, 'submit 应当调用 currentLines()')
assert.ok(submitBody.indexOf('this.mergeLines(') >= 0, 'submit 应当调用 mergeLines()')
// 注意：'this.mergeLines('.indexOf('this.mergeLine(') 也是 0——不能用 indexOf 判"没有
// 调用旧名"，"mergeLines(" 本身就以 "mergeLine(" 开头。用负向前瞻只匹配"后面不跟 s"的旧名。
assert.ok(!/this\.currentLine(?!s)\(/.test(submitBody), 'submit 不应再调用已改名的 currentLine()')
assert.ok(!/this\.mergeLine(?!s)\(/.test(submitBody), 'submit 不应再调用已改名的 mergeLine()')

// H2 钉子：本行金额无条件从「当前输入」算，位置在任何早退之前，单选形态直接读
// data.qty × data.unitPrice。2026-09-02 那版把两种形态合并成一次「对 currentLines()
// 的 lines 求和」——位置确实还在早退之前，但来源错了：currentLines 在「有规格但还没
// 选全」时返回 { lines: [], error }，空数组求和恒为 0，屏上的本行金额从 50.00 掉回
// 0.00（H2 举的正是这一格）。npm test 里没有能实例化销售页的地方，抓不到运行期的值，
// 只能钉住写法：金额语句要排在第一条 `return patch` 前面，且单选那支要出现 data.qty。
const linePatchBody = pageMethod(saleJs, 'linePatch')
const amountAt = linePatchBody.indexOf('lineAmountText:')
const firstReturnAt = linePatchBody.indexOf('return patch')
assert.ok(amountAt >= 0, 'linePatch 里找不到 lineAmountText 的赋值')
assert.ok(
  firstReturnAt < 0 || amountAt < firstReturnAt,
  'H2：lineAmountText 必须在 linePatch 的任何早退之前算好，否则没选全规格 / 校验没过时'
    + '屏上的金额会清零'
)
assert.ok(
  linePatchBody.indexOf('inventory.toNumber(this.data.qty)') >= 0,
  'H2：单选形态的本行金额必须直接读 data.qty × data.unitPrice（baseline 840408b 逐字'
    + '就是 util.money(qty * price)），不能从 currentLines() 的 lines 求和——lines 在'
    + '「有规格但还没选全」时是空数组，求和恒为 0'
)

// selectedSizes / multiMode 单一写入点钉子。2026-09-02 的真实回归：pickSize 的
// applySizeSelection 只把新集合写进 selectedSizes，忘了同步 multiMode（它是
// selectedSizes.length >= 2 的纯派生量，不是独立状态）——UI 上表现为点第二枚规格二
// chip 之后 selectedSizes 已经变成 2 个了，卡却死活切不到多选形态，因为 wxml 分支
// 判的是 multiMode。npm test 那二十几项一个都碰不到 wxml 分支切换，这个 bug 跑满
// 25 分钟的 tests/ui.test.js 才暴露。
//
// 事后把三处写入点（applyProductState / pickAllSizes 的 T7 分支 / applySizeSelection）
// 收敛成同一个 sale.js 方法 sizeSelectionPatch(nextSizes)，返回
// { selectedSizes, multiMode } 一整个 patch，三处只准调它、不许再各自手写字面量。
// 这条钉子守的就是这条收敛：pages/sale/sale.js 里字面量 key "selectedSizes:" 和
// "multiMode:" 除了 data{} 初始值那一份，只准在 sizeSelectionPatch 自己的 return
// 里各出现一次——各恰好 2 次。红了说明又有地方绕开 sizeSelectionPatch 手写了这两个
// key 中的一个，多半就是同一类"写了集合、漏了派生量"的回归。
function stripCommentsForMultiModePin(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (block) {
      return block.replace(/[^\n]/g, ' ')
    })
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
const saleJsNoCommentsForMultiModePin = stripCommentsForMultiModePin(saleJs)
// (?<!\.) 排掉 "this.data.selectedSizes : []" 这类三元表达式——那个冒号是
// 三元运算符的一部分，不是对象字面量的 key，不能算进「写入点」。
const selectedSizesKeyCount = (saleJsNoCommentsForMultiModePin.match(/(?<!\.)selectedSizes\s*:/g) || []).length
const multiModeKeyCount = (saleJsNoCommentsForMultiModePin.match(/multiMode\s*:/g) || []).length
assert.strictEqual(
  selectedSizesKeyCount,
  2,
  '字面量 "selectedSizes:" 应当恰好出现 2 次（data{} 初始值 + sizeSelectionPatch 的 return），'
    + '实为 ' + selectedSizesKeyCount + ' 次——多出来的多半是有地方绕开 sizeSelectionPatch 直接写了'
    + ' selectedSizes，很可能又漏了同步 multiMode'
)
assert.strictEqual(
  multiModeKeyCount,
  2,
  '字面量 "multiMode:" 应当恰好出现 2 次（data{} 初始值 + sizeSelectionPatch 的 return），'
    + '实为 ' + multiModeKeyCount + ' 次——同上一条，数目对不上就要看是不是又有地方绕开了'
    + ' sizeSelectionPatch'
)
// cellRows / cellQtys 的两条同族钉子。multiMode 那条钉子只管"selectedSizes 和"
// multiMode 是不是一起写"——cellRows 和 cellQtys 是另外两个从 selectedSizes 派生
// 出来的东西，但都需要 selectedSizes 之外的输入（sizeOptions / 已有草稿），够不上
// sizeSelectionPatch(nextSizes) 那个只吃一个参数的窄契约，所以没有塞进同一个
// helper，而是各自在真正出问题的地方补的：
//   cellRows 那次的病灶不是"漏写字段"，是"漏写的地方在错误的位置"——
//   算 cellRows 的逻辑曾经挂在 linePatch 里 "if (!lines.length) return" 的
//   后面，选中两格但还没填数量时 lines 是空的，cellRows 永远生不出来，用户连
//   输入框都看不到。改法是把它挪进 stockPatch（跟 stockText / sizeOptions 一样，
//   每次拼 spec 状态都无条件重算，没有任何早退能绕开）。这条钉子只保证接线还在：
//   stockPatch 的方法体必须调用 buildCellRows。
const stockPatchBody = pageMethod(saleJs, 'stockPatch')
assert.ok(
  stockPatchBody.indexOf('this.buildCellRows(') >= 0,
  'stockPatch 应当调用 buildCellRows——cellRows 的形状（选中了哪几格）必须跟着'
    + ' stockText / sizeOptions 无条件重算，不能被塞回某条 lines.length 才会走到的'
    + ' 分支后面，否则选中格但还没填数量时用户会看不到输入框'
)

// cellQtys 那次的病灶：applySizeSelection 只处理了"被移除的格删 key"和"进入多选
// 时把原数量框的值搬给 firstSize"，新选中的格（非 firstSize 的那些，比如全选一次
// 带出的第三、第四格）从来没建过 key。留空（状态机 T4）指的是这一格的值是空串，
// 不是这一格压根不存在——真出事时不会崩，因为 buildCellRows 拿 undefined 也当空串
// 显示，但少了 key 这件事本身就说明 selectedSizes 和 cellQtys 没对齐，谁在这两者
// 之间的假设上多走一步都可能出岔子。这条钉子只保证补齐逻辑还在：
const applySizeSelectionBody = pageMethod(saleJs, 'applySizeSelection')
assert.ok(
  applySizeSelectionBody.indexOf('cellQtys[cellKey(size)] == null') >= 0
    && applySizeSelectionBody.indexOf("cellQtys[cellKey(size)] = ''") >= 0,
  'applySizeSelection 应当把 nextSizes 里还没有 key 的格补成空串——少了这一步，'
    + '新选中的格在 cellQtys 里会完全没有条目，跟 selectedSizes 的假设对不齐'
)
// cellQtys 的下标必须一律走 cellKey()——站点完整性钉子（2026-09-03）。
//
// 规格取值是店主自由输入的（docs/blank-process.md），直接拿它当对象 key 会撞上
// Object.prototype 上的名字：叫 constructor / toString / valueOf 的取值读出来是函数，
// 数量框里显示 "function Object() { [native code] }"；叫 __proto__ 的那一格连数量都
// 存不进去（赋字符串给 __proto__ 被静默忽略）。cellKey 加固定前缀把两者隔开。
//
// 这条钉子防的不是那个 bug 本身，而是**站点完整性**：cellQtys 有 8 个读写点，下一个人
// 加第 9 个时忘了加前缀，不会崩、不会报错，只会静默读到 undefined——表现和它要修的
// 症状几乎一样（那一格的数量悄悄丢了）。本仓在「一个字段改多点位、漏掉一处、审计
// 第二轮才找出来」上栽过，见记忆 sku-vs-barcode-levels。
//
// 复用上面那个剥注释器：注释里提到 cellQtys[...] 不算违规。
// 两条正则先各自过一道**阳性对照**：拿它去 match 一个已知违规的字面串，
// 必须至少命中 1 次。不加这道的话，正则被改坏（或者 cellQtys 改了名）之后
// 两条断言会**静默变成恒真**——实测：把正则写成 cellQtysZZZ 并真留一处裸用，
// `npm test` EXIT=0、零个 AssertionError。（2026-09-03 审计提的；这正是本仓反复栓的
// 那个形态：钉子还在，守的东西没了。）
const SALE_SITE_RE = /cellQtys\s*\[\s*(?!cellKey\s*\()/g
const UI_SITE_RE = /cellQtys\s*\[\s*(?!'v:'|"v:")/g
assert.ok(
  ('cellQtys[size]'.match(SALE_SITE_RE) || []).length >= 1,
  '阳性对照：sale.js 那条站点正则应当能认出 `cellQtys[size]` 这种裸用。'
    + '认不出就说明正则被改坏了，下面那条 === 0 是恒真的假绿'
)
assert.ok(
  ('cellQtys[size]'.match(UI_SITE_RE) || []).length >= 1,
  '阳性对照：ui.test.js 那条站点正则应当能认出 `cellQtys[size]` 这种裸用'
)
assert.strictEqual(
  ('cellQtys[cellKey(size)]'.match(SALE_SITE_RE) || []).length, 0,
  '阳性对照：合规写法不得被误判为裸用'
)
const bareCellQtyAccess = saleJsNoCommentsForMultiModePin.match(SALE_SITE_RE) || []

// 同一条站点完整性也要盖到 tests/ui.test.js——**站点清单的边界不等于实现文件的边界**。
// 2026-09-03 实例：前缀那一批枚举站点时，另一条线的 PR 还没合入，
// 它带进来的 UI 断言直接读 `cellQtys[<size>]`。两边各自都绿，合到一起才红（
// `'undefined' !== '2'`）——而且只有完整 UI 轮能抳到，`npm test` 看不见。
// 所以这条钉子放在纯 Node 套件里，让下一次漏写在 `npm test` 就红。
const uiTestSrc = fs.readFileSync(path.join(__dirname, 'ui.test.js'), 'utf8')
// 口径不对称，是故意的：上面扫 sale.js 走剥注释器（注释里提到不算违规），
// 这里扫 ui.test.js **原文**。将来谁在 ui.test.js 的注释里写一句 `cellQtys[size]` 会误红，
// 方向是安全的（宁可误红），但别误以为两边同口径。
const bareCellQtyInUi = uiTestSrc.match(UI_SITE_RE) || []
assert.strictEqual(
  bareCellQtyInUi.length, 0,
  'tests/ui.test.js 里所有 cellQtys[...] 的下标都必须带 \'v:\' 前缀（与 sale.js 的 cellKey 同形），'
    + '实测有 ' + bareCellQtyInUi.length + ' 处裸用。裸用会读到 undefined，'
    + '而那是静默的——只有完整 UI 轮会红。'
)

assert.strictEqual(
  bareCellQtyAccess.length, 0,
  'pages/sale/sale.js 里所有 cellQtys[...] 的下标都必须走 cellKey()，实测有 '
    + bareCellQtyAccess.length + ' 处裸用。规格取值是用户自由输入的，'
    + '不加前缀会撞上 Object.prototype 的属性名'
)

// 配套的第二半：钉住 cellKey 的实现形态，再证明这个形态确实解决问题。
//
// sale.js 是小程序 Page 文件、不能 require，所以上面那条钉子只能保证「下标都走了
// cellKey」，保证不了 cellKey 自己有没有效。这里先把它的函数体钉成「固定前缀 + 入参」，
// 再拿同形的实现跑一遍 Object.prototype 的**全部**属性名——两条合起来才是闭环：
// 下标都走它（钉子一）+ 它的实现是加前缀（钉子二）+ 加前缀对所有原型名有效（下面这段）。
// 下面这条**刻意**钉死字面形态（'v:' + size），而不是只钉「有个前缀」这个语义。
// 换成 'q:' + size 或模板串同样正确，钉子照样会红——这是有意的，不是钉子写窄了：
// key 形态一变，再下面那段「加前缀对 Object.prototype 全部属性名有效」的前提就要
// 重新验一遍，宁可误红也不放过。
//
// 所以看到它红，请先想清楚新形态是否仍然成立、并同步改下面那段验证，**不要顺手
// 把这条断言放宽**。放宽它等于把「key 形态可以随便改」这个假设偷偷塞进仓库。
assert.ok(
  saleJsNoCommentsForMultiModePin.indexOf("return 'v:' + size") >= 0,
  "cellKey 的实现应当是「固定前缀 'v:' + 入参」。改了前缀形态就要同步改下面那段验证，"
    + '否则验证的是一个已经不存在的实现'
)

const cellKeySameShape = function (size) { return 'v:' + size }
Object.getOwnPropertyNames(Object.prototype).forEach(function (protoName) {
  const box = {}
  box[cellKeySameShape(protoName)] = '5'
  assert.strictEqual(
    box[cellKeySameShape(protoName)], '5',
    '规格取值叫 ' + protoName + ' 时，加前缀后应当能正常存取——这正是店主可以自由'
      + '输入的取值名，不加前缀时 __proto__ 存不进去、constructor 读出来是函数'
  )
})
// 反过来证明上面那段不是空转：不加前缀时，同一组名字里确实有存不住的
const bareBox = {}
bareBox['__proto__'] = '5'
assert.notStrictEqual(
  bareBox['__proto__'], '5',
  '这条断言若红，说明当前 JS 引擎下裸用 __proto__ 当 key 已经不出问题了，'
    + '上面那整段防护的前提消失，应当重新评估是否还需要 cellKey'
)

// ===========================================================================
// 「本次售价」的归属：多选态换规格一要追平（22:231）
// ===========================================================================
//
// 病灶（2026-09-03 实测）：pickColor 的多选支只写 selectedColor / cellQtys / batchQty，
// unitPrice 一个字不动。黑色选中 M+L 时单价自动取第一枚选中格（黑 M）的档价 69，
// 点「白色」之后颜色变了、逐格数量清空了，单价仍是 69 —— 两格各填 1 件加入清单，
// 就是白 M ×1 @69、白 L ×1 @69，而白色两格的档价是 59，屏上没有任何提示。
//
// 稿 22:231 的裁定：换规格一时单价追平到新参照格（第一枚选中格）的档价，除非店主
// 已经手改过本次售价；**判据是「有没有人动过这个框」，不是「参照格变没变」**——
// 多选态下 data.skuId 恒为空串，applyProductState 那套 skuId 判据在这里恒假，
// 分不出「店主手改过」和「系统刚追平过」。
//
// 下面这些不是静态钉子，是**真的把 sale.js 里那几个方法拿出来跑**：sale.js 是小程序
// Page 文件、不能 require，但方法体是纯文本，用上面那个 pageMethod 抽出来重新组装成
// 一个对象就能在 Node 里执行。这样断言盯的是源码本身，不是一份转写。
function makeHarnessMethods() {
  const names = [
    'pricePatch', 'applyProductState', 'applySizeSelection', 'pickColor', 'pickSize',
    'pickAllSizes', 'onField', 'firstSelectedSku', 'sizeSelectionPatch', 'singleSelectedSize',
    'currentSku', 'currentLines', 'toCartItem'
  ]
  const bodies = names.map(function (name) { return pageMethod(saleJs, name) }).join(',')
  // cellKey 是模块级函数，不是方法，单独把它的源码搬进同一个作用域——同样不转写。
  const cellKeyMatch = /\nfunction cellKey\(size\) \{[\s\S]*?\n\}/.exec(saleJs)
  assert.ok(cellKeyMatch, '夹具前提：sale.js 里应当找得到模块级的 cellKey 定义')
  return { bodies: bodies, cellKeySrc: cellKeyMatch[0], names: names }
}

const harnessSrc = makeHarnessMethods()

// 四格档价刻意互不相同，且都不等于商品档价。ui.test.js 那边吃过这个亏：种子四格
// 全是 59 = 商品档价时，「追平到该格档价」「退回商品档价」「什么都没做」三种实现
// 给出同一个数，断言恒真。这里白 M 59 / 白 L 49 / 商品档价 39 三者分开，才分得出
// 「取了第一枚选中格」和「取了别的格 / 退回了商品档价」。
function makePricedFixture() {
  const product = inv.createProduct({
    name: '短袖', costPrice: 28, salePrice: 39, stock: 0, alertQty: 4,
    colors: ['黑色', '白色'], sizes: ['M', 'L']
  }, 1000, 'p-priced')
  return inv.applyProductSkus(product, [], [
    { color: '黑色', size: 'M', stock: 9, costPrice: 28, salePrice: 69, alertQty: 4 },
    { color: '黑色', size: 'L', stock: 9, costPrice: 28, salePrice: 65, alertQty: 4 },
    { color: '白色', size: 'M', stock: 9, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'L', stock: 9, costPrice: 28, salePrice: 49, alertQty: 4 }
  ], 1100, idFactory())
}

const priced = makePricedFixture()
const pricedSku = function (color, size) {
  const found = inv.findSkuBySpec(priced.skus, priced.product.id, color, size)
  assert.ok(found, '夹具前提：找不到「' + color + ' · ' + size + '」这一格')
  return found
}
const pBlackM = pricedSku('黑色', 'M')
const pBlackL = pricedSku('黑色', 'L')
const pWhiteM = pricedSku('白色', 'M')
const pWhiteL = pricedSku('白色', 'L')

// 夹具前提逐条钉死。少了任何一条，下面的断言就有一条会变成恒真的假绿。
assert.strictEqual(pBlackM.salePrice, 69, '夹具前提：黑 M 档价 69')
assert.strictEqual(pBlackL.salePrice, 65, '夹具前提：黑 L 档价 65')
assert.strictEqual(pWhiteM.salePrice, 59, '夹具前提：白 M 档价 59')
assert.strictEqual(pWhiteL.salePrice, 49, '夹具前提：白 L 档价 49')
assert.strictEqual(priced.product.salePrice, 39, '夹具前提：商品档价 39')
;[
  ['黑 M 与白 M', pBlackM.salePrice, pWhiteM.salePrice],
  ['白 M 与白 L', pWhiteM.salePrice, pWhiteL.salePrice],
  ['白 M 与商品档价', pWhiteM.salePrice, priced.product.salePrice],
  ['黑 M 与黑 L', pBlackM.salePrice, pBlackL.salePrice]
].forEach(function (pair) {
  assert.notStrictEqual(pair[1], pair[2],
    '夹具前提：' + pair[0] + ' 的档价必须不同，相等的话「追平到第一枚选中格」这条'
      + '断言分不出真追平和别的实现')
})

// 三格规格二的夹具。两格是**不够**的：['M','L'] 里点掉任意一格都会掉出多选形态，
// 那是 T5（多选→单选）另一条路；「多选态内增删格」这个形状——点完前后都还在多选态、
// 而且「第一枚选中格」换了人——至少要三格才做得出来（['M','L','XL'] 去掉 M）。
// 六格档价两两不同，且都不等于商品档价 39：相等的话「追平到新的第一枚选中格」
// 「追平到旧的那一格」「退回商品档价」「什么都没做」会给出同一个数，断言恒真。
function makeTriFixture() {
  const product = inv.createProduct({
    name: '长袖', costPrice: 28, salePrice: 39, stock: 0, alertQty: 4,
    colors: ['黑色', '白色'], sizes: ['M', 'L', 'XL']
  }, 2000, 'p-tri')
  return inv.applyProductSkus(product, [], [
    { color: '黑色', size: 'M', stock: 9, costPrice: 28, salePrice: 69, alertQty: 4 },
    { color: '黑色', size: 'L', stock: 9, costPrice: 28, salePrice: 65, alertQty: 4 },
    { color: '黑色', size: 'XL', stock: 9, costPrice: 28, salePrice: 55, alertQty: 4 },
    { color: '白色', size: 'M', stock: 9, costPrice: 28, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'L', stock: 9, costPrice: 28, salePrice: 49, alertQty: 4 },
    { color: '白色', size: 'XL', stock: 9, costPrice: 28, salePrice: 45, alertQty: 4 }
  ], 2100, idFactory())
}

const tri = makeTriFixture()
const triSku = function (color, size) {
  const found = inv.findSkuBySpec(tri.skus, tri.product.id, color, size)
  assert.ok(found, '夹具前提：三格夹具里找不到「' + color + ' · ' + size + '」这一格')
  return found
}
const tBlackM = triSku('黑色', 'M')
const tBlackL = triSku('黑色', 'L')
const tBlackXL = triSku('黑色', 'XL')
const tWhiteM = triSku('白色', 'M')

assert.deepStrictEqual(tri.product.sizes, ['M', 'L', 'XL'],
  '夹具前提：三格夹具的行序必须是 M / L / XL——下面「追平到行序第一格」的断言全靠它'
    + '与点击顺序不一致才分得出「取了行序第一格」和「取了 nextSizes[0]」')
;[
  ['黑 M', tBlackM.salePrice, 69], ['黑 L', tBlackL.salePrice, 65],
  ['黑 XL', tBlackXL.salePrice, 55], ['白 M', tWhiteM.salePrice, 59],
  ['商品档价', tri.product.salePrice, 39]
].forEach(function (row) {
  assert.strictEqual(row[1], row[2], '夹具前提：' + row[0] + ' 的档价应当是 ' + row[2])
})
;[tBlackM.salePrice, tBlackL.salePrice, tBlackXL.salePrice, tWhiteM.salePrice, tri.product.salePrice]
  .forEach(function (a, i, all) {
    all.forEach(function (b, j) {
      if (i < j) {
        assert.notStrictEqual(a, b,
          '夹具前提：三格夹具里这五个价（黑 M/L/XL、白 M、商品档价）必须两两不同，'
            + '第 ' + i + ' 个与第 ' + j + ' 个撞了 —— 撞了的话下面至少有一条断言恒真')
      }
    })
  })

// fx 省略时用两格夹具 priced；三格夹具 tri 见上（多选态内增删格要它）。
function saleHarness(initial, fx) {
  const fixture = fx || priced
  const store = {
    getProduct: function (id) {
      return id === fixture.product.id ? fixture.product : null
    }
  }
  const make = new Function('store', 'inventory', 'util',
    harnessSrc.cellKeySrc + '\nreturn { cellKey: cellKey,' + harnessSrc.bodies + '\n}')
  const methods = make(store, inv, util)
  harnessSrc.names.forEach(function (name) {
    assert.strictEqual(typeof methods[name], 'function',
      '夹具前提：应当从 sale.js 里抽到方法 ' + name + '——抽不到说明它改名或改了签名，'
        + '下面整段就不再是在测源码了')
  })
  return Object.assign({
    data: Object.assign({
      products: [fixture.product], skus: fixture.skus, cart: [],
      productId: fixture.product.id, productName: fixture.product.name,
      hasSpecs: true, colors: fixture.product.colors, sizes: fixture.product.sizes,
      selectedColor: '', selectedSizes: [], multiMode: false, skuId: '',
      qty: '', unitPrice: '', priceTouched: false, cellQtys: {}, batchQty: '',
      sizeOptions: [], cellRows: []
    }, initial || {}),
    setData: function (patch) { Object.assign(this.data, patch) },
    // 下面这几个是本段不关心的东西（现货 hint / 本行金额 / 结算 / 刷新），一律打桩。
    // 它们一个都不写 unitPrice 或 priceTouched，桩掉不影响被测的判定。
    stockPatch: function () { return {} },
    linePatch: function () { return {} },
    applySettle: function (patch) { this.setData(patch) },
    recomputeAfterSpecChange: function () {},
    cartItems: function () { return [] }
  }, methods)
}

function tapColor(page, value) {
  page.pickColor({ currentTarget: { dataset: { value: value } } })
}
function tapSize(page, value) {
  page.pickSize({ currentTarget: { dataset: { value: value } } })
}
function typePrice(page, value) {
  typeField(page, 'unitPrice', value)
}
// onField 是通用入口（remark / qty / unitPrice 都走它），所以辅助函数也做成通用的——
// 只给 unitPrice 开一个专用口子的话，「往别的框里打字会不会误置位」就没法测。
function typeField(page, field, value) {
  page.onField({ currentTarget: { dataset: { field: field } }, detail: { value: value } })
}
function multiOnBlack(extra) {
  const qtys = {}
  return saleHarness(Object.assign({
    selectedColor: '黑色', selectedSizes: ['M', 'L'], multiMode: true,
    // 多选态下 skuId 恒为空串（applySizeSelection 写的就是空串），这是本 bug 的
    // 直接成因：照抄 applyProductState 的 skuId 判据在这里恒假。
    skuId: '', unitPrice: String(pBlackM.salePrice), priceTouched: false,
    cellQtys: qtys, batchQty: ''
  }, extra || {}))
}

// --- (1) 多选态换规格一 → 单价追平到新参照格档价 -----------------------------
const t3 = multiOnBlack({ cellQtys: { 'v:M': '1', 'v:L': '1' }, batchQty: '2' })
assert.notStrictEqual(t3.data.unitPrice, String(pWhiteM.salePrice),
  '前提：进入值（' + t3.data.unitPrice + '）不许等于期望值（' + pWhiteM.salePrice + '），'
    + '相等的话「换规格一要追平」这条断言恒真，实现什么都不做也能过')
tapColor(t3, '白色')
assert.strictEqual(t3.data.unitPrice, String(pWhiteM.salePrice),
  '多选态换规格一之后，单价应当追平到新参照格（第一枚选中格 = 白 M）的档价 '
    + pWhiteM.salePrice + '，实为 ' + t3.data.unitPrice
    + '——停在上一个规格一的价就是按错价记账，而且屏上没有任何提示')
assert.strictEqual(t3.data.priceTouched, false,
  '系统自己追平的价，归属要收回给系统（priceTouched 复位）——不复位的话下一次换'
    + '规格一会把这个系统写进去的价当成「店主手改的」保留住，一次追平永久生效')
// T3 原有的另外半条不许被改坏
assert.strictEqual(t3.data.selectedColor, '白色', 'T3：规格一应当换成白色')
assert.deepStrictEqual(t3.data.selectedSizes, ['M', 'L'], 'T3：选中集合保留')
assert.strictEqual(t3.data.multiMode, true, 'T3：仍在多选形态')
assert.strictEqual(Object.keys(t3.data.cellQtys).length, 0,
  'T3：逐格数量清空（换颜色后每格现货会变，留着旧数量会被当成已核过库存）')
assert.strictEqual(t3.data.batchQty, '', 'T3：「全部填」清空')

// 记账后果：把两格都填上 1 件，出去的两行必须都是白色那一格、都按白色的价。
// 上面那条只看 data.unitPrice，这条看真正进清单的行——docs/accounting-vs-policy.md
// 的「不要为了省一次点击，让销售偷偷拿其他规格去充当前规格」，价也是同一件事。
const t3Qtys = {}
t3Qtys[t3.cellKey('M')] = '1'
t3Qtys[t3.cellKey('L')] = '1'
t3.setData({ cellQtys: t3Qtys })
const t3Lines = t3.currentLines()
assert.strictEqual(t3Lines.error, '', 'T3：两格都填了数，不该有 error')
assert.strictEqual(t3Lines.lines.length, 2, 'T3：两格各一行')
const t3BySize = {}
t3Lines.lines.forEach(function (line) { t3BySize[line.size] = line })
assert.strictEqual(t3BySize.M.skuId, pWhiteM.id, 'T3：M 那行应当记在白 M 上')
assert.strictEqual(t3BySize.L.skuId, pWhiteL.id, 'T3：L 那行应当记在白 L 上')
assert.strictEqual(t3BySize.M.unitPrice, pWhiteM.salePrice,
  '白 M 这一行应当按 ' + pWhiteM.salePrice + ' 记账，实为 ' + t3BySize.M.unitPrice
    + '——按上一个规格一的价出货，销售额、毛利、欠款三个数一起错')
assert.strictEqual(t3BySize.L.unitPrice, pWhiteM.salePrice,
  '整批一个价：白 L 这一行也按第一枚选中格的 ' + pWhiteM.salePrice + ' 记账，实为 '
    + t3BySize.L.unitPrice)

// --- (2) 追平之后再换一次 → 仍然追平（证明标志真的被复位了）-------------------
// 接着上面那个 page 的末态（白色，单价 59，归属在系统手里）再换回黑色。
assert.notStrictEqual(t3.data.unitPrice, String(pBlackM.salePrice),
  '前提：进入值（' + t3.data.unitPrice + '）不许等于期望值（' + pBlackM.salePrice + '）')
tapColor(t3, '黑色')
assert.strictEqual(t3.data.unitPrice, String(pBlackM.salePrice),
  '第二次换规格一仍然要追平到 ' + pBlackM.salePrice + '，实为 ' + t3.data.unitPrice
    + '——追平之后 priceTouched 若被写成 true，这里就会把系统上一次写进去的 59'
    + '当成店主手改的价保留住，一次追平之后永久「保留」')

// --- (2b) onField 的字段守卫：只有「本次售价」带归属 -----------------------
// `onField` 是个**通用**入口，`sale.wxml` 里给 `remark` / `qty` / `unitPrice`（两个框）
// 都绑了它。把 `field === 'unitPrice'` 那道守卫放宽成「任何字段都置位」之后，
// **打个数量就会把系统写的价标成「店主填的」**，之后换颜色就不再追平——
// 正是本次要修的那个错账形态，只是触发路径换了。
// （2026-09-04 审计 N1：这道守卫之前没有任何断言盯着，放宽它 `npm test` 全绿。）
const guard = multiOnBlack()
typeField(guard, 'qty', '3')
assert.strictEqual(guard.data.qty, '3', '\u524d\u63d0\uff1aonField \u786e\u5b9e\u628a qty \u5199\u8fdb\u53bb\u4e86\uff08\u63a2\u9488\u6ca1\u574f\uff09')
assert.notStrictEqual(
  String(pBlackM.salePrice), String(pWhiteM.salePrice),
  '前提：进入值（黑 M 档价）不许等于期望值（白 M 档价），否则下面那条追平断言恒真'
)
assert.strictEqual(
  guard.data.priceTouched, false,
  '往「数量」框里打字不得把 priceTouched 置位（false → true）'
)
tapColor(guard, '\u767d\u8272')
assert.strictEqual(
  guard.data.unitPrice, String(pWhiteM.salePrice),
  '打过数量之后换规格一，仍然要追平到 ' + pWhiteM.salePrice
    + '，实为 ' + guard.data.unitPrice
)

// 上面只盯住了 false → true。**反方向同样是真钱的 bug**：店主先手打 88，
// 再去数量框敲个数，归属被无声清掉，接着换颜色 88 就变成档价。
// （2026-09-04 审计 F2：只钉单向时，「打 qty 顺手清掉标志」这种改法全套绿。）
const guardBack = multiOnBlack()
typePrice(guardBack, '88')
assert.strictEqual(guardBack.data.priceTouched, true, '前提：先把归属打成店主的')
typeField(guardBack, 'qty', '3')
assert.strictEqual(
  guardBack.data.priceTouched, true,
  '往「数量」框里打字也不得把已经置位的 priceTouched 清掉（true → false）——'
    + '清掉之后换颜色就会把店主手填的价冲掉'
)
tapColor(guardBack, '\u767d\u8272')
assert.strictEqual(
  guardBack.data.unitPrice, '88',
  '打过数量之后换规格一，店主手填的 88 必须还在，实为 ' + guardBack.data.unitPrice
)

// `remark` 也绑在 onField 上（sale.wxml）。上面的断言文案引用了它来给自己背书，
// 那就得真测它——否则就是本仓记过的「断言不要吹过头」。
// （审计 F2：守卫写成 `field !== 'qty'`（即 remark 也置位）时全套绿。）
const guardRemark = multiOnBlack()
typeField(guardRemark, 'remark', '备注')
assert.strictEqual(
  guardRemark.data.priceTouched, false,
  '往「备注」框里打字同样不得置位 priceTouched'
)
tapColor(guardRemark, '\u767d\u8272')
assert.strictEqual(
  guardRemark.data.unitPrice, String(pWhiteM.salePrice),
  '打过备注之后换规格一，仍然要追平到 ' + pWhiteM.salePrice
)
const guardRemarkBack = multiOnBlack()
typePrice(guardRemarkBack, '88')
typeField(guardRemarkBack, 'remark', '备注')
assert.strictEqual(
  guardRemarkBack.data.priceTouched, true,
  '往「备注」框里打字也不得清掉已置位的 priceTouched'
)

// --- (2c) 标志是「谁写的」，不是「等不等于档价」 ----------------------
// `pages/sale/sale.js` 那条 data 注释声明这个标志**不是**派生量，并给了两条理由：
// 「店主完全可以手打一个恰好等于档价的数」、「也可以手打完再改回来」。
// **这两条就是下面要钉的东西。**
//
// 【为什么要分两组】「派生量」有两种自然写法，杀伤完全不同：
//   D1 = 和**追平目标**（新参照格）比 —— 它顺手把多选态换色的追平也废了，
//        组 (1) 当场就红，轮不到这里。
//   D2 = 和**值的来源格**（旧参照格）比 —— 语义上更贴近「这个值是不是人填的」，
//        而且它会把组 (1)(3) 全部蒙混过去。
// 只钉 D1 等于没钉：2026-09-04 审计实测 D2 下 **全套绿**，而店主明明手打了 69、
// 单据却按 59 出货。下面前两组专杀 D2（分辨点在**值**上），第三组补 D1。
//
// （我曾把第一组删掉、只留第三组，结果删掉的恰恰是唯一有独占杀伤的那一条。）

// (2c-1) 注释第一条理由：手打一个恰好等于**当前**参照格档价的数。
const sameSrc = multiOnBlack()
typePrice(sameSrc, String(pBlackM.salePrice))
assert.strictEqual(sameSrc.data.priceTouched, true, '前提：手打就是手打，哪怕值等于档价')
tapColor(sameSrc, '\u767d\u8272')
assert.strictEqual(
  sameSrc.data.unitPrice, String(pBlackM.salePrice),
  '店主手打的数恰好等于**当前**参照格档价时，换规格一仍要保留 '
    + pBlackM.salePrice + '，实为 ' + sameSrc.data.unitPrice
    + '——被追平成 ' + pWhiteM.salePrice + ' 就说明标志被写成了「和来源格比」那种派生量'
)
assert.strictEqual(sameSrc.data.priceTouched, true, '保留时归属也要原样留住')

// (2c-2) 注释第二条理由：手打完再改回来。
const typedBack = multiOnBlack()
typePrice(typedBack, '88')
typePrice(typedBack, String(pBlackM.salePrice))
tapColor(typedBack, '\u767d\u8272')
assert.strictEqual(
  typedBack.data.unitPrice, String(pBlackM.salePrice),
  '手打 88 再改回 ' + pBlackM.salePrice + ' 之后，那仍然是店主填的数，'
    + '换规格一不得追平，实为 ' + typedBack.data.unitPrice
)

// (2c-3) 补 D1（和追平目标比）。这一组值这一层两种实现相同，
// 分辨点只在标志上——**仅限本场景如此**，不是普遍的（上面两组就分在值上）。
// 主杀伤不在这一条身上，D1 其实在组 (1) 就会先红；留着作为补钉。
const sameTgt = multiOnBlack()
typePrice(sameTgt, String(pWhiteM.salePrice))
tapColor(sameTgt, '\u767d\u8272')
assert.strictEqual(sameTgt.data.unitPrice, String(pWhiteM.salePrice), '前提：这一步两种实现的值相同')
assert.strictEqual(
  sameTgt.data.priceTouched, true,
  '手打的数恰好等于追平目标时，走的仍必须是「保留」那条路（标志留 true）'
)

// --- (3) 店主手改过单价 → 换规格一保留他填的 ---------------------------------
const kept = multiOnBlack()
typePrice(kept, '88')
assert.strictEqual(kept.data.priceTouched, true,
  'onField 是 priceTouched 的唯一置位点：店主往「本次售价」框里打字之后，'
    + '这个标志必须为真，否则下面「保留他填的价」根本无从判起')
assert.strictEqual(kept.data.unitPrice, '88', 'onField 应当把值写进 data')
assert.notStrictEqual('88', String(pWhiteM.salePrice),
  '前提：手改的价不许恰好等于追平目标，否则「保留」和「追平」分不出来')
tapColor(kept, '白色')
assert.strictEqual(kept.data.unitPrice, '88',
  '店主手改过本次售价之后再换规格一，应当保留他填的 88，实为 ' + kept.data.unitPrice
    + '——判据是「有没有人动过这个框」（22:231），不是「参照格变没变」')
assert.strictEqual(kept.data.priceTouched, true,
  '保留的时候归属不变，还是店主的——写成 false 的话再换一次规格一就会把他的价冲掉')

// --- (4) 站点完整性：系统在**别的**写入点写过框，归属也要收回 -----------------
// 只在 pickColor 里复位是不够的：applyProductState / applySizeSelection 同样会
// 拿系统算的价盖掉框里的值，那两处不复位的话，店主手改一次之后这个标志就再也回不去，
// 后面每一次换规格一都会「保留」一个其实是系统写进去的价。
const relay = multiOnBlack()
typePrice(relay, '88')
assert.strictEqual(relay.data.priceTouched, true, '前提：先手改一次')
// T5：点掉一格回落单选态，applySizeSelection 追平到剩下那一格（黑 M）
relay.applySizeSelection(priced.product, ['M', 'L'], ['M'])
assert.strictEqual(relay.data.unitPrice, String(pBlackM.salePrice),
  'T5 回落单选态应当追平到剩下那一格的档价 ' + pBlackM.salePrice + '，实为 ' + relay.data.unitPrice)
assert.strictEqual(relay.data.priceTouched, false,
  'applySizeSelection 追平之后也要复位归属——只在 pickColor 里复位，标志就成了'
    + '「店主这辈子动过没有」，而它要答的是「框里现在这个值是不是他填的」')
relay.applySizeSelection(priced.product, ['M'], ['M', 'L'])
assert.strictEqual(relay.data.priceTouched, false, '回到多选态，归属仍在系统手里')
tapColor(relay, '白色')
assert.strictEqual(relay.data.unitPrice, String(pWhiteM.salePrice),
  '手改过、但中途系统写过这个框，之后换规格一应当照常追平到 ' + pWhiteM.salePrice
    + '，实为 ' + relay.data.unitPrice)

// --- (5) 离开页面再回来（onShow 回填），手改过这件事不许被忘掉 ----------------
// onShow 会对同一件商品再跑一次 selectProduct → applyProductState。那一支的
// keepPrice 判真、把店主的价原样写回框里，此时**不能**顺手把归属收走：值还是他的。
const revisit = multiOnBlack()
typePrice(revisit, '88')
revisit.applyProductState(priced.product, '黑色', ['M', 'L'], [])
assert.strictEqual(revisit.data.unitPrice, '88',
  'onShow 回填不该把店主手改的价打回档价，实为 ' + revisit.data.unitPrice)
assert.strictEqual(revisit.data.priceTouched, true,
  '原样留住他的价时，归属也要原样留住——写成 false 的话，离开页面再回来一趟就足以'
    + '让他手改的价在下一次换规格一时被无声冲掉')
tapColor(revisit, '白色')
assert.strictEqual(revisit.data.unitPrice, '88',
  '回来之后换规格一仍应保留 88，实为 ' + revisit.data.unitPrice)

// --- (6) 单选态的既有行为没被破坏 --------------------------------------------
// (6a) 单选态换规格一：没手改过就照常追平到新那一格。
const singleColor = saleHarness({
  selectedColor: '黑色', selectedSizes: ['M'], multiMode: false,
  skuId: pBlackM.id, unitPrice: String(pBlackM.salePrice), priceTouched: false
})
assert.notStrictEqual(singleColor.data.unitPrice, String(pWhiteM.salePrice), '前提：进入值 ≠ 期望值')
tapColor(singleColor, '白色')
assert.strictEqual(singleColor.data.unitPrice, String(pWhiteM.salePrice),
  '单选态换规格一应当追平到 ' + pWhiteM.salePrice + '，实为 ' + singleColor.data.unitPrice)
assert.strictEqual(singleColor.data.skuId, pWhiteM.id, '单选态 skuId 要跟着那一格走')

// (6b) 单选态点规格二：**手改过也照样追平**。这条是 tests/ui.test.js:1990 逐字钉着的
// 行为（逐格售价是真功能，停在上一格就是按错价记账），本次不动它：22:231 新加的
// 「有没有人动过这个框」写的是换规格一，作用点在 pickColor 的多选支。
// 把它在 npm test 里复刻一份，是因为那条 UI 断言要跑满整轮 UI 测试才看得到——
// 换规格一那边一旦顺手把判据"统一"成 priceTouched，这里立刻就红。
const singleSize = saleHarness({ selectedColor: '黑色', selectedSizes: [], multiMode: false })
typePrice(singleSize, '1')
assert.strictEqual(singleSize.data.priceTouched, true, '前提：先手改一次')
assert.notStrictEqual('1', String(pBlackM.salePrice), '前提：进入值 ≠ 期望值')
tapSize(singleSize, 'M')
assert.deepStrictEqual(singleSize.data.selectedSizes, ['M'], '前提：这一下应当选中 M')
assert.strictEqual(singleSize.data.unitPrice, String(pBlackM.salePrice),
  '单选态点规格二仍应把单价追平到那一枚 SKU 的档价 ' + pBlackM.salePrice + '，实为 '
    + singleSize.data.unitPrice + '——这条与 tests/ui.test.js:1990 同源，'
    + '把换规格一的「手改过就保留」判据扩到这里会当场推翻它')
assert.strictEqual(singleSize.data.priceTouched, false, '追平了就要复位归属')
assert.strictEqual(singleSize.data.skuId, pBlackM.id, 'skuId 也要跟上')

// ===========================================================================
// 「本次售价」的归属（续）：多选态内增删格也按「动过没有」判（22:231 追裁）
// ===========================================================================
//
// 稿 22:231 追加的裁定：换规格二**只在多选态**同理——多选态内增删格，单价同样按
// 「动过没有」判；**单选形态点规格二仍然一律追平**（那是 2026-09-02「按错价记账」
// 回归的闸，见下面 (6b) 与 tests/ui.test.js:1990）。两条判据并存不矛盾：单选态每次
// 点格子就是在挑那一个 SKU，价该跟着走；多选态的价是「整批一个价」，店主填了就是
// 他要的批价，不该被增删一格冲掉。
//
// 病灶（2026-09-03 实测）：applySizeSelection 里那句
//     keepPrice = !!this.data.unitPrice && this.data.skuId === (refSku ? refSku.id : '')
// 在多选态**结构性恒假**——进/留在多选态时写进 data 的 skuId 恒为空串，而 refSku.id
// 非空。后果：多选态手改 88，一点规格二 chip 就无声变回 69。

function triMulti(sizes, extra) {
  const cellQtys = {}
  sizes.forEach(function (s) { cellQtys['v:' + s] = '' })
  return saleHarness(Object.assign({
    selectedColor: '黑色', selectedSizes: sizes.slice(), multiMode: true,
    // 多选态下 skuId 恒为空串——这是本 bug 的直接成因，夹具必须照实模拟。
    skuId: '', priceTouched: false, cellQtys: cellQtys, batchQty: ''
  }, extra || {}), tri)
}

// --- (7) 多选态内**删格**，没手改过 → 追平到新的第一枚选中格 ------------------
const shrink = triMulti(['M', 'L', 'XL'], {
  unitPrice: String(tBlackM.salePrice),
  cellQtys: { 'v:M': '1', 'v:L': '2', 'v:XL': '3' }
})
assert.strictEqual(shrink.data.priceTouched, false, '前提：店主没动过这个框')
assert.notStrictEqual(shrink.data.unitPrice, String(tBlackL.salePrice),
  '前提：进入值（' + shrink.data.unitPrice + '）不许等于期望值（' + tBlackL.salePrice
    + '），相等的话这条断言恒真，实现什么都不做也能过')
tapSize(shrink, 'M')
assert.deepStrictEqual(shrink.data.selectedSizes, ['L', 'XL'],
  '前提：点掉 M 之后应当剩 L / XL 两格')
assert.strictEqual(shrink.data.multiMode, true,
  '前提：剩两格仍在多选形态——掉出多选态就变成 T5 那条路，测的不是这条')
assert.strictEqual(shrink.data.unitPrice, String(tBlackL.salePrice),
  '多选态内删掉第一枚选中格之后，没手改过的单价应当追平到新的第一枚选中格（黑 L）的'
    + '档价 ' + tBlackL.salePrice + '，实为 ' + shrink.data.unitPrice
    + '——停在被删掉那一格的价就是按错价记账，屏上没有任何提示')
assert.strictEqual(shrink.data.priceTouched, false,
  '系统自己追平的价，归属要收回给系统')
assert.strictEqual(shrink.data.cellQtys[shrink.cellKey('M')], undefined,
  '删掉的格连 key 一起清掉（选中集合是唯一真相，不留看不见的数）')
assert.strictEqual(shrink.data.cellQtys[shrink.cellKey('L')], '2', '留下的格数量不动')
assert.strictEqual(shrink.data.cellQtys[shrink.cellKey('XL')], '3', '留下的格数量不动')

// 记账后果：两格出去的行都得按 65，不是被删掉那一格的 69。
const shrinkLines = shrink.currentLines()
assert.strictEqual(shrinkLines.error, '', '两格都填了数，不该有 error')
assert.strictEqual(shrinkLines.lines.length, 2, '两格各一行')
shrinkLines.lines.forEach(function (line) {
  assert.strictEqual(line.unitPrice, tBlackL.salePrice,
    '「' + line.size + '」这一行应当按新参照格的 ' + tBlackL.salePrice + ' 记账，实为 '
      + line.unitPrice + '——按已经点掉那一格的价出货，销售额、毛利、欠款三个数一起错')
})

// --- (8) 多选态内**增格**，没手改过 → 追平到**行序**第一格，不是点击序 --------
const grow = triMulti(['L', 'XL'], { unitPrice: String(tBlackL.salePrice) })
assert.notStrictEqual(grow.data.unitPrice, String(tBlackM.salePrice), '前提：进入值 ≠ 期望值')
tapSize(grow, 'M')
assert.deepStrictEqual(grow.data.selectedSizes, ['L', 'XL', 'M'],
  '前提：pickSize 是往末尾 concat，所以点击序是 L / XL / M——与行序 M / L / XL 不同，'
    + '下面那条才分得出「取了行序第一格」和「取了 nextSizes[0]」')
assert.strictEqual(grow.data.multiMode, true, '前提：仍在多选形态')
assert.strictEqual(grow.data.unitPrice, String(tBlackM.salePrice),
  '多选态内新增一格之后，单价应当追平到**行序**第一枚选中格（黑 M）的档价 '
    + tBlackM.salePrice + '，实为 ' + grow.data.unitPrice
    + '——取成点击序第一个（黑 L，' + tBlackL.salePrice + '）就与逐格行 / cellRows 的'
    + '行序两说了，屏上第一行显示的是 M、价却是 L 的')
assert.strictEqual(grow.data.cellQtys[grow.cellKey('M')], '',
  '新选中的格要有一个空串条目，不是压根没有 key')

// --- (9) 多选态内增删格 + 店主手改过 → 保留他填的 ----------------------------
const triKept = triMulti(['M', 'L', 'XL'], {
  unitPrice: String(tBlackM.salePrice),
  cellQtys: { 'v:M': '1', 'v:L': '1', 'v:XL': '1' }
})
typePrice(triKept, '88')
assert.strictEqual(triKept.data.priceTouched, true,
  'onField 是 priceTouched 的唯一置位点：店主往「本次售价」框里打字之后这个标志必须为真')
assert.notStrictEqual('88', String(tBlackL.salePrice),
  '前提：手改的价不许恰好等于追平目标，否则「保留」和「追平」分不出来')
tapSize(triKept, 'M')
assert.deepStrictEqual(triKept.data.selectedSizes, ['L', 'XL'], '前提：删掉 M，仍是多选')
assert.strictEqual(triKept.data.multiMode, true, '前提：仍在多选形态')
assert.strictEqual(triKept.data.unitPrice, '88',
  '多选态的价是「整批一个价」，店主手改过之后**增删一格不许冲掉**，应当仍是 88，实为 '
    + triKept.data.unitPrice + '——判据是「有没有人动过这个框」（22:231 追裁），'
    + '不是「参照格变没变」；后者在多选态结构性恒假（skuId 恒为空串）')
assert.strictEqual(triKept.data.priceTouched, true,
  '保留的时候归属不变，还是店主的——写成 false 的话再增删一格就会把他的价冲掉')
// 再增一格，仍然保留（证明归属没被中途收走）
tapSize(triKept, 'M')
assert.deepStrictEqual(triKept.data.selectedSizes, ['L', 'XL', 'M'], '前提：把 M 加回来')
assert.strictEqual(triKept.data.unitPrice, '88',
  '第二次增删格仍应保留店主填的 88，实为 ' + triKept.data.unitPrice)
// 记账后果：三格都按他填的 88 出去。
const keptQtys = {}
;['M', 'L', 'XL'].forEach(function (s) { keptQtys[triKept.cellKey(s)] = '1' })
triKept.setData({ cellQtys: keptQtys })
const keptLines = triKept.currentLines()
assert.strictEqual(keptLines.lines.length, 3, '三格各一行')
keptLines.lines.forEach(function (line) {
  assert.strictEqual(line.unitPrice, 88,
    '「' + line.size + '」这一行应当按店主填的 88 记账，实为 ' + line.unitPrice)
})

// --- (10) T4（0/1 → 多选）判据**未变**：仍看「参照 SKU 变没变」------------------
// 这一条是本次改动的边界闸。店主手改过（88），但这一下把参照格换成了行序第一格 M
// （data.skuId 记的还是 L 那一枚，对不上），所以照旧追平到 69。
// 把多选态那条 priceTouched 判据顺手"统一"到 T4，这里立刻会停在 88。
const t4 = saleHarness({
  selectedColor: '黑色', selectedSizes: ['L'], multiMode: false,
  skuId: tBlackL.id, unitPrice: String(tBlackL.salePrice), priceTouched: false, qty: '2'
}, tri)
typePrice(t4, '88')
assert.strictEqual(t4.data.priceTouched, true, '前提：先手改一次')
tapSize(t4, 'M')
assert.deepStrictEqual(t4.data.selectedSizes, ['L', 'M'], '前提：这一下应当进多选形态')
assert.strictEqual(t4.data.multiMode, true, '前提：|Z| 1→2，进多选')
assert.strictEqual(t4.data.unitPrice, String(tBlackM.salePrice),
  'T4 的判据**没有换**：参照格从黑 L 换成了行序第一格黑 M，应当照旧追平到 '
    + tBlackM.salePrice + '，实为 ' + t4.data.unitPrice
    + '——22:231 追裁写的是「多选态内增删格」，T4 是进多选那一下，不在裁定范围内')
assert.strictEqual(t4.data.priceTouched, false, 'T4 追平了，归属收回给系统')
assert.strictEqual(t4.data.qty, '', 'T4：数量框清空')
assert.strictEqual(t4.data.cellQtys[t4.cellKey('L')], '2', 'T4：原数量框的值搬进原选中格 L')
assert.strictEqual(t4.data.cellQtys[t4.cellKey('M')], '', 'T4：新格留空')

// T4 的 0→N 支（空态点「全选」）同样未变：没有原选中格，追平到行序第一格。
const t4All = saleHarness({
  selectedColor: '黑色', selectedSizes: [], multiMode: false,
  skuId: '', unitPrice: String(tri.product.salePrice), priceTouched: false, qty: '5'
}, tri)
assert.notStrictEqual(t4All.data.unitPrice, String(tBlackM.salePrice), '前提：进入值 ≠ 期望值')
t4All.pickAllSizes()
assert.deepStrictEqual(t4All.data.selectedSizes, ['M', 'L', 'XL'], '前提：全选三格')
assert.strictEqual(t4All.data.unitPrice, String(tBlackM.salePrice),
  'T4 的 0→N 支应当追平到行序第一格（黑 M）的档价 ' + tBlackM.salePrice + '，实为 '
    + t4All.data.unitPrice)
assert.strictEqual(t4All.data.cellQtys[t4All.cellKey('M')], '5',
  'T4 0→N：数量框的值按行序搬进第一格')

// --- (11) T5（多选 → 0/1）判据**未变**：回落到哪一格就按哪一格的档价 ----------
// 同样是边界闸：店主手改过 88，但回落单选态之后每一次点格子就是在挑那一个 SKU，
// 价必须跟着走（与 tests/ui.test.js:1990 同源）。扩了 priceTouched 这里会停在 88。
const t5 = triMulti(['L', 'XL'], {
  unitPrice: String(tBlackL.salePrice),
  cellQtys: { 'v:L': '3', 'v:XL': '4' }
})
typePrice(t5, '88')
assert.strictEqual(t5.data.priceTouched, true, '前提：先手改一次')
tapSize(t5, 'L')
assert.deepStrictEqual(t5.data.selectedSizes, ['XL'], '前提：这一下应当回落单选形态')
assert.strictEqual(t5.data.multiMode, false, '前提：|Z| 2→1，回落单选')
assert.strictEqual(t5.data.unitPrice, String(tBlackXL.salePrice),
  'T5 的判据**没有换**：回落到黑 XL 就该按它的档价 ' + tBlackXL.salePrice + ' 记账，实为 '
    + t5.data.unitPrice + '——单选形态每次点格子就是在挑那一枚 SKU，价该跟着走；'
    + '把多选态那条「手改过就保留」扩到这里，就是从这个方向把 #127「按错价记账」'
    + '那条闸拆掉（tests/ui.test.js:1990）')
assert.strictEqual(t5.data.priceTouched, false, 'T5 追平了，归属收回给系统')
assert.strictEqual(t5.data.skuId, tBlackXL.id, 'T5：skuId 记剩下那一格')
assert.strictEqual(t5.data.qty, '4', 'T5：那一格的值搬回数量框')
assert.strictEqual(Object.keys(t5.data.cellQtys).length, 0, 'T5：逐格草稿清空')
assert.strictEqual(t5.data.batchQty, '', 'T5：「全部填」清空')

// --- (12) 站点完整性静态钉子 --------------------------------------------------
// 页面 data 的 unitPrice 只准由 pricePatch 写出来（唯一同时决定 priceTouched 的地方），
// 加上 onField 那个用户输入口（走 patch[field] = value，没有字面量 key）。
// 本 bug 的形状就是「有个地方改了参照格却没写 unitPrice」，而它不崩、不报错、
// 屏上也没提示——只有把写入口收敛成一个，漏写才会在结构上做不到。
// 本仓在「一个字段改多点位、漏掉一处」上栽过不止一次，见记忆 sku-vs-barcode-levels。
// (?<!\.) 与上面 selectedSizes 那条同源：排掉 `this.data.unitPrice : x` 这类三元
// 表达式里的冒号——那不是对象字面量的 key，不是写入点。
const UNIT_PRICE_KEY_RE = /(?<!\.)unitPrice\s*:/g
assert.ok(
  ('    unitPrice: price,'.match(UNIT_PRICE_KEY_RE) || []).length === 1,
  '阳性对照：这条正则应当能认出 `unitPrice:` 这种字面量 key。认不出就说明它被改坏了，'
    + '下面那条计数是恒真的假绿'
)
assert.ok(
  ('keep ? this.data.unitPrice : fallback'.match(UNIT_PRICE_KEY_RE) || []).length === 0,
  '阴性对照：三元表达式里的 `this.data.unitPrice :` 不是写入点，不许被数进去——'
    + '数进去的话计数会随着实现的写法漂移，钉子失去意义'
)
const unitPriceKeyCount = (saleJsNoCommentsForMultiModePin.match(UNIT_PRICE_KEY_RE) || []).length
assert.strictEqual(
  unitPriceKeyCount, 4,
  '字面量 "unitPrice:" 应当恰好出现 4 次（data{} 初始值 + pricePatch 的 return + '
    + 'toCartItem 的清单行 + submit 的 items 映射），实为 ' + unitPriceKeyCount
    + ' 次。多出来的多半是有地方绕开 pricePatch 直接往页面 data 里写单价——'
    + '那就又有一个「改了参照格、单价没跟上」或者「把店主手改的价无声冲掉」的点位'
)
;['applyProductState', 'applySizeSelection', 'pickColor'].forEach(function (name) {
  const body = pageMethod(saleJs, name)
  assert.ok(
    body.indexOf('this.pricePatch(') >= 0,
    name + ' 应当经 this.pricePatch() 写单价——三个改变「参照格」的方法都必须走它，'
      + '否则 unitPrice 和 priceTouched 会分头写，标志迟早开始撒谎'
  )
})
const pricePatchBody = pageMethod(saleJs, 'pricePatch')
assert.ok(
  /unitPrice\s*:/.test(pricePatchBody) && /priceTouched\s*:/.test(pricePatchBody),
  'pricePatch 的返回里两个字段必须都在——只写一个就等于没有这个函数'
)

// --- (13) 上面那两条钉子的盲区：非字面量 key 的写入口 -------------------------
// UNIT_PRICE_KEY_RE 只数得到对象字面量 key（`unitPrice:`），三条方法名单只查
// `this.pricePatch(` 在不在。2026-09-03 审计给了实证：往 pickAllSizes 里插
//
//     const px = {}
//     px.unitPrice = '0'
//     this.setData(px)
//
// —— 换成属性赋值就绕开了字面量 key，pickAllSizes 又不在任何名单里，结果 `npm test`
// 整个 exit=0，一条断言都没红。下面补上属性赋值和引号计算 key 这两种形态。
//
// **说清这条钉子盖不到什么，别吹过头**：`patch[field] = value`（onField 那种全动态
// 下标）任何静态正则都认不出来——那正是 onField 自己的写法，也是留给用户输入的口。
// 所以这条挡的是「顺手换个写法绕开 pricePatch」，不是「所有可能的写入」。
const UNIT_PRICE_WRITE_RE = /(?:\.\s*unitPrice\s*=(?!=)|\[\s*['"]unitPrice['"]\s*\])/g
assert.strictEqual(
  ("px.unitPrice = '0'".match(UNIT_PRICE_WRITE_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出属性赋值 `px.unitPrice = ...`（审计实证用的正是这个'
    + '写法）。认不出就说明它被改坏了，下面那条 === 0 是恒真的假绿'
)
assert.strictEqual(
  ("px['unitPrice'] = '0'".match(UNIT_PRICE_WRITE_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出引号计算 key `px[\'unitPrice\']`'
)
assert.strictEqual(
  ('if (this.data.unitPrice === prev) return'.match(UNIT_PRICE_WRITE_RE) || []).length, 0,
  '阴性对照：`=== ` 是比较不是写入，不许被数进去——数进去的话这条钉子会随实现的'
    + '读法漂移，迟早被人当噪音删掉'
)
assert.strictEqual(
  ('unitPrice: keep ? this.data.unitPrice : fallback'.match(UNIT_PRICE_WRITE_RE) || []).length, 0,
  '阴性对照：字面量 key 与三元里的读取都不是这条要数的形态（前者归 UNIT_PRICE_KEY_RE 管）'
)
const unitPriceWrites = saleJsNoCommentsForMultiModePin.match(UNIT_PRICE_WRITE_RE) || []
assert.strictEqual(
  unitPriceWrites.length, 0,
  'pages/sale/sale.js 里不许出现 `x.unitPrice = ...` 或 `x[\'unitPrice\'] = ...` 这种'
    + '绕开 pricePatch 的写法，实测有 ' + unitPriceWrites.length + ' 处：'
    + JSON.stringify(unitPriceWrites) + '。页面 data 的 unitPrice 只准由 pricePatch'
    + '（系统）和 onField（用户输入）写出来——分头写的话 priceTouched 迟早开始撒谎'
)

// priceTouched 同理，且更严：它是本次新加的标志，写岔了不会崩、不会报错，只会让
// 「框里这个值是不是人填的」这个问题答错，而答错的后果是店主手改的价被无声冲掉
// （或者反过来，系统写进去的价被永久「保留」）。
// (?<!\.) 与上面 selectedSizes 那条同源：排掉 `this.data.priceTouched : false` 这类
// 三元表达式里的冒号。
const PRICE_TOUCHED_KEY_RE = /(?<!\.)priceTouched\s*:/g
assert.strictEqual(
  ('    priceTouched: false,'.match(PRICE_TOUCHED_KEY_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出 `priceTouched:` 这种字面量 key'
)
assert.strictEqual(
  ('keep ? this.data.priceTouched : false'.match(PRICE_TOUCHED_KEY_RE) || []).length, 0,
  '阴性对照：三元表达式里的 `this.data.priceTouched :` 不是写入点'
)
const priceTouchedKeyCount = (saleJsNoCommentsForMultiModePin.match(PRICE_TOUCHED_KEY_RE) || []).length
assert.strictEqual(
  priceTouchedKeyCount, 2,
  '字面量 "priceTouched:" 应当恰好出现 2 次（data{} 初始值 + pricePatch 的 return），'
    + '实为 ' + priceTouchedKeyCount + ' 次——多出来的是有地方绕开 pricePatch 单独写了'
    + '归属标志，那就等于让它和 unitPrice 分头走'
)
const PRICE_TOUCHED_WRITE_RE = /(?:\.\s*priceTouched\s*=(?!=)|\[\s*['"]priceTouched['"]\s*\])/g
assert.strictEqual(
  ('patch.priceTouched = true'.match(PRICE_TOUCHED_WRITE_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出属性赋值 `patch.priceTouched = true`（onField 的写法）'
)
assert.strictEqual(
  ('if (this.data.priceTouched === true) return'.match(PRICE_TOUCHED_WRITE_RE) || []).length, 0,
  '阴性对照：`=== ` 是比较不是写入'
)
const priceTouchedWrites = saleJsNoCommentsForMultiModePin.match(PRICE_TOUCHED_WRITE_RE) || []
assert.strictEqual(
  priceTouchedWrites.length, 1,
  '属性赋值形态的 priceTouched 写入应当恰好 1 处（onField 里那句 `patch.priceTouched = '
    + 'true`，唯一的置位点），实为 ' + priceTouchedWrites.length + ' 处'
)
const onFieldBody = stripCommentsForMultiModePin(pageMethod(saleJs, 'onField'))
assert.strictEqual(
  (onFieldBody.match(PRICE_TOUCHED_WRITE_RE) || []).length, 1,
  '那唯一一处必须在 onField 里——挪到别的方法就说明置位点不止一个了，'
    + '「框里这个值是不是人填的」会开始答错'
)

// 「方法名单」的另一半：pickSize / pickAllSizes 是两个改变选中集合的入口，它们只准
// 把价的事**转交出去**（applyProductState / applySizeSelection），自己一个字都不许碰。
// 审计那条实证插的正是 pickAllSizes——它当时不在任何名单里，插进去也没人红。
// 先给剥注释器过一道对照：这条钉子判的是「方法体里没有 unitPrice 这个词」，
// 万一剥注释器把代码也一起剥了，断言会静默变成恒真。
const stripProbe = stripCommentsForMultiModePin('  // 注释里提到 unitPrice\n  px.unitPrice = 1\n')
assert.strictEqual(
  stripProbe.indexOf('注释里提到'), -1,
  '阳性对照：剥注释器应当真的把行注释剥掉——剥不掉的话下面那条会因为方法体里的'
    + '注释提到 unitPrice 而误红'
)
assert.ok(
  stripProbe.indexOf('px.unitPrice = 1') >= 0,
  '阴性对照：剥注释器不许把代码一起剥掉——剥掉了下面那条 indexOf === -1 就是恒真的假绿'
)
;['pickSize', 'pickAllSizes'].forEach(function (name) {
  const body = stripCommentsForMultiModePin(pageMethod(saleJs, name))
  ;['unitPrice', 'priceTouched'].forEach(function (field) {
    assert.strictEqual(
      body.indexOf(field), -1,
      name + ' 的方法体里不许出现 ' + field + '——这两个入口只准把价的事转交给 '
        + 'applyProductState / applySizeSelection，自己碰就又多了一个绕开 pricePatch 的'
        + '写入点（2026-09-03 审计的实证就插在 pickAllSizes 里，当时零断言变红）'
    )
  })
})

console.log('sale-spec-view tests passed')
