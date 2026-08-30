const apply = require('./ledger-apply')
const inventory = require('./inventory')
const records = require('./ledger-records')
const migrate = require('./ledger-migrate')

const NOT_MEMBER = '不是该店成员'

function publicShop(shop, role) {
  return {
    id: shop._id || shop.id,
    name: shop.name,
    role: role || '',
    ownerOpenid: shop.ownerOpenid || '',
    createdAt: shop.createdAt || 0
  }
}

// 首个账套 bookId = shopId：老账本迁移过来不用发号。
function withBookId(ledger, shopId) {
  if (!ledger) return ledger
  if (ledger.bookId) return ledger
  return Object.assign({}, ledger, { bookId: String(shopId) })
}

// 纯内存：只吃账本文档，出四张表 + 聚合投影。
// **签名里没有 db —— 记账路径拿不到数据库句柄，所以「提交之后又去读库」
// 在那条路上写不出来。** opts 是纯数据（{dayStart, recentLimit}），2b-2a 新增，
// 不破坏这条签名保证。
function publicListsOf(shopId, doc, opts) {
  opts = opts || {}
  const source = doc || apply.emptyLedger()
  const lists = apply.listsOf(withBookId(source, shopId))
  lists.hasClearedBackup = apply.hasClearedBackup(source)
  lists.archivedClearCount = ((source && source.clearSnapshots) || []).length
  // 最近一份清空快照的元信息。「恢复清空前数据」的弹窗要说清恢复的是哪一天、
  // 多少条，光警告「清空之后新记的账会丢掉」不够。recordCount 缺失（升级前存的
  // 老快照，元数据只有 {id, savedAt}）回 null，客户端退化成只带日期；
  // mode:'snapshots' 转换时会把归并条数补进元数据。
  // 投影本身在 ledger-apply 的 latestClearView（内存模式的 memoryPublicLists
  // 用同一份，形状才不会两头漂）。
  const latestClear = apply.latestClearView(source)
  if (latestClear) {
    lists.latestClear = latestClear
  }
  if (apply.recordsPending(source)) {
    // 还没迁移：流水仍在账本文档的数组里，读时自愈之后只当**本地语料**用 ——
    // 2b-2b 起 `ledger.records` 在线上彻底消失（含未迁移的店），流水一律走
    // listRecords 分页取。线上只存在一种线协议形态（方案 Q1）。
    // 写路径已经被 assertRecordsReady 拦住，不会有一半在数组一半在集合的账。
    //
    // 2b-3 起「还没搬」的判据变成 default-deny：没有 recordsMigratedAt、也没有
    // recordsSchema 才算未迁移（见 apply.recordsPending）。所以这个分支现在多覆盖
    // 一类账本 —— 两个章都没有、老数组也丢了。那种时候 legacy 折出来是空的，
    // 读路径给出一本空账，而写路径冻着；这是**故意的**：冻住有出路（跑
    // migrateRecords），放行会把新流水写进一个空集合、老账再也拼不回来。
    //
    // 上面 `const source = doc || apply.emptyLedger()`：emptyLedger 带着
    // recordsSchema 的章，所以「账本文档读不到」这条防御路径不会掉进这个分支，
    // 行为和 2b-3 之前逐字一致。
    const legacy = apply.legacyRecordsOf(source)
    // 迁移窗口内 accounts / aggregate 还是 2b-1 之前的形状（根本没有这两个字段），
    // 直接投影会把全店金额和每个客户的欠款都回传成 0，而 getSlip 的 legacy 分支
    // 走 receivableAt 算得对 —— 送货单印 200、客户页显示 0，自相矛盾（审计阻塞 1）。
    // 数组已经在内存里，现折一次，零额外 IO。
    lists.accounts = inventory.foldAccountTerms(legacy)
    lists.aggregate = inventory.foldTotalTerms(legacy)
    apply.withAggregates(lists)
    lists.recordsPendingMigration = true
    // recent / today 同样从这份已经在内存里的老数组现切，零额外 IO ——
    // 和 listRecords 走的是同一个 apply.pageRecords，一份定义、两处调用（方案 Q1）。
    lists.recent = apply.pageRecords(legacy, { limit: opts.recentLimit }).records
    if (opts.dayStart != null) {
      lists.today = inventory.todayTotals(legacy, opts.dayStart)
      lists.todayComplete = true
    } else {
      lists.today = null
      lists.todayComplete = false
    }
  }
  return lists
}

// getLedger 专用：给已迁移的账套补 recent / today。
// **只准从只读 action 调**：分页查询有界，但仍然是 IO，记账路径不能碰 ——
// 事务已经提交，这里一抛错（或一超时）就变成「账记上了却报失败」，
// 店员再点一次就真的记两笔。
// tests/ledger-records.test.js 的「提交之后不许读库」用例把这条钉死。
//
// countAll() 的漂移哨兵在这里：2b-2b 删掉 attachRecords 之后它是唯一的防线
// （docs/cloud-ledger.md 的「怎么发现漂移」第 ② 条），不能顺手删。
async function attachRecent(db, shopId, lists, dayStart, recentLimit) {
  const store = records.recordStore(db.recordsCtx(), lists.bookId, shopId)
  const got = await records.recentAndToday(store, dayStart, recentLimit)
  lists.recent = got.recent
  lists.today = got.today
  lists.todayComplete = got.todayComplete
  const claimed = (lists.aggregate && lists.aggregate.count) || 0
  // countAll() 对「resolve 出非有限 total」的 count() 会抛（见 ledger-records.js），
  // 在这里必须接住：读路径的哨兵**只报告不阻断**（docs/cloud-ledger.md「怎么发现
  // 漂移」第 ② 条）。数不出来就当「数出来的值和 aggregate.count 对不上」处理 ——
  // 标脏、告警、照常回传。这和 countAll 改成抛错之前的语义在 claimed 非 0 时等价
  //（那时数不出来被吞成 0，0 对不上同样标脏）；唯一的差别在空账：claimed 为 0 时
  // 老代码 0===0 不报，现在数不出来也标脏 —— 多报一次是安全侧，和 countAll 改抛
  // 是同一个理由（数不出来是信号，不是 0）。**运维路径上的调用点故意不一样**：
  // ledger-migrate.js 的 checkAggregates / initMigration / verifyPhase 都不接，
  // 数不出来在那边要响亮失败；这一处是 countAll 全部调用点里唯一落在主读路径上
  // 的，抛出去店主首页就打不开。
  let total = null
  let countError = null
  try {
    total = await store.countAll()
  } catch (error) {
    countError = error
  }
  if (countError || total !== claimed) {
    lists.aggregatesStale = true
    console.warn('[ledger] aggregate drift shop=' + shopId + ' book=' + lists.bookId
      + ' count=' + (countError ? '数不出来：' + ((countError && countError.message) || countError) : total)
      + ' aggregate=' + claimed)
  }
  return lists
}

function clearDoc(shopId, snapshot) {
  const doc = {
    _id: snapshot.id,
    id: snapshot.id,
    shopId: shopId,
    savedAt: snapshot.savedAt,
    bookId: snapshot.bookId || '',
    products: snapshot.products || [],
    skus: snapshot.skus || [],
    customers: snapshot.customers || [],
    categories: snapshot.categories || [],
    accounts: snapshot.accounts || {},
    aggregate: snapshot.aggregate || null
  }
  // 升级前的备份流水还在数组里，原样存下来不能丢（恢复要等迁移动作把它转过来）
  if (snapshot.records && snapshot.records.length) {
    doc.records = snapshot.records
  }
  return doc
}

function adoptLegacyBackup(ledger, nextId, now) {
  if (!ledger) return { ledger: ledger, snapshot: null }
  if (!apply.listsHaveData(ledger.clearedBackup)) {
    if (!ledger.clearedBackup) return { ledger: ledger, snapshot: null }
    const stripped = Object.assign({}, ledger)
    stripped.clearedBackup = null
    return { ledger: stripped, snapshot: null }
  }
  if ((ledger.clearSnapshots || []).length) {
    const stripped = Object.assign({}, ledger)
    stripped.clearedBackup = null
    return { ledger: stripped, snapshot: null }
  }
  const snapshot = apply.snapshotLists(
    ledger.clearedBackup,
    (ledger.clearedBackup && ledger.clearedBackup.savedAt) || now
  )
  snapshot.id = nextId()
  const next = Object.assign({}, ledger)
  next.clearSnapshots = (ledger.clearSnapshots || []).concat([{
    id: snapshot.id,
    savedAt: snapshot.savedAt,
    // clearedBackup 是升级前的老格式，流水在 records 数组里，按行数报；
    // mode:'snapshots' 转换时会回填成归并条数（见 convertSnapshots）
    recordCount: apply.snapshotRecordCount(ledger.clearedBackup)
  }])
  next.clearedBackup = null
  return { ledger: next, snapshot: snapshot }
}

