const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wxml = fs.readFileSync(
  path.join(__dirname, '../pages/product-edit/product-edit.wxml'),
  'utf8'
)
const editJs = fs.readFileSync(
  path.join(__dirname, '../pages/product-edit/product-edit.js'),
  'utf8'
)
const editWxss = fs.readFileSync(
  path.join(__dirname, '../pages/product-edit/product-edit.wxss'),
  'utf8'
)

// ---------------------------------------------------------------------------
// 5a 批（B5）· 商品编辑按稿 Screen/04（3:651）重做。
// 这一组钉的都是「看不见就会悄悄退回去」的事：类型分段控件复活、件数变回可填、
// 保存时把默认进价冲进每一格、取值 chip 退回「已选中」的白底黑描边。
// ---------------------------------------------------------------------------

// 稿 UX注释 n1（3:664）：「无「类型」选择：商品 = 可选规格（0~2 项）+ 可选半成品池」。
assert.ok(wxml.indexOf('setProductKind') < 0, '商品类型分段控件本批拿掉了')
assert.ok(wxml.indexOf('productKind') < 0, 'wxml 上不该再有 productKind 这个派生态')
assert.ok(editJs.indexOf('migrateBlankFinished') < 0, '切类型搬件数的迁移逻辑随之删除')
assert.ok(editJs.indexOf('applyProductKind') < 0, '同上')
assert.ok(wxml.indexOf('各格不同价') < 0, '「同价 / 各格不同价」分段控件稿上没有')

// 稿 UX注释 n9（10:134）：库存只读，建档初始 0，改数只走库存修正门。
assert.ok(!/<input[^>]*data-field="stock"/.test(wxml), '件数不许是输入框')
assert.ok(!/<input[^>]*data-field="blankStock"/.test(wxml), '半成品件数不许是输入框')
assert.ok(!/data-field="stock"[^>]*bindinput/.test(wxml), '同上（属性顺序反过来也拦）')
assert.ok(wxml.indexOf('sku-readonly') >= 0, '矩阵库存列是只读纯文本')
assert.ok(wxml.indexOf('blank-readonly') >= 0, '半成品池库存是只读纯文本')
assert.ok(/stock:\s*0,/.test(editJs), '保存时商品件数写 0（建档初始 0）')
// 收窄到 save() 里 payload 的形态（salePrice: row.salePrice 之后紧跟 stock: '0'）：
// rebuildSkuRows 里新建行也有一处合法的 stock: '0'（初始 0 件），宽形态的
// /stock:\s*'0'/ 在 save() 被改回 row.stock 时仍被它喂饱，变异验证 #2 实测拦不住。
assert.ok(/salePrice: row\.salePrice,\s*stock:\s*'0'/.test(editJs), '保存时每一格件数写 0')

// 保存不许带 costPrice：applyProductSkus 只有在 row.costPrice 缺席时才会回落到
// 这一格原来的进价（进货写进去的那个）。带上默认进价会把它冲掉，毛利当场算错。
assert.ok(!/costPrice:\s*row\./.test(editJs), '每格 payload 不许带 costPrice')
assert.ok(!/costPrice:\s*sharedPrice/.test(editJs), '同上')

// 折叠索引三行（稿 card/折叠·规格与SKU 15:19）
assert.strictEqual(
  (wxml.match(/bindtap="toggleFold"/g) || []).length,
  3,
  '折叠索引正好三行：规格 / 半成品池 / 每个规格的库存与价格'
)
assert.ok(wxml.indexOf('规格 · {{specSummary}}') >= 0, '第一行带规格副文案')
assert.ok(wxml.indexOf('半成品池 · {{blankSummary}}') >= 0, '第二行带半成品池副文案')
assert.ok(wxml.indexOf('每个规格的库存与价格 · {{skuSummary}}') >= 0, '第三行带条数副文案')

