// utils/slip-actions.js 的竞态守卫：这是「异步返回顺序」型缺陷，读代码读不出来
// （上一轮就漏了），手工点也复现不稳定——wx.showLoading({ mask: true }) 挡住触摸，
// 用户手速再快也点不到 chip，所以真机上「切样式时旧图覆盖新图」几乎不会自己冒出来。
// 守卫本身又长得像可以「简化」的样板：下一个人把 stillCurrent 收回成只比 docNo，
// 不比样式，现在没有任何东西会红。这个文件就是钉住这条不变式。
//
// 只 fake utils/slip-image.js 的 exportToTempFile 一个函数：slip-actions.js 是
// `const slipImage = require('./slip-image'); slipImage.exportToTempFile(...)`，
// 调用时才做属性查找，不是解构绑定，所以直接改 exports 上的这一个属性就够，
// canvas 和 wx 的画布 API 一行都不用碰。
const assert = require('assert')
const slipActions = require('../utils/slip-actions')
const slipImage = require('../utils/slip-image')
// 第 7 节走的是真实的 store 和真实的送货单视图，不是替身：导出样式记忆的 key
// 来自 util.withSlipView 递出的 customerId，少了它整条记忆链路会静默退化成
// 「所有客户共用一条空 key」。这两个模块本来就被 slip-actions.js 顺带加载了，
// 这里只是显式拿到它们的引用。
const store = require('../utils/store')
const util = require('../utils/util')

// 只有 utils/store.js 的 getSlipExportStyle/setSlipExportStyle 会摸 wx 存储，
// 一个 Map 撑起来就够，参见 tests/store.test.js 的同类夹具。
// 返回这只 Map：第 5 节要按店切 inv_shop_id、并在每个场景之间清干净，
// 前四节留下的样式记忆不能漏到后面去。
function installWxStub() {
  const storage = new Map()
  global.wx = {
    getStorageSync: function (key) {
      return storage.has(key) ? storage.get(key) : ''
    },
    setStorageSync: function (key, value) {
      storage.set(key, value)
    }
  }
  return storage
}

function makePage(overrides) {
  const page = {
    data: Object.assign({
      showSlip: true,
      slip: { docNo: 'X', customerId: 'c1' },
      exportStyle: 'summary',
      exporting: false
    }, overrides),
    setData: function (patch) {
      Object.assign(this.data, patch)
    }
  }
  page.slipImagePath = ''
  return page
}

// 手动挡住 resolve/reject 的 promise：不能让 exportToTempFile 自己决定谁先回来，
// 用例要能摆布「先 resolve 哪个」。
function deferred() {
  let resolve, reject
  const promise = new Promise(function (res, rej) {
    resolve = res
    reject = rej
  })
  return { promise: promise, resolve: resolve, reject: reject }
}

// 每次调用都记一笔（含调用时的 exportStyle），返回一个可以之后单独摆布的 deferred。
// 不用真的检查 page/slip 参数——四个用例只关心「谁先回来、回来时守卫认不认」。
function installFakeExport() {
  const calls = []
  slipImage.exportToTempFile = function (page, slip, exportStyle) {
    const d = deferred()
    calls.push({ exportStyle: exportStyle, resolve: d.resolve, reject: d.reject })
    return d.promise
  }
  return calls
}

// 把控制权交回事件循环，让 exportToTempFile 的 .then/.catch 走完
function tick(times) {
  let p = Promise.resolve()
  for (let i = 0; i < (times || 3); i++) {
    p = p.then(function () {})
  }
  return p
}

const wxStorage = installWxStub()

