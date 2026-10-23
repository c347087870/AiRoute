// 「这次失败算谁的」离线回归：不联网、不起服务。
//
//     node scripts/test-failure-class.js
//
// 守的是这条链：一次真实调用失败了 → 该不该计入模型的连续失败 → 连续 3 次就失活。
// 这里的规则错一位，坏模型就永远进不了失活，而它的症状是「卡住不返回」——
// 用户看到的是每个新会话都先假死一轮，且只在高延迟 + 客户端断开时复现。
//
// 真实链路（/v1/models 不再播报、建链跳过）在 scripts/smoke-e2e.js 里验证。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const dataDir = path.join(os.tmpdir(), 'airoute-failure-class-test')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
// paths 在调用时读环境变量，赶在第一次读写台账之前设好
process.env.AIROUTE_DATA_DIR = dataDir

const cls = require(path.join(root, 'server/failure-class.js'))
const health = require(path.join(root, 'server/model-health.js'))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const REF = 'channels/qoder/gfmodel'

check('用户取消：axios 的 CanceledError 文案', () => {
  assert.equal(cls.isAbortFailure({ status: 500, error: 'canceled' }), true)
  assert.equal(cls.isAbortFailure({ status: 500, error: '请求已取消' }), true)
})

check('用户取消：499 与显式 clientCancelled 标记', () => {
  assert.equal(cls.isAbortFailure({ status: 499, error: '客户端已断开' }), true)
  assert.equal(cls.isAbortFailure({ status: 502, error: '随便什么', clientCancelled: true }), true)
})

check('回归点：AbortError 文案本身不再等于「用户取消」', () => {
  // undici / 我们自己的 abort() 抛的是这一句；它既可能来自用户点停止，
  // 也可能来自上游卡到超时。旧实现在这里判成取消，坏模型因此永远不失活
  assert.equal(cls.isAbortFailure({ status: 502, error: 'This operation was aborted' }), false)
  assert.equal(cls.isAbortFailure({ status: 502, error: 'This operation was aborted', code: 20 }), false)
})

check('上游真报错：不是取消', () => {
  assert.equal(cls.isAbortFailure({ status: 502, error: 'Upstream returned 502' }), false)
  assert.equal(cls.isAbortFailure({ status: 504, error: 'sse first-token timeout after 120000ms' }), false)
})

check('首帧看门狗掐的：504 + stall + 文案带秒数', () => {
  const v = cls.classifyChannelFailure({ stalled: true, timeoutMs: 60000, error: new Error('This operation was aborted') })
  assert.equal(v.status, 504)
  assert.equal(v.kind, 'stall')
  assert.match(v.message, /60 秒内没有返回任何内容/)
  assert.equal(v.clientCancelled, undefined)
})

check('客户端在等待期内断开：499，不计失败', () => {
  const v = cls.classifyChannelFailure({ clientClosed: true, elapsedMs: 3000, timeoutMs: 60000, error: new Error('This operation was aborted') })
  assert.equal(v.status, 499)
  assert.equal(v.clientCancelled, true)
  assert.equal(cls.isAbortFailure({ status: v.status, clientCancelled: v.clientCancelled }), true)
})

check('等过首帧上限才被客户端放弃：仍算卡住（504，计入失败）', () => {
  const v = cls.classifyChannelFailure({ clientClosed: true, elapsedMs: 120000, timeoutMs: 60000, error: new Error('This operation was aborted') })
  assert.equal(v.status, 504)
  assert.equal(v.kind, 'stall')
  assert.equal(cls.isAbortFailure({ status: v.status }), false)
})

check('普通上游错误沿用状态码；没有状态码落 502', () => {
  assert.equal(cls.classifyChannelFailure({ error: Object.assign(new Error('模型不存在'), { statusCode: 404 }) }).status, 404)
  assert.equal(cls.classifyChannelFailure({ error: Object.assign(new Error('池中无号'), { status: 503 }) }).status, 503)
  assert.equal(cls.classifyChannelFailure({ error: new Error('未知原因') }).status, 502)
})

check('已经写过帧：只给日志状态码，不换源', () => {
  assert.equal(cls.classifyChannelFailure({ started: true }).status, 502)
})

check('首帧上限可被环境变量覆盖，非法值回落到默认', () => {
  assert.equal(cls.resolveFirstChunkTimeoutMs({}), 60000)
  assert.equal(cls.resolveFirstChunkTimeoutMs({ AIROUTE_CHANNEL_FIRST_CHUNK_TIMEOUT_MS: '30000' }), 30000)
  assert.equal(cls.resolveFirstChunkTimeoutMs({ AIROUTE_CHANNEL_FIRST_CHUNK_TIMEOUT_MS: 'abc' }), 60000)
  assert.equal(cls.resolveFirstChunkTimeoutMs({ AIROUTE_CHANNEL_FIRST_CHUNK_TIMEOUT_MS: '0' }), 60000)
})

check('串起来：卡死 3 次 → 模型失活（这条链断过，才会「每次都先撞同一个坏模型」）', () => {
  health.reset()
  const verdict = cls.classifyChannelFailure({ stalled: true, timeoutMs: 60000, error: new Error('This operation was aborted') })
  const entry = { status: verdict.status, error: verdict.message }
  assert.equal(cls.isAbortFailure(entry), false, '卡死必须计入失败')
  for (let i = 0; i < 3; i += 1) {
    if (!cls.isAbortFailure(entry)) health.noteFailure(REF, entry.error)
  }
  assert.equal(health.isOffline(REF), true)
  assert.equal(health.stateOf(REF).reason, 'errors')
})

check('串起来：用户取消 3 次不会把模型弄失活', () => {
  health.reset()
  const verdict = cls.classifyChannelFailure({ clientClosed: true, elapsedMs: 2000, timeoutMs: 60000 })
  const entry = { status: verdict.status, clientCancelled: verdict.clientCancelled }
  for (let i = 0; i < 3; i += 1) {
    if (!cls.isAbortFailure(entry)) health.noteFailure(REF, 'aborted')
  }
  assert.equal(health.isOffline(REF), false)
  assert.equal(health.stateOf(REF).failures, 0)
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