// 取值 chip 从「白底黑描边」改回灰底（chip 铁律：白底黑描边 = 已选中，取值不是选择态）
assert.ok(wxml.indexOf('chip on js-pe-color-chip') < 0, '取值 chip 不再借「已选中」的形')
assert.ok(wxml.indexOf('chip chip-val') >= 0, '取值 chip 走灰底那一档')
assert.ok(wxml.indexOf('chip-del') >= 0, '取值 chip 带独立的 44x44 删除热区（稿 13:678）')
// ＋添加走 app.wxss 的 chip 铁律第五档（稿 chip/add 13:703）
assert.ok(wxml.indexOf('chip add') >= 0, '＋添加用共用类 .chip.add')
assert.ok(wxml.indexOf('＋ 添加规格值') >= 0, '文案照稿 3:675')
// 点了原位变输入框，回车 / 失焦生成 chip（稿 UX注释 n6）
assert.ok(wxml.indexOf('bindconfirm="commitSpec"') >= 0, '回车提交')
assert.ok(wxml.indexOf('bindblur="commitSpec"') >= 0, '失焦提交')
assert.ok(wxml.indexOf('bindtap="startAdd"') >= 0, '点＋添加先变输入框')

// 保存在固定底栏、删除是危险红字链（稿 bottom-cta 4:997 与 画布规范 9:24）
assert.ok(wxml.indexOf('save-bar') >= 0, '保存钮在固定底栏')
assert.ok(wxml.indexOf('danger-link') >= 0, '删除商品是危险红字链那一档')
assert.ok(wxml.indexOf('btn-danger') < 0, '不再是浅红底块')
assert.ok(wxml.indexOf('action-strip') < 0, '页面操作区不再有灰底 ghost 横条（规范 9:24）')
assert.ok(/\.save-btn \{[\s\S]*?height: 124rpx/.test(editWxss), 'xxl 62 = 124rpx（稿 7:501）')
assert.ok(editWxss.indexOf('env(safe-area-inset-bottom)') >= 0, '底栏要留 34 安全区')

// 库存调整 / 改规格两个入口挪到了商品详情（稿 UX注释/商品详情 3:628 的「库存修正」门）。
// 两个页面本身没有变成孤岛：pages/adjust 由 product-detail 与记一笔面板进，
// pages/convert 由记一笔面板进。
assert.ok(wxml.indexOf('goAdjust') < 0, '库存调整入口不在商品编辑上')
assert.ok(wxml.indexOf('goConvert') < 0, '改规格入口不在商品编辑上')

// 锚点入参：category = 商品列表空态「从模板建档」，price = 商品详情「调价」
assert.ok(editJs.indexOf("focus === 'category'") >= 0, '接得住 ?focus=category')
assert.ok(editJs.indexOf("focus === 'price'") >= 0, '接得住 ?focus=price')
assert.ok(wxml.indexOf('id="pe-spec-card"') >= 0, 'category 锚点要有滚动落点')
assert.ok(wxml.indexOf('js-pe-categories') >= 0, '管理模板的钩子留着（ui.test.js 的种类用例走它进）')

// 商品图：选图入口和压缩画布钉在 wxml，require 钉在 js
assert.ok(wxml.indexOf('pickImage') >= 0)
assert.ok(wxml.indexOf('image-canvas') >= 0)
assert.ok(wxml.indexOf('id="imageCanvas"') >= 0)
assert.ok(editJs.indexOf('product-image') >= 0)

// 三张旧 sku 卡合成一张矩阵，utils/sku-card-view.js 随之删除
assert.ok(
  !fs.existsSync(path.join(__dirname, '../utils/sku-card-view.js')),
  'sku-card-view 本批删掉（三张旧卡的显隐判据没有消费方了）'
)
assert.ok(editJs.indexOf('sku-card-view') < 0, 'js 不再 require 它')
assert.ok(
  fs.readFileSync(path.join(__dirname, '../project.config.json'), 'utf8')
    .indexOf('sku-card-view') < 0,
  'packOptions.include 里也要摘掉'
)

const productsWxml = fs.readFileSync(
  path.join(__dirname, '../pages/products/products.wxml'),
  'utf8'
)
assert.ok(productsWxml.indexOf('goods-grid') >= 0)
assert.ok(productsWxml.indexOf('action-strip') < 0)
assert.ok(productsWxml.indexOf('stat-grid') < 0)
assert.ok(productsWxml.indexOf('goods-spec-toggle') < 0)
assert.ok(productsWxml.indexOf('查看规格') < 0)
assert.ok(productsWxml.indexOf('收起规格') < 0)
assert.ok(productsWxml.indexOf('toggleSpecs') < 0)
assert.ok(productsWxml.indexOf('进价') < 0)
assert.ok(productsWxml.indexOf('售价') < 0)
assert.ok(productsWxml.indexOf('skuSummary') < 0)
assert.ok(productsWxml.indexOf('bar-fill') < 0)
assert.ok(productsWxml.indexOf('barWidth') < 0)
assert.ok(productsWxml.indexOf('item.specTag') < 0)
assert.ok(productsWxml.indexOf('profitText') < 0)
assert.ok(productsWxml.indexOf('rateText') < 0)
assert.ok(productsWxml.indexOf('毛利') < 0)
assert.ok(productsWxml.indexOf("item.sku || '未填'") < 0)
assert.ok(productsWxml.indexOf('库存调整') < 0)
// 商品图：两列图卡上方正方形预览，失败回落首字占位
assert.ok(productsWxml.indexOf('goods-thumb') >= 0)
assert.ok(productsWxml.indexOf('lazy-load') >= 0)
assert.ok(productsWxml.indexOf('thumb-empty') >= 0)
// 锚点必须真能命中：旧值 'class="card goods-card"' 在 wxml 里找不到（实际 class 是
// 'card goods-card js-product-card'，goods-card 后面没引号），indexOf 恒 -1，
// slice(-1) 只剩最后一个字符，下面的「条码」断言在 1 个字符里恒真 —— 整条空转。
// （ui.test.js 钉子⑨的注释记过同一类坑：slice(x, -1) 不报错、钉子静默降级却照样绿。）
// 锚点要匹配到**类名边界**，两头的坑都得躲开：
//   · 带闭合引号（'…goods-card"'）→ 卡上后加 hook class 就失配，正是这条空转的成因
//   · 纯前缀（'…goods-card'）→ 把 class 改名成 goods-cardX 也照样命中，改名漏网
// 所以要求 goods-card 后面紧跟引号或空格，即它确实是一个完整的类名。
const productsCardMatch = /class="card goods-card[" ]/.exec(productsWxml)
const productsCardAt = productsCardMatch ? productsCardMatch.index : -1
assert.ok(
  productsCardAt >= 0,
  '自检：商品卡锚点没命中，本条「条码」断言会跟着空转 —— 改 wxml 的卡 class 时要连锚点一起改'
)
const productsCard = productsWxml.slice(productsCardAt)
assert.ok(productsCard.indexOf('条码') < 0)

