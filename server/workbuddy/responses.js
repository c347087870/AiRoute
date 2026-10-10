// OpenAI Responses ⇄ OpenAI Chat 协议转换（仅 WorkBuddy 账号池通道使用）
// 请求向：POST /v1/responses 的 Responses 请求体 → Chat 请求体（再进既有改写管线）
// 响应向：Chat 帧/聚合结果 → Responses 事件流/Response 对象（供 Codex CLI 等客户端）

// 生成带前缀的随机 id（resp_ / msg_ / fc_ / call_）
function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// 工具结果内容拍平为文本：字符串直返；数组取全部文本块；其他对象 JSON 化
function flattenOutput(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map(b => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && typeof b.text === 'string') return b.text
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  if (output && typeof output === 'object') {
    try {
      return JSON.stringify(output)
    } catch {
      return ''
    }
  }
  return ''
}

// 内容块数组 → Chat 内容块：input_text/output_text/text → text；input_image/image_url → image_url
function contentBlocksToChat(blocks) {
  const parts = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue
    const type = b.type
    if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text })
    } else if (type === 'input_image' || type === 'image_url') {
      // input_image 的 image_url 是字符串；image_url 类型是 {url} 对象，两种都兼容
      const url = typeof b.image_url === 'string' ? b.image_url : (b.image_url && b.image_url.url) || b.url || ''
      if (url) parts.push({ type: 'image_url', image_url: { url } })
    }
  }
  return parts
}

// ===== 请求向：Responses body → Chat body =====

// input items 串成 Chat messages：assistant 文本与紧随其后的 function_call 合并为一条消息
// （function_call_output → role:tool 消息；reasoning 无 Chat 对应 → 丢弃）
function buildMessages(instructions, input) {
  const messages = []
  if (typeof instructions === 'string' && instructions) {
    messages.push({ role: 'system', content: instructions })
  }

  // assistant 缓冲：文本与工具调用合并成一条 assistant 消息（工具结果必须紧跟在它之后）
  let pendingText = ''
  let pendingCalls = []
  const flushAssistant = () => {
    if (!pendingText && !pendingCalls.length) return
    const msg = { role: 'assistant', content: pendingText || null }
    if (pendingCalls.length) msg.tool_calls = pendingCalls
    messages.push(msg)
    pendingText = ''
    pendingCalls = []
  }

  // 单条 item → 落消息（function_call 走缓冲，其余先冲刷缓冲）
  const handleItem = item => {
    if (!item || typeof item !== 'object') return
    const type = item.type
    if (type === 'function_call') {
      pendingCalls.push({
        id: item.call_id || item.id || genId('call'),
        type: 'function',
        function: {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
        }
      })
      return
    }
    if (type === 'reasoning') return // 无 Chat 对应，丢弃
    if (type === 'function_call_output') {
      flushAssistant() // 工具结果必须紧跟在 assistant.tool_calls 之后
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: flattenOutput(item.output)
      })
      return
    }
    // message 或无 type：按 role 映射；developer → system（上游不支持 developer）
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' || item.role === 'developer' ? 'system' : 'user'
    const content = typeof item.content === 'string' ? item.content : contentBlocksToChat(item.content)
    if (role === 'assistant') {
      if (typeof content === 'string') pendingText += content
      else if (Array.isArray(content)) pendingText += content.map(p => p.text || '').join('')
      return
    }
    flushAssistant()
    messages.push({ role, content })
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else {
    for (const item of Array.isArray(input) ? input : []) handleItem(item)
  }
  flushAssistant()
  return messages
}

// Responses 工具定义 → Chat 工具：function 类型映射为嵌套结构，其余类型（web_search /
// local_shell / mcp 等 Chat 无对应）丢弃；已是嵌套结构的原样透传
function normalizeTools(tools) {
  const out = []
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== 'object') continue
    if (t.function && typeof t.function === 'object') {
      out.push(t)
      continue
    }
    if (t.type !== 'function') continue
    const fn = { name: t.name || '' }
    if (typeof t.description === 'string') fn.description = t.description
    fn.parameters = t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} }
    if (typeof t.strict === 'boolean') fn.strict = t.strict
    out.push({ type: 'function', function: fn })
  }
  return out
}

