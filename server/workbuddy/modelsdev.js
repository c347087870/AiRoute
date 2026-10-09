// WorkBuddy 模型目录兜底第 4 级：models.dev 聚合目录按需拉取
// 翻译自参考项目 internal/upstream/modelsdev.go（端点 / 解析 / 缓存语义）
//
// 定位：只对「上游动态值缺失 + 静态种子表未收录 + model.json 未缓存」的模型查
// models.dev，是兜底的兜底——超时短（5s）、失败静默降级，绝不阻塞 /v1/models 主路径：
// 查找异步化，本次请求直接返回兜底值，拉到后由 catalog 写 model.json 供下次命中。
//
// 缓存语义（对齐任务书）：成功索引 1h 内复用不重拉；失败 5min 负缓存内不重拉；
// 首次未命中仅触发后台异步拉取，本次 lookup 返回 null。
//
// 数据源 schema（与参考一致）：{ "<provider>": { "models": { "<id>": { "limit":
// { "context": N, "output": N } } } } }，模型 id 有裸名与带命名空间（openai/gpt-5.5）
// 两种形态，均取尾段做索引 key；多 provider 同名分歧时官方 vendor 源优先，其余取众数。

const axios = require('axios')
const C = require('./constants')

// 单次拉取超时：兜底的兜底，不值得等（参照 modelsDevTimeout）
const FETCH_TIMEOUT_MS = 5000

// 成功索引缓存时长：1h 内复用不再打 models.dev（参照任务书「1h 成功缓存」）
const DEFAULT_SUCCESS_TTL_MS = 60 * 60 * 1000

// 拉取失败负缓存时长：5min 内不重拉（参照任务书「5min 失败负缓存」）
const DEFAULT_FAIL_COOLDOWN_MS = 5 * 60 * 1000

// 值校验量级上限：context/output 超过 1e9 视为脏数据拒绝（参照 modelsDevValueMax）
const VALUE_MAX = 1e9

// 响应体上限：聚合文档实测 ~4.7MB，留余量（参照 modelsDevMaxBody）
const MAX_BODY_BYTES = 32 << 20

// 官方 vendor provider 优先名单：聚合网关自报的 limit 常与官方源分歧，官方源优先
// （参照 modelsDevVendorSources）
const VENDOR_SOURCES = new Set(['zai', 'moonshotai', 'moonshotai-cn', 'openai', 'google', 'deepseek', 'minimax'])

// 模块级单例状态（纯函数 + 模块级缓存，禁止 class）
const state = {
  url: C.MODELS_DEV_URL, // 拉取端点（测试可覆盖）
  successTtlMs: DEFAULT_SUCCESS_TTL_MS, // 成功索引缓存时长
  failCooldownMs: DEFAULT_FAIL_COOLDOWN_MS, // 失败负缓存时长
  fetcher: null, // 注入的假 fetcher（测试用）；null = 走默认 axios 拉取
  doc: null, // modelId -> { context, output }；null = 尚未成功拉取
  fetchedAt: 0, // 最近一次成功拉取时刻
  lastFailAt: 0, // 最近一次失败时刻
  fetching: false // 在途拉取去重标记
}

// 数值归一：非法/NaN 一律 0
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

// 配置注入（缓存时长 / 端点；测试用短 TTL，运行时不调用）
function configure(opts = {}) {
  if (typeof opts.url === 'string' && opts.url) state.url = opts.url
  if (typeof opts.successTtlMs === 'number' && opts.successTtlMs >= 0) state.successTtlMs = opts.successTtlMs
  if (typeof opts.failCooldownMs === 'number' && opts.failCooldownMs >= 0) state.failCooldownMs = opts.failCooldownMs
}

// 注入假 fetcher（测试替代真实网络；返回原始 JSON 文本或已解析对象）
function setFetcher(fn) {
  state.fetcher = typeof fn === 'function' ? fn : null
}

// 测试隔离：清空全部单例状态并回落默认配置
function resetForTest() {
  state.url = C.MODELS_DEV_URL
  state.successTtlMs = DEFAULT_SUCCESS_TTL_MS
  state.failCooldownMs = DEFAULT_FAIL_COOLDOWN_MS
  state.fetcher = null
  state.doc = null
  state.fetchedAt = 0
  state.lastFailAt = 0
  state.fetching = false
}

// 索引是否处于成功缓存有效期内
function isFresh() {
  return state.doc !== null && Date.now() - state.fetchedAt < state.successTtlMs
}

