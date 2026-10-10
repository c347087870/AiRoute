// WorkBuddy 模型目录兜底链：上下文窗口 / 输出上限 / 思考档位
//
// 查找链（上游动态值永远权威）：
//  1. 上游动态值（maxInputTokens / maxOutputTokens）——权威，压过静态种子表与 model.json；
//  2. 静态种子表（本文件 CONTEXT_SEED，编译期兜底——context 是模型固有属性）；
//  3. model.json 本地缓存（数据目录；读失败/损坏静默降级）；
//  4. models.dev 按需拉取（异步、不阻塞本次；命中进程内索引则写入 model.json 供下次命中）；
//
// context_length 未收录 → 1M 兜底（宁可高估不低估）；
// max_output_tokens 未收录 → 省略（返回 null，不编造输出上限）。
// effort 档位：上游 supportedEfforts 非空时权威，否则取静态分表，缺省空数组（不降级）。

const fs = require('fs')
const path = require('path')
const C = require('./constants')
const modelsdev = require('./modelsdev')

// 全链未收录模型的 context_length 兜底：1M
const DEFAULT_CONTEXT_WINDOW = 1000000

// 上下文窗口 / 输出上限静态种子表
// context 必为正；maxOutput 为 0 表示输出上限未知（省略不编造）
const CONTEXT_SEED = {
  // ---- GLM 家族（z-ai）----
  'glm-5.2': { context: 1000000, maxOutput: 131072 }, // 实测（CN 1M；models.dev 共识 1M/131072）
  'glm-5.1': { context: 200000, maxOutput: 131072 }, // 实测（CN 200K；models.dev 共识 200K/131072）
  'glm-5.3': { context: 1000000, maxOutput: 131072 }, // 实测外推 + models.dev 共识 1M/131072
  'glm-5.3-flash': { context: 1000000, maxOutput: 131072 }, // models.dev 共识 1M/131072
  'glm-5v-turbo': { context: 200000, maxOutput: 131072 }, // 实测（CN 200K；models.dev 共识 200K/131072）

  // ---- Kimi 家族（moonshot）----
  'kimi-k2.7': { context: 256000, maxOutput: 65536 }, // 实测（CN 256K）；输出同族估算
  'kimi-k2.6': { context: 256000, maxOutput: 262144 }, // 实测（CN 256K）；输出 models.dev 官方 262144
  'kimi-k2.5': { context: 164000, maxOutput: 262144 }, // 实测外推；输出共识 262144
  'kimi-k3': { context: 1048576, maxOutput: 131072 }, // models.dev 官方（moonshotai 1M/128K）
  'kimi-k2.8-preview': { context: 1048576, maxOutput: 0 }, // models.dev（1M；输出未收录，省略）

  // ---- MiniMax / 混元（tencent）----
  'minimax-m3': { context: 512000, maxOutput: 512000 }, // 实测（CN 512K）；输出共识 512000
  hy3: { context: 192000, maxOutput: 64000 }, // 实测（CN 192K/64K）
  'hy3-preview': { context: 262144, maxOutput: 64000 }, // models.dev（共识 262144/64000）
  'hy4-preview': { context: 1000000, maxOutput: 64000 }, // 实测外推 + models.dev（~1M/64000）
  'hy4-preview-x': { context: 1000000, maxOutput: 64000 }, // 实测外推（1M）；输出同族估算

  // ---- DeepSeek 家族 ----
  'deepseek-v4-pro': { context: 1000000, maxOutput: 384000 }, // 实测（CN 1M；共识 1M/384000）
  'deepseek-v4-flash': { context: 1000000, maxOutput: 384000 }, // 实测（CN 1M；共识 1M/384000）
  'deepseek-v4.1-flash': { context: 1000000, maxOutput: 384000 } // 实测外推 + models.dev 共识
}

