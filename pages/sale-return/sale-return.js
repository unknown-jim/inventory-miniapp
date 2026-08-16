const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    customerName: '',
    timeText: '',
    remark: '',
    lines: []
  },

  onLoad(query) {
    const record = store.getRecord(query.id)
    if (!record || record.type !== 'out') {
      wx.showToast({ title: '销售流水不存在', icon: 'none' })
      return
    }
    const records = store.getRecords()
    const order = inventory.buildSaleOrder(records, record)
    this.setData({
      customerName: order.customerName || '散客',
      timeText: util.formatDateTime(order.createdAt),
      lines: order.records.map(function (item) {
        const remain = inventory.returnableQty(records, item)
        return {
          id: item.id,
          productName: item.productName,
          specText: inventory.specText(item.color, item.size),
          soldText: String(item.qty),
          returnedText: String(inventory.saleReturnQty(records, item.id)),
          remainText: String(remain),
          remain: remain,
          qty: remain > 0 ? String(remain) : '0'
        }
      })
    })
  },

  onQty(e) {
    const id = e.currentTarget.dataset.id
    const lines = this.data.lines.map(function (item) {
      if (item.id !== id) return item
      return Object.assign({}, item, { qty: e.detail.value })
    })
    this.setData({ lines: lines })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    try {
      const items = this.data.lines.map(function (item) {
        return { saleRecordId: item.id, qty: item.qty }
      })
      store.addReturn({
        items: items,
        remark: this.data.remark
      })
      wx.showToast({ title: '已退货入库', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      util.showError(error)
    }
  }
})
