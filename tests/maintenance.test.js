// 平台级维护开关（集合 platform_config 的 maintenance 文档）的服务端行为。
//
// 13 条验收项对照方案 §5.2，逐条编号钉住：
//   1 fail-open（读失败）：开关读不出来 = 没在维护 = 正常放行，回包不带 maintenance
//   2 fail-open（集合不存在）：同上
//   3 硬拦写：遍历 apply.MUTATIONS 本身，每一个 action 都被拒（以后新增的
//     mutation 自动被这条覆盖——遍历数组而不是手写列表）
//   4 硬拦写（MUTATIONS 之外的写）：createShop / addMember / updateMember /
//     removeMember / deleteShop / migrateLocal 也被拒
//   5 未知 action 也被拒（白名单的必然结果）
//   6 回包携带：维护开着时读 action 成功且带 maintenance
//   7 message 为空时回默认文案
//   8 维护关着时行为与今天完全一致：每一种回包都不含 maintenance 键
//   9 开关能随时关掉；setMaintenance 在维护开着时本身不被拦
//  10 setMaintenance / getMaintenance 走平台运营方白名单
//  11 运维 action（checkAggregates）维护期间照常放行
//  12 getMaintenance 不吞读失败（诊断路径），同一时刻 mutation 放行（拦截路径）
//  13 错误回包带得出维护标志（index.js 那段 if (error.maintenance) 的依据）
const assert = require('assert')
const core = require('../cloudfunctions/ledger/ledger-core')
const apply = require('../utils/ledger-apply')
const memory = require('./memory-db')
const MemoryDb = memory.MemoryDb

function idFactory() {
  let n = 0
  return function () {
    n += 1
    return 'mt-' + n
  }
}

async function call(db, makeId, openid, action, shopId, payload, now) {
  return core.dispatch({
    db: db,
    makeId: makeId,
    openid: openid,
    action: action,
    shopId: shopId,
    apiVersion: core.API_VERSION,
    payload: payload || {},
    now: now || 1000
  })
}

async function rejectsMessage(promise, message) {
  try {
    await promise
  } catch (error) {
    assert.strictEqual(error.message, message,
      '错误文案对不上：' + error.message + ' ≠ ' + message)
    return error
  }
  assert.fail('本该抛错：' + message)
}

async function rejects(promise, re) {
  try {
    await promise
  } catch (error) {
    assert.ok(re.test(error.message), 'unexpected error: ' + error.message)
    return
  }
  assert.fail('expected to reject ' + re)
}

// 维护开着之前先把店和货备好（开着之后 createShop / saveProduct 会被拦）。
async function setupShop(db, ids) {
  const res = await call(db, ids, 'owner-a', 'createShop', '', { name: '测试店' })
  const shopId = res.shop.id
  await call(db, ids, 'owner-a', 'saveProduct', shopId, {
    name: '铜轴', costPrice: 10, salePrice: 20, stock: 5
  })
  return shopId
}

function addAdmin(db, openid) {
  db.platformAdmins[openid] = { _id: openid, openid: openid, note: '', createdAt: 0 }
}

const CUSTOM_MESSAGE = '今晚 22:00-23:00 升级'

function noMaintenanceKey(res, label) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'maintenance'), false,
    label + ' 不许带 maintenance 键（维护关着时回包和今天一模一样）')
}

