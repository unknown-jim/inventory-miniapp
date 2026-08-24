const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

let automator
try {
  automator = require('miniprogram-automator')
} catch (error) {
  console.error('未安装 miniprogram-automator。请先安装 Node.js，然后在仓库根目录执行 npm install')
  process.exit(1)
}

const projectPath = path.join(__dirname, '..')
const isWindows = process.platform === 'win32'
const fixedPort = Number(process.env.WECHAT_AUTOMATOR_PORT || 0)
const basePort = 9420
const portTimeout = Number(process.env.WECHAT_AUTOMATOR_PORT_TIMEOUT || 180000)
const connectTimeout = Number(process.env.WECHAT_AUTOMATOR_CONNECT_TIMEOUT || 60000)
const stepTimeout = Number(process.env.WECHAT_AUTOMATOR_STEP_TIMEOUT || 30000)
const runTimeout = Number(process.env.WECHAT_AUTOMATOR_RUN_TIMEOUT || 900000)
// 单次 automator.connect 的上限。要比 patchCheckVersion 里那 30 轮等待（最坏约 3 分钟）
// 宽，否则会把本来能连上的情况判死。
const connectAttemptTimeout = Number(process.env.WECHAT_AUTOMATOR_CONNECT_ATTEMPT_TIMEOUT || 240000)
const closeTimeout = Number(process.env.WECHAT_AUTOMATOR_CLOSE_TIMEOUT || 20000)
// 整个脚本的上限，比 runTimeout 再外面一层：runTimeout 只罩着用例本身，起端口和连接
// 这些前置步骤卡住时它根本没起跑。
const scriptTimeout = Number(process.env.WECHAT_AUTOMATOR_SCRIPT_TIMEOUT || 1500000)
// 收尾之后留给进程自己退的宽限。给到 10 秒是量出来的：收尾做完之后，Windows 还要几秒
// 才把 cli 子进程那边的句柄放干净（实测约 5 秒），太短会让兜底看门狗在正常收场时也开火。
const exitGrace = Number(process.env.WECHAT_AUTOMATOR_EXIT_GRACE || 10000)

// 收尾要用到的东西全放模块作用域：断言失败、超时、连接断开、未捕获异常，
// 每条退出路径都够得着，不必依赖 run() 走没走到自己的 finally。
let activeCliPath = ''
let toolOpened = false
let activeMiniProgram = null
const openMiniPrograms = new Set()
const liveCli = new Set()

function resolveCliPath() {
  if (process.env.WECHAT_CLI && fs.existsSync(process.env.WECHAT_CLI)) {
    return process.env.WECHAT_CLI
  }
  if (!isWindows) {
    const mac = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
    return fs.existsSync(mac) ? mac : ''
  }
  const roots = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent')
  ]
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]
    if (!fs.existsSync(root)) continue
    const names = fs.readdirSync(root)
    for (let j = 0; j < names.length; j++) {
      const cli = path.join(root, names[j], 'cli.bat')
      if (fs.existsSync(cli)) return cli
    }
  }
  return ''
}

function step(name) {
  console.log('[UI] ' + name)
}

function errText(error) {
  if (!error) return String(error)
  return error.message ? error.message : String(error)
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function portOpen(port) {
  return new Promise(function (resolve) {
    const socket = net.connect({ host: '127.0.0.1', port: port })
    let settled = false
    const done = function (ok) {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1000)
    socket.on('connect', function () { done(true) })
    socket.on('timeout', function () { done(false) })
    socket.on('error', function () { done(false) })
  })
}

// cli.bat 是 GBK 编码的，第一行 `chcp 65001` 把控制台切到 UTF-8 之后，cmd 会按切页前
// 的字节偏移接着读这个文件，于是把一行注释的后半截当成命令执行——那半截正好以 `CLI`
// 开头。开发者工具的安装目录若在 PATH 上，这个 `CLI` 就解析回 cli.bat 自己，无限递归，
// cmd 一直刷「Maximum setlocal recursion level reached.」，端口永远起不来。
// 把安装目录从子进程的 PATH 上摘掉，那半截注释就找不到命令、只报一句错，真正的命令照跑。
function childEnv(cliPath) {
  const installDir = path.resolve(path.dirname(cliPath)).toLowerCase()
  const env = Object.assign({}, process.env)
  Object.keys(env).forEach(function (key) {
    if (key.toLowerCase() !== 'path') return
    env[key] = String(env[key] || '')
      .split(path.delimiter)
      .filter(function (dir) {
        return dir && path.resolve(dir).toLowerCase() !== installDir
      })
      .join(path.delimiter)
  })
  return env
}

// Node 从 18.20.2 / 20.12.2（CVE-2024-27980 的修复）起不再允许不带 shell 地 spawn
// .bat / .cmd，会直接抛 EINVAL。automator 的 launch() 正是这么拉起 cli.bat 的，
// 而且它把这个 spawn 错误转述成「cliPath 不对」，把人往错方向带。
// 所以这里自己经 cmd.exe 起自动化端口，再用 automator.connect 接上去。
function runCli(cliPath, args) {
  const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : cliPath
  const commandArgs = isWindows ? ['/c', cliPath].concat(args) : args
  const chunks = []
  const started = {
    error: null,
    exitCode: null,
    output: function () {
      const text = chunks.join('').trim()
      return text ? '\nCLI 输出：\n' + text : ''
    }
  }
  const child = childProcess.spawn(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnv(cliPath)
  })
  started.child = child
  liveCli.add(started)
  // 进度和 √ auto 都走 stderr，出错时要一起打出来。
  child.stdout.on('data', function (chunk) { chunks.push(String(chunk)) })
  child.stderr.on('data', function (chunk) { chunks.push(String(chunk)) })
  child.on('error', function (error) { started.error = error })
  child.on('exit', function (code) { started.exitCode = code })
  // 从名册里划掉要等 close 而不是 exit：进程退了不等于那两个管道关了（实测 cli auto
  // 退出之后 PipeWrap 还在 process.getActiveResourcesInfo() 里挂着），而攥着事件循环
  // 不放的正是管道。
  child.on('close', function () { liveCli.delete(started) })
  return started
}

