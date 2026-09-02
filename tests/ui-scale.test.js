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
// 稿 Screen/01 的 hero 3:558 是「今日实收（元）」，「今日看板」四个字改版后
// 只留在 index.json 的 navigationBarTitleText 里，不在 wxml 上。
assert.ok(indexWxml.indexOf('今日实收（元）') >= 0, 'home hero should show 今日实收（元）')
assert.ok(indexWxml.indexOf('{{receivedText}}') >= 0, 'home hero should render receivedText')
// 稿 banner/debt 3:561 的文案是「N 位客户欠款共 ¥X」，在 index.js 里拼，
// wxml 上只有绑定；「去收款」那个桥挪到了流水详情（docs/design-file.md 硬约束）。
assert.ok(indexWxml.indexOf('{{debtBannerText}}') >= 0, 'home page should render debtBannerText')
assert.ok(indexWxml.indexOf('bindtap="goCustomers"') >= 0, 'debt banner should go to 客户 tab')
assert.ok(indexWxml.indexOf('js-seed') >= 0, 'home page should keep js-seed')
assert.ok(indexWxml.indexOf('pageLoading') >= 0, 'home page should gate content on pageLoading')
// 稿 caption 13:169 / 13:170：「看板落地用 Screen/00b 骨架，不要转圈占整页」。
// page-loading 组件本身没删，只是看板不再消费它（其余 5 个页面还在用）。
assert.ok(indexWxml.indexOf('<page-loading') < 0, 'home page should not use the spinner card')
assert.ok(indexWxml.indexOf('js-dash-skeleton') >= 0, 'home page should render the 00b skeleton')
assert.ok(
  JSON.parse(read('pages/index/index.json')).usingComponents['page-loading'] === undefined,
  'home page should not declare page-loading any more'
)
const loadingWxml = read('components/page-loading/index.wxml')
assert.ok(loadingWxml.indexOf('js-page-loading') >= 0, 'loading view should expose js-page-loading')
// 1a 批：加载态改成稿上的 state/loading（3:413）—— 一行式，spinner +「加载中…」。
// 旧文案是「正在加载」+「请稍候，正在读取本店账本。」两行整卡。
assert.ok(loadingWxml.indexOf('加载中') >= 0, 'loading view should say 加载中')
assert.ok(
  loadingWxml.indexOf('page-loading-spin') >= 0,
  'loading view should render the spinner element'
)

// 1a 批：全局阻断态组件（稿 Row/00「全局阻断态（4 种）」4:1099）。
const blockingWxml = read('components/state-blocking/index.wxml')
const blockingJs = read('components/state-blocking/index.js')
assert.ok(
  blockingWxml.indexOf('js-state-blocking') >= 0,
  'state-blocking should expose js-state-blocking'
)
// 1a 批执行备注（规格 §6.2 与 §10.1 内部矛盾的裁定）：组件文件顶部的注释**必须**提到
// virtualHost 这个词（说明为什么不开），词面 indexOf 会把注释误当字段拦下来。
// 这里只拦「virtualHost 后跟 ASCII 冒号」的字段赋值语法；注释里的「virtualHost。」
// 是全角句号，不匹配。意图与规格 §10.3 的变异验证一致：加 virtualHost: true 必须红。
assert.ok(
  !/virtualHost\s*:/.test(blockingJs),
  'state-blocking 不要开 virtualHost：开了 automator 从页面查不到卡片里的标题和按钮，'
    + 'record-sheet 和 slip-overlay 都为此摘掉过'
)
assert.ok(
  indexWxml.indexOf('<state-blocking') >= 0,
  'home page blocked branch should use the shared blocking card'
)
assert.ok(
  indexWxml.indexOf('还不能记账') < 0,
  '阻断态标题现在由 utils/messages.js 的 BLOCKING 表给，不再写死在 index.wxml 里'
)
assert.ok(indexWxml.indexOf('填充示例数据') >= 0, 'home page should keep 填充示例数据')
assert.ok(indexWxml.indexOf('新增商品') >= 0, 'home page should keep 新增商品')
// 稿 section/最新流水 3:573 右侧没有链接（流水本身是 tabBar 的一格）；
// 「全部 ›」是要补货标题行 11:100 的，进 Screen/01b。
assert.ok(indexWxml.indexOf('全部 ›') >= 0, 'home page should keep 要补货「全部 ›」')
assert.ok(indexWxml.indexOf('bindtap="goLowStock"') >= 0, 'home page should link 要补货 full list')
assert.ok(indexWxml.indexOf('bindtap="goRecords"') >= 0, 'home page should bind goRecords')

