// WorkBuddy 运行时：账号池、会话粘性、模型缓存、聊天转发（换号重试与错误处置闭环）
// 翻译自参考项目 internal/server/handler.go 的主流程

const fs = require('fs')
const path = require('path')
const C = require('./constants')
const errMod = require('./errors')
const authMod = require('./auth')
const client = require('./client')
const catalogMod = require('./catalog')
const poolMod = require('./pool')
const sessionMod = require('./session')
const payloadMod = require('./payload')
const sseMod = require('./sse')
const dsmlMod = require('./dsml')
const promptMod = require('./prompt')
const schedulerMod = require('./scheduler')
const tasksMod = require('./tasks')
const queueMod = require('./queue')
const wafipMod = require('./wafip')
const usageMod = require('./usage')
const creditHistMod = require('./credithist')

// 运行时单例（Express 与 Electron 主进程同进程，全局唯一）
let rt = null

// 账号操作运行态（uid → 动作名；进程内状态，供面板显示「保活中」等）
const runningActions = new Map()

// 初始化运行时（幂等）
// opts: { dataDir, poolConfig, promptMode, promptFile, sanitizeFingerprints, log }
function init(opts = {}) {
  if (rt) return rt

  const dataDir = opts.dataDir || path.join(__dirname, '..', '..', 'data')
  const authDir = opts.authDir || path.join(dataDir, 'workbuddy-auths')
  const stateFile = opts.stateFile || path.join(dataDir, 'workbuddy-state.json')

  fs.mkdirSync(authDir, { recursive: true, mode: 0o755 })

  // 模型目录兜底链：把数据目录注入 catalog（model.json 缓存的读写位置）
  catalogMod.configure({ dataDir })

  const pool = poolMod.createPool({
    ...(opts.poolConfig || {}),
    stateFile,
    // 池内事件（成本探索/免费窗口结束等）汇入系统日志
    onEvent: msg => {
      if (rt) rt.log(`workbuddy: ${msg}`, 'system')
    }
  })
  pool.load()
  pool.startFlusher()

  // 凭证加载 → 池对齐（先 load 恢复状态，再注入凭证）
  const auths = authMod.loadDir(authDir)
  pool.syncToDir(auths)

  // 用量/积分消耗统计：落盘 data/usage.json，启动加载、30s 防抖自动落盘
  const usage = usageMod.createUsage({ dataDir, file: opts.usageFile })
  usage.load()

  // 积分历史账本：把每次真实查到的余额与上次比对，变动即留痕（新账号首次只建
  // 基线）。挂载在 client 的余额观察者上（余额查询是"积分变动"唯一可靠的观测口），
  // 签到 / 活跃上报 / 旅行 / 保活 / 面板手动刷新全覆盖；落盘 data/credit-history.json
  const creditHist = creditHistMod.createLedger({ dataDir, file: opts.creditHistoryFile })
  creditHist.load()
  client.setCreditObserver((uid, credits) => creditHist.observe(uid, credits))

  const session = sessionMod.createRouter({
    ttl: opts.poolConfig?.sessionStickyTtlMs,
    gcInterval: opts.poolConfig?.sessionStickyGcMs,
    available: allowUIDs => pool.availableUIDs('', allowUIDs),
    availableForModel: (model, allowUIDs) => pool.availableUIDs(model, allowUIDs)
  })
  session.startGC()

  const promptText = (() => {
    try {
      return promptMod.loadPrompt(opts.promptFile || '')
    } catch (err) {
      opts.log?.(`workbuddy: 提示词加载失败，回落内置默认（${err.message}）`)
      return promptMod.DEFAULT_PROMPT
    }
  })()

  // 运行日志环形缓冲（最多 500 条）：只保留关键事件，帧级高频日志不进入
  const logBuffer = []
  const sink = opts.log || (msg => console.log(msg))
  const pushLog = (channel, message, level = 'info') => {
    logBuffer.push({ ts: Date.now(), level, channel, message })
    if (logBuffer.length > 500) logBuffer.shift()
    sink(message)
  }
  // 兼容既有调用：单参数视为系统日志；任务模块日志按前缀归入任务频道
  const log = (message, channel) => {
    const ch = channel || (String(message).includes('[WorkBuddy任务]') ? 'task' : 'system')
    pushLog(ch, message)
  }

  rt = {
    dataDir,
    authDir,
    stateFile,
    pool,
    session,
    usage,
    creditHist,
    log,
    pushLog,
    logBuffer,
    cfg: {
      promptMode: opts.promptMode || 'custom', // custom / append / passthrough
      promptText,
      sanitizeFingerprints: opts.sanitizeFingerprints !== false,
      softRateMs: opts.poolConfig?.softRateMs || C.POOL_DEFAULTS.softRateMs,
      callbackUrl: opts.callbackUrl || '',
      deviceTokenFile: opts.deviceTokenFile || '' // 设备令牌文件路径（参照 upstream.device_token_file）
    },
    models: { ts: 0, list: [], efforts: {}, defaultEfforts: {} },
    enabledModels: Array.isArray(opts.enabledModels) ? opts.enabledModels : [], // 账号池统一维护的启用模型清单
    logins: new Map(), // OAuth state → { created }
    loginTTL: 15 * 60 * 1000,
    wafIpGate: wafipMod.createWafIpGate(opts.poolConfig?.wafIp || {}) // WAF IP 级 fail-fast 门
  }

  // 成长任务执行器（一键完成：事件上报 + 真实对话 + 自动领奖）
  rt.taskRunner = tasksMod.createTaskRunner({
    client,
    log: rt.log,
    chatOnce
  })

  // 成长任务执行队列（账号内串行 / 账号间并发夹取 [1,4]，默认 2）
  rt.taskQueue = queueMod.createQueue({
    pool,
    log: rt.log,
    scanPending: auth => tasksMod.scanPendingCodes(auth),
    runCode: (auth, code) => rt.taskRunner.runOne(auth, code)
  })

  // 定时任务调度器（签到/活跃/旅行/保活/夜猫子/成长队列 + 余额后台刷新）
  rt.scheduler = schedulerMod.createScheduler({
    pool,
    client,
    auth: authMod,
    refreshTokenFor: a => refreshTokenFor(rt, a),
    refreshBalanceFor: a => refreshBalanceFor(rt, a),
    log: rt.log,
    scheduleConfig: opts.scheduleConfig || {},
    // 到点触发成长任务队列（与「全账号入队执行」同管线）
    growthHook: () => {
      void rt.taskQueue.runQueueOnce()
    }
  })
  rt.scheduler.start()

  return rt
}

// 任务专用：向指定账号与模型发一条真实短对话（非流式聚合，直接使用传入凭证不上池）
async function chatOnce(auth, model, message) {
  const r = ensure()
  const snap = effortsSnapshot()
  let prepared = payloadMod.prepareBody(JSON.stringify({ model, messages: [{ role: 'user', content: message }] }), {
    sanitize: r.cfg.sanitizeFingerprints,
    efforts: snap.efforts,
    defaultEfforts: snap.defaultEfforts
  })
  prepared = payloadMod.injectPromptCacheKey(prepared, auth.uid, '')
  const res = await client.chatStream(auth, prepared, rtOpts(r))
  const text = await client.readAll(res.stream, 8 * 1024 * 1024)
  return sseMod.aggregateSSE(text)
}

