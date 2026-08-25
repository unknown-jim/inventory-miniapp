# Git 工作树与分支

任何会改仓库文件的工作（功能、修复、文档、配置）都必须：**从 `main` 新建一条分支，并在新的 git worktree 里改**。不要在主工作树、不要在 `main` 上直接改。

本约定由仓库维护者指定，不是可选项。

GitHub 默认分支是 `main`（`origin/main`）。远程或本地可能还留着历史分支 `master` / `origin/master`，**不要拿它当基线**。

目录名 `inventory-miniapp-main` 只是主工作树的文件夹名，不是分支名。

## 目录约定

| 角色 | 路径 |
|---|---|
| 主工作树（只留 `main`，保持干净） | `inventory-miniapp-main`（本仓库主检出） |
| 任务工作树 | `../inventory-miniapp-worktrees/<短名>` |

任务工作树全部收在 `../inventory-miniapp-worktrees/` 一个目录里，不再平铺在主仓库同级，避免和其他项目混杂。

主工作树永远停在 `main`，不要在里面 `checkout` 到别的分支。若主工作树还停在历史分支 `master`，先一次性切到 `main` 对齐默认分支，再开新任务。

## 开新任务

在**主工作树**执行（有远程时先更新基线）：

```bash
git fetch origin
git worktree add -b <前缀>/<短名> ../inventory-miniapp-worktrees/<短名> origin/main
```

没有 `origin` 时，基线用本地 `main`：

```bash
git worktree add -b <前缀>/<短名> ../inventory-miniapp-worktrees/<短名> main
```

然后进入新目录再改文件：

```bash
cd ../inventory-miniapp-worktrees/<短名>
```

用 Cursor / Agent 时：建好工作树后，必须把工作区切到新目录，再开始改文件。

### 分支名前缀

| 前缀 | 用途 |
|---|---|
| `feat/` | 功能 |
| `fix/` | 修复 |
| `docs/` | 只改文档或约定 |
| `chore/` | 工具、依赖、杂项 |

短名用英文小写和连字符，例如 `docs/code-injection`、`feat/lazy-code-loading`。

每个**独立任务**一条新分支、一棵新工作树。不要把无关改动堆进已有任务的工作树。

## 不要做

- 在 `main` 或历史分支 `master` 上改文件、提交、或把未提交改动直接带进新分支。
- 从 `origin/master` 或本地 `master` 开新任务。
- 从功能分支再分出新任务（除非明确是同一任务的后续）。
- 在主工作树切换分支来「省事」。
- 复用上一任务的工作树做下一件无关的事。
- 基线过期：有 `origin` 却不 `fetch`，从旧的本地 `main` 开工。

## 过程文档不进仓库

调查报告、审计报告、派工 prompt、交接/回报、迁移清单 —— 这些都**不提交到本仓库**，放在仓库外的 handoff 目录：

```
~/work/inventory-miniapp-handoffs/
```

理由：仓库只放长期资产。过程材料是一次性的，没人清理，结论烂得很快——后来的 agent 读到过期报告，会去修一个已经不存在的 bug。把它挪进 `docs/` 不改变这个结局。

**命名约定：**

| 形态 | 文件名 | 写入规则 |
|---|---|---|
| 派工 | `<任务>-<日期>.md` | 写完不改 |
| 回报 | `<任务>-result-<日期>.md` | 写完不改 |
| 多轮 | `<任务>-roundN-<日期>.md` | 每轮开新文件，不在旧文件上叠加 |
| 长寿计划 | `<主题>-PLAN.md`（不带日期） | 反复重写，见下 |

前三种是一次性的，天然不腐烂。**只有长寿计划文档需要额外规矩**——它跨全程反复重写，不管就会被回灌成一坨（背景知识、每轮交接、已完成清单全往里堆，剩余工作反而找不到）：

- 文档头部必须有「这里不放什么、它在哪」对照表
- 条目做完**直接删**，不要改成 `[x]` 留着；不设「已完成」「变更历史」小节
- 状态用条目 ID 从 `git log --grep=<id>` 派生，不在文档里维护
- 写明行数预算；超了按当前状态**重写**，不是 diff

完整机制见 `engineering-discipline` skill 的 `Long-Lived Plan Documents` 一节。

**可以进仓库的**：代码、测试、项目规则和文档、长期规范、复盘。拿不准就别进。确实需要进的，先说清楚是什么、为什么不放 handoff 目录、放哪儿，得到同意再提交——不要先提交再问要不要删。

## 收尾

合并进 `main` 且不再需要该目录后，在主工作树执行：

```bash
git worktree remove ../inventory-miniapp-worktrees/<短名>
git branch -d <前缀>/<短名>
```

未合并的分支不要用 `-D` 强删。

提交说明和 Pull Request 怎么写，见 [commit-and-pr.md](commit-and-pr.md)。

## Agent 检查清单

改任何文件之前：

- [ ] 当前目录不是主工作树里的 `main` 检出
- [ ] 当前分支是本次任务新建的，并且从最新 `main`（有远程则是 `origin/main`）长出来
- [ ] 没有从 `master` / `origin/master` 起步
- [ ] 工作区已经切到对应 worktree 目录
- [ ] 没有把这次任务的文件写进主工作树
