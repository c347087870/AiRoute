// WorkBuddy 上游 HTTP 客户端：OAuth、token 刷新、聊天转发、签到/余额/模型/成长域调用

const axios = require('axios')
const http = require('http')
const https = require('https')
const { StringDecoder } = require('string_decoder')
const C = require('./constants')
const headersMod = require('./headers')
const errMod = require('./errors')
const catalog = require('./catalog')

// ===== 基础 HTTP =====

// 连接层加固：keepAlive 复用 + 15s keepalive 探测 + 空闲池上限。
// 说明：Node 无 ResponseHeaderTimeout 等价项，聊天首字节上限在 chatStream 用 AbortController 实现
const keepAliveHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: C.TRANSPORT_DEFAULTS.keepAliveMsecs,
  maxSockets: C.TRANSPORT_DEFAULTS.maxSockets,
  maxFreeSockets: C.TRANSPORT_DEFAULTS.maxFreeSockets
})
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: C.TRANSPORT_DEFAULTS.keepAliveMsecs,
  maxSockets: C.TRANSPORT_DEFAULTS.maxSockets,
  maxFreeSockets: C.TRANSPORT_DEFAULTS.maxFreeSockets
})

// 传输层失败后清空空闲连接池：死连接可能仍留在空闲池里，
// 等超时才过期，下一个请求会继续捡到它；只销毁空闲 socket，不影响在途请求
function purgeIdleSockets() {
  for (const agent of [keepAliveHttpAgent, keepAliveHttpsAgent]) {
    const free = agent.freeSockets || {}
    for (const key of Object.keys(free)) {
      for (const sock of free[key] || []) {
        try {
          sock.destroy()
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}

// 发送请求（非流式）：返回 { status, text, headers }
async function send(cfg) {
  const res = await axios({
    method: cfg.method || 'POST',
    url: cfg.url,
    headers: cfg.headers || {},
    data: cfg.data,
    timeout: cfg.timeoutMs || C.TIMEOUT_DEFAULTS.timeoutMs,
    responseType: cfg.responseType || 'text',
    validateStatus: () => true,
    maxRedirects: 0,
    // 禁用 HTTP/2 协商，保持 HTTP/1.1
    httpAgent: cfg.agent || keepAliveHttpAgent,
    httpsAgent: cfg.agent || keepAliveHttpsAgent
  })
  const text = cfg.responseType === 'stream' ? '' : typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  return { status: res.status, text, headers: res.headers, data: res.data }
}

// 发送 JSON 请求并按业务信封解包（code != 0 视为业务错误）
async function sendEnvelope(cfg) {
  const res = await send(cfg)
  if (res.status >= 400) {
    throw new Error(`http_error: upstream ${res.status}`)
  }
  if (res.status >= 300) {
    throw new Error(`http_error: upstream redirect ${res.status}`)
  }
  let env
  try {
    env = JSON.parse(res.text)
  } catch {
    throw new Error('storage_parse_error: invalid json response')
  }
  if (env && typeof env.code !== 'undefined' && Number(env.code) !== 0) {
    const err = new Error(`code=${env.code} msg=${env.msg || ''}`)
    err.bizCode = env.code
    throw err
  }
  return env?.data
}

// ===== OAuth 设备授权 =====

// OAuth 通用请求头（UA 与 Origin 支持 identity 覆盖）
function oauthHeaders(opts = {}) {
  const origin = headersMod.originRefererOf(null, opts)
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': headersMod.oauthUA(opts)
  }
}

// 步骤①：取授权 URL
async function oauthStart(opts = {}) {
  const data = await sendEnvelope({
    method: 'POST',
    url: `${headersMod.chatBaseOf(null, opts)}${C.OAUTH_STATE_PATH}?platform=CLI`,
    headers: oauthHeaders(opts),
    data: {},
    timeoutMs: 30000
  })
  const state = typeof data?.state === 'string' ? data.state : ''
  const authUrl = typeof data?.authUrl === 'string' ? data.authUrl : ''
  if (!state || !authUrl) throw new Error('auth state: missing state or authUrl')
  return { state, authUrl }
}

// 步骤③：取 token（pending 时业务 code != 0）
async function oauthPollToken(state, opts = {}) {
  const data = await sendEnvelope({
    method: 'GET',
    url: `${headersMod.chatBaseOf(null, opts)}${C.OAUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`,
    headers: oauthHeaders(opts),
    timeoutMs: 30000
  })
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
  if (!accessToken) throw new Error('登录未完成（waiting for login）')
  return {
    accessToken,
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
    expiresIn: Number(data.expiresIn) || 0,
    domain: typeof data.domain === 'string' ? data.domain : ''
  }
}

// 步骤③b：取账号信息（失败不阻塞登录，返回 null）
async function oauthFetchAccount(state, accessToken, opts = {}) {
  try {
    const data = await sendEnvelope({
      method: 'GET',
      url: `${headersMod.chatBaseOf(null, opts)}${C.OAUTH_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`,
      headers: { ...oauthHeaders(opts), Authorization: `Bearer ${accessToken}` },
      timeoutMs: 30000
    })
    return {
      uid: typeof data?.uid === 'string' ? data.uid : '',
      enterpriseId: typeof data?.enterpriseId === 'string' ? data.enterpriseId : '',
      nickname: typeof data?.nickname === 'string' ? data.nickname : ''
    }
  } catch {
    return null
  }
}

// ===== token 刷新 =====

// 刷新 access token；失败返回 { ok: false, error, kind }
async function refreshToken(auth, opts = {}) {
  const rt = String(auth?.refreshToken || '').trim()
  if (!rt) return { ok: false, error: 'no refreshToken' }

  const chatBase = headersMod.chatBaseOf(auth, opts)
  const atBefore = auth.accessToken

  let res
  try {
    res = await send({
      method: 'POST',
      url: `${chatBase}${C.TOKEN_REFRESH_PATH}`,
      headers: headersMod.refreshHeaders(auth, rt, opts),
      timeoutMs: C.TIMEOUT_DEFAULTS.refreshTimeoutMs
    })
  } catch (err) {
    return { ok: false, error: `refresh request failed: ${err.message}`, kind: errMod.ERR_KIND.CLIENT }
  }

  if (res.status >= 400) {
    const kind = errMod.classify(res.status, res.text)
    return { ok: false, error: `refresh_failed: http ${res.status} ${errMod.truncateMsg(res.text)}`, kind, status: res.status }
  }

  let env
  try {
    env = JSON.parse(res.text)
  } catch {
    return { ok: false, error: 'refresh_failed: invalid json' }
  }
  const data = env?.data
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
  if (!accessToken) {
    return { ok: false, error: 'refresh_failed: no accessToken in response — re-login required' }
  }

  // 快照一致才写回（锁外期间他人已刷新则不覆盖）
  if (auth.accessToken !== atBefore && auth.refreshToken !== rt) return { ok: true }

  auth.accessToken = accessToken
  if (typeof data.refreshToken === 'string' && data.refreshToken) auth.refreshToken = data.refreshToken
  if (typeof data.domain === 'string' && data.domain) auth.domain = data.domain
  const expiresIn = Number(data.expiresIn) || 0
  const REFRESH_MAX_SEC = 10 * 365 * 24 * 3600 // 10 年：超量级视为脏值，保留旧过期时间
  if (expiresIn > 0 && expiresIn < REFRESH_MAX_SEC) {
    auth.expiresAt = Math.floor(Date.now() / 1000) + expiresIn
  }
  return { ok: true, changed: true }
}

// ===== 聊天转发 =====

// 发起聊天请求（流式）：成功返回 { status, stream, headers }；失败抛错（带 kind）
async function chatStream(auth, body, opts = {}) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const url = `${chatBase}${C.CHAT_COMPLETIONS_PATH}`
  let res
  // 首字节（响应头）前上限：
  // 只计响应头到达前，头到达后 SSE 长流不受影响（流中空闲由 idle 监控负责）
  const headerAbort = new AbortController()
  const headerTimer = setTimeout(() => headerAbort.abort(), C.TIMEOUT_DEFAULTS.headerTimeoutMs)
  try {
    res = await axios({
      method: 'POST',
      url,
      headers: headersMod.chatHeaders(auth, opts.meta || {}, opts),
      data: body,
      responseType: 'stream',
      timeout: 0, // chat 无总时长上限
      validateStatus: () => true,
      maxRedirects: 0,
      signal: headerAbort.signal,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent
    })
  } catch (err) {
    purgeIdleSockets()
    const timedOut = headerAbort.signal.aborted
    const e = new Error(
      timedOut
        ? `upstream_timeout: no response headers within ${C.TIMEOUT_DEFAULTS.headerTimeoutMs}ms`
        : `transport failed: ${err.message}`
    )
    // 首字节超时是请求级失败，不轮转也不罚号；传输层失败才计账号失败
    e.kind = timedOut ? errMod.ERR_KIND.TIMEOUT : errMod.ERR_KIND.CLIENT
    e.code = timedOut ? 'upstream_timeout' : undefined
    e.transport = !timedOut
    throw e
  } finally {
    clearTimeout(headerTimer)
  }

  if (res.status >= 400) {
    // 读取错误 body（上限 200KB）以做错误分类
    const text = await readAll(res.data, 200 * 1024)
    const kind = errMod.classify(res.status, text)
    const e = new Error(`upstream ${kind} (http ${res.status}): ${errMod.truncateMsg(text)}`)
    e.kind = kind
    e.status = res.status
    e.body = text
    e.retryAfterMs = errMod.parseRetryAfter(res.headers)
    e.rateResetMs = errMod.parseRateReset(text)
    e.isModelRateLimit = errMod.isModelRateLimit(text)
    throw e
  }

  return { status: res.status, stream: res.data, headers: res.headers }
}

// 读取流到字符串（带字节上限）
function readAll(stream, limit) {
  return new Promise(resolve => {
    let buf = ''
    let done = false
    // UTF-8 增量解码器：TCP 分块边界可能落在多字节字符中间，逐块 toString()
    // 会在字符中部产生 U+FFFD（响应正文出现乱码）
    const decoder = new StringDecoder('utf8')
    const finish = () => {
      if (done) return
      done = true
      buf += decoder.end() // 冲刷未完成的最后一个多字节字符
      resolve(buf)
    }
    stream.on('data', chunk => {
      if (buf.length >= limit) return
      buf += decoder.write(chunk)
    })
    stream.on('end', finish)
    stream.on('error', finish)
    stream.on('close', finish)
  })
}

// ===== 计费域（签到 / 余额）=====

// 计费域 POST（按区域候选路径依次尝试；仅 404 回落下一候选，其余状态原样返回）。
// 国内版候选只有 /v2 形态；国际版反过来——无 /v2 优先、404 时回落 /v2。
// 路径候选由 headers.js 的 checkinPathsOf / billingMeterPathsOf 给出（按账号区域判定）
async function sendBillingPaths(auth, opts, paths, data) {
  const billingBase = headersMod.billingBaseOf(auth, opts)
  const candidates = Array.isArray(paths) && paths.length ? paths : [C.BILLING_METER_PATH_V2]
  let last = null
  for (const p of candidates) {
    last = await send({
      method: 'POST',
      url: `${billingBase}${p}`,
      headers: headersMod.billingHeaders(auth, opts),
      data,
      timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
    })
    if (last.status !== 404) return last
  }
  return last
}

// 每日签到：返回 { ok, message, kind }
async function dailyCheckin(auth, opts = {}) {
  let res
  try {
    res = await sendBillingPaths(auth, opts, headersMod.checkinPathsOf(auth, opts), {})
  } catch (err) {
    return { ok: false, message: `请求失败: ${err.message}`, kind: errMod.ERR_KIND.CLIENT }
  }
  if (res.status >= 400) {
    // 幂等判定只对错误路径生效：只认带分类的错误
    if (errMod.isAlreadyCheckin(res.status, res.text)) {
      return { ok: true, message: '今日已签到', already: true }
    }
    return { ok: false, message: `http ${res.status}: ${errMod.truncateMsg(res.text)}`, kind: errMod.classify(res.status, res.text) }
  }
  let env = null
  try {
    env = JSON.parse(res.text)
  } catch {
    /* 非 JSON 视为成功 */
  }
  if (env && Number(env.code) !== 0) {
    const msg = String(env.msg || '')
    if (errMod.ALREADY_CHECKIN_MARKERS.some(m => msg.toLowerCase().includes(m.toLowerCase()))) {
      return { ok: true, message: '今日已签到', already: true }
    }
    return { ok: false, message: `code=${env.code} msg=${msg}` }
  }
  return { ok: true, message: '签到成功' }
}

// ===== 余额观察者 =====

// 当前挂载的余额观察者（null = 未挂载）。旁路通知，不改变任何透传字节；未挂载时零开销
let creditObserver = null

// 挂载 / 注销（null）余额观察者。可在启动后任意时刻调用；观察者在余额查询的
// 调用栈上同步执行，必须自身快速返回
function setCreditObserver(fn) {
  creditObserver = typeof fn === 'function' ? fn : null
}

// 查询成功（ok）后旁路通知观察者（uid + 余额绝对值）
// 失败不是观测值：网络抖动返回的错误若被留痕，会在下一次成功时造出一条假变动；
// 观察者异常不打断余额查询主流程（纯旁路，与"落盘失败只记日志"同一哲学）
function notifyCredits(uid, credits) {
  if (!creditObserver || !uid) return
  try {
    creditObserver(String(uid), credits)
  } catch {
    /* 观察者是旁路：异常不得影响余额查询 */
  }
}

// 余额查询：返回 { ok, credits, total, expiring, earliestExpiry, earliestRemaining, message }
async function userResource(auth, opts = {}) {
  let res
  try {
    res = await sendBillingPaths(auth, opts, headersMod.billingMeterPathsOf(auth, opts), buildResourceQuery())
  } catch (err) {
    return { ok: false, message: `请求失败: ${err.message}` }
  }
  if (res.status >= 400) {
    return { ok: false, message: `http ${res.status}: ${errMod.truncateMsg(res.text)}` }
  }
  let env
  try {
    env = JSON.parse(res.text)
  } catch {
    return { ok: false, message: '响应非 JSON' }
  }
  const accounts = extractAccounts(env)
  if (!accounts) {
    return { ok: false, message: `响应缺少 Accounts（顶层键：${topKeysOf(env)}）` }
  }
  const agg = aggregateCredits(accounts, opts.expiringSoonMs)
  if (agg.ok) notifyCredits(auth.uid, agg.credits)
  return agg
}

// 积分批次明细查询：返回规范化后的批次列表（用于「积分构成」视图）
async function resourcePackages(auth, opts = {}) {
  let res
  try {
    res = await sendBillingPaths(auth, opts, headersMod.billingMeterPathsOf(auth, opts), buildResourceQuery())
  } catch (err) {
    return { ok: false, message: `请求失败: ${err.message}` }
  }
  if (res.status >= 400) {
    return { ok: false, message: `http ${res.status}: ${errMod.truncateMsg(res.text)}` }
  }
  let env
  try {
    env = JSON.parse(res.text)
  } catch {
    return { ok: false, message: '响应非 JSON' }
  }
  const accounts = extractAccounts(env)
  if (!accounts) {
    return { ok: false, message: `响应缺少 Accounts（顶层键：${topKeysOf(env)}）` }
  }
  const packages = accounts.map(mapPackage).filter(Boolean)
  // 未用完在前、到期近的在前；已用完的沉底
  packages.sort((a, b) => {
    if ((a.remain > 0) !== (b.remain > 0)) return a.remain > 0 ? -1 : 1
    if (a.expiry && b.expiry && a.expiry !== b.expiry) return a.expiry - b.expiry
    return b.remain - a.remain
  })
  return { ok: true, packages }
}

// 从计费接口响应中提取 Accounts 数组
// 上游信封为 {code,msg,data:{Response:{Data:{Accounts:[...]}}}}——业务数据在 data 内层；
// 同时兼容个别域直接返回 {Response:{Data:{Accounts}}} 的形态
function extractAccounts(env) {
  if (!env || typeof env !== 'object') return null
  const candidates = [env?.data?.Response?.Data?.Accounts, env?.Response?.Data?.Accounts, env?.data?.Accounts]
  for (const c of candidates) {
    if (Array.isArray(c)) return c
  }
  return null
}

// 响应顶层键名（解析失败时的诊断信息）
function topKeysOf(env) {
  if (!env || typeof env !== 'object') return String(env)
  return Object.keys(env).slice(0, 8).join(',')
}

// 上游批次对象 → 规范结构（Cycle 口径与 Capacity 口径不可混用）
function mapPackage(acc) {
  if (!acc || typeof acc !== 'object') return null
  const useCycle = num(acc.CycleCapacitySize) > 0
  return {
    name: String(acc.PackageName || acc.SubProductName || acc.SubProductCode || '未命名批次'),
    code: String(acc.PackageCode || ''),
    remain: useCycle ? num(acc.CycleCapacityRemain) : num(acc.CapacityRemain),
    used: useCycle ? num(acc.CycleCapacityUsed) : num(acc.CapacityUsed),
    size: useCycle ? num(acc.CycleCapacitySize) : num(acc.CapacitySize),
    cycle: useCycle,
    expiry: parseExpiry(acc),
    createTime: parseTimeValue(acc.CreateTime)
  }
}

// 余额查询固定请求体（时间区间按 UTC+8 格式化）
function buildResourceQuery() {
  const now = Date.now()
  const far = now + 101 * 365 * 24 * 3600 * 1000
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatCST(now),
    PackageEndTimeRangeEnd: formatCST(far)
  }
}

// 格式化 UTC+8 墙钟 "YYYY-MM-DD HH:mm:ss"
function formatCST(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

// 聚合积分批次：总量 + 快过期窗口内子集 + 最早到期批次
function aggregateCredits(accounts, expiringSoonMs) {
  const now = Date.now()
  const window = typeof expiringSoonMs === 'number' && expiringSoonMs > 0 ? expiringSoonMs : C.POOL_DEFAULTS.expiringSoonMs
  let credits = 0
  let total = 0
  let expiring = 0
  let earliestExpiry = 0
  let earliestRemaining = 0

  for (const acc of accounts) {
    if (!acc || typeof acc !== 'object') continue
    const useCycle = num(acc.CycleCapacitySize) > 0
    const remain = useCycle ? num(acc.CycleCapacityRemain) : num(acc.CapacityRemain)
    const size = useCycle ? num(acc.CycleCapacitySize) : num(acc.CapacitySize)
    credits += remain
    total += size
    if (remain <= 0) continue

    const expiry = parseExpiry(acc)
    if (expiry && expiry > now) {
      if (expiry - now <= window) expiring += remain
      if (!earliestExpiry || expiry < earliestExpiry) {
        earliestExpiry = expiry
        earliestRemaining = remain
      } else if (expiry === earliestExpiry) {
        earliestRemaining += remain
      }
    }
  }

  return { ok: true, credits, total, expiring, earliestExpiry, earliestRemaining }
}

// 到期时间解析：ExpiredTime → PackageEndTime → CycleEndTime
function parseExpiry(acc) {
  const candidates = [acc.ExpiredTime, acc.PackageEndTime, acc.CycleEndTime]
  for (const c of candidates) {
    const ms = parseTimeValue(c)
    if (ms) return ms
  }
  return 0
}

// 解析时间值（ISO 字符串 / epoch 秒 / epoch 毫秒）
function parseTimeValue(v) {
  if (v === null || typeof v === 'undefined' || v === '') return 0
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return 0
    return v > 1e11 ? Math.trunc(v) : Math.trunc(v * 1000)
  }
  const s = String(v).trim()
  if (!s) return 0
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n > 1e11 ? n : n * 1000
  }
  const t = Date.parse(s.replace(' ', 'T'))
  return Number.isFinite(t) ? t : 0
}

