// WorkBuddy 定时任务调度器：签到（含连登管家）/ 活跃上报 / 猫猫旅行 / token 保活 / 夜猫子 + 余额后台刷新
// 纯函数风格（无 class）；依赖全部由调用方注入（见文件末尾 createScheduler 的 deps 说明）

const crypto = require('crypto')
const C = require('./constants')
const headers = require('./headers')
const errMod = require('./errors')
const authMod = require('./auth')
const tasksMod = require('./tasks')

// ===== 本地常量（constants.js 未收录的路径与阈值）=====

const HEATMAP_PATH = '/activity/growth/heatmap' // 补签热力图（growth 域）
const MAKEUP_USE_PATH = '/activity/growth/makeup-cards/use' // 使用补签卡（growth 域）
const CLAIM_GIFT_PATH = '/billing/meter/claim-gift' // 新手礼包（billing 域）
const CLAIM_COMPENSATION_PATH = '/billing/meter/claim-compensation' // 活动补偿（billing 域）
const COMPENSATION_STATUS_PATH = '/billing/meter/compensation-status' // 补偿活动状态（billing 域）
const COMP_STATUS_CONCURRENCY = 3 // 补偿状态并发查询上限（与余额刷新同量级）

const ACCOUNT_DELAY_MS = 800 // 账号间限速（签到/旅行/活跃/夜猫子同口径）
const ADOPT_REPORT_GAP_MS = 1050 // 领养前置上报后的等待
const NIGHT_CHAT_GAP_MS = 4000 // 夜猫子每次对话间隔
const BALANCE_CONCURRENCY = 4 // 余额后台刷新并发上限
const TICK_MS = 60000 // 调度主循环 tick 周期
const WAKEUP_GRACE_MS = 5000 // 迟到唤醒宽限：睡眠跨过整点后，晚于计划时刻 ≤ 该值视为可补跑
const NIGHT_WINDOW_START = 23 // 夜猫子窗口起始小时（含）
const NIGHT_WINDOW_END = 8 // 夜猫子窗口结束小时（不含）

const BUDDY_TASK_INCOMPLETE_MARKER = 'first_buddy task not completed yet' // 领养门槛未达标关键词
const DEFAULT_REPORT_MODEL_ID = 'deepseek-v4-flash' // 活跃上报默认模型 id
const DEFAULT_REPORT_MODEL_NAME = 'DeepSeek V4 Flash' // 活跃上报默认模型名

// ===== 时间工具 =====

