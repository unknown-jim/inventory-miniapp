const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

const SUGGESTED_COLORS = ['黑色', '白色']
const SUGGESTED_SIZES = ['M', 'L']

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
    colors: [],
    sizes: [],
    colorInput: '',
    sizeInput: '',
    hasSpecs: false,
    skuRows: [],
    specTip: '',
    blankProcess: false,
    blankStock: '',
    blankStockText: ''
  },

  onLoad(query) {
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
    this.setData(Object.assign({
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
      colors: product.colors || [],
      sizes: product.sizes || [],
      blankStockText: blank ? String(blank.stock) : '0',
      skuRows: this.rowsFromSkus(skus)
    }, kindFields(kind)))
    wx.setNavigationBarTitle({ title: '编辑商品' })
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

  rebuildSkuRows(colors, sizes, extra) {
    const combos = inventory.skuCombos(colors, sizes)
    const prevMap = {}
    ;(this.data.skuRows || []).forEach(function (row) {
      prevMap[row.key] = row
    })
    const rows = combos.map(function (combo) {
      const key = inventory.specKey(combo.color, combo.size)
      return prevMap[key] || this.emptyRow(combo)
    }.bind(this))

    this.setData(Object.assign({
      colors: colors,
      sizes: sizes,
      skuRows: rows
    }, extra || {}))
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
        specTip = specTip ? specTip + ' 库存已记到白坯。' : '库存已记到白坯。'
      }
    } else {
      const move = inventory.toNumber(this.data.blankStock || this.data.blankStockText)
      if (move > 0 && skuRows.length && !skuRows.some(function (row) {
        return inventory.toNumber(row.stock) > 0
      })) {
        skuRows[0].stock = String(move)
        blankStock = '0'
        specTip = specTip ? specTip + ' 白坯库存已记到第一个规格，请按实际拆分。' : '白坯库存已记到第一个规格，请按实际拆分。'
      }
    }
    return {
      skuRows: skuRows,
      blankStock: blankStock,
      specTip: specTip
    }
  },

  setProductKind(e) {
    const kind = e.currentTarget.dataset.kind
    if (!kind || kind === this.data.productKind) return
    if (kind === 'plain') {
      this.clearSpecs()
      return
    }
    if (kind === 'finished' && this.data.isEdit && inventory.toNumber(this.data.blankStockText) > 0) {
      wx.showToast({ title: '还有白坯库存，不能改成成衣现货', icon: 'none' })
      return
    }

    const from = this.data.productKind
    let colors = this.data.colors.slice()
    let sizes = this.data.sizes.slice()
    let specTip = ''
    if (!colors.length && !sizes.length) {
      colors = SUGGESTED_COLORS.slice()
      sizes = SUGGESTED_SIZES.slice()
      specTip = '已带出常用色码，可改、可删、可再加。'
    }

    const extra = kindFields(kind)
    extra.specTip = specTip

    if (from === 'plain' && kind === 'blank' && !this.data.isEdit) {
      const move = inventory.toNumber(this.data.stock)
      extra.blankStock = String(move || 0)
      if (move > 0) {
        extra.specTip = specTip ? specTip + ' 初始库存会记到白坯。' : '初始库存会记到白坯。'
      }
    }

    this.rebuildSkuRows(colors, sizes, extra)

    if (from === 'plain' && kind === 'finished') {
      const move = this.data.isEdit
        ? inventory.toNumber(this.data.stockText)
        : inventory.toNumber(this.data.stock)
      const skuRows = this.data.skuRows.slice()
      if (move > 0 && skuRows.length && !skuRows.some(function (row) {
        return inventory.toNumber(row.stock) > 0
      })) {
        skuRows[0].stock = String(move)
        this.setData({
          skuRows: skuRows,
          specTip: this.data.specTip
            ? this.data.specTip + ' 原库存已记到第一个规格，请按实际拆分。'
            : '原库存已记到第一个规格，请按实际拆分。'
        })
      }
      return
    }

    if (from === 'blank' || from === 'finished') {
      this.setData(this.migrateBlankFinished(kind === 'blank'))
    }
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
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
    if (!value) {
      wx.showToast({ title: '请输入颜色', icon: 'none' })
      return
    }
    if (this.data.colors.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个颜色', icon: 'none' })
      return
    }
    this.rebuildSkuRows(this.data.colors.concat([value]), this.data.sizes, { colorInput: '' })
  },

  addSize() {
    const value = String(this.data.sizeInput || '').trim()
    if (!value) {
      wx.showToast({ title: '请输入尺码', icon: 'none' })
      return
    }
    if (this.data.sizes.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个尺码', icon: 'none' })
      return
    }
    this.rebuildSkuRows(this.data.colors, this.data.sizes.concat([value]), { sizeInput: '' })
  },

  removeColor(e) {
    const value = e.currentTarget.dataset.value
    const blocked = this.data.skuRows.some(function (row) {
      return row.color === value && inventory.toNumber(row.stock) > 0
    })
    if (blocked) {
      wx.showToast({ title: '该颜色还有库存，不能删除', icon: 'none' })
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
      wx.showToast({ title: '该尺码还有库存，不能删除', icon: 'none' })
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
      content: '颜色和尺码会去掉，白坯和各规格库存合并到这件商品上。',
      success: (res) => {
        if (!res.confirm) return
        const patch = Object.assign(kindFields('plain'), {
          specTip: '',
          stock: String(total),
          stockText: String(total)
        })
        if (!this.data.isEdit) {
          patch.skuRows = this.data.skuRows.map(function (row) {
            return Object.assign({}, row, { stock: '0' })
          })
          patch.blankStock = ''
        }
        this.setData(patch)
      }
    })
  },

  onSkuField(e) {
    const index = e.currentTarget.dataset.index
    const field = e.currentTarget.dataset.field
    const skuRows = this.data.skuRows.slice()
    skuRows[index][field] = e.detail.value
    this.setData({ skuRows: skuRows })
  },

  save() {
    try {
      const kind = this.data.productKind
      const hasSpecs = kind !== 'plain'
      const blankProcess = kind === 'blank'
      if (hasSpecs && !this.data.colors.length && !this.data.sizes.length) {
        throw new Error('请添加颜色或尺码')
      }
      store.saveProduct({
        id: this.data.id,
        name: this.data.name,
        sku: this.data.sku,
        barcode: this.data.barcode,
        costPrice: this.data.costPrice,
        salePrice: this.data.salePrice,
        stock: hasSpecs
          ? (blankProcess && !this.data.isEdit ? this.data.blankStock || this.data.stock : 0)
          : (this.data.isEdit ? 0 : this.data.stock),
        alertQty: this.data.alertQty,
        colors: hasSpecs ? this.data.colors : [],
        sizes: hasSpecs ? this.data.sizes : [],
        blankProcess: blankProcess,
        skus: hasSpecs ? this.data.skuRows.map(function (row) {
          return {
            id: row.id,
            color: row.color,
            size: row.size,
            sku: row.sku,
            costPrice: row.costPrice,
            salePrice: row.salePrice,
            stock: row.stock,
            alertQty: row.alertQty
          }
        }) : []
      })
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
      success: (res) => {
        if (!res.confirm) return
        store.deleteProduct(this.data.id)
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(function () {
          wx.navigateBack()
        }, 400)
      }
    })
  }
})
