// 一个「Auto」伪模型 + 若干档排序策略：让客户端在 /v1/models 里直接选「这条请求想怎么挑模型」。
//
// ## 为什么做成「模型列表里的假模型」
//
// 客户端的模型选择只有一个入口：/v1/models 返回的 id。Claude Code、Cursor、
// 各类 SDK 都没有「给 AiRoute 换个模型」的能力 —— 它们只能把某个 id 写进请求。
// 所以「按延迟挑 / 按性价比挑」这种策略，唯一不用改客户端就能用的形态，
// 就是让它看起来像一个模型。
//
// 伪模型只剩 `auto` 一个。原来是四档（auto / auto-fast / auto-cheap / auto-least-conn），
// 靠「客户端写哪个 id」来选策略 —— 但客户端往往只有一个模型名可填（写在 json / toml /
// yaml 里），改一次配置就多一次出错机会，而且四档同时出现在 /v1/models 里会让
// 某些客户端把列表第一项当默认值。现在策略改由「渠道账号 → 模型」页统一选，
// 客户端永远只需要填 `auto`。
//
// ## 为什么不塞进 state.current
//
// `state.current` 是给人用的全局开关，一次只能有一个值；策略是「这条请求想怎么
// 挑」，粒度小得多。混在一起的话，任何客户端只要带上 auto 就会把你在面板里
// 选的激活模型改掉，等于让客户端替人做决定。
//
// ## 数据从哪来
//
// 排序需要「哪家快、哪家便宜」，这两件事都没有静态来源：
// - 延迟只能实测。日志里每条都有 responseTime（含排队，但同口径可比），
//   取最近 200 次的中位数，避开长尾。
// - 成本优先用**真实消耗**（日志里的 credits 与 token 数），没有样本时退回
//   渠道包写在 displayName 里的倍率（`· x0.06`）与「· 免费」标记。
//   两种口径不同，但方向一致，用它们比大小是安全的 —— 都是「越便宜越小」。
//
// 冷启动（没有任何日志）时全部是未知，排序退化成配置顺序：不会把请求打乱。
//
// 并发优先是唯一不靠日志的一档：它看的是「此刻谁最闲」，
// 而日志只在请求结束后才有记录，所以那份计数由转发路径实时维护（见「在途计数」）。

const fs = require('fs-extra')
const path = require('path')
const paths = require('./paths')
const models = require('./models')

// 伪模型的 id 用纯 ASCII：它们会被客户端写进 json / toml / yaml，
// 中文和空格在那些格式里要转义，改一次配置就多一次出错机会。
const AUTO_MODELS = [
  { id: 'auto', strategy: 'balanced', name: 'Auto 自动路由（按当前策略挑模型）' }
]

// 四档排序策略。id 是落盘与接口里用的稳定标识，label 面向界面（tab 上的短名），
// note 是这一档在做什么（界面放在悬停提示里，不占版面）。
// 顺序即界面上的展示顺序：先综合，再按诉求分档。
const STRATEGIES = [
  { id: 'balanced', label: '综合', note: '延迟与成本等权' },
  { id: 'latency', label: '延迟优先', note: '挑最近跑得最快的' },
  { id: 'cost', label: '成本优先', note: '免费与低倍率先行' },
  { id: 'connections', label: '并发优先', note: '挑此刻在途最少的' }
]

const DEFAULT_STRATEGY = 'balanced'

// 界面上给出的一档与落盘里写的一档要对上：配置被手改过或来自旧版本时，
// 拿到一个不认识的 id 就退回默认档，而不是让排序逻辑走空。
function normalizeStrategy(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  return STRATEGIES.some(item => item.id === id) ? id : DEFAULT_STRATEGY
}

function listStrategies() {
  return STRATEGIES.map(item => ({ id: item.id, label: item.label, note: item.note }))
}

// 策略落在 server-config.json 里：它已经是「网关自身的行为配置」（端口等），
// 放这里不用再加一份数据文件，导入导出也自动带上。
const STRATEGY_KEY = 'autoStrategy'

