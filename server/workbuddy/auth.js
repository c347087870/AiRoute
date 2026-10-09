// 账号凭证管理：双形态解析、原子落盘、目录扫描
// 翻译自参考项目 internal/auth/auth.go

const fs = require('fs')
const path = require('path')

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

  return {
    uid: str(acct.uid),
    enterpriseId: str(acct.enterpriseId),
    nickname: str(acct.nickname),
    domain: str(src.domain),
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
      domain: auth.domain
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

module.exports = {
  validUID,
  parseAuth,
  saveAtomic,
  pathFor,
  loadDir,
  needsRefresh
}