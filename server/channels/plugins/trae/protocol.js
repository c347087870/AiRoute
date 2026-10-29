// Trae（字节跳动 Trae IDE）协议：端点、凭据、请求头、SOLO 请求体与目录解析
//
// 协议来源：Trae2api / Traework2api 的逆向分析，与 dsh 渠道包的
// `vendor/channel-pack/src/Trae*.ts` 逐条对齐（那张实现经过大量实测修正，
// 注释里每条 ⚠️ 都是踩过的坑，搬运时不要「简化」掉）。
//
// 与 AiRoute 的分工：本文件只做**纯函数与常量**，不发请求、不碰磁盘。
// 网络与状态在 provider.js，这样协议细节能被离线单测直接覆盖。
//
// ## 协议速览
//
// | 用途 | 方法 | 路径 | Host |
// | --- | --- | --- | --- |
// | 对话（SOLO 自定义 SSE） | POST | `/api/agent/v3/llm_utils_chat` | trae-api-cn.mchost.guru |
// | 模型目录 | POST | `/api/ide/v1/batch_get_detail_param` | 同上 |
// | 换 token | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | api.trae.com.cn |
// | 用户信息 | POST | `/cloudide/api/v3/trae/GetUserInfo` | 同上 |
// | 签到状态 / 领取 | POST | `/trae/api/v2/ug/checkin_credits/{status,claim}` | api.trae.cn |
// | 积分余额 | POST | `/trae/api/v2/pay/ide_user_ent_usage` | api.trae.cn |
//
// ⚠️ 对话端点返回的是**自定义 SSE 事件**（`event: output` / `token_usage` /
// `done`），不是 OpenAI 标准帧，必须解析后重映射（见 sse.js）。

const crypto = require('crypto')

const AGENT_HOST = 'https://trae-api-cn.mchost.guru'
const UG_HOST = 'https://api.trae.cn'
const OAUTH_HOST = 'https://api.trae.com.cn'
const CONSOLE_HOST = 'https://www.trae.cn'

const CHAT_PATH = '/api/agent/v3/llm_utils_chat'
const BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param'
const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
const USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo'
const CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
const CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
const ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'

const REQUEST_TIMEOUT_MS = 30000
const DEFAULT_MODEL = 'glm-5.2'
const DEFAULT_FUNCTION = 'solo_work_lite'

// 版本号是**模型准入条件**：上游按 X-Ide-Version 决定返回哪些模型，
// 版本过低时 glm-5.3 等新模型会报 4001。跟随 Trae 更新时一起动这两个值。
const IDE_VERSION = '0.1.52'
const IDE_VERSION_CODE = '20260811'

// ── 登录页参数（按 Trae 桌面客户端实测链接对齐）──
// 登录页按客户端形态（auth_from / client_id / 版本号）校验，版本过旧会被判成
// 「非官方客户端」而不给授权码。版本号由宿主的 version-sync 每天从官网同步
// （changelog + 本机安装双源取最大），这里只存**兜底默认值**——同步还没完成
// 或两个源都失败时用它，保证登录不至于整体不可用。
const LOGIN_AUTH_FROM = 'trae'
const LOGIN_CLIENT_ID = 'ono9krqynydwx5' // IDE 应用；SOLO 是 en1oxy7wnw8j9n
const LOGIN_DEVICE_TYPE = 'windows'
const LOGIN_DEVICE_BRAND = '20XHA000CD'
const LOGIN_OS_VERSION = 'Windows 11 Home China'
const LOGIN_CHANNEL_NAME = 'common'
const LOGIN_APP_TYPE = 'stable'
// 可被 version-sync 覆盖的两个版本号（登录链接 plugin_version 与 x_app_version）
const LOGIN_FALLBACK = { pluginVersion: '2.3.97430', appVersion: '3.4.9' }
// 授权码换证：v3 端点（v1 只认 refreshToken 分支，见 provider 的 fallback）
const EXCHANGE_V3_PATH = '/trae/api/v3/oauth/ExchangeToken'

const CLIENT_ID = 'en1oxy7wnw8j9n'
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'
const USER_AGENT = `Trae/${IDE_VERSION}`

// Max 模式（1M 上下文）常量。上游只认 `is_max_mode` + `prompt_max_tokens:168000`
// 这一对（填 1M 会被 4001 拒，真实上下文由上游内部决策），见 maxModeFields。
const MAX_CONTEXT_TOKENS = 1000000
const MAX_OUTPUT_TOKENS = 64000

// 可调用通道白名单（顺序即优先级）。**白名单不只是排序**：22 个 function 里
// 只有这些在本推理端点下真正可调用（chat / builder / inline_chat 实测稳定被拒，
// 且报错文案指向模型，极易误判成「这个模型坏了」）。
const CHANNELS = [
  'solo_agent',
  'solo_work_lite',
  'solo_agent_remote',
  'solo_work_remote',
  'solo_agent_lite',
  'chat_v3',
  'builder_v3',
  'solo_coder',
  'solo_design_lite',
  'solo_design_remote',
  'git_ai',
  'code_reviewer',
  'code_review_summary',
  'multimodal',
  'system_diagnosis',
]

// IDE 真实请求会带上全部 22 个 function：只传聊天通道会让响应里的条目错位
const ALL_FUNCTIONS = [
  'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
  'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
  'custom_agent_generation', 'utils', 'code_reviewer',
  'code_review_summary', 'solo_agent', 'solo_agent_remote',
  'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
  'solo_design_lite', 'solo_design_remote', 'multimodal',
  'system_diagnosis',
]

// 远端目录不可用时的兜底表（2026-08 实测快照）。远端可用时**完全采信远端**。
const FALLBACK_MODELS = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official' },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro' },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430' },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo' },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
  { id: 'glm-5', name: 'GLM-5' },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' },
  { id: 'kimi-k3', name: 'Kimi K3' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'minimax-m3', name: 'MiniMax M3' },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus' },
  { id: 'sagitta', name: 'Sagitta' },
  { id: 'aquila', name: 'Aquila' },
]

// ── 凭据 ──

