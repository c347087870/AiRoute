// 聊天请求体改写管线：出站前把客户端 body 改写为上游可接受的形态
// 步骤顺序固定（S1..S14），不可调整

const crypto = require('crypto')
const C = require('./constants')
const sanitize = require('./sanitize')

// 档位序：off < minimal < low < medium < high < xhigh < max
const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

// 完整管线：S1..S14
// opts: {
//   sanitize: bool,                                   // 指纹脱敏开关
//   efforts: {model: [档位]},                         // 各模型支持的档位（降级用）
//   defaultEfforts: {model: 默认档},                  // 各模型默认档（补档用）
//   contextWindow: number,                            // 模型上下文窗口（压缩判据；0/缺省不压缩）
//   maxOutput: number,                                // 模型输出上限（max_tokens 兜底注入；0/缺省不注入）
//   compressRatio: number,                            // 压缩阈值比例（默认 0.8；上游报超长后改用 0.5）
//   compress: bool,                                   // 是否启用上下文压缩（默认启用）
//   rewriteMode: 'compat' | 'native'                  // 改写档位（默认 compat 全量修补；native 只保留上游硬性步骤）
// }
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
  // S3b 输出上限兜底：客户端未指定时按模型配置注入，避免上游把输出预算压得过低，
  // 思考模型会因此把预算全花在 reasoning 上、最终回答为空（finish_reason=length）
  if (obj.max_tokens === undefined || obj.max_tokens === null) {
    const limit = Number(opts.maxOutput) || 0
    if (limit > 0) obj.max_tokens = limit
  }
  // S4 stream_options 默认补 include_usage
  if (!Object.prototype.hasOwnProperty.call(obj, 'stream_options')) {
    obj.stream_options = { include_usage: true }
  }
  // 改写档位：compat=默认全量修补；native=原生透传（跳过工具参数/工具历史/消息内容的主动修补，
  // 只保留上游硬性要求与结构映射），供工具调用被改写导致异常时保真直通
  const native = opts.rewriteMode === 'native'
  // S5..S8 各类归一化（native 跳过工具类修补：tool_choice 归一、schema 修正）
  if (!native) {
    normalizeToolChoice(obj)
    normalizeToolPatterns(obj)
  }
  // 角色与图片结构映射属上游硬性要求，两种档位都保留
  normalizeRoles(obj)
  normalizeImageURL(obj)
  // S9 上下文压缩（native 不压缩）
  if (!native) {
    // S9 上下文压缩（先于配对清理：裁掉最旧整轮后，再统一清理孤儿 tool_call）
    const compressed = compressContext(obj, opts)
    if (compressed) obj.messages = compressed
  }
  // S9 工具配对三步（各档位统一执行：属"让请求合法"的必要归一而非语义改写；不修会被上游以 11148/503 拒绝）
  if (Array.isArray(obj.messages)) {
    obj.messages = mergeAdjacentToolCalls(obj.messages)
    obj.messages = repackToolResultBlocks(obj.messages)
    obj.messages = cleanupOrphanToolCalls(obj.messages)
  }
  // S10 DeepSeek 思维链注入（先于档位降级：补入的默认档也要走降级；native 不注入）
  const modelName = typeof obj.model === 'string' ? obj.model : ''
  if (!native) injectThinking(obj, lookupDefaultEffort(opts.defaultEfforts, modelName))
  // S11 档位降级（上游对不支持的档位会 400，两种档位都保留）
  normalizeReasoningEffort(obj, opts.efforts)
  // S12 reasoning_content 多轮回填（native 跳过）
  if (!native) backfillReasoningContent(obj)
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

// S9：上下文压缩
// 触发条件：估算 token 超过模型上下文窗口 × ratio（默认 0.8）；窗口未知（0）时不裁剪。
// 裁剪单位是「轮」而不是「条」：一条 user 开启新的一轮，其后的 assistant / tool 结果
// 全部归入同一轮。按条裁会把工具调用与其结果拆散，配对清理随后把两侧都删掉，反而丢更多。
// system 消息独立成组且永不裁剪（它是指令）；最新一轮同样永不裁剪（那是本次提问，
// 裁掉等于请求语义丢失）。返回裁剪后的 messages；未触发裁剪时返回 null（保留原数组）
function compressContext(obj, opts) {
  if (opts.compress === false) return null
  const window = Number(opts.contextWindow) || 0
  if (!(window > 0)) return null
  const messages = obj.messages
  if (!Array.isArray(messages) || messages.length === 0) return null

  const ratio = clampRatio(opts.compressRatio)
  const budget = Math.floor(window * ratio)
  const groups = groupTurns(messages)
  let kept = groups.length
  let tokens = estimateTokens(messages)

  // 从最旧的「非保护组」开始整组丢弃，直到估算值落进预算（至少留 minKeepTurns 组）
  for (let i = 0; i < groups.length && tokens > budget; i++) {
    const g = groups[i]
    if (g.protected || kept <= C.CONTEXT_COMPRESS.minKeepTurns) continue
    tokens -= g.tokens
    g.dropped = true
    kept--
  }
  if (!groups.some(g => g.dropped)) return null

  const out = []
  for (const g of groups) {
    if (!g.dropped) out.push(...g.items)
  }
  return out
}

