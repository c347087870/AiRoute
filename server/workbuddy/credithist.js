// 积分历史账本（移植自参考项目 internal/credithist/credithist.go）
//
// 为什么需要：签到 / 活跃上报 / 猫猫旅行 / 成长任务都会让余额增加，但上游只在少数
// 渠道留下可读金额；面板「用量」折算的是消耗，此前没有逐账号的余额时间线。把每次
// 真实查到的余额当观测量与上一次比对，变动即留痕，可覆盖全部获取渠道。
//
// 留痕语义（与参考实现一致）：
//   - 首次见到某 uid：只建立基线，不记流水（否则会把历史余额误报成"刚获得"）；
//   - 余额与基线相同：直接返回（不落盘）；
//   - 余额变化且 |delta| <= maxDelta：追加一条流水（正 = 获取，负 = 消耗）；
//   - 余额变化但 |delta| > maxDelta：只更新基线（上游脏数据 / 口径切换不留痕）。
//
// 落盘：<dataDir>/credit-history.json，余额快照与流水同文件——重启后基线不丢，
// 不会把"上次进程结束时的余额"当成新增。原子替换（tmp + rename），失败静默：
// 留痕是旁路观测，不能反过来影响余额刷新主流程。
//
// 实现约定：纯函数 + 闭包状态，禁止 class；中文注释。
//
// 与参考实现的有意差异：参考实现只记增加（减少属"消耗"，已有用量视图覆盖）。本
// 实现两个方向都留痕（delta 带符号），因为本面板缺的正是"什么时候变成多少"这条
// 时间线；展示层用正负号区分获取与消耗。

const fs = require('fs')
const path = require('path')

// 落盘格式版本（与 usage.json 同风格，便于将来迁移）
const FILE_VERSION = 1

// 单次变动的留痕上限（对齐参考实现的 _MAX_DELTA）：超过它基本可断定是上游脏数据
// 或口径切换（如企业版"不限量"哨兵值），只更新基线、不留痕，避免假流水污染历史
const MAX_DELTA = 1000000

// 流水条数上限（超出丢最旧）：按每日数十条估计可留数月
const MAX_ENTRIES = 2000

// 数值归一：非有限数 → null（调用方跳过该次观测）
function finiteOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 创建积分历史账本
// opts: { dataDir, file, now, maxEntries, maxDelta }
//   - file 显式给出则优先（含空串 = 纯内存不落盘）；否则 dataDir/credit-history.json
//   - now：注入当前时间函数（测试用），返回毫秒
//   - maxEntries / maxDelta：注入留痕上限（测试用），默认取模块常量
function createLedger(opts = {}) {
  const dataDir = opts.dataDir || ''
  // file 显式给出（含空串 = 纯内存不落盘）优先；未给出则回落 dataDir/credit-history.json
  const filePath = opts.file === null || typeof opts.file === 'undefined'
    ? dataDir
      ? path.join(dataDir, 'credit-history.json')
      : ''
    : String(opts.file)

  const nowFn = typeof opts.now === 'function' ? opts.now : null
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
    ? Math.trunc(opts.maxEntries)
    : MAX_ENTRIES
  const maxDelta = Number.isFinite(opts.maxDelta) && opts.maxDelta > 0
    ? Math.trunc(opts.maxDelta)
    : MAX_DELTA

  const snapshot = new Map() // uid → 最近一次观测到的余额（重启后恢复，基线不丢）
  let entries = [] // 流水（时间升序）

  // 当前时间（毫秒）
  function currentMs() {
    if (nowFn) {
      const n = Number(nowFn())
      if (Number.isFinite(n)) return n
    }
    return Date.now()
  }

  // 原子写盘（目录不存在则创建）；失败静默：旁路观测不影响主流程，下次再试
  function write() {
    if (!filePath) return
    const snap = {
      version: FILE_VERSION,
      saved: new Date(currentMs()).toISOString(),
      snapshot: Object.fromEntries(snapshot),
      entries
    }
    try {
      const dir = path.dirname(filePath)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(snap))
      fs.renameSync(tmp, filePath)
    } catch {
      /* 落盘失败静默：内存态仍生效 */
    }
  }

  // 启动加载（文件不存在 / 损坏均静默从空账本开始：丢历史好过让面板起不来）
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
    const snap = obj && obj.snapshot && typeof obj.snapshot === 'object' ? obj.snapshot : {}
    for (const [uid, v] of Object.entries(snap)) {
      const n = finiteOrNull(v)
      if (uid && n !== null) snapshot.set(String(uid), n)
    }
    const arr = Array.isArray(obj && obj.entries) ? obj.entries : []
    const restored = []
    for (const e of arr) {
      if (!e || typeof e !== 'object' || !e.uid) continue
      const delta = finiteOrNull(e.delta)
      const before = finiteOrNull(e.before)
      const after = finiteOrNull(e.after)
      if (delta === null || before === null || after === null) continue
      restored.push({
        time: String(e.time || ''),
        uid: String(e.uid),
        delta,
        before,
        after
      })
    }
    entries = restored.length > maxEntries ? restored.slice(-maxEntries) : restored
  }

  // 记录一次真实查到的余额（uid + 余额绝对值）
  //   - 首次见到该 uid：只建基线，不记流水；
  //   - 余额与基线相同：直接返回（不落盘）；
  //   - 变化且 |delta| <= maxDelta：追加流水；|delta| > maxDelta：只更新基线
  // 纯空白 uid 与空 uid 一样无效：放进去只会留下一个面板永远筛不到的幽灵基线
  function observe(uid, credits) {
    const key = String(uid === null || typeof uid === 'undefined' ? '' : uid).trim()
    if (!key) return
    const value = finiteOrNull(credits)
    if (value === null) return

    const seen = snapshot.has(key)
    const prev = seen ? snapshot.get(key) : 0
    if (seen && prev === value) return

    snapshot.set(key, value)
    if (seen) {
      const delta = value - prev
      if (delta >= -maxDelta && delta <= maxDelta) {
        entries.push({
          time: new Date(currentMs()).toISOString(),
          uid: key,
          delta,
          before: prev,
          after: value
        })
        if (entries.length > maxEntries) {
          // 丢最旧：slice 产生新数组，避免一直持有所增长数组的引用
          entries = entries.slice(-maxEntries)
        }
      }
    }
    write()
  }

  // 返回最近 limit 条流水（新的在前）；limit <= 0 或超过总条数 = 全部
  function read(limit) {
    const n = entries.length
    let take = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 0
    if (take <= 0 || take > n) take = n
    const out = []
    for (let i = n - 1; i >= n - take; i--) out.push({ ...entries[i] })
    return out
  }

  return { observe, read, load }
}

module.exports = { createLedger, MAX_DELTA, MAX_ENTRIES }
