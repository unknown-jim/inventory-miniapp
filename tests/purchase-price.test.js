const assert = require('assert')
const fs = require('fs')
const path = require('path')
const inv = require('../utils/inventory')
const util = require('../utils/util')

// ===========================================================================
// 进货页「本次进价」的归属
// ===========================================================================
//
// 病灶（销售侧 PR #138 的实测复现，进货侧同形）：applyProductState 的 keepPrice 旧判据
// 只判**身份**（productId 一样 + skuId === nextSkuId + 框里有值）。店主选中某一格
// （系统把本次进价追平到该格档案进价），中途去商品编辑改了**这一格**的进价，回进货页
// onShow → selectProduct(同一 id) → applyProductState —— 同一枚 SKU 判真，框里留着
// **过期的旧进价**。
//
// 危害形态：屏上那个数看上去完全正常，只是过期了。按它入库，进货金额 / 成本 / 毛利 /
// 应付一起错 —— 静默错账。
//
// 修法与销售侧同构：给「框里这个值是谁给的」立一个标志 priceTouched，判据从「身份没变」
// 收紧成「身份没变 **且** 这个值是店主自己给的」。没人动过就重新取档案进价。
//
// 下面这些不是静态钉子，是**真的把 purchase.js 里那几个方法拿出来跑**：purchase.js 是
// 小程序 Page 文件、不能 require，但方法体是纯文本，抽出来重新组装成一个对象就能在
// Node 里执行。这样断言盯的是源码本身，不是一份转写。
// ===========================================================================

const purchaseJs = fs.readFileSync(path.join(__dirname, '../pages/purchase/purchase.js'), 'utf8')

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

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (block) { return block.replace(/[^\n]/g, ' ') })
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// selectProduct 是 onShow 回填的原路（onShow 里 `this.selectProduct(this.data.productId)`），
// 抽进来是为了让「离开页面再回来」那组断言走真入口，而不是直接调 applyProductState
// 自己替它决定 skuId 那个参数 —— 那等于把被测的分支判断转写进测试里。
// pickRecent / pickSku / onField 同理：三个改动点各自的真入口。
const METHOD_NAMES = [
  'pricePatch', 'applyProductState', 'selectProduct', 'pickSku', 'pickRecent',
  'loadRecent', 'onField', 'skuOptionsOf', 'baseCostOf', 'refreshAmount', 'submit'
]

// RECENT_SCAN / RECENT_KEEP 是模块级常量，不是方法，loadRecent 用得到 ——
// 同样把源码搬进同一个作用域，不转写。
const constSrc = ['RECENT_SCAN', 'RECENT_KEEP'].map(function (name) {
  const m = new RegExp('\\nconst ' + name + ' = \\d+').exec(purchaseJs)
  assert.ok(m, '夹具前提：purchase.js 里应当找得到模块级常量 ' + name)
  return m[0]
}).join('')

const methodBodies = METHOD_NAMES.map(function (name) {
  return pageMethod(purchaseJs, name)
}).join(',')

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
// 四格档案进价刻意互不相同，且都不等于商品档案进价。ui.test.js 那边吃过这个亏：
// 种子四格全等于商品价时，「追平到该格档价」「退回商品档价」「什么都没做」三种实现
// 给出同一个数，断言恒真。
function makeFixture() {
  const nextId = idFactory()
  const spec = inv.createProduct({
    name: '短袖', costPrice: 20, salePrice: 59, stock: 0, alertQty: 4,
    colors: ['黑色', '白色'], sizes: ['M', 'L']
  }, 1000, 'p-spec')
  const specBuilt = inv.applyProductSkus(spec, [], [
    { color: '黑色', size: 'M', stock: 9, costPrice: 28, salePrice: 69, alertQty: 4 },
    { color: '黑色', size: 'L', stock: 9, costPrice: 26, salePrice: 65, alertQty: 4 },
    { color: '白色', size: 'M', stock: 9, costPrice: 24, salePrice: 59, alertQty: 4 },
    { color: '白色', size: 'L', stock: 9, costPrice: 22, salePrice: 49, alertQty: 4 }
  ], 1100, nextId)

  // 无规格商品：baseCostOf 走 product.costPrice 那一档。
  const plain = inv.createProduct({
    name: '矿泉水', costPrice: 15, salePrice: 25, stock: 40, alertQty: 5
  }, 1000, 'p-plain')
  const plainBuilt = inv.applyProductSkus(plain, specBuilt.skus, null, 1100, nextId)

  // 待加工商品：baseCostOf 走 findBlankSku 那一档。applyProductSkus 建出来的待加工格
  // costPrice 取的是 product.costPrice，两者相等就分不出「取了待加工格」和「退回商品
  // 档价」—— 下面把待加工格的进价单独挪开（真实路径上 applyPurchase 也是这么把它改
  // 掉的：utils/inventory.js 的 blank 分支 `sku.costPrice = unitPrice`）。
  const blank = inv.createProduct({
    name: '卫衣', costPrice: 45, salePrice: 99, stock: 20, alertQty: 5,
    colors: ['黑色'], sizes: ['M'], blankProcess: true
  }, 1000, 'p-blank')
  const blankBuilt = inv.applyProductSkus(blank, plainBuilt.skus, null, 1100, nextId)
  const blankSkus = blankBuilt.skus.map(function (item) {
    return (item.productId === 'p-blank' && item.isBlank)
      ? Object.assign({}, item, { costPrice: 41 })
      : item
  })

  return {
    products: [specBuilt.product, plainBuilt.product, blankBuilt.product],
    skus: blankSkus
  }
}

