/**
 * 账本导出 sheet（稿 4:872）预览与分享文案。
 * 分型笔数 / 金额由客户端对 listRecords 全量结果聚合——服务端 terms
 * 没有分型笔数（docs/cloud-ledger.md OPEN-Q-1），不改云函数。
 */
const inventory = require('./inventory')

const EXPORT_TYPE_ORDER = ['in', 'out', 'pay', 'return', 'convert', 'adjust', 'opening']
const EXPORT_TYPE_LABELS = {
  out: '销售',
  in: '进货',
  pay: '收款',
  return: '退货',
  convert: '改规格',
  adjust: '调整',
  opening: '期初'
}

/** @param {string} key 'month'|'lastMonth'|'all'|'follow'
 *  @param {number} now
 *  @param {string} [followKey] page windowKey when key==='follow'
 */
function exportWindowRange(key, now, followKey) {
  if (key === 'follow') {
    return exportWindowRange(followKey || 'month', now)
  }
  if (key === 'today') {
    const from = inventory.startOfDay(now)
    const next = new Date(from)
    next.setDate(next.getDate() + 1)
    return { from: from, to: next.getTime() }
  }
  if (key === 'month') {
    const d = new Date(now)
    return {
      from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
      to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
    }
  }
  if (key === 'lastMonth') {
    const d = new Date(now)
    return {
      from: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      to: new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    }
  }
  return { from: null, to: null }
}

function exportWindowLabel(key, followKey, followLabel) {
  if (key === 'follow') return followLabel || '本月'
  if (key === 'month') return '本月'
  if (key === 'lastMonth') return '上月'
  if (key === 'all') return '全部'
  if (key === 'today') return '今日'
  return '本月'
}

/**
 * @param {Array<{type:string, amount?:number}>} records
 * @param {string[]} selectedTypes empty or ['all'] => all types
 */
function aggregateByType(records, selectedTypes) {
  const all = !selectedTypes || !selectedTypes.length || selectedTypes.indexOf('all') >= 0
  const want = {}
  if (!all) {
    selectedTypes.forEach(function (t) { want[t] = true })
  }
  const buckets = {}
  EXPORT_TYPE_ORDER.forEach(function (t) {
    buckets[t] = { type: t, label: EXPORT_TYPE_LABELS[t], count: 0, amount: 0 }
  })
  ;(records || []).forEach(function (rec) {
    const t = rec && rec.type
    if (!buckets[t]) return
    if (!all && !want[t]) return
    buckets[t].count += 1
    buckets[t].amount = inventory.round2(buckets[t].amount + inventory.toNumber(rec.amount))
  })
  return EXPORT_TYPE_ORDER.map(function (t) { return buckets[t] })
}

function typesLabel(selectedTypes) {
  if (!selectedTypes || !selectedTypes.length || selectedTypes.indexOf('all') >= 0) {
    return '全部类型'
  }
  return selectedTypes.map(function (t) {
    return EXPORT_TYPE_LABELS[t] || t
  }).join('、')
}

/** 预览卡主行：优先销售/进货（稿样张），其余有笔数的也列出 */
function previewLines(buckets, moneyFmt) {
  const fmt = moneyFmt || function (n) { return '¥' + n.toFixed(2) }
  const lines = []
  const prefer = { out: true, in: true }
  buckets.forEach(function (b) {
    if (!b.count && !prefer[b.type]) return
    if (b.type === 'out') {
      lines.push(b.label + ' ' + b.count + ' 笔 · 应收 ' + fmt(b.amount))
    } else if (b.type === 'in') {
      lines.push(b.label + ' ' + b.count + ' 笔 · ' + fmt(b.amount))
    } else if (b.count) {
      lines.push(b.label + ' ' + b.count + ' 笔 · ' + fmt(b.amount))
    }
  })
  if (!lines.length) {
    lines.push('所选范围暂无流水')
  }
  return lines
}

function previewTitle(windowLabel, selectedTypes) {
  return '预览 · ' + windowLabel + ' · ' + typesLabel(selectedTypes)
}

function shareText(windowLabel, selectedTypes, lines) {
  const head = '账本导出 · ' + windowLabel + ' · ' + typesLabel(selectedTypes)
  return [head].concat(lines || []).join('\n')
}

module.exports = {
  EXPORT_TYPE_ORDER: EXPORT_TYPE_ORDER,
  EXPORT_TYPE_LABELS: EXPORT_TYPE_LABELS,
  exportWindowRange: exportWindowRange,
  exportWindowLabel: exportWindowLabel,
  aggregateByType: aggregateByType,
  typesLabel: typesLabel,
  previewLines: previewLines,
  previewTitle: previewTitle,
  shareText: shareText
}