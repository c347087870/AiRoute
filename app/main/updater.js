// 一键升级的 Electron 胶水层：解析安装目标 → 调安装引擎 → 写 journal → 重启应用
// 安装流程各步骤失败会由 updater-core 自动回滚；本模块负责把阶段与失败原因暴露给界面
const { app } = require('electron')
const fs = require('fs-extra')
const path = require('path')
const core = require('./updater-core')

const UPDATE_DIR = process.env.AIROUTE_UPDATE_DIR || path.join(app.getPath('userData'), 'updates')
const JOURNAL = path.join(UPDATE_DIR, 'journal.json')
const BACKUP_DIR = path.join(UPDATE_DIR, 'backup')

// 界面阶段文案：一键升级只有一个按钮，进度条下方显示当前动作
const STAGE_TEXT = {
  [core.STAGE.VERIFY]: '校验安装包 SHA-256…',
  [core.STAGE.BACKUP]: '备份当前版本…',
  [core.STAGE.REPLACE]: '替换应用（原子改名）…',
  [core.STAGE.READBACK]: '校验新版本（版本 / 签名 / 哈希）…',
  restarting: '升级完成，正在重启应用…'
}

let state = {
  supported: false,   // 当前环境是否支持一键升级（仅 macOS 打包后的 .app）
  reason: '',         // 不支持时的原因（界面直接展示）
  stage: 'idle',      // idle | verifying | backing-up | replacing | readback | restarting | error
  message: '',        // 当前阶段文案
  error: '',          // 失败原因
  rolledBack: false,  // 失败后是否已自动回滚
  from: '',           // 升级前版本
  to: '',             // 目标版本
  backup: null,       // 可回滚的备份 { version, path }
  lastResult: null    // 上次升级结果（启动时从 journal 恢复，供界面提示一次）
}
let running = false // 同一时间只允许一个升级 / 回滚任务

// 判定是否支持一键升级：必须是 macOS 打包后的 .app，且所在目录可写
function resolveTarget() {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: '一键升级目前仅支持 macOS，Windows 请使用「手动下载安装包」' }
  }
  if (!app.isPackaged) {
    return { ok: false, reason: '开发模式下不支持一键升级，请手动下载安装包' }
  }
  const exe = app.getPath('exe')
  const bundle = path.resolve(exe, '..', '..', '..')
  if (!bundle.toLowerCase().endsWith('.app') || !fs.existsSync(bundle)) {
    return { ok: false, reason: '当前不是 .app 安装形态，无法自动替换' }
  }
  // 未拖入「应用程序」时系统会从随机只读路径运行（App Translocation），替换不会生效
  if (bundle.includes('AppTranslocation')) {
    return { ok: false, reason: '应用正从临时隔离路径运行，请先把 AiRoute 拖到「应用程序」再升级' }
  }
  // 直接双击 dmg 运行：镜像卷只读，无法替换，先安装到本地
  if (bundle.startsWith('/Volumes/')) {
    return { ok: false, reason: '应用正从 dmg / 外接卷运行，请先把 AiRoute 拖到「应用程序」再升级' }
  }
  const dir = path.dirname(bundle)
  if (!core.canWriteDir(dir)) {
    return { ok: false, reason: `没有写入 ${dir} 的权限，请手动下载安装包` }
  }
  return { ok: true, target: bundle, dir, exe }
}

// 写 journal：升级前先落盘「进行中」，重启后据此判断上次结果
function writeJournal(data) {
  try {
    fs.ensureDirSync(UPDATE_DIR)
    fs.writeJsonSync(JOURNAL, { ...data, at: new Date().toISOString() }, { spaces: 2 })
  } catch (e) {
    console.warn('[aiRoute] 写入升级日志失败:', e.message)
  }
}

// 启动时读取上次升级结果：
//   目标版本 == 当前版本 → 升级成功；否则看 journal 状态判断是失败回滚还是中途被中断
function readLastResult() {
  let journal = null
  try { journal = fs.readJsonSync(JOURNAL) } catch { return null }
  if (!journal || !journal.to) return null
  const base = { from: journal.from || '', to: journal.to, at: journal.at || '', rolledBack: !!journal.rolledBack }
  if (journal.to === app.getVersion()) {
    try { fs.removeSync(JOURNAL) } catch {}
    return { ...base, ok: true }
  }
  if (journal.status === 'error') {
    return { ...base, ok: false, error: journal.error || '升级失败', rolledBack: journal.rolledBack !== false }
  }
  if (journal.status === 'installing' || journal.status === 'installed') {
    return { ...base, ok: false, error: '上次升级未完成（应用被中断）', rolledBack: true }
  }
  return null
}

// 刷新可回滚备份（只保留最近一次升级前的版本）
function refreshBackup() {
  state.backup = null
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(name => /^AiRoute-.+\.app$/.test(name))
    if (!files.length) return
    const name = files[0]
    const version = name.replace(/^AiRoute-/, '').replace(/\.app$/, '')
    if (version === app.getVersion()) return
    state.backup = { version, path: path.join(BACKUP_DIR, name) }
  } catch {}
}