// machine_id / device_id 必须**持久化**：前者是设备身份（每次换会触发风控或
// 要求重新登录），后者是签到设备号（同一天两个账号共用会被判「该设备已签到」）。
function generateMachineId() {
  // 桌面客户端的 machine_id 是 64 位 hex（sha256 形态），不是 uuid
  return crypto.randomBytes(32).toString('hex')
}

function generateDeviceId() {
  let value = ''
  for (let i = 0; i < 16; i++) value += crypto.randomInt(0, 10)
  return value
}

// 凭据里的 expires_at 可能是毫秒数字串、秒数字串或 ISO；都没有时回退 JWT 的 exp
function credentialExpiresAtMs(credential) {
  const raw = credential?.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1e12 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential?.access_token)
}

// 解 JWT 的 exp（不看签名：只用来算过期时间，令牌真伪由上游判定）
function jwtExpiresAtMs(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function isExpired(credential, nowMs = Date.now()) {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : nowMs >= expiresAt
}

function isRefreshable(credential) {
  return typeof credential?.refresh_token === 'string' && credential.refresh_token.length > 0
}

// 账号展示名：ScreenName 是字节 passport 按 uid 自动生成的（「用户26815487395」
// 这种），多账号时彼此无法区分；脱敏手机号末两位互不相同，是唯一可靠标识
function displayName(credential, fallbackId) {
  for (const value of [credential?.phone, credential?.email, credential?.nickname, credential?.uid]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return fallbackId
}

// ── 请求头 ──

// 同一个 token 要挂在三个头上（Authorization / X-Cloudide-Token / X-Ide-Token），
// 实测缺任一个都可能被拒
function soloHeaders(credential, stream) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Cloudide-Token': credential.access_token,
    'X-Ide-Token': credential.access_token,
    'X-Uid': credential.uid,
    'X-App-Id': APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': IDE_VERSION,
    'X-Ide-Version-Code': IDE_VERSION_CODE,
    'X-App-Version-Code': IDE_VERSION_CODE,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'macos',
    'X-OS-Version': 'macOS 15.7.4',
    'X-Device-Brand': 'Apple',
    'Request-Traffic-Type': 'prod',
  }
  if (credential.machine_id) headers['X-Machine-Id'] = credential.machine_id
  if (credential.device_id) headers['X-Device-Id'] = credential.device_id
  return headers
}

// OAuth（ExchangeToken / GetUserInfo）不带签名，只要 UA
function oauthHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
  }
}

// 签到/积分是一套独立的完整客户端头（约 20 个），简化版会失败。
// 设备身份按 user_id 确定性派生，每个账号独享，避免「每设备每天一次」互斥。
function checkinHeaders(credential) {
  const userId = credential.uid
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': derivedUuid(userId, 'market'),
    'X-User-Region': 'CN',
    'X-Device-Id': derivedDigits(15, userId, 'devid'),
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': IDE_VERSION,
    'X-Tt-Trace-Id': `00-${crypto.randomBytes(8).toString('hex')}-01`,
    'Vscode-Sessionid': derivedHex(32, userId, 'sess'),
    'X-Request-Id': crypto.randomUUID(),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
  }
}

// 确定性伪随机流：同一 (seed, salt) 永远产出同一串字节。
// 算法：SHA256(`salt:seed` ++ counterBE32) 串联 —— 与 trae-mate 的 device_map 一致。
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`
  const out = []
  let counter = 0
  while (out.length < nbytes) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeUInt32BE(counter >>> 0, 0)
    const digest = crypto.createHash('sha256').update(prefix, 'utf8').update(counterBuf).digest()
    for (const byte of digest) {
      out.push(byte)
      if (out.length >= nbytes) break
    }
    counter++
  }
  return out
}

function derivedDigits(length, seed, salt) {
  return seededStream(seed, salt, length).map(byte => String(byte % 10)).join('')
}

function derivedHex(bytes, seed, salt) {
  return Buffer.from(seededStream(seed, salt, bytes)).toString('hex')
}

function derivedUuid(seed, salt) {
  const bytes = seededStream(seed, salt, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// 登录 URL：参数名、顺序与编码方式都被上游钉住。
// 两个致命细节（Agent2API 实测）：
//   ① `auth_callback_url` **不能编码** —— 官方页面对它做正则匹配，编码成
//      `http%3A%2F%2F...` 后拿不到回调地址，页面永远停在「认证中」/「网络错误」；
//   ② 必须带 PKCE（code_challenge + S256），否则页面只回授权码，换不到令牌。
function buildLoginQuery(params) {
  return params
    .map(([key, value, encode]) => `${key}=${encode ? encodeURIComponent(value) : value}`)
    .join('&')
}

function buildLoginUrl(machineId, deviceId, callbackUrl, options = {}) {
  // 版本号优先用宿主同步的官网值；每轮登录都重新读（同步是后台定时任务）
  const synced = options.versions || {}
  const pluginVersion = synced.pluginVersion || LOGIN_FALLBACK.pluginVersion
  const appVersion = synced.appVersion || LOGIN_FALLBACK.appVersion
  const params = [
    ['login_version', '1', false],
    ['auth_from', LOGIN_AUTH_FROM, false],
    ['login_channel', 'native_ide', false],
    ['plugin_version', pluginVersion, true],
    ['auth_type', 'local', false],
    ['client_id', LOGIN_CLIENT_ID, false],
    ['redirect', '0', false],
    // 每次登录一个新的 uuid：复用/推导出来的 trace 会被上游当成重放
    ['login_trace_id', options.traceId || crypto.randomUUID(), true],
    ['auth_callback_url', callbackUrl, false],
    ['machine_id', machineId, true],
    ['device_id', deviceId, true],
    ['x_device_id', deviceId, true],
    ['x_machine_id', machineId, true],
    ['x_device_brand', LOGIN_DEVICE_BRAND, true],
    ['x_device_type', LOGIN_DEVICE_TYPE, true],
    ['x_os_version', LOGIN_OS_VERSION, true],
    // x_env 在桌面客户端里是**空值**：保留参数名，值为空
    ['x_env', '', true],
    ['x_app_version', appVersion, true],
    ['x_app_type', LOGIN_APP_TYPE, true],
    ...(options.codeChallenge
      ? [['code_challenge', options.codeChallenge, true], ['code_challenge_method', 'S256', false]]
      : []),
    ['channel_name', LOGIN_CHANNEL_NAME, false],
  ]
  return `${CONSOLE_HOST}/authorization?${buildLoginQuery(params)}`
}

// PKCE：48 字节 → base64url（无填充），challenge = SHA-256(verifier)
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// 设备密钥对：官方每次登录现生成一套 EC P-256，公钥进 ExchangeToken 的
// DeviceInfo.DevicePublicKey，私钥必须随凭据落盘（丢了等于断开设备绑定）
function generateDeviceKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKey, privateKey }
}

// 授权码换证（v3）：CodeVerifier 与 DeviceInfo 缺一不可，空公钥会被判 20405
function buildAuthCodeExchange({ authCode, codeVerifier, publicKey, machineId, deviceId }, appVersion = LOGIN_FALLBACK.appVersion) {
  return {
    urls: [
      `https://api.trae.cn${EXCHANGE_V3_PATH}`,
      `https://api.trae.com.cn${EXCHANGE_V3_PATH}`,
      // 老端点兜底：桌面客户端历史上一直用它，v3 拒了再试一次
      `https://api.trae.cn${EXCHANGE_PATH}`,
    ],
    body: {
      ClientID: LOGIN_CLIENT_ID,
      AuthCode: authCode,
      CodeVerifier: codeVerifier,
      IDEVersion: appVersion,
      DeviceInfo: {
        DeviceID: deviceId,
        MachineID: machineId,
        // IDE 客户端是 IDE_PC（SOLO 才是 SOLO_PC）
        PlatformCode: 'IDE_PC',
        DeviceType: 'PC',
        DeviceName: 'DESKTOP-CPASOLO',
        DeviceModel: LOGIN_DEVICE_BRAND,
        ClientVersion: appVersion,
        DevicePublicKey: publicKey,
        DeviceBrand: 'Microsoft',
        DeviceCPU: '',
        OSInfo: LOGIN_DEVICE_TYPE,
        OSVersion: LOGIN_OS_VERSION,
      },
    },
  }
}

