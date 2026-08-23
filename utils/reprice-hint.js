const inventory = require('./inventory')
const util = require('./util')

// 有退货的销售单改单价时，保存前给店主看的那一句话。
//
// 为什么要这一句：退货行的单价不是店主录的（退货页只收数量），是退货时从销售行
// 复制过去的派生值。销售行改了价，同单退货就跟着按新价整体重算（utils/inventory.js
// 的 repriceSaleReturns），销售额、毛利、欠款都会变。账面变了，当初实际退出去的
// 现金不会跟着变 —— 抽屉里到底是多少只有店主知道，软件不替他判断，只把这件事
// 摆出来问一次。改实收、改数量不产生这件事，不弹。

// 流水行 -> { [lineId]: { unitPrice, returnedQty, returnedAmount } }。
// 必须在进入编辑**之前**建：页面上的行会被改掉，这里要的是改之前的样子。
// returnedAmount 缺失的是老流水，按 returnedQty × 当时单价回推，和数据层
// （returnedAmountOfSale）同一条兜底口径。
function savedReturnsOf(recordLines) {
  const saved = {}
  ;(recordLines || []).forEach(function (line) {
    const unitPrice = inventory.round2(inventory.toNumber(line.unitPrice))
    const returnedQty = inventory.round2(inventory.toNumber(line.returnedQty))
    saved[String(line.lineId || '')] = {
      unitPrice: unitPrice,
      returnedQty: returnedQty,
      returnedAmount: (line.returnedAmount == null || line.returnedAmount === '')
        ? inventory.round2(returnedQty * unitPrice)
        : inventory.round2(line.returnedAmount)
    }
  })
  return saved
}

// saved 见上；lines = 页面上正在编辑的行（{ id, unitPrice, ... }）。
// 有退货的行里只要有一行的单价真的变了就出文案，否则返回空串。
function repriceHint(saved, lines) {
  const before = saved || {}
  let changed = false
  let qty = 0
  let oldAmount = 0
  let newAmount = 0
  ;(lines || []).forEach(function (item) {
    const prev = before[String(item.id || '')]
    if (!prev || prev.returnedQty <= 0) return
    qty = inventory.round2(qty + prev.returnedQty)
    oldAmount = inventory.round2(oldAmount + prev.returnedAmount)
    newAmount = inventory.round2(newAmount
      + inventory.round2(prev.returnedQty * inventory.toNumber(item.unitPrice)))
    if (inventory.round2(item.unitPrice) !== prev.unitPrice) changed = true
  })
  if (!changed) return ''
  return '这张单已经退了 ' + qty + ' 件，当时记 ¥' + util.money(oldAmount)
    + '。改单价会把这几件按新单价一起重算成 ¥' + util.money(newAmount)
    + '，销售额、毛利、欠款都会跟着变。当初实际退出去的现金不会变，请自己核对一下。'
}

module.exports = {
  savedReturnsOf: savedReturnsOf,
  repriceHint: repriceHint
}
