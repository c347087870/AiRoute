// Qoder 渠道：设备码登录、续期、目录、加密补全
//
// 与 Trae 同构（没有 cordis ctx、没有 LLM 适配器栈），差异只在协议：
//   - 登录是**设备码轮询**（不是本地回调）：用户在网页确认后，我们轮询 openApi 取令牌；
//   - 补全走 **WASM 加密端点**，请求体的加密与签名由 qoder-auth-wasm 完成；
//   - 响应的 SSE 多一层信封，先剥掉才是标准 OpenAI 帧。
//
// 国际版（qoder.com）与国内版（qoder.cn）是**两套独立凭据**，但协议同形，
// 所以共用本文件，差别全在 protocol.PRODUCTS 里。

const fs = require('fs')
const path = require('path')

const protocol = require('./protocol')
const { QoderEncryptedInfer } = require('./wasm')

const PROVIDERS = ['qoder', 'qodercn']

// 消息里的工具调用要转成客户端认识的形状（OpenAI 风格，不用 Anthropic 的 tool_use）
function buildHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && typeof message === 'object')
    .map(message => {
      const role = message.role === 'tool' ? 'tool' : message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
      const entry = { role, content: typeof message.content === 'string' ? message.content : message.content ?? '' }
      if (role === 'assistant' && Array.isArray(message.tool_calls)) {
        entry.tool_calls = message.tool_calls.map((call, index) => ({
          id: call.id || `call_${index}`,
          type: 'function',
          index,
          function: { name: call.function?.name || '', arguments: call.function?.arguments || '{}' },
        }))
      }
      if (role === 'tool' && message.tool_call_id) entry.tool_call_id = message.tool_call_id
      return entry
    })
}

// 工具定义必须真的下发：不下发时模型只能用正文里的 XML 臆造工具调用
function buildTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter(tool => tool && typeof tool === 'object' && tool.function)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      },
    }))
}

// 取消息里的纯文本（最后一条 user 消息就是本轮提问）
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('')
  }
  return ''
}

// 业务错误帧 → Error；排队（10605）单独标出来，调用方据此等待后重发。
//
// ⚠️ 排队不能按「普通失败」快退避重试：服务端明确要求等 `retryAfterSeconds`
// （实测 30 秒），按 500ms→8s 的指数退避永远等不到，表现就是「偶尔能用」。
// 也不能把它当认证失败去续期 —— 那会白换一次令牌再撞同一堵墙。
function queueOrError(data) {
  // HTTP 层传入的是整个响应体对象，SSE 层传入的是顶层帧的 message；
  // 两者共用同一套解析（vendor 的 model-queue 明确要求两种形态都支持），
  // 否则就是「只修了一条路径」的老缺陷。
  const info = protocol.parseQueueInfo(data) ?? protocol.parseQueueInfo(data?.message)
  if (info || String(data.code) === '10605') {
    const seconds = Number(info?.retryAfterSeconds ?? info?.waitTime ?? 30)
    const error = new Error(`Qoder 排队中，${seconds} 秒后重试`)
    error.code = 'QUEUED'
    error.retryAfterMs = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 120) * 1000 : 30000
    return error
  }
  const message = typeof data.message === 'string' && data.message.length < 200
    ? data.message
    : JSON.stringify(data.message)
  return new Error(`Qoder：${message}`)
}

