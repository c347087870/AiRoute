// WorkBuddy 成长任务模块：17 项任务一键完成 + 任务中心扫描
// 事件结构按上游规格固定。
//
// 三种指纹：
//   CLI   —— {billingBase}/v2/report（BillingHeaders，无端标记头）
//   桌面  —— {chatBase}/v2/report（桌面 UA + workbuddy-desktop 事件族）
//   Web   —— {webBase}/v2/report（x-client-platform: web）
// 以上 UA / 版本 / 事件体指纹均为官方默认值，可由配置 identity 逐项覆盖（见 identity.js）
// 领奖走 Web 域 /activity/growth/tasks/{code}/claim（x-client-platform: web）。

const crypto = require('crypto')
const C = require('./constants')
const headersMod = require('./headers')
const errMod = require('./errors')
const clientMod = require('./client')

// ===== 节流与轮询参数 =====
const REPORT_GAP = 1050 // 连续上报 / 项间节流（ms）
const CLAIM_POLL_ATTEMPTS = 4 // 达标回读有界轮询次数（含首次读）
const CLAIM_POLL_GAP = 3000 // 达标回读轮询间隔（ms，总预算约 12s）
const ACCEPT_BATCH = 20 // 批量接受分片大小（上游对 task_codes 长度无公开上限，保守 20）
const ACCEPT_BATCH_GAP = 1050 // 批量接受的批间节流（ms）
const MP_ACTION_GAP = 2000 // mp 任务写动作间隔（accept/回读之间，防频控）
const MP_CHAT_EVENT_GAP = 45000 // mp 对话事件真人节奏间隔（ms；连发会被反作弊回滚）
const MP_CHAT_EVENT_JITTER = 10000 // mp 对话事件随机抖动上限（ms）
const EXPERT_SUMMON_GAP = 6000 // 专家召唤链间隔（ms）
const NIGHT_CHAT_GAP = 4000 // 夜猫子夜间对话间隔（ms）
const TEMPLATE_GAP = 300 // 模板事件组间隔（ms）

// 小程序口径专属成长任务：默认（无 mp 头）列表不下发，accept/claim 均要求 mp 头
const MP_TASK_CODES = new Set([
  'school_season', // 校园日（mini chat + activityId）
  'Sequential_Tasks_1', // 小程序首对话
  'Sequential_Tasks_2', // 小程序选专家对话
  'Sequential_Tasks_3', // 小程序 5 次对话
  'Sequential_Tasks_4', // 小程序定时任务（预留）
  'Sequential_Tasks_5', // 小程序使用 GLM5.2（预留）
  'Sequential_Tasks_6', // 小程序 10 次对话（预留）
  'Sequential_Tasks_7' // 体验灵感功能（预留）
])
const MP_OPEN_DAY_ACTIVITY_ID = 'school_open_day_2026' // 校园日 activityId（与开学季同活动关联）

const DESKTOP_VERSION = '5.5.6' // 桌面指纹版本号（默认值；identity.desktopVersion 可覆盖）
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' // Web 事件体浏览器 UA（默认值；identity.webUA 可覆盖）

// 读 identity 覆盖值（空/非法回落默认值；identity 由 runtime/scheduler 经 opts 下发）
function idOf(opts, key, fallback) {
  return headersMod.idv(opts, key) || fallback
}

