const apply = require('./ledger-apply')
const inventory = require('./inventory')
const recordsModule = require('./ledger-records')

// 账本升级（2b-1b）：把 ledgers.records 数组里的老流水搬进 ledger_records 集合。
//
// **这个文件不参与 `npm run sync:ledger-inventory`**：同步的仍然只有
// utils/inventory.js 和 utils/ledger-apply.js。这里有 IO（读集合、开事务），
// 放进 utils/ 会破坏那两个文件「零 IO、零数据库句柄」的结构保证。
//
// 三个 action，全部走平台运营方白名单（ledger-core.js 的 requirePlatformAdmin，
// 名单在集合 platform_admins）、全部过 apiVersion 门、全部不走 applyMutation：
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

// 回滚守卫翻多少条。取 PAGE_LIMIT（= apply.clampPageLimit 的上限 100）：写成更大的
// 数会被 clampPageLimit 静默钳回 100，于是这个常量就在**说谎** —— 它读起来像
// 「探针看 500 条」，实际只看 100。
// **不要**把理由写成「会让 foreignMore 的判据和实际取到的条数脱节」：那个风险已经
// 被结构消掉了 —— pageDocs 返回的是**钳后**的 limit，foreignMore 比的就是它。
// 实测把这个常量改成 500，M10g 的 foreignMore: true 照样成立、整个测试集 EXIT=0。
const ROLLBACK_PROBE_LIMIT = PAGE_LIMIT
// 错误文案和回包里最多点名几条「不在老数组里」的记录。
const ROLLBACK_FOREIGN_SAMPLE = 5

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

// P14：同一张单里同一件商品挂着两套价——销售行一个单价、退货行另一个。
//
// 来路：有一段时间「改有退货的销售单的单价」是放行的，而退货行的单价不跟着走
// （退货行的 unitPrice 从来不是用户录的，是开退货单时从销售行抄的）。于是销售额、
// 毛利、欠款都是两套价拼出来的，能算出负数的销售额。写路径后来修好了
// （repriceSaleReturns 会把同单退货行拨到新价），但**已经写进老账本的那些没人管**。
//
// 为什么报出来：repairReturnSplits 只重算**份额**（谁退了多少现金），不碰单价。
// 所以这类单搬进 ledger_records 之后销售额和毛利仍然是两套价拼的。
//
// 但它**不是阻塞项**：这是既有的数据损伤，迁移既不制造也不加重它，而且迁移前后
// 都能修（写路径的 repriceSaleReturns 会拨回一致）。拿它挡住整店迁移不成比例 ——
// 和 P6 孤儿退货同一类：记录在案，让操作者自己决定。
//
// 补救：在小程序里打开这几张单、随便改一下再保存，写路径会把退货行拨到销售行
// 当前的单价（会弹提示说清账上的退款现金变了多少）。改完重跑预检这条就空了。
function mixedPriceOf(records) {
  const sales = salesById(records)
  const bad = []
  ;(records || []).forEach(function (item) {
    if (!item || item.type !== 'return') return
    const saleId = saleIdOfReturn(item)
    const sale = saleId && sales[saleId]
    if (!sale) return
    const saleLines = inventory.recordLines(sale)
    inventory.recordLines(item).forEach(function (line) {
      const lineId = String((line && line.saleLineId) || '')
      const saleLine = saleLines.find(function (x) {
        return String((x && x.lineId) || '') === lineId
      })
      if (!saleLine) return
      const salePrice = inventory.round2(inventory.toNumber(saleLine.unitPrice))
      const returnPrice = inventory.round2(inventory.toNumber(line && line.unitPrice))
      if (salePrice === returnPrice) return
      bad.push({
        saleId: saleId,
        returnId: String((item && item.id) || ''),
        lineId: lineId,
        salePrice: salePrice,
        returnPrice: returnPrice
      })
    })
  })
  return bad
}