// 取运行时（未初始化返回 null）
function getRuntime() {
  return rt
}

// ===== OAuth 账号登录 =====

// 发起 OAuth：返回 { state, url }
async function oauthStart() {
  const r = ensure()
  cleanupLogins(r)
  const { state, authUrl } = await client.oauthStart()
  r.logins.set(state, { created: Date.now() })
  r.log(`workbuddy: 发起 OAuth 添加账号（state=${state.slice(0, 8)}...）`)
  return { state, url: authUrl }
}

// 轮询 OAuth 结果：完成则落盘 + 热加载进池
async function oauthPoll(state) {
  const r = ensure()
  cleanupLogins(r)
  const sess = r.logins.get(state)
  if (!sess) throw new Error('unknown or expired state（请重新发起添加账号）')

  const token = await client.oauthPollToken(state)
  const account = await client.oauthFetchAccount(state, token.accessToken)
  const uid = account?.uid || ''
  if (!authMod.validUID(uid)) {
    throw new Error('上游返回的 uid 含非法字符，拒绝落盘（防路径穿越）')
  }

  const auth = {
    uid,
    enterpriseId: account?.enterpriseId || '',
    nickname: account?.nickname || '',
    domain: token.domain || '',
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn > 0 ? Math.floor(Date.now() / 1000) + token.expiresIn : 0,
    deviceToken: '',
    filePath: authMod.pathFor(r.authDir, uid)
  }
  authMod.saveAtomic(auth)
  r.pool.add(auth)
  r.pool.revive(uid) // 全新登录 = 人工恢复口径
  r.models.ts = 0 // 失效模型缓存

  // 顺带签到 + 余额刷新（失败不影响登录结果）
  let checkinMessage = ''
  let credits = -1
  let creditsTotal = 0
  try {
    const ck = await client.dailyCheckin(auth, rtOpts(r))
    checkinMessage = ck.message || ''
  } catch (err) {
    checkinMessage = `签到失败: ${err.message}`
  }
  try {
    const res = await client.userResource(auth, { ...rtOpts(r), expiringSoonMs: r.pool.getConfig().expiringSoonMs })
    if (res.ok) {
      credits = res.credits
      creditsTotal = res.total
      r.pool.setCreditsDetailed(uid, res.credits, res.total, res.expiring, res.earliestExpiry, res.earliestRemaining)
      r.pool.reenableIfCredits(uid, res.credits, res.total)
    }
  } catch {
    /* 余额失败不阻断 */
  }

  r.logins.delete(state)
  r.log(`workbuddy: 新账号已热加载 uid=${uid} nickname="${auth.nickname}"（免重启生效）`)
  return {
    done: true,
    uid,
    nickname: auth.nickname,
    credits,
    creditsTotal,
    checkinMessage
  }
}

// 清理过期登录会话
function cleanupLogins(r) {
  const now = Date.now()
  for (const [state, sess] of r.logins.entries()) {
    if (now - sess.created > r.loginTTL) r.logins.delete(state)
  }
}

// ===== 账号运维 =====

// 账号列表（状态 + 昵称 + 域）
function listAccounts() {
  return ensure().pool.list()
}

// 移除账号（删凭证文件 + 出池）
function removeAccount(uid) {
  const r = ensure()
  const auth = r.pool.remove(uid)
  if (!auth) return false
  if (auth.filePath) {
    try {
      fs.unlinkSync(auth.filePath)
    } catch {
      /* 文件不存在忽略 */
    }
  }
  r.models.ts = 0
  return true
}

// 单号签到
async function checkinAccount(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) return { ok: false, message: '账号不存在' }
  return runTracked(uid, 'checkin', async () => {
    const res = await client.dailyCheckin(auth, rtOpts(r))
    if (res.ok) r.pool.noteCheckinDone(uid)
    return res
  })
}

// 单号余额刷新
async function refreshBalance(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) return { ok: false, message: '账号不存在' }
  return refreshBalanceFor(r, auth)
}

// 余额刷新并写回池（含余额恢复解冻）；运行态标记覆盖手动与批量调用
async function refreshBalanceFor(r, auth) {
  return runTracked(auth.uid, 'balance', async () => {
    const res = await client.userResource(auth, { ...rtOpts(r), expiringSoonMs: r.pool.getConfig().expiringSoonMs })
    if (res.ok) {
      r.pool.setCreditsDetailed(auth.uid, res.credits, res.total, res.expiring, res.earliestExpiry, res.earliestRemaining)
      r.pool.reenableIfCredits(auth.uid, res.credits, res.total)
    }
    return res
  })
}

// 全量余额刷新（并发，限 4）
async function refreshAllBalances() {
  const r = ensure()
  const accounts = r.pool.list()
  const results = []
  const queue = accounts.slice()
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const st = queue.shift()
      const auth = r.pool.authByUID(st.uid)
      if (!auth) continue
      try {
        results.push({ uid: st.uid, ...(await refreshBalanceFor(r, auth)) })
      } catch (err) {
        results.push({ uid: st.uid, ok: false, message: err.message })
      }
    }
  })
  await Promise.all(workers)
  return results
}

// 解冻 / 复活账号
function reviveAccount(uid) {
  return ensure().pool.revive(uid)
}

// 单号保活（token 刷新）
async function keepaliveAccount(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) return { ok: false, message: '账号不存在' }
  return refreshTokenFor(r, auth)
}

// token 刷新（含 12153 连续计数处置）
async function refreshTokenFor(r, auth) {
  // 运行态标记：面板可见「保活中」（手动与批量保活都走这里）
  return runTracked(auth.uid, 'keepalive', async () => {
    const res = await client.refreshToken(auth, rtOpts(r))
    // 最近保活结果与时间（面板展示）
    r.pool.noteKeepalive(auth.uid, !!res.ok)
    if (res.ok) {
      r.pool.clearSessionDead(auth.uid)
      if (res.changed) {
        try {
          authMod.saveAtomic(auth)
        } catch (err) {
          r.log(`workbuddy: 凭证落盘失败 uid=${auth.uid}: ${err.message}`)
        }
      }
      return { ok: true }
    }
    if (res.kind === errMod.ERR_KIND.SESSION_DEAD) {
      if (r.pool.noteSessionDead(auth.uid)) {
        r.pool.disable(auth.uid, '12153 session dead')
        r.log(`workbuddy: keepalive uid=${auth.uid} 连续 3 次 12153 session dead — 已禁用`)
      }
    }
    return res
  })
}

// ===== 账号操作运行态 =====
// 面板展示「签到中 / 保活中 / 刷余额中」（uid → 动作名，进程内状态）

