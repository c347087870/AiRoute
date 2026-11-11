// Qoder 接入优化项的离线回归
//
// 只测**纯逻辑与转帧**，不碰网络与真实账号：
//   · 模型名解析（展示名 / 别名 / 伪 key）；
//   · 每日领取窗口（UTC+8 10:00，与系统时区无关）；
//   · 额度解析（团队共享池 cap<0 = 不限）；
//   · 设置夹紧（手改文件写坏值不该把渠道打死）；
//   · 转帧（空名工具调用丢弃 + finish 降级、credits 透传、stat 口径）。
//
// 需要真实上游的路径（签到、余额、排队重发）靠手测：这里只守住「不联网就能错的那些」。

const assert = require('assert')
const sse = require('../server/channels/sse')
const protocol = require('../server/channels/plugins/qoder/protocol')
const { createQoder } = require('../server/channels/plugins/qoder/provider')
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
  await test('模型名解析：官方 key / 展示名 / 小写 / 别名 / 伪 key', () => {
    assert.equal(protocol.resolveModelKey('qoder', 'qmodel_38max'), 'qmodel_38max')
    assert.equal(protocol.resolveModelKey('qoder', 'Qwen3.8-Max'), 'qmodel_38max')
    assert.equal(protocol.resolveModelKey('qoder', 'qwen3.8-max'), 'qmodel_38max')
    assert.equal(protocol.resolveModelKey('qoder', 'Qwen3.8-Max (qmodel_38max)'), 'qmodel_38max')
    assert.equal(protocol.resolveModelKey('qoder', 'qoder/smodel'), 'smodel')
    // 历史伪 key：旧配置里写的是 mmodel_cn，必须还能路由（上游只认 mmodel）
    assert.equal(protocol.resolveModelKey('qodercn', 'mmodel_cn'), 'mmodel')
    // 不存在的名字不能瞎猜
    assert.equal(protocol.resolveModelKey('qoder', 'gpt-4o'), '')
  })

  await test('双区目录：CN 的 mmodel 是 M2.7，intl 是 M3；伪 key 已不对外', () => {
    const intl = protocol.PRODUCTS.qoder.models.map(m => m.id)
    const cn = protocol.PRODUCTS.qodercn.models.map(m => m.id)
    assert.ok(!intl.includes('mmodel_cn'), 'intl 不该再有伪 key')
    assert.ok(!cn.includes('mmodel_cn'), 'cn 不该再有伪 key')
    const cnMiniMax = protocol.PRODUCTS.qodercn.models.find(m => m.id === 'mmodel')
    assert.equal(cnMiniMax.name, 'MiniMax-M2.7')
    assert.equal(cnMiniMax.supportsImage, false)
    assert.ok(cn.includes('q37fmodel') && cn.includes('gm51model'), 'CN 独占模型还在')
    // 默认上下文按官方默认档（200K），不是能力上限 1M
    for (const model of protocol.PRODUCTS.qoder.models) {
      assert.ok(model.contextWindow <= 1000000, `${model.id} 上下文不该超过 1M`)
      assert.equal(model.contextWindow, model.maxInputTokens <= 1000000 ? model.contextWindow : model.contextWindow)
    }
    assert.equal(protocol.PRODUCTS.qoder.models.find(m => m.id === 'smodel').contextWindow, 200000)
  })

  await test('每日领取窗口：UTC+8 10:00，与系统时区无关', () => {
    // 2026-10-28 17:00 +08 → 下一个窗口是 10-29 10:00 +08
    const t1 = Date.parse('2026-10-28T17:00:00+08:00')
    assert.equal(new Date(protocol.nextCheckinWindow(t1)).toISOString(), '2026-10-29T02:00:00.000Z')
    // 10-28 09:59 +08 → 仍是当天 10:00
    const t2 = Date.parse('2026-10-28T09:59:00+08:00')
    assert.equal(new Date(protocol.nextCheckinWindow(t2)).toISOString(), '2026-10-28T02:00:00.000Z')
    // 10-28 10:00 整 → 已过点，给明天
    const t3 = Date.parse('2026-10-28T10:00:00+08:00')
    assert.equal(new Date(protocol.nextCheckinWindow(t3)).toISOString(), '2026-10-29T02:00:00.000Z')
  })

  await test('额度解析：套餐 + 资源包 + 共享池（cap<0 = 不限）', () => {
    const body = {
      qoderUsage: {
        userQuota: { total: 1000, used: 400, remaining: 600 },
        addOnQuota: { total: 100, used: 0 },
        dedicatedResourcePackages: [{ total: 50, remaining: 50 }],
        sharedQuota: { cap: -1, used: 20 },
      },
    }
    const value = protocol.parseUsageBalance(body)
    assert.equal(value.total, 750, `合计应是 600+100+50，实际 ${value.total}`)
    assert.equal(value.unlimited, true, 'cap<0 要标成不限')
    // 企业版没有额度数字：不能报 0
    assert.equal(protocol.parseUsageBalance({ displayMode: 'enterprise' }), null)
    assert.equal(protocol.parseUsageBalance({}), null)
  })

  await test('设置夹紧：越界值被夹住，未知字段被忽略', () => {
    const normalized = settingsModule.normalize({
      cooldownMs: 0, // 低于下限
      maxConcurrency: 99, // 高于上限
      firstChunkTimeoutMs: '60000', // 字符串数字
      autoCheckinHour: 99,
      balanceRefreshMinutes: -5,
      bogus: 1,
    })
    assert.equal(normalized.cooldownMs, 1000)
    assert.equal(normalized.maxConcurrency, 16)
    assert.equal(normalized.firstChunkTimeoutMs, 60000)
    assert.equal(normalized.autoCheckinHour, 23, '签到时点夹在 0-23')
    assert.equal(normalized.balanceRefreshMinutes, 0, '刷新间隔夹在 0-1440')
    assert.equal('bogus' in normalized, false)
    // 默认值等于旧版行为
    assert.equal(settingsModule.DEFAULTS.cooldownMs, 60000)
    assert.equal(settingsModule.DEFAULTS.firstChunkTimeoutMs, 120000)
    assert.equal(settingsModule.DEFAULTS.autoCheckin, true)
    assert.equal(settingsModule.DEFAULTS.autoCheckinHour, 10)
    assert.equal(settingsModule.DEFAULTS.balanceRefreshMinutes, 30)
  })

  await test('转帧：空名工具调用被丢弃，finish 降级成 stop', () => {
    const collector = sse.createCollector('qoder/test')
    collector.push({ type: 'tool-call-delta', index: 0, id: 'call_x', argumentsDelta: '' })
    collector.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    const completion = collector.completion()
    assert.equal(completion.choices[0].message.tool_calls, undefined, '空名调用不该出现在结果里')
    assert.equal(completion.choices[0].finish_reason, 'stop', '清空后必须降级，否则客户端死等工具结果')
  })

  await test('转帧：正常工具调用保留，credits 透传进 usage', () => {
    const collector = sse.createCollector('qoder/test')
    collector.push({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{"p":1}' })
    collector.push({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 120, credits: 0.5 },
    })
    collector.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    const completion = collector.completion()
    assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'read_file')
    assert.equal(completion.choices[0].finish_reason, 'tool_calls')
    assert.equal(completion.usage.credits, 0.5)
    // 统计口径：input 是「未命中缓存」的部分（100），cacheRead 单独记（40）
    const stat = sse.toStatUsage(completion.usage)
    assert.equal(stat.input, 100)
    assert.equal(stat.cacheRead, 40)
    assert.equal(stat.credits, 0.5)
  })

  await test('无账号时 complete 明确报 401（不是 502 网关故障）', async () => {
    const qoder = createQoder({
      dataDir: require('path').join(require('os').tmpdir(), `qoder-test-${process.pid}`),
      logger: { info() {}, warn() {}, error() {} },
      credentials: {
        listCredentials: () => [],
        getCredential: () => undefined,
        setCredential: () => {},
        removeCredential: () => {},
      },
      settings: { get: () => settingsModule.DEFAULTS },
    })
    try {
      await qoder.complete({ provider: 'qoder', model: 'qfmodel', openAi: { messages: [{ role: 'user', content: 'hi' }] } }, () => {}, undefined)
      throw new Error('应当抛错')
    } catch (error) {
      assert.equal(error.statusCode, 401, `期望 401，实际 ${error.statusCode}（${error.message}）`)
    }
  })

  await test('未知模型 / 未知渠道都给 404，不让路由层回落 502', async () => {
    const qoder = createQoder({
      dataDir: require('path').join(require('os').tmpdir(), `qoder-test2-${process.pid}`),
      logger: { info() {}, warn() {}, error() {} },
      credentials: {
        listCredentials: () => [],
        getCredential: () => undefined,
        setCredential: () => {},
        removeCredential: () => {},
      },
      settings: { get: () => settingsModule.DEFAULTS },
    })
    for (const [provider, model] of [['qoder', 'gpt-4o'], ['nope', 'qfmodel']]) {
      try {
        await qoder.complete({ provider, model, openAi: { messages: [] } }, () => {}, undefined)
        throw new Error('应当抛错')
      } catch (error) {
        assert.equal(error.statusCode, 404, `${provider}/${model} 期望 404，实际 ${error.statusCode}`)
      }
    }
  })

  await test('桌面头补齐：X-Machine-Id / X-Version / X-Machine-Code 与签名版本一致', async () => {
    // 官方桌面端除 Cosy-* 外还发一组 X-*；WASM 只产 Cosy-*，宿主必须补齐。
    // 版本号必须与签名用的版本同源，否则两处自相矛盾。
    const wasm = require('../server/channels/plugins/qoder/wasm')
    const machineId = '11111111-2222-3333-4444-555555555555'
    const client = await wasm.QoderEncryptedInfer.create({
      user: { uid: 'u-test', securityOauthToken: 'Bearer x' },
      machineId,
      metadata: {},
      host: 'https://api2.qoder.sh',
      clientVersion: '0.5.2',
    })
    const out = client.prepareInfer({ modelKey: 'dmodel', source: 'system', body: {} })
    assert.equal(out.headers['X-Machine-Id'], machineId, 'X-Machine-Id 应与传入的 machineId 一致')
    assert.equal(out.headers['X-Version'], '0.5.2', 'X-Version 应跟随 clientVersion')
    assert.equal(out.headers['Cosy-Version'], '0.5.2', 'Cosy-Version 应跟随 clientVersion')
    assert.equal(out.headers['X-Machine-Code'], '', '官方无值时发空串')
    // 平台类字段在官方靠混淆常量表，还原不出确切字面量 —— 宁可缺失也不猜
    assert.ok(!('X-IDE-Platform' in out.headers), '未确认的 X-IDE-Platform 不应臆造')
  })

  await test('版本体系：Qoder 客户端版本必须是 0.x，不能混入 changelog 的 1.x 内核线', async () => {
    // 2026-11-03 的教训：把 qoder.com/changelog 里 type='ide' 的 1.38.0 当成客户端版本，
    // 导致 Cosy-Version 比官方高两个数量级。客户端版本是 0.x 体系。
    const vs = require('../server/channels/version-sync')
    const p = require('../server/channels/plugins/qoder/protocol')

    const fallback = vs.FALLBACK.qoder.appVersion
    assert.ok(/^0\./.test(fallback), `FALLBACK.qoder 应是 0.x 客户端版本，实际 ${fallback}`)
    assert.ok(/^0\./.test(p.DESKTOP_CLIENT_VERSION), `DESKTOP_CLIENT_VERSION 应是 0.x，实际 ${p.DESKTOP_CLIENT_VERSION}`)
  })

  console.log('')
  if (failed > 0) {
    console.log(`${passed} 项通过，${failed} 项失败`)
    process.exitCode = 1
  } else {
    console.log(`${passed} 项通过`)
  }
}

main()
