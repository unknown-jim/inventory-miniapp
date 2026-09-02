# UI 自动化测试

## 每一批 UI 改动合并前跑什么（先读这一节）

接下来 28 个屏要按新稿一批批改。**每批合并前照下面三步走**，这三步挡的是最贵的两类失败：整个工程编译不出来、以及跨批相互作用。

### 第 1 步 · `npm test`（约 20 秒，不开开发者工具）

**改了 wxss / wxml 就必须跑，而且它值这 20 秒。** 里面的 `tests/wxss-wxml.test.js` 专治 2026-08-30 PR #93 那一类：块注释里写了 `*/`（`.btn-*` 后面紧跟 `/`）→ 注释提前闭合 → 整页 WXSS 编译失败 → **开发者工具不显式报错、整个工程构建不出来** → automator 第一步就抛 `Cannot destructure property 'rawPath' ...`，看着完全像路由或环境问题。那一次花了 4 次真机运行 + 逐文件二分。现在这类问题**跑 `npm test` 立刻红**，还直接指到行号。

同一步里还有几条跟 UI 强相关的静态钉子，红了先看它们，别急着开工具：

| 钉子在哪 | 红了说明 |
|---|---|
| `tests/wxss-wxml.test.js` | 块注释 / 大括号 / 标签配对 / `wx:for` 缺 `wx:key` |
| `tests/slip-image.test.js` 末尾 | 有人给 `slip-overlay` 加回了 `virtualHost`，或宿主的 `id` 没了 |
| `tests/record-sheet.test.js` 末尾 | 同上，`record-sheet` 那一对 |
| `tests/automator-contract.test.js` | 页面加了/删了 `pageLoading` 字段，`waitPageReady` 的调用点要跟着改 |
| `tests/ui-scale.test.js` | 字号 / 热区越出 [ui-scale.md](ui-scale.md) 的档位 |

### 第 2 步 · `npm run test:all`（约 25 分钟，要开开发者工具，**全机器串行**）

跑之前**确认没有别的会话在跑**：自动化端口 9420 全局唯一，两个会话互相把对方的工具退掉，不是排队是相互摧毁。

```bash
npm run test:all > "$TMPDIR/ui.txt" 2>&1; echo "EXIT=$?"
```

输出**必须重定向到项目目录之外**（见下面「三条硬约束」后面那条：往项目目录里写文件会触发热重载，小程序被重启、页面栈清回入口页，之后所有等待都等不到目标页，而报错只显示「没跳过去」）。

### 第 3 步 · 撞到红的，先分清是抖动还是回归

**症状是初始化 / 超时 / 连接断（连不上、等不到、页面栈不对），而不是某条断言不符** —— 十有八九是环境，按这个顺序查：

