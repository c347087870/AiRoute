const express = require('express')
const cors = require('cors')
const axios = require('axios')
const fs = require('fs-extra')
const os = require('os')
const logger = require('./logger')
const engine = require('./router-engine')
const tokenStats = require('./token-stats')
const paths = require('./paths')
const models = require('./models')
const upstream = require('./upstream')
const benchmark = require('./benchmark')
const update = require('./update')
const workbuddy = require('./workbuddy/runtime')
const wbSession = require('./workbuddy/session')
const wbAnthropic = require('./workbuddy/anthropic')

const {
  getConfig,
  saveConfig,
  resolveRef,
  listModelRefs,
  toProviderView,
  sanitizeProviderInput,
  cleanupRuleRefs,
  isRefOfProvider,
  firstAvailableRef
} = models

const app = express()

// 关闭 Express 指纹头（Claude Code 会因 x-powered-by 误判请求被中间层拦截）
app.disable('x-powered-by')

// 跨域白名单：AI 客户端与 Electron 渲染进程不携带 Origin，直接放行；
// 浏览器网页必须来自本机 localhost，阻止外站网页脚本调用本地网关改配置
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return callback(null, true)
    return callback(null, false)
  }
}))
app.use(express.json({ limit: '100mb' }))

const STATE_PATH = paths.getStatePath()
const FALLBACK_PATH = paths.getFallbackPath()

function getState() {
  if (!fs.existsSync(STATE_PATH)) return { current: 'auto' }
  try {
    return fs.readJsonSync(STATE_PATH)
  } catch {
    return { current: 'auto' }
  }
}

function saveState(state) {
  fs.writeJsonSync(STATE_PATH, state, { spaces: 2 })
}

function getFallback() {
  if (!fs.existsSync(FALLBACK_PATH)) return { model: '' }
  try {
    return fs.readJsonSync(FALLBACK_PATH)
  } catch {
    return { model: '' }
  }
}

function saveFallback(fallback) {
  fs.writeJsonSync(FALLBACK_PATH, fallback, { spaces: 2 })
}

// 构建本次请求要尝试的模型链：主模型 + 兜底模型
function buildProviderChain(config, state, fallbackData, body) {
  const chain = []
  let requestedRef = state.current

  if (requestedRef === 'auto') {
    const routed = engine.resolveModel(body)
    requestedRef = routed || firstAvailableRef(config)
  }

  const primary = resolveRef(config, requestedRef)
  if (primary) chain.push(primary)

  if (fallbackData.model) {
    const fb = resolveRef(config, fallbackData.model)
    if (fb && fb.ref !== primary?.ref) chain.push(fb)
  }

  return { chain, primaryRef: primary ? primary.ref : requestedRef }
}

function logFailure(entry) {
  logger.log(entry)
  tokenStats.recordFailure(entry.model)
}

app.get('/api/fallback', (req, res) => {
  res.json(getFallback())
})

app.put('/api/fallback', (req, res) => {
  const { model } = req.body
  saveFallback({ model: model || '' })
  res.json({ ok: true, model })
})