;(async function () {

  // -------------------------------------------------------------------------
  // 1) 切 detail → 切回 summary：两次预生成同时在飞，先回来的是 summary，
  //    后回来的是已经不再当选的 detail —— detail 不能覆盖 summary。
  // -------------------------------------------------------------------------
  {
    const calls = installFakeExport()
    const page = makePage()

    slipActions.changeExportStyle(page, 'detail')
    slipActions.changeExportStyle(page, 'summary')

    assert.strictEqual(calls.length, 2, '切两次样式必须各发起一次预生成')
    assert.strictEqual(calls[0].exportStyle, 'detail')
    assert.strictEqual(calls[1].exportStyle, 'summary')

    calls[1].resolve('path-summary')
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-summary', '先回来的当选样式必须写进缓存')

    calls[0].resolve('path-detail')
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-summary',
      '后回来的过期样式（detail）不能覆盖已经写入的当选样式（summary）')
  }

  // -------------------------------------------------------------------------
  // 2) 同上，但过期的那次不是晚到的成功，是晚到的失败：catch 里的守卫也不能把
  //    已经成功写入的当选样式清空。
  // -------------------------------------------------------------------------
  {
    const calls = installFakeExport()
    const page = makePage()

    slipActions.changeExportStyle(page, 'detail')
    slipActions.changeExportStyle(page, 'summary')

    calls[1].resolve('path-summary')
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-summary')

    calls[0].reject(new Error('过期的 detail 生成失败'))
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-summary',
      '过期样式的失败不能清空已经成功写入的当选样式缓存')
  }

  // -------------------------------------------------------------------------
  // 3) 预生成在飞时用户关掉了送货单弹层（showSlip 变 false）：迟到的结果不能
  //    把 closeSlip 清空的缓存又写回来。
  // -------------------------------------------------------------------------
  {
    const calls = installFakeExport()
    const page = makePage()

    slipActions.prepareSlipImage(page, page.data.slip)
    assert.strictEqual(calls.length, 1)

    slipActions.closeSlip(page)
    assert.strictEqual(page.data.showSlip, false)
    assert.strictEqual(page.slipImagePath, '')

    calls[0].resolve('path-late')
    await tick()
    assert.strictEqual(page.slipImagePath, '', '弹层关闭之后才返回的预生成不能把缓存写回来')
  }

  // -------------------------------------------------------------------------
  // 4) 基线：开单、样式没换、没有并发 —— 正常写入缓存。
  // -------------------------------------------------------------------------
  {
    const calls = installFakeExport()
    const page = makePage()

    slipActions.prepareSlipImage(page, page.data.slip)
    assert.strictEqual(calls.length, 1)

    calls[0].resolve('path-base')
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-base', '没有并发时必须正常写入缓存')
  }

  // -------------------------------------------------------------------------
  // 5) 切样式必须让已生成的图片缓存当场作废（changeExportStyle 里那句
  //    page.slipImagePath = ''）。
  //
  //    那一行上面的注释自己写着「这是这条链路最容易漏的坑」，可删掉它之后
  //    npm test 仍然全绿。缓存不作废是**静默**错的：exportSlip 一旦命中
  //    page.slipImagePath 就直接开图、不再重新生成，于是用户切到明细、点导出，
  //    拿到的还是汇总那张——屏上 chip 是明细，纸上是汇总。
  // -------------------------------------------------------------------------
  {
    const calls = installFakeExport()
    const page = makePage()

    slipActions.prepareSlipImage(page, page.data.slip)
    calls[0].resolve('path-summary')
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-summary', '前提：汇总那张图已经生成好了')

    slipActions.changeExportStyle(page, 'detail')
    assert.strictEqual(page.data.exportStyle, 'detail', '前提：样式确实切过去了')
    assert.strictEqual(page.slipImagePath, '',
      '切样式必须当场作废旧样式的图片缓存——留着它，点导出命中的就是旧样式那张图')
    assert.strictEqual(calls.length, 2, '切样式之后要按新样式重新预生成')
    assert.strictEqual(calls[1].exportStyle, 'detail')

    // 作废不是「从此不再填」：新样式那张回来之后缓存要重新填上，填的是新样式
    calls[1].resolve('path-detail')
    await tick()
    assert.strictEqual(page.slipImagePath, 'path-detail',
      '新样式生成完之后缓存要重新填上，填的是新样式那张')
  }

  // -------------------------------------------------------------------------
  // 6) 重复点已经选中的那枚 chip：样式没变就早退——不许再发一次预生成，也不许
  //    把手上这张有效缓存扔掉。删掉那句早退之后 npm test 也是全绿。
  //
  //    比较放在 normalizeExportStyle 之后：当前是 summary、传进来一个未识别值，
  //    夹完也是 summary，那同样是「没变」。拿原始值比会漏掉这一种。
  // -------------------------------------------------------------------------
  {
    const calls = installFakeExport()
    const page = makePage()

    slipActions.prepareSlipImage(page, page.data.slip)
    calls[0].resolve('path-summary')
    await tick()
    assert.strictEqual(calls.length, 1, '前提：只预生成过一次')
    assert.strictEqual(page.slipImagePath, 'path-summary', '前提：缓存里有一张有效的汇总图')

    slipActions.changeExportStyle(page, 'summary')
    assert.strictEqual(calls.length, 1, '重复点已选中的 chip 不许再发一次预生成')
    assert.strictEqual(page.slipImagePath, 'path-summary',
      '重复点已选中的 chip 不许把手上这张有效缓存扔掉')

    slipActions.changeExportStyle(page, '不认识的样式')
    assert.strictEqual(calls.length, 1,
      '未识别值夹成 summary 之后与当前值相同，同样不该重新预生成')
    assert.strictEqual(page.slipImagePath, 'path-summary',
      '未识别值夹成 summary 之后与当前值相同，同样不该扔掉缓存')

    // 反面：真的换了样式才发。没有这一条，上面四条「不该发」全靠「恒不发」也能绿。
    slipActions.changeExportStyle(page, 'detail')
    assert.strictEqual(calls.length, 2, '真的换了样式才重新预生成')
    assert.strictEqual(page.slipImagePath, '', '真的换了样式才作废缓存')
  }

  // -------------------------------------------------------------------------
  // 7) 导出样式**按客户**记住：切样式写回 → 下次开这个客户的单读回来。
  //
  //    走真实的 utils/store.js 和真实的 util.withSlipView，不是替身。PR #126 把
  //    这条链路合进来时整条零断言，下面三处改坏 npm test 全都绿着：
  //      · changeExportStyle 里删掉 store.setSlipExportStyle(...)  → 记不住
  //      · initialExportStyle 恒返回 'summary'                     → 读不出来
  //      · util.withSlipView 不再递 customerId                     → key 恒为空
  //    store 那一端的三条（多店隔离 / 散客 no-op / 非法值兜底）钉在
  //    tests/store.test.js 的第 17 节，两处合起来才盖住整条链路。
  // -------------------------------------------------------------------------
  {
    // 前六节切样式时已经往存储里写过记忆，清干净再开始
    wxStorage.clear()
    wxStorage.set('inv_shop_id', 'shop-A')
    installFakeExport()

    function orderOf(id, customerId, customerName) {
      return {
        id: id,
        type: 'out',
        createdAt: new Date('2026-08-15T12:00:00').getTime(),
        amount: 9,
        paidAmount: 0,
        remark: '',
        customerId: customerId,
        customerName: customerName,
        lines: [{
          lineId: 'r1',
          productName: '纯牛奶 250ml',
          qty: 2,
          unitPrice: 4.5,
          amount: 9,
          createdAt: new Date('2026-08-15T12:00:00').getTime()
        }]
      }
    }

    const slip = util.withSlipView(orderOf('order-1', 'cust-9', '李记便利'), 9, [], '测试店')
    assert.strictEqual(slip.customerId, 'cust-9',
      '送货单视图必须把 customerId 递出来——它是导出样式记忆的 key，'
      + '少了它每个客户拿到的都是同一条空 key 的记忆')

    // 第一次开这个客户的单：没记过，走缺省汇总
    assert.strictEqual(slipActions.initialExportStyle(slip.customerId), 'summary',
      '这个客户没记过样式时，打开送货单应当是汇总')

    const page = makePage({
      slip: slip,
      exportStyle: slipActions.initialExportStyle(slip.customerId)
    })
    slipActions.changeExportStyle(page, 'detail')
    assert.strictEqual(store.getSlipExportStyle(slip.customerId), 'detail',
      '切样式必须按客户写回记忆（changeExportStyle 里的 store.setSlipExportStyle）')

    // 关掉重开：同一个客户必须还记得明细
    const reopened = util.withSlipView(orderOf('order-2', 'cust-9', '李记便利'), 9, [], '测试店')
    assert.strictEqual(slipActions.initialExportStyle(reopened.customerId), 'detail',
      '同一个客户再开送货单，必须记得上次选的明细')

    // 另一个客户不许跟着变：记忆是按客户记的，不是按店记的
    const other = util.withSlipView(orderOf('order-3', 'cust-8', '王记'), 9, [], '测试店')
    assert.strictEqual(slipActions.initialExportStyle(other.customerId), 'summary',
      '记忆按客户记，另一个客户不许跟着变成明细')

    // 散客（没有 customerId）：写不进去，也不许污染别人的记忆
    const walkIn = util.withSlipView(orderOf('order-4', '', ''), 9, [], '测试店')
    assert.strictEqual(walkIn.customerId, '', '前提：散客单没有 customerId')
    const walkInPage = makePage({ slip: walkIn, exportStyle: 'summary' })
    slipActions.changeExportStyle(walkInPage, 'detail')
    assert.strictEqual(slipActions.initialExportStyle(walkIn.customerId), 'summary',
      '散客不写记忆，下次开单仍是汇总')
    assert.strictEqual(slipActions.initialExportStyle(reopened.customerId), 'detail',
      '散客那次切换不许污染有名有姓的客户的记忆')
  }

  console.log('slip-actions.test.js ok')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
