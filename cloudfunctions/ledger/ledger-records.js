const apply = require('./ledger-apply')
const inventory = require('./inventory')

// 流水集合 ledger_records 的访问层。
//
// **这个文件不参与 `npm run sync:ledger-inventory`**：同步的仍然只有
// utils/inventory.js 和 utils/ledger-apply.js。那两个文件必须保持 100% 纯函数、
// 零 IO，「去数据库找哪几条流水」全部收在这里。
//
// 文档形状和 sortKey / _id 的定义在 ledger-apply.js（纯映射，小程序内存模式也要用）。
//
// 需要在云控制台建的索引（本文件的每一次查询都对得上其中一条，全部避开数组字段）：
//   1  bookId ASC, sortKey DESC                                 -> page / recentAndToday
//   2  bookId ASC, customerId ASC, sortKey DESC                 -> page(customerId) / suffixOfCustomer
//   3  bookId ASC, type ASC, sortKey DESC                       -> page(type)
//   4  bookId ASC, saleOrderId ASC, sortKey ASC                 -> 查一张销售单的退货（整体重算用）
//   5  bookId ASC, type ASC, productId ASC, skuId ASC, sortKey DESC -> latestPurchases
//   6  shopId ASC                                               -> deleteShop 清理、跨账套运维

const COLLECTION = 'ledger_records'
const PAGE_LIMIT = 100
// getSlip 倒推上限：5000 条还倒推不出当时欠款就报错。
// 宁可报错，也不能在客户手上的单据上印一个错数。
//
// 上限按**条数**判，不按页数判：hasMore = docs.length >= limit 在总数正好是
// 整页倍数时恒为真，按页数判会把「正好 N 条」也算成超限 —— 老实现名义 5000、
// 实际 4999 就到顶，就是这个 off-by-one。**这是仓里唯一一份样板**（2b-2b 删掉
// COMPAT_MAX_RECORDS 之后），下一个写有界循环的人照着这里写，不要再错一遍。
const SUFFIX_MAX_RECORDS = 5000
// 「集合去掉一个元素之后的最大值」由原集合前 2 名一定能确定，所以取 2 条：
// 改一条 in 不改 createdAt，删一条要把它从候选里去掉，两种都够。
const LATEST_PURCHASE_KEEP = 2
// recentAndToday 的无界循环兜底：跨 dayStart 之前一直翻不到头（比如 dayStart
// 非法却没被拦住）就会一直往前翻。2000 条封顶，超过就报「算不出来」而不是
// 一直翻下去 —— 和 SUFFIX_MAX_RECORDS 一样是「有界循环」的兜底，但两者是不同
// 的量（一个管今日聚合翻多远，一个管欠款倒推翻多远），互不影响。
const TODAY_MAX_RECORDS = 2000
// 一张销售单名下退货单的查询上限：200 张已远超现实（一次退货是一张单，退 200 次
// 同一张销售单），到顶说明数据不对劲，报错不做无界翻页 —— 有界循环的同一份样板。
const SALE_RETURNS_MAX = 200

function docsOf(res) {
  return (res && res.data) || []
}

