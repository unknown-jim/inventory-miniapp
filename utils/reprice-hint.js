const inventory = require('./inventory')
const util = require('./util')

// 有退货的销售单保存前，给店主看的那一句话。
//
// 为什么要这一句：退货行的单价不是店主录的（退货页只收数量），是退货时从销售行
// 复制过去的派生值。销售行改了价，同单退货就跟着按新价整体重算（utils/inventory.js
// 的 repriceSaleReturns），销售额、毛利、欠款都会变。**账上记的现金退款额也跟着
// 变，当初实际退出去的现金不会** —— 那个差额就是店主要自己找补的数。
//
// 这个差额别处看不到：现金退款额记在退货单头的 paidAmount 上，没有任何页面显示
// 它，店主既看不见它变了、也推不出该补多少。所以这句话必须一次说完四件事 ——
// 改前多少、改后多少、差多少、差额怎么补。只提醒「请自己核对一下」等于没说。
// 改实收、改数量、改没退过货的行都不产生这件事，不弹。

// 一张销售单名下**全部**退货单的现金退款额之和。
//
// recomputeSaleReturns 把它按记账顺序拆成每张退货单的 paidAmount，拆分不变量
// Σ(r_i − c_i) == min(D, Σr_i) 决定了总和只有一个值：
//     Σc = max(0, Σ退货货值 − 欠款基准 D)，D = 应收 − 实收
// 所以这里不必加载退货单也能算出总额 —— 详情页本来也只 fetch 这一张销售单。
//
// 老退货单还没 materialize paidAmount 时（读的时候按 payType 回推），账上此刻
// 显示的可能不是这个数；但保存时 recomputeSaleReturns 正会把它拨到这个数，
// 所以「改完会变成多少」这半句仍然成立。
function cashRefundOf(amount, settled, returnedAmount) {
  const debt = inventory.round2(inventory.round2(amount) - inventory.round2(settled))
  const cash = inventory.round2(inventory.round2(returnedAmount) - debt)
  return cash > 0 ? cash : 0
}

// 进入编辑**之前**的销售单快照。必须在改之前建：页面上的行会被改掉，这里要的
// 是改之前的样子。returnedAmount 缺失的是老流水，按 returnedQty × 当时单价回推，
// 和数据层（returnedAmountOfSale）同一条兜底口径。
//
// **正因为同口径，缺字段时下面 repriceHint 的 mixed 判据恒为假** —— 它比的是
// |returnedAmount − returnedQty × unitPrice|，而缺字段时这里补出来的正是
// returnedQty × unitPrice，差值恒为 0。所以缺失必须单独立一个
// returnedAmountMissing 标记，靠它兜住，不能指望 mixed 顺带抓到。
function savedSaleOf(record) {
  const lines = {}
  let returnedAmount = 0
  inventory.recordLines(record).forEach(function (line) {
    const unitPrice = inventory.round2(inventory.toNumber(line.unitPrice))
    const returnedQty = inventory.round2(inventory.toNumber(line.returnedQty))
    const missing = (line.returnedAmount == null || line.returnedAmount === '')
    const amount = missing
      ? inventory.round2(returnedQty * unitPrice)
      : inventory.round2(line.returnedAmount)
    lines[String(line.lineId || '')] = {
      unitPrice: unitPrice,
      returnedQty: returnedQty,
      returnedAmount: amount,
      returnedAmountMissing: missing
    }
    returnedAmount = inventory.round2(returnedAmount + amount)
  })
  return {
    amount: inventory.round2(inventory.toNumber(record && record.amount)),
    settled: inventory.settledAmount(record),
    returnedAmount: returnedAmount,
    lines: lines
  }
}

// 账上现金退款额改前改后的差，以及差额怎么补。差为 0 就不说这段。
//
// 符号是有方向的，不能两头都写「补记一笔收款」：客户欠款 = Σ(应收−实收) +
// 期初 − Σ(退货额−现金退款) − Σ收款（inventory.js 的 accountOf），现金退款额
// 记少 1 元，欠款就跟着少 1 元。所以
//   · 账上记少了（涨价那头）：那笔现金真出去了，账上不认，等于客户还欠你，
//     要收回来才对得上 —— 这时候再记一笔收款只会把欠款推得更低。
//   · 账上记多了（降价那头）：账上多算了一笔没出去的现金，欠款被记多了，
//     补记一笔同额收款正好冲平 —— docs/accounting-vs-policy.md 的
//     「事后补记一笔收款就对上」只在这一头成立。
// 保存之后账上的退款现金。newReturned 由构造是准的：repriceSaleReturns 会把这张
// 销售单名下**每一条**匹配的退货行都拨到销售行当前单价，所以落库的 Σ退货额
// 就是「已退件数 × 现价」（小数件数下逐张 round2 最多差 1 分，见下方）。
function cashAfterOf(nextAmount, paidAmount, savedSettled, newReturned) {
  const paid = (paidAmount == null || String(paidAmount).trim() === '')
    ? savedSettled : inventory.round2(paidAmount)
  return cashRefundOf(nextAmount,
    inventory.settledAmount({ amount: nextAmount, paidAmount: paid }), newReturned)
}

