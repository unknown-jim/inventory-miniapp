const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 盘点模式。设计稿 Screen/02b 盘点模式 4:893、Screen/02c 盘点·键盘弹起 7:170、
// UX注释/盘点模式 4:921。入口：记一笔面板 -> 库存修正 -> 盘一遍这个商品（先选商品）。
//
// 作用域是**一个商品**（稿 n3）：把这个商品的每一格账面数一起带出来，只改对不上的
// 那几格，一条确认。它和 pages/adjust 不是一张皮 —— 那一页是「一格 + 原因」，
// 这一页是「所有格一起对」。两个入口在稿上并存，不要合并。
//
// 记账规矩（docs/accounting-vs-policy.md）：库存调整只改件数，不计入进货、销售、
// 毛利和欠款，也不改进价。本页的写操作只有 store.addAdjust 一个，账法全在
// utils/inventory.js 的 applyAdjust 里，这里一条流水都不自己拼。

// 实点数的解析。返回 null = 这一格**没碰过**，按零差异处理。
//
// 【空框绝不能当成 0 件】把空框读成 0，店主随手删掉一格就会把那一格库存悄悄清零，
// 而且屏上看起来「我什么都没干」。要盘成 0 件必须真的打一个 0。
//
// 只收 0 和正数、最多两位小数：实点是「数出来有几件」，没有负数这一档；两位小数
// 是全仓的量纲（inventory.round2）。type="digit" 的键盘本来也打不出负号。
function parseTake(text) {
  const raw = String(text == null ? '' : text).trim()
  if (!raw) return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null
  return Number(raw)
}

// 行尾的差值。稿 4:931 是 12px Inter SemiBold 的「−3」；本仓用 ASCII 的 + / -
// （规格「与稿的已知偏差」第 3 条）。零差异不出字，但格子仍占位，
// 免得输入框随差值位数左右跳。
function diffTextOf(diff) {
  if (!diff) return ''
  return (diff > 0 ? '+' : '-') + Math.abs(diff)
}

