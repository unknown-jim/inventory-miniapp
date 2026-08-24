# UI 自动化测试

`npm run test:ui` 用 `miniprogram-automator` 驱动**真实的微信开发者工具**，把六段操作从头点一遍：填充示例数据 → 销售出库并核对送货单 → 流水详情与再次导出 → 期初欠款 → 收款 → 店铺清空。

这是仓库里唯一一条能证明「页面点得动」的测试。`npm test` 那十几项都是纯 Node，跑的是 `utils/` 里的逻辑和静态检查，碰不到渲染层。

## 怎么跑

三个本机前提，缺一条都跑不起来：

1. 装了微信开发者工具（默认找 `C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`，位置不同就设环境变量 `WECHAT_CLI`）
2. 工具里**已登录**（扫码）
3. 工具 → 设置 → 安全设置 → **服务端口**已打开

```bash
npm run test:ui
```

脚本自己用 `cli auto` 把工具拉起来、开自动化端口 9420，跑完再 `close` 掉。端口上若还留着上一次的会话，会先把工具整个退掉再重开——同一个端口连不同 worktree 的项目是抢不过来的，以前就这么测成了另一棵树的代码。

### 在任务 worktree 里跑：先补两个没进版本库的文件

在任务工作树（`../inventory-miniapp-worktrees/<短名>`，见 [git-workflow.md](git-workflow.md)）里跑 `npm run test:ui` / `npm run test:all` 之前，除了复制 `node_modules`，**还要把主检出的 `project.private.config.json` 也复制过去**：

```bash
cp -r /d/work/inventory-miniapp/node_modules ./node_modules
cp /d/work/inventory-miniapp/project.private.config.json ./
```

两个文件都在 `.gitignore` 里，所以 `git worktree add` 出来的目录里没有它们。少了 `node_modules` 会当场报模块找不到，好认；少了 `project.private.config.json` 不报错，反而更难查——它钉着 `libVersion: 3.16.2`，以及 `useApiHook` / `useIsolateContext` / `compileHotReLoad` 等一串开发者工具设置。缺了它，工具会按「全新项目」的默认值打开这棵树，UI 测试就以**互不相同**的初始化/超时症状随机挂掉。典型标志是日志里那句：

```text
[UI] Tool.getInfo 一直没带 SDKVersion，跳过基础库版本校验
```

实测（2026-08-24，同一份代码，主检出和 worktree 交替跑）：

| 环境 | 结果 |
|---|---|
| 主检出 `main` | 连过 2 次 |
| 缺 `project.private.config.json` 的 worktree | 连挂 3 次，三次症状各不相同：`退不回 tab 页，页面栈太深` / `Connection closed, check if wechat web devTools is still running` / `timeout waiting for automator response` |

三次挂的**没有一条是断言失败**。所以：worktree 里 UI 测试红、而且症状是初始化或超时类（连不上、等不到、页面栈不对）而不是某条断言不符，先查这个文件在不在，别急着当成代码回归去翻 diff。

## 两条硬约束

### 1. 页面级选择器查不到自定义组件内部

实测（2026-08-23，开发者工具 2.02.x + `miniprogram-automator` 0.12.1）：`slip-overlay` 开了 `virtualHost: true`，页面侧压根没有它的宿主节点，下面五种写法**全部返回 0**：

| 写法 | 结果 |
|---|---|
| `page.$$('.js-slip')` | 0 |
| `page.$$('slip-overlay >>> .js-slip')` | 0 |
| `page.$$('slip-overlay')`（宿主节点本身） | 0 |
| 页面内 `createSelectorQuery().selectAll('.js-slip')` | 0 |
| `selectComponent` / `selectAllComponents`（tag、class、id 三种写法） | 全 null / 0 |

所以：**组件内部的内容一律核对页面数据，不查 DOM。**

