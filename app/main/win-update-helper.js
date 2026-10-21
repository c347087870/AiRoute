// Windows 安装版一键升级的助手进程（主进程以 ELECTRON_RUN_AS_NODE 方式拉起，见 updater-core.applyWindowsUpdate）
// 流程：等主进程退出 → 静默运行 NSIS 安装包 → 拉起安装后的应用（失败时拉起旧版本，避免用户面前一个窗口都没有）
//
// 为什么必须是独立进程：Windows 无法在运行中替换自身 exe，安装包必须在应用退出后才能覆盖文件；
// 而「等待自己退出」只能由另一个进程完成，所以助手轮询主进程 PID 直至其消失。
//
// 参数（全部为 --key value 形式）：
//   --pid <主进程 PID> --installer <安装包路径> --exe <应用可执行文件> --journal <升级日志路径>
// 退出码：0 安装完成 / 1 安装失败（已尝试拉起旧版本） / 2 参数或安装包缺失
//
// 只依赖 node 内置模块、不 require electron：既能被离线单测 require，也能在 ELECTRON_RUN_AS_NODE 下运行
const fs = require('fs')
const { spawn } = require('child_process')

const POLL_MS = 300
const EXIT_TIMEOUT_MS = 60 * 1000
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 进程是否仍存活：ESRCH = 已退出；EPERM = 进程存在但无权限发信号（Windows 上同样视为存活）
function isProcessAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// 轮询等待进程退出；超时返回 false（调用方据此放弃升级并拉起旧版本）
async function waitForExit(pid, { aliveFn = isProcessAlive, sleepFn = sleep, timeoutMs = EXIT_TIMEOUT_MS, now = Date.now } = {}) {
  const startedAt = now()
  while (aliveFn(pid)) {
    if (now() - startedAt > timeoutMs) return false
    await sleepFn(POLL_MS)
  }
  return true
}

// 静默运行 NSIS 安装包：/S 无界面（按上次安装目录原地升级），--updated 让安装包按「升级」处理
function runInstaller(installerPath, { spawnFn = spawn, timeoutMs = INSTALL_TIMEOUT_MS, args = ['/S', '--updated'] } = {}) {
  return new Promise(resolve => {
    let settled = false
    let timer = null
    const finish = result => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawnFn(installerPath, args, { stdio: 'ignore', windowsHide: true })
    } catch (e) {
      finish({ code: -1, error: e.message || String(e) })
      return
    }
    timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: -1, error: '安装程序超时未退出' })
    }, timeoutMs)
    child.on('error', e => finish({ code: -1, error: e.message || String(e) }))
    child.on('exit', code => finish({ code: typeof code === 'number' ? code : -1 }))
  })
}

// 拉起应用（安装成功启动新版本，失败则启动旧版本）
function launchApp(exePath, { spawnFn = spawn, exists = fs.existsSync } = {}) {
  if (!exePath || !exists(exePath)) return false
  try {
    const child = spawnFn(exePath, [], { detached: true, stdio: 'ignore' })
    if (child && typeof child.unref === 'function') child.unref()
    return true
  } catch {
    return false
  }
}

// 回写升级日志：只改状态字段，保留主进程写入的 from / to / artifactPath 等
function writeJournal(file, patch) {
  if (!file) return false
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...current, ...patch, at: new Date().toISOString() }, null, 2))
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] || '').replace(/^--/, '')
    if (!key) continue
    out[key] = argv[i + 1]
  }
  return out
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    aliveFn = isProcessAlive,
    sleepFn = sleep,
    spawnFn = spawn,
    waitForExitFn = waitForExit,
    runInstallerFn = runInstaller,
    launchFn = launchApp,
    writeJournalFn = writeJournal,
    exists = fs.existsSync,
    log = line => console.log('[aiRoute] 更新助手:', line)
  } = deps
  const opts = parseArgs(argv)
  const { installer, exe: exePath, journal } = opts

  if (!installer || !exists(installer)) {
    log('缺少安装包或安装包不存在，放弃')
    return 2
  }

  if (!(await waitForExitFn(opts.pid, { aliveFn, sleepFn }))) {
    log('等待应用退出超时')
    writeJournalFn(journal, { status: 'error', error: '等待应用退出超时，升级未执行' })
    launchFn(exePath, { spawnFn, exists })
    return 1
  }

  log('应用已退出，开始静默安装')
  const result = await runInstallerFn(installer, { spawnFn })
  if (result && result.code === 0) {
    log('安装完成，正在启动新版本')
    writeJournalFn(journal, { status: 'installed' })
    launchFn(exePath, { spawnFn, exists })
    return 0
  }

  const reason = (result && (result.error || `安装程序退出码 ${result.code}`)) || '安装程序执行失败'
  log(`安装失败：${reason}`)
  writeJournalFn(journal, { status: 'error', error: `${reason}，请手动下载安装包重试` })
  launchFn(exePath, { spawnFn, exists })
  return 1
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      console.error('[aiRoute] 更新助手异常:', err && err.message)
      process.exit(1)
    })
}

module.exports = { POLL_MS, EXIT_TIMEOUT_MS, INSTALL_TIMEOUT_MS, parseArgs, isProcessAlive, waitForExit, runInstaller, launchApp, writeJournal, main }