// 夹具前提逐条钉死。这里钉的比下面用到的多——白M(24) 与黑L(26) 目前没有断言用到，
// 钉着是为了「换一格」时随手取得到一个价不同的格子。不要读成「少了任何一条下面就假绿」。
;(function pinFixture() {
  const fx = makeFixture()
  const cost = function (color, size) {
    const found = inv.findSkuBySpec(fx.skus, 'p-spec', color, size)
    assert.ok(found, '夹具前提：找得到「' + color + ' · ' + size + '」这一格')
    return found.costPrice
  }
  const spec = fx.products[0]
  const plain = fx.products[1]
  const blankSku = inv.findBlankSku(fx.skus, 'p-blank')
  assert.ok(blankSku, '夹具前提：待加工商品应当有一条 isBlank 的 sku')
  const all = [
    ['黑 M', cost('黑色', 'M'), 28], ['黑 L', cost('黑色', 'L'), 26],
    ['白 M', cost('白色', 'M'), 24], ['白 L', cost('白色', 'L'), 22],
    ['分规格商品档价', spec.costPrice, 20], ['无规格商品档价', plain.costPrice, 15],
    ['待加工格', blankSku.costPrice, 41], ['待加工商品档价', fx.products[2].costPrice, 45]
  ]
  all.forEach(function (row) {
    assert.strictEqual(row[1], row[2], '夹具前提：' + row[0] + ' 的进价应当是 ' + row[2])
  })
  all.forEach(function (a, i) {
    all.forEach(function (b, j) {
      if (i < j) {
        assert.notStrictEqual(a[1], b[1],
          '夹具前提：这八个进价必须两两不同，「' + a[0] + '」与「' + b[0] + '」撞了 ——'
            + '撞了的话下面至少有一条断言分不出「取了这一格」和「取了别处」')
      }
    })
  })
  assert.strictEqual(inv.productHasSpecs(plain), false, '夹具前提：矿泉水是无规格商品')
  assert.strictEqual(inv.isBlankProcess(fx.products[2]), true, '夹具前提：卫衣走待加工')
})()

// fx.skus / fx.products 会被 reprice* 整份换掉（造新数组 + 新对象，不原地改字段），
// 所以 store 的两个读法都在**调用时**读 fx 上的属性 —— 与 onShow 每次重新
// store.getProducts() / store.getSkus() 同形，顺带证明实现判的是 id 与值，
// 没有偷偷靠对象同一性。
function harness(initial) {
  const built = makeFixture()
  const fx = {
    products: built.products,
    skus: built.skus,
    records: []
  }
  const store = {
    getProduct: function (id) {
      return fx.products.find(function (item) { return item.id === id }) || null
    },
    getSku: function (id) {
      return fx.skus.find(function (item) { return item.id === id }) || null
    },
    listRecords: function () {
      return Promise.resolve({ records: fx.records })
    },
    // submit 只多用这两个。addPurchase 走**真** applyPurchase 落账，不是打桩返回，
    // 这样「提交之后档案进价变成什么」是引擎自己算的，不是测试替它编的。
    getSkus: function () { return fx.skus },
    addPurchase: function (input) {
      const done = inv.applyPurchase(
        fx.products.slice(), fx.records.slice(), input, 9000, 'rec-sub', fx.skus.slice())
      fx.products = done.products
      fx.skus = done.skus
      fx.records = done.records
      return Promise.resolve(done.records[done.records.length - 1])
    }
  }
  const make = new Function('store', 'inventory', 'util',
    constSrc + '\nreturn {' + methodBodies + '\n}')
  const methods = make(store, inv, util)
  METHOD_NAMES.forEach(function (name) {
    assert.strictEqual(typeof methods[name], 'function',
      '夹具前提：应当从 purchase.js 里抽到方法 ' + name + ' —— 抽不到说明它改名或改了'
        + '签名，下面整段就不再是在测源码了')
  })
  const page = Object.assign({
    data: Object.assign({
      products: fx.products, skus: fx.skus, recent: [],
      productId: '', productName: '请选择商品', stockText: '-',
      hasSpecs: false, blankProcess: false, skuId: '', skuOptions: [],
      baseCostText: '', specLabel: '', qty: '', unitPrice: '', priceTouched: false,
      remark: '', amountText: '0.00', totalText: '共 0 件 · ¥0.00', costHint: ''
    }, initial || {}),
    setData: function (patch) { Object.assign(this.data, patch) }
  }, methods)

  page.fx = fx
  page.cell = function (productId, color, size) {
    const found = inv.findSkuBySpec(fx.skus, productId, color, size)
    assert.ok(found, '夹具前提：找得到「' + color + ' · ' + size + '」这一格')
    return found
  }
  // 模拟「店主去商品编辑改了这一格的档案进价」+ 回页面时 onShow 重新取一份 skus。
  page.repriceCell = function (productId, color, size, cost) {
    let idx = -1
    fx.skus.forEach(function (item, i) {
      if (item.productId === productId && item.color === color && item.size === size) idx = i
    })
    assert.ok(idx >= 0, '夹具前提：找得到要改价的「' + color + ' · ' + size + '」这一格')
    const next = fx.skus.slice()
    next[idx] = Object.assign({}, next[idx], { costPrice: cost })
    fx.skus = next
    page.setData({ skus: next })
    return next[idx]
  }
  page.repriceBlank = function (productId, cost) {
    let idx = -1
    fx.skus.forEach(function (item, i) {
      if (item.productId === productId && item.isBlank) idx = i
    })
    assert.ok(idx >= 0, '夹具前提：找得到待加工那一格')
    const next = fx.skus.slice()
    next[idx] = Object.assign({}, next[idx], { costPrice: cost })
    fx.skus = next
    page.setData({ skus: next })
    return next[idx]
  }
  page.repriceProduct = function (productId, cost) {
    fx.products = fx.products.map(function (item) {
      return item.id === productId ? Object.assign({}, item, { costPrice: cost }) : item
    })
    page.setData({ products: fx.products })
    return store.getProduct(productId)
  }
  return page
}

