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

// 只用来等条件和等选择器；纯 sleep（page.waitFor 传毫秒数）不必套。
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

// 判据是 data.pageLoading === false。index / customers / shop / sale 这些页有这个字段，
// **record-edit / customer-edit / records 没有** —— 对它们调用会一路等到 stepTimeout，
// 然后报一句「等「页面加载完成 pages/customer-edit/customer-edit」超时（30 秒）」：
// undefined === false 恒为 false，所以那不是「页面没加载完」，是这个判据对那些页压根不适用。
// 这句误导性的报错跟真实原因（走错页了 / 上一步没退回去）毫无关系，排查时被它带偏过一次。
// 所以这里先探一次：没有这个字段就直说是用错了地方，别死等 30 秒再报个假原因。
// 哪些页有这个字段由 tests/automator-contract.test.js 钉着，页面侧一改就会红。
async function waitPageReady(page) {
  const first = await page.data()
  if (!first || !Object.prototype.hasOwnProperty.call(first, 'pageLoading')) {
    throw new Error('waitPageReady 用错了地方：' + page.path + ' 的 data 里没有 pageLoading 字段，'
      + '等不到。多半是上一步没走到预期的页面。当前 data 的字段：'
      + Object.keys(first || {}).slice(0, 12).join(','))
  }
  if (first.pageLoading === false) return
  await waitFor(page, async function () {
    const data = await page.data()
    return data && data.pageLoading === false
  }, '页面加载完成 ' + page.path)
}

// ---------------------------------------------------------------------------
// 「现在到底在哪一页」一律走原始 RPC，不看 Page 对象的 path。
//
// automator 的 Page.create 有一层 pageMap 缓存（out/Page.js）：
//     static create(t,e,a){if(a.get(e.id))return a.get(e.id);const i=new Page(t,e);return a.set(e.id,i),i}
// 命中 pageId 就返回旧对象，而 Page.path 是**构造那一刻的快照、之后永不更新**
// （构造函数里只有 this.path=e.path 一次赋值）。pageMap 挂在 MiniProgram 实例上，
// 整轮测试期间从不清理。小程序的 pageId 在页面销毁后会被复用，一旦复用，
// currentPage() / pageStack() 就可能返回一个 path 还停在上一个页面的 Page 对象。
//
// MiniProgram.send(method, params) 是直通 connection.send 的（out/MiniProgram.js:
// `async send(t,e={}){return await this.connection.send(t,e)}`），拿到的是未经这层
// 缓存污染的原始数据。currentPage() / pageStack() 自己用的也正是这两个 RPC。
// ---------------------------------------------------------------------------
async function rawCurrentPage(miniProgram) {
  return await miniProgram.send('App.getCurrentPage')      // { pageId, path, query }
}

async function rawPageStack(miniProgram) {
  const res = await miniProgram.send('App.getPageStack')
  return (res && res.pageStack) || []                      // [{ pageId, path, query }]
}

function describeStack(stack) {
  return '[' + stack.map(function (p) { return p.path + '#' + p.pageId }).join(' > ') + ']'
}

// 绕过 automator 的页面栈视图，直接问小程序 runtime 自己：getCurrentPages() 的 route 列表。
//
// 为什么需要第二条路：上面 rawPageStack 走的是 App.getPageStack，而 automator 这一侧
// 已知有缓存问题（见 pageMap 那段）。光看 App.getPageStack 说「栈没变」，分不清是
//   R1：wx.navigateBack 在 runtime 里真的没生效（栈实际没动）
//   R2：runtime 里栈动了，但 automator 的视图陈旧、没跟上
// evaluate 走的是 App.callFunction（out/MiniProgram.js: evaluate -> send('App.callFunction')），
// 和 App.getPageStack 是两条不同的 RPC 路径。两个栈并排打出来就能定性。
//
// 套 withTimeout：runtime 卡住时 automator 的 send 自己没有超时，这里要报「取不到」
// 而不是把整轮拖死 —— 而且「取不到」本身就是一条现场证据。
async function runtimeStack(miniProgram) {
  return await withTimeout(miniProgram.evaluate(function () {
    return getCurrentPages().map(function (p) { return p.route })
  }), 10000, 'runtime getCurrentPages()')
}

// 出错路径上的取证：除了 automator 侧的页面栈，再拿一次 runtime 侧的 getCurrentPages()。
// 两个数字并排才判得出路由指令到底生没生效 —— 这是排查这类失败的第一个岔路口：
//   runtime 侧变了、automator 侧没变 = automator 的页面栈视图陈旧（R2）
//   两边都没变                       = wx 路由在 runtime 层面就没生效（R1）
// 这不是探针，是错误信息的一部分。runNativeClearModal 结尾那处退栈失败是偶发的，
// 而且**据用户实测，同一步在 main 基线上也红过**（症状同样是 timeout waiting for
// automator response）—— 注意这条依据来自用户的实测，不是本轮验证跑出来的：本轮的
// main 基线那一轮死在更早的 runCustomerLedgerLoadMore，压根没跑到这个函数。
// 既然它还会再犯，下一个人撞上时应当一眼看出是 R1 还是 R2，不必像这次一样从头查一遍。
// **取证本身不许抛异常盖掉原始错误**，所以整段 try/catch（runtimeStack 内部已带超时）。
async function runtimeStackForError(miniProgram) {
  try {
    const routes = await runtimeStack(miniProgram)
    return 'runtime栈(' + routes.length + ')=[' + routes.join(' > ') + ']'
  } catch (error) {
    return 'runtime栈=<取证失败: ' + (error && error.message ? error.message : error) + '>'
  }
}

// 出问题时把现场打全：automator 眼里的栈 + runtime 自己的栈 + Page 对象以为的 path。
// 默认关掉（每次三四个额外 RPC，噪音大），要查路由问题时 WECHAT_UI_TRACE=1 打开。
const traceOn = process.env.WECHAT_UI_TRACE === '1'

// 纯日志断点，不发任何 RPC —— 工具卡住时它一定打得出来，用来定位「是哪一条命令把工具卡住的」。
// 卡住的那条命令的「之前」会打出来、「之后」不会，夹逼即可。
function mark(tag) {
  if (!traceOn) return
  console.log('[UI:mark] ' + tag)
}

async function trace(miniProgram, tag) {
  if (!traceOn) return
  let autoPart = ''
  let rtPart = ''
  try {
    // 这两个 RPC 也要套超时：automator 的 send 自己没有超时，工具卡住时
    // trace 会连着一起挂死，那就既没有现场、也不知道卡在哪。
    const cur = await withTimeout(rawCurrentPage(miniProgram), 10000, 'App.getCurrentPage')
    const stack = await withTimeout(rawPageStack(miniProgram), 10000, 'App.getPageStack')
    autoPart = 'cur=' + cur.path + '#' + cur.pageId + ' automator栈(' + stack.length + ')=' + describeStack(stack)
  } catch (error) {
    autoPart = 'automator栈=<取不到: ' + (error && error.message ? error.message : error) + '>'
  }
  try {
    const routes = await runtimeStack(miniProgram)
    rtPart = ' runtime栈(' + routes.length + ')=[' + routes.join(' > ') + ']'
  } catch (error) {
    rtPart = ' runtime栈=<取不到: ' + (error && error.message ? error.message : error) + '>'
  }
  // trace 只是观测，坏了不许把用例带崩
  console.log('[UI:trace] ' + tag + ' ' + autoPart + rtPart)
}

