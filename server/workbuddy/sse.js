// SSE 帧重建与非流式聚合
// 翻译自参考项目 internal/upstream/sse.go / truncation.go / usage.go
const dsmlMod = require('./dsml')

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

// 逐帧重建器：收敛 tool_calls 的 name、首帧 id 续传、白名单剔除噪声；
// 可选挂标记修复器（options.repair，见 dsml.js），把正文里的原生工具调用标记
// 还原成 delta.tool_calls
function createFrameRebuilder(options = {}) {
  const repair = options.repair || null
  const toolCallSeen = {} // index → 是否已输出过 name
  let firstID = ''
  let maxToolIdx = -1 // 上游已用过的最大 tool_call index（合成 index 从其后接续）
  let synthIdx = 0 // 本流已合成的调用数（避开上游已用 index）
  let toolFinishSent = false // 是否已发出过 finish_reason: tool_calls（流尾兜底用）
  return { push, reset, finish }

  // 处理一帧 payload 文本，返回重建后的所有 payload（error 帧单帧原样返回）。
  // 命中标记修复时一帧展开成多帧：正文帧 + N 个 delta.tool_calls 帧 + 收尾帧
  function push(payload) {
    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      return { payloads: [payload], valid: false }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { payloads: [payload], valid: false }

    if (Object.prototype.hasOwnProperty.call(obj, 'error')) {
      return { payloads: [payload], valid: true } // error 帧绕过白名单原样透传
    }

    const frames = repair && repair.enabled() ? repairFrame(obj) : [obj]
    return { payloads: frames.map(rebuildOne), valid: true }
  }

  // 标记修复（见 dsml.js 的文件头说明）：把本帧 delta.content 喂给修复器，命中时
  // 把还原出的调用转成独立的 delta.tool_calls 帧，finish_reason 挪到调用帧之后
  // ——否则客户端在读到调用之前就认为回合已经结束
  function repairFrame(obj) {
    if (!Array.isArray(obj.choices)) return [obj]
    const calls = []
    for (const choice of obj.choices) {
      const d = choice && typeof choice === 'object' ? choice.delta : null
      if (!d || typeof d !== 'object') continue
      if (typeof d.content !== 'string' || !d.content) continue
      const got = repair.feed(d.content)
      for (const call of got.calls) calls.push(call)
      if (got.text === '') delete d.content
      else d.content = got.text
    }
    if (calls.length === 0) {
      // 本帧没命中标记；但本流此前还原过调用 → 把上游的 stop 收尾改写成
      // tool_calls，客户端据此知道「回合以工具调用结束」而不是「模型只说了话」
      if (synthIdx > 0 && rewriteFinishReason(obj, 'tool_calls')) toolFinishSent = true
      return [obj]
    }
    // 命中：注意「本帧本来没有 finish_reason」时不得补收尾帧——上游的收尾帧
    // 随后就到，补了会变成两个 finish_reason
    const fr = takeFinishReason(obj)
    const out = [obj]
    for (const call of calls) {
      const idx = maxToolIdx + 1 + synthIdx
      synthIdx++
      out.push(markupCallFrame(obj, idx, call))
    }
    if (fr) {
      const want = fr === 'stop' ? 'tool_calls' : fr
      out.push(finishOnlyFrame(obj, want))
      toolFinishSent = want === 'tool_calls'
    }
    return out
  }

  // 单帧规范重建：strip name + id 续传 + maxToolIdx 跟踪 + 白名单，返回 payload 文本
  function rebuildOne(obj) {
    stripToolCallNames(obj)

    // 首帧 id 续传：后续帧缺 id 用缓存值
    if (typeof obj.id === 'string' && obj.id) {
      if (!firstID) firstID = obj.id
    } else if (firstID) {
      obj.id = firstID
    }

    // 上游已用过的最大 tool_call index（供合成调用接续编号，避免撞车）
    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        const calls = choice && choice.delta && Array.isArray(choice.delta.tool_calls) ? choice.delta.tool_calls : []
        for (const call of calls) {
          if (call && typeof call.index === 'number' && Math.trunc(call.index) > maxToolIdx) maxToolIdx = Math.trunc(call.index)
        }
      }
    }

    const normalized = normalizeFrame(obj)
    return JSON.stringify(normalized)
  }

  // 流末收尾：回吐尾缓冲（未判定的字节一律原文交还，未闭合的块连起始标记一起），
  // 若本流还原过调用、但上游从未给出收尾帧，补一帧 finish_reason: tool_calls。
  // 返回 { payloads: 尾部帧, validCount: 其中应计入有效帧的帧数 }（对齐参考实现：
  // 只有尾缓冲回吐帧计数，兜底收尾帧不计——避免把空流伪装成非空）
  function finish() {
    const payloads = []
    let validCount = 0
    if (repair && repair.enabled()) {
      const tail = repair.flush()
      if (tail) {
        payloads.push(rebuildOne({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: tail } }] }))
        validCount = 1
      }
      if (synthIdx > 0 && !toolFinishSent) {
        payloads.push(rebuildOne(finishOnlyFrame({}, 'tool_calls')))
      }
    }
    return { payloads, validCount }
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
    maxToolIdx = -1
    synthIdx = 0
    toolFinishSent = false
  }
}

// takeFinishReason 取出并删除所有 choice 的 finish_reason，返回第一个非空值。
// 标记修复把一帧拆成多帧时需要它：finish_reason 必须落在工具调用帧之后
function takeFinishReason(obj) {
  let fr = ''
  const choices = Array.isArray(obj.choices) ? obj.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    if (!fr && typeof choice.finish_reason === 'string' && choice.finish_reason) fr = choice.finish_reason
    delete choice.finish_reason
  }
  return fr
}

// rewriteFinishReason 把 choice 上「已有且为 stop」的 finish_reason 改写成 want。
// 本来就没有 finish_reason 的中间帧一律不动（绝不凭空造收尾），已有其他值
// （length / content_filter 等）时也不动。返回是否发生了改写
function rewriteFinishReason(obj, want) {
  let changed = false
  const choices = Array.isArray(obj.choices) ? obj.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    if (choice.finish_reason === 'stop') {
      choice.finish_reason = want
      changed = true
    }
  }
  return changed
}

// markupCallFrame 以 src 帧为模板，构造一帧只带单个 delta.tool_calls 的 chunk。
// id 不在这里写：交给重建器的 id 续传逻辑补齐（src 帧先写出，firstID 已就位）
function markupCallFrame(src, idx, call) {
  const frame = {
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { tool_calls: dsmlMod.markupToolCalls([call], idx) } }]
  }
  for (const k of ['created', 'model']) {
    if (src[k] !== undefined && src[k] !== null) frame[k] = src[k]
  }
  return frame
}

// finishOnlyFrame 构造一帧只带 finish_reason 的收尾 chunk（空 delta）
function finishOnlyFrame(src, finish) {
  const frame = {
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: finish }]
  }
  for (const k of ['created', 'model']) {
    if (src[k] !== undefined && src[k] !== null) frame[k] = src[k]
  }
  return frame
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