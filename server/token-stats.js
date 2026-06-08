const fs = require('fs-extra')
const path = require('path')

const DATA_DIR = process.env.AIROUTE_DATA_DIR || __dirname
const TOKEN_STATS_FILE = path.join(DATA_DIR, 'token-stats.json')

// 内存中的统计数据（用于快速查询）
let statsCache = {
  byDay: {},      // 按天统计: { "2024-01-01": { input: 0, output: 0, total: 0 } }
  byMonth: {},    // 按月统计: { "2024-01": { input: 0, output: 0, total: 0 } }
  byHour: {},     // 按小时统计: { "2024-01-01-14": { input: 0, output: 0, total: 0 } }
  byModel: {},    // 按模型统计: { "claude-opus": { input: 0, output: 0, total: 0 } }
  requests: []    // 最近请求记录（用于清理）
}

// 从文件加载历史数据
function loadStats() {
  try {
    if (fs.existsSync(TOKEN_STATS_FILE)) {
      const data = fs.readJsonSync(TOKEN_STATS_FILE)
      statsCache = { ...statsCache, ...data }
    }
  } catch (err) {
    console.error('Failed to load token stats:', err.message)
  }
}

// 保存统计数据到文件
function saveStats() {
  try {
    fs.writeJsonSync(TOKEN_STATS_FILE, statsCache, { spaces: 2 })
  } catch (err) {
    console.error('Failed to save token stats:', err.message)
  }
}

// 获取日期键 (YYYY-MM-DD)
function getDayKey(timestamp) {
  const date = new Date(timestamp)
  return date.toISOString().split('T')[0]
}

// 获取月份键 (YYYY-MM)
function getMonthKey(timestamp) {
  const date = new Date(timestamp)
  return date.toISOString().slice(0, 7)
}

// 获取小时键 (YYYY-MM-DD-HH)
function getHourKey(timestamp) {
  const date = new Date(timestamp)
  const day = date.toISOString().split('T')[0]
  const hour = String(date.getHours()).padStart(2, '0')
  return `${day}-${hour}`
}

// 初始化统计对象
function initStatObj() {
  return { input: 0, output: 0, total: 0, count: 0 }
}

// 记录一次Token使用
function recordTokens(model, inputTokens, outputTokens, timestamp = Date.now()) {
  const totalTokens = inputTokens + outputTokens
  
  const dayKey = getDayKey(timestamp)
  const monthKey = getMonthKey(timestamp)
  const hourKey = getHourKey(timestamp)
  
  // 初始化维度对象（如果不存在）
  if (!statsCache.byDay[dayKey]) statsCache.byDay[dayKey] = initStatObj()
  if (!statsCache.byMonth[monthKey]) statsCache.byMonth[monthKey] = initStatObj()
  if (!statsCache.byHour[hourKey]) statsCache.byHour[hourKey] = initStatObj()
  if (!statsCache.byModel[model]) statsCache.byModel[model] = initStatObj()
  
  // 更新各维度统计
  statsCache.byDay[dayKey].input += inputTokens
  statsCache.byDay[dayKey].output += outputTokens
  statsCache.byDay[dayKey].total += totalTokens
  statsCache.byDay[dayKey].count++
  
  statsCache.byMonth[monthKey].input += inputTokens
  statsCache.byMonth[monthKey].output += outputTokens
  statsCache.byMonth[monthKey].total += totalTokens
  statsCache.byMonth[monthKey].count++
  
  statsCache.byHour[hourKey].input += inputTokens
  statsCache.byHour[hourKey].output += outputTokens
  statsCache.byHour[hourKey].total += totalTokens
  statsCache.byHour[hourKey].count++
  
  statsCache.byModel[model].input += inputTokens
  statsCache.byModel[model].output += outputTokens
  statsCache.byModel[model].total += totalTokens
  statsCache.byModel[model].count++
  
  // 记录请求详情（保留最近1000条）
  statsCache.requests.unshift({
    timestamp,
    model,
    inputTokens,
    outputTokens,
    totalTokens
  })
  
  if (statsCache.requests.length > 1000) {
    statsCache.requests = statsCache.requests.slice(0, 1000)
  }
  
  // 定期保存到文件（每10次请求保存一次，避免频繁IO）
  if (statsCache.requests.length % 10 === 0) {
    saveStats()
  }
}

