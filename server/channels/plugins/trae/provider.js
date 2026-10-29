// Trae 渠道：登录、续期、目录、补全、签到、额度
//
// 与 dsh 渠道包的区别：这里**不再有 cordis ctx 与 LLM 适配器栈**。AiRoute 的
// 请求体在 HTTP 层已经收敛成 OpenAI Chat，所以本文件只做三件事：
//   ① 选号（多账号、跳过冷却/熔断/在途超限的）
//   ② 把 OpenAI 请求转成 SOLO 格式并发出去
//   ③ 把 SOLO 的自定义 SSE 事件转成 AiRoute 的内部 chunk（sse.js 的输入）
//
// 失败重试的边界（对齐上游实测口径）：
//   - HTTP 层 401/403 → 续期一次后重发；其余状态码按 protocol.retryPlan 分诊
//     （同号退避重试 / 换号 / 直接透传），不再一律换号；
//   - 首字超时（默认 10s）→ 换下一个号重发，**只在本轮还没吐任何内容时**；
//   - 流内可换号错误（1005/4008/4011）→ 同上，吐了一半就不再重放。

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const protocol = require('./protocol')
const sanitize = require('./sanitize')

const PROVIDERS = ['trae']
const CREDENTIAL_PREFIX = 'TRAE'

// 换号预算：一次请求最多试几个账号。比原来多一个：首字超时换号会更快耗尽预算，
// 3 个号在「两个号卡住」的场景下不够用。
const MAX_ROTATE = 4
// 同号重试的等待上限：重试表里 503 最长 40s，别让调用方等到天荒地老
const MAX_SAME_KEY_RETRY = 3
// 额度耗尽后的冷却终点由 protocol.nextQuotaReset 给出（次日 04:00），
// 真限流用 Retry-After/60s —— 不再共用一个固定一小时的窗口。
const RATE_LIMIT_FALLBACK_MS = 60 * 1000
// 积分为零的账号在多长时间内可信（快照陈旧时 fail-open，别把好号误杀）
const CREDITS_FRESH_MS = 24 * 3600 * 1000

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
  constructor(message, code, status, retryAfterMs = 0) {
    super(message)
    this.name = 'TraeError'
    this.code = code
    this.statusCode = status
    this.retryAfterMs = Number(retryAfterMs) || 0
  }
}

