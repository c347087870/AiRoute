// 渠道 chunk → OpenAI Chat 协议
//
// 渠道适配器吐的是 DSH 的内部流事件（text-delta / reasoning-delta /
// tool-call-delta / usage / finish）。AiRoute 对外的三个端点都建立在 OpenAI
// Chat 形态之上（Anthropic 与 Responses 客户端由 workbuddy 的转换器转过去），
// 所以这里只需要一份 OpenAI 映射，三个端点共用，避免同一份用量在三条路径上
// 算出三个数。
//
// 映射逐条对齐 dsh-our-free-model 自己的网关（openai-gateway/stream.ts），
// 差异只有一处：这里不拼 `error` 帧给客户端 —— AiRoute 的错误出口在 router，
// 流已发出 200 时由调用方决定写什么。

const crypto = require('crypto')

// DSH 的 FinishReason → OpenAI finish_reason。
// aborted / error 都映射成 'error'：这两者在 OpenAI 协议里没有对应值，
// 而伪造 'stop' 会让客户端把一次失败当成正常收尾（读到的内容是残缺的）。
function finishReason(reason) {
  switch (reason?.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    default: return 'error'
  }
}

// 非负整数归一：用量字段宁少不崩
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

// DSH 的互斥口径 → OpenAI 的含缓存口径。
// 关键一行是 input = 未命中 + 命中 + 写入：漏掉缓存会让客户端把上下文占用
// 算小一两个数量级，进而永远不触发自动压缩。
function toOpenAiUsage(usage) {
  const cached = count(usage?.cacheReadTokens)
  const written = count(usage?.cacheWriteTokens)
  const inputTokens = count(usage?.inputTokens) + cached + written
  const outputTokens = count(usage?.outputTokens)
  const reported = count(usage?.totalTokens)
  const reasoningTokens = count(usage?.reasoningTokens)
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: Math.max(reported, inputTokens + outputTokens),
    prompt_tokens_details: { cached_tokens: cached },
    ...reasoningTokens > 0
      ? { reasoning_tokens: reasoningTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } }
      : {},
  }
}

// 一次请求的状态机：push 消费 chunk 并返回增量帧，end 收尾。
// 流式与聚合两个出口共用它，保证两边算出的文本、工具调用、用量完全一致。
function createCollector(model) {
  const id = `chatcmpl-${crypto.randomUUID()}`
  let content = ''
  let reasoning = ''
  const tools = new Map()
  let usage
  let finish
  let completionUsage

  function baseChunk(delta, finishReasonValue) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReasonValue ?? null }],
    }
  }

  function push(chunk) {
    switch (chunk?.type) {
      case 'text-delta':
        content += chunk.text
        return [baseChunk({ content: chunk.text })]
      case 'reasoning-delta':
        reasoning += chunk.text
        // reasoning_content 是业界事实标准（DeepSeek / vLLM 同名字段），
        // 客户端不认识时忽略即可，不影响正文
        return [baseChunk({ reasoning_content: chunk.text })]
      case 'tool-call-delta': {
        let tool = tools.get(chunk.index)
        if (!tool) {
          tool = { id: String(chunk.id ?? ''), name: undefined, arguments: '' }
          tools.set(chunk.index, tool)
        }
        tool.id = String(chunk.id || tool.id)
        if (chunk.name !== undefined) tool.name = chunk.name
        tool.arguments += chunk.argumentsDelta ?? ''
        return [baseChunk({
          tool_calls: [{
            index: chunk.index,
            id: tool.id,
            type: 'function',
            function: {
              ...tool.name === undefined ? {} : { name: tool.name },
              arguments: chunk.argumentsDelta ?? '',
            },
          }],
        })]
      }
      case 'usage':
        usage = chunk.usage
        return []
      case 'finish': {
        finish = chunk.reason?.kind
        const frames = [baseChunk({}, finishReason(chunk.reason))]
        // 收尾帧之后紧跟用量帧（choices 为空），与官方网关一致：
        // 有 usage 时客户端才会记账，缺了它统计里只有 0
        if (usage !== undefined) {
          completionUsage = toOpenAiUsage(usage)
          frames.push({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            usage: completionUsage,
          })
        }
        return frames
      }
      default:
        // block-start / block-end 不映射：block-end 携带的是已拼好的
        // arguments，而增量帧已经逐段发过了，重发会让客户端把参数拼两遍
        return []
    }
  }

  function completion() {
    const toolCalls = [...tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tool]) => ({
        id: tool.id || `call_${crypto.randomUUID()}`,
        type: 'function',
        function: { name: tool.name ?? '', arguments: tool.arguments === '' ? '{}' : tool.arguments },
      }))
    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content === '' && toolCalls.length > 0 ? null : content,
          ...reasoning === '' ? {} : { reasoning_content: reasoning },
          ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
        },
        finish_reason: finish === 'tool-calls' ? 'tool_calls'
          : finish === 'max-tokens' ? 'length'
            : finish === 'error' || finish === 'aborted' ? 'error'
              : 'stop',
      }],
      // 没有用量就整个字段缺省：给 0 会被统计口径当成「真实用量为零」
      ...completionUsage === undefined ? {} : { usage: completionUsage },
    }
  }

  return {
    push,
    completion,
    get usage() { return completionUsage },
    get failed() { return finish === 'error' || finish === 'aborted' },
    // 上游在流里报错时，正文可能是残缺的；把已产出的部分交回给调用方记录，
    // 但错误本身由 router 的异常出口负责（不在流里伪造成功）
    get text() { return content },
  }
}

// 流式写出：返回 { write(chunk) → string, done() → string }
// 只产出 `data: …\n\n` 帧，由 router 决定写到哪里（OpenAI 直写、Anthropic 与
// Responses 走各自的转换器）。
function createStreamWriter(model) {
  const collector = createCollector(model)
  return {
    collector,
    write(chunk) {
      return collector.push(chunk).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
    },
    end() {
      return 'data: [DONE]\n\n'
    },
  }
}

// OpenAI 口径 → AiRoute 统计口径。
// ⚠️ AiRoute 的 `input` 一直表示**未命中缓存**的输入（`usageTotal` 把四项相加），
// 而 OpenAI 的 `prompt_tokens` 含缓存 —— 直接塞进去会把命中部分算两遍。
function toStatUsage(usage) {
  if (!usage) return null
  const cached = count(usage.prompt_tokens_details?.cached_tokens)
  return {
    input: Math.max(0, count(usage.prompt_tokens) - cached),
    output: count(usage.completion_tokens),
    cacheRead: cached,
    cacheWrite: 0,
  }
}

module.exports = { createCollector, createStreamWriter, toOpenAiUsage, toStatUsage, finishReason }