// 启动清理：旧包 / 暂存目录（此时都不在运行）与已用完的安装包（保留备份）
function cleanupStale(target) {
  if (target.ok) {
    const dir = path.dirname(target.target)
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith(core.OLD_PREFIX) && !name.startsWith(core.STAGE_PREFIX)) continue
        try { fs.removeSync(path.join(dir, name)) } catch {}
      }
    } catch {}
  }
  try {
    for (const name of fs.readdirSync(UPDATE_DIR)) {
      if (name === 'backup') continue
      try { fs.removeSync(path.join(UPDATE_DIR, name)) } catch {}
    }
  } catch {}
}

// 启动初始化：必须在 app.whenReady 之后调用（依赖 userData 与 app.getVersion）
function init() {
  state.from = app.getVersion()
  const target = resolveTarget()
  state.supported = target.ok
  state.reason = target.ok ? '' : target.reason
  // 不支持自动替换的环境（开发模式 / Windows）不碰更新目录，避免留下无用文件
  if (!target.ok) return getStatus()
  fs.ensureDirSync(UPDATE_DIR)
  state.lastResult = readLastResult()
  refreshBackup()
  cleanupStale(target)
  return getStatus()
}

function setState(patch) {
  state = { ...state, ...patch }
}

function getStatus() {
  return { ...state, updateDir: UPDATE_DIR }
}

// 启动安装任务（异步执行，进度通过 getStatus 轮询）
function startInstall(payload) {
  if (running) throw new Error('已有升级任务进行中')
  const target = resolveTarget()
  if (!target.ok) throw new Error(target.reason)

  const { artifactPath, sha256, version } = payload || {}
  if (!artifactPath || !sha256 || !version) throw new Error('缺少安装包信息')
  if (!core.isInside(UPDATE_DIR, artifactPath)) throw new Error('安装包路径非法')
  if (path.extname(artifactPath).toLowerCase() !== '.dmg') throw new Error('安装包格式不正确')
  if (!fs.existsSync(artifactPath)) throw new Error('安装包不存在，请重新下载')

  running = true
  const from = app.getVersion()
  setState({
    stage: core.STAGE.VERIFY,
    message: STAGE_TEXT[core.STAGE.VERIFY],
    error: '',
    rolledBack: false,
    from,
    to: version
  })
  writeJournal({ status: 'installing', stage: core.STAGE.VERIFY, from, to: version, artifactPath, sha256 })
  installAsync({ target: target.target, artifactPath, sha256, version, from }).catch(() => {})
  return getStatus()
}

async function installAsync({ target, artifactPath, sha256, version, from }) {
  const onStage = stage => {
    setState({ stage, message: STAGE_TEXT[stage] || '' })
    writeJournal({ status: 'installing', stage, from, to: version, artifactPath, sha256 })
  }
  try {
    const result = await core.applyUpdate({
      target,
      artifactPath,
      sha256,
      version,
      fromVersion: from,
      updateDir: UPDATE_DIR,
      onStage,
      log: line => console.log('[aiRoute] 更新:', line)
    })
    writeJournal({ status: 'installed', from, to: version, backup: result.backup })
    setState({
      stage: 'restarting',
      message: STAGE_TEXT.restarting,
      backup: { version: from, path: result.backup }
    })
    running = false
    scheduleRelaunch()
  } catch (e) {
    running = false
    const message = e.message || '升级失败'
    setState({ stage: 'error', message: '', error: message, rolledBack: !!e.rolledBack })
    writeJournal({ status: 'error', from, to: version, error: message, rolledBack: !!e.rolledBack })
    console.error('[aiRoute] 升级失败:', message)
  }
}

// 手动回滚到上一版本（新版本启动异常时的人工兜底）
function startRollback() {
  if (running) throw new Error('已有升级任务进行中')
  const target = resolveTarget()
  if (!target.ok) throw new Error(target.reason)
  const backup = state.backup
  if (!backup) throw new Error('没有可回滚的备份')

  running = true
  setState({
    stage: core.STAGE.VERIFY,
    message: STAGE_TEXT[core.STAGE.VERIFY],
    error: '',
    rolledBack: false,
    to: backup.version
  })
  rollbackAsync(target.target, backup).catch(() => {})
  return getStatus()
}

async function rollbackAsync(target, backup) {
  const onStage = stage => setState({ stage, message: STAGE_TEXT[stage] || '' })
  const from = app.getVersion()
  try {
    const result = await core.rollbackToBackup({
      target,
      backup: backup.path,
      updateDir: UPDATE_DIR,
      onStage,
      log: line => console.log('[aiRoute] 更新:', line)
    })
    writeJournal({ status: 'rollback', from, to: result.version, rolledBack: true })
    setState({ stage: 'restarting', message: '回滚完成，正在重启应用…' })
    running = false
    scheduleRelaunch()
  } catch (e) {
    running = false
    const message = e.message || '回滚失败'
    setState({ stage: 'error', message: '', error: message, rolledBack: !!e.rolledBack })
    writeJournal({ status: 'error', from, to: backup.version, error: message, rolledBack: !!e.rolledBack })
  }
}

// 重启应用：Electron 无法只热重载主进程，server 与主进程同生命周期，必须整体重启。
// 此时磁盘上的 .app 已被替换，process.execPath 指向同一路径、加载的就是新版本
function scheduleRelaunch(delay = 800) {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, delay)
}

module.exports = {
  UPDATE_DIR,
  STAGE_TEXT,
  init,
  getStatus,
  startInstall,
  startRollback,
  resolveTarget
}