// 真入口的薄包装 —— 参数形状按 wxml 的绑定来（.js-purchase-price 带
// data-field="unitPrice"，规格 chip 带 data-id，最近进货 chip 带 data-key）。
function typeField(page, field, value) {
  page.onField({ currentTarget: { dataset: { field: field } }, detail: { value: value } })
}
function typePrice(page, value) {
  typeField(page, 'unitPrice', value)
}
function tapSku(page, id) {
  page.pickSku({ currentTarget: { dataset: { id: id } } })
}
function tapRecent(page, key) {
  page.pickRecent({ currentTarget: { dataset: { key: key } } })
}

// 「店主选中黑 M，进价由系统追平写进去（归属在系统手里）」这个起手式，
// 由**真入口**造出来：先选商品，再点那一格 chip。手搭 data 造出来的形态可能是
// 真实调用链产生不了的（销售侧 PR #138 栽过一次）。
function onBlackM(qty) {
  const page = harness()
  page.selectProduct('p-spec')
  const cell = page.cell('p-spec', '黑色', 'M')
  tapSku(page, cell.id)
  if (qty != null) typeField(page, 'qty', qty)
  assert.strictEqual(page.data.skuId, cell.id, '起手式：应当选中黑 M 那一格')
  assert.strictEqual(page.data.unitPrice, String(cell.costPrice),
    '起手式：本次进价应当由系统追平到黑 M 的档案进价 ' + cell.costPrice)
  assert.strictEqual(page.data.priceTouched, false,
    '起手式：这个值是系统写的，店主还没动过')
  return page
}

// ---------------------------------------------------------------------------
// (P1) 回填 + 这一格的档案进价变了 + 没手改过 → 重新取该格档案进价
// ---------------------------------------------------------------------------
// 本次修复的正题。旧判据在这里判真，框里停在过期的 28。
{
  const page = onBlackM('10')
  const before = page.cell('p-spec', '黑色', 'M')
  const after = page.repriceCell('p-spec', '黑色', 'M', 31)
  assert.strictEqual(after.id, before.id,
    '前提：改的必须是**同一枚 SKU**（身份没变、只有档案进价变了）—— 身份也变了的话 '
      + 'skuId 判据自己就判假了，这一组测不到要测的东西')
  assert.notStrictEqual(String(after.costPrice), page.data.unitPrice,
    '前提：进入值（' + page.data.unitPrice + '）不许等于期望值（' + after.costPrice
      + '）—— 相等的话「回填要重新取档案进价」这条断言恒真，实现什么都不做也能过')

  // onShow 的原路：`this.selectProduct(this.data.productId)`。
  page.selectProduct('p-spec')

  assert.strictEqual(page.data.skuId, before.id,
    '前提：回填之后参照格仍是同一枚 SKU —— 这一组钉的正是「身份没变、内容变了」，'
      + 'skuId 要是跟着变了就说明夹具没造出要测的形状')
  assert.strictEqual(page.data.unitPrice, '31',
    '店主改了这一格的档案进价（28 → 31），回进货页 onShow 回填时本次进价必须跟着更新到 '
      + '31，实为 ' + page.data.unitPrice + ' —— 停在旧价看上去完全正常、只是过期了，'
      + '按它入库就是静默错账（进货金额 / 成本 / 毛利 / 应付一起错）')
  assert.strictEqual(page.data.priceTouched, false,
    '重新取的是档案进价，归属仍在系统手里 —— 写成 true 的话，他离开页面回来一趟就足以'
      + '让这个系统写进去的价在下一次回填时被当成「店主自己填的」永久保留')
  // 记账后果：屏上那笔钱（与服务端 applyPurchase 的 amount 同构）也得跟着走。
  assert.strictEqual(page.data.amountText, util.money(310),
    '10 件按新进价 31 应当是 ¥310.00，实为 ¥' + page.data.amountText
      + ' —— 这是「确认入库」按钮上那个数，停在旧价就是按错价入库')
  assert.strictEqual(page.data.baseCostText, util.money(31),
    '「档案进价」那一行也应当是新的 31')
  assert.strictEqual(page.data.costHint, '',
    '本次进价与档案进价现在一致了，不该再出「档案进价 ¥31 → ¥28，后续毛利按新进价」'
      + '那条提示 —— 旧实现在这里会拿一个店主根本没填过的数去唱「改价」，'
      + '把静默错账伪装成一次有意的改价')
}

// ---------------------------------------------------------------------------
// (P2) 回填 + 档案进价变了 + **手改过** → 保留他填的
// ---------------------------------------------------------------------------
// 上面那条的另一半。只改成「回填一律追平」的话，这一条会红。
{
  const page = onBlackM()
  typePrice(page, '33')
  assert.strictEqual(page.data.priceTouched, true,
    'onField 是这个框的置位点：店主往「本次进价」里打字之后归属必须归他')
  const after = page.repriceCell('p-spec', '黑色', 'M', 31)
  assert.notStrictEqual(String(after.costPrice), '33',
    '前提：手改的价不许恰好等于新档案进价，否则「保留」和「重新取档价」分不出来')
  assert.notStrictEqual(String(page.fx.products[0].costPrice), '33',
    '前提：手改的价也不许等于商品档案进价，否则「保留」和「退回商品档价」分不出来')

  page.selectProduct('p-spec')

  assert.strictEqual(page.data.unitPrice, '33',
    '店主手改过本次进价之后，就算这一格的档案进价在商品编辑里被改了，回填也必须保留他'
      + '填的 33，实为 ' + page.data.unitPrice + ' —— 判据是「没人动过才重新取档案进价」')
  assert.strictEqual(page.data.priceTouched, true,
    '保留的时候归属不变，还是店主的 —— 收走的话他离开页面回来一趟，那个 33 在下一次'
      + '回填时就会被无声冲掉')
}

