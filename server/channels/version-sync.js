// 渠道版本号自动同步（每天拉一次 Trae / Qoder 官网最新版本）
//
// 为什么需要：Trae 登录页按客户端形态（plugin_version / x_app_version）校验，
// 版本过旧会被判成「非官方客户端」而不给授权码（10-29 实测）；Qoder 的目录
// 解析也依赖版本号。写死一个常量意味着每次上游发版都要改代码。
//
// 数据源（全部公开、无需凭据，按可靠性分层）：
//   Trae:
//     ① docs.trae.cn/ide_changelog  —— 官方更新日志，HTML 里嵌版本号（可能滞后）
//     ② 本机已安装的 Trae（resources/app/product.json）—— 比日志更准，但仅本机有
//     两者取最大值；都失败时沿用内置默认值。
//   Qoder:
//     ① qoder.com/changelog —— Next.js RSC payload，带 tag_name/published_at/type
//       结构化数据，type=ide 即桌面 IDE 版本
//     ② 本机已安装的 Qoder（Qoder Launcher/state.ini 的 targetVersion）
//
// 刷新结果落盘 channels-data/channel-versions.json，进程启动与每日定时各跑一次；
// 拉取失败静默沿用上一次结果（网络抖动不该让登录立刻坏掉）。

const fs = require('fs')
const path = require('path')
const os = require('os')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
// 内置默认值：上游拉不到时的底线。随代码更新，新版本以同步结果为准。
const FALLBACK = {
  trae: { appVersion: '3.4.9', pluginVersion: '2.3.97430' },
  // Qoder 客户端版本（0.x 体系）。不要填 changelog 里的 1.x，那是 IDE 内核线。
  qoder: { appVersion: '0.5.3' },
}
const REFRESH_INTERVAL_MS = 24 * 3600 * 1000

// 版本号提取。边界规则：
//   · 前面不能是数字或点（排除 3.3.102 里的「102」、IP 地址、小数）；
//   · 允许 v/V 前缀（更新日志写 v3.4.1）；前面是其它字母时排除（避免把
//     「2.3.97430」这种构建号、URL 路径段误当版本）
function versionOrNull(text) {
  const m = String(text || '').match(/(?<![0-9.])(?:[vV])?(\d+\.\d+\.\d+)(?![0-9])/)
  if (!m) return null
  try { return { raw: m[1], cmp: m[1].split('.').map(n => Number(n) || 0) } } catch { return null }
}

