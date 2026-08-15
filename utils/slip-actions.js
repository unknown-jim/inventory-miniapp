const slipImage = require('./slip-image')
const util = require('./util')

function prepareSlipImage(page, slip) {
  const docNo = slip && slip.docNo
  slipImage.exportToTempFile(page, slip).then(function (path) {
    if (page.data.showSlip && page.data.slip && page.data.slip.docNo === docNo) {
      page.slipImagePath = path
    }
  }).catch(function () {
    page.slipImagePath = ''
  })
}

function exportSlip(page) {
  if (page.data.exporting) return
  const ready = page.slipImagePath
  if (ready) {
    openSlipImage(ready)
    return
  }
  const slip = page.data.slip
  if (!slip) return
  page.setData({ exporting: true })
  wx.showLoading({ title: '生成图片', mask: true })
  slipImage.exportToTempFile(page, slip).then(function (path) {
    page.slipImagePath = path
    page.setData({ exporting: false })
    wx.hideLoading()
    openSlipImage(path)
  }).catch(function (error) {
    page.setData({ exporting: false })
    wx.hideLoading()
    util.showError(error && error.message ? error : new Error('导出失败'))
  })
}

function openSlipImage(path) {
  slipImage.openExportedImage(path).catch(function (error) {
    util.showError(error)
  })
}

function closeSlip(page) {
  page.slipImagePath = ''
  page.setData({ showSlip: false, exporting: false })
}

module.exports = {
  prepareSlipImage: prepareSlipImage,
  exportSlip: exportSlip,
  openSlipImage: openSlipImage,
  closeSlip: closeSlip
}
