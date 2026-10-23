// 账号「被上游禁用」判定的离线回归：不联网、不需要真实账号
//
//     node scripts/test-account-health.js
//
// 这里只测「认出什么文案 / 从哪些返回里认 / 台账读写」这三件事。
// 真正「测一下就把号停掉」要走渠道包，在 scripts/test-channels.js 与
// scripts/smoke-e2e.js 的口径之外，需要真实账号，故不放这里。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const dataDir = path.join(os.tmpdir(), 'airoute-account-health-test')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
// paths 在调用时读环境变量，赶在第一次读写台账之前设好
process.env.AIROUTE_DATA_DIR = dataDir

const health = require(path.join(root, 'server/account-health.js'))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const ACCOUNT = 'lobsterai-a1b2c3'
// 实测原话（界面上的 toast 就长这样）
const DISABLED_TEXT = '无法确认：lobsterai: code=40302 账号已被禁用'

// 渠道包封套：成功时是 { ok: true, value }，失败时是 { ok: false, error }
const ok = value => ({ ok: true, value })

check('认得出「账号已被禁用」的结论性文案', () => {
  assert.equal(health.isDisabledSignal(DISABLED_TEXT), true)
  assert.equal(health.isDisabledSignal('code=40302'), true)
  assert.equal(health.isDisabledSignal('账号已被停用'), true)
  assert.equal(health.isDisabledSignal('该帐号被禁用'), true)
  assert.equal(health.isDisabledSignal('upstream: Account has been disabled'), true)
  assert.equal(health.isDisabledSignal('account is banned'), true)
})

check('未知与临时状态不算禁用', () => {
  // 这些是「问不到」或「还能用但慢」，据此停用会把好号关掉
  assert.equal(health.isDisabledSignal('无法确认：网络超时'), false)
  assert.equal(health.isDisabledSignal('仍受限：429 rate limit，重置时间 12:00'), false)
  assert.equal(health.isDisabledSignal('积分查询失败（凭证失效或响应异常）'), false)
  assert.equal(health.isDisabledSignal('余额为 0'), false)
  assert.equal(health.isDisabledSignal(''), false)
  assert.equal(health.isDisabledSignal(undefined), false)
  assert.equal(health.isDisabledSignal({ message: DISABLED_TEXT }), false, '非字符串一律不认')
})

check('account.test 失败且带禁用文案 → 有证据', () => {
  const result = ok({ accountId: ACCOUNT, modelId: 'lobsterai/claude-sonnet-4', ok: false, message: DISABLED_TEXT })
  assert.deepEqual(health.evidenceOf('account.test', { accountId: ACCOUNT }, result), [
    { accountId: ACCOUNT, reason: DISABLED_TEXT }
  ])
})

check('account.test 成功 / 其它失败原因 → 没有证据', () => {
  assert.deepEqual(health.evidenceOf('account.test', { accountId: ACCOUNT }, ok({ accountId: ACCOUNT, ok: true })), [])
  const timeout = ok({ accountId: ACCOUNT, ok: false, message: '无法确认：网络超时' })
  assert.deepEqual(health.evidenceOf('account.test', { accountId: ACCOUNT }, timeout), [])
})

check('account.retest 的 stillLimited 逐条看', () => {
  const result = ok({
    accountId: ACCOUNT,
    tested: 2,
    cleared: [],
    stillLimited: [
      { modelId: 'a', ok: false, message: DISABLED_TEXT },
      { modelId: 'b', ok: false, message: '仍受限：429' }
    ]
  })
  const evidence = health.evidenceOf('account.retest', { accountId: ACCOUNT }, result)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].accountId, ACCOUNT)
})

check('account.retestAll 能把证据归属到各自账号', () => {
  const result = ok({
    accounts: [
      { accountId: 'other-x', stillLimited: [{ modelId: 'a', ok: false, message: '仍受限：429' }] },
      { accountId: ACCOUNT, stillLimited: [{ modelId: 'b', ok: false, message: DISABLED_TEXT }] }
    ]
  })
  assert.deepEqual(health.evidenceOf('account.retestAll', {}, result), [
    { accountId: ACCOUNT, reason: DISABLED_TEXT }
  ])
})