// P8 × P14 的交集：同一条销售行**既缺 returnedAmount、名下退货行又挂着另一套价**。
//
// 为什么两条单独出现都放行、撞在一起就必须拦：
//   · P8 单独出现（缺 returnedAmount，退货行和销售行同价）：读时按
//     returnedQty × 销售行单价回推，那正好等于 Σ退货额，兜底值就是真值，无害。
//   · P14 单独出现（两套价，但 returnedAmount 记着）：既有的数据损伤，迁移既不
//     制造也不加重它，改一次单就会被拨回一致。
//   · 撞在一起，回推的前提（「这行的退货都按销售行当前价开」）当场不成立，兜底值
//     就是错的 —— 而写路径会把它固化：店主打开这张单一个字不改直接保存，
//     repriceSaleReturns 把退货行拨到现价、returnedAmount 落成 Σ退货额，
//     于是账上的已退货值从「当初真退的货值」跳到「已退件数 × 现价」。之后一次
//     寻常退货就按这个抬高（或压低）的基准算冲抵，柜台多退现金、客户页还挂着欠款，
//     同一笔钱客户付两次。
//
// 所以它是**阻塞项**：迁移前在 app 里还改得动（老云函数还在跑），迁移之后写路径
// 被 assertRecordsReady 冻结，只能去控制台手改生产文档。
function mixedPriceMissingAmountOf(missingReturnedAmount, mixedPrice) {
  const missing = Object.create(null)
  ;(missingReturnedAmount || []).forEach(function (item) {
    missing[String((item && item.saleId) || '') + KEY_SEP + String((item && item.lineId) || '')] = item
  })
  const seen = Object.create(null)
  const out = []
  ;(mixedPrice || []).forEach(function (item) {
    const saleId = String((item && item.saleId) || '')
    const lineId = String((item && item.lineId) || '')
    const key = saleId + KEY_SEP + lineId
    if (!Object.prototype.hasOwnProperty.call(missing, key)) return
    if (!seen[key]) {
      seen[key] = {
        saleId: saleId,
        lineId: lineId,
        salePrice: item.salePrice,
        // 退货行实际累加出来的货值 —— 就是回推值该等于、而实际不等于的那个数
        fromReturns: missing[key].fromReturns,
        returnIds: [],
        returnPrices: []
      }
      out.push(seen[key])
    }
    seen[key].returnIds.push(String((item && item.returnId) || ''))
    seen[key].returnPrices.push(item.returnPrice)
  })
  return out
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
  const mixedPrice = mixedPriceOf(list)
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
    mixedPrice: mixedPrice,
    mixedPriceMissingAmount: mixedPriceMissingAmountOf(returned.missingReturnedAmount, mixedPrice),
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

// 「这批归并后的流水**本身**有没有病」——只吃内存里的记录，不碰数据库。
//
// 为什么要抽出来：搬进 ledger_records 有两条路，`migrateRecords`（搬家）和
// `migrateLocal`（把本机账本上传到当前店），**两条路跑的是同一个
// apply.legacyRecordsOf**（归并 + 退货份额整体重算，它就是来改钱的），
// 从前却只有搬家路跑 V1–V12。同一份数据一条路报 failed、另一条路直接放行，
// 而落库之后一个负账户会让**全店任何客户**都退不了货、改不了单、删不了销售单
//（见上面 negativeAccountsOf 的注释和 ledger-core.migrateLocalShard 的实测清单）。
// 所以这里给出**唯一一份定义**，两条路都调它，将来加检查不会只加一边。
//
// 选进来的是 V4..V12 里**不依赖集合往返**的那几项：
//   V4  returnedQty / returnedAmount 跨文档一致
//   V5  拆分不变量
//   V6  负账户
//   V8  重复 / 空 id
//   V9 / V10 归并结构守恒（行数守恒、非 out 一条没被并掉）
//   V12 所有金额都是 round2() 的输出
// **不含 V1 / V2 / V3 / V7**：那四项比的是「集合里的文档 vs 内存里的 merged」，
// 只有搬家路径有集合可比。V11 孤儿退货是**非阻塞**的（份额无从算起，报数人工
// 确认，保持保守回推值），不进 failures。
//
// opts.deferNegativeAccounts —— 把 V6 交给调用方在**累计** accounts 上判。
// 分片上传时一片就是一段时间切片，「A 片赊销、B 片收款」是完全合法的切法，
// 单片折出来的负欠款是切片假象、不是错账（实测：一份干净本机账本按时间切成
// `in,out,return` + `pay,out` 两片，后一片单独折叠 receivable = −5，而整本
// 折叠 receivable = 3）。所以分片路把 V6 挪到收完最后一片时的累计 accounts 上
// 判，判据仍是同一个 negativeAccountsOf，只是判的对象换成了全量。
function recordFailures(sourceRecords, merged, opts) {
  const audit = auditRecords(merged)
  const shape = mergeShapeChecks(sourceRecords || [], merged)
  let failures = [].concat(shape.problems)
  failures = failures.concat(audit.returnedMismatch.map(function (item) {
    return Object.assign({ check: 'V4' }, item)
  }))
  failures = failures.concat(audit.splitViolations.map(function (item) {
    return Object.assign({ check: 'V5' }, item)
  }))
  if (!(opts && opts.deferNegativeAccounts)) {
    failures = failures.concat(audit.negativeAccounts.map(function (item) {
      return Object.assign({ check: 'V6' }, item)
    }))
  }
  failures = failures.concat(audit.duplicateIds.map(function (id) {
    return { check: 'V8', reason: '重复 id', id: id }
  }))
  if (audit.emptyIds) {
    failures.push({ check: 'V8', reason: '空 id', count: audit.emptyIds })
  }
  failures = failures.concat(audit.subCent.map(function (item) {
    return Object.assign({ check: 'V12' }, item)
  }))
  return failures
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

// P11：升级前存下来的清空快照。没有 bookId 的那些，在跑 mode:'snapshots' 之前
// 「恢复清空前数据」会报错 —— 这里报数，转换由 migrateRecords 的 mode:'snapshots'
// 做（活账套迁完之后紧接着的一步）。clears 可选：控制台另导一份 ledger_clears 才有。
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
    mixedPrice: auditAfter.mixedPrice,
    missingReturnedAmount: auditAfter.missingReturnedAmount,
    // P8×P14：两条单独非阻塞，交集阻塞（见 mixedPriceMissingAmountOf）
    mixedPriceMissingAmount: auditAfter.mixedPriceMissingAmount,
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

// 阻塞项：不为空就停下来。孤儿退货（P6）、missingReturnedAmount（P8 的缺字段那半）
// 和两套价（P14）单独出现都是**非阻塞**的，逐条人工确认即可 —— 但
// **P8 × P14 的交集是阻塞的**，理由见 mixedPriceMissingAmountOf 上方那段：
// 两条单独出现都无害，撞在同一条销售行上，兜底回推值就是错的，而写路径会把它固化。
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
  add('P8×P14 缺已退金额且退货行两套价', report.mixedPriceMissingAmount)
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
  'returnedMismatch', 'missingReturnedAmount', 'mixedPrice', 'mixedPriceMissingAmount',
  'duplicateIds', 'multiLineOrders', 'mergeProblems', 'blocking'
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
      // 「残骸」不是唯一解释。集合条数**超过**归并条数时，多出来的那些多半不是
      // 上次尝试写了一半，而是**迁移之后记的真账** —— 这本账迁完过、后来被
      // mode:'rollback' 退回了老路径，中间正常营业记的流水都只在集合里。
      // 对这一类无条件推荐 newBook 会把那些真账留在一本再也没人指向的账套里，
      // 永久不可达。所以按差额分流。
      const mergedCount = inventory.toNumber(report.mergedCount)
      const extra = report.collectionCount - mergedCount
      report.blocking.push(extra > 0 ? {
        key: 'P13',
        label: '目标账套里已有 ' + report.collectionCount + ' 条流水，比老数组归并后的 '
          + mergedCount + ' 条还多 ' + extra + ' 条 —— 多出来的很可能是迁移后记的账'
          + '（这本账迁完过、又被 rollback 退回了老路径）',
        count: report.collectionCount,
        hint: '**不要**直接 newBook：那会把这 ' + extra + ' 条永久留在旧账套里、再也读不到。'
          + '先用 listRecords 把集合里的流水翻一遍，确认这几条是不是真账，再决定怎么办'
      } : {
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
    mixedPrice: audit.mixedPrice,
    missingReturnedAmount: audit.missingReturnedAmount,
    mixedPriceMissingAmount: audit.mixedPriceMissingAmount,
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
    mixedPrice: report.mixedPrice,
    mixedPriceMissingAmount: report.mixedPriceMissingAmount,
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
//
// 活账套迁完之后还有一步：mode:'snapshots' 把升级前存的清空快照也转过来
//（见下面 convertSnapshots 上方那段）。不跑它，那几家店的「恢复清空前数据」
// 就从能点变成永久报错。
async function migrateRecords(db, shopId, payload, now, nextId) {
  payload = payload || {}
  const mode = String(payload.mode || 'run')
  if (mode === 'rollback') return rollbackMigration(db, shopId, now, payload)
  if (mode === 'dropLegacy') return dropLegacy(db, shopId, now)
  if (mode === 'snapshots') return convertSnapshots(db, shopId, payload, now)
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
  // restart / newBook 是**一次性**的：谁点的、被哪一次尝试消化掉了，记在
  // migration.freshBy 上。判据是「这个标志还没被当前这次尝试消化过」，不是
  // 「payload 里有没有这个标志」。
  //
  // 为什么必须这样：文档给的循环示例把 payload 写在循环体里，操作者要 restart 时
  // 最自然的改法就是加进那个 payload，于是**每一次调用**都带着它。按「有标志就重来」
  // 判，每次调用都重新 initMigration —— 8 次调用全是
  // {"state":"running","phase":"writing","written":0,"cursor":0}，永远不前进、
  // 也永远不出现 failed，循环条件不退出。newBook 更糟：每次还发一个新账套号
  //（实测 5 次调用发出 gen1..gen5，集合里一条都没写）。而这发生在所有店一起停摆
  // 的窗口里。
  //
  // 「一条都还没写才算幂等」同样不收敛：写完第一个 chunk 之后 cursor 就不是 0 了，
  // 下一次调用又会重新 init，在 init 和 write 之间原地打转。所以判据只能是
  // freshBy，与进度无关。
  //
  // 代价：一次由 restart 起的尝试进行到一半时，再带 restart 不会真的重来。可以接受 ——
  // restart 的语义是「同账套 cursor 拨回 0 重写一遍」，而 set() 幂等、merged 逐条
  // 相同、源数组变了会被 writePhase 的 total 比对判掉，所以那一趟重写和接着写的
  // 末态一模一样。真正需要重来的两种状态（failed / done 但没有 recordsMigratedAt）
  // 都不算「消化过」，照样重来；换账套用 newBook（标志不同，一定重来）。
  const want = payload.newBook ? 'newBook' : (payload.restart ? 'restart' : '')
  let state = ledger.migration || null
  const live = !!(state && (String(state.phase || '') === 'writing'
    || String(state.phase || '') === 'verifying'))
  const consumed = !!(want && live && String(state.freshBy || '') === want)
  if (want && !consumed) state = null
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
    verified: inventory.toNumber(state.verified),
    // 回给循环调用者看：它带的 restart / newBook 被认下了、而且只认这一次
    freshBy: String(state.freshBy || '')
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
    // 哪个标志起的这一次尝试。migrateRecords 靠它把 restart / newBook 变成
    // 一次性的，循环调用者原样重发同一个 payload 才能收敛。
    freshBy: newBook ? 'newBook' : (restart ? 'restart' : ''),
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
    bookId: bookId, total: 0, phase: 'done', freshBy: '', cursor: 0, written: 0, verified: 0,
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
  // V4..V12 里不依赖集合往返的那几项**只有一份定义**，migrateLocal 走的是同一个
  // （见 recordFailures 的注释）。V1 / V3 留在这里：只有搬家路有集合可比。
  // V11 孤儿退货是**非阻塞**的：份额无从算起，报数人工确认，不拦迁移。
  failures = failures.concat(recordFailures(ledger.records || [], merged))
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

// ---------------------------------------------------------------------------
// mode:'snapshots' —— 把升级前存下来的清空快照转过来。
//
// 为什么必须做：restoreCleared（ledger-apply.js）要快照带 bookId / accounts /
// aggregate 三样东西，而升级前存的快照把流水装在 records 数组里、三样都没有。
// 不转换 = 那几家店的「恢复清空前数据」按钮**从能点变成永久报错**，是对活店
// 的真实功能损失（阶段 0 的真实导出：3 家店里 2 家中招，共 3 份老快照）。
//
// 前置条件：本店活账套必须已经迁完（recordsMigratedAt 已写）。快照转换是加分项，
// **不能挡住关键路径**；而且它和活账套走的是同一套 legacyRecordsOf（归并 +
// 退货份额整体重算），先在活账上跑通再来转快照更安全。
//
// 账套号 = 'clr-' + 快照 id，**故意不发新号**（对比 migrateRecords 的 newBook）。
// 发号会逼出一个两头不讨好的选择：把号先写进快照文档再写流水，崩在中间就恢复出
// 一本空账（products 回来了、流水没了，静默错账）；先写流水再写号，崩在中间就
// 留下一批孤儿文档、下次重试又换一个号（那一头只是存储泄漏，不算错钱，两头的代价
// 不同级）。号由快照自己决定，两头都不用付：同一份
// 快照重跑写的是同一批 _id，set() 幂等，countAll 永远只数这一份，且没有任何
// 需要跨调用持久化的状态。'clr-' 前缀保证不会撞上现有账套（现有账套号要么是
// shopId、要么是 nextId() 出来的 base36 串）。
//
// 幂等：bookId 非空即跳过，整个 mode 可以反复调。
// 单份失败不影响其他份：快照之间互相独立，一份坏数据不该让其他份也恢复不了。
// ---------------------------------------------------------------------------
function snapshotBookId(snapshotId) {
  return 'clr-' + String(snapshotId || '')
}

function errorText(error) {
  return String((error && (error.message || error.errMsg)) || error || '未知错误')
}

// 回滚守卫的错误文案里点名几条外来记录。id/类型/时间三样，够操作者拿 getRecord 去看。
function describeForeign(list) {
  const head = (list || []).slice(0, ROLLBACK_FOREIGN_SAMPLE).map(function (item) {
    return item.id + '（' + item.type + '，createdAt=' + item.createdAt + '）'
  }).join('、')
  return (list || []).length > ROLLBACK_FOREIGN_SAMPLE ? head + ' 等' : head
}

// 一份快照。**不抛**（除非是程序错误）：失败原样记进 report 由调用方继续下一份。
async function convertOneSnapshot(db, shopId, meta) {
  const snapshotId = String((meta && meta.id) || '')
  const entry = { id: snapshotId, savedAt: inventory.toNumber(meta && meta.savedAt) }
  if (!snapshotId) {
    entry.status = 'failed'
    entry.reason = '账本里这条清空记录没有 id'
    return entry
  }
  let doc = null
  try {
    doc = await db.getClearSnapshot(snapshotId)
  } catch (error) {
    entry.status = 'failed'
    entry.reason = '读快照失败：' + errorText(error)
    return entry
  }
  if (!doc) {
    entry.status = 'failed'
    entry.reason = '账本里记着这份快照，ledger_clears 里却找不到它'
    return entry
  }
  const legacy = (doc.records || [])
  entry.legacyCount = legacy.length
  if (doc.bookId) {
    // 幂等：已经转过了。**不重算、不重写**，否则反复调会白涨版本。
    entry.status = 'skipped'
    entry.bookId = String(doc.bookId)
    return entry
  }
  const bookId = snapshotBookId(snapshotId)
  entry.bookId = bookId
  let merged = []
  try {
    // 和活账套**完全同一套处理**：归并 + repairReturnSplits 份额整体重算。
    // 快照里的流水同样可能是任意一代形状，同样会带着 B1 / B2 的错值。
    merged = legacy.length ? apply.legacyRecordsOf({ records: legacy }) : []
  } catch (error) {
    entry.status = 'failed'
    entry.reason = '归并/重算这份快照的流水时出错：' + errorText(error)
    return entry
  }
  entry.recordCount = merged.length
  const store = recordsModule.recordStore(db.recordsCtx(), bookId, shopId)
  try {
    // 事务外逐条写。_id = bookId_recordId 是确定的，set() 幂等。
    for (let i = 0; i < merged.length; i++) {
      await store.set(merged[i])
    }
  } catch (error) {
    entry.status = 'failed'
    entry.reason = '把这份快照的流水写进集合时出错：' + errorText(error)
    return entry
  }
  let count = 0
  try {
    count = await store.countAll()
  } catch (error) {
    entry.status = 'failed'
    entry.reason = '数这份快照的流水条数时出错：' + errorText(error)
    return entry
  }
  entry.collectionCount = count
  if (count !== merged.length) {
    // 没写全（或者账套里有别的东西）就不许给它盖 bookId：盖了就等于宣布
    // 「这份快照可以恢复」，恢复出来却是半本账。
    entry.status = 'failed'
    entry.reason = '写完之后条数对不上（应为 ' + merged.length + '，实为 ' + count + '），没有给这份快照盖 bookId'
    return entry
  }
  const accounts = inventory.foldAccountTerms(merged)
  const aggregate = inventory.foldTotalTerms(merged)
  try {
    const outcome = await db.runTransaction(async function (tx) {
      const cur = await tx.getClearSnapshot(snapshotId)
      if (!cur) {
        throw new Error('快照文档在转换过程中不见了')
      }
      if (cur.bookId) {
        // 另一次调用抢先转好了。集合里那批是同样的 _id、同样的内容，不用清理。
        return { raced: true, bookId: String(cur.bookId) }
      }
      // records 数组**保留不删** —— 和 ledgers.records 同一个理由：那是回滚路，
      // 清掉就退不回旧云函数了。
      await tx.putClearSnapshot(snapshotId, Object.assign({}, cur, {
        bookId: bookId,
        accounts: accounts,
        aggregate: aggregate
      }))
      // 顺手把归并条数回填进账本 clearSnapshots 的元数据（「恢复清空前数据」
      // 弹窗要报的数）。老元数据只有 {id, savedAt}，records 数组按行数又**不等于**
      // 恢复出来的条数（同 orderId 的行会归并成一张单）—— 转换这里是全店唯一
      // 一个拿得到归并结果的地方。这次回填和上面盖 bookId 的 putClearSnapshot
      // 在**同一个事务**里：回填抛错会把盖号那半场一起回滚，整份按 failed 报
      //（下面 catch 的「写回快照文档时出错」），不会留下「盖了号却没回填条数」
      // 的中间态。重试是安全的：事务外那批集合写入 _id 确定、set() 幂等，
      // 事务重跑一遍就收敛。账本里找不到这条元数据（带外删过）就只跳过回填，
      // 盖号那半场照常提交。
      const ledgerCur = await tx.getLedger(shopId)
      if (ledgerCur && (ledgerCur.clearSnapshots || []).length) {
        const metas = (ledgerCur.clearSnapshots || []).map(function (meta) {
          if (String((meta && meta.id) || '') !== snapshotId) return meta
          return Object.assign({}, meta, { recordCount: merged.length })
        })
        await tx.putLedger(shopId, Object.assign({}, ledgerCur, { clearSnapshots: metas }))
      }
      return { raced: false }
    })
    if (outcome && outcome.raced) {
      entry.status = 'skipped'
      entry.bookId = String(outcome.bookId)
      entry.reason = '另一次调用抢先转好了'
      return entry
    }
  } catch (error) {
    entry.status = 'failed'
    entry.reason = '写回快照文档时出错：' + errorText(error)
    return entry
  }
  // 空 records 的快照走 stamp-only：只补 bookId + 空 accounts / aggregate。
  // 上面那条路径原样把它做完了（merged 为空 -> 一条都不写、折出空累加器），
  // 这里只是给报告一个能看懂的名字。
  entry.status = merged.length ? 'converted' : 'stamped'
  return entry
}

async function convertSnapshots(db, shopId, payload, now) {
  const limit = clampChunk(payload.limit)
  const ledger = await db.getLedger(shopId)
  if (!ledger) {
    throw new Error('店铺账本不存在')
  }
  if (!ledger.recordsMigratedAt) {
    throw new Error('本店活账套还没完成流水升级，先把它迁完（不带 mode 调 migrateRecords）再来转换老快照')
  }
  const metas = (ledger.clearSnapshots || [])
  const report = []
  let converted = 0
  let skipped = 0
  let failed = 0
  // 预算只由**转成功的份数**消耗：跳过是白拿的（一次读就完），失败也不消耗，
  // 否则一份修不好的坏数据会把预算吃光、remaining 永远归不了零，循环调不收敛。
  let budget = limit
  let index = 0
  for (; index < metas.length; index++) {
    if (budget <= 0) break
    const entry = await convertOneSnapshot(db, shopId, metas[index])
    report.push(entry)
    if (entry.status === 'skipped') {
      skipped += 1
    } else if (entry.status === 'failed') {
      failed += 1
    } else {
      converted += 1
      budget -= 1
    }
  }
  // remaining = 这次**没看过**的份数。失败的那几份不算 remaining（算了就永远
  // 收敛不了），要看 report 里的 reason 人工处理，修好之后再调一次就会重试。
  const remaining = metas.length - index
  return {
    state: remaining ? 'running' : 'done',
    mode: 'snapshots',
    total: metas.length,
    converted: converted,
    skipped: skipped,
    failed: failed,
    remaining: remaining,
    updatedAt: now,
    report: report.slice(0, REPORT_LIST_LIMIT),
    reportTotal: report.length
  }
}

// mode:'rollback' —— 只清 recordsMigratedAt 和 migration，老数组还在，
// **读**立刻退回老路径；**写是冻着的**：recordsPending 重新为真，assertRecordsReady
// 照旧拦下每一条写（实测回滚后记账和删单都报「本店账本还没完成流水升级，暂时
// 不能记账」）——回滚不是重新开张，是回到停摆态。这也是回滚彩排（docs 阶段 1）
// 最后一步只能 newBook 的原因之一：彩排记的那条账留在集合里删不掉。
// **这是显式动作**，不要让人去控制台手改生产文档。
//
// **回滚只对「迁完之后一条新账都没记」成立。** 迁完之后店是解冻的，新流水只进
// ledger_records；ledgers.records 那份老数组一条都不涨（applyMutation 把它原样
// 带过去，那是 O(1) 回滚路的依仗）。所以回滚是把读路径整个切回一个**过期的真子集**
// —— 迁移之后记的账在老路径上一条都看不见，欠款和流水数当场跌回迁移那一刻。
//
// 靠哨兵发现不了：回滚后 recordsPending 为真，getLedger 不走 attachRecent，
// 那次 count() 比对根本不会发生，aggregatesStale 恒为 false。所以只能在这里挡。
//
// 守卫是**两个独立信号**：
//
//   ① 事务内、精确、判「有没有」：翻集合最新一页，逐条看 doc.id 在不在老数组
//      归并出来的那一份里。不在 = 这条账只存在于集合里，回滚就把它从读路径抹掉。
//      **只用 pageDocs**（where().orderBy().limit().get()）。这条 API 链在事务里
//      **已经有在跑的调用点**（ledger-core.js 记账事务里的 apply.prepareMutation）：
//        · 改或删一张进货单 -> latestPurchases
//          where({bookId,type,productId,skuId}).orderBy('sortKey','desc').limit(2).get()
//        · 改或删一张退货单、改一张有退货的销售单 -> returnsOfSale
//          where({bookId,saleOrderId}).orderBy('sortKey','asc').limit(201).get()
//      **新增那三条一次都不发**（实测：addPurchase / addSale / addReturn 在事务里
//      发出的 where 查询数都是 0，addReturn 只发一次 doc().get() 捞被退销售单）——
//      recordsNeeded 只在 updateRecord / deleteRecord 上返回非空的 purchases /
//      saleReturns。所以正确的说法是：这条形状在事务里不可用时，**改单和删单一笔
//      都做不了**，不是「一笔进货都记不了」。阶段 1 的测试店必须**改或删一张进货
//      单**、**改或删一张退货单**才算把它验过，光记进货和退货验不到
//      （docs/cloud-ledger.md 阶段 1 清单已按这条改写）。
//      **绝对不要在事务里调 countAll()**：上面两条是「已经在事务里跑的同一条 API
//      链」，而 transaction.collection().where().count() 在这个仓里一次都没跑过。
//      把一个未实测的量放在全店停摆窗口里唯一的紧急出路上，是拿退路去赌。
//      这条是 docs/cloud-ledger.md「不去依赖一个未实测的量」的第三条，别再改回去。
//      ①**抓得到②抓不到的那一类**：迁完之后删了 3 条老账、又记了 3 笔新账 ——
//      条数一模一样，②看不出来，①一眼看出那 3 个 id 不在老数组里（M10e/M10e2）。
//      ①**只翻一页**，靠的是一条排序性质：sortKey = pad13(createdAt) + '_' + id，
//      倒序 = (createdAt 倒序, id 倒序)，而 createdAt 服务端给、updateRecord 改不了，
//      老数组里每一条都在迁移之前创建 —— 所以迁移后记的账是倒序序列的一个**前缀**
//      （和 recentAndToday 判「今天取全了没有」同一条性质）。这条性质不成立时
//      （时钟回拨、带外塞老日期文档）由②兜底。
//
//   ② 事务外、有毫秒级竞态、判「有多少」：countAll() 数整本账套，和归并条数比。
//      这是当晚**已经有实证**的那一份 —— 每家店迁移前跑的 checkAggregates 第一件事
//      就是它（本文件 checkMigrated 里的 store.countAll()，同一条形状、同一家店、
//      几分钟前刚成功过）。
//      ②**抓得到①抓不到的那一类**：残骸埋在最新一页之外（这本账迁过、被 force
//      回滚过、又重迁过，上一轮的文档 sortKey 排在老数组后面）。**M10h 钉的就是
//      这一类**：拆掉②之后 M10h 必须变红，那是②有牙的验收标准。
//      竞态两个方向都有：窗口里新记账 -> 数**偏小**（可能放过一次该拦的），窗口里
//      删记录 -> 数**偏大**（可能误拦一次合法的，安全侧，force 可恢复）。偏小那个
//      方向恰好是①的强项：窗口里新记的账 createdAt 最大，一定在最新一页最前面。
//      **所以②是提醒不是保险箱，回包里的数才是最终账。**
//
// 两个信号的失效面**重叠得很窄，但不是零**。同时弄瞎两个需要：带外删掉 k 条已迁
// 文档 + 带外塞进 k 条 createdAt 排在最新一页之外的文档 —— 条数被抹平（②瞎）而且
// 外来文档不在最新一页（①瞎）。app 内没有任何路径能塞一条 createdAt 比老数组还早
// 的文档，所以现实里做不出来；但**别把这句写回「失效模式互不重叠」**，那句是假的。
//
// **force: true 绕过的是整道守卫，包括探针本身。** 探针读不到数（云端不支持、
// 超时、账套号中途变了、事务外那次读账本没读到）时：不带 force 一律拒绝并在错误里
// 点名 force；带 force 照常回滚，把读不到数的原因原样写进回包。
// **守卫可以失灵，这条出路不许失灵。**
//
// 这条合同在结构上由两件事保证，改这段的人两件都要维持：
//   a. 事务外那半场收在 preCountProbe 里，**它不抛**；
//   b. 事务内那半场收在 rollbackGuard 里，**它也不抛**。
// 但「从入口到 tx.putLedger 之间会抛的语句只有两条、都是『要不要回滚』这个决定
// 本身的一部分」**不是一句干净的保证**——两条各有一处必须照实说的缺口：
//   · 缺口一（`if (!cur)`，回滚和 dropLegacy 的事务体各有一条）：它测的不是
//     「账本在不在」，是「账本在不在 **或者** 事务里这次读失败了」——真云的
//     tx.getLedger（index.js 的事务适配器）和 db.getLedger 一样**把一切异常吞成
//     null**。后一种情形带 force 也出不去，**这是有意的**：cur 都没读到，往下唯一
//     安全的动作就是什么都别写（putLedger 是整文档 set()，拿一份读不到原件的
//     文档往下走就是毁账本），拒绝是对的。代价是「这条出路不许失灵」在这条路上
//     失效：force 无效、只能重试——所以那句错误文案必须把两种可能都点到、并给出
//     「再调一次」的指引，不能断言「账本不存在」（M10j 的第四个零件钉着这一条）。
//   · 缺口二（bookOf(cur, shopId)）：它也在 force 之外。真实数据上 String() 对
//     任何 JSON 值都不抛、实际够不着它，但它确实是一条没被 force 覆盖的语句——
//     别把这里的说法简化回「只剩两条」。
// 2b-1b 审计阻塞 1 就是事务外那次 db.getLedger 漏在 try 外面：真云的 getLedger
// **把一切异常吞成 null**（index.js 的 createDb），于是一次瞬时读失败在这里不是抛
// 超时、而是走到 `if (!pre) throw new Error('店铺账本不存在')` —— 带不带 force
// 都报同一句，紧急出路当场没了，而且那句文案会让凌晨两点的人以为账本真的丢了。

// 信号②的事务外半场。**任何情况下都不抛**：算不出来就把原因写进 countError。
// 返回的 bookId 是「事务外那次数的是哪一本」，交给事务内比对。
async function preCountProbe(db, shopId) {
  const out = { known: false, bookId: '', count: null, countError: '' }
  let pre = null
  try {
    pre = await db.getLedger(shopId)
  } catch (error) {
    out.countError = '事务外读账本失败：' + errorText(error)
    return out
  }
  if (!pre) {
    // 真云的 getLedger 把读失败也吞成 null，所以这里既可能是「真没这份文档」、
    // 也可能是一次瞬时读失败。两种都只该弄瞎②；判「账本在不在」的是事务里那次读。
    out.countError = '事务外没读到账本文档（真云的 getLedger 把读失败也吞成 null），'
      + '拿不到账套号，数不了集合条数'
    return out
  }
  out.known = true
  out.bookId = bookOf(pre, shopId)
  try {
    out.count = await recordsModule.recordStore(db.recordsCtx(), out.bookId, shopId).countAll()
  } catch (error) {
    out.countError = errorText(error)
  }
  return out
}

// 回滚守卫的事务内半场 + 两个信号的合并。**任何情况下都不抛**（上面的 b）：
// 算不出来就把原因写进 probeError / countError，回一个「什么都不知道」的结论，
// 由调用方按 force 决定是拒绝还是照常回滚。
// 连 apply.legacyRecordsOf 也包在里面：它是纯函数，但 records 不是数组时会抛
//（实测 records 传字符串 -> "(list || []).map is not a function"），
// 而它只服务于守卫，不该有能力把 force 一起带走。
async function rollbackGuard(tx, cur, shopId, bookId, pre) {
  const guard = {
    mergedCount: null,
    collectionCount: pre.count,
    countError: pre.countError,
    foreign: [],
    foreignMore: false,
    probeError: ''
  }
  if (pre.known && bookId !== pre.bookId) {
    // 事务外那一次数的是另一本账（中途有人 clearAll / loadSeed 换了账套），作废。
    guard.collectionCount = null
    guard.countError = '账套号在读数和事务之间变了（' + pre.bookId + ' → ' + bookId + '），'
      + '事务外数出来的条数不能用；再调一次就好'
  }

  // merged 在事务内从 cur 现算：老数组只可能被 clearAll / loadSeed / dropLegacy 改，
  // 那三条都会把它清空、调用方已经拦掉。纯函数、不发号、不读时钟，放在事务里安全。
  let mergedIds = null
  try {
    const merged = apply.legacyRecordsOf(cur)
    guard.mergedCount = merged.length
    mergedIds = Object.create(null)
    for (let i = 0; i < merged.length; i++) {
      mergedIds[String((merged[i] && merged[i].id) || '')] = true
    }
  } catch (error) {
    // 归并失败**同时**弄瞎两个信号：①要 id 集合，②要归并条数才算得出 extra。
    const why = '老数组归并失败，两个信号都用不了：' + errorText(error)
    guard.probeError = why
    guard.countError = why
    return guard
  }

  // —— 信号①：事务**内**翻最新一页，逐条比 id
  try {
    const store = recordsModule.recordStore(tx.recordsCtx(), bookId, shopId)
    const got = await store.pageDocs({ cursor: '', limit: ROLLBACK_PROBE_LIMIT })
    const docs = got.docs
    for (let i = 0; i < docs.length; i++) {
      const id = String((docs[i] && docs[i].id) || '')
      if (mergedIds[id]) continue
      guard.foreign.push({
        id: id,
        type: String((docs[i] && docs[i].type) || ''),
        createdAt: inventory.toNumber(docs[i] && docs[i].createdAt)
      })
    }
    // 判**条数**不判页数（样板见 ledger-records.js 的 SUFFIX_MAX_RECORDS）：
    // 整页都是外来的，说明这一页装不下，后面还有。
    guard.foreignMore = guard.foreign.length >= got.limit
  } catch (error) {
    guard.probeError = errorText(error)
    guard.foreign = []
    guard.foreignMore = false
  }
  return guard
}

async function rollbackMigration(db, shopId, now, payload) {
  payload = payload || {}
  const force = !!payload.force

  const pre = await preCountProbe(db, shopId)

  const outcome = await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      // 两种可能在这里分不开（真云的 tx.getLedger 把读失败也吞成 null），但有一条
      // 是确定的：回滚一个字都没写。文案必须给出重试指引而不是断言「账本不存在」，
      // 理由见上方「这条合同」那段注释的缺口一。
      throw new Error('事务里没读到这家店的账本。云端的 getLedger 把「文档不存在」和「这次读失败了」'
        + '都返回 null，所以这两种情况在这里分不开。回滚一个字都没写。'
        + '如果店还在，多半是一次瞬时失败 —— 再调一次就好；反复如此再去控制台确认文档还在不在。')
    }
    if (!((cur.records || []).length)) {
      // 三种来路都会把 ledgers.records 清空，别只报第一种：
      throw new Error('没有可回滚的老流水（老数组是空的）。三种来路：跑过 mode:"dropLegacy"；'
        + '店主点过「清空数据」（clearAll）；店主点过「恢复清空前数据」（restoreCleared）。'
        + '后两种在 ledger_clears 的快照文档里还留着老数组的副本')
    }
    const bookId = bookOf(cur, shopId)

    const guard = await rollbackGuard(tx, cur, shopId, bookId, pre)
    const extra = (guard.collectionCount == null || guard.mergedCount == null)
      ? null
      : Math.max(0, guard.collectionCount - guard.mergedCount)
    // discarded = 这次回滚从读路径上抹掉的条数的**下界**（两个信号取大的）。
    // 两个都是下界，取 max 仍然只是下界：页内 2 条 + 页外 4 条 + 带外删 4 条时
    // extra=2、foreign=2，回包写 2、实际抹掉 6。**两个都瞎的时候回 null**，
    // 不回 0 —— 0 读起来像「什么都没丢」，而这时候我们什么都不知道。
    const blind = !!guard.probeError && !!guard.countError
    const discarded = blind ? null : Math.max(extra || 0, guard.foreign.length)

    if (!force) {
      if (guard.probeError || guard.countError) {
        throw new Error('回滚守卫读不到数，判断不了这次回滚会不会丢账：'
          + [guard.probeError && ('翻最新一页失败：' + guard.probeError),
            guard.countError && ('数集合条数失败：' + guard.countError)].filter(Boolean).join('；')
          + '。请先用 listRecords 把集合翻一遍，确认里面没有迁移之后记的账'
          + '（或者已经另行备份），再带 force: true')
      }
      if (guard.foreign.length || extra) {
        throw new Error('这本账迁完之后动过，回滚会丢账：集合最新一页里有 '
          + guard.foreign.length + (guard.foreignMore ? '+' : '') + ' 条不在老数组里'
          + (guard.foreign.length ? '（' + describeForeign(guard.foreign) + '）' : '')
          + '；集合共 ' + guard.collectionCount + ' 条、老数组归并后 ' + guard.mergedCount
          + ' 条，多 ' + extra + ' 条。这些账只在 ledger_records 里，'
          + '老数组一条都不涨，回滚之后老路径上一条都看不见，aggregatesStale 哨兵也看不见。'
          + '确认它们已经另行备份、仍要回滚，请带 force: true')
      }
    }

    await tx.putLedger(shopId, Object.assign({}, cur, {
      recordsMigratedAt: 0,
      migration: null,
      revision: inventory.toNumber(cur.revision) + 1
    }))
    return {
      legacyCount: (cur.records || []).length,
      mergedCount: guard.mergedCount,
      collectionCount: guard.collectionCount,
      countError: guard.countError,
      foreignCount: guard.foreign.length,
      foreignMore: guard.foreignMore,
      foreignSample: guard.foreign.slice(0, ROLLBACK_FOREIGN_SAMPLE),
      probeError: guard.probeError,
      discarded: discarded
    }
  })
  return {
    state: 'rolledBack',
    phase: '',
    // legacyCount 仍是**老数组原始条数**（按行），mergedCount 才是和 collectionCount
    // 可比的那个量。两个都回，当晚核对时不用再猜是哪一个。归并失败时 mergedCount 为 null。
    legacyCount: outcome.legacyCount,
    mergedCount: outcome.mergedCount,
    // 事务**外**数的，有毫秒级竞态；数不到时为 null，原因在 countError 里
    collectionCount: outcome.collectionCount,
    countError: outcome.countError,
    // 事务**内**数的，精确：最新一页里有几条不在老数组
    foreignCount: outcome.foreignCount,
    foreignMore: outcome.foreignMore,
    foreignSample: outcome.foreignSample,
    probeError: outcome.probeError,
    forced: force,
    // 抹掉条数的**下界**（两个信号取大的）。两个探针都瞎时为 null = 「不知道」，
    // 不是 0 = 「什么都没丢」。
    discarded: outcome.discarded,
    updatedAt: now
  }
}

// mode:'dropLegacy' —— 把 ledgers.records 置空。**跑完就没有 O(1) 回滚了**，
// 默认不跑，只在 P12 逼近 5MB 时当晚跑。
//
// 前置条件只有两条，两条都**直接**回答「删了会不会把唯一一份副本删掉」：
//
//   ① recordsMigratedAt 非空。它是写路径的解冻开关（assertRecordsReady）：
//      写着它，新账就只进集合，老数组不再是活数据。
//   ② 集合里数得出条数，而且**不是空的**（老数组非空时）。这一条是新加的，
//      它挡的是「recordsMigratedAt 写着、集合却是另一本 / 空的」——
//      那种时候老数组是**唯一**副本，删了就真的没了。
//
// **不再看 migration.phase === 'done'**（2b-1b 审计 A6）。三条理由：
//   a. 它和 recordsMigratedAt 是在**同一个事务**里写进去的（verifyPhase 收尾那一次
//      putLedger），所以作为前置条件它从来说不出 recordsMigratedAt 说不出的话。
//   b. 它**活不过一笔账**：applyMutation 只把 records / recordsMigratedAt /
//      migratedFromLocal / importing 带过 listsOf。而上线清单的顺序恰好是
//      「迁完 -> 记一笔 1 元测试账确认写路径解冻 -> 再删掉 -> 跑 dropLegacy」，
//      于是需要 dropLegacy 的那家店必然卡死，app 内没有出路。
//      （2b-1c 起 applyMutation 也把 migration 带过去了，但前置条件不该靠它 ——
//      1b 那一版已经上过的店，migration 是补不回来的，见测试 M16e。）
//   c. 它一旦触发，文案是**误导性的**：recordsMigratedAt 明明写着、迁移明明成功了，
//      报的却是「还没完成流水升级」，凌晨两点看到这句会以为迁移失败要重来。
//
// ② 的条数在**事务外**数（和回滚守卫的信号②同一条路、同一个理由）：
// transaction.collection().where().count() 在这个仓里一次都没跑过，不许把它放到
// 一条不可逆的破坏性操作的前置条件上。事务外的 countAll() 是有实证的那一份 ——
// 同一家店几分钟前跑 checkAggregates 时刚成功过。
//
// **故意不给 force**：和 rollback 不同，dropLegacy 是优化不是出路。数不着就报错、
// 让人再调一次，什么都没坏；给它一个「绕过检查照样删」的开关，等于给一条不可逆
// 操作配一把能关掉唯一一道闸的钥匙。
//
// 判据是「集合空不空」而**不是**「集合条数 >= 归并条数」：迁完之后正常营业一周，
// 店主删掉几张单是常态（deleteRecord 从集合里删、老数组一条不动），拿条数当硬闸
// 会在最需要 dropLegacy 的那家店上误伤。差多少照样回在 shortfall 里给人看。
async function dropLegacy(db, shopId, now) {
  const pre = await preCountProbe(db, shopId)
  const outcome = await db.runTransaction(async function (tx) {
    const cur = await tx.getLedger(shopId)
    if (!cur) {
      // 和 rollbackMigration 事务体里那句同一口径：两种可能分不开、一条都没删、
      // 给出重试指引。这一条同样没有 force 可绕（见 rollbackMigration 上方注释）。
      throw new Error('事务里没读到这家店的账本。云端的 getLedger 把「文档不存在」和「这次读失败了」'
        + '都返回 null，所以这两种情况在这里分不开。老流水一条都没删。'
        + '如果店还在，多半是一次瞬时失败 —— 再调一次就好；反复如此再去控制台确认文档还在不在。')
    }
    if (!cur.recordsMigratedAt) {
      throw new Error('本店账本还没完成流水升级（recordsMigratedAt 是空的），不能删老流水。'
        + '先不带 mode 调 migrateRecords 把它迁完')
    }
    const dropped = (cur.records || []).length
    const bookId = bookOf(cur, shopId)
    let mergedCount = null
    try {
      mergedCount = apply.legacyRecordsOf(cur).length
    } catch (error) {
      throw new Error('老数组归并不出来，判断不了集合里那份全不全：' + errorText(error))
    }
    if (mergedCount) {
      if (pre.known && bookId !== pre.bookId) {
        throw new Error('账套号在数条数和事务之间变了（' + pre.bookId + ' → ' + bookId + '），'
          + '事务外数出来的条数不能用；再调一次就好')
      }
      if (pre.countError || pre.count == null) {
        throw new Error('删老流水前要先数一遍集合，确认流水真的在里面，但这次没数着：'
          + (pre.countError || '没拿到条数')
          + '。事务外的 countAll 是有实证的那一份（几分钟前跑 checkAggregates 时刚成功过），'
          + '所以这多半是一次瞬时失败，过一会儿再调一次')
      }
      if (!pre.count) {
        throw new Error('账套 ' + bookId + ' 的集合里一条流水都没有，而老数组归并后有 '
          + mergedCount + ' 条 —— 老数组现在是这 ' + mergedCount + ' 条的**唯一**副本，删了就没了。'
          + '先跑 checkAggregates 看这本账套对不对（多半是 newBook 换过账套、或者 bookId 被改过），'
          + '真要退回老路径请用 mode: "rollback"')
      }
    }
    await tx.putLedger(shopId, Object.assign({}, cur, {
      records: [],
      revision: inventory.toNumber(cur.revision) + 1
    }))
    return {
      dropped: dropped,
      bookId: bookId,
      mergedCount: mergedCount,
      collectionCount: pre.count,
      // 集合比归并少几条 = 迁完之后删掉的单数（正常营业会有），只报不拦
      shortfall: (pre.count == null || mergedCount == null)
        ? null
        : Math.max(0, mergedCount - pre.count)
    }
  })
  return {
    state: 'dropped',
    phase: 'done',
    dropped: outcome.dropped,
    bookId: outcome.bookId,
    mergedCount: outcome.mergedCount,
    collectionCount: outcome.collectionCount,
    shortfall: outcome.shortfall,
    updatedAt: now
  }
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
  snapshotBookId: snapshotBookId,
  mergeOnly: mergeOnly,
  sortDesc: sortDesc,
  auditRecords: auditRecords,
  checkLedger: checkLedger,
  verifyChunk: verifyChunk,
  verifyMigrated: verifyMigrated,
  mergeShapeChecks: mergeShapeChecks,
  // 下面三个给 ledger-core 的 migrateLocalShard 用：本机上传要跑同一套校验、
  // 用同一个负账户判据、报同一种人话
  recordFailures: recordFailures,
  negativeAccountsOf: negativeAccountsOf,
  describeProblems: describeProblems,
  movingChangesOf: movingChangesOf,
  accountsDiff: accountsDiff,
  termsDiff: termsDiff,
  truncateReport: truncateReport,
  checkAggregates: checkAggregates,
  migrateRecords: migrateRecords,
  recomputeAggregates: recomputeAggregates
}