// waitCli 超时之后我们就不管这个子进程了，可 cmd.exe 还在跑，它继承的那两个管道
// 也还挂在事件循环上——光断开 automator 连接，进程照样退不掉。所以收尾时挨个杀掉，
// 并且把读端 destroy 了：孙子进程（cli.bat 里的 node）攥着写端也拖不住我们。
function stopCli(started) {
  const child = started && started.child
  if (!child) return
  // 这几步失败都不影响结论（进程可能已经退了、句柄可能已经关了），一律吞掉。
  try {
    if (started.exitCode == null) child.kill()
  } catch (error) {}
  try {
    if (child.stdout) child.stdout.destroy()
  } catch (error) {}
  try {
    if (child.stderr) child.stderr.destroy()
  } catch (error) {}
  try {
    child.unref()
  } catch (error) {}
}

async function waitCli(label, started, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (started.error) {
      throw new Error('跑 cli ' + label + ' 失败: ' + started.error.message + started.output())
    }
    if (started.exitCode != null) return started.exitCode
    if (Date.now() >= deadline) {
      throw new Error('等 cli ' + label + ' 结束超时（' + Math.round(timeout / 1000) + ' 秒）' + started.output())
    }
    await sleep(1000)
  }
}

async function waitPort(port, want, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await portOpen(port) === want) return true
    if (Date.now() >= deadline) return false
    await sleep(1000)
  }
}

// 端口决定不了工具里开的是哪个项目。端口已被别的项目的自动化会话占着时，
// `cli auto --project` 不会把它抢过来——之前就这么连上去测了另一个 worktree 的代码；
// 换个空端口也不行，第二个工具实例连 Tool.getInfo 都不回。所以先把工具整个退掉。
async function ensurePortFree(cliPath, port) {
  if (!await portOpen(port)) return
  step('端口 ' + port + ' 上已经有别的自动化会话，先退出开发者工具')
  await waitCli('quit', runCli(cliPath, ['quit']), 60000)
  if (!await waitPort(port, false, 60000)) {
    throw new Error('退出开发者工具后端口 ' + port + ' 仍被占用，手动关掉工具再跑')
  }
}

// cli auto 会一直等到工具打开项目、自动化端口能用了才退出，所以先等它退出，再确认端口。
async function startAutoPort(cliPath, port) {
  const args = ['auto', '--project', projectPath, '--auto-port', String(port)]
  const started = runCli(cliPath, args)
  const code = await waitCli('auto', started, portTimeout)
  if (code !== 0) {
    throw new Error('cli auto 以退出码 ' + code + ' 结束' + started.output())
  }
  if (!await waitPort(port, true, 30000)) {
    throw new Error('cli auto 已经结束，但自动化端口 ' + port + ' 没开' + started.output())
  }
}

// 工具 2.02.x 刚打开项目时 Tool.getInfo 只回 { version }，要过一会儿才带上 SDKVersion。
// automator 的 checkVersion 直接拿 SDKVersion 去 split，就在 undefined 上崩掉。
// 这里等它出现再做原本的版本校验；一直等不到就跳过校验，不让脚手架卡死在这一步。
function patchCheckVersion() {
  let MiniProgram
  try {
    MiniProgram = require('miniprogram-automator/out/MiniProgram').default
  } catch (error) {
    return false
  }
  const original = MiniProgram.prototype.checkVersion
  MiniProgram.prototype.checkVersion = async function () {
    // automator 的 connect() = 先建连接（Connection.create 已经把 ws 连上了）再
    // checkVersion()。checkVersion 一抛错或一卡住，那条连接就没人再碰——Launcher 不会
    // dispose 它，调用方也拿不到实例。connectMiniProgram 是重试的，于是每失败一次就漏
    // 一个连到自动化端口的 socket，谁也别想让进程退出。这个 patch 是唯一能拿到那个实例
    // 的地方（this 就是它），登记下来，收尾时统一断开。
    openMiniPrograms.add(this)
    for (let i = 0; i < 30; i++) {
      let info = null
      try {
        // 工具偶尔会收下命令却永远不回；automator 的 send 没有超时，得自己兜一层。
        info = await Promise.race([
          this.send('Tool.getInfo'),
          sleep(5000).then(function () { throw new Error('Tool.getInfo 超时') })
        ])
      } catch (error) {
        info = null
      }
      if (info && info.SDKVersion) {
        // 原版校验会再发一次 Tool.getInfo，而 Connection.send 没有超时：工具答过一次
        // 之后不再答话，这里就是最后一处能永久卡住的地方，所以也掐表。
        return await withTimeout(original.call(this), stepTimeout, '基础库版本校验')
      }
      await sleep(1000)
    }
    step('Tool.getInfo 一直没带 SDKVersion，跳过基础库版本校验')
  }
  return true
}