async function handleRequest(req, res) {
  const config = getConfig()
  const state = getState()
  const fallbackData = getFallback()
  const isStream = !!req.body?.stream
  const clientIsAnthropic = req.path === '/v1/messages'

  // 任务级日志上下文：同一任务（一次输入+其工具循环）的多次请求合并为一条日志记录
  const rawBody = JSON.stringify(req.body || {})
  const baseLog = {
    taskKey: wbSession.extractTaskKey(rawBody) || undefined,
    input: wbSession.extractInputText(rawBody) || undefined
  }

  const { chain, primaryRef } = buildProviderChain(config, state, fallbackData, req.body)

  if (!chain.length) {
    tokenStats.recordFailure(primaryRef || '')
    logger.log({
      ...baseLog,
      model: primaryRef || '',
      status: 0,
      error: '没有可用的 Provider 或模型，请先在 Provider 管理中配置',
      responseTime: 0
    })
    const noChainMsg = '没有可用的 Provider 或模型，请先在 Provider 管理中配置'
    return res.status(500).json(clientIsAnthropic ? wbAnthropic.errorBody(noChainMsg) : { error: noChainMsg })
  }

  const startTime = Date.now()
  let lastError = null

  for (const entry of chain) {
    const provider = entry.provider
    const isFallback = entry.ref !== primaryRef

    // WorkBuddy 类型：走账号池转发（不需要 apiKey / 端点 URL）
    if (models.isWorkbuddyProvider(provider)) {
      try {
        await handleWorkbuddyRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic)
        return
      } catch (err) {
        lastError = err
        logFailure({ ...baseLog,
          model: entry.ref,
          status: err.status || 500,
          error: err.message,
          responseTime: Date.now() - startTime,
          fallback: isFallback,
          fallbackFrom: isFallback ? primaryRef : undefined,
          // 失败也并入同一任务的日志行（任务级合并键 + 使用记录）：
          // 优先用 forwardChat 补挂的字段，缺失时回落到请求入口的 baseLog
          taskKey: err.taskKey || baseLog.taskKey,
          input: err.input || baseLog.input
        })
        continue
      }
    }

    if (!provider.apiKey) {
      lastError = new Error('未配置 API Key')
      logFailure({ ...baseLog,
        model: entry.ref,
        status: 0,
        error: lastError.message,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined
      })
      continue
    }

    const url = upstream.resolveEndpoint(provider, clientIsAnthropic)
    if (!url) {
      lastError = new Error(clientIsAnthropic ? '未配置 Anthropic 端点 (baseURL)' : '未配置 OpenAI 端点 (openaiURL)')
      logFailure({ ...baseLog,
        model: entry.ref,
        status: 0,
        error: lastError.message,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined
      })
      continue
    }

    const headers = upstream.resolveHeaders(provider, clientIsAnthropic)
    const reqBody = upstream.buildRequestBody(
      req.body,
      entry.model,
      isStream,
      clientIsAnthropic,
      // 推理档位逐模型配置（Provider 模型项上的 reasoningEffort）；未配置则不干预客户端原值
      entry.model.reasoningEffort || undefined
    )

    if (isStream) {
      try {
        const upstreamRes = await axios.post(url, reqBody, {
          headers,
          timeout: 300000,
          responseType: 'stream',
          validateStatus: () => true
        })

        if (upstreamRes.status !== 200) {
          lastError = new Error(`Upstream returned ${upstreamRes.status}`)
          logFailure({ ...baseLog,
            model: entry.ref,
            status: upstreamRes.status,
            error: lastError.message,
            responseTime: Date.now() - startTime,
            fallback: isFallback,
            fallbackFrom: isFallback ? primaryRef : undefined
          })
          continue
        }

        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        const streamUsage = upstream.emptyUsage()
        const usageExtractor = upstream.createStreamUsageExtractor(clientIsAnthropic)

        upstreamRes.data.on('data', (chunk) => {
          upstream.mergeStreamUsage(streamUsage, usageExtractor.push(chunk))
          res.write(chunk)
        })

        upstreamRes.data.on('end', () => {
          upstream.mergeStreamUsage(streamUsage, usageExtractor.end())
          tokenStats.recordTokens(entry.ref, streamUsage)
          logger.log({
            ...baseLog,
            model: entry.ref,
            status: 200,
            responseTime: Date.now() - startTime,
            fallback: isFallback,
            fallbackFrom: isFallback ? primaryRef : undefined,
            inputTokens: streamUsage.input,
            outputTokens: streamUsage.output,
            cacheReadTokens: streamUsage.cacheRead,
            cacheWriteTokens: streamUsage.cacheWrite,
            totalTokens: upstream.usageTotal(streamUsage),
            stream: true
          })
          res.end()
        })

        upstreamRes.data.on('error', (err) => {
          logFailure({ ...baseLog,
            model: entry.ref,
            status: 500,
            error: err.message,
            responseTime: Date.now() - startTime,
            fallback: isFallback,
            fallbackFrom: isFallback ? primaryRef : undefined,
            stream: true
          })
          try { res.end() } catch {}
        })

        return
      } catch (streamErr) {
        lastError = streamErr
        logFailure({ ...baseLog,
          model: entry.ref,
          status: streamErr.response?.status || 500,
          error: streamErr.message,
          responseTime: Date.now() - startTime,
          fallback: isFallback,
          fallbackFrom: isFallback ? primaryRef : undefined
        })
        continue
      }
    }

    try {
      const response = await axios.post(url, reqBody, { headers, timeout: 60000 })
      const elapsed = Date.now() - startTime
      const usage = upstream.extractUsage(response.data, clientIsAnthropic) || upstream.emptyUsage()

      tokenStats.recordTokens(entry.ref, usage)

      logger.log({
        ...baseLog,
        model: entry.ref,
        status: 200,
        responseTime: elapsed,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: upstream.usageTotal(usage)
      })

      return res.json(response.data)
    } catch (err) {
      lastError = err
      logFailure({ ...baseLog,
        model: entry.ref,
        status: err.response?.status || 500,
        error: err.message,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined
      })
    }
  }

  if (clientIsAnthropic) {
    return res.status(500).json(wbAnthropic.errorBody(lastError?.message || 'All providers failed', lastError?.gatewayHint))
  }
  res.status(500).json({
    error: 'All providers failed',
    detail: lastError?.message,
    // 网关补充说明（gateway_hint，参照 hint.go；无提示时不带字段）
    ...(lastError?.gatewayHint ? { gateway_hint: lastError.gatewayHint } : {})
  })
}

