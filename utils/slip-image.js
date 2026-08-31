// 送货单是给客户看的，客户多为中老年。导出图在手机上按宽度铺满，字的观感由「字号 ÷ 画布宽」
// 决定，高度不进这个式子。所以放大字号的前提是收窄画布：列宽改成按本单内容量出来，不再写死。
const WIDTH = 1700
const PAD = 36
const LINE_H = 65
const CELL_PAD_X = 24
const CELL_PAD_Y = 23

// 品名列吸收各单差异，最窄留三个中文字，再长就在单元格内折行，不缩字号。
const NAME_MIN_CHARS = 3

// 规格轴超过这个数就并成一列。每多一轴至少多占三个中文字，画布被撑宽、整张单的字跟着挤小；
// 并成一列只是这一格折行，比全单字号缩水划算。
// 定在 2 而不是 3：颜色+尺码是绝大多数单据的形态，保持分列；三轴分列会占到 648，
// 比合并后的 216 宽出一大截，字号反而比四轴还小，所以三轴起就合并。
const SPEC_AXIS_LIMIT = 2

// 列宽按量出来的字宽定，但真机字体和估算值有出入，留一点余量，免得货号顶出格线。
const MEASURE_SLACK = 1.04

// 画布高度至少是宽度的这个倍数。内容不够高就在表格和汇总区之间补白，把手机预览的上下黑边压一压；
// 再往上调黑边会更少，但补出来的空白也更显眼。
const MIN_HEIGHT_RATIO = 1.15

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

