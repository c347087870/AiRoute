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
  const target = `${entry.model || ''} ${entry.error || ''} ${entry.fallbackFrom || ''}`.toLowerCase()
  return target.includes(keyword.toLowerCase())
}

function matchStatus(entry, statusFilter) {
  if (!statusFilter) return true
  if (statusFilter === 'success') return entry.status === 200
  if (statusFilter === 'failed') return entry.status !== 200
  return String(entry.status) === String(statusFilter)
}

// 从最新的日志文件往前读，凑够 limit 条即停止，避免每次全量解析历史
function getLogs(options = {}) {
  const { limit = 50, model = '', status = '', keyword = '' } = options || {}
  const max = Number(limit) > 0 ? Number(limit) : 50
  const results = []

  for (const fileName of listLogFiles()) {
    const entries = readEntriesFromFile(fileName)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (model && entry.model !== model) continue
      if (!matchStatus(entry, status)) continue
      if (!matchKeyword(entry, keyword)) continue
      results.push(entry)
      if (results.length >= max) return results
    }
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

function log(entry) {
  ensureLogDir()
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  }) + '\n'
  fs.appendFileSync(path.join(paths.getLogDir(), getLogFileName()), line)
}

function clearLogs() {
  ensureLogDir()
  for (const fileName of listLogFiles()) {
    fs.removeSync(path.join(paths.getLogDir(), fileName))
  }
}

module.exports = { log, getLogs, clearLogs, getLoggedModels }
