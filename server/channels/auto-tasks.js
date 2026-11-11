// 渠道账号的自动维护：每日自动签到 + 积分余额定期刷新
//
// 为什么定时器放在宿主而不是插件：插件只负责「怎么签 / 怎么查余额」，
// 「什么时候跑」是宿主的事 —— 各家插件各带一套定时器，装/卸时还要各自清理，
// 而宿主本来就统一持有运行时生命周期（init / reloadPlugins / shutdown）。
//
// 自动签到只覆盖 Trae 与 Qoder 国内版：
//   · Trae 的签到按自然日重置（checkin_credits/status 的 checked_in）；
//   · Qoder 国内版的活动窗口是 UTC+8 10:00（见 protocol.nextCheckinWindow）。
// 时点默认 10 点（10:05 起跑，等 Qoder 新活动发布）；Trae 不受时点影响。
// 启动时会补签（进程晚于时点启动也能签上），失败按 30 分钟重试，最多 3 次。
//
// 积分刷新对「插件实现了 balance()」的所有渠道生效（由 provider.status 回答），
// 默认每 30 分钟一次；0 表示关闭，只剩面板的手动刷新按钮。

const fs = require('fs')
const path = require('path')

const FILE = 'channel-auto-tasks.json'
const TICK_MS = 60 * 1000
// 启动后先让目录刷新跑完，再开始第一轮：首轮会真的去上游签到
const FIRST_TICK_DELAY_MS = 15 * 1000
const CHECKIN_RETRY_MS = 30 * 60 * 1000
const CHECKIN_MAX_ATTEMPTS = 3
const AUTO_CHECKIN_PROVIDERS = ['trae', 'qodercn']
const DEFAULT_CHECKIN_HOUR = 10
const DEFAULT_BALANCE_MINUTES = 30
// 到点后再等 5 分钟：Qoder 的活动窗口在 10:00 整点切换，服务端发布新活动可能
// 晚几秒；踩着 10:00:00 去查会拿到「没有可领取的活动」，然后当天就不再重试了。
const CHECKIN_MINUTE_OFFSET = 5

// 「今天」按 UTC+8 算：Qoder 的活动窗口固定 UTC+8 10:00，Trae 官方客户端也是按
// 北京时间的 dayKey 判跨天（反编译 workbench 里的 beijingDayKey）。用系统时区
// 会在改过时区的机器上提前/延后一天签到。
const UTC8_OFFSET_MS = 8 * 3600 * 1000
// Qoder 每日领取窗口的起始小时（UTC+8）；与 plugins/qoder/protocol.js 的
// CHECKIN_WINDOW_HOUR 同值。宿主不 require 插件内部常量，改动时两处一起看。
const QODER_WINDOW_HOUR = 10

function dayKeyOf(ms) {
  return new Date(ms + UTC8_OFFSET_MS).toISOString().slice(0, 10)
}

// Qoder 的「今天」是活动窗口：UTC+8 10:00 才算新的一天。用日历日的话，把签到
// 时点设在 10 点前会在凌晨把「昨天窗口已领」记成今天已签，10 点后反而不签了。
function qoderDayKeyOf(ms) {
  return new Date(ms + UTC8_OFFSET_MS - QODER_WINDOW_HOUR * 3600 * 1000).toISOString().slice(0, 10)
}

function dayKeyFor(provider, ms) {
  return provider === 'qodercn' ? qoderDayKeyOf(ms) : dayKeyOf(ms)
}

function utc8HourOf(ms) {
  return new Date(ms + UTC8_OFFSET_MS).getUTCHours()
}

function checkinHourOf(cfg) {
  const value = Number(cfg?.autoCheckinHour)
  if (!Number.isFinite(value)) return DEFAULT_CHECKIN_HOUR
  return Math.min(23, Math.max(0, Math.round(value)))
}

