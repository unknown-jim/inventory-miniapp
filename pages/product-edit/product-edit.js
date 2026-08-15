const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

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
    const colors = product.colors || []
    const sizes = product.sizes || []
    const blank = inventory.findBlankSku(skus, product.id)
    this.setData({
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
      colors: colors,
      sizes: sizes,
      hasSpecs: inventory.productHasSpecs(product),
      blankProcess: inventory.isBlankProcess(product),
      blankStockText: blank ? String(blank.stock) : '0',
      skuRows: this.rowsFromSkus(skus)
    })
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

    let specTip = ''
    let blankProcess = this.data.blankProcess
    if (!this.data.skuRows.length && rows.length) {
      if (!this.data.hasSpecs) blankProcess = true
      const move = this.data.isEdit
        ? inventory.toNumber(this.data.stockText)
        : inventory.toNumber(this.data.stock)
      if (blankProcess) {
        if (move > 0 && !this.data.isEdit) {
          specTip = '初始库存会记到白坯，销售时再选颜色尺码。'
        }
      } else if (move > 0 && !rows.some(function (row) { return inventory.toNumber(row.stock) > 0 })) {
        rows[0].stock = String(move)
        specTip = '原库存已记到第一个规格，请按实际拆分。'
      }
    }

    this.setData(Object.assign({
      colors: colors,
      sizes: sizes,
      hasSpecs: combos.length > 0,
      blankProcess: combos.length ? blankProcess : false,
      skuRows: rows,
      specTip: specTip
    }, extra || {}))
  },

  setStockMode(e) {
    const mode = e.currentTarget.dataset.mode
    const blankProcess = mode === 'blank'
    if (blankProcess === this.data.blankProcess) return
    if (!blankProcess && this.data.isEdit && inventory.toNumber(this.data.blankStockText) > 0) {
      wx.showToast({ title: '还有白坯库存，不能改成成衣现货', icon: 'none' })
      return
    }
    const skuRows = this.data.skuRows.slice()
    let specTip = ''
    let blankStock = this.data.blankStock
    if (blankProcess) {
      const first = skuRows[0]
      const move = first ? inventory.toNumber(first.stock) : 0
      if (move > 0 && skuRows.every(function (row, index) {
        return index === 0 || inventory.toNumber(row.stock) <= 0
      })) {
        skuRows[0].stock = '0'
        blankStock = String(move)
        specTip = '库存已记到白坯。'
      }
    } else {
      const move = inventory.toNumber(this.data.blankStock || this.data.blankStockText)
      if (move > 0 && skuRows.length && !skuRows.some(function (row) { return inventory.toNumber(row.stock) > 0 })) {
        skuRows[0].stock = String(move)
        blankStock = '0'
        specTip = '白坯库存已记到第一个规格，请按实际拆分。'
      }
    }
    this.setData({
      blankProcess: blankProcess,
      skuRows: skuRows,
      blankStock: blankStock,
      specTip: specTip
    })
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

  clearSpecs() {
    wx.showModal({
      title: '改为普通商品',
      content: '颜色和尺码会去掉，各规格库存合并到这件商品上。',
      success: (res) => {
        if (!res.confirm) return
        const total = this.data.skuRows.reduce(function (sum, row) {
          return sum + inventory.toNumber(row.stock)
        }, 0)
        this.setData({
          colors: [],
          sizes: [],
          hasSpecs: false,
          skuRows: [],
          specTip: '',
          blankProcess: false,
          blankStock: String(total),
          blankStockText: String(total),
          stock: String(total),
          stockText: String(total || this.data.stockText)
        })
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
      store.saveProduct({
        id: this.data.id,
        name: this.data.name,
        sku: this.data.sku,
        barcode: this.data.barcode,
        costPrice: this.data.costPrice,
        salePrice: this.data.salePrice,
        stock: this.data.hasSpecs
          ? (this.data.blankProcess && !this.data.isEdit ? this.data.blankStock || this.data.stock : 0)
          : (this.data.isEdit ? 0 : this.data.stock),
        alertQty: this.data.alertQty,
        colors: this.data.colors,
        sizes: this.data.sizes,
        blankProcess: this.data.hasSpecs && this.data.blankProcess,
        skus: this.data.skuRows.map(function (row) {
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
        })
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
