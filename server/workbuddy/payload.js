// 聊天请求体改写管线：出站前把客户端 body 改写为上游可接受的形态
// 翻译自参考项目 internal/upstream/payload.go / thinking.go / cache_key.go / tool_pairing.go
// 步骤顺序严格与参考实现一致（S1..S14），不可调整

const crypto = require('crypto')
const sanitize = require('./sanitize')

// 档位序：off < minimal < low < medium < high < xhigh < max
const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

// 完整管线：S1..S14
// opts: { sanitize: bool, efforts: {model: [档位]}, defaultEfforts: {model: 默认档} }
function prepareBody(src, opts = {}) {
  if (!src) return src
  let obj
  try {
    obj = JSON.parse(src)
  } catch {
    return src // 坏 body 原样返回，不做二次错误化
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return src

  // S2 强制流式（上游拒绝非流式）
  obj.stream = true
  // S3 max_completion_tokens 别名翻译
  translateMaxCompletionTokens(obj)
  // S4 stream_options 默认补 include_usage
  if (!Object.prototype.hasOwnProperty.call(obj, 'stream_options')) {
    obj.stream_options = { include_usage: true }
  }
  // S5..S8 各类归一化
  normalizeToolChoice(obj)
  normalizeToolPatterns(obj)
  normalizeRoles(obj)
  normalizeImageURL(obj)
  // S9 tool 配对两步：先重排再清理孤儿
  if (Array.isArray(obj.messages)) {
    obj.messages = repackToolResultBlocks(obj.messages)
    obj.messages = cleanupOrphanToolCalls(obj.messages)
  }
  // S10 DeepSeek 思维链注入（先于档位降级：补入的默认档也要走降级）
  const modelName = typeof obj.model === 'string' ? obj.model : ''
  injectThinking(obj, lookupDefaultEffort(opts.defaultEfforts, modelName))
  // S11 档位降级
  normalizeReasoningEffort(obj, opts.efforts)
  // S12 reasoning_content 多轮回填
  backfillReasoningContent(obj)
  // S13 指纹脱敏（仅开关开启时）
  if (opts.sanitize) {
    if (Array.isArray(obj.messages)) sanitize.sanitizeMessages(obj.messages)
  }
  // S14 序列化
  try {
    return JSON.stringify(obj)
  } catch {
    return src
  }
}

// S3：把 max_completion_tokens 翻译为 max_tokens（别名一律删除；显式 max_tokens 优先）
function translateMaxCompletionTokens(obj) {
  const has = Object.prototype.hasOwnProperty.call(obj, 'max_completion_tokens')
  const alias = obj.max_completion_tokens
  delete obj.max_completion_tokens
  if (!has) return
  if (Object.prototype.hasOwnProperty.call(obj, 'max_tokens')) return // 显式优先，别名只删
  if (typeof alias === 'number' && Number.isFinite(alias) && alias > 0 && Number.isInteger(alias)) {
    obj.max_tokens = alias
  }
}

// S5：tool_choice 归一（上游该字段是 string，对象形式会 400 code=11101）
function normalizeToolChoice(obj) {
  if (!Object.prototype.hasOwnProperty.call(obj, 'tool_choice')) return
  const tc = obj.tool_choice

  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      // none 语义：连 tools/functions 一起删
      delete obj.tool_choice
      delete obj.tools
      delete obj.functions
    }
    return
  }

  if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const type = String(tc.type || '')
      .trim()
      .toLowerCase()
    if (type === 'none') {
      delete obj.tool_choice
      delete obj.tools
      delete obj.functions
      return
    }
    if (type === 'auto' || type === 'required') {
      obj.tool_choice = type
      return
    }
    if (type === 'function') {
      const fn = tc.function && typeof tc.function === 'object' ? tc.function : {}
      const name = String(fn.name || tc.name || '').trim()
      obj.tool_choice = name || 'auto'
      return
    }
    delete obj.tool_choice // 其他 type
    return
  }

  delete obj.tool_choice // 非标量
}

