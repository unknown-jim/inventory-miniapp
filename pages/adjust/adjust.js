const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

function hintText(direction) {
  if (direction === 'out') {
    return '不计入销售额和销售毛利，不开送货单。无单送人、报损、盘亏用这个。送货单上的赠品请走销售，售价填 0。'
  }
  return '不计入进货金额，也不改这件商品的进价。别人送来的货、盘盈用这个；花钱进货请走进货。'
}

function reasonOptionsOf(direction, selected) {
  const type = direction === 'out' ? 'adjust_out' : 'adjust_in'
  return inventory.adjustReasons(type).map(function (item) {
    return Object.assign({}, item, { on: item.value === selected })
  })
}

Page({
  data: {
    productId: '',
    productName: '',
    hasSpecs: false,
    blankProcess: false,
    skuId: '',
    cellOptions: [],
    stockText: '',
    direction: 'in',
    reason: 'surplus',
    reasonOptions: [],
    qty: '',
    remark: '',
    hintText: '',
    remarkPlaceholder: '可选'
  },

  onLoad(query) {
    const id = query && query.id
    if (!id) {
      wx.showToast({ title: '请从商品编辑进入', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
      return
    }
    this.pendingId = id
  },

  async onShow() {
    if (!(await store.ready())) return
    const id = this.pendingId || this.data.productId
    if (!id) return
    this.pendingId = ''
    this.loadProduct(id)
  },

  cellOptionsOf(product, skus, selectedId) {
    const list = inventory.skusOfProduct(skus, product.id)
    if (inventory.isBlankProcess(product)) {
      const options = []
      const blank = inventory.findBlankSku(skus, product.id)
      if (blank) {
        options.push({
          id: blank.id,
          specText: inventory.blankStockLabel(),
          stock: blank.stock,
          on: blank.id === selectedId
        })
      }
      list.filter(function (item) {
        return !item.isBlank
      }).forEach(function (item) {
        options.push({
          id: item.id,
          specText: inventory.specText(item.color, item.size),
          stock: item.stock,
          on: item.id === selectedId
        })
      })
      return options
    }
    return list.filter(function (item) {
      return !item.isBlank
    }).map(function (item) {
      return {
        id: item.id,
        specText: inventory.specText(item.color, item.size),
        stock: item.stock,
        on: item.id === selectedId
      }
    })
  },

  currentStock(product, skus, skuId) {
    if (!inventory.productHasSpecs(product)) {
      return String(product.stock)
    }
    if (!skuId) return '—'
    const sku = (skus || []).find(function (item) {
      return item.id === skuId
    })
    return sku ? String(sku.stock) : '—'
  },

  loadProduct(id) {
    const product = store.getProduct(id)
    if (!product) {
      wx.showToast({ title: '请从商品编辑进入', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
      return
    }
    const skus = store.getSkusByProduct(product.id)
    const hasSpecs = inventory.productHasSpecs(product)
    const cellOptions = hasSpecs ? this.cellOptionsOf(product, skus, this.data.skuId) : []
    let skuId = this.data.productId === product.id ? this.data.skuId : ''
    if (hasSpecs) {
      const still = cellOptions.some(function (item) {
        return item.id === skuId
      })
      if (!still) skuId = cellOptions.length === 1 ? cellOptions[0].id : ''
    } else {
      skuId = ''
    }
    const direction = this.data.direction || 'in'
    const reason = this.data.reason || 'surplus'
    this.setData({
      productId: product.id,
      productName: product.name,
      hasSpecs: hasSpecs,
      blankProcess: inventory.isBlankProcess(product),
      skuId: skuId,
      cellOptions: this.cellOptionsOf(product, skus, skuId),
      stockText: this.currentStock(product, skus, skuId),
      direction: direction,
      reason: reason,
      reasonOptions: reasonOptionsOf(direction, reason),
      hintText: hintText(direction),
      remarkPlaceholder: reason === 'other' ? '必填，说明原因' : '可选'
    })
  },

  pickCell(e) {
    const skuId = e.currentTarget.dataset.id
    const product = store.getProduct(this.data.productId)
    const skus = store.getSkusByProduct(this.data.productId)
    this.setData({
      skuId: skuId,
      cellOptions: this.cellOptionsOf(product, skus, skuId),
      stockText: this.currentStock(product, skus, skuId)
    })
  },

  setDirection(e) {
    const direction = e.currentTarget.dataset.direction
    let reason = this.data.reason
    const type = direction === 'out' ? 'adjust_out' : 'adjust_in'
    if (!inventory.adjustReasonAllowed(type, reason)) {
      reason = direction === 'out' ? 'damage' : 'surplus'
    }
    this.setData({
      direction: direction,
      reason: reason,
      reasonOptions: reasonOptionsOf(direction, reason),
      hintText: hintText(direction),
      remarkPlaceholder: reason === 'other' ? '必填，说明原因' : '可选'
    })
  },

  pickReason(e) {
    const reason = e.currentTarget.dataset.value
    this.setData({
      reason: reason,
      reasonOptions: reasonOptionsOf(this.data.direction, reason),
      remarkPlaceholder: reason === 'other' ? '必填，说明原因' : '可选'
    })
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  async submit() {
    try {
      const product = store.getProduct(this.data.productId)
      if (!product) {
        throw new Error('请从商品编辑进入')
      }
      if (inventory.productHasSpecs(product) && !this.data.skuId) {
        throw new Error(inventory.specSelectHint(product) || '请选择要调整的库存')
      }
      const payload = {
        productId: product.id,
        direction: this.data.direction,
        reason: this.data.reason,
        qty: this.data.qty,
        remark: this.data.remark
      }
      if (this.data.skuId) payload.skuId = this.data.skuId
      await store.addAdjust(payload)
      this.loadProduct(product.id)
      this.setData({ qty: '', remark: '' })
      wx.showToast({ title: '已调整', icon: 'success' })
    } catch (error) {
      util.showError(error)
    }
  }
})