function publicMember(member) {
  return {
    id: member._id || member.id,
    shopId: member.shopId,
    openid: member.openid,
    role: member.role,
    displayName: String(member.displayName || '').trim(),
    createdAt: member.createdAt || 0
  }
}

function normalizeDisplayName(value) {
  const name = String(value == null ? '' : value).trim()
  if (name.length > 32) {
    throw new Error('称呼最多 32 个字')
  }
  return name
}

function normalizeOperatorName(value) {
  return String(value == null ? '' : value).trim().slice(0, 32)
}

function operatorSnapshot(members, shopId, actorOpenid, payload, opts) {
  opts = opts || {}
  const name = normalizeOperatorName(payload && payload.operatorName)
  const requested = String((payload && payload.operatorOpenid) || '').trim()
  const selected = requested ? findMember(members, shopId, requested) : null
  if (selected) {
    return {
      operatorOpenid: selected.openid,
      operatorName: name || String(selected.displayName || '').trim()
    }
  }
  if (requested) {
    return {
      operatorOpenid: requested,
      operatorName: name
    }
  }
  if (name) {
    return {
      operatorOpenid: '',
      operatorName: name
    }
  }
  if (opts.defaultToActor) {
    const actor = findMember(members, shopId, actorOpenid)
    return {
      operatorOpenid: actorOpenid,
      operatorName: actor ? String(actor.displayName || '').trim() : ''
    }
  }
  return {
    operatorOpenid: '',
    operatorName: ''
  }
}

function findMember(members, shopId, openid) {
  return (members || []).find(function (item) {
    return item.shopId === shopId && item.openid === openid
  }) || null
}

function requireMember(members, shopId, openid) {
  const member = findMember(members, shopId, openid)
  if (!member) {
    throw new Error(NOT_MEMBER)
  }
  return member
}

function requireOwner(members, shopId, openid) {
  const member = requireMember(members, shopId, openid)
  if (member.role !== 'owner') {
    throw new Error('只有店主能改成员')
  }
  return member
}

// 运维动作（账本升级那三个）的门。**不是 owner-gated**：
//
// 这套系统按会员费卖给多家店，平台运营方要给每一家跑迁移，而运营方通常不是任何一家店的
// 成员；反过来，店主能跑 dropLegacy / rollback / recomputeAggregates 才是真正的风险——
// dropLegacy 跑完就没有 O(1) 回滚了，rollback 会把迁移后记的账从读路径抹掉，而后果由平台方兜。
// 所以判据换成「是不是平台运营方」，对运营方放行、对所有租户关死。
//
// 名单在集合 platform_admins，_id 就是 openid，所以这里是一次 doc().get()，不用索引。
// **fail-closed**：db.getPlatformAdmin 把「文档不存在」和「读失败」都返回 null，两种都拒绝。
// what 只影响错误文案：这道门现在不只管账本升级，还管删店后的流水清理，
// 报「账本升级只能由平台运营方执行」会指错地方。不传就是原来那句，老调用点不动。
async function requirePlatformAdmin(db, openid, what) {
  const admin = db.getPlatformAdmin ? await db.getPlatformAdmin(openid) : null
  if (!admin) {
    throw new Error((what || '账本升级') + '只能由平台运营方执行')
  }
  return admin
}

function memberDocId(shopId, openid) {
  return String(shopId) + '_' + String(openid)
}

// dayStart 由客户端传（跨午夜时客户端自己知道要重取），服务端只做健全性检查，
// **不回退到服务端时区现算** —— 那正是「悄悄给一个错数」。非法（非数字 / NaN /
// <=0 / 远超 now）一律拒绝，调用方把 today 显示成 —— 而不是 0（0 是会被当真
// 的错数）。「远超」的宽限量选一天：够盖过时区差和一点点时钟误差，不是精确刻度。
const DAY_START_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000
// 下界同样必要，而且比上界更要紧：设备时钟停在 1970 时 dayStart 会是个很小的
// 正数，一路翻到没有更多流水才收工，于是**整本账被当成「今天」返回，还标着
// todayComplete: true**。一个标着「完整」的错数比 null 更危险 —— null 会让
// 首页显示「—」，而这个会让店主把三年的销售额当成今天的。
// 宽限量取两天：够盖过时区差和跨午夜的请求，不是精确刻度。
const DAY_START_PAST_SLACK_MS = 2 * 24 * 60 * 60 * 1000
function isValidDayStart(value, now) {
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  if (n <= 0) return false
  if (n < now - DAY_START_PAST_SLACK_MS) return false
  if (n > now + DAY_START_FUTURE_SLACK_MS) return false
  return true
}

// getSlip 和 getRecord 共用同一条「按 id 找一条流水」的口径：迁移窗口内从内存
// 里的老数组 find，迁完之后走 store.byId。两处各写一遍就会有一天口径分叉，
// 所以只准从这里过。
async function loadRecordById(ledger, store, id) {
  const wantedId = String(id || '')
  if (apply.recordsPending(ledger)) {
    const legacy = apply.legacyRecordsOf(ledger)
    const record = legacy.find(function (item) { return item.id === wantedId }) || null
    return { record: record, legacy: legacy }
  }
  const record = await store.byId(wantedId)
  return { record: record, legacy: null }
}

// 流水搬走之后不能再看 ledger.records.length，改看聚合里的条数。
// 仍然带上 records.length，是为了让迁移前的老文档也算「有数据」。
//
// 2b-3 起新代码不再写这个字段，这一条只对**升级前留下的老文档**成立，不是漏删的。
// 它能真正起作用的窗口很窄（唯一调用点 migrateLocalShard 排在 assertRecordsReady
// 后面，未迁移的店根本走不到这里；走到这里还只靠这一条为真的，只有「刚迁完、
// 老数组还没被第一笔账删掉、而且四张表和 aggregate 全空」那一种账本）。
// **但别顺手删它**：它守的是「云上已有账本，不能再上传本机数据」，删掉一个判据
// 就是把这道门放松一分，而放行的后果是拿本机账本盖掉云上的账。
function ledgerHasData(ledger) {
  if (!ledger) return false
  return !!(
    (ledger.products && ledger.products.length)
    || (ledger.skus && ledger.skus.length)
    || (ledger.customers && ledger.customers.length)
    || (ledger.categories && ledger.categories.length)
    || (ledger.aggregate && ledger.aggregate.count)
    || (ledger.records && ledger.records.length)
  )
}

// 分片上传时退货单必须和它的被退销售单落在同一片里。
//
// 判据是「**本片里找得到 saleOrderId 指向的那张销售单**」，不是「saleOrderId 非空」。
// 非空只拦得住代 A：legacyLine() 对老退货行写死 saleOrderId = ''，只有
// backfillReturnedQty 在**同一批**里找到被退销售单才补得上，切开就是空的。
// 而代 B / 代 C 的退货单**本来就带 saleOrderId**，切两片照样非空、照样放行。
//
// 放行的代价：repairReturnSplits 按 lines[0].saleOrderId 分组，销售单不在同一片
// 就当孤儿跳过，份额一分都不重算。实测代 B 单（销售 100 实收 40、退货 30，
// 退货单头既无 paidAmount 也无 payType）——
//   同片上传：退货 paidAmount 补成 0，欠款 30（正确）
//   切两片：  不报错，paidAmount 缺字段落库，settledAmount 读时保守回推成
//             「整笔退现金」，欠款 60
// 而且事后修不了：recomputeAggregates 按集合现状重折叠，实测 changed = false。
function assertReturnsPaired(shard) {
  const saleIds = Object.create(null)
  ;(shard || []).forEach(function (record) {
    if (record && record.type === 'out') saleIds[String(record.id || '')] = true
  })
  ;(shard || []).forEach(function (record) {
    if (!record || record.type !== 'return') return
    inventory.recordLines(record).forEach(function (line) {
      const saleId = String((line && line.saleOrderId) || '')
      if (!saleId || !saleIds[saleId]) {
        throw new Error('退货单和它的销售单必须在同一片里上传，请重新上传')
      }
    })
  })
}

// 迁移前的账本：流水还在文档数组里，谁也不该往集合里写第一条新流水。
// 这不是可选的保护 —— 少了它，新账进集合、老账留数组，两边都不是完整的账。
//
// 2b-3 起判据改成 default-deny，这道门顺带多覆盖一类：**两个章都没有、老数组
// 也丢了**（只从备份恢复了 ledgers、没恢复 ledger_records）。文案照旧对 ——
// 对那一类，「跑 migrateRecords」也确实是正确的出路：零流水的店走 stampOnly
// 只补戳，有流水的店走正常迁移。
function assertRecordsReady(ledger) {
  if (apply.recordsPending(ledger)) {
    throw new Error('本店账本还没完成流水升级，暂时不能记账')
  }
}

