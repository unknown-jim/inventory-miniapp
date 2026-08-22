const apply = require('./ledger-apply')
const inventory = require('./inventory')
const records = require('./ledger-records')

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
// 在那条路上写不出来。**
function publicListsOf(shopId, doc) {
  const source = doc || apply.emptyLedger()
  const lists = apply.listsOf(withBookId(source, shopId))
  lists.hasClearedBackup = apply.hasClearedBackup(source)
  lists.archivedClearCount = ((source && source.clearSnapshots) || []).length
  if (apply.recordsPending(source)) {
    // 还没迁移：流水仍在账本文档的数组里，读时自愈后原样回传。
    // 写路径已经被 assertRecordsReady 拦住，不会有一半在数组一半在集合的账。
    const legacy = apply.legacyRecordsOf(source)
    lists.records = legacy
    // 迁移窗口内 accounts / aggregate 还是 2b-1 之前的形状（根本没有这两个字段），
    // 直接投影会把全店金额和每个客户的欠款都回传成 0，而 getSlip 的 legacy 分支
    // 走 receivableAt 算得对 —— 送货单印 200、客户页显示 0，自相矛盾（审计阻塞 1）。
    // 数组已经在内存里，现折一次，零额外 IO。
    lists.accounts = inventory.foldAccountTerms(legacy)
    lists.aggregate = inventory.foldTotalTerms(legacy)
    apply.withAggregates(lists)
    lists.recordsPendingMigration = true
  }
  return lists
}

