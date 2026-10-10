// 上游正文里的「模型原生工具调用标记」修复层
//
// 背景：上游最终由 DeepSeek 系模型出结果，它的工具调用原生语法不是 OpenAI 的
// JSON tool_calls，而是一段带全角竖线（两个 U+FF5C）分隔的标记文本：
//
//   <PIPE>DSML<PIPE> calls>
//   <PIPE>DSML<PIPE> invoke name="exec_command">
//   <PIPE>DSML<PIPE> parameter name="cmd" string="true">ls -la<PIPE>DSML<PIPE> parameter>
//   </PIPE>DSML<PIPE> invoke>
//   </PIPE>DSML<PIPE> calls>
//
// （上面用 <PIPE> 占位，真实分隔符见 MARKUP_PIPE 常量。）
//
// 上游只在请求**声明了 tools** 时才把这段标记解析成结构化 tool_calls。一旦某次请求
// 没带上 tools（客户端一次性 exec 探测、auto-review 复核回合、或任何 tools 中途丢失
// 的请求），模型仍然想调工具，于是这段标记以纯文本落进 content。下游没有任何一层
// 认识它：Codex 只执行 Responses API 的结构化 function_call 条目，于是把标记当成
// 普通助手文本写进会话历史，回合直接结束、工具一次都没跑。
//
// 本文件是最后一道防线：在出站响应（流式与非流式）里识别这段标记，还原成标准的
// tool_calls / delta.tool_calls。
//
// 判定分两级，因为「客户端声明了哪些工具」这件事在链路上并不可靠——最常见的泄漏
// 场景恰恰是 tools 声明在中转环节丢失，此时请求体里根本没有 tools 名单：
//   严格判定（名单非空）：块内每个 invoke 的工具名都必须在名单里。
//   弱判定（名单为空）：只要求块结构完美闭合、块内不夹带正文，且每个工具名形如
//   合法标识符（RE_TOOL_NAME）。
// 两级判定共同的硬性前提（任一不满足即原文透出）：
//   - 标记块完整闭合，块内除 invoke/parameter 与空白外没有夹带其他正文；
//   - 本回合上游没有给出任何结构化 tool_calls（不覆盖真实调用，非流式侧判定）；
//   - 非流式路径额外要求 finish_reason 为 stop。
// 任何一条不满足 → 原文原样透出。修复层绝不吞字节：所有「拿不准」的分支都走回吐。

// 模型原生工具调用标记的分隔符：两个全角竖线 U+FF5C
const MARKUP_PIPE = '\uFF5C\uFF5C'

// 标记块与内层元素的起止标记（结束标记一律比同名开始标记多一个 '/'）
const MARKUP_OPEN = `<${MARKUP_PIPE}DSML${MARKUP_PIPE} calls>`
const MARKUP_CLOSE = `</${MARKUP_PIPE}DSML${MARKUP_PIPE} calls>`
const MARKUP_INVOKE_CLOSE = `</${MARKUP_PIPE}DSML${MARKUP_PIPE} invoke>`
const MARKUP_PARAM_CLOSE = `</${MARKUP_PIPE}DSML${MARKUP_PIPE} parameter>`

// 全角竖线是正则元字符，构造正则前先转义
const MARKUP_TAG_PREFIX = escapeRegExp(`<${MARKUP_PIPE}DSML${MARKUP_PIPE}`)

// invoke 头：<PIPE>DSML<PIPE> invoke name="NAME">（第 1 捕获组为工具名）
const RE_INVOKE = new RegExp(`${MARKUP_TAG_PREFIX}\\s+invoke\\s+name="([^"]*)"\\s*>`)

// parameter 头：<PIPE>DSML<PIPE> parameter name="NAME" string="true">
// string 属性可选（缺省按 JSON 解析取值）；第 2 捕获组为 string 属性值
const RE_PARAM = new RegExp(`${MARKUP_TAG_PREFIX}\\s+parameter\\s+name="([^"]*)"(?:\\s+string="(true|false)")?\\s*>`)

