// 上游模型的调用协议封装
// router（请求代理）与 benchmark（模型评测）都从这里取，避免协议逻辑重复实现

// 去掉用户配置末尾的斜杠，避免拼出 //v1/messages 这样的双斜杠路径
function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

// 根据协议类型返回对应的端点 URL，未配置端点时返回 null
function resolveEndpoint(provider, isAnthropic) {
  if (isAnthropic) {
    if (!provider.baseURL) return null
    return trimTrailingSlash(provider.baseURL) + '/v1/messages'
  }
  const openaiUrl = provider.openaiURL || ''
  if (!openaiUrl) return null
  return trimTrailingSlash(openaiUrl) + '/chat/completions'
}

// 根据协议类型返回对应的请求头
function resolveHeaders(provider, isAnthropic) {
  if (isAnthropic) {
    return {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  }
  return {
    'Authorization': `Bearer ${provider.apiKey}`,
    'content-type': 'application/json'
  }
}

// Anthropic 协议要求 system 必须是顶层字段；CodeBuddy 等客户端按 OpenAI 习惯把
// role=system 消息放进 messages，上游会报 invalid params，这里统一提取合并到顶层 system
function extractSystemMessages(reqBody) {
  if (!Array.isArray(reqBody.messages)) return reqBody
  const systemParts = Array.isArray(reqBody.system) ? [...reqBody.system] : (reqBody.system ? [reqBody.system] : [])
  const messages = []
  let hasSystemMsg = false
  for (const m of reqBody.messages) {
    if (m && m.role === 'system') {
      hasSystemMsg = true
      // 字符串内容包装为文本块，数组内容保留原始块（含 cache_control 等字段）
      if (typeof m.content === 'string') systemParts.push({ type: 'text', text: m.content })
      else if (Array.isArray(m.content)) systemParts.push(...m.content)
      continue
    }
    messages.push(m)
  }
  if (!hasSystemMsg) return reqBody
  return { ...reqBody, messages, system: systemParts }
}

// 构造转发请求体：替换模型 ID，按需注入 max_tokens 与流式用量开关
// reasoningEffort 为 AiRoute 客户端统一指定的推理档位（max/high/medium/low），off 表示移除该字段；
// 不透传请求里的原始值——CodeBuddy 等客户端可能发出上游不认识的档位（如 xhigh），lkeap 会直接报 400
function buildRequestBody(body, model, isStream, isAnthropic, reasoningEffort) {
  const reqBody = { ...body, model: model.id }
  if (isStream !== undefined) {
    reqBody.stream = isStream
  }
  // OpenAI 协议流式默认不返回 usage，需显式开启才能统计到 Token
  if (isStream && !isAnthropic) {
    reqBody.stream_options = { ...(reqBody.stream_options || {}), include_usage: true }
  }
  // Anthropic 协议要求 max_tokens 必填，客户端未指定时回落到模型配置的最大输出
  if (reqBody.max_tokens === undefined || reqBody.max_tokens === null) {
    if (model.maxOutput) reqBody.max_tokens = model.maxOutput
  }
  // 推理档位是 OpenAI 协议字段，由网关按客户端配置强制覆盖（Anthropic 端点没有该字段，无需处理）
  if (!isAnthropic && reasoningEffort !== undefined) {
    if (reasoningEffort === 'off') delete reqBody.reasoning_effort
    else reqBody.reasoning_effort = reasoningEffort
  }
  return isAnthropic ? extractSystemMessages(reqBody) : reqBody
}

function toNum(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function usageTotal(usage) {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output
}

// 非流式响应中提取用量
// Anthropic 的 input_tokens 不含缓存部分；OpenAI 的 prompt_tokens 包含缓存，需扣除后才是未缓存输入
function extractUsage(data, isAnthropic) {
  if (!data || !data.usage) return null

  if (isAnthropic) {
    return {
      input: toNum(data.usage.input_tokens),
      output: toNum(data.usage.output_tokens),
      cacheRead: toNum(data.usage.cache_read_input_tokens),
      cacheWrite: toNum(data.usage.cache_creation_input_tokens)
    }
  }

  const cached = toNum(data.usage.prompt_tokens_details?.cached_tokens)
  const prompt = toNum(data.usage.prompt_tokens)
  return {
    input: Math.max(0, prompt - cached),
    output: toNum(data.usage.completion_tokens),
    cacheRead: cached,
    cacheWrite: 0
  }
}

// 从响应体中提取纯文本回答
function extractText(data, isAnthropic) {
  if (!data) return ''

  if (isAnthropic) {
    if (!Array.isArray(data.content)) return ''
    return data.content
      .filter(block => block && block.type === 'text')
      .map(block => block.text || '')
      .join('')
  }

  return data.choices?.[0]?.message?.content || ''
}

// 从单行 SSE 文本中提取用量（单帧通常只含部分字段，由调用方合并）
function parseUsageLine(line, isAnthropic) {
  const trimmed = String(line || '').trim()
  if (!trimmed.startsWith('data: ')) return null

  const dataStr = trimmed.slice(6).trim()
  if (dataStr === '[DONE]') return null

  try {
    const data = JSON.parse(dataStr)

    if (isAnthropic) {
      // message_start 携带输入与缓存用量，message_delta 携带输出用量
      if (data.type === 'message_start' && data.message?.usage) {
        const usage = data.message.usage
        return {
          input: toNum(usage.input_tokens),
          output: 0,
          cacheRead: toNum(usage.cache_read_input_tokens),
          cacheWrite: toNum(usage.cache_creation_input_tokens)
        }
      }
      if (data.type === 'message_delta' && data.usage) {
        return {
          input: toNum(data.usage.input_tokens),
          output: toNum(data.usage.output_tokens),
          cacheRead: toNum(data.usage.cache_read_input_tokens),
          cacheWrite: toNum(data.usage.cache_creation_input_tokens)
        }
      }
    } else if (data.usage) {
      const cached = toNum(data.usage.prompt_tokens_details?.cached_tokens)
      const prompt = toNum(data.usage.prompt_tokens)
      return {
        input: Math.max(0, prompt - cached),
        output: toNum(data.usage.completion_tokens),
        cacheRead: cached,
        cacheWrite: 0
      }
    }
  } catch {
    // 忽略非 JSON 帧
  }

  return null
}

// 带行缓冲的流式用量提取器：TCP 拆包可能把一条 SSE 帧切到两个 chunk，
// 缓冲残行后再解析，避免 usage 帧被截断丢失导致流式统计少计
function createStreamUsageExtractor(isAnthropic) {
  let remainder = ''
  return {
    // 推入一个 chunk，返回本次解析出的用量（可能为 null）
    push(chunk) {
      remainder += chunk.toString()
      const lines = remainder.split('\n')
      remainder = lines.pop() || ''
      let usage = null
      for (const line of lines) {
        const found = parseUsageLine(line, isAnthropic)
        if (found) usage = found
      }
      return usage
    },
    // 流结束时冲刷残行，返回末尾帧的用量（可能为 null）
    end() {
      const found = parseUsageLine(remainder, isAnthropic)
      remainder = ''
      return found
    }
  }
}

// 合并流式多帧用量：每个字段取最后一次出现的大于 0 的值
function mergeStreamUsage(target, incoming) {
  if (!incoming) return
  if (incoming.input > 0) target.input = incoming.input
  if (incoming.output > 0) target.output = incoming.output
  if (incoming.cacheRead > 0) target.cacheRead = incoming.cacheRead
  if (incoming.cacheWrite > 0) target.cacheWrite = incoming.cacheWrite
}

module.exports = {
  resolveEndpoint,
  resolveHeaders,
  buildRequestBody,
  extractUsage,
  extractText,
  createStreamUsageExtractor,
  mergeStreamUsage,
  emptyUsage,
  usageTotal,
  toNum
}
