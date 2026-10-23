// 渠道账号「被上游禁用」的台账：谁被禁用了、原话是什么、什么时候发现的。
//
// ## 为什么要在 AiRoute 这一层记
//
// 渠道包把上游的业务码原样透出（实测 `lobsterai: code=40302 账号已被禁用`），
// 它自己的负缓存只管「某个模型不可用」，不管「这个号已经废了」。于是一个被上游
// 禁用的账号会继续留在池子里：调度器照样把请求派过去、界面上照旧是个正常账号，
// 用户只有在手点「测试」时看到一句 toast —— 看完就没了。
//
// 渠道包产物由上游生成（见 .agents/skills/channels），改它的行为要回 vendor 上游，
// 所以判断放在这里：认出确定性文案 → 由调用方在池里停用该账号 → 原因记在本台账，
// 界面据此打标签。`account.update` 的 patch 只有
// `nickname | enabled | expiresAt | refreshable`，没有地方存原因，故只能自己存。
//
// 文案只是**证据**：「无法确认 / 查询失败 / 限流」是未知或临时状态，不能据此停用
// 账号 —— 把还能用的号关掉比多派几次请求代价大得多。
//
// 状态文件是运行数据（`account-health.json`），不进仓库。

const fs = require('fs-extra')
const paths = require('./paths')

const FILE_VERSION = 1

// 只认「结论性」的禁用信号：
//   - LobsterAI 业务码 40302（实测文案「lobsterai: code=40302 账号已被禁用」）
//   - 其它渠道把上游原文带出来时的中英文说法
// 不认「无法确认」「查询失败」「限额/限流」：那些是未知或临时状态。
const DISABLED_PATTERNS = [
  /\b40302\b/,
  /(?:账号|帐号)已?(?:被)?(?:禁用|停用|封禁)/,
  /account\s+(?:has\s+been\s+|is\s+|was\s+)?(?:disabled|banned|suspended)\b/i
]

/**
 * 这段文案是否在说「账号被上游禁用了」。
 *
 * @param {unknown} text 上游/渠道包给出的原因文案
 * @returns {boolean}
 */
function isDisabledSignal(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) return false
  return DISABLED_PATTERNS.some(re => re.test(value))
}

// 渠道包封套里的值：`{ ok: true, value }`，失败时是 `{ ok: false, error }`
function unwrap(result) {
  if (!result || typeof result !== 'object') return null
  const value = result.ok === true ? result.value : null
  return value && typeof value === 'object' ? value : null
}

/**
 * 从一次 RPC 结果里挑出「某账号被禁用」的证据（纯函数，不读盘不写盘）。
 *
 * 只覆盖证据真的会出现、且能归属到具体账号的几个方法；其它方法即使文案相同
 * 也无从判断是哪个账号，硬猜会把无关的账号停掉。
 *
 * 特意**不看** `account.list` 的 `refreshError`：那是上一次凭据刷新失败留下的
 * 残留（渠道包不清就一直挂着），据它停用会让「用户刚重新启用」立刻又被停掉。
 * 下面几个方法都是当场问上游的，证据是新鲜的。
 *
 * @param {string} method 渠道包 RPC 方法名
 * @param {object} payload 调用参数（`account.test` 的 accountId 在这里）
 * @param {object} result 渠道包封套 `{ ok, value }`
 * @returns {Array<{ accountId: string, reason: string }>}
 */
function evidenceOf(method, payload, result) {
  const value = unwrap(result)
  if (!value) return []
  const out = []
  const push = (accountId, reason) => {
    if (typeof accountId !== 'string' || accountId === '') return
    if (!isDisabledSignal(reason)) return
    if (out.some(item => item.accountId === accountId && item.reason === String(reason).trim())) return
    out.push({ accountId, reason: String(reason).trim() })
  }

  if (method === 'account.test') {
    // `{ accountId, modelId, ok, message }`
    if (value.ok !== true) push(value.accountId || payload?.accountId, value.message)
    return out
  }
  if (method === 'account.retest') {
    // `{ accountId, stillLimited: [{ modelId, ok, message }], cleared }`
    for (const item of value.stillLimited || []) push(value.accountId || payload?.accountId, item?.message)
    return out
  }
  if (method === 'account.retestAll') {
    // `{ accounts: [{ accountId, stillLimited: [...] }] }`
    for (const account of value.accounts || []) {
      for (const item of account?.stillLimited || []) push(account?.accountId, item?.message)
    }
    return out
  }
  if (method === 'credits.balances') {
    // `{ accounts: [{ accountId, credits?, error? }] }`：查余额要先过鉴权，
    // 所以被禁用的账号在这里也会带着同一句上游原文
    for (const account of value.accounts || []) push(account?.accountId, account?.error)
    return out
  }
  return out
}

