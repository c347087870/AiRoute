// Qoder 渠道：设备码登录、续期、目录、加密补全、每日领取
//
// 与 Trae 同构（没有 cordis ctx、没有 LLM 适配器栈），差异只在协议：
//   - 登录是**设备码轮询**（不是本地回调）：用户在网页确认后，我们轮询 openApi 取令牌；
//   - 补全走 **WASM 加密端点**，请求体的加密与签名由 qoder-auth-wasm 完成；
//   - 响应的 SSE 多一层信封，先剥掉才是标准 OpenAI 帧。
//
// 国际版（qoder.com）与国内版（qoder.cn）是**两套独立凭据**，但协议同形，
// 所以共用本文件，差别全在 protocol.PRODUCTS 里。
//
// ## 账号池的三层（失败治理的顺序很重要）
//
//   · 选号：会话亲和 > 轮转 > 清单顺序。亲和是为了吃上游 prompt 缓存 ——
//     同一段对话换号，上游看到的是「另一台设备上的另一段对话」，缓存全丢；
//   · 冷却：429/额度类只冷却一个短窗口（默认 60 秒），不再一锁一小时。
//     上游 429 绝大多数是「这一分钟的并发超了」，锁一小时等于把好号也钉死；
//   · 并发：同一账号默认只允许 1 个在途请求（上游对单号并发极敏感）。
//
// 这三层都可以在面板「渠道设置」里关掉回到旧行为（见 settings.js 的默认值）。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const protocol = require('./protocol')
const { QoderEncryptedInfer } = require('./wasm')

const PROVIDERS = ['qoder', 'qodercn']

// 排队等待预算：单次等待夹在 [1s, 120s]，整轮最多重发 2 次（上游要求按
// retryAfterSeconds 耐心等，但也不能让客户端无限挂着 —— 超过预算按 429 报出去）
const QUEUE_MAX_ATTEMPTS = 2

// 会话亲和与 session_id 的存活时间：覆盖一次典型的多轮对话即可
const AFFINITY_TTL_MS = 2 * 3600 * 1000

// 历史里工具结果的保留长度（首尾各留这么多字符，中间换成固定省略串）。
// 固定串很关键：同一段历史每次请求都要逐字节一致，否则上游前缀缓存从被削处失效。
const TOOL_RESULT_KEEP = 2000
const TOOL_RESULT_MARKER = '\n…（历史工具结果已省略）…\n'

// 发送前的体积上限。上游前置的是 30MB 硬限（超限直接 RST，表现为不定时断流），
// 本地先拦下来还能给客户端一个可读的 413。
const MAX_BODY_BYTES = 28 * 1024 * 1024

// 业务错误 → 带状态码的 Error：渠道包不挂 statusCode，路由层只能一律回落 502，
// 于是「额度用完」「参数不对」「排了一分钟队」在客户端看起来都是网关故障。
function httpError(message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode }, extra)
}

// 工具定义归一：flat 形态（顶层 name）包成 function；不认识的类型明确丢弃
function buildTools(tools) {
  if (!Array.isArray(tools)) return { tools: [], dropped: 0 }
  const out = []
  let dropped = 0
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const fn = tool.function && typeof tool.function === 'object'
      ? tool.function
      : typeof tool.name === 'string' ? tool : null
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) {
      dropped++
      continue
    }
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      },
    })
  }
  return { tools: out, dropped }
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

// 历史工具结果削减：首尾保留、中间换成固定省略串。
// 不削会让长会话的 token 线性膨胀；每轮改写成不同内容又会打掉上游前缀缓存。
function shrinkToolText(text) {
  const value = String(text ?? '')
  if (value.length <= TOOL_RESULT_KEEP * 2 + TOOL_RESULT_MARKER.length) return value
  return value.slice(0, TOOL_RESULT_KEEP) + TOOL_RESULT_MARKER + value.slice(-TOOL_RESULT_KEEP)
}

// 消息 → 上游 history。
//
// 三条判据：
//   1. developer 归一到 system（上游只认 system/user/assistant，其余角色会被 400）；
//   2. assistant 的 reasoning_content 要回填 —— DeepSeek 族多轮缺它会偶发失败；
//   3. 工具调用必须能配对：缺 tool_call_id 的 tool 消息不能丢掉（丢了模型会以为
//      工具没执行），而是折成一条 user 文本；缺 id 的调用补一个本地 id 并记下来，
//      这样后续 tool 消息才找得到它。
function buildHistory(messages) {
  const out = []
  const knownCallIds = new Set()
  let patchedIds = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role === 'tool' ? 'tool'
      : message.role === 'assistant' ? 'assistant'
        : message.role === 'system' || message.role === 'developer' ? 'system'
          : 'user'
    if (role === 'system') continue // system 单独走 systemText

    if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      const text = shrinkToolText(textOf(message.content) || String(message.content ?? ''))
      if (callId && knownCallIds.has(callId)) {
        out.push({ role: 'tool', content: text, tool_call_id: callId })
      } else {
        // 找不到配对（客户端截断历史、或上游换了 id）：折成用户可见文本，别静默丢
        out.push({ role: 'user', content: `[工具结果]\n${text}` })
      }
      continue
    }

    const entry = { role, content: typeof message.content === 'string' ? message.content : message.content ?? '' }
    if (role === 'assistant') {
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        entry.reasoning_content = message.reasoning_content
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        entry.tool_calls = message.tool_calls.map((call, index) => {
          const id = call.id || `call_local_${index}`
          if (!call.id) patchedIds++
          knownCallIds.add(id)
          return {
            id,
            type: 'function',
            index,
            function: {
              name: call.function?.name || '',
              arguments: call.function?.arguments || '{}',
            },
          }
        })
      }
    }
    out.push(entry)
  }
  return { history: out, patchedIds }
}

// 会话指纹：system + 首条 user 决定「这是哪段对话」。
// 只用最后一条 user 会把同一对话的每一轮都算成新会话；不看 system 会让两段
// 客户端配置不同的对话共用账号。
function affinityKey(openAi) {
  const messages = Array.isArray(openAi?.messages) ? openAi.messages : []
  const system = messages.filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => textOf(message.content)).join('\n').slice(0, 400)
  const firstUser = messages.find(message => message.role === 'user')
  const anchor = textOf(firstUser?.content).slice(0, 400)
  if (!system && !anchor) return ''
  return `${system}\u0000${anchor}`
}

