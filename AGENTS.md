# Agent 说明

本仓库约定写在仓库文档里，不写在 `.cursor/`。改任何文件之前先读对应文档并遵守。

## 必须先读

1. [docs/git-workflow.md](docs/git-workflow.md)：从 `main` 新建 worktree 和分支。不满足这一条就不要改文件。
2. [docs/code-injection.md](docs/code-injection.md)：按需注入、用时注入、分包时机、代码质量扫描。
3. [docs/commit-and-pr.md](docs/commit-and-pr.md)：提交说明和 Pull Request 描述。写 commit 或开 PR 时必须遵守。
4. [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)：记账要自洽，现场规矩不写死。
5. [docs/blank-process.md](docs/blank-process.md)：待加工、分规格现货、退货原样入库、改规格。
6. [docs/ui-scale.md](docs/ui-scale.md)：操作界面字号、点击区域、密度规则。
7. [docs/cloud-ledger.md](docs/cloud-ledger.md)：云函数记账、多店隔离、环境 ID、禁止客户端直连业务库。
8. [docs/ui-test.md](docs/ui-test.md)：UI 自动化测试怎么跑、为什么查不到自定义组件里的东西、等待为什么必须带超时。改页面 `js-` 钩子、抽组件或改 `tests/ui.test.js` 时必读。

## 硬约束（摘要）

### Git

- 禁止在主工作树（`inventory-miniapp-main`）和 `main` 上改文件。也不要从历史分支 `master` 开新任务。
- 每次任务：`git fetch origin`（有远程时）→ `git worktree add -b <前缀>/<短名> ../inventory-miniapp-worktrees/<短名> origin/main`（无远程则基线用 `main`）→ **把工作区切到新目录** → 再改文件。
- 主工作树永远停在 `main`，不要在里面切换分支。
- 不要复用上一任务的工作树做下一件无关的事。
- 提交说明和 PR 描述遵守 [docs/commit-and-pr.md](docs/commit-and-pr.md)：祈使句首行、写清为什么改、一次 PR 只做一件自包含的事。

### 代码注入

- `app.json` 必须保留 `"lazyCodeLoading": "requiredComponents"`，不得删除。
- 不要在 `app.json` 的 `permission` 里写 `scope.writePhotosAlbum`（基础库只认地理位置 scope；相册说明写在后台隐私指引和保存弹窗里）。
- `ignoreDevUnusedFiles` / `ignoreUploadUnusedFiles` 必须为 false。JS 工具模块留在 `packOptions.include`；加载态和送货单弹层用页面 `usingComponents`，不要再用 `<include>` / `@import` 片段。详见 [docs/code-injection.md](docs/code-injection.md)。
- 不要把低频自定义组件写进 `app.json` 的全局 `usingComponents`。
- 页面 JSON 只声明本页真正用到的组件。
- 非首屏重组件才配 `componentPlaceholder`；首屏立刻展示的组件不要配。`page-loading` 是首屏，不要配占位。
- 不要为了用时注入去硬拆页面。共用 WXML/WXSS 片段改成组件，是为了让代码质量扫描能看见依赖。
- tabBar 页面必须留在主包。
- `lazyloadPlaceholderEnable` 只用于调试占位态，日常保持 `false`。
- 不要只把约定写进 `.cursor/rules/`；有新约定就更新 `docs/`，并在本文件补上入口。

### 记账和现场规矩

- 件数守恒、退货原样入库、整单共享待加工：记账要自洽，必须守。
- 销售填实收，不选「现结 / 赊账」；欠款 = 应收 − 实收，实收少于应收必须选客户。退货先冲这张单没收到的钱。详见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)。
- 库存调整只改件数，不计入进货、销售、毛利和欠款，也不改进价。详见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)。
- 上线前欠款走期初往来，不拿销售去凑；不改库存、不计入销售和毛利。
- 能不能换某一根轴、先改再卖还是当场改：现场规矩，不要写成软件限制。
- 给操作便利（种类模板带出待选项、多规格可同价），不要给行业裁判。详见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)。
- 操作界面不要写小于 `--fs-xs` 的字号、不要写小于 `--tap-sm` 的可点高度。新页面用 `app.wxss` 共用布局类，根节点 `class="page"`。送货单除外。详见 [docs/ui-scale.md](docs/ui-scale.md)。

### 测试

- 改 wxml 的 `js-` 钩子、或把页面里的块抽成自定义组件，必须同步检查 `tests/ui.test.js` 并跑一次 `npm run test:ui`。抽组件会让该块上的钩子在测试里全部失效。
- 自定义组件内部的内容，页面级选择器一律查不到（`slip-overlay` / `page-loading` 都开了 `virtualHost`，`page.$$` / `>>>` / `selectComponent` 实测全是 0）。断言改成核对页面数据，别再往回写 `.js-slip` 这类选择器。
- `tests/ui.test.js` 里新增等待一律走 `waitFor(page, target, label)`。automator 原生的 `page.waitFor` 没有超时，选择器一过期就静默挂死，不报错。
- 以上详见 [docs/ui-test.md](docs/ui-test.md)。

