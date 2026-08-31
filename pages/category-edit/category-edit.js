const store = require('../../utils/store')
const util = require('../../utils/util')

// 删除确认的红。wx.showModal 的 confirmColor 只吃颜色字面量，读不到 app.wxss 里的
// var(--color-red-600)。值 = 稿 red/600 也就是节点 4:643 绑的那枚变量 3:37 = #DB2626。
// 改版前写的是 #DC2626，与稿差一个色阶，本批顺手对齐。
const DANGER_RED = '#DB2626'

function axisLabel(value, fallback) {
  const name = String(value || '').trim()
  return name || fallback
}

Page({
  // 【不要往这个 data 里加 pageLoading】tests/automator-contract.test.js 的
  // NO_PAGE_LOADING 名单钉着本页没有它。
  //
  // productKind 与 hasSpecs 是**推导出来的镜像**，不是开关（见下面 withKind 的注释）；
  // adding 是「哪一组的『＋ 添加』正变成输入框」，空串 = 三组都没在输入。
  data: {
    id: '',
    isEdit: false,
    name: '',
    names: [],
    nameInput: '',
    specAxis1: '',
    specAxis2: '',
    colors: [],
    sizes: [],
    colorInput: '',
    sizeInput: '',
    adding: '',
    blankPool: false,
    sharedPrice: true,
    hasSpecs: false,
    productKind: 'plain'
  },

  async onLoad(query) {
    if (!(await store.ready())) return
    if (!query.id) {
      this.setData(this.withKind({}))
      wx.setNavigationBarTitle({ title: '新增种类' })
      return
    }
    const category = store.getCategory(query.id)
    if (!category) {
      wx.showToast({ title: '种类不存在', icon: 'none' })
      return
    }
    this.setData(this.withKind({
      id: category.id,
      isEdit: true,
      name: category.name,
      names: category.names || [],
      specAxis1: category.specAxis1 || '',
      specAxis2: category.specAxis2 || '',
      colors: category.colors || [],
      sizes: category.sizes || [],
      blankPool: category.productKind === 'blank',
      sharedPrice: category.sharedPrice !== false
    }))
    wx.setNavigationBarTitle({ title: '编辑种类' })
  },

  // 稿 Screen/16 上没有「默认商品类型」这个分段开关，只有「默认带半成品池」一枚开关
  // （稿 4:633 的 col/半成品池开关 9:84）。所以 productKind 不再由人直接选，而是推出来的：
  //     没有规格取值            -> plain
  //     有规格取值 + 池子开着   -> blank
  //     有规格取值 + 池子关着   -> finished
  // 这与 pages/product-edit 的 save() 里 blankProcess = hasSpecs && blankPool 同源
  // （那一屏同样没有 productKind 开关），也与 utils/inventory.js 的 normalizeProductKind
  // 一致。推导之后 createCategory 那句「请添加规格」的条件恒假，永远触发不了 ——
  // 「只填名字存不下去」这个老坑从根上没了。
  //
  // 本函数是 productKind/hasSpecs 唯一的推导入口，colors/sizes/blankPool 的每一处
  // 写入（onLoad 新建&编辑分支、commitColor/commitSize、removeColor/removeSize、
  // toggleBlank）都过它，save() 直接读它维护的 data 镜像，不再另算一遍。
  withKind(patch) {
    const colors = patch.colors != null ? patch.colors : this.data.colors
    const sizes = patch.sizes != null ? patch.sizes : this.data.sizes
    const blankPool = patch.blankPool != null ? patch.blankPool : this.data.blankPool
    const hasSpecs = !!(colors.length || sizes.length)
    patch.hasSpecs = hasSpecs
    patch.productKind = hasSpecs ? (blankPool ? 'blank' : 'finished') : 'plain'
    return patch
  },

  onField(e) {
    const patch = {}
    patch[e.currentTarget.dataset.field] = e.detail.value
    this.setData(patch)
  },

  toggleBlank() {
    this.setData(this.withKind({ blankPool: !this.data.blankPool }))
  },

  toggleShared() {
    this.setData({ sharedPrice: !this.data.sharedPrice })
  },

  // 点「＋ 添加」：那一组的 chip 原位换成一枚聚焦的输入框（稿 n1 4:646）。
  // 顺手清掉上一次留下的草稿，免得第二次点开时里面还有字。
  startAdd(e) {
    const field = e.currentTarget.dataset.add
    const patch = { adding: field }
    if (field === 'name') patch.nameInput = ''
    if (field === 'color') patch.colorInput = ''
    if (field === 'size') patch.sizeInput = ''
    this.setData(patch)
  },

  // 回车 / 失焦生成 chip。confirm 之后系统会紧接着再触发一次 blur，两个事件绑的是同一个
  // 方法；setData 对 this.data 是**同步**生效的，所以第一次进来把 adding 清空之后，
  // 第二次进来在第一行直接 return，不会重复添加、也不会重复弹「已有这个名称」。
  // 写法与 pages/product-edit 的 commitSpec 同源。
  // 空着走开 = 取消，不弹提示：输入框是点出来的，不填就是不加，不是错误。
  commitName() {
    if (this.data.adding !== 'name') return
    const value = String(this.data.nameInput || '').trim()
    this.setData({ adding: '', nameInput: '' })
    if (!value) return
    if (this.data.names.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个名称', icon: 'none' })
      return
    }
    this.setData({ names: this.data.names.concat([value]) })
  },

  commitColor() {
    if (this.data.adding !== 'color') return
    const value = String(this.data.colorInput || '').trim()
    this.setData({ adding: '', colorInput: '' })
    if (!value) return
    if (this.data.colors.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个' + axisLabel(this.data.specAxis1, '规格一'), icon: 'none' })
      return
    }
    this.setData(this.withKind({ colors: this.data.colors.concat([value]) }))
  },

  commitSize() {
    if (this.data.adding !== 'size') return
    const value = String(this.data.sizeInput || '').trim()
    this.setData({ adding: '', sizeInput: '' })
    if (!value) return
    if (this.data.sizes.indexOf(value) >= 0) {
      wx.showToast({ title: '已有这个' + axisLabel(this.data.specAxis2, '规格二'), icon: 'none' })
      return
    }
    this.setData(this.withKind({ sizes: this.data.sizes.concat([value]) }))
  },

  removeName(e) {
    const value = e.currentTarget.dataset.value
    this.setData({
      names: this.data.names.filter(function (item) {
        return item !== value
      })
    })
  },

  // 删掉最后一个取值会把种类推回 plain，所以这两个走 withKind，removeName 不用。
  removeColor(e) {
    const value = e.currentTarget.dataset.value
    this.setData(this.withKind({
      colors: this.data.colors.filter(function (item) {
        return item !== value
      })
    }))
  },

  removeSize(e) {
    const value = e.currentTarget.dataset.value
    this.setData(this.withKind({
      sizes: this.data.sizes.filter(function (item) {
        return item !== value
      })
    }))
  },

  async save() {
    try {
      // 落盘的 productKind 直接读 withKind 维护的镜像，不再另算一遍——
      // colors/sizes/blankPool 的每一个写入点都过 withKind（见上面的注释和
      // onLoad 新建分支的 withKind({})），镜像不会失效，两份公式会漂但没人测，
      // 合成一份才让 tests/ui.test.js 那条「新建默认推成 plain」的断言真的挡得住东西。
      const hasSpecs = this.data.hasSpecs
      await store.saveCategory({
        id: this.data.id,
        name: this.data.name,
        names: this.data.names,
        productKind: this.data.productKind,
        sharedPrice: this.data.sharedPrice,
        specAxis1: hasSpecs ? this.data.specAxis1 : '',
        specAxis2: hasSpecs ? this.data.specAxis2 : '',
        colors: hasSpecs ? this.data.colors : [],
        sizes: hasSpecs ? this.data.sizes : []
      })
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      util.showError(error)
    }
  },

  // 【删模板不动任何已建商品，这是代码事实不是承诺】
  //   · utils/inventory.js 的 createProduct 返回的 17 个键里没有 categoryId，
  //     updateProduct 走同一个构造函数，同样没有；
  //   · pages/product-edit 的 save() payload 里也没有这个键；
  //   · 全仓 categoryId 只在 pages/product-edit 里出现，是建档会话里的游标，不落盘；
  //   · 套模板是把 names / 轴名 / 取值 / sharedPrice **复制**进建档页，不是引用；
  //   · cloudfunctions/ledger/ledger-apply.js 的 deleteCategory 分支只有三行，
  //     只 filter 掉 next.categories 这一条，products / skus / records 一个字都不碰。
  // 所以文案里「已经建好的商品不会动」是事实，**不需要数「N 个商品在用」，也数不出来**
  // （那个数恒为零）。删掉之后唯一的真实损失是「新建商品时少一组待选项」，写在第二句。
  //
  // 危险视觉因此落在三级里最轻的一档（红字链，稿 4:643），确认只做一层
  // （稿 n3 4:648 逐字「删除模板 danger 红 + 二次确认」，没有「输入名字确认」那半句）。
  remove() {
    wx.showModal({
      title: '删除种类「' + (this.data.name || '未命名种类') + '」？',
      content: '只删模板，已经建好的商品不会动。删掉之后，新建商品时少一组待选项。',
      confirmText: '删除',
      confirmColor: DANGER_RED,
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteCategory(this.data.id)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(function () {
            wx.navigateBack()
          }, 400)
        } catch (error) {
          util.showError(error)
        }
      }
    })
  }
})