// 业务错误帧 → Error；排队（10605）单独标出来，调用方据此等待后重发。
//
// ⚠️ 排队不能按「普通失败」快退避重试：服务端明确要求等 `retryAfterSeconds`
// （实测 30 秒），按 500ms→8s 的指数退避永远等不到，表现就是「偶尔能用」。
// 也不能把它当认证失败去续期 —— 那会白换一次令牌再撞同一堵墙。
function queueOrError(data) {
  const info = protocol.parseQueueInfo(data) ?? protocol.parseQueueInfo(data?.message)
  if (info || String(data.code) === '10605') {
    const seconds = Number(info?.retryAfterSeconds ?? info?.waitTime ?? 30)
    const error = new Error(`Qoder 排队中，${seconds} 秒后重试`)
    error.code = 'QUEUED'
    // 排队不是账号故障：报 429 + Retry-After，客户端能据此退避，也不需要冷却账号
    error.statusCode = 429
    error.retryAfterMs = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 120) * 1000 : 30000
    return error
  }
  const message = typeof data.message === 'string' && data.message.length < 200
    ? data.message
    : JSON.stringify(data.message)
  return new Error(`Qoder：${message}`)
}

// 429 / 额度类 403 的判据：这些不该一锁一小时，也不该反复挑同一个号
const QUOTA_RE = /pricingUrl|insufficient|quota|exceed|余额|额度/i
function isQuotaDenied(status, text) {
  return status === 429 || (status === 403 && QUOTA_RE.test(String(text || '')))
}

// 人工可读的上游错误：把状态码带回去，别让路由层回落成 502
function upstreamError(product, status, text, extra = {}) {
  const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 300)
  const message = `${product.displayName}：${detail || `HTTP ${status}`}`
  return httpError(message, status >= 500 ? 502 : status, extra)
}

