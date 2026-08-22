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
- 流水形状：`records[]` **一张单一条记录**，明细在 `lines[]`。单头只放跨行共享的东西（客户、结算方式、备注、经手人、时间、单级汇总 `amount`/`profit`），其余一律进 `lines`。收款和期初没有明细，`lines` 为空、金额在单头。进货 / 改规格 / 库存调整是单行单，用 `lines[0]`。
  - `lines[].allocations` 必须**逐行保留**（这一行是从哪个规格格、还是从待加工扣的货）。「退货原样入库」完全依赖它，不要拍平或丢弃。
  - 已退数量记在销售行的 `lines[].returnedQty` 上，不要扫全表数退货记录。新增退货要加、删退货要减、改退货数量要同步改，三条路径都要双向一致。
  - 一张退货单只能退同一张销售单。退货单头的客户和结算方式继承自被退销售单，跨单无法定义单头。
  - 老的按行流水由 `migrateRecordShape` 在 `legacyRecordsOf` 里**读时自愈**，不需要迁移脚本。**`listsOf` 不碰流水**（它只出四张表和聚合投影），`legacyRecordsOf` 只在「这本账还没搬进 `ledger_records`」时被兼容读和 `migrateLocal` 调到；同一本账的写路径已经被 `assertRecordsReady` 挡住，不会出现一半在数组一半在集合。**只有 `out` 按 `orderId || id` 归并，其余每条各自成单**——老退货记录和被退销售单共享同一个 `orderId`，一起归并会把退货并进销售单。
- 送货单欠款：一律用 `receivableAt` 按**当前流水**、按单据时间截断现算。**不要加冻结欠款的字段。** 同一客户的送货单按时间排开，「合计欠款」必须构成一条连续余额线、末端等于该客户当前欠款；写入时冻结的值在改 / 删更早的记录后会制造一个不出现在任何单据上的断点，客户拿单据对账时对不上。
- 聚合值：账本文档里存的是**累加器**（`accounts` 每个客户一份、`aggregate` 全店一份，单位分），回传给客户端的 `customers[].account`（销售单数 / 销售额 / 赊账 / 已收 / 欠款）和 `totals`（全店销售额 / 进货额 / 毛利 / 欠款 / 流水数）是它们的投影，见 [`ledger-apply.js`](../utils/ledger-apply.js) 的 `withAggregates`。**客户端要算「当前」的钱一律读这两个字段，不要自己遍历流水缓存现算**——流水缓存可能残缺（记账后的 delta 合并条数对不上、重拉又失败），现算出来是一个偏小的欠款；`account` / `totals` 是服务端权威值，任何时候都是对的。客户页的欠款和累计销售、销售页的客户欠款、送货单上的「本次前欠」都走这条。唯一算不出来的是「**截断到某张老单据时刻**的欠款」（重印老送货单要按当时的账），那要按时间倒推流水，只能走 `store.recordsForMoney()`——**缓存不完整就报错、不打单**，宁可打不出单，也不能在客户手上的单据上印一个错数。
  - **2b-1 起累加器由 `applyTermsDelta` 增量维护**，不再每次由 `records` 全量重折叠（流水已经不在账本文档里了，想全量重折叠就得读集合，那是无界 IO）。所以**漂移是可能发生的**，别再说「不可能漂移」。
  - **这和被推翻的 `receivableSnapshot` 不是一回事，两个结论不能互相套用。** `receivableSnapshot` 冻结的是「T 时刻的流水集合在 T 时刻的折叠」，而送货单要印的是「**当前**流水集合截断到 T 时刻的折叠」——那从来就是两个量，改一条更早的流水，冻结值就再也对不上任何一张单据。`accounts` / `aggregate` 的定义是「**当前**流水集合的全量折叠」，任意时刻有唯一正确值，增量只是计算方式，**它是真正的缓存**。不要拿 `receivableSnapshot` 的结论否掉这里的增量维护，也不要拿这里的增量维护给下一个冻结字段背书。
  - 靠什么发现漂移：① `tests/ledger-records.test.js` 的 3000 步随机记账守门员，每步比对增量结果与集合全量折叠，**漏调 `applyTermsDelta` 会当场挂**；② 运行时 `attachRecords` 的 `aggregatesStale` 哨兵，`getLedger` 时比对 `aggregate.count` 和集合 `count()`，对不上就在回包里标记并 `console.warn`——只报告不阻断，因为那是读路径。常规记账路径不会漂（流水写和聚合写在同一个事务里），会漂的是带外增删和非原子的批量导入。
  - 怎么修：用集合里当前账套的全部记录重新 `foldAccountTerms` / `foldTotalTerms`，写回账本文档。**这个动作现在还没实现**，真的漂了要先补一个 `recomputeAggregates`。
  - 还没迁移的老账本没有这两个字段，`cloneTerms` 只会把它补成空累加器 —— 那样全店金额和每个客户的欠款会一路回传成 0，而 `getSlip` 走 `receivableAt` 算得对，同一笔钱在送货单上印 200、在客户页显示 0。所以 `publicListsOf` 的 `recordsPending` 分支必须拿刚自愈出来的老数组现折一次（`foldAccountTerms` / `foldTotalTerms`），数组已经在内存里，零额外 IO。
