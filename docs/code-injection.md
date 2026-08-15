# 代码注入与包体积约定

本文件是仓库级约定，给人和各类 Agent 共同遵守。不要把同一套规则只写在 `.cursor/` 里。

## 依据

- [按需注入和用时注入](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/lazyload.html)（微信官方文档）
- [占位组件](https://developers.weixin.qq.com/miniprogram/dev/framework/custom-component/placeholder.html)（微信官方文档）
- [小程序性能优化指南](https://developers.weixin.qq.com/community/develop/doc/00040e5a0846706e893dcc24256009)（官方社区置顶，对应开发者工具「代码质量」扫描）

下面的「必须 / 建议」以这两处官方材料为准；「本仓库怎么做」由当前项目形态推导：原生小程序、无自定义组件、无插件、无分包、5 个 tab 页必须留在主包。

## 当前状态

| 项 | 状态 |
|---|---|
| 自定义组件 | 无，各页 `usingComponents` 为空 |
| 插件 / 分包 | 无 |
| `lazyCodeLoading` | 已写入 `app.json`，之后不得删除 |
| JS / WXSS / WXML 压缩 | 已开（`project.config.json`） |
| 上传过滤无依赖文件 | `ignoreUploadUnusedFiles` 已开 |
| 不进代码包 | `tests/`、`node_modules`、`docs/`、仓库说明与 npm 清单已在 `packOptions.ignore` |
| 基础库 | `3.8.0`（高于按需注入 2.11.1、用时注入 2.11.2） |

用时注入目前没有对象。不要为了「看起来用了占位组件」去硬拆页面。

## 1. 按需注入（必须长期开启）

`app.json` 必须包含：

```json
{
  "lazyCodeLoading": "requiredComponents"
}
```

开启后，运行时只注入**当前访问页**声明过的页面代码和自定义组件。未访问页、未声明组件的 JS 不会执行。

连带约束（官方说明，不是可选项）：

- 页面 JSON 里的 `usingComponents`、以及 `app.json` 里的全局 `usingComponents`，**全部视为该页依赖并会注入**。
- 不要把低频组件写进 `app.json` 的全局 `usingComponents`。
- 页面 JSON 只声明本页 WXML **真正用到**的组件；复制页面时删掉无用声明。
- 插件包和扩展库**不支持**按需注入。以后若接插件，放到分包，用分包异步化引入。

改完配置后，至少走一遍：看板、商品、进货、销售、库存、流水、客户。确认没有依赖「所有页面 JS 启动时都会执行」这种隐式行为。

## 2. 用时注入（有非首屏重组件时才配）

前提：第 1 节的 `lazyCodeLoading` 已开启。给组件配置 `componentPlaceholder` 后，该组件自动变成用时注入：

1. 本页第一次渲染它之前，不注入。
2. 第一次渲染时先画占位，当前渲染流程结束后再注入。
3. 注入完成后替换回真实组件。

**要配占位：** 弹层、筛选器、图表、编辑器、扫码结果区等，默认不在首屏、用 `wx-if` 才出现的重组件。

**不要配占位：** 首屏立刻要出现的块。配了会先闪一层占位再替换。

页面 JSON 示例：

```json
{
  "usingComponents": {
    "sku-editor": "/components/sku-editor/index"
  },
  "componentPlaceholder": {
    "sku-editor": "view"
  }
}
```

占位优先用内置 `view`。只有需要骨架屏时，再做一个很轻的占位组件。官方限制：

- 被当作占位的组件，自己不能再配占位。
- 组件未加载且没有可用占位时，渲染会中断并报错。
- 占位期间不要调用该组件的方法；把它当成普通 `view`。

`project.config.json` / `project.private.config.json` 里的 `lazyloadPlaceholderEnable` 只用于**调试占位态**（打开后组件停在占位、不再注入）。日常开发保持 `false`，不要当正式开关。

## 3. 分包（体量上来再拆）

现在全在主包是合理的。出现以下任一情况再拆：

- 主包（不含插件）接近 1.5MB（指南建议阈值；单包上限 2MB）
- 某功能只被少数非 tab 页使用（报表、打印模板、批量导入等）
- 要接体积较大的第三方组件或插件

拆的时候：

- **tabBar 的 5 个页面必须留在主包**，不能放进分包。
- 仅被分包使用的 JS / 组件，不要留在主包。
- 跨分包引用组件必须配 `componentPlaceholder`，否则分包未下载完会中断渲染。
- 插件不要写进主包 `plugins`；放入分包并用分包异步化。

现在就拆分包会拉长路径：tab 跳转要等下载，而当前几乎吃不到收益。

## 4. 与代码质量扫描对齐

上传 / 提审前，用微信开发者工具跑一遍 **代码质量**。和本约定相关的项：

| 扫描项 | 本仓库怎么守 |
|---|---|
| 必须：开启组件懒注入 | `app.json` 保留 `lazyCodeLoading` |
| 必须：去掉无用插件 | 不在 `app.json` 留死插件 |
| 必须：去掉无依赖文件 | 无用文件不进代码包；`tests/`、`node_modules`、`docs/` 等保持 ignore；`ignoreUploadUnusedFiles` 保持 true |
| 压缩 JS / WXSS / WXML | 保持 `minified`、`minifyWXSS`、`minifyWXML` 为 true |
| 建议：图片/音频 >200KB | tab 图标可留包内；超过 200KB 的静态资源走 CDN |
| 建议：主包仅被分包依赖的 JS/组件 | 有分包之后再挪；现在无分包则不适用 |

## 5. 不要做

- 为了「用上用时注入」把现有页面硬拆成自定义组件。
- 把 WeUI / Vant 等整包挂到 `app.json` 全局组件（按需注入会形同虚设）。
- 给首屏关键块配 `componentPlaceholder`。
- 把 tab 页塞进分包。
- 把 `lazyCodeLoading` 删掉，或把 `lazyloadPlaceholderEnable` 长期设为 true。
- 在用时注入组件的 `attached` 里做页面占位阶段就必须完成的逻辑。

## 6. 改代码时的检查清单

改 `app.json`、页面 JSON、新增组件、引入插件或考虑分包时：

- [ ] `lazyCodeLoading` 仍在 `app.json`
- [ ] 没有把低频组件写进全局 `usingComponents`
- [ ] 页面 JSON 没有未使用的组件声明
- [ ] 非首屏重组件配了 `componentPlaceholder`；首屏组件没有
- [ ] 没有新增无用插件或无依赖文件
- [ ] tab 页仍在主包
- [ ] 准备上传时跑过代码质量扫描
