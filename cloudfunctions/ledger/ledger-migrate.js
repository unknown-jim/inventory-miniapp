const apply = require('./ledger-apply')
const inventory = require('./inventory')
const recordsModule = require('./ledger-records')

// 账本升级（2b-1b）：把 ledgers.records 数组里的老流水搬进 ledger_records 集合。
//
// **这个文件不参与 `npm run sync:ledger-inventory`**：同步的仍然只有
// utils/inventory.js 和 utils/ledger-apply.js。这里有 IO（读集合、开事务），
// 放进 utils/ 会破坏那两个文件「零 IO、零数据库句柄」的结构保证。
//
// 三个 action，全部 owner-gated、全部过 apiVersion 门、全部不走 applyMutation：
//   checkAggregates      只读预检。核心是纯函数 checkLedger(ledger)，只吃一份
//                        ledgers 文档 —— 所以**不部署也能跑**（控制台导出 JSON +
//                        scripts/check-ledger-export.js），这解开了「必须先部署
//                        才能预检、而部署等于全队停摆」的死结。
//   migrateRecords       搬家。状态机落在 ledgers/{shopId}.migration。
//   recomputeAggregates  聚合漂了之后按集合现状重折叠。
//
// 用到的索引（都在 ledger-records.js 顶部那 6 条里，不新增）：
//   #1 bookId ASC, sortKey DESC —— pageDocs（写完校验、重算折叠）
//
// 写路径的冻结**不在这里**：assertRecordsReady（ledger-core.js）已经挡住了未
// 迁移账本的每一条写。不要再引入第二个 ledgers.migration.state 冻结开关 ——
// 两个冻结口径迟早会打架。
//
// 一次调用只推进一个阶段，理由见 migrateRecords 上方注释。

// 一次调用写多少条。事务外写，所以这个数不受「单事务写入条数上限」约束，
// 只影响单次往返的时长（云函数超时 20 秒）。
const MIGRATE_CHUNK_DEFAULT = 50
const MIGRATE_CHUNK_MAX = 500
// checkAggregates 对已迁移账套翻页的上限，判**条数**不判页数
//（样板见 ledger-records.js 的 SUFFIX_MAX_RECORDS）。到顶报错，不做无界翻页。
const AUDIT_MAX_RECORDS = 5000
// recomputeAggregates 的同一道界。两者是不同的量（一个管诊断翻多远、一个管
// 重算翻多远），互不影响，所以各给一个常量。
const RECOMPUTE_MAX_RECORDS = 5000
// 返回包里每份明细列表最多带几条 + 总数。纯函数返回**全量**，截断只发生在
// 带 IO 的壳里 —— 本地脚本要拿全量自己排版。
const REPORT_LIST_LIMIT = 50

const PAGE_LIMIT = recordsModule.PAGE_LIMIT

// ---------------------------------------------------------------------------
// 纯函数层：预检和迁移校验共用同一份定义。
// 「预检说没问题、迁移却出问题」在结构上不可能 —— 因为是同一个函数。
// ---------------------------------------------------------------------------

// 深比对，两条口径：key 顺序无关；**undefined ≡ 缺字段**（null 不算，null 是
// 一个真的值）。文档往返之后「本来就没有这个 key」和「值是 undefined」必须
// 判成一样，否则 V2 会被一堆假阳性淹掉。
function stableEqual(a, b) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b)
  }
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const arrayA = Array.isArray(a)
  if (arrayA !== Array.isArray(b)) return false
  if (arrayA) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!stableEqual(a[i], b[i])) return false
    }
    return true
  }
  const names = {}
  Object.keys(a).forEach(function (key) {
    if (a[key] !== undefined) names[key] = true
  })
  Object.keys(b).forEach(function (key) {
    if (b[key] !== undefined) names[key] = true
  })
  const keys = Object.keys(names)
  for (let i = 0; i < keys.length; i++) {
    if (!stableEqual(a[keys[i]], b[keys[i]])) return false
  }
  return true
}

// 逐条差在哪个顶层 key 上。失败报告里给出来，不然只知道「不相等」没法查。
function diffKeysOf(a, b) {
  const names = {}
  Object.keys(a || {}).forEach(function (key) {
    if (a[key] !== undefined) names[key] = true
  })
  Object.keys(b || {}).forEach(function (key) {
    if (b[key] !== undefined) names[key] = true
  })
  return Object.keys(names).filter(function (key) {
    return !stableEqual((a || {})[key], (b || {})[key])
  })
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function byteLength(text) {
  const s = String(text == null ? '' : text)
  if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(s, 'utf8')
  // 退路：没有 Buffer 的宿主里按 UTF-8 手算，宁可慢也不要给一个错的字节数
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code < 0xdc00) { bytes += 4; i += 1 }
    else bytes += 3
  }
  return bytes
}

// 只归并、不重算。这是**线上此刻**看到的那份数字（repairReturnSplits 是
// 2b-1a 刚加上的修复），预检报告里的 before 一列就是它。
function mergeOnly(records) {
  const list = records || []
  return inventory.needsRecordMigration(list)
    ? inventory.migrateRecordShape(list)
    : list
}

// 一条流水占几行。老的扁平记录一条就是一行；收款 / 期初没有明细（legacyOrder
// 给 lines: []），所以是 0 行。V9「归并前后行数相等」两端都用这份定义。
function lineCountOf(record) {
  if (!record) return 0
  if (Array.isArray(record.lines)) return record.lines.length
  const type = record.type
  if (type === 'pay' || type === 'opening') return 0
  return 1
}

function sumLineCount(records) {
  return (records || []).reduce(function (sum, item) {
    return sum + lineCountOf(item)
  }, 0)
}

function countByType(records) {
  const out = {}
  ;(records || []).forEach(function (item) {
    const type = String((item && item.type) || '')
    out[type] = (out[type] || 0) + 1
  })
  return out
}

function sortDesc(records) {
  return (records || []).slice().sort(function (a, b) {
    const ka = apply.makeSortKey(a && a.createdAt, a && a.id)
    const kb = apply.makeSortKey(b && b.createdAt, b && b.id)
    if (ka === kb) return 0
    return ka > kb ? -1 : 1
  })
}

function hasMoney(value) {
  return !(value == null || value === '')
}

// 六种形状（P2）。生产上**应该**是纯代 A（销售和退货都只有 payType）；
// returnNeither > 0 就说明 B1 是正在发生的错账，排期要提前。
function shapesOf(records) {
  const out = {
    salePaid: 0, salePayType: 0, saleNeither: 0,
    returnPaid: 0, returnPayType: 0, returnNeither: 0
  }
  ;(records || []).forEach(function (item) {
    const type = item && item.type
    if (type !== 'out' && type !== 'return') return
    const prefix = type === 'out' ? 'sale' : 'return'
    if (hasMoney(item.paidAmount)) out[prefix + 'Paid'] += 1
    else if (item.payType) out[prefix + 'PayType'] += 1
    else out[prefix + 'Neither'] += 1
  })
  return out
}

