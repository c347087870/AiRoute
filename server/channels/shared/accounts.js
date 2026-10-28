// 自有渠道（Trae / Qoder）的共用工具：账号标识、凭据读取与落盘
//
// 这些渠道**不再经过 dsh 渠道包**，所以账号与凭据由 AiRoute 自己持有。
// 但为了不破坏已有数据，账号标识与存储键都沿用渠道包的约定：
//
//   账号 id：`<provider>-<8 位 hash>`，凭据键：`<PROVIDER>_ACCOUNT_<8 位大写 hex>`
//
// 这样 `channels-data/channel-credentials.json` 里已有的账号能被直接认领，
// 不需要用户重新登录（见 claimLegacyAccounts）。

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 渠道包对所有 provider 共用的凭据文件（0600 明文，与 server/workbuddy-auths/ 同口径）
const CREDENTIALS_FILE = 'channel-credentials.json'

function credentialsPath(dataDir) {
  return path.join(dataDir, CREDENTIALS_FILE)
}

// 账号 id 的 hash 后缀：`trae` + uid → 稳定的 8 位 hex。
// 与渠道包的生成方式一致，所以同一个账号在迁移前后是同一个 id
function accountSuffix(provider, uid) {
  return crypto.createHash('sha256').update(`${provider}:${uid}`).digest('hex').slice(0, 8)
}

function accountId(provider, uid) {
  return `${provider}-${accountSuffix(provider, uid)}`
}

function credentialKey(provider, uid) {
  return `${provider.toUpperCase()}_ACCOUNT_${accountSuffix(provider, uid).toUpperCase()}`
}

// 读全部凭据（只读不改）。文件不存在 = 还没有任何账号，这是正常状态
function readCredentials(dataDir) {
  try {
    const raw = fs.readFileSync(credentialsPath(dataDir), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// 凭据值在渠道包里是 JSON **字符串**（不是对象）；两种形态都容忍
function parseCredentialValue(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function writeCredentials(dataDir, credentials) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = credentialsPath(dataDir)
  // 先写临时文件再 rename：中途崩溃不会留下半截 JSON（里面是明文凭据，
  // 读回失败等于全部账号「消失」）
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// 读取某账号的凭据（对象形态）；不存在或解析失败返回 undefined。
//
// ⚠️ 取凭据时**按 uid 反查真实键名**，不重新计算：渠道包生成后缀的算法
// 与本模块未必一致（实测旧文件里 `TRAE_ACCOUNT_45AB04E0` 的账号 uid 是
// `15814148757308`，hash 算出来是 `032a9984`）—— 重算会让「迁移过来的账号」
// 一律读不到凭据，表现就是登录态全丢。键名一旦写进去就是权威。
function keyForUid(dataDir, provider, uid) {
  const all = readCredentials(dataDir)
  const prefix = `${provider.toUpperCase()}_ACCOUNT_`
  const expected = credentialKey(provider, uid)
  if (Object.hasOwn(all, expected)) return expected
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue
    const credential = parseCredentialValue(raw)
    if (credential && credential.uid === uid) return key
  }
  return expected
}

function getCredential(dataDir, provider, uid) {
  const all = readCredentials(dataDir)
  return parseCredentialValue(all[keyForUid(dataDir, provider, uid)])
}

// 写凭据：沿用该 uid 已有的键名（迁移过来的账号不会被复制成两条），
// 没有时才按标准规则生成
function setCredential(dataDir, provider, uid, credential) {
  const all = readCredentials(dataDir)
  all[keyForUid(dataDir, provider, uid)] = JSON.stringify(credential)
  writeCredentials(dataDir, all)
}

function removeCredential(dataDir, provider, uid) {
  const all = readCredentials(dataDir)
  delete all[keyForUid(dataDir, provider, uid)]
  writeCredentials(dataDir, all)
}

// 枚举某 provider 已有的凭据：返回 [{ uid, key, credential, suffix }]
//
// uid 取自凭据本身（最可靠）；`suffix` 是键名里的那 8 位 hex，
// 用它拼出的账号 id 才能和旧数据（渠道包写的键名）一致。
function listCredentials(dataDir, provider) {
  const prefix = `${provider.toUpperCase()}_ACCOUNT_`
  const all = readCredentials(dataDir)
  const out = []
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue
    const credential = parseCredentialValue(raw)
    if (!credential || typeof credential !== 'object') continue
    const uid = typeof credential.uid === 'string' ? credential.uid : ''
    out.push({ key, uid, credential, suffix: key.slice(prefix.length).toLowerCase() })
  }
  return out
}

// 生成 8 位小写 hex 后缀（用于没有 uid 的新账号的临时 id）
function randomSuffix() {
  return crypto.randomBytes(4).toString('hex')
}

module.exports = {
  accountSuffix,
  accountId,
  credentialKey,
  readCredentials,
  parseCredentialValue,
  writeCredentials,
  getCredential,
  setCredential,
  removeCredential,
  listCredentials,
  randomSuffix,
  credentialsPath,
}
