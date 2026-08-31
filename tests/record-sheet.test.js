// 「记一笔」面板的结构与落点。
//
// 这个文件存在的理由：面板做错了在审计里看不出来 —— 少一行、点了去错页、
// 二级没展开，界面照样跑得起来。别的测试覆盖公式，没有一个覆盖导航，
// 所以这里逐行钉住「稿上有哪几行」和「每一行点下去去哪」。
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

// ---------------------------------------------------------------------------
// 一、WXML 结构：稿上的每一行、每一句人话解释都要在
// ---------------------------------------------------------------------------

const wxml = read('components/record-sheet/index.wxml')

// 设计稿 sheet/记一笔(7:165)：五行，顺序 = 节点 y 坐标 67/142/217/292/367
const MAIN_ROWS = [
  ['sale', '销售', '卖货开单，可出送货单'],
  ['purchase', '进货', '补货入库'],
  ['pay', '收款', '收客户的欠款'],
  ['return', '退货', '客户退货原样入库'],
  ['adjust', '库存修正', '换规格加工或盘盈盘亏']
]

let cursor = -1
MAIN_ROWS.forEach(function (row) {
  const action = row[0]
  const label = row[1]
  const desc = row[2]
  const at = wxml.indexOf('data-action="' + action + '"')
  assert.ok(at >= 0, '面板缺少动作行：' + label)
  assert.ok(at > cursor, '面板动作行顺序和设计稿不一致，错在：' + label)
  cursor = at
  assert.ok(wxml.indexOf('>' + label + '</view>') >= 0, '动作行标题对不上稿：' + label)
  assert.ok(wxml.indexOf(desc) >= 0, '动作行缺少人话解释：' + label + ' → ' + desc)
})

// 设计稿 sheet/库存修正 4:31：二级三行，顺序按节点 y 坐标 59 / 130 / 201
const ADJUST_ROWS = [
  ['convert', '换规格 / 加工（总数不变）', '成品换规格、半成品做成成品'],
  ['qty', '数量对不上（盘盈 / 盘亏 / 报损）', '直接改某个规格的件数，不计进销毛利'],
  ['take', '盘一遍这个商品', '各规格账面数带出，只改对不上的那几个规格']
]
// 判定要剥掉注释再做：WXML 的说明文字里也出现过这几个词。
const wxmlBody = wxml.replace(/<!--[\s\S]*?-->/g, '')
let adjCursor = -1
ADJUST_ROWS.forEach(function (row) {
  const at = wxmlBody.indexOf('data-action="' + row[0] + '"')
  assert.ok(at >= 0, '库存修正二级缺少：' + row[1])
  assert.ok(at > adjCursor, '库存修正二级的顺序和设计稿不一致，错在：' + row[1])
  adjCursor = at
  assert.ok(wxmlBody.indexOf('>' + row[1] + '</view>') >= 0, '二级行标题对不上稿：' + row[1])
  assert.ok(wxmlBody.indexOf(row[2]) >= 0, '二级行缺少人话解释：' + row[1])
})
assert.ok(
  wxml.indexOf('库存修正只改件数：不计入进货、销售、毛利，也不产生欠款') >= 0,
  '二级缺少「只改件数」那句 note'
)

// 三条关闭通道（设计稿 UX注释/骨架 n-遮罩）
assert.ok(wxml.indexOf('js-rs-mask') >= 0 && wxml.indexOf('bindtap="onClose"') >= 0, '缺少点遮罩关闭')
assert.ok(wxml.indexOf('js-rs-cancel') >= 0, '缺少底部「取消」')
assert.ok(wxml.indexOf('bindtouchstart="onGrabStart"') >= 0, '缺少 grabber 下滑关闭')

// picker 的标题与空态文案（sheet/选原销售单 11:29、sheet/select·收款 11:58）
assert.ok(wxml.indexOf('选择原销售单') >= 0, '退货缺少选原销售单 picker')
assert.ok(wxml.indexOf('只列出还没退完的销售单') >= 0, '选原销售单缺 hint')
assert.ok(wxml.indexOf('没有可退的销售单') >= 0, '选原销售单缺空态')
assert.ok(wxml.indexOf('选择客户') >= 0, '收款缺少选客户 picker')
assert.ok(wxml.indexOf('只列有欠款的客户') >= 0, '选客户缺 hint')
assert.ok(wxml.indexOf('没有欠款客户，都收清了') >= 0, '选客户缺空态')

