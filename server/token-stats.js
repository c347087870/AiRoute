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
  // 渠道 / 账号维度：用于「每个渠道的积分与 token」「每个账号的多时间窗口」
  // scope = { byDay: { day: stat }, byMonth: { month: stat }, total: stat }
  byChannel: {},
  byAccount: {},
  // 渠道·账号·模型三级明细：键为 `渠道|uid|模型`，按日留存。
  // 用量页要能按「渠道-账号-模型」看逐日消耗，渠道/账号两级聚合推不出这个组合
  byEntry: {},
  // 日志回填只做一次：记录回填当天，避免每次启动都把日志重算一遍造成重复计数
  entryBackfillDay: '',
  // 余额快照基线：{ "trae:uid": { day, usedTotal, remaining, at } }
  // 用于没有逐请求积分的渠道（Trae）按「累计已用」差分算今日消耗
  balanceBaseline: {},
  requests: []    // 最近请求明细，仅用于排查，最多保留 1000 条
}

let dirty = false
let saveTimer = null

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

function initStatObj() {
  // credits：上游逐请求回报的积分（Qoder / WorkBuddy）
  // balanceCredits：没有逐请求积分时，用余额累计已用的日差分补出来的积分（Trae）
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, count: 0, failed: 0, credits: 0, balanceCredits: 0 }
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
    credits: toNumber(source.credits),
    balanceCredits: toNumber(source.balanceCredits)
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

