# 设计稿（Ardot）与改稿约定

小程序的高保真设计稿不在本仓库，是 Ardot 云文件：

```
https://ardot.tencent.com/file/718738891083099
```

两页画布：**组件库**（全部可复用组件与变量）和**核心页面**（按流程组织的成屏高保真）。设计稿是页面结构、交互规则和演示账的权威来源；字号、热区、密度与 [ui-scale.md](ui-scale.md) 同源，实现前先读稿、改 UI 先对稿。

## 结构约定

核心页面由「Row」组成，**一行 = 一个流程**：Screen（375×812）+ UX注释卡 + 该流程的 sheet / dialog / 变体 / caption。

| 元素 | 命名与位置 |
|---|---|
| 主屏 | `Screen/NN`，NN 对应 Row 编号 |
| 派生屏 | `Screen/NNb` / `NNc`（01b 低库存列表、02b 盘点、02c 键盘弹起、08b 全可退 0、09b 客户编辑） |
| 弹层 | `sheet/xxx`、`dialog/xxx`、`slip/xxx`，放在触发它的流程行 |
| 注释 | 每屏一张 `UX注释/xxx` 卡；屏与屏之间的行内说明用 `↓` 开头的 caption |
| 全局态 | Row/00 骨架：全局阻断态 4 种、空态 / 加载态示例 |

**不要建「补丁堆」行。** 评审期临时攒的组（如曾经的 Row/18「补齐缺失屏」）验收完要拆回各流程行：caption 说明随迁、组件跟触发流程走、交叉引用同步改，然后把空壳组删掉。

## 演示账纪律

页面顶部「演示账对照表」是样张取数的**唯一来源**（演示今天 = 2026-08-25）：

- 王姐销售单 S20260825-014：应收 ¥352 / 实收 ¥268 / 欠 ¥84 / 毛利 ¥100
- 退货① 窗帘布 ¥96 = 冲欠款 ¥84 + 退现金 ¥12（冲完即清，toast 不带「去收款」桥）；退货② ¥128 全退现金
- 进货 25 件 ¥2,375；李老板欠 ¥1,500 已清（其 ¥2,300 销售单 = 08-24）；王姐预收 ¥200

新样张从表取数，不许自编；改交互规则必须同步改对照表。「去收款」桥只在**仍有剩余欠款**时出现——销售挂欠后的完成 toast 带桥是正确示范，退货冲完即清不带（否则点进去是无款可收的客户）。

## Token 与语义

- 三层变量：Primitive（brand / red / neutral…）→ Semantic（fill/action、text/muted、text/debt…）→ Component（尺寸、圆角、动效）。
- 小字灰一律绑 text/muted（62% 黑）；禁用 = fill/action-disabled + text/disabled；红色的三种语义（欠款金额 / 危险动作 / 库存预警）见 STRING 变量 color/red-semantics。
- 品牌青绿只做非语义场合的小剂量点缀（毛利 stat 数字、空态插画描边、border/focus 聚焦）；主行动一律黑，tabBar 不上品牌色——这两条是历轮评审的刻意决策，不要回退。

## MCP 改稿的坑（2026-08-28 实战记录）

用 Ardot MCP 的 `batch_edit` 改稿时踩过这些，复查时可少走弯路：

1. **文本字符写入通道会出现服务端脏缓冲**：`U(content/characters)` 不是替换，而是把历史载荷拼接进目标；带内容的 `I()` 会灌入同文件其他节点的旧文本。读回 `characters` 出现多段拼接即可确诊。只有字符写入受影响——结构、样式、颜色、复制、删除、变量操作全部正常。
2. **绕过通道**：`apply_variables` 建 STRING 变量，再 `U(node, {content: "$:集合:变量"})`。内容绑定通道干净。代价是文案挂在变量集（本稿为 `FixText` 集），编辑器里双击改字不再生效；应在正常编辑会话把文案誊回内联文本后删掉该变量集。
3. **改组件公共子节点前先列实例**：组件的 body 是所有实例的默认值，替换它会丢掉各实例自己的覆盖（confirm-danger 换 body 后，「移出成员」「放弃改动」两个弹窗的 body 一度落回删除流水的默认文案）。
4. **实例后代路径用字面量** `"实例id;子id"`；用 binding 拼接（`v+";child"`）会生成双分号，报 not found。
5. **竖排里 `fill_container` 的子节点 Move 进横排后**，width 会解析成固定值，撑爆容器裁掉兄弟节点；Move 之后重设一次 `fill_container`。
6. **别名变量（VARIABLE_ALIAS）在 fill 简写路径不解析**（如 fill/brand-accent），会回落默认色并报 warning；要绑 Primitive 本体或写完整 `fills` 数组。
7. `capture_layout` 开 `problemsOnly` 时，大 Row 报 oversized container 是画布常态（Row 本身是 fill_container）；要盯的是 `OUTSIDE_PARENT` 和 `MissingContent`。

## 过程文档不进仓库

审计报告、交接回报、改稿清单等一次性材料放 `~/work/inventory-miniapp-handoffs/`，规则见 [git-workflow.md](git-workflow.md)。本文档只收长期有效的结构与工具约定。