// 读 identity 数值覆盖值（非正数回落默认值）
function idNumOf(opts, key, fallback) {
  const n = Number(headersMod.idv(opts, key))
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe' // 企鹅教师助手（Buddy_App_QQ 判据应用）
const BUDDY_APP_NAME = '企鹅教师助手'
const BUDDY_INCOMPLETE_MARKER = 'first_buddy task not completed yet' // 领养门槛未过标记
const LIGHTHOUSE_EXPERT_ID = 'ex_2cvvUZQhDyeJ' // 轻量云专家固定 id
const THEME_KEY = 'theme-tkmwj7' // 和平精英激战金秋（Hp_Appearance 判据主题）
const LIBRARY_DOC_URL = 'https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm'
const SERVER_ID_RE = /^(cmb-)?[0-9a-f]{32}$/ // 服务端 requestId 形状

// 可自动化任务的执行顺序（先解锁依赖项）
const TASK_ORDER = [
  'chat_5',
  'first_buddy',
  'Model_chat_GLM5.2',
  'RichMeow_Chat',
  'Buddy_App',
  'Buddy_App_QQ',
  'automation_1',
  'Library_read',
  'template_5',
  'playbook_prompt',
  'create_canvas',
  'expert_5',
  'Expert_team_use_3',
  'Hp_Appearance',
  'skill_1',
  'Expert_lighthouse',
  'black_cat',
  'school_season',
  'Sequential_Tasks_1',
  'Sequential_Tasks_2',
  'Sequential_Tasks_3',
  'Sequential_Tasks_4',
  'Sequential_Tasks_5',
  'Sequential_Tasks_6',
  'Sequential_Tasks_7'
]

// 任务在 TASK_ORDER 中的顺序（队列按依赖序排；未知返回大值）
function taskOrderIndex(code) {
  const i = TASK_ORDER.indexOf(String(code || '').trim())
  return i < 0 ? 1 << 20 : i
}

// 任务是否小程序口径专属（决定 accept/回读/领奖走 mp 变体）
function isMPTaskCode(code) {
  return MP_TASK_CODES.has(String(code || '').trim())
}

// 无独立领奖的任务（buddy/first 即发放奖励）
const NO_CLAIM_CODES = new Set(['first_buddy'])

// ===== 通用工具 =====

// 睡眠指定毫秒
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 安全取整（非有限数回落 0）
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

// 幂等令牌（与前端 randomUUID 同款 8-4-4-4-12 十六进制；mp 事件 requestId 用）
function clientToken() {
  const b = crypto.randomBytes(16).toString('hex')
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`
}

// 数组分片（批量接受按 ACCEPT_BATCH 分批用）
function chunk(list, size) {
  const arr = Array.isArray(list) ? list : []
  const n = size > 0 ? Math.trunc(size) : arr.length || 1
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// 默认口径 + mp 口径任务按 task_code 去重合并（mp 列表是超集，仅补默认列表缺失项）
function mergeTasksByCode(base, extra) {
  const out = Array.isArray(base) ? base.slice() : []
  const seen = new Set(out.map(t => (t && t.task_code) || ''))
  for (const t of Array.isArray(extra) ? extra : []) {
    const code = (t && t.task_code) || ''
    if (!code || seen.has(code)) continue
    out.push(t)
    seen.add(code)
  }
  return out
}

// 账号可读标识（日志用）
function accountLabel(auth) {
  const uid = (auth && auth.uid) || '?'
  const nick = (auth && auth.nickname) || ''
  return nick ? `${uid}(${nick})` : uid
}

// 本地日期字符串（行为事件按天幂等用）
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

// 是否处于夜猫子计数窗口（23:00–08:00 本地时区）
function inNightWindow(now) {
  const h = (now || new Date()).getHours()
  return h >= 23 || h < 8
}

// 桌面/上报用稳定设备标识：sha256("<salt>:<uid>") 前 18 字节 hex（36 字符）
// 与 headers.deriveAccountStableID（wb2a: 前缀）是两套派生，勿混
function deriveID(auth, salt) {
  const uid = (auth && auth.uid) || ''
  return crypto.createHash('sha256').update(`${salt}:${uid}`).digest('hex').slice(0, 36)
}

// 从 SSE 文本中抓第一个匹配的服务端 requestId（cmb- 前缀 32hex 或裸 32hex）
function findServerRequestId(text) {
  const re = /"id":"([^"]+)"/g
  let m
  while ((m = re.exec(String(text || '')))) {
    if (SERVER_ID_RE.test(m[1])) return m[1]
  }
  return ''
}

// 构建归一化后的任务进度文本（日志/回读对比用）
function progressText(task) {
  if (!task) return '?'
  if (task.target > 0) return `${task.current}/${task.target}`
  if (task.claimed) return 'claimed'
  return task.accept_status || '?'
}

// 解析 data.tasks[]（progress 对象优先，平铺兜底；claimable 本地推算）
function parseTasks(data) {
  const arr = data && Array.isArray(data.tasks) ? data.tasks : []
  return arr.map(normalizeTask)
}

// 单任务归一化（字段名固定）
function normalizeTask(raw) {
  const t = raw && typeof raw === 'object' ? raw : {}
  let current = num(t.current)
  let target = num(t.target)
  const pr = t.progress
  if (pr && typeof pr === 'object') {
    const pc = num(pr.current)
    const pt = num(pr.target)
    if (pt > 0 || pc > 0) {
      current = pc
      target = pt
    }
  }
  const claimed = t.accept_status === 'claimed'
  return {
    task_code: String(t.task_code || ''),
    title: String(t.title || ''),
    description: String(t.description || ''),
    task_desc: String(t.task_desc || ''),
    credit: num(t.reward_credit),
    energy: num(t.reward_energy),
    has_reward: !!t.has_reward,
    reward_buddy: !!t.reward_buddy,
    task_type: String(t.task_type || ''),
    tag: String(t.tag || ''),
    jump_url: String(t.jump_url || ''),
    locked: !!t.locked,
    accept_status: String(t.accept_status || ''),
    status: String(t.status || ''),
    target,
    current,
    claimable: !claimed && target > 0 && current >= target,
    claimed
  }
}

// ===== growth 域：列表 / 接受 / 领奖 =====

// 拉取默认口径任务列表并解析（GET {chatBase}/v2/activity/growth/tasks）
async function fetchTasksWith(client, auth, opts) {
  const data = await client.growthOK(auth, 'GET', C.GROWTH_TASKS_PATH, undefined, opts)
  return parseTasks(data)
}

// 拉取小程序口径任务列表并解析（mp 头；mp 专属任务仅在该口径下发）
async function fetchTasksMPWith(client, auth, opts) {
  const data = await client.listTasksMP(auth, opts)
  return parseTasks(data)
}

// 默认 + mp 口径任务去重合并（mp 列表失败静默，返回默认口径）
async function fetchMergedTasksWith(client, auth, opts) {
  const base = await fetchTasksWith(client, auth, opts)
  try {
    const mp = await fetchTasksMPWith(client, auth, opts)
    return mergeTasksByCode(base, mp)
  } catch {
    return base
  }
}

// 接受任务（默认口径；POST {chatBase}/v2/activity/growth/tasks/accept）
// 幂等：已 accepted 时上游返回成功或业务提示，均不视为致命错误
async function acceptTasksWith(client, auth, codes, opts) {
  const list = Array.isArray(codes) ? codes.filter(Boolean) : []
  if (list.length === 0) return { ok: true, message: '无待接受任务' }
  const env = await client.growthCall(auth, 'POST', C.GROWTH_TASKS_ACCEPT_PATH, { task_codes: list }, opts)
  if (env && typeof env.code !== 'undefined' && Number(env.code) !== 0) {
    return { ok: false, message: `code=${env.code} msg=${env.msg || ''}` }
  }
  return { ok: true, message: `已接受 ${list.length} 个任务` }
}

// 接受小程序口径任务（mp 头；缺头实测 task not found）
async function acceptTasksMPWith(client, auth, codes, opts) {
  const list = Array.isArray(codes) ? codes.filter(Boolean) : []
  if (list.length === 0) return { ok: true, message: '无待接受任务' }
  try {
    await client.acceptTasksMP(auth, list, opts)
    return { ok: true, message: `已接受 ${list.length} 个小程序任务` }
  } catch (err) {
    return { ok: false, message: err.message }
  }
}

// 领取奖励：mp 专属任务走 chat 域 mp 口径（400 降级 Web），其余走 Web 域
// 返回 { credit, energy, alreadyClaimed }
async function claimTaskWith(client, auth, code, opts) {
  if (isMPTaskCode(code)) return client.claimRewardMP(auth, code, opts)
  return client.claimReward(auth, code, opts)
}

// 收集尚未接受的任务码（跳过已领取/未解锁/已接受/已完成）
function collectAcceptable(tasks) {
  const codes = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t.claimed || t.locked) continue
    if (t.accept_status === 'accepted' || t.accept_status === 'completed') continue
    if (t.task_code) codes.push(t.task_code)
  }
  return codes
}

// 批量接受该账号全部未接受任务：默认口径分批 20 + 批间 1050ms；mp 口径单独一次
// 返回 { accepted, failed:[codes] }
async function acceptAllWith(client, auth, opts, log) {
  const logger = typeof log === 'function' ? log : () => {}
  let accepted = 0
  const failed = []
  const tasks = await fetchTasksWith(client, auth, opts)
  for (const batch of chunk(collectAcceptable(tasks), ACCEPT_BATCH)) {
    const r = await acceptTasksWith(client, auth, batch, opts)
    if (r.ok) {
      accepted += batch.length
    } else {
      logger(`批量接受失败（不阻塞）：${r.message}`)
      failed.push(...batch)
    }
    await sleep(ACCEPT_BATCH_GAP)
  }
  // mp 口径任务单独接受（默认列表不含 mp 码，accept 亦要求 mp 头）
  try {
    const mpTasks = await fetchTasksMPWith(client, auth, opts)
    const mpCodes = collectAcceptable(mpTasks)
    if (mpCodes.length > 0) {
      const r = await acceptTasksMPWith(client, auth, mpCodes, opts)
      if (r.ok) {
        accepted += mpCodes.length
      } else {
        logger(`mp 批量接受失败（不阻塞）：${r.message}`)
        failed.push(...mpCodes)
      }
      await sleep(ACCEPT_BATCH_GAP)
    }
  } catch (err) {
    logger(`mp 列表拉取失败（不阻塞）：${err.message}`)
  }
  return { accepted, failed }
}

// 定位单个任务（双口径回落）：默认列表未命中且为 mp 专属码时回落 mp 列表；未命中返回 null
async function taskByCodeWith(client, auth, code, opts) {
  const tasks = await fetchTasksWith(client, auth, opts)
  for (const t of tasks) {
    if (t.task_code === code) return t
  }
  if (isMPTaskCode(code)) {
    const mp = await fetchTasksMPWith(client, auth, opts)
    for (const t of mp) {
      if (t.task_code === code) return t
    }
  }
  return null
}

// ===== CLI 指纹：chat_request_send 上报（{billingBase}/v2/report）=====

// 构造 CLI 口径 chat_request_send 事件完整字段（勿用最小字段，防上游加严）
function chatRequestEventBody(auth, conversationID, requestID, modelID, modelName) {
  const conv = conversationID
  const req = requestID || conversationID
  const mid = modelID || 'deepseek-v4-flash'
  const mname = modelName || mid
  const now = Date.now()
  return {
    eventCode: 'chat_request_send',
    timestamp: now,
    reportDelay: 0,
    mode: 'craft',
    conversationId: conv,
    requestId: req,
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
    rootRequestId: req,
    parentConversationId: conv,
    agentName: 'default',
    agentType: 'conversation',
    userId: (auth && auth.uid) || ''
  }
}

// 上报一条 CLI 指纹对话活跃事件（可指定模型）
async function reportChatActivityModel(client, auth, conversationID, requestID, modelID, modelName, opts) {
  const billingBase = headersMod.billingBaseOf(auth, opts)
  const body = [chatRequestEventBody(auth, conversationID, requestID, modelID, modelName)]
  const res = await client.send({
    method: 'POST',
    url: `${billingBase}${C.REPORT_PATH}`,
    headers: headersMod.billingHeaders(auth, opts),
    data: body
  })
  if (res.status >= 400) {
    const e = new Error(`report http ${res.status}: ${errMod.truncateMsg(res.text)}`)
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
    const e = new Error(`report code=${env.code} msg=${env.msg || ''}`)
    e.bizCode = env.code
    throw e
  }
}

// 上报一条默认模型的 CLI 对话活跃事件（deepseek-v4-flash）
function reportChatActivity(client, auth, conversationID, requestID, opts) {
  return reportChatActivityModel(client, auth, conversationID, requestID, 'deepseek-v4-flash', 'DeepSeek V4 Flash', opts)
}

// ===== 桌面指纹：事件链上报（{chatBase}/v2/report）=====

// 公共桌面指纹字段（注入每个事件；业务字段可覆盖同名键）
// 版本/commit/osVersion/核数/内存可由 identity 覆盖（desktopVersion / desktopCommit / desktopOsVersion / desktopCpuCores / desktopMemorySize）
function desktopFingerprint(auth, opts) {
  const now = Date.now()
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: (auth && auth.uid) || '',
    username: (auth && auth.nickname) || '',
    userNickname: (auth && auth.nickname) || '',
    product: 'SaaS',
    releaseDate: idNumOf(opts, 'desktopReleaseDate', 1789036585355),
    commit: idOf(opts, 'desktopCommit', '5f9692923c93033111c51ad7b003eb80204a9b75'),
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: idOf(opts, 'desktopVersion', DESKTOP_VERSION),
    machineId: deriveID(auth, 'machine'),
    sessionId: deriveID(auth, 'session'),
    extName: 'workbuddy-desktop',
    extVersion: idOf(opts, 'desktopVersion', DESKTOP_VERSION),
    os: 'win32',
    arch: 'x64',
    osVersion: idOf(opts, 'desktopOsVersion', '10.0.26220'),
    cpuCores: idNumOf(opts, 'desktopCpuCores', 20),
    memorySize: idNumOf(opts, 'desktopMemorySize', 24),
    timestamp: now,
    presentAt: now
  }
}

// 为每个业务事件注入公共桌面指纹（业务字段优先）
function buildDesktopEvents(auth, events, opts) {
  const fp = desktopFingerprint(auth, opts)
  return events.map(ev => Object.assign({}, fp, ev))
}

// 以桌面指纹上报事件数组
async function reportDesktop(client, auth, events, opts) {
  const res = await client.desktopReport(auth, buildDesktopEvents(auth, events, opts), opts)
  if (res.status >= 400) {
    throw new Error(`desktop report http ${res.status}: ${errMod.truncateMsg(res.text)}`)
  }
}

// 桌面「成功对话」六事件链（RichMeow / 模板 / 灵感 / 画布 / 专家链共用）
function desktopChatSequence(conversationID, requestID, messageID, modelID, modelName) {
  const firstTokenAt = Date.now()
  const mk = (code, extra) => Object.assign({ eventCode: code }, extra)
  return [
    mk('agent_task_created', {
      source: 'LOCAL',
      name: 'working',
      task_target: 'local',
      mode: 'craft',
      requestModelId: modelID,
      requestModelName: modelName,
      has_repo: false,
      repo_type: 'none',
      workspace_type: 'empty',
      has_connector: false,
      connector_types: [],
      has_mention: false,
      mention_types: [],
      has_template: false,
      action: '',
      template_name: '',
      has_expert: false,
      expert_id: '',
      expert_name: '',
      expert_industry_id: '',
      has_skill: false,
      skill_names: [],
      conversationId: conversationID,
      messageId: messageID,
      buddyId: '',
      buddyName: ''
    }),
    mk('chat_message_send', {
      messageId: messageID + '-assistant',
      historyCount: 0,
      isContextTruncated: false,
      currentStepCount: 1,
      traceId: requestID,
      rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: 'cli',
      agentType: 'main'
    }),
    mk('chat_request_send', {
      inputLength: 24,
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 500,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      traceId: requestID,
      rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: 'cli',
      agentType: 'main',
      'codebuddy.session_id': conversationID,
      'codebuddy.conversation_request_id': requestID
    }),
    mk('chat_message_response', {
      messageId: messageID + '-assistant',
      responseModelId: modelID,
      inputToken: 120,
      outputToken: 80,
      totalToken: 200,
      cachedTokens: 0,
      cachedWriteTokens: 0,
      cachedMissTokens: 0,
      isSuccessful: true,
      messageErrorCode: '',
      finishReason: 'stop',
      firstTokenAt,
      traceId: requestID,
      conversationId: conversationID,
      rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: 'cli',
      agentType: 'main',
      'codebuddy.session_id': conversationID,
      'codebuddy.conversation_request_id': requestID
    }),
    mk('chat_message_status', {
      messageId: messageID + '-assistant',
      messageErrorCode: '0',
      traceId: requestID,
      rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: 'cli',
      agentType: 'main'
    }),
    mk('chat_request_response', {
      mode: 'craft',
      toolCallCount: 0,
      inputToken: 120,
      outputToken: 80,
      totalToken: 200,
      cachedTokens: 0,
      cachedWriteTokens: 0,
      cachedMissTokens: 0,
      isSuccessful: true,
      messageErrorCode: '',
      finishReason: 'stop',
      rootRequestId: requestID,
      parentConversationId: conversationID
    })
  ]
}

// buddyapp 进入五连事件（Buddy_App / Buddy_App_QQ 共用）
function desktopBuddyAppSequence(buddyID, buddyName) {
  const mk = (code, extra) =>
    Object.assign({ eventCode: code, mode: 'LOCAL', buddyId: buddyID, buddyName }, extra)
  return [
    mk('buddyapp_discover_click'),
    mk('buddyapp_show', { elementId: buddyID, elementName: buddyName, position: 2 }),
    mk('buddyapp_enter_click', { elementId: buddyID, elementName: buddyName, position: 2, isFirstPage: '1' }),
    mk('buddyapp_auth_confirm_click', { elementId: buddyID, elementName: buddyName }),
    mk('buddyapp_bindaccount_skip_click', { elementId: buddyID, elementName: buddyName })
  ]
}

// 定时任务创建成功事件（automation_1）
function desktopAutomationCreateEvent(name) {
  return {
    eventCode: 'automated_task_create_suc',
    name,
    source: 'manually',
    modelId: 'fast-model',
    modelIsThinking: true,
    connectorCount: 0,
    skills: '',
    skillCount: 0,
    scheduleType: 'once',
    mode: 'LOCAL'
  }
}

// 模板使用事件组（六事件链 + 模板双事件）
function desktopTemplateUseSequence(conversationID, requestID, templateID, templateName) {
  const events = desktopChatSequence(conversationID, requestID, 'msg-' + templateID, 'fast-model', 'fast-model')
  return events.concat([
    {
      eventCode: 'agent_task_created_with_template',
      mode: 'working',
      isCustomModel: false,
      id: templateID,
      name: templateName,
      requestId: requestID
    },
    { eventCode: 'template_used', template_id: templateID, task_mode: 'working' }
  ])
}

// 灵感案例做同款事件组（六事件链 + 三事件）
function desktopPlaybookPromptSequence(conversationID, requestID, caseID, caseName) {
  const events = desktopChatSequence(conversationID, requestID, 'msg-pb', 'fast-model', 'fast-model')
  const payload = {
    id: caseID,
    name: caseName,
    type: 'document',
    categoryId: '',
    categoryName: ''
  }
  return events.concat([
    {
      eventCode: 'web_element_click',
      pageName: 'playbook_detail',
      elementId: 'playbook_ctaClick',
      elementName: caseName,
      source: 'discover'
    },
    Object.assign({ eventCode: 'playbook_cta_click', source: 'discover', position: 0 }, payload),
    Object.assign({ eventCode: 'playbook_prompt_send', conversationId: conversationID, requestId: requestID }, payload)
  ])
}

// 设计创意画布事件组（六事件链 + 画布双事件）
function desktopDesignCanvasSequence(conversationID, requestID) {
  const events = desktopChatSequence(conversationID, requestID, 'msg-canvas', 'fast-model', 'fast-model')
  return events.concat([
    {
      eventCode: 'wbx_design_canvas_task_create',
      conversationId: conversationID,
      requestId: requestID,
      source: 'summon_keyword',
      cost: 12000,
      isSuccessful: true
    },
    {
      eventCode: 'wbx_design_canvas_open',
      conversationId: conversationID,
      requestId: requestID,
      id: 'ardot-file-' + String(requestID).slice(-8),
      source: 'summon_keyword',
      type: 'page',
      cost: 13000,
      isSuccessful: true
    }
  ])
}

// 专家召唤链三事件
function desktopExpertSummonSequence(e) {
  const cat = firstCategory(e.categories)
  const ver = e.version || '1.0.0'
  return [
    {
      eventCode: 'web_element_click',
      source: e.expertID,
      type: cat,
      version: ver,
      elementId: 'expert_summon_click',
      elementName: '立即召唤',
      pageURL: '/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html'
    },
    {
      eventCode: 'expert_summon_click',
      id: e.expertID,
      name: e.displayNameZH,
      expertTitle: e.professionZH,
      type: 'expert-all',
      position: 0,
      expertType: e.expertType,
      version: ver,
      mode: 'LOCAL'
    },
    {
      eventCode: 'expert_summoned',
      id: e.expertID,
      name: e.displayNameZH,
      expertTitle: e.professionZH,
      type: 'expert-all'
    }
  ]
}

// expert_actual_use 公共载荷
function desktopExpertActualUse(e, conversationID, requestID) {
  return {
    eventCode: 'expert_actual_use',
    id: e.expertID,
    name: e.displayNameZH,
    expertTitle: e.professionZH,
    type: firstCategory(e.categories),
    expertType: e.expertType,
    source: 'builtin',
    version: e.version || '1.0.0',
    cost: 9000,
    characterCount: 14,
    conversationId: conversationID,
    requestId: requestID,
    messageId: 'msg-' + String(requestID).slice(-8),
    requestModelId: 'fast-model',
    requestModelName: 'fast-model'
  }
}

// mode:"craft" 变体（expert_5 / Expert_team_use_3 用）
function desktopExpertActualUseEvent(e, conversationID, requestID) {
  const ev = desktopExpertActualUse(e, conversationID, requestID)
  ev.mode = 'craft'
  return ev
}

// mode:"LOCAL" 变体（Expert_lighthouse 用；type 空、cost=0）
function desktopExpertActualUseLocal(e, conversationID, requestID) {
  const ev = desktopExpertActualUse(e, conversationID, requestID)
  ev.mode = 'LOCAL'
  return ev
}

// 取专家首个分类名（缺省 expert-all）
function firstCategory(categories) {
  if (Array.isArray(categories) && categories.length > 0 && typeof categories[0] === 'string') {
    return categories[0]
  }
  return 'expert-all'
}

// ===== Web 指纹：单事件上报（{webBase}/v2/report）=====

// 构造 web 口径浏览器事件（os/osVersion/UA 可由 identity 覆盖：webOs / webOsVersion / webUA）
function buildWebEvent(auth, eventCode, pageURL, elementID, elementName, opts) {
  return {
    eventCode,
    timestamp: Date.now(),
    reportDelay: 0,
    pageURL,
    elementId: elementID,
    elementName,
    os: idOf(opts, 'webOs', 'Win32'),
    arch: '',
    osVersion: idOf(opts, 'webOsVersion', '10.0'),
    userAgent: idOf(opts, 'webUA', WEB_UA),
    machineId: deriveID(auth, 'webmachine'),
    userId: (auth && auth.uid) || '',
    userNickname: (auth && auth.nickname) || '',
    enterpriseId: (auth && auth.enterpriseId) || ''
  }
}

// 以 web 指纹上报单事件
async function reportWeb(client, auth, event, opts) {
  const res = await client.webReport(auth, [event], opts)
  if (res.status >= 400) {
    throw new Error(`web report http ${res.status}: ${errMod.truncateMsg(res.text)}`)
  }
}

// ===== growth 域辅助接口（chatBase，桌面头族）=====

// 发送 JSON 并按 HTTP/业务信封判定成败（chatBase 桌面头族的自建调用）
async function postJSON(client, url, headers, data) {
  const res = await client.send({ method: 'POST', url, headers, data })
  if (res.status >= 400) {
    const e = new Error(`http ${res.status}: ${errMod.truncateMsg(res.text)}`)
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
    const e = new Error(`code=${env.code} msg=${env.msg || ''}`)
    e.bizCode = env.code
    e.body = res.text
    throw e
  }
  return env
}

// 同意 Buddy 协议（幂等）
function buddyAgreement(client, auth, opts) {
  return client.growthOK(auth, 'POST', C.BUDDY_AGREEMENT_PATH, { agree: true }, opts)
}

// 领取第一只 Buddy（+300 分 +8 能量；门槛未过时上游返回 400）
function buddyFirst(client, auth, opts) {
  return client.growthOK(auth, 'POST', C.BUDDY_FIRST_PATH, {}, opts)
}

// 判定「领养门槛未达标」：HTTP 400 且 msg 含 first_buddy 标记
function isBuddyTaskIncomplete(err) {
  if (!err || err.status !== 400) return false
  const text = String(err.body || err.message || '').toLowerCase()
  return text.includes(BUDDY_INCOMPLETE_MARKER)
}

// 设置外观主题（{chatBase}/v2/user-asset/appearance/set）
async function setAppearanceTheme(client, auth, resourceKey, opts) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const headers = {
    Authorization: `Bearer ${(auth && auth.accessToken) || ''}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': headersMod.desktopUA(opts),
    'X-Product': 'SaaS'
  }
  if (auth && auth.uid) headers['X-User-Id'] = auth.uid
  await postJSON(client, `${chatBase}${C.APPEARANCE_SET_PATH}`, headers, {
    kind: 'theme',
    resource_key: resourceKey
  })
}