// WorkBuddy 类型 Provider 的请求转发：账号池化 + 换号重试 + SSE 重建（由 runtime 内部闭环）
async function handleWorkbuddyRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic) {
  const rt = workbuddy.getRuntime()
  if (!rt) {
    throw new Error('WorkBuddy 运行时未初始化')
  }

  const isStream = !!req.body?.stream
  const clientIP = extractClientIP(req.headers)
  // WorkBuddy 源的推理档位走每个模型独立配置（不回落全局档位；未配置则不干预）
  const modelEffort = entry.model.reasoningEffort || ''

  // Anthropic 客户端（/v1/messages）：请求体先转 OpenAI 形态，再进改写/上游管线
  const fwdBody = JSON.stringify(clientIsAnthropic ? wbAnthropic.toOpenAI(req.body || {}) : (req.body || {}))

  // 任务级日志上下文（与 handleRequest 同口径；用客户端原始请求体，保持日志口径不变）
  const wbRawBody = JSON.stringify(req.body || {})
  const wbBaseLog = {
    taskKey: wbSession.extractTaskKey(wbRawBody) || undefined,
    input: wbSession.extractInputText(wbRawBody) || undefined
  }

  if (isStream) {
    let started = false
    const startSse = () => {
      if (started) return
      started = true
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    }

    // Anthropic 客户端：重建帧先喂用量提取器，再经协议转换写出；OpenAI 客户端原样写出
    const emitter = clientIsAnthropic ? wbAnthropic.createStreamEmitter({ model: entry.ref }) : null

    const streamUsage = upstream.emptyUsage()
    const usageExtractor = upstream.createStreamUsageExtractor(false)

    let fwd = null
    try {
      fwd = await workbuddy.forwardChat({
        body: fwdBody,
        isStream: true,
        clientIP,
        model: entry.model.id,
        reasoningEffort: modelEffort,
        // 客户端断开时立即停止换号轮转/退避等待
        isAborted: () => req.destroyed || res.writableEnded,
        // 会话头族入站透传（X-Conversation-Request-ID / X-Trace-ID）
        inbound: {
          conversationRequestId: req.headers['x-conversation-request-id'],
          traceId: req.headers['x-trace-id']
        },
        onChunk: text => {
          startSse()
          upstream.mergeStreamUsage(streamUsage, usageExtractor.push(text))
          if (emitter) {
            const out = emitter.push(text)
            if (out) res.write(out)
          } else {
            res.write(text)
          }
        }
      })
    } catch (err) {
      // 响应头尚未写出时可安全换源；已开始输出则收尾（Anthropic 补 error 事件）
      if (!started) throw err
      try {
        if (emitter) {
          const out = emitter.fail(err)
          if (out) res.write(out)
        }
        res.end()
      } catch {
        /* 客户端已断开 */
      }
      return
    }

    startSse()
    upstream.mergeStreamUsage(streamUsage, usageExtractor.end())
    if (emitter) {
      const out = emitter.end()
      if (out) res.write(out)
    }
    tokenStats.recordTokens(entry.ref, streamUsage)
    logger.log({
      ...wbBaseLog,
      model: entry.ref,
      status: 200,
      responseTime: Date.now() - startTime,
      fallback: isFallback,
      fallbackFrom: isFallback ? primaryRef : undefined,
      uid: fwd?.uid,
      ttfbMs: fwd?.ttfbMs,
      // 请求日志「使用记录 / 积分消耗」与任务级合并键（一次提问一条日志）
      taskKey: fwd?.taskKey,
      input: fwd?.input,
      credits: fwd?.credits,
      inputTokens: streamUsage.input,
      outputTokens: streamUsage.output,
      cacheReadTokens: streamUsage.cacheRead,
      cacheWriteTokens: streamUsage.cacheWrite,
      totalTokens: upstream.usageTotal(streamUsage),
      stream: true
    })
    res.end()
    return
  }

  // 非流式：上游仍走 SSE，由 runtime 聚合成单个响应
  let aggregated = null
  const fwd = await workbuddy.forwardChat({
    body: fwdBody,
    isStream: false,
    clientIP,
    model: entry.model.id,
    reasoningEffort: modelEffort,
    isAborted: () => req.destroyed || res.writableEnded,
    inbound: {
      conversationRequestId: req.headers['x-conversation-request-id'],
      traceId: req.headers['x-trace-id']
    },
    onDone: payload => {
      aggregated = payload
    }
  })
  if (!aggregated) throw new Error('上游未返回有效响应')

  const usage = upstream.extractUsage(aggregated, false) || upstream.emptyUsage()
  tokenStats.recordTokens(entry.ref, usage)
  logger.log({
    ...wbBaseLog,
    model: entry.ref,
    status: 200,
    responseTime: Date.now() - startTime,
    fallback: isFallback,
    fallbackFrom: isFallback ? primaryRef : undefined,
    uid: fwd?.uid,
    ttfbMs: fwd?.ttfbMs,
    credits: fwd?.credits || undefined,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: upstream.usageTotal(usage)
  })
  // Anthropic 客户端：聚合结果转 Anthropic Message 后返回
  res.json(clientIsAnthropic ? wbAnthropic.toMessage(aggregated, entry.ref) : aggregated)
}

// 从请求头提取客户端 IP（X-Forwarded-For 第一段，回落 X-Real-IP）
function extractClientIP(headersMap) {
  const xff = headersMap['x-forwarded-for'] || headersMap['X-Forwarded-For'] || ''
  if (xff) {
    const first = String(xff).split(',')[0].trim()
    if (first) return first
  }
  return String(headersMap['x-real-ip'] || headersMap['X-Real-IP'] || '').trim()
}

app.post('/v1/messages', handleRequest)
app.post('/v1/chat/completions', handleRequest)

app.get('/v1/models', (req, res) => {
  const config = getConfig()
  const seen = new Set()
  const configured = []

  for (const { model } of listModelRefs(config)) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    configured.push({ id: model.id, object: 'model', created: 0, owned_by: 'airoute' })
  }

  const aliases = [
    'claude-opus-4-0-20250514', 'claude-opus-4-20250514',
    'claude-sonnet-4-0-20250514', 'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022', 'claude-3-opus-20240229',
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'
  ]
  const extra = aliases.filter(a => !seen.has(a)).map(id => ({
    id, object: 'model', created: 0, owned_by: 'airoute'
  }))

  res.json({ object: 'list', data: [...configured, ...extra] })
})

app.get('/api/state', (req, res) => {
  res.json(getState())
})

app.post('/api/state', (req, res) => {
  const { current } = req.body
  // 非法引用落盘后所有请求都会 500，保存前先校验可解析
  if (typeof current !== 'string' || !current.trim()) {
    return res.status(400).json({ error: '模型引用不能为空' })
  }
  if (current !== 'auto' && !resolveRef(getConfig(), current)) {
    return res.status(400).json({ error: `模型不存在或配置无效: ${current}` })
  }
  saveState({ current })
  res.json({ current })
})

// ==================== 更新检查与下载 ====================

// 查询最新版本；force=1 跳过 30 分钟缓存（设置页手动检查用）
app.get('/api/update/check', async (req, res) => {
  try {
    res.json(await update.checkUpdate(req.query.force === '1'))
  } catch (e) {
    res.status(502).json({ error: '检查更新失败: ' + (e.message || '网络不可用') })
  }
})

// 启动应用内下载（服务端流式写盘，前端轮询进度）
app.post('/api/update/download', (req, res) => {
  const { tag, savePath } = req.body || {}
  if (!tag || !savePath) return res.status(400).json({ error: '缺少版本号或保存路径' })
  try {
    res.json(update.startDownload(tag, savePath))
  } catch (e) {
    res.status(409).json({ error: e.message || '无法开始下载' })
  }
})

// 下载进度快照
app.get('/api/update/download/progress', (req, res) => {
  res.json(update.getDownloadState())
})

app.get('/api/providers', (req, res) => {
  res.json(models.toSafeConfig(getConfig()))
})

