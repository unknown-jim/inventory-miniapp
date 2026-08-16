const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')
const uiScale = require('../../utils/ui-scale')

Page({
  behaviors: [uiScale.behavior],
  data: {
    type: 'all',
    list: [],
    salesAmount: '0.00',
    purchaseAmount: '0.00',
    profit: '0.00',
    receivable: '0.00',
    count: 0
  },

  onLoad(options) {
    const type = options && options.type
    if (type === 'in' || type === 'out' || type === 'pay' || type === 'return' || type === 'convert') {
      this.setData({ type: type })
    }
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const all = store.getRecords()
    const records = inventory.filterRecords(all, this.data.type)
    const summary = inventory.summarizeRecords(all)
    const list = inventory.groupRecords(records)
    this.setData({
      list: list.map(util.withRecordView),
      salesAmount: util.money(summary.salesAmount),
      purchaseAmount: util.money(summary.purchaseAmount),
      profit: util.money(summary.profit),
      receivable: util.money(summary.receivable),
      count: list.length
    })
  },

  setType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
    this.refresh()
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/record-edit/record-edit?id=' + e.currentTarget.dataset.id })
  }
})