- **事务提交之后不允许有任何可能失败的 IO。** 回传要用的东西必须在事务里备齐。提交后再报一次错，客户端看到的是「记账失败」，店员会再点一次，账就记两遍。结构上靠签名保证：`publicListsOf(shopId, doc)` 是纯内存函数、**签名里没有 db**，记账返回处只准调它；唯一会读 `ledger_records` 的 `attachRecords(db, ...)` 只准从只读 action 调。记账回传给客户端的是 `recordDelta`（服务端往集合里写什么，客户端就往缓存里合什么），由纯函数 `mergeRecordDelta` 合并、按**条数**判完整。
- 兼容期 `getLedger` 整本回传的上限是 **2000 条**（`COMPAT_MAX_RECORDS`），**超了报错不截断**。截断等于悄悄少给一批流水，送货单欠款会错。上限判**条数**不判页数：`hasMore = docs.length >= limit` 在总数正好是整页倍数时恒为真，按页数判会把「正好 N 条」也算成超限。`getSlip` 的 `SUFFIX_MAX_RECORDS` 是另一个量（倒推走多远，与返回包无关），值 5000，但同一个 off-by-one 用同样写法修。不要靠调大 `COMPAT_MAX_RECORDS` 硬撑：它同时是「哪些店可以在分页版本之前迁移」的判据。
- 小程序调云函数**必须带 `apiVersion`**；服务端对会回传账本的 action（`getLedger` / `getSlip` / `migrateLocal` 和所有记账）设门，版本低就报「请更新小程序到最新版本」。老客户端拿到不带流水的回传会把本地缓存清空，下一张送货单印出 0.00 的前欠 —— 静默印错钱不可接受。`whoami` / `listShops` / `createShop` / `listMembers` 放行，否则老客户端连店都列不出来。上线顺序：先发小程序、逐店确认已更新，再部署云函数。
- 扣账内核只有一份。云函数不能 `require('../../utils/inventory')`，用 `npm run sync:ledger-inventory` 复制到 `cloudfunctions/ledger/`。`npm test` 会在两份不一致时失败。
- 环境 ID 写在 [`utils/cloud-config.js`](../utils/cloud-config.js) 的 `CLOUD_ENV_ID`，必须等于开发者工具「云开发 → 设置」里的那一串（微信侧）。腾讯云控制台里另一套环境填进来会报 Environment not found。空着不能记账，也不要用客户端 `DYNAMIC_CURRENT_ENV` 代替填写。
- 集合：`shops`、`members`、`ledgers`、`ledger_records`、`ledger_clears`。前四张是当前店账；`ledger_clears` 保存每一次清空的完整快照，不回传给小程序。
  - `ledger_records` 是 2b-1 从 `ledgers.records` 数组里拆出来的**当前流水表**，一单一条文档，`_id` = `bookId_recordId`，排序键 `sortKey` = `pad13(createdAt)_id`。账本文档里的 `records` 数组只剩没迁移的老店在用，迁完就是空的。
  - 它需要 **6 条索引**，定义和用途写在 [`cloudfunctions/ledger/ledger-records.js`](../cloudfunctions/ledger/ledger-records.js) 顶部注释里，和这里必须一致。全部避开数组字段：
    1. `bookId` ASC, `sortKey` DESC —— `page` / `readAll`
    2. `bookId` ASC, `customerId` ASC, `sortKey` DESC —— `page(customerId)` / `suffixOfCustomer`
    3. `bookId` ASC, `type` ASC, `sortKey` DESC —— `page(type)`
    4. `bookId` ASC, `saleOrderId` ASC —— 查一张销售单的退货
    5. `bookId` ASC, `type` ASC, `productId` ASC, `skuId` ASC, `sortKey` DESC —— `latestPurchases`
    6. `shopId` ASC —— `deleteShop` 清理、跨账套运维