// credentials / login 由宿主注入（见 plugin-api.js）：插件不直接 require 宿主的
// 存储与端口服务，换实现时这里不用改。
function createTrae({ dataDir, logger = console, credentials, login, settings, versions }) {
  if (!credentials) throw new Error('Trae 插件缺少凭据服务（credentials）')
  if (!login) throw new Error('Trae 插件缺少登录回调服务（login）')
  const accounts = credentials
  const loginServer = login
  // 渠道设置：宿主没注入时退回默认值（等于改造前的行为）
  const SETTING_DEFAULTS = {
    firstByteMs: 10000,
    poolStrategy: 'order',
    stickyTtlMs: 1800000,
    sanitize: true,
    maxMode: true,
    toolAlias: {},
  }

  function cfg() {
    // 按渠道取：Trae 的参数在 providers.trae 下，改 Qoder 不会影响这里
    const raw = settings?.forProvider?.('trae') || settings?.get?.() || {}
    return {
      firstByteMs: Number.isFinite(Number(raw.traeFirstByteMs)) ? Number(raw.traeFirstByteMs) : SETTING_DEFAULTS.firstByteMs,
      poolStrategy: typeof raw.traePoolStrategy === 'string' ? raw.traePoolStrategy : SETTING_DEFAULTS.poolStrategy,
      stickyTtlMs: Number.isFinite(Number(raw.traeStickyTtlMs)) ? Number(raw.traeStickyTtlMs) : SETTING_DEFAULTS.stickyTtlMs,
      sanitize: raw.traeSanitize !== false,
      maxMode: raw.traeMaxMode !== false,
      toolAlias: raw.traeToolAlias ?? SETTING_DEFAULTS.toolAlias,
      maxConcurrency: Number.isFinite(Number(raw.maxConcurrency)) ? Number(raw.maxConcurrency) : 1,
    }
  }

  // ── 状态 ──
  // 模型目录缓存：远端失败时**不缓存空结果**，否则一次抖动会让目录空一整天
  let catalog = { models: [], at: 0 }
  let catalogFetching = null
  // 模型 → 所属通道（同一条目按通道择优后的结果）
  const channelOf = new Map()
  // 账号冷却：uid → { kind, until }。kind 决定语义：
  //   quota = 额度耗尽（冷却到次日 04:00）/ rate = 真限流（Retry-After 或 60s）
  const cooldowns = new Map()
  // 熔断：uid → { failures, level, openUntil }。连续失败才熔断，成功一次清零
  const breakers = new Map()
  // 单号在途数：uid → 数量（配合设置里的 maxConcurrency 做闸门）
  const inflight = new Map()
  // 模型级冷却：model → { level, until }。同一模型连续抖动时，换号也没用，
  // 直接快速失败并给 Retry-After，比让每个号都白试一遍好
  const modelCooldowns = new Map()
  // 会话粘性：key → { uid, until }。同一段对话固定落同一账号
  const sticky = new Map()
  // 待完成的登录流程：state → { machineId, deviceId, createdAt }
  const logins = new Map()
  // 账号级今日 token：uid → { day, total }。内存账本（进程重启清零）——
  // 界面显示的是「今天到目前为止用了多少」，与 WorkBuddy 池的 tokenUsageToday 同口径；
  // 跨零点自然归零，不落盘（重启丢一段当日读数可接受，不值得为此多一份状态文件）
  const tokenToday = new Map()

  function noteTokenUsage(uid, tokens) {
    const total = Math.trunc(Number(tokens) || 0)
    if (!uid || total <= 0) return
    const day = localDay(Date.now())
    const entry = tokenToday.get(uid)
    if (!entry || entry.day !== day) tokenToday.set(uid, { day, total })
    else entry.total += total
  }

  function tokenUsageTodayOf(uid) {
    const entry = tokenToday.get(uid)
    return entry && entry.day === localDay(Date.now()) ? entry.total : 0
  }

  // ── 冷却 / 熔断 / 在途 / 粘性 ──

  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

  function cooldownOf(uid, now = Date.now()) {
    const entry = cooldowns.get(uid)
    if (!entry) return undefined
    if (entry.until <= now) {
      cooldowns.delete(uid)
      return undefined
    }
    return entry
  }

  function noteCooldown(uid, kind, ms) {
    cooldowns.set(uid, { kind, until: Date.now() + Math.max(1000, ms) })
  }

  function breakerOf(uid, now = Date.now()) {
    const entry = breakers.get(uid)
    if (!entry || !entry.openUntil) return undefined
    if (entry.openUntil <= now) {
      breakers.delete(uid)
      return undefined
    }
    return entry
  }

  // 账号使用统计（内存）：策略排序要用「最近用过没 / 成功率」，为这个落盘不值得
  const usageStats = new Map()

  function noteAccountSuccess(uid) {
    const entry = usageStats.get(uid) || { success: 0, fail: 0, lastUsedAt: 0 }
    entry.success++
    entry.lastUsedAt = Date.now()
    usageStats.set(uid, entry)
  }

  function noteAccountFailure(uid) {
    const entry = usageStats.get(uid) || { success: 0, fail: 0, lastUsedAt: 0 }
    entry.fail++
    usageStats.set(uid, entry)
  }

  function successRateOf(uid) {
    const entry = usageStats.get(uid)
    if (!entry || entry.success + entry.fail === 0) return undefined
    return entry.success / (entry.success + entry.fail)
  }

  // 连续失败 3 次才熔断：30 分钟起，之后每次再加倍，封顶 6 小时
  function noteFailure(uid) {
    noteAccountFailure(uid)
    const entry = breakers.get(uid) || { failures: 0, level: 0, openUntil: 0 }
    entry.failures++
    if (entry.failures >= 3) {
      entry.level++
      const window = Math.min(30 * 60 * 1000 * Math.pow(2, entry.level - 1), 6 * 3600 * 1000)
      entry.openUntil = Date.now() + window
      logger.warn?.(`[Trae] ${uid} 连续失败 ${entry.failures} 次，熔断 ${Math.round(window / 60000)} 分钟`)
    }
    breakers.set(uid, entry)
  }

  function noteSuccess(uid) {
    breakers.delete(uid)
    cooldowns.delete(uid)
  }

  function modelCooldownOf(model, now = Date.now()) {
    const entry = modelCooldowns.get(model)
    if (!entry) return undefined
    if (entry.until <= now) {
      modelCooldowns.delete(model)
      return undefined
    }
    return entry
  }

  // 模型级冷却 10s → 20s → 40s（不再往上翻：超过 40s 基本等于模型下线，
  // 那种情况该由模型健康台账处理，不该让网关在这里硬等）
  function noteModelFailure(model) {
    const entry = modelCooldowns.get(model) || { level: 0, until: 0 }
    entry.level = Math.min(entry.level + 1, 3)
    entry.until = Date.now() + 10000 * Math.pow(2, entry.level - 1)
    modelCooldowns.set(model, entry)
  }

  function noteModelSuccess(model) {
    modelCooldowns.delete(model)
  }

  // 会话键：优先用客户端显式给的 conversation_id（OpenAI 体里没有标准字段，
  // 但 Anthropic/Codex 客户端常带 metadata），否则用前三消息的指纹 —— 同一段
  // 对话重发时前三条稳定，够用来绑定账号。
  function stickyKeyOf(openAi) {
    const explicit = openAi?.conversation_id ?? openAi?.metadata?.conversation_id
    if (typeof explicit === 'string' && explicit.trim().length > 0) return `c:${explicit.trim()}`
    const head = Array.isArray(openAi?.messages) ? openAi.messages.slice(0, 3) : []
    if (head.length === 0) return ''
    return `f:${crypto.createHash('sha256').update(JSON.stringify(head)).digest('hex').slice(0, 16)}`
  }

  function stickyUidFor(key) {
    if (!key) return undefined
    const entry = sticky.get(key)
    if (!entry) return undefined
    if (entry.until <= Date.now()) {
      sticky.delete(key)
      return undefined
    }
    return entry.uid
  }

  function rememberSticky(key, uid) {
    const { stickyTtlMs } = cfg()
    if (!key || !(stickyTtlMs > 0)) return
    // 上限保护：长会话不该把内存吃满，超过就整体清空（粘性丢了只是缓存不命中）
    if (sticky.size > 2000) sticky.clear()
    sticky.set(key, { uid, until: Date.now() + stickyTtlMs })
  }

  // 余额快照只在新鲜时才用来过滤零积分账号：陈旧快照 fail-open，
  // 否则一次查询失败就会把所有号都判成没钱
  function creditsUsable(entry) {
    if (!Number.isFinite(entry.credits)) return true
    const fetchedAt = Number(entry.creditsFetchedAt)
    if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > CREDITS_FRESH_MS) return true
    return entry.credits > 0
  }

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
        // 今日已用 token（账号级，见 tokenToday 的说明）
        tokenUsageToday: tokenUsageTodayOf(entry.uid),
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

  // 静默写注册表：不触发 onChanged。余额快照变化不影响模型目录，
  // 触发重建等于每次查余额都白跑一趟远端采集
  function patchAccountQuiet(uid, patch) {
    const entries = readRegistry()
    const index = entries.findIndex(entry => entry.uid === uid)
    if (index === -1) {
      entries.push({ uid, id: accounts.accountId('trae', uid), name: uid, enabled: true, addedAt: Date.now(), ...patch })
    } else {
      entries[index] = { ...entries[index], ...patch }
    }
    writeRegistry(entries)
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

  // v3 续期（客户端 exchangeTokenByRefreshToken 同款）：带 DeviceInfo + DeviceProof
  // （对 'POST <path> <clientID> <refreshToken> <timestamp> <nonce>' 的 sha256 私钥签名）。
  // v1（ClientSecret:'-'）失败时的兜底：能救回「refresh 还有效但 v1 端点拒了」的号
  async function refreshCredentialV3(credential) {
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomBytes(16).toString('hex')
    const path = '/trae/api/v3/oauth/ExchangeToken'
    const proofBase = ['POST', path, protocol.LOGIN_CLIENT_ID, credential.refresh_token, String(timestamp), nonce].join(' ')
    const signature = crypto.createSign('sha256').update(proofBase).sign(credential.device_private_key, 'base64')
    const built = protocol.buildAuthCodeExchange({
      authCode: '', // v3 续期不用授权码；复用请求体组装，AuthCode 置空换 RefreshToken
      codeVerifier: '',
      publicKey: credential.device_public_key || '',
      machineId: credential.machine_id,
      deviceId: credential.device_id,
    }, versions?.get?.().trae?.appVersion)
    const lastError = []
    for (const url of built.urls) {
      try {
        const response = await request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': protocol.USER_AGENT,
            'x-cloudide-token': '',
          },
          body: {
            ClientID: protocol.LOGIN_CLIENT_ID,
            ClientSecret: '',
            RefreshToken: credential.refresh_token,
            DeviceInfo: built.body.DeviceInfo,
            DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
            IDEVersion: versions?.get?.().trae?.appVersion || protocol.IDE_VERSION,
          },
        })
        const text = await response.text().catch(() => '')
        if (!response.ok) {
          lastError.push(`HTTP ${response.status} ${text.slice(0, 120)}`)
          continue
        }
        const parsed = protocol.parseExchangeResponse(JSON.parse(text))
        if (parsed) return parsed
        lastError.push('响应里没有 Token')
      } catch (error) {
        lastError.push(error.message)
      }
    }
    throw new TraeError(`Trae v3 续期失败：${lastError.join('；').slice(0, 300)}`, 'AUTH', 502)
  }

  async function refreshCredential(uid, { force = false } = {}) {
    if (refreshing.has(uid)) return refreshing.get(uid)
    const task = (async () => {
      const credential = accounts.getCredential(dataDir, 'trae', uid)
      if (!credential) throw new TraeError('账号凭据不存在', 'AUTH')
      if (!protocol.isRefreshable(credential)) throw new TraeError('账号没有 refresh_token，请重新登录', 'AUTH')
      const exchange = await (async () => {
        // 先走 v1（历史端点，所有账号都认识）；v1 拒了再试 v3 —— 有设备密钥对的号
        // 在 v1 被逐步下线后仍能续命
        try {
          const response = await request(`${protocol.OAUTH_HOST}${protocol.EXCHANGE_PATH}`, {
            method: 'POST',
            headers: protocol.oauthHeaders(),
            body: { ClientID: 'en1oxy7wnw8j9n', RefreshToken: credential.refresh_token, ClientSecret: '-', UserID: '' },
          })
          if (response.ok) {
            const parsed = protocol.parseExchangeResponse(await response.json())
            if (parsed) return parsed
          }
          logger.info?.(`[Trae] ${uid} v1 续期未成功（HTTP ${response.status}），尝试 v3`)
        } catch (error) {
          logger.info?.(`[Trae] ${uid} v1 续期异常：${error.message}，尝试 v3`)
        }
        if (!credential.device_private_key) {
          throw new TraeError('Trae 续期失败且该账号没有设备密钥（v3 需要），请重新登录', 'AUTH', 401)
        }
        return refreshCredentialV3(credential)
      })()
      const next = protocol.applyRefresh(credential, exchange)
      accounts.setCredential(dataDir, 'trae', uid, next)
      return next
    })().finally(() => refreshing.delete(uid))
    refreshing.set(uid, task)
    return task
  }

  // 候选账号：停用 / 冷却 / 熔断 / 已在 tried 里的都不参与；余额快照为零的也跳过
  function candidateEntries(tried = new Set()) {
    const now = Date.now()
    const out = []
    for (const entry of listAccounts()) {
      if (entry.enabled === false) continue
      if (tried.has(entry.uid)) continue
      if (cooldownOf(entry.uid, now)) continue
      if (breakerOf(entry.uid, now)) continue
      if (!creditsUsable(entry)) continue
      const credential = accounts.getCredential(dataDir, 'trae', entry.uid)
      if (!credential) continue
      out.push({
        uid: entry.uid,
        credential,
        credits: entry.credits,
        creditsExpireAt: entry.creditsExpireAt,
        successRate: successRateOf(entry.uid),
        lastUsedAt: usageStats.get(entry.uid)?.lastUsedAt || 0,
        inflight: inflight.get(entry.uid) || 0,
      })
    }
    return out
  }

  // 只看「有个号能拿去登录/读目录」的宽松版：目录接口不消耗积分，
  // 不能因为余额快照为零就把目录也判成不可用
  function usableAccounts(_model, tried = new Set()) {
    const out = []
    for (const entry of listAccounts()) {
      if (entry.enabled === false) continue
      if (tried.has(entry.uid)) continue
      const credential = accounts.getCredential(dataDir, 'trae', entry.uid)
      if (!credential) continue
      out.push({ uid: entry.uid, credential })
    }
    return out
  }

  function pickCandidate(tried, stickyUid) {
    const list = candidateEntries(tried)
    if (list.length === 0) return undefined
    // 粘性优先：同一段对话固定落同一账号（缓存命中 + 上游会话一致性）
    if (stickyUid) {
      const bound = list.find(item => item.uid === stickyUid)
      if (bound) return bound
    }
    // 单号在途上限：超限的先让位；全忙时退化为最闲的那个（宁可排队也不拒绝）
    const limit = Number(cfg().maxConcurrency) || 0
    let pool = list
    if (limit > 0) {
      const idle = list.filter(item => item.inflight < limit)
      pool = idle.length > 0 ? idle : [list.reduce((a, b) => (a.inflight <= b.inflight ? a : b))]
    }
    return protocol.pickByStrategy(pool, {
      strategy: cfg().poolStrategy,
      seed: (Date.now() ^ (tried.size * 7919)) >>> 0,
    })
  }

  function enterInflight(uid) {
    inflight.set(uid, (inflight.get(uid) || 0) + 1)
  }

  function leaveInflight(uid) {
    const next = (inflight.get(uid) || 1) - 1
    if (next <= 0) inflight.delete(uid)
    else inflight.set(uid, next)
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

  function buildBody(openAi, model, identity) {
    const body = { ...openAi }
    delete body.stream_options
    delete body.reasoning_effort
    // 系统消息在 SOLO 里走 system 字段之外的位置也行：上游认 messages 里的 role
    const channel = channelOf.get(model) || protocol.DEFAULT_FUNCTION
    const now = cfg()
    const entry = catalog.models.find(item => item.id === model)
    // Max 模式：只有目录声明了「max 档 > dev 档」的模型才带这一组字段，
    // 否则多余的 is_max_mode 会被上游当成越权档位
    const maxMode = now.maxMode && entry?.contextWindowMax && entry.contextWindowMax > (entry.contextWindow || 0)
      ? { maxContext: entry.contextWindowMax, outputMax: entry.maxOutputTokens }
      : undefined
    const solo = protocol.transformToSolo(body, channel, { ...identity, maxMode })
    // 形态清洗：身份句/键值剥离（默认开，可在渠道设置里关掉）
    if (now.sanitize) {
      sanitize.sanitizeMessages(solo.messages)
      sanitize.sanitizeTools(solo.tools)
    }
    // 工具名别名：请求侧改名，响应侧用 reverse 回改
    const aliases = sanitize.applyToolAliases(solo, now.toolAlias)
    return { body: solo, reverse: aliases.reverse }
  }

  // ── SOLO SSE → AiRoute chunk ──

  // 把上游流逐事件转成内部 chunk。`onChunk` 由调用方提供。
  // 返回本轮是否吐过内容（决定能不能换号重发）。
  async function consumeSolo(response, { model, signal, onChunk, servedUid, reverse, onFirstChunk }) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // SOLO 的事件是 `event: <name>` + `data: <json>` 两行一对，空行是事件结束
    let currentEvent = ''
    let currentData = ''
    let emitted = false
    // 首字计时：拿到第一块字节就要通知调用方停掉超时计时器
    let firstByteSeen = false
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
          if (fn.name) tool.name = sanitize.restoreToolName(fn.name, reverse)
          const delta = typeof fn.arguments === 'string' ? fn.arguments : ''
          tool.arguments += delta
          emitted = true
          onChunk({
            type: 'tool-call-delta',
            index,
            ...tool.id ? { id: tool.id } : {},
            // 名字只在首次拿到时发：重复发会让客户端重建调用
            ...tool.name ? { name: tool.name } : {},
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
        if (!firstByteSeen) {
          firstByteSeen = true
          onFirstChunk?.()
        }
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
          // 记账归因：面板的「今日 token」按账号累计（同 WorkBuddy 的 tokenUsageToday）
          ...(servedUid ? { uid: servedUid } : {}),
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
    const now = cfg()

    // 模型级冷却：同一模型连续失败时，换号也救不回来（判的是模型不是账号），
    // 直接快速失败并给 Retry-After，别让每个号白试一遍
    const cooling = modelCooldownOf(bare)
    if (cooling) {
      const wait = Math.max(1000, cooling.until - Date.now())
      throw new TraeError(`Trae 的 ${bare} 连续失败，${Math.ceil(wait / 1000)}s 后重试`, 'MODEL_COOLING', 503, wait)
    }

    const stickyKey = stickyKeyOf(openAi)
    const tried = new Set()
    let lastError

    while (tried.size < MAX_ROTATE) {
      const candidate = pickCandidate(tried, stickyUidFor(stickyKey))
      if (!candidate) break
      tried.add(candidate.uid)
      enterInflight(candidate.uid)
      try {
        let credential
        try {
          credential = await resolveCredential(candidate.uid)
        } catch (error) {
          // 续期失败：这个号这一轮没戏，记一次失败后换下一个
          lastError = error
          noteFailure(candidate.uid)
          continue
        }

        const { body, reverse } = buildBody({ ...openAi, model: bare }, bare, {
          uid: candidate.uid,
          deviceId: credential.device_id || credential.deviceId,
          machineId: credential.machine_id || credential.machineId,
          // 粘性键就是上游 conversation_id 时直接复用，多轮上下文才真的连得上
          conversationId: stickyKey.startsWith('c:') ? stickyKey.slice(2) : undefined,
        })

        let attempt = 0
        let switched = false
        while (!switched) {
          // 首字超时：只覆盖「建连 → 第一块字节」。拿到首字立刻撤掉计时器，
          // 之后的长生成交给调用方的 signal 控制（模型想很久是正常的）
          const controller = new AbortController()
          const onClientAbort = () => controller.abort()
          signal?.addEventListener?.('abort', onClientAbort, { once: true })
          let firstByteTimeout = false
          const timer = now.firstByteMs > 0
            ? setTimeout(() => {
              firstByteTimeout = true
              controller.abort()
            }, now.firstByteMs)
            : null
          try {
            let response = await request(`${protocol.AGENT_HOST}${protocol.CHAT_PATH}`, {
              method: 'POST',
              headers: protocol.soloHeaders(credential, true),
              body,
              signal: controller.signal,
              timeout: 0,
            })
            if (response.status === 401 || response.status === 403) {
              credential = await refreshCredential(candidate.uid)
              response = await request(`${protocol.AGENT_HOST}${protocol.CHAT_PATH}`, {
                method: 'POST',
                headers: protocol.soloHeaders(credential, true),
                body,
                signal: controller.signal,
                timeout: 0,
              })
            }
            if (!response.ok) {
              const text = await response.text().catch(() => '')
              const retryAfter = Number(response.headers.get('retry-after')) || 0
              const decision = protocol.retryPlan(response.status, text, attempt, retryAfter)
              if (decision.restrict) {
                updateAccount(candidate.uid, { enabled: false, disabledReason: '上游判定账号异常（11140），已停止参与调度' })
              }
              if (decision.rateLimited) {
                // 同号退避重试期间不冷却自己（本轮还要用它），冷却只在换号时落
                logger.warn?.(`[Trae] ${candidate.uid} 限流，${Math.round(decision.delayMs / 1000)}s 后重试`)
              }
              lastError = new TraeError(
                `Trae：${text.slice(0, 300) || `HTTP ${response.status}`}`,
                'HTTP_ERROR',
                response.status,
                decision.delayMs,
              )
              if (decision.action === protocol.RETRY.RETRY && attempt < MAX_SAME_KEY_RETRY) {
                attempt++
                await sleep(decision.delayMs)
                continue
              }
              if (decision.action === protocol.RETRY.SWITCH) {
                // 只有上游/网络侧的失败才计入熔断：积分耗尽、账号受限是「这个号没额度」，
                // 不是「这个号坏了」，冷却已经覆盖，再熔断会白白缩小可用池
                if (response.status === 429 || response.status >= 500) noteFailure(candidate.uid)
                if (protocol.isCreditExhaustedError(text)) {
                  noteCooldown(candidate.uid, 'quota', protocol.nextQuotaReset() - Date.now())
                } else if (response.status === 429) {
                  noteCooldown(candidate.uid, 'rate', Math.max(decision.delayMs, RATE_LIMIT_FALLBACK_MS))
                }
                switched = true
                continue
              }
              // FATAL：请求本身的问题（context 超长等），换号也不会好
              throw lastError
            }

            const result = await consumeSolo(response, {
              model: bare,
              signal: controller.signal,
              reverse,
              // 记账包一层：usage 帧经过时顺手累计到该账号的今日 token（servedUid 已带入）
              onChunk: chunk => {
                if (chunk?.type === 'usage') noteTokenUsage(chunk.usage?.uid, chunk.usage?.totalTokens)
                onChunk(chunk)
              },
              servedUid: candidate.uid,
              onFirstChunk: () => {
                if (timer) clearTimeout(timer)
              },
            })
            noteSuccess(candidate.uid)
            noteModelSuccess(bare)
            rememberSticky(stickyKey, candidate.uid)
            noteAccountSuccess(candidate.uid)
            return result
          } catch (error) {
            if (signal?.aborted) throw error
            if (firstByteTimeout) {
              // 建连了但一直没有首字：还没吐任何内容，重放是安全的
              noteFailure(candidate.uid)
              lastError = new TraeError(
                `Trae：${Math.round(now.firstByteMs / 1000)}s 无首字，已换号`,
                'FIRST_BYTE_TIMEOUT',
                504,
              )
              switched = true
              continue
            }
            // 流内可换号错误：只有**还没吐内容**时才换号（吐了一半重放会重复计费）
            const rotatable = error instanceof TraeError && protocol.ROTATABLE_STREAM_ERRORS.has(Number(error.code))
            if (rotatable) {
              noteCooldown(candidate.uid, 'quota', protocol.nextQuotaReset() - Date.now())
              lastError = error
              switched = true
              continue
            }
            // 认证失效：换下一个账号（同一个号没有第二次机会）
            if (error instanceof TraeError && error.code === 'AUTH') {
              lastError = error
              switched = true
              continue
            }
            // 5xx / 零产出：算账号一次失败，也算模型一次抖动
            if (error instanceof TraeError && (Number(error.statusCode) >= 500 || error.code === 'EMPTY')) {
              noteFailure(candidate.uid)
              noteModelFailure(bare)
              lastError = error
              switched = true
              continue
            }
            throw error
          } finally {
            if (timer) clearTimeout(timer)
            signal?.removeEventListener?.('abort', onClientAbort)
          }
        }
      } finally {
        leaveInflight(candidate.uid)
      }
    }

    if (lastError) throw lastError
    const any = usableAccounts('')
    if (any.length === 0) throw new TraeError('Trae 没有可用账号，请先登录', 'AUTH', 401)
    throw new TraeError(`Trae 的账号都在 ${bare} 上受限，请稍后再试`, 'QUOTA_EXCEEDED', 429)
  }

  // ── 登录 ──

  // 起一次登录：返回登录 URL 与 state。回调由本地 HTTP 服务接收（shared/login-server）。
  async function startLogin() {
    const machineId = protocol.generateMachineId()
    // 官方的 device_id 是 16 位纯数字；机器标识仍是 32 位 hex
    const deviceId = protocol.generateDeviceId()
    const state = accounts.randomSuffix()
    // PKCE 与设备密钥对必须与这一轮绑定：授权码换证时要用同一份 verifier 与公钥
    const pkce = protocol.pkcePair()
    const deviceKeys = protocol.generateDeviceKeys()
    const session = { machineId, deviceId, codeVerifier: pkce.verifier, deviceKeys, createdAt: Date.now() }
    const callback = await loginServer.start({
      provider: 'trae',
      state,
      onCallback: async (rawUrl) => {
        const parsed = protocol.parseCallback(rawUrl)
        if (!parsed.ok) throw new Error(parsed.reason)
        const credential = await exchangeCallback(parsed.info, session)
        const uid = credential.uid
        accounts.setCredential(dataDir, 'trae', uid, credential)
        updateAccount(uid, { name: protocol.displayName(credential, accounts.accountId('trae', uid)), enabled: true, addedAt: Date.now() })
        await fetchCatalog({ force: true })
        return 'Trae 登录成功，可以关闭此页面回到 AiRoute'
      },
    })
    logins.set(state, session)
    // start() 返回的是 { callbackUrl, wait }，回调地址要从 callbackUrl 里取：
    // 直接把整个对象拼进 URL 会得到 auth_callback_url=[object Object]，
    // Trae 登录页拿不到回调地址，会永远停在「认证中」
    return {
      loginUrl: protocol.buildLoginUrl(machineId, deviceId, callback.callbackUrl, {
        codeChallenge: pkce.challenge,
        // 官网同步的客户端版本号（每天自动更新；同步失败回落内置默认）
        versions: versions?.get?.().trae || {},
      }),
      state,
    }
  }

  // 用回调里的 refreshToken 换 access token，再补一次用户信息
  // 授权码换证（PKCE）：v3 ExchangeToken 换，带上本轮 code_verifier 与设备公钥
  async function exchangeAuthCode(info, session) {
    const built = protocol.buildAuthCodeExchange({
      authCode: info.authCode,
      codeVerifier: session.codeVerifier || '',
      publicKey: session.deviceKeys?.publicKey || '',
      machineId: session.machineId,
      deviceId: session.deviceId,
    }, versions?.get?.().trae?.appVersion)
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': protocol.USER_AGENT,
      // 官方客户端在这个端点上带的是空 token 头（见 Agent2API）
      'x-cloudide-token': '',
    }
    let lastError
    for (const url of built.urls) {
      try {
        const response = await request(url, { method: 'POST', headers, body: built.body })
        const text = await response.text().catch(() => '')
        if (!response.ok) {
          lastError = new TraeError(`Trae 授权码换证失败（HTTP ${response.status}）：${text.slice(0, 160)}`, 'AUTH', response.status)
          continue
        }
        let data
        try {
          data = JSON.parse(text)
        } catch {
          lastError = new TraeError('Trae 换证响应不是 JSON', 'AUTH', 502)
          continue
        }
        const parsed = protocol.parseExchangeResponse(data)
        if (parsed) return parsed
        lastError = new TraeError('Trae 换证响应里没有 Token', 'AUTH', 502)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new TraeError('Trae 授权码换证失败', 'AUTH', 502)
  }

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
    } else if (info.authCode && info.authCode.length > 0) {
      // PKCE 新流程：授权码是一次性的，换证失败就没有第二次机会
      exchange = await exchangeAuthCode(info, session)
    } else {
      // 没有 refreshToken / authCode 时只能用回调里的 access token 兜底
      exchange = { accessToken: info.accessToken, refreshToken: '', tokenExpireAt: 0, tokenExpireDuration: 0 }
    }
    let userInfo = { uid: info.uid, screenName: info.nickname, enterpriseId: info.enterpriseId, phone: '', email: '' }
    try {
      const headers = protocol.oauthHeaders()
      headers['X-Cloudide-Token'] = exchange.accessToken
      const response = await request(`${protocol.OAUTH_HOST}${protocol.USER_INFO_PATH}`, {
        method: 'POST',
        headers,
        // 客户端的 IDEVersion 是 appVersion（3.4.x，见 main.js getUserInfo），
      // 不是聊天头的 0.1.52 —— 用官网同步值
      body: { ReqSource: 'IDE', IDEVersion: versions?.get?.().trae?.appVersion || protocol.IDE_VERSION },
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
    return protocol.buildCredential(exchange, userInfo, {
      machineId: session.machineId,
      deviceId: session.deviceId,
      devicePublicKey: session.deviceKeys?.publicKey,
      devicePrivateKey: session.deviceKeys?.privateKey,
      authClientId: protocol.LOGIN_CLIENT_ID,
    })
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
    // 官方客户端（main.js _requestCheckinCredits）带 req_source：IDE=1、SOLO=2。
    // 我们此前发空 body 也通，但对齐客户端可少一类「被识别为非官方调用」的特征
    const status = await request(`${protocol.UG_HOST}${protocol.CHECKIN_STATUS_PATH}`, {
      method: 'POST', headers, body: { req_source: 1 },
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
      method: 'POST', headers, body: { req_source: 1 },
    })
    const gained = after.ok ? protocol.parseCheckinStatus(await after.json().catch(() => ({}))) : undefined
    const credit = gained?.credits
    return { outcome: 'claimed', ...credit > 0 ? { credit } : {} }
  }

  // 主动校验令牌（客户端 checkLogin 同款）：CheckLogin 不消耗积分、只看
  // Result.IsLogin，比「发一次对话」便宜得多，适合保活与面板测试。
  // 返回 { valid, errorCode? }
  async function checkLogin(uid) {
    const credential = await resolveCredential(uid)
    const response = await request(`${protocol.OAUTH_HOST}/cloudide/api/v3/trae/CheckLogin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
      },
      body: {
        IDEVersion: versions?.get?.().trae?.appVersion || protocol.IDE_VERSION,
        ReqSource: 'IDE',
        GetAIPayHost: true,
      },
    })
    const body = await response.json().catch(() => ({}))
    const errorCode = body?.ResponseMetadata?.Error?.Code || ''
    if (!response.ok || errorCode || body?.Result?.IsLogin === false) {
      return { valid: false, errorCode: errorCode || `HTTP ${response.status}` }
    }
    return { valid: true }
  }

  // 余额 = Σ(资源包上限 - 已用)，见 protocol.parseCreditBalance。
  // 请求体带 require_usage 才回 usage（缺了它只有额度上限，算不出剩余）。
  // req_source 对齐客户端：IDE=1（此前发 2 是 SOLO 的口径）
  async function balance(uid) {
    const credential = await resolveCredential(uid)
    const response = await request(`${protocol.UG_HOST}${protocol.ENT_USAGE_PATH}`, {
      method: 'POST',
      headers: protocol.checkinHeaders(credential),
      body: { require_usage: true, req_source: 1 },
    })
    if (!response.ok) throw new TraeError(`积分余额查询失败（HTTP ${response.status}）`, 'HTTP_ERROR', response.status)
    const parsed = protocol.parseCreditBalance(await response.json().catch(() => ({})))
    // 余额回写：选号策略要按「还剩多少钱 / 什么时候过期」排序，只查不存等于白查。
    // 到期时间取所有还有剩余的资源包里最早的那个 —— 先到期的积分该先花。
    const expiries = parsed.packages
      .filter(item => item.remaining > 0 && item.expireAt > 0)
      .map(item => item.expireAt)
    patchAccountQuiet(uid, {
      credits: parsed.total,
      creditsFetchedAt: Date.now(),
      creditsExpireAt: expiries.length > 0 ? Math.min(...expiries) : 0,
    })
    return parsed
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
    cooldowns.clear()
    breakers.clear()
    inflight.clear()
    modelCooldowns.clear()
    sticky.clear()
    usageStats.clear()
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
    checkLogin,
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
