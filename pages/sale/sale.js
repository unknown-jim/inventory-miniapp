const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const saleSpecView = require('../../utils/sale-spec-view')
const slipActions = require('../../utils/slip-actions')
const memberChips = require('../../utils/member-chips').memberChips

// 规格取值是店主自由输入的（docs/blank-process.md：取值可改、可删、可追加，不预置行业
// 取值），直接拿它当 cellQtys 的对象 key 会撞上 Object.prototype 上的名字：取值叫
// constructor / toString / valueOf 时读出来是函数，数量框里会显示
// "function Object() { [native code] }"；取值叫 __proto__ 时那一格连数量都存不进去
// （赋字符串给 __proto__ 被静默忽略，写 '5' 读回 '[object Object]'），用户填了没反应
// 也不报错。加一个固定前缀把用户输入和原型属性名隔开。
//
// 记账不受影响——inventory.toNumber 的 Number.isFinite 兜底把这些值折成 0，
// currentLines 的「qty <= 0 continue」会跳过，NaN 行进不了清单。修的是显示与录入。
//
// cellQtys 是纯内部状态：wxml 只绑 cellRows 数组，不直接读它，所以 key 格式不外溢。
// tests/sale-spec-view.test.js 末尾有静态钉子，禁止绕过这个函数裸写下标。
function cellKey(size) {
  return 'v:' + size
}

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
    // 规格二支持多选（批 2/2026-09-02）。|Z| <= 1 时卡渲染成既有单选形态（主屏那套，
    // 一个字不改），selectedSizes 里最多一个元素；|Z| >= 2 时切多选形态，见 multiMode。
    selectedSizes: [],
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
    // 「本次售价」这个框里现在的值是不是**店主自己填的**。false = 系统写进去的
    // （追平到某一格的档价），true = 有人动过 onField。这不是「和档价不相等」的
    // 派生量：店主完全可以手打一个恰好等于档价的数，也可以手打完再改回来。
    // 唯一置位点是 onField（wxml 的 .js-batch-price / .js-single-price 都绑它），
    // 唯一复位点是 pricePatch（系统每次自己写 unitPrice 都把归属收回去）。
    priceTouched: false,
    lineAmountText: '0.00',
    // 以下四个字段只在多选形态（multiMode）下被 wxml 消费：batchQty 是「全部填」框的
    // 字面值（一次性动作，不跨批记忆）；cellQtys 是 格(size) -> 数量 的草稿；
    // multiMode 派生自 selectedSizes.length >= 2；batchLineCount / addBtnLabel /
    // cellRows 由 linePatch 统一算，裁定 C：N = 有正数量的格数，不是选中格数。
    batchQty: '',
    cellQtys: {},
    multiMode: false,
    allSizesOn: false,
    batchLineCount: 0,
    addBtnLabel: '加入清单',
    cellRows: [],

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

  // 单选形态下"当前唯一选中的格"；|Z| = 0 或 >= 2 时没有这个概念，返回空串。
  singleSelectedSize() {
    return this.data.selectedSizes.length === 1 ? this.data.selectedSizes[0] : ''
  },

  // selectedSizes 和 multiMode 是同一件事的两种形状：multiMode 就是 selectedSizes.length
  // >= 2 的派生量，不是独立状态。2026-09-02 的回归就是漏处：pickSize/pickAllSizes 的
  // 写入点只改了 selectedSizes、忘了同步 multiMode，UI 测试卡在切多选形态那一步——
  // 页面 data 里 selectedSizes 已经是 2 个了，multiMode 却还停在旧值，wxml 永远切不到
  // 多选模板。所以收敛到这一个函数：任何要改 selectedSizes 的地方都只准调它拿 patch，
  // 不许自己手写 { selectedSizes: ..., multiMode: ... }——写集合却漏派生量这件事，
  // 结构上就做不到。tests/sale-spec-view.test.js 末尾有条静态钉子扫全部 setData({...})，
  // 逮到「selectedSizes 单独出现在 patch 里、没有 multiMode 也没有走这个函数」就红。
  sizeSelectionPatch(nextSizes) {
    return { selectedSizes: nextSizes, multiMode: nextSizes.length >= 2 }
  },

  currentSku(product) {
    const current = product || store.getProduct(this.data.productId)
    if (!current || !inventory.productHasSpecs(current)) return null
    const colors = current.colors || []
    const sizes = current.sizes || []
    const size = this.singleSelectedSize()
    if ((colors.length && !this.data.selectedColor) || (sizes.length && !size)) {
      return null
    }
    return inventory.findSkuBySpec(this.data.skus, current.id, this.data.selectedColor, size)
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

  specOptions(product, selectedColor, selectedSizes, cart) {
    return saleSpecView.saleSpecOptions(
      product,
      this.data.skus,
      selectedColor,
      selectedSizes,
      this.cartItems(cart)
    )
  },

  stockPatch(product, sku, cart) {
    if (!product) {
      return { stockText: this.data.stockText, cellRows: [] }
    }
    const sizes = product.sizes || []
    const selectedSizes = this.data.selectedSizes || []
    const specPatch = this.specOptions(product, this.data.selectedColor, selectedSizes, cart)
    return Object.assign({
      stockText: this.stockLeft(product, sku, cart),
      // 「全选」chip 的三态：全选 / 未全选（部分选中与一个都没选同为未选中，无第三态）。
      allSizesOn: sizes.length > 0 && sizes.every(function (s) {
        return selectedSizes.indexOf(s) >= 0
      }),
      // 逐格行的"形状"（选中了哪几格）只由 selectedSizes + sizeOptions 决定，跟
      // "有没有正数量的行"无关——这里跟 stockText / colorOptions / sizeOptions 一样
      // 是每次拼 spec 状态都会重算的东西，没有任何早退能绕过它。2026-09-02 的回归
      // 就是把这段逻辑塞进了 linePatch 的 "if (!lines.length) return" 后面——选中
      // 两格但还没填数量时 lines 是空的，cellRows 也就永远生不出来，用户连输入框
      // 都看不到，无从填出第一个正数量（鸡生蛋）。红字/琥珀才是要等真的有正数量的
      // 行、真的跑过 assertSaleItems 才有意义的东西，两者不是一回事。
      cellRows: this.data.multiMode ? this.buildCellRows(specPatch.sizeOptions, '') : []
    }, specPatch)
  },

  // 选中集合 / 逐格草稿变化之后统一刷新：chips 的 on 态与「全选」三态、逐格现货 hint、
  // 金额、琥珀/红字、按钮态。pickSize / pickAllSizes / 多选态 pickColor 共用这一条。
  recomputeAfterSpecChange(product) {
    this.setData(this.stockPatch(product, this.currentSku(product), this.data.cart))
    this.applySettle(this.linePatch(this.data.cart))
  },

  cartDue(cart) {
    return inventory.round2((cart || this.data.cart).reduce(function (sum, item) {
      return sum + inventory.toNumber(item.qty) * inventory.toNumber(item.unitPrice)
    }, 0))
  },

  // 逐格标红：整批失败时才逐格增量定位，只标第一个抛错的格（多格同时超格时卡级红字
  // 只出一句，UX 注释 9 / 状态机 §1.3：后面的格库存已被吃掉，状态无意义）。
  // overNote 已经从外层那次整批 assertSaleItems 的报错里取好了，这里只找"哪一格"。
  locateOverCell(cart, lines) {
    for (let i = 0; i < lines.length; i++) {
      try {
        inventory.assertSaleItems(
          this.data.products,
          this.data.skus,
          this.cartItems(cart.concat(lines.slice(0, i + 1)))
        )
      } catch (error) {
        return lines[i].size
      }
    }
    return ''
  },

  // 多选态逐格行的渲染数组：从 sizeOptions（现货 hint，裁定 B 用 ready 不用 stock）+
  // cellQtys（草稿值）+ overKey（唯一标红格）拼出来，顺序就是 sizeOptions 的顺序
  // （= product.sizes 顺序，即"行序"）。
  buildCellRows(sizeOptions, overKey) {
    const cellQtys = this.data.cellQtys || {}
    return (sizeOptions || []).filter(function (opt) {
      return opt.on
    }).map(function (opt) {
      const raw = cellQtys[cellKey(opt.value)]
      return {
        value: opt.value,
        qtyText: raw == null ? '' : String(raw),
        hint: '现货 ' + opt.ready,
        over: !!overKey && opt.value === overKey
      }
    })
  },

  // 本批能不能加入清单。稿 n16 7:33：「清单累计（已入 + 本批）超过现货且半成品池也不够
  // 时，加入清单禁用并拦截」。判据直接用后端那份 assertSaleItems，不在页面里另写一套
  // 库存算式。H6：批后只跑一次 assertSaleItems（省重复全量克隆，不是防中间态误判——
  // 顺序贪心下整批通过蕴含每个前缀通过）。
  linePatch(cart) {
    const list = cart || this.data.cart
    const product = this.data.productId ? store.getProduct(this.data.productId) : null
    const result = this.currentLines()
    const lines = result.lines

    // H2：金额无条件从当前输入算，位置在任何早退之前——多选态是"本批 N 格 · 合计"，
    // 同样不许因为校验没过就清零或不渲染（稿 ③ 22:169 的 ¥1792.00 就是这条的证据）。
    //
    // 单选形态必须直接读 data.qty × data.unitPrice，**不能**从 lines 求和：currentLines()
    // 在「有规格但还没选全」时返回 { lines: [], error: 请选规格 }，空数组求和恒为 0，
    // 屏上的本行金额会从 50.00 掉回 0.00 —— 位置在早退之前是对的，来源错了。
    // baseline 840408b 这里逐字是 util.money(qty * price)，H2 举的正是这一格
    //（2026-09-02 返工：上一轮把两种形态合并成一次 reduce，就是这么破的）。
    const amount = this.data.multiMode
      ? inventory.round2(lines.reduce(function (sum, line) {
        return sum + inventory.toNumber(line.qty) * inventory.toNumber(line.unitPrice)
      }, 0))
      : inventory.toNumber(this.data.qty) * inventory.toNumber(this.data.unitPrice)
    // 裁定 C：N = 有正数量的格数（= lines.length），不是选中格数。
    const patch = {
      lineAmountText: util.money(amount),
      batchLineCount: lines.length,
      addBtnLabel: lines.length ? ('加入清单（' + lines.length + ' 行）') : '加入清单',
      blankNote: '',
      overNote: '',
      // cellRows 不在这里管：它的"形状"由 stockPatch 无条件算好（见那边的注释），
      // 这个方法只在下面 multiMode 且真的有 lines 时，拿 overKey 重新贴一次标红。
      canAdd: false
    }

    if (!product) return patch
    if (result.error) {
      patch.overNote = result.error
      return patch
    }
    if (!lines.length) {
      // 逐格红框要跟着清：填爆 → 再把所有格清空之后 lines 为空，从这里早退。overNote /
      // canAdd 在 patch 的初值里已经清好了，cellRows 却不在初值里（它由 stockPatch 管
      // 形状），上一次标红的那一格会把红描边留在屏上（稿 S5 22:343：两格都是常态描边
      // $3:85）。这里只重贴一次 overKey='' 的同一份行，不改行的形状。
      if (this.data.multiMode) patch.cellRows = this.buildCellRows(this.data.sizeOptions, '')
      return patch
    }

    const reserved = this.cartItems(list)

    if (this.data.multiMode) {
      // 多选态：琥珀行按 P0-P3 独立算，跟 assertSaleItems 成败无关——P3 时两者并存
      // （琥珀是整批口径，红字是该格口径，稿 S4 / UX 注释 8）。
      if (inventory.isBlankProcess(product)) {
        const short = saleSpecView.blankShortOf(product, this.data.skus, lines, reserved)
        if (short > 0) {
          const pool = inventory.blankAvailability(product, this.data.skus, '', '', reserved).blank
          patch.blankNote = short <= pool
            ? ('现货不足，本批将从半成品扣 ' + short + ' 件')
            : ('现货不足，半成品只够补 ' + pool + ' 件，本批还差 ' + inventory.round2(short - pool) + ' 件')
        }
      }
      let overKey = ''
      try {
        inventory.assertSaleItems(this.data.products, this.data.skus, this.cartItems(list.concat(lines)))
        patch.canAdd = true
      } catch (error) {
        patch.overNote = String((error && error.message) || '库存不够，不能加入清单')
        overKey = this.locateOverCell(list, lines)
      }
      patch.cellRows = this.buildCellRows(this.data.sizeOptions, overKey)
      return patch
    }

    // 单选形态：既有逻辑一个字不改（H3 的 isBlankProcess 守卫也原样留着）。
    try {
      inventory.assertSaleItems(this.data.products, this.data.skus, this.cartItems(list.concat(lines)))
    } catch (error) {
      patch.overNote = String((error && error.message) || '库存不够，不能加入清单')
      return patch
    }
    patch.canAdd = true
    // 稿 13:139;3:429：仅现货不足、真的要从半成品扣时才出现（n9 4:19）
    if (inventory.isBlankProcess(product)) {
      const sku = this.currentSku(product)
      if (sku) {
        const avail = inventory.blankAvailability(product, this.data.skus, sku.color, sku.size, reserved)
        const qty = lines[0] ? inventory.toNumber(lines[0].qty) : 0
        const short = inventory.round2(qty - inventory.toNumber(avail.ready))
        if (short > 0) patch.blankNote = '现货不足，将从半成品扣 ' + short + ' 件'
      }
    }
    return patch
  },

  // 「本次售价」的唯一写出口。keep 为真＝框里现在这个值是店主自己填的、系统不许冲掉；
  // 为假＝追平到参照格 refSku 的档价（没有参照格就退回商品档价），同时把归属收回给
  // 系统（priceTouched 复位）。**两个字段必须一起写**，这是这个函数存在的全部理由：
  //
  //   · 只写 unitPrice 不写 priceTouched：追平一次之后标志还挂着 true，后面每一次
  //     多选态换规格一 / 增删格都会「保留」一个其实是系统自己写进去的价——一次手改
  //     永久生效。
  //   · 只写 priceTouched 不写 unitPrice：就是本次要修的那个 bug 的形状。
  //
  // 页面 data 的 unitPrice 只准由这里写出来（三个调用点：applyProductState /
  // applySizeSelection / pickColor 的多选支），加上 onField 那个用户输入口。
  // 2026-09-03 的实测后果：pickColor 的多选支只写了 selectedColor，unitPrice 一个字
  // 没动——黑色 M+L 单价 69，换到白色（两格档价都是 59）之后屏上仍是 69，两格各 1 件
  // 加入清单就是白 M ×1 @69、白 L ×1 @69，屏上没有任何提示。
  // tests/sale-spec-view.test.js 末尾有静态钉子守这条收敛。
  pricePatch(keep, refSku, product) {
    return {
      unitPrice: keep ? this.data.unitPrice : String(refSku ? refSku.salePrice : product.salePrice),
      priceTouched: keep ? this.data.priceTouched : false
    }
  },

  // selectedSizes 是选中集合（数组）。sizes.length === 1 时自动选中该值（既有单值轴的
  // 便利行为，一个字不改），|Z| 由此算出的 multiMode 跟着走。
  applyProductState(product, selectedColor, selectedSizes, cart) {
    const hasSpecs = inventory.productHasSpecs(product)
    const colors = product.colors || []
    const sizes = product.sizes || []
    let color = selectedColor
    let sizesSel = (selectedSizes || []).slice()
    if (hasSpecs) {
      if (colors.length === 1) color = colors[0]
      if (sizes.length === 1) sizesSel = [sizes[0]]
    } else {
      color = ''
      sizesSel = []
    }
    const singleSize = sizesSel.length === 1 ? sizesSel[0] : ''
    const sku = hasSpecs ? inventory.findSkuBySpec(this.data.skus, product.id, color, singleSize) : null
    // 「参照格没变」，`skuId` 只答得了**身份**那一半：
    //
    //   · 身份没变（还是同一枚 SKU）—— sameRefCell 判的就是这个。
    //   · 内容没变（那一枚 SKU 的档价还是原来那个数）—— skuId 一个字都答不了。
    //
    // 只判身份的后果（22:231，实测复现）：店主在销售页选中黑 M（系统把本次售价
    // 追平到 69），中途去商品编辑把**这一格**的档价改成 79，回销售页 onShow →
    // selectProduct → 这里。skuId 一模一样，判真，框里留着过期的 69。那个 69 看上去
    // 完全正常、只是过期了，屏上没有任何异常，按它出货销售额 / 毛利 / 欠款一起错 ——
    // 静默错账，比屏上跳个数危险得多。
    //
    // 所以规则就是裁定原文那一句：**身份没变 + 没手改过 → 一律重新取该格档价**；
    // 手改过就保留他填的。不需要再问一句「框里这个值过期了没」——没手改过时，
    // 不管过期与否都重新取，没过期时取回来的就是同一个数。
    //
    // （2026-09-04：上一版这里多了一项 `|| this.data.unitPrice === systemPrice`，并用
    // 十几行注释把它讲成本次修复的核心机制。审计穷举 185,040 组证明它**完全不产生行为**：
    // 那一支里等式为真时写 (this.data.unitPrice, false)、为假时写 (systemPrice, false)，
    // 而等式为真恰恰意味着两者相等 —— 两条路写出同一对值。`systemPrice` 换成任意
    // 垃圾全套仍绿。已删。行为一字未变。）
    //
    // **单选态点规格二不受影响**：那条路上 skuId 从这一格换成那一格，sameRefCell
    // 第一层就判假，照常一律追平 —— #127「按错价记账」回归的闸没被碰（钉子两份：
    // tests/ui.test.js:1990 与 tests/sale-spec-view.test.js 的 (6b)）。审计穷举已证：
    // 参照格身份变了的组合，base 与 fix **0 差异**。
    //
    // **多选态（|Z| >= 2）整个跳过这道判定**，不是漏改：此时 sku 恒为 null，
    // 该追平到的数退回商品档价，而多选态框里那个值的正主是「第一枚选中格」
    // （applySizeSelection / pickColor 多选支写的）。不加这道闸，每次 onShow 回填会把
    // 整批价从 69 打回商品档价 39（已由 (7e) 钉死）。**多选态自己的档价过期问题
    // 仍在**，另算，这里不冒充解决。
    const isMulti = sizesSel.length >= 2
    const sameRefCell = this.data.productId === product.id && !!this.data.unitPrice
      && this.data.skuId === (sku ? sku.id : '')
    const keepPrice = sameRefCell && (isMulti || !!this.data.priceTouched)
    this.setData(Object.assign({
      productId: product.id,
      productName: product.name,
      hasSpecs: hasSpecs,
      blankProcess: inventory.isBlankProcess(product),
      specAxis1: inventory.specAxis1Name(product),
      specAxis2: inventory.specAxis2Name(product),
      colors: colors,
      sizes: sizes,
      selectedColor: color,
      skuId: sku ? sku.id : ''
    }, this.pricePatch(keepPrice, sku, product)))
    this.setData(this.sizeSelectionPatch(sizesSel))
    this.setData(this.stockPatch(product, sku, cart))
    this.applySettle(this.linePatch(cart))
  },

  selectProduct(id) {
    const product = store.getProduct(id)
    if (!product) return
    const same = this.data.productId === id
    if (!same) {
      // T1：换商品——多选相关的逐格草稿、全部填框全部清空（选中集合本身交给
      // applyProductState 的 selectedSizes=[] 分支去清）。
      this.setData({ cellQtys: {}, batchQty: '' })
    }
    this.applyProductState(
      product,
      same ? this.data.selectedColor : '',
      same ? this.data.selectedSizes : [],
      this.data.cart
    )
  },

  pickColor(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    const value = e.currentTarget.dataset.value
    if (this.data.selectedSizes.length >= 2) {
      // T3：多选态换规格一（22:231）——选中集合保留；逐格数量与「全部填」清空（换颜色
      // 后每格现货会变，留着旧数量会被当成已核过库存；与 T11 同形）；**单价追平到新
      // 参照格（第一枚选中格）的档价，除非店主已经手改过本次售价，那就保留他填的**。
      //
      // 判据是「有没有人动过这个框」，不是「参照格变没变」——多选态下 skuId 恒为空串
      // （见 applySizeSelection 的注释），applyProductState 那套 skuId 判据在这里分不出
      // 「店主手改过」和「系统刚追平过」，照抄过来等于恒假。
      //
      // 这一条原本写的是「单价保留」，并引用「样张 S5」。那个引用是错的：S5 在稿上是
      // 看板的「本月进货」卡，跟销售规格无关，稿上当时零条注释讲换规格一时什么保留、
      // 什么清空——那是一条没有稿依据的代码侧自定裁定，且与 applySizeSelection 声明的
      // 「多选态单价取第一枚选中格的 SKU 售价」互相打架。实测后果见 pricePatch 的注释。
      //
      // 顺序有依赖：firstSelectedSku 读的是 data.selectedColor，必须先把新颜色写进去
      // 再取参照格，否则取到的是**换之前**那一格，追平等于没追。
      this.setData({ selectedColor: value, cellQtys: {}, batchQty: '' })
      const keepPrice = !!this.data.priceTouched && !!this.data.unitPrice
      const refSku = this.firstSelectedSku(product, this.data.selectedSizes)
      this.setData(this.pricePatch(keepPrice, refSku, product))
      this.recomputeAfterSpecChange(product)
      return
    }
    // 单选形态：既有逻辑一个字不改。
    this.applyProductState(product, value, this.data.selectedSizes, this.data.cart)
  },

  // 规格二 chips 的 toggle 入口。T4/T5：|Z| 跨过 1↔2 边界时数量要搬运，
  // 停留在同一形态时只增删该格——统一交给 applySizeSelection。
  pickSize(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    const needColor = !!(product.colors && product.colors.length)
    // n5 3:767 的级联：规格一未选时规格二禁用。
    if (needColor && !this.data.selectedColor) return
    const value = e.currentTarget.dataset.value
    const prev = this.data.selectedSizes.slice()
    const wasOn = prev.indexOf(value) >= 0
    const next = wasOn
      ? prev.filter(function (v) { return v !== value })
      : prev.concat([value])
    // 单选形态（这一下点完前后都 <= 1 格）：走回既有那条路，一个字不改——跟 pickColor
    // 上面那个分支同形。**必须是 applyProductState**：只有它会把 skuId / unitPrice
    // 追平到新选中的那枚 SKU（`String(sku ? sku.salePrice : product.salePrice)`）。
    // 走 applySizeSelection 只 setData 了 stockPatch + linePatch，单价会停在上一格的
    // 值 —— 逐格售价是真功能（pages/product-edit/product-edit.wxml:207 每格一个售价
    // 输入框，product-edit.js:319 专门保留店主逐格改过的价），停住就是按错价记账；
    // 附带 skuId 停在 ''，下次 onShow 回填时 keepPrice 判假，单价还会自己跳。
    // |Z| 跨 1↔2 边界（T4/T5）与已在多选态时才交给 applySizeSelection。
    if (prev.length <= 1 && next.length <= 1) {
      this.applyProductState(product, this.data.selectedColor, next, this.data.cart)
      return
    }
    this.applySizeSelection(product, prev, next)
  },

  // T6/T7：「全选」——当前已全选时再点 = 全不选（回落单选空态，= T1 后同形）；
  // 否则选中当前未选中的格，已选中的格保留原值（复用 applySizeSelection 的 T4 迁移）。
  pickAllSizes() {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    const needColor = !!(product.colors && product.colors.length)
    if (needColor && !this.data.selectedColor) return
    const sizes = product.sizes || []
    if (sizes.length <= 1) return // |S| = 1 时「全选」chip 不出现，双保险
    const prev = this.data.selectedSizes.slice()
    const allSelected = sizes.every(function (s) {
      return prev.indexOf(s) >= 0
    })
    if (allSelected) {
      this.setData(Object.assign(this.sizeSelectionPatch([]), { cellQtys: {}, batchQty: '', qty: '' }))
      this.recomputeAfterSpecChange(product)
      return
    }
    this.applySizeSelection(product, prev, sizes.slice())
  },

  // 「第一枚选中格」按行序（product.sizes 顺序）取，不是点击顺序——逐格行与
  // currentLines 的行序都按 product.sizes 走，单价默认值跟着同一个序才不会两说。
  firstSelectedSku(product, sizes) {
    const all = (product && product.sizes) || []
    for (let i = 0; i < all.length; i++) {
      if ((sizes || []).indexOf(all[i]) >= 0) {
        return inventory.findSkuBySpec(this.data.skus, product.id, this.data.selectedColor, all[i]) || null
      }
    }
    return null
  },

  // T4：|Z| 1→2，原数量框的值搬进第一枚已选格，新格留空；|Z| 0→N（空态点「全选」）
  // 没有「原选中格」，那个值搬进行序第一格（22:231）。
  // T5：|Z| 2→1，那一格的值搬回数量框；丢弃的格数量直接弃掉（选中集合是唯一真相，
  // 不留看不见的数）。停留在同一形态时只增删该格，「全部填」不受影响（T9）。
  applySizeSelection(product, prevSizes, nextSizes) {
    let cellQtys = Object.assign({}, this.data.cellQtys)
    prevSizes.forEach(function (size) {
      if (nextSizes.indexOf(size) < 0) delete cellQtys[cellKey(size)]
    })
    const wasMulti = prevSizes.length >= 2
    const isMulti = nextSizes.length >= 2
    let qty = this.data.qty
    let batchQty = this.data.batchQty
    if (!wasMulti && isMulti) {
      // |Z| 0→N（空态点「全选」，2026-09-02 放开单选形态那枚 chip 之后才可达）：
      // prevSizes 为空，没有「原选中格」，数量框里的值按行序搬进第一格——与 T4 是同一条
      // 规则的自然延伸，别静默丢掉。nextSizes 来自 product.sizes.slice()，所以
      // nextSizes[0] 就是行序第一格，与 firstSelectedSku / cellRows 的行序同源。
      const firstSize = prevSizes[0] || nextSizes[0]
      if (firstSize) cellQtys[cellKey(firstSize)] = qty
      qty = ''
    } else if (wasMulti && !isMulti) {
      const remain = nextSizes[0]
      qty = (remain && cellQtys[cellKey(remain)] != null) ? cellQtys[cellKey(remain)] : ''
      cellQtys = {}
      batchQty = ''
    }
    // 新选中的格（不管是不是 firstSize 那一枚）要有一个空串的条目，不是压根没有
    // key——留空是指值，不是这一格的存在与否；不然 T6 全选一次多加两三格时，除了
    // firstSize 那一个，其余全是没 key 的格。
    if (isMulti) {
      nextSizes.forEach(function (size) {
        if (cellQtys[cellKey(size)] == null) cellQtys[cellKey(size)] = ''
      })
    }
    // 单价 / skuId 追平。**判据分两套，按路径分**——这是 22:231 的裁定，不是漏改：
    //
    //   · 多选态内增删格（wasMulti && isMulti）：判据是「店主动过这个框没有」
    //     （priceTouched）。多选态的价是「整批一个价」，店主填了就是他要的批价，不该
    //     被增删一格冲掉；没填过就追平到新的第一枚选中格。
    //     **这条路不能用下面那套 skuId 判据**：进/留在多选态时写进 data 的 skuId 恒为
    //     空串（见下），而 refSku.id 非空，那个等式在这条路上**结构性恒假**——
    //     2026-09-03 实测：多选态手改 88，点掉一格就无声变回 69，屏上没有任何提示。
    //
    //   · 两条过渡路径（T4 = 0/1→多选、T5 = 多选→0/1）：判据仍是「参照 SKU 变没变」，
    //     **故意不换成 priceTouched**。T4 从单选带着那一格的价进来，参照格没变就该留着
    //     （skuId 此时是真的 SKU id，等式判得出来）；T5 回落到某一格就该按那一格的档价
    //     记账——与 pickSize 单选分支走 applyProductState 的结果同形，而
    //     tests/ui.test.js:1990 逐字钉着「单选形态点规格二一律追平」（#127「按错价
    //     记账」回归的专用闸）。把 priceTouched 扩到 T5 会从这个方向把那条闸拆掉。
    //
    // 两条判据并存不矛盾：单选态每次点格子就是在挑那一个 SKU，价该跟着走；多选态的价
    // 是整批一个价，店主填了就是他要的。
    //   · 进/留在多选态：参照 SKU = 第一枚选中格（返工裁定：多选态单价的默认值取该格
    //     SKU 售价，不是商品档价，与单选形态取值逻辑一致；用户仍可改，仍是整批一个价）。
    //     写进 data 的 skuId 记空串——多选态没有「当前唯一 SKU」（currentSku 在 |Z| != 1
    //     时就返回 null），applyProductState 在 |Z| >= 2 时算出来的 sku 也是空；两边对齐
    //     了，onShow 回填时 keepPrice 才判真，不会把整批价打回商品档价。
    //   · 回落单选态（T5，|Z| 2→1）：参照 SKU = 剩下那一格，skuId 记它的 id ——跟
    //     pickSize 单选分支走 applyProductState 的结果同形，onShow 也不会再自己跳价。
    const refSku = isMulti
      ? this.firstSelectedSku(product, nextSizes)
      : this.firstSelectedSku(product, nextSizes.slice(0, 1))
    const keepPrice = (wasMulti && isMulti)
      ? (!!this.data.priceTouched && !!this.data.unitPrice)
      : (!!this.data.unitPrice && this.data.skuId === (refSku ? refSku.id : ''))
    this.setData(Object.assign(this.sizeSelectionPatch(nextSizes), {
      cellQtys: cellQtys,
      qty: qty,
      batchQty: batchQty,
      skuId: (isMulti || !refSku) ? '' : refSku.id
    }, this.pricePatch(keepPrice, refSku, product)))
    this.recomputeAfterSpecChange(product)
  },

  // T8：「全部填 N」覆盖当前所有已选中格（含已经逐格改过的）；之后新选中的格不自动
  // 带这个值，留空（一次性动作，不是绑定）。
  onBatchQty(e) {
    const value = e.detail.value
    const cellQtys = Object.assign({}, this.data.cellQtys)
    this.data.selectedSizes.forEach(function (size) {
      cellQtys[cellKey(size)] = value
    })
    this.setData({ batchQty: value, cellQtys: cellQtys })
    this.applySettle(this.linePatch(this.data.cart))
  },

  // T9：只改这一格，「全部填」框里的值留着当提示，不联动、不清空。
  onCellQty(e) {
    const size = e.currentTarget.dataset.value
    const value = e.detail.value
    const cellQtys = Object.assign({}, this.data.cellQtys)
    cellQtys[cellKey(size)] = value
    this.setData({ cellQtys: cellQtys })
    this.applySettle(this.linePatch(this.data.cart))
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const patch = {}
    patch[field] = value
    // 「本次售价」是这个通用入口里唯一带**归属**的字段：店主一动这个框，换规格一就不许
    // 再无声把他填的价冲掉（22:231）。这里是唯一的置位点——wxml 的 .js-batch-price 和
    // .js-single-price 两个输入框都绑 onField、都带 data-field="unitPrice"，手打的价
    // 进不来别的路。复位统一在 pricePatch，不在这里。
    if (field === 'unitPrice') patch.priceTouched = true
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

  // H1：这是 mergeLines 的第三个调用点在 submit() 里，改名/改签名时那边要同步改，
  // 否则「填了一行没点加入清单、直接点确认销售」这条路径会把老方法调用悬空。
  // 单选形态分支一个字不改（qty <= 0 早退在先，spec 未选的 error 只在 qty > 0 时才判）；
  // 多选形态遍历 selectedSizes（按 product.sizes 顺序，即"行序"），
  // 数量取 cellQtys，数量 <= 0 的格不产生行。
  currentLines() {
    const product = store.getProduct(this.data.productId)
    if (!product) return { lines: [], error: '' }
    const unitPrice = inventory.round2(this.data.unitPrice)
    if (unitPrice < 0) return { lines: [], error: '' }

    if (!inventory.productHasSpecs(product)) {
      const qty = inventory.round2(this.data.qty)
      if (qty <= 0) return { lines: [], error: '' }
      return { lines: [this.toCartItem(product, null, qty, unitPrice)], error: '' }
    }

    const colors = product.colors || []
    const sizes = product.sizes || []

    if (this.data.multiMode) {
      if (colors.length && !this.data.selectedColor) {
        return { lines: [], error: inventory.specSelectHint(product) }
      }
      const lines = []
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i]
        if (this.data.selectedSizes.indexOf(size) < 0) continue
        const qty = inventory.round2(this.data.cellQtys[cellKey(size)])
        if (qty <= 0) continue
        const sku = inventory.findSkuBySpec(this.data.skus, product.id, this.data.selectedColor, size)
        if (sku) lines.push(this.toCartItem(product, sku, qty, unitPrice))
      }
      return { lines: lines, error: '' }
    }

    // 单选形态：既有逻辑一个字不改。
    const qty = inventory.round2(this.data.qty)
    if (qty <= 0) return { lines: [], error: '' }
    if ((colors.length && !this.data.selectedColor) || (sizes.length && !this.singleSelectedSize())) {
      return { lines: [], error: inventory.specSelectHint(product) }
    }
    const sku = this.currentSku(product)
    if (!sku) return { lines: [], error: '规格不存在' }
    return { lines: [this.toCartItem(product, sku, qty, unitPrice)], error: '' }
  },

  addCart() {
    try {
      const result = this.currentLines()
      if (result.error) {
        wx.showToast({ title: result.error, icon: 'none' })
        return
      }
      if (!result.lines.length) {
        wx.showToast({ title: '请选择商品并填写数量', icon: 'none' })
        return
      }
      const wasMulti = this.data.multiMode
      const lineCount = result.lines.length
      const cart = this.mergeLines(result.lines, this.data.cart)
      const product = store.getProduct(this.data.productId)
      const sku = this.currentSku(product)
      // 稿 n-加入 13:560 / T11：加入后按钮禁用，商品与规格选中集合保留；
      // 单选态清 qty，多选态清逐格草稿与「全部填」（单价两边都保留）。
      const clearPatch = wasMulti ? { cellQtys: {}, batchQty: '' } : { qty: '' }
      this.setData(Object.assign({ cart: cart }, clearPatch, this.stockPatch(product, sku, cart)))
      this.applySettle(this.linePatch(cart))
      wx.showToast({
        title: wasMulti ? ('已加入 ' + lineCount + ' 行') : '已加入清单',
        icon: 'success'
      })
    } catch (error) {
      util.showError(error)
    }
  },

  // H7：同批两行落同一格，由这个循环天然累加（findIndex 命中已有行就加总，否则新建），
  // 不必专门写夹具测试。H6：批后只在最后跑一次 assertSaleItems——省去逐行重复的全量
  // 克隆，不是为了防中间态误判（顺序贪心下整批通过蕴含每个前缀通过）。
  // 抛错时函数体内只改 list（局部变量），不写回 this.data.cart，调用方也不会把半成品
  // 结果赋回 cart，天然满足"抛错不许污染 cart"。
  mergeLines(lines, cart) {
    const list = (cart || []).slice()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const product = store.getProduct(line.productId)
      const sku = line.skuId ? store.getSku(line.skuId) : null
      const index = list.findIndex(function (item) {
        return item.key === line.key
      })
      const nextQty = inventory.round2((index >= 0 ? list[index].qty : 0) + line.qty)
      if (index >= 0) {
        list[index] = this.toCartItem(product, sku, nextQty, line.unitPrice)
      } else {
        list.push(line)
      }
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
      // H1：submit() 是 mergeLines / currentLines 的第三个调用点——沿用 addCart 那份
      // 「先取 currentLines()，有内容就 mergeLines 并回」的逻辑，否则「填了一行没点
      // 加入清单、直接点确认销售」这条路径会漏掉这一行（npm test 抓不到这个悬空调用，
      // 只有 UI 测试能抓）。
      let cart = this.data.cart.slice()
      const result = this.currentLines()
      if (result.error) {
        wx.showToast({ title: result.error, icon: 'none' })
        return
      }
      if (result.lines.length) {
        cart = this.mergeLines(result.lines, this.data.cart)
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
          // T11 同形：selectedSizes/单价保留，逐格草稿与「全部填」清空（qty 只在
          // 单选态有意义，两边都清不影响对方）。
          //
          // **priceTouched 不在这里复位**，跟着单价一起留（下面那个成功分支同理）。
          // 别照抄旁边的 paidTouched：两个标志的读法不一样。paidAmount 只在 paidTouched
          // 为真时才被读（settlePatch 里那个三元），所以复位它等于把框还给系统；而
          // unitPrice 是无条件读的，这里又明明把店主填的价原样留在了框里 —— 复位掉
          // 就等于「屏上还是他的 88，归属却记成系统的」，下一张单他换个颜色，那 88 会
          // 自己变成档价，正是本次要修的形态。标志的口径是「框里这个值是不是人填的」。
          qty: '',
          cellQtys: {},
          batchQty: '',
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
        // T11 同形：selectedSizes/单价保留，逐格草稿与「全部填」清空。
        qty: '',
        cellQtys: {},
        batchQty: '',
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