// 主转换：instructions → system；input items → messages；tools / tool_choice / 参数映射
function toChat(body) {
  const src = body && typeof body === 'object' ? body : {}
  const out = { ...src }
  // Responses 专属字段：Chat 无对应，统一移除（否则会原样发往上游）
  delete out.instructions
  delete out.input
  delete out.store
  delete out.include
  delete out.text
  delete out.truncation
  delete out.previous_response_id
  delete out.prompt_cache_key
  delete out.metadata
  delete out.reasoning

  out.messages = buildMessages(src.instructions, src.input)

  // max_output_tokens → max_tokens（Chat 协议名）
  if (out.max_output_tokens !== undefined) {
    out.max_tokens = out.max_output_tokens
    delete out.max_output_tokens
  }
  // reasoning.effort → reasoning_effort（客户端显式指定时才映射，交由改写管线按模型档位处理）
  const effort = src.reasoning && typeof src.reasoning === 'object' ? src.reasoning.effort : ''
  if (effort && out.reasoning_effort === undefined) out.reasoning_effort = effort

  if (Array.isArray(src.tools)) {
    const tools = normalizeTools(src.tools)
    if (tools.length) out.tools = tools
    else delete out.tools
  }

  // tool_choice：{type:'function', name} → {type:'function', function:{name}}；其余原样
  const tc = src.tool_choice
  if (tc && typeof tc === 'object' && tc.type === 'function' && tc.name && !tc.function) {
    out.tool_choice = { type: 'function', function: { name: tc.name } }
  }
  return out
}

// ===== 响应向：Chat → Responses =====

// finish_reason → Responses 收尾状态（length → incomplete / max_output_tokens）
function finishStatus(finish) {
  if (finish === 'length') return { status: 'incomplete', reason: 'max_output_tokens' }
  if (finish === 'content_filter' || finish === 'content-filter') return { status: 'incomplete', reason: 'content_filter' }
  return { status: 'completed', reason: null }
}

// 上游 usage → Responses usage 对象（明细字段按协议补齐，reasoning_tokens 上游不提供记 0）
function usageObject(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  const prompt = Number(u.prompt_tokens) || 0
  const completion = Number(u.completion_tokens) || 0
  const cached = Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: Number(u.total_tokens) || prompt + completion
  }
}

// 聚合的 chat.completion → Response 对象（output：message 在前、工具调用随后）
function toResponse(agg, fallbackModel) {
  const src = agg && typeof agg === 'object' ? agg : {}
  const choice = (Array.isArray(src.choices) && src.choices[0]) || {}
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {}
  const output = []
  if (typeof message.content === 'string' && message.content) {
    output.push({
      id: genId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }]
    })
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!call || !call.function) continue
    output.push({
      id: genId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: call.id || genId('call'),
      name: call.function.name || '',
      arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments || {})
    })
  }
  const fs = finishStatus(choice.finish_reason)
  return {
    id: genId('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: fs.status,
    error: null,
    incomplete_details: fs.reason ? { reason: fs.reason } : null,
    model: src.model || fallbackModel || '',
    output,
    parallel_tool_calls: true,
    usage: usageObject(src.usage)
  }
}

