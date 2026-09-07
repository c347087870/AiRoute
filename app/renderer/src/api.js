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

// 探测指定端口上的 AiRoute 服务是否可用，用于改端口后确认新端口已生效
export async function probeServer(port) {
  try {
    await axios.get(`http://localhost:${port}/api/health`, { timeout: 3000 })
    return true
  } catch {
    return false
  }
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

// Provider 名称可能包含特殊字符，所有按名称寻址的接口都要编码
export function updateProvider(name, config) {
  return api.put(`/api/providers/${encodeURIComponent(name)}`, config).then(r => r.data)
}

export function deleteProvider(name) {
  return api.delete(`/api/providers/${encodeURIComponent(name)}`).then(r => r.data)
}

export function addProvider(name, config) {
  return api.post(`/api/providers/${encodeURIComponent(name)}`, config).then(r => r.data)
}

// options: { limit, model, status, keyword }
export function getLogs(options = {}) {
  const { limit = 50, model = '', status = '', keyword = '' } = options
  return api.get('/api/logs', { params: { limit, model, status, keyword } }).then(r => r.data)
}

// 日志中出现过的模型引用列表，供筛选下拉使用
export function getLogModels() {
  return api.get('/api/logs/models').then(r => r.data)
}

export function clearLogs() {
  return api.delete('/api/logs').then(r => r.data)
}

// 请求统计（今日/累计，含失败数），与 Token 统计同源
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
  return api.get(`/api/token-stats/model/${encodeURIComponent(modelName)}`).then(r => r.data)
}

// 按时间段获取 Token 统计（days: 1, 3, 7, 15, 30）
export function getTokenStatsByPeriod(days) {
  return api.get(`/api/token-stats/period/${days}`).then(r => r.data)
}

// 获取某一天的按小时统计，date 为 YYYY-MM-DD
export function getTokenStatsHourly(date) {
  return api.get(`/api/token-stats/hourly/${date}`).then(r => r.data)
}

// 获取单个 provider 的完整信息（含明文 apiKey）
export function getProviderFull(name) {
  return api.get(`/api/providers/${encodeURIComponent(name)}/full`).then(r => r.data)
}

export function getRules() {
  return api.get('/api/rules').then(r => r.data)
}

export function updateRules(rules) {
  return api.put('/api/rules', rules).then(r => r.data)
}

// model 为空时测试该 Provider 的默认模型
export function testProvider(name, model = '') {
  return api.post(`/api/providers/${encodeURIComponent(name)}/test`, { model }, { timeout: 30000 }).then(r => r.data)
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

// ==================== 模型测分 ====================

// 获取题库（首次调用会自动从内置题库复制一份到数据目录）
export function getQuestions() {
  return api.get('/api/benchmark/questions').then(r => r.data)
}

// 整体保存题库
export function saveQuestions(questions) {
  return api.put('/api/benchmark/questions', { questions }).then(r => r.data)
}

// 导入题库，mode 为 replace（整体替换）或 append（追加）
export function importQuestions(questions, mode = 'replace') {
  return api.post('/api/benchmark/questions/import', { questions, mode }).then(r => r.data)
}

// 恢复为内置题库
export function resetQuestions() {
  return api.post('/api/benchmark/questions/reset').then(r => r.data)
}

// 启动评测，返回 { runId, total }，执行在服务端后台进行
export function startBenchmark(options) {
  return api.post('/api/benchmark/run', options).then(r => r.data)
}

// 查询当前评测进度 { running, runId, total, completed }
export function getBenchmarkStatus() {
  return api.get('/api/benchmark/status').then(r => r.data)
}

// 历史评测列表（不含每题完整回答）
export function listBenchmarkRuns() {
  return api.get('/api/benchmark/runs').then(r => r.data)
}

// 单次评测详情（含每题回答，响应较大故放宽超时）
export function getBenchmarkRun(id) {
  return api.get(`/api/benchmark/runs/${encodeURIComponent(id)}`, { timeout: 30000 }).then(r => r.data)
}

export function deleteBenchmarkRun(id) {
  return api.delete(`/api/benchmark/runs/${encodeURIComponent(id)}`).then(r => r.data)
}

export function clearBenchmarkRuns() {
  return api.delete('/api/benchmark/runs').then(r => r.data)
}
