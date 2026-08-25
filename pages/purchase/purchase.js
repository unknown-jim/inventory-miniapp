const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    products: [],
    skus: [],
    productId: '',
    productName: '请选择商品',
    stockText: '-',
    hasSpecs: false,
    colors: [],
    sizes: [],
    selectedColor: '',
    selectedSize: '',
    skuId: '',
    specAxis1: '规格一',
    specAxis2: '规格二',
    colorOptions: [],
    sizeOptions: [],
    blankProcess: false,
    qty: '',
    unitPrice: '',
    remark: '',
    amountText: '0.00',
    showPicker: false,
    keyword: '',
    filtered: [],
    pageLoading: true
  },

  async onShow() {
    if (!store.isReady()) this.setData({ pageLoading: true })
    if (!(await store.ready())) {
      this.setData({ pageLoading: false })
      return
    }
    const products = store.getProducts()
    const skus = store.getSkus()
    const selectedId = getApp().consumeSelectedProduct()
    this.setData({ products: products, skus: skus, pageLoading: false })
    this.data.skus = skus
    this.data.products = products
    this.applyFilter(this.data.keyword, products, skus)
    if (selectedId) {
      this.selectProduct(selectedId)
    } else if (this.data.productId) {
      this.selectProduct(this.data.productId)
    }
  },

  applyFilter(keyword, products, skus) {
    const source = products || this.data.products
    const skuList = skus || this.data.skus
    this.setData({
      keyword: keyword,
      filtered: inventory.filterProducts(source, keyword, skuList).map(function (item) {
        return util.withView(item, skuList)
      })
    })
  },

  onSearch(e) {
    this.applyFilter(e.detail.value)
  },

  openPicker() {
    if (!this.data.products.length) {
      wx.showToast({ title: '请先新增商品', icon: 'none' })
      return
    }
    this.setData({ showPicker: true })
    this.applyFilter(this.data.keyword)
  },

  closePicker() {
    this.setData({ showPicker: false })
  },

  onPick(e) {
    this.selectProduct(e.currentTarget.dataset.id)
    this.closePicker()
  },

  // 商品图加载失败就去掉缩略图占位，不删 item.image，下次打开弹层还会再试。
  // 动态路径走「先建空对象再赋键」：对象字面量里写计算属性会被微信 babel 编成
  // @babel/runtime helper（tests/no-babel-helpers.test.js 禁）。
  onSheetThumbError(e) {
    const i = e.currentTarget.dataset.index
    const patch = {}
    patch['filtered[' + i + '].imageFailed'] = true
    this.setData(patch)
  },

  currentSku(product) {
    const current = product || store.getProduct(this.data.productId)
    if (!current || !inventory.productHasSpecs(current)) return null
    const colors = current.colors || []
    const sizes = current.sizes || []
    if ((colors.length && !this.data.selectedColor) || (sizes.length && !this.data.selectedSize)) {
      return null
    }
    return inventory.findSkuBySpec(this.data.skus, current.id, this.data.selectedColor, this.data.selectedSize)
  },

  specOptions(product, selectedColor, selectedSize) {
    const colors = (product && product.colors) || []
    const sizes = (product && product.sizes) || []
    const skus = this.data.skus
    return {
      colorOptions: colors.map(function (color) {
        return { value: color, on: color === selectedColor }
      }),
      sizeOptions: sizes.map(function (size) {
        const sku = inventory.findSkuBySpec(skus, product.id, selectedColor || '', size)
        return {
          value: size,
          stock: sku ? sku.stock : 0,
          on: size === selectedSize
        }
      })
    }
  },

  applyProductState(product, selectedColor, selectedSize) {
    const hasSpecs = inventory.productHasSpecs(product)
    const blankProcess = inventory.isBlankProcess(product)
    const colors = product.colors || []
    const sizes = product.sizes || []
    let color = selectedColor
    let size = selectedSize
    if (hasSpecs && !blankProcess) {
      if (colors.length === 1) color = colors[0]
      if (sizes.length === 1) size = sizes[0]
    } else {
      color = ''
      size = ''
    }
    const sku = hasSpecs && !blankProcess ? inventory.findSkuBySpec(this.data.skus, product.id, color, size) : null
    const blank = blankProcess ? inventory.findBlankSku(this.data.skus, product.id) : null
    const keepPrice = this.data.productId === product.id && this.data.unitPrice && this.data.skuId === (sku ? sku.id : (blank ? blank.id : ''))
    const unitPrice = keepPrice ? this.data.unitPrice : String(sku ? sku.costPrice : product.costPrice)
    const amount = inventory.round2(inventory.toNumber(this.data.qty) * inventory.toNumber(unitPrice))
    let stockText = String(product.stock)
    if (blankProcess) {
      stockText = blank ? String(blank.stock) : '0'
    } else if (hasSpecs) {
      stockText = sku ? String(sku.stock) : '请选规格'
    }
    this.setData(Object.assign({
      productId: product.id,
      productName: product.name,
      hasSpecs: hasSpecs,
      blankProcess: blankProcess,
      specAxis1: inventory.specAxis1Name(product),
      specAxis2: inventory.specAxis2Name(product),
      colors: colors,
      sizes: sizes,
      selectedColor: color,
      selectedSize: size,
      skuId: sku ? sku.id : (blank ? blank.id : ''),
      stockText: stockText,
      unitPrice: unitPrice,
      amountText: util.money(amount)
    }, this.specOptions(product, color, size)))
  },

  selectProduct(id) {
    const product = store.getProduct(id)
    if (!product) return
    const same = this.data.productId === id
    this.applyProductState(product, same ? this.data.selectedColor : '', same ? this.data.selectedSize : '')
  },

  pickColor(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    this.applyProductState(product, e.currentTarget.dataset.value, this.data.selectedSize)
  },

  pickSize(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    this.applyProductState(product, this.data.selectedColor, e.currentTarget.dataset.value)
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
    this.refreshAmount()
  },

  refreshAmount() {
    const amount = inventory.round2(inventory.toNumber(this.data.qty) * inventory.toNumber(this.data.unitPrice))
    this.setData({ amountText: util.money(amount) })
  },

  async submit() {
    try {
      const product = store.getProduct(this.data.productId)
      if (product && inventory.productHasSpecs(product) && !inventory.isBlankProcess(product)) {
        const colors = product.colors || []
        const sizes = product.sizes || []
        if ((colors.length && !this.data.selectedColor) || (sizes.length && !this.data.selectedSize)) {
          throw new Error(inventory.specSelectHint(product))
        }
        if (!this.data.skuId) {
          throw new Error('规格不存在')
        }
      }
      const record = await store.addPurchase({
        productId: this.data.productId,
        skuId: inventory.isBlankProcess(product) ? '' : this.data.skuId,
        qty: this.data.qty,
        unitPrice: this.data.unitPrice,
        remark: this.data.remark
      })
      this.data.skus = store.getSkus()
      const recordLine = inventory.firstLine(record)
      const latest = store.getProduct(recordLine.productId)
      const blank = latest && inventory.isBlankProcess(latest) ? inventory.findBlankSku(this.data.skus, latest.id) : null
      const sku = recordLine.skuId && !blank ? store.getSku(recordLine.skuId) : null
      this.setData({
        skus: this.data.skus,
        qty: '',
        remark: '',
        stockText: blank ? String(blank.stock) : (sku ? String(sku.stock) : String(latest.stock))
      })
      this.refreshAmount()
      wx.showToast({ title: '进货成功', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
