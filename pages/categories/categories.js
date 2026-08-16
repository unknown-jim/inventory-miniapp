const store = require('../../utils/store')
const inventory = require('../../utils/inventory')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
  data: {
    keyword: '',
    list: []
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const list = inventory.filterCategories(store.getCategories(), this.data.keyword).map(function (item) {
      const parts = []
      parts.push(inventory.categoryKindTag(item))
      if (item.specAxis1 || item.specAxis2) {
        parts.push([item.specAxis1, item.specAxis2].filter(Boolean).join(' / ') || '规格')
      }
      if (item.names && item.names.length) {
        parts.push(item.names.slice(0, 3).join('、'))
      }
      return Object.assign({}, item, {
        kindTag: inventory.categoryKindTag(item),
        summary: parts.join(' · ')
      })
    })
    this.setData({ list: list })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/category-edit/category-edit' })
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/category-edit/category-edit?id=' + e.currentTarget.dataset.id })
  }
})