function isMutation(action) {
  return apply.MUTATIONS.indexOf(action) >= 0
}

// cloud://<env>.<bucket>/shops/<shopId>/products/... —— env.bucket 段不含 '/'，
// 第一个 '/' 之后就是路径。前缀必须是本店商品图目录：防止把别店的 fileID 挂到
// 本店商品上（挂上之后换图会触发服务端删别店的文件）。
function validShopImageFileId(fileId, shopId) {
  const id = String(fileId || '')
  if (id.length > 512) return false
  if (id.indexOf('cloud://') !== 0) return false
  const slash = id.indexOf('/', 'cloud://'.length)
  if (slash < 0) return false
  return id.slice(slash + 1).indexOf('shops/' + String(shopId) + '/products/') === 0
}

// 2b-1 起小程序必须带 apiVersion。老客户端（已发布那一版）拿到不带 records
// 的回传会把本地流水缓存清成空数组，下一张送货单就会印一个 0.00 的前欠。
const API_VERSION = 2
const VERSIONED_READS = ['getLedger', 'getSlip', 'migrateLocal', 'listRecords', 'getRecord',
  'getRecordSummary']
// 版本门的第二条理由，和上面那条（会不会回传账本）**不是一回事**：deleteShop 是
// 不可逆动作（shops / members / ledgers / ledger_clears 全删，ledger_records 里
// 该店的流水也在提交之后按 shopId 清掉，见下面 deleteShop 分支），冻结窗口里店主
// 到处撞「请更新小程序到最新版本」、最容易乱点的时候，删店按钮就在同一个店铺页上。
// 可逆的读写撞门还能重试，不可逆的
// 动作不许由老客户端在冻结窗口里发起。单列一个数组而不是并进 VERSIONED_READS，
// 就是为了让这两条理由各管各的名单。
const VERSIONED_DESTRUCTIVE = ['deleteShop']
// 账本升级的三个运维动作（2b-1b）。同样过版本门 —— 它们回传的是账本内部形状，
// 老客户端拿去解释只会更糟。三个都**不进 MUTATIONS**、不走 applyMutation：
// 它们改的是账本的迁移状态和聚合本身，不是一笔账。
function isOpsAction(action) {
  return migrate.OPS_ACTIONS.indexOf(action) >= 0
}
// 删店之后没清完的流水，由平台运营方接着清（2b-3）。和账本升级三动作共用同一道
// 白名单门，但**不并进 OPS_ACTIONS**：那三个是账本升级，这个不是，两份名单各自
// 说得清自己是什么。它同样是不可逆动作，却**不进 VERSIONED_DESTRUCTIVE** ——
// 那份名单管的是「不许由老客户端发起」，而这个 action 客户端一个入口都没有，
// 真正的门是 requirePlatformAdmin；版本门由下面的 isPlatformAction 一并带上。
const PLATFORM_ACTIONS = ['purgeDeletedShopRecords']
function isPlatformAction(action) {
  return isOpsAction(action) || PLATFORM_ACTIONS.indexOf(action) >= 0
}
function needsApiVersion(action) {
  return VERSIONED_READS.indexOf(action) >= 0 || VERSIONED_DESTRUCTIVE.indexOf(action) >= 0
    || isPlatformAction(action) || isMutation(action)
}

// ---------------------------------------------------------------------------
// 平台级维护开关（集合 platform_config 的 maintenance 文档）。
//
// 它**不是**账本升级的冻结开关（docs/cloud-ledger.md「不要做」里禁的那个仍然禁）。
// 两个口径不重叠：assertRecordsReady 是**按店**、**自动**、口径来自这本账自己的
// 迁移状态；维护开关是**平台级**、**手动**、不编码任何一家店的迁移状态。
// 账本升级仍然只用 assertRecordsReady，不许改成读这个开关。
// ---------------------------------------------------------------------------

// 维护期间仍然放行的只读 action。**白名单，不是黑名单**：以后新增的 action
// 默认落在「维护期不许」那一侧，写错的方向是安全的那一侧。
// 读放行是有意的：维护期店里仍然能查账、查库存、翻流水、看送货单，只是不能记。
//
// **这道门管的是云函数，管不到客户端直连云存储的那条路**：商品图是客户端
// wx.cloud.uploadFile 直传的（utils/product-image.js），维护期店员选了图仍然传得上去，
// 只是紧接着的 saveProduct 会被这里拦掉，于是存储里留一个孤儿文件。
// 不产生错账（账本的写被拦死了），和仓里已经接受的那类孤儿文件同一档，不必修，
// 但别以为这道门覆盖了「所有写」——它覆盖的是**所有会改账的写**。
const MAINTENANCE_READS = [
  'whoami', 'listShops', 'listMembers', 'getLedger', 'getSlip', 'getRecord', 'listRecords',
  'getRecordSummary'
]

// 维护期间照常放行的运维 action：它们**就是**维护窗口里要做的事，
// 而且已经由 platform_admins 白名单（fail-closed）守着。
// **setMaintenance 必须在这一侧**——否则开关一旦打开就再也关不掉，
// 而「维护窗口里最需要的就是能随时关掉」。
const MAINTENANCE_ACTIONS = ['getMaintenance', 'setMaintenance']

// 放行的第三类走 isPlatformAction 而**不是** isOpsAction：后者只有账本升级那三个，
// 会把 purgeDeletedShopRecords（删店之后接着清流水，2b-3）挡在维护窗口外面 ——
// 而那恰恰是维护窗口里会做的事，且它同样只有平台运营方调得动。判据跟着
// isPlatformAction 走，以后再加平台运维 action 时这里自动跟上，不用记得回来改。
function allowedDuringMaintenance(action) {
  return MAINTENANCE_READS.indexOf(action) >= 0
    || MAINTENANCE_ACTIONS.indexOf(action) >= 0
    || isPlatformAction(action)
}

const MAINTENANCE_DEFAULT_MESSAGE = '系统正在维护，暂时不能记账。维护结束后会自动恢复，请稍后再试。'

function maintenanceOn(doc) {
  return !!(doc && doc.on === true)
}

// 回传给客户端的形状。只给客户端需要的两个字段，不把 updatedBy 这类内部信息发出去。
function publicMaintenance(doc) {
  return {
    on: true,
    message: String((doc && doc.message) || '') || MAINTENANCE_DEFAULT_MESSAGE
  }
}

// 读一次开关。**任何失败都折成 null（= 没在维护）**——fail-open，理由见
// index.js 的 getMaintenance 注释和 docs/cloud-ledger.md 的「维护模式」。
// 这里连「拦不拦写」也是 fail-open，而且这是**单独判断过**的，不是顺手跟着弹窗走的：
//   · 读失败和「维护是否真的开着」互相独立，读失败在非维护期发生的次数远多于维护期；
//   · fail-closed 的后果是所有店一起做不了生意，从店员视角和真维护无法区分；
//   · 维护窗口里真正保护数据完整性的不是这道门——ledgers/{shopId} 的事务是全店写的
//     唯一串行化点，搬家期间的硬围栏是 assertRecordsReady。这道门是**减少无谓写入**的闸，
//     把它当最后一道防线来设计，会同时得到一条不可靠的防线和一个高频的误伤。
// 残余风险如实记着：维护开着 + 这一次读恰好失败 + 恰好有人提交 = 一笔写会落进去。
// 三件事同时发生，后果由上面两道真围栏兜。
//
// **不缓存**：每次 dispatch 现读。缓存会让「关掉维护」延迟一个 TTL，而随时能关掉
// 是这个功能最重要的性质。本仓的量下这次读可以忽略；真到了要省它的量级，
// 旋钮是加 TTL 缓存并接受关闭延迟。
async function readMaintenance(db) {
  if (!db || !db.getMaintenance) return null
  try {
    const doc = await db.getMaintenance()
    return maintenanceOn(doc) ? doc : null
  } catch (error) {
    return null
  }
}

function withMaintenance(error, doc) {
  if (error && doc) error.maintenance = publicMaintenance(doc)
  return error
}

