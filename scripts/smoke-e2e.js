// AiRoute 端到端冒烟测试（离线，不依赖任何真实上游）
// 运行：node scripts/smoke-e2e.js
//
// 做什么：
//   1. 起一个本地 mock 上游（同时实现 Anthropic /v1/messages 与 OpenAI /chat/completions）
//   2. 用临时数据目录起真实网关 server/router.js（独立端口）
//   3. 逐个打全部对外接口与三条协议链路（流式 + 非流式），断言响应正确
//   4. 校验日志 / Token 统计 / 路由规则 / Fallback / Provider CRUD 等落盘副作用
// 覆盖范围：router.js 全量 HTTP 路由 + upstream.js 协议封装 + logger + token-stats
// （WorkBuddy 账号池链路由 scripts/test-workbuddy.js 离线覆盖）

const assert = require('assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.join(__dirname, '..')

let passed = 0
let failed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, err })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${err.message}`)
  }
}

function group(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ---------- mock 上游 ----------

function startMockUpstream() {
  const requests = [] // 记录收到的请求，供断言
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => {
      raw += c
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* ignore */
      }
      requests.push({ url: req.url, headers: req.headers, body })

      // 确定性失败路径（用于验证 Fallback）：/fail 一律 500
      if (req.url.includes('/fail')) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'mock upstream internal error' } }))
        return
      }

      // Anthropic token 计数
      if (req.url.includes('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 42 }))
        return
      }

      const isAnthropic = req.url.includes('/v1/messages')
      const stream = !!body.stream

      if (isAnthropic) {
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }
            })}\n\n`
          )
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } })}\n\n`
          )
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } })}\n\n`
          )
          res.write(
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })}\n\n`
          )
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: '你好，世界' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }
          })
        )
        return
      }

      // OpenAI chat/completions
      if (stream) {
        // 并发用例（并发优先策略）需要一个「还没结束」的上游：请求体里带 hold
        // 就先压 600ms 不写任何字节，好让第二个请求在它仍挂着时到达网关
        const holdMs = /hold/.test(JSON.stringify(body.messages || [])) ? 600 : 0
        const emit = () => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(
            `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '，世界' }, finish_reason: null }] })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`
          )
          res.write('data: [DONE]\n\n')
          res.end()
        }
        if (holdMs) setTimeout(emit, holdMs)
        else emit()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '你好，世界' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_tokens_details: { cached_tokens: 5 } }
        })
      )
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }))
  })
}

// ---------- 网关进程 ----------

function startGateway(dataDir, port, extraEnv = {}) {
  // 清除代理环境变量：真实部署（Electron 应用）不依赖它们，
  // 且代理会让「不可达上游」的判定不稳定，影响 fallback 等用例
  const env = { ...process.env, AIROUTE_DATA_DIR: dataDir, PORT: String(port), ...extraEnv }
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    delete env[k]
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'router.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', d => {
    out += d.toString()
  })
  child.stderr.on('data', d => {
    out += d.toString()
  })
  return { child, getOutput: () => out }
}

async function waitHealth(port, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetchJson(`http://127.0.0.1:${port}/api/health`)
      if (r.status === 200) return true
    } catch {
      /* not up yet */
    }
    await sleep(150)
  }
  return false
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-json */
  }
  return { status: res.status, text, json, headers: res.headers }
}

async function readSse(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, text, headers: res.headers }
}

