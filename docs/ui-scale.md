# 操作界面字号和点击区域

给中老年店主看、点。送货单是给客户看的单据版式，不走这套。

## 依据

- [小程序适老化设计指南](https://developers.weixin.qq.com/miniprogram/design/elderly.html)（微信官方：正文随字号放大，可点热区至少约 44pt）
- 工信部适老化常见要求：正文不小于约 18px（本仓库按 375 宽屏约 36rpx 来对）

下面的「必须」以这两处为准；档位和默认值按本仓库形态推导：单人记账小程序、使用者多为店主、销售页字段密。

## 怎么做

字号和按钮高度写在 `app.wxss` 的 CSS 变量里，不要在页面里再写 22rpx、24rpx 这种小字，也不要再写 64rpx 高的可点按钮。

| 变量 | 含义 |
|---|---|
| `--fs-xs` | 标签、角标 |
| `--fs-sm` | 次要说明、筛选项 |
| `--fs-md` | 正文、输入 |
| `--fs-lg` | 标题、主按钮文字 |
| `--fs-xl` / `--fs-hero` | 金额、看板数字 |
| `--tap-sm` / `--tap-md` / `--tap-lg` | 可点控件高度 |
| `--chip-min` | 胶囊选项最小高度 |

看板提供「标准 / 大 / 更大」。默认是 **大**。选档存在本地 `inv_ui_scale`，各页用 `utils/ui-scale.js` 的 behavior 给根节点加上 `ui-std` / `ui-lg` / `ui-xl`。

新页面要：

1. `require('../../utils/ui-scale')`
2. `behaviors: [uiScale.behavior]`
3. 根节点 `class="page {{uiScaleClass}}"`
4. 字号和可点高度用上面的变量，不要写死更小的 rpx

## 不要做

- 不要为了跟微信「关怀模式」把全站改成 rem。当前布局按 rpx 排，跟系统 1.4 倍容易把销售页撑破。
- 不要把送货单 `styles/slip.wxss` 和画布导出字号套进这套变量。
- 不要把低频设置做成新的 tab；入口放看板底部。