// 默认 fetcher：GET models.dev 聚合文档（5s 超时、失败抛错由调用方静默处理）
async function defaultFetcher() {
  const res = await axios.get(state.url, {
    timeout: FETCH_TIMEOUT_MS,
    responseType: 'text',
    maxRedirects: 0,
    validateStatus: () => true,
    // 保持原始文本，交由 parseCatalog 统一 JSON.parse（避免 axios 自动转换口径差异）
    transformResponse: [v => v]
  })
  if (res.status !== 200) throw new Error(`models.dev status ${res.status}`)
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  if (text.length > MAX_BODY_BYTES) throw new Error('models.dev body too large')
  return text
}

// 解析聚合文档 → 裸 id 索引（多 provider 同名合并采值：vendor 优先 / 众数 / provider 字典序）
function parseCatalog(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw
  const byModel = new Map()
  for (const provider of Object.keys(doc || {})) {
    const models = doc[provider] && doc[provider].models
    if (!models || typeof models !== 'object') continue
    for (const fullID of Object.keys(models)) {
      const limit = models[fullID] && models[fullID].limit
      if (!limit) continue
      const slash = fullID.lastIndexOf('/')
      const id = slash >= 0 ? fullID.slice(slash + 1) : fullID
      if (!id) continue
      // 值校验：context 正数 + 量级上限；output 非负 + 量级上限（脏值不进索引）
      const ctx = num(limit.context)
      const out = num(limit.output)
      if (!(ctx > 0) || ctx > VALUE_MAX) continue
      if (out < 0 || out > VALUE_MAX) continue
      const aggKey = `${ctx}/${out}`
      let list = byModel.get(id)
      if (!list) {
        list = []
        byModel.set(id, list)
      }
      const dup = list.find(c => c.aggKey === aggKey)
      if (dup) {
        dup.votes += 1
        if (VENDOR_SOURCES.has(provider)) dup.vendor = true
        if (provider < dup.minProvider) dup.minProvider = provider
      } else {
        list.push({
          context: ctx,
          output: out,
          aggKey,
          votes: 1,
          vendor: VENDOR_SOURCES.has(provider),
          minProvider: provider
        })
      }
    }
  }
  const out = new Map()
  for (const [id, list] of byModel) {
    let best = list[0]
    for (const c of list) {
      const better =
        (c.vendor && !best.vendor) ||
        (c.vendor === best.vendor && c.votes > best.votes) ||
        (c.vendor === best.vendor && c.votes === best.votes && c.minProvider < best.minProvider)
      if (better) best = c
    }
    out.set(id, { context: best.context, output: best.output })
  }
  return out
}

// 拉取并解析聚合目录（异步；任何失败静默，只刷新失败时刻供负缓存）
// 成功：写入索引 + 成功时刻；失败：仅记 lastFailAt（下次查找仍走兜底，不重试风暴）
async function fetchCatalog() {
  let raw
  try {
    raw = await (state.fetcher ? state.fetcher() : defaultFetcher())
  } catch {
    state.lastFailAt = Date.now()
    return null
  }
  try {
    const doc = parseCatalog(raw)
    state.doc = doc
    state.fetchedAt = Date.now()
    state.lastFailAt = 0
    return doc
  } catch {
    state.lastFailAt = Date.now()
    return null
  }
}

// 确保索引可用（异步、不阻塞调用方）：成功缓存期内 / 在途去重 / 失败负缓存期内 → 直接返回；
// 否则唤起一次后台拉取（fetch 失败静默）
function ensureDocAsync() {
  if (isFresh()) return
  if (state.fetching) return
  if (state.lastFailAt && Date.now() - state.lastFailAt < state.failCooldownMs) return
  state.fetching = true
  Promise.resolve()
    .then(() => fetchCatalog())
    .catch(() => {})
    .finally(() => {
      state.fetching = false
    })
}

// 查询一个模型的 (context, output)：命中返回 { context, output }，未命中返回 null。
// 只读内存索引；索引不可用时触发一次后台异步拉取并立即返回 null（不阻塞）。
function lookup(modelId) {
  ensureDocAsync()
  if (!state.doc) return null
  const e = state.doc.get(String(modelId || ''))
  if (!e) return null
  return { context: e.context, output: e.output }
}

module.exports = {
  configure,
  setFetcher,
  resetForTest,
  fetchCatalog,
  lookup,
  parseCatalog,
  isFresh
}