// 清理过期数据（默认保留30天）
function cleanupOldData(retentionDays = 30) {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffDayKey = getDayKey(cutoffDate.getTime())
  const cutoffMonthKey = getMonthKey(cutoffDate.getTime())
  
  let cleaned = false
  
  // 清理按天统计
  for (const key of Object.keys(statsCache.byDay)) {
    if (key < cutoffDayKey) {
      delete statsCache.byDay[key]
      cleaned = true
    }
  }
  
  // 清理按月统计
  for (const key of Object.keys(statsCache.byMonth)) {
    if (key < cutoffMonthKey) {
      delete statsCache.byMonth[key]
      cleaned = true
    }
  }
  
  // 清理按小时统计
  for (const key of Object.keys(statsCache.byHour)) {
    if (key < cutoffDayKey) {
      delete statsCache.byHour[key]
      cleaned = true
    }
  }
  
  if (cleaned) {
    saveStats()
  }
}

// 获取所有统计数据
function getAllStats() {
  return {
    byDay: statsCache.byDay,
    byMonth: statsCache.byMonth,
    byHour: statsCache.byHour,
    byModel: statsCache.byModel,
    recentRequests: statsCache.requests.slice(0, 50) // 返回最近50条
  }
}

// 获取指定模型的统计
function getModelStats(model) {
  return statsCache.byModel[model] || initStatObj()
}

// 获取今日统计
function getTodayStats() {
  const today = getDayKey(Date.now())
  return statsCache.byDay[today] || initStatObj()
}

// 获取本月统计
function getMonthStats() {
  const currentMonth = getMonthKey(Date.now())
  return statsCache.byMonth[currentMonth] || initStatObj()
}

// 获取指定天数的统计数据
function getStatsByDays(days) {
  const result = initStatObj()
  const today = new Date()
  
  for (let i = 0; i < days; i++) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    const dayKey = getDayKey(date.getTime())
    
    if (statsCache.byDay[dayKey]) {
      const dayStats = statsCache.byDay[dayKey]
      result.input += dayStats.input || 0
      result.output += dayStats.output || 0
      result.total += dayStats.total || 0
      result.count += dayStats.count || 0
    }
  }
  
  return result
}

// 获取最近N天的详细数据（用于图表）
function getRecentDaysDetail(days) {
  const details = []
  const today = new Date()
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    const dayKey = getDayKey(date.getTime())
    
    const dayStats = statsCache.byDay[dayKey] || initStatObj()
    details.push({
      date: dayKey,
      displayDate: formatDateDisplay(dayKey),
      total: dayStats.total || 0,
      count: dayStats.count || 0
    })
  }
  
  return details
}

// 获取某一天的按小时统计数据
function getHourlyDetailForDay(dateStr) {
  const details = []
  
  for (let hour = 0; hour < 24; hour++) {
    const hourKey = `${dateStr}-${String(hour).padStart(2, '0')}`
    const hourStats = statsCache.byHour[hourKey] || initStatObj()
    
    details.push({
      hour: String(hour).padStart(2, '0'),
      displayLabel: `${hour}:00`,
      total: hourStats.total || 0,
      count: hourStats.count || 0
    })
  }
  
  return details
}

// 格式化日期显示 (YYYY-MM-DD -> MM/DD)
function formatDateDisplay(dayKey) {
  const parts = dayKey.split('-')
  return `${parts[1]}/${parts[2]}`
}

// 初始化时加载历史数据
loadStats()

// 每天凌晨自动清理过期数据
const now = new Date()
const tomorrow = new Date(now)
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(0, 0, 0, 0)
const msUntilMidnight = tomorrow.getTime() - now.getTime()

setTimeout(() => {
  cleanupOldData()
  // 之后每天执行一次
  setInterval(() => cleanupOldData(), 24 * 60 * 60 * 1000)
}, msUntilMidnight)

module.exports = {
  recordTokens,
  getAllStats,
  getModelStats,
  getTodayStats,
  getMonthStats,
  getStatsByDays,
  getRecentDaysDetail,
  getHourlyDetailForDay,
  cleanupOldData,
  saveStats
}
