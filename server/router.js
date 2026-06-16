const express = require('express')
const cors = require('cors')
const axios = require('axios')
const fs = require('fs-extra')
const path = require('path')
const logger = require('./logger')
const engine = require('./router-engine')
const tokenStats = require('./token-stats')

const app = express()
app.use(cors())
app.use(express.json({ limit: '100mb' }))

const DATA_DIR = process.env.AIROUTE_DATA_DIR || __dirname
const CONFIG_PATH = path.join(DATA_DIR, 'models.json')
const STATE_PATH = path.join(DATA_DIR, 'state.json')
const FALLBACK_PATH = path.join(DATA_DIR, 'fallback.json')

// 请求计数器
let totalRequests = 0
let todayRequests = 0
let todayDate = new Date().toDateString()

function incrementCounter() {
  const today = new Date().toDateString()
  if (today !== todayDate) {
    todayDate = today
    todayRequests = 0
  }
  totalRequests++
  todayRequests++
}

function getConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  return fs.readJsonSync(CONFIG_PATH)
}

function saveConfig(config) {
  fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 })
}

function getState() {
  if (!fs.existsSync(STATE_PATH)) return { current: 'auto' }
  return fs.readJsonSync(STATE_PATH)
}

function saveState(state) {
  fs.writeJsonSync(STATE_PATH, state, { spaces: 2 })
}

function getFallback() {
  if (!fs.existsSync(FALLBACK_PATH)) return { model: '' }
  return fs.readJsonSync(FALLBACK_PATH)
}

function saveFallback(fallback) {
  fs.writeJsonSync(FALLBACK_PATH, fallback, { spaces: 2 })
}

// 根据客户端请求的协议类型返回对应的端点 URL
function resolveEndpoint(provider, clientIsAnthropic) {
  if (clientIsAnthropic) {
    return provider.baseURL + '/v1/messages'
  }
  const openaiUrl = provider.openaiURL || ''
  if (!openaiUrl) return null
  return openaiUrl + '/chat/completions'
}

