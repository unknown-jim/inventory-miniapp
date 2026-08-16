const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cloudConfig = require('../utils/cloud-config')

if (cloudConfig.isConfigured()) {
  assert.ok(cloudConfig.getCloudEnvId().length > 0)
} else {
  assert.ok(cloudConfig.missingMessage().indexOf('无法记账') >= 0)
  assert.ok(cloudConfig.missingMessage().indexOf('cloud-config.js') >= 0)
}

const root = path.join(__dirname, '..')
const forbidden = /wx\.cloud\.database\s*\(/

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      return
    }
    if (path.extname(entry.name) === '.js') out.push(full)
  })
}

const files = []
walk(path.join(root, 'pages'), files)
walk(path.join(root, 'utils'), files)
const appJs = path.join(root, 'app.js')
if (fs.existsSync(appJs)) files.push(appJs)

const hits = []
files.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = fs.readFileSync(file, 'utf8')
  if (forbidden.test(src)) hits.push(rel)
})

assert.strictEqual(
  hits.length,
  0,
  'miniprogram must not call wx.cloud.database() on business collections:\n' + hits.join('\n')
)

console.log('no-client-cloud-db: ' + files.length + ' files ok')
