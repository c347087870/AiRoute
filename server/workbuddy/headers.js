// WorkBuddy 出站请求头构造

const crypto = require('crypto')
const C = require('./constants')

// 读 identity 覆盖值（缺失/非字符串返回空串；调用方按「空串回落默认」消费）
function idv(opts, key) {
  const v = opts && opts.identity ? opts.identity[key] : ''
  return typeof v === 'string' ? v : ''
}

// Accept-Language（默认 zh-CN，identity.acceptLanguage 可覆盖）
function acceptLanguage(opts = {}) {
  return idv(opts, 'acceptLanguage') || 'zh-CN'
}

// Origin/Referer 基础域（默认 CN，identity.originReferer 可覆盖）
function originRefererOf(account, opts = {}) {
  return idv(opts, 'originReferer') || C.ORIGIN_REFERER_CN
}

// 客户端出站 UA（chat / refresh / 模型目录共用）：按「使用端身份」（opts.clientIdentity）组装——
// workbuddy（默认）= 官方 WorkBuddy 桌面端三段式；codebuddy = 官方 CodeBuddy IDE 两段式
// （官网积分记录「使用端」列按出站 UA 服务端归因，故身份切换即改这里）
// identity 可整串覆盖（workbuddyUA / codebuddyUA），也可只覆盖版本号段
function userAgent(account, opts = {}) {
  if (opts.userAgent) return opts.userAgent // 显式覆盖一切
  if (opts.clientIdentity === 'codebuddy') {
    const ideVersion = idv(opts, 'ideVersion') || C.DEFAULT_IDE_VERSION
    return idv(opts, 'codebuddyUA') || `CodeBuddyIDE/${ideVersion} CodeBuddy/${ideVersion}`
  }
  const clientVersion = idv(opts, 'clientVersion') || C.DEFAULT_CLIENT_VERSION
  const cliVersion = idv(opts, 'cliVersion') || C.DEFAULT_CLI_VERSION
  return idv(opts, 'workbuddyUA') || `WorkBuddy/${clientVersion} WorkBuddy/${clientVersion} CLI/${cliVersion}`
}

// 桌面端事件链 UA（默认按桌面版本 + CLI 版本段拼接；identity.desktopUA 可整串覆盖）
function desktopUA(opts = {}) {
  const dv = idv(opts, 'desktopVersion') || C.DEFAULT_DESKTOP_VERSION
  const cliVersion = idv(opts, 'cliVersion') || C.DEFAULT_CLI_VERSION
  return idv(opts, 'desktopUA') || `WorkBuddy/${dv} WorkBuddy/${dv} CLI/${cliVersion}`
}

// /v3/config 探测 UA（默认按 IDE 版本段拼接；identity.v3ConfigUA 可整串覆盖）
function v3ConfigUA(opts = {}) {
  const v = idv(opts, 'ideVersion') || C.DEFAULT_IDE_VERSION
  return idv(opts, 'v3ConfigUA') || `CodeBuddyIDE/${v} CodeBuddy/${v}`
}

// OAuth 设备授权 UA（默认官方 CLI 串；identity.oauthUA 可整串覆盖）
function oauthUA(opts = {}) {
  return idv(opts, 'oauthUA') || C.CODEBUDDY_CLI_UA
}

// billing 域 UA：单段无 CLI 段；SaaS 归属模式不设 UA；codebuddy 身份用 CodeBuddy 品牌单段
function billingUA(opts = {}) {
  const name = opts.clientName || 'WorkBuddy'
  if (name === 'SaaS') return ''
  if (opts.clientIdentity === 'codebuddy') {
    const ideVersion = idv(opts, 'ideVersion') || C.DEFAULT_IDE_VERSION
    return idv(opts, 'codebuddyBillingUA') || `CodeBuddy/${ideVersion}`
  }
  const clientVersion = idv(opts, 'clientVersion') || C.DEFAULT_CLIENT_VERSION
  return idv(opts, 'workbuddyBillingUA') || `WorkBuddy/${clientVersion}`
}

// 账号级稳定设备头派生：sha256("wb2a:"+purpose+":"+uid) 前 18 字节 hex（36 字符）
// 盐固定 wb2a:，跨进程重启恒定
function deriveAccountStableID(uid, purpose) {
  if (!uid) return ''
  return crypto.createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36)
}

