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
// 需要的索引（用 node scripts/wxcloud-ensure-indexes.js 建，幂等；不要靠控制台手点。
// #1–#5 本文件的每一次查询都对得上其中一条，全部避开数组字段；#6 当前没有任何
// 查询使用——它是给 2b-3 的 deleteShop 清理 ledger_records 预建的，删店目前只删
// shops / members / ledgers / ledger_clears，见 ledger-core.js 的 deleteShop 和
// docs/cloud-ledger.md 的「删除店铺」）：
//   1  bookId ASC, sortKey DESC                                 -> page / recentAndToday
//   2  bookId ASC, customerId ASC, sortKey DESC                 -> page(customerId) / suffixOfCustomer
//   3  bookId ASC, type ASC, sortKey DESC                       -> page(type)
//   4  bookId ASC, saleOrderId ASC, sortKey ASC                 -> 查一张销售单的退货（整体重算用）
//   5  bookId ASC, type ASC, productId ASC, skuId ASC, sortKey DESC -> latestPurchases
//   6  shopId ASC                                               -> 给 2b-3 的 deleteShop 清理预留，当前无查询使用

const COLLECTION = 'ledger_records'
const PAGE_LIMIT = 100
// getSlip 倒推上限：5000 条还倒推不出当时欠款就报错。
// 宁可报错，也不能在客户手上的单据上印一个错数。
//
// 上限按**条数**判，不按页数判：hasMore = docs.length >= limit 在总数正好是
// 整页倍数时恒为真，按页数判会把「正好 N 条」也算成超限 —— 老实现名义 5000、
// 实际 4999 就到顶，就是这个 off-by-one。下一个写有界循环的人照着这里写，
// 不要再错一遍。**同型的有界循环仓里还有两处**：本文件的 recentAndToday
//（TODAY_MAX_RECORDS）和 ledger-migrate.js 的 readAllDocs —— 三处**都判条数不判
// 页数**，但到顶之后的动作不同：本处和 readAllDocs 是 `> cap` + throw，
// recentAndToday 是 `>= MAX` + break（不抛，回 todayComplete: false）。
// 单次查询上限（returnsOfSale）是另一种形状，见 SALE_RETURNS_MAX 那段。
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
// **查询要 limit(MAX + 1)、判据要 `> MAX`**，理由见 returnsOfSale 里那段。
// **静默截断现在不只毁份额**：repriceSaleReturns 已经改成按 Σ退货额**覆盖**
// 销售行的 returnedAmount（不再是「原值 + 差额」），所以只捞回一部分退货单时，
// returnedAmount 会被就地写小成「捞回来那几张的和」—— 已退货值当场缩水，
// 下一次退货按这个偏低的基准算冲抵，柜台多退现金。这就是为什么这里宁可抛错。
// 两件事写在这里，别踩：
//   ① 这是一道**死角**。到顶之后改这张销售单、以及改/删它名下的任何退货单，
//      都要先把全部退货单捞齐来整体重算，于是两条路都撞在这里，app 内没有出路，
//      只能后台处理。所以错误文案不许写成「请先删掉一些退货单」——那是店主做不到
//      的事。真要给出路，得单开一条「不重算只删」的运维通道，那是另一件事。
//   ② 真正的约束不是这个数，而是**单次事务的写入量**：整体重算会连带重写全部
//      退货单，写放大 = ledgers 1 + 目标 1 + N。200 是按「现实里不会有这么多」
//      拍的。**2026-08-24 在演示店 mt33kfi77idxpw 实测过了：N = 90（单事务写
//      92 条）确定性失败**，两次都报 index.js 那句「库存刚被别人改过，请再提交」；
//      函数耗时 12.3 / 11.5 秒（上限 60 秒）、内存 155 / 138 MB（上限 512 MB），
//      事务原子回滚、一条都没写进去。所以**真实上限远低于 200，这个常量当前形同
//      虚设**：够不着它，先撞事务。撞到哪一条限制仍未知——底层错误被 index.js
//      吞掉了（那边已加 console.error，拿到原文之后再回来把这个数改对）。
//      在改对之前，别把 200 当成「验证过安全」的值引用。
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
  //
  // limit 取 **MAX + 1**、判据取 **> MAX**，两条理由：
  //   ① 名义和实际对齐。limit(MAX) + `>= MAX` 是 SUFFIX_MAX_RECORDS 顶上批评的
  //      那个 off-by-one：文案说「超过 200 张」，触发点却是「等于 200 张」，
  //      第 200 张退货单就把这张销售单锁死了。
  //   ② 多要一条才判得出「到底是刚好取满还是被截断了」。`get()` 的 limit 上限
  //      是未实测项：真实云开发若把它压到低于 200，limit(MAX) + `>= MAX` 永远
  //      不触发，返回的是一组**静默截断**
  //      的退货单，recomputeSaleReturns 在不完整的组上分份额 —— 拆分不变量破裂，
  //      欠款和现金退款额一起算错，而且不报错。**更糟的是 repriceSaleReturns 会把
  //      销售行的 returnedAmount 按 Σ 覆盖成「捞回来那几张的和」**，已退货值就地缩水，
  //      之后每一次退货都按这个偏低的基准算冲抵。
  //      要 MAX + 1、判 > MAX 之后，只要云端单次上限 ≥ MAX + 1 就一定判得出来
  //      （wx-server-sdk 云函数侧是 1000，远够）。**这一条不是无条件的**：
  //      上限恰好等于 MAX 时反而是老写法碰巧会抛（它请求 MAX 拿满就抛），
  //      而新写法请求 MAX+1 只拿回 MAX、判不出来 —— 所以 MAX 不许调到接近
  //      云端上限，两者之间必须留出至少一条的余量。
  async function returnsOfSale(saleOrderId) {
    const res = await col.where({
      bookId: book,
      saleOrderId: String(saleOrderId || '')
    }).orderBy('sortKey', 'asc').limit(SALE_RETURNS_MAX + 1).get()
    const docs = docsOf(res)
    if (docs.length > SALE_RETURNS_MAX) {
      throw new Error('这张销售单的退货单太多（超过 ' + SALE_RETURNS_MAX + ' 张），超出一次能整体重算的范围，请联系开发者处理')
    }
    return docs.map(apply.fromRecordDoc)
  }

  // 倒序一页的**原始文档**。cursor 是上一页最后一条的 sortKey。
  // limit 钳制走 apply.clampPageLimit：不传时缺省 20（2b-2 之前是 100），
  // 调用方核实过这条变化 —— recentAndToday / suffixOfCustomer 都显式传自己的
  // limit（PAGE_LIMIT=100），不受影响，见 tests/ledger-records.test.js。
  //
  // page() 就是它加一层 fromRecordDoc。分成两层是因为迁移校验要看
  // _id / sortKey / bookId / shopId 这几个派生字段有没有和来源脱节（V7），而
  // fromRecordDoc 正好把它们剥掉了。**这条 where 只有这一份定义**，
  // 不要在 ledger-migrate.js 里另写一条。
  async function pageDocs(options) {
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
    return { docs: docsOf(res), limit: limit }
  }

  async function page(options) {
    const got = await pageDocs(options)
    const docs = got.docs
    return {
      records: docs.map(apply.fromRecordDoc),
      cursor: docs.length ? String(docs[docs.length - 1].sortKey || '') : '',
      hasMore: docs.length >= got.limit
    }
  }

  async function countAll() {
    const res = await col.where({ bookId: book }).count()
    // total 必须是一个有限数字才算「数着了」。count() 回 {} 或 {total: NaN} 时
    // `(res && res.total) || 0` 会把它吞成 0：信号②（回滚守卫 / dropLegacy 的
    // 事务外计数）静默变成「集合是空的」而不是「数不出来」，dropLegacy 因此会报
    // 出因果错误的「集合里一条流水都没有……多半是 newBook 换过账套」（偏安全侧、
    // 可重试，但把一次瞬时故障指认成了账套不对）。数不出来就抛，让调用方走
    // 「数不着」那条路（preCountProbe 会接住、写进 countError）。
    if (!res || typeof res.total !== 'number' || !isFinite(res.total)) {
      throw new Error('数 ' + COLLECTION + ' 里账套 ' + book + ' 的条数没数出来：'
        + JSON.stringify(res) + ' 不是有限的数字')
    }
    return res.total
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
    pageDocs: pageDocs,
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