// 工具名的合理形态：各家 SDK 的工具名一律是这种标识符。
// 弱判定（客户端没给出 tools 名单）时用它兜底，挡住模型在正文里「讨论」这段语法
// 时写出的 <tool_name>、NAME 之类占位符
const RE_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/

// 单次标记块的累积上限（近似字节数，按 UTF-16 码元计）。正常块从几百字节（一条 ls）
// 到几十 KB（一段 apply_patch）。超过上限仍未闭合 → 判定「这不是标记」，立即原文
// 回吐并退出块态，避免无限缓冲
const MARKUP_MAX_BLOCK_BYTES = 256 * 1024

// 正则元字符转义（等价 Go 的 regexp.QuoteMeta）
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// markupStartCandidate 返回 s 中最早的「可能是 MARKUP_OPEN 起点」的下标：该位置之后
// 要么正好是完整的 MARKUP_OPEN，要么是它的一个前缀（被增量边界截断）。没有候选返回 -1
function markupStartCandidate(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '<') continue
    const rest = s.slice(i)
    if (rest.length >= MARKUP_OPEN.length) {
      if (rest.startsWith(MARKUP_OPEN)) return i
      continue
    }
    if (MARKUP_OPEN.startsWith(rest)) return i
  }
  return -1
}

// parseMarkupParams 解析一个 invoke 内部的 parameter 列表，产出 JSON 对象文本
// string="true" 的取值按原文字符串处理（命令里的换行/引号/反斜杠原样保留）；
// 其余先按 JSON 解析，失败则退化为字符串——参数值永远不丢，最坏情况是类型不如模型本意；
// 无参数的工具产出 "{}"。返回 { value, ok }
function parseMarkupParams(body) {
  const args = {}
  let pos = 0
  for (;;) {
    const m = RE_PARAM.exec(body.slice(pos))
    if (!m) break
    if (body.slice(pos, pos + m.index).trim() !== '') return { value: '', ok: false } // parameter 之前夹带正文
    const name = m[1]
    const isString = m[2] === 'true'
    const valStart = pos + m.index + m[0].length
    const end = body.indexOf(MARKUP_PARAM_CLOSE, valStart)
    if (end < 0) return { value: '', ok: false } // parameter 未闭合
    const raw = body.slice(valStart, end)
    pos = end + MARKUP_PARAM_CLOSE.length
    if (isString) {
      args[name] = raw
      continue
    }
    try {
      args[name] = JSON.parse(raw.trim())
    } catch {
      args[name] = raw
    }
  }
  if (body.slice(pos).trim() !== '') return { value: '', ok: false } // 最后一个 parameter 之后夹带正文
  try {
    return { value: JSON.stringify(args), ok: true }
  } catch {
    return { value: '', ok: false }
  }
}

// parseMarkupBlock 解析 calls 块内部（外层起止标记之间的内容）。
// 成功要求：块内除 invoke 与空白外没有别的字节；每个 invoke 都闭合；每个 invoke 的
// 参数列表合法；工具名判定通过（名单非空走严格比对，名单为空走形态检查）。
// 任一不满足返回 { calls: null, ok: false }，由调用方原文回吐
function parseMarkupBlock(inner, allowed) {
  const strict = !!(allowed && allowed.size > 0)
  const out = []
  let pos = 0
  for (;;) {
    const m = RE_INVOKE.exec(inner.slice(pos))
    if (!m) break
    if (inner.slice(pos, pos + m.index).trim() !== '') return { calls: null, ok: false } // invoke 之前夹带了正文
    const name = m[1]
    const bodyStart = pos + m.index + m[0].length
    const end = inner.indexOf(MARKUP_INVOKE_CLOSE, bodyStart)
    if (end < 0) return { calls: null, ok: false } // invoke 未闭合
    const body = inner.slice(bodyStart, end)
    pos = end + MARKUP_INVOKE_CLOSE.length
    const args = parseMarkupParams(body)
    if (!args.ok) return { calls: null, ok: false }
    if (strict) {
      if (!allowed.has(name)) return { calls: null, ok: false } // 工具名不在客户端声明的 tools 里 → 不认，原文透出
    } else if (!RE_TOOL_NAME.test(name)) {
      return { calls: null, ok: false } // 名单缺失时的弱判定：名字不像工具名 → 不认，原文透出
    }
    out.push({ name, arguments: args.value })
  }
  if (out.length === 0) return { calls: null, ok: false }
  if (inner.slice(pos).trim() !== '') return { calls: null, ok: false } // 最后一个 invoke 之后夹带了正文
  return { calls: out, ok: true }
}

