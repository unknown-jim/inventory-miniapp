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
  ;['pages', 'utils', 'styles', 'components'].forEach(function (dir) {
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
  return (
    rel.indexOf('utils/') === 0 ||
    rel.indexOf('pages/') === 0 ||
    rel.indexOf('styles/') === 0 ||
    rel.indexOf('components/') === 0
  )
}

function listImmediateDirs(rel) {
  const full = path.join(root, rel)
  if (!fs.existsSync(full)) return []
  return fs.readdirSync(full, { withFileTypes: true })
    .filter(function (entry) {
      return entry.isDirectory()
    })
    .map(function (entry) {
      return entry.name
    })
}

function resolveComponentBase(fromFile, spec) {
  const trimmed = String(spec || '').trim()
  if (!trimmed) return null
  if (trimmed.charAt(0) === '/') return path.join(root, trimmed.slice(1))
  return path.resolve(path.dirname(fromFile), trimmed)
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
assert.strictEqual(tabList.length, 4, 'tabBar should have 4 items')
assert.deepStrictEqual(
  tabList.map(function (item) { return item.text }),
  ['看板', '商品', '流水', '客户']
)
assert.deepStrictEqual(
  tabList.map(function (item) { return item.pagePath }),
  [
    'pages/index/index',
    'pages/products/products',
    'pages/records/records',
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

// --- 原生外壳的颜色 -------------------------------------------------------
// 这一组守的是 WXSS 够不着的地方：导航栏、tabBar 的文字色、以及 tabBar 图标
// **像素本身**。它们只在 app.json 和 PNG 里，A1（主题绑 token）当时把整个
// app.json 划出了范围，A3（tabBar 5→4）沿用旧图标画法并登记为「不足」，于是
// 13 个批次逐个把它标成「原生外壳，实现侧不动」跳过——直到真机上看见「顶部
// 还是绿的、tab 图标还是绿的」才发现。没有断言守着，它就会再漏一次。
const BRAND_TEAL = [0x0F, 0x76, 0x6E]     // 旧品牌青绿，主行动改黑后全站不该再有
const TAB_ON = [0x17, 0x17, 0x17]         // 稿 text/primary 3:23
const TAB_OFF = [0x6F, 0x6F, 0x6F]        // 稿 text/muted 3:79（#171717 @62%）白底合成

assert.strictEqual(appJson.window.navigationBarBackgroundColor, '#FFFFFF',
  '导航栏底色要跟稿的 navbar/自定义（4:69 绑 3:13 = 白）一致，不要回退成品牌青绿')
assert.strictEqual(appJson.window.navigationBarTextStyle, 'black',
  '白底导航栏的标题必须是 black；留成 white 会得到白底白字')
assert.strictEqual(appJson.tabBar.selectedColor, '#171717',
  'tabBar 选中态跟稿 3:23 一致。裁定「tabBar 不上品牌色」见 docs/design-file.md')
assert.strictEqual(appJson.tabBar.color, '#6F6F6F',
  'tabBar 未选中态是 text/muted 在白底上的合成值')

// 只认 8 位 RGBA、非隔行、单/多 IDAT —— 本仓库四组 tab 图标都是这个形状。
// 形状变了就抛，不要静默跳过：静默跳过的颜色检查等于没有检查。
function dominantColorOf(rel) {
  const buf = fs.readFileSync(path.join(root, rel))
  assert.strictEqual(buf[24], 8, rel + ' 不是 8 位深，颜色检查失效')
  assert.strictEqual(buf[25], 6, rel + ' 不是 RGBA（colorType 6），颜色检查失效')
  assert.strictEqual(buf[28], 0, rel + ' 是隔行 PNG，本解码器不支持')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const parts = []
  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    if (buf.toString('ascii', off + 4, off + 8) === 'IDAT') parts.push(buf.slice(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = require('zlib').inflateSync(Buffer.concat(parts))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      } else if (filter !== 0) throw new Error(rel + ' 未知 PNG filter ' + filter)
      out[y * stride + x] = v & 0xFF
    }
  }
  const tally = new Map()
  for (let i = 0; i < out.length; i += bpp) {
    if (out[i + 3] < 128) continue
    const key = out[i] + ',' + out[i + 1] + ',' + out[i + 2]
    tally.set(key, (tally.get(key) || 0) + 1)
  }
  let best = null, bestN = 0
  tally.forEach(function (n, key) { if (n > bestN) { bestN = n; best = key } })
  return best ? best.split(',').map(Number) : null
}

tabList.forEach(function (item) {
  ;[[item.selectedIconPath, TAB_ON, '选中'], [item.iconPath, TAB_OFF, '未选中']].forEach(function (pair) {
    const got = dominantColorOf(pair[0])
    assert.deepStrictEqual(got, pair[1],
      pair[0] + '（' + pair[2] + '态）主色应为 rgb(' + pair[1] + ')，实测 rgb(' + got + ')')
    assert.notDeepStrictEqual(got, BRAND_TEAL, pair[0] + ' 还是旧的品牌青绿')
  })
})

// tabBar 5→4（A3 批）：进货、销售撤出一级导航，改由看板「记一笔」+ 流水页 FAB 承载。
// 它们**不再是 tab 页**，但**必须仍在 pages 数组里**（AGENTS.md：不要顺手挪进分包）。
// 这两条一起钉：只钉前者，有人把页面删了不会红；只钉后者，有人把 tab 加回来不会红。
;['pages/purchase/purchase', 'pages/sale/sale'].forEach(function (page) {
  assert.ok(
    (appJson.pages || []).indexOf(page) >= 0,
    page + ' 必须留在 app.json 的 pages 数组里（撤出 tabBar 不等于挪出主包）'
  )
  assert.ok(
    !tabList.some(function (item) { return item.pagePath === page }),
    page + ' 已在 A3 批撤出 tabBar，不要加回 tabBar.list'
  )
})

listImmediateDirs('pages').forEach(function (name) {
  const registered = (appJson.pages || []).some(function (page) {
    return page === 'pages/' + name + '/' + name || page.indexOf('pages/' + name + '/') === 0
  })
  assert.ok(registered, 'pages/' + name + ' is not in app.json; code quality flags unused page files')
})

assert.ok(!fs.existsSync(path.join(root, 'pages/common')), 'do not keep include fragments in pages/common')
assert.ok(!fs.existsSync(path.join(root, 'styles/slip.wxss')), 'slip overlay styles belong in components/slip-overlay')
assert.ok(!included['styles/slip.wxss'], 'packOptions.include should not list styles/slip.wxss')
assert.ok(!included['pages/common/slip-overlay.wxml'], 'packOptions.include should not list slip-overlay.wxml')
assert.ok(!included['pages/common/page-loading.wxml'], 'packOptions.include should not list page-loading.wxml')

const includeHits = []
const unusedDecls = []
const missingComponentFiles = []
const usedComponents = {}
const pageJsonFiles = []
walkDir(path.join(root, 'pages'), pageJsonFiles)
pageJsonFiles.forEach(function (file) {
  if (path.extname(file) !== '.json') return
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  const wxmlPath = file.replace(/\.json$/, '.wxml')
  const wxml = fs.existsSync(wxmlPath) ? fs.readFileSync(wxmlPath, 'utf8') : ''
  if (/<(include|import)\b/.test(wxml)) includeHits.push(toProjectRel(wxmlPath))
  const placeholders = json.componentPlaceholder || {}
  assert.ok(!placeholders['page-loading'], toProjectRel(file) + ' should not placeholder first-screen page-loading')
  const comps = json.usingComponents || {}
  Object.keys(comps).forEach(function (tag) {
    if (wxml.indexOf('<' + tag) < 0) {
      unusedDecls.push(toProjectRel(file) + ' unused usingComponents.' + tag)
    }
    const base = resolveComponentBase(file, comps[tag])
    const rel = toProjectRel(base)
    usedComponents[rel] = true
    ;['.js', '.json', '.wxml', '.wxss'].forEach(function (ext) {
      if (!fs.existsSync(base + ext)) missingComponentFiles.push(rel + ext)
    })
    if (fs.existsSync(base + '.json')) {
      const compJson = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
      assert.strictEqual(compJson.component, true, rel + ' should set component: true')
    }
  })
})

if (fs.existsSync(path.join(root, 'components'))) {
  const componentFiles = []
  walkDir(path.join(root, 'components'), componentFiles)
  componentFiles.forEach(function (file) {
    if (path.extname(file) === '.wxml' && /<(include|import)\b/.test(fs.readFileSync(file, 'utf8'))) {
      includeHits.push(toProjectRel(file))
    }
  })
}

assert.strictEqual(
  includeHits.length,
  0,
  'WXML include/import is invisible to the unused-file scan:\n' + includeHits.join('\n')
)
assert.strictEqual(unusedDecls.length, 0, unusedDecls.join('\n'))
assert.strictEqual(missingComponentFiles.length, 0, 'component file missing:\n' + missingComponentFiles.join('\n'))

const unusedComponentDirs = []
listImmediateDirs('components').forEach(function (name) {
  const rel = 'components/' + name + '/index'
  if (!usedComponents[rel]) unusedComponentDirs.push(rel)
})
assert.strictEqual(unusedComponentDirs.length, 0, 'unreferenced component:\n' + unusedComponentDirs.join('\n'))
assert.ok(usedComponents['components/page-loading/index'], 'page-loading should be declared on a page')
assert.ok(usedComponents['components/slip-overlay/index'], 'slip-overlay should be declared on a page')

console.log('pack-refs: ' + Object.keys(included).length + ' include entries ok')
