const assert = require('assert')
const fs = require('fs')
const path = require('path')

let automator
try {
  automator = require('miniprogram-automator')
} catch (error) {
  console.error('未安装 miniprogram-automator。请先安装 Node.js，然后在仓库根目录执行 npm install')
  process.exit(1)
}

const projectPath = path.join(__dirname, '..')

function resolveCliPath() {
  if (process.env.WECHAT_CLI && fs.existsSync(process.env.WECHAT_CLI)) {
    return process.env.WECHAT_CLI
  }
  const roots = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent')
  ]
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]
    if (!fs.existsSync(root)) continue
    const names = fs.readdirSync(root)
    for (let j = 0; j < names.length; j++) {
      const cli = path.join(root, names[j], 'cli.bat')
      if (fs.existsSync(cli)) return cli
    }
  }
  return ''
}

function step(name) {
  console.log('[UI] ' + name)
}

async function tap(page, selector) {
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到可点击元素: ' + selector)
  }
  await el.tap()
}

async function tapWhen(page, selector) {
  await page.waitFor(selector)
  await tap(page, selector)
}

async function waitGone(page, selector) {
  await page.waitFor(async function () {
    const list = await page.$$(selector)
    return list.length === 0
  })
}

async function textOf(page, selector) {
  await page.waitFor(selector)
  const el = await page.$(selector)
  if (!el) {
    throw new Error('找不到文本元素: ' + selector)
  }
  return el.text()
}

async function resetStorage(miniProgram) {
  // 注入内存账本：同一套 inventory.js，不连真实云。
  await miniProgram.evaluate(function () {
    wx.setStorageSync('inv_test_memory_ledger', true)
    wx.setStorageSync('inv_shop_id', 'ui-test-shop')
    wx.setStorageSync('inv_shop_name', '测试店')
    wx.setStorageSync('inv_products', [])
    wx.setStorageSync('inv_records', [])
    wx.setStorageSync('inv_customers', [])
    wx.setStorageSync('inv_skus', [])
    wx.setStorageSync('inv_categories', [])
    wx.setStorageSync('inv_revision', 0)
    wx.setStorageSync('inv_local_snapshot_done', true)
  })
}

async function waitPageReady(page) {
  await page.waitFor(async function () {
    const data = await page.data()
    return data && data.pageLoading === false
  })
}

async function seedFromHome(miniProgram) {
  step('清空本地数据并点「填充示例数据」')
  await resetStorage(miniProgram)
  const home = await miniProgram.reLaunch('/pages/index/index')
  await waitPageReady(home)
  await home.waitFor('.js-seed')
  await tap(home, '.js-seed')
  await home.waitFor(async function () {
    const data = await home.data()
    return data && data.isEmpty === false
  })
  return home
}

async function runSalePickerAndSlip(miniProgram) {
  step('销售：点选商品、客户，赊账出库，核对送货单')
  const sale = await miniProgram.switchTab('/pages/sale/sale')
  await waitPageReady(sale)
  await sale.waitFor('.js-product-picker')

  await tap(sale, '.js-product-picker')
  await sale.waitFor('.js-product-item')
  const products = await sale.$$('.js-product-item')
  assert.ok(products.length > 0, '商品点选列表为空')
  await products[0].tap()
  await waitGone(sale, '.js-product-item')

  await tapWhen(sale, '.js-customer-picker')
  await sale.waitFor('.js-customer-item')
  const customers = await sale.$$('.js-customer-item')
  assert.ok(customers.length > 0, '客户点选列表为空')
  await customers[0].tap()
  await waitGone(sale, '.js-customer-item')

  await tapWhen(sale, '.js-pay-credit')
  await sale.waitFor(200)
  const afterPayType = await sale.data('payType')
  assert.strictEqual(afterPayType, 'credit')

  const qty = await sale.$('.js-qty')
  if (!qty) {
    throw new Error('找不到数量输入框')
  }
  await qty.input('1')
  await tapWhen(sale, '.js-add-cart')
  await sale.waitFor(async function () {
    const data = await sale.data()
    return data && data.cart && data.cart.length > 0
  })

  await tapWhen(sale, '.js-sale-submit')
  await sale.waitFor('.js-slip')

  const title = await textOf(sale, '.js-slip-title')
  assert.ok(title.indexOf('送货单') >= 0, '送货单标题不对: ' + title)
  const productName = await textOf(sale, '.js-slip-product')
  assert.ok(productName.length > 0, '送货单没有商品名')
  const customerName = await textOf(sale, '.js-slip-customer')
  assert.ok(customerName.length > 0, '送货单没有收货人')
  const payText = await textOf(sale, '.js-slip-pay')
  assert.strictEqual(payText.replace(/\s/g, ''), '赊账')
  const shopName = await textOf(sale, '.js-slip-shop')
  assert.ok(shopName.indexOf('测试店') >= 0, '送货单没有店名: ' + shopName)
  const operator = await textOf(sale, '.js-slip-operator')
  assert.ok(operator.indexOf('测试店主') >= 0, '送货单没有经手人: ' + operator)
  assert.ok(operator.indexOf('ui-test-openid') < 0, '送货单不应印 openid: ' + operator)

  await tap(sale, '.js-slip-close')
  await waitGone(sale, '.js-slip')
}

