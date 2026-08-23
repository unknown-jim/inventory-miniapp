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
  // 进度和 √ auto 都走 stderr，出错时要一起打出来。
  child.stdout.on('data', function (chunk) { chunks.push(String(chunk)) })
  child.stderr.on('data', function (chunk) { chunks.push(String(chunk)) })
  child.on('error', function (error) { started.error = error })
  child.on('exit', function (code) { started.exitCode = code })
  return started
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
        return await original.call(this)
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
      return await automator.connect({ wsEndpoint: wsEndpoint })
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) break
      await sleep(1000)
    }
  }
  throw lastError
}

async function tap(page, selector) {
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到可点击元素: ' + selector)
  }
  await el.tap()
}

async function tapWhen(page, selector) {
  await page.waitFor(selector)
  await tap(page, selector)
}

async function waitGone(page, selector) {
  await page.waitFor(async function () {
    const list = await page.$$(selector)
    return list.length === 0
  })
}

async function textOf(page, selector) {
  await page.waitFor(selector)
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到文本元素: ' + selector)
  }
  return el.text()
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
  await page.waitFor(async function () {
    const data = await page.data()
    return data && data.pageLoading === false
  })
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
  await home.waitFor('.js-seed')
  await tap(home, '.js-seed')
  await home.waitFor(async function () {
    const data = await home.data()
    return data && data.isEmpty === false
  })
  return home
}

async function runSalePickerAndSlip(miniProgram) {
  step('销售：点选商品、客户，一分未收出库，核对送货单')
  const sale = await miniProgram.switchTab('/pages/sale/sale')
  await waitPageReady(sale)
  await sale.waitFor('.js-product-picker')

  await tap(sale, '.js-product-picker')
  await sale.waitFor('.js-product-item')
  const products = await sale.$$('.js-product-item')
  assert.ok(products.length > 0, '商品点选列表为空')
  await products[0].tap()
  await waitGone(sale, '.js-product-item')

  await tapWhen(sale, '.js-customer-picker')
  await sale.waitFor('.js-customer-item')
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
  await sale.waitFor(async function () {
    const data = await sale.data()
    return data && data.cart && data.cart.length > 0
  })

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
  await sale.waitFor('.js-slip')

  const title = await textOf(sale, '.js-slip-title')
  assert.ok(title.indexOf('送货单') >= 0, '送货单标题不对: ' + title)
  const productName = await textOf(sale, '.js-slip-product')
  assert.ok(productName.length > 0, '送货单没有商品名')
  const customerName = await textOf(sale, '.js-slip-customer')
  assert.ok(customerName.length > 0, '送货单没有收货人')
  const paidText = await textOf(sale, '.js-slip-paid')
  assert.strictEqual(paidText.replace(/\s/g, ''), '¥0.00')
  const shopName = await textOf(sale, '.js-slip-shop')
  assert.ok(shopName.indexOf('测试店') >= 0, '送货单没有店名: ' + shopName)
  const operator = await textOf(sale, '.js-slip-operator')
  assert.ok(operator.indexOf('测试店主') >= 0, '送货单没有经手人: ' + operator)
  assert.ok(operator.indexOf('ui-test-openid') < 0, '送货单不应印 openid: ' + operator)

  await tap(sale, '.js-slip-close')
  await waitGone(sale, '.js-slip')
}

async function runRecordSlipExport(miniProgram) {
  step('流水：打开销售记录，默认只读，再次打开送货单')
  const records = await miniProgram.navigateTo('/pages/records/records')
  await records.waitFor('.js-record-out')
  const items = await records.$$('.js-record-out')
  assert.ok(items.length > 0, '流水里没有销售记录')
  await items[0].tap()

  await records.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('record-edit') >= 0, '未进入流水详情: ' + edit.path)
  await edit.waitFor('.js-edit')
  let pageData = await edit.data()
  assert.strictEqual(pageData.editing, false, '进入详情就进入了修改')
  const saveBefore = await edit.$$('.js-save')
  assert.strictEqual(saveBefore.length, 0, '未点修改就出现了保存')
  await edit.waitFor('.js-export-slip')
  await tap(edit, '.js-export-slip')
  await edit.waitFor('.js-slip')
  const title = await textOf(edit, '.js-slip-title')
  assert.ok(title.indexOf('送货单') >= 0, '再次导出时送货单标题不对: ' + title)
  const shopName = await textOf(edit, '.js-slip-shop')
  assert.ok(shopName.indexOf('测试店') >= 0, '再次导出没有店名: ' + shopName)
  const operator = await textOf(edit, '.js-slip-operator')
  assert.ok(operator.indexOf('测试店主') >= 0, '再次导出没有经手人: ' + operator)
  assert.ok(operator.indexOf('ui-test-openid') < 0, '再次导出不应印 openid: ' + operator)
  await tap(edit, '.js-slip-close')
  await waitGone(edit, '.js-slip')

  step('流水：点修改后才能保存，取消回到详情')
  await tap(edit, '.js-edit')
  await edit.waitFor('.js-save')
  pageData = await edit.data()
  assert.strictEqual(pageData.editing, true, '点修改后仍不能改')
  await tap(edit, '.js-cancel')
  await edit.waitFor('.js-edit')
  pageData = await edit.data()
  assert.strictEqual(pageData.editing, false, '取消后没有回到详情')
  await miniProgram.navigateBack()
}

