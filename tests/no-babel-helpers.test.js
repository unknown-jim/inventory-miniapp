const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

function walkJs(dir, out) {
  if (!fs.existsSync(dir)) return
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkJs(full, out)
      return
    }
    if (path.extname(entry.name) === '.js') out.push(full)
  })
}

function collectFiles() {
  const files = []
  walkJs(path.join(root, 'pages'), files)
  walkJs(path.join(root, 'utils'), files)
  walkJs(path.join(root, 'components'), files)
  const appJs = path.join(root, 'app.js')
  if (fs.existsSync(appJs)) files.push(appJs)
  return files
}

function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (block) {
      return block.replace(/[^\n]/g, ' ')
    })
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

const checks = [
  { name: 'object rest/spread', re: /\{\s*\.\.\./ },
  { name: 'array spread', re: /\[\s*\.\.\./ },
  { name: 'computed property', re: /[{,]\s*\[[^\]]+\]\s*:/ },
  { name: 'optional chaining', re: /\?\./ },
  { name: 'nullish coalescing', re: /\?\?/ }
]

const hits = []

collectFiles().forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = stripNoise(fs.readFileSync(file, 'utf8'))
  checks.forEach(function (check) {
    if (check.re.test(src)) hits.push(rel + ': ' + check.name)
  })
})

assert.strictEqual(
  hits.length,
  0,
  'syntax that WeChat babel may compile with @babel/runtime helpers:\n' + hits.join('\n')
)

console.log('no-babel-helpers: ' + collectFiles().length + ' files ok')
