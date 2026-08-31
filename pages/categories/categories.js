const store = require('../../utils/store')
const inventory = require('../../utils/inventory')

Page({
  // total 是**未过滤**的模板总数，专门用来把两个空态分开（稿 n4 15:157）：
  // total 为 0 是真空态，total 不为 0 而 list 为空才是「搜索无结果」。
  // 改版前只有 list 一个字段，两态共用一张卡，搜不到时说「还没有种类模板」是假话。
  //
  // 【不要往这个 data 里加 pageLoading】tests/automator-contract.test.js 的
  // NO_PAGE_LOADING 名单钉着本页没有它；加了会红，而且 tests/ui.test.js 的调用点
  // 也不对本页调 waitPageReady。
  data: {
    keyword: '',
    total: 0,
    list: [],
    missText: ''
  },

  async onShow() {
    if (!(await store.ready())) return
    this.refresh()
  },

  refresh() {
    const all = store.getCategories()
    const keyword = String(this.data.keyword || '').trim()
    // 摘要行的拼法与稿 15:50 / 15:53 / 15:56 三个样张逐字对得上：
    // 「类型 · 轴名 / 轴名 · 商品名待选前三个」，缺哪一段就少哪一段。
    const list = inventory.filterCategories(all, keyword).map(function (item) {
      const kindTag = inventory.categoryKindTag(item)
      const parts = []
      parts.push(kindTag)
      if (item.specAxis1 || item.specAxis2) {
        parts.push([item.specAxis1, item.specAxis2].filter(Boolean).join(' / ') || '规格')
      }
      if (item.names && item.names.length) {
        parts.push(item.names.slice(0, 3).join('、'))
      }
      // 类型 tag 的类名在这里定，不写进 wxml 的三层三元表达式里。
      // 三个类都是 app.wxss 的共用类，本批不改它们的值（规格 §6-3）。
      let tagClass = 'tag-ok'
      if (item.productKind === 'blank') tagClass = 'tag-blank'
      if (item.productKind === 'finished') tagClass = 'tag-spec'
      return Object.assign({}, item, {
        kindTag: kindTag,
        tagClass: tagClass,
        summary: parts.join(' · ')
      })
    })
    this.setData({
      total: all.length,
      list: list,
      // 稿 $15:61 逐字：「没有找到含「墙布」的种类，换个词试试，或清空搜索看全部 3 个种类」。
      // 两个变量：关键词、未过滤总数。只在搜索无结果那一支渲染。
      missText: '没有找到含「' + keyword + '」的种类，换个词试试，或清空搜索看全部 '
        + all.length + ' 个种类'
    })
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value })
    this.refresh()
  },

  // 稿 16d 的「清空搜索」退路（btn/ghost 15:207，label $15:62）。
  // 只清关键词、原地刷新，不退栈。
  clearSearch() {
    this.setData({ keyword: '' })
    this.refresh()
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/category-edit/category-edit' })
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/category-edit/category-edit?id=' + e.currentTarget.dataset.id })
  }
})