async function runRecordSlipExport(miniProgram) {
  step('流水：打开销售记录，默认只读，再次打开送货单')
  const records = await miniProgram.navigateTo('/pages/records/records')
  await records.waitFor('.js-record-out')
  const items = await records.$$('.js-record-out')
  assert.ok(items.length > 0, '流水里没有销售记录')
  await items[0].tap()

  await records.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('record-edit') >= 0, '未进入流水详情: ' + edit.path)
  await edit.waitFor('.js-edit')
  let pageData = await edit.data()
  assert.strictEqual(pageData.editing, false, '进入详情就进入了修改')
  const saveBefore = await edit.$$('.js-save')
  assert.strictEqual(saveBefore.length, 0, '未点修改就出现了保存')
  await edit.waitFor('.js-export-slip')
  await tap(edit, '.js-export-slip')
  await edit.waitFor('.js-slip')
  const title = await textOf(edit, '.js-slip-title')
  assert.ok(title.indexOf('送货单') >= 0, '再次导出时送货单标题不对: ' + title)
  const shopName = await textOf(edit, '.js-slip-shop')
  assert.ok(shopName.indexOf('测试店') >= 0, '再次导出没有店名: ' + shopName)
  const operator = await textOf(edit, '.js-slip-operator')
  assert.ok(operator.indexOf('测试店主') >= 0, '再次导出没有经手人: ' + operator)
  assert.ok(operator.indexOf('ui-test-openid') < 0, '再次导出不应印 openid: ' + operator)
  await tap(edit, '.js-slip-close')
  await waitGone(edit, '.js-slip')

  step('流水：点修改后才能保存，取消回到详情')
  await tap(edit, '.js-edit')
  await edit.waitFor('.js-save')
  pageData = await edit.data()
  assert.strictEqual(pageData.editing, true, '点修改后仍不能改')
  await tap(edit, '.js-cancel')
  await edit.waitFor('.js-edit')
  pageData = await edit.data()
  assert.strictEqual(pageData.editing, false, '取消后没有回到详情')
  await miniProgram.navigateBack()
}

async function runOpeningSheet(miniProgram) {
  step('客户页：记期初欠款，弹出层并确认')
  const list = await miniProgram.switchTab('/pages/customers/customers')
  await list.waitFor('.js-customer-item')
  await tap(list, '.js-customer-item')

  await list.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('customer-edit') >= 0, '未进入客户编辑页: ' + edit.path)
  await edit.waitFor('.js-opening')
  await tapWhen(edit, '.js-opening')
  await edit.waitFor('.js-opening-sheet')
  const amount = await edit.$('.js-opening-amount')
  if (!amount) {
    throw new Error('找不到期初欠款金额输入框')
  }
  await amount.input('20')
  await tapWhen(edit, '.js-opening-submit')
  await waitGone(edit, '.js-opening-sheet')
  await miniProgram.navigateBack()
}

async function runPaySheet(miniProgram) {
  step('客户页：点收款，弹出收款层并确认')
  const list = await miniProgram.switchTab('/pages/customers/customers')
  await waitPageReady(list)
  await list.waitFor('.js-collect')
  await tap(list, '.js-collect')

  await list.waitFor(800)
  const edit = await miniProgram.currentPage()
  assert.ok(edit.path.indexOf('customer-edit') >= 0, '未进入客户编辑页: ' + edit.path)
  await edit.waitFor('.js-pay-sheet')
  await tapWhen(edit, '.js-pay-submit')
  await waitGone(edit, '.js-pay-sheet')
}

async function runNativeClearModal(miniProgram) {
  step('店铺页：点清空（原生弹窗用 mock 自动确认）')
  const home = await miniProgram.reLaunch('/pages/index/index')
  await waitPageReady(home)
  await home.waitFor('.js-shop')
  await tap(home, '.js-shop')
  await home.waitFor(800)
  const shop = await miniProgram.currentPage()
  assert.ok(shop.path.indexOf('shop') >= 0, '未进入店铺页: ' + shop.path)
  await shop.waitFor('.js-clear')
  await tap(shop, '.js-clear')
  await shop.waitFor(async function () {
    const data = await shop.data()
    return data && data.isEmpty === true
  })
  await miniProgram.navigateBack()
  const backHome = await miniProgram.currentPage()
  await waitPageReady(backHome)
  await backHome.waitFor('.js-seed')
}

async function run() {
  const launchOpts = {
    projectPath: projectPath,
    timeout: 90000
  }
  const cliPath = resolveCliPath()
  if (cliPath) {
    launchOpts.cliPath = cliPath
    step('使用 CLI ' + cliPath)
  }

  step('启动微信开发者工具')
  const miniProgram = await automator.launch(launchOpts)
  try {
    await miniProgram.mockWxMethod('showToast', {})
    await miniProgram.mockWxMethod('showModal', {
      confirm: true,
      cancel: false
    })
    await seedFromHome(miniProgram)
    await runSalePickerAndSlip(miniProgram)
    await runRecordSlipExport(miniProgram)
    await runOpeningSheet(miniProgram)
    await runPaySheet(miniProgram)
    await runNativeClearModal(miniProgram)
    console.log('ui tests passed')
  } finally {
    await miniProgram.close()
  }
}

run().catch(function (error) {
  console.error(error && error.stack ? error.stack : error)
  console.error('')
  console.error('UI 测试跑不起来时，按这个清单查：')
  console.error('1. 已安装 Node.js LTS，并在仓库根目录执行过 npm install')
  console.error('2. 微信开发者工具 → 设置 → 安全设置 → 开启服务端口 / CLI')
  console.error('   若命令行提示「工具的服务端口已关闭」，在提示处输入 y，或按上面路径手动打开')
  console.error('3. 默认会找 C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat')
  console.error('   若安装位置不同，设置环境变量 WECHAT_CLI 为 cli.bat 的完整路径')
  console.error('4. wx.showModal 是系统弹窗，自动化点不到内部按钮，脚本里用 mockWxMethod 自动确认')
  process.exit(1)
})