// 回调参数是 URL 编码的 JSON；Trae 的中文昵称存在**双重编码**（实测乱码
// 「Óû§8847309959」），故再容错解一层
function parseJsonParam(raw) {
  if (raw === null || raw === undefined || raw.length === 0) return undefined
  const candidates = [raw]
  try {
    candidates.push(decodeURIComponent(raw))
  } catch { /* 不是二次编码 */ }
  for (const text of candidates) {
    try {
      const value = JSON.parse(text)
      if (typeof value === 'object' && value !== null) return value
    } catch { /* 下一个候选 */ }
  }
  return undefined
}

function jsonString(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

// 从 authCodeInfo（JSON 或 JSON 字符串）里挖授权码：键名上游改过几版，递归找
function extractAuthCode(raw) {
  const parsed = parseJsonParam(raw)
  if (!parsed || typeof parsed !== 'object') return ''
  const keys = ['authCode', 'auth_code', 'AuthCode', 'AuthCodeToken', 'code']
  const walk = value => {
    if (!value || typeof value !== 'object') return ''
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item)
        if (hit) return hit
      }
      return ''
    }
    for (const key of keys) {
      if (typeof value[key] === 'string' && value[key].trim().length > 0) return value[key].trim()
    }
    for (const nested of Object.values(value)) {
      const hit = walk(nested)
      if (hit) return hit
    }
    return ''
  }
  return walk(parsed)
}

// 解析登录回调。上游同时存在两条材料分支（Agent2API 实测）：
//   · refreshToken —— 老流程，拿到就直接走续期链换凭据；
//   · authCode     —— PKCE 新流程，要用本轮 code_verifier 去 v3 ExchangeToken 换。
// 错误键必须先判：`error` / `errorCode` / `isRedirect=false` 时其余字段一律留空，
// 否则会把「用户取消 + 一个残留 code」当成成功材料。
function parseCallback(rawUrl) {
  let query
  try {
    query = new URL(rawUrl.startsWith('http') ? rawUrl : `http://127.0.0.1${rawUrl}`).searchParams
  } catch {
    return { ok: false, reason: '回调 URL 无法解析' }
  }
  const errorKey = ['error', 'error_code', 'err', 'errorCode']
    .find(key => (query.get(key) || '').trim().length > 0)
  if (errorKey) return { ok: false, reason: `上游拒绝授权：${errorKey}=${query.get(errorKey)}` }
  if ((query.get('isRedirect') || '') === 'false') return { ok: false, reason: '上游返回 isRedirect=false（设备绑定被拒）' }

  const userInfo = parseJsonParam(query.get('userInfo'))
  const userJwt = parseJsonParam(query.get('userJwt'))
  let refreshToken = query.get('refreshToken') ?? ''
  if (refreshToken.length === 0) refreshToken = jsonString(userJwt, 'RefreshToken')
  const accessToken = refreshToken.length === 0 ? jsonString(userJwt, 'Token') : ''
  const authCode = [
    query.get('authCode'),
    query.get('auth_code'),
    query.get('AuthCode'),
    query.get('authorization_code'),
    query.get('code'),
  ].find(candidate => (candidate || '').trim().length > 0)?.trim()
    || extractAuthCode(query.get('authCodeInfo'))

  const info = {
    refreshToken,
    accessToken,
    authCode,
    // 回调带回的 loginHost 才是这次授权实际发生的站点（可能与国际站不同）
    loginHost: query.get('loginHost') || query.get('login_host') || '',
    uid: jsonString(userInfo, 'UserID'),
    nickname: jsonString(userInfo, 'ScreenName'),
    // 回调里的字段名是 TenantID，不是 EnterpriseID
    enterpriseId: jsonString(userInfo, 'TenantID'),
  }
  if (info.refreshToken.length === 0 && info.accessToken.length === 0 && info.authCode.length === 0) {
    return { ok: false, reason: '回调未携带 refreshToken / accessToken / authCode' }
  }
  return { ok: true, info }
}

// ── 响应解析 ──