app.get('/api/providers/:name/full', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (!config[name]) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }
  res.json(config[name])
})

// Provider 名称不允许为空或包含路径分隔符，否则会破坏 /api/providers/:name 系列路由
function validateProviderName(name) {
  if (!name || typeof name !== 'string') return '名称不能为空'
  const trimmed = name.trim()
  if (!trimmed) return '名称不能为空'
  if (trimmed.includes('/')) return '名称不能包含斜杠 /'
  if (/[\s]/.test(trimmed)) return '名称不能包含空格'
  return null
}

app.put('/api/providers/:name', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (!config[name]) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }
  const update = sanitizeProviderInput(req.body)
  // 不允许把通用 Provider 改成 WorkBuddy（若已存在 WorkBuddy 源），防止绕过唯一性限制
  if (update.type === 'workbuddy' && !models.isWorkbuddyProvider(config[name])) {
    const existing = models.listWorkbuddyProviders(config)
    if (existing.length) {
      return res.status(409).json({ error: `WorkBuddy 源只能有一个（已存在：${existing[0]}）` })
    }
  }
  applyPoolModelsForWorkbuddy(update)
  config[name] = { ...config[name], ...update }
  saveConfig(config)
  res.json({ ok: true })
})

// workbuddy 类型 Provider 的模型清单由账号池统一维护：未显式提供时用账号池启用清单填充
function applyPoolModelsForWorkbuddy(input) {
  if (!models.isWorkbuddyProvider(input)) return
  if (Array.isArray(input.models) && input.models.length > 0) return
  if (!workbuddy.getRuntime()) return
  const enabled = workbuddy.getEnabledModels()
  if (enabled.length) input.models = enabled
}

app.delete('/api/providers/:name', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (!config[name]) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }

  delete config[name]
  saveConfig(config)

  // 同步清理指向该 Provider 的引用，避免留下悬空配置
  const cleaned = cleanupProviderRefs(name, config)
  res.json({ ok: true, cleaned })
})

// 清理指向指定 Provider 的所有引用（当前模型 / 兜底 / 路由规则），返回被清理项
function cleanupProviderRefs(name, config) {
  const cleaned = []

  const state = getState()
  if (isRefOfProvider(state.current, name)) {
    state.current = firstAvailableRef(config) || 'auto'
    saveState(state)
    cleaned.push('state')
  }

  const fallbackData = getFallback()
  if (isRefOfProvider(fallbackData.model, name)) {
    saveFallback({ model: '' })
    cleaned.push('fallback')
  }

  const rulesResult = cleanupRuleRefs(engine.getRules(), name)
  if (rulesResult.changed) {
    engine.saveRules(rulesResult)
    cleaned.push('rules')
  }

  return cleaned
}

app.post('/api/providers/:name', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  const nameError = validateProviderName(name)
  if (nameError) {
    return res.status(400).json({ error: nameError })
  }
  if (config[name]) {
    return res.status(409).json({ error: `Provider ${name} already exists` })
  }
  const input = sanitizeProviderInput(req.body)
  // WorkBuddy 源全局唯一：已存在时拒绝新建（前端按钮也会同步禁用）
  if (models.isWorkbuddyProvider(input)) {
    const existing = models.listWorkbuddyProviders(config)
    if (existing.length) {
      return res.status(409).json({ error: `WorkBuddy 源只能有一个（已存在：${existing[0]}）` })
    }
  }
  applyPoolModelsForWorkbuddy(input)
  config[name] = input
  saveConfig(config)
  res.json({ ok: true })
})

app.post('/api/providers/:name/test', async (req, res) => {
  const config = getConfig()
  const { name } = req.params
  const raw = config[name]
  if (!raw) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }

  const provider = toProviderView(raw)
  if (!provider.apiKey && !models.isWorkbuddyProvider(provider)) {
    return res.json({ ok: false, error: 'API Key 未配置', latency: 0 })
  }
  if (!provider.models.length) {
    return res.json({ ok: false, error: '未配置模型', latency: 0 })
  }

  const requestedId = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const model = (requestedId && provider.models.find(m => m.id === requestedId)) || provider.models[0]

  // WorkBuddy 类型：通过账号池发一次真实短对话验证连通性
  if (models.isWorkbuddyProvider(provider)) {
    const start = Date.now()
    try {
      let aggregated = null
      await workbuddy.forwardChat({
        // 限制输出长度以加快连通性测试（上游仍强制流式，此处由本地聚合为单响应）
        body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 32 }),
        isStream: false,
        model: model.id,
        onDone: payload => {
          aggregated = payload
        }
      })
      const latency = Date.now() - start
      if (!aggregated) return res.json({ ok: false, error: '账号池未返回有效响应', latency, model: model.id })
      const usage = upstream.extractUsage(aggregated, false) || upstream.emptyUsage()
      return res.json({
        ok: true,
        latency,
        status: 200,
        model: model.id,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: upstream.usageTotal(usage)
      })
    } catch (err) {
      return res.json({ ok: false, error: err.message, latency: Date.now() - start, model: model.id })
    }
  }

  // 测试：优先测 Anthropic 端点，没有则测 OpenAI；URL 与请求头复用统一封装，避免尾斜杠拼出双斜杠
  const testAnthropic = !!provider.baseURL
  const maxTokens = model.maxOutput ? Math.min(32, model.maxOutput) : 32
  const testBody = {
    model: model.id,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: 'hi' }]
  }

  const start = Date.now()
  try {
    const url = upstream.resolveEndpoint(provider, testAnthropic)
    if (!url) {
      return res.json({ ok: false, error: '未配置可用的端点 URL', latency: 0 })
    }
    const headers = upstream.resolveHeaders(provider, testAnthropic)
    const response = await axios.post(url, testBody, { headers, timeout: 30000 })
    const latency = Date.now() - start
    const usage = upstream.extractUsage(response.data, testAnthropic) || upstream.emptyUsage()

    // 连通性测试不写入正式用量统计，避免污染数据
    res.json({
      ok: true,
      latency,
      status: response.status,
      model: model.id,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: upstream.usageTotal(usage)
    })
  } catch (err) {
    const latency = Date.now() - start
    const status = err.response?.status || 0
    const message = err.response?.data?.error?.message || err.message || '连接失败'
    res.json({ ok: false, error: message, status, latency, model: model.id })
  }
})

