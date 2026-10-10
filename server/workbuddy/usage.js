// 用量记录（按时间片分桶）：与 pool 的 token 台账不同——pool 是每账号一个累计
// 计数器、没有时间维度；本模块按 (时间片, uid, model, rate) 分桶累计，可回答
//「某小时各模型用了多少 / 积分扣了多少」，且长期保留。
//
// 保留策略（分片粒度自动降级，总量有界）：
//   - 近 USAGE_HOURLY_KEEP_HOURS 小时内：小时桶（细粒度，看尖峰）
//   - 更早：折叠为日桶，永久保留（看长期趋势）
//   - 桶数达上限时优先折叠最旧小时桶（异常流量下内存/文件仍有界）
//
// 落盘：data/usage.json，原子替换（tmp + rename）+ 防抖刷新，重启不丢。
//
// 实现约定：纯函数 + 闭包状态。

const fs = require('fs')
const path = require('path')
const C = require('./constants')

// usage.json 当前格式版本：版本 3 增加积分观测字段与模型生效倍率分区。
// 旧版本缺失字段按零值加载，旧数据不丢弃。
const FILE_VERSION = 3

// 补零两位
function pad2(n) {
  return String(n).padStart(2, '0')
}

// 小时分片键（本地时区）："h:YYYY-MM-DDTHH"
function hourScopeOf(ms) {
  const d = new Date(ms)
  return `h:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`
}

