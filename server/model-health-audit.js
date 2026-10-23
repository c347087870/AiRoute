// 失活审计：把「渠道账号池」的外部事实折成模型的失活判定。
//
// 两类触发条件只能从这里来 —— 它们不是某一次请求的结果，而是「现在还剩多少」：
//  - 余额不足一次请求（积分用光）
//  - 渠道已经没有可用账号（全部被禁用）
//
// 数据一律现取，不缓存副本：渠道包的账号池与积分才是唯一真相（见
// server/channels/index.js 的注释）。代价是每轮审计要问一次渠道包，所以
// 有两点收敛：按渠道（不是按模型）问一次，且只问配置里真有模型的渠道；
// 查不到余额时**不下判断** —— 一次查询失败不该把整排模型藏起来。
//
// 连续失败 3 次不在这里：那是请求路径自己记账（见 model-health.noteFailure）。

const models = require('./models')
const health = require('./model-health')
const channels = require('./channels')
const workbuddy = require('./workbuddy/runtime')

// 10 分钟一轮：余额是分钟级的慢变量，而每轮都要真的去上游查积分，
// 频率再高只是替上游制造压力。
const AUDIT_INTERVAL_MS = 10 * 60 * 1000

const WORKBUDDY_PREFIXES = { workbuddy: 'cn', 'workbuddy-global': 'global' }

let timer = null
let running = null

// 配置里渠道模型的 id 第一段就是渠道包里的 provider（gemini/xxx、workbuddy/xxx），
// 和配置里的源名（channels）不是一回事
function splitBySource(refs) {
  const channelGroups = new Map()
  const wbGroups = { cn: [], global: [] }
  for (const item of refs) {
    if (!models.isChannelProvider(item.provider)) continue
    const prefix = String(item.model.id || '').split('/')[0]
    if (WORKBUDDY_PREFIXES[prefix]) {
      wbGroups[WORKBUDDY_PREFIXES[prefix]].push(item)
      continue
    }
    if (!channelGroups.has(prefix)) channelGroups.set(prefix, [])
    channelGroups.get(prefix).push(item)
  }
  return { channelGroups, wbGroups }
}

// 渠道包里各账号余额的上限。
// 返回 null 表示「没有可信读数」，调用方据此跳过余额判断：
//  - 所有账号都查不到（凭证过期 / 网络异常）≠ 余额为 0
//  - 有账号带着 error 时也跳过它：那说明这个号此刻查不了或不能用
async function bestChannelBalance(rt, providerId) {
  let reply
  try {
    // 走 channels.rpc 而不是 rt.rpc：渠道包的账号入口统一在那里，「账号被上游
    // 禁用」的证据也由它收口 —— 余额查询是唯一会主动问到每个号的定时动作，
    // 不经过它，被禁用的号要等到用户手点测试才会被标记。
    reply = await channels.rpc({ method: 'credits.balances', payload: { provider: providerId } })
  } catch {
    return null
  }
  if (reply?.ok !== true) return null
  const accounts = Array.isArray(reply.value?.accounts) ? reply.value.accounts : []
  let best = null
  for (const account of accounts) {
    if (account && typeof account.error === 'string' && account.error) continue
    const total = account?.balance?.total
    if (!Number.isFinite(total)) continue
    best = best === null ? total : Math.max(best, total)
  }
  return best
}

// 判定结果落到台账。
// 因「连续失败」失活的记录保持原原因：那是一次次真实失败换来的证据，
// 不该被一条「余额够用」的审计覆盖成健康。
function apply(ref, verdict) {
  const rec = health.stateOf(ref)
  if (verdict.offline) {
    if (rec.offline && rec.reason === 'errors') return
    health.markOffline(ref, verdict.reason, verdict.detail)
    return
  }
  // 余额读数不可信：账号确实恢复了就恢复，余额失活保持原样等下一次读数
  if (verdict.unknown) {
    if (rec.offline && rec.reason === 'account') health.revive(ref)
    return
  }
  if (rec.offline && (rec.reason === 'balance' || rec.reason === 'account')) health.revive(ref)
}