// 从跳转用的 url 推出 App.getCurrentPage 会报的 path 形式：去掉 query、去掉前导斜杠。
// 实测（WECHAT_UI_TRACE=1 的 trace 输出）path 就是 'pages/record-edit/record-edit' 这种，
// 无前导斜杠、query 是独立字段。
function pathOf(url) {
  return String(url || '').split('?')[0].replace(/^\//, '')
}

// 轮询体里的单次 RPC 也必须有超时。
//
// automator 的 Connection.send **没有任何超时**（out/Connection.js：生成 uuid、塞进
// callbacks Map、等对面回，回不来就永远挂着）。所以只要某一次 RPC 永不返回，下面轮询里
// 那句 `if (Date.now() >= deadline)` 根本走不到 —— stepTimeout 形同虚设，只能等 15 分钟的
// 整轮看门狗兜底，而且那条报错不指位置。本轮要消灭的就是这类「等待不可靠」，
// 所以热路径上一条都不能漏。
//
// 取不到就当「还没到」返回 null，继续轮询，直到 stepTimeout 走完再报那条带现场的详细错 ——
// 单次 RPC 抖一下不该直接掐掉整个等待。
async function pollCurrentPage(miniProgram) {
  try {
    return await withTimeout(rawCurrentPage(miniProgram), 10000, 'App.getCurrentPage')
  } catch (error) {
    return null
  }
}

async function pollPageStack(miniProgram) {
  try {
    return await withTimeout(rawPageStack(miniProgram), 10000, 'App.getPageStack')
  } catch (error) {
    return null
  }
}

// 出错路径上读页面栈：读不到就降级成一句话，**不许抛异常盖掉原始错误**（同 runtimeStackForError）。
async function pageStackForError(miniProgram) {
  const stack = await pollPageStack(miniProgram)
  return stack ? describeStack(stack) : '<取证失败: 读 automator 页面栈超时或出错>'
}

// 取「到位之后」的 Page 对象，并挡掉 pageMap 缓存返回陈旧对象的情况
//（缓存机制见上方 rawCurrentPage / rawPageStack 那段长注释；对应的源码断言在
// tests/automator-contract.test.js 里，那边编号为 F2）。
// 这两次 currentPage() 也套 withTimeout：Connection.send 没有任何超时（见上方
// pollCurrentPage 那段），不套就可能永久挂住。这里**不降级**成 null —— 取不到 Page 对象
// 就没法往下走，直接带标签抛出去比蒙着走好，报错也指得出是哪一步卡住。
//
// 【别写成「仅剩的无超时 RPC」】本文件还有若干 await miniProgram.X() 没套超时：
// 4 处 evaluate（resetStorage / seedExtraPayDocs / countMemoryDocs / 取 customerId）、
// pageScrollTo、run() 里两处 mockWxMethod。它们不在等待/判位置的热路径上，本轮按范围控制
// 没动，但它们同样会挂住。谁要补，照这里的写法套 withTimeout 即可。
async function freshCurrentPage(miniProgram, pageId, expectedPath, label) {
  let page = await withTimeout(miniProgram.currentPage(), 10000, '取当前页对象（' + label + '）')
  if (String(page.path || '') !== expectedPath) {
    console.log('[UI] pageMap 缓存返回了陈旧页面对象（id=' + pageId
      + '，对象说 ' + page.path + '，实为 ' + expectedPath + '），已重建')
    miniProgram.pageMap.delete(pageId)
    page = await withTimeout(miniProgram.currentPage(), 10000, '删缓存后重取当前页对象（' + label + '）')
  }
  assert.strictEqual(String(page.path || ''), expectedPath,
    '取到的页面对象仍然不是' + label + ': ' + page.path)
  return page
}

// 等页面到位。**判据是完整路径精确相等，不是子串包含。**
//
// 曾经用过子串匹配（waitForPage(mp, 'shop', ...)）。它当时能work纯属路径命名的偶然：
// 'record' 同时是 pages/records/records 和 pages/record-edit/record-edit 的子串，
// 'customers' 和 'customer-edit' 也只差一个字符。一旦拿它当通用包装器，
// 「静默确认到了错误的页面」就是迟早的事 —— 而这正是本轮要消灭的失败形态本身。
// 所以判据收紧成 ===，调用点一律传 pages/ 开头的完整路径（由文件末尾的钉子看着）。
//
// 路径判定走 rawCurrentPage，不走 currentPage() —— 后者会被 pageMap 缓存骗（见上方注释）。
async function waitForPage(miniProgram, expectedPath, label) {
  const deadline = Date.now() + stepTimeout
  let cur = null
  for (;;) {
    cur = await pollCurrentPage(miniProgram)
    if (cur && String(cur.path || '') === expectedPath) break
    if (Date.now() >= deadline) {
      const stack = await pageStackForError(miniProgram)
      const rt = await runtimeStackForError(miniProgram)
      throw new Error('等「进入' + label + '」超时（' + Math.round(stepTimeout / 1000) + ' 秒）：'
        + '期望 ' + expectedPath + '，当前页 ' + (cur ? cur.path : '<读不到>') + '，页面栈 ' + stack
        + '，' + rt
        + '（这是轮询预算的下界，单次 RPC 各带 10 秒超时，实际可能更久）'
        + '。判读同 goBackTo：两边都没到 = 路由在 runtime 层面没生效；'
        + 'runtime 到了而 automator 没到 = automator 的页面栈视图陈旧')
    }
    await sleep(200)
  }
  return await freshCurrentPage(miniProgram, cur.pageId, expectedPath, label)
}

// 主动跳转：下发路由指令，然后**自己确认真的到了**，不信路由方法的返回值。
//
// 为什么不能信返回值 —— 依据是**源码事实**，不是实测：
// changeRoute 的等待是 `sleep(3e3)` 这个固定睡眠，睡够就返回、不管跳转成没成，
// 它不是完成信号（out/MiniProgram.js，由 tests/automator-contract.test.js 钉着）。
// 固定睡眠只要不够长就会漏，只是漏的门槛从 800 毫秒抬到了 3 秒而已 —— 这和本文件
// 曾经用固定 800 毫秒等 tap 跳转是同一个错误，只是尺度不同。
//
// 【关于证据，说明白】曾经有一轮 main 版本在
//     const edit = await miniProgram.navigateTo('/pages/customer-edit/customer-edit?id=' + id)
// 之后报 'Cannot read properties of undefined (reading length)'（edit.data() 里没有 ledger），
// 一度被当成「3 秒不够」的实测证据。**这条证据后来被判定为不干净、已撤回**：当时那一轮
// 可能受热重载干扰（见文件末尾钉子⑥），而热重载会把小程序重启回入口页 pages/index/index，
// 其 data 同样没有 ledger —— 与「没跳到」完全同形，无法区分；而 main 版本在那一行
// 没有记录实际 path，所以两种解释都成立。
// 所以本函数的依据只有两条，都不依赖那轮：① 上面的源码事实；② 可诊断性 —— 出错时
// waitForPage 会报出「期望 X、当前页 Y、两侧页面栈」，而直接用返回值只会在下游炸出
// 一句看不出原因的 TypeError。
//
// 期望路径由 url 自己推导（pathOf），调用方不额外传：多一个参数就多一次写错的机会，
// 而这个参数写错的后果恰恰是「静默确认到了错误的页面」。
// ---------------------------------------------------------------------------
// 【路由指令不许紧挨着上一步下发】—— 本轮判定实验的结论，goto / goBackTo 里那句
// settleBeforeRoute() 的全部依据都在这段里。
//
// 在 origin/main（9c4abe0，**一个字没改**）上插桩跑了 7 轮，把 runOpeningSheet 结尾
// 那次退回前后的两侧页面栈连读 8 秒都打了出来（[PROBE] 原文在 PR #70 正文里）。
// 结论：**这个失败在 main 上本来就有，不是本分支引入的**，只是 main 那句裸的
// `await miniProgram.navigateBack()` 没有任何验证，紧接着 runPaySheet 一个 switchTab
// 就把页面栈重置了，于是退没退成功看不出来。
//
// 被吞的现场长这样：navigateBack() 正常返回（3027ms，正是 changeRoute 那个固定 sleep），
// 通道完全健康（探针 RPC 全是 1-3ms），但连读 8 秒，App.getPageStack 和 runtime 的
// getCurrentPages() 都一动不动，始终是 [customers > customer-edit]。
// 分离得很干净：退栈下发在上一次 tap 之后 ≤92ms → 3/3 被吞；≥290ms → 4/4 正常。
//
// 三条**已经被排除**的解释，别再回头查：
//   · 不是遮罩挡住 —— 内存模式下 store 的 showBusy/hideBusy 直接 return，没有 showLoading；
//   · 不是在途的 reloadLedger —— 被吞那几轮里 ledgerLoading / ledgerLock 早已是 false、
//     ledgerHasMore 也已落定；
//   · 不是视图层还没渲染完 —— 被吞的那一轮，页面上的欠款文案已经从 ¥17.00 变成 ¥37.00，
//     渲染明明落地了，退栈照样被吞。
//
// 两条同样重要的否定结论：
//   · **补发无效，不许加重试。** 从 runtime 侧补发 wx.navigateBack({success,fail})，
//     回调拿到的是 {"ok":true,"res":{"errMsg":"navigateBack:ok"}} —— API 说成功了，
//     栈依旧不动。重试只会把 30 秒烧完再报同一句话。
//   · **一旦被吞，路由就整个卡死。** 紧接着的任何一条路由指令都会让工具等满 10 秒、
//     报 timeout waiting for automator response。所以那个「偶发 timeout」和这里抓到的
//     「栈没退」是同一件事的两种表现，不是两个 bug。
//
// 【所以怎么修，以及诚实说明它的边界】
// 唯一被实测支撑的因果是「离上一步远一点就不犯」，**真正的阈值没测出来，成因也没查到
// （那在开发者工具里面，从外面看不见）**。所以这里只做一件事：每条路由指令下发之前
// 空出一段安静时间，成没成还是照旧由 waitForPage / goBackTo 轮询确认 —— 这不是
// 用固定 sleep 冒充完成信号（那是钉子①②禁的事），下发之后的判定一行没动。
//
// 【为什么基准取在「马上要下发」这一刻，而不是取在上一次 tap 上】
// 先试过「距上一次 tap 满 400ms」这条规则（ctrl-floor400-1 那轮）。期初欠款那处它治好了，
// 但那一轮仍然红在 runNativeClearModal 处，报 `timeout waiting for automator response`。
// **注意这句话能说到什么程度**：那一处**没有插桩**，也**没有记录 tap 到下发的实际间隔**，
// clearAll() 到底跑了多久、那次退栈离 tap 到底多远，产物里一个数都没有。所以只能说
// 「那条规则在这一步没有被验证有效」，**不能**断言它「等于没等」—— 那是没有数据的推断。
// 换成「无条件空出一段」的真正理由不是前者被证伪，而是：**它对『上一步做了多久』不敏感，
// 是更保守的形式**。「距 tap N 毫秒」在上一步耗时超过 N 的任何一步上都会退化成不等，
// 而哪些步骤会超过 N 是没数过的；无条件空出一段没有这个前提。附带好处是 tapEl / inputEl /
// callPageMethod 那三个记交互时刻的封装整套都不需要了，改动反而更小。
//
// 值为什么是 1000：比观察到的所有失败（≤92ms）高一个数量级。400 这个数只有一处实测 ——
// 期初欠款那一处在 400ms 下退栈正常（automator 路径 ctrl-floor400-1、runtime 路径
// probe-rt-floor400-1 各一次）—— 其余步骤在 400ms 下如何，没量过。1000 是保守取的，
// 不是二分出来的。嫌慢就用 WECHAT_UI_ROUTE_SETTLE 调，但调小之前先读上面那段。
//
// 【补测：这个易感窗口不是 automator 路由通道独有的】（本轮受控实验，合并 main 之后跑）
// 上面七轮量的都是「automator 经 RPC 下发 callWxMethod(navigateBack)」这一条路。为了知道
// runtime 自己发路由指令会不会也被吞，在同一处、同样的 ≤92ms 早下发条件下，把下发方式换成
// miniProgram.evaluate 在 runtime 里直接执行 wx.navigateBack({success, fail})：
//     probe-auto-1（对照，automator 下发，距 tap 70ms）   → 被吞，两侧栈 8 秒不动
//     probe-rt-1  （runtime 下发，距 tap 69ms）           → 被吞，回调 navigateBack:ok，栈不动
//     probe-rt-2  （runtime 下发，距 tap 74ms）           → 被吞，同上
//     probe-rt-floor400-1（runtime 下发，距 tap 401ms）   → 正常退栈，整轮绿
// 也就是说：**换掉 automator 的路由指令通道并不能免疫**，wx.navigateBack 在 runtime 里
// 执行时同样被吞（回调还报 ok）。所以不能拿「automator 桥独有」来论证产品路径安全。
// 【这个实验测不到什么，别外推】evaluate 走的是 App.callFunction，本身仍是一条 automator
// RPC。它能区分的是「automator 的路由指令通道」和「runtime 里执行 wx 路由 API」这两层，
// **不等于真实手指经页面 handler 触发**。真机上有没有这个窗口，一次都没测过。
const ROUTE_SETTLE = Number(process.env.WECHAT_UI_ROUTE_SETTLE || 1000)

// 数一下真的等了几次。理由：这个次数决定了整轮多花多少秒，而它是「8 个 goto 调用点 +
// backToTabRoot 循环里那个圈数不定的 goBackTo」算出来的，静态数调用点会数错。
// 以前 PR 里写过一个拍出来的秒数，事后没人能核实 —— 现在跑完直接打在日志里。
//
// 【为什么总时长必须是量出来的，不能拿 次数 × ROUTE_SETTLE 算】审计实测过一条和钉子⑨
// 同类、低一层的变异：把**这个函数体内**的 await 去掉（写成裸的 sleep(ROUTE_SETTLE)），
// 位置比较照过、钉子⑦⑨全绿、保护完全失效，而当时那行按「次数 × 配置值」算的收尾日志
// 照样打印「14 次 × 1000ms = 约 14 秒」—— 实际一秒没等，日志在说谎。
// 改成前后 Date.now() 求差累加之后，同一条变异会让累计毫秒当场塌成接近 0，日志自己露馅。
// 所以 settleMs 只许由下面这两行 Date.now() 产生，**永远不要**改回用 ROUTE_SETTLE 推算。
let settleCount = 0
let settleMs = 0

async function settleBeforeRoute() {
  if (ROUTE_SETTLE > 0) {
    settleCount += 1
    const settleAt = Date.now()
    await sleep(ROUTE_SETTLE)
    settleMs += Date.now() - settleAt
  }
}
// ---------------------------------------------------------------------------

async function goto(miniProgram, method, url, label) {
  await settleBeforeRoute()
  await miniProgram[method](url)
  return await waitForPage(miniProgram, pathOf(url), label)
}

// 退栈：下发 navigateBack，然后**自己确认真的退到了目标页**，不信它的返回值。
//
// 【为什么必须包这一层】navigateBack() 返回 **不等于** 退栈完成。changeRoute 的等待是固定
// sleep(3e3)（out/MiniProgram.js，由 tests/automator-contract.test.js 钉着），是睡够就返回，
// 不是完成信号。本轮实测抓到过它返回了、栈却一层没退：
//     [UI:trace] runNativeClearModal 结尾 navigateBack 之前 stack(2)=[pages/index/index#15 > pages/shop/shop#16]
//     [UI:trace] runNativeClearModal 结尾 navigateBack 之后 stack(2)=[pages/index/index#15 > pages/shop/shop#16]
//     紧接着下一条命令报 timeout waiting for automator response
// 两条 trace 都打了出来（说明 navigateBack() 正常返回、RPC 通道当时还通），但栈没动。
// 所以「navigateBack() 返回即已完成」是错的 —— 这正是本函数存在的理由。
//
// 【判据】「栈变浅」和「栈顶就是退栈前的那一页」两个条件同时成立，缺一不可：
//   · 只等栈顶匹配 —— 遇上 customers > customer-edit > customers 这种同一个页面在栈里
//     出现两次的情形，navigateBack 还没生效时栈顶就已经"匹配"了，立刻假通过；
//   · 只等栈长度变小 —— 退到了非预期的页面（多退了一层、或者被别的跳转插队）不会报错。
// 栈顶按 **pageId** 认而不是按 path 认：pageId 是页面实例的身份，target 那一层没被弹掉、
// id 不会变；path 认不出「同一个路径的两个不同实例」。
//
// 【基准必须取在 navigateBack 之前】这是上一轮栽过的坑，别再挪。曾经包过一层同样意图的
// 等待（叫 goBack），它在 navigateBack() **返回之后**才去读基准栈深；而那时 3 秒已经睡完、
// 栈往往早就变浅了，于是拿变浅后的值再等「比这更浅」，永远等不到，整轮挂死。
// 教训是「基准取晚了」，**不是**「不该包等待」。这个先后顺序由文件末尾的钉子⑤看着。
//
// 【别再归错因】上一轮那次挂死是两个原因叠加，不是一个：
//   ① 基准取晚了（本函数已修）；
//   ② 「退栈没生效」的现场。R1/R2 的判读结果**按位置分开写**，两处的证据强度不一样，
//      别把其中一处的结论套到另一处：
//        · **runOpeningSheet 结尾那处：已定为 R1**（wx 路由在 runtime 层面就没生效）。
//          依据是插桩采到的双栈快照（baseline-r1 / baseline-r3 / ctrl-early-1）：
//          navigateBack() 正常返回，App.getPageStack 和 runtime 的 getCurrentPages()
//          连读 8 秒都一动不动 —— runtime 侧自己都说没退，所以不是 automator 视图陈旧。
//        · **runNativeClearModal 结尾那处：未插桩，R1/R2 仍未定。** 七轮插桩的探针
//          全部只装在 runOpeningSheet 结尾，这一处**一次栈快照都没采到过**。
//          唯一相关的一轮（ctrl-floor400-1）在这一步只留下一句裸的
//          `timeout waiting for automator response`，既没有 automator 栈也没有 runtime 栈，
//          而 R1/R2 的判据恰恰就是「runtime 栈退没退」。上面那两行 trace 只有 automator 侧，
//          所以只能说「automator 侧观测不到退栈」。目前能说的只有：它的症状与上面那处
//          被吞之后的表现一致，**疑似**同因。
// ② 未根治，所以本函数**仍然可能**在那两处超时。超时报错里带 runtime 侧 getCurrentPages()
// 快照，就是为了让下一个人一眼判出撞上的是 R1 还是 R2，不必从头查一遍 —— 尤其是
// runNativeClearModal 那处，下次撞上时那份快照就是把它定性所缺的那个量。
async function goBackTo(miniProgram, label) {
  // 【先空出安静时间，再读基准，再下发】依据见 ROUTE_SETTLE 上方那段实测。
  // 顺序有讲究：settle 放在读基准之前，基准才是"下发那一刻"的栈；放在读基准之后，
  // 基准就旧了一秒。另外说清楚 —— 本函数上一轮抓到的「navigateBack 返回了、两侧栈
  // 都没动」不是本函数写错了，那就是被吞的现场，本函数的功劳是把它从静默变成了报错。
  await settleBeforeRoute()
  // 基准这一次读**不能**降级成 null：读不到基准就没法判断退没退到位，直接报错比蒙着走好。
  // 套 withTimeout 只是为了别永远挂着（Connection.send 没超时）。这行在 navigateBack 之前，
  // 抛出去也不存在盖掉原始错误的问题。
  const before = await withTimeout(rawPageStack(miniProgram), 10000, '读退栈前的页面栈基准')
  if (before.length < 2) {
    throw new Error('退回「' + label + '」没有可退的目标：当前页面栈只有 '
      + before.length + ' 层 ' + describeStack(before))
  }
  const target = before[before.length - 2]
  await miniProgram.navigateBack()
  const deadline = Date.now() + stepTimeout
  for (;;) {
    const now = await pollPageStack(miniProgram)
    const top = now && now.length ? now[now.length - 1] : null
    if (now && now.length < before.length && top && String(top.pageId) === String(target.pageId)) {
      break
    }
    if (Date.now() >= deadline) {
      const nowText = now ? describeStack(now) : '<取证失败: 读 automator 页面栈超时或出错>'
      const rt = await runtimeStackForError(miniProgram)
      throw new Error('等「退回' + label + '」超时（' + Math.round(stepTimeout / 1000) + ' 秒）：'
        + '期望退到 ' + target.path + '#' + target.pageId
        + '，退栈前 ' + describeStack(before) + '，现在 ' + nowText + '，' + rt
        + '（这是轮询预算的下界，单次 RPC 各带 10 秒超时，实际可能更久）'
        + '。判读：runtime 栈也没退 = wx.navigateBack 在 runtime 层面没生效（R1，多等无用，'
        + '要换路由方式或在页面侧加可观测的卸载信号）；runtime 栈退了而 automator 栈没退 = '
        + 'automator 的页面栈视图陈旧（R2，等的判据要改成读 runtime 侧）')
    }
    await sleep(200)
  }
  return await freshCurrentPage(miniProgram, target.pageId, String(target.path || ''), label)
}

// 【源码事实】automator 0.12.1 的 out/MiniProgram.js#changeRoute 是：
//     currentPage() → callWxMethod(navigateBack) → sleep(3000) → currentPage()
// 五个路由方法（navigateTo / redirectTo / navigateBack / reLaunch / switchTab）全走它，
// 每次固定至少 3 秒。**但那 3 秒是固定睡眠、不是完成信号**：睡够就返回，不管跳转成没成。
// 所以下面这个循环不直接调 miniProgram.navigateBack()，而是走 goBackTo —— 由它自己确认
// 退到了目标页（为什么必须这样，见 goBackTo 上方那段里的实测反例）。
// 这条源码事实被 tests/automator-contract.test.js 钉着，automator 一升级就会红。
//
// 顺带纠正一个曾经的错觉：这个循环「5 圈在一瞬间烧完」是不可能的 —— 每圈之间隔着
// navigateBack 自带的 3 秒，再加 goBackTo 自己的确认轮询。实测一圈就退回去了：
//     [UI:trace] backToTabRoot#0 navigateBack 之前 stack(2)=[pages/customers/customers#9 > pages/customer-edit/customer-edit#11]
//     [UI:trace] backToTabRoot#0 navigateBack 之后 stack(1)=[pages/customers/customers#9]
//
// 工具 2.02.x 上，站在 navigateTo 进来的二级页调用 reLaunch，automator 会等满 10 秒报
// 「timeout waiting for automator response」，而且页面压根没跳（在 customer-edit 上必现）。
// 退回栈底的 tab 页再 reLaunch 就正常。所以每次 reLaunch 之前先把栈清干净。
async function backToTabRoot(miniProgram) {
  for (let i = 0; i < 5; i++) {
    // 走 pollPageStack 而不是 miniProgram.pageStack()：后者没有超时（挂住就是本函数
    // 永久挂死，只剩 15 分钟整轮看门狗兜底、报错还不指位置），而且它会过 pageMap 构造
    // Page 对象 —— 判「现在在哪一页 / 栈多深」一律走原始 RPC，理由见上方 rawPageStack 那段。
    // 读不到就当「栈还没读到」，按栈深未知处理：直接报错比拿不确定的值往下走好。
    const stack = await pollPageStack(miniProgram)
    if (!stack) {
      throw new Error('backToTabRoot 第 ' + i + ' 圈读页面栈失败（超时或出错），无法判断还要退几层')
    }
    if (stack.length <= 1) return
    await trace(miniProgram, 'backToTabRoot#' + i + ' navigateBack 之前')
    await goBackTo(miniProgram, '上一页（backToTabRoot 第 ' + i + ' 圈）')
    await trace(miniProgram, 'backToTabRoot#' + i + ' navigateBack 之后')
  }
  throw new Error('退不回 tab 页，页面栈太深')
}

async function seedFromHome(miniProgram) {
  step('清空本地数据并点「填充示例数据」')
  await resetStorage(miniProgram)
  await backToTabRoot(miniProgram)
  const home = await goto(miniProgram, 'reLaunch', '/pages/index/index', '首页')
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
  const sale = await goto(miniProgram, 'switchTab', '/pages/sale/sale', '销售页')
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
  const records = await goto(miniProgram, 'navigateTo', '/pages/records/records', '流水页')
  await waitFor(records, '.js-record-out', '出现 .js-record-out')
  const items = await records.$$('.js-record-out')
  assert.ok(items.length > 0, '流水里没有销售记录')
  await items[0].tap()

  const edit = await waitForPage(miniProgram, 'pages/record-edit/record-edit', '流水详情页')
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
  await trace(miniProgram, 'runRecordSlipExport 结尾 navigateBack 之前')
  await goBackTo(miniProgram, '流水页')
  await trace(miniProgram, 'runRecordSlipExport 结尾 navigateBack 之后')
}

async function runOpeningSheet(miniProgram) {
  step('客户页：记期初欠款，弹出层并确认')
  const list = await goto(miniProgram, 'switchTab', '/pages/customers/customers', '客户页')
  await waitFor(list, '.js-customer-item', '出现 .js-customer-item')
  await tap(list, '.js-customer-item')

  const edit = await waitForPage(miniProgram, 'pages/customer-edit/customer-edit', '客户编辑页')
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
  await trace(miniProgram, 'runOpeningSheet 结尾 navigateBack 之前')
  await goBackTo(miniProgram, '客户页')
  await trace(miniProgram, 'runOpeningSheet 结尾 navigateBack 之后')
}

async function runPaySheet(miniProgram) {
  step('客户页：点收款，弹出收款层并确认')
  const list = await goto(miniProgram, 'switchTab', '/pages/customers/customers', '客户页')
  await waitPageReady(list)
  await waitFor(list, '.js-collect', '出现 .js-collect')
  await tap(list, '.js-collect')

  const edit = await waitForPage(miniProgram, 'pages/customer-edit/customer-edit', '客户编辑页')
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
  const records = await goto(miniProgram, 'navigateTo', '/pages/records/records', '流水页')
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
  await trace(miniProgram, 'runRecordsLoadMore 结尾 navigateBack 之前')
  await goBackTo(miniProgram, '客户页')
  await trace(miniProgram, 'runRecordsLoadMore 结尾 navigateBack 之后')
}

async function runCustomerLedgerLoadMore(miniProgram) {
  step('客户页：往来记录超过一页时手动「加载更多」兜底')
  const customerId = await miniProgram.evaluate(function () {
    const list = wx.getStorageSync('inv_customers') || []
    return list.length ? list[0].id : ''
  })
  assert.ok(customerId, '前提：示例数据里有客户')
  await seedExtraPayDocs(miniProgram, 30, customerId, 'cust')
  const edit = await goto(miniProgram, 'navigateTo',
    '/pages/customer-edit/customer-edit?id=' + customerId, '客户编辑页')
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
  await trace(miniProgram, 'runCustomerLedgerLoadMore 结尾 navigateBack 之前')
  await goBackTo(miniProgram, '客户页')
  await trace(miniProgram, 'runCustomerLedgerLoadMore 结尾 navigateBack 之后')
}

async function runNativeClearModal(miniProgram) {
  step('店铺页：点清空（原生弹窗用 mock 自动确认）')
  // 上一步停在 customer-edit，直接 reLaunch 会超时，见 backToTabRoot。
  // 这一整段逐条打了 mark：两轮 UI 测试都在本函数里以「timeout waiting for automator
  // response」告终，但一次在结尾的 navigateBack 之后、一次早到连 trace 都没来得及打，
  // 需要夹逼出到底是哪条命令把工具卡住的。mark 不发 RPC，工具卡死了它也打得出来。
  mark('runNativeClearModal: backToTabRoot 之前')
  await backToTabRoot(miniProgram)
  mark('runNativeClearModal: reLaunch(/pages/index/index) 之前')
  const home = await goto(miniProgram, 'reLaunch', '/pages/index/index', '首页')
  mark('runNativeClearModal: reLaunch 之后 / waitPageReady(home) 之前')
  await waitPageReady(home)
  await waitFor(home, '.js-shop', '出现 .js-shop')
  mark('runNativeClearModal: tap(.js-shop) 之前')
  await tap(home, '.js-shop')
  const shop = await waitForPage(miniProgram, 'pages/shop/shop', '店铺页')
  mark('runNativeClearModal: 已进入 shop / waitPageReady(shop) 之前')
  await waitPageReady(shop)
  await waitFor(shop, '.js-clear', '出现 .js-clear')
  mark('runNativeClearModal: tap(.js-clear) 之前')
  await tap(shop, '.js-clear')
  mark('runNativeClearModal: tap(.js-clear) 之后 / 等 isEmpty')
  await waitFor(shop, async function () {
    const data = await shop.data()
    return data && data.isEmpty === true
  }, '店铺数据清空')
  mark('runNativeClearModal: isEmpty 已为 true')
  await trace(miniProgram, 'runNativeClearModal 结尾 navigateBack 之前')
  const backHome = await goBackTo(miniProgram, '首页')
  await trace(miniProgram, 'runNativeClearModal 结尾 navigateBack 之后')
  await waitPageReady(backHome)
  await waitFor(backHome, '.js-seed', '出现 .js-seed')
}

async function run() {
  const cliPath = resolveCliPath()
  if (!cliPath) {
    throw new Error('找不到微信开发者工具的 cli，把环境变量 WECHAT_CLI 设成 cli.bat 的完整路径')
  }

  activeCliPath = cliPath

  // 生效参数打在开头：这两个值都能被环境变量覆盖，而产物里看不出用的是哪个值。
  // 上一轮审计就卡在这里 —— 三轮全绿的日志里无从核实 ROUTE_SETTLE 到底是不是 1000。
  step('本轮参数：ROUTE_SETTLE=' + ROUTE_SETTLE + 'ms（路由指令下发前的安静时间）'
    + '，stepTimeout=' + stepTimeout + 'ms（单步超时）')

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
  // 代价也报出来，别让下一个人只能从 PR 正文里抄一个没法核实的秒数。
  // 总时长是 settleBeforeRoute 里 Date.now() 前后差**实测累加**出来的，不是
  // 次数 × ROUTE_SETTLE 算的 —— 理由见 settleBeforeRoute 上方那段（算出来的数在
  // 「函数体内 await 被去掉」这条变异下会照样好看，量出来的会塌成接近 0）。
  step('settleBeforeRoute 本轮实际执行 ' + settleCount + ' 次，实测累计等待 '
    + settleMs + 'ms（约 ' + Math.round(settleMs / 1000) + ' 秒；配置 ROUTE_SETTLE='
    + ROUTE_SETTLE + 'ms）')
  console.log('ui tests passed')
}

// ---------------------------------------------------------------------------
// 自检钉子：读本文件自己的源码，钉住两条容易被下一个人顺手改掉的约定。
// 放在 run() 之前而不是文件真正的末尾 —— 红的时候要在打开开发者工具之前就断掉，
// 否则会在 run() 已经在飞的时候抛顶层异常，finally 里那句关窗口就执行不到了。
// needle 一律用拼接写，不写成字面量，免得钉子自己的这几行把自己扫红。
// ---------------------------------------------------------------------------
const selfSource = fs.readFileSync(__filename, 'utf8')

// 只剥注释，块注释换成等量空白（保持长度，不影响别处）。抄自
// tests/no-duplicate-decls.test.js 的 stripComments —— 那边是脚本不是模块，
// require 它会把整个测试再跑一遍，所以只能抄不能共享。
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (block) { return block.replace(/[^\n]/g, ' ') })
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function countOccurrences(haystack, needle) {
  let n = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    n += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

// 钉子①：不许再出现「固定睡 800 毫秒的 page.waitFor」这个**具体字面量**。
// page.waitFor(数字) 就是 sleep(数字)（out/Page.js: isNum -> sleep），跟页面没关系；
// 跳转比它慢就拿到跳转之前的页面，报「未进入 XX 页」这种看着像功能坏了的假失败。
//
// **诚实说明覆盖面**：这条只钉「waitFor 后面直接跟 800」这一个字面量，不是「禁止一切固定 sleep」。
// 换成 sleep(2000)、page.waitFor(1500) 等等它都拦不住（实测绕过确认过）。
// 结构性保护来自钉子③（不许直接用路由方法返回值）、钉子④（调用点必须传完整路径）
// 和钉子⑦（封装体内必须真的有轮询确认）。**说清各自管什么**：③④ 只盯**调用点写法**，
// 不看封装体；把 goto 的函数体整个换成「下发指令 + 睡 2 秒 + currentPage()」，③④ 照样全绿
// （实测验证过）。补钉子⑦就是为了堵这个洞，但它也只认结构关键字，不保证语义正确。
// 本条的价值只是：把踩过的那个坑本身钉死，别原样复发。
assert.strictEqual(
  countOccurrences(selfSource, 'waitFor(' + '800)'),
  0,
  '本文件里不许再出现「固定睡 800 毫秒的 page.waitFor」来等跳转：跳转慢一点就拿到旧页面，'
    + '要用 waitForPage 轮询真实路径'
)

// 钉子②：runSalePickerAndSlip 里那一处「等 200 毫秒的 sale.waitFor」必须原样留着，且只有一处。
// 它不是在等跳转 —— 那时人已经在 sale 页上没动过，等的是点「一分未收」之后
// setData 回到视图层；页面数据里没有可以拿来判定「这次点击算完了」的标志位
// （paidAmount 点之前点之后都是字符串，分不出"还没变"和"变成了 0"），
// 所以这里保留一小段固定等待是有意的，不是漏改。
// 全局把 waitFor(数字) 换成轮询的时候，别把这一处也顺手换掉。
assert.strictEqual(
  countOccurrences(selfSource, 'sale.waitFor(' + '200)'),
  1,
  'runSalePickerAndSlip 里那一处「等 200 毫秒的 sale.waitFor」应当恰好保留 1 次：'
    + '它等的是 setData 回视图层，不是等跳转'
)

// 钉子③：路由方法的返回值一律不许直接用，必须过 goto / goBackTo。
// 依据是源码事实：changeRoute 的等待是固定 sleep(3e3)，睡够就返回、不是完成信号
// （由 tests/automator-contract.test.js 钉着）。
// 注：曾经引用过一轮 main 版本的 TypeError 当实测证据，那条证据已判定不干净并撤回，
// 理由写在 goto 函数上方。这条钉子不依赖它。
// 所以除了 goBackTo 内部那一次 navigateBack，本文件不许再直接调这五个路由方法。
// 这条红了 = 有人又直接用返回值了，请改走 goto / goBackTo。
// needle 一律拼出来，不写成字面量 —— 下面这张名单本身就在本文件里，写成字面量会把自己数进去。
const routeSource = stripJsComments(selfSource)
;[
  ['navigateTo', 0],
  ['switchTab', 0],
  ['reLaunch', 0],
  ['redirectTo', 0],
  ['navigateBack', 1]
].forEach(function (pair) {
  assert.strictEqual(
    countOccurrences(routeSource, 'miniProgram.' + pair[0] + '('),
    pair[1],
    '直接调用 miniProgram.' + pair[0] + '(...) 的次数应当是 ' + pair[1] + ' —— 路由方法的返回值不可信'
      + '（changeRoute 只是固定睡 3 秒），一律走 goto / goBackTo 自己确认到位'
  )
})

// 上面那张名单只挡点号写法。方括号写法（miniProgram['switchTab'](…)）能绕过去，
// 所以再钉一条：本文件里 miniProgram[ 这种下标调用只允许有一处 —— goto 内部那句
// miniProgram[method](url)。多出来的多半就是绕过上面名单的路由直调。
assert.strictEqual(
  countOccurrences(routeSource, 'miniProgram' + '['),
  1,
  '下标形式的路由直调（miniProgram 后面直接跟方括号）只允许 1 处 —— 就是 goto 内部'
    + '那句用下标取方法名的调用。多出来的多半是用方括号写法绕过了「不许直接用路由方法返回值」这条'
)

// 钉子④：waitForPage / goto 的调用点必须传 pages/ 开头的完整路径，不许退回短片段。
// 判据是完整路径精确相等；传 'shop' 这种短片段在今天能work纯属路径命名的偶然
// （'record' 同时是 pages/records/records 和 pages/record-edit/record-edit 的子串）。
// 这条红了 = 有人图省事传了短片段，请补成完整路径。
var badTargets = []
var reWaitForPage = /waitForPage\(miniProgram,\s*'([^']*)'/g
var hit = null
while ((hit = reWaitForPage.exec(routeSource)) !== null) {
  if (hit[1].indexOf('pages/') !== 0) badTargets.push('waitForPage -> ' + JSON.stringify(hit[1]))
}
var reGoto = /goto\(miniProgram,\s*'[a-zA-Z]+',\s*'([^']*)'/g
while ((hit = reGoto.exec(routeSource)) !== null) {
  if (hit[1].indexOf('/pages/') !== 0) badTargets.push('goto -> ' + JSON.stringify(hit[1]))
}
assert.strictEqual(
  badTargets.length,
  0,
  '这些调用点传的不是 pages/ 开头的完整路径（判据是精确相等，短片段会静默匹配到别的页面）：\n'
    + badTargets.join('\n')
)