// 三段版本号比较：a>b 返回 1
function compareVersion(a, b) {
  if (!a) return b ? -1 : 0
  if (!b) return 1
  const len = Math.max(a.cmp.length, b.cmp.length)
  for (let i = 0; i < len; i++) {
    const x = a.cmp[i] || 0
    const y = b.cmp[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

const maxVersion = list => list.filter(Boolean).reduce((best, item) => (compareVersion(item, best) >= 0 ? item : best), null)

function fetchWithTimeout(url, timeoutMs = 15000) {
  // Node 18+ 的全局 fetch 没有 AbortSignal.timeout 之外的便捷超时；这里手动包一层
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  return fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

// ── Trae 数据源 ──

// 官方更新日志：HTML 里「v3.4.x」与「3.4.x」两种写法都有，取最大值
async function fetchTraeDocsVersion() {
  const response = await fetchWithTimeout('https://docs.trae.cn/ide_changelog?lang=zh')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.text()
  const versions = [...body.matchAll(/(?<![0-9.])(?:[vV])?(\d+\.\d+\.\d+)(?![0-9])/g)]
    .map(m => versionOrNull(m[1]))
    .filter(Boolean)
  const max = maxVersion(versions)
  if (!max) throw new Error('更新日志里没有版本号')
  return max.raw
}

// 本机安装的 Trae：product.json 里 appVersion（用户可见版本）与 tronBuildVersion
// （登录链接 plugin_version 用的构建号）。找不到安装目录就返回 null —— 只有一台
// 机器装了 Trae，这个源是「锦上添花」而不是必需。
function readTraeLocalVersion() {
  const candidates = [
    'D:\\软件\\Trae CN\\resources\\app\\product.json',
    'C:\\Program Files\\Trae CN\\resources\\app\\product.json',
    'C:\\Program Files (x86)\\Trae CN\\resources\\app\\product.json',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Trae CN', 'resources', 'app', 'product.json'),
  ]
  for (const file of candidates) {
    try {
      const product = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (product.appVersion) {
        return { appVersion: String(product.appVersion), pluginVersion: String(product.tronBuildVersion || '') }
      }
    } catch { /* 下一个候选 */ }
  }
  return null
}

// ── Qoder 数据源 ──

// Qoder 桌面客户端的版本**只能**从官方 updater 元数据取。
//
// 为什么不能用 qoder.com/changelog：那里的 type='ide' 是 **IDE 内核线（1.x）**，
// 与桌面客户端（0.x）不是同一套版本体系。拿 1.38.0 当客户端版本会让
// Cosy-Version 头与签名载荷都发错值 —— 比写死一个偏低的版本更容易被判异常。
//
// latest.yml 是 electron-updater 的官方元数据，客户端自己就用它判断要不要更新，
// 它里面的 version 字段就是产品版本。
async function fetchQoderLatestYmlVersion() {
  const response = await fetchWithTimeout('https://static.qoder.com.cn/qoder-app/releases/latest.yml')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  // 形如 `version: 0.5.3`，取第一处即可（后面 files[] 里没有同名顶层字段）
  const m = /^version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(text)
  if (!m) throw new Error('latest.yml 里没有 version 字段')
  return m[1]
}

// 保留旧实现：万一 latest.yml 不可用，changelog 仍能提供「有新版发布」这个信号。
// 但它的值**不可**当客户端版本用，只作最后兜底。
async function fetchQoderChangelogVersion() {
  const response = await fetchWithTimeout('https://qoder.com/changelog')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  // RSC payload 的转义深度不定：浏览器里是一层 \uXXXX + \"，fetch 拿到的原始
  // 响应是两层（\\"tag_name\\"）。统一做法：先解 \uXXXX，再解 \" → "，
  // 让字段名无论如何都能被下面的正则匹配到
  const raw = await response.text()
  let body = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  body = body.replace(/\\"/g, '"')
  let latest = null
  // 记录字段顺序是 tag_name → name → published_at → … → type（字段间还有
  // created_at / formattedTime 等），所以 tag_name 与 type 之间留 600 字符窗，
  // published_at 在这个窗口里单独找
  const re = /"tag_name":"([^"]+)"[\s\S]{0,600}?"type":"([a-z\-]+)"[\s\S]{0,600}?(?="tag_name"|$)/g
  for (const m of body.matchAll(re)) {
    if (m[2] !== 'ide') continue
    const version = versionOrNull(m[1])
    const time = body.slice(m.index, m.index + m[0].length).match(/"published_at":"([^"]+)"/)
    const at = time ? Date.parse(time[1]) : NaN
    if (!version || !Number.isFinite(at)) continue
    // 同版本号可能多次发布，用发布时间取最新的一条
    if (!latest || at > latest.at) latest = { at, version }
  }
  if (!latest) throw new Error('changelog 里没有 IDE 版本')
  return latest.version.raw
}

function readQoderLocalVersion() {
  try {
    const ini = fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'Qoder', 'Qoder Launcher', 'state.ini'), 'utf8')
    const m = ini.match(/targetVersion=(\d+\.\d+\.\d+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// ── 汇总与缓存 ──

async function refreshVersions() {
  const result = {
    updatedAt: Date.now(),
    // 每个源的成败都记录下来：面板能看到「为什么版本没更新」
    sources: {},
    trae: { ...FALLBACK.trae },
    qoder: { ...FALLBACK.qoder },
  }

  // Trae：docs 更新日志 vs 本机安装，取最大
  try {
    result.sources.traeDocs = await fetchTraeDocsVersion()
  } catch (error) {
    result.sources.traeDocs = `失败：${error.message}`
  }
  const traeLocal = readTraeLocalVersion()
  if (traeLocal) result.sources.traeLocal = traeLocal.appVersion
  const traeMax = maxVersion([
    versionOrNull(result.sources.traeDocs),
    versionOrNull(traeLocal && traeLocal.appVersion),
  ])
  if (traeMax) {
    result.trae.appVersion = traeMax.raw
    // plugin_version（登录链接用）跟着本机构建号走：本机没有就用内置默认
    result.trae.pluginVersion = (traeLocal && traeLocal.pluginVersion) || FALLBACK.trae.pluginVersion
  }

  // Qoder 版本有两条独立数据源，职责不同：
  //
  //   sources.qoderDocs  = changelog 的 type:'ide' 版本 → **IDE 内核线（1.x）**，
  //                        只作「上游有没有发新版」的信号，**不可当客户端版本用**
  //   sources.qoderLatestYml = 官方 updater 的 version → **客户端版本（0.x）**，权威
  //
  // ⚠️ 绝不能把两者「取最大」：跨体系比较必然选中 1.x 的错误值。
  // 那是 2.0.2~2.0.3 的 bug（签名发 Cosy-Version: 1.38.0，官方是 0.5.3）。
  // 现在的取值顺序固定为：latest.yml > 本机 launcher > 内置兜底。
  //
  // changelog 仍然无条件拉取并记录（观测用，也让「上游发布节奏」可见）。
  try {
    result.sources.qoderDocs = await fetchQoderChangelogVersion()
  } catch (error) {
    result.sources.qoderDocs = `失败：${error.message}`
  }
  try {
    result.sources.qoderLatestYml = await fetchQoderLatestYmlVersion()
  } catch (error) {
    result.sources.qoderLatestYml = `失败：${error.message}`
  }

  const qoderYml = versionOrNull(result.sources.qoderLatestYml)
  const qoderLocal = readQoderLocalVersion()
  if (qoderLocal) result.sources.qoderLocal = qoderLocal

  if (qoderYml) {
    result.qoder.appVersion = qoderYml.raw
  } else {
    // latest.yml 不可用：本机 launcher 版本（同体系、只是可能过期）> 内置兜底。
    // 注意**不**回落到 qoderDocs（1.x 体系）。
    const localVer = versionOrNull(qoderLocal)
    if (localVer) result.qoder.appVersion = localVer.raw
  }

  return result
}

/**
 * 版本号同步器。启动后立即刷一次，之后每 24 小时一次；拉取失败沿用缓存。
 * @param {string} dataDir channels-data 目录（缓存文件放这）
 */
function createVersionSync(dataDir, { logger = console } = {}) {
  const file = path.join(dataDir, 'channel-versions.json')
  let cached = null
  let lastAt = 0
  let running = null
  let timer = null

  function readCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && parsed.trae && parsed.qoder) return parsed
    } catch { /* 缓存损坏按无缓存处理 */ }
    return null
  }

  async function refresh({ force = false } = {}) {
    if (running) return running
    if (!force && cached && Date.now() - lastAt < REFRESH_INTERVAL_MS) return cached
    running = (async () => {
      try {
        const next = await refreshVersions()
        cached = next
        lastAt = Date.now()
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(next, null, 2))
        logger.info?.(`[versions] 同步完成：trae ${next.trae.appVersion}/${next.trae.pluginVersion}，qoder ${next.qoder.appVersion}`)
        return next
      } catch (error) {
        // 拉取失败：有缓存就继续用缓存，没缓存就用内置默认。登录不能因为
        // 一个版本号接口挂掉而整体不可用
        logger.warn?.(`[versions] 同步失败，沿用旧值：${error.message}`)
        cached = cached || readCache() || { updatedAt: 0, sources: {}, trae: { ...FALLBACK.trae }, qoder: { ...FALLBACK.qoder } }
        lastAt = Date.now()
        return cached
      } finally {
        running = null
      }
    })()
    return running
  }

  function start() {
    cached = readCache()
    // 启动即刷（异步，不阻塞渠道初始化）；之后每天一次
    void refresh()
    timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  // 插件拿当前版本：缓存没有（首次同步还没完成）回落内置默认
  function get() {
    return cached || { updatedAt: 0, sources: {}, trae: { ...FALLBACK.trae }, qoder: { ...FALLBACK.qoder } }
  }

  return { start, stop, get, refresh, file }
}

module.exports = { createVersionSync, refreshVersions, FALLBACK }
