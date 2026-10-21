// 通用 Provider 的模型清单探测：用 URL + Key 直接问上游要 /models
// 只在「新增/编辑 Provider 表单」里用，不参与请求代理，也不落盘任何配置

const axios = require('axios')
const modelsdev = require('./workbuddy/modelsdev')

// 单次探测超时：聚合网关冷启动较慢，给足 10s，但连续探测多个候选端点时逐个串行
const FETCH_TIMEOUT_MS = 10000

// 上限补全最多等多久：models.dev 首次拉取是后台异步的，这里限时等待，
// 超时则本次不补（下次点击时索引已缓存），不拖慢拉取按钮的响应
const LIMIT_WAIT_MS = 2500

// 单次返回的模型数量上限：防止异常网关吐出巨型列表撑爆前端
const MAX_MODELS = 5000

// 非对话模型识别（保守黑名单：只拦语义明确的非对话族）
// 宁可漏过（可在「显示全部」里看到），也不误杀 chat 模型：不匹配 -vision / -vl / -audio 这类歧义命名
const NON_CHAT_HINTS = [
  /embed/i,
  /rerank/i,
  /whisper|transcri|\basr\b/i,
  /\btts\b|text-to-speech|speech/i,
  /moderation/i,
  /dall-?e|gpt-image|stable-diffusion|sdxl|\bflux\b|midjourney/i,
  /\bveo\b|\bsora\b|kling|hailuo|\bvideo\b/i,
  /\bocr\b/
]

// 去掉首尾空白与结尾斜杠，避免拼出 //models
function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

// 识别 token 是否为非对话模型（embedding / 语音 / 图像 / 视频 / 重排等）
function isChatModel(id) {
  const text = String(id || '')
  if (!text) return false
  return !NON_CHAT_HINTS.some(re => re.test(text))
}

// 生成待探测的模型端点列表（按优先级：先 OpenAI 协议，再 Anthropic 协议）
// 两种协议各取第一个成功的端点；同一协议内的多个候选按顺序回退
function listCandidates(input) {
  const out = []
  const push = (url, protocol) => {
    if (!url) return
    if (out.some(c => c.url === url)) return
    out.push({ url, protocol })
  }

  const openai = trimUrl(input && input.openaiURL)
  if (openai) {
    // 容错：用户可能直接粘贴了完整的 chat/completions 地址
    const base = openai.replace(/\/chat\/completions$/i, '')
    push(base.endsWith('/models') ? base : `${base}/models`, 'openai')
  }

  const base = trimUrl(input && input.baseURL)
  if (base) {
    if (base.endsWith('/models')) {
      push(base, 'anthropic')
    } else if (/\/v1$/i.test(base)) {
      // 已自带 /v1（如 https://api.anthropic.com/v1），不要再拼一层
      push(`${base}/models`, 'anthropic')
    } else {
      // Anthropic 官方路径是 {base}/v1/models；部分网关只暴露 {base}/models，作为回退
      push(`${base}/v1/models`, 'anthropic')
      push(`${base}/models`, 'anthropic')
    }
  }

  return out
}

// 探测用的请求头：Bearer 与 x-api-key 同时带（聚合网关两种鉴权方式混用，多带一个不会报错）
function headersFor(protocol, apiKey) {
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey
  }
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01'
  return headers
}

