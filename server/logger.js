const fs = require('fs-extra')
const path = require('path')

const DATA_DIR = process.env.AIROUTE_DATA_DIR || __dirname
const LOG_DIR = path.join(DATA_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'usage.log')

function ensureLogDir() {
  fs.ensureDirSync(LOG_DIR)
}

function sanitizeHeaders(headers) {
  const sanitized = { ...headers }
  if (sanitized.Authorization) sanitized.Authorization = '***'
  if (sanitized['x-api-key']) sanitized['x-api-key'] = '***'
  if (sanitized['anthropic-version']) delete sanitized['anthropic-version']
  return sanitized
}

function log(entry) {
  ensureLogDir()
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  }) + '\n'
  fs.appendFileSync(LOG_FILE, line)
}

function getLogs(limit = 50) {
  ensureLogDir()
  if (!fs.existsSync(LOG_FILE)) return []
  const content = fs.readFileSync(LOG_FILE, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)
  const parsed = lines.map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  return parsed.slice(-limit).reverse()
}

module.exports = { log, getLogs, sanitizeHeaders }
