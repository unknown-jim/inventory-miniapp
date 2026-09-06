// G322 第二轮：`store.ready()` 失败时，页面不再默默留一张空屏。
//
// 【修的是什么】
// 十个页面里有八个在 `ready()` 失败时只有一句
// `this.setData({ pageLoading: false }); return` —— 屏上就是一个空列表 / 空页面，
// 一个字都不说。另外两个（sale-return / customer-detail）说了话，但两条失败因被
// `ready()` 塌成同一个 `false`，于是一律写「检查网络后重试」：
// 对「没选店」「被移出店铺」那一类**是错的诊断**，而且还配一枚点了不会好的按钮。
//
// 【这一层钉什么、钉不到什么】
// 钉的是「页面在失败时把哪几个字段写成了什么」和「模板里那一支排在主体前面」。
//   · 行为钉真跑 `onShow`：往 require.cache 里塞 store 替身，`global.Page` 挂钩接住
//     页面模块交上来的那个对象，跑的就是仓库里那份程序（形状抄 tests/customer-card.test.js）。
//   · 静态钉只看 wxml 文本的先后，**不解析 wxml**：两支不在同一条 wx:if 链上、
//     或者挂在别的父节点下面，它看不出来；屏上最终渲染哪一支要 test:ui 才知道。
// 钉不到的还有：`store.readyOrFailure()` 自己的分类对不对 —— 那是
// tests/store.test.js 的 5'') 那一节，那里跑的是真 store + 真 ledger-core.dispatch。
// 本文件一律拿替身喂，只管页面这一层。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const messages = require('../utils/messages')

const ROOT = path.join(__dirname, '..')

// 八个从前什么都不说的页面。sale-return / customer-detail 不在这张表里：
// 它们本来就有错误态，改的是文案与按钮，钉子分别在下面第 5 节和
// tests/customer-card.test.js。
const PAGES = [
  'customers', 'products', 'sale', 'purchase',
  'product-detail', 'low-stock', 'members', 'stock-take'
]

// 失败描述的两种形状，与 utils/store.js 的 readyOrFailure 对齐。
const NET = { retryable: true, title: '加载失败', text: '网络异常，请检查网络后重试' }
const KICKED = {
  retryable: false,
  title: '还不能记账',
  text: messages.forStaff('不是该店成员').text
}

// ---------------------------------------------------------------------------
// 页面加载器：塞 store 替身 + 接住 Page()
// ---------------------------------------------------------------------------
function baseStore(extra) {
  const stub = {
    isReady: function () { return false },
    getProducts: function () { return [] },
    getSkus: function () { return [] },
    getCustomers: function () { return [] },
    getCategories: function () { return [] },
    getCustomer: function () { return null },
    getProduct: function () { return null },
    getShopName: function () { return '测试店' },
    getRecent: function () { return [] },
    getTotals: function () { return {} },
    whoami: function () { return Promise.resolve('me-openid') },
    listMembers: function () { return Promise.resolve({ members: [], role: 'owner' }) },
    listRecords: function () { return Promise.resolve({ records: [], cursor: '' }) },
    dataVersion: function () { return 1 }
  }
  return Object.assign(stub, extra || {})
}

function stubWx() {
  return {
    getStorageSync: function () { return '' },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    showToast: function () {},
    showModal: function (o) { if (o && o.complete) o.complete({}) },
    showLoading: function () {},
    hideLoading: function () {},
    navigateTo: function () {},
    navigateBack: function () {},
    switchTab: function () {},
    setNavigationBarTitle: function () {},
    onKeyboardHeightChange: function () {},
    offKeyboardHeightChange: function () {},
    createSelectorQuery: function () {
      return {
        select: function () { return this },
        boundingClientRect: function () { return this },
        exec: function () {}
      }
    }
  }
}

function loadPage(name, stub) {
  const storePath = require.resolve('../utils/store')
  const modPath = require.resolve('../pages/' + name + '/' + name + '.js')
  const prevStore = require.cache[storePath]
  const prevPage = global.Page
  const prevGetApp = global.getApp
  const prevWx = global.wx
  let captured = null
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: stub }
  global.Page = function (o) { captured = o }
  global.getApp = function () {
    return {
      globalData: {},
      consumeSelectedProduct: function () { return '' },
      consumeSelectedCustomer: function () { return '' },
      consumePendingInventoryFilter: function () { return '' }
    }
  }
  global.wx = stubWx()
  try {
    delete require.cache[modPath]
    require(modPath)
  } finally {
    if (prevStore) require.cache[storePath] = prevStore
    else delete require.cache[storePath]
    global.Page = prevPage
    global.getApp = prevGetApp
    delete require.cache[modPath]
  }
  assert.ok(captured, name + ' 应当调用一次 Page()')
  // setData 收下并**调用**回调：丢掉回调的话，回调里再写一次 setData 就完全逃逸。
  captured.setData = function (o, cb) { Object.assign(captured.data, o); if (cb) cb() }
  return captured
}

