// 上游错误分类：统一判定错误类型，决定账号处置与是否换号

// 错误类型枚举（字符串值即日志/提示中使用的标识）
const ERR_KIND = {
  NONE: 'none', // 成功
  HARD_CREDIT: 'hard_credit', // 余额不足（402 / 关键词 / 429+14018）
  SOFT_RATE: 'soft_rate', // 软限流（429 / 限流文案）
  SESSION_DEAD: 'session_dead', // 401 + 12153 session 失效
  NOT_FOUND: 'not_found', // 404
  SERVER: 'server', // 5xx
  CONTENT_BLOCKED: 'content_blocked', // 内容策略拦截
  BAD_PARAMS: 'bad_params', // 请求体解析失败（11101）
  ACCOUNT_FAULT: 'account_fault', // 账号级授权/配额故障
  MODEL_BLOCKED: 'model_blocked', // 11102 该后端无此模型 / 11158 账号×模型无权限
  CHANNEL_REFUSED: 'channel_refused', // 11-128 通道校验失败（账号健康，不罚号）
  UPSTREAM_BUSY: 'upstream_busy', // 6021 渠道队列满载（非账号问题，不罚号不轮转）
  WAF_BLOCK: 'waf_block', // 403 + 非业务信封（WAF 页）
  PROMPT_TOO_LONG: 'prompt_too_long', // 11115 prompt 过长
  IMAGE_INVALID: 'image_invalid', // 图片格式/数据无效
  TIMEOUT: 'timeout', // 首字节超时（本地判定，非上游响应）
  CLIENT: 'client' // 其他 4xx 兜底
}

// 余额不足关键词（小写匹配）
const HARD_MARKERS = [
  'insufficient credit',
  'no credit',
  'credit exhausted',
  'credits exhausted',
  'out of credit',
  'quota exceeded',
  'quota exhaust',
  'payment required',
  'credit not enough',
  'not enough credit',
  '积分不足',
  '额度不足',
  '余额不足',
  '积分用完',
  '额度用尽',
  '没有积分'
]

// 限流关键词（小写匹配）
const SOFT_RATE_MARKERS = [
  'rate limit',
  'rate-limiting',
  'rate-limited',
  'too many requests',
  'too many',
  'usage limit',
  '请求过于频繁',
  '限流'
]

// session 失效关键词（大小写敏感）
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

// 账号级故障关键词（小写匹配）
// 注意：'request illegal' 不能作为通用 marker——WorkBuddy 的 11-128 通道校验失败
// （{"code":"11-128","msg":"request illegal"}）与 11140 账号限制（{"code":11140,
// "msg":"request illegal"}）文案完全相同。只看文案会把一次通道校验失败误判成账号
// 封禁并硬禁用健康账号。11140 的判定统一走 isAccountRestricted（code + 文案双条件）。
const ACCOUNT_FAULT_MARKERS = ['trial not activated', 'trial version is not yet activated']

// 11140 / 11-128 共用的正文关键词
const REQUEST_ILLEGAL_MSG = 'request illegal'

// 业务码是否存在（不依赖 JSON 可解析：上游 11-128 的 code 是带连字符的字符串，
// 非法 JSON 形态也出现过，故按字面量多形态匹配）
function literalCode(raw, code) {
  const s = String(raw || '')
  const forms = [`"code":"${code}"`, `"code":" ${code}"`, `"code":${code}`, `"code": ${code}`]
  return forms.some(f => s.includes(f))
}

// 是否 11-128 通道校验失败（上游认为请求不是官方客户端发出）
// 必须 code + 文案双条件：11-128 还承载内容审核变体（"blocked by security policy"，
// 应归 content_blocked），按 code 一刀切会把内容拦截也变成通道拒绝。
function isChannelRefused(body) {
  const raw = String(body || '')
  if (!raw.toLowerCase().includes(REQUEST_ILLEGAL_MSG)) return false
  return literalCode(raw, '11-128')
}

// 是否 11140 账号被上游限制（异常行为/风控）
// 必须 code + 文案双条件：
//   - 只看文案："request illegal" 也出现在 11-128 通道校验失败里（健康账号）；
//   - 只看 code：11140 也承载模型级限流文案（"The model provider is rate-limiting
//     requests."），那种场景必须保持 soft_rate。
function isAccountRestricted(body) {
  const raw = String(body || '')
  if (!raw.toLowerCase().includes(REQUEST_ILLEGAL_MSG)) return false
  return literalCode(raw, '11140')
}

