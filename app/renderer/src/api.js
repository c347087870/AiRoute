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

// 日志目录占用（字节数与文件数），供「日志查看」页提示存储体积
export function getLogsSize() {
  return api.get('/api/logs/size').then(r => r.data)
}

export function clearLogs() {
  return api.delete('/api/logs').then(r => r.data)
}

// 系统状态：本地版本与当前监听端口（设置页「系统状态」用）
export function getSystemStatus() {
  return api.get('/api/system/status').then(r => r.data)
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

// 清空全部 Token 统计（不可恢复）
export function clearTokenStats() {
  return api.delete('/api/stats').then(r => r.data)
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

// model 为空时测试该 Provider 的默认模型（WorkBuddy 类型走真实对话，超时放宽）
export function testProvider(name, model = '') {
  return api.post(`/api/providers/${encodeURIComponent(name)}/test`, { model }, { timeout: 120000 }).then(r => r.data)
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

// ==================== WorkBuddy 账号池 ====================

// 发起 OAuth 设备授权，返回 { ok, state, url }
export function wbOauthStart() {
  return api.post('/api/workbuddy/oauth/start', {}, { timeout: 30000 }).then(r => r.data)
}

// 轮询 OAuth 结果；data.done 为 true 表示登录完成并已热加载进池
export function wbOauthPoll(state) {
  return api.get('/api/workbuddy/oauth/poll', { params: { state }, timeout: 30000 }).then(r => r.data)
}

// 账号列表（含状态与汇总统计）
export function wbAccounts() {
  return api.get('/api/workbuddy/accounts').then(r => r.data)
}

// 移除账号（删凭证 + 出池）
export function wbRemoveAccount(uid) {
  return api.delete(`/api/workbuddy/accounts/${encodeURIComponent(uid)}`).then(r => r.data)
}

// 单号签到
export function wbCheckin(uid) {
  return api.post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/checkin`, {}, { timeout: 60000 }).then(r => r.data)
}

// 单号余额刷新
export function wbRefreshBalance(uid) {
  return api.post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/balance`, {}, { timeout: 60000 }).then(r => r.data)
}

// 单号 token 保活
export function wbKeepalive(uid) {
  return api.post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/keepalive`, {}, { timeout: 60000 }).then(r => r.data)
}

// 解冻 / 复活账号
export function wbRevive(uid) {
  return api.post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/revive`, {}).then(r => r.data)
}

// 人工禁用账号（保留凭证与状态，仅退出轮转）
export function wbDisable(uid, reason) {
  return api.post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/disable`, { reason }).then(r => r.data)
}

// 人工恢复启用（只清禁用，不动冷却/熔断）
export function wbEnable(uid) {
  return api.post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/enable`, {}).then(r => r.data)
}

// 全量余额刷新
export function wbRefreshAllBalances() {
  return api.post('/api/workbuddy/accounts/refresh-balances', {}, { timeout: 120000 }).then(r => r.data)
}

// 上游模型列表；refresh 为 true 时强制刷新缓存
export function wbModels(refresh = false) {
  return api.get('/api/workbuddy/models', { params: refresh ? { refresh: 1 } : {}, timeout: 60000 }).then(r => r.data)
}

// 池统计与账号状态
export function wbStatus() {
  return api.get('/api/workbuddy/status').then(r => r.data)
}

// 单账号成长任务列表（含进度与奖励）
export function wbTaskList(uid) {
  return api.get(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/tasks`, { timeout: 60000 }).then(r => r.data)
}

// 一键完成成长任务；taskCode 为空表示跑全部可自动化任务
export function wbTaskRun(uid, taskCode = '') {
  return api
    .post(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/tasks/run`, { taskCode }, { timeout: 600000 })
    .then(r => r.data)
}

// 任务执行进度快照
export function wbTaskProgress() {
  return api.get('/api/workbuddy/tasks/progress').then(r => r.data)
}

// 全账号任务扫描
export function wbTaskScan() {
  return api.get('/api/workbuddy/tasks/scan', { timeout: 120000 }).then(r => r.data)
}

// 全账号任务扫描（POST 变体，返回含 pending_count 汇总）
export function wbTaskScanAll() {
  return api.post('/api/workbuddy/tasks/scan_all', {}, { timeout: 120000 }).then(r => r.data)
}