async function connectMiniProgram(port, timeout) {
  const wsEndpoint = 'ws://127.0.0.1:' + port
  const deadline = Date.now() + timeout
  let lastError = null
  for (;;) {
    try {
      // 单次尝试也要掐表：connect 里等的是工具回话，卡住就是永远卡住，
      // 而 deadline 只在被拒之后才检查，罩不住「一次都没返回」。
      return await withTimeout(automator.connect({ wsEndpoint: wsEndpoint }),
        connectAttemptTimeout, '连接 ' + wsEndpoint)
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) break
      await sleep(1000)
    }
  }
  throw lastError
}

// automator 的 page.waitFor 走 licia/waitUntil，而且没传超时（timeout=0 = 无限轮询）。
// 选择器一旦过期，整个测试就静默挂死而不是报错——送货单弹层被抽成自定义组件之后，
// 这里真的挂了二十多分钟才被发现。所以所有等待都套一层超时，并把等的是什么报出来。
function withTimeout(promise, timeout, label) {
  let timer = null
  const guard = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      const spent = timeout >= 1000 ? Math.round(timeout / 1000) + ' 秒' : timeout + ' 毫秒'
      reject(new Error('等「' + label + '」超时（' + spent + '）'))
    }, timeout)
  })
  return Promise.race([promise, guard]).finally(function () {
    clearTimeout(timer)
  })
}

// 只用来等条件和等选择器；纯 sleep（page.waitFor(800)）不必套。
async function waitFor(page, target, label) {
  await withTimeout(page.waitFor(target), stepTimeout, label)
}

async function tap(page, selector) {
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到可点击元素: ' + selector)
  }
  await el.tap()
}

// automator 原生的 page.waitFor 没有超时：选择器一过期就静默挂死、不报错，
// 整轮 UI 测试卡在那里。**本文件新增的等待一律走这三个带超时的封装**，
// 挂了能报出等的是哪个元素 / 哪个数据条件，而不是无限等。
const WAIT_TIMEOUT = Number(process.env.WECHAT_UI_WAIT_TIMEOUT || 15000)

// waitFor 不在这里重复定义：上面那份（委托 automator 原生 page.waitFor 再套
// withTimeout）契约更宽 —— target 可以是选择器、毫秒数或条件函数，而本文件里
// 大量调用点传的正是**条件函数**。曾经在这里另写过一份只吃选择器的 waitFor，
// 函数声明提升会让后面这份静默盖掉前面那份，于是 page.$$(函数) 把函数序列化成
// 空选择器，报 querySelectorAll 'The provided selector is empty'，整轮跑不动。
// 下面两个是原生没有的能力，才留在这里。

async function waitForGone(page, target, label) {
  const deadline = Date.now() + WAIT_TIMEOUT
  for (;;) {
    const list = await page.$$(target)
    if (list.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error('等元素消失超时（' + (label || target) + '，选择器 ' + target + '，' + WAIT_TIMEOUT + 'ms）')
    }
    await sleep(300)
  }
}

async function waitForData(page, predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT
  for (;;) {
    const data = await page.data()
    if (predicate(data)) return data
    if (Date.now() >= deadline) {
      throw new Error('等待页面数据超时（' + label + '，' + WAIT_TIMEOUT + 'ms）')
    }
    await sleep(300)
  }
}

async function tapWhen(page, selector) {
  await waitFor(page, selector, '出现 ' + selector)
  await tap(page, selector)
}

async function waitGone(page, selector) {
  await waitFor(page, async function () {
    const list = await page.$$(selector)
    return list.length === 0
  }, '消失 ' + selector)
}

// 送货单弹层的 wxml 在自定义组件 components/slip-overlay 里，组件还开了 virtualHost，
// 于是页面侧压根没有它的宿主节点：page.$$('.js-slip')、'slip-overlay >>> .js-slip'、
// 页面 selectComponent('slip-overlay') 实测全是 0。所以这里不查 DOM，改核对页面数据里
// 的 slip —— 组件模板就是逐字段渲染这个对象的。
// 代价：绑定写错（数据对、屏幕上不显示）这版用例查不出来，那种要靠截图看。
async function waitSlipOpen(page, label) {
  await waitFor(page, async function () {
    const data = await page.data()
    return !!(data && data.showSlip && data.slip)
  }, label + '弹出')
}

async function closeSlip(page, label) {
  await page.callMethod('closeSlip')
  await waitFor(page, async function () {
    const data = await page.data()
    return data && data.showSlip === false
  }, label + '关闭')
}

function assertSlip(slip, label) {
  assert.ok(slip, label + '没有数据')
  assert.ok(slip.lines && slip.lines.length > 0, label + '没有商品明细')
  assert.ok(slip.lines[0].productName.length > 0, label + '没有商品名')
  assert.ok(slip.customerName && slip.customerName.length > 0, label + '没有收货人')
  assert.ok(slip.shopName.indexOf('测试店') >= 0, label + '没有店名: ' + slip.shopName)
  assert.ok(slip.operatorText.indexOf('测试店主') >= 0, label + '没有经手人: ' + slip.operatorText)
  assert.ok(slip.operatorText.indexOf('ui-test-openid') < 0, label + '不应印 openid: ' + slip.operatorText)
}