async function auditChannels(refs) {
  const rt = channels.getRuntime()
  if (!rt) return
  const { channelGroups } = splitBySource(refs)
  if (channelGroups.size === 0) return
  const providerIds = [...channelGroups.keys()].filter(id => rt.providers.includes(id))

  let statuses = {}
  try {
    // 账号计数不联网，一次问全部渠道
    const reply = await rt.rpc({ method: 'provider.status', payload: { providers: providerIds } })
    if (reply?.ok === true) statuses = reply.value?.statuses || {}
  } catch {
    /* 计数拿不到就别判账号：真实调用会给出答案 */
  }

  for (const [providerId, items] of channelGroups) {
    // 目录里已经没有这个 provider（渠道被移除/改名）：不查询、不判断
    if (!providerIds.includes(providerId)) continue
    const status = statuses[providerId]
    const accounts = status?.accounts ? { total: status.accounts.total, enabled: status.accounts.enabled } : null
    // 账号全被禁用时不必再查余额（结果一定是 0，还白花一次上游请求）
    const balance = accounts && accounts.enabled === 0 ? null : await bestChannelBalance(rt, providerId)
    for (const item of items) {
      const unit = health.stateOf(item.ref).credits
      apply(item.ref, health.judge({ accounts, balance: { best: balance, unit } }))
    }
  }
}

function auditWorkbuddy(refs) {
  const rt = workbuddy.getRuntime()
  if (!rt) return
  const { wbGroups } = splitBySource(refs)
  let accounts = []
  try {
    accounts = rt.listAccounts() || []
  } catch {
    return
  }

  for (const [realm, items] of Object.entries(wbGroups)) {
    if (items.length === 0) continue
    const list = accounts.filter(account => (account.realm || 'cn') === realm)
    const enabled = list.filter(account => !account.disabled)
    const accountsInfo = { total: list.length, enabled: enabled.length }
    // creditsTotal 为 0 表示这次进程还没拉到过这个号的积分（pool 的默认值），
    // 不是「余额为 0」；只有拉到过的号才参与余额判断
    let best = null
    for (const account of enabled) {
      if (!(account.creditsTotal > 0) || !Number.isFinite(account.credits)) continue
      best = best === null ? account.credits : Math.max(best, account.credits)
    }
    for (const item of items) {
      const unit = health.stateOf(item.ref).credits
      apply(item.ref, health.judge({ accounts: accountsInfo, balance: { best, unit } }))
    }
  }
}

// 清掉配置里已经不存在的引用（删了源/模型之后台账不该一直留着）
function prune(refs) {
  try {
    health.prune(refs.map(item => item.ref))
  } catch {
    /* 台账写失败不该拖垮审计 */
  }
}

async function run() {
  const config = models.getConfig()
  const refs = models.listModelRefs(config)
  if (refs.length === 0) {
    prune(refs)
    return { ok: true, checked: 0, offline: [] }
  }
  await auditChannels(refs)
  auditWorkbuddy(refs)
  prune(refs)
  return {
    ok: true,
    checked: refs.length,
    offline: health.list().filter(item => item.offline).map(item => ({ ...item }))
  }
}

// 并发去重：定时器与用户手动触发可能撞在一起，跑两轮除了多花上游请求没有意义
function audit() {
  if (running) return running
  running = run()
    .catch(err => {
      console.error('[aiRoute] 模型失活审计失败:', err.message)
      return { ok: false, error: err.message, offline: health.list().filter(item => item.offline) }
    })
    .finally(() => { running = null })
  return running
}

function start() {
  if (timer) return
  audit()
  timer = setInterval(() => { audit() }, AUDIT_INTERVAL_MS)
  // 审计定时器不该成为「进程退不掉」的原因
  if (timer.unref) timer.unref()
}

function stop() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

module.exports = {
  AUDIT_INTERVAL_MS,
  audit,
  start,
  stop,
  // 测试用：暴露纯函数式的分支，避免为了测一条规则拉起整个渠道运行时
  _internal: { splitBySource, apply }
}