const indexJs = read('pages/index/index.js')
assert.ok(indexJs.indexOf('pageLoading: true') >= 0, 'home page should start in loading state')
assert.ok(indexJs.indexOf('isEmpty: false') >= 0, 'home page should not treat unloaded ledger as empty')

// pages/index 从这张表里摘出去：它的加载态改成了 Screen/00b 骨架屏，
// 不再消费 page-loading。另外两条约束（pageLoading 起手为 true、
// 拿到账本之前不显示数据）在下面单独钉。
const tabPages = [
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

assert.ok(indexJs.indexOf('store.isReady()') >= 0, 'home page should wait for ledger before showing data')

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

// 店铺改名（renameShop）的静态形状。全部是 indexOf 扫描：匹配完整语法形状
// （含 {{ }} 的属性写法），注释里出现同名字符串不算数。
assert.ok(shopWxml.indexOf('js-shop-rename') >= 0, 'shop page should have a rename entry link')
assert.ok(
  shopWxml.indexOf('js-shop-rename-input') >= 0 && shopWxml.indexOf('maxlength="16"') >= 0,
  'rename input should cap at 16 (native mirror of inventory.SHOP_NAME_MAX)'
)
assert.ok(
  shopWxml.indexOf('isOwner && !renaming') >= 0,
  'rename entry should be owner-gated in wxml (staff must not see 改名 at all)'
)
assert.ok(
  shopWxml.indexOf('js-shop-rename-save') >= 0
    && shopWxml.indexOf('disabled="{{!canSaveRename}}"') >= 0,
  'rename save should be disabled while the trimmed name is empty'
)
assert.ok(
  shopJs.indexOf('\n    renaming: false,') >= 0,
  'rename panel should start collapsed (renaming: false in page data)'
)
assert.ok(
  appWxss.indexOf('.row-link {') >= 0
    && read('pages/members/members.wxss').indexOf('.row-link {') < 0
    && shopWxss.indexOf('.row-link') < 0,
  '.row-link should be defined once in app.wxss — not copied into members or shop'
)
const shopCurrentLine = shopWxml.split('\n').filter(function (line) {
  return line.indexOf('js-shop-current"') >= 0
}).join('\n')
assert.ok(
  shopCurrentLine.indexOf("{{shopName || '未命名店铺'}}") >= 0,
  'js-shop-current 那一行只许绑店名本身（tests/ui.test.js 拿它的渲染文本和账本店名做严格相等）'
)
assert.ok(
  shopCurrentLine.indexOf('改名') < 0,
  '「改名」链接必须是 js-shop-current 的兄弟节点，不许塞进同一行'
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
  // 2a 批执行备注（规格内部矛盾的裁定）：这条断言的意图是拦「require 已删除的
  // ui-scale 运行时模块」（0a 批遗留）。规格 §7.3 给的 index.js 注释里合法引用了
  // docs/ui-scale.md 这份文档，宽字符串 indexOf 会把注释误当 require 拦下来
  // ——同 tests/ui-scale.test.js 里 state-blocking virtualHost 那条的同一个坑。
  // 收窄到 require 语句，意图不变：页面仍然不许 require ui-scale 模块。
  assert.ok(!/require\([^)]*ui-scale/.test(js), page + ' should not require ui-scale')
  assert.ok(js.indexOf('uiScale') < 0, page + ' should not use uiScale behavior')
  assert.ok(wxml.indexOf('uiScaleClass') < 0, page + ' should not bind uiScaleClass')
  assert.ok(wxml.indexOf('class="page"') >= 0, page + ' root should be class="page"')
})

// 单据版式类的豁免只认类名，不认整个文件/目录：docs/ui-scale.md 的规则是「送货单的单据版式
// 除外」，豁免的判据是版式性质，不是「长在 components/slip-overlay/ 这个目录里」——同一个
// 组件文件里给店主点的操作控件（.export-style 这类）不是单据版式，要跟其它操作界面一样受检。
// 名单按前缀写死：模仿纸单排布的类名（.slip 本身，以及 .slip- 开头的那些）继续豁免；
// 一条规则的选择器只要出现哪怕一个不是 .slip 前缀的类名，就整条规则照常受检——宁可少豁免、
// 不要看漏新增的操作控件类，方向跟「反过来做成白名单」正相反（那样会让新控件默认漏检）。
const SLIP_LAYOUT_SELECTOR = /^\.slip(-[\w-]*)?$/

