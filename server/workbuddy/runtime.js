// WorkBuddy 运行时：账号池、会话粘性、模型缓存、聊天转发（换号重试与错误处置闭环）

const fs = require('fs')
const path = require('path')
const { StringDecoder } = require('string_decoder')
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
const identityMod = require('./identity')

// 运行时单例（Express 与 Electron 主进程同进程，全局唯一）
let rt = null

// 账号操作运行态（uid → 动作名；进程内状态，供面板显示「保活中」等）
const runningActions = new Map()

// 关停运行时：导入配置/账号后要按新文件重新 init，否则池里还是旧账号。
// 与 __resetForTest 同一步骤，但语义是生产用的 —— 停定时器后再让 init 重建。
function shutdown() {
  if (!rt) return
  try {
    rt.scheduler?.stop?.()
  } catch {}
  try {
    rt.session?.stopGC?.()
  } catch {}
  try {
    rt.pool?.stopFlusher?.()
  } catch {}
  rt = null
}

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

  // 凭证加载 → 账号池对齐（先 load 恢复状态，再注入凭证）
  const auths = authMod.loadDir(authDir)
  pool.syncToDir(auths)

  // 用量/积分消耗统计：落盘 data/usage.json，启动加载、30s 防抖自动落盘
  const usage = usageMod.createUsage({ dataDir, file: opts.usageFile })
  usage.load()

  // 积分历史账本（留痕语义见 credithist.js）：挂 client 余额观察者，覆盖签到 /
  // 活跃上报 / 旅行 / 保活 / 面板手动刷新，落盘 data/credit-history.json
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
  // 单参数默认系统频道；任务模块统一走 taskLog（显式 task 频道）
  // 保留前缀兜底：个别带 [WorkBuddy任务] 的旧格式消息仍归入任务频道
  const log = (message, channel) => {
    const ch = channel || (String(message).includes('[WorkBuddy任务]') ? 'task' : 'system')
    pushLog(ch, message)
  }
  // 任务模块专用日志（成长任务执行器 / 执行队列 / 定时任务调度器）
  const taskLog = message => pushLog('task', message)

  rt = {
    dataDir,
    authDir,
    stateFile,
    pool,
    session,
    usage,
    creditHist,
    log,
    taskLog,
    pushLog,
    logBuffer,
    cfg: {
      promptMode: opts.promptMode || 'custom', // custom / append / passthrough
      promptText,
      sanitizeFingerprints: opts.sanitizeFingerprints !== false,
      rewriteMode: opts.rewriteMode === 'native' ? 'native' : 'compat', // 改写档位：compat 全量修补 / native 原生透传
      // 使用端身份：workbuddy = 官方桌面端指纹（默认）/ codebuddy = 官方 IDE 指纹（官网「使用端」显示 CodeBuddy）
      clientIdentity: opts.clientIdentity === 'codebuddy' ? 'codebuddy' : 'workbuddy',
      // 客户端指纹与版本覆盖（UA / 版本号 / 事件体指纹 / 语言 / 域名；白名单归一化，空=官方默认）
      identity: identityMod.normalize(opts.identity),
      softRateMs: opts.poolConfig?.softRateMs || C.POOL_DEFAULTS.softRateMs,
      callbackUrl: opts.callbackUrl || '',
      deviceTokenFile: opts.deviceTokenFile || '' // 设备令牌文件路径
    },
    // 模型目录缓存：按区域分槽（byRealm.cn / byRealm.global / byRealm.all）。
    // 两地模型清单、倍率、思考档位都可能不同，不能共用一个槽位
    models: { byRealm: {} },
    // 启用模型清单：按区域分开（国内/国际的可用模型不同）
    enabledModelsByRealm: {
      cn: Array.isArray(opts.enabledModels) ? opts.enabledModels : [],
      global: Array.isArray(opts.enabledModelsGlobal) ? opts.enabledModelsGlobal : []
    },
    logins: new Map(), // OAuth state → { created }
    loginTTL: 15 * 60 * 1000,
    wafIpGate: wafipMod.createWafIpGate(opts.poolConfig?.wafIp || {}) // WAF IP 级 fail-fast 门
  }

  // 成长任务执行器（一键完成：事件上报 + 真实对话 + 自动领奖）
  rt.taskRunner = tasksMod.createTaskRunner({
    client,
    log: taskLog,
    chatOnce
  })

  // 成长任务执行队列（账号内串行 / 账号间并发夹取 [1,4]，默认 2）
  // skipAuth：国际版无成长体系 —— 在队列内统一门控，使「全账号」入口
  // （runtime.queueOnce 与定时 growthHook 直调 runQueueOnce）都受控，
  // 避免对必然被上游拒绝的端点空发请求并污染错误计数
  rt.taskQueue = queueMod.createQueue({
    pool,
    log: taskLog,
    skipAuth: skipGrowthExecFor,
    // 账号占用与一键完成 / 补领清扫共用一把锁（tasks.js 模块级单表）。
    // 队列在 runAccount 外层取锁并整轮持有，条目执行时不再重复抢占（lockHeld）。
    tryLockAccount: tasksMod.tryLockAccount,
    unlockAccount: tasksMod.unlockAccount,
    scanPending: auth => tasksMod.scanPendingCodes(auth, rtOpts(rt, auth)),
    runCode: (auth, code) => {
      const opts = rtOpts(rt, auth)
      opts.lockHeld = true // 队列已持有该账号占用
      return rt.taskRunner.runOne(auth, code, opts)
    }
  })

  // 定时任务调度器（签到/活跃/旅行/保活/夜猫子/成长队列 + 余额后台刷新）
  rt.scheduler = schedulerMod.createScheduler({
    pool,
    client,
    auth: authMod,
    refreshTokenFor: a => refreshTokenFor(rt, a),
    refreshBalanceFor: a => refreshBalanceFor(rt, a),
    log: taskLog,
    scheduleConfig: opts.scheduleConfig || {},
    // 使用端身份（实时读取，热改后任务类请求同样跟随）
    clientIdentityFor: () => rt.cfg.clientIdentity,
    // 客户端指纹与版本覆盖（实时读取，热改后任务类请求同样跟随）
    identityFor: () => rt.cfg.identity,
    // 到点触发成长任务队列（与「全账号入队执行」同管线）
    growthHook: () => {
      // 不用 void 直接丢弃：runQueueOnce 抛错会变成未捕获 rejection，
      // Node 15+ 默认终止进程（Electron 主进程同样受影响）
      rt.taskQueue.runQueueOnce().catch(err => {
        rt.pushLog('task', `成长任务队列触发失败：${err.message}`, 'error')
      })
    },
    // 到点补领「已达标未领」的成长任务奖励（分钟级、幂等，不跑行为链路）。
    // 走 runtime 注入是为了拿到区域感知的 rtOpts（identity / 域名映射）与共享账号锁。
    taskSweepHook: () => sweepGrowthTasks(rt)
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
  const res = await client.chatStream(auth, prepared, rtOpts(r, auth))
  const text = await client.readAll(res.stream, 8 * 1024 * 1024)
  return sseMod.aggregateSSE(text)
}

// 取运行时（未初始化返回 null）
function getRuntime() {
  return rt
}

// ===== OAuth 账号登录 =====

// 发起 OAuth：返回 { state, url }
// realm：'cn'（默认）或 'global'。国际版与国内版的 OAuth 路径完全相同，
// 只有域名/Origin/UA 不同，故这里把区域贯穿到出站 opts，并在 login 会话里记住，
// 供 poll 阶段用同一区域落盘（避免用错域名取账号信息）
async function oauthStart(realm) {
  const r = ensure()
  cleanupLogins(r)
  const want = authMod.resolveRealmForLogin(realm, '')
  const { state, authUrl } = await client.oauthStart(rtOpts(r, want))
  r.logins.set(state, { created: Date.now(), realm: want })
  r.log(
    'workbuddy: 发起 OAuth 添加账号（' +
      (want === authMod.REALM_GLOBAL ? '国际版' : '国内版') +
      ` state=${state.slice(0, 8)}...）`
  )
  return { state, url: authUrl, realm: want }
}

// 轮询 OAuth 结果：完成则落盘 + 热加载进池
async function oauthPoll(state) {
  const r = ensure()
  cleanupLogins(r)
  const sess = r.logins.get(state)
  if (!sess) throw new Error('unknown or expired state（请重新发起添加账号）')

  // 先用「用户选择的区域」取 token —— 必须早于任何 token.domain 的使用：
  // token 尚未取回时引用它会抛 TDZ ReferenceError，导致轮询恒失败、账号永远不落盘
  // （现象：浏览器已完成授权，界面一直停在「等待登录」）
  const wantRealm = authMod.resolveRealmForLogin(sess.realm, '')
  const opts = rtOpts(r, wantRealm)

  const token = await client.oauthPollToken(state, opts)
  // 落盘区域：用户选择优先；用户没选时用上游返回的 domain 兜底推断
  const realm = wantRealm || authMod.resolveRealmForLogin('', token.domain)
  const account = await client.oauthFetchAccount(state, token.accessToken, opts)
  const uid = account?.uid || ''
  if (!authMod.validUID(uid)) {
    throw new Error('上游返回的 uid 含非法字符，拒绝落盘（防路径穿越）')
  }

  const auth = {
    uid,
    enterpriseId: account?.enterpriseId || '',
    nickname: account?.nickname || '',
    domain: token.domain || '',
    // 区域以用户选择为准（显式 realm 优先于 domain 推断）
    realm,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn > 0 ? Math.floor(Date.now() / 1000) + token.expiresIn : 0,
    deviceToken: '',
    filePath: authMod.pathFor(r.authDir, uid)
  }
  authMod.saveAtomic(auth)
  r.pool.add(auth)
  r.pool.revive(uid) // 全新登录 = 人工恢复口径
  invalidateModelCache(r) // 失效模型缓存（所有区域）

  // 顺带签到 + 余额刷新（失败不影响登录结果）
  // 国际版不提供签到能力，跳过并如实标注（见 shouldSkipCheckin）
  let checkinMessage = ''
  let credits = -1
  let creditsTotal = 0
  if (skipCheckinFor(auth)) {
    checkinMessage = '国际版账号无签到能力，已跳过'
  } else {
    try {
      const ck = await client.dailyCheckin(auth, opts)
      checkinMessage = ck.message || ''
    } catch (err) {
      checkinMessage = `签到失败: ${err.message}`
    }
  }
  try {
    const res = await client.userResource(auth, { ...opts, expiringSoonMs: r.pool.getConfig().expiringSoonMs })
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
  r.log(
    `workbuddy: 新账号已热加载 uid=${uid} nickname="${auth.nickname}" ` +
      `区域=${realm === authMod.REALM_GLOBAL ? '国际版' : '国内版'}（免重启生效）`
  )
  return {
    done: true,
    uid,
    nickname: auth.nickname,
    realm,
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
  invalidateModelCache(r)
  return true
}

// 单号签到
async function checkinAccount(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) return { ok: false, message: '账号不存在' }
  return runTracked(uid, 'checkin', async () => {
    const res = await client.dailyCheckin(auth, rtOpts(r, auth))
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
    const res = await client.userResource(auth, { ...rtOpts(r, auth), expiringSoonMs: r.pool.getConfig().expiringSoonMs })
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
    const res = await client.refreshToken(auth, rtOpts(r, auth))
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
      // refresh 失效但 AT 仍有效：账号还能用，不计死、不罚号。
      // 顺手把历史计数清零（落盘），否则下次真失败会被旧计数推到阈值。
      if (authMod.atStillValid(auth)) {
        r.pool.clearSessionDead(auth.uid)
        r.log(`workbuddy: keepalive uid=${auth.uid} refresh 失败但 AT 仍有效，保留账号`)
        return { ok: true, kept: true }
      }
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

// 拉取上游模型列表（1h 缓存，按区域分别缓存）；force 强制刷新
// realm：'cn' / 'global' 按区域拉取。不传区域时按「选中账号自身的区域」缓存
//（绝不混区：两地清单不同，混在 all 槽位会让某区域的请求拿到另一区域的目录）。
async function listUpstreamModels(force, realm) {
  const r = ensure()
  const now = Date.now()

  // 任取一个可用账号（健康优先，其次任意非禁用）；限定区域时只在区域内挑
  const accounts = r.pool.list()
  const realmOfUid = uid => {
    const a = r.pool.authByUID(uid)
    return a && a.realm === 'global' ? 'global' : 'cn'
  }
  const inScope = st => !realm || realmOfUid(st.uid) === realm
  let picked = null
  for (const st of accounts) {
    if (!st.disabled && inScope(st)) {
      picked = r.pool.authByUID(st.uid)
      break
    }
  }
  for (const st of accounts) {
    if (!picked && inScope(st)) picked = r.pool.authByUID(st.uid)
  }
  if (!picked) {
    const label = realm === 'global' ? '国际版' : realm === 'cn' ? '国内版' : ''
    throw new Error(`没有可用的${label}账号，请先添加 WorkBuddy 账号`)
  }

  // 缓存槽位按实际选中账号的区域（传了区域则必等于该区域）
  const scope = realmOfUid(picked.uid)
  const slot = (r.models.byRealm && r.models.byRealm[scope]) || { ts: 0, list: [], efforts: {}, defaultEfforts: {} }
  if (!force && slot.list.length && now - slot.ts < 3600000) {
    return slot.list
  }

  // 探测 opts 必须带区域：国际版走三路 UA + /v2 企业端点（在 client.fetchModels 内部分流），
  // 国内版走原两路。不带 realm 的话 headers 层会按国内版处理，国际版探测就会走错路径与 UA
  const list = await client.fetchModels(picked, { ...rtOpts(r, picked), realm: scope })
  if (!r.models.byRealm) r.models.byRealm = {}
  r.models.byRealm[scope] = {
    ts: now,
    list,
    efforts: buildEffortsMap(list, r),
    defaultEfforts: buildDefaultEffortsMap(list)
  }
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

// 当前缓存的档位表（供请求体管线降级使用）。
// 目录按区域分槽（byRealm.cn / byRealm.global），这里把所有槽位合并成一张表——
// 模型 id 跨区域不重叠（少数同名模型的档位也一致），合并不会互相覆盖；
// 只读单一槽位（历史 bug：读不存在的 byRealm.all）会让档位降级与默认档补全永远拿不到数据。
function effortsSnapshot() {
  const r = rt
  if (!r) return { efforts: {}, defaultEfforts: {} }
  const byRealm = (r.models && r.models.byRealm) || {}
  const efforts = {}
  const defaultEfforts = {}
  for (const slot of Object.values(byRealm)) {
    if (!slot || typeof slot !== 'object') continue
    if (slot.efforts && typeof slot.efforts === 'object') Object.assign(efforts, slot.efforts)
    if (slot.defaultEfforts && typeof slot.defaultEfforts === 'object') Object.assign(defaultEfforts, slot.defaultEfforts)
  }
  return { efforts, defaultEfforts }
}

// 失效全部区域的模型目录缓存（账号增删 / 重新登录后调用）
function invalidateModelCache(r) {
  if (!r) return
  r.models = { byRealm: {} }
}

// 在（区域优先的）模型目录里查找条目：先查本区域，再回落 all，
// 最后在各区域目录里兜底找——区域目录尚未拉取时不至于拿不到能力信息
function findModelEntry(r, model, realm) {
  if (!model) return null
  const byRealm = (r && r.models && r.models.byRealm) || {}
  const scope = realm === 'global' || realm === 'cn' ? realm : ''
  const order = []
  if (scope) order.push(scope)
  order.push('all')
  for (const key of order) {
    const slot = byRealm[key]
    if (!slot || !Array.isArray(slot.list)) continue
    const hit = slot.list.find(m => m && m.id === model)
    if (hit) return hit
  }
  for (const slot of Object.values(byRealm)) {
    if (!slot || !Array.isArray(slot.list)) continue
    const hit = slot.list.find(m => m && m.id === model)
    if (hit) return hit
  }
  return null
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
  // 会话/轮级键必须在提示词改写前取：改写会动 messages 内容，之后取会让键漂移
  const sessionKey = sessionMod.extractKey(baseBody)
  const turnKey = sessionMod.turnKey(baseBody)
  // 日志口径：使用记录（提问原文，≤1000 字）与任务键（一次提问一条日志，跨工具循环/重试）
  const logInput = sessionMod.extractInputText(baseBody)
  const logTaskKey = sessionMod.extractTaskKey(baseBody) || turnKey
  // 会话头族 meta：轮转循环外生成一次 → 换号/重试/降级全部同 ID，后台不再碎片化
  const chatMeta = buildChatMeta(baseBody, { sessionKey, turnKey, inbound: opts.inbound })
  // 区域隔离选号：opts.realm 由调用方（router，按当前 WorkBuddy 源）指定。
  // 未指定 = 不限区域（兼容旧调用方 / 单源场景）。
  // 必须在 hintContextOf / modelRateOf / modelCapsOf 之前确定：它们要按区域查目录
  const pickRealm = authMod.resolveRealm(opts.realm, '') === authMod.REALM_GLOBAL ? 'global' : opts.realm === 'cn' ? 'cn' : ''
  // gateway_hint 判定上下文（必须在提示词改写前取：改写会动 messages 内容）
  const hintCtx = hintContextOf(r, baseBody, model, pickRealm)
  // 用量统计的积分倍率：模型在对应区域目录里的 rate 字段（缺失为 ''）
  const modelRate = modelRateOf(r, model, pickRealm)
  // 提示词体系（降级期 append 退化为替换）
  const applied = promptMod.applyPromptMode(body, r.cfg.promptMode, r.cfg.promptText)
  body = applied.body
  let degradedApplied = applied.degradedApplied

  // 粘性号：循环外解析一次；不可用时解绑并回落普通轮换
  // 区域校验：会话绑定不区分区域（会话路由器的可用集是全池），若不校验，
  // 同一条会话先走国内源再走国际源时会把粘性号带过去 → 跨区派发（把请求发到错误上游）。
  // 与 pick 一样，区域不符一律视为不可用（解绑后重新分配）。
  let stickyUID = ''
  if (sessionKey) {
    const bound = r.session.resolveForModel(sessionKey, model, null)
    if (bound.ok && realmOfAuth(r, bound.uid) === pickRealm) stickyUID = bound.uid
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
  // 模型上下文窗口与输出上限（所有尝试共用；请求级错误分支与管线都要用）
  const caps = modelCapsOf(r, model, pickRealm)
  // 上游报告上下文过长 → 下次尝试改用激进裁剪比例（0 表示用默认比例）
  let compressRatio = 0
  // 上游只产出思考、未产出最终回答（finish_reason=length）的换号重试剩余次数
  let truncationRetries = C.TRUNCATION_RETRY.maxAttempts
  // 空响应重试要放行失败账号（否则换号会退化成对同一账号空转）
  let allowRetriedUID = false

  // 换号次数 = 常规轮转上限 + 截断/超长两种额外重试（各自独立计数）
  const maxAttempts = C.MAX_ROTATE + C.TRUNCATION_RETRY.maxAttempts + 1
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptStarted = Date.now()
    // 选号：粘性优先，其次池 pick
    // relaxTried（空回答重试）时允许回落复用上次账号——失败未被罚号，严格排除 tried
    // 可能直接无号可用；但只要能换到新号就换，故先按 tried 选，取不到才放开
    // realm：按区域隔离选号（国内/国际账号域名与能力不同，绝不跨区派发）
    const relaxTried = allowRetriedUID
    allowRetriedUID = false
    let auth = null
    if (stickyUID && !tried.has(stickyUID)) auth = r.pool.pickByUID(stickyUID, model, null, pickRealm)
    if (!auth && stickyUID) unbindSticky() // 粘性号在当前模型不可用（冷却/占满/模型受限/区域不符）→ 解绑
    if (!auth) auth = r.pool.pick({ tried, model, realm: pickRealm })
    if (!auth && relaxTried) auth = r.pool.pick({ model, realm: pickRealm })
    if (!auth) {
      // 区分「账号不可用」与「该模型在账号池中暂时不可用」——后者切换模型即可恢复
      const diag = r.pool.diagnoseNoCandidate(model, pickRealm)
      // 该区域所有账号都对该模型有确定性拒绝（11102 无此模型 / 11158 账号类型无权限）
      // 或模型级限流：这是「模型不可用」，不是「池子没号」。按 503 no_healthy_account
      // 报会让客户端以为是网关故障并重试整池；应为 400 model_unavailable（客户端
      // 该换模型，重试同一模型不会自愈）。区域隔离下不跨区取证：只看本区域。
      const modelBlocked = diag.modelCooled > 0 && diag.healthy === 0 && diag.cooling === 0
      const realmLabel = pickRealm === 'global' ? '国际版' : '国内版'
      // 6004 模型级限流是有重置墙钟的暂时状态：把等待信息透出，别让「无此模型/无权限」
      // 的含糊文案背锅（也不该因此在模型失活台账里记失败）
      const rateLimitOnly = modelBlocked && diag.modelRateLimited === diag.modelCooled
      const rateLimitHint = rateLimitOnly
        ? (() => {
            const resetAt = Math.min(...r.pool.list()
              .filter(s => s.realm === pickRealm)
              .flatMap(s => s.rateLimitedModels || [])
              .filter(item => item.model === model)
              .map(item => item.resetAt || item.until)
              .filter(t => t > Date.now()), Infinity)
            return Number.isFinite(resetAt)
              ? `模型级限流中，${new Date(resetAt).toLocaleTimeString('zh-CN', { hour12: false })} 重置`
              : '模型级限流中'
          })()
        : ''
      const err = new Error(
        modelBlocked
          ? `模型 ${model} 在${realmLabel}账号池中不可用（${rateLimitOnly ? rateLimitHint : '该后端无此模型、账号类型无权限或模型级限流'}），请切换其他模型`
          : `${realmLabel}账号池中${errMod.NO_HEALTHY_HINT}`
      )
      err.code = modelBlocked ? 'model_unavailable' : errMod.NO_HEALTHY_CODE
      // 仅限流：客户端该等重置而不是换模型；也不计入模型连续失败（见 router 判据）
      err.rateLimited = rateLimitOnly
      err.noHealthy = true
      // 状态码：模型不可用属客户端可纠正的请求问题（400）；池中无号才是网关侧 503
      err.status = modelBlocked ? 400 : 503
      err.input = logInput
      err.taskKey = logTaskKey
      // gateway_hint：模型级受限给「换模型」指向；账号级给本地调度提示
      err.gatewayHint = modelBlocked
        ? errMod.gatewayHint(errMod.ERR_KIND.MODEL_BLOCKED, '', hintCtx)
        : errMod.noHealthyAccountHint()
      r.pushLog('chat', `请求失败：${err.message}（账号诊断：总 ${diag.total} / 可用 ${diag.healthy} / 冷却 ${diag.cooling} / 模型受限 ${diag.modelCooled}（其中限流 ${diag.modelRateLimited}）/ 禁用 ${diag.disabled}）`, 'warn')
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
        // 改写档位：native 原生透传 / compat 全量修补（工具调用保真场景用 native）
        rewriteMode: r.cfg.rewriteMode,
        efforts: snap.efforts,
        defaultEfforts: snap.defaultEfforts,
        // 上下文压缩判据与输出上限兜底（都来自模型目录；缺失则各自跳过）
        contextWindow: caps.contextWindow,
        maxOutput: caps.maxOutput,
        // 上游报告过上下文过长时改用激进裁剪比例（见 catch 中的重试分支）
        compressRatio: compressRatio
      })
      prepared = payloadMod.injectPromptCacheKey(prepared, auth.uid, sessionKey || '')

      // 出站选项按「本次选中的账号」区域生成：国际版账号必须走 workbuddy.ai 域
      const upstreamRes = await client.chatStream(auth, prepared, {
        ...rtOpts(r, auth),
        clientIP: opts.clientIP,
        meta: chatMeta
      })

      // ===== 成功路径 =====
      r.pool.noteSuccess(auth.uid)
      // 成功即清该 (账号,模型) 的 11102 负缓存，
      // 避免一次误封或上游抖动把模型锁死到退避到期（6h 起、封顶 24h）
      r.pool.blockModelClear(auth.uid, model)
      if (sessionKey) r.session.bind(sessionKey, auth.uid)

      let cost = null
      let ttfbMs = 0
      let emptyAnswer = false
      let aggregatedOut = null
      if (isStream) {
        const out = await streamToClient(r, upstreamRes.stream, { ...opts, rewriteMode: r.cfg.rewriteMode }, releaseHeld, hintCtx, declaredTools)
        cost = out.cost
        ttfbMs = out.ttfbMs
        emptyAnswer = !!out.emptyAnswer
      } else {
        const text = await client.readAll(upstreamRes.stream, 64 * 1024 * 1024)
        releaseHeld()
        const aggregated = sseMod.aggregateSSE(text)
        // 标记修复（非流式）：把正文里的原生工具调用标记还原成 message.tool_calls
        // 各档位统一执行（native 只关字段重建，标记修复关闭会导致工具调用标记泄漏成正文）
        const mrepair = dsmlMod.repairAggregatedResponse(aggregated, declaredTools, true)
        logMarkupRepair(r, mrepair, model, declaredTools)
        cost = costOfUsage(aggregated && aggregated.usage)
        emptyAnswer = isEmptyAnswer(aggregated)
        aggregatedOut = aggregated
      }
      // 只有思考、没有最终回答（输出预算被思考吃满）：换号重试一次
      // 不调用 onDone 也不记用量为成功——调用方可能在 onDone 里已把响应交给客户端，
      // 此时重试会让客户端收到两份回答
      // opts.noEmptyRetry：调用方主动用极小输出预算（如 token 计数），空回答属预期，不重试
      // 重试时上调输出预算：上游把 reasoning 计入 max_tokens，小预算下思考烧光预算、
      // 正文为空；换号无法解决（每个账号行为一致），必须给足预算才可能拿到正文
      if (emptyAnswer && truncationRetries > 0 && !opts.noEmptyRetry) {
        truncationRetries--
        allowRetriedUID = true
        recordUsageAttempt(r, { auth, model, rate: modelRate, startedAt: attemptStarted, ok: false, delta: cost })
        const raised = raiseOutputBudget(body, caps.maxOutput)
        const changed = raised !== body
        const before = (() => {
          try {
            return JSON.parse(body).max_tokens
          } catch {
            return undefined
          }
        })()
        const after = (() => {
          try {
            return JSON.parse(raised).max_tokens
          } catch {
            return undefined
          }
        })()
        body = raised
        r.pushLog(
          'chat',
          `模型只产出思考未产出回答（finish_reason=length）→ ${changed ? `输出预算 ${before} → ${after} 后重试` : '预算无法再提高，换号重试'} model=${model} uid=${auth.uid.slice(0, 8)}`,
          'warn'
        )
        if (!(await sleepCancellable(backoffAfter(attempt), opts.isAborted))) break
        continue
      }
      allowRetriedUID = false
      if (!isStream && aggregatedOut) opts.onDone?.(aggregatedOut)
      // 成本台账：记录实测单价并内插扣减余额
      recordModelCost(r, auth.uid, model, cost)
      // 用量/积分统计：每次尝试（成功）都记一条
      recordUsageAttempt(r, { auth, model, rate: modelRate, startedAt: attemptStarted, ok: true, delta: cost })
      // 用量披露到日志文本：上游未回 usage 时三项显示 -（不伪造 0），积分四舍五入到 3 位抑制浮点尾数
      const usageText = cost && cost.totalTokens > 0
        ? ` 输入=${cost.pt} 输出=${cost.ct} 积分=${cost.hasCredit ? Math.round(cost.credit * 1000) / 1000 : '-'}`
        : ' 输入=- 输出=- 积分=-'
      r.pushLog('chat', `对话成功 model=${model} uid=${auth.uid.slice(0, 8)} ${isStream ? 'stream' : 'sync'} 耗时=${Date.now() - startedAt}ms${usageText}`)
      // credit：末帧 usage.credit 实测积分消耗；上游未提供时为 undefined（与"消耗为 0"区分），
      // 供请求日志「积分消耗」列
      return {
        ok: true,
        uid: auth.uid,
        ttfbMs,
        totalTokens: cost ? cost.totalTokens : null,
        credits: cost && cost.hasCredit ? cost.credit : undefined,
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

      // 上游报告上下文过长：改用激进裁剪比例重建请求体后重试（请求级错误，不罚号）。
      // 预防性压缩按 80% 估算触发，估不准或上游实测上限更低时走到这里；
      // 只在默认比例尚未切换、且窗口已知（可裁剪）时进行一次
      if (
        kind === errMod.ERR_KIND.PROMPT_TOO_LONG &&
        !compressRatio &&
        caps.contextWindow > 0
      ) {
        compressRatio = C.CONTEXT_COMPRESS.aggressiveRatio
        tried.delete(auth.uid)
        r.pushLog('chat', `上游报告上下文过长 → 按 ${Math.round(compressRatio * 100)}% 裁剪历史后重试（同请求）`)
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

      // 上游队列满载（6021 queue.full）：渠道级容量事件，换任何账号都撞同一堵墙。
      // 不轮转、不透传「账号错误」，直接把上游原文抛给客户端按退避重试。
      if (kind === errMod.ERR_KIND.UPSTREAM_BUSY) {
        err.input = logInput
        err.taskKey = logTaskKey
        // 503 = 临时不可用，客户端按退避重试是正确处置（不换号、不换模型也无需换）
        err.status = 503
        r.pushLog('chat', `上游推理队列满载（6021 queue.full）→ 终止轮转，透传原文等待客户端退避重试 uid=${auth.uid.slice(0, 8)}`, 'warn')
        throw err
      }

      // 请求级错误：不轮转，直接抛给调用方（补挂日志字段，供 router 失败日志完整记录）
      // TIMEOUT：首字节超时换号多半再撞同一个慢上游，直接终止轮转
      if (
        kind === errMod.ERR_KIND.TIMEOUT ||
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
      // 轮转退避：base·2^n 封顶 8s，±25% 抖动；
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
      // 14003「模型繁忙」：同号换模型立刻可用，且响应里没有恢复时刻。
      // 按账号级冷却会把整号冻 600s，实测 4 个号 8 次命中就让整池停 10 分钟。
      if (errMod.isModelBusy(String(err.body || '')) && model) {
        if (resetAt) pool.cooldownSoftForModel(uid, softBase, resetAt, model, '14003 model busy')
        else pool.cooldownModelBusy(uid, model, '14003 model busy')
        return
      }
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
      // 与保活路径口径一致：连续 3 次才禁用。单次抖动或上游偶发 12153 不应把
      // 可用账号打成终态（disable 只能人工 revive）。详见 keepalive 的同名处置
      if (pool.noteSessionDead(uid)) {
        pool.disable(uid, '12153 session dead (连续 3 次)')
      }
      return
    case errMod.ERR_KIND.NOT_FOUND:
      pool.cooldown(uid, pool.COOL_SOFT, C.POOL_DEFAULTS.notFoundCooldownMs, 'upstream 404')
      return
    case errMod.ERR_KIND.ACCOUNT_FAULT: {
      // 账号级授权/配额故障按业务码分野（与 classify 口径一致）：
      //   11140 + "request illegal" → 账号被上游限制（异常行为/风控）：硬禁用。
      //     解除只能由用户在 WorkBuddy 官方渠道申诉，重登无效。
      //   14017（trial not activated）→ register 未完成，补完 register 后可能自愈，
      //     保持软冷却（禁用会让用户补完 register 后仍无法用）。
      // 注意 11-128 的 msg 同为 "request illegal"，但那是通道校验失败，已在
      // classify 分流到 CHANNEL_REFUSED，走不到这里。
      if (errMod.isAccountRestricted(String(err.body || ''))) {
        pool.disable(uid, 'account restricted by upstream (11140 request illegal); appeal in WorkBuddy (submit feedback) to lift the restriction')
      } else {
        pool.cooldown(uid, pool.COOL_SOFT, softBase, 'account fault (14017)')
      }
      return
    }
    case errMod.ERR_KIND.CHANNEL_REFUSED:
      // 11-128 通道校验失败（上游判定请求可能不是官方客户端发出）：账号本身健康
      // ——官方客户端可正常使用同一账号。这不是账号级故障，**不罚账号**（无冷却/
      // 熔断/错误计数），由轮转继续尝试。与 CONTENT_BLOCKED 同待遇。
      return
    case errMod.ERR_KIND.UPSTREAM_BUSY:
      // 6021 queue.full 渠道级容量满载：零动作（不冷却/不熔断/不计错误/不连败）。
      // 轮转循环对该 kind 直接 fail-fast，见 chat()。
      return
    case errMod.ERR_KIND.SERVER:
      pool.noteError(uid)
      return
    case errMod.ERR_KIND.MODEL_BLOCKED:
      // 11102（该后端无此模型）/ 11158（账号类型无权限）：reason 前缀决定
      // pool.blockModelClear 能否在成功时清掉该条负缓存，不能混用
      if (model) pool.blockModelBackoff(uid, model, errMod.modelBlockReasonFor(String(err.body || '')))
      return
    case errMod.ERR_KIND.CONTENT_BLOCKED:
    case errMod.ERR_KIND.PROMPT_TOO_LONG:
    case errMod.ERR_KIND.IMAGE_INVALID:
    case errMod.ERR_KIND.BAD_PARAMS:
    case errMod.ERR_KIND.TIMEOUT:
      return // 请求级错误不罚号（首字节超时多为上游整体慢，与账号无关）
    default:
      pool.noteFailures(uid)
  }
}

// ±25% 均匀抖动
function jitterDuration(baseMs) {
  return Math.round(baseMs * (0.75 + Math.random() * 0.5))
}

// 轮转退避时长：base·2^n 封顶 cap，再施加 ±25% 抖动
function backoffAfter(n) {
  const base = C.ROTATE_BACKOFF.baseMs
  if (!(base > 0)) return 0
  let d = base
  for (let k = 0; k < n && d < C.ROTATE_BACKOFF.capMs; k++) d *= 2
  if (d > C.ROTATE_BACKOFF.capMs) d = C.ROTATE_BACKOFF.capMs
  return jitterDuration(d)
}

// 可取消等待：isAborted() 为真立即返回 false，等满返回 true
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

// 请求体是否携带 image_url part（判不出就不给「模型不支持图片」指向）
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

// gateway_hint 判定上下文（必须在提示词改写前取）
function hintContextOf(r, bodyText, model, realm) {
  const entry = findModelEntry(r, model, realm)
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

// SSE error 帧附加 gateway_hint：非 error 帧或无 hint 原样返回
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
function modelRateOf(r, model, realm) {
  const entry = findModelEntry(r, model, realm)
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

// 设备令牌文件读取：5 分钟缓存 + ≤1KB + 读失败优雅降级（不注入）
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
// opts.reasoningHidden：本通道是否对客户端隐藏思考内容（Anthropic 协议转换即如此），
//   决定「思考帧」是否算客户端可见内容，进而决定空回答能否安全重试
// 返回值：Promise<{ costInfo, ttfbMs, emptyAnswer }>
// emptyAnswer = 上游收尾为 length（输出预算耗尽）且全程没有正文与工具调用：
// 只有思考、没有最终回答，客户端此时会报「模型返回数据异常」——交由上层换号重试
function streamToClient(r, upstreamStream, opts, releaseHeld, hintCtx, declaredTools) {
  const reasoningHidden = !!opts.reasoningHidden
  // 改写档位：native 时响应流只关字段重建（白名单收敛 / name 收敛 / id 续传全不做，帧字段保真），
  // 标记修复仍开启——否则工具调用标记会以正文形式泄漏给客户端，工具调用必失败
  const native = opts.rewriteMode === 'native'
  return new Promise(resolve => {
    // 标记修复（见 dsml.js）：上游在没有 tools 的请求里会把工具调用吐成正文标记，
    // 这里在透传前还原成 delta.tool_calls；名单为空时启用弱判定（tools 声明在
    // 链路上丢失是实测最常见的泄漏成因，只做严格判定等于对主场景不设防）
    const repair = dsmlMod.createMarkupRepair(declaredTools, true)
    const rebuilder = sseMod.createFrameRebuilder({ repair, passthrough: native })
    const idleMs = C.TIMEOUT_DEFAULTS.idleTimeoutMs
    let validFrames = 0
    let doneSent = false
    let buffer = ''
    // UTF-8 增量解码器：分块边界可能落在多字节字符中间，逐块 toString() 会让
    // 响应正文出现 U+FFFD 乱码（且不报错，属静默损坏）
    const decoder = new StringDecoder('utf8')
    let finished = false
    let idleTimer = null
    let lastActivity = Date.now()
    let costInfo = null
    const startedAt = Date.now()
    let ttfbMs = 0
    // 回答形态统计（判定「只有思考、没有最终回答」）
    let sawContent = false // 是否产出过正文
    let sawToolCall = false // 是否产出过工具调用
    let lengthFinish = false // 收尾原因是否为 length
    let wroteVisible = false // 是否已向客户端写出过它可见的内容

    const finish = () => {
      if (finished) return
      finished = true
      if (idleTimer) clearInterval(idleTimer)
      releaseHeld()
      resolve({
        cost: costInfo,
        ttfbMs,
        // 「只有思考」且客户端尚未拿到任何可见内容时才可重试：已写过说明客户端
        // 持有一段半成品，重试会让它收到两份输出。思考内容是否算「可见」取决于
        // 客户端协议——Anthropic 通道的发射器丢弃 reasoning_content，故传
        // reasoningHidden 让本判定与客户端实际所见一致
        emptyAnswer: lengthFinish && !sawContent && !sawToolCall && !wroteVisible
      })
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
        // 各档位统一过帧重建器：native 档由其内部直通模式只修标记、不重建字段
        const result = rebuilder.push(payload)
        if (result.valid) {
          validFrames++
          if (!ttfbMs) ttfbMs = Date.now() - startedAt // 首个有效帧到达耗时（TTFB）
          // 回答形态统计：正文 / 工具调用 / 收尾原因（供上层判定「只有思考」）
          const shape = frameShapeOf(result.payloads)
          if (shape.content) sawContent = true
          if (shape.toolCall) sawToolCall = true
          if (shape.finish === 'length') lengthFinish = true
          // 客户端可见性：隐藏思考的通道下，只有思考帧落地时不算已写出内容
          if (!reasoningHidden && result.payloads.length) wroteVisible = true
          if (shape.content || shape.toolCall) wroteVisible = true
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
        // error 帧附加 gateway_hint，非 error 帧原样
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
      // native 直通档无字段重建，但仍有标记修复，收尾回吐照常执行（绝不吞字节）
      if (rebuilder) {
        const tail = rebuilder.finish()
        const tailShape = frameShapeOf(tail.payloads)
        if (tailShape.content) sawContent = true
        if (tailShape.toolCall) sawToolCall = true
        for (let i = 0; i < tail.payloads.length; i++) {
          writeFrame(tail.payloads[i])
          if (i < tail.validCount) validFrames++
        }
        logMarkupRepair(r, repair, opts.model, declaredTools)
      }
      if (validFrames === 0) {
        writeFrame('{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}')
      }
      writeDone()
      finish()
    }

    const handleEnd = () => {
      if (finished) return
      buffer += decoder.end() // 冲刷未完成的最后一个多字节字符
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
      buffer += decoder.write(chunk)
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

// 一批已重建帧的回答形态：是否含正文 / 工具调用 / 收尾原因
// 只认实际写出的内容，空串与空数组一律忽略（上游常发空 delta 的心跳帧）
function frameShapeOf(payloads) {
  const out = { content: false, toolCall: false, finish: '' }
  for (const p of payloads) {
    let obj
    try {
      obj = JSON.parse(p)
    } catch {
      continue
    }
    if (!obj || !Array.isArray(obj.choices)) continue
    for (const choice of obj.choices) {
      if (!choice || typeof choice !== 'object') continue
      if (!out.finish && typeof choice.finish_reason === 'string' && choice.finish_reason) {
        out.finish = choice.finish_reason
      }
      // 只统计最终回答：reasoning_content（思考）刻意不计，正是要区分的那一项
      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {}
      if (typeof delta.content === 'string' && delta.content) out.content = true
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) out.toolCall = true
    }
  }
  return out
}

// 聚合结果是否为「只有思考、没有最终回答」（与流式路径 frameShapeOf 判定一致）
// opts 额外支持 { sawReasoning }：流式路径已知产出过思考帧时由调用方告知，
// 非流式路径从 message.reasoning_content 推断；仅用于日志措辞与预算上调幅度
function isEmptyAnswer(aggregated) {
  const choice = (aggregated && Array.isArray(aggregated.choices) && aggregated.choices[0]) || {}
  const message = choice.message && typeof choice.message === 'object' ? choice.message : {}
  const hasContent = typeof message.content === 'string' && !!message.content
  const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  return choice.finish_reason === 'length' && !hasContent && !hasCalls
}

// 截断重试时的输出预算上调：取 max(当前值 × 2, RAISE_MIN_TOKENS)，并以模型输出上限封顶。
// 上游把 reasoning（思考）计入 max_tokens，思考型模型在小预算下会把预算全部烧在
// 思考上、正文为空且 finish_reason=length —— 单纯换号重试无法解决（每个账号行为一致），
// 只有给足预算才能拿到正文。
// 下限取 32768 的依据（实测 deepseek-v4.1-flash + 复杂任务）：
//   预算 4000  → 思考烧光、正文为空（失败）
//   预算 16384 → 多数可拿到正文，但个别请求仍失败
//   预算 32768 → 稳定拿到正文
// 思考所需规模与请求原本的预算无关（预算 4000 与 100 的请求，思考量相同），
// 故必须设绝对下限而非仅做倍数放大；32K 对上游 384K 的输出上限而言仍有充足空间。
// 返回新的请求体文本；无法解析时原样返回
const RAISE_MIN_TOKENS = 32768

function raiseOutputBudget(bodyText, maxOutput) {
  let obj
  try {
    obj = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return bodyText

  const curRaw = Number(obj.max_tokens)
  const cur = Number.isFinite(curRaw) && curRaw > 0 ? curRaw : 0
  const cap = Number(maxOutput) > 0 ? Number(maxOutput) : 0
  let next = Math.max(cur * 2, RAISE_MIN_TOKENS)
  if (cap > 0 && next > cap) next = cap
  if (next <= cur) return bodyText // 已达上限：无法再提高
  obj.max_tokens = next
  try {
    return JSON.stringify(obj)
  } catch {
    return bodyText
  }
}

// 模型上下文窗口与输出上限（供压缩判据与 max_tokens 兜底）
// 上游模型目录命中优先，未命中回落静态兜底链；两者都拿不到时为 0（各自跳过对应动作）
function modelCapsOf(r, model, realm) {
  const entry = findModelEntry(r, model, realm)
  return {
    contextWindow: catalogMod.contextWindowOf(model, entry && entry.maxContext, { dataDir: r.dataDir }),
    maxOutput: catalogMod.outputTokensOf(model, entry && entry.maxOutput, { dataDir: r.dataDir })
  }
}

// 标记修复命中统计（还原成功记 INFO、识别到但拒绝记 WARN——
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

// 会话头族 meta：
// conversationID 透传客户端原值；客户端没有时（Anthropic / Claude Code 流量）回退会话键，
// 否则 X-Conversation-ID 缺失、上游 prompt_cache_key 会退化为每账号一个常量——同账号下
// 所有客户端共享一个不断被逐出的前缀缓存槽；conversationRequestID
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
// realmOrAuth：调用方已知的账号区域，可传 'global'/'cn' 字符串，或直接传 auth 对象
//（传 auth 对象时按该账号自身区域判定，最不易出错）。
// 国际版**不下发 identity 的 CN 域名覆盖**——那三个覆盖位是给国内版换自定义端点用的，
// 若原样传给国际版会把请求发到国内域名。
function rtOpts(r, realmOrAuth) {
  const id = r.cfg.identity || {}
  const realm =
    realmOrAuth && typeof realmOrAuth === 'object'
      ? realmOrAuth.realm
      : realmOrAuth
  const global = realm === authMod.REALM_GLOBAL
  return {
    // 客户端指纹与版本覆盖（全字段透传，消费端留空回落官方默认；任务链路同样生效）
    identity: id,
    clientName: 'WorkBuddy',
    userAgent: '',
    // 使用端身份：出站 UA 与用量归属头（X-IDE-*）按此切换，热改后下一次请求即生效
    clientIdentity: r.cfg.clientIdentity,
    passthroughIP: false,
    // 区域：必须显式下发。OAuth 阶段还没有账号对象（chatBaseOf(null, opts)），
    // 消费端只能靠 opts.realm 判定该走 workbuddy.ai 还是 copilot.tencent.com
    realm: global ? 'global' : 'cn',
    // 域名三件套（identity.chatBase / billingBase / webBase；留空回落默认）
    // 国际版不下发这三个覆盖，交由消费端按区域取 workbuddy.ai
    chatBaseCN: global ? '' : id.chatBase || '',
    billingBaseCN: global ? '' : id.billingBase || '',
    webBaseCN: global ? '' : id.webBase || '',
    // 设备令牌文件兜底（5min 缓存 + ≤1KB + 读失败不注入）
    deviceTokenFileReader: () => readDeviceTokenCached(r.cfg.deviceTokenFile)
  }
}

// 账号所属区域（uid → 'cn' / 'global'；账号不存在或未知一律回落 'cn'）
// 供区域隔离判定复用（粘性号校验、按区域挑账号等）
function realmOfAuth(r, uid) {
  const a = r.pool.authByUID(uid)
  return a && a.realm === authMod.REALM_GLOBAL ? 'global' : 'cn'
}

// 国际版是否跳过签到：上游对国际版不提供签到能力（调了必然 4xx，
// 既消耗请求又污染错误计数），故整条跳过。
// 与参考实现（workbuddy2api-panel）的调度侧 IsGlobal 门控一致。
function skipCheckinFor(auth) {
  return !!(auth && auth.realm === authMod.REALM_GLOBAL)
}

// 国际版是否跳过成长体系（成长任务 / 旅行 / 连登 / 夜猫子）：
// 国际版无个人成长体系，这些端点一律拒绝
function skipGrowthFor(auth) {
  return !!(auth && auth.realm === authMod.REALM_GLOBAL)
}

// 是否跳过成长任务的**执行**（一键完成 / 入队执行 / 定时队列）。
//
// 比 skipGrowthFor 多一类：企业切换会话（token_source=enterprise_switch）。该形态
// 下成长任务列表 / 额度查询等**读端点照常**，但 /v2/report 行为事件返回 200 却被
// 上游静默丢弃——「读得见、记不上账」，任务进度永不跳动。跑执行队列只会白耗真实
// 对话配额且无任何报错，故执行侧统一门控。
// 读取（taskList / taskScan）、接任务（taskAccept）、领奖（taskClaim）与签到、
// 保活不受影响：这些不是行为上报路径，实测正常。
function skipGrowthExecFor(auth) {
  if (!auth) return false
  if (auth.realm === authMod.REALM_GLOBAL) return true
  return authMod.isEnterpriseSession(auth)
}

// 是否跳过**补领清扫**（accept/claim 两条幂等读改请求，不跑任何行为上报）。
//
// 不能复用 skipGrowthExecFor：那条门控针对的是「行为事件被 200 静默丢弃」，而
// 企业切换会话（token_source=enterprise_switch）的**读端点与领奖实测正常**（见
// skipGrowthExecFor 注释）。拿它当清扫门控会让这类账号的达标奖励永远领不到——
// 明明是能领的钱。
// 真企业版（enterpriseId 非空）另当别论：上游对非个人账号直接 403
// `growth system is only available for personal users`，每轮清扫都会刷一片错误，
// 故整体跳过（与参考实现 workbuddy2api-panel 的 IsGlobal/IsEnterprise 门控一致）。
function skipGrowthSweepFor(auth) {
  if (!auth) return false
  if (auth.realm === authMod.REALM_GLOBAL) return true
  return authMod.isEnterprise(auth)
}

// ===== 积分构成 / 模型清单 / 运行日志 =====

// 单账号积分批次明细（积分构成视图）
async function creditPackages(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  return client.resourcePackages(auth, { ...rtOpts(r, auth), expiringSoonMs: r.pool.getConfig().expiringSoonMs })
}

// 积分变动流水（新的在前；limit 默认 50、上限 1000，uid 可选精确过滤，offset 翻页）
// 账号昵称在读取时用池快照填充——账本只存 uid，上游改名后旧流水也跟着更新
// 返回 total（过滤后总条数）与 net（过滤后净变动），供前端分页与统计说明
function creditHistory(limitArg, uidArg, offsetArg) {
  const r = ensure()
  let limit = Math.trunc(Number(limitArg)) || 0
  if (limit <= 0) limit = 50
  if (limit > 1000) limit = 1000
  const uid = String(uidArg || '').trim()
  const offset = Math.max(0, Math.trunc(Number(offsetArg)) || 0)

  // 统一全量取回（账本上限默认 2000 条）：total 与翻页要求不受截断影响，
  // 过滤后再切页；2000 条浅拷贝的代价可忽略
  const all = r.creditHist.read(0)

  const nicks = new Map()
  for (const st of r.pool.list()) {
    if (st.nickname) nicks.set(st.uid, st.nickname)
  }

  const matched = []
  let net = 0
  for (const e of all) {
    if (uid && e.uid !== uid) continue
    net += Number(e.delta) || 0
    matched.push({ ...e, account: nicks.get(e.uid) || '' })
  }
  return { entries: matched.slice(offset, offset + limit), limit, offset, total: matched.length, net }
}

// 账号池统一维护的启用模型清单（供 Provider 同步；只含落盘字段，不附加派生信息）
// realm：按区域取清单（国内/国际的模型清单不同）。不传 = 返回国内版清单（兼容旧调用）
function getEnabledModels(realm) {
  const r = ensure()
  const scope = realm === 'global' ? 'global' : 'cn'
  const byRealm = r.enabledModelsByRealm || {}
  return byRealm[scope] || []
}

// 启用模型清单 + 后台拉取到的思考档位（供 Provider 弹窗渲染下拉选项与默认值）
// 档位来源：上游模型清单命中则用上游 supportedEfforts，未命中回落静态兜底表；
// 仅用于界面展示，不写入 Provider 配置，避免把派生字段落进 models.json
function getEnabledModelsWithEfforts(realm) {
  const r = ensure()
  const scope = realm === 'global' ? 'global' : 'cn'
  return getEnabledModels(scope).map(m => {
    const entry = findModelEntry(r, m.id, scope)
    const upstreamEfforts = entry && Array.isArray(entry.efforts) ? entry.efforts : []
    return {
      ...m,
      realm: scope,
      efforts: catalogMod.supportedEffortsOf(m.id, upstreamEfforts),
      defaultEffort: catalogMod.defaultEffortOf(m.id, upstreamEfforts, entry && entry.defaultEffort)
    }
  })
}

// 设置启用模型清单（内存态；持久化由调用方写入 server-config）
// realm：写入哪个区域的清单
function setEnabledModels(models, realm) {
  const r = ensure()
  const scope = realm === 'global' ? 'global' : 'cn'
  const list = Array.isArray(models) ? models : []
  const normalized = list
    .map(m => ({
      id: String(m?.id || '').trim(),
      displayName: String(m?.displayName || m?.name || '').trim(),
      maxContext: toIntOrNull(m?.maxContext),
      maxOutput: toIntOrNull(m?.maxOutput)
    }))
    .filter(m => m.id)
  if (!r.enabledModelsByRealm) r.enabledModelsByRealm = { cn: [], global: [] }
  r.enabledModelsByRealm[scope] = normalized
  return normalized
}

// 校验一批模型是否属于指定区域（**只用已缓存目录，不触发网络请求**）。
// 目的：阻止跨区域误写。国内版与国际版的模型清单完全不同
// （国内 deepseek/glm/kimi…，国际 default-model/fast-model/o4-mini…），
// 一旦把国际模型写进国内槽位，该源的全部模型引用都会失效——曾真实发生过。
// 判定从严：「明确只存在于另一区域目录」才拒绝；任一目录未缓存则放行（不阻塞正常保存）
function validateModelsForRegion(region, models) {
  const r = rt
  if (!r || !r.models) return { ok: true, rejected: [] }
  const scope = region === 'global' ? 'global' : 'cn'
  const other = scope === 'global' ? 'cn' : 'global'
  const idsOf = key => {
    const slot = (r.models.byRealm || {})[key]
    if (!slot || !Array.isArray(slot.list) || !slot.list.length) return null
    return new Set(slot.list.map(m => String(m && m.id || '').trim()).filter(Boolean))
  }
  const mine = idsOf(scope)
  const theirs = idsOf(other)
  if (!mine && !theirs) return { ok: true, rejected: [] } // 无缓存可依，放行
  const rejected = []
  for (const m of Array.isArray(models) ? models : []) {
    const id = String((m && m.id) || '').trim()
    if (!id) continue
    const inMine = mine ? mine.has(id) : true // 本区域目录未知时视为可能属于
    const inOther = theirs ? theirs.has(id) : false
    if (!inMine && inOther) rejected.push(id)
  }
  return { ok: rejected.length === 0, rejected }
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
// 国际版账号没有个人成长体系（上游对成长任务端点一律拒绝），
// 入口统一拒绝并给出明确原因，避免面板点了以后只看到一串上游 4xx。

// 国际版成长任务统一错误
function growthUnsupportedError(auth) {
  const err = new Error(
    `国际版账号（${String(auth?.nickname || auth?.uid || '').slice(0, 20)}）没有成长任务体系，该功能仅国内版可用`
  )
  err.code = 'growth_unsupported_realm'
  // 422：请求本身可理解但该账号当前形态不能执行（与 400 参数错误、500 网关故障区分）
  err.status = 422
  return err
}

// 企业切换会话的执行拒绝错误（附重登指引；422 与「参数错误」区分）
function enterpriseSessionError(auth) {
  const err = new Error(
    `账号（${String(auth?.nickname || auth?.uid || '').slice(0, 20)}）当前是企业切换会话（token_source=enterprise_switch）：` +
      '上游对行为事件上报返回 200 但静默丢弃，成长任务进度不会增长，执行只会白耗对话配额。' +
      '请在浏览器退出企业空间后重新登录授权该账号'
  )
  err.code = 'enterprise_session_relogin'
  err.status = 422
  return err
}

// 按账号形态取「不能执行」的错误（国际版 / 企业切换会话）
function growthExecBlockedError(auth) {
  if (auth && auth.realm === authMod.REALM_GLOBAL) return growthUnsupportedError(auth)
  return enterpriseSessionError(auth)
}

// 查询单账号任务列表（含进度与奖励）
async function taskList(uid) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  if (skipGrowthFor(auth)) throw growthUnsupportedError(auth)
  return tasksMod.fetchTasks(auth, rtOpts(r, auth))
}

// 一键完成：taskCode 为空跑全部可自动化任务，否则只跑指定任务
async function taskRun(uid, taskCode) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (!auth) throw new Error('账号不存在')
  if (skipGrowthExecFor(auth)) throw growthExecBlockedError(auth)
  return taskCode ? r.taskRunner.runOne(auth, taskCode, rtOpts(r, auth)) : r.taskRunner.runAll(auth, rtOpts(r, auth))
}

// 任务执行进度快照
function taskProgress() {
  return ensure().taskRunner.getProgress()
}

// ===== 成长任务补领清扫 =====

// 全账号一轮补领清扫：把「已达标未领」的任务奖励领掉（不做任何行为上报）。
//
// 现有三条链路都不负责这一环：执行队列只扫「有自动动作」的任务；队列路径要重跑
// 行为动作且一天只跑一次；一键完成对达标任务直接跳过。于是经真实对话点亮的任务
// 会长期卡在「达标未领」，积分再也上不去。
//
// 门控用 skipGrowthSweepFor（国际版 + 真企业版；企业切换会话照常清扫），
// 被门控账号零上游请求。
// 账号锁与一键完成/执行队列共享（tasks.tryLockAccount）：正在跑动作的账号整轮
// 跳过，不打断进行中的链路。并发 2 与任务中心扫描同口径。
async function sweepGrowthTasks(r) {
  const rt = r || ensure()
  const st = await tasksMod.sweepOnce({
    client,
    listAccounts: () => rt.pool.list(),
    authByUID: uid => rt.pool.authByUID(uid),
    skipAuth: skipGrowthSweepFor,
    optsFor: a => rtOpts(rt, a),
    concurrency: 2,
    log: rt.taskLog
  })
  const summary = tasksMod.sweepSummary(st)
  // 只在有实际动静时写日志：分钟级周期任务每次刷一条「无事发生」会淹没有效信息
  if (st.claimed > 0 || st.accepted > 0 || st.errors > 0) {
    rt.pushLog('task', `补领清扫：${summary}`, st.errors > 0 ? 'warn' : 'info')
  }
  return { ...st, summary }
}

// 全账号任务扫描（返回每账号未完成/可自动化任务）；国际版账号不参与扫描
async function taskScan() {
  const r = ensure()
  const auths = r.pool
    .list()
    .filter(st => !st.disabled)
    .map(st => r.pool.authByUID(st.uid))
    .filter(a => a && !skipGrowthFor(a))
  return tasksMod.scanTasks(auths, rtOpts(r))
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
  if (skipGrowthFor(auth)) throw growthUnsupportedError(auth)
  const list = (Array.isArray(codes) ? codes : []).filter(Boolean)
  if (list.length > 0) {
    await tasksMod.acceptTasks(auth, list, rtOpts(r, auth))
    return { ok: true, accepted: list.length }
  }
  const res = await tasksMod.acceptAllFor(auth, rtOpts(r, auth), r.taskLog)
  return { ok: true, accepted: res.accepted, failed: res.failed }
}

// 接受多个账号的全部未接受任务（uids 为空则全部非禁用账号；国际版跳过）
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
    if (skipGrowthFor(auth)) {
      accounts.push({ uid: st.uid, accepted: 0, skipped: 'international' })
      continue
    }
    try {
      const res = await tasksMod.acceptAllFor(auth, rtOpts(r, auth), r.taskLog)
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
  if (skipGrowthFor(auth)) throw growthUnsupportedError(auth)
  const code = String(taskCode || '').trim()
  if (!code) throw new Error('缺少 taskCode')
  const res = await tasksMod.claimTask(auth, code, rtOpts(r, auth))
  return { ok: true, already_claimed: !!res.alreadyClaimed, credit: res.credit, energy: res.energy }
}

// 全账号（或指定 uids）入队执行成长任务（国际版账号不入队）
// 区域门控统一在队列的 skipAuth 里做（见 taskQueue 构造），此处只需透传 uids，
// 保证「指定账号」与「全账号」两条路径行为一致
function queueOnce(uids, options) {
  const r = ensure()
  const filter = Array.isArray(uids) && uids.length > 0 ? uids.map(String) : null
  return r.taskQueue.runQueueOnce(filter, options || {})
}

// 指定账号入队执行指定任务码（国际版 / 企业切换会话拒绝）
function enqueue(uid, codes) {
  const r = ensure()
  const auth = r.pool.authByUID(uid)
  if (auth && skipGrowthExecFor(auth)) return { ok: false, enqueued: 0, error: growthExecBlockedError(auth).message }
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
  // 改写档位：仅接受 compat / native，其余值忽略（防脏配置写坏管线）
  if (patch.rewriteMode === 'compat' || patch.rewriteMode === 'native') r.cfg.rewriteMode = patch.rewriteMode
  // 使用端身份：仅接受 workbuddy / codebuddy，其余值忽略
  if (patch.clientIdentity === 'workbuddy' || patch.clientIdentity === 'codebuddy') {
    r.cfg.clientIdentity = patch.clientIdentity
  }
  // 客户端指纹与版本覆盖：白名单归一化后整体替换（未提交字段=清空回落官方默认）
  if (patch.identity && typeof patch.identity === 'object') {
    r.cfg.identity = identityMod.normalize(patch.identity)
  }
  if (typeof patch.deviceTokenFile === 'string') r.cfg.deviceTokenFile = patch.deviceTokenFile
  if (patch.poolConfig) r.pool.updateConfig(patch.poolConfig)
}

function errMsgOf(err) {
  return err?.message || String(err)
}

module.exports = {
  init,
  shutdown,
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
  // 供单测/调试：截断重试时的输出预算上调
  raiseOutputBudget,
  isEmptyAnswer,
  // 供单测/调试：区域门控
  skipCheckinFor,
  skipGrowthFor,
  skipGrowthExecFor,
  skipGrowthSweepFor,
  growthExecBlockedError,
  growthUnsupportedError,
  enterpriseSessionError,
  realmOfAuth,
  invalidateModelCache,
  findModelEntry,
  rtOpts,
  // 定时任务调度
  schedulerState: () => ensure().scheduler.getState(),
  schedulerRun: task => ensure().scheduler.runNow(task),
  schedulerUpdateConfig: patch => ensure().scheduler.updateConfig(patch),
  // 官方补偿（可观测化：先查后领）
  compensationStatusAll: () => ensure().scheduler.compensationStatusAll(),
  compensationClaimAll: async () => {
    const results = await ensure().scheduler.compensationClaimAll()
    return { ok: true, results, summary: ensure().scheduler.summarizeCompensation(results) }
  },
  compensationClaimFor: async uid => ensure().scheduler.compensationClaimFor(uid),
  summarizeCompensation: results => ensure().scheduler.summarizeCompensation(results),
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
  getEnabledModelsWithEfforts,
  setEnabledModels,
  validateModelsForRegion,
  getLogs,
  // 用量 / 积分消耗统计
  usageSnapshot: hours => ensure().usage.snapshot(hours),
  usageSave: () => ensure().usage.save(),
  // 仅供单测：清空单例，使后续 init 能以新的 dataDir 重新初始化。
  // 生产代码不得调用（会让运行中的调度器/池状态与实例脱钩）
  __resetForTest: () => {
    if (rt && rt.scheduler && typeof rt.scheduler.stop === 'function') rt.scheduler.stop()
    if (rt && rt.session && typeof rt.session.stopGC === 'function') rt.session.stopGC()
    rt = null
  }
}