// createMarkupRepair 按客户端声明的工具名构造标记修复状态机（流式与非流式共用，
// 一条响应流一个实例）。allowed 为请求体里提取到的工具名集合（可能为 null——tools
// 声明在中转环节丢失是常态）；allowUnknown 为 true 时启用弱判定。
// 两者都为空/为 false → 修复器整体禁用（enabled() 为 false），feed 恒等透传
function createMarkupRepair(allowed, allowUnknown) {
  const names = allowed || null
  let hold = '' // 已确认可能属于标记、但还不足以判定的尾部缓冲
  let inBlock = false // 已消费掉 MARKUP_OPEN，正在块内部累积
  let seen = 0 // 识别到的标记块数（含被拒绝的）
  let rejected = 0 // 识别到但未转换的块数（观测/排障用）
  let converted = 0 // 已还原的调用数（观测用）

  // 修复器是否启用
  function enabled() {
    return !!(names && names.size > 0) || !!allowUnknown
  }

  // feed 吃进一段正文增量，返回 { text, calls }：text 为应当作为正文透出的部分，
  // calls 为还原出来的工具调用（按出现顺序转成 tool_call）。
  // 不变量：所有 feed 的入参拼接后，等于「所有返回的 text + flush() + 被成功转换的
  // 标记块原文」——除了被转换掉的标记块本身，一个字节都不会丢
  function feed(text) {
    if (!enabled()) return { text, calls: [] }
    let s = hold + text
    hold = ''
    let emit = ''
    const calls = []
    for (;;) {
      if (!inBlock) {
        const i = markupStartCandidate(s)
        if (i < 0) {
          emit += s
          break
        }
        if (s.length - i < MARKUP_OPEN.length) {
          // 起点被截断在增量边界（上游把标记切成了两片）：留到下一片再判定
          emit += s.slice(0, i)
          hold = s.slice(i)
          break
        }
        emit += s.slice(0, i)
        s = s.slice(i + MARKUP_OPEN.length)
        inBlock = true
        continue
      }
      const k = s.indexOf(MARKUP_CLOSE)
      if (k < 0) {
        if (s.length > MARKUP_MAX_BLOCK_BYTES) {
          // 超长未闭合：不是标记，原文回吐并退出块态
          emit += MARKUP_OPEN
          emit += s
          inBlock = false
          break
        }
        hold = s
        break
      }
      const inner = s.slice(0, k)
      s = s.slice(k + MARKUP_CLOSE.length)
      inBlock = false
      seen++
      const parsed = parseMarkupBlock(inner, names)
      if (parsed.ok) {
        for (const call of parsed.calls) calls.push(call)
        converted += parsed.calls.length
        continue
      }
      // 块内不是纯调用（夹带正文 / 工具名不合规 / 参数畸形）：原文回吐，绝不吞字节
      rejected++
      emit += MARKUP_OPEN
      emit += inner
      emit += MARKUP_CLOSE
    }
    return { text: emit, calls }
  }

  // flush 在响应流结束时调用：把仍未判定的尾部缓冲原文交还。未闭合的块连同起始
  // 标记一起回吐——上游发了什么就透出什么
  function flush() {
    if (!enabled()) return ''
    let out = hold
    if (inBlock) out = MARKUP_OPEN + hold
    hold = ''
    inBlock = false
    return out
  }

  return {
    enabled,
    feed,
    flush,
    converted: () => converted,
    seen: () => seen,
    rejected: () => rejected
  }
}

