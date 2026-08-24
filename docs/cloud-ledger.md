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
  - 「**截断到某张老单据时刻**的欠款」（重印老送货单要按当时的账）**唯一的算法在服务端 `getSlip`**：用当前欠款减去该单之后的后缀（`suffixOfCustomer`，上限 `SUFFIX_MAX_RECORDS` 5000 条，超了报错不给数）。**客户端没有任何流水全集，因此也没有任何现算钱的路径**——这条由 `tests/no-client-cloud-db.test.js` 的**结构禁令**保证（正则扫 `pages/` + `components/` + `app.js`，禁止的函数名单见该文件的 `MONEY_FROM_RECORDS` —— 折钱的（如 `receivableAt` / `foldAccountTerms`）和改钱的（如 `recomputeSaleReturns`）都在里面，名字出现就算，不要求后面跟括号，抄一份到文档里就会漂一份，以测试为准；`utils/store.js` / `utils/util.js` 也不许把这些函数转发出去；`accountOf` 只允许 `accountOf(null)` 这个空账户构造器），**不再靠运行时守卫**。守卫要求调用者记得调它，结构禁令不给写错的机会。它挡不住手写 `reduce` 折钱，见下面「不要做」那条。
  - 客户端拿到 `getSlip` 的回包必须挑剔到 `typeof receivable === 'number'`：`null` / 缺字段走 `Number()` 都会变成 0，而 0.00 的前欠会被当成「这个客户不欠钱」印在单据上。**算不出当时欠款就不开单**，宁可打不出单。
  - **2b-1 起累加器由 `applyTermsDelta` 增量维护**，不再每次由 `records` 全量重折叠（流水已经不在账本文档里了，想全量重折叠就得读集合，那是无界 IO）。所以**漂移是可能发生的**，别再说「不可能漂移」。
  - **这和被推翻的 `receivableSnapshot` 不是一回事，两个结论不能互相套用。** `receivableSnapshot` 冻结的是「T 时刻的流水集合在 T 时刻的折叠」，而送货单要印的是「**当前**流水集合截断到 T 时刻的折叠」——那从来就是两个量，改一条更早的流水，冻结值就再也对不上任何一张单据。`accounts` / `aggregate` 的定义是「**当前**流水集合的全量折叠」，任意时刻有唯一正确值，增量只是计算方式，**它是真正的缓存**。不要拿 `receivableSnapshot` 的结论否掉这里的增量维护，也不要拿这里的增量维护给下一个冻结字段背书。
  - 靠什么发现漂移：① `tests/ledger-records.test.js` 的 3000 步随机记账守门员，每步比对增量结果与集合全量折叠，**漏调 `applyTermsDelta` 会当场挂**；② 运行时 `attachRecent` 的 `aggregatesStale` 哨兵，`getLedger` 时比对 `aggregate.count` 和集合 `count()`，对不上就在回包里标记并 `console.warn`——只报告不阻断，因为那是读路径。客户端把回包里的这个标记存进 `utils/store.js` 的缓存（`getAggregatesStale()`），首页和流水页在它为真时挂一条「账目正在核对中，金额可能不准，请联系开发者」的提示条——只落在云函数日志里没人盯等于没有。`attachRecords` 在 2b-2 删掉之后，这个哨兵只剩 `attachRecent` 一份，**它是唯一的防线，不要顺手删掉那次 `count()`**。**它的实测边界：只比 `aggregate.count` 和集合 `countAll()`，纯金额漂移它看不见**（往累加器里注入金额偏差、条数不动，`aggregatesStale` 仍是 `false`）；金额级的漂移只有 `checkAggregates` 报得出（逐字段比对 `accounts` / `aggregate`），修要靠 `recomputeAggregates`。常规记账路径不会漂（流水写和聚合写在同一个事务里），会漂的是带外增删和非原子的批量导入。
  - 怎么修：`recomputeAggregates`（见下面「账本升级」一节）。它在一个事务里翻完当前账套的全部记录，重新 `foldAccountTerms` / `foldTotalTerms` 写回账本文档，有界 `RECOMPUTE_MAX_RECORDS` 5000 条、判条数不判页数，`dryRun: true` 只算不写，返回包永远带 before/after diff。
    - **它按集合的现状重折叠，所以它不修 B1。** 如果集合里某张退货单的 `paidAmount` 本身就是错的，重算会忠实地把这个错数再算一遍。退货份额的整体重算（`repairReturnSplits`）只发生在老数组搬进集合的那一刻（`migrateRecords`）；已经在集合里的错值只能靠改单据本身来修（`updateRecord` / `deleteRecord` 内置整体重算）。**不要拿 `recomputeAggregates` 去修错账。**
  - 还没迁移的老账本没有这两个字段，`cloneTerms` 只会把它补成空累加器 —— 那样全店金额和每个客户的欠款会一路回传成 0，而 `getSlip` 走 `receivableAt` 算得对，同一笔钱在送货单上印 200、在客户页显示 0。所以 `publicListsOf` 的 `recordsPending` 分支必须拿刚自愈出来的老数组现折一次（`foldAccountTerms` / `foldTotalTerms`），数组已经在内存里，零额外 IO。
- **事务提交之后不允许有任何可能失败的 IO。** 回传要用的东西必须在事务里备齐。提交后再报一次错，客户端看到的是「记账失败」，店员会再点一次，账就记两遍。结构上靠签名保证：`publicListsOf(shopId, doc, opts)` 是纯内存函数、**签名里没有 db**（`opts` 只是 `{dayStart, recentLimit}` 这样的纯数据），记账返回处只准调它；唯一会读 `ledger_records` 的 `attachRecent(db, ...)` 只准从只读 action 调。**记账回传只有四张表 + 聚合投影，一条流水都没有**——2b-2 起也不再有 `recordDelta`：分页之后客户端每个列表都是服务端取的、每个金额都来自 `accounts` / `totals` 投影，delta 零消费者，留着一个没人用的算钱字段就是给下一个人留坑。记账之后客户端只把本地的 `dataVersion` 标脏，页面 `onShow` 时再决定要不要重取，**不在提交之后再发一次可能失败的请求**。
- 分页协议（`listRecords`）：
  - 入参 `{ type?, customerId?, cursor?, limit? }`，返回 `{ records[], cursor, hasMore }`，`sortKey` 倒序。
  - `limit` 由纯函数 `apply.clampPageLimit` 收口：不传 / 非法（NaN、0、负数）**一律给缺省 20**（不是钳到 1），超过上限才钳到 100。集合查询、未迁移老账本的内存切片、小程序内存模式**三处用同一份定义** `apply.pageRecords`，等价性由 `tests/ledger-records.test.js` 的 T-A2 逐字段钉住。
  - `hasMore = 本页条数 >= limit`：总数正好是整页倍数时最后一页是 **0 条 + `hasMore: false`**。判条数不判页数，按页数判会把「正好 N 条」也算成还有下一页。
  - **本页为空时 `cursor` 返回 `''`**。客户端直接赋值会把游标冲回开头、从第一页重来（整页倍数时必然踩到），正确写法是 `res.cursor || 手上那个`。
  - **`type` 与 `customerId` 不能同时非默认**（`type: 'all'` 不算非默认）：`recordStore.page` 代码上支持同时筛，但没有 `bookId + type + customerId + sortKey` 索引，那会变成一条**无索引查询**——10 条数据上飞快，10000 条上超时。在 API 边界显式报错，宁可报一条明确的错，也不要发一条会随数据量退化的查询。内存模式也照样拒绝，别让它变成「开发者工具里好好的，一上线就超时」。
  - **不回 `total`**：流水页的「全部 N」用 `getLedger` 的 `totals.count`（零查询），其余 chip 和客户页都不显示条数。
  - **没有条数上限**。2b-2 之前 `getLedger` 整本回传卡在 2000 条（`COMPAT_MAX_RECORDS`），超了报错、账本直接打不开；分页之后这道悬崖不存在了，这是 2b-2 的主要收益，**不要再加回来**。`getSlip` 的 `SUFFIX_MAX_RECORDS`（5000）是另一个量——倒推走多远、与返回包无关——它是「有界循环判条数不判页数」的样板，下一个写这种循环的人照着它写（同型的还有 `recentAndToday` 的 `TODAY_MAX_RECORDS` 和 `ledger-migrate.js` 的 `readAllDocs`，三处**都判条数不判页数**；到顶后的动作不同——前两处 `> cap` + 抛错，`recentAndToday` 是 `>= MAX` + `break`，回 `todayComplete: false`）。**单次查询**的上限是另一种形状：要 `limit(MAX + 1)`、判 `> MAX`（`returnsOfSale` 的 `SALE_RETURNS_MAX`）——多要一条才分得清「刚好取满」和「被云端截断」，否则云端单次上限低于 MAX 时判据永不触发，返回一组静默截断的退货单，`recomputeSaleReturns` 在不完整的组上分份额，欠款和现金退款额一起算错。
- 流水**字段**换形状时，**读的一端兜底，不写迁移脚本**。老流水缺新字段就按老字段回推，写的一端只写新字段并把老字段删掉，一条流水不留两份结算数据。例子：结算金额 `paidAmount` 缺失时按老的 `payType` 回推（现结当作全额结清、赊账当作一分没结），见 [`utils/inventory.js`](../utils/inventory.js) 的 `settledAmount`。云函数另外还接受老客户端只送 `payType` 的写入（`resolvePaidAmount`）——小程序和云函数不是同一次发布。**这条管字段，不管搬家**：流水搬进 `ledger_records` 是一次显式的迁移动作，不要拿这条给它背书，也不要拿它否掉这条。
  - 退货单缺 `paidAmount` **且**缺 `payType`（把结算改成实收金额的那一版，退货冲抵改成读时现算，退货单头从此不存任何结算字段）时，`settledAmount` 读时**保守回推成「整笔退现金」**。**不要改成 0**：会折出负欠款，而 `assertAccountsValid` 是全账户扫描，一个负账户就让这家店从此退不了货、改不了单、删不了单；方向也不对（算成退了现金可以补记一笔收款救回来，算小了要一笔负数收款，系统里没这个操作）。正确值单条记录算不出来（要被退销售单在场），由 `migrateRecords` 的整体重算给出。六格分支表和反向的负欠款断言钉在 `tests/ledger-terms.test.js`。
