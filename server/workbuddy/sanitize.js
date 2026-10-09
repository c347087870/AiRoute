// 指纹脱敏：出站请求体中对客户端指纹串做剥离与最小改写，避免上游内容审核逐字误杀
// 翻译自参考项目 internal/upstream/sanitize.go，行为逐字对齐

// 特征预检子串（大小写敏感 Contains），任一命中才进入净化流程
const SANITIZE_FEATURES = [
  'x-anthropic-billing-header', // header 键值段键名
  'cc_entrypoint=', // 尾随裸键值
  'You are Claude Code', // 身份句
  'Main branch (', // 注入指令句
  'You are a coding agent running in the Codex CLI', // Codex instructions 首段
  'github.com/anthropics/', // 反馈句里的仓库链接
  '11128' // 上游反探测：裸数字错误码
]

// 改写层：按数组顺序逐条全局替换（大小写敏感）
const SANITIZE_REWRITES = [
  // ① 身份句（匹配串不带结尾标点，同时覆盖 CLI 版与桌面版）
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude"
  ],
  // ② 注入指令句
  ['Main branch (you will usually use this for PRs)', 'Default branch (you will usually use this for PRs)'],
  // ③ Codex instructions 首段
  [
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.'
  ],
  // ④ 反馈句（只改 give→provide，语义不变）
  [
    'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues'
  ],
  // ⑤ 上游错误码反探测（零宽空格无效，用可见连字符）
  ['11128', '11-128']
]

// 剥离层正则：键值形态 header 整段删除（要求冒号，大小写不敏感）
const RE_HDR = /x-anthropic-billing-header:[^;\n]*;?[ \t\n\f\r]*/gi
// 剥离层正则：尾随裸键值整段删除（循环至稳定）
const RE_KV = /\bcc_[a-z0-9_]+=[^;\n]*;?[ \t\n\f\r]*/gi
// 兜底层正则：残留裸 header 键名最小缩写（不要求冒号，大小写不敏感）
const RE_BARE_HDR = /x-anthropic-billing-header/gi

// 是否含指纹：预检不中则整条净化跳过（文本零改动）
function hasFingerprint(text) {
  if (typeof text !== 'string' || !text) return false
  for (const f of SANITIZE_FEATURES) {
    if (text.includes(f)) return true
  }
  RE_BARE_HDR.lastIndex = 0
  return RE_BARE_HDR.test(text) // 大小写不敏感正则兜底（裸键名，无冒号）
}

// 净化单个文本：预检 → 改写层 → 剥离层 → 兜底 → TrimSpace
// 注意：只有命中指纹时才 TrimSpace，无指纹文本逐字原样返回
function sanitizeText(text) {
  if (typeof text !== 'string' || !text) return text
  if (!hasFingerprint(text)) return text

  let out = text
  for (const [find, replace] of SANITIZE_REWRITES) {
    out = out.split(find).join(replace)
  }
  RE_HDR.lastIndex = 0
  out = out.replace(RE_HDR, '')
  if (out.includes('cc_')) {
    let prev = ''
    while (prev !== out) {
      prev = out
      RE_KV.lastIndex = 0
      out = out.replace(RE_KV, '')
    }
  }
  RE_BARE_HDR.lastIndex = 0
  out = out.replace(RE_BARE_HDR, 'x-anthropic-billing-hdr')
  return out.trim()
}

// 净化 tool_calls[].function.arguments（字符串化 JSON，按纯文本处理）
function sanitizeToolCalls(list) {
  if (!Array.isArray(list)) return false
  let changed = false
  for (const call of list) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) continue
    const fn = call.function
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) continue
    if (typeof fn.arguments !== 'string') continue
    const next = sanitizeText(fn.arguments)
    if (next !== fn.arguments) {
      fn.arguments = next
      changed = true
    }
  }
  return changed
}

// 净化多模态 content 数组：只动 text part，image 等其他 part 原样
function sanitizeContentArray(parts) {
  let changed = false
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue
    if (typeof part.text !== 'string') continue
    const next = sanitizeText(part.text)
    if (next !== part.text) {
      part.text = next
      changed = true
    }
  }
  return changed
}

// 净化单条消息：content（string/数组）、reasoning_content、tool_calls 各自独立判断
// content 为 null 不影响 tool_calls 被净化
function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false
  let changed = false

  if (typeof msg.content === 'string') {
    const next = sanitizeText(msg.content)
    if (next !== msg.content) {
      msg.content = next
      changed = true
    }
  } else if (Array.isArray(msg.content)) {
    if (sanitizeContentArray(msg.content)) changed = true
  }

  if (typeof msg.reasoning_content === 'string') {
    const next = sanitizeText(msg.reasoning_content)
    if (next !== msg.reasoning_content) {
      msg.reasoning_content = next
      changed = true
    }
  }

  if (sanitizeToolCalls(msg.tool_calls)) changed = true

  return changed
}

// 净化 messages 数组，返回是否有改动
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const msg of messages) {
    if (sanitizeMessage(msg)) changed = true
  }
  return changed
}

module.exports = {
  hasFingerprint,
  sanitizeText,
  sanitizeMessages,
  sanitizeMessage,
  sanitizeToolCalls
}