// toolNameAllowlist 从客户端请求体里收集「可用于判定工具调用」的工具名集合。
// 两个来源都要，因为二者会分别缺失：
//   1. 本请求声明的工具：OpenAI tools[].function.name、Responses 风格裸 tools[].name、
//      旧版 functions[].name。tools 声明在中转环节丢失是实测常态；
//   2. 会话历史里出现过的工具：messages[].tool_calls[].function.name 与旧版
//      messages[].function_call.name——多轮会话里这份名单几乎总在，且天然可信。
// 两个来源都为空 → 返回 null，由调用方决定是否启用弱判定；解析失败按空处理
function toolNameAllowlist(body) {
  let req
  try {
    req = JSON.parse(body)
  } catch {
    return null
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null
  const names = new Set()

  const tools = Array.isArray(req.tools) ? req.tools : []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const fnName = t.function && typeof t.function === 'object' ? t.function.name : ''
    if (typeof fnName === 'string' && fnName) {
      names.add(fnName)
      continue
    }
    if (typeof t.name === 'string' && t.name) names.add(t.name)
  }

  const functions = Array.isArray(req.functions) ? req.functions : []
  for (const f of functions) {
    if (f && typeof f === 'object' && typeof f.name === 'string' && f.name) names.add(f.name)
  }

  const messages = Array.isArray(req.messages) ? req.messages : []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : []
    for (const tc of tcs) {
      const fnName = tc && tc.function && typeof tc.function === 'object' ? tc.function.name : ''
      if (typeof fnName === 'string' && fnName) names.add(fnName)
    }
    const fc = m.function_call
    if (fc && typeof fc === 'object' && typeof fc.name === 'string' && fc.name) names.add(fc.name)
  }

  return names.size > 0 ? names : null
}

// markupCallID 生成一个形态接近 OpenAI 的 tool_call id（纳秒时间戳 + 序号，
// 保证同一条响应里多个调用的 id 互不相同）
function markupCallID(idx) {
  return `call_${process.hrtime.bigint()}_${idx}`
}

// markupMessageToolCalls 把还原出来的调用转成**非流式** message.tool_calls 数组。
// 非流式形态不带 index（index 是流式 delta 的分片归属标记）
function markupMessageToolCalls(calls) {
  return calls.map((call, i) => ({
    id: markupCallID(i),
    type: 'function',
    function: { name: call.name, arguments: call.arguments }
  }))
}

// markupToolCalls 把还原出来的调用转成**流式** delta.tool_calls 数组。
// base 是首个 index（流式路径用它避开上游已用过的 index）
function markupToolCalls(calls, base) {
  return calls.map((call, i) => ({
    index: base + i,
    id: markupCallID(base + i),
    type: 'function',
    function: { name: call.name, arguments: call.arguments }
  }))
}

// repairAggregatedResponse 在非流式聚合响应里把正文中的标记还原为 tool_calls。
// 只在「该 choice 没有结构化 tool_calls」且「finish_reason 为 stop」时生效：前者
// 保证不覆盖真实调用，后者保证正文没有被 max_tokens 截断。
// 返回本次使用的修复器，调用方据 converted()/seen()/rejected() 记观测
function repairAggregatedResponse(resp, allowed, allowUnknown) {
  const repair = createMarkupRepair(allowed, allowUnknown)
  if (!repair.enabled()) return repair
  const choices = resp && Array.isArray(resp.choices) ? resp.choices : null
  if (!choices) return repair
  for (const c of choices) {
    if (!c || typeof c !== 'object') continue
    const msg = c.message
    if (!msg || typeof msg !== 'object') continue
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue
    if (c.finish_reason !== 'stop') continue
    const text = typeof msg.content === 'string' ? msg.content : ''
    if (!text || !text.includes(MARKUP_PIPE)) continue
    const fed = repair.feed(text)
    const emit = fed.text + repair.flush()
    if (fed.calls.length === 0) continue
    msg.content = emit
    msg.tool_calls = markupMessageToolCalls(fed.calls)
    c.finish_reason = 'tool_calls'
  }
  return repair
}

module.exports = {
  MARKUP_PIPE,
  createMarkupRepair,
  toolNameAllowlist,
  repairAggregatedResponse,
  markupToolCalls,
  markupCallID
}