// ---------------------------------------------------------------------------
// (P3) 回填 + 档案进价**没**变 → 不制造无谓的抖动，归属也不许被顺手收走
// ---------------------------------------------------------------------------
// 两条，杀伤不一样：
//   P3-1 钉值。没手改过时框里那个值本来就等于追平目标，两种实现给同一个数，
//        所以它**抓不到「判据写坏」那一类**，留着是当可读文档，不是当闸。
//   P3-2 钉的是**走了哪条路**：手打一个恰好等于档案进价的数，值这一层两种实现相同，
//        分辨点在归属上。走「追平」那条路 priceTouched 会被复位成 false，
//        而店主明明动过这个框。这一条抓的是「回填一律追平」那类实现。
{
  const page = onBlackM()
  const cell = page.cell('p-spec', '黑色', 'M')
  page.selectProduct('p-spec')
  assert.strictEqual(page.data.unitPrice, String(cell.costPrice),
    'P3-1：档案进价没变，回填后值也不该变')
  assert.strictEqual(page.data.skuId, cell.id, 'P3-1：参照格身份也不该变')
}
{
  const page = onBlackM()
  const cell = page.cell('p-spec', '黑色', 'M')
  typePrice(page, String(cell.costPrice))
  assert.strictEqual(page.data.priceTouched, true, '前提：他确实动过这个框')
  page.selectProduct('p-spec')
  assert.strictEqual(page.data.unitPrice, String(cell.costPrice),
    'P3-2：值这一层两种实现相同，这条断言不承担杀伤，分辨点在下一条')
  assert.strictEqual(page.data.priceTouched, true,
    'P3-2：店主手打了一个恰好等于档案进价的数，归属仍然是他的 —— 回填时被复位成 false，'
      + '说明实现走的是「一律追平」那条路，下一次档案进价一变就会把他的数冲掉')
}

// ---------------------------------------------------------------------------
// (P4) 换格（pickSku）**一律追平**，手改过也一样 —— 既有行为的回归闸
// ---------------------------------------------------------------------------
// 逐格进价是真功能：换到另一格还停在上一格的价就是按错价入库。把 P2 那条
// 「手改过就保留」顺手"统一"成只看 priceTouched，这里立刻红。
{
  const page = onBlackM()
  typePrice(page, '33')
  assert.strictEqual(page.data.priceTouched, true, '前提：先手改一次')
  const target = page.cell('p-spec', '白色', 'L')
  assert.notStrictEqual(String(target.costPrice), '33', '前提：进入值 ≠ 期望值')

  tapSku(page, target.id)

  assert.strictEqual(page.data.skuId, target.id, '前提：这一下应当换到白 L')
  assert.strictEqual(page.data.unitPrice, String(target.costPrice),
    '换格之后本次进价应当追平到白 L 的档案进价 ' + target.costPrice + '，实为 '
      + page.data.unitPrice + ' —— 把「手改过就保留」的判据扩到换格这条路上，就是从这个'
      + '方向拆掉「按错价记账」那条闸')
  assert.strictEqual(page.data.priceTouched, false,
    '追平了就要复位归属 —— 不复位的话这个系统写进去的价会被当成店主的，一次手改永久生效')
  assert.strictEqual(page.data.baseCostText, util.money(target.costPrice),
    '「档案进价」那一行也要跟着换到白 L 的')
}

// ---------------------------------------------------------------------------
// (P5) 换商品：手改过的价不许跟着跨到另一个商品上
// ---------------------------------------------------------------------------
// 两条，**挡住它的不是同一个判据**，别只留一条：
//   P5-1 分规格 → 无规格：data.skuId 从「黑 M 那一枚」变成空串，`skuId === nextSkuId`
//        那一条就判假了。也就是说这条断言实际考的是 skuId 判据，不是商品身份判据。
//   P5-2 无规格 → 待加工：两边 nextSkuId **都是空串**，skuId 判据结构性恒真，
//        `productId === product.id` 是唯一挡得住的那一条。
//        2026-09-05 实测：只有 P5-1 时，把商品身份判据整条删掉**零断言变红** ——
//        店主在矿泉水上手打 19，转头点卫衣，19 就跟着跨过去了。
{
  const page = onBlackM()
  typePrice(page, '33')
  const plain = page.fx.products[1]
  assert.notStrictEqual(String(plain.costPrice), '33', '前提：进入值 ≠ 期望值')

  page.selectProduct('p-plain')

  assert.strictEqual(page.data.productId, 'p-plain', '前提：这一下应当换到矿泉水')
  assert.strictEqual(page.data.unitPrice, String(plain.costPrice),
    'P5-1：换商品之后本次进价应当取新商品的档案进价 ' + plain.costPrice + '，实为 '
      + page.data.unitPrice + ' —— 把上一个商品的价带过来就是按错价入库')
  assert.strictEqual(page.data.priceTouched, false, '换商品追平了，归属收回给系统')
}
{
  const page = harness()
  page.selectProduct('p-plain')
  typePrice(page, '19')
  assert.strictEqual(page.data.skuId, '', '前提：无规格商品的 skuId 是空串')

  page.selectProduct('p-blank')

  assert.strictEqual(page.data.productId, 'p-blank', '前提：这一下应当换到卫衣')
  assert.strictEqual(page.data.skuId, '',
    '前提：待加工商品的 nextSkuId 也是空串 —— 两边都空，`skuId === nextSkuId` 恒真，'
      + '这一组才考得到商品身份那一条判据')
  assert.strictEqual(page.data.unitPrice, '41',
    'P5-2：在矿泉水上手打的 19 不许跟着跨到卫衣上，应当取卫衣待加工那一格的 41，实为 '
      + page.data.unitPrice + ' —— 两个商品的 skuId 都是空串，只有「还是不是同一个商品」'
      + '挡得住；这一条删掉的话，店主在一个商品上填的价会无声地变成另一个商品的进价')
  assert.strictEqual(page.data.priceTouched, false, '换商品追平了，归属收回给系统')
}