// V12 / D2：判据是「所有金额都是 round2() 的输出」，**不重抄一份浮点老算法
// 当参照**（那是第二份会漂的定义）。全过 = 整数分与浮点必然同解。
const MONEY_RECORD_KEYS = ['amount', 'profit', 'paidAmount']
const MONEY_LINE_KEYS = ['amount', 'profit', 'unitPrice', 'costPrice', 'returnedAmount']
function isWholeCent(value) {
  if (!hasMoney(value)) return true
  const n = Number(value)
  if (!Number.isFinite(n)) return true
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-9
}

function subCentOf(records) {
  const bad = []
  ;(records || []).forEach(function (record) {
    if (!record) return
    MONEY_RECORD_KEYS.forEach(function (key) {
      if (!isWholeCent(record[key])) {
        bad.push({ id: String(record.id || ''), field: key, value: record[key] })
      }
    })
    inventory.recordLines(record).forEach(function (line, at) {
      MONEY_LINE_KEYS.forEach(function (key) {
        if (!isWholeCent(line && line[key])) {
          bad.push({ id: String(record.id || ''), field: 'lines[' + at + '].' + key, value: line[key] })
        }
      })
    })
  })
  return bad
}

// V8：归并散架（重复 id）或过头（空 id）
function idProblemsOf(records) {
  const seen = Object.create(null)
  const duplicateIds = []
  let emptyIds = 0
  ;(records || []).forEach(function (record) {
    const id = String((record && record.id) || '')
    if (!id) {
      emptyIds += 1
      return
    }
    if (seen[id]) {
      if (duplicateIds.indexOf(id) < 0) duplicateIds.push(id)
      return
    }
    seen[id] = true
  })
  return { duplicateIds: duplicateIds, emptyIds: emptyIds }
}

function salesById(records) {
  const out = Object.create(null)
  ;(records || []).forEach(function (item) {
    if (item && item.type === 'out' && item.id) out[String(item.id)] = item
  })
  return out
}

function saleIdOfReturn(record) {
  return String((inventory.recordLines(record)[0] || {}).saleOrderId || '')
}

// V11 / P6：份额修不了的退货单。两类：单头没指向任何销售单，或指向的销售单
// 不在这份流水里（跨账套 / 已删）。**保守回推值只对代 B 孤儿是保守的**，
// 代 A / 代 C 的孤儿仍然可能折出负账户，别假设「孤儿一定非负」。
function orphanReturnsOf(records) {
  const sales = salesById(records)
  const out = []
  ;(records || []).forEach(function (item) {
    if (!item || item.type !== 'return') return
    const saleId = saleIdOfReturn(item)
    if (!saleId) {
      out.push({ id: String(item.id || ''), saleOrderId: '', reason: '退货单头没有 saleOrderId' })
      return
    }
    if (!sales[saleId]) {
      out.push({ id: String(item.id || ''), saleOrderId: saleId, reason: '被退销售单不在这本账里' })
    }
  })
  return out
}

// V4 / P8：销售行 returnedQty == 名下退货行 qty 之和，returnedAmount 同理。
// returnedAmount 缺失是老流水的合法形态（读时回退 returnedQty × 单价），
// 所以只在字段真的存在时比金额，缺的那些单独报 missingReturnedAmount。
// 分组键的分隔符用 \u0000：id 里不可能出现它，用空格 / 下划线 / 短横都可能被
// id 本身撞上，撞了就是把两组退货并成一组、静默给出一条假的「不一致」。
// **写成转义、不要在源码里放裸 NUL 字节** —— 那会让 grep / diff 把整个文件当二进制。
const KEY_SEP = '\u0000'
function returnedMismatchOf(records) {
  const sales = salesById(records)
  const tally = Object.create(null)
  ;(records || []).forEach(function (item) {
    if (!item || item.type !== 'return') return
    const saleId = saleIdOfReturn(item)
    if (!saleId) return
    inventory.recordLines(item).forEach(function (line) {
      const key = saleId + KEY_SEP + String((line && line.saleLineId) || '')
      const got = tally[key] || { qty: 0, amount: 0 }
      got.qty = inventory.round2(got.qty + inventory.toNumber(line && line.qty))
      got.amount = inventory.round2(got.amount + inventory.toNumber(line && line.amount))
      tally[key] = got
    })
  })
  const bad = []
  const missingReturnedAmount = []
  Object.keys(tally).forEach(function (key) {
    const parts = key.split(KEY_SEP)
    const sale = sales[parts[0]]
    if (!sale) return
    const line = inventory.recordLines(sale).find(function (item) {
      return String((item && item.lineId) || '') === parts[1]
    })
    if (!line) {
      bad.push({ saleId: parts[0], lineId: parts[1], field: 'saleLineId', reason: '退货指向的销售行不存在' })
    }
  })
  ;(records || []).forEach(function (sale) {
    if (!sale || sale.type !== 'out') return
    inventory.recordLines(sale).forEach(function (line) {
      const key = String(sale.id || '') + KEY_SEP + String((line && line.lineId) || '')
      const got = tally[key] || { qty: 0, amount: 0 }
      const qty = inventory.round2(inventory.toNumber(line && line.returnedQty))
      if (qty !== got.qty) {
        bad.push({
          saleId: String(sale.id || ''), lineId: String((line && line.lineId) || ''),
          field: 'returnedQty', stored: qty, fromReturns: got.qty
        })
      }
      if (!hasMoney(line && line.returnedAmount)) {
        if (got.qty) {
          missingReturnedAmount.push({
            saleId: String(sale.id || ''), lineId: String((line && line.lineId) || ''),
            fromReturns: got.amount
          })
        }
        return
      }
      const amount = inventory.round2(line.returnedAmount)
      if (amount !== got.amount) {
        bad.push({
          saleId: String(sale.id || ''), lineId: String((line && line.lineId) || ''),
          field: 'returnedAmount', stored: amount, fromReturns: got.amount
        })
      }
    })
  })
  return { returnedMismatch: bad, missingReturnedAmount: missingReturnedAmount }
}

// V5 / P7：【拆分不变量】Σ(rᵢ − settledAmount(rᵢ)) == min(D, Σrᵢ)。
// **B1 的直接判据** —— 只比条数抓不住它。
function splitViolationsOf(records) {
  const bad = []
  const groups = Object.create(null)
  ;(records || []).forEach(function (item) {
    if (!item || item.type !== 'return') return
    const saleId = saleIdOfReturn(item)
    if (!saleId) return
    if (!groups[saleId]) groups[saleId] = []
    groups[saleId].push(item)
  })
  ;(records || []).forEach(function (sale) {
    if (!sale || sale.type !== 'out') return
    const rets = groups[String(sale.id || '')]
    if (!rets || !rets.length) return
    const debt = inventory.round2(inventory.toNumber(sale.amount) - inventory.settledAmount(sale))
    const sumReturn = inventory.round2(rets.reduce(function (acc, item) {
      return acc + inventory.toNumber(item.amount)
    }, 0))
    const offset = inventory.round2(rets.reduce(function (acc, item) {
      return acc + (inventory.toNumber(item.amount) - inventory.settledAmount(item))
    }, 0))
    const want = Math.min(debt, sumReturn)
    if (offset !== want) {
      bad.push({ saleId: String(sale.id || ''), debt: debt, sumReturn: sumReturn, offset: offset, want: want })
    }
  })
  return bad
}

