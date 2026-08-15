const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    products: [],
    productId: '',
    productName: '请选择商品',
    stockText: '-',
    costText: '-',
    qty: '',
    unitPrice: '',
    remark: '',
    amountText: '0.00',
    profitText: '0.00',
    showPicker: false,
    keyword: '',
    filtered: []
  },

  onShow() {
    const products = store.getProducts()
    const selectedId = getApp().consumeSelectedProduct()
    this.setData({ products: products })
    this.applyFilter(this.data.keyword, products)
    if (selectedId) {
      this.selectProduct(selectedId)
    } else if (this.data.productId) {
      this.selectProduct(this.data.productId)
    }
  },

  applyFilter(keyword, products) {
    const source = products || this.data.products
    this.setData({
      keyword: keyword,
      filtered: inventory.filterProducts(source, keyword).map(util.withView)
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

  closePickerKeep() {},

  onPick(e) {
    this.selectProduct(e.currentTarget.dataset.id)
    this.closePicker()
  },

  selectProduct(id) {
    const product = store.getProduct(id)
    if (!product) return
    this.setData({
      productId: product.id,
      productName: product.name,
      stockText: String(product.stock),
      costText: util.money(product.costPrice),
      unitPrice: this.data.productId === id && this.data.unitPrice
        ? this.data.unitPrice
        : String(product.salePrice)
    })
    this.refreshPreview()
  },

  onField(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
    this.refreshPreview()
  },

  refreshPreview() {
    const qty = inventory.toNumber(this.data.qty)
    const price = inventory.toNumber(this.data.unitPrice)
    const cost = inventory.toNumber(this.data.costText)
    this.setData({
      amountText: util.money(qty * price),
      profitText: util.money((price - cost) * qty)
    })
  },

  submit() {
    try {
      const record = store.addSale({
        productId: this.data.productId,
        qty: this.data.qty,
        unitPrice: this.data.unitPrice,
        remark: this.data.remark
      })
      const product = store.getProduct(record.productId)
      this.setData({
        qty: '',
        remark: '',
        stockText: String(product.stock)
      })
      this.refreshPreview()
      wx.showToast({ title: '销售成功', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