// 内容拦截关键词（小写匹配）
const CONTENT_BLOCKED_MARKERS = ['blocked by security policy', 'unapproved channel', 'illegal api invocation']

// 图片无效关键词（小写匹配，仅 400）
const INVALID_IMAGE_MARKERS = ['invalid image_url content', 'invalid_image_data', 'replace the image']

// prompt 过长标记（原文匹配，非小写化）
const PROMPT_TOO_LONG_MARKERS = ['"code":11115', '"code": 11115', '"code":"11115"', 'prompt is too long']

// 请求体解析失败标记
const BAD_PARAMS_MARKER_MSG = 'Unmarshal chat params failed'
const BAD_PARAMS_MARKER_CODE = '"code":11101'

// 已签到关键词（幂等判定）
const ALREADY_CHECKIN_MARKERS = ['已签到', 'already']

// 业务码命中：codeMarker(lower, code)，检测 N 的各种 JSON 形态
function codeMarker(lowerBody, code) {
  const forms = [
    `"code":${code}`,
    `"code": ${code}`,
    `"code":"${code}"`,
    `"code": "${code}"`,
    `"code":" ${code}"`,
    `"code": '${code}'`
  ]
  return forms.some(f => lowerBody.includes(f))
}

// 截断错误消息（保留前 200 字符）
function truncateMsg(body, maxLen = 200) {
  const s = String(body || '')
  return s.length > maxLen ? s.slice(0, maxLen) : s
}

// 递归遍历 JSON，任一 code 字段等于 want → true
function hasBusinessCode(body, want) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  const stack = [parsed]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }
    if (typeof node.code !== 'undefined' && String(node.code).trim() === String(want)) return true
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return false
}

// 确定性模型拒绝的两个业务码：
//   11102「该后端无此模型」——模型在该后端不存在
//   11158「该账号类型无权使用该模型」——同一模型在不同账号类型上权限不同，
//         换有权限的账号仍可能成功，所以与 11102 同属 (账号,模型) 负缓存
const MODEL_BLOCK_CODE = '11102'
const MODEL_FORBIDDEN_CODE = '11158'
const MODEL_BLOCK_MSG = 'service info not found'
const MODEL_FORBIDDEN_MSG = 'is not allowed for user type'

// 取确定性模型拒绝的负缓存 reason（pool.blockModelClear 按前缀区分条目，
// 不能碰 6004 的独立冷却表——6004 有自身上游重置墙钟语义）
function modelBlockReasonFor(body) {
  const raw = String(body || '')
  const lower = raw.toLowerCase()
  if (literalCode(raw, MODEL_FORBIDDEN_CODE) || lower.includes(MODEL_FORBIDDEN_MSG)) {
    return '11158 model not allowed for account type'
  }
  return '11102 model not available'
}

// 是否确定性模型拒绝（11102 该后端无此模型 / 11158 账号类型无权限）：仅 400/404
// 只比对 code/msg 独立字段，绝不做整段文本子串匹配——错误体还带 requestId 等字段，
// 拿整段文本匹配会把 code 撞在 ID 上、误避让一个本来能用的模型。
function isModelBlocked(status, body) {
  if (status !== 400 && status !== 404) return false
  if (!body) return false
  const lower = body.toLowerCase()
  if (
    !body.includes(MODEL_BLOCK_CODE) &&
    !body.includes(MODEL_FORBIDDEN_CODE) &&
    !lower.includes(MODEL_BLOCK_MSG) &&
    !lower.includes(MODEL_FORBIDDEN_MSG)
  ) {
    return false
  }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  const layers = [parsed]
  if (parsed && typeof parsed.error === 'object' && parsed.error) layers.push(parsed.error)

  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    const code = layer.code ?? layer.errCode ?? layer.error_code
    const msg = typeof layer.msg === 'string' ? layer.msg : typeof layer.message === 'string' ? layer.message : ''
    const codeStr = String(code).trim()
    if (codeStr === MODEL_BLOCK_CODE || codeStr === MODEL_FORBIDDEN_CODE) return true
    const lowerMsg = msg.toLowerCase()
    if (lowerMsg.includes(MODEL_BLOCK_MSG) || lowerMsg.includes(MODEL_FORBIDDEN_MSG)) return true
  }
  return false
}

