// 盘点页（pages/stock-take）的账法与折算。
//
// 这个文件存在的理由：盘点做错了在审计里看不出来 —— 差异算反、空框当成 0 件、
// 没碰的格也发一条流水，界面照样跑得起来，屏上还很正常。别的测试覆盖 applyAdjust
// 的公式，没有一个覆盖「这一屏把用户输入折成几条什么样的 addAdjust」。
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..')
const util = require('../utils/util')
const inventory = require('../utils/inventory')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function makeWx() {
  const calls = []
  const wx = {
    calls: calls,
    showToast: function (o) { calls.push(['showToast', o && o.title]) },
    showModal: function (o) { calls.push(['showModal', o && o.title]) },
    showLoading: function () {},
    hideLoading: function () {},
    navigateBack: function () { calls.push(['navigateBack']) },
    setNavigationBarTitle: function (o) { calls.push(['title', o && o.title]) },
    onKeyboardHeightChange: function (fn) { wx.kbFn = fn },
    offKeyboardHeightChange: function () { wx.kbFn = null }
  }
  return wx
}

// util 是在**宿主 realm** 里 require 的，它内部的 util.showError 引用的是宿主的
// 全局 wx，不是沙箱里那个。所以要给宿主也挂一份，否则「一条都没记上」那条分支
// 会抛 ReferenceError，测出来的失败原因和真实原因对不上。
function loadPage(storeStub, wxStub) {
  global.wx = wxStub
  const src = read('pages/stock-take/stock-take.js')
  let captured = null
  const sandbox = {
    module: { exports: {} },
    console: console,
    // 提交成功后那句 setTimeout(navigateBack, 400) 在测试里没有意义，直接吞掉；
    // 「有没有退回上一页」由 tests/ui.test.js 的真机流程验。
    setTimeout: function () {},
    wx: wxStub,
    require: function (id) {
      if (id.indexOf('store') >= 0) return storeStub
      if (id.indexOf('inventory') >= 0) return inventory
      if (id.indexOf('util') >= 0) return util
      throw new Error('页面出现了预期外的 require: ' + id)
    },
    Page: function (def) { captured = def }
  }
  vm.runInNewContext(src, sandbox)
  assert.ok(captured, '页面没有调用 Page()')
  const inst = Object.assign({}, captured)
  inst.data = JSON.parse(JSON.stringify(captured.data))
  inst.setData = function (patch) { Object.assign(inst.data, patch) }
  return inst
}

// ---------------------------------------------------------------------------
// 一、账面数取哪一格：判据必须与 lowStockRows / product-detail 同源
// ---------------------------------------------------------------------------

// blankProduct.stock 故意取 40、与 blank sku 的 18 错开：这一格的账面数必须取
// findBlankSku 那条 sku，不能取商品记录上的 stock。两个值相同的话，「半成品行的
// 账面数取 blank sku 的 stock，不是 product.stock」这条断言永远证不出差别
//（规格 §18 变异 #4 在同值夹具下咬不红，实测确认后改的这一个数）。
const blankProduct = {
  id: 'p-blank', name: '卫衣', stock: 40, blankProcess: true,
  colors: ['黑色', '白色'], sizes: ['M'], specAxis1: '颜色', specAxis2: '尺码'
}
const blankSkus = [
  { id: 's1', productId: 'p-blank', color: '黑色', size: 'M', stock: 3, isBlank: false },
  { id: 's2', productId: 'p-blank', color: '白色', size: 'M', stock: 0, isBlank: false },
  { id: 's9', productId: 'p-blank', color: '', size: '', stock: 18, isBlank: true }
]

const emptyStore = { ready: function () { return Promise.resolve(true) } }
const shaper = loadPage(emptyStore, makeWx())

