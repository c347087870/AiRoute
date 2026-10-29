// Trae 出站请求的「形态清洗」
//
// 为什么需要：Trae 上游会对请求体做渠道/客户端特征识别 —— 系统提示词里如果逐字
// 带着别家 CLI 的身份句（Claude Code / Codex CLI / opencode…）、或者夹带客户端
// 抓包时留下的 `cc_xxx=` 键值、`x-anthropic-*` 头引用，整条请求会被判成
// 「非授权渠道调用」直接拦掉（错误码 11-128）。这类拦截**换号无效**，因为判的是
// 请求内容而不是账号。
//
// 这里做两件事，都不改变语义：
//   ① 把「别家 CLI 的身份声明」改写成中性句（我们本来也不是那个 CLI，
//      原样透传等于替客户端撒谎）；
//   ② 剥掉纯元数据形态的键值（cc_* / x-anthropic-*），它们对模型没有信息量。
//
// 另一层是工具名别名：上游还会按 tools[].name 集合识别 agent 客户端。
// 别名表默认空（不猜测哪些名字敏感），需要时在「渠道设置」里配 [原名, 别名]。
// 改名后响应侧必须逆映射回原名，否则客户端的工具分发表对不上。

// 特征预检：命中才进净化流程，没命中的文本逐字原样返回（零改动、零风险）
const FEATURES = [
  'You are Claude Code',
  'You are a coding agent running in the Codex CLI',
  'You are an interactive CLI agent',
  'You are opencode',
  'Main branch (',
  'x-anthropic-',
  'cc_'
]

// 逐串改写：只改身份声明与固定文案，不动用户内容
const REWRITES = [
  [
    "You are Claude Code, Anthropic's official CLI tool for Claude",
    'You are a coding assistant.'
  ],
  [
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.',
    'You are a coding agent working in a terminal.'
  ],
  [
    'You are an interactive CLI agent specializing in software engineering tasks.',
    'You are a software engineering assistant.'
  ],
  [
    'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
    'You are a software engineering assistant.'
  ],
  [
    'Main branch (you will usually use this for PRs)',
    'Default branch (you will usually use this for PRs)'
  ],
  [
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    'To provide feedback, report the issue to the maintainers.'
  ]
]

// 键值剥离：cc_xxx=...; 与 x-anthropic-xxx: ...（只在正文里出现时处理）
const RE_CC_KV = /\bcc_[a-z0-9_]+=[^;\s]*;?[ \t]*/gi
const RE_ANTHROPIC_REF = /x-anthropic-[a-z0-9-]+(\s*:\s*[^\n]*)?/gi

function hasFingerprint(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return FEATURES.some(feature => text.includes(feature))
}

function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!hasFingerprint(text)) return text
  let out = text
  for (const [from, to] of REWRITES) out = out.split(from).join(to)
  out = out.replace(RE_CC_KV, '')
  out = out.replace(RE_ANTHROPIC_REF, '')
  return out
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false
  let changed = false
  if (typeof message.content === 'string') {
    const next = sanitizeText(message.content)
    if (next !== message.content) { message.content = next; changed = true }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') continue
      const next = sanitizeText(part.text)
      if (next !== part.text) { part.text = next; changed = true }
    }
  }
  if (typeof message.reasoning_content === 'string') {
    const next = sanitizeText(message.reasoning_content)
    if (next !== message.reasoning_content) { message.reasoning_content = next; changed = true }
  }
  // 历史工具调用的 arguments 是字符串化 JSON，按纯文本过一遍
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const args = call?.function?.arguments ?? call?.function_call?.arguments
      if (typeof args !== 'string') continue
      const next = sanitizeText(args)
      if (next === args) continue
      if (call.function) call.function.arguments = next
      else call.function_call.arguments = next
      changed = true
    }
  }
  return changed
}

// 只清洗 messages（工具描述里的身份句由 applyToolAliases 之外的调用点单独处理）
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const message of messages) if (sanitizeMessage(message)) changed = true
  return changed
}

// 工具描述里也可能夹带身份句（有些客户端把整段 README 塞进 description）
function sanitizeTools(tools) {
  if (!Array.isArray(tools)) return false
  let changed = false
  for (const tool of tools) {
    const fn = tool?.function
    if (!fn || typeof fn.description !== 'string') continue
    const next = sanitizeText(fn.description)
    if (next !== fn.description) { fn.description = next; changed = true }
  }
  return changed
}

// ── 工具名别名 ──

// rules 支持 [['原名','别名'], ...] 或 { 原名: 别名 }；返回 Map(原名 → 别名)
function normalizeRules(rules) {
  const map = new Map()
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (!Array.isArray(rule) || rule.length < 2) continue
      const from = String(rule[0] || '').trim()
      const to = String(rule[1] || '').trim()
      if (from && to && from !== to) map.set(from, to)
    }
  } else if (rules && typeof rules === 'object') {
    for (const [from, to] of Object.entries(rules)) {
      const name = String(from || '').trim()
      const alias = String(to || '').trim()
      if (name && alias && name !== alias) map.set(name, alias)
    }
  }
  return map
}

// 请求侧改名：tools[].function.name / tool_choice / 历史 tool_calls
// 返回 reverse（别名 → 原名），响应侧据此回改
function applyToolAliases(body, rules) {
  const map = normalizeRules(rules)
  const reverse = new Map()
  if (map.size === 0 || !body || typeof body !== 'object') return { reverse, changed: false }
  let changed = false
  const rename = name => {
    const alias = map.get(name)
    if (!alias) return name
    if (!reverse.has(alias)) reverse.set(alias, name)
    return alias
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const fn = tool?.function
      if (!fn || typeof fn.name !== 'string') continue
      const alias = rename(fn.name)
      if (alias !== fn.name) { fn.name = alias; changed = true }
    }
  }

  if (typeof body.tool_choice === 'string' && map.has(body.tool_choice)) {
    body.tool_choice = rename(body.tool_choice)
    changed = true
  } else if (body.tool_choice?.function?.name && map.has(body.tool_choice.function.name)) {
    body.tool_choice.function.name = rename(body.tool_choice.function.name)
    changed = true
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!Array.isArray(message?.tool_calls)) continue
      for (const call of message.tool_calls) {
        const fn = call?.function ?? call?.function_call
        if (!fn || typeof fn.name !== 'string') continue
        const alias = rename(fn.name)
        if (alias !== fn.name) { fn.name = alias; changed = true }
      }
    }
  }

  return { reverse, changed }
}

// 响应侧回改：把别名换回原名。reverse 为空时原样返回（零成本）
function restoreToolName(name, reverse) {
  if (!reverse || reverse.size === 0) return name
  return reverse.get(name) || name
}

module.exports = {
  hasFingerprint,
  sanitizeText,
  sanitizeMessage,
  sanitizeMessages,
  sanitizeTools,
  applyToolAliases,
  restoreToolName,
  normalizeRules
}
