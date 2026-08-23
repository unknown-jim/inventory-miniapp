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