// S6：tools schema 里的 pattern / patternProperties 键中 `\_` → `_`（上游对 `\_` 严格拒收，400 code=11129）
function normalizeToolPatterns(obj) {
  if (!Array.isArray(obj.tools)) return
  for (const tool of obj.tools) {
    if (!tool || typeof tool !== 'object') continue
    const params = tool.function && typeof tool.function === 'object' ? tool.function.parameters : tool.parameters
    if (params && typeof params === 'object') fixPatterns(params)
  }
}

// 递归修正 schema 中的转义下划线
function fixPatterns(node) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) fixPatterns(item)
    return
  }
  if (typeof node.pattern === 'string' && node.pattern.includes('\\_')) {
    node.pattern = node.pattern.split('\\_').join('_')
  }
  if (node.patternProperties && typeof node.patternProperties === 'object' && !Array.isArray(node.patternProperties)) {
    const keys = Object.keys(node.patternProperties)
    if (keys.some(k => k.includes('\\_'))) {
      const rebuilt = {}
      for (const k of keys) {
        rebuilt[k.split('\\_').join('_')] = node.patternProperties[k]
      }
      node.patternProperties = rebuilt
    }
  }
  for (const key of Object.keys(node)) {
    const v = node[key]
    if (v && typeof v === 'object') fixPatterns(v)
  }
}

// S7：role developer → system（其余 role 原样，不合并/重排/删除）
function normalizeRoles(obj) {
  if (!Array.isArray(obj.messages)) return
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    if (typeof m.role === 'string' && m.role.trim().toLowerCase() === 'developer') {
      m.role = 'system'
    }
  }
}

// S8：image_url 字符串形态兼容为对象形态（上游只认 {"url": ...}）
function normalizeImageURL(obj) {
  if (!Array.isArray(obj.messages)) return
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue
      if (part.type !== 'image_url') continue
      if (typeof part.image_url === 'string' && part.image_url) {
        part.image_url = { url: part.image_url }
      }
    }
  }
}

// S9a：把插在 assistant.tool_calls 与其 tool 结果之间的非 tool 消息挪到整组之后
// 目的：保证同批 tool 结果连续（防上游 11148 tool_call_sequence_broken）
function repackToolResultBlocks(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const out = []
  let i = 0
  let changed = false

  while (i < messages.length) {
    const msg = messages[i]
    const isGroupHead =
      msg && typeof msg === 'object' && !Array.isArray(msg) && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0

    if (!isGroupHead) {
      out.push(msg)
      i++
      continue
    }

    // 收集本批 tool_call id 集合
    const ids = new Set()
    for (const call of msg.tool_calls) {
      if (call && typeof call === 'object' && call.id) ids.add(call.id)
    }

    out.push(msg)
    i++

    const results = []
    const strays = []
    let broke = false
    while (i < messages.length) {
      const next = messages[i]
      if (!next || typeof next !== 'object' || Array.isArray(next)) break
      if (next.role === 'assistant' && Array.isArray(next.tool_calls) && next.tool_calls.length > 0) break // 下一组交还外层
      if (next.role === 'tool' && ids.has(next.tool_call_id)) {
        results.push(next)
        i++
        continue
      }
      if (results.length === 0) break // 尚无结果即遇非结果 → 交 cleanup 处理
      strays.push(next) // 结果之间的杂音消息：挪后
      i++
      broke = true
    }

    if (results.length === 0) continue
    out.push(...results)
    if (broke) changed = true
    out.push(...strays)
  }

  return changed ? out : messages
}

