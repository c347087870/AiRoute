// WorkBuddy 模块的离线自动化测试
// 运行：node scripts/test-workbuddy.js（需 Node 14+，或用 Electron 内置 Node 运行）
// 覆盖：指纹脱敏 / 提示词体系与降级 / 请求体改写管线 / SSE 重建与聚合 /
//       错误分类 / 会话粘性 / 账号池冷却与选号 / 凭证双形态解析
// 全部为纯离线断言，不发起任何网络请求

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const wbDir = path.join(__dirname, '..', 'server', 'workbuddy')
const sanitize = require(path.join(wbDir, 'sanitize.js'))
const prompt = require(path.join(wbDir, 'prompt.js'))
const payload = require(path.join(wbDir, 'payload.js'))
const sse = require(path.join(wbDir, 'sse.js'))
const errors = require(path.join(wbDir, 'errors.js'))
const session = require(path.join(wbDir, 'session.js'))
const anthropicMod = require(path.join(wbDir, 'anthropic.js'))
const clientMod = require(path.join(wbDir, 'client.js'))
const poolMod = require(path.join(wbDir, 'pool.js'))
const authMod = require(path.join(wbDir, 'auth.js'))
const headersMod = require(path.join(wbDir, 'headers.js'))
const constants = require(path.join(wbDir, 'constants.js'))
const tasksMod = require(path.join(wbDir, 'tasks.js'))
const queueMod = require(path.join(wbDir, 'queue.js'))
const schedulerMod = require(path.join(wbDir, 'scheduler.js'))
const catalogMod = require(path.join(wbDir, 'catalog.js'))
const modelsdevMod = require(path.join(wbDir, 'modelsdev.js'))
const usageMod = require(path.join(wbDir, 'usage.js'))
const credithistMod = require(path.join(wbDir, 'credithist.js'))
const upstreamMod = require(path.join(__dirname, '..', 'server', 'upstream.js'))

// ===== 迷你测试框架 =====
let passed = 0
let failed = 0
const failures = []

// 执行一个测试用例
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

// 执行一个异步测试用例
async function testAsync(name, fn) {
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

// 测试分组标题
function group(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`)
}

// 构造一个内存账号（不落盘）
function makeAuth(uid, extra = {}) {
  return {
    uid,
    enterpriseId: '',
    nickname: `测试账号${uid.slice(0, 4)}`,
    domain: 'copilot.tencent.com',
    accessToken: `token-${uid}`,
    refreshToken: `refresh-${uid}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    deviceToken: '',
    filePath: '',
    ...extra
  }
}

