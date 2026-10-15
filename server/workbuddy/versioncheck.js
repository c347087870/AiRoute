// 客户端版本号自动检查：从官方公开来源获取最新版本号
//
// 背景：出站请求需要伪装成官方客户端，UA 里的版本号过时可能被上游判为可疑
// （实测证据：国际版 UA 平台段送错会触发 403 code 11140）。
// 版本号会随官方发版变化，硬编码必然过时，故提供自动检查。
//
// 已实测可用的来源（全部 JSON/HTML、无需鉴权）：
//   桌面端主版本：GET {chatBase}/v2/update?platform=workbuddy-win32-x64-user
//                 → { version: "5.7.7.40774747" }，取前三段得 5.7.7
//                 **国内版与国际版不同**（实测 5.7.7 vs 5.7.6），必须按区域分别取
//   CLI 版本：    GET https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest
//                 → { version: "2.164.0" }（npm 版本号即 CLI 自身版本号）
//   IDE 版本：    GET https://www.codebuddy.cn/docs/ide/release-notes/release-notes
//                 → HTML，首个 "X.Y.Z (日期)" 标题即最新（如 4.12.1）
//                 （Open VSX 给的是 4.12.39997873 带构建号形态，与 UA 语义不符，不用）
//
// 设计原则：
//   1. 每个字段**独立** try/catch —— 单源失败不影响其它字段
//   2. 分层降级：在线源 → 上次成功值落盘缓存（可无限期沿用）→ constants.js 硬编码
//   3. 严格校验：必须是 X.Y.Z 形态，且**不得低于当前值**（防上游返回回滚值把 UA 打坏）
//   4. 缓存 6 小时（版本号是低频变化量）

const fs = require('fs')
const path = require('path')
const axios = require('axios')
const C = require('./constants')

const CLIENT_VERSION = C.DEFAULT_CLIENT_VERSION

// 桌面端更新接口的平台标识（实测 win32-x64-user 在 CN/INTL 都可用）
const DESKTOP_PLATFORM = 'workbuddy-win32-x64-user'
// 版本号缓存有效期：6 小时
const CACHE_TTL_MS = 6 * 3600 * 1000
// 单源超时（官方接口很快，实测 116ms；给足余量但不拖慢界面）
const FETCH_TIMEOUT_MS = 15000

const CLI_REGISTRY_URL = 'https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest'
const IDE_CHANGELOG_URL = 'https://www.codebuddy.cn/docs/ide/release-notes/release-notes'

// 解析 "5.7.7.40774747" → "5.7.7"；非法输入返回 ''
function parseVersion(raw) {
  const s = String(raw || '').trim()
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : ''
}

// 版本号比较：a > b → 1，a < b → -1，相等 → 0（非法值视为 0）
function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

// 取桌面端最新版本（按区域）。失败抛错，由调用方 try/catch
async function fetchDesktopVersion(chatBase) {
  const url = `${chatBase}/v2/update?platform=${DESKTOP_PLATFORM}`
  const res = await axios.get(url, { timeout: FETCH_TIMEOUT_MS })
  const v = parseVersion(res.data && res.data.version)
  if (!v) throw new Error(`响应缺少可解析的 version（${JSON.stringify(res.data).slice(0, 120)}）`)
  return v
}

// 取 CLI 最新版本（npm registry）
async function fetchCliVersion() {
  const res = await axios.get(CLI_REGISTRY_URL, { timeout: FETCH_TIMEOUT_MS })
  const v = parseVersion(res.data && res.data.version)
  if (!v) throw new Error('npm 响应缺少 version')
  return v
}