| 现象 | 处理 |
|---|---|
| 端口被占 / `Connection closed` 出现在随机步骤 | 上一轮的残留。`Get-Process 微信开发者工具` 手动关掉；`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 里挂 `ui.test.js` 的 `Stop-Process`。**别按镜像名杀 `WeChatAppEx`**——它是微信本体也在用的，而且**新版微信本体的进程名是 `Weixin.exe` 不是 `WeChat.exe`**，别拿「`WeChat.exe` 不在 → 那些是残留」当依据去杀（2026-09-02 差一步就把用户正在用的微信杀了） |
| `cli auto 以退出码 4294967295 结束` / 刚跑几步就 `Connection closed`，**而进程列表是干净的** | 9420 端口处在 TCP `TIME_WAIT`（Windows 默认约 120 秒），杀进程对它无效。判据是 `netstat -ano \| grep -E ":9420 .*(TIME_WAIT\|LISTENING)"`，或 `Get-NetTCPConnection -LocalPort 9420` 看到 `State=TimeWait PID=0`。**连着跑两轮必撞**，跑之前等它消失即可。2026-09-02 在这上面白烧了三轮完整测试，其间还因为中途插进来的一次 baseline 恰好赶上干净窗口、跑绿了，差点把「环境是好的」反过来当成「代码有问题」的依据 |
| 「服务端口」没开 | 工具 → 设置 → 安全设置 → 服务端口 |
| 报「等『页面加载完成 pages/xxx』超时」 | 多半不是没加载完，是那个页面**根本没有 `pageLoading` 字段**，或者上一步走错了页。名单在 `tests/automator-contract.test.js` |
| `pageMap 缓存返回了陈旧页面对象` 那行日志 | 正常，脚本会自己删缓存重取，不用管 |
| worktree 里随机挂、症状各不相同 | 少了 `project.private.config.json`，从主检出 `cp` 一份 |
| 成片 `Maximum setlocal recursion level reached` | 见下面「排查」小节。正常情况下走的是直接调用，根本不经 cmd |

**判不出来就做 baseline 对照**：在改动前的 HEAD 上跑同一条，baseline 也挂就是环境，别在 diff 里找原因。

### 调一段用例时不要跑满 25 分钟

```bash
WECHAT_UI_ONLY=convert,product-edit npm run test:ui > "$TMPDIR/ui.txt" 2>&1
```

段名见 `tests/ui.test.js` 里 `STEPS` 那张表。种子那一段永远跑（后面每段都依赖它）。日志会大声打一行说明这是部分用例 —— **验收证据必须是不带这个开关的完整一轮**，部分绿不能当整轮绿用。

### 加新用例时，完成信号别写成「输入框被清空」

这条是 2026-08-31 用两次真实失败换来的，写在这里免得下一批再踩：

- **输入之后要确认值真的落进了 `data`**（`typeInto` 的第五个参数传字段名）。落不进去的话，后面每一步都会以别的样子失败；
- **提交的完成信号要读账本**（`waitForNewRecord` / `waitForLists`），不要读「输入框被清空」或「页面跳走了」。前者在输入没落进去时**恒真**，后者分不清「校验没过」和「路由被吞」—— 而校验抛的错会被 mock 掉的 `showToast` 吃掉，屏幕上什么都看不见。

---

`npm run test:ui` 用 `miniprogram-automator` 驱动**真实的微信开发者工具**，把这些操作从头点一遍：

| # | 段落 | 主要断言 |
|---|---|---|
| 1 | 填充示例数据 | 种子灌进内存账本 |
| 2 | 「记一笔」面板 | 五行文案与顺序、三条关闭通道、三个 picker 的落点、列表被 `max-height` 夹住并能滚 |
| 3 | 进货 | 库存 +N、**本次进价改写商品进价**、`in` 流水金额 = 数量 × 进价 |
| 4 | 销售出库 + 送货单 | 一分未收 → 欠款 = 应收；送货单**逐格核对屏幕上印的字** |
| 5 | 流水只读 + 再次导出 | 进详情不进修改态、导出的送货单同样核对渲染 |
| 6 | 退货 | 挂欠单全额冲欠款 / 收讫单全额退现金；欠款只减冲欠款那部分；件数原样入库 |
| 7 | 库存调整 | 件数减了，而 `salesSum` / `profitSum` / `purchaseSum` / `returnsSum` **一分没动** |
| 8 | 换规格 | 源格 −N、目标格 +N、**总件数守恒**，同样不进销售额与毛利 |
| 9 | 商品详情 | 头卡与库存全景逐格核对；四个动作按钮各自的落点 |
| 10 | 商品编辑 | 规格取值增删时 SKU 矩阵 2×2 → 3×2 → 2×2；保存后真的落 4 个规格格；删除路径 |
| 11 | 种类模板 | 列表渲染、加一条待选项并落盘、新增再删掉 |
| 12 | 流水改 / 取消 | 点「修改」才出现保存，取消回详情 |
| 13 | 客户记期初 / 收款 | 弹层开合与提交 |
| 14 | 流水分页触底 / 客户往来分页 | 首屏只给一页、翻完不重不漏 |
| 15 | 店铺清空 | 原生弹窗用 mock 自动确认 |
| 16 | 建店 / 选店 / 成员 | 成员名单渲染与权限位；**通过 UI 建一家新店**（会换账套，所以放最后） |

这是仓库里唯一一条能证明「页面点得动」的测试。`npm test` 那二十几项都是纯 Node，跑的是 `utils/` 里的逻辑和静态检查，碰不到渲染层。

**但纯 Node 那侧新补了一格**：`tests/wxss-wxml.test.js` 扫全部 `pages/**`、`components/**` 的 wxss/wxml，查块注释配对、大括号平衡、标签配对、`wx:for` 缺 `wx:key`。缘起是 2026-08-30 的 PR #93：商品详情页 WXSS 首行注释里的 `.btn-*` 紧跟 `/`，把块注释提前闭合，整页 WXSS 编译失败、开发者工具**不显式报错**、整个工程构建不出来，automator 第一步就抛 `Cannot destructure property 'rawPath' of 't.getPageMetaByWebviewId(...)' as it is null` —— 看着完全像路由或环境问题，实际花了 4 次真机运行 + 逐文件二分才定位。那一类问题现在两秒钟就红，不必等十分钟开工具。

### 内存模式测不到的两处，如实记着

`resetStorage()` 注入的是内存账本（`utils/store.js` 的 `memoryCall`），有两条路在这个模式下根本走不通，所以用例**故意不测**：

- **加减成员 / 删店**：`addMember` / `removeMember` / `updateMember` / `deleteShop` 一律抛「本地测试账本不能改成员 / 删店」。成员那一段只验渲染和权限位（店主看得到「添加店员」那张卡）。
- **真正的切店**：`listShops` 只回**当前这一家**，所以「我加入的店」永远只有一行；点它验的是 `selectShop → ensureReady` 这条链没断，验不了从 A 店切到 B 店。

「通过 UI 建店」倒是真的能测：`createShop` 在内存模式下会换 `shopId`、清空账本、装一本空账 —— 也正因为如此，它必须排在整轮的**最后**。

## 怎么跑

三个本机前提，缺一条都跑不起来：

1. 装了微信开发者工具（默认找 `C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`，位置不同就设环境变量 `WECHAT_CLI`）
2. 工具里**已登录**（扫码）
3. 工具 → 设置 → 安全设置 → **服务端口**已打开

```bash
npm run test:ui
```

脚本自己用 `cli auto` 把工具拉起来、开自动化端口 9420，跑完再 `close` 掉。端口上若还留着上一次的会话，会先把工具整个退掉再重开——同一个端口连不同 worktree 的项目是抢不过来的，以前就这么测成了另一棵树的代码。

### 全新 worktree 的第一次冷启动会真的发一次云调用

「UI 测试跑在内存模式、所以不碰云」这句话**有一个真实的例外**，而且它就在每一轮的最开头。

短路的前提是**标志已经在 storage 里**：

- `utils/store.js` 的 `isMemoryMode()` 读的是 `wx.getStorageSync('inv_test_memory_ledger')`；
  `initCloud()` 第一行就是 `if (isMemoryMode()) return { ok: true, mode: 'memory' }`。
- 写这个标志的是 `tests/ui.test.js` 的 `resetStorage()`，而它在 **automator 连上之后**才跑
  （在 `seedFromHome` 里）。
- 在那之前小程序已经启动过一次了：`app.js` 的 `onLaunch` 调 `store.initCloud()`，
  `onShow` 调 `store.checkMaintenance()`（它走 `request('whoami', ...)`）。

老 worktree 里标志是上一轮留下的，所以两条都短路、确实不发云调用。
**但全新 worktree 的开发者工具 storage 是干净的**，那一次冷启动就会真的 `wx.cloud.init`
并发一次真实的 `whoami` 云调用。`checkMaintenance` 的失败被 try/catch 吞掉，
**结果层面无害**（断言不会因此变红），但它意味着：

- 别在别人跑 UI 测试的时候部署云函数。函数替换窗口（`status Updating → Active`）里，
  那一次冷启动调用的耗时 / 成败会变成对方分辨不出来的变量。**2026-08-25 真发生过**：
  一边在追一个随机性失败、一边以为「不碰 9420 就不影响你」而部署了，废掉一轮。
  共享资源不只有端口，还有**生产环境的服务端行为**。
- 云环境不可达时，全新 worktree 的第 1 轮会多花一个超时的时间才进入内存模式。

### 在任务 worktree 里跑：先补两个没进版本库的文件

在任务工作树（`../inventory-miniapp-worktrees/<短名>`，见 [git-workflow.md](git-workflow.md)）里跑 `npm run test:ui` / `npm run test:all` 之前，要补两件没进版本库的东西：装依赖，**外加把主检出的 `project.private.config.json` 复制过去**：

```bash
npm install --no-audit --no-fund
cp /d/work/inventory-miniapp/project.private.config.json ./
```

依赖**不要**再从主检出 `cp -r node_modules`（这里以前是这么写的）：主检出的 `node_modules` 现在是个空目录，复制过去只得到一个空壳，连非 UI 的 `npm test` 都会红在 `tests/automator-contract.test.js`（`Cannot find module 'miniprogram-automator/package.json'`）。有 `package-lock.json`，`npm install` 两秒装完 77 个包。

**更不要用 junction / 符号链接把它指向主检出。** 看着是省了磁盘和那两秒，代价是 `git worktree remove` 会顺着链接递归删下去，**把主检出的 `node_modules` 整个清空**——2026-09-02 实测从 50 个包变成 0，之后主检出和所有工作树的 `npm test` 一起红在 `automator-contract`，症状和上面那段「空壳」一模一样，看着完全像环境自己坏了，得重跑 `npm install` 才能恢复。真要用链接，`git worktree remove` **之前**先把链接摘掉：`rmdir` 只删链接不碰目标，`rm -rf` 会穿透。

两样东西都在 `.gitignore` 里，所以 `git worktree add` 出来的目录里没有它们。缺依赖会当场报模块找不到，好认；少了 `project.private.config.json` 不报错，反而更难查——它钉着 `libVersion: 3.16.2`，以及 `useApiHook` / `useIsolateContext` / `compileHotReLoad` 等一串开发者工具设置。缺了它，工具会按「全新项目」的默认值打开这棵树，UI 测试就以**互不相同**的初始化/超时症状随机挂掉。典型标志是日志里那句：

```text
[UI] Tool.getInfo 一直没带 SDKVersion，跳过基础库版本校验
```

实测（2026-08-24，同一份代码，主检出和 worktree 交替跑）：

| 环境 | 结果 |
|---|---|
| 主检出 `main` | 连过 2 次 |
| 缺 `project.private.config.json` 的 worktree | 连挂 3 次，三次症状各不相同：`退不回 tab 页，页面栈太深` / `Connection closed, check if wechat web devTools is still running` / `timeout waiting for automator response` |

三次挂的**没有一条是断言失败**。所以：worktree 里 UI 测试红、而且症状是初始化或超时类（连不上、等不到、页面栈不对）而不是某条断言不符，先查这个文件在不在，别急着当成代码回归去翻 diff。

## 三条硬约束

### 1. 开了 `virtualHost` 的组件，页面级选择器**一个节点都查不到**

实测（2026-08-23，开发者工具 2.02.x + `miniprogram-automator` 0.12.1）：当时 `slip-overlay` 开着 `virtualHost: true`，页面侧压根没有它的宿主节点，下面五种写法**全部返回 0**：

| 写法 | 结果 |
|---|---|
| `page.$$('.js-slip')` | 0 |
| `page.$$('slip-overlay >>> .js-slip')` | 0 |
| `page.$$('slip-overlay')`（宿主节点本身） | 0 |
| 页面内 `createSelectorQuery().selectAll('.js-slip')` | 0 |
| `selectComponent` / `selectAllComponents`（tag、class、id 三种写法） | 全 null / 0 |

**结论不是「组件内部一律核对页面数据」，而是「别开 `virtualHost`」。**

2026-08-31 把 `slip-overlay` 的 `virtualHost` 摘掉、给两个引用点（`pages/sale`、`pages/record-edit`）加上 `id="slip-overlay"` 之后，那条用例就从「核对 `page.data().slip`」升回了**核对渲染**：`page.$('#slip-overlay')` 拿到 `CustomElement`，再在这个实例上查 `.js-slip-*` 子元素，逐格和 `data.slip` 对账（店名 / 经手人 / 收货人 / `¥实收` / 每一行商品名）。关闭也改成**点真的那颗「完成」按钮**，把 `onClose → triggerEvent('close') → 页面 closeSlip` 这条链一起验掉。`components/record-sheet` 一开始就是这么做的。

摘之前先核排版：弹层本体是 `position: fixed`，关着时 `wx:if` 连子节点都不渲染，所以宿主是个零高的块级空节点；两个宿主都挂在 `.page` 里，而 `.page`（`app.wxss:76`）是普通块级容器，没有 flex / grid，多一个零高子节点不改变兄弟节点排布。**换个组件摘 `virtualHost` 时，这一步要自己重新核一遍。**

不许再加回来这件事有静态钉子看着：`tests/slip-image.test.js` 末尾同时钉 `virtualHost` 和两个宿主的 `id`，`tests/record-sheet.test.js` 末尾钉 `record-sheet` 那一对。

`page-loading` 仍然是 `virtualHost`（它没有需要查的内容）：等页面就绪一律用 `waitPageReady()`（读 `pageLoading` 字段），不要去查加载态的节点。哪些页面有这个字段由 `tests/automator-contract.test.js` 的两张名单钉着，**对没有这个字段的页面调 `waitPageReady()` 会报一句和真实原因无关的假错**。

### 1b. 没开 `virtualHost` 时，`>>>` 会**静默降级**

和第 1 条是同一类坑的另一面，别混：

- 开着 `virtualHost` —— 页面侧根本没有宿主节点，三种写法都是**真的 0**，红得干脆；
- 没开 —— 宿主在，`'宿主 >>> .a .b'` **能锚上**，然后因为 `>>>` 右边只吃单个简单选择器、吃不下两级后代链而**静默降级成宿主本身**：返回 1 个节点、`text()` 是整块拼成的一串，**绿着骗人**。

所以组件里的元素一律走**组件实例自己的 `$` / `$$`**：先用页面查宿主 id 拿到 `CustomElement`，再在它上面查子元素。依据是 automator 的 `out/Element.js`：`CustomElement extends Element`，两个查询都以该元素为作用域下发，后代链正常。

### 2. 所有等待必须走 `waitFor(page, target, label)`

automator 的 `page.waitFor` 底层是 `licia/waitUntil`，而且**没传 timeout（0 = 无限轮询）**。直接用它，选择器一旦过期就是静默挂死，不报错、不退出。

`tests/ui.test.js` 里因此包了一层：

```js
await waitFor(sale, '.js-add-cart', '出现 .js-add-cart')   // 选择器
await waitFor(sale, async function () { ... }, '商品进购物车')  // 条件
```

- 单步默认 30 秒，`WECHAT_AUTOMATOR_STEP_TIMEOUT` 覆盖
- 整轮默认 30 分钟，`WECHAT_AUTOMATOR_RUN_TIMEOUT` 覆盖（2026-08-31 从 15 分钟抬上来：用例从 9 段加到 17 段，路由次数和页面加载都翻了倍。看门狗一开火只报「整轮 UI 用例超时」、指不出是哪一步，排查成本比多等十分钟高得多）
- 整个脚本默认 45 分钟，`WECHAT_AUTOMATOR_SCRIPT_TIMEOUT` 覆盖（整轮那道只罩用例本身，起端口、连接卡住时它还没起跑）
- 收尾关工具默认 20 秒，`WECHAT_AUTOMATOR_CLOSE_TIMEOUT` 覆盖
- 超时消息带 `label`，直接说清在等什么：`等「出现 .js-seed」超时（30 秒）`

只有纯 sleep（`page.waitFor(800)`）可以直接调，它不存在等不到的情况。

**不要**在用例里写 `await page.waitFor('.js-xxx')`。

### 3. 路由指令不许紧挨着上一步下发

实测（2026-08-25，开发者工具 2.02.x + `miniprogram-automator` 0.12.1）：路由指令下发得离上一步太近，会被**静默吞掉**，而且会把路由整个卡死。

在未改动的 `origin/main`（9c4abe0）上插桩跑了 7 轮，盯 `runOpeningSheet` 结尾那次退回，把 automator 侧 `App.getPageStack` 和 runtime 侧 `getCurrentPages()` 两个栈连读 8 秒：

| 退栈下发距上一次 tap | 结果 |
|---|---|
| ≤ 92ms | 3/3 被吞，两侧栈一动不动 |
| ≥ 290ms | 4/4 正常退回 |

被吞时的现场：`navigateBack()` 正常返回（3027ms，正是 `changeRoute` 那个固定 `sleep(3000)`），通道也完全健康（探针 RPC 全是 1–3ms），但栈就是不动。**这不是通道问题，也不是没等够。**

三条已经排除的解释，别再回头查：

- 不是遮罩挡住 —— 内存模式下 `store` 的 `showBusy` / `hideBusy` 直接 return，压根没有 `showLoading`
- 不是在途的异步取数 —— 被吞那几轮里 `ledgerLoading` / `ledgerLock` 早已是 `false`
- 不是视图层还没渲染完 —— 被吞的那一轮，页面上的欠款文案已经从 `¥17.00` 变成 `¥37.00`

两条同样重要的否定结论：

- **补发无效，不要加重试。** 从 runtime 侧补发 `wx.navigateBack({success, fail})`，回调拿到的是 `{"ok":true,"res":{"errMsg":"navigateBack:ok"}}` —— API 说成功了，栈依旧不动。
- **一旦被吞，路由整个卡死。** 紧接着的任何一条路由指令都会让工具等满 10 秒、报 `timeout waiting for automator response`。所以那个「偶发 timeout」和「栈没退」是同一件事的两种表现，不是两个 bug。

`tests/ui.test.js` 的对策是：`goto` / `goBackTo` 在真正下发之前先空出 `WECHAT_UI_ROUTE_SETTLE`（默认 1000）毫秒。**下发之后仍旧靠轮询确认到没到位**，这段安静时间不是拿固定 `sleep` 冒充完成信号。

基准要取在「马上要下发」的这一刻，不要取在上一次 tap 上。先试过「距上一次 tap 满 400ms」这条规则（`ctrl-floor400-1`）：期初欠款那处它治好了，但那一轮仍然红在 `runNativeClearModal` 处，报 `timeout waiting for automator response`。**这句话只能说到这里** —— 那一处**没有插桩，也没有记录 tap 到下发的实际间隔**，`clearAll()` 跑了多久、那次退栈离 tap 多远，产物里一个数都没有。所以只能说「那条规则在这一步没有被验证有效」，**不能**断言它「等于没等」。

换成「无条件空出一段」的理由不是前者被证伪，而是：**它对『上一步做了多久』不敏感，是更保守的形式**。「距 tap N 毫秒」在任何一个上一步耗时超过 N 的步骤上都会退化成不等，而哪些步骤会超过 N 是没数过的。

**真正的阈值没测出来，成因也没查到**（那在开发者工具内部，从外面看不见），1000 是保守取的。400 只有一处实测：期初欠款那处在 400ms 下退栈正常（automator 路径与 runtime 路径各一次），其余步骤在 400ms 下如何，没量过。嫌慢可以用 `WECHAT_UI_ROUTE_SETTLE` 调，但调小之前先把这一节读完。

**这个窗口不是 automator 路由通道独有的。** 补测（同一处、同样 ≤92ms 早下发，只把下发方式换成 `miniProgram.evaluate` 在 runtime 里直接执行 `wx.navigateBack({success, fail})`）：

| 下发方式 | 距上一次 tap | 结果 |
|---|---|---|
| automator `navigateBack()`（对照） | 70ms | 被吞 |
| runtime `wx.navigateBack` | 69ms | 被吞，回调报 `navigateBack:ok` |
| runtime `wx.navigateBack` | 74ms | 被吞，同上 |
| runtime `wx.navigateBack` | 401ms | 正常退回，整轮绿 |

所以**不能**用「automator 桥独有」来论证真机上的产品路径安全。这个实验的边界也要一起记住：`evaluate` 走的是 `App.callFunction`，本身仍是一条 automator RPC，它区分的是「automator 的路由指令通道」和「runtime 里执行 `wx` 路由 API」这两层，**不等于真实手指经页面 handler 触发**；真机上有没有这个窗口，一次都没测过。

`pages/customer-edit/customer-edit.js` 的 `save()` 是 `setTimeout(() => wx.navigateBack(), 400)`，恰好落在上面唯一测过正常的那个间隔上 —— 但那是模拟器里的一次测量，不是真机结论。如果有人在真机上看到店员点保存/返回没反应，回来重读这一节。

## 改 wxml 时的检查清单

- [ ] 跑过 `node tests/wxss-wxml.test.js`（两秒，不用开工具）——它查块注释配对、大括号平衡、标签配对、`wx:for` 缺 `wx:key`。**wxss 的块注释里不要出现 `*/`**：`.btn-*` 后面紧跟 `/` 就会把注释提前闭合，整页编译失败而工具不显式报错
- [ ] 新增或改名 `js-` 钩子后，`grep` 过 `tests/ui.test.js`
- [ ] 把页面里的块抽成自定义组件后，确认该块上的 `js-` 钩子在测试里**全部失效**了——要么把断言改走页面数据，要么把钩子留在页面模板一侧（`record-edit` 的「导出送货单」按钮 `.js-export-slip` 就还在页面里，所以还能直接点）
- [ ] 跑过一次 `npm run test:ui`

## 一次真实事故

2026-08-18 的 `bf8f6d7` 把加载态和送货单弹层抽成自定义组件，没有同步改 `tests/ui.test.js`。当时 UI 测试因为 Node 24 禁止 spawn `.bat`、工具 2.02 的 `Tool.getInfo` 不带 `SDKVersion` 等问题本来就跑不起来，直到 2026-08-23 的 `7d1f12b` 把脚手架修好，再跑才暴露出来。

暴露的样子值得记一笔：销售流程**全部成功**——库存从 42 扣到 41、单号 `SH20260823-H9ZH` 生成了、弹层在模拟器里画得好好的，只有 `waitFor('.js-slip')` 永远等不到，于是整个测试无声挂了二十多分钟，既不报错也不退出。

两个教训就是上面第 1、2 条硬约束：**跨不进组件**，以及**等待没有超时**。

## 断言写在哪一层：sheet 固定高那批的四条结论

2026-09-01 的 `fix/sheet-list-height`（PR #121）审计走了十一轮才 PASS，逐轮逼出这四条。
它们不是理论，每一条后面都跟着一次「全套测试绿而功能已经坏了」的实测。

**1. 静态正则守不住 CSS。** 读 wxss 原始文本的断言看不见三样东西，而这三样都能让功能坏掉：

- **层叠** —— 在 `height: 640rpx` 后面再加一行 `height: 200rpx`，`640rpx` 那几个字还在文本里，正则照样命中
- **注释** —— 把整条规则注释掉，`align-items: center` 这七个字仍在文本里
- **DOM 嵌套** —— 给元素外面套一层 view，子选择器不再命中，而 **wxss 一个字节都没改**

实测这三种改法都能做到「静态断言 + 全套 UI 双绿而居中已彻底失效」。**要守计算后的布局，就得读计算样式**（`Element.style('align-items')`），不能读文本。

**2. 只查相对关系会漏掉绝对值。** 「高度不变」「占满外壳」「行数溢出容器」「能滚」四条同时成立，而外壳从 332px 掉到 104px —— 因为没有一条问「它**应该**是多高」。写断言时先问一句：**这些断言合起来，有没有一条在守我主张的那个结论？**

**3. 变异跑绿时，两个问题都要问完。**

> ① 打中被测路径了吗？ ② 如果打中了也不红，说明什么？

只问 ① 会误以为断言无效、去过度加固；只问 ② 会误以为验过了。这批里三次栽在只问一个：
两次是变异没打中（一次是全文件 `replace` 改到了另一条同名规则，一次是变异打在 A picker
而断言跑在 B picker），一次是断言压根没覆盖那条路径（`line.sku` 的三处全在 `applyPurchase`
和 `applyAdjust` 里，而测试走的是 `applySaleOrder`）。

**变异没打中和断言有洞，现象一模一样，应对方向却完全相反。**

**变异跑绿还有第三个原因：变异打中了、断言也是活的，但它一直活在别的路径上。**
（注意这里数的是「变异跑绿的**原因**」，与下文 3-4 末尾那句「上面四段都是跑绿」
不是同一把尺子——那句数的是**场景**（1、2、3 三段加本段）。两套计数各自成立，
别把它们归一，也别拿其中一个去改另一个。）

2026-09-03 实测。`tests/slip-image.test.js` 用 7 个夹具覆盖矩阵化的条件 2–6（条件 3 由三个夹具分摊；条件 1 由另一组断言覆盖，条件 7 单独一组，都不在这 7 个里），
每条的注释都写着「只差这一条」。把条件 4（节内单价一致）改成恒真，那条夹具**仍然平铺**、
测试仍绿：

```
夹具 A：2 行、单价不一致（声称在测条件 4）
  条件4 完好 -> 矩阵化? false
  条件4 改坏 -> 矩阵化? false      ← 改坏了也没变

