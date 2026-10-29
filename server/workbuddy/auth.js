// 账号凭证管理：双形态解析、原子落盘、目录扫描

const fs = require('fs')
const path = require('path')

// ===== 区域（realm）=====
// 国内版（cn）与国际版（global）用同一套 OAuth 路径，仅域名/UA/头族不同。
// 落盘字段 `realm`（嵌套形 auth.realm）；缺失时按 domain 后缀推断，
// 再回落 cn——旧凭证文件不含该字段，必须能安全地判为国内版。

const REALM_CN = 'cn'
const REALM_GLOBAL = 'global'

// 国际版域名族（裸域与任意子域）。国内版 OAuth 返回 www.codebuddy.cn，
// 国际版返回 workbuddy.ai 家族域名。
function isGlobalDomain(domain) {
  const d = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
  if (!d) return false
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')
}

// 归一化区域取值（用于「解析已存在的凭证文件」这一场景）。
// 优先级：domain 是上游 OAuth 真实返回值 → 最可信；realm 是本地记录。
// 两者矛盾时以 domain 为准：凭证可能被手工编辑或早期版本写入错误 realm，
// 把国内账号判成国际版会让请求发往境外域名而全量失败（反之亦然）。
// 注意：OAuth 刚落盘时**不要**用本函数，应直接用 resolveRealmForLogin（用户显式选择优先）。
function resolveRealm(realm, domain) {
  const r = String(realm || '').trim().toLowerCase()
  const hasDomain = !!String(domain || '').trim()
  if (hasDomain) {
    // domain 有明确指向：workbuddy.ai 家族 → global；否则 → cn
    // （即使 realm 声称 global，domain 是国内也判 cn —— 宁可走国内链路可用，
    //  也不要因误判把请求全发到境外而全盘失败）
    return isGlobalDomain(domain) ? REALM_GLOBAL : REALM_CN
  }
  // 没有 domain 信息（老凭证/手工构造）才采信显式 realm
  return r === REALM_GLOBAL ? REALM_GLOBAL : REALM_CN
}

// 登录落盘时用的区域解析：**用户显式选择优先**。
// OAuth 刚拿到的 domain 可能尚未反映区域（或上游返回空），而用户已明确选了中国际版，
// 此时必须尊重用户选择，否则国际版永远无法添加。
function resolveRealmForLogin(realm, domain) {
  const r = String(realm || '').trim().toLowerCase()
  if (r === REALM_GLOBAL) return REALM_GLOBAL
  if (r === REALM_CN) return REALM_CN
  return isGlobalDomain(domain) ? REALM_GLOBAL : REALM_CN
}

// UID 白名单校验（防路径穿越）：仅字母/数字/下划线/连字符，长度 ≤ 64
function validUID(uid) {
  if (!uid || uid.length > 64) return false
  return /^[A-Za-z0-9_-]+$/.test(uid)
}

// 解析凭证 JSON（双形态：嵌套形 auth/account，或扁平形）
// 失败返回 null（空输入 / JSON 非法 / accessToken 为空）
function parseAuth(raw) {
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null

  const nested = doc.auth && typeof doc.auth === 'object' ? doc.auth : null
  const src = nested || doc
  const acct = nested && doc.account && typeof doc.account === 'object' ? doc.account : doc

  const accessToken = typeof src.accessToken === 'string' ? src.accessToken.trim() : ''
  if (!accessToken) return null

  const domain = str(src.domain)
  return {
    uid: str(acct.uid),
    enterpriseId: str(acct.enterpriseId),
    nickname: str(acct.nickname),
    domain,
    // 区域：显式字段优先，缺失按 domain 推断（旧凭证 → 国内版）
    realm: resolveRealm(src.realm, domain),
    accessToken,
    refreshToken: str(src.refreshToken),
    expiresAt: Number.isFinite(Number(src.expiresAt)) ? Math.floor(Number(src.expiresAt)) : 0,
    deviceToken: str(doc.device_token),
    filePath: ''
  }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

// 是否真企业版（计费口径：enterpriseId 非空）
function isEnterprise(auth) {
  return !!(auth && String(auth.enterpriseId || '').trim())
}

// 解出 JWT payload 里的 token_source 声明。
// 非 JWT / 解码失败 / payload 非 JSON 一律返回 ''（老 token 与非标准形态按无此声明
// 处理，零回归）。先按无填充 base64url 解（JWT 标准），失败再试带填充形态。
function jwtTokenSource(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) return ''
  let raw
  try {
    raw = Buffer.from(parts[1], 'base64url').toString('utf8')
  } catch {
    return ''
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return ''
  }
  return payload && typeof payload.token_source === 'string' ? payload.token_source : ''
}

