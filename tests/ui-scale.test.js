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
assert.ok(
  !/(^|[,>+~\s])\*\s*[{,]/.test(appWxss),
  'app.wxss should not use universal selector * (WXSS does not compile it)'
)
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
assert.ok(indexWxml.indexOf('流水与毛利汇总') < 0, 'home page should not link 流水与毛利汇总')
assert.ok(indexWxml.indexOf('客户管理') < 0, 'home page should not link 客户管理')
assert.ok(indexWxml.indexOf('种类模板') < 0, 'home page should not link 种类模板')
assert.ok(indexWxml.indexOf('进货入库') < 0, 'home page should not show 进货入库')
assert.ok(indexWxml.indexOf('销售出库') < 0, 'home page should not show 销售出库')
assert.ok(indexWxml.indexOf('js-clear') < 0, 'home page should not have js-clear')
assert.ok(indexWxml.indexOf('js-restore') < 0, 'home page should not have js-restore')
assert.ok(indexWxml.indexOf('bindtap="goMembers"') < 0, 'home page should not bind goMembers')
assert.ok(indexWxml.indexOf('class="action-strip"') < 0, 'home page should not use action-strip')
assert.ok(indexWxml.indexOf('js-shop') >= 0, 'home page should have js-shop')
assert.ok(indexWxml.indexOf('今日看板') >= 0, 'home page should show 今日看板')
assert.ok(indexWxml.indexOf('去收款') >= 0, 'home page should keep 去收款')
assert.ok(indexWxml.indexOf('js-seed') >= 0, 'home page should keep js-seed')
assert.ok(indexWxml.indexOf('pageLoading') >= 0, 'home page should gate content on pageLoading')
assert.ok(indexWxml.indexOf('<page-loading') >= 0, 'home page should use shared loading view')
const loadingWxml = read('components/page-loading/index.wxml')
assert.ok(loadingWxml.indexOf('js-page-loading') >= 0, 'loading view should expose js-page-loading')
assert.ok(loadingWxml.indexOf('正在加载') >= 0, 'loading view should say 正在加载')
assert.ok(indexWxml.indexOf('填充示例数据') >= 0, 'home page should keep 填充示例数据')
assert.ok(indexWxml.indexOf('新增商品') >= 0, 'home page should keep 新增商品')
assert.ok(indexWxml.indexOf('查看全部') >= 0, 'home page should keep 查看全部')
assert.ok(indexWxml.indexOf('bindtap="goRecords"') >= 0, 'home page should bind goRecords')

const indexJs = read('pages/index/index.js')
assert.ok(indexJs.indexOf('pageLoading: true') >= 0, 'home page should start in loading state')
assert.ok(indexJs.indexOf('isEmpty: false') >= 0, 'home page should not treat unloaded ledger as empty')

const tabPages = [
  'pages/index/index',
  'pages/products/products',
  'pages/purchase/purchase',
  'pages/sale/sale',
  'pages/customers/customers'
]
tabPages.forEach(function (page) {
  const wxml = read(page + '.wxml')
  const js = read(page + '.js')
  assert.ok(
    wxml.indexOf('<page-loading') >= 0,
    page + ' should use shared loading view'
  )
  assert.ok(js.indexOf('pageLoading: true') >= 0, page + ' should start in loading state')
  assert.ok(js.indexOf('store.isReady()') >= 0, page + ' should wait for ledger before showing data')
})

const storeJs = read('utils/store.js')
assert.ok(storeJs.indexOf('function isReady(') >= 0, 'store should expose isReady')
assert.ok(storeJs.indexOf('isReady: isReady') >= 0, 'store should export isReady')

const shopWxml = read('pages/shop/shop.wxml')
assert.ok(shopWxml.indexOf('js-clear') >= 0, 'shop page should have js-clear')
assert.ok(shopWxml.indexOf('js-restore') >= 0, 'shop page should have js-restore')
assert.ok(shopWxml.indexOf('js-delete-shop') >= 0, 'shop page should have js-delete-shop')
assert.ok(shopWxml.indexOf('成员名单') >= 0, 'shop page should keep 成员名单')
assert.ok(shopWxml.indexOf('hasCurrentShop') >= 0, 'shop page current header should require membership')
assert.ok(shopWxml.indexOf('<page-loading') >= 0, 'shop page should use shared loading view')
assert.ok(shopWxml.indexOf('pageLoading') >= 0, 'shop page should gate content on pageLoading')
assert.ok(shopWxml.indexOf('shopsReady') < 0, 'shop page should not use a separate shopsReady empty card')
const shopJs = read('pages/shop/shop.js')
assert.ok(shopJs.indexOf('pageLoading: true') >= 0, 'shop page should start in loading state')
assert.ok(shopJs.indexOf('isEmpty: false') >= 0, 'shop page should not treat unloaded ledger as empty')
assert.ok(
  /async onShow\(\) \{[\s\S]*?pageLoading:\s*true[\s\S]*?listShops/.test(shopJs),
  'shop onShow should hide shop UI until listShops returns'
)
assert.ok(shopWxml.indexOf('shopsLoadError') >= 0, 'shop page should have a shops load error state')
assert.ok(shopWxml.indexOf('!shops.length && !hasCurrentShop') >= 0, 'empty onboarding should not run when current shop is known')
assert.ok(shopJs.indexOf('retryShops') >= 0, 'shop page should retry shops after load error')
assert.ok(shopJs.indexOf('hasCurrentShop: !!status.shopId') >= 0, 'listShops failure should still treat a selected shop as current')
assert.ok(shopWxml.indexOf('加入别人的店') >= 0, 'shop page should offer 加入别人的店')
assert.ok(shopWxml.indexOf('我的 openid') < 0, 'shop page should not title the identity block 我的 openid')
assert.ok(shopWxml.indexOf('流水与毛利汇总') < 0, 'shop page should not link 流水与毛利汇总')
const shopWxss = read('pages/shop/shop.wxss')
assert.ok(
  shopWxss.indexOf('.card + .card') >= 0 && shopWxss.indexOf('margin-top: var(--space-md)') >= 0,
  'shop page consecutive cards should keep vertical spacing'
)

const membersWxml = read('pages/members/members.wxml')
const membersJs = read('pages/members/members.js')
assert.ok(membersWxml.indexOf('<page-loading') >= 0, 'members page should use shared loading view')
assert.ok(membersWxml.indexOf('pageLoading') >= 0, 'members page should gate content on pageLoading')
assert.ok(membersJs.indexOf('pageLoading: true') >= 0, 'members page should start in loading state')
assert.ok(membersJs.indexOf('store.isReady()') >= 0, 'members page should wait for ledger before showing data')
assert.ok(membersWxml.indexOf('我的 openid') < 0, 'members page should not repeat identity copy')
assert.ok(membersWxml.indexOf('添加店员') >= 0, 'members page should say 添加店员')
assert.ok(membersWxml.indexOf('加入白名单') < 0, 'members page should not say 加入白名单')
assert.ok(membersJs.indexOf('还没写称呼') >= 0, 'empty display name should read 还没写称呼')

const saleWxml = read('pages/sale/sale.wxml')
const saleJs = read('pages/sale/sale.js')
const recordEditWxml = read('pages/record-edit/record-edit.wxml')
const recordEditJs = read('pages/record-edit/record-edit.js')
assert.ok(saleWxml.indexOf('点选本店成员，也可手写') >= 0, 'sale operator chips should say what they are')
assert.ok(recordEditWxml.indexOf('点选本店成员，也可手写') >= 0, 'record-edit operator chips should say what they are')
assert.ok(saleJs.indexOf("|| '未命名'") < 0, 'sale chips should not fall back to 未命名')
assert.ok(recordEditJs.indexOf("|| '未命名'") < 0, 'record-edit chips should not fall back to 未命名')
assert.ok(saleJs.indexOf("utils/member-chips") >= 0, 'sale should use shared member chips')
assert.ok(recordEditJs.indexOf("utils/member-chips") >= 0, 'record-edit should use shared member chips')
assert.ok(appWxss.indexOf('.field-input + .chips') >= 0, 'chips under an input should have a shared top gap')
assert.ok(appWxss.indexOf('.field-hint') >= 0, 'app.wxss should define .field-hint')

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

const sourceDirs = ['pages', 'utils', 'components']
const forbiddenHits = []
sourceDirs.forEach(function (dir) {
  const files = []
  walk(path.join(root, dir), files)
  files.forEach(function (file) {
    const rel = path.relative(root, file).replace(/\\/g, '/')
    if (rel.indexOf('components/slip-overlay/') === 0) return
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
if (fs.existsSync(path.join(root, 'components'))) walk(path.join(root, 'components'), wxssFiles, '.wxss')
wxssFiles.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  if (rel.indexOf('components/slip-overlay/') === 0) return
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

const productsWxss = read('pages/products/products.wxss')
assert.ok(
  productsWxss.indexOf('min-height: var(--tap-sm)') >= 0,
  'products.wxss toggle should use min-height: var(--tap-sm)'
)
assert.ok(productsWxss.indexOf('.bar-fill') < 0, 'products.wxss should not keep .bar-fill')

console.log('ui-scale tests passed')