// 包裹一次账号操作：运行期间标记动作，结束或异常都清除
async function runTracked(uid, action, fn) {
  setAccountRunning(uid, action)
  try {
    return await fn()
  } finally {
    if (runningActions.get(uid) === action) setAccountRunning(uid, '')
  }
}

// 设置/清除账号运行态动作（空串 = 清除；调度器可经注入回调复用）
function setAccountRunning(uid, action) {
  if (!uid) return
  if (action) runningActions.set(uid, action)
  else runningActions.delete(uid)
}

// 查询账号当前运行态动作（'' = 空闲）
function accountRunningAction(uid) {
  return runningActions.get(uid) || ''
}

// 人工禁用账号（保留凭证与状态，仅退出轮转）
function disableAccount(uid, reason) {
  const r = ensure()
  if (!r.pool.status(uid)) return { ok: false, message: '账号不存在' }
  r.pool.disable(uid, reason || '人工禁用')
  r.log(`workbuddy: 账号已人工禁用 uid=${uid.slice(0, 8)} 原因=${reason || '人工禁用'}`)
  return { ok: true }
}

// 人工恢复启用（只清禁用，不动冷却/熔断/模型台账）
function enableAccount(uid) {
  const r = ensure()
  if (!r.pool.reviveDisabled(uid)) return { ok: false, message: '账号不存在或未被禁用' }
  r.log(`workbuddy: 账号已恢复启用 uid=${uid.slice(0, 8)}`)
  return { ok: true }
}

// ===== 模型目录 =====

// 拉取上游模型列表（1h 缓存）；force 强制刷新
async function listUpstreamModels(force) {
  const r = ensure()
  const now = Date.now()
  if (!force && r.models.list.length && now - r.models.ts < 3600000) {
    return r.models.list
  }

  // 任取一个可用账号（健康优先，其次任意非禁用）
  const accounts = r.pool.list()
  let picked = null
  for (const st of accounts) {
    if (!st.disabled) {
      picked = r.pool.authByUID(st.uid)
      break
    }
  }
  for (const st of accounts) {
    if (!picked) picked = r.pool.authByUID(st.uid)
  }
  if (!picked) throw new Error('没有可用账号，请先添加 WorkBuddy 账号')

  const list = await client.fetchModels(picked, rtOpts(r))
  r.models = { ts: now, list, efforts: buildEffortsMap(list, r), defaultEfforts: buildDefaultEffortsMap(list) }
  return list
}

// 从模型列表构建档位表（模型 → 支持档位）
function buildEffortsMap(list, r) {
  const map = {}
  for (const m of list) {
    if (Array.isArray(m.efforts) && m.efforts.length) map[m.id] = m.efforts
  }
  return map
}

// 从模型列表构建默认档位表（模型 → 默认档）
function buildDefaultEffortsMap(list) {
  const map = {}
  for (const m of list) {
    if (m.defaultEffort) map[m.id] = m.defaultEffort
  }
  return map
}

// 当前缓存的档位表（供请求体管线降级使用）
function effortsSnapshot() {
  const r = rt
  if (!r) return { efforts: {}, defaultEfforts: {} }
  return { efforts: r.models.efforts, defaultEfforts: r.models.defaultEfforts }
}

// ===== 聊天转发 =====

