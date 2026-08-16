const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

function axisLabel(value, fallback) {
  const name = String(value || '').trim()
  return name || fallback
}

Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    productKind: 'finished',
    sharedPrice: true,
    names: [],
    nameInput: '',
    specAxis1: '',
    specAxis2: '',
    colors: [],
    sizes: [],
    colorInput: '',
    sizeInput: ''
  },

  async onLoad(query) {
    if (!(await store.ready())) return
    if (!query.id) {
      wx.setNavigationBarTitle({ title: '新增种类' })
      return
    }
    const category = store.getCategory(query.id)
    if (!category) {
      wx.showToast({ title: '种类不存在', icon: 'none' })
      return
    }
    this.setData({
      id: category.id,
      isEdit: true,
      name: category.name,
      productKind: category.productKind || 'plain',
      sharedPrice: category.sharedPrice !== false,
      names: category.names || [],
      specAxis1: category.specAxis1 || '',
      specAxis2: category.specAxis2 || '',
      colors: category.colors || [],
      sizes: category.sizes || []
    })
    wx.setNavigationBarTitle({ title: '编辑种类' })
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  setProductKind(e) {
    const kind = e.currentTarget.dataset.kind
    if (!kind || kind === this.data.productKind) return
    const patch = { productKind: kind }
    if (kind === 'plain') {
      patch.specAxis1 = ''
      patch.specAxis2 = ''
      patch.colors = []
      patch.sizes = []
    }
    this.setData(patch)
  },

  setSharedPrice(e) {
    this.setData({ sharedPrice: e.currentTarget.dataset.on === '1' })
  },

  addName() {
    const value = String(this.data.nameInput || '').trim()
    if (!value) {
      wx.showToast({ title: '请输入商品名', icon: 'none' })
      return
    }
    if (this.data.names.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个名称', icon: 'none' })
      return
    }
    this.setData({
      names: this.data.names.concat([value]),
      nameInput: ''
    })
  },

  removeName(e) {
    const value = e.currentTarget.dataset.value
    this.setData({
      names: this.data.names.filter(function (item) {
        return item !== value
      })
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
    this.setData({
      colors: this.data.colors.concat([value]),
      colorInput: ''
    })
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
    this.setData({
      sizes: this.data.sizes.concat([value]),
      sizeInput: ''
    })
  },

  removeColor(e) {
    const value = e.currentTarget.dataset.value
    this.setData({
      colors: this.data.colors.filter(function (item) {
        return item !== value
      })
    })
  },

  removeSize(e) {
    const value = e.currentTarget.dataset.value
    this.setData({
      sizes: this.data.sizes.filter(function (item) {
        return item !== value
      })
    })
  },

  async save() {
    try {
      await store.saveCategory({
        id: this.data.id,
        name: this.data.name,
        names: this.data.names,
        productKind: this.data.productKind,
        sharedPrice: this.data.sharedPrice,
        specAxis1: this.data.specAxis1,
        specAxis2: this.data.specAxis2,
        colors: this.data.productKind === 'plain' ? [] : this.data.colors,
        sizes: this.data.productKind === 'plain' ? [] : this.data.sizes
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
      title: '删除种类',
      content: '只删模板，已经建好的商品不会动。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteCategory(this.data.id)
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
