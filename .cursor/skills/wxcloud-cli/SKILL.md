---
name: wxcloud-cli
description: >-
  Logs in with the WeChat Cloud Run CLI and deploys the ledger cloud function
  using WXCLOUD_PRIVATE_KEY. Use when deploying ledger, running wxcloud login,
  using 微信云托管 CLI 密钥, or fixing Environment not found / INVALID_ENV.
---

# 微信云托管 CLI

微信侧云环境用 `@wxcloud/cli`（`wxcloud`），不要用腾讯云账号的 `tcb`。CLI 私钥只放环境变量，禁止写入仓库、PR、skill 或聊天回复。

官方说明：[CLI工具](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/cli/)

## 环境变量

| 变量 | 用途 |
|---|---|
| `WXCLOUD_PRIVATE_KEY` | 云托管控制台 → 设置 → CLI 密钥（必填，保密） |
| `WXCLOUD_APPID` | 小程序 AppID；缺省读 `project.config.json` |
| `WXCLOUD_ENV_ID` | 云环境 ID；缺省读 `utils/cloud-config.js` |

本机优先级：进程环境变量 → 用户环境变量 → 仓库根目录 `.env`（已 gitignore）。模板是 `.env.example`。

没有 `WXCLOUD_PRIVATE_KEY` 时停下来，让用户去控制台生成并设环境变量。不要让用户把密钥贴进对话。

## 登录

```bash
npm install -g @wxcloud/cli
node scripts/wxcloud-login.js
```

等价于 `wxcloud login -a <AppID> -k <密钥>`。命令输出里不要打印密钥。

## 部署 ledger

改过 `utils/inventory.js` 或 `utils/ledger-apply.js` 时，先 `npm run sync:ledger-inventory`。

```bash
node scripts/wxcloud-deploy-ledger.js
```

脚本会：登录（若尚未登录）→ 创建或更新云函数 `ledger`（超时 20 秒、云端装依赖）→ 补齐集合 `shops` / `members` / `ledgers` / `ledger_clears`。

不要用 `wxcloud function:upload` 做第一次创建：官方命令会先查函数信息，函数不存在时直接失败。

集合权限仍须在微信云开发控制台设成「仅管理端可读写」。

## 环境 ID 与 AppID

`utils/cloud-config.js` 的 `CLOUD_ENV_ID` 必须等于开发者工具「云开发 → 设置」里的环境 ID，且与 `project.config.json` 的 `appid` 是同一套绑定。填腾讯云控制台另一套环境会 `-501000 Environment not found`。

小程序端继续 `wx.cloud.init({ env })` 显式传 ID，不要用客户端 `DYNAMIC_CURRENT_ENV`。
