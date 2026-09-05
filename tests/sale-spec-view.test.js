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
    // selectProduct 是 onShow 回填的原路（onShow 末尾 `this.selectProduct(this.data.productId)`），
    // 抽进来是为了让「离开页面再回来」那组断言走真入口，而不是直接调 applyProductState
    // 自己替它决定 same / selectedColor / selectedSizes 三个参数——那等于把被测的分支
    // 判断转写进测试里。
    'pricePatch', 'applyProductState', 'selectProduct', 'applySizeSelection', 'pickColor', 'pickSize',
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
// D1 这种**纯**派生量会先在组 (1) 响；但**合取形态**（标志 AND 派生量）
// 只有这一条抓得到，它有独占杀伤。（上一版这里写的是「主杀伤不在这一条
// 身上」——**说少了**。本仓的「断言不要吹过头」是反过吹，但说少一样会让
// 后人误删。）
const sameTgt = multiOnBlack()
typePrice(sameTgt, String(pWhiteM.salePrice))
tapColor(sameTgt, '\u767d\u8272')
assert.strictEqual(sameTgt.data.unitPrice, String(pWhiteM.salePrice), '前提：这一步两种实现的值相同')
assert.strictEqual(
  sameTgt.data.priceTouched, true,
  '手打的数恰好等于追平目标时，走的仍必须是「保留」那条路（标志留 true）'
)