const blankRows = Array.from(shaper.rowsOf(blankProduct, blankSkus))
assert.strictEqual(blankRows.length, 3, '待加工商品要把半成品池和每个成品格都排出来')
assert.strictEqual(blankRows[0].blank, true, '半成品排第一行（稿 card/盘点行 4:900）')
assert.strictEqual(blankRows[0].label, '半成品', '半成品行的名照稿 4:901')
assert.strictEqual(blankRows[0].skuId, 's9', '半成品行要挂 findBlankSku 那一格的 skuId')
assert.strictEqual(blankRows[0].bookQty, 18, '半成品行的账面数取 blank sku 的 stock，不是 product.stock')
assert.deepStrictEqual(
  Array.from(blankRows.slice(1).map(function (r) { return r.skuId })),
  ['s1', 's2'],
  '成品格按 sku 顺序排在半成品之后'
)

// 分规格现货（没有 blankProcess）：只有成品格，没有半成品行
const specProduct = { id: 'p-spec', name: '短袖', stock: 8, colors: ['黑色'], sizes: ['M', 'L'] }
const specSkus = [
  { id: 't1', productId: 'p-spec', color: '黑色', size: 'M', stock: 6, isBlank: false },
  { id: 't2', productId: 'p-spec', color: '黑色', size: 'L', stock: 2, isBlank: false }
]
const specRows = Array.from(shaper.rowsOf(specProduct, specSkus))
assert.strictEqual(specRows.length, 2, '分规格现货只盘成品格')
assert.ok(!specRows.some(function (r) { return r.blank }), '分规格现货没有半成品行')

// 普通商品：一行，账面在商品记录上
const plainRows = Array.from(shaper.rowsOf({ id: 'p-plain', name: '牛奶', stock: 48 }, []))
assert.strictEqual(plainRows.length, 1, '普通商品只有一行')
assert.strictEqual(plainRows[0].skuId, '', '普通商品那一行不带 skuId')
assert.strictEqual(plainRows[0].bookQty, 48, '普通商品的账面数取 product.stock')
assert.strictEqual(plainRows[0].label, '库存')

// ---------------------------------------------------------------------------
// 二、差异怎么折：空框 = 没碰过，不是 0 件
// ---------------------------------------------------------------------------

function fold(inputs) {
  const rows = inputs.map(function (pair, i) {
    return { key: 'k' + i, skuId: 'k' + i, blank: false, label: 'L' + i, bookQty: pair[0], input: pair[1] }
  })
  return shaper.foldRows(rows)
}

const foldedSame = fold([[8, '8'], [23, '23']])
assert.strictEqual(foldedSame.diffCount, 0, '预填账面数的行差异必须是 0')

const foldedDiff = fold([[8, '5'], [23, '23'], [15, '17']])
assert.strictEqual(foldedDiff.diffCount, 2, '两格改了就是两处差异')
assert.strictEqual(foldedDiff.rows[0].diff, -3, '账面 8 实点 5 的差异是 -3（稿 4:931 的样张）')
assert.strictEqual(foldedDiff.rows[0].diffText, '-3')
assert.strictEqual(foldedDiff.rows[0].changed, true)
assert.strictEqual(foldedDiff.rows[1].diffText, '', '零差异的行不出差值文案')
assert.strictEqual(foldedDiff.rows[2].diff, 2, '账面 15 实点 17 的差异是 +2')
assert.strictEqual(foldedDiff.rows[2].diffText, '+2')

// 这一条是本页最重要的闸：清空一格不能被读成「这一格 0 件」
const foldedEmpty = fold([[8, ''], [23, '  ']])
assert.strictEqual(foldedEmpty.diffCount, 0,
  '空框必须按「没碰过」处理 —— 读成 0 件会把整格库存悄悄清零')

// 打了 0 才是真的盘成 0 件
const foldedZero = fold([[8, '0']])
assert.strictEqual(foldedZero.diffCount, 1, '真的打了 0 才算盘成 0 件')
assert.strictEqual(foldedZero.rows[0].diff, -8)

// 负数、三位小数、乱字符都不算数（type="digit" 打不出来，但粘贴能进来）
const foldedBad = fold([[8, '-1'], [8, '1.234'], [8, 'abc']])
assert.strictEqual(foldedBad.diffCount, 0, '不合法的实点数不参与折算')

// 两位小数是全仓量纲，要能盘
const foldedDecimal = fold([[8, '7.5']])
assert.strictEqual(foldedDecimal.rows[0].diff, -0.5, '两位小数要能盘')

