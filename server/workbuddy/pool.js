// WorkBuddy 账号池：选号调度、冷却/熔断状态机、在途租约、状态持久化

const fs = require('fs')
const path = require('path')
const C = require('./constants')

const COOL_HARD = 0 // 余额不足 → 冷却到次日 04:00
const COOL_SOFT = 1 // 429 → 短冷却

const MODEL_COST_TTL = 6 * 3600 * 1000 // 模型成本台账有效期 6h
const MODEL_BLOCK_BASE_TTL = 6 * 3600 * 1000 // 11102 负缓存基数 6h
const MODEL_BLOCK_SHIFT = 4
const MODEL_BLOCK_MAX_TTL = 24 * 3600 * 1000 // 11102 负缓存封顶 24h
const SOFT_STREAK_SHIFT_MAX = 16
const MODEL_BLOCK_REASON = '11102 model not available'
const SESSION_DEAD_REASON = '12153 session dead'
const SESSION_DEAD_THRESHOLD = 3

// 创建账号池
// opts: { stateFile, softRateMs, softRateMaxMs, breaker..., degrade..., maxInFlight..., minPickGapMs, idleWeight..., preferExpiring, expiringSoonMs }
function createPool(opts = {}) {
  const cfg = {
    softRateMs: opts.softRateMs > 0 ? opts.softRateMs : C.POOL_DEFAULTS.softRateMs,
    softRateMaxMs: opts.softRateMaxMs > 0 ? opts.softRateMaxMs : C.POOL_DEFAULTS.softRateMaxMs,
    breakerThreshold: opts.breakerThreshold > 0 ? opts.breakerThreshold : C.POOL_DEFAULTS.breakerThreshold,
    breakerCooldownMs: opts.breakerCooldownMs > 0 ? opts.breakerCooldownMs : C.POOL_DEFAULTS.breakerCooldownMs,
    breakerCooldownMaxMs: opts.breakerCooldownMaxMs > 0 ? opts.breakerCooldownMaxMs : C.POOL_DEFAULTS.breakerCooldownMaxMs,
    degradeThreshold: opts.degradeThreshold > 0 ? opts.degradeThreshold : C.POOL_DEFAULTS.degradeThreshold,
    degradeCooldownMs: opts.degradeCooldownMs > 0 ? opts.degradeCooldownMs : C.POOL_DEFAULTS.degradeCooldownMs,
    degradeCooldownMaxMs: opts.degradeCooldownMaxMs > 0 ? opts.degradeCooldownMaxMs : C.POOL_DEFAULTS.degradeCooldownMaxMs,
    maxInFlight: typeof opts.maxInFlight === 'number' && opts.maxInFlight >= 0 ? opts.maxInFlight : C.POOL_DEFAULTS.maxInFlight,
    minPickGapMs: opts.minPickGapMs > 0 ? opts.minPickGapMs : C.POOL_DEFAULTS.minPickGapMs,
    idleWeightPerHour: typeof opts.idleWeightPerHour === 'number' ? opts.idleWeightPerHour : C.POOL_DEFAULTS.idleWeightPerHour,
    idleWeightMax: typeof opts.idleWeightMax === 'number' ? opts.idleWeightMax : C.POOL_DEFAULTS.idleWeightMax,
    preferExpiring: opts.preferExpiring !== false,
    expiringSoonMs: typeof opts.expiringSoonMs === 'number' ? opts.expiringSoonMs : C.POOL_DEFAULTS.expiringSoonMs,
    costExploreMs: typeof opts.costExploreMs === 'number' ? opts.costExploreMs : C.POOL_DEFAULTS.costExploreMs,
    onEvent: typeof opts.onEvent === 'function' ? opts.onEvent : null,
    stateFile: opts.stateFile || ''
  }

  const byUID = new Map() // uid → entry
  let pickSeq = 0 // 单调选号序号（LRU 兜底）
  let dirty = false
  let flushTimer = null
  const exploreLast = new Map() // model → 上次成本探索时刻（运行态，不持久化）

  // ===== 账号增删 =====

  // 加入或更新账号（已存在只换凭证，保留积分与冷却状态）
  function add(auth) {
    if (!auth?.uid) return false
    const existing = byUID.get(auth.uid)
    if (existing) {
      existing.auth = auth
    } else {
      byUID.set(auth.uid, newEntry(auth))
    }
    dirty = true
    return true
  }

  // 目录扫描结果对齐：新账号加入、消失的账号剔除
  function syncToDir(auths) {
    const incoming = new Set()
    for (const a of auths || []) {
      if (!a?.uid) continue
      incoming.add(a.uid)
      add(a)
    }
    let removed = false
    for (const uid of [...byUID.keys()]) {
      if (!incoming.has(uid)) {
        byUID.delete(uid)
        removed = true
      }
    }
    if (removed) {
      dirty = true
      saveNow()
    }
  }

  // 移除账号，返回被移除的凭证（供删除文件）
  function remove(uid) {
    const e = byUID.get(uid)
    if (!e) return null
    byUID.delete(uid)
    dirty = true
    saveNow()
    return e.auth
  }

  // 新建账号条目（全部状态归零）
  function newEntry(auth) {
    return {
      uid: auth.uid,
      auth,
      credits: 0,
      creditsTotal: 0,
      disabled: false,
      reason: '',
      until: 0,
      coolKind: 0,
      successCount: 0,
      errTotal: 0,
      lastSuccess: 0,
      lastErr: 0,
      lastCheckinDay: '',
      lastCheckinAt: 0,
      lastKeepaliveAt: 0,
      lastKeepaliveOk: false,
      tokenUsageTotal: 0,
      tokenUsageToday: 0,
      tokenDayKey: '',
      disabledAt: 0,
      softStreak: 0,
      sessionDeadFails: 0,
      consecutiveFails: 0,
      degradeUntil: 0,
      breakerUntil: 0,
      retryCount: 0,
      fails: 0,
      creditsExpiring: 0,
      creditsEarliestExpiry: 0,
      creditsEarliestRemaining: 0,
      modelCooldowns: {},
      modelCosts: {},
      inFlight: 0,
      lastUsed: 0,
      usedSeq: 0
    }
  }

  // ===== 健康判定 =====

  // 账号级健康：禁用/冷却/熔断/降权四条件任一未到期即不可选
  function healthy(e, now) {
    if (e.disabled) return false
    if (e.until && now < e.until) return false
    if (e.breakerUntil && now < e.breakerUntil) return false
    if (e.degradeUntil && now < e.degradeUntil) return false
    return true
  }

  // 该账号对指定模型是否被独立冷却（6004）
  function modelCooled(e, now, reqModel) {
    if (!reqModel) return false
    const mc = e.modelCooldowns[reqModel]
    if (!mc || mc.auditOnly) return false
    return mc.until && now < mc.until
  }

  // 模型维度健康（叠加模型级冷却豁免）
  function healthyForModel(e, now, reqModel) {
    if (e.disabled) return false
    if (modelCooled(e, now, reqModel)) return false
    return healthy(e, now)
  }

  // 在途上限
  function inFlightLimit(e) {
    return cfg.maxInFlight
  }

  function inFlightFull(e) {
    const limit = inFlightLimit(e)
    if (limit <= 0) return false
    return e.inFlight >= limit
  }

  // 惰性清理过期条目
  function pruneEntry(e, now) {
    for (const m of Object.keys(e.modelCooldowns)) {
      const mc = e.modelCooldowns[m]
      if (!mc.until || now >= mc.until) delete e.modelCooldowns[m]
    }
    for (const m of Object.keys(e.modelCosts)) {
      const mc = e.modelCosts[m]
      if (!mc.lastSeen || now - mc.lastSeen > MODEL_COST_TTL) delete e.modelCosts[m]
    }
  }

  // ===== 选号 =====

  // 选号：过滤 → 成本分层 → 权重预计算 → 洗牌 → 排序 → top5 → 最早到期优先 → 加权抽签
  // opts: { tried: Set<uid>, model, allowUIDs: Set<uid>（账箱子集，null/空=全池） }
  function pick(pickOpts = {}) {
    const tried = pickOpts.tried || null
    const reqModel = pickOpts.model || ''
    const allowUIDs = pickOpts.allowUIDs || null
    const now = Date.now()

    const allowOK = e => !allowUIDs || allowUIDs.has(e.uid)
    const healthyOf = reqModel ? e => allowOK(e) && healthyForModel(e, now, reqModel) : e => allowOK(e) && healthy(e, now)

    const cands = []
    for (const e of byUID.values()) {
      if (tried && tried.has(e.uid)) continue
      pruneEntry(e, now)
      if (!healthyOf(e)) continue
      if (inFlightFull(e)) continue
      cands.push(e)
    }

    if (cands.length === 0) return pickEarliestExpiry(tried, now, allowUIDs)

    // 成本分层：0=实测免费 > 1=无观测 > 2=实测收费
    let bestTier = 2
    const tierOf = new Map()
    for (const e of cands) {
      const t = costTierOf(e, reqModel, now)
      tierOf.set(e.uid, t)
      if (t.tier < bestTier) bestTier = t.tier
    }

    // 成本探索：免费层存在且有"无观测"候选时，每 costExploreMs
    // 把一次真实请求搭车改道给未知号（零新增上游请求），用真实观测替代推测
    if (cfg.costExploreMs > 0 && bestTier === 0 && reqModel) {
      const hasTier1 = cands.some(e => tierOf.get(e.uid).tier === 1)
      const key = reqModel
      const last = exploreLast.get(key) || 0
      if (hasTier1 && now - last >= cfg.costExploreMs) {
        exploreLast.set(key, now)
        bestTier = 1
        cfg.onEvent?.(`成本探索：model=${reqModel}（本次优先无观测账号）`)
      }
    }

    // 权重基准：全部 healthy 候选的积分最大值
    let maxCredits = 0
    for (const e of cands) {
      if (e.credits > maxCredits) maxCredits = e.credits
    }

    const ws = []
    for (const e of cands) {
      const t = tierOf.get(e.uid)
      if (t.tier !== bestTier) continue
      ws.push({ e, w: weightOf(e, maxCredits, now), cost1k: t.cost1k })
    }

    // 等权重洗牌（避免字典序截断导致 uid 靠后的账号永不入 top5）
    if (ws.length > 5 && ws.slice(1).some(x => x.w === ws[0].w)) {
      shuffle(ws, now)
    }

    // 排序：成本升序 → 权重降序 → uid 升序
    ws.sort((a, b) => {
      if (a.cost1k !== b.cost1k) return a.cost1k - b.cost1k
      if (a.w !== b.w) return b.w - a.w
      return a.e.uid < b.e.uid ? -1 : 1
    })

    const candsAll = ws.map(x => x.e)
    const shortlist = candsAll.slice(0, 5)

    let picked = null

    // 最早到期优先
    if (cfg.preferExpiring) {
      const priority = candsAll.filter(
        c =>
          c.creditsExpiring > 0 &&
          c.creditsEarliestRemaining > 0 &&
          c.creditsEarliestExpiry &&
          c.creditsEarliestExpiry > now
      )
      priority.sort((a, b) => {
        if (a.creditsEarliestExpiry !== b.creditsEarliestExpiry) return a.creditsEarliestExpiry - b.creditsEarliestExpiry
        if (a.creditsEarliestRemaining !== b.creditsEarliestRemaining) return b.creditsEarliestRemaining - a.creditsEarliestRemaining
        return a.uid < b.uid ? -1 : 1
      })
      for (const c of priority) {
        if (now - c.lastUsed >= cfg.minPickGapMs) {
          picked = c
          break
        }
      }
      if (!picked && priority.length > 0) picked = priority[0]
    }

    if (!picked) {
      const eligible = shortlist.filter(c => now - c.lastUsed >= cfg.minPickGapMs)
      if (eligible.length === 0) {
        // top5 全部刚用过：LRU 兜底（usedSeq 最小者）
        picked = candsAll[0]
        for (const c of candsAll.slice(1)) {
          if (c.usedSeq < picked.usedSeq) picked = c
        }
      } else {
        picked = pickWeighted(eligible, now)
      }
    }

    if (!picked) return null
    picked.lastUsed = now
    pickSeq++
    picked.usedSeq = pickSeq
    return picked.auth
  }

  // 加权抽签（定点放大 1e6）
  function pickWeighted(cands, now) {
    let maxCredits = 0
    for (const e of cands) {
      if (e.credits > maxCredits) maxCredits = e.credits
    }
    const SCALE = 1000000
    const weights = cands.map(e => Math.trunc(weightOf(e, maxCredits, now) * SCALE))
    let total = 0
    for (const w of weights) total += w
    if (total <= 0) return cands[Math.floor(Math.random() * cands.length)]
    const r = Math.floor(Math.random() * total)
    let acc = 0
    for (let i = 0; i < cands.length; i++) {
      acc += weights[i]
      if (r < acc) return cands[i]
    }
    return cands[cands.length - 1]
  }

  // 权重：1.0 + (credits/maxCredits)*10 + 闲置补偿（封顶）
  function weightOf(e, maxCredits, now) {
    let w = 1.0
    if (maxCredits > 0) w += (e.credits / maxCredits) * 10
    let idleWeight
    if (!e.lastUsed) {
      idleWeight = cfg.idleWeightMax // 从未使用给满分
    } else {
      const hours = Math.max(0, (now - e.lastUsed) / 3600000)
      idleWeight = Math.min(hours * cfg.idleWeightPerHour, cfg.idleWeightMax)
    }
    return w + idleWeight
  }

  // 成本分层判定
  function costTierOf(e, reqModel, now) {
    if (!reqModel) return { tier: 1, cost1k: 0 }
    const mc = e.modelCosts[reqModel]
    if (!mc || !mc.lastSeen || now - mc.lastSeen > MODEL_COST_TTL) return { tier: 1, cost1k: 0 }
    if (mc.costPer1k <= 0) return { tier: 0, cost1k: 0 }
    return { tier: 2, cost1k: mc.costPer1k }
  }

  // Fisher-Yates 洗牌（time-seeded）
  function shuffle(arr, seed) {
    let s = seed % 2147483647
    if (s <= 0) s += 2147483646
    const rand = () => {
      s = (s * 16807) % 2147483647
      return (s - 1) / 2147483646
    }
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
  }

  // 全冷却兜底：取最早到期者（排除禁用与余额耗尽号，遵守账箱子集）
  function pickEarliestExpiry(tried, now, allowUIDs) {
    let best = null
    for (const e of byUID.values()) {
      if (tried && tried.has(e.uid)) continue
      if (allowUIDs && !allowUIDs.has(e.uid)) continue
      if (e.disabled) continue
      if (e.coolKind === COOL_HARD && e.until && now < e.until) continue // 余额耗尽号不兜底
      if (inFlightFull(e)) continue
      const exp = expiryOf(e, now)
      if (!exp) continue
      if (!best || exp < expiryOf(best, now)) best = e
    }
    if (!best) return null
    best.lastUsed = now
    pickSeq++
    best.usedSeq = pickSeq
    return best.auth
  }

  // 三截止中仍在未来者的最早时刻
  function expiryOf(e, now) {
    const list = [e.until, e.breakerUntil, e.degradeUntil].filter(t => t && now < t)
    if (list.length === 0) return 0
    return Math.min(...list)
  }

  // ===== 在途租约 =====

  // 获取在途租约（占满拒绝）
  function acquire(uid) {
    const e = byUID.get(uid)
    if (!e) return false
    const limit = inFlightLimit(e)
    if (limit <= 0) {
      e.inFlight++
      return true
    }
    if (e.inFlight >= limit) return false
    e.inFlight++
    return true
  }

  // 释放在途租约（幂等）
  function release(uid) {
    const e = byUID.get(uid)
    if (!e) return
    if (e.inFlight > 0) e.inFlight--
  }

  // ===== 冷却 / 熔断 / 降权 =====

  // 固定时长账号级冷却
  function cooldown(uid, kind, durationMs, reason) {
    const e = byUID.get(uid)
    if (!e) return
    e.until = Date.now() + durationMs
    e.coolKind = kind
    e.reason = reason || ''
    clearRoutingModelCooldowns(e)
    dirty = true
  }

  // 余额不足：冷却到次日 04:00（本地时区）
  function cooldownUntilTomorrow4AM(uid, reason) {
    cooldown(uid, COOL_HARD, nextDay4AM(Date.now()) - Date.now(), reason)
  }

  // 计算下一个 04:00：当天 04:00 之前返回当天（等当天签到恢复）
  function nextDay4AM(nowMs) {
    const d = new Date(nowMs)
    const today4 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0).getTime()
    if (d.getHours() < 4) return today4
    return today4 + 24 * 3600 * 1000
  }

  // 账号级软冷却（重置墙钟 / 有界指数退避）
  function cooldownSoftRate(uid, baseMs, resetAtMs, reason) {
    const e = byUID.get(uid)
    if (!e) return
    const now = Date.now()
    if (resetAtMs) {
      e.until = cappedSoftUntil(now, resetAtMs)
    } else if (e.coolKind !== COOL_SOFT || now >= e.until) {
      const d = softDuration(baseMs, e.softStreak + 1)
      e.softStreak++
      e.until = now + d
    }
    // 已在软冷却中的兜底探测：不推进 streak、不延长 until
    e.coolKind = COOL_SOFT
    e.reason = reason || ''
    clearRoutingModelCooldowns(e)
    dirty = true
  }

  // 模型级软冷却（6004）：有重置墙钟时写模型级独立冷却（切模型豁免）
  function cooldownSoftForModel(uid, baseMs, resetAtMs, model, reason) {
    const e = byUID.get(uid)
    if (!e) return
    if (!model) return cooldownSoftRate(uid, baseMs, resetAtMs, reason)
    const now = Date.now()
    if (resetAtMs) {
      e.modelCooldowns[model] = {
        until: cappedSoftUntil(now, resetAtMs),
        resetAt: resetAtMs,
        reason: reason || ''
      }
    } else {
      if (e.coolKind !== COOL_SOFT || now >= e.until) {
        const d = softDuration(baseMs, e.softStreak + 1)
        e.softStreak++
        e.until = now + d
      }
      e.coolKind = COOL_SOFT
      e.reason = reason || ''
      clearRoutingModelCooldowns(e)
    }
    dirty = true
  }

  // 6004 审计台账（无重置墙钟时，只展示不参与路由）
  function recordModelRateLimitAudit(uid, model, reason) {
    if (!uid || !model) return
    const e = byUID.get(uid)
    if (!e) return
    const now = Date.now()
    const old = e.modelCooldowns[model]
    if (old && !old.auditOnly && old.until > now) return
    let until = e.until
    if (!until || until <= now) until = now + softRateMax()
    e.modelCooldowns[model] = { until, reason: reason || '', auditOnly: true }
    dirty = true
  }

  // 11102 负缓存（该后端无此模型，指数退避）
  function blockModelBackoff(uid, model, reason) {
    if (!uid || !model) return
    const e = byUID.get(uid)
    if (!e) return
    const now = Date.now()
    const hits = (e.modelCooldowns[model]?.hits || 0) + 1
    const shift = Math.min(hits - 1, MODEL_BLOCK_SHIFT)
    let ttl = MODEL_BLOCK_BASE_TTL * 2 ** shift
    if (ttl > MODEL_BLOCK_MAX_TTL) ttl = MODEL_BLOCK_MAX_TTL
    e.modelCooldowns[model] = { until: now + ttl, reason: reason || MODEL_BLOCK_REASON, hits }
    dirty = true
  }

  // 清 11102 负缓存（不碰 6004）
  function blockModelClear(uid, model) {
    const e = byUID.get(uid)
    if (!e) return
    const mc = e.modelCooldowns[model]
    if (!mc || !String(mc.reason || '').startsWith('11102')) return
    delete e.modelCooldowns[model]
    dirty = true
  }

  // 清参与路由的模型冷却，保留审计台账
  function clearRoutingModelCooldowns(e) {
    for (const m of Object.keys(e.modelCooldowns)) {
      if (!e.modelCooldowns[m].auditOnly) delete e.modelCooldowns[m]
    }
  }

  // 软冷却封顶：min(resetAt, now + softRateMax)，已过期钳 1ms
  function cappedSoftUntil(now, resetAt) {
    const cap = now + softRateMax()
    if (resetAt > cap) return cap
    if (resetAt > now) return resetAt
    return now + 1
  }

  function softRateMax() {
    return cfg.softRateMaxMs > 0 ? cfg.softRateMaxMs : C.POOL_DEFAULTS.softRateMaxMs
  }

  // 有界指数退避：base × 2^(streak-1)，封顶 softRateMax
  function softDuration(baseMs, streak) {
    if (streak <= 1) return baseMs
    let shift = streak - 1
    if (shift > SOFT_STREAK_SHIFT_MAX) shift = SOFT_STREAK_SHIFT_MAX
    let d = baseMs * 2 ** shift
    const max = softRateMax()
    if (d > max || d <= 0) d = max
    return d
  }

  // 成功入账：清熔断/降权/软冷却计数（不动 until）
  function noteSuccess(uid) {
    const e = byUID.get(uid)
    if (!e) return
    const now = Date.now()
    e.successCount++
    e.lastSuccess = now
    e.fails = 0
    e.retryCount = 0
    e.breakerUntil = 0
    e.softStreak = 0
    e.sessionDeadFails = 0
    e.consecutiveFails = 0
    e.degradeUntil = 0
    dirty = true
  }

  // 失败入账（5xx）：喂熔断器
  function noteError(uid) {
    const e = byUID.get(uid)
    if (!e) return
    e.errTotal++
    e.lastErr = Date.now()
    e.fails++
    if (e.fails < cfg.breakerThreshold) {
      dirty = true
      return
    }
    let d = cfg.breakerCooldownMs
    for (let i = 0; i < e.retryCount; i++) {
      d *= 2
      if (d >= cfg.breakerCooldownMaxMs) {
        d = cfg.breakerCooldownMaxMs
        break
      }
    }
    e.fails = 0
    e.retryCount++
    e.breakerUntil = Date.now() + d
    dirty = true
  }

  // 连败降权（未知失败）：达阈临时出池
  function noteFailures(uid) {
    const e = byUID.get(uid)
    if (!e) return
    e.consecutiveFails++
    if (e.consecutiveFails < cfg.degradeThreshold) {
      dirty = true
      return
    }
    e.consecutiveFails = 0
    const now = Date.now()
    if (e.degradeUntil && now < e.degradeUntil) {
      dirty = true
      return
    }
    e.degradeUntil = now + Math.min(cfg.degradeCooldownMs, cfg.degradeCooldownMaxMs)
    dirty = true
  }

  // 12153 计数：连续达阈值返回 true（调用方据此禁用）
  function noteSessionDead(uid) {
    const e = byUID.get(uid)
    if (!e) return false
    e.sessionDeadFails++
    dirty = true
    if (e.sessionDeadFails >= SESSION_DEAD_THRESHOLD) {
      e.sessionDeadFails = 0
      return true
    }
    return false
  }

  // 清 12153 计数（刷新成功等）
  function clearSessionDead(uid) {
    const e = byUID.get(uid)
    if (e) e.sessionDeadFails = 0
  }

  // 禁用账号（更强终态：清冷却域，保留熔断观测）
  function disable(uid, reason) {
    const e = byUID.get(uid)
    if (!e) return
    e.until = 0
    e.coolKind = 0
    e.softStreak = 0
    e.modelCooldowns = {}
    e.disabled = true
    e.disabledAt = Date.now()
    e.reason = reason || ''
    dirty = true
  }

  // 人工复活（清全部惩罚状态）
  function revive(uid) {
    const e = byUID.get(uid)
    if (!e) return false
    e.disabled = false
    e.disabledAt = 0
    e.until = 0
    e.coolKind = 0
    e.reason = ''
    e.softStreak = 0
    e.modelCooldowns = {}
    e.sessionDeadFails = 0
    e.fails = 0
    e.retryCount = 0
    e.breakerUntil = 0
    e.consecutiveFails = 0
    e.degradeUntil = 0
    dirty = true
    return true
  }

  // 只清禁用（人工重新登录口径）
  function reviveDisabled(uid) {
    const e = byUID.get(uid)
    if (!e || !e.disabled) return false
    e.disabled = false
    e.disabledAt = 0
    e.reason = ''
    e.sessionDeadFails = 0
    dirty = true
    return true
  }

  // 写回积分明细（含快过期窗口）；快过期额度钳制在 [0, credits]
  function setCreditsDetailed(uid, credits, total, expiring, earliestExpiry, earliestRemaining) {
    const e = byUID.get(uid)
    if (!e) return
    const cr = Number(credits) || 0
    e.credits = cr
    e.creditsTotal = Number(total) || 0
    let exp = Number(expiring) || 0
    if (exp < 0) exp = 0
    if (exp > cr) exp = cr
    e.creditsExpiring = exp
    e.creditsEarliestExpiry = Number(earliestExpiry) || 0
    let er = Number(earliestRemaining) || 0
    if (er < 0) er = 0
    if (er > cr) er = cr
    e.creditsEarliestRemaining = er
    dirty = true
  }

  // 余额恢复即解冻（只清余额硬冷却，不动软冷却/熔断）
  function reenableIfCredits(uid, remain, total) {
    const e = byUID.get(uid)
    if (!e) return
    e.credits = remain
    e.creditsTotal = total
    if (remain > 0 && !e.disabled && e.coolKind === COOL_HARD) {
      e.until = 0
      e.coolKind = 0
      e.reason = ''
    }
    dirty = true
  }

  // 记录签到完成日（跨零点自然过期）+ 最近签到时刻
  function noteCheckinDone(uid) {
    const e = byUID.get(uid)
    if (!e) return
    e.lastCheckinDay = localDay(Date.now())
    e.lastCheckinAt = Date.now()
    dirty = true
  }

  // 记录保活结果（面板展示「最近保活结果与时间」）
  function noteKeepalive(uid, ok) {
    const e = byUID.get(uid)
    if (!e) return
    e.lastKeepaliveAt = Date.now()
    e.lastKeepaliveOk = !!ok
    dirty = true
  }

  // 记录账号级 token 消耗（累计 + 今日；跨天自动归零今日）
  function noteTokenUsage(uid, total) {
    const e = byUID.get(uid)
    const t = Math.trunc(Number(total) || 0)
    if (!e || t <= 0) return
    const day = localDay(Date.now())
    if (e.tokenDayKey !== day) {
      e.tokenDayKey = day
      e.tokenUsageToday = 0
    }
    e.tokenUsageToday += t
    e.tokenUsageTotal += t
    dirty = true
  }

  // 记录一次实测扣费观测（uid / model / credit / tokens）：
  // 更新该 (账号,模型) 的成本账本（EMA 平滑 alpha=0.3），并顺带扣减余额内插估计。
  // credit：本次真实扣费积分（消耗量）；tokens：本次 token 总数（<=0 不记录）
  // 返回 { ok, costPer1k, freeTierEnded }
  function noteModelCost(uid, model, credit, tokens) {
    const e = byUID.get(uid)
    const tk = Math.trunc(Number(tokens) || 0)
    if (!e || !model || tk <= 0) return { ok: false, costPer1k: 0, freeTierEnded: false }
    const cr = Number(credit) || 0
    let per1k = (cr / tk) * 1000
    if (!(per1k > 0)) per1k = 0
    // 余额内插扣减（credit=0 的免费请求不动余额；扣穿钳 0 不产生负余额）
    if (cr > 0 && e.credits > 0) {
      const d = Math.min(Math.round(cr), e.credits)
      e.credits -= d
      if (e.creditsExpiring > 0) e.creditsExpiring = Math.max(0, e.creditsExpiring - d)
      if (e.creditsEarliestRemaining > 0) {
        if (d >= e.creditsEarliestRemaining) {
          e.creditsEarliestRemaining = 0
          e.creditsEarliestExpiry = 0
        } else {
          e.creditsEarliestRemaining -= d
        }
      }
    }
    const alpha = 0.3
    const prev = e.modelCosts[model]
    let freeTierEnded = false
    if (!prev || typeof prev.costPer1k !== 'number') {
      e.modelCosts[model] = { costPer1k: per1k, lastSeen: Date.now(), samples: 1 }
    } else {
      // 免费窗口结束事件：此前 tier0（实测免费）被收费观测覆盖
      freeTierEnded = prev.costPer1k <= 0 && per1k > 0
      e.modelCosts[model] = {
        costPer1k: prev.costPer1k * (1 - alpha) + per1k * alpha,
        lastSeen: Date.now(),
        samples: (prev.samples || 0) + 1
      }
    }
    dirty = true
    return { ok: true, costPer1k: e.modelCosts[model].costPer1k, freeTierEnded }
  }

  // ===== 查询 =====

  // 单账号状态（脱敏，供面板/状态端点）
  function status(uid) {
    const e = byUID.get(uid)
    if (!e) return null
    return statusOf(e, Date.now())
  }

  // 全账号状态列表（按 uid 升序）
  function list() {
    const now = Date.now()
    return [...byUID.values()].map(e => statusOf(e, now)).sort((a, b) => (a.uid < b.uid ? -1 : 1))
  }

  // 按 uid 取完整凭证
  function authByUID(uid) {
    return byUID.get(uid)?.auth || null
  }

  // 诊断当前无候选账号的原因（供错误提示；不做任何状态变更）
  function diagnoseNoCandidate(model) {
    const now = Date.now()
    const diag = { total: 0, disabled: 0, cooling: 0, modelCooled: 0, inFlightFull: 0, healthy: 0 }
    for (const e of byUID.values()) {
      diag.total++
      if (e.disabled) {
        diag.disabled++
        continue
      }
      if (model && modelCooled(e, now, model)) {
        diag.modelCooled++
        continue
      }
      if ((e.until && now < e.until) || (e.breakerUntil && now < e.breakerUntil) || (e.degradeUntil && now < e.degradeUntil)) {
        diag.cooling++
        continue
      }
      if (inFlightFull(e)) {
        diag.inFlightFull++
        continue
      }
      diag.healthy++
    }
    return diag
  }

  // 可用 uid 列表（健康且未占满在途，uid 升序）
  // allowUIDs：账箱子集过滤（null/空 = 全池）
  function availableUIDs(model, allowUIDs) {
    const now = Date.now()
    const out = []
    for (const e of byUID.values()) {
      if (allowUIDs && !allowUIDs.has(e.uid)) continue
      pruneEntry(e, now)
      const ok = model ? healthyForModel(e, now, model) : healthy(e, now)
      if (!ok) continue
      if (inFlightFull(e)) continue
      out.push(e.uid)
    }
    return out.sort()
  }

  // 指定 uid 是否可用（模型维度 + 账箱子集）
  function pickByUID(uid, model, allowUIDs) {
    const e = byUID.get(uid)
    if (!e) return null
    if (allowUIDs && !allowUIDs.has(uid)) return null
    const now = Date.now()
    pruneEntry(e, now)
    const ok = model ? healthyForModel(e, now, model) : healthy(e, now)
    if (!ok) return null
    if (inFlightFull(e)) return null
    e.lastUsed = now
    pickSeq++
    e.usedSeq = pickSeq
    return e.auth
  }

  // 账号状态统计（总数/可用/冷却/禁用/在途占满）
  function counts() {
    const now = Date.now()
    let total = 0
    let healthyCount = 0
    let cooling = 0
    let disabled = 0
    let inFlightFullCount = 0
    for (const e of byUID.values()) {
      total++
      if (e.disabled) {
        disabled++
        continue
      }
      const coolingNow = (e.until && now < e.until) || (e.breakerUntil && now < e.breakerUntil)
      if (coolingNow) cooling++
      if (healthy(e, now)) {
        healthyCount++
        if (inFlightFull(e)) inFlightFullCount++
      }
    }
    return { total, healthy: healthyCount, cooling, disabled, inFlightFull: inFlightFullCount }
  }

  // 是否可服务（存在健康且未占满的账号）
  function servableNow() {
    return availableUIDs('').length > 0
  }

  // 是否存在健康账号（判定与 healthy() 一致：冷却/熔断/降权过期即恢复，不要求时间戳归零）
  function hasHealthy() {
    const now = Date.now()
    for (const e of byUID.values()) {
      if (healthy(e, now)) return true
    }
    return false
  }

  // 单账号状态派生
  function statusOf(e, now) {
    const cooling = (e.until && now < e.until) || (e.breakerUntil && now < e.breakerUntil)
    const laterUntil = Math.max(e.until || 0, e.breakerUntil || 0)
    const coolRemaining = cooling ? Math.ceil((laterUntil - now) / 1000) : 0
    const coolKind = e.breakerUntil && e.breakerUntil >= (e.until || 0) && now < e.breakerUntil ? 'breaker' : e.coolKind === COOL_HARD ? 'hard_credit' : 'soft_rate'

    const rateLimitedModels = []
    for (const [model, mc] of Object.entries(e.modelCooldowns)) {
      if (!mc.until || now >= mc.until) continue
      const item = {
        model,
        kind: String(mc.reason || '').startsWith('11102') ? 'model_unavailable' : 'rate_limit',
        until: mc.until
      }
      if (mc.resetAt && mc.resetAt !== mc.until) item.resetAt = mc.resetAt
      rateLimitedModels.push(item)
    }
    rateLimitedModels.sort((a, b) => (a.model < b.model ? -1 : 1))

    return {
      uid: e.uid,
      nickname: e.auth?.nickname || '',
      credits: e.credits,
      creditsTotal: e.creditsTotal,
      creditsExpiring: e.creditsExpiring,
      creditsEarliestExpiry: e.creditsEarliestExpiry,
      creditsEarliestRemaining: e.creditsEarliestRemaining,
      disabled: e.disabled,
      disabledReason: e.disabled ? e.reason : '',
      cooling: !!cooling,
      coolKind: cooling ? coolKind : '',
      coolRemaining,
      reason: e.reason || '',
      successCount: e.successCount,
      errTotal: e.errTotal,
      lastSuccess: e.lastSuccess,
      lastErr: e.lastErr,
      inFlight: e.inFlight,
      checkinDone: e.lastCheckinDay === localDay(now),
      lastCheckinAt: e.lastCheckinAt,
      lastKeepaliveAt: e.lastKeepaliveAt,
      lastKeepaliveOk: e.lastKeepaliveOk,
      tokenUsageToday: e.tokenUsageToday,
      tokenUsageTotal: e.tokenUsageTotal,
      disabledAt: e.disabledAt,
      consecutiveFails: e.consecutiveFails,
      breakerUntil: e.breakerUntil && now < e.breakerUntil ? e.breakerUntil : 0,
      breakerRemaining: e.breakerUntil && now < e.breakerUntil ? Math.ceil((e.breakerUntil - now) / 1000) : 0,
      degradeUntil: e.degradeUntil && now < e.degradeUntil ? e.degradeUntil : 0,
      rateLimitedModels
    }
  }

  // ===== 持久化 =====

  // 立即落盘（原子写：tmp + rename）
  function saveNow() {
    if (!cfg.stateFile) return
    try {
      const dir = path.dirname(cfg.stateFile)
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      const tmp = `${cfg.stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(overview(), null, 2), { mode: 0o600 })
      fs.renameSync(tmp, cfg.stateFile)
    } catch {
      /* 落盘失败静默，下个周期重试 */
    }
  }

  // 内存 → 落盘结构（惰性过滤过期条目）
  function overview() {
    const now = Date.now()
    const accounts = {}
    for (const e of byUID.values()) {
      const item = {
        credits: e.credits,
        credits_total: e.creditsTotal,
        disabled: e.disabled,
        reason: e.reason,
        until: e.until || 0,
        cool_kind: e.coolKind,
        success_count: e.successCount,
        err_total: e.errTotal,
        last_success: e.lastSuccess,
        last_err: e.lastErr,
        last_checkin_day: e.lastCheckinDay,
        soft_streak: e.softStreak,
        session_dead_fails: e.sessionDeadFails,
        consecutive_fails: e.consecutiveFails,
        credits_expiring: e.creditsExpiring,
        credits_earliest_expiry: e.creditsEarliestExpiry,
        credits_earliest_remaining: e.creditsEarliestRemaining,
        last_checkin_at: e.lastCheckinAt,
        last_keepalive_at: e.lastKeepaliveAt,
        last_keepalive_ok: e.lastKeepaliveOk,
        token_usage_total: e.tokenUsageTotal,
        token_usage_today: e.tokenUsageToday,
        token_day_key: e.tokenDayKey,
        disabled_at: e.disabledAt
      }
      if (e.breakerUntil && now < e.breakerUntil) {
        item.breaker_until = e.breakerUntil
        item.retry_count = e.retryCount
      }
      if (e.degradeUntil && now < e.degradeUntil) item.degrade_until = e.degradeUntil

      const cooldowns = {}
      for (const [m, mc] of Object.entries(e.modelCooldowns)) {
        if (!mc.until || now >= mc.until) continue
        cooldowns[m] = { until: mc.until }
        if (mc.resetAt) cooldowns[m].reset_at = mc.resetAt
        if (mc.reason) cooldowns[m].reason = mc.reason
        if (mc.auditOnly) cooldowns[m].audit_only = true
      }
      if (Object.keys(cooldowns).length) item.model_cooldowns = cooldowns

      const costs = {}
      for (const [m, mc] of Object.entries(e.modelCosts)) {
        if (!mc.lastSeen || now - mc.lastSeen > MODEL_COST_TTL) continue
        costs[m] = { cost_per_1k: mc.costPer1k, last_seen: mc.lastSeen, samples: mc.samples }
      }
      if (Object.keys(costs).length) item.model_costs = costs

      accounts[e.uid] = item
    }
    return { accounts }
  }

  // 启动加载：读 state.json 恢复状态（凭证由 syncToDir 注入）
  function load() {
    if (!cfg.stateFile) return
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'))
    } catch {
      return
    }
    if (!doc?.accounts || typeof doc.accounts !== 'object') return
    applyAccounts(doc.accounts)
  }

  // 从落盘结构恢复账号状态（惰性过滤过期项）
  function applyAccounts(accounts) {
    const now = Date.now()
    for (const [uid, s] of Object.entries(accounts)) {
      if (!s || typeof s !== 'object') continue
      const e = newEntry({ uid })
      e.credits = num(s.credits)
      e.creditsTotal = num(s.credits_total)
      e.disabled = !!s.disabled
      e.reason = str(s.reason)
      e.until = num(s.until)
      e.coolKind = num(s.cool_kind)
      e.successCount = num(s.success_count)
      e.errTotal = Math.max(num(s.err_total), num(s.err_count))
      e.lastSuccess = num(s.last_success)
      e.lastErr = num(s.last_err)
      e.lastCheckinDay = str(s.last_checkin_day)
      e.lastCheckinAt = num(s.last_checkin_at)
      e.lastKeepaliveAt = num(s.last_keepalive_at)
      e.lastKeepaliveOk = !!s.last_keepalive_ok
      e.tokenUsageTotal = num(s.token_usage_total)
      e.tokenUsageToday = num(s.token_usage_today)
      e.tokenDayKey = str(s.token_day_key)
      // 跨天恢复：今日计数归零（保留累计）
      const todayKey = localDay(now)
      if (e.tokenDayKey !== todayKey) {
        e.tokenDayKey = todayKey
        e.tokenUsageToday = 0
      }
      e.disabledAt = num(s.disabled_at)
      e.softStreak = num(s.soft_streak)
      e.sessionDeadFails = num(s.session_dead_fails)
      e.consecutiveFails = num(s.consecutive_fails)
      if (num(s.breaker_until) && now < num(s.breaker_until)) {
        e.breakerUntil = num(s.breaker_until)
        e.retryCount = num(s.retry_count)
      }
      if (num(s.degrade_until) && now < num(s.degrade_until)) e.degradeUntil = num(s.degrade_until)

      // 快过期批次清洗
      let expiring = num(s.credits_expiring)
      if (expiring < 0) expiring = 0
      if (expiring > e.credits) expiring = e.credits
      e.creditsExpiring = expiring
      const earliestExpiry = num(s.credits_earliest_expiry)
      let earliestRemaining = num(s.credits_earliest_remaining)
      if (earliestRemaining < 0 || earliestRemaining > e.credits) earliestRemaining = 0
      if (earliestRemaining === 0 || !earliestExpiry || now >= earliestExpiry) {
        e.creditsEarliestExpiry = 0
        e.creditsEarliestRemaining = 0
      } else {
        e.creditsEarliestExpiry = earliestExpiry
        e.creditsEarliestRemaining = earliestRemaining
      }

      if (s.model_cooldowns && typeof s.model_cooldowns === 'object') {
        for (const [m, mc] of Object.entries(s.model_cooldowns)) {
          if (!mc || !num(mc.until) || now >= num(mc.until)) continue
          e.modelCooldowns[m] = {
            until: num(mc.until),
            resetAt: num(mc.reset_at),
            reason: str(mc.reason),
            auditOnly: !!mc.audit_only
          }
        }
      }
      if (s.model_costs && typeof s.model_costs === 'object') {
        for (const [m, mc] of Object.entries(s.model_costs)) {
          const lastSeen = num(mc.last_seen)
          const costPer1k = Number(mc.cost_per_1k)
          if (!lastSeen || now - lastSeen > MODEL_COST_TTL || !Number.isFinite(costPer1k) || costPer1k < 0) continue
          e.modelCosts[m] = { costPer1k, lastSeen, samples: num(mc.samples) }
        }
      }

      const existing = byUID.get(uid)
      if (existing && existing.auth?.accessToken) {
        e.auth = existing.auth // 凭证已注入则保留
      }
      byUID.set(uid, e)
    }
  }

  // 启动周期落盘（5s，仅脏时写）
  function startFlusher() {
    if (flushTimer || !cfg.stateFile) return
    flushTimer = setInterval(() => {
      if (dirty) {
        dirty = false
        saveNow()
      }
    }, 5000)
    if (flushTimer.unref) flushTimer.unref()
  }

  // 停止周期落盘并做最后一次落盘
  function stopFlusher() {
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    if (dirty) {
      dirty = false
      saveNow()
    }
  }

  return {
    // 增删
    add,
    syncToDir,
    remove,
    // 选号
    pick,
    acquire,
    release,
    pickByUID,
    // 冷却
    cooldown,
    cooldownUntilTomorrow4AM,
    cooldownSoftRate,
    cooldownSoftForModel,
    recordModelRateLimitAudit,
    blockModelBackoff,
    blockModelClear,
    // 计数
    noteSuccess,
    noteError,
    noteFailures,
    noteSessionDead,
    clearSessionDead,
    noteCheckinDone,
    noteKeepalive,
    noteTokenUsage,
    noteModelCost,
    disable,
    revive,
    reviveDisabled,
    setCreditsDetailed,
    reenableIfCredits,
    // 查询
    status,
    list,
    authByUID,
    diagnoseNoCandidate,
    availableUIDs,
    counts,
    servableNow,
    hasHealthy,
    // 持久化
    load,
    saveNow,
    startFlusher,
    stopFlusher,
    // 常量
    COOL_HARD,
    COOL_SOFT,
    reason: { SESSION_DEAD_REASON, MODEL_BLOCK_REASON },
    // 配置读写（热生效）
    updateConfig(patch) {
      Object.assign(cfg, patch)
    },
    getConfig() {
      return { ...cfg }
    }
  }
}

// 本地时区 YYYY-MM-DD
function localDay(ms) {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

module.exports = { createPool, localDay, COOL_HARD, COOL_SOFT }