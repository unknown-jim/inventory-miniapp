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

脚本会：登录（若尚未登录）→ 创建或更新云函数 `ledger`（超时 20 秒、云端装依赖）→ 补齐集合 `shops` / `members` / `ledgers` / `ledger_records` / `ledger_clears` / `platform_admins` → 补齐 `ledger_records` 的 6 条索引 → 把六张业务表权限设成 `ADMINONLY`。

注意：脚本是**先更新函数代码、后建表**，而账本升级的运维门是 fail-closed 的——`platform_admins` 必须在部署**之前**建好并写入运营方 openid，否则新代码上线后三个运维 action 对所有人拒绝。顺序和恢复路见 `docs/cloud-ledger.md` 的「账本升级」（建表 / 插文档 / 核对权限一条命令：`node scripts/wxcloud-ensure-platform-admin.js <运营方 openid>`）。

不要用 `wxcloud function:upload` 做第一次创建：官方命令会先查函数信息，函数不存在时直接失败。

## 建索引

`ledger_records` 的 6 条复合索引不要在控制台手点。已验证可用 `@wxcloud/cli` 内部接口 `flexdbDescribeTable` / `flexdbUpdateTable`（`createIndexes`）。可单独跑：

```bash
node scripts/wxcloud-ensure-indexes.js
```

幂等：只补「字段名 + 升降序」还不存在的索引。升降序用 `'1'` / `'-1'`。定义与 `cloudfunctions/ledger/ledger-records.js` 顶部注释、`docs/cloud-ledger.md` 必须一致。不要把密钥写进命令输出。

## 设权限

六张业务表 `shops` / `members` / `ledgers` / `ledger_records` / `ledger_clears` / `platform_admins` 必须是 `ADMINONLY`（仅管理端可读写）。不要在控制台手点。已验证可用 `@wxcloud/cli` 内部接口 `tcbDescribeDatabaseACL` / `tcbModifyDatabaseACL`。可单独跑：

```bash
node scripts/wxcloud-ensure-acl.js
```

**不要传 region**，一传 `Describe` 会报 `UnknownParameter`。幂等：已经是 `ADMINONLY` 的表会跳过。控制台新建的表常常是 `PRIVATE`（仅创建者可读写）。不要把密钥写进命令输出。

## 白名单 platform_admins

账本升级三个运维 action 的门（集合 `platform_admins`，`_id` = openid）。不要在控制台手点，也不要裸调内部接口，脚本已写好且幂等：

```bash
node scripts/wxcloud-ensure-platform-admin.js <运营方 openid>
```

集合缺了先建、权限核对 `ADMINONLY`、同 `_id` 已存在跳过不覆盖，跑完打印集合现状。**必须在部署新云函数之前跑**——门是 fail-closed 的，部署完才建名单，三个运维 action 会对所有人拒绝（见 `docs/cloud-ledger.md` 的「账本升级」）。名单空了 / 被删导致锁死时，也用这条命令恢复，不用重新部署云函数。

## 环境 ID 与 AppID

`utils/cloud-config.js` 的 `CLOUD_ENV_ID` 必须等于开发者工具「云开发 → 设置」里的环境 ID，且与 `project.config.json` 的 `appid` 是同一套绑定。填腾讯云控制台另一套环境会 `-501000 Environment not found`。

小程序端继续 `wx.cloud.init({ env })` 显式传 ID，不要用客户端 `DYNAMIC_CURRENT_ENV`。
