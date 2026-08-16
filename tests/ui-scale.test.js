const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function walk(dir, out, ext) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out, ext)
      return
    }
    if (!ext || path.extname(entry.name) === ext) out.push(full)
  })
}

assert.ok(
  !fs.existsSync(path.join(root, 'utils/ui-scale.js')),
  'utils/ui-scale.js should be removed'
)

const appWxss = read('app.wxss')
assert.ok(appWxss.indexOf('--fs-md:') >= 0, 'app.wxss should define type tokens')
assert.ok(appWxss.indexOf('--tap-lg:') >= 0, 'app.wxss should define tap tokens')
assert.ok(appWxss.indexOf('--space-xs:') >= 0, 'app.wxss should define --space-xs')
assert.ok(appWxss.indexOf('--space-sm:') >= 0, 'app.wxss should define --space-sm')
assert.ok(appWxss.indexOf('--space-md:') >= 0, 'app.wxss should define --space-md')
assert.ok(appWxss.indexOf('--space-lg:') >= 0, 'app.wxss should define --space-lg')
assert.ok(appWxss.indexOf('--space-xl:') >= 0, 'app.wxss should define --space-xl')
assert.ok(appWxss.indexOf('--page-pad:') >= 0, 'app.wxss should define --page-pad')
assert.ok(appWxss.indexOf('--card-pad:') >= 0, 'app.wxss should define --card-pad')
assert.ok(appWxss.indexOf('--gap:') >= 0, 'app.wxss should define --gap')
assert.ok(appWxss.indexOf('.stat-grid') >= 0, 'app.wxss should define .stat-grid')
assert.ok(appWxss.indexOf('.action-strip') >= 0, 'app.wxss should define .action-strip')
assert.ok(appWxss.indexOf('.field-row') >= 0, 'app.wxss should define .field-row')
assert.ok(appWxss.indexOf('.seg') >= 0, 'app.wxss should define .seg')
assert.ok(appWxss.indexOf('.page.ui-std') < 0, 'app.wxss should not define ui-std')
assert.ok(appWxss.indexOf('.page.ui-xl') < 0, 'app.wxss should not define ui-xl')

const xsMatch = appWxss.match(/--fs-xs:\s*(\d+)rpx/)
assert.ok(xsMatch, 'app.wxss should define --fs-xs in rpx')
const minFont = Number(xsMatch[1])

const indexWxml = read('pages/index/index.wxml')
assert.ok(indexWxml.indexOf('显示大小') < 0, 'home page should not expose 显示大小')
assert.ok(indexWxml.indexOf('uiScaleClass') < 0, 'home page should not bind uiScaleClass')
assert.ok(indexWxml.indexOf('class="page"') >= 0, 'home page root should be class="page"')

const project = JSON.parse(read('project.config.json'))
const include = ((project.packOptions && project.packOptions.include) || [])
  .map(function (item) {
    return typeof item === 'string' ? item : item.value
  })
  .join('\n')
assert.ok(include.indexOf('ui-scale.js') < 0, 'packOptions.include should not list ui-scale.js')

const appJson = JSON.parse(read('app.json'))
const pages = appJson.pages.slice()
assert.ok(pages.length > 0, 'app.json pages should not be empty')

pages.forEach(function (page) {
  const js = read(page + '.js')
  const wxml = read(page + '.wxml')
  assert.ok(js.indexOf('ui-scale') < 0, page + ' should not require ui-scale')
  assert.ok(js.indexOf('uiScale') < 0, page + ' should not use uiScale behavior')
  assert.ok(wxml.indexOf('uiScaleClass') < 0, page + ' should not bind uiScaleClass')
  assert.ok(wxml.indexOf('class="page"') >= 0, page + ' root should be class="page"')
})

const sourceDirs = ['pages', 'utils']
const forbiddenHits = []
sourceDirs.forEach(function (dir) {
  const files = []
  walk(path.join(root, dir), files)
  files.forEach(function (file) {
    const rel = path.relative(root, file).replace(/\\/g, '/')
    if (rel.indexOf('pages/common/') === 0) return
    const src = fs.readFileSync(file, 'utf8')
    if (src.indexOf('ui-std') >= 0) forbiddenHits.push(rel + ' contains ui-std')
    if (src.indexOf('显示大小') >= 0) forbiddenHits.push(rel + ' contains 显示大小')
    if (src.indexOf('ui-scale.js') >= 0) forbiddenHits.push(rel + ' contains ui-scale.js')
  })
})
assert.strictEqual(forbiddenHits.length, 0, 'operation UI should not keep scale runtime:\n' + forbiddenHits.join('\n'))

const redefHits = []
const pageWxss = []
walk(path.join(root, 'pages'), pageWxss, '.wxss')
pageWxss.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = fs.readFileSync(file, 'utf8')
  if (/^\s*\.(field-row|pay-tabs|stat-grid)\b/m.test(src)) redefHits.push(rel)
})
assert.strictEqual(
  redefHits.length,
  0,
  'page wxss should not redefine .field-row / .pay-tabs / .stat-grid:\n' + redefHits.join('\n')
)

const tinyHits = []
const wxssFiles = [path.join(root, 'app.wxss')]
walk(path.join(root, 'pages'), wxssFiles, '.wxss')
wxssFiles.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (rel.indexOf('pages/common/') === 0) return
  const src = fs.readFileSync(file, 'utf8')
  const re = /font-size:\s*(\d+)rpx/g
  let match
  while ((match = re.exec(src))) {
    if (Number(match[1]) < minFont) tinyHits.push(rel + ' font-size:' + match[1] + 'rpx')
  }
})
assert.strictEqual(
  tinyHits.length,
  0,
  'operation UI should not use font-size below --fs-xs (' + minFont + 'rpx):\n' + tinyHits.join('\n')
)

console.log('ui-scale tests passed')
