const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    products: [],
    productId: '',
    productName: '请选择商品',
    stockText: '-',
    qty: '',
    unitPrice: '',
    remark: '',
    amountText: '0.00',
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
      unitPrice: this.data.productId === id && this.data.unitPrice
        ? this.data.unitPrice
        : String(product.costPrice)
    })
    this.refreshAmount()
  },

  onField(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
    this.refreshAmount()
  },

  refreshAmount() {
    const amount = inventory.round2(inventory.toNumber(this.data.qty) * inventory.toNumber(this.data.unitPrice))
    this.setData({ amountText: util.money(amount) })
  },

  submit() {
    try {
      const record = store.addPurchase({
        productId: this.data.productId,
        qty: this.data.qty,
        unitPrice: this.data.unitPrice,
        remark: this.data.remark
      })
      this.setData({
        qty: '',
        remark: '',
        stockText: String(store.getProduct(record.productId).stock)
      })
      this.refreshAmount()
      wx.showToast({ title: '进货成功', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