// 事务失败分两类，**给店员的话必须分开说，因为该做的事正相反**：
//
//   ① 真冲突（write conflict）：两个人同时改同一批货，后到的那个被回滚。
//      **重试会成功**，文案要劝重试。
//   ② 单事务写入量超限：整体重算会连带重写全部退货单，写放大 =
//      ledgers 1 + 目标 1 + N（见 ledger-records.js 的 SALE_RETURNS_MAX ②）。
//      **重试永远不会成功**——2026-08-24 演示店实测，证据和二分结果记在
//      index.js 那段注释里。旧文案「库存刚被别人改过，请再提交」对这一类是
//      **错的建议**：劝人重试一件永远不会成功的事，而每次重试都是一次几十条的写放大。
//
// **判据要两个入参，不能只看错误文本。** index.js 那段注释留了一个未决问题：
// 「得先判断是不是所有 TransactionNotExist 都不该重试（30 秒那句暗示也可能是一次
// 真超时）」。这里不去回答「是不是所有」，而是**当场量**：那几次实测在 11–16 秒
// 就炸了，离错误文本自己说的 30 秒差得远，所以它们不是超时；真跑满 30 秒的那种
// 长什么样还没见过，**就按可重试处理**（退回今天的行为，不比今天更糟）。
// 这样这条分支不坐在任何一个没实测过的假设上。
//
// **顺序不能反**：TransactionNotExist 这个词里带着 "transaction"，
// 先跑通用冲突正则会把它误判成可重试。
const TX_NOT_EXIST = /TransactionNotExist|transaction\s+(does\s+)?not\s+exist/i
const TX_CONFLICT = /conflict|transaction/i
// 错误文本自称 30 秒；取 25 秒留出测量误差。**只在明显没到这个数时才判定
// 「确定性失败」**，够不着的一律退回可重试那一侧。
const TX_TIMEOUT_FLOOR_MS = 25000
const TX_TOO_BIG_MESSAGE = '这张单牵连的记录太多，一次改不完'
const TX_CONFLICT_MESSAGE = '库存刚被别人改过，请再提交'

// 返回 'too-big' / 'conflict' / ''（不是事务类失败，调用方原样抛原错误）。
// elapsedMs 传不进来（undefined）时**不判 too-big** —— 少了这个入参就等于
// 少了判据，宁可退回今天的行为。
function classifyTransactionError(msg, elapsedMs) {
  const text = String(msg || '')
  if (TX_NOT_EXIST.test(text)) {
    return (typeof elapsedMs === 'number' && elapsedMs < TX_TIMEOUT_FLOOR_MS)
      ? 'too-big' : 'conflict'
  }
  if (TX_CONFLICT.test(text)) return 'conflict'
  return ''
}

async function membersOfShop(db, tx, shopId) {
  if (tx && tx.listMembersByShop) {
    return tx.listMembersByShop(shopId)
  }
  return db.listMembersByShop(shopId)
}

// 删店之后没清完的流水，由平台运营方带同一个 shopId 接着清（2b-3）。
// 幂等、可反复调：判据只有 shopId 一个，回包 remaining 为 true 就再调一次。
// 这次改动之前删掉的店留下的存量孤儿也走这里补清，前提是你还知道那个 shopId ——
// **找不回 shopId 的老孤儿本次不处理**：那要全表扫 ledger_records 找「shops 里
// 已经没有的 shopId」，是另一件事。
//
// **两道前置检查判的是「这家店真的没了」，不是「调用者有没有权限」**（权限是上面
// 那道白名单门的事）。这个 action 会把一个 shopId 名下的流水全删光，误加在一家活店
// 上就是一次不可恢复的抹账：聚合还在、流水没了，recomputeAggregates 也修不回来
//（它按集合现状重折叠）。shops 和 ledgers 两个都查，不是二选一 —— 半删状态
//（店没了账本还在，或反过来）同样要拒绝，那说明上一次删店没走完，先弄清楚再说。
//
// **两道门的强度不一样，别把第二道当保险**：
//   · listShopsByIds 是真 fail-closed —— index.js 那份没有 catch，读失败会抛出去，
//     这次调用直接失败。**护住活店的是它**，也只有它。
//   · getLedger 是 fail-open —— index.js 和 MemoryDb 的实现都把「文档不存在」和
//     「读失败」一起折成 null（受限于 wxcloud 的 doc().get() 对缺失文档抛错，
//     两者本来就分不开），所以 ledgers 的一次瞬时读失败会让这道门从「拒绝」
//     降级成「放行」。它挡的是半删这种基本只能靠手工改库造出来的状态，
//     用 fail-open 换主读路径不受影响是划算的；真要它 fail-closed，得先把适配层
//     换成 where({ _id }) 那种分得清空结果和读失败的查法，那是另一件事。
async function purgeDeletedShopRecords(db, shopId, payload) {
  payload = payload || {}
  const shops = await db.listShopsByIds([shopId])
  if (shops && shops.length) {
    throw new Error('店铺 ' + shopId + ' 还在，不能清它的流水：这个动作只清已经删掉的店')
  }
  const ledger = await db.getLedger(shopId)
  if (ledger) {
    throw new Error('店铺 ' + shopId + ' 的账本还在，不能清它的流水：先确认这家店确实已经删干净了')
  }
  const got = await records.purgeByShop(db.recordsCtx(), shopId, {
    maxRecords: payload.maxRecords,
    deadline: Date.now() + records.PURGE_BUDGET_MS
  })
  return Object.assign({ shopId: String(shopId) }, got)
}