// ---------------------------------------------------------------------------
// (P6) 进价框被清空 → 回填要把档案进价填回来，不许留空
// ---------------------------------------------------------------------------
// keepPrice 里 `!!this.data.unitPrice` 那一条守的就是这个：店主把框清空了、归属还在
// 他手里，回填时**不能**「保留」一个空串 —— 那样「确认入库」上会一直挂着 ¥0.00。
{
  const page = onBlackM()
  const cell = page.cell('p-spec', '黑色', 'M')
  typePrice(page, '')
  assert.strictEqual(page.data.unitPrice, '', '前提：框现在是空的')
  assert.strictEqual(page.data.priceTouched, true, '前提：清空也是他动的，归属在他手里')

  page.selectProduct('p-spec')

  assert.strictEqual(page.data.unitPrice, String(cell.costPrice),
    '框被清空之后回填必须把档案进价 ' + cell.costPrice + ' 填回来，实为「'
      + page.data.unitPrice + '」—— 留空的话屏上那笔钱恒为 ¥0.00，'
      + '而 keepPrice 少了「框里有值」这一条正好会留空')
  assert.strictEqual(page.data.priceTouched, false, '填回来的是档案进价，归属归系统')
}

// ---------------------------------------------------------------------------
// (P7) 无规格商品：同一条修复也覆盖它
// ---------------------------------------------------------------------------
// 无规格商品的 nextSkuId 恒为空串，`skuId === nextSkuId` 那一条**结构性恒真**，
// 身份判据在这条路上一点闸都没有 —— 旧实现在这里漏得最狠。
{
  const page = harness()
  page.selectProduct('p-plain')
  assert.strictEqual(page.data.skuId, '', '前提：无规格商品的 skuId 是空串')
  assert.strictEqual(page.data.unitPrice, '15', '前提：进入值是商品档案进价 15')
  assert.strictEqual(page.data.priceTouched, false, '前提：这个值是系统写的')
  page.repriceProduct('p-plain', 17)

  page.selectProduct('p-plain')

  assert.strictEqual(page.data.unitPrice, '17',
    '无规格商品改了档案进价（15 → 17），回填也必须跟着更新到 17，实为 '
      + page.data.unitPrice + ' —— 这条路上 skuId 两边都是空串、身份判据恒真，'
      + '旧实现在这里一定停在旧价')
  assert.strictEqual(page.data.priceTouched, false, '取的是档案进价，归属归系统')
}
{
  // 另一半：无规格商品 + 手改过 → 保留他填的。
  const page = harness()
  page.selectProduct('p-plain')
  typePrice(page, '19')
  const plainAfter = page.repriceProduct('p-plain', 17)
  // 拿**实际取值**比，不比两个字面量——字面量互比恒真，改了上面的数这条也不会跟着动。
  assert.notStrictEqual(page.data.unitPrice, String(plainAfter.costPrice),
    '前提：手改的价（' + page.data.unitPrice + '）不许等于新档案进价（'
      + plainAfter.costPrice + '），否则本组分不出「保留」和「追平」')

  page.selectProduct('p-plain')

  assert.strictEqual(page.data.unitPrice, '19',
    '无规格商品手改过之后回填必须保留他填的 19，实为 ' + page.data.unitPrice)
  assert.strictEqual(page.data.priceTouched, true, '保留时归属不变')
}

// ---------------------------------------------------------------------------
// (P8) 待加工商品：基准取待加工那一格，改了也要跟着走
// ---------------------------------------------------------------------------
// baseCostOf 的第三档（blank 优先于 sku 与 product）。nextSkuId 同样恒为空串，
// 与 P7 同形；分开一条是因为**取数的来源**不同：取错来源就会拿商品档价（45）当基准，
// 而 applyPurchase 的 blank 分支覆盖的是待加工格那一份。
{
  const page = harness()
  page.selectProduct('p-blank')
  assert.strictEqual(page.data.blankProcess, true, '前提：这是待加工商品')
  assert.strictEqual(page.data.unitPrice, '41',
    '前提：进入值应当取待加工那一格的 41，不是商品档价 45')
  page.repriceBlank('p-blank', 43)

  page.selectProduct('p-blank')

  assert.strictEqual(page.data.unitPrice, '43',
    '待加工那一格的进价改了（41 → 43），回填必须跟着更新到 43，实为 '
      + page.data.unitPrice)
  assert.strictEqual(page.data.baseCostText, util.money(43), '「档案进价」那一行同理')
}

// ---------------------------------------------------------------------------
// (P9) 往别的框打字不许置位归属
// ---------------------------------------------------------------------------
// onField 是通用入口（qty / remark / unitPrice 都走它）。误置位的后果是反向的：
// 店主只是改了个数量，系统写进去的进价就被当成他填的，从此再也不会被回填更新。
{
  const page = onBlackM()
  typeField(page, 'qty', '5')
  assert.strictEqual(page.data.qty, '5', '前提：数量确实写进去了')
  assert.strictEqual(page.data.priceTouched, false,
    '往「数量」框打字不许把进价的归属划给店主')
  typeField(page, 'remark', '张三送来的')
  assert.strictEqual(page.data.priceTouched, false, '「备注」同理')

  const after = page.repriceCell('p-spec', '黑色', 'M', 31)
  page.selectProduct('p-spec')
  assert.strictEqual(page.data.unitPrice, String(after.costPrice),
    '只改过数量 / 备注的话，回填仍应重新取档案进价 ' + after.costPrice + '，实为 '
      + page.data.unitPrice + ' —— onField 对每个字段都置位的话，改一下数量就够让'
      + '进价从此冻住')
}