// 是否处于「企业上下文」：账号本身是企业版，或 accessToken 签发自**企业切换会话**
// （JWT payload 带 token_source=enterprise_switch —— 浏览器在企业空间状态下完成
// OAuth 授权时签发）。
//
// 为什么单独一站：企业切换会话与真企业版的上游表现不同（实测 2026-10-12）——
// 成长任务列表 / 额度查询 / 领养 Buddy 等**读端点与直连 API 照常**，但行为事件
// 上报（/v2/report）**返回 200 却被上游静默丢弃**：成长任务全部 0/x，重跑并回读
// 进度从不跳动。即「读得见、记不上账」。不跳过则调度队列每轮白跑全部任务（含
// 真实对话配额），且无任何报错可查。
// 因此行为类任务（活跃上报 / 连登管家 / 猫猫旅行 / 夜猫子 / 成长任务执行）的门控
// 用本函数；签到不在此列（签到失败是显式报错），任务列表扫描与保活照常。
//
// 每次现解码而非缓存：refresh 会整体换发 token，企业切换状态可能随重新授权翻转。
function isEnterpriseSession(auth) {
  if (isEnterprise(auth)) return true
  return jwtTokenSource(auth && auth.accessToken) === 'enterprise_switch'
}

// 原子落盘（嵌套形，插件可读格式）：tmp + rename，权限 0600
function saveAtomic(auth) {
  if (!auth) return
  if (!String(auth.accessToken || '').trim()) {
    throw new Error(`save refused: empty accessToken (uid=${auth.uid})`)
  }
  if (!auth.filePath) throw new Error('no FilePath set')

  const doc = {
    auth: {
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
      domain: auth.domain,
      // 区域落盘：刷新 token 时不回写会导致重启后按 domain 重新推断（国际版域名可推断，
      // 但显式落盘可避免上游换了 domain 取值后判定漂移）
      realm: auth.realm || REALM_CN
    },
    account: {
      uid: auth.uid,
      enterpriseId: auth.enterpriseId,
      nickname: auth.nickname
    }
  }
  if (auth.deviceToken) doc.device_token = auth.deviceToken // 非空才写

  const dir = path.dirname(auth.filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  const tmp = `${auth.filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, auth.filePath)
}

// 按 uid 计算凭证文件路径
function pathFor(dir, uid) {
  return path.join(dir, `workbuddy-${uid}.json`)
}

// 扫描目录加载全部凭证（workbuddy*.json），失败的单文件静默跳过
function loadDir(dir) {
  const list = []
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return list
  }

  const seen = new Map()
  for (const name of names) {
    if (!name.startsWith('workbuddy') || !name.endsWith('.json')) continue
    const filePath = path.join(dir, name)
    let auth
    try {
      auth = parseAuth(fs.readFileSync(filePath, 'utf8'))
    } catch {
      continue
    }
    if (!auth) continue
    auth.filePath = filePath

    if (seen.has(auth.uid)) {
      // 重复 UID：后者覆盖
      const prev = seen.get(auth.uid)
      const idx = list.indexOf(prev)
      if (idx >= 0) list.splice(idx, 1)
    }
    seen.set(auth.uid, auth)
    list.push(auth)
  }
  return list
}

// 凭证是否需要刷新：expiresAt 缺失视为需要，或距过期不足 within
function needsRefresh(auth, within) {
  const expiresAt = Number(auth?.expiresAt || 0)
  if (expiresAt <= 0) return true
  return Math.floor(Date.now() / 1000) + within >= expiresAt
}

// AT 是否仍然有效（留 5 分钟余量）。refresh 失败但 AT 未过期 ≠ 账号死：
// 上游 chat 仍可用（实测 4/29 个账号 refresh 恒回 12153，但 AT 还剩 26~333 天，
// /v2/chat/completions 全 200）。按 session dead 连续计数会把这些号永久禁用。
function atStillValid(auth, marginSec = 300) {
  const exp = Number(auth?.expiresAt || 0)
  if (!Number.isFinite(exp) || exp <= 0) return false // 无 expiry 无法判定，按死处理
  return Math.floor(Date.now() / 1000) + marginSec < exp
}

module.exports = {
  validUID,
  parseAuth,
  saveAtomic,
  pathFor,
  loadDir,
  needsRefresh,
  atStillValid,
  // 企业上下文判定（计费口径 / 行为任务门控口径）
  isEnterprise,
  isEnterpriseSession,
  jwtTokenSource,
  // 区域判定
  REALM_CN,
  REALM_GLOBAL,
  resolveRealm,
  resolveRealmForLogin,
  isGlobalDomain
}