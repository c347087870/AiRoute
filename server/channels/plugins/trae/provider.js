// Trae 渠道：登录、续期、目录、补全、签到、额度
//
// 与 dsh 渠道包的区别：这里**不再有 cordis ctx 与 LLM 适配器栈**。AiRoute 的
// 请求体在 HTTP 层已经收敛成 OpenAI Chat，所以本文件只做三件事：
//   ① 选号（多账号、跳过被限流的）
//   ② 把 OpenAI 请求转成 SOLO 格式并发出去
//   ③ 把 SOLO 的自定义 SSE 事件转成 AiRoute 的内部 chunk（sse.js 的输入）
//
// 失败重试的边界（刻意与渠道包一致）：
//   - HTTP 层 401/403 → 续期一次后重发；
//   - 流内可换号错误（1005/4008/4011）→ **只在本轮还没吐任何内容时**换号重发
//     （吐了一半再重放会重复计费、重复执行工具）；
//   - 额度不足 → 标记该账号在此模型上受限，换下一个账号。

const http = require('http')
const fs = require('fs')
const path = require('path')

const protocol = require('./protocol')

const PROVIDERS = ['trae']
const CREDENTIAL_PREFIX = 'TRAE'

// 换号预算：一次请求最多试几个账号
const MAX_ROTATE = 3
// 流内错误与 HTTP 错误里「该换号」的判据
const RATE_LIMIT_FALLBACK_MS = 60 * 60 * 1000

// 本地日期键（YYYY-MM-DD）。签到按**自然日**算，跨零点自动失效，
// 所以存日期而不是存时间戳再比 24 小时。
// 与 server/workbuddy/pool.js 的 localDay 同口径，但两边各留一份：
// 插件不引用 WorkBuddy 的实现（那是另一套后端，不该成为插件的依赖）。
function localDay(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

class TraeError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'TraeError'
    this.code = code
    this.statusCode = status
  }
}

