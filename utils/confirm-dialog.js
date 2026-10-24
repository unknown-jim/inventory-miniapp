/**
 * confirm-dialog 文案组装（稿 10:126 / 10:128 / 7:267 / 7:456）。
 * 纯函数，方便单测；真正弹层在 components/confirm-dialog。
 */
const inventory = require('./inventory')

function moneyYuan(n) {
  return '¥' + inventory.round2(n).toFixed(2)
}

/** 放弃改动 7:456 */
function discardOpts() {
  return {
    title: '放弃未保存的改动？',
    body: '改动还没保存。放弃并返回后，这一屏填过的内容不会保留。',
    confirmText: '放弃',
    cancelText: '取消',
    confirmTone: 'danger'
  }
}

/** 移出成员 7:267 */
function removeMemberOpts(displayName) {
  const who = displayName || '该成员'
  return {
    title: '移出成员' + who + '？',
    body: '移出后' + who + '将无法进入这家店的账本。移出后会连带发生：',
    impactLines: [
      '· ' + who + '的账号不再关联本店',
      '· 历史流水里的经手人仍显示原来的称呼',
      '· 把身份码再发给店主即可加回'
    ],
    note: '移出不影响已经记下的账。',
    confirmText: '移出',
    cancelText: '取消',
    confirmTone: 'danger'
  }
}

/**
 * 删除销售单：有退货 → 禁删说明 10:128；否则影响明细 10:126。
 * @param {object} record
 * @param {object} ctx { customerName, debtBefore, debtAfter, hasReturned, returnCount, docNo, timeText, amount, paidAmount }
 */
function deleteSaleOpts(ctx) {
  ctx = ctx || {}
  if (ctx.hasReturned) {
    const n = ctx.returnCount || 1
    return {
      title: '这张单有退货，不能直接删',
      body: '请先处理名下的退货单，再回来删本单。',
      impactLines: [
        '· 先到退货单的详情页，删除那 ' + n + ' 条退货（退回的货会重新出库）',
        '· 退货删完后回到本单，删除入口恢复可用',
        '· 本单的库存、欠款、实收会在删本单时一并回滚'
      ],
      note: '有退货的销售单不能直接删除。',
      showConfirm: false,
      cancelText: '知道了'
    }
  }

  const who = ctx.customerName || '散客'
  const doc = ctx.docNo || ''
  const time = ctx.timeText || ''
  const amount = moneyYuan(ctx.amount || 0)
  const paid = moneyYuan(ctx.paidAmount || 0)
  const debt = moneyYuan(ctx.debtBefore || 0)
  const head = [time, who + '的销售单', doc].filter(Boolean).join(' ')
  const body = head + '：应收 ' + amount + ' / 实收 ' + paid
    + (ctx.debtBefore > 0 ? ' / 欠 ' + debt : '')
    + '。删除后会连带发生：'

  const lines = ['· 本单商品退回库存']
  if (ctx.debtBefore > 0) {
    lines.push('· 欠款少 ' + moneyYuan(ctx.debtBefore) + ' → ' + moneyYuan(ctx.debtAfter || 0))
  }
  if ((ctx.paidAmount || 0) > 0) {
    lines.push('· 本单实收的现金不退回')
  }

  return {
    title: '删除这张销售单？',
    body: body,
    impactLines: lines,
    note: '删除不可撤销。',
    confirmText: '删除',
    cancelText: '取消',
    confirmTone: 'danger'
  }
}

module.exports = {
  discardOpts: discardOpts,
  removeMemberOpts: removeMemberOpts,
  deleteSaleOpts: deleteSaleOpts,
  moneyYuan: moneyYuan
}