夹具 B：同样数据补到 6 行（2 色 × 3 码）
  一行不同价、条件4 完好 -> false
  一行不同价、条件4 改坏 -> true    ← 这里才真的测到
```

原因：那 5 条夹具都不超过 2 行（4 条 2 行、1 条 1 行），而条件 6（有压缩收益 `2 + 行轴取值数 < 节行数`）要求至少 4 行。
无论条件 4 是对是错，它们都先被条件 6 拦下。**测试断言的是最终结果（是不是平铺），
不是「被哪个条件拦下」**——只要有任一否决路径成立，结果就相同。

**判定顺序在这里是无关的**，这一步最容易绕进去：那批里条件 4 排在条件 6 之前、先执行先拦，
照样测不到。第一反应「前面的条件先拦所以测得到」是错的。

判据：**把被测条件改坏之后，夹具必须从「不满足」翻成「满足」。** 改坏了结果没变，
就说明另有路径也在拦它。这条比「把夹具补到 4 行」通用——条件 3（轴数不对）走的是
`if (!axes) return null` 那条早退路径，根本到不了条件 6，补行数解决不了它。

跟前两种的分别要说清楚：**变异没打中** = 代码没被改到；**断言有洞** = 没人守那条路；
**这一种** = 代码改到了、断言也活着，只是它守的一直是另一条路。所以——

> 变异验证只能证明「这条断言在某条路径上是活的」，
> 证明不了「它活在你以为的那条路径上」。

三轮独立审计加逐条变异都没抓到这个，不是流程松：它在流程之外。

**跑红也要问一句「红在哪一条」。** 上面四段都是「跑绿」，还有第五段是**崩溃红冒充断言红**：
把 `product.sku` 改成读规格级字段做变异，三处初始化点全红——看着像验过了，实际那三行的
作用域里根本没有 `sku` 变量（它是 `const`，声明在后面各分支的块里），红的分别是 `ReferenceError: sku is not defined`、一条「库存不足」、一条
「调整出库不许把格扣成负数」。**三条没有一条在说货号。**

判据：**报错文案是不是在说你改的那件事**。换一种不依赖作用域、不会崩的变异形态
（例如把值换成 `'__MUT__'` 这种毒值字面量），红就只可能红在断言上。

顺带一条同样容易骗人的：**取证工具本身也会制造假结论**。同一批里我用
`/(销售|进货|库存修正|换规格|无规格[^ ]*|待加工[^ ]*)[^ ]* 的货号要取商品级/` 去筛，
七处被判成「红在别处」，实际都精确红在货号断言上——**失败原因是 `[^ ]*` 跨不过空格**，
而断言标签里含空格（`无规格销售 consumeSaleLine 初始值 的货号…`）。差一点得出
「断言大面积失效」的相反结论。

**所以每个取证工具都要有一个「它确实在工作」的阳性信号**：探针先打印总触发次数、
grep 先在一条已知能匹配的样本上试一次。工具静默失败时产出的假象，恰好长得像你正想
验证的那个结论——空输出和「这条路没走到」长得一模一样。

**2026-09-03 又撞一次，形态干净得像教科书**：有人验上面那条「翻转判据」时按 `unitPriceText`
造夹具，而 `tests/slip-image.test.js` 的 `specLine` 用的字段名是 `priceText`。字段名错了、
行根本不成立，四种组合全返回 `false`——而那四个 `false` 既可以读成「没矩阵化」，
也可以读成「探针压根没走到那条路径」。**没有阳性对照就分不开这两件事。**

所以做翻转验证时，先构造一个「本来就该满足」的夹具，确认探针能吐出 `true`；
**拿不到这个 `true`，后面任何 `false` 都不算证据。**

### 漏掉一条路径时，先问断言、再问夹具

那批里 `allocateBlankLine` 藏了三轮。全量插桩它的 30 次调用：26 次货号是空串、4 次非空，
**其中 2 次是本批之前就有的夹具**（卫衣 `HD-006`）。所以那条路上一直存在能测出差别的数据，
**谁写一条断言都能守住——「没写断言」是主因**，夹具形状只是让它更难被偶然发现。

顺序不能倒过来。写成「有夹具形状问题才会漏」会让下一个人在**已有断言**的路径上放松警惕，
而那才是更常见的情形。

夹具那一半仍然要问，但排第二：**空串、`undefined`、两边恰好相等**这类取值会让变异
「改了也看不出差别」。写断言前看一眼——被测差异在这份数据上表现得出来吗？

**4. 审计者自己的假设也要实测，负面结果照报。** 「我认为这里有洞」和「我验证了这里有洞」
是两回事。那批审计两次押错并如实记下——其中一次（押「让位不会把跳动带回来」）反而撞出了
真 bug：小屏上 `.rs-picker-body` 的 `min-height: auto` 让高度重新随搜索结果变，287px → 259px。
**押错的那次比押中的那些更值钱。**

### 放宽阈值前先算一笔账

放宽容差本身不危险，**放出来的空间够不够放进一个真实改动**才是判据：

- 出事那次：`== 320rpx` 放成「≤ 且 ≥ 一半」，打开了 `[320rpx, 643rpx]` 整段——一个 `500rpx` 正好落在里面，**装得下，所以漏了**
- 安全那次：预算 390 → 400rpx 只释放 10.9rpx，而最小的真实新增（一行 `--fs-caption`（24rpx 字号，行盒约 36rpx）+ 一个 gap 16rpx）是 52rpx，**4.8 倍，结构上装不下**

比讨论「容差取 2 还是 3」管用。

## 排查

跑失败时脚本会打印一份编号清单，按它查。踩过的坑：

- 端口被上一次没退干净的工具占着——脚本会先 `cli quit`，退不掉就手动关工具
- **`cli.bat` 的 `setlocal` 递归风暴，以及它现在为什么不该再发生**（2026-08-31 重写这一条，旧说法有两处是错的）

  症状是刷屏「Maximum setlocal recursion level reached.」、`cli auto` 永远不返回。成因：`cli.bat` 第 3 行 `chcp 65001 >nul` 把控制台切到 UTF-8，某些机器状态下 cmd 在切页处丢了解析位置，把一行中文注释的后半截当命令执行——那半截正好以 `CLI` 开头（bat 里就有 `set "CLI=%~dp0resources\...\index.js"` 这个变量名）。

  **两处更正：**

  1. 旧文档写「`cli.bat` 是 GBK 编码的」。**不对**：2026-08-31 实测这台机器上的 `cli.bat` 是 **UTF-8** 编码（前 64 字节里 `按` = `e6 8c 89`）、CRLF 行尾。工具升级换过版本，所以「自己写一份 GBK 的等价 bat」那条绕法是针对旧版的，别再照抄。
  2. 旧文档写「脚本已把工具安装目录从子进程 `PATH` 上摘掉」。**这条修复对现在这版无效**：误解析发生在第 7 行 `cd /d "%~dp0"` **之后**，此刻 cwd 就是安装目录，而 cmd 解析裸命令时**先查当前目录、再查 `PATH`**——摘 `PATH` 摘不掉 cwd 那一跳。它只在「误解析发生在 `cd` 之前」或「cwd 不是安装目录」时才管用。

  **现在的做法：根本不经 `cmd.exe` / `cli.bat`。** `tests/ui.test.js` 从 `cli.bat` 里**解析**出三样东西——Electron exe 的探测规则（`>50MB` + 六个排除名）、`BOOTSTRAP_JS`、`index.js` 的相对路径——然后自己 `spawn(electron, ['-e', BOOTSTRAP_JS, indexJs, ...args])`，带 `ELECTRON_RUN_AS_NODE=1`，并按 bat 的语义把调用方的 CD 传成环境变量 `cwd`。参数是解析出来的不是抄下来的，工具升级时跟着走；解析不出来才回落到内置默认值，再不行才回落到老路。

  日志开头那行「CLI 走直接调用 / CLI 回落到 cmd.exe + cli.bat 老路」说的就是走了哪条。要强制走老路对拍，设 `WECHAT_CLI_DIRECT=0`；老路上再撞见递归风暴会**当场报错**，不会再刷满 3 分钟才报一句指不出原因的「等 cli auto 结束超时」。

  **复现状态如实记**：2026-08-31 在这台机器上**没能复现**递归风暴——直接跑 `cli.bat --help`，五种组合（cwd = 安装目录 / 仓库根 × 安装目录在不在 `PATH` 上 × 先 `chcp 936` / 先 `chcp 65001`）全部干净退出、输出各 1841 字节、`setlocal recursion` 命中 0 次。所以改成直接调用**不是「修一个复现过的 bug」**，而是把 cmd.exe + .bat + 代码页 + `%~dp0` + `PATH` 这一整层已知脆弱面拿掉。直接调用那条路已用 `--help` 对拍过，输出与 `cli.bat` 完全一致。
- `automator.launch()` 不能用：Node 18.20.2 / 20.12.2 起禁止不带 shell 地 spawn `.bat`，而且报错会被转述成误导性的「cliPath 不对」。直接调用那条路连 `.bat` 都不碰，这条限制自然不存在；兜底那条经 `cmd.exe` 走，也绕开了
- `wx.showModal` 是系统弹窗，自动化点不到内部按钮，用 `mockWxMethod` 自动确认
- 在任务 worktree 里跑，却没从主检出复制 `project.private.config.json`——挂的样子是随机的初始化/超时，不是断言失败，见上面「在任务 worktree 里跑：先补两个没进版本库的文件」

### 失败之后先清残留，再重试

一次失败会自我放大：留下来的东西会让下一轮在**随机步骤**报
`Connection closed, check if wechat web devTools is still running`，看起来像新的回归，其实是上一轮的尾巴。

脚本这边已经做到：任何退出路径（断言失败、超时、连接断开、未捕获异常）都会走同一个收尾——
给 `close()` 掐表、无论成败都补一次 `disconnect()`、`close()` 关不掉工具就再用 `cli quit` 兜一次、
收掉没退的 `cli` 子进程，最后确保进程真的退出（收尾自己卡住也有硬看门狗）。

工具已经卡死时这些仍可能不管用。重试之前先确认：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*ui.test.js*' }
Get-Process 微信开发者工具
```

前者查出来就 `Stop-Process`（它还占着到 9420 的 WebSocket），后者查出来就手动关掉工具（它还占着 9420 端口）。

脚本**不**替你按镜像名杀进程：`WeChatAppEx` 是微信本体也在用的进程，按名字杀会连着把用户正在用的微信小程序一起干掉，误伤代价比留个残留大。所以自动化只做「用工具自己的 `cli quit` 好好关」，剩下的交给人。