// 钉子⑦：goto / goBackTo / waitForPage 的**封装体本身**必须真的在轮询确认，不能退化成
// 「下发指令 + 睡一觉 + 读一次」。
// 钉子③④ 只盯调用点写法：实测把 goto 的函数体换成
//     await miniProgram[method](url); await sleep(2000); return await miniProgram.currentPage()
// 之后，③④ 仍然全绿 —— 因为调用点一个字没改。这条就是堵那个洞。
// **局限**：它只认结构关键字（deadline / 轮询 / 转调），不校验语义；有人把 deadline 设成
// 1 毫秒它照样绿。它挡的是「整体退化成固定 sleep」这一种，不是所有写坏的方式。
;[
  ['waitForPage', ['deadline', 'sleep(200)', 'pollCurrentPage']],
  ['goBackTo', ['deadline', 'sleep(200)', 'pollPageStack', 'settleBeforeRoute']],
  ['goto', ['waitForPage', 'settleBeforeRoute']]
].forEach(function (pair) {
  const name = pair[0]
  const at = routeSource.indexOf('async function ' + name + '(')
  assert.ok(at >= 0, '钉子⑦：找不到 ' + name + ' 的定义，钉子失效了')
  const end = routeSource.indexOf('\n}', at)
  assert.ok(end > at, '钉子⑦：找不到 ' + name + ' 的函数体结尾，钉子失效了')
  const body = routeSource.slice(at, end)
  pair[1].forEach(function (needle) {
    assert.ok(
      body.indexOf(needle) >= 0,
      '钉子⑦：' + name + ' 的函数体里找不到 ' + JSON.stringify(needle) + ' —— 封装体可能被退化成了'
        + '「下发指令 + 固定 sleep + 读一次」。这类退化钉子③④看不见（它们只盯调用点写法），'
        + '所以必须由本条拦下。要改封装体的实现方式，连同本条一起改，别直接删。'
    )
  })
})