async function resetStorage(miniProgram) {
  // 注入内存账本：同一套 inventory.js，不连真实云。
  await miniProgram.evaluate(function () {
    wx.setStorageSync('inv_test_memory_ledger', true)
    wx.setStorageSync('inv_shop_id', 'ui-test-shop')
    wx.setStorageSync('inv_shop_name', '测试店')
    wx.setStorageSync('inv_products', [])
    wx.setStorageSync('inv_records', [])
    wx.setStorageSync('inv_customers', [])
    wx.setStorageSync('inv_skus', [])
    wx.setStorageSync('inv_categories', [])
    wx.setStorageSync('inv_revision', 0)
    wx.setStorageSync('inv_local_snapshot_done', true)
  })
}

async function waitPageReady(page) {
  await waitFor(page, async function () {
    const data = await page.data()
    return data && data.pageLoading === false
  }, '页面加载完成 ' + page.path)
}

// 工具 2.02.x 上，站在 navigateTo 进来的二级页调用 reLaunch，automator 会等满 10 秒报
// 「timeout waiting for automator response」，而且页面压根没跳（在 customer-edit 上必现）。
// 退回栈底的 tab 页再 reLaunch 就正常。所以每次 reLaunch 之前先把栈清干净。
async function backToTabRoot(miniProgram) {
  for (let i = 0; i < 5; i++) {
    const stack = await miniProgram.pageStack()
    if (stack.length <= 1) return
    await miniProgram.navigateBack()
  }
  throw new Error('退不回 tab 页，页面栈太深')
}

async function seedFromHome(miniProgram) {
  step('清空本地数据并点「填充示例数据」')
  await resetStorage(miniProgram)
  await backToTabRoot(miniProgram)
  const home = await miniProgram.reLaunch('/pages/index/index')
  await waitPageReady(home)
  await waitFor(home, '.js-seed', '出现 .js-seed')
  await tap(home, '.js-seed')
  await waitFor(home, async function () {
    const data = await home.data()
    return data && data.isEmpty === false
  }, '示例数据填充完成')
  return home
}

async function runSalePickerAndSlip(miniProgram) {
  step('销售：点选商品、客户，一分未收出库，核对送货单')
  const sale = await miniProgram.switchTab('/pages/sale/sale')
  await waitPageReady(sale)
  await waitFor(sale, '.js-product-picker', '出现 .js-product-picker')

  await tap(sale, '.js-product-picker')
  await waitFor(sale, '.js-product-item', '出现 .js-product-item')
  const products = await sale.$$('.js-product-item')
  assert.ok(products.length > 0, '商品点选列表为空')
  await products[0].tap()
  await waitGone(sale, '.js-product-item')

  await tapWhen(sale, '.js-customer-picker')
  await waitFor(sale, '.js-customer-item', '出现 .js-customer-item')
  const customers = await sale.$$('.js-customer-item')
  assert.ok(customers.length > 0, '客户点选列表为空')
  await customers[0].tap()
  await waitGone(sale, '.js-customer-item')

  const qty = await sale.$('.js-qty')
  if (!qty) {
    throw new Error('找不到数量输入框')
  }
  await qty.input('1')
  await tapWhen(sale, '.js-add-cart')
  await waitFor(sale, async function () {
    const data = await sale.data()
    return data && data.cart && data.cart.length > 0
  }, '商品进购物车')

  // 默认实收等于应收，本单不欠钱
  const fullPaid = await sale.data()
  assert.strictEqual(fullPaid.paidAmount, fullPaid.amountText)
  assert.strictEqual(fullPaid.hasNewDebt, false)

  // 点「一分未收」：欠款等于整单应收
  await tapWhen(sale, '.js-paid-none')
  await sale.waitFor(200)
  const nonePaid = await sale.data()
  assert.strictEqual(nonePaid.paidAmount, '0')
  assert.strictEqual(nonePaid.hasNewDebt, true)
  assert.strictEqual(nonePaid.debtText, nonePaid.amountText)

  await tapWhen(sale, '.js-sale-submit')
  await waitSlipOpen(sale, '送货单')
  const slip = (await sale.data()).slip
  assertSlip(slip, '送货单')
  assert.strictEqual(slip.paidText, '0.00', '送货单实收不对: ' + slip.paidText)
  await closeSlip(sale, '送货单')
}

async function runRecordSlipExport(miniProgram) {
  step('流水：打开销售记录，默认只读，再次打开送货单')
  const records = await miniProgram.navigateTo('/pages/records/records')
  await waitFor(records, '.js-record-out', '出现 .js-record-out')
  const items = await records.$$('.js-record-out')
  assert.ok(items.length > 0, '流水里没有销售记录')
  await items[0].tap()

  await records.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('record-edit') >= 0, '未进入流水详情: ' + edit.path)
  await waitFor(edit, '.js-edit', '出现 .js-edit')
  let pageData = await edit.data()
  assert.strictEqual(pageData.editing, false, '进入详情就进入了修改')
  const saveBefore = await edit.$$('.js-save')
  assert.strictEqual(saveBefore.length, 0, '未点修改就出现了保存')
  await waitFor(edit, '.js-export-slip', '出现 .js-export-slip')
  await tap(edit, '.js-export-slip')
  await waitSlipOpen(edit, '再次导出的送货单')
  assertSlip((await edit.data()).slip, '再次导出的送货单')
  await closeSlip(edit, '再次导出的送货单')

  step('流水：点修改后才能保存，取消回到详情')
  await tap(edit, '.js-edit')
  await waitFor(edit, '.js-save', '出现 .js-save')
  pageData = await edit.data()
  assert.strictEqual(pageData.editing, true, '点修改后仍不能改')
  await tap(edit, '.js-cancel')
  await waitFor(edit, '.js-edit', '出现 .js-edit')
  pageData = await edit.data()
  assert.strictEqual(pageData.editing, false, '取消后没有回到详情')
  await miniProgram.navigateBack()
}

