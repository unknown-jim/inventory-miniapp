const assert = require('assert')
const fs = require('fs')
const path = require('path')
const inv = require('../utils/inventory')
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
const bareCellQtyAccess = saleJsNoCommentsForMultiModePin.match(/cellQtys\s*\[\s*(?!cellKey\s*\()/g) || []
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

console.log('sale-spec-view tests passed')