// 接受任务：taskCodes 为空则接受该账号全部未接受任务
export function wbTaskAccept(uid, taskCodes = []) {
  return api.post('/api/workbuddy/tasks/accept', { uid, taskCodes }, { timeout: 120000 }).then(r => r.data)
}

// 全账号接受全部未接受任务（uids 为空则全部非禁用账号）
export function wbTaskAcceptAll(uids = []) {
  return api.post('/api/workbuddy/tasks/accept_all', { uids }, { timeout: 300000 }).then(r => r.data)
}

// 单独领取某任务奖励
export function wbTaskClaim(uid, taskCode) {
  return api.post('/api/workbuddy/tasks/claim', { uid, taskCode }, { timeout: 60000 }).then(r => r.data)
}

// 启动多账号执行队列（payload: { uids?, taskCodes?, concurrency? }）
export function wbTaskRunQueue(payload = {}) {
  return api.post('/api/workbuddy/tasks/run_queue', payload, { timeout: 600000 }).then(r => r.data)
}

// 队列状态快照（前端轮询）
export function wbTaskQueue() {
  return api.get('/api/workbuddy/tasks/queue').then(r => r.data)
}

// 单账号积分构成明细（批次：名称 / 剩余 / 总额 / 到期时间）
export function wbCreditPackages(uid) {
  return api.get(`/api/workbuddy/accounts/${encodeURIComponent(uid)}/credits`, { timeout: 60000 }).then(r => r.data)
}

// 用量 / 积分消耗统计（hours 默认 72，上限 1440，0 = 全历史；today/yesterday 为本地自然日窗口）
export function wbUsage(hours = 72) {
  return api.get('/api/workbuddy/usage', { params: { hours } }).then(r => r.data)
}

// 立即落盘用量数据
export function wbUsageSave() {
  return api.post('/api/workbuddy/usage/save', {}).then(r => r.data)
}

// 积分变动流水（新的在前；limit 默认 50 上限 1000；uid 精确过滤；offset 翻页）
export function wbCreditHistory({ limit = 50, uid = '', offset = 0 } = {}) {
  return api.get('/api/workbuddy/credit-history', { params: { limit, uid, offset } }).then(r => r.data)
}

// 账号池统一维护的启用模型清单
export function wbEnabledModels() {
  return api.get('/api/workbuddy/models/enabled').then(r => r.data)
}

// 保存启用模型清单（自动同步写入所有 workbuddy Provider）
export function wbSaveEnabledModels(models) {
  return api.post('/api/workbuddy/models/enabled', { models }, { timeout: 60000 }).then(r => r.data)
}

// WorkBuddy 运行日志（channel: chat / task / system）
export function wbLogs(options = {}) {
  const { channel = '', level = '', keyword = '', limit = 200 } = options
  return api.get('/api/workbuddy/logs', { params: { channel, level, keyword, limit } }).then(r => r.data)
}

// WorkBuddy 运行时配置（提示词模式 / 指纹脱敏开关 / 全局路由开关 / 池参数）
export function wbConfig() {
  return api.get('/api/workbuddy/config').then(r => r.data)
}

// 修改运行时配置（热生效并持久化到 server-config.json）
export function wbUpdateConfig(patch) {
  return api.put('/api/workbuddy/config', patch).then(r => r.data)
}

// 定时任务状态（开关 / 时点 / 最近执行）
export function wbScheduler() {
  return api.get('/api/workbuddy/scheduler').then(r => r.data)
}

// 手动触发单类定时任务（checkin / travel / activity / keepalive / blackcat / balance）
export function wbSchedulerRun(task) {
  return api.post('/api/workbuddy/scheduler/run', { task }, { timeout: 600000 }).then(r => r.data)
}

// 修改排程（时点 / 开关 / 余额刷新间隔）
export function wbSchedulerUpdate(patch) {
  return api.put('/api/workbuddy/scheduler', patch).then(r => r.data)
}

// ==================== 更新检查 ====================

// 查询最新版本；force 为 true 时跳过服务端 30 分钟缓存（手动检查用）
export function checkUpdate(force = false) {
  return api.get('/api/update/check', { params: force ? { force: 1 } : {} }).then(r => r.data)
}

// 启动应用内下载（tag + 保存路径），返回初始下载状态
export function startUpdateDownload(tag, savePath) {
  return api.post('/api/update/download', { tag, savePath }).then(r => r.data)
}

// 下载进度快照（前端轮询）
export function getUpdateProgress() {
  return api.get('/api/update/download/progress').then(r => r.data)
}
