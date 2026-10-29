// 账号渠道的运行参数（面板「渠道设置」内页读写它）
//
// 两级结构：
//   · 顶层 = 默认值（旧版就是这一层，读旧文件不会丢配置）
//   · providers.<id> = 该渠道自己的覆盖值（在每张渠道卡的「设置」里单独改）
// 取某个渠道的实际参数用 forProvider(id)：顶层默认 + 该渠道覆盖。
// 这样 Trae 的首字超时、Qoder 的冷却互不影响，改一家不会动到另一家。
//
// 为什么单独一个文件：这些参数横跨宿主（router 的首帧保活）与插件（Qoder 的
// 冷却/并发/选号），放 server-config.json 会让「服务端口」和「渠道行为」混在
// 一起；放各插件自己的目录里又没法在面板上统一展示。

const fs = require('fs')
const path = require('path')

const FILE = 'channel-settings.json'
// 可以在卡片里单独配置的渠道（与内置插件一致）
const PROVIDERS = ['trae', 'qoder', 'qodercn']

const DEFAULTS = {
  // 首帧上限（毫秒）：上游一个字节都没给就判卡住。默认 120 秒 ——
  // 实测思考型模型（xhigh）首字 40~71 秒，旧默认 60 秒会把合法请求判死。
  firstChunkTimeoutMs: 120000,
  // 超过这么多毫秒还没有第一段内容，就先把 SSE 头与心跳发出去，避免客户端
  // 因为「迟迟没有响应头」自己超时。0 = 关掉（回到旧行为：收到内容才承诺 200）。
  // 取 3 秒而不是 0：401/429/404 这类立等可得的错误要留给正常错误出口，
  // 太早发 200 会把「额度用完」变成「200 + 错误帧」。
  earlyHeadersMs: 3000,
  // 空闲心跳间隔（毫秒）：0 表示不发。
  heartbeatMs: 5000,
  // 429 / 额度受限后的单账号冷却（毫秒）。旧行为是一小时，过罚：
  // 上游 429 通常只代表「这一分钟的并发超了」。
  cooldownMs: 60000,
  // 同一账号的最大并发（0 = 不限）。上游对单号并发极敏感，默认 1。
  maxConcurrency: 1,
  // 同一账号两次请求的最小间隔（毫秒）。
  minGapMs: 0,
  // 同一段对话固定用同一个账号（吃上游 prompt 缓存，也避免同会话跨设备）
  affinity: true,
  // 账号轮转：关掉即「永远用清单里第一个可用账号」（旧行为）
  rotation: true,
  // ── Trae 中转（P0/P1）──
  // 首字超时：建连后这么久还没吐第一个字节就换号。Trae 思考型模型首字 10~40s，
  // 10 秒是「卡住的号」与「模型在想」的分界，换号只发生在毫无产出时。
  traeFirstByteMs: 10000,
  // 选号策略：order = 清单顺序（旧行为）；expire = 积分先到期先用；
  // credit = 余额多的优先；weighted = 余额×闲置×成功率加权随机；p2c = 随机两个取更闲
  traePoolStrategy: 'order',
  // 会话粘性 TTL：同一段对话固定落同一账号，0 = 关
  traeStickyTtlMs: 1800000,
  // 出站形态清洗：把别家 CLI 的身份句改写成中性句、剥掉 cc_* / x-anthropic-* 键值。
  // 关掉即原样透传（上游按渠道特征识别时会被 11-128 拦掉）
  traeSanitize: true,
  // Max 模式：目录声明了 max 档 > dev 档的模型才启用（1M 上下文）
  traeMaxMode: true,
  // 工具名别名表：{ 原名: 别名 }，请求侧改名、响应侧回改。默认空 = 不改名
  traeToolAlias: {},
}

const POOL_STRATEGIES = ['order', 'expire', 'credit', 'weighted', 'p2c']

// 数值范围：宁可夹紧也不让一个手改的 0/负值把渠道打死
const RANGES = {
  firstChunkTimeoutMs: [10000, 900000],
  earlyHeadersMs: [0, 60000],
  heartbeatMs: [0, 60000],
  cooldownMs: [1000, 6 * 60 * 60 * 1000],
  maxConcurrency: [0, 16],
  minGapMs: [0, 10000],
  traeFirstByteMs: [3000, 60000],
  traeStickyTtlMs: [0, 24 * 60 * 60 * 1000],
}

function clampNumber(key, value) {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return undefined
  const [min, max] = RANGES[key] || [0, Number.MAX_SAFE_INTEGER]
  return Math.min(Math.max(Math.round(raw), min), max)
}

// 只接受已知字段：面板与手改的文件都可能夹带无关键
function normalizeFlat(patch, base) {
  const out = { ...base }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in patch)) continue
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof patch[key] === 'boolean') out[key] = patch[key]
      continue
    }
    if (key === 'traePoolStrategy') {
      if (POOL_STRATEGIES.includes(patch[key])) out[key] = patch[key]
      continue
    }
    if (key === 'traeToolAlias') {
      const value = patch[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const map = {}
        for (const [from, to] of Object.entries(value)) {
          if (typeof from === 'string' && from.trim() && typeof to === 'string' && to.trim()) map[from.trim()] = to.trim()
        }
        out[key] = map
      }
      continue
    }
    const value = clampNumber(key, patch[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

function normalize(patch, base = DEFAULTS) {
  const out = normalizeFlat(patch, base)
  // providers 是嵌套的一层：只归一出现过的渠道，其余保持原样
  const merged = { ...(base.providers || {}) }
  const incoming = patch && typeof patch === 'object' ? patch.providers : undefined
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    for (const id of PROVIDERS) {
      const value = incoming[id]
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      merged[id] = normalizeFlat(value, { ...DEFAULTS, ...(merged[id] || {}) })
    }
  }
  out.providers = merged
  return out
}

function readFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 渠道设置读写器。读带 2 秒缓存（每次请求都读盘没必要），写立即落盘。
 * @param {string} dataDir channels-data 目录
 */
function createSettings(dataDir) {
  const file = path.join(dataDir, FILE)
  let cached = null
  let cachedAt = 0
  const TTL = 2000

  function get() {
    const now = Date.now()
    if (cached && now - cachedAt < TTL) return cached
    cached = normalize(readFile(file))
    cachedAt = now
    return cached
  }

  // 某渠道的实际参数：顶层默认 + 该渠道覆盖
  function forProvider(id) {
    const all = get()
    const own = all.providers && all.providers[id]
    return own ? { ...all, ...own } : { ...all }
  }

  function update(patch) {
    const next = normalize(patch, get())
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, file)
    cached = next
    cachedAt = Date.now()
    return next
  }

  return { get, forProvider, update, file, defaults: DEFAULTS, providers: PROVIDERS }
}

module.exports = { createSettings, DEFAULTS, PROVIDERS, normalize }