// ==================== WorkBuddy 账号池管理 ====================

// 未初始化时统一返回 400，避免前端拿到 500 无法区分
function requireWorkbuddy(res) {
  const rt = workbuddy.getRuntime()
  if (!rt) {
    res.status(400).json({ error: 'WorkBuddy 运行时未初始化' })
    return null
  }
  return rt
}

// 发起 OAuth 设备授权
app.post('/api/workbuddy/oauth/start', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const result = await workbuddy.oauthStart()
    res.json({ ok: true, state: result.state, url: result.url })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// 轮询 OAuth 结果（完成则凭证落盘 + 热加载进池）
app.get('/api/workbuddy/oauth/poll', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const state = String(req.query.state || '')
  if (!state) return res.status(400).json({ error: '缺少 state' })
  try {
    const result = await workbuddy.oauthPoll(state)
    res.json(result)
  } catch (err) {
    // 登录未完成属正常轮询状态，返回 done:false 让前端继续
    res.json({ done: false, message: err.message })
  }
})

// 账号列表（状态 + 汇总；合并账号运行态动作，面板显示「签到中 / 保活中 / 刷余额中」）
app.get('/api/workbuddy/accounts', (req, res) => {
  const rt = requireWorkbuddy(res)
  if (!rt) return
  const accounts = workbuddy.listAccounts().map(a => ({ ...a, runningAction: workbuddy.accountRunningAction(a.uid) }))
  res.json({ ok: true, accounts, counts: rt.pool.counts() })
})

// 人工禁用账号（保留凭证与状态，仅退出轮转；body.reason 可选）
app.post('/api/workbuddy/accounts/:uid/disable', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json(workbuddy.disableAccount(req.params.uid, String(req.body?.reason || '').trim()))
})

// 人工恢复启用（只清禁用，不动冷却/熔断）
app.post('/api/workbuddy/accounts/:uid/enable', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json(workbuddy.enableAccount(req.params.uid))
})

// 移除账号（删凭证文件 + 出池）
app.delete('/api/workbuddy/accounts/:uid', (req, res) => {
  if (!requireWorkbuddy(res)) return
  const ok = workbuddy.removeAccount(req.params.uid)
  if (!ok) return res.status(404).json({ error: '账号不存在' })
  res.json({ ok: true })
})

// 单号签到
app.post('/api/workbuddy/accounts/:uid/checkin', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const result = await workbuddy.checkinAccount(req.params.uid)
  res.json(result)
})

// 单号余额刷新
app.post('/api/workbuddy/accounts/:uid/balance', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const result = await workbuddy.refreshBalance(req.params.uid)
  res.json(result)
})

// 单号 token 保活
app.post('/api/workbuddy/accounts/:uid/keepalive', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const result = await workbuddy.keepaliveAccount(req.params.uid)
  res.json(result)
})

// 解冻 / 复活账号
app.post('/api/workbuddy/accounts/:uid/revive', (req, res) => {
  if (!requireWorkbuddy(res)) return
  const ok = workbuddy.reviveAccount(req.params.uid)
  if (!ok) return res.status(404).json({ error: '账号不存在' })
  res.json({ ok: true })
})

// 全量余额刷新
app.post('/api/workbuddy/accounts/refresh-balances', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const results = await workbuddy.refreshAllBalances()
  res.json({ ok: true, results })
})

// ==================== WorkBuddy 成长任务 ====================

// 任务接口错误回写：账号任务占用（account_busy）统一 409，其余按给定状态码
function sendTaskError(res, err, status = 400) {
  if (err && err.code === 'account_busy') {
    return res.status(409).json({ ok: false, code: 'account_busy', message: err.message || '该账号正在执行任务，请稍候' })
  }
  return res.status(status).json({ error: err.message })
}

// 全账号任务扫描（未完成 + 可自动化标记）
app.get('/api/workbuddy/tasks/scan', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const accounts = await workbuddy.taskScan()
    res.json({ ok: true, accounts })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// 全账号任务扫描（POST 变体；返回含 pending_count 汇总）
app.post('/api/workbuddy/tasks/scan_all', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const result = await workbuddy.taskScanAll()
    res.json({ ok: true, accounts: result.accounts, pending_count: result.pending_count })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// 单账号任务列表
app.get('/api/workbuddy/accounts/:uid/tasks', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const tasks = await workbuddy.taskList(req.params.uid)
    res.json({ ok: true, tasks })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

// 接受任务（body: uid, taskCodes?；taskCodes 为空则接受该账号全部未接受任务）
app.post('/api/workbuddy/tasks/accept', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const uid = String(req.body?.uid || '')
  const taskCodes = Array.isArray(req.body?.taskCodes) ? req.body.taskCodes : []
  if (!uid) return res.status(400).json({ error: '缺少 uid' })
  try {
    const result = await workbuddy.taskAccept(uid, taskCodes)
    res.json(result)
  } catch (err) {
    sendTaskError(res, err, 400)
  }
})

// 全账号接受全部未接受任务（body: uids?）
app.post('/api/workbuddy/tasks/accept_all', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const uids = Array.isArray(req.body?.uids) ? req.body.uids : []
  try {
    const result = await workbuddy.taskAcceptAll(uids)
    res.json(result)
  } catch (err) {
    sendTaskError(res, err, 400)
  }
})

// 单独领取某任务奖励（body: uid, taskCode）
app.post('/api/workbuddy/tasks/claim', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const uid = String(req.body?.uid || '')
  const taskCode = String(req.body?.taskCode || '')
  if (!uid) return res.status(400).json({ error: '缺少 uid' })
  if (!taskCode) return res.status(400).json({ error: '缺少 taskCode' })
  try {
    const result = await workbuddy.taskClaim(uid, taskCode)
    res.json(result)
  } catch (err) {
    sendTaskError(res, err, 400)
  }
})

