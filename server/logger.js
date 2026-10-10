const fs = require('fs-extra')
const path = require('path')
const paths = require('./paths')

// 日志按本地日期分文件存储，避免单文件无限增长
// 老版本的 usage.log 保留兼容读取，排序时视为最旧的一份

const LOG_FILE_RE = /^usage(-\d{4}-\d{2}-\d{2})?\.log$/

function pad2(value) {
  return String(value).padStart(2, '0')
}

function getDayKey(timestamp) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function getLogFileName(timestamp = Date.now()) {
  return `usage-${getDayKey(timestamp)}.log`
}

function ensureLogDir() {
  fs.ensureDirSync(paths.getLogDir())
}

// 返回日志文件列表，按时间从新到旧排序
function listLogFiles() {
  ensureLogDir()
  const files = fs.readdirSync(paths.getLogDir()).filter(name => LOG_FILE_RE.test(name))

  return files
    .map(name => ({ name, day: name === 'usage.log' ? '' : name.slice(6, 16) }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map(item => item.name)
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function readEntriesFromFile(fileName) {
  const filePath = path.join(paths.getLogDir(), fileName)
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf-8')
  if (!content.trim()) return []
  return content.split('\n').filter(Boolean).map(parseLine).filter(Boolean)
}

function matchKeyword(entry, keyword) {
  if (!keyword) return true
  const target = `${entry.model || ''} ${entry.error || ''} ${entry.fallbackFrom || ''} ${entry.input || ''}`.toLowerCase()
  return target.includes(keyword.toLowerCase())
}

// 「重试/降级」判定：换模型降级（fallback），或任务内调用失败后最终恢复（200 且留有错误）。
// 与成功/失败是「过程经历」与「最终结果」两个维度，可同时命中（如降级后仍失败的条目）。
function isDegraded(entry) {
  return !!entry.fallback || (entry.status === 200 && !!entry.error)
}

function matchStatus(entry, statusFilter) {
  if (!statusFilter) return true
  if (statusFilter === 'success') return entry.status === 200
  if (statusFilter === 'failed') return entry.status !== 200
  if (statusFilter === 'degraded') return isDegraded(entry)
  return String(entry.status) === String(statusFilter)
}

// 从最新的日志文件往前读；带 taskKey 的多次调用按任务合并为一条（一次提问一条记录）
// 合并后再做状态/关键字过滤与条数截断，保证过滤结果与页面展示口径一致
function getLogs(options = {}) {
  const { limit = 50, model = '', status = '', keyword = '' } = options || {}
  const max = Number(limit) > 0 ? Number(limit) : 50
  const RAW_CAP = 3000 // 单次查询最多扫描的原始条数（防大文件全量解析）

  const groups = new Map() // taskKey → 原始条目（新→旧）
  const standalone = [] // 无 taskKey 的逐条记录（新→旧）
  let raw = 0

  for (const fileName of listLogFiles()) {
    const entries = readEntriesFromFile(fileName)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (model && entry.model !== model) continue
      if (entry.taskKey) {
        const list = groups.get(entry.taskKey)
        if (list) list.push(entry)
        else groups.set(entry.taskKey, [entry])
      } else {
        standalone.push(entry)
      }
      raw++
      if (raw >= RAW_CAP) break
    }
    if (raw >= RAW_CAP) break
  }

  // 组内新→旧，反转成旧→新后合并；与逐条记录一起按「末条完成时刻」倒序
  const merged = []
  for (const list of groups.values()) merged.push(mergeTaskEntries([...list].reverse()))
  merged.push(...standalone)
  merged.sort((a, b) => Date.parse(b.timestamp || 0) + (b.responseTime || 0) - (Date.parse(a.timestamp || 0) + (a.responseTime || 0)))

  const results = []
  for (const entry of merged) {
    // 标记「重试/降级」：前端徽标与筛选共用同一判定口径
    if (isDegraded(entry)) entry.degraded = true
    if (!matchStatus(entry, status)) continue
    if (!matchKeyword(entry, keyword)) continue
    results.push(entry)
    if (results.length >= max) break
  }
  return results
}

// 日志中出现过的模型列表，供前端筛选下拉使用
function getLoggedModels() {
  const models = new Set()
  for (const fileName of listLogFiles()) {
    for (const entry of readEntriesFromFile(fileName)) {
      if (entry.model) models.add(entry.model)
    }
  }
  return [...models].sort()
}

// 请求序号（面板日志顺序对齐；进程内单调递增）
let seqCounter = 0

// ===== 任务级合并（读时）=====
// 同 taskKey 的多次请求（一次提问 + 其工具循环/换号重试）在读取时合并为一条：
// 文件仍保留每次上游调用的原始记录（便于排查），页面与导出一任务一条。

// token 速率派生字段（缺失且可算时补上）
function deriveTokensPerSec(enriched) {
  if (!enriched.tokensPerSec && enriched.totalTokens > 0 && enriched.responseTime > 0) {
    enriched.tokensPerSec = Math.round((enriched.totalTokens / (enriched.responseTime / 1000)) * 10) / 10
  }
  return enriched
}

// 合并一组同任务记录（入参按时间升序）：时间/输入/模型取首条，Token 与积分累加，
// 耗时 = 末条完成 - 首条开始，任一失败即失败（状态取首个非 200、错误取首个错误），
// 账号取末条、ttfb 取首条非空；calls 记录上游调用次数；taskKey 为内部字段不出现在输出
function mergeTaskEntries(list) {
  const first = list[0]
  let acc = { ...first, calls: 1 }
  for (let i = 1; i < list.length; i++) {
    const entry = list[i]
    acc = {
      ...acc,
      status: acc.status !== 200 ? acc.status : entry.status,
      error: acc.error || entry.error,
      fallback: acc.fallback || entry.fallback || undefined,
      fallbackFrom: acc.fallbackFrom || entry.fallbackFrom,
      uid: entry.uid || acc.uid,
      uid8: entry.uid ? entry.uid8 || String(entry.uid).slice(0, 8) : acc.uid8,
      ttfbMs: acc.ttfbMs || entry.ttfbMs,
      inputTokens: (acc.inputTokens || 0) + (entry.inputTokens || 0),
      outputTokens: (acc.outputTokens || 0) + (entry.outputTokens || 0),
      cacheReadTokens: (acc.cacheReadTokens || 0) + (entry.cacheReadTokens || 0),
      cacheWriteTokens: (acc.cacheWriteTokens || 0) + (entry.cacheWriteTokens || 0),
      totalTokens: (acc.totalTokens || 0) + (entry.totalTokens || 0),
      stream: acc.stream || entry.stream || undefined,
      input: acc.input || entry.input,
      credits: (acc.credits || 0) + (entry.credits || 0) || undefined,
      tokensPerSec: undefined,
      calls: acc.calls + 1
    }
  }
  // 耗时：末条完成时刻 - 首条开始时刻（timestamp 为完成时刻，responseTime 为本次耗时）
  const firstStart = Date.parse(first.timestamp) - (first.responseTime || 0)
  const lastEnd = Date.parse(list[list.length - 1].timestamp)
  if (Number.isFinite(firstStart) && Number.isFinite(lastEnd) && lastEnd >= firstStart) {
    acc.responseTime = lastEnd - firstStart
  }
  delete acc.taskKey
  return deriveTokensPerSec(acc)
}

// ===== 日志自动清理（保留天数 + 目录总量上限）=====

const RETAIN_DAYS = 90 // 请求日志保留天数（超期文件自动删除）
const MAX_TOTAL_BYTES = 512 * 1024 * 1024 // 日志目录总量上限（512MB，超限从最旧文件删起）
const PRUNE_INTERVAL_MS = 60 * 60 * 1000 // 清理节流：最多每小时一次（写入时触发）
let lastPruneAt = 0

// 日志文件名 → 日期键（YYYY-MM-DD；无日期的旧格式 usage.log 返回空串，不参与自动清理）
function dayOfLogFile(name) {
  const m = LOG_FILE_RE.exec(name)
  return m && m[1] ? m[1].slice(1) : ''
}

// 自动清理日志：先删超期文件；目录总量超限时从最旧文件删起（最新文件永不删）
function pruneLogs(now = Date.now()) {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  const cutoffDay = getDayKey(now - RETAIN_DAYS * 86400000)
  const dir = paths.getLogDir()
  const remaining = []
  for (const name of listLogFiles()) {
    const day = dayOfLogFile(name)
    if (day && day < cutoffDay) {
      try {
        fs.removeSync(path.join(dir, name))
      } catch {
        /* 文件并发消失忽略 */
      }
      continue
    }
    try {
      remaining.push({ name, size: fs.statSync(path.join(dir, name)).size })
    } catch {
      /* 读不到大小则跳过（不计入总量） */
    }
  }
  // 总量上限：从最旧（数组尾）删到阈值以内，索引 0（最新文件）永不删
  let total = remaining.reduce((sum, f) => sum + f.size, 0)
  for (let i = remaining.length - 1; i >= 1 && total > MAX_TOTAL_BYTES; i--) {
    try {
      fs.removeSync(path.join(dir, remaining[i].name))
      total -= remaining[i].size
    } catch {
      /* 忽略 */
    }
  }
}

// 写一条请求日志（纯追加，保留每次上游调用的原始记录）；
// 带 taskKey 的记录在读取时按任务合并（一任务一条）。
// 自动补序号 / uid 前 8 位 / token 速率派生字段
function log(entry) {
  ensureLogDir()
  pruneLogs()
  seqCounter++
  const enriched = deriveTokensPerSec({ seq: seqCounter, ...(entry || {}) })
  if (enriched.uid && !enriched.uid8) enriched.uid8 = String(enriched.uid).slice(0, 8)
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...enriched })
  fs.appendFileSync(path.join(paths.getLogDir(), getLogFileName()), line + '\n')
}

function clearLogs() {
  ensureLogDir()
  for (const fileName of listLogFiles()) {
    fs.removeSync(path.join(paths.getLogDir(), fileName))
  }
}

// 日志目录占用统计：总字节数 + 文件数（供前端提示存储体积）
function getTotalSize() {
  ensureLogDir()
  let totalSize = 0
  let fileCount = 0
  for (const name of fs.readdirSync(paths.getLogDir())) {
    try {
      const stat = fs.statSync(path.join(paths.getLogDir(), name))
      if (stat.isFile()) {
        totalSize += stat.size
        fileCount++
      }
    } catch {
      /* 忽略并发消失的文件 */
    }
  }
  return { totalSize, fileCount }
}

module.exports = { log, getLogs, clearLogs, getLoggedModels, getTotalSize }