// 钉子⑧：automator 的 pageMap 字段名。
// freshCurrentPage 里直接摸 miniProgram.pageMap.delete(...) —— 这是**非公开字段**，
// automator 改名的话不会让契约测试变红，而是在跑到那一行时抛运行期 TypeError
// （「Cannot read properties of undefined (reading 'delete')」），现场看不出是升级导致的。
// 所以在这里先确认它存在、且是个带 delete 的 Map。
const MiniProgramCls = require('miniprogram-automator/out/MiniProgram').default
// 构造函数会往 connection 上挂三个监听，所以喂一个只有 on() 的假连接；不发任何 RPC。
const probeInstance = new MiniProgramCls({ on: function () {} })
assert.ok(
  probeInstance.pageMap && typeof probeInstance.pageMap.delete === 'function',
  'MiniProgram 实例上没有带 delete 的 pageMap 字段了（automator 可能改了名或换了实现）。'
    + 'tests/ui.test.js 的 freshCurrentPage 直接用 miniProgram.pageMap.delete(pageId) 清缓存，'
    + '字段没了会在运行期抛 TypeError 而不是让契约测试变红，所以在这里先拦一道。'
)

// 钉子⑥：项目目录里不许留运行日志之类的产物。**这是本仓最隐蔽的一个坑。**
//
// 【为什么】project.config.json 里 compileHotReLoad = true，开发者工具还带一个
// wxfilewatcher 进程在监听整个项目目录。跑 UI 测试时往这个目录里写文件 —— 最常见的就是
// `npm run test:ui > out.txt` 这种输出重定向，shell 是**流式**写入的，一轮十分钟日志一直在长
// —— 会持续触发热重载：小程序被重启，页面栈清空、回到入口页 pages/index/index。
// 此后任何等待都等不到目标页，而报错现场看上去只是「没跳过去」，**完全看不出真实原因**。
//
// 【实测对照】同一份代码（tests/ui.test.js sha1 35db9459…），唯一变量是日志写在哪：
//   · 日志写在项目根目录 → 红。现场是：
//       等「进入流水页」超时（30 秒）：期望 pages/records/records，当前页 pages/index/index，
//       页面栈 [pages/index/index#8]，runtime栈(1)=[pages/index/index]
//     栈深 1 且停在入口页、pageId 还比同期健康轮更大（新建的实例）= 小程序被重启过。
//   · 日志改写到项目目录之外 → 绿。
//
// 【热重载解释不了什么，别过度归因】热重载的现场签名是「栈深 1、停在入口页、pageId 变大
// （新建实例）」。曾经另有一处 runNativeClearModal 结尾退栈失败，现场是
//     navigateBack 之前 stack(2)=[pages/index/index#15 > pages/shop/shop#16]
//     navigateBack 之后 stack(2)=[pages/index/index#15 > pages/shop/shop#16]
// 栈深没变、pageId 前后完全相同 —— 不符合热重载的签名，**热重载解释不了它**。那一处
// 至今原因未定（R1/R2 未定），不要因为找到了热重载就把它一并算进去。
//
// 【正确做法】把输出重定向到项目目录**之外**（系统临时目录之类）：
//     npm run test:ui > "$TMPDIR/ui.txt" 2>&1; echo "EXIT=$?"
//
// 【这条钉子的局限，别高估它】
//   · 只查项目根目录，**不递归** —— 写进任何子目录照样触发热重载，钉不住；
//   · 只认 .txt / .log / .out 三种后缀 —— 换个文件名就漏；
//   · 只在**进程启动那一刻**查一次 —— 真正危险的是「跑测试期间往项目目录内写任何文件」，
//     那是个动态过程，静态断言在原理上就覆盖不了。
//   它能挡的只是最常见的那一种踩法：重定向的目标文件在 node 启动前就已经被 shell 创建。
//   钉不住的那些，只能靠上面这段注释和排查清单第 10 条。
const runArtifacts = fs.readdirSync(projectPath).filter(function (name) {
  return /\.(txt|log|out)$/i.test(name)
})
assert.strictEqual(
  runArtifacts.length,
  0,
  '项目根目录里有运行产物：' + runArtifacts.join(', ')
    + '。开发者工具在监听这个目录（project.config.json 里 compileHotReLoad=true，'
    + '外加 wxfilewatcher 进程），跑测试期间往这里写文件会触发热重载 —— 小程序被重启、'
    + '页面栈清空回入口页 pages/index/index，于是所有等待都等不到目标页，'
    + '而报错看上去只是「没跳过去」，查不到真正原因。'
    + '请把输出重定向到项目目录之外再跑，例如 npm run test:ui > "$TMPDIR/ui.txt" 2>&1'
)

