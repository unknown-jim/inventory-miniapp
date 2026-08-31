const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const productImage = require('../../utils/product-image')

function axisLabel(value, fallback) {
  const name = String(value || '').trim()
  return name || fallback
}

// 折叠索引第一行的副文案（稿 15:21「规格 · 颜色 2 / 尺寸 2」）。
// 两根轴都没有取值时说「未设置」；只有一根时只列那一根。
function specSummaryOf(specAxis1, specAxis2, colors, sizes) {
  const parts = []
  if ((colors || []).length) parts.push(axisLabel(specAxis1, '规格一') + ' ' + colors.length)
  if ((sizes || []).length) parts.push(axisLabel(specAxis2, '规格二') + ' ' + sizes.length)
  return parts.length ? parts.join(' / ') : '未设置'
}

// 5a 批（稿 Screen/04）起，这一页**没有「商品类型」这个选择**（UX注释 n1）。
// 类型在后端本来就是派生的：utils/inventory.js 的
//   productHasSpecs(product) = colors/sizes 里有没有取值
//   isBlankProcess(product)  = product.blankProcess && productHasSpecs(product)
// 所以页面只维护两件事：规格取值（colors / sizes）和半成品池开关（blankPool）。
//
// 同批起件数在这一页是**只读**的（UX注释 n9「建档初始 0。改数只走库存修正门」）。
// 编辑态本来就改不动件数（updateProduct 最后一行 next.stock = existing.stock，
// applyProductSkus 里已有的格取 prev.stock）；建档改成 0 之后，
// 老代码里那一整套「切类型时把件数从这一桶搬到那一桶」的迁移逻辑全部是 no-op，随之删除。
Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    sku: '',
    barcode: '',
    image: '',
    showImage: false,
    costPrice: '',
    salePrice: '',
    alertQty: '5',
    stockText: '0',
    marginText: '0.00',
    rateText: '0%',
    focusPrice: false,
    hasSpecs: false,
    specAxis1: '',
    specAxis2: '',
    colors: [],
    sizes: [],
    adding: '',
    specInput: '',
    skuRows: [],
    blankPool: false,
    blankStockText: '0',
    sharedPrice: true,
    categories: [],
    categoryId: '',
    nameSuggest: [],
    specOpen: false,
    blankOpen: false,
    skuOpen: false,
    specSummary: '未设置',
    blankSummary: '未开',
    skuSummary: '0 条',
    saving: false
  },

  async onLoad(query) {
    const focus = query && query.focus ? String(query.focus) : ''
    this.setData({ showImage: productImage.canUseImage() })
    if (!(await store.ready())) return
    if (query && query.id) {
      const product = store.getProduct(query.id)
      if (!product) {
        wx.showToast({ title: '商品不存在', icon: 'none' })
        return
      }
      const skus = store.getSkusByProduct(product.id)
      const blank = inventory.findBlankSku(skus, product.id)
      const margin = inventory.calcMargin(product.costPrice, product.salePrice)
      this.setData(this.withFoldSummary({
        id: product.id,
        isEdit: true,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        image: product.image || '',
        costPrice: String(product.costPrice),
        salePrice: String(product.salePrice),
        alertQty: String(product.alertQty),
        stockText: String(product.stock),
        marginText: util.money(margin.profit),
        rateText: margin.rate + '%',
        specAxis1: product.specAxis1 || '',
        specAxis2: product.specAxis2 || '',
        colors: (product.colors || []).slice(),
        sizes: (product.sizes || []).slice(),
        blankPool: inventory.isBlankProcess(product),
        blankStockText: blank ? String(blank.stock) : '0',
        sharedPrice: product.sharedPrice !== false,
        skuRows: this.rowsFromSkus(skus)
      }))
      wx.setNavigationBarTitle({ title: '编辑商品' })
    } else {
      wx.setNavigationBarTitle({ title: '新增商品' })
    }
    this.applyFocus(focus)
  },

  async onShow() {
    if (!(await store.ready())) return
    this.refreshCategories()
    if (this.data.isEdit && this.data.id) {
      this.refreshStockDisplay()
    }
  },

  // 锚点入参。category = 商品列表空态「从模板建档」的落点（3a 规格 OQ-5 交接过来的）；
  // price = 商品详情「调价」的落点（稿 focus-caption 7:429：售价框聚焦、border/focus 描边）。
  // 别的值一律忽略，不报错 —— 入参是给别的页面用的桥，桥拼错了不该让本页打不开。
  applyFocus(focus) {
    if (focus === 'category') {
      this.setData({ specOpen: true })
      setTimeout(function () {
        wx.pageScrollTo({ selector: '#pe-spec-card', duration: 200 })
      }, 120)
      return
    }
    if (focus === 'price') {
      this.setData({ focusPrice: true })
    }
  },

  onPriceBlur() {
    if (this.data.focusPrice) this.setData({ focusPrice: false })
  },

  // 折叠索引三行的开合（稿 15:34「点行即展开对应卡片」）。三张卡各自独立，可以同时开。
  toggleFold(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    if (key === 'spec') {
      patch.specOpen = !this.data.specOpen
    } else if (key === 'blank') {
      patch.blankOpen = !this.data.blankOpen
    } else if (key === 'sku') {
      patch.skuOpen = !this.data.skuOpen
    } else {
      return
    }
    this.setData(patch)
  },

  // 折叠索引三行的副文案是派生值，任何改到规格 / 半成品池 / 矩阵的 setData
  // 都要过这一层，否则行上的数字会和卡里的内容对不上。
  withFoldSummary(patch) {
    const colors = patch.colors != null ? patch.colors : this.data.colors
    const sizes = patch.sizes != null ? patch.sizes : this.data.sizes
    const axis1 = patch.specAxis1 != null ? patch.specAxis1 : this.data.specAxis1
    const axis2 = patch.specAxis2 != null ? patch.specAxis2 : this.data.specAxis2
    const rows = patch.skuRows != null ? patch.skuRows : this.data.skuRows
    const blankPool = patch.blankPool != null ? patch.blankPool : this.data.blankPool
    const hasSpecs = !!(colors.length || sizes.length)
    patch.hasSpecs = hasSpecs
    patch.specSummary = specSummaryOf(axis1, axis2, colors, sizes)
    patch.blankSummary = (hasSpecs && blankPool) ? '已开' : '未开'
    patch.skuSummary = rows.length + ' 条'
    return patch
  },

  // 矩阵不带进价列（稿 3:684 只有 规格 / 库存 / 预警 / 价格 四列），所以行上也不留
  // costPrice —— 保存时不带这个 key，服务端才会回落到这一格原来的进价。
  rowsFromSkus(skus) {
    return (skus || []).filter(function (item) {
      return !item.isBlank
    }).map(function (item) {
      return {
        key: inventory.specKey(item.color, item.size),
        id: item.id,
        color: item.color,
        size: item.size,
        specText: inventory.specText(item.color, item.size),
        sku: item.sku,
        salePrice: String(item.salePrice),
        stock: String(item.stock),
        alertQty: String(item.alertQty)
      }
    })
  },

  rebuildSkuRows(colors, sizes, extra) {
    const combos = inventory.skuCombos(colors, sizes)
    const prevMap = {}
    ;(this.data.skuRows || []).forEach(function (row) {
      prevMap[row.key] = row
    })
    const salePrice = this.data.salePrice
    const alertQty = this.data.alertQty
    const rows = combos.map(function (combo) {
      const key = inventory.specKey(combo.color, combo.size)
      if (prevMap[key]) return prevMap[key]
      return {
        key: key,
        id: '',
        color: combo.color,
        size: combo.size,
        specText: inventory.specText(combo.color, combo.size),
        sku: '',
        salePrice: salePrice,
        stock: '0',
        alertQty: alertQty
      }
    })
    this.setData(this.withFoldSummary(Object.assign({
      colors: colors,
      sizes: sizes,
      skuRows: rows
    }, extra || {})))
  },

  refreshStockDisplay() {
    const product = store.getProduct(this.data.id)
    if (!product) return
    const skus = store.getSkusByProduct(product.id)
    const blank = inventory.findBlankSku(skus, product.id)
    const liveRows = this.rowsFromSkus(skus)
    const skuRows = (this.data.skuRows || []).map(function (row) {
      const live = liveRows.find(function (item) {
        return item.id === row.id || item.key === row.key
      })
      if (!live) return row
      return Object.assign({}, row, { stock: live.stock, id: live.id || row.id })
    })
    this.setData(this.withFoldSummary({
      stockText: String(product.stock),
      blankStockText: blank ? String(blank.stock) : '0',
      skuRows: skuRows
    }))
  },

  categoryChips(categoryId) {
    const selected = categoryId || this.data.categoryId
    return store.getCategories().map(function (item) {
      return Object.assign({}, item, { on: item.id === selected })
    })
  },

  refreshCategories() {
    const categories = this.categoryChips()
    const current = this.data.categoryId ? store.getCategory(this.data.categoryId) : null
    this.setData({
      categories: categories,
      nameSuggest: current ? current.names || [] : this.data.nameSuggest
    })
  },

  // 种类模板：带出名称待选项、规格轴与取值、以及「默认带半成品池」。
  // 待选项是起点不是名单（docs/accounting-vs-policy.md），所以带出来之后照样能改、能删、能加。
  applyCategory(e) {
    const id = e.currentTarget.dataset.id
    const category = store.getCategory(id)
    if (!category) return
    const base = {
      categoryId: id,
      nameSuggest: category.names || [],
      categories: this.categoryChips(id)
    }
    const kind = category.productKind || 'plain'
    if (kind === 'plain') {
      // 普通模板只带名称待选项。**不替用户把已经加好的规格删掉** ——
      // 删规格是破坏性动作（会把各格件数合并回商品），要去掉请自己删取值，那条路会问一句。
      this.setData(this.withFoldSummary(base))
      return
    }
    // 建档时模板是起点，直接替换；编辑时是补充，合并进已有取值（沿用改版前的取舍）。
    const colors = this.data.isEdit
      ? inventory.uniqueSpecs((this.data.colors || []).concat(category.colors || []))
      : (category.colors || []).slice()
    const sizes = this.data.isEdit
      ? inventory.uniqueSpecs((this.data.sizes || []).concat(category.sizes || []))
      : (category.sizes || []).slice()
    const extra = Object.assign({}, base, {
      specAxis1: category.specAxis1 || this.data.specAxis1,
      specAxis2: category.specAxis2 || this.data.specAxis2,
      sharedPrice: category.sharedPrice !== false
    })
    // 模板的「默认带半成品池」只负责**带出来**，不负责替用户关掉他自己开着的池子。
    if (kind === 'blank' && !this.data.blankPool) extra.blankPool = true
    this.rebuildSkuRows(colors, sizes, extra)
  },

  pickName(e) {
    const name = e.currentTarget.dataset.value
    this.setData({ name: name })
  },

  goCategories() {
    wx.navigateTo({ url: '/pages/categories/categories' })
  },

  async writeBack(field, value) {
    if (!this.data.categoryId) return
    try {
      await store.appendCategoryValue(this.data.categoryId, field, value)
      this.refreshCategories()
    } catch (error) {
      util.showError(error)
    }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const patch = {}
    patch[field] = value
    // 改默认售价时，把**还没被逐格改过**的行一起带上（当前值 = 改动前的默认价）。
    // 无条件追平会把店主逐格改过的价冲掉；一行都不带的话，「先加规格、后填价」
    // 这个顺序下每一格都是空的。
    if (field === 'salePrice') {
      const prev = this.data.salePrice
      patch.skuRows = (this.data.skuRows || []).map(function (row) {
        if (String(row.salePrice) !== String(prev)) return row
        return Object.assign({}, row, { salePrice: value })
      })
    }
    this.setData(this.withFoldSummary(patch))
    if (field === 'costPrice' || field === 'salePrice') this.refreshMargin()
  },

  refreshMargin() {
    const margin = inventory.calcMargin(this.data.costPrice, this.data.salePrice)
    this.setData({
      marginText: util.money(margin.profit),
      rateText: margin.rate + '%'
    })
  },

  onSkuField(e) {
    const index = e.currentTarget.dataset.index
    const field = e.currentTarget.dataset.field
    const skuRows = this.data.skuRows.slice()
    skuRows[index] = Object.assign({}, skuRows[index])
    skuRows[index][field] = e.detail.value
    this.setData(this.withFoldSummary({ skuRows: skuRows }))
  },

  // 点「＋ 添加规格值」，原位变成聚焦的小输入框（稿 UX注释 n6）。
  startAdd(e) {
    this.setData({ adding: e.currentTarget.dataset.axis, specInput: '' })
  },

  // 回车 / 失焦生成取值 chip（稿 UX注释 n6）。confirm 之后系统会紧接着再触发一次 blur，
  // 两个事件绑的是同一个方法；setData 对 this.data 是**同步**生效的，所以第一次进来
  // 把 adding 清空之后，第二次进来在下面这行直接 return，不会重复添加、
  // 也不会弹一句「已有这个取值」。
  commitSpec() {
    const axis = this.data.adding
    if (!axis) return
    const value = String(this.data.specInput || '').trim()
    this.setData({ adding: '', specInput: '' })
    if (!value) return
    if (axis === 'color') {
      if (this.data.colors.indexOf(value) >= 0) {
        wx.showToast({ title: '已有这个' + axisLabel(this.data.specAxis1, '规格一'), icon: 'none' })
        return
      }
      this.rebuildSkuRows(this.data.colors.concat([value]), this.data.sizes)
      this.writeBack('colors', value)
      return
    }
    if (this.data.sizes.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个' + axisLabel(this.data.specAxis2, '规格二'), icon: 'none' })
      return
    }
    this.rebuildSkuRows(this.data.colors, this.data.sizes.concat([value]))
    this.writeBack('sizes', value)
  },

  removeColor(e) {
    const value = e.currentTarget.dataset.value
    const blocked = this.data.skuRows.some(function (row) {
      return row.color === value && inventory.toNumber(row.stock) > 0
    })
    if (blocked) {
      wx.showToast({ title: '该' + axisLabel(this.data.specAxis1, '规格一') + '还有库存，不能删除', icon: 'none' })
      return
    }
    this.applySpecRemoval(this.data.colors.filter(function (item) {
      return item !== value
    }), this.data.sizes)
  },

  removeSize(e) {
    const value = e.currentTarget.dataset.value
    const blocked = this.data.skuRows.some(function (row) {
      return row.size === value && inventory.toNumber(row.stock) > 0
    })
    if (blocked) {
      wx.showToast({ title: '该' + axisLabel(this.data.specAxis2, '规格二') + '还有库存，不能删除', icon: 'none' })
      return
    }
    this.applySpecRemoval(this.data.colors, this.data.sizes.filter(function (item) {
      return item !== value
    }))
  },

  // 两根轴都空了 = 这件商品变回普通商品。服务端 applyProductSkus 的 !productHasSpecs
  // 分支会把各规格格和半成品池的件数合并回商品自己身上（productStockFromSkus 把
  // 半成品那条 sku 也算进去），并且把 blankProcess 关掉。这是不可逆的合并，先问一句。
  applySpecRemoval(colors, sizes) {
    if (colors.length || sizes.length) {
      this.rebuildSkuRows(colors, sizes)
      return
    }
    wx.showModal({
      title: '改为普通商品',
      content: '规格会去掉，半成品池和各规格库存合并到这件商品上。',
      success: (res) => {
        if (!res.confirm) return
        this.rebuildSkuRows([], [], {
          blankPool: false,
          blankOpen: false,
          specAxis1: '',
          specAxis2: ''
        })
      }
    })
  },

  // 半成品池开关（稿 3:461）。两道门都是后端既有约束的前置提示，不是新规矩：
  //   · 关不掉：applyProductSkus 会抛「还有待加工库存，不能改成分规格现货」
  //   · 开不了：createProduct 会抛「待加工请添加规格」
  toggleBlankPool() {
    if (this.data.blankPool) {
      if (inventory.toNumber(this.data.blankStockText) > 0) {
        wx.showToast({ title: '还有待加工库存，不能改成分规格现货', icon: 'none' })
        return
      }
      this.setData(this.withFoldSummary({ blankPool: false }))
      return
    }
    if (!this.data.hasSpecs) {
      wx.showToast({ title: '先添加规格取值，再开半成品池', icon: 'none' })
      return
    }
    this.setData(this.withFoldSummary({ blankPool: true }))
  },

  getImageCanvas() {
    return new Promise(function (resolve, reject) {
      wx.createSelectorQuery()
        .select('#imageCanvas')
        .fields({ node: true, size: true })
        .exec(function (res) {
          const canvas = res && res[0] && res[0].node
          if (!canvas) {
            reject(new Error('图片处理失败，请重试'))
            return
          }
          resolve(canvas)
        })
    })
  },

  async pickImage() {
    try {
      const media = await new Promise(function (resolve, reject) {
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sizeType: ['compressed'],
          success: resolve,
          fail: reject
        })
      })
      const filePath = media.tempFiles && media.tempFiles[0] && media.tempFiles[0].tempFilePath
      if (!filePath) return
      wx.showLoading({ title: '处理图片中', mask: true })
      const canvas = await this.getImageCanvas()
      const compressed = await productImage.compressImage(canvas, filePath)
      wx.showLoading({ title: '上传图片中', mask: true })
      const fileID = await productImage.uploadProductImage(compressed, store.getShopId())
      this.setData({ image: fileID })
      wx.hideLoading()
    } catch (error) {
      wx.hideLoading()
      // 用户取消选图不是错误，不弹提示（同 utils/slip-image.js 对 cancel 的处理）
      const msg = String((error && (error.errMsg || error.message)) || '')
      if (msg.indexOf('cancel') < 0) util.showError(error)
    }
  },

  removeImage() {
    wx.showModal({
      title: '删除图片',
      content: '保存后将从商品上移除这张图。',
      success: (res) => {
        if (res.confirm) this.setData({ image: '' })
      }
    })
  },

  onImageError() {
    wx.showToast({ title: '图片加载失败，保存后重试或换一张', icon: 'none' })
  },

  async save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const hasSpecs = !!(this.data.colors.length || this.data.sizes.length)
      const blankProcess = hasSpecs && this.data.blankPool
      await store.saveProduct({
        id: this.data.id,
        name: this.data.name,
        sku: this.data.sku,
        barcode: this.data.barcode,
        image: this.data.image,
        costPrice: this.data.costPrice,
        salePrice: this.data.salePrice,
        // 建档初始 0（稿 UX注释 n9「库存只读……建档初始 0。改数只走库存修正门」）。
        // 编辑态本来就不改件数：updateProduct 最后一行是 next.stock = existing.stock。
        stock: 0,
        alertQty: this.data.alertQty,
        specAxis1: hasSpecs ? this.data.specAxis1 : '',
        specAxis2: hasSpecs ? this.data.specAxis2 : '',
        colors: hasSpecs ? this.data.colors : [],
        sizes: hasSpecs ? this.data.sizes : [],
        blankProcess: blankProcess,
        // sharedPrice 在 5a 批之后没有读方了（稿上没有「同价 / 各格不同价」这个开关）。
        // 原样透传：不推导也不清零，老数据不churn。退役它是后续批次的事。
        sharedPrice: this.data.sharedPrice,
        skus: hasSpecs ? this.data.skuRows.map(function (row) {
          return {
            id: row.id,
            color: row.color,
            size: row.size,
            sku: row.sku,
            // **不带 costPrice。** applyProductSkus 里那一格是
            //   row.costPrice != null ? row.costPrice : (prev ? prev.costPrice : product.costPrice)
            // 不带这个 key，服务端就回落到这一格原来的进价（进货写进去的那个）；
            // 带上默认进价会把它冲掉，毛利当场算错。稿的矩阵也没有进价列。
            salePrice: row.salePrice,
            stock: '0',
            alertQty: row.alertQty
          }
        }) : []
      })
      await this.writeBack('names', this.data.name)
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      util.showError(error)
    } finally {
      this.setData({ saving: false })
    }
  },

  remove() {
    wx.showModal({
      title: '删除商品',
      content: '历史流水会保留，只是不再显示这个商品。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteProduct(this.data.id)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(function () {
            wx.navigateBack()
          }, 400)
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