// ---------------------------------------------------------------------------
// 二、落点：每一行点下去到底去哪个页面
// ---------------------------------------------------------------------------

function loadComponent(storeStub, wxStub) {
  const src = read('components/record-sheet/index.js')
  let captured = null
  const sandbox = {
    module: { exports: {} },
    console: console,
    wx: wxStub,
    require: function (id) {
      if (id.indexOf('store') >= 0) return storeStub
      if (id.indexOf('inventory') >= 0) return inventory
      if (id.indexOf('util') >= 0) return util
      throw new Error('组件出现了预期外的 require: ' + id)
    },
    Component: function (def) { captured = def }
  }
  vm.runInNewContext(src, sandbox)
  assert.ok(captured, '组件没有调用 Component()')
  const inst = Object.assign({}, captured.methods)
  inst.data = JSON.parse(JSON.stringify(captured.data))
  inst.closed = 0
  inst.setData = function (patch) { Object.assign(inst.data, patch) }
  inst.triggerEvent = function (name) { if (name === 'close') inst.closed++ }
  return inst
}

function makeWx() {
  const calls = []
  return {
    calls: calls,
    navigateTo: function (o) { calls.push(['navigateTo', o.url]) },
    switchTab: function (o) { calls.push(['switchTab', o.url]) },
    showToast: function () {},
    showModal: function () {}
  }
}

function tapMain(action) {
  const wxStub = makeWx()
  const inst = loadComponent({}, wxStub)
  inst.onAction({ currentTarget: { dataset: { action: action } } })
  return { inst: inst, calls: wxStub.calls }
}

// A3 批把 tabBar 收到 4 个（看板/商品/流水/客户），销售和进货已撤出 tabBar，
// 是普通页，只能 navigateTo —— 它们不在 tabBar 里，switchTab 会直接 fail。
// makeWx() 的 switchTab stub **故意留着**：谁把 switchTab 加回组件，下面两条
// deepStrictEqual 会立刻红。
const sale = tapMain('sale')
assert.deepStrictEqual(sale.calls, [['navigateTo', '/pages/sale/sale']], '销售没去销售页')
assert.strictEqual(sale.inst.closed, 1, '跳转后面板要关掉')

const purchase = tapMain('purchase')
assert.deepStrictEqual(purchase.calls, [['navigateTo', '/pages/purchase/purchase']], '进货没去进货页')

// 库存修正是展开二级，不是跳页
const adjustTap = tapMain('adjust')
assert.deepStrictEqual(adjustTap.calls, [], '库存修正不该直接跳页')
assert.strictEqual(adjustTap.inst.data.step, 'adjust', '库存修正没有展开二级')
assert.strictEqual(adjustTap.inst.closed, 0, '展开二级不该关掉面板')

// 二级：换规格 → convert（自带商品 picker，无参可进）
const convertWx = makeWx()
const convertInst = loadComponent({}, convertWx)
convertInst.onAdjustAction({ currentTarget: { dataset: { action: 'convert' } } })
assert.deepStrictEqual(convertWx.calls, [['navigateTo', '/pages/convert/convert']], '换规格没去 convert')

// 三个 picker 的落点。这三页都有入参守卫，不带 id 进去是「流水不存在」/
// 「请从商品编辑进入」，所以面板必须先选再跳。
const payWx = makeWx()
loadComponent({}, payWx).onPickCustomer({ currentTarget: { dataset: { id: 'c1' } } })
assert.deepStrictEqual(
  payWx.calls,
  [['navigateTo', '/pages/customer-detail/customer-detail?id=c1&pay=1']],
  '收款要带客户 id 进客户详情页的收款态'
)

const retWx = makeWx()
loadComponent({}, retWx).onPickOrder({ currentTarget: { dataset: { id: 'r9' } } })
assert.deepStrictEqual(
  retWx.calls,
  [['navigateTo', '/pages/sale-return/sale-return?id=r9']],
  '退货要带原销售单 id'
)

