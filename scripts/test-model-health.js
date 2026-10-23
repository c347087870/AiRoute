// 模型失活台账的离线回归：不联网、不需要真实账号
//
//     node scripts/test-model-health.js
//
// 这里只测「规则本身」：连续失败阈值、成功清零、余额/账号判据、恢复语义。
// 真实链路（/v1/models 不再播报、建链跳过）在 scripts/smoke-e2e.js 里验证 ——
// 那部分要起服务、要 mock 上游，放这里会把一次单元回归拖成端到端。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const dataDir = path.join(os.tmpdir(), 'airoute-model-health-test')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
// paths 在调用时读环境变量，赶在第一次读写台账之前设好
process.env.AIROUTE_DATA_DIR = dataDir

const health = require(path.join(root, 'server/model-health.js'))
const audit = require(path.join(root, 'server/model-health-audit.js'))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const REF = 'channels/gemini/gemini-2.5-pro'

check('默认健康：未记录的引用不是失活', () => {
  health.reset()
  assert.equal(health.isOffline(REF), false)
  assert.equal(health.stateOf(REF).offline, false)
  assert.equal(health.stateOf(REF).failures, 0)
})

check('连续失败到第 3 次才失活', () => {
  health.reset()
  health.noteFailure(REF, 'upstream 502')
  health.noteFailure(REF, 'upstream 502')
  assert.equal(health.isOffline(REF), false, '两次失败还算正常抖动')
  assert.equal(health.stateOf(REF).failures, 2)
  const rec = health.noteFailure(REF, 'upstream 502')
  assert.equal(rec.offline, true)
  assert.equal(rec.reason, 'errors')
  assert.match(rec.detail, /连续 3 次失败/)
  assert.equal(health.isOffline(REF), true)
})

check('成功一次清零连续失败', () => {
  health.reset()
  health.noteFailure(REF, 'x')
  health.noteFailure(REF, 'x')
  health.noteSuccess(REF)
  assert.equal(health.stateOf(REF).failures, 0)
  // 清零后再失败两次仍不失活：说明确实从 0 重新数
  health.noteFailure(REF, 'x')
  health.noteFailure(REF, 'x')
  assert.equal(health.isOffline(REF), false)
})

check('失活后不再叠加失败、原因不被覆盖', () => {
  health.reset()
  health.markOffline(REF, 'balance', '剩余额度为 0')
  health.noteFailure(REF, 'upstream 502')
  health.noteFailure(REF, 'upstream 502')
  const rec = health.stateOf(REF)
  assert.equal(rec.reason, 'balance')
  assert.equal(rec.detail, '剩余额度为 0')
})

check('成功可自动恢复「连续失败」造成的失活', () => {
  health.reset()
  for (let i = 0; i < health.OFFLINE_AFTER_FAILURES; i += 1) health.noteFailure(REF, 'x')
  assert.equal(health.isOffline(REF), true)
  const rec = health.noteSuccess(REF)
  assert.equal(rec.offline, false, '能成功一次就说明链路是通的')
  assert.equal(rec.reason, '')
})

check('成功不会顺手恢复余额/账号失活', () => {
  health.reset()
  health.markOffline(REF, 'balance', '剩余额度为 0')
  health.noteSuccess(REF)
  assert.equal(health.isOffline(REF), true, '余额是外部事实，得等审计确认够用')
})

check('成功记下「一次请求消耗」样本', () => {
  health.reset()
  health.noteSuccess(REF, 12)
  assert.equal(health.stateOf(REF).credits, 12)
  health.noteSuccess(REF) // 没有新样本时保留旧值
  assert.equal(health.stateOf(REF).credits, 12)
  health.noteSuccess(REF, 0) // 0 是「免费」而不是「未提供」：不能当成本
  assert.equal(health.stateOf(REF).credits, 12)
})