async function runOpeningSheet(miniProgram) {
  step('客户页：记期初欠款，弹出层并确认')
  const list = await miniProgram.switchTab('/pages/customers/customers')
  await waitFor(list, '.js-customer-item', '出现 .js-customer-item')
  await tap(list, '.js-customer-item')

  await list.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('customer-edit') >= 0, '未进入客户编辑页: ' + edit.path)
  await waitFor(edit, '.js-opening', '出现 .js-opening')
  await tapWhen(edit, '.js-opening')
  await waitFor(edit, '.js-opening-sheet', '出现 .js-opening-sheet')
  const amount = await edit.$('.js-opening-amount')
  if (!amount) {
    throw new Error('找不到期初欠款金额输入框')
  }
  await amount.input('20')
  await tapWhen(edit, '.js-opening-submit')
  await waitGone(edit, '.js-opening-sheet')
  await miniProgram.navigateBack()
}

async function runPaySheet(miniProgram) {
  step('客户页：点收款，弹出收款层并确认')
  const list = await miniProgram.switchTab('/pages/customers/customers')
  await waitPageReady(list)
  await waitFor(list, '.js-collect', '出现 .js-collect')
  await tap(list, '.js-collect')

  await list.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('customer-edit') >= 0, '未进入客户编辑页: ' + edit.path)
  await waitFor(edit, '.js-pay-sheet', '出现 .js-pay-sheet')
  await tapWhen(edit, '.js-pay-submit')
  await waitGone(edit, '.js-pay-sheet')
}

// 造超过一页（> 20 条）的收款流水，写进内存模式的流水仓（inv_record_docs）。
// 文档形状和 toRecordDoc 一致（_id = bookId_id、sortKey = pad13(createdAt)_id），
// bookId 取当前账套号，不然 memoryRecordStore 的 rows() 按 bookId 过滤看不见。
// tag 用来给两批注水错开 id / _id（存储里不去重，撞了 _id 列表里就是两条）。
async function seedExtraPayDocs(miniProgram, count, customerId, tag) {
  await miniProgram.evaluate(function (count, customerId, tag) {
    const bookId = wx.getStorageSync('inv_book_id') || wx.getStorageSync('inv_shop_id') || 'ui-test-shop'
    const existing = wx.getStorageSync('inv_record_docs') || []
    const docs = []
    for (let i = 0; i < count; i++) {
      const id = 'ui-' + tag + '-' + String(i)
      let pad = String(1700000000000 + i * 60000)
      while (pad.length < 13) pad = '0' + pad
      docs.push({
        id: id, type: 'pay', amount: 10, profit: 0, remark: '',
        createdAt: 1700000000000 + i * 60000,
        customerId: customerId || '',
        _id: bookId + '_' + id,
        bookId: bookId,
        shopId: 'ui-test-shop',
        sortKey: pad + '_' + id
      })
    }
    wx.setStorageSync('inv_record_docs', existing.concat(docs))
  }, count, customerId || '', tag || 'more')
}

async function countMemoryDocs(miniProgram) {
  return await miniProgram.evaluate(function () {
    const bookId = wx.getStorageSync('inv_book_id') || wx.getStorageSync('inv_shop_id') || 'ui-test-shop'
    return ((wx.getStorageSync('inv_record_docs') || []).filter(function (doc) {
      return String(doc.bookId || '') === String(bookId)
    })).length
  })
}

// 触底加载的分层验证（docs/cloud-ledger.md 的 V4 兜底就是为「onReachBottom
// 不触发」准备的）。这里能验到哪一层就如实记哪一层：
//   第一层：真实滚动 —— wx.pageScrollTo 把页面滚到底，看列表有没有自己长出第二页。
//           这是「小程序会调 onReachBottom」的实证；scrollTop 前后对比证明滚动
//           真的发生了，避免「没滚所以没触发」的假阴性。
//   第二层：手动「加载更多」按钮 —— 触底不触发时的兜底出路，必须真的能用。
// page.callMethod('onReachBottom') 只能证明方法本身好使，证明不了小程序会调它，
// 所以不拿它冒充触底验证；只在滚动没验到时用它确认方法接线没断。
let bottomReachedByScroll = null

