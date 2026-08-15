const WIDTH = 750
const PAD = 48

const COLORS = {
  bg: '#FFFFFF',
  kicker: '#0F766E',
  title: '#134E4A',
  muted: '#64748B',
  value: '#134E4A',
  line: '#E2E8F0',
  debt: '#C2410C'
}

const FONT = {
  kicker: '600 22px sans-serif',
  title: '700 40px sans-serif',
  meta: '22px sans-serif',
  name: '600 28px sans-serif',
  muted: '22px sans-serif',
  value: '600 28px sans-serif',
  amount: '700 36px sans-serif',
  debt: '700 32px sans-serif'
}

function parseFontSize(font) {
  const match = String(font || '').match(/(\d+)px/)
  return match ? Number(match[1]) : 28
}

function estimateWidth(text, font) {
  const size = parseFontSize(font)
  const str = String(text || '')
  let width = 0
  for (let i = 0; i < str.length; i++) {
    width += str.charCodeAt(i) > 127 ? size : Math.ceil(size * 0.55)
  }
  return width
}

function wrapText(text, maxWidth, measure) {
  const str = String(text || '')
  if (!str) return ['']
  const lines = []
  let current = ''
  for (let i = 0; i < str.length; i++) {
    const next = current + str.charAt(i)
    if (current && measure(next) > maxWidth) {
      lines.push(current)
      current = str.charAt(i)
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines
}

function pushText(cmds, text, x, y, font, color, align) {
  cmds.push({
    type: 'text',
    text: String(text || ''),
    x: x,
    y: y,
    font: font,
    color: color,
    align: align || 'left'
  })
}

function pushDash(cmds, y) {
  cmds.push({
    type: 'dash',
    y: y,
    x1: PAD,
    x2: WIDTH - PAD
  })
}

function pushRow(cmds, label, value, y, measure) {
  const labelWidth = 132
  const valueWidth = WIDTH - PAD * 2 - labelWidth
  const lines = wrapText(value, valueWidth, function (text) {
    return measure(text, FONT.value)
  })
  pushText(cmds, label, PAD, y, FONT.muted, COLORS.muted, 'left')
  lines.forEach(function (line, index) {
    pushText(cmds, line, WIDTH - PAD, y + index * 36, FONT.value, COLORS.value, 'right')
  })
  return y + Math.max(44, lines.length * 36 + 8)
}

function layoutSlip(slip, measure) {
  const measureFn = measure || estimateWidth
  const cmds = []
  const right = WIDTH - PAD
  const contentWidth = WIDTH - PAD * 2
  const amountCol = 200
  const nameWidth = contentWidth - amountCol
  let y = PAD

  pushText(cmds, '请核对后签收', PAD, y, FONT.kicker, COLORS.kicker)
  y += 36
  pushText(cmds, '送货单', PAD, y, FONT.title, COLORS.title)
  y += 58
  pushText(cmds, '单号 ' + (slip.docNo || ''), PAD, y, FONT.meta, COLORS.muted)
  pushText(cmds, slip.timeText || '', right, y, FONT.meta, COLORS.muted, 'right')
  y += 40
  pushDash(cmds, y)
  y += 20

  if (slip.hasCustomer) {
    y = pushRow(cmds, '收货人', slip.customerName, y, measureFn)
    if (slip.customerPhone) {
      y = pushRow(cmds, '电话', slip.customerPhone, y, measureFn)
    }
    if (slip.customerAddress) {
      y = pushRow(cmds, '地址', slip.customerAddress, y, measureFn)
    }
    y += 8
    pushDash(cmds, y)
    y += 16
  }

  ;(slip.lines || []).forEach(function (line) {
    const names = wrapText(line.productName, nameWidth, function (text) {
      return measureFn(text, FONT.name)
    })
    names.forEach(function (name, index) {
      pushText(cmds, name, PAD, y, FONT.name, COLORS.value)
      if (index === 0) {
        pushText(cmds, '¥' + line.amountText, right, y, FONT.name, COLORS.value, 'right')
      }
      y += 36
    })
    const sub = (line.specText ? line.specText + ' · ' : '') + line.qtyText + ' 件 × ¥' + line.priceText
    wrapText(sub, nameWidth, function (text) {
      return measureFn(text, FONT.muted)
    }).forEach(function (row) {
      pushText(cmds, row, PAD, y, FONT.muted, COLORS.muted)
      y += 30
    })
    y += 10
  })

  pushDash(cmds, y)
  y += 12

  if (slip.remark) {
    y = pushRow(cmds, '备注', slip.remark, y, measureFn)
  }
  y = pushRow(cmds, '结算', slip.payText, y, measureFn)
  y += 8
  pushDash(cmds, y)
  y += 24
  pushText(cmds, '金额', PAD, y, FONT.muted, COLORS.muted)
  pushText(cmds, '¥' + slip.amountText, right, y, FONT.amount, COLORS.title, 'right')
  y += 52

  if (slip.hasCustomer) {
    y = pushRow(cmds, '之前欠款', '¥' + slip.prevDebtText, y, measureFn)
    y = pushRow(cmds, '本次欠款', '¥' + slip.thisDebtText, y, measureFn)
    y += 8
    pushDash(cmds, y)
    y += 20
    pushText(cmds, '累计欠款', PAD, y, FONT.muted, COLORS.muted)
    pushText(cmds, '¥' + slip.receivableText, right, y, FONT.debt, slip.hasDebt ? COLORS.debt : COLORS.kicker, 'right')
    y += 48
  }

  return {
    width: WIDTH,
    height: y + PAD,
    commands: cmds
  }
}

function drawSlip(ctx, layout) {
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.textBaseline = 'top'
  layout.commands.forEach(function (cmd) {
    if (cmd.type === 'text') {
      ctx.font = cmd.font
      ctx.fillStyle = cmd.color
      ctx.textAlign = cmd.align
      ctx.fillText(cmd.text, cmd.x, cmd.y)
    } else if (cmd.type === 'dash') {
      ctx.save()
      ctx.strokeStyle = COLORS.line
      ctx.lineWidth = 2
      ctx.setLineDash([8, 8])
      ctx.beginPath()
      ctx.moveTo(cmd.x1, cmd.y)
      ctx.lineTo(cmd.x2, cmd.y)
      ctx.stroke()
      ctx.restore()
    }
  })
}

function getPixelRatio() {
  try {
    if (typeof wx !== 'undefined' && wx.getWindowInfo) {
      return Math.min(wx.getWindowInfo().pixelRatio || 2, 3)
    }
  } catch (error) {}
  try {
    if (typeof wx !== 'undefined' && wx.getSystemInfoSync) {
      return Math.min(wx.getSystemInfoSync().pixelRatio || 2, 3)
    }
  } catch (error) {}
  return 2
}

function makeMeasure(ctx) {
  if (!ctx || !ctx.measureText) return estimateWidth
  return function (text, font) {
    ctx.font = font
    return ctx.measureText(String(text || '')).width
  }
}

function createOffscreen(width, height) {
  if (typeof wx === 'undefined' || !wx.createOffscreenCanvas) return null
  try {
    return wx.createOffscreenCanvas({
      type: '2d',
      width: width,
      height: height
    })
  } catch (error) {
    return null
  }
}

function queryPageCanvas(page, width, height) {
  return new Promise(function (resolve, reject) {
    wx.createSelectorQuery()
      .in(page)
      .select('#slipCanvas')
      .fields({ node: true, size: true })
      .exec(function (res) {
        const canvas = res && res[0] && res[0].node
        if (!canvas) {
          reject(new Error('无法生成图片'))
          return
        }
        canvas.width = width
        canvas.height = height
        resolve(canvas)
      })
  })
}

function canvasToFile(canvas, destWidth, destHeight) {
  return new Promise(function (resolve, reject) {
    wx.canvasToTempFilePath({
      canvas: canvas,
      fileType: 'png',
      quality: 1,
      destWidth: destWidth,
      destHeight: destHeight,
      success: function (res) {
        resolve(res.tempFilePath)
      },
      fail: function (error) {
        reject(new Error((error && error.errMsg) || '导出失败'))
      }
    })
  })
}

function exportToTempFile(page, slip) {
  const probe = createOffscreen(16, 16)
  const measure = makeMeasure(probe && probe.getContext ? probe.getContext('2d') : null)
  const layout = layoutSlip(slip, measure)
  const dpr = getPixelRatio()
  const pixelWidth = Math.ceil(layout.width * dpr)
  const pixelHeight = Math.ceil(layout.height * dpr)
  const offscreen = createOffscreen(pixelWidth, pixelHeight)

  function paint(canvas) {
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    drawSlip(ctx, layout)
    return canvasToFile(canvas, pixelWidth, pixelHeight)
  }

  if (offscreen && offscreen.getContext) {
    return paint(offscreen).catch(function () {
      return queryPageCanvas(page, pixelWidth, pixelHeight).then(paint)
    })
  }
  return queryPageCanvas(page, pixelWidth, pixelHeight).then(paint)
}

function previewImage(filePath) {
  return new Promise(function (resolve, reject) {
    wx.previewImage({
      current: filePath,
      urls: [filePath],
      success: function () {
        resolve('preview')
      },
      fail: function (error) {
        reject(new Error((error && error.errMsg) || '无法打开图片'))
      }
    })
  })
}

function saveToAlbum(filePath) {
  return new Promise(function (resolve, reject) {
    wx.saveImageToPhotosAlbum({
      filePath: filePath,
      success: function () {
        resolve('saved')
      },
      fail: function (error) {
        const msg = (error && error.errMsg) || ''
        const denied = msg.indexOf('auth') >= 0 || msg.indexOf('deny') >= 0 || msg.indexOf('authorize') >= 0
        if (!denied) {
          reject(new Error(msg || '保存失败'))
          return
        }
        wx.showModal({
          title: '需要相册权限',
          content: '保存送货单到相册，才能发给客户或打印。',
          confirmText: '去设置',
          success: function (modal) {
            if (!modal.confirm) {
              reject(new Error('未授权相册'))
              return
            }
            wx.openSetting({
              success: function (setting) {
                if (!(setting.authSetting && setting.authSetting['scope.writePhotosAlbum'])) {
                  reject(new Error('未授权相册'))
                  return
                }
                wx.saveImageToPhotosAlbum({
                  filePath: filePath,
                  success: function () {
                    resolve('saved')
                  },
                  fail: function () {
                    reject(new Error('保存失败'))
                  }
                })
              },
              fail: function () {
                reject(new Error('未授权相册'))
              }
            })
          }
        })
      }
    })
  })
}

function openExportedImage(filePath) {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined') {
      reject(new Error('无法打开图片'))
      return
    }
    function fallback() {
      saveToAlbum(filePath).then(function () {
        wx.showToast({ title: '已保存到相册', icon: 'success' })
        return previewImage(filePath)
      }).then(resolve).catch(function () {
        previewImage(filePath).then(resolve).catch(reject)
      })
    }
    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: filePath,
        success: function () {
          resolve('share')
        },
        fail: function (error) {
          const msg = (error && error.errMsg) || ''
          if (msg.indexOf('cancel') >= 0) {
            resolve('cancel')
            return
          }
          fallback()
        }
      })
      return
    }
    fallback()
  })
}

module.exports = {
  WIDTH: WIDTH,
  FONT: FONT,
  estimateWidth: estimateWidth,
  wrapText: wrapText,
  layoutSlip: layoutSlip,
  drawSlip: drawSlip,
  exportToTempFile: exportToTempFile,
  openExportedImage: openExportedImage
}