// 取 IDE 最新版本（官方 changelog 首个版本标题）
async function fetchIdeVersion() {
  const res = await axios.get(IDE_CHANGELOG_URL, { timeout: FETCH_TIMEOUT_MS, responseType: 'text' })
  const html = typeof res.data === 'string' ? res.data : String(res.data || '')
  // 标题形如 <h2 id="...">4.12.1 (2026-09-20)</h2>，直接取全文首个 "X.Y.Z (" 匹配
  const m = /(\d+\.\d+\.\d+)\s*\(/.exec(html)
  if (!m) throw new Error('changelog 页面未匹配到版本号（页面结构可能已变）')
  return m[1]
}

// 创建版本检查器（dataDir 用于落盘缓存）
function createVersionChecker(opts = {}) {
  const cacheFile = opts.cacheFile || (opts.dataDir ? path.join(opts.dataDir, 'version-cache.json') : '')
  let mem = null // { fetchedAt, latest, sources, errors }

  // 读缓存：内存 → 磁盘
  function loadCache() {
    if (mem) return mem
    if (!cacheFile) return null
    try {
      const doc = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (doc && doc.latest) mem = doc
    } catch {
      /* 无缓存或损坏：静默降级 */
    }
    return mem
  }

  // 写缓存：内存 + 磁盘（落盘失败不影响功能）
  function saveCache(doc) {
    mem = doc
    if (!cacheFile) return
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      const tmp = `${cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2))
      fs.renameSync(tmp, cacheFile)
    } catch {
      /* 落盘失败忽略 */
    }
  }

  // 当前生效值（由调用方传入，通常来自 identity 配置合并默认值）
  function currentOf(identity) {
    const id = identity || {}
    return {
      clientVersion: id.clientVersion || CLIENT_VERSION,
      desktopVersion: id.desktopVersion || id.clientVersion || CLIENT_VERSION,
      cliVersion: id.cliVersion || '',
      ideVersion: id.ideVersion || ''
    }
  }

  // 执行一次检查。
  // force=true 忽略 TTL 强制刷新；否则 TTL 内直接返回缓存。
  // current：当前生效值，用于「不得低于当前值」校验（缺失则跳过该校验）
  async function check(current, force) {
    const cached = loadCache()
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { ...cached, fromCache: true }
    }

    const errors = []
    const sources = {}
    const latest = {}
    const cur = currentOf(current)
    // 读取上次成功值作为单字段降级来源
    const prev = (cached && cached.latest) || {}

    // 每字段独立采集：新值必须合法且 >= 当前值，否则回落上次成功值
    const accept = (field, value, source) => {
      if (!value) return false
      if (cur[field] && compareVersion(value, cur[field]) < 0) {
        errors.push(`${field}: 官方返回 ${value} 低于当前值 ${cur[field]}，已忽略（防回滚）`)
        return false
      }
      latest[field] = value
      if (source) sources[field] = source
      return true
    }

    // 桌面端主版本（CN / INTL 分别取，实测两者不同）
    let desktopRegion = {}
    try {
      desktopRegion.cn = await fetchDesktopVersion(C.CHAT_BASE_CN)
    } catch (e) {
      errors.push(`桌面端(国内版): ${e.message}`)
    }
    try {
      desktopRegion.global = await fetchDesktopVersion(C.GLOBAL_CHAT_BASE)
    } catch (e) {
      errors.push(`桌面端(国际版): ${e.message}`)
    }

    // clientVersion / desktopVersion 用国内版值（identity 是全局单份配置；
    // 国际版略低一两个小版本，用较新的国内版值做 UA 不会被判旧）
    const desktopPick = desktopRegion.cn || desktopRegion.global || ''
    if (!accept('clientVersion', desktopPick, `${C.CHAT_BASE_CN}/v2/update`)) {
      if (prev.clientVersion) latest.clientVersion = prev.clientVersion
    }
    if (desktopPick) {
      // desktopVersion 与主版本同源（桌面端 UA 两段同版本），沿用同一取值
      if (!accept('desktopVersion', desktopPick, `${C.CHAT_BASE_CN}/v2/update`)) {
        if (prev.desktopVersion) latest.desktopVersion = prev.desktopVersion
      }
    } else if (prev.desktopVersion) {
      latest.desktopVersion = prev.desktopVersion
    }

    // CLI 版本
    try {
      const v = await fetchCliVersion()
      if (!accept('cliVersion', v, CLI_REGISTRY_URL) && prev.cliVersion) latest.cliVersion = prev.cliVersion
    } catch (e) {
      errors.push(`CLI: ${e.message}`)
      if (prev.cliVersion) latest.cliVersion = prev.cliVersion
    }

    // IDE 版本
    try {
      const v = await fetchIdeVersion()
      if (!accept('ideVersion', v, IDE_CHANGELOG_URL) && prev.ideVersion) latest.ideVersion = prev.ideVersion
    } catch (e) {
      errors.push(`IDE: ${e.message}`)
      if (prev.ideVersion) latest.ideVersion = prev.ideVersion
    }

    const doc = {
      fetchedAt: Date.now(),
      latest,
      desktopByRegion: desktopRegion,
      sources,
      errors,
      fromCache: false
    }
    // 一个字段都没取到时不覆盖旧缓存，避免把可用缓存清空
    if (Object.keys(latest).length > 0) saveCache(doc)
    return doc
  }

  // 读取缓存内容（不触发网络）
  function peek() {
    return loadCache()
  }

  return { check, peek, currentOf }
}

module.exports = {
  createVersionChecker,
  parseVersion,
  compareVersion,
  fetchDesktopVersion,
  fetchCliVersion,
  fetchIdeVersion,
  CLI_REGISTRY_URL,
  IDE_CHANGELOG_URL,
  DESKTOP_PLATFORM,
  CACHE_TTL_MS
}