// ===== 成长域通用调用 =====

// growth 域 JSON 调用（挂 chatBase，BillingHeaders）
async function growthCall(auth, method, pathName, data, opts = {}) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const res = await send({
    method,
    url: `${chatBase}${pathName}`,
    headers: headersMod.billingHeaders(auth, opts),
    data: method === 'GET' ? undefined : data || {},
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  if (res.status >= 400) {
    const kind = errMod.classify(res.status, res.text)
    const e = new Error(`upstream ${kind} (http ${res.status}): ${errMod.truncateMsg(res.text)}`)
    e.kind = kind
    e.status = res.status
    e.body = res.text
    throw e
  }
  let env = null
  try {
    env = JSON.parse(res.text)
  } catch {
    /* 允许非 JSON */
  }
  return env
}

// 成长域调用并要求业务成功（code === 0）
async function growthOK(auth, method, pathName, data, opts = {}) {
  const env = await growthCall(auth, method, pathName, data, opts)
  if (env && typeof env.code !== 'undefined' && Number(env.code) !== 0) {
    const e = new Error(`code=${env.code} msg=${env.msg || ''}`)
    e.bizCode = env.code
    e.body = JSON.stringify(env)
    throw e
  }
  return env?.data
}

// 小程序口径平台头值（mp 限定任务的列表/接受/领奖全链路要求该头）
const MP_PLATFORM = 'miniprogram'

// 小程序口径 growth 域请求头：BillingHeaders + X-Client-Platform: miniprogram
function growthMPHeaders(auth, opts = {}) {
  return { ...headersMod.billingHeaders(auth, opts), 'X-Client-Platform': MP_PLATFORM }
}

// 小程序口径 growth 域 JSON 调用（叠加 mp 头；语义同 growthCall）
async function growthMPCall(auth, method, pathName, data, opts = {}) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const res = await send({
    method,
    url: `${chatBase}${pathName}`,
    headers: growthMPHeaders(auth, opts),
    data: method === 'GET' ? undefined : data || {},
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  if (res.status >= 400) {
    const kind = errMod.classify(res.status, res.text)
    const e = new Error(`upstream ${kind} (http ${res.status}): ${errMod.truncateMsg(res.text)}`)
    e.kind = kind
    e.status = res.status
    e.body = res.text
    throw e
  }
  let env = null
  try {
    env = JSON.parse(res.text)
  } catch {
    /* 允许非 JSON */
  }
  return env
}

// 小程序口径 growth 域调用并要求业务成功（code === 0）
async function growthOKMP(auth, method, pathName, data, opts = {}) {
  const env = await growthMPCall(auth, method, pathName, data, opts)
  if (env && typeof env.code !== 'undefined' && Number(env.code) !== 0) {
    const e = new Error(`code=${env.code} msg=${env.msg || ''}`)
    e.bizCode = env.code
    e.body = JSON.stringify(env)
    throw e
  }
  return env?.data
}

// 拉取小程序口径任务列表（GET {chatBase}/v2/activity/growth/tasks + mp 头）
// 实测 mp 列表是默认口径的超集，调用方须按 task_code 去重合并
function listTasksMP(auth, opts = {}) {
  return growthOKMP(auth, 'GET', C.GROWTH_TASKS_PATH, null, opts)
}

// 接受小程序限定任务（缺 mp 头实测 task not found）
function acceptTasksMP(auth, codes, opts = {}) {
  const list = Array.isArray(codes) ? codes.filter(Boolean) : []
  return growthOKMP(auth, 'POST', C.GROWTH_TASKS_ACCEPT_PATH, { task_codes: list }, opts)
}

// 解析领奖响应 data：{already_claimed, credit, energy}
function parseClaimData(d) {
  const alreadyClaimed = !!(d && d.already_claimed)
  return {
    credit: alreadyClaimed ? 0 : num(d && d.credit),
    energy: alreadyClaimed ? 0 : num(d && d.energy),
    alreadyClaimed
  }
}

// Web 域领奖：POST {webBase}/activity/growth/tasks/{code}/claim（无 body，web 头族）
// 任务码在路径里；返回 { credit, energy, alreadyClaimed }
async function claimReward(auth, taskCode, opts = {}) {
  const webBase = headersMod.webBaseOf(auth, opts)
  const url = `${webBase}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`
  const headers = {
    Authorization: `Bearer ${(auth && auth.accessToken) || ''}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: webBase,
    Referer: `${webBase}/profile/growth-center`,
    'x-client-platform': 'web'
  }
  const ua = headersMod.userAgent(auth, opts)
  if (ua) headers['User-Agent'] = ua
  if (auth && auth.uid) headers['X-User-Id'] = auth.uid
  if (auth && auth.enterpriseId) {
    headers['X-Enterprise-Id'] = auth.enterpriseId
    headers['X-Tenant-Id'] = auth.enterpriseId
  }
  if (auth && auth.domain) headers['X-Domain'] = auth.domain

  const res = await send({ method: 'POST', url, headers })
  if (res.status >= 400) {
    const e = new Error(`claim http ${res.status}: ${errMod.truncateMsg(res.text)}`)
    e.status = res.status
    e.body = res.text
    throw e
  }
  let env = null
  try {
    env = JSON.parse(res.text)
  } catch {
    /* 允许非 JSON */
  }
  if (env && typeof env.code !== 'undefined' && Number(env.code) !== 0) {
    const e = new Error(`claim code=${env.code} msg=${env.msg || ''}`)
    e.bizCode = env.code
    e.body = res.text
    throw e
  }
  return parseClaimData(env && env.data)
}

// 小程序口径领奖：POST {chatBase}/activity/growth/tasks/{code}/claim（无 body，mp 头）
// chat 域返回 HTTP 400（部分任务/租户形态）→ 降级 Web 域 claimReward。
async function claimRewardMP(auth, taskCode, opts = {}) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const url = `${chatBase}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`
  const res = await send({ method: 'POST', url, headers: growthMPHeaders(auth, opts) })
  if (res.status >= 400) {
    if (res.status === 400) return claimReward(auth, taskCode, opts)
    const e = new Error(`mp claim http ${res.status}: ${errMod.truncateMsg(res.text)}`)
    e.status = res.status
    e.body = res.text
    throw e
  }
  let env = null
  try {
    env = JSON.parse(res.text)
  } catch {
    /* 允许非 JSON */
  }
  if (env && typeof env.code !== 'undefined' && Number(env.code) !== 0) {
    const e = new Error(`mp claim code=${env.code} msg=${env.msg || ''}`)
    e.bizCode = env.code
    e.body = res.text
    throw e
  }
  return parseClaimData(env && env.data)
}

// 小程序上报请求头（X-Client-Product / X-Client-Version / X-Client-Platform: mp-weixin / X-Platform）
// X-Client-Version 默认 2.4.0，可由 identity.mpVersion 覆盖
function mpReportHeaders(auth, opts = {}) {
  const headers = {
    Authorization: `Bearer ${(auth && auth.accessToken) || ''}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Product': 'workbuddy-mp',
    'X-Client-Version': headersMod.idv(opts, 'mpVersion') || '2.4.0',
    'X-Client-Platform': 'mp-weixin',
    'X-Platform': 'wechatmp'
  }
  if (auth && auth.uid) headers['X-User-Id'] = auth.uid
  return headers
}

// 小程序埋点上报：POST {billingBase}/v2/report（body 为事件数组）
// billing 域地址走 billingBaseOf（identity.billingBase 可覆盖）
async function reportMPEvent(auth, events, opts = {}) {
  const arr = Array.isArray(events) ? events : [events]
  const res = await send({
    method: 'POST',
    url: `${headersMod.billingBaseOf(auth, opts)}${C.REPORT_PATH}`,
    headers: mpReportHeaders(auth, opts),
    data: arr,
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  return { status: res.status, text: res.text }
}

// 桌面端事件上报（chatBase /v2/report，桌面端头族）
async function desktopReport(auth, events, opts = {}) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const res = await send({
    method: 'POST',
    url: `${chatBase}${C.REPORT_PATH}`,
    headers: headersMod.desktopHeaders(auth, opts),
    data: events,
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  return { status: res.status, text: res.text }
}

// 官网域上报（webBase /v2/report，web 口径头）
async function webReport(auth, events, opts = {}) {
  const webBase = headersMod.webBaseOf(auth, opts)
  const res = await send({
    method: 'POST',
    url: `${webBase}${C.REPORT_PATH}`,
    headers: headersMod.webHeaders(auth, opts),
    data: events,
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  return { status: res.status, text: res.text }
}

// ===== 模型目录 =====

// 合并两路模型目录：primary 为主（同 id 以 primary 字段为准），secondary 只补 primary 缺失的 id
// （输出顺序 = primary 原序 + secondary 补充项，稳定输出）
function mergeModelList(primary, secondary) {
  const out = [...primary]
  const seen = new Set(primary.map(m => m.id))
  for (const m of secondary) {
    if (!seen.has(m.id)) {
      out.push(m)
      seen.add(m.id)
    }
  }
  return out
}

// 拉取模型目录：/v3/config 与企业端点两路并发，v3 优先、企业端点补缺
// 国际版（realm=global）特殊处理：
//   1. 企业端点走 /v2 优先（/console 兜底）——实测 /v2/enterprises/personal/models 200 且模型更全
//   2. /v3/config 需要**并发三种 UA**：桌面端 / IDE / CLI 在不同 UA 下下发不同的模型集
//      （2026-10 实测：桌面端 29 条含 gpt-6-sol/luna、grok-4.7；IDE 13 条独有 o4-mini、
//       enhance-1.0、auto-chat；CLI 22 条独有 deepseek 系、gpt-6-astra——只发一种 UA 会漏模型，
//       客户端里能看到但目录里没有）
//   3. 合并口径：桌面端 UA 为主路（字段最全），IDE/CLI 只补主路缺失的模型 id
async function fetchModels(auth, opts = {}) {
  const global = headersMod.isGlobalAccount(auth, opts)
  const chatBase = headersMod.chatBaseOf(auth, opts)

  if (global) {
    const [v3, ent] = await Promise.all([
      fetchV3ConfigModelsMultiUA(chatBase, auth, opts).catch(() => []),
      fetchEnterpriseModels(chatBase, auth, C.MODELS_ENTERPRISE_PATH_GLOBAL, opts)
        .catch(() => fetchEnterpriseModels(chatBase, auth, C.MODELS_ENTERPRISE_PATH, opts).catch(() => []))
    ])
    // v3（三 UA 并集）为主，企业端点补缺
    const merged = mergeModelList(v3, ent)
    if (!merged.length) throw new Error('模型目录拉取失败（国际版）')
    return merged
  }

  const [v3, ent] = await Promise.all([
    fetchV3ConfigModels(chatBase, auth, opts).catch(() => []),
    fetchEnterpriseModels(chatBase, auth, C.MODELS_ENTERPRISE_PATH, opts).catch(() => [])
  ])
  const merged = mergeModelList(v3, ent)
  if (!merged.length) throw new Error('模型目录拉取失败')
  return merged
}

// 国际版 /v3/config 三路 UA 并发探测并集。
// 三路 UA（与参考实现口径一致）：
//   桌面端 UA = 本账号按区域生成的 chat UA（主路，字段最全）
//   IDE UA    = CodeBuddyIDE/<ideVersion> CodeBuddy/<ideVersion>（独有 o4-mini / enhance-1.0 / auto-chat）
//   CLI UA    = CLI/<cliVersion> CodeBuddy/<cliVersion>（独有 deepseek 系 / gpt-6-astra）
// 合并：主路（桌面端）条目字段权威，其余两路只补主路缺失的 id；
// 单路失败降级为其余路 + warn 日志（由调用方记），全路失败才抛错。
async function fetchV3ConfigModelsMultiUA(chatBase, auth, opts = {}) {
  const identity = opts.identity || {}
  const clientVersion = identity.clientVersion || C.DEFAULT_CLIENT_VERSION
  const ideVersion = identity.ideVersion || C.DEFAULT_IDE_VERSION
  const cliVersion = identity.cliVersion || C.DEFAULT_CLI_VERSION

  const desktopUA = headersMod.userAgent(auth, { ...opts, realm: 'global' })
  const ideUA = `CodeBuddyIDE/${ideVersion} CodeBuddy/${ideVersion}`
  const cliUA = `CLI/${cliVersion} CodeBuddy/${cliVersion}`

  const routes = [
    { label: 'desktop', ua: desktopUA },
    { label: 'ide', ua: ideUA },
    { label: 'cli', ua: cliUA }
  ]

  const results = await Promise.all(
    routes.map(r =>
      fetchV3ConfigModels(chatBase, auth, { ...opts, __uaOverride: r.ua })
        .then(list => ({ label: r.label, list, err: null }))
        .catch(err => ({ label: r.label, list: [], err }))
    )
  )

  const failed = results.filter(x => x.err)
  const okLists = results.filter(x => !x.err && x.list.length)
  if (!okLists.length) {
    // 全路失败：抛首路错误（调用方记日志）
    const first = results.find(x => x.err)
    throw first ? first.err : new Error('v3/config 三路 UA 探测全部失败')
  }

  // 主路 = 桌面端 UA（成功时）；否则取第一个成功的路
  const primary = results.find(x => x.label === 'desktop' && !x.err && x.list.length) || okLists[0]
  // 次路只补主路缺失的 id
  const others = okLists.filter(x => x !== primary)
  let merged = primary.list
  for (const o of others) merged = mergeModelList(merged, o.list)
  return merged
}

// 企业模型目录解析（data.agents[name=cli].models 为候选顺序）
async function fetchEnterpriseModels(chatBase, auth, pathName, opts = {}) {
  const res = await send({
    method: 'GET',
    url: `${chatBase}${pathName}`,
    headers: { ...headersMod.commonHeaders(auth, opts), Authorization: `Bearer ${auth.accessToken}` },
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  if (res.status >= 400) throw new Error(`models http ${res.status}`)
  const env = JSON.parse(res.text)
  const data = env?.data
  if (!data) return []

  const entryByID = new Map()
  for (const m of Array.isArray(data.models) ? data.models : []) {
    const item = mapModelEntry(m)
    if (item) entryByID.set(item.id, item)
  }

  let candidateIDs = null
  for (const agent of Array.isArray(data.agents) ? data.agents : []) {
    if (agent?.name === 'cli' && Array.isArray(agent.models)) {
      candidateIDs = agent.models
      break
    }
  }

  const out = []
  if (candidateIDs) {
    for (const id of candidateIDs) {
      const item = entryByID.get(id)
      if (item) out.push(item)
    }
  } else {
    out.push(...entryByID.values())
  }
  return out
}

// /v3/config 模型目录解析（含试用模型继承与促销信息）
// opts.__uaOverride：国际版三路 UA 探测时由调用方注入，覆盖默认 UA
async function fetchV3ConfigModels(chatBase, auth, opts = {}) {
  const ua = opts.__uaOverride || ''
  const res = await send({
    method: 'GET',
    url: `${chatBase}${C.V3_CONFIG_PATH}`,
    headers: headersMod.v3ConfigHeaders(auth, opts, ua),
    timeoutMs: C.TIMEOUT_DEFAULTS.timeoutMs
  })
  if (res.status >= 400) throw new Error(`v3 config http ${res.status}`)
  const env = JSON.parse(res.text)
  const data = env?.data
  if (!data) return []

  const list = []
  const bannerMap = new Map()
  const banners = data.productFeaturesConfig?.ModelTrialBanner?.banners
  for (const b of Array.isArray(banners) ? banners : []) {
    if (b?.modelId && b?.targetModelId) bannerMap.set(b.modelId, b.targetModelId)
  }

  const byID = new Map()
  for (const m of Array.isArray(data.models) ? data.models : []) {
    const item = mapModelEntry(m)
    if (item) byID.set(item.id, item)
  }

  // 试用模型：能力继承 target，但 credits/tags 清空
  for (const [id, target] of bannerMap) {
    if (byID.has(id)) continue
    const base = byID.get(target)
    if (!base) continue
    byID.set(id, { ...base, id, credits: '', tags: [] })
  }

  for (const item of byID.values()) {
    if (isNonChatModel(item)) continue
    list.push(item)
  }
  return list
}

// 上游模型对象 → 内部模型条目
// 上游零值字段走目录兜底链
function mapModelEntry(m) {
  if (!m || typeof m !== 'object') return null
  const id = String(m.id || '').trim()
  if (!id) return null
  const reasoning = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : {}
  const upstreamEfforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : []
  const upstreamDefault = String(reasoning.defaultEffort || reasoning.effort || '')
  return {
    id,
    name: String(m.name || '').trim(),
    description: String(m.descriptionZh || '').trim(),
    credits: m.credits ?? '',
    // 积分倍率（规范化数值键，如 "0.79"；无法数值化时保留去后缀原文；缺失为空串）
    rate: normalizeModelRate(m.credits),
    tags: Array.isArray(m.tags) ? m.tags : [],
    vendor: String(m.vendor || ''),
    isDefault: !!m.isDefault,
    // 上下文 / 输出上限：四级兜底链（上游值优先）
    maxContext: catalog.contextWindowOf(id, m.maxInputTokens),
    maxOutput: catalog.outputTokensOf(id, m.maxOutputTokens),
    supportsImages: !!m.supportsImages,
    supportsReasoning: !!m.supportsReasoning,
    supportsToolCall: !!m.supportsToolCall,
    // 思考档位：上游值优先，否则静态分表，缺省空数组
    efforts: catalog.supportedEffortsOf(id, upstreamEfforts),
    defaultEffort: catalog.defaultEffortOf(id, upstreamEfforts, upstreamDefault)
  }
}

// 非对话模型过滤
function isNonChatModel(item) {
  const id = item.id.toLowerCase().trim()
  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return true
  if (item.maxOutput > 0 && item.maxOutput <= 256) return true
  if (Array.isArray(item.tags) && item.tags.includes('text-to-image')) return true
  return false
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

// 把上游倍率原文规范化为可比较的数值键。
// 兼容 "x0.05" / "x0.05 credits" / "0.50x" 等形态；无法数值化时保留去除
// credits 后缀与空白后的原文，避免编造倍率；缺失返回空串。
function normalizeModelRate(raw) {
  let s = String(raw === null || typeof raw === 'undefined' ? '' : raw).trim()
  if (!s) return ''
  if (s.toLowerCase().endsWith('credits')) s = s.slice(0, s.length - 'credits'.length).trim()
  if (s.toLowerCase().startsWith('x')) s = s.slice(1).trim()
  else if (s.toLowerCase().endsWith('x')) s = s.slice(0, s.length - 1).trim()
  if (!s) return ''
  const v = Number(s)
  if (!Number.isFinite(v)) return String(raw).trim()
  return String(v)
}

module.exports = {
  send,
  sendEnvelope,
  oauthStart,
  oauthPollToken,
  oauthFetchAccount,
  refreshToken,
  chatStream,
  readAll,
  dailyCheckin,
  userResource,
  resourcePackages,
  setCreditObserver,
  growthCall,
  growthOK,
  growthMPHeaders,
  growthMPCall,
  growthOKMP,
  listTasksMP,
  acceptTasksMP,
  claimReward,
  claimRewardMP,
  mpReportHeaders,
  reportMPEvent,
  desktopReport,
  webReport,
  fetchModels,
  fetchV3ConfigModels,
  fetchEnterpriseModels,
  mergeModelList,
  mapModelEntry,
  normalizeModelRate,
  formatCST,
  parseTimeValue,
  aggregateCredits,
  extractAccounts,
  buildResourceQuery
}