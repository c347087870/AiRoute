// WorkBuddy 多账号成长任务执行队列
// 语义：账号内串行（同账号任务按依赖序逐条执行）、账号间并发（并发数夹取 [1,4]，
// 默认 2）、单调 seq（每启动一轮 +1，前端只渲染自己启动的那一轮）、状态可轮询。
// 纯函数风格（无 class）；依赖全部由调用方注入。

const DEFAULT_CONCURRENCY = 2 // 默认账号间并发
const MIN_CONCURRENCY = 1 // 并发下限
const MAX_CONCURRENCY = 4 // 并发上限（有效范围 [1,4]）
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
//         log, itemTimeoutMs, skipAuth?(auth)->bool }
// skipAuth：账号级门控（如国际版无成长体系）。在**扫描前**过滤，故 uids 为空的
// 「全账号」入口（含定时 growthHook 直接调用 runQueueOnce()）同样受控——
// 只在 runtime.queueOnce 里过滤会漏掉定时触发这条路径。
function createQueue(opts = {}) {
  const pool = opts.pool || null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const scanPending = typeof opts.scanPending === 'function' ? opts.scanPending : async () => []
  const runCode = typeof opts.runCode === 'function' ? opts.runCode : async () => ({ status: 'done', message: '' })
  const itemTimeoutMs = Number(opts.itemTimeoutMs) > 0 ? Number(opts.itemTimeoutMs) : ITEM_TIMEOUT_MS
  const skipAuth = typeof opts.skipAuth === 'function' ? opts.skipAuth : () => false
  // 账号占用（与一键完成 / 补领清扫共用同一把锁）。
  // 队列按**账号整轮**持锁：清扫在队列两条任务之间抢到锁，会让后续条目被判
  // account_busy 变虚假失败。故锁必须在 runAccount 外层取、整个账号跑完后放。
  // 未注入时（测试/独立调用）退化为不加锁，语义同旧版。
  const lockAccount = typeof opts.tryLockAccount === 'function' ? opts.tryLockAccount : () => true
  const unlockAccount = typeof opts.unlockAccount === 'function' ? opts.unlockAccount : () => {}
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
  let scheduling = false // 本次 runQueueOnce 的扫描/入队阶段是否未结束
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
  // 整轮持锁：期间补领清扫 / 一键完成抢不到该账号，下一轮再补，不产生虚假失败。
  async function runAccount(entry) {
    if (!lockAccount(entry.uid)) {
      // 该账号正被一键完成 / 上一条链路占用：本轮条目标记跳过（不是失败）
      for (const it of state.items) {
        if (it.uid !== entry.uid || it.status !== 'pending') continue
        it.status = 'skipped'
        it.message = '该账号有其它任务动作在执行，跳过'
        it.finished_at = Date.now()
      }
      return
    }
    try {
      for (let i = 0; i < state.items.length; i++) {
        const it = state.items[i]
        if (it.uid !== entry.uid || it.status !== 'pending') continue
        await execItem(it, entry.auth)
      }
    } finally {
      unlockAccount(entry.uid)
    }
  }

  // 结束收尾：作业真正结束时才清 running——三个条件同时满足：
  //   1) 入队流程已结束（scheduling=false，扫描/入队期间不得算结束）
  //   2) 待执行账号清空
  //   3) 无在跑 worker
  // 这是「同一次 runQueueOnce 期间 running 恒为 true」的保证，避免前端轮询在扫描
  // 尚未结束的窗口内误判结束、也避免窗口内二次 runQueueOnce 抹掉进行中的条目
  function finish() {
    if (scheduling || active || waiting.length > 0) return
    // 兜底：作业未真正结束过。kick() 的收尾与 runQueueOnce 的 finally 可能交错
    // （例如 waiting 空导致 kick 直接 finish，随后 finally 的 finish 因 scheduling
    // 尚未落下而提前返回），漏掉这次兜底会让 running 永久卡在 true、后续全部 conflict
    if (!state.running) return
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
          // 注意：queued 的释放必须在该账号执行完（finally）之后，不能在取下条目的
          // 瞬间释放——否则执行期间同账号再次入队会绕过去重，起第二个 worker 并发
          // 跑同一账号（上游 withAccountLock 会判 account_busy，条目变虚假失败）
          try {
            await runAccount(entry)
          } catch (err) {
            log(`[WorkBuddy队列] 账号 ${entry.uid} 执行异常：${err.message}`)
          } finally {
            queued.delete(entry.uid)
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
    // 先占位：扫描（数秒级网络耗时）期间再次触发直接命中上面的 running 判拒。
    // scheduling 与 running 同时置起，但只有 scheduling 会在扫描结束后落下
    // （running 要等到所有 worker 跑完，见 finish 的三条件）
    scheduling = true
    state.running = true
    state.startedAt = Date.now()
    state.finishedAt = 0
    state.items = []
    state.conc = concurrency
    state.seq += 1
    const seq = state.seq

    try {
    const filterUids = Array.isArray(uids) && uids.length > 0 ? new Set(uids.map(String)) : null
    const fixedCodes = Array.isArray(options.taskCodes) ? options.taskCodes.filter(Boolean) : []
    const states = listAccounts().filter(st => !st.disabled && (!filterUids || filterUids.has(String(st.uid))))

    let total = 0
    let skipped = 0
    for (const st of states) {
      const auth = authOf(st.uid)
      if (!auth) continue
      // 账号级门控（区域能力差异）：在扫描前拦截，避免对必然失败的端点空发请求
      if (skipAuth(auth)) {
        skipped++
        continue
      }
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
      state.startedAt = 0
      return {
        started: false,
        seq,
        total: 0,
        skipped,
        message: skipped > 0 ? `没有可执行账号（已跳过 ${skipped} 个不适用账号）` : '全部账号没有待办任务'
      }
    }
    log(`[WorkBuddy队列] 已入队 ${total} 项（并发 ${concurrency}${skipped ? `，跳过 ${skipped} 个不适用账号` : ''}）`)
    return { started: true, total, seq, conc: concurrency, skipped }
    } finally {
      // 扫描/入队阶段结束：此后 running 的归属完全由 worker 决定（见 finish）
      scheduling = false
      finish()
    }
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