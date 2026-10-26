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

// PKCE 字符集：RFC 7636 的 unreserved（66 个），与官方实现同一集合
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

// ── 产品配置 ──

// 目录 key 与展示名。采样自 2026-09 的客户端目录；远端目录拉不到时用它兜底。
const COMMON_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 200000, supportsImage: true, supportsThinking: true },
  { id: 'smodel', name: 'Sonus', contextWindow: 1000000, supportsImage: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'cmodel', name: 'Cantus', contextWindow: 1000000, supportsImage: true, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'max', 'low'], defaultEffort: 'max' },
  { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 1000000, supportsImage: true },
  // 免费额度模型：e2e 探针用它以免消耗积分（priceFactor 0 是**免费**，不是缺失）
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1000000, supportsImage: true, isFree: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1000000, supportsImage: true, isFree: true, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium' },
  // 这两个只有「关闭思考」，没有档位表
  { id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1000000, supportsImage: true },
  { id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1000000, supportsImage: true },
]

const CN_ONLY_MODELS = [
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1000000, supportsImage: true },
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1000000, supportsImage: true, efforts: ['high', 'max'], defaultEffort: 'max' },
  // CN 的 mmodel 是 M2.7 且不支持图片，档位表只有 200K 一档
  { id: 'mmodel_cn', name: 'MiniMax-M2.7', contextWindow: 200000 },
]

const PRODUCTS = {
  qoder: {
    id: 'qoder',
    displayName: 'Qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    // ⚠️ 加密端点在 api2.qoder.sh；api2-v2.qoder.sh 是公开端点，混用会 404
    inferBase: 'https://api2.qoder.sh',
    // 取自 asar 的 authClientIds.prod。用 testClientId 会在授权回调阶段被拒
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    userAgentPrefix: 'qoder',
    // 决定服务端把请求路由到哪个池；缺 business 的请求会落到故障节点
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
    models: COMMON_MODELS,
  },
  qodercn: {
    id: 'qodercn',
    displayName: 'Qoder (国内版)',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    // CN 的 algo 网关换了域名，路径与协议同形
    inferBase: 'https://gateway.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    userAgentPrefix: 'qoder',
    clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
    models: [...COMMON_MODELS, ...CN_ONLY_MODELS.filter(model => !COMMON_MODELS.some(each => each.id === model.id))],
  },
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
  PRODUCTS,
  createPkce,
  createDeviceSession,
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
  unwrapEnvelopeChunk,
  classifyInner,
}