async function dispatchAction(input) {
  const db = input.db
  const openid = String((input && input.openid) || '')
  const action = String((input && input.action) || '')
  const payload = (input && input.payload) || {}
  const now = input.now || Date.now()
  const nextId = input.makeId || function () {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  if (!openid) {
    throw new Error('无法获取用户身份')
  }
  if (!action) {
    throw new Error('缺少操作')
  }

  // 老客户端（已发布那一版）拿到不带 records 的回传，会把本地流水缓存清成空数组，
  // 下一张送货单就会印一个 0.00 的前欠。**静默印错钱不可接受，所以直接挡住。**
  // 放行的是不会回传账本的 action：whoami / listShops / createShop / listMembers /
  // addMember / updateMember / removeMember —— 否则老客户端连店都列不出来、加不了人，
  // 报错会误导成「不是该店成员」。deleteShop 虽然也不回传账本，但它是不可逆动作，
  // 单独列在 VERSIONED_DESTRUCTIVE 里照样挡（理由见那里的注释）。
  const apiVersion = Number((input && input.apiVersion) || 0)
  if (needsApiVersion(action) && apiVersion < API_VERSION) {
    throw new Error('请更新小程序到最新版本')
  }

  if (action === 'whoami') {
    return { openid: openid }
  }

  if (action === 'listShops') {
    const members = await db.listMembersByOpenid(openid)
    const ids = members.map(function (item) {
      return item.shopId
    })
    const shops = await db.listShopsByIds(ids)
    const roleByShop = {}
    members.forEach(function (item) {
      roleByShop[item.shopId] = item.role
    })
    return {
      shops: shops.map(function (shop) {
        const id = shop._id || shop.id
        return publicShop(shop, roleByShop[id])
      })
    }
  }

  if (action === 'createShop') {
    const name = String(payload.name || '').trim()
    if (!name) {
      throw new Error('请填写店铺名称')
    }
    const shopId = nextId()
    const memberId = memberDocId(shopId, openid)
    return db.runTransaction(async function (tx) {
      const shop = {
        _id: shopId,
        name: name,
        ownerOpenid: openid,
        createdAt: now
      }
      const member = {
        _id: memberId,
        shopId: shopId,
        openid: openid,
        role: 'owner',
        createdAt: now
      }
      const ledger = Object.assign({ _id: shopId }, apply.emptyLedger())
      ledger.bookId = shopId
      ledger.recordsMigratedAt = now
      await tx.setShop(shop)
      await tx.setMember(member)
      await tx.putLedger(shopId, ledger)
      return { shop: publicShop(shop, 'owner') }
    })
  }

  // 平台级维护开关的读写。**平台运营方白名单**（和账本升级三个动作同一道门）。
  // 客户端一个入口都没有：从开发者工具 Console 调
  //   wx.cloud.callFunction({ name:'ledger', data:{ action:'setMaintenance',
  //     payload:{ on:true, message:'今晚 22:00-23:00 升级' } } })
  // **不放进 needsApiVersion**：版本门的两条理由（会不会回传账本、是不是不可逆动作）
  // 这两个 action 都不占，而且更重要——维护窗口里最需要的就是能随时关掉，
  // 不能把关闭开关的路挡在一道以后可能收紧的版本门后面。
  if (MAINTENANCE_ACTIONS.indexOf(action) >= 0) {
    await requirePlatformAdmin(db, openid)
    if (action === 'getMaintenance') {
      // 诊断路径**不吞异常**：运维方要能分辨「开关是关的」和「开关读不出来」。
      // 拦截路径（readMaintenance）为了 fail-open 把两者折成同一个「没在维护」。
      const doc = db.getMaintenanceRaw ? await db.getMaintenanceRaw() : await db.getMaintenance()
      return {
        maintenanceConfig: doc || null,
        on: maintenanceOn(doc)
      }
    }
    const on = payload.on === true
    const next = {
      _id: 'maintenance',
      on: on,
      message: String(payload.message || ''),
      updatedAt: now,
      updatedBy: openid
    }
    await db.setMaintenance(next)
    return { maintenanceConfig: next, on: on }
  }

  const shopId = String((input && input.shopId) || payload.shopId || '')
  if (!shopId) {
    throw new Error('请选择店铺')
  }

  if (action === 'listMembers') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    return {
      members: members.map(publicMember),
      role: findMember(members, shopId, openid).role
    }
  }

  if (action === 'addMember') {
    const target = String(payload.openid || '').trim()
    if (!target) {
      throw new Error('请填写店员 openid')
    }
    const role = payload.role === 'owner' ? 'owner' : 'staff'
    return db.runTransaction(async function (tx) {
      const members = await membersOfShop(db, tx, shopId)
      requireOwner(members, shopId, openid)
      if (findMember(members, shopId, target)) {
        throw new Error('已经是本店成员')
      }
      const member = {
        _id: memberDocId(shopId, target),
        shopId: shopId,
        openid: target,
        role: role,
        createdAt: now
      }
      const displayName = normalizeDisplayName(payload.displayName)
      if (displayName) {
        member.displayName = displayName
      }
      await tx.setMember(member)
      return { member: publicMember(member) }
    })
  }

  if (action === 'updateMember') {
    const target = String(payload.openid || '').trim() || openid
    const displayName = normalizeDisplayName(payload.displayName)
    return db.runTransaction(async function (tx) {
      const members = await membersOfShop(db, tx, shopId)
      const actor = requireMember(members, shopId, openid)
      const existing = findMember(members, shopId, target)
      if (!existing) {
        throw new Error('不是该店成员')
      }
      if (actor.role !== 'owner' && target !== openid) {
        throw new Error('只能改自己的称呼')
      }
      const member = Object.assign({}, existing, { displayName: displayName })
      await tx.setMember(member)
      return { member: publicMember(member) }
    })
  }

  if (action === 'removeMember') {
    const target = String(payload.openid || '').trim()
    if (!target) {
      throw new Error('请选择要移除的成员')
    }
    return db.runTransaction(async function (tx) {
      const members = await membersOfShop(db, tx, shopId)
      requireOwner(members, shopId, openid)
      const existing = findMember(members, shopId, target)
      if (!existing) {
        throw new Error('不是该店成员')
      }
      if (existing.role === 'owner') {
        const owners = members.filter(function (item) {
          return item.role === 'owner'
        })
        if (owners.length <= 1) {
          throw new Error('不能移除最后一位店主')
        }
      }
      await tx.removeMember(existing._id || existing.id || memberDocId(shopId, target))
      return { removed: true, openid: target }
    })
  }

  if (action === 'deleteShop') {
    // 墙钟从进这个分支起算，**不用上面那个 now**：now 是调用方传进来的记账时刻
    //（测试里是固定值），这里要的是「这次函数调用还剩多少时间」。从事务之前起算
    // 而不是从事务之后，是为了让「事务 + 清理」的总时长有上界 —— 事务慢了，
    // 留给清理的预算就自动变少，不会两段各自算各自的、加起来撞云端硬超时。
    const startedAt = Date.now()
    const result = await db.runTransaction(async function (tx) {
      const members = await membersOfShop(db, tx, shopId)
      const member = requireMember(members, shopId, openid)
      if (member.role !== 'owner') {
        throw new Error('只有店主能删除店铺')
      }
      const shop = tx.getShop ? await tx.getShop(shopId) : null
      if (!shop) {
        throw new Error('店铺不存在')
      }
      let ledger = null
      if (tx.getLedger) {
        try {
          ledger = await tx.getLedger(shopId)
        } catch (error) {
          ledger = null
        }
      }
      const clearIds = {}
      function addClearId(id) {
        const key = String(id || '')
        if (key) clearIds[key] = true
      }
      ((ledger && ledger.clearSnapshots) || []).forEach(function (item) {
        addClearId(item && item.id)
      })
      if (tx.listClearSnapshotsByShop) {
        try {
          const clears = await tx.listClearSnapshotsByShop(shopId)
          clears.forEach(function (item) {
            addClearId(item._id || item.id)
          })
        } catch (error) {
          // 没有 shopId 索引时仍按账本里的快照 id 删
        }
      }
      const memberIds = members.map(function (item) {
        return item._id || item.id || memberDocId(shopId, item.openid)
      })
      for (let i = 0; i < memberIds.length; i++) {
        await tx.removeMember(memberIds[i])
      }
      const snapshotIds = Object.keys(clearIds)
      for (let i = 0; i < snapshotIds.length; i++) {
        if (tx.removeClearSnapshot) {
          await tx.removeClearSnapshot(snapshotIds[i])
        }
      }
      if (tx.removeLedger) {
        try {
          await tx.removeLedger(shopId)
        } catch (error) {
          if (ledger) throw error
        }
      }
      await tx.removeShop(shopId)
      return { deleted: true, shopId: shopId }
    })
    // 事务提交之后才清这家店的流水（2b-3）。三条理由写在 records.purgeByShop 上方，
    // 缺一条这段就该换个写法：塞不进事务 / 先清后删会让活店掉流水（那是错数）/
    // 提交之后的失败不许变成「删店失败」。
    //
    // 所以这里**捕获一切**：purgeByShop 自己不抛，但 db.recordsCtx() 本身也可能抛
    //（真云上是一次瞬时故障，tests/ledger-records.test.js 第 13 节那条「提交后的读
    // 失败绝不能变成记账失败」用的就是这个替身）。店已经没了，回包必须照样是
    // deleted: true —— 报错只会让店主以为没删成，再点一次还报「不是该店成员」。
    let purge = null
    try {
      purge = await records.purgeByShop(db.recordsCtx(), shopId, {
        deadline: startedAt + records.PURGE_BUDGET_MS
      })
    } catch (error) {
      purge = {
        removed: 0, remaining: true, stopped: 'error',
        error: String((error && error.message) || error || '')
      }
    }
    if (purge.remaining) {
      // 没清完是**预期内**的（大店一次调用删不完），但必须留下痕迹：店主没有任何
      // 入口能接着清，只有平台运营方能。日志里要带够接着清所需的全部信息。
      console.warn('[ledger] deleteShop 流水没清完 shop=' + shopId
        + ' removed=' + purge.removed + ' stopped=' + purge.stopped
        + (purge.error ? ' error=' + purge.error : '')
        + ' —— 由平台运营方带同一个 shopId 调 purgeDeletedShopRecords 接着清')
    }
    return Object.assign({}, result, { purge: purge })
  }

  // 平台运营方动作：账本升级三个 + 删店后的流水清理。**平台运营方白名单**，
  // 不是 owner-gated（理由见 requirePlatformAdmin 上方）。客户端一个入口都没有：
  // 从开发者工具 Console 直接 wx.cloud.callFunction 调。加个隐藏按钮就等于把
  // 「一键重写全店流水」「一键删光一家店的流水」发到线上。
  if (isPlatformAction(action)) {
    if (action === 'purgeDeletedShopRecords') {
      await requirePlatformAdmin(db, openid, '清理已删店铺的流水')
      return purgeDeletedShopRecords(db, shopId, payload)
    }
    await requirePlatformAdmin(db, openid)
    if (action === 'checkAggregates') {
      return migrate.checkAggregates(db, shopId, payload)
    }
    if (action === 'migrateRecords') {
      return migrate.migrateRecords(db, shopId, payload, now, nextId)
    }
    return migrate.recomputeAggregates(db, shopId, payload, now)
  }

  if (action === 'getLedger') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    const ledger = await db.getLedger(shopId)
    if (!ledger) {
      throw new Error('店铺账本不存在')
    }
    const dayStart = isValidDayStart(payload.dayStart, now) ? Number(payload.dayStart) : null
    const recentLimit = payload.recentLimit
    const lists = publicListsOf(shopId, ledger, { dayStart: dayStart, recentLimit: recentLimit })
    if (!lists.recordsPendingMigration) {
      await attachRecent(db, shopId, lists, dayStart, recentLimit)
    }
    return { ledger: lists }
  }

  // 送货单欠款：从「当前欠款」倒推「单据时刻的欠款」。
  // 不冻结任何字段 —— 冻结值在改 / 删更早的记录之后会制造一个不出现在任何单据上
  // 的断点，客户拿单据对账时对不上。详见 docs/cloud-ledger.md 的「送货单欠款」。
  if (action === 'getSlip') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    const raw = await db.getLedger(shopId)
    if (!raw) {
      throw new Error('店铺账本不存在')
    }
    const ledger = withBookId(raw, shopId)
    const store = records.recordStore(db.recordsCtx(), ledger.bookId, shopId)
    const loaded = await loadRecordById(ledger, store, payload.recordId)
    const record = loaded.record
    if (!record) {
      throw new Error('流水不存在')
    }
    const customerId = String(record.customerId || '')
    // 散客单没有欠款线，直接给 0（老客户端的 missing 守卫对散客短路失效，
    // 这条路径现在根本不存在：服务端显式返回 0）
    if (!customerId) {
      return { record: record, receivable: 0 }
    }
    if (loaded.legacy) {
      return {
        record: record,
        receivable: inventory.receivableAt(loaded.legacy, customerId, record.createdAt)
      }
    }
    const from = apply.makeSortKey(inventory.toNumber(record.createdAt) + 1, '')
    const suffix = await store.suffixOfCustomer(customerId, from)
    const current = inventory.accountOf((ledger.accounts || {})[customerId]).receivable
    return {
      record: record,
      receivable: inventory.round2(current - inventory.receivableDelta(suffix, customerId))
    }
  }

  // 2b-2：分页之后 store 缓存里不一定有这条流水（可能来自 customer-edit 的
  // 往来记录，或 records.js 翻到很后面的页），所以需要单独按 id 取一条。
  // 和 getSlip 共用 loadRecordById，两处口径不能各写一遍。
  if (action === 'getRecord') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    const raw = await db.getLedger(shopId)
    if (!raw) {
      throw new Error('店铺账本不存在')
    }
    const ledger = withBookId(raw, shopId)
    const store = records.recordStore(db.recordsCtx(), ledger.bookId, shopId)
    const loaded = await loadRecordById(ledger, store, payload.recordId)
    if (!loaded.record) {
      throw new Error('流水不存在')
    }
    return { record: loaded.record }
  }

  // 分页取流水的唯一入口。type 和 customerId 不能同时非默认：不是没有调用点
  // 需要，而是这会变成一条无索引查询 —— 10 条数据上飞快，10000 条上超时，
  // 宁可在边界报一条明确的错，也不要发一条会随数据量退化的查询（方案 §3.1）。
  //
  // **时间段 [from, to)（2b-4）不放松这条约束，也不被它拦住。** 时间段走的是
  // sortKey，而 sortKey 是 #1 / #2 / #3 三条索引各自的最后一维，所以
  // 「时间段」「时间段 + type」「时间段 + customerId」三种组合各自命中一条现成
  // 索引；唯一还是无索引的仍然是 type + customerId 同时非默认，加不加时间段
  // 都一样 —— 窗口窄不代表查询有索引，别拿「反正只查一个月」当放开的理由。
  if (action === 'listRecords') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    const type = String(payload.type || '')
    const customerId = String(payload.customerId || '')
    if (type && type !== 'all' && customerId) {
      throw new Error('不支持同时按类型和客户筛选')
    }
    // 时间段非法要在读账本文档**之前**就报出来：两条分支（未迁移的内存切片、
    // 已迁移的集合查询）各自也会校验，这里提前一次只为省一次 IO、并且让错误
    // 顺序稳定（不会因为账本读不到而先报「店铺账本不存在」）。
    apply.normalizeWindow(payload)
    const raw = await db.getLedger(shopId)
    if (!raw) {
      throw new Error('店铺账本不存在')
    }
    const ledger = withBookId(raw, shopId)
    const pageOptions = {
      type: type, customerId: customerId, cursor: payload.cursor, limit: payload.limit,
      from: payload.from, to: payload.to
    }
    if (apply.recordsPending(ledger)) {
      // 未迁移的店也只回一页，从账本文档里那份老数组切，走同一个 apply.pageRecords —
      // 线上只存在一种线协议形态（方案 Q1）。写路径仍被 assertRecordsReady 挡住。
      const legacy = apply.legacyRecordsOf(ledger)
      const page = apply.pageRecords(legacy, pageOptions)
      page.recordsPendingMigration = true
      return page
    }
    const store = records.recordStore(db.recordsCtx(), ledger.bookId, shopId)
    return store.page(pageOptions)
  }

  // 一个时间段的汇总（2b-4）：流水页顶上的「本月」摘要条。回
  // { totals: {salesAmount, purchaseAmount, profit, count} | null, complete, scanned }。
  //
  // **必须给时间段**（normalizeWindow 的 required）。无界汇总 = 全店累计，而那个
  // 数是 getLedger 的 totals（accounts / aggregate 的投影），零查询就能拿到的权威
  // 值；在这里扫一遍集合去重算它，既浪费又必然撞上界回「算不出来」。摘要条的
  // 「全部」那一档因此不走这个 action，直接读 totals。
  //
  // **回包里没有 receivable**（见 inventory.windowTotalsOf 那段）：欠款是存量，
  // 一段时间的折叠算出来的是「本期净增欠款」，和同屏那个真的欠款总额是两个量。
  //
  // 只读 action：进 VERSIONED_READS，也进 MAINTENANCE_READS（维护期店里照样能
  // 查账翻流水，摘要条和它下面的列表是同一件事，放行一个挡另一个没有道理）。
  if (action === 'getRecordSummary') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    apply.normalizeWindow(payload, true)
    // **不接受 type / customerId**。摘要条按设计是「这段时间的进货 / 销售 / 毛利」，
    // 不跟着下面那排类型 chip 变；悄悄忽略掉这两个参数，调用方会拿一个全类型的
    // 数当成「本月进货」用。要报错，不要给一个长得对、含义不对的数。
    // （真要分型汇总，它走索引 #3 / #2、和这里同一个上界，但目前没有调用点，
    // 每多一个入参就多一处口径要对齐。）
    if (String(payload.type || '') && String(payload.type) !== 'all') {
      throw new Error('窗口汇总不支持按类型筛选')
    }
    if (String(payload.customerId || '')) {
      throw new Error('窗口汇总不支持按客户筛选')
    }
    const raw = await db.getLedger(shopId)
    if (!raw) {
      throw new Error('店铺账本不存在')
    }
    const ledger = withBookId(raw, shopId)
    if (apply.recordsPending(ledger)) {
      // 未迁移的店：老数组已经在内存里，现筛现折，零额外 IO，也没有上界可撞。
      // 和 publicListsOf 的 recordsPending 分支同一条理由。
      const legacy = apply.filterWindow(apply.legacyRecordsOf(ledger), payload)
      return {
        totals: inventory.summarizeWindow(legacy),
        complete: true,
        scanned: legacy.length,
        recordsPendingMigration: true
      }
    }
    const store = records.recordStore(db.recordsCtx(), ledger.bookId, shopId)
    return records.windowSummary(store, payload)
  }

  if (action === 'migrateLocal') {
    return migrateLocalShard(db, shopId, openid, payload, now, nextId)
  }

  if (!isMutation(action)) {
    throw new Error('未知操作')
  }

  // 商品图只认本店目录下的 fileID。校验放在事务开始之前：越早抛越省一次事务；
  // 「哪个店」也只有 dispatch 知道，applyMutation 里判不了。空串 / 缺省放行
  // （等于清除图片，会触发旧图的作废清理）。updateProduct 透传 image 缺省时，
  // 老数据的 image 本来就是服务端写进去的合法值，不在这里重复挡。
  if (action === 'saveProduct' && payload.image != null && String(payload.image) !== ''
    && !validShopImageFileId(payload.image, shopId)) {
    throw new Error('商品图地址不合法')
  }

  // 事务边界：ledgers/{shopId} 的读 + 写仍然是全店所有写操作的唯一串行化点。
  // 所以即使「事务内 where() 是否上锁」语义不明，也不出问题 —— 任何并发写者要提交
  // 都必须先写 ledgers 文档，而它已经被本事务锁住了。
  // 单事务写入量：ledgers 1 个 + 目标记录 1 条 + （改销售单/退货时）该销售单的全部退货单。
  const outcome = await db.runTransaction(async function (tx) {
    const members = await membersOfShop(db, tx, shopId)
    requireMember(members, shopId, openid)
    let current = await tx.getLedger(shopId)
    if (!current) {
      throw new Error('店铺账本不存在')
    }
    assertRecordsReady(current)
    current = withBookId(current, shopId)
    const adopted = adoptLegacyBackup(current, nextId, now)
    if (adopted.snapshot) {
      await tx.putClearSnapshot(adopted.snapshot.id, clearDoc(shopId, adopted.snapshot))
    }
    current = adopted.ledger
    const store = records.recordStore(tx.recordsCtx(), current.bookId, shopId)
    // 两轮收敛：先按 payload 捞，再按捞到的记录捞它牵连的销售单 / 进货候选
    const loaded = await apply.prepareMutation(store, action, payload)
    let mutationPayload = payload
    if (action === 'addSale') {
      mutationPayload = Object.assign({}, payload, operatorSnapshot(members, shopId, openid, payload, {
        defaultToActor: true
      }))
    } else if (action === 'updateRecord') {
      const existing = loaded.byId[String(payload.id || '')]
      const hasOperator = Object.prototype.hasOwnProperty.call(payload, 'operatorName')
        || Object.prototype.hasOwnProperty.call(payload, 'operatorOpenid')
      if (existing && existing.type === 'out' && hasOperator) {
        mutationPayload = Object.assign({}, payload, operatorSnapshot(members, shopId, openid, payload, {
          defaultToActor: false
        }))
      }
    }
    let applied
    if (action === 'restoreCleared') {
      const latest = apply.latestClearMeta(current)
      if (!latest || latest.savedAt <= (current.lastRestoredClearAt || 0)) {
        throw new Error('没有可恢复的数据')
      }
      const snapshot = await tx.getClearSnapshot(latest.id)
      if (!snapshot) {
        throw new Error('没有可恢复的数据')
      }
      applied = apply.applyMutation(current, action, { snapshot: snapshot }, now, nextId, loaded)
    } else {
      applied = apply.applyMutation(current, action, mutationPayload, now, nextId, loaded)
      if (applied.result && applied.result.clearSnapshot) {
        const snapshot = applied.result.clearSnapshot
        await tx.putClearSnapshot(snapshot.id, clearDoc(shopId, snapshot))
        delete applied.result.clearSnapshot
      }
    }
    // loadSeed / clearAll 会换账套，写进去的必须是「改后」的那一本
    const writeStore = applied.ledger.bookId === current.bookId
      ? store
      : records.recordStore(tx.recordsCtx(), applied.ledger.bookId, shopId)
    await records.applyWrites(writeStore, applied.recordWrites)
    await tx.putLedger(shopId, applied.ledger)
    return {
      lists: applied.ledger,
      result: applied.result
    }
  })

  // 事务已经提交。**从这里到 return 之间不允许出现任何 await。**
  // 提交之后再失败一次，客户端看到的就是「记账失败」，店员会再点一次，
  // 于是同一笔账真的落两遍（见 2b-1a 审计阻塞 3）。
  // 回传要用的东西全部已经在内存里：lists 就是事务里算好的账本，
  // publicListsOf 的签名里没有 db，所以这条路上根本写不出「提交之后再读库」。
  //
  // **唯一的 sanctioned 例外：下面这段商品图清理（deleteFiles）。** 它配当例外，
  // 是因为三条同时成立，缺一条都不行：
  //   1. 清理结果不进回传数据 —— 回传的 result 还是事务里算好的那份，
  //      客户端不可能因为这段而看到「记账失败」，也就不会双记；
  //   2. index.js 注入的 storage.deleteFiles 把一切错误吞干净（只 console.warn），
  //      这里的 await 实际上永不抛；
  //   3. 最坏失败模式是留下一个孤儿文件（多占一点存储），不是错账。
  // 它也不能挪到事务之前删：事务失败会回滚，商品上仍挂着这张图，先删就把
  // 「还活着的商品的图」删成死链；同理不能塞进事务里 —— 云存储删除不是事务
  // 参与者，事务回滚也删不回来。挂在提交之后是唯一既不双记、又不删活图的位置。
  // （deleteShop 的商品图清理**故意不做**：和 ledger_records 的 2b-3 孤儿清理
  // 是同一类「删店遗留」，留到以后一起做，避免 scope 膨胀。）
  const obsolete = ((outcome.result && outcome.result.obsoleteImages) || [])
    .filter(function (id) { return validShopImageFileId(id, shopId) })
  if (obsolete.length && input.storage && input.storage.deleteFiles) {
    await input.storage.deleteFiles(obsolete)
  }
  //
  // 2b-2b 起**不再回传 recordDelta**：分页之后客户端每个列表都是服务端取的、
  // 每个金额都来自 accounts / totals 投影，没有任何一处消费 delta。留着一个
  // 没人用的算钱字段就是给下一个人留坑（方案 C-2，用户已明确点头）。
  // result.obsoleteImages 会随 result 原样回传客户端 —— 无害（客户端忽略），
  // 也不剔除，别为它再花一次拷贝。
  return {
    ledger: publicListsOf(shopId, outcome.lists),
    result: outcome.result
  }
}

