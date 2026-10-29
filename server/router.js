const express = require('express')
const cors = require('cors')
const axios = require('axios')
const fs = require('fs-extra')
const os = require('os')
const { StringDecoder } = require('string_decoder')
const logger = require('./logger')
const engine = require('./router-engine')
const tokenStats = require('./token-stats')
const paths = require('./paths')
const models = require('./models')
const upstream = require('./upstream')
const iputil = require('./iputil')
const benchmark = require('./benchmark')
const update = require('./update')
const workbuddy = require('./workbuddy/runtime')
const wbVersionCheck = require('./workbuddy/versioncheck')
const wbIdentity = require('./workbuddy/identity')
const wbSession = require('./workbuddy/session')
const wbAnthropic = require('./workbuddy/anthropic')
const wbResponses = require('./workbuddy/responses')
const providerModels = require('./provider-models')
const channels = require('./channels')
const channelSse = require('./channels/sse')
const autoStrategy = require('./auto-strategy')
const configIO = require('./config-io')
const modelHealth = require('./model-health')
const modelHealthAudit = require('./model-health-audit')
const accountHealth = require('./account-health')
// 「这次失败算谁的」判定（客户端取消 vs 上游卡死），见 server/failure-class.js
const { isAbortFailure, classifyChannelFailure, stallMessage, CHANNEL_FIRST_CHUNK_TIMEOUT_MS } = require('./failure-class')
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

// 客户端是否已断开：只看「响应已收尾」与「连接套接字已销毁」。
// 不能用 req.destroyed——express.json() 消费完请求体后它恒为 true（实测），
// 会把「客户端仍在等待」误判为「已断开」，导致换号/截断重试被直接跳过并抛 500
function clientGone(req, res) {
  if (res.writableEnded || res.finished) return true
  const sock = req.socket || res.socket
  if (sock && sock.destroyed) return true
  return false
}

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
  // 失活的模型不参与建链：它在 /v1/models 里已经不播报了，这里再放进来只会让
  // 每个请求先撞一次已知会失败的墙。被跳过的引用原样带出去 —— 建链为空时
  // 错误文案要能说清「不是没配，是失活了」。
  const dropOffline = chain => {
    const live = []
    const skippedOffline = []
    for (const entry of chain) {
      if (modelHealth.isOffline(entry.ref)) skippedOffline.push(entry.ref)
      else live.push(entry)
    }
    return { live, skippedOffline }
  }

  // 客户端点名了 auto 伪模型（/v1/models 只播报 auto 一个）：这次请求按
  // 服务端配置的策略挑模型，与面板里的激活模型无关。其它 model 值照旧被忽略
  // —— 保持「切换只在 AiRoute 里做」。
  const requested = typeof body?.model === 'string' ? body.model.trim() : ''
  if (autoStrategy.isAutoId(requested)) {
    const strategy = autoStrategy.getStrategy()
    const chain = autoStrategy.buildChain(config, strategy, fallbackData.model)
    if (chain.length) {
      const { live, skippedOffline } = dropOffline(chain)
      // 候选全失活时返回空链：不能让已失活的候选继续顶上去
      return {
        chain: live,
        primaryRef: (live[0] || chain[0]).ref,
        autoModel: autoStrategy.AUTO_MODELS[0],
        skippedOffline
      }
    }
  }

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

  const { live, skippedOffline } = dropOffline(chain)
  // primaryRef 保留原始请求的引用（哪怕它已失活）：日志里「从哪个模型兜底过来」
  // 需要这个真实来源，而不是过滤后的第一个
  return { chain: live, primaryRef: primary ? primary.ref : requestedRef, skippedOffline }
}

function logFailure(entry) {
  logger.log(entry)
  tokenStats.recordFailure(entry.model)
  // 连续失败计数：只有真实转发失败才计入失活判定。
  // 用户主动取消（关页面、点停止）不是模型的问题 —— 判据见 failure-class.js
  if (!isAbortFailure(entry)) modelHealth.noteFailure(entry.model, entry.error)
}

app.get('/api/fallback', (req, res) => {
  res.json(getFallback())
})

app.put('/api/fallback', (req, res) => {
  const { model } = req.body || {}
  saveFallback({ model: model || '' })
  res.json({ ok: true, model })
})

async function handleRequest(req, res) {
  const config = getConfig()
  const state = getState()
  const fallbackData = getFallback()
  const isStream = !!req.body?.stream
  const clientIsAnthropic = req.path === '/v1/messages'
  const clientIsResponses = req.path === '/v1/responses'

  // 任务级日志上下文：同一任务（一次输入+其工具循环）的多次请求合并为一条日志记录
  const rawBody = JSON.stringify(req.body || {})
  const baseLog = {
    taskKey: wbSession.extractTaskKey(rawBody) || undefined,
    input: wbSession.extractInputText(rawBody) || undefined
  }

  const { chain, primaryRef, skippedOffline = [] } = buildProviderChain(config, state, fallbackData, req.body)

  if (!chain.length) {
    const noChainMsg = skippedOffline.length
      ? `模型已失活（${skippedOffline.join('、')}），在 Provider / 渠道账号页恢复后重试`
      : '没有可用的 Provider 或模型，请先在 Provider 管理中配置'
    tokenStats.recordFailure(primaryRef || '')
    logger.log({
      ...baseLog,
      model: primaryRef || '',
      status: 0,
      error: noChainMsg,
      responseTime: 0
    })
    const noChainBody = clientIsAnthropic
      ? wbAnthropic.errorBody(noChainMsg)
      : clientIsResponses
        ? wbResponses.errorBody(noChainMsg)
        : { error: noChainMsg }
    return res.status(500).json(noChainBody)
  }

  const startTime = Date.now()
  let lastError = null
  let activeUpstreamStream = null // 当前活跃的通用 Provider 上游响应流（流式分支注册，重试时覆盖）
  // 在途计数（auto-least-conn 的唯一数据源）：派发给哪个候选就记在它头上，
  // 换下一个候选或请求收尾时释放。必须覆盖**所有**转发请求 —— 只统计 auto 请求的话，
  // 手动激活模型上正在跑的并发对策略就是隐形的。流式转发注册完回调就返回，
  // 所以释放挂在 res close 上（那也正好是「连接」在这里的字面含义）
  let releaseHeld = null
  const releaseCurrent = () => {
    if (!releaseHeld) return
    releaseHeld()
    releaseHeld = null
  }
  res.on('close', releaseCurrent)
  // 下游断开时取消尚未返回响应头的请求，避免上游仍在生成却已被算作空闲。
  // clientDisconnected 供失败记账用：断开引起的 abort / stream error 不是模型的锅，
  // 不能因为它文案里没有「取消」两个字就记进连续失败
  const upstreamController = new AbortController()
  let clientDisconnected = false
  res.on('close', () => {
    if (res.writableEnded) return // 正常收尾不算断开
    clientDisconnected = true
    upstreamController.abort()
    const s = activeUpstreamStream
    activeUpstreamStream = null
    if (s) {
      try {
        s.destroy()
      } catch {
        /* 忽略 */
      }
    }
  })

  for (const entry of chain) {
    releaseCurrent()
    // close 之后不能再占用下一候选：此时不会有第二次 close 来释放它。
    if (clientGone(req, res)) return
    releaseHeld = autoStrategy.beginAttempt(entry.ref)
    const provider = entry.provider
    const isFallback = entry.ref !== primaryRef

    // Channel 类型：渠道包（十家免费账号 + WorkBuddy 的国内版/国际版）
    if (models.isChannelProvider(provider)) {
      try {
        // WorkBuddy 的补全不走 worker：它的 payload 管线在主进程，绕进渠道包
        // 的 GenerateOptions 再转回 OpenAI 是两次有损转换（见 worker.mjs 注释）
        const realm = channelWorkbuddyRealm(entry.model.id)
        if (realm) {
          await handleWorkbuddyRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic, clientIsResponses, realm)
        } else {
          await handleChannelRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic, clientIsResponses)
        }
        return
      } catch (err) {
        lastError = err
        logFailure({ ...baseLog,
          model: entry.ref,
          status: err.status || 500,
          error: err.message,
          detail: err.body || undefined,
          kind: err.kind || undefined,
          code: err.code || undefined,
          responseTime: Date.now() - startTime,
          fallback: isFallback,
          fallbackFrom: isFallback ? primaryRef : undefined,
          // 渠道转发自己判定的「客户端取消」（见 handleChannelRequest）：
          // 只有这种情况不算模型的连续失败
          clientCancelled: err.clientCancelled === true
        })
        continue
      }
    }

    // WorkBuddy 类型：走账号池转发（不需要 apiKey / 端点 URL）
    if (models.isWorkbuddyProvider(provider)) {
      try {
        await handleWorkbuddyRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic, clientIsResponses)
        return
      } catch (err) {
        lastError = err
        logFailure({ ...baseLog,
          model: entry.ref,
          status: err.status || 500,
          error: err.message,
          // 上游原始错误体与分类（排障用）：仅消息不足以定位上游业务码
          detail: err.body || undefined,
          kind: err.kind || undefined,
          code: err.code || undefined,
          gatewayHint: err.gatewayHint || undefined,
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
    // Responses 客户端：请求体先转 Chat 形态，再发往 OpenAI 兼容端点
    const clientBody = clientIsResponses ? wbResponses.toChat(req.body || {}) : req.body
    const reqBody = upstream.buildRequestBody(
      clientBody,
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
          signal: upstreamController.signal,
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
        res.setHeader('X-Accel-Buffering', 'no') // 反代逐帧透传：缺此头会被 Nginx 攒批，长流被客户端判为卡死

        const streamUsage = upstream.emptyUsage()
        const usageExtractor = upstream.createStreamUsageExtractor(clientIsAnthropic)
        // Responses 客户端：上游 Chat SSE 逐行转换后写出；其余原样透传
        const rsEmitter = clientIsResponses ? wbResponses.createStreamEmitter({ model: entry.ref }) : null
        let rsBuffer = ''
        // UTF-8 增量解码器：TCP 分块边界可能落在多字节字符中间，
        // chunk.toString() 逐块独立解码会在字符中部产生 U+FFFD（乱码）
        const rsDecoder = new StringDecoder('utf8')
        let closed = false // 收尾标记（幂等）：正常 EOF、上游错误、空闲超时、下游断开都汇到这里
        let sawDone = false // 已向下游写过 [DONE]（上游自带时不重复补）
        let sawAnyData = false // 上游是否产出过任何字节（用于识别"200 空流"）
        // [DONE] 跨 chunk 的检测窗口：TCP 可能把它切到两个 chunk，只按单 chunk 匹配
        // 会漏判，进而在收尾时补发第二个 [DONE]（下游读到重复收尾标记）
        let doneProbe = ''
        let idleTimer = null
        const idleMs = 300000 // 流中空闲上限（与 WorkBuddy 链路一致）：超时即判上游卡死并主动收尾

        // 统一收尾（幂等）：补 [DONE] 后 end 响应；调用方负责先断开上游
        const finishStream = () => {
          if (closed) return
          closed = true
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
          try {
            if (rsEmitter) {
              const tail = rsEmitter.end()
              if (tail) res.write(tail)
            } else if (!sawDone) {
              res.write('data: [DONE]\n\n')
              sawDone = true
            }
          } catch {
            /* 下游已断开 */
          }
          try {
            res.end()
          } catch {
            /* 下游已断开 */
          }
        }

        // 空闲看门狗：上游长时间无字节 → 断开上游 + 补 error 帧收尾，避免下游无限挂住
        const abortIdle = () => {
          try {
            upstreamRes.data.destroy()
          } catch {
            /* 忽略 */
          }
          logFailure({
            ...baseLog,
            model: entry.ref,
            status: 504,
            error: `upstream stream idle timeout (${idleMs}ms)`,
            responseTime: Date.now() - startTime,
            fallback: isFallback,
            fallbackFrom: isFallback ? primaryRef : undefined,
            stream: true
          })
          try {
            if (rsEmitter) res.write(rsEmitter.fail('upstream stream idle timeout'))
            else if (!sawDone) res.write('data: {"error":{"message":"upstream stream idle timeout","type":"upstream_error","code":"upstream_idle_timeout"}}\n\n')
          } catch {
            /* 下游已断开 */
          }
          finishStream()
        }

        // 刷新空闲计时（每收到一个上游字节就重置）
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(abortIdle, idleMs)
          if (idleTimer.unref) idleTimer.unref()
        }

        // 注册当前活跃上游流：下游断开由请求级监听统一处理（避免重试循环里叠加 res 监听）
        activeUpstreamStream = upstreamRes.data
        armIdle()
        upstreamRes.data.on('data', (chunk) => {
          armIdle()
          sawAnyData = true
          upstream.mergeStreamUsage(streamUsage, usageExtractor.push(chunk))
          if (!sawDone) {
            // 滑窗检测上游自带的收尾标记：窗口只保留末尾若干字节，不随流增长。
            // 用 latin1 做纯字节映射（此处只匹配 ASCII 子串，不涉及多字节解码）
            doneProbe = (doneProbe + chunk.toString('latin1')).slice(-16)
            if (doneProbe.includes('[DONE]')) sawDone = true
          }
          if (!rsEmitter) {
            res.write(chunk)
            return
          }
          rsBuffer += rsDecoder.write(chunk)
          let idx
          while ((idx = rsBuffer.indexOf('\n')) >= 0) {
            const line = rsBuffer.slice(0, idx)
            rsBuffer = rsBuffer.slice(idx + 1)
            if (!line.trim()) continue
            const out = rsEmitter.push(line.replace(/\r+$/, ''))
            if (out) res.write(out)
          }
        })

        upstreamRes.data.on('end', () => {
          upstream.mergeStreamUsage(streamUsage, usageExtractor.end())
          if (closed) return // 已因空闲/断开收尾：不重复记日志与收尾
          // 空流（上游 200 但零字节）：补 error 帧，避免下游把空响应当成正常完成而一直等
          if (!sawAnyData && !rsEmitter) {
            try {
              res.write('data: {"error":{"message":"upstream returned an empty stream","type":"upstream_error","code":"upstream_empty_stream"}}\n\n')
            } catch {
              /* 下游已断开 */
            }
          }
          tokenStats.recordTokens(entry.ref, streamUsage)
          modelHealth.noteSuccess(entry.ref)
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
            totalTokens: upstream.usageTotalOrNull(streamUsage),
            stream: true
          })
          finishStream()
        })

        upstreamRes.data.on('error', (err) => {
          logFailure({ ...baseLog,
            model: entry.ref,
            status: 500,
            error: err.message,
            responseTime: Date.now() - startTime,
            fallback: isFallback,
            fallbackFrom: isFallback ? primaryRef : undefined,
            // 下游先断 → 我们 destroy 了上游流，这个 error 是善后产物，不算模型失败
            clientCancelled: clientDisconnected,
            stream: true
          })
          if (closed) return
          // 上游中途断流：补 error 帧 + [DONE]，避免下游一直等收尾
          try {
            if (rsEmitter) res.write(rsEmitter.fail(`upstream stream error: ${err.message}`))
            else if (!sawDone) res.write('data: {"error":{"message":"upstream stream error","type":"upstream_error","code":"upstream_stream_error"}}\n\n')
          } catch {
            /* 下游已断开 */
          }
          finishStream()
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
          fallbackFrom: isFallback ? primaryRef : undefined,
          // axios 因 signal 被 abort 抛的是 CanceledError（文案带 cancel），
          // 这里再显式标一次，避免依赖文案
          clientCancelled: clientDisconnected
        })
        continue
      }
    }

    try {
      const response = await axios.post(url, reqBody, { headers, timeout: 60000, signal: upstreamController.signal })
      const elapsed = Date.now() - startTime
      const usage = upstream.extractUsage(response.data, clientIsAnthropic) || upstream.emptyUsage()

      tokenStats.recordTokens(entry.ref, usage)

      modelHealth.noteSuccess(entry.ref)
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
        totalTokens: upstream.usageTotalOrNull(usage)
      })

      // Responses 客户端：聚合结果转 Response 对象后返回
      return res.json(clientIsResponses ? wbResponses.toResponse(response.data, entry.ref) : response.data)
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

  releaseCurrent()
  if (clientGone(req, res)) return

  // 状态码：优先用运行时给出的 status（模型不可用 400、池中无号 503 等），
  // 否则 500。此前一律 500，把「换个模型就行」说成了网关故障。
  const finalStatus = lastError?.status || 500
  // 上游排队/限流带回来的等待时间：告诉客户端「多久之后再来」，
  // 缺了它客户端只能立刻重试，正好撞在同一堵墙上
  const retryAfterMs = Number(lastError?.retryAfterMs) || 0
  if (retryAfterMs > 0) res.setHeader('Retry-After', String(Math.max(1, Math.round(retryAfterMs / 1000))))
  if (clientIsAnthropic) {
    return res.status(finalStatus).json(wbAnthropic.errorBody(lastError?.message || 'All providers failed', lastError?.gatewayHint))
  }
  res.status(finalStatus).json({
    error: 'All providers failed',
    detail: lastError?.message,
    // 错误分类与网关侧错误码（排障用；无则不带字段）
    ...(lastError?.kind ? { kind: lastError.kind } : {}),
    ...(lastError?.code ? { code: lastError.code } : {}),
    // 网关补充说明（gateway_hint；无提示时不带字段）
    ...(lastError?.gatewayHint ? { gateway_hint: lastError.gatewayHint } : {})
  })
}