// V6 / P5：负账户。一个负账户 = 这家店从此退不了货、改不了单、删不了单
//（assertAccountsValid 是全账户扫描，被 applyReturnOrder / updateRecord /
// deleteRecord 三处调用）。
function negativeAccountsOf(accounts) {
  const bad = []
  Object.keys(accounts || {}).forEach(function (customerId) {
    const account = inventory.accountOf(accounts[customerId])
    if (account.receivable < 0) {
      bad.push({ customerId: customerId, receivable: account.receivable })
    }
  })
  return bad
}

// P10：多行单抽样，人眼过一遍归并有没有把不该并的并进来
function multiLineOrdersOf(records) {
  const out = []
  ;(records || []).forEach(function (item) {
    const lines = inventory.recordLines(item)
    if (lines.length <= 1) return
    out.push({
      id: String((item && item.id) || ''), type: String((item && item.type) || ''),
      lineCount: lines.length, amount: inventory.toNumber(item && item.amount)
    })
  })
  return out
}

function receivableMapOf(accounts) {
  const out = {}
  Object.keys(accounts || {}).forEach(function (customerId) {
    out[customerId] = inventory.accountOf(accounts[customerId]).receivable
  })
  return out
}

// V4..V12 的唯一定义。预检、迁移校验、已迁移账套的漂移诊断三处共用。
function auditRecords(records) {
  const list = records || []
  const accounts = inventory.foldAccountTerms(list)
  const aggregate = inventory.foldTotalTerms(list)
  const ids = idProblemsOf(list)
  const returned = returnedMismatchOf(list)
  return {
    count: list.length,
    lineCount: sumLineCount(list),
    typeCount: countByType(list),
    shapes: shapesOf(list),
    duplicateIds: ids.duplicateIds,
    emptyIds: ids.emptyIds,
    orphanReturns: orphanReturnsOf(list),
    returnedMismatch: returned.returnedMismatch,
    missingReturnedAmount: returned.missingReturnedAmount,
    splitViolations: splitViolationsOf(list),
    subCent: subCentOf(list),
    multiLineOrders: multiLineOrdersOf(list),
    accounts: accounts,
    aggregate: aggregate,
    negativeAccounts: negativeAccountsOf(accounts),
    receivable: receivableMapOf(accounts),
    totals: inventory.totalsOf(aggregate)
  }
}

// 归并前后的结构守恒（V9 / V10）。
// V10 的形式是「除 out 以外每种 type 的条数一条不许少」+「总条数差恰好等于
// out 少掉的那些」—— 这样既不用复抄一份归并 key 规则（第二份定义会漂），
// 也能抓住「非 out 被按 orderId 归并把退货并进销售单」。
function mergeShapeChecks(legacy, merged) {
  const before = countByType(legacy)
  const after = countByType(merged)
  const problems = []
  Object.keys(before).forEach(function (type) {
    if (type === 'out') return
    if ((after[type] || 0) !== before[type]) {
      problems.push({
        check: 'V10', type: type, before: before[type], after: after[type] || 0,
        reason: '归并把非 out 的记录并掉了'
      })
    }
  })
  const drop = (legacy || []).length - (merged || []).length
  const outDrop = (before.out || 0) - (after.out || 0)
  if (drop !== outDrop) {
    problems.push({ check: 'V10', reason: '条数差和被并掉的销售单数对不上', drop: drop, outDrop: outDrop })
  }
  const lineBefore = sumLineCount(legacy)
  const lineAfter = sumLineCount(merged)
  if (lineBefore !== lineAfter) {
    problems.push({ check: 'V9', reason: '归并前后行数不等', before: lineBefore, after: lineAfter })
  }
  return { problems: problems, lineBefore: lineBefore, lineAfter: lineAfter, drop: drop, outDrop: outDrop }
}

function termsDiff(before, after, scope, customerId) {
  const out = []
  const a = before || inventory.emptyTerms()
  const b = after || inventory.emptyTerms()
  const names = {}
  Object.keys(a).forEach(function (key) { names[key] = true })
  Object.keys(b).forEach(function (key) { names[key] = true })
  Object.keys(names).forEach(function (field) {
    const x = inventory.toNumber(a[field])
    const y = inventory.toNumber(b[field])
    if (x === y) return
    const item = { scope: scope || 'aggregate', field: field, before: x, after: y }
    if (customerId) item.customerId = customerId
    out.push(item)
  })
  return out
}

function accountsDiff(before, after) {
  const names = {}
  Object.keys(before || {}).forEach(function (key) { names[key] = true })
  Object.keys(after || {}).forEach(function (key) { names[key] = true })
  let out = []
  Object.keys(names).forEach(function (customerId) {
    out = out.concat(termsDiff(
      (before || {})[customerId], (after || {})[customerId], 'customer', customerId
    ))
  })
  return out
}

// 重算会把哪些客户的钱改掉，以及为什么（P4）。
// 每条 movingChange 必须能归到三类之一：
//   B2            退货单头挂着改客户之前的旧 customerId
//   genB          代 B 的退货单两个结算字段都没有，被回推成整笔退现金
//   payTypeStale  改过销售单结算档，退货单的 payType 没跟着改
// 冒出第四类（other）说明这个方案有洞，**停下来**，不要照修。
//
// raw = 未归并的原始记录（可选，但预检必须传）。**归因一定要看原始记录**：
// legacyOrder 会给每张 out / return 补上 paidAmount，所以在归并结果上归因时，
// 一张「payType 过期」的代 A 退货单看起来是「本来就有 paidAmount、值却变了」，
// 会被误判成第四类，把一次正常的预检报成「方案有洞」。归并后的退货单 id 就是
// 原始记录的 id（只有 out 按 orderId 归并），所以按 id 取得回来。
function movingChangesOf(before, after, raw) {
  const beforeById = Object.create(null)
  ;(before || []).forEach(function (item) {
    if (item && item.id) beforeById[String(item.id)] = item
  })
  const rawById = Object.create(null)
  ;(raw || []).forEach(function (item) {
    if (item && item.id) rawById[String(item.id)] = item
  })
  const out = []
  ;(after || []).forEach(function (item) {
    if (!item || item.type !== 'return') return
    const id = String(item.id || '')
    const was = beforeById[id]
    if (!was) return
    const settledBefore = inventory.settledAmount(was)
    const settledAfter = inventory.settledAmount(item)
    const customerBefore = String(was.customerId || '')
    const customerAfter = String(item.customerId || '')
    if (settledBefore === settledAfter && customerBefore === customerAfter) return
    const src = rawById[id] || was
    let reason = 'other'
    if (customerBefore !== customerAfter) reason = 'B2'
    else if (!hasMoney(src.paidAmount) && !src.payType) reason = 'genB'
    else if (!hasMoney(src.paidAmount) && src.payType) reason = 'payTypeStale'
    out.push({
      id: String(item.id || ''), saleOrderId: saleIdOfReturn(item), reason: reason,
      customerBefore: customerBefore, customerAfter: customerAfter,
      settledBefore: settledBefore, settledAfter: settledAfter
    })
  })
  return out
}

