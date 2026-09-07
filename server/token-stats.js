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

const RETENTION_DAYS = 35 // 保留天数，需大于页面可查询的最大区间（近 30 天）
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
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, count: 0, failed: 0 }
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
    failed: toNumber(source.failed)
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
}

// 记录一次请求的 Token 用量
// usage: { input, output, cacheRead, cacheWrite }，缺失字段按 0 处理
function recordTokens(model, usage, timestamp = Date.now()) {
  const input = toNumber(usage?.input)
  const output = toNumber(usage?.output)
  const cacheRead = toNumber(usage?.cacheRead)
  const cacheWrite = toNumber(usage?.cacheWrite)
  const normalized = { input, output, cacheRead, cacheWrite }
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
  const cutoffMonthKey = getMonthKey(cutoff.getTime())

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

function getModelStats(model) {
  return statsCache.byModel[model] || initStatObj()
}

function getTodayStats() {
  return statsCache.byDay[getDayKey(Date.now())] || initStatObj()
}

function getMonthStats() {
  return statsCache.byMonth[getMonthKey(Date.now())] || initStatObj()
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
  }

  return result
}

function getRecentDaysDetail(days) {
  const details = []
  const today = new Date()

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    const dayKey = getDayKey(date.getTime())
    const stats = statsCache.byDay[dayKey] || initStatObj()
    details.push({
      date: dayKey,
      displayDate: `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`,
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      cacheWrite: stats.cacheWrite,
      total: stats.total,
      count: stats.count
    })
  }

  return details
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
      count: stats.count
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
  getRequestSummary,
  getAllStats,
  getModelStats,
  getTodayStats,
  getMonthStats,
  getStatsByDays,
  getRecentDaysDetail,
  getHourlyDetailForDay,
  cleanupOldData,
  saveStats,
  flush,
  initStatObj,
  getDayKey
}