check('手动恢复清掉标记但保留消耗样本', () => {
  health.reset()
  health.markOffline(REF, 'balance', 'x')
  health.noteSuccess(REF, 7)
  const rec = health.revive(REF)
  assert.equal(rec.offline, false)
  assert.equal(rec.failures, 0)
  assert.equal(rec.credits, 7)
})

check('judge：账号全被禁用', () => {
  assert.deepEqual(
    health.judge({ accounts: { total: 2, enabled: 0 }, balance: { best: null, unit: 0 } }),
    { offline: true, reason: 'account', detail: '该渠道没有可用账号（全部被禁用）' }
  )
  assert.equal(health.judge({ accounts: { total: 2, enabled: 1 }, balance: { best: null, unit: 0 } }).offline, false)
  // 一个账号都没有（未登录）：不算「被禁用」—— 渠道包另有「没有账号」的说法
  assert.equal(health.judge({ accounts: { total: 0, enabled: 0 }, balance: { best: null, unit: 0 } }).offline, false)
})

check('judge：余额不足一次请求', () => {
  assert.equal(health.judge({ balance: { best: 0, unit: 0 } }).reason, 'balance')
  assert.equal(health.judge({ balance: { best: 5, unit: 12 } }).reason, 'balance', '还剩 5，单次要 12')
  assert.equal(health.judge({ balance: { best: 12, unit: 12 } }).offline, false, '刚好够一次就还能跑')
  assert.equal(health.judge({ balance: { best: 5, unit: 0 } }).offline, false, '没有消耗样本时不能凭 5 判死')
})

check('judge：余额未知时不下判断', () => {
  // null = 查不到（凭证过期/网络异常），不是 0：凭它下线等于把整排模型藏起来
  const verdict = health.judge({ accounts: { total: 1, enabled: 1 }, balance: { best: null, unit: 9 } })
  assert.equal(verdict.offline, false)
  assert.equal(verdict.unknown, true, '要标出「读数不可信」，审计才不会拿它给旧的余额失活翻案')
})

check('审计规则：余额读数不可信时不替余额失活翻案', () => {
  const { apply } = audit._internal
  health.reset()
  health.markOffline(REF, 'balance', '剩余额度为 0')
  apply(REF, { offline: false, unknown: true })
  assert.equal(health.isOffline(REF), true, '查不到余额 ≠ 余额够了')

  health.reset()
  health.markOffline(REF, 'account', '该渠道没有可用账号')
  apply(REF, { offline: false, unknown: true })
  assert.equal(health.isOffline(REF), false, '账号已恢复就该回来，跟余额读数无关')
})

check('审计规则：余额恢复后自动恢复，连续失败不被覆盖', () => {
  const { apply } = audit._internal
  health.reset()
  health.markOffline(REF, 'balance', '剩余额度为 0')
  apply(REF, { offline: false })
  assert.equal(health.isOffline(REF), false, '余额够了就该自动回来')

  health.reset()
  health.markOffline(REF, 'errors', '连续 3 次失败')
  apply(REF, { offline: false })
  assert.equal(health.isOffline(REF), true, '失败是真实证据，审计不能替它原谅')
  assert.equal(health.stateOf(REF).reason, 'errors')
})

check('prune 清掉配置里已不存在的引用', () => {
  health.reset()
  health.noteFailure('gone/provider/model', 'x')
  health.markOffline(REF, 'errors', 'x')
  health.prune([REF])
  assert.equal(health.stateOf('gone/provider/model').offline, false)
  assert.equal(health.stateOf('gone/provider/model').failures, 0, '引用没了就该整条删掉')
  assert.equal(health.isOffline(REF), true, '还在配置里的保留')
})

check('台账落盘后能重新读回', () => {
  health.reset()
  health.markOffline(REF, 'account', '该渠道没有可用账号')
  // reset 会清缓存；用「直接改缓存外的进程状态」没法模拟重启，改为断言文件内容
  const file = path.join(dataDir, 'model-health.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.models[REF].offline, true)
  assert.equal(saved.models[REF].reason, 'account')
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
