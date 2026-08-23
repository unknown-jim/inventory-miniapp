// 账本升级预检（阶段 0，T−7 天）。**不部署也能跑，不影响营业。**
//
// 用法：
//   1. 云开发控制台 -> 数据库 -> ledgers -> 导出（JSON / JSONL 都认）
//   2. 可选：另导一份 ledger_clears（只要 _id / shopId / savedAt / bookId / records）
//   3. node scripts/check-ledger-export.js <ledgers 导出文件> [--clears <clears 导出文件>]
//                                          [--json] [--limit 50] [--shop <shopId>]
//
// 为什么要有这个脚本：预检的核心 migrate.checkLedger 是**只吃一份 ledgers 文档
// 的纯函数**，所以能在本机跑。否则就是「必须先部署才能预检、而部署那一刻 12 家
// 店全部停摆（apiVersion 门）」的死结 —— 阶段 0 停下来的代价是零，当晚停下来
// 的代价是全队停摆过夜。
//
// 判据（对应方案 §五 P1–P13）打在每家店的报告里；退出码非零 = 有阻塞项。

const fs = require('fs')
const path = require('path')

const migrate = require(path.join(__dirname, '..', 'cloudfunctions', 'ledger', 'ledger-migrate'))

function usage(message) {
  if (message) console.error(message)
  console.error('用法: node scripts/check-ledger-export.js <ledgers.json> [--clears <ledger_clears.json>] [--json] [--limit N] [--shop <shopId>]')
  process.exit(2)
}

function parseArgs(argv) {
  const out = { file: '', clears: '', json: false, limit: 20, shop: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--clears') out.clears = argv[++i] || ''
    else if (arg === '--limit') out.limit = Number(argv[++i] || 20)
    else if (arg === '--shop') out.shop = argv[++i] || ''
    else if (arg.slice(0, 2) === '--') usage('未知参数 ' + arg)
    else if (!out.file) out.file = arg
    else usage('多余的参数 ' + arg)
  }
  if (!out.file) usage('缺少导出文件')
  return out
}

// 控制台导出有三种形态，全部认：
//   ① JSONL：一行一个文档（微信云开发控制台导出 JSON 时的默认形态）
//   ② 顶层数组
//   ③ { data: [...] } 包一层
// 认不出来就报错，**不要猜** —— 猜错会漏掉整批店，而报告看起来是绿的。
function loadDocs(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed[0] === '[' || (trimmed[0] === '{' && /^\{\s*"data"\s*:/.test(trimmed))) {
    const parsed = JSON.parse(trimmed)
    const list = Array.isArray(parsed) ? parsed : parsed.data
    if (!Array.isArray(list)) throw new Error(file + '：认不出这份导出的结构')
    return list
  }
  const docs = []
  trimmed.split(/\r?\n/).forEach(function (line, at) {
    const row = line.trim()
    if (!row) return
    try {
      docs.push(JSON.parse(row))
    } catch (error) {
      throw new Error(file + ' 第 ' + (at + 1) + ' 行不是合法 JSON：' + error.message)
    }
  })
  return docs
}

function money(value) {
  return (Math.round(Number(value || 0) * 100) / 100).toFixed(2)
}

function head(list, limit) {
  const arr = list || []
  if (arr.length <= limit) return arr
  return arr.slice(0, limit)
}

