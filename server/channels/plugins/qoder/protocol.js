// Qoder 协议：产品配置、PKCE 设备码登录、凭据续期、信封剥离
//
// 协议来源：Qoder 0.3.4 桌面端的逆向分析，与 dsh 渠道包的
// `vendor/channel-pack/src/qoder*.ts` 对齐。这里只做纯函数与常量，
// 网络在 provider.js，WASM 加密在 wasm.js。
//
// ## 三件容易混的事
//
// 1. **设备码不是浏览器回调**：`authBase/device/selectAccounts` 只是让用户在
//    网页里确认授权页，真正的令牌由 `openApiBase/api/v1/deviceToken/poll` 轮询取回；
// 2. **续期与轮询不同 host**：轮询/续期都挂 `openApiBase`，不是 `authBase`。
//    写错 host 会让登录永远失败（qoder.com 上该路径回 401）；
// 3. **加密推理只认目录 key**（`qfmodel` / `dmodel`），公开端点只认通用名，
//    两者不能互换。

const crypto = require('crypto')

const REQUEST_TIMEOUT_MS = 30000
const LOGIN_TIMEOUT_MS = 300000
const POLL_INTERVAL_MS = 1000

const DEVICE_SELECT_PATH = '/device/selectAccounts'
const POLL_PATH = '/api/v1/deviceToken/poll'
const REFRESH_PATH = '/api/v1/deviceToken/refresh'
const USERINFO_PATH = '/api/v1/userinfo'
// 积分余额（挂 openApiBase）。⚠️ 与模型列表不同，这个端点**不需要 WASM 签名**，
// 只要 Bearer；早期因「模型列表要签名」而误判 Qoder 无积分端点。
// 响应形状（实测 2026-09）：
//   { displayMode:"qoder", qoderUsage:{ userQuota:{total,used,remaining},
//     addOnQuota:{…}, dedicatedResourcePackages:[…] } }
// ⚠️ 余额不只在 userQuota：实测有账号 userQuota.remaining=0 而 addOnQuota.remaining=100，
// 只读一层会显示 0 —— 三层（套餐/资源包/专用资源包）都要加。
const USAGE_PATH = '/sash/api/v2/me/usage'
// 活动平台（每日领取积分）：官方桌面端 0.4.8 主进程调它。
// ⚠️ 头集合必须逐字对齐，且**不发任何 cosy-machine\*** —— 派生值会让服务端把
// 「每日领取 100 Credits」整条静默过滤（HTTP 200 + 只剩 VIEW_DETAILS）。
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
const campaignClaimPath = id => `/sash/api/v1/me/campaigns/${encodeURIComponent(String(id))}/claim`
// 旧签到端点（部分区域已下线，只剩活动平台）：404/405/410 才算「本区没有」
const CHECKIN_STATUS_PATH = '/sash/api/v1/me/daily-check-in/status'
const CHECKIN_CLAIM_PATH = '/sash/api/v1/me/daily-check-in/claim'
// 桌面端身份：活动平台缺任一都会「200 + 空列表」
const DESKTOP_CLIENT_TYPE = '10'
const DESKTOP_CLIENT_VERSION = '0.4.8'

// PKCE 字符集：RFC 7636 的 unreserved（66 个），与官方实现同一集合
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

// ── 产品配置 ──