// 从一条模型记录里取 ID：兼容 OpenAI(id) / Ollama(name) / 部分网关(model|slug)
function pickId(item) {
  if (typeof item === 'string') return item.trim()
  if (!item || typeof item !== 'object') return ''
  for (const key of ['id', 'model', 'name', 'slug']) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// 从一条模型记录里取展示名：与 ID 相同时视为没有（避免前端出现重复两行）
function pickDisplayName(item, id) {
  if (!item || typeof item !== 'object') return ''
  for (const key of ['display_name', 'displayName', 'label', 'name']) {
    const value = typeof item[key] === 'string' ? item[key].trim() : ''
    if (value && value !== id) return value
  }
  return ''
}

// 归一化单条记录，无 ID 的丢弃
function normalizeEntry(item) {
  const id = pickId(item)
  if (!id) return null
  return { id, displayName: pickDisplayName(item, id) }
}

// 取响应里的模型数组：兼容 { data: [] } / { models: [] } / { result: [] } / { items: [] } / 裸数组
function extractList(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  for (const key of ['data', 'models', 'result', 'items']) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  return []
}

// 把上游错误翻译成可读文案
function describeError(err) {
  const status = err && err.status
  if (status === 401 || status === 403) return `鉴权失败（${status}）：API Key 无效或无权限`
  if (status === 404) return '该地址没有 /models 接口'
  if (status === 429) return '请求过于频繁（429），请稍后再试'
  const code = (err && err.code) || ''
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return '请求超时'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名无法解析'
  if (code === 'ECONNREFUSED') return '连接被拒绝'
  if (status) return `上游返回 ${status}`
  return (err && err.message) || '请求失败'
}

// 探测单个端点：拿到模型数组，或抛出带 status 的错误
async function probe(candidate, apiKey) {
  const res = await axios.get(candidate.url, {
    headers: headersFor(candidate.protocol, apiKey),
    timeout: FETCH_TIMEOUT_MS,
    // 自行判断状态码，便于给出「没有 /models 接口」这类精确文案
    validateStatus: () => true,
    responseType: 'json',
    maxContentLength: 8 << 20
  })

  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }

  const list = extractList(res.data)
    .map(normalizeEntry)
    .filter(Boolean)
  if (!list.length) throw new Error('接口返回了空模型列表')
  return list
}

// 汇总失败原因：全部是鉴权错时合并成一条，否则取前两条不同文案
function summarizeFailures(failures) {
  if (!failures.length) return '未找到可用的 /models 端点'
  const authOnly = failures.every(f => f.status === 401 || f.status === 403)
  if (authOnly) return failures[0].error
  const unique = []
  for (const f of failures) {
    if (!unique.includes(f.error)) unique.push(f.error)
    if (unique.length >= 2) break
  }
  return unique.join('；')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 用 models.dev 索引补上下文 / 输出上限（命中即填，未命中保持 null）
// 索引首次不可用时最多等 LIMIT_WAIT_MS：等不到就留空，不阻塞拉取结果
async function enrichLimits(list) {
  if (!modelsdev.isFresh()) {
    try {
      await Promise.race([modelsdev.fetchCatalog(), delay(LIMIT_WAIT_MS)])
    } catch {
      // 目录拉取失败不影响模型列表本身
    }
  }
  for (const model of list) {
    const hit = modelsdev.lookup(model.id)
    if (!hit) continue
    if (hit.context > 0) model.maxContext = hit.context
    if (hit.output > 0) model.maxOutput = hit.output
  }
}

// 主入口：探测模型清单
// 返回 { ok:true, models, sources } 或 { ok:false, error, failures }
async function fetchModels(input) {
  const apiKey = String((input && input.apiKey) || '').trim()
  if (!apiKey) return { ok: false, error: '请先填写 API Key' }

  const candidates = listCandidates(input || {})
  if (!candidates.length) return { ok: false, error: '请至少填写一个端点 URL' }

  const models = []
  const seen = new Set()
  const sources = []
  const failures = []
  const doneProtocols = new Set()

  for (const candidate of candidates) {
    // 同一协议只要首个端点成功就够，其余候选跳过（避免对同一上游重复请求）
    if (doneProtocols.has(candidate.protocol)) continue
    try {
      const list = await probe(candidate, apiKey)
      doneProtocols.add(candidate.protocol)
      sources.push(candidate.protocol)
      for (const item of list) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        models.push(item)
      }
    } catch (err) {
      const status = err && err.status
      failures.push({ url: candidate.url, status, error: describeError(err) })
      // 401/403 说明端点存在但鉴权失败：换路径重试没有意义，还会混入误导性的 404
      if (status === 401 || status === 403) doneProtocols.add(candidate.protocol)
    }
  }

  if (!models.length) {
    return { ok: false, error: summarizeFailures(failures), failures }
  }

  // 截断并标记对话/非对话，前端据此做默认过滤
  const capped = models.slice(0, MAX_MODELS)
  for (const model of capped) model.chat = isChatModel(model.id)

  await enrichLimits(capped)

  return { ok: true, models: capped, sources, count: capped.length }
}

module.exports = {
  fetchModels,
  listCandidates,
  normalizeEntry,
  extractList,
  isChatModel,
  describeError,
  headersFor,
  MAX_MODELS
}