// credentials 由宿主注入（见 plugin-api.js）
function createQoder({ dataDir, logger = console, credentials, settings, versions }) {
  if (!credentials) throw new Error('Qoder 插件缺少凭据服务（credentials）')
  const accounts = credentials
  // 运行参数：缺省全部回落成「改造前的行为」，见 settings.js
  // 按渠道取设置：qoder 与 qodercn 各自独立（channel-settings.json 的 providers.<id>）
  const cfg = providerId => (typeof settings?.forProvider === 'function'
    ? settings.forProvider(providerId || 'qoder')
    : (typeof settings?.get === 'function' ? settings.get() : {}))
  // 每个账号一个加密客户端（WASM 上下文有状态，不能跨账号复用）
  const clients = new Map()
  const refreshing = new Map()
  // 账号冷却：uid → 解封时间（429 / 额度类，窗口由设置决定）
  const cooldowns = new Map()
  // 会话亲和：对话指纹 → { uid, expiresAt }
  const affinity = new Map()
  // 会话 id：对话指纹 → { id, expiresAt }。上游按 session_id 做前缀缓存，
  // 同一段对话的第二轮换了 id 就等于换了一段对话
  const sessions = new Map()
  // 轮转游标：provider → 下一个起始下标
  const rotation = new Map()
  // 单账号并发闸门：uid → { active, waiters }
  const gates = new Map()
  const logins = new Map()
  // 账号级今日 token：uid → { day, total }。内存账本（进程重启清零），与
  // WorkBuddy 池的 tokenUsageToday 同口径；跨零点自然归零，不落盘
  const tokenToday = new Map()
  // 每日领取的能力探测结果：provider → { supported, until, reason }
  const checkinProbe = new Map()

  const maxOutputFile = path.join(dataDir, 'qoder-max-output.json')
  const machineFile = path.join(dataDir, 'qoder-machine.json')

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

  // ── 安装盐：machine_id 的派生种子 ──
  //
  // 同一台机器、同一个账号永远是同一台「设备」；删号重登不该换设备，
  // 否则上游看到的是一台机器上冒出一堆新设备（最容易被聚类的特征）。
  function installSalt() {
    try {
      const parsed = JSON.parse(fs.readFileSync(machineFile, 'utf8'))
      if (typeof parsed?.salt === 'string' && parsed.salt.length > 0) return parsed.salt
    } catch { /* 首次运行 */ }
    const salt = crypto.randomUUID()
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(machineFile, JSON.stringify({ salt }, null, 2), { mode: 0o600 })
    } catch (error) {
      logger.warn?.(`[qoder] 安装盐写入失败：${error.message}`)
    }
    return salt
  }

  // ── 目录 ──

  function learnedMaxOutput(provider, model) {
    try {
      const parsed = JSON.parse(fs.readFileSync(maxOutputFile, 'utf8'))
      const entry = parsed?.[`${provider}/${model}`]
      if (!entry || typeof entry.max !== 'number') return undefined
      if (typeof entry.until === 'number' && entry.until < Date.now()) return undefined
      return entry.max
    } catch {
      return undefined
    }
  }

  // 从 400 的报错文案里学「这个模型允许的最大输出」，落盘 7 天。
  // 不学的话每个客户端都要自己踩一次 400（而且换客户端就重踩）。
  function learnMaxOutput(provider, model, text) {
    const match = String(text || '').match(/max_tokens[^\[]{0,40}\[\s*1\s*,\s*(\d{3,7})\s*\]/i)
    if (!match) return
    const max = Number(match[1])
    if (!Number.isFinite(max) || max < 64) return
    let parsed = {}
    try {
      parsed = JSON.parse(fs.readFileSync(maxOutputFile, 'utf8')) || {}
    } catch { /* 首次 */ }
    parsed[`${provider}/${model}`] = { max, until: Date.now() + 7 * 24 * 3600 * 1000 }
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(maxOutputFile, JSON.stringify(parsed, null, 2))
      logger.info?.(`[qoder] 学到 ${provider}/${model} 的输出上限：${max}`)
    } catch (error) {
      logger.warn?.(`[qoder] 输出上限落盘失败：${error.message}`)
    }
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
      const next = { ...entries[index], ...patch }
      // 用户手动「启用」= 认为号还能用：把「官方禁用」标记一并清掉，
      // 否则勾上启用也永远选不到它
      if (patch.enabled === true) {
        delete next.officialDisabled
        delete next.officialDisabledReason
        delete next.officialDisabledAt
      }
      entries[index] = next
    }
    writeRegistry(provider, entries)
    notify()
  }

  // 国际版出现「排队中」（10605）= 官方已把这个号放进禁用队列，实测不会自愈。
  // 打持久标记并从选号里剔除，免得每个请求都白等 30 秒×2。
  function markOfficialDisabled(provider, uid, reason) {
    if (provider !== 'qoder') return
    try {
      updateAccount(provider, uid, {
        officialDisabled: true,
        officialDisabledReason: String(reason || '上游排队（10605）：账号已被官方禁用').slice(0, 200),
        officialDisabledAt: Date.now(),
      })
      logger.warn?.(`[qoder] ${provider}/${uid} 出现排队 → 标记为「官方禁用」`)
    } catch (error) {
      logger.warn?.(`[qoder] 标记 ${uid} 官方禁用失败：${error.message}`)
    }
  }

  // 上游明确说令牌死了（401/403 + TOKEN_EXPIRE）才停用：
  // 不停用的话每个请求都要白撞一次 401 再换号，而且面板上看不出是哪个号坏了。
  function disableAccount(provider, uid, reason) {
    try {
      updateAccount(provider, uid, { enabled: false, lastError: String(reason || '').slice(0, 200), lastErrorAt: Date.now() })
      logger.warn?.(`[qoder] ${provider}/${uid} 已停用：${reason}`)
    } catch (error) {
      logger.warn?.(`[qoder] 停用 ${uid} 失败：${error.message}`)
    }
  }

  function accountEntries(provider) {
    const now = Date.now()
    return listAccounts(provider).map(entry => {
      const credential = accounts.getCredential(dataDir, provider, entry.uid)
      const until = cooldowns.get(entry.uid)
      return {
        ...entry,
        name: credential ? protocol.displayName(credential, entry.name) : entry.name,
        refreshable: credential ? protocol.isRefreshable(credential) : false,
        expiresAt: credential ? protocol.credentialExpiresAtMs(credential) ?? 0 : 0,
        expired: credential ? protocol.isExpired(credential) : true,
        hasCredential: credential !== undefined,
        // 今日已用 token（账号级，见 tokenToday 的说明）
        tokenUsageToday: tokenUsageTodayOf(entry.uid),
        // 冷却到什么时候（面板可显示「限流中」，避免用户以为号坏了）
        ...until !== undefined && until > now ? { coolingUntil: until } : {},
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
      if (!credential) throw httpError('账号凭据不存在', 401)
      if (!protocol.isRefreshable(credential)) throw httpError('账号没有 refresh_token，请重新登录', 401)
      const response = await request(`${product.openApiBase}${protocol.REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': `${product.userAgentPrefix}/1.0.0`,
        },
        body: protocol.refreshBody(credential),
      })
      const text = await response.clone().text().catch(() => '')
      // 401/403 = 续期令牌真失效；其余（5xx、429）是可重试的瞬时失败
      if (response.status === 401 || response.status === 403) {
        disableAccount(provider, uid, `续期被拒绝（HTTP ${response.status}），需要重新登录`)
        throw httpError(`Qoder 续期被拒绝（HTTP ${response.status}），请重新登录`, 401, { code: 'AUTH' })
      }
      const parsed = await response.json().catch(() => undefined)
      if (!response.ok) throw httpError(`Qoder 续期失败（HTTP ${response.status}）${text ? `：${text.slice(0, 120)}` : ''}`, 502)
      const payload = protocol.parseTokenPayload(parsed)
      if (!payload.accessToken) {
        disableAccount(provider, uid, '续期响应缺少访问令牌')
        throw httpError('续期响应缺少访问令牌，请重新登录', 401, { code: 'AUTH' })
      }
      const next = protocol.applyRefresh(credential, payload)
      // 官方可能不给新的过期时间：沿用旧值，而不是把 expire_time 抹成 undefined
      if (next.expire_time === undefined && credential.expire_time !== undefined) next.expire_time = credential.expire_time
      accounts.setCredential(dataDir, provider, uid, next)
      // 令牌变了，加密客户端的鉴权字段也要重建
      clients.delete(key)
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
        // 有明确 AUTH 结论就不再用旧令牌（它已经被上游判死了）
        if (error?.code === 'AUTH' || protocol.isExpired(credential)) throw error
        logger.warn?.(`[qoder] ${uid} 续期失败，沿用现有令牌：${error.message}`)
      }
    }
    return credential
  }

  // ── 账号池：冷却 / 并发 / 选号 ──

  function coolingUntil(uid) {
    const until = cooldowns.get(uid)
    return until !== undefined && until > Date.now() ? until : 0
  }

  function noteCooldown(uid, ms) {
    const window = Math.max(1000, Number(ms) || 0)
    const until = Date.now() + window
    if ((cooldowns.get(uid) || 0) < until) cooldowns.set(uid, until)
  }

  // 单账号并发闸门：默认 1。拿不到就排队，但排队要能被 signal 打断 ——
  // 客户端的「停止」不该被一个等锁的请求卡住。
  function acquireSlot(uid, signal, providerId) {
    const limit = Number(cfg(providerId).maxConcurrency) || 0
    if (limit <= 0) return Promise.resolve(() => {})
    const gate = gates.get(uid) || { active: 0, waiters: [] }
    gates.set(uid, gate)
    const minGap = Number(cfg(providerId).minGapMs) || 0

    const grant = resolve => {
      gate.active++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        gate.active--
        const next = gate.waiters.shift()
        if (next) setTimeout(() => next.run(), minGap)
      })
    }

    return new Promise(resolve => {
      const run = () => {
        if (signal?.aborted) {
          resolve(() => {})
          return
        }
        grant(resolve)
      }
      if (gate.active < limit) {
        if (minGap > 0) setTimeout(run, minGap)
        else run()
      } else {
        gate.waiters.push({ run })
        signal?.addEventListener('abort', () => {
          const index = gate.waiters.findIndex(item => item.run === run)
          if (index !== -1) gate.waiters.splice(index, 1)
          resolve(() => {})
        }, { once: true })
      }
    })
  }

  function usableEntries(provider) {
    return listAccounts(provider).filter(entry => entry.enabled !== false
      // 官方禁用的号不再参与选号：它的每一次请求都只会换回「排队中」
      && entry.officialDisabled !== true
      && accounts.getCredential(dataDir, provider, entry.uid) !== undefined)
  }

  // 选号顺序：亲和命中 > 轮转起点 > 清单顺序。冷却中的号排到最后而不是直接剔除 ——
  // 全部在冷却时「试一下」比「立刻报 429」更接近用户预期。
  function orderCandidates(provider, openAi) {
    const settingsNow = cfg(provider)
    const entries = usableEntries(provider)
    const now = Date.now()
    const key = settingsNow.affinity === false ? '' : affinityKey(openAi)
    const recall = key && sessions.has(key) && sessions.get(key).expiresAt > now ? key : ''
    const preferred = recall ? affinity.get(recall) : undefined
    const preferredUid = preferred && preferred.expiresAt > now ? preferred.uid : ''

    let ordered = entries
    if (!preferredUid && settingsNow.rotation !== false && entries.length > 1) {
      const start = (rotation.get(provider) || 0) % entries.length
      ordered = [...entries.slice(start), ...entries.slice(0, start)]
      rotation.set(provider, (start + 1) % entries.length)
    } else if (preferredUid) {
      const hit = entries.find(entry => entry.uid === preferredUid)
      if (hit) ordered = [hit, ...entries.filter(entry => entry.uid !== preferredUid)]
    }

    const ready = ordered.filter(entry => coolingUntil(entry.uid) === 0)
    const cooling = ordered.filter(entry => coolingUntil(entry.uid) !== 0)
    return { list: [...ready, ...cooling], affinityKey: recall }
  }

  // ── 目录 ──

  // Qoder 的目录端点需要 WASM 签名，成本高且不稳定；目录以产品兜底表为准
  // （与渠道包同一口径：线上模型列表走兜底表，客户端目录只用于离线核对）。
  function listModels(provider) {
    const product = protocol.PRODUCTS[provider]
    return product.models.map(model => {
      const learned = learnedMaxOutput(provider, model.id)
      return {
        id: model.id,
        name: model.name,
        displayName: model.name,
        maxContext: model.contextWindow || 200000,
        maxOutput: learned,
        vision: model.supportsImage === true,
        isFree: model.isFree === true,
        reasoning: model.efforts && model.efforts.length > 0
          ? { efforts: model.efforts, defaultEffort: model.defaultEffort }
          : undefined,
      }
    })
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
      // 官方客户端版本号：写死会在官方抬版本后被判版本过低（430），
      // 这里允许用环境变量临时改，不必发版
      clientVersion: process.env.AIROUTE_QODER_CLIENT_VERSION || undefined,
    })
    clients.set(key, client)
    return client
  }

  // 会话 id：同一段对话复用同一个，上游据此命中前缀缓存
  function sessionIdFor(key) {
    if (!key) return undefined
    const now = Date.now()
    const hit = sessions.get(key)
    if (hit && hit.expiresAt > now) {
      hit.expiresAt = now + AFFINITY_TTL_MS
      return hit.id
    }
    const id = crypto.randomUUID()
    sessions.set(key, { id, expiresAt: now + AFFINITY_TTL_MS })
    return id
  }

  // ── 补全 ──

  // 思考档位归一：客户端可能给 xhigh / none / 中文……上游只认目录里的档位。
  // 不归一时上游会「静默改默认档」，用户以为选了 max 其实没生效。
  function normalizeEffort(raw, meta) {
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const value = raw.trim().toLowerCase()
    if (value === 'none' || value === 'off' || value === 'disabled') return 'none'
    const efforts = meta?.efforts
    if (!Array.isArray(efforts) || efforts.length === 0) return undefined
    if (efforts.includes(value)) return value
    return meta?.defaultEffort || efforts[0]
  }

  // 本次请求的 ask（加密前的明文参数）。抽出来是为了「重试要重签」时能重算。
  function buildAsk(provider, bare, openAi, meta, sessionKey) {
    const messages = Array.isArray(openAi.messages) ? openAi.messages : []
    const systemMessage = messages.find(message => message.role === 'system' || message.role === 'developer')
    const lastUser = [...messages].reverse().find(message => message.role === 'user')
    const userText = textOf(lastUser?.content)
    const { history, patchedIds } = buildHistory(messages.filter(message => message.role !== 'system' && message.role !== 'developer'))
    if (patchedIds > 0) logger.info?.(`[qoder] 历史里有 ${patchedIds} 个工具调用缺 id，已补本地 id`)
    const isReasoning = Array.isArray(meta?.efforts) && meta.efforts.length > 0
    const effort = normalizeEffort(openAi.reasoning_effort, meta)
    const { tools, dropped } = buildTools(openAi.tools)
    if (dropped > 0) logger.warn?.(`[qoder] 丢弃了 ${dropped} 个形状不认识的工具定义`)

    // 输出上限：客户端给的值先按「学到的上限」夹一次；没客户端值就不下发
    const rawMax = typeof openAi.max_tokens === 'number' ? openAi.max_tokens
      : typeof openAi.max_completion_tokens === 'number' ? openAi.max_completion_tokens
        : undefined
    const learned = learnedMaxOutput(provider, bare)
    const maxTokens = rawMax === undefined ? undefined : (learned ? Math.min(rawMax, learned) : rawMax)
    if (rawMax !== undefined && maxTokens !== rawMax) {
      logger.info?.(`[qoder] max_tokens ${rawMax} → ${maxTokens}（按学到的输出上限夹）`)
    }

    return {
      modelKey: bare,
      userText,
      ...systemMessage ? { systemText: textOf(systemMessage.content) } : {},
      isReasoning,
      history,
      tools,
      ...maxTokens === undefined ? {} : { maxTokens },
      ...effort ? { reasoningEffort: effort } : {},
      ...meta ? { isVl: meta.supportsImage === true, displayName: meta.name, maxInputTokens: meta.maxInputTokens || meta.contextWindow } : {},
      ...sessionKey ? { sessionId: sessionIdFor(sessionKey) } : {},
      // business 必填：缺了服务端会把请求路由到故障节点
      business: { type: 'agent' },
    }
  }

  async function complete({ provider, model, openAi }, onChunk, signal) {
    const product = protocol.PRODUCTS[provider]
    if (!product) throw httpError(`未知的 Qoder 渠道：${provider}`, 404)
    // 客户端可能填展示名（Qwen3.8-Max）或历史别名：上游只认目录 key
    const bare = protocol.resolveModelKey(provider, model)
    if (!bare) throw httpError(`${product.displayName} 没有模型 ${model}`, 404)
    const meta = modelOf(provider, bare)
    if (!meta) throw httpError(`${product.displayName} 没有模型 ${model}`, 404)

    const { list: candidates, affinityKey: sessionKey } = orderCandidates(provider, openAi)
    if (candidates.length === 0) {
      if (usableEntries(provider).length === 0) {
        // 区分「没登录」和「登录了但被官方禁用（排队）」：后者不该让用户去重登
        const blocked = listAccounts(provider).filter(entry => entry.officialDisabled === true)
        if (blocked.length > 0) {
          throw httpError(`${product.displayName} 的账号已被官方禁用（排队），请更换账号或在面板上启用后重试`, 403, { code: 'OFFICIAL_DISABLED' })
        }
        throw httpError(`${product.displayName} 没有可用账号，请先登录`, 401)
      }
      throw httpError(`${product.displayName} 的账号都在 ${bare} 上受限`, 429, { retryAfterMs: cfg(provider).cooldownMs || 60000 })
    }

    const ask = buildAsk(provider, bare, openAi, meta, sessionKey)
    const bodyBytes = Buffer.byteLength(JSON.stringify(ask.history || [])) + Buffer.byteLength(ask.userText || '')
    if (bodyBytes > MAX_BODY_BYTES) {
      // 超限的请求上游会直接 RST，本地先拒还能给出可读原因，也不去冷却账号
      throw httpError(`${product.displayName}：请求体过大（约 ${Math.round(bodyBytes / 1024 / 1024)}MB），请精简历史或图片`, 413)
    }

    let lastError
    for (const candidate of candidates) {
      if (signal?.aborted) throw new Error('请求已取消')
      const release = await acquireSlot(candidate.uid, signal, provider)
      try {
        let queueAttempts = 0
        let transportRetried = false
        for (;;) {
          const credential = await resolveCredential(provider, candidate.uid)
          if (!credential) throw httpError('账号凭据不存在', 401)
          const client = await clientFor(provider, candidate.uid, credential)
          // ⚠️ 每次尝试都重新签名：date/requestId 都参与签名，复用上一次的
          // prepared 会让重试带着过期的 Cosy-Date 与重复的 request-id（403/409）
          const prepared = client.prepareInfer(ask)

          let response
          try {
            response = await request(prepared.url, {
              method: 'POST',
              headers: prepared.headers,
              body: prepared.body,
              signal,
              timeout: 0,
            })
          } catch (error) {
            if (signal?.aborted) throw error
            // 传输层抖动（DNS/连接被重置）：换一个推理域名再试一次。
            // 签名只覆盖 path，换 host 不影响有效性；换号反而会白占一个号。
            const hosts = Array.isArray(product.inferHosts) ? product.inferHosts : []
            const nextHost = hosts.find(host => !String(prepared.url).startsWith(host))
            if (!transportRetried && nextHost) {
              transportRetried = true
              logger.warn?.(`[qoder] 传输失败，换推理域名重试：${error.message}`)
              clients.set(`${provider}:${candidate.uid}`, await QoderEncryptedInfer.create({
                user: { uid: credential.uid, securityOauthToken: protocol.bearerToken(credential) },
                machineId: credential.machine_id,
                metadata: { ...product.clientMetadata },
                host: nextHost,
              }))
              continue
            }
            throw httpError(`${product.displayName}：网络请求失败（${error.message}）`, 502)
          }

          // 第一形态的排队：HTTP 403 + 排队 JSON 体（subCode 常见为 RESOURCE_LIMIT）。
          // 必须在认证分支之前识别，否则会被当普通 403 直接失败。
          if (response.status === 403) {
            const text = await response.clone().text().catch(() => '')
            let parsed
            try { parsed = JSON.parse(text) } catch { /* 普通错误 */ }
            const queueError = parsed && typeof parsed === 'object' ? queueOrError(parsed) : null
            if (queueError?.code === 'QUEUED') {
              // 国际版排队 = 官方禁用该号，等 30 秒也没用：标记后立刻失败
              if (product.id === 'qoder') {
                markOfficialDisabled(product.id, candidate.uid, queueError.message)
                throw queueError
              }
              if (queueAttempts >= QUEUE_MAX_ATTEMPTS) throw queueError
              queueAttempts++
              logger.info?.(`[qoder] ${queueError.message}`)
              await new Promise(resolve => setTimeout(resolve, queueError.retryAfterMs))
              continue // 下一轮重签
            }
          }

          if (response.status === 401 || response.status === 403) {
            const text = await response.text().catch(() => '')
            const tokenDead = response.status === 401
              || /"?code"?\s*:\s*"?105"?/.test(text)
              || /TOKEN_EXPIRE/i.test(text)
            if (tokenDead) {
              // 令牌这条路径已死：续期一次；续不上就停用该号，别让每个请求都白撞。
              // 无论续期成功与否都换下一个候选 —— 本次请求的签名已经带上了旧令牌。
              try {
                await refreshCredential(provider, candidate.uid)
                lastError = httpError(`${product.displayName} 鉴权已过期（已自动续期，重试即用）`, 401, { code: 'AUTH' })
              } catch (refreshError) {
                disableAccount(provider, candidate.uid, '令牌已失效')
                lastError = httpError(`${product.displayName}：${refreshError.message}`, 401, { code: 'AUTH' })
              }
              break
            }
            if (isQuotaDenied(response.status, text)) {
              noteCooldown(candidate.uid, cfg(product.id).cooldownMs)
              lastError = httpError(`${product.displayName}：额度受限`, 429, { retryAfterMs: cfg(product.id).cooldownMs })
              break
            }
            throw upstreamError(product, response.status, text)
          }

          if (response.status === 409) {
            // 重复请求：凭据没问题，重发一次即可 —— 这里交给上层重试，不换号
            throw httpError(`${product.displayName}：重复请求`, 409, { code: 'DUPLICATE' })
          }

          if (response.status === 429) {
            const retryAfter = Number(response.headers.get('retry-after'))
            const window = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : cfg(product.id).cooldownMs
            noteCooldown(candidate.uid, window)
            lastError = httpError(`${product.displayName}：额度受限`, 429, { retryAfterMs: window })
            break
          }

          if (!response.ok) {
            const text = await response.text().catch(() => '')
            if (response.status === 400) learnMaxOutput(provider, bare, text)
            throw upstreamError(product, response.status, text)
          }

          // 排队可以在同一账号上等一等再重发：排队期间没有任何产出，重放不会重复计费。
          // 第二形态是 HTTP 200 建流后错误以信封投递，只有 consumeEnvelope 看得见。
          let sseQueueAttempts = 0
          let emptyRetried = false
          let emittedAny = false
          for (;;) {
            try {
              return await consumeEnvelope(response, {
                model: bare,
                signal,
                // 记账包一层：usage 帧经过时顺手累计到该账号的今日 token（servedUid 已带入）
                onChunk: chunk => {
                  emittedAny = true
                  if (chunk?.type === 'usage') noteTokenUsage(chunk.usage?.uid, chunk.usage?.totalTokens)
                  onChunk(chunk)
                },
                servedUid: candidate.uid,
              })
            } catch (error) {
              // 上游 200 建流后一个字节都没产出（空回答）：还没向客户端发过任何东西，
              // 重签一次重发是安全的。不重试的话用户只看到一片空白，而这次失败
              // 也不会被记成模型故障。
              if (!signal?.aborted && error?.code === 'EMPTY' && !emittedAny && !emptyRetried) {
                emptyRetried = true
                logger.warn?.('[qoder] 上游返回空回答，重签后重试一次')
                const rePrepared = client.prepareInfer(ask)
                const retried = await request(rePrepared.url, {
                  method: 'POST', headers: rePrepared.headers, body: rePrepared.body, signal, timeout: 0,
                })
                if (!retried.ok) throw upstreamError(product, retried.status, await retried.text().catch(() => ''))
                response = retried
                continue
              }
              if (error?.code === 'QUEUED' && product.id === 'qoder') {
                markOfficialDisabled(product.id, candidate.uid, error.message)
                throw error
              }
              if (error?.code !== 'QUEUED' || sseQueueAttempts >= QUEUE_MAX_ATTEMPTS || signal?.aborted) {
                if (error?.code === 'QUEUED') markOfficialDisabled(product.id, candidate.uid, error.message)
                throw error
              }
              sseQueueAttempts++
              logger.info?.(`[qoder] ${error.message}`)
              await new Promise(resolve => setTimeout(resolve, error.retryAfterMs))
              const rePrepared = client.prepareInfer(ask)
              const retried = await request(rePrepared.url, {
                method: 'POST', headers: rePrepared.headers, body: rePrepared.body, signal, timeout: 0,
              })
              if (!retried.ok) throw upstreamError(product, retried.status, await retried.text().catch(() => ''))
              response = retried
            }
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (error?.code === 'QUEUED') markOfficialDisabled(product.id, candidate.uid, error.message)
        if (error?.code === 'AUTH' || error?.code === 'DUPLICATE') {
          // 换个号继续（这里不 break 外层，让它走下一个候选）
          lastError = error
          continue
        }
        throw error
      } finally {
        release()
      }
    }
    // 亲和只在这一轮彻底失败后才解绑：中途换过号说明亲和已经失效了
    if (sessionKey) affinity.delete(sessionKey)
    throw lastError ?? httpError(`${product.displayName}：所有账号均不可用`, 503)
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
      if (data.error) throw httpError(`Qoder：${data.error.message || JSON.stringify(data.error)}`, 502)
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

    // 只补发有名字的调用：空名调用客户端查不到工具，只会一直等一个不会来的结果
    const named = [...toolCalls.entries()].filter(([, call]) => typeof call.name === 'string' && call.name.length > 0)
    for (const [index, call] of named) {
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
          // 上游直接报的积分消耗（复数：单数 credits 恒为 0，实测踩过）
          ...Number.isFinite(Number(usage.credits)) ? { credits: Number(usage.credits) } : {},
          // 记账归因：面板的「今日 token」按账号累计（同 WorkBuddy 的 tokenUsageToday）
          ...(servedUid ? { uid: servedUid } : {}),
        },
      })
    }
    // 有 [DONE] 却一个字都没产出：这是「200 + 空回答」，不是正常收尾。
    // 放过去客户端只会显示空白，而这次失败也不会进模型健康台账。
    if (!emitted && named.length === 0) {
      throw httpError('Qoder 返回了空内容（上游零产出）', 502, { code: 'EMPTY' })
    }
    // 有名字的调用才算真的调用了工具；只剩空名残帧时降级成 stop，
    // 否则客户端会一直等一个永远不会来的工具结果
    const reason = named.length > 0
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

  // 轮询一次：404 / 202 = 用户还没确认（继续等），200 = 拿到令牌
  async function pollLogin(provider, state) {
    const entry = logins.get(state)
    if (!entry) return { status: 'expired', message: '登录会话已失效，请重新发起' }
    const product = protocol.PRODUCTS[entry.provider]
    const response = await request(protocol.buildPollUrl(entry.session, product), {
      headers: { Accept: 'application/json', 'User-Agent': `${product.userAgentPrefix}/1.0.0` },
    })
    if (response.status === 404 || response.status === 202) return { status: 'pending' }
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
    const uid = payload.uid
    if (!uid) return { status: 'failed', message: '登录响应里没有 user_id，无法建立账号' }
    // 同一账号沿用已有 machine_id；新账号按 (安装盐, uid) 派生。
    // 随机 UUID 会让「删号重登」变成一台新设备，是上游最容易聚类的特征。
    const existing = accounts.getCredential(dataDir, entry.provider, uid)
    const machineId = existing?.machine_id && String(existing.machine_id).length > 0
      ? existing.machine_id
      : protocol.deriveMachineId(`${installSalt()}:${uid}`)
    const credential = protocol.buildCredential(payload, { machineId, nickname })
    // 官方不给过期时间时按 30 天兜底：不写 expire_time 的账号永不主动续期
    if (credential.expire_time === undefined) credential.expire_time = Date.now() + protocol.DEFAULT_CREDENTIAL_TTL_MS
    accounts.setCredential(dataDir, entry.provider, uid, credential)
    updateAccount(entry.provider, uid, {
      name: protocol.displayName(credential, accounts.accountId(entry.provider, uid)),
      enabled: true,
      addedAt: Date.now(),
    })
    logins.delete(state)
    return { status: 'done', uid, name: protocol.displayName(credential, uid) }
  }

  // ── 额度（余额 / 每日领取）──

  // 积分余额 = 套餐额度 + 资源包 + 专用资源包 + 团队共享池（见 protocol.parseUsageBalance）。
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
    const raw = await response.text().catch(() => '')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('积分余额查询失败：响应不是 JSON')
    }
    const value = protocol.parseUsageBalance(parsed)
    if (!value) {
      // 保留现场：形状不符时把原始响应的摘要带出来，否则只能看到一句「不符合预期」
      throw new Error(`积分余额查询失败：响应形状不符合预期（${raw.slice(0, 160)}）`)
    }
    return value
  }

  // 活动平台的桌面端头：UA 逐字 'Qoder' + cosy-clienttype 10 + cosy-version。
  // ⚠️ 绝不能带任何 cosy-machine*：派生值会让「每日领取」活动被整条静默过滤。
  // cosy-version 用官网同步的 IDE 版本（每天自动更新），同步失败回落内置默认
  function desktopHeaders(credential) {
    const version = versions?.get?.().qoder?.appVersion || protocol.DESKTOP_CLIENT_VERSION
    return {
      Accept: 'application/json',
      'User-Agent': 'Qoder',
      Authorization: `Bearer ${protocol.bearerToken(credential)}`,
      'cosy-clienttype': protocol.DESKTOP_CLIENT_TYPE,
      'cosy-version': version,
    }
  }

  function campaignTitle(item) {
    const content = item?.placements?.[0]?.content
    const zh = content?.zh || content?.en
    if (typeof zh?.title === 'string' && zh.title.trim()) return zh.title.trim()
    return typeof item?.title === 'string' && item.title ? item.title : '每日领取'
  }

  function campaignStatus(item) {
    return String(item?.claimStatus ?? item?.claim_status ?? '').toUpperCase()
  }

  function campaignAction(item) {
    return String(item?.actionType ?? item?.action_type ?? '').toUpperCase()
  }

  function campaignBenefit(item) {
    const benefit = item?.benefit && typeof item.benefit === 'object' ? item.benefit : {}
    return {
      kind: String(benefit.kind ?? '').toUpperCase(),
      amount: Number(benefit.amount) || 0,
    }
  }

  // 拉活动列表。候选基址只在「连接失败 / 404 / 405 / 410」时回落 ——
  // 401/403/429 换个域名同样失败，回落只会多打几次上游。
  async function loadCampaigns(provider, credential) {
    const product = protocol.PRODUCTS[provider]
    const bases = Array.isArray(product.openApiCandidates) && product.openApiCandidates.length > 0
      ? product.openApiCandidates
      : [product.openApiBase]
    let lastError
    for (const base of bases) {
      let response
      try {
        response = await request(`${base}${protocol.CAMPAIGNS_PATH}`, { headers: desktopHeaders(credential) })
      } catch (error) {
        lastError = new Error(`活动列表请求失败：${error.message}`)
        continue
      }
      if ([404, 405, 410].includes(response.status)) {
        lastError = new Error(`活动平台不可用（HTTP ${response.status}）`)
        continue
      }
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw httpError(`活动平台鉴权失败（HTTP ${response.status}）`, response.status)
      }
      if (!response.ok) throw httpError(`活动列表查询失败（HTTP ${response.status}）`, 502)
      const body = await response.json().catch(() => undefined)
      if (!body || typeof body !== 'object') throw new Error('活动列表响应不是 JSON')
      return {
        campaigns: Array.isArray(body.campaigns) ? body.campaigns : [],
        showCampaign: body.showCampaign !== false,
      }
    }
    throw lastError || new Error('活动列表不可用')
  }

  // 领取一条活动。幂等：409 / ALREADY_CLAIMED / replayed 都归一成「今天已领」
  async function claimCampaign(provider, credential, id) {
    const product = protocol.PRODUCTS[provider]
    const response = await request(`${product.openApiBase}${protocol.campaignClaimPath(id)}`, {
      method: 'POST',
      headers: { ...desktopHeaders(credential), 'Content-Type': 'application/json' },
      body: '{}',
      timeout: 20000,
    })
    const body = await response.json().catch(() => ({}))
    const status = String(body?.status ?? '').toUpperCase()
    const failure = String(body?.failureCode ?? body?.errorCode ?? '').toUpperCase()
    const replayed = body?.replayed === true
    if (response.status === 409 || failure === 'ALREADY_CLAIMED' || failure === 'REPLAYED' || replayed) {
      return { kind: 'already-claimed', message: '今天已领过' }
    }
    if (status === 'BLOCKED' || failure === 'SAME_PERSON_ALREADY_CLAIMED') {
      // 服务器按「人」去重：同机多个账号只有第一个能领（官方行为，不是 bug）
      return { kind: 'blocked', message: '同一个人今天已领过（同机多号只算一次）' }
    }
    if (failure === 'REDEMPTION_CODE_OUT_OF_STOCK') return { kind: 'pending', message: '库存不足，稍后再试' }
    if (failure === 'ACHIEVEMENT_NOT_COMPLETED' || body?.achievementCompleted === false) {
      return { kind: 'locked', message: '成就未完成，暂不可领' }
    }
    if (failure === 'CAMPAIGN_NOT_ACTIVE') return { kind: 'pending', message: '活动未开始或已结束' }
    if (failure === 'RISK_BLOCKED' || failure === 'RISK_DEPENDENCY_UNAVAILABLE') {
      return { kind: 'blocked', message: '被上游风控拦下，稍后再试' }
    }
    const ok = ['CLAIMED', 'GRANTED', 'SUCCESS'].includes(status) || body?.success === true
    if (!ok) {
      return { kind: 'failed', message: String(body?.message || body?.error || `HTTP ${response.status}`).slice(0, 120) }
    }
    const credit = Number(body?.benefit?.amount ?? body?.amount) || 0
    return { kind: 'claimed', credit, message: credit > 0 ? `领取 ${credit} 积分` : '已领取' }
  }

  // 旧签到端点：只有 404/405/410 才算「本区没有」，403 多是出口/WAF，不能缓存
  async function legacyCheckin(provider, credential) {
    const product = protocol.PRODUCTS[provider]
    try {
      const response = await request(`${product.openApiBase}${protocol.CHECKIN_STATUS_PATH}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${protocol.bearerToken(credential)}`,
        },
      })
      if ([404, 405, 410].includes(response.status)) {
        return { outcome: 'ineligible', message: '本区域未开放每日签到接口', unsupported: true }
      }
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'failed', message: `签到接口鉴权失败（HTTP ${response.status}）` }
      }
      if (!response.ok) return { outcome: 'failed', message: `签到状态查询失败（HTTP ${response.status}）` }
      const body = await response.json().catch(() => ({}))
      const claimed = String(body?.status ?? '').toUpperCase() === 'CLAIMED'
      if (claimed) return { outcome: 'done', message: '今天已签过' }
      const claim = await request(`${product.openApiBase}${protocol.CHECKIN_CLAIM_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${protocol.bearerToken(credential)}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      const claimBody = await claim.json().catch(() => ({}))
      const text = JSON.stringify(claimBody)
      if (claim.status === 409 || text.includes('ALREADY_CLAIMED')) return { outcome: 'done', message: '今天已签过' }
      if (!claim.ok || claimBody?.success === false) {
        return { outcome: 'failed', message: `签到失败（HTTP ${claim.status}）` }
      }
      const credit = Number(claimBody?.rewardCredits) || 0
      return { outcome: 'claimed', credit, message: credit > 0 ? `签到领取 ${credit} 积分` : '签到成功' }
    } catch (error) {
      return { outcome: 'failed', message: `签到请求失败：${error.message}` }
    }
  }

  // 每日领取：活动平台（campaigns → claim）优先，接口不存在时回落旧签到。
  // 三种结论必须分清：领到了 / 今天已领 / 本区没有 —— 都报「已领」是错的。
  async function checkin(provider, uid) {
    const product = protocol.PRODUCTS[provider]
    if (!product) return { outcome: 'failed', message: `未知的 Qoder 渠道：${provider}` }
    const target = uid || listAccounts(provider).find(entry => entry.enabled !== false)?.uid
    if (!target) return { outcome: 'ineligible', message: '没有可用账号' }
    const probe = checkinProbe.get(provider)
    if (probe && probe.until > Date.now() && !probe.supported) {
      return { outcome: 'ineligible', message: probe.reason || '本区域未开放每日领取' }
    }

    const credential = await resolveCredential(provider, target)
    if (!credential) return { outcome: 'failed', message: '账号凭据不存在' }

    let list
    try {
      list = await loadCampaigns(provider, credential)
    } catch (error) {
      // 活动平台整体不可用：按「本区没有」处理，但只缓存 6 小时（可能是临时故障）
      const unsupported = /HTTP (404|405|410)|活动平台不可用/.test(error.message)
      if (unsupported) {
        checkinProbe.set(provider, { supported: false, until: Date.now() + 6 * 3600 * 1000, reason: error.message })
        const legacy = await legacyCheckin(provider, credential)
        if (legacy.outcome !== 'ineligible') return legacy
        return { outcome: 'ineligible', message: '本区域没有每日领取活动' }
      }
      return { outcome: 'failed', message: error.message }
    }

    checkinProbe.set(provider, { supported: true, until: Date.now() + 6 * 3600 * 1000 })
    const nextNote = `下次可领：${new Date(protocol.nextCheckinWindow()).toLocaleString('zh-CN', { hour12: false })}（UTC+8 10:00）`
    if (list.campaigns.length === 0) {
      return { outcome: 'ineligible', message: `没有可领取的活动（${nextNote}）` }
    }

    let credit = 0
    let claimed = 0
    let already = 0
    const notes = []
    for (const item of list.campaigns) {
      const id = item?.campaignId ?? item?.campaign_id
      if (!id) continue
      const status = campaignStatus(item)
      // ⚠️ 先判已领，再判 actionType：官方领完会把 actionType 降级成 VIEW_DETAILS，
      // 反过来判会把「今天已领」报成「没有可领的活动」
      if (status === 'CLAIMED') { already++; continue }
      const action = campaignAction(item)
      if (action !== '' && action !== 'CLAIM_BENEFIT') continue
      const benefit = campaignBenefit(item)
      if (benefit.kind !== '' && benefit.kind !== 'CREDITS') continue
      if (status !== 'CLAIMABLE') {
        const reason = String(item?.unavailableReason ?? '').toUpperCase()
        if (reason === 'REDEMPTION_CODE_OUT_OF_STOCK') notes.push('库存不足')
        else if (reason === 'ACHIEVEMENT_NOT_COMPLETED' || item?.achievementCompleted === false) notes.push('成就未完成')
        continue
      }
      const result = await claimCampaign(provider, credential, id)
      if (result.kind === 'claimed') {
        claimed++
        credit += result.credit || 0
        notes.push(`${campaignTitle(item)}：${result.message}`)
      } else if (result.kind === 'already-claimed') {
        already++
      } else if (result.kind === 'blocked') {
        // 同人去重：本机其它账号已经领过，这一轮不必再试
        notes.push(result.message)
        break
      } else {
        notes.push(result.message)
      }
      // 相邻两次领取之间留 1 秒：上游对连续 claim 有频率判据
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    if (claimed > 0) {
      return { outcome: 'claimed', credit, message: `领取 ${claimed} 项，共 ${credit} 积分` }
    }
    if (already > 0) return { outcome: 'done', message: `今天已领过${notes.length ? `（${notes.join('；')}）` : ''}` }
    return { outcome: 'ineligible', message: notes.length > 0 ? notes.join('；') : `今天没有可领取的活动（${nextNote}）` }
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
    cooldowns.delete(uid)
    notify()
  }

  async function shutdown() {
    logins.clear()
    clients.clear()
    cooldowns.clear()
    affinity.clear()
    sessions.clear()
    gates.clear()
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