// 目录 key 与展示名。采样自 2026-09 的客户端目录；远端目录拉不到时用它兜底。
//
// ⚠️ 字段口径按官方 `context_config` / `thinking_config` 还原，别照抄「能力上限」：
//   · contextWindow 用**默认档**（官方多为 200K），1M 是可选档，写 1M 会让客户端
//     按 1M 估算上下文、迟迟不压缩，真到 800K 时被上游直接拒；
//   · maxInputTokens 是官方 `max_input_tokens`（部分模型 180K），下发加密请求体时用它；
//   · efforts 的默认档来自 `thinking_config.enabled.efforts[*].is_default`；
//   · isFree 是官方 `is_free`（免费额度模型），面板据此打「免费」标签。
const COMMON_MODELS = [
  // auto 官方 enable=false（按账号套餐开放），保留 key 只为不打断已有配置
  { id: 'auto', name: 'Auto', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true, supportsThinking: true },
  {
    id: 'smodel', name: 'Sonus', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
    efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high',
  },
  {
    id: 'cmodel', name: 'Cantus', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
    efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high',
  },
  {
    id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
    efforts: ['high', 'low', 'max'], defaultEffort: 'max',
  },
  {
    id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true,
    efforts: ['high', 'low', 'max'], defaultEffort: 'max',
  },
  {
    id: 'gmodel', name: 'GLM-5.3', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
    efforts: ['high', 'low', 'max'], defaultEffort: 'max',
  },
  {
    id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true,
    efforts: ['high', 'max'], defaultEffort: 'max',
  },
  {
    id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true,
    efforts: ['high', 'max'], defaultEffort: 'max',
  },
  {
    id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true,
    efforts: ['high', 'max', 'low'], defaultEffort: 'max',
  },
  {
    id: 'mmodel', name: 'MiniMax-M3', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
  },
  // 免费额度模型：e2e 探针用它以免消耗积分（priceFactor 0 是**免费**，不是缺失）
  {
    id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
    isFree: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'xhigh',
  },
  {
    id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 200000, maxInputTokens: 180000, supportsImage: true,
    isFree: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium',
  },
  // 这两个只有「关闭思考」，没有档位表
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true },
]

// CN 独有的模型（intl 目录里没有这两个 key；采样自官方 cn 目录）
const CN_ONLY_MODELS = [
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true },
  {
    id: 'gm51model', name: 'GLM-5.2', contextWindow: 200000, maxInputTokens: 200000, supportsImage: true,
    efforts: ['high', 'max'], defaultEffort: 'max',
  },
]

// 双区同 key 不同型号：CN 的 mmodel 是 MiniMax-M2.7（不支持图片、默认 200K）。
// ⚠️ 上游只认 key `mmodel`，以前的 `mmodel_cn` 是我们自己编的伪 key ——
// 发上去会 400，所以这里改成「按区域覆盖同名条目 + 保留旧别名」。
const CN_MODEL_OVERRIDES = [
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200000, maxInputTokens: 200000, supportsImage: false },
]

// 历史别名：老配置里可能引用过这些 id，路由时要能认出来（不新增对外 id）
const MODEL_ALIASES = {
  mmodel_cn: 'mmodel',
  'minimax-m2.7': 'mmodel',
  'minimax-m3': 'mmodel',
  'kimi-k3': 'kmodel_latest',
  'kimi-k2.8-preview': 'kmodel',
  'glm-5.3': 'gmodel',
  'glm-5.3-flash': 'gfmodel',
  'glm-5.2': 'gm51model',
  'deepseek-v4-pro': 'dmodel',
  'deepseek-flash': 'dfmodel',
  'qwen3.8-max': 'qmodel_38max',
  'qwen3.8-flash': 'qfmodel',
  'qwen3.7-max': 'qmodel_latest',
  'qwen3.7-plus': 'qmodel',
  'qwen3.7-flash': 'q37fmodel',
  sonus: 'smodel',
  cantus: 'cmodel',
  ultimate: 'smodel',
}

const PRODUCTS = {
  qoder: {
    id: 'qoder',
    displayName: 'Qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    // 活动平台（每日领取积分）的候选基址：主域不通时按序回落。
    // 只有「连接失败 / 404 / 405 / 410」才换下一个；401/403/429 属于业务错误，换基址没用。
    openApiCandidates: ['https://openapi.qoder.sh', 'https://center.qoder.sh', 'https://openapi.qoder.com'],
    // ⚠️ 加密端点在 api2.qoder.sh；api2-v2.qoder.sh 是公开端点，混用会 404
    inferBase: 'https://api2.qoder.sh',
    // 推理域名的兜底序列：COSY 签名只覆盖 path，换 host 不影响签名有效性
    inferHosts: ['https://api2.qoder.sh', 'https://api1.qoder.sh', 'https://api3.qoder.sh'],
    // 取自 asar 的 authClientIds.prod。用 testClientId 会在授权回调阶段被拒
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    userAgentPrefix: 'qoder',
    // 活动平台要求逐字 'Qoder'，且必须带桌面端身份头（缺了会「200 + 空列表」）
    desktopUserAgent: 'Qoder',
    // 决定服务端把请求路由到哪个池；缺 business 的请求会落到故障节点
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
    models: COMMON_MODELS,
  },
  qodercn: {
    id: 'qodercn',
    displayName: 'Qoder (国内版)',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    openApiCandidates: ['https://openapi.qoder.com.cn', 'https://qoder.com.cn'],
    // CN 的 algo 网关换了域名，路径与协议同形
    inferBase: 'https://gateway.qoder.com.cn',
    inferHosts: ['https://gateway.qoder.com.cn'],
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    userAgentPrefix: 'qoder',
    desktopUserAgent: 'Qoder',
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
    models: mergeModels(COMMON_MODELS, CN_MODEL_OVERRIDES, CN_ONLY_MODELS),
  },
}