function readString(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(source, key) {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(source, key) {
  const value = source?.[key]
  return typeof value === 'boolean' ? value : undefined
}

// ExchangeToken 响应是 `{ Result: { Token, RefreshToken, TokenExpireAt, ... } }`
function parseExchangeResponse(data) {
  const result = data?.Result ?? data?.result
  if (typeof result !== 'object' || result === null) return undefined
  const accessToken = readString(result, 'Token') || readString(result, 'token') || readString(result, 'accessToken')
  if (accessToken.length === 0) return undefined
  return {
    accessToken,
    refreshToken: readString(result, 'RefreshToken') || readString(result, 'refreshToken'),
    tokenExpireAt: readNumber(result, 'TokenExpireAt') ?? readNumber(result, 'tokenExpireAt') ?? 0,
    tokenExpireDuration: readNumber(result, 'TokenExpireDuration') ?? readNumber(result, 'tokenExpireDuration') ?? 0,
  }
}

// GetUserInfo 只下发**脱敏**手机号 / 邮箱（NonPlainTextMobile / NonPlainTextEmail）
function parseUserInfo(data) {
  const result = data?.Result ?? data?.result
  if (typeof result !== 'object' || result === null) return undefined
  const uid = readString(result, 'UserID') || readString(result, 'userId') || readString(result, 'uid')
  if (uid.length === 0) return undefined
  return {
    uid,
    screenName: readString(result, 'ScreenName') || readString(result, 'screenName') || uid,
    enterpriseId: readString(result, 'EnterpriseID') || readString(result, 'enterpriseId'),
    phone: readString(result, 'NonPlainTextMobile') || readString(result, 'nonPlainTextMobile'),
    email: readString(result, 'NonPlainTextEmail') || readString(result, 'nonPlainTextEmail'),
  }
}

// ── 签到 / 积分响应 ──
//
// ⚠️ 这三个端点的响应**都是平铺的**，没有 `data` 这一层。实测（2026-10-26）：
//
//   status → {"checked_in":true,"code":0,"credits":100,"did_checked_in":true,
//             "enable":true,"extra_credits":100,"message":"success"}
//   claim  → {"code":0,"message":"success"}                       ← 没有积分数
//   余额   → {"usage_summary":{…},"user_entitlement_pack_list":[…]} ← 没有 total_credits
//
// 早期实现按 `body.data.checked_in` / `body.data.credits` / `body.data.total_credits`
// 读，于是：已签到判不出来（claim 幂等，重复领取也回 code 0）、领取金额恒为
// undefined（界面显示「+? 积分」）、余额恒为 null。解析收在这里，让这类字段路径
// 错误能被离线用例直接钉住。

// 业务码可能是数字，也可能是字符串（部分网关回 `"9074"`）。
// 缺失按 0 处理，非数字按 -1（未知失败），两者不能混：缺失代表上游没给码。
function readBusinessCode(body) {
  const raw = body?.code
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return raw === undefined || raw === null ? 0 : -1
}

// 签到业务码。每类对应不同的处置方式，**不能一律当成功**。
const CHECKIN_CODE_OK = 0
const CHECKIN_CODE_AUTH = 1001        // 鉴权失效 → 需要重新登录
const CHECKIN_CODE_PLAN_LIMIT = 1005  // 当前套餐不参与签到（免费/企业号常见）
const CHECKIN_CODE_BUSY = 9074        // 「签到人数过多」→ 稍后再试，不是永久失败

function parseCheckinStatus(body) {
  const code = readBusinessCode(body)
  return {
    code,
    ok: code === CHECKIN_CODE_OK,
    // 判据只能是 checked_in：claim 对「今天已签过」是幂等的（同样回 code 0），
    // 只有 status 能区分「真的领到了」与「早就领过了」
    checkedIn: readBoolean(body, 'checked_in') === true,
    // 活动是否开启。false + code 0 = 这个账号没有签到活动（免费/企业套餐）
    enabled: readBoolean(body, 'enable') !== false,
    // 领取成功后**唯一**能拿到金额的地方：claim 响应里没有积分数
    credits: readNumber(body, 'credits') ?? 0,
    extraCredits: readNumber(body, 'extra_credits') ?? 0,
    streakDays: readNumber(body, 'streak_days') ?? 0,
    message: readString(body, 'message') || readString(body, 'msg'),
  }
}

// claim 只回答「成不成」，金额要回 status 端点取（见 parseCheckinStatus）
function parseClaimResponse(body) {
  const code = readBusinessCode(body)
  return {
    code,
    ok: code === CHECKIN_CODE_OK,
    message: readString(body, 'message') || readString(body, 'msg'),
  }
}

// 余额 = Σ(每个资源包的 credits_limit - credits_amount)。
// 包名在 `entitlement_base_info.display_desc`（`base.name` 实测恒 undefined），
// 到期时间在**条目级** `expire_time`（秒级 Unix，实测 1790783999 = 2026-09-30）。
function parseCreditBalance(body) {
  const list = Array.isArray(body?.user_entitlement_pack_list) ? body.user_entitlement_pack_list : []
  const packages = []
  let total = 0
  let expiredTotal = 0
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const base = entry.entitlement_base_info
    if (typeof base !== 'object' || base === null) continue
    const limit = readNumber(base.quota, 'credits_limit')
    // credits_limit <= 0 的是「免费」这类占位包，不含额度
    if (limit === undefined || limit <= 0) continue
    const used = readNumber(entry.usage, 'credits_amount') ?? 0
    // 逐包保留两位再合计：上游的 credits_amount 是四位小数（实测 12.2644），
    // 不裁会在面板上显示「487.7356」，而积分本身是整数口径
    const remaining = Math.max(0, Math.round((limit - used) * 100) / 100)
    const expireSec = readNumber(entry, 'expire_time')
    packages.push({
      name: readString(base, 'display_desc') || readString(entry, 'display_desc') || '资源包',
      total: limit,
      used,
      remaining,
      // 秒 → 毫秒必须 ×1000；拿不到就留 0，前端按「永久」显示
      expireAt: expireSec !== undefined && expireSec > 0 ? expireSec * 1000 : 0,
    })
    total += remaining
  }
  return { total: Math.round(total * 100) / 100, packages, expiredTotal }}

// 组装可落盘的凭据。expires_at 优先取绝对时间，其次相对秒数，最后 JWT exp。
function buildCredential(exchange, userInfo, session, nowMs = Date.now()) {
  let expiresAt = ''
  if (exchange.tokenExpireAt > 1e12) expiresAt = String(exchange.tokenExpireAt)
  else if (exchange.tokenExpireAt > 0) expiresAt = String(exchange.tokenExpireAt * 1000)
  else if (exchange.tokenExpireDuration > 0) expiresAt = String(nowMs + exchange.tokenExpireDuration * 1000)
  else {
    const exp = jwtExpiresAtMs(exchange.accessToken)
    expiresAt = exp === undefined ? '' : String(exp)
  }
  return {
    access_token: exchange.accessToken,
    refresh_token: exchange.refreshToken,
    expires_at: expiresAt,
    uid: userInfo.uid,
    nickname: userInfo.screenName,
    ...userInfo.phone ? { phone: userInfo.phone } : {},
    ...userInfo.email ? { email: userInfo.email } : {},
    machine_id: session.machineId,
    device_id: session.deviceId,
    // 设备密钥对只写不读，但重建凭据时必须保住：抹掉等于断开这台设备与账号的绑定
    ...session.devicePublicKey ? { device_public_key: session.devicePublicKey } : {},
    ...session.devicePrivateKey ? { device_private_key: session.devicePrivateKey } : {},
    ...session.authClientId ? { auth_client_id: session.authClientId } : {},
    enterprise_id: userInfo.enterpriseId,
  }
}

// 续期只覆盖令牌相关字段，**保留** machine_id / uid / phone 等身份字段
function applyRefresh(credential, exchange) {
  const next = { ...credential, access_token: exchange.accessToken }
  if (exchange.refreshToken.length > 0) next.refresh_token = exchange.refreshToken
  const built = buildCredential(exchange, { uid: credential.uid }, {
    machineId: credential.machine_id,
    deviceId: credential.device_id,
  })
  if (built.expires_at) next.expires_at = built.expires_at
  return next
}

// ── 模型目录 ──

// 上下文窗口取 `context_window_tokens.dev`：`max` 那一档（1M）要开 Max 模式才可用，
// 采信 max 会让客户端以为有 1M 窗口、实际请求被上游拒。
// 但 max 档要单独记下来（contextWindowMax）：只有知道「这模型有更大的档」，
// 才能判断什么时候该开 Max 模式 —— 两个口径分槽，互不兜底。
function readContextWindow(entry) {
  const tokens = entry.context_window_tokens ?? entry.ContextWindowTokens
  if (typeof tokens !== 'object' || tokens === null) return undefined
  return readNumber(tokens, 'dev') ?? readNumber(tokens, 'Dev')
}

function readContextWindowMax(entry) {
  const tokens = entry.context_window_tokens ?? entry.ContextWindowTokens
  if (typeof tokens !== 'object' || tokens === null) return undefined
  const max = readNumber(tokens, 'max') ?? readNumber(tokens, 'Max')
  return max !== undefined && max > 0 ? max : undefined
}

function readDetailMaxTokens(entry, suffix = '') {
  const list = entry.model_detail_list ?? entry.ModelDetailList
  if (!Array.isArray(list) || list.length === 0) return undefined
  const wanted = list.find(item => typeof item === 'object' && item !== null
    && (item.model_type ?? item.ModelType) === `__dev${suffix}`) ?? list[0]
  return readNumber(wanted, 'max_tokens') ?? readNumber(wanted, 'maxTokens')
}

// 思考档位：`reasoning_effort_config.options` 是**单值字符串**数组（既是产品侧档位名，
// 也是 wire 值）。support_thinking: false 表示上游明确不支持。
function readReasoningConfig(entry) {
  const raw = entry.reasoning_effort_config ?? entry.ReasoningEffortConfig
  if (typeof raw !== 'object' || raw === null) return undefined
  const supportThinking = readBoolean(raw, 'support_thinking') ?? readBoolean(raw, 'supportThinking')
  const options = raw.options ?? raw.Options
  if (!Array.isArray(options)) return { supportThinking, options: [], defaultOption: undefined }
  return {
    supportThinking,
    options: options.filter(option => typeof option === 'string' && option.length > 0),
    defaultOption: readString(raw, 'default_level') || readString(raw, 'defaultLevel') || undefined,
  }
}

// 解析 batch_get_detail_param 的一条 config_info_list 条目
function parseConfigEntry(entry, channel) {
  const id = readString(entry, 'config_name') || readString(entry, 'ConfigName')
  if (id.length === 0) return undefined
  const display = entry.display_config ?? entry.DisplayConfig
  const displayRecord = typeof display === 'object' && display !== null ? display : undefined
  const name = displayRecord !== undefined ? (readString(displayRecord, 'display_name') || id) : id
  const reasoning = readReasoningConfig(entry)
  return {
    id,
    name,
    channel,
    usage: readString(entry, 'usage') || readString(entry, 'Usage'),
    isCustomModel: displayRecord === undefined ? undefined : readBoolean(displayRecord, 'is_custom_model'),
    isHidden: readBoolean(entry, 'is_invisible_to_user'),
    isEnabled: readBoolean(entry, 'config_switch'),
    multimodal: displayRecord === undefined ? undefined : readBoolean(displayRecord, 'multimodal'),
    contextWindow: readContextWindow(entry),
    contextWindowMax: readContextWindowMax(entry),
    maxOutputTokens: readDetailMaxTokens(entry),
    reasoning: reasoning === undefined ? undefined : {
      // 与 provider.js 的 reasoningFor 同一判据：只判「配置存在」不够，
      // support_thinking:false 与空 options 都必须视为不声明档位
      efforts: reasoning.supportThinking === false ? [] : reasoning.options,
      defaultEffort: reasoning.defaultOption,
    },
  }
}

// 该条目能否真正声明出思考档位（档位必须与其 function 同源，故这里整条择优）
function declaresEfforts(model) {
  return model.reasoning !== undefined && model.reasoning.efforts.length > 0
}

// 解析 batch_get_detail_param（多通道）响应。
//
// 合并规则（踩过的坑）：
//   ① 空档位不得覆盖有档位 —— 上游把空档位的条目排在**最后**，无条件「后覆盖前」
//      会让 13 个模型丢掉思考档位；
//   ② 两侧都有档位时按通道优先级取更靠前者；
//   ③ 其余情形保持「后覆盖前」。
// 合并前先做四条硬性过滤：非白名单通道整组丢弃、usage 非 chat_completion、
// config_switch=false、is_invisible_to_user=true。
function parseBatchModelList(body) {
  const groups = body?.function_configs ?? body?.FunctionConfigs
  if (!Array.isArray(groups)) return []
  const rankOf = channel => CHANNELS.indexOf(channel)
  const byId = new Map()
  const chosenRank = new Map()
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const channel = readString(group, 'function') || readString(group, 'Function')
    if (channel.length === 0 || rankOf(channel) < 0) continue
    const list = group.config_info_list ?? group.ConfigInfoList
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const model = parseConfigEntry(item, channel)
      if (model === undefined) continue
      if (model.usage !== undefined && model.usage !== 'chat_completion') continue
      if (model.isEnabled === false) continue
      if (model.isHidden === true) continue
      // 自定义模型（需在 IDE 内绑定供应商）实测 5/5 被流内 4001 拒绝
      if (model.isCustomModel === true) continue
      const incumbent = byId.get(model.id)
      if (incumbent === undefined) {
        byId.set(model.id, model)
        chosenRank.set(model.id, rankOf(channel))
        continue
      }
      const incumbentHas = declaresEfforts(incumbent)
      const candidateHas = declaresEfforts(model)
      if (incumbentHas && !candidateHas) continue
      if (incumbentHas && candidateHas && rankOf(channel) >= (chosenRank.get(model.id) ?? 0)) continue
      byId.set(model.id, model)
      chosenRank.set(model.id, rankOf(channel))
    }
  }
  return [...byId.values()]
}

