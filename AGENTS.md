# Agent 说明

本仓库约定写在仓库文档里，不写在 `.cursor/`。改任何文件之前先读对应文档并遵守。

## 必须先读

1. [docs/git-workflow.md](docs/git-workflow.md)：从 `main` 新建 worktree 和分支。不满足这一条就不要改文件。
2. [docs/code-injection.md](docs/code-injection.md)：按需注入、用时注入、分包时机、代码质量扫描。

## 硬约束（摘要）

### Git

- 禁止在主工作树（`inventory-miniapp-main`）和 `main` 上改文件。也不要从历史分支 `master` 开新任务。
- 每次任务：`git fetch origin`（有远程时）→ `git worktree add -b <前缀>/<短名> ../inventory-miniapp-<短名> origin/main`（无远程则基线用 `main`）→ **把工作区切到新目录** → 再改文件。
- 主工作树永远停在 `main`，不要在里面切换分支。
- 不要复用上一任务的工作树做下一件无关的事。

### 代码注入

- `app.json` 必须保留 `"lazyCodeLoading": "requiredComponents"`（若尚未写入，在注入/组件相关任务的工作树里补上，之后不得删除）。
- 不要把低频自定义组件写进 `app.json` 的全局 `usingComponents`。
- 页面 JSON 只声明本页真正用到的组件。
- 非首屏重组件才配 `componentPlaceholder`；首屏立刻展示的组件不要配。
- 当前没有自定义组件时，不要为了用时注入去硬拆页面。
- tabBar 页面必须留在主包。
- `lazyloadPlaceholderEnable` 只用于调试占位态，日常保持 `false`。
- 不要只把约定写进 `.cursor/rules/`；有新约定就更新 `docs/`，并在本文件补上入口。