// 按 id 覆盖再追加：保证「同 key 不同型号」与「区域独占」都表达得出来
function mergeModels(base, overrides = [], extra = []) {
  const byId = new Map(base.map(model => [model.id, model]))
  for (const model of overrides) byId.set(model.id, model)
  const out = [...byId.values()]
  for (const model of extra) if (!byId.has(model.id)) out.push(model)
  return out
}

/**
 * 客户端填的模型名 → 上游目录 key。
 *
 * 接受：裸 key、展示名（Qwen3.8-Max）、小写展示名、历史别名，以及 `key (Name)` 形态。
 * 官方客户端允许用户填展示名，只认裸 key 会让「Qwen3.8-Max」直接 400。
 */
function resolveModelKey(productId, input) {
  const product = PRODUCTS[productId]
  const raw = String(input || '').trim()
  if (!product || !raw) return ''
  const stripped = raw.replace(/^[^/]*\//, '') // 去掉 provider/ 前缀
  const candidates = [stripped]
  const paren = stripped.match(/^(.+?)\s*\((.*)\)$/)
  if (paren) candidates.push(paren[1].trim(), paren[2].trim())
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase()
    const hit = product.models.find(model =>
      model.id === candidate || model.id.toLowerCase() === lower || (model.name || '').toLowerCase() === lower)
    if (hit) return hit.id
    if (MODEL_ALIASES[lower] && product.models.some(model => model.id === MODEL_ALIASES[lower])) {
      return MODEL_ALIASES[lower]
    }
  }
  return ''
}

// ── PKCE 设备码登录 ──

function createPkce() {
  const length = 43 + Math.floor(86 * Math.random())
  const bytes = crypto.randomBytes(length)
  let verifier = ''
  for (let i = 0; i < length; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length]
  // ⚠️ 必须去掉 base64 的 `=` padding，带 padding 服务端校验失败
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// machine_id 由本实现生成并**持久化**：官方用硬件指纹（SMBIOS UUID 再加盐 hash），
// 那不可移植；随机 UUID 在实测中同样被接受，续期时原样回传即可。
function createDeviceSession(machineId) {
  return {
    pkce: createPkce(),
    nonce: crypto.randomUUID(),
    machineId: machineId || crypto.randomUUID(),
  }
}

// 授权页 URL：client_id 必须用 prod 的那个
function buildAuthUrl(session, product) {
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: product.clientId,
  })
  return `${product.authBase}${DEVICE_SELECT_PATH}?${query.toString()}`
}

// 轮询 URL 挂 openApiBase（不是 authBase）
function buildPollUrl(session, product) {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  })
  return `${product.openApiBase}${POLL_PATH}?${query.toString()}`
}

