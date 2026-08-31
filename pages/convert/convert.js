const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// ---------------------------------------------------------------------------
// 换规格（稿 Screen/12 库存修正·换格 4:423）。
//
// 【本页的账面边界，改这个文件之前先读一遍】
// 换规格**只挪件数，不碰任何债务成本**。这条不是靠本页守的，是靠账法层四道闸门守的：
//   ① utils/inventory.js:2041-2066 造的记录里 amount / profit 是**字面量 0**，
//      而且整条记录是新造的对象字面量、不是 payload 的展开 —— payload 里多塞任何
//      金额字段都不会有效果；applyConvert 全程只读 productId / fromSkuId /
//      toSkuId / qty / remark 这 5 个键。
//   ② utils/inventory.js:1480-1504 的 recordTerms 对 type === 'convert' 的
//      11 个钱项**全部返回 0**，只有 count 是 1。
//   ③ utils/inventory.js:1433-1440 的 isCustomerAccountRecord 不含 'convert'，
//      所以 applyTermsDelta 的 bump() 在 `if (!customerId) return` 当场返回，
//      accounts 一格都不动。
//   ④ utils/inventory.js:3206-3241 的 todayTotals 没有 convert 分支，今日五数不动。
// 所以本页的责任只有一条：**payload 就是那 5 个键，一个都不多。**
// 屏上一个金额都不出现（稿注 4:473 原话「不产生金额」）。
//
// 待加工（半成品）**不能做来源也不能做目标**：utils/inventory.js:2023-2025 对
// from.isBlank / to.isBlank 直接 throw，docs/blank-process.md:24 也写着这条。
// 稿注 $11:112 画了「半成品也可以选」，那是还没落地的新增语义（规格 §6-2 / OPEN-Q-2），
// **不要为了让那枚 chip 亮起来去动后端那道 throw**。
// ---------------------------------------------------------------------------

