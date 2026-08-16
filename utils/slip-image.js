const WIDTH = 1760
const PAD = 48
const LINE_H = 28
const CELL_PAD_X = 12
const CELL_PAD_Y = 10

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

function skuText(line) {
  const sku = line && line.sku ? String(line.sku) : ''
  return sku === '未填' ? '' : sku
}

function qtyTotalText(lines) {
  const total = (lines || []).reduce(function (sum, line) {
    const n = Number(line.qtyText)
    return sum + (isFinite(n) ? n : 0)
  }, 0)
  if (Math.round(total) === total) return String(total)
  return String(Math.round(total * 100) / 100)
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

function specAxisNames(lines) {
  const names = []
  let unnamed = false
  ;(lines || []).forEach(function (line) {
    const parts = line.specParts
    if (parts && parts.length) {
      parts.forEach(function (part) {
        if (!part || !part.value) return
        if (part.name) {
          if (names.indexOf(part.name) < 0) names.push(part.name)
        } else {
          unnamed = true
        }
      })
      return
    }
    if (line.specText) unnamed = true
  })
  if (unnamed && names.indexOf('规格') < 0) names.push('规格')
  return names
}

function specCellValue(line, axisName) {
  const parts = line.specParts
  if (parts && parts.length) {
    const hits = parts.filter(function (part) {
      if (!part || !part.value) return false
      if (part.name) return part.name === axisName
      return axisName === '规格'
    })
    return hits.map(function (part) {
      return part.value
    }).join(' · ')
  }
  if (axisName === '规格') return line.specText || ''
  return ''
}

function specColWidth(count) {
  if (count <= 1) return 280
  if (count === 2) return 200
  return 150
}

function tableColumns(slip) {
  const contentWidth = WIDTH - PAD * 2
  const axes = specAxisNames(slip && slip.lines)
  const specWidth = specColWidth(axes.length)
  const defs = [
    { key: 'seq', title: '序号', width: 68, align: 'center', font: FONT.num },
    { key: 'sku', title: '货号', width: axes.length >= 3 ? 160 : 200, align: 'left', font: FONT.num },
    { key: 'name', title: '品名', width: 0, align: 'left', font: FONT.name }
  ]
  axes.forEach(function (name) {
    defs.push({
      key: 'spec:' + name,
      title: name,
      width: specWidth,
      align: 'left',
      font: FONT.name
    })
  })
  defs.push(
    { key: 'qty', title: '数量', width: 100, align: 'center', font: FONT.num },
    { key: 'price', title: '单价', width: 140, align: 'right', font: FONT.num },
    { key: 'amount', title: '金额', width: 156, align: 'right', font: FONT.num }
  )
  const used = defs.reduce(function (sum, col) {
    return sum + col.width
  }, 0)
  let x = PAD
  defs.forEach(function (col) {
    if (!col.width) col.width = contentWidth - used
    col.x = x
    x += col.width
  })
  return { defs: defs, contentWidth: contentWidth }
}

function colByKey(cols, key) {
  return cols.defs.find(function (col) {
    return col.key === key
  })
}

function cellX(col) {
  if (col.align === 'right') return col.x + col.width - CELL_PAD_X
  if (col.align === 'center') return col.x + col.width / 2
  return col.x + CELL_PAD_X
}

function wrapCell(text, col, measure) {
  const str = String(text || '')
  if (!str) return []
  const inner = Math.max(24, col.width - CELL_PAD_X * 2)
  return wrapText(str, inner, function (line) {
    return measure(line, col.font)
  })
}

function layoutMeta(cmds, slip, y, measure) {
  const contentWidth = WIDTH - PAD * 2
  const gap = 28
  const colW = (contentWidth - gap * 2) / 3
  const x2 = PAD + colW + gap
  const x3 = PAD + (colW + gap) * 2
  if (!slip.hasCustomer) {
    layoutLabeled(cmds, '单号', slip.docNo, PAD, y, colW, measure)
    layoutLabeled(cmds, '日期', slip.timeText, x2, y, colW, measure)
    return layoutLabeled(cmds, '结算', slip.payText, x3, y, colW, measure) + 8
  }
  const row1 = Math.max(
    layoutLabeled(cmds, '收货人', slip.customerName, PAD, y, colW, measure),
    layoutLabeled(cmds, '电话', slip.customerPhone, x2, y, colW, measure),
    layoutLabeled(cmds, '单号', slip.docNo, x3, y, colW, measure)
  )
  const row2 = Math.max(
    layoutLabeled(cmds, '地址', slip.customerAddress, PAD, row1, colW, measure),
    layoutLabeled(cmds, '结算', slip.payText, x2, row1, colW, measure),
    layoutLabeled(cmds, '日期', slip.timeText, x3, row1, colW, measure)
  )
  return row2 + 8
}

function layoutTable(cmds, slip, y, measure) {
  const headerH = 42
  const totalH = 48
  const cols = tableColumns(slip)
  const defs = cols.defs
  const lines = slip.lines || []
  const axes = specAxisNames(lines)
  const rows = lines.map(function (line, index) {
    const cells = {
      seq: [String(index + 1)],
      sku: wrapCell(skuText(line), colByKey(cols, 'sku'), measure),
      name: wrapCell(line.productName, colByKey(cols, 'name'), measure),
      qty: [line.qtyText],
      price: [line.priceText],
      amount: [line.amountText]
    }
    axes.forEach(function (name) {
      cells['spec:' + name] = wrapCell(specCellValue(line, name), colByKey(cols, 'spec:' + name), measure)
    })
    const lineCount = defs.reduce(function (max, col) {
      return Math.max(max, (cells[col.key] || []).length)
    }, 1)
    return {
      cells: cells,
      height: Math.max(44, CELL_PAD_Y * 2 + lineCount * LINE_H)
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
  const tableRight = WIDTH - PAD

  pushRect(cmds, PAD, headerY, cols.contentWidth, headerH, COLORS.header)
  pushRect(cmds, PAD, totalY, cols.contentWidth, totalH, COLORS.total)
  pushStroke(cmds, PAD, tableTop, cols.contentWidth, tableH, 2)
  pushLine(cmds, PAD, headerY + headerH, tableRight, headerY + headerH, 1)
  rows.forEach(function (row) {
    pushLine(cmds, PAD, row.y + row.height, tableRight, row.y + row.height, 1)
  })
  defs.slice(1).forEach(function (col) {
    pushLine(cmds, col.x, tableTop, col.x, y, 1)
  })

  defs.forEach(function (col) {
    pushText(cmds, col.title, cellX(col), textTop(headerY, headerH, FONT.head), FONT.head, COLORS.value, col.align)
  })

  rows.forEach(function (row) {
    defs.forEach(function (col) {
      const texts = row.cells[col.key] || []
      const blockH = texts.length * LINE_H
      let ty = row.y + (row.height - blockH) / 2
      texts.forEach(function (line) {
        pushText(cmds, line, cellX(col), ty, col.font, COLORS.value, col.align)
        ty += LINE_H
      })
    })
  })

  const nameCol = colByKey(cols, 'name')
  const qtyCol = colByKey(cols, 'qty')
  const amountCol = colByKey(cols, 'amount')
  pushText(cmds, '合计', cellX(nameCol), textTop(totalY, totalH, FONT.total), FONT.total, COLORS.title, nameCol.align)
  pushText(cmds, qtyTotalText(lines), cellX(qtyCol), textTop(totalY, totalH, FONT.total), FONT.total, COLORS.title, qtyCol.align)
  pushText(cmds, '¥' + slip.amountText, cellX(amountCol), textTop(totalY, totalH, FONT.total), FONT.total, COLORS.title, amountCol.align)
  return y + 16
}

function layoutDebt(cmds, slip, x, y, boxW) {
  const rows = [
    { label: '之前欠款', value: '¥' + slip.prevDebtText, color: COLORS.value },
    { label: '本次欠款', value: '¥' + slip.thisDebtText, color: COLORS.value },
    { label: '累计欠款', value: '¥' + slip.receivableText, color: slip.hasDebt ? COLORS.debt : COLORS.ok }
  ]
  const rowH = 40
  const height = rowH * rows.length
  pushRect(cmds, x, y + rowH * 2, boxW, rowH, COLORS.total)
  pushStroke(cmds, x, y, boxW, height, 1)
  rows.forEach(function (row, index) {
    if (index) pushLine(cmds, x, y + rowH * index, x + boxW, y + rowH * index, 1)
    const font = index === 2 ? FONT.debt : FONT.value
    pushText(cmds, row.label, x + 14, textTop(y + rowH * index, rowH, FONT.head), FONT.head, COLORS.muted)
    pushText(cmds, row.value, x + boxW - 14, textTop(y + rowH * index, rowH, font), font, row.color, 'right')
  })
  return y + height
}

function layoutSign(cmds, y) {
  pushText(cmds, '客户签收：', PAD, y, FONT.sign, COLORS.muted)
  const lineX = PAD + 110
  pushLine(cmds, lineX, y + 22, lineX + 360, y + 22, 1)
  return y + 36
}

function layoutFooter(cmds, slip, y, measure) {
  let next = y
  if (slip.remark) {
    next = layoutLabeled(cmds, '备注', slip.remark, PAD, y, WIDTH - PAD * 2, measure) + 8
  }
  const signY = next + 12
  layoutSign(cmds, signY)
  if (slip.hasCustomer) {
    const boxW = 420
    const debtY = layoutDebt(cmds, slip, WIDTH - PAD - boxW, next, boxW)
    return Math.max(signY + 36, debtY) + 8
  }
  return signY + 36
}

function layoutSlip(slip, measure) {
  // 预览弹层仍是手机竖向卡片；导出用横向表格，规格按本单出现的轴名分列。
  const measureFn = measure || estimateWidth
  const cmds = []
  let y = PAD

  pushText(cmds, '送货单', WIDTH / 2, y, FONT.title, COLORS.title, 'center')
  y += 50
  pushText(cmds, '请核对后签收', WIDTH / 2, y, FONT.kicker, COLORS.muted, 'center')
  y += 32
  pushLine(cmds, PAD, y, WIDTH - PAD, y, 2)
  y += 5
  pushLine(cmds, PAD, y, WIDTH - PAD, y, 1)
  y += 18

  y = layoutMeta(cmds, slip, y, measureFn)
  y = layoutTable(cmds, slip, y, measureFn)
  y = layoutFooter(cmds, slip, y, measureFn)

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
  specAxisNames: specAxisNames,
  wrapText: wrapText,
  layoutSlip: layoutSlip,
  drawSlip: drawSlip,
  exportToTempFile: exportToTempFile,
  openExportedImage: openExportedImage
}
