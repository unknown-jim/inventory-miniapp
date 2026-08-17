const apply = require('./ledger-apply')

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

function publicLedger(doc) {
  const lists = apply.listsOf(doc || apply.emptyLedger())
  lists.hasClearedBackup = apply.hasClearedBackup(doc)
  lists.archivedClearCount = ((doc && doc.clearSnapshots) || []).length
  return lists
}

function clearDoc(shopId, snapshot) {
  return {
    _id: snapshot.id,
    id: snapshot.id,
    shopId: shopId,
    savedAt: snapshot.savedAt,
    products: snapshot.products || [],
    skus: snapshot.skus || [],
    records: snapshot.records || [],
    customers: snapshot.customers || [],
    categories: snapshot.categories || []
  }
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

function ledgerHasData(ledger) {
  if (!ledger) return false
  return (ledger.products && ledger.products.length)
    || (ledger.skus && ledger.skus.length)
    || (ledger.records && ledger.records.length)
    || (ledger.customers && ledger.customers.length)
    || (ledger.categories && ledger.categories.length)
}

function isMutation(action) {
  return apply.MUTATIONS.indexOf(action) >= 0
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
    return { ledger: publicLedger(ledger) }
  }

  if (action === 'migrateLocal') {
    const incoming = payload.ledger || payload
    return db.runTransaction(async function (tx) {
      const members = await membersOfShop(db, tx, shopId)
      requireMember(members, shopId, openid)
      const current = await tx.getLedger(shopId)
      if (!current) {
        throw new Error('店铺账本不存在')
      }
      if (ledgerHasData(current)) {
        throw new Error('云上已有账本，不能再上传本机数据')
      }
      const next = apply.listsOf({
        products: incoming.products,
        skus: incoming.skus,
        records: incoming.records,
        customers: incoming.customers,
        categories: incoming.categories,
        revision: 0
      })
      next.revision = 1
      next.migratedFromLocal = true
      next.clearSnapshots = current.clearSnapshots || []
      next.lastRestoredClearAt = current.lastRestoredClearAt || 0
      await tx.putLedger(shopId, next)
      return { ledger: publicLedger(next) }
    })
  }

  if (!isMutation(action)) {
    throw new Error('未知操作')
  }

  return db.runTransaction(async function (tx) {
    const members = await membersOfShop(db, tx, shopId)
    requireMember(members, shopId, openid)
    let current = await tx.getLedger(shopId)
    if (!current) {
      throw new Error('店铺账本不存在')
    }
    const adopted = adoptLegacyBackup(current, nextId, now)
    if (adopted.snapshot) {
      await tx.putClearSnapshot(adopted.snapshot.id, clearDoc(shopId, adopted.snapshot))
    }
    current = adopted.ledger
    let mutationPayload = payload
    if (action === 'addSale') {
      mutationPayload = Object.assign({}, payload, operatorSnapshot(members, shopId, openid, payload, {
        defaultToActor: true
      }))
    } else if (action === 'updateRecord') {
      const existing = (current.records || []).find(function (item) {
        return item.id === payload.id
      })
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
      applied = apply.applyMutation(current, action, { snapshot: snapshot }, now, nextId)
    } else {
      applied = apply.applyMutation(current, action, mutationPayload, now, nextId)
      if (applied.result && applied.result.clearSnapshot) {
        const snapshot = applied.result.clearSnapshot
        await tx.putClearSnapshot(snapshot.id, clearDoc(shopId, snapshot))
        delete applied.result.clearSnapshot
      }
    }
    await tx.putLedger(shopId, applied.ledger)
    return {
      ledger: publicLedger(applied.ledger),
      result: applied.result
    }
  })
}

module.exports = {
  NOT_MEMBER: NOT_MEMBER,
  dispatch: dispatch,
  publicLedger: publicLedger,
  requireMember: requireMember
}