// 根据客户端请求的协议类型返回对应的请求头
function resolveHeaders(provider, clientIsAnthropic) {
  if (clientIsAnthropic) {
    return {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  }
  return {
    'Authorization': `Bearer ${provider.apiKey}`,
    'content-type': 'application/json'
  }
}

function resolveRequestBody(provider, body, isStream) {
  const reqBody = { ...body, model: provider.model }
  if (isStream !== undefined) {
    reqBody.stream = isStream
  }
  return reqBody
}

// 非流式响应中提取 Token 用量
function extractTokensFromResponse(data, isAnthropicFormat) {
  if (isAnthropicFormat) {
    if (data.usage) {
      return {
        input: data.usage.input_tokens || 0,
        output: data.usage.output_tokens || 0
      }
    }
  } else {
    if (data.usage) {
      return {
        input: data.usage.prompt_tokens || 0,
        output: data.usage.completion_tokens || 0
      }
    }
  }
  return null
}

// 从流式响应 chunk 中提取 Token 用量
function extractTokensFromStreamChunk(chunk, isAnthropicFormat) {
  try {
    const text = chunk.toString()
    const lines = text.split('\n').filter(line => line.trim())

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue

      const dataStr = line.slice(6).trim()
      if (dataStr === '[DONE]') continue

      try {
        const data = JSON.parse(dataStr)

        if (isAnthropicFormat) {
          if (data.type === 'message_delta' && data.usage) {
            return {
              input: data.usage.input_tokens || 0,
              output: data.usage.output_tokens || 0
            }
          }
          if (data.type === 'message_start' && data.message?.usage) {
            return {
              input: data.message.usage.input_tokens || 0,
              output: 0
            }
          }
        } else {
          if (data.usage) {
            return {
              input: data.usage.prompt_tokens || 0,
              output: data.usage.completion_tokens || 0
            }
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  } catch (e) {
    // 忽略整体解析错误
  }

  return null
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
  incrementCounter()

  const config = getConfig()
  const state = getState()
  const fallback = getFallback()
  const isStream = !!req.body.stream
  const clientIsAnthropic = req.path === '/v1/messages'

  let primaryModel = state.current
  if (primaryModel === 'auto') {
    const routed = engine.resolveModel(req.body)
    primaryModel = routed || Object.keys(config)[0]
  }

  const fallbackModel = fallback.model && config[fallback.model] ? fallback.model : null
  const providerChain = [primaryModel]
  if (fallbackModel && fallbackModel !== primaryModel) {
    providerChain.push(fallbackModel)
  }

  const startTime = Date.now()
  let lastError = null

  for (const name of providerChain) {
    const provider = config[name]
    if (!provider || !provider.apiKey) continue

    try {
      const url = resolveEndpoint(provider, clientIsAnthropic)
      if (!url) {
        lastError = new Error(clientIsAnthropic ? '未配置 Anthropic 端点 (baseURL)' : '未配置 OpenAI 端点 (openaiURL)')
        logger.log({
          model: name,
          status: 0,
          error: lastError.message,
          responseTime: Date.now() - startTime,
          fallback: true,
          fallbackFrom: primaryModel
        })
        continue
      }
      const headers = resolveHeaders(provider, clientIsAnthropic)
      const reqBody = resolveRequestBody(provider, req.body, isStream)

      if (isStream) {
        try {
          const upstream = await axios.post(url, reqBody, {
            headers,
            timeout: 300000,
            responseType: 'stream',
            validateStatus: () => true
          })

          if (upstream.status !== 200) {
            lastError = new Error(`Upstream returned ${upstream.status}`)
            logger.log({
              model: name,
              status: upstream.status,
              error: lastError.message,
              responseTime: Date.now() - startTime,
              fallback: true,
              fallbackFrom: primaryModel
            })
            continue
          }

          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')

          let streamTokens = { input: 0, output: 0 }
          const chunks = []

          upstream.data.on('data', (chunk) => {
            const tokens = extractTokensFromStreamChunk(chunk, clientIsAnthropic)
            if (tokens) {
              if (tokens.input > 0) streamTokens.input = tokens.input
              if (tokens.output > 0) streamTokens.output = tokens.output
            }
            chunks.push(chunk)
            res.write(chunk)
          })

          upstream.data.on('end', () => {
            if (streamTokens.input > 0 || streamTokens.output > 0) {
              console.log(`[Token Stats] ✅ Stream request completed - Model: ${name}`)
              tokenStats.recordTokens(name, streamTokens.input, streamTokens.output)
              logger.log({
                model: name,
                status: 200,
                responseTime: Date.now() - startTime,
                fallback: name !== primaryModel,
                fallbackFrom: name !== primaryModel ? primaryModel : undefined,
                inputTokens: streamTokens.input,
                outputTokens: streamTokens.output,
                totalTokens: streamTokens.input + streamTokens.output,
                stream: true
              })
            } else {
              console.log(`[Token Stats] ⚠️ Stream request completed but no tokens found - Model: ${name}`)
              logger.log({
                model: name,
                status: 200,
                responseTime: Date.now() - startTime,
                fallback: name !== primaryModel,
                fallbackFrom: name !== primaryModel ? primaryModel : undefined,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                stream: true
              })
            }
            res.end()
          })

          upstream.data.on('error', (err) => {
            logger.log({
              model: name,
              status: 500,
              error: err.message,
              responseTime: Date.now() - startTime,
              fallback: true,
              fallbackFrom: primaryModel,
              stream: true
            })
            try { res.end() } catch {}
          })

          return
        } catch (streamErr) {
          lastError = streamErr
          logger.log({
            model: name,
            status: streamErr.response?.status || 500,
            error: streamErr.message,
            responseTime: Date.now() - startTime,
            fallback: true,
            fallbackFrom: primaryModel
          })
          continue
        }
      }

      const response = await axios.post(url, reqBody, {
        headers,
        timeout: 60000
      })

      const elapsed = Date.now() - startTime

      const tokens = extractTokensFromResponse(response.data, clientIsAnthropic)
      if (tokens) {
        tokenStats.recordTokens(name, tokens.input, tokens.output)
      }

      logger.log({
        model: name,
        status: 200,
        responseTime: elapsed,
        fallback: name !== primaryModel,
        fallbackFrom: name !== primaryModel ? primaryModel : undefined,
        inputTokens: tokens?.input || 0,
        outputTokens: tokens?.output || 0,
        totalTokens: tokens ? (tokens.input + tokens.output) : 0
      })

      return res.json(response.data)
    } catch (err) {
      lastError = err
      logger.log({
        model: name,
        status: err.response?.status || 500,
        error: err.message,
        responseTime: Date.now() - startTime,
        fallback: true,
        fallbackFrom: primaryModel
      })
    }
  }

  res.status(500).json({ error: 'All providers failed', detail: lastError?.message })
}

app.post('/v1/messages', handleRequest)
app.post('/v1/chat/completions', handleRequest)

app.get('/v1/models', (req, res) => {
  const config = getConfig()
  const aliases = [
    'claude-opus-4-0-20250514', 'claude-opus-4-20250514',
    'claude-sonnet-4-0-20250514', 'claude-sonnet-4-20250514',
    'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022', 'claude-3-opus-20240229',
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'
  ]
  const configured = Object.entries(config).map(([name, provider]) => ({
    id: provider.model || name, object: 'model', created: 0, owned_by: 'airoute'
  }))
  const extra = aliases.filter(a => !configured.some(m => m.id === a)).map(id => ({
    id, object: 'model', created: 0, owned_by: 'airoute'
  }))
  res.json({ object: 'list', data: [...configured, ...extra] })
})

app.get('/api/state', (req, res) => {
  res.json(getState())
})

app.post('/api/state', (req, res) => {
  const { current } = req.body
  saveState({ current })
  res.json({ current })
})

app.get('/api/providers', (req, res) => {
  const config = getConfig()
  const safe = {}
  for (const [name, provider] of Object.entries(config)) {
    safe[name] = {
      ...provider,
      apiKey: provider.apiKey ? '••••••••' : ''
    }
  }
  res.json(safe)
})

app.get('/api/providers/:name/full', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (!config[name]) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }
  res.json(config[name])
})

app.put('/api/providers/:name', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (!config[name]) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }
  const update = { ...req.body }
  if (!update.apiKey || update.apiKey.trim() === '') {
    delete update.apiKey
  }
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
  res.json({ ok: true })
})

