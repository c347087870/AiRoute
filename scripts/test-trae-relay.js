// Trae 中转（P0/P1）的离线回归
//
// 只测**纯逻辑**，不碰网络与真实账号：
//   · 请求体：模型名双写（model_name__dev）、会话信封、Max 模式字段；
//   · 重试分诊：429 / 503 / 502 / 400 的处置与延迟；
//   · 冷却终点：额度耗尽 → 次日 04:00（东八区，与系统时区无关）；
//   · 选号策略：order / credit / expire / weighted / p2c；
//   · 形态清洗：身份句改写、cc_* 与 x-anthropic-* 剥离、无指纹时零改动；
//   · 工具名别名：请求侧改名 + 响应侧回改；
//   · 设置归一：新字段的默认值、夹紧与非法值忽略。

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const protocol = require('../server/channels/plugins/trae/protocol')
const sanitize = require('../server/channels/plugins/trae/sanitize')
const settingsModule = require('../server/channels/settings')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message}`)
  }
}

async function main() {
  await test('模型名双写：配置名 + 内部名（__dev）', () => {
    assert.equal(protocol.wireModelName('claude-sonnet-4.5'), 'claude-sonnet-4.5__dev')
    // 点号风格例外：下划线变体在上游报 4023
    assert.equal(protocol.wireModelName('deepseek-v4.1-flash'), 'deepseek-v4.1-flash__dev')
    // 已经是内部名就不再叠后缀
    assert.equal(protocol.wireModelName('gpt-5__dev'), 'gpt-5__dev')
    assert.equal(protocol.wireModelName(''), '')
  })

  await test('请求体：config_name / model / model_name 三件套 + 会话信封', () => {
    const body = protocol.transformToSolo(
      { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] },
      'solo_work_lite',
      { uid: 'u1', deviceId: 'd1', machineId: 'm1', conversationId: 'conv-1' },
    )
    assert.equal(body.config_name, 'claude-sonnet-4.5')
    assert.equal(body.model, 'claude-sonnet-4.5')
    assert.equal(body.model_name, 'claude-sonnet-4.5__dev')
    assert.equal(body.function, 'solo_work_lite')
    assert.equal(body.stream, true)
    assert.equal(body.conversation_id, 'conv-1')
    assert.equal(body.workspace_id, 'e04cdd')
    assert.equal(body.mode, 'FunctionCall')
    assert.equal(body.package_type, 'stable_cn')
    assert.equal(body.user_id, 'u1')
    assert.equal(body.device_id, 'd1')
    assert.equal(body.machine_id, 'm1')
    assert.ok(typeof body.session_id === 'string' && body.session_id.length > 0)
    assert.ok(typeof body.project_id === 'string' && body.project_id.length > 0)
    assert.equal(body.ide_version, protocol.IDE_VERSION)
  })

  await test('登录链接：桌面客户端形态（trae / IDE client / 3.4.9）+ PKCE + 回调不编码', () => {
    const { verifier, challenge } = protocol.pkcePair()
    const url = protocol.buildLoginUrl('a'.repeat(64), '1234567890123456', 'http://127.0.0.1:41890/authorize', { codeChallenge: challenge })
    assert.ok(url.includes('auth_from=trae'), 'auth_from 必须是 trae（IDE 客户端）')
    assert.ok(url.includes('client_id=ono9krqynydwx5'), 'IDE 的 client_id')
    assert.ok(url.includes('plugin_version=2.3.97430'))
    assert.ok(url.includes('x_app_version=3.4.9'))
    assert.ok(url.includes('x_app_type=stable'))
    assert.ok(url.includes('x_env=&'), 'x_env 是空值但参数要在')
    assert.ok(url.includes('channel_name=common'))
    assert.ok(!url.includes('hide_saas_login'), '桌面客户端没有这个参数')
    assert.ok(url.includes('auth_callback_url=http://127.0.0.1:41890/authorize'), '回调地址必须原样出现（不能 %3A%2F%2F）')
    assert.ok(url.includes(`code_challenge=${challenge}`))
    assert.ok(url.includes('code_challenge_method=S256'))
    // PKCE：challenge = sha256(verifier) 的 base64url
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
    assert.equal(challenge, expected)
    assert.ok(/^[A-Za-z0-9_-]{60,}$/.test(verifier), 'verifier 是 base64url 无填充')
  })

  await test('登录链接：官网同步的版本号覆盖内置默认（version-sync 接入点）', () => {
    const { challenge } = protocol.pkcePair()
    const url = protocol.buildLoginUrl('m', 'd', 'http://127.0.0.1:1/authorize', {
      codeChallenge: challenge,
      versions: { appVersion: '3.5.0', pluginVersion: '2.3.99999' },
    })
    assert.ok(url.includes('x_app_version=3.5.0'), 'x_app_version 应跟随同步值')
    assert.ok(url.includes('plugin_version=2.3.99999'), 'plugin_version 应跟随同步值')
    // 换证请求里的 IDEVersion 同样跟随
    const built = protocol.buildAuthCodeExchange({
      authCode: 'AC', codeVerifier: 'v', publicKey: 'P', machineId: 'm', deviceId: 'd',
    }, '3.5.0')
    assert.equal(built.body.IDEVersion, '3.5.0')
    assert.equal(built.body.DeviceInfo.ClientVersion, '3.5.0')
  })

  await test('签到 / 余额 / GetUserInfo 请求体对齐客户端（req_source / IDEVersion）', () => {
    // 这些 body 形状来自 Trae 客户端反编译（main.js _requestCheckinCredits /
    // _fetchEntitlementUsageRaw / getUserInfo），此处用源码级断言锁住，
    // 防止以后改动时回退成 SOLO 口径
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'channels', 'plugins', 'trae', 'provider.js'), 'utf8')
    assert.ok(src.includes("body: { req_source: 1 }"), '签到 body 必须 req_source:1（IDE 口径）')
    assert.ok(src.includes("body: { require_usage: true, req_source: 1 }"), '余额 body 必须 req_source:1')
    assert.ok(src.includes("ReqSource: 'IDE', IDEVersion: versions?.get?.().trae?.appVersion"), 'GetUserInfo 的 IDEVersion 必须用同步值')
    // 客户端 v3 续期需要 DeviceProof 签名（sha256 私钥），确认实现存在
    assert.ok(src.includes("createSign('sha256')"), 'v3 续期应有 DeviceProof 签名')
    assert.ok(src.includes('DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce }'), 'DeviceProof 三字段齐全')
    assert.ok(src.includes('CheckLogin'), '应有令牌主动校验（CheckLogin）')
    // ABI 必须登记：宿主 capabilitiesOf 用「方法存在与否」判能力，漏登记就一路报「不支持」
    const abi = fs.readFileSync(path.join(__dirname, '..', 'server', 'channels', 'plugins', 'trae', 'index.js'), 'utf8')
    assert.ok(abi.includes('checkLogin: (provider, uid) =>'), '插件 ABI 必须暴露 checkLogin')
  })

  await test('设备密钥对：EC P-256 的 SPKI 公钥 + PKCS#8 私钥', () => {
    const keys = protocol.generateDeviceKeys()
    assert.ok(keys.publicKey.includes('BEGIN PUBLIC KEY'))
    assert.ok(keys.privateKey.includes('BEGIN PRIVATE KEY'))
  })

  await test('授权码换证请求：CodeVerifier + DeviceInfo 齐全', () => {
    const built = protocol.buildAuthCodeExchange({
      authCode: 'AC-1', codeVerifier: 'verifier-1', publicKey: 'PEM', machineId: 'm1', deviceId: 'd1',
    })
    assert.ok(built.urls[0].endsWith('/trae/api/v3/oauth/ExchangeToken'))
    assert.equal(built.body.AuthCode, 'AC-1')
    assert.equal(built.body.CodeVerifier, 'verifier-1')
    assert.equal(built.body.DeviceInfo.DevicePublicKey, 'PEM')
    assert.equal(built.body.DeviceInfo.DeviceID, 'd1')
    assert.equal(built.body.DeviceInfo.PlatformCode, 'IDE_PC')
  })

  await test('回调解析：authCode / authCodeInfo / refreshToken 三种材料', () => {
    const byCode = protocol.parseCallback('/authorize?state=s&authCode=AC-9')
    assert.equal(byCode.ok, true)
    assert.equal(byCode.info.authCode, 'AC-9')
    const byInfo = protocol.parseCallback('/authorize?state=s&authCodeInfo=' + encodeURIComponent(JSON.stringify({ data: { authCode: 'AC-10' } })))
    assert.equal(byInfo.info.authCode, 'AC-10')
    const byRefresh = protocol.parseCallback('/authorize?state=s&refreshToken=RT-1')
    assert.equal(byRefresh.info.refreshToken, 'RT-1')
    // 错误分支先判：错误回调不能被当成材料
    const failed = protocol.parseCallback('/authorize?state=s&error=access_denied&authCode=AC-1')
    assert.equal(failed.ok, false)
    assert.ok(failed.reason.includes('access_denied'))
    const redirectOff = protocol.parseCallback('/authorize?state=s&isRedirect=false&authCode=AC-1')
    assert.equal(redirectOff.ok, false)
  })

  await test('Max 模式：is_max_mode + prompt_max_tokens=168000（1M 值会被 4001 拒）', () => {
    const fields = protocol.maxModeFields(1000000, 64000)
    assert.equal(fields.is_max_mode, true)
    assert.equal(fields.prompt_max_tokens, 168000)
    assert.equal(fields.max_tokens, 64000)
    assert.equal(fields.context_window_size, 1000000)
    // 没有 max 档的模型不带这组字段
    const plain = protocol.transformToSolo({ model: 'x', messages: [] }, 'solo_work_lite', {})
    assert.equal(plain.is_max_mode, undefined)
  })

  await test('目录：dev / max 两个口径分槽，不互相兜底', () => {
    const models = protocol.parseBatchModelList({
      function_configs: [{
        function: 'solo_work_lite',
        config_info_list: [{
          config_name: 'demo-model',
          usage: 'chat_completion',
          context_window_tokens: { dev: 128000, max: 1000000 },
        }],
      }],
    })
    assert.equal(models.length, 1)
    assert.equal(models[0].contextWindow, 128000)
    assert.equal(models[0].contextWindowMax, 1000000)
  })

  await test('重试分诊：400 的三种语义（抖动 / 积分耗尽 / 账号受限）', () => {
    // 思考签名抖动：同号重试一次就好，第二次仍失败才认命
    assert.deepEqual(protocol.retryPlan(400, '{"error":"invalid thinking.signature"}', 0), { action: 'retry', delayMs: 200 })
    assert.equal(protocol.retryPlan(400, 'thinking.signature', 1).action, 'fatal')
    // 积分耗尽：请求合法，换号
    assert.equal(protocol.retryPlan(400, 'insufficient credit', 0).action, 'switch')
    assert.equal(protocol.retryPlan(400, '额度不足', 0).action, 'switch')
    // 账号级风控：换号 + 停用该号
    const restricted = protocol.retryPlan(400, '{"code":11140,"message":"账号存在异常"}', 0)
    assert.equal(restricted.action, 'switch')
    assert.equal(restricted.restrict, true)
    // 其余 400：请求本身的问题（context 超长等），换号无意义
    assert.equal(protocol.retryPlan(400, 'context length exceeded', 0).action, 'fatal')
  })

  await test('重试分诊：429 / 503 / 502 / 401 / 5xx', () => {
    assert.deepEqual(protocol.retryPlan(429, '', 0), { action: 'retry', delayMs: 1000, rateLimited: true })
    // Retry-After 优先
    assert.equal(protocol.retryPlan(429, '', 0, 5).delayMs, 5000)
    // 三次之后换号
    assert.equal(protocol.retryPlan(429, '', 3).action, 'switch')
    assert.equal(protocol.retryPlan(503, '', 0).delayMs, 10000)
    assert.equal(protocol.retryPlan(503, '', 1).delayMs, 20000)
    assert.equal(protocol.retryPlan(529, '', 2).delayMs, 40000)
    assert.equal(protocol.retryPlan(502, '', 0).action, 'retry')
    assert.equal(protocol.retryPlan(502, '', 0).delayMs, 500)
    assert.equal(protocol.retryPlan(502, '', 1).action, 'switch')
    assert.equal(protocol.retryPlan(401, '', 0).action, 'switch')
    assert.equal(protocol.retryPlan(500, '', 0).action, 'switch')
    assert.equal(protocol.retryPlan(404, '', 0).action, 'fatal')
  })

  await test('额度冷却终点：次日 04:00（东八区）', () => {
    const now = Date.parse('2026-10-28T17:58:00+08:00')
    assert.equal(protocol.nextQuotaReset(now), Date.parse('2026-10-29T04:00:00+08:00'))
    // 凌晨 03:00 仍算「今天 04:00」
    const early = Date.parse('2026-10-29T03:00:00+08:00')
    assert.equal(protocol.nextQuotaReset(early), Date.parse('2026-10-29T04:00:00+08:00'))
  })

  await test('选号策略：顺序 / 余额 / 到期 / 加权 / P2C', () => {
    const entries = [
      { uid: 'a', credits: 10, creditsExpireAt: 0, inflight: 2 },
      { uid: 'b', credits: 300, creditsExpireAt: 2000, inflight: 0 },
      { uid: 'c', credits: 50, creditsExpireAt: 1000, inflight: 1 },
    ]
    assert.equal(protocol.pickByStrategy(entries, { strategy: 'order' }).uid, 'a')
    assert.equal(protocol.pickByStrategy(entries, { strategy: 'credit' }).uid, 'b')
    assert.equal(protocol.pickByStrategy(entries, { strategy: 'expire' }).uid, 'c')
    // 加权随机：同一 seed 必须可复现，且只可能落在得分最高的几个里
    const first = protocol.pickByStrategy(entries, { strategy: 'weighted', seed: 42 }).uid
    const second = protocol.pickByStrategy(entries, { strategy: 'weighted', seed: 42 }).uid
    assert.equal(first, second)
    assert.ok(['a', 'b', 'c'].includes(first))
    // P2C：先在途数少者胜（a 有 2 个在途，b 空闲）
    assert.equal(protocol.pickByStrategy(entries, { strategy: 'p2c', seed: 1 }).uid, 'b')
    assert.equal(protocol.pickByStrategy([], { strategy: 'order' }), undefined)
  })

  await test('形态清洗：身份句改写 + cc_* / x-anthropic-* 剥离', () => {
    const text = "You are Claude Code, Anthropic's official CLI tool for Claude\ncc_billing=abc123; x-anthropic-billing-hdr: v1\nmain task"
    const out = sanitize.sanitizeText(text)
    assert.ok(!out.includes('Claude Code'), '身份句该被改写')
    assert.ok(!out.includes('cc_billing'), 'cc_* 键值该被剥离')
    assert.ok(!out.includes('x-anthropic-'), 'x-anthropic-* 引用该被剥离')
    assert.ok(out.includes('main task'), '正文不能丢')
    // 无指纹文本逐字原样（连空白都不动）
    const plain = 'normal user prompt  with  spaces'
    assert.equal(sanitize.sanitizeText(plain), plain)
    // 幂等：洗过的文本再洗一遍不再变化
    assert.equal(sanitize.sanitizeText(out), out)
  })

  await test('形态清洗：messages / tools.description 都覆盖', () => {
    const messages = [
      { role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI tool for Claude' },
      { role: 'user', content: [{ type: 'text', text: 'see x-anthropic-version: 1' }, { type: 'image_url', image_url: { url: 'a' } }] },
    ]
    assert.equal(sanitize.sanitizeMessages(messages), true)
    assert.ok(!messages[0].content.includes('Claude Code'))
    assert.ok(!messages[1].content[0].text.includes('x-anthropic-'))
    assert.equal(messages[1].content[1].image_url.url, 'a')
    const tools = [{ function: { name: 't', description: 'You are an interactive CLI agent specializing in software engineering tasks.' } }]
    assert.equal(sanitize.sanitizeTools(tools), true)
    assert.ok(!tools[0].function.description.includes('interactive CLI'))
  })

  await test('工具名别名：请求侧三处改名，响应侧回改', () => {
    const body = {
      tools: [{ function: { name: 'bash' } }, { function: { name: 'read' } }],
      tool_choice: { function: { name: 'bash' } },
      messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'bash', arguments: '{}' } }] }],
    }
    const { reverse, changed } = sanitize.applyToolAliases(body, { bash: 'run_command' })
    assert.equal(changed, true)
    assert.equal(body.tools[0].function.name, 'run_command')
    assert.equal(body.tools[1].function.name, 'read')
    assert.equal(body.tool_choice.function.name, 'run_command')
    assert.equal(body.messages[0].tool_calls[0].function.name, 'run_command')
    assert.equal(reverse.get('run_command'), 'bash')
    assert.equal(sanitize.restoreToolName('run_command', reverse), 'bash')
    assert.equal(sanitize.restoreToolName('read', reverse), 'read')
    // 空表零改动
    const plain = { tools: [{ function: { name: 'bash' } }] }
    assert.equal(sanitize.applyToolAliases(plain, {}).changed, false)
  })

  await test('设置归一：默认值 / 夹紧 / 非法值忽略', () => {
    const base = settingsModule.normalize({})
    assert.equal(base.traeFirstByteMs, 10000)
    assert.equal(base.traePoolStrategy, 'order')
    assert.equal(base.traeStickyTtlMs, 1800000)
    assert.equal(base.traeSanitize, true)
    assert.equal(base.traeMaxMode, true)
    // 首字超时下限 3 秒
    assert.equal(settingsModule.normalize({ traeFirstByteMs: 1000 }).traeFirstByteMs, 3000)
    // 非法策略忽略
    assert.equal(settingsModule.normalize({ traePoolStrategy: 'nope' }).traePoolStrategy, 'order')
    // 布尔只能被布尔改
    assert.equal(settingsModule.normalize({ traeSanitize: 'false' }).traeSanitize, true)
    assert.equal(settingsModule.normalize({ traeSanitize: false }).traeSanitize, false)
    // 别名表只留字符串对
    assert.deepEqual(
      settingsModule.normalize({ traeToolAlias: { bash: 'run_command', bad: 1 } }).traeToolAlias,
      { bash: 'run_command' },
    )
  })

  await test('每渠道单独配置：providers.<id> 覆盖默认值，互不影响', () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airoute-settings-'))
    try {
      const service = settingsModule.createSettings(dir)
      service.update({
        providers: {
          trae: { firstChunkTimeoutMs: 45000, traeFirstByteMs: 8000 },
          qoder: { cooldownMs: 30000 },
          qodercn: { cooldownMs: 120000 },
        },
      })
      assert.equal(service.forProvider('trae').firstChunkTimeoutMs, 45000)
      assert.equal(service.forProvider('trae').traeFirstByteMs, 8000)
      // 没有覆盖的渠道用默认值
      assert.equal(service.forProvider('qodercn').firstChunkTimeoutMs, 120000)
      // 同名字段各渠道独立
      assert.equal(service.forProvider('qoder').cooldownMs, 30000)
      assert.equal(service.forProvider('qodercn').cooldownMs, 120000)
      // 非法值被夹紧，不影响其它渠道
      service.update({ providers: { qoder: { firstChunkTimeoutMs: 1 } } })
      assert.equal(service.forProvider('qoder').firstChunkTimeoutMs, 10000)
      assert.equal(service.forProvider('trae').firstChunkTimeoutMs, 45000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