// 兜底目录：只用于「远端目录整体失败」；没有通道信息，发送时回退默认通道
function fallbackModels() {
  return FALLBACK_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    channel: DEFAULT_FUNCTION,
    contextWindow: 200000,
    multimodal: false,
  }))
}

// ── OpenAI → SOLO 请求体 ──

// assistant 的 tool_calls 在 SOLO 里叫 function_call；无名调用整条剔除
function transformMessage(message) {
  const result = { ...message }
  if (result.role === 'assistant' && Array.isArray(result.tool_calls)) {
    const kept = []
    for (const raw of result.tool_calls) {
      if (typeof raw !== 'object' || raw === null) continue
      const call = { ...raw }
      if (typeof call.function === 'object' && call.function !== null) {
        call.function_call = call.function
        delete call.function
      }
      const fn = call.function_call
      if (typeof fn?.name !== 'string' || fn.name.trim().length === 0) continue
      kept.push(call)
    }
    if (kept.length > 0) result.tool_calls = kept
    else delete result.tool_calls
  }
  if (typeof result.content === 'string') result.content = [{ type: 'text', text: result.content }]
  // 已经是数组的 content 原样透传（兼容多模态）
  return result
}

// tool_choice：none 删掉全部工具；auto/required 降为字符串；function 取名字
function normalizeToolChoice(body) {
  const choice = body.tool_choice
  if (choice === undefined) return
  const suppress = () => { delete body.tools; delete body.functions }
  if (typeof choice === 'string') {
    if (choice.toLowerCase().trim() === 'none') { delete body.tool_choice; suppress() }
    return
  }
  if (typeof choice === 'object' && choice !== null) {
    const type = typeof choice.type === 'string' ? choice.type.toLowerCase().trim() : ''
    if (type === 'none') { delete body.tool_choice; suppress(); return }
    if (type === 'auto' || type === 'required') { body.tool_choice = type; return }
    if (type === 'function') {
      const name = (typeof choice.function?.name === 'string' ? choice.function.name : '') || (typeof choice.name === 'string' ? choice.name : '')
      body.tool_choice = name.trim().length > 0 ? name.trim() : 'auto'
      return
    }
    delete body.tool_choice
    return
  }
  delete body.tool_choice
}

