// 用 miniprogram-automator 驱动开发者工具，在小程序运行时里发云函数调用。
// 连接逻辑抄自 tests/ui.test.js（同一套 cli auto + connect 的踩坑修法）。
const childProcess = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')
const automator = require('miniprogram-automator')

const projectPath = process.env.PROJECT || 'D:\work\inventory-miniapp'
const port = 9420
const ENV = 'cloud1-d3g8tukt6525022b6'

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function step(s) { console.log('[drv] ' + s) }

function resolveCliPath() {
  const p = process.env.WECHAT_CLI || 'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat'
  return fs.existsSync(p) ? p : ''
}
function portOpen(p) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port: p })
    s.on('connect', () => { s.destroy(); res(true) })
    s.on('error', () => res(false))
    setTimeout(() => { s.destroy(); res(false) }, 1500)
  })
}
async function startAutoPort(cliPath) {
  const dir = path.dirname(cliPath)
  const env = Object.assign({}, process.env)
  env.PATH = (env.PATH || '').split(';').filter(x => x && path.resolve(x) !== path.resolve(dir)).join(';')
  const args = ['/c', '"' + cliPath + '" auto --project "' + projectPath + '" --auto-port ' + port]
  const child = childProcess.spawn('cmd.exe', args, { env: env, windowsVerbatimArguments: true, stdio: 'ignore', detached: false })
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (await portOpen(port)) return child
    await sleep(2000)
  }
  throw new Error('自动化端口 ' + port + ' 没开起来')
}
function patchCheckVersion() {
  try {
    const MP = require('miniprogram-automator/out/MiniProgram').default
    if (MP && MP.prototype && MP.prototype.checkVersion) {
      MP.prototype.checkVersion = async function () { return true }
    }
  } catch (e) { /* 版本不同就算了 */ }
}

async function main() {
  const cli = resolveCliPath()
  if (!cli) throw new Error('找不到 cli.bat')
  step('起自动化端口 ' + port)
  if (!(await portOpen(port))) await startAutoPort(cli)
  patchCheckVersion()
  step('连接 ws://127.0.0.1:' + port)
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:' + port })
  step('已连接')
  const payloadPath = process.argv[2]
  const body = fs.readFileSync(payloadPath, 'utf8')
  const out = await mp.evaluate(new Function('ENV', 'return (' + body + ')(ENV)'), ENV)
  console.log('RESULT_JSON_START')
  console.log(JSON.stringify(out, null, 2))
  console.log('RESULT_JSON_END')
  try { await mp.disconnect() } catch (e) {}
  process.exit(0)
}
main().catch(e => { console.error('[drv] 失败:', e && (e.stack || e.message || e)); process.exit(1) })
