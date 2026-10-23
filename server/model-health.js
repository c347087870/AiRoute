// 模型健康台账：谁「失活」了、为什么、还能不能恢复。
//
// ## 为什么需要一层自己的台账
//
// 渠道包只记录「上游明确说这个模型不存在」（它自己的 dead-models.json，TTL 30 天），
// 那是上游侧的事实。而「连续报错 3 次 / 余额不足一次 / 账号全被禁用」是**网关侧**的
// 判断，通用 Provider 同样适用，而且必须能在界面上看到原因、手动恢复。渠道包产物
// 由上游生成（见 .agents/skills/channels），把这类策略塞进去等于每次重生成都丢一遍。
//
// ## 失活只做一件事：把请求从这里挪走
//
// 不删配置、不改引用 —— `/v1/models` 不再播报它，建链时跳过它，恢复后原样回来。
// 路由规则、兜底、当前模型里的引用因此不会失效（引用失效才会让人无从下手）。
//
// ## 三种原因，三种恢复方式
//
// - `errors`：连续失败 3 次。只有「再成功一次」或人工恢复才清 —— 它已经不接请求了，
//   所以实际触发恢复的是手动测试通过 / 界面按钮。
// - `balance`：剩余额度不足一次请求。余额是外部事实，会自己变好，所以审计里
//   一旦算出「够用」就自动恢复。
// - `account`：该渠道没有可用账号。同上，账号恢复可用后自动恢复。
//
// 状态文件是运行数据（`model-health.json`），不进仓库。

const fs = require('fs-extra')
const paths = require('./paths')

// 连续失败多少次判定失活。3 次是用户口径：一次抖动、一次上游 5xx 都还算正常，
// 连着 3 次就该让位给别的模型，而不是让每个请求都先撞一次墙。
const OFFLINE_AFTER_FAILURES = 3

const FILE_VERSION = 1

function emptyRecord() {
  return {
    offline: false,
    reason: '',
    detail: '',
    since: 0,
    failures: 0,
    // 最近一次成功请求消耗的额度：用来回答「余额还够不够一次请求」。
    // 渠道包不报每请求消耗（只有 WorkBuddy 报），所以这里可能是 0 = 未知
    credits: 0,
    updatedAt: 0
  }
}

function sanitize(raw) {
  const rec = emptyRecord()
  if (!raw || typeof raw !== 'object') return rec
  rec.offline = raw.offline === true
  rec.reason = typeof raw.reason === 'string' ? raw.reason : ''
  rec.detail = typeof raw.detail === 'string' ? raw.detail : ''
  rec.since = Number.isFinite(raw.since) ? raw.since : 0
  rec.failures = Number.isFinite(raw.failures) && raw.failures > 0 ? Math.floor(raw.failures) : 0
  rec.credits = Number.isFinite(raw.credits) && raw.credits > 0 ? raw.credits : 0
  rec.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  return rec
}

// 内存缓存：建链时每个请求都要问「它是否失活」，不能每次都读盘。
// 这个进程是唯一写入者，所以缓存不会和文件打架。
let cache = null

function load() {
  if (cache) return cache
  let models = {}
  try {
    const file = paths.getModelHealthPath()
    if (fs.existsSync(file)) {
      const raw = fs.readJsonSync(file)
      const source = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' ? raw.models : {}
      for (const [ref, value] of Object.entries(source)) {
        if (!ref || typeof value !== 'object' || value === null) continue
        models[ref] = sanitize(value)
      }
    }
  } catch {
    // 文件坏了按「没有任何失活」处理：宁可让请求多试一次，也不要凭一份读不出的
    // 文件把模型全藏起来（那样用户连界面上的恢复入口都找不到原因）
    models = {}
  }
  cache = { models }
  return cache
}

function save(data) {
  const file = paths.getModelHealthPath()
  fs.ensureDirSync(paths.getDataDir())
  fs.writeJsonSync(file, { version: FILE_VERSION, models: data.models }, { spaces: 2 })
}

function stateOf(ref) {
  const rec = load().models[ref]
  return rec ? { ...rec } : emptyRecord()
}

function isOffline(ref) {
  const rec = load().models[ref]
  return !!(rec && rec.offline === true)
}

// 全部记录（含已恢复的历史？不 —— 恢复即清空标记，但记录本身留着记账）
function list() {
  const { models } = load()
  return Object.entries(models)
    .map(([ref, rec]) => ({ ref, ...rec }))
    .sort((a, b) => b.since - a.since || (a.ref < b.ref ? -1 : 1))
}

// 只有失活的那部分：界面与 /v1/models 用
function offlineRefs() {
  const out = new Set()
  for (const [ref, rec] of Object.entries(load().models)) {
    if (rec.offline) out.add(ref)
  }
  return out
}