function readServerConfig() {
  const file = paths.getServerConfigPath()
  if (!fs.existsSync(file)) return {}
  try {
    const data = fs.readJsonSync(file)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

// 读取当前策略。配置缺失、被手改坏或来自旧版本时都退回默认档。
function getStrategy() {
  return normalizeStrategy(readServerConfig()[STRATEGY_KEY])
}

function saveStrategy(value) {
  const id = normalizeStrategy(value)
  const config = readServerConfig()
  config[STRATEGY_KEY] = id
  fs.writeJsonSync(paths.getServerConfigPath(), config, { spaces: 2 })
  return id
}

const CANDIDATE_LIMIT = 4 // 一次请求最多按顺序试几个模型：再长就不是「挑模型」而是硬扛故障了
const STATS_TTL_MS = 60 * 1000 // 日志扫描结果的缓存时长
const SCAN_FILES = 2 // 只看最近两份日志（今天 + 昨天）
const SCAN_LINES_PER_FILE = 4000
const LATENCY_SAMPLES = 200 // 每个模型保留的延迟样本数（中位数足够稳，多了只是白占内存）
const UNKNOWN_LATENCY_MS = 5000 // 从没跑过的模型：按「比已知的都慢」处理，但没慢到不可用
const UNKNOWN_COST = 1 // 没有倍率也没有实测：按渠道包的 x1.0 基准
const HOPELESS_FAIL_RATE = 0.5 // 近期失败率过半且样本够多 → 排到最后，但仍保留在链上
const HOPELESS_MIN_ATTEMPTS = 3
const FREE_RE = /·\s*免费/
const MULTIPLE_RE = /·\s*x\s*([\d.]+)/i
const LOG_FILE_RE = /^usage(-\d{4}-\d{2}-\d{2})?\.log$/

function isAutoId(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return AUTO_MODELS.some(item => item.id === id)
}

// 思考档位的先后次序：与上游一致，从「关」到「最强」。
// 声明给客户端时按这个顺序排，客户端把它当强度列表展示才不会乱。
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// 把若干「档位数组」并成一个有序去重列表；一个有效项都没有时返回空数组
// （空数组 = 不声明，交给调用方决定要不要给兜底四档）
function unionEfforts(lists) {
  const seen = new Set()
  for (const list of Array.isArray(lists) ? lists : []) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const effort = typeof item === 'string' ? item.trim() : ''
      if (effort) seen.add(effort)
    }
  }
  if (seen.size === 0) return []
  const known = EFFORT_ORDER.filter(item => seen.has(item))
  const extra = [...seen].filter(item => !EFFORT_ORDER.includes(item)).sort()
  return [...known, ...extra]
}

// OpenAI 形态的模型条目：多带 name/description 两个字段，
// 能读到它们的客户端（面板式客户端不少）就能看到中文说明，读不到的只显示 id 也不出错。
// reasoning_supported_efforts 是本网关额外声明的思考档位（客户端据此渲染档位选择器）。
function listAutoModels(reasoningEfforts) {
  const efforts = Array.isArray(reasoningEfforts) && reasoningEfforts.length ? reasoningEfforts : []
  return AUTO_MODELS.map(item => ({
    id: item.id,
    object: 'model',
    created: 0,
    owned_by: 'airoute',
    name: item.name,
    description: item.name,
    // 没有档位数据时宁可少声明，也不给一个客户端会照单全收的假能力
    ...efforts.length ? { reasoning_supported_efforts: efforts.slice() } : {}
  }))
}

