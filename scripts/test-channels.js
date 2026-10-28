// 渠道集成的离线回归：不联网、不需要真实账号
//
//     node scripts/test-channels.js
//
// 覆盖的是 AiRoute 这一侧：Provider 同步、模型引用、三条协议入口的转帧与记账。
// 渠道包本身（登录、换号、限流）由上游的测试覆盖，这里用假运行时替代 ——
// 真正需要验证的是「我们接上去的那一层」有没有把 chunk 转对、把错误码透对。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const qoderProtocol = require('../server/channels/plugins/qoder/protocol')

const root = path.join(__dirname, '..')
const dataDir = path.join(os.tmpdir(), 'airoute-channels-test')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
const port = 39000 + Math.floor(Math.random() * 900)

const rows = [{
  id: 'gemini/gemini-2.5-pro',
  name: 'Gemini 2.5 Pro',
  owned_by: 'gemini',
  context_window: 1000000,
  max_tokens: 65536,
  vision: true
}, {
  // 只用来验证「配置里有、运行时没有」时的报错路径
  id: 'gemini/missing',
  name: 'Missing',
  owned_by: 'gemini'
}]

// 假运行时：按渠道包的 chunk 形状回一段「思考 + 正文 + 工具调用 + 用量」
const fakeRuntime = {
  providers: ['gemini'],
  state: () => ({ state: 'ready', error: '' }),
  publicModelRows: () => rows,
  refresh: async () => rows,
  handles: model => model.startsWith('gemini/') && !model.includes('missing'),
  rpc: async body => ({ ok: true, value: { echo: body } }),
  complete: async (request, onChunk) => {
    // 上游目录里「可见但此刻调不通」的条目：测试接口应换下一个模型重试
    if (request.model === 'gemini/dead-model') {
      throw new Error('上游拒调（code=4001）')
    }
    assert.equal(request.model, 'gemini/gemini-2.5-pro')
    assert.ok(Array.isArray(request.openAi.messages), '请求应已收敛成 OpenAI Chat 形态')
    // 断流场景：先吐一段正文再失败，用来验证「已发 200 后不再换源」
    if (request.openAi.messages[0]?.content === 'boom') {
      onChunk({ type: 'text-delta', text: '半句' })
      throw Object.assign(new Error('上游断流'), { statusCode: 502 })
    }
    onChunk({ type: 'reasoning-delta', text: '想一下' })
    onChunk({ type: 'text-delta', text: '你好' })
    onChunk({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'lookup', argumentsDelta: '{"q":' })
    onChunk({ type: 'tool-call-delta', index: 0, argumentsDelta: '"x"}' })
    onChunk({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' } })
    onChunk({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 15 } })
    onChunk({ type: 'finish', reason: { kind: 'tool-calls' } })
  },
  close: async () => {}
}

// 在 require router 之前替换渠道模块：router 与测试拿到的是同一个模块实例
const channels = require(path.join(root, 'server', 'channels'))
channels.getRuntime = () => fakeRuntime
channels.init = () => Promise.resolve(fakeRuntime)
channels.rpc = async body => fakeRuntime.rpc(body)

fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({
  channels: {
    type: 'channel',
    displayName: '账号渠道（10 家）',
    models: [{ id: 'gemini/gemini-2.5-pro' }]
  }
}, null, 2))
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ current: 'channels/gemini/gemini-2.5-pro' }))

process.env.AIROUTE_DATA_DIR = dataDir
process.env.PORT = String(port)
require(path.join(root, 'server', 'router.js'))

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method,
      headers: payload === null
        ? {}
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await request('GET', '/api/health')
      if (res.status === 200) return
    } catch {
      /* 还没起 */
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('服务未在预期时间内启动')
}

function sseFrames(text) {
  return text.split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data: '))
    .map(block => block.slice(6))
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload))
}

const checks = []
function check(name, fn) {
  checks.push({ name, fn })
}