// 钉子⑤：goBackTo 必须在 navigateBack **之前**取页面栈基准。
//
// 这是上一轮唯一真正栽进去的坑：老的 goBack 在 navigateBack() 返回之后才读基准栈深，
// 而 navigateBack() 自己已经睡了 3 秒、栈往往早就变浅了，于是拿变浅后的值再等
// 「比这更浅」，永远等不到，整轮挂死 30 秒。
// 在此之前这条只有注释在管 —— 有人把取基准那行挪到 navigateBack 之后，
// 前面四条钉子全都照样绿，等于没有保护。所以这里按**源码里的先后位置**钉死。
const goBackToBody = (function () {
  const at = routeSource.indexOf('async function goBackTo(')
  assert.ok(at >= 0, '找不到 goBackTo 的定义，钉子⑤失效了')
  const end = routeSource.indexOf('\n}', at)
  assert.ok(end > at, '找不到 goBackTo 的函数体结尾，钉子⑤失效了')
  return routeSource.slice(at, end)
})()

const baselineAt = goBackToBody.indexOf('rawPageStack(')
const navBackAt = goBackToBody.indexOf('miniProgram.' + 'navigateBack(')
assert.ok(
  baselineAt >= 0,
  '自检：goBackTo 体内应当读一次 rawPageStack 当基准，没找到 —— 钉子⑤失效了'
)
assert.ok(
  navBackAt >= 0,
  '自检：goBackTo 体内应当有一次 navigateBack 调用，没找到 —— 钉子⑤失效了'
)
assert.ok(
  baselineAt < navBackAt,
  '基准必须取在 navigateBack 之前：现在读 rawPageStack 的位置（' + baselineAt
    + '）排在 navigateBack（' + navBackAt + '）之后。'
    + 'navigateBack() 自带 3 秒睡眠，返回时栈往往已经变浅，'
    + '这之后再取"基准"就等于拿变浅后的值去等"比这更浅"，永远等不到 —— 上一轮就是这么挂死的'
)