// (2c-4) 「档价」有两个自然读法：**该格的 SKU 档价**与**商品档价**。
// 上面三组钉的都是前一个。后一个同样能把标志写成派生量，而且逃在**置位点**：
//     onField 里 `patch.priceTouched = !!value && value !== String(product.salePrice)`
// （决策点上的同族变异已经被组 (1) 抓住，逃的只有置位点这一支。）
//
// 2026-09-04 复审实测：这个变异下 `npm test` **全套绿**，而深度 5 的序列差分
// 有 **168 条**价格分叉：店主在多选态手打商品档价 39，换个颜色就被无声改成 59。
// 这正是本组那句「标志是谁写的，不是等不等于档价」要守的形态。
const sameProd = multiOnBlack()
assert.notStrictEqual(
  String(priced.product.salePrice), String(pWhiteM.salePrice),
  '前提：商品档价不许等于追平目标，否则本组分不出「保留」和「追平」'
)
typePrice(sameProd, String(priced.product.salePrice))
assert.strictEqual(
  sameProd.data.priceTouched, true,
  '手打的数恰好等于**商品档价**时，归属仍然是店主的——'
    + '置位点写成「值 != 商品档价」的话这里会判成 false'
)
tapColor(sameProd, '\u767d\u8272')
assert.strictEqual(
  sameProd.data.unitPrice, String(priced.product.salePrice),
  '店主手打的数恰好等于商品档价时，换规格一仍要保留 '
    + priced.product.salePrice + '，实为 ' + sameProd.data.unitPrice
    + '——被追平成 ' + pWhiteM.salePrice + ' 就说明置位点把「等于商品档价」'
    + '当成了「没动过」'
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
// onShow 回填：参照格**身份**没变、**档价**变了（22:231）
// ===========================================================================
//
// 病灶（实测复现，不是推测）：applyProductState 的 keepPrice 只判「还是不是同一枚
// SKU」。店主选中黑 M（系统追平到 69），中途去商品编辑把**这一格**的档价改成 79，
// 回销售页 onShow → selectProduct(同一 id) → applyProductState —— 参照格身份没变，
// 判真，框里留着过期的 69。
//
// 危害形态与本仓其它价格 bug 不同，也更重：屏上那个 69 看上去完全正常，只是过期了，
// 没有任何异常提示。按它出货，销售额 / 毛利 / 欠款三个数一起错 —— 静默错账。
//
// 裁定（22:231 逐字）：「没手改过就重新取该格档价，手改过就保留」。
//
// 下面这组要在两次调用之间**改档价**，不能碰上面那份被十几处共用的 priced 夹具。
function repriceFixture() {
  const fx = makePricedFixture()
  return {
    product: fx.product,
    skus: fx.skus,
    cell: function (color, size) {
      const found = inv.findSkuBySpec(fx.skus, fx.product.id, color, size)
      assert.ok(found, '夹具前提：找得到「' + color + ' · ' + size + '」这一格')
      return found
    },
    // 模拟「店主去商品编辑改了这一格的档价」+ 回页面时 onShow 重新 store.getSkus()：
    // **换掉数组里那一枚**，不是原地改字段 —— 顺带证明实现判的是身份（id）与值，
    // 没有偷偷靠对象同一性。data.skus 与 fx.skus 是同一个数组引用（saleHarness 里
    // `skus: fixture.skus`），所以这一换页面侧立刻看得见，与 onShow 的时序同形。
    reprice: function (color, size, price) {
      let idx = -1
      fx.skus.forEach(function (item, i) {
        if (item.productId === fx.product.id && item.color === color && item.size === size) idx = i
      })
      assert.ok(idx >= 0, '夹具前提：找得到要改价的「' + color + ' · ' + size + '」这一格')
      const next = Object.assign({}, fx.skus[idx], { salePrice: price })
      fx.skus[idx] = next
      return next
    }
  }
}

// 单选态选中黑 M、价由系统追平写进去（归属在系统手里）的起手式。
function singleOnBlackM(fx, extra) {
  const cell = fx.cell('黑色', 'M')
  return saleHarness(Object.assign({
    selectedColor: '黑色', selectedSizes: ['M'], multiMode: false,
    skuId: cell.id, unitPrice: String(cell.salePrice), priceTouched: false
  }, extra || {}), fx)
}

// --- (7a) 回填 + 档价变了 + 没手改过 → 重新取该格档价 ------------------------
const staleFx = repriceFixture()
const staleBefore = staleFx.cell('黑色', 'M')
const stale = singleOnBlackM(staleFx)
assert.strictEqual(stale.data.unitPrice, '69', '前提：进入值是黑 M 的旧档价 69')
assert.strictEqual(stale.data.priceTouched, false, '前提：这个值是系统写的，店主没动过')
const staleAfter = staleFx.reprice('黑色', 'M', 79)
assert.strictEqual(
  staleAfter.id, staleBefore.id,
  '前提：改的必须是**同一枚 SKU**（身份没变、只有档价变了）——身份也变了的话 skuId '
    + '判据自己就判假了，这一组测不到要测的东西'
)
assert.notStrictEqual(
  String(staleAfter.salePrice), stale.data.unitPrice,
  '前提：进入值（' + stale.data.unitPrice + '）不许等于期望值（' + staleAfter.salePrice
    + '）——相等的话「回填要重新取档价」这条断言恒真，实现什么都不做也能过'
)
// onShow 的原路：`this.selectProduct(this.data.productId)`。
stale.selectProduct(staleFx.product.id)
assert.strictEqual(
  stale.data.skuId, staleBefore.id,
  '前提：回填之后参照格仍是同一枚 SKU——这一组钉的正是「身份没变、内容变了」，'
    + 'skuId 要是跟着变了就说明夹具没造出要测的形状'
)
assert.strictEqual(
  stale.data.unitPrice, '79',
  '店主改了这一格的档价（69 → 79），回销售页 onShow 回填时单价必须跟着更新到 79，'
    + '实为 ' + stale.data.unitPrice + '——停在旧价看上去完全正常、只是过期了，'
    + '按它出货就是静默错账（销售额 / 毛利 / 欠款一起错）'
)
assert.strictEqual(
  stale.data.priceTouched, false,
  '重新取的是档价，归属仍在系统手里——写成 true 的话下一次换规格一会把这个系统'
    + '写进去的价当成「店主手改的」保留住'
)

// --- (7b) 回填 + 档价变了 + **手改过** → 保留他填的 --------------------------
const heldFx = repriceFixture()
const held = singleOnBlackM(heldFx)
typePrice(held, '88')
assert.strictEqual(held.data.priceTouched, true, '前提：先手改一次')
const heldAfter = heldFx.reprice('黑色', 'M', 79)
assert.notStrictEqual(
  String(heldAfter.salePrice), '88',
  '前提：手改的价不许恰好等于新档价，否则「保留」和「重新取档价」分不出来'
)
assert.notStrictEqual(
  String(heldFx.product.salePrice), '88',
  '前提：手改的价也不许等于商品档价，否则「保留」和「退回商品档价」分不出来'
)
held.selectProduct(heldFx.product.id)
assert.strictEqual(
  held.data.unitPrice, '88',
  '店主手改过本次售价之后，就算这一格的档价在商品编辑里被改了，回填也必须保留他填的 88，'
    + '实为 ' + held.data.unitPrice + '——判据是「没手改过才重新取档价」（22:231）'
)
assert.strictEqual(
  held.data.priceTouched, true,
  '保留的时候归属不变，还是店主的——收走的话他离开页面回来一趟，'
    + '那个 88 在下一次换规格一时就会被无声冲掉'
)

// --- (7c) 回填 + 档价**没**变 → 值不变，不制造无谓的抖动 ----------------------
// **两条，杀伤不一样，别只留一条**：
//   7c-1 钉值 + 钉参照格身份（`skuId` 不该变）。它在**单选态**里两种实现给的是同一个数
//        （没手改过时框里那个值本来就等于追平目标），所以它抓不到「判据写坏」那一类。
//        **没找到只让它红的变异**——2026-09-04 两轮审计跑过的变异里，每一个能让它红的
//        都同时打红了别的组（pricePatch 忽略 refSku、调用点把 refSku 换 null、
//        回填时 skuId 写死空串，都是如此）。
//
//        这句话只能说到这儿：**「我跑过的变异里没有」不等于「不存在」**，别写成
//        「只有两个变异能让它红」那种穷不尽的断言——上一版就是这么写的，复审第一次试
//        就找到第三个。同理，这里不列「谁在守参照格取错」的清单：清单会漏（上一版漏了
//        本文件自己新加的 (7h)），而漏掉的那条正是后人会误删的那条。
//        留着是当可读文档，不是当闸——说清它盖不到什么，免得后人拿它当护身符。
//   7c-2 钉的是**走了哪条路**：手打一个恰好等于档价的数，值这一层两种实现相同，
//        分辨点在归属上。走「追平」那条路 priceTouched 会被复位成 false，
//        而店主明明动过这个框。这一条抓的是「回填一律追平」那类实现。
const steadyFx = repriceFixture()
const steadyCell = steadyFx.cell('黑色', 'M')
const steady = singleOnBlackM(steadyFx)
assert.notStrictEqual(
  String(steadyCell.salePrice), String(steadyFx.product.salePrice),
  '前提：该格档价（' + steadyCell.salePrice + '）必须不等于商品档价（'
    + steadyFx.product.salePrice + '），否则 7c-1 连「参照格取错」都抓不到，纯装饰'
)
steady.selectProduct(steadyFx.product.id)
assert.strictEqual(
  steady.data.unitPrice, String(steadyCell.salePrice),
  '档价没变的回填不许改动框里的值，应当仍是 ' + steadyCell.salePrice + '，实为 '
    + steady.data.unitPrice
)
assert.strictEqual(steady.data.skuId, steadyCell.id, '参照格也不该变')

const steadyTypedFx = repriceFixture()
const steadyTypedCell = steadyTypedFx.cell('黑色', 'M')
const steadyTyped = singleOnBlackM(steadyTypedFx)
typePrice(steadyTyped, String(steadyTypedCell.salePrice))
assert.strictEqual(steadyTyped.data.priceTouched, true, '前提：手打就是手打，哪怕值等于档价')
steadyTyped.selectProduct(steadyTypedFx.product.id)
assert.strictEqual(
  steadyTyped.data.unitPrice, String(steadyTypedCell.salePrice),
  '前提：这一步两种实现的值相同（' + steadyTypedCell.salePrice + '），分辨点在下一条'
)
assert.strictEqual(
  steadyTyped.data.priceTouched, true,
  '店主手打的数恰好等于该格档价时，回填走的仍必须是「保留」那条路（归属留 true）——'
    + '被复位成 false 就说明回填一律在追平，那他这个值下一次换规格一就会被无声冲掉'
)

// --- (7d) 单选态点规格二仍一律追平（#127「按错价记账」那条闸，回归钉子）--------
// 与 tests/ui.test.js:1990 同源，也与上面 (6b) 同源，但形状**互补**：(6b) 钉的是
// 0 格 → 1 格；这一条钉的是店主**手改过**之后在格之间来回换（1 格 → 0 格 → 另一格），
// 每一步都必须追平。把 (7a)(7b) 那条「没手改过才重新取档价」的判据顺手扩成
// 「手改过就一直保留」、或者把「身份没变」那一项从判据里删掉，这里立刻红。
const switchCell = saleHarness({
  selectedColor: '黑色', selectedSizes: ['M'], multiMode: false,
  skuId: pBlackM.id, unitPrice: String(pBlackM.salePrice), priceTouched: false
})
typePrice(switchCell, '88')
assert.strictEqual(switchCell.data.priceTouched, true, '前提：先手改一次')
;[String(priced.product.salePrice), String(pBlackL.salePrice)].forEach(function (p) {
  assert.notStrictEqual('88', p,
    '前提：手改的价（88）不许等于下面任何一步的期望值（' + p + '），否则断言恒真')
})
tapSize(switchCell, 'M') // 点掉唯一选中的那一格，回落到「没选规格二」
assert.deepStrictEqual(switchCell.data.selectedSizes, [], '前提：这一下应当把 M 点掉')
assert.strictEqual(
  switchCell.data.unitPrice, String(priced.product.salePrice),
  '单选态点掉规格二之后没有参照格了，单价应当退回商品档价 ' + priced.product.salePrice
    + '，实为 ' + switchCell.data.unitPrice + '——手改过也照样追平，这是 #127 那条闸'
)
assert.strictEqual(switchCell.data.priceTouched, false, '追平了就要复位归属')
tapSize(switchCell, 'L') // 换到另一格
assert.deepStrictEqual(switchCell.data.selectedSizes, ['L'], '前提：这一下应当选中 L')
assert.strictEqual(
  switchCell.data.unitPrice, String(pBlackL.salePrice),
  '单选态换到另一格，单价应当追平到那一枚 SKU 的档价 ' + pBlackL.salePrice + '，实为 '
    + switchCell.data.unitPrice + '——逐格售价是真功能，停在上一格就是按错价记账'
)
assert.strictEqual(switchCell.data.skuId, pBlackL.id, 'skuId 也要跟上')

// --- (7f) 全不选后回填退回商品档价（多选态入口）-----------------------------
// 顺带行为改变，声明 + 钉住：`pickAllSizes` 的「全不选」支不写单价，框里会留着上一批的
// 价；本次修复让下一次回填把它退回商品档价（此时没有参照格）。
// 改动前是 69 → 回填后仍 69；改动后是 69 → 回填后 39。
// **只有「没手改过」时与 (7d) 同结果**，别把这两条读成同一条规则——手改过时它们相反，
// 而且是既有行为，本次不动（复审实测，base 与 fix 一致）：
//
//   · 本条这个入口（多选态全不选）：skuId 两边都是空串 → sameRefCell 判真 →
//     priceTouched 让它**保留**店主填的价。
//   · (7d) 那个入口（单选态点掉规格二）：skuId 是旧格 id、参照格没了 → sameRefCell
//     判假 → **一律追平**，这是 #127 那条闸。
//
// 同一个屏上状态（没选规格二 + 手打过价），两个入口结果不同。要不要抹平是另一轮的事。
// 本条只覆盖「没手改过」那一半，下面的断言也只断这一半。
//
// 两个入口都得有闸。本条**有独占杀伤**，不是纯文档——2026-09-05 重跑实测，这个变异下
// 去掉本条之后全套绿，带上本条只有本条红：
//
//     keepPrice = sameRefCell && (priceTouched || (hasSpecs && !isMulti && !sku))
//
// 红文：「全不选之后回填：没有参照格了，单价应当退回商品档价 39，实为 69」。
//
// （更粗的 `|| !sku` 会同时打红 (7i)——那条守的是无规格商品同一形态。所以要分开二者，
// 变异得带上 `hasSpecs`。这一句在本文件里改过三次：先是漏写了独占杀伤，再是把 `|| !sku`
// 说成「只从这一个漏」而 (7i) 补进来之后它就不成立了，第三次是 2026-09-05：
// 上一版写的变异是 `sameRefCell && (isMulti || priceTouched || (hasSpecs && !sku))`，
// 而 `isMulti` 那一项已经从实现里删掉了（多选态不再豁免，见 (7k)）。照着新实现改写成
// `sameRefCell && (priceTouched || (hasSpecs && !sku))` 之后它**同时打红 (7k) 与 (7l)**——多选态
// 下 `!sku` 也为真，那一项把多选态一并豁免了。要还原成「只有本条红」，变异必须再带上
// `!isMulti`，就是上面那一行。**加断言会让旧的杀伤陈述过期**，不重跑就会留下一句错话。）
//
// 上一版这里两处都写错了，一起记下来当反面教材：
//   1. 夹具用 singleOnBlackM（skuId = 该格 id）——那是**不可达形态**。全不选只在多选态
//      够得到，此时 skuId 恒为空串。用单选态夹具时 base 与 fix 同时判假、同时追平，
//      本条**在 base 上也是绿的**，测不到它声称测的东西。复审跑七组对照当场打回。
//   2. 夹具修好之前我用错误的变异验过一次，得出「没有独占杀伤」并写进了注释。
//      本仓的规矩是「断言不要吹过头」——但**说少了一样有害**：一条被标成纯文档的断言，
//      后人清理时会先删它，而它其实是那条逃逸唯一的闸。
;(function assertDeselectAllThenRefill() {
  const fx = repriceFixture()
  const cell = fx.cell('黑色', 'M')
  // 进入态必须从**多选态**来：`pickAllSizes` 的全不选支要求 sizes.length > 1 且已全选，
  // 只有多选态够得到；而多选态 `skuId` 恒为空串（applySizeSelection 写的）。
  // 拿单选态夹具（skuId = 该格 id）在这里是**不可达形态**，base 与 fix 会同时判假、
  // 同时追平，本条就成了两侧都绿的摆设——上一版正是这么写的，复审当场打回。
  const page = saleHarness({
    selectedColor: '黑色', selectedSizes: ['M', 'L'], multiMode: true,
    skuId: '', unitPrice: String(cell.salePrice), priceTouched: false,
    cellQtys: { 'v:M': '1', 'v:L': '2' }, batchQty: ''
  }, fx)
  assert.strictEqual(page.data.skuId, '', '前提：多选态 skuId 是空串，全不选只能从这儿进来')
  // 全不选：直接调 `pickAllSizes` 本身，不照抄它那一支的写法——照抄的话它自己改了
  // 这里不会知道。（`sizes` 两格且已全选，走的正是 allSelected 那一支。）
  page.pickAllSizes()
  assert.strictEqual(page.data.unitPrice, String(cell.salePrice), '前提：全不选本身不改单价')
  assert.notStrictEqual(String(cell.salePrice), String(fx.product.salePrice),
    '前提：该格档价不许等于商品档价，否则本条分不出「退回」和「没动」')
  // 走 onShow 的真入口 `selectProduct(同 id)`，不手搭 applyProductState 的参数——
  // (7g) 上一版正是栽在手搭出不可达形态上。
  page.selectProduct(fx.product.id)
  assert.strictEqual(page.data.unitPrice, String(fx.product.salePrice),
    '全不选之后回填：没有参照格了，单价应当退回商品档价 ' + fx.product.salePrice
      + '，实为 ' + page.data.unitPrice + '——这是本次修复带来的顺带改变。'
      + '没手改过时与 (7d) 同结果；手改过时两个入口相反，那是既有行为，本条不覆盖')
})()

// --- (7g) 换商品：手改过的价不许跟着跨到另一个商品上 -------------------------
// `sameRefCell` 三项里 `this.data.productId === product.id` 那一项，2026-09-04 审计实测：
// **本条断言补进来之前**，删掉它整个 `npm test` 仍然 exit=0，而穷举差分跑得出行为差异
// ——不是死代码，是没人测。（这句是历史陈述：补上本条之后，再删那一项这里就红。
// 也不写具体组数——那个网格的维度没有记在仓里，谁都复核不了；三轮审计各用自己的网格
// 独立跑出了同一个定性结论。）
// base 上就有这个洞（base 的判据内联着同两项），本次改动既没造成也没加重，
// 但这一行现在归本次改动管，就地补上。
//
// 漏的形态：`skuId` 两边都是空串（进来之前在多选态所以是空串，换完商品 sku 为 null 也是
// 空串），`'' === ''` 判真——少了 productId 那一项，A 商品手填的批价会**原样带到 B 商品**，
// 屏上没有任何提示。按它出货就是拿 A 的价记 B 的账。
//
// **必须走 `selectProduct` 这个真入口。** `sale.js` 里 `applyProductState` 三个调用点
// （`purchase.js` 有个同名方法，不相干），
// `this.data.productId !== product.id` 只可能来自 `selectProduct` 的 `same === false` 支，
// 而那一支传的是 `('', [], cart)`——颜色空、尺码空。上一版这里手搭了「换完商品还停在
// 多选态」的参数，那是 `selectProduct` 永远不会产生的形态，于是只挡住了 `isMulti` 那一支，
// 真实泄漏走的是 `priceTouched` 那一支：复审拿 M13（productId 只守 isMulti）实测，
// **整套 `npm test` 全绿**而 888 原样进了 B 商品。
;(function assertPriceDoesNotCrossProducts() {
  const fx = repriceFixture()
  const typed = '888'
  assert.notStrictEqual(typed, String(fx.product.salePrice),
    '前提：手填价不许等于目标商品档价，否则本组分不出「带过来了」和「追平了」')
  const page = saleHarness({
    productId: 'another-product', selectedColor: '黑色', selectedSizes: ['M', 'L'],
    multiMode: true, skuId: '', unitPrice: typed, priceTouched: true,
    cellQtys: { 'v:M': '1', 'v:L': '2' }, batchQty: ''
  }, fx)
  page.selectProduct(fx.product.id)
  assert.deepStrictEqual(page.data.selectedSizes, [],
    '前提：换商品走的是 same===false 那一支，选中尺码被清空——这一条就是要测那个形态')
  assert.strictEqual(page.data.selectedColor, '', '前提：颜色同样被清空')
  assert.strictEqual(page.data.unitPrice, String(fx.product.salePrice),
    '换到另一个商品，手填的 ' + typed + ' 必须被冲掉、追平到新商品档价 '
      + fx.product.salePrice + '，实为 ' + page.data.unitPrice
      + '——换完之后 skuId 两边都是空串，只有 productId 那一项拦得住')
})()

// --- (7h) 价格框被清空 → 回填要把档价填回来，不许留空 -------------------------
// `sameRefCell` 的 `!!this.data.unitPrice` 那一项，同一轮审计实测：**本条断言补进来之前**
// 删掉它全套仍绿，而穷举差分跑得出行为差异（同样是历史陈述——补上本条之后再删就红）。
// 漏的形态：店主把价格框清空（onField 记 priceTouched=true、
// unitPrice=''），再 onShow 回填——少了这一项就判成「他手改过，保留」，于是保留一个
// **空串**，价格框一直空着。
;(function assertClearedPriceRefills() {
  const fx = repriceFixture()
  const cell = fx.cell('黑色', 'M')
  const page = saleHarness({
    productId: fx.product.id, selectedColor: '黑色', selectedSizes: ['M'],
    multiMode: false, skuId: cell.id, unitPrice: String(cell.salePrice), priceTouched: false
  }, fx)
  typePrice(page, '')
  assert.strictEqual(page.data.unitPrice, '', '前提：框已清空')
  assert.strictEqual(page.data.priceTouched, true, '前提：清空也算动过这个框')
  page.selectProduct(fx.product.id)   // 同上，走真入口
  assert.strictEqual(page.data.unitPrice, String(cell.salePrice),
    '框被清空之后回填，应当把该格档价 ' + cell.salePrice + ' 填回来，实为「'
      + page.data.unitPrice + '」——保留空串等于让店主对着空价格框出货')
})()

// --- (7i) 无规格商品：同一条修复也覆盖它 -----------------------------------
// 复审指出这是本次改动**未声明的行为延伸**：`applyProductState` 里 `hasSpecs === false`
// 时 color/sizes 被清空、`sku` 恒为 null，走的仍是同一个 `sameRefCell`。改动前回填保留
// 框里的旧值，改动后没手改过就重新取**商品档价**。方向与本次修复一致（店主改了档价，
// 回销售页要跟着走），但 sale.js 那段规则只写了「该格档价」和单选/多选，没提这一形态。
// 在这里声明并钉住——顺带证明「没有规格」不是绕过这条修复的通道。
;(function assertNoSpecProductAlsoReprices() {
  const bare = inv.createProduct({
    name: '毛巾', costPrice: 4, salePrice: 12, stock: 20, alertQty: 2, colors: [], sizes: []
  }, 2000, 'p-bare')
  const fx = { product: bare, skus: [] }
  const page = saleHarness({
    productId: bare.id, selectedColor: '', selectedSizes: [],
    multiMode: false, skuId: '', unitPrice: String(bare.salePrice), priceTouched: false
  }, fx)
  assert.strictEqual(inv.productHasSpecs(bare), false, '前提：这是无规格商品')
  // 店主去商品编辑把档价 12 改成 15，回销售页 onShow → selectProduct(同 id)。
  // 改档价靠的是**换掉 fx.product**：saleHarness 的 store.getProduct 闭包读的就是它，
  // 与 onShow 先刷 store 再 selectProduct 的时序同形。不要以为是靠 data.products 生效。
  const repriced = Object.assign({}, bare, { salePrice: 15 })
  fx.product = repriced
  assert.notStrictEqual(String(repriced.salePrice), page.data.unitPrice,
    '前提：新档价不许等于框里的旧值，否则本组分不出「跟着更新」和「没动」')
  page.selectProduct(repriced.id)
  assert.strictEqual(page.data.unitPrice, String(repriced.salePrice),
    '无规格商品改了档价，回填也要跟着更新到 ' + repriced.salePrice
      + '，实为 ' + page.data.unitPrice
      + '——没有规格不该成为绕过这条修复的通道')
})()

// --- (7j) 无规格商品 + 手改过 → 保留他填的（(7i) 的另一半）-------------------
// (7i) 只覆盖「没手改过」那一半。复审实测下面两个变异**都是 0 失败**，说明另一半没人守：
//     keepPrice = sameRefCell && hasSpecs && (isMulti || priceTouched)
//     keepPrice = sameRefCell && (isMulti || (priceTouched && hasSpecs))
// 两个都会让「无规格商品手改过的价」在回填时被冲掉——店主填的数无声变成商品档价。
// (7b) 是有规格版的同一半，无规格版就缺这一条。
;(function assertNoSpecKeepsTypedPrice() {
  const bare = inv.createProduct({
    name: '毛巾', costPrice: 4, salePrice: 12, stock: 20, alertQty: 2, colors: [], sizes: []
  }, 2000, 'p-bare-2')
  const fx = { product: bare, skus: [] }
  const page = saleHarness({
    productId: bare.id, selectedColor: '', selectedSizes: [],
    multiMode: false, skuId: '', unitPrice: String(bare.salePrice), priceTouched: false
  }, fx)
  typePrice(page, '77')
  assert.strictEqual(page.data.priceTouched, true, '前提：手打过价，归属归店主')
  const repriced = Object.assign({}, bare, { salePrice: 15 })
  fx.product = repriced
  assert.notStrictEqual('77', String(repriced.salePrice),
    '前提：手填价不许等于新档价，否则分不出「保留」和「追平」')
  page.selectProduct(repriced.id)
  assert.strictEqual(page.data.unitPrice, '77',
    '无规格商品店主手填的 77 必须保留，实为 ' + page.data.unitPrice
      + '——被改成 ' + repriced.salePrice + ' 就说明归属那一层漏了无规格这一支')
  assert.strictEqual(page.data.priceTouched, true, '归属仍在店主手里，不该被复位')
})()

// --- (7m) 多选态把价格框清空 → 回填填第一枚选中格的档价（(7h) 的多选版）---------
// 复审指出这是本次改动**悄悄换掉、没人守**的一格：删掉 `isMulti ||` 之后，多选态清空
// 价格框再回填，从「填商品档价」变成「填第一枚选中格的档价」。方向对——多选态那个值的
// 正主本来就是第一枚选中格——但没有断言分得出来。声明并钉住。
;(function assertMultiClearedPriceRefillsFromRefCell() {
  const fx = repriceFixture()
  const first = fx.cell('黑色', 'M')
  const page = singleOnBlackM(fx, { qty: '1' })
  tapSize(page, 'L')   // T4：进多选
  assert.strictEqual(page.data.multiMode, true, '前提：在多选形态')
  assert.strictEqual(page.data.skuId, '', '前提：多选态 skuId 是空串')
  typePrice(page, '')
  assert.strictEqual(page.data.unitPrice, '', '前提：框已清空')
  assert.strictEqual(page.data.priceTouched, true, '前提：清空也算动过这个框')
  assert.notStrictEqual(String(first.salePrice), String(fx.product.salePrice),
    '前提：第一枚选中格的档价不许等于商品档价，否则本组分不出这两种实现')
  page.selectProduct(fx.product.id)
  assert.strictEqual(page.data.unitPrice, String(first.salePrice),
    '多选态清空价格框之后回填，应当填第一枚选中格的档价 ' + first.salePrice
      + '，实为 ' + page.data.unitPrice + '——填商品档价 ' + fx.product.salePrice
      + ' 是本次改动之前的行为，那个数不是这一批任何一行的价')
})()

// --- (7e) 多选态回填不许被打回商品档价 ----------------------------------------
// 多选态下 applyProductState 算出来的 `sku` 恒为 null，拿它当追平目标就会退回商品档价，
// 而框里那个值的正主是「第一枚选中格」（applySizeSelection / pickColor 多选支写进去的），
// 两者本来就不相等。追平目标取错，每一次 onShow 回填都会把整批价从 69 打回 39 —— 正是
// tests/ui.test.js 里「多选态 skuId 记空串」那条注释警告的形状。
// 上面 (5) 钉的是多选态**手改过**的回填；这一条补的是**没手改过**那一半。
//
// （2026-09-05 更新：这条闸原先是靠「多选态整个跳过过期判定」实现的，本条的注释也是
// 那么写的。那个写法顺带把**多选态自己的档价过期**一起豁免掉了，见下面 (7k)。现在闸
// 换成了「追平目标取第一枚选中格」——本条断的**值**一个字没改，只是它现在守的是
// 「refSku 取对了没有」，不再是「跳过判定了没有」。）
const multiBack = multiOnBlack()
assert.strictEqual(multiBack.data.priceTouched, false, '前提：店主没动过这个框')
assert.strictEqual(multiBack.data.skuId, '', '前提：多选态 skuId 恒为空串')
assert.notStrictEqual(
  String(pBlackM.salePrice), String(priced.product.salePrice),
  '前提：第一枚选中格的档价必须不等于商品档价，否则「保留」和「打回商品档价」分不出来'
)
multiBack.selectProduct(priced.product.id)
assert.strictEqual(
  multiBack.data.unitPrice, String(pBlackM.salePrice),
  '多选态离开页面再回来，整批价应当仍是第一枚选中格的档价 ' + pBlackM.salePrice
    + '，实为 ' + multiBack.data.unitPrice + '——被打回商品档价 '
    + priced.product.salePrice + ' 就说明追平目标取成了多选态恒为 null 的那个 sku，'
    + '没取第一枚选中格'
)
assert.deepStrictEqual(multiBack.data.selectedSizes, ['M', 'L'], '回填不该动选中集合')

// --- (7k) 多选态回填：第一枚选中格的**档价变了** → 跟着更新 ------------------
// (7a) 是这条规则的单选态版本。多选态在 #138 里被**整个豁免**掉了（当时的判据是
// `sameRefCell && (isMulti || priceTouched)`，isMulti 那一支让多选态永远「保留」），
// 那是刻意留下并已声明的缺口：店主在多选态选中黑 M + L（系统把整批价追平到第一枚
// 选中格黑 M 的档价 69），中途去商品编辑把**黑 M 这一格**的档价改成 79，回销售页
// onShow → selectProduct → applyProductState，框里仍是过期的 69。危害与 (7a) 同类、
// 同样是静默错账，而且更重一点：多选态是整批一个价，错的是这一批**每一行**。
//
// 修法与 (7a) 同一条规则，差别只在参照格的取法：多选态的参照格是「第一枚选中格」
// （firstSelectedSku），单选态是当前唯一 SKU。判据两边都是「没手改过就重新取」。
//
// **进入态由真入口造**：从单选态选中黑 M 出发，点 L 进多选（T4，走 applySizeSelection）。
// 手搭一个 `skuId: ''` 的多选态也能过，但那样测的是我自己写的形状；这里让真代码去写
// skuId / unitPrice，顺带把「T4 之后的进入态到底长什么样」也钉住了。
//
// 杀伤（2026-09-05 实测，写清跑过什么，不写穷不尽的断言）：
//   · 拿 e8bc617 的 sale.js 跑，**只留本条**也红（'69' !== '79'）——不是靠别的组带红的。
//   · 把豁免加回去（`keepPrice = sameRefCell && (isMulti || priceTouched)`）本条红，
//     但 (7l) **同时**也红。所以本条不是**那个**变异的独占闸。
//   · 但它确实有独占杀伤，换个变异就现出来了——只红本条这三条断言，(7l) 绿：
//
//         keepPrice = sameRefCell && (priceTouched || (isMulti && this.data.selectedColor === color))
//
//     （上一版这里写的是「没去找只让本条红的变异」。复审替我找到了、我自己复现确认。
//     诚实的自陈不算错，但**能找到就该写进去**：一条被标成「只是正面陈述」的断言，
//     后人清理时会先删它。本仓在 (7f) 上正反两个方向都栽过。）
;(function assertMultiRefillTakesFreshCellPrice() {
  const fx = repriceFixture()
  const cellBefore = fx.cell('黑色', 'M')
  const page = singleOnBlackM(fx, { qty: '1' })
  tapSize(page, 'L')   // T4：1 → 2 格，进多选
  assert.deepStrictEqual(page.data.selectedSizes, ['M', 'L'], '前提：这一下应当进多选形态')
  assert.strictEqual(page.data.multiMode, true, '前提：|Z| 1→2')
  assert.strictEqual(page.data.skuId, '', '前提：多选态 skuId 由真代码写成空串')
  assert.strictEqual(page.data.unitPrice, String(cellBefore.salePrice),
    '前提：进多选之后整批价是第一枚选中格黑 M 的档价 ' + cellBefore.salePrice)
  assert.strictEqual(page.data.priceTouched, false, '前提：这个值是系统写的，店主没动过')

  const cellAfter = fx.reprice('黑色', 'M', 79)
  assert.strictEqual(cellAfter.id, cellBefore.id,
    '前提：改的必须是**同一枚 SKU**（身份没变、只有档价变了）——这一组钉的正是这个形状')
  assert.notStrictEqual(String(cellAfter.salePrice), page.data.unitPrice,
    '前提：进入值（' + page.data.unitPrice + '）不许等于期望值（' + cellAfter.salePrice
      + '），相等的话这条断言恒真，实现什么都不做也能过')
  assert.notStrictEqual(String(cellAfter.salePrice), String(fx.product.salePrice),
    '前提：新档价不许等于商品档价（' + fx.product.salePrice + '），否则「取了第一枚选中格」'
      + '和「退回商品档价」这两种实现分不出来')

  page.selectProduct(fx.product.id)   // onShow 的原路
  assert.strictEqual(page.data.unitPrice, '79',
    '多选态下店主改了第一枚选中格的档价（69 → 79），回销售页 onShow 回填时整批价必须'
      + '跟着更新到 79，实为 ' + page.data.unitPrice + '——停在旧价看上去完全正常、'
      + '只是过期了，按它出货这一批每一行都错（销售额 / 毛利 / 欠款一起错）')
  assert.strictEqual(page.data.priceTouched, false,
    '重新取的是档价，归属仍在系统手里——写成 true 的话下一次换规格一会把这个系统'
      + '写进去的价当成「店主手改的」保留住')
  assert.strictEqual(page.data.skuId, '',
    '回填之后仍在多选态，skuId 仍记空串——写成参照格 id 的话 sameRefCell 会结构性恒假，'
      + '店主手改的批价每次回填都被冲掉')
  assert.deepStrictEqual(page.data.selectedSizes, ['M', 'L'], '回填不该动选中集合')

  // 记账后果：两格各 1 件，出去的两行都得按新档价 79。上面那条只看 data.unitPrice。
  const qtys = {}
  qtys[page.cellKey('M')] = '1'
  qtys[page.cellKey('L')] = '1'
  page.setData({ cellQtys: qtys })
  const lines = page.currentLines()
  assert.strictEqual(lines.error, '', '两格都填了数，不该有 error')
  assert.strictEqual(lines.lines.length, 2, '两格各一行')
  lines.lines.forEach(function (line) {
    assert.strictEqual(line.unitPrice, 79,
      '「' + line.size + '」这一行应当按更新后的 79 记账，实为 ' + line.unitPrice
        + '——整批一个价，过期的话这一批每一行一起错')
  })
})()

// --- (7l) 多选态回填：参照格要按**这一次归一化之后**的颜色取 ------------------
// `applyProductState` 里 `color` 可能与 `this.data.selectedColor` 不同：`colors.length === 1`
// 时它会自动选中那一个色，而 data 要到之后 setData 才跟上。可达形态（product-edit 的
// applySpecRemoval，pages/product-edit/product-edit.js:388/410）：商品原有黑 / 白两色，
// 店主在销售页多选态选中**黑** M + L（整批价 = 黑 M 的 69），中途去商品编辑把「黑色」这个
// 取值删掉，只剩白色；回销售页 onShow → 归一化把 color 定成白色、屏上也显示白色，
// 于是这一批出去的行是白 M / 白 L，价就该是白 M 的 59。
//
// **前置条件**：删色只在该色各格**库存为 0** 时可达——`inventory.applyProductSkus`
// （utils/inventory.js:535）和 `product-edit.js:380-390` 的 `removeColor` 两道闸都会拦
// 「还有库存，不能删除该规格」。本组夹具用 `stock: 9` + 手工 splice 直接造末态，走的不是
// 那条真路径；复审用库存 0 走**真** `applyProductSkus` 复现过，结论一致。照注释去真 UI
// 复现时记得先把库存清零，否则会撞上那道闸、以为形态不可达。
//
// 三种实现给三个不同的数，这一条同时挡住另外两个：
//   · 本次改动之前（多选态一律保留）      → 69，拿**已经不存在的那个颜色**的价记白色的账
//   · 参照格读 this.data.selectedColor    → 取不到（黑色的 SKU 已经没了）→ 退回商品档价 39
//   · 按归一化之后的 color 取             → 59（白 M），与真正出去的那两行对得上
//
// 杀伤（2026-09-05 实测）：把 `firstSelectedSku(product, sizesSel, color)` 的第三个实参
// 去掉（= 回去读 this.data.selectedColor）时，**去掉本条之后全套绿，带上本条只有本条红**
// ——这一条是那个实参唯一的闸。另外拿 e8bc617 的 sale.js 跑，只留本条也红。
;(function assertMultiRefillUsesNormalizedColor() {
  const fx = repriceFixture()
  const blackM = fx.cell('黑色', 'M')
  const whiteM = fx.cell('白色', 'M')
  const page = singleOnBlackM(fx, { qty: '1' })
  tapSize(page, 'L')
  assert.deepStrictEqual(page.data.selectedSizes, ['M', 'L'], '前提：进多选形态')
  assert.strictEqual(page.data.unitPrice, String(blackM.salePrice),
    '前提：整批价是黑 M 的 ' + blackM.salePrice)

  // 模拟「店主在商品编辑里删掉了黑色这个取值」+ 回页面时 onShow 重新取商品与 SKU：
  // 商品的 colors 只剩白色，黑色那两枚 SKU 一并消失。data.skus 与 fx.skus 是同一个
  // 数组引用（saleHarness 里 `skus: fixture.skus`），所以就地删就等价于 onShow 重取。
  fx.product = Object.assign({}, fx.product, { colors: ['白色'] })
  for (let i = fx.skus.length - 1; i >= 0; i--) {
    if (fx.skus[i].color === '黑色') fx.skus.splice(i, 1)
  }
  assert.strictEqual(fx.skus.length, 2, '前提：只剩白色两枚 SKU')
  ;[String(blackM.salePrice), String(fx.product.salePrice)].forEach(function (other) {
    assert.notStrictEqual(String(whiteM.salePrice), other,
      '前提：白 M 的档价（' + whiteM.salePrice + '）不许等于 ' + other
        + '，否则三种实现里有两种给出同一个数，本条分不出来')
  })

  page.selectProduct(fx.product.id)
  assert.strictEqual(page.data.selectedColor, '白色',
    '前提：只剩一个色时归一化会自动选中它，屏上显示的就是白色')
  assert.strictEqual(page.data.multiMode, true, '前提：仍在多选形态')
  assert.strictEqual(page.data.unitPrice, String(whiteM.salePrice),
    '删掉当前选中的颜色之后回填，整批价应当取**归一化之后**那个色的第一枚选中格'
      + '（白 M）的档价 ' + whiteM.salePrice + '，实为 ' + page.data.unitPrice
      + '——停在 ' + blackM.salePrice + ' 是拿已经不存在的黑色的价记白色的账；'
      + '退成 ' + fx.product.salePrice + ' 是参照格读了还没跟上的 data.selectedColor、'
      + '取不到格子')

  // 记账后果：出去的两行确实是白色那两格，价与上面那个数对得上。
  const qtys = {}
  qtys[page.cellKey('M')] = '1'
  qtys[page.cellKey('L')] = '1'
  page.setData({ cellQtys: qtys })
  const lines = page.currentLines()
  assert.strictEqual(lines.lines.length, 2, '两格各一行')
  lines.lines.forEach(function (line) {
    assert.strictEqual(line.color, '白色', '「' + line.size + '」这一行应当记在白色上')
    assert.strictEqual(line.unitPrice, whiteM.salePrice,
      '「' + line.size + '」这一行应当按 ' + whiteM.salePrice + ' 记账，实为 ' + line.unitPrice)
  })
})()

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