// ---------------------------------------------------------------------------
// (P10) 静态钉子：写入口的收敛
// ---------------------------------------------------------------------------
// 本 bug 的形状就是「有个地方改了参照格却没跟着写进价」，而它不崩、不报错、屏上也没
// 提示 —— 只有把系统侧的写入口收敛成一个（pricePatch），漏写才会在结构上做不到。
// **说清这条钉子盖不到什么**：`patch[field] = value`（onField 那种全动态下标）任何
// 静态正则都认不出来 —— 那正是 onField 自己的写法，也是留给用户输入的口。所以它挡的是
// 「顺手换个写法绕开 pricePatch」，不是「所有可能的写入」。
const purchaseNoComments = stripComments(purchaseJs)

// 剥注释器先过一道对照：它要是把代码也一起剥了，下面几条会静默变成恒真的假绿。
const stripProbe = stripComments('  // 注释里提到 unitPrice: 1\n  px.unitPrice = 1\n')
assert.strictEqual(stripProbe.indexOf('注释里提到'), -1,
  '阳性对照：剥注释器应当真的把行注释剥掉 —— 剥不掉的话下面的计数会把注释也数进去')
assert.ok(stripProbe.indexOf('px.unitPrice = 1') >= 0,
  '阴性对照：剥注释器不许把代码一起剥掉 —— 剥掉了下面几条就是恒真的假绿')