// SOLO 要求 parameters 是 JSON **字符串**（OpenAI 标准是对象）
function normalizeTools(body) {
  const raw = body.tools
  if (!Array.isArray(raw) || raw.length === 0) return
  const out = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    if (item.function === undefined) continue
    if (typeof item.function.parameters === 'object' && item.function.parameters !== null) {
      item.function.parameters = JSON.stringify(item.function.parameters)
    }
    out.push(item)
  }
  if (out.length > 0) body.tools = out
  else delete body.tools
}

// 模型名 → 上游 wire 名。官方每个模型都有「配置名」和「内部模型名」两套写法：
// 内部名统一是 <配置名>__dev，只有少数模型是点号风格（下划线变体会报 4023）。
// 只发配置名时上游按兜底规则解析，新上架模型容易落到错误的档位/计费口径。
const WIRE_NAME_EXCEPTIONS = { 'deepseek-v4.1-flash': 'deepseek-v4.1-flash__dev' }

function wireModelName(configName) {
  const name = String(configName || '').trim()
  if (!name) return ''
  if (WIRE_NAME_EXCEPTIONS[name]) return WIRE_NAME_EXCEPTIONS[name]
  return name.includes('__') ? name : `${name}__dev`
}

// 会话信封：官方客户端每个请求都在 body 里带这三个 id 与一组版本/形态字段。
// 我们原来只把它们放在 header（X-Machine-Id / X-Device-Id），body 是最小集 ——
// 上游按 body 判客户端一致性时就少了一半证据，多轮上下文归属也只能靠猜。
function buildEnvelope(identity = {}) {
  return {
    conversation_id: identity.conversationId || crypto.randomUUID(),
    session_id: identity.sessionId || crypto.randomUUID(),
    project_id: crypto.randomUUID(),
    workspace_id: 'e04cdd',
    mode: 'FunctionCall',
    package_type: 'stable_cn',
    ide_version: IDE_VERSION,
    ide_version_code: IDE_VERSION_CODE,
    app_id: APP_ID,
    ...(identity.uid ? { user_id: identity.uid } : {}),
    ...(identity.deviceId ? { device_id: identity.deviceId } : {}),
    ...(identity.machineId ? { machine_id: identity.machineId } : {}),
  }
}

