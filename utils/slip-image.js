const WIDTH = 1240
const PAD = 56
const COL = {
  seq: 80,
  qty: 120,
  price: 160,
  amount: 176
}

const COLORS = {
  bg: '#FFFFFF',
  title: '#111827',
  muted: '#6B7280',
  value: '#1F2937',
  line: '#4B5563',
  header: '#F3F4F6',
  total: '#FAFAFA',
  debt: '#C2410C',
  ok: '#0F766E'
}

const FONT = {
  kicker: '22px sans-serif',
  title: '700 44px sans-serif',
  meta: '22px sans-serif',
  value: '600 24px sans-serif',
  head: '600 22px sans-serif',
  name: '24px sans-serif',
  spec: '20px sans-serif',
  num: '24px sans-serif',
  total: '700 26px sans-serif',
  debt: '700 26px sans-serif',
  sign: '22px sans-serif'
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

function textTop(y, rowH, font) {
  return y + (rowH - parseFontSize(font)) / 2
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

function pushRect(cmds, x, y, w, h, fill) {
  cmds.push({ type: 'rect', x: x, y: y, w: w, h: h, fill: fill })
}

function pushLine(cmds, x1, y1, x2, y2, width) {
  cmds.push({
    type: 'line',
    x1: x1,
    y1: y1,
    x2: x2,
    y2: y2,
    width: width || 1,
    color: COLORS.line
  })
}

function pushStroke(cmds, x, y, w, h, width) {
  cmds.push({
    type: 'stroke',
    x: x,
    y: y,
    w: w,
    h: h,
    width: width || 1,
    color: COLORS.line
  })
}

function layoutLabeled(cmds, label, value, x, y, maxWidth, measure) {
  const prefix = label + '：'
  const prefixW = measure(prefix, FONT.meta)
  const inner = Math.max(48, maxWidth - prefixW)
  const lines = wrapText(String(value || ''), inner, function (text) {
    return measure(text, FONT.value)
  })
  const lineH = 32
  lines.forEach(function (line, index) {
    const top = y + index * lineH
    if (index === 0) {
      pushText(cmds, prefix, x, top, FONT.meta, COLORS.muted)
    }
    pushText(cmds, line, x + prefixW, top, FONT.value, COLORS.value)
  })
  return y + Math.max(lineH, lines.length * lineH) + 6
}

function tableColumns() {
  const contentWidth = WIDTH - PAD * 2
  const nameW = contentWidth - COL.seq - COL.qty - COL.price - COL.amount
  const xs = [
    PAD,
    PAD + COL.seq,
    PAD + COL.seq + nameW,
    PAD + COL.seq + nameW + COL.qty,
    PAD + COL.seq + nameW + COL.qty + COL.price,
    WIDTH - PAD
  ]
  return { contentWidth: contentWidth, nameW: nameW, xs: xs }
}

function layoutMeta(cmds, slip, y, measure) {
  const contentWidth = WIDTH - PAD * 2
  if (!slip.hasCustomer) {
    const third = contentWidth / 3
    layoutLabeled(cmds, '单号', slip.docNo, PAD, y, third, measure)
    layoutLabeled(cmds, '日期', slip.timeText, PAD + third, y, third, measure)
    return layoutLabeled(cmds, '结算', slip.payText, PAD + third * 2, y, third, measure) + 12
  }
  const colW = (contentWidth - 48) / 2
  const rightX = PAD + colW + 48
  let leftY = y
  let rightY = y
  leftY = layoutLabeled(cmds, '收货人', slip.customerName, PAD, leftY, colW, measure)
  if (slip.customerPhone) {
    leftY = layoutLabeled(cmds, '电话', slip.customerPhone, PAD, leftY, colW, measure)
  }
  if (slip.customerAddress) {
    leftY = layoutLabeled(cmds, '地址', slip.customerAddress, PAD, leftY, colW, measure)
  }
  rightY = layoutLabeled(cmds, '单号', slip.docNo, rightX, rightY, colW, measure)
  rightY = layoutLabeled(cmds, '日期', slip.timeText, rightX, rightY, colW, measure)
  rightY = layoutLabeled(cmds, '结算', slip.payText, rightX, rightY, colW, measure)
  return Math.max(leftY, rightY) + 12
}

function layoutTable(cmds, slip, y, measure) {
  const padX = 12
  const headerH = 46
  const totalH = 50
  const nameLineH = 30
  const specLineH = 24
  const cols = tableColumns()
  const xs = cols.xs
  const rows = (slip.lines || []).map(function (line) {
    const inner = cols.nameW - padX * 2
    const names = wrapText(line.productName, inner, function (text) {
      return measure(text, FONT.name)
    })
    const specs = line.specText
      ? wrapText(line.specText, inner, function (text) {
        return measure(text, FONT.spec)
      })
      : []
    const blockH = names.length * nameLineH + specs.length * specLineH
    return {
      line: line,
      names: names,
      specs: specs,
      height: Math.max(52, 12 + blockH + 12)
    }
  })
  const tableTop = y
  const headerY = y
  y += headerH
  rows.forEach(function (row) {
    row.y = y
    y += row.height
  })
  const totalY = y
  y += totalH
  const tableH = y - tableTop

  pushRect(cmds, PAD, headerY, cols.contentWidth, headerH, COLORS.header)
  pushRect(cmds, PAD, totalY, cols.contentWidth, totalH, COLORS.total)
  pushStroke(cmds, PAD, tableTop, cols.contentWidth, tableH, 2)
  pushLine(cmds, PAD, headerY + headerH, WIDTH - PAD, headerY + headerH, 1)
  rows.forEach(function (row) {
    pushLine(cmds, PAD, row.y + row.height, WIDTH - PAD, row.y + row.height, 1)
  })
  xs.slice(1, -1).forEach(function (x) {
    pushLine(cmds, x, tableTop, x, y, 1)
  })

  const heads = [
    { text: '序号', x: (xs[0] + xs[1]) / 2, align: 'center' },
    { text: '品名', x: xs[1] + padX, align: 'left' },
    { text: '数量', x: (xs[2] + xs[3]) / 2, align: 'center' },
    { text: '单价', x: xs[4] - padX, align: 'right' },
    { text: '金额', x: xs[5] - padX, align: 'right' }
  ]
  heads.forEach(function (head) {
    pushText(cmds, head.text, head.x, textTop(headerY, headerH, FONT.head), FONT.head, COLORS.value, head.align)
  })

  rows.forEach(function (row, index) {
    const line = row.line
    const blockH = row.names.length * nameLineH + row.specs.length * specLineH
    let nameY = row.y + (row.height - blockH) / 2
    pushText(cmds, String(index + 1), (xs[0] + xs[1]) / 2, textTop(row.y, row.height, FONT.num), FONT.num, COLORS.value, 'center')
    row.names.forEach(function (name) {
      pushText(cmds, name, xs[1] + padX, nameY, FONT.name, COLORS.value)
      nameY += nameLineH
    })
    row.specs.forEach(function (spec) {
      pushText(cmds, spec, xs[1] + padX, nameY, FONT.spec, COLORS.muted)
      nameY += specLineH
    })
    pushText(cmds, line.qtyText, (xs[2] + xs[3]) / 2, textTop(row.y, row.height, FONT.num), FONT.num, COLORS.value, 'center')
    pushText(cmds, line.priceText, xs[4] - padX, textTop(row.y, row.height, FONT.num), FONT.num, COLORS.value, 'right')
    pushText(cmds, line.amountText, xs[5] - padX, textTop(row.y, row.height, FONT.num), FONT.num, COLORS.value, 'right')
  })

  pushText(cmds, '合计', xs[1] + padX, textTop(totalY, totalH, FONT.total), FONT.total, COLORS.title)
  pushText(cmds, '¥' + slip.amountText, xs[5] - padX, textTop(totalY, totalH, FONT.total), FONT.total, COLORS.title, 'right')
  return y + 18
}

function layoutDebt(cmds, slip, y) {
  const contentWidth = WIDTH - PAD * 2
  const colW = contentWidth / 3
  const headH = 40
  const valH = 48
  const top = y
  const height = headH + valH
  pushRect(cmds, PAD, top, contentWidth, headH, COLORS.header)
  pushStroke(cmds, PAD, top, contentWidth, height, 1)
  pushLine(cmds, PAD, top + headH, WIDTH - PAD, top + headH, 1)
  pushLine(cmds, PAD + colW, top, PAD + colW, top + height, 1)
  pushLine(cmds, PAD + colW * 2, top, PAD + colW * 2, top + height, 1)
  const labels = ['之前欠款', '本次欠款', '累计欠款']
  const values = [
    '¥' + slip.prevDebtText,
    '¥' + slip.thisDebtText,
    '¥' + slip.receivableText
  ]
  const valueColors = [
    COLORS.value,
    COLORS.value,
    slip.hasDebt ? COLORS.debt : COLORS.ok
  ]
  labels.forEach(function (label, index) {
    const cx = PAD + colW * index + colW / 2
    pushText(cmds, label, cx, textTop(top, headH, FONT.head), FONT.head, COLORS.muted, 'center')
    pushText(cmds, values[index], cx, textTop(top + headH, valH, FONT.debt), FONT.debt, valueColors[index], 'center')
  })
  return top + height + 16
}

function layoutSign(cmds, y) {
  pushText(cmds, '客户签收：', PAD, y, FONT.sign, COLORS.muted)
  const lineX = PAD + 110
  pushLine(cmds, lineX, y + 22, lineX + 320, y + 22, 1)
  return y + 40
}

function layoutSlip(slip, measure) {
  // 预览弹层仍是手机竖向卡片；导出画成表格单据，方便发给客户或打印。
  const measureFn = measure || estimateWidth
  const cmds = []
  let y = PAD

  pushText(cmds, '送货单', WIDTH / 2, y, FONT.title, COLORS.title, 'center')
  y += 54
  pushText(cmds, '请核对后签收', WIDTH / 2, y, FONT.kicker, COLORS.muted, 'center')
  y += 36
  pushLine(cmds, PAD, y, WIDTH - PAD, y, 2)
  y += 5
  pushLine(cmds, PAD, y, WIDTH - PAD, y, 1)
  y += 22

  y = layoutMeta(cmds, slip, y, measureFn)
  y = layoutTable(cmds, slip, y, measureFn)

  if (slip.remark) {
    y = layoutLabeled(cmds, '备注', slip.remark, PAD, y, WIDTH - PAD * 2, measureFn) + 8
  }
  if (slip.hasCustomer) {
    y = layoutDebt(cmds, slip, y)
  }
  y = layoutSign(cmds, y + 8)

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
    } else if (cmd.type === 'rect') {
      ctx.fillStyle = cmd.fill
      ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h)
    } else if (cmd.type === 'stroke') {
      ctx.save()
      ctx.strokeStyle = cmd.color
      ctx.lineWidth = cmd.width || 1
      if (ctx.setLineDash) ctx.setLineDash([])
      ctx.strokeRect(cmd.x, cmd.y, cmd.w, cmd.h)
      ctx.restore()
    } else if (cmd.type === 'line') {
      ctx.save()
      ctx.strokeStyle = cmd.color
      ctx.lineWidth = cmd.width || 1
      if (ctx.setLineDash) ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(cmd.x1, cmd.y1)
      ctx.lineTo(cmd.x2, cmd.y2)
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