// 唯一会读 ledger_records 集合的回传函数。**只准从只读 action 调。**
// 记账路径永远不能调它：事务已经提交，这里一抛错（或一超时）就变成
// 「账记上了却报失败」，店员再点一次就真的记两笔。
// tests/ledger-records.test.js 的「提交之后不许读库」用例把这条钉死。
async function attachRecords(db, shopId, lists) {
  // 便宜的前置检查：aggregate.count 就在刚读到的账本文档里，一次比较。
  // 不用先烧掉 20 次分页往返才发现拼不完。
  const claimed = (lists.aggregate && lists.aggregate.count) || 0
  if (claimed > records.COMPAT_MAX_RECORDS) throw new Error(records.TOO_MANY_RECORDS)
  const store = records.recordStore(db.recordsCtx(), lists.bookId, shopId)
  lists.records = await store.readAll()        // 真正的硬上限在 readAll 里
  // 廉价哨兵：带外增删会让累加器和集合对不上。只报告不阻断 —— 这是读路径。
  const total = await store.countAll()
  if (total !== claimed) {
    lists.aggregatesStale = true
    console.warn('[ledger] aggregate drift shop=' + shopId + ' book=' + lists.bookId
      + ' count=' + total + ' aggregate=' + claimed)
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
    savedAt: snapshot.savedAt
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

function memberDocId(shopId, openid) {
  return String(shopId) + '_' + String(openid)
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
// legacyLine() 对老退货行写死 saleOrderId = ''，只有 backfillReturnedQty 在
// **同一批**里找到被退销售单才补得上。分处两片就会留下一张 saleOrderId 为空的
// 退货单，它的可退上限从此没有着落（见 2b-1a 审计阻塞 2 的可达性分析）。
function assertReturnsPaired(shard) {
  ;(shard || []).forEach(function (record) {
    if (!record || record.type !== 'return') return
    inventory.recordLines(record).forEach(function (line) {
      if (!String((line && line.saleOrderId) || '')) {
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
const VERSIONED_READS = ['getLedger', 'getSlip', 'migrateLocal']
function needsApiVersion(action) {
  return VERSIONED_READS.indexOf(action) >= 0 || isMutation(action)
}

async function membersOfShop(db, tx, shopId) {
  if (tx && tx.listMembersByShop) {
    return tx.listMembersByShop(shopId)
  }
  return db.listMembersByShop(shopId)
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
  // 只挡会回传账本的 action：whoami / listShops / createShop / listMembers 放行，
  // 否则老客户端连店都列不出来，报错会误导成「不是该店成员」。
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
    return db.runTransaction(async function (tx) {
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
  }

  if (action === 'getLedger') {
    const members = await db.listMembersByShop(shopId)
    requireMember(members, shopId, openid)
    const ledger = await db.getLedger(shopId)
    if (!ledger) {
      throw new Error('店铺账本不存在')
    }
    const lists = publicListsOf(shopId, ledger)
    if (!lists.recordsPendingMigration) await attachRecords(db, shopId, lists)
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
    const wantedId = String(payload.recordId || '')
    const legacy = apply.recordsPending(ledger) ? apply.legacyRecordsOf(ledger) : null
    const record = legacy
      ? legacy.find(function (item) { return item.id === wantedId }) || null
      : await store.byId(wantedId)
    if (!record) {
      throw new Error('流水不存在')
    }
    const customerId = String(record.customerId || '')
    // 散客单没有欠款线，直接给 0（老客户端的 missing 守卫对散客短路失效，
    // 这条路径现在根本不存在：服务端显式返回 0）
    if (!customerId) {
      return { record: record, receivable: 0 }
    }
    if (legacy) {
      return {
        record: record,
        receivable: inventory.receivableAt(legacy, customerId, record.createdAt)
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

  if (action === 'migrateLocal') {
    return migrateLocalShard(db, shopId, openid, payload, now, nextId)
  }

  if (!isMutation(action)) {
    throw new Error('未知操作')
  }

  // 事务边界：ledgers/{shopId} 的读 + 写仍然是全店所有写操作的唯一串行化点。
  // 所以即使「事务内 where() 是否上锁」语义不明，也不出问题 —— 任何并发写者要提交
  // 都必须先写 ledgers 文档，而它已经被本事务锁住了。
  // 单事务写入量：ledgers 1 个 + 记录 ≤2 个。
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
      result: applied.result,
      recordWrites: applied.recordWrites,
      bookChanged: applied.ledger.bookId !== current.bookId
    }
  })

  // 事务已经提交。**从这里到 return 之间不允许出现任何 await。**
  // 提交之后再失败一次，客户端看到的就是「记账失败」，店员会再点一次，
  // 于是同一笔账真的落两遍（见 2b-1a 审计阻塞 3）。
  // 回传要用的东西全部已经在内存里：lists 是事务里算好的账本，
  // recordWrites 是刚刚写进集合的那几条 —— 客户端把它合进自己的缓存即可，
  // 服务端写什么，客户端就合什么，是同一个数组。
  return {
    ledger: publicListsOf(shopId, outcome.lists),
    recordDelta: {
      bookId: String(outcome.lists.bookId || ''),
      bookChanged: !!outcome.bookChanged,
      count: (outcome.lists.aggregate && outcome.lists.aggregate.count) || 0,
      writes: outcome.recordWrites || []
    },
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
    // 一次性上传（不带 token）只有一片，空 saleOrderId 只可能是「被退销售单本来
    // 就不在这份本机账本里」，不是分片切坏的，拦了反而让这家店永远传不上来。
    if (token) assertReturnsPaired(shard)
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
    return {
      lists: next,
      shardWrites: shard.map(function (r) {
        return { op: 'set', record: r }
      })
    }
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
  // 同样是「事务提交之后零 IO」：一次性上传时 shardWrites 就是全部流水。
  return {
    ledger: publicListsOf(shopId, outcome.lists),
    recordDelta: {
      bookId: String(outcome.lists.bookId || ''),
      bookChanged: true,
      count: (outcome.lists.aggregate && outcome.lists.aggregate.count) || 0,
      // 一次性上传时这就是全部流水，零次读库；分片上传时只有最后一片，
      // 客户端按条数发现对不上，自己再拉一次全量。
      writes: outcome.shardWrites || []
    }
  }
}

module.exports = {
  NOT_MEMBER: NOT_MEMBER,
  API_VERSION: API_VERSION,
  dispatch: dispatch,
  publicListsOf: publicListsOf,
  attachRecords: attachRecords,
  withBookId: withBookId,
  requireMember: requireMember
}