// 一键完成（taskCode 为空跑全部可自动化任务）
app.post('/api/workbuddy/accounts/:uid/tasks/run', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const taskCode = String(req.body?.taskCode || '')
  try {
    const result = await workbuddy.taskRun(req.params.uid, taskCode)
    res.json(result)
  } catch (err) {
    sendTaskError(res, err, 400)
  }
})

// 任务执行进度快照（前端轮询）
app.get('/api/workbuddy/tasks/progress', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, ...workbuddy.taskProgress() })
})

// 启动多账号执行队列（body: uids?, taskCodes?, concurrency?）
app.post('/api/workbuddy/tasks/run_queue', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const uids = Array.isArray(req.body?.uids) ? req.body.uids : []
  const taskCodes = Array.isArray(req.body?.taskCodes) ? req.body.taskCodes.filter(Boolean) : []
  try {
    let result
    if (taskCodes.length) {
      // 指定任务码：按 uids（为空则全部非禁用账号）入队
      const targets = uids.length ? uids : workbuddy.listAccounts().filter(a => !a.disabled).map(a => a.uid)
      let enqueued = 0
      for (const uid of targets) enqueued += workbuddy.enqueue(uid, taskCodes).enqueued
      result = enqueued
        ? { ok: true, started: true, total: enqueued, enqueued }
        : { ok: true, started: false, total: 0, message: '没有可入队的任务' }
    } else {
      result = await workbuddy.queueOnce(uids, { concurrency: req.body?.concurrency })
    }
    if (result && result.conflict) {
      return res.status(409).json({ ok: false, code: 'queue_busy', message: result.message })
    }
    res.json(result)
  } catch (err) {
    sendTaskError(res, err, 400)
  }
})

// 队列状态快照（前端轮询）
app.get('/api/workbuddy/tasks/queue', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, ...workbuddy.queueStatus() })
})

// 单号积分构成明细（批次：名称/剩余/总额/到期时间）
app.get('/api/workbuddy/accounts/:uid/credits', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const result = await workbuddy.creditPackages(req.params.uid)
    res.json(result)
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

// 用量 / 积分消耗统计（hours 默认 72，上限 1440，0 = 全历史）
app.get('/api/workbuddy/usage', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, ...workbuddy.usageSnapshot(req.query.hours) })
})

// 积分变动流水（新的在前；limit 默认 200 上限 1000，uid 可选精确过滤）
app.get('/api/workbuddy/credit-history', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, ...workbuddy.creditHistory(req.query.limit, req.query.uid) })
})

// 立即落盘用量数据（面板「刷新」或关闭前调用）
app.post('/api/workbuddy/usage/save', (req, res) => {
  if (!requireWorkbuddy(res)) return
  workbuddy.usageSave()
  res.json({ ok: true })
})

// 账号池统一维护的启用模型清单
app.get('/api/workbuddy/models/enabled', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, models: workbuddy.getEnabledModels() })
})

// 保存启用模型清单，并同步写入所有 workbuddy 类型 Provider 的 models 字段
app.post('/api/workbuddy/models/enabled', (req, res) => {
  if (!requireWorkbuddy(res)) return
  const list = workbuddy.setEnabledModels(req.body?.models)

  // 持久化到 server-config.json
  const serverConfig = engine.getServerConfig()
  serverConfig.workbuddy = serverConfig.workbuddy || {}
  serverConfig.workbuddy.enabledModels = list
  engine.saveServerConfig(serverConfig)

  // 同步到所有 workbuddy Provider（引用体系 provider/modelId 依赖此字段）
  // 保留 Provider 侧已配置的模型级推理档位（按模型 id 匹配，不被账号池清单覆盖）
  const config = getConfig()
  let synced = 0
  for (const [name, raw] of Object.entries(config)) {
    const provider = toProviderView(raw)
    if (!models.isWorkbuddyProvider(provider)) continue
    const effortByID = new Map((provider.models || []).map(m => [m.id, m.reasoningEffort || '']))
    config[name] = {
      ...raw,
      models: list.map(m => {
        const effort = effortByID.get(m.id)
        return effort ? { ...m, reasoningEffort: effort } : { ...m }
      })
    }
    synced++
  }
  if (synced > 0) saveConfig(config)

  res.json({ ok: true, models: list, synced })
})

// WorkBuddy 运行日志（环形缓冲，支持频道过滤：chat / task / system）
app.get('/api/workbuddy/logs', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({
    ok: true,
    logs: workbuddy.getLogs({
      channel: req.query.channel || '',
      level: req.query.level || '',
      keyword: req.query.keyword || '',
      limit: req.query.limit || 200
    })
  })
})

// 上游模型列表（refresh=1 强制刷新缓存）
app.get('/api/workbuddy/models', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const list = await workbuddy.listUpstreamModels(req.query.refresh === '1')
    res.json({ ok: true, models: list })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// 池统计（健康 / 冷却 / 禁用）
app.get('/api/workbuddy/status', (req, res) => {
  const rt = requireWorkbuddy(res)
  if (!rt) return
  res.json({ ok: true, counts: rt.pool.counts(), accounts: rt.pool.list() })
})

// 定时任务状态（开关 / 时点 / 最近执行结果）
app.get('/api/workbuddy/scheduler', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, ...workbuddy.schedulerState() })
})

