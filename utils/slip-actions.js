const slipImage = require('./slip-image')
const util = require('./util')
const store = require('./store')

function normalizeExportStyle(style) {
  return style === 'detail' ? 'detail' : 'summary'
}

// 回调回来时，单据和样式都可能已经换了，两个都要对上才认这张图。
//
// 只认 docNo 是不够的——切样式不换单据。changeExportStyle 每切一次就重新发起一次预生成，
// 于是「切到明细、立刻切回汇总」会有两次在飞；先发起的那次若后返回，就把明细那张图写进
// 缓存，而界面上选中的是汇总，用户点导出拿到的是明细。docNo 一样，挡不住。
//
// catch 同理：批 1 之前本函数只在打开弹层时调一次、不会并发，无条件清空是安全的；
// 现在并发了，失败的那次不能去清掉另一次成功的结果。
function prepareSlipImage(page, slip) {
  const docNo = slip && slip.docNo
  const exportStyle = normalizeExportStyle(page.data.exportStyle)
  function stillCurrent() {
    return page.data.showSlip
      && page.data.slip
      && page.data.slip.docNo === docNo
      && normalizeExportStyle(page.data.exportStyle) === exportStyle
  }
  slipImage.exportToTempFile(page, slip, exportStyle).then(function (path) {
    if (stillCurrent()) {
      page.slipImagePath = path
    }
  }).catch(function () {
    if (stillCurrent()) {
      page.slipImagePath = ''
    }
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
  const docNo = slip.docNo
  const exportStyle = normalizeExportStyle(page.data.exportStyle)
  // 导出在飞时用户切单据/切样式，回来的这张图就不该覆盖缓存——否则下次点导出
  // （命中缓存、不再重新生成）拿到的是这张过期的图。实践中 wx.showLoading({ mask: true })
  // 会挡住触摸，用户点不到 chip，但那只是运行时行为，代码层面没有任何东西保证它。
  // 守卫只管「要不要写进缓存」：本次点击要的就是这张图，openSlipImage 无条件执行。
  function stillCurrent() {
    return page.data.showSlip
      && page.data.slip
      && page.data.slip.docNo === docNo
      && normalizeExportStyle(page.data.exportStyle) === exportStyle
  }
  page.setData({ exporting: true })
  wx.showLoading({ title: '生成图片', mask: true })
  slipImage.exportToTempFile(page, slip, exportStyle).then(function (path) {
    if (stillCurrent()) {
      page.slipImagePath = path
    }
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

// 打开送货单时用：按客户读取记住的导出样式；散客或没有记录一律 'summary'。
function initialExportStyle(customerId) {
  return store.getSlipExportStyle(customerId)
}

// 切样式：更新 data、按客户写回记忆、并让已生成的图片缓存作废、按新样式重新预生成。
// 不作废缓存的话，用户切了样式点导出，拿到的还是旧样式那张图——这是这条链路最容易漏的坑。
// pages/sale 和 pages/record-edit 逻辑相同，收在这里复用，页面只挂 bindstylechange。
//
// 样式没变就直接 return：重复点已选中的 chip 不该白白扔掉一张有效缓存、重跑一遍渲染，
// 连点还会额外制造并发。比较要放在 normalizeExportStyle 之后，拿原始值比会漏掉
// 「本来就是 summary，传来的是未识别值也会被夹成 summary」这种同值不同写法的情况。
function changeExportStyle(page, style) {
  const normalized = normalizeExportStyle(style)
  if (normalized === normalizeExportStyle(page.data.exportStyle)) return
  const slip = page.data.slip
  page.slipImagePath = ''
  page.setData({ exportStyle: normalized })
  if (slip && slip.customerId) {
    store.setSlipExportStyle(slip.customerId, normalized)
  }
  if (slip) {
    prepareSlipImage(page, slip)
  }
}

module.exports = {
  prepareSlipImage: prepareSlipImage,
  exportSlip: exportSlip,
  openSlipImage: openSlipImage,
  closeSlip: closeSlip,
  initialExportStyle: initialExportStyle,
  changeExportStyle: changeExportStyle
}