// 转发聊天请求：池化选号 + 改写管线 + 换号重试 + 错误处置
// opts: { body, isStream, clientIP, model, onChunk(text), onDone(usage), onError(err) }
async function forwardChat(opts) {
  const r = ensure()
  const originalBody = opts.body
  // 模型名：优先 Provider 配置的模型 id（opts.model，客户端可不指定由界面当前选中决定）
  const model = String(opts.model || '')
  const isStream = opts.isStream !== false
  const startedAt = Date.now()

  let body = String(originalBody || '')
  // 注入网关解析出的模型 ID（客户端可不指定 model，由界面当前选中决定）
  body = payloadMod.setBodyModel(body, model)
  // 模型级推理档位注入（Provider 每个模型独立配置；空 = 不干预客户端原值）
  // 放在提示词与改写管线之前，保证降级重试路径同样携带
  body = payloadMod.setBodyEffort(body, opts.reasoningEffort)
  const baseBody = body
  // 工具名名单：上游在没有 tools 的请求里会把工具调用吐成原生标记文本（见 dsml.js），
  // 修复层用它做严格判定。名单来自「本请求声明的 tools」与「会话历史里出现过的工具名」
  // 两个来源——实测 tools 声明会在中转环节丢失，只认前者会让修复层在最需要它的场景失效
  const declaredTools = dsmlMod.toolNameAllowlist(baseBody)
  // 会话/轮级键必须在提示词改写前取（参照 handler：改写会动 messages 内容，之后取会让键漂移）
  const sessionKey = sessionMod.extractKey(baseBody)
  const turnKey = sessionMod.turnKey(baseBody)
  // 日志口径：使用记录（提问原文，≤1000 字）与任务键（一次提问一条日志，跨工具循环/重试）
  const logInput = sessionMod.extractInputText(baseBody)
  const logTaskKey = sessionMod.extractTaskKey(baseBody) || turnKey
  // 会话头族 meta：轮转循环外生成一次 → 换号/重试/降级全部同 ID，后台不再碎片化
  const chatMeta = buildChatMeta(baseBody, { sessionKey, turnKey, inbound: opts.inbound })
  // gateway_hint 判定上下文（必须在提示词改写前取，参照 handler：改写会动 messages 内容）
  const hintCtx = hintContextOf(r, baseBody, model)
  // 用量统计的积分倍率：模型在 r.models.list 里的 rate 字段（缺失为 ''）
  const modelRate = modelRateOf(r, model)
  // 提示词体系（降级期 append 退化为替换）
  const applied = promptMod.applyPromptMode(body, r.cfg.promptMode, r.cfg.promptText)
  body = applied.body
  let degradedApplied = applied.degradedApplied

  // 粘性号：循环外解析一次；不可用时解绑并回落普通轮换（参照 handler unbindSticky）
  let stickyUID = ''
  if (sessionKey) {
    const bound = r.session.resolveForModel(sessionKey, model, null)
    if (bound.ok) stickyUID = bound.uid
  }
  const unbindSticky = () => {
    if (stickyUID) {
      r.session.unbind(sessionKey)
      stickyUID = ''
    }
  }

  const tried = new Set()
  let lastError = null
  let wafIpBlocked = false // WAF IP 级判定后终止轮转

  for (let attempt = 0; attempt < C.MAX_ROTATE; attempt++) {
    const attemptStarted = Date.now()
    // 选号：粘性优先，其次池 pick
    let auth = null
    if (stickyUID && !tried.has(stickyUID)) auth = r.pool.pickByUID(stickyUID, model, null)
    if (!auth && stickyUID) unbindSticky() // 粘性号在当前模型不可用（冷却/占满/模型受限）→ 解绑
    if (!auth) auth = r.pool.pick({ tried, model })
    if (!auth) {
      // 区分「账号不可用」与「该模型在账号池中暂时不可用」——后者切换模型即可恢复
      const diag = r.pool.diagnoseNoCandidate(model)
      const modelBlocked = diag.modelCooled > 0 && diag.healthy === 0 && diag.cooling === 0
      const err = new Error(
        modelBlocked
          ? `模型 ${model} 在账号池中暂时不可用（模型级限流或该后端无此模型），请切换其他模型或稍后重试`
          : errMod.NO_HEALTHY_HINT
      )
      err.code = modelBlocked ? 'model_temporarily_unavailable' : errMod.NO_HEALTHY_CODE
      err.noHealthy = true
      err.input = logInput
      err.taskKey = logTaskKey
      // gateway_hint：模型级受限给「换模型」指向；账号级给本地调度提示
      err.gatewayHint = modelBlocked
        ? errMod.gatewayHint(errMod.ERR_KIND.MODEL_BLOCKED, '', hintCtx)
        : errMod.noHealthyAccountHint()
      r.pushLog('chat', `请求失败：${err.message}（账号诊断：总 ${diag.total} / 可用 ${diag.healthy} / 冷却 ${diag.cooling} / 模型受限 ${diag.modelCooled} / 禁用 ${diag.disabled}）`, 'warn')
      throw err
    }

    tried.add(auth.uid)
    if (!r.pool.acquire(auth.uid)) {
      tried.add(auth.uid)
      continue
    }

    const released = { done: false }
    const releaseHeld = () => {
      if (!released.done) {
        released.done = true
        r.pool.release(auth.uid)
      }
    }

    try {
      // 请求体改写：提示词之后再走 payload 管线 + cache key
      const snap = effortsSnapshot()
      let prepared = payloadMod.prepareBody(body, {
        sanitize: r.cfg.sanitizeFingerprints,
        efforts: snap.efforts,
        defaultEfforts: snap.defaultEfforts
      })
      prepared = payloadMod.injectPromptCacheKey(prepared, auth.uid, sessionKey || '')

      const upstreamRes = await client.chatStream(auth, prepared, {
        ...rtOpts(r),
        clientIP: opts.clientIP,
        meta: chatMeta
      })

      // ===== 成功路径 =====
      r.pool.noteSuccess(auth.uid)
      // 成功即清该 (账号,模型) 的 11102 负缓存（参照实现 G 步的 BlockModelClear），
      // 避免一次误封或上游抖动把模型锁死到退避到期（6h 起、封顶 24h）
      r.pool.blockModelClear(auth.uid, model)
      if (sessionKey) r.session.bind(sessionKey, auth.uid)

      let cost = null
      let ttfbMs = 0
      if (isStream) {
        const out = await streamToClient(r, upstreamRes.stream, opts, releaseHeld, hintCtx, declaredTools)
        cost = out.cost
        ttfbMs = out.ttfbMs
      } else {
        const text = await client.readAll(upstreamRes.stream, 64 * 1024 * 1024)
        releaseHeld()
        const aggregated = sseMod.aggregateSSE(text)
        // 标记修复（非流式）：把正文里的原生工具调用标记还原成 message.tool_calls
        const mrepair = dsmlMod.repairAggregatedResponse(aggregated, declaredTools, true)
        logMarkupRepair(r, mrepair, model, declaredTools)
        cost = costOfUsage(aggregated && aggregated.usage)
        opts.onDone?.(aggregated)
      }
      // 成本台账：记录实测单价并内插扣减余额（参照 handler 的 NoteModelCost 接线）
      recordModelCost(r, auth.uid, model, cost)
      // 用量/积分统计：每次尝试（成功）都记一条
      recordUsageAttempt(r, { auth, model, rate: modelRate, startedAt: attemptStarted, ok: true, delta: cost })
      // 用量披露到日志文本：上游未回 usage 时三项显示 -（不伪造 0），积分四舍五入到 3 位抑制浮点尾数
      const usageText = cost && cost.totalTokens > 0
        ? ` 输入=${cost.pt} 输出=${cost.ct} 积分=${cost.hasCredit ? Math.round(cost.credit * 1000) / 1000 : '-'}`
        : ' 输入=- 输出=- 积分=-'
      r.pushLog('chat', `对话成功 model=${model} uid=${auth.uid.slice(0, 8)} ${isStream ? 'stream' : 'sync'} 耗时=${Date.now() - startedAt}ms${usageText}`)
      // credit：末帧 usage.credit 实测积分消耗（缺失时为 0），供请求日志「积分消耗」列
      return {
        ok: true,
        uid: auth.uid,
        ttfbMs,
        totalTokens: cost ? cost.totalTokens : 0,
        credits: cost ? cost.credit : 0,
        input: logInput,
        taskKey: logTaskKey
      }
    } catch (err) {
      releaseHeld()

      // 用量/积分统计：每次尝试（失败）都记一条（ok=false，err 计数 +1）
      recordUsageAttempt(r, { auth, model, rate: modelRate, startedAt: attemptStarted, ok: false, delta: null })

      // 内容拦截：passthrough/append 模式触发降级重试
      const kind = err.kind || errMod.ERR_KIND.CLIENT
      // gateway_hint：上游原文优先（err.body），无则用 message
      attachGatewayHint(err, kind, err.body || errMsgOf(err), hintCtx)
      if (
        kind === errMod.ERR_KIND.CONTENT_BLOCKED &&
        (r.cfg.promptMode === 'passthrough' || r.cfg.promptMode === 'append') &&
        !degradedApplied
      ) {
        promptMod.degradeTrigger()
        body = promptMod.rewrite(baseBody, promptMod.DEGRADED_PROMPT)
        degradedApplied = true
        tried.delete(auth.uid)
        r.pushLog('chat', '内容拦截（疑似指纹误报）→ 换降级提示词同请求重试')
        continue
      }

      // 错误处置（更新账号状态）
      applyErrorPolicy(r, auth.uid, err, model)

      // 失败号正是粘性号 → 解绑（下次请求重新分配）
      if (stickyUID && auth.uid === stickyUID) unbindSticky()

      // WAF 403 → IP 级 fail-fast（短窗多号命中即终止轮转，不再放大风控）
      if (kind === errMod.ERR_KIND.WAF_BLOCK && r.wafIpGate.noteWaf(auth.uid)) {
        wafIpBlocked = true
        r.pushLog('chat', 'WAF IP 级拦截判定（60s 窗内多个账号被拦）→ 终止本次轮转，等待窗口自然解除', 'warn')
      }

      // 请求级错误：不轮转，直接抛给调用方（补挂日志字段，供 router 失败日志完整记录）
      if (
        kind === errMod.ERR_KIND.PROMPT_TOO_LONG ||
        kind === errMod.ERR_KIND.IMAGE_INVALID ||
        kind === errMod.ERR_KIND.BAD_PARAMS ||
        kind === errMod.ERR_KIND.CONTENT_BLOCKED
      ) {
        err.input = logInput
        err.taskKey = logTaskKey
        throw err
      }

      if (err.transport) r.pool.noteFailures(auth.uid)
      lastError = err
      r.pushLog('chat', `换号重试 model=${model} uid=${auth.uid.slice(0, 8)} kind=${kind} ${errMsgOf(err)}`)
      // 轮转退避（参照 server/backoff.go）：base·2^n 封顶 8s，±25% 抖动；
      // 客户端断开（isAborted）或 IP 级 WAF 判定时立即停止轮转
      if (wafIpBlocked || !(await sleepCancellable(backoffAfter(attempt), opts.isAborted))) break
    }
  }

  const err = new Error(lastError ? lastError.message : 'All attempts failed')
  err.kind = lastError?.kind
  err.code = lastError?.code || 'all_attempts_failed'
  err.gatewayHint = lastError?.gatewayHint
  err.input = logInput
  err.taskKey = logTaskKey
  throw err
}

