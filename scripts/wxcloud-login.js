const { spawnSync } = require('child_process')
const path = require('path')
const env = require('./wxcloud-env')

const root = path.join(__dirname, '..')
env.loadDotEnv(root)
const appId = env.readAppId(root)
const privateKey = env.requirePrivateKey()

const result = spawnSync(
  process.platform === 'win32' ? 'wxcloud.cmd' : 'wxcloud',
  ['login', '-a', appId, '-k', privateKey],
  { stdio: 'inherit' }
)
if (result.status) process.exit(result.status)