// 维护门 + 回包携带的唯一入口。**写拦截在这里，不在客户端**：弹窗只是 UX，
// 真正的门在服务端——即使有人用老客户端、或者弹窗没弹出来，写照样进不去。
//
// 回包携带的机制（需求 2「已经在用小程序的用户也要弹」）：维护开着时，
// **每一个回包**（成功的和失败的）都带上 maintenance 字段。用户只要还在操作
// （翻页、开单、查账），下一次请求就把维护状态带回来，客户端立刻弹窗，零额外往返。
// **不要改成轮询。**
//
// 诚实边界：一个用户盯着静态页面完全不动、一个请求都不发，收不到弹窗。
// 覆盖不是 100%——但这不构成风险，他在不发请求的情况下也写不进任何东西。
// utils/maintenance.js 那头还有一句 App.onShow 的补充检查，同一条边界写在那里。
//
// 维护**关着**时（含开关读失败）：这个函数除了多一次小集合的 doc().get()，
// 对回包**一个字节都不改**——不加 maintenance 键。所以「维护关着时行为与今天完全
// 一致」这句是字面成立的，测试也按字面钉（hasOwnProperty('maintenance') === false）。
async function dispatch(input) {
  const db = input && input.db
  const action = String((input && input.action) || '')
  const doc = await readMaintenance(db)
  if (!doc) return dispatchAction(input)
  // action 为空时不由维护门管：让 dispatchAction 去报它自己的「缺少操作」，
  // 不要把一个格式错误的请求说成是维护中。
  if (action && !allowedDuringMaintenance(action)) {
    throw withMaintenance(new Error(publicMaintenance(doc).message), doc)
  }
  try {
    const result = await dispatchAction(input)
    // **两个维护 action 自己的回包不挂标志。** doc 是进 dispatch 那一刻读到的，
    // 而 setMaintenance 很可能刚把它改掉——挂上去就是一份过期状态：运营方
    // 调 setMaintenance({on:false}) 关掉维护，回包却还写着 maintenance.on = true。
    // 今天没人被坑到（运营方从 devtools Console 调，不走 utils/store.js 的
    // callCloud，note() 不会被触发），但只要以后有人把它接进客户端，
    // 关掉开关的那一刻自己就会被弹一个「后台维护中」，而且那份过期状态还会
    // 占住去重用的 shownKey。getMaintenance 一并跳过：它的回包里已经有权威状态。
    if (MAINTENANCE_ACTIONS.indexOf(action) >= 0) return result
    return Object.assign({}, result, { maintenance: publicMaintenance(doc) })
  } catch (error) {
    throw withMaintenance(error, doc)
  }
}

