const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const slipImage = require('../../utils/slip-image')

Page({
  data: {
    products: [],
    skus: [],
    productId: '',
    productName: '请选择商品',
    stockText: '-',
    costText: '-',
    hasSpecs: false,
    colors: [],
    sizes: [],
    selectedColor: '',
    selectedSize: '',
    skuId: '',
    colorOptions: [],
    sizeOptions: [],
    customerId: '',
    customerName: '散客（可不选）',
    customerPhone: '',
    customerAddress: '',
    receivableText: '',
    hasDebt: false,
    payType: 'cash',
    qty: '',
    unitPrice: '',
    remark: '',
    lineAmountText: '0.00',
    cart: [],
    amountText: '0.00',
    profitText: '0.00',
    showPicker: false,
    showCustomerPicker: false,
    showSlip: false,
    keyword: '',
    customerKeyword: '',
    filtered: [],
    filteredCustomers: [],
    slip: null,
    exporting: false
  },

  onShow() {
    const products = store.getProducts()
    const skus = store.getSkus()
    const selectedId = getApp().consumeSelectedProduct()
    const selectedCustomerId = getApp().consumeSelectedCustomer()
    this.setData({ products: products, skus: skus })
    this.data.skus = skus
    this.data.products = products
    this.applyFilter(this.data.keyword, products, skus)
    this.applyCustomerFilter(this.data.customerKeyword)
    if (selectedId) {
      this.selectProduct(selectedId)
    } else if (this.data.productId) {
      this.selectProduct(this.data.productId)
    }
    if (selectedCustomerId) {
      this.selectCustomer(selectedCustomerId)
    } else if (this.data.customerId) {
      this.selectCustomer(this.data.customerId)
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

  applyCustomerFilter(keyword) {
    this.setData({
      customerKeyword: keyword,
      filteredCustomers: inventory.sortCustomers(
        inventory.filterCustomers(store.getCustomers(), keyword)
      )
    })
  },

  onSearch(e) {
    this.applyFilter(e.detail.value)
  },

  onCustomerSearch(e) {
    this.applyCustomerFilter(e.detail.value)
  },

  openPicker() {
    if (!this.data.products.length) {
      wx.showToast({ title: '请先新增商品', icon: 'none' })
      return
    }
    this.setData({ showPicker: true, showCustomerPicker: false })
    this.applyFilter(this.data.keyword)
  },

  closePicker() {
    this.setData({ showPicker: false })
  },

  openCustomerPicker() {
    this.setData({ showCustomerPicker: true, showPicker: false })
    this.applyCustomerFilter(this.data.customerKeyword)
  },

  closeCustomerPicker() {
    this.setData({ showCustomerPicker: false })
  },

  closePickerKeep() {},

  onPick(e) {
    this.selectProduct(e.currentTarget.dataset.id)
    this.closePicker()
  },

  onPickCustomer(e) {
    this.selectCustomer(e.currentTarget.dataset.id)
    this.closeCustomerPicker()
  },

  cartQtyOf(productId, skuId, cart) {
    const list = cart || this.data.cart
    return list.reduce(function (sum, item) {
      if (skuId) {
        return item.skuId === skuId ? sum + inventory.toNumber(item.qty) : sum
      }
      return !item.skuId && item.productId === productId ? sum + inventory.toNumber(item.qty) : sum
    }, 0)
  },

  toCartItem(product, sku, qty, unitPrice) {
    const count = inventory.round2(qty)
    const price = inventory.round2(unitPrice)
    const amount = inventory.round2(count * price)
    const spec = sku ? inventory.specText(sku.color, sku.size) : ''
    return {
      key: sku ? sku.id : product.id,
      productId: product.id,
      skuId: sku ? sku.id : '',
      name: product.name,
      specText: spec,
      sku: sku && sku.sku ? sku.sku : product.sku,
      qty: count,
      unitPrice: price,
      costPrice: sku ? sku.costPrice : product.costPrice,
      qtyText: String(count),
      priceText: util.money(price),
      amountText: util.money(amount)
    }
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

  stockLeft(product, sku, cart) {
    const current = product || store.getProduct(this.data.productId)
    if (!current) return '-'
    if (inventory.productHasSpecs(current)) {
      const selected = sku || this.currentSku(current)
      if (!selected) return '请选规格'
      return String(inventory.round2(selected.stock - this.cartQtyOf(current.id, selected.id, cart)))
    }
    return String(inventory.round2(current.stock - this.cartQtyOf(current.id, '', cart)))
  },

  specOptions(product, selectedColor, selectedSize) {
    const colors = (product && product.colors) || []
    const sizes = (product && product.sizes) || []
    const skus = this.data.skus
    const colorOptions = colors.map(function (color) {
      const related = inventory.skusOfProduct(skus, product.id).filter(function (item) {
        return item.color === color
      })
      const stock = related.reduce(function (sum, item) {
        return sum + inventory.toNumber(item.stock)
      }, 0)
      return { value: color, stock: stock, on: color === selectedColor }
    })
    const sizeOptions = sizes.map(function (size) {
      const sku = inventory.findSkuBySpec(skus, product.id, selectedColor || '', size)
      return {
        value: size,
        stock: sku ? sku.stock : 0,
        on: size === selectedSize,
        low: !!(sku && sku.stock <= sku.alertQty)
      }
    })
    return { colorOptions: colorOptions, sizeOptions: sizeOptions }
  },

  totals(cart, qtyValue, priceValue) {
    const list = cart || this.data.cart
    const qty = qtyValue == null ? inventory.toNumber(this.data.qty) : inventory.toNumber(qtyValue)
    const price = priceValue == null ? inventory.toNumber(this.data.unitPrice) : inventory.toNumber(priceValue)
    const cartAmount = list.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
    }, 0)
    const cartProfit = list.reduce(function (sum, item) {
      return sum + (inventory.toNumber(item.unitPrice) - inventory.toNumber(item.costPrice)) * inventory.toNumber(item.qty)
    }, 0)
    return {
      lineAmountText: util.money(qty * price),
      amountText: util.money(cartAmount),
      profitText: util.money(cartProfit)
    }
  },

  applyProductState(product, selectedColor, selectedSize, cart) {
    const hasSpecs = inventory.productHasSpecs(product)
    const colors = product.colors || []
    const sizes = product.sizes || []
    let color = selectedColor
    let size = selectedSize
    if (hasSpecs) {
      if (colors.length === 1) color = colors[0]
      if (sizes.length === 1) size = sizes[0]
    } else {
      color = ''
      size = ''
    }
    const sku = hasSpecs ? inventory.findSkuBySpec(this.data.skus, product.id, color, size) : null
    const keepPrice = this.data.productId === product.id && this.data.unitPrice && this.data.skuId === (sku ? sku.id : '')
    const unitPrice = keepPrice
      ? this.data.unitPrice
      : String(sku ? sku.salePrice : product.salePrice)
    const patch = Object.assign({
      productId: product.id,
      productName: product.name,
      hasSpecs: hasSpecs,
      colors: colors,
      sizes: sizes,
      selectedColor: color,
      selectedSize: size,
      skuId: sku ? sku.id : '',
      costText: util.money(sku ? sku.costPrice : product.costPrice),
      unitPrice: unitPrice,
      stockText: this.stockLeft(product, sku, cart)
    }, this.specOptions(product, color, size), this.totals(cart, this.data.qty, unitPrice))
    this.setData(patch)
  },

  selectProduct(id) {
    const product = store.getProduct(id)
    if (!product) return
    const same = this.data.productId === id
    this.applyProductState(
      product,
      same ? this.data.selectedColor : '',
      same ? this.data.selectedSize : '',
      this.data.cart
    )
  },

  pickColor(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    this.applyProductState(product, e.currentTarget.dataset.value, this.data.selectedSize, this.data.cart)
  },

  pickSize(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    this.applyProductState(product, this.data.selectedColor, e.currentTarget.dataset.value, this.data.cart)
  },

  selectCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      this.clearCustomer()
      return
    }
    const account = inventory.summarizeCustomerAccount(store.getRecords(), id)
    this.setData({
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      receivableText: util.money(account.receivable),
      hasDebt: account.receivable > 0
    })
  },

  clearCustomer() {
    this.setData({
      customerId: '',
      customerName: '散客（可不选）',
      customerPhone: '',
      customerAddress: '',
      receivableText: '',
      hasDebt: false,
      showCustomerPicker: false
    })
  },

  setPayType(e) {
    this.setData({ payType: e.currentTarget.dataset.type })
  },

  goAddCustomer() {
    this.setData({ showCustomerPicker: false })
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?select=1' })
  },

  goCustomers() {
    wx.navigateTo({ url: '/pages/customers/customers' })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const qty = field === 'qty' ? value : this.data.qty
    const price = field === 'unitPrice' ? value : this.data.unitPrice
    this.setData(Object.assign({ [field]: value }, this.totals(this.data.cart, qty, price)))
  },

  currentLine() {
    const product = store.getProduct(this.data.productId)
    if (!product) return null
    const qty = inventory.round2(this.data.qty)
    const unitPrice = inventory.round2(this.data.unitPrice)
    if (qty <= 0) return null
    if (unitPrice < 0) return null
    if (inventory.productHasSpecs(product)) {
      const colors = product.colors || []
      const sizes = product.sizes || []
      if ((colors.length && !this.data.selectedColor) || (sizes.length && !this.data.selectedSize)) {
        return { error: inventory.specSelectHint(product) }
      }
      const sku = this.currentSku(product)
      if (!sku) return { error: '规格不存在' }
      return this.toCartItem(product, sku, qty, unitPrice)
    }
    return this.toCartItem(product, null, qty, unitPrice)
  },

  addCart() {
    try {
      const line = this.currentLine()
      if (line && line.error) {
        wx.showToast({ title: line.error, icon: 'none' })
        return
      }
      if (!line) {
        wx.showToast({ title: '请选择商品并填写数量', icon: 'none' })
        return
      }
      const cart = this.mergeLine(line, this.data.cart)
      const product = store.getProduct(line.productId)
      const sku = line.skuId ? store.getSku(line.skuId) : null
      this.setData(Object.assign({
        cart: cart,
        qty: '',
        stockText: this.stockLeft(product, sku, cart)
      }, this.totals(cart, 0)))
      wx.showToast({ title: '已加入清单', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  },

  mergeLine(line, cart) {
    const product = store.getProduct(line.productId)
    const sku = line.skuId ? store.getSku(line.skuId) : null
    const list = (cart || []).slice()
    const index = list.findIndex(function (item) {
      return item.key === line.key
    })
    const nextQty = inventory.round2((index >= 0 ? list[index].qty : 0) + line.qty)
    const left = sku ? sku.stock : product.stock
    if (left < nextQty) {
      const label = product.name + (line.specText ? ' ' + line.specText : '')
      throw new Error(label + ' 库存不足，当前库存 ' + left)
    }
    if (index >= 0) {
      list[index] = this.toCartItem(product, sku, nextQty, line.unitPrice)
    } else {
      list.push(line)
    }
    return list
  },

  removeCart(e) {
    const key = e.currentTarget.dataset.key
    const cart = this.data.cart.filter(function (item) {
      return item.key !== key
    })
    const product = store.getProduct(this.data.productId)
    const sku = this.currentSku(product)
    this.setData(Object.assign({
      cart: cart,
      stockText: this.stockLeft(product, sku, cart)
    }, this.totals(cart)))
  },

  submit() {
    try {
      const cart = this.data.cart.slice()
      const line = this.currentLine()
      if (line && line.error) {
        wx.showToast({ title: line.error, icon: 'none' })
        return
      }
      if (line) {
        cart.splice(0, cart.length)
        this.mergeLine(line, this.data.cart).forEach(function (item) {
          cart.push(item)
        })
      }
      const order = store.addSale({
        customerId: this.data.customerId,
        payType: this.data.payType,
        remark: this.data.remark,
        items: cart.map(function (item) {
          return {
            productId: item.productId,
            skuId: item.skuId,
            qty: item.qty,
            unitPrice: item.unitPrice
          }
        })
      })
      const receivable = order.customerId
        ? inventory.summarizeCustomerAccount(store.getRecords(), order.customerId).receivable
        : 0
      const skus = store.getSkus()
      this.data.skus = skus
      const product = this.data.productId ? store.getProduct(this.data.productId) : null
      const sku = this.currentSku(product)
      const slipView = util.withSlipView(order, receivable)
      this.slipImagePath = ''
      this.setData(Object.assign({
        skus: skus,
        cart: [],
        qty: '',
        remark: '',
        showSlip: true,
        slip: slipView,
        stockText: product ? this.stockLeft(product, sku, []) : this.data.stockText
      }, this.totals([], 0)))
      this.prepareSlipImage(slipView)
      if (this.data.customerId) {
        this.selectCustomer(this.data.customerId)
      }
    } catch (error) {
      util.showError(error)
    }
  },

  prepareSlipImage(slip) {
    const self = this
    const docNo = slip && slip.docNo
    slipImage.exportToTempFile(this, slip).then(function (path) {
      if (self.data.showSlip && self.data.slip && self.data.slip.docNo === docNo) {
        self.slipImagePath = path
      }
    }).catch(function () {
      self.slipImagePath = ''
    })
  },

  exportSlip() {
    if (this.data.exporting) return
    const ready = this.slipImagePath
    if (ready) {
      this.openSlipImage(ready)
      return
    }
    const slip = this.data.slip
    if (!slip) return
    this.setData({ exporting: true })
    wx.showLoading({ title: '生成图片', mask: true })
    const self = this
    slipImage.exportToTempFile(this, slip).then(function (path) {
      self.slipImagePath = path
      self.setData({ exporting: false })
      wx.hideLoading()
      self.openSlipImage(path)
    }).catch(function (error) {
      self.setData({ exporting: false })
      wx.hideLoading()
      util.showError(error && error.message ? error : new Error('导出失败'))
    })
  },

  openSlipImage(path) {
    slipImage.openExportedImage(path).catch(function (error) {
      util.showError(error)
    })
  },

  closeSlip() {
    this.slipImagePath = ''
    this.setData({ showSlip: false, exporting: false })
  }
})
