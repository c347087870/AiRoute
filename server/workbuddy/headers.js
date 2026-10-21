// WorkBuddy 出站请求头构造

const crypto = require('crypto')
const C = require('./constants')

// 读 identity 覆盖值（缺失/非字符串返回空串；调用方按「空串回落默认」消费）
function idv(opts, key) {
  const v = opts && opts.identity ? opts.identity[key] : ''
  return typeof v === 'string' ? v : ''
}

// ===== 区域判定 =====
// 区域有两个来源，二者都要认：
//   1. account.realm —— 账号对象自身（请求转发 / 账号运维等已有账号的场景）
//   2. opts.realm    —— 调用方显式指定（OAuth 登录阶段**还没有账号对象**，
//                       此时 account 传的是 null，区域只能靠 opts 带进来）
// 早先只认 account.realm，导致「选国际版添加账号」时 OAuth 仍走国内域名——
// 授权链接指向国内站，登录自然拿不到国际版凭证。
function isGlobalAccount(account, opts) {
  if (account && account.realm === 'global') return true
  if (opts && opts.realm === 'global') return true
  return false
}

// Accept-Language：国际版 en-US，国内版 zh-CN
// identity.acceptLanguage 覆盖只在国内版生效（与域名覆盖同理：它是给国内链路的调节项）
function acceptLanguage(opts = {}, account = null) {
  if (isGlobalAccount(account, opts)) return C.GLOBAL_ACCEPT_LANGUAGE
  return idv(opts, 'acceptLanguage') || 'zh-CN'
}

// Origin/Referer 基础域：国际版 workbuddy.ai，国内版 codebuddy.cn
// identity.originReferer 覆盖同样只在国内版生效
function originRefererOf(account, opts = {}) {
  if (isGlobalAccount(account, opts)) return C.ORIGIN_REFERER_GLOBAL
  return idv(opts, 'originReferer') || C.ORIGIN_REFERER_CN
}

// 客户端出站 UA（chat / refresh / 模型目录共用）：按「使用端身份」（opts.clientIdentity）组装——
// workbuddy（默认）= 官方 WorkBuddy 桌面端三段式；codebuddy = 官方 CodeBuddy IDE 两段式
// （官网积分记录「使用端」列按出站 UA 服务端归因，故身份切换即改这里）
// identity 可整串覆盖（workbuddyUA / codebuddyUA），也可只覆盖版本号段
// 国际版账号：平台段必须换成官方国际版 productName（WorkBuddy AI），
// 送成国内版的 WorkBuddy 可能触发上游 403 code 11140
function userAgent(account, opts = {}) {
  if (opts.userAgent) return opts.userAgent // 显式覆盖一切
  const clientVersion = idv(opts, 'clientVersion') || C.DEFAULT_CLIENT_VERSION
  const cliVersion = idv(opts, 'cliVersion') || C.DEFAULT_CLI_VERSION

  // 国际版优先于 clientIdentity：平台段（WorkBuddy AI）是国际链路的硬要求，
  // 送错可能触发上游 403 code 11140；而 clientIdentity 是国内站「使用端」归因的概念，
  // 对国际站不适用。曾把 clientIdentity 判断放在前面，导致配置里选了 codebuddy 时
  // 国际版账号拿到 CodeBuddyIDE/... 的 UA（既不是 WorkBuddy AI，也不是国际形态）。
  if (isGlobalAccount(account, opts)) {
    // workbuddyUA 是「整串 UA 覆盖」，其持久化值通常是从界面保存下来的国内版形态
    // （WorkBuddy/<v> WorkBuddy/<v> CLI/<v>）——直接采信会把平台段降级。
    // 仅当覆盖串本身就含国际版平台段时才采信；版本号覆盖照常生效。
    const override = idv(opts, 'workbuddyUA')
    if (override && override.includes(C.GLOBAL_UA_PLATFORM)) return override
    return `WorkBuddy/${clientVersion} ${C.GLOBAL_UA_PLATFORM}/${clientVersion} CLI/${cliVersion}`
  }

  if (opts.clientIdentity === 'codebuddy') {
    const ideVersion = idv(opts, 'ideVersion') || C.DEFAULT_IDE_VERSION
    return idv(opts, 'codebuddyUA') || `CodeBuddyIDE/${ideVersion} CodeBuddy/${ideVersion}`
  }
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
// 国际版：平台段同为官方国际版 productName（WorkBuddy AI）
function billingUA(opts = {}, account = null) {
  const name = opts.clientName || 'WorkBuddy'
  if (name === 'SaaS') return ''
  const clientVersion = idv(opts, 'clientVersion') || C.DEFAULT_CLIENT_VERSION
  // 国际版优先于 clientIdentity（同 userAgent：平台段是国际链路硬要求）
  if (isGlobalAccount(account, opts)) {
    // 持久化的 workbuddyBillingUA 通常是国内版形态（WorkBuddy/<v>），直接采信会降级平台段
    const override = idv(opts, 'workbuddyBillingUA')
    if (override && override.includes(C.GLOBAL_UA_PLATFORM)) return override
    return `${C.GLOBAL_UA_PLATFORM}/${clientVersion}`
  }
  if (opts.clientIdentity === 'codebuddy') {
    const ideVersion = idv(opts, 'ideVersion') || C.DEFAULT_IDE_VERSION
    return idv(opts, 'codebuddyBillingUA') || `CodeBuddy/${ideVersion}`
  }
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
    'Accept-Language': acceptLanguage(opts, account)
  }
  const uid = account?.uid || ''
  if (uid) {
    headers['X-Machine-ID'] = deriveAccountStableID(uid, 'machine')
    headers['X-Session-ID'] = deriveAccountStableID(uid, 'session')
  }
  return headers
}

