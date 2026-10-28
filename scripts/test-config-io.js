// 配置导入导出的离线测试：只碰临时目录，不启动服务、不联网
//
//     node scripts/test-config-io.js
//
// 重点验证「覆盖式导入」的三条底线：
//   1. 导出能把配置与账号目录完整带走（含非 JSON 文件的兜底）；
//   2. 导入前一定留下快照，导入后文件与导出时一致；
//   3. 非法文件（格式不对 / 路径穿越）一律拒绝，且不动现有配置。

const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('node:os')
const path = require('node:path')

const dataDir = path.join(os.tmpdir(), 'airoute-config-io-test')
fs.removeSync(dataDir)
fs.ensureDirSync(dataDir)
process.env.AIROUTE_DATA_DIR = dataDir

const configIO = require(path.join(__dirname, '..', 'server', 'config-io.js'))

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, err })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${err.message}`)
  }
}

function readJson(file, fallback) {
  try {
    return fs.readJsonSync(path.join(dataDir, file))
  } catch {
    return fallback
  }
}

function writeFixtures() {
  fs.removeSync(dataDir)
  fs.ensureDirSync(path.join(dataDir, 'workbuddy-auths'))
  fs.ensureDirSync(path.join(dataDir, 'channels-data', 'channel-pack'))
  fs.writeJsonSync(path.join(dataDir, 'models.json'), {
    custom: { displayName: '自建源', baseURL: 'http://example.com/v1', apiKey: 'sk-test', models: [{ id: 'm1' }] }
  }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'rules.json'), {
    rules: [{ condition: 'long_context', target: 'custom/m1' }],
    customRules: [{ keyword: '翻译', target: 'custom/m1' }]
  }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'fallback.json'), { model: 'custom/m1' }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'state.json'), { current: 'custom/m1' }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'server-config.json'), { port: 3111 }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'workbuddy-auths', 'workbuddy-uid.json'), {
    uid: 'uid', accessToken: 'token'
  }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'channels-data', 'channel-credentials.json'), {
    gemini: { token: 't' }
  }, { spaces: 2 })
  fs.writeJsonSync(path.join(dataDir, 'channels-data', 'channel-pack', 'state.json'), { at: 1 }, { spaces: 2 })
  // 非 JSON 文件也要能原样带走（渠道包升级后可能落别的格式）
  fs.writeFileSync(path.join(dataDir, 'channels-data', 'channel-pack', 'note.txt'), 'raw text')
}

console.log('\n配置导入导出')

test('导出包含配置与账号目录，非 JSON 文件按文本带走', () => {
  writeFixtures()
  const data = configIO.exportAll()
  assert.equal(data.format, 'airoute-config')
  assert.equal(data.version, 1)
  assert.ok(data.exportedAt)
  assert.equal(data.config.models.custom.apiKey, 'sk-test')
  assert.equal(data.config.rules.rules.length, 1)
  assert.equal(data.config.state.current, 'custom/m1')
  assert.equal(data.accounts.workbuddy['workbuddy-uid.json'].accessToken, 'token')
  assert.equal(data.accounts.channels['channel-pack/note.txt'], 'raw text')
})

test('导入整体覆盖配置与账号，并留下导入前快照', () => {
  writeFixtures()
  const payload = configIO.exportAll()

  // 改成另一套配置，模拟在别的机器上导入
  payload.config.models = { other: { baseURL: 'http://other/v1', models: [{ id: 'x' }] } }
  payload.config.state = { current: 'other/x' }
  payload.config.server.port = 3222
  payload.accounts.workbuddy = { 'workbuddy-uid.json': { uid: 'uid', accessToken: 'new-token' } }
  payload.accounts.channels = { 'channel-credentials.json': { gemini: { token: 'new' } } }

  const result = configIO.importAll(payload)
  assert.equal(result.ok, true)
  assert.ok(fs.existsSync(result.backupFile))
  assert.ok(result.replaced.includes('models.json'))
  assert.ok(result.replaced.includes('workbuddy-auths'))

  assert.equal(readJson('models.json').other.models[0].id, 'x')
  assert.equal(readJson('state.json').current, 'other/x')
  assert.equal(readJson('server-config.json').port, 3222)
  assert.equal(readJson('workbuddy-auths/workbuddy-uid.json').accessToken, 'new-token')
  // 覆盖语义：导出里没有的旧文件不应残留
  assert.equal(fs.existsSync(path.join(dataDir, 'channels-data', 'channel-pack', 'note.txt')), false)

  const backup = fs.readJsonSync(result.backupFile)
  assert.equal(backup.format, 'airoute-config')
  assert.equal(backup.config.models.custom.apiKey, 'sk-test')
})

test('导入文件缺 accounts 时保留现有账号目录', () => {
  writeFixtures()
  const payload = configIO.exportAll()
  delete payload.accounts.channels

  configIO.importAll(payload)
  assert.ok(fs.existsSync(path.join(dataDir, 'channels-data', 'channel-credentials.json')))
})

test('拒绝格式不对的文件，且不动现有配置', () => {
  writeFixtures()
  const before = fs.readJsonSync(path.join(dataDir, 'models.json'))
  assert.throws(() => configIO.importAll({ hello: 'world' }), /不是 AiRoute 配置文件/)
  assert.throws(() => configIO.importAll({ format: 'airoute-config', version: 99, config: { models: {} } }), /更新的版本/)
  assert.throws(() => configIO.importAll({ format: 'airoute-config', version: 1, config: {} }), /缺少模型来源/)
  assert.throws(
    () => configIO.importAll({ format: 'airoute-config', version: 1, config: { models: {}, server: { port: 70000 } } }),
    /端口/
  )
  assert.throws(
    () => configIO.importAll({ format: 'airoute-config', version: 1, config: { models: {}, state: { current: 42 } } }),
    /当前模型/
  )
  assert.throws(
    () => configIO.importAll({ format: 'airoute-config', version: 1, config: { models: {}, fallback: { model: 1 } } }),
    /兜底模型/
  )
  assert.deepEqual(fs.readJsonSync(path.join(dataDir, 'models.json')), before)
})

test('拒绝账号目录里的路径穿越，且不动现有配置', () => {
  writeFixtures()
  const payload = configIO.exportAll()
  payload.accounts.workbuddy = { '../escape.json': { bad: true } }
  assert.throws(() => configIO.importAll(payload), /非法路径/)
  assert.equal(fs.existsSync(path.join(dataDir, '..', 'escape.json')), false)
  assert.equal(readJson('workbuddy-auths/workbuddy-uid.json').accessToken, 'token')
})

test('备份只保留最近 5 份', () => {
  writeFixtures()
  for (let i = 0; i < 7; i++) {
    // 文件名精确到毫秒，连续导入也可能落在同一毫秒 —— 睡 2ms 保证是不同快照
    const until = Date.now() + 2
    while (Date.now() < until) {}
    configIO.importAll(deleteAccounts(configIO.exportAll()))
  }
  const backups = fs.readdirSync(path.join(dataDir, 'config-backups'))
  assert.ok(backups.length <= 5, `期望 ≤ 5 份，实际 ${backups.length} 份`)
  assert.ok(backups.length >= 1)
})

test('清空配置抹掉模型、规则与账号，保留服务端设置并留快照', () => {
  writeFixtures()
  const result = configIO.clearAll()
  assert.equal(result.ok, true)
  assert.ok(fs.existsSync(result.backupFile))

  assert.deepEqual(readJson('models.json'), {})
  assert.deepEqual(readJson('rules.json'), { rules: [], customRules: [] })
  assert.deepEqual(readJson('fallback.json'), { model: '' })
  assert.deepEqual(readJson('state.json'), { current: 'auto' })
  // 端口属于服务端设置，不该被清掉
  assert.equal(readJson('server-config.json').port, 3111)
  assert.equal(fs.existsSync(path.join(dataDir, 'workbuddy-auths')), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'channels-data')), false)

  // 快照可以再导入回来
  configIO.importAll(fs.readJsonSync(result.backupFile))
  assert.equal(readJson('models.json').custom.apiKey, 'sk-test')
})

function deleteAccounts(payload) {
  delete payload.accounts
  return payload
}

console.log(`\n${passed}/${passed + failed} 项通过`)
if (failed) {
  for (const { name, err } of failures) console.log(`\n${name}\n${err.stack}`)
  process.exit(1)
}