// P11：升级前存下来的清空快照。没有 bookId 的那些，迁移之后「恢复清空前数据」
// 永久报错 —— 只报数不转换（转换要为每份老快照发账套 + 逐条写集合，是第二个
// 无界写循环，见方案 §六-(e)）。clears 可选：控制台另导一份 ledger_clears 才有。
function clearSnapshotsOf(ledger, clears) {
  const metas = (ledger && ledger.clearSnapshots) || []
  const byId = Object.create(null)
  ;(clears || []).forEach(function (doc) {
    const id = String((doc && (doc._id || doc.id)) || '')
    if (id) byId[id] = doc
  })
  const list = metas.map(function (meta) {
    const doc = byId[String((meta && meta.id) || '')]
    return {
      id: String((meta && meta.id) || ''),
      savedAt: inventory.toNumber(meta && meta.savedAt),
      known: !!doc,
      hasBookId: doc ? !!doc.bookId : null,
      legacyRecordCount: doc ? ((doc.records || []).length) : null
    }
  })
  const latest = list.length ? list[list.length - 1] : null
  return {
    count: list.length,
    // 小程序只恢复最近一次，所以真正会报错的只有这一份
    latestHasBookId: latest ? latest.hasBookId : null,
    latestKnown: latest ? latest.known : false,
    lastRestoredClearAt: inventory.toNumber(ledger && ledger.lastRestoredClearAt),
    hasLegacyClearedBackup: !!(ledger && ledger.clearedBackup),
    snapshots: list
  }
}

// P1–P13 的唯一定义。**只吃一份 ledgers 文档**，没有任何 IO ——
// 所以控制台导出 JSON 之后能在本机跑（scripts/check-ledger-export.js）。
// options = { shopId?, clears? }
function checkLedger(ledger, options) {
  options = options || {}
  const doc = ledger || {}
  const shopId = String(options.shopId || doc._id || doc.id || '')
  const bookId = String(doc.bookId || shopId)
  const legacy = (doc.records || [])
  // before / after 各用一份深拷贝：migrateRecordShape 的 backfillReturnedQty 会
  // 就地改 line.returnedQty，两趟共用同一份输入会互相污染。
  const raw = deepClone(legacy)
  const before = mergeOnly(deepClone(legacy))
  const after = apply.legacyRecordsOf({ records: deepClone(legacy) })
  const auditBefore = auditRecords(before)
  const auditAfter = auditRecords(after)
  const shape = mergeShapeChecks(legacy, after)
  const moving = movingChangesOf(before, after, raw)
  const report = {
    shopId: shopId,
    bookId: bookId,
    recordsMigratedAt: inventory.toNumber(doc.recordsMigratedAt),
    recordsPending: apply.recordsPending(doc),
    importing: doc.importing ? { token: String(doc.importing.token || ''), nextSeq: inventory.toNumber(doc.importing.nextSeq), count: inventory.toNumber(doc.importing.count) } : null,
    migration: doc.migration || null,
    revision: inventory.toNumber(doc.revision),
    // P1：各店条数的答案。决定 limit 和当晚时长。
    legacyCount: legacy.length,
    mergedCount: after.length,
    lineCount: auditAfter.lineCount,
    // P12：迁移**不会**让账本文档变小；> 3 MB 的店当晚迁完立刻 dropLegacy
    docBytes: byteLength(JSON.stringify(doc)),
    // P2：**按未归并的原始记录数**。归并会给每张 out / return 单头补上
    // paidAmount（legacyOrder），所以在 merged 上数形状只会看到「代 C」，
    // 那正好把「这本账里存的是哪一代」这个唯一想问的问题抹掉。
    shapes: shapesOf(raw),
    // P3：必须为空。这是 D2。两份都要看 ——
    // subCent 是**会被写进集合**的那份（决定迁移之后整数分折叠对不对），
    // subCentRaw 是原始记录（决定 M5「迁移前后 getSlip 相等」还成不成立）。
    subCent: auditAfter.subCent,
    subCentRaw: subCentOf(raw),
    // P4：每条 movingChange 必须能归到三类之一
    before: { totals: auditBefore.totals, receivable: auditBefore.receivable },
    after: { totals: auditAfter.totals, receivable: auditAfter.receivable },
    diffs: accountsDiff(auditBefore.accounts, auditAfter.accounts),
    movingChanges: moving,
    unexplainedChanges: moving.filter(function (item) { return item.reason === 'other' }),
    // P5：negativeAfter 必须为空
    negativeBefore: auditBefore.negativeAccounts,
    negativeAfter: auditAfter.negativeAccounts,
    // P6：记录在案，非阻塞
    orphanReturns: auditAfter.orphanReturns,
    // P7 / P8 / P9
    splitViolationsBefore: auditBefore.splitViolations,
    splitViolationsAfter: auditAfter.splitViolations,
    returnedMismatch: auditAfter.returnedMismatch,
    missingReturnedAmount: auditAfter.missingReturnedAmount,
    duplicateIds: auditAfter.duplicateIds,
    emptyIds: auditAfter.emptyIds,
    // P10
    multiLineOrders: auditAfter.multiLineOrders,
    mergeProblems: shape.problems,
    // P11
    clearSnapshots: clearSnapshotsOf(doc, options.clears),
    // P13：collectionCount 由带 IO 的壳补上（纯函数看不到集合）
    collectionCount: null
  }
  report.blocking = blockingOf(report)
  return report
}

// 阻塞项：不为空就停下来。孤儿退货（P6）和 missingReturnedAmount 是**非阻塞**的，
// 逐条人工确认即可。
function blockingOf(report) {
  const out = []
  function add(name, list) {
    const n = Array.isArray(list) ? list.length : inventory.toNumber(list)
    if (n) out.push({ check: name, count: n })
  }
  add('P3 亚分金额', report.subCent)
  add('P3 亚分金额（原始记录）', report.subCentRaw)
  add('P4 无法归类的改动', report.unexplainedChanges)
  add('P5 迁移后仍有负账户', report.negativeAfter)
  add('P7 拆分不变量仍被破坏', report.splitViolationsAfter)
  add('P8 returnedQty/Amount 跨行不一致', report.returnedMismatch)
  add('P9 重复 id', report.duplicateIds)
  add('P9 空 id', report.emptyIds)
  add('V9/V10 归并结构不守恒', report.mergeProblems)
  return out
}