// 会话头族（消息级 32 hex ID + 轮级聚合 ID + 会话 ID）
// X-Conversation-ID **始终发送**：国际端点收紧了通道校验，缺该头会直接
// 400 / 11-128（conversation id missing）。caller 没给会话 ID（Anthropic /
// Claude Code 入站不带 conversation_id）时按 32 hex 现场生成——
// 上游要的是「像一个官方客户端的多轮会话链路」，不是特定值。
function conversationHeaders(meta = {}) {
  const messageID = newMessageID()
  const convReqID = meta.conversationRequestId || newMessageID()
  const conversationID = meta.conversationId || newMessageID()
  const headers = {
    'X-Conversation-ID': conversationID,
    'X-Conversation-Request-ID': convReqID,
    'X-Conversation-Message-ID': messageID,
    'X-Request-ID': messageID,
    'X-Root-Request-ID': convReqID,
    'X-Trace-ID': meta.traceId || convReqID,
    'X-B3-TraceId': validTraceID(convReqID) ? convReqID : messageID,
    'X-B3-SpanId': messageID.slice(0, 16),
    'X-B3-Sampled': '1'
  }
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
  // 国际版例外（见下）：企业头与域头都写死为国际版形态，不回退登录返回的 domain
  const enterpriseId = account?.enterpriseId || ''
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId
  else headers['X-No-Enterprise-Id'] = '1'
  const global = isGlobalAccount(account, opts)
  if (global) {
    // 国际版 chat 专属声明：显式声明「无企业」+ 域写死 workbuddy.ai。
    // 登录返回的 domain 可能是别的取值，透传会被上游判为可疑请求
    headers['X-No-Enterprise-Id'] = '1'
    delete headers['X-Enterprise-Id']
    headers['X-Domain'] = C.GLOBAL_DOMAIN_HEADER
  } else {
    const domain = account?.domain || ''
    if (domain) headers['X-Domain'] = domain
    else headers['X-No-Department-Info'] = '1'
  }

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
    'Accept-Language': acceptLanguage(opts, account) // billing 域未走 commonHeaders，单独注入
  }
  const ua = opts.userAgent || billingUA(opts, account)
  if (ua) headers['User-Agent'] = ua

  const uid = account?.uid || ''
  if (uid) headers['X-User-Id'] = uid
  const enterpriseId = account?.enterpriseId || ''
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId
    headers['X-Tenant-Id'] = enterpriseId // 与 Enterprise-Id 同值，同时发
  }
  if (isGlobalAccount(account, opts)) {
    // 国际版：域写死 workbuddy.ai，与 chat 通道口径一致
    headers['X-Domain'] = C.GLOBAL_DOMAIN_HEADER
  } else {
    const domain = account?.domain || ''
    if (domain) headers['X-Domain'] = domain
  }
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
// uaOverride：国际版目录探测需要并发多种 UA（不同 UA 下发不同模型集），
// 传了就用它，不再走 v3ConfigUA 的 identity 覆盖
function v3ConfigHeaders(account, opts = {}, uaOverride = '') {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Authorization: `Bearer ${account?.accessToken || ''}`,
    'X-Product': 'SaaS',
    'User-Agent': uaOverride || opts.userAgent || v3ConfigUA(opts),
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

// chat 域：按账号区域切（国际版 workbuddy.ai / 国内版 copilot.tencent.com）
// 优先级：显式 chatBaseCN > 账号区域 > identity.chatBase 覆盖 > 内置默认
//
// 注意：identity 的域名覆盖（chatBase/billingBase/webBase）语义是「给国内版换自定义端点」，
// 因此**只在国内版生效**。曾把它放在区域判断之后无条件读取，导致配置里一旦设过
// identity.chatBase，国际版也会被拉回该域名（实测：选了国际版仍拿到国内站授权链接）。
function chatBaseOf(account, opts = {}) {
  if (opts.chatBaseCN) return opts.chatBaseCN
  if (isGlobalAccount(account, opts)) return C.GLOBAL_CHAT_BASE
  return idv(opts, 'chatBase') || C.CHAT_BASE_CN
}

// billing 域：国际版与 chat 同域
function billingBaseOf(account, opts = {}) {
  if (opts.billingBaseCN) return opts.billingBaseCN
  if (isGlobalAccount(account, opts)) return C.GLOBAL_BILLING_BASE
  return idv(opts, 'billingBase') || C.BILLING_BASE_CN
}

// 官网域：国际版与 chat 同域
function webBaseOf(account, opts = {}) {
  if (opts.webBaseCN) return opts.webBaseCN
  if (isGlobalAccount(account, opts)) return C.GLOBAL_WEB_BASE
  return idv(opts, 'webBase') || C.WEB_BASE_CN
}

// ===== 计费域路径（按区域）=====
// 国内版只认带 /v2 前缀的形态；国际版反过来——无前缀优先，404 时回落 /v2。
// 顺序写反会让国际版计费调用常态失败（每次多一次 404 往返，甚至直接判失败）。

// 余额查询路径候选序列（按优先级）
// opts：与其它头函数一致，用于 OAuth / 无账号对象场景下按 opts.realm 判定区域
function billingMeterPathsOf(account, opts = {}) {
  if (isGlobalAccount(account, opts)) return [C.BILLING_METER_PATH_GLOBAL, C.BILLING_METER_PATH_GLOBAL_V2]
  return [C.BILLING_METER_PATH_V2]
}

// 签到路径候选序列（按优先级）
function checkinPathsOf(account, opts = {}) {
  if (isGlobalAccount(account, opts)) return [C.DAILY_CHECKIN_PATH_GLOBAL, C.DAILY_CHECKIN_PATH_GLOBAL_V2]
  return [C.DAILY_CHECKIN_PATH_V2]
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
  extractClientIP,
  // 区域
  isGlobalAccount,
  billingMeterPathsOf,
  checkinPathsOf,
  v3ConfigHeaders
}