// 是否 WAF 拦截页：403 且无业务信封
function isWafBlocked(status, body) {
  if (status !== 403) return false
  const s = String(body || '')
  const hasEnvelope = s.includes('"code":') || s.includes('"msg":')
  return !hasEnvelope
}

// 是否模型级 429 限流（code 6004）
function isModelRateLimit(body) {
  return /"code"\s*:\s*"?6004"?/.test(String(body || ''))
}

// 是否渠道级队列满载（code 6021 queue.full）：推理集群排队打满时上游回
// 429 + {"code":6021,"msg":"queue.full.title"}。这是渠道容量事件，不是账号问题——
// 同一时刻换任何账号都撞同一堵墙。按限流处置会逐号软冷却，实测 2 秒绞杀整池健康号。
// 结构码为主判据，"queue.full" 文案为外卡（避免 code 形态差异漏判）。
function isUpstreamBusy(body) {
  const raw = String(body || '')
  if (literalCode(raw, '6021')) return true
  return raw.toLowerCase().includes('queue.full')
}

// 是否重复签到（幂等判定）
// 只认"带分类的错误"（HTTP ≥400 或业务 code≠0 的响应体）；
// 2xx 成功与网络层错误一律不算幂等，否则会把真实签到成功误标为「已签到」
function isAlreadyCheckin(status, body) {
  if (status < 400) return false
  const s = String(body || '')
  return ALREADY_CHECKIN_MARKERS.some(m => s.toLowerCase().includes(m.toLowerCase()))
}

// 状态码是否属于 prompt 过长可判定范围
function isPromptTooLongStatus(status) {
  return status === 400 || status === 404 || status === 413
}

// 统一错误分类：判定顺序固定，命中即返回
function classify(status, body) {
  const raw = String(body || '')
  const lower = raw.toLowerCase()

  // 0. 11102 该后端无此模型（语义最具体，最先判）
  if (isModelBlocked(status, raw)) return ERR_KIND.MODEL_BLOCKED
  // 1. 402 真正的计费耗尽
  if (status === 402) return ERR_KIND.HARD_CREDIT
  // 2. session 失效（须先于 429：401+12153 混排 rate limit 文案仍属 session 失效）
  if (SESSION_DEAD_MARKERS.some(m => raw.includes(m))) return ERR_KIND.SESSION_DEAD
  // 3. 通道校验失败 / 账号被限制（11-128 与 11140 的 msg 同为 "request illegal"，
  //    必须按业务码分流，且都须先于 429 与 4xx 兜底）：
  //      - 11-128 = 通道校验失败（上游认为请求不是官方客户端发出）→ 账号健康，不罚号
  //      - 11140 = 账号被上游限制（异常行为/风控）→ account_fault，由策略层禁用
  if (isChannelRefused(raw)) return ERR_KIND.CHANNEL_REFUSED
  if (isAccountRestricted(raw)) return ERR_KIND.ACCOUNT_FAULT
  // 3.1 账号级故障（须先于 429：429+14017 属账号故障）
  if (ACCOUNT_FAULT_MARKERS.some(m => lower.includes(m))) return ERR_KIND.ACCOUNT_FAULT
  // 3.2 渠道级队列满载（6021）：须先于 status==429 兜底，否则整池被误冷却
  if (isUpstreamBusy(raw)) return ERR_KIND.UPSTREAM_BUSY
  // 4. 429 + 14018 = 积分耗尽（须先于通用 429 兜底）
  if (status === 429 && hasBusinessCode(raw, '14018')) return ERR_KIND.HARD_CREDIT
  // 5. 通用 429 = 软限流
  if (status === 429) return ERR_KIND.SOFT_RATE
  // 6. 余额关键词
  if (HARD_MARKERS.some(m => lower.includes(m))) return ERR_KIND.HARD_CREDIT
  // 7. 限流关键词
  if (SOFT_RATE_MARKERS.some(m => lower.includes(m))) return ERR_KIND.SOFT_RATE
  // 8. prompt 过长（须先于 404/5xx/WAF/4xx 兜底，避免误冷却账号）
  if (isPromptTooLongStatus(status) && PROMPT_TOO_LONG_MARKERS.some(m => raw.includes(m))) {
    return ERR_KIND.PROMPT_TOO_LONG
  }
  // 9. 404
  if (status === 404) return ERR_KIND.NOT_FOUND
  // 10. 5xx
  if (status >= 500) return ERR_KIND.SERVER
  // 11. WAF 拦截页
  if (isWafBlocked(status, raw)) return ERR_KIND.WAF_BLOCK
  // 12. 400 + 11135 = 图片无效
  if (status === 400 && codeMarker(lower, '11135')) return ERR_KIND.IMAGE_INVALID
  // 13. 400 + 图片无效文案
  if (status === 400 && INVALID_IMAGE_MARKERS.some(m => lower.includes(m))) return ERR_KIND.IMAGE_INVALID
  // 14. 其余 4xx：内容拦截 → 请求体解析失败 → 客户端兜底
  if (status >= 400) {
    if (CONTENT_BLOCKED_MARKERS.some(m => lower.includes(m))) return ERR_KIND.CONTENT_BLOCKED
    if (raw.includes(BAD_PARAMS_MARKER_MSG) || raw.includes(BAD_PARAMS_MARKER_CODE)) return ERR_KIND.BAD_PARAMS
    return ERR_KIND.CLIENT
  }
  // 15. 成功
  return ERR_KIND.NONE
}

