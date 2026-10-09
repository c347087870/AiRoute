// WorkBuddy 多账号成长任务执行队列
// 翻译自参考项目 internal/panel/taskcenter.go 的执行队列部分。
// 语义：账号内串行（同账号任务按依赖序逐条执行）、账号间并发（并发数夹取 [1,4]，
// 默认 2）、单调 seq（每启动一轮 +1，前端只渲染自己启动的那一轮）、状态可轮询。
// 纯函数风格（无 class）；依赖全部由调用方注入。

const DEFAULT_CONCURRENCY = 2 // 默认账号间并发
const MIN_CONCURRENCY = 1 // 并发下限
const MAX_CONCURRENCY = 4 // 并发上限（与参考实现夹取 [1,4] 一致）
const ITEM_TIMEOUT_MS = 30 * 60 * 1000 // 单条执行安全上限（默认 30 分钟，防悬挂）

// 并发数夹取到 [1,4]；非法/未配置回落默认 2
function clampConcurrency(n) {
  const v = Math.trunc(Number(n))
  if (!Number.isFinite(v) || v < MIN_CONCURRENCY) return DEFAULT_CONCURRENCY
  if (v > MAX_CONCURRENCY) return MAX_CONCURRENCY
  return v
}

// 带超时的执行：超时以 timeout 标记的错误 reject（不阻塞队列）
function runWithTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      const e = new Error(`执行超时（>${ms}ms）`)
      e.timeout = true
      reject(e)
    }, ms)
    Promise.resolve()
      .then(fn)
      .then(
        v => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve(v)
        },
        err => {
          if (done) return
          done = true
          clearTimeout(timer)
          reject(err)
        }
      )
  })
}