async function runRecordsLoadMore(miniProgram) {
  step('流水页：超过一页时首屏只有一页，滚到底触发 onReachBottom，手动「加载更多」兜底')
  const TOTAL = 45
  await seedExtraPayDocs(miniProgram, TOTAL, '', 'rec')
  const expectedTotal = await countMemoryDocs(miniProgram)
  assert.ok(expectedTotal > 20, '前提：当前账套的流水超过一页（实为 ' + expectedTotal + ' 条）')

  await backToTabRoot(miniProgram)
  const records = await miniProgram.navigateTo('/pages/records/records')
  await waitForData(records, function (data) { return data.loaded }, '流水页首屏加载完成')
  const first = await records.data()
  assert.strictEqual(first.list.length, 20, '首屏只给一页 20 条，不多给')
  assert.strictEqual(first.hasMore, true, '还有下一页')
  await waitFor(records, '.js-load-more', '手动「加载更多」按钮（还有下一页时要出现）')
  await waitForGone(records, '.js-aggregates-stale', '聚合漂移提示条不应误报')

  // ---- 第一层：真实滚动 -------------------------------------------------
  // 滚了之后看列表会不会自己长出第二页。scrollTop 前后读一次是为了排除
  // 「压根没滚动所以没触发」的假阴性；读不到（前后都是 0）就只把结论记成
  // 「无法验证」，不冒充。
  const before = await records.scrollTop()
  await miniProgram.pageScrollTo(10000000)
  await sleep(800)
  let scrolled = null
  try {
    scrolled = await waitForData(records, function (data) {
      return data.list.length > 20
    }, '滚到底之后 onReachBottom 触发、第二页追加')
  } catch (error) {
    const after = await records.scrollTop()
    if (after > before) {
      bottomReachedByScroll = false
      step('页面滚下去了（scrollTop ' + before + ' -> ' + after + '）但 onReachBottom 没触发：'
        + '模拟器里触底不可靠，手动按钮就是为这个准备的兜底')
    } else {
      bottomReachedByScroll = null
      step('滚动没法确认（scrollTop ' + before + ' -> ' + after + '，可能读不到）：'
        + '模拟器里没验到真实触底，只验了方法本身（下一行）')
      await records.callMethod('onReachBottom')
      await waitForData(records, function (data) {
        return data.list.length > 20
      }, 'callMethod 直调 onReachBottom（只证明方法接线，不证明小程序会调它）')
    }
  }
  if (scrolled) {
    bottomReachedByScroll = true
    step('滚到底后 onReachBottom 触发了：列表 ' + scrolled.list.length + ' 条')
  }

  // ---- 第二层：手动按钮翻到头 -------------------------------------------
  let guard = 0
  for (;;) {
    const data = await records.data()
    if (!data.hasMore) break
    await tap(records, '.js-load-more')
    await waitForData(records, function (d) {
      return d.list.length > data.list.length
    }, '点「加载更多」之后第二页追加（上一次 ' + data.list.length + ' 条）')
    guard += 1
    if (guard > 10) throw new Error('点了 10 次还没翻完，不对劲')
  }
  const finalData = await records.data()
  assert.strictEqual(finalData.list.length, expectedTotal,
    '翻完正好全量 ' + expectedTotal + ' 条，不重不漏')
  const ids = {}
  finalData.list.forEach(function (item) {
    assert.ok(!ids[item.id], '列表里有重复：' + item.id)
    ids[item.id] = true
  })
  await waitForGone(records, '.js-load-more', '翻完之后「加载更多」按钮要消失')
  await miniProgram.navigateBack()
}

async function runCustomerLedgerLoadMore(miniProgram) {
  step('客户页：往来记录超过一页时手动「加载更多」兜底')
  const customerId = await miniProgram.evaluate(function () {
    const list = wx.getStorageSync('inv_customers') || []
    return list.length ? list[0].id : ''
  })
  assert.ok(customerId, '前提：示例数据里有客户')
  await seedExtraPayDocs(miniProgram, 30, customerId, 'cust')
  const edit = await miniProgram.navigateTo('/pages/customer-edit/customer-edit?id=' + customerId)
  await waitForData(edit, function (data) { return data.ledger.length === 20 }, '往来记录首屏一页 20 条')
  await waitFor(edit, '.js-ledger-more', '往来记录的「加载更多」按钮')
  let guard = 0
  for (;;) {
    const data = await edit.data()
    if (!data.ledgerHasMore) break
    await tap(edit, '.js-ledger-more')
    await waitForData(edit, function (d) {
      return d.ledger.length > data.ledger.length
    }, '客户往来点「加载更多」之后下一页追加（上一次 ' + data.ledger.length + ' 条）')
    guard += 1
    if (guard > 10) throw new Error('点了 10 次还没翻完，不对劲')
  }
  const after = await edit.data()
  assert.ok(after.ledger.length > 20, '翻完超过一页（实为 ' + after.ledger.length + ' 条）')
  const seen = {}
  after.ledger.forEach(function (item) {
    assert.ok(!seen[item.id], '往来记录里有重复：' + item.id)
    seen[item.id] = true
  })
  await waitForGone(edit, '.js-ledger-more', '翻完之后按钮要消失')
  await miniProgram.navigateBack()
}

async function runNativeClearModal(miniProgram) {
  step('店铺页：点清空（原生弹窗用 mock 自动确认）')
  // 上一步停在 customer-edit，直接 reLaunch 会超时，见 backToTabRoot。
  await backToTabRoot(miniProgram)
  const home = await miniProgram.reLaunch('/pages/index/index')
  await waitPageReady(home)
  await waitFor(home, '.js-shop', '出现 .js-shop')
  await tap(home, '.js-shop')
  await home.waitFor(800)
  const shop = await miniProgram.currentPage()
  assert.ok(shop.path.indexOf('shop') >= 0, '未进入店铺页: ' + shop.path)
  await waitPageReady(shop)
  await waitFor(shop, '.js-clear', '出现 .js-clear')
  await tap(shop, '.js-clear')
  await waitFor(shop, async function () {
    const data = await shop.data()
    return data && data.isEmpty === true
  }, '店铺数据清空')
  await miniProgram.navigateBack()
  const backHome = await miniProgram.currentPage()
  await waitPageReady(backHome)
  await waitFor(backHome, '.js-seed', '出现 .js-seed')
}

