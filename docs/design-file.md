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
- 货号（一个货号 = 一个商品，条码才到规格级）：纯棉四件套 = S-001、全棉斜纹布 = S-007；亚麻窗帘布 / 枕芯 / 夏凉被**未填**。货号为空则商品卡货号行整行不渲染，所以 Screen/02 四张卡只有四件套出这一行；picker 变体 `b5PickS4`（窗帘布）的空串**是有意留空、不是漏填**。2026-09-02 补进对照表前，S-001/S-007 一直是无出处的自编号。

新样张从表取数，不许自编；改交互规则必须同步改对照表。「去收款」桥只在**仍有剩余欠款**时出现——销售挂欠后的完成 toast 带桥是正确示范，退货冲完即清不带（否则点进去是无款可收的客户）。

## Token 与语义

- 三层变量：Primitive（brand / red / neutral…）→ Semantic（fill/action、text/muted、text/debt…）→ Component（尺寸、圆角、动效）。
- 小字灰一律绑 text/muted（62% 黑）；红色的三种语义（欠款金额 / 危险动作 / 库存预警）见 STRING 变量 color/red-semantics。
- **禁用不要用 `fill/action-disabled` + `text/disabled`**（= `neutral/200` + `neutral/400`，合成只有 2.02:1）。各档配方与「禁用一律不透明、≥3:1」这条裁定见 [ui-scale.md](ui-scale.md#chip-的颜色铁律)。2026-08-30 收敛后这两个 token 在稿上已零引用。
- 品牌青绿只做非语义场合的小剂量点缀（毛利 stat 数字、空态插画描边、border/focus 聚焦）；主行动一律黑，tabBar 不上品牌色——这两条是历轮评审的刻意决策，不要回退。
- **图标描边与它同态的标签同色。** tab on 图标 = `selectedColor` = neutral/900，off 图标 = `tabBar.color` = text/muted。2026-09-02 前 off 图标被漏在 `neutral/400` 上（2.52:1），比正下方自家标签浅一档；判据是 on 态两者分毫不差，可见规则本就是「图标 == 标签」。当时还把这个差异写进 `pack-refs` 的断言注释、说成「稿自己就分开的」——**两个值不一样时先问是意图还是遗漏，别急着把差异写成依据**。
- **非文字的 UI 部件边界，白底上 ≥ 3:1**（WCAG 1.4.11）。`neutral/400`（#A3A3A3）只有 2.52:1，不要再用于图标、边框、未勾选态。2026-09-02 已把搜索框放大镜、tab off 图标、7 个未勾复选框边框、`ph/备注` 从它上面移走；稿上现在只剩「微信胶囊·勿占用」占位与作废件还绑着它，那两处是有意留灰。为此给 `text/muted` 补了 `STROKE` scope（原先只有 `TEXT_FILL`，而 `text/faint` 早已是 `TEXT_FILL` + `STROKE`）。
- **wxss 里 `data:image/svg+xml` 内联图标的颜色是个盲区**：写成 `%23A3A3A3`，主题色 grep 搜 `#A3A3A3` 搜不到，PNG 的逐像素断言也够不着。2026-08-31 那 13 个批次因此完整漏过它。现由 `tests/wxss-wxml.test.js` 的允许清单守着，新色必须登记并写明凭什么。

## MCP 改稿的坑（2026-08-28 实战记录；8–10 为 2026-08-29 补，11–15 为 2026-08-30 补，16 为 2026-08-31 补，17–20 为 2026-09-02 补）

用 Ardot MCP 的 `batch_edit` 改稿时踩过这些，复查时可少走弯路：

1. **文本字符写入通道会出现服务端脏缓冲**：`U(content/characters)` 不是替换，而是把历史载荷拼接进目标；带内容的 `I()` 会灌入同文件其他节点的旧文本。读回 `characters` 出现多段拼接即可确诊。只有字符写入受影响——结构、样式、颜色、复制、删除、变量操作全部正常。
2. **绕过通道**：`apply_variables` 建 STRING 变量，再 `U(node, {content: "$:集合:变量"})`。内容绑定通道干净。代价是文案挂在变量集（本稿为 `FixText` 集），编辑器里双击改字不再生效；应在正常编辑会话把文案誊回内联文本后删掉该变量集。
3. **改组件公共子节点前先列实例**：组件的 body 是所有实例的默认值，替换它会丢掉各实例自己的覆盖（confirm-danger 换 body 后，「移出成员」「放弃改动」两个弹窗的 body 一度落回删除流水的默认文案）。
4. **实例后代路径用字面量** `"实例id;子id"`；用 binding 拼接（`v+";child"`）会生成双分号，报 not found。
5. **Move 之后布局尺寸会被重解析，两个轴都会。** 竖排里 `fill_container` 的子节点 Move 进横排后，width 会解析成固定值，撑爆容器裁掉兄弟节点；反过来把固定宽的卡 Move 进宽 Row，width **和 height** 会双双变成 FILL（实测三张 343×335/199/236 的卡一度被拉成 812 高）。Move 之后把两个轴的 `layoutSizing` 都显式设回去，再复读一次实际宽高。
6. **别名变量（VARIABLE_ALIAS）在 fill 简写路径不解析**（如 fill/brand-accent），会回落默认色并报 warning；要绑 Primitive 本体或写完整 `fills` 数组。写完整数组时，变量要放在 **`boundVariables.color`** 里，不是写成 `color: "$3:84"` 字符串——后者仍走简写路径，一样不解析。曾经有一轮因为只试了「绑 Primitive」这一条就把它记成工具限制，其实第二条路是通的。2026-09-02 再次复现：`fills: ["$3:84"]`（`text/warning`，也是 VARIABLE_ALIAS）静默失败，写完整 paint 数组 + `boundVariables.color` 才落进去。
    **但「放在 `boundVariables.color` 里」这句话本身会被误读成写字符串，那是错的**（2026-09-03 实测）：`boundVariables: {color: "$3:13"}` 直接被拒，`potentialIssues` 明说 `Expected object at [0].boundVariables.color, but received 'string'`。要写成 alias 对象：

    ```
    fills: [{ type: "SOLID", color: {...}, boundVariables: { color: { id: "VariableID:3:13", type: "VARIABLE_ALIAS" } } }]
    ```

    这一条是本坑里唯一**会当场报错**的写法（不像简写路径那样静默回落），所以撞上了反而好办——照上面改就行。
7. `capture_layout` 开 `problemsOnly` 时，大 Row 报 oversized container 是画布常态（Row 本身是 fill_container）；要盯的是 `OUTSIDE_PARENT` 和 `MissingContent`。
8. **变量绑定通道不是无副作用通道**：给组件子节点 `U(content: "$:FixText:xxx")` 干净，但绑定会继承进所有实例，把实例原有的 characters 字面量覆盖冲掉（实测一次冲掉 stat/block 8 实例 24 个文字槽加两处流水行金额）。绑之前先列实例、核对哪些实例带 characters 覆盖；被冲的实例按改前取证的原值逐个绑回各自的变量。同理要警惕：改组件默认样张前先想清楚实例都覆盖了什么。
9. **往组件里插 svg 子框，子框会被放到远处坐标**：`I(组件, {type: "frame", svg: ...})` 建出的子框 x/y 实测落在其他画布位置（如 1619,18948），组件和全部实例因此渲染空白。插入后立刻把子框 x/y 归零；判定「新节点截图空白」先读 `absoluteBoundingBox` 再定性，不要想当然归咎渲染缓存。
10. **截图渲染滞后于节点数据**：`capture_screenshot` 可能长时间显示旧内容（旧文案、旧样式、甚至别的变体的字），新写入的节点尤其明显。对数与样式判定一律以 `batch_read` 实时数据为准，截图异常先查数据再定性——2026-08-29 两轮审计共 6 条「发现」因此作废。反过来，数据正确但渲染卡死不追（同一文案长期显示旧值）时，给该节点走一次变量绑定通道可强制渲染器重解析。

11. **清空 STRING 键之前，必须跑一遍带 `resolveInstances` 的全稿零引用扫描**。页面 TEXT 搜索**看不见实例路径上的覆盖**，这是系统性假阴性——一次「合并同值键」照着页面搜索的结果清空，冲空了两个屏上可见的文字节点（看板首条流水金额、销售清单规格副行），下一轮才被 `capture_layout` 的 `ZERO_SIZE` 抓到。做不到零引用扫描就不要清。`apply_variables` 只能清空值、不能删键，所以「少几个键」的收益远小于风险；无引用的键**登记**去向即可，不要清空。
12. **改组件本体的几何之后，必须复跑所有引用屏的 `capture_layout`**。给 `chip/取值·可删` 加 44×44 的 × 热区，每枚 chip 宽了约 24px，模板编辑页的取值行因此从一行折成两行（超容器 3px），把「删除模板」整行推出可视区——而那一屏的注释白纸黑字写着「开关与删除必须完整可见」。改本体时下游是看不见的。
    配套做法：动手**之前**把两页 `capture_layout(problemsOnly: true)` 的原始输出落盘，改完再跑一次做**集合 diff**。「零新增裁切」要能靠 diff 证明，靠逐条归因旁证不算。
13. **`I()` 建 TEXT 不继承文件字体**，默认落到 Sarasa Gothic SC，字宽随之变化（实测每枚 +1px），在余量只剩个位数的容器里足以引发折行。新建文字节点后显式设字体，或干脆改用已有本体的实例。
14. **`C()` 复制 COMPONENT 得到的是 INSTANCE，不是新本体。** 要建本体只能新建，不能复制。
15. **绑变量的 paint，它的 opacity 由变量自身的 alpha 决定；你写进去的 paint 级 opacity 会被静默丢弃。** 给一枚 `{color: #6B7280, opacity: 0.5}` 的画笔绑上 alpha=1 的 token，透明度直接变成 100%——三种写法（`color` 简写 / 显式 `boundVariables` + 字面 color + opacity / 先写字面量再单独补绑定）全都拦不住，最后一种的绑定写入干脆是 no-op。实测全稿 3715 个节点的每一枚 paint，「paint.opacity ≠ 所绑变量 alpha」的例外是 **0**——这套模型没有「绑 token + 独立画笔透明度」的表达位。
    所以：**要保留画笔透明度就别绑 token**（或者给那个颜色建一枚自带 alpha 的变量）。而且**验收颜色一律用 `resolveVariables` 读回完整 paint 对象**——`batch_read` 的 token 简写会把 paint 级 opacity 藏掉，一次绑定把商品卡相机角标从「几乎看不见的浅灰」变成「实心深灰蓝」（ΔE00 22），实施者自查时报的却是「几乎恒等」，就是这么漏的。
16. **`batch_edit` 在写入被拒时照样回 `success: true`，唯一的真信号是 `potentialIssues`。** 画布只读（编辑器处在 Dev Mode）时，一次 `U(node, {strokes: ...})` 返回的 `operations[].updated` 字段**回显的是旧值**——看起来像「写进去了、只是值没变」，实际是一个字节都没落。只有 `potentialIssues` 里那句 `failed to apply "strokes" — Setting the property "strokes" is not allowed in read-only mode` 能看出真失败。所以**任何写入之后都要用 `batch_read` 复读验证**，不要拿 `success` 或 `updated` 当验收依据；验收颜色仍按坑 15 用 `resolveVariables: true` 读完整 paint 对象。
    **`fetch_file_info` 的两个字段都判不出能不能写。** `permission` 在只读状态下照样返回 `readwrite`；`fileUrl` 里的 `&m=dev` 也不行——2026-08-31 实测，编辑器切回设计模式、写入已经成功之后，`fileUrl` 里的 `&m=dev` **仍然在**（`cocraft://localhost/file/718738891083099?node_id=3%3A159&m=dev`）。它跟着当前选中节点更新 `node_id`，说明连接是活的，但 `m=dev` 这一段是打开文件时定死的，不反映当前模式。中间那一轮据此判定「还锁着」是误判。
    **唯一可靠的判据是试写一次**：发一条最小的 `U()`，看返回里有没有 `potentialIssues`——有 `read-only mode` 就是锁着，没有 `potentialIssues` 且 `updated` 回显新值就是通了，再 `batch_read` 复读坐实。真锁着时没有绕过路径，只能请人把编辑器切回设计模式；但**判断锁没锁要靠试写，不要靠读 URL**。

    **试写的值必须和现值不同，否则探测会卡在「看不出结论」上**（2026-09-02 实测）。那次探测发的是 `U("3:731", {gap: 16})`，而该节点 gap 本来就是 16——`updated` 回显 `{gap: 16}`，在「真写进去了」和「被拒后回显旧值」两种情况下**一模一样**，执行者据此判定探测无效、卡住重来。
    严格说这只废掉了 `updated` 这条**次要**佐证：`potentialIssues` 是主判据，它出不出那句 `read-only mode` 跟你写什么值无关，值相同时照样有效。但上一段的判据写成了「没有 `potentialIssues` **且** `updated` 回显新值」这个合取式，值相同时后半个条件无从判定，人就会以为整条判据失效。
    所以两件事一起记：判据以 `potentialIssues` 为准，`updated` 只是佐证；而探测时**挑一个当前值已知、且故意写成别的值**的属性，验完再改回去，佐证和主判据就都能用上——「最小试写」的最小是指**操作条数**，不是指改动量。

17. **`I()` 建不出 INSTANCE，而且照样回 `success: true`。** 想插一个组件实例时 `I(parent, {type: "INSTANCE", mainComponent: ...})` 会失败，`potentialIssues` 里点名 `Unsupported node type: INSTANCE`，但 `success` 仍为真、`operations` 是空数组（一手实测：发过一条最小 `I()` 坐实）。要建实例得用 `C(本体, 父)` 复制。这是坑 16 的同一个病灶在另一条操作上的表现：**成功与否只看 `potentialIssues`**。

18. **`visible: false` 的子节点不参与自动布局回流。**（**二手：来自 2026-09-01 改稿会话的报告，本仓未独立复现**；描述的是排错方向，最坏是白查一次，不像坑 15/16 那种照做会写坏稿。） 它的 `x/y` 停在被隐藏之前的位置，于是 `capture_layout` 会把它报成「超出父容器 17px」之类。看到 overflow **先查 `visible` 再查几何**——按提示去缩字号、改行高全是南辕北辙。处理是手工把隐藏节点的 y 挪回可见区。

19. **`batch_edit` 的操作行不能写 `const`。** `const a = I(...)` 会被整行判为 unparseable 并**整条跳过**，绑定名也不存在了，后面引用它的操作跟着连锁失败。只能写裸绑定 `a = I(...)`。和坑 16/17 同一个病灶：`success` 仍是 true，唯一信号还是 `potentialIssues`。

20. **`I()` 不接受第三个 index 参数，新节点静默追加到父容器末尾。** 要控制插入位置，得 `I()` 建完再 `M(node, parent, index)` 补一刀——`M` 的 index 是生效的。同容器内 Move 不破坏 `fill_container`（2026-09-02 实测 12 次 Move 后复读全部仍是 fill_container），所以这一步不必担心坑 5；坑 5 说的是**跨容器**且主轴方向变化的 Move。

## 过程文档不进仓库

审计报告、交接回报、改稿清单等一次性材料放 `~/work/inventory-miniapp-handoffs/`，规则见 [git-workflow.md](git-workflow.md)。本文档只收长期有效的结构与工具约定。
