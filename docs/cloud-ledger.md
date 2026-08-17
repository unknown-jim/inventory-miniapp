# 云开发多店记账

同一云环境里多家店隔离。店员用 openid 白名单进店。小程序不直连业务库。

## 依据

- [云函数即管理端](https://developers.weixin.qq.com/minigame/dev/wxcloud/guide/functions/wx-server-sdk.html)（微信官方：云函数以管理员身份访问数据库）
- [数据库事务仅云函数](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/database/Database.runTransaction.html)（官方：客户端没有事务）

安全规则不能跨集合判断「是不是本店成员」。所以 `shops` / `members` / `ledgers` 权限设为**仅管理端可读写**，小程序只 `wx.cloud.callFunction({ name: 'ledger' })`。

## 本仓库怎么做

- 身份：云函数里的 `OPENID`，不做额外登录，也不做邀请码。
- 租户：每条账带 `shopId`。先查 `members`，不是该店成员直接拒绝。
- 写：进货 / 销售 / 退货 / 改规格 / 库存调整 / 改档都走 `ledger` 的 `action`（库存调整是 `addAdjust`）。函数里用现有 [`utils/inventory.js`](../utils/inventory.js)，在**事务回调中重新读取** `ledgers` 文档再计算再写回。
- 读：云函数按店返回整本账；小程序内存 + `wx.storage` 只做缓存，不是权威来源。
- 扣账内核只有一份。云函数不能 `require('../../utils/inventory')`，用 `npm run sync:ledger-inventory` 复制到 `cloudfunctions/ledger/`。`npm test` 会在两份不一致时失败。
- 环境 ID 写在 [`utils/cloud-config.js`](../utils/cloud-config.js) 的 `CLOUD_ENV_ID`，必须等于开发者工具「云开发 → 设置」里的那一串（微信侧）。腾讯云控制台里另一套环境填进来会报 Environment not found。空着不能记账，也不要用客户端 `DYNAMIC_CURRENT_ENV` 代替填写。
- 集合：`shops`、`members`、`ledgers`、`ledger_clears`。前三张是当前店账；`ledger_clears` 保存每一次清空的完整快照，不回传给小程序。不要第一期就拆当前流水表。

建店、加成员、选店、店主删店在低频页，不进 tab，不挂全局组件。tab 仍留主包。`lazyCodeLoading` 保持开启。`cloudfunctions/` 不进小程序包。

## 上线前在控制台做的事

1. 开通云开发，把**开发者工具云开发面板里的**环境 ID 填进 `utils/cloud-config.js`。
2. 建集合 `shops`、`members`、`ledgers`、`ledger_clears`，权限选「仅管理端可读写」。
3. 用微信云托管 CLI 部署 `ledger`：密钥只放环境变量 `WXCLOUD_PRIVATE_KEY`（或 gitignore 的 `.env`），执行 `node scripts/wxcloud-login.js` 和 `node scripts/wxcloud-deploy-ledger.js`。不要用腾讯云账号的 `tcb`，也不要把密钥写进仓库。Agent 步骤见 [`.cursor/skills/wxcloud-cli/SKILL.md`](../.cursor/skills/wxcloud-cli/SKILL.md)。开发者工具右键「上传并部署：云端安装依赖」也可以。超时已设 20 秒。
4. 开发者工具使用正式 AppID（测试号没有云开发）。

可选：给 `members` 的 `openid`、`shopId` 以及 `ledger_clears` 的 `shopId` 加索引，名单或清空记录变长时更快。

## 本地旧账

建店或选店后，若本机 `wx.storage` 里还有商品 / 流水，店铺页提供一次「把本机账本上传到当前店」。云上已经有账则拒绝，避免两份对打。

## 清空和恢复

店铺页「清空数据」只清当前店的商品、SKU、流水、客户、种类，店铺和成员还在。每一次清空都会在集合 `ledger_clears` 里追加一份完整快照，**不会覆盖更早的记录**。小程序免费只恢复**最近一次**；恢复后按钮消失，直到再次清空。更早的快照留在云端，以后可以做成付费恢复，这一期不接支付、也不在界面里列出历史。`getLedger` 只回 `hasClearedBackup` / `archivedClearCount`，不把快照正文传给客户端。

## 删除店铺

只有当前店的店主能删。删的是整店：`shops` 文档、全部 `members`、当前 `ledgers`、该店在 `ledger_clears` 里的快照。店员只能看见自己加入的店，不能删。删掉后小程序不再列出该店，也不能用「恢复清空前数据」找回。误开的测试店用这个；只想抹账、店还要留，用「清空数据」。

## UI 测试

不连真实云。`tests/ui.test.js` 写入 `inv_test_memory_ledger`，`store` 用同一套 `inventory.js` 在本地改账。

## 不要做

- 小程序端 `wx.cloud.database()` 读写业务集合，或「本地写一份云写一份」。
- 离线开单队列。断网卖货和同时卖货冲突无法在本地裁决。
- 把现场规矩写成软件限制。记账仍要自洽，见 [accounting-vs-policy.md](accounting-vs-policy.md)。
- 把 `CLOUD_ENV_ID` 留空却指望开发者工具自动选环境，或把腾讯云控制台里另一套环境 ID 填进小程序。
- 把微信云托管 CLI 密钥写进仓库、skill 或提交说明。只放 `WXCLOUD_PRIVATE_KEY` 或 `.env`。
- 改了 `utils/inventory.js` 或 `utils/ledger-apply.js` 却不跑 `npm run sync:ledger-inventory`。
