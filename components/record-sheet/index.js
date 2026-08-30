const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 「选原销售单」翻几页就停：n5 说可退单通常个位数，但「最近 20 条流水」里可能
// 一条可退的都没有（全退完了 / 全是进货收款）。一页拿不到就再翻，最多 3 页，
// 免得一个空列表让人以为没单可退。不做搜索也是 n5 定的：滑动比搜索快。
const ORDER_PAGES = 3
const ORDER_LIMIT = 20
// 下滑关闭的位移门槛（px）。grabber 才挂手势，不挂整张 sheet——picker 那几步
// 列表要滚，挂整张会把滚动吃掉。
const DISMISS_PX = 40

Component({
  options: {
    // **不要加 virtualHost**。开了它页面侧就没有宿主节点，automator 从页面
    // 够不到组件里的任何东西 —— tests/ui.test.js 在 slip-overlay 上实测过：
    // page.$$('.js-slip')、'slip-overlay >>> .js-slip'、selectComponent 全是 0，
    // 那条用例只好改成核对页面 data。面板的状态（step / 三个 picker 的列表）
    // 全在组件自己身上，页面 data 里只有一个 showRecordSheet，退不回去。
    // 宿主节点是空块，面板本体 position: fixed 不占流，加上它不影响任何排版。
    styleIsolation: 'apply-shared'
  },
  properties: {
    show: {
      type: Boolean,
      value: false,
      observer: '_onShowChange'
    }
  },
  data: {
    // main → adjust → product，以及 main → customer / order。
    // 每次打开都从 main 重来，不留上一次停在哪一层。
    step: 'main',
    loading: false,
    customers: [],
    customerKeyword: '',
    debtCount: 0,
    debtTotalText: '0.00',
    orders: [],
    products: [],
    productKeyword: ''
  },
  methods: {
    noop() {},

    _onShowChange(show) {
      if (!show) return
      // 关的时候不重置：关闭有淡出，半路把内容换回 main 会闪一下。
      // 统一在「打开」这一侧重置，效果一样而且看不见。
      this.setData({
        step: 'main',
        loading: false,
        customers: [],
        customerKeyword: '',
        debtCount: 0,
        debtTotalText: '0.00',
        orders: [],
        products: [],
        productKeyword: ''
      })
    },

    // 点遮罩 / 底部「取消」/ grabber 下滑，三条通道同效关闭（设计稿 UX注释/骨架 n-遮罩）
    onClose() {
      this.triggerEvent('close')
    },

    onGrabStart(e) {
      const touch = e.touches && e.touches[0]
      this.grabY = touch ? touch.clientY : 0
      this.grabbed = !!touch
    },

    onGrabMove() {},

    onGrabEnd(e) {
      if (!this.grabbed) return
      this.grabbed = false
      const touch = (e.changedTouches && e.changedTouches[0]) || null
      if (!touch) return
      if (touch.clientY - this.grabY >= DISMISS_PX) this.onClose()
    },

    // 跳完就关：从落点页返回时不该还压着一张面板
    _go(url) {
      this.onClose()
      wx.navigateTo({
        url: url,
        fail: function (error) {
          util.showError(error)
        }
      })
    },

    // 销售和进货现在还是 tabBar 页，只能用 switchTab。
    // **下一批把 tabBar 从 5 个收到 4 个（看板/商品/流水/客户）之后，这两处
    // 必须改成 _go() 走 navigateTo** —— 页面一旦不在 tabBar 里，switchTab 会直接
    // fail，而这是本面板仅有的两个 switchTab。改 app.json 那批请连这里一起改。
    _goTab(url) {
      this.onClose()
      wx.switchTab({
        url: url,
        fail: function (error) {
          util.showError(error)
        }
      })
    },

    onAction(e) {
      const action = e.currentTarget.dataset.action
      if (action === 'sale') return this._goTab('/pages/sale/sale')
      if (action === 'purchase') return this._goTab('/pages/purchase/purchase')
      if (action === 'pay') return this.openCustomerPicker()
      if (action === 'return') return this.openOrderPicker()
      if (action === 'adjust') return this.setData({ step: 'adjust' })
    },

    onAdjustAction(e) {
      const action = e.currentTarget.dataset.action
      // convert 自带商品 picker，无参可进；adjust 必须带 productId，所以先选商品
      if (action === 'convert') return this._go('/pages/convert/convert')
      if (action === 'qty') return this.openProductPicker()
    },

    // ---- 收款：先选客户（只列有欠款），落点 customer-edit 的收款态 ----

    async openCustomerPicker() {
      this.setData({ step: 'customer', loading: true })
      if (!(await store.ready())) {
        this.setData({ loading: false })
        return
      }
      this.refreshCustomers()
    },

    onCustomerSearch(e) {
      this.setData({ customerKeyword: e.detail.value })
      this.refreshCustomers()
    },

    refreshCustomers() {
      const keyword = this.data.customerKeyword
      const all = inventory.sortCustomers(
        inventory.filterCustomers(store.getCustomers(), keyword)
      ).map(function (item) {
        return util.withCustomerView(item, item.account || null)
      }).filter(function (item) {
        // 只列有欠款的（设计稿 n8）。无欠款客户走客户详情记预收，不从这里进。
        return item.hasDebt
      }).sort(function (a, b) {
        return inventory.toNumber(b.receivable) - inventory.toNumber(a.receivable)
      })
      const total = all.reduce(function (sum, item) {
        return sum + inventory.toNumber(item.receivable)
      }, 0)
      this.setData({
        loading: false,
        customers: all,
        debtCount: all.length,
        debtTotalText: util.money(total)
      })
    },

    onPickCustomer(e) {
      this._go('/pages/customer-edit/customer-edit?id=' + e.currentTarget.dataset.id + '&pay=1')
    },

    // ---- 退货：先选原销售单，不开空白退货单（设计稿 n5）----

    async openOrderPicker() {
      this.setData({ step: 'order', loading: true, orders: [] })
      if (!(await store.ready())) {
        this.setData({ loading: false })
        return
      }
      const token = (this.orderToken || 0) + 1
      this.orderToken = token
      const rows = []
      let cursor = ''
      try {
        for (let page = 0; page < ORDER_PAGES; page++) {
          const res = await store.listRecords({ type: 'out', cursor: cursor, limit: ORDER_LIMIT })
          if (token !== this.orderToken) return
          res.records.forEach(function (record) {
            const lines = inventory.recordLines(record)
            const remain = inventory.round2(lines.reduce(function (sum, line) {
              return sum + inventory.returnableQty(line)
            }, 0))
            if (!(remain > 0)) return
            const view = util.withRecordView(record)
            // 退过一部分才标件数；从未退过只说「未退过」（n5 明写不标件数）
            const returned = lines.some(function (line) {
              return inventory.toNumber(line.returnedQty) > 0
            })
            rows.push({
              id: record.id,
              customerText: view.customerName || record.customerName || '散客',
              // 单号走 util.formatDocNo（CK<年月日>-<id 末四位>）——record.id 是不透明
              // 存储 id，直接印出来店主认不出。稿上样张写的是 S20260825-014，那个
              // 编号体系代码里不存在，这里用全站在用的 docNo（送货单印的也是它）。
              subText: view.timeText + ' · 销售单 ' + util.formatDocNo(record),
              returnText: view.productName + ' · ' + (returned ? '可退 ' + remain + ' 件' : '未退过'),
              amountText: view.amountText
            })
          })
          // 本页为空时服务端回 ''，直接赋值会把游标冲回开头、从第一页重来
          cursor = res.cursor || cursor
          if (!res.hasMore) break
        }
      } catch (error) {
        if (token === this.orderToken) {
          this.setData({ loading: false })
          util.showError(error)
        }
        return
      }
      if (token !== this.orderToken) return
      this.setData({ loading: false, orders: rows })
    },

    onPickOrder(e) {
      this._go('/pages/sale-return/sale-return?id=' + e.currentTarget.dataset.id)
    },

    // ---- 库存修正 › 数量对不上：先选商品，落点 adjust 必须带 productId ----

    async openProductPicker() {
      this.setData({ step: 'product', loading: true })
      if (!(await store.ready())) {
        this.setData({ loading: false })
        return
      }
      this.refreshProducts()
    },

    onProductSearch(e) {
      this.setData({ productKeyword: e.detail.value })
      this.refreshProducts()
    },

    refreshProducts() {
      const skus = store.getSkus()
      const list = inventory.filterProducts(store.getProducts(), this.data.productKeyword, skus)
        .map(function (item) {
          return {
            id: item.id,
            name: item.name,
            stockText: String(inventory.productStockFromSkus(skus, item.id))
          }
        })
      this.setData({ loading: false, products: list })
    },

    onPickProduct(e) {
      this._go('/pages/adjust/adjust?id=' + e.currentTarget.dataset.id)
    }
  }
})