// 商品 picker 有两个落点，由 pickTarget 决定。默认那一档（数量对不上）不许漂。
const qtyWx = makeWx()
loadComponent({}, qtyWx).onPickProduct({ currentTarget: { dataset: { id: 'p7' } } })
assert.deepStrictEqual(
  qtyWx.calls,
  [['navigateTo', '/pages/adjust/adjust?id=p7']],
  'adjust 收 ?id=<productId>，必须带商品 id'
)

const takeWx = makeWx()
const takeInst = loadComponent({}, takeWx)
takeInst.data.pickTarget = 'take'
takeInst.onPickProduct({ currentTarget: { dataset: { id: 'p7' } } })
assert.deepStrictEqual(
  takeWx.calls,
  [['navigateTo', '/pages/stock-take/stock-take?id=p7']],
  '「盘一遍这个商品」要带商品 id 进盘点页（Screen/02b）'
)

// 两条路各自把 pickTarget 和 hint 设对，否则选完商品会去错页
const routeInst = loadComponent({ ready: function () { return Promise.resolve(false) } }, makeWx())
routeInst.onAdjustAction({ currentTarget: { dataset: { action: 'take' } } })
assert.strictEqual(routeInst.data.pickTarget, 'take', '第三行要把 picker 的落点设成 take')
assert.ok(routeInst.data.productHint.indexOf('规格') >= 0, '盘点档的 picker hint 要说清楚是盘所有规格')

const routeInst2 = loadComponent({ ready: function () { return Promise.resolve(false) } }, makeWx())
routeInst2.onAdjustAction({ currentTarget: { dataset: { action: 'qty' } } })
assert.strictEqual(routeInst2.data.pickTarget, 'adjust', '第二行的 picker 落点仍是 adjust')

// ---------------------------------------------------------------------------
// 三、两个 picker 的筛选口径
// ---------------------------------------------------------------------------

// 收款 picker：只列有欠款的，按欠款倒序（设计稿 UX注释/骨架 n8）
const customerStore = {
  ready: function () { return Promise.resolve(true) },
  getCustomers: function () {
    return [
      { id: 'a', name: '老陈', account: { count: 1, amount: 500, receivable: 500 } },
      { id: 'b', name: '收清了的', account: { count: 1, amount: 100, receivable: 0 } },
      { id: 'c', name: '李老板', account: { count: 2, amount: 1500, receivable: 1500 } },
      { id: 'd', name: '没记过账的' }
    ]
  }
}
const payPicker = loadComponent(customerStore, makeWx())
payPicker.refreshCustomers()
assert.deepStrictEqual(
  payPicker.data.customers.map(function (x) { return x.name }),
  ['李老板', '老陈'],
  '收款 picker 只列有欠款的客户，且按欠款从多到少'
)
assert.strictEqual(payPicker.data.debtCount, 2)
assert.strictEqual(payPicker.data.debtTotalText, util.money(2000), '欠款合计对不上')

// 退货 picker：只列可退 > 0 的销售单；退过一部分才标件数，没退过只说「未退过」
function saleRecord(id, name, qty, returnedQty) {
  return {
    id: id,
    type: 'out',
    createdAt: new Date(2026, 7, 25, 14, 32).getTime(),
    customerName: name,
    amount: 352,
    lines: [
      { lineId: id + '-1', productName: '四件套', qty: qty, returnedQty: returnedQty, unitPrice: 176 }
    ]
  }
}
const orderStore = {
  ready: function () { return Promise.resolve(true) },
  listRecords: function () {
    return Promise.resolve({
      records: [
        saleRecord('r1', '王姐', 2, 1),      // 退过 1，可退 1
        saleRecord('r2', '全退完的', 2, 2),  // 可退 0 → 不该出现
        saleRecord('r3', '李老板', 3, 0)     // 从未退过，可退 3
      ],
      cursor: '',
      hasMore: false
    })
  }
}