// 解析设备 token：账号级 > 全局配置 > 文件兜底（文件读取由调用方注入 deviceTokenFileReader）
function resolveDeviceToken(account, opts = {}) {
  if (account?.deviceToken) return account.deviceToken
  if (opts.deviceToken) return opts.deviceToken
  if (opts.deviceTokenFileReader) {
    try {
      const v = opts.deviceTokenFileReader()
      if (v) return String(v).trim()
    } catch {
      /* 读失败 → 空串，优雅降级 */
    }
  }
  return ''
}

// 用量归属头：默认使用官方桌面端指纹；SaaS 模式走旧行为；
// codebuddy 身份跟随 CodeBuddy 品牌与 IDE 版本（后台用量归因与「使用端」口径一致）
function attribHeaders(opts = {}) {
  const name = opts.clientName || 'WorkBuddy'
  if (name === 'SaaS') return { 'X-Product': 'SaaS' }
  const codebuddy = opts.clientIdentity === 'codebuddy'
  const ideName = codebuddy ? 'CodeBuddy' : name
  const version = codebuddy
    ? idv(opts, 'ideVersion') || C.DEFAULT_IDE_VERSION
    : idv(opts, 'clientVersion') || C.DEFAULT_CLIENT_VERSION
  return {
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': ideName,
    'X-IDE-Type': ideName,
    'X-IDE-Version': version,
    'X-Product': ideName
  }
}

// 生成 32 位 hex 消息 ID
function newMessageID() {
  return crypto.randomBytes(16).toString('hex')
}

// 校验 B3 TraceId 合法性：长度 16 或 32 且全 hex
function validTraceID(s) {
  const v = String(s || '')
  if (v.length !== 16 && v.length !== 32) return false
  return /^[0-9a-fA-F]+$/.test(v)
}

// 公共请求头（所有 API 共享）
function commonHeaders(account, opts = {}) {
  const origin = originRefererOf(account, opts)
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': userAgent(account, opts),
    'X-CodeBuddy-Request': '1', // 官方风控闸门头，所有 API 必带
    'Accept-Language': acceptLanguage(opts)
  }
  const uid = account?.uid || ''
  if (uid) {
    headers['X-Machine-ID'] = deriveAccountStableID(uid, 'machine')
    headers['X-Session-ID'] = deriveAccountStableID(uid, 'session')
  }
  return headers
}

// 会话头族（消息级 32 hex ID + 轮级聚合 ID）
function conversationHeaders(meta = {}) {
  const messageID = newMessageID()
  const convReqID = meta.conversationRequestId || newMessageID()
  const headers = {
    'X-Conversation-Request-ID': convReqID,
    'X-Conversation-Message-ID': messageID,
    'X-Request-ID': messageID,
    'X-Root-Request-ID': convReqID,
    'X-Trace-ID': meta.traceId || convReqID,
    'X-B3-TraceId': validTraceID(convReqID) ? convReqID : messageID,
    'X-B3-SpanId': messageID.slice(0, 16),
    'X-B3-Sampled': '1'
  }
  if (meta.conversationId) headers['X-Conversation-ID'] = meta.conversationId
  return headers
}

// 聊天请求头：CommonHeaders + 鉴权 + 账号头 + 归属头 + 会话头族 + 设备头
function chatHeaders(account, meta = {}, opts = {}) {
  const headers = { ...commonHeaders(account, opts) }
  headers.Accept = 'application/json, text/event-stream'

  const accessToken = account?.accessToken || ''
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  else headers['X-No-Authorization'] = '1'

  const uid = account?.uid || ''
  if (uid) headers['X-User-Id'] = uid
  else headers['X-No-User-Id'] = '1'

  // 企业与域头：EnterpriseID/Domain 原样透传，缺省 X-No-*
  const enterpriseId = account?.enterpriseId || ''
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId
  else headers['X-No-Enterprise-Id'] = '1'
  const domain = account?.domain || ''
  if (domain) headers['X-Domain'] = domain
  else headers['X-No-Department-Info'] = '1'

  Object.assign(headers, attribHeaders(opts))

  const ip = opts.clientIP || ''
  if (opts.passthroughIP && ip) {
    headers['X-Forwarded-For'] = ip
    headers['X-Real-IP'] = ip
    headers['X-Client-IP'] = ip
  }

  const deviceToken = resolveDeviceToken(account, opts)
  if (deviceToken) headers['X-Device-Token'] = deviceToken

  Object.assign(headers, conversationHeaders(meta))
  // 安全红线：chat 请求永不携带 X-Refresh-Token
  return headers
}

