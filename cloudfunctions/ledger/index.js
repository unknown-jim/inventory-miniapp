const cloud = require('wx-server-sdk')
const core = require('./ledger-core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

function cloneData(data) {
  if (!data) return data
  const copy = {}
  Object.keys(data).forEach(function (key) {
    if (key === '_id') return
    copy[key] = data[key]
  })
  return copy
}

// 流水集合的句柄。传 db 就是事务外读，传 transaction 就是事务内读写。
// ledger-records.js 只认这两个字段，不认整个 db 对象。
function recordsCtx(scope) {
  return {
    collection: scope.collection('ledger_records'),
    command: _
  }
}

function createDb() {
  return {
    recordsCtx() {
      return recordsCtx(db)
    },
    async listMembersByOpenid(openid) {
      const res = await db.collection('members').where({ openid: openid }).limit(100).get()
      return res.data || []
    },
    async listShopsByIds(ids) {
      if (!ids || !ids.length) return []
      const res = await db.collection('shops').where({ _id: _.in(ids) }).limit(100).get()
      return res.data || []
    },
    async listMembersByShop(shopId) {
      const res = await db.collection('members').where({ shopId: shopId }).limit(100).get()
      return res.data || []
    },
    async getLedger(shopId) {
      try {
        const res = await db.collection('ledgers').doc(shopId).get()
        return res.data || null
      } catch (error) {
        return null
      }
    },
    // 平台运营方白名单。_id 就是 openid，所以是一次 doc().get()，不用索引。
    // **失败一律当「不是运营方」**：文档不存在会抛，读失败也会抛，两种都返回 null。
    // 这是有意的 fail-closed —— 读不出来就拒绝，比读不出来就放行安全得多；
    // 代价是一次瞬时读失败会让运维动作暂时不可用，重试即可。
    async getPlatformAdmin(openid) {
      try {
        const res = await db.collection('platform_admins').doc(String(openid || '')).get()
        return res.data || null
      } catch (error) {
        return null
      }
    },
    // 事务外读一份清空快照。只有账本升级的 mode:'snapshots' 用得上：它要先在
    // 事务外把快照里的流水逐条写进集合（写完再开事务盖 bookId），所以得先能
    // 在事务外看见这份文档。记账路径读快照仍然只走事务里的 tx.getClearSnapshot。
    async getClearSnapshot(id) {
      try {
        const res = await db.collection('ledger_clears').doc(id).get()
        return res.data || null
      } catch (error) {
        return null
      }
    },
    async runTransaction(fn) {
      try {
        return await db.runTransaction(async function (transaction) {
          const tx = {
            recordsCtx() {
              return recordsCtx(transaction)
            },
            async getLedger(shopId) {
              try {
                const res = await transaction.collection('ledgers').doc(shopId).get()
                return res.data || null
              } catch (error) {
                return null
              }
            },
            async putLedger(shopId, ledger) {
              await transaction.collection('ledgers').doc(shopId).set({
                data: cloneData(ledger)
              })
            },
            async getClearSnapshot(id) {
              try {
                const res = await transaction.collection('ledger_clears').doc(id).get()
                return res.data || null
              } catch (error) {
                return null
              }
            },
            async putClearSnapshot(id, snapshot) {
              await transaction.collection('ledger_clears').doc(id).set({
                data: cloneData(snapshot)
              })
            },
            async listMembersByShop(shopId) {
              const res = await transaction.collection('members').where({ shopId: shopId }).get()
              return res.data || []
            },
            async getShop(shopId) {
              try {
                const res = await transaction.collection('shops').doc(shopId).get()
                return res.data || null
              } catch (error) {
                return null
              }
            },
            async setShop(shop) {
              await transaction.collection('shops').doc(shop._id).set({
                data: cloneData(shop)
              })
            },
            async removeShop(shopId) {
              await transaction.collection('shops').doc(shopId).remove()
            },
            async setMember(member) {
              await transaction.collection('members').doc(member._id).set({
                data: cloneData(member)
              })
            },
            async removeMember(memberId) {
              await transaction.collection('members').doc(memberId).remove()
            },
            async removeLedger(shopId) {
              await transaction.collection('ledgers').doc(shopId).remove()
            },
            async listClearSnapshotsByShop(shopId) {
              const res = await transaction.collection('ledger_clears').where({ shopId: shopId }).limit(100).get()
              return res.data || []
            },
            async removeClearSnapshot(id) {
              try {
                await transaction.collection('ledger_clears').doc(id).remove()
              } catch (error) {
                return
              }
            }
          }
          return fn(tx)
        })
      } catch (error) {
        const msg = String((error && (error.message || error.errMsg)) || error || '')
        if (/conflict|transaction/i.test(msg)) {
          // **改写之前先把原文记下来。** 这句「库存刚被别人改过」是给店主看的话，
          // 但它盖住的是**任何**匹配 conflict / transaction 的底层错误——真正的并发
          // 冲突、事务超时、单事务写入量超限，在回包和日志里长得一模一样。
          //
          // 这不是假想。2026-08-24 演示店实测：改一张挂着 90 张退货单的销售单的
          // 单价（单事务写 ledgers 1 + 销售单 1 + 退货单 90 = 92 条）**确定性失败**，
          // 两次都是这句话；函数耗时 12.3 / 11.5 秒（远未到 60 秒上限）、内存
          // 155 / 138 MB（远未到 512 MB），事务是原子的（一条都没写进去）。
          // 当时**无法判断**到底撞了哪一条限制，因为原始错误就在这里被吞掉了，
          // CLS 里只剩改写后的文案，没有堆栈。
          //
          // console.error 的输出进云函数日志，不进回包，所以不会把内部细节
          // 泄露给客户端。**不要为了「日志干净」把这行删掉**——删掉就等于把
          // 下一次同类故障的排查成本重新抬回到「只能靠改代码重部署来加日志」。
          console.error('[ledger] transaction failed, original error:', msg, error && error.stack)
          throw new Error('库存刚被别人改过，请再提交')
        }
        throw error
      }
    }
  }
}

exports.main = async function (event) {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || wxContext.openid || ''
  try {
    const result = await core.dispatch({
      openid: openid,
      action: event && event.action,
      shopId: event && event.shopId,
      // 小程序必须带 apiVersion：老客户端拿到不带流水的回传会把缓存清空，
      // 下一张送货单印 0.00 的前欠。门在 ledger-core.js 的 dispatch 顶部。
      apiVersion: event && event.apiVersion,
      payload: (event && event.payload) || {},
      db: createDb()
    })
    return Object.assign({ ok: true }, result)
  } catch (error) {
    return {
      ok: false,
      error: (error && error.message) || '记账失败'
    }
  }
}