// 错误 → 账号状态处置（对照 applyErrorPolicy）
function applyErrorPolicy(r, uid, err, model) {
  const kind = err.kind || errMod.ERR_KIND.CLIENT
  const pool = r.pool
  const softBase = r.cfg.softRateMs

  switch (kind) {
    case errMod.ERR_KIND.HARD_CREDIT:
      pool.cooldownUntilTomorrow4AM(uid, '余额不足')
      return
    case errMod.ERR_KIND.SOFT_RATE: {
      const resetAt = err.rateResetMs || 0
      if (resetAt && err.isModelRateLimit && model) {
        pool.cooldownSoftForModel(uid, softBase, resetAt, model, '6004 model rate limit')
        return
      }
      if (resetAt) {
        pool.cooldownSoftRate(uid, softBase, resetAt, '429 rate limit')
        return
      }
      if (err.retryAfterMs > 0) {
        pool.cooldownSoftRate(uid, softBase, Date.now() + err.retryAfterMs, '429 rate limit (retry-after)')
        if (err.isModelRateLimit && model) {
          pool.recordModelRateLimitAudit(uid, model, '6004 model rate limit (reset unknown)')
        }
        return
      }
      pool.cooldownSoftRate(uid, softBase, 0, '429 rate limit')
      if (err.isModelRateLimit && model) {
        pool.recordModelRateLimitAudit(uid, model, '6004 model rate limit (reset unknown)')
      }
      return
    }
    case errMod.ERR_KIND.WAF_BLOCK: {
      const base = jitterDuration(60000)
      if (err.retryAfterMs > 0) pool.cooldownSoftRate(uid, base, Date.now() + err.retryAfterMs, 'waf 403 block (retry-after)')
      else pool.cooldownSoftRate(uid, base, 0, 'waf 403 block')
      return
    }
    case errMod.ERR_KIND.SESSION_DEAD:
      pool.disable(uid, '12153 session dead')
      return
    case errMod.ERR_KIND.NOT_FOUND:
      pool.cooldown(uid, pool.COOL_SOFT, C.POOL_DEFAULTS.notFoundCooldownMs, 'upstream 404')
      return
    case errMod.ERR_KIND.ACCOUNT_FAULT: {
      const body = String(err.body || '').toLowerCase()
      if (body.includes('request illegal')) {
        pool.disable(uid, 'account banned by upstream (11140 request illegal), re-login required')
      } else {
        pool.cooldown(uid, pool.COOL_SOFT, softBase, 'account fault (14017)')
      }
      return
    }
    case errMod.ERR_KIND.SERVER:
      pool.noteError(uid)
      return
    case errMod.ERR_KIND.MODEL_BLOCKED:
      if (model) pool.blockModelBackoff(uid, model, pool.reason.MODEL_BLOCK_REASON)
      return
    case errMod.ERR_KIND.CONTENT_BLOCKED:
    case errMod.ERR_KIND.PROMPT_TOO_LONG:
    case errMod.ERR_KIND.IMAGE_INVALID:
    case errMod.ERR_KIND.BAD_PARAMS:
      return // 请求级错误不罚号
    default:
      pool.noteFailures(uid)
  }
}

// ±25% 均匀抖动
function jitterDuration(baseMs) {
  return Math.round(baseMs * (0.75 + Math.random() * 0.5))
}

// 轮转退避时长（参照 server/backoff.go backoffAfter）：base·2^n 封顶 cap，再施加 ±25% 抖动
function backoffAfter(n) {
  const base = C.ROTATE_BACKOFF.baseMs
  if (!(base > 0)) return 0
  let d = base
  for (let k = 0; k < n && d < C.ROTATE_BACKOFF.capMs; k++) d *= 2
  if (d > C.ROTATE_BACKOFF.capMs) d = C.ROTATE_BACKOFF.capMs
  return jitterDuration(d)
}

// 可取消等待（参照 sleepCtx）：isAborted() 为真立即返回 false，等满返回 true
function sleepCancellable(ms, isAborted) {
  if (!(ms > 0)) return Promise.resolve(!(isAborted && isAborted()))
  return new Promise(resolve => {
    const stepMs = 50
    let elapsed = 0
    const timer = setInterval(() => {
      elapsed += stepMs
      if (isAborted && isAborted()) {
        clearInterval(timer)
        resolve(false)
        return
      }
      if (elapsed >= ms) {
        clearInterval(timer)
        resolve(true)
      }
    }, stepMs)
    if (timer.unref) timer.unref()
  })
}

// 请求体是否携带 image_url part（参照 hasImagePart：判不出就不给「模型不支持图片」指向）
function hasImagePart(bodyText) {
  let obj
  try {
    obj = JSON.parse(bodyText)
  } catch {
    return false
  }
  const messages = Array.isArray(obj?.messages) ? obj.messages : []
  for (const m of messages) {
    const content = m?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part && part.type === 'image_url') return true
    }
  }
  return false
}

// gateway_hint 判定上下文（参照 handler.hintContext；必须在提示词改写前取）
function hintContextOf(r, bodyText, model) {
  const entry = (r.models.list || []).find(m => m && m.id === model)
  return {
    model: model || '',
    hasImage: hasImagePart(bodyText),
    modelInCatalog: !!entry,
    modelSupportsImages: !!(entry && entry.supportsImages)
  }
}

// 附加上游错误的 gateway_hint（origin 为上游原文；未覆盖形态不写字段）
function attachGatewayHint(err, kind, origin, ctx) {
  if (!err || err.gatewayHint) return
  const hint = errMod.gatewayHint(kind, String(origin || err.message || ''), ctx || {})
  if (hint) err.gatewayHint = hint
}

// SSE error 帧附加 gateway_hint（参照 hint.FrameHintFunc）：非 error 帧或无 hint 原样返回
function attachFrameHint(payloadText, hintCtx) {
  let obj
  try {
    obj = JSON.parse(payloadText)
  } catch {
    return payloadText
  }
  if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, 'error')) return payloadText
  let hint = ''
  try {
    hint = errMod.gatewayHint(errMod.frameKind(payloadText), payloadText, hintCtx || {})
  } catch {
    hint = ''
  }
  if (!hint) return payloadText
  const base = obj.error && typeof obj.error === 'object' ? obj.error : { message: String(obj.error || '') }
  return JSON.stringify({ ...obj, error: { ...base, gateway_hint: hint } })
}

