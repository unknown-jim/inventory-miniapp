const path = require('path')
const env = require('./wxcloud-env')

const root = path.join(__dirname, '..')
env.loadDotEnv(root)
const ENV_ID = env.readEnvId(root)
const NAME = 'ledger'
const FN_DIR = path.join(root, 'cloudfunctions', 'ledger')
// 函数的资源配置**只有 cloudfunctions/ledger/config.json 一份定义**，这里读它。
// 曾经在本文件里另写死过一份 memorySize: 256 / timeout: 20，代价是：线上为了让
// 3.6 MB 账本的 initMigration 跑得完（20 秒实测超时）手工调成 60 秒 / 512 MB，
// 下一次部署又被这里按 20 / 256 覆盖回去，migrateRecords 当场重新超时——而
// 部署日志里看不出发生过覆盖。缺字段就抛，不许拿 undefined 去部署。
const FN_CONFIG = require(path.join(FN_DIR, 'config.json'))
if (typeof FN_CONFIG.memorySize !== 'number' || typeof FN_CONFIG.timeout !== 'number') {
  throw new Error('cloudfunctions/ledger/config.json 里缺 memorySize / timeout')
}
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
      memorySize: FN_CONFIG.memorySize,
      timeout: FN_CONFIG.timeout,
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
    memorySize: FN_CONFIG.memorySize,
    timeout: FN_CONFIG.timeout,
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
  // platform_admins 漏了同样致命但更隐蔽：门是 fail-closed 的，部署完三个运维
  // action（checkAggregates / migrateRecords / recomputeAggregates）对**所有人**
  // 拒绝，谁也迁不了 —— 而那一刻正是全店停摆、等着跑迁移的时刻。所以这张表
  // 必须在建集合清单里，而且要在部署新云函数**之前**建好并写入运营方 openid。
  // 表建完后补 ledger_records 的 6 条索引，并把六张业务表权限设成 ADMINONLY
  // （幂等），见 scripts/wxcloud-ensure-indexes.js、scripts/wxcloud-ensure-acl.js。
  const names = ['shops', 'members', 'ledgers', 'ledger_records', 'ledger_clears', 'platform_admins']
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
  const indexes = require('./wxcloud-ensure-indexes')
  await indexes.ensureIndexes(wx.api, { region: region, tag: tag })
  const acl = require('./wxcloud-ensure-acl')
  await acl.ensureAcl(wx.api, { envId: ENV_ID })
}

main().catch(function (error) {
  console.error(error.message || error)
  process.exit(1)
})
