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
- 读：`getLedger` 返回**四张有界的表**（商品 / SKU / 客户 / 种类）+ **聚合投影**（`totals` / `customers[].account`）+ **最近一页流水** `recent` + **今日三项** `today`。流水一律分页取，`listRecords` 是唯一入口；按 id 打开某一张单走 `getRecord`。小程序内存 + `wx.storage` 只做缓存，不是权威来源。**客户端没有流水全集**，任何列表都是服务端取的一页。
  - `recent` 和 `today` 是按客户端给的 `dayStart` 现算的**读时投影**，不落库、不冻结。它们和被否掉的 `receivableSnapshot` 不是一回事：投影的定义永远是「当前流水集合的折叠」，任意时刻有唯一正确值；冻结字段存的是另一个量。
- 流水形状：`records[]` **一张单一条记录**，明细在 `lines[]`。单头只放跨行共享的东西（客户、结算方式、备注、经手人、时间、单级汇总 `amount`/`profit`），其余一律进 `lines`。收款和期初没有明细，`lines` 为空、金额在单头。进货 / 改规格 / 库存调整是单行单，用 `lines[0]`。
  - `lines[].allocations` 必须**逐行保留**（这一行是从哪个规格格、还是从待加工扣的货）。「退货原样入库」完全依赖它，不要拍平或丢弃。
  - 已退数量和金额记在销售行的 `lines[].returnedQty` / `lines[].returnedAmount` 上（金额按退货单实际金额累加，老流水缺失读时回退 `returnedQty × 单价`），不要扫全表数退货记录。新增退货要加、删退货要减、改退货数量要同步改，改销售行单价时退货行跟着拨价、差额也要加回来，四条路径都要双向一致。
  - 一张退货单只能退同一张销售单。退货单头的客户和结算方式继承自被退销售单，跨单无法定义单头。
  - 老的按行流水由 `migrateRecordShape` 在 `legacyRecordsOf` 里**读时自愈**，不需要迁移脚本。**`listsOf` 不碰流水**（它只出四张表和聚合投影），`legacyRecordsOf` 只在「这本账还没搬进 `ledger_records`」时被兼容读和 `migrateLocal` 调到；同一本账的写路径已经被 `assertRecordsReady` 挡住，不会出现一半在数组一半在集合。**只有 `out` 按 `orderId || id` 归并，其余每条各自成单**——老退货记录和被退销售单共享同一个 `orderId`，一起归并会把退货并进销售单。