// 毫秒时间戳：10 位当秒、13 位当毫秒；解析不出来返回 undefined
// （**绝不填 0**：「没有过期时间」与「1970 年过期」是两回事）
function readTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function readString(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

// token 响应：登录用 `token`，续期用 `device_token`，两个都接受
function parseTokenPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { accessToken: '' }
  const accessToken = readString(value, ['token', 'device_token', 'access_token']) ?? ''
  const refreshToken = readString(value, ['refresh_token', 'refreshToken'])
  const expiresAt = readTimestamp(value.expires_at ?? value.expiresAt ?? value.expire_time)
  const refreshExpiresAt = readTimestamp(value.refresh_token_expires_at ?? value.refreshTokenExpiresAt)
  // 设备码响应里的 user_id 是加密推理的必需项（用来派生 encrypt_user_info）
  const uid = readString(value, ['user_id', 'userId'])
  const userName = readString(value, ['user_name', 'userName'])
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...refreshExpiresAt === undefined ? {} : { refreshExpiresAt },
    ...uid === undefined ? {} : { uid },
    ...userName === undefined ? {} : { userName },
  }
}

// security_oauth_token 与 access_token **双写同值**：Qoder 的取用顺序是
// `security_oauth_token ?? access_token`，双写兼容两条路径
function buildCredential(payload, extra) {
  const nickname = extra.nickname || payload.userName
  return {
    security_oauth_token: payload.accessToken,
    access_token: payload.accessToken,
    ...payload.refreshToken === undefined ? {} : { refresh_token: payload.refreshToken },
    ...payload.expiresAt === undefined ? {} : { expire_time: payload.expiresAt },
    ...payload.refreshExpiresAt === undefined ? {} : { refresh_token_expire_time: payload.refreshExpiresAt },
    machine_id: extra.machineId,
    ...payload.uid === undefined ? {} : { uid: payload.uid },
    ...nickname ? { nickname } : {},
  }
}

function credentialExpiresAtMs(credential) {
  return credential?.expire_time
}

function isRefreshable(credential) {
  return typeof credential?.refresh_token === 'string' && credential.refresh_token.length > 0
}

function isExpired(credential, nowMs = Date.now()) {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= nowMs
}

function refreshBody(credential) {
  return { refresh_token: credential.refresh_token ?? '', machine_id: credential.machine_id }
}

function bearerToken(credential) {
  const token = credential?.security_oauth_token
  if (typeof token === 'string' && token.length > 0) return token
  return typeof credential?.access_token === 'string' ? credential.access_token : ''
}

function displayName(credential, fallbackId) {
  const nickname = credential?.nickname
  return typeof nickname === 'string' && nickname.trim().length > 0 ? nickname.trim() : fallbackId
}

// 续期结果覆盖旧凭据：machine_id / uid / nickname 不在续期响应里，必须保留
// （丢了会让下一次续期缺设备标识、让加密推理缺 uid）
function applyRefresh(credential, payload) {
  const next = buildCredential(payload, { machineId: credential.machine_id, nickname: credential.nickname })
  if (next.refresh_token === undefined && credential.refresh_token !== undefined) {
    next.refresh_token = credential.refresh_token
  }
  if (next.uid === undefined && credential.uid !== undefined) next.uid = credential.uid
  return next
}

// 设备码登录拿不到过期时间时的兜底寿命。官方设备令牌实测约 30 天；
// 不写 expire_time 会让 needsRefresh 永远为假 —— 该号永不主动续期，只能等 401。
const DEFAULT_CREDENTIAL_TTL_MS = 30 * 24 * 3600 * 1000