// 流式事件生成器：消费「重建后的 OpenAI 帧文本」，产出 Responses SSE 事件文本
// push(text) 返回要写出的文本（'' = 忽略）；end() 输出收尾事件；fail(err) 输出 failed 事件
function createStreamEmitter(opts = {}) {
  const model = opts.model || ''
  let started = false // response.created 已发
  let finished = false // 已收尾（end/fail/错误事件）
  let nextOutputIndex = 0 // 下一条 output item 下标
  let textItem = null // 文本 message item 状态
  let lastUsage = null // 最近一帧的 usage
  let finishReason = '' // 上游收尾原因
  const toolItems = new Map() // OpenAI tool index → { outputIndex, id, callId, name, args, opened }
  const order = [] // 已收口 item：{ outputIndex, item }（completed 时按序放进 output）
  const respId = genId('resp')

  // 拼装一个 SSE 事件
  const evt = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

  // Response 对象骨架（created / in_progress / completed / failed 共用）
  function baseResponse(status, extra = {}) {
    return {
      id: respId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      error: null,
      incomplete_details: null,
      model,
      output: [],
      parallel_tool_calls: true,
      usage: null,
      ...extra
    }
  }

  // failed 事件：错误信息按 Responses 形态包装（幂等由调用方保证）
  function failedEvent(message, hint) {
    const text = hint ? `${message}（${hint}）` : message
    return evt('response.failed', {
      type: 'response.failed',
      response: baseResponse('failed', { error: { code: 'upstream_error', message: text } })
    })
  }

  // 首次需要时发出 response.created + response.in_progress（幂等）
  function ensureStart() {
    if (started) return ''
    started = true
    return (
      evt('response.created', { type: 'response.created', response: baseResponse('in_progress') }) +
      evt('response.in_progress', { type: 'response.in_progress', response: baseResponse('in_progress') })
    )
  }

  // 打开文本 message item（幂等：output_item.added + content_part.added）
  function ensureTextItem() {
    if (textItem) return ''
    textItem = { outputIndex: nextOutputIndex++, id: genId('msg'), text: '' }
    let out = evt('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: textItem.outputIndex,
      item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    })
    out += evt('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: textItem.id,
      output_index: textItem.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    })
    return out
  }

  // 收口文本 item（output_text.done + content_part.done + output_item.done，幂等）
  function closeTextItem() {
    if (!textItem || textItem.closed) return ''
    textItem.closed = true
    const part = { type: 'output_text', text: textItem.text, annotations: [] }
    const item = { id: textItem.id, type: 'message', status: 'completed', role: 'assistant', content: [part] }
    order.push({ outputIndex: textItem.outputIndex, item })
    let out = evt('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: textItem.id,
      output_index: textItem.outputIndex,
      content_index: 0,
      text: textItem.text
    })
    out += evt('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: textItem.id,
      output_index: textItem.outputIndex,
      content_index: 0,
      part
    })
    out += evt('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: textItem.outputIndex,
      item
    })
    return out
  }

  // 处理一条工具调用增量：首次出现分配 output_index 并发 output_item.added
  function handleToolDelta(call) {
    const idx = typeof call.index === 'number' ? call.index : 0
    let tb = toolItems.get(idx)
    if (!tb) {
      tb = { outputIndex: nextOutputIndex++, id: genId('fc'), callId: '', name: '', args: '', opened: false }
      toolItems.set(idx, tb)
    }
    if (call.id) tb.callId = call.id
    if (call.function && call.function.name) tb.name = call.function.name
    let out = ''
    if (!tb.opened) {
      tb.opened = true
      out += evt('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: tb.outputIndex,
        item: { id: tb.id, type: 'function_call', status: 'in_progress', call_id: tb.callId, name: tb.name, arguments: '' }
      })
    }
    const args = call.function && call.function.arguments
    if (typeof args === 'string' && args) {
      tb.args += args
      out += evt('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: tb.id,
        output_index: tb.outputIndex,
        delta: args
      })
    }
    return out
  }

  // 收口一条工具调用（arguments.done + output_item.done，幂等）
  function closeToolItem(tb) {
    if (tb.closed) return ''
    tb.closed = true
    const item = { id: tb.id, type: 'function_call', status: 'completed', call_id: tb.callId, name: tb.name, arguments: tb.args }
    order.push({ outputIndex: tb.outputIndex, item })
    let out = evt('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: tb.id,
      output_index: tb.outputIndex,
      arguments: tb.args
    })
    out += evt('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: tb.outputIndex,
      item
    })
    return out
  }

  // 处理一帧重建后的 OpenAI 增量帧
  function pushFrame(obj) {
    const choice = (Array.isArray(obj.choices) && obj.choices[0]) || {}
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
    if (obj.usage && typeof obj.usage === 'object') lastUsage = obj.usage
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
    const hasContent = typeof delta.content === 'string' && delta.content
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(c => c && typeof c === 'object') : []
    if (!hasContent && !calls.length) return ''
    let out = ensureStart()
    if (hasContent) {
      out += ensureTextItem()
      textItem.text += delta.content
      out += evt('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: textItem.id,
        output_index: textItem.outputIndex,
        content_index: 0,
        delta: delta.content
      })
    }
    for (const call of calls) out += handleToolDelta(call)
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
      return failedEvent(base.message || 'upstream error', base.gateway_hint)
    }
    return pushFrame(obj)
  }

  // 收尾：关闭未收口 item + completed / incomplete 事件（幂等）
  function end() {
    if (finished) return ''
    finished = true
    if (!started) return '' // 从未产出任何内容：不伪造响应，交由客户端判定空流
    let out = closeTextItem()
    for (const tb of toolItems.values()) out += closeToolItem(tb)
    // output 按 output_index 排序（与流式事件的发出顺序一致）
    const output = order
      .slice()
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map(o => o.item)
    const fs = finishStatus(finishReason)
    const type = fs.status === 'incomplete' ? 'response.incomplete' : 'response.completed'
    const response = baseResponse(fs.status, {
      incomplete_details: fs.reason ? { reason: fs.reason } : null,
      output,
      usage: usageObject(lastUsage)
    })
    out += evt(type, { type, response })
    return out
  }

  // 流中断失败：输出 failed 事件（幂等）
  function fail(err) {
    if (finished) return ''
    finished = true
    const msg = (err && err.message) || 'upstream error'
    return failedEvent(msg, err && err.gatewayHint)
  }

  return { push, end, fail }
}

// 网关自身错误体（Responses 客户端对非 2xx 响应的 JSON 错误体）
function errorBody(message, hint) {
  const text = String(message || '')
  return { error: { message: hint ? `${text}（${hint}）` : text, type: 'api_error' } }
}

module.exports = {
  toChat,
  toResponse,
  createStreamEmitter,
  errorBody
}