function median(list) {
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

// ==================== 日志采样 ====================

let cache = { at: 0, stats: new Map() }

function accumulate(stats, entry) {
  const ref = entry && entry.model
  if (!ref) return
  let stat = stats.get(ref)
  if (!stat) {
    stat = { ok: 0, fail: 0, latencies: [], credits: 0, tokens: 0, costSamples: 0 }
    stats.set(ref, stat)
  }

  const ok = entry.status === 200 && !entry.error
  if (ok) {
    stat.ok++
    if (entry.responseTime > 0) {
      stat.latencies.push(entry.responseTime)
      if (stat.latencies.length > LATENCY_SAMPLES) stat.latencies.shift()
    }
  } else {
    stat.fail++
  }

  // 成本只统计「上游真的报了 credits」的样本：`0` 是有效值（免费），
  // 字段缺失才是没数据 —— 两者混为一谈会把付费模型算成免费
  if (typeof entry.credits === 'number') {
    const tokens = Number(entry.totalTokens) || 0
    if (tokens > 0) {
      stat.credits += entry.credits
      stat.tokens += tokens
      stat.costSamples++
    }
  }
}

function readStats() {
  const now = Date.now()
  if (now - cache.at < STATS_TTL_MS) return cache.stats

  const stats = new Map()
  try {
    const dir = paths.getLogDir()
    const files = fs.readdirSync(dir)
      .filter(name => LOG_FILE_RE.test(name))
      .sort()
      .reverse()
      .slice(0, SCAN_FILES)
    for (const name of files) {
      const lines = fs.readFileSync(path.join(dir, name), 'utf-8').split('\n')
      const start = Math.max(0, lines.length - SCAN_LINES_PER_FILE)
      for (let i = start; i < lines.length; i++) {
        const line = lines[i]
        if (!line) continue
        try {
          accumulate(stats, JSON.parse(line))
        } catch {
          // 坏行（写了一半就断电）跳过：统计不值得为一行脏数据整体失败
        }
      }
    }
  } catch {
    // 读不到日志就当作「没有任何实测」，排序退化成配置顺序
  }

  cache = { at: now, stats }
  return stats
}

// 清缓存：写测试用，跑完不用等 TTL
function resetStatsCache() {
  cache = { at: 0, stats: new Map() }
}

// ==================== 在途计数（最小连接）====================

// 「此刻有多少请求在跑」没有任何静态来源：日志只在请求结束后才有一行。
// 所以这份计数只能由转发路径实时维护——派发给某个候选时 +1，换下一个候选
// 或整个请求收尾时 -1。进程内的 Map 够用：AiRoute 是单进程本地服务，
// 不存在「多台均衡器各看一半连接数」那种误差。
const inflight = new Map()

// 返回释放函数，而不是让调用方自己配一次 -1：转发路径上散落着一堆 return /
// continue，把「谁加谁减」绑在一起才漏不掉，而漏减的后果是某个候选永远显得忙。
function beginAttempt(ref) {
  if (!ref) return () => {}
  inflight.set(ref, (inflight.get(ref) || 0) + 1)
  let released = false
  return () => {
    if (released) return // 收尾路径（next 候选 / res close）都会调，重复释放会把计数塌成负数
    released = true
    const next = (inflight.get(ref) || 0) - 1
    if (next > 0) inflight.set(ref, next)
    else inflight.delete(ref) // 落到 0 就删键，避免 Map 随着历史模型无限长
  }
}

function getInFlight(ref) {
  return inflight.get(ref) || 0
}

// 清计数：写测试用
function resetInFlight() {
  inflight.clear()
}

// ==================== 打分 ====================

// 单个模型的成本估算：实测口径优先，其次配置里的倍率，最后按 1.0 兜底。
// 返回值越小越便宜，`0` 表示免费。
function costOf(model, stat) {
  if (stat && stat.costSamples > 0 && stat.tokens > 0) {
    return stat.credits / (stat.tokens / 1000)
  }
  const text = `${model.displayName || ''} ${model.name || ''}`
  if (FREE_RE.test(text)) return 0
  const matched = MULTIPLE_RE.exec(text)
  if (matched) {
    const value = Number(matched[1])
    if (Number.isFinite(value)) return value
  }
  return UNKNOWN_COST
}

function scoreOf(entry, stats) {
  const stat = stats.get(entry.ref) || null
  const ok = stat ? stat.ok : 0
  const fail = stat ? stat.fail : 0
  const attempts = ok + fail
  const failRate = attempts ? fail / attempts : 0
  const latency = stat && stat.latencies.length ? median(stat.latencies) : null
  const cost = costOf(entry.model, stat)

  return {
    entry,
    attempts,
    failRate,
    latency,
    cost,
    // 失败惩罚乘在两项指标上：一个刚被限流的免费模型，不该因为「免费」被一直选中
    latencyKey: (latency === null ? UNKNOWN_LATENCY_MS : latency) * (1 + 2 * failRate),
    costKey: cost * (1 + 2 * failRate),
    // 实时在途数：唯一不来自日志的指标
    conn: getInFlight(entry.ref),
    // 同分时的次序（目前只有并发优先用）：留 0 让其它策略保持「同分即配置顺序」
    tie: 0,
    hopeless: attempts >= HOPELESS_MIN_ATTEMPTS && failRate >= HOPELESS_FAIL_RATE ? 1 : 0
  }
}

// 把某一项指标线性归一化到 0..1，让「毫秒」和「倍率」这两种量纲能相加
function normalizer(list, field) {
  const values = list.map(item => item[field])
  const min = Math.min(...values)
  const max = Math.max(...values)
  return item => (max > min ? (item[field] - min) / (max - min) : 0)
}

/**
 * 按策略给候选模型排序。
 *
 * @param {Array} refs models.listModelRefs(config) 的结果
 * @param {string} strategy 'latency' | 'cost' | 'balanced' | 'connections'
 * @param {Map} stats readStats() 的结果
 * @returns {Array} 按尝试顺序排好的 [{ entry, ... }]
 */
function rankCandidates(refs, strategy, stats) {
  const scored = refs.map(entry => scoreOf(entry, stats))

  if (strategy === 'balanced') {
    // 等权：两项各自归一化之后相加。量纲不同（毫秒 vs 倍率）不能直接加，
    // 归一化之后「相对更快的」与「相对更便宜的」才是同一把尺子
    const lat = normalizer(scored, 'latencyKey')
    const cost = normalizer(scored, 'costKey')
    for (const item of scored) item.key = 0.5 * lat(item) + 0.5 * cost(item)
  } else if (strategy === 'cost') {
    for (const item of scored) item.key = item.costKey
  } else if (strategy === 'connections') {
    // 在途最少的先试。绝大多数时候只有一个客户端在跑、人人都是 0，
    // 这时按延迟分先后（等价于延迟优先档）——否则空闲系统里的顺序会退化成配置顺序，
    // 而配置顺序与「谁更快」无关
    for (const item of scored) {
      item.key = item.conn
      item.tie = item.latencyKey
    }
  } else {
    for (const item of scored) item.key = item.latencyKey
  }

  // hopeless 先沉底，再按指标，最后按同分次序；Array#sort 稳定，全平手时保留配置顺序
  scored.sort((a, b) => a.hopeless - b.hopeless || a.key - b.key || a.tie - b.tie)
  return scored
}

/**
 * 给 auto 伪模型生成这次请求的尝试链。
 * 尾巴上按配置的兜底模型补一位 —— 用户显式配了「主模型挂了用哪个」，
 * 策略挑了 4 个都挂的时候没理由把它丢掉。
 */
function buildChain(config, strategy, fallbackRef) {
  const refs = models.listModelRefs(config)
  if (!refs.length) return []

  const ranked = rankCandidates(refs, normalizeStrategy(strategy), readStats())
  const chain = []
  const seen = new Set()
  for (const item of ranked) {
    if (chain.length >= CANDIDATE_LIMIT) break
    const resolved = models.resolveRef(config, item.entry.ref)
    if (!resolved) continue
    seen.add(resolved.ref)
    chain.push(resolved)
  }

  if (fallbackRef && !seen.has(fallbackRef)) {
    const resolved = models.resolveRef(config, fallbackRef)
    if (resolved) chain.push(resolved)
  }
  return chain
}

module.exports = {
  AUTO_MODELS,
  STRATEGIES,
  DEFAULT_STRATEGY,
  EFFORT_ORDER,
  unionEfforts,
  isAutoId,
  listAutoModels,
  listStrategies,
  normalizeStrategy,
  getStrategy,
  saveStrategy,
  rankCandidates,
  buildChain,
  beginAttempt,
  getInFlight,
  resetInFlight,
  readStats,
  resetStatsCache,
  median,
  costOf
}