// 本机账本上传：服务端的分片接收端。
//
// 客户端不带 token 就是老的一次性上传（2b-1 的小程序仍然这么调）；带 token 就是
// 分片上传，服务端把已收的片攒在 ledgers.importing 里，**收到最后一片才切换**。
// 切换前 bookId 仍指向空账套，所以中途失败对店里完全不可见，重来只要换个 token
// （半成品账套不可达，O(1) 回滚）。
//
// R-4：客户端必须**全部片成功之后**才 markMigrated()。顺序反了会在中途失败时
// 删掉本机唯一的原始数据。见 utils/store.js 的 migrateLocal。
//
// **这条路和 migrateRecords 走的是同一个 apply.legacyRecordsOf**（归并 + 退货
// 份额整体重算），也就是说它**会改钱**：同一份数据落库时的欠款可以和本机看到的
// 不一样。所以它必须过和搬家路同一套 migrate.recordFailures（V4/V5/V6/V8/
// V9/V10/V12，见那里的注释）。从前只有 assertRecordsReady + ledgerHasData +
// assertReturnsPaired 三道门，于是同一份数据 migrateRecords 报 failed（V6 负账户）、
// migrateLocal 直接放行。落库之后 assertAccountsValid 是**全账户扫描**，实测一个
// 客户欠 −100 的后果：
//   · 全店**任何客户**的退货 / 改单 / 删销售单一律报「改完后收款会超过赊账，
//     请先改收款记录」——连和它毫无关系的另一个客户都退不了货、删不了单
//   · 负账户那个客户还收不了款（applyPayment 自己那条「收款不能超过当前欠款」）
//   · 能把它拨回来的只剩「删掉那张退货单」或「删掉那笔收款单」（删完欠款回到
//     非负所以放行）——等于让店主拿删真账换解冻
// 而客户端上传成功即 markMigrated()、本机原件已删，退不回去。
//
// 这里没有 V1 / V2 / V3 / V7：那四项比的是「集合里的文档 vs 内存里的 merged」，
// 上传是往一个空账套里写，没有集合可比。
//
// 逐片跑的那几项和 assertReturnsPaired 要求的是同一件事——一张销售单和它的
// 全部退货单必须同片——所以它们不额外收紧合法切法（实测：一份 in,out,return,
// pay,out 的干净本机账本，四种两刀切法里合法的三种全部通过、落库欠款都等于整本
// 折叠的 3，只有把销售单和它的退货切开的那一种被拒）。只是**哪一片先报错**取决于
// 切法：销售单那一片先撞 V4（销售行记着 returnedQty，本片里却一条退货都没有），
// 退货单那一片撞 assertReturnsPaired。
//
// V6 单独摆在最后一片上判（deferNegativeAccounts）：一片就是一段时间切片，
// 「A 片赊销、B 片收款」是合法切法，单片折出来的负欠款是切片假象。累计的
// state.accounts 才是这本账的全量，拿 migrate.negativeAccountsOf 扫它。
// 不带 token 的一次性上传只有一片、isFinal 恒为真，所以那道门对客户端就是全量的；
// 分片时同理——中间各片 deferNegativeAccounts，最后一片对累计 state.accounts 判。
// （客户端什么时候不带 token：整本只需要一片，或账里有孤儿退货，见 utils/store.js
// 的 migrateLocal 和 utils/ledger-shard.js 的 planShards。）
async function migrateLocalShard(db, shopId, openid, payload, now, nextId) {
  const token = String(payload.token || '')
  const incoming = payload.ledger || payload
  const rawRecords = payload.records || incoming.records || []
  const seq = Number(payload.seq || 0)
  const isFinal = token ? !!payload.final : true

  const outcome = await db.runTransaction(async function (tx) {
    const members = await membersOfShop(db, tx, shopId)
    requireMember(members, shopId, openid)
    const current = await tx.getLedger(shopId)
    if (!current) {
      throw new Error('店铺账本不存在')
    }
    assertRecordsReady(current)
    const importing = current.importing || null
    const resuming = !!(token && importing && importing.token === token)

    if (!resuming) {
      if (ledgerHasData(current)) {
        throw new Error('云上已有账本，不能再上传本机数据')
      }
      if (seq !== 0) {
        throw new Error('导入批次对不上，请重新上传')
      }
    } else if (seq < importing.nextSeq) {
      // 这一片已经收过了。记录 _id 确定、set 幂等，但聚合不能重复加，所以直接跳过
      return { skipped: true, importing: importing, lists: null }
    } else if (seq > importing.nextSeq) {
      throw new Error('导入的分片顺序不对，请重新上传')
    }

    const bookId = resuming ? String(importing.bookId) : nextId()
    // 归并成「一单一条」：原样复用 2a 的 migrateRecordShape，一行不要改。
    // 分片时客户端不能把同一张销售单的行拆到两片里，否则这一步会把它拆成两单。
    const shard = apply.legacyRecordsOf({ records: rawRecords })
    // 一次性上传（不带 token）只有一片，找不到被退销售单只可能是「它本来就不在
    // 这份本机账本里」，不是分片切坏的，拦了反而让这家店永远传不上来。
    if (token) assertReturnsPaired(shard)
    // 这一批流水本身有没有病。**文案必须说清「本机数据没有删」**：utils/store.js
    // 的 migrateLocal() 只在云函数成功返回之后才 markMigrated()，抛错时本机原件
    // 确实还在，店主不该以为数据没了。
    const failures = migrate.recordFailures(rawRecords, shard, { deferNegativeAccounts: true })
    if (failures.length) {
      throw new Error('本机账本有问题，没有上传：' + migrate.describeProblems(failures)
        + '。本机数据没有删，修好再传。')
    }
    let state = {
      accounts: (resuming && importing.accounts) || {},
      aggregate: (resuming && importing.aggregate) || inventory.emptyTerms()
    }
    const store = records.recordStore(tx.recordsCtx(), bookId, shopId)
    for (let i = 0; i < shard.length; i++) {
      state = inventory.applyTermsDelta(state, null, shard[i])
      await store.set(shard[i])
    }
    const lists = resuming ? importing.lists : {
      products: incoming.products || [],
      skus: incoming.skus || [],
      customers: incoming.customers || [],
      categories: incoming.categories || []
    }

    if (!isFinal) {
      const staged = Object.assign({}, current, {
        importing: {
          token: token,
          bookId: bookId,
          nextSeq: seq + 1,
          count: ((resuming && importing.count) || 0) + shard.length,
          startedAt: (resuming && importing.startedAt) || now,
          lists: lists,
          accounts: state.accounts,
          aggregate: state.aggregate
        }
      })
      await tx.putLedger(shopId, staged)
      return { staged: true, importing: staged.importing, lists: null }
    }

    // V6 在**累计** accounts 上判：负账户可能是跨片才显现的（A 片赊销、B 片收款
    // 各自都不负，合起来才负），而单片折出来的负欠款又只是切片假象。判据和搬家路
    // 同一个 negativeAccountsOf。一次性上传走的也是这里（isFinal 恒为真）。
    const negative = migrate.negativeAccountsOf(state.accounts).map(function (item) {
      return Object.assign({ check: 'V6' }, item)
    })
    if (negative.length) {
      throw new Error('本机账本有问题，没有上传：' + migrate.describeProblems(negative)
        + '。本机数据没有删，修好再传。')
    }

    const next = apply.listsOf({
      products: lists.products,
      skus: lists.skus,
      customers: lists.customers,
      categories: lists.categories,
      bookId: bookId,
      accounts: state.accounts,
      aggregate: state.aggregate,
      revision: 0
    })
    next.revision = 1
    next.migratedFromLocal = true
    next.recordsMigratedAt = now
    // 出生就是集合形态的章。这里是 putLedger 的整文档 set()，而 next 来自
    // apply.listsOf()（不产出 records 键），所以这一次写就把老数组删掉了 ——
    // 2b-3 之前这里是 next.records = []，效果相同、只是留了个空数组。
    //
    // 顺手盖上出生章：这份文档是新代码从零拼出来的，流水从第一条起就在集合里，
    // 说得出这句话就该写下来。少了它这份文档只剩 recordsMigratedAt 一个证据，
    // 那个字段一旦丢掉（只从局部备份恢复、控制台手改），default-deny 会把一本
    // 流水明明在集合里的账冻住。
    //
    // **这不是类不变式，别当它是**：migrateRecords 的 stampOnly / verifyPhase 写出去
    // 的文档就只有 recordsMigratedAt 一个章（那些是老文档，出生在集合之前，盖出生章
    // 是撒谎）。所以「没有 recordsSchema」推不出「是老文档」，判据那边也没这么用。
    next.recordsSchema = apply.RECORDS_SCHEMA
    next.importing = null
    next.clearSnapshots = current.clearSnapshots || []
    next.lastRestoredClearAt = current.lastRestoredClearAt || 0
    // 快照跟着 clearSnapshots 一起留下来了，那么「这家店放弃过退路」这件事也要留下来 ——
    // 丢了它，那些快照里可能还带着的 records 数组就永远清不掉了（见 ledger-migrate.js
    // 的 dropSnapshotLegacy）。
    if (current.legacyDroppedAt) next.legacyDroppedAt = current.legacyDroppedAt
    await tx.putLedger(shopId, next)
    return { lists: next }
  })

  if (!outcome.lists) {
    return {
      importing: {
        token: outcome.importing.token,
        nextSeq: outcome.importing.nextSeq,
        count: outcome.importing.count
      },
      skipped: !!outcome.skipped
    }
  }
  // 同样是「事务提交之后零 IO」：publicListsOf 只吃内存里那份账本文档。
  // 迁完之后客户端要看流水，走 listRecords 分页取，不靠回传。
  return {
    ledger: publicListsOf(shopId, outcome.lists)
  }
}

module.exports = {
  NOT_MEMBER: NOT_MEMBER,
  API_VERSION: API_VERSION,
  PLATFORM_ACTIONS: PLATFORM_ACTIONS,
  dispatch: dispatch,
  MAINTENANCE_READS: MAINTENANCE_READS,
  MAINTENANCE_ACTIONS: MAINTENANCE_ACTIONS,
  MAINTENANCE_DEFAULT_MESSAGE: MAINTENANCE_DEFAULT_MESSAGE,
  allowedDuringMaintenance: allowedDuringMaintenance,
  publicListsOf: publicListsOf,
  attachRecent: attachRecent,
  withBookId: withBookId,
  requireMember: requireMember,
  classifyTransactionError: classifyTransactionError,
  TX_NOT_EXIST: TX_NOT_EXIST,
  TX_CONFLICT: TX_CONFLICT,
  TX_TIMEOUT_FLOOR_MS: TX_TIMEOUT_FLOOR_MS,
  TX_TOO_BIG_MESSAGE: TX_TOO_BIG_MESSAGE,
  TX_CONFLICT_MESSAGE: TX_CONFLICT_MESSAGE
}