// 从 usage 提取成本台账 / 用量记录输入（末帧 usage.credit 与 token 字段）；
// 返回 null 仅当 usage 非对象。hasCredit = 末帧 usage 里是否真有 credit 字段
// （缺失不伪造 0）；pt/ct 缺失记 0；tt 缺失时用 pt+ct 兜底。
function costOfUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const hasPT = typeof usage.prompt_tokens === 'number'
  const hasCT = typeof usage.completion_tokens === 'number'
  const pt = hasPT ? usage.prompt_tokens : 0
  const ct = hasCT ? usage.completion_tokens : 0
  let total = typeof usage.total_tokens === 'number' ? usage.total_tokens : 0
  if (!total && (hasPT || hasCT)) total = pt + ct
  const hasCredit = typeof usage.credit === 'number'
  return {
    credit: hasCredit ? usage.credit : 0,
    totalTokens: total,
    hasCredit,
    pt,
    ct,
    tt: total
  }
}

// 记录一次请求尝试的用量（供「用量」视图）：成功/失败都计请求数，失败另计失败数；
// latMs = 本次尝试耗时（下限 1ms）；tps = tt/(latMs/1000)；记录失败不影响主流程
function recordUsageAttempt(r, info) {
  if (!r.usage) return
  const delta = info.delta
  const latMs = Math.max(1, Date.now() - info.startedAt)
  const tt = delta ? Number(delta.tt) || 0 : 0
  try {
    r.usage.record({
      uid: (info.auth && info.auth.uid) || '',
      model: info.model || '',
      rate: info.rate || '',
      ok: !!info.ok,
      pt: delta ? Number(delta.pt) || 0 : 0,
      ct: delta ? Number(delta.ct) || 0 : 0,
      tt,
      latMs,
      tps: tt > 0 ? tt / (latMs / 1000) : 0,
      credit: delta ? Number(delta.credit) || 0 : 0,
      hasCredit: !!(delta && delta.hasCredit)
    })
  } catch {
    /* 用量记录异常不影响主流程 */
  }
}

// 取模型在 r.models.list 里的积分倍率（rate 字段，缺失为 ''）
function modelRateOf(r, model) {
  const list = (r.models && r.models.list) || []
  const entry = list.find(m => m && m.id === model)
  return entry && typeof entry.rate === 'string' ? entry.rate : ''
}

// 记录实测成本（免费窗口结束打日志）+ 账号级 token 消耗；台账异常不影响主流程
// 无有效 token 总数（totalTokens<=0）时不记账，保持与既有余额内插口径一致
function recordModelCost(r, uid, model, cost) {
  if (!cost || !(cost.totalTokens > 0)) return
  try {
    r.pool.noteTokenUsage(uid, cost.totalTokens)
    const res = r.pool.noteModelCost(uid, model, cost.credit, cost.totalTokens)
    if (res.ok && res.freeTierEnded) {
      r.pushLog('system', `模型 ${model} 在账号 ${uid.slice(0, 8)} 上的免费窗口结束（实测 ${res.costPer1k.toFixed(3)} 积分/1k）`)
    }
  } catch {
    /* 忽略 */
  }
}

// 设备令牌文件读取（参照 device_token.go）：5 分钟缓存 + ≤1KB + 读失败优雅降级（不注入）
let dtFileCache = { path: '', token: '', readAt: 0 }
function readDeviceTokenCached(filePath) {
  const p = String(filePath || '')
  if (!p) return ''
  const now = Date.now()
  if (p === dtFileCache.path && now - dtFileCache.readAt < C.DEVICE_TOKEN_FILE.cacheTtlMs) return dtFileCache.token
  dtFileCache.path = p
  dtFileCache.readAt = now
  try {
    const stat = fs.statSync(p)
    if (stat.size > C.DEVICE_TOKEN_FILE.maxLen) {
      dtFileCache.token = ''
      return ''
    }
    dtFileCache.token = String(fs.readFileSync(p, 'utf8')).trim()
    return dtFileCache.token
  } catch {
    dtFileCache.token = ''
    return ''
  }
}