function printReport(report, limit) {
  const lines = []
  function say(text) { lines.push(text) }
  say('=== 店 ' + report.shopId + '（账套 ' + report.bookId + '）===')
  say('P13 recordsMigratedAt=' + report.recordsMigratedAt
    + ' recordsPending=' + report.recordsPending
    + ' collectionCount=' + (report.collectionCount == null ? '未知（本地脚本看不到集合）' : report.collectionCount)
    + ' importing=' + (report.importing ? JSON.stringify(report.importing) : 'null'))
  say('P1  老记录 ' + report.legacyCount + ' 条 -> 归并后 ' + report.mergedCount + ' 单，共 ' + report.lineCount + ' 行')
  say('P12 账本文档 ' + report.docBytes + ' 字节'
    + (report.docBytes > 3 * 1024 * 1024 ? '  ← 超过 3 MB，当晚迁完立刻跑 dropLegacy' : ''))
  say('P2  形状 销售[实收 ' + report.shapes.salePaid + ' / payType ' + report.shapes.salePayType
    + ' / 都没有 ' + report.shapes.saleNeither + ']'
    + ' 退货[实收 ' + report.shapes.returnPaid + ' / payType ' + report.shapes.returnPayType
    + ' / 都没有 ' + report.shapes.returnNeither + ']'
    + (report.shapes.returnNeither ? '  ← B1 是正在发生的错账，排期提前' : ''))
  // subCent 是归并后的，subCentRaw 是原始记录的。两个都阻塞，两个都要打 ——
  // 只打前者的话，「原始记录有亚分」的店会显示「P3 0 处」而末尾又报阻塞，看着自相矛盾。
  const subCentRaw = report.subCentRaw || []
  say('P3  亚分金额 归并后 ' + report.subCent.length + ' 处 / 原始记录 ' + subCentRaw.length + ' 处'
    + ((report.subCent.length || subCentRaw.length) ? '（两个都必须为空）' : ''))
  head(report.subCent, limit).forEach(function (item) {
    say('      ' + item.id + ' ' + item.field + ' = ' + item.value)
  })
  say('P4  全店欠款 ' + money(report.before.totals.receivable) + ' -> ' + money(report.after.totals.receivable)
    + '，客户级差异 ' + report.diffs.length + ' 项，会动钱的退货单 ' + report.movingChanges.length + ' 张')
  const byReason = {}
  report.movingChanges.forEach(function (item) {
    byReason[item.reason] = (byReason[item.reason] || 0) + 1
  })
  say('      归类：' + (Object.keys(byReason).length ? Object.keys(byReason).map(function (key) {
    return key + '×' + byReason[key]
  }).join(' ') : '无'))
  if (report.unexplainedChanges.length) {
    say('      ← 出现第四类改动，停下来：方案有洞')
    head(report.unexplainedChanges, limit).forEach(function (item) {
      say('      ' + JSON.stringify(item))
    })
  }
  head(report.diffs.filter(function (item) { return item.field === 'creditSalesSum' || item.field === 'creditReturnsSum' || item.field === 'openingsSum' }), limit)
    .forEach(function (item) {
      say('      客户 ' + item.customerId + ' ' + item.field + ' ' + item.before + ' -> ' + item.after + '（分）')
    })
  say('P5  负账户 迁移前 ' + report.negativeBefore.length + ' 个 / 迁移后 ' + report.negativeAfter.length + ' 个'
    + (report.negativeAfter.length ? '  ← 必须为空，否则迁完这家店退货/改单/删单三条路一起卡死' : ''))
  head(report.negativeAfter, limit).forEach(function (item) {
    say('      客户 ' + item.customerId + ' 欠款 ' + money(item.receivable))
  })
  say('P6  孤儿退货 ' + report.orphanReturns.length + ' 张（非阻塞，逐条人工确认）')
  head(report.orphanReturns, limit).forEach(function (item) {
    say('      ' + item.id + ' ' + item.reason)
  })
  say('P7  拆分不变量被破坏 迁移前 ' + report.splitViolationsBefore.length + ' 张 / 迁移后 '
    + report.splitViolationsAfter.length + ' 张' + (report.splitViolationsAfter.length ? '  ← 重算逻辑有洞' : ''))
  head(report.splitViolationsAfter, limit).forEach(function (item) {
    say('      销售单 ' + item.saleId + ' 欠款 ' + item.debt + ' 退货 ' + item.sumReturn + ' 冲抵 ' + item.offset + '（应为 ' + item.want + '）')
  })
  say('P8  returnedQty/Amount 跨行不一致 ' + report.returnedMismatch.length + ' 处'
    + '，returnedAmount 缺失 ' + report.missingReturnedAmount.length + ' 处（缺失非阻塞，读时按 qty×单价 回退）')
  head(report.returnedMismatch, limit).forEach(function (item) {
    say('      ' + JSON.stringify(item))
  })
  say('P9  重复 id ' + report.duplicateIds.length + ' 个 / 空 id ' + report.emptyIds + ' 个')
  say('P10 多行单 ' + report.multiLineOrders.length + ' 张，抽样：')
  head(report.multiLineOrders, Math.min(limit, 20)).forEach(function (item) {
    say('      ' + item.id + ' ' + item.type + ' ' + item.lineCount + ' 行 ' + money(item.amount))
  })
  if (report.mergeProblems.length) {
    say('      归并结构不守恒：' + JSON.stringify(report.mergeProblems))
  }
  const clears = report.clearSnapshots
  say('P11 清空快照 ' + clears.count + ' 份'
    + (clears.count === 0
      ? '（这家店没清过，不会撞上「恢复清空前数据」那条路）'
      : '，最近一份 hasBookId='
        + (clears.latestHasBookId == null ? '没导 ledger_clears，用 --clears 补' : clears.latestHasBookId)
        + (clears.latestHasBookId === false ? '  ← 这家店迁移后「恢复清空前数据」永久报错' : '')))
  say(report.blocking.length
    ? '阻塞项 ' + report.blocking.length + ' 类：' + report.blocking.map(function (item) {
      return item.check + '(' + item.count + ')'
    }).join('，')
    : '阻塞项：无')
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const ledgers = loadDocs(args.file)
  const clears = args.clears ? loadDocs(args.clears) : null
  const reports = []
  ledgers.forEach(function (doc) {
    const shopId = String((doc && (doc._id || doc.id)) || '')
    if (args.shop && shopId !== args.shop) return
    const mine = clears ? clears.filter(function (item) {
      return String((item && item.shopId) || '') === shopId
    }) : null
    reports.push(migrate.checkLedger(doc, { shopId: shopId, clears: mine }))
  })
  if (!reports.length) {
    console.error('导出文件里没有匹配的账本文档')
    process.exit(2)
  }
  const blocked = reports.filter(function (item) { return item.blocking.length })
  if (args.json) {
    process.stdout.write(JSON.stringify({
      generatedAt: Date.now(),
      source: path.basename(args.file),
      shopCount: reports.length,
      blockedShopIds: blocked.map(function (item) { return item.shopId }),
      reports: reports
    }, null, 2) + '\n')
  } else {
    reports.forEach(function (report) {
      console.log(printReport(report, args.limit))
      console.log('')
    })
    const totalMerged = reports.reduce(function (sum, item) { return sum + item.mergedCount }, 0)
    console.log('共 ' + reports.length + ' 家店，归并后合计 ' + totalMerged + ' 单。'
      + (blocked.length
        ? '有 ' + blocked.length + ' 家店存在阻塞项：' + blocked.map(function (item) { return item.shopId }).join('、')
          + ' —— 停在阶段 0，先人工处理。'
        : '没有阻塞项，可以进阶段 1。'))
  }
  process.exit(blocked.length ? 1 : 0)
}

try {
  main()
} catch (error) {
  console.error(error.message || error)
  process.exit(2)
}