Page({
  data: {
    products: [],
    skus: [],
    productId: '',
    productName: '请选择商品',
    hasSpecs: false,
    blankProcess: false,
    fromSkuId: '',
    fromOptions: [],
    toSkuId: '',
    toOptions: [],
    colors: [],
    sizes: [],
    specAxis1: '规格一',
    specAxis2: '规格二',
    qty: '',
    remark: '',
    maxQty: 0,
    maxHint: '',
    canDec: false,
    canInc: false,
    previewFrom: '',
    previewTo: '',
    submitting: false,
    showPicker: false,
    keyword: '',
    filtered: []
  },

  onLoad(query) {
    if (query.id) this.pendingId = query.id
  },

  // **不要给 data 加 pageLoading**：tests/automator-contract.test.js:181 的
  // NO_PAGE_LOADING 名单里有本页，加了当场红；用例改等业务字段 productId。
  async onShow() {
    if (!(await store.ready())) return
    const products = store.getProducts()
    const skus = store.getSkus()
    this.setData({ products: products, skus: skus })
    this.data.skus = skus
    this.data.products = products
    this.applyFilter(this.data.keyword, products, skus)
    const selectedId = this.pendingId || getApp().consumeSelectedProduct()
    this.pendingId = ''
    if (selectedId) {
      this.selectProduct(selectedId)
    } else if (this.data.productId) {
      this.selectProduct(this.data.productId)
    }
  },

  specProducts(products, skus) {
    return (products || []).filter(function (item) {
      return inventory.productHasSpecs(item)
    }).map(function (item) {
      return util.withView(item, skus)
    })
  },

  applyFilter(keyword, products, skus) {
    const source = this.specProducts(products || this.data.products, skus || this.data.skus)
    this.setData({
      keyword: keyword,
      filtered: inventory.filterProducts(source, keyword, skus || this.data.skus)
    })
  },

  onSearch(e) {
    this.applyFilter(e.detail.value)
  },

  openPicker() {
    if (!this.specProducts(this.data.products, this.data.skus).length) {
      wx.showToast({ title: '请先给商品加上规格', icon: 'none' })
      return
    }
    this.setData({ showPicker: true })
    this.applyFilter(this.data.keyword)
  },

  closePicker() {
    this.setData({ showPicker: false })
  },

  closePickerKeep() {},

  onPick(e) {
    this.selectProduct(e.currentTarget.dataset.id)
    this.closePicker()
  },

  // 稿 4:502「从哪个规格」：来源 = 该商品**非待加工且有货**的格。
  // 待加工那一格不出（后端 :2023 对 from.isBlank 直接 throw）。
  fromOptionsOf(product, skus, fromSkuId) {
    return inventory.skusOfProduct(skus, product.id).filter(function (item) {
      return !item.isBlank && inventory.toNumber(item.stock) > 0
    }).map(function (item) {
      return {
        id: item.id,
        label: inventory.specText(item.color, item.size),
        stock: item.stock,
        on: item.id === fromSkuId
      }
    })
  },

  // 稿 4:503「换成哪个规格」：目标 = 该商品**全部非待加工格**（含 0 库存的空格），
  // 与来源相同的那一枚**留在列表里但置禁用档**（稿注 $13:694：
  // neutral/100 灰底 + neutral/500 字、整枚 opacity 1，点按弹 toast）。
  // 留位而不是过滤掉，是为了让格子的位置在切换来源时不跳。
  toOptionsOf(product, skus, fromSkuId, toSkuId) {
    return inventory.skusOfProduct(skus, product.id).filter(function (item) {
      return !item.isBlank
    }).map(function (item) {
      const same = item.id === fromSkuId
      return {
        id: item.id,
        label: inventory.specText(item.color, item.size),
        stock: item.stock,
        same: same,
        on: !same && item.id === toSkuId
      }
    })
  },

  selectProduct(id) {
    const product = store.getProduct(id)
    if (!product || !inventory.productHasSpecs(product)) {
      wx.showToast({ title: '请选择带规格的商品', icon: 'none' })
      return
    }
    const fromOptions = this.fromOptionsOf(product, this.data.skus, '')
    const fromSkuId = fromOptions.length === 1 ? fromOptions[0].id : ''
    this.setData({
      productId: product.id,
      productName: product.name,
      hasSpecs: true,
      blankProcess: inventory.isBlankProcess(product),
      colors: product.colors || [],
      sizes: product.sizes || [],
      specAxis1: inventory.specAxis1Name(product),
      specAxis2: inventory.specAxis2Name(product),
      fromSkuId: fromSkuId,
      fromOptions: this.fromOptionsOf(product, this.data.skus, fromSkuId),
      toSkuId: '',
      toOptions: this.toOptionsOf(product, this.data.skus, fromSkuId, ''),
      qty: ''
    })
    this.refreshPreview()
  },

  pickFrom(e) {
    const fromSkuId = e.currentTarget.dataset.id
    const product = store.getProduct(this.data.productId)
    if (!product) return
    // 换了来源之后，原来选中的目标如果正好等于新来源，就把目标清掉。
    const toSkuId = this.data.toSkuId === fromSkuId ? '' : this.data.toSkuId
    this.setData({
      fromSkuId: fromSkuId,
      toSkuId: toSkuId,
      fromOptions: this.fromOptionsOf(product, this.data.skus, fromSkuId),
      toOptions: this.toOptionsOf(product, this.data.skus, fromSkuId, toSkuId)
    })
    this.refreshPreview()
  },

  pickTo(e) {
    const toSkuId = e.currentTarget.dataset.id
    const product = store.getProduct(this.data.productId)
    if (!product) return
    if (toSkuId === this.data.fromSkuId) {
      // 稿 toast/与来源相同 7:494（msg 7:495）。**不变账**，只提示。
      wx.showToast({ title: '与来源相同，请另选目标规格', icon: 'none' })
      return
    }
    this.setData({
      toSkuId: toSkuId,
      toOptions: this.toOptionsOf(product, this.data.skus, this.data.fromSkuId, toSkuId)
    })
    this.refreshPreview()
  },

  // 稿 card/换规格预览 4:786 + hint 7:106 + 守恒提示 4:466。
  // **这里只算件数，不算钱**：换规格屏上一个金额都没有（稿注 4:473「不产生金额」）。
  refreshPreview() {
    const from = this.data.fromSkuId ? store.getSku(this.data.fromSkuId) : null
    const to = this.data.toSkuId ? store.getSku(this.data.toSkuId) : null
    const maxQty = from ? inventory.round2(from.stock) : 0
    const qty = inventory.round2(this.data.qty)
    const fromLabel = from ? inventory.specText(from.color, from.size) : ''
    const toLabel = to ? inventory.specText(to.color, to.size) : ''
    this.setData({
      maxQty: maxQty,
      maxHint: from ? ('最多 ' + maxQty + ' 件（= 来源现存）') : '',
      canDec: qty > 0,
      canInc: !!from && qty < maxQty,
      previewFrom: from && qty > 0
        ? (fromLabel + '（' + from.stock + '）→ −' + qty + ' → 剩 ' + inventory.round2(from.stock - qty))
        : '',
      previewTo: to && qty > 0
        ? (toLabel + '（' + to.stock + '）→ +' + qty + ' → 变 ' + inventory.round2(to.stock + qty))
        : ''
    })
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  // 稿 stepper/default 7:225：数字可点开直输，上限 = 来源现存（稿 7:106）。
  onQty(e) {
    this.setData({ qty: e.detail.value })
    this.refreshPreview()
  },

  stepDown() {
    const next = inventory.round2(inventory.toNumber(this.data.qty) - 1)
    this.setData({ qty: next > 0 ? String(next) : '' })
    this.refreshPreview()
  },

  stepUp() {
    // 没选来源就没有上限可言。灰着的 ＋ 仍然会收到 tap（禁用的是视觉不是事件），
    // 所以这道判断必须写在这里，不能只靠 canInc 的样式。
    if (!this.data.fromSkuId) {
      wx.showToast({ title: '请先选要改的现货', icon: 'none' })
      return
    }
    const next = inventory.round2(inventory.toNumber(this.data.qty) + 1)
    if (next > this.data.maxQty) {
      wx.showToast({ title: this.data.maxHint, icon: 'none' })
      return
    }
    this.setData({ qty: String(next) })
    this.refreshPreview()
  },

  async submit() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    try {
      const product = store.getProduct(this.data.productId)
      if (!product) {
        throw new Error('请选择商品')
      }
      if (!this.data.fromSkuId) {
        throw new Error('请选择要改的现货')
      }
      if (!this.data.toSkuId) {
        throw new Error('请选择改成的规格')
      }
      // payload 就是这五个键。applyConvert（utils/inventory.js:1996-2074）也只读这五个；
      // 单头的 amount / profit 是它自己写死的 0。**一个金额字段都不许加。**
      await store.addConvert({
        productId: product.id,
        fromSkuId: this.data.fromSkuId,
        toSkuId: this.data.toSkuId,
        qty: this.data.qty,
        remark: this.data.remark
      })
      this.data.skus = store.getSkus()
      this.setData({ skus: this.data.skus, qty: '', remark: '' })
      this.selectProduct(product.id)
      // 稿 toast/换格完成 7:348。
      wx.showToast({ title: '已换格 · 总数不变 · 明细见流水', icon: 'none' })
    } catch (error) {
      util.showError(error)
    }
    this.setData({ submitting: false })
  }
})