// 一页原始文档 vs 内存里那份 merged 的同一段（两边都按 sortKey 倒序）。
// V2 + V7。V1（条数）在翻完之后统一判。
function verifyChunk(wanted, docs, bookId, shopId) {
  const problems = []
  const n = Math.max((wanted || []).length, (docs || []).length)
  for (let i = 0; i < n; i++) {
    const doc = docs[i]
    const want = wanted[i]
    if (!doc) {
      problems.push({ check: 'V1', id: String((want && want.id) || ''), reason: '集合里少了这条' })
      continue
    }
    if (!want) {
      problems.push({ check: 'V1', id: String(doc.id || ''), reason: '集合里多出这条' })
      continue
    }
    const wantDoc = apply.toRecordDoc(want, bookId, shopId)
    if (String(doc._id || '') !== wantDoc._id) {
      problems.push({ check: 'V7', id: String(want.id || ''), field: '_id', got: String(doc._id || ''), want: wantDoc._id })
    }
    if (String(doc.sortKey || '') !== wantDoc.sortKey) {
      problems.push({ check: 'V7', id: String(want.id || ''), field: 'sortKey', got: String(doc.sortKey || ''), want: wantDoc.sortKey })
    }
    if (String(doc.bookId || '') !== wantDoc.bookId) {
      problems.push({ check: 'V7', id: String(want.id || ''), field: 'bookId', got: String(doc.bookId || ''), want: wantDoc.bookId })
    }
    if (String(doc.shopId || '') !== wantDoc.shopId) {
      problems.push({ check: 'V7', id: String(want.id || ''), field: 'shopId', got: String(doc.shopId || ''), want: wantDoc.shopId })
    }
    const roundTrip = apply.fromRecordDoc(doc)
    if (!stableEqual(roundTrip, want)) {
      problems.push({ check: 'V2', id: String(want.id || ''), fields: diffKeysOf(roundTrip, want) })
    }
  }
  return problems
}

// 全量版：V1 + V2 + V3 + V7。给测试和「一次能拿到全部文档」的调用方用；
// 迁移动作按页跑 verifyChunk 再在末尾补 V1 / V3，两条路的判据是同一份代码。
function verifyMigrated(merged, docs, bookId, shopId) {
  const wanted = sortDesc(merged)
  const sorted = (docs || []).slice().sort(function (a, b) {
    const ka = String((a && a.sortKey) || '')
    const kb = String((b && b.sortKey) || '')
    if (ka === kb) return 0
    return ka > kb ? -1 : 1
  })
  let problems = verifyChunk(wanted, sorted, bookId, shopId)
  if (wanted.length !== sorted.length) {
    problems = problems.concat([{ check: 'V1', reason: '条数不等', want: wanted.length, got: sorted.length }])
  }
  const readBack = sorted.map(apply.fromRecordDoc)
  problems = problems.concat(foldProblems(
    { accounts: inventory.foldAccountTerms(readBack), aggregate: inventory.foldTotalTerms(readBack) },
    { accounts: inventory.foldAccountTerms(wanted), aggregate: inventory.foldTotalTerms(wanted) }
  ))
  return problems
}

// V3：读回折叠 **逐字段 ===** 内存那份折叠（整数分，可以要求精确相等）
function foldProblems(got, want) {
  return accountsDiff(want.accounts, got.accounts).map(function (item) {
    return Object.assign({ check: 'V3' }, item)
  }).concat(termsDiff(want.aggregate, got.aggregate, 'aggregate').map(function (item) {
    return Object.assign({ check: 'V3' }, item)
  }))
}

// ---------------------------------------------------------------------------
// 带 IO 的壳
// ---------------------------------------------------------------------------

// 首个账套 bookId = shopId（方案 C2，与 ledger-core.withBookId 一致）。
// 这里内联而不是 require('./ledger-core')：那会绕成循环依赖。
function bookOf(ledger, shopId) {
  return String((ledger && ledger.bookId) || shopId || '')
}

function clampChunk(limit) {
  const n = Math.floor(inventory.toNumber(limit))
  if (!n || n < 1) return MIGRATE_CHUNK_DEFAULT
  return Math.min(n, MIGRATE_CHUNK_MAX)
}

function clampReportLimit(limit) {
  const n = Math.floor(inventory.toNumber(limit))
  if (!n || n < 1) return REPORT_LIST_LIMIT
  return n
}

// 明细一律截断到 limit 条 + 总数。**只在壳里截断**：纯函数返回全量，
// 本地脚本要拿全量自己排版。
const REPORT_LISTS = [
  'subCent', 'subCentRaw', 'diffs', 'movingChanges', 'unexplainedChanges', 'negativeBefore',
  'negativeAfter', 'orphanReturns', 'splitViolationsBefore', 'splitViolationsAfter',
  'returnedMismatch', 'missingReturnedAmount', 'duplicateIds', 'multiLineOrders',
  'mergeProblems', 'blocking'
]
function truncateReport(report, limit) {
  const out = Object.assign({}, report)
  REPORT_LISTS.forEach(function (name) {
    const list = out[name]
    if (!Array.isArray(list)) return
    out[name + 'Total'] = list.length
    if (list.length > limit) out[name] = list.slice(0, limit)
  })
  if (out.clearSnapshots && Array.isArray(out.clearSnapshots.snapshots)) {
    out.clearSnapshots = Object.assign({}, out.clearSnapshots, {
      snapshots: out.clearSnapshots.snapshots.slice(0, limit)
    })
  }
  return out
}

async function readAllDocs(store, cap) {
  let cursor = ''
  const docs = []
  for (;;) {
    const got = await store.pageDocs({ cursor: cursor, limit: PAGE_LIMIT })
    for (let i = 0; i < got.docs.length; i++) docs.push(got.docs[i])
    // 上限判**条数**不判页数（ledger-records.js 的 SUFFIX_MAX_RECORDS 那份样板）
    if (docs.length > cap) {
      throw new Error('这本账的流水超过 ' + cap + ' 条，超出一次能扫完的范围，请联系开发者处理')
    }
    if (got.docs.length < got.limit) return docs
    cursor = String(got.docs[got.docs.length - 1].sortKey || '')
  }
}

