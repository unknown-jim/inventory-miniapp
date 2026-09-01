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

// 只有 utils/store.js 的 getSlipExportStyle/setSlipExportStyle 会摸 wx 存储，
// 一个 Map 撑起来就够，参见 tests/store.test.js 的同类夹具。
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

installWxStub()

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

  console.log('slip-actions.test.js ok')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
