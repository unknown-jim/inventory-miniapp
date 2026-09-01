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
// 整轮看门狗。2026-08-31 这一批把用例从 9 段加到 17 段（进货 / 退货 / 库存调整 /
// 换规格 / 商品详情 / 商品编辑 / 种类模板 / 建店成员），路由次数和页面加载都翻了倍，
// 15 分钟不够用了 —— 看门狗一开火，报的是「整轮 UI 用例超时」，指不出是哪一步，
// 排查成本比多等十分钟高得多。所以随用例规模一起抬。
const runTimeout = Number(process.env.WECHAT_AUTOMATOR_RUN_TIMEOUT || 1800000)
// 单次 automator.connect 的上限。要比 patchCheckVersion 里那 30 轮等待（最坏约 3 分钟）
// 宽，否则会把本来能连上的情况判死。
const connectAttemptTimeout = Number(process.env.WECHAT_AUTOMATOR_CONNECT_ATTEMPT_TIMEOUT || 240000)
const closeTimeout = Number(process.env.WECHAT_AUTOMATOR_CLOSE_TIMEOUT || 20000)
// 整个脚本的上限，比 runTimeout 再外面一层：runTimeout 只罩着用例本身，起端口和连接
// 这些前置步骤卡住时它根本没起跑。
const scriptTimeout = Number(process.env.WECHAT_AUTOMATOR_SCRIPT_TIMEOUT || 2700000)
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

// ---------------------------------------------------------------------------
// Windows 启动分支：**不经 cmd.exe / cli.bat**，直接 spawn 开发者工具的 Electron。
//
// 【老写法坏在哪】cli.bat 第 3 行是 `chcp 65001 >nul`，把控制台切到 UTF-8；文件本身
// 带一堆中文注释。某些机器状态下 cmd 会在切页处丢掉解析位置，把一行注释的后半截当命令
// 执行 —— 那半截正好以 `CLI` 开头（bat 里有 `set "CLI=%~dp0resources\...\index.js"`，
// 变量名就叫 CLI）。
//
// 【为什么「摘 PATH」这条老修复对现在这版无效】误解析发生在 bat 第 7 行 `cd /d "%~dp0"`
// **之后** —— 此刻 cwd 就是安装目录，而 cmd 解析裸命令时**先查当前目录、再查 PATH**。
// 于是 `CLI` 解析回同目录的 cli.bat 自己，无限递归，刷屏
// 「Maximum setlocal recursion level reached.」，端口永远起不来。
// 把安装目录从子进程 PATH 上摘掉**摘不掉 cwd 这一跳**，所以那条修复只在
// 「误解析发生在 cd 之前」或「cwd 不是安装目录」时才管用。
//
// 【顺带修正一处旧记载】旧注释和 docs/ui-test.md 都写着「cli.bat 是 GBK 编码的」。
// 2026-08-31 实测这台机器上的 cli.bat 是 **UTF-8**（前 64 字节里 `按` = e6 8c 89），
// CRLF 行尾。工具升级换过版本，所以「写一份 GBK 的等价 bat」那条绕法也是针对旧版的。
//
// 【复现状态，如实说】2026-08-31 在这台机器上**没能复现**递归风暴。直接跑
// `cli.bat --help` 五种组合（cwd=安装目录 / cwd=仓库根 × 安装目录在不在 PATH 上 ×
// 先 chcp 936 / 先 chcp 65001）全部干净退出，输出各 1841 字节，`setlocal recursion`
// 命中 0 次。所以下面这段**不是**"修一个复现过的 bug"，而是把 cmd.exe + .bat +
// 代码页 + `%~dp0` + PATH 这一整层已知脆弱面拿掉 —— cli.bat 一共只干三件事，
// 在 Node 里做完全等价，而且顺带绕掉了 Node 不许 spawn .bat 的那条限制。
// 老路仍然留着当兜底（下面 runCli 的 else 分支），并且在它的输出里认递归风暴，
// 把「刷屏 + 永不返回」变成一句指得出原因的报错。
//
// 【cli.bat 干的三件事】
//   ① 在安装目录里找那个 >50MB 的 Electron exe（排除 node.exe 等六个名字）
//   ② ELECTRON_RUN_AS_NODE=1，并把调用方的 CD 传成环境变量 cwd
//   ③ <electron> -e <BOOTSTRAP_JS> <安装目录>\resources\app.asar.unpacked\js\common\cli\index.js <args>
//
// 【参数从 cli.bat 里解析，不写死】写死就是转写，工具一升级就悄悄错（本项目已经
// 因为转写栽过好几次）。解析不出来才回落到下面这份内置默认值。用 latin1 读文件：
// 要匹配的 token 全是 ASCII，文件是 GBK 还是 UTF-8 都不影响，中文注释的字节掺不进来。
// ---------------------------------------------------------------------------

// 内置默认值：只有 cli.bat 读不到 / 格式变了才用得上。和 2026-08-31 实测的那版一致。
const CLI_FALLBACK = {
  bootstrap: "const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});"
    + 'if(!process.env.cwd)process.env.cwd=process.cwd();'
    + "process.argv=[process.execPath,'--ms-enable-electron-run-as-node',e,'--electron'].concat(a);require(e)",
  cliRel: path.join('resources', 'app.asar.unpacked', 'js', 'common', 'cli', 'index.js'),
  exeMin: 50000000,
  exeSkip: ['node.exe', 'node-18.exe', 'wxfilewatcher.exe', 'wxfilewatcher_x64.exe',
    'notification_helper.exe', 'wechatdevtools.exe']
}

// 解析 cli.bat 里那四样东西。任何一样解析不出来就整体回落，不做"半份解析半份默认"——
// 那样出错时分不清用的是哪一半。
function parseCliBat(cliPath) {
  let src = ''
  try {
    src = fs.readFileSync(cliPath, 'latin1')
  } catch (error) {
    return null
  }
  const bootstrap = (src.match(/set\s+"BOOTSTRAP_JS=([\s\S]*?)"\s*\r?\n/) || [])[1]
  const cliRel = (src.match(/set\s+"CLI=%~dp0([^"]*)"/) || [])[1]
  const exeMin = Number((src.match(/%%~zF\s+GTR\s+(\d+)/i) || [])[1])
  const exeSkip = []
  const re = /"%%~nxF"\s*==\s*"([^"]+)"/g
  let hit = null
  while ((hit = re.exec(src)) !== null) exeSkip.push(hit[1].toLowerCase())
  if (!bootstrap || !cliRel || !exeMin || !exeSkip.length) return null
  return { bootstrap: bootstrap, cliRel: cliRel, exeMin: exeMin, exeSkip: exeSkip }
}

// 解析一次就够，结论（走的哪条路、认出来的是哪个 exe）打进日志，产物里能核实。
let directLaunch
let directLaunchLogged = false

function resolveDirectLaunch(cliPath) {
  if (!isWindows) return { ok: false, why: '非 Windows，cli 本身就是可执行脚本' }
  if (process.env.WECHAT_CLI_DIRECT === '0') {
    return { ok: false, why: 'WECHAT_CLI_DIRECT=0，按要求强制走 cmd.exe + cli.bat 老路' }
  }
  const parsed = parseCliBat(cliPath)
  const spec = parsed || CLI_FALLBACK
  const from = parsed ? '从 cli.bat 解析' : '内置默认值（cli.bat 没解析出来）'
  const installDir = path.resolve(path.dirname(cliPath))
  const indexJs = path.join(installDir, spec.cliRel)
  if (!fs.existsSync(indexJs)) {
    return { ok: false, why: '找不到 CLI 入口 ' + indexJs }
  }
  let names = []
  try {
    names = fs.readdirSync(installDir)
  } catch (error) {
    return { ok: false, why: '读不到安装目录 ' + installDir + '：' + errText(error) }
  }
  const candidates = names.filter(function (name) {
    if (!/\.exe$/i.test(name)) return false
    if (spec.exeSkip.indexOf(name.toLowerCase()) >= 0) return false
    try {
      return fs.statSync(path.join(installDir, name)).size > spec.exeMin
    } catch (error) {
      return false
    }
  })
  if (!candidates.length) {
    return { ok: false, why: '安装目录里没有 >' + spec.exeMin + ' 字节的 Electron exe（排除表 '
      + spec.exeSkip.join('/') + '）' }
  }
  return {
    ok: true,
    installDir: installDir,
    electron: path.join(installDir, candidates[0]),
    indexJs: indexJs,
    bootstrap: spec.bootstrap,
    note: from + '；exe 候选 ' + JSON.stringify(candidates)
  }
}

function directLaunchFor(cliPath) {
  if (directLaunch === undefined) {
    directLaunch = resolveDirectLaunch(cliPath)
  }
  if (!directLaunchLogged) {
    directLaunchLogged = true
    if (directLaunch.ok) {
      step('CLI 走直接调用（不经 cmd.exe / cli.bat）：' + directLaunch.electron
        + '（' + directLaunch.note + '）')
    } else {
      step('CLI 回落到 cmd.exe + cli.bat 老路：' + directLaunch.why)
    }
  }
  return directLaunch
}

// Node 从 18.20.2 / 20.12.2（CVE-2024-27980 的修复）起不再允许不带 shell 地 spawn
// .bat / .cmd，会直接抛 EINVAL。automator 的 launch() 正是这么拉起 cli.bat 的，
// 而且它把这个 spawn 错误转述成「cliPath 不对」，把人往错方向带。所以不用 launch()。
// 直接调用这条路连 .bat 都不碰，那条限制自然不存在；兜底那条经 cmd.exe 走，也绕开了。
//
// 兜底路上仍然把安装目录从 PATH 上摘掉（childEnv）：它拦不住「cwd 那一跳」（见上），
// 但对「误解析发生在 cd /d 之前」的那种形态还是有用的，留着不亏。
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

// 递归风暴的字面签名。命中就当场报错，别让它刷满 portTimeout（3 分钟）再报一句
// 「等 cli auto 结束超时」——那句话完全指不出原因，上一个人就是这么被带偏的。
const RECURSION_SIGN = 'setlocal recursion level reached'

