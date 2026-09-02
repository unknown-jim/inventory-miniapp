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
const MATRIX_COL_LIMIT = 6

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

// 判定条件 3：该行 specParts 里「有名字、有值」的轴恰好 2 个，返回轴名序列；
// 不满足（轴数不是 2、或存在无名轴）一律返回 null，调用方据此退回平铺。
function lineAxisPair(line) {
  const parts = (line && line.specParts) || []
  const valued = parts.filter(function (part) {
    return part && part.value
  })
  if (valued.length !== 2) return null
  if (!valued[0].name || !valued[1].name) return null
  return [valued[0].name, valued[1].name]
}

// 节内所有行的轴名序列必须完全一致（名字和顺序都要对上），否则不成表。
function sectionAxisPair(section) {
  let pair = null
  for (let i = 0; i < section.lines.length; i++) {
    const current = lineAxisPair(section.lines[i])
    if (!current) return null
    if (!pair) {
      pair = current
    } else if (current[0] !== pair[0] || current[1] !== pair[1]) {
      return null
    }
  }
  return pair
}

// 判定条件 4：节内单价必须逐字相同，单价要提到节头，不同价就提不上去。
function sectionPriceText(section) {
  const first = section.lines[0] && section.lines[0].priceText
  const same = section.lines.every(function (line) {
    return line.priceText === first
  })
  return same ? first : null
}