// 前缀只是「版式性质」这条真判据的近似，而 .slip- 前缀里混着操作控件：.slip-btn 是底部
// 那两个按钮、.slip-actions 是它们的容器，按 docs/ui-scale.md 的判据它们不是单据版式，
// 却会被前缀捎带豁免。点名排除，别让近似判据放过真该受检的东西。
// 今天这两条规则里都没有 font-size，所以排除它们不会新增报错——加在这里是为了以后有人
// 往里写字号时能被拦住。
const SLIP_OPERATION_CLASSES = ['.slip-btn', '.slip-actions']

function isSlipLayoutSelector(selectorText) {
  return selectorText.split(',').every(function (single) {
    const classNames = single.match(/\.[\w-]+/g)
    if (!classNames || !classNames.length) return false
    return classNames.every(function (cls) {
      return SLIP_LAYOUT_SELECTOR.test(cls) && SLIP_OPERATION_CLASSES.indexOf(cls) < 0
    })
  })
}

// 把 wxss 源码里「选择器全部是单据版式类」的规则块整体挖掉（连大括号内容一起），剩下的文本
// （其余选择器的规则、注释、操作控件类）原样交给调用方继续检查。只对 wxss 做——js/wxml 没有
// 选择器概念，也就没有可豁免的东西，本来就不该整文件跳过。
function stripSlipLayoutRules(src) {
  return src.replace(/([^{}]+)\{[^{}]*\}/g, function (whole, selectorPart) {
    // selectorPart 是「上一个 } 到这条规则的 {」之间的全部文本，所以会捎带上一条规则后面的
    // 注释。两个方向都会出错：注释被连坐挖掉（于是注释里写的禁用词扫不到），而注释里只要
    // 出现任何带点号的 token（现有文件里就有 docs/ui-scale.md、.chip）又会让这条规则失去
    // 豁免。先把注释剥掉再判选择器，判完再把注释放回去。
    const comments = selectorPart.match(/\/\*[\s\S]*?\*\//g)
    const selectorOnly = selectorPart.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (!isSlipLayoutSelector(selectorOnly)) return whole
    return comments ? comments.join('\n') + '\n' : ''
  })
}

const sourceDirs = ['pages', 'utils', 'components']
const forbiddenHits = []
sourceDirs.forEach(function (dir) {
  const files = []
  walk(path.join(root, dir), files)
  files.forEach(function (file) {
    const rel = path.relative(root, file).replace(/\\/g, '/')
    const isSlipOverlayWxss = rel.indexOf('components/slip-overlay/') === 0 && path.extname(file) === '.wxss'
    const src = fs.readFileSync(file, 'utf8')
    const checked = isSlipOverlayWxss ? stripSlipLayoutRules(src) : src
    if (checked.indexOf('ui-std') >= 0) forbiddenHits.push(rel + ' contains ui-std')
    if (checked.indexOf('显示大小') >= 0) forbiddenHits.push(rel + ' contains 显示大小')
    if (checked.indexOf('ui-scale.js') >= 0) forbiddenHits.push(rel + ' contains ui-scale.js')
  })
})
assert.strictEqual(forbiddenHits.length, 0, 'operation UI should not keep scale runtime:\n' + forbiddenHits.join('\n'))

const redefHits = []
const pageWxss = []
walk(path.join(root, 'pages'), pageWxss, '.wxss')
pageWxss.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = fs.readFileSync(file, 'utf8')
  // 2a 批执行备注（规格内部矛盾的裁定）：这条断言拦的是「页面重定义共用类」，
  // 规格 §7.4 给的 index.wxss 注释里有一行以空白开头引用 .stat-grid 这个名字
  //（「.stat-grid 是 app.wxss 的共用类……」），词面正则会把注释误当选择器拦下来。
  // 收窄到定义语法（选择器名后面跟 { 或逗号），真正的重定义照样拦。
  // .press 进这张名单是因为它真出过事：index / low-stock / records / shop 各自定义过
  // 一份，前三份是 opacity: 0.72、shop 那份是 background，于是 13 处引用拿到两种效果，
  // 而背景色那种在卡内会因为卡的 28rpx 内边距铺不满，看着像一块没对齐的灰方块。
  if (/^\s*\.(field-row|pay-tabs|stat-grid|press)\s*[,{]/m.test(src)) redefHits.push(rel)
})
assert.strictEqual(
  redefHits.length,
  0,
  'page wxss should not redefine .field-row / .pay-tabs / .stat-grid / .press:\n' + redefHits.join('\n')
)

