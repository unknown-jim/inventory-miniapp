const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const saleSpecView = require('../../utils/sale-spec-view')
const slipActions = require('../../utils/slip-actions')
const memberChips = require('../../utils/member-chips').memberChips

// 稿 card/客户 3:708 的散客态；副行文案与客户 picker 的散客行同源。
const WALKIN_NAME = '散客'
const WALKIN_SUB = '不填客户，送货单不显示收货人'
// 稿 hint 4:655 逐字。
const INFO_HINT = '经手人默认我，备注会写进送货单'

Page({
  data: {
    products: [],
    skus: [],
    productId: '',
    productName: '选择商品',
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
    blankNote: '',
    overNote: '',
    canAdd: false,
    qty: '',
    unitPrice: '',
    lineAmountText: '0.00',

    customerId: '',
    customerName: WALKIN_NAME,
    customerSub: WALKIN_SUB,
    customerMeta: '',
    customerPhone: '',
    customerAddress: '',
    // 客户预收余额。**读服务端投影 account.prepay，不在页面里折流水**
    // （utils/inventory.js 的 accountOf 已经把它折好，见规格 1.3）。
    customerPrepay: 0,
    prepayText: '0.00',

    infoOpen: false,
    infoHint: INFO_HINT,
    remark: '',
    operatorOpenid: '',
    operatorName: '',
    operatorTouched: false,
    members: [],
    myOpenid: '',

    cart: [],
    cartHead: '销售清单',
    qtyTotal: 0,
    amountText: '0.00',

    // 实收三格。paidAmount 是现金、prepayUsed 是本单抵掉的预收、
    // cashDueText 是「收满」chip 上那个数 = 应收 − 抵扣（稿 n11 4:691）。
    paidAmount: '',
    paidTouched: false,
    prepayOn: false,
    prepayUsed: 0,
    prepayUsedText: '0.00',
    cashDueText: '0.00',
    debtText: '0.00',
    hasNewDebt: false,
    paidOver: false,
    overText: '0.00',
    feedbackText: '',
    feedbackDanger: false,
    paidBlocked: false,
    summaryHint: '还没加商品',
    sheetTitle: '实收 · 散客',
    confirmText: '确认实收 ¥0.00',
    walkinDisabled: false,

    showPaid: false,
    showCart: false,
    showPicker: false,
    showCustomerPicker: false,
    showSlip: false,
    keyword: '',
    customerKeyword: '',
    filtered: [],
    filteredCustomers: [],
    slip: null,
    exporting: false,
    exportStyle: 'summary',
    slipCanvasWidth: 1760,
    slipCanvasHeight: 4000,
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
    } else {
      this.applySettle({})
    }
  },

  // -------------------------------------------------------------------------
  // 结算：本页所有金额口径的唯一入口。字段名与 G1 契约一一对应，不另造名字。
  //   due       = 本单应收（清单求和）
  //   prepayUsed= 抵扣开时 = min(应收, 客户预收余额)，抵扣关时 = 0
  //   cashDue   = due − prepayUsed，就是「收满」chip 上的数（稿 n11 4:691）
  //   paid      = 没动过实收就跟着 cashDue 走，动过就用店主填的数
  //   debt      = cashDue − paid，正数记欠款、负数是超收转预收
  // 服务端 resolvePaidAmount 的两条边界在这里对齐（utils/inventory.js:1843/1853）：
  //   · prepayUsed 不许超过应收 —— 这里用 min 保证
  //   · 抵扣 > 0 时实收不许超过 cashDue —— 这里拦成 paidBlocked，不让它抛到云上
  // over 里的字段覆盖 this.data，让「先算后 setData」只写一次。
  // -------------------------------------------------------------------------
  settlePatch(over) {
    const d = Object.assign({}, this.data, over || {})
    const list = d.cart || []
    const due = this.cartDue(list)
    const prepayBal = inventory.round2(inventory.toNumber(d.customerPrepay))
    const prepayUsed = (d.prepayOn && d.customerId && prepayBal > 0 && due > 0)
      ? inventory.round2(Math.min(due, prepayBal))
      : 0
    const cashDue = inventory.round2(due - prepayUsed)
    const paidText = d.paidTouched
      ? String(d.paidAmount == null ? '' : d.paidAmount)
      : (cashDue > 0 ? util.money(cashDue) : '')
    const paid = inventory.round2(String(paidText).trim() === '' ? 0 : paidText)
    const debt = inventory.round2(cashDue - paid)
    const over1 = debt < 0 ? inventory.round2(-debt) : 0
    const shortfall = debt > 0 ? debt : 0
    const who = d.customerId ? d.customerName : WALKIN_NAME
    const qtyTotal = inventory.round2(list.reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty)
    }, 0))

    let blocked = false
    let danger = false
    let feedback = ''
    if (paid < 0) {
      blocked = true
      danger = true
      feedback = '实收不能为负数'
    } else if (prepayUsed > 0 && over1 > 0) {
      // 服务端 utils/inventory.js:1853 会抛「已抵扣预收，实收不能超过 X」。
      // 一张单不要既抵预收又转预收，所以在这里就拦住，不把错误留给云函数。
      blocked = true
      danger = true
      feedback = '已抵扣预收，实收最多 ¥' + util.money(cashDue) + '；要多收请先关掉抵扣'
    } else if (!d.customerId && shortfall > 0) {
      // 稿 feedback 7:235 逐字
      blocked = true
      danger = true
      feedback = '散客不能欠款，未收 ¥' + util.money(shortfall)
    } else if (!d.customerId && over1 > 0) {
      // 稿 n2 3:737 逐字
      blocked = true
      danger = true
      feedback = '散客需收满 ¥' + util.money(due) + ' · 多收 ¥' + util.money(over1) + ' 请先选客户记预收'
    } else if (over1 > 0) {
      // 稿 feedback 10:185：muted 不是红字，确认钮照常可用（n7 3:769）
      feedback = '多收 ¥' + util.money(over1) + ' · 记为' + who + '预收'
    } else if (shortfall > 0) {
      // 稿 feedback 3:772
      feedback = '未收 ¥' + util.money(shortfall) + ' · 记为' + who + '欠款'
    } else if (prepayUsed > 0) {
      // 稿 feedback 7:409
      feedback = '预收抵扣 ¥' + util.money(prepayUsed) + ' · 本次实收已清'
    }

    // 底栏压缩句。稿 hint 7:20「未收 ¥84.00 · 预收未用」与散客变体 7:342「未收 ¥84.00 · 先选客户」。
    let summary
    if (!list.length) {
      summary = '还没加商品'
    } else if (blocked && !d.customerId) {
      summary = (shortfall > 0 ? '未收 ¥' + util.money(shortfall) : '多收 ¥' + util.money(over1)) + ' · 先选客户'
    } else if (blocked) {
      summary = feedback
    } else if (over1 > 0) {
      summary = '多收 ¥' + util.money(over1) + ' 记预收'
    } else if (shortfall > 0 && prepayUsed > 0) {
      summary = '未收 ¥' + util.money(shortfall) + ' · 预收抵 ¥' + util.money(prepayUsed)
    } else if (shortfall > 0 && prepayBal > 0) {
      summary = '未收 ¥' + util.money(shortfall) + ' · 预收未用'
    } else if (shortfall > 0) {
      summary = '未收 ¥' + util.money(shortfall) + ' 记欠款'
    } else if (prepayUsed > 0) {
      summary = '预收抵 ¥' + util.money(prepayUsed) + ' · 本单已清'
    } else {
      summary = '本单已收讫'
    }

    return {
      amountText: util.money(due),
      qtyTotal: qtyTotal,
      cartHead: list.length
        ? ('销售清单 · ' + list.length + ' 种 · 共 ' + qtyTotal + ' 件')
        : '销售清单',
      paidAmount: paidText,
      prepayUsed: prepayUsed,
      prepayUsedText: util.money(prepayUsed),
      prepayText: util.money(prepayBal),
      cashDueText: util.money(cashDue),
      debtText: util.money(shortfall),
      hasNewDebt: shortfall > 0,
      paidOver: over1 > 0,
      overText: util.money(over1),
      feedbackText: feedback,
      feedbackDanger: danger,
      paidBlocked: blocked,
      summaryHint: summary,
      sheetTitle: '实收 · ' + who,
      confirmText: '确认实收 ¥' + util.money(paid < 0 ? 0 : paid),
      // 稿 7:324：实收 ≠ 应收时散客置灰不可选（与 sheet 内禁用确认钮成双闸）
      walkinDisabled: shortfall > 0 || over1 > 0
    }
  },

  applySettle(patch) {
    const next = patch || {}
    this.setData(Object.assign({}, next, this.settlePatch(next)))
  },

  // -------------------------------------------------------------------------
  // 商品 / 规格 / 数量
  // -------------------------------------------------------------------------
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
    this.setData({ showPicker: true, showCustomerPicker: false, showPaid: false, showCart: false })
    this.applyFilter(this.data.keyword)
  },

  closePicker() {
    this.setData({ showPicker: false })
  },

  openCustomerPicker() {
    this.setData({ showCustomerPicker: true, showPicker: false, showCart: false })
    this.applyCustomerFilter(this.data.customerKeyword)
  },

  closeCustomerPicker() {
    this.setData({ showCustomerPicker: false })
  },

  openPaid() {
    if (!this.data.cart.length && !this.data.canAdd) {
      wx.showToast({ title: '请先加入商品', icon: 'none' })
      return
    }
    this.setData({ showPaid: true, showCart: false, showPicker: false, showCustomerPicker: false })
  },

  closePaid() {
    this.setData({ showPaid: false })
  },

  // 稿 7:508：确认实收只是把 sheet 里的数收下并关掉，真正记账是底栏「确认销售」。
  confirmPaid() {
    if (this.data.paidBlocked) return
    this.setData({ showPaid: false })
  },

  openCart() {
    this.setData({ showCart: true, showPaid: false, showPicker: false, showCustomerPicker: false })
  },

  closeCart() {
    this.setData({ showCart: false })
  },

  toggleInfo() {
    this.setData({ infoOpen: !this.data.infoOpen })
  },

  closePickerKeep() {},

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

  onPickCustomer(e) {
    this.selectCustomer(e.currentTarget.dataset.id)
    this.closeCustomerPicker()
  },

  goAddProduct() {
    this.setData({ showPicker: false })
    wx.navigateTo({ url: '/pages/product-edit/product-edit' })
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
      // 货号对商品、条码对规格（2026-09-01 裁定）：一律取商品级。
      // 此前是 `sku && sku.sku ? sku.sku : product.sku` —— 与 utils/inventory.js 里
      // 那五处同形，只是写成三元、藏在页面文件里，三轮清点都只扫 utils 没看见它。
      sku: product.sku,
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

  // 本行能不能加入清单。稿 n16 7:33：「清单累计（已入 + 本行）超过该格现货且半成品池
  // 也不够时，加入清单禁用并拦截，不只在数量为空时禁用」。判据直接用后端那份
  // assertSaleItems，不在页面里另写一套库存算式。
  linePatch(cart) {
    const list = cart || this.data.cart
    const qty = inventory.toNumber(this.data.qty)
    const price = inventory.toNumber(this.data.unitPrice)
    const patch = {
      lineAmountText: util.money(qty * price),
      blankNote: '',
      overNote: '',
      canAdd: false
    }
    const product = this.data.productId ? store.getProduct(this.data.productId) : null
    if (!product || qty <= 0) return patch
    const line = this.currentLine()
    if (!line) return patch
    if (line.error) {
      patch.overNote = line.error
      return patch
    }
    try {
      inventory.assertSaleItems(this.data.products, this.data.skus, this.cartItems(list.concat([line])))
    } catch (error) {
      patch.overNote = String((error && error.message) || '库存不够，不能加入清单')
      return patch
    }
    patch.canAdd = true
    // 稿 13:139;3:429：仅现货不足、真的要从半成品扣时才出现（n9 4:19）
    if (inventory.isBlankProcess(product)) {
      const sku = this.currentSku(product)
      if (sku) {
        const avail = inventory.blankAvailability(product, this.data.skus, sku.color, sku.size, this.cartItems(list))
        const short = inventory.round2(qty - inventory.toNumber(avail.ready))
        if (short > 0) patch.blankNote = '现货不足，将从半成品扣 ' + short + ' 件'
      }
    }
    return patch
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
    const base = Object.assign({
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
      unitPrice: unitPrice,
      stockText: this.stockLeft(product, sku, cart)
    }, this.specOptions(product, color, size, cart))
    this.setData(base)
    this.applySettle(this.linePatch(cart))
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

  onField(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const patch = {}
    patch[field] = value
    this.setData(patch)
    this.applySettle(this.linePatch(this.data.cart))
  },

  // -------------------------------------------------------------------------
  // 客户
  // -------------------------------------------------------------------------
  selectCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      this.clearCustomer()
      return
    }
    // 服务端 customers[].account 是这个客户的当前欠款与预收余额，和现算逐字段相等
    // （tests/ledger-terms.test.js 有等价断言）。不再自己遍历流水缓存算。
    const account = customer.account || {}
    const receivable = inventory.round2(inventory.toNumber(account.receivable))
    const prepay = inventory.round2(inventory.toNumber(account.prepay))
    // 稿 n-客户卡预收 10:155：有欠款时副行**只写欠款**，预收不并列出。
    const sub = receivable > 0
      ? ('当前欠款 ¥' + util.money(receivable))
      : (prepay > 0 ? ('无欠款 · 预收 ¥' + util.money(prepay) + ' 可抵') : '无欠款')
    const meta = [customer.phone, customer.address].filter(function (item) {
      return !!String(item || '').trim()
    }).join(' · ')
    // 稿 n-预收抵扣 7:428：刚进这张单时**默认抵扣开**；店主可以用 chip 一键关掉。
    this.applySettle({
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      customerSub: sub,
      customerMeta: meta,
      customerPrepay: prepay,
      prepayOn: prepay > 0,
      paidTouched: false,
      showCustomerPicker: false
    })
  },

  clearCustomer() {
    if (this.data.walkinDisabled) {
      wx.showToast({ title: '本单实收不等于应收，散客不能选', icon: 'none' })
      return
    }
    this.applySettle({
      customerId: '',
      customerName: WALKIN_NAME,
      customerSub: WALKIN_SUB,
      customerMeta: '',
      customerPhone: '',
      customerAddress: '',
      customerPrepay: 0,
      prepayOn: false,
      paidTouched: false,
      showCustomerPicker: false
    })
  },

  goPickCustomer() {
    this.setData({ showCustomerPicker: true })
    this.applyCustomerFilter(this.data.customerKeyword)
  },

  goAddCustomer() {
    this.setData({ showCustomerPicker: false })
    wx.navigateTo({ url: '/pages/customer-edit/customer-edit?select=1' })
  },

  // -------------------------------------------------------------------------
  // 实收 sheet
  // -------------------------------------------------------------------------
  onPaidInput(e) {
    this.applySettle({ paidAmount: e.detail.value, paidTouched: true })
  },

  fillPaidFull() {
    this.applySettle({ paidTouched: false })
  },

  fillPaidNone() {
    this.applySettle({ paidAmount: '0', paidTouched: true })
  },

  // 稿 chip 13:510 / 13:511 与抵扣行的 ×（13:512）都走这一个开关。
  // 切换会改变 cashDue，所以一律把 paidTouched 复位，让实收跟着新的「收满」值走
  // ——否则关掉抵扣之后框里还留着 152，屏上「收满 ¥352.00」和实收自相矛盾。
  togglePrepay() {
    if (!this.data.customerId || this.data.customerPrepay <= 0) return
    this.applySettle({ prepayOn: !this.data.prepayOn, paidTouched: false })
  },

  // -------------------------------------------------------------------------
  // 清单
  // -------------------------------------------------------------------------
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
    patch.infoHint = this.infoHintOf(name, this.data.remark)
    this.setData(patch)
  },

  pickOperator(e) {
    const openid = e.currentTarget.dataset.openid
    const member = (this._members || []).find(function (item) {
      return item.openid === openid
    })
    const name = member ? String(member.displayName || '').trim() : ''
    this.setData({
      operatorOpenid: openid,
      operatorName: name,
      operatorTouched: true,
      members: memberChips(this._members, openid, this.data.myOpenid),
      infoHint: this.infoHintOf(name, this.data.remark)
    })
  },

  // 收起态那一行的副信息。什么都没填就用稿 4:655 的默认句，填了就把填的内容摆出来
  // ——收起之后店主还得看得见自己填过什么。
  infoHintOf(operatorName, remark) {
    const who = String(operatorName || '').trim()
    const note = String(remark || '').trim()
    if (!who && !note) return INFO_HINT
    return (who || '我') + (note ? (' · ' + note) : '')
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
      // 稿 n-加入 13:560：加入后数量清空、钮禁用，商品与规格保留。
      this.setData(Object.assign({ cart: cart, qty: '' }, this.stockPatch(product, sku, cart)))
      this.applySettle(this.linePatch(cart))
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

  // 清单行改数量。稿 stepper 3:722;7:224 的加减与中间可点开的输入框共用这一条。
  setCartQty(key, qty) {
    const next = inventory.round2(qty)
    const list = this.data.cart.slice()
    const index = list.findIndex(function (item) {
      return item.key === key
    })
    if (index < 0) return
    if (next <= 0) {
      wx.showToast({ title: '数量要大于 0，删行请点行尾的 ×', icon: 'none' })
      return
    }
    const old = list[index]
    const product = store.getProduct(old.productId)
    const sku = old.skuId ? store.getSku(old.skuId) : null
    if (!product) return
    list[index] = this.toCartItem(product, sku, next, old.unitPrice)
    try {
      inventory.assertSaleItems(this.data.products, this.data.skus, this.cartItems(list))
    } catch (error) {
      util.showError(error)
      return
    }
    const cur = store.getProduct(this.data.productId)
    this.setData(Object.assign({ cart: list }, this.stockPatch(cur, this.currentSku(cur), list)))
    this.applySettle(this.linePatch(list))
  },

  onCartQty(e) {
    this.setCartQty(e.currentTarget.dataset.key, e.detail.value)
  },

  stepUp(e) {
    const key = e.currentTarget.dataset.key
    const item = this.data.cart.find(function (row) {
      return row.key === key
    })
    if (!item) return
    this.setCartQty(key, inventory.toNumber(item.qty) + 1)
  },

  stepDown(e) {
    const key = e.currentTarget.dataset.key
    const item = this.data.cart.find(function (row) {
      return row.key === key
    })
    if (!item) return
    this.setCartQty(key, inventory.toNumber(item.qty) - 1)
  },

  // 稿 n-删行 10:90：仅剩 1 行时 × 禁用，清空整单走放弃开单。
  removeCart(e) {
    if (this.data.cart.length <= 1) {
      wx.showToast({ title: '只剩一行了，清空整单请直接退出', icon: 'none' })
      return
    }
    const key = e.currentTarget.dataset.key
    const cart = this.data.cart.filter(function (item) {
      return item.key !== key
    })
    const product = store.getProduct(this.data.productId)
    const sku = this.currentSku(product)
    this.setData(Object.assign({ cart: cart }, this.stockPatch(product, sku, cart)))
    this.applySettle(this.linePatch(cart))
  },

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------
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
      const prepayBal = inventory.round2(inventory.toNumber(this.data.customerPrepay))
      const prepayUsed = (this.data.prepayOn && this.data.customerId && prepayBal > 0 && dueAmount > 0)
        ? inventory.round2(Math.min(dueAmount, prepayBal))
        : 0
      const cashDue = inventory.round2(dueAmount - prepayUsed)
      // 空着不当 0：清空重填时手滑提交，不该悄悄记成一整单欠款。
      if (this.data.paidTouched && !String(this.data.paidAmount).trim()) {
        wx.showToast({ title: '请填实收，没收到就填 0', icon: 'none' })
        return
      }
      const paidAmount = this.data.paidTouched
        ? inventory.round2(this.data.paidAmount)
        : cashDue
      if (paidAmount < 0) {
        wx.showToast({ title: '实收不能为负数', icon: 'none' })
        return
      }
      // 【G1】原来这里有一条「实收比应收多，请改实收」的客户端硬拦，本批删掉：
      // 多收的钱不再是错误，是预收（docs/accounting-vs-policy.md 的「预收」一条，
      // 服务端 utils/inventory.js:1856-1860 已经把溢出写进 prepayAdded）。
      // 剩下两条仍要在客户端拦，因为服务端拦下来只会抛一句技术话：
      if (prepayUsed > 0 && paidAmount > cashDue) {
        wx.showToast({ title: '已抵扣预收，实收最多 ¥' + util.money(cashDue), icon: 'none' })
        return
      }
      if (!this.data.customerId && inventory.round2(cashDue - paidAmount) !== 0) {
        wx.showToast({ title: '实收不等于应收，请先选客户', icon: 'none' })
        return
      }
      const order = await store.addSale({
        customerId: this.data.customerId,
        paidAmount: paidAmount,
        // 【G1】本单抵掉的预收。服务端 utils/ledger-apply.js:930 已经把这个键
        // 透传给 applySaleOrder，为 0 时后端也不会往单头上写这个字段。
        prepayUsed: prepayUsed,
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
      // 口径和 store.getSlip 对齐（「挑剔到 typeof、绝不默认成 0」）：null / 缺字段
      // 走 Number() 都会变成 0，而 0.00 的前欠会被当成「这个客户不欠钱」印在单据上。
      // 实际构造不出取不到值的路径 —— customerSnapshot 会先抛「客户不存在」，
      // withAggregates 给每个客户都挂了 account —— 这是口径对齐，不是修 bug；
      // 万一哪天投影缺了字段，宁可打不出单，不印错数。
      let receivable = 0
      let receivableBroken = false
      if (order.customerId) {
        const account = (store.getCustomer(order.customerId) || {}).account || {}
        if (typeof account.receivable !== 'number' || !isFinite(account.receivable)) {
          receivableBroken = true
        } else {
          receivable = account.receivable
        }
      }
      const skus = store.getSkus()
      this.data.skus = skus
      const product = this.data.productId ? store.getProduct(this.data.productId) : null
      const sku = this.currentSku(product)
      this.slipImagePath = ''
      // 下一单重新默认收满，别把上一单填的实收留在框里。
      this.data.paidTouched = false
      if (receivableBroken) {
        // 走到这里时**账已经记上了**，只是打不出单。必须按成功路径把购物车清掉
        // 再报错：留着「报错 + 满车」，店员最可能的动作是再点一次保存 ——
        // 同一笔账就记两遍。文案也要说清「已记上、别再按保存」；送货单不缺出路，
        // 到流水页打开这张单可以重打（record-edit 的 getSlip 自己按当时欠款算）。
        this.setData(Object.assign({
          skus: skus,
          cart: [],
          qty: '',
          remark: '',
          infoHint: INFO_HINT,
          paidTouched: false,
          showPaid: false,
          showCart: false
        }, this.stockPatch(product, sku, [])))
        this.applySettle(this.linePatch([]))
        if (this.data.customerId) {
          this.selectCustomer(this.data.customerId)
        }
        throw new Error('这笔账已记上，只是打不出单：别再按保存（会记两笔），送货单到流水里重打')
      }
      const slipView = util.withSlipView(order, receivable, store.getProducts(), store.getShopName())
      this.setData(Object.assign({
        skus: skus,
        cart: [],
        qty: '',
        remark: '',
        infoHint: INFO_HINT,
        paidTouched: false,
        showPaid: false,
        showCart: false,
        showSlip: true,
        slip: slipView,
        exportStyle: slipActions.initialExportStyle(slipView.customerId)
      }, this.stockPatch(product, sku, [])))
      this.applySettle(this.linePatch([]))
      this.prepareSlipImage(slipView)
      if (this.data.customerId) {
        // 重选一次客户：预收余额刚被这一单改过，抵扣默认值要按新余额重算。
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
  },

  onSlipStyleChange(e) {
    slipActions.changeExportStyle(this, e.detail.style)
  }
})