Page({
  data: {
    pageLoading: true,
    // `store.readyOrFailure()` 失败时屏上留的错误卡（稿 state/error 3:759 /
    // state/error/blocking（不可重试）4:1041）。`loadErrorText` 空串 = 没出错。
    // 可重试与不可重试是**两种**错误态，不可重试的那种不给重试按钮
    //（docs/ui-scale.md「新页面要」第 5 条）。三句话都由 store 给，本页不自己写。
    loadErrorTitle: '',
    loadErrorText: '',
    loadErrorRetry: false,
    productId: '',
    productName: '',
    rows: [],
    diffCount: 0,
    submitting: false,
    // 键盘高度（px）。>0 时整屏高度缩成 calc(100vh - kbPx px)：底部黑块跟着浮到
    // 键盘之上、列表区（flex:1 的 scroll-view）被动压缩且仍可滚。这就是稿 caption
    // 7:169 说的「底部黑块随键盘上浮，列表区压缩可滚（盘点验收硬依赖）」。
    // 之所以不能靠 adjust-position：那个默认值顶的是页面内容，而底栏是跟着视口走的，
    // 顶完照样被键盘盖住。
    kbPx: 0,
    scrollIntoId: ''
  },

  onLoad(query) {
    const id = query && query.id
    if (!id) {
      wx.showToast({ title: '请从库存修正进入', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
      return
    }
    this.pendingId = id
    // 基础库 2.7.0 起才有（project.config.json 的 libVersion 是 3.8.0）。取不到就
    // 让 kbPx 恒为 0，退化成「底栏被键盘盖住」—— 和本仓其它页面今天的表现一样。
    // 不退回 input 的 bindkeyboardheightchange：那个事件拿不到「键盘收起」。
    if (typeof wx.onKeyboardHeightChange === 'function') {
      this.kbHandler = (res) => {
        this.setData({ kbPx: Math.max(0, Math.round((res && res.height) || 0)) })
      }
      wx.onKeyboardHeightChange(this.kbHandler)
    }
  },

  onUnload() {
    if (this.kbHandler && typeof wx.offKeyboardHeightChange === 'function') {
      wx.offKeyboardHeightChange(this.kbHandler)
    }
    this.kbHandler = null
  },

  // **只在第一次读到账本时装数据。** 这一页的输入框是店主一格一格数出来的，
  // 每次 onShow 重载会把数了一半的结果冲掉。装过一次就不再动，退出重进才重带账面。
  async onShow() {
    // 上一轮的错误卡先收掉：onShow 每次都跑，留着它会盖在这次取回来的数据上。
    if (this.data.loadErrorText) this.setData({ loadErrorTitle: '', loadErrorText: '', loadErrorRetry: false })
    if (!store.isReady()) this.setData({ pageLoading: true })
    // `ready()` 只说「不行」；`readyOrFailure()` 还说为什么 —— 没选店 / 被移出店铺
    // 那一类点重试不会好，对它们写「检查网络后重试」是错的诊断。文案与看板的阻断卡
    // 同源，取舍写在 utils/store.js 的 readyOrFailure 上。报错仍然只报一次：
    // showError 在 store 里已经报过，这里只负责别把屏留成一张空列表。
    const failure = await store.readyOrFailure()
    if (failure) {
      this.setData({
        pageLoading: false,
        loadErrorTitle: failure.title,
        loadErrorText: failure.text,
        loadErrorRetry: failure.retryable
      })
      return
    }
    const id = this.pendingId
    if (!id) {
      this.setData({ pageLoading: false })
      return
    }
    this.pendingId = ''
    this.loadProduct(id)
  },

  // 错误卡上那枚「重试」。整条 onShow 重走一遍，不另开一条加载路径 —— 另开一条就
  // 会有「重试成功了但页面没按 onShow 的样子装好」这种两说。
  reload() {
    return this.onShow()
  },

  // 行的取法与 pages/product-detail 的 stockRowsOf 同源，判据一个字都不新造：
  // 半成品池的件数在 isBlank 的那条 sku 上（findBlankSku），成品格各是一条 sku，
  // 无规格商品只有商品记录上的一格。utils/util.js 的 lowStockRows 用的是同一套。
  // 顺序按稿 card/盘点行 4:899：半成品排最上，其余成品格按 sku 顺序。
  rowsOf(product, skus) {
    if (!inventory.productHasSpecs(product)) {
      return [{
        key: 'product',
        skuId: '',
        blank: false,
        label: '库存',
        bookQty: inventory.toNumber(product.stock)
      }]
    }
    const rows = []
    if (inventory.isBlankProcess(product)) {
      const blank = inventory.findBlankSku(skus, product.id)
      if (blank) {
        rows.push({
          key: blank.id,
          skuId: blank.id,
          blank: true,
          // 稿 4:901 的行名是「半成品」，入口那一屏 pages/product-detail 也叫半成品。
          // inventory.blankStockLabel() 返回的是「待加工」；两套叫法的分工由改稿批
          // 统一（B3 规格 OQ-6 已登记），本页跟着入口那一屏走。
          label: '半成品',
          bookQty: inventory.toNumber(blank.stock)
        })
      }
    }
    skus.forEach(function (item) {
      if (item.isBlank) return
      rows.push({
        key: item.id,
        skuId: item.id,
        blank: false,
        label: inventory.specText(item.color, item.size),
        bookQty: inventory.toNumber(item.stock)
      })
    })
    return rows
  },

  // 把每行的 input 折成 diff / diffText / changed，并数出差异处数。纯计算。
  foldRows(rows) {
    let count = 0
    const next = rows.map(function (row) {
      const taken = parseTake(row.input)
      const diff = taken === null ? 0 : inventory.round2(taken - row.bookQty)
      if (diff) count += 1
      return Object.assign({}, row, {
        diff: diff,
        diffText: diffTextOf(diff),
        changed: !!diff
      })
    })
    return { rows: next, diffCount: count }
  },

  loadProduct(id) {
    const product = store.getProduct(id)
    if (!product) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
      return
    }
    const skus = store.getSkusByProduct(product.id)
    // 稿 navbar 4:895 的标题是「盘点 · 纯棉四件套」。原生导航栏只改文字不改形态
    // （docs/ui-scale.md：不要改原生导航栏 / tabBar）。
    wx.setNavigationBarTitle({ title: '盘点 · ' + product.name })
    // 账面数自动带出（稿 n1）：输入框预填账面，没动过的行差异恒为 0。
    const rows = this.rowsOf(product, skus).map(function (row) {
      return Object.assign({}, row, {
        bookText: '账面 ' + row.bookQty,
        input: String(row.bookQty)
      })
    })
    const folded = this.foldRows(rows)
    this.setData({
      pageLoading: false,
      productId: product.id,
      productName: product.name,
      rows: folded.rows,
      diffCount: folded.diffCount
    })
  },

  onQtyInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const rows = this.data.rows.slice()
    if (!rows[index]) return
    rows[index] = Object.assign({}, rows[index], { input: e.detail.value })
    const folded = this.foldRows(rows)
    this.setData({ rows: folded.rows, diffCount: folded.diffCount })
  },

  // 键盘弹起后列表区被压缩，靠下的行会掉出可视区。聚焦时把这一行滚进来，
  // 否则店主看不见自己在往哪一格填。稿上**没有**焦点行高亮（02b 与 02c 的
  // amber 底出现在同一行，那是差异高亮不是焦点高亮），所以只滚不上色。
  onQtyFocus(e) {
    this.setData({ scrollIntoId: 'take-row-' + Number(e.currentTarget.dataset.index) })
  },

  // 稿 n5：退出与「确认调整」并排，退出后回上一页。这里不做「有差异先确认」的
  // 二次弹窗 —— 原生返回箭头拦不住（小程序没有可取消的返回钩子），只拦一半的
  // 保护比不拦更容易让人误以为有保护。
  exit() {
    if (this.data.submitting) return
    wx.navigateBack()
  },

  // 部分成功之后重新对账面：已经记上的那几格差异会自动归零，没记上的仍留着店主
  // 填的实点数。再点一次「确认调整」只会补记剩下的那几条。
  refreshBook() {
    const product = store.getProduct(this.data.productId)
    if (!product) return
    const fresh = this.rowsOf(product, store.getSkusByProduct(product.id))
    const rows = this.data.rows.map(function (row) {
      const hit = fresh.find(function (item) {
        return item.key === row.key
      })
      if (!hit) return row
      return Object.assign({}, row, {
        bookQty: hit.bookQty,
        bookText: '账面 ' + hit.bookQty
      })
    })
    const folded = this.foldRows(rows)
    this.setData({ rows: folded.rows, diffCount: folded.diffCount })
  },

  // 稿 toast/盘点完成 10:206：「已盘点 · 白色/2.0m 8 → 5 件」。
  // 一处差异照抄这个形状；多处只报处数 —— 三四条规格名拼进一条 toast 会被真机腰斩。
  doneToast(jobs) {
    if (jobs.length === 1) {
      const job = jobs[0]
      return '已盘点 · ' + job.label + ' ' + job.bookQty + ' → '
        + inventory.round2(job.bookQty + job.diff) + ' 件'
    }
    return '已盘点 · ' + jobs.length + ' 处差异已调整'
  },

  // 一个差异规格 = 一条 adjust 流水（稿 n1）。addAdjust 一次只吃一条，所以这里
  // 串行发 N 次；没有批量口，第一条失败就停，已记上的不回滚（也回滚不了）。
  // 需要「一次事务写 N 条」的批量 action 是后端契约变更，登记在规格 OQ-2。
  async submit() {
    if (this.data.submitting) return
    const rows = this.data.rows
    // 填了字却解析不出数，不能当成「没碰过」静默跳过 —— 那是最难发现的一类错。
    const bad = rows.find(function (row) {
      return String(row.input == null ? '' : row.input).trim() !== '' && parseTake(row.input) === null
    })
    if (bad) {
      wx.showToast({ title: bad.label + '：实点数只能填 0 或正数，最多两位小数', icon: 'none' })
      return
    }
    const jobs = rows.filter(function (row) {
      return !!row.diff
    })
    if (!jobs.length) return
    const productId = this.data.productId
    this.setData({ submitting: true })
    let done = 0
    try {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]
        const payload = {
          productId: productId,
          direction: job.diff > 0 ? 'in' : 'out',
          // 服务端的原因白名单（inventory.adjustReasons）里没有「盘点」这一档，
          // 盘盈 / 盘亏正是它现成的两个值，语义逐字对上。稿 n1 要的独立「盘点」
          // 原因要改两份镜像的白名单，是后端契约变更，登记在规格 OQ-1。
          reason: job.diff > 0 ? 'surplus' : 'shortage',
          qty: Math.abs(job.diff),
          remark: ''
        }
        if (job.skuId) payload.skuId = job.skuId
        await store.addAdjust(payload)
        done += 1
      }
    } catch (error) {
      // 前 done 条已经记上了，**不能**说「没记上」：那会让店主照着提示再点一遍，
      // 账就记两遍。改成如实说记上了几条，并把账面重新对一遍。
      console.warn('[stock-take] 分条提交中断，已记 ' + done + '/' + jobs.length, error)
      this.setData({ submitting: false })
      this.refreshBook()
      if (done > 0) {
        wx.showModal({
          title: '只记上了一部分',
          content: '已记 ' + done + ' 处，还有 ' + (jobs.length - done)
            + ' 处没记上。页面上的账面数已经按最新账本对过，再点一次「确认调整」只补记剩下的。',
          showCancel: false,
          confirmText: '知道了'
        })
      } else {
        util.showError(error)
      }
      return
    }
    this.setData({ submitting: false })
    wx.showToast({ title: this.doneToast(jobs), icon: 'none' })
    setTimeout(function () {
      wx.navigateBack()
    }, 400)
  }
})