// .press 的实现方式本身也钉住：必须是透明度，不能回退成背景色。
// 背景色画在卡内行上会被卡的 28rpx 内边距夹住（铺不到卡边、圆角对不上），
// 而且会把 .debt-banner 自带的 amber-50 底盖成灰、让窄文字链的灰块谎称整行可点。
const pressRule = /\.press\s*\{([^}]*)\}/.exec(appWxss)
assert.ok(pressRule, 'app.wxss 必须定义唯一的 .press 按下态')
assert.ok(
  /opacity\s*:/.test(pressRule[1]),
  '.press 要用 opacity 表达按下，实为：' + pressRule[1].trim()
)
assert.ok(
  !/background\s*:/.test(pressRule[1]),
  '.press 不要用 background —— 卡内行会被卡的内边距夹住、自带底色的块会被盖掉，实为：' + pressRule[1].trim()
)

const tinyHits = []
const wxssFiles = [path.join(root, 'app.wxss')]
walk(path.join(root, 'pages'), wxssFiles, '.wxss')
if (fs.existsSync(path.join(root, 'components'))) walk(path.join(root, 'components'), wxssFiles, '.wxss')
wxssFiles.forEach(function (file) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const src = fs.readFileSync(file, 'utf8')
  const checked = rel.indexOf('components/slip-overlay/') === 0 ? stripSlipLayoutRules(src) : src
  const re = /font-size:\s*(\d+)rpx/g
  let match
  while ((match = re.exec(checked))) {
    if (Number(match[1]) < minFont) tinyHits.push(rel + ' font-size:' + match[1] + 'rpx')
  }
})
assert.strictEqual(
  tinyHits.length,
  0,
  'operation UI should not use font-size below --fs-xs (' + minFont + 'rpx):\n' + tinyHits.join('\n')
)

const productsWxss = read('pages/products/products.wxss')
// 3a 批（B3）：--tap-sm 是 A2 标为待删的旧别名（与 --tap-md 同值 96rpx），
// 两列图卡是新写的代码，直接绑文档档位名。
assert.ok(
  productsWxss.indexOf('min-height: var(--tap-md)') >= 0,
  'products.wxss card should use min-height: var(--tap-md)'
)
assert.ok(productsWxss.indexOf('goods-grid') >= 0, 'products.wxss should layout a two-column grid')
assert.ok(productsWxss.indexOf('width: 112rpx') < 0, 'products.wxss should not keep the small left thumbnail')
assert.ok(productsWxss.indexOf('.bar-fill') < 0, 'products.wxss should not keep .bar-fill')

// ---------------------------------------------------------------------------
// 2a 批：看板与「要补货」完整列表
// ---------------------------------------------------------------------------
const util = require('../utils/util')

// 稿 UX注释/要补货 9:46 的三 SKU 样张：
//   全棉斜纹布 · 本白/2.0m 剩 5 / 预警 8（缺口 3）
//   枕芯 · 48×74cm        剩 3 / 预警 6（缺口 3）
//   纯棉四件套 · 白色/2.0m 剩 8 / 预警 10（缺口 2）
// 排序：缺口大优先；同缺口按商品名 zh-CN 音序（全 quán < 枕 zhěn）；同名再按规格名。
// 行文案是 inventory.specText 的输出（色 · 码），与稿上的「本白/2.0m」是同一组值、
// 分隔符按仓库既有实现走，不为了对稿去改 specText。
const lowStockProducts = [
  { id: 'p-si', name: '纯棉四件套', colors: ['白色'], sizes: ['2.0m'], stock: 0, alertQty: 0 },
  { id: 'p-xw', name: '全棉斜纹布', colors: ['本白'], sizes: ['2.0m'], stock: 0, alertQty: 0 },
  { id: 'p-zx', name: '枕芯', colors: [], sizes: ['48×74cm'], stock: 0, alertQty: 0 },
  { id: 'p-ok', name: '库存充足的普通商品', colors: [], sizes: [], stock: 50, alertQty: 5 }
]
const lowStockSkus = [
  { id: 's-si', productId: 'p-si', color: '白色', size: '2.0m', stock: 8, alertQty: 10 },
  { id: 's-xw', productId: 'p-xw', color: '本白', size: '2.0m', stock: 5, alertQty: 8 },
  { id: 's-zx', productId: 'p-zx', color: '', size: '48×74cm', stock: 3, alertQty: 6 }
]
const lowRows = util.lowStockRows(lowStockProducts, lowStockSkus)
assert.deepStrictEqual(
  lowRows.map(function (row) { return row.productName }),
  ['全棉斜纹布', '枕芯', '纯棉四件套'],
  '要补货排序：缺口大优先，同缺口按商品名 zh-CN 音序（稿 UX注释 9:46）'
)
assert.deepStrictEqual(
  lowRows.map(function (row) { return row.gap }),
  [3, 3, 2],
  '缺口 = 预警 − 剩'
)
assert.strictEqual(lowRows[0].name, '全棉斜纹布 · 本白 · 2.0m', '行文案是「商品名 · 规格」')
assert.strictEqual(lowRows[0].remainText, '剩 5')
assert.strictEqual(lowRows[0].thresholdText, '/ 预警 8')
assert.strictEqual(lowRows.length, 3, '库存充足的商品不进这张表；粒度是规格不是商品')