function balanceMinutesOf(cfg) {
  const value = Number(cfg?.balanceRefreshMinutes)
  if (!Number.isFinite(value)) return DEFAULT_BALANCE_MINUTES
  return Math.min(1440, Math.max(0, Math.round(value)))
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir            渠道数据目录（状态文件落这里）
 * @param {(body:object)=>Promise<any>} deps.rpc  宿主 RPC（走 channels.rpc，账号证据才会被收口）
 * @param {object} deps.settings           settings.js 的读写器
 * @param {()=>string[]} deps.providers    当前装着的 provider
 * @param {object} [deps.logger]
 * @param {()=>number} [deps.now]          测试注入的时钟
 */
function createAutoTasks({ dataDir, rpc, settings, providers, logger = console, now = () => Date.now() }) {
  const file = path.join(dataDir, FILE)
  let state = readState()
  let timer = null
  let firstTimer = null
  let running = null

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        checkin: parsed?.checkin && typeof parsed.checkin === 'object' ? parsed.checkin : {},
        balance: parsed?.balance && typeof parsed.balance === 'object' ? parsed.balance : {},
      }
    } catch {
      return { checkin: {}, balance: {} }
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, file)
    } catch (error) {
      logger.warn?.(`[channels] 自动任务状态落盘失败：${error.message}`)
    }
  }

  function cfgOf(provider) {
    if (typeof settings?.forProvider === 'function') return settings.forProvider(provider) || {}
    if (typeof settings?.get === 'function') return settings.get() || {}
    return {}
  }

  async function statusesOf() {
    try {
      const reply = await rpc({ method: 'provider.status', payload: {} })
      return reply?.ok === true ? reply.value?.statuses || {} : {}
    } catch (error) {
      logger.warn?.(`[channels] 自动任务读取渠道状态失败：${error.message}`)
      return {}
    }
  }

  // 是否到了今天的签到时点：到了才跑，过了时点启动的（补签）同样成立
  function checkinDue(provider, at) {
    const cfg = cfgOf(provider)
    if (cfg.autoCheckin === false) return false
    const hour = checkinHourOf(cfg)
    const currentHour = utc8HourOf(at)
    const currentMinute = new Date(at + UTC8_OFFSET_MS).getUTCMinutes()
    if (currentHour < hour) return false
    if (currentHour === hour && currentMinute < CHECKIN_MINUTE_OFFSET) return false
    const day = dayKeyFor(provider, at)
    const record = state.checkin[provider]
    if (!record || record.day !== day) return true
    if (record.done) return false
    if ((Number(record.attempts) || 0) >= CHECKIN_MAX_ATTEMPTS) return false
    return at - (Number(record.at) || 0) >= CHECKIN_RETRY_MS
  }

  async function runCheckin(provider) {
    const day = dayKeyFor(provider, now())
    const previous = state.checkin[provider]
    const record = previous && previous.day === day
      ? { ...previous }
      : { day, attempts: 0, done: false, at: 0 }
    record.attempts = (Number(record.attempts) || 0) + 1
    record.at = now()
    state.checkin[provider] = record
    saveState()

    // 今天所有账号都签过就不要再打上游：credits.claimAll 内部会逐号查状态，
    // 全签过的账号每个也要一次请求，纯属白花。
    let accounts = []
    try {
      const reply = await rpc({ method: 'account.list', payload: { provider } })
      if (reply?.ok === true && Array.isArray(reply.value)) accounts = reply.value
    } catch (error) {
      logger.warn?.(`[channels] 自动签到 ${provider} 读取账号失败：${error.message}`)
    }
    if (accounts.length > 0 && accounts.every(account => account.checkinDone === true)) {
      record.done = true
      saveState()
      return
    }

    try {
      const reply = await rpc({ method: 'credits.claimAll', payload: { provider } })
      if (reply?.ok !== true) {
        logger.warn?.(`[channels] 自动签到 ${provider} 失败：${reply?.error || '未知错误'}`)
        return
      }
      const summary = reply.value?.summary || {}
      const failed = Number(summary.failed) || 0
      record.done = failed === 0
      saveState()
      logger.info?.(
        `[channels] 自动签到 ${provider}：领取 ${summary.claimed || 0}，已领 ${summary.alreadyClaimed || 0}，` +
          `未开通 ${summary.inactive || 0}，失败 ${failed}`,
      )
    } catch (error) {
      logger.warn?.(`[channels] 自动签到 ${provider} 异常：${error.message}`)
    }
  }

  function balanceDue(provider, at) {
    const minutes = balanceMinutesOf(cfgOf(provider))
    if (minutes <= 0) return false
    const last = Number(state.balance[provider]) || 0
    return at - last >= minutes * 60 * 1000
  }

  async function runBalance(provider, at) {
    // 先记时刻再查：查询失败也不该每条 tick 都重试，下一次间隔到了再说
    state.balance[provider] = at
    saveState()
    try {
      const reply = await rpc({ method: 'credits.balances', payload: { provider } })
      if (reply?.ok !== true) logger.warn?.(`[channels] 积分刷新 ${provider} 失败：${reply?.error || '未知错误'}`)
    } catch (error) {
      logger.warn?.(`[channels] 积分刷新 ${provider} 异常：${error.message}`)
    }
  }

  async function run() {
    const at = now()
    const installed = providers()
    const statuses = await statusesOf()

    for (const provider of AUTO_CHECKIN_PROVIDERS) {
      if (!installed.includes(provider)) continue
      const status = statuses[provider]
      if (!status || status.capabilities?.checkin !== true) continue
      if (status.accounts && status.accounts.total === 0) continue
      if (!checkinDue(provider, at)) continue
      await runCheckin(provider)
    }

    for (const provider of installed) {
      const status = statuses[provider]
      if (!status || status.capabilities?.balance !== true) continue
      if (status.accounts && status.accounts.total === 0) continue
      if (!balanceDue(provider, at)) continue
      await runBalance(provider, at)
    }
  }

  // 定时器与手动触发可能撞在一起：跑两轮只会替上游多制造几次请求
  function tick() {
    if (running) return running
    running = run()
      .catch(error => logger.warn?.(`[channels] 自动任务异常：${error.message}`))
      .finally(() => { running = null })
    return running
  }

  function start() {
    if (timer) return
    state = readState()
    timer = setInterval(() => { void tick() }, TICK_MS)
    if (timer.unref) timer.unref()
    firstTimer = setTimeout(() => { void tick() }, FIRST_TICK_DELAY_MS)
    if (firstTimer.unref) firstTimer.unref()
  }

  function stop() {
    if (timer) clearInterval(timer)
    if (firstTimer) clearTimeout(firstTimer)
    timer = null
    firstTimer = null
  }

  return {
    start,
    stop,
    tick,
    // 只读快照（测试与排查用：看今天哪家签过、上次余额是什么时候查的）
    state: () => JSON.parse(JSON.stringify(state)),
  }
}

module.exports = {
  createAutoTasks,
  AUTO_CHECKIN_PROVIDERS,
  DEFAULT_CHECKIN_HOUR,
  DEFAULT_BALANCE_MINUTES,
  CHECKIN_MAX_ATTEMPTS,
  CHECKIN_RETRY_MS,
  _internal: { dayKeyOf, qoderDayKeyOf, dayKeyFor, utc8HourOf, checkinHourOf, balanceMinutesOf },
}