- 送货单欠款：一律按**当前流水**、按单据时间截断现算，**在服务端**（`getSlip`；未迁移的老账本走 `receivableAt`，迁完的走「当前欠款 − 后缀」，两条路的等价性由 `tests/ledger-records.test.js` 钉住）。**不要加冻结欠款的字段。** 同一客户的送货单按时间排开，「合计欠款」必须构成一条连续余额线、末端等于该客户当前欠款；写入时冻结的值在改 / 删更早的记录后会制造一个不出现在任何单据上的断点，客户拿单据对账时对不上。
- 聚合值：账本文档里存的是**累加器**（`accounts` 每个客户一份、`aggregate` 全店一份，单位分），回传给客户端的 `customers[].account`（销售单数 / 销售额 / 赊账 / 已收 / 欠款）和 `totals`（全店销售额 / 进货额 / 毛利 / 欠款 / 流水数）是它们的投影，见 [`ledger-apply.js`](../utils/ledger-apply.js) 的 `withAggregates`。**客户端要算「当前」的钱一律读这两个字段**——分页之后客户端手上只有一页流水，拿它现折出来的必然是一个偏小的欠款；`account` / `totals` 是服务端权威值，任何时候都是对的。客户页的欠款和累计销售、销售页的客户欠款、流水页的汇总四项都走这条。
  - 「**截断到某张老单据时刻**的欠款」（重印老送货单要按当时的账）**唯一的算法在服务端 `getSlip`**：用当前欠款减去该单之后的后缀（`suffixOfCustomer`，上限 `SUFFIX_MAX_RECORDS` 5000 条，超了报错不给数）。**客户端没有任何流水全集，因此也没有任何现算钱的路径**——这条由 `tests/no-client-cloud-db.test.js` 的**结构禁令**保证（正则扫 `pages/`，禁止 `summarizeCustomerAccount` / `receivableAt` / `getTotalReceivable` / `summarizeRecords` / `computeTotals` / `foldAccountTerms` / `foldTotalTerms` / `totalsOf`，`accountOf` 只允许 `accountOf(null)` 这个空账户构造器），**不再靠运行时守卫**。守卫要求调用者记得调它，结构禁令不给写错的机会。
  - 客户端拿到 `getSlip` 的回包必须挑剔到 `typeof receivable === 'number'`：`null` / 缺字段走 `Number()` 都会变成 0，而 0.00 的前欠会被当成「这个客户不欠钱」印在单据上。**算不出当时欠款就不开单**，宁可打不出单。
  - **2b-1 起累加器由 `applyTermsDelta` 增量维护**，不再每次由 `records` 全量重折叠（流水已经不在账本文档里了，想全量重折叠就得读集合，那是无界 IO）。所以**漂移是可能发生的**，别再说「不可能漂移」。
  - **这和被推翻的 `receivableSnapshot` 不是一回事，两个结论不能互相套用。** `receivableSnapshot` 冻结的是「T 时刻的流水集合在 T 时刻的折叠」，而送货单要印的是「**当前**流水集合截断到 T 时刻的折叠」——那从来就是两个量，改一条更早的流水，冻结值就再也对不上任何一张单据。`accounts` / `aggregate` 的定义是「**当前**流水集合的全量折叠」，任意时刻有唯一正确值，增量只是计算方式，**它是真正的缓存**。不要拿 `receivableSnapshot` 的结论否掉这里的增量维护，也不要拿这里的增量维护给下一个冻结字段背书。
  - 靠什么发现漂移：① `tests/ledger-records.test.js` 的 3000 步随机记账守门员，每步比对增量结果与集合全量折叠，**漏调 `applyTermsDelta` 会当场挂**；② 运行时 `attachRecent` 的 `aggregatesStale` 哨兵，`getLedger` 时比对 `aggregate.count` 和集合 `count()`，对不上就在回包里标记并 `console.warn`——只报告不阻断，因为那是读路径。`attachRecords` 在 2b-2 删掉之后，这个哨兵只剩 `attachRecent` 一份，**它是唯一的防线，不要顺手删掉那次 `count()`**。常规记账路径不会漂（流水写和聚合写在同一个事务里），会漂的是带外增删和非原子的批量导入。
  - 怎么修：用集合里当前账套的全部记录重新 `foldAccountTerms` / `foldTotalTerms`，写回账本文档。**这个动作现在还没实现**，真的漂了要先补一个 `recomputeAggregates`。
  - 还没迁移的老账本没有这两个字段，`cloneTerms` 只会把它补成空累加器 —— 那样全店金额和每个客户的欠款会一路回传成 0，而 `getSlip` 走 `receivableAt` 算得对，同一笔钱在送货单上印 200、在客户页显示 0。所以 `publicListsOf` 的 `recordsPending` 分支必须拿刚自愈出来的老数组现折一次（`foldAccountTerms` / `foldTotalTerms`），数组已经在内存里，零额外 IO。
- **事务提交之后不允许有任何可能失败的 IO。** 回传要用的东西必须在事务里备齐。提交后再报一次错，客户端看到的是「记账失败」，店员会再点一次，账就记两遍。结构上靠签名保证：`publicListsOf(shopId, doc, opts)` 是纯内存函数、**签名里没有 db**（`opts` 只是 `{dayStart, recentLimit}` 这样的纯数据），记账返回处只准调它；唯一会读 `ledger_records` 的 `attachRecent(db, ...)` 只准从只读 action 调。**记账回传只有四张表 + 聚合投影，一条流水都没有**——2b-2 起也不再有 `recordDelta`：分页之后客户端每个列表都是服务端取的、每个金额都来自 `accounts` / `totals` 投影，delta 零消费者，留着一个没人用的算钱字段就是给下一个人留坑。记账之后客户端只把本地的 `dataVersion` 标脏，页面 `onShow` 时再决定要不要重取，**不在提交之后再发一次可能失败的请求**。
- 分页协议（`listRecords`）：
  - 入参 `{ type?, customerId?, cursor?, limit? }`，返回 `{ records[], cursor, hasMore }`，`sortKey` 倒序。
  - `limit` 由纯函数 `apply.clampPageLimit` 钳到 `[1, 100]`，缺省 20。集合查询、未迁移老账本的内存切片、小程序内存模式**三处用同一份定义** `apply.pageRecords`，等价性由 `tests/ledger-records.test.js` 的 T-A2 逐字段钉住。
  - `hasMore = 本页条数 >= limit`：总数正好是整页倍数时最后一页是 **0 条 + `hasMore: false`**。判条数不判页数，按页数判会把「正好 N 条」也算成还有下一页。
  - **本页为空时 `cursor` 返回 `''`**。客户端直接赋值会把游标冲回开头、从第一页重来（整页倍数时必然踩到），正确写法是 `res.cursor || 手上那个`。
  - **`type` 与 `customerId` 不能同时非默认**（`type: 'all'` 不算非默认）：`recordStore.page` 代码上支持同时筛，但没有 `bookId + type + customerId + sortKey` 索引，那会变成一条**无索引查询**——10 条数据上飞快，10000 条上超时。在 API 边界显式报错，宁可报一条明确的错，也不要发一条会随数据量退化的查询。内存模式也照样拒绝，别让它变成「开发者工具里好好的，一上线就超时」。
  - **不回 `total`**：流水页的「全部 N」用 `getLedger` 的 `totals.count`（零查询），其余 chip 和客户页都不显示条数。
  - **没有条数上限**。2b-2 之前 `getLedger` 整本回传卡在 2000 条（`COMPAT_MAX_RECORDS`），超了报错、账本直接打不开；分页之后这道悬崖不存在了，这是 2b-2 的主要收益，**不要再加回来**。`getSlip` 的 `SUFFIX_MAX_RECORDS`（5000）是另一个量——倒推走多远、与返回包无关——它现在是仓里唯一一份「有界循环判条数不判页数」的样板，下一个写这种循环的人照着它写。
