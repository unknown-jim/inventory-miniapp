const fs = require('fs')
const path = require('path')

function loadDotEnv(root) {
  const file = path.join(root, '.env')
  if (!fs.existsSync(file)) return
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.charAt(0) === '#') return
    const eq = trimmed.indexOf('=')
    if (eq <= 0) return
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
      (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value
  })
}

function readAppId(root) {
  if (process.env.WXCLOUD_APPID) return String(process.env.WXCLOUD_APPID).trim()
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  return String(project.appid || '').trim()
}

function readEnvId(root) {
  if (process.env.WXCLOUD_ENV_ID) return String(process.env.WXCLOUD_ENV_ID).trim()
  // require 只吃字面量路径（动态拼接会被安全扫描按命令注入拦）；本文件恒在
  // scripts/ 下，'../utils/cloud-config.js' 与原先的 path.join(root, ...) 同址。
  // root 参数为保持调用方签名不变而保留。
  const cloudConfig = require('../utils/cloud-config.js')
  return cloudConfig.getCloudEnvId()
}

function requirePrivateKey() {
  const key = String(process.env.WXCLOUD_PRIVATE_KEY || '').trim()
  if (!key) {
    throw new Error(
      '未设置 WXCLOUD_PRIVATE_KEY。在用户环境变量或仓库根目录 .env 里填写（.env 已 gitignore）。不要把密钥写进仓库或贴到对话。'
    )
  }
  return key
}

module.exports = {
  loadDotEnv: loadDotEnv,
  readAppId: readAppId,
  readEnvId: readEnvId,
  requirePrivateKey: requirePrivateKey
}
