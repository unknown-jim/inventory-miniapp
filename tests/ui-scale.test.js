const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const store = {}

global.wx = {
  getStorageSync: function (key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''
  },
  setStorageSync: function (key, value) {
    store[key] = value
  }
}

global.Behavior = function (def) {
  return def
}

const uiScale = require('../utils/ui-scale')

assert.strictEqual(uiScale.DEFAULT, 'lg')
assert.deepStrictEqual(uiScale.LEVELS, ['std', 'lg', 'xl'])
assert.strictEqual(uiScale.readScale(), 'lg')
assert.strictEqual(uiScale.scaleClass(), 'ui-lg')

uiScale.writeScale('xl')
assert.strictEqual(store[uiScale.KEY], 'xl')
assert.strictEqual(uiScale.readScale(), 'xl')
assert.strictEqual(uiScale.scaleClass(), 'ui-xl')

uiScale.writeScale('std')
assert.strictEqual(uiScale.readScale(), 'std')

uiScale.writeScale('huge')
assert.strictEqual(uiScale.readScale(), 'std')

store[uiScale.KEY] = 'bad'
assert.strictEqual(uiScale.readScale(), 'lg')

assert.ok(uiScale.behavior, 'behavior should be defined')
assert.strictEqual(typeof uiScale.behavior.onShow, 'function')
assert.strictEqual(typeof uiScale.behavior.setUiScale, 'function')
assert.strictEqual(typeof uiScale.behavior.methods.setUiScale, 'function')

const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
const pages = appJson.pages.slice()
assert.ok(pages.length > 0, 'app.json pages should not be empty')

pages.forEach(function (page) {
  const js = fs.readFileSync(path.join(root, page + '.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8')
  assert.ok(js.indexOf("require('../../utils/ui-scale')") >= 0, page + ' should require ui-scale')
  assert.ok(js.indexOf('behaviors: [uiScale.behavior]') >= 0, page + ' should use ui-scale behavior')
  assert.ok(wxml.indexOf('class="page {{uiScaleClass}}"') >= 0, page + ' should bind uiScaleClass')
})

const indexWxml = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8')
assert.ok(indexWxml.indexOf('显示大小') >= 0, 'home page should expose display size')
assert.ok(indexWxml.indexOf('data-level="std"') >= 0, 'home page should offer 标准')
assert.ok(indexWxml.indexOf('data-level="lg"') >= 0, 'home page should offer 大')
assert.ok(indexWxml.indexOf('data-level="xl"') >= 0, 'home page should offer 更大')

const appWxss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8')
assert.ok(appWxss.indexOf('--fs-md:') >= 0, 'app.wxss should define type tokens')
assert.ok(appWxss.indexOf('--tap-lg:') >= 0, 'app.wxss should define tap tokens')
assert.ok(appWxss.indexOf('.page.ui-std') >= 0, 'app.wxss should define 标准 scale')
assert.ok(appWxss.indexOf('.page.ui-xl') >= 0, 'app.wxss should define 更大 scale')

function walkWxss(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkWxss(full, out)
      return
    }
    if (path.extname(entry.name) === '.wxss') out.push(full)
  })
}

const wxssFiles = [path.join(root, 'app.wxss')]
walkWxss(path.join(root, 'pages'), wxssFiles)

const tinyFont = /font-size:\s*(1[0-9]|2[0-7])rpx/
const tinyHits = []
wxssFiles.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (rel.indexOf('pages/common/') === 0) return
  const src = fs.readFileSync(file, 'utf8')
  if (tinyFont.test(src)) tinyHits.push(rel)
})
assert.strictEqual(
  tinyHits.length,
  0,
  'operation UI should not use font-size below 28rpx:\n' + tinyHits.join('\n')
)

console.log('ui-scale tests passed')