- 流水**字段**换形状时，**读的一端兜底，不写迁移脚本**。老流水缺新字段就按老字段回推，写的一端只写新字段并把老字段删掉，一条流水不留两份结算数据。例子：结算金额 `paidAmount` 缺失时按老的 `payType` 回推（现结当作全额结清、赊账当作一分没结），见 [`utils/inventory.js`](../utils/inventory.js) 的 `settledAmount`。云函数另外还接受老客户端只送 `payType` 的写入（`resolvePaidAmount`）——小程序和云函数不是同一次发布。**这条管字段，不管搬家**：流水搬进 `ledger_records` 是一次显式的迁移动作，不要拿这条给它背书，也不要拿它否掉这条。
- 结算口径：`paidAmount` = **这张单当场用现金结清、因而不进客户欠款的金额**。销售是客户付进来的，退货是店里退出去的现金。单据的欠款贡献一律是 `amount − paidAmount`（销售为正、退货为负）。退货单的 `paidAmount` 在**写入时**按「先冲这张销售单没收到的钱、冲不掉的才算退现金」算出来（`returnCashRefund`），**不在读的时候现算 `max(0, 应收−实收−已退)`**：夹断不可加，会同时破坏 `applyTermsDelta` 的增量维护（单条记录的贡献必须只依赖自己）和 `getSlip` 的「当前欠款 − 后缀」（后缀减不回一个被夹断的量，重印老送货单会印错）。退货单头的这一份是**按记账先后顺序**分出来的份额，判据是【拆分不变量】`Σ(退货额 − 现金退款额) == min(销售单欠款, Σ退货额)`。加一张新退货单永远维持它（新的那张就是最后一张，冲抵基准由销售行的 `returnedAmount` 现推）。**改销售单（欠款基准变了）、改/删任何一张退货单（前缀和变了）不再拦截**：事务把该销售单的**全部退货单**加载进来（`recordsNeeded` 的 `saleReturns`，走 `saleOrderId` 索引查询 `returnsOfSale`），`recomputeSaleReturns` 按记账顺序（`(createdAt, id)` 升序 = `sortKey` 升序）整体重算各单 `paidAmount`，并把退货单头过期的客户字段（id / 姓名 / 电话 / 地址，四个都继承自被退销售单，要拨就整组拨）拨到销售单当前值；多条变化由 `assertAccountsAfterAll` 一起过欠款校验。「已退货值」由销售行的 `lines[].returnedAmount` 定义（退货时按退货单实际金额累加，老流水缺失读时回退 `returnedQty × 单价`），由构造恒等于 Σ退货额——改单价、小数数量下的分位取整都不再让它和实际退货额分岔（旧口径 `round2(0.5×7.77)×2 = 7.78` vs `round2(1×7.77) = 7.77` 会差 1 分）。两条旧操作限制随之取消：不用先删后面的退货单，有退货的单也可以改单价。改单价时先由 `repriceSaleReturns` 把同单退货行的 `unitPrice` / `amount` / `profit` 拨到新价，销售行的 `returnedAmount` 同步加上差额（仍恒等于 Σ退货额），再交给 `recomputeSaleReturns` 分份额。**不拨价就是两套价**：退货行的单价是退货时从销售行复制的派生值，销售行改了它不跟，销售额就成了「新价销售额 − 旧价退货额」，误差 = 已退件数 ×（新价 − 旧价），没有上界；把一行改成 0 元赠品能算出负销售额和负的客户「累计销售」。只拨 `unitPrice`，**不动 `costPrice`**：退货行的 `costPrice` 是当时 `restockLine` 把成本放回哪一格的依据，事后改它而不重跑一遍入库，库存成本就和流水对不上。守门员是 `tests/inventory.test.js` 末尾的 fuzzer 两条不变量：欠款逐分等于 main #47 读时口径，销售额和毛利逐分等于「留在客户手上的货 × 当前单价」（第二条专抓两套价，第一条两边都用实际退货额、看不见它）。
- 小程序调云函数**必须带 `apiVersion`**；服务端对会回传账本或流水的 action（`getLedger` / `getSlip` / `listRecords` / `getRecord` / `migrateLocal` 和所有记账）设门，版本低就报「请更新小程序到最新版本」。`whoami` / `listShops` / `createShop` / `listMembers` 放行，否则老客户端连店都列不出来。
  - **上线顺序：先部署云函数，再发布小程序**（和 2b-1 定的相反）。理由：2b-2 之前新客户端对老云函数是前向容忍的（老云函数照旧回传整本 `ledger.records`，客户端走整份替换分支）；2b-2 之后这条容忍没了——新客户端要调 `listRecords` / `getRecord`，老云函数会回「未知操作」，流水页直接空白。保住它就得在客户端保留整本缓存 + 本地分页，而那正是这一步要删的。所以只能反过来：① 部署云函数（此刻起老客户端撞 `apiVersion` 门，报「请更新小程序到最新版本」——设计好的响亮失败）→ ② 逐店跑流水迁移 → ③ 发布小程序新版并逐店确认已更新。②③ 之间店里是「老客户端被挡住」的状态，**必须打烊后一口气做完**。配 `wx.getUpdateManager` 冷启动提示更新。
