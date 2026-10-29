const fs = require('fs-extra')
const path = require('path')
const paths = require('./paths')

const TOKEN_STATS_FILE = path.join(paths.getDataDir(), 'token-stats.json')

// 统计口径说明：
// input      = 未命中缓存的输入 token（Anthropic 的 input_tokens、OpenAI 的 prompt_tokens 扣除缓存部分）
// cacheRead  = 从缓存读取的输入 token（Anthropic cache_read_input_tokens、OpenAI prompt_tokens_details.cached_tokens）
// cacheWrite = 写入缓存的输入 token（Anthropic cache_creation_input_tokens，OpenAI 协议无此项记 0）
// output     = 输出 token
// total      = input + cacheRead + cacheWrite + output
// 所有时间维度均使用本机本地时间，避免 UTC 日期与本地小时混用导致数据错位

const RETENTION_DAYS = 35 // 按日 / 按小时明细的保留天数，需大于页面可查询的最大区间（近 30 天）
// 按月汇总单独保留 24 个月：状态面板的「本月 / 近三月 / 本年」要覆盖整个自然年，
// 而按小时明细留一年等于把文件写大几十倍（每小时一个桶）；一个月汇总只有 7 个数字，
// 留两年也就十几 KB。月份桶只在请求发生时累加，所以整月口径本来就是准的
const MONTH_RETENTION_MONTHS = 24
const MAX_REQUEST_RECORDS = 1000
const SAVE_DEBOUNCE_MS = 5000

let statsCache = {
  byDay: {},      // { "2026-09-04": statObj }
  byMonth: {},    // { "2026-09": statObj }
  byHour: {},     // { "2026-09-04-14": statObj }
  byModel: {},    // { "glm/glm-4.6": statObj }
  requests: []    // 最近请求明细，仅用于排查，最多保留 1000 条
}

let dirty = false
let saveTimer = null

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

function initStatObj() {
  // credits：按积分计费的渠道（Qoder）用它记账；token 渠道恒为 0
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, count: 0, failed: 0, credits: 0 }
}

// 补齐历史数据缺失的缓存与失败计数字段，避免 undefined 累加出 NaN
function normalizeStatObj(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    input: toNumber(source.input),
    output: toNumber(source.output),
    cacheRead: toNumber(source.cacheRead),
    cacheWrite: toNumber(source.cacheWrite),
    total: toNumber(source.total),
    count: toNumber(source.count),
    failed: toNumber(source.failed),
    credits: toNumber(source.credits)
  }
}

function normalizeStatMap(map) {
  const out = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, value] of Object.entries(map)) {
    out[key] = normalizeStatObj(value)
  }
  return out
}

// 历史文件的键沿用原样不做转换：无法从聚合键反推真实时间戳，
// 强行换算会二次错位，仅在新增数据时使用本地时间
function loadStats() {
  try {
    if (fs.existsSync(TOKEN_STATS_FILE)) {
      const data = fs.readJsonSync(TOKEN_STATS_FILE)
      statsCache = {
        byDay: normalizeStatMap(data.byDay),
        byMonth: normalizeStatMap(data.byMonth),
        byHour: normalizeStatMap(data.byHour),
        byModel: normalizeStatMap(data.byModel),
        requests: Array.isArray(data.requests) ? data.requests.slice(0, MAX_REQUEST_RECORDS) : []
      }
    }
  } catch (err) {
    console.error('Failed to load token stats:', err.message)
  }
}

function saveStats() {
  try {
    fs.writeJsonSync(TOKEN_STATS_FILE, statsCache, { spaces: 2 })
  } catch (err) {
    console.error('Failed to save token stats:', err.message)
  }
}

// 标记为脏并延迟落盘，避免每次请求都写文件；进程退出时由 exit 钩子强制保存
function scheduleSave() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flush()
  }, SAVE_DEBOUNCE_MS)
  if (typeof saveTimer.unref === 'function') saveTimer.unref()
}

