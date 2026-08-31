const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 无图占位的五色瓷砖。稿「规范/无图占位底色」3:821 原话：底色 hash 的输入是商品
// **不可变 id**，不是「名 + 货号」——「改名不再换色」是这条规范自己写的理由。
// 返回的下标对应 products.wxss 的 .tile-0 到 .tile-4，颜色写在那边，这里只出编号。
// 逐字符取模而不是先求和再取模：字符串长了也不会溢出，结果与先求和等价。
const TILE_COUNT = 5

function tileIndex(id) {
  const text = String(id || '')
  let sum = 0
  for (let i = 0; i < text.length; i++) {
    sum = (sum + text.charCodeAt(i)) % TILE_COUNT
  }
  return sum
}

// 只有一格时，副行给规格名而不是「1 个规格」——稿样张「米白/1.5m · 库存 16」（13:172）。
// 这里**不用** inventory.specText：它用 ` · ` 连接两个规格轴，会和副行本身的 ` · ` 分节符
// 撞车，屏上读成三段并列。稿在这个位置用的就是 `/`。
function specSlash(sku) {
  const parts = []
  const color = String(sku.color || '').trim()
  const size = String(sku.size || '').trim()
  if (color) parts.push(color)
  if (size) parts.push(size)
  return parts.join('/')
}

// 卡副行与起价一起算：两者都要「这个商品的成品规格清单」，扫一遍就够。
//
// 副行（稿三张样张逐字对齐）：
//   分规格   「N 个规格 · 库存 M」（13:184「3 个规格 · 库存 45」）
//   只有一格 「规格名 · 库存 M」（13:172「米白/1.5m · 库存 16」）
//   待加工   在上面基础上加「 + 半成品」（3:819「3 个规格 + 半成品 · 库存 86」）
//   无规格   只剩「库存 M」。稿上没有这一档样张。
//
// 货号行（2026-09-01 新增，稿 sku 槽 19:32 / 19:33，夹在 name 与 meta 之间）：
//   文案就是「货号 」+ product.sku，和 product-detail.js 的 metaTextOf 同一句形。
//   **sku 为空时给空串，由 wxml 的 wx:if 整行不渲染** —— 不是渲染空串、不是写「未填」。
//   「未填」那个写法只属于销售 / 进货的选货弹层（那里一行必须有内容），列表卡不用它，
//   tests/product-edit.test.js 有一条断言专门钉着 products.wxml 不许出现它。
//   一个货号 = 一个商品（条码才对应到规格级），所以这里取 product.sku，不去 skus 里挑。
//   为什么单独占一行、不并进 metaText：卡内容宽只有 149px，metaText 有规格时已经是
//   「3 个规格 · 库存 45」占满一行，再拼货号必折行；而折行会让同排两卡内容高度不等。
//   稿 UX 注释 n12（19:34）和 n10（10:177）记的是同一条裁定。
//
// product.stock 就是库存合计：分规格商品的这个字段由服务端用 productStockFromSkus
// 折好回写（utils/inventory.js:388-392），不用在客户端再加一遍。
//
// 起价：取各成品规格售价的最小值，没有成品规格就回落商品自己的售价。
// 稿上四张卡**一律**带「起」，包括只有一格的亚麻窗帘布，所以不做「只有一个价就去掉起」的分支。
function cardViewOf(product, skus) {
  const finished = inventory.skusOfProduct(skus, product.id).filter(function (item) {
    return !item.isBlank
  })
  let head = ''
  if (inventory.productHasSpecs(product)) {
    head = finished.length === 1 ? specSlash(finished[0]) : (finished.length + ' 个规格')
    if (inventory.isBlankProcess(product)) head += ' + 半成品'
  }
  const stockPart = '库存 ' + product.stock
  let min = Number(product.salePrice) || 0
  if (finished.length) {
    min = Number(finished[0].salePrice) || 0
    finished.forEach(function (item) {
      const value = Number(item.salePrice) || 0
      if (value < min) min = value
    })
  }
  return {
    skuText: product.sku ? '货号 ' + product.sku : '',
    metaText: head ? (head + ' · ' + stockPart) : stockPart,
    priceText: util.money(min)
  }
}

Page({
  data: {
    keyword: '',
    // 稿 segment/default 3:584 的三档：全部 / 有半成品 / 低库存。
    // 旧的 onlyAlert 布尔换成这一个字段，取值只有 'all' / 'blank' / 'low'。
    filter: 'all',
    list: [],
    pageLoading: true
  },

  // 看板不再带筛选进商品 tab：稿把「要补货 → 全部 ›」的去处定成独立页 Screen/01b
  // （caption 7:269），B2 已按此新建 pages/low-stock。所以这里不再
  // consumePendingInventoryFilter；app.js 那三个方法本批**不删**，理由见规格 §4.6。
  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    this.refresh()
  },

  refresh() {
    const skus = store.getSkus()
    const matched = inventory.filterProducts(store.getProducts(), this.data.keyword, skus)
    const filter = this.data.filter
    const source = matched.filter(function (item) {
      if (filter === 'low') return inventory.isLowStock(item, skus)
      if (filter === 'blank') return inventory.isBlankProcess(item)
      return true
    })
    this.setData({
      pageLoading: false,
      list: source.map(function (item) {
        const view = cardViewOf(item, skus)
        // Array.from 按码位取首字：emoji 开头的商品名不会切出半个代理对
        return Object.assign({}, item, {
          lowStock: inventory.isLowStock(item, skus),
          skuText: view.skuText,
          metaText: view.metaText,
          priceText: view.priceText,
          tile: tileIndex(item.id),
          thumbText: Array.from(String(item.name || ''))[0] || '品'
        })
      })
    })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter })
    this.refresh()
  },

  // 商品图加载失败只换占位首字，不删 item.image，下次刷新还会再试。
  // 动态路径走「先建空对象再赋键」：对象字面量里写 ['list[' + i + ']'] 是计算属性，
  // 会被微信 babel 编成 @babel/runtime helper（tests/no-babel-helpers.test.js 禁）。
  onThumbError(e) {
    const i = e.currentTarget.dataset.index
    const patch = {}
    patch['list[' + i + '].imageFailed'] = true
    this.setData(patch)
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  // 空态「从模板建档」。落点和「手动新增」暂时相同：建档页首卡本来就是种类模板 chips
  // （product-edit.wxml:5-17），差的只是锚定到那张卡，而加锚点要改 product-edit 的入参，
  // 那是 B5 的范围。两个入口分开写方法便于到时候单独改 —— 和 product-detail.js 的
  // goPrice / goEditProduct 是同一个处理方式。
  goTemplate() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
  },

  // 点卡片进只读详情；编辑入口在详情页（列表直进编辑容易误改，操作界面密度规则的裁定）。
  // 这条路由 #93 就已经在了，本批一个字不改。
  goDetail(e) {
    wx.navigateTo({ url: '/pages/product-detail/product-detail?id=' + e.currentTarget.dataset.id })
  }
})