// 待加工商品：blank sku 的 stock 对 **product.alertQty**（镜像 inventory.isLowStock 分支 1）
const blankRows = util.lowStockRows(
  [{ id: 'p-bk', name: '半成品布', blankProcess: true, colors: ['本白'], sizes: ['2.0m'], stock: 0, alertQty: 7 }],
  [{ id: 's-bk', productId: 'p-bk', isBlank: true, color: '', size: '', stock: 4, alertQty: 999 }]
)
assert.strictEqual(blankRows.length, 1, '待加工低于 product.alertQty 要进表')
assert.strictEqual(blankRows[0].name, '半成品布 · 待加工')
assert.strictEqual(blankRows[0].gap, 3, '待加工的阈值是 product.alertQty(7)，不是 sku.alertQty(999)')

// docs/ui-scale.md 的金额降档表，三档边界逐个钉
assert.strictEqual(util.heroAmountClass('¥3,860.00'), 'amount-hero', '9 字符走 80rpx 那一档')
assert.strictEqual(util.heroAmountClass('¥123456.78'), 'amount-hero', '10 字符仍是最大档')
assert.strictEqual(util.heroAmountClass('¥5,490,000.00'), 'amount-hero-md', '549 万 = 13 字符 -> 68rpx')
assert.strictEqual(util.heroAmountClass('¥54,900,000.00'), 'amount-hero-sm', '14 字符 -> 56rpx')
assert.strictEqual(util.heroAmountClass('—'), 'amount-hero', '算不出来时的「—」走最大档')
assert.strictEqual(util.statAmountClass('¥1,180.00'), 'amount-stat', '9 字符 -> --fs-display')
assert.strictEqual(util.statAmountClass('¥123456.78'), 'amount-stat-md', '10 字符 -> --fs-amount-lg')
assert.strictEqual(util.statAmountClass('¥5,490,000.00'), 'amount-stat-sm', '13 字符 -> --fs-amount-lg-sm')

// 降档 class 必须在页面 wxss 里真的定义，否则 JS 挑对了档屏上也没效果
const indexWxss = read('pages/index/index.wxss')
;['.amount-hero', '.amount-hero-md', '.amount-hero-sm', '.amount-stat', '.amount-stat-md', '.amount-stat-sm']
  .forEach(function (cls) {
    assert.ok(indexWxss.indexOf(cls + ' {') >= 0, 'index.wxss 缺少降档 class ' + cls)
  })
