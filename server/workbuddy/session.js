// 会话粘性路由：同一会话尽量复用同一账号，多轮对话不跳号

const crypto = require('crypto')

const DERIVED_KEY_PREFIX = 'd-' // 内容派生键前缀

// 从请求体提取会话键（6 步顺序，命中即返回）
function extractKey(body) {
  if (!body) return ''
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return ''
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''

  const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}

  const candidates = [
    meta.conversation_id,
    meta.conversationId,
    obj.conversation_id,
    obj.conversationId,
    obj.prompt_cache_key
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }

  // 派生回退：body 含 user 维度标识时抑制（粒度过粗）
  if (hasUserIDKey(meta, obj)) return ''
  return deriveKey(obj)
}

// metadata.user_id 或顶层 user_id 为非空字符串 → 抑制派生
function hasUserIDKey(meta, obj) {
  const a = meta?.user_id
  const b = obj?.user_id
  return (typeof a === 'string' && a.trim() !== '') || (typeof b === 'string' && b.trim() !== '')
}

// 内容回退哈希派生：sha256(systemText + \x00 + firstUserText) 前 16 字节
function deriveKey(obj) {
  const msgs = obj.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return ''

  let systemText = ''
  let firstUserText = ''
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const role = typeof m.role === 'string' ? m.role : ''
    if (role === 'system' || role === 'developer') {
      if (systemText === '') systemText = messageText(m.content)
    } else if (role === 'user') {
      if (firstUserText === '') firstUserText = contentSignature(m.content)
    }
    if (firstUserText !== '' && systemText !== '') break
  }
  if (firstUserText === '') return ''

  const sum = crypto
    .createHash('sha256')
    .update(`${systemText}\u0000${firstUserText}`)
    .digest('hex')
  return DERIVED_KEY_PREFIX + sum.slice(0, 32)
}

// 取消息文本（字符串直返；数组拼接 text part）
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (part && typeof part === 'object' && typeof part.text === 'string') out += part.text
  }
  return out
}

// FNV-1a 哈希取模（同一 key 稳定映射到同一下标）
function hashIndex(key, n) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % n
}

// ===== 会话头族 ID =====

// 消息级 ID：32 位 hex（UUID v4 去横线形态）
function newMessageId() {
  return crypto.randomBytes(16).toString('hex')
}

// 进程启动随机盐：派生值不可按外部可控键内容预计算；重启换新
const deriveSalt = newMessageId()

// 会话键 → 稳定 conversationRequestID：sha256(盐|键) 前 16 字节 hex；空键每次新值
function requestIdForKey(key) {
  if (!key) return newMessageId()
  return crypto.createHash('sha256').update(`${deriveSalt}|${key}`).digest('hex').slice(0, 32)
}

// 轮级键 → 聚合 ID：sha256(盐|键) 前 16 字节 hex；空键每次新值
function turnRequestId(turnKeyText) {
  if (!turnKeyText) return newMessageId()
  return crypto.createHash('sha256').update(`${deriveSalt}|${turnKeyText}`).digest('hex').slice(0, 32)
}

// 从请求体提取对话 ID（只认 conversationId，绝不回落 user_id）
function resolveConversationId(body) {
  if (!body) return ''
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return ''
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''
  const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}
  const candidates = [meta.conversation_id, meta.conversationId, obj.conversation_id, obj.conversationId]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

// 轮级聚合键：body 里最后一条 user 消息的「序号 + 内容签名」（无则空串）
function turnKey(body) {
  if (!body) return ''
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return ''
  }
  const msgs = Array.isArray(obj?.messages) ? obj.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || typeof m !== 'object' || m.role !== 'user') continue
    const sig = contentSignature(m.content)
    if (sig === '') return '' // 最后一条 user 无可签名内容：本轮不建键（不往前找，防键随 step 漂移）
    return `u${i}:${sig}`
  }
  return ''
}

// ===== 日志任务合并键（一次用户输入及其后续工具调用 = 一个任务）=====

// 任务合并键：会话段 + 轮段；任一段缺失时返回空串（无法可靠识别任务则不合并）
// 会话段：显式会话 ID → user_id 中 _session_ 段（Claude Code）→ 内容派生键
// 轮段：最近一条真实用户输入（跳过 tool_result 与注入块）的「序号 + 内容签名」
function extractTaskKey(body) {
  if (!body) return ''
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return ''
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''

  const sessionPart = taskSessionPart(obj)
  if (!sessionPart) return ''
  const turnPart = taskTurnPart(obj)
  if (!turnPart) return ''
  return `${sessionPart}\u0000${turnPart}`
}

