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

## 三条硬约束

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
- 整个脚本默认 25 分钟，`WECHAT_AUTOMATOR_SCRIPT_TIMEOUT` 覆盖（整轮那道只罩用例本身，起端口、连接卡住时它还没起跑）
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

- [ ] 新增或改名 `js-` 钩子后，`grep` 过 `tests/ui.test.js`
- [ ] 把页面里的块抽成自定义组件后，确认该块上的 `js-` 钩子在测试里**全部失效**了——要么把断言改走页面数据，要么把钩子留在页面模板一侧（`record-edit` 的「导出送货单」按钮 `.js-export-slip` 就还在页面里，所以还能直接点）
- [ ] 跑过一次 `npm run test:ui`

## 一次真实事故

2026-08-18 的 `bf8f6d7` 把加载态和送货单弹层抽成自定义组件，没有同步改 `tests/ui.test.js`。当时 UI 测试因为 Node 24 禁止 spawn `.bat`、工具 2.02 的 `Tool.getInfo` 不带 `SDKVersion` 等问题本来就跑不起来，直到 2026-08-23 的 `7d1f12b` 把脚手架修好，再跑才暴露出来。

暴露的样子值得记一笔：销售流程**全部成功**——库存从 42 扣到 41、单号 `SH20260823-H9ZH` 生成了、弹层在模拟器里画得好好的，只有 `waitFor('.js-slip')` 永远等不到，于是整个测试无声挂了二十多分钟，既不报错也不退出。

两个教训就是上面第 1、2 条硬约束：**跨不进组件**，以及**等待没有超时**。

## 排查

跑失败时脚本会打印一份编号清单，按它查。踩过的坑：

- 端口被上一次没退干净的工具占着——脚本会先 `cli quit`，退不掉就手动关工具
- `cli.bat` 切 UTF-8 代码页后被 cmd 误解析、把注释里的 `CLI` 当命令递归调自己，刷屏「Maximum setlocal recursion level reached」——脚本已把工具安装目录从子进程 `PATH` 上摘掉
- 同一句刷屏还可能以**另一副面孔**出现（2026-08-24 复现）：`cli.bat` 本体就是 UTF-8 编码 + 中文注释 + 中途 `chcp 65001`，某些机器状态（疑似工具更新后 cmd 与代码页失同步）下 cmd 丢了解析位置，`setlocal` 无限递归——拿 `cli.bat --help` 在安装目录里就能复现，与仓库内容无关，摘 `PATH` 也救不了。**绕法**：自己写一份 GBK 编码、**不含 `chcp`**、CRLF 行尾的等价 bat（照抄原文件的 exe 探测、`ELECTRON_RUN_AS_NODE`、`BOOTSTRAP_JS` 那几段，只去掉切代码页），放临时目录，跑测试时 `WECHAT_CLI=<这份bat的绝对路径> npm run test:ui`。关键点：GBK 编码让中文安装路径在默认 CP936 的 cmd 下稳定解析，整份文件从头到尾一个代码页，就没有中途失同步的窗口
- `automator.launch()` 不能用：Node 18.20.2 / 20.12.2 起禁止不带 shell 地 spawn `.bat`，而且报错会被转述成误导性的「cliPath 不对」。脚本改成自己经 `cmd.exe` 起端口再 `connect`
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