function uniqueValuesInOrder(values) {
  const seen = []
  values.forEach(function (value) {
    if (seen.indexOf(value) < 0) seen.push(value)
  })
  return seen
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

// 逐条核对矩阵化条件 2~6（条件 1 是 exportStyle==='summary'，由调用方在决定要不要调这个
// 函数时把关；条件 7——矩阵化不得让画布比平铺更宽，见方案 R1——需要 basePageWidth，
// 这里还没算出来，由调用方 layoutSlip 在算完 basePageWidth 之后再对这里的结果补一刀）。
// 任一条不满足就返回 null，调用方据此退回平铺。
function buildMatrixSection(section) {
  if (section.lines.length < 2) return null // 条件 2：节行数 ≥ 2
  const axes = sectionAxisPair(section) // 条件 3
  if (!axes) return null
  const priceText = sectionPriceText(section) // 条件 4
  if (priceText == null) return null
  const rowAxis = axes[0]
  const colAxis = axes[1]
  const rowValues = uniqueValuesInOrder(section.lines.map(function (line) {
    return specCellValue(line, rowAxis)
  }))
  const colValues = uniqueValuesInOrder(section.lines.map(function (line) {
    return specCellValue(line, colAxis)
  }))
  if (colValues.length > MATRIX_COL_LIMIT) return null // 条件 5
  if (!(2 + rowValues.length < section.lines.length)) return null // 条件 6：有压缩收益
  // 同一 (行,列) 组合理论上可能出现多行（实际链路里 pages/sale/sale.js 的 mergeLine 已经
  // 按 productId+规格在购物车阶段合并过，这里能碰到的概率很低，但存下来防的就是这条）。
  // grid 存的是行数组、不是单行，格内累加显示，不让后写的行覆盖先写的——行小计本来就是按
  // section.lines 全量算的，格子如果只挑最后一行，会出现「格之和 ≠ 小计」这种在单据上
  // 代价很高的错，还会让行数只增 N 不增 R，反而更容易凑到条件 6 的压缩收益。
  // Object.create(null) 而不是 {}：规格取值是店主自由输入的字符串，正好叫 `constructor`
  // / `toString` / `valueOf` / `hasOwnProperty` / `__proto__` 时，`{}` 会从原型上读到
  // 一个真值，`if (!grid[r][c])` 判假、不初始化成数组，下一行 `.push` 直接抛
  // `grid[r][c].push is not a function`——**整张送货单导不出来**。
  // **列轴**撞上时抛异常；**行轴撞上不抛异常，但不是无害**（上一版这里
  // 写的是「行轴撞上无害」，错的）：`grid[r]` 拿到的是原型上那个对象本体，
  // 于是 `grid[r][c] = []` 写到全局 `Object`（`constructor`）或 `Object.prototype`
  // （`__proto__`）身上。实测后果有两层：
  //   · **`__proto__` 那一支：同一张单当场就印错**——两行共用同一批格子数组，本该 1/2/3（小计 6）
  //     和 4/5/6（小计 15），实际两行都印 5/7/9
  //     （`constructor` 那一支实测**不**印错，它只污染全局 `Object`）
  //   · `__proto__` 那一支还会泄到**下一张单**（新建的 `{}` 从 `Object.prototype`
  //     继承到上一张的格子），客户可能在自己的单子上看到别人的货
  // 两处都换掉，别只换一处。
  const grid = Object.create(null)
  section.lines.forEach(function (line) {
    const r = specCellValue(line, rowAxis)
    const c = specCellValue(line, colAxis)
    if (!grid[r]) grid[r] = Object.create(null)
    if (!grid[r][c]) grid[r][c] = []
    grid[r][c].push(line)
  })
  return {
    rowAxis: rowAxis,
    colAxis: colAxis,
    rowValues: rowValues,
    colValues: colValues,
    priceText: priceText,
    grid: grid
  }
}

// 矩阵节的列定义：第一列（key 特意叫 'name'）＝行轴取值，中间各列＝列轴取值格内件数，
// 最后一列＝小计。key 'name' 是刻意对齐 fitColumns/canWrapColumn 已有的判断（吸收富余
// 宽度、允许折行），不必另写一套列宽算法。
function matrixColumnDefs(section, matrix) {
  const defs = [{
    key: 'name',
    title: matrix.rowAxis,
    align: 'left',
    font: FONT.name,
    values: matrix.rowValues.slice()
  }]
  matrix.colValues.forEach(function (colValue) {
    defs.push({
      key: 'col:' + colValue,
      title: colValue,
      align: 'center',
      font: FONT.num,
      values: matrix.rowValues.map(function (rowValue) {
        const cellLines = matrix.grid[rowValue] && matrix.grid[rowValue][colValue]
        // 没卖过的格子画 —（U+2014），不留空白——留白会被当成漏印。
        // 同一格多行：件数相加显示，不挑某一行——qtyTotalText 跟节尾小计、行小计用的是
        // 同一套求和口径，格之和才对得上小计。
        return cellLines && cellLines.length ? qtyTotalText(cellLines) : '—'
      })
    })
  })
  defs.push({
    key: 'subtotal',
    title: '小计',
    align: 'center',
    font: FONT.num,
    values: matrix.rowValues.map(function (rowValue) {
      const rowLines = section.lines.filter(function (line) {
        return specCellValue(line, matrix.rowAxis) === rowValue
      })
      return qtyTotalText(rowLines)
    })
  })
  return defs
}

// 表头和每列的每个值都量一遍取最宽，跟 tableColumns 同一套算法，量出来的宽度才可信。
function measureColsWidth(defs, measure) {
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

// 矩阵节自己的列下限——形状照抄 pageWidthFor，但量的是这一节的矩阵列（行轴+各列取值+小计），
// 不是平铺全表的列。老路径靠 pageWidthFor(raw) 保证 fitColumns 一定塞得下，矩阵节的列压根
// 没进那个式子，所以矩阵节必须单独算一次下限，调用方（layoutSlip）拿它和 pageWidthFor 取 max。
function matrixPageWidthFor(section, matrix, measure) {
  const raw = measureColsWidth(matrixColumnDefs(section, matrix), measure)
  const floor = raw.defs.reduce(function (sum, col) {
    return sum + (canWrapColumn(col) ? floorWidth(col, measure) : col.width)
  }, 0)
  return floor + PAD * 2
}

// 矩阵节画四种行：节头（货号+品名 / 单价）、列表头（行轴名 / 各列取值 / 小计）、
// 数据行（行轴取值 / 各列件数 / 该行小计）、节尾（小计 N 件 / ¥金额合计）。
// 列的边框只画在列表头到数据行这一段，节头和节尾是跨列的整行文字，不该被竖线切开。
function layoutMatrixSection(cmds, section, matrix, pageWidth, y, measure) {
  const contentWidth = pageWidth - PAD * 2
  const tableRight = PAD + contentWidth
  const raw = measureColsWidth(matrixColumnDefs(section, matrix), measure)
  const cols = fitColumns(raw, pageWidth, measure)
  const defs = cols.defs
  const headH = 98

  // 节头是「货号+品名」和「¥单价」共用的一行，两段都不进列布局，所以边界得自己划：
  // 品名可用宽 = 内容宽 − 左右内边距 − 单价文本宽 − 安全间距。
  // 不算这一刀的话（改动前就是直接 pushText 单行硬画）：单价 ¥59.00、画布 1700 时实测
  // **28 个汉字起**节头右边界压过单价左边界、**33 个汉字起**整段画到画布外。阈值随单价
  // 位数走——单价越长可用宽越窄，越早出事，所以这里按实际单价文本宽现算，不写死字数。
  // 同一份数据在明细态不出事：那边品名走 wrapCell，受列宽约束。
  // 先 fitFont 降字号，还塞不下再折行，行数计进节头高度。
  const priceLabel = '¥' + matrix.priceText
  // 纯观感留白：品名和单价之间别贴到一起。断言只钉「不越过单价左边界」，钉不住这个间距
  // （去掉它测试仍然绿，实测过）——它是余量，不是正确性边界，别当钉子读。
  const headGap = CELL_PAD_X * 2
  // 下限 48 是给 fitFont 的最小字号（36px）留的余量：单个汉字最宽就是字号，48 > 36，
  // 折出来的每一行至少还塞得下一个字，不会出现「一个字都放不下反而溢出」。
  const headAvail = Math.max(48, contentWidth - CELL_PAD_X * 2 - measure(priceLabel, FONT.head) - headGap)
  const headerLabel = (section.sku ? section.sku + ' ' : '') + section.productName
  const headerFont = fitFont(headerLabel, FONT.head, headAvail, measure)
  const headerLines = wrapText(headerLabel, headAvail, function (part) {
    return measure(part, headerFont)
  })
  // 只有折了行才变高。**不能写成 `Math.max(headH, CELL_PAD_Y*2 + n*LINE_H)`**：
  // n=1 时那个式子是 23*2+65=111，而 headH=98，`Math.max` 恒取 111——于是
  // **每一张既有矩阵送货单的节头都无条件长高 13px**，短品名一张也不例外。
  // （2026-09-03 审计拉出来的。上一版就是那么写的，而旁边的注释声称
  // 「单行时与改动前逐字相同」——逐条指令对比实测 49 条里 31 条不同，
  // contentHeight 1218→1231。**声明不动却实际动了产品行为**，跟把稿的现状
  // 当成稿的意图是同一个错误。本次改回“只有折行才变高”，而不是去改稿——
  // 节头变高不是本 PR 要解决的问题，不该搭车。）
  const sectionHeadH = headerLines.length > 1
    ? CELL_PAD_Y * 2 + headerLines.length * LINE_H
    : headH

  const tableTop = y
  const sectionHeadY = y
  y += sectionHeadH
  const listHeadY = y
  y += headH

  const rows = matrix.rowValues.map(function (rowValue, index) {
    const cells = {}
    defs.forEach(function (col) {
      const raw2 = col.values[index]
      cells[col.key] = canWrapColumn(col)
        ? wrapCell(raw2, col, measure)
        : [raw2 == null ? '' : String(raw2)]
    })
    const lineCount = defs.reduce(function (max, col) {
      return Math.max(max, (cells[col.key] || []).length)
    }, 1)
    return {
      cells: cells,
      height: Math.max(103, CELL_PAD_Y * 2 + lineCount * LINE_H)
    }
  })
  rows.forEach(function (row) {
    row.y = y
    y += row.height
  })

  const footY = y
  y += headH

  const tableH = y - tableTop

  pushRect(cmds, PAD, sectionHeadY, contentWidth, sectionHeadH, COLORS.header)
  pushRect(cmds, PAD, listHeadY, contentWidth, headH, COLORS.total)
  pushRect(cmds, PAD, footY, contentWidth, headH, COLORS.total)
  pushStroke(cmds, PAD, tableTop, contentWidth, tableH, 2)
  pushLine(cmds, PAD, sectionHeadY + sectionHeadH, tableRight, sectionHeadY + sectionHeadH, 1)
  pushLine(cmds, PAD, listHeadY + headH, tableRight, listHeadY + headH, 1)
  rows.forEach(function (row) {
    pushLine(cmds, PAD, row.y + row.height, tableRight, row.y + row.height, 1)
  })
  defs.slice(1).forEach(function (col) {
    pushLine(cmds, col.x, listHeadY, col.x, footY, 1)
  })

  // 单行时沿用 textTop 的垂直居中（和改动前逐字相同）；折行了才按整块文字居中。
  let headTextY = headerLines.length > 1
    ? sectionHeadY + (sectionHeadH - headerLines.length * LINE_H) / 2
    : textTop(sectionHeadY, sectionHeadH, headerFont)
  headerLines.forEach(function (part) {
    pushText(cmds, part, PAD + CELL_PAD_X, headTextY, headerFont, COLORS.value, 'left')
    headTextY += LINE_H
  })
  pushText(cmds, priceLabel, tableRight - CELL_PAD_X, textTop(sectionHeadY, sectionHeadH, FONT.head), FONT.head, COLORS.value, 'right')

  defs.forEach(function (col) {
    pushText(cmds, col.title, cellX(col), textTop(listHeadY, headH, FONT.head), FONT.head, COLORS.value, col.align)
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

  const sectionQtyText = qtyTotalText(section.lines)
  const sectionAmountText = amountSumText(section.lines)
  pushText(cmds, '小计 ' + sectionQtyText + ' 件', PAD + CELL_PAD_X, textTop(footY, headH, FONT.head), FONT.head, COLORS.value, 'left')
  pushText(cmds, '¥' + sectionAmountText, tableRight - CELL_PAD_X, textTop(footY, headH, FONT.head), FONT.head, COLORS.value, 'right')

  return y + 24
}

// 平铺节的列结构/宽度/x 坐标一律照抄整表那一份（sharedCols，由调用方用整表的
// tableColumns+fitColumns 算好），不再各节自己重算——整表轴数超过 SPEC_AXIS_LIMIT 时会把
// 规格并成一列，单独拆出来的某一节可能自己没那么多轴、算出来的列反而更宽，而 pageWidth
// 是按整表口径定的，两边一混，宽的那份会被裁掉一截，画到画布外静默丢失（R2 审计实测：
// 服装节矩阵化+钢材节平铺，整表 4 轴合并成一列 spec:*，钢材节自己只有 2 轴不合并，两种
// 口径差 216px，8 条指令最右画到了 1820，画布却只有 1736）。
// 这里只换 values——按传入的这组行重新取值，取值口径（哪一列取哪个字段/哪个规格轴）跟
// tableColumns 内部完全一致，只是不重新决定「轴要不要合并成一列」，那个决定权在整表。
function flatSectionColumns(sharedCols, groupLines, axes) {
  const defs = sharedCols.defs.map(function (col) {
    let values
    if (col.key === 'sku') {
      values = columnValues(groupLines, 'sku')
    } else if (col.key === 'name') {
      values = columnValues(groupLines, 'productName')
    } else if (col.key === 'spec:*') {
      values = mergedSpecValues(groupLines, axes)
    } else if (col.key.indexOf('spec:') === 0) {
      values = columnValues(groupLines, 'spec', col.key.slice(5))
    } else if (col.key === 'qty') {
      values = columnValues(groupLines, 'qtyText')
    } else if (col.key === 'price') {
      values = columnValues(groupLines, 'priceText')
    } else if (col.key === 'amount') {
      values = columnValues(groupLines, 'amountText')
    } else {
      values = groupLines.map(function () {
        return ''
      })
    }
    return Object.assign({}, col, { values: values })
  })
  return { defs: defs, contentWidth: sharedCols.contentWidth }
}

// 全表按节渲染：矩阵节走 layoutMatrixSection（矩阵列结构跟平铺列本来就不是一回事，列宽
// 自己算，不受这条改动影响，矩阵化判定 7 个条件也没动）。平铺节复用 layoutTable，但列定义
// 换成整表那一份（见 flatSectionColumns），并且把连续出现的平铺节合并成一次 layoutTable
// 调用——这样连续的平铺节自然共用一个表头；矩阵节把两段平铺隔开时，后面那段平铺节重新画
// 一次表头（读者需要重新对齐列义），不连续的段不并起来。
function layoutSectionedTable(cmds, sections, matrices, raw, axes, pageWidth, y, measure) {
  const cols = fitColumns(raw, pageWidth, measure)
  let cursor = y
  let flatLines = []

  function flushFlat() {
    if (!flatLines.length) return
    cursor = layoutTable(cmds, { lines: flatLines }, flatSectionColumns(cols, flatLines, axes), cursor, measure)
    flatLines = []
  }

  sections.forEach(function (section, index) {
    const matrix = matrices[index]
    if (matrix) {
      flushFlat()
      cursor = layoutMatrixSection(cmds, section, matrix, pageWidth, cursor, measure)
    } else {
      flatLines = flatLines.concat(section.lines)
    }
  })
  flushFlat()

  return cursor
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
  // 导出样式是用户导出那一刻的选择，不是单据数据，所以放在 options 而不是 slip 上。
  // 只认字面 'detail'，别的值（含不传）一律按 'summary'。
  const exportStyle = options && options.exportStyle === 'detail' ? 'detail' : 'summary'
  const raw = tableColumns(slip, measureFn)

  // exportStyle === 'detail' 时连分节都不算，sections/matrices 留 null、hasMatrix 恒为
  // false，整张单走 tableColumns / fitColumns / layoutTable 这条不分节的路径。
  // 注意：**不传 options 解析成 'summary'**，会分节、会矩阵化，和 'detail' 不是一回事；
  // 上一版注释把这两者说成同一条老路径，不对。
  let sections = null
  let matrices = null
  let hasMatrix = false
  if (exportStyle === 'summary') {
    sections = sliceLineSections(slip.lines)
    matrices = sections.map(buildMatrixSection)
  }

  // 基准画布：不管有没有矩阵节都先按平铺算一遍。这一步必须排在「矩阵节是否成立」判定之前——
  // R1 新增的条件 7 要拿它当上限，先有基准才能问「矩阵化会不会撑得比它更宽」，否则「画布宽度
  // 取决于哪些节矩阵化、矩阵化又取决于画布宽度」会绕成循环依赖（方案 R1 明确点出这一条）。
  const basePageWidth = pageWidthFor(raw, measureFn)

  // 条件 7（方案 R1，2026-09-02）：矩阵化不得让画布比平铺更宽。逐节判断——这节矩阵化后的
  // 列宽下限一旦超过 basePageWidth，就地退回平铺（matrices[index] 置 null），不牵连其它节，
  // 混排照旧成立。前 6 条件都满足也不例外：这个功能的出发点是「单子太长」，不是「字太大」，
  // 拿字号换行数是走反了。MATRIX_COL_LIMIT（条件 5）留着当快速否决，但真正兜底是这一条。
  if (matrices) {
    matrices = matrices.map(function (matrix, index) {
      if (!matrix) return null
      if (matrixPageWidthFor(sections[index], matrix, measureFn) > basePageWidth) return null
      return matrix
    })
    hasMatrix = matrices.some(function (matrix) {
      return !!matrix
    })
  }

  // R1 之后 pageWidth 恒等于 basePageWidth（条件 7 保证了留下来的每个矩阵节的列宽下限都
  // <= 它）。这里仍然走 Math.max 而不是直接赋值 basePageWidth，是留一道兜底：万一条件 7
  // 本身判断有误，静默丢列的代价比画布多撑一点更高，宁可画布跟着变宽也不要截断内容——
  // 正常路径下这段是 no-op，不改变任何结果。
  let pageWidth = basePageWidth
  if (hasMatrix) {
    pageWidth = matrices.reduce(function (width, matrix, index) {
      if (!matrix) return width
      return Math.max(width, matrixPageWidthFor(sections[index], matrix, measureFn))
    }, pageWidth)
  }

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

  if (hasMatrix) {
    y = layoutSectionedTable(cmds, sections, matrices, raw, specAxisNames(slip.lines), pageWidth, y, measureFn)
  } else {
    // 全表没有任何矩阵节：老单据、明细态、或矩阵条件一条都没满足的汇总态，都走这条
    // 没改过一个字的老路径——tableColumns/fitColumns/layoutTable 的调用方式和改动前相同。
    const cols = fitColumns(raw, pageWidth, measureFn)
    y = layoutTable(cmds, slip, cols, y, measureFn)
  }

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