// 流式转发：SSE 帧白名单重建 + 标记修复 + [DONE] 恰好一次 + 空流兜底
// 返回值：Promise<costInfo|null>（末帧 usage 的成本台账输入）
function streamToClient(r, upstreamStream, opts, releaseHeld, hintCtx, declaredTools) {
  return new Promise(resolve => {
    // 标记修复（见 dsml.js）：上游在没有 tools 的请求里会把工具调用吐成正文标记，
    // 这里在透传前还原成 delta.tool_calls；名单为空时启用弱判定（tools 声明在
    // 链路上丢失是实测最常见的泄漏成因，只做严格判定等于对主场景不设防）
    const repair = dsmlMod.createMarkupRepair(declaredTools, true)
    const rebuilder = sseMod.createFrameRebuilder({ repair })
    const idleMs = C.TIMEOUT_DEFAULTS.idleTimeoutMs
    let validFrames = 0
    let doneSent = false
    let buffer = ''
    let finished = false
    let idleTimer = null
    let lastActivity = Date.now()
    let costInfo = null
    const startedAt = Date.now()
    let ttfbMs = 0

    const finish = () => {
      if (finished) return
      finished = true
      if (idleTimer) clearInterval(idleTimer)
      releaseHeld()
      resolve({ cost: costInfo, ttfbMs })
    }

    const writeFrame = payload => {
      if (doneSent) return
      try {
        opts.onChunk?.(`data: ${payload}\n\n`)
      } catch {
        /* 客户端已断开 */
      }
    }

    const writeDone = () => {
      if (doneSent) return
      doneSent = true
      try {
        opts.onChunk?.('data: [DONE]\n\n')
      } catch {
        /* 客户端已断开 */
      }
    }

    // 空闲监控：超过 idle 未收到字节则中止
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > idleMs) {
        try {
          upstreamStream.destroy()
        } catch {
          /* 忽略 */
        }
        handleEnd()
      }
    }, Math.max(10, Math.min(1000, Math.floor(idleMs / 4))))
    if (idleTimer.unref) idleTimer.unref()

    const handleLine = line => {
      const trimmed = line.replace(/\r+$/, '')
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6).trim()
        if (payload === '[DONE]') return 'done'
        const result = rebuilder.push(payload)
        if (result.valid) {
          validFrames++
          if (!ttfbMs) ttfbMs = Date.now() - startedAt // 首个有效帧到达耗时（TTFB）
          // 成本台账输入：末帧 usage（credit + token 总数）；标记修复可能把一帧
          // 展开成多帧，逐帧找携带 usage 的那一帧
          if (payload.includes('"usage"')) {
            for (const p of result.payloads) {
              if (!p.includes('"usage"')) continue
              let frameObj = null
              try {
                frameObj = JSON.parse(p)
              } catch {
                frameObj = null
              }
              const c = costOfUsage(frameObj && frameObj.usage)
              if (c) costInfo = c
            }
          }
        }
        // error 帧附加 gateway_hint（参照 hint.FrameHintFunc），非 error 帧原样
        for (const p of result.payloads) writeFrame(attachFrameHint(p, hintCtx))
        return ''
      }
      if (trimmed !== '') {
        // 注释等其他行原样透传
        try {
          opts.onChunk?.(`${trimmed}\n`)
        } catch {
          /* 忽略 */
        }
      }
      return ''
    }

    // 流末统一收尾：标记修复尾部回吐 + 兜底收尾帧 + 空流兜底 + [DONE]。
    // [DONE] 到达与 EOF/错误收尾都汇到这里（幂等）
    const finalize = () => {
      if (finished) return
      // 标记修复收尾：未判定的尾部字节一律原文回吐（绝不吞字节，未闭合的块连
      // 起始标记一起交还）；本流还原过调用但上游没给收尾帧时，补一帧
      // finish_reason: tool_calls（客户端才不会把「工具调用回合」读成「只说了话」）
      const tail = rebuilder.finish()
      for (let i = 0; i < tail.payloads.length; i++) {
        writeFrame(tail.payloads[i])
        if (i < tail.validCount) validFrames++
      }
      logMarkupRepair(r, repair, opts.model, declaredTools)
      if (validFrames === 0) {
        writeFrame('{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}')
      }
      writeDone()
      finish()
    }

    const handleEnd = () => {
      if (finished) return
      // 冲刷残行
      if (buffer) {
        const res = handleLine(buffer)
        buffer = ''
        if (res === 'done') {
          finalize()
          return
        }
      }
      finalize()
    }

    upstreamStream.on('data', chunk => {
      if (finished) return
      lastActivity = Date.now()
      buffer += chunk.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const res = handleLine(line)
        if (res === 'done') {
          // [DONE] 后不再透传任何数据（含垃圾帧），收尾统一走 finalize
          // （先回吐标记修复的尾缓冲与兜底收尾帧，再写 [DONE]）
          finalize()
          try {
            upstreamStream.destroy()
          } catch {
            /* 忽略 */
          }
          return
        }
      }
    })
    upstreamStream.on('end', handleEnd)
    upstreamStream.on('error', handleEnd)
    upstreamStream.on('close', handleEnd)
  })
}

// 标记修复命中统计（对齐参考实现：还原成功记 INFO、识别到但拒绝记 WARN——
// 排障时能一眼区分「没识别到」与「识别到但判定不通过」）
function logMarkupRepair(r, repair, model, declaredTools) {
  if (!repair) return
  const known = declaredTools ? declaredTools.size : 0
  if (repair.converted() > 0) {
    r.pushLog('chat', `已从助手正文还原 ${repair.converted()} 个原生工具调用（model=${model || ''}，已知工具名 ${known} 个）`, 'info')
  } else if (repair.seen() > 0) {
    r.pushLog('chat', `识别到 ${repair.seen()} 个原生工具调用标记块但未还原（model=${model || ''}，已知工具名 ${known} 个）`, 'warn')
  }
}

// 会话头族 meta（参照 handler 的 chatMeta 装配）：
// conversationID 透传客户端原值；客户端没有时（Anthropic / Claude Code 流量）回退会话键，
// 否则 X-Conversation-ID 缺失、上游 prompt_cache_key 会退化为每账号一个常量——同账号下
// 所有客户端共享一个不断被逐出的前缀缓存槽（对齐参考项目 #133）；conversationRequestID
// 入站头透传优先，否则 轮级复合键 > 纯轮级键 > 会话级键 > 请求级随机；traceId 入站透传
function buildChatMeta(body, keys = {}) {
  const inbound = keys.inbound || {}
  let conversationId = sessionMod.resolveConversationId(body)
  if (!conversationId) conversationId = keys.sessionKey || ''
  let conversationRequestId = strOr(inbound.conversationRequestId)
  if (!conversationRequestId) {
    const sessKey = keys.sessionKey || ''
    const turn = keys.turnKey || ''
    if (turn && sessKey) conversationRequestId = sessionMod.turnRequestId(`${sessKey}:${turn}`)
    else if (turn) conversationRequestId = sessionMod.turnRequestId(turn)
    else if (sessKey) conversationRequestId = sessionMod.requestIdForKey(sessKey)
    else conversationRequestId = sessionMod.turnRequestId('')
  }
  return { conversationId, conversationRequestId, traceId: strOr(inbound.traceId) }
}

function strOr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

// 运行时配置 → 客户端调用选项
function rtOpts(r) {
  return {
    clientVersion: C.DEFAULT_CLIENT_VERSION,
    cliVersion: C.DEFAULT_CLI_VERSION,
    clientName: 'WorkBuddy',
    userAgent: '',
    passthroughIP: false,
    // 设备令牌文件兜底（参照 device_token.go：5min 缓存 + ≤1KB + 读失败不注入）
    deviceTokenFileReader: () => readDeviceTokenCached(r.cfg.deviceTokenFile)
  }
}

// ===== 积分构成 / 模型清单 / 运行日志 =====

// 单账号积分批次明细（积分构成视图）
async function creditPackages(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  return client.resourcePackages(auth, { ...rtOpts(r), expiringSoonMs: r.pool.getConfig().expiringSoonMs })
}

// 积分变动流水（新的在前；limit 默认 200、上限 1000，uid 可选精确过滤）
// 账号昵称在读取时用池快照填充——账本只存 uid，上游改名后旧流水也跟着更新
function creditHistory(limitArg, uidArg) {
  const r = ensure()
  let limit = Math.trunc(Number(limitArg)) || 0
  if (limit <= 0) limit = 200
  if (limit > 1000) limit = 1000
  const uid = String(uidArg || '').trim()

  // 有 uid 过滤时必须先全量取回（账本上限默认 2000 条）：先截断再过滤会让筛选后的
  // 条数看起来像历史缺失；无过滤时只取 limit 条，不为一次展示拷贝整个账本
  const all = r.creditHist.read(uid ? 0 : limit)

  const nicks = new Map()
  for (const st of r.pool.list()) {
    if (st.nickname) nicks.set(st.uid, st.nickname)
  }

  const entries = []
  for (const e of all) {
    if (uid && e.uid !== uid) continue
    entries.push({ ...e, account: nicks.get(e.uid) || '' })
    if (entries.length >= limit) break
  }
  return { entries, limit }
}

// 账号池统一维护的启用模型清单（供 Provider 同步）
function getEnabledModels() {
  return ensure().enabledModels || []
}

