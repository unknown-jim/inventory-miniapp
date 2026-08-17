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

## 硬约束（摘要）

### Git

- 禁止在主工作树（`inventory-miniapp-main`）和 `main` 上改文件。也不要从历史分支 `master` 开新任务。
- 每次任务：`git fetch origin`（有远程时）→ `git worktree add -b <前缀>/<短名> ../inventory-miniapp-<短名> origin/main`（无远程则基线用 `main`）→ **把工作区切到新目录** → 再改文件。
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
- 库存调整只改件数，不计入进货、销售、毛利和欠款，也不改进价。详见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)。
- 上线前欠款走期初往来，不拿销售去凑；不改库存、不计入销售和毛利。
- 能不能换某一根轴、先改再卖还是当场改：现场规矩，不要写成软件限制。
- 给操作便利（种类模板带出待选项、多规格可同价），不要给行业裁判。详见 [docs/accounting-vs-policy.md](docs/accounting-vs-policy.md)。
- 操作界面不要写小于 `--fs-xs` 的字号、不要写小于 `--tap-sm` 的可点高度。新页面用 `app.wxss` 共用布局类，根节点 `class="page"`。送货单除外。详见 [docs/ui-scale.md](docs/ui-scale.md)。

### 云开发

- 业务库只允许云函数 `ledger` 读写。小程序禁止 `wx.cloud.database()` 访问 `shops` / `members` / `ledgers` / `ledger_clears`。
- `utils/cloud-config.js` 必须有明确的环境 ID 才记账；填开发者工具「云开发」里的 ID，不要填腾讯云控制台另一套环境，也不要依赖「第一个云环境」。
- 部署 `ledger` 用微信云托管 CLI；密钥只放环境变量 `WXCLOUD_PRIVATE_KEY`，步骤见 [`.cursor/skills/wxcloud-cli/SKILL.md`](.cursor/skills/wxcloud-cli/SKILL.md)。不要用腾讯云账号的 `tcb` 管微信侧环境。
- 改 `utils/inventory.js` 或 `utils/ledger-apply.js` 后运行 `npm run sync:ledger-inventory`，保持云函数副本一致。
- `app.json` 的 `lazyCodeLoading` 仍须保留；`cloudfunctions/` 不进小程序包。详见 [docs/cloud-ledger.md](docs/cloud-ledger.md)。
