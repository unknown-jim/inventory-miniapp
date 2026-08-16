const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
  data: {
    products: [],
    skus: [],
    productId: '',
    productName: '请选择商品',
    hasSpecs: false,
    blankProcess: false,
    fromSkuId: '',
    fromOptions: [],
    colors: [],
    sizes: [],
    toColor: '',
    toSize: '',
    specAxis1: '规格一',
    specAxis2: '规格二',
    colorOptions: [],
    sizeOptions: [],
    qty: '',
    remark: '',
    showPicker: false,
    keyword: '',
    filtered: []
  },

  onLoad(query) {
    if (query.id) this.pendingId = query.id
  },

  onShow() {
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

  fromOptionsOf(product, skus) {
    return inventory.skusOfProduct(skus, product.id).filter(function (item) {
      return !item.isBlank && inventory.toNumber(item.stock) > 0
    }).map(function (item) {
      return {
        id: item.id,
        specText: inventory.specText(item.color, item.size),
        stock: item.stock,
        on: item.id === this.data.fromSkuId
      }
    }.bind(this))
  },

  selectProduct(id) {
    const product = store.getProduct(id)
    if (!product || !inventory.productHasSpecs(product)) {
      wx.showToast({ title: '请选择带规格的商品', icon: 'none' })
      return
    }
    const colors = product.colors || []
    const sizes = product.sizes || []
    const fromOptions = this.fromOptionsOf(product, this.data.skus)
    const fromSkuId = fromOptions.length === 1 ? fromOptions[0].id : ''
    this.setData({
      productId: product.id,
      productName: product.name,
      hasSpecs: true,
      blankProcess: inventory.isBlankProcess(product),
      specAxis1: inventory.specAxis1Name(product),
      specAxis2: inventory.specAxis2Name(product),
      colors: colors,
      sizes: sizes,
      fromSkuId: fromSkuId,
      fromOptions: fromOptions.map(function (item) {
        return Object.assign({}, item, { on: item.id === fromSkuId })
      }),
      toColor: colors.length === 1 ? colors[0] : '',
      toSize: sizes.length === 1 ? sizes[0] : '',
      colorOptions: colors.map(function (value) {
        return { value: value, on: colors.length === 1 }
      }),
      sizeOptions: sizes.map(function (value) {
        return { value: value, on: sizes.length === 1 }
      })
    })
  },

  pickFrom(e) {
    const fromSkuId = e.currentTarget.dataset.id
    this.setData({
      fromSkuId: fromSkuId,
      fromOptions: this.data.fromOptions.map(function (item) {
        return Object.assign({}, item, { on: item.id === fromSkuId })
      })
    })
  },

  pickToColor(e) {
    const toColor = e.currentTarget.dataset.value
    this.setData({
      toColor: toColor,
      colorOptions: this.data.colorOptions.map(function (item) {
        return Object.assign({}, item, { on: item.value === toColor })
      })
    })
  },

  pickToSize(e) {
    const toSize = e.currentTarget.dataset.value
    this.setData({
      toSize: toSize,
      sizeOptions: this.data.sizeOptions.map(function (item) {
        return Object.assign({}, item, { on: item.value === toSize })
      })
    })
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  submit() {
    try {
      const product = store.getProduct(this.data.productId)
      if (!product) {
        throw new Error('请选择商品')
      }
      if (!this.data.fromSkuId) {
        throw new Error('请选择要改的现货')
      }
      const toSku = inventory.findSkuBySpec(this.data.skus, product.id, this.data.toColor, this.data.toSize)
      if (!toSku) {
        throw new Error(inventory.specSelectHint(product) || '请选择改成的规格')
      }
      store.addConvert({
        productId: product.id,
        fromSkuId: this.data.fromSkuId,
        toSkuId: toSku.id,
        qty: this.data.qty,
        remark: this.data.remark
      })
      this.data.skus = store.getSkus()
      this.selectProduct(product.id)
      this.setData({ qty: '', remark: '', skus: this.data.skus })
      wx.showToast({ title: '已改规格', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
