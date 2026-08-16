// 把云开发环境 ID 填在这里（开发者工具 → 云开发 → 设置）。
// 空着则不能记账，也不会悄悄使用「第一个云环境」。
const CLOUD_ENV_ID = 'cloud1-d3g8tukt6525022b6'

function getCloudEnvId() {
  return String(CLOUD_ENV_ID || '').trim()
}

function isConfigured() {
  return getCloudEnvId().length > 0
}

function missingMessage() {
  return '未配置云环境 ID，无法记账。请在 utils/cloud-config.js 填写 CLOUD_ENV_ID。'
}

module.exports = {
  CLOUD_ENV_ID: CLOUD_ENV_ID,
  getCloudEnvId: getCloudEnvId,
  isConfigured: isConfigured,
  missingMessage: missingMessage
}