// 钉子⑨：settleBeforeRoute() 必须**带 await** 且排在真正下发路由指令**之前**。
// 钉子⑦只查函数体里有没有这个词，把它挪到 navigateBack 之后照样绿 —— 而那样一挪，
// 「空出安静时间」就完全失效，症状是随机某一步报「等退回 XX 超时 / 两侧栈都没动」，
// 看不出和挪动有关系。和钉子⑤同一类坑（顺序错了、静默失效），所以同样钉死。
//
// 【为什么 needle 里要带 await】把 await 去掉（写成裸的 settleBeforeRoute()），位置比较
// 照样通过、钉子⑦⑨全绿，但那个 sleep 变成一条没人等的游离 promise，保护完全消失 ——
// 症状和这次一模一样。**实测过**：在旧版钉子下把 goto 里的 await 去掉，整轮 UI 测试
// 照样 EXIT=0 全绿。所以位置和 await 必须一起钉，只钉位置等于漏掉一半。
const settleNeedle = 'await ' + 'settleBeforeRoute('
const settleAt = goBackToBody.indexOf(settleNeedle)
assert.ok(
  settleAt >= 0,
  '自检：goBackTo 体内应当有一次 ' + JSON.stringify(settleNeedle) + ' 调用，没找到 —— '
    + '要么被删了，要么 await 被去掉了（去掉 await 的话 sleep 就没人等，保护等于不存在）'
)
assert.ok(
  settleAt < navBackAt,
  'settleBeforeRoute() 必须排在 navigateBack 之前：现在它在位置 ' + settleAt
    + '，而 navigateBack 在 ' + navBackAt + '。放在后面等于没空出安静时间，'
    + '被吞的退栈会原样复发（依据见 ROUTE_SETTLE 上方那段实测）'
)