// onShow 里 store 之外的东西（getApp、wx）在跑的时候也得在，所以每次跑都把
// 全局摆回去。跑完还原，别把状态漏给下一个用例。
function runOnShow(page, fn) {
  const prevGetApp = global.getApp
  const prevWx = global.wx
  global.getApp = function () {
    return {
      globalData: {},
      consumeSelectedProduct: function () { return '' },
      consumeSelectedCustomer: function () { return '' },
      consumePendingInventoryFilter: function () { return '' }
    }
  }
  global.wx = stubWx()
  return Promise.resolve()
    .then(function () { return fn ? fn() : page.onShow() })
    .then(function (value) {
      global.getApp = prevGetApp
      global.wx = prevWx
      return value
    }, function (error) {
      global.getApp = prevGetApp
      global.wx = prevWx
      throw error
    })
}

// ---------------------------------------------------------------------------
// 1) 模板：每一页都有那一支，而且排在主体之前
// ---------------------------------------------------------------------------
function stripWxmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

PAGES.forEach(function (name) {
  const wxml = stripWxmlComments(
    fs.readFileSync(path.join(ROOT, 'pages', name, name + '.wxml'), 'utf8'))

  const guard = wxml.indexOf('wx:elif="{{loadErrorText}}"')
  assert.ok(guard >= 0,
    name + '.wxml 应当有 loadErrorText 那一支（稿 state/error 3:759）——'
      + '没有它，ready() 失败时屏上就是一个不说话的空页面')

  const body = wxml.indexOf('<block wx:else>')
  assert.ok(body >= 0, name + '.wxml 应当还有主体那一支 <block wx:else>')
  assert.ok(guard < body,
    name + '.wxml 的错误态要排在主体的 <block wx:else> 之前，排在后面就永远轮不到它')

  // 可重试与不可重试是两种错误态（docs/ui-scale.md「新页面要」第 5 条）：
  // 那枚「重试」必须挂在 loadErrorRetry 上，无条件出现就是在骗人。
  const gate = wxml.indexOf('wx:if="{{loadErrorRetry}}"')
  assert.ok(gate > guard && gate < body,
    name + '.wxml 里那枚「重试」要挂在 loadErrorRetry 上：没选店 / 被移出店铺'
      + '点几次都不会好，那时不该有这枚按钮')
  assert.ok(wxml.indexOf('bindtap="reload"') > guard,
    name + '.wxml 的重试按钮应当绑 reload')

  // 标题和正文都是绑定，不是死字：这两句由 store 给，同一件事在哪一页都是同一句话。
  assert.ok(wxml.indexOf('{{loadErrorTitle}}') > guard,
    name + '.wxml 的错误态标题应当绑 loadErrorTitle，不许写死 ——'
      + '「被移出店铺」和「网络断了」不是同一个标题')
  assert.ok(wxml.indexOf('{{loadErrorText}}', guard + 1) > guard,
    name + '.wxml 的错误态正文应当绑 loadErrorText')
})

// ---------------------------------------------------------------------------
// 2) 行为：失败时三个字段真的落进 data，而且屏不留在加载态上
// ---------------------------------------------------------------------------
function assertFailureLands(name, failure) {
  const page = loadPage(name, baseStore({
    readyOrFailure: function () { return Promise.resolve(failure) }
  }))
  return runOnShow(page).then(function () {
    assert.strictEqual(page.data.loadErrorText, failure.text,
      name + '：ready 失败时正文应当逐字是 store 给的那句，实为「'
        + page.data.loadErrorText + '」——空的话屏上就是一个不说话的空页面')
    assert.strictEqual(page.data.loadErrorTitle, failure.title,
      name + '：标题也要是 store 给的那个')
    assert.strictEqual(page.data.loadErrorRetry, failure.retryable,
      name + '：给不给重试按钮由 store 说了算。'
        + '不可重试那一类点几次都不会好，摆一枚重试按钮是骗人')
    assert.strictEqual(page.data.pageLoading, false,
      name + '：也不能把屏留在加载态上——转圈转到天荒地老也是一种说谎')
  })
}

// ---------------------------------------------------------------------------
// 3) 行为：加载成功之后错误卡要收掉（**同一个页面实例**）
//    反向控制不落在 data 初值上：先真的失败一次把三个字段写满，再成功一次。
//    落在初值上的话，把页面里那句「先收掉上一轮的错误卡」整行删掉它也恒绿。
// ---------------------------------------------------------------------------
function assertSuccessClears(name) {
  const seq = [KICKED, null]
  const page = loadPage(name, baseStore({
    readyOrFailure: function () { return Promise.resolve(seq.shift()) }
  }))
  return runOnShow(page).then(function () {
    assert.ok(page.data.loadErrorText, name + '：前置条件——第一次要真的落进错误态')
    return runOnShow(page)
  }).then(function () {
    assert.strictEqual(page.data.loadErrorText, '',
      name + '：加载成功之后错误卡必须收掉，实为「' + page.data.loadErrorText + '」——'
        + '留着的话它会盖在这次取回来的数据上（失败后切后台再切回来就走到这里）')
    assert.strictEqual(page.data.loadErrorRetry, false, name + '：重试标志也要一起收掉')
  })
}

