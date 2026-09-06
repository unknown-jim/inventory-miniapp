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

// 汇总态矩阵表的列轴（第二轴）去重取值数上限。理由同上一条注释：列一多画布被撑宽，
// 整张单的字号反而更小，只是这次是横向撑宽而不是纵向多列。
// R1（2026-09-02）之后这条只是提前退出的快速否决——列数不多但列值字数长照样能撑宽画布，
// 真正兜底是 layoutSlip 里「矩阵节画布下限 <= 平铺基准」的条件 7。这条注释记的推理仍然
// 成立（列数本身也是撑宽的一个来源），所以保留，不删。
// 规格胶囊（汇总态数量列）。画布是 1700 宽的高清图，这几个数跟 LINE_H(65) 同一量级。
// 胶囊高度必须 **>= 字号 + 上下内边距**。上一版写死 52 而胶囊文字是 56px 的 FONT.num——
// 胶囊比字还矮，textTop 算出来的顶端比胶囊顶端还高 2px，文字上下都露在灰底外面；
// 排距也只剩 8px，相邻两排的字贴在一起。**这两条真机同样会有**，不是预览器的失真。
// 胶囊文字用 FONT.small（48px / 12.1pt）：它比表格正文低一档，但胶囊有底色、对比度更高，
// 而且店主反馈的第一条就是「胶囊太大」。字号一降，一排能多放一枚。
const PILL_TEXT = 44
// 等宽胶囊开关（评审用，定了就把死的那一支删掉，不留配置项）
const PILL_EQUAL_WIDTH = true
const PILL_PAD_Y = 10
const PILL_H = PILL_TEXT + PILL_PAD_Y * 2
const PILL_PAD_X = 16
const PILL_GAP = 10
const PILL_ROW_GAP = 10
const PILL_ROW_H = PILL_H + PILL_ROW_GAP

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
  smallStrong: '700 56px sans-serif',  // 14.1pt 累计欠款，小字里唯一要跳出来的
  pill: '44px sans-serif'              // 11.1pt 规格胶囊与合计胶囊：格内密排，比正文低两档
}

// 胶囊文字。放在 FONT 之后声明——常量块在上面，那里还引用不到 FONT。
const PILL_FONT = FONT.pill

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