async function run() {
  const cliPath = resolveCliPath()
  if (!cliPath) {
    throw new Error('找不到微信开发者工具的 cli，把环境变量 WECHAT_CLI 设成 cli.bat 的完整路径')
  }

  activeCliPath = cliPath

  const autoPort = fixedPort || basePort
  await ensurePortFree(cliPath, autoPort)
  step('用 CLI 打开本仓库并开自动化端口 ' + autoPort + '：' + cliPath)
  // 在 startAutoPort 之前就记上：它抛错时工具窗口可能已经开出来了，收尾一样得去关。
  toolOpened = true
  await startAutoPort(cliPath, autoPort)

  patchCheckVersion()
  step('连接 ws://127.0.0.1:' + autoPort)
  const miniProgram = await connectMiniProgram(autoPort, connectTimeout)
  activeMiniProgram = miniProgram
  openMiniPrograms.add(miniProgram)
  // 收尾统一交给 finish()：关工具、断连接、退进程要在每条退出路径上都发生，
  // 而不只是在 run() 自己能走到的 finally 里。
  await miniProgram.mockWxMethod('showToast', {})
  await miniProgram.mockWxMethod('showModal', {
    confirm: true,
    cancel: false
  })
  // 单步超时兜不住的情形（工具收下命令再也不回、automator 的 send 本身没有超时）
  // 再套一层整轮看门狗，保证任何情况下都会结束并把工具关掉。
  // 新增的两个「加载更多」步骤也必须在看门狗里 —— 它们要滚页面、等列表增长，
  // 恰好是最容易卡住不回的那一类。
  await withTimeout((async function () {
    await seedFromHome(miniProgram)
    await runSalePickerAndSlip(miniProgram)
    await runRecordSlipExport(miniProgram)
    await runOpeningSheet(miniProgram)
    await runPaySheet(miniProgram)
    await runRecordsLoadMore(miniProgram)
    await runCustomerLedgerLoadMore(miniProgram)
    await runNativeClearModal(miniProgram)
  })(), runTimeout, '整轮 UI 用例')
  // 触底加载验到了哪一层，最后一行说清楚，别让人翻日志猜。
  // 放在看门狗之外：它是报告不是用例，超时的时候本来也走不到这里。
  if (bottomReachedByScroll === true) {
    step('触底加载结论：模拟器里 wx.pageScrollTo 滚到底后 onReachBottom 真的触发了')
  } else if (bottomReachedByScroll === false) {
    step('触底加载结论：滚动真的发生了但 onReachBottom 没触发 —— 手动「加载更多」是必要的兜底，真机还要再验')
  } else {
    step('触底加载结论：模拟器里没验到真实触底（滚动无法确认），只验了 onReachBottom 方法本身和手动按钮')
  }
  console.log('ui tests passed')
}

// 收尾：关掉这次自己开的工具窗口，断开所有自动化连接，收掉还没退的 cli 子进程。
// 关不掉不该盖掉测试本身的结论，所以每一步的异常都吞掉、只记一行。
//
// 每一步都是被实测坑过才写的（2026-08-24 三次复现）：
//   * automator 的 close() 是 send('App.exit') → sleep → send('Tool.close') → disconnect()，
//     而 Connection.send 没有超时。工具卡住不回话时 close() 既不 resolve 也不 reject，
//     以前放在 run() 的 finally 里就永远停在那儿：进程不退，到自动化端口的 WebSocket
//     一直 ESTABLISHED。下一轮 test:all 于是撞上「端口上已经有别的自动化会话」，两个
//     自动化客户端抢同一个端口，在随机步骤报 Connection closed —— 每失败一次多留一个
//     僵尸，重试越来越容易失败，一次偶发失败被放大成看起来像回归的连环失败。
//     所以 close() 必须掐表。
//   * Tool.close 一抛错，automator 就不会再走到它自己的 disconnect()，连接照样留着。
//     所以无论 close 成功与否，这里都补一次断开——而且是对所有登记过的实例，
//     connect 重试期间漏下的那些也在里面。
async function teardown() {
  const miniProgram = activeMiniProgram
  activeMiniProgram = null
  let closed = false
  if (miniProgram) {
    try {
      await withTimeout(miniProgram.close(), closeTimeout, '关闭开发者工具')
      closed = true
    } catch (error) {
      step('关闭开发者工具失败，可以手动关：' + errText(error))
    }
  }
  openMiniPrograms.forEach(function (item) {
    // close() 成功时它已经断过一次，ws.close() 是幂等的，再断一次没有副作用。
    try {
      item.disconnect()
    } catch (error) {
      step('断开自动化连接失败：' + errText(error))
    }
  })
  openMiniPrograms.clear()
  // 工具窗口没关成 => 它还开着，而且多半已经卡死，整棵进程树会一直留到下次
  // ensurePortFree 才被收掉。用工具自己的 cli quit 兜一下，别让它按次累积。
  // 不按镜像名杀进程：WeChatAppEx 微信本体也在用，误伤代价太大。
  if (toolOpened && !closed && activeCliPath) {
    step('工具没关干净，用 cli quit 兜底')
    const started = runCli(activeCliPath, ['quit'])
    try {
      await waitCli('quit', started, closeTimeout)
    } catch (error) {
      step('cli quit 也没收干净，手动关掉开发者工具：' + errText(error))
    }
    stopCli(started)
  }
  liveCli.forEach(stopCli)
  liveCli.clear()
}