- 结算口径：`paidAmount` = **这张单当场用现金结清、因而不进客户欠款的金额**。销售是客户付进来的，退货是店里退出去的现金。单据的欠款贡献一律是 `amount − paidAmount`（销售为正、退货为负）。这里的「单据」就是夹断的单位——应收、实收、已退货值一律按**整张销售单**取，不按行，口径和老账会怎么变见 [accounting-vs-policy.md](accounting-vs-policy.md)。退货单的 `paidAmount` 在**写入时**按「先冲这张销售单没收到的钱、冲不掉的才算退现金」算出来（`returnCashRefund`），**不在读的时候现算 `max(0, 应收−实收−已退)`**：夹断不可加，会同时破坏 `applyTermsDelta` 的增量维护（单条记录的贡献必须只依赖自己）和 `getSlip` 的「当前欠款 − 后缀」（后缀减不回一个被夹断的量，重印老送货单会印错）。退货单头的这一份是**按记账先后顺序**分出来的份额，判据是【拆分不变量】`Σ(退货额 − 现金退款额) == min(销售单欠款, Σ退货额)`。加一张新退货单永远维持它（新的那张就是最后一张，冲抵基准由销售行的 `returnedAmount` 现推）。**改销售单（欠款基准变了）、改/删任何一张退货单（前缀和变了）不再拦截**：事务把该销售单的**全部退货单**加载进来（`recordsNeeded` 的 `saleReturns`，走 `saleOrderId` 索引查询 `returnsOfSale`），`recomputeSaleReturns` 按记账顺序（`(createdAt, id)` 升序 = `sortKey` 升序）整体重算各单 `paidAmount`，并把退货单头过期的客户字段（id / 姓名 / 电话 / 地址，四个都继承自被退销售单，要拨就整组拨）拨到销售单当前值；多条变化由 `assertAccountsAfterAll` 一起过欠款校验。「已退货值」由销售行的 `lines[].returnedAmount` 定义（退货时按退货单实际金额累加，老流水缺失读时回退 `returnedQty × 单价`），由构造恒等于 Σ退货额——改单价、小数数量下的分位取整都不再让它和实际退货额分岔（旧口径 `round2(0.5×7.77)×2 = 7.78` vs `round2(1×7.77) = 7.77` 会差 1 分）。两条旧操作限制随之取消：不用先删后面的退货单，有退货的单也可以改单价。改单价时先由 `repriceSaleReturns` 把同单退货行的 `unitPrice` / `amount` / `profit` 拨到新价，销售行的 `returnedAmount` 同步加上差额（仍恒等于 Σ退货额），再交给 `recomputeSaleReturns` 分份额。**不拨价就是两套价**：退货行的单价是退货时从销售行复制的派生值，销售行改了它不跟，销售额就成了「新价销售额 − 旧价退货额」，误差 = 已退件数 ×（新价 − 旧价），没有上界；把一行改成 0 元赠品能算出负销售额和负的客户「累计销售」。只拨 `unitPrice`，**不动 `costPrice`**：退货行的 `costPrice` 是当时 `restockLine` 把成本放回哪一格的依据，事后改它而不重跑一遍入库，库存成本就和流水对不上。守门员是 `tests/inventory.test.js` 末尾的 fuzzer 两条不变量：欠款逐分等于 main #47 读时口径，销售额和毛利逐分等于「留在客户手上的货 × 当前单价」（第二条专抓两套价，第一条两边都用实际退货额、看不见它）。
- 小程序调云函数**必须带 `apiVersion`**；服务端设门，版本低就报「请更新小程序到最新版本」。设门的按理由分两组：会回传账本或流水的（`getLedger` / `getSlip` / `listRecords` / `getRecord` / `migrateLocal` 和所有记账、平台运营方动作——账本升级三个加 `purgeDeletedShopRecords`），以及**不可逆动作** `deleteShop`（`VERSIONED_DESTRUCTIVE`，单列——删店不回传账本，但冻结窗口里店主到处撞「请更新」、最容易乱点的时候，删店按钮就在同一个店铺页上，不可逆动作不许由老客户端发起）。放行的恰好 7 个：`whoami` / `listShops` / `createShop` / `listMembers` / `addMember` / `updateMember` / `removeMember` ——否则老客户端连店都列不出来、加不了人，报错会误导成「不是该店成员」；这份名单由 `tests/ledger-migrate.test.js` 的 M12c 整个钉住，改门别只改一处。
  - **上线顺序：先部署云函数，再发布小程序**（和 2b-1 定的相反）。理由：2b-2 之前新客户端对老云函数是前向容忍的（老云函数照旧回传整本 `ledger.records`，客户端走整份替换分支）；2b-2 之后这条容忍没了——新客户端要调 `listRecords` / `getRecord`，老云函数会回「未知操作」，流水页直接空白。保住它就得在客户端保留整本缓存 + 本地分页，而那正是这一步要删的。所以只能反过来：① 部署云函数（此刻起老客户端撞 `apiVersion` 门，报「请更新小程序到最新版本」——设计好的响亮失败）→ ② 逐店跑 `checkAggregates` → `migrateRecords` 把流水搬进 `ledger_records`（见下面「账本升级」一节）→ ③ 发布小程序新版并逐店确认已更新。②③ 之间店里是「老客户端被挡住」的状态，**必须打烊后一口气做完**。冷启动提示更新已接在 `app.js` 的 `onLaunch`（`setupUpdateManager`：`wx.getUpdateManager` 三段式，`onUpdateReady` 弹「新版本已经准备好，是否重启应用？」确认框 → `applyUpdate`，低版本基础库 `wx.canIUse` 兜底跳过）——冻结窗口的长度直接取决于店员多快更新，这段不是装饰。
  - **没有「逐店冻结窗口」这回事。** `apiVersion` 门是全局的：部署云函数那一瞬间**所有**店的老客户端一起被挡住，不是迁一家停一家。冻结窗口 = 从部署到发布小程序之间的**整段**时间，排期要按这个算。
- 扣账内核只有一份。云函数不能 `require('../../utils/inventory')`，用 `npm run sync:ledger-inventory` 复制到 `cloudfunctions/ledger/`。`npm test` 会在两份不一致时失败。
- 环境 ID 写在 [`utils/cloud-config.js`](../utils/cloud-config.js) 的 `CLOUD_ENV_ID`，必须等于开发者工具「云开发 → 设置」里的那一串（微信侧）。腾讯云控制台里另一套环境填进来会报 Environment not found。空着不能记账，也不要用客户端 `DYNAMIC_CURRENT_ENV` 代替填写。
- 集合：`shops`、`members`、`ledgers`、`ledger_records`、`ledger_clears`、`platform_admins`。前四张是当前店账；`ledger_clears` 保存每一次清空的完整快照，不回传给小程序；`platform_admins` 是**平台运营方白名单**（账本升级三个运维 action 的门，见下面「账本升级」），文档形状 `{ _id: openid, openid, note, createdAt }` —— `_id` 就是 openid，查询是一次 `doc(openid).get()`，**不需要索引**，权限同样是仅管理端可读写。
  - `ledger_records` 是 2b-1 从 `ledgers.records` 数组里拆出来的**当前流水表**，一单一条文档，`_id` = `bookId_recordId`，排序键 `sortKey` = `pad13(createdAt)_id`。账本文档里的 `records` 数组只剩没迁移的老店在用，迁完就是空的。
  - 它需要 **6 条索引**，定义和用途写在 [`cloudfunctions/ledger/ledger-records.js`](../cloudfunctions/ledger/ledger-records.js) 顶部注释里，和这里必须一致。#1–#5 全部避开数组字段；#6 是另一回事：
    1. `bookId` ASC, `sortKey` DESC —— `page` / `recentAndToday`
    2. `bookId` ASC, `customerId` ASC, `sortKey` DESC —— `page(customerId)` / `suffixOfCustomer`
    3. `bookId` ASC, `type` ASC, `sortKey` DESC —— `page(type)`
    4. `bookId` ASC, `saleOrderId` ASC, `sortKey` ASC —— 查一张销售单的退货（整体重算用）
    5. `bookId` ASC, `type` ASC, `productId` ASC, `skuId` ASC, `sortKey` DESC —— `latestPurchases`
    6. `shopId` ASC —— `purgeByShop`（删店之后按 `shopId` 分批清流水，见下面「删除店铺」）。**本文件里唯一不带 `bookId` 前缀的查询**：一家店的流水可能散在好几个账套里（当前账套、`newBook` 换掉的旧账套、`mode:'snapshots'` 转出来的 `clr-` 快照账套），账本文档一删就没人拿得到那些 `bookId`，`shopId` 是唯一还认得出它们的字段

建店、加成员、选店、店主删店在低频页，不进 tab，不挂全局组件。店铺页按有没有店分流：没店只展示创建和复制身份，有店后才展示本店、切换、账本和删除。tab 仍留主包。`lazyCodeLoading` 保持开启。`cloudfunctions/` 不进小程序包。

## 上线前要做的事