// 3.1 checkAggregates —— 只读预检。不开事务，纯读无副作用。
async function checkAggregates(db, shopId, payload) {
  payload = payload || {}
  const limit = clampReportLimit(payload.limit)
  const raw = await db.getLedger(shopId)
  if (!raw) {
    throw new Error('店铺账本不存在')
  }
  const bookId = bookOf(raw, shopId)
  const store = recordsModule.recordStore(db.recordsCtx(), bookId, shopId)
  if (apply.recordsPending(raw)) {
    const report = checkLedger(raw, { shopId: shopId })
    // P13：非 0 = 上次尝试的残骸，用 newBook: true 换一本。
    // blocking 是纯函数在上面算完的，那时还看不到集合，所以这一项要在这里补进去
    // —— 不补的话预检会报「阻塞项：无」，而 initMigration 当场就会拒绝，
    // 操作者在阶段 0 看不到、要到当晚才撞上。
    report.collectionCount = await store.countAll()
    if (report.collectionCount) {
      report.blocking.push({
        key: 'P13',
        label: '目标账套里已有 ' + report.collectionCount + ' 条流水（上次尝试的残骸）',
        count: report.collectionCount,
        hint: '来路不明就直接 newBook: true 换一本账套；restart 不会删残骸'
      })
    }
    report.migrated = false
    return truncateReport(report, limit)
  }
  // 已迁移：翻完账套跑同一套 auditRecords，与账本里存的聚合逐字段比。
  // aggregatesStale 哨兵只说「有漂」，这里说「漂在哪个客户的哪一项」。
  const docs = await readAllDocs(store, AUDIT_MAX_RECORDS)
  const list = docs.map(apply.fromRecordDoc)
  const audit = auditRecords(list)
  const aggregateDiffs = foldProblems(
    { accounts: raw.accounts || {}, aggregate: raw.aggregate || inventory.emptyTerms() },
    { accounts: audit.accounts, aggregate: audit.aggregate }
  )
  const report = {
    shopId: String(shopId),
    bookId: bookId,
    migrated: true,
    recordsPending: false,
    recordsMigratedAt: inventory.toNumber(raw.recordsMigratedAt),
    migration: raw.migration || null,
    revision: inventory.toNumber(raw.revision),
    legacyCount: (raw.records || []).length,
    collectionCount: docs.length,
    lineCount: audit.lineCount,
    docBytes: byteLength(JSON.stringify(raw)),
    shapes: audit.shapes,
    subCent: audit.subCent,
    negativeAfter: audit.negativeAccounts,
    orphanReturns: audit.orphanReturns,
    splitViolationsAfter: audit.splitViolations,
    returnedMismatch: audit.returnedMismatch,
    missingReturnedAmount: audit.missingReturnedAmount,
    duplicateIds: audit.duplicateIds,
    emptyIds: audit.emptyIds,
    multiLineOrders: audit.multiLineOrders,
    aggregateDiffs: aggregateDiffs,
    aggregatesStale: aggregateDiffs.length > 0,
    after: { totals: audit.totals, receivable: audit.receivable },
    clearSnapshots: clearSnapshotsOf(raw, null)
  }
  report.blocking = blockingOf({
    subCent: report.subCent,
    unexplainedChanges: [],
    negativeAfter: report.negativeAfter,
    splitViolationsAfter: report.splitViolationsAfter,
    returnedMismatch: report.returnedMismatch,
    duplicateIds: report.duplicateIds,
    emptyIds: report.emptyIds,
    mergeProblems: []
  })
  const truncated = truncateReport(report, limit)
  truncated.aggregateDiffsTotal = aggregateDiffs.length
  if (aggregateDiffs.length > limit) truncated.aggregateDiffs = aggregateDiffs.slice(0, limit)
  return truncated
}

// 3.2 migrateRecords —— 搬家。
//
// **每次调用只做一个阶段**，两条理由都是「不去依赖一个未实测的量」：
//   ① 写在**事务外**，cursor 用事务内 CAS 推进。单事务写入条数上限是未实测项；
//      写路径已冻结（assertRecordsReady）、_id 确定、set() 幂等、源数组不变，
//      事务在这里买不到任何东西，却会把那个未知量变成真约束。
//   ② writing→verifying **单独占一次调用**。「事务内能否读到自己刚写的数据」
//      同样是未实测项；分两次调用，校验读的一定是已提交数据。
//
// 幂等：归并 + 重算是 ledger.records 的纯函数（不发号、不读时钟），写路径冻结
// → 每次算出的 merged 逐条相同；同 chunk 重发 = 同 _id 重新 set()。
//
// 失败恢复：中断在 writing → cursor 记着进度接着写；校验不过 → phase='failed'，
// 店里看到的和失败前一模一样（仍是停摆态，不是错账）；重来 → restart: true
//（同账套重写）或 newBook: true（新账套，老半成品不可达，O(1) 回滚）；
// 已 done 后发现问题 → mode:'rollback'。
async function migrateRecords(db, shopId, payload, now, nextId) {
  payload = payload || {}
  const mode = String(payload.mode || 'run')
  if (mode === 'rollback') return rollbackMigration(db, shopId, now)
  if (mode === 'dropLegacy') return dropLegacy(db, shopId, now)
  if (mode !== 'run') {
    throw new Error('未知的升级模式：' + mode)
  }

  const limit = clampChunk(payload.limit)
  const ledger = await db.getLedger(shopId)
  if (!ledger) {
    throw new Error('店铺账本不存在')
  }
  if (ledger.recordsMigratedAt) {
    throw new Error('本店账本已经完成流水升级，要退回老路径请用 mode: "rollback"')
  }
  const fresh = !!payload.restart || !!payload.newBook
  const state = fresh ? null : (ledger.migration || null)
  if (!state) {
    return initMigration(db, shopId, ledger, payload, now, nextId)
  }
  if (state.phase === 'failed') {
    throw new Error('上一次账本升级没通过校验（' + String(state.error || '') + '），要重来请带 restart: true 或 newBook: true')
  }
  if (state.phase === 'done') {
    throw new Error('账本升级状态自相矛盾：phase 是 done 却没有 recordsMigratedAt，请联系开发者')
  }
  if (state.phase === 'writing') {
    return writePhase(db, shopId, ledger, state, limit, now)
  }
  if (state.phase === 'verifying') {
    return verifyPhase(db, shopId, ledger, state, limit, now)
  }
  throw new Error('未知的账本升级阶段：' + String(state.phase || ''))
}

function stateOf(state, extra) {
  return Object.assign({
    state: 'running',
    phase: String(state.phase || ''),
    bookId: String(state.bookId || ''),
    total: inventory.toNumber(state.total),
    cursor: inventory.toNumber(state.cursor),
    written: inventory.toNumber(state.written),
    verified: inventory.toNumber(state.verified)
  }, extra || {})
}

// cursor 的 CAS：读回账本，migration 仍等于我读到的那个才写。
// 防两个操作者并发跑跳段（R7）；即便跳了，V1 + V2 也会兜住。
async function putMigration(db, shopId, expect, next) {
  await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    const got = cur.migration || null
    if (!got
      || String(got.bookId || '') !== String(expect.bookId || '')
      || String(got.phase || '') !== String(expect.phase || '')
      || inventory.toNumber(got.cursor) !== inventory.toNumber(expect.cursor)
      || inventory.toNumber(got.verified) !== inventory.toNumber(expect.verified)) {
      throw new Error('账本升级进度被另一次调用推进过，请重新读一次状态再继续')
    }
    await tx.putLedger(shopId, Object.assign({}, cur, { migration: next }))
  })
}

async function initMigration(db, shopId, ledger, payload, now, nextId) {
  const legacy = (ledger.records || [])
  const newBook = !!payload.newBook
  const restart = !!payload.restart
  const bookId = newBook
    ? String((nextId || function () { return String(shopId) + '-b' })())
    : bookOf(ledger, shopId)

  // 特例一：建了没用过的店（records 为空且没有 recordsMigratedAt）。
  // **只补戳，不写 accounts / aggregate** —— 那本账可能已经有活流水和正确聚合。
  if (!legacy.length) {
    return stampOnly(db, shopId, bookId, now)
  }

  const merged = apply.legacyRecordsOf(ledger)
  const store = recordsModule.recordStore(db.recordsCtx(), bookId, shopId)
  if (!restart) {
    const existing = await store.countAll()
    if (existing) {
      throw new Error('目标账套里已经有 ' + existing + ' 条流水（多半是上次尝试的残骸）。'
        + '同账套重写请带 restart: true，换一本新账套请带 newBook: true')
    }
  }
  const migration = {
    bookId: bookId,
    total: merged.length,
    phase: 'writing',
    cursor: 0,
    written: 0,
    verified: 0,
    verifyCursor: '',
    verifyAccounts: {},
    verifyAggregate: inventory.emptyTerms(),
    startedAt: now,
    updatedAt: now,
    error: ''
  }
  await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    if (cur.recordsMigratedAt) {
      throw new Error('本店账本已经完成流水升级，要退回老路径请用 mode: "rollback"')
    }
    await tx.putLedger(shopId, Object.assign({}, cur, { bookId: bookId, migration: migration }))
  })
  return stateOf(migration)
}