;(async function () {
  // ---------------------------------------------------------------- 1 + 2
  // fail-open：读失败 / 集合不存在，都当「没在维护」放行，回包一个字节不改。
  {
    const db = new MemoryDb()
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    db.maintenanceReadThrows = true
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    const res = await call(db, ids, 'owner-a', 'saveProduct', shopId, {
      name: '读失败也放行', costPrice: 1, salePrice: 2, stock: 1
    })
    assert.ok(res.result, '开关读失败时 mutation 正常通过（fail-open）')
    noMaintenanceKey(res, 'fail-open（读失败）的回包')
  }
  {
    const db = new MemoryDb()   // maintenance = null：集合压根没建
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    const res = await call(db, ids, 'owner-a', 'saveProduct', shopId, {
      name: '没集合也放行', costPrice: 1, salePrice: 2, stock: 1
    })
    assert.ok(res.result, '集合不存在时 mutation 正常通过（fail-open）')
    noMaintenanceKey(res, 'fail-open（集合不存在）的回包')
  }

  // ---------------------------------------------------------------- 3
  // 硬拦写：遍历 apply.MUTATIONS 数组本身。以后新增的 mutation 不改这条测试
  // 也自动被覆盖——手写列表做不到这一点。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    assert.ok(apply.MUTATIONS.length > 0, '前提：MUTATIONS 非空')
    for (let i = 0; i < apply.MUTATIONS.length; i++) {
      const action = apply.MUTATIONS[i]
      await rejectsMessage(
        call(db, ids, 'owner-a', action, shopId, {}),
        CUSTOM_MESSAGE
      )
    }
  }

  // ---------------------------------------------------------------- 4
  // MUTATIONS 之外但确实写库的 action：白名单机制保证它们被拦，这条钉住这一点。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    const writes = ['createShop', 'addMember', 'updateMember', 'removeMember', 'deleteShop', 'migrateLocal']
    for (let i = 0; i < writes.length; i++) {
      await rejectsMessage(
        call(db, ids, 'owner-a', writes[i], shopId, writes[i] === 'createShop' ? { name: '新店' } : {}),
        CUSTOM_MESSAGE
      )
    }
  }

  // ---------------------------------------------------------------- 5
  // 未知 action：白名单的必然结果是它也落在「维护期不许」那一侧。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    await rejectsMessage(
      call(db, ids, 'owner-a', 'notARealAction', '', {}),
      CUSTOM_MESSAGE
    )
  }

  // ---------------------------------------------------------------- 6
  // 回包携带：维护开着时读 action 全部成功，回包带 maintenance（需求 2 的机制）。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    const who = await call(db, ids, 'owner-a', 'whoami')
    assert.strictEqual(who.openid, 'owner-a')
    assert.strictEqual(who.maintenance.on, true)
    assert.strictEqual(who.maintenance.message, CUSTOM_MESSAGE)
    const ledger = await call(db, ids, 'owner-a', 'getLedger', shopId)
    assert.ok(ledger.ledger, '维护期 getLedger 照常放行（读白名单）')
    assert.strictEqual(ledger.maintenance.message, CUSTOM_MESSAGE)
    const page = await call(db, ids, 'owner-a', 'listRecords', shopId, { limit: 5 })
    assert.ok(Array.isArray(page.records), '维护期 listRecords 照常放行')
    assert.strictEqual(page.maintenance.on, true)
    // 摘要条和它下面那张列表是同一件事：放行一个、挡住另一个没有道理
    const sum = await call(db, ids, 'owner-a', 'getRecordSummary', shopId, { from: 1, to: 9999999999999 })
    assert.ok(sum.totals, '维护期 getRecordSummary 照常放行')
    assert.strictEqual(sum.maintenance.on, true)
  }

  // ---------------------------------------------------------------- 7
  // 自定义文案与默认文案：message 为空回 MAINTENANCE_DEFAULT_MESSAGE。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: '' }
    const who = await call(db, ids, 'owner-a', 'whoami')
    assert.strictEqual(who.maintenance.message, core.MAINTENANCE_DEFAULT_MESSAGE,
      'message 为空时回服务端默认文案')
  }

  // ---------------------------------------------------------------- 8
  // 维护关着：行为与今天完全一致。用 hasOwnProperty 钉字面——res.maintenance
  // === undefined 分不清「没有这个键」和「键在、值恰好是 undefined」。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: false, message: CUSTOM_MESSAGE }
    const who = await call(db, ids, 'owner-a', 'whoami')
    noMaintenanceKey(who, 'whoami 回包')
    const shops = await call(db, ids, 'owner-a', 'listShops')
    noMaintenanceKey(shops, 'listShops 回包')
    const ledger = await call(db, ids, 'owner-a', 'getLedger', shopId)
    noMaintenanceKey(ledger, 'getLedger 回包')
    const page = await call(db, ids, 'owner-a', 'listRecords', shopId, { limit: 5 })
    noMaintenanceKey(page, 'listRecords 回包')
    const saved = await call(db, ids, 'owner-a', 'saveProduct', shopId, {
      name: '关着时正常记', costPrice: 1, salePrice: 2, stock: 1
    })
    assert.ok(saved.result, '维护关着时 mutation 正常')
    noMaintenanceKey(saved, 'mutation 回包')
  }

  // ---------------------------------------------------------------- 9
  // 开关能随时关掉：开着 → 写被拒 → 关掉（setMaintenance 本身不被拦）→ 写恢复。
  // setMaintenance 若被维护门拦住，开关就成了发版才能解除的东西。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    addAdmin(db, 'op-user')
    const on = await call(db, ids, 'op-user', 'setMaintenance', '', { on: true, message: CUSTOM_MESSAGE })
    assert.strictEqual(on.on, true)
    assert.strictEqual(db.maintenance.on, true)
    await rejectsMessage(
      call(db, ids, 'owner-a', 'saveProduct', shopId, { name: '维护中被拦', costPrice: 1, salePrice: 1, stock: 1 }),
      CUSTOM_MESSAGE
    )
    const off = await call(db, ids, 'op-user', 'setMaintenance', '', { on: false })
    assert.strictEqual(off.on, false)
    assert.strictEqual(db.maintenance.on, false)
    const saved = await call(db, ids, 'owner-a', 'saveProduct', shopId, {
      name: '关掉立刻恢复', costPrice: 1, salePrice: 1, stock: 1
    })
    assert.ok(saved.result, '开关关掉之后写立刻恢复')
  }

  // ---------------------------------------------------------------- 10
  // setMaintenance / getMaintenance 走平台运营方白名单（和账本升级同一道门）。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    await setupShop(db, ids)
    await rejects(
      call(db, ids, 'owner-a', 'setMaintenance', '', { on: true }),
      /账本升级只能由平台运营方执行/
    )
    await rejects(
      call(db, ids, 'owner-a', 'getMaintenance', ''),
      /账本升级只能由平台运营方执行/
    )
    assert.strictEqual(db.maintenance, null, '非运营方的 setMaintenance 不许碰开关')
  }

  // ---------------------------------------------------------------- 11
  // 运维 action 维护期间照常放行：checkAggregates 就是维护窗口里要做的事。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    addAdmin(db, 'op-user')
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    const res = await call(db, ids, 'op-user', 'checkAggregates', shopId)
    assert.ok(res, '维护期运营方仍能跑 checkAggregates')
    assert.strictEqual(res.maintenance.on, true, '运维回包也带维护标志')
  }

  // --------------------------------------------------------------- 11b
  // purgeDeletedShopRecords 同样要放行。它**不在 OPS_ACTIONS 里**（那份名单只有
  // 账本升级三个），走的是 PLATFORM_ACTIONS —— 所以维护门的判据必须是
  // isPlatformAction 而不是 isOpsAction。这条测试就是钉住那个判据：
  // 换回 isOpsAction 会让维护窗口里跑不了删店清理，而那正是窗口里会做的事。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    await setupShop(db, ids)
    addAdmin(db, 'op-user')
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    // 一个已经删掉的店：shops 里查不到、ledgers 里也没有，正是这个 action 的前提
    const res = await call(db, ids, 'op-user', 'purgeDeletedShopRecords', 'gone-shop')
    assert.strictEqual(res.shopId, 'gone-shop', '维护期运营方仍能跑删店清理')
    assert.strictEqual(res.maintenance.on, true, '它的回包也带维护标志')
  }

  // ---------------------------------------------------------------- 12
  // 同一次读失败，两条路径有意不同：拦截路径 fail-open（mutation 放行），
  // 诊断路径不吞（getMaintenance 抛错）。运维方要能分辨「关的」和「读不出来」。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    addAdmin(db, 'op-user')
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    db.maintenanceReadThrows = true
    const saved = await call(db, ids, 'owner-a', 'saveProduct', shopId, {
      name: '读失败放行', costPrice: 1, salePrice: 1, stock: 1
    })
    assert.ok(saved.result, '拦截路径 fail-open：同一时刻 mutation 放行')
    noMaintenanceKey(saved, 'fail-open 的回包')
    await rejects(
      call(db, ids, 'op-user', 'getMaintenance', ''),
      /maintenance read failed/
    )
  }

  // ---------------------------------------------------------------- 13
  // 错误回包带得出维护标志：dispatch 抛出的 error 上挂着 maintenance，
  // index.js 的 exports.main 靠它把失败的回包也带上标志。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    let caught = null
    try {
      await call(db, ids, 'owner-a', 'saveProduct', shopId, {
        name: '错误也要带标志', costPrice: 1, salePrice: 1, stock: 1
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught, '维护期写必须被拒')
    assert.strictEqual(caught.message, CUSTOM_MESSAGE)
    assert.ok(caught.maintenance, 'error 上挂着 maintenance 标志')
    assert.strictEqual(caught.maintenance.on, true)
    assert.strictEqual(caught.maintenance.message, CUSTOM_MESSAGE)
  }

  // ---------------------------------------------------------------- 13b
  // renameShop 维护期被挡：allowedDuringMaintenance 是白名单，renameShop 不在
  // MAINTENANCE_READS 里，所以不用写一行拦截代码它就自动落在「不许」那一侧。
  // 这条钉住的是「没有人把它加进白名单」—— 加进去这条就红。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    const shopId = await setupShop(db, ids)
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    let caught = null
    try {
      await call(db, ids, 'owner-a', 'renameShop', shopId, { name: '维护期改名' })
    } catch (error) {
      caught = error
    }
    assert.ok(caught, '维护期改名必须被拒')
    assert.strictEqual(caught.message, CUSTOM_MESSAGE)
    assert.ok(caught.maintenance, '改名失败的回包也要带 maintenance 标志')
  }

  // ---------------------------------------------------------------- 14
  // 判据必须是**严格** on === true。
  //
  // 审计发现这一条原来没测：把 maintenanceOn 从 `doc.on === true` 放宽成
  // `!!doc.on`，整轮测试还是绿的。放宽的后果不是理论问题——一份 `{on:'false'}`
  // 的文档（控制台手改时很容易打成字符串）会被 `!!` 判成**真**，于是所有店
  // 一起被锁死，而运营方看着控制台里写着 false 完全想不到是它。
  // 严格判据是这里唯一安全的方向：拿不准就当没在维护（fail-open）。
  {
    const loose = [
      { on: 'true' }, { on: 'false' }, { on: 1 }, { on: 0 },
      { on: null }, { on: undefined }, { on: {} }, {}
    ]
    for (let i = 0; i < loose.length; i++) {
      const db = new MemoryDb()
      const ids = idFactory()
      const shopId = await setupShop(db, ids)
      db.maintenance = Object.assign({ _id: 'maintenance' }, loose[i])
      const saved = await call(db, ids, 'owner-a', 'saveProduct', shopId, {
        name: '宽判据' + i, costPrice: 1, salePrice: 1, stock: 1
      })
      assert.ok(saved.result, 'on 不是严格 true 时必须放行：' + JSON.stringify(loose[i]))
      noMaintenanceKey(saved, 'on=' + JSON.stringify(loose[i]) + ' 的回包')
    }
  }

  // ---------------------------------------------------------------- 15
  // setMaintenance / getMaintenance 自己的回包**不挂**维护标志。
  //
  // doc 是进 dispatch 那一刻读的，而 setMaintenance 很可能刚把它改掉：挂上去
  // 就是一份过期状态（关掉维护的那次调用，回包里却写着 on:true）。今天只有
  // devtools Console 调得到它、不走 utils/store.js，所以没人被坑；这条测试是为了
  // 以后有人把它接进客户端时不会踩——那时运营方按下「关闭维护」会自己被弹一个
  // 「后台维护中」，而且那份过期状态还会占住去重用的 shownKey。
  {
    const db = new MemoryDb()
    const ids = idFactory()
    await setupShop(db, ids)
    addAdmin(db, 'op-user')
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    const off = await call(db, ids, 'op-user', 'setMaintenance', '', { on: false })
    assert.strictEqual(off.on, false, '关掉维护')
    noMaintenanceKey(off, 'setMaintenance 的回包')
    db.maintenance = { _id: 'maintenance', on: true, message: CUSTOM_MESSAGE }
    const got = await call(db, ids, 'op-user', 'getMaintenance', '')
    assert.strictEqual(got.on, true, 'getMaintenance 读得到权威状态')
    noMaintenanceKey(got, 'getMaintenance 的回包')
  }

  console.log('maintenance tests passed')
})().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