送货单就是 `page.data().slip`（`shopName` / `operatorText` / `customerName` / `paidText` / `lines[]`，由 `utils/util.js` 的 `withSlipView()` 拼出），关闭走 `page.callMethod('closeSlip')`，判断是否弹出看 `showSlip && slip`。用例里封装成了 `waitSlipOpen()` / `assertSlip()` / `closeSlip()`。

`page-loading` 同样是 `virtualHost`：等页面就绪一律用 `waitPageReady()`（读 `pageLoading` 字段），不要去查加载态的节点。

**代价要认：** 数据对、但组件里字段绑错导致屏幕上不显示，这版用例查不出来。要验渲染只能靠 `miniProgram.screenshot()` 人眼看。

### 2. 所有等待必须走 `waitFor(page, target, label)`

automator 的 `page.waitFor` 底层是 `licia/waitUntil`，而且**没传 timeout（0 = 无限轮询）**。直接用它，选择器一旦过期就是静默挂死，不报错、不退出。

`tests/ui.test.js` 里因此包了一层：

```js
await waitFor(sale, '.js-add-cart', '出现 .js-add-cart')   // 选择器
await waitFor(sale, async function () { ... }, '商品进购物车')  // 条件
```

- 单步默认 30 秒，`WECHAT_AUTOMATOR_STEP_TIMEOUT` 覆盖
- 整轮默认 15 分钟，`WECHAT_AUTOMATOR_RUN_TIMEOUT` 覆盖
- 超时消息带 `label`，直接说清在等什么：`等「出现 .js-seed」超时（30 秒）`

只有纯 sleep（`page.waitFor(800)`）可以直接调，它不存在等不到的情况。

**不要**在用例里写 `await page.waitFor('.js-xxx')`。

## 改 wxml 时的检查清单

- [ ] 新增或改名 `js-` 钩子后，`grep` 过 `tests/ui.test.js`
- [ ] 把页面里的块抽成自定义组件后，确认该块上的 `js-` 钩子在测试里**全部失效**了——要么把断言改走页面数据，要么把钩子留在页面模板一侧（`record-edit` 的「导出送货单」按钮 `.js-export-slip` 就还在页面里，所以还能直接点）
- [ ] 跑过一次 `npm run test:ui`

## 一次真实事故

2026-08-18 的 `bf8f6d7` 把加载态和送货单弹层抽成自定义组件，没有同步改 `tests/ui.test.js`。当时 UI 测试因为 Node 24 禁止 spawn `.bat`、工具 2.02 的 `Tool.getInfo` 不带 `SDKVersion` 等问题本来就跑不起来，直到 2026-08-23 的 `7d1f12b` 把脚手架修好，再跑才暴露出来。

暴露的样子值得记一笔：销售流程**全部成功**——库存从 42 扣到 41、单号 `SH20260823-H9ZH` 生成了、弹层在模拟器里画得好好的，只有 `waitFor('.js-slip')` 永远等不到，于是整个测试无声挂了二十多分钟，既不报错也不退出。

两个教训就是上面那两条硬约束：**跨不进组件**，以及**等待没有超时**。

## 排查

跑失败时脚本会打印一份编号清单，按它查。踩过的坑：

- 端口被上一次没退干净的工具占着——脚本会先 `cli quit`，退不掉就手动关工具
- `cli.bat` 切 UTF-8 代码页后被 cmd 误解析、把注释里的 `CLI` 当命令递归调自己，刷屏「Maximum setlocal recursion level reached」——脚本已把工具安装目录从子进程 `PATH` 上摘掉
- `automator.launch()` 不能用：Node 18.20.2 / 20.12.2 起禁止不带 shell 地 spawn `.bat`，而且报错会被转述成误导性的「cliPath 不对」。脚本改成自己经 `cmd.exe` 起端口再 `connect`
- `wx.showModal` 是系统弹窗，自动化点不到内部按钮，用 `mockWxMethod` 自动确认
- 在任务 worktree 里跑，却没从主检出复制 `project.private.config.json`——挂的样子是随机的初始化/超时，不是断言失败，见上面「在任务 worktree 里跑：先补两个没进版本库的文件」
