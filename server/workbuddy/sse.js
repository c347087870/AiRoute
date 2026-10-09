// SSE 帧重建与非流式聚合
// 翻译自参考项目 internal/upstream/sse.go / truncation.go / usage.go

// 顶层白名单字段（存在且非 null 才保留）
const FRAME_TOP_FIELDS = ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']

// usage 缓存别名候选序列（取第一个 > 0 的值作为 best）
function normalizeUsageCacheAliases(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return usage

  const candidates = [
    usage.prompt_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
    usage.input_tokens_details?.cached_tokens
  ]
  let best = 0
  for (const v of candidates) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) {
      best = n
      break
    }
  }
  if (best <= 0) return usage

  const out = { ...usage }
  out.cache_read_input_tokens = best
  out.cached_tokens = best
  out.prompt_cache_hit_tokens = best
  out.prompt_tokens_details = { ...(out.prompt_tokens_details || {}), cached_tokens: best }
  if (out.input_tokens_details && typeof out.input_tokens_details === 'object') {
    out.input_tokens_details = { ...out.input_tokens_details, cached_tokens: best }
  }
  return out
}

// 补 total_tokens（缺失且 prompt/completion 均为数字时）
function ensureUsageTotal(usage) {
  if (!usage || typeof usage !== 'object') return usage
  if (typeof usage.total_tokens !== 'undefined') return usage
  const pt = usage.prompt_tokens
  const ct = usage.completion_tokens
  if (typeof pt === 'number' && typeof ct === 'number') {
    return { ...usage, total_tokens: pt + ct }
  }
  return usage
}

// arguments 是否被截断：空串（合法无参）→ false；非空但 JSON 解析失败 → true
function isTruncatedArguments(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return false
  try {
    JSON.parse(s)
    return false
  } catch {
    return true
  }
}

// 丢弃 arguments 残缺的 tool_call
function dropTruncatedToolCalls(calls) {
  if (!Array.isArray(calls)) return calls
  return calls.filter(c => {
    const args = c?.function?.arguments
    return !isTruncatedArguments(args)
  })
}

// 逐帧重建器：收敛 tool_calls 的 name、首帧 id 续传、白名单剔除噪声
function createFrameRebuilder() {
  const toolCallSeen = {} // index → 是否已输出过 name
  let firstID = ''
  return { push, reset }

  // 处理一帧 payload 文本，返回重建后的 payload（error 帧原样返回）
  function push(payload) {
    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      return { payload, valid: false }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { payload, valid: false }

    if (Object.prototype.hasOwnProperty.call(obj, 'error')) {
      return { payload, valid: true } // error 帧绕过白名单原样透传
    }

    stripToolCallNames(obj)

    // 首帧 id 续传：后续帧缺 id 用缓存值
    if (typeof obj.id === 'string' && obj.id) {
      if (!firstID) firstID = obj.id
    } else if (firstID) {
      obj.id = firstID
    }

    const normalized = normalizeFrame(obj)
    return { payload: JSON.stringify(normalized), valid: true }
  }

  // 每 index 只保留一次 function.name（累加型客户端不会把 name 拼成多份）
  function stripToolCallNames(obj) {
    if (!Array.isArray(obj.choices)) return
    for (const choice of obj.choices) {
      const calls = choice?.delta?.tool_calls
      if (!Array.isArray(calls)) continue
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue
        const idx = typeof call.index === 'number' ? call.index : 0
        const fn = call.function
        if (!fn || typeof fn !== 'object') continue
        if (!toolCallSeen[idx]) {
          toolCallSeen[idx] = true
        } else {
          delete fn.name
        }
      }
    }
  }

  // 清空内部状态（每次请求独立使用一个重建器）
  function reset() {
    for (const k of Object.keys(toolCallSeen)) delete toolCallSeen[k]
    firstID = ''
  }
}

// 白名单重建单帧
function normalizeFrame(obj) {
  const out = {}

  for (const field of FRAME_TOP_FIELDS) {
    const v = obj[field]
    if (typeof v !== 'undefined' && v !== null) out[field] = v
  }
  if (typeof out.object === 'undefined') out.object = 'chat.completion.chunk'
  if (typeof out.id === 'undefined') out.id = 'chatcmpl-wb2api'

  out.choices = []
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!choice || typeof choice !== 'object') continue
      const rebuilt = {}
      if (typeof choice.index !== 'undefined') rebuilt.index = choice.index

      const delta = {}
      const d = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
      if (typeof d.role === 'string' && d.role) delta.role = d.role
      if (typeof d.content === 'string' && d.content) delta.content = d.content
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) delta.reasoning_content = d.reasoning_content
      if (typeof d.refusal === 'string' && d.refusal) delta.refusal = d.refusal
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) delta.tool_calls = d.tool_calls
      if (d.function_call && typeof d.function_call === 'object') {
        const name = d.function_call.name
        const args = d.function_call.arguments
        const nameEmpty = !name || (typeof name === 'string' && !name.trim())
        const argsEmpty = !args || (typeof args === 'string' && !args.trim())
        if (!(nameEmpty && argsEmpty)) delta.function_call = d.function_call
      }
      rebuilt.delta = delta

      rebuilt.finish_reason = typeof choice.finish_reason === 'string' && choice.finish_reason ? choice.finish_reason : null
      out.choices.push(rebuilt)
    }
  }

  if (!Object.prototype.hasOwnProperty.call(obj, 'usage')) {
    out.usage = null
  } else if (obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage)) {
    out.usage = normalizeUsageCacheAliases(obj.usage)
  } else {
    out.usage = obj.usage
  }

  return out
}