// machine_id 由 (安装盐, uid) 派生：同一账号换一次登录不该变成「另一台设备」。
// 形状要与官方一致（UUIDv4：第 13 位 4、第 17 位 8/9/a/b）。
function deriveMachineId(seed) {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = 'a'
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

// 每日领取窗口：固定 UTC+8 10:00（不用系统时区 —— 用户机器时区改了不该影响判据）
const CHECKIN_WINDOW_HOUR = 10
const UTC8_OFFSET_MS = 8 * 3600 * 1000

function nextCheckinWindow(nowMs = Date.now()) {
  // 换算到 UTC+8 的「日历日」，算出距下一个 10:00 的毫秒数
  const shifted = nowMs + UTC8_OFFSET_MS
  const dayStart = Math.floor(shifted / 86400000) * 86400000
  const windowStart = dayStart + CHECKIN_WINDOW_HOUR * 3600 * 1000
  const next = shifted < windowStart ? windowStart : windowStart + 86400000
  return next - UTC8_OFFSET_MS
}

// ── 积分余额 ──

// 安全读数字：上游可能发字符串数字；解析不出返回 undefined（不编造 0）
function readNumberField(source, key) {
  if (typeof source !== 'object' || source === null) return undefined
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

// 一个 quota 对象 → { total, used, remaining }；三个字段都缺时返回 undefined。
// remaining 优先取服务端字段，缺失按 total-used 算；负值钳到 0（计量回滚时上游会发负数）。
function parseQuota(quota) {
  const total = readNumberField(quota, 'total')
  const used = readNumberField(quota, 'used')
  const remainingRaw = readNumberField(quota, 'remaining')
  if (total === undefined && used === undefined && remainingRaw === undefined) return undefined
  const totalValue = Math.max(0, total ?? 0)
  const usedValue = Math.max(0, used ?? 0)
  const remaining = remainingRaw !== undefined
    ? Math.max(0, remainingRaw)
    : Math.max(0, totalValue - usedValue)
  return { total: totalValue, used: usedValue, remaining }
}

/**
 * 解析 /sash/api/v2/me/usage 的响应。
 *
 * 返回 { total, packages }（packages 仅用于测试与排查，面板只显示 total）；
 * 一个包都没解析出来（企业版 / 形状不符）返回 null —— 那是「查不到」，
 * 与「余额为 0」严格区分，后者会让用户以为额度被清空了。
 */
function parseUsageBalance(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  // 企业版没有额度数字，只有外部链接；报 0 会误导
  if (body.displayMode === 'enterprise') return null
  const usage = body.qoderUsage
  if (typeof usage !== 'object' || usage === null) return null
  const packages = []
  let unlimited = false
  const plan = parseQuota(usage.userQuota)
  if (plan) packages.push({ name: '套餐额度', ...plan })
  const addOn = parseQuota(usage.addOnQuota)
  if (addOn) packages.push({ name: '资源包', ...addOn })
  for (const key of ['dedicatedResourcePackages', 'orgResourcePackages']) {
    const list = Array.isArray(usage[key]) ? usage[key] : []
    for (const item of list) {
      const pkg = parseQuota(item)
      if (pkg) packages.push({ name: key === 'dedicatedResourcePackages' ? '专用资源包' : '组织资源包', ...pkg })
    }
  }
  // 团队/共享池：`cap`（或 total）为负数表示不限量，报 0 会让团队号看起来「已耗尽」
  for (const key of ['sharedQuota', 'teamQuota', 'orgSharedQuota']) {
    const quota = usage[key]
    if (!quota || typeof quota !== 'object') continue
    const cap = readNumberField(quota, 'cap')
    if (cap !== undefined && cap < 0) unlimited = true
    const pkg = parseQuota(quota)
    if (pkg) packages.push({ name: '共享池', ...pkg })
    else if (cap !== undefined && cap < 0) packages.push({ name: '共享池', total: 0, used: 0, remaining: 0 })
  }
  if (packages.length === 0) return null
  // 逐包保留两位再合计，抑制浮点尾数
  const total = Math.round(packages.reduce((sum, pkg) => sum + pkg.remaining, 0) * 100) / 100
  return { total, packages, ...unlimited ? { unlimited: true } : {} }
}

// ── 响应信封 ──

function innerTextOf(payload) {
  let envelope
  try {
    envelope = JSON.parse(payload)
  } catch {
    return null
  }
  // 缺 body 字段就不是信封 → 视为已经是标准帧
  if (envelope === null || typeof envelope !== 'object' || envelope.body === undefined) return null
  return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body)
}

// 内层帧分类。⚠️ 不能用「不含 `"choices"` 就是错误」这种字符串嗅探：
// 心跳帧 `body: null` 会被误判成业务错误（模型正常答完却报失败），
// 而错误文案里恰好含 `"choices"` 的帧会被静默透传。
function classifyInner(inner) {
  const trimmed = inner.trim()
  if (trimmed.length === 0) return 'heartbeat'
  if (trimmed.includes('[DONE]')) return 'chunk'
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return 'error'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'heartbeat'
  if (Array.isArray(parsed.choices) || parsed.usage !== undefined) return 'chunk'
  if (parsed.code !== undefined || parsed.message !== undefined || parsed.error !== undefined
    || parsed.statusCodeValue !== undefined || parsed.type !== undefined) return 'error'
  return 'heartbeat'
}

// 排队信息解析（与 vendor channel-pack 的 model-queue.parseQueueError 同口径）：
// 广度优先展开 data / result / message / body，字符串再 JSON.parse 一次 ——
// 排队参数藏在外层 code 的 message JSON 字符串里，只看顶层永远拿不到。
//
// ⚠️ 判据是「命中 code=10605 或出现排队字段」而不是「isQueued === true」：
// 内层帧没有 code 字段，且瞬时排队实测为 isQueued:false + serviceAvailable:true，
// 那也是排队（该按服务端给的 waitTime 重发）。
function parseQueueInfo(value) {
  let root = value
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root)
    } catch {
      return undefined
    }
  }
  if (root === null || typeof root !== 'object') return undefined
  const seen = new Set()
  const nodes = []
  const queue = [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    nodes.push(node)
    for (const key of ['data', 'result', 'message', 'body']) {
      const child = node[key]
      if (child !== null && typeof child === 'object') queue.push(child)
      else if (typeof child === 'string' && child.length > 0) {
        try { queue.push(JSON.parse(child)) } catch { /* 非 JSON，忽略 */ }
      }
    }
  }
  const info = nodes.find(node => node.isQueued !== undefined || node.serviceAvailable !== undefined)
  if (!info) return undefined
  const codeHit = nodes.some(node => String(node.code) === '10605')
  if (!codeHit && info.isQueued === undefined) return undefined
  const out = {}
  if (typeof info.isQueued === 'boolean') out.isQueued = info.isQueued
  if (typeof info.subCode === 'string' && info.subCode.length > 0) out.subCode = info.subCode
  if (typeof info.queueType === 'string' && info.queueType.length > 0) out.queueType = info.queueType
  for (const key of ['retryAfterSeconds', 'waitTime']) {
    const num = Number(info[key])
    if (Number.isFinite(num)) out[key] = Math.trunc(num)
  }
  return out
}