// 渠道 / 账号 scope：{ byDay, byMonth, total }
function normalizeScopeMap(map) {
  const out = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, value] of Object.entries(map)) {
    const scope = value && typeof value === 'object' ? value : {}
    out[key] = {
      byDay: normalizeStatMap(scope.byDay),
      byMonth: normalizeStatMap(scope.byMonth),
      total: normalizeStatObj(scope.total)
    }
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
        byChannel: normalizeScopeMap(data.byChannel),
        byAccount: normalizeScopeMap(data.byAccount),
        byEntry: normalizeScopeMap(data.byEntry),
        entryBackfillDay: typeof data.entryBackfillDay === 'string' ? data.entryBackfillDay : '',
        balanceBaseline: data.balanceBaseline && typeof data.balanceBaseline === 'object' ? data.balanceBaseline : {},
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

// 模型引用 → 渠道 + 模型名，渠道统一小写：
// 新版本写 channels/workbuddy/xxx，老版本写 WorkBuddy/xxx，两者必须归到同一个渠道，
// 否则同一个账号的历史会被拆成两条线
function parseModelRef(model) {
  const parts = String(model || '').split('/').filter(Boolean)
  if (!parts.length) return { channel: 'unknown', model: 'unknown' }
  if (parts[0] === 'channels' && parts.length >= 3) {
    return { channel: parts[1].toLowerCase(), model: parts.slice(2).join('/') }
  }
  return { channel: parts[0].toLowerCase(), model: parts.slice(1).join('/') || parts[0] }
}

function channelOf(model) {
  return parseModelRef(model).channel
}

// 三级明细的键：`渠道|uid|模型`。uid 可能为空（部分渠道的日志不带账号），
// 用固定分隔符切片，模型名里带 / 也不会切错
const ENTRY_SEP = '|'

function entryKeyOf(channel, uid, model) {
  return `${channel}${ENTRY_SEP}${uid || ''}${ENTRY_SEP}${model}`
}

function parseEntryKey(key) {
  const first = key.indexOf(ENTRY_SEP)
  const second = key.indexOf(ENTRY_SEP, first + 1)
  if (first < 0 || second < 0) return { channel: key, uid: '', model: '' }
  return {
    channel: key.slice(0, first),
    uid: key.slice(first + 1, second),
    model: key.slice(second + 1)
  }
}

function ensureScope(map, key) {
  if (!map[key]) map[key] = { byDay: {}, byMonth: {}, total: initStatObj() }
  return map[key]
}

function accumulateScope(scope, timestamp, normalized) {
  const dayKey = getDayKey(timestamp)
  const monthKey = getMonthKey(timestamp)
  if (!scope.byDay[dayKey]) scope.byDay[dayKey] = initStatObj()
  if (!scope.byMonth[monthKey]) scope.byMonth[monthKey] = initStatObj()
  accumulate(scope.byDay[dayKey], normalized)
  accumulate(scope.byMonth[monthKey], normalized)
  accumulate(scope.total, normalized)
}

// 余额累计已用（Trae 的 packages[].used 之和）的日差分 → balanceCredits。
// 同一天第一次只记基线；之后每次余额刷新把增量写进该账号/渠道的当日桶。
function recordBalanceSnapshot({ channel, uid, usedTotal, remaining, timestamp = Date.now() }) {
  if (!channel || !uid || !Number.isFinite(Number(usedTotal))) return
  const key = `${channel}:${uid}`
  const total = Number(usedTotal)
  const left = Number(remaining)
  const day = getDayKey(timestamp)
  // 即使今天还没消耗，也把账号/渠道 scope 建出来：面板要显示 0，而不是「没有这个账号」
  ensureScope(statsCache.byAccount, key)
  ensureScope(statsCache.byChannel, channel)
  const prev = statsCache.balanceBaseline[key]
  if (!prev || prev.day !== day) {
    statsCache.balanceBaseline[key] = {
      day,
      usedTotal: total,
      remaining: Number.isFinite(left) ? left : 0,
      at: timestamp
    }
    scheduleSave()
    return
  }
  const delta = Math.max(0, total - Number(prev.usedTotal || 0))
  prev.usedTotal = total
  prev.remaining = Number.isFinite(left) ? left : prev.remaining
  prev.at = timestamp
  if (delta > 0) {
    const add = target => {
      target.balanceCredits = (target.balanceCredits || 0) + delta
    }
    const accountScope = ensureScope(statsCache.byAccount, key)
    const dayKey = getDayKey(timestamp)
    const monthKey = getMonthKey(timestamp)
    if (!accountScope.byDay[dayKey]) accountScope.byDay[dayKey] = initStatObj()
    if (!accountScope.byMonth[monthKey]) accountScope.byMonth[monthKey] = initStatObj()
    add(accountScope.byDay[dayKey])
    add(accountScope.byMonth[monthKey])
    add(accountScope.total)
    const channelScope = ensureScope(statsCache.byChannel, channel)
    if (!channelScope.byDay[dayKey]) channelScope.byDay[dayKey] = initStatObj()
    if (!channelScope.byMonth[monthKey]) channelScope.byMonth[monthKey] = initStatObj()
    add(channelScope.byDay[dayKey])
    add(channelScope.byMonth[monthKey])
    add(channelScope.total)
  }
  scheduleSave()
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

  // 渠道 / 账号 / 「渠道·账号·模型」三级维度：账号来自插件 usage.uid
  // （Trae / Qoder / WorkBuddy 都会带；没带账号的请求记到空 uid 那一档）
  const ref = parseModelRef(statKey)
  const channel = ref.channel
  accumulateScope(ensureScope(statsCache.byChannel, channel), timestamp, normalized)
  const uid = typeof usage?.uid === 'string' ? usage.uid : ''
  if (uid) accumulateScope(ensureScope(statsCache.byAccount, `${channel}:${uid}`), timestamp, normalized)
  accumulateScope(ensureScope(statsCache.byEntry, entryKeyOf(channel, uid, ref.model)), timestamp, normalized)

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
  for (const map of [statsCache.byChannel, statsCache.byAccount, statsCache.byEntry]) {
    for (const scope of Object.values(map)) {
      if (!scope || typeof scope !== 'object') continue
      for (const key of Object.keys(scope.byDay || {})) {
        if (key < cutoffDayKey) { delete scope.byDay[key]; cleaned = true }
      }
      for (const key of Object.keys(scope.byMonth || {})) {
        if (key < cutoffMonthKey) { delete scope.byMonth[key]; cleaned = true }
      }
    }
  }
  for (const [key, baseline] of Object.entries(statsCache.balanceBaseline)) {
    if (!baseline || baseline.day < cutoffDayKey) { delete statsCache.balanceBaseline[key]; cleaned = true }
  }

  if (cleaned) saveStats()
}

function getAllStats() {
  return {
    byDay: statsCache.byDay,
    byMonth: statsCache.byMonth,
    byHour: statsCache.byHour,
    byModel: statsCache.byModel,
    byChannel: statsCache.byChannel,
    byAccount: statsCache.byAccount,
    byEntry: statsCache.byEntry,
    recentRequests: statsCache.requests.slice(0, 50)
  }
}

// 清空全部统计（不可恢复）：各维度归零并立即落盘，同时清掉待落盘定时器避免回写旧数据
// 回填标记保留成「已回填」：清空是用户的明确意图，重启后不该再从日志把历史捞回来
function clearAllStats() {
  statsCache = {
    byDay: {}, byMonth: {}, byHour: {}, byModel: {},
    byChannel: {}, byAccount: {}, byEntry: {}, entryBackfillDay: getDayKey(Date.now()),
    balanceBaseline: {}, requests: []
  }
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
    result.credits += Number(stats.credits) || 0
    result.balanceCredits += Number(stats.balanceCredits) || 0
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
    result.credits += Number(dayStats.credits) || 0
    result.balanceCredits += Number(dayStats.balanceCredits) || 0
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
      failed: stats.failed,
      credits: Number(stats.credits) || 0,
      balanceCredits: Number(stats.balanceCredits) || 0,
      creditsUsed: (Number(stats.credits) || 0) > 0 ? Number(stats.credits) : Number(stats.balanceCredits) || 0
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
    result.credits += Number(dayStats.credits) || 0
    result.balanceCredits += Number(dayStats.balanceCredits) || 0
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

// ── 渠道 / 账号维度：时间窗口与换算比 ──

// 一个 statObj 的展示口径：credits 是上游逐请求回报；balanceCredits 是余额差分。
// 两者取更可信的那个：有逐请求积分就用它，否则用余额差分（Trae）。
function periodView(raw) {
  const stat = normalizeStatObj(raw)
  const creditsUsed = stat.credits > 0 ? stat.credits : stat.balanceCredits
  return { ...stat, creditsUsed }
}

function daysFrom(startTs, endTs = Date.now()) {
  const out = []
  const cursor = new Date(startTs)
  cursor.setHours(12, 0, 0, 0)
  const last = new Date(endTs)
  last.setHours(12, 0, 0, 0)
  for (; cursor.getTime() <= last.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    out.push(getDayKey(cursor.getTime()))
  }
  return out
}

function monthsFrom(startYear, startMonth, now = new Date()) {
  const out = []
  const cursor = new Date(startYear, startMonth, 1)
  const end = new Date(now.getFullYear(), now.getMonth(), 1)
  while (cursor.getTime() <= end.getTime()) {
    out.push(getMonthKey(cursor.getTime()))
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return out
}

function sumDayKeys(scope, keys) {
  return sumStats(keys.map(key => scope.byDay[key]))
}

function sumMonthKeys(scope, keys) {
  return sumStats(keys.map(key => scope.byMonth[key]))
}

// 一个 scope 的六个时间窗口 + 总计
function getScopePeriods(scope) {
  if (!scope) {
    const empty = periodView(initStatObj())
    return { day: empty, threeDay: empty, week: empty, month: empty, quarter: empty, year: empty, total: empty }
  }
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const today = new Date(y, m, now.getDate())
  const weekStart = new Date(y, m, now.getDate() - ((now.getDay() + 6) % 7))
  const monthStart = new Date(y, m, 1)
  const quarterStart = new Date(y, m - 2, 1)
  const yearStart = new Date(y, 0, 1)
  const threeStart = new Date(y, m, now.getDate() - 2)

  return {
    day: periodView(scope.byDay[getDayKey(today.getTime())]),
    threeDay: periodView(sumDayKeys(scope, daysFrom(threeStart))),
    week: periodView(sumDayKeys(scope, daysFrom(weekStart))),
    month: periodView(sumMonthKeys(scope, monthsFrom(y, m))),
    quarter: periodView(sumMonthKeys(scope, monthsFrom(quarterStart.getFullYear(), quarterStart.getMonth()))),
    year: periodView(sumMonthKeys(scope, monthsFrom(y, 0))),
    total: periodView(scope.total)
  }
}

// 当前所有渠道 / 账号的统计快照：
//   { channels: { trae: { periods } }, accounts: { "trae:uid": { channel, uid, periods, balance } } }
// 渠道 / 账号的逐日序列：给「每日积分消耗 / 100 积分≈Token」趋势图用。
// 固定输出最近 N 天（没有数据补 0），前端不用自己补日期。
function buildScopeTrend(scope, days = 30) {
  const out = []
  const today = new Date()
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    const key = getDayKey(date.getTime())
    const stat = periodView(scope?.byDay?.[key] || initStatObj())
    out.push({
      date: key,
      label: `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`,
      credits: stat.creditsUsed,
      tokens: stat.total,
      tokenPer100Credits: stat.creditsUsed > 0 ? Math.round((stat.total / stat.creditsUsed) * 100) : null,
    })
  }
  return out
}

function getScopeStats() {
  const channels = {}
  for (const [id, scope] of Object.entries(statsCache.byChannel)) {
    channels[id] = { id, periods: getScopePeriods(scope), trend: buildScopeTrend(scope) }
  }
  const accounts = {}
  for (const [key, scope] of Object.entries(statsCache.byAccount)) {
    const index = key.indexOf(':')
    if (index <= 0) continue
    const channel = key.slice(0, index)
    const uid = key.slice(index + 1)
    const baseline = statsCache.balanceBaseline[key]
    accounts[key] = {
      channel,
      uid,
      periods: getScopePeriods(scope),
      trend: buildScopeTrend(scope),
      // 最近一次余额快照的剩余积分（只用于面板显示，不参与统计）
      remaining: baseline && Number.isFinite(Number(baseline.remaining)) ? Number(baseline.remaining) : null
    }
  }
  return { channels, accounts }
}

// 面板账号行用：某账号今天消耗的积分（逐请求优先，否则余额差分）
function getAccountToday(channel, uid) {
  const scope = statsCache.byAccount[`${channel}:${uid}`]
  const periods = getScopePeriods(scope)
  return periods.day
}

// 「渠道-账号-模型」三级明细的逐日序列：用量页的筛选、折线图、明细表都吃这一份。
// 固定输出最近 N 天（含今天），没数据的日期补 0，前端不用自己对齐日期
function getEntryBreakdown(days = 30) {
  const dates = []
  const today = new Date()
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    dates.push(getDayKey(date.getTime()))
  }

  const entries = []
  for (const [key, scope] of Object.entries(statsCache.byEntry)) {
    const totals = periodView(sumStats(dates.map(day => scope.byDay?.[day])))
    if (totals.count === 0 && totals.total === 0) continue
    entries.push({
      ...parseEntryKey(key),
      key,
      totals,
      series: dates.map(day => {
        const stat = periodView(scope.byDay?.[day])
        return {
          date: day,
          tokens: stat.total,
          input: stat.input,
          output: stat.output,
          cacheRead: stat.cacheRead,
          cacheWrite: stat.cacheWrite,
          credits: stat.creditsUsed,
          count: stat.count
        }
      })
    })
  }
  entries.sort((a, b) => b.totals.total - a.totals.total)
  return { days, dates, entries }
}

// 三级明细是新增维度，升级前的历史只存在于请求日志里（逐次记录 model / uid / token / 积分）。
// 首次启动回填一次，页面才不会只剩今天以后的数据；回填标记写进统计文件，重启不重复算
function backfillEntriesFromLogs() {
  if (statsCache.entryBackfillDay) return
  let raw = []
  try {
    raw = require('./logger').readAllRawEntries()
  } catch {
    return
  }
  for (const entry of raw) {
    const timestamp = Date.parse(entry?.timestamp || '')
    if (!Number.isFinite(timestamp)) continue
    const input = toNumber(entry.inputTokens)
    const output = toNumber(entry.outputTokens)
    const cacheRead = toNumber(entry.cacheReadTokens)
    const cacheWrite = toNumber(entry.cacheWriteTokens)
    const credits = toNumber(entry.credits)
    if (!input && !output && !cacheRead && !cacheWrite && !credits) continue
    const ref = parseModelRef(entry.model)
    const uid = entry.uid ? String(entry.uid) : ''
    accumulateScope(
      ensureScope(statsCache.byEntry, entryKeyOf(ref.channel, uid, ref.model)),
      timestamp,
      { input, output, cacheRead, cacheWrite, ...credits > 0 ? { credits } : {} }
    )
  }
  statsCache.entryBackfillDay = getDayKey(Date.now())
  saveStats()
}

function getHourlyDetailForDay(dateStr) {  const details = []

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
      failed: stats.failed,
      credits: Number(stats.credits) || 0,
      balanceCredits: Number(stats.balanceCredits) || 0,
      creditsUsed: (Number(stats.credits) || 0) > 0 ? Number(stats.credits) : Number(stats.balanceCredits) || 0
    })
  }

  return details
}

loadStats()
backfillEntriesFromLogs()

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
  recordBalanceSnapshot,
  getScopeStats,
  getScopePeriods,
  getAccountToday,
  getEntryBreakdown,
  channelOf,
  cleanupOldData,
  saveStats,
  flush,
  initStatObj,
  getDayKey
}