// ctx = { collection: <ledger_records 集合句柄>, command: db.command }
// 传 db 的句柄就是事务外读，传 transaction 的句柄就是事务内读写。
function recordStore(ctx, bookId, shopId) {
  const col = ctx.collection
  const _ = ctx.command
  const book = String(bookId == null ? '' : bookId)
  const shop = String(shopId == null ? '' : shopId)

  async function rawById(id) {
    try {
      const res = await col.doc(apply.recordDocId(book, id)).get()
      const doc = res && res.data
      if (!doc || String(doc.bookId || '') !== book) return null
      return doc
    } catch (error) {
      return null
    }
  }

  async function byId(id) {
    const doc = await rawById(id)
    return doc ? apply.fromRecordDoc(doc) : null
  }

  async function saleOrder(id) {
    const record = await byId(id)
    if (!record || record.type !== 'out') return null
    return record
  }

  async function latestPurchases(productId, skuId) {
    const res = await col.where({
      bookId: book,
      type: 'in',
      productId: String(productId || ''),
      skuId: String(skuId || '')
    }).orderBy('sortKey', 'desc').limit(LATEST_PURCHASE_KEEP).get()
    return docsOf(res).map(apply.fromRecordDoc)
  }

  // 一张销售单名下的全部退货单，按记账顺序（sortKey 升序）返回，给整体重算用
  // （inventory.recomputeSaleReturns）。where 不加 type：toRecordDoc 只给 return
  // 写非空 saleOrderId，其余类型恒 ''，这条 where 天然只命中退货单，正好对上索引 #4。
  async function returnsOfSale(saleOrderId) {
    const res = await col.where({
      bookId: book,
      saleOrderId: String(saleOrderId || '')
    }).orderBy('sortKey', 'asc').limit(SALE_RETURNS_MAX).get()
    const docs = docsOf(res)
    if (docs.length >= SALE_RETURNS_MAX) {
      throw new Error('这张销售单的退货单太多，请先删掉一些退货单再改')
    }
    return docs.map(apply.fromRecordDoc)
  }

  // 倒序一页。cursor 是上一页最后一条的 sortKey。
  // limit 钳制走 apply.clampPageLimit：不传时缺省 20（2b-2 之前是 100），
  // 调用方核实过这条变化 —— recentAndToday / suffixOfCustomer 都显式传自己的
  // limit（PAGE_LIMIT=100），不受影响，见 tests/ledger-records.test.js。
  async function page(options) {
    options = options || {}
    const limit = apply.clampPageLimit(options.limit)
    const where = { bookId: book }
    const type = String(options.type || '')
    if (type && type !== 'all') {
      where.type = type === 'adjust' ? _.in(['adjust_in', 'adjust_out']) : type
    }
    if (options.customerId) {
      where.customerId = String(options.customerId)
    }
    if (options.cursor) {
      where.sortKey = _.lt(String(options.cursor))
    }
    const res = await col.where(where).orderBy('sortKey', 'desc').limit(limit).get()
    const docs = docsOf(res)
    return {
      records: docs.map(apply.fromRecordDoc),
      cursor: docs.length ? String(docs[docs.length - 1].sortKey || '') : '',
      hasMore: docs.length >= limit
    }
  }

  async function countAll() {
    const res = await col.where({ bookId: book }).count()
    return (res && res.total) || 0
  }

  // receivableAt 的口径是 createdAt <= at（含同毫秒的本单自己），
  // 所以后缀必须是 createdAt > at，即 sortKey >= pad13(at + 1)。
  // createdAt 是整数毫秒，两者严格互补，没有重叠也没有遗漏。
  // 上限判条数不判页数，理由见 SUFFIX_MAX_RECORDS 顶上那段（同一个 off-by-one）。
  async function suffixOfCustomer(customerId, fromSortKey, maxRecords) {
    const cap = maxRecords == null ? SUFFIX_MAX_RECORDS : maxRecords
    const cid = String(customerId || '')
    if (!cid) return []
    let bound = _.gte(String(fromSortKey || ''))
    const out = []
    for (;;) {
      const res = await col.where({
        bookId: book,
        customerId: cid,
        sortKey: bound
      }).orderBy('sortKey', 'asc').limit(PAGE_LIMIT).get()
      const docs = docsOf(res)
      for (let n = 0; n < docs.length; n++) {
        out.push(apply.fromRecordDoc(docs[n]))
      }
      if (out.length > cap) throw new Error('流水太多，暂时算不出当时欠款')
      if (docs.length < PAGE_LIMIT) return out
      bound = _.gt(String(docs[docs.length - 1].sortKey || ''))
    }
  }

  async function set(record) {
    const doc = apply.toRecordDoc(record, book, shop)
    await col.doc(doc._id).set({ data: doc })
  }

  // 只删本事务里刚读到过的记录，删不掉要让事务失败：
  // 悄悄吞掉会让聚合减了、记录还在，账就漂了。
  async function remove(id) {
    await col.doc(apply.recordDocId(book, id)).remove()
  }

  return {
    collectionName: COLLECTION,
    bookId: book,
    shopId: shop,
    byId: byId,
    saleOrder: saleOrder,
    latestPurchases: latestPurchases,
    returnsOfSale: returnsOfSale,
    page: page,
    countAll: countAll,
    suffixOfCustomer: suffixOfCustomer,
    set: set,
    remove: remove
  }
}

// 「最近一页」+「今日三项」合成一次查询。
//
// 依据是一条可证的性质：sortKey = pad13(createdAt) + '_' + id，按 sortKey 倒序
// = 按 (createdAt 倒序, id 倒序)，所以「今天」的流水一定是这个序列的一个前缀 ——
// 翻到一条 createdAt < dayStart 后面就不可能再有今天的。于是「今天有没有取全」
// 是可判定的，不是猜的：翻到边界（crossed）或者翻到整本流水的头（!hasMore）
// 都叫「取全了」；命中 TODAY_MAX_RECORDS 还没翻到边界，才是「算不出来」。
//
// dayStart 为 null（调用方校验过的非法值）时不算 today，只取 recent 那一页，
// 一次查询就完事 —— 不因为一个乱来的 dayStart 去烧多次往返。
async function recentAndToday(store, dayStart, recentLimit) {
  const limit = apply.clampPageLimit(recentLimit)
  const day = Number(dayStart)
  const wantToday = dayStart != null && Number.isFinite(day) && day > 0

  if (!wantToday) {
    const got = await store.page({ cursor: '', limit: limit })
    return { recent: got.records, today: null, todayComplete: false }
  }

  let cursor = ''
  let all = []
  let hasMore = true
  let crossed = false
  for (;;) {
    const got = await store.page({ cursor: cursor, limit: PAGE_LIMIT })
    all = all.concat(got.records)
    hasMore = got.hasMore
    cursor = got.cursor
    if (!crossed) {
      crossed = got.records.some(function (item) {
        return inventory.toNumber(item && item.createdAt) < day
      })
    }
    if (all.length >= TODAY_MAX_RECORDS) break
    if (all.length >= limit && (crossed || !hasMore)) break
    if (!hasMore) break
  }

  const complete = crossed || !hasMore
  return {
    recent: all.slice(0, limit),
    today: complete ? inventory.todayTotals(all, day) : null,
    todayComplete: complete
  }
}

async function applyWrites(store, writes) {
  const list = writes || []
  for (let i = 0; i < list.length; i++) {
    const write = list[i]
    if (write.op === 'remove') {
      await store.remove(write.id)
    } else {
      await store.set(write.record)
    }
  }
  return list.length
}

module.exports = {
  COLLECTION: COLLECTION,
  PAGE_LIMIT: PAGE_LIMIT,
  SUFFIX_MAX_RECORDS: SUFFIX_MAX_RECORDS,
  LATEST_PURCHASE_KEEP: LATEST_PURCHASE_KEEP,
  TODAY_MAX_RECORDS: TODAY_MAX_RECORDS,
  SALE_RETURNS_MAX: SALE_RETURNS_MAX,
  recordStore: recordStore,
  recentAndToday: recentAndToday,
  applyWrites: applyWrites
}