async function stampOnly(db, shopId, bookId, now) {
  const migration = {
    bookId: bookId, total: 0, phase: 'done', cursor: 0, written: 0, verified: 0,
    verifyCursor: '', verifyAccounts: {}, verifyAggregate: inventory.emptyTerms(),
    startedAt: now, updatedAt: now, error: '', stampOnly: true
  }
  await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    if (cur.recordsMigratedAt) {
      throw new Error('本店账本已经完成流水升级，要退回老路径请用 mode: "rollback"')
    }
    if ((cur.records || []).length) {
      throw new Error('账本里还有老流水，不能只补时间戳')
    }
    await tx.putLedger(shopId, Object.assign({}, cur, {
      bookId: bookId,
      migration: migration,
      recordsMigratedAt: now,
      revision: inventory.toNumber(cur.revision) + 1
    }))
  })
  return stateOf(migration, { state: 'done', stampOnly: true })
}

async function failMigration(db, shopId, state, message, now, problems) {
  const next = Object.assign({}, state, { phase: 'failed', error: message, updatedAt: now })
  await putMigration(db, shopId, state, next)
  return stateOf(state, {
    state: 'failed',
    phase: 'failed',
    error: message,
    problems: (problems || []).slice(0, REPORT_LIST_LIMIT),
    problemsTotal: (problems || []).length
  })
}

async function writePhase(db, shopId, ledger, state, limit, now) {
  const merged = apply.legacyRecordsOf(ledger)
  if (merged.length !== inventory.toNumber(state.total)) {
    return failMigration(db, shopId, state,
      '账本里的老流水在升级过程中变了（开始 ' + inventory.toNumber(state.total)
      + ' 条，现在 ' + merged.length + ' 条）', now)
  }
  const cursor = Math.max(0, Math.floor(inventory.toNumber(state.cursor)))
  if (cursor >= merged.length) {
    // writing -> verifying 单独占一次调用，理由见 migrateRecords 上方 ②
    const next = Object.assign({}, state, {
      phase: 'verifying', verified: 0, verifyCursor: '',
      verifyAccounts: {}, verifyAggregate: inventory.emptyTerms(), updatedAt: now
    })
    await putMigration(db, shopId, state, next)
    return stateOf(next)
  }
  const chunk = sortDesc(merged).slice(cursor, cursor + limit)
  const store = recordsModule.recordStore(db.recordsCtx(), state.bookId, shopId)
  for (let i = 0; i < chunk.length; i++) {
    await store.set(chunk[i])
  }
  const next = Object.assign({}, state, {
    cursor: cursor + chunk.length,
    written: Math.max(0, inventory.toNumber(state.written)) + chunk.length,
    updatedAt: now
  })
  await putMigration(db, shopId, state, next)
  return stateOf(next)
}

async function verifyPhase(db, shopId, ledger, state, limit, now) {
  const merged = apply.legacyRecordsOf(ledger)
  if (merged.length !== inventory.toNumber(state.total)) {
    return failMigration(db, shopId, state,
      '账本里的老流水在升级过程中变了（开始 ' + inventory.toNumber(state.total)
      + ' 条，现在 ' + merged.length + ' 条）', now)
  }
  const bookId = String(state.bookId || '')
  const desc = sortDesc(merged)
  const store = recordsModule.recordStore(db.recordsCtx(), bookId, shopId)
  const got = await store.pageDocs({ cursor: String(state.verifyCursor || ''), limit: limit })
  const docs = got.docs
  const verified = Math.max(0, Math.floor(inventory.toNumber(state.verified)))
  const problems = verifyChunk(desc.slice(verified, verified + docs.length), docs, bookId, shopId)
  if (problems.length) {
    return failMigration(db, shopId, state, '逐条校验没过：' + describeProblems(problems), now, problems)
  }
  let terms = {
    accounts: state.verifyAccounts || {},
    aggregate: state.verifyAggregate || inventory.emptyTerms()
  }
  for (let i = 0; i < docs.length; i++) {
    terms = inventory.applyTermsDelta(terms, null, apply.fromRecordDoc(docs[i]))
  }
  const nextVerified = verified + docs.length
  if (docs.length >= got.limit) {
    const next = Object.assign({}, state, {
      verified: nextVerified,
      verifyCursor: String(docs[docs.length - 1].sortKey || ''),
      verifyAccounts: terms.accounts,
      verifyAggregate: terms.aggregate,
      updatedAt: now
    })
    await putMigration(db, shopId, state, next)
    return stateOf(next)
  }

  // 翻完了：跑 §四 4.2 的 12 项校验，全过才切开关。
  const collectionCount = await store.countAll()
  let failures = []
  if (nextVerified !== merged.length) {
    failures.push({ check: 'V1', reason: '校验条数和归并条数不等', want: merged.length, got: nextVerified })
  }
  if (collectionCount !== merged.length) {
    failures.push({ check: 'V1', reason: '集合条数和归并条数不等', want: merged.length, got: collectionCount })
  }
  failures = failures.concat(foldProblems(terms, {
    accounts: inventory.foldAccountTerms(merged),
    aggregate: inventory.foldTotalTerms(merged)
  }))
  const audit = auditRecords(merged)
  const shape = mergeShapeChecks(ledger.records || [], merged)
  failures = failures.concat(shape.problems)
  failures = failures.concat(audit.returnedMismatch.map(function (item) {
    return Object.assign({ check: 'V4' }, item)
  }))
  failures = failures.concat(audit.splitViolations.map(function (item) {
    return Object.assign({ check: 'V5' }, item)
  }))
  failures = failures.concat(audit.negativeAccounts.map(function (item) {
    return Object.assign({ check: 'V6' }, item)
  }))
  failures = failures.concat(audit.duplicateIds.map(function (id) {
    return { check: 'V8', reason: '重复 id', id: id }
  }))
  if (audit.emptyIds) {
    failures.push({ check: 'V8', reason: '空 id', count: audit.emptyIds })
  }
  failures = failures.concat(audit.subCent.map(function (item) {
    return Object.assign({ check: 'V12' }, item)
  }))
  // V11 孤儿退货是**非阻塞**的：份额无从算起，报数人工确认，不拦迁移
  if (failures.length) {
    return failMigration(db, shopId, state, '校验没过：' + describeProblems(failures), now, failures)
  }

  const done = Object.assign({}, state, {
    phase: 'done', verified: nextVerified, updatedAt: now, error: '',
    verifyCursor: '', verifyAccounts: {}, verifyAggregate: inventory.emptyTerms(),
    orphanReturns: audit.orphanReturns.length
  })
  await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    const got2 = cur.migration || null
    if (!got2 || String(got2.phase || '') !== 'verifying'
      || inventory.toNumber(got2.verified) !== inventory.toNumber(state.verified)) {
      throw new Error('账本升级进度被另一次调用推进过，请重新读一次状态再继续')
    }
    // 老数组 records **故意不删**：它是 O(1) 回滚路的全部依仗（方案 §六-(b)）
    await tx.putLedger(shopId, Object.assign({}, cur, {
      bookId: bookId,
      accounts: terms.accounts,
      aggregate: terms.aggregate,
      recordsMigratedAt: now,
      revision: inventory.toNumber(cur.revision) + 1,
      migration: done
    }))
  })
  return stateOf(done, {
    state: 'done',
    report: {
      totals: audit.totals,
      receivable: audit.receivable,
      orphanReturns: audit.orphanReturns.slice(0, REPORT_LIST_LIMIT),
      orphanReturnsTotal: audit.orphanReturns.length,
      missingReturnedAmount: audit.missingReturnedAmount.slice(0, REPORT_LIST_LIMIT),
      missingReturnedAmountTotal: audit.missingReturnedAmount.length
    }
  })
}