// 解析上游明示的等待时长（Retry-After 族头），失败返回 0
function parseRetryAfter(headers) {
  const get = name => {
    if (!headers) return ''
    if (typeof headers.get === 'function') return headers.get(name) || ''
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase())
    return key ? String(headers[key] ?? '') : ''
  }

  const isAllDigits = v => /^\d+$/.test(v)
  const sanityMaxMs = 2 * 60 * 60 * 1000

  const candidates = [
    { name: 'Retry-After', maxVal: 7200, toMs: n => n * 1000 },
    { name: 'Retry-After-Ms', maxVal: 7200000, toMs: n => n },
    { name: 'X-Ratelimit-Reset', maxVal: null, toMs: null }
  ]

  for (const c of candidates) {
    const raw = get(c.name).trim()
    if (!raw || !isAllDigits(raw) || raw.length > 16) continue
    const n = Number(raw)
    if (!Number.isFinite(n)) continue

    let ms
    if (c.name === 'X-Ratelimit-Reset') {
      const epochMs = raw.length >= 12 ? n : n * 1000
      ms = epochMs - Date.now()
    } else {
      if (n > c.maxVal) continue
      ms = c.toMs(n)
    }
    if (ms <= 0 || ms > sanityMaxMs) continue
    return ms
  }
  return 0
}

// 解析限流重置墙钟：CN 文案「将在 … 重置」/ EN 文案 reset at YYYY-MM-DD HH:MM:SS（按 UTC+8 解释）
function parseRateReset(body) {
  const raw = String(body || '')
  const cn = raw.match(/将在 (.+?) 重置/)
  const en = raw.match(/reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/i)
  const value = cn ? cn[1] : en ? en[1] : ''
  if (!value) return 0
  const cleaned = value.replace(/\s*UTC\+8\s*$/i, '').trim()
  const m = cleaned.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return 0
  const CST_OFFSET_MS = 8 * 60 * 60 * 1000
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - CST_OFFSET_MS
  return ms
}