function flush() {
  if (!dirty) return
  dirty = false
  saveStats()
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

// 本地日期键 (YYYY-MM-DD)
function getDayKey(timestamp) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

// 本地月份键 (YYYY-MM)
function getMonthKey(timestamp) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

// 本地小时键 (YYYY-MM-DD-HH)
function getHourKey(timestamp) {
  return `${getDayKey(timestamp)}-${pad2(new Date(timestamp).getHours())}`
}

function accumulate(target, usage) {
  target.input += usage.input
  target.output += usage.output
  target.cacheRead += usage.cacheRead
  target.cacheWrite += usage.cacheWrite
  target.total += usage.input + usage.cacheRead + usage.cacheWrite + usage.output
  target.count += 1
  if (usage.credits) target.credits = (target.credits || 0) + usage.credits
}

// 记录一次请求的 Token 用量
// usage: { input, output, cacheRead, cacheWrite, credits }，缺失字段按 0 处理
function recordTokens(model, usage, timestamp = Date.now()) {
  const input = toNumber(usage?.input)
  const output = toNumber(usage?.output)
  const cacheRead = toNumber(usage?.cacheRead)
  const cacheWrite = toNumber(usage?.cacheWrite)
  const credits = toNumber(usage?.credits)
  const normalized = { input, output, cacheRead, cacheWrite, ...credits > 0 ? { credits } : {} }
  const statKey = model || 'unknown'

  const dayKey = getDayKey(timestamp)
  const monthKey = getMonthKey(timestamp)
  const hourKey = getHourKey(timestamp)

  if (!statsCache.byDay[dayKey]) statsCache.byDay[dayKey] = initStatObj()
  if (!statsCache.byMonth[monthKey]) statsCache.byMonth[monthKey] = initStatObj()
  if (!statsCache.byHour[hourKey]) statsCache.byHour[hourKey] = initStatObj()
  if (!statsCache.byModel[statKey]) statsCache.byModel[statKey] = initStatObj()

  accumulate(statsCache.byDay[dayKey], normalized)
  accumulate(statsCache.byMonth[monthKey], normalized)
  accumulate(statsCache.byHour[hourKey], normalized)
  accumulate(statsCache.byModel[statKey], normalized)

  statsCache.requests.unshift({
    timestamp,
    model: statKey,
    ...normalized,
    totalTokens: input + cacheRead + cacheWrite + output
  })
  if (statsCache.requests.length > MAX_REQUEST_RECORDS) {
    statsCache.requests.length = MAX_REQUEST_RECORDS
  }

  scheduleSave()
}

// 记录一次失败请求，只累加计数不累加 Token
function recordFailure(model, timestamp = Date.now()) {
  const dayKey = getDayKey(timestamp)
  const monthKey = getMonthKey(timestamp)
  const hourKey = getHourKey(timestamp)

  if (!statsCache.byDay[dayKey]) statsCache.byDay[dayKey] = initStatObj()
  if (!statsCache.byMonth[monthKey]) statsCache.byMonth[monthKey] = initStatObj()
  if (!statsCache.byHour[hourKey]) statsCache.byHour[hourKey] = initStatObj()

  statsCache.byDay[dayKey].failed++
  statsCache.byMonth[monthKey].failed++
  statsCache.byHour[hourKey].failed++

  if (model) {
    if (!statsCache.byModel[model]) statsCache.byModel[model] = initStatObj()
    statsCache.byModel[model].failed++
  }

  scheduleSave()
}

// 请求数汇总，与 Token 统计同源，避免状态面板出现两个口径不一致的数字
function getRequestSummary() {
  let totalRequests = 0
  let totalFailed = 0

  for (const stats of Object.values(statsCache.byDay)) {
    totalRequests += stats.count + stats.failed
    totalFailed += stats.failed
  }

  const todayStats = statsCache.byDay[getDayKey(Date.now())] || initStatObj()

  return {
    todayRequests: todayStats.count + todayStats.failed,
    todayFailed: todayStats.failed,
    totalRequests,
    totalFailed,
    retentionDays: RETENTION_DAYS
  }
}

function cleanupOldData(retentionDays = RETENTION_DAYS) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffDayKey = getDayKey(cutoff.getTime())

  // 月汇总的裁剪口径与按日不同：跟着「近三月 / 本年」的口径走，
  // 用当前月往前推 MONTH_RETENTION_MONTHS 个月，而不是沿用 35 天前的那个月
  const monthCutoff = new Date()
  monthCutoff.setDate(1)
  monthCutoff.setMonth(monthCutoff.getMonth() - MONTH_RETENTION_MONTHS)
  const cutoffMonthKey = getMonthKey(monthCutoff.getTime())

  let cleaned = false
  for (const key of Object.keys(statsCache.byDay)) {
    if (key < cutoffDayKey) { delete statsCache.byDay[key]; cleaned = true }
  }
  for (const key of Object.keys(statsCache.byHour)) {
    if (key.slice(0, 10) < cutoffDayKey) { delete statsCache.byHour[key]; cleaned = true }
  }
  for (const key of Object.keys(statsCache.byMonth)) {
    if (key < cutoffMonthKey) { delete statsCache.byMonth[key]; cleaned = true }
  }

  if (cleaned) saveStats()
}

