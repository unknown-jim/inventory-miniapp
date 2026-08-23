# 简单进销存小程序

进销存微信小程序：管商品、进货、销售、库存预警和毛利。多家店共用一个云环境，按店隔离；店员用 openid 白名单进店。记账走云函数，卖货时需要联网。

## 能做什么

- 商品：名称、货号、条码、进价、售价、预警数量；可先选种类模板带出名称和规格待选项。列表可看全部或只看预警，带库存条
- 待加工：进货进待加工库存，销售选规格，先扣现货再扣待加工
- 分规格现货：按规格组合各记一份库存；可勾同价，不必每格重填
- 种类模板：用户自建、可增删，不是库存分类，也不预置行业名单
- 进货入库、销售出库、退货原样入库、成品改规格
- 销售不选「现结 / 赊账」：算出本单应收后填实收，默认收满；欠款 = 应收 − 实收，收一部分也记得下
- 库存调整：盘盈、盘亏、报损、无单赠品、其他；只改点中那一格件数，不计入进货、销售和毛利，也不改进价
- 看板：点店名进店铺页；商品数、库存总量、今日销售额、今日毛利、预警。库存总量和预警会进商品页对应筛选
- 流水：进货/销售记录，以及对应毛利
- 客户：底部 tab 进入；档案、上线前期初欠款、赊账和收款
- 店铺：没店时创建或把身份发给老板；有店后管成员、切换、清空和删除。进店仍粘贴身份，没有邀请码；可填店内称呼

## 怎么运行

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 导入本仓库根目录，使用正式 AppID（测试号没有云开发）
3. 开通云开发，把**环境 ID**填进 [`utils/cloud-config.js`](utils/cloud-config.js) 的 `CLOUD_ENV_ID`。空着不能记账，也不会自动用第一个环境
4. 在云开发控制台创建集合 `shops`、`members`、`ledgers`、`ledger_records`、`ledger_clears`、`platform_admins`。`ledger_records` 的 6 条索引用 `node scripts/wxcloud-ensure-indexes.js` 建；六张表权限用 `node scripts/wxcloud-ensure-acl.js` 设成仅管理端可读写（部署脚本末尾都会跑）。`platform_admins` 是账本升级运维 action 的白名单（`_id` = 运营方 openid），必须在部署云函数**之前**建好并写入，见 [docs/cloud-ledger.md](docs/cloud-ledger.md) 的「账本升级」
5. 上传并部署云函数 `ledger`（目录 `cloudfunctions/ledger`，超时 20 秒；或 `node scripts/wxcloud-deploy-ledger.js`）
6. 编译预览。先建店或让老板把你的 openid 加进白名单，才能记账

公式对不对，不依赖微信开发者工具：

```bash
npm test
```

改过 [`utils/inventory.js`](utils/inventory.js) 或 [`utils/ledger-apply.js`](utils/ledger-apply.js) 之后，先同步到云函数再测、再部署：

```bash
npm run sync:ledger-inventory
```

点选、收款弹层、送货单要开发者工具自动点：

1. 安装 [Node.js LTS](https://nodejs.org/)
2. 仓库根目录执行 `npm install`
3. 微信开发者工具 → 设置 → 安全设置 → **开启服务端口 / CLI**
4. 跑 UI 测试（会拉起开发者工具；走内存账本，不连真实云）：

```bash
npm run test:ui
```

`wx.showModal`（清空数据、删除确认）是系统弹窗，脚本点不到里面的按钮，测试里用官方 `mockWxMethod` 自动确认。商品/客户点选、收款层、送货单是页面自己画的，会真实点击。

若 CLI 不在默认路径 `C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`，先设环境变量 `WECHAT_CLI` 再跑。

脚本不用 automator 自带的 `launch()`：Node 从 18.20.2 起不允许直接 spawn `.bat`，那条路在 Node 24 上必然失败。改成自己跑 `cli auto --project … --auto-port 9420` 再 `connect`。自动化端口上若已经有别的项目的会话，脚本会先 `cli quit` 把开发者工具整个退掉、再用本仓库重新打开——手动开着的工具窗口会因此被关掉；跑完也会关掉自己开的那个窗口。

## 使用说明

- 库存只通过「进货」「销售」「退货」「改规格」「库存调整」变动；编辑商品不会改库存。库存调整入口在商品编辑页，不计入进货、不改进价；出库不计入销售和毛利
- 上线前已经欠的钱走客户页「记期初欠款」（新建时也可填），不要用赊账销售去凑；不改库存、不计入销售和毛利
- 毛利 =（本次售价 − 当前进价）× 数量
- 账在云上按店隔离。换手机要用同一微信、并被加进该店白名单
- 本机若还有旧版本地账，建店后可在店铺页上传一次到当前店
- 两个人同时卖同一规格时，后提交的人会看到库存不足，或提示「库存刚被别人改过，请再提交」
- 店铺页可以清空当前店数据；最近一次清空可免费恢复，更早的清空记录留在云端

## 开发约定

仓库文档在 `docs/` 和根目录 [AGENTS.md](AGENTS.md)，不放在 `.cursor/`。

- 改任何文件必须从 `main` 新建 git worktree 和分支，见 [docs/git-workflow.md](docs/git-workflow.md)
- 提交说明和 Pull Request 写法，见 [docs/commit-and-pr.md](docs/commit-and-pr.md)
- 代码注入、用时注入、分包时机和上传前扫描，见 [docs/code-injection.md](docs/code-injection.md)
- 记账要自洽，不要把行业习惯写成限制，见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)
- 待加工 / 分规格 / 退货 / 改规格，见 [docs/blank-process.md](docs/blank-process.md)
- 操作界面字号、点击区域和密度规则，见 [docs/ui-scale.md](docs/ui-scale.md)
- 云函数记账、多店隔离、环境 ID，见 [docs/cloud-ledger.md](docs/cloud-ledger.md)
- 部署云函数用微信云托管 CLI，密钥放环境变量 `WXCLOUD_PRIVATE_KEY`，见 [docs/cloud-ledger.md](docs/cloud-ledger.md)

## 刻意没做的

离线开单队列、邀请码、手机号登录、角色权限矩阵、扫码、供应商、盘点、多仓库、把流水拆成可分页集合。