// (?<!\.) 排掉 `this.data.unitPrice : x` 这类三元表达式里的冒号 —— 那不是对象字面量
// 的 key，不是写入点。
const UNIT_PRICE_KEY_RE = /(?<!\.)unitPrice\s*:/g
assert.strictEqual(('    unitPrice: price,'.match(UNIT_PRICE_KEY_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出 `unitPrice:` 这种字面量 key。认不出就说明它被改坏了，'
    + '下面那条计数是恒真的假绿')
assert.strictEqual(('keep ? this.data.unitPrice : fallback'.match(UNIT_PRICE_KEY_RE) || []).length, 0,
  '阴性对照：三元表达式里的 `this.data.unitPrice :` 不是写入点，不许被数进去')
const unitPriceKeyCount = (purchaseNoComments.match(UNIT_PRICE_KEY_RE) || []).length
assert.strictEqual(unitPriceKeyCount, 7,
  '字面量 "unitPrice:" 应当恰好出现 7 次（data{} 初始值 + pricePatch 的 return + '
    + 'loadRecent 拼的 chip 条目 + pickRecent 的清空与回填两处 + submit 的 payload + submit 尾部的复位），'
    + '实为 ' + unitPriceKeyCount + ' 次。多出来的多半是有地方绕开 pricePatch 直接往'
    + '页面 data 里写进价 —— 那就又有一个「把店主填的价无声冲掉」或者「改了格价没跟上」'
    + '的点位')

const PRICE_TOUCHED_KEY_RE = /(?<!\.)priceTouched\s*:/g
assert.strictEqual(('    priceTouched: false,'.match(PRICE_TOUCHED_KEY_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出 `priceTouched:` 这种字面量 key')
assert.strictEqual(('keep ? this.data.priceTouched : false'.match(PRICE_TOUCHED_KEY_RE) || []).length, 0,
  '阴性对照：三元表达式里的 `this.data.priceTouched :` 不是写入点')
const priceTouchedKeyCount = (purchaseNoComments.match(PRICE_TOUCHED_KEY_RE) || []).length
assert.strictEqual(priceTouchedKeyCount, 5,
  '字面量 "priceTouched:" 应当恰好出现 5 次（data{} 初始值 + pricePatch 的 return + '
    + 'pickRecent 的清空与回填两处 + submit 尾部的复位），实为 ' + priceTouchedKeyCount + ' 次 —— '
    + '这条只保证**写入点总数收敛**，不保证同址：把某一处拆成两次 setData，计数不变、'
    + '它照样绿（复审在 pickRecent 上实证过，baseline 就守不住）。「同一次 setData」'
    + '这件事目前只有 submit 那一处有静态钉（见 P12），别的入口靠人看')

const WRITE_RE = /(?:\.\s*(unitPrice|priceTouched)\s*=(?!=)|\[\s*['"](?:unitPrice|priceTouched)['"]\s*\])/g
assert.strictEqual(("px.unitPrice = '0'".match(WRITE_RE) || []).length, 1,
  '阳性对照：这条正则应当能认出属性赋值 `px.unitPrice = ...`（销售侧审计的实证用的'
    + '正是这个写法：换成属性赋值就绕开了字面量 key，整轮 npm test 一条都不红）')
assert.strictEqual(("px['priceTouched'] = true".match(WRITE_RE) || []).length, 1,
  '阳性对照：引号计算 key 也要认得出')
assert.strictEqual(('if (this.data.unitPrice === prev) return'.match(WRITE_RE) || []).length, 0,
  '阴性对照：`===` 是比较不是写入，不许被数进去 —— 数进去的话这条钉子会随实现的读法'
    + '漂移，迟早被人当噪音删掉')
const writes = purchaseNoComments.match(WRITE_RE) || []
assert.deepStrictEqual(writes, ['.priceTouched ='],
  '属性赋值形态的写入应当恰好一处（onField 里那句 `patch.priceTouched = true`），实为 '
    + JSON.stringify(writes) + ' —— 多出来的就是绕开 pricePatch 的写入点')
const onFieldBody = stripComments(pageMethod(purchaseJs, 'onField'))
assert.strictEqual((onFieldBody.match(WRITE_RE) || []).length, 1,
  '那唯一一处必须在 onField 里 —— 挪到别的方法就说明用户输入口不止一个了')

const pricePatchBody = pageMethod(purchaseJs, 'pricePatch')
assert.ok(/unitPrice\s*:/.test(pricePatchBody) && /priceTouched\s*:/.test(pricePatchBody),
  'pricePatch 的返回里两个字段必须都在 —— 只写一个就等于没有这个函数')
assert.ok(pageMethod(purchaseJs, 'applyProductState').indexOf('this.pricePatch(') >= 0,
  'applyProductState 应当经 this.pricePatch() 写进价 —— 它是唯一会重算档案进价基准的'
    + '方法，不走 pricePatch 就会让 unitPrice 和 priceTouched 分头写')
// pickSku / selectProduct 是两个换参照格的入口，只准把价的事**转交出去**
// （交给 applyProductState），自己一个字都不许碰。销售侧审计那条实证插的正是这种
// 「不在任何名单里的方法」—— 插进去当时零断言变红。
;['pickSku', 'selectProduct'].forEach(function (name) {
  const body = stripComments(pageMethod(purchaseJs, name))
  ;['unitPrice', 'priceTouched'].forEach(function (field) {
    assert.strictEqual(body.indexOf(field), -1,
      name + ' 的方法体里不许出现 ' + field + ' —— 这两个入口只准把价的事转交给 '
        + 'applyProductState，自己碰就又多了一个绕开 pricePatch 的写入点')
  })
})

// ---------------------------------------------------------------------------
// (P11) 「最近进货」chip 带来的上次进价，活得过一次回填
// ---------------------------------------------------------------------------
// 点 chip 是店主**主动要**那个数（稿 4:713：带出商品 + 规格 + 上次进价），归属算他的。
// 标成系统的话，他去别的页面转一圈回来，onShow 回填就会把这个数无声换成档案进价 ——
// 那正是本次要修的那种静默改数，只是换了个方向；而且旧实现靠身份判据本来就把它留住了，
// 标 false 等于这次修复顺手带出一条新的回归。
//
// chip 条目不手搭：拿真的进货流水喂 loadRecent，让它自己拼出来。
async function recentGroup() {
  started += 1
  const page = harness()
  const cell = page.cell('p-spec', '黑色', 'M')
  // 上一次这一格是按 31 进的货 —— 用真引擎造这张流水，形状与线上一致。
  const done = inv.applyPurchase(
    page.fx.products.slice(), [],
    { productId: 'p-spec', skuId: cell.id, qty: 5, unitPrice: 31, remark: '' },
    900, 'rec-1', page.fx.skus.slice()
  )
  // applyPurchase 会把这一格的档案进价一并改成 31。这里**故意不把它带回夹具**：
  // 场景是「上次按 31 进的货，后来店主又在商品编辑里把档案进价改回 28」——
  // 两个数必须不同，相同的话「保留 chip 的价」和「追平到档案进价」分不出来。
  page.fx.records = done.records
  assert.strictEqual(page.cell('p-spec', '黑色', 'M').costPrice, 28,
    '前提：夹具里这一格的档案进价仍是 28')

  await page.loadRecent()

  assert.strictEqual(page.data.recent.length, 1, '前提：loadRecent 应当拼出一枚 chip')
  const chip = page.data.recent[0]
  assert.strictEqual(chip.unitPrice, '31', '前提：chip 上带的是上次进价 31')
  assert.notStrictEqual(chip.unitPrice, '28',
    '前提：chip 的价不许等于档案进价，否则下面那条断言恒真')

  // 先往数量框里填一个数——不填的话下面那条「数量留空」是恒真的：qty 进场就是空串，
  // 把 pickRecent 里的 `qty: ''` 整个删掉，11 组也全绿（复审实测）。
  typeField(page, 'qty', '7')
  assert.strictEqual(page.data.qty, '7', '前提：框里先有个数，下面那条才分得出「清空了」和「本来就空」')

  tapRecent(page, chip.key)

  assert.strictEqual(page.data.productId, 'p-spec', '点 chip 应当带出商品')
  assert.strictEqual(page.data.skuId, cell.id, '点 chip 应当带出规格')
  assert.strictEqual(page.data.qty, '', '稿 4:713：点 chip 之后数量留空——刚填的 7 要被清掉')
  assert.strictEqual(page.data.unitPrice, '31', '点 chip 应当带出上次进价 31')
  assert.strictEqual(page.data.priceTouched, true,
    '点 chip 是店主主动要这个数，归属算他的 —— 标成系统的话下面那条回填会把它换掉')

  // 他去别的页面转一圈（比如翻了下商品详情）再回来 —— onShow 的原路。
  page.selectProduct('p-spec')

  assert.strictEqual(page.data.unitPrice, '31',
    '「最近进货」带出来的上次进价必须活得过一次回填，实为 ' + page.data.unitPrice
      + ' —— 被换成档案进价 28 的话，店主点 chip 要来的那个数就在他没看见的时候变了，'
      + '而旧实现靠身份判据本来是留得住的（这条同时是本次修复的回归闸）')
  assert.strictEqual(page.data.priceTouched, true, '保留时归属不变')
  ended += 1   // 本块跑完（收尾闸靠它，与开头的 started 配对）
}

// 收尾闸：异步断言没跑完就退出的话，进程会安安静静 exit 0——复审实测过这条假绿通道
// （把 addPurchase 换成永不 settle 的 promise，上一版照样 exit 0）。这里钉死：
// 没走到最后一行就是失败。
// 收尾闸：每个异步块**进出各报一次**，退出时要求进出相等。
//
// 不用「总块数」那个常量：我写过一版数 `async function` 来自检，结果它数的 token 就
// 出现在数它的代码里，越改越绕（先数出 6 处，改窄之后 5 处）。进出配对不需要知道总数，
// 加块时只要照抄这一对，忘了改常量这种事就不存在。
//
// 它抓得住：块内提前 return、await 的 promise 永不 settle、链被截断。
// 它抓不住：整个块被删掉或从未被调用（那样进出都是 0）。
let started = 0
let ended = 0
process.on('exit', function (code) {
  if (code === 0 && started !== ended) {
    console.error('异步断言没跑完就退出了：进了 ' + started + ' 个异步块，只跑完 ' + ended
      + ' 个。多半是某个 await 的 promise 永远不 settle、链被谁截断了，或者块内提前 return 了。')
    process.exitCode = 1
  }
})

recentGroup().then(function () {
  // --- (P12) 提交之后归属交还系统（2026-09-06 翻案）------------------------------
// 上一版裁定「不复位」，论据是「进货走移动加权平均、复位会填进一个没人报过价的平均数」。
// **那个论据整段是错的**：进货走 `applyPurchase`，三条分支都是 `costPrice = unitPrice`
// 直接覆盖（utils/inventory.js:745 / 769 / 781），移动加权平均那条 :192 只服务调拨与
// 退货回格。purchase.js:172-174 那段 baseline 注释早就写着「被这次进价覆盖」。
//
// 事实翻过来，裁决跟着翻：那个价是店主为**这一单**给的，单记完归属就该还回系统。
// 复位在提交那一刻是**显示等价**的（档案进价刚被覆盖成同一个数），差别只在之后——
// 别人改了档案进价，复位过的会跟上，不复位的停在旧数，正是本批一直在修的静默错账。
// 两条一起钉：一条静态、一条真跑。
//
// 静态那条从源码抠 submit 的函数体看那次清空怎么写——**不能**把那行 setData 抄进测试
// 里自己写一遍再断言自己写的东西，那是纯摆设（第一版正是这么写的，把复位改成不复位
// 它一声不吭）。
//
// 但静态钉子只看那一行**怎么写**，看不见它**执不执行**：复审实测，把整行挂在一个永假
// 条件后面（`if (!record) this.setData(...)`），字面量一字未改，全套仍绿。所以补一条
// 真跑 submit 的行为钉子——「submit 打服务端跑不动」这个理由不成立，harness 本来就有
// store 替身，补上 getSkus / addPurchase（走真 applyPurchase 落账）就跑得起来。
;(function assertSubmitReleasesOwnership() {
  const body = pageMethod(purchaseJs, 'submit')
  const line = (body.match(/this\.setData\(\{[^}]*qty:\s*''[^}]*\}\)/) || [])[0]
  assert.ok(line,
    'submit 里应当有一处「清空 qty」的 setData——找不到说明它改了写法，'
      + '下面两条就不是在测源码了')
  assert.ok(line.indexOf('priceTouched: false') >= 0,
    '提交之后归属要交还系统：那次清空的 setData 里应当写 `priceTouched: false`，'
      + '实为 `' + line + '`——留着 true 的话，以后别人改了档案进价这一格再也追不上，'
      + '就是本批一直在修的静默错账')
  assert.ok(line.indexOf("unitPrice: ''") >= 0,
    '归属与价必须**一起**写（守这件事的是本条，不是 P10——P10 只保证写入点总数收敛）：'
      + '这次清空里应当同时有 '
      + "`unitPrice: ''`，实为 `" + line + '`')
})()

// submit 直接调 `wx.showToast`（purchase.js:360）；错误路径经 `util.showError` 用到
// `wx.showModal` / `wx.showToast`。只桩这两个——**桩多了就等于把生产代码的依赖偷偷
// 改宽**：上一版桩了五个并写「只桩它真正调到的三个」，两句都是假的（`util.showToast`
// 这个函数根本不存在，实际只调到 showToast 一个），复审拿 Proxy 记账当场比出来。
global.wx = global.wx || {
  showToast: function () {},
  showModal: function () {}
}

// --- (P13) 真跑一遍 submit：归属确实被交还了 ---------------------------------
// P12 是静态的，看不见「那行代码执不执行」。复审实测：把整行挂在永假条件后面
// （`if (!record) this.setData(...)`），字面量一字未改，全套仍绿。这一条真跑。
;(async function assertSubmitActuallyReleasesOwnership() {
  started += 1
  const page = harness()
  const cell = page.cell('p-spec', '黑色', 'M')
  page.selectProduct('p-spec')
  tapSku(page, cell.id)
  typeField(page, 'qty', '2')
  typePrice(page, '33')
  assert.strictEqual(page.data.priceTouched, true, '前提：手打过价，归属在店主手里')
  assert.notStrictEqual('33', String(cell.costPrice),
    '前提：手打的价不许等于原档案进价 ' + cell.costPrice + '，否则分不出复位与否')

  await page.submit()

  assert.strictEqual(page.data.priceTouched, false,
    '提交之后归属应当交还系统，实为 ' + page.data.priceTouched
      + '——留着 true 的话，以后别人改了档案进价这一格再也追不上，就是静默错账')
  assert.strictEqual(page.data.qty, '', '提交之后数量也该清空')
  // 「显示等价」那句话的实证：进货是直接覆盖（不是加权平均），所以回填拿回来的
  // 就是刚才填的那个数**四舍五入到两位之后**的样子。
  assert.strictEqual(page.data.unitPrice, '33',
    '复位之后回填应当拿回刚覆盖上去的档案进价 33，实为 ' + page.data.unitPrice
      + '——不等于的话「复位在提交那一刻是显示等价的」这句话就不成立')
  ended += 1   // 本块跑完（收尾闸靠它，与开头的 started 配对）
})()
  .then(function () { console.log('purchase-price tests passed') })
  .catch(function (e) { console.error(e); process.exit(1) })
}, function (error) {
  console.error(error)
  process.exit(1)
})