// 创建执行队列
// opts: { pool, listAccounts?(), authByUID?(uid), scanPending(auth)->codes, runCode(auth, code)->{status,message},
//         log, itemTimeoutMs }
function createQueue(opts = {}) {
  const pool = opts.pool || null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const scanPending = typeof opts.scanPending === 'function' ? opts.scanPending : async () => []
  const runCode = typeof opts.runCode === 'function' ? opts.runCode : async () => ({ status: 'done', message: '' })
  const itemTimeoutMs = Number(opts.itemTimeoutMs) > 0 ? Number(opts.itemTimeoutMs) : ITEM_TIMEOUT_MS
  const listAccounts =
    typeof opts.listAccounts === 'function'
      ? opts.listAccounts
      : () => (pool && typeof pool.list === 'function' ? pool.list() : [])
  const authOf =
    typeof opts.authByUID === 'function'
      ? opts.authByUID
      : uid => (pool && typeof pool.authByUID === 'function' ? pool.authByUID(uid) : null)

  const state = { running: false, startedAt: 0, finishedAt: 0, conc: DEFAULT_CONCURRENCY, seq: 0, items: [] }
  const waiting = [] // 待执行账号 [{uid, nickname, auth}]
  const queued = new Set() // 已入待执行列表的 uid
  let active = false // 调度是否在跑（防重复调度）
  let concurrency = DEFAULT_CONCURRENCY

  // 状态快照（轮询用；深拷贝条目避免外部误改）
  function queueStatus() {
    return {
      running: state.running,
      total: state.items.length,
      conc: state.conc,
      seq: state.seq,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      items: state.items.map(it => ({ ...it }))
    }
  }

  // 单条执行：标记 running → 带超时执行 → 写回状态与耗时
  async function execItem(it, auth) {
    it.status = 'running'
    it.started_at = Date.now()
    try {
      const r = await runWithTimeout(() => runCode(auth, it.taskCode), itemTimeoutMs)
      it.status = (r && r.status) || 'done'
      it.message = (r && r.message) || ''
    } catch (err) {
      it.status = 'failed'
      it.message = err && err.message ? err.message : String(err)
    }
    it.finished_at = Date.now()
    it.elapsed_ms = it.finished_at - it.started_at
  }

  // 账号 worker：该账号条目按 index 顺序串行执行（账号内串行）
  async function runAccount(entry) {
    for (let i = 0; i < state.items.length; i++) {
      const it = state.items[i]
      if (it.uid !== entry.uid || it.status !== 'pending') continue
      await execItem(it, entry.auth)
    }
  }

  // 结束收尾：仅当待执行账号清空且无在跑调度时
  function finish() {
    if (active || waiting.length > 0) return
    state.running = false
    state.finishedAt = Date.now()
    log(`[WorkBuddy队列] 执行结束（共 ${state.items.length} 项）`)
  }

  // 调度：账号间并发受 concurrency 限制，账号内串行
  function kick() {
    if (active) return
    if (waiting.length === 0) {
      finish()
      return
    }
    active = true
    state.running = true
    if (!state.startedAt) state.startedAt = Date.now()
    void (async () => {
      const n = Math.min(concurrency, waiting.length)
      async function worker() {
        while (waiting.length > 0) {
          const entry = waiting.shift()
          queued.delete(entry.uid)
          try {
            await runAccount(entry)
          } catch (err) {
            log(`[WorkBuddy队列] 账号 ${entry.uid} 执行异常：${err.message}`)
          }
        }
      }
      const workers = []
      for (let i = 0; i < Math.max(n, 1); i++) workers.push(worker())
      await Promise.all(workers)
      active = false
      finish()
    })()
  }

  // 入队：为 uid 追加任务条目（去重同一 uid 不重复排队）；返回入队条目数
  function enqueue(uid, codes, meta = {}) {
    const list = (Array.isArray(codes) ? codes : []).filter(Boolean)
    if (!list.length) return 0
    state.items.push(
      ...list.map(code => ({
        uid,
        nickname: meta.nickname || '',
        kind: 'growth',
        taskCode: code,
        status: 'pending',
        message: '',
        started_at: 0,
        finished_at: 0,
        elapsed_ms: 0
      }))
    )
    if (!queued.has(uid)) {
      queued.add(uid)
      const auth = meta.auth || authOf(uid)
      waiting.push({ uid, nickname: meta.nickname || '', auth })
      kick()
    }
    return list.length
  }

  // 全账号（或指定 uids）扫描待办并入队执行；返回启动结果
  // { started, total, seq, conflict?, message? }
  async function runQueueOnce(uids, options = {}) {
    if (state.running) {
      return { started: false, conflict: true, seq: -1, message: '队列正在执行中（可在任务中心查看进度）' }
    }
    concurrency = clampConcurrency(options.concurrency)
    // 先占位：扫描（数秒级网络耗时）期间再次触发直接命中上面的 running 判拒
    state.running = true
    state.startedAt = Date.now()
    state.finishedAt = 0
    state.items = []
    state.conc = concurrency
    state.seq += 1
    const seq = state.seq

    const filterUids = Array.isArray(uids) && uids.length > 0 ? new Set(uids.map(String)) : null
    const fixedCodes = Array.isArray(options.taskCodes) ? options.taskCodes.filter(Boolean) : []
    const states = listAccounts().filter(st => !st.disabled && (!filterUids || filterUids.has(String(st.uid))))

    let total = 0
    for (const st of states) {
      const auth = authOf(st.uid)
      if (!auth) continue
      let codes = fixedCodes
      if (!codes.length) {
        try {
          codes = await scanPending(auth)
        } catch (err) {
          log(`[WorkBuddy队列] 扫描 ${st.uid} 待办失败：${err.message}`)
          continue
        }
      }
      if (!codes.length) continue
      total += enqueue(st.uid, codes, { nickname: st.nickname, auth })
    }

    if (total === 0) {
      state.running = false
      state.startedAt = 0
      return { started: false, seq, total: 0, message: '全部账号没有待办任务' }
    }
    log(`[WorkBuddy队列] 已入队 ${total} 项（并发 ${concurrency}）`)
    return { started: true, total, seq, conc: concurrency }
  }

  // 清空队列（测试/重置用）
  function reset() {
    state.running = false
    state.startedAt = 0
    state.finishedAt = 0
    state.seq = 0
    state.items = []
    waiting.length = 0
    queued.clear()
    active = false
  }

  return { enqueue, runQueueOnce, queueStatus, reset }
}

module.exports = {
  createQueue,
  clampConcurrency,
  runWithTimeout,
  DEFAULT_CONCURRENCY,
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
  ITEM_TIMEOUT_MS
}