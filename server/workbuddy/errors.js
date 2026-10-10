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
  MODEL_BLOCKED: 'model_blocked', // 11102 该后端无此模型
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
const ACCOUNT_FAULT_MARKERS = ['request illegal', 'trial not activated', 'trial version is not yet activated']

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

// 是否「该后端无此模型」（11102）：仅 400/404
function isModelBlocked(status, body) {
  if (status !== 400 && status !== 404) return false
  if (!body) return false
  const lower = body.toLowerCase()
  if (!body.includes('11102') && !lower.includes('service info not found')) return false

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
    if (String(code).trim() === '11102') return true
    if (msg.toLowerCase().includes('service info not found')) return true
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
  // 3. 账号级故障（须先于 429：429+14017 属账号故障）
  if (ACCOUNT_FAULT_MARKERS.some(m => lower.includes(m))) return ERR_KIND.ACCOUNT_FAULT
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
  isWafBlocked,
  isModelRateLimit,
  isAlreadyCheckin,
  parseRetryAfter,
  parseRateReset,
  truncateMsg,
  NO_HEALTHY_HINT,
  NO_HEALTHY_CODE,
  ALREADY_CHECKIN_MARKERS
}