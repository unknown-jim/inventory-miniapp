const fs = require('fs')
const automator = require('miniprogram-automator')
const ENV = 'cloud1-d3g8tukt6525022b6'
try {
  const MP = require('miniprogram-automator/out/MiniProgram').default
  const orig = MP.prototype.checkVersion
  MP.prototype.checkVersion = async function () {
    for (let i = 0; i < 30; i++) {
      try { return await orig.call(this) } catch (e) { await new Promise(r => setTimeout(r, 2000)) }
    }
    return true
  }
} catch (e) {}
async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
  console.log('[drv] 已连接')
  const body = fs.readFileSync(process.argv[2], 'utf8')
  const out = await mp.evaluate(new Function('ENV', 'return (' + body + ')(ENV)'), ENV)
  console.log('RESULT_JSON_START')
  console.log(JSON.stringify(out, null, 2))
  console.log('RESULT_JSON_END')
  try { await mp.disconnect() } catch (e) {}
  process.exit(0)
}
main().catch(e => { console.error('[drv] 失败:', e && (e.stack || e.message || e)); process.exit(1) })