// 思考档位静态兜底表
const CN_EFFORT_SEED = {
  'deepseek-v4-flash': { efforts: ['low', 'high', 'max'] },
  'deepseek-v4.1-flash': { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'deepseek-v4-pro': { efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' },
  'hy4-preview': { efforts: ['high'], defaultEffort: 'high' },
  'hy4-preview-x': { efforts: ['high'] },
  hy3: { efforts: ['low', 'high'], defaultEffort: 'high' },
  'hy3-x': { efforts: ['low', 'high'], defaultEffort: 'high' },
  'glm-5.3': { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'glm-5.3-flash': { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'glm-5.2': { efforts: ['high', 'xhigh'], defaultEffort: 'high' },
  'glm-5.1': { efforts: ['medium'] },
  'glm-5v-turbo': { efforts: ['medium'] },
  'kimi-k3-1': { efforts: ['medium'] },
  'kimi-k2.7': { efforts: ['medium'] },
  'kimi-k2.6': { efforts: ['medium'] },
  'minimax-m3': { efforts: ['medium'] }
}

// model.json 缓存单例状态（纯函数 + 模块级缓存）
const cache = {
  dir: '', // 数据目录（configure 注入；空 = 不落盘，纯内存）
  loadedDir: null, // 已加载对应的目录（目录变更时重载）
  loaded: false, // entries 是否已初始化
  entries: {} // modelId -> { context_length, max_output_tokens, ... }
}

// 数值归一：非法/NaN 一律 0
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

// 条目校验：context 正数 + 输出非负
function validEntry(e) {
  return !!e && num(e.context_length) > 0 && num(e.max_output_tokens) >= 0
}

// 解析本次使用的数据目录（opts.dataDir 可覆盖；否则用模块级注入的目录）
function resolveDir(opts) {
  const over = opts && opts.dataDir
  return String(over || cache.dir || '')
}

// 确保 model.json 已加载（目录变更即重载；读失败/损坏/非法条目静默降级）
function ensureLoaded(dir) {
  if (cache.loaded && cache.loadedDir === dir) return
  cache.entries = {}
  cache.loadedDir = dir
  cache.loaded = true
  if (!dir) return
  let raw
  try {
    raw = fs.readFileSync(path.join(dir, C.MODEL_CATALOG_FILE), 'utf8')
  } catch {
    return // 文件不存在 / 不可读 → 空缓存（静默）
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return // 整体损坏 → 空缓存（静默降级到种子表 / 1M）
  }
  if (!doc || typeof doc !== 'object') return
  for (const id of Object.keys(doc)) {
    if (validEntry(doc[id])) cache.entries[id] = doc[id]
  }
}

// 第 3 级：查 model.json 缓存（只读内存；加载已由 ensureLoaded 完成）
function cacheGet(modelId, opts) {
  ensureLoaded(resolveDir(opts))
  const e = cache.entries[modelId]
  return validEntry(e) ? e : null
}

// 第 4 级回流：把 models.dev 命中值写入缓存并落盘（tmp + rename 原子；失败静默）
function cachePut(modelId, context, maxOutput, opts) {
  if (!modelId || !(context > 0) || !(maxOutput >= 0)) return
  const dir = resolveDir(opts)
  ensureLoaded(dir)
  cache.entries[modelId] = {
    context_length: context,
    max_output_tokens: maxOutput,
    fetched_at: new Date().toISOString(),
    source: 'modelsdev'
  }
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, C.MODEL_CATALOG_FILE)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache.entries, null, 2))
    fs.renameSync(tmp, target)
  } catch {
    /* 落盘失败静默：内存缓存仍生效 */
  }
}

// 注入数据目录（runtime 启动时调用；变更即触发下次重载）
function configure(opts = {}) {
  if (typeof opts.dataDir === 'string') {
    cache.dir = opts.dataDir
    cache.loaded = false
    cache.loadedDir = null
  }
}

// 测试隔离：清空缓存与目录
function resetForTest() {
  cache.dir = ''
  cache.loadedDir = null
  cache.loaded = false
  cache.entries = {}
}

// 取静态档位条目（未命中返回空对象）
function staticEffortCap(modelId) {
  return CN_EFFORT_SEED[String(modelId || '')] || {}
}

// ===== 对外 API（四级查找链）=====

// context_length 决策：上游值 → 种子表 → model.json → models.dev（异步）→ 1M 兜底
function contextWindowOf(modelId, upstreamValue, opts) {
  const remote = num(upstreamValue)
  if (remote > 0) return remote
  const id = String(modelId || '')
  if (!id) return DEFAULT_CONTEXT_WINDOW
  const seed = CONTEXT_SEED[id]
  if (seed && seed.context > 0) return seed.context
  const cached = cacheGet(id, opts)
  if (cached) return cached.context_length
  const hit = modelsdev.lookup(id)
  if (hit && hit.context > 0) {
    cachePut(id, hit.context, hit.output, opts)
    return hit.context
  }
  return DEFAULT_CONTEXT_WINDOW
}

// max_output_tokens 决策：上游值 → 种子表 → model.json → models.dev（异步）→ 省略（null）
function outputTokensOf(modelId, upstreamValue, opts) {
  const remote = num(upstreamValue)
  if (remote > 0) return remote
  const id = String(modelId || '')
  if (!id) return null
  const seed = CONTEXT_SEED[id]
  if (seed && seed.maxOutput > 0) return seed.maxOutput
  const cached = cacheGet(id, opts)
  if (cached && num(cached.max_output_tokens) > 0) return num(cached.max_output_tokens)
  const hit = modelsdev.lookup(id)
  if (hit && hit.output > 0) {
    cachePut(id, hit.context, hit.output, opts)
    return hit.output
  }
  return null
}

// 思考档位决策：上游 supportedEfforts 非空时权威；否则取静态分表；缺省空数组（不降级）
function supportedEffortsOf(modelId, upstreamValue) {
  const up = Array.isArray(upstreamValue) ? upstreamValue.filter(v => typeof v === 'string' && v) : []
  if (up.length) return up.slice()
  const cap = staticEffortCap(modelId)
  return Array.isArray(cap.efforts) ? cap.efforts.slice() : []
}

// 默认档决策：与档位同源（上游有档位用上游默认档，静态兜底用静态默认档），
// 仅在「档位非空且默认档命中成员」时返回，否则空串（不宣称不支持的默认档）
function defaultEffortOf(modelId, upstreamEfforts, upstreamDefault) {
  const up = Array.isArray(upstreamEfforts) ? upstreamEfforts.filter(v => typeof v === 'string' && v) : []
  const cap = staticEffortCap(modelId)
  const efforts = up.length ? up : Array.isArray(cap.efforts) ? cap.efforts : []
  const def = up.length ? String(upstreamDefault || '') : String(cap.defaultEffort || '')
  if (!efforts.length || !def) return ''
  return efforts.includes(def) ? def : ''
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_SEED,
  configure,
  resetForTest,
  contextWindowOf,
  outputTokensOf,
  supportedEffortsOf,
  defaultEffortOf
}