// WorkBuddy 在渠道包里注册成两个 provider（国内版 / 国际版），模型 id 的前缀
// 就是区域。拆成两个而不是一个：模型 id 在两地清单里会重名，而 `provider/model`
// 是 AiRoute 的引用键，合成一个就无法表达「国内版的 X」。
const WORKBUDDY_CHANNEL_REALM = { workbuddy: 'cn', 'workbuddy-global': 'global' }

// 返回该渠道模型对应的 WorkBuddy 区域；不是 WorkBuddy 的模型返回 ''
function channelWorkbuddyRealm(modelId) {
  const provider = String(modelId || '').split('/')[0]
  return WORKBUDDY_CHANNEL_REALM[provider] || ''
}

// 渠道测试的「传输层抖动」判据与重试间隔
//
// 为什么需要重试：本机 DNS 走代理的 fake-IP（198.18.x.x），实测会出现成片的
// `getaddrinfo ENOTFOUND` —— 同一轮测试里 loomy / raccoon 同时 `fetch failed`，
// 只花 2 到 6 毫秒（请求根本没发出去），过几分钟原样重测又全通。这类失败与
// 「模型/账号真的不可用」有本质区别：把一次 DNS 抖动写成红点并持久化，用户下次
// 打开模型页会以为模型坏了。
//
// 只重试「请求没打出去」这一类。业务错误（401、模型不存在、额度用尽、上游限流）
// 一律不重试 —— 重试无用，还多打一次上游、平白增加风控风险。超时同样不重试：
// sse chunk timeout 是 120 秒，重试一次会把整轮测试拖到 240 秒，超过前端 180 秒
// 的请求超时，用户只会看到「请求超时」而不是真实原因。
const TEST_TRANSIENT_RE = /(fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|socket hang up|terminated|UND_ERR_|渠道网络请求失败)/i
const TEST_TRANSIENT_RETRY_MS = 800

function isTransientTestError(error) {
  const message = String(error?.message || '')
  if (/timeout/i.test(message)) return false
  return TEST_TRANSIENT_RE.test(message) || TEST_TRANSIENT_RE.test(String(error?.code || ''))
}

// 测试结果的计时口径：一次测试有三个有意义的时间点，界面上都要能看到。
//   ttfbMs    首字节到达（含选号 / 排队 / 上游思考）—— 用户感知的「响应时间」
//   totalMs   整次调用耗时（含把 64 个 token 收完）
//   genMs     纯生成耗时 = total - ttfb，从第一帧到收尾
//   tps       生成速度 = 输出 token / genMs，单位 token/s
// genMs 太短（< 50ms）时不报速度：除出来会是几百 tok/s 的假数字，
// 那是「测试题太短」而不是模型真的那么快。
function testTiming(completion, firstChunkMs, totalMs) {
  const usage = upstream.extractUsage(completion, false) || upstream.emptyUsage()
  const outputTokens = Number(usage.output) || 0
  const ttfbMs = Number.isFinite(firstChunkMs) ? firstChunkMs : totalMs
  const genMs = Math.max(0, totalMs - ttfbMs)
  const tps = genMs >= 50 && outputTokens > 0 ? Math.round((outputTokens / (genMs / 1000)) * 10) / 10 : null
  // latency 与 ttfbMs 同值：这是历史字段名，界面（含更早的客户端）一直读它，
  // 少给一个就会显示成 "-"。两个名字都给，谁读哪个都拿得到数
  return { latency: ttfbMs, ttfbMs, totalMs, genMs, outputTokens, tps }
}

// 渠道连通性测试（带一次抖动重试）：第二次仍失败就原样抛出，让界面看到真实原因。
// 调用方不用关心重试，重试与否只看错误是传输层抖动还是业务结论。
// signal：界面点「停止」时由调用方中止。测试请求要能真的断开在途上游调用 ——
// 只置一个「别再试下一个」的标志，卡住的请求仍会占着连接直到超时。
async function channelTestCompletion(model, signal, onFirstChunk) {
  try {
    return await channelTestAttempt(model, signal, onFirstChunk)
  } catch (err) {
    if (signal?.aborted) throw err // 用户按了停止：不重试
    if (!isTransientTestError(err)) throw err
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, TEST_TRANSIENT_RETRY_MS)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('测试已取消'), { code: 'ABORT_ERR' }))
      }, { once: true })
    })
    return channelTestAttempt(model, signal, onFirstChunk)
  }
}

// 一次尝试。WorkBuddy 的补全不走 worker（它的适配器只提供目录，
// 见 worker.mjs），所以这里必须分流 —— 否则测试面板对 WorkBuddy 永远报
// 「适配器未实现」，而真实请求其实是通的。
//
// 计时口径：返回 { completion, firstChunkMs }。firstChunkMs 是「首字节到达」的时刻，
// 界面上「响应时间」用它、「总耗时」用整次调用的耗时 —— 两个数分开才不会把
// 排队 + 思考的时间混进生成速度里。
async function channelTestAttempt(model, signal, onFirstChunk) {
  const bare = String(model || '').replace(/^[^/]+\//, '')
  const realm = channelWorkbuddyRealm(model)
  const startedAt = Date.now()
  // 只在第一次真正拿到内容时记一次，后续帧不覆盖
  let firstAt = 0
  const markFirst = () => {
    if (firstAt) return
    firstAt = Date.now()
    onFirstChunk?.(firstAt - startedAt)
  }

  if (realm) {
    if (!workbuddy.getRuntime()) throw new Error('WorkBuddy 运行时未初始化')
    let aggregated = null
    try {
      await workbuddy.forwardChat({
        // max_tokens 不能太小：带 reasoning 的模型会把几十个 token 全花在思考上，
        // 正文为空，测试就显示成「回复（空）」
        body: JSON.stringify({ model: bare, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 64 }),
        isStream: false,
        model: bare,
        realm,
        // WorkBuddy 的转发没有独立 signal，中止靠这个回调在换号/重试之间跳出
        isAborted: () => signal?.aborted === true,
        onDone: payload => { aggregated = payload }
      })
    } catch (err) {
      // 测试链路的错误原本只有 message（latency=1 的那种秒败，用户只看到一句
      // 「Cannot convert…」没法定位）—— 把堆栈打到服务日志，响应里仍给 message
      console.error('[channels-test] WorkBuddy forwardChat 抛错：', err?.stack || err)
      throw err
    }
    if (!aggregated) throw new Error('WorkBuddy 未返回有效响应')
    // 非流式聚合没有逐帧回调，首字节时间无从测量，按整次耗时回报
    markFirst()
    return { completion: aggregated, firstChunkMs: firstAt - startedAt }
  }

  const rt = channels.getRuntime()
  if (!rt) throw new Error('渠道运行时未初始化')
  const collector = channelSse.createCollector(model)
  await rt.complete({
    model,
    openAi: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 64, stream: false }
  }, chunk => {
    markFirst()
    collector.push(chunk)
  }, signal)
  return { completion: collector.completion(), firstChunkMs: firstAt ? firstAt - startedAt : Date.now() - startedAt }
}