1. 开通云开发，把**开发者工具云开发面板里的**环境 ID 填进 `utils/cloud-config.js`。
2. 建集合 `shops`、`members`、`ledgers`、`ledger_records`、`ledger_clears`、`platform_admins`。`node scripts/wxcloud-deploy-ledger.js` 会自动建这六张表（缺 `ledger_records` 就是部署完每一次流水查询都报错，所以它必须在那个数组里），补 `ledger_records` 的 6 条索引，并把六张表权限设成仅管理端可读写。**但 `platform_admins` 不能等部署脚本去建**：脚本是先更新函数代码、后建表，而门是 fail-closed 的——新代码上线那一刻读不到名单，三个运维 action 对所有人拒绝。正确顺序见「账本升级」一节的上线硬依赖（`node scripts/wxcloud-ensure-platform-admin.js <运营方 openid>`）。
3. 给这六张业务表设权限为 **仅管理端可读写**（`ADMINONLY`）。**不是可选的**：小程序禁止直连业务库，权限必须把客户端挡在外面。控制台新建的表常常是 `PRIVATE`（仅创建者可读写），比设计松。CLI 新建的表默认已是 `ADMINONLY`。

   不要在控制台手点。用微信云托管 CLI：

   ```bash
   node scripts/wxcloud-ensure-acl.js
   ```

   部署 `node scripts/wxcloud-deploy-ledger.js` 末尾也会跑同一段。做法是 `@wxcloud/cli` 内部 API：`tcbDescribeDatabaseACL` 读当前标签，不是 `ADMINONLY` 再用 `tcbModifyDatabaseACL` 改。**不要传 region**，一传 `Describe` 会报 `UnknownParameter`。幂等：已经是 `ADMINONLY` 的表会跳过。

   标签对照：`ADMINONLY` = 仅管理端可读写；`PRIVATE` = 仅创建者可读写；`ADMINWRITE` = 仅管理端可写；`READONLY` = 所有人可读、仅创建者可写。官方还有第三方平台 HTTP 接口 [dbmodifyacl](https://developers.weixin.qq.com/doc/oplatform/openApi/cloudbase-batch/db-mgnt/api_setpermission.html)，需要 `component_access_token`，本仓库不走那条。
4. 给 `ledger_records` 建上面「集合」那条里列的 **6 条索引**（复合索引，字段顺序和升降序都不能改；漏一条就会退化成全表扫，条数一多就超时）。**这一步不是可选的**：#1–#5 是流水的每一次查询都要用的；#6 是删店后清流水（`purgeByShop`）唯一走的那条，缺了它删店的清理会退化成全表扫。

   不要在控制台手点。用微信云托管 CLI 的 FlexDB 接口，脚本已写好且可重复执行：

   ```bash
   node scripts/wxcloud-ensure-indexes.js
   ```

   部署 `node scripts/wxcloud-deploy-ledger.js` 末尾也会跑同一段。做法是 `@wxcloud/cli` 内部 API：`flexdbDescribeTable` 列出已有索引，缺的再用 `flexdbUpdateTable({ createIndexes })` 补。升降序传字符串 `'1'` / `'-1'`。已有**字段名和升降序都相同**的索引会跳过，不按索引名判断，也不删除多余索引。

   官方也有 HTTP 接口 [updateIndex](https://developers.weixin.qq.com/minigame/dev/wxcloud/reference-http-api/database/updateIndex.html)，本仓库不走那条，因为登录态已经在 CLI 里。
5. 用微信云托管 CLI 部署 `ledger`：密钥只放环境变量 `WXCLOUD_PRIVATE_KEY`（或 gitignore 的 `.env`），执行 `node scripts/wxcloud-login.js` 和 `node scripts/wxcloud-deploy-ledger.js`。不要用腾讯云账号的 `tcb`，也不要把密钥写进仓库。Agent 步骤见 [`.cursor/skills/wxcloud-cli/SKILL.md`](../.cursor/skills/wxcloud-cli/SKILL.md)。开发者工具右键「上传并部署：云端安装依赖」也可以。**超时和内存只有 `cloudfunctions/ledger/config.json` 一份定义**（当前 `timeout: 60` / `memorySize: 512`），部署脚本读它下发——20 秒不够：3.6 MB 账本的 `initMigration` 实测超时。改配置改那个文件，不要在部署脚本里另写一份，也不要只在云控制台上手工调（下一次部署会被覆盖回去）。只走开发者工具上传时，仍须另跑 `node scripts/wxcloud-ensure-indexes.js` 和 `node scripts/wxcloud-ensure-acl.js`。
6. 开发者工具使用正式 AppID（测试号没有云开发）。

可选：给 `members` 的 `openid`、`shopId` 以及 `ledger_clears` 的 `shopId` 加索引，名单或清空记录变长时更快。同一套 `flexdbUpdateTable`。`ledger_records` 的 6 条不在「可选」里。

## 本地旧账

建店或选店后，若本机 `wx.storage` 里还有商品 / 流水，店铺页提供一次「把本机账本上传到当前店」。云上已经有账则拒绝，避免两份对打。

**上传（`migrateLocal`）和搬家（`migrateRecords`）跑的是同一个 `legacyRecordsOf`（归并 + 退货份额整体重算），所以它也会改钱**——同一份数据落库之后的欠款可以和店主在本机看到的不一样。因此它过**同一套** `migrate.recordFailures`：V4 `returnedQty`/`returnedAmount` 跨文档一致、V5 拆分不变量、V6 负账户、V8 重复/空 id、V9/V10 归并结构守恒、V12 亚分金额。不含 V1/V2/V3/V7——那四项比的是「集合里的文档 vs 内存里的 merged」，上传是往一个空账套里写，没有集合可比。**校验只写一份定义**（`ledger-migrate.js` 的 `recordFailures`），两条路都调它，将来加检查不会只加一边。

- 少了这道门就是：同一份数据 `migrateRecords` 报 `failed`（V6 负账户）、`migrateLocal` 直接放行。落库后 `assertAccountsValid` 是**全账户扫描**，实测一个客户欠 −100 的后果是**全店任何客户**的退货 / 改单 / 删销售单一律报「改完后收款会超过赊账，请先改收款记录」（连和它毫无关系的另一个客户都退不了货、删不了单），负账户那个客户还收不了款；能把它拨回来的只剩「删掉那张退货单」或「删掉那笔收款单」（删完欠款回到非负所以放行），等于拿删真账换解冻。而客户端上传成功即 `markMigrated()`、本机原件已删，退不回去。
- **V6 判在累计 `accounts` 上，不逐片判。** 一片就是一段时间切片，「A 片赊销、B 片收款」是合法切法，单片折出来的负欠款是切片假象不是错账。不带 `token` 的一次性上传只有一片、`isFinal` 恒为真，所以那道门对客户端就是全量的（分片时同理：中间各片 `deferNegativeAccounts`，最后一片对累计 `state.accounts` 判）。
- **拒绝的文案必须说清「本机数据没有删」**：`markMigrated()` 只在云函数成功返回之后才调，抛错时本机原件确实还在，不能让店主以为数据没了。

**客户端这半（`utils/store.js` 的 `migrateLocal()` + `utils/ledger-shard.js` 的 `planShards`）**：本机账本太大会撞两堵墙——请求体大小、事务生命周期（2026-08-24 实测：一个事务里写 92 条文档就被服务端丢弃，`[ResourceUnavailable.TransactionNotExist]`，云函数耗时才 12–16 秒，真实边界尚未查清）——所以先在**归并后的视图**上用并查集求「不可切开的原子组」再贪心装箱，**上传的仍然是原始（未归并）流水**，服务端照旧自己归并，V9/V10 在每一片上仍然是有效检查。要点：

- 分片单位是**归并后**的条数（40，拍的：92 条实测丢事务的来路见上，留一倍余量）＋ 请求体 JSON 字符数（20 万，拍的，没实测过 `wx.cloud.callFunction` 的上限）。
- 原子组 = 一张销售单 + 它的**全部**退货单 + 全部同 id 记录。归并和「退货 → 销售」的指向都读 `utils/inventory.js` 的 `migrateRecordShape` / `recordGroups`（`recordGroups(records)[i]` 和 `migrateRecordShape(records)[i]` 逐位对应），**只有这一份定义**，客户端不另抄一套。
- 孤儿退货（`saleOrderId` 为空、或指向的销售单整本账里都不存在）整本退回不带 `token` 的一次性上传并 `console.warn`：带 `token` 的路上 `assertReturnsPaired` 不区分「客户端切坏的」和「源数据本来就是孤儿」，任何切法都会被拒，而一次性上传今天就放行它们——退回不是回归，改成硬报错才是。
- 只需要一片时不带 `token`（线协议和 2b-1 完全一致），小账本零行为变化。
- `markMigrated()` 只在**最后一片回了 `ledger`** 之后（`finishMigrate`），中途任何一片失败本机数据都在；失败重来是换一个新 `token`（不复用、不落盘），半成品账套不可达（服务端那边没切账套指针，O(1) 回滚）。
- 片内原始记录可能被重排（退货单拉到销售单旁边）：不影响钱——`recomputeSaleReturns` 自己按 `(createdAt, id)` 升序排，`applyTermsDelta` 可加，落库按 `_id` 写。

## 账本升级（老流水搬进 `ledger_records`）

2b-1 之前流水存在 `ledgers.records` 数组里。搬家是**一次显式的运维动作**，不是「读时兜底」——那条规矩管**字段**换形状，不管搬家，两件事不要互相套用。

三个 action 都走**平台运营方白名单**（`ledger-core.js` 的 `requirePlatformAdmin`，名单在集合 `platform_admins`，`_id` 就是 openid）、都过 `apiVersion` 门、都**不进 `MUTATIONS`**（不走 `applyMutation`）。**客户端一个入口都没有**：从开发者工具 Console 直接 `wx.cloud.callFunction({ name:'ledger', data:{ action, shopId, apiVersion:2, payload } })` 调。不要加隐藏按钮——那等于把「一键重写全店流水」发到线上。实现在 [`cloudfunctions/ledger/ledger-migrate.js`](../cloudfunctions/ledger/ledger-migrate.js)（**不参与 sync**，它有 IO）。

**为什么不是 owner-gated**（2b-4 之前是，改掉的理由）：owner 门守错了对象。它拦住平台运营方——这套系统按会员费卖给多家店，运营方要给每一家跑迁移，而运营方通常不是任何一家店的成员，挨个切店主微信号不可扩展，也不可能让交了会员费的店主自己打开开发者工具敲 Console；它却放行每一个店主——`dropLegacy` 跑完就没有 O(1) 回滚、`mode:'rollback'` 会把迁移后记的账从读路径抹掉、`recomputeAggregates` 按集合现状重折叠，而后果由平台方兜。白名单两头同时变对：**对运营方放行、对所有租户关死**。门是 **fail-closed** 的：`getPlatformAdmin` 把「文档不存在」和「读失败」都折成 `null`，两种一律拒绝——读不出来就拒绝，比读不出来就放行安全得多；代价是一次瞬时读失败让运维动作暂时不可用，重试即可。

**上线硬依赖：`platform_admins` 必须在部署新云函数之前建好并写入运营方 openid。** 顺序反了的后果：新代码一上线，三个运维 action 对**所有人**拒绝（fail-closed 的必然结果），而那正是要用它们迁移的时刻——全店已经因为 `apiVersion` 门停摆，却谁也跑不了迁移。正确顺序：① 运营方在开发者工具 Console 调 `whoami` 拿到自己的 openid（这个 action 在线上老版本就有、且免版本门，现在就能做）→ ② 一条命令把建集合、写文档、核对权限做完：`node scripts/wxcloud-ensure-platform-admin.js <openid>`（照 `wxcloud-ensure-indexes.js` 的形状写的幂等脚本，内部是 `@wxcloud/cli` 的 `flexdbCreateTable` / `flexdbPutItem` / ACL 那套；`tag` 的推导 `databases[0].instanceId || ENV_ID` 复用 `wxcloud-ensure-indexes.js` 导出的 `resolveDb`。**注意：`resolveDb` 本身只有一份，但那行推导本体在全仓有两份**——`wxcloud-ensure-indexes.js:123` 和 `wxcloud-deploy-ledger.js:154` 各写了一次 `(db && db.instanceId) || ENV_ID`，部署脚本没走 `resolveDb`。改那行推导要**两处一起改**。（`wxcloud-ensure-acl.js` 里也有个叫 `tag` 的东西，那是 **ACL 标签** `ADMINONLY`，同名不同物，别弄混））→ ③ 才部署新云函数。`deleteShop` **保持 owner-gated 不变**：那是租户对自己店的操作，不是平台运维。

**恢复路**：万一 `platform_admins` 空了 / 被删了导致锁死，重跑同一条命令 `node scripts/wxcloud-ensure-platform-admin.js <openid>` 把那条文档插回去即可，**不需要重新部署云函数**——门每次调用都现读集合，读到就放行。

### `checkAggregates` —— 只读预检

`payload: { limit?: 50 }`（只截断返回包里的明细长度）。不开事务，纯读无副作用。按有没有搬完分流：未搬完跑纯函数 `checkLedger(ledger)` 给出 P1–P14；已搬完翻完账套（上限 `AUDIT_MAX_RECORDS` 5000，到顶报错不做无界翻页）跑同一套 `auditRecords`，与账本里存的 `accounts`/`aggregate` 逐字段比——`aggregatesStale` 哨兵只说「有漂」，这里说「漂在**哪个客户的哪一项**」。

**预检可以不部署就跑。** 核心是只吃一份 `ledgers` 文档的纯函数，所以控制台导出 `ledgers` 全表（只读，不影响营业）之后本机就能跑：

```
node scripts/check-ledger-export.js <ledgers 导出文件> [--clears <ledger_clears 导出文件>] [--json]
```

这解开了「必须先部署才能预检、而部署那一刻所有店全部停摆」的死结。**阶段 0 停下来的代价是零。** 阻塞项：P3 亚分金额、P4 无法归类的改动、P5 迁移后仍有负账户、P7 拆分不变量仍被破坏、P8 `returnedQty`/`returnedAmount` 跨行不一致、**P8×P14 交集**、P9 重复/空 id、V9/V10 归并结构不守恒。**P6 孤儿退货、P8 的「缺 `returnedAmount`」那半、P14 两套价，单独出现都是非阻塞的**：P6 份额无从算起（报数人工确认，保持保守回推值）；缺 `returnedAmount` 时读时按 `returnedQty × 销售行单价` 回推，退货全按销售行当时的价开，回推值就是真值；P14 是「同一件商品销售行一个价、退货行另一个价」——那段「改有退货的单的单价放行、退货行不跟着走」留下的既有损伤，迁移既不制造也不加重它，而且迁移前后都能修（写路径的 `repriceSaleReturns` 会拨回一致）。报出来让操作者自己决定，不拿它挡住整店迁移。**注意 `repairReturnSplits` 只重算份额、不碰单价**，所以搬进集合之后销售额和毛利仍然是两套价拼的，直到有人去改那张单。

- **但 P8×P14 的交集是阻塞的**（`mixedPriceMissingAmount`）：同一条销售行既缺 `returnedAmount`、名下退货行又挂着另一套价时，回推的前提（「这行的退货都按销售行当前价开」）不成立，回推值就是错的。而写路径会把它固化——店主打开这张单一个字不改直接保存，`repriceSaleReturns` 把退货行拨到现价、`returnedAmount` 落成 Σ退货额，账上的已退货值从「当初真退的货值」跳到「已退件数 × 现价」；之后一次寻常退货就按这个抬高（或压低）的基准算冲抵，柜台多退现金而客户页还挂着欠款，同一笔钱客户付两次。**迁移前在 app 里改一下这几张单就能修**（老云函数还在跑，保存会把退货行拨回一致）；迁移之后写路径被 `assertRecordsReady` 冻结，只能去控制台手改生产文档——这是阶段 0 不能省的又一条理由。

> **阻塞项必须在部署之前修完。** 其中大部分在 `migrateRecords` 切开关前还会跑一遍（V4–V12），不过就 `failed`；而部署之后写路径已经被 `assertRecordsReady` 冻结，店里**改不了任何一张单**——修不了就只能在控制台手改 `ledgers.records`。部署之前老云函数还在跑，同样一张单在 app 里就能改。这是阶段 0 唯一不能省的理由。
>
> **但预检的阻塞项不是 V4–V12 的子集，两张单子只是大部分重合**：P4「无法归类的改动」和 **P8×P14 交集**只在预检里判，`migrateRecords` 不会因为它们停下来。这两条**只有阶段 0 拦得住**——迁完之后它们不再报错，只是安静地把钱算错。别指望当晚那一遍校验兜底。

### `migrateRecords` —— 搬家

```
payload: { limit?: 50, restart?: false, newBook?: false, force?: false,
           mode?: 'run' | 'rollback' | 'dropLegacy' | 'snapshots' | 'dropSnapshotLegacy' }
返回:    { state, phase, bookId, cursor, written, total, verified, freshBy,
           report?, error?, problems? }
```

`freshBy ∈ '' | 'restart' | 'newBook'`，记着当前这次尝试是哪个标志起的，回给调用方看。`force` 只对 `mode:'rollback'` 有意义。

状态机落在 `ledgers/{shopId}.migration`，`phase ∈ writing | verifying | done | failed`。**每次调用只推进一个阶段**，循环调到 `state === 'done'`。

**写循环之前先看 `result.ok`。** 云函数入口把一切包成 `{ ok: true, ... }` / `{ ok: false, error }`，抛错**不会**以异常形式到达调用方。所以循环条件写成 `while (r.state !== 'done')` 会在出错时空转——`ok:false` 时根本没有 `state` 这个字段：

```js
// 要 restart / newBook 时，只加在**第一次**调用的 payload 里，循环里的固定
// payload 不带（见下面 freshBy 那条：同一个标志每次都带会被当成同一次尝试的
// 重复调用，restart 不重来、newBook 不发新号，循环永不前进）。第一次调用
// 拿到回包确认 freshBy 认下了，之后每次都发下面这个不带标志的 payload。
let r
do {
  r = (await wx.cloud.callFunction({
    name: 'ledger',
    data: { action: 'migrateRecords', shopId: SHOP, apiVersion: 2, payload: { limit: 50 } }
  })).result
  console.log(r)
  if (!r.ok) break            // ← 这一句不能省
} while (r.state !== 'done' && r.state !== 'failed')
```

三条设计取舍都是「不去依赖一个未实测的量」：

- **写在事务外，cursor 用事务内 CAS 推进。** 单事务写入条数上限是未实测项；写路径已经被 `assertRecordsReady` 冻结、`_id` 确定、`set()` 幂等、源数组不变，事务在这里买不到任何东西，却会把那个未知量变成真约束。
- **`writing → verifying` 单独占一次调用。** 「事务内能否读到自己刚写的数据」同样未实测；分两次调用，校验读的一定是已提交数据。
- **`mode:'rollback'` 的守卫，事务内只用 `where().orderBy().limit().get()`，绝不用 `count()`。** `transaction.collection().where().count()` 在这个仓里一次都没跑过；而 `where().orderBy().limit().get()` **已经有在事务里跑的调用点**：**改或删**一张进货单发 `latestPurchases`（`where({bookId,type,productId,skuId}).orderBy('sortKey','desc').limit(2).get()`），**改或删**一张退货单、以及改一张有退货的销售单发 `returnsOfSale`（`where({bookId,saleOrderId}).orderBy('sortKey','asc').limit(201).get()`）——两条都在记账事务里的 `apply.prepareMutation` 发出。**新增那三条一次都不发**（实测 `addPurchase` / `addSale` / `addReturn` 在事务内发出的 `where` 查询数都是 **0**，`addReturn` 只发一次 `doc().get()` 捞被退销售单）：`recordsNeeded` 只在 `updateRecord` / `deleteRecord` 上返回非空的 `purchases` / `saleReturns`。所以准确的说法是——这条形状在事务里不可用时，**改单和删单一笔都做不了**（不是「一笔进货都记不了」），于是阶段 1 的演示店 `mt33kfi77idxpw`**只有改过或删过单据才验得到它**。回滚是全店停摆窗口里唯一的紧急出路，**出路本身失效比守卫不生效更糟**，所以那里一个新的未知量都不许引入。真要数总条数就在**事务外**数（那条形状当晚已经跑过：每家店迁移前的 `checkAggregates` 第一件事就是它）。

**不需要第二个冻结开关。** 写路径从新云函数部署那一刻起就被 `assertRecordsReady` 挡住了（`recordsPending = records.length > 0 && !recordsMigratedAt`），不要再加一个 `ledgers.migration.state`——两个冻结口径迟早会打架。

切开关前跑 12 项校验，**全过才写 `recordsMigratedAt`**：V1 条数、V2 逐条 `fromRecordDoc` 深比对（key 顺序无关、`undefined ≡ 缺字段`）、V3 读回折叠逐字段 `===` 内存折叠、V4 `returnedQty`/`returnedAmount` 跨文档一致、**V5 拆分不变量**（B1 的直接判据，只比条数抓不住）、**V6 `assertAccountsValid` 不抛**（一个负账户会卡死全店写路径）、V7 `_id`/`sortKey`/`bookId`/`shopId` 与来源一致、V8 无重复/空 id、V9 行数守恒、V10 非 `out` 一条没被并掉、V11 孤儿退货（**报数，不阻塞**）、**V12 所有金额都是 `round2()` 的输出**（`|v×100 − round(v×100)| < 1e-9`；不要重抄一份浮点老算法当参照，那是第二份会漂的定义）。

- **幂等**：归并 + 重算是 `ledger.records` 的纯函数（不发号、不读时钟），写路径冻结 → 每次算出的 `merged` 逐条相同；同 chunk 重发 = 同 `_id` 重新 `set()`。
- **失败恢复**：中断在 `writing` → cursor 记着进度接着调；校验不过 → `phase='failed'`，**店里看到的和失败前一模一样**（仍是停摆态，不是错账），`recordsMigratedAt` 不写；重来 → `restart: true`（同账套重写，**注意它不删集合里已有的文档**，只是把 cursor 拨回 0 重写一遍；残骸若不是这次要写的那批的子集，重写完仍会撞校验——撞哪条取决于残骸排在哪：**比老数组新的**（迁移后记的真账都算）在 verify 第一页就把逐条比对整排错开，报错单以 **V7（`_id`/`sortKey` 不符）和 V2（逐条不等）打头**，V1「集合里多出这条」垫在末尾；**排得比老数组都老的**残骸只撞 V1「集合里多出这条」。别按校验名猜残骸的来路，报错单里每条都带 `id`）或 `newBook: true`（换新账套，老半成品从此不可达，O(1) 回滚，代价是留下孤儿文档）。**残骸来路不明就直接 `newBook`，不要试 `restart`。**
  - **`restart` / `newBook` 是一次性的**：哪个标志起的这次尝试记在 `migration.freshBy` 上，同一个标志在这次尝试里只认一次。**上面那个循环示例的 payload 是写在循环体里的**，操作者要 restart 时最自然的改法就是加进那个 payload，于是每次调用都带着它——按「有标志就重来」判就会每次重新初始化，8 次调用全是 `{"state":"running","phase":"writing","written":0,"cursor":0}`，永不前进、也永不 `failed`，循环条件不退出；`newBook` 更糟，每次还发一个新账套号（实测 5 次调用发出 5 个号，集合里一条都没写）。而这发生在所有店一起停摆的窗口里。所以判据只能看 `freshBy`，**不能看进度**（「一条都还没写才算幂等」写完第一个 chunk 就失效，会在 init 和 write 之间原地打转）。代价是一次由 `restart` 起的尝试进行到一半时再带 `restart` 不会真的重来——可以接受：`set()` 幂等、`merged` 逐条相同、源数组变了会被 `writePhase` 的 total 比对判掉，重写一遍和接着写的末态一模一样。真正需要重来的两种状态（`failed`、以及 `done` 却没有 `recordsMigratedAt`）都不算「消化过」，照样重来；换账套用 `newBook`（标志不同，一定重来）。**真要在半途再换一本账套，逃生路是两次调用**：先发一次 `{restart: true}`（标志和 `freshBy` 不同 → 一定重来，在**当前**账套上重新初始化，`freshBy` 变成 `restart`），再发 `{newBook: true}`（这时标志又不同了 → 重来并发一个新账套号）。直接连发两次 `{newBook:true}` 只会被当成同一次尝试的重复调用，账套号一动不动——**回包里的 `freshBy` 就是拿来看这件事的**。另一条路是等这次尝试进 `failed`（`live` 只算 `writing` / `verifying`），那之后任何标志都认。
- **`mode:'rollback'`**：已 `done` 之后发现不对，只清 `recordsMigratedAt` 和 `migration`，老数组还在，**读**立刻退回老路径；**写是冻着的**——`recordsPending` 重新为真，`assertRecordsReady` 照旧拦下每一条写（实测回滚后记账和删单都报「本店账本还没完成流水升级，暂时不能记账」），回滚是回到停摆态、不是重新开张。**这是显式动作，不要让人去控制台手改生产文档。**代码**不检查 `migration.phase`**：`writing` / `verifying` 中途也能调，效果同样是回到停摆态（`cursor` / `verifyCursor` 跟着 `migration` 一起清掉，等于放弃这次尝试）；前置条件只有一条真实的——老数组非空，为空的店（跑过 `dropLegacy`、点过「清空数据」、点过「恢复清空前数据」）当场报「没有可回滚的老流水」。回滚后**重跑必须带 `restart: true`**（集合里的文档还在，不带 `restart` 会被残骸检查拒绝），若回滚前已按新路径记过账，`restart` 会撞 V7/V2（见上面「失败恢复」），只剩 `newBook: true` 一条路。
  - **只对「迁完之后一条新账都没记」成立。** 迁完之后店是解冻的，新流水只进 `ledger_records`；`ledgers.records` 那份老数组一条都不涨（`applyMutation` 把它原样带过去，那正是 O(1) 回滚路的依仗）。所以回滚是把读路径整个切回一个**过期的真子集**——迁移之后记的账在老路径上一条都看不见，欠款和流水数当场跌回迁移那一刻，而且 `aggregatesStale` 哨兵**看不见**（回滚后 `recordsPending` 为真，`getLedger` 不走 `attachRecent`，那次 `count()` 根本不发生）。
  - **守卫是两个独立信号**：①**事务内**翻集合最新一页（`ROLLBACK_PROBE_LIMIT` = 100 条），逐条看 `doc.id` 在不在老数组归并后的那一份里（用 `pageDocs`，**事务里绝不调 `count()`**，理由见上面第三条设计取舍）——精确、无竞态、一次往返，抓得到「删 3 条老账 + 记 3 笔新账」这类**条数一模一样**的情形（`tests/ledger-migrate.test.js` 的 M10e / M10e2）；②**事务外** `countAll()` 和归并条数比——抓得到埋在最新一页之外的残骸（这本账迁过、被 `force` 回滚过、又重迁过；**M10h 钉的就是这一类，拆掉②它当场变红**）。②有毫秒级竞态，两个方向都有（窗口里新记账 → 数偏小、可能放过；窗口里删记录 → 数偏大、可能误拦，安全侧且 `force` 可恢复），**所以②是提醒不是保险箱，回包里的数才是最终账**；而它漏掉的偏小那一侧恰好是①的强项（新记的账 `createdAt` 最大，一定在最新一页最前面）。
  - **两个信号的失效面重叠得很窄，但不是零。** 不要写成「失效模式互不重叠」——那句是假的，实测能构造出反例：130 条老账迁完之后，带外删掉 2 条已迁文档 + 带外塞进 2 条 `createdAt` 排在最新一页之外的文档，条数被抹平（②瞎）而且外来文档不在最新一页（①瞎），**不带 `force` 会静默回滚成功、`discarded: 0`，2 条真账从读路径消失**。app 内没有任何路径能塞一条 `createdAt` 比老数组还早的文档，所以现实概率很低，但守卫的说明书不能写错。
  - **`discarded` 只是下界，两个信号取 max 之后仍然是下界。** 实测：页内 2 条外来 + 页外 4 条外来 + 带外删 4 条已迁文档 → `collectionCount` 132、`mergedCount` 130、`foreignCount` 2 → 回包写 `discarded: 2`，而实际从读路径抹掉的是 6 条。**两个探针都读不到数时 `discarded` 回 `null`**（不是 0——0 读起来像「什么都没丢」，而那时候我们什么都不知道）。
  - **守卫只管「丢账」，不管「复活」。** 迁完之后**只删不加**再回滚：`extra = max(0, 负数) = 0`、`foreign = 0`，守卫放行，被删掉的记录在老路径上**原样复活**（实测：迁完 5 条 → 删 1 条 → 不带 `force` 回滚成功 → 老路径又是 5 条）。这是基线就有的行为，本轮没引入也没修：老数组是一份**迁移那一刻的**快照，回滚就是回到那一刻，删除动作和新增动作一样回不去。回滚前要不要保这几条，只能靠人判断。
  - **`force: true` 绕过的是整道守卫，包括探针本身。** 探针读不到数（云端不支持那条查询、超时、账套号中途变了、**事务外那次读账本没读到**、老数组归并不出来）时，不带 `force` 一律拒绝并在错误里点名 `force`；带 `force` 照常回滚，把读不到数的原因原样写进回包。**守卫可以失灵，这条出路不许失灵。**
  - 这条合同在**结构上**由两件事保证，改那段代码的人两件都要维持：事务外那半场收在 `preCountProbe` 里、**它不抛**；事务内那半场收在 `rollbackGuard` 里、**它也不抛**。但「从入口到 `tx.putLedger` 之间会抛的语句只有两条、都是『要不要回滚』这个决定本身的一部分」不是一句干净的保证，两条各有一处要照实说的缺口：① `if (!cur)` 测的是「账本在不在 **或者** 事务里这次读失败了」——真云的 `tx.getLedger`（`index.js` 的事务适配器）和 `db.getLedger` 一样把一切异常吞成 `null`。后一种情形带 `force` 也出不去，**这是有意的**：`cur` 都没读到，往下唯一安全的动作就是什么都别写（`putLedger` 是整文档 `set()`，拿一份读不到原件的文档往下走就是毁账本）；代价是这条路上 `force` 无效、只能重试，所以那句错误文案把两种可能都点到、并给出「再调一次」的重试指引，不能断言「账本不存在」。② `bookOf(cur, shopId)` 也在 `force` 之外——真实数据上 `String()` 对任何 JSON 值都不抛、实际够不着它，但「只剩两条」这个说法字面上不准确。**别再把守卫要用的读写在 `try` 外面**：真云的 `db.getLedger` 把一切异常吞成 `null`（`index.js` 的 `createDb`），一次瞬时读失败会变成「店铺账本不存在」，**带不带 `force` 都一样报错**，而那句文案会让凌晨两点的人以为账本真的丢了。`tests/ledger-migrate.test.js` 的 M10i / M10j 把这一条钉住了（守卫机器的零件逐个弄坏：前三个零件都要求「不带 `force` 拒绝且点名 `force`、带 `force` 回滚成功」；第四个零件——**事务内** `tx.getLedger` 返回 `null`——和别的零件不一样，**带 `force` 也必须拒绝**，且文案里有重试指引）。
  - 回包**一律**带：`legacyCount`（老数组原始条数，按行）/ `mergedCount`（归并后，和集合可比；归并失败时为 `null`）/ `collectionCount`（事务外数的，数不到为 `null`）/ `countError` / `foreignCount`（最新一页里不在老数组的条数）/ `foreignMore`（整页都是外来的，后面还有）/ `foreignSample`（最多 5 条 `{id,type,createdAt}`）/ `probeError` / `forced` / `discarded`（抹掉条数的**下界**，两个信号取大的；**两个探针都瞎时为 `null` = 不知道**，不是 0）。
  - 老数组为空时报的三种来路：跑过 `dropLegacy`、店主点过「清空数据」（`clearAll`）、店主点过「恢复清空前数据」（`restoreCleared`）。后两种在 `ledger_clears` 的快照文档里还留着老数组的副本。
- **`mode:'dropLegacy'`**：一个事务把 `ledgers.records` 置空。**跑完就没有 O(1) 回滚了**，默认不跑，只在账本文档逼近 5 MB（P12）时当晚跑。迁移**不会**让账本文档变小，5 MB 墙仍在。
  - 前置条件只有两条，两条都直接回答「删了会不会把唯一一份副本删掉」：① `recordsMigratedAt` 非空（写路径已解冻，新账只进集合）；② **事务外**数一遍集合，账套号没变、数得着、而且**不是空的**（老数组非空时）。②数不着就报错让人再调一次，**故意不给 `force`**——回滚是出路，堵死它等于把店锁死；`dropLegacy` 是优化，堵一次什么都没坏，给一条不可逆操作配「绕过唯一一道闸」的开关才是错的。
  - **前置条件不看 `migration.phase === 'done'`。** 它和 `recordsMigratedAt` 是同一次 `putLedger` 写进去的，说不出后者说不出的话；它一旦触发文案还是误导性的（`recordsMigratedAt` 明明写着却报「还没完成流水升级」）；而且 2b-1b 那一版里它**活不过一笔账**（`applyMutation` 不带 `migration`），恰好被上线清单「迁完 → 记一笔 1 元测试账 → 再删掉 → 跑 `dropLegacy`」的顺序踩中，需要它的那家店必然卡死、app 内没有出路。2b-1c 起 `applyMutation` 会把 `migration` 带过每一次记账，但**前置条件仍然不许依赖它**——1b 那一版已经上过的店，`migration` 是补不回来的（M16e 钉着这一条）。
  - 判据是「集合空不空」而**不是**「集合条数 ≥ 归并条数」：迁完之后正常营业，店主删掉几张单是常态（`deleteRecord` 从集合里删、老数组一条不动），拿条数当硬闸会在最需要 `dropLegacy` 的那家店上误伤。差多少照样回在 `shortfall` 里给人看。
  - 跑完会盖 `legacyDroppedAt`（**保留第一次的时间**，重跑不刷新）——那是 `mode:'dropSnapshotLegacy'` 唯一的闸。「这家店什么时候放弃的旧包退路」全店只有一个入口、可查、不含糊。`applyMutation` 把它带过每一次记账（和 `recordsMigratedAt` 同一待遇，2b-1b 审计 A6 那一类教训）。
  - 回包带：`dropped`（清掉的老数组条数，按行）/ `bookId` / `mergedCount` / `collectionCount` / `legacyDroppedAt` / `shortfall`（`max(0, mergedCount − collectionCount)`）。
- **两个特例**：`records` 为空且没有 `recordsMigratedAt`（建了没用过的店）走 **stamp-only**，只补 `recordsMigratedAt` 和 `bookId`，**不写 `accounts`/`aggregate`**（那本账可能已有活流水和正确聚合）；已经有 `recordsMigratedAt` 的一律报错。
- **`ledgers.records` 迁完之后故意留着**，`applyMutation` 每次记账都把它原样带过去。它是 O(1) 回滚路的全部依仗，`tests/ledger-records.test.js` 钉着这一条。
  - **三个动作会把它清空，从而废掉这家店的回滚路**：`dropLegacy`（明说了）、**「恢复清空前数据」**（`restoreCleared` 里 `next.records = []`，既有行为）、以及**「清空数据」**（`clearAll` → `switchBook()`，第一行就是 `next.records = []`）。「填示例数据」（`loadSeed`，开发路径）同理也走 `switchBook`。所以「整体不对就部署存档的旧函数包」这条深层退路，对**跑过 `dropLegacy` 的店**、**用过「恢复清空前数据」的店**和**点过「清空数据」的店**都不成立——旧包在这些店上会读出一本空账。数据本身没丢（还在 `ledger_records` 里；`clearAll` 存进 `ledger_clears` 的快照文档里还带着老数组的副本），但旧包读的是 `ledgers.records`，**它看不见集合里那份、也看不见快照里那份**。跑过 `mode:'dropSnapshotLegacy'` 之后，旧包连「恢复清空前数据」也读不到快照里的流水了（快照的 `records` 数组被删）——这正是那个动作的意思：那条退路已经终止。当晚谁点过恢复**或清空**要记下来。

**迁移会改动某些店当前显示的欠款。** 只有三类会动：B2（退货单头挂着改客户之前的旧 `customerId`）、`payType` 过期（改过销售单结算档，退货没跟着改）、缺两个结算字段的退货单。**这三类今天在线上就是错的**，所以这是修，不是引入——但阶段 0 的报告要逐店把差异清单给店主过一遍。

### `mode:'snapshots'` —— 把升级前存的清空快照也转过来

```
payload: { mode: 'snapshots', limit?: 50 }
返回:    { state, converted, skipped, failed, remaining, total, report[] }
         report[] 每项 { id, savedAt, status, bookId?, legacyCount?, recordCount?, reason? }
         status ∈ converted | stamped | skipped | failed（stamped 计进 converted）
```

**为什么必须跑。** `restoreCleared` 要快照带 `bookId` / `accounts` / `aggregate` 三样东西，而升级前存的快照把流水装在 `records` 数组里、三样都没有。不转换 = 那几家店的「恢复清空前数据」**从能点变成永久报错**，是对活店的真实功能损失（阶段 0 的真实导出：3 家店里 2 家中招，共 3 份老快照）。`clearDoc` 早就把这三个字段预留好并原样保留老 `records` 数组，就是在等这一步。

**前置条件：本店活账套必须已经迁完**（`recordsMigratedAt` 已写），没迁完调它明确报错。快照转换是加分项，**不能挡住关键路径**；而且它和活账套走的是同一套 `legacyRecordsOf`（归并 + 退货份额整体重算），先在活账上跑通再来转快照更安全。

**逐份处理**账本 `clearSnapshots` 里的每一条元数据：`bookId` 非空就跳过（幂等）；`records` 为空走 stamp-only（只补 `bookId` + 空 `accounts`/`aggregate`）；否则 `legacyRecordsOf` 归并 + 重算 → 事务外逐条 `set()` 写进 `ledger_records` → `countAll` 必须等于归并条数 → **一个事务**写回快照文档的 `bookId`/`accounts`/`aggregate`。**`records` 数组转换时保留不删**，和 `ledgers.records` 同一个理由：那时它还是旧云函数退路的一半。代价是同一批流水在库里存了两份（快照数组一份、集合一份）。**已删掉的店不在这个问题里**：删店会把 `ledger_clears` 文档连同里面的 `records` 数组一起删掉（见下面「删除店铺」），**悬着的只有活店的快照双份**。而它**现在有终止条件了**：跑过 `mode:'dropLegacy'`（那是「这家店放弃退路」的显式决定）之后，用 `mode:'dropSnapshotLegacy'` 收掉快照里的那一半，见下。

- **账套号 = `'clr-' + 快照 id`，故意不发新号**（对比 `newBook`）。发号会逼出一个两头不讨好的选择：先把号写进快照文档再写流水，崩在中间就恢复出一本空账（商品回来了、流水没了，**静默错账**）；先写流水再写号，崩在中间只是留下一批孤儿文档、下次重试换一个号（**是存储泄漏，不算错钱**——两头的代价不同级，别把它当成和上一条一样危险）。号由快照自己决定，两头都不用付：同一份快照重跑写的是同一批 `_id`，`set()` 幂等，`countAll` 永远只数这一份，且没有任何需要跨调用持久化的状态。`clr-` 前缀保证不会撞上现有账套。
- **单份失败不影响其他份。** 快照之间互相独立，一份坏数据不该让其他份也恢复不了。失败的记进 `report[]`（带 `reason`）继续下一份。**失败不吃 `limit` 预算**，否则一份修不好的快照会把预算吃光、`remaining` 永远归不了零，循环调不收敛。所以 `state` 只有 `running` / `done` 两种，`failed > 0` 也会收敛到 `done` —— 收敛不等于全好，**要看 `failed` 和 `report`**。
- **转全部快照，不只是最近一份。** 小程序只恢复最近一次，但更早的留在云端（见「清空和恢复」）。只转最近一份会留下混合状态，将来做付费恢复时是个雷。
- **幂等**：`bookId` 非空即跳过，整个 mode 可以反复调。`limit` 控制每次调用最多转几份，`remaining` 是这次没看过的份数。

跑完之前 `restoreCleared` 报「这份备份是账本升级前存的，请让开发者先跑 mode:"snapshots" 转换」——**文案要指出这条走得通的路**，不要写成「请联系开发者」。

哪几家店还有没转的快照，**只有本地预检脚本带 `--clears` 才报得出**（P11）：云上的 `checkAggregates` 读不到 `ledger_clears`，P11 一律回 `known: false`。所以云端确认「转完了」的唯一依据是 `mode:'snapshots'` 自己返回的 `state === 'done' && failed === 0`——**`done` 不等于全好，必须同时看 `failed` 和 `report`**。事后还有一道守门员：恢复之后 `getLedger` 的 `aggregatesStale` 会在条数对不上时叫。

另一个漏网口：只有 `ledgers.clearedBackup`、`clearSnapshots` 还是空的店（老的单份备份格式，还没被 `adoptLegacyBackup` 转成快照），`mode:'snapshots'` 会报 `total: 0` 什么都不做；等下一次记账把它转成快照之后，恢复又会报错，**得再跑一次**。真实导出里三家店的 `clearedBackup` 都是空的，但换一批数据要留意。

### `mode:'dropSnapshotLegacy'` —— 收掉快照里那份重复的 records 数组

```
payload: { mode: 'dropSnapshotLegacy', limit?: 50 }
返回:    { state, mode, total, dropped, skipped, failed, remaining, updatedAt, report[], reportTotal }
         report[] 每项 { id, savedAt, status, bookId?, legacyCount?, expectedCount?, collectionCount?, reason? }
         status ∈ dropped | skipped | failed
```

**这是 2b-3 给「同一批流水存了两份」定的终止条件。** 转换（`mode:'snapshots'`）故意把数组留着，因为那时它还是旧云函数退路的一半；这个动作就是宣布那条退路到此为止，把另一半也收掉。`state` 只有 `running` / `done` 两种，`failed > 0` 也会收敛到 `done` —— **收敛不等于全清掉了，必须同时看 `failed` 和 `report`**。

**一份快照的 `records` 数组可以删，当且仅当五条同时成立：**

| # | 条件 | 为什么 |
|---|---|---|
| ① | 本店 `ledgers.recordsMigratedAt` 非空 | 活账套没迁完就谈清理是本末倒置 |
| ② | 本店 `ledgers.legacyDroppedAt` 非空（由 `mode:'dropLegacy'` 盖） | 「这家店放弃旧包退路」这个决定，全店只有一个入口、可查、不含糊 |
| ③ | 这份快照的 `bookId` 非空 | 没 `bookId` = 还没转换 = 数组是它流水的**唯一**副本 |
| ④ | 这份快照的 `bookId` **不是**本店**当前**活账套 | 那本账套还在涨（多半是被「恢复清空前数据」恢复过），快照里冻结的 `aggregate` 不再是它的权威条数，数不出可信判据 |
| ⑤ | `countAll(bookId) === toNumber(aggregate.count)` | 删之前重新证明集合里那份是完整的 |

**为什么闸是 `legacyDroppedAt` 而不是「`ledgers.records` 为空」**：后者是一个能被巧合满足的派生状态。卓祥 `mt3231n3ixeenv` 的活账套本来就是 0 条流水，它的 `ledgers.records` 天然是空的。按「数组空了就算退路已死」判，会在**恰恰是旧包退路里唯一还有意义的那份数据**（它那 1 份快照的 6 条流水）上直接放行。所以判据必须是一个**显式决定的痕迹**，不是一个能被巧合满足的派生状态。

**为什么不并进 `dropLegacy`**：`dropLegacy` 的语义是「这家店的账本（`ledgers` 文档）」，一个事务、一份文档。快照是另一批文档、数量不定、要逐份事务、要逐份报告。并进去会让那个动作的语义变模糊，也让回滚粒度变粗（跑完 `dropLegacy` 还能停下来，不必连快照一起丢）。所以是**两个动作、强制顺序**：`dropLegacy`（盖戳 + 清活账套老数组）→ `dropSnapshotLegacy`（清快照里那半）。

**删前校验用 `countAll === aggregate.count`，两类快照通用**：A 类（老快照被转换过来的）`aggregate = foldTotalTerms(merged)`，所以 `aggregate.count` 就是转换那一刻 `countAll` 校验过的归并条数；B 类（迁移之后、`dropLegacy` 之前点「清空数据」存的）`aggregate` 是被封存账套那一刻的增量维护值，而被封存的账套此后不再变化。**不许改成「重新归并 `records` 数组再比条数」**：B 类的数组是迁移前的过期子集（封存前记的新账在集合里、不在数组里），归并出来的条数本来就不等于集合里的条数，那么判会把 B 类全判成失败。判据是严格相等——少一条不行，多一条也不行（多出来的恰恰说明这本账套已不是快照冻结时的那本）。

**一份快照一个事务，每个事务只写 1 份文档，永远不批量**；`countAll()` 在**事务外**（事务里调 `countAll()` 是本仓库明令禁止的）。2026-08-24 实测：一个事务里写 92 条文档确定性失败（`TransactionNotExist`，30 秒边界，函数耗时才 12–16 秒），真实边界未知——不可逆操作不许坐在一个未实测的量上。快照现在每份才 6 条，但设计不许假设永远这么小。

**不给 `force`**，和 `dropLegacy` 同一个口径：给一条不可逆操作配「绕过唯一一道闸」的开关才是错的。⑤数不着（`countAll` 抛错）就报失败让人再调一次。

**已知的保守误伤**：④是一条有意的、会误伤的保守规则——被「恢复清空前数据」恢复过、**而且那本账套此刻仍是活账套**的快照，清不掉它的数组（报「这份快照的账套现在就是本店活账套」）。判据是「是不是**此刻**的活账套」，不是「有没有被恢复过」：同一份快照之后再被「清空数据」封存一次，账套就不再是活的，⑤ 照常逐份现数证明条数，于是又清得掉。别把这条读成「恢复过的快照永远清不掉」。安全侧一律拒绝，这是取舍不是疏漏。

**`restoreCleared` 不读这个数组**（只读 `bookId` / 四张表 / `accounts` / `aggregate`），所以删了不影响恢复——这条由端到端测试 D3 钉住（删完数组再恢复，商品/库存/流水/欠款逐项回到清空之前），不靠这句话。删掉的快照文档盖 `legacyRecordsDroppedAt`；`countAll` 抛错、条数对不上、账套号在数数和事务之间变了，都按 `failed` 记进 `report` 继续下一份，重调即重试。幂等：数组已删的份数报 `skipped`。

哪几份还带着双份，本地预检脚本带 `--clears` 时 P11 会点名（「已转换但还带着 records 双份 N 份」）；云上的 `checkAggregates` 读不到 `ledger_clears`，和 `mode:'snapshots'` 的漏网口同一条。

### 上线清单

**阶段 0（T−7 天，不部署、不影响营业）**：控制台导出 `ledgers` 全表（另导 `ledger_clears` 的 `_id`/`shopId`/`savedAt`/`bookId`/**`records`**——漏了 `records`，P11 明细里每份快照的「流水 N 条」就全是 0，看不出哪份需要转换）→ `node scripts/check-ledger-export.js <文件> --json > 预检报告.json` → 逐店过 P1–P14，阻塞项必须为空、P4 每条改动能归到三类之一 → `mergedCount` 填进排期表 → **下载存档当前线上 `ledger` 云函数代码包**（唯一的整体回滚路，事后补不回来）。任何一项不过就停在这里。

**阶段 1（T−1 天）**：确认集合 `ledger_records` 存在且权限为「仅管理端可读写」→ 建 **6 条复合索引**（字段顺序和升降序逐条核对，漏一条会退化成全表扫）→ 跑 `node scripts/wxcloud-ensure-platform-admin.js <运营方 openid>`：建 `platform_admins`、写入运营方 openid、核对权限 `ADMINONLY`，一条命令幂等做完（上线硬依赖，见「账本升级」一节）→ 确认运营方 openid 在 `platform_admins` 里（脚本收尾会打印集合现状，逐条核对有这条）→ **顺便验一下当晚要用的调用方式能不能调通**（控制台云函数测试面板里 `getWXContext().OPENID` 可能为空，那就只能走开发者工具 Console，别留到当晚才发现）。

> **阶段 1 的后半段（下面那几条彩排和真云实测）必须在部署之后做，所以它和阶段 2 是同一个晚上，不是隔一天。** 部署那一瞬间所有店一起被 `apiVersion` 门挡住（见「没有逐店冻结窗口这回事」），而彩排要验的双信号回滚守卫、`platform_admins` 白名单、事务内 `pageDocs`，旧云函数里一个都没有。**不要为此另开一个云环境**：现有规模（3 家店、十几条流水）下那个成本远大于它防的风险。正确的隔离办法是**拿运营方自己那家演示店当挡箭牌**——先在它身上把下面几条全跑绿，不绿就停在这里，此时真实店铺一个字都没动。
>
> **店的先后顺序**（重名的两家务必按 `shopId` 认，不要按店名认）：
> 1. `mt33kfi77idxpw`（运营方自有演示店）——彩排和两条真云实测全在它身上跑
> 2. `mt3231n3ixeenv`（卓祥服饰，0 条流水、1 份老快照）——第一个真实店，也是**不额外造数据的话，唯一能在低风险下验 `mode:'snapshots'`** 的地方（自有演示店没有清空快照，这条它盖不到——要盖就得先在演示店里人造一次「清空数据」把快照造出来，那是另一份风险）
> 3. `msxeubh4c6d5f9`（应收 549 万那家，2 份老快照）——**最后动**


→ **把运营方 openid 加进当晚要迁的每家店的 `members`（`role: 'staff'`）**。为什么必须有这一步：三个运维 action 走的是 `platform_admins` 白名单，但当晚清单里 **`getSlip` 前后逐张对照、`getLedger` 核对、记 1 元测试账、删掉它** 这几步走的是 `requireMember`——而白名单的设计前提就是运营方不属于任何一家店（见上面「为什么不是 owner-gated」），不加成员这些步全报「不是该店成员」，其中 `getSlip` 逐张相等是这次迁移**唯一的正确性验证**，恰好落在被挡掉的步骤里。写法：直接往 `members` 插文档（`addMember` 要 owner，运营方加不了自己），`_id` 是 `shopId_openid`（`ledger-core.js` 的 `memberDocId`），文档 `{ _id, shopId, openid, role, createdAt }`；`role` 只有 `owner` / `staff` 两档，运营方一律 **`staff`**——`staff` 过得了 `requireMember`，而 `deleteShop` / `addMember` / `removeMember` 仍要 owner，租户边界不破。**迁完可以移除**（店主 `removeMember` 或直接删那条文档）。

  已做完（记录于 2026-08-24）：运营方 openid 已写进 `msxeubh4c6d5f9`（聚友纺织，549 万应收那家）和 `mt3231n3ixeenv`（卓祥服饰），都是 `staff`；`mt33kfi77idxpw`（另一家聚友纺织）运营方本来就是 `owner`，未改动。三位店主原有的 owner 记录一条没动。

→ **在演示店 `mt33kfi77idxpw`上把回滚彩排一遍**（本机测不到的就这一段）：`migrateRecords` 到 `done` → 在 app 里记一笔 1 元销售 → 调 `{mode:'rollback'}` **必须被拒**，错误里报得出 `foreignCount` ≥ 1 → 再调 `{mode:'rollback', force:true}` **必须成功**，回包里 `forced:true`、`discarded:1`、`probeError` 和 `countError` 都是空串 → 最后用 `{newBook:true}` 迁回去。**最后这一步不要用 `{restart:true}`**：彩排记的那笔 1 元测试账留在集合里就是残骸、又不是这次要写的那批的子集，`restart` 重写完必撞校验（那笔账 `createdAt` 最新、排在倒序最前，逐页比对整排错开——报错单以 V7 / V2 打头、V1「集合里多出这条」垫在末尾；内存替身上实测 7 项 = V7×4 + V2×2 + V1×1——店停在 `failed`、`recordsMigratedAt` 一直是 0）；而回滚之后写路径是冻着的（见上面 `mode:'rollback'` 那条），那条账在 app 里删不掉，所以只能换账套——这正是上面「**残骸来路不明就直接 `newBook`，不要试 `restart`**」那条规矩的实例。**这三步任意一步不对就停在阶段 1，不要进阶段 2**：当晚的紧急出路只有这一条，它是不是好的，只能在这里知道。**彩排还有一个它结构性看不见的失败模式**：演示店是运营方自己 `createShop` 建的，他在那家店里既是 owner 又在白名单——「运营方不是该店成员」这一段彩排怎么跑都是绿的。阶段 2 里走 `requireMember` 的那几步能不能跑，只能靠上面「把运营方加进 `members`」那一步保证，不能指望彩排发现；这个失败模式第一次现形是在 T 日打烊后、全店已因 `apiVersion` 门停摆的时候，没有第二次机会。

→ 演示店 `mt33kfi77idxpw`走完整流程时**必须包含「改一张进货单（或删掉它）」和「改一张退货单（或删掉它）」**——导出副本里没有现成的单可改（真实导出：549 万那家 0 张进货单、三家店 0 张退货单），要先在演示店里**记一笔进货、一笔销售、一笔退货**（退货必须挂在销售单上，所以销售那笔也得先记），再来改或删它们。这一步**是在验守卫的依赖，不是在验业务**，别省：事务里那两条 `where().orderBy().limit().get()`（`latestPurchases` / `returnsOfSale`）**只有 `updateRecord` / `deleteRecord` 才会发**，光记进货和退货一条都发不出来（实测 `addPurchase` / `addSale` / `addReturn` 在事务内的 `where` 查询数都是 0）。上面那次 `{mode:'rollback'}` 被拒只证明了 `pageDocs` 在**回滚事务**里能跑；这一步才证明**记账事务**里也能跑，两件事都得有。

→ **【真云实测①：事务内 `where + orderBy + limit`（`pageDocs` 还带 `_.lt` 游标）】**这条链是新引入的依赖，本机永远验不出来——`tests/memory-db.js` 的替身什么都支持。基线（`7b27b9f`）的事务里出现过的是 `doc().get()/set()/remove()`、不带修饰的 `where().get()`、和一条 `where().limit().get()`（deleteShop 清 `ledger_clears`）；**`orderBy` 和 `_.lt` 在事务里一次都没出现过**，是新云函数才引入的。触发它的操作要**逐个点名跑**，别只写「走完整流程」：改或删**进货单**（`latestPurchases`）、改或删**退货单**（`returnsOfSale`）、改**有退货的销售单**（同 `returnsOfSale`）、对着全店跑一次 **`recomputeAggregates`**（事务内 `readAllDocs` 一页页 `pageDocs`）。云端事务不支持 `orderBy` / `_.lt` 的任何一个修饰符，这四种操作就全线报错。

→ **【真云实测②：单事务写入条数上限 + 事务超时】**① **写入条数这一半已经测过一次（2026-08-24，演示店 `mt33kfi77idxpw`）**：改一张挂着 90 张退货单的销售单的单价（事务写 `ledgers` 1 + 目标 1 + 退货单 90 = 92 条）**确定性失败**，服务端报 `[ResourceUnavailable.TransactionNotExist]`「transaction must be commit or abort in 30 seconds」，而函数耗时只有 12.3 / 11.5 秒——**所以真实边界不是那 30 秒。后来在同一家店上做了二分**：**22 条写入通过（9.7 秒）、47 条失败（11.3 秒）、92 条失败（12–16 秒）**。11.3 秒失败而 9.7 秒通过，**时间至此被彻底排除**，是条数或体积。**但到底是哪一个还没分开**：演示店的 `ledgers` 文档有 3.6 MB、每次事务都要重写它一遍，所以「22–47 条」这个区间可能只对大账本成立。分开它们的办法已经就绪：建一家空店（账本几千字节）跑同样的 47 条——过了就是体积（那么任何常数都不安全，得把整体重算搬出事务），不过就是条数（可以定一个保守常数）。**这一条没结束**：还要在不同时段各测一次排除并发 / 负载因素，理由和口径见 `ledger-records.js` 的 `SALE_RETURNS_MAX` 与 `index.js` 事务改写处那两段注释。② **事务超时这一半还没测**：对着测试店的全量流水跑一次 `recomputeAggregates`——它在**一个事务里**做最多 `RECOMPUTE_MAX_RECORDS` 5000 条 / 50 次串行分页查询，看会不会撞超时（`config.json` 的 `timeout` 现在是 60 秒，不是当初写这条时的 20 秒）。

> **【已实测】2026-08-24 在演示店 `mt33kfi77idxpw`（3.6 MB 账本、8129 条老流水、归并 4694 单）上跑出来的数，下面这几条不再是未知量：**
>
> | 测的东西 | 结果 |
> |---|---|
> | `migrateRecords` 写入，每批 500 条 | **30–34 秒**（末批 194 条 18.9 秒），共 9 批 |
> | `migrateRecords` 校验，每页 | **11.5–13.6 秒**，共 **47 页** |
> | `checkAggregates`（只读） | **7.7 秒** |
> | `recomputeAggregates({dryRun:true})` | **7.9 秒**，`diffs: []` |
> | 改一张挂 90 张退货单的销售单单价（单事务写 92 条） | **确定性失败**，两次 |
>
> 两条结论：
>
> 1. **`recomputeAggregates` 的 47 页串行查询不是问题**（7.9 秒，连旧的 20 秒都够）。真正吃时间的是迁移写入。
> 2. **单事务写 92 条过不去**，两次都报 index.js 那句「库存刚被别人改过，请再提交」；函数耗时 12.3 / 11.5 秒（上限 60 秒）、内存 155 / 138 MB（上限 512 MB），**超时和内存都排除**，事务原子回滚、一条都没写进去。**原始错误已经拿到**（部署带 `console.error` 的版本后重跑，从 CLS 里捣出来的）：
>
> ```
> document.set:fail -501001 resource system error.
> [ResourceUnavailable.TransactionNotExist]
> Transaction does not exist on the server,
> transaction must be commit or abort in 30 seconds.
> ```
>
> 失败点是**事务被服务端丢弃**：第 N 次 `document.set` 发出去时，那个事务在服务端已经不存在了。
> **但不要把它当成「跑满 30 秒被掉」**：三次失败的函数耗时是 12.3 / 11.5 / **16.4 秒**，
> 都远不到 30 秒。那句「must be commit or abort in 30 seconds」是错误码自带的通用提示文案，
> 不代表真的过了 30 秒——更可能是**条数或体积**把事务提前打掉了，`TransactionNotExist`
> 只是它现形的方式。真实边界在哪里尚未查清。所以 **`SALE_RETURNS_MAX = 200` 当前形同虚设**：够不着它，先撞事务。
>
> **这不阻塞迁移**：迁移写入走的是事务**外**路径（`writePhase` 用 `db.recordsCtx()`），所以 4694 条才能分批搬完；只有 `updateRecord` / `deleteRecord` 碰到「一张销售单挂很多退货单」才会撞上。

> **【架构上限】`migrateRecords` 每推进一个 chunk 就重写一次整个 `ledgers` 文档，而那个文档里装着正在被搬的老数组本身。** 于是每一批 500 条的代价里都含着一次 3.6 MB 的写回，**账本越大迁移越慢——而账本大正是要迁移的理由**。实测：3.6 MB 的店每批 30–34 秒，20 秒的旧配置**一个 chunk 都跑不完**（这就是 `config.json` 现在是 `timeout: 60` / `memorySize: 512` 的原因）。再大一个量级的账本会撞到 60 秒，到那时得改结构（比如把游标从 `ledgers` 里搬出去），而不是继续调大 `timeout`。

→ **【真云实测②：单事务写入条数上限 + 事务超时】**两个量都没实测过（`ledger-records.js` 的 `SALE_RETURNS_MAX` 注释自己也写着「200 是拍的，部署前要实测再定」），而 `config.json` 的 `timeout` 是 20 秒。① 造一张挂着**几十张退货单**的销售单，改一次它的单价——这个事务要写 `ledgers` 1 + 目标 1 + 全部退货单 N，看它过不过、耗时多少；② 对着演示店 `mt33kfi77idxpw`的全量流水跑一次 `recomputeAggregates`——它在**一个事务里**做最多 `RECOMPUTE_MAX_RECORDS` 5000 条 / 50 次串行分页查询，看会不会撞超时。

→ 顺便在演示店 `mt33kfi77idxpw`上把 `dropLegacy` 按**上线清单自己的顺序**跑一遍：迁完 → 记一笔 1 元销售 → 删掉 → `{mode:'dropLegacy'}` **必须成功**，验收看回包里 **`shortfall` 为 0**（也就是 `collectionCount ≥ mergedCount`）。**别要求两个条数相等**：这家演示店在最后一次迁移**之后**记的账只进集合、不进老数组——为上一条造的进货 / 销售 / 退货单只要没删掉就会留在当前账套里，`collectionCount` 偏大是正常的（实测：归并 6 条 + 3 张测试单 = 集合 9 条）。回滚彩排那笔 1 元测试账也永久留在集合里，但它记在后来被 `{newBook:true}` 换掉的旧账套里，不进这两个数。真正的闸是「集合非空」而不是条数相等（见上面 `mode:'dropLegacy'` 那条），集合里**缺**了老数组该有的账才回在 `shortfall` 里（大于 0 就停下来查）。跑完这家店就没有 O(1) 回滚了，所以**只在演示店上跑**。

**阶段 2（T 日打烊后，从第 2 步起所有店一起停摆）**：`npm test` 绿 → `npm run sync:ledger-inventory` → `node scripts/wxcloud-deploy-ledger.js` → **回到「阶段 1 的后半段」（上面那一段）把演示店 `mt33kfi77idxpw` 的彩排和两条真云实测先跑完——那几步必须在部署之后才能做，所以它们就在今晚、就在这一步之后；**不跑彩排就直接进「逐店」，等于带着一条没验证过的紧急出路去动真实店**（彩排验的就是全店停摆窗口里唯一那条出路） → 开发者工具打开新版源码、**运营方**（`platform_admins` 里那个 openid，阶段 1 已建好）登录——迁移夜跑这三个 action 的是运营方，不再是各家店主。**但当晚清单不是每一步都走白名单**：三个运维 action（`checkAggregates` / `migrateRecords` 各 mode / `recomputeAggregates`——最后一个在下面回滚段落里，聚合漂了才跑）过 `requirePlatformAdmin`，运营方在名单里即可；其余每一步（`getSlip`、`getLedger`、记 1 元测试账、删掉它）过的是 `requireMember`，运营方必须是**该店**成员（阶段 1 已提前加为 `staff`），不是就报「不是该店成员」。逐店步骤用〔白名单〕/〔店成员〕标注执行人。每家的 `shopId` 从阶段 0 导出的 `ledgers` 全表 `_id` 里取——`listShops` 只列调用者自己是成员的店，运营方在阶段 1 加 `members` 之前调它回 `[]`（实测），加过之后能列出这几家，但 id 一律以导出为准 → **逐店的顺序不允许改（重名的两家务必按 `shopId` 认，不要按店名认）：① `mt33kfi77idxpw` 演示店（彩排，已在上一步跑完）→ ② `mt3231n3ixeenv` 卓祥服饰（第一个真实店）→ ③ `msxeubh4c6d5f9` 应收 549 万那家（**最后动**）** → 逐店：`checkAggregates`**〔白名单〕**（`mergedCount` 与阶段 0 报告**一致**、`collectionCount === 0`；**零记录的店是例外**——`records` 为空且没迁过，云上走「已迁移」分支，报告形状不同、**没有 `mergedCount` 字段**、还报 `migrated: true`（其实 `recordsMigratedAt` 是 0），照清单核对时别卡在这一条）→ 记下 2–3 张老送货单的 `getSlip` 结果**〔店成员〕** → 循环 `migrateRecords` 到 `done`**〔白名单〕** → `getLedger` 核对 `totals` 和两个客户**〔店成员〕**（等于报告里的 `after`、**无 `aggregatesStale`**）→ **重跑那几张 `getSlip`，必须逐张相等〔店成员〕** → **预检 P11 报了有没转的快照的店，跑 `migrateRecords` 的 `mode:'snapshots'` 到 `state === 'done'` 且 `failed === 0`〔白名单〕**（漏跑 = 这家店的「恢复清空前数据」从能点变成永久报错）→ 记一笔 1 元测试销售确认写路径解冻、再删掉**〔店成员〕** → 账本文档 > 3 MB 的店跑 `dropLegacy`**〔白名单〕** → 全部绿了再发布小程序并逐店真机确认已更新。

**回滚**：某店 `failed` → 不动，该店停摆，无错账；某店 `done` 后发现不对 → `mode:'rollback'`（O(1)，该店**仍停摆**——只有读退回老路径，写仍被 `assertRecordsReady` 冻着；集合里的文档留着，**重跑必须带 `restart: true`**，回滚前记过账就连 `restart` 也会撞 V7/V2、只能 `newBook: true`；**迁完之后已经记过账就会被拒绝**，那些账只在集合里，回滚看不见它们——真要回滚得先另行备份再带 `force: true`；反过来，迁完之后**只删过单**的店回滚会**放行**，被删的单在老路径上复活，守卫不管这一侧）；整体不对 → 部署阶段 0 存档的旧函数包（已跑过 `dropLegacy` / 清空 / 恢复的店回不去）；聚合漂了 → `recomputeAggregates`。

### `recomputeAggregates` —— 漂移修复入口

`payload: { dryRun?: false }` → `{ bookId, count, changed, dryRun, before, after, diffs }`。一个事务做完：`ledgers/{shopId}` 的读 + 写仍是全店写操作的唯一串行化点，事务内翻完集合再写回不可能读到半个并发写，**不需要新的冻结字段**。有界 `RECOMPUTE_MAX_RECORDS` 5000、判条数不判页数，拒绝还没搬完的账本，没漂就不写（不白涨 `revision`）。**边界见上面「聚合值 → 怎么修」那条：它不修 B1。**

## 清空和恢复

店铺页「清空数据」只清当前店的商品、SKU、流水、客户、种类，店铺和成员还在。每一次清空都会在集合 `ledger_clears` 里追加一份完整快照，**不会覆盖更早的记录**。小程序免费只恢复**最近一次**；恢复后按钮消失，直到再次清空。更早的快照留在云端，以后可以做成付费恢复，这一期不接支付、也不在界面里列出历史。`getLedger` 只回 `hasClearedBackup` / `archivedClearCount` / `latestClear`（`{ savedAt, recordCount }`，最近那份的元信息，**不带快照正文**），不把快照正文传给客户端。`latestClear` 是「恢复清空前数据」弹窗的依据：说清恢复的是哪一天、多少条流水（`pages/shop/shop.js`）。`recordCount` 在**清空那一刻**写进账本 `clearSnapshots` 的元数据（已迁移的账本取 `aggregate.count`，那是被封存账套的权威条数；老数组按行数报，归并条数要等 `mode:'snapshots'` 转换时回填修正）；升级前的老元数据没有这个字段，回 `null`，弹窗退化成只带日期。

快照存的是四张有界的表 + 聚合累加器 + 账套号，**不复制流水**：老账套原地不动，清空只是把指针换到新账套（O(1)）。所以恢复要快照带 `bookId`，账本升级前存的快照没有它 —— 转换见上面「账本升级」的 `mode:'snapshots'`，**每家店的每一份快照都要转**（只转最近一份会留下混合状态，将来做付费恢复时是个雷）。恢复只认这几样，**不读 `records` 数组**——升级前的老数组转换后暂留（那是旧包退路的一半）、由 `mode:'dropSnapshotLegacy'` 收掉，删掉不影响恢复。

## 删除店铺

只有当前店的店主能删，且**必须带新版 `apiVersion`**（`VERSIONED_DESTRUCTIVE`，见上面版本门那条——不可逆动作不许由老客户端在冻结窗口里发起）。删的是整店：`shops` 文档、全部 `members`、当前 `ledgers`、该店在 `ledger_clears` 里的快照，**以及 `ledger_records` 里这家店的全部流水**（2b-3）。店员只能看见自己加入的店，不能删。删掉后小程序不再列出该店，也不能用「恢复清空前数据」找回。误开的测试店用这个；只想抹账、店还要留，用「清空数据」。

流水的清理**在删店事务提交之后做**，`records.purgeByShop` 按 `shopId` 分批删（索引 #6）。三条理由，缺一条这段就该换个写法：

1. **塞不进事务。** 2026-08-24 实测**单事务写 92 条文档就确定性失败**，报 `[ResourceUnavailable.TransactionNotExist]`（函数耗时才 12 秒，所以不是简单的 30 秒墙，真实边界还没查清）。一家店上万条流水进事务必炸，而且事务是原子的——连店都删不掉。
2. **不许反过来「先清流水再删店」。** 清到一半失败就是一家**活着的**店掉了一半流水：聚合还在、流水少了，那是**错数**，而 `recomputeAggregates` 修不回来（它按集合现状重折叠）。提交之后再清，最坏情况只是"泄漏"，不可能是"算错"。
3. **提交之后的失败不许变成「删店失败」。** 店已经没了，报错只会让店主以为没删成、再点一次（再点报「不是该店成员」）。所以 `purgeByShop` 不抛错，清不完 / 清失败都只写 `console.warn`，回包照样 `deleted: true`，另带一个 `purge: { removed, remaining, stopped, error }` 供日志和测试核对。

**按 `shopId` 而不是 `bookId` 清**，因为一家店的流水可能散在好几个账套里：当前账套、`newBook` 换掉的旧账套、`mode:'snapshots'` 转出来的 `clr-` 快照账套。账本文档一删就没人拿得到那些 `bookId` 了，`shopId` 是唯一还认得出它们的字段。索引 #6（`shopId` ASC）就是为这一条查询建的。

**单次调用有两个预算，管的不是同一件事**：条数上限 `PURGE_MAX_RECORDS`（5000，确定性、与机器快慢无关，测试能精确撞上）和墙钟上限 `PURGE_BUDGET_MS`（30 秒，生产上真正先触发的那一个——单条删除多快没实测过，条数换算成多少秒是未知数，只有钟能保证不被云端硬超时砍掉）。墙钟从进 `deleteShop` 分支时起算，不是从事务结束起算，这样「事务 + 清理」的总时长才有上界。

**大店一次删不完是预期内的，不是故障。** 清不完时回包里 `purge.remaining` 为 `true`，云函数日志里有一行 `[ledger] deleteShop 流水没清完 shop=…`。店主没有任何入口能接着清（店都没了，他已经不是成员），**接着清的入口是平台运营方动作 `purgeDeletedShopRecords`**：

```js
wx.cloud.callFunction({ name: 'ledger', data: {
  action: 'purgeDeletedShopRecords', shopId: '<那家店的 shopId>',
  apiVersion: 2, payload: {}
}})
```

幂等、可反复调，判据只有 `shopId` 一个，不需要持久化任何进度——回包 `remaining` 为 `true` 就再调一次，直到 `false`。`payload.maxRecords` 可以把单次条数**调小**（调大会被 clamp 回 `PURGE_MAX_RECORDS`）。这个动作走**平台运营方白名单**（`platform_admins`），客户端一个入口都没有，从开发者工具 Console 调。

它有**两道前置检查，判的是「这家店真的没了」，不是「调用者有没有权限」**：`shops` 和 `ledgers` 里只要还有一份文档在就拒绝，两个都查。误加在一家活店上就是一次不可恢复的抹账（聚合还在、流水没了，`recomputeAggregates` 修不回来）；半删状态（店没了账本还在，或反过来）同样拒绝——那说明上一次删店没走完，先弄清楚再说。

**两道门的强度不一样，别把第二道当保险**：`listShopsByIds` 是真 fail-closed（`index.js` 那份没有 catch，读失败会抛出去），**护住活店的是它，也只有它**；`getLedger` 是 fail-open——`index.js` 和 `MemoryDb` 都把「文档不存在」和「读失败」一起折成 `null`（受限于 wxcloud 的 `doc().get()` 对缺失文档抛错，两者本来就分不开），所以 `ledgers` 的一次瞬时读失败会让第二道门从「拒绝」降级成「放行」。它挡的是半删这种基本只能靠手工改库造出来的状态，用 fail-open 换主读路径不受影响是划算的；真要它 fail-closed，得先把适配层换成 `where({ _id })` 那种分得清空结果和读失败的查法，那是另一件事。

**存量泄漏**（2b-3 之前删掉的店留下的孤儿流水）也走这个动作补清，前提是你还知道那个 `shopId`。**找不回 `shopId` 的老孤儿本次不处理**：那要全表扫 `ledger_records` 找「`shops` 里已经没有的 `shopId`」，是另一件事。

**为什么值得做这一项**：孤儿记录按 `bookId` 和 `shopId` 都查不到（账本文档没了，谁也拿不到那个 `bookId`），所以它不产生任何错数，是纯存储泄漏；但**残留文档里带着 `customerName` / `customerPhone` / `customerAddress`**，店主点了「删除店铺」之后这些个人信息还在库里。这一项的动机是**个人信息**，不是省存储。

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
- 分片上传时把退货单和它的被退销售单切到两片里。`assertReturnsPaired` 的判据是「**本片里找得到 `saleOrderId` 指向的那张销售单**」，不是「`saleOrderId` 非空」：非空只拦得住代 A（`legacyLine()` 对老退货行写死 `saleOrderId = ''`，只有 `backfillReturnedQty` 在**同一批**里找到被退销售单才补得上），而代 B / 代 C 的退货单本来就带 `saleOrderId`，切两片照样非空。放行的代价是 `repairReturnSplits` 按 `lines[0].saleOrderId` 分组、销售单不在同一片就当孤儿跳过，份额一分都不重算——实测代 B 单（销售 100 实收 40、退货 30）同片上传欠款 30、切两片欠款 60，而且 `recomputeAggregates` 修不了（它按集合现状重折叠）。客户端这半由 `utils/ledger-shard.js` 的 `planShards` 保证（原子组 = 销售单 + 全部退货单 + 全部同 id 记录），`tests/store.test.js` 的分片一节钉住。
- 在页面里从流水现算钱。客户端手上只有一页，折出来必然偏小，而偏小的欠款会被印在客户手上的单据上。`tests/no-client-cloud-db.test.js` 的结构禁令会挡住，别绕过它。**结构禁令不是全覆盖的**：它挡的是「调用/引用已知的折钱函数」（扫 `pages/` + `components/` + `app.js`，名字出现就算，方括号取值和解构别名也躲不掉；另有一条禁令不许 `utils/store.js` / `utils/util.js` 把这些函数转发出去）。**手写 `reduce` 从一页流水折钱、一个名单里的名字都不出现**，正则天生抓不到——这类只能靠 code review 和「客户端手上只有一页流水」这条认知把关。
- 给 `listRecords` 放开「同时按类型和客户筛」。代码上跑得通，但那是一条无索引查询，条数一多就超时。
- 客户端把「今日三项算不出来」显示成 0。**要显示「—」**：0 是会被当真的错数，店主会拿它当今天真的没卖出东西。
- 记账之后再顺手拉一次流水。提交之后每多一次可能失败的请求，就多一次「账记上了却报失败」的机会；标脏就够了。
- 改销售单或退货单时只改单条、不整体重算同单其余退货单的 `paidAmount`。份额是一组按记账顺序分出来的，漏拨会静默算错欠款；整体重算内置在 `updateRecord` / `deleteRecord` 里，别绕开它们直改集合。
- 改销售行单价时只改销售行、不拨同单退货行的单价。`returnedAmount` 只保证「已退货值 ≡ Σ退货额」这条**内部**一致；内部自洽不等于对外正确，销售额 / 毛利 / 欠款是销售行和退货行一起折出来的，两边必须同一套价。
- 拿 `recomputeAggregates` 去修错账。它按集合现状重折叠，错值会被忠实地再算一遍。
- 转换老清空快照时先把 `bookId` 写进快照文档、再写流水。崩在中间就恢复出一本空账：商品和客户回来了、流水没了，**而且看不出来**。顺序必须是「写流水 → 数条数 → 才盖 `bookId`」，账套号由快照 id 决定（`clr-` 前缀）所以不需要先占号。
- 活账套还没迁完就去跑 `mode:'snapshots'`。快照转换是加分项，不能挡住关键路径，服务端直接拒绝。
- 把 `dropSnapshotLegacy` 并进 `dropLegacy`，或攒一批快照放进同一个事务里删。前一个动作的语义是「这家店的账本文档」、一个事务一份文档，并进去语义就模糊了、回滚粒度也变粗；后一个——一个事务里写 92 条文档确定性失败那次实测（`TransactionNotExist`）的真实边界还没查清，不可逆操作不许坐在一个未实测的量上。**一份快照一个事务，每个事务只写 1 份文档。**
- 为账本升级再加一个冻结开关。`assertRecordsReady` 已经在挡未迁移账本的每一条写，两个冻结口径迟早会打架。
- 把 `settledAmount` 对「退货缺两个结算字段」的回推改成 0。会折出负欠款，一个负账户就让这家店从此退不了货、改不了单、删不了单。
