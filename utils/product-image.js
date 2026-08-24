// 商品图：选图后客户端压缩再直传云开发存储。
// 只在云模式开放（内存模式 / 未配环境没有云存储，UI 整块不渲染）。
const store = require('./store')

// 缩略图最长边：列表显示尺寸的 2~3 倍，盖住高分屏。压成 jpg 后一般几十 KB。
const MAX_EDGE = 600
const JPEG_QUALITY = 0.7

function canUseImage() {
  const status = store.getStatus()
  return status.mode === 'cloud' && status.configured && !!status.shopId
}

// 与 store.js 的 uid() 同风格。cloudPath 只要求不撞名，不编码商品 id：
// 换图就是写一个新文件，旧文件由服务端在保存后清理。
function makeFileName() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// `shops/${shopId}/products/${name}.jpg`——服务端按这个前缀校验和删除
// （cloudfunctions/ledger/ledger-core.js 的 validShopImageFileId），
// 改这里必须同步改那边，两边都有测试钉住。
function buildCloudPath(shopId, name) {
  return 'shops/' + shopId + '/products/' + name + '.jpg'
}

function getImageInfo(src) {
  return new Promise(function (resolve, reject) {
    wx.getImageInfo({
      src: src,
      success: resolve,
      fail: function () {
        reject(new Error('这张图打不开，换一张试试'))
      }
    })
  })
}

function loadCanvasImage(canvas, src) {
  return new Promise(function (resolve, reject) {
    const img = canvas.createImage()
    img.onload = function () {
      resolve(img)
    }
    img.onerror = function () {
      reject(new Error('这张图打不开，换一张试试'))
    }
    img.src = src
  })
}

// 压缩：canvas 是页面里 <canvas type="2d"> 的 node（见 product-edit 的
// getImageCanvas）。只缩不放：两边都 ≤ 原尺寸。返回压缩后的临时文件路径。
async function compressImage(canvas, srcPath) {
  const info = await getImageInfo(srcPath)
  const scale = Math.min(1, MAX_EDGE / Math.max(info.width, info.height))
  const width = Math.max(1, Math.round(info.width * scale))
  const height = Math.max(1, Math.round(info.height * scale))
  canvas.width = width
  canvas.height = height
  const img = await loadCanvasImage(canvas, srcPath)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, width, height)
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      fileType: 'jpg',
      quality: JPEG_QUALITY,
      destWidth: width,
      destHeight: height,
      success: function (res) {
        resolve(res.tempFilePath)
      },
      fail: function (error) {
        reject(new Error((error && error.errMsg) || '图片处理失败，请重试'))
      }
    })
  })
}

async function uploadProductImage(filePath, shopId) {
  if (!String(shopId || '').trim()) {
    throw new Error('还没有选择店铺，不能上传图片')
  }
  const res = await new Promise(function (resolve, reject) {
    wx.cloud.uploadFile({
      cloudPath: buildCloudPath(shopId, makeFileName()),
      filePath: filePath,
      success: resolve,
      fail: function (error) {
        console.warn('[product-image] 上传失败', error)
        reject(new Error('图片上传失败，请重试'))
      }
    })
  })
  const fileID = res && res.fileID
  if (!fileID) throw new Error('图片上传失败，请重试')
  return fileID
}

module.exports = {
  MAX_EDGE: MAX_EDGE,
  JPEG_QUALITY: JPEG_QUALITY,
  canUseImage: canUseImage,
  makeFileName: makeFileName,
  buildCloudPath: buildCloudPath,
  compressImage: compressImage,
  uploadProductImage: uploadProductImage
}