// billing / growth 域请求头
function billingHeaders(account, opts = {}) {
  const headers = {
    Authorization: `Bearer ${account?.accessToken || ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguage(opts) // billing 域未走 commonHeaders，单独注入
  }
  const ua = opts.userAgent || billingUA(opts)
  if (ua) headers['User-Agent'] = ua

  const uid = account?.uid || ''
  if (uid) headers['X-User-Id'] = uid
  const enterpriseId = account?.enterpriseId || ''
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId
    headers['X-Tenant-Id'] = enterpriseId // 与 Enterprise-Id 同值，同时发
  }
  const domain = account?.domain || ''
  if (domain) headers['X-Domain'] = domain
  const deviceToken = resolveDeviceToken(account, opts)
  if (deviceToken) headers['X-Device-Token'] = deviceToken
  return headers
}

// token 刷新请求头（X-Refresh-Token 仅允许出现在此）
function refreshHeaders(account, refreshToken, opts = {}) {
  const headers = { ...commonHeaders(account, opts) }
  headers['X-Refresh-Token'] = refreshToken
  const enterpriseId = account?.enterpriseId || ''
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId
  headers['X-Auth-Refresh-Source'] = 'plugin'
  return headers
}

// 桌面端事件链请求头（report / 外观设置）
function desktopHeaders(account, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': desktopUA(opts),
    'X-CodeBuddy-Request': '1',
    Authorization: `Bearer ${account?.accessToken || ''}`,
    'X-User-Id': account?.uid || '',
    'x-client-platform': 'desktop'
  }
  const enterpriseId = account?.enterpriseId || ''
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId
  return headers
}

// 官网域请求头（web 口径领奖 / 上报）
function webHeaders(account, opts = {}) {
  const origin = originRefererOf(account, opts)
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': userAgent(account, opts),
    'X-CodeBuddy-Request': '1',
    'x-client-platform': 'web',
    Origin: origin,
    Referer: `${origin}/`,
    Authorization: `Bearer ${account?.accessToken || ''}`,
    'X-User-Id': account?.uid || ''
  }
}

// /v3/config 专用请求头（UA 敏感：缺 CodeBuddy 版本号会 400 code=12403）
function v3ConfigHeaders(account, opts = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Authorization: `Bearer ${account?.accessToken || ''}`,
    'X-Product': 'SaaS',
    'User-Agent': opts.userAgent || v3ConfigUA(opts),
    'X-CodeBuddy-Request': '1'
  }
  const uid = account?.uid || ''
  if (uid) headers['X-User-Id'] = uid
  headers['X-Domain'] = v3ConfigDomain(account, opts)
  return headers
}

// /v3/config 的 X-Domain：账号 domain 去 scheme/尾斜杠 > chatBase host > 默认
function v3ConfigDomain(account, opts = {}) {
  const raw = String(account?.domain || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .trim()
  if (raw) return raw
  const chatBase = chatBaseOf(account, opts)
  try {
    return new URL(chatBase).host
  } catch {
    return 'copilot.tencent.com'
  }
}

// chat 域（opts 可覆盖）
function chatBaseOf(account, opts = {}) {
  return opts.chatBaseCN || C.CHAT_BASE_CN
}

// billing 域（opts 可覆盖）
function billingBaseOf(account, opts = {}) {
  return opts.billingBaseCN || C.BILLING_BASE_CN
}

// 官网域（opts 可覆盖）
function webBaseOf(account, opts = {}) {
  return opts.webBaseCN || C.WEB_BASE_CN
}

// 从入站请求提取客户端 IP（X-Forwarded-For 第一段，回落 X-Real-IP）
function extractClientIP(headers) {
  const get = name => {
    if (!headers) return ''
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
    return key ? String(headers[key] ?? '') : ''
  }
  const xff = get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0].trim()
    if (first) return first
  }
  return get('x-real-ip').trim()
}

module.exports = {
  idv,
  userAgent,
  billingUA,
  desktopUA,
  v3ConfigUA,
  oauthUA,
  deriveAccountStableID,
  resolveDeviceToken,
  newMessageID,
  validTraceID,
  acceptLanguage,
  originRefererOf,
  commonHeaders,
  conversationHeaders,
  chatHeaders,
  billingHeaders,
  refreshHeaders,
  desktopHeaders,
  webHeaders,
  v3ConfigHeaders,
  chatBaseOf,
  billingBaseOf,
  webBaseOf,
  extractClientIP
}