check('Qoder HTTP 排队错误可解析，并保留服务端等待时间', () => {
  const info = qoderProtocol.parseQueueInfo({
    code: '10605',
    message: JSON.stringify({ isQueued: true, modelKey: 'gfmodel', queueCount: 0, queueType: 'p3', retryAfterSeconds: 30, serviceAvailable: false, subCode: 'RESOURCE_LIMIT', waitTime: 30 })
  })
  assert.equal(info.isQueued, true)
  assert.equal(info.retryAfterSeconds, 30)
  assert.equal(info.subCode, 'RESOURCE_LIMIT')
  const transient = qoderProtocol.parseQueueInfo({ isQueued: false, serviceAvailable: true, waitTime: 0, retryAfterSeconds: 2 })
  assert.equal(transient.retryAfterSeconds, 2)
  assert.equal(qoderProtocol.parseQueueInfo({ code: '110', message: 'Billing daily count exceeded' }), undefined)
})

check('渠道运行时状态可读', async () => {
  const res = await request('GET', '/api/channels/status')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.text)
  assert.equal(body.state, 'ready')
  assert.deepEqual(body.providers, ['gemini'])
})

check('非流式：正文、思考、工具调用、用量都转对', async () => {
  const res = await request('POST', '/v1/chat/completions', {
    model: 'channels/gemini/gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(res.status, 200, res.text)
  const body = JSON.parse(res.text)
  const message = body.choices[0].message
  assert.equal(message.content, '你好')
  assert.equal(message.reasoning_content, '想一下')
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'lookup')
  // block-end 携带的是同一份参数，不能把参数拼两遍
  assert.equal(message.tool_calls[0].function.arguments, '{"q":"x"}')
  // OpenAI 口径：prompt = 未命中 10 + 缓存 2
  assert.equal(body.usage.prompt_tokens, 12)
  assert.equal(body.usage.completion_tokens, 5)
  // 上游报的总数（15）比「输入 + 输出」小，取较大者：少算会让客户端
  // 误判上下文占用（上游口径不一致时宁多勿少）
  assert.equal(body.usage.total_tokens, 17)
  assert.equal(body.usage.prompt_tokens_details.cached_tokens, 2)
})

check('流式：逐帧增量 + 收尾 [DONE]', async () => {
  const res = await request('POST', '/v1/chat/completions', {
    model: 'channels/gemini/gemini-2.5-pro',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true
  })
  assert.equal(res.status, 200, res.text)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'))
  const frames = sseFrames(res.text)
  const text = frames.map(frame => frame.choices?.[0]?.delta?.content || '').join('')
  assert.equal(text, '你好')
  const usageFrame = frames.find(frame => frame.usage)
  assert.equal(usageFrame.usage.prompt_tokens, 12)
  // 增量帧里的 arguments 只应是各段增量，不是整份参数
  const argDeltas = frames
    .flatMap(frame => frame.choices?.[0]?.delta?.tool_calls || [])
    .map(call => call.function.arguments)
    .join('')
  assert.equal(argDeltas, '{"q":"x"}')
})

check('Anthropic 客户端：请求转成 OpenAI、回程转回 message', async () => {
  const res = await request('POST', '/v1/messages', {
    model: 'channels/gemini/gemini-2.5-pro',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(res.status, 200, res.text)
  const body = JSON.parse(res.text)
  assert.equal(body.type, 'message')
  const text = body.content.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.equal(text, '你好')
  assert.equal(body.stop_reason, 'tool_use')
})

check('渠道 RPC 透传（登录/账号池的方法表不在本层重抄）', async () => {
  const res = await request('POST', '/api/channels/rpc', { method: 'account.list', payload: {} })
  assert.equal(res.status, 200, res.text)
  const body = JSON.parse(res.text)
  assert.equal(body.ok, true)
  assert.deepEqual(body.result.value.echo, { method: 'account.list', payload: {} })
})

check('Provider 连通性测试走渠道包', async () => {
  const res = await request('POST', '/api/providers/channels/test', {})
  assert.equal(res.status, 200, res.text)
  const body = JSON.parse(res.text)
  assert.equal(body.ok, true)
  assert.equal(body.model, 'gemini/gemini-2.5-pro')
})

// 上游目录与「此刻真的能调」并不同步：某个模型失败不代表这个源不通。
// 这里让第一个候选必然失败，验证测试接口会换下一个而不是直接下结论。
check('连通性测试：首个模型调不通时自动换下一个', async () => {
  const realRows = fakeRuntime.publicModelRows
  fakeRuntime.publicModelRows = () => [
    { id: 'gemini/dead-model', name: 'Dead', owned_by: 'gemini' },
    ...realRows()
  ]
  try {
    const res = await request('POST', '/api/channels/test', {})
    assert.equal(res.status, 200, res.text)
    const body = JSON.parse(res.text)
    assert.equal(body.ok, true, body.error)
    assert.equal(body.model, 'gemini/gemini-2.5-pro')
    assert.deepEqual(body.tried.map(item => item.model), ['gemini/dead-model'])
    assert.match(body.tried[0].error, /上游拒调/)
  } finally {
    fakeRuntime.publicModelRows = realRows
  }
})

// 「只测这个渠道」：候选必须收在那一家里，别把别家的模型也拖进来试
// （界面上每个渠道组各有一个「测试」按钮，走的就是 provider 这条路径）
check('按渠道测试：只在指定渠道的模型里挑候选', async () => {
  const realRows = fakeRuntime.publicModelRows
  fakeRuntime.publicModelRows = () => [
    { id: 'other/other-model', name: 'Other', owned_by: 'other' },
    ...realRows()
  ]
  try {
    const res = await request('POST', '/api/channels/test', { provider: 'gemini' })
    assert.equal(res.status, 200, res.text)
    const body = JSON.parse(res.text)
    assert.equal(body.ok, true, body.error)
    assert.equal(body.model, 'gemini/gemini-2.5-pro')
    // tried 为空 = 没有试过别家的模型；有内容说明 provider 过滤漏了
    assert.deepEqual(body.tried, [])

    const missing = await request('POST', '/api/channels/test', { provider: 'no-such' })
    assert.equal(missing.status, 400, missing.text)
    assert.match(JSON.parse(missing.text).error, /渠道 no-such 还没有可用模型/)
  } finally {
    fakeRuntime.publicModelRows = realRows
  }
})

check('运行时没有的模型：透出 404，而不是 500', async () => {
  // AiRoute 按「当前模型」路由，请求体里的 model 不参与选源
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ current: 'channels/gemini/missing' }))
  const res = await request('POST', '/v1/chat/completions', {
    model: 'channels/gemini/missing',
    messages: [{ role: 'user', content: 'hi' }]
  })
  assert.equal(res.status, 404, res.text)
  assert.match(res.text, /渠道未提供模型/)
})

check('流式断流：补错误帧 + [DONE]，不换源也不崩', async () => {
  // 上一项把当前模型改成了 missing，这里先切回可用模型
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ current: 'channels/gemini/gemini-2.5-pro' }))
  const res = await request('POST', '/v1/chat/completions', {
    model: 'channels/gemini/gemini-2.5-pro',
    messages: [{ role: 'user', content: 'boom' }],
    stream: true
  })
  // 已经发出 200：客户端能看到的收尾必须是错误帧，而不是一个「看起来正常结束」的流
  assert.equal(res.status, 200, res.text)
  assert.match(res.text, /半句/)
  assert.match(res.text, /data: \{"error"/)
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'), res.text.slice(-80))
})

async function main() {
  await waitForServer()
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
  // 数据目录不在这里删：token-stats 的定时落盘仍在跑，删掉目录会让退出前
  // 冒一条 ENOENT（与本次验证无关的噪声）。下次运行开头会清掉它。
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
