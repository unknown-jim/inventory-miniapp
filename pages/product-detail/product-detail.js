const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    productId: '',
    name: '',
    priceText: '',
    metaText: '',
    image: '',
    imageFailed: false,
    thumbText: '',
    hasSpecs: false,
    stockRows: [],
    pageLoading: true
  },

  onLoad(query) {
    const id = query && query.id
    if (!id) {
      wx.showToast({ title: '请从商品列表进入', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
      return
    }
    this.pendingId = id
  },

  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    const id = this.pendingId
    if (!id) return
    this.pendingId = ''
    this.loadProduct(id)
  },

  // 半成品池的件数在 isBlank 的那条 sku 上（findBlankSku），不在商品记录里。
  stockRowsOf(product, skus) {
    if (!inventory.productHasSpecs(product)) {
      return [{ id: product.id, label: '库存', qtyText: product.stock + ' 件' }]
    }
    const rows = []
    if (inventory.isBlankProcess(product)) {
      const blank = inventory.findBlankSku(skus, product.id)
      if (blank) {
        rows.push({
          id: blank.id,
          blank: true,
          label: '半成品 · 现货不足自动扣',
          qtyText: blank.stock + ' 件'
        })
      }
    }
    skus.forEach(function (item) {
      if (item.isBlank) return
      rows.push({
        id: item.id,
        label: inventory.specText(item.color, item.size),
        qtyText: item.stock + ' 件'
      })
    })
    return rows
  },

  metaTextOf(product, skus) {
    if (!inventory.productHasSpecs(product)) {
      return product.sku ? '货号 ' + product.sku : ''
    }
    const axes = ((product.colors || []).length ? 1 : 0) + ((product.sizes || []).length ? 1 : 0)
    const finished = skus.filter(function (item) {
      return !item.isBlank
    }).length
    let text = axes + ' 项规格 · ' + finished + ' 个成品规格'
    if (inventory.isBlankProcess(product)) text += ' + 半成品池'
    return text
  },

  loadProduct(id) {
    const product = store.getProduct(id)
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
      return
    }
    const skus = store.getSkusByProduct(product.id)
    this.setData({
      pageLoading: false,
      productId: product.id,
      name: product.name,
      priceText: util.money(product.salePrice),
      metaText: this.metaTextOf(product, skus),
      image: product.image || '',
      thumbText: Array.from(String(product.name || ''))[0] || '品',
      hasSpecs: inventory.productHasSpecs(product),
      stockRows: this.stockRowsOf(product, skus)
    })
  },

  // 头卡缩略图点开全屏看大图（设计稿 UX 注释 n10：不进编辑）。无图或图挂了不响应。
  previewThumb() {
    if (!this.data.image || this.data.imageFailed) return
    wx.previewImage({ current: this.data.image, urls: [this.data.image] })
  },

  // 商品图加载失败只换占位首字，不删 image，下次刷新还会再试（同商品列表）。
  onThumbError() {
    this.setData({ imageFailed: true })
  },

  // 「去销售」「去进货」在 tabBar 收到 4 个之后是普通页，走 navigateTo。
  // 和 switchTab 不同，navigateTo 不重置页面栈，从落点页能直接返回本详情页。
  goSale() {
    wx.navigateTo({ url: '/pages/sale/sale' })
  },

  goPurchase() {
    wx.navigateTo({ url: '/pages/purchase/purchase' })
  },

  // 设计要求「调价」进编辑页并锚定价格区（售价/进价聚焦），锚定由后续批次补；
  // 本批和「编辑商品」一样只做跳转，两个入口分开写便于到时候单独改。
  goPrice() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + this.data.productId })
  },

  goEditProduct() {
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + this.data.productId })
  },

  // 库存全景的最终形态是底部调整 sheet，本批先接到现有数量调整页。
  // title-row（库存修正门）和每格都落到同一个 adjust 入口。
  goAdjust() {
    wx.navigateTo({ url: '/pages/adjust/adjust?id=' + this.data.productId })
  }
})