// 空流错误标记（便于上层判定）
function emptyStreamError() {
  const err = new Error('upstream stream contained no valid data events')
  err.isEmptyStream = true
  return err
}

// 非流式聚合：把完整 SSE 文本聚合为单个 chat.completion 响应
function aggregateSSE(text) {
  const state = {
    id: '',
    model: '',
    created: 0,
    finishReason: 'stop',
    usage: null,
    content: '',
    reasoning: '',
    gotAnyContent: false,
    validEvents: 0,
    sawDone: false,
    toolCalls: new Map(),
    toolOrder: [],
    toolSeq: 0,
    idIndex: new Map()
  }

  const lines = String(text || '').split('\n')
  for (const line of lines) {
    const trimmed = line.replace(/\r+$/, '')
    if (!trimmed.startsWith('data: ')) continue
    const payload = trimmed.slice(6).trim()
    if (payload === '[DONE]') {
      state.sawDone = true
      break
    }
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      continue
    }
    if (!chunk || typeof chunk !== 'object') continue
    state.validEvents++

    if (!state.id && typeof chunk.id === 'string' && chunk.id) state.id = chunk.id
    if (!state.model && typeof chunk.model === 'string' && chunk.model) state.model = chunk.model
    if (!state.created && typeof chunk.created === 'number') state.created = chunk.created
    if (chunk.usage) state.usage = chunk.usage

    if (!Array.isArray(chunk.choices)) continue
    for (const choice of chunk.choices) {
      if (!choice || typeof choice !== 'object') continue
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) state.finishReason = choice.finish_reason

      const delta = choice.delta
      if (delta && typeof delta === 'object') {
        if (typeof delta.content === 'string' && delta.content) {
          state.content += delta.content
          state.gotAnyContent = true
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          state.reasoning += delta.reasoning_content
        }
        if (Array.isArray(delta.tool_calls)) mergeToolCallsChunk(state, delta.tool_calls)
      }

      const message = choice.message
      if (message && typeof message === 'object' && !state.gotAnyContent) {
        if (typeof message.content === 'string' && message.content) {
          state.content += message.content
          state.gotAnyContent = true
        }
        if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
          state.reasoning += message.reasoning_content
        }
        if (Array.isArray(message.tool_calls)) mergeToolCallsChunk(state, message.tool_calls)
      }
    }
  }

  if (state.validEvents === 0) throw emptyStreamError()

  const id = state.id || `chatcmpl-${Date.now()}${String(process.hrtime.bigint()).slice(-6)}`
  const created = state.created || Math.floor(Date.now() / 1000)

  const message = { role: 'assistant', content: state.content }
  if (state.reasoning) message.reasoning_content = state.reasoning

  if (state.toolOrder.length > 0) {
    const order = [...state.toolOrder].sort((a, b) => a - b)
    let calls = order.map(idx => state.toolCalls.get(idx)).filter(Boolean)
    if (state.finishReason === 'length' || !state.sawDone) calls = dropTruncatedToolCalls(calls)
    if (calls.length > 0) message.tool_calls = calls
  }

  const resp = {
    id,
    object: 'chat.completion',
    created,
    model: state.model,
    choices: [{ index: 0, message, finish_reason: state.finishReason }]
  }
  if (state.usage) resp.usage = normalizeUsageCacheAliases(ensureUsageTotal(state.usage))
  return resp
}

// tool_calls 按 index 合并（index 缺失时按 id 优先、末位兜底归位）
function mergeToolCallsChunk(state, calls) {
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    let idx
    const hasIndex = typeof call.index === 'number'
    if (hasIndex) {
      idx = Math.trunc(call.index)
    } else if (call.id) {
      idx = state.idIndex.has(call.id) ? state.idIndex.get(call.id) : nextToolIndex(state)
    } else if (state.toolOrder.length > 0) {
      idx = state.toolOrder[state.toolOrder.length - 1]
    } else {
      idx = nextToolIndex(state)
    }

    let merged = state.toolCalls.get(idx)
    if (!merged) {
      merged = { index: idx }
      state.toolCalls.set(idx, merged)
      state.toolOrder.push(idx)
    }
    if (call.id) state.idIndex.set(call.id, idx)

    mergeToolCallDelta(merged, call)
    if (merged.id) state.idIndex.set(merged.id, idx)
  }
}

// 下一个可用 tool index（跳过已占用）
function nextToolIndex(state) {
  while (state.toolCalls.has(state.toolSeq)) state.toolSeq++
  const idx = state.toolSeq
  state.toolSeq++
  return idx
}

// 合并单个 tool_call 增量
function mergeToolCallDelta(merged, delta) {
  if (delta.id) merged.id = delta.id
  if (delta.type) merged.type = delta.type
  const fn = delta.function
  if (!fn || typeof fn !== 'object') return
  merged.function = merged.function || {}
  if (fn.name) merged.function.name = fn.name
  if (fn.arguments) {
    merged.function.arguments = merged.function.arguments ? merged.function.arguments + fn.arguments : fn.arguments
  }
}

module.exports = {
  createFrameRebuilder,
  normalizeFrame,
  normalizeUsageCacheAliases,
  ensureUsageTotal,
  isTruncatedArguments,
  dropTruncatedToolCalls,
  aggregateSSE,
  emptyStreamError
}