// Channel 类型 Provider 的请求转发：十个免费账号渠道（LobsterAI / Qoder / TRAE /
// Cline / Loomy / Raccoon / MiniMax / ZCode / Gemini / Qoder CN）。
// 真正的协议适配、登录态、账号池、限流标记都在 worker 里的渠道包；这里只做
// 「协议收口 + 转帧 + 记账」。换号逻辑因此不在这里 —— 渠道包内部已经闭环，
// 在外面再重试一次会让同一个请求在两个账号上各花一次配额。
async function handleChannelRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic, clientIsResponses) {
  const rt = channels.getRuntime()
  if (!rt) throw Object.assign(new Error('渠道运行时未初始化'), { status: 503 })
  if (!rt.handles(entry.model.id)) {
    throw Object.assign(new Error(`渠道未提供模型 ${entry.model.id}`), { status: 404 })
  }

  const isStream = !!req.body?.stream
  // 渠道运行参数（面板「渠道设置」内页）：按渠道取，改一家不影响另一家
  const settingsService = channels.getSettings?.()
  const channelCfg = settingsService?.forProvider?.(entry.provider) || settingsService?.get?.() || {}
  const firstChunkTimeoutMs = Number(channelCfg.firstChunkTimeoutMs) || CHANNEL_FIRST_CHUNK_TIMEOUT_MS
  const heartbeatMs = Number(channelCfg.heartbeatMs) || 0
  const earlyHeadersMs = Number(channelCfg.earlyHeadersMs) || 0  // 三个协议入口在这里收敛成 OpenAI Chat 形态：渠道包的适配器只认这一种。
  // Anthropic 与 Responses 的回程再用 workbuddy 的转换器转回去，避免为渠道
  // 单独维护第二套协议实现。
  const openAi = clientIsAnthropic
    ? wbAnthropic.toOpenAI(req.body || {})
    : clientIsResponses
      ? wbResponses.toChat(req.body || {})
      : { ...(req.body || {}) }

  // 模型级推理档位：与 WorkBuddy 链路口径一致 —— 配置了就覆盖客户端原值，
  // 'off' 表示显式关掉思考（删字段），未配置则不干预客户端请求。
  // 渠道适配器读的就是 openAi.reasoning_effort（Qoder 的 wasm 会把它转给上游）。
  // 上面三个分支都返回新对象，改这里不会动到 req.body
  const modelEffort = entry.model.reasoningEffort || ''
  if (modelEffort === 'off') {
    delete openAi.reasoning_effort
    delete openAi.reasoningEffort
  } else if (modelEffort) {
    openAi.reasoning_effort = modelEffort
    delete openAi.reasoningEffort // 上游只认 snake_case，避免重复字段
  }

  // 客户端断开即取消上游：渠道包内部会释放该次请求占用的并发额度，
  // 不取消会让用户在界面里点了停止、上游却继续跑完。
  // clientClosed 要和「上游卡死」区分开：两者都会让这次调用以 AbortError 失败，
  // 但只有前者是用户的选择，不该计入模型的连续失败
  const controller = new AbortController()
  let clientClosed = false
  const onClose = () => {
    if (res.writableEnded) return
    clientClosed = true
    controller.abort()
  }
  res.on('close', onClose)

  const recordUsage = usage => {
    const stat = channelSse.toStatUsage(usage) || upstream.emptyUsage()
    tokenStats.recordTokens(entry.ref, stat)
    return stat
  }

  // 流式状态提到 try 之外：出错时得先知道「是否已经对客户端承诺过 200」，
  // 已经发出帧之后再抛错只会让外层在已发送的响应上再写一次 JSON 头（ERR_HTTP_HEADERS_SENT）
  let started = false
  let emitter = null
  let collector = null
  // 首帧看门狗：stalled 决定这次失败怎么记账 ——「等满上限还一个字都没有」
  // 是模型/上游的问题，不能用「用户取消」搪塞过去（那会让它永远不失活）
  let stallTimer = null
  let stalled = false
  // 有没有收到过任何字节：看门狗与上游「擦边」时用它纠正判据 ——
  // 计时器响的同时数据刚好到了，说明上游是活的，不能按卡死记账
  let gotChunk = false
  const clearStallTimer = () => {
    if (!stallTimer) return
    clearTimeout(stallTimer)
    stallTimer = null
  }
  const startSse = () => {
    if (started) return
    started = true
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    lastWriteAt = Date.now()
    startHeartbeat()
  }

  // 心跳与「早发头」：客户端等不到响应头就会自己超时（常见 60 秒），
  // 而思考型模型首字实测 40~70 秒。所以超过 earlyHeadersMs 还没有内容时，
  // 先把 200 与 SSE 头发出去，再用注释帧续命 —— 客户端看到的是「连接活着」。
  //
  // 为什么留 3 秒而不是立刻发：401/404/429 这类错误通常 1~2 秒内就有结论，
  // 早发头会把它们变成「200 + 错误帧」，客户端与兜底逻辑都读不到状态码。
  let lastWriteAt = Date.now()
  let heartbeatTimer = null
  const startHeartbeat = () => {
    if (heartbeatTimer || heartbeatMs <= 0) return
    heartbeatTimer = setInterval(() => {
      if (!started || res.writableEnded) return
      if (Date.now() - lastWriteAt < heartbeatMs) return
      try {
        res.write(': ping\n\n')
        lastWriteAt = Date.now()
      } catch {
        /* 下游已断开 */
      }
    }, Math.min(heartbeatMs, 5000))
    heartbeatTimer.unref?.()
  }
  const write = text => {
    if (!text) return
    lastWriteAt = Date.now()
    res.write(text)
  }
  let earlyTimer = null
  if (isStream && earlyHeadersMs > 0) {
    earlyTimer = setTimeout(() => {
      if (!started && !res.writableEnded) startSse()
    }, earlyHeadersMs)
    earlyTimer.unref?.()
  }
  // 已开始流式后失败：补错误帧 + [DONE] 收尾。不换源 —— 客户端已经收到
  // 这次回答的前缀，再换一家只会把两段不同内容拼在一起
  const failStream = message => {
    try {
      if (emitter) write(emitter.fail(message))
      else write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: 'channel_stream_error' } })}\n\n`)
      if (!emitter) write('data: [DONE]\n\n')
      res.end()
    } catch {
      /* 下游已断开 */
    }
  }

  // 首帧看门狗：流式与非流式共用一个判据 —— 上限内上游一个字节都没给，就是卡住了。
  // 收到第一段内容立刻撤掉：之后的长生成不算超时，那是模型在正常干活。
  // 中止理由走 abort reason：渠道包会把它原样抛出来，外层因此既知道「为什么失败」，
  // 也不会把它误判成用户取消（旧实现对 AbortError 一律当取消，坏模型永远不失活）。
  stallTimer = setTimeout(() => {
    stalled = true
    controller.abort(new Error(stallMessage(firstChunkTimeoutMs)))
  }, firstChunkTimeoutMs)
  if (stallTimer.unref) stallTimer.unref()

  try {
    if (isStream) {
      // Anthropic / Responses 客户端：把 OpenAI 帧喂给既有转换器；OpenAI 客户端直写
      emitter = clientIsAnthropic
        ? wbAnthropic.createStreamEmitter({ model: entry.ref })
        : clientIsResponses
          ? wbResponses.createStreamEmitter({ model: entry.ref })
          : null
      const writer = channelSse.createStreamWriter(entry.ref)
      collector = writer.collector

      await rt.complete({ model: entry.model.id, openAi }, chunk => {
        // 有字节就说明上游活着；哪怕这一帧还拼不出完整帧（frames 为空）也撤掉看门狗
        gotChunk = true
        clearStallTimer()
        const frames = writer.write(chunk)
        if (!frames) return
        startSse()
        if (emitter) {
          // 转换器按「一行 data 帧」消费，故拆开逐帧投喂
          for (const frame of frames.split('\n\n')) {
            if (!frame) continue
            const out = emitter.push(frame)
            if (out) write(out)
          }
        } else {
          write(frames)
        }
      }, controller.signal)
      clearStallTimer()

      if (collector.failed) throw Object.assign(new Error('渠道流未正常收尾'), { status: 502 })
      startSse()
      if (emitter) {
        const tail = emitter.end()
        if (tail) write(tail)
      } else {
        write(writer.end())
      }
      res.end()

      const usage = recordUsage(collector.usage)
      modelHealth.noteSuccess(entry.ref)
      logger.log({
        model: entry.ref,
        status: 200,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: upstream.usageTotalOrNull(usage),
        stream: true
      })
      return
    }

    // 非流式：聚合后一次返回
    collector = channelSse.createCollector(entry.ref)
    await rt.complete({ model: entry.model.id, openAi }, chunk => {
      // 同样按「有没有字节」判活：非流式不代表上游可以在首帧上限内一声不吭
      gotChunk = true
      clearStallTimer()
      collector.push(chunk)
    }, controller.signal)
    if (collector.failed) throw Object.assign(new Error('渠道生成未正常收尾'), { status: 502 })
    const completion = collector.completion()
    const usage = recordUsage(collector.usage)
    modelHealth.noteSuccess(entry.ref)
    logger.log({
      model: entry.ref,
      status: 200,
      responseTime: Date.now() - startTime,
      fallback: isFallback,
      fallbackFrom: isFallback ? primaryRef : undefined,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: upstream.usageTotalOrNull(usage)
    })
    res.json(clientIsAnthropic
      ? wbAnthropic.toMessage(completion, entry.ref)
      : clientIsResponses
        ? wbResponses.toResponse(completion, entry.ref)
        : completion)
  } catch (err) {
    // 已经发出 200 与部分帧：收尾并结束，不把错误交给外层（外层会再写一次
    // 响应头，在已发送的响应上必然抛 ERR_HTTP_HEADERS_SENT）
    if (started) {
      failStream(err.message)
      const stat = channelSse.toStatUsage(collector?.usage) || upstream.emptyUsage()
      if (collector?.usage) tokenStats.recordTokens(entry.ref, stat)
      logFailure({
        model: entry.ref,
        status: 502,
        error: err.message,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined,
        inputTokens: stat.input,
        outputTokens: stat.output,
        totalTokens: upstream.usageTotalOrNull(stat),
        // 用户在生成中途点了停止：收尾归收尾，不该记成模型的连续失败
        clientCancelled: clientClosed,
        stream: true
      })
      return
    }
    // 没发出任何帧就失败：交给 failure-class 判定归属（上游卡死 / 用户取消 / 真报错）。
    // 归属决定两件事 —— 回给客户端的状态码，以及这次算不算模型的一次连续失败
    const verdict = classifyChannelFailure({
      started: false,
      // 看门狗响了但期间其实收到过字节（擦边竞态）：上游是活的，不按卡死记账
      stalled: stalled && !gotChunk,
      clientClosed,
      elapsedMs: Date.now() - startTime,
      // 超时上限来自渠道设置：判定文案与阈值必须和看门狗同一个数，
      // 否则「卡住」的提示会说成另一个秒数
      timeoutMs: firstChunkTimeoutMs,
      error: err
    })
    throw Object.assign(verdict.message ? new Error(verdict.message) : err, {
      status: verdict.status,
      ...(verdict.kind ? { kind: verdict.kind } : {}),
      ...(verdict.clientCancelled ? { clientCancelled: true } : {})
    })
  } finally {
    clearStallTimer()
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (earlyTimer) clearTimeout(earlyTimer)
    res.removeListener('close', onClose)
  }
}

// WorkBuddy 的请求转发：账号池化 + 换号重试 + SSE 重建（由 runtime 内部闭环）
//
// realmOverride：渠道化之后区域由模型 id 前缀决定（workbuddy/ vs workbuddy-global/），
// 不再来自 Provider 配置；旧路径（type: workbuddy 的源）仍然传空、按 Provider 取。
async function handleWorkbuddyRequest(entry, req, res, startTime, isFallback, primaryRef, clientIsAnthropic, clientIsResponses, realmOverride) {
  const rt = workbuddy.getRuntime()
  if (!rt) {
    throw new Error('WorkBuddy 运行时未初始化')
  }

  const isStream = !!req.body?.stream
  const clientIP = iputil.extractClientIP(req)
  // WorkBuddy 源的推理档位走每个模型独立配置（不回落全局档位；未配置则不干预）
  const modelEffort = entry.model.reasoningEffort || ''
  // 区域：据此刻隔离选号与出站域名，保证「国内版」的请求绝不会落到国际版
  // 账号上，反之亦然
  const realm = realmOverride || models.providerRegion(entry.provider)
  // 上游模型 id：渠道化之后 entry.model.id 带区域前缀（workbuddy/<m>），
  // 上游只认裸 id。entry.ref（channels/workbuddy/<m>）仍用于日志与记账。
  const modelId = String(entry.model.id || '')
  const upstreamModel = channelWorkbuddyRealm(modelId) ? modelId.slice(modelId.indexOf('/') + 1) : modelId

  // Anthropic 客户端（/v1/messages）与 Responses 客户端（/v1/responses）：
  // 请求体先转 OpenAI Chat 形态，再进改写/上游管线
  const fwdBody = JSON.stringify(
    clientIsAnthropic
      ? wbAnthropic.toOpenAI(req.body || {})
      : clientIsResponses
        ? wbResponses.toChat(req.body || {})
        : (req.body || {})
  )

  // 任务级日志上下文（用客户端原始请求体，保持日志口径不变）
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

    // Anthropic / Responses 客户端：重建帧先喂用量提取器，再经协议转换写出；OpenAI 客户端原样写出
    const emitter = clientIsAnthropic
      ? wbAnthropic.createStreamEmitter({ model: entry.ref })
      : clientIsResponses
        ? wbResponses.createStreamEmitter({ model: entry.ref })
        : null

    const streamUsage = upstream.emptyUsage()
    const usageExtractor = upstream.createStreamUsageExtractor(false)

    let fwd = null
    try {
      fwd = await workbuddy.forwardChat({
        body: fwdBody,
        isStream: true,
        clientIP,
        model: upstreamModel,
        reasoningEffort: modelEffort,
        // 区域：限定只从该区域的账号里选号（国内源不碰国际账号，反之亦然）
        realm,
        // 客户端断开时立即停止换号轮转/退避等待
        isAborted: () => clientGone(req, res),
        // Anthropic / Responses 通道的发射器丢弃 reasoning_content：思考帧对该客户端不可见，
        // 传输层据此判定「空回答重试」是否安全（不能让客户端收到两份输出）
        reasoningHidden: clientIsAnthropic || clientIsResponses,
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
      // 已对客户端输出过内容：不换源，但必须留一条失败日志 —— 否则「流式中途失败」
      // 的请求在日志与用量里整条消失（渠道链路同位置有 logFailure）
      logFailure({
        ...wbBaseLog,
        model: entry.ref,
        status: err.status || 502,
        error: err.message,
        detail: err.body || undefined,
        kind: err.kind || undefined,
        code: err.code || undefined,
        gatewayHint: err.gatewayHint || undefined,
        responseTime: Date.now() - startTime,
        fallback: isFallback,
        fallbackFrom: isFallback ? primaryRef : undefined,
        taskKey: err.taskKey || wbBaseLog.taskKey,
        input: err.input || wbBaseLog.input,
        stream: true
      })
      return
    }

    startSse()
    upstream.mergeStreamUsage(streamUsage, usageExtractor.end())
    if (emitter) {
      const out = emitter.end()
      if (out) res.write(out)
    }
    tokenStats.recordTokens(entry.ref, streamUsage)
    modelHealth.noteSuccess(entry.ref, fwd?.credits)
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
      totalTokens: upstream.usageTotalOrNull(streamUsage),
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
    model: upstreamModel,
    reasoningEffort: modelEffort,
    // 区域：限定只从该区域的账号里选号
    realm,
    isAborted: () => clientGone(req, res),
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
  modelHealth.noteSuccess(entry.ref, fwd?.credits)
  logger.log({
    ...wbBaseLog,
    model: entry.ref,
    status: 200,
    responseTime: Date.now() - startTime,
    fallback: isFallback,
    fallbackFrom: isFallback ? primaryRef : undefined,
    uid: fwd?.uid,
    ttfbMs: fwd?.ttfbMs,
    // 积分消耗：仅在上游真实提供时为数值（0 是有效值"免费"，与未提供区分）
    credits: typeof fwd?.credits === 'number' ? fwd.credits : undefined,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: upstream.usageTotalOrNull(usage)
  })
  // Anthropic / Responses 客户端：聚合结果转对应协议形态后返回
  const finalBody = clientIsAnthropic
    ? wbAnthropic.toMessage(aggregated, entry.ref)
    : clientIsResponses
      ? wbResponses.toResponse(aggregated, entry.ref)
      : aggregated
  res.json(finalBody)
}

app.post('/v1/messages', handleRequest)
app.post('/v1/chat/completions', handleRequest)
app.post('/v1/responses', handleRequest)

// 思考档位兜底：渠道目录一个档位都没探测到时，给一组通用值
// （与「模型来源」弹窗里给的那四档保持一致，客户端与面板看到的是同一套）
const FALLBACK_EFFORTS = ['low', 'high', 'max', 'xhigh']

// 当前目录里各模型探测到的思考档位并集。
// /v1/models 只播报 auto 一个伪模型，档位只能声明在它身上 —— 客户端据此渲染
// 档位选择器；具体档位在派发时仍按目标模型降级（payload 的 S11）。
function declaredEfforts() {
  const rows = channels.getRuntime()?.publicModelRows() || []
  const union = autoStrategy.unionEfforts(rows.map(row => row.reasoning?.efforts))
  return union.length ? union : FALLBACK_EFFORTS.slice()
}

// 只播报 auto 伪模型：真实模型与别名都不再暴露给客户端。
// 客户端只需填 `auto`，具体挑哪个模型由服务端按当前策略（见 auto-strategy.js）决定——
// 这样一来客户端配置里不会写死具体模型，切换策略/模型无需改客户端。
// 同时避免某些客户端把列表第一项当默认值而选中某个真实模型。
app.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: autoStrategy.listAutoModels(declaredEfforts()) })
})

// 各模型探测到的思考档位（供「模型来源」弹窗渲染档位下拉）。
// 键与渠道目录的模型 id 一致（`<渠道>/<模型>`），channels 源里的模型 id 正是这个形状。
// 读的是已采集的目录，不在这里触发上游拉取：弹窗打开不该等一次网络往返。
app.get('/api/model-efforts', (req, res) => {
  const rows = channels.getRuntime()?.publicModelRows() || []
  const efforts = {}
  for (const row of rows) {
    if (!row?.id || !Array.isArray(row.reasoning?.efforts) || row.reasoning.efforts.length === 0) continue
    efforts[row.id] = row.reasoning.efforts.slice()
  }
  res.json({ efforts, fallback: FALLBACK_EFFORTS.slice() })
})

// ==================== Anthropic token 计数（Claude Code 预估用）====================

// POST /v1/messages/count_tokens：WorkBuddy 通道发极小 max_tokens 的请求取上游真实 usage；
// 通用 Provider 配了 Anthropic 端点则原样转发 count_tokens；都不可用时本地粗估，保证 Claude Code 不 404
app.post('/v1/messages/count_tokens', async (req, res) => {
  const body = req.body || {}
  const { chain } = buildProviderChain(getConfig(), getState(), getFallback(), body)

  // WorkBuddy：真实计数（Anthropic 请求先转 OpenAI 形态；极小输出预算，空回答属预期不重试）
  // 渠道化之后它也是 channel 源，区域与上游模型 id 都要从模型 id 前缀还原
  for (const entry of chain) {
    const isChannel = models.isChannelProvider(entry.provider)
    const realm = isChannel
      ? channelWorkbuddyRealm(entry.model.id)
      : (models.isWorkbuddyProvider(entry.provider) ? models.providerRegion(entry.provider) : '')
    if (!realm) continue
    if (!workbuddy.getRuntime()) break
    try {
      const chatBody = {
        ...wbAnthropic.toOpenAI(body),
        stream: true,
        stream_options: { include_usage: true },
        // 输出预算取 8 而非 1：实测上游对 max_tokens=1 会先让思考帧占满预算、
        // 最终无正文（finish_reason=length），网关据空回答判失败并换号重试至耗尽，
        // 客户端拿到 500。8 是实测可用下限，仍远小于任何真实回答，不影响计数语义
        max_tokens: 8
      }
      let aggregated = null
      await workbuddy.forwardChat({
        body: JSON.stringify(chatBody),
        isStream: false,
        model: isChannel ? String(entry.model.id).replace(/^[^/]+\//, '') : entry.model.id,
        reasoningEffort: entry.model.reasoningEffort || '',
        // 区域：与该源账号池一致
        realm,
        noEmptyRetry: true,
        isAborted: () => clientGone(req, res),
        onDone: payload => {
          aggregated = payload
        }
      })
      const usage = upstream.extractUsage(aggregated, false) || upstream.emptyUsage()
      // input_tokens 口径与 Anthropic 一致：未缓存输入 + 缓存读 + 缓存写
      return res.json({ input_tokens: usage.input + usage.cacheRead + usage.cacheWrite })
    } catch {
      break // 计数失败不阻断客户端，降级到转发/估算
    }
  }

  // Channel 通道（渠道包里的另外十家）：同样走真实计数
  for (const entry of chain) {
    if (!models.isChannelProvider(entry.provider)) continue
    // WorkBuddy 已在上面处理过（它的适配器只提供目录，不进 worker 补全）
    if (channelWorkbuddyRealm(entry.model.id)) continue
    const rt = channels.getRuntime()
    if (!rt) continue
    try {
      const collector = channelSse.createCollector(entry.model.id)
      await rt.complete({
        model: entry.model.id,
        openAi: { ...wbAnthropic.toOpenAI(body), max_tokens: 8, stream: false }
      }, chunk => collector.push(chunk))
      const usage = collector.usage
      if (!usage) continue
      // Anthropic 的 input_tokens = 未缓存 + 缓存读 + 缓存写 = OpenAI 的 prompt_tokens
      return res.json({ input_tokens: usage.prompt_tokens })
    } catch {
      continue // 计数失败不阻断客户端，降级到转发/估算
    }
  }

  // 通用 Provider：Anthropic 端点原样转发（对方原生支持 count_tokens 时结果最准）
  for (const entry of chain) {
    const provider = entry.provider
    if (models.isPooledProvider(provider)) continue
    if (!provider.apiKey || !provider.baseURL) continue
    try {
      const base = String(provider.baseURL).replace(/\/+$/, '')
      const resp = await axios.post(`${base}/v1/messages/count_tokens`, body, {
        headers: upstream.resolveHeaders(provider, true),
        timeout: 15000,
        validateStatus: () => true
      })
      if (resp.status === 200 && resp.data && typeof resp.data.input_tokens === 'number') {
        return res.json({ input_tokens: resp.data.input_tokens })
      }
    } catch {
      /* 转发失败降级到估算 */
    }
  }

  // 兜底：本地粗估（Claude Code 仅用于上下文进度显示，估算可用）
  res.json({ input_tokens: estimateTokens(body) })
})

// 本地粗估 token 数（无真实计数通道时的兜底）：按文字种类分别估算——
// CJK 字符按 1 字 ≈ 1 token（宁可高估留余量），其余字符按 4 字符 ≈ 1 token
function estimateTokens(body) {
  let text = ''
  try {
    text = JSON.stringify(body || {})
  } catch {
    return 1
  }
  // CJK 区间：CJK 标点/假名（\u3000-\u30ff）、扩展 A（\u3400-\u4dbf）、
  // 基本汉字（\u4e00-\u9fff）、兼容汉字（\uf900-\ufaff）、全角形式（\uff00-\uffef）
  const cjk = (text.match(/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length
  const rest = text.length - cjk
  return Math.max(1, Math.ceil(cjk + rest / 4))
}

app.get('/api/state', (req, res) => {
  res.json(getState())
})

app.post('/api/state', (req, res) => {
  const { current } = req.body || {}
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

// ==================== 模型失活 ====================
//
// 失活由两处写入：转发路径的连续失败（model-health.noteFailure），以及定时审计
// （余额不足一次请求 / 渠道没有可用账号）。界面只读 + 手动恢复。
// 恢复只清标记：配置、路由规则、兜底里的引用都没动过，恢复后立即重新参与路由。

// 台账记录 + 配置里解析出的 modelId（界面按「渠道 id + 模型 id」分组匹配）。
// 让前端自己拼 ref 会在用户改过源名时对不上。
function healthListView() {
  const config = getConfig()
  return modelHealth.list().map(item => {
    const resolved = resolveRef(config, item.ref)
    if (!resolved) return item
    return { ...item, modelId: resolved.modelId, providerType: resolved.provider.type || '' }
  })
}

app.get('/api/model-health', (req, res) => {
  res.json({
    ok: true,
    models: healthListView(),
    auditIntervalMs: modelHealthAudit.AUDIT_INTERVAL_MS,
    offlineAfterFailures: modelHealth.OFFLINE_AFTER_FAILURES
  })
})

// 手动触发一轮审计：刚充完值/刚启用账号时，不必等下一轮定时器
app.post('/api/model-health/audit', async (req, res) => {
  const result = await modelHealthAudit.audit()
  res.json({ ...result, models: healthListView() })
})

app.post('/api/model-health/revive', (req, res) => {
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : ''
  if (!ref) return res.status(400).json({ error: '缺少模型引用' })
  if (!resolveRef(getConfig(), ref)) return res.status(404).json({ error: `模型不存在: ${ref}` })
  modelHealth.revive(ref)
  res.json({ ok: true, ref, state: modelHealth.stateOf(ref) })
})

// 账号被上游禁用的原因（AiRoute 侧补记的）：渠道包的 account.update 只有
// enabled，没有地方存「为什么停用」，所以界面上的标签文案从这里取。
app.get('/api/account-health', (req, res) => {
  res.json({ ok: true, accounts: accountHealth.list() })
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
//   不传 savePath：一键升级，下载到托管目录并做 SHA-256 校验（供主进程替换安装）
//   传 savePath  ：手动下载，另存为到用户指定路径（Windows / 自动替换失败时的兜底）
app.post('/api/update/download', (req, res) => {
  const { tag, savePath } = req.body || {}
  if (!tag) return res.status(400).json({ error: '缺少版本号' })
  try {
    res.json(savePath ? update.startDownload(tag, savePath) : update.startInstall(tag))
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
  // WorkBuddy 不再是独立的源类型：它已经是渠道包里的第 11 家，
  // 由 server/channels 的目录同步维护（见 migrateWorkbuddyProviders）
  if (update.type === 'workbuddy') {
    return res.status(400).json({ error: 'WorkBuddy 已并入「账号渠道」，不再单独建源' })
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

// 用 URL + Key 探测上游模型清单：新增 Provider 时表单尚未落盘，所以不依赖已存在的配置。
// 必须注册在 /api/providers/:name 之前——否则会被 :name 路由当成名为 fetch-models 的 Provider 吞掉
app.post('/api/providers/fetch-models', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  try {
    const result = await providerModels.fetchModels({
      baseURL: typeof body.baseURL === 'string' ? body.baseURL : '',
      openaiURL: typeof body.openaiURL === 'string' ? body.openaiURL : '',
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : ''
    })
    // 探测失败属于「用户输入/上游」问题，用 400 便于前端区分本地服务异常
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch {
    // 不记录 apiKey：这里是唯一会接触明文密钥的非配置路径
    res.status(500).json({ ok: false, error: '探测模型列表失败，请检查本地服务日志' })
  }
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
  const input = sanitizeProviderInput(req.body)
  // WorkBuddy 已并入渠道包：新建源只允许「账号渠道」这一种池化形态
  if (input.type === 'workbuddy') {
    return res.status(400).json({ error: 'WorkBuddy 已并入「账号渠道」，不再单独建源' })
  }
  config[name] = input
  saveConfig(config)
  res.json({ ok: true })
})

// 单个 provider 里单个模型的一次连通性测试。三条链路（渠道包 / WorkBuddy / 通用端点）
// 各自协议不同，但**返回口径必须一致**：{ ok, latency, ttfbMs, totalMs, genMs, tps, ... }，
// 否则「测试全部模型」那张表得按来源各写一套列。
// 单个 provider 里单个模型的一次连通性测试。三条链路（渠道包 / WorkBuddy / 通用端点）
// 各自协议不同，但**返回口径必须一致**，否则「测试全部」那张表得按来源各写一套列：
//   ok        是否连通
//   ttfbMs    首字节耗时（用户感知的响应时间）；失败时 = 整次尝试的耗时
//   totalMs   整次调用耗时；失败时与 ttfbMs 相同
//   genMs/tps 纯生成耗时与速度；拿不到逐帧数据时为 0 / null
// 失败分支也必须带全这几个字段 —— 少一个，界面上那句「连接失败 · -」就会露出来。
function failedTestResult(startedAt, error) {
  const totalMs = Date.now() - startedAt
  return { ok: false, error, latency: totalMs, ttfbMs: totalMs, totalMs, genMs: 0, tps: null }
}

async function runProviderTest(provider, name, item, signal) {
  const ref = `${name}/${item.id}`
  const startedAt = Date.now()
  let firstChunkMs = NaN
  const onFirstChunk = ms => { firstChunkMs = ms }

  // Channel 类型：交给渠道包的适配器发一次真实短对话（换号与限流在包内闭环）
  if (models.isChannelProvider(provider)) {
    // 已失活模型不测：用户以为测试会重新路由到它，恢复后才有意义
    if (modelHealth.isOffline(ref)) {
      return failedTestResult(startedAt, '该模型已失活，请先恢复再测')
    }
    try {
      const attempt = await channelTestCompletion(item.id, signal, onFirstChunk)
      const message = attempt.completion.choices?.[0]?.message || {}
      modelHealth.noteSuccess(ref)
      const timing = testTiming(attempt.completion, firstChunkMs, Date.now() - startedAt)
      const usage = upstream.extractUsage(attempt.completion, false) || upstream.emptyUsage()
      return {
        ok: true,
        ...timing,
        latency: timing.ttfbMs,
        reply: (message.content || message.reasoning_content || '').slice(0, 80),
        finish: attempt.completion.choices?.[0]?.finish_reason,
        // 用量统一给全：结果里那句「本次用量 N tokens」读的就是 totalTokens
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: upstream.usageTotalOrNull(usage) ?? timing.outputTokens ?? 0
      }
    } catch (err) {
      if (signal.aborted) throw err
      return failedTestResult(startedAt, err.message)
    }
  }

  // WorkBuddy 类型：通过账号池发一次真实短对话验证连通性
  if (models.isWorkbuddyProvider(provider)) {
    try {
      let aggregated = null
      await workbuddy.forwardChat({
        // 限制输出长度以加快连通性测试（上游仍强制流式，此处由本地聚合为单响应）
        body: JSON.stringify({ model: item.id, messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 32 }),
        isStream: false,
        model: item.id,
        // 按该源区域测试：国内源不能用国际账号验证（反之亦然）
        realm: models.providerRegion(provider),
        isAborted: () => signal.aborted,
        onDone: payload => {
          aggregated = payload
        }
      })
      if (!aggregated) {
        return failedTestResult(startedAt, '账号池未返回有效响应')
      }
      modelHealth.noteSuccess(ref)
      // 非流式聚合拿不到逐帧时刻：首字节时间按整次耗时回报，速度不虚报
      const timing = testTiming(aggregated, Date.now() - startedAt, Date.now() - startedAt)
      const usage = upstream.extractUsage(aggregated, false) || upstream.emptyUsage()
      return {
        ok: true,
        ...timing,
        latency: timing.ttfbMs,
        status: 200,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: upstream.usageTotalOrNull(usage)
      }
    } catch (err) {
      if (signal.aborted) throw err
      return failedTestResult(startedAt, err.message)
    }
  }

  // 通用 Provider：优先测 Anthropic 端点，没有则测 OpenAI
  const testAnthropic = !!provider.baseURL
  const maxTokens = item.maxOutput ? Math.min(32, item.maxOutput) : 32
  const testBody = {
    model: item.id,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: 'hi' }]
  }
  try {
    const url = upstream.resolveEndpoint(provider, testAnthropic)
    if (!url) {
      return failedTestResult(startedAt, '未配置可用的端点 URL')
    }
    const headers = upstream.resolveHeaders(provider, testAnthropic)
    const response = await axios.post(url, testBody, { headers, timeout: 30000, signal })
    modelHealth.noteSuccess(ref)
    const totalMs = Date.now() - startedAt
    const usage = upstream.extractUsage(response.data, testAnthropic) || upstream.emptyUsage()
    // 连通性测试不写入正式用量统计，避免污染数据。
    // 非流式请求没有首字节时刻，速度按整次耗时算（不分帧，宁可保守）
    return {
      ok: true,
      latency: totalMs,
      ttfbMs: totalMs,
      totalMs,
      genMs: 0,
      tps: null,
      status: response.status,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: upstream.usageTotalOrNull(usage)
    }
  } catch (err) {
    if (signal.aborted) throw err
    const status = err.response?.status || 0
    const message = err.response?.data?.error?.message || err.message || '连接失败'
    return { ...failedTestResult(startedAt, message), status }
  }
}

app.post('/api/providers/:name/test', async (req, res) => {
  const config = getConfig()
  const { name } = req.params
  const raw = config[name]
  if (!raw) {
    return res.status(404).json({ error: `Provider ${name} not found` })
  }

  const provider = toProviderView(raw)
  if (!provider.apiKey && !models.isPooledProvider(provider)) {
    return res.json({ ok: false, error: 'API Key 未配置', latency: 0 })
  }
  if (!provider.models.length) {
    return res.json({ ok: false, error: '未配置模型', latency: 0 })
  }

  const requestedId = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const model = (requestedId && provider.models.find(m => m.id === requestedId)) || provider.models[0]
  // all=true：一次请求测这个源的**全部**模型，每个模型回一条带响应时间的结果。
  //
  // 面板上的「测试全部」走的是**前端逐个发单模型请求**，没走这里 —— 因为同一账号
  // 连着打几个模型会被上游限流（表现为「服务端一口气跑全失败、单个测却成功」），
  // 前端逐个发才能在模型之间插入间隔与限流退避。
  // 这个分支保留给脚本 / 第三方客户端：一次调用拿到整源结果，它们不必自己写循环。
  const testAll = req.body?.all === true && !requestedId

  // 「停止」：前端 abort 请求 → res 关闭 → 中止在途上游调用。
  // 不主动 removeListener：res 是一次性的，注册完随请求一起回收。
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })

  // 全量模式：一个源一个 HTTP 请求，边测边把已有结果刷回去太复杂，
  // 这里一次跑完统一返回 —— 但每个模型都带自己的耗时，界面上逐条显示
  if (testAll) {
    const results = []
    for (const item of provider.models) {
      if (controller.signal.aborted) break
      const single = await runProviderTest(provider, name, item, controller.signal)
      results.push({ model: item.id, ...single })
    }
    const passed = results.filter(r => r.ok).length
    return res.json({
      ok: passed > 0,
      all: true,
      total: results.length,
      passed,
      failed: results.length - passed,
      results,
      // 兼容单模型口径的字段：整组的「响应时间」取第一个成功模型的，全部失败取最后一条
      latency: (results.find(r => r.ok) || results[results.length - 1] || {}).latency || 0,
      model: (results.find(r => r.ok) || results[results.length - 1] || {}).model || ''
    })
  }

  // 单模型模式：请求点名了某个模型，或该源只有一个模型
  const target = provider.models.find(m => m.id === model.id) || provider.models[0]
  try {
    const single = await runProviderTest(provider, name, target, controller.signal)
    return res.json({ model: target.id, ...single })
  } catch (err) {
    // 只有「用户点了停止」会抛到这里：响应已收尾，不再写
    if (controller.signal.aborted) return
    res.json({ model: target.id, ...failedTestResult(Date.now(), err.message) })
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

// 发起 OAuth 设备授权（body.realm：cn（默认）/ global —— 决定用哪套域名与头族登录）
app.post('/api/workbuddy/oauth/start', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const result = await workbuddy.oauthStart(models.normalizeRegion(req.body?.realm))
    res.json({ ok: true, state: result.state, url: result.url, realm: result.realm })
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
      // 指定任务码：按 uids（为空则全部非禁用账号）入队。
      // 走 workbuddy.enqueue：它内部对国际版账号直接拒绝（无成长体系），
      // 批量路径同样受控（与 enqueue 的单账号行为一致）
      const targets = uids.length ? uids : workbuddy.listAccounts().filter(a => !a.disabled).map(a => a.uid)
      let enqueued = 0
      let skipped = 0
      for (const uid of targets) {
        const r = workbuddy.enqueue(uid, taskCodes)
        if (r && r.ok === false) skipped++
        else enqueued += (r && r.enqueued) || 0
      }
      result = enqueued
        ? { ok: true, started: true, total: enqueued, enqueued, skipped }
        : {
            ok: true,
            started: false,
            total: 0,
            skipped,
            message: skipped > 0 ? `没有可入队的任务（已跳过 ${skipped} 个不适用账号）` : '没有可入队的任务'
          }
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

// 积分变动流水（新的在前；limit 默认 50 上限 1000，uid 可选精确过滤，offset 翻页）
app.get('/api/workbuddy/credit-history', (req, res) => {
  if (!requireWorkbuddy(res)) return
  res.json({ ok: true, ...workbuddy.creditHistory(req.query.limit, req.query.uid, req.query.offset) })
})

// 立即落盘用量数据（面板「刷新」或关闭前调用）
app.post('/api/workbuddy/usage/save', (req, res) => {
  if (!requireWorkbuddy(res)) return
  workbuddy.usageSave()
  res.json({ ok: true })
})

// 账号池统一维护的启用模型清单（附后台拉取到的思考档位，供 Provider 弹窗渲染下拉）
// 上游模型缓存为空时先拉一次（1h 缓存；无可用账号/拉取失败静默降级到静态兜底档位）
// region 查询参数：cn（默认）/ global，两地模型清单不同，按区域返回
app.get('/api/workbuddy/models/enabled', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const region = models.normalizeRegion(req.query.region)
  try {
    await workbuddy.listUpstreamModels(false, region)
  } catch {
    /* 拉取失败：档位回落静态兜底表 */
  }
  res.json({ ok: true, region, models: workbuddy.getEnabledModelsWithEfforts(region) })
})

// 保存启用模型清单。WorkBuddy 的模型现在挂在渠道源里（id 形如 workbuddy/<m>），
// 所以清单变了要重刷一次渠道目录，否则界面与 /v1/models 会停在旧结果上。
app.post('/api/workbuddy/models/enabled', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const region = models.normalizeRegion(req.body?.region)
  const incoming = Array.isArray(req.body?.models) ? req.body.models : []

  // 跨区域防呆：拒绝「明确只属于另一区域」的模型 id。
  // 国内版与国际版清单完全不同，误写会让整个源的模型引用失效（曾真实发生）
  const check = workbuddy.validateModelsForRegion(region, incoming)
  if (!check.ok) {
    const label = region === 'global' ? '国际版' : '国内版'
    return res.status(400).json({
      error:
        `以下模型不属于${label}目录，拒绝写入：${check.rejected.join('、')}。` +
        `请在「模型和档位」页签切换到正确区域后再保存。`,
      rejected: check.rejected
    })
  }

  const list = workbuddy.setEnabledModels(incoming, region)

  // 持久化到 server-config.json（按区域分键；旧键 enabledModels 保留为国内版，兼容历史）
  const serverConfig = engine.getServerConfig()
  serverConfig.workbuddy = serverConfig.workbuddy || {}
  if (region === 'global') {
    serverConfig.workbuddy.enabledModelsGlobal = list
  } else {
    serverConfig.workbuddy.enabledModels = list
  }
  engine.saveServerConfig(serverConfig)

  // 同步到渠道源：引用体系（provider/modelId）依赖 channels 的 models 字段。
  // 只刷新目录，不重建配置 —— 模型级设置（上下文/输出上限、推理档位）由
  // syncChannelProvider 按模型 id 合并保留。
  let synced = false
  try {
    await syncChannelProviderFromRuntime()
    synced = true
  } catch (err) {
    console.error('[aiRoute] 渠道目录刷新失败:', err.message)
  }

  res.json({ ok: true, region, models: list, synced })
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

// 上游模型列表（refresh=1 强制刷新缓存；region=cn/global 按区域拉取）
// 必须带 region：国内版与国际版的模型清单完全不同，不带区域会按「任意可用账号」取，
// 拿到哪个区域的清单取决于账号顺序——曾因此把国际版模型写进国内版槽位
app.get('/api/workbuddy/models', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  const region = models.normalizeRegion(req.query.region)
  try {
    const list = await workbuddy.listUpstreamModels(req.query.refresh === '1', region)
    res.json({ ok: true, region, models: list })
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

// 手动触发单类定时任务（checkin / travel / activity / keepalive / blackcat /
// growth / balance / taskSweep）
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

// 官方补偿活动状态（只读，不领取）
// 取数与呈现分离：补偿状态没有 overview 快照可吃，挂进轮询就是定期轰炸上游，
// 故仅供进页面与手动点击时取一次，倒计时靠前端本地重渲染。
app.get('/api/workbuddy/compensation', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const rows = await workbuddy.compensationStatusAll()
    res.json({ ok: true, rows })
  } catch (err) {
    // 全量查询失败必须显形：不能返回空数组让前端说「当前没有待领补偿」
    res.status(500).json({ ok: false, error: err.message || '补偿状态查询失败', rows: [] })
  }
})

// 逐号领取补偿（先查状态 → 待领才领）。
// 返回 summary 里 errored 与 claimed 分开计：上游全挂时每个账号都走 error 分支，
// 只看 claimed 会把「全部查询失败」说成「当前没有待领补偿」——比不说更糟。
app.post('/api/workbuddy/compensation/claim_all', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const result = await workbuddy.compensationClaimAll()
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '补偿领取失败' })
  }
})

// 单号领取补偿
app.post('/api/workbuddy/accounts/:uid/compensation', async (req, res) => {
  if (!requireWorkbuddy(res)) return
  try {
    const result = await workbuddy.compensationClaimFor(req.params.uid)
    if (result && result.error === 'account not found') {
      return res.status(404).json({ ok: false, error: '账号不存在' })
    }
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '补偿领取失败' })
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

// ==================== 客户端版本号自动检查 ====================
//
// 出站 UA 里的版本号过时会被上游判为可疑（实测：国际版平台段送错触发 403 code 11140）。
// 这里从官方公开来源取最新版本号，供界面一键对照与更新。
// 来源已实测：/v2/update（桌面端，按区域不同）+ npm registry（CLI）+ 官方 changelog（IDE）。

// 版本检查器单例：缓存落盘在数据目录（6 小时 TTL）
let versionChecker = null
function getVersionChecker() {
  if (!versionChecker) {
    versionChecker = wbVersionCheck.createVersionChecker({ dataDir: paths.getDataDir() })
  }
  return versionChecker
}

// 当前生效的版本号（identity 覆盖 > 官方默认）
function currentVersions() {
  const wb = engine.getServerConfig().workbuddy || {}
  return getVersionChecker().currentOf(wb.identity || {})
}

// 组装「当前 vs 最新」对照结果
function versionReport(doc) {
  const current = currentVersions()
  const latest = (doc && doc.latest) || {}
  const fields = []
  for (const [key, label] of [
    ['clientVersion', 'WorkBuddy 主链路版本'],
    ['desktopVersion', '桌面事件链版本'],
    ['cliVersion', 'CLI 版本段'],
    ['ideVersion', 'CodeBuddy IDE 版本']
  ]) {
    const cur = current[key] || ''
    const lat = latest[key] || ''
    fields.push({
      key,
      label,
      current: cur,
      latest: lat,
      hasUpdate: !!lat && wbVersionCheck.compareVersion(lat, cur) > 0
    })
  }
  return {
    ok: true,
    fetchedAt: (doc && doc.fetchedAt) || 0,
    fromCache: !!(doc && doc.fromCache),
    fields,
    desktopByRegion: (doc && doc.desktopByRegion) || {},
    sources: (doc && doc.sources) || {},
    errors: (doc && doc.errors) || []
  }
}

// 读取版本对照（默认走缓存，超过 6 小时自动刷新）
app.get('/api/workbuddy/versions', async (req, res) => {
  try {
    const doc = await getVersionChecker().check(currentVersions(), req.query.refresh === '1')
    res.json(versionReport(doc))
  } catch (err) {
    res.status(502).json({ error: '检查版本号失败: ' + (err.message || '网络不可用') })
  }
})

// 强制刷新版本号（界面上「重新检查」按钮）
app.post('/api/workbuddy/versions/refresh', async (req, res) => {
  try {
    const doc = await getVersionChecker().check(currentVersions(), true)
    res.json(versionReport(doc))
  } catch (err) {
    res.status(502).json({ error: '检查版本号失败: ' + (err.message || '网络不可用') })
  }
})

// 应用最新版本号：写入 server-config.json 的 workbuddy.identity（热生效）
// body.fields 可选：只应用指定字段（缺省应用全部有更新的字段）
app.post('/api/workbuddy/versions/apply', async (req, res) => {
  try {
    const doc = await getVersionChecker().check(currentVersions(), false)
    const latest = doc.latest || {}
    const only = Array.isArray(req.body?.fields) && req.body.fields.length ? new Set(req.body.fields) : null

    const serverConfig = engine.getServerConfig()
    serverConfig.workbuddy = serverConfig.workbuddy || {}
    const identity = { ...(serverConfig.workbuddy.identity || {}) }
    const prevVersions = {}
    for (const key of ['clientVersion', 'desktopVersion', 'cliVersion', 'ideVersion']) {
      prevVersions[key] = identity[key] || currentVersions()[key] || ''
    }

    const applied = []
    for (const key of ['clientVersion', 'desktopVersion', 'cliVersion', 'ideVersion']) {
      if (only && !only.has(key)) continue
      const val = latest[key]
      if (!val) continue
      if (wbVersionCheck.compareVersion(val, identity[key] || currentVersions()[key] || '0') <= 0) continue
      identity[key] = val
      applied.push({ key, value: val })
    }
    if (!applied.length) {
      return res.json({ ok: true, applied: [], message: '没有需要更新的版本号' })
    }

    // 同步派生的 UA 串：identity 同时存版本号与成品 UA，而消费端优先用成品 UA 串
    //（headers.js 的 userAgent）。只改版本号而不同步 UA 串的话，出站请求仍是旧版本号。
    const nextVersions = { ...prevVersions }
    for (const a of applied) nextVersions[a.key] = a.value
    const synced = wbIdentity.syncDerivedUA(identity, prevVersions, nextVersions)
    serverConfig.workbuddy.identity = synced.identity
    engine.saveServerConfig(serverConfig)

    // 热更新运行时 identity（UA 立即按新版本号拼接）
    workbuddy.updateConfig({ identity: synced.identity })

    res.json({
      ok: true,
      applied,
      syncedUA: Object.keys(synced.changed),
      identity: synced.identity
    })
  } catch (err) {
    res.status(500).json({ error: '应用版本号失败: ' + (err.message || '未知错误') })
  }
})

// WorkBuddy 运行时配置（提示词模式 / 脱敏开关等，热生效）
app.get('/api/workbuddy/config', (req, res) => {
  const rt = requireWorkbuddy(res)
  if (!rt) return
  res.json({
    promptMode: rt.cfg.promptMode,
    sanitizeFingerprints: rt.cfg.sanitizeFingerprints,
    rewriteMode: rt.cfg.rewriteMode,
    clientIdentity: rt.cfg.clientIdentity,
    // 界面回填用：返回「覆盖 > 官方默认」的完整生效值（30 项，无空值）
    identity: wbIdentity.effective(rt.cfg.identity),
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
    if (req.body?.rewriteMode === 'compat' || req.body?.rewriteMode === 'native') wb.rewriteMode = req.body.rewriteMode
    if (req.body?.clientIdentity === 'workbuddy' || req.body?.clientIdentity === 'codebuddy') wb.clientIdentity = req.body.clientIdentity
    if (req.body?.identity && typeof req.body.identity === 'object') wb.identity = wbIdentity.normalize(req.body.identity)
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

// 系统状态：本地版本、更新线路与当前监听端口（设置页「系统状态」用；未监听时回落配置端口）
// line 与 /api/update/check 的判定同一套规则：版本号带 beta/rc 等标识走 beta 线
app.get('/api/system/status', (req, res) => {
  const addr = server && server.address()
  const version = update.getLocalVersion()
  res.json({
    version,
    line: update.releaseLine(version),
    port: (addr && addr.port) || engine.getServerConfig().port || 3000
  })
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

// 时间维度一次取回：当日 / 本周 / 本月 / 近三月 / 本年。
// 拆成多个请求会让面板各自闪烁、各自失败；而且月维度必须走月汇总桶
// （按日明细只留 35 天，月初用日明细加会少一截），聚合口径只放服务端一处
app.get('/api/token-stats/range', (req, res) => {
  res.json(tokenStats.getRangeStats())
})

// 用量统计页的日历维度明细：本日 / 本周 / 本月 / 近三月 / 本年。
// 与 /range 的区别是「要画图」，所以连带返回逐天明细（本日走 /hourly/:date）。
// 近三月与本年超过明细保留期时，明细只从保留期内最早的那天开始，summary 仍是完整口径
app.get('/api/token-stats/calendar/:range', (req, res) => {
  const ranges = tokenStats.getCalendarRanges()
  const picked = ranges[req.params.range]
  if (!picked) {
    return res.status(400).json({ error: `未知的时间维度：${req.params.range}` })
  }
  res.json({
    range: req.params.range,
    start: picked.start.getTime(),
    end: picked.end.getTime(),
    summary: picked.summary,
    details: tokenStats.getDaysDetailBetween(picked.start.getTime(), picked.end.getTime())
  })
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

// ==================== 配置备份（导出 / 导入） ====================
// 导出包含明文的模型 apiKey 与账号凭据：只经本机 127.0.0.1 传输，前端不落盘缓存
app.get('/api/config/export', (req, res) => {
  try {
    res.json(configIO.exportAll())
  } catch (err) {
    res.status(500).json({ error: '导出配置失败: ' + (err.message || '未知原因') })
  }
})

// 覆盖式导入：config-io 内部写盘前先快照，失败回滚；这里只负责按新文件重建运行时
app.post('/api/config/import', async (req, res) => {
  let result
  try {
    result = configIO.importAll(req.body)
  } catch (err) {
    return res.status(400).json({ error: err.message || '导入配置失败' })
  }
  await reloadRuntimes()
  res.json(result)
})

// 清空配置：抹掉模型来源、规则与账号凭据；服务端设置保留
app.post('/api/config/clear', async (req, res) => {
  let result
  try {
    result = configIO.clearAll()
  } catch (err) {
    return res.status(500).json({ error: err.message || '清空配置失败' })
  }
  await reloadRuntimes()
  res.json(result)
})

// Auto 策略：客户端模型名填 `auto` 时按哪一档口径挑模型（见 auto-strategy.js）。
// 非法档位回 400，不静默回退 —— 前端要根据这个状态码提示「切换失败」。
app.get('/api/auto-strategy', (req, res) => {
  res.json({ strategy: autoStrategy.getStrategy(), strategies: autoStrategy.listStrategies() })
})

app.put('/api/auto-strategy', (req, res) => {
  // 用原值校验：normalizeStrategy 会把不认识的档位静默回退成默认档，
  // 那样非法请求会得到 200，前端永远不知道切换没生效
  const raw = req.body?.strategy
  if (!autoStrategy.STRATEGIES.some(item => item.id === raw)) {
    return res.status(400).json({ error: `未知的 Auto 策略：${raw}` })
  }
  const strategy = autoStrategy.saveStrategy(raw)
  res.json({ strategy })
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
      enabledModelsGlobal: wb.enabledModelsGlobal || [],
      promptMode: wb.promptMode || 'custom',
      promptFile: wb.promptFile || '',
      sanitizeFingerprints: wb.sanitizeFingerprints !== false,
      rewriteMode: wb.rewriteMode || 'compat',
      clientIdentity: wb.clientIdentity || 'workbuddy',
      identity: wb.identity || {},
      deviceTokenFile: wb.deviceTokenFile || '',
      log: msg => console.log(`[aiRoute] ${msg}`)
    })
  } catch (err) {
    console.error('[aiRoute] WorkBuddy 初始化失败:', err.message)
  }
}

initWorkbuddy()

// ===== 免费账号渠道（server/channels/）=====
//
// 渠道包自己持有账号池、登录态、模型黑名单与积分，AiRoute 只在外面做两件事：
// 把它的模型目录同步成一个 Provider，以及把请求转进 worker。
//
// 为什么只建一个 Provider 而不是五家：渠道的模型 id 本来就是
// `provider/model` 形态（trae/glm-5.2、workbuddy/auto），而 AiRoute 的
// 引用格式是 `providerName/modelId` 且 modelId 允许含斜杠 —— 一个 `channels` 源
// 即可无损表达，配置里也不用为每家各留一条会自动重生的记录。
const CHANNEL_PROVIDER_ID = 'channels'
// 渠道数是**算出来的**：插件装了几家（WorkBuddy 两区也各算一家）就写几家。
// 插件可以装/卸/停用，写死一个数字就会在用户装了第三方插件后一直显示旧值。
const CHANNEL_PROVIDER_FALLBACK_COUNT = 5
function channelProviderName() {
  const count = channels.getRuntime()?.providers.length || CHANNEL_PROVIDER_FALLBACK_COUNT
  return `账号渠道（${count} 家）`
}
// 历次默认名。渠道数变了（10 → 11 → 5 → N）之后，只有用户自己改过名字才需要
// 保留，还是旧默认值的应当跟着升级 —— 否则界面上会长期写着「11 家」。
const LEGACY_CHANNEL_NAMES = ['账号渠道', '账号渠道（10 家）', '账号渠道（11 家）', '账号渠道（5 家）']

// 旧形态迁移：WorkBuddy 曾经是独立的 `type: 'workbuddy'` 源（每个区域一个），
// 现在是渠道包里的第 11 家（两个 provider：workbuddy / workbuddy-global）。
//
// 迁移必须连模型级设置一起搬（显示名、推理档位），否则用户调过的档位会在升级后
// 静默失效；路由规则与当前选择里的引用也要改写，否则会指向一个已被删掉的源。
function migrateWorkbuddyProviders() {
  try {
    const config = getConfig()
    const names = models.listWorkbuddyProviders(config)
    if (names.length === 0) return

    // 老源名 → 渠道包里的模型 id 前缀
    const prefixOf = new Map()
    const carried = []
    for (const name of names) {
      const provider = config[name]
      const prefix = models.providerRegion(provider) === 'global' ? 'workbuddy-global' : 'workbuddy'
      prefixOf.set(name, prefix)
      for (const model of provider.models || []) {
        const entry = typeof model === 'string' ? { id: model } : { ...model }
        if (!entry.id) continue
        carried.push({ ...entry, id: `${prefix}/${entry.id}` })
      }
      delete config[name]
    }

    // 并入而不是覆盖：渠道目录可能已经同步过一次，那一份才是权威，
    // 老源只用来补回手工改过的字段
    const existing = config[CHANNEL_PROVIDER_ID] || {}
    const merged = [...(existing.models || [])]
    const known = new Set(merged.map(model => (typeof model === 'string' ? model : model.id)))
    for (const entry of carried) {
      if (known.has(entry.id)) continue
      known.add(entry.id)
      merged.push(entry)
    }
    config[CHANNEL_PROVIDER_ID] = {
      ...existing,
      displayName: existing.displayName || channelProviderName(),
      type: 'channel',
      models: merged
    }

    // 引用改写：`<老源>/<模型>` → `channels/<前缀>/<模型>`
    const rewrite = ref => {
      if (typeof ref !== 'string') return ref
      for (const [name, prefix] of prefixOf) {
        if (ref.startsWith(`${name}/`)) {
          return `${CHANNEL_PROVIDER_ID}/${prefix}/${ref.slice(name.length + 1)}`
        }
      }
      return ref
    }

    const state = getState()
    const nextCurrent = rewrite(state.current)
    if (nextCurrent !== state.current) {
      state.current = nextCurrent
      saveState(state)
    }

    const fallbackData = getFallback()
    const nextFallback = rewrite(fallbackData.model)
    if (nextFallback !== fallbackData.model) saveFallback({ ...fallbackData, model: nextFallback })

    const rules = engine.getRules()
    let rulesChanged = false
    for (const rule of [...(rules.rules || []), ...(rules.customRules || [])]) {
      const next = rewrite(rule?.target)
      if (next !== rule?.target) {
        rule.target = next
        rulesChanged = true
      }
    }
    if (rulesChanged) engine.saveRules(rules)

    saveConfig(config)
    console.log(`[aiRoute] 已把 ${names.join('、')} 并入渠道源 ${CHANNEL_PROVIDER_ID}（${carried.length} 个模型）`)
  } catch (err) {
    console.error('[aiRoute] WorkBuddy 源迁移失败:', err.message)
  }
}

migrateWorkbuddyProviders()

// 渠道目录 → Provider.models。
// 合并而不是整体替换：用户可能改过显示名或填了推理档位，重登一次就冲掉
// 会让这些手工值每次重启都丢。已被渠道移除的模型自然消失（不再出现在目录里）。
// 上下文/输出上限不保留旧值 —— 目录里的才是权威值（WorkBuddy 那组还来自账号池
// 的启用清单，保留旧值会让池里的修改永远不生效）。
function syncChannelProvider(rows) {
  try {
    const config = getConfig()
    const existing = config[CHANNEL_PROVIDER_ID]
    // 用户把它改成了通用源 —— 那是显式选择，不覆盖
    if (existing && existing.type !== 'channel') return

    const list = (rows || []).map(row => ({
      id: row.id,
      displayName: row.name || row.id,
      ...row.context_window ? { maxContext: row.context_window } : {},
      ...row.max_tokens ? { maxOutput: row.max_tokens } : {}
    }))
    // 一个账号都没登录时不建空 Provider：空模型列表会让路由规则指向一个
    // 永远失败的源（与 WorkBuddy 无账号时的行为不同，后者是池驱动、无需目录）
    if (!existing && list.length === 0) return

    const previous = new Map()
    for (const model of existing?.models || []) {
      if (typeof model === 'string') previous.set(model, model)
      else if (model && typeof model.id === 'string') previous.set(model.id, model)
    }
    const merged = list.map(row => {
      const prev = previous.get(row.id)
      if (!prev || typeof prev === 'string') return row
      return {
        ...row,
        ...prev.displayName ? { displayName: prev.displayName } : {},
        ...prev.reasoningEffort ? { reasoningEffort: prev.reasoningEffort } : {}
      }
    })

    const previousName = existing?.displayName || ''
    config[CHANNEL_PROVIDER_ID] = {
      ...existing,
      // 旧默认名跟着升级，用户改过的保留
      displayName: !previousName || LEGACY_CHANNEL_NAMES.includes(previousName) ? channelProviderName() : previousName,
      type: 'channel',
      models: models.sanitizeModels(merged)
    }
    saveConfig(config)
  } catch (err) {
    console.error('[aiRoute] 渠道模型目录同步失败:', err.message)
  }
}

async function syncChannelProviderFromRuntime() {
  const rt = channels.getRuntime()
  if (!rt) return
  syncChannelProvider(await rt.refresh())
}

// 目录同步去抖：渠道包在账号变更时会 emit，一次登录可能连发多条，
// 每条都写一次 models.json 既吵又可能被用户在另一个窗口的改动覆盖
let channelSyncTimer = null
function scheduleChannelSync() {
  clearTimeout(channelSyncTimer)
  channelSyncTimer = setTimeout(() => {
    syncChannelProviderFromRuntime().catch(err => console.error('[aiRoute] 渠道目录刷新失败:', err.message))
  }, 400)
  channelSyncTimer.unref?.()
}

// 初始化渠道运行时（未登录任何账号也能启动，转发时才报无可用账号）
// 返回初始化 promise：导入配置后要等它完成，才能确认新账号已生效
function initChannels() {
  return channels.init({
    onChanged: scheduleChannelSync,
    logger: {
      info: message => console.log(`[channels] ${message}`),
      warn: message => console.warn(`[channels] ${message}`),
      error: message => console.error(`[channels] ${message}`)
    }
  }).then(() => syncChannelProviderFromRuntime())
    .catch(err => console.error('[aiRoute] 渠道初始化失败:', err.message))
}

initChannels()

// 导入配置后按新文件重建运行时：WorkBuddy 账号池/调度器与渠道 worker 都只在
// init 时读盘，不重建的话界面显示新账号、请求却还在用旧池
async function reloadRuntimes() {
  try {
    workbuddy.shutdown()
  } catch (err) {
    console.error('[aiRoute] WorkBuddy 关停失败:', err.message)
  }
  try {
    await channels.shutdown()
  } catch (err) {
    console.error('[aiRoute] 渠道关停失败:', err.message)
  }
  initWorkbuddy()
  await initChannels()
}

app.get('/api/channels/status', async (req, res) => {
  const rt = channels.getRuntime()
  if (!rt) return res.json({ ok: true, state: 'unavailable', error: '', providers: [], models: 0 })
  // 面板的首个请求常早于 worker 初始化完成：不等 ready 会回一份
  // 「providers 空、models 0」的快照，界面看起来像渠道全没了（实际只是在启动）
  try {
    await rt.ready
  } catch {
    /* 初始化失败：下面按 failed 状态回报，不让请求挂在这里 */
  }
  const state = rt.state()
  res.json({
    ok: true,
    state: state.state,
    error: state.error,
    providers: rt.providers,
    models: rt.publicModelRows().length,
    // 插件现状：装了什么、哪家没起来。面板与 CLI 都读这一份
    plugins: typeof rt.plugins === 'function' ? rt.plugins() : [],
    pluginFailures: typeof rt.pluginFailures === 'function' ? rt.pluginFailures() : []
  })
})

// ===== 渠道设置（首帧上限 / 心跳 / 冷却 / 并发 / 选号）=====
//
// 放在 channels-data/channel-settings.json，面板「渠道设置」内页读写它。
// 默认值等于改造前的行为，所以升级后不点任何开关，表现与旧版一致。

app.get('/api/channels/settings', (req, res) => {
  try {
    const store = typeof channels.getSettings === 'function' ? channels.getSettings() : null
    // 渠道模块被测试替身替换时没有设置读口：回空设置比 500 更接近"没配置"
    res.json({ ok: true, settings: store ? store.get() : {} })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message })
  }
})

app.put('/api/channels/settings', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  try {
    const store = typeof channels.getSettings === 'function' ? channels.getSettings() : null
    if (!store) return res.status(503).json({ ok: false, error: '渠道运行时未初始化' })
    res.json({ ok: true, settings: store.update(body) })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

// ===== 渠道插件管理 =====
//
// 插件就是这个目录里的普通包（见 server/channels/plugin-store.js）：
// 装/卸/启停改的是清单，然后**重建运行时** —— provider 集合由清单算出来，
// 不重建的话界面显示新清单、请求还按旧的走。
//
// 这里刻意不做「在线从 npm 拉包」：装一个第三方插件等于让它读本机的账号凭据，
// 来源必须是用户显式给的本地路径。要装远程包，先自己解到本机再指过来。

app.get('/api/channels/plugins', async (req, res) => {
  const rt = channels.getRuntime()
  if (!rt) return res.json({ ok: true, plugins: [], failures: [], available: [] })
  res.json({
    ok: true,
    plugins: typeof rt.plugins === 'function' ? rt.plugins() : [],
    failures: typeof rt.pluginFailures === 'function' ? rt.pluginFailures() : [],
    // 内置包里还没被装上的（正常情况为空：内置插件在清单里默认全启用）
    available: channels.listBuiltinPlugins(),
  })
})

app.post('/api/channels/plugins', async (req, res) => {
  const action = String(req.body?.action || '')
  const id = String(req.body?.id || '')
  const source = String(req.body?.source || '')
  try {
    const store = channels.getRuntime()?.store
    if (!store) return res.status(503).json({ ok: false, error: '渠道运行时未初始化' })
    if (action === 'add') {
      if (!id || !source) return res.status(400).json({ ok: false, error: '添加插件需要 id 与 source（本地目录或 npm 包名）' })
      store.add({ id, source })
    } else if (action === 'remove') {
      if (!id) return res.status(400).json({ ok: false, error: '缺少插件 id' })
      store.remove(id)
    } else if (action === 'enable' || action === 'disable') {
      if (!id) return res.status(400).json({ ok: false, error: '缺少插件 id' })
      store.setEnabled(id, action === 'enable')
    } else {
      return res.status(400).json({ ok: false, error: `未知动作：${action}` })
    }
    // 重建之后再同步目录：新插件的模型要立刻出现在 channels 源里
    await channels.reloadPlugins()
    await syncChannelProviderFromRuntime()
    res.json({ ok: true, ...(await channelPluginInfo()) })
  } catch (err) {
    res.status(err.statusCode && err.statusCode >= 400 ? err.statusCode : 400).json({ ok: false, error: err.message })
  }
})

async function channelPluginInfo() {
  const rt = channels.getRuntime()
  if (!rt) return { plugins: [], failures: [], available: channels.listBuiltinPlugins() }
  return {
    plugins: typeof rt.plugins === 'function' ? rt.plugins() : [],
    failures: typeof rt.pluginFailures === 'function' ? rt.pluginFailures() : [],
    available: channels.listBuiltinPlugins(),
  }
}

// 实时目录（渠道包口径）：登录完就能看到该账号的模型
app.get('/api/channels/models', async (req, res) => {
  try {
    const rt = channels.getRuntime()
    if (!rt) return res.status(503).json({ ok: false, error: '渠道运行时未初始化' })
    res.json({ ok: true, models: await rt.refresh() })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

// 重新采集目录并同步进 Provider 配置（新增账号、上游调整目录后调用）
app.post('/api/channels/refresh', async (req, res) => {
  try {
    await syncChannelProviderFromRuntime()
    res.json({ ok: true, models: channels.getRuntime()?.publicModelRows().length ?? 0 })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

// 渠道管理 RPC 透传：登录 / 账号池 / 积分 / 黑名单 / 备份全走渠道包自己的方法表。
// 这里不做方法白名单 —— 抄一份方法表只会随上游版本漂移，而渠道包的 RPC 层
// 已经对每个方法做了参数校验。
app.post('/api/channels/rpc', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const controller = new AbortController()
  const onClose = () => { if (!req.complete) controller.abort() }
  res.on('close', onClose)
  try {
    const result = await channels.rpc({ method: body.method, payload: body.payload }, controller.signal)
    // 账号类方法会改动池与目录：登录成功、删号、启停都影响「哪些模型可见」
    if (typeof body.method === 'string' && /^(?:account|login|provider|model|credits)\./.test(body.method)) {
      scheduleChannelSync()
    }
    // 改账号/积分的动作（登录、删号、领积分）会让失活判定立刻变；只挑这类方法补跑
    // 一轮审计 —— account.list / credits.balances 是轮询读取，触发它们等于每 5 秒审一次
    if (typeof body.method === 'string' && /^(?:account\.(?:create|delete|reset|resetAll|update|reorder)|credits\.claimAll)$/.test(body.method)) {
      modelHealthAudit.audit().catch(() => { /* 审计失败不影响这次 RPC 的结果 */ })
    }
    res.json({ ok: true, result })
  } catch (err) {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400
    res.status(status).json({ ok: false, error: err.message })
  } finally {
    res.removeListener('close', onClose)
  }
})

// 渠道 Provider 的连通性测试：发一次真实短对话（与 WorkBuddy 的测试口径一致）
//
// 未指定模型时**依次试前几个**而不是只试第一个：上游目录与「此刻真的能调」并
// 不完全同步（曾见 TRAE 的 Doubao-Seed-Code 回流内 code=4001，同账号换 glm-5.1
// 立刻正常，次日该模型又恢复正常 —— 即失败可能是上游侧的临时状态）。只试第一个
// 会把「某个模型此刻不可调用」误报成「这个渠道不通」，而用户没有别的手段分辨。
const TEST_MODEL_CANDIDATES = 3

// 渠道包的模型 id（gemini/x）→ AiRoute 引用（channels/gemini/x）。
// 目录没同步上、或用户把渠道源改名时可能对不上；对不上就不记账，
// 免得在台账里留下一个配置里根本不存在的孤儿引用。
function channelModelRef(modelId) {
  const ref = `${CHANNEL_PROVIDER_ID}/${modelId}`
  return resolveRef(getConfig(), ref) ? ref : ''
}

app.post('/api/channels/test', async (req, res) => {
  const rt = channels.getRuntime()
  if (!rt) return res.status(503).json({ ok: false, error: '渠道运行时未初始化' })
  const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : ''
  const wantModel = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  // worker 启动早期目录还没采集：此时按「没有模型」拒绝，会让用户误以为账号没登上
  let rows = rt.publicModelRows()
  if (!wantModel && rows.length === 0) {
    try { rows = await rt.refresh() } catch { /* 采集失败：下面按没有候选处理 */ }
  }
  // 目录不受「是否登录」门控（未登录渠道也会播报模型），直接拿前几个候选会在
  // 无账号的渠道上必然失败。故先按 provider.status 的账号计数筛出真正能调的渠道；
  // 拿不到计数时不做过滤 —— 让真实调用给出答案，好过凭猜测拒绝。
  let live = null
  if (!wantModel) {
    try {
      // rt.rpc 回的是渠道包封套 { ok, value }，value 里才是 { statuses }
      const reply = await rt.rpc({ method: 'provider.status', payload: { providers: rt.providers } })
      const statuses = reply?.ok === true ? reply.value?.statuses : undefined
      if (statuses) {
        live = new Set(Object.entries(statuses)
          .filter(([, status]) => (status?.accounts?.total || 0) > 0)
          .map(([id]) => id))
      }
    } catch { /* 计数不可用：退回全量目录 */ }
  }
  // 目录行带的是 `owned_by`（就是 provider），没有 `channel` 字段。
  // 按 `row.channel` 判可用会让每一行都落到「没有账号」那一侧 —— 渠道明明登录了，
  // 测试却统一报「先登录该渠道的账号」。这里统一取行自己的 provider。
  const rowProvider = row => (row && (row.channel || row.owned_by)) || String(row?.id || '').split('/')[0]
  const candidates = wantModel
    ? [wantModel]
    : rows
      .filter(row => (!provider || rowProvider(row) === provider || row.id.startsWith(`${provider}/`))
        && !modelHealth.isOffline(channelModelRef(row.id))
        // WorkBuddy 不在渠道包的 provider.status 里（它不是包内 provider），
        // 只要运行时在就当作可用，让真实调用给出答案
        && (live === null || live.has(rowProvider(row)) || (!!workbuddy.getRuntime() && !!channelWorkbuddyRealm(row.id))))
      .map(row => row.id)
      .slice(0, TEST_MODEL_CANDIDATES)
  if (!candidates.length) {
    // 「没有模型」有两种完全不同的原因：没登录账号，和账号在但模型全被关掉。
    // 早先两句话合并成一句「先登录该渠道的账号」，账号明明登录了却看到这句，
    // 只会让人去重登 —— 实际要动的是「模型」页的开关。
    let accountCount = 0
    try {
      const reply = await rt.rpc({ method: 'provider.status', payload: { providers: rt.providers } })
      accountCount = reply?.ok === true ? (reply.value?.statuses?.[provider]?.accounts?.total || 0) : 0
    } catch { /* 拿不到计数就按老文案走 */ }
    return res.status(400).json({
      ok: false,
      error: provider
        ? accountCount > 0
          ? `渠道 ${provider} 的模型全部处于关闭状态：到「模型」页把要用的模型打开，再回来测试`
          : `渠道 ${provider} 还没有可用模型（先登录该渠道的账号）`
        : '账号池里还没有可用模型（先登录一个账号）'
    })
  }
  const start = Date.now()
  const tried = []
  // 「停止」：前端 abort 请求 → res 关闭 → 中止在途上游调用，并在候选之间跳出。
  // 两者都要有 —— 只跳出循环的话，正在跑的那次调用仍会占着连接直到超时。
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  for (const model of candidates) {
    if (controller.signal.aborted) return
    const attemptStart = Date.now()
    // 首字节时间由 attempt 内的帧回调给出（换号重试时以最后一次为准）
    let firstChunkMs = NaN
    try {
      const attempt = await channelTestCompletion(model, controller.signal, ms => { firstChunkMs = ms })
      const completion = attempt.completion
      const message = completion.choices?.[0]?.message || {}
      // 测试通过 = 这个模型此刻真的能调：顺手清掉「连续失败」的失活标记，
      // 否则用户只能去别处点恢复
      const ref = channelModelRef(model)
      if (ref) modelHealth.noteSuccess(ref)
      const timing = testTiming(completion, firstChunkMs, Date.now() - attemptStart)
      return res.json({
        ok: true,
        model,
        // latency 保留原名（界面旧版本与渠道页历史数据都读它），语义是「首字节响应时间」
        latency: timing.ttfbMs,
        ...timing,
        // 正文为空时退回 reasoning：只要上游真回了内容，就说明链路是通的
        reply: (message.content || message.reasoning_content || '').slice(0, 80),
        finish: completion.choices?.[0]?.finish_reason,
        // 前面失败的候选一并回给界面：自动模式下用户要知道「跳过的是哪些、为什么」
        tried
      })
    } catch (err) {
      if (controller.signal.aborted) return
      tried.push({ model, error: err.message })
    }
  }
  res.json({ ok: false, error: tried[tried.length - 1].error, latency: Date.now() - start, tried })
})

// 兜底错误处理中间件（必须放在所有路由之后）：
//  1. 未捕获异常不再走 Express 默认处理器——它会回吐完整堆栈与绝对路径
//  2. body 解析失败（畸形 JSON、超出 100mb 上限）也汇到这里，统一回 400
// 注意必须保持 4 个参数：Express 依此识别错误中间件，少一个会被当普通中间件注册
app.use((err, req, res, next) => {
  const status = err && (err.status || err.statusCode)
  const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500
  // 详情只留在服务端日志，响应体只给通用文案（绝不回堆栈）
  console.error(`[aiRoute] 请求处理异常 ${req.method} ${req.originalUrl}:`, err && err.message)
  if (res.headersSent) return next(err)
  res.status(code).json({ error: code === 400 ? '请求体不是合法 JSON 或超出大小上限' : '服务器内部错误' })
})

const PORT = process.env.PORT || engine.getServerConfig().port || 3000
listen(PORT)
// 启动即审一轮，之后按间隔轮转：进程重启后余额与账号状态可能已经变过
modelHealthAudit.start()
