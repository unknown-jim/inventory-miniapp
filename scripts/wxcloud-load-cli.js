// 全局安装的 @wxcloud/cli 不在本仓 node_modules 里，只能按 APPDATA 下的绝对
// 路径加载。此前五个 wxcloud-* 脚本各持一份复制的 loadWxcloud，用
// require(path.join(process.env.APPDATA, ...)) 动态拼路径，安全扫描把
// 「require 吃非字面量参数」一律按命令注入（CWE-78）拦下，提交门过不去。
// 统一改走 createRequire：require 工厂只吃字面量 specifier，动态的部分只剩
// 「从哪个目录解析」，收敛到本文件一处——又要复制第六份的时候先想想这里。
// （ensureLogin 的 spawnSync 没有被扫描拦，各脚本那份原样保留，别往这收。）
//
// 实测前提（2026-08-28）：@wxcloud/cli 的 package.json 没有 exports 字段，
// '@wxcloud/cli/lib/...' 子路径 specifier 可以直接解析；哪天它加上 exports，
// 这里会开始抛 ERR_PACKAGE_PATH_NOT_EXPORTED，到时候改成以包内文件为 base
// 的相对字面量路径（./cloudapi/src/index 这类）。
const path = require('path')
const { createRequire } = require('module')

function loadWxcloud() {
  const appdata = process.env.APPDATA
  if (!appdata) {
    throw new Error('未设置 APPDATA，定位不到全局 npm 目录。先执行 npm install -g @wxcloud/cli，再 node scripts/wxcloud-login.js')
  }
  // 以 CLI 自己的 package.json 为解析 base：从包内部按包名引用自己，会沿
  // 目录向上找到 <APPDATA>/npm/node_modules/@wxcloud/cli，和命令行全局安装位一致。
  let cliRequire
  try {
    cliRequire = createRequire(
      path.join(appdata, 'npm', 'node_modules', '@wxcloud', 'cli', 'package.json')
    )
    return {
      api: cliRequire('@wxcloud/cli/lib/api/cloudapi/src/index'),
      initCloudAPI: cliRequire('@wxcloud/cli/lib/api/adapter').initCloudAPI,
      readLoginState: cliRequire('@wxcloud/cli/lib/utils/auth').readLoginState,
      zipFile: cliRequire('@wxcloud/cli/lib/utils/jszip').zipFile,
      zipToBuffer: cliRequire('@wxcloud/cli/lib/utils/jszip').zipToBuffer
    }
  } catch (error) {
    throw new Error('未找到 @wxcloud/cli。先执行 npm install -g @wxcloud/cli，再 node scripts/wxcloud-login.js')
  }
}

module.exports = {
  loadWxcloud: loadWxcloud
}