// 本地时区 YYYY-MM-DD（排程/补签判定用）
function localYMD(ms) {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 固定 UTC+8（Asia/Shanghai）YYYY-MM-DD（旅行「自然日」判定用；中国无夏令时）
function cstYMD(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

// 本地小时（0-23）
function localHour(ms) {
  return new Date(ms).getHours()
}

// 账号标签：昵称(uid 前 8 位)；无昵称只留 uid 前 8 位，空 uid 返回 "-"
function label(uid, nick) {
  const short = uid ? String(uid).slice(0, 8) : '-'
  const n = String(nick || '').trim()
  return n ? `${n}(${short})` : short
}

// 幂等令牌（前端 randomUUID 同款语义：8-4-4-4-12 十六进制）
function clientToken() {
  const b = crypto.randomBytes(16).toString('hex')
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`
}

// 错误消息提取
function errMsg(e) {
  return e && e.message ? e.message : String(e)
}

// 宽松解析 JSON 文本（失败返回 null）
function safeJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// 奖品载荷压缩为单行日志（>220 字符截断）
function compactJSON(raw) {
  let s
  try {
    s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    s = String(raw)
  }
  s = s || ''
  return s.length > 220 ? `${s.slice(0, 220)}…` : s
}

// 可等待睡眠
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 排程小时归一：空数组/null/非法值回落默认（禁用一律走 *_enabled=false）
function normalizeHours(v, def) {
  if (!Array.isArray(v)) return def.slice()
  const out = []
  for (const h of v) {
    if (Number.isInteger(h) && h >= 0 && h <= 23 && !out.includes(h)) out.push(h)
  }
  if (out.length === 0) return def.slice()
  return out.sort((a, b) => a - b)
}

// 排程小时列表 → 日志文本
function hoursText(hours) {
  return hours.join('、')
}

// 迟到唤醒判定：时点已过但未执行时，晚于计划时刻不超过宽限（5s）→ 'run'（补跑），
// 否则 'skip'（跳过并记日志，避免睡眠跨过整点后长时间后才补跑）
function catchUpDecision(plannedMs, nowMs, graceMs = WAKEUP_GRACE_MS) {
  const late = nowMs - plannedMs
  if (!(late > 0)) return 'run' // 未过点或毫秒级抖动：正常执行
  return late <= graceMs ? 'run' : 'skip'
}

// 某小时时点的计划墙钟毫秒（本地时区整点，minute/second=0）
function hourSlotMs(nowMs, hour) {
  const d = new Date(nowMs)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

// ===== 工厂函数 =====

// 创建调度器
// deps: { pool, client, auth, refreshTokenFor(auth), refreshBalanceFor(auth), log(msg), scheduleConfig }
function createScheduler(deps) {
  const pool = deps.pool
  const client = deps.client
  const log = typeof deps.log === 'function' ? deps.log : msg => console.log(msg)
  const DEF = C.SCHEDULE_DEFAULTS

  // ===== 排程配置（可热改）=====

  const sc0 = deps.scheduleConfig || {}
  const cfg = {
    checkinHours: normalizeHours(sc0.checkinHours, DEF.checkinHours),
    travelHours: normalizeHours(sc0.travelHours, DEF.travelHours),
    activityHours: normalizeHours(sc0.activityHours, DEF.activityHours),
    keepaliveHours: normalizeHours(sc0.keepaliveHours, DEF.keepaliveHours),
    blackcatHours: normalizeHours(sc0.blackcatHours, DEF.blackcatHours),
    growthHours: normalizeHours(sc0.growthHours, DEF.growthHours),
    checkinEnabled: sc0.checkinEnabled !== false,
    travelEnabled: sc0.travelEnabled !== false,
    activityEnabled: sc0.activityEnabled !== false,
    keepaliveEnabled: sc0.keepaliveEnabled !== false,
    blackcatEnabled: sc0.blackcatEnabled !== false,
    growthEnabled: sc0.growthEnabled !== false,
    balanceRefreshMinutes:
      Number.isFinite(Number(sc0.balanceRefreshMinutes)) && Number(sc0.balanceRefreshMinutes) > 0
        ? Number(sc0.balanceRefreshMinutes)
        : DEF.balanceRefreshMinutes,
    taskSweepEnabled: sc0.taskSweepEnabled !== false,
    taskSweepMinutes:
      Number.isFinite(Number(sc0.taskSweepMinutes)) && Number(sc0.taskSweepMinutes) > 0
        ? Number(sc0.taskSweepMinutes)
        : DEF.taskSweepMinutes
  }

  // 小时制任务表（tick 命中的判定依据）
  const HOUR_TASKS = [
    { name: 'checkin', hoursKey: 'checkinHours', enabledKey: 'checkinEnabled' },
    { name: 'travel', hoursKey: 'travelHours', enabledKey: 'travelEnabled' },
    { name: 'activity', hoursKey: 'activityHours', enabledKey: 'activityEnabled' },
    { name: 'keepalive', hoursKey: 'keepaliveHours', enabledKey: 'keepaliveEnabled' },
    { name: 'blackcat', hoursKey: 'blackcatHours', enabledKey: 'blackcatEnabled' },
    { name: 'growth', hoursKey: 'growthHours', enabledKey: 'growthEnabled' }
  ]

  // ===== 运行时状态 =====

  let timer = null // tick 定时器
  let stopped = false // 停机标志（长循环据此提前收尾）
  let lastBalanceAt = 0 // 上次余额刷新时刻
  let lastSweepAt = 0 // 上次任务补领清扫时刻
  const fired = new Set() // 小时+任务去重键（本地日:任务:小时）
  const running = {} // 各类任务是否在执行中
  const adoptTried = {} // uid → 已判定领养门槛未达的 UTC+8 自然日
  let lastTickAt = 0 // 上一次 tick 的墙钟毫秒（迟到唤醒补跑判定用）
  const state = {
    checkin: { at: 0, summary: '', running: false },
    travel: { at: 0, summary: '', running: false },
    activity: { at: 0, summary: '', running: false },
    keepalive: { at: 0, summary: '', running: false },
    blackcat: { at: 0, summary: '', running: false },
    growth: { at: 0, summary: '', running: false },
    balance: { at: 0, summary: '', running: false },
    taskSweep: { at: 0, summary: '', running: false }
  }

  // ===== 通用工具（闭包内，需 deps）=====

  // 客户端调用选项（与 runtime rtOpts 同口径：identity 全字段透传 + 域名映射）
  // 区域感知：realmOrAuth 传账号对象（或 'cn'/'global' 字符串）。
  // identity 的 chatBase/billingBase/webBase 语义是「给国内版换自定义端点」，
  // 而 headers 层的显式覆盖**优先于**区域判断 —— 若原样下发，国际版账号的
  // 签到 / 余额 / 活跃上报等定时任务会被拉回国内域名（实测：401 Authorization Required）。
  // 故国际版一律不下发这三个覆盖，交由 headers 按区域取 workbuddy.ai。
  function baseOpts(realmOrAuth) {
    const id = typeof deps.identityFor === 'function' ? deps.identityFor() || {} : {}
    const realm = realmOrAuth && typeof realmOrAuth === 'object' ? realmOrAuth.realm : realmOrAuth
    const global = realm === 'global'
    return {
      // 客户端指纹与版本覆盖（留空回落官方默认；实时读取，热改后任务类请求同样跟随）
      identity: id,
      clientName: 'WorkBuddy',
      userAgent: '',
      // 使用端身份：由 runtime 注入的 getter 实时读取（热改后任务类请求同样跟随）
      clientIdentity: typeof deps.clientIdentityFor === 'function' ? deps.clientIdentityFor() : '',
      passthroughIP: false,
      // 区域：必须显式下发，headers 据此选择 workbuddy.ai / copilot.tencent.com
      realm: global ? 'global' : 'cn',
      // 域名三件套（identity 覆盖；留空回落默认）。国际版不下发，避免被拉回国内域名
      chatBaseCN: global ? '' : id.chatBase || '',
      billingBaseCN: global ? '' : id.billingBase || '',
      webBaseCN: global ? '' : id.webBase || ''
    }
  }

  // 按 uid 或 auth 对象取凭证
  function resolveAuth(ref) {
    if (ref && typeof ref === 'object') return ref
    return pool.authByUID(ref)
  }

  // billing 域 POST（report / 礼包 / 补偿共用）
  async function billingPost(a, path, data) {
    const opts = baseOpts(a)
    const res = await client.send({
      method: 'POST',
      url: `${headers.billingBaseOf(a, opts)}${path}`,
      headers: headers.billingHeaders(a, opts),
      data
    })
    if (res.status >= 400) {
      throw new Error(`http ${res.status}: ${errMod.truncateMsg(res.text)}`)
    }
    const env = safeJSON(res.text)
    if (env && Number(env.code) !== 0) {
      throw new Error(`code=${env.code} msg=${env.msg || ''}`)
    }
    return env ? env.data : null
  }

  // 对话活跃上报（chat_request_send）：必须带 userId，否则上游 200 静默丢弃
  async function reportChatActivity(a, conversationId, requestId, modelId, modelName) {
    const cid = conversationId
    const rid = requestId || conversationId
    const mid = modelId || DEFAULT_REPORT_MODEL_ID
    const mname = modelName || mid
    const now = Date.now()
    const ev = {
      eventCode: 'chat_request_send',
      timestamp: now,
      reportDelay: 0,
      mode: 'craft',
      conversationId: cid,
      requestId: rid,
      inputLength: 12,
      requestModelId: mid,
      requestModelName: mname,
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      expertId: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      fileUri: '',
      presentAt: now,
      traceId: '',
      rootRequestId: rid,
      parentConversationId: cid,
      agentName: 'default',
      agentType: 'conversation',
      userId: a.uid
    }
    await billingPost(a, C.REPORT_PATH, [ev])
  }

  // ===== growth 域接口封装 =====

  // 连登天数（只读 oracle）
  async function growthStreakDays(a) {
    const data = await client.growthOK(a, 'GET', C.GROWTH_STREAK_PATH, null, baseOpts(a))
    return Number(data && data.streak && data.streak.days) || 0
  }

  // 连登完整状态
  async function growthStreakFull(a) {
    return client.growthOK(a, 'GET', C.GROWTH_STREAK_PATH, null, baseOpts(a))
  }

  // 兑换连登档位
  async function redeemTier(a, tier) {
    await client.growthOK(a, 'POST', C.GROWTH_REDEEM_PATH, { tier, client_token: clientToken() }, baseOpts(a))
  }

  // 抽奖次数
  async function lotteryChances(a) {
    const data = await client.growthOK(a, 'GET', C.LOTTERY_SUMMARY_PATH, null, baseOpts(a))
    return Number(data && data.chances) || 0
  }

  // 抽奖一次（返回原始奖品载荷）
  async function lotteryDraw(a) {
    return client.growthOK(a, 'POST', C.LOTTERY_DRAW_PATH, { client_token: clientToken() }, baseOpts(a))
  }

  // 新手礼包（billing 域）
  async function claimGift(a) {
    const data = await billingPost(a, CLAIM_GIFT_PATH, {})
    return Number(data && data.credit) || 0
  }

  // 活动补偿状态（billing 域）：先查后领所缺的那一半
  //
  // 上游口径（实测 2026-10-16，cn 域 CLI 侧与 Web 侧一致）：
  //   {"code":0,"msg":"OK","data":{"claimed":false,"active":true,"credit_num":500,
  //     "validity_period":1,"end_time":"2026-10-22 23:59:59"}}
  // active=false 是「当前无补偿活动」的正常 200，不是错误——只有传输失败 / 非 2xx /
  // 业务 code 非 0 才算 error。
  async function compensationStatus(a) {
    const data = await billingPost(a, COMPENSATION_STATUS_PATH, {})
    const d = data && typeof data === 'object' ? data : {}
    return {
      active: !!d.active,
      claimed: !!d.claimed,
      creditNum: Number(d.credit_num) || 0,
      validityPeriod: Number(d.validity_period) || 0,
      endTime: typeof d.end_time === 'string' ? d.end_time : ''
    }
  }

  // 补偿活动是否「可领且未领」：active && !claimed && credit > 0
  // 三种不领形态归为「无需领取」：无活动 / 已领完 / 活动在但额度为 0
  function compensationPending(st) {
    return !!(st && st.active && !st.claimed && st.creditNum > 0)
  }

  // 活动补偿实际领取（billing 域）
  async function claimCompensation(a) {
    const data = await billingPost(a, CLAIM_COMPENSATION_PATH, {})
    return Number(data && data.credit) || 0
  }

  // 单账号「查状态 → 待领才领」全部分支与日志（签到排程与面板按钮共用，避免漂移）
  // 返回 { uid, nickname, status, claimed, credit, skip, skipMsg, error }
  async function compensationClaimOne(a) {
    const r = { uid: a.uid, nickname: a.nickname || '', status: null, claimed: false, credit: 0, skip: '', skipMsg: '', error: '' }
    let st
    try {
      st = await compensationStatus(a)
    } catch (e) {
      // 查状态失败是真问题（传输/鉴权/上游），必须显式记录——旧盲领写法会把这类
      // 失败静默吞成「无事发生」
      r.error = errMsg(e)
      log(`compensation ${label(a.uid, a.nickname)}: 查状态失败: ${r.error}`)
      return r
    }
    r.status = st
    if (!compensationPending(st)) {
      if (!st.active) {
        r.skip = 'no_active'
        r.skipMsg = '当前无生效补偿'
      } else if (st.claimed) {
        r.skip = 'claimed'
        r.skipMsg = '本次活动已领取'
      } else {
        r.skip = 'zero_credit'
        r.skipMsg = '活动在但额度为 0'
      }
      return r
    }
    let credit
    try {
      credit = await claimCompensation(a)
    } catch (e) {
      r.error = errMsg(e)
      log(`compensation ${label(a.uid, a.nickname)}: 待领 ${st.creditNum}c 但领取失败: ${r.error}`)
      return r
    }
    r.claimed = true
    r.credit = credit
    log(`compensation ${label(a.uid, a.nickname)}: 🎊 补偿领取 +${credit}c（截止 ${st.endTime || '未知'}）`)
    return r
  }

  // 补偿目标的跳过原因（面板据此渲染，勿随意改字面量）
  // 注意没有「paused」：暂停选号不跳过补偿——补偿是纯领奖 RPC，与「让位防风控」
  // 的选号语义无关（旅行/成长任务亦然）。
  function compensationTargets() {
    const out = []
    for (const st of pool.list()) {
      const t = { uid: st.uid, nickname: st.nickname || '', a: null, skip: '', skipMsg: '', disabled: !!st.disabled }
      if (st.disabled) {
        t.skip = 'disabled'
        t.skipMsg = '账号已禁用'
        out.push(t)
        continue
      }
      const a = pool.authByUID(st.uid)
      if (!a || !a.accessToken) {
        t.skip = 'no_auth'
        t.skipMsg = '无凭证'
        out.push(t)
        continue
      }
      if (isGlobalAuth(a)) {
        t.skip = 'global'
        t.skipMsg = '国际版无国内补偿体系'
        out.push(t)
        continue
      }
      if (authMod.isEnterprise(a)) {
        t.skip = 'enterprise'
        t.skipMsg = '企业版无补偿体系'
        out.push(t)
        continue
      }
      t.a = a
      out.push(t)
    }
    return out
  }

  // 并发查全部账号补偿状态（只读，不领取）。输出与池顺序一致：
  // 先按 targets 预分配等长数组，每个 worker 只写自己那一个下标——避免
  // 「完成顺序 = 返回顺序」导致的行序漂移（面板逐行对齐依赖稳定行序）。
  async function compensationStatusAll() {
    const targets = compensationTargets()
    const rows = new Array(targets.length)
    const queue = []
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      if (!t.a) {
        rows[i] = { uid: t.uid, nickname: t.nickname, status: null, skip: t.skip, skipMsg: t.skipMsg, error: '' }
        continue
      }
      queue.push(i)
    }
    const workers = []
    const workerCount = Math.min(COMP_STATUS_CONCURRENCY, queue.length)
    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (queue.length) {
            if (stopped) return
            const i = queue.shift()
            const t = targets[i]
            const row = { uid: t.uid, nickname: t.nickname, status: null, skip: '', skipMsg: '', error: '' }
            try {
              row.status = await compensationStatus(t.a)
            } catch (e) {
              row.error = errMsg(e)
            }
            rows[i] = row
          }
        })()
      )
    }
    await Promise.all(workers)
    // 停机导致未跑到的下标回填成空行（保持长度与顺序，不出现 undefined）
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = { uid: targets[i].uid, nickname: targets[i].nickname, status: null, skip: '', skipMsg: '', error: '查询被中断' }
    }
    return rows
  }

  // 逐号「查状态 → 待领则领」（面板手动入口与签到排程共用的串行版本）。
  // 刻意串行：同一活动每号仅能领一次（重复领会拿到业务错误），串行让前一个失败
  // 不影响后一个的判定；账号量是个位数，无需并发。
  async function compensationClaimAll() {
    const targets = compensationTargets()
    const out = []
    for (const t of targets) {
      if (!t.a) {
        out.push({ uid: t.uid, nickname: t.nickname, status: null, claimed: false, credit: 0, skip: t.skip, skipMsg: t.skipMsg, error: '' })
        continue
      }
      if (stopped) break
      out.push(await compensationClaimOne(t.a))
    }
    return out
  }

  // 批量领取汇总。单独统计 errored 是为了让调用方能区分「没有可领」与「一个都没
  // 查成」：上游故障或 token 全过期时每个账号都走 error 分支，若只按 claimed 计数，
  // 面板会把「全部查询失败」渲染成「当前没有待领补偿」——正是要消灭的静默失败。
  // 调用方必须先看 errored 再看 claimed。
  function summarizeCompensation(results) {
    const s = { total: results.length, claimed: 0, skipped: 0, errored: 0, credit: 0 }
    for (const r of results) {
      if (r.error) s.errored++
      else if (r.claimed) {
        s.claimed++
        s.credit += Number(r.credit) || 0
      } else s.skipped++
    }
    return s
  }

  // 单号领取补偿（面板单号按钮）；账号不在池返回 error
  async function compensationClaimFor(uid) {
    const st = pool.list().find(x => String(x.uid) === String(uid))
    if (!st) return { error: 'account not found' }
    const skip = (reason, msg) => ({ uid: st.uid, nickname: st.nickname || '', status: null, claimed: false, credit: 0, skip: reason, skipMsg: msg, error: '' })
    if (st.disabled) return skip('disabled', '账号已禁用')
    const a = pool.authByUID(st.uid)
    if (!a || !a.accessToken) return skip('no_auth', '无凭证')
    if (isGlobalAuth(a)) return skip('global', '国际版无国内补偿体系')
    if (authMod.isEnterprise(a)) return skip('enterprise', '企业版无补偿体系')
    return compensationClaimOne(a)
  }

  // 昨日是否漏签（heatmap cell.score === 0）
  async function heatmapYesterdayMissed(a) {
    const yesterday = localYMD(Date.now() - 86400000)
    const data = await client.growthOK(a, 'GET', HEATMAP_PATH, null, baseOpts(a))
    const cells = Array.isArray(data && data.cells) ? data.cells : []
    for (const cell of cells) {
      const date = String((cell && cell.date) || '')
      if (date.length >= 10 && date.slice(0, 10) === yesterday) {
        return Number(cell.score) === 0
      }
    }
    return false
  }

  // 使用补签卡
  async function useMakeupCard(a, date) {
    await client.growthOK(a, 'POST', MAKEUP_USE_PATH, { target_date: date }, baseOpts(a))
  }

  // 猫档案（无猫返回 null）
  async function buddyInfo(a) {
    const data = await client.growthOK(a, 'GET', C.BUDDY_INFO_PATH, null, baseOpts(a))
    const b = data ? data.buddy : null
    if (b === null || typeof b === 'undefined') return null
    if (typeof b === 'string') {
      const t = b.trim()
      return t === '' || t === 'null' ? null : { raw: t }
    }
    if (typeof b === 'object') return Object.keys(b).length === 0 ? null : b
    return null
  }

  // 旅行状态
  async function travelStatus(a) {
    const data = await client.growthOK(a, 'GET', C.BUDDY_STATUS_PATH, null, baseOpts(a))
    const ts = data && typeof data === 'object' ? data : {}
    return {
      state: String(ts.state || ''),
      dailyLimitReached: !!ts.daily_limit_reached,
      recordId: Number(ts.record_id) || 0,
      rewardCredit: Number(ts.reward_credit) || 0
    }
  }

  // 派出
  async function travelDepart(a) {
    await client.growthOK(a, 'POST', C.BUDDY_DEPART_PATH, { location_id: C.TRAVEL_LOCATION_ID }, baseOpts(a))
  }

  // 领奖（返回 reward_credit）
  async function travelClaim(a, recordId) {
    const data = await client.growthOK(a, 'POST', C.BUDDY_CLAIM_PATH, { record_id: recordId }, baseOpts(a))
    return Number(data && data.reward_credit) || 0
  }

  // 同意协议
  async function buddyAgreement(a) {
    await client.growthOK(a, 'POST', C.BUDDY_AGREEMENT_PATH, { agree: true }, baseOpts(a))
  }

  // 领养第一只猫
  async function buddyFirst(a) {
    await client.growthOK(a, 'POST', C.BUDDY_FIRST_PATH, {}, baseOpts(a))
  }

  // 领养门槛未达标判定：HTTP 400 + first_buddy 关键词
  function isBuddyTaskIncomplete(e) {
    if (!e || e.status !== 400) return false
    const body = String(e.body || e.message || '').toLowerCase()
    return body.includes(BUDDY_TASK_INCOMPLETE_MARKER)
  }

  // 任务列表（black_cat 进度）
  async function listTasks(a) {
    const data = await client.growthOK(a, 'GET', C.GROWTH_TASKS_PATH, null, baseOpts(a))
    return Array.isArray(data && data.tasks) ? data.tasks : []
  }

  // black_cat 剩余差额（无需做返回 0）
  async function blackcatNeed(a) {
    const tasks = await listTasks(a)
    for (const t of tasks) {
      if (!t || t.task_code !== 'black_cat') continue
      let cur = Number(t.current) || 0
      let tgt = Number(t.target) || 0
      const p = t.progress
      if (p && typeof p === 'object') {
        const pc = Number(p.current) || 0
        const pt = Number(p.target) || 0
        if (pt > 0 || pc > 0) {
          cur = pc
          tgt = pt
        }
      }
      if (t.accept_status === 'claimed' || cur >= tgt) return 0
      return tgt - cur
    }
    return 0
  }

  // ===== 签到 =====

  // 单账号签到 + 余额查询写回（失败隔离）
  async function checkinOne(a) {
    const lb = label(a.uid, a.nickname)
    let ckOk = false
    let ckMessage = ''
    try {
      const ck = await client.dailyCheckin(a, baseOpts(a))
      ckOk = !!ck.ok
      ckMessage = ck.message || ''
      if (ck.ok) {
        pool.noteCheckinDone(a.uid)
        log(`checkin ${lb}: ${ck.already ? '今天已签到（幂等）' : '签到成功'}`)
      } else {
        log(`checkin ${lb}: ${ckMessage || '签到失败'}`)
      }
    } catch (e) {
      log(`checkin ${lb}: ${errMsg(e)}`)
    }
    // 签到后必接余额查询（即使签到失败/幂等也查）
    try {
      const res = await client.userResource(a, baseOpts(a))
      if (!res || res.ok === false) {
        log(`user-resource ${lb}: ${(res && res.message) || '余额查询失败'}`)
        return { ok: ckOk, message: ckMessage }
      }
      pool.reenableIfCredits(a.uid, res.credits, res.total)
      pool.setCreditsDetailed(a.uid, res.credits, res.total, res.expiring, res.earliestExpiry, res.earliestRemaining)
      return { ok: true, credits: res.credits, message: ckMessage }
    } catch (e) {
      log(`user-resource ${lb}: ${errMsg(e)}`)
      return { ok: ckOk, message: ckMessage }
    }
  }

  // 连登管家：补签 → 礼包/补偿 → 兑换已解锁档位 → 抽完所有次数
  async function streakBonusOne(a) {
    const lb = label(a.uid, a.nickname)
    await makeupYesterday(a)
    try {
      const credit = await claimGift(a)
      log(`streak-bonus ${lb}: 🎊 新手礼包 +${credit}c`)
    } catch {
      /* 无礼包/已领：静默 */
    }
    // 补偿改为「先查状态 → 待领才领」：旧写法盲领，让「没有补偿」「已经领过」
    // 「真的领取失败」三种情形在日志里完全同构，且补偿带截止日，排程停摆就会
    // 静默过期。无待领时不记日志（避免每日刷屏），真实失败一律显形（见 claimOne）
    await compensationClaimOne(a)

    let full
    try {
      full = await growthStreakFull(a)
    } catch (e) {
      log(`streak-bonus ${lb}: ${errMsg(e)}`)
      return
    }
    const rs = (full && full.redemption_status) || {}
    const statuses = { '7d': rs.tier_7d_status, '14d': rs.tier_14d_status, '28d': rs.tier_28d_status }
    const tiers = Array.isArray(rs.tiers) ? rs.tiers : []
    for (const tier of tiers) {
      const status = statuses[tier.tier]
      if (status === 'locked' || status === 'claimed') continue
      try {
        await redeemTier(a, tier.tier)
      } catch (e) {
        log(`streak-bonus ${lb}: redeem ${tier.tier}: ${errMsg(e)}`)
        continue
      }
      log(
        `streak-bonus ${a.uid}: ★ 兑换 ${tier.tier} 档（+${tier.credit || 0}c +${tier.energy || 0}e ` +
          `卡×${tier.cards || 0} 抽奖×${tier.chances || 0}）`
      )
    }

    let chances
    try {
      chances = await lotteryChances(a)
    } catch (e) {
      log(`streak-bonus ${lb}: lottery summary: ${errMsg(e)}`)
      return
    }
    for (let i = 0; i < chances; i++) {
      let raw
      try {
        raw = await lotteryDraw(a)
      } catch (e) {
        log(`streak-bonus ${lb}: draw: ${errMsg(e)}`)
        return
      }
      log(`streak-bonus ${lb}: 🎲 第${i + 1}抽 ${compactJSON(raw)}`)
    }
    if (chances > 0) log(`streak-bonus ${lb}: 抽奖完成 ${chances} 次`)
  }

  // 昨日漏签且有补签卡则补签（保连登）
  async function makeupYesterday(a) {
    const lb = label(a.uid, a.nickname)
    let missed
    try {
      missed = await heatmapYesterdayMissed(a)
    } catch {
      return
    }
    if (!missed) return
    let full
    try {
      full = await growthStreakFull(a)
    } catch {
      return
    }
    const balance = Number(full && full.makeup_cards && full.makeup_cards.balance) || 0
    if (balance <= 0) return
    const yesterday = localYMD(Date.now() - 86400000)
    try {
      await useMakeupCard(a, yesterday)
    } catch (e) {
      log(`streak-bonus ${lb}: 补签 ${yesterday} 失败: ${errMsg(e)}`)
      return
    }
    log(`streak-bonus ${lb}: ★ 已用补签卡补签 ${yesterday}（保连登）`)
  }

  // 全量签到（账号间 800ms 限速；末尾追加连登管家）
  // ===== 区域门控 =====
  // 国际版（global）账号没有个人成长体系：上游对签到 / 成长任务 / 旅行 / 连登 /
  // 夜猫子这些端点一律拒绝（4xx）。若照常派发，每天会对必然失败的端点空发请求，
  // 既浪费往返又污染账号错误计数（可能误触熔断）。故这些任务整体跳过国际版。
  // **活跃上报与 token 保活两域都支持**，不跳过。
  const isGlobalAuth = a => !!(a && a.realm === 'global')

  // 企业切换会话（token_source=enterprise_switch，或真企业版）：行为事件上报会被
  // 上游静默丢弃（返回 200 但不记账），跑这些任务纯属白耗对话配额。判定见 auth.js。
  const isEnterpriseSessionAuth = a => authMod.isEnterpriseSession(a)
  const ENTERPRISE_SESSION_HINT = '企业切换会话（token_source=enterprise_switch）：上游行为上报静默丢弃，请在浏览器退出企业空间后重新登录授权'

  // 成长任务「执行侧」门控（与 runtime.skipGrowthExecFor 同语义）：
  // 国际版无成长体系；企业切换会话下行为上报被静默丢弃。
  const skipGrowthExecFor = a => isGlobalAuth(a) || isEnterpriseSessionAuth(a)

  // 补领清扫门控（与 runtime.skipGrowthSweepFor 同语义）：清扫只做 accept/claim
  // 两条幂等读改请求，不跑行为上报——企业切换会话的读/领奖实测正常，故**不跳过**，
  // 否则这类账号的达标奖励永远领不到。真企业版上游直接 403
  // （growth system is only available for personal users），整体跳过。
  const skipGrowthSweepFor = a => isGlobalAuth(a) || authMod.isEnterprise(a)

  async function runCheckinAll() {
    let first = true
    let count = 0
    let ok = 0
    let skippedGlobal = 0
    for (const st of pool.list()) {
      if (stopped) break
      if (st.disabled) continue
      const a = pool.authByUID(st.uid)
      if (!a || !a.refreshToken) continue
      if (isGlobalAuth(a)) {
        skippedGlobal++
        continue // 国际版无签到能力
      }
      if (!first) {
        await sleep(ACCOUNT_DELAY_MS)
        if (stopped) break
      }
      first = false
      const r = await checkinOne(a)
      count++
      if (r.ok) ok++
    }
    await runStreakBonusAll()
    const tail = skippedGlobal > 0 ? `（跳过 ${skippedGlobal} 个国际版账号）` : ''
    return `签到 ${ok}/${count}${tail}，连登管家已跑`
  }

  // 全量连登管家（国际版跳过；企业切换会话跳过——行为上报静默丢弃）
  async function runStreakBonusAll() {
    for (const st of pool.list()) {
      if (stopped) break
      if (st.disabled) continue
      const a = pool.authByUID(st.uid)
      if (!a || !a.accessToken) continue
      if (isGlobalAuth(a)) continue // 国际版无连登体系
      if (isEnterpriseSessionAuth(a)) {
        log(`streak ${label(a.uid, a.nickname)}: skip — ${ENTERPRISE_SESSION_HINT}`)
        continue
      }
      await streakBonusOne(a)
    }
  }

  // ===== 活跃上报 =====

  // 上报后的 streak 自检回读（只读 oracle）
  async function checkActivityStreak(a) {
    const lb = label(a.uid, a.nickname)
    let days
    try {
      days = await growthStreakDays(a)
    } catch (e) {
      log(`activity ${lb}: streak check failed (report OK): ${errMsg(e)}`)
      return true
    }
    if (days === 0) {
      log(`activity ${lb}: report OK but streak.days=0 (silent drop?)`)
      return true
    }
    log(`activity ${lb}: streak days=${days}`)
    return false
  }

  // 单账号活跃上报 + 自检
  async function activityOne(a) {
    const cid = `wb2api-${Date.now()}`
    try {
      await reportChatActivity(a, cid, '', DEFAULT_REPORT_MODEL_ID, DEFAULT_REPORT_MODEL_NAME)
    } catch (e) {
      log(`activity ${label(a.uid, a.nickname)}: ${errMsg(e)}`)
      return { ok: false, message: errMsg(e) }
    }
    await checkActivityStreak(a)
    return { ok: true, message: '上报成功' }
  }

  // 全量活跃上报（企业切换会话跳过——行为上报静默丢弃）
  async function runActivityAll() {
    let first = true
    let count = 0
    let ok = 0
    let skippedEnt = 0
    for (const st of pool.list()) {
      if (stopped) break
      if (st.disabled) continue
      const a = pool.authByUID(st.uid)
      if (!a || !a.accessToken) continue
      if (isEnterpriseSessionAuth(a)) {
        skippedEnt++
        log(`activity ${label(a.uid, a.nickname)}: skip — ${ENTERPRISE_SESSION_HINT}`)
        continue
      }
      if (!first) {
        await sleep(ACCOUNT_DELAY_MS)
        if (stopped) break
      }
      first = false
      const r = await activityOne(a)
      count++
      if (r.ok) ok++
    }
    const tail = skippedEnt > 0 ? `（跳过 ${skippedEnt} 个企业切换会话账号）` : ''
    return `上报 ${ok}/${count}${tail}`
  }

  // ===== 猫猫旅行 =====

  // 单账号单趟状态机（不轮询、每趟最多一个动作）
  async function travelOne(a) {
    const lb = label(a.uid, a.nickname)
    let buddy
    try {
      buddy = await buddyInfo(a)
    } catch (e) {
      log(`travel ${lb}: buddy-info: ${errMsg(e)}`)
      return
    }
    if (!buddy) {
      await travelAdopt(a)
      return
    }
    let ts
    try {
      ts = await travelStatus(a)
    } catch (e) {
      log(`travel ${lb}: status: ${errMsg(e)}`)
      return
    }
    if (ts.state === 'arrived') {
      await travelClaimStep(a, ts)
    } else if (ts.state === 'idle') {
      await travelDepartStep(a, ts)
    } else if (ts.state === 'traveling') {
      log(`travel ${lb}: skip (traveling record=${ts.recordId})`)
    } else {
      log(`travel ${lb}: skip (unknown state "${ts.state}")`)
    }
  }

  // 空闲派出（每日 1 次由上游 daily_limit_reached 判定）
  async function travelDepartStep(a, ts) {
    const lb = label(a.uid, a.nickname)
    if (ts.dailyLimitReached) {
      log(`travel ${lb}: skip (daily limit reached)`)
      return
    }
    try {
      await travelDepart(a)
    } catch (e) {
      log(`travel ${lb}: depart: ${errMsg(e)}`)
      return
    }
    log(`travel ${lb}: depart ok location=${C.TRAVEL_LOCATION_ID}`)
  }

  // 到站领奖（必须带 record_id）
  async function travelClaimStep(a, ts) {
    const lb = label(a.uid, a.nickname)
    if (!ts.recordId) {
      log(`travel ${lb}: claim skipped (arrived but no record_id)`)
      return
    }
    let reward
    try {
      reward = await travelClaim(a, ts.recordId)
    } catch (e) {
      log(`travel ${lb}: claim record=${ts.recordId}: ${errMsg(e)}`)
      return
    }
    log(`travel ${lb}: claim ok record=${ts.recordId} reward=${reward}`)
  }

  // 无猫领养：report → agreement → buddy/first
  async function travelAdopt(a) {
    const uid = a.uid
    const lb = label(uid, a.nickname)
    if (adoptTried[uid] === cstYMD(Date.now())) return // 当日已判定门槛未达
    try {
      await reportChatActivity(a, `wb2api-adopt-${Date.now()}`, '', DEFAULT_REPORT_MODEL_ID, DEFAULT_REPORT_MODEL_NAME)
      await sleep(ADOPT_REPORT_GAP_MS)
    } catch (e) {
      log(`travel ${lb}: adopt preflight report: ${errMsg(e)}`)
    }
    try {
      await buddyAgreement(a)
    } catch (e) {
      log(`travel ${lb}: agreement: ${errMsg(e)}`)
      return
    }
    try {
      await buddyFirst(a)
      log(`travel ${lb}: adopt ok (+300 credits)`)
    } catch (e) {
      if (isBuddyTaskIncomplete(e)) {
        adoptTried[uid] = cstYMD(Date.now())
        log(`travel ${lb}: adopt skipped (conversation threshold not reached, retry tomorrow)`)
      } else {
        log(`travel ${lb}: adopt: ${errMsg(e)}`)
      }
    }
  }

  // 全量旅行巡检（国际版跳过：无成长体系；企业切换会话跳过：行为上报静默丢弃）
  async function runTravelAll() {
    let first = true
    let count = 0
    let skippedGlobal = 0
    let skippedEnt = 0
    for (const st of pool.list()) {
      if (stopped) break
      if (st.disabled) continue
      const a = pool.authByUID(st.uid)
      if (!a || !a.refreshToken) continue
      if (isGlobalAuth(a)) {
        skippedGlobal++
        continue
      }
      if (isEnterpriseSessionAuth(a)) {
        skippedEnt++
        log(`travel ${label(a.uid, a.nickname)}: skip — ${ENTERPRISE_SESSION_HINT}`)
        continue
      }
      if (!first) {
        await sleep(ACCOUNT_DELAY_MS)
        if (stopped) break
      }
      first = false
      await travelOne(a)
      count++
    }
    const parts = []
    if (skippedGlobal > 0) parts.push(`跳过 ${skippedGlobal} 个国际版账号`)
    if (skippedEnt > 0) parts.push(`跳过 ${skippedEnt} 个企业切换会话账号`)
    const tail = parts.length ? `（${parts.join('，')}）` : ''
    return `巡检 ${count} 个账号${tail}`
  }

  // ===== token 保活 =====

  // 全量保活
  async function runKeepaliveAll() {
    let count = 0
    for (const st of pool.list()) {
      if (stopped) break
      if (st.disabled) continue
      const a = pool.authByUID(st.uid)
      if (!a || !a.refreshToken) continue
      const res = await deps.refreshTokenFor(a)
      if (!res || res.ok === false) {
        // runtime 已处理 session_dead 连续计数与禁用，这里只记日志
        log(`keepalive ${label(st.uid, st.nickname)}: ${(res && res.error) || '刷新失败'}`)
      }
      count++
    }
    return `保活 ${count} 个账号`
  }

  // ===== 夜猫子 =====

  // 当前是否处于 23:00–08:00 计数窗口
  function inNightWindow(ms) {
    const h = localHour(ms)
    return h >= NIGHT_WINDOW_START || h < NIGHT_WINDOW_END
  }

  // 发 need 次 glm-5.2 短对话并各上报一条事件链；返回 { ok, error }
  async function runNightChats(a, need) {
    let ok = 0
    for (let i = 0; i < need; i++) {
      if (stopped) break
      let res
      try {
        res = await client.chatStream(
          a,
          { model: 'glm-5.2', messages: [{ role: 'user', content: '1+1等于几？直接回答。' }], stream: true },
          baseOpts(a)
        )
      } catch (e) {
        return { ok, error: `第 ${i + 1} 次对话失败: ${errMsg(e)}` }
      }
      try {
        await client.readAll(res.stream, 1 << 20)
      } catch {
        /* 读取失败不阻断 */
      }
      try {
        res.stream.destroy()
      } catch {
        /* 流已关闭 */
      }
      try {
        await reportChatActivity(a, `wb2api-night-${Date.now()}-${i}`, '', 'glm-5.2', 'GLM-5.2')
      } catch (e) {
        return { ok, error: `第 ${i + 1} 次上报失败: ${errMsg(e)}` }
      }
      ok++
      await sleep(NIGHT_CHAT_GAP_MS)
    }
    return { ok, error: null }
  }

  // 全量夜猫子补足
  async function runBlackcatNow() {
    if (!inNightWindow(Date.now())) {
      log('blackcat: 当前不在 23:00–08:00 计数窗口，跳过')
      return '窗口外跳过'
    }
    for (const st of pool.list()) {
      if (stopped) break
      if (st.disabled) continue
      const a = pool.authByUID(st.uid)
      if (!a || !a.accessToken) continue
      if (isGlobalAuth(a)) continue // 国际版无夜猫子任务
      if (isEnterpriseSessionAuth(a)) {
        log(`blackcat ${label(st.uid, st.nickname)}: skip — ${ENTERPRISE_SESSION_HINT}`)
        continue
      }
      const lb = label(st.uid, st.nickname)
      let need
      try {
        need = await blackcatNeed(a)
      } catch (e) {
        log(`blackcat ${lb}: ${errMsg(e)}`)
        continue
      }
      if (need <= 0) continue
      const r = await runNightChats(a, need)
      if (r.error) {
        log(`blackcat ${lb}: ${r.ok}/${need} 完成，中断: ${r.error}`)
        continue
      }
      log(`blackcat ${lb}: 完成 ${r.ok} 次夜间对话`)
      await sleep(ACCOUNT_DELAY_MS)
    }
    return '夜猫子补足完成'
  }

  // ===== 余额后台刷新 =====

  // 并发全量余额刷新（上限 4，失败隔离）
  async function runBalanceRefresh() {
    const queue = pool.list().filter(st => !st.disabled)
    let ok = 0
    let fail = 0
    const workerCount = Math.min(BALANCE_CONCURRENCY, queue.length)
    const workers = []
    for (let i = 0; i < workerCount; i++) {
      workers.push(
        (async () => {
          while (queue.length) {
            if (stopped) return
            const st = queue.shift()
            const a = pool.authByUID(st.uid)
            if (!a) continue
            try {
              const res = await deps.refreshBalanceFor(a)
              if (!res || res.ok === false) {
                fail++
                log(`balance ${label(st.uid, st.nickname)}: ${(res && res.message) || '刷新失败'}`)
              } else {
                ok++
              }
            } catch (e) {
              fail++
              log(`balance ${label(st.uid, st.nickname)}: ${errMsg(e)}`)
            }
          }
        })()
      )
    }
    await Promise.all(workers)
    return `余额刷新 成功 ${ok} / 失败 ${fail}`
  }

  // ===== 任务补领清扫 =====

  // 全账号一轮补领清扫（分钟级、幂等，只 accept/claim，不跑行为链路）。
  // 与成长队列分工：队列负责「点亮任务」（真实对话/事件上报，成本高，小时制），
  // 清扫负责「把已达标的奖领掉」（两条幂等读改请求，分钟级负担可忽略）。
  // 门控：国际版无成长体系、企业切换会话上报被丢弃 —— 二者零上游请求。
  async function runTaskSweep() {
    const hook = typeof deps.taskSweepHook === 'function' ? deps.taskSweepHook : null
    if (hook) {
      // 外部接管（runtime 注入，与账号池/区域 opts 同源）
      try {
        const st = await hook()
        return (st && st.summary) || '补领清扫完成'
      } catch (e) {
        return `补领清扫失败: ${errMsg(e)}`
      }
    }
    // 兜底：调度器自带的直接实现（未注入 hook 时仍可用，测试与独立调用走这条）
    try {
      const st = await tasksMod.sweepOnce({
        client,
        listAccounts: () => pool.list(),
        authByUID: uid => pool.authByUID(uid),
        skipAuth: skipGrowthSweepFor,
        optsFor: a => baseOpts(a),
        concurrency: 2,
        log
      })
      return tasksMod.sweepSummary(st)
    } catch (e) {
      return `补领清扫失败: ${errMsg(e)}`
    }
  }

  // ===== 成长任务队列（到点触发 hook）=====

  // 到点触发成长任务队列：hook 由 runtime 挂载（与「全账号入队执行」同管线），
  // 未挂载时安全跳过；已在执行/无待办由队列自身判拒
  async function runGrowthQueue() {
    const hook = typeof deps.growthHook === 'function' ? deps.growthHook : null
    if (!hook) return '未挂载成长任务回调，跳过'
    try {
      await hook()
    } catch (e) {
      return `触发失败: ${errMsg(e)}`
    }
    return '已触发成长任务队列'
  }

  // ===== 任务执行入口 =====

  const TASK_FNS = {
    checkin: runCheckinAll,
    travel: runTravelAll,
    activity: runActivityAll,
    keepalive: runKeepaliveAll,
    blackcat: runBlackcatNow,
    growth: runGrowthQueue,
    balance: runBalanceRefresh,
    taskSweep: runTaskSweep
  }

  // 执行单类任务（带重入保护，异常不影响调度器）
  async function runTask(name) {
    if (running[name]) return '(已在执行)'
    running[name] = true
    state[name].running = true
    try {
      const summary = await TASK_FNS[name]()
      state[name].at = Date.now()
      state[name].summary = summary || '完成'
      log(`scheduler: ${name} 完成 — ${state[name].summary}`)
      return state[name].summary
    } catch (e) {
      state[name].at = Date.now()
      state[name].summary = `失败: ${errMsg(e)}`
      log(`scheduler: ${name} 异常 — ${state[name].summary}`)
      return state[name].summary
    } finally {
      running[name] = false
      state[name].running = false
    }
  }

  // 每分钟 tick：本地时区整点命中 + 当日去重 + 迟到唤醒补跑
  function tick() {
    if (stopped) return
    const now = Date.now()
    const hour = localHour(now)
    const today = localYMD(now)

    // 清理非今日的触发去重键
    for (const k of fired) {
      if (!k.startsWith(`${today}:`)) fired.delete(k)
    }

    for (const t of HOUR_TASKS) {
      if (!cfg[t.enabledKey]) continue
      // 常规：当前小时命中该任务时点（启动当小时内、或准点/迟到的唤醒都属此）→ 执行一次。
      // 保持既有行为：到点命中即跑，不因启动晚于整点而跳过。
      if (cfg[t.hoursKey].includes(hour)) {
        const key = `${today}:${t.name}:${hour}`
        if (!fired.has(key)) {
          fired.add(key)
          void runTask(t.name)
        }
        continue
      }
      // 迟到唤醒补跑：上次 tick 之后跨过了该任务的某个较早时点
      // （睡眠跨过整点，唤醒时已非该小时）。晚于计划时刻 ≤ 宽限（5s）→ 补跑；
      // 超出 → 跳过并记日志（避免睡醒后很久才补跑，时机已失）。
      if (lastTickAt > 0) {
        for (const h of cfg[t.hoursKey]) {
          const planned = hourSlotMs(now, h)
          if (planned <= lastTickAt || planned > now) continue // 不在本 tick 区间
          const key = `${localYMD(planned)}:${t.name}:${h}`
          if (fired.has(key)) continue
          fired.add(key)
          if (catchUpDecision(planned, now) === 'run') {
            log(`scheduler: ${t.name} 补跑（时点 ${h}:00 迟到在宽限内）`)
            void runTask(t.name)
          } else {
            const lateSec = Math.round((now - planned) / 1000)
            state[t.name].at = now
            state[t.name].summary = `跳过（时点 ${h}:00 迟到 ${lateSec}s 超出唤醒宽限）`
            log(`scheduler: ${t.name} 跳过（时点 ${h}:00 迟到 ${lateSec}s 超出唤醒宽限）`)
          }
        }
      }
    }
    lastTickAt = now

    // 余额后台刷新（分钟级，独立于整点排程）
    if (cfg.balanceRefreshMinutes > 0 && now - lastBalanceAt >= cfg.balanceRefreshMinutes * 60000) {
      lastBalanceAt = now
      void runTask('balance')
    }

    // 任务补领清扫（分钟级、幂等）：把「已达标未领」的成长任务奖励领掉。
    // 只做 accept/claim 两条读改请求，不跑任何行为链路，故分钟级成本可忽略。
    if (cfg.taskSweepEnabled && cfg.taskSweepMinutes > 0 && now - lastSweepAt >= cfg.taskSweepMinutes * 60000) {
      lastSweepAt = now
      void runTask('taskSweep')
    }
  }

  // ===== 对外接口 =====

  // 启动调度循环
  function start() {
    if (timer) return
    stopped = false
    lastBalanceAt = Date.now()
    // 清扫不在启动瞬间跑：启动那次留给「进页面看余额」这类手动路径，
    // 定时清扫从第一个完整间隔后才开始，避免与启动时的余额刷新叠加。
    lastSweepAt = Date.now()
    timer = setInterval(tick, TICK_MS)
    if (timer.unref) timer.unref()
    log(
      `scheduler: 已启动 — 签到 ${hoursText(cfg.checkinHours)} 点 / 旅行 ${hoursText(cfg.travelHours)} 点 / ` +
        `活跃 ${hoursText(cfg.activityHours)} 点 / 保活 ${hoursText(cfg.keepaliveHours)} 点 / ` +
        `夜猫子 ${hoursText(cfg.blackcatHours)} 点 / 成长任务 ${hoursText(cfg.growthHours)} 点 / ` +
        `余额每 ${cfg.balanceRefreshMinutes} 分钟 / ` +
        `补领清扫 ${cfg.taskSweepEnabled ? `每 ${cfg.taskSweepMinutes} 分钟` : '已关闭'}`
    )
    tick()
  }

  // 停止调度循环
  function stop() {
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // 手动触发单类任务（不受时点/开关限制）
  async function runNow(name) {
    if (!TASK_FNS[name]) return { ok: false, message: `未知任务: ${name}` }
    const summary = await runTask(name)
    return { ok: true, summary, state: { ...state[name] } }
  }

  // 单账号签到
  async function runCheckinFor(ref) {
    const a = resolveAuth(ref)
    if (!a) return { ok: false, message: '账号不存在' }
    if (!a.refreshToken) return { ok: false, message: '缺少 refreshToken' }
    return checkinOne(a)
  }

  // 单账号旅行巡检
  async function runTravelFor(ref) {
    const a = resolveAuth(ref)
    if (!a) return { ok: false, message: '账号不存在' }
    if (!a.refreshToken) return { ok: false, message: '缺少 refreshToken' }
    await travelOne(a)
    return { ok: true, message: '已巡检' }
  }

  // 单账号活跃上报
  async function runActivityFor(ref) {
    const a = resolveAuth(ref)
    if (!a) return { ok: false, message: '账号不存在' }
    if (!a.accessToken) return { ok: false, message: '缺少 accessToken' }
    return activityOne(a)
  }

  // 单账号 token 保活
  async function runKeepaliveFor(ref) {
    const a = resolveAuth(ref)
    if (!a) return { ok: false, message: '账号不存在' }
    if (!a.refreshToken) return { ok: false, message: '缺少 refreshToken' }
    return deps.refreshTokenFor(a)
  }

  // 最近执行状态快照
  function getState() {
    const out = {
      enabled: { ...pickEnabled() },
      hours: { ...pickHours() },
      balanceRefreshMinutes: cfg.balanceRefreshMinutes,
      taskSweepEnabled: cfg.taskSweepEnabled,
      taskSweepMinutes: cfg.taskSweepMinutes
    }
    for (const k of Object.keys(state)) out[k] = { ...state[k] }
    return out
  }

  // 任务开关快照
  function pickEnabled() {
    return {
      checkin: cfg.checkinEnabled,
      travel: cfg.travelEnabled,
      activity: cfg.activityEnabled,
      keepalive: cfg.keepaliveEnabled,
      blackcat: cfg.blackcatEnabled,
      growth: cfg.growthEnabled
    }
  }

  // 时点快照
  function pickHours() {
    return {
      checkin: cfg.checkinHours.slice(),
      travel: cfg.travelHours.slice(),
      activity: cfg.activityHours.slice(),
      keepalive: cfg.keepaliveHours.slice(),
      blackcat: cfg.blackcatHours.slice(),
      growth: cfg.growthHours.slice()
    }
  }

  // 热改排程（hours 空数组回落默认；开关无条件覆盖）
  function updateConfig(patch = {}) {
    if ('checkinHours' in patch) cfg.checkinHours = normalizeHours(patch.checkinHours, DEF.checkinHours)
    if ('travelHours' in patch) cfg.travelHours = normalizeHours(patch.travelHours, DEF.travelHours)
    if ('activityHours' in patch) cfg.activityHours = normalizeHours(patch.activityHours, DEF.activityHours)
    if ('keepaliveHours' in patch) cfg.keepaliveHours = normalizeHours(patch.keepaliveHours, DEF.keepaliveHours)
    if ('blackcatHours' in patch) cfg.blackcatHours = normalizeHours(patch.blackcatHours, DEF.blackcatHours)
    if ('growthHours' in patch) cfg.growthHours = normalizeHours(patch.growthHours, DEF.growthHours)

    if ('checkinEnabled' in patch) cfg.checkinEnabled = patch.checkinEnabled !== false
    if ('travelEnabled' in patch) cfg.travelEnabled = patch.travelEnabled !== false
    if ('activityEnabled' in patch) cfg.activityEnabled = patch.activityEnabled !== false
    if ('keepaliveEnabled' in patch) cfg.keepaliveEnabled = patch.keepaliveEnabled !== false
    if ('blackcatEnabled' in patch) cfg.blackcatEnabled = patch.blackcatEnabled !== false
    if ('growthEnabled' in patch) cfg.growthEnabled = patch.growthEnabled !== false

    if ('balanceRefreshMinutes' in patch) {
      const n = Number(patch.balanceRefreshMinutes)
      cfg.balanceRefreshMinutes = Number.isFinite(n) && n > 0 ? n : DEF.balanceRefreshMinutes
    }
    if ('taskSweepEnabled' in patch) cfg.taskSweepEnabled = patch.taskSweepEnabled !== false
    if ('taskSweepMinutes' in patch) {
      const n = Number(patch.taskSweepMinutes)
      cfg.taskSweepMinutes = Number.isFinite(n) && n > 0 ? n : DEF.taskSweepMinutes
    }
    // 时点/开关变化后清空当日去重，使新时点在当前小时即可命中
    fired.clear()
    return {
      enabled: { ...pickEnabled() },
      hours: { ...pickHours() },
      balanceRefreshMinutes: cfg.balanceRefreshMinutes,
      taskSweepEnabled: cfg.taskSweepEnabled,
      taskSweepMinutes: cfg.taskSweepMinutes
    }
  }

  return {
    start,
    stop,
    runNow,
    runCheckinFor,
    runTravelFor,
    runActivityFor,
    runKeepaliveFor,
    runBlackcatNow,
    runGrowthNow: () => runTask('growth'),
    // 任务补领清扫（手动触发；与定时 tick 同一条链路）
    runTaskSweepNow: () => runTask('taskSweep'),
    // 官方补偿（可观测化）：状态查询 / 逐号领取 / 单号领取 / 汇总
    compensationStatusAll,
    compensationClaimAll,
    compensationClaimFor,
    summarizeCompensation,
    getState,
    updateConfig
  }
}

module.exports = { createScheduler, catchUpDecision, hourSlotMs, WAKEUP_GRACE_MS }