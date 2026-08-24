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
function assertRecordsReady(ledger) {
  if (apply.recordsPending(ledger)) {
    throw new Error('本店账本还没完成流水升级，暂时不能记账')
  }
}

function isMutation(action) {
  return apply.MUTATIONS.indexOf(action) >= 0
}

// 2b-1 起小程序必须带 apiVersion。老客户端（已发布那一版）拿到不带 records
// 的回传会把本地流水缓存清成空数组，下一张送货单就会印一个 0.00 的前欠。
const API_VERSION = 2
const VERSIONED_READS = ['getLedger', 'getSlip', 'migrateLocal', 'listRecords', 'getRecord']
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
//（它按集合现状重折叠）。所以 shops 和 ledgers 里**只要还有一份文档在就直接拒绝**，
// 两个都查，不是二选一 —— 半删状态（店没了账本还在，或反过来）同样要拒绝，
// 那说明上一次删店没走完，先弄清楚再说，不能顺手把流水删了。
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

async function dispatch(input) {
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
  if (action === 'listRecords') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    const type = String(payload.type || '')
    const customerId = String(payload.customerId || '')
    if (type && type !== 'all' && customerId) {
      throw new Error('不支持同时按类型和客户筛选')
    }
    const raw = await db.getLedger(shopId)
    if (!raw) {
      throw new Error('店铺账本不存在')
    }
    const ledger = withBookId(raw, shopId)
    const pageOptions = {
      type: type, customerId: customerId, cursor: payload.cursor, limit: payload.limit
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

  if (action === 'migrateLocal') {
    return migrateLocalShard(db, shopId, openid, payload, now, nextId)
  }

  if (!isMutation(action)) {
    throw new Error('未知操作')
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
  // 2b-2b 起**不再回传 recordDelta**：分页之后客户端每个列表都是服务端取的、
  // 每个金额都来自 accounts / totals 投影，没有任何一处消费 delta。留着一个
  // 没人用的算钱字段就是给下一个人留坑（方案 C-2，用户已明确点头）。
  return {
    ledger: publicListsOf(shopId, outcome.lists),
    result: outcome.result
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
// 不带 token 的一次性上传只有一片、isFinal 恒为真，所以那道门对客户端就是全量的
//（utils/store.js 的 migrateLocal() 从不带 token）。
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
    next.records = []
    next.importing = null
    next.clearSnapshots = current.clearSnapshots || []
    next.lastRestoredClearAt = current.lastRestoredClearAt || 0
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
  publicListsOf: publicListsOf,
  attachRecent: attachRecent,
  withBookId: withBookId,
  requireMember: requireMember
}