// ---------------------------------------------------------------------------
// 4) 行为：错误卡上那枚「重试」真的重走加载
// ---------------------------------------------------------------------------
function assertReloadReruns(name) {
  let asked = 0
  const page = loadPage(name, baseStore({
    readyOrFailure: function () { asked += 1; return Promise.resolve(NET) }
  }))
  return runOnShow(page).then(function () {
    const before = asked
    assert.strictEqual(typeof page.reload, 'function',
      name + '：错误卡上那枚按钮绑的是 reload，页面得真有这个方法')
    return runOnShow(page, function () { return page.reload() }).then(function () {
      assert.ok(asked > before,
        name + '：点重试必须真的再问一次 store —— 不问的话那枚按钮是个摆设')
    })
  })
}

// ---------------------------------------------------------------------------
// 5) sale-return：可重试那一半保留本页自己那句（说的是「这张单」，更准），
//    不可重试那一半改说真原因，并且收掉重试按钮。
// ---------------------------------------------------------------------------
function assertSaleReturnSplitsTwoClasses() {
  function mount(failure) {
    const page = loadPage('sale-return', baseStore({
      readyOrFailure: function () { return Promise.resolve(failure) },
      fetchRecord: function () { return Promise.reject(new Error('本用例走不到这一步')) }
    }))
    page.orderId = 'r-1'
    return page
  }
  const net = mount(NET)
  return runOnShow(net, function () { return net.load() }).then(function () {
    assert.strictEqual(net.data.loadErrorRetry, true, 'sale-return：网络那一类要给重试')
    assert.notStrictEqual(net.data.loadErrorText, NET.text,
      'sale-return：可重试那一半保留本页自己那句，不换成 store 的通用那句 ——'
        + '本页那句说的是这张退货单读不出来，比「网络异常」具体。'
        + '实为「' + net.data.loadErrorText + '」')
    assert.notStrictEqual(net.data.loadErrorText.indexOf('账本没读到'), -1,
      'sale-return：可重试那一半仍然是本页原来那句（PR #141 之前就在的文案）')
    const kicked = mount(KICKED)
    return runOnShow(kicked, function () { return kicked.load() }).then(function () {
      assert.strictEqual(kicked.data.loadErrorRetry, false,
        'sale-return：被移出店铺点几次都不会好，不给重试按钮')
      assert.strictEqual(kicked.data.loadErrorText, KICKED.text,
        'sale-return：这一类要说真原因，实为「' + kicked.data.loadErrorText + '」')
      assert.strictEqual(kicked.data.loadErrorText.indexOf('检查网络'), -1,
        'sale-return：「检查网络后重试」正是 G322 要消灭的那句错诊断')
    })
  })
}

// ---------------------------------------------------------------------------
// 6) messages.PERMANENT 不许和话术表脱钩
//    它是「点重试不会好」的判据，拿正则扫中文原文，服务端改一个字就静默失配。
//    tests/messages.test.js 已经逐条把 RULES 的 literal 钉在源文件上；这里再把
//    PERMANENT 钉在 RULES 上，两段接起来就是「服务端原文 → 判据」一条链。
// ---------------------------------------------------------------------------
function assertPermanentStaysAnchored() {
  messages.PERMANENT.forEach(function (re) {
    const hit = messages.RULES.filter(function (rule) { return re.test(rule.literal) })
    assert.strictEqual(hit.length, 1,
      'PERMANENT 里的 ' + re + ' 应当**恰好**命中话术表里的一条 literal，实为 '
        + hit.length + ' 条。命中 0 条说明服务端原文改了而这条判据没跟上（'
        + '于是「点重试不会好」的那一类会被判成可重试）；命中多条说明它太宽')
  })
  // 反向：可重试的那一条不许被划进来。RULES 里「账本没取到，请重试」是最该给
  // 重试按钮的一条 —— 「我们知道这是什么毛病」和「再点一次有没有用」是两个问题。
  assert.strictEqual(messages.isPermanent('账本没取到，请重试'), false,
    '「账本没取到，请重试」是可重试的那一类，不许划进 PERMANENT')
  assert.strictEqual(messages.isPermanent('不是该店成员'), true,
    '被移出店铺是 G322 的头号场景，必须判成不可重试')
  return Promise.resolve()
}

// ---------------------------------------------------------------------------
let chain = Promise.resolve()
PAGES.forEach(function (name) {
  chain = chain
    .then(function () { return assertFailureLands(name, NET) })
    .then(function () { return assertFailureLands(name, KICKED) })
    .then(function () { return assertSuccessClears(name) })
    .then(function () { return assertReloadReruns(name) })
})
chain
  .then(assertSaleReturnSplitsTwoClasses)
  .then(assertPermanentStaysAnchored)
  .then(function () {
    console.log('ready-error-state tests passed（' + PAGES.length + ' 个页面 + sale-return）')
  }, function (error) {
    console.error(error)
    process.exit(1)
  })