// 各错误类型的网关提示（gateway_hint，与上游原文并列，不替换 message）
const GATEWAY_HINTS = {
  [ERR_KIND.PROMPT_TOO_LONG]: "request context exceeds the model's limit; reduce history/message size",
  [ERR_KIND.IMAGE_INVALID]: 'image request was rejected by upstream; check image_url format and image data',
  [ERR_KIND.WAF_BLOCK]: 'upstream WAF blocked the gateway; retry after the block window',
  [ERR_KIND.SOFT_RATE]: 'rate limited by upstream; retry after reset',
  [ERR_KIND.ACCOUNT_FAULT]: 'account-level fault at upstream (auth/quota state); the gateway will rotate or disable this account',
  [ERR_KIND.SESSION_DEAD]: 'account session expired at upstream; the account is disabled until re-login',
  [ERR_KIND.HARD_CREDIT]: 'account credits exhausted at upstream; waiting for daily check-in to restore',
  [ERR_KIND.MODEL_BLOCKED]: 'upstream has no such model on this backend; switch model or retry on another account',
  [ERR_KIND.CHANNEL_REFUSED]: 'upstream rejected this channel request (it did not look like an official client); the account itself is healthy and the gateway keeps rotating',
  [ERR_KIND.UPSTREAM_BUSY]: 'upstream inference queue is full (not an account problem); wait a moment and retry',
  [ERR_KIND.CONTENT_BLOCKED]: 'request content was rejected by content policy; adjust the prompt and retry',
  [ERR_KIND.TIMEOUT]: 'upstream did not return response headers before the deadline; the gateway stops rotating accounts for this request, retry later'
}

// ===== gateway_hint =====
// error.message 永远是上游原文透传；gateway_hint 只做并列的网关视角补充说明，未覆盖形态返回空串

// 11133 model_param_invalid 家族（宁宽勿漏：hint 是补充说明非权威分类）
function isModelParamInvalid(body) {
  const lower = String(body || '').toLowerCase()
  return (
    codeMarker(lower, '11133') ||
    lower.includes('model_param_invalid') ||
    lower.includes('invalid request parameters') ||
    lower.includes('request parameters do not meet the current model requirements')
  )
}

// 11135 invalid_image_data 家族
function isInvalidImageData(body) {
  const lower = String(body || '').toLowerCase()
  return codeMarker(lower, '11135') || lower.includes('invalid_image_data') || lower.includes('replace the image')
}

// 按错误形态返回网关补充说明；ctx: { model, hasImage, modelInCatalog, modelSupportsImages }
function gatewayHint(kind, msg, ctx = {}) {
  // 11133/11135 上游业务码先于 Kind 表判定
  if (isModelParamInvalid(msg)) {
    if (ctx.hasImage && ctx.modelInCatalog && !ctx.modelSupportsImages) {
      return `model ${ctx.model || ''} does not support images; pick one with supports_images=true from /v1/models`
    }
    return 'request parameters were rejected by the model provider; check message format and model capabilities'
  }
  if (isInvalidImageData(msg)) {
    return 'image data rejected by upstream; use a real/valid image, may need a new conversation'
  }
  return GATEWAY_HINTS[kind] || ''
}

// 从 SSE error 帧 payload 判定错误类型（6004 优先，其余取 error.message 走分类）
function frameKind(payload) {
  if (isModelRateLimit(payload)) return ERR_KIND.SOFT_RATE
  let frame
  try {
    frame = JSON.parse(String(payload || ''))
  } catch {
    return ERR_KIND.CLIENT
  }
  const message = typeof frame?.error?.message === 'string' ? frame.error.message : ''
  if (!message) return ERR_KIND.CLIENT
  return classify(400, message)
}

// 本地调度类错误（池中无健康号）的固定 hint（无 ErrKind，不进 Kind 表）
function noHealthyAccountHint() {
  return NO_HEALTHY_HINT
}

// 账号池无可用账号时的本地提示
const NO_HEALTHY_HINT = 'no healthy account available in pool; check /status or retry later'
const NO_HEALTHY_CODE = 'no_healthy_account'

module.exports = {
  ERR_KIND,
  classify,
  gatewayHint,
  frameKind,
  noHealthyAccountHint,
  isModelParamInvalid,
  isInvalidImageData,
  codeMarker,
  hasBusinessCode,
  isModelBlocked,
  isChannelRefused,
  isAccountRestricted,
  isUpstreamBusy,
  modelBlockReasonFor,
  isWafBlocked,
  isModelRateLimit,
  isAlreadyCheckin,
  parseRetryAfter,
  parseRateReset,
  truncateMsg,
  NO_HEALTHY_HINT,
  NO_HEALTHY_CODE,
  ALREADY_CHECKIN_MARKERS,
  MODEL_BLOCK_CODE,
  MODEL_FORBIDDEN_CODE
}