// 最高一档暂时是字面量 80rpx：--fs-hero 还是旧值 48rpx，翻值排给收尾批（A2 §8.3）。
// 收尾批翻完之后把这条断言改成检查 var(--fs-hero)。
assert.ok(
  /\.amount-hero \{\s*font-size: 80rpx;/.test(indexWxss),
  '看板 hero 最大档必须是 80rpx（docs/ui-scale.md 降档表），不许用 transform: scale'
)
assert.ok(indexWxss.indexOf('transform: scale') < 0, '金额降档不许用运行时缩放（docs/ui-scale.md 明令）')
assert.ok(indexWxss.indexOf('var(--fs-hero-md)') >= 0, '中间档要吃 --fs-hero-md')
assert.ok(indexWxss.indexOf('var(--fs-hero-sm)') >= 0, '最小档要吃 --fs-hero-sm')

// 骨架屏（稿 Screen/00b 13:216）：8 条灰条，色用 neutral/200，闪动用动效 token
assert.ok(indexWxss.indexOf('var(--color-neutral-200)') >= 0, '骨架屏灰条用 neutral/200')
assert.ok(indexWxss.indexOf('var(--duration-base)') >= 0, '骨架屏闪动用 --duration-base（稿 13:61）')
assert.ok(indexWxss.indexOf('var(--easing-standard)') >= 0, '骨架屏闪动用 --easing-standard')
const skelBars = (indexWxml.match(/skel-bar/g) || []).length
// 2a 批执行备注（规格内部矛盾的裁定）：规格 §0 与本断言原期望值都说稿 13:219 是
// 8 条灰条，但规格 §7.2 给的骨架 wxml 实际画了 9 个 skel-bar 元素
//（hero/cta/banner/两格 stat/两条小标题/restock/records —— 正是原断言消息里列的
// 那份清单，只是清单加出来是 9 不是 8；差的一条就是 stat 区拆成的两格）。
// wxss 的 .skel-stats 两格结构与 wxml 自洽，删哪一条都没有依据，
// 先按 wxml 实际元素数 9 钉住（删一条 / 加一条都会红，防漂移意图不变），
// 留发起人对稿复核 13:219 到底几条。
assert.strictEqual(skelBars, 9, '稿 13:219 骨架：hero/cta/banner/两格 stat/两条小标题/restock/records（规格 §7.2 实际 9 个元素；规格原文记 8 条，见执行备注）')

// 新增的三个颜色 token
;['--color-amber-600', '--color-red-600', '--color-green-700'].forEach(function (token) {
  assert.ok(appWxss.indexOf(token + ':') >= 0, 'app.wxss 缺少 2a 批的 ' + token)
})

// 01b 是独立页面，不是商品 tab 的筛选态（稿 7:270 没有 tabbar、navbar 带返回箭头）
const lowStockJson = JSON.parse(read('pages/low-stock/low-stock.json'))
assert.strictEqual(lowStockJson.navigationBarTitleText, '要补货', '稿 7:272 的 navbar 标题')
const lowStockWxml = read('pages/low-stock/low-stock.wxml')
assert.ok(lowStockWxml.indexOf('class="page"') >= 0, '01b 根节点要 class="page"')
// 2a 批执行备注（规格内部矛盾的裁定）：「行可点 -> 商品详情」的落点（url）在
// low-stock.js 的 goDetail 里，规格 §8.3 的 wxml 上只有 bindtap="goDetail"，
// 原断言查 wxml 必红。wxml 侧钉绑定、js 侧钉落点，意图不变。
assert.ok(lowStockWxml.indexOf('bindtap="goDetail"') >= 0, '01b 行可点（绑 goDetail）')
const lowStockJs = read('pages/low-stock/low-stock.js')
assert.ok(lowStockJs.indexOf('product-detail') >= 0, '01b 行可点 -> 商品详情（稿 9:45）')
assert.ok(lowStockWxml.indexOf('<page-loading') >= 0, '01b 用共用加载态')
const appJsonPages = JSON.parse(read('app.json')).pages
assert.ok(appJsonPages.indexOf('pages/low-stock/low-stock') >= 0, '01b 要登记进 app.json')
assert.ok(
  !(JSON.parse(read('app.json')).tabBar.list || []).some(function (item) {
    return item.pagePath === 'pages/low-stock/low-stock'
  }),
  '01b 是 navigateTo 的二级页，不许进 tabBar'
)

// ---------------------------------------------------------------------------
// 3a 批（B3）· 商品列表两列图卡（稿 Screen/02 = 3:577）
// 这一组钉的都是「看不见就会悄悄退回去」的事：FAB 复活、筛选退回两枚 chip、
// 空态退回单按钮、五色瓷砖丢失、青绿残留、旧字号别名回流、看板交接态复活。
// ---------------------------------------------------------------------------
const productsWxml = read('pages/products/products.wxml')
const productsPageJs = read('pages/products/products.js')

assert.ok(
  productsWxml.indexOf('js-product-add') >= 0 && productsWxml.indexOf('class="fab') < 0,
  '「＋ 新增商品」在搜索行里，不是 FAB（稿 UX 注释 13:165：FAB 全站只服务「记一笔」）'
)
assert.ok(
  productsWxss.indexOf('.fab') < 0,
  'products.wxss 不该再留 FAB 样式'
)
assert.ok(
  productsWxml.indexOf('seg-item') >= 0
    && productsWxml.indexOf('有半成品') >= 0
    && productsWxml.indexOf('低库存') >= 0,
  '筛选是稿上的三档 segment（全部 / 有半成品 / 低库存），不是两枚 chip'
)
assert.ok(
  productsWxml.indexOf('empty-icon-products') >= 0
    && productsWxml.indexOf('empty-actions') >= 0
    && productsWxml.indexOf('从模板建档') >= 0
    && productsWxml.indexOf('手动新增') >= 0,
  '无商品空态用 B1 交付的 state/empty/cta 形（稿 7:322：插画 + 标题 + 副行 + 两枚 CTA）'
)
assert.ok(
  productsWxss.indexOf('.tile-0') >= 0 && productsWxss.indexOf('.tile-4') >= 0,
  '无图占位的五色瓷砖（稿「规范/无图占位底色」3:821）落在 products.wxss 的 .tile-0 到 .tile-4'
)
assert.ok(
  productsWxss.indexOf('thumb-camera') >= 0,
  '无图占位右下要有相机角标（稿 camera 13:198）'
)

// ---------------------------------------------------------------------------
// 货号行（2026-09-01，稿 card/商品/1:1 的 sku 槽 19:32、UX注释 n12 = 19:34）。
// 四条各钉一层，任何一层退回去都红：wxml 有这一行 / 它是条件渲染 / 它的位置 / 取数与色档。
// ---------------------------------------------------------------------------
const skuRowLines = productsWxml.split('\n').filter(function (line) {
  return line.indexOf('class="item-sku') >= 0
})
assert.strictEqual(
  skuRowLines.length, 1,
  '商品卡的货号行应当正好一处（稿 sku 槽 19:32），实为 ' + skuRowLines.length + ' 处'
)
assert.ok(
  skuRowLines[0].indexOf('wx:if="{{item.skuText}}"') >= 0
    && skuRowLines[0].indexOf('hidden=') < 0,
  '货号行必须是 wx:if 条件渲染、不是 hidden：.goods-info 带 gap，hidden 的节点照样占一份间距，'
    + '没货号的卡会多出一段空隙 —— 稿 n12 要的是「整行不渲染、库存行上提」'
)
assert.ok(
  productsWxml.indexOf('class="item-name"') < productsWxml.indexOf('class="item-sku')
    && productsWxml.indexOf('class="item-sku') < productsWxml.indexOf('class="item-meta"'),
  '货号行夹在名称行与库存行之间（稿 19:32 在 name 与 meta 之间，y=193）'
)
assert.ok(
  productsPageJs.indexOf("skuText: product.sku ? '货号 ' + product.sku : ''") >= 0,
  '卡上的货号文案在 cardViewOf 里成型，空货号给空串 —— 和 product-detail.js:73 同一句形'
)
assert.ok(
  /\.item-sku\s*\{[^}]*var\(--fs-caption\)[^}]*\}/.test(productsWxss)
    && /\.item-sku\s*\{[^}]*var\(--color-text-muted\)[^}]*\}/.test(productsWxss),
  '.item-sku 走 12px 地板 --fs-caption + --color-text-muted（稿 sku 槽与 meta 同档，'
    + 'text/muted = VariableID:3:79 = #171717@62%）'
)
assert.ok(
  productsWxss.indexOf('#0F766E') < 0,
  'products.wxss 的两处青绿（原 .link 与 .fab）本批清干净，A1 规格把它划给了逐屏批'
)
assert.ok(
  productsWxss.indexOf('var(--fs-hero)') < 0 && productsWxss.indexOf('var(--tap-sm)') < 0,
  '.thumb-text 脱离 --fs-hero、.goods-card 脱离 --tap-sm（B2 规格 OQ-2 交给本批的那一处）'
)
// 3a 批执行备注（规格内部矛盾的裁定）：这条断言的意图是拦「products.js 再消费
// consumePendingInventoryFilter」（§8.3 变异 #4 加回 getApp().consumePendingInventoryFilter()
// 必须红），但规格 §7.1 给的 products.js 注释里合法提到了这个方法名（「所以这里不再
// consumePendingInventoryFilter」），宽 indexOf 会把注释误当调用拦下来 —— 同本文件
// state-blocking virtualHost 那条的同一个坑。收窄到「方法名后跟 ASCII 左括号」的调用
// 形态，意图不变：真加回调用照样红。
assert.ok(
  !/consumePendingInventoryFilter\s*\(/.test(productsPageJs),
  '看板不再带筛选进商品 tab（稿 caption 7:269 把「全部 ›」指向独立页 Screen/01b），'
    + '这个消费点在本批摘掉；app.js 那三个方法本批刻意留着，见规格 OQ-4'
)

// 02b 盘点是独立页面（稿 Screen/02b 4:893：navbar 带返回箭头、没有 tabbar），
// 不是 pages/adjust 的一个模式 —— 稿上 sheet/库存修正 4:31 的第二行和第三行是
// 两个并存的入口，合并会让同一个 URL 承载两张互相否定的皮。
const takeJson = JSON.parse(read('pages/stock-take/stock-take.json'))
assert.strictEqual(takeJson.navigationBarTitleText, '盘点', '盘点页的静态标题')
const takeWxml = read('pages/stock-take/stock-take.wxml')
assert.ok(takeWxml.indexOf('class="page"') >= 0, '02b 根节点要 class="page"')
assert.ok(takeWxml.indexOf('<page-loading') >= 0, '02b 用共用加载态')
assert.ok(takeWxml.indexOf('js-take-submit') >= 0, '02b 底栏要有「差异 N 处 · 确认调整」')
assert.ok(takeWxml.indexOf('js-take-exit') >= 0, '02b 底栏要有「退出」（稿 4:1003 两钮并排）')
assert.ok(takeWxml.indexOf('差异 {{diffCount}} 处 · 确认调整') >= 0,
  '主按钮要实时显示差异处数（稿 UX注释 n2）')
const takeJs = read('pages/stock-take/stock-take.js')
assert.ok(takeJs.indexOf('addAdjust') >= 0, '02b 的写操作只能走 store.addAdjust')
assert.ok(takeJs.indexOf('findBlankSku') >= 0,
  '02b 的半成品账面数要走 findBlankSku，判据与 lowStockRows / product-detail 同源')
// pages/adjust 不许被本批改掉：稿上两个入口并存
const adjustWxml = read('pages/adjust/adjust.wxml')
assert.ok(adjustWxml.indexOf('js-adjust-submit') >= 0, 'pages/adjust 仍是「一格 + 原因」那张皮')
assert.ok(adjustWxml.indexOf('只改这一个格子的件数，不是整单盘点。') >= 0,
  'pages/adjust 那句「不是整单盘点」要留着 —— 它正是两屏分工的说明')

// ---------------------------------------------------------------------------
// 5a 批（B5）· 商品编辑（稿 Screen/04 = 3:651）
// 这一组钉的是跨文件的接缝：chip 铁律第五档落在 app.wxss（Screen/04 与 Screen/16
// 共用同一枚 chip/add，留在页面里必然写两遍）、底栏 CTA 的 62 档、以及本页最后
// 两处青绿的去向。
// ---------------------------------------------------------------------------
const peWxml = read('pages/product-edit/product-edit.wxml')
const peWxss = read('pages/product-edit/product-edit.wxss')

assert.ok(
  appWxss.indexOf('--color-neutral-300:') >= 0,
  'chip/add 的描边色 neutral/300 3:17 要进 app.wxss'
)
assert.ok(
  /\.chip\.add\s*\{/.test(appWxss),
  'chip 铁律第五档（白底 + neutral/300 描边 = ＋添加）落在 app.wxss，不留在页面里'
)
assert.ok(peWxml.indexOf('class="page"') >= 0, '商品编辑根节点要 class="page"')
assert.ok(peWxml.indexOf('js-pe-kind-finished') < 0, '商品类型分段控件本批拿掉（稿 UX注释 n1）')
assert.ok(peWxml.indexOf('js-pe-save') >= 0, '保存钩子留着')
assert.ok(peWxml.indexOf('js-pe-remove') >= 0, '删除钩子留着')
assert.ok(
  peWxss.indexOf('.save-bar') >= 0 && peWxss.indexOf('position: fixed') >= 0,
  '保存钮钉底栏（稿 bottom-cta 4:997）'
)
assert.ok(
  peWxss.indexOf('#ECFDF5') < 0,
  '毛利预览的青绿底块本批清掉（稿 4:756 是一行 muted 小字）'
)
assert.ok(
  peWxss.indexOf('var(--fs-sm)') < 0 && peWxss.indexOf('var(--fs-md)') < 0
    && peWxss.indexOf('var(--tap-sm)') < 0,
  'product-edit.wxss 脱离 --fs-sm / --fs-md / --tap-sm 三个 A2 待删的旧别名'
)
assert.ok(
  !fs.existsSync(path.join(root, 'utils/sku-card-view.js')),
  'sku-card-view 本批删掉'
)

console.log('ui-scale tests passed')