const productsJs = fs.readFileSync(
  path.join(__dirname, '../pages/products/products.js'),
  'utf8'
)
assert.ok(productsJs.indexOf('expandedId') < 0)
assert.ok(productsJs.indexOf('toggleSpecs') < 0)
assert.ok(productsJs.indexOf('skuListView') < 0)
assert.ok(productsJs.indexOf('goConvert') < 0)
assert.ok(productsJs.indexOf('barWidth') < 0)

// 商品图：选货弹层行内缩略图，sale / purchase 同构；无图不渲染，不加占位灰块
const saleWxml = fs.readFileSync(
  path.join(__dirname, '../pages/sale/sale.wxml'),
  'utf8'
)
const purchaseWxml = fs.readFileSync(
  path.join(__dirname, '../pages/purchase/purchase.wxml'),
  'utf8'
)
assert.ok(saleWxml.indexOf('sheet-thumb') >= 0)
assert.ok(purchaseWxml.indexOf('sheet-thumb') >= 0)

// B7 把类型 chip 从 wxml 字面量改成了 records.js 的 TYPE_OPTIONS 数组
// wx:for 渲染，所以「调整」这一档现在钉在数组里，不是 wxml 文本。
const recordsWxml = fs.readFileSync(
  path.join(__dirname, '../pages/records/records.wxml'),
  'utf8'
)
const recordsJs = fs.readFileSync(
  path.join(__dirname, '../pages/records/records.js'),
  'utf8'
)
assert.ok(/\{\s*key:\s*'adjust',\s*label:\s*'调整'\s*\}/.test(recordsJs))
assert.ok(recordsWxml.indexOf('wx:for="{{typeOptions}}"') >= 0)
assert.ok(recordsWxml.indexOf('data-type="{{item.key}}"') >= 0)
// 光有数组和 wxml 动态渲染语法还不够：数组必须真的接到 data.typeOptions
// 上，否则 wx:for 绑定的是个 undefined，chip 一枚都渲染不出来也测不出来。
assert.ok(recordsJs.indexOf('typeOptions: TYPE_OPTIONS') >= 0)

console.log('product-edit tests passed')
