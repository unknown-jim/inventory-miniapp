const path = require('path')
const env = require('./wxcloud-env')

const root = path.join(__dirname, '..')
env.loadDotEnv(root)
const ENV_ID = env.readEnvId(root)
const NAME = 'ledger'
const FN_DIR = path.join(root, 'cloudfunctions', 'ledger')
const HelloWorldCode =
  'UEsDBBQACAAIALB+WU4AAAAAAAAAAAAAAAAIABAAaW5kZXguanNVWAwAAZ9zXPuec1z1ARQAdY7BCsIwEETv+Yoll6ZQ+wOhnv0DD+IhxkWC664kWwmI/27V3IpzGuYNw3RzQSiaU9TOG6x3yVrGW0gMEzh8IOsAUVixfkwgOoV47WHawtPAooUVIRxJLs7ukEhgL5nOtl/h79qf+GBZeIM1FbXHdac9aKC9cDwTDfCb9eblzRtQSwcI6+pcr4AAAADOAAAAUEsBAhUDFAAIAAgAsH5ZTuvqXK+AAAAAzgAAAAgADAAAAAAAAAAAQKSBAAAAAGluZGV4LmpzVVgIAAGfc1z7nnNcUEsFBgAAAAABAAEAQgAAAMYAAAAAAA=='

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function loadWxcloud() {
  const cliRoot = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@wxcloud', 'cli')
  try {
    return {
      api: require(path.join(cliRoot, 'lib/api/cloudapi/src/index')),
      initCloudAPI: require(path.join(cliRoot, 'lib/api/adapter')).initCloudAPI,
      readLoginState: require(path.join(cliRoot, 'lib/utils/auth')).readLoginState,
      zipFile: require(path.join(cliRoot, 'lib/utils/jszip')).zipFile,
      zipToBuffer: require(path.join(cliRoot, 'lib/utils/jszip')).zipToBuffer
    }
  } catch (error) {
    throw new Error('未找到 @wxcloud/cli。先执行 npm install -g @wxcloud/cli，再 node scripts/wxcloud-login.js')
  }
}

async function waitActive(api, region) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < 15 * 60 * 1000) {
    const info = await api.scfGetFunctionInfo({
      namespace: ENV_ID,
      region: region,
      functionName: NAME,
      codeSecret: undefined
    })
    if (info.status !== last) {
      console.log('status', info.status, info.statusDesc || '')
      last = info.status
    }
    if (info.status === 'Active') return info
    if (info.status === 'CreateFailed' || info.status === 'UpdateFailed') {
      throw new Error(info.status + ': ' + (info.statusDesc || ''))
    }
    await sleep(3000)
  }
  throw new Error('timeout waiting for Active')
}

async function ensureLogin(wx) {
  try {
    const state = await wx.readLoginState()
    if (state && state.appid) return state
  } catch (error) {
    /* not logged in */
  }
  const { spawnSync } = require('child_process')
  const login = spawnSync(process.execPath, [path.join(__dirname, 'wxcloud-login.js')], {
    stdio: 'inherit'
  })
  if (login.status) process.exit(login.status)
  return wx.readLoginState()
}

async function main() {
  env.requirePrivateKey()
  const wx = loadWxcloud()
  const state = await ensureLogin(wx)
  wx.initCloudAPI(state.appid)
  const { envList } = await wx.api.tcbGetEnvironments({})
  const currentEnv = envList.find(function (item) {
    return item.envId === ENV_ID
  })
  if (!currentEnv) {
    throw new Error(
      '环境不在该 AppID 下: ' +
        ENV_ID +
        ' / ' +
        envList
          .map(function (item) {
            return item.envId
          })
          .join(',')
    )
  }
  const region = currentEnv.functions[0].region
  console.log('env', ENV_ID, 'region', region)

  let exists = false
  try {
    await wx.api.scfGetFunctionInfo({
      namespace: ENV_ID,
      region: region,
      functionName: NAME
    })
    exists = true
  } catch (error) {
    if (!(error && error.code === 'ResourceNotFound.Function')) throw error
  }

  if (!exists) {
    console.log('creating function')
    await wx.api.scfCreateFunction({
      functionName: NAME,
      code: { zipFile: HelloWorldCode },
      handler: 'index.main',
      description: '按店隔离的云记账',
      memorySize: 256,
      timeout: 20,
      environment: { variables: [] },
      role: 'TCB_QcsRole',
      runtime: 'Nodejs16.13',
      namespace: ENV_ID,
      region: region,
      stamp: 'MINI_QCBASE',
      installDependency: true,
      clsLogsetId: currentEnv.logServices && currentEnv.logServices[0] && currentEnv.logServices[0].logsetId,
      clsTopicId: currentEnv.logServices && currentEnv.logServices[0] && currentEnv.logServices[0].topicId
    })
    await waitActive(wx.api, region)
  }

  await wx.api.scfUpdateFunctionInfo({
    namespace: ENV_ID,
    region: region,
    functionName: NAME,
    memorySize: 256,
    timeout: 20,
    installDependency: true
  })
  await waitActive(wx.api, region)

  const zip = wx.zipFile(FN_DIR, { ignore: ['node_modules'] })
  const zipBuffer = await wx.zipToBuffer(zip)
  console.log('updating code')
  await wx.api.scfUpdateFunction({
    functionName: NAME,
    namespace: ENV_ID,
    region: region,
    handler: 'index.main',
    installDependency: true,
    fileData: zipBuffer.toString('base64')
  })
  await waitActive(wx.api, region)
  console.log('function deployed')

  const db = currentEnv.databases && currentEnv.databases[0]
  const tag = (db && db.instanceId) || ENV_ID
  // ledger_records 漏了就是**上线路径直接断掉**：集合不存在，部署完每一次流水
  // 查询（listRecords / getSlip / getRecord / 记账）都报错。
  // 建表不建索引 —— 那 6 条复合索引仍须在控制台手建，见 docs/cloud-ledger.md。
  const names = ['shops', 'members', 'ledgers', 'ledger_records', 'ledger_clears']
  let tables = []
  try {
    const listed = await wx.api.flexdbListTables({
      region: region,
      tag: tag,
      mgoLimit: 100,
      mgoOffset: 0
    })
    tables = (listed.tables || []).map(function (item) {
      return item.tableName
    })
  } catch (error) {
    console.log('list tables failed', error.message || error)
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (tables.indexOf(name) >= 0) continue
    try {
      await wx.api.flexdbCreateTable({ region: region, tag: tag, tableName: name })
      console.log('created table', name)
    } catch (error) {
      console.log('create table', name, error.message || error.code || error)
    }
  }
}

main().catch(function (error) {
  console.error(error.message || error)
  process.exit(1)
})
