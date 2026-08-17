const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
}

function walkDir(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDir(full, out)
      return
    }
    out.push(full)
  })
}

function collectSources() {
  const files = []
  ;['pages', 'utils', 'styles'].forEach(function (dir) {
    const full = path.join(root, dir)
    if (fs.existsSync(full)) walkDir(full, files)
  })
  ;['app.js', 'app.wxss', 'app.json'].forEach(function (name) {
    const full = path.join(root, name)
    if (fs.existsSync(full)) files.push(full)
  })
  return files
}

function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function toProjectRel(absPath) {
  return normalizeRel(path.relative(root, absPath))
}

function includeSet(packOptions) {
  const include = (packOptions && packOptions.include) || []
  const set = {}
  include.forEach(function (item) {
    const value = typeof item === 'string' ? item : item.value
    set[normalizeRel(value)] = true
  })
  return set
}

function appPageJsSet(appJson) {
  const set = {}
  ;(appJson.pages || []).forEach(function (page) {
    set[normalizeRel(page + '.js')] = true
  })
  const tabList = appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []
  tabList.forEach(function (item) {
    if (item.pagePath) set[normalizeRel(item.pagePath + '.js')] = true
  })
  return set
}

function isRelativeRequire(spec) {
  return spec.indexOf('./') === 0 || spec.indexOf('../') === 0
}

function resolveRequire(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec)
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target
  if (!path.extname(target) && fs.existsSync(target + '.js')) return target + '.js'
  return target
}

function resolveAsset(fromFile, spec) {
  const trimmed = String(spec || '').trim()
  if (!trimmed) return null
  if (trimmed.charAt(0) === '/') return path.join(root, trimmed.slice(1))
  return path.resolve(path.dirname(fromFile), trimmed)
}

function extractQuoted(src, re) {
  const out = []
  let match
  while ((match = re.exec(src))) out.push(match[2])
  return out
}

function mustPackInclude(rel) {
  return rel.indexOf('utils/') === 0 || rel.indexOf('pages/') === 0 || rel.indexOf('styles/') === 0
}

const project = readJson('project.config.json')
const appJson = readJson('app.json')
const included = includeSet(project.packOptions)
const appPages = appPageJsSet(appJson)
const missingFiles = []
const missingInclude = []

collectSources().forEach(function (file) {
  const ext = path.extname(file)
  const src = fs.readFileSync(file, 'utf8')
  const fromRel = toProjectRel(file)
  const refs = []

  if (ext === '.js') {
    extractQuoted(src, /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g).forEach(function (spec) {
      if (!isRelativeRequire(spec)) return
      refs.push({ kind: 'require', spec: spec, abs: resolveRequire(file, spec) })
    })
  } else if (ext === '.wxss') {
    extractQuoted(src, /@import\s+(['"])([^'"]+)\1\s*;/g).forEach(function (spec) {
      refs.push({ kind: 'import', spec: spec, abs: resolveAsset(file, spec) })
    })
  } else if (ext === '.wxml') {
    const wxmlRe = /<(include|import)\s+[^>]*src\s*=\s*(['"])([^'"]+)\2/g
    let match
    while ((match = wxmlRe.exec(src))) {
      refs.push({ kind: 'wxml', spec: match[3], abs: resolveAsset(file, match[3]) })
    }
  }

  refs.forEach(function (ref) {
    if (!ref.abs || !fs.existsSync(ref.abs) || !fs.statSync(ref.abs).isFile()) {
      missingFiles.push(fromRel + ' -> ' + ref.spec)
      return
    }
    const rel = toProjectRel(ref.abs)
    if (ref.kind === 'require') {
      if (!mustPackInclude(rel)) return
      if (appPages[rel]) return
    }
    if (!included[rel]) missingInclude.push(fromRel + ' -> ' + rel)
  })
})

assert.strictEqual(missingFiles.length, 0, 'referenced file missing on disk:\n' + missingFiles.join('\n'))
assert.strictEqual(missingInclude.length, 0, 'referenced file not in packOptions.include:\n' + missingInclude.join('\n'))

const tabList = appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []
assert.strictEqual(tabList.length, 5, 'tabBar should have 5 items')
assert.deepStrictEqual(
  tabList.map(function (item) { return item.text }),
  ['看板', '商品', '进货', '销售', '客户']
)
assert.deepStrictEqual(
  tabList.map(function (item) { return item.pagePath }),
  [
    'pages/index/index',
    'pages/products/products',
    'pages/purchase/purchase',
    'pages/sale/sale',
    'pages/customers/customers'
  ]
)
tabList.forEach(function (item) {
  assert.ok(item.iconPath && fs.existsSync(path.join(root, item.iconPath)), 'missing tab icon: ' + item.iconPath)
  assert.ok(
    item.selectedIconPath && fs.existsSync(path.join(root, item.selectedIconPath)),
    'missing selected tab icon: ' + item.selectedIconPath
  )
})

console.log('pack-refs: ' + Object.keys(included).length + ' include entries ok')