// 会话段：显式会话 ID 优先；否则从 user_id 提取 _session_ 段；再退内容派生键
function taskSessionPart(obj) {
  const meta = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}
  const candidates = [
    meta.conversation_id,
    meta.conversationId,
    obj.conversation_id,
    obj.conversationId,
    obj.prompt_cache_key
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return `k:${c.trim()}`
  }

  const userId = [meta.user_id, obj.user_id].find(v => typeof v === 'string' && v.trim()) || ''
  const session = /_session_([A-Za-z0-9._-]+)/.exec(userId)
  if (session) return `s:${session[1]}`

  // 派生键本身已带 d- 前缀（与 extractKey 回退格式一致）
  return deriveKey(obj)
}

// 轮段：从后往前找最近一条非工具结果、非注入块的用户消息（工具循环/续写提醒中该消息稳定不变）
function taskTurnPart(obj) {
  const msgs = Array.isArray(obj.messages) ? obj.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || typeof m !== 'object' || m.role !== 'user') continue
    if (isToolResultContent(m.content)) continue
    if (isInjectedContent(m.content)) continue
    const sig = contentSignature(m.content)
    if (sig === '') return ''
    return `u${i}:${sig}`
  }
  return ''
}

// 工具结果消息：content 数组且每个 part 都是 tool_result / tool_use_result
function isToolResultContent(content) {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(
    part => part && typeof part === 'object' && (part.type === 'tool_result' || part.type === 'tool_use_result')
  )
}

// 原始文本拼接：字符串直返；数组只拼 text part；不抽取 <user_query> 也不截断（供注入块判定用）
function joinText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (part && typeof part === 'object' && typeof part.text === 'string') text += part.text
  }
  return text
}

// 客户端自动追加的上下文标签（非真实用户输入）：未闭合标签按「到结尾」处理
const INJECT_TAG_RE = /<(user_info|system_reminder|system-reminder|rules|additional_data|cb_summary|ide_opened_file|session)>[\s\S]*?(<\/\1>|$)/gi

// 剥离上下文标签块：闭合标签整块剔除，未闭合剥到结尾；残余部分才是用户真正输入
function stripInjectTags(text) {
  return text.replace(INJECT_TAG_RE, '')
}

// 注入块判定：整条 [System reminder: …]；含 <user_query> 一律视为真实提问；剥离上下文标签后无实义文本也算注入块
function isInjectedContent(content) {
  const text = joinText(content).trim()
  if (!text) return !hasImageIn(content) // 纯图片消息是真实输入（[图片]），空消息才算注入块
  if (/^\[system reminder:/i.test(text)) return true
  if (lastUserQuery(text) !== null) return false
  return stripInjectTags(text).trim() === ''
}

// 使用记录上限：超长输入只存前 1000 字符，避免日志文件被大段粘贴撑爆
const INPUT_TEXT_MAX = 1000

// 使用记录：最近一条真实用户输入（跳过工具结果与注入块）；无文本含图片 → [图片]；
// 含 <user_query>…</user_query> 包裹时只取最后一段内文（IDE 消息还带
// <user_info>/<rules>/<additional_data> 等大段上下文，避免记录被规则文本淹没）；
// 续写请求只有注入块时回退到更早的真实提问，一条都没有才记 [系统续写]
function extractInputText(body) {
  if (!body) return ''
  let obj
  try {
    obj = JSON.parse(body)
  } catch {
    return ''
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ''

  const msgs = Array.isArray(obj.messages) ? obj.messages : []
  let sawInjected = false // 是否跳过了注入块，用于区分「续写」与「压根没有用户消息」
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || typeof m !== 'object' || m.role !== 'user') continue
    if (isToolResultContent(m.content)) continue
    if (isInjectedContent(m.content)) {
      sawInjected = true
      continue
    }
    return buildInputText(m.content)
  }
  return sawInjected ? '[系统续写]' : ''
}

// 输入内容转文本：字符串直返；数组拼接 text part；含 <user_query> 时取内文（优先，避免未闭合标签误吞）；否则剥离注入块后记录残余实义文本（如 <system-reminder>…</system-reminder>\nhello 只留 hello）；无文本含图片时给占位
function buildInputText(content) {
  const text = joinText(content)
  if (!text.trim()) return hasImageIn(content) ? '[图片]' : ''
  if (lastUserQuery(text) !== null) return recordText(text)
  return stripInjectTags(text).trim().slice(0, INPUT_TEXT_MAX)
}