const gotoBodyAt = routeSource.indexOf('async function goto(')
assert.ok(gotoBodyAt >= 0, '找不到 goto 的定义，钉子⑨失效了')
// 这条 end > at 不能省：indexOf 找不到时返回 -1，slice(x, -1) 不报错，会把「函数体」变成
// 从 goto 开头一直到文件倒数第二个字符的一大段，于是下面的位置比较仍然为真、钉子静默
// 降级成弱检查却照样绿。钉子⑤⑦都有这一条，这里之前漏了。
const gotoBodyEnd = routeSource.indexOf('\n}', gotoBodyAt)
assert.ok(gotoBodyEnd > gotoBodyAt, '找不到 goto 的函数体结尾，钉子⑨失效了')
const gotoBody = routeSource.slice(gotoBodyAt, gotoBodyEnd)
const gotoSettleAt = gotoBody.indexOf(settleNeedle)
const gotoCallAt = gotoBody.indexOf('miniProgram' + '[method]')
assert.ok(gotoSettleAt >= 0 && gotoCallAt >= 0 && gotoSettleAt < gotoCallAt,
  'goto 里 ' + JSON.stringify(settleNeedle) + ' 必须排在下发路由指令之前：settle 在 '
    + gotoSettleAt + '，下发在 ' + gotoCallAt + '（-1 表示压根没找到 —— 也可能是 await 被去掉了）'
)