check('credits.balances 的 error 也算证据', () => {
  const result = ok({
    accounts: [
      { accountId: ACCOUNT, balance: null, error: DISABLED_TEXT },
      { accountId: 'other-x', balance: { total: 10 } }
    ]
  })
  assert.deepEqual(health.evidenceOf('credits.balances', { provider: 'lobsterai' }, result), [
    { accountId: ACCOUNT, reason: DISABLED_TEXT }
  ])
})

check('不看 account.list 的 refreshError（那是上一次刷新的残留）', () => {
  const result = ok({ accounts: [{ id: ACCOUNT, enabled: true, refreshError: DISABLED_TEXT }] })
  assert.deepEqual(health.evidenceOf('account.list', { provider: 'lobsterai' }, result), [])
})

check('封套本身失败 / 值不是对象时没有证据', () => {
  assert.deepEqual(health.evidenceOf('account.test', { accountId: ACCOUNT }, { ok: false, error: { message: DISABLED_TEXT } }), [])
  assert.deepEqual(health.evidenceOf('account.test', { accountId: ACCOUNT }, ok(null)), [])
  assert.deepEqual(health.evidenceOf('account.test', { accountId: ACCOUNT }, null), [])
})

check('台账：记录、查原因、清掉', () => {
  health.reset()
  assert.equal(health.reasonOf(ACCOUNT), null)
  health.record(ACCOUNT, DISABLED_TEXT, 'lobsterai')
  const rec = health.reasonOf(ACCOUNT)
  assert.equal(rec.reason, DISABLED_TEXT)
  assert.equal(rec.provider, 'lobsterai')
  assert.ok(rec.since > 0)
  assert.equal(health.list().length, 1)
  // 用户重新启用：原因不该继续挂着
  assert.equal(health.clear(ACCOUNT), true)
  assert.equal(health.reasonOf(ACCOUNT), null)
  assert.equal(health.clear(ACCOUNT), false, '没有记录时清也不该报错')
})

check('同一账号同一原因重复记录不重写时间戳', () => {
  health.reset()
  const first = health.record(ACCOUNT, DISABLED_TEXT, 'lobsterai')
  const second = health.record(ACCOUNT, DISABLED_TEXT, 'lobsterai')
  assert.equal(second.since, first.since, '轮询会反复喂同一条证据，不该每次都改文件')
  const changed = health.record(ACCOUNT, '账号已被封禁', 'lobsterai')
  assert.notEqual(changed.reason, DISABLED_TEXT, '换了说法就更新原因')
})

check('prune 清掉池子里已不存在的账号', () => {
  health.reset()
  health.record(ACCOUNT, DISABLED_TEXT, 'lobsterai')
  health.record('gone-x', DISABLED_TEXT, 'lobsterai')
  health.prune([ACCOUNT])
  assert.equal(health.reasonOf(ACCOUNT)?.reason, DISABLED_TEXT)
  assert.equal(health.reasonOf('gone-x'), null)
})

check('台账落盘后能重新读回', () => {
  health.reset()
  health.record(ACCOUNT, DISABLED_TEXT, 'lobsterai')
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'account-health.json'), 'utf8'))
  assert.equal(saved.accounts[ACCOUNT].reason, DISABLED_TEXT)
  assert.equal(saved.accounts[ACCOUNT].provider, 'lobsterai')
})

check('空的 / 非字符串账号 id 不记账', () => {
  health.reset()
  assert.equal(health.record('', DISABLED_TEXT), null)
  assert.equal(health.record(undefined, DISABLED_TEXT), null)
  assert.equal(health.list().length, 0)
})

async function main() {
  let failed = 0
  for (const item of checks) {
    try {
      await item.fn()
      console.log(`ok   ${item.name}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL ${item.name}\n     ${error.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
