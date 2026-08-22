const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

Page({
  data: {
    orderId: '',
    customerName: '',
    timeText: '',
    remark: '',
    lines: []
  },

  async onLoad(query) {
    if (!(await store.ready())) return
    const record = store.getRecord(query.id)
    if (!record || record.type !== 'out') {
      wx.showToast({ title: '销售流水不存在', icon: 'none' })
      return
    }
    this.setData({
      orderId: record.id,
      customerName: record.customerName || '散客',
      timeText: util.formatDateTime(record.createdAt),
      lines: inventory.recordLines(record).map(function (item) {
        const remain = inventory.returnableQty(item)
        return {
          id: item.lineId,
          productName: item.productName,
          specText: inventory.specText(item.color, item.size),
          soldText: String(item.qty),
          returnedText: String(inventory.round2(item.returnedQty)),
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

  async submit() {
    try {
      const orderId = this.data.orderId
      const items = this.data.lines.map(function (item) {
        return { saleOrderId: orderId, saleLineId: item.id, qty: item.qty }
      })
      await store.addReturn({
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
