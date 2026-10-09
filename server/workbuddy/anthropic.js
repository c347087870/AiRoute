// Anthropic ⇄ OpenAI 协议转换（仅 WorkBuddy 账号池通道使用）
// 请求向：/v1/messages 的 Anthropic 请求体 → OpenAI 请求体（再进既有改写管线）
// 响应向：OpenAI 帧/聚合结果 → Anthropic 事件流/Message（供 Claude Code 等客户端）

// 生成带前缀的随机 id（msg_ / toolu_）
function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// tool_result 内容拍平为文本：字符串直返；块数组取全部 text 块；其他对象 JSON 化
function flattenToolResult(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('')
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return ''
}

// ===== 请求向：Anthropic body → OpenAI body =====

// 主转换：system 顶层字段 → 首条 system 消息；工具/工具调用/工具结果按 OpenAI 形态重建
function toOpenAI(body) {
  const src = body && typeof body === 'object' ? body : {}
  const out = { ...src }
  delete out.metadata
  delete out.thinking

  const messages = []
  // system：字符串或块数组（Claude Code 多块 + cache_control）→ 单条 system 消息
  if (src.system) {
    const text = Array.isArray(src.system)
      ? src.system.map(b => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
      : String(src.system)
    if (text) messages.push({ role: 'system', content: text })
  }

  for (const m of Array.isArray(src.messages) ? src.messages : []) {
    if (!m || typeof m !== 'object') continue
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content })
      continue
    }
    const blocks = Array.isArray(m.content) ? m.content : []
    if (role === 'assistant') {
      const texts = []
      const calls = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
        else if (b.type === 'tool_use') {
          calls.push({
            id: b.id || '',
            type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) }
          })
        }
        // thinking / redacted_thinking 等无 OpenAI 对应 → 丢弃
      }
      if (!texts.length && !calls.length) continue
      const msg = { role, content: texts.length ? texts.join('') : null }
      if (calls.length) msg.tool_calls = calls
      messages.push(msg)
    } else {
      const parts = []
      const toolMsgs = []
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: b.text })
        else if (b.type === 'image' && b.source) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data || ''}` }
          })
        } else if (b.type === 'tool_result') {
          // 工具结果必须作为独立 tool 消息（跟在 assistant.tool_calls 之后）
          toolMsgs.push({
            role: 'tool',
            tool_call_id: b.tool_use_id || '',
            content: flattenToolResult(b.content)
          })
        }
      }
      if (toolMsgs.length) messages.push(...toolMsgs)
      if (parts.length) {
        messages.push({ role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
      }
    }
  }
  out.messages = messages

  // tools：{name, description, input_schema} → {type:'function', function:{...}}
  if (Array.isArray(src.tools)) {
    const tools = []
    for (const t of src.tools) {
      if (!t || typeof t !== 'object' || !t.name) continue
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema && typeof t.input_schema === 'object'
            ? t.input_schema
            : { type: 'object', properties: {} }
        }
      })
    }
    if (tools.length) out.tools = tools
    else delete out.tools
  }

  // tool_choice：auto → 'auto'；any → 'required'；tool → 指定函数
  if (src.tool_choice && typeof src.tool_choice === 'object') {
    const type = src.tool_choice.type
    if (type === 'auto') out.tool_choice = 'auto'
    else if (type === 'any') out.tool_choice = 'required'
    else if (type === 'tool' && src.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: src.tool_choice.name } }
    } else delete out.tool_choice
  }

  // stop_sequences → stop
  if (Array.isArray(src.stop_sequences)) {
    out.stop = src.stop_sequences
    delete out.stop_sequences
  }
  return out
}

// ===== 响应向：OpenAI → Anthropic =====

// finish_reason → Anthropic stop_reason
function mapStopReason(finish) {
  if (finish === 'length') return 'max_tokens'
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use'
  return 'end_turn'
}

// 聚合的 chat.completion → Anthropic Message（含 tool_use 块、usage）
function toMessage(agg, fallbackModel) {
  const src = agg && typeof agg === 'object' ? agg : {}
  const choice = (Array.isArray(src.choices) && src.choices[0]) || {}
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {}
  const content = []
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!call || !call.function || !call.function.name) continue
    let input = {}
    try {
      input = JSON.parse(call.function.arguments || '{}')
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: call.id || genId('toolu'), name: call.function.name, input })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  const usage = src.usage && typeof src.usage === 'object' ? src.usage : {}
  return {
    id: genId('msg'),
    type: 'message',
    role: 'assistant',
    model: src.model || fallbackModel || '',
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0
    }
  }
}

// 流式事件生成器：消费「重建后的 OpenAI 帧文本」，产出 Anthropic SSE 事件文本
// push(text) 返回要写出的文本（'' = 忽略）；end() 输出收尾事件；fail(err) 输出 error 事件
function createStreamEmitter(opts = {}) {
  const model = opts.model || ''
  let started = false // message_start 已发
  let finished = false // 已收尾（end/fail/错误事件）
  let nextIndex = 0 // 下一个 content_block 下标
  let textIndex = -1 // 文本块下标（-1 = 未开）
  let textOpen = false
  const toolBlocks = new Map() // OpenAI tool index → { block, id, name }
  let stopReason = 'end_turn'
  let lastUsage = null
  const msgId = genId('msg')

  // 拼装一个 SSE 事件
  const evt = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

  // 首次需要时发出 message_start（幂等）
  function ensureStart() {
    if (started) return ''
    started = true
    return evt('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
  }

  // 关闭已打开的文本块
  function closeText() {
    if (!textOpen) return ''
    textOpen = false
    return evt('content_block_stop', { type: 'content_block_stop', index: textIndex })
  }

  // 处理一帧重建后的 OpenAI 增量帧
  function pushFrame(obj) {
    const choice = (Array.isArray(obj.choices) && obj.choices[0]) || {}
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
    if (obj.usage && typeof obj.usage === 'object') lastUsage = obj.usage
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      stopReason = mapStopReason(choice.finish_reason)
    }
    let out = ''
    const hasContent = typeof delta.content === 'string' && delta.content
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(c => c && typeof c === 'object') : []
    if (!hasContent && !calls.length) return ''
    out += ensureStart()
    if (hasContent) {
      if (!textOpen) {
        textIndex = nextIndex++
        textOpen = true
        out += evt('content_block_start', {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' }
        })
      }
      out += evt('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content }
      })
    }
    for (const call of calls) {
      const idx = typeof call.index === 'number' ? call.index : 0
      let tb = toolBlocks.get(idx)
      if (!tb) {
        out += closeText() // 文本块先收口（工具块之后不再有文本）
        tb = { block: nextIndex++, id: '', name: '' }
        toolBlocks.set(idx, tb)
      }
      if (call.id) tb.id = call.id
      if (call.function && call.function.name) tb.name = call.function.name
      if (!tb.opened) {
        tb.opened = true
        out += evt('content_block_start', {
          type: 'content_block_start',
          index: tb.block,
          content_block: { type: 'tool_use', id: tb.id || genId('toolu'), name: tb.name || 'tool_call', input: {} }
        })
      }
      const args = call.function && call.function.arguments
      if (typeof args === 'string' && args) {
        out += evt('content_block_delta', {
          type: 'content_block_delta',
          index: tb.block,
          delta: { type: 'input_json_delta', partial_json: args }
        })
      }
    }
    return out
  }

  // 消费一段下行文本（可能是 data 帧、[DONE] 或注释行）；返回要写出的文本
  function push(text) {
    if (finished) return ''
    const s = String(text || '')
    if (!s.startsWith('data: ')) return '' // 注释行等一律不转发（保持事件流纯净）
    const payload = s.slice(6).trim()
    if (payload === '[DONE]') return ''
    let obj = null
    try {
      obj = JSON.parse(payload)
    } catch {
      obj = null
    }
    if (!obj || typeof obj !== 'object') return ''
    if (Object.prototype.hasOwnProperty.call(obj, 'error')) {
      finished = true
      const base = obj.error && typeof obj.error === 'object' ? obj.error : { message: String(obj.error || '') }
      const hint = base.gateway_hint ? `（${base.gateway_hint}）` : ''
      return evt('error', { type: 'error', error: { type: 'api_error', message: `${base.message || 'upstream error'}${hint}` } })
    }
    return pushFrame(obj)
  }

  // 收尾：关闭未闭合块 + message_delta + message_stop（幂等）
  function end() {
    if (finished) return ''
    finished = true
    if (!started) return '' // 从未产出任何内容：不伪造消息，交由客户端判定空流
    let out = closeText()
    for (const tb of toolBlocks.values()) {
      if (tb.opened) out += evt('content_block_stop', { type: 'content_block_stop', index: tb.block })
    }
    const outputTokens = lastUsage && Number(lastUsage.completion_tokens) > 0 ? Number(lastUsage.completion_tokens) : 0
    out += evt('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    })
    out += evt('message_stop', { type: 'message_stop' })
    return out
  }

  // 流中断失败：输出 error 事件（幂等）
  function fail(err) {
    if (finished) return ''
    finished = true
    const msg = (err && err.message) || 'upstream error'
    const hint = err && err.gatewayHint ? `（${err.gatewayHint}）` : ''
    return evt('error', { type: 'error', error: { type: 'api_error', message: `${msg}${hint}` } })
  }

  return { push, end, fail }
}

// Anthropic 错误体（网关自身错误对外形态）
function errorBody(message, hint) {
  const text = String(message || '')
  return {
    type: 'error',
    error: { type: 'api_error', message: hint ? `${text}（${hint}）` : text }
  }
}

module.exports = {
  toOpenAI,
  toMessage,
  createStreamEmitter,
  mapStopReason,
  errorBody
}