// ---------- 主流程 ----------

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airoute-e2e-'))
  const mock = await startMockUpstream()
  const gwPort = 39000 + Math.floor(Math.random() * 1000)
  const mockBase = `http://127.0.0.1:${mock.port}`

  // 临时配置：一个通用 Provider 指向 mock 上游
  fs.writeFileSync(
    path.join(tmpDir, 'models.json'),
    JSON.stringify(
      {
        'mock-provider': {
          displayName: 'Mock Provider',
          baseURL: `${mockBase}/anthropic`,
          openaiURL: `${mockBase}/v1`,
          apiKey: 'sk-test',
          models: [
            { id: 'mock-large', displayName: '大杯', maxContext: 128000, maxOutput: 4096 },
            { id: 'mock-small', displayName: '小杯' }
          ]
        },
        'no-key-provider': {
          displayName: '无 Key',
          baseURL: `${mockBase}/anthropic`,
          models: [{ id: 'nk' }]
        },
        // 确定性失败源：mock 的 /fail 路径一律 500，用于验证 Fallback
        'fail-provider': {
          displayName: '失败源',
          baseURL: `${mockBase}/fail-anthropic`,
          openaiURL: `${mockBase}/fail-v1`,
          apiKey: 'sk-test',
          models: [{ id: 'dead' }]
        }
      },
      null,
      2
    )
  )
  fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify({ current: 'mock-provider/mock-large' }))
  fs.writeFileSync(path.join(tmpDir, 'rules.json'), JSON.stringify({ rules: [], customRules: [] }))
  fs.writeFileSync(path.join(tmpDir, 'fallback.json'), JSON.stringify({ model: '' }))
  fs.writeFileSync(path.join(tmpDir, 'server-config.json'), JSON.stringify({ port: gwPort }))

  const gw = startGateway(tmpDir, gwPort)
  const base = `http://127.0.0.1:${gwPort}`

  try {
    const up = await waitHealth(gwPort)
    assert.ok(up, `网关未能启动。输出：\n${gw.getOutput().slice(-2000)}`)

    // ==================== 基础 API ====================
    group('1. 基础 API 与配置读取')

    await check('GET /api/health 返回 ok', async () => {
      const r = await fetchJson(`${base}/api/health`)
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.status, 'ok')
      assert.strictEqual(r.json.port, gwPort)
    })

    await check('GET /api/state 返回当前模型', async () => {
      const r = await fetchJson(`${base}/api/state`)
      assert.strictEqual(r.json.current, 'mock-provider/mock-large')
    })

    await check('GET /api/providers 脱敏 apiKey', async () => {
      const r = await fetchJson(`${base}/api/providers`)
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json['mock-provider'].apiKey, '••••••••')
      assert.strictEqual(r.json['mock-provider'].models.length, 2)
    })

    await check('GET /api/providers/:name/full 返回明文 Key', async () => {
      const r = await fetchJson(`${base}/api/providers/mock-provider/full`)
      assert.strictEqual(r.json.apiKey, 'sk-test')
    })

    await check('GET /api/providers/:name/full 不存在 → 404', async () => {
      const r = await fetchJson(`${base}/api/providers/nope/full`)
      assert.strictEqual(r.status, 404)
    })

    await check('GET /api/rules 返回空规则', async () => {
      const r = await fetchJson(`${base}/api/rules`)
      assert.deepStrictEqual(r.json, { rules: [], customRules: [] })
    })

    await check('GET /api/fallback', async () => {
      const r = await fetchJson(`${base}/api/fallback`)
      assert.strictEqual(r.json.model, '')
    })

    await check('GET /api/server-config 附带 localIPs 数组', async () => {
      const r = await fetchJson(`${base}/api/server-config`)
      assert.ok(Array.isArray(r.json.localIPs))
      assert.strictEqual(r.json.port, gwPort)
    })

    await check('GET /api/system/status 版本、线路与端口', async () => {
      const r = await fetchJson(`${base}/api/system/status`)
      assert.strictEqual(r.json.port, gwPort)
      assert.ok(typeof r.json.version === 'string' && r.json.version.length > 0)
      // 更新线路：beta 构建走 beta 线，其余走正式线（与 server/update.js 的 releaseLine 同规则）
      assert.ok(['beta', 'stable'].includes(r.json.line), `line 应为 beta 或 stable，实际 ${r.json.line}`)
      const expectBeta = /-(alpha|beta|rc|next|dev)([.\-]|$)/i.test(r.json.version)
      assert.strictEqual(r.json.line, expectBeta ? 'beta' : 'stable', '线路判定应与版本号一致')
    })

    await check('GET /api/benchmark/questions 返回题库', async () => {
      const r = await fetchJson(`${base}/api/benchmark/questions`)
      assert.ok(r.status === 200)
      assert.ok(r.json && Array.isArray(r.json.questions) && r.json.questions.length > 0)
    })

    await check('GET /api/token-stats 结构完整', async () => {
      const r = await fetchJson(`${base}/api/token-stats`)
      assert.ok(r.json.byDay && r.json.byMonth && r.json.byHour && r.json.byModel)
    })

    await check('GET /api/token-stats/period/:days 越界 → 400', async () => {
      const r = await fetchJson(`${base}/api/token-stats/period/99`)
      assert.strictEqual(r.status, 400)
    })

    // 状态面板的四个时间维度：字段齐备，且当月口径不能小于当日
    // （月维度走月汇总桶，当日走按日桶，两者独立存储，写错一侧就会在这里露出来）
    await check('GET /api/token-stats/range 四档齐备且口径自洽', async () => {
      const r = await fetchJson(`${base}/api/token-stats/range`)
      assert.strictEqual(r.status, 200)
      for (const key of ['day', 'month', 'quarter', 'year']) {
        const s = r.json[key]
        assert.ok(s && typeof s === 'object', `${key} 必须存在`)
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'count', 'failed']) {
          assert.strictEqual(typeof s[field], 'number', `${key}.${field} 必须是数字`)
        }
      }
      const req = s => s.count + s.failed
      assert.ok(req(r.json.month) >= req(r.json.day), '本月请求数不应少于当日')
      assert.ok(req(r.json.quarter) >= req(r.json.month), '近三月请求数不应少于本月')
      assert.ok(req(r.json.year) >= req(r.json.quarter), '本年请求数不应少于近三月')
      assert.ok(r.json.year.total >= r.json.month.total, '本年 Token 不应少于本月')
    })

    await check('GET /api/token-stats/hourly/:date 非法日期 → 400', async () => {
      const r = await fetchJson(`${base}/api/token-stats/hourly/2026-1-1`)
      assert.strictEqual(r.status, 400)
    })

    await check('GET /v1/models 返回配置模型 + 别名', async () => {
      const r = await fetchJson(`${base}/v1/models`)
      const ids = r.json.data.map(m => m.id)
      assert.ok(ids.includes('mock-large'))
      assert.ok(ids.includes('claude-opus-4-20250514'))
    })

    await check('GET /v1/models 只暴露 auto 伪模型', async () => {
      const r = await fetchJson(`${base}/v1/models`)
      const ids = r.json.data.map(m => m.id)
      assert.ok(ids.includes('auto'))
      // 策略改在「渠道-模型」页统一选，模型列表里不该再有另外三档
      for (const id of ['auto-fast', 'auto-cheap', 'auto-least-conn']) {
        assert.ok(!ids.includes(id), `${id} 不该再出现在 /v1/models`)
      }
    })

    await check('Auto 策略：可读可改，非法值 400', async () => {
      const r = await fetchJson(`${base}/api/auto-strategy`)
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.strategy, 'balanced')
      assert.deepStrictEqual(r.json.strategies.map(item => item.id), ['balanced', 'latency', 'cost', 'connections'])

      const bad = await fetchJson(`${base}/api/auto-strategy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: '不存在的档' })
      })
      assert.strictEqual(bad.status, 400)

      const ok = await fetchJson(`${base}/api/auto-strategy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'connections' })
      })
      assert.strictEqual(ok.status, 200)
      assert.strictEqual(ok.json.strategy, 'connections')

      // 复位
      await fetchJson(`${base}/api/auto-strategy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'balanced' })
      })
    })

    // ==================== 配置写入校验 ====================
    group('2. 配置写入与入参校验')

    await check('POST /api/state 非法引用 → 400（不落盘）', async () => {
      const r = await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'ghost/model' })
      })
      assert.strictEqual(r.status, 400)
      const cur = await fetchJson(`${base}/api/state`)
      assert.strictEqual(cur.json.current, 'mock-provider/mock-large')
    })

    await check('POST /api/state 合法引用 → 切换生效', async () => {
      const r = await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'mock-provider/mock-small' })
      })
      assert.strictEqual(r.status, 200)
      const cur = await fetchJson(`${base}/api/state`)
      assert.strictEqual(cur.json.current, 'mock-provider/mock-small')
      // 切回大杯，后续链路断言用
      await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'mock-provider/mock-large' })
      })
    })

    await check('PUT /api/rules 目标模型不存在 → 400', async () => {
      const r = await fetchJson(`${base}/api/rules`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: [{ condition: 'contains_code', target: 'ghost/x' }], customRules: [] })
      })
      assert.strictEqual(r.status, 400)
    })

    await check('PUT /api/rules 合法规则 → 保存并可回读', async () => {
      const r = await fetchJson(`${base}/api/rules`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rules: [{ condition: 'contains_code', target: 'mock-provider/mock-small' }],
          customRules: [{ keyword: '123', target: 'mock-provider/mock-small' }]
        })
      })
      assert.strictEqual(r.status, 200)
      const back = await fetchJson(`${base}/api/rules`)
      assert.strictEqual(back.json.rules.length, 1)
      assert.strictEqual(back.json.customRules[0].keyword, '123')
    })

    await check('PUT /api/server-config 非法端口 → 400', async () => {
      const r = await fetchJson(`${base}/api/server-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: 99999 })
      })
      assert.strictEqual(r.status, 400)
    })

    await check('POST /api/providers/:name 重名 → 409', async () => {
      const r = await fetchJson(`${base}/api/providers/mock-provider`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'dup', baseURL: mockBase, apiKey: 'x' })
      })
      assert.strictEqual(r.status, 409)
    })

    await check('POST /api/providers 新建 → 可读回', async () => {
      const r = await fetchJson(`${base}/api/providers/newprov`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: '新源', baseURL: mockBase, apiKey: 'k', models: [{ id: 'm1' }] })
      })
      assert.strictEqual(r.status, 200)
      const back = await fetchJson(`${base}/api/providers/newprov/full`)
      assert.strictEqual(back.json.displayName, '新源')
      assert.strictEqual(back.json.models[0].id, 'm1')
    })

    await check('POST /api/providers 名称含斜杠 → 400', async () => {
      const r = await fetchJson(`${base}/api/providers/bad%2Fname`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x', baseURL: mockBase, apiKey: 'k' })
      })
      assert.ok(r.status === 400 || r.status === 404)
    })

    await check('DELETE /api/providers/:name 清理指向它的引用', async () => {
      // newprov 无引用，先给 fallback 指向它再删
      await fetchJson(`${base}/api/fallback`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'newprov/m1' })
      })
      const r = await fetchJson(`${base}/api/providers/newprov`, { method: 'DELETE' })
      assert.strictEqual(r.status, 200)
      const fb = await fetchJson(`${base}/api/fallback`)
      assert.strictEqual(fb.json.model, '')
    })

    // ==================== 协议链路 ====================
    group('3. 三条协议链路（非流式）')

    await check('POST /v1/chat/completions 非流式 → 原样返回 OpenAI 响应', async () => {
      const r = await fetchJson(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'whatever', messages: [{ role: 'user', content: 'hi' }] })
      })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.choices[0].message.content, '你好，世界')
      assert.strictEqual(r.json.usage.prompt_tokens, 20)
    })

    await check('POST /v1/messages 非流式 → 返回 Anthropic 响应', async () => {
      const r = await fetchJson(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'whatever', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
      })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.content[0].text, '你好，世界')
      assert.strictEqual(r.json.usage.input_tokens, 11)
    })

    await check('POST /v1/responses 非流式 → 转换为 Responses 形态', async () => {
      const r = await fetchJson(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'whatever', input: 'hi' })
      })
      assert.strictEqual(r.status, 200)
      // Responses 对象：object=response，含 output 数组
      assert.strictEqual(r.json.object, 'response')
      assert.ok(Array.isArray(r.json.output))
    })

    await check('POST /v1/messages/count_tokens → 通用 Provider 转发计数', async () => {
      const r = await fetchJson(`${base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'whatever', messages: [{ role: 'user', content: 'hi' }] })
      })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.input_tokens, 42)
    })

    group('4. 三条协议链路（流式）')

    await check('POST /v1/chat/completions stream → SSE 帧 + [DONE]', async () => {
      const r = await readSse(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] })
      })
      assert.strictEqual(r.status, 200)
      assert.ok(r.text.includes('你好'))
      assert.ok(r.text.includes('[DONE]'))
    })

    await check('POST /v1/messages stream → 原样透传 Anthropic SSE', async () => {
      const r = await readSse(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] })
      })
      assert.strictEqual(r.status, 200)
      assert.ok(r.text.includes('message_start'))
      assert.ok(r.text.includes('content_block_delta'))
    })

    await check('POST /v1/responses stream → 转换为 Responses 事件流', async () => {
      const r = await readSse(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', stream: true, input: 'hi' })
      })
      assert.strictEqual(r.status, 200)
      // Responses 事件流用 event: 行
      assert.ok(r.text.includes('response.'), `响应体：${r.text.slice(0, 300)}`)
    })

    // ==================== 上游收到的请求体 ====================
    group('5. 转发请求体正确性')

    await check('非流式 OpenAI：注入 model / 关闭 stream', async () => {
      await fetchJson(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'probe-nonstream' }] })
      })
      const last = mock.requests.filter(q => q.url.includes('/chat/completions')).pop()
      assert.strictEqual(last.body.model, 'mock-large', 'model 应被替换为当前选中模型')
      assert.strictEqual(last.body.stream, false)
    })

    await check('Anthropic 转发：system 消息被提取到顶层 system 字段', async () => {
      const r = await fetchJson(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'x',
          max_tokens: 50,
          messages: [
            { role: 'system', content: '你是助手' },
            { role: 'user', content: 'hi' }
          ]
        })
      })
      assert.strictEqual(r.status, 200)
      const last = mock.requests.filter(q => q.url.includes('/v1/messages')).pop()
      assert.ok(Array.isArray(last.body.system), 'system 应提升为数组')
      assert.strictEqual(last.body.system[0].text, '你是助手')
      assert.strictEqual(last.body.messages.length, 1, 'messages 里不应残留 system')
    })

    await check('OpenAI 流式：请求体自动带 stream_options.include_usage', async () => {
      await readSse(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', stream: true, messages: [{ role: 'user', content: 'hi' }] })
      })
      const last = mock.requests.filter(q => q.url.includes('/chat/completions')).pop()
      assert.strictEqual(last.body.stream, true)
      assert.strictEqual(last.body.stream_options.include_usage, true)
    })

    // ==================== Fallback ====================
    group('6. Fallback 故障自愈')

    await check('主模型失败 → 自动降级到备用模型且客户端无感', async () => {
      const setState = async ref => {
        const r = await fetchJson(`${base}/api/state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current: ref })
        })
        assert.strictEqual(r.status, 200, `切换当前模型失败：${ref} → ${r.text}`)
      }
      try {
        // 主模型指向确定性失败源，备用指向 mock
        await setState('fail-provider/dead')
        await fetchJson(`${base}/api/fallback`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'mock-provider/mock-large' })
        })

        const r = await fetchJson(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'fallback-probe' }] })
        })
        assert.strictEqual(r.status, 200, '应降级成功')
        assert.strictEqual(r.json.choices[0].message.content, '你好，世界')

        const logs = await fetchJson(`${base}/api/logs?status=degraded&limit=100`)
        assert.ok(logs.json.some(e => e.fallback), `降级事件应写入日志，实际：${JSON.stringify(logs.json.slice(0, 3))}`)
      } finally {
        await fetchJson(`${base}/api/fallback`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: '' })
        })
        await setState('mock-provider/mock-large')
      }
    })

    // ==================== 模型失活 ====================
    group('6.5 模型失活（连续失败 → 下线 → 手动恢复）')

    await check('连续 3 次失败 → 模型失活、不再出现在 /v1/models、恢复后回来', async () => {
      const setState = ref => fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: ref })
      })
      try {
        await setState('fail-provider/dead')
        // 前面 Fallback 用例可能已经消耗掉 1 次失败，这里多打几次保证越过阈值
        for (let i = 0; i < 3; i += 1) {
          await fetchJson(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: `health-probe-${i}` }] })
          })
        }

        const ledger = await fetchJson(`${base}/api/model-health`)
        assert.strictEqual(ledger.status, 200)
        const record = ledger.json.models.find(item => item.ref === 'fail-provider/dead')
        assert.ok(record, `台账里应有 fail-provider/dead，实际：${JSON.stringify(ledger.json.models)}`)
        assert.strictEqual(record.offline, true)
        assert.strictEqual(record.reason, 'errors')

        const listed = await fetchJson(`${base}/v1/models`)
        assert.ok(!listed.json.data.some(item => item.id === 'dead'), '失活模型不该再被播报')

        const blocked = await fetchJson(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'after-offline' }] })
        })
        assert.strictEqual(blocked.status, 500)
        assert.match(blocked.json.error, /失活/, '错误文案要说清是失活，而不是「没配置」')

        const revived = await fetchJson(`${base}/api/model-health/revive`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref: 'fail-provider/dead' })
        })
        assert.strictEqual(revived.status, 200)
        const listedAgain = await fetchJson(`${base}/v1/models`)
        assert.ok(listedAgain.json.data.some(item => item.id === 'dead'), '恢复后应重新播报')
      } finally {
        await setState('mock-provider/mock-large')
      }
    })

    // ==================== 账号禁用台账 ====================

    await check('账号停用原因台账可读（无渠道账号时为空数组，不报错）', async () => {
      const resp = await fetchJson(`${base}/api/account-health`)
      assert.strictEqual(resp.status, 200)
      assert.deepStrictEqual(resp.json, { ok: true, accounts: [] })
    })

    // ==================== 智能路由 ====================
    group('7. 智能路由（auto）')

    await check('auto + 自定义关键词命中 → 路由到目标模型', async () => {
      await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'auto' })
      })
      const r = await fetchJson(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: '请处理 123 号工单' }] })
      })
      assert.strictEqual(r.status, 200)
      const last = mock.requests.filter(q => q.url.includes('/chat/completions')).pop()
      assert.strictEqual(last.body.model, 'mock-small', '自定义规则 123 → mock-small')

      // 复位
      await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'mock-provider/mock-large' })
      })
    })

    await check('并发优先策略：并发的两个请求摊到不同模型上', async () => {
      // 策略是全局一档：先把「并发优先」选上，再用 auto 这个模型名发请求
      await fetchJson(`${base}/api/auto-strategy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'connections' })
      })
      const before = mock.requests.filter(q => q.url.includes('/chat/completions')).length
      const call = () => fetchJson(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'hold 并发' }],
          stream: true
        })
      })
      // 两个请求同时发出：第一个还挂着（mock 压 600ms 不吐字节）时第二个才建链，
      // 这时它必须看见「第一个已占用」而换一个模型
      const [first, second] = await Promise.all([call(), call()])
      assert.strictEqual(first.status, 200, first.text.slice(0, 200))
      assert.strictEqual(second.status, 200, second.text.slice(0, 200))
      const landed = mock.requests
        .filter(q => q.url.includes('/chat/completions'))
        .slice(before)
        .map(q => q.body.model)
      assert.strictEqual(landed.length, 2, `应有两次上游请求：${landed}`)
      assert.notStrictEqual(landed[0], landed[1], `并发的两条请求应落到不同模型：${landed}`)

      // 复位
      await fetchJson(`${base}/api/auto-strategy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'balanced' })
      })
    })

    // ==================== 无可用 Provider ====================
    group('8. 边界与错误处理')
    await check('缺少 API Key 的 Provider → 500 且日志记录', async () => {
      const sw = await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'no-key-provider/nk' })
      })
      assert.strictEqual(sw.status, 200, `切换失败：${sw.text}`)
      try {
        const r = await fetchJson(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'no-key-probe' }] })
        })
        assert.strictEqual(r.status, 500)
        assert.ok(String(r.json.detail || '').includes('API Key'))
      } finally {
        await fetchJson(`${base}/api/state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current: 'mock-provider/mock-large' })
        })
      }
    })

    await check('Anthropic 客户端失败 → 返回 Anthropic 错误信封', async () => {
      const sw = await fetchJson(`${base}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'no-key-provider/nk' })
      })
      assert.strictEqual(sw.status, 200)
      try {
        const r = await fetchJson(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'no-key-probe-2' }] })
        })
        assert.strictEqual(r.status, 500)
        assert.strictEqual(r.json.type, 'error')
        assert.ok(r.json.error && typeof r.json.error.message === 'string')
      } finally {
        await fetchJson(`${base}/api/state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current: 'mock-provider/mock-large' })
        })
      }
    })

    // ==================== 统计与日志 ====================
    group('9. 日志与 Token 统计')

    await check('GET /api/logs 有记录且含模型名', async () => {
      const r = await fetchJson(`${base}/api/logs?limit=100`)
      assert.ok(Array.isArray(r.json) && r.json.length > 0)
      assert.ok(r.json.some(e => String(e.model || '').includes('mock-provider/')))
    })

    await check('GET /api/logs/models 含 mock-provider/mock-large', async () => {
      const r = await fetchJson(`${base}/api/logs/models`)
      assert.ok(r.json.includes('mock-provider/mock-large'))
    })

    await check('GET /api/logs/size 返回字节数与文件数', async () => {
      const r = await fetchJson(`${base}/api/logs/size`)
      assert.ok(r.json.totalSize > 0 && r.json.fileCount > 0)
    })

    await check('Token 统计已累加（byModel 命中 mock-provider/mock-large）', async () => {
      const r = await fetchJson(`${base}/api/token-stats`)
      const m = r.json.byModel['mock-provider/mock-large']
      assert.ok(m, '应按模型累计')
      assert.ok(m.total > 0, 'total 应大于 0')
    })

    await check('GET /api/stats 请求数与失败数同源', async () => {
      const r = await fetchJson(`${base}/api/stats`)
      assert.ok(r.json.totalRequests > 0)
      assert.ok(r.json.totalFailed >= 1, '前面制造过失败请求')
      assert.strictEqual(typeof r.json.retentionDays, 'number')
    })

    await check('GET /api/logs 状态筛选 failed 只返回失败', async () => {
      const r = await fetchJson(`${base}/api/logs?status=failed&limit=50`)
      assert.ok(r.json.every(e => e.status !== 200))
    })

    // ==================== 开发面板（只在开发模式回数据） ====================
    //
    // 面板本身是渲染层的事，这里守的是**服务端的开关**：开发模式下可用、
    // 打包版（NODE_ENV=production）里这个端点必须 404。开关写反了，
    // 用户的正式版就会多一个回显绝对路径与环境变量的接口。
    group('9.5 开发面板接口（仅开发模式）')

    await check('GET /api/dev/info 开发模式返回进程与运行时快照', async () => {
      const r = await fetchJson(`${base}/api/dev/info`)
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.ok, true)
      assert.strictEqual(r.json.devMode, true)
      // 面板靠这几项说明「现在跑的是什么」，字段名变了界面就会静默空着
      assert.strictEqual(typeof r.json.server.version, 'string')
      assert.strictEqual(typeof r.json.process.pid, 'number')
      assert.strictEqual(typeof r.json.process.node, 'string')
      assert.ok(r.json.process.memory && r.json.process.memory.rss > 0)
      assert.strictEqual(typeof r.json.dataDir, 'string')
      assert.ok(r.json.dataDir.includes('airoute-e2e-'), '回的是本次临时数据目录')
      assert.ok(Array.isArray(r.json.files))
      assert.ok(r.json.files.some(f => f.name === 'models.json'), '数据目录里的运行时文件要列出来')
      assert.ok(Array.isArray(r.json.inFlight))
      assert.strictEqual(typeof r.json.channels.state, 'string')
      assert.ok(Array.isArray(r.json.channels.providers))
      assert.ok(r.json.modelHealth && r.json.modelHealth.offlineAfterFailures === 3)
      assert.strictEqual(typeof r.json.logs.totalSize, 'number')
      assert.strictEqual(typeof r.json.tokens.todayRequests, 'number')
    })

    await check('GET /api/dev/info 只回显本项目环境变量（不回 PATH 等）', async () => {
      const r = await fetchJson(`${base}/api/dev/info`)
      const env = r.json.process.env || {}
      assert.ok(!('PATH' in env), '整份环境变量里可能有与本项目无关的密钥')
      assert.ok(!('HOME' in env))
      assert.strictEqual(env.AIROUTE_DATA_DIR, tmpDir)
    })

    await check('NODE_ENV=production 时 /api/dev/info → 404（正式版拿不到）', async () => {
      // 另起一个进程而不是改现有网关的 NODE_ENV：开关是在 require 时读的，
      // 只能靠新进程验证「打包版到底注册没注册」
      const prodPort = gwPort + 1000
      const prod = startGateway(tmpDir, prodPort, { NODE_ENV: 'production' })
      try {
        assert.ok(await waitHealth(prodPort), `正式模式网关未启动。输出：\n${prod.getOutput().slice(-1500)}`)
        const r = await fetchJson(`http://127.0.0.1:${prodPort}/api/dev/info`)
        assert.strictEqual(r.status, 404)
        assert.match(r.json.error, /开发模式/)
        // 别的端点不受影响：只关了开发面板这一个
        const health = await fetchJson(`http://127.0.0.1:${prodPort}/api/health`)
        assert.strictEqual(health.status, 200)
      } finally {
        prod.child.kill('SIGKILL')
        await sleep(300)
      }
    })

    // ==================== WorkBuddy 端点（无账号时不应 500） ====================
    group('10. WorkBuddy 管理端点（无账号，验证不崩）')

    await check('GET /api/workbuddy/accounts 返回空列表而非 500', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/accounts`)
      assert.strictEqual(r.status, 200)
      assert.ok(Array.isArray(r.json.accounts))
    })

    await check('GET /api/workbuddy/status 返回 counts', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/status`)
      assert.strictEqual(r.status, 200)
      assert.ok(r.json.counts && typeof r.json.counts.total === 'number')
    })

    await check('GET /api/workbuddy/config 返回配置', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/config`)
      assert.strictEqual(r.status, 200)
      assert.ok(typeof r.json.promptMode === 'string')
      assert.ok(r.json.identity && typeof r.json.identity === 'object')
    })

    await check('GET /api/workbuddy/models/enabled 无账号也返回 200', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/models/enabled?region=cn`)
      assert.strictEqual(r.status, 200)
      assert.ok(Array.isArray(r.json.models))
    })

    await check('GET /api/workbuddy/scheduler 返回排程状态', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/scheduler`)
      assert.strictEqual(r.status, 200)
    })

    await check('GET /api/workbuddy/logs 返回数组', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/logs`)
      assert.strictEqual(r.status, 200)
      assert.ok(Array.isArray(r.json.logs))
    })

    await check('GET /api/workbuddy/usage 返回快照', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/usage?hours=72`)
      assert.strictEqual(r.status, 200)
    })

    await check('GET /api/workbuddy/credit-history 返回结构', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/credit-history`)
      assert.strictEqual(r.status, 200)
      assert.ok(Array.isArray(r.json.entries))
    })

    await check('POST /api/workbuddy/tasks/run_queue 无账号 → 不崩', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/tasks/run_queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      assert.ok(r.status === 200 || r.status === 409)
    })

    await check('GET /api/workbuddy/tasks/queue 返回队列状态', async () => {
      const r = await fetchJson(`${base}/api/workbuddy/tasks/queue`)
      assert.strictEqual(r.status, 200)
    })

    // ==================== 重启 ====================
    group('11. 服务重启')

    await check('POST /api/restart 后仍可访问', async () => {
      const r = await fetchJson(`${base}/api/restart`, { method: 'POST' })
      assert.strictEqual(r.status, 200)
      await sleep(1500)
      const h = await fetchJson(`${base}/api/health`)
      assert.strictEqual(h.status, 200)
      assert.strictEqual(h.json.port, gwPort)
    })
  } finally {
    try {
      gw.child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    try {
      mock.server.close()
    } catch {
      /* ignore */
    }
    await sleep(300)
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  console.log('\n' + '='.repeat(52))
  console.log(`通过 ${passed} 项，失败 ${failed} 项，共 ${passed + failed} 项`)
  if (failed) {
    console.log('\n失败详情：')
    for (const f of failures) {
      console.log(`  ✗ ${f.name}\n    ${f.err.stack || f.err.message}`)
    }
    process.exit(1)
  }
  console.log('全部通过')
  process.exit(0)
}

main().catch(err => {
  console.error('冒烟测试异常：', err)
  process.exit(1)
})