// S9b：剔除无法配对的 tool_call 与 tool 结果（对称裁剪）
function cleanupOrphanToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages

  const resultIds = new Set()
  const callIds = new Set()
  let hasToolTraffic = false
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    if (m.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id) {
      resultIds.add(m.tool_call_id)
      hasToolTraffic = true
    }
    if (Array.isArray(m.tool_calls)) {
      hasToolTraffic = true
      for (const call of m.tool_calls) {
        if (call && typeof call === 'object' && call.id) callIds.add(call.id)
      }
    }
  }
  if (!hasToolTraffic) return messages

  const keep = new Set()
  for (const id of callIds) {
    if (resultIds.has(id)) keep.add(id)
  }

  const out = []
  let changed = false
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      out.push(m)
      continue
    }
    if (m.role === 'tool') {
      if (typeof m.tool_call_id === 'string' && m.tool_call_id && !keep.has(m.tool_call_id)) {
        changed = true // 孤儿结果：整条删除
        continue
      }
      out.push(m)
      continue
    }
    if (Array.isArray(m.tool_calls)) {
      const filtered = m.tool_calls.filter(c => c && typeof c === 'object' && c.id && keep.has(c.id))
      if (filtered.length !== m.tool_calls.length) {
        changed = true
        if (filtered.length === 0) delete m.tool_calls
        else m.tool_calls = filtered
      }
    }
    out.push(m)
  }

  return changed ? out : messages
}

// 是否 DeepSeek 模型（思维链注入的触发条件）
function isDeepSeekModel(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith('deepseek')
}

// S10：DeepSeek 思维链注入
function injectThinking(obj, defaultEffort) {
  const model = typeof obj.model === 'string' ? obj.model : ''
  if (!isDeepSeekModel(model)) return

  const th = obj.thinking && typeof obj.thinking === 'object' && !Array.isArray(obj.thinking) ? obj.thinking : null
  const type = th && typeof th.type === 'string' ? th.type.trim() : ''

  if (type) {
    if (type.toLowerCase() === 'disabled') {
      // 显式关闭：删除档位字段
      delete obj.reasoning_effort
      delete obj.reasoningEffort
      return
    }
    ensureDeepSeekEffort(obj, defaultEffort)
    return
  }

  if (!th) obj.thinking = { type: 'enabled' }
  else th.type = 'enabled'
  ensureDeepSeekEffort(obj, defaultEffort)
}

// 缺档时补默认档（已有任一档位字段则不覆盖）
function ensureDeepSeekEffort(obj, defaultEffort) {
  if (typeof obj.reasoning_effort !== 'undefined' || typeof obj.reasoningEffort !== 'undefined') return
  obj.reasoning_effort = defaultEffort || 'high' // 硬编码兜底
}

// 查模型的默认档（来自模型目录缓存）
function lookupDefaultEffort(defaultEfforts, model) {
  if (!defaultEfforts || !model) return ''
  const v = defaultEfforts[model]
  return typeof v === 'string' ? v : ''
}

// S11：按模型支持的档位集合降级请求档位
function normalizeReasoningEffort(obj, efforts) {
  if (!efforts || Object.keys(efforts).length === 0) return
  const model = typeof obj.model === 'string' ? obj.model : ''
  if (!model) return
  const supported = efforts[model]
  if (!Array.isArray(supported) || supported.length === 0) return

  const key = typeof obj.reasoning_effort !== 'undefined' ? 'reasoning_effort' : typeof obj.reasoningEffort !== 'undefined' ? 'reasoningEffort' : ''
  if (!key) return
  const reqRaw = obj[key]
  if (typeof reqRaw !== 'string') return

  const reqStr = reqRaw.trim().toLowerCase()
  const reqIdx = EFFORT_RANK[reqStr]
  if (typeof reqIdx === 'undefined') return // 未知档 → 透传

  const ranked = supported
    .map(s => ({ name: s, idx: EFFORT_RANK[String(s).trim().toLowerCase()] }))
    .filter(x => typeof x.idx !== 'undefined')
  if (ranked.length === 0) return

  // 取 ≤ 请求档的最高支持档
  let best = null
  for (const x of ranked) {
    if (x.idx <= reqIdx && (best === null || x.idx > best.idx)) best = x
  }
  if (best) {
    if (best.name.trim().toLowerCase() !== reqStr) obj[key] = best.name
    return
  }
  // 支持档全部高于请求档 → 取最低支持档
  let lowest = ranked[0]
  for (const x of ranked) {
    if (x.idx < lowest.idx) lowest = x
  }
  obj[key] = lowest.name
}

