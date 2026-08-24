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
// #1–#5 是流水的读写路径，每一次查询都对得上其中一条，全部避开数组字段；
// #6 只服务 purgeByShop —— 它是本文件里**唯一不带 bookId 前缀**的查询，因为
// 「这家店的流水」跨账套：当前账套、newBook 换掉的旧账套、mode:'snapshots' 转出来的
// clr- 快照账套，共同标识只有 shopId 一个（见 purgeByShop 上方那段））：
//   1  bookId ASC, sortKey DESC                                 -> page / recentAndToday
//   2  bookId ASC, customerId ASC, sortKey DESC                 -> page(customerId) / suffixOfCustomer
//   3  bookId ASC, type ASC, sortKey DESC                       -> page(type)
//   4  bookId ASC, saleOrderId ASC, sortKey ASC                 -> 查一张销售单的退货（整体重算用）
//   5  bookId ASC, type ASC, productId ASC, skuId ASC, sortKey DESC -> latestPurchases
//   6  shopId ASC                                               -> purgeByShop（删店之后清孤儿流水，2b-3）

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
//      虚设**：够不着它，先撞事务。
//
//      原始错误后来拿到了（index.js 那行 console.error）：
//        [ResourceUnavailable.TransactionNotExist]
//        「transaction must be commit or abort in 30 seconds」
//      **但它没解释那次失败**——耗时才 12 秒，离 30 秒差得远。
//      **后来二分过：22 条通过（9.7 秒）、47 条失败（11.3 秒）、92 条失败。**
//      11.3 秒失败而 9.7 秒通过，时间被排除。
//
//      **2026-08-25 的对照实验把剩下两个可能也分开了：是体积，不是条数。**
//      同样 47 条单事务写入（1 ledgers + 1 销售单 + 45 退货单）：
//        新建空店（ledgers 5,932 字节）-> **通过，3.6 秒**
//        演示店（ledgers 3.6 MB）    -> **失败，11.3 秒**
//      写入条数完全相同、唯一变量是账本大小，结果一成一败。
//      （旁证：造那 45 张退货单时小账本店每张 897 毫秒、演示店 8.8 秒，
//      条数一样却差近十倍——事务耗时主要是重写整个 ledgers 撑起来的。）
//
//      **结论：给这个常数定任何值都不安全。** 阈值随账本大小浮动，同一个 N
//      在小店过、在大店不过，而账本会随着做生意一直长。所以原先写的
//      「回来把这个数改对」**不只是做不成，而是方向错了**：把 200 换成 40 只会在
//      小店上白白拒掉合法操作，大店上照样炸。**正确的修法是把整体重算搬出事务**
//      （或至少别在同一个事务里重写整本账）。尚未做：不同时段各测一次排除并发 / 负载。
//
//      **这个常量因此不许删，也不许往 1000 附近调**：它有两个角色，只死了一个。
//      角色 A「拒绝整体重算的闸」确实死了（事务先炸，200 够不着）；角色 B
//      「单次查询的截断探测器」还活着——limit(MAX + 1) + 判 `> MAX` 是用来分辨
//      「刚好取满」和「被云端静默截断」的，云函数侧单次上限 1000，201 安全地在
//      它下面。删掉这个常量、或者把它调到贴近 1000，角色 B 当场失效。
//
//      **在有实测数字之前，真正该修的不是这个数，是失败形态**：N 到 90 时店主
//      看到的是 index.js 改写出来的「库存刚被别人改过，请再提交」，一句劝人重试
//      的话，而这类失败是确定性的、重试永远不成功；反倒是这里设计好的那句「超出
//      一次能整体重算的范围，请联系开发者处理」永远不会出现。详见 index.js 那段。
const SALE_RETURNS_MAX = 200