// 把 OpenAI Chat 请求体转成 SOLO 格式。
// `channel` 必须是**列出该模型的通道**：发错通道上游回流内 4001，
// 而错误文案指向模型，极易误判成「这个模型坏了」。
function transformToSolo(openAi, channel, identity = {}) {
  const body = { ...openAi, stream: true, function: channel || DEFAULT_FUNCTION }
  if (Array.isArray(body.messages)) body.messages = body.messages.map(transformMessage)
  const rawModel = typeof body.model === 'string' ? body.model : ''
  // `__dev` 之类的后缀是客户端内部标记，不发给上游
  const configName = (rawModel.includes('__') ? rawModel.split('__')[0] : rawModel) || DEFAULT_MODEL
  body.config_name = configName
  body.model = configName
  body.model_name = wireModelName(configName)
  Object.assign(body, buildEnvelope(identity))
  // Max 模式：只有目录声明了「max 档 > dev 档」的模型才需要这一组字段
  if (identity.maxMode) Object.assign(body, maxModeFields(identity.maxMode.maxContext, identity.maxMode.outputMax))
  normalizeToolChoice(body)
  normalizeTools(body)
  return body
}

// Max 模式（1M 上下文）：三件套必须成套，只调大 max_tokens 会被按 200K 拒绝
// Max 模式（1M 上下文）：上游只认 is_max_mode + prompt_max_tokens 这一对，
// 且 prompt_max_tokens 必须是 168000 —— 填 1M 会被 4001 拒（对方 2026-09 实测），
// 真实上下文由上游内部决策，这个字段不钳制实际长度。
const MAX_MODE_PROMPT_TOKENS = 168000
function maxModeFields(maxContext, outputMax) {
  return {
    is_max_mode: true,
    prompt_max_tokens: MAX_MODE_PROMPT_TOKENS,
    max_tokens: outputMax > 0 ? outputMax : MAX_OUTPUT_TOKENS,
    context_window_size: maxContext > 0 ? maxContext : MAX_CONTEXT_TOKENS,
  }
}

// ── SOLO SSE 解析 ──

// 一条 SOLO 事件：`event: <name>` + `data: <json>`
function parseSseEvent(eventName, dataLine) {
  const event = String(eventName || '').trim()
  if (!dataLine) return { event }
  let raw
  try {
    raw = JSON.parse(dataLine)
  } catch {
    return { event }
  }
  const parsed = { event }
  if (event === 'output') {
    if (typeof raw.response === 'string') parsed.text = raw.response
    if (typeof raw.reasoning_content === 'string') parsed.reasoning = raw.reasoning_content
    if (Array.isArray(raw.tool_calls)) parsed.toolCalls = raw.tool_calls.map(normalizeToolCall)
  } else if (event === 'token_usage') {
    parsed.usage = raw
  } else if (event === 'done') {
    if (typeof raw.finish_reason === 'string') parsed.finishReason = raw.finish_reason
  } else if (event === 'error') {
    parsed.error = {
      code: typeof raw.code === 'number' ? raw.code : -1,
      // 上游的错误文案可能在 message / msg / error 里
      message: String(raw.message ?? raw.msg ?? raw.error ?? '未知错误'),
    }
  }
  return parsed
}

// tool_calls：SOLO 用 function_call，且带 namespace / partial_arguments 等专属字段
function normalizeToolCall(call) {
  if (typeof call !== 'object' || call === null) return call
  const out = { ...call }
  if (typeof out.function_call === 'object' && out.function_call !== null) {
    out.function = { ...out.function_call }
    delete out.function_call
  }
  if (typeof out.function === 'object' && out.function !== null) {
    delete out.function.namespace
    delete out.function.partial_arguments
  }
  return out
}

// ── 重试分诊 ──
//
// 上游的失败不能一个「错误」了事：429 是等一会儿再试，502/503 是同号重发或换号，
// 400 里还有「思考签名抖动」「积分耗尽」「账号被限制」三种完全不同的处置。
// 一律换号或一律 502 会把可恢复的抖动变成用户可见的失败。
const RETRY = { RETRY: 'retry', SWITCH: 'switch', FATAL: 'fatal' }

function errorText(value) {
  return String(value || '')
}

function isThinkingSignatureError(body) {
  return errorText(body).toLowerCase().includes('thinking.signature')
}

// 积分/额度耗尽：请求本身合法，换号才有意义
function isCreditExhaustedError(body) {
  const lower = errorText(body).toLowerCase()
  return lower.includes('insufficient credit') || lower.includes('积分不足') || lower.includes('额度不足')
}

// 账号级风控（11140）：与渠道级 11-128 相反 —— 换号有意义，受限账号该被停用
function isAccountRestrictedError(body) {
  const text = errorText(body)
  return text.includes('账号存在异常') || text.includes('已被限制使用') || /"code"\s*:\s*11140(?![0-9])/.test(text)
}

// 返回 { action: 'retry'|'switch'|'fatal', delayMs, rateLimited?, restrict? }
// attempt：同一账号已尝试次数（0 = 第一次失败后的决策）
function retryPlan(status, body, attempt = 0, retryAfterSeconds = 0) {
  const code = Number(status) || 0
  if (code === 400 && isThinkingSignatureError(body)) {
    return { action: attempt === 0 ? RETRY.RETRY : RETRY.FATAL, delayMs: 200 }
  }
  if (code === 400 && isCreditExhaustedError(body)) return { action: RETRY.SWITCH, delayMs: 0 }
  if (code === 400 && isAccountRestrictedError(body)) return { action: RETRY.SWITCH, delayMs: 0, restrict: true }
  if (code === 429) {
    if (attempt >= 3) return { action: RETRY.SWITCH, delayMs: 0 }
    const wait = Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) * 1000 : 1000 * (attempt + 1)
    return { action: RETRY.RETRY, delayMs: wait, rateLimited: true }
  }
  if (code === 503 || code === 529) {
    if (attempt >= 3) return { action: RETRY.SWITCH, delayMs: 0 }
    return { action: RETRY.RETRY, delayMs: 10000 * Math.pow(2, Math.min(attempt, 2)) }
  }
  // 502 多半是上游网关瞬时抖动：同号重试一次比立刻换号便宜
  if (code === 502) return { action: attempt === 0 ? RETRY.RETRY : RETRY.SWITCH, delayMs: 500 }
  if (code === 401 || code === 403) return { action: RETRY.SWITCH, delayMs: 0 }
  // 400 其余是请求本身的问题（context 超长等），换号无意义
  if (code === 400) return { action: RETRY.FATAL, delayMs: 0 }
  if (code >= 500) return { action: RETRY.SWITCH, delayMs: 0 }
  return { action: RETRY.FATAL, delayMs: 0 }
}