// credentials / login 由宿主注入（见 plugin-api.js）：插件不直接 require 宿主的
// 存储与端口服务，换实现时这里不用改。
function createTrae({ dataDir, logger = console, credentials, login }) {
  if (!credentials) throw new Error('Trae 插件缺少凭据服务（credentials）')
  if (!login) throw new Error('Trae 插件缺少登录回调服务（login）')
  const accounts = credentials
  const loginServer = login
  // ── 状态 ──
  // 模型目录缓存：远端失败时**不缓存空结果**，否则一次抖动会让目录空一整天
  let catalog = { models: [], at: 0 }
  let catalogFetching = null
  // 模型 → 所属通道（同一条目按通道择优后的结果）
  const channelOf = new Map()
  // 账号受限记录：`<uid>::<model>` → 解除时间戳
  const rateLimits = new Map()
  // 待完成的登录流程：state → { machineId, deviceId, createdAt }
  const logins = new Map()

  const notify = () => {
    try {
      events.onChanged?.()
    } catch (error) {
      logger.warn?.(`[Trae] 变更回调失败：${error.message}`)
    }
  }
  const events = {}

  function registryFile() {
    return path.join(dataDir, 'trae-accounts.json')
  }

  // 账号清单（展示顺序 + 停用标记）。凭据本身在 channel-credentials.json
  function readRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8'))
      return Array.isArray(parsed?.accounts) ? parsed.accounts : []
    } catch {
      return []
    }
  }

  function writeRegistry(entries) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(registryFile(), JSON.stringify({ accounts: entries }, null, 2), { mode: 0o600 })
  }

  // 合并「注册表里的账号」与「凭据文件里有的账号」：
  // 后者覆盖前者，因为渠道包迁移过来的账号只存在于凭据文件里
  function listAccounts() {
    const entries = readRegistry()
    const byUid = new Map(entries.map(entry => [entry.uid, entry]))
    for (const { uid, credential, suffix } of accounts.listCredentials(dataDir, 'trae')) {
      if (!uid) continue
      const id = `trae-${suffix}`
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
      // 注册表里的 id 可能来自旧算法（重算 hash），以凭据键名为准
      const existing = byUid.get(uid)
      if (existing.id !== id) byUid.set(uid, { ...existing, id })
    }
    return [...byUid.values()]
  }

  function accountEntries() {
    const today = localDay(Date.now())
    return listAccounts().map(entry => {
      const credential = accounts.getCredential(dataDir, 'trae', entry.uid)
      return {
        ...entry,
        name: credential ? protocol.displayName(credential, entry.name) : entry.name,
        refreshable: credential ? protocol.isRefreshable(credential) : false,
        expiresAt: credential ? protocol.credentialExpiresAtMs(credential) ?? 0 : 0,
        expired: credential ? protocol.isExpired(credential) : true,
        hasCredential: credential !== undefined,
        // 今天签过没：面板据此把「签到」按钮置灰。与 WorkBuddy 的
        // checkinDone 同名同义，两套后端在界面上才是同一个字段。
        // 跨零点自然失效 —— 存的是日期而不是「上次签到时刻」
        checkinDone: entry.lastCheckinDay === today,
        lastCheckinAt: Number(entry.lastCheckinAt) || 0,
      }
    })
  }

  function updateAccount(uid, patch) {
    const entries = readRegistry()
    const index = entries.findIndex(entry => entry.uid === uid)
    if (index === -1) {
      entries.push({ uid, id: accounts.accountId('trae', uid), name: patch.name || uid, enabled: true, addedAt: Date.now(), ...patch })
    } else {
      entries[index] = { ...entries[index], ...patch }
    }
    writeRegistry(entries)
    notify()
  }

  // 记下「今天签过了」。只写注册表，**不发 notify**：
  // notify 会触发宿主重建模型目录（onChanged → 目录重算），
  // 而签到不影响目录，白跑一趟远端采集。面板下一次轮询就能读到这个字段。
  //
  // stampAt=false 用于「上游说今天已签过」：那时我们只知道日期，
  // 不知道是哪一刻签的，写一个 now 会让「最近签到」显示成刚刚。
  function noteCheckinDone(uid, { stampAt = true } = {}) {
    const entries = readRegistry()
    const index = entries.findIndex(entry => entry.uid === uid)
    const now = Date.now()
    const patch = { lastCheckinDay: localDay(now) }
    if (stampAt) patch.lastCheckinAt = now
    if (index === -1) {
      // 注册表里没有这条（账号只在凭据文件里）：id 必须取合并后清单里的那一个 ——
      // 那是按**凭据键名**算的，重算 hash 会让迁移过来的账号换 id 读不到凭据
      const existing = listAccounts().find(entry => entry.uid === uid)
      entries.push({
        uid,
        id: existing?.id || accounts.accountId('trae', uid),
        name: existing?.name || uid,
        enabled: true,
        addedAt: now,
        ...patch,
      })
    } else {
      entries[index] = { ...entries[index], ...patch }
    }
    writeRegistry(entries)
  }

  // ── HTTP ──

  async function request(url, { method = 'GET', headers, body, signal, timeout = protocol.REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController()
    // timeout <= 0 表示**不限时**（对话流可能几十秒才收尾，由调用方的 signal 控制）
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

  // ── 凭据续期 ──

  const refreshing = new Map()

  async function refreshCredential(uid, { force = false } = {}) {
    if (refreshing.has(uid)) return refreshing.get(uid)
    const task = (async () => {
      const credential = accounts.getCredential(dataDir, 'trae', uid)
      if (!credential) throw new TraeError('账号凭据不存在', 'AUTH')
      if (!protocol.isRefreshable(credential)) throw new TraeError('账号没有 refresh_token，请重新登录', 'AUTH')
      const response = await request(`${protocol.OAUTH_HOST}${protocol.EXCHANGE_PATH}`, {
        method: 'POST',
        headers: protocol.oauthHeaders(),
        body: { ClientID: 'en1oxy7wnw8j9n', RefreshToken: credential.refresh_token, ClientSecret: '-', UserID: '' },
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        // 400/401/403 = 令牌真失效，需要重新登录；5xx = 上游抖动，留给下次
        const lapsed = [400, 401, 403].includes(response.status)
        throw new TraeError(
          `Trae 续期失败（HTTP ${response.status}）：${text.slice(0, 200)}`,
          lapsed ? 'AUTH' : 'TRANSPORT',
          response.status,
        )
      }
      const exchange = protocol.parseExchangeResponse(await response.json())
      if (!exchange) throw new TraeError('Trae 续期响应缺少 Token', 'AUTH')
      const next = protocol.applyRefresh(credential, exchange)
      accounts.setCredential(dataDir, 'trae', uid, next)
      return next
    })().finally(() => refreshing.delete(uid))
    refreshing.set(uid, task)
    return task
  }

  // 取一个可用于某模型的凭据：按注册表顺序，跳过停用/受限/无法续期的账号
  function usableAccounts(model, tried = new Set()) {
    const now = Date.now()
    const out = []
    for (const entry of listAccounts()) {
      if (entry.enabled === false) continue
      if (tried.has(entry.uid)) continue
      const until = rateLimits.get(`${entry.uid}::${model}`)
      if (until !== undefined && until > now) continue
      const credential = accounts.getCredential(dataDir, 'trae', entry.uid)
      if (!credential) continue
      out.push({ uid: entry.uid, credential })
    }
    return out
  }

  // 需要续期的判据：没有 access_token 或已过期。提前 5 分钟续，避免请求途中过期
  function needsRefresh(credential) {
    const expiresAt = protocol.credentialExpiresAtMs(credential)
    if (!credential.access_token) return true
    if (expiresAt === undefined) return false
    return expiresAt - Date.now() < 5 * 60 * 1000
  }

  async function resolveCredential(uid) {
    let credential = accounts.getCredential(dataDir, 'trae', uid)
    if (!credential) return undefined
    if (needsRefresh(credential) && protocol.isRefreshable(credential)) {
      try {
        credential = await refreshCredential(uid)
      } catch (error) {
        // 续期失败但令牌还没真的过期：先用旧令牌试一次（对齐渠道包的容错口径）
        if (!protocol.isExpired(credential)) {
          logger.warn?.(`[Trae] ${uid} 续期失败，沿用现有令牌：${error.message}`)
        } else {
          throw error
        }
      }
    }
    return credential
  }

  // ── 模型目录 ──

  async function fetchCatalog({ force = false } = {}) {
    if (!force && catalog.models.length > 0 && Date.now() - catalog.at < 10 * 60 * 1000) return catalog.models
    if (catalogFetching) return catalogFetching
    catalogFetching = (async () => {
      const owner = usableAccounts('')[0]
      if (!owner) {
        // 没有可用账号：目录为空是设计（未登录的渠道不播报模型），不是故障
        catalog = { models: [], at: Date.now() }
        channelOf.clear()
        return []
      }
      let credential
      try {
        credential = await resolveCredential(owner.uid)
      } catch (error) {
        logger.warn?.(`[Trae] 目录读取跳过：${error.message}`)
        return catalog.models
      }
      try {
        const response = await request(`${protocol.AGENT_HOST}${protocol.BATCH_MODELS_PATH}`, {
          method: 'POST',
          headers: protocol.soloHeaders(credential, false),
          body: {
            functions: protocol.ALL_FUNCTIONS,
            agent_type: '',
            current_config_info: { config_name: '', is_custom_model: false },
            mode_type: 0,
            access_type: 0,
            ab_force_vids: '',
            ab_autotest_advanced_mode: 0,
            show_custom_model: true,
          },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const models = protocol.parseBatchModelList(await response.json())
        if (models.length === 0) throw new Error('目录为空')
        channelOf.clear()
        for (const model of models) channelOf.set(model.id, model.channel)
        catalog = { models, at: Date.now() }
        return models
      } catch (error) {
        // 远端整体失败才用兜底表；**不覆盖**已有缓存
        logger.warn?.(`[Trae] 模型目录读取失败，使用兜底表：${error.message}`)
        if (catalog.models.length === 0) {
          const fallback = protocol.fallbackModels()
          channelOf.clear()
          for (const model of fallback) channelOf.set(model.id, model.channel)
          catalog = { models: fallback, at: Date.now() }
        }
        return catalog.models
      }
    })().finally(() => { catalogFetching = null })
    return catalogFetching
  }

  async function listModels() {
    const models = await fetchCatalog()
    return models.map(model => ({
      id: model.id,
      name: model.name,
      displayName: model.name,
      maxContext: model.contextWindow || 200000,
      maxOutput: model.maxOutputTokens,
      vision: model.multimodal === true,
      reasoning: model.reasoning && model.reasoning.efforts.length > 0
        ? { efforts: model.reasoning.efforts, defaultEffort: model.reasoning.defaultEffort }
        : undefined,
    }))
  }

  // ── 请求体转换（OpenAI → SOLO）──

  function buildBody(openAi, model) {
    const body = { ...openAi }
    delete body.stream_options
    delete body.reasoning_effort
    // 系统消息在 SOLO 里走 system 字段之外的位置也行：上游认 messages 里的 role
    const channel = channelOf.get(model) || protocol.DEFAULT_FUNCTION
    return protocol.transformToSolo(body, channel)
  }

  // ── SOLO SSE → AiRoute chunk ──

  // 把上游流逐事件转成内部 chunk。`onChunk` 由调用方提供。
  // 返回本轮是否吐过内容（决定能不能换号重发）。
  async function consumeSolo(response, { model, signal, onChunk }) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // SOLO 的事件是 `event: <name>` + `data: <json>` 两行一对，空行是事件结束
    let currentEvent = ''
    let currentData = ''
    let emitted = false
    const toolCalls = new Map()
    let usage
    let finishReason
    let sawDone = false

    const dispatch = () => {
      const name = currentEvent
      const data = currentData
      currentEvent = ''
      currentData = ''
      if (!name) return
      const parsed = protocol.parseSseEvent(name, data)
      if (parsed.error) {
        throw new TraeError(`Trae：${parsed.error.message}`, String(parsed.error.code), 502)
      }
      if (name === 'output') {
        if (parsed.reasoning) {
          emitted = true
          onChunk({ type: 'reasoning-delta', text: parsed.reasoning })
        }
        if (parsed.text) {
          emitted = true
          onChunk({ type: 'text-delta', text: parsed.text })
        }
        for (const call of parsed.toolCalls ?? []) {
          // ⚠️ Trae 把**同一个**工具调用拆成多帧下发，每帧只带参数字符串的一段
          // （实测 `{` 与 `"city":"北京"}` 分两帧），且并非每帧都带 id/name。
          // 必须按 index 合并 —— 否则一次工具调用会变成两个空参数调用。
          const index = typeof call.index === 'number' ? call.index : toolCalls.size
          let tool = toolCalls.get(index)
          if (!tool) {
            tool = { id: '', name: '', arguments: '' }
            toolCalls.set(index, tool)
          }
          const fn = call.function ?? call.function_call ?? {}
          if (call.id) tool.id = call.id
          if (fn.name) tool.name = fn.name
          const delta = typeof fn.arguments === 'string' ? fn.arguments : ''
          tool.arguments += delta
          emitted = true
          onChunk({
            type: 'tool-call-delta',
            index,
            ...tool.id ? { id: tool.id } : {},
            // 名字只在首次拿到时发：重复发会让客户端重建调用
            ...fn.name ? { name: fn.name } : {},
            argumentsDelta: delta,
          })
        }
      } else if (name === 'token_usage') {
        usage = parsed.usage
      } else if (name === 'done') {
        if (parsed.finishReason) finishReason = parsed.finishReason
        sawDone = true
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
          if (line === '') {
            dispatch()
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            currentData += line.slice(5).trim()
          }
          // 以 `:` 开头的注释行忽略
        }
        if (signal?.aborted) throw new TraeError('请求已取消', 'ABORTED', 499)
      }
      if (currentData.length > 0 || currentEvent.length > 0) dispatch()
    } finally {
      reader.releaseLock()
    }

    // 工具调用在收尾时统一发 block-end：增量帧已经把参数发完了，
    // block-end 只带拼好的完整参数给非流式聚合用
    for (const [index, call] of toolCalls) {
      onChunk({
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: call.id || `call_${index}_${Date.now().toString(36)}`,
          name: call.name || '',
          arguments: call.arguments || '{}',
        },
      })
    }
    if (usage) {
      // Trae 的用量口径：prompt_tokens / completion_tokens，缓存命中在 prompt_tokens_details
      onChunk({
        type: 'usage',
        usage: {
          inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
          cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0,
          cacheWriteTokens: 0,
          totalTokens: usage.total_tokens,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        },
      })
    }
    const reason = finishReason === 'tool_calls' || toolCalls.size > 0
      ? 'tool-calls'
      : finishReason === 'length'
        ? 'max-tokens'
        : finishReason === 'error'
          ? 'error'
          : sawDone || emitted
            ? 'stop'
            : 'error'
    onChunk({ type: 'finish', reason: { kind: reason } })
    return { emitted }
  }

  // ── 补全 ──

  async function complete({ model, openAi }, onChunk, signal) {
    // 模型名可能带 `__dev` 之类的后缀，目录里存的是干净名
    const bare = String(model || '').replace(/^trae\//, '')
    const candidates = usableAccounts(bare)
    if (candidates.length === 0) {
      const any = usableAccounts('')
      if (any.length === 0) throw new TraeError('Trae 没有可用账号，请先登录', 'AUTH', 401)
      throw new TraeError(`Trae 的账号都在 ${bare} 上受限，请稍后再试`, 'QUOTA_EXCEEDED', 429)
    }

    const tried = new Set()
    let lastError
    for (const candidate of candidates.slice(0, MAX_ROTATE)) {
      tried.add(candidate.uid)
      let credential = candidate.credential
      try {
        credential = await resolveCredential(candidate.uid)
        const body = buildBody({ ...openAi, model: bare }, bare)
        let response = await request(`${protocol.AGENT_HOST}${protocol.CHAT_PATH}`, {
          method: 'POST',
          headers: protocol.soloHeaders(credential, true),
          body,
          signal,
          // 对话流可能很久才回第一个字节，不设总超时（由调用方的 signal 控制）
          timeout: 0,
        })
        if (response.status === 401 || response.status === 403) {
          credential = await refreshCredential(candidate.uid)
          response = await request(`${protocol.AGENT_HOST}${protocol.CHAT_PATH}`, {
            method: 'POST',
            headers: protocol.soloHeaders(credential, true),
            body,
            signal,
            timeout: 0,
          })
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          const status = response.status
          lastError = new TraeError(`Trae：${text.slice(0, 300) || `HTTP ${status}`}`, 'HTTP_ERROR', status)
          if (status === 429) {
            rateLimits.set(`${candidate.uid}::${bare}`, Date.now() + RATE_LIMIT_FALLBACK_MS)
            continue
          }
          throw lastError
        }
        return await consumeSolo(response, { model: bare, signal, onChunk })
      } catch (error) {
        if (signal?.aborted) throw error
        // 流内可换号错误：只有**还没吐内容**时才换号（吐了一半重放会重复计费）
        const rotatable = error instanceof TraeError && protocol.ROTATABLE_STREAM_ERRORS.has(Number(error.code))
        if (rotatable) {
          rateLimits.set(`${candidate.uid}::${bare}`, Date.now() + RATE_LIMIT_FALLBACK_MS)
          lastError = error
          continue
        }
        // 认证失效：换下一个账号（同一个号没有第二次机会）
        if (error instanceof TraeError && error.code === 'AUTH') {
          lastError = error
          continue
        }
        throw error
      }
    }
    throw lastError instanceof TraeError
      ? lastError
      : new TraeError(lastError?.message || 'Trae：所有账号均不可用', 'HTTP_ERROR', 502)
  }

  // ── 登录 ──

  // 起一次登录：返回登录 URL 与 state。回调由本地 HTTP 服务接收（shared/login-server）。
  async function startLogin() {
    const machineId = protocol.generateMachineId()
    const deviceId = protocol.generateDeviceId()
    const state = accounts.randomSuffix()
    const callback = await loginServer.start({
      provider: 'trae',
      state,
      onCallback: async (rawUrl) => {
        const parsed = protocol.parseCallback(rawUrl)
        if (!parsed.ok) throw new Error(parsed.reason)
        const credential = await exchangeCallback(parsed.info, { machineId, deviceId })
        const uid = credential.uid
        accounts.setCredential(dataDir, 'trae', uid, credential)
        updateAccount(uid, { name: protocol.displayName(credential, accounts.accountId('trae', uid)), enabled: true, addedAt: Date.now() })
        await fetchCatalog({ force: true })
        return 'Trae 登录成功，可以关闭此页面回到 AiRoute'
      },
    })
    logins.set(state, { machineId, deviceId, createdAt: Date.now() })
    // start() 返回的是 { callbackUrl, wait }，回调地址要从 callbackUrl 里取：
    // 直接把整个对象拼进 URL 会得到 auth_callback_url=[object Object]，
    // Trae 登录页拿不到回调地址，会永远停在「认证中」
    return { loginUrl: protocol.buildLoginUrl(machineId, deviceId, callback.callbackUrl), state }
  }

  // 用回调里的 refreshToken 换 access token，再补一次用户信息
  async function exchangeCallback(info, session) {
    let exchange
    if (info.refreshToken.length > 0) {
      const response = await request(`${protocol.OAUTH_HOST}${protocol.EXCHANGE_PATH}`, {
        method: 'POST',
        headers: protocol.oauthHeaders(),
        body: { ClientID: 'en1oxy7wnw8j9n', RefreshToken: info.refreshToken, ClientSecret: '-', UserID: '' },
      })
      if (!response.ok) throw new Error(`Trae 换取令牌失败（HTTP ${response.status}）`)
      exchange = protocol.parseExchangeResponse(await response.json())
      if (!exchange) throw new Error('Trae 换取令牌的响应里没有 Token')
    } else {
      // 没有 refreshToken 时只能用回调里的 access token 兜底
      exchange = { accessToken: info.accessToken, refreshToken: '', tokenExpireAt: 0, tokenExpireDuration: 0 }
    }
    let userInfo = { uid: info.uid, screenName: info.nickname, enterpriseId: info.enterpriseId, phone: '', email: '' }
    try {
      const headers = protocol.oauthHeaders()
      headers['X-Cloudide-Token'] = exchange.accessToken
      const response = await request(`${protocol.OAUTH_HOST}${protocol.USER_INFO_PATH}`, {
        method: 'POST',
        headers,
        body: { ReqSource: 'IDE', IDEVersion: protocol.IDE_VERSION },
      })
      if (response.ok) {
        const fetched = protocol.parseUserInfo(await response.json())
        if (fetched) {
          userInfo = {
            uid: fetched.uid || userInfo.uid,
            screenName: fetched.screenName || userInfo.screenName,
            enterpriseId: fetched.enterpriseId || userInfo.enterpriseId,
            phone: fetched.phone,
            email: fetched.email,
          }
        }
      }
    } catch { /* 容错：沿用回调里的用户信息 */ }
    if (!userInfo.uid) throw new Error('Trae 未能确定账号 uid')
    return protocol.buildCredential(exchange, userInfo, session)
  }

  // ── 账号运维 ──

  // 签到。三条约束（每条都对应一类真实故障，字段形状见 protocol.js 的 parse* 注释）：
  //   ① 先查 status 判「今天签过没」——claim 对已签到是幂等的，重复领也回 code 0；
  //   ② claim 响应不含金额，领完要回 status 取 credits；
  //   ③ 业务码要分类：1005 未开通 / 9074 稍后再试 / 1001 要重新登录，都不能报成功。
  //
  // 每条「今天已经签过」的路径都要落盘 lastCheckinDay：面板靠它把按钮置灰。
  // 少记一处，用户第二天就会看到一个点下去只回「今天已签过」的按钮。
  async function checkin(uid) {
    const credential = await resolveCredential(uid)
    const headers = protocol.checkinHeaders(credential)
    const status = await request(`${protocol.UG_HOST}${protocol.CHECKIN_STATUS_PATH}`, {
      method: 'POST', headers, body: {},
    })
    if (!status.ok) throw new TraeError(`签到状态查询失败（HTTP ${status.status}）`, 'HTTP_ERROR', status.status)
    const before = protocol.parseCheckinStatus(await status.json().catch(() => ({})))
    if (before.code === protocol.CHECKIN_CODE_AUTH) {
      throw new TraeError('Trae 签到鉴权失败，请重新登录', 'AUTH', 401)
    }
    if (before.checkedIn) {
      // 上游只说「今天签过了」，没说是什么时候签的：别把 lastCheckinAt 写成此刻
      noteCheckinDone(uid, { stampAt: false })
      return { outcome: 'done' }
    }
    // 活动未开启（免费 / 企业套餐）：不是失败，如实说「未开通」，免得天天报红
    if (!before.enabled) return { outcome: 'ineligible', message: '该账号未开通签到活动' }

    const claim = await request(`${protocol.UG_HOST}${protocol.CHECKIN_CLAIM_PATH}`, {
      method: 'POST', headers, body: {},
    })
    const claimed = protocol.parseClaimResponse(await claim.json().catch(() => ({})))
    if (!claim.ok) throw new TraeError(`签到失败（HTTP ${claim.status}）`, 'HTTP_ERROR', claim.status)
    if (!claimed.ok) {
      if (claimed.code === protocol.CHECKIN_CODE_AUTH) {
        throw new TraeError('Trae 签到鉴权失败，请重新登录', 'AUTH', 401)
      }
      if (claimed.code === protocol.CHECKIN_CODE_PLAN_LIMIT) {
        return { outcome: 'ineligible', message: claimed.message || '当前套餐不参与签到' }
      }
      // 9074「签到人数过多」也走这里：可重试的失败，不要报成成功
      return { outcome: 'failed', message: claimed.message || `签到失败（code=${claimed.code}）` }
    }

    // 领到了才记「今天签过」。失败的路径不记：否则按钮会置灰一整天，
    // 用户明明没签成却再也点不动
    noteCheckinDone(uid)

    // 领取成功但响应里没有金额：回 status 取「今天这一签值多少」。
    // 取不到就**不带 credit**（界面显示「未返回」），不要编一个 0 出来
    const after = await request(`${protocol.UG_HOST}${protocol.CHECKIN_STATUS_PATH}`, {
      method: 'POST', headers, body: {},
    })
    const gained = after.ok ? protocol.parseCheckinStatus(await after.json().catch(() => ({}))) : undefined
    const credit = gained?.credits
    return { outcome: 'claimed', ...credit > 0 ? { credit } : {} }
  }

  // 余额 = Σ(资源包上限 - 已用)，见 protocol.parseCreditBalance。
  // 请求体带 require_usage 才回 usage（缺了它只有额度上限，算不出剩余）
  async function balance(uid) {
    const credential = await resolveCredential(uid)
    const response = await request(`${protocol.UG_HOST}${protocol.ENT_USAGE_PATH}`, {
      method: 'POST',
      headers: protocol.checkinHeaders(credential),
      body: { require_usage: true, req_source: 2 },
    })
    if (!response.ok) throw new TraeError(`积分余额查询失败（HTTP ${response.status}）`, 'HTTP_ERROR', response.status)
    return protocol.parseCreditBalance(await response.json().catch(() => ({})))
  }

  function importLegacy(entry) {
    // 渠道包迁移过来的账号：凭据文件里已经在了，这里只补注册表条目。
    // id 用凭据键里的那 8 位，面板上的账号才不会在迁移前后换一个名字
    const suffix = entry.suffix || accounts.accountSuffix('trae', entry.uid)
    updateAccount(entry.uid, {
      id: `trae-${suffix}`,
      name: protocol.displayName(entry.credential, `trae-${suffix}`),
      enabled: true,
      addedAt: entry.addedAt ?? 0,
    })
    return listAccounts().length
  }

  function removeAccount(uid) {
    accounts.removeCredential(dataDir, 'trae', uid)
    writeRegistry(readRegistry().filter(entry => entry.uid !== uid))
    notify()
  }

  async function shutdown() {
    logins.clear()
    catalog = { models: [], at: 0 }
    channelOf.clear()
    rateLimits.clear()
  }

  return {
    providers: PROVIDERS,
    listAccounts: accountEntries,
    updateAccount: (uid, patch) => updateAccount(uid, patch),
    listModels,
    complete,
    startLogin,
    removeAccount,
    importLegacy,
    checkin,
    balance,
    refresh: () => fetchCatalog({ force: true }),
    refreshAccount: uid => refreshCredential(uid),
    shutdown,
    // 仅供测试
    setEvents(handlers) {
      Object.assign(events, handlers)
    },
  }
}

module.exports = { createTrae, PROVIDERS, CREDENTIAL_PREFIX, TraeError }
