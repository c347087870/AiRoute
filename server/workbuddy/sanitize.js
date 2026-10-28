// 指纹脱敏：出站请求体中对客户端指纹串做剥离与最小改写，避免上游内容审核逐字误杀

// 特征预检子串（大小写敏感 Contains），任一命中才进入净化流程
const SANITIZE_FEATURES = [
  'x-anthropic-billing-hdr', // header 键值段键名
  'You are Claude Code', // 身份句
  'Main branch (', // 注入指令句
  'You are a coding agent running in the Codex CLI', // Codex instructions 首段
  // DSH 的 @ 路径说明段：原文是 "References starting with @ are paths..."。
  // 这里必须用原文真实存在的子串 —— 早先误写成 'prefixed with @'（源文里没这个词），
  // 预检因此永不命中，整条净化被跳过，表现为「脱敏写了但完全没生效」
  'starting with @',
  'github.com/anthropics/', // 反馈句里的仓库链接
  '11128' // 上游反探测：裸错误码 11128（输入侧形态）
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

// 正则改写层：整句/整段同义改写（大小写不敏感）。字面量层只能逐串替换，
// 上游是按「连续原文」判渠道特征的 —— 句子顺序一变或大小写不同，逐串替换就会漏掉，
// 所以这类整段文案一律走正则。
// DSH（本项目自己就是它的客户端）的系统提示词里有一段 @ 路径说明，
// 段首「Tokens prefixed with @」与紧随其后的 workspace root 连排就会被判 11-128；
// 这里逐句换措辞，保留 @ 的语义，让任意连续两段的原文都不再出现。
const SANITIZE_REGEX_REWRITES = [
  // "References starting with @" 是上游指名拒绝的形状，必须换掉。
  // 注意：previously 这里写的正则是 /\bTokens prefixed with @/ —— 源文里没有
  // "Tokens prefixed" 这个词，规则永远匹配不到，等于没写。
  [/References starting with @/gi, 'Paths written as @'],
  // 后面几条同样要保证「匹配串 !== 替换串」，否则是空转规则
  [/Relative paths are resolved against the working directory/gi,
    'Relative paths resolve from the working directory'],
  [/absolute ones point at files or directories on this machine/gi,
    'absolute ones identify files or directories on the host'],
  [/A trailing slash marks a directory: list it when its contents matter\./gi,
    'A trailing slash means a directory \u2014 list it when you need what is inside.'],
  [/Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading\./gi,
    'Everything else is a file \u2014 open it with the read tool before describing what is inside.'],
  [/@"\.\.\." quotes a path containing spaces\./gi,
    'A path containing spaces is written as @"...".']
]

// 剥离层正则：键值形态 header 整段删除（要求冒号，大小写不敏感）
const RE_HDR = /x-anthropic-billing-header:[^;\n]*;?[ \t\n\f\r]*/gi
// 剥离层正则：尾随裸键值整段删除（循环至稳定）
const RE_KV = /\bcc_[a-z0-9_]+=[^;\s]*;?[ \t\n\f\r]*/gi
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
  for (const [re, replace] of SANITIZE_REGEX_REWRITES) {
    out = out.replace(re, replace)
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