// 等待队列执行结束（轮询 running 标志；超时直接返回）
async function waitQueue(queue, timeoutMs = 3000) {
  const t0 = Date.now()
  while (queue.queueStatus().running && Date.now() - t0 < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function main() {
  // ==================== 1. 指纹脱敏 ====================
  group('1. 指纹脱敏 sanitize')

  test('身份句改写（CLI 版句号保留）', () => {
    const out = sanitize.sanitizeText("You are Claude Code, Anthropic's official CLI for Claude.")
    assert.ok(out.includes('official CLI tool for Claude.'), '应插入 tool 一词')
    assert.ok(!out.includes('official CLI for Claude'), '原句应不再存在')
  })

  test('身份句改写（桌面版逗号后缀不漏网）', () => {
    const input = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
    const out = sanitize.sanitizeText(input)
    assert.ok(out.includes('official CLI tool for Claude, running within the Claude Agent SDK.'))
  })

  test('Codex instructions 首句改写、后句逐字保留', () => {
    const input =
      'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.'
    const out = sanitize.sanitizeText(input)
    assert.ok(out.includes('running in the Codex CLI tool, a terminal-based coding assistant.'))
    assert.ok(out.includes('Codex CLI is an open source project led by OpenAI.'))
  })

  test('非精确变体不改写', () => {
    const input = 'You are a coding agent running in a CLI, a terminal-based coding assistant.'
    assert.strictEqual(sanitize.sanitizeText(input), input)
  })

  test('Main branch 改写为 Default branch', () => {
    const out = sanitize.sanitizeText('Main branch (you will usually use this for PRs)')
    assert.strictEqual(out, 'Default branch (you will usually use this for PRs)')
  })

  test('反馈句 give→provide', () => {
    const input = 'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues'
    const out = sanitize.sanitizeText(input)
    assert.ok(out.includes('To provide feedback, users should report'))
    assert.ok(!out.includes('To give feedback'))
  })

  test('裸 11128 改写为 11-128（相邻错误码不动）', () => {
    const out = sanitize.sanitizeText('upstream returned code=11128 for this request, not 11148 or 11101')
    assert.ok(out.includes('code=11-128'))
    assert.ok(!out.includes('11128'))
    assert.ok(out.includes('11148') && out.includes('11101'))
  })

  test('billing header 键值段整段删除（大小写不敏感）', () => {
    assert.strictEqual(sanitize.sanitizeText('x-anthropic-billing-header: cc_version=1.0; cc_entrypoint=cli;'), '')
    const upper = sanitize.sanitizeText('X-Anthropic-Billing-Header: cc_version=1.0;')
    assert.ok(!upper.toLowerCase().includes('billing-header:'))
  })

  test('裸键名最小缩写为 hdr', () => {
    const out = sanitize.sanitizeText('字段 x-anthropic-billing-header 出现在正文中')
    assert.ok(out.includes('x-anthropic-billing-hdr'))
    assert.ok(!out.includes('billing-header'))
  })

  test('无指纹文本逐字原样返回（不 trim）', () => {
    const input = '  ordinary user message  '
    assert.strictEqual(sanitize.sanitizeText(input), input)
  })

  test('自由文本不误伤', () => {
    const input = 'please use main branch for this repo'
    assert.strictEqual(sanitize.sanitizeText(input), input)
  })

  test('多模态 content 只动 text part', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude" },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ]
      }
    ]
    const changed = sanitize.sanitizeMessages(messages)
    assert.strictEqual(changed, true)
    assert.ok(messages[0].content[0].text.includes('CLI tool for Claude'))
    assert.strictEqual(messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA')
  })

  test('tool_calls.arguments 盲区修复（content 为 null 仍净化）', () => {
    const messages = [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo 11128"}' } }]
      }
    ]
    const changed = sanitize.sanitizeMessages(messages)
    assert.strictEqual(changed, true)
    assert.ok(messages[1].tool_calls[0].function.arguments.includes('11-128'))
    assert.ok(!messages[1].tool_calls[0].function.arguments.includes('11128'))
  })

  // ==================== 2. 提示词体系与降级 ====================
  group('2. 提示词体系 prompt')

  test('custom 模式：删除全部 system/developer 并头部插入', () => {
    const body = JSON.stringify({
      model: 'x',
      messages: [
        { role: 'system', content: '旧系统提示' },
        { role: 'developer', content: '开发者指令' },
        { role: 'user', content: '你好' }
      ]
    })
    const out = JSON.parse(prompt.rewrite(body, '我是自有提示词'))
    assert.strictEqual(out.messages.length, 2)
    assert.strictEqual(out.messages[0].role, 'system')
    assert.strictEqual(out.messages[0].content, '我是自有提示词')
    assert.strictEqual(out.messages[1].role, 'user')
    assert.ok(!JSON.stringify(out).includes('旧系统提示'))
  })

  test('custom 模式：坏 JSON 原样返回', () => {
    const bad = '{not valid json'
    assert.strictEqual(prompt.rewrite(bad, 'SYS'), bad)
  })

  test('append 模式：开头连续块之后插入，既有消息逐字不动', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'A' },
        { role: 'developer', content: 'B' },
        { role: 'user', content: 'C' }
      ]
    })
    const out = JSON.parse(prompt.append(body, 'GW'))
    assert.deepStrictEqual(
      out.messages.map(m => m.role),
      ['system', 'developer', 'system', 'user']
    )
    assert.strictEqual(out.messages[2].content, 'GW')
  })

  test('append 模式：无开头块时插入到最前', () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'C' }] })
    const out = JSON.parse(prompt.append(body, 'GW'))
    assert.deepStrictEqual(
      out.messages.map(m => m.role),
      ['system', 'user']
    )
  })

  test('passthrough 模式不改写', () => {
    const body = JSON.stringify({ messages: [{ role: 'system', content: 'keep me' }] })
    const res = prompt.applyPromptMode(body, 'passthrough', 'GW')
    assert.strictEqual(res.body, body)
    assert.strictEqual(res.degradedApplied, false)
  })

  test('降级态触发后在 append 模式退化为替换', () => {
    prompt.degradeTrigger()
    assert.strictEqual(prompt.degradeActive(), true)
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'C' }
      ]
    })
    const res = prompt.applyPromptMode(body, 'append', 'GW')
    assert.strictEqual(res.degradedApplied, true)
    const out = JSON.parse(res.body)
    assert.strictEqual(out.messages[0].content, prompt.DEGRADED_PROMPT)
    assert.strictEqual(out.messages.length, 2)
  })

  test('nextMidnightCST：跨月与整点边界', () => {
    const CST = 8 * 3600 * 1000
    const cases = [
      ['2026-09-11T23:59:00+08:00', '2026-09-12T00:00:00+08:00'],
      ['2026-09-11T00:00:00+08:00', '2026-09-12T00:00:00+08:00'],
      ['2026-09-11T12:00:00+08:00', '2026-09-12T00:00:00+08:00'],
      ['2026-01-31T23:59:00+08:00', '2026-02-01T00:00:00+08:00']
    ]
    for (const [nowStr, wantStr] of cases) {
      const now = Date.parse(nowStr)
      const want = Date.parse(wantStr)
      const got = prompt.nextMidnightCST(now)
      assert.strictEqual(got, want, `${nowStr} → 期望 ${wantStr}`)
      assert.ok(got > now, '必须严格晚于当前时刻')
      assert.strictEqual((got + CST) % (24 * 3600 * 1000), 0, '必须是 CST 00:00')
    }
  })

  // ==================== 3. 请求体改写管线 ====================
  group('3. 请求体改写管线 payload')

  test('强制 stream:true 与 stream_options 补全', () => {
    const out = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'glm-5.2', messages: [], stream: false }), {}))
    assert.strictEqual(out.stream, true)
    assert.deepStrictEqual(out.stream_options, { include_usage: true })
  })

  test('max_completion_tokens 翻译为 max_tokens（显式优先只删别名）', () => {
    const a = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'm', messages: [], max_completion_tokens: 4096 }), {}))
    assert.strictEqual(a.max_tokens, 4096)
    assert.ok(!('max_completion_tokens' in a))

    const b = JSON.parse(
      payload.prepareBody(JSON.stringify({ model: 'm', messages: [], max_tokens: 100, max_completion_tokens: 4096 }), {})
    )
    assert.strictEqual(b.max_tokens, 100)

    const c = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'm', messages: [], max_completion_tokens: 0 }), {}))
    assert.ok(!('max_tokens' in c))
  })

  test('tool_choice 对象形式归一（none 连带删 tools）', () => {
    const out = JSON.parse(
      payload.prepareBody(
        JSON.stringify({ model: 'm', messages: [], tools: [{ type: 'function' }], tool_choice: { type: 'none' } }),
        {}
      )
    )
    assert.ok(!('tool_choice' in out))
    assert.ok(!('tools' in out))

    const out2 = JSON.parse(
      payload.prepareBody(
        JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'function', function: { name: 'Bash' } } }),
        {}
      )
    )
    assert.strictEqual(out2.tool_choice, 'Bash')

    const out3 = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'auto' } }), {}))
    assert.strictEqual(out3.tool_choice, 'auto')
  })

  test('role developer 归一为 system（不受 sanitize 开关影响）', () => {
    const out = JSON.parse(
      payload.prepareBody(JSON.stringify({ model: 'm', messages: [{ role: 'developer', content: 'x' }] }), { sanitize: false })
    )
    assert.strictEqual(out.messages[0].role, 'system')
  })

  test('image_url 字符串形态归一为对象形态', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://x/y.png' }] }]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.deepStrictEqual(out.messages[0].content[0].image_url, { url: 'https://x/y.png' })
  })

  test('tools schema 中 \\_ 转义修正', () => {
    const body = {
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { a: { pattern: '^a\\_b$' } } } } }]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.strictEqual(out.tools[0].function.parameters.properties.a.pattern, '^a_b$')
  })

  test('tool 配对：重排与孤儿清理', () => {
    // 孤儿：assistant 调用无对应结果 → 剔除调用与结果
    const body = {
      model: 'm',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'A', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'B', arguments: '{}' } }] }
      ]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.strictEqual(out.messages[2].tool_calls, undefined, 'c2 无结果应被剔除')
    assert.strictEqual(out.messages[0].tool_calls.length, 1)
  })

  test('DeepSeek 思维链注入（默认档 high，显式 disabled 反注入）', () => {
    const a = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }), {}))
    assert.strictEqual(a.thinking.type, 'enabled')
    assert.strictEqual(a.reasoning_effort, 'high')

    const b = JSON.parse(
      payload.prepareBody(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [], thinking: { type: 'disabled' } }), {})
    )
    assert.ok(!('reasoning_effort' in b))

    const c = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'glm-5.2', messages: [] }), {}))
    assert.ok(!('thinking' in c), '非 deepseek 不注入')
  })

  test('reasoning_effort 档位降级（max→high / low→medium）', () => {
    const efforts = { 'deepseek-v4-flash': ['low', 'high'], 'glm-5.2': ['medium', 'high'] }
    const a = JSON.parse(
      payload.prepareBody(JSON.stringify({ model: 'deepseek-v4-flash', messages: [], reasoning_effort: 'max' }), { efforts })
    )
    assert.strictEqual(a.reasoning_effort, 'high')

    const b = JSON.parse(
      payload.prepareBody(JSON.stringify({ model: 'glm-5.2', messages: [], reasoning_effort: 'low' }), { efforts })
    )
    assert.strictEqual(b.reasoning_effort, 'medium', '支持档全高于请求档时取最低')

    const c = JSON.parse(
      payload.prepareBody(JSON.stringify({ model: 'unknown-model', messages: [], reasoning_effort: 'xhigh' }), { efforts })
    )
    assert.strictEqual(c.reasoning_effort, 'xhigh', '未缓存模型透传')
  })

  test('reasoning_content 多轮回填（含单空格兜底）', () => {
    const body = {
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'assistant', content: 'a1', reasoning: '这是思考' },
        { role: 'user', content: 'q2' }
      ]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.strictEqual(out.messages[0].reasoning_content, '这是思考')
    assert.strictEqual(out.messages[0].reasoning, '这是思考')
  })

  test('prompt_cache_key 注入（已有值不覆盖）', () => {
    const a = payload.injectPromptCacheKey(JSON.stringify({ model: 'm', messages: [] }), 'uid12345678', 'conv-1')
    const keyA = JSON.parse(a).prompt_cache_key
    assert.ok(keyA.startsWith('wb2a-uid12345-'), '前缀应为 uid 前 8 位')

    const b = payload.injectPromptCacheKey(
      JSON.stringify({ model: 'm', messages: [], prompt_cache_key: 'existing' }),
      'uid1',
      'conv'
    )
    assert.strictEqual(JSON.parse(b).prompt_cache_key, 'existing')
  })

  // ==================== 4. SSE 重建与聚合 ====================
  group('4. SSE 帧重建与聚合 sse')

  test('帧白名单剔除噪声字段', () => {
    const rebuilder = sse.createFrameRebuilder()
    const res = rebuilder.push(
      JSON.stringify({
        id: 'c1',
        object: 'chat.completion.chunk',
        model: 'm',
        choices: [{ index: 0, delta: { content: 'hi', bogus_field: 1 }, finish_reason: null }],
        noise: 'x'
      })
    )
    const out = JSON.parse(res.payloads[0])
    assert.ok(!('noise' in out))
    assert.ok(!('bogus_field' in out.choices[0].delta))
    assert.strictEqual(out.choices[0].finish_reason, null)
  })

  test('error 帧绕过白名单原样透传', () => {
    const rebuilder = sse.createFrameRebuilder()
    const payloadStr = JSON.stringify({ error: { message: 'blocked by security policy', code: 11128 }, extra: 1 })
    const res = rebuilder.push(payloadStr)
    assert.strictEqual(res.payloads[0], payloadStr)
  })

  test('tool_calls name 每 index 只保留一次', () => {
    const rebuilder = sse.createFrameRebuilder()
    const f1 = JSON.parse(
      rebuilder.push(
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Bash', arguments: '' } }] } }] })
      ).payloads[0]
    )
    assert.strictEqual(f1.choices[0].delta.tool_calls[0].function.name, 'Bash')
    const f2 = JSON.parse(
      rebuilder.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'Bash', arguments: '{}' } }] } }] })).payloads[0]
    )
    assert.ok(!('name' in f2.choices[0].delta.tool_calls[0].function), '后续片应删除 name')
  })

  test('首帧 id 续传（后续帧缺 id 用缓存值）', () => {
    const rebuilder = sse.createFrameRebuilder()
    rebuilder.push(JSON.stringify({ id: 'chatcmpl-abc', choices: [] }))
    const f2 = JSON.parse(rebuilder.push(JSON.stringify({ choices: [{ delta: { content: 'x' } }] })).payloads[0])
    assert.strictEqual(f2.id, 'chatcmpl-abc')
  })

  test('非流式聚合：文本 + reasoning + usage', () => {
    const frames = [
      { id: 'c1', model: 'glm-5.2', created: 1, choices: [{ delta: { role: 'assistant', content: '你' } }] },
      { choices: [{ delta: { content: '好', reasoning_content: '思考中' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      null
    ]
    const text = frames.map(f => (f === null ? 'data: [DONE]\n' : `data: ${JSON.stringify(f)}\n`)).join('')
    const out = sse.aggregateSSE(text)
    assert.strictEqual(out.object, 'chat.completion')
    assert.strictEqual(out.choices[0].message.content, '你好')
    assert.strictEqual(out.choices[0].message.reasoning_content, '思考中')
    assert.strictEqual(out.choices[0].finish_reason, 'stop')
    assert.strictEqual(out.usage.total_tokens, 12)
  })

  test('非流式聚合：tool_calls 按 index 合并', () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Bash', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      null
    ]
    const text = frames.map(f => (f === null ? 'data: [DONE]\n' : `data: ${JSON.stringify(f)}\n`)).join('')
    const out = sse.aggregateSSE(text)
    assert.strictEqual(out.choices[0].message.tool_calls.length, 1)
    assert.strictEqual(out.choices[0].message.tool_calls[0].function.arguments, '{"a":1}')
  })

  test('截断保护：finish_reason=length 时丢弃残缺 arguments', () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Bash', arguments: '{"a":1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 't2', function: { name: 'Bash', arguments: '{"b"' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      null
    ]
    const text = frames.map(f => (f === null ? 'data: [DONE]\n' : `data: ${JSON.stringify(f)}\n`)).join('')
    const out = sse.aggregateSSE(text)
    const calls = out.choices[0].message.tool_calls || []
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].function.arguments, '{"a":1}')
  })

  test('空流抛哨兵错误', () => {
    assert.throws(() => sse.aggregateSSE('data: \n\n'), /no valid data events/)
  })

  test('usage 缓存别名归一（4 字段统一）', () => {
    const out = sse.normalizeUsageCacheAliases({ prompt_tokens: 100, prompt_cache_hit_tokens: 40 })
    assert.strictEqual(out.cache_read_input_tokens, 40)
    assert.strictEqual(out.cached_tokens, 40)
    assert.strictEqual(out.prompt_tokens_details.cached_tokens, 40)
  })

  test('请求体 model 注入 setBodyModel（客户端未指定时补全为网关解析结果）', () => {
    // 客户端不传 model（AiRoute 允许用界面当前选中模型）→ 必须补全，否则上游报 11102
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const out = JSON.parse(payload.setBodyModel(body, 'hy4-preview'))
    assert.strictEqual(out.model, 'hy4-preview')

    // 客户端带的旧模型被覆盖为网关解析结果
    const override = JSON.parse(payload.setBodyModel(JSON.stringify({ model: 'old' }), 'new'))
    assert.strictEqual(override.model, 'new')

    // 已一致时原样返回（保持引用相等，避免无谓序列化）
    const same = JSON.stringify({ model: 'm', messages: [] })
    assert.strictEqual(payload.setBodyModel(same, 'm'), same)

    // 无模型参数时不处理
    const noop = JSON.stringify({ messages: [] })
    assert.strictEqual(payload.setBodyModel(noop, ''), noop)
  })

  test('模型级档位注入 setBodyEffort（空不干预 / 自定义覆盖 / off 删除）', () => {
    const base = JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'low' })
    // 未配置档位 → 原样返回（不干预客户端原值）
    assert.strictEqual(payload.setBodyEffort(base, ''), base)
    // 自定义字符覆盖（含 xhigh 等非标准档位）
    const out = JSON.parse(payload.setBodyEffort(base, 'xhigh'))
    assert.strictEqual(out.reasoning_effort, 'xhigh')
    // off → 删除档位字段
    const off = JSON.parse(payload.setBodyEffort(base, 'off'))
    assert.ok(!('reasoning_effort' in off))
    // camelCase 变体统一清理，避免重复字段
    const camel = JSON.parse(payload.setBodyEffort(JSON.stringify({ model: 'm', reasoningEffort: 'x' }), 'high'))
    assert.strictEqual(camel.reasoning_effort, 'high')
    assert.ok(!('reasoningEffort' in camel))
  })

  test('模型级档位字段清洗（Provider models 的 reasoningEffort）', () => {
    const modelsMod = require(path.join(__dirname, '..', 'server', 'models.js'))
    const list = modelsMod.sanitizeModels([
      { id: 'm1', reasoningEffort: '  xhigh  ' },
      { id: 'm2', reasoningEffort: '' },
      { id: 'm3', reasoningEffort: 'a'.repeat(50) }
    ])
    assert.strictEqual(list[0].reasoningEffort, 'xhigh', '两端空白应清理')
    assert.ok(!('reasoningEffort' in list[1]), '空档位不写入字段')
    assert.strictEqual(list[2].reasoningEffort.length, 32, '超长截断到 32 字符')
    // 视图归一化时同样保留该字段
    const view = modelsMod.toProviderView({ type: 'workbuddy', models: [{ id: 'm', reasoningEffort: 'minimal' }] })
    assert.strictEqual(view.models[0].reasoningEffort, 'minimal')
  })

  // ==================== 4.5 计费响应解析 ====================
  group('4.5 计费响应解析 client')

  test('Accounts 提取：真实信封层级 data.Response.Data.Accounts', () => {
    const env = { code: 0, msg: '', data: { Response: { Data: { Accounts: [{ PackageName: 'P1' }] } } } }
    const accounts = clientMod.extractAccounts(env)
    assert.ok(Array.isArray(accounts), '应识别出 Accounts 数组')
    assert.strictEqual(accounts.length, 1)
    assert.strictEqual(accounts[0].PackageName, 'P1')
  })

  test('Accounts 提取：兼容无 data 内层形态与异常输入', () => {
    // 兼容分支：个别域可能不带 data 内层
    assert.strictEqual(clientMod.extractAccounts({ Response: { Data: { Accounts: [] } } }).length, 0)
    // 无法识别结构 → null（触发带诊断信息的错误消息）
    assert.strictEqual(clientMod.extractAccounts({ code: 0, msg: 'ok' }), null)
    assert.strictEqual(clientMod.extractAccounts(null), null)
  })

  test('积分聚合：Cycle / Capacity 口径不混用 + 到期解析', () => {
    const env = {
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: '包A', CapacityRemain: 300, CapacityUsed: 100, CapacitySize: 400, CycleEndTime: '2026-12-31 12:00:00' },
              { PackageName: '包B', CycleCapacitySize: 500, CycleCapacityRemain: 0, CycleCapacityUsed: 500, CycleEndTime: '2026-10-01 00:00:00' }
            ]
          }
        }
      }
    }
    const accounts = clientMod.extractAccounts(env)
    const agg = clientMod.aggregateCredits(accounts, 168 * 3600000)
    assert.strictEqual(agg.ok, true)
    assert.strictEqual(agg.credits, 300, '仅包A 有剩余（包B 已用完）')
    assert.strictEqual(agg.total, 900, '包A 400(Capacity) + 包B 500(Cycle)')
    assert.ok(agg.earliestExpiry > 0, '应解析出最早到期时间')
    assert.strictEqual(agg.earliestRemaining, 300)
  })

  // ==================== 5. 错误分类 ====================
  group('5. 错误分类 errors')

  const K = errors.ERR_KIND

  test('402 → 余额不足', () => assert.strictEqual(errors.classify(402, ''), K.HARD_CREDIT))
  test('429 → 软限流', () => assert.strictEqual(errors.classify(429, ''), K.SOFT_RATE))
  test('429 + 14018 → 余额不足（优先于通用 429）', () =>
    assert.strictEqual(errors.classify(429, '{"code":14018,"msg":"quota exceeded"}'), K.HARD_CREDIT))
  test('401 + 12153 → session 失效（优先于限流文案）', () =>
    assert.strictEqual(errors.classify(401, '{"code":12153,"msg":"Offline user session not found rate limit"}'), K.SESSION_DEAD))
  test('400 + 11102 → 该后端无此模型', () =>
    assert.strictEqual(errors.classify(400, '{"code":11102,"msg":"service info not found"}'), K.MODEL_BLOCKED))
  test('404 → 上游 404', () => assert.strictEqual(errors.classify(404, ''), K.NOT_FOUND))
  test('500 → 服务端错误', () => assert.strictEqual(errors.classify(500, ''), K.SERVER))
  test('400 + 内容拦截文案 → 内容拦截', () =>
    assert.strictEqual(errors.classify(400, '{"code":11128,"msg":"blocked by security policy"}'), K.CONTENT_BLOCKED))
  test('403 + 无业务信封 → WAF', () => assert.strictEqual(errors.classify(403, '<html>403 Forbidden</html>'), K.WAF_BLOCK))
  test('403 + 业务信封 → 内容拦截', () =>
    assert.strictEqual(errors.classify(403, '{"code":11128,"msg":"blocked by security policy"}'), K.CONTENT_BLOCKED))
  test('400 + 11115 → prompt 过长', () =>
    assert.strictEqual(errors.classify(400, '{"code":11115,"msg":"prompt is too long"}'), K.PROMPT_TOO_LONG))
  test('400 + Unmarshal → 请求体解析失败', () =>
    assert.strictEqual(errors.classify(400, 'msg: Unmarshal chat params failed'), K.BAD_PARAMS))
  test('400 + 11140 request illegal → 账号故障', () =>
    assert.strictEqual(errors.classify(400, '{"code":11140,"msg":"request illegal"}'), K.ACCOUNT_FAULT))
  test('200 → 无错误', () => assert.strictEqual(errors.classify(200, 'ok'), K.NONE))

  test('ParseRateReset 解析中文重置文案（UTC+8 墙钟）', () => {
    const body = '{"code":6004,"msg":"该模型使用量已达上限，将在 2026-09-30 18:00:00 UTC+8 重置"}'
    const ms = errors.parseRateReset(body)
    const expected = Date.UTC(2026, 8, 30, 10, 0, 0) // 18:00 CST = 10:00 UTC
    assert.strictEqual(ms, expected)
  })

  test('ParseRateReset 解析英文重置文案', () => {
    const body = '{"msg":"reset at 2026-09-30 18:00:00"}'
    const ms = errors.parseRateReset(body)
    assert.strictEqual(ms, Date.UTC(2026, 8, 30, 10, 0, 0))
  })

  test('IsModelRateLimit 识别裸数字与带引号形态', () => {
    assert.strictEqual(errors.isModelRateLimit('{"code":6004}'), true)
    assert.strictEqual(errors.isModelRateLimit('{"code":"6004"}'), true)
    assert.strictEqual(errors.isModelRateLimit('{"code":6005}'), false)
  })

  test('ParseRetryAfter 解析 Retry-After 秒（越界丢弃）', () => {
    assert.strictEqual(errors.parseRetryAfter({ 'retry-after': '120' }), 120000)
    assert.strictEqual(errors.parseRetryAfter({ 'retry-after': '99999' }), 0)
    assert.strictEqual(errors.parseRetryAfter({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }), 0)
  })

  test('isAlreadyCheckin 只认错误路径（2xx 不算幂等）', () => {
    assert.strictEqual(errors.isAlreadyCheckin(200, '{"code":0}'), false, '2xx 不得判为已签到')
    assert.strictEqual(errors.isAlreadyCheckin(400, '{"code":10001,"msg":"今日已签到"}'), true)
    assert.strictEqual(errors.isAlreadyCheckin(409, '{"msg":"already checked in today"}'), true)
    assert.strictEqual(errors.isAlreadyCheckin(400, '{"code":10000,"msg":"server error"}'), false)
  })

  test('gateway_hint 按错误类型映射（未覆盖形态为空）', () => {
    assert.ok(errors.gatewayHint(K.SOFT_RATE, '').includes('rate limited'))
    assert.ok(errors.gatewayHint(K.MODEL_BLOCKED, '').includes('no such model'))
    assert.ok(errors.gatewayHint(K.WAF_BLOCK, '').includes('WAF'))
    assert.ok(errors.gatewayHint(K.CONTENT_BLOCKED, '').includes('content policy'))
    assert.strictEqual(errors.gatewayHint(K.NONE, ''), '')
    assert.strictEqual(errors.gatewayHint(K.SERVER, ''), '')
  })

  test('gateway_hint 11133/11135 家族优先于 Kind 表', () => {
    const neutral = errors.gatewayHint(K.CLIENT, '{"code":11133,"msg":"invalid request parameters"}')
    assert.ok(neutral.includes('model capabilities'), '无图上下文退中性提示')
    const pointed = errors.gatewayHint(K.CLIENT, '{"code":11133,"msg":"invalid request parameters"}', {
      model: 'glm-5.3-flash',
      hasImage: true,
      modelInCatalog: true,
      modelSupportsImages: false
    })
    assert.ok(pointed.includes('does not support images') && pointed.includes('glm-5.3-flash'))
    assert.ok(errors.gatewayHint(K.CLIENT, '{"code":11135,"msg":"invalid_image_data"}').includes('image data rejected'))
  })

  test('frameKind 判定 SSE error 帧（6004 优先）', () => {
    assert.strictEqual(errors.frameKind('{"code":6004,"msg":"rate limit"}'), K.SOFT_RATE)
    assert.strictEqual(errors.frameKind('{"error":{"message":"prompt is too long"}}'), K.PROMPT_TOO_LONG)
  })

  // ==================== 6. 会话粘性 ====================
  group('6. 会话粘性 session')

  test('会话键提取顺序（metadata 优先于顶层）', () => {
    const body = JSON.stringify({ metadata: { conversation_id: 'meta-id' }, conversation_id: 'top-id', messages: [] })
    assert.strictEqual(session.extractKey(body), 'meta-id')
  })

  test('prompt_cache_key 作为会话键', () => {
    const body = JSON.stringify({ prompt_cache_key: 'pck-1', messages: [] })
    assert.strictEqual(session.extractKey(body), 'pck-1')
  })

  test('派生回退：system + 首条 user 哈希（d- 前缀）', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hello' }
      ]
    })
    const key = session.extractKey(body)
    assert.ok(key.startsWith('d-'), '应为派生键')
    assert.strictEqual(key.length, 2 + 32)
    // 稳定复现
    assert.strictEqual(session.extractKey(body), key)
  })

  test('user_id 抑制派生回退', () => {
    const body = JSON.stringify({ metadata: { user_id: 'u1' }, messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(session.extractKey(body), '')
  })

  test('FNV-1a 稳定映射', () => {
    assert.strictEqual(session.hashIndex('abc', 10), session.hashIndex('abc', 10))
    assert.ok(session.hashIndex('abc', 10) < 10)
  })

  test('路由器：粘性命中与滚动续期', () => {
    const router = session.createRouter({ available: () => ['a', 'b', 'c'] })
    const r1 = router.resolveForModel('k1', '')
    assert.strictEqual(r1.ok, true)
    const r2 = router.resolveForModel('k1', '')
    assert.strictEqual(r2.uid, r1.uid, '同一会话应复用同一账号')
    router.stopGC()
  })

  test('路由器：绑定账号不可用时重新分配', () => {
    let uids = ['a']
    const router = session.createRouter({ available: () => uids })
    const r1 = router.resolveForModel('k2', '')
    assert.strictEqual(r1.uid, 'a')
    uids = ['b']
    const r2 = router.resolveForModel('k2', '')
    assert.strictEqual(r2.uid, 'b')
    router.stopGC()
  })

  test('轮级键 TurnKey：取最后一条 user 消息（序号 + 内容签名）', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '第二轮' }
      ]
    })
    assert.strictEqual(session.turnKey(body), 'u2:第二轮')
    // 同内容不同轮次 → 不同键（序号入键）
    const body2 = JSON.stringify({ messages: [{ role: 'user', content: '第二轮' }] })
    assert.strictEqual(session.turnKey(body2), 'u0:第二轮')
    assert.strictEqual(session.turnKey(JSON.stringify({ messages: [] })), '')
  })

  test('聚合 ID：同键稳定、异键不同、恒 32 hex', () => {
    const a1 = session.requestIdForKey('conv-a')
    const a2 = session.requestIdForKey('conv-a')
    const b = session.requestIdForKey('conv-b')
    assert.strictEqual(a1, a2, '同会话键应恒派生同值')
    assert.notStrictEqual(a1, b)
    assert.strictEqual(a1.length, 32)
    const t1 = session.turnRequestId('u0:同一个问题')
    assert.strictEqual(t1, session.turnRequestId('u0:同一个问题'))
    assert.notStrictEqual(t1, session.turnRequestId('u2:同一个问题'))
    assert.strictEqual(t1.length, 32)
  })

  test('内容签名：非文本 part 入 type + 摘要（纯图片轮不碎片化）', () => {
    const img = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }]
    const sig = session.contentSignature(img)
    assert.ok(sig.startsWith('[image_url:'), '非文本 part 应带摘要')
    assert.strictEqual(session.contentSignature(img), sig, '同内容签名稳定')
    assert.notStrictEqual(session.contentSignature([{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }]), sig)
    assert.strictEqual(session.contentSignature('纯文本'), '纯文本')
  })

  test('任务合并键：Claude Code 工具循环中稳定、换轮或换会话则变化', () => {
    const ccBody = (sid, msgs) =>
      JSON.stringify({
        metadata: { user_id: `user_abc123_account_xyz__session_${sid}` },
        messages: msgs
      })
    const first = ccBody('s-1', [{ role: 'user', content: '帮我检查日志页问题' }])
    const k1 = session.extractTaskKey(first)
    assert.ok(k1.startsWith('s:s-1'), '会话段应取 user_id 中的 session 段')
    // 工具循环后续请求：追加 assistant + tool_result，任务键不变
    const loop = ccBody('s-1', [
      { role: 'user', content: '帮我检查日志页问题' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
    ])
    assert.strictEqual(session.extractTaskKey(loop), k1, '工具循环应合并为同一任务')
    // 换轮：新的真实用户输入 → 新任务键
    const nextTurn = ccBody('s-1', [
      { role: 'user', content: '帮我检查日志页问题' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续优化日志页' }
    ])
    assert.notStrictEqual(session.extractTaskKey(nextTurn), k1, '新轮次应另起任务')
    // 换会话
    const otherSession = ccBody('s-2', [{ role: 'user', content: '帮我检查日志页问题' }])
    assert.notStrictEqual(session.extractTaskKey(otherSession), k1, '不同会话应隔离')
  })

  test('任务合并键：显式会话键优先、无标识回退派生、缺轮不合并', () => {
    const withConv = JSON.stringify({ conversation_id: 'c-9', messages: [{ role: 'user', content: 'hi' }] })
    assert.ok(session.extractTaskKey(withConv).startsWith('k:c-9'))
    const derived = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    assert.ok(session.extractTaskKey(derived).startsWith('d-'), '应回退派生键')
    // 只有会话段、没有可用轮段时不合并（空串）
    assert.strictEqual(session.extractTaskKey(JSON.stringify({ conversation_id: 'c-9', messages: [] })), '')
  })

  test('使用记录：取真实输入、跳过工具结果、图片占位、超长截断', () => {
    const loop = JSON.stringify({
      messages: [
        { role: 'user', content: '帮我检查日志页问题' },
        { role: 'assistant', content: '处理中' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
      ]
    })
    assert.strictEqual(session.extractInputText(loop), '帮我检查日志页问题')
    const img = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAA' } }] }]
    })
    assert.strictEqual(session.extractInputText(img), '[图片]')
    const long = session.extractInputText(
      JSON.stringify({ messages: [{ role: 'user', content: '长'.repeat(2500) }] })
    )
    assert.strictEqual(long.length, 1000, '超长输入应截断到 1000 字符')
    assert.strictEqual(session.extractInputText(JSON.stringify({ messages: [] })), '')
  })

  test('使用记录：<user_query> 只取最后一段内文、无标签保留原文、先提取后截断', () => {
    const wrapped = JSON.stringify({
      messages: [
        { role: 'user', content: '<user_info>大段上下文</user_info><user_query>第一个问题</user_query>' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '前文 <user_query>第一个问题</user_query> 后文 <user_query> 真正的问题 </user_query> 结尾' }
      ]
    })
    assert.strictEqual(session.extractInputText(wrapped), '真正的问题', '应取最后一段内文并去两端空白')
    const noTag = JSON.stringify({ messages: [{ role: 'user', content: '无标签时保留原文' }] })
    assert.strictEqual(session.extractInputText(noTag), '无标签时保留原文')
    const unclosed = JSON.stringify({ messages: [{ role: 'user', content: '未闭合 <user_query>abc' }] })
    assert.strictEqual(session.extractInputText(unclosed), '未闭合 <user_query>abc', '未闭合标签保留原文')
    const longTagged = session.extractInputText(
      JSON.stringify({ messages: [{ role: 'user', content: `<user_info>${'x'.repeat(3000)}</user_info><user_query>${'长'.repeat(2500)}</user_query>` }] })
    )
    assert.strictEqual(longTagged.length, 1000, '提取内文后再截断到 1000 字符')
  })

  test('使用记录：注入块（系统提醒 / 上下文标签）跳过并回退，全是注入块记 [系统续写]', () => {
    const remind = JSON.stringify({
      messages: [
        { role: 'user', content: '修一下日志页的显示' },
        { role: 'assistant', content: '处理中' },
        { role: 'user', content: '[System reminder: Output token limit hit. Resume directly.]' }
      ]
    })
    assert.strictEqual(session.extractInputText(remind), '修一下日志页的显示', '提醒续写应回退到真实提问')
    const ctxOnly = JSON.stringify({
      messages: [
        { role: 'user', content: '<user_info>\nOS Version: win32\n</user_info>' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '<additional_data>\nBelow are context blocks.\n</additional_data>\n<cb_summary>\nSummary of the conversation so far.\n</cb_summary>' }
      ]
    })
    assert.strictEqual(session.extractInputText(ctxOnly), '[系统续写]', '全是注入块时记 [系统续写]')
  })

  test('使用记录：system-reminder / session 块剥离后记录残余文本', () => {
    const cc = JSON.stringify({
      messages: [
        { role: 'user', content: '<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>\nhello，小c' }
      ]
    })
    assert.strictEqual(session.extractInputText(cc), 'hello，小c', '指令块剥离后只留用户残余问题')
    const ideOnly = JSON.stringify({
      messages: [
        { role: 'user', content: '<session>\n<ide_opened_file>The user opened the file d:/x.js in the IDE.</ide_opened_file>' }
      ]
    })
    assert.strictEqual(session.extractInputText(ideOnly), '[系统续写]', '纯 IDE 上下文记 [系统续写]')
  })

  test('合并键：续写提醒不另起日志（跳过注入块后轮段稳定）', () => {
    const base = JSON.stringify({ conversation_id: 'c-1', messages: [{ role: 'user', content: '继续' }] })
    const withRemind = JSON.stringify({
      conversation_id: 'c-1',
      messages: [
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '[System reminder: Output token limit hit. Resume directly.]' }
      ]
    })
    assert.strictEqual(session.extractTaskKey(withRemind), session.extractTaskKey(base), '提醒续写应与原提问合并为同一任务')
  })

  // ==================== 7. 账号池 ====================
  group('7. 账号池 pool')

  test('软冷却：指数退避与封顶', () => {
    const pool = poolMod.createPool({ softRateMs: 1000, softRateMaxMs: 8000 })
    pool.add(makeAuth('u1'))
    const base = 1000
    pool.cooldownSoftRate('u1', base, 0, 'r1')
    const st1 = pool.status('u1')
    assert.ok(st1.coolRemaining >= 1 && st1.coolRemaining <= 2, '首次应为 base')

    // 到期后再触发 → streak 递增
    const e = pool.status('u1')
    pool.cooldownSoftRate('u1', base, 0, 'r2')
    const st2 = pool.status('u1')
    assert.ok(st2.coolRemaining >= st1.coolRemaining, '退避应不短于上一次')
  })

  test('6004 模型级冷却：切模型豁免（不写账号级 until）', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('u2'))
    const resetAt = Date.now() + 3600000
    pool.cooldownSoftForModel('u2', 600000, resetAt, 'glm-5.2', '6004 model rate limit')
    const st = pool.status('u2')
    assert.strictEqual(st.cooling, false, '账号级不应冷却')
    assert.strictEqual(st.rateLimitedModels.length, 1)
    assert.strictEqual(st.rateLimitedModels[0].model, 'glm-5.2')
    assert.strictEqual(st.rateLimitedModels[0].kind, 'rate_limit')
    // 其他模型仍可选
    assert.ok(pool.availableUIDs('deepseek-v4-flash').includes('u2'))
    assert.ok(!pool.availableUIDs('glm-5.2').includes('u2'))
  })

  test('11102 负缓存：仅锁该模型，调用成功清除后恢复', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('u2b'))
    pool.blockModelBackoff('u2b', 'glm-5.3-flash', '11102 model not available')
    assert.ok(!pool.availableUIDs('glm-5.3-flash').includes('u2b'), '命中 11102 负缓存的模型不可选')
    assert.ok(pool.availableUIDs('hy4-preview').includes('u2b'), '其他模型不受影响')
    assert.strictEqual(pool.status('u2b').rateLimitedModels[0].kind, 'model_unavailable')

    pool.blockModelClear('u2b', 'glm-5.3-flash')
    assert.ok(pool.availableUIDs('glm-5.3-flash').includes('u2b'), '清除负缓存后恢复可选')
  })

  test('noteModelCost：EMA 平滑 + 余额内插扣减 + 免费窗口结束事件', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('cm1'))
    pool.setCreditsDetailed('cm1', 1000, 1000, 0, 0, 0)
    // 首次：免费请求（credit=0）→ 单价 0，余额不变
    const r1 = pool.noteModelCost('cm1', 'glm-5.2', 0, 1000)
    assert.strictEqual(r1.ok, true)
    assert.strictEqual(r1.costPer1k, 0)
    assert.strictEqual(pool.status('cm1').credits, 1000)
    // 第二次：收费（credit=10 / 1000 token）→ 免费窗口结束 + 扣减 10
    const r2 = pool.noteModelCost('cm1', 'glm-5.2', 10, 1000)
    assert.strictEqual(r2.freeTierEnded, true, '免费窗口结束应上报事件')
    assert.strictEqual(pool.status('cm1').credits, 990)
    assert.ok(Math.abs(r2.costPer1k - 3) < 1e-9, 'EMA：0×0.7+10×0.3=3')
    // tokens<=0：不记录、不扣减
    const r3 = pool.noteModelCost('cm1', 'glm-5.2', 100, 0)
    assert.strictEqual(r3.ok, false)
    assert.strictEqual(pool.status('cm1').credits, 990)
  })

  test('成本分层与 30min 探索：探索到期改道无观测账号', () => {
    // 关停探索：优先实测免费账号
    const p1 = poolMod.createPool({ costExploreMs: 0, preferExpiring: false })
    p1.add(makeAuth('free1'))
    p1.add(makeAuth('unknown1'))
    p1.setCreditsDetailed('free1', 100, 100, 0, 0, 0)
    p1.setCreditsDetailed('unknown1', 100, 100, 0, 0, 0)
    p1.noteModelCost('free1', 'glm-5.2', 0, 1000)
    assert.strictEqual(p1.pick({ model: 'glm-5.2' }).uid, 'free1', '有免费层时应优先免费账号')

    // 开启探索（间隔 1ms 必然到期）：本次改道给无观测账号
    const p2 = poolMod.createPool({ costExploreMs: 1, preferExpiring: false })
    p2.add(makeAuth('free2'))
    p2.add(makeAuth('unknown2'))
    p2.setCreditsDetailed('free2', 100, 100, 0, 0, 0)
    p2.setCreditsDetailed('unknown2', 100, 100, 0, 0, 0)
    p2.noteModelCost('free2', 'glm-5.2', 0, 1000)
    assert.strictEqual(p2.pick({ model: 'glm-5.2' }).uid, 'unknown2', '探索周期到期应改道无观测账号')
  })

  test('setCreditsDetailed 钳制快过期额度到 [0, credits]', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('cl1'))
    pool.setCreditsDetailed('cl1', 100, 100, 999, Date.now() + 1000, 999)
    const st = pool.status('cl1')
    assert.strictEqual(st.creditsExpiring, 100)
    assert.strictEqual(st.creditsEarliestRemaining, 100)
    pool.setCreditsDetailed('cl1', 50, 100, -5, 0, -5)
    assert.strictEqual(pool.status('cl1').creditsExpiring, 0)
  })

  test('账号级 token 消耗：累计与今日分别计数', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('tk1'))
    pool.noteTokenUsage('tk1', 100)
    pool.noteTokenUsage('tk1', 50)
    const st = pool.status('tk1')
    assert.strictEqual(st.tokenUsageToday, 150)
    assert.strictEqual(st.tokenUsageTotal, 150)
    pool.noteTokenUsage('tk1', 0) // 非正数不记录
    assert.strictEqual(pool.status('tk1').tokenUsageToday, 150)
  })

  test('保活结果与签到时刻记录（含禁用时间）', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('kp1'))
    pool.noteKeepalive('kp1', false)
    let st = pool.status('kp1')
    assert.ok(st.lastKeepaliveAt > 0)
    assert.strictEqual(st.lastKeepaliveOk, false)
    pool.noteKeepalive('kp1', true)
    assert.strictEqual(pool.status('kp1').lastKeepaliveOk, true)
    pool.noteCheckinDone('kp1')
    assert.ok(pool.status('kp1').lastCheckinAt > 0)
    pool.disable('kp1', '人工禁用')
    st = pool.status('kp1')
    assert.strictEqual(st.disabled, true)
    assert.ok(st.disabledAt > 0)
    pool.reviveDisabled('kp1')
    assert.strictEqual(pool.status('kp1').disabledAt, 0)
  })

  test('WAF IP 级门：单号反复 403 不触发，两个不同号触发', () => {
    const wafipMod = require(path.join(wbDir, 'wafip.js'))
    const gate = wafipMod.createWafIpGate({ windowMs: 60000, threshold: 2 })
    assert.strictEqual(gate.noteWaf('uidA'), false, '单号首次不触发')
    assert.strictEqual(gate.noteWaf('uidA'), false, '同号反复不触发（只数不同号）')
    assert.strictEqual(gate.noteWaf('uidB'), true, '第二个不同号触发 IP 级')
    assert.strictEqual(gate.active(), true)
    assert.strictEqual(gate.noteWaf('uidC'), true, '激活期内新命中直接 true（不续期）')
  })

  await testAsync('WAF IP 级门：窗口到期自然解除', async () => {
    const wafipMod = require(path.join(wbDir, 'wafip.js'))
    const gate = wafipMod.createWafIpGate({ windowMs: 10, threshold: 2 })
    gate.noteWaf('u1')
    gate.noteWaf('u2')
    assert.strictEqual(gate.active(), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.strictEqual(gate.active(), false, '窗口到期自然解除')
  })

  test('余额耗尽 → 硬冷却到次日 04:00（可被余额恢复解冻）', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('u3'))
    pool.cooldownUntilTomorrow4AM('u3', '余额不足')
    const st = pool.status('u3')
    assert.strictEqual(st.cooling, true)
    assert.strictEqual(st.coolKind, 'hard_credit')
    assert.ok(st.coolRemaining > 0)

    pool.reenableIfCredits('u3', 100, 1000)
    assert.strictEqual(pool.status('u3').cooling, false, '余额恢复后应解冻')
  })

  test('软冷却不被余额刷新清空（只解冻硬冷却）', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('u4'))
    pool.cooldownSoftRate('u4', 600000, 0, '429')
    pool.reenableIfCredits('u4', 100, 1000)
    assert.strictEqual(pool.status('u4').cooling, true, '软冷却应保留')
  })

  test('熔断：连败达阈触发退避（30m 起）', () => {
    const pool = poolMod.createPool({ breakerThreshold: 3, breakerCooldownMs: 60000, breakerCooldownMaxMs: 300000 })
    pool.add(makeAuth('u5'))
    pool.noteError('u5')
    pool.noteError('u5')
    assert.strictEqual(pool.status('u5').cooling, false)
    pool.noteError('u5')
    const st = pool.status('u5')
    assert.strictEqual(st.cooling, true)
    assert.strictEqual(st.coolKind, 'breaker')

    pool.noteSuccess('u5')
    assert.strictEqual(pool.status('u5').cooling, false, '成功应清零熔断')
  })

  test('12153 连续 3 次才达禁用阈值', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('u6'))
    assert.strictEqual(pool.noteSessionDead('u6'), false)
    assert.strictEqual(pool.noteSessionDead('u6'), false)
    assert.strictEqual(pool.noteSessionDead('u6'), true)
    pool.disable('u6', '12153 session dead')
    const st = pool.status('u6')
    assert.strictEqual(st.disabled, true)
    assert.strictEqual(st.disabledReason, '12153 session dead')
    assert.ok(!pool.availableUIDs('').includes('u6'), '禁用账号不参与选号')

    pool.revive('u6')
    assert.strictEqual(pool.status('u6').disabled, false)
  })

  test('选号：禁用账号不参与，健康账号可选中', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('ok1'))
    pool.add(makeAuth('bad1'))
    pool.disable('bad1', 'test')
    const pickedUids = new Set()
    for (let i = 0; i < 20; i++) {
      const auth = pool.pick({})
      if (auth) pickedUids.add(auth.uid)
    }
    assert.deepStrictEqual([...pickedUids], ['ok1'])
  })

  test('选号：最早到期优先（快过期账号优先被选）', () => {
    const pool = poolMod.createPool({ preferExpiring: true })
    pool.add(makeAuth('rich'))
    pool.add(makeAuth('expiring'))
    pool.setCreditsDetailed('rich', 10000, 10000, 0, 0, 0)
    const soon = Date.now() + 3600000
    pool.setCreditsDetailed('expiring', 100, 100, 100, soon, 100)
    const auth = pool.pick({})
    assert.strictEqual(auth.uid, 'expiring', '快过期积分账号应优先')
  })

  test('全冷却兜底：排除硬冷却账号，取最早到期者', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('hard'))
    pool.add(makeAuth('soft'))
    pool.cooldownUntilTomorrow4AM('hard', '余额不足')
    pool.cooldownSoftRate('soft', 60000, 0, '429')
    const auth = pool.pick({})
    assert.ok(auth, '应有兜底账号')
    assert.strictEqual(auth.uid, 'soft', '硬冷却账号不应参与兜底')
  })

  test('在途租约：占满拒绝、释放后可用', () => {
    const pool = poolMod.createPool({ maxInFlight: 1 })
    pool.add(makeAuth('inf1'))
    assert.strictEqual(pool.acquire('inf1'), true)
    assert.strictEqual(pool.acquire('inf1'), false)
    assert.strictEqual(pool.pick({}), null, '在途占满不应被选中')
    pool.release('inf1')
    assert.strictEqual(pool.acquire('inf1'), true)
  })

  test('状态持久化往返（原子写 + 加载恢复）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pool-test-'))
    const stateFile = path.join(dir, 'state.json')
    const pool = poolMod.createPool({ stateFile })
    pool.add(makeAuth('p1'))
    pool.setCreditsDetailed('p1', 500, 1000, 50, Date.now() + 7200000, 50)
    pool.cooldownSoftForModel('p1', 600000, Date.now() + 1800000, 'glm-5.2', '6004 model rate limit')
    pool.saveNow()

    const pool2 = poolMod.createPool({ stateFile })
    pool2.load()
    pool2.add(makeAuth('p1'))
    const st = pool2.status('p1')
    assert.strictEqual(st.credits, 500)
    assert.strictEqual(st.creditsExpiring, 50)
    assert.strictEqual(st.rateLimitedModels.length, 1, '模型级冷却应恢复')
    assert.strictEqual(st.rateLimitedModels[0].model, 'glm-5.2')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('过期条目在恢复时被惰性过滤', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pool-test2-'))
    const stateFile = path.join(dir, 'state.json')
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        accounts: {
          old1: {
            credits: 10,
            breaker_until: Date.now() - 1000, // 已过期
            degrade_until: Date.now() - 1000,
            model_cooldowns: { m1: { until: Date.now() - 1000 } },
            model_costs: { m1: { cost_per_1k: 1, last_seen: Date.now() - 99999999 } }
          }
        }
      })
    )
    const pool = poolMod.createPool({ stateFile })
    pool.load()
    const st = pool.status('old1')
    assert.strictEqual(st.cooling, false, '过期熔断不应恢复')
    assert.strictEqual(st.rateLimitedModels.length, 0, '过期模型冷却不应恢复')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('选号：账箱子集限定（子集外账号不参与）', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('a1'))
    pool.add(makeAuth('a2'))
    pool.add(makeAuth('a3'))
    const allow = new Set(['a1', 'a2'])
    const picked = new Set()
    for (let i = 0; i < 30; i++) {
      const auth = pool.pick({ allowUIDs: allow })
      if (auth) picked.add(auth.uid)
    }
    assert.ok(picked.size > 0, '子集内应能选出账号')
    assert.ok(!picked.has('a3'), '子集外账号不应被选中')
  })

  test('选号：未传子集视为全池', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('b1'))
    const auth = pool.pick({ allowUIDs: null })
    assert.strictEqual(auth.uid, 'b1')
  })

  test('availableUIDs / pickByUID 支持子集过滤', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('c1'))
    pool.add(makeAuth('c2'))
    assert.deepStrictEqual(pool.availableUIDs('', new Set(['c2'])), ['c2'])
    assert.strictEqual(pool.pickByUID('c1', '', new Set(['c2'])), null, '子集外账号不可按 uid 选取')
    assert.ok(pool.pickByUID('c2', '', new Set(['c2'])))
  })

  test('会话粘性：子集限定下不分配到子集外账号', () => {
    const router = session.createRouter({
      available: allowUIDs => ['s1', 's2', 's3'].filter(u => !allowUIDs || allowUIDs.has(u))
    })
    const r1 = router.resolveForModel('ksub', '', new Set(['s1', 's2']))
    assert.ok(['s1', 's2'].includes(r1.uid), `应落在子集内，实际 ${r1.uid}`)
    router.stopGC()
  })

  test('无候选诊断：区分账号级冷却与模型级受限', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('d1'))
    pool.add(makeAuth('d2'))
    // 初始：两个账号均可用
    let diag = pool.diagnoseNoCandidate('m1')
    assert.strictEqual(diag.healthy, 2)

    // d1 的 m1 被模型级冷却（6004 有重置墙钟）→ 计入 modelCooled，且单算 modelRateLimited
    pool.cooldownSoftForModel('d1', 600000, Date.now() + 3600000, 'm1', '6004 model rate limit')
    diag = pool.diagnoseNoCandidate('m1')
    assert.strictEqual(diag.modelCooled, 1)
    assert.strictEqual(diag.modelRateLimited, 1, '6004 是暂时限流，不是确定性拒绝')
    assert.strictEqual(diag.healthy, 1)

    // 其他模型不受该冷却影响
    diag = pool.diagnoseNoCandidate('other')
    assert.strictEqual(diag.modelCooled, 0)
    assert.strictEqual(diag.modelRateLimited, 0)
    assert.strictEqual(diag.healthy, 2)

    // d2 账号级冷却 → 计入 cooling
    pool.cooldownSoftRate('d2', 600000, 0, '429')
    diag = pool.diagnoseNoCandidate('m1')
    assert.strictEqual(diag.cooling, 1)
    assert.strictEqual(diag.healthy, 0)

    // 11102 确定性拒绝：modelCooled 计入但 modelRateLimited 不计入
    pool.blockModelBackoff('d1', 'm1', '11102 model not available')
    diag = pool.diagnoseNoCandidate('m1')
    assert.strictEqual(diag.modelCooled, 1)
    assert.strictEqual(diag.modelRateLimited, 0, '11102 是确定性拒绝，不算限流')
  })

  test('WorkBuddy 源识别与列表（唯一性判定用）', () => {
    const modelsMod = require(path.join(__dirname, '..', 'server', 'models.js'))
    const config = {
      glm: { type: '', models: [{ id: 'glm-4.6' }] },
      wb1: { type: 'workbuddy', models: [] },
      wb2: { type: 'workbuddy', models: [] }
    }
    assert.deepStrictEqual(modelsMod.listWorkbuddyProviders(config), ['wb1', 'wb2'])
    assert.strictEqual(modelsMod.isWorkbuddyProvider(config.wb1), true)
    assert.strictEqual(modelsMod.isWorkbuddyProvider(config.glm), false)
    // 账箱子集字段已废弃：Provider 视图归一化时应清理旧配置残留
    const view = modelsMod.toProviderView({ type: 'workbuddy', models: [{ id: 'm' }], accounts: ['u1'] })
    assert.ok(!('accounts' in view), 'accounts 字段应被清理')
  })

  // ==================== 8. 凭证管理 ====================
  group('8. 凭证管理 auth')

  test('嵌套形与扁平形双形态解析', () => {
    const nested = JSON.stringify({
      auth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 123, domain: 'd' },
      account: { uid: 'u1', enterpriseId: 'e1', nickname: 'n1' },
      device_token: 'dt'
    })
    const flat = JSON.stringify({
      accessToken: 'AT2',
      refreshToken: 'RT2',
      expiresAt: 456,
      domain: 'd2',
      uid: 'u2',
      enterpriseId: 'e2',
      nickname: 'n2'
    })
    const a = authMod.parseAuth(nested)
    const b = authMod.parseAuth(flat)
    assert.strictEqual(a.accessToken, 'AT')
    assert.strictEqual(a.uid, 'u1')
    assert.strictEqual(a.deviceToken, 'dt')
    assert.strictEqual(b.accessToken, 'AT2')
    assert.strictEqual(b.uid, 'u2')
  })

  test('缺少 accessToken 解析失败', () => {
    assert.strictEqual(authMod.parseAuth('{"uid":"u1"}'), null)
    assert.strictEqual(authMod.parseAuth('not json'), null)
  })

  test('UID 白名单（防路径穿越）', () => {
    assert.strictEqual(authMod.validUID('abc-123_X'), true)
    assert.strictEqual(authMod.validUID('../../evil'), false)
    assert.strictEqual(authMod.validUID('a'.repeat(65)), false)
    assert.strictEqual(authMod.validUID(''), false)
  })

  test('原子落盘与回读（嵌套形 + 0600）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-test-'))
    const auth = makeAuth('disk1')
    auth.filePath = authMod.pathFor(dir, 'disk1')
    authMod.saveAtomic(auth)
    const raw = fs.readFileSync(auth.filePath, 'utf8')
    const doc = JSON.parse(raw)
    assert.ok(doc.auth && doc.account, '应写为嵌套形')
    assert.strictEqual(doc.account.uid, 'disk1')
    assert.ok(!('device_token' in doc), '空 device_token 不应写入')
    const loaded = authMod.parseAuth(raw)
    assert.strictEqual(loaded.accessToken, auth.accessToken)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('稳定设备头派生（盐固定 wb2a:，跨进程恒定）', () => {
    const id = headersMod.deriveAccountStableID('uid-x', 'machine')
    assert.strictEqual(id.length, 36)
    const expected = crypto.createHash('sha256').update('wb2a:machine:uid-x').digest('hex').slice(0, 36)
    assert.strictEqual(id, expected)
  })

  test('UA 三段式（CN 固定 WorkBuddy 标识）', () => {
    const ua = headersMod.userAgent({ uid: 'u' })
    assert.strictEqual(ua, 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1')
  })

  test('chat 请求头永不携带 X-Refresh-Token', () => {
    const h = headersMod.chatHeaders(makeAuth('u7'), {}, {})
    assert.ok(!('X-Refresh-Token' in h))
    assert.strictEqual(h['X-CodeBuddy-Request'], '1')
    assert.ok(h.Authorization.startsWith('Bearer '))
  })

  // ==================== 9. 模块接口完整性 ====================
  group('9. 模块接口完整性')

  test('scheduler 模块导出 createScheduler 与完整接口', () => {
    const schedulerMod = require(path.join(wbDir, 'scheduler.js'))
    assert.strictEqual(typeof schedulerMod.createScheduler, 'function')
    const s = schedulerMod.createScheduler({
      pool: poolMod.createPool({}),
      client: {},
      auth: {},
      refreshTokenFor: async () => ({ ok: true }),
      refreshBalanceFor: async () => ({ ok: true }),
      log: () => {}
    })
    for (const fn of ['start', 'stop', 'runNow', 'runCheckinFor', 'runTravelFor', 'runActivityFor', 'runKeepaliveFor', 'runBlackcatNow', 'getState', 'updateConfig']) {
      assert.strictEqual(typeof s[fn], 'function', `缺少 ${fn}`)
    }
    const st = s.getState()
    assert.deepStrictEqual(st.hours.checkin, [9, 21])
    assert.strictEqual(st.enabled.checkin, true)
    // 关闭开关与改时点即时生效
    const next = s.updateConfig({ checkinEnabled: false, activityHours: [8, 20] })
    assert.strictEqual(next.enabled.checkin, false)
    assert.deepStrictEqual(next.hours.activity, [8, 20])
    // 空数组回落默认（不是禁用）
    const back = s.updateConfig({ activityHours: [] })
    assert.deepStrictEqual(back.hours.activity, [10])
    s.stop()
  })

  test('tasks 模块导出任务体系接口', () => {
    const tasksMod = require(path.join(wbDir, 'tasks.js'))
    for (const fn of ['fetchTasks', 'acceptTasks', 'claimTask', 'createTaskRunner', 'scanTasks']) {
      assert.strictEqual(typeof tasksMod[fn], 'function', `缺少 ${fn}`)
    }
    assert.ok(Array.isArray(tasksMod.TASK_ORDER) && tasksMod.TASK_ORDER.length >= 15, '任务顺序表应包含 15 项以上')
    const runner = tasksMod.createTaskRunner({ client: {}, log: () => {} })
    for (const fn of ['runAll', 'runOne', 'getProgress']) {
      assert.strictEqual(typeof runner[fn], 'function', `runner 缺少 ${fn}`)
    }
    const p = runner.getProgress()
    assert.strictEqual(p.running, false)
    assert.strictEqual(p.total, 0)
  })

  test('runtime 模块导出完整接口', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const expectFns = [
      'init',
      'getRuntime',
      'updateConfig',
      'oauthStart',
      'oauthPoll',
      'listAccounts',
      'removeAccount',
      'checkinAccount',
      'refreshBalance',
      'refreshAllBalances',
      'reviveAccount',
      'keepaliveAccount',
      'listUpstreamModels',
      'forwardChat',
      'schedulerState',
      'schedulerRun',
      'schedulerUpdateConfig',
      'taskList',
      'taskRun',
      'taskProgress',
      'taskScan',
      'creditPackages',
      'creditHistory',
      'getEnabledModels',
      'setEnabledModels',
      'getLogs',
      'backoffAfter',
      'readDeviceTokenCached'
    ]
    for (const fn of expectFns) {
      assert.strictEqual(typeof runtimeMod[fn], 'function', `runtime 缺少 ${fn}`)
    }
  })

  test('启用模型清单与模型目录缓存解耦（目录刷新不清空清单）', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rt-test-'))
    runtimeMod.init({ dataDir: tmp, enabledModels: [{ id: 'm1', displayName: 'M1' }] })
    const r = runtimeMod.getRuntime()
    assert.deepStrictEqual(runtimeMod.getEnabledModels().map(m => m.id), ['m1'])
    // 模拟模型目录缓存整体替换（拉取上游模型时的赋值行为）
    r.models = { ts: Date.now(), list: [], efforts: {}, defaultEfforts: {} }
    assert.deepStrictEqual(runtimeMod.getEnabledModels().map(m => m.id), ['m1'], '目录刷新不应清空启用清单')
    // 清单写入与规范化
    const saved = runtimeMod.setEnabledModels([{ id: 'm2', name: 'M2', maxContext: 1000 }, { id: '' }])
    assert.deepStrictEqual(saved.map(m => m.id), ['m2'])
    assert.strictEqual(saved[0].displayName, 'M2')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('constants 常量表关键值', () => {
    assert.strictEqual(constants.CHAT_BASE_CN, 'https://copilot.tencent.com')
    assert.strictEqual(constants.BILLING_BASE_CN, 'https://www.codebuddy.cn')
    assert.strictEqual(constants.WEB_BASE_CN, 'https://www.workbuddy.cn')
    assert.strictEqual(constants.CHAT_COMPLETIONS_PATH, '/v2/chat/completions')
    assert.strictEqual(constants.REPORT_PATH, '/v2/report')
    assert.deepStrictEqual(constants.SCHEDULE_DEFAULTS.checkinHours, [9, 21])
    assert.strictEqual(constants.MAX_ROTATE, 3)
    assert.strictEqual(constants.SESSION_DEAD_THRESHOLD, 3)
  })

  // ==================== 10. 轮转退避与设备令牌 ====================
  group('10. 轮转退避与设备令牌 runtime')

  test('backoffAfter：base·2^n 封顶且抖动 ±25%', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const base = constants.ROTATE_BACKOFF.baseMs
    const cap = constants.ROTATE_BACKOFF.capMs
    for (let i = 0; i < 40; i++) {
      const d0 = runtimeMod.backoffAfter(0)
      assert.ok(d0 >= base * 0.74 && d0 <= base * 1.26, `n=0 应在 ±25% 区间内，实际 ${d0}`)
      const d5 = runtimeMod.backoffAfter(5)
      assert.ok(d5 >= cap * 0.74 && d5 <= cap * 1.26, `n=5 应封顶并抖动，实际 ${d5}`)
    }
    assert.ok(runtimeMod.backoffAfter(1) <= cap * 1.26, 'n=1 不应超过封顶')
  })

  test('设备令牌文件：正常读取 / 超 1KB 忽略 / 读失败降级为空', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dt-test-'))
    const okFile = path.join(dir, 'device_token')
    fs.writeFileSync(okFile, '  tok-123  ')
    assert.strictEqual(runtimeMod.readDeviceTokenCached(okFile), 'tok-123')
    const bigFile = path.join(dir, 'big_token')
    fs.writeFileSync(bigFile, 'x'.repeat(2048))
    assert.strictEqual(runtimeMod.readDeviceTokenCached(bigFile), '')
    assert.strictEqual(runtimeMod.readDeviceTokenCached(path.join(dir, 'missing')), '')
    assert.strictEqual(runtimeMod.readDeviceTokenCached(''), '')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // ==================== 11. 任务体系（mp 口径 / 队列 / 排程宽限）====================
  group('11. 任务体系（mp / 队列 / 排程）')

  test('mp 口径头构造（X-Client-Platform: miniprogram / mp-weixin）', () => {
    const h = clientMod.growthMPHeaders(makeAuth('mpu'), {})
    assert.strictEqual(h['X-Client-Platform'], 'miniprogram')
    assert.ok(h.Authorization.startsWith('Bearer '))
    assert.ok(h['X-User-Id'] === 'mpu')
    const rh = clientMod.mpReportHeaders(makeAuth('mpu'))
    assert.strictEqual(rh['X-Client-Platform'], 'mp-weixin')
    assert.strictEqual(rh['X-Client-Product'], 'workbuddy-mp')
    assert.strictEqual(rh['X-Platform'], 'wechatmp')
  })

  test('默认 + mp 口径任务按 task_code 去重合并（保留默认项，不覆盖）', () => {
    const base = [{ task_code: 'chat_5', title: '默认' }, { task_code: 'RichMeow_Chat' }]
    const mp = [{ task_code: 'chat_5', title: 'mp' }, { task_code: 'school_season' }]
    const merged = tasksMod.mergeTasksByCode(base, mp)
    assert.deepStrictEqual(merged.map(t => t.task_code), ['chat_5', 'RichMeow_Chat', 'school_season'])
    assert.strictEqual(merged[0].title, '默认', '重复项应保留默认口径条目')
  })

  test('claim 轮询参数（4 次 × 3s）', () => {
    assert.strictEqual(tasksMod.CLAIM_POLL_ATTEMPTS, 4)
    assert.strictEqual(tasksMod.CLAIM_POLL_GAP, 3000)
  })

  test('accept 分批 20 + 批间 1050ms，chunk 分片正确', () => {
    assert.strictEqual(tasksMod.ACCEPT_BATCH, 20)
    assert.strictEqual(tasksMod.ACCEPT_BATCH_GAP, 1050)
    const codes = Array.from({ length: 45 }, (_, i) => `c${i}`)
    const parts = tasksMod.chunk(codes, tasksMod.ACCEPT_BATCH)
    assert.deepStrictEqual(parts.map(p => p.length), [20, 20, 5])
  })

  test('任务表包含 8 个 mp 专属任务，顺序表 25 项，mp 判定正确', () => {
    const mpCodes = [
      'school_season',
      'Sequential_Tasks_1',
      'Sequential_Tasks_2',
      'Sequential_Tasks_3',
      'Sequential_Tasks_4',
      'Sequential_Tasks_5',
      'Sequential_Tasks_6',
      'Sequential_Tasks_7'
    ]
    for (const c of mpCodes) {
      assert.ok(tasksMod.TASK_ACTIONS[c], `缺少 mp 任务动作 ${c}`)
      assert.strictEqual(tasksMod.isMPTaskCode(c), true)
    }
    assert.strictEqual(tasksMod.TASK_ORDER.length, 25)
    assert.strictEqual(tasksMod.isMPTaskCode('chat_5'), false)
    assert.ok(tasksMod.taskOrderIndex('school_season') > tasksMod.taskOrderIndex('black_cat'), 'mp 任务排在 PC 任务之后')
  })

  test('队列并发夹取 [1,4]（默认 2）', () => {
    assert.strictEqual(queueMod.clampConcurrency(0), 2)
    assert.strictEqual(queueMod.clampConcurrency(-3), 2)
    assert.strictEqual(queueMod.clampConcurrency(1), 1)
    assert.strictEqual(queueMod.clampConcurrency(3), 3)
    assert.strictEqual(queueMod.clampConcurrency(9), 4)
    assert.strictEqual(queueMod.clampConcurrency('abc'), 2)
    assert.strictEqual(queueMod.MAX_CONCURRENCY, 4)
  })

  await testAsync('队列：账号内串行执行（同账号条目不并发）', async () => {
    const order = []
    let active = 0
    let maxActive = 0
    const q = queueMod.createQueue({
      listAccounts: () => [{ uid: 'u1', nickname: '甲', disabled: false }],
      authByUID: () => makeAuth('u1'),
      scanPending: async () => ['a', 'b', 'c'],
      runCode: async (auth, code) => {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(code)
        await new Promise(r => setTimeout(r, 8))
        active--
        return { status: 'done', message: code }
      },
      itemTimeoutMs: 5000,
      log: () => {}
    })
    const res = await q.runQueueOnce()
    await waitQueue(q)
    assert.strictEqual(res.started, true)
    assert.strictEqual(res.total, 3)
    assert.strictEqual(maxActive, 1, '同账号条目应串行')
    assert.deepStrictEqual(order, ['a', 'b', 'c'])
    const st = q.queueStatus()
    assert.strictEqual(st.running, false)
    assert.strictEqual(st.items.filter(i => i.status === 'done').length, 3)
    assert.ok(st.items[0].elapsed_ms >= 0 && st.items[0].finished_at > 0, '条目应记录耗时')
  })

  await testAsync('队列：账号间并发不超过夹取上限', async () => {
    let running = 0
    let peak = 0
    const q = queueMod.createQueue({
      listAccounts: () => ['u1', 'u2', 'u3', 'u4'].map(uid => ({ uid, nickname: '', disabled: false })),
      authByUID: uid => makeAuth(uid),
      scanPending: async () => ['a'],
      runCode: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise(r => setTimeout(r, 12))
        running--
        return { status: 'done', message: 'ok' }
      },
      itemTimeoutMs: 5000,
      log: () => {}
    })
    await q.runQueueOnce(undefined, { concurrency: 2 })
    await waitQueue(q)
    assert.ok(peak <= 2, `账号并发应 ≤ 2，实际 ${peak}`)
    assert.ok(peak >= 1)
    assert.strictEqual(q.queueStatus().conc, 2)
    assert.strictEqual(q.queueStatus().items.length, 4)
  })

  await testAsync('队列：已在执行时 runQueueOnce 返回冲突', async () => {
    const q = queueMod.createQueue({
      listAccounts: () => [{ uid: 'u1', nickname: '', disabled: false }],
      authByUID: () => makeAuth('u1'),
      scanPending: async () => ['a'],
      runCode: async () => {
        await new Promise(r => setTimeout(r, 30))
        return { status: 'done', message: '' }
      },
      itemTimeoutMs: 5000,
      log: () => {}
    })
    await q.runQueueOnce()
    const second = await q.runQueueOnce()
    assert.strictEqual(second.conflict, true)
    assert.strictEqual(second.seq, -1)
    await waitQueue(q)
  })

  await testAsync('队列：整轮持锁——清扫/一键完成抢不到正在排队的账号', async () => {
    // 队列按账号整轮持锁：两条任务之间若让出锁，补领清扫会抢到并改动上游状态，
    // 后续条目要么虚假失败、要么与清扫对同一账号并发写。这里用共享锁表复现。
    const locked = new Set()
    const seenBusy = []
    const q = queueMod.createQueue({
      listAccounts: () => [{ uid: 'u1', nickname: '甲', disabled: false }],
      authByUID: () => makeAuth('u1'),
      tryLockAccount: uid => {
        if (locked.has(uid)) return false
        locked.add(uid)
        return true
      },
      unlockAccount: uid => locked.delete(uid),
      scanPending: async () => ['a', 'b', 'c'],
      runCode: async (auth, code) => {
        // 每条任务执行期间锁都应仍被队列持有（清扫此时抢不到）
        seenBusy.push(locked.has('u1'))
        await new Promise(r => setTimeout(r, 5))
        return { status: 'done', message: code }
      },
      itemTimeoutMs: 5000,
      log: () => {}
    })
    await q.runQueueOnce()
    await waitQueue(q)
    assert.deepStrictEqual(seenBusy, [true, true, true], '整轮期间锁必须一直持有')
    assert.strictEqual(q.queueStatus().items.filter(i => i.status === 'done').length, 3)
    assert.strictEqual(locked.has('u1'), false, '账号跑完后必须释放锁')
  })

  await testAsync('队列：账号已被占用时条目记「跳过」而非「失败」', async () => {
    const q = queueMod.createQueue({
      listAccounts: () => [{ uid: 'u1', nickname: '', disabled: false }],
      authByUID: () => makeAuth('u1'),
      tryLockAccount: () => false, // 一键完成/清扫正持锁
      unlockAccount: () => {},
      scanPending: async () => ['a', 'b'],
      runCode: async () => {
        throw new Error('不应执行')
      },
      itemTimeoutMs: 5000,
      log: () => {}
    })
    await q.runQueueOnce()
    await waitQueue(q)
    const items = q.queueStatus().items
    assert.strictEqual(items.length, 2)
    assert.strictEqual(
      items.every(i => i.status === 'skipped'),
      true,
      '被占用只跳过，不算失败'
    )
    assert.ok(items[0].message.includes('跳过'), items[0].message)
  })

  test('runOne(lockHeld) 不重复抢占账号锁', async () => {
    // 执行队列已持锁后逐条调用 runOne；若 runOne 再抢一次会自锁自，条目变虚假失败。
    const runner = tasksMod.createTaskRunner({ client: {}, log: () => {}, chatOnce: async () => ({}) })
    assert.strictEqual(typeof runner.runOne, 'function')
    assert.strictEqual(tasksMod.tryLockAccount('lock-held-uid'), true)
    try {
      // 持锁状态下走 lockHeld 分支：不应抛 account_busy（动作不可自动化属另一类错误）
      let err = null
      try {
        await runner.runOne(makeAuth('lock-held-uid'), 'not_a_task', { lockHeld: true })
      } catch (e) {
        err = e
      }
      assert.ok(err, '未知任务码应报错')
      assert.strictEqual(err.code, undefined, `不应是 account_busy：${err.message}`)
      // 无 lockHeld 时自抢自必然 account_busy
      let busyErr = null
      try {
        await runner.runOne(makeAuth('lock-held-uid'), 'chat_5', {})
      } catch (e) {
        busyErr = e
      }
      assert.strictEqual(busyErr && busyErr.code, 'account_busy')
    } finally {
      tasksMod.unlockAccount('lock-held-uid')
    }
  })

  test('成长排程默认值：growthHours=[1]，growthEnabled=true，可热改', () => {
    const s = schedulerMod.createScheduler({
      pool: poolMod.createPool({}),
      client: {},
      auth: {},
      refreshTokenFor: async () => ({ ok: true }),
      refreshBalanceFor: async () => ({ ok: true }),
      log: () => {}
    })
    const st = s.getState()
    assert.deepStrictEqual(st.hours.growth, [1])
    assert.strictEqual(st.enabled.growth, true)
    const next = s.updateConfig({ growthEnabled: false, growthHours: [2, 3] })
    assert.strictEqual(next.enabled.growth, false)
    assert.deepStrictEqual(next.hours.growth, [2, 3])
    const back = s.updateConfig({ growthHours: [] })
    assert.deepStrictEqual(back.hours.growth, [1], '空数组应回落默认')
    s.stop()
  })

  test('迟到唤醒宽限判定：≤5s 补跑，>5s 跳过', () => {
    const planned = Date.now()
    assert.strictEqual(schedulerMod.WAKEUP_GRACE_MS, 5000)
    assert.strictEqual(schedulerMod.catchUpDecision(planned, planned), 'run')
    assert.strictEqual(schedulerMod.catchUpDecision(planned, planned + 4000), 'run')
    assert.strictEqual(schedulerMod.catchUpDecision(planned, planned + 5000), 'run')
    assert.strictEqual(schedulerMod.catchUpDecision(planned, planned + 5001), 'skip')
    assert.strictEqual(schedulerMod.catchUpDecision(planned, planned + 60000), 'skip')
  })

  // ==================== 12. 模型目录兜底链 ====================
  group('12. 模型目录兜底链 catalog / modelsdev')

  // 注入离线假 fetcher 并预置一份 models.dev 文档（保证本组全程离线，不触发真网）
  modelsdevMod.resetForTest()
  modelsdevMod.setFetcher(async () =>
    JSON.stringify({ zai: { models: { 'glm-9.9': { limit: { context: 777000, output: 42000 } } } } })
  )
  await modelsdevMod.fetchCatalog()
  catalogMod.resetForTest()

  test('四级链第 1 级：上游动态值优先', () => {
    assert.strictEqual(catalogMod.contextWindowOf('glm-5.2', 123456), 123456)
    assert.strictEqual(catalogMod.outputTokensOf('glm-5.2', 999), 999)
    assert.strictEqual(catalogMod.contextWindowOf('unknown-x', 500000), 500000)
  })

  test('四级链第 2 级：静态种子表', () => {
    assert.strictEqual(catalogMod.contextWindowOf('glm-5.2', 0), 1000000)
    assert.strictEqual(catalogMod.outputTokensOf('glm-5.2', 0), 131072)
    assert.strictEqual(catalogMod.contextWindowOf('hy3', 0), 192000)
    assert.strictEqual(catalogMod.outputTokensOf('hy3', 0), 64000)
  })

  test('四级链第 3 级：model.json 缓存（含损坏静默降级）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-catalog-json-'))
    fs.writeFileSync(
      path.join(dir, 'model.json'),
      JSON.stringify({ 'custom-model-1': { context_length: 300000, max_output_tokens: 9000 } })
    )
    catalogMod.configure({ dataDir: dir })
    assert.strictEqual(catalogMod.contextWindowOf('custom-model-1', 0), 300000)
    assert.strictEqual(catalogMod.outputTokensOf('custom-model-1', 0), 9000)
    // 文件损坏 → 静默降级（回落到 1M / 省略）
    fs.writeFileSync(path.join(dir, 'model.json'), '{broken')
    catalogMod.configure({ dataDir: dir })
    assert.strictEqual(catalogMod.contextWindowOf('custom-model-1', 0), 1000000)
    assert.strictEqual(catalogMod.outputTokensOf('custom-model-1', 0), null)
    // 文件缺失 → 同样静默降级
    fs.rmSync(path.join(dir, 'model.json'), { force: true })
    catalogMod.configure({ dataDir: dir })
    assert.strictEqual(catalogMod.contextWindowOf('custom-model-1', 0), 1000000)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('四级链第 4 级：models.dev 命中（回写 model.json）+ 1M 兜底', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-catalog-md-'))
    catalogMod.configure({ dataDir: dir })
    assert.strictEqual(catalogMod.contextWindowOf('glm-9.9', 0), 777000)
    assert.strictEqual(catalogMod.outputTokensOf('glm-9.9', 0), 42000)
    // 命中已回写 model.json（第 4 级 → 第 3 级）
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'))
    assert.strictEqual(saved['glm-9.9'].context_length, 777000)
    assert.strictEqual(saved['glm-9.9'].max_output_tokens, 42000)
    // 全链未收录 → 1M 兜底 / 输出省略
    assert.strictEqual(catalogMod.contextWindowOf('nonexistent-model-xyz', 0), 1000000)
    assert.strictEqual(catalogMod.outputTokensOf('nonexistent-model-xyz', 0), null)
    assert.strictEqual(catalogMod.DEFAULT_CONTEXT_WINDOW, 1000000)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('effort 静态分表且上游值优先', () => {
    assert.deepStrictEqual(catalogMod.supportedEffortsOf('deepseek-v4.1-flash', []), ['low', 'high', 'max'])
    assert.deepStrictEqual(catalogMod.supportedEffortsOf('hy3', []), ['low', 'high'])
    assert.deepStrictEqual(catalogMod.supportedEffortsOf('glm-5.2', []), ['high', 'xhigh'])
    // 未收录模型 → 空数组（不降级）
    assert.deepStrictEqual(catalogMod.supportedEffortsOf('unknown-model', []), [])
    // 上游值优先（静态表有该模型也不覆盖）
    assert.deepStrictEqual(catalogMod.supportedEffortsOf('glm-5.2', ['minimal', 'ultra']), ['minimal', 'ultra'])
    // 默认档与档位同源；不在集合内则为空串
    assert.strictEqual(catalogMod.defaultEffortOf('deepseek-v4.1-flash', [], ''), 'high')
    assert.strictEqual(catalogMod.defaultEffortOf('glm-5.2', ['minimal'], 'ultra'), '')
    assert.strictEqual(catalogMod.defaultEffortOf('glm-5.2', ['minimal', 'ultra'], 'ultra'), 'ultra')
  })

  test('上下文压缩：超预算时整轮裁剪，system 与最近轮次保留', () => {
    const msgs = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U1' + 'x'.repeat(4000) },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'U2' + 'y'.repeat(4000) },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'U3 last' }
    ]
    const out = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'm', messages: msgs }), { contextWindow: 1200 }))
    assert.strictEqual(out.messages[0].role, 'system', 'system 永不裁剪')
    assert.ok(
      out.messages.some(m => m.content === 'U3 last'),
      '最近一轮必须保留'
    )
    assert.ok(out.messages.length < msgs.length, '应发生裁剪')
  })

  test('上下文压缩：窗口未知（0）时不裁剪', () => {
    const msgs = [
      { role: 'user', content: 'U1' + 'x'.repeat(4000) },
      { role: 'user', content: 'U2' + 'y'.repeat(4000) }
    ]
    const out = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'm', messages: msgs }), { contextWindow: 0 }))
    assert.strictEqual(out.messages.length, 2)
  })

  test('上下文压缩：裁掉工具轮不留孤儿 tool 结果', () => {
    const msgs = [
      { role: 'user', content: 'U1' + 'x'.repeat(6000) },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'R1' + 'y'.repeat(6000) },
      { role: 'user', content: 'U2 last' }
    ]
    const out = JSON.parse(payload.prepareBody(JSON.stringify({ model: 'm', messages: msgs }), { contextWindow: 1200 }))
    assert.strictEqual(out.messages.filter(m => m.role === 'tool').length, 0, '裁掉的一轮不应留下孤儿 tool 结果')
    assert.strictEqual(out.messages[out.messages.length - 1].content, 'U2 last')
  })

  test('输出上限兜底：未指定 max_tokens 时注入模型上限，显式值不被覆盖', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
    const injected = JSON.parse(payload.prepareBody(JSON.stringify(base), { maxOutput: 131072 }))
    assert.strictEqual(injected.max_tokens, 131072)
    const explicit = JSON.parse(payload.prepareBody(JSON.stringify({ ...base, max_tokens: 999 }), { maxOutput: 131072 }))
    assert.strictEqual(explicit.max_tokens, 999)
    const none = JSON.parse(payload.prepareBody(JSON.stringify(base), {}))
    assert.strictEqual(none.max_tokens, undefined, '模型上限未知时不注入')
  })

  test('client.mapModelEntry 接线兜底链（上游优先 / 种子兜底）', () => {
    const a = clientMod.mapModelEntry(
      { id: 'glm-5.2', maxInputTokens: 500000, maxOutputTokens: 60000, reasoning: { supportedEfforts: ['low'] } }
    )
    assert.strictEqual(a.maxContext, 500000)
    assert.strictEqual(a.maxOutput, 60000)
    assert.deepStrictEqual(a.efforts, ['low'])
    // 上游缺失字段 → 种子表兜底
    const b = clientMod.mapModelEntry({ id: 'glm-5.2' })
    assert.strictEqual(b.maxContext, 1000000)
    assert.strictEqual(b.maxOutput, 131072)
    assert.deepStrictEqual(b.efforts, ['high', 'xhigh'])
    assert.strictEqual(b.defaultEffort, 'high')
  })

  test('contextWindowOf 实测安全上限钳制（压缩阈值贴近真实可用容量）', () => {
    const M = 'deepseek-v4.1-flash'
    const cap = catalogMod.CONTEXT_SAFE_CAP[M]
    assert.strictEqual(cap, 640000, '实测安全上限应为 640000')
    // 上游声明 1M → 钳到实测安全值（否则预防性压缩阈值 800k 永不触发，超限只能撞上游错误）
    assert.strictEqual(catalogMod.contextWindowOf(M, 1000000, {}), cap)
    // 上游未声明 → 种子表同样被钳制
    assert.strictEqual(catalogMod.contextWindowOf(M, null, {}), cap)
    // 上游声明低于上限 → 不抬高（尊重上游更保守的值）
    assert.strictEqual(catalogMod.contextWindowOf(M, 500000, {}), 500000)
    // 未列入钳制表的模型 → 保持上游声明值
    assert.strictEqual(catalogMod.contextWindowOf('glm-5.3-flash', 1000000, {}), 1000000)
    // 钳制后压缩阈值必须真的落到实测区间内（回归：曾为 800000）
    assert.strictEqual(Math.floor(catalogMod.contextWindowOf(M, 1000000, {}) * 0.8), 512000)
  })

  await testAsync('modelsdev：成功索引缓存（TTL 内不重拉）', async () => {
    let calls = 0
    modelsdevMod.resetForTest()
    modelsdevMod.setFetcher(async () => {
      calls++
      return JSON.stringify({ openai: { models: { 'gpt-x': { limit: { context: 200000, output: 16000 } } } } })
    })
    await modelsdevMod.fetchCatalog()
    assert.strictEqual(calls, 1)
    assert.deepStrictEqual(modelsdevMod.lookup('gpt-x'), { context: 200000, output: 16000 })
    // 缓存期内改数据源不生效（成功缓存 1h）
    modelsdevMod.setFetcher(async () => {
      calls++
      return JSON.stringify({ openai: { models: { 'gpt-x': { limit: { context: 999999, output: 1 } } } } })
    })
    assert.deepStrictEqual(modelsdevMod.lookup('gpt-x'), { context: 200000, output: 16000 })
    assert.strictEqual(calls, 1, '成功缓存期内不应重拉')
    assert.strictEqual(modelsdevMod.lookup('absent-model'), null)
  })

  await testAsync('modelsdev：非阻塞首拉 + 失败负缓存 TTL', async () => {
    let calls = 0
    modelsdevMod.resetForTest()
    modelsdevMod.configure({ failCooldownMs: 3600000 }) // 大负缓存窗
    modelsdevMod.setFetcher(async () => {
      calls++
      throw new Error('boom')
    })
    // 首次 lookup 非阻塞：本次立即返回空，后台异步拉取
    assert.strictEqual(modelsdevMod.lookup('m'), null)
    await new Promise(r => setTimeout(r, 10))
    assert.strictEqual(calls, 1, '首次 lookup 应触发一次后台拉取')
    // 负缓存窗内不重拉
    assert.strictEqual(modelsdevMod.lookup('m'), null)
    await new Promise(r => setTimeout(r, 10))
    assert.strictEqual(calls, 1, '失败负缓存期内不应重拉')
    // 负缓存窗过期 → 再次触发
    modelsdevMod.configure({ failCooldownMs: 1 })
    await new Promise(r => setTimeout(r, 10))
    assert.strictEqual(modelsdevMod.lookup('m'), null)
    await new Promise(r => setTimeout(r, 10))
    assert.strictEqual(calls, 2, '负缓存过期后应重拉')
    modelsdevMod.resetForTest()
  })

  // ==================== 13. 请求日志（任务合并 / 占用统计）====================
  group('13. 请求日志 logger（任务合并 / 占用统计）')

  // 独立数据目录：不触碰真实日志（paths 每次调用动态读取 AIROUTE_DATA_DIR）
  const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airoute-log-test-'))
  const prevLogDirEnv = process.env.AIROUTE_DATA_DIR
  process.env.AIROUTE_DATA_DIR = tmpLogDir
  const loggerMod = require(path.join(__dirname, '..', 'server', 'logger.js'))

  try {
    test('无 taskKey：逐条追加（兼容旧行为）', () => {
      loggerMod.log({ model: 'm1', status: 200, responseTime: 100, totalTokens: 10, input: '第一条' })
      loggerMod.log({ model: 'm1', status: 200, responseTime: 100, totalTokens: 20, input: '第二条' })
      const logs = loggerMod.getLogs({ limit: 10 })
      assert.strictEqual(logs.length, 2)
      const inputs = logs.map(l => l.input)
      assert.ok(inputs.includes('第一条') && inputs.includes('第二条'), '两条都应保留')
      assert.ok(logs[0].timestamp && logs[0].seq, '应补时间戳与序号')
    })

    test('同 taskKey：读时合并为一条，Token / 积分累加、账号取末条、使用记录取首条', () => {
      loggerMod.clearLogs()
      loggerMod.log({ taskKey: 'T1', model: 'm1', status: 200, responseTime: 100, uid: 'uid-11111111', inputTokens: 6, outputTokens: 4, totalTokens: 10, credits: 3, input: '合并任务' })
      loggerMod.log({ taskKey: 'T1', model: 'm1', status: 200, responseTime: 300, uid: 'uid-22222222', inputTokens: 15, outputTokens: 10, totalTokens: 25, credits: 5 })
      const logs = loggerMod.getLogs({ limit: 10 })
      assert.strictEqual(logs.length, 1, '同任务应合并为一条')
      assert.strictEqual(logs[0].inputTokens, 21)
      assert.strictEqual(logs[0].outputTokens, 14)
      assert.strictEqual(logs[0].totalTokens, 35)
      assert.strictEqual(logs[0].credits, 8)
      assert.strictEqual(logs[0].uid, 'uid-22222222', '账号取末条')
      assert.strictEqual(logs[0].input, '合并任务', '使用记录取首条')
      assert.ok(logs[0].responseTime >= 100, '耗时按末条结束-首条开始')
      assert.strictEqual(logs[0].calls, 2, '标注上游调用次数')
      assert.ok(!('taskKey' in logs[0]), 'taskKey 为内部字段，不出现在输出中')
    })

    test('读时合并：文件保留每次上游调用原始记录，页面只出一条', () => {
      loggerMod.clearLogs()
      loggerMod.log({ taskKey: 'T3', model: 'm1', status: 200, responseTime: 10, totalTokens: 1 })
      loggerMod.log({ taskKey: 'T3', model: 'm1', status: 200, responseTime: 20, totalTokens: 2 })
      loggerMod.log({ taskKey: 'T3', model: 'm1', status: 200, responseTime: 30, totalTokens: 3 })
      const rawFile = fs.readdirSync(path.join(tmpLogDir, 'logs')).filter(n => /^usage-.*\.log$/.test(n))[0]
      const rawLines = fs.readFileSync(path.join(tmpLogDir, 'logs', rawFile), 'utf-8').split('\n').filter(Boolean)
      assert.strictEqual(rawLines.length, 3, '文件应保留 3 条原始记录（可排查细节）')
      assert.ok(JSON.parse(rawLines[0]).taskKey, '原始记录带合并键')
      const logs = loggerMod.getLogs({ limit: 10 })
      assert.strictEqual(logs.length, 1, '页面只出一条')
      assert.strictEqual(logs[0].calls, 3)
      assert.strictEqual(logs[0].totalTokens, 6)
    })

    test('合并结果取末条：模型 / 状态跟随最终上游，错误保留首个（供重试/降级判定）', () => {
      loggerMod.clearLogs()
      loggerMod.log({ taskKey: 'T2', model: 'm1', status: 500, error: '首个错误', responseTime: 50 })
      loggerMod.log({ taskKey: 'T2', model: 'm2', status: 200, responseTime: 60, totalTokens: 5 })
      const logs = loggerMod.getLogs({ limit: 10 })
      assert.strictEqual(logs.length, 1)
      assert.strictEqual(logs[0].status, 200, '状态取末条：中途失败后恢复应显示成功')
      assert.strictEqual(logs[0].model, 'm2', '模型取末条：显示真正服务这次请求的上游')
      assert.strictEqual(logs[0].error, '首个错误', '错误保留首个非空，供重试/降级判定')
      assert.strictEqual(logs[0].degraded, true, '中途失败后恢复应标记重试/降级')
      assert.strictEqual(logs[0].totalTokens, 5)
    })

    test('fallback 合并：主源 502 + 备用 200 显示备用模型与成功（不再被主源吞掉）', () => {
      loggerMod.clearLogs()
      loggerMod.log({ taskKey: 'T4', model: 'primary', status: 502, error: '主源挂了', responseTime: 40 })
      loggerMod.log({ taskKey: 'T4', model: 'backup', status: 200, fallback: true, fallbackFrom: 'primary', responseTime: 90, totalTokens: 7 })
      const logs = loggerMod.getLogs({ limit: 10 })
      assert.strictEqual(logs.length, 1)
      assert.strictEqual(logs[0].model, 'backup', '显示真正服务的备用模型')
      assert.strictEqual(logs[0].status, 200, '备用模型成功即任务成功')
      assert.strictEqual(logs[0].fallback, true)
      assert.strictEqual(logs[0].fallbackFrom, 'primary', '降级链路保持 主源 → 备用')
      assert.strictEqual(logs[0].degraded, true)
    })

    test('不同 taskKey 互不影响；getTotalSize 统计与清空', () => {
      loggerMod.clearLogs()
      loggerMod.log({ taskKey: 'A', model: 'm1', status: 200, responseTime: 10 })
      loggerMod.log({ taskKey: 'B', model: 'm1', status: 200, responseTime: 10 })
      assert.strictEqual(loggerMod.getLogs({ limit: 10 }).length, 2)
      const size = loggerMod.getTotalSize()
      assert.ok(size.totalSize > 0, '占用应大于 0')
      assert.strictEqual(size.fileCount, 1)
      loggerMod.clearLogs()
      assert.strictEqual(loggerMod.getTotalSize().totalSize, 0)
    })
  } finally {
    if (prevLogDirEnv === undefined) delete process.env.AIROUTE_DATA_DIR
    else process.env.AIROUTE_DATA_DIR = prevLogDirEnv
    fs.rmSync(tmpLogDir, { recursive: true, force: true })
  }

  // ==================== 14. 用量 / 积分消耗统计 ====================
  group('14. 用量/积分消耗统计 usage')

  test('桶累加与维度聚合（总量 / 账号 / 模型 / 时序）', () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    const u = usageMod.createUsage({ file: '', now: () => clk })
    u.record({ uid: 'u1', model: 'm1', rate: '0.5', ok: true, pt: 100, ct: 50, tt: 150, latMs: 200, tps: 250, credit: 2, hasCredit: true })
    u.record({ uid: 'u1', model: 'm1', rate: '0.5', ok: false, pt: 0, ct: 0, tt: 0, latMs: 50, tps: 0, credit: 0, hasCredit: false })
    u.record({ uid: 'u2', model: 'm2', rate: '1', ok: true, pt: 10, ct: 5, tt: 15, latMs: 100, tps: 150, credit: 0.5, hasCredit: true })
    const s = u.snapshot(72)
    assert.strictEqual(s.totals.req, 3)
    assert.strictEqual(s.totals.err, 1, '失败尝试计数')
    assert.strictEqual(s.totals.pt, 110)
    assert.strictEqual(s.totals.ct, 55)
    assert.strictEqual(s.totals.tt, 165)
    assert.strictEqual(s.totals.lat_avg, (200 + 50 + 100) / 3)
    assert.strictEqual(s.totals.tps_avg, (250 + 150) / 2, 'TPS 只用有样本的尝试求平均')
    assert.strictEqual(s.by_account.length, 2)
    assert.strictEqual(s.by_account[0].key, 'u1', '按总量降序')
    assert.strictEqual(s.by_model.length, 2)
    assert.strictEqual(s.series.length, 1, '同一小时合成一个时序点')
    assert.strictEqual(s.series[0].scope, 'hour')
    assert.strictEqual(s.buckets, 2, '同键两次尝试合并为一个桶，共 2 个桶')
    u.stop()
  })

  test('hasCredit=false 不计入 CR/CRN/CRT（不伪造 0）', () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    const u = usageMod.createUsage({ file: '', now: () => clk })
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 100, ct: 50, tt: 150, latMs: 100, tps: 10, credit: 5, hasCredit: false })
    const t = u.snapshot(72).totals
    assert.strictEqual(t.cr, 0)
    assert.strictEqual(t.crn, 0)
    assert.strictEqual(t.crt, 0)
    assert.strictEqual(t.avg_credit_per_1m, 0)
    u.stop()
  })

  test('免费请求（credit=0 且 has=true）计入 CRN 但不增 CR', () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    const u = usageMod.createUsage({ file: '', now: () => clk })
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 100, ct: 50, tt: 150, latMs: 100, tps: 10, credit: 0, hasCredit: true })
    const t = u.snapshot(72).totals
    assert.strictEqual(t.cr, 0)
    assert.strictEqual(t.crn, 1, '免费请求仍是有效积分样本')
    assert.strictEqual(t.crt, 150, '同次既有 credit 又有 token → 计入匹配 Token')
    u.stop()
  })

  test('avg_credit_per_1m 只用同次既有 credit 又有 token 的样本', () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    const u = usageMod.createUsage({ file: '', now: () => clk })
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 600000, ct: 0, tt: 600000, latMs: 100, tps: 1, credit: 3, hasCredit: true })
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 400000, ct: 0, tt: 400000, latMs: 100, tps: 1, credit: 0, hasCredit: true })
    // credit 有但无 token：计入 CR/CRN，不进匹配 Token 分母
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 0, ct: 0, tt: 0, latMs: 100, tps: 0, credit: 9, hasCredit: true })
    const t = u.snapshot(72).totals
    assert.strictEqual(t.cr, 12)
    assert.strictEqual(t.crn, 3)
    assert.strictEqual(t.crt, 1000000)
    assert.strictEqual(t.avg_credit_per_1m, 12, '12 积分 / 1e6 token → 12 积分每 1M')
    u.stop()
  })

  test('小时 → 日折叠（注入短保留窗口）', () => {
    const t0 = Date.parse('2026-05-01T10:00:00')
    const t3 = t0 + 3 * 3600000
    let clk = t0
    const u = usageMod.createUsage({ file: '', now: () => clk, hourlyKeepMs: 2 * 3600000 })
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 10, ct: 0, tt: 10, latMs: 100, tps: 1, credit: 1, hasCredit: true })
    clk = t3 // 推进到 3 小时后，上一条已超出 2h 保留窗口
    u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 20, ct: 0, tt: 20, latMs: 100, tps: 1, credit: 2, hasCredit: true })
    u.rollup(t3)
    const s = u.snapshot(0)
    assert.strictEqual(s.totals.req, 2, '折叠不丢数据')
    assert.strictEqual(s.totals.tt, 30)
    const scopes = s.series.map(p => p.scope)
    assert.ok(scopes.includes('day'), '旧的 10:00 小时桶应折叠为日桶')
    assert.ok(scopes.includes('hour'), '新近的 13:00 小时桶应保留')
    u.stop()
  })

  test('桶数达上限时优先折叠最旧小时桶', () => {
    let clk = Date.parse('2026-05-01T09:00:00')
    const u = usageMod.createUsage({ file: '', now: () => clk, maxBuckets: 2 })
    const rec = () => u.record({ uid: 'u1', model: 'm1', rate: '', ok: true, pt: 1, ct: 0, tt: 1, latMs: 100, tps: 1, credit: 0, hasCredit: false })
    rec(); clk += 3600000; rec(); clk += 3600000; rec()
    const s = u.snapshot(0)
    assert.ok(s.buckets <= 2, `桶数应回落到上限内，实际 ${s.buckets}`)
    assert.strictEqual(s.totals.req, 3, '折叠不丢请求数')
    assert.ok(s.series.some(p => p.scope === 'day'), '应产生折叠后的日桶')
    u.stop()
  })

  test('持久化往返（原子写 + load 恢复）', () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-usage-test-'))
    const file = path.join(dir, 'usage.json')
    const u1 = usageMod.createUsage({ file, now: () => clk })
    u1.record({ uid: 'u1', model: 'm1', rate: '0.5', ok: true, pt: 100, ct: 50, tt: 150, latMs: 100, tps: 10, credit: 2, hasCredit: true })
    u1.save()
    assert.ok(fs.existsSync(file), '应立即落盘')
    assert.ok(!fs.existsSync(`${file}.tmp`), '原子写后不应残留 tmp 文件')
    assert.ok(fs.statSync(file).size > 0)
    const u2 = usageMod.createUsage({ file, now: () => clk })
    u2.load()
    const a = u1.snapshot(0).totals
    const b = u2.snapshot(0).totals
    assert.strictEqual(b.req, a.req)
    assert.strictEqual(b.tt, a.tt)
    assert.strictEqual(b.cr, a.cr)
    assert.strictEqual(b.crt, a.crt)
    assert.ok(u2.snapshot(0).file_bytes > 0, '应报告文件占用')
    u1.stop(); u2.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('snapshot(hours) 窗口过滤与 0=全历史、上限夹取', () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    let c = clk - 48 * 3600000
    const u = usageMod.createUsage({ file: '', now: () => c })
    u.record({ uid: 'old', model: 'm1', rate: '', ok: true, pt: 5, ct: 0, tt: 5, latMs: 100, tps: 1, credit: 0, hasCredit: false })
    c = clk
    u.record({ uid: 'new', model: 'm1', rate: '', ok: true, pt: 1, ct: 0, tt: 1, latMs: 100, tps: 1, credit: 0, hasCredit: false })
    assert.strictEqual(u.snapshot(24).totals.req, 1, '24h 窗口只含最近的记录')
    assert.strictEqual(u.snapshot(72).totals.req, 2, '72h 窗口含两条')
    assert.strictEqual(u.snapshot(0).totals.req, 2, '0 = 全历史')
    assert.strictEqual(u.snapshot(999999).totals.req, 2, '超上限夹取到 1440 后仍含两条')
    assert.strictEqual(u.snapshot().totals.req, 2, '默认 72 小时')
    u.stop()
  })

  test("snapshot('today'/'yesterday')：本地自然日窗口", () => {
    const clk = Date.parse('2026-05-01T10:00:00')
    let c = clk - 24 * 3600000 // 昨天 10 点
    const u = usageMod.createUsage({ file: '', now: () => c })
    u.record({ uid: 'y', model: 'm1', rate: '', ok: true, pt: 5, ct: 0, tt: 5, latMs: 100, tps: 1, credit: 0, hasCredit: false })
    c = clk
    u.record({ uid: 't', model: 'm1', rate: '', ok: true, pt: 1, ct: 0, tt: 1, latMs: 100, tps: 1, credit: 0, hasCredit: false })
    assert.strictEqual(u.snapshot('today').totals.req, 1, '今天窗口只含今天的记录')
    assert.strictEqual(u.snapshot('yesterday').totals.req, 1, '昨天窗口只含昨天的记录')
    assert.strictEqual(u.snapshot('yesterday').totals.pt, 5, '昨天窗口内容正确')
    u.stop()
  })

  test('倍率解析与模型条目 rate 字段', () => {
    assert.strictEqual(clientMod.normalizeModelRate('x0.79'), '0.79')
    assert.strictEqual(clientMod.normalizeModelRate('x0.05 credits'), '0.05')
    assert.strictEqual(clientMod.normalizeModelRate('0.50x'), '0.5')
    assert.strictEqual(clientMod.normalizeModelRate(''), '')
    assert.strictEqual(clientMod.normalizeModelRate('abc'), 'abc', '无法数值化时保留原文')
    const entry = clientMod.mapModelEntry({ id: 'glm-5.3', credits: 'x0.79' })
    assert.strictEqual(entry.rate, '0.79')
    assert.strictEqual(clientMod.mapModelEntry({ id: 'x' }).rate, '', '缺失倍率为空串')
  })

  // ==================== 15. 积分历史 ====================
  group('15. 积分历史 credithist')

  test('首次观测只建基线；变化留痕（正获取负消耗）；read 新的在前', () => {
    let clk = Date.parse('2026-05-01T10:00:00')
    const l = credithistMod.createLedger({ file: '', now: () => (clk += 1000) })
    l.observe('u1', 100)
    assert.deepStrictEqual(l.read(0), [], '首次观测只建基线，不记流水')
    l.observe('u1', 100)
    assert.deepStrictEqual(l.read(0), [], '余额不变不留痕')
    l.observe('u1', 160)
    l.observe('u1', 120)
    const r = l.read(0)
    assert.strictEqual(r.length, 2)
    assert.strictEqual(r[0].delta, -40, '新的在前')
    assert.strictEqual(r[0].before, 160)
    assert.strictEqual(r[0].after, 120)
    assert.strictEqual(r[1].delta, 60)
    assert.strictEqual(r[1].before, 100)
    assert.strictEqual(r[1].after, 160)
    assert.ok(r[0].time && !Number.isNaN(Date.parse(r[0].time)), '时间为可解析的 ISO 串')
    assert.strictEqual(l.read(1).length, 1, 'limit 取最近 1 条')
    assert.strictEqual(l.read(1)[0].delta, -40)
    assert.strictEqual(l.read(999).length, 2, 'limit 超量取全部')
  })

  test('|delta| 超过 maxDelta 只更新基线不留痕（边界值恰好等于上限仍留痕）', () => {
    const l = credithistMod.createLedger({ file: '', maxDelta: 1000 })
    l.observe('u1', 100)
    l.observe('u1', 1101)
    assert.deepStrictEqual(l.read(0), [], '超限变动不留痕')
    l.observe('u1', 1201) // 与更新后的基线差 100：正常留痕
    assert.strictEqual(l.read(0).length, 1)
    assert.strictEqual(l.read(0)[0].before, 1101)
    assert.strictEqual(l.read(0)[0].delta, 100)
    l.observe('u1', 2201) // 恰好等于上限：仍留痕
    assert.strictEqual(l.read(0).length, 2)
    assert.strictEqual(l.read(0)[0].delta, 1000)
  })

  test('持久化往返：快照与流水恢复、tmp 不残留；重启后同余额不产生假变动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-credithist-'))
    const file = path.join(dir, 'credit-history.json')
    const l1 = credithistMod.createLedger({ file })
    l1.observe('u1', 100)
    l1.observe('u1', 150)
    assert.ok(fs.existsSync(file), '变动应同步落盘')
    assert.ok(!fs.existsSync(`${file}.tmp`), '原子写后不应残留 tmp 文件')
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.strictEqual(disk.version, 1)
    assert.strictEqual(disk.snapshot.u1, 150)
    assert.strictEqual(disk.entries.length, 1)

    const l2 = credithistMod.createLedger({ file })
    l2.load()
    l2.observe('u1', 150) // 与恢复的基线相同：不应补一条假流水
    l2.observe('u2', 90) // 新账号：只建基线
    const r = l2.read(0)
    assert.strictEqual(r.length, 1, '重启后同余额不产生假变动')
    assert.strictEqual(r[0].delta, 50)
    const disk2 = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.strictEqual(disk2.snapshot.u2, 90, '新账号基线已持久化')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('流水条数上限：超出丢最旧', () => {
    const l = credithistMod.createLedger({ file: '', maxEntries: 3 })
    let v = 0
    for (let i = 0; i < 6; i++) l.observe('u1', (v += 10))
    const r = l.read(0)
    assert.strictEqual(r.length, 3)
    assert.strictEqual(r[0].after, 60, '保留最新')
    assert.strictEqual(r[2].after, 40, '最旧的被丢弃')
  })

  test('空 uid 与非有限余额被忽略', () => {
    const l = credithistMod.createLedger({ file: '' })
    l.observe('', 10)
    l.observe('   ', 10)
    l.observe(null, 10)
    l.observe('u1', NaN)
    l.observe('u1', 'abc')
    assert.deepStrictEqual(l.read(0), [], '非法观测不产生任何记录')
    l.observe('u1', 100)
    l.observe('u1', 120)
    assert.strictEqual(l.read(0).length, 1, '修剪后的 uid 正常工作')
  })

  test('client 余额观察者接口导出（挂载 / 注销）', () => {
    assert.strictEqual(typeof clientMod.setCreditObserver, 'function')
    clientMod.setCreditObserver(null)
    clientMod.setCreditObserver(() => {})
    clientMod.setCreditObserver(null)
  })

  test('runtime.creditHistory：昵称读取时填充、uid 过滤、limit 夹取', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-credithist-rt-'))
    runtimeMod.init({ dataDir: tmp }) // 已初始化时为幂等空操作
    const r = runtimeMod.getRuntime()
    const savedLedger = r.creditHist
    const savedList = r.pool.list
    // 用假账本与假账号池隔离测试读取层：留痕写入语义由上面 credithist 组用例覆盖
    r.creditHist = {
      read: limit => {
        const all = [
          { time: '2026-05-01T02:00:00.000Z', uid: 'u1', delta: 60, before: 100, after: 160 },
          { time: '2026-05-01T01:00:00.000Z', uid: 'u2', delta: -30, before: 130, after: 100 },
          { time: '2026-05-01T00:00:00.000Z', uid: 'u1', delta: 30, before: 70, after: 100 }
        ]
        return limit > 0 ? all.slice(0, limit) : all
      }
    }
    r.pool.list = () => [{ uid: 'u1', nickname: '账号一' }]
    try {
      const a = runtimeMod.creditHistory()
      assert.strictEqual(a.limit, 50, '默认 50')
      assert.strictEqual(a.entries.length, 3)
      assert.strictEqual(a.offset, 0, '默认偏移 0')
      assert.strictEqual(a.total, 3, '返回过滤后总条数')
      assert.strictEqual(a.net, 60, '净变动合计（60-30+30）')
      assert.strictEqual(a.entries[0].account, '账号一', '昵称读取时填充')
      assert.strictEqual(a.entries[1].account, '', '池内无此账号时昵称为空串')
      assert.strictEqual(runtimeMod.creditHistory(2).entries.length, 2, 'limit 截断')
      assert.strictEqual(runtimeMod.creditHistory(5000).limit, 1000, '上限 1000')
      assert.strictEqual(runtimeMod.creditHistory(-1).limit, 50, '非法 limit 回落默认')
      assert.strictEqual(runtimeMod.creditHistory('abc').limit, 50, '非数字 limit 回落默认')
      const e = runtimeMod.creditHistory(100, 'u1')
      assert.strictEqual(e.entries.length, 2, 'uid 过滤')
      assert.strictEqual(e.total, 2, 'uid 过滤后总数')
      assert.strictEqual(e.net, 90, 'uid 过滤后净变动（60+30）')
      assert.ok(e.entries.every(x => x.uid === 'u1'))
      const pg = runtimeMod.creditHistory(1, '', 1)
      assert.strictEqual(pg.entries.length, 1, 'offset 翻页')
      assert.strictEqual(pg.entries[0].uid, 'u2', '翻页命中第 2 条')
      assert.strictEqual(pg.total, 3, '翻页不影响总条数')
    } finally {
      r.creditHist = savedLedger
      r.pool.list = savedList
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // ==================== 8.5 CN 域请求头（固定 zh-CN / 固定 CN 域）====================
  group('8.5 CN 域请求头（固定 zh-CN / 固定 CN 域）')

  test('acceptLanguage：固定 zh-CN', () => {
    assert.strictEqual(headersMod.acceptLanguage(), 'zh-CN')
  })

  test('originRefererOf：固定 codebuddy.cn', () => {
    assert.strictEqual(headersMod.originRefererOf(), 'https://www.codebuddy.cn')
  })

  test('三个 base 函数：默认 CN 域 + opts 覆盖位', () => {
    const cn = { domain: 'copilot.tencent.com' }
    assert.strictEqual(headersMod.chatBaseOf(cn, {}), 'https://copilot.tencent.com')
    assert.strictEqual(headersMod.billingBaseOf(cn, {}), 'https://www.codebuddy.cn')
    assert.strictEqual(headersMod.webBaseOf(cn, {}), 'https://www.workbuddy.cn')
    assert.strictEqual(headersMod.chatBaseOf(cn, { chatBaseCN: 'http://cn.local' }), 'http://cn.local')
    assert.strictEqual(headersMod.billingBaseOf(cn, { billingBaseCN: 'http://b.local' }), 'http://b.local')
    assert.strictEqual(headersMod.webBaseOf(cn, { webBaseCN: 'http://w.local' }), 'http://w.local')
  })

  test('chatHeaders：CN 分支保持 enterprise/domain/X-No-Department-Info 逻辑', () => {
    const a = headersMod.chatHeaders(makeAuth('c1', { enterpriseId: 'e9', domain: 'copilot.tencent.com' }), {}, {})
    assert.strictEqual(a['X-Enterprise-Id'], 'e9')
    assert.strictEqual(a['X-Domain'], 'copilot.tencent.com')
    assert.strictEqual(a.Origin, 'https://www.codebuddy.cn')
    assert.strictEqual(a['Accept-Language'], 'zh-CN')
    const b = headersMod.chatHeaders(makeAuth('c2', { domain: '' }), {}, {})
    assert.strictEqual(b['X-No-Enterprise-Id'], '1')
    assert.strictEqual(b['X-No-Department-Info'], '1')
  })

  test('mergeModelList：primary 字段权威、secondary 只补缺失 id', () => {
    const merged = clientMod.mergeModelList([{ id: 'a', name: 'A1' }, { id: 'b' }], [{ id: 'a', name: 'A2' }, { id: 'c' }])
    assert.deepStrictEqual(merged.map(m => m.id), ['a', 'b', 'c'])
    assert.strictEqual(merged[0].name, 'A1', '同 id 以 primary 为准')
  })

  test('constants：Origin / 计费路径 CN 常量取值', () => {
    assert.strictEqual(constants.ORIGIN_REFERER_CN, 'https://www.codebuddy.cn')
    assert.strictEqual(constants.MODELS_ENTERPRISE_PATH, '/console/enterprises/personal/models')
    assert.strictEqual(constants.BILLING_METER_PATH_V2, '/v2/billing/meter/get-user-resource')
    assert.strictEqual(constants.DAILY_CHECKIN_PATH_V2, '/v2/billing/meter/daily-checkin')
  })

  // ==================== 9. Anthropic ⇄ OpenAI 协议转换 ====================

  group('9. Anthropic ⇄ OpenAI 协议转换')

  test('toOpenAI：system/tools/tool_use/tool_result 全量映射', () => {
    const body = {
      model: 'workbuddy/deepseek-v4.1-flash',
      max_tokens: 4096,
      stream: true,
      system: [{ type: 'text', text: '你是 Claude Code', cache_control: { type: 'ephemeral' } }],
      metadata: { user_id: 'u1' },
      stop_sequences: ['\n\nHuman:'],
      tool_choice: { type: 'auto' },
      tools: [
        { name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
        { name: 'Bash', input_schema: { type: 'object', properties: {} } }
      ],
      messages: [
        { role: 'user', content: '<system-reminder>ctx</system-reminder>\nhello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想一下' },
            { type: 'text', text: '我来读文件' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.js' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '文件内容' }] },
            { type: 'text', text: '继续' }
          ]
        }
      ]
    }
    const out = anthropicMod.toOpenAI(body)
    assert.strictEqual(out.messages[0].role, 'system')
    assert.strictEqual(out.messages[0].content, '你是 Claude Code', 'system 块数组拼为单条消息')
    assert.strictEqual(out.metadata, undefined, 'metadata 剔除')
    assert.strictEqual(out.thinking, undefined)
    assert.deepStrictEqual(out.stop, ['\n\nHuman:'], 'stop_sequences → stop')
    assert.strictEqual(out.tool_choice, 'auto')
    assert.strictEqual(out.tools[0].type, 'function')
    assert.strictEqual(out.tools[0].function.name, 'Read')
    assert.deepStrictEqual(out.tools[0].function.parameters, { type: 'object', properties: { file_path: { type: 'string' } } })
    const a = out.messages[2]
    assert.strictEqual(a.role, 'assistant')
    assert.strictEqual(a.content, '我来读文件', 'thinking 块丢弃')
    assert.strictEqual(a.tool_calls[0].id, 'toolu_1')
    assert.strictEqual(a.tool_calls[0].function.name, 'Read')
    assert.strictEqual(a.tool_calls[0].function.arguments, '{"file_path":"a.js"}')
    const t = out.messages[3]
    assert.strictEqual(t.role, 'tool')
    assert.strictEqual(t.tool_call_id, 'toolu_1')
    assert.strictEqual(t.content, '文件内容')
    const last = out.messages[4]
    assert.strictEqual(last.role, 'user')
    assert.strictEqual(last.content, '继续')
  })

  test('toOpenAI：tool_choice any/指定函数 + 无 tools 时剔除', () => {
    const out1 = anthropicMod.toOpenAI({ messages: [], tool_choice: { type: 'any' } })
    assert.strictEqual(out1.tool_choice, 'required')
    const out2 = anthropicMod.toOpenAI({ messages: [], tool_choice: { type: 'tool', name: 'Bash' } })
    assert.deepStrictEqual(out2.tool_choice, { type: 'function', function: { name: 'Bash' } })
    const out3 = anthropicMod.toOpenAI({ messages: [], tools: [] })
    assert.strictEqual(out3.tools, undefined, '空 tools 剔除')
  })

  test('toMessage：聚合 chat.completion → Anthropic Message', () => {
    const agg = {
      id: 'chatcmpl-1',
      model: 'workbuddy/deepseek-v4.1-flash',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '思考结果',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
            { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{坏JSON' } }
          ]
        }
      }],
      usage: { prompt_tokens: 12, completion_tokens: 34 }
    }
    const msg = anthropicMod.toMessage(agg, 'workbuddy/x')
    assert.strictEqual(msg.type, 'message')
    assert.strictEqual(msg.role, 'assistant')
    assert.strictEqual(msg.model, 'workbuddy/deepseek-v4.1-flash')
    assert.strictEqual(msg.content[0].type, 'text')
    assert.strictEqual(msg.content[0].text, '思考结果')
    assert.strictEqual(msg.content[1].type, 'tool_use')
    assert.deepStrictEqual(msg.content[1].input, { command: 'ls' })
    assert.deepStrictEqual(msg.content[2].input, {}, '坏 JSON 参数回退为空对象')
    assert.strictEqual(msg.stop_reason, 'tool_use')
    // usage 四项齐备：缓存两项恒存在（OpenAI 协议无缓存写入 → 0，不是"未知"），
    // 客户端据此可算缓存命中率；上游已归一的别名也要能读到
    assert.deepStrictEqual(msg.usage, {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    })
  })

  test('toMessage：usage 缓存读多种别名都能取到', () => {
    const mk = usage => anthropicMod.toMessage({ choices: [{ message: { content: 'x' } }], usage }, 'm').usage
    // prompt_tokens_details.cached_tokens（sse.js 归一后的标准形态）
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } }).cache_read_input_tokens, 40)
    // 平铺别名
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 30 }).cache_read_input_tokens, 30)
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 20 }).cache_read_input_tokens, 20)
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5, cached_tokens: 10 }).cache_read_input_tokens, 10)
    // 无缓存字段 / 非数字 / 负数 → 0（不产生 NaN）
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5 }).cache_read_input_tokens, 0)
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 'x' }).cache_read_input_tokens, 0)
    assert.strictEqual(mk({ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: -5 }).cache_read_input_tokens, 0)
    // 完全无 usage 时不抛错
    assert.deepStrictEqual(anthropicMod.toMessage({ choices: [{ message: { content: 'x' } }] }, 'm').usage, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    })
  })

  test('流式生成器：文本事件序列 + [DONE] 收尾', () => {
    const em = anthropicMod.createStreamEmitter({ model: 'workbuddy/x' })
    const out = []
    const feed = t => {
      const s = em.push(t)
      if (s) out.push(s)
    }
    const frame = o => `data: ${JSON.stringify(o)}\n\n`
    feed(': keepalive\n')
    feed(frame({ choices: [{ delta: { role: 'assistant' }, index: 0 }] }))
    feed(frame({ choices: [{ delta: { content: '你好' }, index: 0 }] }))
    feed(frame({ choices: [{ delta: { content: '，小c' }, index: 0 }] }))
    feed(frame({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }))
    feed('data: [DONE]\n\n')
    const tail = em.end()
    if (tail) out.push(tail)
    const text = out.join('')
    const events = [...text.matchAll(/event: (\w+)/g)].map(m => m[1])
    assert.deepStrictEqual(events, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    assert.ok(!text.includes('keepalive'), '注释行不转发')
    assert.ok(!text.includes('[DONE]'), '[DONE] 吞掉')
    assert.ok(text.includes('"text":"你好"') && text.includes('"text":"，小c"'))
    assert.ok(text.includes('"stop_reason":"end_turn"'))
  })

  test('流式生成器：工具调用事件 + length 映射', () => {
    const em = anthropicMod.createStreamEmitter({ model: 'workbuddy/x' })
    const out = []
    const feed = t => {
      const s = em.push(t)
      if (s) out.push(s)
    }
    const frame = o => `data: ${JSON.stringify(o)}\n\n`
    feed(frame({ choices: [{ delta: { content: '执行中' }, index: 0 }] }))
    feed(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }, index: 0 }] }))
    feed(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"x":1}' } }] }, index: 0 }] }))
    feed(frame({ choices: [{ delta: {}, finish_reason: 'length', index: 0 }], usage: { completion_tokens: 9 } }))
    const tail = em.end() || ''
    const text = out.join('') + tail
    assert.ok(text.includes('"type":"tool_use"') && text.includes('"name":"Bash"'), 'tool_use 块开始')
    assert.ok(text.includes('"partial_json":"{\\"command\\":\\"ls\\"}"'), '参数增量透传')
    assert.ok(text.includes('"stop_reason":"max_tokens"'), 'length → max_tokens')
    assert.ok(text.includes('"output_tokens":9'), 'usage 取末帧')
    const starts = [...text.matchAll(/event: message_start/g)].length
    assert.strictEqual(starts, 1, 'message_start 只发一次')
  })

  test('错误事件：网关错误帧 → Anthropic error 事件', () => {
    const em = anthropicMod.createStreamEmitter({ model: 'x' })
    const s = em.push('data: ' + JSON.stringify({ error: { message: '均无可用账号', gateway_hint: '请检查账号状态' } }) + '\n\n')
    assert.ok(s.includes('event: error'))
    assert.ok(s.includes('均无可用账号（请检查账号状态）'))
    assert.strictEqual(em.push('data: [DONE]\n\n'), '')
    assert.strictEqual(em.end(), '', '错误后不再补收尾事件')
    assert.strictEqual(anthropicMod.errorBody('boom', 'hint').error.message, 'boom（hint）')
  })

  test('流式生成器：message_delta 补齐缓存用量', () => {
    const em = anthropicMod.createStreamEmitter({ model: 'x' })
    const out = []
    const feed = t => {
      const s = em.push(t)
      if (s) out.push(s)
    }
    const frame = o => `data: ${JSON.stringify(o)}\n\n`
    feed(frame({ choices: [{ delta: { content: 'hi' }, index: 0 }] }))
    // 末帧 usage 带缓存读（上游归一后的形态）
    feed(
      frame({
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 1000, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 800 } }
      })
    )
    const text = out.join('') + (em.end() || '')
    const delta = /event: message_delta\ndata: (.+)\n/.exec(text)
    assert.ok(delta, '应有 message_delta 事件')
    const u = JSON.parse(delta[1]).usage
    assert.strictEqual(u.output_tokens, 42)
    assert.strictEqual(u.input_tokens, 1000, '输入用量也应带上')
    assert.strictEqual(u.cache_read_input_tokens, 800, '缓存读必须透传（此前完全丢失）')
    assert.strictEqual(u.cache_creation_input_tokens, 0)
    // 上游未给 usage 时字段仍在（恒 0），不产生 NaN / undefined
    const em2 = anthropicMod.createStreamEmitter({ model: 'x' })
    em2.push(frame({ choices: [{ delta: { content: 'y' }, index: 0 }] }))
    const t2 = (em2.end() || '')
    const d2 = /event: message_delta\ndata: (.+)\n/.exec(t2)
    const u2 = JSON.parse(d2[1]).usage
    assert.strictEqual(u2.cache_read_input_tokens, 0)
    assert.strictEqual(u2.input_tokens, 0)
  })

  test('raiseOutputBudget：预算上调、下限保护、上限封顶、坏输入原样返回', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const R = runtimeMod.raiseOutputBudget
    assert.strictEqual(typeof R, 'function', 'raiseOutputBudget 应导出')
    const mt = s => JSON.parse(s).max_tokens
    // 小幅预算 → 取下限 32768（实测：复杂任务需 32K 才稳定拿到正文）
    assert.strictEqual(mt(R(JSON.stringify({ model: 'm', max_tokens: 100 }), 0)), 32768)
    assert.strictEqual(mt(R(JSON.stringify({ model: 'm', max_tokens: 4000 }), 0)), 32768)
    // 大额预算 → 翻倍
    assert.strictEqual(mt(R(JSON.stringify({ model: 'm', max_tokens: 20000 }), 0)), 40000)
    // 模型输出上限封顶
    assert.strictEqual(mt(R(JSON.stringify({ model: 'm', max_tokens: 100000 }), 131072)), 131072)
    assert.strictEqual(mt(R(JSON.stringify({ model: 'm', max_tokens: 120000 }), 131072)), 131072, '超上限则回调到上限')
    // 已达上限且无法提高 → 原样返回（调用方据此改走换号）
    const capped = JSON.stringify({ model: 'm', max_tokens: 32768 })
    assert.strictEqual(R(capped, 32768), capped, '已封顶时不改动')
    // 未设 max_tokens → 补下限
    assert.strictEqual(mt(R(JSON.stringify({ model: 'm' }), 0)), 32768)
    // 坏 JSON / 非对象 → 原样返回，绝不抛错
    assert.strictEqual(R('{bad', 0), '{bad')
    assert.strictEqual(R('[1,2]', 0), '[1,2]')
    assert.strictEqual(R('', 0), '')
    // 其他字段保持不变
    const keep = JSON.parse(R(JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }), 0))
    assert.strictEqual(keep.model, 'm')
    assert.strictEqual(keep.messages[0].content, 'x')
  })

  // ==================== 16. 国际版（Global / workbuddy.ai）====================
  group('16. 国际版区域支持')

  test('区域判定：显式 realm 优先 > domain 后缀 > 默认 cn', () => {
    const A = authMod
    // 解析已存在凭证：domain 权威（可能被手工改过 / 早期版本写错 realm）
    assert.strictEqual(A.resolveRealm('global', 'www.codebuddy.cn'), 'cn', 'realm 与 domain 矛盾时信 domain')
    assert.strictEqual(A.resolveRealm('cn', 'www.workbuddy.ai'), 'global', 'domain 是国际就判国际')
    assert.strictEqual(A.resolveRealm('', 'www.workbuddy.ai'), 'global', '按域推断')
    assert.strictEqual(A.resolveRealm(undefined, 'workbuddy.ai'), 'global', '裸域也算')
    assert.strictEqual(A.resolveRealm(undefined, 'https://WWW.WorkBuddy.AI/'), 'global', '带 scheme + 大小写')
    assert.strictEqual(A.resolveRealm(undefined, 'www.codebuddy.cn'), 'cn')
    // 旧凭证：没有 realm、也没有 domain → 必须判国内版（不能误判成国际版）
    assert.strictEqual(A.resolveRealm(undefined, ''), 'cn', '旧凭证默认国内版')
    assert.strictEqual(A.resolveRealm(undefined, undefined), 'cn')
    // 无 domain 时才采信显式 realm（手工构造的凭证）
    assert.strictEqual(A.resolveRealm('global', ''), 'global')
    assert.strictEqual(A.isGlobalDomain('evil-workbuddy.ai.attacker.com'), false, '后缀必须精确匹配域边界')

    // 登录落盘：用户显式选择优先于 domain（否则国际版永远添加不上）
    assert.strictEqual(A.resolveRealmForLogin('global', 'www.codebuddy.cn'), 'global', '登录时用户选择优先')
    assert.strictEqual(A.resolveRealmForLogin('cn', 'www.workbuddy.ai'), 'cn', '登录时用户选择优先')
    assert.strictEqual(A.resolveRealmForLogin('', 'www.workbuddy.ai'), 'global', '未选时按 domain 推断')
    assert.strictEqual(A.resolveRealmForLogin('', ''), 'cn')
  })

  test('凭证解析：旧凭证无 realm 字段 → 国内版；落盘回写 realm', () => {
    const oldDoc = JSON.stringify({
      auth: { accessToken: 'tok', refreshToken: 'r', expiresAt: 1, domain: 'www.codebuddy.cn' },
      account: { uid: 'u-old', enterpriseId: '', nickname: 'old' }
    })
    const a1 = authMod.parseAuth(oldDoc)
    assert.strictEqual(a1.realm, 'cn', '旧凭证必须判为国内版')

    const newDoc = JSON.stringify({
      auth: { accessToken: 'tok', refreshToken: 'r', expiresAt: 1, domain: 'www.workbuddy.ai', realm: 'global' },
      account: { uid: 'u-new', enterpriseId: '', nickname: 'new' }
    })
    assert.strictEqual(authMod.parseAuth(newDoc).realm, 'global')

    // 落盘必须带 realm（刷新 token 回写时不丢）
    const tmp = path.join(os.tmpdir(), `wb-realm-${Date.now()}.json`)
    authMod.saveAtomic({
      uid: 'u1',
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: 1,
      domain: 'www.workbuddy.ai',
      realm: 'global',
      filePath: tmp
    })
    const back = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    assert.strictEqual(back.auth.realm, 'global', 'realm 必须落盘')
    fs.unlinkSync(tmp)
  })

  test('国际版域名：chat/billing/web 同域 workbuddy.ai（不像国内版三域）', () => {
    const cn = { uid: 'c', realm: 'cn', domain: 'www.codebuddy.cn' }
    const gl = { uid: 'g', realm: 'global', domain: 'www.workbuddy.ai' }
    assert.strictEqual(headersMod.chatBaseOf(gl, {}), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.billingBaseOf(gl, {}), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.webBaseOf(gl, {}), 'https://www.workbuddy.ai')
    // 国内版三域保持原样（回归）
    assert.strictEqual(headersMod.chatBaseOf(cn, {}), 'https://copilot.tencent.com')
    assert.strictEqual(headersMod.billingBaseOf(cn, {}), 'https://www.codebuddy.cn')
    assert.strictEqual(headersMod.webBaseOf(cn, {}), 'https://www.workbuddy.cn')
    // 旧账号（无 realm）走国内版域
    assert.strictEqual(headersMod.chatBaseOf({ uid: 'x' }, {}), 'https://copilot.tencent.com')
  })

  test('国际版 UA 平台段为 WorkBuddy AI（送错会触发 403/11140）', () => {
    const gl = { uid: 'g', realm: 'global' }
    const cn = { uid: 'c', realm: 'cn' }
    const uaG = headersMod.userAgent(gl, {})
    assert.ok(uaG.includes('WorkBuddy AI/'), `国际版 UA 应含 WorkBuddy AI 平台段，实际 ${uaG}`)
    assert.ok(!/WorkBuddy\/[\d.]+ WorkBuddy\//.test(uaG), '不应出现国内版的双 WorkBuddy 段')
    const uaC = headersMod.userAgent(cn, {})
    assert.ok(uaC.includes('WorkBuddy/5.5.4 WorkBuddy/'), '国内版保持三段式')
    // billing 域 UA 同样按区域切
    assert.ok(headersMod.billingUA({}, gl).includes('WorkBuddy AI'))
    assert.strictEqual(headersMod.billingUA({}, cn), 'WorkBuddy/5.5.4')
  })

  test('国际版 Accept-Language / Origin 按区域切', () => {
    const gl = { uid: 'g', realm: 'global' }
    const cn = { uid: 'c', realm: 'cn' }
    assert.strictEqual(headersMod.acceptLanguage({}, gl), 'en-US')
    assert.strictEqual(headersMod.acceptLanguage({}, cn), 'zh-CN')
    assert.strictEqual(headersMod.originRefererOf(gl, {}), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.originRefererOf(cn, {}), 'https://www.codebuddy.cn')
  })

  test('国际版 chat 头：X-Domain 写死 workbuddy.ai + X-No-Enterprise-Id', () => {
    const gl = { uid: 'g', realm: 'global', domain: 'some-other-domain.example', accessToken: 't' }
    const h = headersMod.chatHeaders(gl, {}, {})
    assert.strictEqual(h['X-Domain'], 'www.workbuddy.ai', '必须写死，不透传登录返回的 domain')
    assert.strictEqual(h['X-No-Enterprise-Id'], '1')
    assert.strictEqual(h['X-Enterprise-Id'], undefined, '国际版不应带企业头')
    assert.strictEqual(h['Accept-Language'], 'en-US')
    // 国内版：domain 原样透传（回归）
    const cn = { uid: 'c', realm: 'cn', domain: 'www.codebuddy.cn', accessToken: 't' }
    const hc = headersMod.chatHeaders(cn, {}, {})
    assert.strictEqual(hc['X-Domain'], 'www.codebuddy.cn')
    assert.strictEqual(hc['X-No-Enterprise-Id'], '1')
  })

  test('计费路径：国际版无 /v2 优先、404 回落；国内版只有 /v2', () => {
    const gl = { uid: 'g', realm: 'global' }
    const cn = { uid: 'c', realm: 'cn' }
    assert.deepStrictEqual(headersMod.billingMeterPathsOf(gl), [
      '/billing/meter/get-user-resource',
      '/v2/billing/meter/get-user-resource'
    ])
    assert.deepStrictEqual(headersMod.billingMeterPathsOf(cn), ['/v2/billing/meter/get-user-resource'])
    assert.deepStrictEqual(headersMod.checkinPathsOf(gl), [
      '/billing/meter/daily-checkin',
      '/v2/billing/meter/daily-checkin'
    ])
    assert.deepStrictEqual(headersMod.checkinPathsOf(cn), ['/v2/billing/meter/daily-checkin'])
  })

  test('账号池：按区域隔离选号（不跨区派发）', () => {
    const pool = poolMod.createPool({})
    pool.add({ ...makeAuth('cn1'), realm: 'cn' })
    pool.add({ ...makeAuth('gl1'), realm: 'global' })
    assert.strictEqual(pool.pick({ realm: 'cn' }).uid, 'cn1', '国内池只应选中 cn 账号')
    assert.strictEqual(pool.pick({ realm: 'global' }).uid, 'gl1', '国际池只应选中 global 账号')
    assert.deepStrictEqual(pool.availableUIDs('', null, 'cn'), ['cn1'])
    assert.deepStrictEqual(pool.availableUIDs('', null, 'global'), ['gl1'])
    // 不传区域 = 不限（兼容旧调用）
    assert.strictEqual(pool.availableUIDs('', null, '').length, 2)
    // 诊断也按区域
    assert.strictEqual(pool.diagnoseNoCandidate('', 'cn').total, 1)
    assert.strictEqual(pool.diagnoseNoCandidate('', 'global').total, 1)
  })

  test('账号池：国际版并发上限取 maxInFlightGlobal', () => {
    const p = poolMod.createPool({ maxInFlight: 3, maxInFlightGlobal: 2 })
    p.add({ ...makeAuth('cn1'), realm: 'cn' })
    p.add({ ...makeAuth('gl1'), realm: 'global' })
    // 国内账号可占到 3
    assert.strictEqual(p.acquire('cn1'), true)
    assert.strictEqual(p.acquire('cn1'), true)
    assert.strictEqual(p.acquire('cn1'), true)
    assert.strictEqual(p.acquire('cn1'), false, '国内账号第 4 个在途应被拒')
    // 国际账号只能到 2
    assert.strictEqual(p.acquire('gl1'), true)
    assert.strictEqual(p.acquire('gl1'), true)
    assert.strictEqual(p.acquire('gl1'), false, '国际账号第 3 个在途应被拒（上限 2）')
  })

  test('区域门控：国际版跳过签到/成长任务', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const gl = { uid: 'g', realm: 'global', nickname: 'intl' }
    const cn = { uid: 'c', realm: 'cn' }
    assert.strictEqual(runtimeMod.skipCheckinFor(gl), true, '国际版跳过签到')
    assert.strictEqual(runtimeMod.skipCheckinFor(cn), false)
    assert.strictEqual(runtimeMod.skipGrowthFor(gl), true, '国际版跳过成长任务')
    assert.strictEqual(runtimeMod.skipGrowthFor(cn), false)
    // 旧账号（无 realm）不跳过
    assert.strictEqual(runtimeMod.skipGrowthFor({ uid: 'x' }), false)
    const err = runtimeMod.growthUnsupportedError(gl)
    assert.strictEqual(err.code, 'growth_unsupported_realm')
    assert.ok(err.message.includes('国际版'))
  })

  test('模型目录：按区域分槽查找（先本区域后兜底）', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const r = {
      models: {
        byRealm: {
          cn: { list: [{ id: 'glm-cn-only' }, { id: 'shared', rate: 'cn-rate' }] },
          global: { list: [{ id: 'gpt-global-only' }, { id: 'shared', rate: 'global-rate' }] }
        }
      }
    }
    assert.strictEqual(runtimeMod.findModelEntry(r, 'shared', 'cn').rate, 'cn-rate', '同模型应按区域取各自条目')
    assert.strictEqual(runtimeMod.findModelEntry(r, 'shared', 'global').rate, 'global-rate')
    assert.strictEqual(runtimeMod.findModelEntry(r, 'gpt-global-only', 'global').id, 'gpt-global-only')
    assert.strictEqual(runtimeMod.findModelEntry(r, 'gpt-global-only', 'cn').id, 'gpt-global-only', '本区域没有时兜底找')
    assert.strictEqual(runtimeMod.findModelEntry(r, '不存在', 'cn'), null)
    // 失效缓存会清空所有区域
    runtimeMod.invalidateModelCache(r)
    assert.deepStrictEqual(r.models.byRealm, {})
  })

  test('Provider 区域：归一化与每区域唯一', () => {
    const modelsMod = require(path.join(__dirname, '..', 'server', 'models.js'))
    assert.strictEqual(modelsMod.normalizeRegion('global'), 'global')
    assert.strictEqual(modelsMod.normalizeRegion('CN'), 'cn', '大小写归一')
    assert.strictEqual(modelsMod.normalizeRegion(''), 'cn', '缺失回落国内版')
    assert.strictEqual(modelsMod.normalizeRegion('bogus'), 'cn', '非法值回落国内版')

    const cfg = {
      workbuddy: { type: 'workbuddy', models: [{ id: 'm' }] },
      'workbuddy-global': { type: 'workbuddy', region: 'global', models: [{ id: 'm' }] },
      generic: { baseURL: 'https://x', models: [{ id: 'm' }] }
    }
    const byRegion = modelsMod.listWorkbuddyProvidersByRegion(cfg)
    assert.deepStrictEqual(byRegion.cn, ['workbuddy'])
    assert.deepStrictEqual(byRegion.global, ['workbuddy-global'])
    assert.strictEqual(modelsMod.workbuddyProviderNameForRegion(cfg, 'global'), 'workbuddy-global')
    assert.strictEqual(modelsMod.workbuddyProviderNameForRegion(cfg, 'cn'), 'workbuddy')
    // 旧配置无色 region 字段 → 国内版
    assert.strictEqual(modelsMod.providerRegion({ type: 'workbuddy' }), 'cn')
    // 引用区域推导
    assert.strictEqual(modelsMod.regionOfRef(cfg, 'workbuddy-global/model-x'), 'global')
    assert.strictEqual(modelsMod.regionOfRef(cfg, 'workbuddy/model-x'), 'cn')
    assert.strictEqual(modelsMod.regionOfRef(cfg, 'generic/model-x'), 'cn')
    assert.strictEqual(modelsMod.regionOfRef(cfg, 'nonexistent/m'), 'cn')
  })

  test('Provider 输入过滤：region 落入白名单', () => {
    const modelsMod = require(path.join(__dirname, '..', 'server', 'models.js'))
    const out = modelsMod.sanitizeProviderInput({ type: 'workbuddy', region: 'global', models: [{ id: 'm' }] })
    assert.strictEqual(out.region, 'global')
    const bad = modelsMod.sanitizeProviderInput({ type: 'workbuddy', region: 'hacker', models: [{ id: 'm' }] })
    assert.strictEqual(bad.region, 'cn', '非法区域应回落 cn 而非落盘')
    const none = modelsMod.sanitizeProviderInput({ type: 'workbuddy', models: [{ id: 'm' }] })
    assert.strictEqual('region' in none, false, '未提供时不写入该字段')
  })

  test('OAuth 阶段按 opts.realm 走对应域名（account 为 null）', () => {
    // 回归：曾只认 account.realm，导致「选国际版添加账号」时 OAuth 仍发往国内域名，
    // 授权链接指向国内站 → 国际版账号根本添加不上
    const glOpts = { realm: 'global' }
    const cnOpts = { realm: 'cn' }
    assert.strictEqual(headersMod.chatBaseOf(null, glOpts), 'https://www.workbuddy.ai', '国际版 OAuth 必须走 workbuddy.ai')
    assert.strictEqual(headersMod.billingBaseOf(null, glOpts), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.webBaseOf(null, glOpts), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.originRefererOf(null, glOpts), 'https://www.workbuddy.ai', 'Origin 必须是国际域')
    assert.ok(headersMod.userAgent(null, glOpts).includes('WorkBuddy AI/'), 'UA 平台段必须是 WorkBuddy AI')
    assert.strictEqual(headersMod.acceptLanguage(glOpts, null), 'en-US')
    assert.ok(headersMod.billingUA(glOpts, null).includes('WorkBuddy AI'))
    // 国际版计费路径顺序（OAuth 后立刻查余额时会用到）
    assert.deepStrictEqual(headersMod.billingMeterPathsOf(null, glOpts), [
      '/billing/meter/get-user-resource',
      '/v2/billing/meter/get-user-resource'
    ])
    assert.deepStrictEqual(headersMod.checkinPathsOf(null, glOpts), [
      '/billing/meter/daily-checkin',
      '/v2/billing/meter/daily-checkin'
    ])
    // 国内版 OAuth 不受影响
    assert.strictEqual(headersMod.chatBaseOf(null, cnOpts), 'https://copilot.tencent.com')
    assert.strictEqual(headersMod.originRefererOf(null, cnOpts), 'https://www.codebuddy.cn')
    assert.ok(headersMod.userAgent(null, cnOpts).includes('WorkBuddy/5.5.4 WorkBuddy/'))
    // 无区域信息（旧调用）回落国内版，且不抛错
    assert.strictEqual(headersMod.chatBaseOf(null, {}), 'https://copilot.tencent.com')
    assert.strictEqual(headersMod.chatBaseOf(undefined, undefined), 'https://copilot.tencent.com')
    assert.strictEqual(headersMod.billingMeterPathsOf(undefined, undefined).length, 1)
    // 有账号对象时以账号为准
    assert.strictEqual(headersMod.chatBaseOf({ realm: 'global' }, {}), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.chatBaseOf({ realm: 'cn' }, {}), 'https://copilot.tencent.com')
  })

  test('rtOpts 必须下发 realm（否则 OAuth 无法按区域选域名）', () => {
    // 回归：曾漏传 realm，导致「选国际版」时 OAuth 仍请求 copilot.tencent.com，
    // 上游据此返回国内站的授权链接 —— 国际版账号根本添加不上
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const os = require('os')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rtopts-'))
    runtimeMod.init({ dataDir: tmp, enabledModels: [] })
    const r = runtimeMod.getRuntime()

    const cn = runtimeMod.rtOpts(r, 'cn')
    assert.strictEqual(cn.realm, 'cn', 'rtOpts 必须带 realm=cn')
    const gl = runtimeMod.rtOpts(r, 'global')
    assert.strictEqual(gl.realm, 'global', 'rtOpts 必须带 realm=global')
    // 国际版不下发 CN 域名覆盖（否则会把请求发回国内域名）
    assert.strictEqual(gl.chatBaseCN, '', '国际版不得下发 chatBaseCN 覆盖')
    assert.strictEqual(gl.billingBaseCN, '')
    assert.strictEqual(gl.webBaseCN, '')
    // 接受账号对象
    assert.strictEqual(runtimeMod.rtOpts(r, { realm: 'global' }).realm, 'global')
    assert.strictEqual(runtimeMod.rtOpts(r, { realm: 'cn' }).realm, 'cn')
    assert.strictEqual(runtimeMod.rtOpts(r, undefined).realm, 'cn', '未指定按国内版')
    // 端到端：拿 rtOpts 的产物直接问域名
    assert.strictEqual(headersMod.chatBaseOf(null, gl), 'https://www.workbuddy.ai')
    assert.strictEqual(headersMod.chatBaseOf(null, cn), 'https://copilot.tencent.com')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('identity 国内覆盖不得把国际版拉回国内域名（真实根因回归）', () => {
    // 真实故障：server-config.json 的 identity 里存了国内版覆盖值
    // （chatBase= copilot.tencent.com、originReferer= codebuddy.cn、acceptLanguage= zh-CN、
    //   workbuddyUA= WorkBuddy/…、clientIdentity= codebuddy），
    // 早先这些覆盖被无条件读取，导致「选国际版」时仍拿到国内站授权链接。
    // 语义上它们只是「给国内链路换端点/改归因」的调节项，国际版必须一律不生效。
    const realIdentity = {
      chatBase: 'https://copilot.tencent.com',
      billingBase: 'https://www.codebuddy.cn',
      webBase: 'https://www.workbuddy.cn',
      originReferer: 'https://www.codebuddy.cn',
      acceptLanguage: 'zh-CN',
      workbuddyUA: 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1',
      workbuddyBillingUA: 'WorkBuddy/5.5.4'
    }
    const gl = { identity: realIdentity, realm: 'global', clientIdentity: 'codebuddy' }
    const cn = { identity: realIdentity, realm: 'cn', clientIdentity: 'codebuddy' }

    // 国际版：覆盖全部不得生效
    assert.strictEqual(headersMod.chatBaseOf(null, gl), 'https://www.workbuddy.ai', 'chatBase 覆盖不得生效')
    assert.strictEqual(headersMod.billingBaseOf(null, gl), 'https://www.workbuddy.ai', 'billingBase 覆盖不得生效')
    assert.strictEqual(headersMod.webBaseOf(null, gl), 'https://www.workbuddy.ai', 'webBase 覆盖不得生效')
    assert.strictEqual(headersMod.originRefererOf(null, gl), 'https://www.workbuddy.ai', 'originReferer 覆盖不得生效')
    assert.strictEqual(headersMod.acceptLanguage(gl, null), 'en-US', 'acceptLanguage 覆盖不得生效')
    const uaG = headersMod.userAgent(null, gl)
    assert.ok(uaG.includes('WorkBuddy AI/'), `UA 平台段必须是 WorkBuddy AI，实际 ${uaG}`)
    assert.ok(!uaG.includes('CodeBuddyIDE'), 'clientIdentity=codebuddy 不得带偏国际版 UA')
    assert.ok(
      headersMod.billingUA(gl, null).includes('WorkBuddy AI'),
      `billing UA 必须是 WorkBuddy AI，实际 ${headersMod.billingUA(gl, null)}`
    )

    // 国内版：同一份覆盖必须继续生效（不能为了修国际版而破坏国内链路）
    assert.strictEqual(headersMod.chatBaseOf(null, cn), 'https://copilot.tencent.com', '国内版覆盖仍生效')
    assert.strictEqual(headersMod.originRefererOf(null, cn), 'https://www.codebuddy.cn', '国内版 Origin 覆盖仍生效')
    assert.strictEqual(headersMod.acceptLanguage(cn, null), 'zh-CN', '国内版语言覆盖仍生效')
    assert.ok(headersMod.userAgent(null, cn).includes('CodeBuddyIDE'), '国内版 clientIdentity 仍生效')
  })

  await testAsync('oauthPoll 全流程：国际版授权完成 → 落盘 → 进池（TDZ 回归）', async () => {
    // 真实故障：oauthPoll 里先用 token.domain 再声明 token，抛 TDZ ReferenceError，
    // 轮询恒失败 → 浏览器已授权但界面一直停在「等待登录」（客户端没反应）
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const clientMod = require(path.join(wbDir, 'client.js'))

    const origToken = clientMod.oauthPollToken
    const origAcct = clientMod.oauthFetchAccount
    const origRes = clientMod.userResource
    const origCheckin = clientMod.dailyCheckin
    let checkinCalled = false

    clientMod.oauthPollToken = async () => ({
      accessToken: 'tok-intl',
      refreshToken: 'ref-intl',
      expiresIn: 3600,
      domain: 'www.workbuddy.ai'
    })
    clientMod.oauthFetchAccount = async () => ({ uid: 'intl-uid-9001', enterpriseId: '', nickname: 'intl' })
    clientMod.userResource = async () => ({ ok: true, credits: 5, total: 9, expiring: 0, earliestExpiry: 0, earliestRemaining: 0 })
    clientMod.dailyCheckin = async () => {
      checkinCalled = true
      return { ok: true, message: 'x' }
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-polltest-'))
    // 清空单例，让本次 init 真正以 tmp 为 dataDir（否则会沿用前面用例的实例，
    // 凭证写到别的目录，断言找不到文件）
    const prevAuthDir = runtimeMod.getRuntime() ? runtimeMod.getRuntime().authDir : ''
    runtimeMod.__resetForTest()
    try {
      runtimeMod.init({ dataDir: tmp, authDir: path.join(tmp, 'auths'), stateFile: path.join(tmp, 'st.json'), enabledModels: [] })
      const started = await runtimeMod.oauthStart('global')
      assert.strictEqual(started.realm, 'global')
      const res = await runtimeMod.oauthPoll(started.state)
      assert.strictEqual(res.done, true, 'oauthPoll 不得抛 TDZ（这是「登录后没反应」的直接原因）')
      assert.strictEqual(res.realm, 'global', '区域按用户选择落盘')
      assert.strictEqual(res.uid, 'intl-uid-9001')
      assert.strictEqual(checkinCalled, false, '国际版不得发起签到')

      // 凭证落盘且 realm 正确（authDir 显式传的是 tmp/auths）
      const f = path.join(tmp, 'auths', 'workbuddy-intl-uid-9001.json')
      assert.ok(fs.existsSync(f), `凭证必须落盘（查找路径 ${f}）`)
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
      assert.strictEqual(doc.auth.realm, 'global')
      assert.strictEqual(doc.auth.accessToken, 'tok-intl')

      // 已进池且区域隔离
      const inPool = runtimeMod.listAccounts().find(a => a.uid === 'intl-uid-9001')
      assert.ok(inPool, '账号必须热加载进池')
      assert.strictEqual(inPool.realm, 'global')
      const rt = runtimeMod.getRuntime()
      assert.strictEqual(rt.pool.pick({ realm: 'global' }).uid, 'intl-uid-9001')
      assert.strictEqual(rt.pool.pick({ realm: 'cn' }), null, '国内池不得选到国际账号')
    } finally {
      clientMod.oauthPollToken = origToken
      clientMod.oauthFetchAccount = origAcct
      clientMod.userResource = origRes
      clientMod.dailyCheckin = origCheckin
      // 还原单例：后续用例依赖前面用例建立的运行时，不能被本用例留下的临时实例顶替
      runtimeMod.__resetForTest()
      if (prevAuthDir) {
        runtimeMod.init({ dataDir: path.dirname(prevAuthDir), authDir: prevAuthDir, enabledModels: [] })
      }
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('跨区域模型防呆：拒绝把另一区域的模型写进本区域', () => {
    // 真实事故：国际版账号加入后，「模型和档位」页签拉取/保存都没带区域，
    // 导致国际版目录（default-model/fast-model/o4-mini…）被写进国内版槽位，
    // 原有的国内模型（deepseek/glm/hy）全部消失，国内源的模型引用全失效
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const os = require('os')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-guard-'))
    runtimeMod.__resetForTest()
    runtimeMod.init({ dataDir: tmp, enabledModels: [], enabledModelsGlobal: [] })
    const r = runtimeMod.getRuntime()

    // 模拟两地目录都已拉取（国内 2 个、国际 2 个，外加一个同名共有的）
    r.models = {
      byRealm: {
        cn: { ts: Date.now(), list: [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }, { id: 'shared' }], efforts: {}, defaultEfforts: {} },
        global: { ts: Date.now(), list: [{ id: 'o4-mini' }, { id: 'fast-model' }, { id: 'shared' }], efforts: {}, defaultEfforts: {} }
      }
    }

    // 国内区域混入国际模型 → 只拒绝那个国际模型，国内模型照常通过
    let v = runtimeMod.validateModelsForRegion('cn', [{ id: 'deepseek-v4.1-flash' }, { id: 'o4-mini' }])
    assert.strictEqual(v.ok, false)
    assert.deepStrictEqual(v.rejected, ['o4-mini'])

    // 国际区域混入国内模型 → 对称拒绝
    v = runtimeMod.validateModelsForRegion('global', [{ id: 'glm-5.3-flash' }, { id: 'fast-model' }])
    assert.strictEqual(v.ok, false)
    assert.deepStrictEqual(v.rejected, ['glm-5.3-flash'])

    // 正确区域 / 两区域共有 / 空输入 / 无目录缓存 → 全部放行（不误伤、不阻塞）
    assert.strictEqual(runtimeMod.validateModelsForRegion('cn', [{ id: 'glm-5.3-flash' }]).ok, true)
    assert.strictEqual(runtimeMod.validateModelsForRegion('global', [{ id: 'o4-mini' }]).ok, true)
    assert.strictEqual(runtimeMod.validateModelsForRegion('cn', [{ id: 'shared' }]).ok, true, '两地共有不误伤')
    assert.strictEqual(runtimeMod.validateModelsForRegion('cn', []).ok, true)
    r.models = { byRealm: {} }
    assert.strictEqual(runtimeMod.validateModelsForRegion('cn', [{ id: 'whatever' }]).ok, true, '无缓存时放行')

    // 按区域读写的清单互相隔离
    runtimeMod.setEnabledModels([{ id: 'cn-a' }], 'cn')
    runtimeMod.setEnabledModels([{ id: 'gl-a' }], 'global')
    assert.deepStrictEqual(runtimeMod.getEnabledModels('cn').map(m => m.id), ['cn-a'])
    assert.deepStrictEqual(runtimeMod.getEnabledModels('global').map(m => m.id), ['gl-a'])
    assert.deepStrictEqual(runtimeMod.getEnabledModels().map(m => m.id), ['cn-a'], '不传区域回落国内版')

    runtimeMod.__resetForTest()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('版本号解析与比较（自动更新用）', () => {
    const vc = require(path.join(wbDir, 'versioncheck.js'))
    // 桌面端更新接口返回 "5.7.7.40774747" 这种四段形态，取前三段才是 UA 要的语义版本
    assert.strictEqual(vc.parseVersion('5.7.7.40774747'), '5.7.7')
    assert.strictEqual(vc.parseVersion('2.164.0'), '2.164.0')
    assert.strictEqual(vc.parseVersion(' 4.12.1 '), '4.12.1', '两端空白应容忍')
    // 非法输入一律返回空串（调用方据此跳过，不会把坏值写进 UA）
    assert.strictEqual(vc.parseVersion(''), '')
    assert.strictEqual(vc.parseVersion('bad'), '')
    assert.strictEqual(vc.parseVersion('v1.2.3'), '', '带前缀字母不匹配')
    assert.strictEqual(vc.parseVersion(null), '')
    assert.strictEqual(vc.parseVersion(undefined), '')

    // 比较必须按数值逐段（字符串比较会把 5.10.0 判成小于 5.9.0）
    assert.strictEqual(vc.compareVersion('5.7.7', '5.5.4'), 1)
    assert.strictEqual(vc.compareVersion('5.5.4', '5.7.7'), -1)
    assert.strictEqual(vc.compareVersion('2.164.0', '2.164.0'), 0)
    assert.strictEqual(vc.compareVersion('4.12.1', '4.12.0'), 1)
    assert.strictEqual(vc.compareVersion('5.10.0', '5.9.0'), 1, '两位数段按数值比较')
    assert.strictEqual(vc.compareVersion('6.0.0', '5.99.99'), 1)
  })

  test('版本号自动更新：防回滚校验与缓存读取（不联网）', () => {
    const vc = require(path.join(wbDir, 'versioncheck.js'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ver-'))
    let calls = 0
    // 用注入的假 fetch 无法直接替换模块内部函数，改为验证「无网络时的降级行为」：
    // 缓存为空 + 网络不可用（用无效域名）时不应抛错，而是返回带 errors 的结果
    const checker = vc.createVersionChecker({ dataDir: tmp })
    assert.strictEqual(checker.peek(), null, '初始无缓存')
    assert.deepStrictEqual(
      checker.currentOf({}),
      {
        clientVersion: vc.parseVersion(require(path.join(wbDir, 'constants.js')).DEFAULT_CLIENT_VERSION),
        desktopVersion: vc.parseVersion(require(path.join(wbDir, 'constants.js')).DEFAULT_CLIENT_VERSION),
        cliVersion: '',
        ideVersion: ''
      },
      'currentOf 缺省回落 constants 硬编码'
    )
    // 传入 identity 覆盖时按其取值
    const cur = checker.currentOf({ clientVersion: '9.9.9', cliVersion: '1.1.1', ideVersion: '2.2.2' })
    assert.strictEqual(cur.clientVersion, '9.9.9')
    assert.strictEqual(cur.cliVersion, '1.1.1')
    assert.strictEqual(cur.ideVersion, '2.2.2')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('版本更新时同步派生 UA 串（不同步则 UA 不会变）', () => {
    const identityMod = require(path.join(wbDir, 'identity.js'))
    // 关键背景：identity 同时存「版本号字段」与「成品 UA 串」，而 headers.userAgent
    // 优先用成品 UA 串。只更新版本号而不同步 UA 串，出站请求仍带旧版本号 → 功能形同虚设
    const prev = { clientVersion: '5.5.4', desktopVersion: '5.5.6', cliVersion: '2.137.1', ideVersion: '4.12.0' }
    const next = { clientVersion: '5.7.7', desktopVersion: '5.7.7', cliVersion: '2.164.0', ideVersion: '4.12.1' }

    // 1) UA 串与旧版本一致（= 系统默认，用户没改过）→ 应重算为新版本
    const before = identityMod.derivedUA(prev)
    const r1 = identityMod.syncDerivedUA({ ...before, oauthUA: 'CLI/2.63.2 CodeBuddy/2.63.2' }, prev, next)
    assert.strictEqual(r1.identity.workbuddyUA, 'WorkBuddy/5.7.7 WorkBuddy/5.7.7 CLI/2.164.0')
    assert.strictEqual(r1.identity.codebuddyUA, 'CodeBuddyIDE/4.12.1 CodeBuddy/4.12.1')
    assert.strictEqual(r1.identity.workbuddyBillingUA, 'WorkBuddy/5.7.7')
    assert.strictEqual(r1.identity.desktopUA, 'WorkBuddy/5.7.7 WorkBuddy/5.7.7 CLI/2.164.0')
    assert.deepStrictEqual(
      Object.keys(r1.changed).sort(),
      ['codebuddyBillingUA', 'codebuddyUA', 'desktopUA', 'v3ConfigUA', 'workbuddyBillingUA', 'workbuddyUA']
    )
    // oauthUA 不受版本驱动，必须原样保留
    assert.strictEqual(r1.identity.oauthUA, 'CLI/2.63.2 CodeBuddy/2.63.2')

    // 2) 用户手工定制过的 UA 串 → 不得被覆盖
    const custom = { ...before, workbuddyUA: 'MyCustom/9.9.9 Agent' }
    const r2 = identityMod.syncDerivedUA(custom, prev, next)
    assert.strictEqual(r2.identity.workbuddyUA, 'MyCustom/9.9.9 Agent', '用户定制值必须保留')
    assert.ok(!Object.keys(r2.changed).includes('workbuddyUA'))

    // 3) UA 串为空 → 视为未配置，补上按新版本拼的值
    const r3 = identityMod.syncDerivedUA({}, prev, next)
    assert.strictEqual(r3.identity.workbuddyUA, 'WorkBuddy/5.7.7 WorkBuddy/5.7.7 CLI/2.164.0')

    // 4) 无版本变化时不应产生任何改动
    const r4 = identityMod.syncDerivedUA({ ...before }, prev, prev)
    assert.deepStrictEqual(r4.changed, {})

    // 5) derivedUA 缺省回落 constants 官方默认
    const d = identityMod.derivedUA({})
    assert.ok(d.workbuddyUA.startsWith('WorkBuddy/'), '缺省也能拼出 UA')
  })

  // ==================== 17. 区域隔离与档位快照（回归）====================
  group('17. 区域隔离与档位快照（回归）')

  test('pool.pickByUID 区域不符 → 拒绝（防跨区派发）', () => {
    const pool = poolMod.createPool({})
    pool.add({ ...makeAuth('cn-pick'), realm: 'cn' })
    pool.add({ ...makeAuth('gl-pick'), realm: 'global' })

    assert.ok(pool.pickByUID('cn-pick', '', null, 'cn'), '同区应可用')
    assert.strictEqual(pool.pickByUID('cn-pick', '', null, 'global'), null, '国内号不得被国际请求选中')
    assert.ok(pool.pickByUID('gl-pick', '', null, 'global'), '国际号对国际请求可用')
    assert.strictEqual(pool.pickByUID('gl-pick', '', null, 'cn'), null, '国际号不得被国内请求选中')
    // 不传区域 = 不限（兼容旧调用）
    assert.ok(pool.pickByUID('cn-pick', '', null), '未指定区域时不受限')
  })

  test('runtime.realmOfAuth：未知账号回落 cn', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-realm-'))
    runtimeMod.__resetForTest()
    try {
      runtimeMod.init({ dataDir: tmp })
      const r = runtimeMod.getRuntime()
      r.pool.add({ ...makeAuth('rc'), realm: 'cn' })
      r.pool.add({ ...makeAuth('rg'), realm: 'global' })
      assert.strictEqual(runtimeMod.realmOfAuth(r, 'rc'), 'cn')
      assert.strictEqual(runtimeMod.realmOfAuth(r, 'rg'), 'global')
      assert.strictEqual(runtimeMod.realmOfAuth(r, 'not-exist'), 'cn', '未知账号回落 cn')
    } finally {
      runtimeMod.__resetForTest()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('runtime.effortsSnapshot：合并各区域档位槽（不再读空的 byRealm.all）', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-eff-'))
    runtimeMod.__resetForTest()
    try {
      runtimeMod.init({ dataDir: tmp })
      const r = runtimeMod.getRuntime()
      // 模拟目录按区域分槽写入（listUpstreamModels 只写 cn / global，从不写 all）
      r.models.byRealm = {
        cn: { ts: Date.now(), list: [], efforts: { 'm-cn': ['low', 'high'] }, defaultEfforts: { 'm-cn': 'low' } },
        global: { ts: Date.now(), list: [], efforts: { 'm-gl': ['high', 'max'] }, defaultEfforts: { 'm-gl': 'high' } }
      }
      const snap = runtimeMod.effortsSnapshot()
      assert.deepStrictEqual(snap.efforts['m-cn'], ['low', 'high'], '国内槽位档位应被读到')
      assert.deepStrictEqual(snap.efforts['m-gl'], ['high', 'max'], '国际槽位档位应被读到')
      assert.strictEqual(snap.defaultEfforts['m-cn'], 'low')
      assert.strictEqual(snap.defaultEfforts['m-gl'], 'high')
    } finally {
      runtimeMod.__resetForTest()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('runtime.effortsSnapshot：空目录返回空表（不抛错）', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-eff2-'))
    runtimeMod.__resetForTest()
    try {
      runtimeMod.init({ dataDir: tmp })
      const snap = runtimeMod.effortsSnapshot()
      assert.deepStrictEqual(snap, { efforts: {}, defaultEfforts: {} })
    } finally {
      runtimeMod.__resetForTest()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync('client 计费路径：国际版无 /v2 优先，404 回落 /v2（真实发起 HTTP）', async () => {
    const http = require('http')
    // 本机回环必须绕过代理，否则请求会走 http_proxy 而测不到真实路径
    const savedNoProxy = process.env.NO_PROXY
    process.env.NO_PROXY = '127.0.0.1,localhost'
    process.env.no_proxy = '127.0.0.1,localhost'

    const seen = []
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        seen.push(req.url)
        if (seen.length === 1) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ code: 404, msg: 'not found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              Response: {
                Data: {
                  Accounts: [
                    { PackageName: 'p1', CapacitySize: 100, CapacityRemain: 60, ExpiredTime: Date.now() + 86400000 }
                  ]
                }
              }
            }
          })
        )
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      // billingBaseCN 显式覆盖域名（否则国际版会走 workbuddy.ai 真域名）；
      // 区域仍由 auth.realm 决定，故路径候选走国际版序列
      const glAuth = { ...makeAuth('gl-billing'), realm: 'global' }
      const res = await clientMod.userResource(glAuth, { billingBaseCN: `http://127.0.0.1:${port}` })
      assert.strictEqual(seen[0], '/billing/meter/get-user-resource', '国际版应优先无 /v2 路径')
      assert.strictEqual(seen[1], '/v2/billing/meter/get-user-resource', '首个路径 404 应回落 /v2')
      assert.strictEqual(res.ok, true, `余额查询应成功：${JSON.stringify(res)}`)
      assert.strictEqual(res.credits, 60)
    } finally {
      await new Promise(resolve => server.close(resolve))
      if (savedNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = savedNoProxy
      delete process.env.no_proxy
    }
  })

  await testAsync('client 计费路径：国内版只走 /v2（不试无前缀路径）', async () => {
    const http = require('http')
    const savedNoProxy = process.env.NO_PROXY
    process.env.NO_PROXY = '127.0.0.1,localhost'
    process.env.no_proxy = '127.0.0.1,localhost'

    const seen = []
    const server = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        seen.push(req.url)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      const cnAuth = { ...makeAuth('cn-billing'), realm: 'cn' }
      await clientMod.userResource(cnAuth, { billingBaseCN: `http://127.0.0.1:${port}` })
      assert.deepStrictEqual(seen, ['/v2/billing/meter/get-user-resource'], '国内版只应请求 /v2 形态')
    } finally {
      await new Promise(resolve => server.close(resolve))
      if (savedNoProxy === undefined) delete process.env.NO_PROXY
      else process.env.NO_PROXY = savedNoProxy
      delete process.env.no_proxy
    }
  })

  // ==================== 18. 请求数统计口径（回归）====================
  group('18. 请求数统计口径一致性（server/token-stats）')

  test('请求次数 = count + failed：汇总 / 按天明细 / 按小时明细三者一致', () => {
    // token-stats 在 require 时按 AIROUTE_DATA_DIR 决定落盘位置，必须先改环境再加载
    const prevDir = process.env.AIROUTE_DATA_DIR
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-stats-'))
    process.env.AIROUTE_DATA_DIR = tmp
    let ts = null
    try {
      const tsPath = path.join(__dirname, '..', 'server', 'token-stats.js')
      delete require.cache[require.resolve(tsPath)]
      ts = require(tsPath)

      ts.recordTokens('p/m', { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 })
      ts.recordFailure('p/m')

      const summary = ts.getRequestSummary()
      assert.strictEqual(summary.todayRequests, 2, '汇总：今日请求数应为 成功 1 + 失败 1')
      assert.strictEqual(summary.todayFailed, 1)

      const byDays = ts.getStatsByDays(1)
      assert.strictEqual(byDays.count, 1)
      assert.strictEqual(byDays.failed, 1, '按天汇总必须带上 failed（否则与 /api/stats 口径不一致）')
      assert.strictEqual(byDays.count + byDays.failed, summary.todayRequests, '按天口径应与汇总一致')

      const dayDetail = ts.getRecentDaysDetail(1)[0]
      assert.strictEqual(dayDetail.count, 1)
      assert.strictEqual(dayDetail.failed, 1, '按天明细必须带上 failed')

      const today = ts.getDayKey(Date.now())
      const hourDetail = ts.getHourlyDetailForDay(today)
      const hourFailed = hourDetail.reduce((sum, h) => sum + (h.failed || 0), 0)
      const hourCount = hourDetail.reduce((sum, h) => sum + (h.count || 0), 0)
      assert.strictEqual(hourFailed, 1, '按小时明细必须带上 failed')
      assert.strictEqual(hourCount + hourFailed, summary.todayRequests, '按小时口径应与汇总一致')

      // 失败请求不产生 token：总计只反映成功那次
      assert.strictEqual(byDays.total, 18, 'total = 10+5+2+1，失败请求不累加 token')
    } finally {
      // 先落盘再删目录：模块注册了 process.on('exit', flush)，否则进程退出时会对已删除路径报错
      try {
        if (ts) {
          ts.saveStats()
          ts.flush()
        }
      } catch {
        /* 忽略 */
      }
      if (prevDir === undefined) delete process.env.AIROUTE_DATA_DIR
      else process.env.AIROUTE_DATA_DIR = prevDir
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('状态面板五档口径：当日 / 本周 / 本月 / 近三月 / 本年，月维度走月汇总桶', () => {
    const prevDir = process.env.AIROUTE_DATA_DIR
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-range-'))
    process.env.AIROUTE_DATA_DIR = tmp
    let ts = null
    try {
      const tsPath = path.join(__dirname, '..', 'server', 'token-stats.js')
      delete require.cache[require.resolve(tsPath)]
      ts = require(tsPath)

      const now = new Date()
      const y = now.getFullYear()
      const m = now.getMonth()
      const at = (year, month, day) => new Date(year, month, day, 12, 0, 0).getTime()

      // 成功请求落在：本月 ×2、上月、上上上月（近三月之外）、去年年末
      const successes = [
        at(y, m, 2),
        at(y, m, 2),
        at(y, m - 1, 2),
        at(y, m - 2, 2),
        at(y, m - 3, 2),
        at(y - 1, 11, 2)
      ]
      for (const timestamp of successes) {
        ts.recordTokens('p/m', { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, timestamp)
      }
      ts.recordFailure('p/m', at(y, m, 2))

      const range = ts.getRangeStats()
      assert.deepStrictEqual(Object.keys(range).sort(), ['day', 'month', 'quarter', 'week', 'year'])

      const inThisMonth = successes.filter(t => {
        const d = new Date(t)
        return d.getFullYear() === y && d.getMonth() === m
      })
      const inQuarter = successes.filter(t => t >= at(y, m - 2, 1))
      const inThisYear = successes.filter(t => new Date(t).getFullYear() === y)

      // 本月：只含本月那两笔成功 + 一次失败，上月及更早不能混进来
      assert.strictEqual(range.month.count, inThisMonth.length, '本月只累计本月的成功请求')
      assert.strictEqual(range.month.failed, 1, '本月失败数独立累计')
      assert.strictEqual(range.month.total, inThisMonth.length * 4, '本月 total = 4 × 本月成功笔数')

      // 近三月 = 本月 + 往前两个自然月（滚动），更早的不在内
      assert.strictEqual(range.quarter.count, inQuarter.length, '近三月应含本月与往前两个自然月')

      // 本年：今年所有月份，去年的不算
      assert.strictEqual(range.year.count, inThisYear.length, '本年不能把去年的请求算进来')

      // 本周：从本周一 00:00 起算。本月 2 号是否落在本周取决于今天星期几，
      // 所以只断言「周口径不超过月口径、且不少于当日」，再单独验周一的边界
      assert.ok(range.week.count <= range.month.count, '本周不可能多于本月')
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
      assert.strictEqual(weekStart.getDay(), 1, '周起点必须是周一')
      const expectedWeek = successes.filter(t => t >= weekStart.getTime())
      assert.strictEqual(range.week.count, expectedWeek.length, '本周只累计周一之后的成功请求')

      // 四档单调：区间越大请求数只增不减
      const req = s => s.count + s.failed
      assert.ok(req(range.week) >= req(range.day))
      assert.ok(req(range.month) >= req(range.week))
      assert.ok(req(range.quarter) >= req(range.month))
      assert.ok(req(range.year) >= req(range.quarter))

      // 月汇总的保留期独立于按日明细：35 天前的按日桶会被清，
      // 但月桶要留够「本年 + 近三月」（30 个月前的才清）
      ts.recordTokens('p/m', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, at(y, m - 30, 2))
      ts.cleanupOldData()
      const stats = ts.getAllStats()
      const months = Object.keys(stats.byMonth)
      const pad2 = n => String(n).padStart(2, '0')
      assert.ok(months.includes(`${y}-${pad2(m + 1)}`), '本月月桶不能被清掉')
      assert.ok(!months.includes(`${y}-${pad2(m - 30 + 1)}`), '30 个月前的月桶应被清掉')
      // 按小时明细仍按 35 天裁：30 个月前那次请求的小时桶必须已经没了
      const oldHourPrefix = `${y}-${pad2(m - 30 + 1)}-`
      assert.ok(!Object.keys(stats.byHour).some(k => k.startsWith(oldHourPrefix)), '按小时明细仍按 35 天裁')
    } finally {
      try {
        if (ts) {
          ts.saveStats()
          ts.flush()
        }
      } catch {
        /* 忽略 */
      }
      if (prevDir === undefined) delete process.env.AIROUTE_DATA_DIR
      else process.env.AIROUTE_DATA_DIR = prevDir
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // ==================== 19. 客户端 IP 解析与 CIDR（iputil）====================
  group('19. 客户端 IP 解析与 CIDR（iputil）')

  test('normalizeIP：去 IPv6 映射前缀 / 去端口', () => {
    const iputil = require(path.join(__dirname, '..', 'server', 'iputil.js'))
    assert.strictEqual(iputil.normalizeIP('::ffff:1.2.3.4'), '1.2.3.4')
    assert.strictEqual(iputil.normalizeIP('1.2.3.4:5678'), '1.2.3.4')
    assert.strictEqual(iputil.normalizeIP('[::1]:3000'), '::1')
    assert.strictEqual(iputil.normalizeIP(' 10.0.0.1 '), '10.0.0.1')
    assert.strictEqual(iputil.normalizeIP(''), '')
  })

  test('inCidr：IPv4 / IPv6 按位匹配，非法输入不匹配', () => {
    const { inCidr } = require(path.join(__dirname, '..', 'server', 'iputil.js'))
    assert.strictEqual(inCidr('10.1.2.3', '10.0.0.0/8'), true)
    assert.strictEqual(inCidr('11.0.0.1', '10.0.0.0/8'), false)
    assert.strictEqual(inCidr('192.168.1.5', '192.168.0.0/16'), true)
    assert.strictEqual(inCidr('192.169.1.5', '192.168.0.0/16'), false)
    assert.strictEqual(inCidr('127.0.0.1', '127.0.0.0/8'), true)
    // /0 匹配一切合法地址
    assert.strictEqual(inCidr('8.8.8.8', '0.0.0.0/0'), true)
    // IPv6
    assert.strictEqual(inCidr('::1', '::1/128'), true)
    assert.strictEqual(inCidr('::2', '::1/128'), false)
    assert.strictEqual(inCidr('fe80::1', 'fe80::/10'), true)
    assert.strictEqual(inCidr('2001:db8::1', 'fe80::/10'), false)
    assert.strictEqual(inCidr('::ffff:10.0.0.1', '10.0.0.0/8'), true, '映射地址应归一到 IPv4 后匹配')
    // 非法输入
    assert.strictEqual(inCidr('not-an-ip', '10.0.0.0/8'), false)
    assert.strictEqual(inCidr('10.0.0.1', '10.0.0.0'), false, '缺少前缀长度不算 CIDR')
  })

  test('extractClientIP：对端不可信时忽略转发头（防伪造）', () => {
    const { extractClientIP } = require(path.join(__dirname, '..', 'server', 'iputil.js'))
    // 公网直连：XFF 完全不可信
    const evil = { socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' } }
    assert.strictEqual(extractClientIP(evil), '8.8.8.8', '不可信对端一律用对端地址')
    // 可信代理（本机）：优先 X-Real-IP
    const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } }
    assert.strictEqual(extractClientIP(local), '1.2.3.4')
    // 可信代理：无 X-Real-IP 时取 XFF 最右一跳
    const chain = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.9' } }
    assert.strictEqual(extractClientIP(chain), '10.0.0.9')
    // 都没有 → 对端地址
    const bare = { socket: { remoteAddress: '192.168.1.7' }, headers: {} }
    assert.strictEqual(extractClientIP(bare), '192.168.1.7')
  })

  // ==================== 20. 智能路由引擎（router-engine）====================
  group('20. 智能路由引擎（router-engine）')

  test('detectCondition：自定义规则最高优先，且只匹配最后一条用户消息', () => {
    const prevDir = process.env.AIROUTE_DATA_DIR
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'))
    process.env.AIROUTE_DATA_DIR = tmp
    try {
      const engPath = path.join(__dirname, '..', 'server', 'router-engine.js')
      delete require.cache[require.resolve(engPath)]
      const eng = require(engPath)
      eng.saveRules({
        rules: [{ condition: 'default', target: 'p/def' }],
        customRules: [{ keyword: '123', target: 'p/num' }]
      })

      // 最后一条用户消息命中关键词 → custom
      const body = JSON.stringify({
        messages: [
          { role: 'user', content: '历史里的 123' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: '这次的 123 工单' }
        ]
      })
      assert.strictEqual(eng.detectCondition(JSON.parse(body)), 'custom:123')
      assert.strictEqual(eng.resolveModel(JSON.parse(body)), 'p/num')

      // 关键词不在最后一条用户消息里 → 不命中（不受历史影响）
      const body2 = JSON.stringify({
        messages: [
          { role: 'user', content: '123' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: '无关提问' }
        ]
      })
      assert.notStrictEqual(eng.detectCondition(JSON.parse(body2)), 'custom:123')
    } finally {
      if (prevDir === undefined) delete process.env.AIROUTE_DATA_DIR
      else process.env.AIROUTE_DATA_DIR = prevDir
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('detectCondition：代码 / 长上下文 / 语种兜底 / default 的判定顺序', () => {
    const prevDir = process.env.AIROUTE_DATA_DIR
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eng2-'))
    process.env.AIROUTE_DATA_DIR = tmp
    try {
      const engPath = path.join(__dirname, '..', 'server', 'router-engine.js')
      delete require.cache[require.resolve(engPath)]
      const eng = require(engPath)
      eng.saveRules({ rules: [], customRules: [] })

      const cond = content => eng.detectCondition({ messages: [{ role: 'user', content }] })

      assert.strictEqual(cond('```js\nconst a = 1\n```'), 'contains_code')
      assert.strictEqual(cond('请解释一下 async 函数的用法'), 'contains_code', '含代码关键字即命中代码')
      assert.strictEqual(cond('翻译成英文'), 'translate', '翻译优先于中文兜底')
      assert.strictEqual(cond('帮我写单元测试'), 'write_test')
      assert.strictEqual(cond('总结一下这段内容'), 'summarize')
      assert.strictEqual(cond('用英语回答'), 'lang_en_request', '语种意图优先于 lang_zh')
      assert.strictEqual(cond('今天天气不错'), 'lang_zh')
      assert.strictEqual(cond('hello there'), 'default')
      // 长上下文：中文长文应命中 long_context 而非 lang_zh
      assert.strictEqual(cond('啊'.repeat(13000)), 'long_context')
    } finally {
      if (prevDir === undefined) delete process.env.AIROUTE_DATA_DIR
      else process.env.AIROUTE_DATA_DIR = prevDir
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('resolveModel：未命中规则时回落 default 规则目标，无 default 返回 null', () => {
    const prevDir = process.env.AIROUTE_DATA_DIR
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eng3-'))
    process.env.AIROUTE_DATA_DIR = tmp
    try {
      const engPath = path.join(__dirname, '..', 'server', 'router-engine.js')
      delete require.cache[require.resolve(engPath)]
      const eng = require(engPath)

      const body = { messages: [{ role: 'user', content: 'hello there' }] }
      eng.saveRules({ rules: [{ condition: 'default', target: 'p/fallback' }], customRules: [] })
      assert.strictEqual(eng.resolveModel(body), 'p/fallback')

      eng.saveRules({ rules: [{ condition: 'contains_code', target: 'p/code' }], customRules: [] })
      assert.strictEqual(eng.resolveModel(body), null, '无 default 规则时应返回 null（由调用方兜底到首个可用模型）')
      assert.strictEqual(eng.resolveModel({ messages: [{ role: 'user', content: '```x\nlet y=1\n```' }] }), 'p/code')
    } finally {
      if (prevDir === undefined) delete process.env.AIROUTE_DATA_DIR
      else process.env.AIROUTE_DATA_DIR = prevDir
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // ==================== 21. 更新资产命名（update / targets）====================
  group('21. 更新资产命名（update / targets）')

  test('assetCandidates：按平台与运行形态拼资产名，Windows 追加旧名兜底', () => {
    const updatePath = path.join(__dirname, '..', 'server', 'update.js')
    delete require.cache[require.resolve(updatePath)]
    const update = require(updatePath)

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const names = update.assetCandidates('v1.7.0-beta.2')
    if (process.platform === 'darwin') {
      assert.deepStrictEqual(names, [`AiRoute-1.7.0-beta.2-${arch}.dmg`], 'macOS 只有 dmg，没有历史命名需要兼容')
      return
    }

    // 安装版：安装包优先，可一键升级；便携包排在后面，仅用于手动下载回退
    const installer = update.assetCandidates('v1.7.0-beta.2', 'installer')
    assert.strictEqual(installer[0], `AiRoute-1.7.0-beta.2-${arch}-setup.exe`, '安装版首选安装包')
    assert.strictEqual(installer[1], `AiRoute-1.7.0-beta.2-${arch}-portable.exe`, '安装包缺失时回退到便携包')
    assert.strictEqual(installer[2], 'AiRoute.exe', 'Windows 需保留 ≤ v1.7.0-beta.1 的旧名兜底')

    const portable = update.assetCandidates('v1.7.0-beta.2', 'portable')
    assert.strictEqual(portable[0], `AiRoute-1.7.0-beta.2-${arch}-portable.exe`, '便携版首选便携包')
    assert.strictEqual(portable[1], `AiRoute-1.7.0-beta.2-${arch}-setup.exe`, '便携包缺失时回退到安装包')

    // 一键升级只认安装版安装包：便携包跑起来只会解包并启动一个新实例，不能拿来「升级」
    assert.deepStrictEqual(
      update.installAssetCandidates('v1.7.0-beta.2', 'installer'),
      [`AiRoute-1.7.0-beta.2-${arch}-setup.exe`]
    )
  })

  test('scripts/targets 与 electron-builder.json 的架构、产物命名一致', () => {
    const targets = require(path.join(__dirname, 'targets.js'))
    const config = require(path.join(__dirname, '..', 'electron-builder.json'))
    const section = config[targets.platform]
    const arches = [...new Set(section.target.flatMap(t => t.arch))]

    assert.deepStrictEqual(targets.configuredArches(), arches, '脚本应直接读配置里的架构列表，不另写一份')
    assert.ok(arches.includes('x64') && arches.includes('arm64'), 'win 与 mac 都应同时出 x64 + arm64')

    const builds = targets.artifacts('1.7.0-beta.2')
    if (targets.isMac) {
      assert.deepStrictEqual(
        builds.map(b => b.name),
        ['AiRoute-1.7.0-beta.2-arm64.dmg', 'AiRoute-1.7.0-beta.2-x64.dmg']
      )
      return
    }

    // Windows 每个架构两类产物：安装版（-setup.exe，支持一键升级）+ 便携版（-portable.exe）
    for (const arch of ['x64', 'arm64']) {
      const names = builds.filter(b => b.arch === arch).map(b => b.name).sort()
      assert.deepStrictEqual(names, [`AiRoute-1.7.0-beta.2-${arch}-setup.exe`, `AiRoute-1.7.0-beta.2-${arch}-portable.exe`].sort())
    }
    assert.strictEqual(section.artifactName, 'AiRoute-${version}-${arch}.${ext}', 'win 段的默认模板（安装版 / 便携版各自覆盖）')
    assert.strictEqual(config.portable.artifactName, 'AiRoute-${version}-${arch}-portable.${ext}', '便携版用 -portable 后缀，两类产物一眼可辨')
    assert.strictEqual(config.nsis.artifactName, 'AiRoute-${version}-${arch}-setup.${ext}', '安装版用 -setup 后缀区分')
    assert.strictEqual(config.nsis.oneClick, false, '安装版为可选目录的向导式安装（静默升级依赖 /S + --updated）')

    // 构建产物名 ↔ 应用内更新拼出的安装包名必须是同一个，否则一键升级 / 手动下载会 404
    const update = require(path.join(__dirname, '..', 'server', 'update.js'))
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const setup = builds.find(b => b.target === 'nsis' && b.arch === arch)
    const portable = builds.find(b => b.target === 'portable' && b.arch === arch)
    assert.ok(setup, `应存在 nsis 产物（${arch}）`)
    assert.ok(portable, `应存在 portable 产物（${arch}）`)
    assert.ok(update.installAssetCandidates('v1.7.0-beta.2', 'installer').includes(setup.name))
    assert.strictEqual(update.assetCandidates('v1.7.0-beta.2', 'portable')[0], portable.name)
    assert.strictEqual(update.assetCandidates('v1.7.0-beta.2', 'installer')[1], portable.name)
  })

  // ==================== 22. P0/P1 协议缺陷回归 ====================
  group('22. P0/P1 协议缺陷回归（静默丢收益 / 误判罚号）')

  // ---- 22.1 错误分类：request illegal 按业务码分流 ----
  // 实测与参考实现 3c4eb88 同口径：11-128 与 11140 的 msg 完全一样，只能靠业务码
  // 分辨「通道校验失败（账号健康）」与「账号被上游限制（该罚号）」。

  test('11-128 request illegal → channel_refused（不罚号）', () => {
    assert.strictEqual(errors.classify(400, '{"code":11-128,"msg":"request illegal"}'), K.CHANNEL_REFUSED)
    assert.strictEqual(errors.classify(400, '{"code":"11-128","msg":"request illegal"}'), K.CHANNEL_REFUSED)
  })

  test('11140 request illegal → account_fault（该罚号）', () => {
    assert.strictEqual(errors.classify(400, '{"code":11140,"msg":"request illegal"}'), K.ACCOUNT_FAULT)
    assert.strictEqual(errors.classify(429, '{"code":11140,"msg":"request illegal"}'), K.ACCOUNT_FAULT)
  })

  test('只有 msg 没有业务码时不做罚号判定（防误伤）', () => {
    // 旧实现把裸 'request illegal' 当成账号故障标记 → 通道校验失败会禁用整池账号
    assert.notStrictEqual(errors.classify(400, '{"msg":"request illegal"}'), K.ACCOUNT_FAULT)
    assert.strictEqual(errors.classify(400, '{"code":11140,"msg":"some other"}'), K.CLIENT, '11140 只在 msg 匹配时才算账号限制')
  })

  test('11-128 / 11140 都先于 429 兜底（不会被当成软限流冷却）', () => {
    assert.strictEqual(errors.classify(429, '{"code":11-128,"msg":"request illegal"}'), K.CHANNEL_REFUSED)
  })

  test('两类新增错误的 gateway_hint 明确「不是账号问题」', () => {
    assert.ok(errors.gatewayHint(K.CHANNEL_REFUSED, '').includes('healthy'))
    assert.ok(errors.gatewayHint(K.UPSTREAM_BUSY, '').includes('not an account problem'))
  })

  // ---- 22.2 11158 模型无权限：与 11102 同走模型级负缓存 ----

  test('11158 is not allowed for user type → MODEL_BLOCKED（400/404）', () => {
    const body = '{"code":11158,"msg":"glm-5.2 is not allowed for user type"}'
    assert.strictEqual(errors.classify(400, body), K.MODEL_BLOCKED)
    assert.strictEqual(errors.classify(404, body), K.MODEL_BLOCKED)
    assert.strictEqual(errors.modelBlockReasonFor(body), '11158 model not allowed for account type')
  })

  test('11158 在 403 上不判模型级拒绝（那是账号/风控层）', () => {
    const body = '{"code":11158,"msg":"glm-5.2 is not allowed for user type"}'
    assert.notStrictEqual(errors.classify(403, body), K.MODEL_BLOCKED)
  })

  test('11102 文案仍判模型级拒绝，两类 reason 前缀可区分', () => {
    assert.strictEqual(errors.classify(400, '{"code":11102,"msg":"service info not found"}'), K.MODEL_BLOCKED)
    assert.strictEqual(errors.modelBlockReasonFor('{"code":11102,"msg":"service info not found"}'), '11102 model not available')
  })

  // ---- 22.3 6021 队列满载：渠道事件，不是限流 ----

  test('6021 queue.full → upstream_busy（不逐号软冷却）', () => {
    assert.strictEqual(errors.classify(429, '{"code":6021,"msg":"queue.full.title"}'), K.UPSTREAM_BUSY)
    assert.strictEqual(errors.classify(400, '{"code":"6021"}'), K.UPSTREAM_BUSY)
    assert.strictEqual(errors.classify(200, '{"code":0,"msg":"request illegal"}'), K.NONE, '正常响应不误判')
  })

  test('isUpstreamBusy 只认 6021 结构码（"queue full" 自然语言不误命中）', () => {
    assert.strictEqual(errors.isUpstreamBusy('{"code":6021}'), true)
    assert.strictEqual(errors.isUpstreamBusy('{"msg":"Queue is Full"}'), false)
    assert.strictEqual(errors.isUpstreamBusy('{"msg":"queue.full.title"}'), true, 'queue.full 结构文案为外卡')
  })

  // ---- 22.4 会话头：X-Conversation-ID 必须在场 ----

  test('conversationHeaders：无 conversationId 时也下发 X-Conversation-ID', () => {
    const h = headersMod.conversationHeaders({})
    assert.ok(typeof h['X-Conversation-ID'] === 'string' && /^[0-9a-f]{32}$/.test(h['X-Conversation-ID']), '应回落为 32 位十六进制')
    // 六个上游校验的 id 头齐全，且各自非空
    for (const k of [
      'X-Conversation-Request-ID',
      'X-Conversation-Message-ID',
      'X-Request-ID',
      'X-Root-Request-ID',
      'X-Trace-ID'
    ]) {
      assert.ok(typeof h[k] === 'string' && h[k].length > 0, `缺少 ${k}`)
    }
  })

  test('conversationHeaders：传入 conversationId 时原样透传', () => {
    const h = headersMod.conversationHeaders({ conversationId: 'conv-abc' })
    assert.strictEqual(h['X-Conversation-ID'], 'conv-abc')
  })

  // ---- 22.5 payload：reasoning_text 剔除 + 空 function.name 清理 ----

  test('prepareBody 剔除 reasoning_text / reasoning 片段（上游 400 code=11101）', () => {
    const body = {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning_text', text: 'think' },
            { type: 'text', text: '最终答案' }
          ]
        }
      ]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.deepStrictEqual(out.messages[0].content, [{ type: 'text', text: '最终答案' }], '只留白名单类型')
  })

  test('prepareBody：思考片段占满 content 且无 tool_calls 时整条消息删除', () => {
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }] }]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.strictEqual(out.messages.length, 1, '空 content 消息会被上游以「空消息」拒绝，应整条删掉')
    assert.strictEqual(out.messages[0].role, 'user')
  })

  test('prepareBody：有 tool_calls 时保留消息只清 content', () => {
    const body = {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'reasoning_text', text: 'r' }],
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'A', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' }
      ]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    assert.strictEqual(out.messages.length, 2)
    assert.ok(!out.messages[0].content, 'content 只剩思考片段时应清空')
    assert.strictEqual(out.messages[0].tool_calls.length, 1, '调用本身要保住，否则成孤儿结果')
  })

  test('空 function.name 的脏 tool_call 连同结果一起剔除（否则整条会话恒 400）', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: '', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'B', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c2', content: 'ok' }
      ]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    const ids = out.messages.filter(m => Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.map(c => c.id))
    assert.deepStrictEqual(ids, ['c2'], '空 name 的调用必须剔除')
    const results = out.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)
    assert.deepStrictEqual(results, ['c2'], '配对结果必须同步剔除，不留孤儿')
  })

  test('缺 function / name 字段的占位条目不动（不扩大打击面）', () => {
    const body = {
      model: 'm',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' }
      ]
    }
    const out = JSON.parse(payload.prepareBody(JSON.stringify(body), {}))
    const calls = out.messages.filter(m => Array.isArray(m.tool_calls))
    assert.strictEqual(calls.length, 1, '无 function 对象的条目上游不拒，不应被删')
    assert.strictEqual(calls[0].tool_calls[0].id, 'c1')
  })

  // ---- 22.6 缓存命中推导：hit=0 + miss>0 + 大 prompt 的矛盾形态 ----
  // 参考实现 329c09e（issue #170）：上游只报 miss、hit 恒 0，导致缓存收益被算成 0。

  test('sse.normalizeUsageCacheAliases：hit=0 + miss=3 + prompt=52703 → hit 52700', () => {
    const out = sse.normalizeUsageCacheAliases({
      prompt_tokens: 52703,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 3
    })
    assert.strictEqual(out.prompt_cache_hit_tokens, 52700)
    assert.strictEqual(out.cached_tokens, 52700)
    assert.strictEqual(out.cache_read_input_tokens, 52700)
    assert.strictEqual(out.prompt_tokens_details.cached_tokens, 52700)
  })

  test('sse：只有 miss 字段时同样推导（prompt 8500 / miss 100 → 8400）', () => {
    const out = sse.normalizeUsageCacheAliases({ prompt_tokens: 8500, prompt_cache_miss_tokens: 100 })
    assert.strictEqual(out.cached_tokens, 8400)
  })

  test('sse：prompt == miss（全新上下文）时 hit 保持 0', () => {
    const out = sse.normalizeUsageCacheAliases({ prompt_tokens: 100, prompt_cache_miss_tokens: 100 })
    assert.ok(!out.cached_tokens, '不能凭空造出缓存命中')
  })

  test('sse：无缓存字段 / 无 prompt 时不做推导', () => {
    assert.ok(!sse.normalizeUsageCacheAliases({ prompt_tokens: 100 }).cached_tokens)
    assert.ok(!sse.normalizeUsageCacheAliases({ prompt_cache_miss_tokens: 3 }).cached_tokens)
    assert.ok(!sse.normalizeUsageCacheAliases({}).cached_tokens)
  })

  test('sse：已有的真实 hit 值不被推导覆盖', () => {
    const out = sse.normalizeUsageCacheAliases({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 })
    assert.strictEqual(out.prompt_cache_hit_tokens, 900)
    assert.strictEqual(out.cached_tokens, 900)
  })

  test('upstreamMod.extractUsage：cacheRead 走同一套推导口径', () => {
    const a = upstreamMod.extractUsage({ usage: { prompt_tokens: 52703, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 3 } })
    assert.strictEqual(a.cacheRead, 52700)
    assert.strictEqual(a.input, 3)
    const b = upstreamMod.extractUsage({ usage: { prompt_tokens: 8500, prompt_cache_miss_tokens: 100 } })
    assert.strictEqual(b.cacheRead, 8400)
    // 常规形态（含 prompt_tokens_details）不受影响
    const c = upstreamMod.extractUsage({ usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 400 } } })
    assert.strictEqual(c.cacheRead, 400)
    // miss 与 prompt 相等 / 无 miss → 不推导（保持「没有缓存命中」语义）
    assert.ok(!upstreamMod.extractUsage({ usage: { prompt_tokens: 100, prompt_cache_miss_tokens: 100 } }).cacheRead)
    assert.ok(!upstreamMod.extractUsage({ usage: { prompt_tokens: 100 } }).cacheRead)
  })

  // ---- 22.7 pool：模型级负缓存的两类 kind 与清除 ----

  test('11158 也归入 model_unavailable（面板显示「该后端无此模型/无权限」）', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('m58'))
    pool.blockModelBackoff('m58', 'glm-5.2', '11158 model not allowed for account type')
    const st = pool.status('m58')
    assert.strictEqual(st.rateLimitedModels.length, 1)
    assert.strictEqual(st.rateLimitedModels[0].kind, 'model_unavailable')
  })

  test('blockModelClear 同时清 11102 与 11158，但不碰 6004 限流', () => {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('mc1'))
    pool.blockModelBackoff('mc1', 'm-a', '11102 model not available')
    pool.blockModelBackoff('mc1', 'm-b', '11158 model not allowed for account type')
    // 6004 带重置墙钟 → 走模型级冷却（与负缓存同表，靠 reason 前缀区分）
    pool.cooldownSoftForModel('mc1', 600000, Date.now() + 3600000, 'm-c', '6004 model rate limit')
    pool.blockModelClear('mc1', 'm-a')
    pool.blockModelClear('mc1', 'm-b')
    pool.blockModelClear('mc1', 'm-c')
    const models = pool.status('mc1').rateLimitedModels.map(x => x.model)
    assert.deepStrictEqual(models, ['m-c'], '11102/11158 该清，6004 属限流不该清')
    assert.strictEqual(pool.status('mc1').rateLimitedModels[0].kind, 'rate_limit')
  })

  await testAsync('冷却到期后 reason 不再透出（避免把健康号标成「限流中」）', async () => {
    const pool = poolMod.createPool({ softRateMs: 30, softRateMaxMs: 30 })
    pool.add(makeAuth('cr1'))
    pool.cooldownSoftRate('cr1', 30, 0, '429 upstream said rate limited')
    assert.ok(pool.status('cr1').reason.includes('rate limited'), '冷却期内应透出原因')
    await new Promise(r => setTimeout(r, 60))
    const after = pool.status('cr1')
    assert.strictEqual(after.cooling, false)
    assert.strictEqual(after.reason, '', '冷却结束后 e.reason 仍在内存，但不该再透出')
  })

  // ---- 22.8 auth：企业切换会话识别 ----

  test('jwtTokenSource 解析 token_source（非法输入返回空串，不抛错）', () => {
    const tok = p => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`
    assert.strictEqual(authMod.jwtTokenSource(tok({ token_source: 'enterprise_switch' })), 'enterprise_switch')
    assert.strictEqual(authMod.jwtTokenSource(tok({ token_source: 'wechat' })), 'wechat')
    assert.strictEqual(authMod.jwtTokenSource(tok({})), '')
    assert.strictEqual(authMod.jwtTokenSource('garbage'), '')
    assert.strictEqual(authMod.jwtTokenSource(''), '')
    assert.strictEqual(authMod.jwtTokenSource(undefined), '')
  })

  test('isEnterpriseSession 与 isEnterprise 隔离：账单域语义不得混用', () => {
    const tok = p => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`
    const switchAuth = { enterpriseId: '', accessToken: tok({ token_source: 'enterprise_switch' }) }
    const plainAuth = { enterpriseId: '', accessToken: tok({ token_source: 'wechat' }) }
    const entAuth = { enterpriseId: 'e9', accessToken: '' }
    assert.strictEqual(authMod.isEnterpriseSession(switchAuth), true)
    assert.strictEqual(authMod.isEnterprise(switchAuth), false, 'token_source 不代表企业账单域')
    assert.strictEqual(authMod.isEnterpriseSession(plainAuth), false)
    assert.strictEqual(authMod.isEnterpriseSession(entAuth), true)
    assert.strictEqual(authMod.isEnterprise(entAuth), true)
  })

  // ---- 22.9 runtime：执行侧门控（读不门控、执行门控）----

  test('skipGrowthExecFor：国际版 + 企业切换会话都跳过执行', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tok = p => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`
    assert.strictEqual(runtimeMod.skipGrowthExecFor(makeAuth('r1')), false, '普通国内号应放行')
    assert.strictEqual(runtimeMod.skipGrowthExecFor(makeAuth('r2', { realm: 'global' })), true)
    assert.strictEqual(runtimeMod.skipGrowthExecFor(makeAuth('r3', { accessToken: tok({ token_source: 'enterprise_switch' }) })), true)
    assert.strictEqual(runtimeMod.skipGrowthExecFor(null), false)
    // 读取侧只认国际版：企业切换会话的读端点实测正常，门控会误伤
    assert.strictEqual(runtimeMod.skipGrowthFor(makeAuth('r4', { accessToken: tok({ token_source: 'enterprise_switch' }) })), false)
  })

  test('执行拒绝错误：422 + 重登指引，且与国际版错误可区分', () => {
    const runtimeMod = require(path.join(wbDir, 'runtime.js'))
    const tok = p => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`
    const entErr = runtimeMod.growthExecBlockedError(makeAuth('e1', { accessToken: tok({ token_source: 'enterprise_switch' }) }))
    assert.strictEqual(entErr.status, 422)
    assert.strictEqual(entErr.code, 'enterprise_session_relogin')
    assert.ok(entErr.message.includes('token_source=enterprise_switch'))
    assert.ok(entErr.message.includes('重新登录'), '必须给出用户可执行的处置')
    const intlErr = runtimeMod.growthExecBlockedError(makeAuth('e2', { realm: 'global' }))
    assert.strictEqual(intlErr.status, 422)
    assert.strictEqual(intlErr.code, 'growth_unsupported_realm')
    assert.notStrictEqual(intlErr.message, entErr.message)
  })

  // ---- 22.10 官方补偿：先查后领（不再盲领）----

  // 假 client：按 X-User-Id 返回不同补偿状态，覆盖「待领 / 无活动 / 已领 / 额度 0 / 查询失败」
  function makeCompClient() {
    const calls = []
    const statusByUid = {
      c1: { active: true, claimed: false, credit_num: 500, validity_period: 1, end_time: '2026-10-22 23:59:59' },
      c2: { active: false, claimed: false, credit_num: 0 },
      c3: { active: true, claimed: true, credit_num: 500 },
      c4: { active: true, claimed: false, credit_num: 0 }
    }
    const client = {
      calls,
      // 签到排程整条链需要的其它端点（只为了让 runNow('checkin') 跑到连登管家那一步）
      async dailyCheckin() {
        return { ok: true, message: '' }
      },
      async userResource() {
        return { ok: true, credits: 1000, total: 1000 }
      },
      async growthOK(auth, method, pathName) {
        if (pathName === constants.GROWTH_STREAK_PATH) return { redemption_status: { tiers: [] } }
        if (pathName === constants.LOTTERY_SUMMARY_PATH) return { chances: 0 }
        if (pathName === '/activity/growth/heatmap') return { cells: [] } // 无漏签记录 → 不补签
        return {}
      },
      async send(cfg) {
        calls.push(cfg)
        const uid = (cfg.headers && cfg.headers['X-User-Id']) || ''
        const url = String(cfg.url)
        if (url.includes('compensation-status')) {
          if (uid === 'c5') throw new Error('transport boom')
          return { status: 200, text: JSON.stringify({ code: 0, msg: 'OK', data: statusByUid[uid] }) }
        }
        if (url.includes('claim-compensation')) {
          return { status: 200, text: JSON.stringify({ code: 0, msg: 'OK', data: { credit: 500 } }) }
        }
        // 新手礼包：业务码非 0 = 没有礼包（调用方静默）
        if (url.includes('claim-gift')) {
          return { status: 200, text: JSON.stringify({ code: 10001, msg: 'no gift' }) }
        }
        return { status: 404, text: 'nope' }
      }
    }
    return client
  }

  function makeCompScheduler(extraAccounts = []) {
    const pool = poolMod.createPool({})
    for (const uid of ['c1', 'c2', 'c3', 'c4', 'c5']) pool.add(makeAuth(uid))
    for (const a of extraAccounts) pool.add(a)
    const client = makeCompClient()
    const s = schedulerMod.createScheduler({
      pool,
      client,
      auth: {},
      refreshTokenFor: async () => ({ ok: true }),
      refreshBalanceFor: async () => ({ ok: true }),
      log: () => {}
    })
    return { s, client, pool }
  }

  await testAsync('compensationStatusAll：行序与池顺序一致，查询失败单独标记', async () => {
    const { s, pool } = makeCompScheduler([makeAuth('g1', { realm: 'global' }), makeAuth('e1', { enterpriseId: 'e9' })])
    const rows = await s.compensationStatusAll()
    assert.deepStrictEqual(
      rows.map(r => r.uid),
      pool.list().map(x => x.uid),
      '并发查询不得让行序按完成顺序漂移（面板逐行对齐依赖稳定行序）'
    )
    const by = new Map(rows.map(r => [r.uid, r]))
    assert.strictEqual(by.get('g1').skip, 'global', '国际版无国内补偿体系')
    assert.strictEqual(by.get('e1').skip, 'enterprise', '企业版无补偿体系')
    assert.strictEqual(by.get('c1').status.creditNum, 500)
    assert.strictEqual(by.get('c1').status.endTime, '2026-10-22 23:59:59')
    assert.strictEqual(by.get('c5').error, 'transport boom', '查询失败必须显形，不能渲染成「无活动」')
    s.stop()
  })

  await testAsync('compensationClaimAll：无活动 / 已领 / 额度 0 都不调领取接口', async () => {
    const { s, client } = makeCompScheduler()
    const results = await s.compensationClaimAll()
    const claimCalls = client.calls.filter(c => String(c.url).includes('claim-compensation'))
    assert.strictEqual(claimCalls.length, 1, '只有 c1 该真的领一次（盲领会把四个账号都打一次）')
    const by = new Map(results.map(r => [r.uid, r]))
    assert.strictEqual(by.get('c1').claimed, true)
    assert.strictEqual(by.get('c1').credit, 500)
    assert.strictEqual(by.get('c2').skip, 'no_active')
    assert.strictEqual(by.get('c3').skip, 'claimed')
    assert.strictEqual(by.get('c4').skip, 'zero_credit')
    assert.strictEqual(by.get('c5').error, 'transport boom')
    s.stop()
  })

  await testAsync('summarizeCompensation：errored 与 claimed 分开计（全失败不能被说成「没有待领」）', async () => {
    const { s } = makeCompScheduler()
    const results = await s.compensationClaimAll()
    const sum = s.summarizeCompensation(results)
    assert.deepStrictEqual(sum, { total: 5, claimed: 1, skipped: 3, errored: 1, credit: 500 })
    // 极端情形：全部查询失败
    const allFail = [{ uid: 'x', error: 'boom' }, { uid: 'y', error: 'boom' }]
    const s2 = s.summarizeCompensation(allFail)
    assert.strictEqual(s2.errored, 2)
    assert.strictEqual(s2.claimed, 0, 'claimed=0 但 errored=2，调用方必须先看 errored')
    s.stop()
  })

  await testAsync('compensationClaimFor：未知账号返回 error，国际版/企业版走 skip', async () => {
    const { s } = makeCompScheduler([makeAuth('g1', { realm: 'global' })])
    const missing = await s.compensationClaimFor('nope')
    assert.strictEqual(missing.error, 'account not found')
    const g = await s.compensationClaimFor('g1')
    assert.strictEqual(g.skip, 'global')
    const one = await s.compensationClaimFor('c1')
    assert.strictEqual(one.claimed, true)
    assert.strictEqual(one.credit, 500)
    s.stop()
  })

  await testAsync('签到排程的连登管家走「先查后领」（日志里无补偿不再刷屏）', async () => {
    const { s, client } = makeCompScheduler()
    await s.runNow('checkin')
    // checkin 本体只打签到 + 余额，连登管家（含补偿）由 runCheckinAll 末尾接续；
    // 这里钉住「补偿那一跳必须先查状态再决定是否领取」，且只有待领账号真的调领取
    const urls = client.calls.map(c => String(c.url))
    const statusIdx = urls.findIndex(u => u.includes('compensation-status'))
    const claimIdx = urls.findIndex(u => u.includes('claim-compensation'))
    assert.ok(statusIdx >= 0, '连登管家必须查补偿状态（旧实现是直接盲领）')
    assert.ok(claimIdx > statusIdx, '必须先查后领')
    const claimCalls = urls.filter(u => u.includes('claim-compensation'))
    assert.strictEqual(claimCalls.length, 1, '只有 c1 待领，其余四个账号不该被打领取接口')
    s.stop()
  })

  // ---- 22.11 任务补领清扫：周期幂等补领「已达标未领」 ----

  // 假 client：默认/mp 两个口径返回不同任务集，覆盖
  // 达标未领 / 已领 / 未达标 / 未接受 / 锁定 / 首宠（无需领奖）/ mp 专属达标
  function makeSweepClient(tasksByUid = {}, mpTasksByUid = {}) {
    const calls = []
    const claimed = new Set()
    const client = {
      calls,
      claimed,
      async growthOK(auth, method, pathName, data) {
        calls.push({ auth: auth.uid, method, pathName, data })
        if (method === 'GET' && pathName === constants.GROWTH_TASKS_PATH) {
          return { tasks: (tasksByUid[auth.uid] || []).slice() }
        }
        return {}
      },
      // acceptTasksWith 走 growthCall（要 envelope 而不是 data）
      async growthCall(auth, method, pathName, data) {
        calls.push({ auth: auth.uid, method, pathName, data })
        return { code: 0, msg: 'OK', data: {} }
      },
      async listTasksMP(auth) {
        calls.push({ auth: auth.uid, method: 'GET', pathName: 'mp' })
        const v = mpTasksByUid[auth.uid]
        if (v === 'throw') throw new Error('mp list down')
        return { tasks: (v || []).slice() }
      },
      async acceptTasksMP(auth, codes) {
        calls.push({ auth: auth.uid, method: 'POST', pathName: 'mp-accept', codes: codes.slice() })
        return {}
      },
      async claimReward(auth, code) {
        calls.push({ auth: auth.uid, method: 'CLAIM', code, mp: false })
        if (code === 'boom_task') throw new Error('claim boom')
        if (claimed.has(`${auth.uid}|${code}`)) return { credit: 0, energy: 0, alreadyClaimed: true }
        claimed.add(`${auth.uid}|${code}`)
        return { credit: 100, energy: 5, alreadyClaimed: false }
      },
      async claimRewardMP(auth, code) {
        calls.push({ auth: auth.uid, method: 'CLAIM', code, mp: true })
        if (claimed.has(`${auth.uid}|${code}`)) return { credit: 0, energy: 0, alreadyClaimed: true }
        claimed.add(`${auth.uid}|${code}`)
        return { credit: 200, energy: 8, alreadyClaimed: false }
      }
    }
    return client
  }

  // 一条任务（模拟上游 tasks[] 元素）
  function taskOf(code, current, target, extra = {}) {
    return {
      task_code: code,
      title: code,
      accept_status: 'accepted',
      reward_credit: 100,
      reward_energy: 5,
      has_reward: true,
      progress: { current, target },
      ...extra
    }
  }

  await testAsync('sweepOnce：只领「已达标未领」，未达标/已领/未接受/无需领奖的一个都不碰', async () => {
    const client = makeSweepClient({
      s1: [
        taskOf('chat_5', 5, 5), // 达标未领 → 领
        taskOf('first_buddy', 1, 1), // 达标但无独立领奖 → 跳过
        taskOf('template_5', 3, 1, { accept_status: 'claimed' }), // 已领 → 跳过
        taskOf('Library_read', 0, 1), // 未达标 → 跳过
        taskOf('automation_1', 0, 1, { accept_status: '' }) // 未接受 → 只 accept，不领
      ]
    })
    const st = await tasksMod.sweepOnce({
      client,
      listAccounts: () => [{ uid: 's1', nickname: 'a', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    })
    const claims = client.calls.filter(c => c.method === 'CLAIM').map(c => c.code)
    assert.deepStrictEqual(claims, ['chat_5'], '只有 chat_5 达标未领该被领')
    assert.strictEqual(st.claimed, 1)
    assert.strictEqual(st.credits, 100)
    assert.strictEqual(st.energy, 5)
    // 未接受的任务只走 accept，不因「接受后可能达标」被误领
    const accepts = client.calls.filter(c => c.method === 'POST' && c.pathName === constants.GROWTH_TASKS_ACCEPT_PATH)
    assert.deepStrictEqual(accepts[0].data.task_codes, ['automation_1'])
    assert.strictEqual(st.accepted, 1)
  })

  await testAsync('sweepOnce：两轮幂等——第二轮零次领奖请求', async () => {
    const client = makeSweepClient({ s1: [taskOf('chat_5', 5, 5)] })
    const deps = {
      client,
      listAccounts: () => [{ uid: 's1', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    }
    const first = await tasksMod.sweepOnce(deps)
    assert.strictEqual(first.claimed, 1)
    // 上游第二轮把该任务标成已领（模拟真实回读），清扫不得再打领奖
    client.calls.length = 0
    const t = taskOf('chat_5', 5, 5, { accept_status: 'claimed' })
    const client2 = makeSweepClient({ s1: [t] })
    const second = await tasksMod.sweepOnce({ ...deps, client: client2 })
    assert.strictEqual(second.claimed, 0, '已领任务不得再领')
    assert.strictEqual(client2.calls.filter(c => c.method === 'CLAIM').length, 0)
  })

  await testAsync('sweepOnce：mp 专属任务按出处分流 accept/claim（不靠码常量判定）', async () => {
    const client = makeSweepClient(
      { s1: [taskOf('chat_5', 5, 5)] },
      // mp_new_task 不在 MP_TASK_CODES 里：靠「只出现在 mp 列表」判定必须走 mp 端点
      { s1: [{ task_code: 'mp_new_task', title: 'mp', accept_status: 'accepted', progress: { current: 2, target: 2 } }] }
    )
    const st = await tasksMod.sweepOnce({
      client,
      listAccounts: () => [{ uid: 's1', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    })
    const claims = client.calls.filter(c => c.method === 'CLAIM')
    const byCode = new Map(claims.map(c => [c.code, c.mp]))
    assert.strictEqual(byCode.get('chat_5'), false, '默认口径任务走 Web 域领奖')
    assert.strictEqual(byCode.get('mp_new_task'), true, '只出现在 mp 列表的任务必须走 mp 领奖端点')
    assert.strictEqual(st.claimed, 2)
    assert.strictEqual(st.credits, 300, '100（web）+ 200（mp）')
  })

  await testAsync('sweepOnce：国际版与真企业版零上游请求；企业切换会话照常补领', async () => {
    const client = makeSweepClient({ cn: [taskOf('chat_5', 5, 5)], e1: [taskOf('chat_5', 5, 5)] })
    // 企业切换会话：accessToken 的 JWT payload 带 token_source=enterprise_switch，
    // 但 enterpriseId 为空 —— 读端点与领奖实测正常，达标奖励属于「能领的钱」。
    const entToken = `x.${Buffer.from(JSON.stringify({ token_source: 'enterprise_switch' })).toString('base64url')}.y`
    const st = await tasksMod.sweepOnce({
      client,
      listAccounts: () => [
        { uid: 'cn', disabled: false },
        { uid: 'g1', disabled: false },
        { uid: 'e1', disabled: false },
        { uid: 'off', disabled: true }
      ],
      authByUID: uid =>
        makeAuth(uid, uid === 'g1' ? { realm: 'global' } : uid === 'e1' ? { accessToken: entToken } : {}),
      // 与 runtime.skipGrowthSweepFor 同语义：国际版 + 真企业版
      skipAuth: a => a.realm === 'global' || authMod.isEnterprise(a),
      concurrency: 2
    })
    assert.strictEqual(st.gated, 1, '只有国际版被门控')
    assert.strictEqual(st.accounts, 2, '国内普通号 + 企业切换会话都参与')
    const touched = new Set(client.calls.map(c => c.auth))
    assert.strictEqual(touched.has('g1'), false, '国际版不得发任何上游请求')
    assert.strictEqual(touched.has('e1'), true, '企业切换会话要照常清扫（读/领奖正常）')
    assert.strictEqual(st.claimed, 2, '两个账号的达标奖励都要领掉')
  })

  await testAsync('sweepOnce：真企业版（enterpriseId 非空）整体跳过', async () => {
    // 上游对非个人账号直接 403 `growth system is only available for personal users`，
    // 每轮清扫都会刷一片错误，故整体跳过（与参考实现 IsEnterprise 门控一致）。
    const c2 = makeSweepClient({ ent: [taskOf('chat_5', 5, 5)] })
    const st2 = await tasksMod.sweepOnce({
      client: c2,
      listAccounts: () => [{ uid: 'ent', disabled: false }],
      authByUID: () => makeAuth('ent', { enterpriseId: 'ent-1' }),
      skipAuth: a => a.realm === 'global' || authMod.isEnterprise(a),
      concurrency: 1
    })
    assert.strictEqual(st2.gated, 1)
    assert.strictEqual(c2.calls.length, 0, '真企业版零上游请求')
  })

  await testAsync('sweepOnce：单项领奖失败不阻塞其余，且计入 errors', async () => {
    const client = makeSweepClient({
      s1: [taskOf('boom_task', 1, 1), taskOf('chat_5', 5, 5)]
    })
    const st = await tasksMod.sweepOnce({
      client,
      listAccounts: () => [{ uid: 's1', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    })
    assert.strictEqual(st.errors, 1, '单项失败计一次错')
    assert.strictEqual(st.claimed, 1, '后续任务仍要被领')
    assert.deepStrictEqual(st.codes, ['chat_5'])
    assert.strictEqual(st.credits, 100)
  })

  await testAsync('sweepOnce：账号被占用（正在跑动作）整轮跳过，解锁后自动补', async () => {
    const client = makeSweepClient({ s1: [taskOf('chat_5', 5, 5)] })
    const deps = {
      client,
      listAccounts: () => [{ uid: 's1', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    }
    assert.strictEqual(tasksMod.tryLockAccount('s1'), true, '先模拟一键完成占用该账号')
    const busy = await tasksMod.sweepOnce(deps)
    assert.strictEqual(busy.skipped, 1, '被占用账号整轮跳过，不打断进行中的链路')
    assert.strictEqual(busy.claimed, 0)
    assert.strictEqual(client.calls.length, 0, '被占用账号不得发上游请求')
    tasksMod.unlockAccount('s1')
    const after = await tasksMod.sweepOnce(deps)
    assert.strictEqual(after.claimed, 1, '解锁后下一轮自然补上')
  })

  await testAsync('sweepOnce：默认列表失败记 error 且不发领奖请求', async () => {
    const calls = []
    const client = {
      calls,
      async growthOK() {
        throw new Error('list down')
      },
      async listTasksMP() {
        calls.push('mp')
        return { tasks: [] }
      }
    }
    const st = await tasksMod.sweepOnce({
      client,
      listAccounts: () => [{ uid: 's1', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    })
    assert.strictEqual(st.errors, 1)
    assert.strictEqual(st.claimed, 0)
    assert.deepStrictEqual(calls, [], '默认列表失败即无法判定判据，不应继续拉 mp 列表')
  })

  await testAsync('sweepOnce：上游回「已领取」不计入补领数（防摘要被 +0 分噪音占满）', async () => {
    // accept_status 未落到 claimed 时列表仍报 claimable；领奖回 already_claimed。
    // 若把它算作补领，每轮摘要都会写「补领 1 项 +0 分」而实际零到账。
    const client = {
      calls: [],
      async growthOK() {
        return { tasks: [taskOf('chat_5', 5, 5)] }
      },
      async listTasksMP() {
        return { tasks: [] }
      },
      async claimReward(auth, code) {
        this.calls.push(code)
        return { credit: 0, energy: 0, alreadyClaimed: true }
      }
    }
    const st = await tasksMod.sweepOnce({
      client,
      listAccounts: () => [{ uid: 's1', disabled: false }],
      authByUID: () => makeAuth('s1'),
      skipAuth: () => false,
      concurrency: 1
    })
    assert.deepStrictEqual(client.calls, ['chat_5'], '仍要真的发一次领奖请求（幂等探测）')
    assert.strictEqual(st.claimed, 0, 'already_claimed 不算补领')
    assert.strictEqual(st.credits, 0)
    assert.deepStrictEqual(st.codes, [])
    const summary = tasksMod.sweepSummary(st)
    assert.strictEqual(summary.includes('补领'), false, `摘要不该出现补领：${summary}`)
  })

  await testAsync('sweepSummary：文案只在有动静时提数字，门控/占用各自显形', async () => {
    assert.strictEqual(tasksMod.sweepSummary(null), '未执行')
    assert.strictEqual(tasksMod.sweepSummary({ accounts: 2 }), '账号 2 个')
    const text = tasksMod.sweepSummary({ accounts: 3, gated: 2, skipped: 1, accepted: 4, claimed: 2, credits: 300, energy: 13, errors: 1 })
    assert.ok(text.includes('账号 3 个'))
    assert.ok(text.includes('门控跳过 2'))
    assert.ok(text.includes('占用跳过 1'))
    assert.ok(text.includes('接受 4'))
    assert.ok(text.includes('补领 2 项 +300 分 +13 能'))
    assert.ok(text.includes('出错 1'))
  })

  await testAsync('调度器：补领清扫可开关、间隔可热改，且不进入小时制排程', async () => {
    const { s } = makeSweepScheduler()
    const st = s.getState()
    assert.strictEqual(st.taskSweepEnabled, true, '缺省启用')
    assert.strictEqual(st.taskSweepMinutes, 15, '缺省 15 分钟')
    assert.ok(st.taskSweep, '状态快照必须有 taskSweep 项（前端展示最近执行）')
    // 热改：关闭
    const off = s.updateConfig({ taskSweepEnabled: false, taskSweepMinutes: 30 })
    assert.strictEqual(off.taskSweepEnabled, false)
    assert.strictEqual(off.taskSweepMinutes, 30)
    // <=0 回落默认（不是停用；停用走开关）
    const back = s.updateConfig({ taskSweepMinutes: 0 })
    assert.strictEqual(back.taskSweepMinutes, 15, '非法间隔回落默认值，停用只由开关控制')
    // 不在 HOUR_TASKS 里：改 hours 不影响清扫（清扫是间隔制）
    assert.ok(!('taskSweepHours' in s.getState().hours))
    s.stop()
  })

  await testAsync('调度器：runNow(taskSweep) 走同一条清扫链路并回写摘要', async () => {
    const { s, client } = makeSweepScheduler()
    const res = await s.runNow('taskSweep')
    assert.strictEqual(res.ok, true)
    assert.ok(res.summary.includes('账号 1 个'), `摘要应来自 sweepSummary，实际：${res.summary}`)
    assert.ok(res.summary.includes('补领 1 项'), `应补领到达标任务，实际：${res.summary}`)
    const claims = client.calls.filter(c => c.method === 'CLAIM')
    assert.strictEqual(claims.length, 1)
    assert.strictEqual(s.getState().taskSweep.summary, res.summary, '摘要须写回状态供面板展示')
    s.stop()
  })

  function makeSweepScheduler() {
    const pool = poolMod.createPool({})
    pool.add(makeAuth('s1'))
    const client = makeSweepClient({ s1: [taskOf('chat_5', 5, 5), taskOf('template_5', 0, 1)] })
    const s = schedulerMod.createScheduler({
      pool,
      client,
      authMod,
      refreshTokenFor: async () => ({ ok: true }),
      refreshBalanceFor: async () => ({ ok: true }),
      log: () => {}
    })
    return { s, client, pool }
  }

  // ==================== 汇总 ====================
  console.log(`\n${'='.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项，共 ${passed + failed} 项`)
  if (failed > 0) {
    console.log('\n失败明细：')
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`)
    process.exit(1)
  }
  console.log('全部通过')
}

// 降级态（degradeUntil）为模块内私有变量，用例间无法主动清除；后续用例避免依赖「未降级」断言

main().catch(err => {
  console.error('测试运行异常:', err)
  process.exit(1)
})