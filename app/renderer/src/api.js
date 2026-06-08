import axios from 'axios'

const storedPort = localStorage.getItem('airoute-server-port') || '3000'

const api = axios.create({
  baseURL: `http://localhost:${storedPort}`,
  timeout: 10000
})

export function setServerPort(port) {
  localStorage.setItem('airoute-server-port', String(port))
  api.defaults.baseURL = `http://localhost:${port}`
}

export function getServerPort() {
  return localStorage.getItem('airoute-server-port') || '3000'
}

export function getState() {
  return api.get('/api/state').then(r => r.data)
}

export function setState(current) {
  return api.post('/api/state', { current }).then(r => r.data)
}

export function getProviders() {
  return api.get('/api/providers').then(r => r.data)
}

export function updateProvider(name, config) {
  return api.put(`/api/providers/${name}`, config).then(r => r.data)
}

export function deleteProvider(name) {
  return api.delete(`/api/providers/${name}`).then(r => r.data)
}

export function addProvider(name, config) {
  return api.post(`/api/providers/${name}`, config).then(r => r.data)
}

export function getLogs(limit = 50) {
  return api.get('/api/logs', { params: { limit } }).then(r => r.data)
}

// 获取请求统计（今日/总计）
export function getStats() {
  return api.get('/api/stats').then(r => r.data)
}

// Token 统计 API
export function getTokenStats() {
  return api.get('/api/token-stats').then(r => r.data)
}

export function getTokenStatsToday() {
  return api.get('/api/token-stats/today').then(r => r.data)
}

export function getTokenStatsMonth() {
  return api.get('/api/token-stats/month').then(r => r.data)
}

export function getTokenStatsByModel(modelName) {
  return api.get(`/api/token-stats/model/${modelName}`).then(r => r.data)
}

// 按时间段获取 Token 统计（days: 1, 3, 7, 15, 30）
export function getTokenStatsByPeriod(days) {
  return api.get(`/api/token-stats/period/${days}`).then(r => r.data)
}

// 获取某一天的按小时统计
export function getTokenStatsHourly(date) {
  return api.get(`/api/token-stats/hourly/${date}`).then(r => r.data)
}

// 获取单个 provider 的完整信息（含明文 apiKey）
export function getProviderFull(name) {
  return api.get(`/api/providers/${name}/full`).then(r => r.data)
}

export function getRules() {
  return api.get('/api/rules').then(r => r.data)
}

export function updateRules(rules) {
  return api.put('/api/rules', rules).then(r => r.data)
}

export function testProvider(name) {
  return api.post(`/api/providers/${name}/test`, {}, { timeout: 30000 }).then(r => r.data)
}

export function getHealth() {
  return api.get('/api/health').then(r => r.data)
}

export function getServerConfig() {
  return api.get('/api/server-config').then(r => r.data)
}

export function updateServerConfig(config) {
  return api.put('/api/server-config', config).then(r => r.data)
}

export function restartServer() {
  return api.post('/api/restart').then(r => r.data)
}

export function getFallback() {
  return api.get('/api/fallback').then(r => r.data)
}

export function updateFallback(model) {
  return api.put('/api/fallback', { model }).then(r => r.data)
}