// 拉取专家市场真实专家列表（expert_actual_use 的 id 必须真实存在）
async function marketExpertList(client, auth, expertType, opts) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const headers = {
    Authorization: `Bearer ${(auth && auth.accessToken) || ''}`,
    'Content-Type': 'application/json',
    'User-Agent': headersMod.desktopUA(opts),
    'X-Domain': chatBase,
    'X-Product': 'SaaS'
  }
  if (auth && auth.uid) headers['X-User-Id'] = auth.uid
  const body = { page: 1, page_size: 20, sort_by: 'reco_rank', sort_order: 'desc' }
  if (expertType) body.expert_type = expertType
  const env = await postJSON(client, `${chatBase}/portal/operation-platform/market/expert/list`, headers, body)
  const experts = env && env.data && Array.isArray(env.data.experts) ? env.data.experts : null
  if (!experts) throw new Error('专家市场响应缺少 experts')
  return experts.map(mapExpert).filter(e => e.expertID)
}

// 上游专家对象 → 内部专家结构
function mapExpert(raw) {
  const e = raw && typeof raw === 'object' ? raw : {}
  return {
    expertID: String(e.expert_id || ''),
    expertType: String(e.expert_type || ''),
    displayNameZH: String(e.display_name_zh || ''),
    professionZH: String(e.profession_zh || ''),
    version: String(e.version || ''),
    categories: Array.isArray(e.categories) ? e.categories : []
  }
}