// 自检（钉住钉子④的判据本身）：上面两个正则必须真的扫到了调用点。
// 不能用 countOccurrences 来做这个自检 —— 它数的是「函数名 + miniProgram,」的出现次数
// （还会把函数定义本身和 goto 内部那次调用数进去），而钉子④真正依赖的是**正则匹配到的
// 带引号字面量**。两者数的不是一回事：正则哪天写坏了匹配不到任何东西，badTargets 会是空的、
// 钉子④假绿，而 countOccurrences 那个数一点不会变，照样放行。所以这里直接数正则的战果。
var waitForPageTargets = []
reWaitForPage.lastIndex = 0
while ((hit = reWaitForPage.exec(routeSource)) !== null) waitForPageTargets.push(hit[1])
assert.strictEqual(
  waitForPageTargets.length,
  4,
  '自检：waitForPage 的字面量调用点应当正好 4 处（4 处 tap 触发的跳转），实为 '
    + waitForPageTargets.length + ' 处：' + JSON.stringify(waitForPageTargets)
    + ' —— 数目对不上说明要么正则失效了（钉子④是假绿的），要么调用点增减了，两种都要人看一眼'
)

var gotoTargets = []
reGoto.lastIndex = 0
while ((hit = reGoto.exec(routeSource)) !== null) gotoTargets.push(hit[1])
assert.strictEqual(
  gotoTargets.length,
  8,
  '自检：goto 的字面量调用点应当正好 8 处，实为 ' + gotoTargets.length + ' 处：'
    + JSON.stringify(gotoTargets)
    + ' —— 数目对不上说明要么正则失效了（钉子④是假绿的），要么调用点增减了，两种都要人看一眼'
)

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
  console.error('11. 在任务 worktree 里跑时，project.private.config.json 在 .gitignore 里，git worktree')
  console.error('    add 出来的目录没有它，工具会按全新项目的默认设置打开这棵树。症状是随机的初始化/')
  console.error('    超时失败而不是断言失败，先从主检出 cp 一份过来再跑，别当成代码回归')
  console.error('12. **不要把测试的输出/日志写在项目目录里**（含 > out.txt 这种重定向）。工具在监听')
  console.error('    这个目录且开了热重载，写入会让小程序重启、页面栈清空回入口页，之后所有等待都')
  console.error('    等不到目标页，报错却只显示「没跳过去」。把输出重定向到项目目录之外再跑。')
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