建店、加成员、选店、店主删店在低频页，不进 tab，不挂全局组件。店铺页按有没有店分流：没店只展示创建和复制身份，有店后才展示本店、切换、账本和删除。tab 仍留主包。`lazyCodeLoading` 保持开启。`cloudfunctions/` 不进小程序包。

## 上线前在控制台做的事

1. 开通云开发，把**开发者工具云开发面板里的**环境 ID 填进 `utils/cloud-config.js`。
2. 建集合 `shops`、`members`、`ledgers`、`ledger_records`、`ledger_clears`，权限选「仅管理端可读写」。
3. 给 `ledger_records` 建上面「集合」那条里列的 **6 条索引**（复合索引，字段顺序和升降序都不能改；漏一条就会退化成全表扫，条数一多就超时）。**这一步不是可选的**：流水的每一次查询都对着其中一条。
4. 用微信云托管 CLI 部署 `ledger`：密钥只放环境变量 `WXCLOUD_PRIVATE_KEY`（或 gitignore 的 `.env`），执行 `node scripts/wxcloud-login.js` 和 `node scripts/wxcloud-deploy-ledger.js`。不要用腾讯云账号的 `tcb`，也不要把密钥写进仓库。Agent 步骤见 [`.cursor/skills/wxcloud-cli/SKILL.md`](../.cursor/skills/wxcloud-cli/SKILL.md)。开发者工具右键「上传并部署：云端安装依赖」也可以。超时已设 20 秒。
5. 开发者工具使用正式 AppID（测试号没有云开发）。

可选：给 `members` 的 `openid`、`shopId` 以及 `ledger_clears` 的 `shopId` 加索引，名单或清空记录变长时更快。`ledger_records` 的 6 条不在「可选」里。

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
- 给流水加「开单时冻结欠款」之类的派生字段。欠款和汇总的**定义**一律是当前流水的折叠——增量维护只是算法，冻结出来的是另一个量。理由见上面「送货单欠款」和「聚合值」两条。
- 迁移老流水时把非 `out` 记录也按 `orderId` 归并。老退货和被退销售单共享 `orderId`，会被并成一张单。
- 在事务提交之后再读一次库来拼回传。也不要把「找不到被退销售行」吞成 `sale = null` 放行：可退上限和 `returnedQty` 同步会双双被跳过，改一下退货数量就能凭空入库、把退货单金额抬到任意值。
- 分片上传时把退货单和它的被退销售单切到两片里。`legacyLine()` 对老退货行写死 `saleOrderId = ''`，只有 `backfillReturnedQty` 在**同一批**里找到被退销售单才补得上。