// 删店之后清孤儿流水（2b-3）的单次调用预算。**两个都要，管的不是同一件事**：
//   · PURGE_MAX_RECORDS 是条数上限，确定性、与机器快慢无关，测试能精确撞上；
//   · PURGE_BUDGET_MS 是墙钟上限，才是生产上真正会先触发的那一个 —— 单条删除多快
//     没实测过，条数上限换算成多少秒是未知数，只有钟能保证这次函数调用不被云端硬
//     超时砍掉（config.json 当前 timeout: 60，这里留出足够余量给删店事务本身）。
// **删不完不是故障，是设计**：调用方拿到 remaining: true 之后带同一个 shopId 再调
// 一次就接着删（purgeByShop 幂等、无需持久化进度）。
const PURGE_MAX_RECORDS = 5000
const PURGE_BUDGET_MS = 30000

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

  // 写入的 data **不许带 `_id`**：文档 id 已经由 `col.doc(id)` 指定，data 里再
  // 出现一次，真实云开发直接拒绝——
  //   document.set:fail -501007 invalid parameters. 不能更新_id的值
  // `ledgers` / `shops` / `members` / `ledger_clears` 四条写路径早就在 index.js 的
  // cloneData 里剥掉了 `_id`，只有这一条没剥——因为它是 2b-1 才加的，而
  // **`ledger_records` 的写在此之前从没在真云上跑过**，第一次跑就是账本升级
  // 的 writePhase，当场 -501007。
  //
  // 剥掉不影响迁移校验 V7：V7 比的是**读回来的**文档的 `_id`，那是数据库按
  // `doc(id)` 自己填的，和 `apply.recordDocId(book, id)` 恒等。
  //
  // 这一类错误测试抓不到过一次：tests/memory-db.js 的 MemoryDoc.set 不但不拒绝
  // 带 `_id` 的 data，还主动补一个，于是 3000 步随机记账、变异测试、真实数据
  // 复演全在替身上跑绿。那边现在会抛错了，别再把它改回去。
  async function set(record) {
    const doc = apply.toRecordDoc(record, book, shop)
    const data = {}
    Object.keys(doc).forEach(function (key) {
      if (key === '_id') return
      data[key] = doc[key]
    })
    await col.doc(doc._id).set({ data: data })
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

// 按 shopId 把一家**已经删掉的**店留下的流水删干净（2b-3）。走索引 #6，是本文件里
// 唯一一条不带 bookId 前缀的查询 —— 这是有意的：一家店的流水可能散在好几个账套里
//（当前账套、newBook 换掉的旧账套、mode:'snapshots' 转出来的 clr- 快照账套），
// 账本文档一删就没人拿得到那些 bookId 了，shopId 是唯一还认得出它们的字段。
//
// **只能在删店事务提交之后调，事务里和事务之前都不行**（理由三条，改这里之前先读完）：
//   ① 塞不进事务。2026-08-24 演示店实测：**单事务写 92 条文档就确定性失败**，
//      服务端报 [ResourceUnavailable.TransactionNotExist]「transaction must be
//      commit or abort in 30 seconds」，而那两次函数耗时只有 12–16 秒 —— 所以
//      **真实边界不是那 30 秒，是别的东西，至今没查清**（那次实测的完整数字、
//      以及那句错误文案为什么解释不了它自己，记在 index.js 事务改写处和本文件
//      SALE_RETURNS_MAX 那两段注释里）。不管边界具体在哪，上万条删除进事务都
//      远远越过它，而且事务原子回滚 —— 连店都删不掉。
//   ② 不许反过来「先清流水再删店」。清到一半失败就是一家**活着的**店掉了一半流水，
//      聚合还在、流水少了 —— 那是**错数**，而 recomputeAggregates 修不回来（它按集合
//      现状重折叠）。提交之后再清，最坏也只是泄漏，不可能算错。
//   ③ 于是中途停下必须能续：判据只有 shopId 一个，不需要持久化任何进度，拿同一个
//      shopId 再调一次就接着删。删店之后店主已经不是成员，续的入口是平台运营方动作
//      purgeDeletedShopRecords（见 ledger-core.js）。
//
// **不抛错**（唯一的例外是空 shopId，见下）。调用时机是事务已经提交、店已经没了，
// 这时把一次删除失败抛成「删店失败」会让店主以为店还在、再点一次（再点报「不是该店
// 成员」）。读失败 / 删失败一律就地停下，把已删条数和错误原文一起回给调用方写日志。
// 空 shopId 是**调用方的 bug**，那一条必须抛：where({ shopId: '' }) 命中的是所有
// shopId 为空的文档，那不是「这家店的流水」，是别人的。
//
// 循环形状和仓里另外三处「有界循环」（SUFFIX_MAX_RECORDS / TODAY_MAX_RECORDS /
// ledger-migrate.js 的 readAllDocs）**同源但不同形**，两点差别：
//   ① 那三处是游标向前翻，必须回答「还有没有下一页」，于是有 hasMore 的 off-by-one；
//      这里**边读边删**，同一条 where 再查一次返回的就是剩下的，所以终止判据是
//      「这一页查出来 0 条」—— 精确，不判页数，也没有 off-by-one。
//   ② 预算仍然**判条数不判页数**（deleted >= cap），和那三处同一份样板。
//
// 不用 where().remove() 批量删：单次批量删的条数上限没有实测过，返回的 stats.removed
// 也分不清「删完了」和「被云端截断了」—— 和 SALE_RETURNS_MAX 顶上是同一类风险。
// 逐条删慢，但每一条的成败都是确定的。**这是取舍，不是没想到**：真要换批量删，
// 先在真环境上把上限和截断信号实测出来再说。
//
// options：
//   maxRecords 单次最多删多少条，只能**调小**不能调大（clamp 到 PURGE_MAX_RECORDS）
//   deadline   墙钟截止时刻（毫秒），到点就停
//   clock      取当前时刻的函数，缺省 Date.now；测试注入它才能确定性地撞上 deadline
// 回值：{ removed: 已删条数, remaining: 是否还有剩, stopped: 'cap'|'time'|'error'|'',
//        error: 错误原文（没有就是空串） }
async function purgeByShop(ctx, shopId, options) {
  options = options || {}
  const shop = String(shopId == null ? '' : shopId)
  if (!shop) {
    throw new Error('缺少 shopId，不能按店清理流水')
  }
  // 非法值（未传 / NaN / 负数 / 字符串）一律退回缺省，**不许当成「无上限」** ——
  // cap 是 NaN 时 `removed >= cap` 恒为假，这个循环就变成无界的了。
  // **先取整再判 > 0**，顺序反过来的话 0.5 会通过「> 0」、取整之后变成 cap = 0，
  // 于是这次调用一条都不删却回 remaining: true —— 安全但莫名其妙的空转。
  const wantedCap = Math.floor(Number(options.maxRecords))
  const cap = Number.isFinite(wantedCap) && wantedCap > 0
    ? Math.min(wantedCap, PURGE_MAX_RECORDS)
    : PURGE_MAX_RECORDS
  // null 要当成「不限时」而不是「截止时刻 0」：Number(null) === 0 是有限数，
  // 照单全收就等于一进来就超时，同样是一次莫名其妙的空转。undefined 天然是 NaN。
  const wantedDeadline = options.deadline == null ? NaN : Number(options.deadline)
  const deadline = Number.isFinite(wantedDeadline) ? wantedDeadline : null
  const clock = options.clock || Date.now
  const col = ctx.collection
  let removed = 0
  function outOfTime() {
    return deadline != null && clock() >= deadline
  }
  try {
    for (;;) {
      if (removed >= cap) return { removed: removed, remaining: true, stopped: 'cap', error: '' }
      if (outOfTime()) return { removed: removed, remaining: true, stopped: 'time', error: '' }
      const res = await col.where({ shopId: shop }).limit(PAGE_LIMIT).get()
      const docs = docsOf(res)
      // 边读边删，所以「这一页 0 条」= 真的删完了。不判页数。
      if (!docs.length) return { removed: removed, remaining: false, stopped: '', error: '' }
      for (let i = 0; i < docs.length; i++) {
        const id = String((docs[i] && docs[i]._id) || '')
        if (!id) {
          // 没有 _id 就删不掉，而下一轮同一条又会被查出来 —— 不停下就是死循环
          //（cap 兜得住，但那是把预算烧在一条烂数据上）。
          return {
            removed: removed, remaining: true, stopped: 'error',
            error: '集合里有一条没有 _id 的文档，删不掉：shopId=' + shop
          }
        }
        await col.doc(id).remove()
        removed += 1
        if (removed >= cap || outOfTime()) break
      }
    }
  } catch (error) {
    return {
      removed: removed,
      remaining: true,
      stopped: 'error',
      error: String((error && error.message) || error || '')
    }
  }
}

module.exports = {
  COLLECTION: COLLECTION,
  PAGE_LIMIT: PAGE_LIMIT,
  SUFFIX_MAX_RECORDS: SUFFIX_MAX_RECORDS,
  LATEST_PURCHASE_KEEP: LATEST_PURCHASE_KEEP,
  TODAY_MAX_RECORDS: TODAY_MAX_RECORDS,
  SALE_RETURNS_MAX: SALE_RETURNS_MAX,
  PURGE_MAX_RECORDS: PURGE_MAX_RECORDS,
  PURGE_BUDGET_MS: PURGE_BUDGET_MS,
  recordStore: recordStore,
  recentAndToday: recentAndToday,
  applyWrites: applyWrites,
  purgeByShop: purgeByShop
}