// 兜底看门狗：收尾之后进程本该自己退，退不掉就硬退。
// 用 unref 的定时器而不是无条件 process.exit()，是因为 unref 的定时器不会拖住事件循环
// ——事件循环干净时 node 照常立刻退出，它压根不开火；只有还有东西攥着循环（没断干净的
// WebSocket、没收的子进程管道）时才轮到它。这样上面的日志能先写完再退。
function forceExitAfter(ms, code, why) {
  const timer = setTimeout(function () {
    // 把「还占着事件循环的是什么」一起报出来：下次再遇到退不掉，不用从头查一遍
    const held = process.getActiveResourcesInfo
      ? process.getActiveResourcesInfo().join('、')
      : '这个 Node 版本报不出来'
    console.error('[UI] ' + why + '，强制退出（exit ' + code + '；还占着：' + held + '）')
    process.exit(code)
  }, ms)
  if (timer.unref) timer.unref()
  return timer
}

// 所有退出路径的唯一出口：断言失败、超时、连接断开、未捕获异常，最后都汇到这里。
let finishing = false

async function finish(code, tail) {
  if (finishing) return
  finishing = true
  // 收尾自己也会卡（工具没死透时 close 和 cli quit 都可能各等满一个 closeTimeout），
  // 先架一道硬看门狗，保证连收尾卡住都能退。
  forceExitAfter(closeTimeout * 2 + exitGrace * 2, code, '收尾流程本身没能在预期时间内结束')
  try {
    await teardown()
  } catch (error) {
    // 收尾里再冒出别的错也不能挡住退出，否则又回到「进程留在那儿」的老问题。
    step('收尾时还出了别的错，忽略：' + errText(error))
  }
  if (tail) tail()
  process.exitCode = code
  forceExitAfter(exitGrace, code, '收尾跑完了、事件循环还被别的东西占着')
}

function onFatal(error) {
  if (finishing) {
    // 整轮超时之后被丢下的那条链路还在跑，它后面报的错不改变结论，别盖掉真正的原因。
    step('收尾期间还有异步错误，忽略：' + errText(error))
    return
  }
  console.error('[UI] 未捕获的异常 / 未处理的 Promise 拒绝：')
  console.error(error && error.stack ? error.stack : error)
  finish(1, printChecklist)
}

function printChecklist() {
  console.error('')
  console.error('UI 测试跑不起来时，按这个清单查：')
  console.error('1. 已安装 Node.js，并在仓库根目录执行过 npm install')
  console.error('2. 本脚本不用 automator.launch()：Node 18.20.2 / 20.12.2 起禁止直接 spawn')
  console.error('   .bat，而 launch() 就是不带 shell 地 spawn cli.bat，必然 EINVAL，')
  console.error('   还会被转述成误导性的「cliPath 不对」。这里改成自己经 cmd.exe 起端口再 connect')
  console.error('3. 默认会找 C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat')
  console.error('   若安装位置不同，设置环境变量 WECHAT_CLI 为 cli.bat 的完整路径')
  console.error('4. 工具要允许被 CLI 驱动：设置 → 安全设置 → 服务端口。上面若打印了 CLI 输出，以它为准')
  console.error('5. 若看到成片的「Maximum setlocal recursion level reached」，是 cli.bat 切 UTF-8 代码页后')
  console.error('   被 cmd 误解析、把注释里的 CLI 当命令又调回自己。脚本已把安装目录从子进程 PATH 摘掉')
  console.error('6. 端口和超时可用 WECHAT_AUTOMATOR_PORT / _PORT_TIMEOUT / _CONNECT_TIMEOUT /')
  console.error('   _STEP_TIMEOUT（单步，默认 30 秒）/ _RUN_TIMEOUT（整轮，默认 15 分钟）/')
  console.error('   _CLOSE_TIMEOUT（收尾关工具，默认 20 秒）/ _SCRIPT_TIMEOUT（整个脚本，默认 25 分钟）覆盖')
  console.error('7. 工具刚打开项目时 Tool.getInfo 不带 SDKVersion，automator 的版本校验会崩，')
  console.error('   脚本里已经等它出现再校验')
  console.error('8. wx.showModal 是系统弹窗，自动化点不到内部按钮，脚本里用 mockWxMethod 自动确认')
  console.error('9. 送货单弹层在 virtualHost 自定义组件里，页面级选择器够不着（page.$$ / >>> /')
  console.error('   selectComponent 实测都是 0），用例核对的是页面数据里的 slip，别再写回 .js-slip')
  console.error('10. 重试之前先确认没有上一轮的残留。脚本收尾会断开连接、必要时 cli quit，但工具')
  console.error('    卡死时这两步都可能不管用，而残留会直接毁掉下一轮：留下的开发者工具占着自动化')
  console.error('    端口，新一轮连上的是上一轮的会话，于是在随机步骤报 Connection closed。查和清：')
  console.error('    Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |')
  console.error('      Where-Object { $_.CommandLine -like \'*ui.test.js*\' }   # 有就 Stop-Process')
  console.error('    Get-Process 微信开发者工具                                  # 有就手动关掉工具')
  console.error('    脚本不按镜像名杀进程：WeChatAppEx 是微信本体也在用的，误伤代价太大')
}

process.on('uncaughtException', onFatal)
process.on('unhandledRejection', onFatal)

// 最外层再罩一道超时：runTimeout 只罩着用例本身，起端口、连接这些前置步骤卡住时
// 它还没起跑，得有人保证无论如何都会走到 finish()。
withTimeout(run(), scriptTimeout, '整个 UI 测试脚本').then(function () {
  return finish(0)
}, function (error) {
  console.error(error && error.stack ? error.stack : error)
  return finish(1, printChecklist)
})