async function runOpeningSheet(miniProgram) {
  step('客户页：记期初欠款，弹出层并确认')
  const list = await miniProgram.switchTab('/pages/customers/customers')
  await list.waitFor('.js-customer-item')
  await tap(list, '.js-customer-item')

  await list.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('customer-edit') >= 0, '未进入客户编辑页: ' + edit.path)
  await edit.waitFor('.js-opening')
  await tapWhen(edit, '.js-opening')
  await edit.waitFor('.js-opening-sheet')
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
  await list.waitFor('.js-collect')
  await tap(list, '.js-collect')

  await list.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('customer-edit') >= 0, '未进入客户编辑页: ' + edit.path)
  await edit.waitFor('.js-pay-sheet')
  await tapWhen(edit, '.js-pay-submit')
  await waitGone(edit, '.js-pay-sheet')
}

async function runNativeClearModal(miniProgram) {
  step('店铺页：点清空（原生弹窗用 mock 自动确认）')
  // 上一步停在 customer-edit，直接 reLaunch 会超时，见 backToTabRoot。
  await backToTabRoot(miniProgram)
  const home = await miniProgram.reLaunch('/pages/index/index')
  await waitPageReady(home)
  await home.waitFor('.js-shop')
  await tap(home, '.js-shop')
  await home.waitFor(800)
  const shop = await miniProgram.currentPage()
  assert.ok(shop.path.indexOf('shop') >= 0, '未进入店铺页: ' + shop.path)
  await waitPageReady(shop)
  await shop.waitFor('.js-clear')
  await tap(shop, '.js-clear')
  await shop.waitFor(async function () {
    const data = await shop.data()
    return data && data.isEmpty === true
  })
  await miniProgram.navigateBack()
  const backHome = await miniProgram.currentPage()
  await waitPageReady(backHome)
  await backHome.waitFor('.js-seed')
}

async function run() {
  const cliPath = resolveCliPath()
  if (!cliPath) {
    throw new Error('找不到微信开发者工具的 cli，把环境变量 WECHAT_CLI 设成 cli.bat 的完整路径')
  }

  const autoPort = fixedPort || basePort
  await ensurePortFree(cliPath, autoPort)
  step('用 CLI 打开本仓库并开自动化端口 ' + autoPort + '：' + cliPath)
  await startAutoPort(cliPath, autoPort)

  patchCheckVersion()
  step('连接 ws://127.0.0.1:' + autoPort)
  const miniProgram = await connectMiniProgram(autoPort, connectTimeout)
  try {
    await miniProgram.mockWxMethod('showToast', {})
    await miniProgram.mockWxMethod('showModal', {
      confirm: true,
      cancel: false
    })
    await seedFromHome(miniProgram)
    await runSalePickerAndSlip(miniProgram)
    await runRecordSlipExport(miniProgram)
    await runOpeningSheet(miniProgram)
    await runPaySheet(miniProgram)
    await runNativeClearModal(miniProgram)
    console.log('ui tests passed')
  } finally {
    // 关掉这次自己开的那个工具窗口，端口跟着释放；不关的话下一次跑会往上顺延端口、
    // 窗口越堆越多。关失败不该盖掉测试本身的结论，所以吞掉异常。
    try {
      await miniProgram.close()
    } catch (error) {
      step('关闭开发者工具失败，可以手动关：' + (error && error.message ? error.message : error))
    }
  }
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
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
  console.error('6. 端口和超时可用 WECHAT_AUTOMATOR_PORT / _PORT_TIMEOUT / _CONNECT_TIMEOUT 覆盖')
  console.error('7. 工具刚打开项目时 Tool.getInfo 不带 SDKVersion，automator 的版本校验会崩，')
  console.error('   脚本里已经等它出现再校验')
  console.error('8. wx.showModal 是系统弹窗，自动化点不到内部按钮，脚本里用 mockWxMethod 自动确认')
  process.exit(1)
})