function emptyRecord() {
  return { reason: '', provider: '', since: 0 }
}

function sanitize(raw) {
  const rec = emptyRecord()
  if (!raw || typeof raw !== 'object') return rec
  rec.reason = typeof raw.reason === 'string' ? raw.reason : ''
  rec.provider = typeof raw.provider === 'string' ? raw.provider : ''
  rec.since = Number.isFinite(raw.since) ? raw.since : 0
  return rec
}

// 内存缓存：界面加载账号列表时会批量问原因，不必每次读盘。
// 这个进程是唯一写入者，所以缓存不会和文件打架。
let cache = null

function load() {
  if (cache) return cache
  let accounts = {}
  try {
    const file = paths.getAccountHealthPath()
    if (fs.existsSync(file)) {
      const raw = fs.readJsonSync(file)
      const source = raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {}
      for (const [accountId, value] of Object.entries(source)) {
        if (!accountId || typeof value !== 'object' || value === null) continue
        accounts[accountId] = sanitize(value)
      }
    }
  } catch {
    // 文件坏了按「没记过任何原因」处理：标签会退化成「已停用」，但账号本身
    // 仍是池子里的真实状态，不会因为一份读不出的文件被误判成可用
    accounts = {}
  }
  cache = { accounts }
  return cache
}

function save(data) {
  const file = paths.getAccountHealthPath()
  fs.ensureDirSync(paths.getDataDir())
  fs.writeJsonSync(file, { version: FILE_VERSION, accounts: data.accounts }, { spaces: 2 })
}

// 记一条「这个账号被上游禁用了」。同一账号同一原因重复记录不写盘：
// 账号列表/余额查询会被反复调用，不该每次都改文件时间戳。
function record(accountId, reason, provider = '') {
  if (typeof accountId !== 'string' || accountId === '') return null
  const data = load()
  const prev = data.accounts[accountId]
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (prev && prev.reason === text) return { ...prev }
  const next = { reason: text, provider, since: Date.now() }
  data.accounts[accountId] = next
  save(data)
  return { ...next }
}

// 用户重新启用账号时清掉原因：这是他的判断，不该被旧证据一直压着
function clear(accountId) {
  const data = load()
  if (!data.accounts[accountId]) return false
  delete data.accounts[accountId]
  save(data)
  return true
}

function reasonOf(accountId) {
  const rec = load().accounts[accountId]
  return rec ? { ...rec } : null
}

function list() {
  const { accounts } = load()
  return Object.entries(accounts)
    .map(([accountId, rec]) => ({ accountId, ...rec }))
    .sort((a, b) => b.since - a.since || (a.accountId < b.accountId ? -1 : 1))
}

// 清掉池子里已经不存在的账号：删号之后台账不该一直留着它
function prune(validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || [])
  const data = load()
  let changed = false
  for (const accountId of Object.keys(data.accounts)) {
    if (!valid.has(accountId)) {
      delete data.accounts[accountId]
      changed = true
    }
  }
  if (changed) save(data)
  return changed
}

// 清缓存与文件：写测试用
function reset() {
  cache = { accounts: {} }
  try {
    fs.removeSync(paths.getAccountHealthPath())
  } catch {
    /* 文件不存在或删不掉都不影响后续断言 */
  }
}

module.exports = {
  isDisabledSignal,
  evidenceOf,
  record,
  clear,
  reasonOf,
  list,
  prune,
  reset
}
