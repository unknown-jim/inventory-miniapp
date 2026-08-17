// 填开发者工具 → 云开发 → 设置里的环境 ID（微信侧）。
// 不要填腾讯云控制台里另一套环境。空着则不能记账。
const CLOUD_ENV_ID = 'cloud1-d4gnytngn0068f7ab'

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
