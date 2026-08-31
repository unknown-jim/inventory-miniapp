const store = require('../../utils/store')
const util = require('../../utils/util')
const inventory = require('../../utils/inventory')

// 客户编辑 / 新增。设计稿 Screen/09b 客户编辑 4:1116、变体/名称空底栏 13:395、
// caption 9:56。B9 起本页只剩「一张表单」这一件事：
// 欠款卡、往来记录、收款 / 记期初两枚 sheet 全部搬去 pages/customer-detail。
//
// 三个入口：
//   pages/customers/customers.js:goAdd              无参 = 新增
//   pages/sale/sale.js / pages/record-edit          ?select=1  新增并回选
//   pages/customer-detail/customer-detail.js:goEdit ?id=<客户id>  编辑
Page({
  data: {
    id: '',
    isEdit: false,
    name: '',
    phone: '',
    address: '',
    remark: '',
    canSave: false,
    saving: false,
    canDelete: false,
    deleteNote: ''
  },

  onLoad(query) {
    this.selectAfterSave = query.select === '1'
    if (!query.id) {
      wx.setNavigationBarTitle({ title: '新增客户' })
      return
    }
    this.setData({ id: query.id, isEdit: true })
    wx.setNavigationBarTitle({ title: '编辑客户' })
  },

  async onShow() {
    if (!this.data.id) return
    if (!(await store.ready())) return
    this.fillCustomer(this.data.id)
  },

  fillCustomer(id) {
    const customer = store.getCustomer(id)
    if (!customer) {
      wx.showToast({ title: '客户不存在', icon: 'none' })
      return
    }
    // accountOf(null) 是「空账户」构造器，是 tests/no-client-cloud-db.test.js
    // 明文放行的唯一用法。
    const account = customer.account || inventory.accountOf(null)
    // 稿注释 4:411：「删除客户限制：有往来记录不可删，仅无记录客户可删（danger 二次确认）」；
    // caption 9:52：「置为不可点并说明原因，**不要点了才报错**」。
    // 服务端 deleteCustomer 现在是**软删除**（utils/ledger-apply.js 的
    // deleteCustomer 分支）：打 archived 标记而不真删，还欠钱 / 存着预收的
    // 客户照样留在列表上，所以钱不会因为删客户而从界面上蒸发。
    // 这道客户端闸比服务端更严（有任何往来就不可删），保留它是为了满足
    // caption 9:52「置为不可点并说明原因，**不要点了才报错**」。
    // 仍然 fail-safe：判不出来就当成不可删。
    // 判据用已经在手的 account 六项，不额外发请求（理由见规格 §5.7）。
    const hasLedger = inventory.toNumber(account.count) > 0
      || inventory.round2(account.amount) !== 0
      || inventory.round2(account.creditAmount) !== 0
      || inventory.round2(account.paidAmount) !== 0
      || inventory.round2(account.receivable) !== 0
      || inventory.round2(account.prepay) !== 0
    this.setData({
      id: customer.id,
      isEdit: true,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      remark: customer.remark,
      canSave: !!String(customer.name || '').trim(),
      canDelete: !hasLedger,
      // 稿 note 4:1135 少了条数：条数要翻完全部分页才数得出来，
      // 为一句提示语发 N 次云调用不值（规格 §6-8）。
      deleteNote: hasLedger
        ? (customer.name + '有往来记录，不能删。只有从没记过账的客户可以删。')
        : ''
    })
  },

  onField(e) {
    const patch = {}
    const field = e.currentTarget.dataset.field
    patch[field] = e.detail.value
    // 稿 13:395 变体：名称为空 ⇒ 保存钮禁用
    if (field === 'name') patch.canSave = !!String(e.detail.value || '').trim()
    this.setData(patch)
  },

  async save() {
    if (!this.data.canSave || this.data.saving) return
    this.setData({ saving: true })
    try {
      const saved = await store.saveCustomer({
        id: this.data.id,
        name: this.data.name,
        phone: this.data.phone,
        address: this.data.address,
        remark: this.data.remark
      })
      if (this.selectAfterSave) {
        getApp().setSelectedCustomer(saved.id)
      }
      // 成功之后**不复位 saving**：页面正在退出，复位只会给连点留一个窗口
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(function () {
        wx.navigateBack()
      }, 400)
    } catch (error) {
      this.setData({ saving: false })
      util.showError(error)
    }
  },

  remove() {
    // 不可删时按钮压根不渲染；这一句是防御，不是判据
    if (!this.data.canDelete) return
    wx.showModal({
      title: '删除客户',
      content: '「' + this.data.name + '」从没记过账，删掉不影响任何流水。删了不能撤销。',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await store.deleteCustomer(this.data.id)
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