// S12：DeepSeek assistant 消息 reasoning_content 回填（多轮一致性）
function backfillReasoningContent(obj) {
  const model = typeof obj.model === 'string' ? obj.model : ''
  if (!isDeepSeekModel(model)) return
  if (!Array.isArray(obj.messages)) return

  const th = obj.thinking && typeof obj.thinking === 'object' ? obj.thinking : null
  const thinkingEnabled = th && typeof th.type === 'string' && th.type.trim().toLowerCase() === 'enabled'

  let hasTrace = false
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    if (typeof m.reasoning === 'string' && m.reasoning) {
      hasTrace = true
      break
    }
    if (Object.prototype.hasOwnProperty.call(m, 'reasoning_content')) {
      hasTrace = true
      break
    }
  }
  if (!thinkingEnabled && !hasTrace) return

  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    if (m.role !== 'assistant') continue

    let rc = ''
    if (typeof m.reasoning_content === 'string') {
      rc = m.reasoning_content // 已是 string（含空串）→ 不覆盖
    } else if (typeof m.reasoning === 'string' && m.reasoning) {
      rc = m.reasoning
      m.reasoning_content = rc
    } else {
      rc = ''
      m.reasoning_content = ''
    }

    if (typeof m.reasoning === 'string' && m.reasoning) continue
    m.reasoning = rc !== '' ? rc : ' ' // 上游按 len>0 不 trim 校验，空则补单空格
  }
}

// 覆盖请求体的 model 字段（客户端可不指定模型，由网关按界面当前选中注入）
// 必须在 prepareBody 之前调用：管线中的思维链注入依赖 obj.model 判断是否 deepseek
function setBodyModel(body, model) {
  if (!body || !model) return body
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return body
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body
  if (obj.model === model) return body
  obj.model = model
  try {
    return JSON.stringify(obj)
  } catch {
    return body
  }
}

// 按配置注入推理档位（在 prepareBody 之前调用，使注入值仍走后续降级管线）
// effort 为空 → 原样返回（保留客户端原值/默认档）；'off' → 删除档位字段
function setBodyEffort(body, effort) {
  if (!body || !effort) return body
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return body
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body

  if (effort === 'off') {
    delete obj.reasoning_effort
    delete obj.reasoningEffort
  } else {
    obj.reasoning_effort = effort
    delete obj.reasoningEffort // 上游只认 snake_case，避免重复字段
  }
  try {
    return JSON.stringify(obj)
  } catch {
    return body
  }
}

// prompt_cache_key 注入（在整条管线之后）
function injectPromptCacheKey(body, uid, conversationID) {
  if (!body) return body
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return body
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return body

  if (typeof obj.prompt_cache_key === 'string' && obj.prompt_cache_key) return body // 已有非空则不覆盖

  let conversation = ''
  if (typeof obj.conversation_id === 'string' && obj.conversation_id) conversation = obj.conversation_id
  else if (typeof obj.conversationId === 'string' && obj.conversationId) conversation = obj.conversationId
  else if (conversationID) conversation = conversationID

  const uid8 = uid ? uid.slice(0, 8) : '-'
  const convHex = crypto
    .createHash('sha256')
    .update(`${uid}|${conversation}`)
    .digest('hex')
    .slice(0, 32)
  obj.prompt_cache_key = `wb2a-${uid8}-${convHex}`

  try {
    return JSON.stringify(obj)
  } catch {
    return body
  }
}

module.exports = {
  prepareBody,
  setBodyModel,
  setBodyEffort,
  injectPromptCacheKey,
  normalizeReasoningEffort,
  isDeepSeekModel,
  EFFORT_RANK
}