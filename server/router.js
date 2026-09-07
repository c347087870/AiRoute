const express = require('express')
const cors = require('cors')
const axios = require('axios')
const fs = require('fs-extra')
const logger = require('./logger')
const engine = require('./router-engine')
const tokenStats = require('./token-stats')
const paths = require('./paths')
const models = require('./models')
const upstream = require('./upstream')
const benchmark = require('./benchmark')

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

  const { chain, primaryRef } = buildProviderChain(config, state, fallbackData, req.body)

  if (!chain.length) {
    tokenStats.recordFailure(primaryRef || '')
    logger.log({
      model: primaryRef || '',
      status: 0,
      error: '没有可用的 Provider 或模型，请先在 Provider 管理中配置',
      responseTime: 0
    })
    return res.status(500).json({ error: '没有可用的 Provider 或模型，请先在 Provider 管理中配置' })
  }

  const startTime = Date.now()
  let lastError = null

  for (const entry of chain) {
    const provider = entry.provider
    const isFallback = entry.ref !== primaryRef

    if (!provider.apiKey) {
      lastError = new Error('未配置 API Key')
      logFailure({
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
      logFailure({
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
    const reqBody = upstream.buildRequestBody(req.body, entry.model, isStream, clientIsAnthropic)

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
          logFailure({
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
          logFailure({
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
        logFailure({
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
      logFailure({
        model: entry.ref,
        status: err.response?.status || 500,
        error: err.message,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined
      })
    }
  }

  res.status(500).json({ error: 'All providers failed', detail: lastError?.message })
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
  config[name] = { ...config[name], ...update }
  saveConfig(config)
  res.json({ ok: true })
})

app.delete('/api/providers/:name', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (!config[name]) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }

  delete config[name]
  saveConfig(config)

  // 同步清理指向该 Provider 的引用，避免留下悬空配置
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

  res.json({ ok: true, cleaned })
})

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
  config[name] = sanitizeProviderInput(req.body)
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
  if (!provider.apiKey) {
    return res.json({ ok: false, error: 'API Key 未配置', latency: 0 })
  }
  if (!provider.models.length) {
    return res.json({ ok: false, error: '未配置模型', latency: 0 })
  }

  const requestedId = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const model = (requestedId && provider.models.find(m => m.id === requestedId)) || provider.models[0]

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

app.delete('/api/logs', (req, res) => {
  logger.clearLogs()
  res.json({ ok: true })
})

// 请求数统计与 Token 统计同源，均来自持久化的按天汇总，避免两个数字口径不一致
app.get('/api/stats', (req, res) => {
  res.json(tokenStats.getRequestSummary())
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

app.get('/api/server-config', (req, res) => {
  res.json(engine.getServerConfig())
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

const PORT = process.env.PORT || engine.getServerConfig().port || 3000
listen(PORT)