// 额度耗尽类的冷却终点：次日 04:00（东八区）。上游按自然日发额度，
// 用一个固定重置点比「一小时后」可靠 —— 后者会在凌晨反复空转。
const UTC8_OFFSET_MS = 8 * 3600 * 1000

function nextQuotaReset(nowMs = Date.now()) {
  const local = nowMs + UTC8_OFFSET_MS
  const dayStart = Math.floor(local / 86400000) * 86400000
  const today0400 = dayStart + 4 * 3600 * 1000
  return (local < today0400 ? today0400 : today0400 + 86400000) - UTC8_OFFSET_MS
}

// ── 选号策略（纯函数，便于离线回归）──
//
// 六个策略里只有 order 是「旧行为」；其余都是为了解决「一直打第一个号」：
// 先到期的积分先花掉、余额多的先顶上、冷号插队（防热点）、两个里挑更闲的（P2C）。
function seededRandom(seed) {
  let t = (Number(seed) >>> 0) + 0x6D2B79F5
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function poolScore(entry, totalCredits, now) {
  const credits = Number(entry.credits)
  const creditShare = totalCredits > 0 && Number.isFinite(credits) ? credits / totalCredits : 1
  const idleHours = Math.max(0, (now - (Number(entry.lastUsedAt) || now)) / 3600000)
  const idleBonus = Math.min(5, idleHours * 0.5)
  const success = Number.isFinite(entry.successRate) ? entry.successRate : 0.9
  return creditShare * 10 + idleBonus + success * 3
}

function pickByStrategy(entries, { strategy = 'order', now = Date.now(), seed = 0 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  if (entries.length === 1) return entries[0]
  if (strategy === 'credit') {
    return entries.reduce((best, item) => ((Number(item.credits) || 0) > (Number(best.credits) || 0) ? item : best))
  }
  if (strategy === 'expire') {
    // 有到期时间的排前面（先到期先花），没有到期时间的排最后
    const rank = item => {
      const exp = Number(item.creditsExpireAt)
      return exp > 0 ? exp : Number.MAX_SAFE_INTEGER
    }
    return entries.reduce((best, item) => (rank(item) < rank(best) ? item : best))
  }
  const totalCredits = entries.reduce((sum, item) => sum + Math.max(0, Number(item.credits) || 0), 0)
  if (strategy === 'weighted') {
    const top = [...entries]
      .sort((a, b) => poolScore(b, totalCredits, now) - poolScore(a, totalCredits, now))
      .slice(0, 5)
    if (top.length === 1) return top[0]
    const weights = top.map(item => Math.max(1, poolScore(item, totalCredits, now) * 10))
    const sum = weights.reduce((a, b) => a + b, 0)
    let point = seededRandom(seed) * sum
    for (let i = 0; i < top.length; i++) {
      point -= weights[i]
      if (point <= 0) return top[i]
    }
    return top[top.length - 1]
  }
  if (strategy === 'p2c') {
    // 随机取两个，先比在途数（空闲者胜）再比得分
    const a = entries[Math.floor(seededRandom(seed) * entries.length) % entries.length]
    let b = entries[Math.floor(seededRandom(seed + 1) * entries.length) % entries.length]
    if (b === a) b = entries[(entries.indexOf(a) + 1) % entries.length]
    const loadA = Number(a.inflight) || 0
    const loadB = Number(b.inflight) || 0
    if (loadA !== loadB) return loadA < loadB ? a : b
    return poolScore(a, totalCredits, now) >= poolScore(b, totalCredits, now) ? a : b
  }
  return entries[0]
}

// 流内可换号的错误码（额度 / 风控类）
const ROTATABLE_STREAM_ERROR = 1005
const ROTATABLE_STREAM_ERRORS = new Set([1005, 4008, 4011])

module.exports = {
  AGENT_HOST,
  UG_HOST,
  OAUTH_HOST,
  CONSOLE_HOST,
  CHAT_PATH,
  BATCH_MODELS_PATH,
  EXCHANGE_PATH,
  USER_INFO_PATH,
  CHECKIN_STATUS_PATH,
  CHECKIN_CLAIM_PATH,
  ENT_USAGE_PATH,
  REQUEST_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_FUNCTION,
  IDE_VERSION,
  CHANNELS,
  ALL_FUNCTIONS,
  ROTATABLE_STREAM_ERROR,
  ROTATABLE_STREAM_ERRORS,
  generateMachineId,
  generateDeviceId,
  credentialExpiresAtMs,
  isExpired,
  isRefreshable,
  displayName,
  soloHeaders,
  oauthHeaders,
  checkinHeaders,
  buildLoginUrl,
  pkcePair,
  generateDeviceKeys,
  buildAuthCodeExchange,
  LOGIN_CLIENT_ID,
  parseCallback,
  parseExchangeResponse,
  parseUserInfo,
  parseCheckinStatus,
  parseClaimResponse,
  parseCreditBalance,
  readBusinessCode,
  CHECKIN_CODE_OK,
  CHECKIN_CODE_AUTH,
  CHECKIN_CODE_PLAN_LIMIT,
  CHECKIN_CODE_BUSY,
  buildCredential,
  applyRefresh,
  parseBatchModelList,
  fallbackModels,
  transformToSolo,
  maxModeFields,
  wireModelName,
  buildEnvelope,
  parseSseEvent,
  RETRY,
  retryPlan,
  isThinkingSignatureError,
  isCreditExhaustedError,
  isAccountRestrictedError,
  nextQuotaReset,
  pickByStrategy,
  poolScore,
}
