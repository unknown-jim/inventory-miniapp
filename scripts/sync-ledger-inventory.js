const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const destDir = path.join(root, 'cloudfunctions', 'ledger')

const files = ['inventory.js', 'ledger-apply.js']

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true })
}

files.forEach(function (name) {
  const src = path.join(root, 'utils', name)
  const dest = path.join(destDir, name)
  if (!fs.existsSync(src)) {
    throw new Error('missing ' + src)
  }
  fs.copyFileSync(src, dest)
  console.log('copied utils/' + name + ' -> cloudfunctions/ledger/' + name)
})