// credentials 由宿主注入（见 plugin-api.js）
function createQoder({ dataDir, logger = console, credentials }) {
  if (!credentials) throw new Error('Qoder 插件缺少凭据服务（credentials）')
  const accounts = credentials
  let catalog = new Map()
  // 每个账号一个加密客户端（WASM 上下文有状态，不能跨账号复用）
  const clients = new Map()
  const refreshing = new Map()
  const rateLimits = new Map()
  const logins = new Map()
  // 账号级今日 token：uid → { day, total }。内存账本（进程重启清零），与
  // WorkBuddy 池的 tokenUsageToday 同口径；跨零点自然归零，不落盘
  const tokenToday = new Map()

  function noteTokenUsage(uid, tokens) {
    const total = Math.trunc(Number(tokens) || 0)
    if (!uid || total <= 0) return
    const day = new Date().toISOString().slice(0, 10)
    const entry = tokenToday.get(uid)
    if (!entry || entry.day !== day) tokenToday.set(uid, { day, total })
    else entry.total += total
  }

  function tokenUsageTodayOf(uid) {
    const entry = tokenToday.get(uid)
    return entry && entry.day === new Date().toISOString().slice(0, 10) ? entry.total : 0
  }
  const events = {}

  const notify = () => {
    try {
      events.onChanged?.()
    } catch (error) {
      logger.warn?.(`[qoder] 变更回调失败：${error.message}`)
    }
  }

  function registryFile(provider) {
    return path.join(dataDir, `${provider}-accounts.json`)
  }

  function readRegistry(provider) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile(provider), 'utf8'))
      return Array.isArray(parsed?.accounts) ? parsed.accounts : []
    } catch {
      return []
    }
  }

  function writeRegistry(provider, entries) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(registryFile(provider), JSON.stringify({ accounts: entries }, null, 2), { mode: 0o600 })
  }

  // 注册表 + 凭据文件合并：渠道包迁移过来的账号只在凭据文件里
  function listAccounts(provider) {
    const byUid = new Map(readRegistry(provider).map(entry => [entry.uid, entry]))
    for (const { uid, credential, suffix } of accounts.listCredentials(dataDir, provider)) {
      if (!uid) continue
      const id = `${provider}-${suffix}`
      if (!byUid.has(uid)) {
        byUid.set(uid, {
          uid,
          id,
          name: protocol.displayName(credential, id),
          enabled: true,
          addedAt: 0,
        })
        continue
      }
      // 注册表里的 id 可能来自旧算法，以凭据键名为准
      const existing = byUid.get(uid)
      if (existing.id !== id) byUid.set(uid, { ...existing, id })
    }
    return [...byUid.values()]
  }

  function updateAccount(provider, uid, patch) {
    const entries = readRegistry(provider)
    const index = entries.findIndex(entry => entry.uid === uid)
    if (index === -1) {
      entries.push({ uid, id: accounts.accountId(provider, uid), name: patch.name || uid, enabled: true, addedAt: Date.now(), ...patch })
    } else {
      entries[index] = { ...entries[index], ...patch }
    }
    writeRegistry(provider, entries)
    notify()
  }

  function accountEntries(provider) {
    return listAccounts(provider).map(entry => {
      const credential = accounts.getCredential(dataDir, provider, entry.uid)
      return {
        ...entry,
        name: credential ? protocol.displayName(credential, entry.name) : entry.name,
        refreshable: credential ? protocol.isRefreshable(credential) : false,
        expiresAt: credential ? protocol.credentialExpiresAtMs(credential) ?? 0 : 0,
        expired: credential ? protocol.isExpired(credential) : true,
        hasCredential: credential !== undefined,
        // 今日已用 token（账号级，见 tokenToday 的说明）
        tokenUsageToday: tokenUsageTodayOf(entry.uid),
      }
    })
  }

  async function request(url, { method = 'GET', headers, body, signal, timeout = protocol.REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController()
    const timer = timeout > 0 ? setTimeout(() => controller.abort(new Error('请求超时')), timeout) : null
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal,
      })
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // ── 续期 ──

  async function refreshCredential(provider, uid) {
    const key = `${provider}:${uid}`
    if (refreshing.has(key)) return refreshing.get(key)
    const task = (async () => {
      const product = protocol.PRODUCTS[provider]
      const credential = accounts.getCredential(dataDir, provider, uid)
      if (!credential) throw new Error('账号凭据不存在')
      if (!protocol.isRefreshable(credential)) throw new Error('账号没有 refresh_token，请重新登录')
      const response = await request(`${product.openApiBase}${protocol.REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `${product.userAgentPrefix}/1.0.0`,
        },
        body: protocol.refreshBody(credential),
      })
      // 401/403 = 续期令牌真失效；其余（5xx、429）是可重试的瞬时失败
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error(`Qoder 续期被拒绝（HTTP ${response.status}），请重新登录`), { code: 'AUTH' })
      }
      const parsed = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`Qoder 续期失败（HTTP ${response.status}）`)
      const payload = protocol.parseTokenPayload(parsed)
      if (!payload.accessToken) throw Object.assign(new Error('续期响应缺少访问令牌，请重新登录'), { code: 'AUTH' })
      const next = protocol.applyRefresh(credential, payload)
      accounts.setCredential(dataDir, provider, uid, next)
      // 令牌变了，加密客户端的鉴权字段也要重建
      clients.delete(`${provider}:${uid}`)
      return next
    })().finally(() => refreshing.delete(key))
    refreshing.set(key, task)
    return task
  }

  function needsRefresh(credential) {
    if (!credential.access_token) return true
    const expiresAt = protocol.credentialExpiresAtMs(credential)
    if (expiresAt === undefined) return false
    return expiresAt - Date.now() < 5 * 60 * 1000
  }

  async function resolveCredential(provider, uid) {
    let credential = accounts.getCredential(dataDir, provider, uid)
    if (!credential) return undefined
    if (needsRefresh(credential) && protocol.isRefreshable(credential)) {
      try {
        credential = await refreshCredential(provider, uid)
      } catch (error) {
        if (!protocol.isExpired(credential)) logger.warn?.(`[qoder] ${uid} 续期失败，沿用现有令牌：${error.message}`)
        else throw error
      }
    }
    return credential
  }

  function usableAccounts(provider, model) {
    const now = Date.now()
    return listAccounts(provider).flatMap(entry => {
      if (entry.enabled === false) return []
      const until = rateLimits.get(`${provider}:${entry.uid}:${model}`)
      if (until !== undefined && until > now) return []
      const credential = accounts.getCredential(dataDir, provider, entry.uid)
      return credential ? [{ uid: entry.uid, credential }] : []
    })
  }

  // ── 目录 ──

  // Qoder 的目录端点需要 WASM 签名，成本高且不稳定；目录以产品兜底表为准
  // （与渠道包同一口径：线上模型列表走兜底表，客户端目录只用于离线核对）。
  function listModels(provider) {
    const product = protocol.PRODUCTS[provider]
    return product.models.map(model => ({
      id: model.id,
      name: model.name,
      displayName: model.name,
      maxContext: model.contextWindow || 200000,
      vision: model.supportsImage === true,
      reasoning: model.efforts && model.efforts.length > 0
        ? { efforts: model.efforts, defaultEffort: model.defaultEffort }
        : undefined,
    }))
  }

  function modelOf(provider, model) {
    return protocol.PRODUCTS[provider].models.find(each => each.id === model)
  }

  // ── 加密客户端 ──

  async function clientFor(provider, uid, credential) {
    const key = `${provider}:${uid}`
    if (clients.has(key)) return clients.get(key)
    const product = protocol.PRODUCTS[provider]
    const client = await QoderEncryptedInfer.create({
      // uid 是加密推理的必需项：缺了会挂起或失败
      user: { uid: credential.uid, securityOauthToken: protocol.bearerToken(credential) },
      machineId: credential.machine_id,
      metadata: { ...product.clientMetadata },
      host: product.inferBase,
    })
    clients.set(key, client)
    return client
  }

  // ── 补全 ──

  async function complete({ provider, model, openAi }, onChunk, signal) {
    const product = protocol.PRODUCTS[provider]
    if (!product) throw Object.assign(new Error(`未知的 Qoder 渠道：${provider}`), { statusCode: 404 })
    const bare = String(model || '').replace(new RegExp(`^${provider}/`), '')
    const candidates = usableAccounts(provider, bare)
    if (candidates.length === 0) {
      if (usableAccounts(provider, '').length === 0) {
        throw Object.assign(new Error(`${product.displayName} 没有可用账号，请先登录`), { statusCode: 401 })
      }
      throw Object.assign(new Error(`${product.displayName} 的账号都在 ${bare} 上受限`), { statusCode: 429 })
    }

    const messages = Array.isArray(openAi.messages) ? openAi.messages : []
    const systemMessage = messages.find(message => message.role === 'system')
    const lastUser = [...messages].reverse().find(message => message.role === 'user')
    const userText = textOf(lastUser?.content)
    const history = buildHistory(messages.filter(message => message.role !== 'system'))
    const meta = modelOf(provider, bare)
    const isReasoning = meta?.efforts?.length > 0
    const effort = typeof openAi.reasoning_effort === 'string' ? openAi.reasoning_effort : undefined

    let lastError
    for (const candidate of candidates) {
      try {
        const credential = await resolveCredential(provider, candidate.uid)
        const client = await clientFor(provider, candidate.uid, credential)
        const prepared = client.prepareInfer({
          modelKey: bare,
          userText,
          ...systemMessage ? { systemText: textOf(systemMessage.content) } : {},
          isReasoning,
          history: history.filter(message => message.role !== 'tool' || message.tool_call_id),
          tools: buildTools(openAi.tools),
          ...typeof openAi.max_tokens === 'number' ? { maxTokens: openAi.max_tokens } : {},
          ...effort ? { reasoningEffort: effort } : {},
          ...meta ? { isVl: meta.supportsImage === true, displayName: meta.name, maxInputTokens: meta.contextWindow } : {},
          // business 必填：缺了服务端会把请求路由到故障节点
          business: { type: 'agent' },
        })
        // ⚠️ 头必须原样透传：Authorization 是 WASM 签的 COSY 令牌
        let response = await request(prepared.url, {
          method: 'POST',
          headers: prepared.headers,
          body: prepared.body,
          signal,
          timeout: 0,
        })
        // HTTP 403 的排队体必须在认证分支之前识别；读取 clone 保留原响应体，
        // 以便下面的认证/普通错误处理仍能给出原始错误信息。
        let queueAttempts = 0
        while (response.status === 403 && !signal?.aborted) {
          const text = await response.clone().text().catch(() => '')
          let parsed
          try { parsed = JSON.parse(text) } catch { /* 普通错误 */ }
          const queueError = parsed && typeof parsed === 'object' ? queueOrError(parsed) : null
          if (queueError?.code !== 'QUEUED') break
          if (queueAttempts >= 2) throw queueError
          queueAttempts++
          logger.info?.(`[qoder] ${queueError.message}`)
          await new Promise(resolve => setTimeout(resolve, queueError.retryAfterMs))
          response = await request(prepared.url, {
            method: 'POST', headers: prepared.headers, body: prepared.body, signal, timeout: 0,
          })
        }
        if (response.status === 401 || response.status === 403) {
          // 认证失败才续期；排队（10605）与重复请求（409）都不是认证问题
          const text = await response.text().catch(() => '')
          if (response.status === 401 || /"?code"?\s*:\s*"?105"?/.test(text)) {
            await refreshCredential(provider, candidate.uid)
            throw Object.assign(new Error(`${product.displayName} 鉴权已过期`), { code: 'AUTH' })
          }
          throw new Error(`${product.displayName}：${text.slice(0, 200) || `HTTP ${response.status}`}`)
        }
        if (response.status === 409) {
          // 重复请求：凭据没问题，重发一次即可 —— 这里交给上层重试，不换号
          throw Object.assign(new Error(`${product.displayName}：重复请求`), { code: 'DUPLICATE' })
        }
        if (!response.ok) {
          // ⚠️ 排队的**第一种**形态是 HTTP 403 + 排队 JSON 体（subCode 常见为
          // RESOURCE_LIMIT）：必须先解析再当普通错误抛，否则就是快退避撞
          // 30 秒的服务端要求，永远等不到。SSE 层（第二种形态）已单独处理。
          const text = await response.text().catch(() => '')
          const status = response.status
          if (status === 429) {
            rateLimits.set(`${provider}:${candidate.uid}:${bare}`, Date.now() + 3600_000)
            lastError = new Error(`${product.displayName}：额度受限`)
            continue
          }
          throw new Error(`${product.displayName}：${text.slice(0, 300) || `HTTP ${status}`}`)
        }
        // 排队可以在同一账号上等一等再重发：排队期间没有任何产出，
        // 重放不会重复计费
        let sseQueueAttempts = 0
        for (;;) {
          try {
            return await consumeEnvelope(response, {
              model: bare,
              signal,
              // 记账包一层：usage 帧经过时顺手累计到该账号的今日 token（servedUid 已带入）
              onChunk: chunk => {
                if (chunk?.type === 'usage') noteTokenUsage(chunk.usage?.uid, chunk.usage?.totalTokens)
                onChunk(chunk)
              },
              servedUid: candidate.uid,
            })
          } catch (error) {
            if (error?.code !== 'QUEUED' || sseQueueAttempts >= 2 || signal?.aborted) throw error
            sseQueueAttempts++
            logger.info?.(`[qoder] ${error.message}`)
            await new Promise(resolve => setTimeout(resolve, error.retryAfterMs))
            const retried = await request(prepared.url, {
              method: 'POST', headers: prepared.headers, body: prepared.body, signal, timeout: 0,
            })
            if (!retried.ok) throw new Error(`${product.displayName}：排队重试失败（HTTP ${retried.status}）`)
            response = retried
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code === 'AUTH') { lastError = error; continue }
        if (error?.code === 'DUPLICATE') { lastError = error; continue }
        throw error
      }
    }
    throw lastError ?? new Error(`${product.displayName}：所有账号均不可用`)
  }

  // 信封 SSE → 内部 chunk。内层是标准 OpenAI 帧，所以解析与 Trae 同形，
  // 差别只在每一行先剥一层信封。
  async function consumeEnvelope(response, { model, signal, onChunk, servedUid }) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let emitted = false
    const toolCalls = new Map()
    let usage
    let finishReason
    let sawDone = false

    const handlePayload = payload => {
      if (payload === '[DONE]') { sawDone = true; return }
      let data
      try {
        data = JSON.parse(payload)
      } catch {
        return
      }
      if (!data || typeof data !== 'object') return
      // Qoder 的业务错误是**顶层** code/message（不是 OpenAI 的 error 对象）
      if (data.code !== undefined && data.message !== undefined && !Array.isArray(data.choices)) {
        throw queueOrError(data)
      }
      if (data.error) throw new Error(`Qoder：${data.error.message || JSON.stringify(data.error)}`)
      if (Array.isArray(data.usage)) usage = data.usage[0]
      else if (data.usage) usage = data.usage
      for (const choice of data.choices ?? []) {
        const delta = choice.delta ?? {}
        // 思考内容：业界多用 reasoning_content，Qoder 也可能给 reasoning
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          emitted = true
          onChunk({ type: 'reasoning-delta', text: reasoning })
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          emitted = true
          onChunk({ type: 'text-delta', text: delta.content })
        }
        for (const call of delta.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : toolCalls.size
          let tool = toolCalls.get(index)
          if (!tool) {
            tool = { id: call.id || `call_${index}`, name: '', arguments: '' }
            toolCalls.set(index, tool)
          }
          if (call.id) tool.id = call.id
          if (call.function?.name) tool.name = call.function.name
          const args = call.function?.arguments ?? ''
          tool.arguments += args
          emitted = true
          onChunk({
            type: 'tool-call-delta',
            index,
            id: tool.id,
            ...call.function?.name ? { name: call.function.name } : {},
            argumentsDelta: args,
          })
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const unwrapped = protocol.unwrapEnvelopeChunk(line)
          if (!unwrapped) continue // 心跳帧
          handlePayload(unwrapped.slice(5).trim())
        }
        if (signal?.aborted) throw new Error('请求已取消')
      }
      if (buffer.trim().length > 0 && buffer.trim().startsWith('data:')) {
        const unwrapped = protocol.unwrapEnvelopeChunk(buffer.trim())
        if (unwrapped) handlePayload(unwrapped.slice(5).trim())
      }
    } finally {
      reader.releaseLock()
    }

    for (const [index, call] of toolCalls) {
      onChunk({
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' },
      })
    }
    if (usage) {
      onChunk({
        type: 'usage',
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
          totalTokens: usage.total_tokens,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
          // 记账归因：面板的「今日 token」按账号累计（同 WorkBuddy 的 tokenUsageToday）
          ...(servedUid ? { uid: servedUid } : {}),
        },
      })
    }
    const reason = finishReason === 'tool_calls' || toolCalls.size > 0
      ? 'tool-calls'
      : finishReason === 'length'
        ? 'max-tokens'
        : sawDone || emitted
          ? 'stop'
          : 'error'
    onChunk({ type: 'finish', reason: { kind: reason } })
    return { emitted }
  }

  // ── 登录（设备码轮询）──

  // 起一次登录：返回授权页 URL 与 state。令牌由 poll 取回（面板轮询 login.poll）。
  async function startLogin(provider) {
    const product = protocol.PRODUCTS[provider]
    if (!product) throw new Error(`未知的 Qoder 渠道：${provider}`)
    const session = protocol.createDeviceSession()
    const state = accounts.randomSuffix()
    logins.set(state, { provider, session, startedAt: Date.now() })
    // 5 分钟后作废，避免内存里堆着不会完成的会话
    setTimeout(() => logins.delete(state), protocol.LOGIN_TIMEOUT_MS).unref?.()
    return { loginUrl: protocol.buildAuthUrl(session, product), state }
  }

  // 轮询一次：404 = 用户还没确认（继续等），200 = 拿到令牌
  async function pollLogin(provider, state) {
    const entry = logins.get(state)
    if (!entry) return { status: 'expired', message: '登录会话已失效，请重新发起' }
    const product = protocol.PRODUCTS[entry.provider]
    const response = await request(protocol.buildPollUrl(entry.session, product), {
      headers: { Accept: 'application/json', 'User-Agent': `${product.userAgentPrefix}/1.0.0` },
    })
    if (response.status === 404) return { status: 'pending' }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { status: 'pending', message: `HTTP ${response.status} ${text.slice(0, 120)}` }
    }
    const payload = protocol.parseTokenPayload(await response.json())
    if (!payload.accessToken) return { status: 'pending' }
    // 设备码响应里常常没有 user_name，补一次 userinfo 才拿得到真实昵称
    let nickname = payload.userName
    if (!nickname) {
      try {
        const info = await request(`${product.openApiBase}${protocol.USERINFO_PATH}`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${payload.accessToken}` },
        })
        if (info.ok) {
          const body = await info.json().catch(() => ({}))
          if (typeof body?.name === 'string' && body.name.trim()) nickname = body.name.trim()
        }
      } catch { /* 昵称只是展示信息，拿不到不该让登录失败 */ }
    }
    const credential = protocol.buildCredential(payload, { machineId: entry.session.machineId, nickname })
    const uid = credential.uid
    if (!uid) return { status: 'failed', message: '登录响应里没有 user_id，无法建立账号' }
    accounts.setCredential(dataDir, entry.provider, uid, credential)
    updateAccount(entry.provider, uid, {
      name: protocol.displayName(credential, accounts.accountId(entry.provider, uid)),
      enabled: true,
      addedAt: Date.now(),
    })
    logins.delete(state)
    return { status: 'done', uid, name: protocol.displayName(credential, uid) }
  }

  // ── 额度与签到 ──

  // Qoder 没有公开的签到端点；额度信息在加密通道的用量帧里，这里只报到「不支持」
  async function checkin() {
    return { outcome: 'ineligible', message: 'Qoder 没有每日签到端点' }
  }

  // 积分余额 = 套餐额度 + 资源包 + 专用资源包（见 protocol.parseUsageBalance）。
  // 这个端点不需要 WASM 签名，只要 Bearer。null 会原样抛出「查询失败」：
  // 上游查不到 ≠ 余额 0，报 0 会让用户以为额度被清空。
  async function balance(provider, uid) {
    const product = protocol.PRODUCTS[provider]
    if (!product) throw new Error(`未知的 Qoder 渠道：${provider}`)
    const credential = await resolveCredential(provider, uid)
    if (!credential) throw new Error('账号凭据不存在')
    const response = await request(`${product.openApiBase}${protocol.USAGE_PATH}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${protocol.bearerToken(credential)}`,
        // 桌面 app 身份（与 vendor 渠道包的 sashClientType 一致）；用量端点对此不敏感，
        // 带上与抓包请求一致，避免服务端按 CLI 身份限流
        'Cosy-ClientType': '10',
        'User-Agent': 'Qoder',
      },
    })
    if (!response.ok) throw new Error(`积分余额查询失败（HTTP ${response.status}）`)
    const parsed = protocol.parseUsageBalance(await response.json().catch(() => ({})))
    if (!parsed) throw new Error('积分余额查询失败：响应形状不符合预期')
    return parsed
  }

  // 渠道包迁移：凭据已在 channel-credentials.json 里，这里只补注册表条目
  function importLegacy(provider, entry) {
    const suffix = entry.suffix || accounts.accountSuffix(provider, entry.uid)
    updateAccount(provider, entry.uid, {
      id: `${provider}-${suffix}`,
      name: protocol.displayName(entry.credential, `${provider}-${suffix}`),
      enabled: true,
      addedAt: entry.addedAt ?? 0,
    })
    return listAccounts(provider).length
  }

  function removeAccount(provider, uid) {
    accounts.removeCredential(dataDir, provider, uid)
    writeRegistry(provider, readRegistry(provider).filter(entry => entry.uid !== uid))
    clients.delete(`${provider}:${uid}`)
    notify()
  }

  async function shutdown() {
    logins.clear()
    clients.clear()
    rateLimits.clear()
  }

  return {
    providers: PROVIDERS,
    listAccounts: accountEntries,
    updateAccount: (provider, uid, patch) => updateAccount(provider, uid, patch),
    listModels,
    complete,
    startLogin,
    pollLogin,
    removeAccount,
    importLegacy,
    checkin,
    balance,
    refresh: async () => [...PROVIDERS],
    refreshAccount: (provider, uid) => refreshCredential(provider, uid),
    shutdown,
    setEvents(handlers) {
      Object.assign(events, handlers)
    },
  }
}

module.exports = { createQoder, PROVIDERS }
