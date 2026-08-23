const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const saleSpecView = require('../../utils/sale-spec-view')
const slipActions = require('../../utils/slip-actions')
const memberChips = require('../../utils/member-chips').memberChips

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
    specAxis1: '规格一',
    specAxis2: '规格二',
    colorOptions: [],
    sizeOptions: [],
    blankProcess: false,
    customerId: '',
    customerName: '散客（可不选）',
    customerPhone: '',
    customerAddress: '',
    receivableText: '',
    hasDebt: false,
    paidAmount: '',
    paidTouched: false,
    debtText: '0.00',
    hasNewDebt: false,
    paidOver: false,
    overText: '0.00',
    qty: '',
    unitPrice: '',
    remark: '',
    operatorOpenid: '',
    operatorName: '',
    operatorTouched: false,
    members: [],
    myOpenid: '',
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
    exporting: false,
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
    let memberList = this._members || []
    let openid = this.data.myOpenid || ''
    try {
      openid = await store.whoami()
      const res = await store.listMembers()
      memberList = res.members || []
    } catch (error) {
      util.showError(error)
    }
    this._members = memberList
    const operatorPatch = {
      myOpenid: openid,
      members: memberChips(memberList, this.data.operatorTouched ? this.data.operatorOpenid : openid, openid)
    }
    if (!this.data.operatorTouched) {
      const me = memberList.find(function (item) {
        return item.openid === openid
      })
      operatorPatch.operatorOpenid = openid
      operatorPatch.operatorName = me ? String(me.displayName || '').trim() : ''
    }
    const selectedId = getApp().consumeSelectedProduct()
    const selectedCustomerId = getApp().consumeSelectedCustomer()
    this.setData(Object.assign({ products: products, skus: skus, pageLoading: false }, operatorPatch))
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

  cartItems(cart) {
    return (cart || this.data.cart).map(function (item) {
      return {
        productId: item.productId,
        skuId: item.skuId,
        color: item.color,
        size: item.size,
        qty: item.qty
      }
    })
  },

  toCartItem(product, sku, qty, unitPrice) {
    const count = inventory.round2(qty)
    const price = inventory.round2(unitPrice)
    const amount = inventory.round2(count * price)
    const spec = sku ? inventory.specText(sku.color, sku.size) : ''
    return {
      key: sku ? product.id + inventory.specKey(sku.color, sku.size) : product.id,
      productId: product.id,
      skuId: sku ? sku.id : '',
      color: sku ? sku.color : '',
      size: sku ? sku.size : '',
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
    const reserved = this.cartItems(cart)
    if (inventory.isBlankProcess(current)) {
      const selected = sku || this.currentSku(current)
      if (!selected) return '请选规格'
      const avail = inventory.blankAvailability(current, this.data.skus, selected.color, selected.size, reserved)
      if (!avail.total) return '0'
      return String(avail.total) + '（现货 ' + avail.ready + ' · 待加工 ' + avail.blank + '）'
    }
    if (inventory.productHasSpecs(current)) {
      const selected = sku || this.currentSku(current)
      if (!selected) return '请选规格'
      return String(inventory.round2(selected.stock - this.cartQtyOf(current.id, selected.id, cart)))
    }
    return String(inventory.round2(current.stock - this.cartQtyOf(current.id, '', cart)))
  },

  specOptions(product, selectedColor, selectedSize, cart) {
    return saleSpecView.saleSpecOptions(
      product,
      this.data.skus,
      selectedColor,
      selectedSize,
      this.cartItems(cart)
    )
  },

  stockPatch(product, sku, cart) {
    if (!product) {
      return { stockText: this.data.stockText }
    }
    return Object.assign({
      stockText: this.stockLeft(product, sku, cart)
    }, this.specOptions(product, this.data.selectedColor, this.data.selectedSize, cart))
  },

  cartDue(cart) {
    return inventory.round2((cart || this.data.cart).reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
    }, 0))
  },

  // 实收和应收的差额。应收变了就重算一遍，店主不用自己盯着两个数字对。
  paidPatch(dueAmount, paidValue) {
    const debt = inventory.round2(dueAmount - inventory.round2(paidValue))
    return {
      debtText: util.money(debt > 0 ? debt : 0),
      hasNewDebt: debt > 0,
      paidOver: debt < 0,
      overText: util.money(debt < 0 ? -debt : 0)
    }
  },

  totals(cart, qtyValue, priceValue) {
    const list = cart || this.data.cart
    const qty = qtyValue == null ? inventory.toNumber(this.data.qty) : inventory.toNumber(qtyValue)
    const price = priceValue == null ? inventory.toNumber(this.data.unitPrice) : inventory.toNumber(priceValue)
    const dueAmount = this.cartDue(list)
    const cartProfit = list.reduce(function (sum, item) {
      return sum + (inventory.toNumber(item.unitPrice) - inventory.toNumber(item.costPrice)) * inventory.toNumber(item.qty)
    }, 0)
    // 没动过实收就一直跟着应收走，默认就是收满。
    const paid = this.data.paidTouched
      ? this.data.paidAmount
      : (dueAmount > 0 ? util.money(dueAmount) : '')
    return Object.assign({
      lineAmountText: util.money(qty * price),
      amountText: util.money(dueAmount),
      profitText: util.money(cartProfit),
      paidAmount: paid
    }, this.paidPatch(dueAmount, paid))
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
    let costPrice = product.costPrice
    if (inventory.isBlankProcess(product)) {
      const blank = inventory.findBlankSku(this.data.skus, product.id)
      if (sku && inventory.toNumber(sku.stock) > 0) costPrice = sku.costPrice
      else if (blank) costPrice = blank.costPrice
    } else if (sku) {
      costPrice = sku.costPrice
    }
    const keepPrice = this.data.productId === product.id && this.data.unitPrice && this.data.skuId === (sku ? sku.id : '')
    const unitPrice = keepPrice
      ? this.data.unitPrice
      : String(sku ? sku.salePrice : product.salePrice)
    const patch = Object.assign({
      productId: product.id,
      productName: product.name,
      hasSpecs: hasSpecs,
      blankProcess: inventory.isBlankProcess(product),
      specAxis1: inventory.specAxis1Name(product),
      specAxis2: inventory.specAxis2Name(product),
      colors: colors,
      sizes: sizes,
      selectedColor: color,
      selectedSize: size,
      skuId: sku ? sku.id : '',
      costText: util.money(costPrice),
      unitPrice: unitPrice,
      stockText: this.stockLeft(product, sku, cart)
    }, this.specOptions(product, color, size, cart), this.totals(cart, this.data.qty, unitPrice))
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
    // 服务端 customers[].account 就是这个客户的当前欠款，和现算逐字段相等
    // （tests/ledger-terms.test.js 有等价断言）。不再自己遍历流水缓存算。
    const account = customer.account || { receivable: 0 }
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

  onPaidInput(e) {
    const value = e.detail.value
    this.setData(Object.assign({
      paidAmount: value,
      paidTouched: true
    }, this.paidPatch(this.cartDue(), value)))
  },

  fillPaidFull() {
    const due = this.cartDue()
    this.setData(Object.assign({
      paidAmount: due > 0 ? util.money(due) : '',
      paidTouched: false
    }, this.paidPatch(due, due)))
  },

  fillPaidNone() {
    const due = this.cartDue()
    this.setData(Object.assign({
      paidAmount: '0',
      paidTouched: true
    }, this.paidPatch(due, 0)))
  },

  goAddCustomer() {
    this.setData({ showCustomerPicker: false })
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?select=1' })
  },

  goCustomers() {
    wx.switchTab({ url: '/pages/customers/customers' })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const qty = field === 'qty' ? value : this.data.qty
    const price = field === 'unitPrice' ? value : this.data.unitPrice
    const patch = {}
    patch[field] = value
    this.setData(Object.assign(patch, this.totals(this.data.cart, qty, price)))
  },

  onOperatorName(e) {
    const name = e.detail.value
    const selectedOpenid = this.data.operatorOpenid
    const selected = (this._members || []).find(function (item) {
      return item.openid === selectedOpenid
    })
    const selectedName = selected ? String(selected.displayName || '').trim() : ''
    const patch = {
      operatorName: name,
      operatorTouched: true
    }
    if (selectedOpenid && name !== selectedName) {
      patch.operatorOpenid = ''
    }
    patch.members = memberChips(
      this._members,
      patch.operatorOpenid != null ? patch.operatorOpenid : selectedOpenid,
      this.data.myOpenid
    )
    this.setData(patch)
  },

  pickOperator(e) {
    const openid = e.currentTarget.dataset.openid
    const member = (this._members || []).find(function (item) {
      return item.openid === openid
    })
    this.setData({
      operatorOpenid: openid,
      operatorName: member ? String(member.displayName || '').trim() : '',
      operatorTouched: true,
      members: memberChips(this._members, openid, this.data.myOpenid)
    })
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
        qty: ''
      }, this.stockPatch(product, sku, cart), this.totals(cart, 0)))
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
    if (index >= 0) {
      list[index] = this.toCartItem(product, sku, nextQty, line.unitPrice)
    } else {
      list.push(line)
    }
    inventory.assertSaleItems(this.data.products, this.data.skus, this.cartItems(list))
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
      cart: cart
    }, this.stockPatch(product, sku, cart), this.totals(cart)))
  },

  async submit() {
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
      // 应收按最终清单重算：还没「加入清单」的那一行在这里已经并进来了，
      // 没动过实收时不能拿旧的清单金额去当实收，否则会凭空记一笔欠款。
      if (!cart.length) {
        wx.showToast({ title: '请先加入商品', icon: 'none' })
        return
      }
      const dueAmount = this.cartDue(cart)
      // 空着不当 0：清空重填时手滑提交，不该悄悄记成一整单欠款。
      if (this.data.paidTouched && !String(this.data.paidAmount).trim()) {
        wx.showToast({ title: '请填实收，没收到就填 0', icon: 'none' })
        return
      }
      const paidAmount = this.data.paidTouched
        ? inventory.round2(this.data.paidAmount)
        : dueAmount
      if (paidAmount < 0) {
        wx.showToast({ title: '实收不能为负数', icon: 'none' })
        return
      }
      if (paidAmount > dueAmount) {
        wx.showToast({ title: '实收比应收多，请改实收', icon: 'none' })
        return
      }
      const order = await store.addSale({
        customerId: this.data.customerId,
        paidAmount: paidAmount,
        remark: this.data.remark,
        operatorOpenid: this.data.operatorOpenid,
        operatorName: this.data.operatorName,
        items: cart.map(function (item) {
          return {
            productId: item.productId,
            skuId: item.skuId,
            color: item.color,
            size: item.size,
            qty: item.qty,
            unitPrice: item.unitPrice
          }
        })
      })
      // 记账刚成功，服务端回传的 customers[].account.receivable 就是这笔销售之后
      // 该客户的欠款。改完这条打单路径**不再依赖流水缓存**。
      const receivable = order.customerId
        ? ((store.getCustomer(order.customerId) || {}).account || {}).receivable || 0
        : 0
      const skus = store.getSkus()
      this.data.skus = skus
      const product = this.data.productId ? store.getProduct(this.data.productId) : null
      const sku = this.currentSku(product)
      const slipView = util.withSlipView(order, receivable, store.getProducts(), store.getShopName())
      this.slipImagePath = ''
      // 下一单重新默认收满，别把上一单填的实收留在框里。
      this.data.paidTouched = false
      this.setData(Object.assign({
        skus: skus,
        cart: [],
        qty: '',
        remark: '',
        paidTouched: false,
        showSlip: true,
        slip: slipView
      }, this.stockPatch(product, sku, []), this.totals([], 0)))
      this.prepareSlipImage(slipView)
      if (this.data.customerId) {
        this.selectCustomer(this.data.customerId)
      }
    } catch (error) {
      util.showError(error)
    }
  },

  prepareSlipImage(slip) {
    slipActions.prepareSlipImage(this, slip)
  },

  exportSlip() {
    slipActions.exportSlip(this)
  },

  closeSlip() {
    slipActions.closeSlip(this)
  }
})