function describeProblems(problems) {
  return (problems || []).slice(0, 5).map(function (item) {
    return JSON.stringify(item)
  }).join('；') + ((problems || []).length > 5 ? '（共 ' + problems.length + ' 项）' : '')
}

// mode:'rollback' —— 只清 recordsMigratedAt 和 migration，老数组还在，
// 读写立刻退回老路径。**这是显式动作**，不要让人去控制台手改生产文档。
async function rollbackMigration(db, shopId, now) {
  const outcome = await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    if (!((cur.records || []).length)) {
      throw new Error('没有可回滚的老流水（老数组是空的，可能已经跑过 dropLegacy）')
    }
    const next = Object.assign({}, cur, {
      recordsMigratedAt: 0,
      migration: null,
      revision: inventory.toNumber(cur.revision) + 1
    })
    await tx.putLedger(shopId, next)
    return { legacyCount: (cur.records || []).length }
  })
  return { state: 'rolledBack', phase: '', legacyCount: outcome.legacyCount, updatedAt: now }
}

// mode:'dropLegacy' —— 把 ledgers.records 置空。**跑完就没有 O(1) 回滚了**，
// 默认不跑，只在 P12 逼近 5MB 时当晚跑。
async function dropLegacy(db, shopId, now) {
  const outcome = await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    const state = cur.migration || null
    if (!cur.recordsMigratedAt || !state || String(state.phase || '') !== 'done') {
      throw new Error('本店账本还没完成流水升级，不能删老流水')
    }
    const dropped = (cur.records || []).length
    await tx.putLedger(shopId, Object.assign({}, cur, {
      records: [],
      revision: inventory.toNumber(cur.revision) + 1
    }))
    return { dropped: dropped }
  })
  return { state: 'dropped', phase: 'done', dropped: outcome.dropped, updatedAt: now }
}

// 3.3 recomputeAggregates —— 漂移修复入口。
//
// **边界（必须写进注释和文档，否则下一个人一定会拿它去修错账）**：
// 它是「按集合里**现在**的记录重折叠」。如果集合里某张退货单的 paidAmount
// 本身就是错的，重算会忠实地把这个错数再算一遍。
// **它不是 B1 的修复入口** —— B1 的修复是 migrateRecords 的整体重算
//（apply.legacyRecordsOf 里的 inventory.repairReturnSplits），那一步只在
// 老数组搬进集合的那一刻发生。已经在集合里的错值，只能靠改单据本身来修。
//
// 一个事务做完。ledgers/{shopId} 的读 + 写仍是唯一串行化点，事务内翻完集合
// 再写回不可能读到半个并发写 —— **不需要新的冻结字段**。
async function recomputeAggregates(db, shopId, payload, now) {
  payload = payload || {}
  const dryRun = !!payload.dryRun
  return db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      throw new Error('店铺账本不存在')
    }
    if (apply.recordsPending(cur)) {
      throw new Error('本店账本还没完成流水升级，聚合是读时从老数组现折的，没有可重算的东西')
    }
    const bookId = bookOf(cur, shopId)
    const store = recordsModule.recordStore(tx.recordsCtx(), bookId, shopId)
    const docs = await readAllDocs(store, RECOMPUTE_MAX_RECORDS)
    let terms = { accounts: {}, aggregate: inventory.emptyTerms() }
    for (let i = 0; i < docs.length; i++) {
      terms = inventory.applyTermsDelta(terms, null, apply.fromRecordDoc(docs[i]))
    }
    const beforeAccounts = cur.accounts || {}
    const beforeAggregate = cur.aggregate || inventory.emptyTerms()
    const diffs = accountsDiff(beforeAccounts, terms.accounts)
      .concat(termsDiff(beforeAggregate, terms.aggregate, 'aggregate'))
    const changed = diffs.length > 0
    if (changed && !dryRun) {
      await tx.putLedger(shopId, Object.assign({}, cur, {
        accounts: terms.accounts,
        aggregate: terms.aggregate,
        revision: inventory.toNumber(cur.revision) + 1
      }))
    }
    return {
      bookId: bookId,
      count: docs.length,
      changed: changed,
      dryRun: dryRun,
      updatedAt: now,
      // 返回包**永远**带 before/after diff，跑没跑成都能看见改了什么
      before: {
        totals: inventory.totalsOf(beforeAggregate),
        receivable: receivableMapOf(beforeAccounts)
      },
      after: {
        totals: inventory.totalsOf(terms.aggregate),
        receivable: receivableMapOf(terms.accounts)
      },
      diffs: diffs.slice(0, REPORT_LIST_LIMIT),
      diffsTotal: diffs.length
    }
  })
}

module.exports = {
  MIGRATE_CHUNK_DEFAULT: MIGRATE_CHUNK_DEFAULT,
  MIGRATE_CHUNK_MAX: MIGRATE_CHUNK_MAX,
  AUDIT_MAX_RECORDS: AUDIT_MAX_RECORDS,
  RECOMPUTE_MAX_RECORDS: RECOMPUTE_MAX_RECORDS,
  REPORT_LIST_LIMIT: REPORT_LIST_LIMIT,
  OPS_ACTIONS: ['checkAggregates', 'migrateRecords', 'recomputeAggregates'],
  stableEqual: stableEqual,
  mergeOnly: mergeOnly,
  sortDesc: sortDesc,
  auditRecords: auditRecords,
  checkLedger: checkLedger,
  verifyChunk: verifyChunk,
  verifyMigrated: verifyMigrated,
  mergeShapeChecks: mergeShapeChecks,
  movingChangesOf: movingChangesOf,
  accountsDiff: accountsDiff,
  termsDiff: termsDiff,
  truncateReport: truncateReport,
  checkAggregates: checkAggregates,
  migrateRecords: migrateRecords,
  recomputeAggregates: recomputeAggregates
}