function runCli(cliPath, args) {
  const direct = directLaunchFor(cliPath)
  let command
  let commandArgs
  let options
  if (direct.ok) {
    command = direct.electron
    commandArgs = ['-e', direct.bootstrap, direct.indexJs].concat(args)
    options = {
      // cli.bat 是 `set "cwd=%CD%"` 之后才 `cd /d "%~dp0"` 的：工作目录换成安装目录，
      // 但把调用方的 CD 留在环境变量 cwd 里给 bootstrap 用。这里照抄这个语义 ——
      // 少设 cwd 这个环境变量的话，bootstrap 里那句 `if(!process.env.cwd)` 会把
      // 安装目录当成调用方目录。
      cwd: direct.installDir,
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        cwd: process.cwd()
      })
    }
  } else {
    command = isWindows ? (process.env.ComSpec || 'cmd.exe') : cliPath
    commandArgs = isWindows ? ['/c', cliPath].concat(args) : args
    options = { env: childEnv(cliPath) }
  }
  const chunks = []
  const started = {
    error: null,
    exitCode: null,
    recursion: false,
    direct: !!direct.ok,
    output: function () {
      const text = chunks.join('').trim()
      return text ? '\nCLI 输出：\n' + text : ''
    }
  }
  const child = childProcess.spawn(command, commandArgs, Object.assign({
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }, options))
  started.child = child
  liveCli.add(started)
  // 进度和 √ auto 都走 stderr，出错时要一起打出来。
  const take = function (chunk) {
    const text = String(chunk)
    // 刷屏时别把几十 MB 全攒在内存里，前 200 段够看清是什么了。
    if (chunks.length < 200) chunks.push(text)
    if (text.toLowerCase().indexOf(RECURSION_SIGN) >= 0) started.recursion = true
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
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
    // 递归风暴不会自己结束，等满 portTimeout 只会换来一句指不出原因的「超时」。
    // 只可能出现在 cmd.exe + cli.bat 那条兜底路上——直接调用根本不经 cmd 解析。
    if (started.recursion) {
      throw new Error('cli ' + label + ' 撞上了 cli.bat 的 setlocal 递归风暴：cmd 在 chcp 之后'
        + '丢了解析位置，把注释后半截当命令跑，而那半截以 CLI 开头、又在 cd /d "%~dp0" 之后'
        + '（cwd = 安装目录，cmd 先查当前目录）于是解析回 cli.bat 自己。'
        + (started.direct
          ? '（本轮走的是直接调用，出现这句说明判断写错了，请贴现场）'
          : '（本轮回落到了 cmd.exe + cli.bat 老路。直接调用那条不经 cmd 解析，'
            + '看上面那行「CLI 回落到…」说明为什么没走成，把它修好即可绕开）')
        + started.output())
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

// ---------------------------------------------------------------------------
// 送货单弹层（components/slip-overlay）。
//
// 【这一段 2026-08-31 从「核对 data」升回了「核对渲染」】
// 之前组件开着 virtualHost，页面侧压根没有它的宿主节点：page.$$('.js-slip')、
// 'slip-overlay >>> .js-slip'、页面 selectComponent('slip-overlay') 实测**全是 0**，
// 所以那一版只能核对页面 data 里的 slip 对象。代价是明摆着的：组件模板里把
// {{slip.paidText}} 写成 {{slip.paid}} 这种绑定错误，**数据对、屏幕上不显示**，
// 那版用例一点反应都没有。
//
// 现在 virtualHost 摘掉了（理由写在 components/slip-overlay/index.js 里），页面上
// 有 <slip-overlay id="slip-overlay">，于是走和「记一笔」面板同一条路：
// 先 page.$('#slip-overlay') 拿 CustomElement，再**在这个实例上**查子元素。
//
// 【不要退回页面级的 '>>>'】排错清单 9b 记的就是这个坑：'>>>' 右边只吃单个简单
// 选择器，吃不下两级后代链时**不报错**，静默降级成宿主本身，返回 1 个错节点、
// text() 是整块拼成的一串 —— 绿着骗人。组件实例上的 $ / $$ 没有这个问题
//（automator out/Element.js：CustomElement extends Element，两个查询都以该元素
// 为作用域下发）。
// ---------------------------------------------------------------------------
async function slipHost(page) {
  const host = await page.$('#slip-overlay')
  if (!host) {
    throw new Error('页面 ' + page.path + ' 上找不到 #slip-overlay 宿主节点：'
      + '组件是不是又开了 virtualHost？开了页面侧就够不到弹层里的任何东西，'
      + '这条用例只能退回核对页面 data（见 components/slip-overlay/index.js 顶部那段）')
  }
  if (typeof host.$ !== 'function' || typeof host.$$ !== 'function') {
    throw new Error('#slip-overlay 拿到的不是自定义组件实例（没有 $ / $$）：'
      + 'automator 只在 nodeId 存在时才建 CustomElement，宿主节点可能没渲染出来')
  }
  return host
}

async function waitInSlip(host, selector, label) {
  const deadline = Date.now() + WAIT_TIMEOUT
  for (;;) {
    const el = await host.$(selector)
    if (el) return el
    if (Date.now() >= deadline) {
      throw new Error('等送货单里的元素超时（' + (label || selector) + '，选择器 '
        + selector + '，' + WAIT_TIMEOUT + 'ms）')
    }
    await sleep(300)
  }
}

// 弹出的判据是**两条都要**：页面 data 说开了，而且弹层根节点真的渲染出来了。
// 只等 data 的话，wx:if 那一层写错（showSlip 传不进组件）就查不出来。
async function waitSlipOpen(page, label) {
  await waitFor(page, async function () {
    const data = await page.data()
    return !!(data && data.showSlip && data.slip)
  }, label + '弹出（页面 data）')
  const host = await slipHost(page)
  await waitInSlip(host, '.js-slip', label + '弹层根节点渲染出来')
  return host
}

// 关闭走**点真的那颗按钮**，不再 callMethod('closeSlip')。
// callMethod 只证明页面方法好使，证不出「完成」这颗按钮接没接上 onClose →
// triggerEvent('close') → 页面 closeSlip 这条链；而组件抽出去之后，断的正是这种链
//（2026-08-18 的 bf8f6d7 就是这么断的）。
async function closeSlip(page, label) {
  const host = await slipHost(page)
  const btn = await waitInSlip(host, '.js-slip-close', label + '的「完成」按钮')
  await btn.tap()
  await waitFor(page, async function () {
    const data = await page.data()
    return data && data.showSlip === false
  }, label + '关闭')
  await waitFor(page, async function () {
    const list = await page.$$('#slip-overlay .js-slip')
    return list.length === 0
  }, label + '弹层节点消失')
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

// 屏幕上真的印出来的那几行，逐格和页面 data 里的 slip 对上。
// **这一条才是「核对渲染」**：assertSlip 只看数据，绑定写错它一点反应都没有。
async function assertSlipRendered(page, slip, label) {
  const host = await slipHost(page)
  const textOf = async function (selector, what) {
    const el = await waitInSlip(host, selector, label + ' 的' + what)
    return String(await el.text() || '').trim()
  }

  assert.strictEqual(await textOf('.js-slip-title', '标题'), '送货单',
    label + '：弹层标题不对')
  assert.strictEqual(await textOf('.js-slip-shop', '店名'), String(slip.shopName),
    label + '：屏幕上的店名和 data 里的 shopName 对不上')
  assert.strictEqual(await textOf('.js-slip-operator', '经手人'), String(slip.operatorText),
    label + '：屏幕上的经手人和 data 里的 operatorText 对不上')
  // 实收那格模板是 ¥{{slip.paidText}}，少了 ¥ 或者绑错字段都要在这里红。
  assert.strictEqual(await textOf('.js-slip-paid', '实收'), '¥' + String(slip.paidText),
    label + '：屏幕上的实收和 data 里的 paidText 对不上')
  if (slip.hasCustomer) {
    assert.strictEqual(await textOf('.js-slip-customer', '收货人'), String(slip.customerName),
      label + '：屏幕上的收货人和 data 里的 customerName 对不上')
  }

  const nameNodes = await host.$$('.js-slip-product')
  const onScreen = []
  for (let i = 0; i < nameNodes.length; i++) {
    onScreen.push(String(await nameNodes[i].text() || '').trim())
  }
  assert.deepStrictEqual(
    onScreen,
    slip.lines.map(function (line) { return String(line.productName) }),
    label + '：屏幕上的商品明细和 data 里的 lines 对不上（少一行 = wx:for 没渲染全，'
      + '顺序不同 = 绑错了字段）'
  )
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

// ---------------------------------------------------------------------------
// 「记一笔」面板（components/record-sheet）。
//
// 面板的状态全在自定义组件实例上 —— 页面 data 里只有一个 showRecordSheet，
// 五行动作、二级、三个 picker 的列表都在组件里。所以这里从宿主节点 #record-sheet
// 取组件实例，读它的 data，并**在这个实例上**查子元素。
//
// 【不要用页面级的 '>>>'】首跑就栽在这上面：'#record-sheet >>> .rs-row .rs-label'
// 返回 1 个节点，text() 是整个面板拼成的一串（含标题「记一笔」和底部「取消」）——
// 它**静默降级成了宿主本身**，不报错。'>>>' 右边只吃单个简单选择器，吃不了两级
// 后代链。排错清单 9 / 9b 记的是同一类坑的两面：开着 virtualHost = 页面侧根本没有宿主
// 节点（真的 0）；没开 = 宿主在、>>> 锚得上然后静默降级（返回错节点、绿着骗人）。
//
// 【为什么组件实例上就行】automator 源码 out/Element.js：
//     class CustomElement extends Element
//     async $(e){...this.send("Element.getElement",{selector:e})...}
//     async $$(e){...this.send("Element.getElements",{selector:e})...}
// 两个查询都以**该元素**为作用域下发，后代链正常。Element.create 在 nodeId 存在时
// 返回 CustomElement，自定义组件的宿主正是这种。
//
// 组件**没有开 virtualHost**，就是为了让这条路通。开了页面侧连宿主节点都没有：
// slip-overlay 曾经就是这么被逼得只能核对页面 data 的；2026-08-31 把它的 virtualHost
// 也摘了、加上 id="slip-overlay"，那条用例才升回核对渲染（见 slipHost 上方那段）。
// 谁要是给 record-sheet 加回 virtualHost，下面这些用例会立刻在 recordSheetHost
// 这一步报错，不会静默失效。
// ---------------------------------------------------------------------------

const MAIN_ROW_LABELS = ['销售', '进货', '收款', '退货', '库存修正']

async function recordSheetHost(page) {
  const host = await page.$('#record-sheet')
  if (!host) {
    throw new Error('页面 ' + page.path + ' 上找不到 #record-sheet 宿主节点：'
      + '组件是不是又开了 virtualHost？开了页面侧就够不到组件里的任何东西')
  }
  if (typeof host.$$ !== 'function' || typeof host.data !== 'function') {
    throw new Error('#record-sheet 拿到的不是自定义组件实例（没有 $$ / data）：'
      + 'automator 只在 nodeId 存在时才建 CustomElement，宿主节点可能没渲染出来')
  }
  return host
}

async function waitSheetData(host, predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT
  for (;;) {
    const data = await host.data()
    if (predicate(data)) return data
    if (Date.now() >= deadline) {
      throw new Error('等记一笔面板数据超时（' + label + '，' + WAIT_TIMEOUT + 'ms）')
    }
    await sleep(300)
  }
}

// 面板里的元素一律走这两个，别退回页面级选择器（理由见上面那段）。
async function waitInSheet(host, selector, label) {
  const deadline = Date.now() + WAIT_TIMEOUT
  for (;;) {
    const el = await host.$(selector)
    if (el) return el
    if (Date.now() >= deadline) {
      throw new Error('等面板里的元素超时（' + (label || selector) + '，选择器 '
        + selector + '，' + WAIT_TIMEOUT + 'ms）')
    }
    await sleep(300)
  }
}

async function tapInSheet(host, selector) {
  const el = await waitInSheet(host, selector, '出现 ' + selector)
  await el.tap()
}

// 面板里的输入框。**不能用 typeInto** —— 那个收的是 page，而面板是组件，host 上没有
// page.waitFor / page.data，实测抛 `page.waitFor is not a function`。
// 落值改用 waitSheetData（组件的 data），与 tapInSheet / waitInSheet 同一路。
async function typeInSheet(host, selector, value, label, field) {
  const el = await waitInSheet(host, selector, '出现 ' + selector + '（' + label + '）')
  await el.input(String(value))
  if (!field) return
  await waitSheetData(host, function (d) {
    return String(d[field]) === String(value)
  }, label + '：输入的「' + value + '」要落进面板 data.' + field)
}

// 空态在固定高外壳里垂直居中 —— **读计算样式，不读 wxss 文本**。
// 静态断言守不住这一格：看不见层叠（同规则后补 align-items: flex-start）、看不见注释
// （整条注释掉，「align-items: center」七个字仍在文本里）、也看不见 DOM 嵌套（给
// .rs-empty 外面套一层 view，wxss 一个字节都不用改）。四种绕法静态全绿，其中「注释掉」
// 连全套 UI 都绿，而居中已经彻底坏了。
//
// **三个 picker 都要跑这一遍**：只查商品那一格的话，单独给选客户套一层 view 能让全套
// 测试保持绿而那一格的居中没了 —— 实测过。
async function assertSheetEmptyCentered(miniProgram, host, label) {
  // 选择器只能用单一简单选择器：'.rs-picker-body > .rs-empty' 在组件查询这条通道上
  // 取不到（实测超时 15s），与 docs/ui-test.md 记的 `>>>` 那个坑同源。
  // 用 .rs-empty 安全：全仓库只在本组件出现 6 处、全在外壳内；三个 picker 是一条
  // wx:if/elif 链，每个外壳内 loading / 列表 / 空态也是一条链，同时刻只渲染一个。
  const nodes = await host.$$('.rs-empty')
  assert.strictEqual(nodes.length, 1,
    label + '：空结果时应当恰好有一个 .rs-empty，实为 ' + nodes.length + ' 个 —— 多于一个就量不准了')
  const el = nodes[0]
  const display = await el.style('display')
  const direction = await el.style('flex-direction')
  const align = await el.style('align-items')
  assert.strictEqual(String(display), 'flex',
    label + '：空态不是 flex 容器（实为 ' + display + '）—— align-items 在非 flex 容器上静默失效')
  // flex-direction 决定 align-items 的语义：row 下它管垂直，column 下它管水平、
  // 垂直改由 justify-content 管。不钉住方向，只钉 align-items 等于什么都没钉。
  // 这不是杜撰的风险：稿 11:79「要记预收…」那条待补的空态第二行进代码后空态就是两行，
  // 而「两行堆起来」最自然的写法正是加 flex-direction: column。
  assert.strictEqual(String(direction), 'row',
    label + '：空态的 flex-direction 是 ' + direction + ' —— 不是 row 的话 align-items 管的就不再是垂直方向')
  assert.strictEqual(String(align), 'center',
    label + '：空态没有垂直居中（align-items 实为 ' + align + '）：会贴在固定高外壳顶部')
  const body = await waitInSheet(host, '.rs-picker-body', label + ' 的固定高外壳')
  const bodyBox = await body.size()
  // **外壳高度要钉绝对值，不能只查相对关系。** 在 height: 640rpx 后面再加一行
  // height: 200rpx（层叠覆盖）时，「高度不变」「占满外壳」「行数溢出」「能滚」四条
  // 全都照样成立，静态正则也照样命中 640rpx 那几个字 —— 全套绿而列表区只剩三分之一。
  //
  // 但不能一律写死等于：稿 n-小屏让位 裁定「80vh 优先、320px 让位」，窗口不够高时
  // 这一块会被压。所以要**先分清是「被窗口压」还是「被人改小」**，判据是 sheet 有没有
  // 真顶到 80vh 上限：没顶到就必须严格等于稿值；顶到了才允许小于。
  // 只写「≤ 上限且 ≥ 一半」是不够的 —— 那样 height: 500rpx（缩水 19%）在没发生
  // 让位的机型上照样全绿。
  const screenWidth = await miniProgram.evaluate(function () {
    return wx.getSystemInfoSync().screenWidth   // rpx 的基准是屏幕宽，不是 windowWidth
  })
  const maxPx = screenWidth * 640 / 750
  const sheetEl = await waitInSheet(host, '.rs-sheet', label + ' 的面板本体')
  const sheetH = (await sheetEl.size()).height
  // 上限直接读计算样式，不自己算 windowHeight * 0.8：实测计算值 537.067px 而自算
  // 536.8px，差 0.27px，而总余量只有 3px —— 这个自造误差不该有；而且把 0.8 写死在
  // 测试里等于和 CSS 的 80vh 有了两份真相。
  const capPx = parseFloat(await sheetEl.style('max-height'))
  const squeezed = sheetH >= capPx - 2      // 顶到 80vh 才算发生让位
  // **面板其余部分要有预算**（稿 n-面板其余预算）。面板离上限只剩 3px，所以在标题下
  // 随手加一条两态都在的说明文字（wxss 一个字节不改）就会立刻顶到上限，把列表区从
  // 332px 压到 291px、丢掉 12%，而「让位」那条裁定会把它当成合规放行 —— 从数学上看
  // 它确实合规，区分不了「窗口矮」和「自己变胖」。换成「让位量 == 超出上限的量」那种
  // 会计恒等式也一样放行。所以预算必须单独钉：grabber + 标题 + searchbar + 取消
  // 预算 400rpx，当前用掉 389rpx，剩 11rpx。
  //
  // **留 11rpx 而不是卡死在 389**：标题那段高度是字体度量决定的（line-height: AUTO），
  // 换机型或基础库时行盒差 1px 是常事，卡死会变成代码没改也红 —— 而那种误红和
  // 「真的有人加了常驻元素」长得一模一样，最顺手的「修法」是把预算调大，于是这条
  // 裁定就被它自己的误红磨掉了。放宽不削弱它：X1 那个变异实测 474rpx，仍然红。
  const chromePx = sheetH - bodyBox.height
  const chromeBudgetPx = screenWidth * 400 / 750
  assert.ok(
    chromePx <= chromeBudgetPx,
    label + '：面板除列表区之外的部分超预算 —— 实测 ' + Math.round(chromePx)
      + 'px（' + Math.round(chromePx * 750 / screenWidth) + 'rpx），预算 '
      + Math.round(chromeBudgetPx) + 'px（400rpx）。要加常驻元素先看预算够不够，'
      + '不够得先减别的，不能默默吃掉列表区'
  )
  if (!squeezed) {
    assert.ok(
      Math.abs(bodyBox.height - maxPx) <= 2,
      label + '：没发生让位（面板 ' + Math.round(sheetH) + 'px < 上限 ' + Math.round(capPx)
        + 'px），外壳就必须是稿定的 640rpx —— 实测 ' + Math.round(bodyBox.height)
        + 'px，应为 ' + Math.round(maxPx) + 'px'
    )
  } else {
    // 让位下限：至少要能看见 3 行 + hint 才叫列表（--tap-min 88rpx × 3 + 32rpx）。
    // 不是拍脑袋的一半：实测等比模拟 375×667 是 248.7/320 = 78%，离这条线有余量。
    const floorPx = screenWidth * (3 * 88 + 32) / 750
    assert.ok(
      bodyBox.height >= floorPx,
      label + '：让位过头，外壳只剩 ' + Math.round(bodyBox.height) + 'px，'
        + '至少要放得下 3 行 + hint（' + Math.round(floorPx) + 'px）'
    )
    assert.ok(
      bodyBox.height <= maxPx + 2,
      label + '：外壳比稿定的 640rpx 还高 —— ' + Math.round(bodyBox.height) + 'px'
    )
  }
  assert.strictEqual(String(await body.style('flex-direction')), 'column',
    label + '：外壳必须竖排 —— 变横排的话 sum / hint / 列表会并排，面板明显坏掉')
  const box = await el.size()
  // 这一条同时覆盖「flex: 1 还在」和「内容没把外壳撑破」。
  assert.ok(
    Math.abs(box.height - bodyBox.height) <= 1,
    label + '：空态没有占满外壳（空态 ' + Math.round(box.height)
      + 'px vs 外壳 ' + Math.round(bodyBox.height) + 'px）'
      + ' —— 少了 flex: 1 的话空态只有自身一行高，居中的是它自己，照样贴顶'
  )
  step(label + ' 空态居中：display=' + display + ' direction=' + direction
    + ' align-items=' + align + '，占满外壳 ' + Math.round(box.height) + 'px')
}

async function sheetRowLabels(host) {
  const nodes = await host.$$('.rs-row .rs-label')
  const texts = []
  for (let i = 0; i < nodes.length; i++) {
    texts.push(String(await nodes[i].text() || '').trim())
  }
  return texts
}

async function assertSheetFitsWindow(miniProgram, host, where) {
  const windowHeight = await miniProgram.evaluate(function () {
    return wx.getSystemInfoSync().windowHeight
  })
  const el = await waitInSheet(host, '.rs-sheet', '面板本体')
  const size = await el.size()
  assert.ok(
    size.height <= windowHeight + 1,
    where + '：面板比可视区还高（' + Math.round(size.height) + 'px > ' + windowHeight
      + 'px），.rs-sheet 的 max-height 没夹住内容'
  )
}

async function closeRecordSheetIfOpen(page) {
  const data = await page.data()
  if (!data || data.showRecordSheet !== true) return
  const host = await recordSheetHost(page)
  await tapInSheet(host, '.js-rs-cancel')
  await waitForData(page, function (d) {
    return d && d.showRecordSheet === false
  }, '关掉面板')
}

// 每次都从「面板是关着的」起步：入口按钮在遮罩底下，automator 的 tap 是直接派事件、
// 不管有没有被盖住，面板开着时再点一次入口不会重置 step，后面等 step === 'main' 会挂死。
async function openRecordSheet(page, entrySelector, label) {
  await closeRecordSheetIfOpen(page)
  await tapWhen(page, entrySelector)
  await waitForData(page, function (d) {
    return d && d.showRecordSheet === true
  }, label + '：面板打开')
  const host = await recordSheetHost(page)
  await waitSheetData(host, function (d) {
    return d && d.step === 'main'
  }, label + '：面板停在一级')
  await waitInSheet(host, '.rs-sheet', label + '：出现 .rs-sheet')
  return host
}

// 放在 seedFromHome 之后、别的用例之前是**有意的**：收款 picker 只列有欠款的客户、
// 退货 picker 只列还能退的销售单，而 runPaySheet 会把欠款收干净、runOpeningSheet
// 会再加一笔期初。种子刚灌完那一刻是这两个 picker 唯一确定的前提。
// 全程只看不提交：进到落点页确认一眼就退回来，不动账。
async function runRecordSheet(miniProgram) {
  step('看板：点「＋ 记一笔」开面板，核对五行动作的文案与顺序')
  let home = await goto(miniProgram, 'switchTab', '/pages/index/index', '看板')
  await waitPageReady(home)
  const host = await openRecordSheet(home, '.js-record-entry', '看板入口')

  const labels = await sheetRowLabels(host)
  assert.deepStrictEqual(
    labels,
    MAIN_ROW_LABELS,
    '面板一级五行的文案或顺序和设计稿 sheet/记一笔(7:165) 对不上，渲染出来的是 '
      + JSON.stringify(labels)
  )
  await assertSheetFitsWindow(miniProgram, host, '一级面板')

  step('面板：三条关闭通道（底部取消 / 点遮罩 / grabber 下滑）')
  await tapInSheet(host, '.js-rs-cancel')
  await waitForData(home, function (d) {
    return d && d.showRecordSheet === false
  }, '「取消」关掉面板')

  const maskHost = await openRecordSheet(home, '.js-record-entry', '重开')
  await tapInSheet(maskHost, '.js-rs-mask')
  await waitForData(home, function (d) {
    return d && d.showRecordSheet === false
  }, '点遮罩关掉面板')

  await runRecordSheetGrabber(miniProgram, home)

  step('面板 › 库存修正：展开二级（稿 4:31 三行，全在）')
  const adjHost = await openRecordSheet(home, '.js-record-entry', '库存修正')
  await tapInSheet(adjHost, '.js-rs-adjust')
  await waitSheetData(adjHost, function (d) {
    return d && d.step === 'adjust'
  }, '展开库存修正二级')
  const options = await adjHost.$$('.rs-option')
  // 稿 sheet/库存修正 4:31 是三行：换格加工 4:34、数量 4:37、盘点 4:1156。
  // B4 批把第三行的落点 pages/stock-take 建出来之后，原先「整行不画」的偏差解除。
  assert.strictEqual(
    options.length,
    3,
    '库存修正二级应当是三行（稿 4:31）：实际渲染出 ' + options.length + ' 行'
  )

  home = await runRecordSheetPayPicker(miniProgram, home)
  home = await runRecordSheetReturnPicker(miniProgram, home)
  home = await runRecordSheetProductPicker(miniProgram, home)
  await runRecordSheetFabEntry(miniProgram)
}

// grabber 下滑。走 Element.touchstart / touchend 而**不是** element.trigger：
// automator 源码 out/Element.js 里 trigger 只塞 detail
//     async trigger(e,t){const s={type:e};isUndef(t)||(s.detail=t);...}
// 带不了 touches / changedTouches，而组件的判据读的正是这两个顶层字段。
// touchstart(e={}) / touchend(e={}) 是把整个对象直接下发的，能带。
// 万一工具那侧仍然不认，退回直接调组件方法验判据本身，并如实记下走的是哪条路；
// 「bindtouchstart 到底有没有接上 onGrabStart」由 tests/record-sheet.test.js 静态钉着。
async function runRecordSheetGrabber(miniProgram, home) {
  const host = await openRecordSheet(home, '.js-record-entry', '重开')
  const grabber = await waitInSheet(host, '.rs-grabber-wrap', 'grabber')
  const from = { identifier: 0, pageX: 187, pageY: 400, clientX: 187, clientY: 400 }
  const to = { identifier: 0, pageX: 187, pageY: 560, clientX: 187, clientY: 560 }
  let closedBy = ''
  try {
    await grabber.touchstart({ touches: [from], changedTouches: [from] })
    await grabber.touchend({ touches: [], changedTouches: [to] })
    await waitForData(home, function (d) {
      return d && d.showRecordSheet === false
    }, 'grabber 下滑关掉面板')
    closedBy = 'touchstart/touchend 派真事件'
  } catch (error) {
    await host.callMethod('onGrabStart', { touches: [from] })
    await host.callMethod('onGrabEnd', { changedTouches: [to] })
    await waitForData(home, function (d) {
      return d && d.showRecordSheet === false
    }, 'grabber 下滑关掉面板（callMethod 兜底）')
    closedBy = 'callMethod 直调（工具侧没把 changedTouches 带进事件）'
  }
  step('grabber 下滑关闭：验到了，走的是 ' + closedBy)
}

async function runRecordSheetPayPicker(miniProgram, home) {
  step('面板 › 收款：只列有欠款的客户、按欠款倒序，点一行进该客户的收款态')
  const host = await openRecordSheet(home, '.js-record-entry', '收款')
  await tapInSheet(host, '.js-rs-pay')
  const data = await waitSheetData(host, function (d) {
    return d && d.step === 'customer' && d.loading === false
  }, '收款 picker 读完客户')

  assert.ok(
    data.customers && data.customers.length > 0,
    '收款 picker 是空的：种子里应当有欠款客户（runPaySheet 靠的是同一个前提）'
  )
  data.customers.forEach(function (item) {
    assert.ok(
      Number(item.receivable) > 0,
      '收款 picker 列出了没有欠款的客户「' + item.name + '」，设计稿 n8 明写只列有欠款的'
    )
  })
  for (let i = 1; i < data.customers.length; i++) {
    assert.ok(
      Number(data.customers[i - 1].receivable) >= Number(data.customers[i].receivable),
      '收款 picker 没有按欠款从多到少排：' + JSON.stringify(data.customers.map(function (c) {
        return [c.name, c.receivable]
      }))
    )
  }

  // 选客户 picker 的空态也要查一遍。只查商品那一格是不够的：单独给选客户的空态
  // 套一层 view（wxss 零改动）能让全套测试保持绿而这一格的居中已经没了 —— 实测过。
  // 选客户是稿点名的两个带搜索框 picker 之一，也是最初报「面板会跳」的那个场景。
  const payHeightWithRows = (await (await waitInSheet(host, '.rs-picker-body', '选客户外壳')).size()).height
  await typeInSheet(host, '.js-rs-customer-search', 'zzz绝不匹配zzz', '选客户搜索（空结果）', 'customerKeyword')
  await waitSheetData(host, function (d) {
    return d && d.customers && d.customers.length === 0
  }, '选客户 picker 搜到零结果')
  const payHeightWhenEmpty = (await (await waitInSheet(host, '.rs-picker-body', '选客户外壳（空结果）')).size()).height
  assert.ok(
    Math.abs(payHeightWhenEmpty - payHeightWithRows) <= 1,
    '选客户 picker 搜不到结果时面板高度变了：有结果 ' + Math.round(payHeightWithRows)
      + 'px → 空结果 ' + Math.round(payHeightWhenEmpty) + 'px'
  )
  await assertSheetEmptyCentered(miniProgram, host, '选客户 picker')
  // 关键词还回去，下面要按顺序点第一个客户，不能停在空列表上
  await typeInSheet(host, '.js-rs-customer-search', '', '选客户清空搜索', 'customerKeyword')
  await waitSheetData(host, function (d) {
    return d && d.customers && d.customers.length > 0
  }, '选客户清空搜索后恢复')

  await tapInSheet(host, '.js-rs-customer')
  const detail = await waitForPage(miniProgram, 'pages/customer-detail/customer-detail', '客户详情页')
  await waitPageReady(detail)
  // 落点带的是 ?id=<客户id>&pay=1，收款层应当自己打开。不提交，看一眼就退。
  await waitFor(detail, '.js-pay-sheet', '收款层自动打开')
  return await goBackTo(miniProgram, '看板')
}

async function runRecordSheetReturnPicker(miniProgram, home) {
  step('面板 › 退货：只列还能退的销售单，点一行进退货页并带出原单行')
  const host = await openRecordSheet(home, '.js-record-entry', '退货')
  await tapInSheet(host, '.js-rs-return')
  const data = await waitSheetData(host, function (d) {
    return d && d.step === 'order' && d.loading === false
  }, '退货 picker 读完销售单')

  assert.ok(
    data.orders && data.orders.length > 0,
    '退货 picker 是空的：种子里 4 张销售单一张都没退过，应当全部可退'
  )
  data.orders.forEach(function (row) {
    // 退过一部分标「可退 N 件」，从未退过只说「未退过」（设计稿 n5）
    assert.ok(
      /可退 \d/.test(row.returnText) || row.returnText.indexOf('未退过') >= 0,
      '退货行第三行既不是「可退 N 件」也不是「未退过」：' + row.returnText
    )
    assert.ok(row.subText.indexOf('销售单 ') >= 0, '退货行缺单号：' + row.subText)
  })

  await tapInSheet(host, '.js-rs-order')
  const ret = await waitForPage(miniProgram, 'pages/sale-return/sale-return', '退货页')
  // 稿上 n5：先选原单再退，不开空白退货单。带不出原单行就等于开了空白单。
  await waitForData(ret, function (d) {
    return d && d.lines && d.lines.length > 0
  }, '退货页带出了原单行')
  return await goBackTo(miniProgram, '看板')
}

async function runRecordSheetProductPicker(miniProgram, home) {
  step('面板 › 库存修正 › 数量对不上：先选商品，并量一下 picker 列表有没有被 max-height 夹住')
  const host = await openRecordSheet(home, '.js-record-entry', '数量对不上')
  await tapInSheet(host, '.js-rs-adjust')
  await waitSheetData(host, function (d) {
    return d && d.step === 'adjust'
  }, '进二级')
  await tapInSheet(host, '.js-rs-qty')
  const data = await waitSheetData(host, function (d) {
    return d && d.step === 'product' && d.loading === false
  }, '商品 picker 读完商品')
  assert.ok(data.products && data.products.length > 0, '商品 picker 是空的')

  // .rs-list 用的是 max-height 而不是仓库惯用的固定 height —— 这是本 PR 自己标出来的
  // 风险点。量真实渲染高度来判，不去猜 rpx 怎么换算。
  const baseList = await waitInSheet(host, '.rs-list', 'picker 列表')
  const baseSize = await baseList.size()
  const baseRows = await host.$$('.rs-pick')
  step('picker 列表（种子原样）：' + baseRows.length + ' 行，容器 '
    + Math.round(baseSize.height) + 'px')

  // 种子只有 6 个商品、合计约 270px，撑不破 640rpx 的上限 —— 首轮跑出来的结论就是
  // 「max-height 这一档没被验到」。所以这里临时把商品表塞长，把它真正验掉，
  // **验完原样还回去**：后面 runSalePickerAndSlip 要按顺序点第一个商品，
  // 不能被假商品污染。内存模式下 store.getProducts() 每次直接读 inv_products，
  // 所以塞完调一次组件的 refreshProducts 就能重新读到。
  const savedProducts = await miniProgram.evaluate(function (n) {
    const before = wx.getStorageSync('inv_products') || []
    const extra = []
    for (let i = 0; i < n; i++) {
      extra.push({ id: 'ui-fill-' + i, name: '撑高用商品 ' + i })
    }
    wx.setStorageSync('inv_products', before.concat(extra))
    return before
  }, 24)
  try {
    await host.callMethod('refreshProducts')
    const padded = await waitSheetData(host, function (d) {
      return d && d.products && d.products.length > baseRows.length
    }, '商品表塞长后 picker 重新读到')

    const listEl = await waitInSheet(host, '.rs-list', 'picker 列表')
    const listSize = await listEl.size()
    const rows = await host.$$('.rs-pick')
    let rowSum = 0
    for (let i = 0; i < rows.length; i++) {
      rowSum += (await rows[i].size()).height
    }
    assert.ok(
      rowSum > listSize.height + 1,
      'picker 列表没被 max-height 夹住：' + rows.length + ' 行合计 ' + Math.round(rowSum)
        + 'px，容器却有 ' + Math.round(listSize.height) + 'px —— 列表会把面板顶穿'
    )
    // 夹住之后还得真的能滚，否则被夹掉的那些行永远点不到。
    // scrollHeight 只有 ScrollViewElement 才有（automator out/Element.js 按 tagName 分发）；
    // 拿不到就如实记一句，不假装验过。
    let scrollNote = '（scrollHeight 取不到，没验滚动）'
    if (typeof listEl.scrollHeight === 'function') {
      const scrollHeight = await listEl.scrollHeight()
      assert.ok(
        scrollHeight > listSize.height + 1,
        'picker 列表夹住了却滚不动：scrollHeight ' + Math.round(scrollHeight)
          + 'px 不大于可视高 ' + Math.round(listSize.height) + 'px'
      )
      scrollNote = '，scrollHeight ' + Math.round(scrollHeight) + 'px —— 能滚'
    }
    await assertSheetFitsWindow(miniProgram, host, '商品 picker（' + padded.products.length + ' 行）')
    step('picker 列表结论：' + rows.length + ' 行合计 ' + Math.round(rowSum)
      + 'px，容器夹到 ' + Math.round(listSize.height) + 'px' + scrollNote)

  } finally {
    // 还原必须在 finally 里：上面任何一条断言挂掉都不能把假商品留给后面的用例
    await miniProgram.evaluate(function (before) {
      wx.setStorageSync('inv_products', before)
    }, savedProducts)
    await host.callMethod('refreshProducts')
    await waitSheetData(host, function (d) {
      return d && d.products && d.products.length === baseRows.length
    }, '商品表还原')
  }

  // 搜不到结果时面板高度不许变（稿 UX注释/骨架 的 n-picker列表高）。
  // 这一条是本批真正要防的回归：静态断言只能守「写法对不对」，守不住「高度真的没变」。
  // 之前 .rs-list 只有 max-height，搜空时整个列表分支被 wx:elif 跳过、换成一行 rs-empty，
  // 面板从满高塌成一行；而 sheet 从底部升起，塌陷会把上面的搜索框一起往下拽 ——
  // 手指还在键盘上，面板在底下跳。
  const bodyBefore = await waitInSheet(host, '.rs-picker-body', 'picker 固定高外壳')
  const heightWithRows = (await bodyBefore.size()).height
  await typeInSheet(host, '.js-rs-product-search', 'zzz绝不匹配zzz', '商品 picker 搜索（空结果）', 'productKeyword')
  await waitSheetData(host, function (d) {
    return d && d.products && d.products.length === 0
  }, '商品 picker 搜到零结果')
  const emptyRow = await host.$$('.rs-pick')
  assert.strictEqual(emptyRow.length, 0, '搜到零结果时不该还剩商品行')
  const bodyAfter = await waitInSheet(host, '.rs-picker-body', 'picker 固定高外壳（空结果）')
  const heightWhenEmpty = (await bodyAfter.size()).height
  assert.ok(
    Math.abs(heightWhenEmpty - heightWithRows) <= 1,
    'picker 搜不到结果时面板高度变了：有结果 ' + Math.round(heightWithRows)
      + 'px → 空结果 ' + Math.round(heightWhenEmpty) + 'px。'
      + '外壳 .rs-picker-body 必须固定高罩住 loading / 列表 / 空态三个分支'
  )
  step('picker 空结果高度不变：' + Math.round(heightWithRows) + 'px → '
    + Math.round(heightWhenEmpty) + 'px')

  await assertSheetEmptyCentered(miniProgram, host, '商品 picker')
  // 关键词还回去，后面的用例按顺序点第一个商品，不能停在空列表上
  await typeInSheet(host, '.js-rs-product-search', '', '商品 picker 清空搜索', 'productKeyword')
  await waitSheetData(host, function (d) {
    return d && d.products && d.products.length > 0
  }, '商品 picker 清空搜索后恢复')

  await tapInSheet(host, '.js-rs-product')
  const adjust = await waitForPage(miniProgram, 'pages/adjust/adjust', '库存调整页')
  // adjust 不带 id 会 toast「请从商品编辑进入」再退回来。能停在这一页并且拿到
  // productId，才证明 picker 真的把商品带过去了 —— 这正是简报原方案会死掉的地方。
  await waitForData(adjust, function (d) {
    return d && d.productId
  }, '调整页拿到了 productId')
  return await goBackTo(miniProgram, '看板')
}

async function runRecordSheetFabEntry(miniProgram) {
  step('流水页：右下角 FAB 打开的是同一张面板')
  // 流水在 A3 批升成了 tab 页，只能 switchTab（navigateTo 到 tab 页会直接 fail）。
  const records = await goto(miniProgram, 'switchTab', '/pages/records/records', '流水页')
  await waitFor(records, '.js-record-fab', '出现 .js-record-fab')
  const host = await openRecordSheet(records, '.js-record-fab', '流水页 FAB')
  const labels = await sheetRowLabels(host)
  assert.deepStrictEqual(
    labels,
    MAIN_ROW_LABELS,
    '流水页 FAB 打开的面板和看板那张不一致（两个入口必须是同一个组件）：' + JSON.stringify(labels)
  )
  await tapInSheet(host, '.js-rs-cancel')
  await waitForData(records, function (d) {
    return d && d.showRecordSheet === false
  }, '流水页关掉面板')
  // 上一步是 switchTab 进流水，栈深恒为 1，没有「上一页」可退——回看板同样要 switchTab。
  await goto(miniProgram, 'switchTab', '/pages/index/index', '看板')
}

async function runSalePickerAndSlip(miniProgram) {
  step('销售：点选商品、客户，一分未收出库，核对送货单')
  // 销售已撤出 tabBar，走 navigateTo。它不像 switchTab 会重置页面栈，所以先退回
  // tab 根再进，保持和改版前一样的"从干净栈进入"前提（上一段停在进货页上）。
  await backToTabRoot(miniProgram)
  const sale = await goto(miniProgram, 'navigateTo', '/pages/sale/sale', '销售页')
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

  // 6a 批：实收搬进 sheet（稿 bottom-cta 4:112 的实收摘要行点开 sheet/实收修改 7:25）。
  await tapWhen(sale, '.js-paid-row')
  await waitFor(sale, '.js-paid-none', '出现 .js-paid-none')

  // 默认收满：实收（现金）+ 预收抵扣 == 应收。**不能直接断言 paidAmount === amountText**
  // ——这个客户如果有预收余额，抵扣默认是开着的，现金那一格就只有差额（G1 契约
  // n-预收抵扣 7:428「刚打开实收 sheet 默认抵扣开」）。
  const fullPaid = await sale.data()
  assert.strictEqual(
    Math.round((Number(fullPaid.paidAmount) + Number(fullPaid.prepayUsed)) * 100),
    Math.round(Number(fullPaid.amountText) * 100),
    '默认收满时 实收 + 预收抵扣 应当等于应收：' + fullPaid.paidAmount + ' + ' + fullPaid.prepayUsed + ' vs ' + fullPaid.amountText
  )
  assert.strictEqual(fullPaid.hasNewDebt, false)
  assert.strictEqual(fullPaid.paidOver, false, '默认收满不该判成超收')

  // 点「一分未收」：欠款等于应收减掉预收抵扣（没有抵扣时就是整单应收）
  await tapWhen(sale, '.js-paid-none')
  await sale.waitFor(200)
  const nonePaid = await sale.data()
  assert.strictEqual(nonePaid.paidAmount, '0')
  assert.strictEqual(nonePaid.hasNewDebt, true)
  assert.strictEqual(nonePaid.debtText, nonePaid.cashDueText, '一分未收时欠款应当等于「收满」那个数')

  await tapWhen(sale, '.js-paid-confirm')
  await waitGone(sale, '.js-paid-none')

  await tapWhen(sale, '.js-sale-submit')
  const slipHostEl = await waitSlipOpen(sale, '送货单')
  const slip = (await sale.data()).slip
  assertSlip(slip, '送货单')
  assert.strictEqual(slip.paidText, '0.00', '送货单实收不对: ' + slip.paidText)
  await assertSlipRendered(sale, slip, '送货单')

  // 本批新增：导出样式二选一（chip「汇总」/「明细」），紧挨导出图片按钮上方。
  // 这单挑的客户是本轮测试临时建出来的，customerId 随机（uid()），不可能带着
  // 别的运行留下的记忆，所以「刚打开没记忆时默认汇总」这条断言是稳的。
  const summaryChip = await waitInSlip(slipHostEl, '.js-slip-style-summary', '送货单的导出样式「汇总」chip')
  const detailChip = await waitInSlip(slipHostEl, '.js-slip-style-detail', '送货单的导出样式「明细」chip')
  assert.ok(summaryChip, '找不到导出样式「汇总」chip')
  assert.ok(detailChip, '找不到导出样式「明细」chip')
  assert.strictEqual((await sale.data()).exportStyle, 'summary', '没有记忆时导出样式应默认「汇总」')

  await detailChip.tap()
  await waitFor(sale, async function () {
    const data = await sale.data()
    return data && data.exportStyle === 'detail'
  }, '点「明细」chip 后页面 data.exportStyle 变成 detail')

  await summaryChip.tap()
  await waitFor(sale, async function () {
    const data = await sale.data()
    return data && data.exportStyle === 'summary'
  }, '点回「汇总」chip 后页面 data.exportStyle 变成 summary')

  await closeSlip(sale, '送货单')
}

// 销售页规格多选 + 批量填数（批 2/2026-09-02）。种子里的「短袖 T恤」两轴都有 >= 2 个
// 取值（黑色/白色 × M/L），是这批要测的形态：颜色单选、尺码可多选。
//
// 【为什么放在 runSaleReturn 之后】本用例最后会真的提交一单，让它成为账本里最新的
// 「out」流水。runSaleReturn 用 latestOfType(records, 'out') 认定「最新销售单就是
// runSalePickerAndSlip 那张一分未收的」，插在两者中间会把这条前提改错；放在
// runSaleReturn 之后就不会撞见任何依赖「最新销售单是谁」的后续用例（全文只有
// runSaleReturn 这一处用 latestOfType）。
//
// 【为什么要走到真提交，不只测加入清单】H1 点名的风险路径是「填了一行没点加入清单、
// 直接点确认销售」——currentLine/mergeLine 改名之后最容易在 submit() 里留下悬空调用，
// 而 npm test 抓不到这类运行期 ReferenceError。所以本用例分两段：先走一次正常的
// 「选两格 → 全部填 → 改一格 → 加入清单」核对清单行数与合计，再填第二批**不点加入
// 清单**直接点确认销售，逼 submit() 自己走 currentLines() / mergeLines() 那条路。
async function runSaleMultiSelect(miniProgram) {
  step('销售：规格二多选批量填数——选两格/全部填/改一格/加入清单，再补一批不点加入清单直接确认销售（H1）')
  await backToTabRoot(miniProgram)
  const sale = await goto(miniProgram, 'navigateTo', '/pages/sale/sale', '销售页')
  await waitPageReady(sale)
  await waitFor(sale, '.js-product-picker', '出现 .js-product-picker')

  await tap(sale, '.js-product-picker')
  await typeInto(sale, '.search', '短袖', '商品搜索', 'keyword')
  await waitFor(sale, '.js-product-item', '出现 .js-product-item')
  const products = await sale.$$('.js-product-item')
  assert.strictEqual(products.length, 1, '搜索「短袖」应当只命中一件商品，实为 ' + products.length)
  await products[0].tap()
  await waitGone(sale, '.js-product-item')
  await waitForData(sale, function (d) {
    return String(d.productName || '').indexOf('短袖') >= 0
  }, '商品切到短袖 T恤')

  // 规格一先选颜色——n5 3:767 的级联：没选颜色，规格二禁用（pickSize / pickAllSizes
  // 里的守卫会直接吃掉点击，不选颜色的话下面两次点规格二都不会有任何效果）。
  await waitFor(sale, '.js-color-chip', '出现规格一 chips')
  await tapNth(sale, '.js-color-chip', 0, '规格一第一枚 chip（颜色）')
  await waitForData(sale, function (d) { return !!d.selectedColor }, '颜色选中')

  // 规格二选两格：第一次点还是既有单选形态（|Z| 0→1），第二次点才切多选（T4，|Z| 1→2）。
  // 两次都用同一个 .js-size-chip 钩子——单选/多选两套模板里都挂了它，不必关心此刻在哪个形态。
  await waitFor(sale, '.js-size-chip', '出现规格二 chips')
  await tapNth(sale, '.js-size-chip', 0, '规格二第一格')
  await waitForData(sale, function (d) {
    return d.selectedSizes.length === 1 && d.multiMode === false
  }, '选中第一格，仍是单选形态')
  await tapNth(sale, '.js-size-chip', 1, '规格二第二格')
  await waitForData(sale, function (d) {
    return d.multiMode === true && d.selectedSizes.length === 2
  }, '选中第二格后切到多选形态')

  const afterPick = await sale.data()
  assert.strictEqual(afterPick.cellRows.length, 2, '多选形态应当渲染两行逐格输入')
  const sizeValues = afterPick.selectedSizes.slice()

  // 「全部填 1」：两格都要落进 cellQtys（T8）。数量刻意压得很小——种子里
  // 黑色/L 只有 2 件现货，本用例后面还要再补一批直接提交，两批加起来不能超过它。
  await typeInto(sale, '.js-batch-qty', '1', '全部填', 'batchQty')
  await waitForData(sale, function (d) {
    return sizeValues.every(function (s) { return String(d.cellQtys[s]) === '1' })
  }, '全部填之后两格的草稿都变成 1')

  // 改第一格（M）为 3（T9：只改这一格，「全部填」框里的值留着当提示，不联动）。
  const cellInputsBefore = await sale.$$('.js-cell-qty')
  assert.strictEqual(cellInputsBefore.length, 2, '逐格应当渲染两个输入框，实为 ' + cellInputsBefore.length)
  await cellInputsBefore[0].input('3')
  await waitForData(sale, function (d) {
    return d.cellRows.length === 2 && d.cellRows[0].qtyText === '3' && d.cellRows[1].qtyText === '1'
  }, '第一格改成 3，第二格仍是全部填时的 1')
  assert.strictEqual((await sale.data()).batchQty, '1', 'T9：「全部填」框里的值应当留着，不因逐格改动被清空')

  // 加入清单：裁定 C 的 N = 有正数量的格数 = 2，按钮标签与合计行都要跟着。
  const beforeAdd = await sale.data()
  assert.strictEqual(beforeAdd.batchLineCount, 2, '本批 2 格都有正数量，batchLineCount 应为 2')
  assert.strictEqual(beforeAdd.addBtnLabel, '加入清单（2 行）')
  const beforeCartLen = beforeAdd.cart.length
  await tapWhen(sale, '.js-add-cart')
  await waitForData(sale, function (d) {
    return d.cart.length === beforeCartLen + 2
  }, '加入清单之后清单多了两行')

  const afterAdd = await sale.data()
  // T11：选中集合与单价保留，逐格草稿与「全部填」清空。
  assert.strictEqual(Object.keys(afterAdd.cellQtys || {}).length, 0, 'T11：加入清单之后逐格草稿应当清空')
  assert.strictEqual(afterAdd.batchQty, '', 'T11：加入清单之后「全部填」应当清空')
  assert.deepStrictEqual(afterAdd.selectedSizes.slice().sort(), sizeValues.slice().sort(),
    'T11：加入清单之后选中集合应当保留')
  const firstBatchLines = afterAdd.cart.slice(beforeCartLen)
  const skuIdBySize = {}
  const qtyBySkuId = {}
  firstBatchLines.forEach(function (item) {
    skuIdBySize[item.size] = item.skuId
    qtyBySkuId[item.skuId] = item.qty
  })
  assert.strictEqual(qtyBySkuId[skuIdBySize[sizeValues[0]]], 3, '第一格应当以 3 件入清单')
  assert.strictEqual(qtyBySkuId[skuIdBySize[sizeValues[1]]], 1, '第二格应当以 1 件入清单')

  // H1：再填一批但**不点加入清单**，直接选客户、走完实收 sheet、点「确认销售」——
  // currentLines() / mergeLines() 在 submit() 里要是悬空，这一步会直接炸掉。
  await typeInto(sale, '.js-batch-qty', '1', '全部填（第二批，不加入清单）', 'batchQty')
  await waitForData(sale, function (d) {
    return sizeValues.every(function (s) { return String(d.cellQtys[s]) === '1' })
  }, '第二批全部填 1 落进两格')

  await tapWhen(sale, '.js-customer-picker')
  await waitFor(sale, '.js-customer-item', '出现 .js-customer-item')
  const customers = await sale.$$('.js-customer-item')
  assert.ok(customers.length > 0, '客户点选列表为空')
  await customers[0].tap()
  await waitGone(sale, '.js-customer-item')

  await tapWhen(sale, '.js-paid-row')
  await waitFor(sale, '.js-paid-full', '出现 .js-paid-full')
  await tapWhen(sale, '.js-paid-full')
  await waitFor(sale, '.js-paid-confirm', '出现 .js-paid-confirm')
  await tapWhen(sale, '.js-paid-confirm')
  await waitGone(sale, '.js-paid-full')

  const beforeRecords = await readRecords(miniProgram)
  await tapWhen(sale, '.js-sale-submit')
  const record = await waitForNewRecord(miniProgram, 'out', beforeRecords,
    'H1：不点加入清单、直接确认销售（多选批量的第二批要在这里被 submit() 并进去）')
  assert.strictEqual(record.lines.length, 2,
    'H1 路径提交的这一单应当是两行（两格各一行），实为 ' + record.lines.length)
  const recordQtyBySkuId = {}
  record.lines.forEach(function (line) { recordQtyBySkuId[line.skuId] = line.qty })
  // 第二批（未点加入清单）1 件 + 第一批已经加入清单的那 3 / 1 件，同格累加（H7：
  // 同批两行落同一格由 mergeLines 的循环天然累加）。第二格两批合计正好吃满黑色/L
  // 全部 2 件现货，是刻意压到边界的（见上面选数量时的注释）。
  assert.strictEqual(recordQtyBySkuId[skuIdBySize[sizeValues[0]]], 3 + 1,
    '第一格应当把两批累加成 4 件')
  assert.strictEqual(recordQtyBySkuId[skuIdBySize[sizeValues[1]]], 1 + 1,
    '第二格应当把两批累加成 2 件')

  await waitSlipOpen(sale, '多选批量销售的送货单')
  await closeSlip(sale, '多选批量销售的送货单')
}

async function runRecordSlipExport(miniProgram) {
  step('流水：打开销售记录，默认只读，再次打开送货单')
  const records = await goto(miniProgram, 'switchTab', '/pages/records/records', '流水页')
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
  const reSlip = (await edit.data()).slip
  assertSlip(reSlip, '再次导出的送货单')
  await assertSlipRendered(edit, reSlip, '再次导出的送货单')
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
  step('客户页：进客户详情记期初欠款，弹出层并确认')
  const list = await goto(miniProgram, 'switchTab', '/pages/customers/customers', '客户页')
  await waitFor(list, '.js-customer-item', '出现 .js-customer-item')
  await tap(list, '.js-customer-item')

  // B9 起客户列表整行进的是**客户详情**（稿 n2 4:365：行内无按钮，收款 / 去销售在详情内）
  const detail = await waitForPage(miniProgram, 'pages/customer-detail/customer-detail', '客户详情页')
  await waitPageReady(detail)
  await waitFor(detail, '.js-opening', '出现 .js-opening')
  await tapWhen(detail, '.js-opening')
  await waitFor(detail, '.js-opening-sheet', '出现 .js-opening-sheet')
  const amount = await detail.$('.js-opening-amount')
  if (!amount) {
    throw new Error('找不到期初欠款金额输入框')
  }
  await amount.input('20')
  await tapWhen(detail, '.js-opening-submit')
  await waitGone(detail, '.js-opening-sheet')
  await trace(miniProgram, 'runOpeningSheet 结尾 navigateBack 之前')
  await goBackTo(miniProgram, '客户页')
  await trace(miniProgram, 'runOpeningSheet 结尾 navigateBack 之后')
}

async function runPaySheet(miniProgram) {
  step('客户页：进客户详情点收款，弹出收款层并确认')
  const list = await goto(miniProgram, 'switchTab', '/pages/customers/customers', '客户页')
  await waitPageReady(list)
  await waitFor(list, '.js-customer-item', '出现 .js-customer-item')
  // B9 起行内不再有「收款」按钮（稿 n2 4:365），收款在详情里。
  // 列表按欠款从多到少排（customers.js 的 refresh），第一行就是欠得最多的那位；
  // 这一步要提交一笔「收满」，所以先把这个前提断言出来，免得默认金额是 0、
  // 确认钮禁用、报出来的却是「等 .js-pay-sheet 消失超时」这种不着边的原因。
  const listData = await list.data()
  assert.ok(
    listData.list && listData.list.length && Number(listData.list[0].receivable) > 0,
    '客户页第一行应当是有欠款的客户（runRecordSheetPayPicker 靠的是同一个前提），实为 '
      + JSON.stringify((listData.list || []).slice(0, 3).map(function (c) {
        return [c.name, c.receivable]
      }))
  )
  await tap(list, '.js-customer-item')

  const detail = await waitForPage(miniProgram, 'pages/customer-detail/customer-detail', '客户详情页')
  await waitPageReady(detail)
  await tapWhen(detail, '.js-pay-open')
  await waitFor(detail, '.js-pay-sheet', '出现 .js-pay-sheet')
  await tapWhen(detail, '.js-pay-submit')
  await waitGone(detail, '.js-pay-sheet')
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
  const records = await goto(miniProgram, 'switchTab', '/pages/records/records', '流水页')
  await waitForData(records, function (data) { return data.loaded }, '流水页首屏加载完成')
  // 7a 批给流水页加了时间段 pill，默认「本月」（稿 UX注释 n8 4:839）。而这条
  // 用例的种子文档 createdAt = 1700000000000 起（2023-11-14，见 seedExtraPayDocs），
  // 落在本月之外。本用例验的是**分页不重不漏**，跟时间段无关，所以先切到「全部」。
  // 时间段选择走原生 wx.showActionSheet，automator 点不到里面的选项，
  // 所以直调页面方法 —— applyWindow 就是为这件事单独抽出来的。
  await records.callMethod('applyWindow', 'all')
  await waitForData(records, function (data) {
    return data.windowKey === 'all' && data.loaded && data.list.length > 0
  }, '切到「全部」时间段之后重新加载完成')
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
  // 总数正好是分页 limit 的整数倍时，翻到底那一次点击会拿到一页空结果——
  // 这不是 bug，是 cloudfunctions/ledger/ledger-records.js 里「游标翻页的
  // hasMore 判条数不判页数」这条已知设计权衡（注释见该文件 :34-40 / :464-468，
  // 仓库里同型的有界循环共享同一份取舍）。空页不会让列表变长，但服务端会正确地
  // 把 hasMore 翻成 false，所以等待条件要认「变长」或「hasMore 变 false」任一个。
  let guard = 0
  for (;;) {
    const data = await records.data()
    if (!data.hasMore) break
    await tap(records, '.js-load-more')
    await waitForData(records, function (d) {
      return d.list.length > data.list.length || !d.hasMore
    }, '点「加载更多」之后第二页追加或翻到底（上一次 ' + data.list.length + ' 条）')
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
  // 上一步是 switchTab 进流水，栈深恒为 1，没有「上一页」可退——回客户页同样要 switchTab。
  await trace(miniProgram, 'runRecordsLoadMore 结尾 switchTab 之前')
  await goto(miniProgram, 'switchTab', '/pages/customers/customers', '客户页')
  await trace(miniProgram, 'runRecordsLoadMore 结尾 switchTab 之后')
}

async function runCustomerLedgerLoadMore(miniProgram) {
  step('客户页：往来记录超过一页时手动「加载更多」兜底')
  const customerId = await miniProgram.evaluate(function () {
    const list = wx.getStorageSync('inv_customers') || []
    return list.length ? list[0].id : ''
  })
  assert.ok(customerId, '前提：示例数据里有客户')
  await seedExtraPayDocs(miniProgram, 30, customerId, 'cust')
  // B9：往来记录搬到了客户详情页。变量名保持 edit 不改，只为把本次 diff 收在两行内。
  const edit = await goto(miniProgram, 'navigateTo',
    '/pages/customer-detail/customer-detail?id=' + customerId, '客户详情页')
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
  // 上一步停在客户页（runCustomerLedgerLoadMore 结尾退过栈），直接 reLaunch 会超时，
  // 见 backToTabRoot。
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

// ===========================================================================
// 2026-08-31 这一批新增的覆盖：进货 / 退货 / 库存调整 / 换规格 / 商品详情 /
// 商品编辑 / 种类模板 / 建店与成员。
//
// 【每条的验收标准】进得去 + 主要字段渲染出来 + **提交后账面变化正确**。
// 「只断言页面能打开」的用例一条都不写 —— 那种绿是负资产。
//
// 【为什么账面要读 storage，而不是只读页面 data】页面 data 是屏幕上那一份，
// 提交之后页面可能还没刷新（多数页 onShow 才重读），拿它当账面是碰运气；
// 内存账本的 storage 才是权威。所以两边都断言：渲染看 DOM / 页面 data，
// 账面看 storage。只看其中一边，另一边坏了都是绿的。
// ===========================================================================

// ---- 取数小工具 ----------------------------------------------------------

// 【输入必须确认真的落进了页面 data】2026-08-31 首跑就栽在这上面：换规格那一步
// 输入完数量直接点提交，提交在页面里抛「改规格数量必须大于 0」被 toast 吞掉，
// 而那一步的完成信号写的是「等 qty 变回空」—— qty **压根没被写过**，判据当场为真，
// 用例一路绿着往下走，最后在 200 行之后的库存断言上以「源格没有减掉 1 件」告终，
// 完全看不出真正的原因在输入那一步。
//
// 所以：给得出字段名的调用点一律传 field，输入之后先确认 data[field] 变成了这个值，
// 落不进去就**在输入这一步**报错。这不是保险，是把失败点挪回它该在的地方。
async function typeInto(page, selector, value, label, field) {
  await waitFor(page, selector, '出现 ' + selector + '（' + label + '）')
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到输入框 ' + selector + '（' + label + '）')
  }
  await el.input(String(value))
  if (!field) return
  await waitForData(page, function (d) {
    return String(d[field]) === String(value)
  }, label + '：输入的「' + value + '」要落进页面 data.' + field
    + '（落不进去的话，后面每一步都会以别的样子失败）')
}

async function textOf(page, selector, label) {
  await waitFor(page, selector, '出现 ' + selector + '（' + label + '）')
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到元素 ' + selector + '（' + label + '）')
  }
  return String(await el.text() || '').trim()
}

async function textsOf(page, selector) {
  const nodes = await page.$$(selector)
  const out = []
  for (let i = 0; i < nodes.length; i++) {
    out.push(String(await nodes[i].text() || '').trim())
  }
  return out
}

async function tapNth(page, selector, index, label) {
  await waitFor(page, selector, '出现 ' + selector + '（' + label + '）')
  const nodes = await page.$$(selector)
  if (nodes.length <= index) {
    throw new Error('要点第 ' + index + ' 个 ' + selector + '，但只渲染出 ' + nodes.length
      + ' 个（' + label + '）')
  }
  await nodes[index].tap()
}

// 四张表只取断言要用的字段。整表搬回来没必要，而且 evaluate 的返回值要过一次
// JSON 序列化，大对象白白拖慢每一步。
async function readLists(miniProgram) {
  return await withTimeout(miniProgram.evaluate(function () {
    return {
      products: (wx.getStorageSync('inv_products') || []).map(function (item) {
        return {
          id: item.id, name: item.name, stock: Number(item.stock) || 0,
          costPrice: Number(item.costPrice) || 0, salePrice: Number(item.salePrice) || 0,
          colors: item.colors || [], sizes: item.sizes || []
        }
      }),
      skus: (wx.getStorageSync('inv_skus') || []).map(function (item) {
        return {
          id: item.id, productId: item.productId, color: item.color || '', size: item.size || '',
          stock: Number(item.stock) || 0, alertQty: Number(item.alertQty) || 0, isBlank: !!item.isBlank
        }
      }),
      categories: (wx.getStorageSync('inv_categories') || []).map(function (item) {
        return { id: item.id, name: item.name, names: item.names || [] }
      }),
      shopId: String(wx.getStorageSync('inv_shop_id') || ''),
      shopName: String(wx.getStorageSync('inv_shop_name') || '')
    }
  }), 20000, '读内存账本的四张表')
}

// 流水同理只取要用的字段：runRecordsLoadMore 之后这张表有几十条，
// 而且销售单的 lines 可以很长。
async function readRecords(miniProgram) {
  return await withTimeout(miniProgram.evaluate(function () {
    const bookId = wx.getStorageSync('inv_book_id') || wx.getStorageSync('inv_shop_id') || 'ui-test-shop'
    return (wx.getStorageSync('inv_record_docs') || []).filter(function (doc) {
      return String(doc.bookId || '') === String(bookId)
    }).map(function (doc) {
      return {
        id: doc.id,
        type: doc.type,
        amount: Number(doc.amount) || 0,
        // paidAmount 缺失和 0 是两回事（settledAmount 的六格分支就靠它分叉），
        // 所以别用 || 0 抹平。
        paidAmount: doc.paidAmount == null || doc.paidAmount === '' ? null : Number(doc.paidAmount),
        profit: Number(doc.profit) || 0,
        customerId: String(doc.customerId || ''),
        createdAt: Number(doc.createdAt) || 0,
        lines: (doc.lines || []).map(function (line) {
          return {
            lineId: line.lineId, productId: line.productId, skuId: line.skuId || '',
            qty: Number(line.qty) || 0, unitPrice: Number(line.unitPrice) || 0
          }
        })
      }
    }).sort(function (a, b) { return b.createdAt - a.createdAt })
  }), 20000, '读内存账本的流水')
}

// 全店聚合（单位分）。库存调整 / 换规格「不进销售额和毛利」这条口径，
// 用它来判最直接：这几项一分都不许动。
async function readAggregate(miniProgram) {
  return await withTimeout(miniProgram.evaluate(function () {
    return wx.getStorageSync('inv_aggregate') || {}
  }), 15000, '读全店聚合')
}

// 提交的完成信号一律用「账本里真的多出了一条这个类型的流水」。
//
// **不要**再用「输入框被清空」当完成信号：页面在提交成功时确实会清空输入框，可这个判据
// 在**输入压根没落进 data**时是恒真的（页面从头到尾就是空的），于是提交失败也照样绿，
// 失败被推迟到几十行之后的账面断言上，现场完全指不出原因。2026-08-31 首跑换规格那一步
// 就是这么挂的，教训写在 typeInto 上方。
//
// 内存模式下 showToast 是 mock 掉的，页面抛的错在屏幕上根本看不见 —— 所以这里的
// 超时消息要把「多半是被 toast 吞了」这句话直接说出来。
async function waitForNewRecord(miniProgram, type, before, label) {
  const deadline = Date.now() + WAIT_TIMEOUT * 2
  for (;;) {
    const now = await readRecords(miniProgram)
    const fresh = now.filter(function (item) {
      return item.type === type && !before.some(function (old) { return old.id === item.id })
    })
    if (fresh.length === 1) return fresh[0]
    if (fresh.length > 1) {
      throw new Error(label + '：一次提交却多出了 ' + fresh.length + ' 条 ' + type + ' 流水')
    }
    if (Date.now() >= deadline) {
      throw new Error('等「' + label + '」超时：账本里没有多出 ' + type + ' 类型的新流水。'
        + '提交多半在页面里抛错、被 showToast 吞掉了（内存模式下 toast 是 mock 的，'
        + '屏幕上什么都看不见）。常见原因：某个输入没落进 data、必选项没选。'
        + '往上翻 [UI] 那几行看提交前读到的字段值')
    }
    await sleep(400)
  }
}

// 和 waitForNewRecord 同一个道理，只是盯的是四张表而不是流水。
//
// **别拿「页面跳走了没有」当提交的完成信号**：页面跳不跳走取决于 save() 有没有抛错，
// 而抛错会被 mock 掉的 showToast 吃掉。于是「没跳走」这个现象指向两个完全不同的原因
//（校验没过 / 路由指令被吞），从现场分不开 —— 2026-08-31 第二轮就在这上面卡了一次：
// 新建种类时页面默认的商品类型是「分规格现货」，没加规格取值，createCategory 抛
// 「请添加规格」，而用例只等页面跳回列表，报出来的是一句「等进入种类列表超时」。
// 先等账本、账本对了再等页面，两个原因就分得开了。
async function waitForLists(miniProgram, predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT * 2
  for (;;) {
    const lists = await readLists(miniProgram)
    if (predicate(lists)) return lists
    if (Date.now() >= deadline) {
      throw new Error('等「' + label + '」超时：账本没有出现预期的变化。提交多半在页面里'
        + '抛错、被 showToast 吞掉了（内存模式下 toast 是 mock 的，屏幕上什么都看不见），'
        + '常见原因是必填/必选项没满足')
    }
    await sleep(400)
  }
}

function moneyTerms(terms) {
  return {
    salesSum: Number((terms || {}).salesSum) || 0,
    returnsSum: Number((terms || {}).returnsSum) || 0,
    purchaseSum: Number((terms || {}).purchaseSum) || 0,
    profitSum: Number((terms || {}).profitSum) || 0,
    saleCount: Number((terms || {}).saleCount) || 0
  }
}

function findProduct(lists, keyword) {
  const hit = lists.products.filter(function (item) {
    return String(item.name).indexOf(keyword) >= 0
  })
  assert.strictEqual(hit.length, 1,
    '种子里叫「' + keyword + '」的商品应当正好一个，实为 ' + hit.length + ' 个：'
      + JSON.stringify(lists.products.map(function (p) { return p.name })))
  return hit[0]
}

function skusOf(lists, productId) {
  return lists.skus.filter(function (item) {
    return item.productId === productId
  })
}

function latestOfType(records, type) {
  const hit = records.filter(function (item) { return item.type === type })
  assert.ok(hit.length > 0, '账本里一条 ' + type + ' 流水都没有')
  return hit[0]                                  // readRecords 已按 createdAt 倒序
}

// 客户欠款一律从**客户页真正渲染出来的那一份**取，不去猜 storage 里的投影字段名。
// 这样既是账面取数，也顺带核对了欠款有没有画在屏幕上。
async function readCustomerDebts(miniProgram, when) {
  const list = await goto(miniProgram, 'switchTab', '/pages/customers/customers', '客户页（' + when + '）')
  await waitPageReady(list)
  const data = await list.data()
  const map = {}
  ;(data.list || []).forEach(function (item) {
    map[item.id] = Number(item.receivable) || 0
  })
  return map
}

// ---- 进货 -----------------------------------------------------------------

// 进货是店里最高频的主路径之一，之前一条用例都没有。
// 这里走完整 UI：进货 tab → 打开商品弹层 → 搜到唯一那一个 → 填数量与本次进价 →
// 确认入库。账面要变三处：库存 +N、**该商品的进价被本次进价改写**（页面上那句
// 「本次进价会更新该商品的进价」就是这个意思）、多一条 in 流水且金额 = 数量 × 进价。
//
// 【本批不覆盖】带规格商品的进货（要先选规格格再填数）。那条路在 record-sheet
// 的商品 picker 用例里只走到落点，没有提交过。如实记在 PR 里。
async function runPurchase(miniProgram) {
  step('进货：选商品、填数量与本次进价、确认入库，核对库存与进价的变化')
  const before = await readLists(miniProgram)
  const beforeTerms = moneyTerms(await readAggregate(miniProgram))
  // 挑一个**不带规格**的种子商品，规格路径是另一条（见上）。
  const target = findProduct(before, '矿泉水')
  const qty = 5
  const unitPrice = 1.25
  assert.notStrictEqual(target.costPrice, unitPrice,
    '本次进价必须和原进价不同，否则「进价被改写」这条断言恒真、等于没测')

  // 进货已撤出 tabBar，走 navigateTo。理由同销售那一段：先退回 tab 根再进。
  await backToTabRoot(miniProgram)
  const purchase = await goto(miniProgram, 'navigateTo', '/pages/purchase/purchase', '进货页')
  await waitPageReady(purchase)
  await tapWhen(purchase, '.js-purchase-picker')
  await waitFor(purchase, '.js-purchase-item', '商品弹层里出现商品行')
  // 用搜索把列表收敛到唯一一条再点，**不按下标点**：下标依赖列表排序，
  // 排序一变用例就静默点到别的商品，还是绿的。
  await typeInto(purchase, '.js-purchase-search', '矿泉水', '商品弹层搜索', 'keyword')
  await waitForData(purchase, function (d) {
    return d.filtered && d.filtered.length === 1 && d.filtered[0].id === target.id
  }, '搜索把商品弹层收敛到唯一那一条')
  await tap(purchase, '.js-purchase-item')
  await waitForData(purchase, function (d) {
    return d.productId === target.id && d.showPicker === false
  }, '弹层关闭、选中的商品带回主表单')

  // 渲染核对：屏幕上印的就是选中的那个商品和它此刻的库存。
  assert.strictEqual(await textOf(purchase, '.js-purchase-picker', '商品名'), target.name,
    '进货页顶上印的商品名和选中的对不上')
  assert.ok(
    (await textOf(purchase, '.js-purchase-stock', '当前库存')).indexOf(String(target.stock)) >= 0,
    '进货页印的当前库存和账本里的 ' + target.stock + ' 对不上'
  )

  await typeInto(purchase, '.js-purchase-qty', qty, '数量', 'qty')
  await typeInto(purchase, '.js-purchase-price', unitPrice, '本次进价', 'unitPrice')
  const amountText = (qty * unitPrice).toFixed(2)
  await waitForData(purchase, function (d) {
    return d.amountText === amountText
  }, '进货金额跟着数量 × 进价算出来（应为 ' + amountText + '）')

  const beforeRecords = await readRecords(miniProgram)
  await tapWhen(purchase, '.js-purchase-submit')
  // 完成信号用「账本里真的多了一条进货流水」，不用「数量框被清空」——理由见 waitForNewRecord。
  const record = await waitForNewRecord(miniProgram, 'in', beforeRecords, '确认入库')

  const after = await readLists(miniProgram)
  const now = after.products.find(function (item) { return item.id === target.id })
  assert.ok(now, '进货之后商品不见了')
  assert.strictEqual(now.stock, target.stock + qty,
    '进货 ' + qty + ' 件之后库存应当是 ' + (target.stock + qty) + '，实为 ' + now.stock)
  assert.strictEqual(now.costPrice, unitPrice,
    '本次进价应当改写该商品的进价（页面上那句提示就是这个意思）：期望 ' + unitPrice
      + '，实为 ' + now.costPrice)

  assert.strictEqual(record.amount, Number(amountText),
    '进货流水的金额应当是数量 × 进价 = ' + amountText + '，实为 ' + record.amount)
  assert.strictEqual(record.lines.length, 1, '进货流水应当只有一行')
  assert.strictEqual(record.lines[0].productId, target.id, '进货流水记的不是这个商品')
  assert.strictEqual(record.lines[0].qty, qty, '进货流水的件数不对')

  const afterTerms = moneyTerms(await readAggregate(miniProgram))
  assert.strictEqual(afterTerms.purchaseSum, beforeTerms.purchaseSum + Math.round(qty * unitPrice * 100),
    '进货金额没有进全店的 purchaseSum（单位分）')
  assert.strictEqual(afterTerms.salesSum, beforeTerms.salesSum, '进货不该动销售额')
  assert.strictEqual(afterTerms.profitSum, beforeTerms.profitSum, '进货不该动毛利')
}

// ---- 退货 -----------------------------------------------------------------

// 退货是出错最贵的一条：退款要**先冲欠款、冲不完的才退现金**，两头分账。
// 拆分不变量写在 utils/inventory.js 的 returnCashRefund 上方：
//     Σ(退货额 − 现金退款) == min(该销售单的欠款 D, Σ退货额)
// 单张退货单就是 冲欠款 = min(D, r)、退现金 = max(0, r − D)。
//
// 所以这里**两条分支各测一次**，而不是造一张人工的「一半一半」单：
//   · 挂欠的那张（D = 全额）→ 应当全部冲欠款、现金 0；
//   · 收讫的那张（D = 0）  → 应当全部退现金、欠款一分不动。
// 两端都钉住，中间的线性区间就没有可藏的地方。
//
// 客户欠款的变化由客户页真正渲染的数来判（readCustomerDebts）。
async function returnWholeOrder(miniProgram, orderId, how) {
  const beforeLists = await readLists(miniProgram)
  const beforeRecords = await readRecords(miniProgram)
  const sale = beforeRecords.find(function (item) { return item.id === orderId })
  assert.ok(sale, '要退的销售单 ' + orderId + ' 不在账本里')
  assert.strictEqual(sale.type, 'out', '要退的不是销售单：' + sale.type)
  // 预收本项目还没实现（客户端明文禁止），所以 D 就是 应收 − 实收，没有第三项。
  const settled = sale.paidAmount == null ? sale.amount : Math.min(sale.paidAmount, sale.amount)
  const debt = Math.round((sale.amount - settled) * 100) / 100

  const ret = await waitForPage(miniProgram, 'pages/sale-return/sale-return', '退货页（' + how + '）')
  // B8 起退货页有 pageLoading（onLoad 里先 fetchRecord）。名单在
  // tests/automator-contract.test.js 的 HAS_PAGE_LOADING 里。
  await waitPageReady(ret)
  await waitForData(ret, function (d) {
    return d && d.lines && d.lines.length > 0 && d.orderId === orderId
  }, '退货页带出了原单行（' + how + '）')
  const retData = await ret.data()

  // 渲染核对：原单每一行都画出来了，客户名也印在上面。
  const lineNodes = await ret.$$('.js-return-line')
  assert.strictEqual(lineNodes.length, retData.lines.length,
    '退货页渲染出来的行数（' + lineNodes.length + '）和 data.lines（' + retData.lines.length
      + '）对不上')
  assert.deepStrictEqual(
    await textsOf(ret, '.js-return-name'),
    retData.lines.map(function (line) { return String(line.productName) }),
    '退货页屏幕上的商品名和 data.lines 对不上'
  )
  assert.strictEqual(await textOf(ret, '.js-return-customer', '客户'), String(retData.customerName),
    '退货页印的客户和 data 对不上')
  const remainText = await textOf(ret, '.js-return-remain', '可退件数')
  assert.ok(remainText.indexOf('可退') >= 0, '退货页那行没写「可退」：' + remainText)

  // 默认就是全退（sale-return.js 把 qty 预填成 remain），所以这里不改数量，
  // 直接提交 —— 少一次输入就少一处和真实操作不一致的地方。
  retData.lines.forEach(function (line) {
    assert.strictEqual(String(line.qty), String(line.remain),
      '前提：退货页应当把每行数量预填成可退件数，实为 ' + line.qty + ' / 可退 ' + line.remain)
  })
  await tapWhen(ret, '.js-return-submit')
  // submit 成功之后页面 setTimeout(400) 再 navigateBack，退回上一页即完成信号。
  await waitFor(ret, async function () {
    const cur = await pollCurrentPage(miniProgram)
    return !!(cur && String(cur.path || '') !== 'pages/sale-return/sale-return')
  }, '退货提交后自己退回上一页（' + how + '）')

  const afterRecords = await readRecords(miniProgram)
  const created = afterRecords.filter(function (item) {
    return item.type === 'return' && !beforeRecords.some(function (old) { return old.id === item.id })
  })
  assert.strictEqual(created.length, 1,
    '一次提交应当只生成一张退货单，实为 ' + created.length + ' 张（' + how + '）')
  const record = created[0]
  const cash = record.paidAmount == null ? record.amount : record.paidAmount
  const offset = Math.round((record.amount - cash) * 100) / 100

  assert.strictEqual(offset, Math.min(debt, record.amount),
    '冲欠款的份额应当是 min(销售单欠款 ' + debt + ', 退货额 ' + record.amount + ') = '
      + Math.min(debt, record.amount) + '，实为 ' + offset
      + '（拆分不变量见 utils/inventory.js 的 returnCashRefund 上方）')
  assert.strictEqual(cash, Math.round(Math.max(0, record.amount - debt) * 100) / 100,
    '退现金的份额应当是 max(0, 退货额 − 欠款)，实为 ' + cash)

  // 退货原样入库：卖掉的那一格回到哪一格，件数就加回哪一格。
  const afterLists = await readLists(miniProgram)
  record.lines.forEach(function (line) {
    if (line.skuId) {
      const was = beforeLists.skus.find(function (s) { return s.id === line.skuId })
      const now = afterLists.skus.find(function (s) { return s.id === line.skuId })
      assert.ok(was && now, '退货行对应的规格格找不到了：' + line.skuId)
      assert.strictEqual(now.stock, was.stock + line.qty,
        '退货没把件数加回原来那一格（' + line.skuId + '）：' + was.stock + ' -> ' + now.stock)
    } else {
      const was = beforeLists.products.find(function (p) { return p.id === line.productId })
      const now = afterLists.products.find(function (p) { return p.id === line.productId })
      assert.ok(was && now, '退货行对应的商品找不到了：' + line.productId)
      assert.strictEqual(now.stock, was.stock + line.qty,
        '退货没把件数加回库存（' + line.productId + '）：' + was.stock + ' -> ' + now.stock)
    }
  })

  step('退货（' + how + '）：退货额 ' + record.amount + ' = 冲欠款 ' + offset
    + ' + 退现金 ' + cash + '（原单欠款 ' + debt + '）')
  return { customerId: record.customerId, amount: record.amount, cash: cash, offset: offset }
}

async function runSaleReturn(miniProgram) {
  step('退货：挂欠单全额冲欠款、收讫单全额退现金，两条分支各走一次')
  const before = await readCustomerDebts(miniProgram, '退货前')
  const records = await readRecords(miniProgram)

  // 分支一：挂欠的那张。走完整 UI —— 流水页 → 销售详情 → 「退货入库」。
  // 取最新那张销售单：它就是 runSalePickerAndSlip 刚做的「一分未收」那单，
  // D = 全额，所以必然走冲欠款那一支。
  const credited = latestOfType(records, 'out')
  assert.ok(credited.paidAmount === 0,
    '前提：最新那张销售单应当是「一分未收」（runSalePickerAndSlip 做的），实收却是 '
      + credited.paidAmount + ' —— 用例顺序被改过的话这里要跟着改')
  const list = await goto(miniProgram, 'switchTab', '/pages/records/records', '流水页')
  await waitFor(list, '.js-record-out', '流水里出现销售记录')
  await tapNth(list, '.js-record-out', 0, '最新一条销售')
  const detail = await waitForPage(miniProgram, 'pages/record-edit/record-edit', '销售流水详情页')
  await waitForData(detail, function (d) {
    return d && d.id === credited.id && d.canReturn === true
  }, '详情页停在那张挂欠的销售单上、并且可退')
  await tapWhen(detail, '.js-go-return')
  const a = await returnWholeOrder(miniProgram, credited.id, '挂欠单')
  assert.strictEqual(a.cash, 0, '挂欠单全额退货时不该退现金')
  assert.strictEqual(a.offset, credited.amount, '挂欠单全额退货时应当全部冲欠款')
  await backToTabRoot(miniProgram)

  // 分支二：收讫的那张。这次**直接带 id 进页面**，不再从流水页点 ——
  // 要的是「实收 ≥ 应收」这个确定的前提，而流水页第一条是哪一张取决于时间序，
  // 按下标点就是在赌。UI 入口那一条已经由分支一走过了。
  const paidOff = records.filter(function (item) {
    return item.type === 'out' && item.id !== credited.id
      && item.paidAmount != null && item.paidAmount >= item.amount
  })[0]
  assert.ok(paidOff, '前提：种子里应当有收讫的销售单（李记便利那三张），一张都没找到')
  await goto(miniProgram, 'navigateTo', '/pages/sale-return/sale-return?id=' + paidOff.id, '退货页（收讫单）')
  const b = await returnWholeOrder(miniProgram, paidOff.id, '收讫单')
  assert.strictEqual(b.offset, 0, '收讫单退货时没有欠款可冲')
  assert.strictEqual(b.cash, paidOff.amount, '收讫单退货时应当全额退现金')

  // 欠款的变化：**只减少冲欠款的那部分**，退出去的现金不动欠款。
  const after = await readCustomerDebts(miniProgram, '退货后')
  const offsets = {}
  ;[a, b].forEach(function (one) {
    offsets[one.customerId] = (offsets[one.customerId] || 0) + one.offset
  })
  Object.keys(before).forEach(function (id) {
    const want = Math.round((before[id] - (offsets[id] || 0)) * 100) / 100
    assert.strictEqual(
      Math.round((after[id] || 0) * 100) / 100,
      want,
      '客户 ' + id + ' 的欠款应当从 ' + before[id] + ' 只减掉冲欠款的 ' + (offsets[id] || 0)
        + '（= ' + want + '），实为 ' + after[id]
        + ' —— 退现金那部分不该动欠款'
    )
  })
}

// ---- 库存调整 -------------------------------------------------------------

// 「只改件数、不进毛利」这条口径最容易写错，而写错了在页面上看不出来 ——
// 库存照样对，只是销售额和毛利悄悄多了一笔。所以这里的主断言是**全店聚合**：
// 库存调整只许让 count +1，salesSum / returnsSum / purchaseSum / profitSum 一分不许动。
// 判据来自 utils/inventory.js 的 recordTerms：adjust_in / adjust_out 对这四项的
// 贡献写死是 0，本用例就是那份定义的运行时对照。
//
// 进页面这里**直接带 id**：从商品详情点进来的那条 UI 路径由 runProductDetail 走，
// 两条用例各测一件事，别互相耦合。
async function runAdjust(miniProgram) {
  step('库存调整：出库 3 件，核对件数减了、销售额与毛利一分没动')
  const before = await readLists(miniProgram)
  const beforeTerms = moneyTerms(await readAggregate(miniProgram))
  const target = findProduct(before, '鸡蛋')
  const qty = 3

  const adjust = await goto(miniProgram, 'navigateTo',
    '/pages/adjust/adjust?id=' + target.id, '库存调整页')
  // adjust 没有 pageLoading 字段（automator-contract 的 NO_PAGE_LOADING 钉着），
  // 所以等的是它自己的业务字段。
  await waitForData(adjust, function (d) {
    return d && d.productId === target.id
  }, '调整页读到了商品')
  assert.strictEqual(await textOf(adjust, '.js-adjust-product', '商品名'), target.name,
    '调整页印的商品名不对')
  assert.strictEqual(await textOf(adjust, '.js-adjust-stock', '当前件数'), String(target.stock),
    '调整页印的当前件数和账本对不上')

  await tapWhen(adjust, '.js-adjust-out')
  await waitForData(adjust, function (d) {
    return d.direction === 'out'
  }, '方向切到出库')
  await typeInto(adjust, '.js-adjust-qty', qty, '调整数量', 'qty')
  const beforeRecords = await readRecords(miniProgram)
  await tapWhen(adjust, '.js-adjust-submit')
  const record = await waitForNewRecord(miniProgram, 'adjust_out', beforeRecords, '确认调整')
  // 页面上那格「当前件数」也要就地刷新 —— 这是渲染那一半，和上面的账面那一半各管各的。
  await waitForData(adjust, function (d) {
    return d.stockText === String(target.stock - qty)
  }, '提交之后页面上的当前件数刷新成 ' + (target.stock - qty))

  const after = await readLists(miniProgram)
  const now = after.products.find(function (item) { return item.id === target.id })
  assert.strictEqual(now.stock, target.stock - qty,
    '出库 ' + qty + ' 件之后库存应当是 ' + (target.stock - qty) + '，实为 ' + now.stock)

  assert.strictEqual(record.profit, 0, '库存调整的毛利必须是 0，实为 ' + record.profit)

  const afterTerms = moneyTerms(await readAggregate(miniProgram))
  ;['salesSum', 'returnsSum', 'purchaseSum', 'profitSum'].forEach(function (key) {
    assert.strictEqual(afterTerms[key], beforeTerms[key],
      '库存调整动了全店聚合的 ' + key + '（' + beforeTerms[key] + ' -> ' + afterTerms[key]
        + '）—— 它只该改件数，不进销售额也不进毛利')
  })
  assert.strictEqual(afterTerms.saleCount, beforeTerms.saleCount,
    '库存调整不该被算成一笔销售')
  await goBackTo(miniProgram, '上一页（库存调整之后）')
}

// ---- 盘点（Screen/02b 盘点模式）--------------------------------------------
//
// 盘点和库存调整的账法完全一样（只改件数、不进销售额与毛利），差别在**形态**：
// 一屏把这个商品的每一格账面数带出来，只改对不上的那几格，一条确认。所以这里断言
// 的重点是「多格一起带出来」和「没碰的格一件不动」—— 后者是稿 UX注释 n1 的原话
// 「未触碰的绝不动」，而它恰好是这一屏最容易做错、屏上又看不出来的地方。
//
// 用卫衣：种子里唯一的待加工商品（半成品池 + 3 色 x 2 码 = 7 格），能同时验到
// 「半成品行排第一」和「账面数取的是 blank sku 那一格」。全轮没有别的用例碰它。
async function runStockTake(miniProgram) {
  step('盘点：一屏带出所有规格的账面数，只改一格，其余一件不动')
  // 从看板起步：这一页提交成功后会自己 navigateBack，用固定起点才判得准退到了哪。
  await goto(miniProgram, 'switchTab', '/pages/index/index', '看板（盘点之前）')

  const before = await readLists(miniProgram)
  const beforeTerms = moneyTerms(await readAggregate(miniProgram))
  const target = findProduct(before, '卫衣')
  const beforeSkus = skusOf(before, target.id)
  const blank = beforeSkus.find(function (item) { return item.isBlank })
  assert.ok(blank, '前提：卫衣是待加工商品，应该有半成品格')
  assert.ok(blank.stock >= 2, '前提：半成品池要有至少 2 件才好盘出差异，实为 ' + blank.stock)

  const take = await goto(miniProgram, 'navigateTo',
    '/pages/stock-take/stock-take?id=' + target.id, '盘点页')
  await waitForData(take, function (d) {
    return d && d.productId === target.id && d.rows && d.rows.length === beforeSkus.length
  }, '盘点页把 ' + beforeSkus.length + ' 个规格全带出来了')

  const opened = await take.data()
  // 刚打开就有差异 = 账面数带错了（稿 n1：账面数自动带出）
  assert.strictEqual(opened.diffCount, 0, '刚打开就有差异 —— 账面数带错了')
  assert.strictEqual(opened.rows[0].blank, true, '第一行应当是半成品（稿 card/盘点行 4:900）')
  assert.strictEqual(opened.rows[0].bookQty, blank.stock,
    '半成品行的账面数要取 findBlankSku 那一格：账本 ' + blank.stock
      + '，页面 ' + opened.rows[0].bookQty)

  const inputs = await take.$$('.js-take-qty')
  assert.strictEqual(inputs.length, beforeSkus.length, '每个规格都要有一个可输入的实点框')
  const taken = blank.stock - 2
  await inputs[0].input(String(taken))
  await waitForData(take, function (d) {
    return d && d.diffCount === 1
  }, '改了一格之后差异处数变成 1')

  const beforeRecords = await readRecords(miniProgram)
  await tapWhen(take, '.js-take-submit')
  const record = await waitForNewRecord(miniProgram, 'adjust_out', beforeRecords, '确认调整')
  assert.strictEqual(record.profit, 0, '盘点的毛利必须是 0，实为 ' + record.profit)
  // 稿 n5 / n7：确认之后回上一页
  await waitForPage(miniProgram, 'pages/index/index', '看板（盘点提交后自动退回）')

  const after = await readLists(miniProgram)
  const afterSkus = skusOf(after, target.id)
  const afterBlank = afterSkus.find(function (item) { return item.isBlank })
  assert.strictEqual(afterBlank.stock, taken,
    '半成品格应当被盘成 ' + taken + '，实为 ' + afterBlank.stock)
  beforeSkus.forEach(function (item) {
    if (item.isBlank) return
    const now = afterSkus.find(function (x) { return x.id === item.id })
    assert.strictEqual(now.stock, item.stock,
      '没碰过的规格被动了（稿 n1：未触碰的绝不动）：' + item.id
        + ' ' + item.stock + ' -> ' + now.stock)
  })

  const afterTerms = moneyTerms(await readAggregate(miniProgram))
  ;['salesSum', 'returnsSum', 'purchaseSum', 'profitSum'].forEach(function (key) {
    assert.strictEqual(afterTerms[key], beforeTerms[key],
      '盘点动了全店聚合的 ' + key + '（' + beforeTerms[key] + ' -> ' + afterTerms[key]
        + '）—— 它只该改件数，不进销售额也不进毛利')
  })
  assert.strictEqual(afterTerms.saleCount, beforeTerms.saleCount, '盘点不该被算成一笔销售')
}

// ---- 换规格 ---------------------------------------------------------------

// 换规格的铁律是**件数守恒**：从一格挪到另一格，这个商品的总件数一件不变，
// 而且同样不进销售额和毛利。所以这里断言三件事：源格 −N、目标格 +N、总数不变。
async function runConvert(miniProgram) {
  step('换规格：从一格挪到另一格，核对件数守恒、不进销售额与毛利')
  const before = await readLists(miniProgram)
  const beforeTerms = moneyTerms(await readAggregate(miniProgram))
  const target = findProduct(before, '短袖')
  const beforeSkus = skusOf(before, target.id).filter(function (item) { return !item.isBlank })
  assert.ok(beforeSkus.length >= 2, '前提：这个商品要有至少两个规格格')

  const convert = await goto(miniProgram, 'navigateTo', '/pages/convert/convert', '换规格页')
  await tapWhen(convert, '.js-convert-picker')
  await waitFor(convert, '.js-convert-item', '商品弹层里出现带规格的商品')
  await typeInto(convert, '.js-convert-search', '短袖', '换规格商品弹层搜索', 'keyword')
  await waitForData(convert, function (d) {
    return d.filtered && d.filtered.length === 1 && d.filtered[0].id === target.id
  }, '搜索把弹层收敛到唯一那一条')
  await tap(convert, '.js-convert-item')
  await waitForData(convert, function (d) {
    return d.productId === target.id && d.showPicker === false && d.fromOptions.length > 0
  }, '选中商品、列出可改的现货格')

  const picked = await convert.data()
  // 源格：选有货的第一格。目标格：**换一个颜色、尺码不变** —— 这样目标格一定存在
  // （种子里两个颜色 × 两个尺码都建了 sku），而且和源格必然不同。
  const from = picked.fromOptions[0]
  const fromSku = before.skus.find(function (item) { return item.id === from.id })
  assert.ok(fromSku, '源格在账本里找不到：' + from.id)
  const toColor = picked.colors.filter(function (color) { return color !== fromSku.color })[0]
  assert.ok(toColor, '前提：这个商品要有至少两个颜色取值')
  const toSku = beforeSkus.find(function (item) {
    return item.color === toColor && item.size === fromSku.size
  })
  assert.ok(toSku, '目标格（' + toColor + '/' + fromSku.size + '）在账本里不存在')

  await tapNth(convert, '.js-convert-from', picked.fromOptions.indexOf(from), '源格')
  await waitForData(convert, function (d) {
    return d.fromSkuId === from.id
  }, '源格选中')

  // B10 起目标格是**一列组合 chip**（稿 picker/格选择器/简版 4:503），不再分颜色 /
  // 尺码两行 —— 稿注 $13:694 要求「与来源相同的 chip 禁用」，那条只有在组合 chip 上
  // 才表达得出来（双轴下禁掉「白色」会连「白色/2.0m」一起误禁）。
  // 下标一律**在选完来源之后重新读一次 toOptions 去找**：与来源相同的那一枚仍然占位
  //（禁用档），拿 fromOptions 或 skus 的顺序去猜必然错位。
  const afterFrom = await convert.data()
  const toIndex = afterFrom.toOptions.findIndex(function (item) {
    return item.id === toSku.id
  })
  assert.ok(toIndex >= 0,
    '目标格没有出现在 toOptions 里：' + toSku.id
      + '（toOptions = ' + JSON.stringify(afterFrom.toOptions.map(function (item) {
        return item.id + ':' + item.label + (item.same ? '(同源禁用)' : '')
      })) + '）')
  await tapNth(convert, '.js-convert-to', toIndex, '目标格')
  await waitForData(convert, function (d) {
    return d.toSkuId === toSku.id
  }, '目标格选中')

  const qty = 1
  await typeInto(convert, '.js-convert-qty', qty, '换规格数量', 'qty')
  // 提交之前把决定成败的四个字段打出来。首跑就是在这一步失败的，而当时日志里
  // 一个字段值都没有，只能从两百行之后的库存断言倒推。
  const ready = await convert.data()
  step('换规格提交前：fromSkuId=' + ready.fromSkuId + '（' + fromSku.color + '/' + fromSku.size
    + '）→ toSkuId=' + ready.toSkuId + '（' + toColor + '/' + fromSku.size
    + '） qty=' + JSON.stringify(ready.qty))
  const beforeRecords = await readRecords(miniProgram)
  await tapWhen(convert, '.js-convert-submit')
  const record = await waitForNewRecord(miniProgram, 'convert', beforeRecords, '换规格提交')

  const after = await readLists(miniProgram)
  const afterSkus = skusOf(after, target.id).filter(function (item) { return !item.isBlank })
  const sum = function (list) {
    return list.reduce(function (acc, item) { return acc + item.stock }, 0)
  }
  // 断言不符时把整张格子表打出来，别让下一个人只能拿着「5 !== 4」倒推。
  const table = function (list) {
    return JSON.stringify(list.map(function (item) {
      return item.color + '/' + item.size + '=' + item.stock
    }))
  }
  const where = '（改之前 ' + table(beforeSkus) + '，改之后 ' + table(afterSkus)
    + '，本次 ' + fromSku.color + '/' + fromSku.size + ' → ' + toColor + '/' + fromSku.size + '）'
  assert.strictEqual(sum(afterSkus), sum(beforeSkus),
    '换规格必须件数守恒：改之前合计 ' + sum(beforeSkus) + ' 件，改之后 ' + sum(afterSkus) + ' 件' + where)
  assert.strictEqual(
    afterSkus.find(function (item) { return item.id === fromSku.id }).stock,
    fromSku.stock - qty,
    '源格没有减掉 ' + qty + ' 件' + where)
  assert.strictEqual(
    afterSkus.find(function (item) { return item.id === toSku.id }).stock,
    toSku.stock + qty,
    '目标格没有加上 ' + qty + ' 件' + where)

  assert.strictEqual(record.profit, 0, '换规格的毛利必须是 0，实为 ' + record.profit)
  const afterTerms = moneyTerms(await readAggregate(miniProgram))
  ;['salesSum', 'returnsSum', 'purchaseSum', 'profitSum'].forEach(function (key) {
    assert.strictEqual(afterTerms[key], beforeTerms[key],
      '换规格动了全店聚合的 ' + key + ' —— 它只是把件数从一格挪到另一格')
  })
  await goBackTo(miniProgram, '上一页（换规格之后）')
}

// ---- 商品详情（本周刚合的 #93）--------------------------------------------

// 这一屏是 2026-08-30 才合进来的，而且合进来的那次就带了一条让整个工程编译不出来的
// WXSS 注释 bug（现在由 tests/wxss-wxml.test.js 静态拦着）。这里补运行时的网：
// 从商品列表点卡片进详情、头卡与库存全景渲染正确、**四个动作按钮各自的落点**。
//
// 四个按钮里「去销售」「去进货」在 A3 批之后走 navigateTo（两页已撤出 tabBar）。
// 它们不再重置页面栈，但这两个仍放在最后测、中间带 id 重进详情 —— 这个写法在
// 压栈语义下照样成立，本批不改流程，只把注释说的机制改对。
async function runProductDetail(miniProgram) {
  step('商品详情：从商品列表进详情，核对头卡与库存全景，再逐个验四个动作按钮的落点')
  const lists = await readLists(miniProgram)
  const target = findProduct(lists, '短袖')

  const products = await goto(miniProgram, 'switchTab', '/pages/products/products', '商品页')
  await waitPageReady(products)
  await typeInto(products, '.js-product-search', '短袖', '商品搜索', 'keyword')
  await waitForData(products, function (d) {
    return d.list && d.list.length === 1 && d.list[0].id === target.id
  }, '搜索把商品列表收敛到唯一那一条')

  // 货号行（2026-09-01，稿 sku 槽 19:32）：有货号的商品，卡上「货号 X」单独一行。
  // 不复刻文案拼法之外的东西 —— 期望值由页面 data 里的 sku 现算，改了前缀这里就红。
  const cardWithSku = await products.data()
  assert.ok(cardWithSku.list[0].sku,
    '前提：种子里的「短袖 T恤」应当带货号，实为 ' + JSON.stringify(cardWithSku.list[0].sku))
  assert.strictEqual(cardWithSku.list[0].skuText, '货号 ' + cardWithSku.list[0].sku,
    'cardViewOf 给出的 skuText 不是「货号 」+ product.sku')
  assert.deepStrictEqual(
    await textsOf(products, '.js-product-sku'),
    ['货号 ' + cardWithSku.list[0].sku],
    '屏幕上的货号行和 data.list[0].skuText 对不上 —— 数据对、卡上没画出来（或画了两行）')

  await tap(products, '.js-product-card')

  const detail = await waitForPage(miniProgram, 'pages/product-detail/product-detail', '商品详情页')
  await waitPageReady(detail)
  await waitForData(detail, function (d) {
    return d.productId === target.id
  }, '详情页读到了商品')
  const data = await detail.data()

  assert.strictEqual(await textOf(detail, '.js-detail-name', '商品名'), target.name,
    '详情页头卡的商品名不对')
  assert.strictEqual(await textOf(detail, '.js-detail-price', '售价'), '¥' + data.priceText,
    '详情页头卡的售价和 data.priceText 对不上（少了 ¥ 或者绑错字段）')
  assert.strictEqual(await textOf(detail, '.js-detail-meta', '副行'), String(data.metaText),
    '详情页头卡的副行和 data.metaText 对不上')

  // 库存全景：每一格都要画出来，而且每格的件数要等于账本里那一格的件数。
  assert.ok(data.stockRows.length > 0, '带规格的商品，库存全景不该是空的')
  assert.deepStrictEqual(
    await textsOf(detail, '.js-detail-cell-label'),
    data.stockRows.map(function (row) { return String(row.label) }),
    '库存全景的格名和 data.stockRows 对不上')
  assert.deepStrictEqual(
    await textsOf(detail, '.js-detail-cell-qty'),
    data.stockRows.map(function (row) { return String(row.qtyText) }),
    '库存全景的件数和 data.stockRows 对不上')
  const bookSkus = skusOf(lists, target.id).filter(function (item) { return !item.isBlank })
  const onScreen = (await textsOf(detail, '.js-detail-cell-qty')).map(function (text) {
    return Number(String(text).replace(/[^0-9.-]/g, ''))
  })
  assert.strictEqual(
    onScreen.reduce(function (a, b) { return a + b }, 0),
    bookSkus.reduce(function (a, b) { return a + b.stock }, 0),
    '库存全景各格件数之和和账本里这个商品的各格之和对不上'
  )

  // 落点①「编辑商品」→ 商品编辑页（navigateTo，能退回来）
  await tapWhen(detail, '.js-detail-edit')
  const edit1 = await waitForPage(miniProgram, 'pages/product-edit/product-edit', '商品编辑页（编辑商品）')
  await waitForData(edit1, function (d) {
    return d.id === target.id && d.isEdit === true
  }, '编辑页带上了这个商品的 id')
  await goBackTo(miniProgram, '商品详情页')

  // 落点②「调价」→ 现在和「编辑商品」同一个落点（product-detail.js 写明了
  // 锚定价格区由后续批次补），所以这里断言的是「也进得去编辑页」，
  // 并**如实记着**它现在和上一个按钮落在同一页 —— 哪天真的分开了，这条要跟着改。
  await tapWhen(detail, '.js-detail-reprice')
  const edit2 = await waitForPage(miniProgram, 'pages/product-edit/product-edit', '商品编辑页（调价）')
  await waitForData(edit2, function (d) {
    return d.id === target.id
  }, '调价也进到了这个商品的编辑页')
  await goBackTo(miniProgram, '商品详情页')

  // 落点③ 库存全景的格 → 库存调整页（带 productId）
  await tapNth(detail, '.js-detail-cell', 0, '库存全景第一格')
  const adjust = await waitForPage(miniProgram, 'pages/adjust/adjust', '库存调整页（从库存全景进）')
  await waitForData(adjust, function (d) {
    return d.productId === target.id
  }, '调整页拿到了 productId')
  await goBackTo(miniProgram, '商品详情页')

  // 落点④「去进货」→ navigateTo 到进货页（已不是 tab）。下一步用带 id 重进详情，
  // 这条路在压栈语义下一样通。
  await tapWhen(detail, '.js-detail-purchase')
  const purchase = await waitForPage(miniProgram, 'pages/purchase/purchase', '进货页（从详情「去进货」）')
  await waitPageReady(purchase)

  // 落点⑤「去销售」→ navigateTo 到销售页（已不是 tab）
  const again = await goto(miniProgram, 'navigateTo',
    '/pages/product-detail/product-detail?id=' + target.id, '商品详情页（重进）')
  await waitPageReady(again)
  await tapWhen(again, '.js-detail-sale')
  const sale = await waitForPage(miniProgram, 'pages/sale/sale', '销售页（从详情「去销售」）')
  await waitPageReady(sale)
}

// ---- 商品编辑（规格编辑器 + SKU 矩阵）------------------------------------

// 规格编辑器的核心是那张矩阵：规格一 × 规格二，加一个取值就多一行、删一个就少一行。
// 这条用例把矩阵**当着面改三次**（2×2 → 3×2 → 2×2），每次都核对行数和行名，
// 再保存、从账本里核对真的落了 4 个规格格，最后删掉自己造的这件商品，
// 不给后面的用例留垃圾。
//
// 【5a 批（B5）起变了三件事】
//   1. 没有「商品类型」分段控件了（稿 UX注释 n1）——加了取值就是带规格的商品；
//   2. 规格编辑器和 SKU 矩阵挂在折叠索引卡后面，要先点开那一行；
//   3. 件数在这一页是**只读**的（稿 UX注释 n9），所以「逐格填一个互不相同的数、
//      再逐格对回来」这条防数据丢失的钉子改填**预警数**，别的一个字没变 ——
//      只断言「落了 4 个组合」是测不出矩阵内容丢失的，理由见下面那段长注释。
async function runProductEdit(miniProgram) {
  step('商品编辑：新建带规格的商品，核对 SKU 矩阵随规格取值增减，保存后落盘，再删掉')
  const before = await readLists(miniProgram)
  const name = 'UI 规格测试商品'
  assert.ok(
    !before.products.some(function (item) { return item.name === name }),
    '账本里已经有叫「' + name + '」的商品了，上一轮没清干净？'
  )

  const products = await goto(miniProgram, 'switchTab', '/pages/products/products', '商品页')
  await waitPageReady(products)
  await tapWhen(products, '.js-product-add')
  const edit = await waitForPage(miniProgram, 'pages/product-edit/product-edit', '商品编辑页（新增）')
  await waitForData(edit, function (d) {
    return d && d.isEdit === false
  }, '停在新增模式')

  await typeInto(edit, '.js-pe-name', name, '商品名称', 'name')
  await typeInto(edit, '.js-pe-cost', '10', '默认进价', 'costPrice')
  await typeInto(edit, '.js-pe-sale', '25', '默认售价', 'salePrice')

  // 规格编辑器在折叠索引第一行后面，先展开。
  await tapWhen(edit, '.js-pe-fold-spec')
  await waitForData(edit, function (d) {
    return d.specOpen === true
  }, '展开规格编辑器')

  // 「＋ 添加规格值」点了原位变输入框，回车 / 失焦生成 chip（稿 UX注释 n6）。
  // 提交这一步走 callMethod：automator 的 Element 没有可靠的 blur 触发口，
  // 而「bindblur / bindconfirm 到底接没接上」由 tests/product-edit.test.js 的静态钉子管。
  // 两边合起来才是完整的：这里证行为、那里证接线。
  const addSpec = async function (addSel, value, axis, key) {
    await tapWhen(edit, addSel)
    await waitForData(edit, function (d) {
      return d.adding === key
    }, axis + '：＋添加变成了输入框')
    await typeInto(edit, '.js-pe-spec-input', value, axis + '取值输入框', 'specInput')
    await edit.callMethod('commitSpec')
    await waitForData(edit, function (d) {
      return (key === 'color' ? d.colors : d.sizes).indexOf(value) >= 0
    }, axis + '加上取值「' + value + '」')
  }
  await addSpec('.js-pe-color-add', '红', '规格一', 'color')
  await addSpec('.js-pe-color-add', '蓝', '规格一', 'color')
  await addSpec('.js-pe-size-add', 'S', '规格二', 'size')
  await addSpec('.js-pe-size-add', 'M', '规格二', 'size')

  // 矩阵在折叠索引第三行后面，展开它才看得见行。
  await tapWhen(edit, '.js-pe-fold-sku')
  await waitForData(edit, function (d) {
    return d.skuOpen === true
  }, '展开 SKU 矩阵')

  // 2×2：矩阵应当正好四行，而且行名就是笛卡尔积。
  const expectRows = async function (want, when) {
    await waitForData(edit, function (d) {
      return d.skuRows && d.skuRows.length === want
    }, when + '：SKU 矩阵应当有 ' + want + ' 行')
    const nodes = await edit.$$('.js-pe-sku-row')
    assert.strictEqual(nodes.length, want,
      when + '：SKU 矩阵渲染出来 ' + nodes.length + ' 行，data.skuRows 却是 ' + want
        + ' 行 —— 数据对、屏幕没画出来')
    const data = await edit.data()
    assert.deepStrictEqual(
      await textsOf(edit, '.js-pe-sku-title'),
      data.skuRows.map(function (row) { return String(row.specText) }),
      when + '：屏幕上的规格名和 data.skuRows 对不上')
    return data.skuRows.map(function (row) { return String(row.specText) })
  }
  const rows2x2 = await expectRows(4, '两色两码')
  ;['红', '蓝'].forEach(function (color) {
    ['S', 'M'].forEach(function (size) {
      assert.ok(
        rows2x2.some(function (text) {
          return text.indexOf(color) >= 0 && text.indexOf(size) >= 0
        }),
        '两色两码的矩阵里缺了 ' + color + '/' + size + '：' + JSON.stringify(rows2x2)
      )
    })
  })

  // 3×2：再加一个取值，矩阵要跟着长两行。
  await addSpec('.js-pe-color-add', '绿', '规格一', 'color')
  await expectRows(6, '三色两码')

  // 删掉刚加的那个取值（点 chip 上的 ×），矩阵要缩回四行。
  // 5a 批起 × 是 chip 里独立的 44×44 热区（稿 chip/取值·可删 10:158 的 hit/删 13:678），
  // 整枚 chip 不再可点；`.js-pe-color-chip` 与 `.js-pe-color-del` 顺序一一对应。
  const chips = await textsOf(edit, '.js-pe-color-chip')
  const greenAt = chips.findIndex(function (text) { return text.indexOf('绿') >= 0 })
  assert.ok(greenAt >= 0, '颜色 chip 里找不到刚加的「绿」：' + JSON.stringify(chips))
  await tapNth(edit, '.js-pe-color-del', greenAt, '删掉「绿」')
  await expectRows(4, '删掉一个取值之后')

  // 【每一格填一个互不相同的预警数，再核对它们逐格落盘】
  // 这一步不是凑数。只断言「落了 4 个规格组合」是**测不出矩阵内容丢失**的：
  // 组合名是 saveProduct 从 colors × sizes 现推的，跟传进去的 skuRows 无关 ——
  // 实测把 product-edit.js 保存时的 skuRows 改成 .slice(1)（整整丢掉一行的数据），
  // 那版用例照样 EXIT=0 全绿。给每格填一个不同的数、再逐格对回来，才钉得住。
  // 5a 批起件数只读（稿 UX注释 n9），所以这个「互不相同的数」改用预警数。
  // 注意这条路只对**没开半成品池**的商品成立：applyProductSkus 对待加工商品
  // 把每格的 alertQty 强制写 0（utils/inventory.js:556），本用例建的正是分规格现货。
  const alertOf = {}
  const rows = (await edit.data()).skuRows
  for (let i = 0; i < rows.length; i++) {
    const want = String(i + 1)
    const inputs = await edit.$$('.js-pe-sku-alert')
    assert.strictEqual(inputs.length, rows.length,
      'SKU 矩阵的预警输入框有 ' + inputs.length + ' 个，行数却是 ' + rows.length)
    await inputs[i].input(want)
    await waitForData(edit, function (d) {
      return String(d.skuRows[i].alertQty) === want
    }, '第 ' + (i + 1) + ' 格（' + rows[i].specText + '）的预警填成 ' + want)
    alertOf[String(rows[i].specText)] = Number(want)
  }

  await tapWhen(edit, '.js-pe-save')
  // 同 runCategories：先等账本，再等页面。页面跳不跳走取决于 save() 抛没抛错，
  // 而抛错被 mock 掉的 toast 吃了，只等页面的话两种原因报的是同一句话。
  const saved = await waitForLists(miniProgram, function (lists) {
    return lists.products.some(function (item) { return item.name === name })
  }, '新建的商品落进账本')
  const listAfterSave = await waitForPage(miniProgram, 'pages/products/products', '保存后退回商品页')

  const created = saved.products.find(function (item) { return item.name === name })
  assert.ok(created, '保存之后账本里没有这件商品')
  assert.strictEqual(created.salePrice, 25, '售价没存进去')
  const createdSkus = skusOf(saved, created.id).filter(function (item) { return !item.isBlank })
  assert.strictEqual(createdSkus.length, 4,
    '两色两码应当落 4 个规格格，实为 ' + createdSkus.length + ' 个：'
      + JSON.stringify(createdSkus.map(function (s) { return s.color + '/' + s.size })))
  const combos = createdSkus.map(function (s) { return s.color + '/' + s.size }).sort()
  assert.deepStrictEqual(combos, ['红/M', '红/S', '蓝/M', '蓝/S'].sort(),
    '落盘的规格组合不是那四格：' + JSON.stringify(combos))
  // 建档件数一律 0（稿 UX注释 n9「建档初始 0。改数只走库存修正门」）。
  createdSkus.forEach(function (item) {
    assert.strictEqual(item.stock, 0,
      '规格「' + item.color + '/' + item.size + '」建档时不该有件数，实为 ' + item.stock
        + '（5a 批起件数只读，进货或库存修正才写它）')
  })
  // 逐格把预警数对回来。specText 的拼法由 inventory.specText 决定，这里按「两个取值
  // 都出现在里面」来配对，不去复刻它的分隔符 —— 复刻就是转写，分隔符一改就假绿。
  Object.keys(alertOf).forEach(function (specText) {
    const hit = createdSkus.filter(function (item) {
      return String(specText).indexOf(item.color) >= 0 && String(specText).indexOf(item.size) >= 0
    })
    assert.strictEqual(hit.length, 1,
      '规格「' + specText + '」在落盘的格子里配到 ' + hit.length + ' 个，应当正好 1 个：'
        + JSON.stringify(combos))
    assert.strictEqual(hit[0].alertQty, alertOf[specText],
      '规格「' + specText + '」的预警数没有逐格落盘：编辑器里填的是 ' + alertOf[specText]
        + '，账本里是 ' + hit[0].alertQty
        + '（矩阵里某一行的数据被丢掉时就是这个样子 —— 只对组合名是查不出来的）')
  })

  // 货号行的空分支（2026-09-01，稿 n12「product.sku 为空则整行不渲染」）。
  // 种子里五件商品全带货号，只有本用例自己建的这件没填 —— 空分支只有在这里测得到。
  // 顺序上必须放在删除之前：删掉之后这件商品就不在列表里了。
  await waitPageReady(listAfterSave)
  await typeInto(listAfterSave, '.js-product-search', name, '商品搜索（货号空态）', 'keyword')
  await waitForData(listAfterSave, function (d) {
    return d.list && d.list.length === 1 && d.list[0].id === created.id
  }, '商品列表收敛到刚建的这件（没填货号的那件）')
  const cardNoSku = await listAfterSave.data()
  assert.ok(!cardNoSku.list[0].sku,
    '前提：本用例建的这件商品不该有货号，实为 ' + JSON.stringify(cardNoSku.list[0].sku))
  assert.strictEqual(cardNoSku.list[0].skuText, '',
    '没填货号时 cardViewOf 该给空串（给出「货号 undefined」「货号 」都是这里红）')
  assert.deepStrictEqual(await textsOf(listAfterSave, '.js-product-sku'), [],
    '没填货号就整行不渲染：屏幕上不该有 .js-product-sku 节点'
      + '（wx:if 被摘掉、或换成 hidden，这里都会红）')
  // 把搜索框清回去，不给后面的用例留一个只剩一条的列表。
  await typeInto(listAfterSave, '.js-product-search', '', '清空商品搜索', 'keyword')

  // 删掉自己造的这件商品：既覆盖删除路径（wx.showModal 由 mockWxMethod 自动确认），
  // 也不给后面的用例留垃圾。
  const back = await goto(miniProgram, 'navigateTo',
    '/pages/product-edit/product-edit?id=' + created.id, '商品编辑页（删除）')
  await waitForData(back, function (d) {
    return d.id === created.id && d.isEdit === true
  }, '编辑页停在刚建的这件商品上')
  await tapWhen(back, '.js-pe-remove')
  const cleaned = await waitForLists(miniProgram, function (lists) {
    return !lists.products.some(function (item) { return item.id === created.id })
  }, '这件商品从账本里删掉')
  await waitForPage(miniProgram, 'pages/products/products', '删除后退回商品页')
  assert.ok(
    !cleaned.products.some(function (item) { return item.id === created.id }),
    '删除之后账本里还留着这件商品'
  )
}

// ---- 种类模板 -------------------------------------------------------------

// 种类只是「建档时带出名称和规格待选项」的模板，不是库存分类。这条用例走它的
// 四件事：列表渲染、改一个（加一条商品名待选项并落盘）、新增一个、把新增的删掉。
// 进页面走的是真实入口 —— 商品编辑页种类那一行的「管理」。
async function runCategories(miniProgram) {
  step('种类模板：列表渲染、编辑加一条待选项、新增一个再删掉')
  const before = await readLists(miniProgram)
  assert.ok(before.categories.length >= 2, '前提：种子里应当有两个种类模板')

  const edit = await goto(miniProgram, 'navigateTo', '/pages/product-edit/product-edit', '商品编辑页（进种类管理）')
  await waitForData(edit, function (d) {
    return d && d.isEdit === false
  }, '停在新增模式')
  // 5a 批起「管理模板」在规格编辑器卡里（稿 4:117），先展开折叠索引第一行。
  await tapWhen(edit, '.js-pe-fold-spec')
  await waitForData(edit, function (d) {
    return d.specOpen === true
  }, '展开规格编辑器')
  await tapWhen(edit, '.js-pe-categories')
  const list = await waitForPage(miniProgram, 'pages/categories/categories', '种类模板列表')
  await waitForData(list, function (d) {
    return d.list && d.list.length === before.categories.length
  }, '种类列表读完')
  assert.deepStrictEqual(
    await textsOf(list, '.js-category-name'),
    (await list.data()).list.map(function (item) { return String(item.name) }),
    '种类列表屏幕上的名字和 data.list 对不上')

  // 改一个：加一条商品名待选项，保存，从账本里核对真的落了盘。
  const first = (await list.data()).list[0]
  await tapNth(list, '.js-category-item', 0, '第一个种类')
  const one = await waitForPage(miniProgram, 'pages/category-edit/category-edit', '种类编辑页')
  await waitForData(one, function (d) {
    return d.id === first.id
  }, '种类编辑页带上了 id')
  const newName = 'UI 待选项'
  // B12 起「＋ 添加」是一枚 chip，点了原位变成输入框（稿 chips/商品名 4:615），
  // 回车 / 失焦提交。automator 的 el.input 只触发 bindinput，不会触发 confirm 或 blur，
  // 所以和上面 addSpec 那处（商品编辑页的规格取值）一样直接 callMethod 走提交。
  await tapWhen(one, '.js-ce-name-add')
  await typeInto(one, '.js-ce-name-input', newName, '商品名待选项输入框', 'nameInput')
  await one.callMethod('commitName')
  await waitForData(one, function (d) {
    return (d.names || []).indexOf(newName) >= 0
  }, '待选项加进列表')
  assert.ok(
    (await textsOf(one, '.js-ce-name-chip')).some(function (text) {
      return text.indexOf(newName) >= 0
    }),
    '待选项加进了 data 却没画在屏幕上'
  )
  await tapWhen(one, '.js-ce-save')
  // 先等账本落盘（提交到底成没成），再等页面跳走。顺序反过来的话，校验没过和路由被吞
  // 会报同一句话 —— 见 waitForLists 上方那段。
  const afterEdit = await waitForLists(miniProgram, function (lists) {
    const hit = lists.categories.find(function (item) { return item.id === first.id })
    return !!(hit && hit.names.indexOf(newName) >= 0)
  }, '保存后账本里这个种类多出「' + newName + '」这条待选项')
  await waitForPage(miniProgram, 'pages/categories/categories', '保存后退回种类列表')
  const savedCat = afterEdit.categories.find(function (item) { return item.id === first.id })
  assert.ok(savedCat && savedCat.names.indexOf(newName) >= 0,
    '保存之后账本里这个种类没有「' + newName + '」这条待选项：'
      + JSON.stringify(savedCat && savedCat.names))

  // 新增一个，再删掉：把「建 / 删」这条路径也走一遍，同时把账本还原成种子的样子。
  await tapWhen(list, '.js-category-add')
  const fresh = await waitForPage(miniProgram, 'pages/category-edit/category-edit', '种类编辑页（新增）')
  await waitForData(fresh, function (d) {
    return d && d.isEdit === false
  }, '停在新增模式')
  // 【只填名字必须存得下去】inventory.createCategory 对非 plain 的种类要求至少一个
  // 规格取值（否则抛「请添加规格」）。这条是 2026-08-31 第二轮实测撞出来的，别去掉。
  // B12 起 productKind 不再是页面上的开关（稿 Screen/16 上没有这个控件），而是从
  // 「有没有规格取值」和「半成品池开不开」推出来的：新建页一个取值都没有，推出来就是
  // plain，所以这里只核对推导结果，不再需要先点一下「普通」。推导错了就存不下去。
  await waitForData(fresh, function (d) {
    return d.productKind === 'plain'
  }, '新建的模板默认推成「普通」')
  const catName = 'UI 临时种类'
  await typeInto(fresh, '.js-ce-name', catName, '种类名称', 'name')
  await tapWhen(fresh, '.js-ce-save')
  const added = await waitForLists(miniProgram, function (lists) {
    return lists.categories.some(function (item) { return item.name === catName })
  }, '新增的种类落进账本')
  await waitForPage(miniProgram, 'pages/categories/categories', '新增保存后退回种类列表')
  const createdCat = added.categories.find(function (item) { return item.name === catName })
  assert.ok(createdCat, '新增之后账本里没有这个种类')
  assert.strictEqual(added.categories.length, before.categories.length + 1,
    '新增之后种类应当多一个')

  // 列表要先刷新出新增的那一条，才谈得上按下标点它 —— 直接 findIndex 会拿到 -1，
  // 然后在 nodes[-1] 上炸一句看不出原因的 TypeError。
  await waitForData(list, function (d) {
    return (d.list || []).some(function (item) { return item.id === createdCat.id })
  }, '种类列表刷新出刚新增的那一条')
  const createdAt = (await list.data()).list.findIndex(function (item) {
    return item.id === createdCat.id
  })
  assert.ok(createdAt >= 0, '种类列表里找不到刚新增的那一条')
  await tapNth(list, '.js-category-item', createdAt, '刚新增的那个种类')
  const toRemove = await waitForPage(miniProgram, 'pages/category-edit/category-edit', '种类编辑页（删除）')
  await waitForData(toRemove, function (d) {
    return d.id === createdCat.id && d.isEdit === true
  }, '停在刚新增的那个种类上')
  await tapWhen(toRemove, '.js-ce-remove')
  const finalLists = await waitForLists(miniProgram, function (lists) {
    return !lists.categories.some(function (item) { return item.id === createdCat.id })
  }, '临时种类从账本里删掉')
  await waitForPage(miniProgram, 'pages/categories/categories', '删除后退回种类列表')
  assert.strictEqual(finalLists.categories.length, before.categories.length,
    '删掉临时种类之后应当回到 ' + before.categories.length + ' 个')
  await backToTabRoot(miniProgram)
}

// ---- 建店 / 选店 / 成员 ---------------------------------------------------

// 【放在最末尾是有意的】通过 UI 建店会**换账套**（store.js 的 memoryCall
// createShop 分支：换 shopId、清空内存账本、装一本空账），所以它一跑，前面所有
// 用例的数据前提就没了。放在 runNativeClearModal 之后，账本本来就已经清空。
//
// 【内存模式能测到哪儿，如实说】resetStorage 注入的是内存账本，memoryCall 里：
//   · listShops 只回**当前这一家**（所以「我加入的店」永远只有一行，
//     「选店」只能点回自己，验的是 selectShop → ensureReady 这条链没断，
//     验不了真正的切店）；
//   · listMembers 固定回一个店主「测试店主」；
//   · addMember / removeMember / deleteShop 一律抛「本地测试账本不能改成员 / 删店」。
// 所以成员这一段只验**渲染和权限位**（店主看得到添加店员那张卡），
// **不验加减成员** —— 那条路在内存模式下根本走不通，硬测只会测出那句抛错。
async function runShopAndMembers(miniProgram) {
  step('店铺与成员：核对本店与成员名单的渲染，再通过 UI 建一家新店（会换账套，所以放最后）')
  const before = await readLists(miniProgram)

  const home = await goto(miniProgram, 'switchTab', '/pages/index/index', '看板')
  await waitPageReady(home)
  await tapWhen(home, '.js-shop')
  const shop = await waitForPage(miniProgram, 'pages/shop/shop', '店铺页')
  await waitPageReady(shop)
  await waitForData(shop, function (d) {
    return d.hasCurrentShop === true && d.shops && d.shops.length > 0
  }, '店铺页读到了当前店')
  assert.strictEqual(await textOf(shop, '.js-shop-current', '当前店名'), before.shopName,
    '店铺页头卡印的店名和账本里的对不上')

  // 选店：内存模式下列表里只有当前这一家，点它验的是 selectShop → ensureReady
  // 这条链没断（点完仍然停在店铺页、当前店没变），验不了真正的切店。
  const shopId = (await shop.data()).currentShopId
  await tapNth(shop, '.js-shop-item', 0, '店铺列表第一行')
  await waitForData(shop, function (d) {
    return d.currentShopId === shopId && d.pageLoading === false
  }, '点当前这家店之后仍然停在这家店上')

  // 成员名单
  await tapWhen(shop, '.js-shop-members')
  const members = await waitForPage(miniProgram, 'pages/members/members', '成员名单')
  await waitPageReady(members)
  await waitForData(members, function (d) {
    return d.members && d.members.length > 0
  }, '成员名单读完')
  const memberData = await members.data()
  assert.strictEqual(memberData.members.length, 1,
    '内存模式的 listMembers 固定回一个店主，实为 ' + memberData.members.length + ' 人')
  assert.strictEqual(memberData.isOwner, true, '内存模式下当前用户应当是店主')
  const cards = await members.$$('.js-member-card')
  assert.strictEqual(cards.length, 1, '成员卡片渲染出 ' + cards.length + ' 张，data 里只有 1 人')
  assert.ok((await textOf(members, '.js-member-name', '成员称呼')).indexOf('测试店主') >= 0,
    '成员卡片上没印出称呼「测试店主」')
  assert.ok((await textOf(members, '.js-member-role', '成员角色')).indexOf('店主') >= 0,
    '成员卡片上没印出角色「店主」')
  // 店主才看得到「添加店员」那张卡 —— 这是权限位的渲染，能验；
  // 真去点添加会撞上「本地测试账本不能改成员」，那条不测（见函数上方）。
  await waitFor(members, '.js-member-add', '店主看得到「添加店员」按钮')
  await goBackTo(miniProgram, '店铺页')

  // 改名：点链接 → 改字 → 保存 → 头卡与 storage 都换成新名。
  // 内存模式的 memoryCall renameShop 只动 SHOP_NAME_KEY，不换账套，
  // 所以这一段跑完后面的建店步骤前提不变。
  await tapWhen(shop, '.js-shop-rename')
  await waitForData(shop, function (d) {
    return d.renaming === true && d.renameName === before.shopName
  }, '改名展开并带出当前店名')
  const renamedTo = 'UI 改名店'
  await typeInto(shop, '.js-shop-rename-input', renamedTo, '新店名', 'renameName')
  await tapWhen(shop, '.js-shop-rename-save')
  await waitForData(shop, function (d) {
    return d.shopName === renamedTo && d.renaming === false && d.pageLoading === false
  }, '改名之后当前店名换了、展开体收起了')
  assert.strictEqual(await textOf(shop, '.js-shop-current', '当前店名'), renamedTo,
    '改名之后头卡没换成新店名')
  const afterRename = await readLists(miniProgram)
  assert.strictEqual(afterRename.shopName, renamedTo, '改名之后 storage 里的店名没换')
  assert.strictEqual(afterRename.shopId, before.shopId, '改名不许换 shopId')
  assert.strictEqual(afterRename.products.length, before.products.length,
    '改名不许动账本，商品数变了：' + afterRename.products.length)

  // 建店：展开「再建一家」→ 填名字 → 创建并进入。
  await tapWhen(shop, '.js-shop-create-toggle')
  await waitForData(shop, function (d) {
    return d.showCreate === true
  }, '展开「再建一家」')
  const newShopName = 'UI 第二家店'
  await typeInto(shop, '.js-shop-name', newShopName, '新店名', 'newShopName')
  await tapWhen(shop, '.js-shop-create')
  await waitForData(shop, function (d) {
    return d.shopName === newShopName && d.currentShopId !== shopId && d.pageLoading === false
  }, '建店之后当前店换成了新店')
  assert.strictEqual(await textOf(shop, '.js-shop-current', '当前店名'), newShopName,
    '建店之后头卡没换成新店名')

  const after = await readLists(miniProgram)
  assert.strictEqual(after.shopName, newShopName, '建店之后 storage 里的店名没换')
  assert.notStrictEqual(after.shopId, before.shopId, '建店之后 shopId 应当换一个')
  assert.strictEqual(after.products.length, 0,
    '新建的店应当是一本空账，却带出了 ' + after.products.length + ' 件商品')
  await goBackTo(miniProgram, '看板')
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
    // 【WECHAT_UI_ONLY：只跑其中几段，**调试专用**】
    // 一整轮二十多分钟，为了调一段用例等二十分钟是不值的。所以留一个逗号分隔的白名单，
    // 段名就是下面 STEPS 里的 key（如 WECHAT_UI_ONLY=convert,purchase）。
    //
    // 两条纪律写在这里，别指望人自觉：
    //   · 种子那一段**永远跑**，白名单管不到它 —— 后面每一段都建立在种子的数据前提上；
    //   · 只要用了这个开关，日志开头会大声打一行，而且**PR / 验收证据必须是完整一轮**。
    //     部分绿不能当整轮绿用，那正是「绿的测试不等于有效的测试」的另一种形状。
    const STEPS = [
      ['record-sheet', runRecordSheet],
      ['purchase', runPurchase],
      ['sale', runSalePickerAndSlip],
      ['record-slip', runRecordSlipExport],
      ['return', runSaleReturn],
      // 必须在 return 之后：本用例末尾会真提交一单，成为账本里最新的 out 流水；
      // runSaleReturn 靠 latestOfType 认定「最新销售单」是谁，插到它前面会把那条
      // 前提改错。详见函数定义处的注释。
      ['sale-multi', runSaleMultiSelect],
      ['adjust', runAdjust],
      ['stock-take', runStockTake],
      ['convert', runConvert],
      ['product-detail', runProductDetail],
      ['product-edit', runProductEdit],
      ['categories', runCategories],
      ['opening', runOpeningSheet],
      ['pay', runPaySheet],
      ['records-more', runRecordsLoadMore],
      ['ledger-more', runCustomerLedgerLoadMore],
      ['clear', runNativeClearModal],
      ['shop', runShopAndMembers]
    ]
    const only = String(process.env.WECHAT_UI_ONLY || '').split(',').map(function (name) {
      return name.trim()
    }).filter(Boolean)
    if (only.length) {
      const known = STEPS.map(function (pair) { return pair[0] })
      only.forEach(function (name) {
        assert.ok(known.indexOf(name) >= 0,
          'WECHAT_UI_ONLY 里的「' + name + '」不是已知的段名。可用：' + known.join(', '))
      })
      step('⚠ WECHAT_UI_ONLY=' + only.join(',') + ' —— 这是**部分**用例，只能用来调试。'
        + '种子那一段照跑（后面每一段都依赖它）。验收证据必须是不带这个环境变量的完整一轮')
    }

    // 【顺序不是随便排的，改之前先读这段】
    //   · runRecordSheet 必须紧跟种子：收款 picker 只列有欠款的客户、退货 picker
    //     只列还能退的销售单，种子刚灌完那一刻是这两个 picker 唯一确定的前提；
    //   · runPurchase 放在销售之前：它只动矿泉水的库存和进价，不碰销售用例点的那个商品；
    //   · runSaleReturn 必须在 runSalePickerAndSlip 之后：它要退的「挂欠单」正是
    //     那一步做出来的「一分未收」那张（用例里有断言把这个前提钉住）；
    //   · runProductEdit / runCategories 自己造的东西自己删掉，不给后面留垃圾；
    //   · runShopAndMembers 必须**最后**：通过 UI 建店会换账套、清空内存账本，
    //     一跑前面所有用例的数据前提就全没了。
    await seedFromHome(miniProgram)
    for (let i = 0; i < STEPS.length; i++) {
      if (only.length && only.indexOf(STEPS[i][0]) < 0) continue
      await STEPS[i][1](miniProgram)
    }
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
  28,
  // 4 处是最早的 tap 跳转；3 处是「记一笔」面板三个 picker 的落点
  //（customer-edit / sale-return / adjust）—— 面板的全部意义就是把人送到这三页；
  // 20 处是 2026-08-31 那一批新覆盖（进货 / 退货 / 库存调整 / 换规格 /
  // 商品详情四个动作按钮 / 商品编辑 / 种类模板 / 建店与成员）各自的落点确认；
  // 1 处是 B4 批新增的盘点流程：确认调整成功后自动 navigateBack 回看板，
  // runStockTake 里用 waitForPage(miniProgram, 'pages/index/index', ...) 验这个退栈。
  '自检：waitForPage 的字面量调用点应当正好 28 处，实为 '
    + waitForPageTargets.length + ' 处：' + JSON.stringify(waitForPageTargets)
    + ' —— 数目对不上说明要么正则失效了（钉子④是假绿的），要么调用点增减了，两种都要人看一眼'
)

var gotoTargets = []
reGoto.lastIndex = 0
while ((hit = reGoto.exec(routeSource)) !== null) gotoTargets.push(hit[1])
assert.strictEqual(
  gotoTargets.length,
  27,
  // 8 处最早就有；2 处是 runRecordSheet 进看板和 runRecordSheetFabEntry 进流水页；
  // 12 处是 2026-08-31 那一批新覆盖自己的入口（含 readCustomerDebts 前后两次进客户页）；
  // 2 处是 A3 批返工时把误判栈深的 goBackTo（switchTab 进流水/客户页之后，栈深恒为 1，
  // 没有「上一页」可退）改成的 switchTab（runRecordSheetFabEntry 结尾回看板、
  // runRecordsLoadMore 结尾回客户页）；
  // 2 处是 B4 批新增的 runStockTake：switchTab 进看板起步，navigateTo 带 id 进盘点页；
  // 1 处是批 2/2026-09-02 新增的 runSaleMultiSelect：navigateTo 进销售页测规格多选。
  '自检：goto 的字面量调用点应当正好 27 处，实为 ' + gotoTargets.length + ' 处：'
    + JSON.stringify(gotoTargets)
    + ' —— 数目对不上说明要么正则失效了（钉子④是假绿的），要么调用点增减了，两种都要人看一眼'
)

// 钉子⑩：Windows 直接调用那条路的**解析**必须真的从本机的 cli.bat 里读出四样东西。
//
// 【为什么要钉】runCli 现在不经 cmd.exe：它从 cli.bat 里解析 Electron 探测规则
//（>N 字节 + 排除名单）、BOOTSTRAP_JS、index.js 相对路径，再自己 spawn。解析不出来时
// 代码会**静默**回落到内置默认值，再不行才回落到 cmd.exe 老路 —— 回落本身是对的
//（不能因为工具换了个格式就整轮跑不起来），但「一直在用内置默认值」这件事必须有人看见，
// 否则工具升级之后我们是拿一份过期的转写在跑，而症状会是别的样子（连不上 / 起不来端口）。
//
// 【局限，别高估】它只验解析，不验 spawn 出来的东西真的能跑 —— 那只有真跑一次才知道。
// 工具没装（找不到 cli）时整条跳过：这是本机环境，不是代码问题，红在这里没有意义。
;(function nailCliBatParse() {
  if (!isWindows) return
  if (process.env.WECHAT_CLI_DIRECT === '0') return
  const cli = resolveCliPath()
  if (!cli) {
    step('钉子⑩：本机找不到开发者工具的 cli，跳过 cli.bat 解析自检')
    return
  }
  const parsed = parseCliBat(cli)
  assert.ok(
    parsed,
    '钉子⑩：从 ' + cli + ' 里解析不出启动参数了（BOOTSTRAP_JS / CLI 入口 / exe 体积门槛 /'
      + ' exe 排除名单，四样缺一即判失败）。开发者工具多半升级换了 cli.bat 的写法。'
      + '代码会静默回落到内置默认值（CLI_FALLBACK）继续跑，但那份是 2026-08-31 抄下来的，'
      + '过期了就会以「连不上 / 端口起不来」的样子发作。请照新版 cli.bat 更新 parseCliBat '
      + '的正则和 CLI_FALLBACK，别直接删这条钉子。'
  )
  assert.ok(
    parsed.bootstrap.indexOf('process.argv') >= 0 && parsed.bootstrap.indexOf('require(e)') >= 0,
    '钉子⑩：解析出来的 BOOTSTRAP_JS 不像那段 bootstrap（应当重写 process.argv 再 require 入口），'
      + '实为：' + JSON.stringify(parsed.bootstrap.slice(0, 120))
  )
})()

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
  console.error('   被 cmd 误解析、把注释里的 CLI 当命令又调回自己（bat 里就有 set "CLI=..." 这个变量名）。')
  console.error('   注意两点更正：① cli.bat 本身现在是 UTF-8 编码不是 GBK（2026-08-31 实测）；')
  console.error('   ② 「把安装目录从子进程 PATH 摘掉」这条老修复对现在这版**无效** —— 误解析发生在')
  console.error('   第 7 行 cd /d "%~dp0" 之后，此刻 cwd 就是安装目录，而 cmd 解析裸命令先查当前目录、')
  console.error('   再查 PATH，摘 PATH 摘不掉 cwd 那一跳。')
  console.error('   现在的做法是**根本不经 cmd.exe / cli.bat**：从 cli.bat 里解析出 Electron 探测规则、')
  console.error('   BOOTSTRAP_JS 和 index.js 路径，自己 spawn electron（ELECTRON_RUN_AS_NODE=1）。')
  console.error('   日志开头那行「CLI 走直接调用 / CLI 回落到 cmd.exe + cli.bat 老路」说的就是走了哪条。')
  console.error('   要强制走老路（对拍用）设 WECHAT_CLI_DIRECT=0；老路上再撞见递归风暴会当场报错，')
  console.error('   不会再刷屏刷满 3 分钟才报一句指不出原因的「等 cli auto 结束超时」')
  console.error('6. 端口和超时可用 WECHAT_AUTOMATOR_PORT / _PORT_TIMEOUT / _CONNECT_TIMEOUT /')
  console.error('   _STEP_TIMEOUT（单步，默认 30 秒）/ _RUN_TIMEOUT（整轮，默认 30 分钟）/')
  console.error('   _CLOSE_TIMEOUT（收尾关工具，默认 20 秒）/ _SCRIPT_TIMEOUT（整个脚本，默认 45 分钟）覆盖')
  console.error('7. 工具刚打开项目时 Tool.getInfo 不带 SDKVersion，automator 的版本校验会崩，')
  console.error('   脚本里已经等它出现再校验')
  console.error('8. wx.showModal 是系统弹窗，自动化点不到内部按钮，脚本里用 mockWxMethod 自动确认')
  console.error('9. 【2026-08-31 已解除】送货单弹层曾经开着 virtualHost，页面级选择器够不着')
  console.error('   （page.$$ / >>> / selectComponent 实测都是 0），那时用例只能核对页面数据里的 slip。')
  console.error('   现在 virtualHost 已摘掉、两个引用点带上了 id="slip-overlay"，用例升回核对渲染：')
  console.error('   走 slipHost(page) 取 CustomElement，再在实例上查 .js-slip-* 子元素（见 9b）。')
  console.error('   要是这里报「找不到 #slip-overlay 宿主节点」，多半是有人把 virtualHost 加回去了 ——')
  console.error('   tests/slip-image.test.js 末尾那条静态钉子会先红，先看 npm test')
  console.error('9b. 自定义组件里的元素，一律走组件实例自己的 $ / $$：先用页面查宿主 id 拿到')
  console.error('    CustomElement，再在它上面查子元素。不要用页面级的「选择器 >>> 子选择器」——')
  console.error('    >>> 右边只吃单个简单选择器，吃不了两级后代链，而且吃不下时不报错：实测')
  console.error('    「宿主 >>> .rs-row .rs-label」静默降级成宿主本身，返回 1 个节点、')
  console.error('    text() 是整个面板拼成的一串。记一笔面板那组用例首跑就栽在这里。')
  console.error('    依据：automator out/Element.js 里 CustomElement extends Element，两个查询都走')
  console.error('    Element.getElement(s) 且以该元素为作用域，后代链正常')
  console.error('    注意 9 和 9b 是两个不同的坑，别混（这条**仍然有效**，只是两边现在都没开')
  console.error('    virtualHost 了）：开着 virtualHost 时页面侧**根本没有**宿主节点，三种写法')
  console.error('    都是真的 0，红得干脆；没开时宿主在、>>> 能锚上、然后静默降级成宿主本身，')
  console.error('    返回 1 个错节点，绿着骗人。所以「查不到组件里的东西」不能一律按同一个原因查：')
  console.error('    先看组件的 options 里有没有 virtualHost，再决定是加 id 还是改写法。')
  console.error('    第 9 条那条用例正是靠「摘 virtualHost + 加 id」升回核对渲染的，不是靠改选择器写法')
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