// 发一条真实桌面指纹 chat（可带 X-Expert-Id），从 SSE 抓服务端 requestId
// 自造 UUID 不计数：expert_actual_use / skill_info 的 requestId 必须是服务端 id
async function desktopChatWithExpert(client, auth, expertID, opts) {
  const chatBase = headersMod.chatBaseOf(auth, opts)
  const conversationID = `wb2api-conv-${Date.now()}`
  const headers = {
    Authorization: `Bearer ${(auth && auth.accessToken) || ''}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': headersMod.desktopUA(opts),
    'X-Domain': chatBase,
    'X-Product': 'SaaS',
    'X-User-Id': (auth && auth.uid) || '',
    'X-Conversation-ID': conversationID,
    'X-Request-ID': String(Date.now()),
    'X-Agent-Intent': 'craft',
    'X-Agent-Type': 'main',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': idOf(opts, 'desktopVersion', DESKTOP_VERSION),
    'x-codebuddy-request': '1'
  }
  if (expertID) headers['X-Expert-Id'] = expertID
  const body = {
    model: 'fast-model',
    messages: [
      { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
      { role: 'user', content: '1+1等于几？直接回答。' }
    ],
    agent: 'cli',
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true }
  }
  const res = await client.send({
    method: 'POST',
    url: `${chatBase}${C.CHAT_COMPLETIONS_PATH}`,
    headers,
    data: body,
    responseType: 'stream'
  })
  if (res.status >= 400) {
    try {
      if (res.data && typeof res.data.destroy === 'function') res.data.destroy()
    } catch {
      /* 忽略关闭失败 */
    }
    throw new Error(`chat http ${res.status}`)
  }
  const text = await client.readAll(res.data, 1 << 20)
  const requestID = findServerRequestId(text)
  if (!requestID) throw new Error('SSE 中未找到服务端 requestId')
  return { conversationID, requestID }
}

// ===== 小程序（mp）指纹：事件构造与上报 =====

// mp 埋点公共指纹（按小程序 appservice 上报形状构造；逐事件叠加，业务字段可覆盖）
// 版本/os/架构/machineId 可由 identity 覆盖（mpVersion / mpOs / mpOsVersion / mpArch / mpMachineId）
function mpEventBase(auth, opts) {
  const mpVersion = idOf(opts, 'mpVersion', '2.4.0')
  return {
    timestamp: Date.now(),
    ideType: 'WorkBuddy_MP',
    ideVersion: mpVersion,
    extName: 'workbuddy-mp',
    extVersion: mpVersion,
    product: 'SaaS',
    ideName: 'wx_app_cloud',
    platform: 'mini_program',
    os: idOf(opts, 'mpOs', 'windows'),
    osVersion: idOf(opts, 'mpOsVersion', '11'),
    arch: idOf(opts, 'mpArch', 'x64'),
    machineId: idOf(opts, 'mpMachineId', '0655736a-607f-4d9d-b430-58176ee9a090'),
    timezone: 'Asia/Shanghai',
    userId: (auth && auth.uid) || '',
    userNickname: (auth && auth.nickname) || ''
  }
}

// mp mini 对话事件（chat_request_send；Tasks_1/3/6 判据载体，无 activityId）
function schoolChatTimesEvent(conversationID) {
  const rid = `wb2api-${clientToken()}`
  return {
    eventCode: 'chat_request_send',
    inputLength: 14,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 500,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    traceId: rid,
    rootRequestId: rid,
    parentConversationId: conversationID,
    conversationId: conversationID,
    messageId: `msg-${rid.slice(-8)}`,
    agentName: 'mp',
    agentType: 'main',
    'codebuddy.session_id': conversationID,
    'codebuddy.conversation_request_id': rid
  }
}

// 校园日（school_season）判据事件：mini 对话 + activityId（无 activityId 不点亮）
function schoolSeasonChatEvent(conversationID) {
  const ev = schoolChatTimesEvent(conversationID)
  ev.activityId = MP_OPEN_DAY_ACTIVITY_ID
  return ev
}

// mp 对话事件 + 模型字段（Sequential_Tasks_5「使用 GLM5.2」判据载体）
function miniChatModelEvent(conversationID, modelID, modelName) {
  const ev = schoolChatTimesEvent(conversationID)
  ev.requestModelId = modelID
  ev.requestModelName = modelName
  return ev
}

// mp 指纹 expert_actual_use（Sequential_Tasks_2 判据载体；与 school 域口径勿混）
function miniExpertUseEvent(expertID, expertName, expertType, opts) {
  const t = expertType || 'agent'
  const name = expertName || expertID
  return {
    eventCode: 'expert_actual_use',
    reportDelay: 0,
    extVersion: idOf(opts, 'mpExtVersion', '2.2.8'),
    source: 'mini_program',
    id: expertID,
    name: expertID,
    expertTitle: name,
    type: 'send_message',
    characterCount: 12,
    expertType: t
  }
}

// mp 指纹灵感事件组（Sequential_Tasks_7 判据载体，2 条）
function miniPlaybookEvents(caseID, caseName, opts) {
  const extVersion = idOf(opts, 'mpExtVersion', '2.2.8')
  const base = {
    id: caseID,
    name: caseName,
    type: 'document',
    categoryId: '',
    categoryName: '',
    skills: '',
    skillNames: ''
  }
  const cta = Object.assign(
    { eventCode: 'playbook_cta_click', source: 'discover', position: 1, extVersion },
    base
  )
  const send = Object.assign(
    {
      eventCode: 'playbook_prompt_send',
      source: 'discover',
      promptLength: 96,
      isOfficial: 1,
      conversationId: `wb2api-mp-pb-${clientToken()}`,
      extVersion
    },
    base
  )
  return [cta, send]
}

// 以 mp 指纹上报事件数组（逐事件叠加公共指纹；失败抛错）
async function reportMP(client, auth, events, opts) {
  const base = mpEventBase(auth, opts)
  const arr = (Array.isArray(events) ? events : [events]).map(ev => Object.assign({}, base, ev))
  const res = await client.reportMPEvent(auth, arr, opts)
  if (res && res.status >= 400) {
    throw new Error(`mp report http ${res.status}: ${errMod.truncateMsg(res.text)}`)
  }
}

// ===== 17 项任务的执行动作 =====

// #1 chat_5：补足 5 条 CLI 对话活跃事件
async function runChat5(ctx) {
  const { client, auth, opts, task } = ctx
  const target = task && task.target > 0 ? task.target : 5
  const current = task ? task.current : 0
  const need = target - current
  if (need <= 0) return { message: '进度已达标，无需上报' }
  for (let i = 0; i < need; i++) {
    const conv = `wb2api-chat5-${Date.now()}-${i}`
    await reportChatActivity(client, auth, conv, '', opts)
    if (i < need - 1) await sleep(REPORT_GAP)
  }
  return { message: `已补报 ${need} 条 CLI 对话活跃事件` }
}

// #2 first_buddy：上报解锁 → 同意协议 → 领取第一只 Buddy
async function runFirstBuddy(ctx) {
  const { client, auth, opts } = ctx
  await reportChatActivity(client, auth, `wb2api-adopt-${Date.now()}`, '', opts)
  await sleep(REPORT_GAP)
  await buddyAgreement(client, auth, opts)
  try {
    await buddyFirst(client, auth, opts)
  } catch (err) {
    if (isBuddyTaskIncomplete(err)) {
      return { message: '前置已上报，但领养门槛未过（上游要求当日活跃），请稍后重试', skipped: true }
    }
    throw err
  }
  return { message: '已领取第一只 Buddy（+300 分 +8 能量）' }
}

// #3 Model_chat_GLM5.2：accept → glm-5.2 真实对话 → 上报模型对话
async function runModelChat(ctx) {
  const { client, auth, opts, deps } = ctx
  if (typeof deps.chatOnce !== 'function') {
    return { message: '未注入 chatOnce，跳过真实对话任务（需接线 runtime.forwardChat）', skipped: true }
  }
  try {
    await acceptTasksWith(client, auth, ['Model_chat_GLM5.2'], opts)
  } catch (err) {
    ctx.log(`accept Model_chat_GLM5.2 失败（继续走行为链路）: ${err.message}`)
  }
  await sleep(REPORT_GAP)
  await deps.chatOnce(auth, 'glm-5.2', 'hi，请回复一句话')
  await sleep(REPORT_GAP)
  await reportChatActivityModel(client, auth, `wb2api-glm52-${Date.now()}`, '', 'glm-5.2', 'GLM-5.2', opts)
  return { message: '已完成 glm-5.2 真实对话并上报' }
}

// #4 RichMeow_Chat：桌面完整对话事件链
async function runRichMeow(ctx) {
  const { client, auth, opts } = ctx
  const ms = Date.now()
  const conv = `wb2api-rm-${ms}`
  const req = `wb2api-rm-req-${ms}`
  const msg = `req-${ms}-user`
  await reportDesktop(client, auth, desktopChatSequence(conv, req, msg, 'fast-model', 'fast-model'), opts)
  return { message: '已按桌面指纹上报完整对话事件链' }
}

// #5/#6 Buddy_App / Buddy_App_QQ：buddyapp 进入五连事件（共用）
async function runBuddyApp(ctx) {
  const { client, auth, opts } = ctx
  await reportDesktop(client, auth, desktopBuddyAppSequence(BUDDY_APP_ID, BUDDY_APP_NAME), opts)
  return { message: '已上报 buddyapp 进入五连事件（覆盖 Buddy_App 与 Buddy_App_QQ）' }
}

// #7 automation_1：定时任务创建成功事件
async function runAutomationCreate(ctx) {
  const { client, auth, opts } = ctx
  await reportDesktop(client, auth, [desktopAutomationCreateEvent('wb2api 自动化')], opts)
  return { message: '已上报定时任务创建事件' }
}

// #8 Library_read：web 域读资料库介绍事件
async function runLibraryRead(ctx) {
  const { client, auth, opts } = ctx
  const ev = buildWebEvent(auth, 'web_element_click', LIBRARY_DOC_URL, 'library_doc_intro_click', 'WorkBuddy资料库介绍', opts)
  await reportWeb(client, auth, ev, opts)
  return { message: '已上报资料库介绍阅读事件' }
}

// #9 template_5：5 组模板使用事件组
async function runTemplateUse(ctx) {
  const { client, auth, opts } = ctx
  const templates = [
    ['1', '深度研究'],
    ['2', '周报生成'],
    ['3', '竞品分析'],
    ['4', '活动策划'],
    ['5', '代码评审']
  ]
  for (let i = 0; i < templates.length; i++) {
    const ms = Date.now()
    const conv = `wb2api-tpl-${ms}-${i}`
    const req = `wb2api-tpl-req-${ms}-${i}`
    await reportDesktop(client, auth, desktopTemplateUseSequence(conv, req, templates[i][0], templates[i][1]), opts)
    await sleep(TEMPLATE_GAP)
  }
  return { message: '已上报 template_used ×5' }
}

// #10 playbook_prompt：灵感案例做同款事件组
async function runPlaybookPrompt(ctx) {
  const { client, auth, opts } = ctx
  const ms = Date.now()
  const conv = `wb2api-pb-${ms}`
  const req = `wb2api-pb-req-${ms}`
  const events = desktopPlaybookPromptSequence(conv, req, 'pm-gtm-launch-plan', '新产品上市 GTM 发布计划一页纸')
  await reportDesktop(client, auth, events, opts)
  return { message: '已上报 playbook_cta_click + playbook_prompt_send' }
}

// #11 create_canvas：设计创意画布事件组
async function runCreateCanvas(ctx) {
  const { client, auth, opts } = ctx
  const ms = Date.now()
  const conv = `wb2api-canvas-${ms}`
  const req = `wb2api-canvas-req-${ms}`
  await reportDesktop(client, auth, desktopDesignCanvasSequence(conv, req), opts)
  return { message: '已上报 wbx_design_canvas_task_create/open' }
}

// #12 expert_5：真实专家召唤+使用链 ×5
function runExpertUse(ctx) {
  return runExpertBatch(ctx, 'agent', 5)
}

// #13 Expert_team_use_3：真实专家团召唤+使用链 ×3
function runExpertTeamUse(ctx) {
  return runExpertBatch(ctx, 'team', 3)
}

// 专家召唤+使用公共实现（失败逐个继续）
async function runExpertBatch(ctx, expertType, count) {
  const { client, auth, opts, log } = ctx
  const experts = await marketExpertList(client, auth, expertType, opts)
  if (experts.length === 0) throw new Error('专家市场列表为空')
  let ok = 0
  for (let i = 0; i < experts.length && ok < count; i++) {
    const e = experts[i]
    try {
      await reportDesktop(client, auth, desktopExpertSummonSequence(e), opts)
      const { conversationID, requestID } = await desktopChatWithExpert(client, auth, e.expertID, opts)
      const events = desktopChatSequence(
        conversationID,
        requestID,
        'msg-' + String(requestID).slice(-8),
        'fast-model',
        'fast-model'
      )
      events.push(desktopExpertActualUseEvent(e, conversationID, requestID))
      await reportDesktop(client, auth, events, opts)
      ok++
      log(`专家链成功 ${ok}/${count}：${e.expertID}`)
    } catch (err) {
      log(`专家链失败（继续下一个）：${e.expertID} → ${err.message}`)
    }
    if (ok < count) await sleep(EXPERT_SUMMON_GAP)
  }
  return { message: `已对 ${ok} 位真实专家（类型 ${expertType}）完成召唤+使用链` }
}

// #14 Hp_Appearance：设置主题 API + 皮肤生效事件
async function runAppearance(ctx) {
  const { client, auth, opts } = ctx
  await setAppearanceTheme(client, auth, THEME_KEY, opts)
  await sleep(2000)
  await reportDesktop(
    client,
    auth,
    [
      {
        eventCode: 'appearance_skin_apply',
        action: 'apply',
        source: 'settings_close',
        id: THEME_KEY,
        vipLevel: 0,
        series: '',
        type: 'unknown'
      }
    ],
    opts
  )
  return { message: '已设置主题并上报皮肤生效事件' }
}

// #15 skill_1：真实对话 + skill_info 技能加载事件
async function runSkillFresh(ctx) {
  const { client, auth, opts } = ctx
  const { conversationID, requestID } = await desktopChatWithExpert(client, auth, '', opts)
  const msgID = 'msg-' + String(requestID).slice(-8)
  const events = desktopChatSequence(conversationID, requestID, msgID, 'fast-model', 'fast-model')
  for (const ev of events) {
    if (ev.eventCode === 'chat_message_response') ev.finishReason = 'tool_calls'
  }
  events.push({
    eventCode: 'skill_info',
    id: '润泽小馆·日报撰写',
    skillId: 'skill_2097350077599879168',
    skillVersion: '1.0.0',
    toolStatus: 'success',
    fileCount: 56,
    source: 'workbuddy-desktop',
    conversationId: conversationID,
    requestId: requestID,
    messageId: msgID,
    requestModelId: 'fast-model',
    requestModelName: 'fast-model',
    traceId: requestID
  })
  await reportDesktop(client, auth, events, opts)
  return { message: '已上报真实对话 + skill_info 技能加载事件' }
}

// #16 Expert_lighthouse：真实轻量云专家召唤+使用链（chat 链带 has_expert）
async function runExpertLighthouse(ctx) {
  const { client, auth, opts } = ctx
  let lh = {
    expertID: LIGHTHOUSE_EXPERT_ID,
    expertType: 'agent',
    displayNameZH: '腾讯轻量云专家',
    professionZH: '腾讯轻量云专家',
    version: '1.0.2',
    categories: []
  }
  try {
    const experts = await marketExpertList(client, auth, 'agent', opts)
    const hit = experts.find(e => e.expertID === LIGHTHOUSE_EXPERT_ID)
    if (hit) lh = hit
  } catch (err) {
    ctx.log(`轻量云专家市场查询失败（用固定信息继续）: ${err.message}`)
  }
  await reportDesktop(client, auth, desktopExpertSummonSequence(lh), opts)
  const { conversationID, requestID } = await desktopChatWithExpert(client, auth, lh.expertID, opts)
  const events = desktopChatSequence(
    conversationID,
    requestID,
    'msg-' + String(requestID).slice(-8),
    'fast-model',
    'fast-model'
  )
  for (const ev of events) {
    if (ev.eventCode === 'agent_task_created') {
      ev.has_expert = true
      ev.expert_id = lh.expertID
      ev.expert_name = lh.displayNameZH
      ev.expert_industry_id = ''
    }
  }
  const use = desktopExpertActualUseLocal(lh, conversationID, requestID)
  use.type = ''
  use.cost = 0
  events.push(use)
  await reportDesktop(client, auth, events, opts)
  return { message: '已上报轻量云专家召唤+使用链（真实对话 requestId）' }
}

// #17 black_cat：夜猫子（23:00–08:00 窗口内 glm-5.2 对话补足）
async function runBlackCat(ctx) {
  const { client, auth, opts, task, deps } = ctx
  if (!inNightWindow()) {
    return { message: '当前不在 23:00–08:00 计数窗口，行为不计分；请在夜间重试', skipped: true }
  }
  const target = task && task.target > 0 ? task.target : 0
  const current = task ? task.current : 0
  let need = 0
  if (!task || task.claimed) need = 0
  else need = target > 0 ? target - current : 0
  if (need <= 0) return { message: '进度已达标，无需补足' }
  if (typeof deps.chatOnce !== 'function') {
    return { message: '未注入 chatOnce，跳过夜间真实对话任务（需接线 runtime.forwardChat）', skipped: true }
  }
  for (let i = 0; i < need; i++) {
    await deps.chatOnce(auth, 'glm-5.2', '1+1等于几？直接回答。')
    await reportChatActivityModel(client, auth, `wb2api-night-${Date.now()}-${i}`, '', 'glm-5.2', 'GLM-5.2', opts)
    if (i < need - 1) await sleep(NIGHT_CHAT_GAP)
  }
  return { message: `已完成 ${need} 次夜间 glm-5.2 对话并上报` }
}

// ===== 小程序口径（mp）任务执行器 =====

// mp 口径回读：拉 mp 列表定位单任务（未命中返回 null）
async function taskByCodeMP(client, auth, code, opts) {
  const tasks = await fetchTasksMPWith(client, auth, opts)
  for (const t of tasks) {
    if (t.task_code === code) return t
  }
  return null
}

// mp accept 登记回读验证：上游存在 200+OK 但未落账形态（此时上报全不归账）；
// 以回读 accept_status 为准，未生效重试一次（最多 2 次）
async function acceptWithVerifyMP(ctx, code) {
  const { client, auth, opts, log } = ctx
  const label = accountLabel(auth)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await client.acceptTasksMP(auth, [code], opts)
    } catch (err) {
      log(`[WorkBuddy任务] mp accept ${code} 尝试${attempt} 失败 账号=${label}：${err.message}`)
      continue
    }
    await sleep(MP_ACTION_GAP)
    const t = await taskByCodeMP(client, auth, code, opts).catch(() => null)
    if (t && t.accept_status && t.accept_status !== 'not_accepted') return true
    log(`[WorkBuddy任务] mp accept ${code} 尝试${attempt} 未登记生效（回读=${t ? t.accept_status || '?' : '?'}）`)
  }
  return false
}

// mp 领奖（chat 域 mp 头，400 降级 Web 域）
function claimMP(ctx, code) {
  return claimTaskWith(ctx.client, ctx.auth, code, ctx.opts)
}

// mp 达标回读（两轮各隔 CLAIM_POLL_GAP）；返回最后一次任务快照
async function readMPAfter(ctx, code, target) {
  let t = await taskByCodeMP(ctx.client, ctx.auth, code, ctx.opts).catch(() => null)
  for (let i = 0; i < 2; i++) {
    if (t && (t.claimable || t.claimed || (target > 0 && t.current >= target))) return t
    await sleep(CLAIM_POLL_GAP)
    const t2 = await taskByCodeMP(ctx.client, ctx.auth, code, ctx.opts).catch(() => null)
    if (t2) t = t2
  }
  return t
}

// growth 域小程序限定任务通用闭环：mp 查询 → accept（带登记回读验证）→
// mini chat 事件上报（withActivityId 决定是否带校园日 activityId）→ 回读 → 达标领奖
async function runMPMiniChatTask(ctx, code, withActivityId) {
  const { client, auth, opts } = ctx
  let t = await taskByCodeMP(client, auth, code, opts)
  if (!t) return { message: 'mp 口径未下发该任务（活动可能已结束）', skipped: true }
  if (t.claimed) return { message: '已领取' }
  if (t.accept_status === 'not_accepted' || !t.accept_status) {
    if (!(await acceptWithVerifyMP(ctx, code))) {
      return { message: 'accept 未登记生效（上游 200+OK 但未落账形态），待下次重试', skipped: true }
    }
    // accept 前 progress 为 null（target 下发 0），接受后回读一次拿真实 target/current
    const t2 = await taskByCodeMP(client, auth, code, opts).catch(() => null)
    if (t2) t = t2
  }
  const target = t.target > 0 ? t.target : 1
  if (t.current >= target || t.accept_status === 'completed') {
    const r = await claimMP(ctx, code)
    return { message: `已领取奖励（+${r.credit}c +${r.energy}e）` }
  }
  const need = target - t.current
  for (let i = 0; i < need; i++) {
    // 真人节奏：每条上报前等待 MP_CHAT_EVENT_GAP + 0~10s 抖动（连发会被反作弊回滚）
    await sleep(MP_CHAT_EVENT_GAP + Math.floor(Math.random() * MP_CHAT_EVENT_JITTER))
    const conv = `wb2api-mp-${Date.now()}-${i}`
    const ev = withActivityId ? schoolSeasonChatEvent(conv) : schoolChatTimesEvent(conv)
    try {
      await reportMP(client, auth, ev, opts)
    } catch (err) {
      return { message: `完成 ${i}/${need} 次上报后中断：${err.message}` }
    }
  }
  const after = await readMPAfter(ctx, code, target)
  if (after && after.claimed) return { message: '本轮已入账（claimed）' }
  if (!after || after.current < target) {
    return { message: `已上报 ${need} 次但进度未达 ${after ? after.current : '?'}/${target}（异步计分未归账，下次重试）` }
  }
  const r = await claimMP(ctx, code)
  return { message: `任务点亮并领取奖励（+${r.credit}c +${r.energy}e）` }
}

// Sequential 链预留任务通用骨架：mp 查询 → accept（带验证）→ 判据事件上报（primary；
// 未点亮且 fallback 非空时补一轮）→ 回读 → 达标领奖。每日零点解锁一环
async function runSequentialEventTask(ctx, code, primary, fallback) {
  const { client, auth, opts } = ctx
  let t = await taskByCodeMP(client, auth, code, opts)
  if (!t) return { message: 'mp 口径未下发该任务（前置任务未完成或活动未开始）', skipped: true }
  if (t.claimed) return { message: '已领取' }
  const target = t.target > 0 ? t.target : 1
  if (t.current >= target || t.accept_status === 'completed') {
    const r = await claimMP(ctx, code)
    return { message: `已领取奖励（+${r.credit}c +${r.energy}e）` }
  }
  if (t.accept_status === 'not_accepted' || !t.accept_status) {
    if (!(await acceptWithVerifyMP(ctx, code))) {
      return { message: 'accept 未登记生效（任务可能处于每日锁定窗口，等解锁后自动重试）', skipped: true }
    }
  }
  try {
    await primary()
  } catch (err) {
    return { message: `判据上报失败：${err.message}` }
  }
  for (let round = 0; round < 2; round++) {
    await sleep(CLAIM_POLL_GAP)
    const t2 = await taskByCodeMP(client, auth, code, opts).catch(() => null)
    if (t2) t = t2
    if (t.claimable || t.claimed || t.current >= target) break
    if (round === 0 && fallback) {
      try {
        await fallback()
      } catch (err) {
        return { message: `备选判据上报失败：${err.message}` }
      }
    }
  }
  if (t.claimed) return { message: '本轮已入账（claimed）' }
  if (t.current < target) return { message: '已上报但进度未点亮（判据形态待解锁后校正，下次重试）' }
  const r = await claimMP(ctx, code)
  return { message: `任务点亮并领取奖励（+${r.credit}c +${r.energy}e）` }
}

// Sequential_Tasks_2「小程序选专家对话」：accept 之前先解析市场真实专家 id
// （拉不到就整任务不动作，避免留下「已登记未上报」的半程态）
async function runMiniExpert(ctx) {
  const { client, auth, opts } = ctx
  const code = 'Sequential_Tasks_2'
  let t = await taskByCodeMP(client, auth, code, opts)
  if (!t) return { message: 'mp 口径未下发该任务（活动可能已结束）', skipped: true }
  if (t.claimed) return { message: '已领取' }
  const target = t.target > 0 ? t.target : 1
  if (t.current >= target || t.accept_status === 'completed') {
    const r = await claimMP(ctx, code)
    return { message: `已领取奖励（+${r.credit}c +${r.energy}e）` }
  }
  let experts
  try {
    experts = await marketExpertList(client, auth, '', opts)
  } catch (err) {
    return { message: `专家市场不可用（${err.message}），跳过以防半程态`, skipped: true }
  }
  if (!experts.length) return { message: '专家市场列表为空，跳过以防半程态', skipped: true }
  const e = experts[0]
  const name = e.displayNameZH || e.professionZH || e.expertID
  if (t.accept_status === 'not_accepted' || !t.accept_status) {
    if (!(await acceptWithVerifyMP(ctx, code))) {
      return { message: 'accept 未登记生效（上游 200+OK 但未落账形态），待下次重试', skipped: true }
    }
  }
  try {
    await reportMP(client, auth, miniExpertUseEvent(e.expertID, name, e.expertType, opts), opts)
  } catch (err) {
    return { message: `上报 expert_actual_use 失败：${err.message}` }
  }
  const after = await readMPAfter(ctx, code, target)
  if (after && after.claimed) return { message: '本轮已入账（claimed）' }
  if (!after || after.current < target) return { message: '已上报但进度未归账（异步计分，下次重试）' }
  const r = await claimMP(ctx, code)
  return { message: `任务点亮并领取奖励（+${r.credit}c +${r.energy}e）` }
}

// school_season「校园日」：mini 对话 + activityId（无 activityId 不点亮）
function runSchoolSeason(ctx) {
  return runMPMiniChatTask(ctx, 'school_season', true)
}

// Sequential_Tasks_1「小程序首对话」：mini 对话（无 activityId）
function runSequentialChat(ctx) {
  return runMPMiniChatTask(ctx, 'Sequential_Tasks_1', false)
}

// Sequential_Tasks_3「小程序 5 次对话」：与 Tasks_1 同形状，target 由任务自带（真人节奏）
function runSequentialChat5(ctx) {
  return runMPMiniChatTask(ctx, 'Sequential_Tasks_3', false)
}

// Sequential_Tasks_6「小程序 10 次对话」（预留）：判据假定同形状，target 以解锁后下发为准
function runSequentialChat10(ctx) {
  return runMPMiniChatTask(ctx, 'Sequential_Tasks_6', false)
}

// Sequential_Tasks_4「小程序定时任务」（预留）：primary 复用 PC 口径 automation_1 事件
function runSequentialAutomation(ctx) {
  return runSequentialEventTask(
    ctx,
    'Sequential_Tasks_4',
    () => reportDesktop(ctx.client, ctx.auth, [desktopAutomationCreateEvent('wb2api 自动化')], ctx.opts),
    null
  )
}

// Sequential_Tasks_5「小程序使用 GLM5.2」（预留）：primary 为带模型字段的 mp 对话事件，
// fallback 为 PC 域模型活跃上报（Model_chat_GLM5.2 同源）
function runSequentialModelChat(ctx) {
  return runSequentialEventTask(
    ctx,
    'Sequential_Tasks_5',
    () =>
      reportMP(
        ctx.client,
        ctx.auth,
        miniChatModelEvent(`wb2api-mp-glm-${Date.now()}`, 'glm-5.2', 'GLM-5.2'),
        ctx.opts
      ),
    () =>
      reportChatActivityModel(ctx.client, ctx.auth, `wb2api-mp-glm-${Date.now()}`, '', 'glm-5.2', 'GLM-5.2', ctx.opts)
  )
}

// Sequential_Tasks_7「体验灵感功能」（预留，疑 PC 口径）：primary 为 PC 灵感事件组，
// fallback 为 mp 指纹灵感事件组
function runSequentialPlaybook(ctx) {
  const ms = Date.now()
  const caseID = 'pm-gtm-launch-plan'
  const caseName = '新产品上市 GTM 发布计划一页纸'
  return runSequentialEventTask(
    ctx,
    'Sequential_Tasks_7',
    () =>
      reportDesktop(
        ctx.client,
        ctx.auth,
        desktopPlaybookPromptSequence(`wb2api-pb-${ms}`, `wb2api-pb-req-${ms}`, caseID, caseName),
        ctx.opts
      ),
    () => reportMP(ctx.client, ctx.auth, miniPlaybookEvents(caseID, caseName, ctx.opts), ctx.opts)
  )
}

// task_code → 执行动作映射表（顺序即 TASK_ORDER）
const TASK_ACTIONS = {
  chat_5: { desc: '上报 5 条对话活跃事件（自动补足差额）', attempt: false, run: runChat5 },
  first_buddy: { desc: '上报解锁 → 同意协议 → 领取第一只 Buddy', attempt: false, run: runFirstBuddy },
  'Model_chat_GLM5.2': { desc: '接受任务 → glm-5.2 真实对话一次 → 上报模型对话', attempt: false, run: runModelChat },
  RichMeow_Chat: { desc: '桌面指纹完整对话事件链上报', attempt: false, run: runRichMeow },
  Buddy_App: { desc: '上报「进入 Buddy 应用」事件链', attempt: false, run: runBuddyApp },
  Buddy_App_QQ: { desc: '上报「进入企鹅教师助手」事件链', attempt: false, run: runBuddyApp },
  automation_1: { desc: '上报「定时任务创建」事件', attempt: false, run: runAutomationCreate },
  Library_read: { desc: '上报「读资料库介绍」事件', attempt: false, run: runLibraryRead },
  template_5: { desc: '上报「使用模板创建任务」事件组 ×5', attempt: false, run: runTemplateUse },
  playbook_prompt: { desc: '上报「灵感案例做同款发送 Prompt」事件组', attempt: false, run: runPlaybookPrompt },
  create_canvas: { desc: '上报「设计创意画布创建」事件组', attempt: false, run: runCreateCanvas },
  expert_5: { desc: '真实专家召唤+使用链 ×5', attempt: false, run: runExpertUse },
  Expert_team_use_3: { desc: '真实专家团召唤+使用链 ×3', attempt: false, run: runExpertTeamUse },
  Hp_Appearance: { desc: '设置主题 API + 皮肤生效事件', attempt: false, run: runAppearance },
  skill_1: { desc: '真实对话 + skill_info 技能加载事件', attempt: false, run: runSkillFresh },
  Expert_lighthouse: { desc: '真实轻量云专家召唤+使用链（chat 链带 has_expert）', attempt: false, run: runExpertLighthouse },
  black_cat: { desc: '夜猫子：23:00–08:00 窗口内 glm-5.2 对话补足', attempt: true, run: runBlackCat },
  // ===== 小程序口径（mp）任务：accept/回读/领奖走 mp 变体 =====
  school_season: { desc: '校园日（mp）：accept → mini 对话+activityId → 领奖', attempt: false, mp: true, run: runSchoolSeason },
  Sequential_Tasks_1: { desc: '小程序首对话（mp）：accept → mini 对话上报 → 领奖', attempt: false, mp: true, run: runSequentialChat },
  Sequential_Tasks_2: { desc: '小程序选专家对话（mp）：市场专家 id → accept → expert_actual_use → 领奖', attempt: false, mp: true, run: runMiniExpert },
  Sequential_Tasks_3: { desc: '小程序 5 次对话（mp）：accept → mini 对话 ×5（真人节奏）→ 领奖', attempt: false, mp: true, run: runSequentialChat5 },
  Sequential_Tasks_4: { desc: '小程序定时任务（mp，预留）：accept → 定时任务创建事件 → 领奖', attempt: false, mp: true, run: runSequentialAutomation },
  Sequential_Tasks_5: { desc: '小程序使用 GLM5.2（mp，预留）：accept → 带模型字段 mini 对话 → 领奖', attempt: false, mp: true, run: runSequentialModelChat },
  Sequential_Tasks_6: { desc: '小程序 10 次对话（mp，预留）：accept → mini 对话 ×target → 领奖', attempt: false, mp: true, run: runSequentialChat10 },
  Sequential_Tasks_7: { desc: '体验灵感功能（mp，预留）：accept → PC/mp 灵感事件组 → 领奖', attempt: false, mp: true, run: runSequentialPlaybook }
}

// ===== 对外接口（模块级默认使用 client.js 模块）=====

// 查询任务列表（默认 + mp 口径按 task_code 去重合并后返回）
async function fetchTasks(auth, opts = {}) {
  return fetchMergedTasksWith(clientMod, auth, opts)
}

// 接受任务（幂等；mp 专属码走 mp 头）
async function acceptTasks(auth, codes, opts = {}) {
  const mpCodes = (Array.isArray(codes) ? codes : []).filter(isMPTaskCode)
  const normalCodes = (Array.isArray(codes) ? codes : []).filter(c => !isMPTaskCode(c))
  const r = await acceptTasksWith(clientMod, auth, normalCodes, opts)
  if (mpCodes.length) await acceptTasksMPWith(clientMod, auth, mpCodes, opts)
  return r
}

// 领取单个任务奖励（mp 专属码走 chat 域 mp 口径，其余 Web 域）
async function claimTask(auth, code, opts = {}) {
  return claimTaskWith(clientMod, auth, code, opts)
}

// ===== 一键完成执行器 =====

// 构造「账号任务占用」错误（同账号并发执行任务时抛；HTTP 层映射 409）
function accountBusyError() {
  const e = new Error('该账号正在执行任务，请稍候')
  e.code = 'account_busy'
  e.ok = false
  return e
}

// 创建任务执行器（deps 由调用方注入）
// deps: { client, log, chatOnce? }
function createTaskRunner(deps = {}) {
  const client = deps.client || clientMod
  const log = typeof deps.log === 'function' ? deps.log : msg => console.log(msg)
  const activeUIDs = new Set() // 正在执行任务的账号（占用即他处 409，不再排队等待）
  const dailyDone = new Map() // `${uid}|${code}|${date}` → 时间戳（行为事件按天幂等）
  const state = { running: false, current: '', startedAt: 0, finishedAt: 0, items: [] }

  // 归一化 opts（空值兜底为对象）
  function mkOpts(options) {
    return options && typeof options === 'object' ? options : {}
  }

  // 账号任务互斥：同账号已占用时直接抛 account_busy（占用即 409，不再排队）；
  // 队列内部逐条串行调用，正常路径不会并发占用。
  function withAccountLock(auth, fn) {
    const uid = (auth && auth.uid) || ''
    if (uid && activeUIDs.has(uid)) return Promise.reject(accountBusyError())
    if (uid) activeUIDs.add(uid)
    return Promise.resolve()
      .then(() => fn())
      .finally(() => {
        if (uid) activeUIDs.delete(uid)
      })
  }

  // 按天幂等键
  function dailyKey(auth, code) {
    return `${(auth && auth.uid) || ''}|${code}|${todayStr()}`
  }

  // 执行后轮询等待异步计分落定（达标即返回；有界预算 CLAIM_POLL_ATTEMPTS 次含首次读）
  async function waitClaimable(auth, code, opts) {
    let t = await taskByCodeWith(client, auth, code, opts).catch(() => null)
    if (t && (t.claimable || t.claimed || t.accept_status === 'completed')) return t
    for (let i = 1; i < CLAIM_POLL_ATTEMPTS; i++) {
      await sleep(CLAIM_POLL_GAP)
      const t2 = await taskByCodeWith(client, auth, code, opts).catch(() => null)
      if (t2) {
        t = t2
        if (t.claimable || t.claimed || t.accept_status === 'completed') return t
      }
    }
    return t
  }

  // 达标自动领奖；返回领奖结果对象（不抛出）
  async function autoClaim(auth, code, opts, item) {
    if (NO_CLAIM_CODES.has(code)) return
    try {
      const r = await claimTaskWith(client, auth, code, opts)
      item.claimed = true
      item.credit = r.credit
      item.energy = r.energy
      if (r.alreadyClaimed || (r.credit === 0 && r.energy === 0)) {
        item.message += '；奖励此前已领取'
      } else {
        item.message += `；已自动领奖 +${r.credit} 分 +${r.energy} 能`
      }
    } catch (err) {
      item.claim_error = err.message
      item.message += '；达标但领奖失败，可在任务列表手动重试'
    }
  }

  // 阶段 0：批量接受尚未接受的任务（默认分批 20 + mp 口径；失败不阻塞）
  async function acceptPending(auth, opts) {
    const r = await acceptAllWith(client, auth, opts, log)
    return r.accepted
  }

  // 执行单项任务（含幂等判定、执行、轮询、自动领奖）
  async function runItem(auth, code, opts) {
    const act = TASK_ACTIONS[code]
    if (!act) return null
    const item = { task_code: code, desc: act.desc, attempt: !!act.attempt, status: 'pending', message: '' }
    const label = accountLabel(auth)

    let task = await taskByCodeWith(client, auth, code, opts)
    if (task && task.claimed) {
      item.status = 'skipped'
      item.message = '已领取过奖励'
      item.progress_after = progressText(task)
      return item
    }
    // 达标判定：进度达标或 accept_status=completed 均可直接领奖
    if (task && ((task.target > 0 && task.current >= task.target) || task.accept_status === 'completed')) {
      item.status = 'done'
      item.message = '进度已达标'
      item.progress_before = progressText(task)
      await autoClaim(auth, code, opts, item)
      return item
    }

    const key = dailyKey(auth, code)
    if (dailyDone.has(key)) {
      item.status = 'skipped'
      item.message = '今日已执行（行为事件按天幂等）'
      if (task) item.progress_before = progressText(task)
      return item
    }

    log(`[WorkBuddy任务] 开始执行 code=${code} 账号=${label}`)
    try {
      const res = await act.run({ client, auth, opts, deps, task, log })
      dailyDone.set(key, Date.now())
      item.message = (res && res.message) || '执行完成'
      item.status = res && res.skipped ? 'skipped' : 'done'
      log(`[WorkBuddy任务] 执行完成 code=${code} 账号=${label} 结果=${item.status}：${item.message}`)
    } catch (err) {
      item.status = 'error'
      item.message = err.message
      log(`[WorkBuddy任务] 执行失败 code=${code} 账号=${label}：${err.message}`)
      return item
    }

    const after = await waitClaimable(auth, code, opts).catch(() => null)
    if (after) item.progress_after = progressText(after)
    if (after && (after.claimable || after.accept_status === 'completed')) await autoClaim(auth, code, opts, item)
    return item
  }

  // 一键完成全部可自动化任务（账号内串行）
  async function runAll(auth, options = {}) {
    return withAccountLock(auth, async () => {
      const opts = mkOpts(options)
      const label = accountLabel(auth)
      state.running = true
      state.current = ''
      state.startedAt = Date.now()
      state.finishedAt = 0
      state.items = []
      log(`[WorkBuddy任务] 一键完成开始 账号=${label}`)

      if (options.accept !== false) {
        try {
          const n = await acceptPending(auth, opts)
          if (n > 0) log(`[WorkBuddy任务] 阶段0 已接受 ${n} 个未接受任务 账号=${label}`)
        } catch (err) {
          log(`[WorkBuddy任务] 阶段0 批量接受失败（不阻塞）：${err.message}`)
        }
      }

      const codes = Array.isArray(options.codes) && options.codes.length > 0 ? options.codes : TASK_ORDER
      for (const code of codes) {
        state.current = code
        let item
        try {
          item = await runItem(auth, code, opts)
        } catch (err) {
          item = { task_code: code, status: 'error', message: `查询/执行失败：${err.message}` }
        }
        if (item) state.items.push(item)
        await sleep(REPORT_GAP)
      }

      state.current = ''
      state.running = false
      state.finishedAt = Date.now()
      const done = state.items.filter(i => i.status === 'done').length
      const failed = state.items.filter(i => i.status === 'error').length
      log(`[WorkBuddy任务] 一键完成结束 账号=${label} 完成=${done} 失败=${failed}`)
      return state.items.slice()
    })
  }

  // 一键完成单个任务（账号内串行）
  async function runOne(auth, taskCode, options = {}) {
    return withAccountLock(auth, async () => {
      const opts = mkOpts(options)
      const code = String(taskCode || '').trim()
      if (!TASK_ACTIONS[code]) {
        throw new Error(`该任务不可自动化（无对应动作）：${code}`)
      }
      state.running = true
      state.current = code
      if (!state.startedAt) state.startedAt = Date.now()
      const item = await runItem(auth, code, opts)
      state.items.push(item)
      state.current = ''
      state.running = false
      state.finishedAt = Date.now()
      return item
    })
  }

  // 当前执行进度（供前端轮询展示）
  function getProgress() {
    const items = state.items.map(i => Object.assign({}, i))
    return {
      running: state.running,
      current: state.current,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      total: items.length,
      completed: items.filter(i => i.status === 'done').length,
      failed: items.filter(i => i.status === 'error').length,
      items
    }
  }

  return { runAll, runOne, getProgress }
}

// ===== 任务中心扫描（并发上限 2）=====

// 扫描单账号未完成任务 + 可自动化标记（默认 + mp 口径合并）
async function scanOneAccount(auth, opts) {
  const acc = { uid: (auth && auth.uid) || '', nickname: (auth && auth.nickname) || '', pending: [], error: '' }
  try {
    const tasks = await fetchMergedTasksWith(clientMod, auth, opts)
    for (const t of tasks) {
      if (t.claimed || t.locked) continue
      const act = TASK_ACTIONS[t.task_code]
      if (!act) continue
      acc.pending.push({
        task_code: t.task_code,
        desc: act.desc,
        target: t.target,
        current: t.current,
        done: (t.target > 0 && t.current >= t.target) || t.accept_status === 'completed',
        mp: isMPTaskCode(t.task_code),
        automatable: true,
        attempt: !!act.attempt
      })
    }
    // 按 TASK_ORDER 依赖序排序（前置任务先执行）
    acc.pending.sort((a, b) => taskOrderIndex(a.task_code) - taskOrderIndex(b.task_code))
  } catch (err) {
    acc.error = err.message
  }
  return acc
}

// 单账号待办任务码（按依赖序；只含可自动化且未完成的任务）——供执行队列入队
async function scanPendingCodes(auth, opts = {}) {
  const acc = await scanOneAccount(auth, opts)
  if (acc.error) throw new Error(acc.error)
  return acc.pending.map(p => p.task_code)
}

// 批量接受单账号全部未接受任务（默认分批 20 + mp 口径）
function acceptAllFor(auth, opts = {}, log) {
  return acceptAllWith(clientMod, auth, opts, log)
}

// 扫描全账号任务列表（并发上限 2；返回每账号未完成任务 + 可自动化标记）
async function scanTasks(auths, opts = {}) {
  const list = Array.isArray(auths) ? auths.filter(Boolean) : []
  const results = new Array(list.length)
  const conc = Math.min(2, list.length)
  let idx = 0
  async function worker() {
    while (true) {
      const i = idx++
      if (i >= list.length) return
      results[i] = await scanOneAccount(list[i], opts)
    }
  }
  const workers = []
  for (let w = 0; w < Math.max(conc, 1); w++) workers.push(worker())
  await Promise.all(workers)
  return results
}

module.exports = {
  fetchTasks,
  acceptTasks,
  claimTask,
  createTaskRunner,
  scanTasks,
  scanPendingCodes,
  acceptAllFor,
  accountBusyError,
  isMPTaskCode,
  taskOrderIndex,
  mergeTasksByCode,
  chunk,
  TASK_ORDER,
  TASK_ACTIONS,
  // 参数/常量（测试与队列复用）
  CLAIM_POLL_ATTEMPTS,
  CLAIM_POLL_GAP,
  ACCEPT_BATCH,
  ACCEPT_BATCH_GAP,
  MP_ACTION_GAP,
  MP_CHAT_EVENT_GAP,
  MP_TASK_CODES
}