// ---------------------------------------------------------------------------
// 三、提交折成几条什么样的 addAdjust
// ---------------------------------------------------------------------------

function submitStore(failAt) {
  const sent = []
  return {
    sent: sent,
    ready: function () { return Promise.resolve(true) },
    getProduct: function () { return blankProduct },
    getSkusByProduct: function () { return blankSkus },
    addAdjust: function (payload) {
      sent.push(payload)
      if (failAt != null && sent.length === failAt) return Promise.reject(new Error('网络异常'))
      return Promise.resolve({})
    }
  }
}

function primed(storeStub, wxStub, inputs) {
  const inst = loadPage(storeStub, wxStub)
  const rows = inputs.map(function (pair, i) {
    return {
      key: 'k' + i, skuId: pair[2] == null ? 'k' + i : pair[2], blank: false,
      label: 'L' + i, bookQty: pair[0], bookText: '账面 ' + pair[0], input: pair[1]
    }
  })
  const folded = inst.foldRows(rows)
  inst.data.productId = 'p-blank'
  inst.data.rows = folded.rows
  inst.data.diffCount = folded.diffCount
  return inst
}

const okStore = submitStore(null)
const okInst = primed(okStore, makeWx(), [[8, '5'], [23, '23'], [15, '17']])
okInst.submit().then(function () {
  // 没碰的那一格一条流水都不发（稿 n1：未触碰的绝不动）
  assert.strictEqual(okStore.sent.length, 2, '两处差异发两条 addAdjust，没碰的那格不发')

  assert.deepStrictEqual(Object.assign({}, okStore.sent[0]), {
    productId: 'p-blank', direction: 'out', reason: 'shortage', qty: 3, remark: '', skuId: 'k0'
  }, '盘少了走 adjust_out / 盘亏，数量是差值的绝对值')

  assert.deepStrictEqual(Object.assign({}, okStore.sent[1]), {
    productId: 'p-blank', direction: 'in', reason: 'surplus', qty: 2, remark: '', skuId: 'k2'
  }, '盘多了走 adjust_in / 盘盈')

  // 原因必须落在服务端白名单里，否则 applyAdjust 当场 throw「请选择原因」
  okStore.sent.forEach(function (p) {
    const type = p.direction === 'out' ? 'adjust_out' : 'adjust_in'
    assert.ok(inventory.adjustReasonAllowed(type, p.reason),
      '原因「' + p.reason + '」不在 ' + type + ' 的白名单里，服务端会拒收')
  })

  // 无规格商品那一行不许带 skuId：applyAdjust 会拿 skuId 去找 sku，找不到就报
  // 「规格不存在」
  const plainStore = submitStore(null)
  const plainInst = primed(plainStore, makeWx(), [[48, '46', '']])
  return plainInst.submit().then(function () {
    assert.strictEqual(plainStore.sent.length, 1)
    assert.ok(!('skuId' in plainStore.sent[0]), '无规格商品的 payload 不带 skuId')

    // 零差异：一条都不发，也不 toast
    const noneWx = makeWx()
    const noneStore = submitStore(null)
    return primed(noneStore, noneWx, [[8, '8']]).submit().then(function () {
      assert.strictEqual(noneStore.sent.length, 0, '零差异不产生任何流水（稿 n7）')

      // 填了字却解析不出数：拦下来点名报错，不静默跳过
      const badWx = makeWx()
      const badStore = submitStore(null)
      return primed(badStore, badWx, [[8, '1.234']]).submit().then(function () {
        assert.strictEqual(badStore.sent.length, 0, '不合法的实点数不许被静默跳过')
        const toasted = badWx.calls.filter(function (c) { return c[0] === 'showToast' })
        assert.strictEqual(toasted.length, 1, '不合法的实点数要报错')
        assert.ok(String(toasted[0][1]).indexOf('L0') >= 0, '报错要点名是哪一格')

        // 中途失败：已记上的不能说成「没记上」
        const failWx = makeWx()
        const failStore = submitStore(2)
        const failInst = primed(failStore, failWx, [[8, '5'], [23, '20'], [15, '17']])
        return failInst.submit().then(function () {
          assert.strictEqual(failStore.sent.length, 2, '第二条失败就停，不再发第三条')
          const modal = failWx.calls.filter(function (c) { return c[0] === 'showModal' })
          assert.strictEqual(modal.length, 1, '部分成功要弹「只记上了一部分」')
          assert.strictEqual(modal[0][1], '只记上了一部分')
          assert.strictEqual(failInst.data.submitting, false, '失败之后闸要放开，能再点一次')

          // -----------------------------------------------------------------
          // 四、toast 形状（稿 toast/盘点完成 10:206）
          // -----------------------------------------------------------------
          assert.strictEqual(
            shaper.doneToast([{ label: '白色/2.0m', bookQty: 8, diff: -3 }]),
            '已盘点 · 白色/2.0m 8 → 5 件',
            '单处差异的 toast 照抄稿 10:206'
          )
          assert.strictEqual(
            shaper.doneToast([{ label: 'a', bookQty: 1, diff: 1 }, { label: 'b', bookQty: 1, diff: 1 }]),
            '已盘点 · 2 处差异已调整',
            '多处差异只报处数，规格名拼进 toast 会被真机腰斩'
          )

          // -----------------------------------------------------------------
          // 五、纪律：字号热区走变量，键盘那条路要在
          // -----------------------------------------------------------------
          const wxss = read('pages/stock-take/stock-take.wxss')
          assert.ok(!/font-size:\s*\d/.test(wxss), '盘点页不许写死字号，一律用 docs/ui-scale.md 的变量')
          ;['--fs-caption', '--fs-label', '--fs-body', '--fs-title', '--tap-md', '--tap-lg']
            .forEach(function (token) {
              assert.ok(wxss.indexOf(token) >= 0, '盘点页应当消费 ' + token)
            })
          assert.ok(wxss.indexOf('var(--color-amber-50)') >= 0,
            '差异行的浅底要用 B1 已落地的 --color-amber-50（稿 4:915 的 amber/50）')
          assert.ok(wxss.indexOf('var(--color-amber-700)') >= 0,
            '差值文字要用 --color-amber-700（稿 4:931 的 amber/700）')

          const wxml = read('pages/stock-take/stock-take.wxml')
          assert.ok(wxml.indexOf('class="page"') >= 0, '根节点要 class="page"')
          // 02c 的三件套：整屏随键盘变矮、列表可滚、输入框不自己顶页面
          assert.ok(/calc\(100vh - \{\{kbPx\}\}px\)/.test(wxml),
            '整屏高度要随键盘高度收缩，否则底栏会被键盘盖住（稿 caption 7:169）')
          assert.ok(wxml.indexOf('<scroll-view') >= 0 && wxml.indexOf('scroll-y') >= 0,
            '列表区要是可滚的 scroll-view（稿 7:169：列表区压缩可滚）')
          assert.ok(wxml.indexOf('adjust-position="{{false}}"') >= 0,
            '输入框要关掉 adjust-position，让位由页面自己算')
          assert.ok(wxml.indexOf('scroll-into-view="{{scrollIntoId}}"') >= 0,
            '聚焦的那一行要能滚进压缩后的可视区')

          const js = read('pages/stock-take/stock-take.js')
          assert.ok(js.indexOf('wx.onKeyboardHeightChange') >= 0, '要监听键盘高度变化')
          assert.ok(js.indexOf('wx.offKeyboardHeightChange') >= 0, '离开页面要注销监听')

          const json = JSON.parse(read('pages/stock-take/stock-take.json'))
          assert.strictEqual(json.usingComponents['page-loading'], '/components/page-loading/index')

          const appJson = JSON.parse(read('app.json'))
          assert.ok(appJson.pages.indexOf('pages/stock-take/stock-take') >= 0,
            '盘点页要登记进 app.json')
          assert.ok(
            !(appJson.tabBar.list || []).some(function (item) {
              return item.pagePath === 'pages/stock-take/stock-take'
            }),
            '盘点页是 navigateTo 的二级页，不许进 tabBar'
          )

          console.log('stock-take tests passed')
        })
      })
    })
  })
}).catch(function (error) {
  console.error(error)
  process.exit(1)
})