function cashHint(saved, oldReturned, newReturned, nextAmount, paidAmount) {
  const before = cashRefundOf(saved.amount, saved.settled, oldReturned)
  const after = cashAfterOf(nextAmount, paidAmount, saved.settled, newReturned)
  const diff = inventory.round2(before - after)
  if (diff === 0) return '销售额、毛利、欠款跟着变，账上的退款现金不变。'
  const moved = '账上的退款现金 ¥' + util.money(before) + ' → ¥' + util.money(after)
    + '，当初真退出去的没变；'
  if (diff > 0) {
    return moved + '少记的 ¥' + util.money(diff) + ' 等于客户还欠你，收回来账才对上。'
  }
  return moved + '多记的 ¥' + util.money(-diff) + ' 其实没退给客户，退给他或补记一笔收款。'
}

// saved 见 savedSaleOf；lines = 页面上正在编辑的行（{ id, qty, unitPrice }）；
// paidAmount = 页面上填的实收（新的欠款基准要用它）。
//
// 三种情况出文案：
//   1. 有退货的行**这次改了单价** —— 保存会按新价重算同单退货。
//   2. 单价一个字没改，但退货行本来就和销售行不是一个价 —— main 上被改出两套价
//      的老单，保存会被静默拨回一致。方向是对的（是修复），但账上的退款现金
//      一样会动，不说一声店主毫无预期。
//   3. 有退货的行**根本没记 returnedAmount**（老流水）。这一类躲得过第 2 条：
//      快照缺字段时按 returnedQty × unitPrice 补，而第 2 条比的正是这条公式，
//      差值恒为 0。所以它得靠 savedSaleOf 打的 returnedAmountMissing 标记单独兜。
//      保存一样会动钱：同单退货行被拨到现价、returnedAmount 落成 Σ退货额，
//      而账上此刻显示的那个回推值本来就不一定等于当初真退的货值。
function repriceHint(saved, lines, paidAmount) {
  const snapshot = saved || {}
  const before = snapshot.lines || {}
  let changed = false
  let mixed = false
  let missing = false
  let qty = 0
  let oldReturned = 0
  let newReturned = 0
  let nextAmount = 0
  ;(lines || []).forEach(function (item) {
    const unitPrice = inventory.round2(inventory.toNumber(item.unitPrice))
    nextAmount = inventory.round2(nextAmount
      + inventory.round2(inventory.toNumber(item.qty) * unitPrice))
    const prev = before[String(item.id || '')]
    if (!prev || prev.returnedQty <= 0) return
    qty = inventory.round2(qty + prev.returnedQty)
    oldReturned = inventory.round2(oldReturned + prev.returnedAmount)
    // 真正落库的是 Σ round2(每张退货单 qty × 新单价)，这里只有该行的已退件数
    // 合计，按 round2(合计 × 新单价) 估。件数是整数时两者逐分相同；type="digit"
    // 允许小数件数，那时每张退货单最多差半分，文案里的金额可能和落库结果差 1 分。
    // 详情页只 fetch 这一张销售单，不为 1 分再拉一次退货单。
    newReturned = inventory.round2(newReturned
      + inventory.round2(prev.returnedQty * unitPrice))
    if (unitPrice !== prev.unitPrice) changed = true
    if (prev.returnedAmountMissing) missing = true
    // 容差 1 分：小数件数下 returnedAmount（逐张 round2 累加）和
    // round2(合计 × 单价) 本来就可能差半分，不能把它当成两套价。
    if (Math.abs(inventory.round2(prev.returnedAmount
      - inventory.round2(prev.returnedQty * prev.unitPrice))) > 0.01) mixed = true
  })
  if (!changed && !mixed && !missing) return ''
  if (changed) {
    return '这张单退过 ' + qty + ' 件，退货额按新价从 ¥' + util.money(oldReturned)
      + ' 重算成 ¥' + util.money(newReturned) + '。'
      + cashHint(snapshot, oldReturned, newReturned, nextAmount, paidAmount)
  }
  // 缺 returnedAmount 时**不能**套用上面那套「改前 → 改后」的说法：改前那一头
  // 账上压根没记，页面拿到的只是按现价回推的估值，而这张单只 fetch 了它自己、
  // 看不到那几张退货单的实际金额。所以这里只说保存后的两个准数（Σ退货额由构造
  // 等于「已退件数 × 现价」，退款现金跟着它现算），改前那一头如实说看不出来 ——
  // 报一个可能是错的「改前 ¥X」比不报更糟。
  if (missing) {
    return '这张单退过 ' + qty + ' 件，账上没记当时的退货金额（老单据）。保存会按现在的价'
      + '把退货额记成 ¥' + util.money(newReturned) + '、账上的退款现金记成 ¥'
      + util.money(cashAfterOf(nextAmount, paidAmount, snapshot.settled, newReturned))
      + '；当初那几张退货单开的是什么价、真退出去多少现金，这张单上看不出来。'
  }
  return '这张单退过 ' + qty + ' 件，退货行挂着旧单价（历史遗留，不是这次改的）。'
    + '保存会按现在的价补齐：¥' + util.money(oldReturned)
    + ' → ¥' + util.money(newReturned) + '。'
    + cashHint(snapshot, oldReturned, newReturned, nextAmount, paidAmount)
}

module.exports = {
  savedSaleOf: savedSaleOf,
  repriceHint: repriceHint
}