// 压缩比例合法性钳制（非法/越界一律回落默认值）
function clampRatio(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return C.CONTEXT_COMPRESS.ratio
  return n
}

// 把 messages 切成「轮」：每条 user 与其后到下一轮之前的全部消息同属一组；
// 开头连续的 system/developer 归为受保护的独立组（永不裁剪）
function groupTurns(messages) {
  const groups = []
  let current = null
  for (const m of messages) {
    const role = m && typeof m === 'object' && !Array.isArray(m) ? String(m.role || '') : ''
    const isSystem = role === 'system' || role === 'developer'
    if (isSystem) {
      // system 独立成组（受保护）；轮进行中出现的 system 也单独成组
      current = { items: [m], tokens: tokenCountOf(m.content), protected: true, dropped: false }
      groups.push(current)
      continue
    }
    if (role === 'user' || !current) {
      // user 开启新的一轮
      current = { items: [m], tokens: tokenCountOf(m.content), protected: false, dropped: false }
      // 消息里的 tool_calls 与 reasoning 也要计入（它们同样占用上游上下文）
      current.tokens += tokenCountOf(m.tool_calls)
      groups.push(current)
      continue
    }
    current.items.push(m)
    current.tokens += tokenCountOf(m.content) + tokenCountOf(m.tool_calls)
  }
  return groups
}

// 估算 token 总量（整条 messages 的近似值）
function estimateTokens(messages) {
  let sum = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    sum += tokenCountOf(m.content) + tokenCountOf(m.tool_calls)
  }
  return sum
}

// 单段内容估算：字符串按字节数折算，图片按固定值计，数组逐块累加
function tokenCountOf(content) {
  if (typeof content === 'string') {
    return Math.ceil(Buffer.byteLength(content, 'utf8') / C.CONTEXT_COMPRESS.bytesPerToken)
  }
  if (Array.isArray(content)) {
    let sum = 0
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      // 图片/base64 块按固定值计，避免数 MB 的 base64 被按字节换算成天量 token
      if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
        sum += C.CONTEXT_COMPRESS.imageTokens
        continue
      }
      if (typeof part.text === 'string') sum += tokenCountOf(part.text)
      else sum += tokenCountOf(part.content)
    }
    return sum
  }
  if (content && typeof content === 'object') {
    let s = ''
    try {
      s = JSON.stringify(content)
    } catch {
      s = ''
    }
    return tokenCountOf(s)
  }
  return 0
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

// S9 工具配对第 0 步：合并背靠背相邻的同批 assistant 工具声明（须先于 repack 与 cleanup）
// 形态一：本条 assistant 仅有非空 tool_calls 无正文 → 声明顺序拼接进上一条同型 assistant
// 形态二：本条 assistant 是纯文本（连 tool_calls 键都没有）→ 折进上一条无正文的 calls assistant
// 意义：deepseek 系对"拆成两条 assistant 的 tool_calls"直接 503/11148，合并成一条才通过；中间隔着消息说明不是同一批声明，一律不合并而交 repack 处理
function mergeAdjacentToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages
  const out = []
  let changed = false

  for (const msg of messages) {
    if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.role === 'assistant' && out.length > 0) {
      const prev = out[out.length - 1]
      const prevOk =
        prev &&
        typeof prev === 'object' &&
        !Array.isArray(prev) &&
        prev.role === 'assistant' &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls.length > 0
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null

      // 形态一：只有工具声明没有正文 → 并入上一条（顺序拼接，不去重，重复 id 交 cleanup 兜底）
      if (prevOk && calls && calls.length > 0 && isEmptyContent(msg.content)) {
        prev.tool_calls = prev.tool_calls.concat(calls)
        mergeReasoningContent(prev, msg)
        changed = true
        continue
      }

      // 形态二：纯文本折进上一条（prev 自身无正文时才无损）
      if (prevOk && !('tool_calls' in msg) && typeof msg.content === 'string' && msg.content !== '' && isEmptyContent(prev.content)) {
        prev.content = msg.content
        mergeReasoningContent(prev, msg)
        changed = true
        continue
      }
    }
    out.push(msg)
  }

  return changed ? out : messages
}

// 判空口径：null/undefined、空串、长度 0 的数组都算空；非空数组（多模态）视为有内容，宁可不合并也不丢内容
function isEmptyContent(v) {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

// 合并思维链：src 无 reasoning_content 则不动；dst 已有非空值则换行拼接，否则直接赋值（不丢思维链）
function mergeReasoningContent(dst, src) {
  const rc = typeof src.reasoning_content === 'string' ? src.reasoning_content : ''
  if (!rc) return
  const cur = typeof dst.reasoning_content === 'string' ? dst.reasoning_content : ''
  dst.reasoning_content = cur ? `${cur}\n${rc}` : rc
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