// 设置启用模型清单（内存态；持久化由调用方写入 server-config）
function setEnabledModels(models) {
  const r = ensure()
  const list = Array.isArray(models) ? models : []
  r.enabledModels = list
    .map(m => ({
      id: String(m?.id || '').trim(),
      displayName: String(m?.displayName || m?.name || '').trim(),
      maxContext: toIntOrNull(m?.maxContext),
      maxOutput: toIntOrNull(m?.maxOutput)
    }))
    .filter(m => m.id)
  return r.enabledModels
}

// 正整数或 null（未配置不写入）
function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

// 运行日志查询（环形缓冲，支持频道/级别/关键字过滤；返回新 → 旧，最新的排最前）
function getLogs(options = {}) {
  const r = ensure()
  const channel = String(options.channel || '')
  const level = String(options.level || '')
  const keyword = String(options.keyword || '').toLowerCase()
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500)

  let list = r.logBuffer
  if (channel) list = list.filter(e => e.channel === channel)
  if (level) list = list.filter(e => e.level === level)
  if (keyword) list = list.filter(e => e.message.toLowerCase().includes(keyword))
  // 环形缓冲按写入顺序存放：取最后 limit 条后倒序，保证新的在最前面
  return list.slice(-limit).reverse()
}

// ===== 成长任务 =====

// 查询单账号任务列表（含进度与奖励）
async function taskList(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  return tasksMod.fetchTasks(auth, rtOpts(r))
}

// 一键完成：taskCode 为空跑全部可自动化任务，否则只跑指定任务
async function taskRun(uid, taskCode) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  return taskCode ? r.taskRunner.runOne(auth, taskCode) : r.taskRunner.runAll(auth)
}

// 任务执行进度快照
function taskProgress() {
  return ensure().taskRunner.getProgress()
}

// 全账号任务扫描（返回每账号未完成/可自动化任务）
async function taskScan() {
  const r = ensure()
  const auths = r.pool
    .list()
    .filter(st => !st.disabled)
    .map(st => r.pool.authByUID(st.uid))
    .filter(Boolean)
  return tasksMod.scanTasks(auths)
}

// 全账号任务扫描（含 pending_count 汇总）
async function taskScanAll() {
  const accounts = await taskScan()
  let pendingCount = 0
  for (const a of accounts) pendingCount += (a.pending || []).length
  return { accounts, pending_count: pendingCount }
}

// 接受任务（uid 指定账号；codes 为空则接受该账号全部未接受任务）
async function taskAccept(uid, codes) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  const list = (Array.isArray(codes) ? codes : []).filter(Boolean)
  if (list.length > 0) {
    await tasksMod.acceptTasks(auth, list, rtOpts(r))
    return { ok: true, accepted: list.length }
  }
  const res = await tasksMod.acceptAllFor(auth, rtOpts(r), r.log)
  return { ok: true, accepted: res.accepted, failed: res.failed }
}

// 接受多个账号的全部未接受任务（uids 为空则全部非禁用账号）
async function taskAcceptAll(uids) {
  const r = ensure()
  const filter = Array.isArray(uids) && uids.length > 0 ? new Set(uids.map(String)) : null
  const states = r.pool.list().filter(st => !st.disabled && (!filter || filter.has(String(st.uid))))
  let accepted = 0
  const failed = []
  const accounts = []
  for (const st of states) {
    const auth = r.pool.authByUID(st.uid)
    if (!auth) continue
    try {
      const res = await tasksMod.acceptAllFor(auth, rtOpts(r), r.log)
      accepted += res.accepted
      failed.push(...res.failed)
      accounts.push({ uid: st.uid, accepted: res.accepted })
    } catch (err) {
      accounts.push({ uid: st.uid, accepted: 0, error: err.message })
    }
  }
  return { ok: true, accepted, failed, accounts }
}

// 单独领取某任务奖励（mp 专属码走 mp 口径）
async function taskClaim(uid, taskCode) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  const code = String(taskCode || '').trim()
  if (!code) throw new Error('缺少 taskCode')
  const res = await tasksMod.claimTask(auth, code, rtOpts(r))
  return { ok: true, already_claimed: !!res.alreadyClaimed, credit: res.credit, energy: res.energy }
}

// 全账号（或指定 uids）入队执行成长任务
function queueOnce(uids, options) {
  const r = ensure()
  return r.taskQueue.runQueueOnce(uids, options || {})
}

// 指定账号入队执行指定任务码
function enqueue(uid, codes) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  const nickname = auth ? auth.nickname : ''
  const n = r.taskQueue.enqueue(uid, codes, { nickname, auth })
  return { ok: true, enqueued: n }
}

// 队列状态快照（轮询用）
function queueStatus() {
  return ensure().taskQueue.queueStatus()
}

// 确保运行时已初始化
function ensure() {
  if (!rt) throw new Error('WorkBuddy 运行时未初始化')
  return rt
}

// 更新运行时配置（热生效）
function updateConfig(patch) {
  const r = ensure()
  if (typeof patch.promptMode === 'string') r.cfg.promptMode = patch.promptMode
  if (typeof patch.promptFile === 'string') r.cfg.promptText = promptMod.loadPrompt(patch.promptFile)
  if (typeof patch.sanitizeFingerprints === 'boolean') r.cfg.sanitizeFingerprints = patch.sanitizeFingerprints
  if (typeof patch.deviceTokenFile === 'string') r.cfg.deviceTokenFile = patch.deviceTokenFile
  if (patch.poolConfig) r.pool.updateConfig(patch.poolConfig)
}

function errMsgOf(err) {
  return err?.message || String(err)
}

module.exports = {
  init,
  getRuntime,
  updateConfig,
  // OAuth
  oauthStart,
  oauthPoll,
  // 账号运维
  listAccounts,
  removeAccount,
  checkinAccount,
  refreshBalance,
  refreshAllBalances,
  refreshBalanceFor,
  reviveAccount,
  keepaliveAccount,
  refreshTokenFor,
  disableAccount,
  enableAccount,
  accountRunningAction,
  setAccountRunning,
  // 模型
  listUpstreamModels,
  effortsSnapshot,
  // 转发
  forwardChat,
  applyErrorPolicy,
  // 供单测/调试：轮转退避与设备令牌文件读取
  backoffAfter,
  readDeviceTokenCached,
  // 定时任务调度
  schedulerState: () => ensure().scheduler.getState(),
  schedulerRun: task => ensure().scheduler.runNow(task),
  schedulerUpdateConfig: patch => ensure().scheduler.updateConfig(patch),
  // 成长任务
  taskList,
  taskRun,
  taskProgress,
  taskScan,
  taskScanAll,
  taskAccept,
  taskAcceptAll,
  taskClaim,
  queueOnce,
  enqueue,
  queueStatus,
  // 积分构成 / 模型清单 / 运行日志
  creditPackages,
  creditHistory,
  getEnabledModels,
  setEnabledModels,
  getLogs,
  // 用量 / 积分消耗统计
  usageSnapshot: hours => ensure().usage.snapshot(hours),
  usageSave: () => ensure().usage.save()
}