// baseline 只有胶囊用：em 盒顶端对齐（textTop）在 103px 高的表格行里差几像素看不出来，
// 在 68px 高的胶囊里一眼就是没居中。中线对齐把这件事交给渲染器算，两端都精确。
function pushTextMiddle(cmds, text, x, yCenter, font, color, align) {
  cmds.push({ type: 'text', text: String(text), x: x, y: yCenter, font: font,
    color: color, align: align || 'left', baseline: 'middle' })
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

// 胶囊：圆角矩形底 + 居中文字。**不用 ctx.roundRect** —— 微信旧版 CanvasContext 没有它，
// drawSlip 那边用 arc 拼路径，两端半圆半径恒等于高的一半。
// 底色默认用表头那个灰（COLORS.header）：单据上已经有它，不为胶囊新引一个颜色。
// 不描边——1700 宽画布缩到手机上时 1px 边会糊成一层脏灰。
// 文字走 pushTextMiddle（中线对齐），不走 textTop 那套 em 盒顶端对齐：68px 高的胶囊里
// 后者一眼就是没居中（店主实测反馈的第一条）。
function pushPillOf(cmds, text, x, y, w, font, fill, color) {
  cmds.push({ type: 'pill', x: x, y: y, w: w, h: PILL_H, fill: fill })
  pushTextMiddle(cmds, text, x + w / 2, y + PILL_H / 2, font, color, 'center')
  return w
}

function pushPill(cmds, text, x, y, w, font) {
  return pushPillOf(cmds, text, x, y, w, font, COLORS.header, COLORS.value)
}

// 合计胶囊：同一格里 2 枚以上时才出（只有一枚时合计就是它自己，纯废话）。
// **深底白字**，字号与字重和规格胶囊完全相同——换成加粗的话文字会比量出来的盒子宽，
// 又变回「文字超出胶囊」，那正是这一轮在修的毛病。浅一档的底色（COLORS.total）
// 和 COLORS.header 差别太小，在缩印的单子上分不出来。
function pushTotalPill(cmds, text, x, y, w, font) {
  return pushPillOf(cmds, text, x, y, w, font, COLORS.value, COLORS.bg)
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
  // 胶囊列（汇总态数量列）也可压：它的 floor 是「一排放得下一枚」，压到底也不截断，
  // 只是排数变多。不让它可压的话，宽度不够时它会去撑宽画布——那是矩阵那版的老毛病。
  if (col.pillValues) return true
  return col.key === 'name' || col.key === 'sku' || col.key.indexOf('spec:') === 0
}

function floorWidth(col, measure) {
  // 胶囊列的下限是**最宽的那一枚**：再窄就要截断规格，单据上不许。
  if (col.pillFloor) return col.pillFloor + CELL_PAD_X * 2
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
    // 富余优先给**胶囊列**（汇总态）：它的自然宽度只保证放得下最宽的一枚，不补的话
    // 胶囊会一枚一行、行高暴涨，正好把「单子更短」这件事做反。没有胶囊列时照旧给品名。
    const pillCol = defs.find(function (col) {
      return !!col.pillValues
    })
    const target = pillCol || defs.find(function (col) {
      return col.key === 'name'
    })
    if (target) target.width -= over
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
  // 行数取自列本身，不再取自 slip.lines：汇总态一行是「一个商品 + 一个单价」的组，
  // 和原始行数不是一回事（明细态两者相等，走的还是同一条路）。
  const rowCount = defs.length ? (defs[0].values || []).length : 0
  const rows = []
  for (let index = 0; index < rowCount; index++) {
    const cells = {}
    let blockH = LINE_H
    defs.forEach(function (col) {
      const pills = col.pillValues && col.pillValues[index]
      if (pills && pills.length) {
        const totalAt = col.pillTotalFrom ? col.pillTotalFrom[index] : -1
        const packed = packPills(pills, Math.max(24, col.width - CELL_PAD_X * 2), col.font, measure, totalAt, PILL_EQUAL_WIDTH ? col.pillFloor : null)
        cells[col.key] = { pills: packed }
        blockH = Math.max(blockH, packed.length * PILL_ROW_H)
        return
      }
      const fixed = col.textLines && col.textLines[index]
      const raw = col.values[index]
      const texts = fixed && fixed.length
        ? fixed
        : (canWrapColumn(col) ? wrapCell(raw, col, measure) : [raw == null ? '' : String(raw)])
      cells[col.key] = texts
      blockH = Math.max(blockH, texts.length * LINE_H)
    })
    rows.push({ cells: cells, height: Math.max(103, CELL_PAD_Y * 2 + blockH) })
  }
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
      const cell = row.cells[col.key]
      if (cell && cell.pills) {
        // 每一排胶囊在列内水平居中；整块在行内垂直居中，和文字格同一个口径。
        let py = row.y + (row.height - cell.pills.length * PILL_ROW_H) / 2
        // **左对齐**，不居中。居中时一排只放得下一两枚，两侧各空一大块（店主的原话是
        // 「左右两侧白边太宽、空间利用率低」）；左对齐之后空白只落在最后一排的尾巴上。
        cell.pills.forEach(function (pillRow) {
          let px = col.x + CELL_PAD_X
          pillRow.forEach(function (item) {
            if (item.total) pushTotalPill(cmds, item.text, px, py, item.w, col.font)
            else pushPill(cmds, item.text, px, py, item.w, col.font)
            px += item.w + PILL_GAP
          })
          py += PILL_ROW_H
        })
        return
      }
      const texts = cell || []
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

// ---------------------------------------------------------------------------
// 汇总态：按商品分节，能矩阵化的节画成「行=规格一取值、列=规格二取值、格内件数」的交叉表，
// 不能矩阵化的节退回平铺。
//
// 分节只在 exportStyle 解析成 'summary' 时跑。解析规则见 layoutSlip：**只有字面 'detail'**
// 走明细态，其余一切取值——包括不传 options、传 undefined、传别的字符串——都解析成
// 'summary'，照样分节、照样矩阵化。实测 `不传 === summary` 为 true、`不传 === detail`
// 为 false。所以「不传 = 老路径、一条分节逻辑都不会跑」是错的，别照着这个前提改代码。
// 常驻断言只钉住两件事（tests/slip-image.test.js）：不传 ≡ 显式 'summary'、且 ≠ 'detail'。
// 「detail 与改动前逐字节相同」没有常驻断言，只在评审期比过 baseline 模块，别当保证读。
// ---------------------------------------------------------------------------

// 分组 key 优先取 productId —— 商品身份，由 utils/util.js 的 withSlipView 从
// inventory.recordLines 的 item.productId 带下来。
// 为什么不能只用「品名 + 货号」：品名没有唯一性校验（utils/inventory.js 的 createProduct
// 只校验非空），货号可空，所以两个**不同商品**同名且都没填货号时会被并进同一节——节头只
// 印一个品名、小计跨商品求和，叠加矩阵格就会印出错数。
// pages/sale/sale.js 的 mergeLines 挡不住这条：它按 product.id + specKey(color,size) 合并，
// 只在**单个商品内**去重，跨商品的同名碰撞它看不见。
// productId 缺失（老流水、页面自己拼的预览数据）才退回「品名 + 货号」，sku 用 skuText 统一
// 空串和「未填」，避免同一商品因为两种写法被拆成两节。
// 两种 key 各带前缀，id / name 两个 keyspace 才不会互相撞上。
// 分隔符用 \u0000，不用空格：品名本身可以含空格（夹具就有「短袖 T恤」），空格拼接会让
// '短袖 T'+'TS' 和 '短袖'+'T TS' 撞成同一个 key（都拼成 '短袖 T TS'）。\u0000 不会出现在
// 品名或货号里，拼接后不可能碰撞。
// 按 key 首次出现的顺序排节、节内保持原始行顺序——单据顺序是店主录入的顺序，不重排。
function sliceLineSections(lines) {
  const list = lines || []
  const index = {}
  const sections = []
  list.forEach(function (line) {
    const sku = skuText(line)
    const productId = String((line && line.productId) || '')
    const key = productId
      ? 'id\u0000' + productId
      : 'name\u0000' + String((line && line.productName) || '') + '\u0000' + sku
    if (!index[key]) {
      index[key] = { productName: (line && line.productName) || '', sku: sku, lines: [] }
      sections.push(index[key])
    }
    index[key].lines.push(line)
  })
  return sections
}

// 判定条件 4：节内单价必须逐字相同，单价要提到节头，不同价就提不上去。
function sectionPriceText(section) {
  const first = section.lines[0] && section.lines[0].priceText
  const same = section.lines.every(function (line) {
    return line.priceText === first
  })
  return same ? first : null
}

// 汇总一节金额：明细行 amountText 相加，口径同 utils/util.js 的 money()（四舍五入到分），
// 但这里不 require 那个模块——slip-image.js 一直是零依赖的纯渲染层，不为这一处开先例。
function amountSumText(lines) {
  const total = (lines || []).reduce(function (sum, line) {
    const n = Number(line.amountText)
    return sum + (isFinite(n) ? n : 0)
  }, 0)
  return (Math.round((total + Number.EPSILON) * 100) / 100).toFixed(2)
}

// 合计搬出表格：金额列原本被合计的 ¥1582.00 撑着，明细行最长才 495.00。搬出来这列窄一截，
// 画布跟着窄，字号就能再大一点；合计本身也不再受列宽约束，可以用最大的字。
// ---------------------------------------------------------------------------
// 汇总态：**去掉规格列**，「同一商品 + 同一单价」并成一行，规格与件数并进数量列画成胶囊。
//
// 为什么不是从前那套交叉表：交叉表要付「节头 + 表头 + 节尾」三行固定开销，所以它有一条
// 「压缩收益」门槛（2 + 行轴取值数 < 原行数）。代入满行的 R×C 网格就是 R×(C−1) > 2 ——
// **2 色 × 2 码永远不满足**，而那正是日常最常见的单子形状：店主点了「汇总」，屏上和明细
// 一模一样，chip 上「单子更短」那句承诺不兑现（2026-09-06 拿真实单据 SH20260906-Q0FW
// 实测复现：4 行的单子两种模式逐字相同）。
// 胶囊几乎零开销：一个商品一行，规格在格内横向排、排不下往下折——**纵向便宜、横向贵**，
// 而交叉表恰好把规格摊在横轴上，所以它还需要「列数上限」和「不许比平铺更宽」两道闸。
// 换成胶囊之后，那两道闸连同压缩收益、轴数恰好为 2、节行数 ≥2 一起不需要了。
//
// 保留的那道闸是**单价**：只有节内单价逐字相同才并成一行。这不是为了省事——单价并进一
// 行之后，客户核单的算式就是「胶囊件数之和 × 单价 = 金额」，单价不统一这条算式就不成立。
// 同一商品两种价时按价分成两组（各自并一行），不退回逐行，列还是这五列，没有第二套版式。
// ---------------------------------------------------------------------------

// 胶囊文字：规格值之间用 ' · '（与 mergedSpecValues 同一个连接符），后面跟 ×件数。
// 无规格的行返回空串，调用方据此让数量列退回纯数字。
function pillTextFor(line, axes) {
  const label = axes.map(function (name) {
    return specCellValue(line, name)
  }).filter(function (value) {
    return value
  }).join('/')
  if (!label) return ''
  return label + ' ×' + String(line && line.qtyText == null ? '' : line.qtyText)
}

// 先按商品分节（沿用 sliceLineSections 那套 productId 优先的身份判定），再按单价分组。
// index 用 Object.create(null)：priceText 虽然由 money() 生成、正常只含数字和点，但
// 这里的教训（同一文件矩阵那版踩过）是**别拿用户数据当对象键还用 {}**，代价是印错单。
function slicePillGroups(lines) {
  const groups = []
  sliceLineSections(lines).forEach(function (section) {
    const index = Object.create(null)
    section.lines.forEach(function (line) {
      const key = String(line && line.priceText == null ? '' : line.priceText)
      if (!index[key]) {
        index[key] = {
          productName: section.productName,
          sku: section.sku,
          priceText: key,
          lines: []
        }
        groups.push(index[key])
      }
      index[key].lines.push(line)
    })
  })
  return groups
}

// 把一组胶囊按可用宽度排进若干行。单个胶囊比可用宽度还宽时照样独占一行（不截断）——
// 单据上宁可撑出去也不能少印一个规格。
// unitW 非空时所有胶囊按同一个宽度走（等宽），每排枚数因此固定、上下排能对齐成列；
// 为空则各按自己文字的宽度，右边缘是毛的。
function packPills(texts, inner, font, measure, totalAt, unitW) {
  const rows = []
  let current = []
  let used = 0
  texts.forEach(function (text, i) {
    const w = unitW || (Math.ceil(measure(text, font)) + PILL_PAD_X * 2)
    const item = { text: text, w: w, total: totalAt != null && totalAt >= 0 && i === totalAt }
    const need = current.length ? used + PILL_GAP + w : w
    if (current.length && need > inner) {
      rows.push(current)
      current = [item]
      used = w
      return
    }
    current.push(item)
    used = need
  })
  if (current.length) rows.push(current)
  return rows
}

// 一格里 2 枚以上才出合计胶囊：只有一枚时合计等于它自己。
function totalPillTextFor(group) {
  return '小计 ' + qtyTotalText(group.lines) + ' 件'
}

// 汇总态的列：品名（含货号第二行）/ 数量 / 单价 / 金额。**没有规格列**——规格在胶囊里。
function summaryColumns(slip, groups, measure) {
  const axes = specAxisNames((slip && slip.lines) || [])
  // **没有独立的货号列**：汇总态一行就是一个商品，货号整列重复同一个值，白占宽度；
  // 而且它每占 242px，胶囊一排就少放一枚（实测：有货号列时一排 2 枚，去掉之后 3 枚）。
  // 货号放在品名格的**第二行**，而且**只在这一组有 2 条以上规格时才放**：
  //   · 并进同一行不行 —— 横向空间是守恒的，品名列跟着变宽，等于把宽度从胶囊那里
  //     拿走，一排又只剩一枚（实测：3 色×4 码从「每排 3 枚、短 35%」退回「每排 1 枚、
  //     短 14%」）。第二行只占高度，不占宽度（两行各自量宽，取较宽的那个）。
  //   · **每一组都要有货号，一条规格的组也不例外。** 上一版为了省那 65px 写了
  //     「只在 2 条以上规格时才放第二行」，结果单商品单规格的单子货号整个不见了
  //     ——而默认导出样式就是汇总，那是最常见的单子（tests/slip-image.test.js:92
  //     当场逮住）。省版面不能省掉单据上的字段。
  //
  // 顺带纠正一条上一版写错的理由：去掉货号列不是因为「整列重复同一个值」——那是
  // **明细态**的现象（同一商品 4 行印 4 次）。汇总态一行就是一个商品，每行货号都不同。
  // 去掉它的真实理由只有一条：那一列占 242px，胶囊一排就少放一枚。
  // 腾出来的这一列全给胶囊：实测 3 色×4 码从「一枚一排、短 22%」变成「两枚一排、短 39%」，
  // 而且不必动字号——降字号那条实测**没有额外收益**（列宽不够放第三枚），却要破
  // docs/ui-scale.md 的适老化字号线，不该付这个代价。
  const defs = [
    { key: 'name', title: '品名', align: 'left', font: FONT.name,
      values: groups.map(function (group) { return group.productName }),
      textLines: groups.map(function (group) {
        return [group.productName, group.sku].filter(function (text) { return text })
      }) },
    { key: 'qty', title: '数量', align: 'center', font: PILL_FONT,
      values: groups.map(function (group) { return qtyTotalText(group.lines) }),
      pillValues: groups.map(function (group) {
        const texts = group.lines.map(function (line) {
          return pillTextFor(line, axes)
        }).filter(function (text) { return text })
        return texts.length >= 2 ? texts.concat([totalPillTextFor(group)]) : texts
      }),
      // 最后那一枚是合计，绘制时换个底色和字重。
      pillTotalFrom: groups.map(function (group) {
        const count = group.lines.filter(function (line) {
          return pillTextFor(line, axes)
        }).length
        return count >= 2 ? count : -1
      }) },
    { key: 'price', title: '单价', align: 'right', font: FONT.num,
      values: groups.map(function (group) { return group.priceText }) },
    { key: 'amount', title: '金额', align: 'right', font: FONT.num,
      values: groups.map(function (group) { return amountSumText(group.lines) }) }
  ]
  defs.forEach(function (col) {
    let need = measure(col.title, FONT.head)
    col.values.forEach(function (value) {
      need = Math.max(need, measure(value == null ? '' : String(value), col.font))
    })
    ;(col.textLines || []).forEach(function (texts) {
      texts.forEach(function (text) {
        need = Math.max(need, measure(text, col.font))
      })
    })
    // 胶囊列只记 floor（最宽的一枚 —— 再窄就要截断规格），宽度下面单独给。
    if (col.pillValues) {
      let widest = 0
      col.pillValues.forEach(function (texts) {
        texts.forEach(function (text) {
          widest = Math.max(widest, Math.ceil(measure(text, col.font)) + PILL_PAD_X * 2)
        })
      })
      if (widest) col.pillFloor = widest
      need = Math.max(need, widest)
    }
    col.width = Math.ceil(need * MEASURE_SLACK) + CELL_PAD_X * 2
  })
  // **其它列按自然宽度取走，剩下的全给胶囊列。** 不能像别的列那样只按内容量宽：
  // 胶囊的自然宽度就是一枚，量完富余会被 fitColumns 派给品名，胶囊只好一枚一行、
  // 行高暴涨——正好把「单子更短」做反（实测：4 枚排成 4 排、12 枚排成 12 排）。
  // 也不能反过来贪心要「全排一行」：那会把货号和品名一起压到 3 字底线，品名跟着折行。
  // 剩余不足一枚时退回 floor，此时 natural 超出内容宽，交给 fitColumns 照常压。
  // **两趟定宽。** 第一趟：其它列按内容量走，剩下的全归胶囊列（可用上限）。
  // 第二趟：按最宽那枚算「这么宽的一排最多放几枚」，再把列**收到正好放下那几枚**，
  // 余下的还给品名列。只做第一趟的话，胶囊按实际宽度左对齐排完，列右边会剩一大块空白
  // ——店主实测反馈的第二条（「右边空白还是多」）。
  const pillCol = defs.find(function (col) {
    return !!col.pillFloor
  })
  const nameCol = defs.find(function (col) {
    return col.key === 'name'
  })
  if (pillCol) {
    const others = defs.reduce(function (sum, col) {
      return col === pillCol ? sum : sum + col.width
    }, 0)
    const avail = Math.max(pillCol.pillFloor + CELL_PAD_X * 2, WIDTH - PAD * 2 - others)
    const inner = avail - CELL_PAD_X * 2
    const unit = pillCol.pillFloor
    const perRow = Math.max(1, Math.floor((inner + PILL_GAP) / (unit + PILL_GAP)))
    const tight = unit * perRow + PILL_GAP * (perRow - 1) + CELL_PAD_X * 2
    pillCol.width = Math.min(avail, tight)
    if (nameCol) nameCol.width += avail - pillCol.width
  }
  return { defs: defs, natural: defs.reduce(function (sum, col) {
    return sum + col.width
  }, 0) }
}

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
  // 导出样式是用户导出那一刻的选择，不是单据数据，所以放在 options 而不是 slip 上。
  // 只认字面 'detail'，别的值（含不传）一律按 'summary'。
  const exportStyle = options && options.exportStyle === 'detail' ? 'detail' : 'summary'
  // 汇总态与明细态的差别**全部**落在列定义上：汇总态用 summaryColumns（没有规格列、
  // 数量列带胶囊、一行是「一个商品 + 一个单价」的组），明细态用 tableColumns（一行一条
  // 原始流水）。往下 pageWidthFor / fitColumns / layoutTable 两条路共用，没有第二套版式。
  //
  // 注意：**不传 options 解析成 'summary'**，和 'detail' 不是一回事。这一条从矩阵那版
  // 就成立，换成胶囊之后照旧——常驻断言钉着「不传 ≡ 显式 summary、且 ≠ detail」。
  const raw = exportStyle === 'summary'
    ? summaryColumns(slip, slicePillGroups(slip.lines), measureFn)
    : tableColumns(slip, measureFn)

  const pageWidth = pageWidthFor(raw, measureFn)

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

  const cols = fitColumns(raw, pageWidth, measureFn)
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
      // 只有胶囊文字带 baseline:'middle'，其余仍是全局那个 'top'，一个字没改。
      if (cmd.baseline) ctx.textBaseline = cmd.baseline
      ctx.fillText(cmd.text, cmd.x, cmd.y)
      if (cmd.baseline) ctx.textBaseline = 'top'
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
    } else if (cmd.type === 'pill') {
      // 胶囊路径：左右两端各一个半圆（r = h/2），中间两条直线。
      const r = cmd.h / 2
      ctx.beginPath()
      ctx.moveTo(cmd.x + r, cmd.y)
      ctx.lineTo(cmd.x + cmd.w - r, cmd.y)
      ctx.arc(cmd.x + cmd.w - r, cmd.y + r, r, -Math.PI / 2, Math.PI / 2)
      ctx.lineTo(cmd.x + r, cmd.y + cmd.h)
      ctx.arc(cmd.x + r, cmd.y + r, r, Math.PI / 2, -Math.PI / 2)
      ctx.closePath()
      ctx.fillStyle = cmd.fill
      ctx.fill()
      if (cmd.stroke) {
        ctx.save()
        ctx.strokeStyle = cmd.stroke
        ctx.lineWidth = 1
        if (ctx.setLineDash) ctx.setLineDash([])
        ctx.stroke()
        ctx.restore()
      }
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

// exportToTempFile 首选 offscreen canvas（每次新建、互不干扰），只有它不可用或绘制失败
// 才回落到页面上唯一的 #slipCanvas——那是全页面共享的同一个节点。两次导出并发都走这条
// 回落路径会互踩：A 设尺寸 → B 设尺寸 → A 画 → B 画 → A 截到的其实是 B 的画面。批 2 的
// 预生成 + 用户手动点导出就能凑出这种并发，所以「拿页面 canvas + 在它上面画完」这一整段
// 必须串行——只串行拿 node 那一步没用，画的动作才是真正共享同一块画布的地方，串行范围
// 要盖到 paint（含 canvasToFile）跑完为止。
// 队列挂在模块作用域。某一次任务失败要 .catch 掉再接下一个，不能让后面排队的任务跟着
// 卡死；这里返回给调用方的是 run 本身（未被 catch 吞掉的那份），调用方自己的失败处理
// （tryScale 换 dpr 重试、offscreen 失败回落）不受影响。
// offscreen 那条主路径每次都是新画布，本来就不冲突，不进这个队列——进了只会白白排队拖慢。
let pageCanvasQueue = Promise.resolve()

function withPageCanvas(page, width, height, paint) {
  const run = pageCanvasQueue.then(function () {
    return queryPageCanvas(page, width, height).then(paint)
  })
  pageCanvasQueue = run.catch(function () {})
  return run
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

// 第三个参数原样透传给 layoutSlip，这一层不加分支。取值语义以 layoutSlip 为准：
// 只有字面 'detail' 走明细态，不传或传别的值一律按 'summary' 渲染——也就是**会**分节、
// **会**矩阵化，不是「与改动前完全一致」的老路径。
function exportToTempFile(page, slip, exportStyle) {
  const probe = createOffscreen(16, 16)
  const measure = makeMeasure(probe && probe.getContext ? probe.getContext('2d') : null)
  const layout = layoutSlip(slip, measure, { exportStyle: exportStyle })
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
        return withPageCanvas(page, pixelWidth, pixelHeight, paint)
      })
    }
    return withPageCanvas(page, pixelWidth, pixelHeight, paint)
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
  sliceLineSections: sliceLineSections,
  wrapText: wrapText,
  layoutSlip: layoutSlip,
  drawSlip: drawSlip,
  exportToTempFile: exportToTempFile,
  openExportedImage: openExportedImage
}
