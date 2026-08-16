# 简单进销存小程序

单人记账用的微信小程序：管商品、进货、销售、库存预警和毛利。数据存在手机本地，不需要后端，也不需要登录。

## 能做什么

- 商品：名称、货号、条码、进价、售价、预警数量；可先选种类模板带出名称和规格待选项
- 待加工：进货进待加工库存，销售选规格，先扣现货再扣待加工
- 分规格现货：按规格组合各记一份库存；可勾同价，不必每格重填
- 种类模板：用户自建、可增删，不是库存分类，也不预置行业名单
- 进货入库、销售出库、退货原样入库、成品改规格
- 看板：商品数、库存总量、今日销售额、今日毛利、预警
- 库存：低于预警标红，可只看预警商品
- 流水：进货/销售记录，以及对应毛利
- 客户：档案、上线前期初欠款、赊账和收款

## 怎么运行

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 导入本仓库根目录
3. AppID 选「测试号 / 游客模式」即可（`project.config.json` 里已是 `touristappid`）
4. 编译预览。第一次打开首页可以点「填充示例数据」

公式对不对，不依赖微信开发者工具：

```bash
npm test
```

点选、收款弹层、送货单要开发者工具自动点：

1. 安装 [Node.js LTS](https://nodejs.org/)
2. 仓库根目录执行 `npm install`
3. 微信开发者工具 → 设置 → 安全设置 → **开启服务端口 / CLI**
4. 跑 UI 测试（会拉起开发者工具）：

```bash
npm run test:ui
```

`wx.showModal`（清空数据、删除确认）是系统弹窗，脚本点不到里面的按钮，测试里用官方 `mockWxMethod` 自动确认。商品/客户点选、收款层、送货单是页面自己画的，会真实点击。

若 CLI 不在默认路径 `C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`，先设环境变量 `WECHAT_CLI` 再跑。

## 使用说明

- 库存只通过「进货」「销售」「退货」「改规格」变动；编辑商品不会改库存
- 上线前已经欠的钱走客户页「记期初欠款」（新建时也可填），不要用赊账销售去凑；不改库存、不计入销售和毛利
- 毛利 =（本次售价 − 当前进价）× 数量
- 数据在当前设备的本地存储里，换手机或清缓存会丢
- 首页底部可以清空全部数据

## 开发约定

仓库文档在 `docs/` 和根目录 [AGENTS.md](AGENTS.md)，不放在 `.cursor/`。

- 改任何文件必须从 `main` 新建 git worktree 和分支，见 [docs/git-workflow.md](docs/git-workflow.md)
- 提交说明和 Pull Request 写法，见 [docs/commit-and-pr.md](docs/commit-and-pr.md)
- 代码注入、用时注入、分包时机和上传前扫描，见 [docs/code-injection.md](docs/code-injection.md)
- 记账要自洽，不要把行业习惯写成限制，见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)
- 待加工 / 分规格 / 退货 / 改规格，见 [docs/blank-process.md](docs/blank-process.md)
- 操作界面字号、点击区域和密度规则，见 [docs/ui-scale.md](docs/ui-scale.md)

## 刻意没做的

多人同步、云开发、登录、扫码、供应商、盘点、多仓库。
