const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    type: 'all',
    list: [],
    salesAmount: '0.00',
    purchaseAmount: '0.00',
    profit: '0.00',
    count: 0
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const records = inventory.filterRecords(store.getRecords(), this.data.type)
    const summary = inventory.summarizeRecords(records)
    this.setData({
      list: records.map(util.withRecordView),
      salesAmount: util.money(summary.salesAmount),
      purchaseAmount: util.money(summary.purchaseAmount),
      profit: util.money(summary.profit),
      count: summary.count
    })
  },

  setType(e) {
    this.setData({ type: e.currentTarget.dataset.type })
    this.refresh()
  }
})