// 手动触发单类定时任务（checkin / travel / activity / keepalive / blackcat / balance）
app.post('/api/workbuddy/scheduler/run', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const task = String(req.body?.task || '')
  try {
    const result = await workbuddy.schedulerRun(task)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// 修改排程（时点 / 开关 / 余额刷新间隔，热生效）
app.put('/api/workbuddy/scheduler', (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const next = workbuddy.schedulerUpdateConfig(req.body || {})
    // 同步持久化到 server-config.json
    const serverConfig = engine.getServerConfig()
    serverConfig.workbuddy = serverConfig.workbuddy || {}
    serverConfig.workbuddy.schedule = { ...(serverConfig.workbuddy.schedule || {}), ...(req.body || {}) }
    engine.saveServerConfig(serverConfig)
    res.json({ ok: true, ...next })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// WorkBuddy 运行时配置（提示词模式 / 脱敏开关等，热生效）
app.get('/api/workbuddy/config', (req, res) => {
  const rt = requireWorkbuddy(res)
  if (!rt) return
  res.json({
    promptMode: rt.cfg.promptMode,
    sanitizeFingerprints: rt.cfg.sanitizeFingerprints,
    deviceTokenFile: rt.cfg.deviceTokenFile,
    pool: rt.pool.getConfig()
  })
})

app.put('/api/workbuddy/config', (req, res) => {
  const rt = requireWorkbuddy(res)
  if (!rt) return
  try {
    workbuddy.updateConfig(req.body || {})
    // 同步持久化到 server-config.json，重启后保留
    const serverConfig = engine.getServerConfig()
    const wb = serverConfig.workbuddy || {}
    if (typeof req.body?.promptMode === 'string') wb.promptMode = req.body.promptMode
    if (typeof req.body?.promptFile === 'string') wb.promptFile = req.body.promptFile
    if (typeof req.body?.sanitizeFingerprints === 'boolean') wb.sanitizeFingerprints = req.body.sanitizeFingerprints
    if (typeof req.body?.deviceTokenFile === 'string') wb.deviceTokenFile = req.body.deviceTokenFile
    serverConfig.workbuddy = wb
    engine.saveServerConfig(serverConfig)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/logs', (req, res) => {
  res.json(logger.getLogs({
    limit: req.query.limit,
    model: req.query.model || '',
    status: req.query.status || '',
    keyword: req.query.keyword || ''
  }))
})

app.get('/api/logs/models', (req, res) => {
  res.json(logger.getLoggedModels())
})

// 日志目录占用（字节数与文件数），供「日志查看」页提示存储体积
app.get('/api/logs/size', (req, res) => {
  res.json(logger.getTotalSize())
})

app.delete('/api/logs', (req, res) => {
  logger.clearLogs()
  res.json({ ok: true })
})

// 请求数统计与 Token 统计同源，均来自持久化的按天汇总，避免两个数字口径不一致
app.get('/api/stats', (req, res) => {
  res.json(tokenStats.getRequestSummary())
})

// 清空 Token 统计（不可恢复）：按日/月/时/模型与最近请求明细归零，状态面板请求数同源一并归零
app.delete('/api/stats', (req, res) => {
  tokenStats.clearAllStats()
  res.json({ ok: true })
})

app.get('/api/token-stats', (req, res) => {
  res.json(tokenStats.getAllStats())
})

app.get('/api/token-stats/today', (req, res) => {
  res.json(tokenStats.getTodayStats())
})

app.get('/api/token-stats/month', (req, res) => {
  res.json(tokenStats.getMonthStats())
})

app.get('/api/token-stats/model/:name', (req, res) => {
  res.json(tokenStats.getModelStats(req.params.name))
})

app.get('/api/token-stats/period/:days', (req, res) => {
  const days = parseInt(req.params.days)
  if (days < 1 || days > 30) {
    return res.status(400).json({ error: '天数必须在 1-30 之间' })
  }
  res.json({
    summary: tokenStats.getStatsByDays(days),
    details: tokenStats.getRecentDaysDetail(days)
  })
})

app.get('/api/token-stats/hourly/:date', (req, res) => {
  const { date } = req.params
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '日期格式必须为 YYYY-MM-DD' })
  }
  res.json({
    date,
    details: tokenStats.getHourlyDetailForDay(date)
  })
})

// ==================== 模型测分 ====================

app.get('/api/benchmark/questions', (req, res) => {
  res.json(benchmark.loadQuestions())
})

app.put('/api/benchmark/questions', (req, res) => {
  const incoming = Array.isArray(req.body?.questions) ? req.body.questions : null
  if (!incoming) {
    return res.status(400).json({ error: '题库格式不正确，需要 questions 数组' })
  }
  const normalized = incoming.map(benchmark.normalizeQuestion).filter(Boolean)
  if (!normalized.length) {
    return res.status(400).json({ error: '题库中没有有效题目，每题至少要有 prompt' })
  }
  const current = benchmark.loadQuestions()
  benchmark.saveQuestions({ ...current, version: 1, questions: normalized })
  res.json({ ok: true, count: normalized.length })
})

// 导入题库，body 可以是数组或 { questions, mode }，mode 为 replace / append
app.post('/api/benchmark/questions/import', (req, res) => {
  try {
    const payload = Array.isArray(req.body) ? req.body : (req.body?.questions ?? req.body)
    const mode = req.body?.mode === 'append' ? 'append' : 'replace'
    const count = benchmark.importQuestions(payload, mode)
    res.json({ ok: true, count })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/benchmark/questions/reset', (req, res) => {
  try {
    const count = benchmark.resetQuestions()
    res.json({ ok: true, count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 启动评测，立即返回 runId，执行在后台进行
app.post('/api/benchmark/run', (req, res) => {
  try {
    res.json(benchmark.startRun(req.body || {}))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/benchmark/status', (req, res) => {
  res.json(benchmark.getStatus())
})

app.get('/api/benchmark/runs', (req, res) => {
  res.json(benchmark.listRuns())
})

app.delete('/api/benchmark/runs', (req, res) => {
  benchmark.clearRuns()
  res.json({ ok: true })
})

app.get('/api/benchmark/runs/:id', (req, res) => {
  const run = benchmark.getRun(req.params.id)
  if (!run) return res.status(404).json({ error: '评测记录不存在' })
  res.json(run)
})

app.delete('/api/benchmark/runs/:id', (req, res) => {
  if (!benchmark.deleteRun(req.params.id)) {
    return res.status(404).json({ error: '评测记录不存在' })
  }
  res.json({ ok: true })
})

app.get('/api/rules', (req, res) => {
  res.json(engine.getRules())
})

app.put('/api/rules', (req, res) => {
  // 目标引用无法解析的规则落盘后永不命中且难以排查，保存前先校验
  const config = getConfig()
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : []
  const customRules = Array.isArray(req.body?.customRules) ? req.body.customRules : []

  for (const rule of rules) {
    if (!rule || typeof rule.condition !== 'string' || !rule.condition.trim()) {
      return res.status(400).json({ error: '存在条件为空的路由规则' })
    }
    if (!resolveRef(config, rule.target)) {
      return res.status(400).json({ error: `路由规则的目标模型不存在: ${rule?.target || '(空)'}` })
    }
  }

  for (const rule of customRules) {
    if (!rule || !String(rule.keyword || '').trim()) {
      return res.status(400).json({ error: '存在关键词为空的自定义规则' })
    }
    if (!resolveRef(config, rule.target)) {
      return res.status(400).json({ error: `自定义规则的目标模型不存在: ${rule?.target || '(空)'}` })
    }
  }

  engine.saveRules(req.body)
  res.json({ ok: true })
})

// 本机局域网 IPv4 列表（排除回环/链路本地；虚拟网卡排后，供教程页展示接入地址）
function getLocalIPv4s() {
  const physical = []
  const virtual = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.internal) continue
      const family = typeof info.family === 'string' ? info.family : `IPv${info.family}`
      if (family !== 'IPv4') continue
      const addr = String(info.address || '')
      if (!addr || addr.startsWith('169.254.')) continue
      const bucket = /vEthernet|VMware|VirtualBox|Hyper|Loopback|Virtual|TAP|TUN/i.test(name) ? virtual : physical
      if (!physical.includes(addr) && !virtual.includes(addr)) bucket.push(addr)
    }
  }
  return physical.concat(virtual)
}

app.get('/api/server-config', (req, res) => {
  res.json({ ...engine.getServerConfig(), localIPs: getLocalIPv4s() })
})

app.put('/api/server-config', (req, res) => {
  const current = engine.getServerConfig()
  const next = { ...current, ...req.body }
  // 非法端口落盘后服务重启即失败，保存前先校验
  const port = Number(next.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: '端口必须是 1-65535 的整数' })
  }
  next.port = port
  engine.saveServerConfig(next)
  res.json({ ok: true, portChanged: current.port !== next.port })
})

let server = null
let restarting = false

function listen(port) {
  server = app.listen(port, () => {
    console.log(`[aiRoute] running on http://localhost:${port}`)
  })
  server.on('error', (err) => {
    console.error('[aiRoute] server error:', err.message)
  })
}

// 重启只关闭并重新监听端口，不退出进程
// 生产模式下 Express 与 Electron 主进程同进程，process.exit 会把整个客户端一起杀掉
async function restartServer() {
  if (restarting) return
  restarting = true

  tokenStats.flush()

  const nextPort = engine.getServerConfig().port || 3000
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  } catch {
    // 低版本 Node 忽略
  }

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })

  listen(nextPort)
  restarting = false
}

app.post('/api/restart', (req, res) => {
  res.json({ ok: true })
  setTimeout(restartServer, 300)
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    port: (server && server.address()) ? server.address().port : (engine.getServerConfig().port || 3000)
  })
})