function getAllStats() {
  return {
    byDay: statsCache.byDay,
    byMonth: statsCache.byMonth,
    byHour: statsCache.byHour,
    byModel: statsCache.byModel,
    recentRequests: statsCache.requests.slice(0, 50)
  }
}

// 清空全部统计（不可恢复）：五个维度归零并立即落盘，同时清掉待落盘定时器避免回写旧数据
function clearAllStats() {
  statsCache = { byDay: {}, byMonth: {}, byHour: {}, byModel: {}, requests: [] }
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  dirty = false
  saveStats()
}

function getModelStats(model) {
  return statsCache.byModel[model] || initStatObj()
}

function getTodayStats() {
  return statsCache.byDay[getDayKey(Date.now())] || initStatObj()
}

function getMonthStats() {
  return statsCache.byMonth[getMonthKey(Date.now())] || initStatObj()
}

// 把多份统计累加成一份，口径与 accumulate 一致（count / failed 也一并累加）
function sumStats(list) {
  const result = initStatObj()
  for (const stats of list) {
    if (!stats) continue
    result.input += stats.input
    result.output += stats.output
    result.cacheRead += stats.cacheRead
    result.cacheWrite += stats.cacheWrite
    result.total += stats.total
    result.count += stats.count
    result.failed += stats.failed
  }
  return result
}

// 状态面板的四个时间维度：当日 / 本月 / 近三月 / 本年。
// 月维度一律用「月汇总桶」求和，而不是把按日明细加起来 —— 按日只留 35 天，
// 月初那几天会被裁掉，用日明细算「本月」会在每月头几天少一截。
// 边界都取本地自然时间：今天 0 点、本月 1 日、本年 1 月 1 日。
function getRangeStats() {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()

  const monthKeyOf = (offset) => {
    const d = new Date(year, month - offset, 1)
    return getMonthKey(d.getTime())
  }

  const thisMonth = sumStats([statsCache.byMonth[monthKeyOf(0)]])
  const lastThreeMonths = sumStats([monthKeyOf(0), monthKeyOf(1), monthKeyOf(2)].map(key => statsCache.byMonth[key]))

  // 本年：从今年 1 月累到本月。跨年的月份不在今年，直接按前缀筛
  const yearPrefix = `${year}-`
  const thisYear = sumStats(
    Object.entries(statsCache.byMonth)
      .filter(([key]) => key.startsWith(yearPrefix))
      .map(([, stats]) => stats)
  )

  return {
    day: getTodayStats(),
    week: getThisWeekStats(),
    month: thisMonth,
    quarter: lastThreeMonths,
    year: thisYear
  }
}

function getStatsByDays(days) {
  const result = initStatObj()
  const today = new Date()

  for (let i = 0; i < days; i++) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    const dayStats = statsCache.byDay[getDayKey(date.getTime())]
    if (!dayStats) continue
    result.input += dayStats.input
    result.output += dayStats.output
    result.cacheRead += dayStats.cacheRead
    result.cacheWrite += dayStats.cacheWrite
    result.total += dayStats.total
    result.count += dayStats.count
    // failed 一并累计：请求次数口径 = count + failed（与 getRequestSummary 一致，
    // 否则状态面板与 Token 统计页对「今天的请求数」会给出两个不同数字）
    result.failed += dayStats.failed
  }

  return result
}

function getRecentDaysDetail(days) {
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - (days - 1))
  return getDaysDetailBetween(start.getTime(), today.getTime())
}

// 按「本地自然日」逐天取明细，闭区间 [startTs, endTs]。
// 时间维度里的本周 / 本月 / 近三月 / 本年都从这里取：它们的起点是日历边界
// （周一、1 号、三月初、1 月 1 日），不是「往前推 N 天」，所以不能复用 getStatsByDays。
//
// 明细只有 RETENTION_DAYS 天，更早的日子已经没有数据：从保留期内最早的那天开始
// 逐天输出，图上就是一段真实的「从哪天起有数据」，而不是把缺失的日子画成 0
function getDaysDetailBetween(startTs, endTs) {
  const details = []
  const today = new Date()
  const earliest = new Date(today)
  earliest.setDate(earliest.getDate() - (RETENTION_DAYS - 1))

  const cursor = new Date(Math.max(startTs, earliest.getTime()))
  cursor.setHours(12, 0, 0, 0) // 正午起走，避开夏令时把日期跳掉
  const last = new Date(endTs)
  last.setHours(12, 0, 0, 0)

  for (; cursor.getTime() <= last.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const dayKey = getDayKey(cursor.getTime())
    const stats = statsCache.byDay[dayKey] || initStatObj()
    details.push({
      date: dayKey,
      displayDate: `${pad2(cursor.getMonth() + 1)}/${pad2(cursor.getDate())}`,
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      cacheWrite: stats.cacheWrite,
      total: stats.total,
      count: stats.count,
      failed: stats.failed
    })
  }

  return details
}

