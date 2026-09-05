const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 「最近进货」chips（稿 chips/最近进货 4:694 + 注 4:713）。
// 拉一页 in 流水、按「商品 + 规格」去重后取前 3 枚。
//
// **只读 lines[0] 上已经算好的字段**：进货是单行单（utils/ledger-apply.js:31 的
// SINGLE_LINE_TYPES 含 'in'），productId / skuId / unitPrice 都在那一行上，
// 页面一分钱都不折（tests/no-client-cloud-db.test.js 的 T-S3）。
const RECENT_SCAN = 30
const RECENT_KEEP = 3

Page({
  data: {
    products: [],
    skus: [],
    recent: [],
    productId: '',
    productName: '请选择商品',
    stockText: '-',
    hasSpecs: false,
    blankProcess: false,
    skuId: '',
    skuOptions: [],
    baseCostText: '',
    specLabel: '',
    qty: '',
    unitPrice: '',
    // 「本次进价」这个框里现在的值是不是**店主自己给的**。false = 系统写的（追平到
    // 档案进价），true = 他自己决定的（往框里打字，或者点「最近进货」chip 要来的
    // 上次进价）。这不是「和档案进价不相等」的派生量：他完全可以手打一个恰好等于
    // 档案进价的数，也可以手打完再改回来。
    // 置位点两个：onField（wxml 的 .js-purchase-price 是唯一的输入口）和 pickRecent
    // （点 chip 是他主动要那个数）。复位点唯一，就是 pricePatch。
    priceTouched: false,
    remark: '',
    amountText: '0.00',
    totalText: '共 0 件 · ¥0.00',
    costHint: '',
    submitting: false,
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
    // **故意不 await**：最近进货只是快捷入口，挂进 onShow 的等待链就等于给
    // tests/ui.test.js 的 waitPageReady 多加一个随机失败点。
    this.loadRecent()
  },

  // 稿 4:713：点选带出商品 + 规格 + 上次进价，只留数量给店员。
  // 拿不到就留空数组、**不弹任何 toast**：主路径（选商品）一点都不依赖它。
  async loadRecent() {
    let records = []
    try {
      const res = await store.listRecords({ type: 'in', limit: RECENT_SCAN })
      records = (res && res.records) || []
    } catch (error) {
      records = []
    }
    const seen = {}
    const out = []
    records.forEach(function (record) {
      if (out.length >= RECENT_KEEP) return
      const line = inventory.firstLine(record)
      const productId = String(line.productId || '')
      if (!productId) return
      const skuId = String(line.skuId || '')
      const key = productId + '|' + skuId
      if (seen[key]) return
      const product = store.getProduct(productId)
      if (!product) return
      const sku = skuId ? store.getSku(skuId) : null
      if (skuId && !sku) return
      const spec = sku && !sku.isBlank ? inventory.specText(sku.color, sku.size) : ''
      seen[key] = true
      out.push({
        key: key,
        productId: productId,
        skuId: skuId,
        unitPrice: String(inventory.toNumber(line.unitPrice)),
        label: spec ? (product.name + ' · ' + spec) : product.name
      })
    })
    this.setData({ recent: out })
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

  // 稿 picker/格选择器/简版 4:493：一枚 chip = 一个成品规格格，label 带余量。
  // 待加工池那一格**不出**：applyPurchase 的 blank 分支无条件走 findBlankSku、
  // 完全忽略 payload.skuId（utils/inventory.js:739-757），选了也没用（规格 §6-3）。
  skuOptionsOf(product, skuId) {
    return inventory.skusOfProduct(this.data.skus, product.id).filter(function (item) {
      return !item.isBlank
    }).map(function (item) {
      return {
        id: item.id,
        label: inventory.specText(item.color, item.size),
        stock: item.stock,
        on: item.id === skuId
      }
    })
  },

  // 「档案进价」的基准分三档取，与 applyPurchase 三条分支一一对应：
  //   待加工   -> 待加工那条 sku 的 costPrice（:746 与 :753 都被这次进价覆盖）
  //   分规格   -> 选中 sku 的 costPrice（:770 覆盖；product.costPrice 不动）
  //   普通商品 -> product.costPrice（:782 覆盖）
  baseCostOf(product, sku, blank) {
    if (blank) return inventory.toNumber(blank.costPrice)
    if (sku) return inventory.toNumber(sku.costPrice)
    return inventory.toNumber(product.costPrice)
  },

  // 「本次进价」的唯一系统写出口。keep 为真＝框里现在这个值是店主自己给的、系统不许
  // 冲掉；为假＝追平到档案进价 baseCost，同时把归属收回给系统。
  // **两个字段必须一起写**，这是这个函数存在的全部理由：
  //
  //   · 只写 unitPrice 不写 priceTouched：追平一次之后标志还挂着 true，后面每一次
  //     回填都会「保留」一个其实是系统自己写进去的价 —— 一次手改永久生效。
  //   · 只写 priceTouched 不写 unitPrice：就是下面 applyProductState 里那个要修的
  //     bug 的形状（销售侧同型缺陷见 PR #138）。
  pricePatch(keep, baseCost) {
    return {
      unitPrice: keep ? this.data.unitPrice : String(baseCost),
      priceTouched: keep ? this.data.priceTouched : false
    }
  },

  applyProductState(product, skuId) {
    const hasSpecs = inventory.productHasSpecs(product)
    const blankProcess = inventory.isBlankProcess(product)
    const options = hasSpecs && !blankProcess ? this.skuOptionsOf(product, skuId) : []
    let nextSkuId = ''
    if (hasSpecs && !blankProcess) {
      const hit = options.find(function (item) {
        return item.id === skuId
      })
      nextSkuId = hit ? hit.id : (options.length === 1 ? options[0].id : '')
    }
    const sku = nextSkuId ? store.getSku(nextSkuId) : null
    const blank = blankProcess ? inventory.findBlankSku(this.data.skus, product.id) : null
    const baseCost = this.baseCostOf(product, sku, blank)
    // 店主自己给的进价要保住：同一个商品、同一格、框里有值，**而且这个值的归属在他
    // 手里**，才不拿档案进价盖掉。最后那一条是本次补的判据（销售侧同型缺陷见 PR #138）。
    //
    // 病灶（销售侧实测复现，进货侧同形）：旧判据只判**身份**（skuId === nextSkuId）。
    // 店主选中某一格（系统把本次进价追平到该格档案进价），中途去商品编辑改了**这一格**
    // 的进价，回进货页 onShow → selectProduct(同一 id) → 这里 —— 同一枚 SKU 判真，
    // 框里留着**过期的旧进价**。那个数看上去完全正常、只是过期了，按它入库，
    // 进货金额 / 成本 / 毛利 / 应付一起错 —— 静默错账。
    //
    // 加上 priceTouched 之后：没人动过就重新取档案进价，动过就保留他给的。
    // **换格那条路不受影响**：pickSku 换到另一格时 skuId 与 nextSkuId 对不上，
    // 第三个条件先判假，照旧一律追平（「按错价记账」那条闸没被碰）。
    const keepPrice = this.data.productId === product.id
      && !!this.data.unitPrice
      && this.data.skuId === nextSkuId
      && !!this.data.priceTouched
    let stockText = '当前库存 ' + product.stock + ' 件'
    if (hasSpecs) {
      // 稿 库存meta 4:441（$13:637）：「进货前：白色/1.8m 5 · … · 半成品 40（共 63）」。
      // skuSummaryText 是仓库里唯一的规格余量拼接函数（utils/inventory.js:414-432）。
      stockText = '进货前：' + inventory.skuSummaryText(product, this.data.skus)
        + '（共 ' + product.stock + ' 件）'
    }
    this.setData(Object.assign({
      productId: product.id,
      productName: product.name,
      hasSpecs: hasSpecs,
      blankProcess: blankProcess,
      skuId: nextSkuId,
      skuOptions: options.map(function (item) {
        return Object.assign({}, item, { on: item.id === nextSkuId })
      }),
      specLabel: blank ? '待加工' : (sku ? inventory.specText(sku.color, sku.size) : product.name),
      baseCostText: util.money(baseCost),
      stockText: stockText
    }, this.pricePatch(keepPrice, baseCost)))
    this.refreshAmount()
  },

  selectProduct(id, skuId) {
    const product = store.getProduct(id)
    if (!product) return
    const same = this.data.productId === id
    this.applyProductState(product, skuId || (same ? this.data.skuId : ''))
  },

  pickSku(e) {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    this.applyProductState(product, e.currentTarget.dataset.id)
  },

  // 稿 4:713：带出商品 + 规格 + 上次进价，**数量留空**。
  pickRecent(e) {
    const key = e.currentTarget.dataset.key
    const hit = this.data.recent.find(function (item) {
      return item.key === key
    })
    if (!hit) return
    // 两处都把 unitPrice 和 priceTouched **一起**写，理由同 pricePatch 的注释。
    // 先清空是既有写法：清掉之后 applyProductState 的 keepPrice 判假，整套状态照
    // 新商品/新格重建，不留上一次的残值。
    this.setData({ qty: '', unitPrice: '', priceTouched: false })
    this.selectProduct(hit.productId, hit.skuId)
    // 「上次进价」的归属算**店主**的：这个数是他点这枚 chip 主动要来的，不是系统
    // 追平出来的。标 false 的话，他去别的页面转一圈回来，onShow 回填就会把这个数
    // 无声换成档案进价 —— 那正是本次要修的那种静默改数，只是换了个方向。
    // （旧实现里这个值靠身份判据也能活过回填，标 true 是把那份行为原样接住。）
    this.setData({ unitPrice: hit.unitPrice, priceTouched: true })
    this.refreshAmount()
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    // 「本次进价」是这个通用入口里唯一带**归属**的字段：店主一动这个框，回填就不许
    // 再无声把他填的价换成档案进价。wxml 里 .js-purchase-price 是唯一带
    // data-field="unitPrice" 的输入框，手打的价进不来别的路。
    // 复位统一在 pricePatch，不在这里。
    if (field === 'unitPrice') patch.priceTouched = true
    this.setData(patch)
    this.refreshAmount()
  },

  // 「数量 × 进价」这一次乘法是**预览**，与服务端 applyPurchase:726 的
  // `amount: round2(qty * unitPrice)` 逐字同构。落账的金额一律由服务端算，
  // 提交后的 toast 只读回包（见 submit），不许用这里的数重拼。
  refreshAmount() {
    const qty = inventory.toNumber(this.data.qty)
    const amount = inventory.round2(qty * inventory.toNumber(this.data.unitPrice))
    // 稿 hint/进价回写 7:350（默认 visible:false）与变体 13:415（$13:383）：
    // 只在这次填的价与档案价不同的时候才出，句式「{规格} 档案进价 ¥旧 → ¥新，后续毛利按新进价」。
    const typed = String(this.data.unitPrice || '').trim()
    const changed = this.data.productId
      && typed !== ''
      && util.money(inventory.round2(inventory.toNumber(typed))) !== this.data.baseCostText
    this.setData({
      amountText: util.money(amount),
      totalText: '共 ' + qty + ' 件 · ¥' + util.money(amount),
      costHint: changed
        ? (this.data.specLabel + ' 档案进价 ¥' + this.data.baseCostText
          + ' → ¥' + util.money(inventory.round2(inventory.toNumber(typed)))
          + '，后续毛利按新进价')
        : ''
    })
  },

  async submit() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    try {
      const product = store.getProduct(this.data.productId)
      if (product && inventory.productHasSpecs(product) && !inventory.isBlankProcess(product)) {
        if (!this.data.skuId) {
          throw new Error(inventory.specSelectHint(product) || '请选择规格')
        }
      }
      // payload 只有这五个键。applyPurchase（utils/inventory.js:696-795）也只读这五个，
      // 单头的 amount / profit 由它自己算与写死，**客户端一个金额字段都不许加**。
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
      this.setData({ skus: this.data.skus, qty: '', remark: '' })
      if (latest) this.applyProductState(latest, this.data.skuId)
      this.loadRecent()
      // 稿 toast/进货完成 7:313「已记进货 · 25 件 · ¥2,375.00」。
      // 两个数**都读回包**（服务端真值），不是屏上那份预览。
      wx.showToast({
        title: '已记进货 · ' + inventory.toNumber(recordLine.qty) + ' 件 · ¥'
          + util.money(record && record.amount),
        icon: 'none'
      })
    } catch (error) {
      util.showError(error)
    }
    this.setData({ submitting: false })
  }
})