### 云开发

- 业务库只允许云函数 `ledger` 读写。小程序禁止 `wx.cloud.database()` 访问 `shops` / `members` / `ledgers` / `ledger_records` / `ledger_clears` / `platform_admins` / `platform_config`。
- `utils/cloud-config.js` 必须有明确的环境 ID 才记账；填开发者工具「云开发」里的 ID，不要填腾讯云控制台另一套环境，也不要依赖「第一个云环境」。
- 部署 `ledger` 用微信云托管 CLI；密钥只放环境变量 `WXCLOUD_PRIVATE_KEY`，步骤见 [`.cursor/skills/wxcloud-cli/SKILL.md`](.cursor/skills/wxcloud-cli/SKILL.md)。不要用腾讯云账号的 `tcb` 管微信侧环境。`ledger_records` 的索引用 `node scripts/wxcloud-ensure-indexes.js` 建；业务表权限用 `node scripts/wxcloud-ensure-acl.js` 设成 `ADMINONLY`。**表清单只有一份**：`wxcloud-ensure-acl.js` 的 `COLLECTIONS`，部署脚本的建表清单直接取它，不要另抄。都不要在控制台手点。
- 改 `utils/inventory.js` 或 `utils/ledger-apply.js` 后运行 `npm run sync:ledger-inventory`，保持云函数副本一致。
- 流水是「一单一记录」，明细在 `lines[]`；`allocations` 逐行保留，已退数量和金额记在销售行的 `returnedQty` / `returnedAmount` 上。欠款和汇总一律由当前流水现算，不要加冻结字段。详见 [docs/cloud-ledger.md](docs/cloud-ledger.md)。
- 流水**字段**换形状时读的一端兜底、写的一端抹掉老字段，不写迁移脚本（例：`settledAmount` 按老 `payType` 回推实收）。这条管字段，不管**搬家**：流水搬进 `ledger_records` 是一次显式的迁移动作，两件事不要互相套用。详见 [docs/cloud-ledger.md](docs/cloud-ledger.md)。
- 搬家是三个走**平台运营方白名单**（集合 `platform_admins`，`_id` = openid，fail-closed）的运维 action：`checkAggregates`（只读预检，核心是纯函数，**控制台导出 `ledgers` 就能在本机跑** `node scripts/check-ledger-export.js`，不用先部署）、`migrateRecords`（搬家，带 `rollback` / `dropLegacy` / `snapshots` / `dropSnapshotLegacy` 四个模式，`snapshots` 把升级前存的清空快照也转过来，不跑那几家店的「恢复清空前数据」会永久报错；**`dropLegacy` 2b-3 起从可选优化变成上线前置**——必须在部署 2b-3 版云函数**之前**逐店跑完（三家店已于 2026-08-25 跑完），那一版记账不再携带 `ledgers.records`，顺序反了每家店的第一笔账就是一次无守卫的隐式清空；`dropSnapshotLegacy` 在 `dropLegacy` 之后收掉快照里那份重复的 `records` 数组——闸是 `dropLegacy` 盖的 `legacyDroppedAt` 戳，不是「数组空了」这种派生状态）、`recomputeAggregates`（聚合漂了按集合现状重折叠，**它不修错账**）。客户端一个入口都没有，只从开发者工具 Console 调；`deleteShop` 保持 owner-gated，不跟着换。详见 [docs/cloud-ledger.md](docs/cloud-ledger.md) 的「账本升级」。
- 平台级维护开关在集合 `platform_config` 的 `maintenance` 文档，`setMaintenance` / `getMaintenance` 同样走平台运营方白名单；维护期写操作由**服务端**硬拦（白名单放行读和运维动作）。开关读失败一律 **fail-open**（当没在维护）——和 `platform_admins` 的 fail-closed 方向相反，理由是两道门拒绝的东西代价不在一个量级，详见 [docs/cloud-ledger.md](docs/cloud-ledger.md) 的「维护模式」。
- `app.json` 的 `lazyCodeLoading` 仍须保留；`cloudfunctions/` 不进小程序包。详见 [docs/cloud-ledger.md](docs/cloud-ledger.md)。
- 商品图：图片二进制放云开发存储，商品记录只存 fileID（`shops/{shopId}/products/` 前缀，客户端压缩后直传）；服务端校验前缀、换图/删商品/恢复清空时在事务提交后清理旧文件。云存储权限 READWRITE 由 `node scripts/wxcloud-ensure-acl.js` 一并设置。详见 [docs/cloud-ledger.md](docs/cloud-ledger.md) 的「商品图与云存储」。