// 本周（周一 00:00 至今）。周一是中国历法习惯里的周首日；
// getDay() 里周日是 0，先 +6 再 %7 才得到「距周一几天」
function getThisWeekStats() {
  const now = new Date()
  const monday = new Date(now)
  const offsetFromMonday = (now.getDay() + 6) % 7
  monday.setDate(monday.getDate() - offsetFromMonday)
  monday.setHours(0, 0, 0, 0)

  // 与「当日 / 本月」同一口径：都从按日桶加，周内不可能跨月到影响结果的程度
  const result = initStatObj()
  const cursor = new Date(monday)
  for (; cursor.getTime() <= now.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const dayStats = statsCache.byDay[getDayKey(cursor.getTime())]
    if (!dayStats) continue
    result.input += dayStats.input
    result.output += dayStats.output
    result.cacheRead += dayStats.cacheRead
    result.cacheWrite += dayStats.cacheWrite
    result.total += dayStats.total
    result.count += dayStats.count
    result.failed += dayStats.failed
  }
  return result
}

// 时间维度的日历边界（都是本地时间）：
//   today 今天 00:00 · week 本周一 · month 本月 1 号 · quarter 近三月（含本月，往前两个月的 1 号）· year 1 月 1 日
// 汇总一律按月汇总桶算（日桶只留 35 天，跨月会少一截），明细走 getDaysDetailBetween
function getCalendarRanges() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const startOfDay = new Date(y, m, now.getDate())
  const startOfWeek = new Date(y, m, now.getDate() - ((now.getDay() + 6) % 7))
  const startOfMonth = new Date(y, m, 1)
  const startOfQuarter = new Date(y, m - 2, 1)
  const startOfYear = new Date(y, 0, 1)

  const monthsFrom = (start) => {
    const keys = []
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    const end = new Date(y, m, 1)
    while (cursor.getTime() <= end.getTime()) {
      keys.push(getMonthKey(cursor.getTime()))
      cursor.setMonth(cursor.getMonth() + 1)
    }
    return keys
  }

  return {
    today: { start: startOfDay, end: now, summary: getTodayStats() },
    week: { start: startOfWeek, end: now, summary: getThisWeekStats() },
    month: { start: startOfMonth, end: now, summary: sumStats(monthsFrom(startOfMonth).map(k => statsCache.byMonth[k])) },
    quarter: { start: startOfQuarter, end: now, summary: sumStats(monthsFrom(startOfQuarter).map(k => statsCache.byMonth[k])) },
    year: { start: startOfYear, end: now, summary: sumStats(monthsFrom(startOfYear).map(k => statsCache.byMonth[k])) }
  }
}

function getHourlyDetailForDay(dateStr) {
  const details = []

  for (let hour = 0; hour < 24; hour++) {
    const hourKey = `${dateStr}-${pad2(hour)}`
    const stats = statsCache.byHour[hourKey] || initStatObj()
    details.push({
      hour: pad2(hour),
      displayLabel: `${hour}:00`,
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      cacheWrite: stats.cacheWrite,
      total: stats.total,
      count: stats.count,
      failed: stats.failed
    })
  }

  return details
}

loadStats()

// 每天凌晨清理一次过期数据
const now = new Date()
const tomorrow = new Date(now)
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(0, 0, 0, 0)

const midnightTimer = setTimeout(() => {
  cleanupOldData()
  const dailyTimer = setInterval(() => cleanupOldData(), 24 * 60 * 60 * 1000)
  if (typeof dailyTimer.unref === 'function') dailyTimer.unref()
}, tomorrow.getTime() - now.getTime())
if (typeof midnightTimer.unref === 'function') midnightTimer.unref()

// 进程退出前把未落盘的统计写完
process.on('exit', flush)

module.exports = {
  recordTokens,
  recordFailure,
  clearAllStats,
  getRequestSummary,
  getAllStats,
  getModelStats,
  getTodayStats,
  getMonthStats,
  getRangeStats,
  getStatsByDays,
  getRecentDaysDetail,
  getDaysDetailBetween,
  getThisWeekStats,
  getCalendarRanges,
  getHourlyDetailForDay,
  cleanupOldData,
  saveStats,
  flush,
  initStatObj,
  getDayKey
}
