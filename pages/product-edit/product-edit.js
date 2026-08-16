const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const skuCardView = require('../../utils/sku-card-view').skuCardView

function axisLabel(value, fallback) {
  const name = String(value || '').trim()
  return name || fallback
}

function kindFields(kind) {
  return {
    productKind: kind,
    hasSpecs: kind !== 'plain',
    blankProcess: kind === 'blank'
  }
}

function productKindOf(product) {
  if (inventory.isBlankProcess(product)) return 'blank'
  if (inventory.productHasSpecs(product)) return 'finished'
  return 'plain'
}

Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    sku: '',
    barcode: '',
    costPrice: '',
    salePrice: '',
    stock: '',
    alertQty: '5',
    stockText: '',
    marginText: '0.00',
    rateText: '0%',
    productKind: 'plain',
    specAxis1: '',
    specAxis2: '',
    colors: [],
    sizes: [],
    colorInput: '',
    sizeInput: '',
    hasSpecs: false,
    skuRows: [],
    specTip: '',
    blankProcess: false,
    blankStock: '',
    blankStockText: '',
    categories: [],
    categoryId: '',
    nameSuggest: [],
    sharedPrice: true,
    blankStockRows: [],
    showBlankPriceCard: false,
    showBlankStockCard: false,
    showFinishedSkuCard: false
  },

  async onLoad(query) {
    if (!(await store.ready())) return
    if (!query.id) {
      wx.setNavigationBarTitle({ title: '新增商品' })
      return
    }
    const product = store.getProduct(query.id)
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      return
    }
    const skus = store.getSkusByProduct(product.id)
    const margin = inventory.calcMargin(product.costPrice, product.salePrice)
    const kind = productKindOf(product)
    const blank = inventory.findBlankSku(skus, product.id)
    const skuRows = this.rowsFromSkus(skus)
    let sharedPrice = kind !== 'plain' && product.sharedPrice !== false
    let specTip = ''
    if (sharedPrice && !inventory.skuPricesMatch(skus)) {
      sharedPrice = false
      specTip = '部分规格价格不同，已按各格显示。'
    }
    this.setData(this.withSkuCards(Object.assign({
      id: product.id,
      isEdit: true,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      costPrice: String(product.costPrice),
      salePrice: String(product.salePrice),
      alertQty: String(product.alertQty),
      stockText: String(product.stock),
      marginText: util.money(margin.profit),
      rateText: margin.rate + '%',
      specAxis1: product.specAxis1 || '',
      specAxis2: product.specAxis2 || '',
      colors: product.colors || [],
      sizes: product.sizes || [],
      blankStockText: blank ? String(blank.stock) : '0',
      skuRows: skuRows,
      sharedPrice: sharedPrice,
      specTip: specTip
    }, kindFields(kind))))
    wx.setNavigationBarTitle({ title: '编辑商品' })
  },

  async onShow() {
    if (!(await store.ready())) return
    this.refreshCategories()
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

  rowsFromSkus(skus) {
    return (skus || []).filter(function (item) {
      return !item.isBlank
    }).map(function (item) {
      return {
        key: inventory.specKey(item.color, item.size),
        id: item.id,
        isNew: false,
        color: item.color,
        size: item.size,
        specText: inventory.specText(item.color, item.size),
        sku: item.sku,
        costPrice: String(item.costPrice),
        salePrice: String(item.salePrice),
        stock: String(item.stock),
        alertQty: String(item.alertQty)
      }
    })
  },

  emptyRow(combo) {
    return {
      key: inventory.specKey(combo.color, combo.size),
      id: '',
      isNew: true,
      color: combo.color,
      size: combo.size,
      specText: inventory.specText(combo.color, combo.size),
      sku: '',
      costPrice: this.data.costPrice,
      salePrice: this.data.salePrice,
      stock: '0',
      alertQty: this.data.alertQty
    }
  },

  withSkuCards(patch) {
    const kind = patch.productKind != null ? patch.productKind : this.data.productKind
    const shared = patch.sharedPrice != null ? patch.sharedPrice : this.data.sharedPrice
    const rows = patch.skuRows != null ? patch.skuRows : this.data.skuRows
    return Object.assign(patch, skuCardView(kind, shared, rows))
  },

  withSharedPrices(rows) {
    if (!this.data.sharedPrice) return rows
    const cost = this.data.costPrice
    const sale = this.data.salePrice
    return (rows || []).map(function (row) {
      return Object.assign({}, row, { costPrice: cost, salePrice: sale })
    })
  },

  rebuildSkuRows(colors, sizes, extra) {
    const combos = inventory.skuCombos(colors, sizes)
    const prevMap = {}
    ;(this.data.skuRows || []).forEach(function (row) {
      prevMap[row.key] = row
    })
    let rows = combos.map(function (combo) {
      const key = inventory.specKey(combo.color, combo.size)
      return prevMap[key] || this.emptyRow(combo)
    }.bind(this))
    const shared = extra && extra.sharedPrice != null ? extra.sharedPrice : this.data.sharedPrice
    if (shared) {
      const cost = this.data.costPrice
      const sale = this.data.salePrice
      rows = rows.map(function (row) {
        return Object.assign({}, row, { costPrice: cost, salePrice: sale })
      })
    }

    const patch = Object.assign({
      colors: colors,
      sizes: sizes,
      skuRows: rows
    }, extra || {})
    const kind = patch.productKind || this.data.productKind
    if (!this.data.isEdit && kind === 'finished' && rows.length) {
      const move = inventory.toNumber(this.data.stock)
      const hasStock = rows.some(function (row) {
        return inventory.toNumber(row.stock) > 0
      })
      if (move > 0 && !hasStock) {
        rows[0] = Object.assign({}, rows[0], { stock: String(move) })
        patch.skuRows = rows
        const tip = patch.specTip != null ? patch.specTip : (this.data.specTip || '')
        if (tip.indexOf('原库存已记到第一个规格') < 0) {
          patch.specTip = tip
            ? tip + ' 原库存已记到第一个规格，请按实际拆分。'
            : '原库存已记到第一个规格，请按实际拆分。'
        }
      }
    }

    this.setData(this.withSkuCards(patch))
  },

  migrateBlankFinished(wantBlank) {
    const skuRows = this.data.skuRows.slice()
    let specTip = this.data.specTip || ''
    let blankStock = this.data.blankStock
    if (wantBlank) {
      const first = skuRows[0]
      const move = first ? inventory.toNumber(first.stock) : 0
      if (move > 0 && skuRows.every(function (row, index) {
        return index === 0 || inventory.toNumber(row.stock) <= 0
      })) {
        skuRows[0].stock = '0'
        blankStock = String(move)
        specTip = specTip ? specTip + ' 库存已记到待加工。' : '库存已记到待加工。'
      }
    } else {
      const move = inventory.toNumber(this.data.blankStock || this.data.blankStockText)
      if (move > 0 && skuRows.length && !skuRows.some(function (row) {
        return inventory.toNumber(row.stock) > 0
      })) {
        skuRows[0].stock = String(move)
        blankStock = '0'
        specTip = specTip ? specTip + ' 待加工库存已记到第一个规格，请按实际拆分。' : '待加工库存已记到第一个规格，请按实际拆分。'
      }
    }
    return {
      skuRows: skuRows,
      blankStock: blankStock,
      specTip: specTip
    }
  },

  setProductKind(e) {
    this.applyProductKind(e.currentTarget.dataset.kind)
  },

  applyProductKind(kind, extra, colorsOverride, sizesOverride) {
    extra = extra || {}
    if (!kind) return
    if (kind === this.data.productKind && colorsOverride == null) return
    if (kind === 'plain') {
      this.clearSpecs()
      return
    }
    if (kind === 'finished' && this.data.isEdit && inventory.toNumber(this.data.blankStockText) > 0) {
      wx.showToast({ title: '还有待加工库存，不能改成分规格现货', icon: 'none' })
      return
    }

    const from = this.data.productKind
    const colors = colorsOverride != null ? colorsOverride.slice() : this.data.colors.slice()
    const sizes = sizesOverride != null ? sizesOverride.slice() : this.data.sizes.slice()
    let specTip = extra.specTip != null ? extra.specTip : ''
    if (!specTip && !colors.length && !sizes.length) {
      specTip = '先给规格轴起名（可只用一根），再添加取值。可改、可删、可再加。'
    }

    const patch = Object.assign(kindFields(kind), extra)
    patch.specTip = specTip
    if (from === 'plain' && extra.sharedPrice == null) {
      patch.sharedPrice = true
    }

    if (from === 'plain' && kind === 'blank' && !this.data.isEdit) {
      const move = inventory.toNumber(this.data.stock)
      patch.blankStock = String(move || 0)
      if (move > 0) {
        patch.specTip = specTip ? specTip + ' 初始库存会记到待加工。' : '初始库存会记到待加工。'
      }
    }

    this.rebuildSkuRows(colors, sizes, patch)

    if (from !== kind && from === 'plain' && kind === 'finished') {
      const move = this.data.isEdit
        ? inventory.toNumber(this.data.stockText)
        : inventory.toNumber(this.data.stock)
      const skuRows = this.data.skuRows.slice()
      if (move > 0 && skuRows.length && !skuRows.some(function (row) {
        return inventory.toNumber(row.stock) > 0
      })) {
        skuRows[0].stock = String(move)
        this.setData(this.withSkuCards({
          skuRows: skuRows,
          specTip: this.data.specTip
            ? this.data.specTip + ' 原库存已记到第一个规格，请按实际拆分。'
            : '原库存已记到第一个规格，请按实际拆分。'
        }))
      }
      return
    }

    if (from !== kind && (from === 'blank' || from === 'finished')) {
      this.setData(this.withSkuCards(this.migrateBlankFinished(kind === 'blank')))
    }
  },

  applyCategory(e) {
    const id = e.currentTarget.dataset.id
    const category = store.getCategory(id)
    if (!category) return
    const kind = category.productKind || 'plain'
    const chips = this.categoryChips(id)
    const nameSuggest = category.names || []
    const base = {
      categoryId: id,
      nameSuggest: nameSuggest,
      categories: chips
    }

    if (kind === 'plain') {
      if (this.data.productKind !== 'plain') {
        if (this.data.isEdit && this.specStockTotal() > 0) {
          wx.showToast({ title: '这件商品还有库存，只带出名称待选项', icon: 'none' })
          this.setData(base)
          return
        }
        if (!this.data.isEdit) {
          this.setData(this.withSkuCards(Object.assign(kindFields('plain'), base, {
            specTip: '',
            specAxis1: '',
            specAxis2: '',
            colors: [],
            sizes: [],
            skuRows: [],
            blankStock: ''
          })))
          return
        }
        this.setData(base)
        wx.showToast({ title: '名称待选项已带出。要改成普通请先去掉规格。', icon: 'none' })
        return
      }
      this.setData(base)
      return
    }

    const colors = this.data.isEdit
      ? inventory.uniqueSpecs((this.data.colors || []).concat(category.colors || []))
      : (category.colors || []).slice()
    const sizes = this.data.isEdit
      ? inventory.uniqueSpecs((this.data.sizes || []).concat(category.sizes || []))
      : (category.sizes || []).slice()
    const extra = Object.assign({}, base, {
      specAxis1: category.specAxis1 || this.data.specAxis1,
      specAxis2: category.specAxis2 || this.data.specAxis2,
      sharedPrice: category.sharedPrice !== false,
      specTip: ''
    })

    if (this.data.productKind !== kind) {
      this.applyProductKind(kind, extra, colors, sizes)
      return
    }
    this.rebuildSkuRows(colors, sizes, extra)
  },

  pickName(e) {
    const name = e.currentTarget.dataset.value
    this.setData({ name: name })
    this.refreshMargin()
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

  setSharedPrice(e) {
    const sharedPrice = e.currentTarget.dataset.on === '1'
    const skuRows = sharedPrice ? this.withSharedPrices(this.data.skuRows) : this.data.skuRows
    this.setData(this.withSkuCards({ sharedPrice: sharedPrice, skuRows: skuRows }))
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    if (this.data.sharedPrice && (field === 'costPrice' || field === 'salePrice')) {
      const cost = field === 'costPrice' ? e.detail.value : this.data.costPrice
      const sale = field === 'salePrice' ? e.detail.value : this.data.salePrice
      patch.skuRows = (this.data.skuRows || []).map(function (row) {
        return Object.assign({}, row, { costPrice: cost, salePrice: sale })
      })
    }
    this.setData(patch)
    this.refreshMargin()
  },

  refreshMargin() {
    const margin = inventory.calcMargin(this.data.costPrice, this.data.salePrice)
    this.setData({
      marginText: util.money(margin.profit),
      rateText: margin.rate + '%'
    })
  },

  addColor() {
    const value = String(this.data.colorInput || '').trim()
    const label = axisLabel(this.data.specAxis1, '规格一')
    if (!value) {
      wx.showToast({ title: '请输入' + label, icon: 'none' })
      return
    }
    if (this.data.colors.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个' + label, icon: 'none' })
      return
    }
    this.rebuildSkuRows(this.data.colors.concat([value]), this.data.sizes, { colorInput: '' })
    this.writeBack('colors', value)
  },

  addSize() {
    const value = String(this.data.sizeInput || '').trim()
    const label = axisLabel(this.data.specAxis2, '规格二')
    if (!value) {
      wx.showToast({ title: '请输入' + label, icon: 'none' })
      return
    }
    if (this.data.sizes.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个' + label, icon: 'none' })
      return
    }
    this.rebuildSkuRows(this.data.colors, this.data.sizes.concat([value]), { sizeInput: '' })
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
    this.rebuildSkuRows(this.data.colors.filter(function (item) {
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
    this.rebuildSkuRows(this.data.colors, this.data.sizes.filter(function (item) {
      return item !== value
    }))
  },

  specStockTotal() {
    const skuTotal = this.data.skuRows.reduce(function (sum, row) {
      return sum + inventory.toNumber(row.stock)
    }, 0)
    if (this.data.productKind !== 'blank') return skuTotal
    const blank = this.data.isEdit
      ? inventory.toNumber(this.data.blankStockText)
      : inventory.toNumber(this.data.blankStock)
    return skuTotal + blank
  },

  clearSpecs() {
    const total = this.specStockTotal()
    wx.showModal({
      title: '改为普通商品',
      content: '规格会去掉，待加工和各规格库存合并到这件商品上。',
      success: (res) => {
        if (!res.confirm) return
        const patch = Object.assign(kindFields('plain'), {
          specTip: '',
          specAxis1: '',
          specAxis2: '',
          stock: String(total),
          stockText: String(total)
        })
        if (!this.data.isEdit) {
          patch.skuRows = this.data.skuRows.map(function (row) {
            return Object.assign({}, row, { stock: '0' })
          })
          patch.blankStock = ''
        }
        this.setData(this.withSkuCards(patch))
      }
    })
  },

  onSkuField(e) {
    const index = e.currentTarget.dataset.index
    const field = e.currentTarget.dataset.field
    const skuRows = this.data.skuRows.slice()
    skuRows[index][field] = e.detail.value
    this.setData(this.withSkuCards({ skuRows: skuRows }))
  },

  async save() {
    try {
      const kind = this.data.productKind
      const hasSpecs = kind !== 'plain'
      const blankProcess = kind === 'blank'
      if (hasSpecs && !this.data.colors.length && !this.data.sizes.length) {
        throw new Error('请添加规格')
      }
      const sharedPrice = hasSpecs && this.data.sharedPrice
      const costPrice = this.data.costPrice
      const salePrice = this.data.salePrice
      await store.saveProduct({
        id: this.data.id,
        name: this.data.name,
        sku: this.data.sku,
        barcode: this.data.barcode,
        costPrice: costPrice,
        salePrice: salePrice,
        stock: hasSpecs
          ? (blankProcess && !this.data.isEdit ? this.data.blankStock || this.data.stock : 0)
          : (this.data.isEdit ? 0 : this.data.stock),
        alertQty: this.data.alertQty,
        specAxis1: hasSpecs ? this.data.specAxis1 : '',
        specAxis2: hasSpecs ? this.data.specAxis2 : '',
        colors: hasSpecs ? this.data.colors : [],
        sizes: hasSpecs ? this.data.sizes : [],
        blankProcess: blankProcess,
        sharedPrice: sharedPrice,
        skus: hasSpecs ? this.data.skuRows.map(function (row) {
          return {
            id: row.id,
            color: row.color,
            size: row.size,
            sku: row.sku,
            costPrice: sharedPrice ? costPrice : row.costPrice,
            salePrice: sharedPrice ? salePrice : row.salePrice,
            stock: row.stock,
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