// content 是否含图片 part（无文本时用于 [图片] 占位）
function hasImageIn(content) {
  if (!Array.isArray(content)) return false
  return content.some(part => part && typeof part === 'object' && (part.type === 'image' || part.type === 'image_url'))
}

// 使用记录文本：优先取最后一段 <user_query>…</user_query> 内文；无该标签保留原文；统一截断
function recordText(text) {
  const tagged = lastUserQuery(text)
  const out = tagged !== null ? tagged.trim() : text
  return out.slice(0, INPUT_TEXT_MAX)
}

// 取最后一段 <user_query>…</user_query> 内文；没有任何标签时返回 null
function lastUserQuery(text) {
  const re = /<user_query>([\s\S]*?)<\/user_query>/g
  let last = null
  let m
  while ((m = re.exec(text)) !== null) last = m[1]
  return last
}

// 内容签名：字符串直返；数组拼接文本 part，非文本 part 入 [type:sha256前8hex] 短摘要
function contentSignature(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let buf = ''
  let hasNonText = false
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const type = typeof part.type === 'string' ? part.type : ''
    if (type === '' || type === 'text') {
      buf += typeof part.text === 'string' ? part.text : ''
      continue
    }
    hasNonText = true
    const digest = crypto.createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 8)
    buf += `\n[${type}:${digest}]\n`
  }
  return hasNonText ? buf.trim() : buf
}

// 创建会话黏性路由器
// opts: { ttl, gcInterval, available: (allowUIDs) => string[], availableForModel: (model, allowUIDs) => string[] }
function createRouter(opts = {}) {
  const ttl = opts.ttl > 0 ? opts.ttl : 30 * 60 * 1000
  const gcInterval = opts.gcInterval > 0 ? opts.gcInterval : 5 * 60 * 1000
  const entries = new Map() // key → { uid, lastActive }
  let timer = null

  // 候选 uid 列表（透传给注入回调）
  const availableList = (model, allowUIDs) => {
    if (model && typeof opts.availableForModel === 'function') return opts.availableForModel(model, allowUIDs) || []
    if (typeof opts.available === 'function') return opts.available(allowUIDs) || []
    return []
  }

  const expired = (e, now) => now - e.lastActive > ttl

  // 解析会话绑定账号：命中滚动续期；未命中分配（双段策略：优先空闲账号）
  // allowUIDs：账箱子集过滤（null/空 = 全池）
  function resolveForModel(key, model, allowUIDs) {
    if (!key) return { uid: '', ok: false }
    const now = Date.now()

    const e = entries.get(key)
    if (e && !expired(e, now)) {
      const avail = availableList(model, allowUIDs)
      if (avail.includes(e.uid)) {
        e.lastActive = now
        return { uid: e.uid, ok: true }
      }
    }

    const uids = availableList(model, allowUIDs)
    if (uids.length === 0) {
      entries.delete(key)
      return { uid: '', ok: false }
    }

    const bound = new Set([...entries.values()].map(v => v.uid))
    let candidatePool = uids.filter(u => !bound.has(u))
    if (candidatePool.length === 0) candidatePool = uids
    const uid = candidatePool[hashIndex(key, candidatePool.length)]

    entries.set(key, { uid, lastActive: now })
    return { uid, ok: true }
  }

  // 绑定会话到指定账号（请求成功后跟随最终成功号）
  function bind(key, uid) {
    if (!key || !uid) return
    entries.set(key, { uid, lastActive: Date.now() })
  }

  // 解绑（请求失败时让下次重新分配）
  function unbind(key) {
    if (!key) return false
    return entries.delete(key)
  }

  // 清理过期绑定
  function gcOnce() {
    const now = Date.now()
    let removed = 0
    for (const [key, e] of entries.entries()) {
      if (expired(e, now)) {
        entries.delete(key)
        removed++
      }
    }
    return removed
  }

  // 启动后台 GC（周期清理，幂等）
  function startGC() {
    if (timer) return
    timer = setInterval(gcOnce, gcInterval)
    if (timer.unref) timer.unref()
  }

  // 停止后台 GC
  function stopGC() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // 当前绑定数（观测用）
  function size() {
    return entries.size
  }

  return { resolveForModel, bind, unbind, gcOnce, startGC, stopGC, size }
}

module.exports = {
  extractKey,
  deriveKey,
  hashIndex,
  contentSignature,
  newMessageId,
  requestIdForKey,
  turnRequestId,
  turnKey,
  resolveConversationId,
  messageText,
  extractTaskKey,
  extractInputText,
  createRouter,
  DERIVED_KEY_PREFIX
}