// 括号里是 1550 宽画布在 390pt 宽手机上铺满时的观感字号，按 18px 正文的适老化线来对。
const FONT = {
  kicker: '51px sans-serif',           // 12.8pt 请核对后签收
  title: '700 88px sans-serif',        // 22.1pt 店名
  meta: '51px sans-serif',             // 12.8pt 收货人/单号这类标签
  value: '600 59px sans-serif',        // 14.8pt 上面这些标签对应的值
  head: '600 51px sans-serif',         // 12.8pt 表头
  name: '56px sans-serif',             // 14.1pt 品名、规格
  num: '56px sans-serif',              // 14.1pt 货号、数量、单价、金额
  total: '700 80px sans-serif',        // 20.1pt 合计，客户最想看清的数
  debt: '700 64px sans-serif',         // 16.1pt 结算盒主行的值
  small: '48px sans-serif',            // 12.1pt 往来欠款那一行
  smallStrong: '700 56px sans-serif'   // 14.1pt 累计欠款，小字里唯一要跳出来的
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

function scaleFont(font, size) {
  const m = String(font).match(/^(\d+\s+)?\d+px\s+(.+)$/)
  return m ? (m[1] || '') + size + 'px ' + m[2] : font
}

// 金额可能到百万甚至千万，格子塞不下就一档档降字号，宁可小一点也不让数字出界。
function fitFont(text, font, maxWidth, measure) {
  const base = parseFontSize(font)
  for (let size = base; size > 36; size -= 4) {
    const candidate = scaleFont(font, size)
    if (measure(text, candidate) <= maxWidth) return candidate
  }
  return scaleFont(font, 36)
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

function labelWidth(labels, measure) {
  let widest = 0
  labels.forEach(function (label) {
    widest = Math.max(widest, measure(label + '：', FONT.meta))
  })
  return Math.ceil(widest) + 12
}

function layoutLabeled(cmds, label, value, x, y, maxWidth, measure, prefixWidth) {
  const prefix = label + '：'
  const prefixW = prefixWidth || measure(prefix, FONT.meta)
  const inner = Math.max(112, maxWidth - prefixW)
  const lines = wrapText(String(value || ''), inner, function (text) {
    return measure(text, FONT.value)
  })
  const lineH = 80
  lines.forEach(function (line, index) {
    const top = y + index * lineH
    if (index === 0) {
      pushText(cmds, prefix, x, top, FONT.meta, COLORS.muted)
    }
    pushText(cmds, line, x + prefixW, top, FONT.value, COLORS.value)
  })
  return y + Math.max(lineH, lines.length * lineH) + 14
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

function canWrapColumn(col) {
  // 数量、单价、金额折行会被看错，品名/货号/规格折行只是变矮一点。
  return col.key === 'name' || col.key === 'sku' || col.key.indexOf('spec:') === 0
}

function floorWidth(col, measure) {
  return Math.ceil(measure('汉'.repeat(NAME_MIN_CHARS), col.font)) + CELL_PAD_X * 2
}

function columnValues(lines, key, axisName) {
  if (key === 'sku') return lines.map(skuText)
  if (key === 'spec') {
    return lines.map(function (line) {
      return specCellValue(line, axisName)
    })
  }
  return lines.map(function (line) {
    return line[key]
  })
}

function mergedSpecValues(lines, axes) {
  return lines.map(function (line) {
    return axes.map(function (name) {
      return specCellValue(line, name)
    }).filter(function (value) {
      return value
    }).join(' · ')
  })
}

function tableColumns(slip, measure) {
  const lines = (slip && slip.lines) || []
  const axes = specAxisNames(lines)
  const defs = [
    { key: 'sku', title: '货号', align: 'center', font: FONT.num, values: columnValues(lines, 'sku') },
    { key: 'name', title: '品名', align: 'left', font: FONT.name, values: columnValues(lines, 'productName') }
  ]
  if (axes.length > SPEC_AXIS_LIMIT) {
    defs.push({
      key: 'spec:*',
      title: '规格',
      align: 'left',
      font: FONT.name,
      values: mergedSpecValues(lines, axes)
    })
  } else {
    axes.forEach(function (name) {
      defs.push({
        key: 'spec:' + name,
        title: name,
        align: 'center',
        font: FONT.name,
        values: columnValues(lines, 'spec', name)
      })
    })
  }
  defs.push(
    { key: 'qty', title: '数量', align: 'center', font: FONT.num, values: columnValues(lines, 'qtyText') },
    { key: 'price', title: '单价', align: 'right', font: FONT.num, values: columnValues(lines, 'priceText') },
    { key: 'amount', title: '金额', align: 'right', font: FONT.num, values: columnValues(lines, 'amountText') }
  )

  // 表头和本单每一行都量一遍，取最宽的那个，谁也不多占。
  defs.forEach(function (col) {
    let need = measure(col.title, FONT.head)
    col.values.forEach(function (value) {
      need = Math.max(need, measure(value == null ? '' : String(value), col.font))
    })
    col.width = Math.ceil(need * MEASURE_SLACK) + CELL_PAD_X * 2
  })

  return { defs: defs, natural: defs.reduce(function (sum, col) {
    return sum + col.width
  }, 0) }
}

// 把量出来的列塞进给定宽度：有富余就全给品名，不够就压可折行的列，压到底还不够才让画布变宽。
function fitColumns(cols, pageWidth, measure) {
  const defs = cols.defs
  const contentWidth = pageWidth - PAD * 2
  let over = cols.natural - contentWidth
  if (over <= 0) {
    const nameCol = defs.find(function (col) {
      return col.key === 'name'
    })
    if (nameCol) nameCol.width -= over
  } else {
    defs.forEach(function (col) {
      if (over <= 0 || !canWrapColumn(col)) return
      const room = col.width - floorWidth(col, measure)
      if (room <= 0) return
      const cut = Math.min(room, over)
      col.width -= cut
      over -= cut
    })
  }
  let x = PAD
  defs.forEach(function (col) {
    col.x = x
    x += col.width
  })
  return { defs: defs, contentWidth: x - PAD, pageWidth: Math.max(pageWidth, x + PAD) }
}

// 四五根规格轴时连折行都救不回来，这时画布变宽保信息完整，字号不动。
function pageWidthFor(cols, measure) {
  const floor = cols.defs.reduce(function (sum, col) {
    return sum + (canWrapColumn(col) ? floorWidth(col, measure) : col.width)
  }, 0)
  return Math.max(WIDTH, floor + PAD * 2)
}

function shiftCommands(cmds, dy) {
  cmds.forEach(function (cmd) {
    if (cmd.type === 'line') {
      cmd.y1 += dy
      cmd.y2 += dy
    } else {
      cmd.y += dy
    }
  })
  return cmds
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

// 三列改两列：单号和日期这类长字符串在三列里逼得字号上不去，两列才放得开。
function layoutMeta(cmds, slip, pageWidth, y, measure) {
  const contentWidth = pageWidth - PAD * 2
  const gap = 48
  const colW = (contentWidth - gap) / 2
  const x2 = PAD + colW + gap
  // 两列共用一个标签宽度，值才会左边缘对齐；各算各的会参差出来。
  // 结算方式已并进底部的应收/实收，这里剩六个字段正好铺满三行，谁也不用单独占一行。
  const lw = labelWidth(slip.hasCustomer
    ? ['收货人', '电话', '地址', '单号', '日期', '经手人']
    : ['单号', '日期', '经手人'], measure)
  if (!slip.hasCustomer) {
    const row1 = Math.max(
      layoutLabeled(cmds, '单号', slip.docNo, PAD, y, colW, measure, lw),
      layoutLabeled(cmds, '日期', slip.timeText, x2, y, colW, measure, lw)
    )
    return layoutLabeled(cmds, '经手人', slip.operatorText || '—', PAD, row1, colW, measure, lw) + 18
  }
  const row1 = Math.max(
    layoutLabeled(cmds, '收货人', slip.customerName, PAD, y, colW, measure, lw),
    layoutLabeled(cmds, '电话', slip.customerPhone, x2, y, colW, measure, lw)
  )
  const row2 = Math.max(
    layoutLabeled(cmds, '地址', slip.customerAddress, PAD, row1, colW, measure, lw),
    layoutLabeled(cmds, '单号', slip.docNo, x2, row1, colW, measure, lw)
  )
  return Math.max(
    layoutLabeled(cmds, '日期', slip.timeText, PAD, row2, colW, measure, lw),
    layoutLabeled(cmds, '经手人', slip.operatorText || '—', x2, row2, colW, measure, lw)
  ) + 18
}

function layoutTable(cmds, slip, cols, y, measure) {
  const headerH = 98
  const defs = cols.defs
  const lines = slip.lines || []
  const rows = lines.map(function (line, index) {
    const cells = {}
    defs.forEach(function (col) {
      const raw = col.values[index]
      cells[col.key] = canWrapColumn(col)
        ? wrapCell(raw, col, measure)
        : [raw == null ? '' : String(raw)]
    })
    const lineCount = defs.reduce(function (max, col) {
      return Math.max(max, (cells[col.key] || []).length)
    }, 1)
    return {
      cells: cells,
      height: Math.max(103, CELL_PAD_Y * 2 + lineCount * LINE_H)
    }
  })
  const tableTop = y
  const headerY = y
  y += headerH
  rows.forEach(function (row) {
    row.y = y
    y += row.height
  })
  const tableH = y - tableTop
  const tableRight = PAD + cols.contentWidth

  pushRect(cmds, PAD, headerY, cols.contentWidth, headerH, COLORS.header)
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

  return y + 24
}

// 合计搬出表格：金额列原本被合计的 ¥1582.00 撑着，明细行最长才 495.00。搬出来这列窄一截，
// 画布跟着窄，字号就能再大一点；合计本身也不再受列宽约束，可以用最大的字。
function summaryRows(slip) {
  // 结算方式去掉了：应收 1582 / 实收 0 已经把赊账说清楚，再写一遍是废话。
  const rows = [
    { label: '总数', value: qtyTotalText(slip.lines) + ' 件' },
    { label: '应收', value: '¥' + slip.dueText },
    { label: '实收', value: '¥' + slip.paidText }
  ]
  // 【G1】抵了预收才多这一格。没抵的单子（含全部老单）格数与改动前逐字相同，
  // 所以 tests/slip-image.test.js 那批静态钉子一条都不动。
  // 布局不用跟着改：layoutSummary 的 cellW = boxW / main.length 是现算的，
  // 多一格自己会窄，数字宽度由 fitFont 兜住。
  if (slip.hasPrepayUsed) {
    rows.push({ label: '预收抵扣', value: '¥' + slip.prepayUsedText })
  }
  return rows
}

function debtRow(slip) {
  if (!slip.hasCustomer) return null
  return [
    { label: '之前欠款', value: '¥' + slip.prevDebtText, color: COLORS.value, font: FONT.small },
    { label: '本次欠款', value: '¥' + slip.thisDebtText, color: COLORS.value, font: FONT.small },
    { label: '累计欠款', value: '¥' + slip.receivableText, color: slip.hasDebt ? COLORS.debt : COLORS.ok, font: FONT.smallStrong }
  ]
}

const SUMMARY_MAIN_H = 200
const SUMMARY_DEBT_H = 96

function debtSpan(item, measure) {
  return Math.ceil(measure(item.label, FONT.small)) + 12 + Math.ceil(measure(item.value, item.font))
}

function drawDebtLine(cmds, items, x, y, measure) {
  let dx = x
  items.forEach(function (item) {
    pushText(cmds, item.label, dx, textTop(y, SUMMARY_DEBT_H, FONT.small), FONT.small, COLORS.muted)
    dx += Math.ceil(measure(item.label, FONT.small)) + 12
    pushText(cmds, item.value, dx, textTop(y, SUMMARY_DEBT_H, item.font), item.font, item.color)
    dx += Math.ceil(measure(item.value, item.font)) + 56
  })
}

// 合计和结算并成一块。不套完整边框：货物表格已经是个框了，再画一个会显得堆在一起，
// 这里改成浅底加上下两条线，视觉上是表格的收尾而不是第二张表。
function layoutSummary(cmds, slip, x, y, boxW, measure) {
  const main = summaryRows(slip)
  const debts = debtRow(slip)
  const room = boxW - 64
  // 欠款三项优先挤一行，千万级数字放不下就让累计欠款独占第二行（它最该被看见）。
  let debtLines = []
  if (debts) {
    const spans = debts.map(function (item) {
      return debtSpan(item, measure)
    })
    const oneLine = spans.reduce(function (a, b) {
      return a + b
    }, 0) + 56 * (debts.length - 1)
    debtLines = oneLine <= room ? [debts] : [debts.slice(0, 2), debts.slice(2)]
  }
  const height = SUMMARY_MAIN_H + SUMMARY_DEBT_H * debtLines.length
  pushRect(cmds, x, y, boxW, height, COLORS.total)
  pushLine(cmds, x, y, x + boxW, y, 3)
  pushLine(cmds, x, y + height, x + boxW, y + height, 3)

  const cellW = boxW / main.length
  main.forEach(function (item, index) {
    const cx = x + cellW * index + 32
    pushText(cmds, item.label, cx, y + 30, FONT.head, COLORS.muted)
    pushText(cmds, item.value, cx, y + 96, fitFont(item.value, FONT.total, cellW - 64, measure), COLORS.title)
  })

  let dy = y + SUMMARY_MAIN_H
  debtLines.forEach(function (items, index) {
    if (index === 0) pushLine(cmds, x, dy, x + boxW, dy, 1)
    drawDebtLine(cmds, items, x + 32, dy, measure)
    dy += SUMMARY_DEBT_H
  })
  return y + height
}

function layoutFooter(cmds, slip, pageWidth, y, measure) {
  let next = y
  if (slip.remark) {
    next = layoutLabeled(cmds, '备注', slip.remark, PAD, y, pageWidth - PAD * 2, measure) + 18
  }
  return layoutSummary(cmds, slip, PAD, next, pageWidth - PAD * 2, measure) + 24
}

function layoutSlip(slip, measure, options) {
  // 预览弹层仍是手机竖向卡片；导出用横向表格，规格按本单出现的轴名分列。
  const measureFn = measure || estimateWidth
  const ratio = options && options.minHeightRatio != null ? options.minHeightRatio : MIN_HEIGHT_RATIO
  const raw = tableColumns(slip, measureFn)
  const pageWidth = pageWidthFor(raw, measureFn)
  const cols = fitColumns(raw, pageWidth, measureFn)
  const cmds = []
  let y = PAD
  const shopName = String(slip.shopName || '').trim()

  // 抬头只留店名。没填店名才用「送货单」兜底，否则单据连个标题都没有。
  pushText(cmds, shopName || '送货单', pageWidth / 2, y, FONT.title, COLORS.title, 'center')
  y += 130
  pushLine(cmds, PAD, y, pageWidth - PAD, y, 3)
  y += 10
  pushLine(cmds, PAD, y, pageWidth - PAD, y, 1)
  y += 36

  y = layoutMeta(cmds, slip, pageWidth, y, measureFn)
  y = layoutTable(cmds, slip, cols, y, measureFn)

  // 签收和欠款先画在临时数组里量高，好把差的高度补成中间留白，把签收区压到底部。
  const footCmds = []
  const footH = layoutFooter(footCmds, slip, pageWidth, 0, measureFn)
  const contentHeight = y + footH + PAD
  const minHeight = Math.round(pageWidth * ratio)
  shiftCommands(footCmds, y + Math.max(0, minHeight - contentHeight))
  footCmds.forEach(function (cmd) {
    cmds.push(cmd)
  })

  return {
    width: pageWidth,
    height: Math.max(contentHeight, minHeight),
    contentHeight: contentHeight,
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

// 微信 canvas 2d 的单边上限各机型不同，常见 4096~16384，超了导出会失败或出白图。
// 货多的单子画布很高，这里按尺寸把倍率压下来；压到 1 还不够就整体缩小，
// 字会跟着变小，但总比导不出来强。
const MAX_CANVAS_PX = 16384
// 官方 Canvas 2D 文档写的最大宽高。只在前面几档都失败时才压到这个边，避免一上来就缩小适老化字号。
const CANVAS_2D_SAFE_PX = 1365

function exportRatio(width, height, pixelRatio) {
  const dpr = pixelRatio == null ? getPixelRatio() : pixelRatio
  const limit = Math.min(MAX_CANVAS_PX / width, MAX_CANVAS_PX / height)
  return Math.min(dpr, limit)
}

// 导出倍率从宽到窄：先按设备像素比，再试 1x，最后才压进 1365。相同尺寸不重复试。
function exportScales(width, height, pixelRatio) {
  const full = exportRatio(width, height, pixelRatio)
  const dpr1 = Math.min(1, full)
  const fit = Math.min(1, CANVAS_2D_SAFE_PX / width, CANVAS_2D_SAFE_PX / height)
  const scales = [full]
  function push(value) {
    if (value < scales[scales.length - 1] - 1e-6) scales.push(value)
  }
  push(dpr1)
  push(fit)
  return scales
}

function dataUrlPayload(dataUrl) {
  const text = String(dataUrl || '')
  const comma = text.indexOf(',')
  if (comma < 0) return ''
  return text.slice(comma + 1)
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

function setPageCanvasCss(page, width, height) {
  return new Promise(function (resolve) {
    if (!page || typeof page.setData !== 'function') {
      resolve()
      return
    }
    page.setData({
      slipCanvasWidth: width,
      slipCanvasHeight: height
    }, function () {
      resolve()
    })
  })
}

function queryPageCanvas(page, width, height) {
  return setPageCanvasCss(page, width, height).then(function () {
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
  })
}

function canvasToTempPath(canvas, destWidth, destHeight) {
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

function writeDataUrl(canvas, mime, quality, ext) {
  return new Promise(function (resolve, reject) {
    if (!canvas || typeof canvas.toDataURL !== 'function') {
      reject(new Error('导出失败'))
      return
    }
    if (typeof wx === 'undefined' || !wx.getFileSystemManager || !wx.env || !wx.env.USER_DATA_PATH) {
      reject(new Error('导出失败'))
      return
    }
    let dataUrl = ''
    try {
      dataUrl = canvas.toDataURL(mime, quality)
    } catch (error) {
      reject(new Error((error && error.message) || '导出失败'))
      return
    }
    const payload = dataUrlPayload(dataUrl)
    if (!payload) {
      reject(new Error('导出失败'))
      return
    }
    const filePath = wx.env.USER_DATA_PATH + '/slip-export.' + ext
    wx.getFileSystemManager().writeFile({
      filePath: filePath,
      data: payload,
      encoding: 'base64',
      success: function () {
        resolve(filePath)
      },
      fail: function (error) {
        reject(new Error((error && error.errMsg) || '导出失败'))
      }
    })
  })
}

function canvasToFile(canvas, destWidth, destHeight) {
  return canvasToTempPath(canvas, destWidth, destHeight).catch(function () {
    return writeDataUrl(canvas, 'image/png', 1, 'png').catch(function () {
      return writeDataUrl(canvas, 'image/jpeg', 0.92, 'jpg')
    })
  })
}

function exportToTempFile(page, slip) {
  const probe = createOffscreen(16, 16)
  const measure = makeMeasure(probe && probe.getContext ? probe.getContext('2d') : null)
  const layout = layoutSlip(slip, measure)
  const scales = exportScales(layout.width, layout.height)

  function attempt(dpr) {
    const pixelWidth = Math.ceil(layout.width * dpr)
    const pixelHeight = Math.ceil(layout.height * dpr)

    function paint(canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx.setTransform) ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.scale(dpr, dpr)
      drawSlip(ctx, layout)
      return canvasToFile(canvas, pixelWidth, pixelHeight)
    }

    const offscreen = createOffscreen(pixelWidth, pixelHeight)
    if (offscreen && offscreen.getContext) {
      return paint(offscreen).catch(function () {
        return queryPageCanvas(page, pixelWidth, pixelHeight).then(paint)
      })
    }
    return queryPageCanvas(page, pixelWidth, pixelHeight).then(paint)
  }

  function tryScale(index) {
    const run = attempt(scales[index])
    if (index >= scales.length - 1) return run
    return run.catch(function () {
      return tryScale(index + 1)
    })
  }

  return tryScale(0)
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
  exportRatio: exportRatio,
  exportScales: exportScales,
  dataUrlPayload: dataUrlPayload,
  MAX_CANVAS_PX: MAX_CANVAS_PX,
  CANVAS_2D_SAFE_PX: CANVAS_2D_SAFE_PX,
  specAxisNames: specAxisNames,
  wrapText: wrapText,
  layoutSlip: layoutSlip,
  drawSlip: drawSlip,
  exportToTempFile: exportToTempFile,
  openExportedImage: openExportedImage
}