- 扣账内核只有一份。云函数不能 `require('../../utils/inventory')`，用 `npm run sync:ledger-inventory` 复制到 `cloudfunctions/ledger/`。`npm test` 会在两份不一致时失败。
- 环境 ID 写在 [`utils/cloud-config.js`](../utils/cloud-config.js) 的 `CLOUD_ENV_ID`，必须等于开发者工具「云开发 → 设置」里的那一串（微信侧）。腾讯云控制台里另一套环境填进来会报 Environment not found。空着不能记账，也不要用客户端 `DYNAMIC_CURRENT_ENV` 代替填写。
- 集合：`shops`、`members`、`ledgers`、`ledger_records`、`ledger_clears`。前四张是当前店账；`ledger_clears` 保存每一次清空的完整快照，不回传给小程序。
  - `ledger_records` 是 2b-1 从 `ledgers.records` 数组里拆出来的**当前流水表**，一单一条文档，`_id` = `bookId_recordId`，排序键 `sortKey` = `pad13(createdAt)_id`。账本文档里的 `records` 数组只剩没迁移的老店在用，迁完就是空的。
  - 它需要 **6 条索引**，定义和用途写在 [`cloudfunctions/ledger/ledger-records.js`](../cloudfunctions/ledger/ledger-records.js) 顶部注释里，和这里必须一致。全部避开数组字段：
    1. `bookId` ASC, `sortKey` DESC —— `page` / `recentAndToday`
    2. `bookId` ASC, `customerId` ASC, `sortKey` DESC —— `page(customerId)` / `suffixOfCustomer`
    3. `bookId` ASC, `type` ASC, `sortKey` DESC —— `page(type)`
    4. `bookId` ASC, `saleOrderId` ASC, `sortKey` ASC —— 查一张销售单的退货（整体重算用）
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
- 在页面里从流水现算钱。客户端手上只有一页，折出来必然偏小，而偏小的欠款会被印在客户手上的单据上。`tests/no-client-cloud-db.test.js` 的结构禁令会挡住，别绕过它。
- 给 `listRecords` 放开「同时按类型和客户筛」。代码上跑得通，但那是一条无索引查询，条数一多就超时。
- 客户端把「今日三项算不出来」显示成 0。**要显示「—」**：0 是会被当真的错数，店主会拿它当今天真的没卖出东西。
- 记账之后再顺手拉一次流水。提交之后每多一次可能失败的请求，就多一次「账记上了却报失败」的机会；标脏就够了。
- 改销售单或退货单时只改单条、不整体重算同单其余退货单的 `paidAmount`。份额是一组按记账顺序分出来的，漏拨会静默算错欠款；整体重算内置在 `updateRecord` / `deleteRecord` 里，别绕开它们直改集合。
- 改销售行单价时只改销售行、不拨同单退货行的单价。`returnedAmount` 只保证「已退货值 ≡ Σ退货额」这条**内部**一致；内部自洽不等于对外正确，销售额 / 毛利 / 欠款是销售行和退货行一起折出来的，两边必须同一套价。