// 初始化 WorkBuddy 运行时（无账号时也可启动，转发时才报无可用账号）
function initWorkbuddy() {
  try {
    const wb = engine.getServerConfig().workbuddy || {}
    workbuddy.init({
      dataDir: paths.getDataDir(),
      poolConfig: wb.pool || {},
      scheduleConfig: wb.schedule || {},
      enabledModels: wb.enabledModels || [],
      promptMode: wb.promptMode || 'custom',
      promptFile: wb.promptFile || '',
      sanitizeFingerprints: wb.sanitizeFingerprints !== false,
      deviceTokenFile: wb.deviceTokenFile || '',
      log: msg => console.log(`[aiRoute] ${msg}`)
    })
  } catch (err) {
    console.error('[aiRoute] WorkBuddy 初始化失败:', err.message)
  }
}

initWorkbuddy()

// WorkBuddy 源归一化：设计上只允许一个源，多于一个时清空重建（账号池数据不受影响）
function normalizeWorkbuddyProviders() {
  try {
    const config = getConfig()
    const names = models.listWorkbuddyProviders(config)
    if (names.length <= 1) return

    console.log(`[aiRoute] 检测到 ${names.length} 个 WorkBuddy 源（${names.join('、')}），清空重建为单一源`)
    for (const name of names) {
      delete config[name]
      cleanupProviderRefs(name, config)
    }

    // 重建一个干净的源：模型清单用账号池启用清单
    let id = models.WORKBUDDY_PROVIDER_ID
    let suffix = 2
    while (config[id]) id = `${models.WORKBUDDY_PROVIDER_ID}-${suffix++}`
    const enabled = workbuddy.getRuntime() ? workbuddy.getEnabledModels() : []
    config[id] = { displayName: 'WorkBuddy 账号池', type: 'workbuddy', models: enabled }
    saveConfig(config)
    console.log(`[aiRoute] 已重建 WorkBuddy 源：${id}（${enabled.length} 个模型）`)
  } catch (err) {
    console.error('[aiRoute] WorkBuddy 源归一化失败:', err.message)
  }
}

normalizeWorkbuddyProviders()

const PORT = process.env.PORT || engine.getServerConfig().port || 3000
listen(PORT)