app.post('/api/providers/:name', (req, res) => {
  const config = getConfig()
  const { name } = req.params
  if (config[name]) {
    return res.status(409).json({ error: `Provider ${name} already exists` })
  }
  config[name] = req.body
  saveConfig(config)
  res.json({ ok: true })
})

app.post('/api/providers/:name/test', async (req, res) => {
  const config = getConfig()
  const { name } = req.params
  const provider = config[name]
  if (!provider) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }
  if (!provider.apiKey) {
    return res.json({ ok: false, error: 'API Key 未配置', latency: 0 })
  }

  // 测试：优先测 Anthropic 端点，没有则测 OpenAI
  const testAnthropic = !!provider.baseURL
  const testBody = {
    model: provider.model,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hi' }]
  }

  const start = Date.now()
  try {
    const url = testAnthropic
      ? provider.baseURL + '/v1/messages'
      : (provider.openaiURL || provider.baseURL) + '/chat/completions'
    const headers = testAnthropic
      ? { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      : { 'Authorization': `Bearer ${provider.apiKey}`, 'content-type': 'application/json' }
    const reqBody = { ...testBody, model: provider.model }
    const response = await axios.post(url, reqBody, { headers, timeout: 30000 })
    const latency = Date.now() - start

    const tokens = extractTokensFromResponse(response.data, testAnthropic)
    if (tokens) {
      tokenStats.recordTokens(name, tokens.input, tokens.output)
    }

    res.json({
      ok: true,
      latency,
      status: response.status,
      inputTokens: tokens?.input || 0,
      outputTokens: tokens?.output || 0,
      totalTokens: tokens ? (tokens.input + tokens.output) : 0
    })
  } catch (err) {
    const latency = Date.now() - start
    const status = err.response?.status || 0
    const message = err.response?.data?.error?.message || err.message || '连接失败'
    res.json({ ok: false, error: message, status, latency })
  }
})

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50
  res.json(logger.getLogs(limit))
})

app.get('/api/stats', (req, res) => {
  res.json({
    totalRequests,
    todayRequests
  })
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
  const { name } = req.params
  res.json(tokenStats.getModelStats(name))
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

app.get('/api/rules', (req, res) => {
  res.json(engine.getRules())
})

app.put('/api/rules', (req, res) => {
  engine.saveRules(req.body)
  res.json({ ok: true })
})

app.get('/api/server-config', (req, res) => {
  res.json(engine.getServerConfig())
})

app.put('/api/server-config', (req, res) => {
  const current = engine.getServerConfig()
  const next = { ...current, ...req.body }
  engine.saveServerConfig(next)
  res.json({ ok: true, portChanged: current.port !== next.port })
})

app.post('/api/restart', (req, res) => {
  res.json({ ok: true })
  setTimeout(() => {
    server.close()
    process.exit(0)
  }, 300)
})

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() })
})

const PORT = process.env.PORT || engine.getServerConfig().port || 3000
const server = app.listen(PORT, () => {
  console.log(`[aiRoute] running on http://localhost:${PORT}`)
})