// 把信封 SSE 转成标准 OpenAI SSE 文本。
//
// ⚠️ 业务错误的 `code` 必须保持为**独立字段**、`message` 原样：
// 拼成「… (10605)」会让下游的排队识别（依赖顶层 code）永远不命中，
// 于是按普通错误快速退避重试，而服务端要求等 30 秒 —— 永远等不到。
function unwrapEnvelopeChunk(rawLine) {
  const payload = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : null
  if (payload === null) return `${rawLine}\n`
  if (payload === '[DONE]') return 'data: [DONE]\n'
  const inner = innerTextOf(payload)
  if (inner === null) return `data: ${payload}\n`
  const kind = classifyInner(inner)
  if (kind === 'heartbeat') return ''
  if (kind === 'error') {
    let code
    let message = inner
    try {
      const parsed = JSON.parse(inner)
      if (parsed.code !== undefined) code = parsed.code
      if (typeof parsed.message === 'string') message = parsed.message
    } catch { /* 保持原文 */ }
    return `data: ${JSON.stringify({ ...code === undefined ? {} : { code }, message, type: 'model_error' })}\n`
  }
  return `data: ${inner}\n`
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  LOGIN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  REFRESH_PATH,
  USERINFO_PATH,
  USAGE_PATH,
  CAMPAIGNS_PATH,
  campaignClaimPath,
  CHECKIN_STATUS_PATH,
  CHECKIN_CLAIM_PATH,
  DESKTOP_CLIENT_TYPE,
  DESKTOP_CLIENT_VERSION,
  DEFAULT_CREDENTIAL_TTL_MS,
  PRODUCTS,
  createPkce,
  createDeviceSession,
  deriveMachineId,
  nextCheckinWindow,
  resolveModelKey,
  buildAuthUrl,
  buildPollUrl,
  parseTokenPayload,
  buildCredential,
  credentialExpiresAtMs,
  isRefreshable,
  isExpired,
  refreshBody,
  bearerToken,
  displayName,
  applyRefresh,
  parseUsageBalance,
  unwrapEnvelopeChunk,
  parseQueueInfo,
  classifyInner,
}