const orderPicker = loadComponent(orderStore, makeWx())
orderPicker.openOrderPicker().then(function () {
  // Array.from 不能省：组件跑在 vm 沙箱里，沙箱有自己的 Array 构造器，
  // 组件内部 new 出来的数组原型和宿主对不上，deepStrictEqual 会比原型比挂。
  const rows = Array.from(orderPicker.data.orders)
  assert.deepStrictEqual(
    Array.from(rows.map(function (r) { return r.customerText })),
    ['王姐', '李老板'],
    '退货 picker 要滤掉已经退完的销售单'
  )
  assert.ok(
    rows[0].returnText.indexOf('可退 1 件') >= 0,
    '退过一部分要标可退件数，实际：' + rows[0].returnText
  )
  // 判「可退 N 件」这个形态，不能光判有没有「件」字——商品名自己就可能带（四件套）
  assert.ok(
    rows[1].returnText.indexOf('未退过') >= 0 && !/可退 \d/.test(rows[1].returnText),
    '从未退过不标件数（设计稿 n5），实际：' + rows[1].returnText
  )
  // 单号走 docNo，不是不透明的 record.id
  assert.ok(
    rows[0].subText.indexOf('CK20260825-') >= 0,
    '单号要用 util.formatDocNo，实际：' + rows[0].subText
  )

  // -------------------------------------------------------------------------
  // 四、两个入口：看板主按钮 + 流水页 FAB，点开同一个组件
  // -------------------------------------------------------------------------

  const indexWxml = read('pages/index/index.wxml')
  assert.ok(indexWxml.indexOf('js-record-entry') >= 0, '看板缺少「记一笔」主按钮')
  assert.ok(indexWxml.indexOf('＋ 记一笔') >= 0, '主按钮文案对不上稿 btn/记一笔 4:983')
  assert.ok(indexWxml.indexOf('<record-sheet') >= 0, '看板没挂面板组件')

  const recordsWxml = read('pages/records/records.wxml')
  assert.ok(recordsWxml.indexOf('js-record-fab') >= 0, '流水页缺少 FAB')
  assert.ok(recordsWxml.indexOf('<record-sheet') >= 0, '流水页没挂面板组件')

  const indexJson = JSON.parse(read('pages/index/index.json'))
  const recordsJson = JSON.parse(read('pages/records/records.json'))
  assert.strictEqual(indexJson.usingComponents['record-sheet'], '/components/record-sheet/index')
  assert.strictEqual(recordsJson.usingComponents['record-sheet'], '/components/record-sheet/index')

  // -------------------------------------------------------------------------
  // 五、纪律：字号热区走变量，不写死
  // -------------------------------------------------------------------------

  const wxss = read('components/record-sheet/index.wxss')
  assert.ok(!/font-size:\s*\d/.test(wxss), '面板不许写死字号，一律用 docs/ui-scale.md 的变量')
  ;['--fs-caption', '--fs-body', '--fs-title', '--tap-min'].forEach(function (token) {
    assert.ok(wxss.indexOf(token) >= 0, '面板应当消费 ' + token)
  })

  // picker 列表区固定高（稿 UX注释/骨架 的 n-picker列表高）。搜不到结果时若高度跟着塌，
  // 面板会在手指还在键盘上时在底下跳，而 sheet 从底部升起，塌陷还会把搜索框一起往下拽。
  const bodyRule = /\.rs-picker-body\s*\{([^}]*)\}/.exec(wxss)
  assert.ok(bodyRule, '缺 .rs-picker-body：三个 picker 的 loading / 列表 / 空态要罩在同一个固定高外壳里')
  assert.ok(
    /(^|[^-])height:\s*640rpx/.test(bodyRule[1]),
    '.rs-picker-body 必须是固定 height 而不是 max-height，否则空态照样会塌：' + bodyRule[1].trim()
  )
  const listRule = /\.rs-list\s*\{([^}]*)\}/.exec(wxss)
  assert.ok(listRule, '缺 .rs-list')
  assert.ok(
    !/max-height/.test(listRule[1]),
    '.rs-list 不该再自己夹高度 —— 高度由 .rs-picker-body 决定，两处都夹会打架：' + listRule[1].trim()
  )
  assert.ok(
    /min-height:\s*0/.test(listRule[1]),
    '.rs-list 作为 flex 子项要 min-height: 0，否则默认 auto 会被内容撑破外壳、把面板重新顶高'
  )
  // 空态要在固定高外壳里垂直居中。固定高之后才需要这条：空态文案自身只有一行，
  // 不居中就贴在 320px 盒子顶部、下面一大片空白（稿 11:55 / 11:77 都是居中的）。
  const emptyRule = /\.rs-picker-body\s*>\s*\.rs-empty\s*\{([^}]*)\}/.exec(wxss)
  assert.ok(emptyRule, '缺 .rs-picker-body > .rs-empty：空态会贴在固定高外壳顶部')
  // 四个声明少任何一个居中都坏，所以四个都要钉 —— 只钉 align-items 是不够的：
  //   · 没有 display: flex，align-items 在非 flex 容器上完全失效（静默，看不出来）
  //   · 没有 flex: 1，空态只有自身一行高（约 51px），居中的是它自己，照样贴外壳顶部
  // 另外两个**有意不钉**，实测删掉居中仍成立，不是漏了：
  //   · justify-content: center —— .rs-empty 自带 text-align: center 兜底
  //   · min-height: 0 —— 空态内容比外壳矮，撑不破，这里不承重（.rs-list 那条才承重）
  ;[
    [/display:\s*flex/, 'display: flex —— 没有它 align-items 在非 flex 容器上静默失效'],
    [/flex:\s*1/, 'flex: 1 —— 没有它空态只有自身一行高，居中的是它自己，仍贴顶'],
    [/align-items:\s*center/, 'align-items: center —— 垂直居中本身']
  ].forEach(function (pair) {
    assert.ok(
      pair[0].test(emptyRule[1]),
      '外壳里的空态要垂直居中，缺 ' + pair[1] + '：' + emptyRule[1].trim()
    )
  })

  // 三个 picker 一个都不能漏：漏掉的那个搜不到时照样塌。
  const sheetWxml = read('components/record-sheet/index.wxml')
  assert.strictEqual(
    (sheetWxml.match(/class="rs-picker-body"/g) || []).length,
    3,
    '三个 picker（选客户 / 选原销售单 / 选商品）都要套 .rs-picker-body'
  )

  // 组件不许开 virtualHost：开了页面侧就没有宿主节点，automator 从页面够不到组件里
  // 的任何东西（tests/ui.test.js 在 slip-overlay 上实测过 page.$$ / >>> / selectComponent
  // 全是 0），tests/ui.test.js 里那一整组面板用例会当场失效。面板本体 position: fixed
  // 不占流，留着宿主节点不影响排版。
  const sheetJs = read('components/record-sheet/index.js')
  assert.ok(
    !/virtualHost\s*:\s*true/.test(sheetJs),
    'record-sheet 不许开 virtualHost：开了 UI 测试就够不到面板里的任何元素'
  )
  ;['pages/index/index.wxml', 'pages/records/records.wxml'].forEach(function (rel) {
    assert.ok(
      read(rel).indexOf('<record-sheet id="record-sheet"') >= 0,
      rel + ' 的 <record-sheet> 要带 id="record-sheet"：UI 测试靠它取组件实例读 data'
    )
  })

  const appWxss = read('app.wxss')
  ;['--fs-caption', '--fs-label', '--fs-body', '--fs-title', '--tap-min'].forEach(function (token) {
    assert.ok(appWxss.indexOf(token + ':') >= 0, 'app.wxss 缺少 ui-scale.md 的 ' + token)
  })
  // --fs-hero 旧表是 48rpx、文档是 80rpx，逐屏批全部迁完之前不许动。实读 5 个消费点、
  // 4 个页面，语义互不相同：pages/index 的 .hero-title 与 .hero-profit-num 才是看板
  // hero（且要先有按位数降档的 class），pages/customer-edit 的 .debt-num 该走
  // --fs-hero-md(68rpx)，pages/products 与 pages/product-detail 的 .thumb-text 是
  // 图卡占位文字、根本不属于 hero 档。移交清单见 0b 批 PR 正文。
  assert.ok(
    /--fs-hero:\s*48rpx/.test(appWxss),
    '--fs-hero 必须留在 48rpx；改成文档的 80rpx 会一次改错 5 个消费点里的 3 个'
  )

  console.log('record-sheet tests passed')
}).catch(function (error) {
  console.error(error)
  process.exit(1)
})