function update(ref, patch) {
  const data = load()
  const next = { ...emptyRecord(), ...(data.models[ref] || {}), ...patch, updatedAt: Date.now() }
  data.models[ref] = next
  save(data)
  return { ...next }
}

function markOffline(ref, reason, detail = '') {
  const rec = stateOf(ref)
  // 同因重复标记不写盘：审计每 10 分钟跑一次，不该每次都改文件时间戳
  if (rec.offline && rec.reason === reason) return rec
  return update(ref, { offline: true, reason, detail, since: Date.now() })
}

function revive(ref) {
  const rec = stateOf(ref)
  if (!rec.offline && rec.failures === 0) return rec
  return update(ref, { offline: false, reason: '', detail: '', since: 0, failures: 0 })
}

// 连续失败 +1；到达阈值就地失活。errorDetail 写进台账只为排障，不参与判断。
function noteFailure(ref, errorDetail = '') {
  if (!ref) return null
  const rec = stateOf(ref)
  if (rec.offline) return rec // 已经不接请求了，再计数只会把原因覆盖掉
  const failures = rec.failures + 1
  if (failures >= OFFLINE_AFTER_FAILURES) {
    return markOffline(ref, 'errors', `连续 ${failures} 次失败：${errorDetail || '未知错误'}`)
  }
  return update(ref, { failures })
}

// 成功一次：清零连续失败。因「连续失败」失活的记录随之恢复 —— 能成功就说明
// 这条链路此刻是通的（手动测试通过走的也是这里）。
// credits 是本次消耗（只有 WorkBuddy 报），用作「一次请求要花多少」的样本。
function noteSuccess(ref, credits) {
  if (!ref) return null
  const rec = stateOf(ref)
  const unit = Number.isFinite(credits) && credits > 0 ? credits : rec.credits
  const revivable = rec.offline && rec.reason === 'errors'
  // 没有任何变化就不写盘：成功是最频繁的事件，不能每个请求都写一次文件
  if (!revivable && rec.failures === 0 && unit === rec.credits) return rec
  return update(ref, {
    failures: 0,
    credits: unit,
    ...revivable ? { offline: false, reason: '', detail: '', since: 0 } : {}
  })
}

/**
 * 单次审计的纯判断：这个渠道此刻还能不能接一次请求。
 *
 * @param {object} input
 * @param {{ total: number, enabled: number }} input.accounts 账号计数（渠道包口径）
 * @param {{ best: number|null, unit: number }} input.balance 可用余额上限与「一次请求」的估计成本
 * @returns {{ offline: boolean, unknown?: boolean, reason?: string, detail?: string }}
 */
function judge({ accounts, balance } = {}) {
  if (accounts && accounts.total > 0 && accounts.enabled === 0) {
    return { offline: true, reason: 'account', detail: '该渠道没有可用账号（全部被禁用）' }
  }
  const best = balance?.best
  const unit = balance?.unit || 0
  // 余额读数不可信（查不到 / 该渠道不报积分）：只能确认账号层面没问题，
  // 不能替已有的「余额不足」失活翻案 —— 否则一次查询失败就会把整排模型放回来
  if (best === null || best === undefined) return { offline: false, unknown: true }
  if (best <= 0) return { offline: true, reason: 'balance', detail: '剩余额度为 0，不足一次请求' }
  if (unit > 0 && best < unit) {
    return { offline: true, reason: 'balance', detail: `剩余额度 ${best}，不足一次请求（上次消耗 ${unit}）` }
  }
  return { offline: false }
}

// 清掉配置里已经不存在的引用：删了 Provider / 模型之后，台账不该一直留着它们
function prune(validRefs) {
  const valid = validRefs instanceof Set ? validRefs : new Set(validRefs || [])
  const data = load()
  let changed = false
  for (const ref of Object.keys(data.models)) {
    const rec = data.models[ref]
    if (!valid.has(ref) || (!rec.offline && rec.failures === 0 && rec.credits === 0)) {
      delete data.models[ref]
      changed = true
    }
  }
  if (changed) save(data)
  return changed
}

// 清缓存与文件：写测试用
function reset() {
  cache = { models: {} }
  try {
    fs.removeSync(paths.getModelHealthPath())
  } catch {
    /* 文件不存在或删不掉都不影响后续断言 */
  }
}

module.exports = {
  OFFLINE_AFTER_FAILURES,
  stateOf,
  isOffline,
  list,
  offlineRefs,
  markOffline,
  revive,
  noteFailure,
  noteSuccess,
  judge,
  prune,
  reset
}