// 日分片键（本地时区）："d:YYYY-MM-DD"
function dayScopeOf(ms) {
  const d = new Date(ms)
  return `d:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// 本地日期键（YYYY-MM-DD，不带分片前缀）
function dayKeyOf(ms) {
  return dayScopeOf(ms).slice(2)
}

// 本地日 0 点时间戳（「今天 / 昨天」窗口边界）
function dayStartOf(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// 解析分片键回本地时间戳（解析失败返回 NaN）
function parseScopeMs(scope) {
  const s = String(scope || '')
  const body = s.startsWith('h:') || s.startsWith('d:') ? s.slice(2) : s
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(body)
  if (!m) return NaN
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0)).getTime()
}

// 数值归一（非法 → 0）
function numOr0(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// 桶的复合键
function bucketKeyOf(b) {
  return `${b.s}|${b.u || ''}|${b.m || ''}|${b.x || ''}`
}

// 规范化桶对象的数值字段（兼容旧版本缺字段）
function normalizeBucket(raw) {
  return {
    s: String(raw.s || ''),
    u: String(raw.u || ''),
    m: String(raw.m || ''),
    x: String(raw.x || ''),
    q: numOr0(raw.q),
    e: numOr0(raw.e),
    p: numOr0(raw.p),
    c: numOr0(raw.c),
    t: numOr0(raw.t),
    l: numOr0(raw.l),
    ln: numOr0(raw.ln),
    v: numOr0(raw.v),
    vn: numOr0(raw.vn),
    cr: numOr0(raw.cr),
    cn: numOr0(raw.cn),
    ct: numOr0(raw.ct)
  }
}

// 空聚合累加器（均值需样本数才能正确加权，故样本数也留在累加器里）
function newAcc() {
  return {
    req: 0, err: 0, pt: 0, ct: 0, tt: 0,
    latSum: 0, latN: 0, tpsSum: 0, tpsN: 0,
    cr: 0, crn: 0, crt: 0
  }
}

// 把桶累加进聚合器
function accAdd(a, b) {
  a.req += b.q
  a.err += b.e
  a.pt += b.p
  a.ct += b.c
  a.tt += b.t
  a.latSum += b.l
  a.latN += b.ln
  a.tpsSum += b.v
  a.tpsN += b.vn
  a.cr += b.cr
  a.crn += b.cn
  a.crt += b.ct
}

// 聚合器结算为对外条目
function accFinish(a) {
  return {
    req: a.req,
    err: a.err,
    pt: a.pt,
    ct: a.ct,
    tt: a.tt,
    lat_avg: a.latN > 0 ? a.latSum / a.latN : 0,
    tps_avg: a.tpsN > 0 ? a.tpsSum / a.tpsN : 0,
    cr: a.cr,
    crn: a.crn,
    crt: a.crt,
    avg_credit_per_1m: a.crt > 0 ? (a.cr / a.crt) * 1000000 : 0
  }
}

// 归一窗口小时数：默认 USAGE_HOURS_DEFAULT；<=0 → 全历史(0)；>上限 → 上限
// 字符串窗口透传：'today'（今天 0 点起）/ 'yesterday'（昨天整段）
function normHours(hours) {
  if (hours === 'today' || hours === 'yesterday') return hours
  if (hours === null || typeof hours === 'undefined' || hours === '') return C.USAGE_HOURS_DEFAULT
  const n = Number(hours)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.trunc(n), C.USAGE_HOURS_MAX)
}

// 创建用量记录器
// opts: { dataDir, file, now, debounceMs, hourlyKeepMs, maxBuckets }
//   - file 显式给出则优先（含空串 = 纯内存不落盘）；否则 dataDir/usage.json
//   - now：注入当前时间函数（测试用），返回毫秒
//   - hourlyKeepMs / maxBuckets：注入折叠窗口与桶上限（测试用），默认取常量
function createUsage(opts = {}) {
  const dataDir = opts.dataDir || ''
  // file 显式给出（含空串 = 纯内存不落盘）优先；未给出则回落 dataDir/usage.json
  const filePath = opts.file === null || typeof opts.file === 'undefined'
    ? dataDir
      ? path.join(dataDir, 'usage.json')
      : ''
    : String(opts.file)

  const nowFn = typeof opts.now === 'function' ? opts.now : null
  const hourlyKeepMs = Number.isFinite(opts.hourlyKeepMs) ? opts.hourlyKeepMs : C.USAGE_HOURLY_KEEP_HOURS * 3600000
  const maxBuckets = Number.isFinite(opts.maxBuckets) ? opts.maxBuckets : C.USAGE_MAX_BUCKETS
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : C.USAGE_FLUSH_MS

  // 桶表：key → 桶对象
  const buckets = new Map()
  let dirty = false
  let flushTimer = null

  // 当前时间（毫秒）
  function currentMs() {
    if (nowFn) {
      const n = Number(nowFn())
      if (Number.isFinite(n)) return n
    }
    return Date.now()
  }

  // 折叠一批小时桶为日桶（先累加再删源桶，幂等）
  function applyMoves(moves) {
    let changed = false
    for (const [fromKey, toKey] of moves) {
      const src = buckets.get(fromKey)
      if (!src) continue
      const dst = buckets.get(toKey)
      if (!dst) {
        const cp = { ...src, s: toKey.slice(0, toKey.indexOf('|')) }
        buckets.set(toKey, cp)
      } else {
        dst.q += src.q
        dst.e += src.e
        dst.p += src.p
        dst.c += src.c
        dst.t += src.t
        dst.l += src.l
        dst.ln += src.ln
        dst.v += src.v
        dst.vn += src.vn
        dst.cr += src.cr
        dst.cn += src.cn
        dst.ct += src.ct
      }
      buckets.delete(fromKey)
      changed = true
    }
    if (changed) dirty = true
  }

  // 某小时桶的日桶目标键
  function dayTargetKey(b) {
    const ts = parseScopeMs(b.s)
    if (!isNaN(ts)) return `${dayScopeOf(ts)}|${b.u}|${b.m}|${b.x}`
    // 解析失败（脏桶）：按 scope 前缀替换为日形态，避免丢失
    return `d:${b.s.slice(2)}|${b.u}|${b.m}|${b.x}`
  }

  // 找最旧的小时桶键（scope 字典序即时间序）
  function oldestHourKey() {
    let best = ''
    for (const [k, b] of buckets) {
      if (!b.s.startsWith('h:')) continue
      if (best === '' || b.s < buckets.get(best).s) best = k
    }
    return best
  }

  // 折叠：① 超出保留窗口的小时桶折日桶；② 桶数达上限时优先折叠最旧小时桶
  function rollup(nowMsInput) {
    const nowMs = Number.isFinite(nowMsInput) ? nowMsInput : currentMs()
    const cutoff = nowMs - hourlyKeepMs

    const moves = []
    for (const [k, b] of buckets) {
      if (!b.s.startsWith('h:')) continue
      const ts = parseScopeMs(b.s)
      if (!isNaN(ts) && ts >= cutoff) continue
      moves.push([k, dayTargetKey(b)])
    }
    applyMoves(moves)

    // 桶数仍超上限：继续折叠最旧的小时桶直到回到上限内
    while (buckets.size > maxBuckets) {
      const oldest = oldestHourKey()
      if (!oldest) break
      applyMoves([[oldest, dayTargetKey(buckets.get(oldest))]])
    }
  }

  // 安排一次防抖落盘
  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush(false)
    }, debounceMs)
    if (flushTimer.unref) flushTimer.unref()
  }

  // 落盘（force=true 忽略 dirty 强制写）
  function flush(force) {
    if (!filePath) return
    if (!dirty && !force) return
    const snap = {
      version: FILE_VERSION,
      saved: new Date(currentMs()).toISOString(),
      buckets: Array.from(buckets.values(), b => ({ ...b }))
    }
    dirty = false
    try {
      const dir = path.dirname(filePath)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(snap))
      fs.renameSync(tmp, filePath)
    } catch {
      /* 落盘失败静默：内存态仍生效，下次再试 */
    }
  }

  // 启动加载（文件不存在 / 损坏均静默从零开始）
  function load() {
    if (!filePath) return
    let raw
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch {
      return
    }
    let obj
    try {
      obj = JSON.parse(raw)
    } catch {
      return
    }
    const arr = Array.isArray(obj && obj.buckets) ? obj.buckets : []
    for (const item of arr) {
      if (!item || typeof item !== 'object' || !item.s) continue
      const b = normalizeBucket(item)
      buckets.set(bucketKeyOf(b), b)
    }
  }

  // 立即落盘
  function save() {
    flush(true)
  }

  // 停止后台防抖（清理定时器）
  function stop() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  // 记录一次请求尝试（ok=false 表示失败尝试，仍计入请求数与失败数）
  function record(entry) {
    const e = entry || {}
    const model = e.model || '(unknown)'
    const rate = e.rate || ''
    const uid = e.uid || ''
    const s = hourScopeOf(currentMs())
    const key = `${s}|${uid}|${model}|${rate}`

    let b = buckets.get(key)
    if (!b) {
      b = { s, u: uid, m: model, x: rate, q: 0, e: 0, p: 0, c: 0, t: 0, l: 0, ln: 0, v: 0, vn: 0, cr: 0, cn: 0, ct: 0 }
      buckets.set(key, b)
    }
    b.q++
    if (!e.ok) b.e++

    const pt = numOr0(e.pt)
    const ct = numOr0(e.ct)
    const tt = numOr0(e.tt)
    b.p += pt
    b.c += ct
    b.t += tt

    const latMs = numOr0(e.latMs)
    if (latMs > 0) {
      b.l += latMs
      b.ln++
    }
    const tps = numOr0(e.tps)
    if (tps > 0) {
      b.v += tps
      b.vn++
    }

    // 只在明确观测到 credit 时累计（hasCredit 缺失不伪造 0）；比值的分母只用
    // 同一次既有 credit 又有 token 的样本（tt 已含 pt+ct 兜底）
    if (e.hasCredit) {
      b.cr += numOr0(e.credit)
      b.cn++
      b.ct += tt
    }

    dirty = true
    if (buckets.size > maxBuckets) rollup(currentMs())
    scheduleFlush()
  }

  // 聚合所选窗口内的桶，产出面板一次拉取的全部用量视图数据
  //   hours 默认 USAGE_HOURS_DEFAULT；上限 USAGE_HOURS_MAX；0 = 全部历史（含日桶）
  //   'today' = 本地今天 0 点起；'yesterday' = 昨天 0 点 ～ 今天 0 点（整段）
  //   附带 yesterday：昨天本地日全天合计（与所选窗口无关）
  function snapshot(hoursArg) {
    const hours = normHours(hoursArg)
    const windowed = hours === 'today' || hours === 'yesterday' || hours > 0
    const nowMs = currentMs()
    const nowHour = Math.floor(nowMs / 3600000) * 3600000
    const todayStart = dayStartOf(nowMs)
    const windowFrom = hours === 'today' ? todayStart
      : hours === 'yesterday' ? dayStartOf(nowMs - 86400000)
        : nowHour - (windowed ? (hours - 1) * 3600000 : 0)
    const windowTo = hours === 'yesterday' ? todayStart : 0

    const total = newAcc()
    const acctAgg = new Map()
    const modelAgg = new Map()
    const hourSeries = new Map()
    const daySeries = new Map()
    const creditAcctAgg = new Map()
    const creditModelAgg = new Map()

    let since = ''
    let matched = 0
    // 昨天（最近一个完整自然日）全天合计：独立于窗口选择
    const yDay = dayKeyOf(nowMs - 86400000)
    const yAcc = newAcc()

    for (const b of buckets.values()) {
      if (since === '' || b.s < since) since = b.s
      const ts = parseScopeMs(b.s)
      // 昨天汇总：小时桶与日桶都按本地日期归并
      if (!isNaN(ts) && dayKeyOf(ts) === yDay) accAdd(yAcc, b)
      if (windowed) {
        // 解析失败的脏桶不进窗口聚合；昨天窗口上边界为今天 0 点（排他）
        if (isNaN(ts) || ts < windowFrom || (windowTo && ts >= windowTo)) continue
      }
      matched++
      accAdd(total, b)

      let aa = acctAgg.get(b.u)
      if (!aa) {
        aa = newAcc()
        acctAgg.set(b.u, aa)
      }
      accAdd(aa, b)

      let ma = modelAgg.get(b.m)
      if (!ma) {
        ma = newAcc()
        modelAgg.set(b.m, ma)
      }
      accAdd(ma, b)

      const isHour = b.s.startsWith('h:')
      const seriesMap = isHour ? hourSeries : daySeries
      const scopeStr = b.s.slice(2)
      let sa = seriesMap.get(scopeStr)
      if (!sa) {
        sa = newAcc()
        seriesMap.set(scopeStr, sa)
      }
      accAdd(sa, b)

      if (b.cn > 0) {
        let ca = creditAcctAgg.get(b.u)
        if (!ca) {
          ca = { req: 0, cr: 0, crn: 0, crt: 0 }
          creditAcctAgg.set(b.u, ca)
        }
        ca.req += b.q
        ca.cr += b.cr
        ca.crn += b.cn
        ca.crt += b.ct

        const modelKey = `${b.m}\u0000${b.x}`
        let cm = creditModelAgg.get(modelKey)
        if (!cm) {
          cm = { req: 0, cr: 0, crn: 0, crt: 0, model: b.m, rate: b.x }
          creditModelAgg.set(modelKey, cm)
        }
        cm.req += b.q
        cm.cr += b.cr
        cm.crn += b.cn
        cm.crt += b.ct
      }
    }

    // 维度条目排序：总量降序 → 请求数降序 → key 升序（输出稳定，前端 diff 不抖）
    const keyed = map => {
      const out = []
      for (const [k, a] of map) out.push({ key: k, ...accFinish(a) })
      out.sort((x, y) => (y.tt - x.tt) || (y.req - x.req) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      return out
    }
    const byAccount = keyed(acctAgg)

    // 时序：日点升序在前，小时点升序在后
    const series = []
    const dayKeys = Array.from(daySeries.keys()).sort()
    for (const k of dayKeys) series.push({ t: k, scope: 'day', ...accFinish(daySeries.get(k)) })
    const hourKeys = Array.from(hourSeries.keys()).sort()
    for (const k of hourKeys) series.push({ t: k, scope: 'hour', ...accFinish(hourSeries.get(k)) })

    let fileBytes = 0
    if (filePath) {
      try {
        fileBytes = fs.statSync(filePath).size
      } catch {
        fileBytes = 0
      }
    }

    return {
      totals: accFinish(total),
      yesterday: { day: yDay, ...accFinish(yAcc) },
      by_account: byAccount,
      by_model: keyed(modelAgg),
      series,
      credit_by_account: creditKeyed(creditAcctAgg),
      credit_by_model: creditModelKeyed(creditModelAgg),
      buckets: matched,
      file_bytes: fileBytes,
      since: since.replace(/^h:/, '').replace(/^d:/, '')
    }
  }

  // 积分维度（账号）：key = uid
  function creditKeyed(map) {
    const out = []
    for (const [k, a] of map) {
      out.push({
        key: k,
        req: a.req,
        cr: a.cr,
        crn: a.crn,
        crt: a.crt,
        avg_credit_per_1m: a.crt > 0 ? (a.cr / a.crt) * 1000000 : 0
      })
    }
    out.sort((x, y) => (y.cr - x.cr) || (y.crt - x.crt) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    return out
  }

  // 积分维度（模型 × 倍率）：key = 模型名，含 rate
  function creditModelKeyed(map) {
    const out = []
    for (const [, a] of map) {
      out.push({
        key: a.model,
        rate: a.rate,
        req: a.req,
        cr: a.cr,
        crn: a.crn,
        crt: a.crt,
        avg_credit_per_1m: a.crt > 0 ? (a.cr / a.crt) * 1000000 : 0
      })
    }
    out.sort((x, y) => (y.cr - x.cr) || (y.crt - x.crt) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) || (x.rate < y.rate ? -1 : x.rate > y.rate ? 1 : 0))
    return out
  }

  return { record, snapshot, save, load, stop, rollup }
}

module.exports = { createUsage }