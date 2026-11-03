// 本地构建与自替换安装：只通过 Electron IPC 暴露
// 构建在源码目录执行 scripts/build.js --mac，产物落在 <project>/app/dist-electron
// 安装由 detached helper 在当前 App 退出后替换 .app，随后重新打开
const { app, BrowserWindow, ipcMain, shell } = require('electron')
const fs = require('fs-extra')
const path = require('path')
const { spawn } = require('child_process')
const devConfig = require('./dev-config')

const isMac = process.platform === 'darwin'
const BUILD_TIMEOUT = 30 * 60 * 1000
const LOG_LIMIT = 1200

let currentBuild = null
let lastResult = null
// 页面重新挂载或刷新后可以回放大段日志，避免只看到后半段
let logBuffer = []

function cleanMessage(err) {
  return String((err && err.message) || err || '')
    .split('\n')
    .filter(line => !/^\s*at\s/.test(line))
    .join(' ')
    .trim()
}

function getBuildStatePath() {
  return path.join(devConfig.getDataDir(), 'dev-build.json')
}

function readBuildState() {
  try {
    const state = fs.readJsonSync(getBuildStatePath())
    if (!state || typeof state !== 'object') return null
    return state
  } catch {
    return null
  }
}

function writeBuildState(state) {
  fs.ensureDirSync(devConfig.getDataDir())
  fs.writeJsonSync(getBuildStatePath(), state, { spaces: 2 })
}

function resolveAppBundle() {
  if (!app.isPackaged || !isMac) return ''
  const exe = app.getPath('exe')
  // /Applications/AiRoute.app/Contents/MacOS/AiRoute -> /Applications/AiRoute.app
  const bundle = path.resolve(exe, '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : ''
}

function send(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {}
  }
}

function log(line, stream = 'stdout') {
  const text = String(line).replace(/\r\n/g, '\n')
  const entry = { line: text, stream, at: Date.now() }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT)
  send('dev-build:log', entry)
}

function getLogs() {
  return logBuffer.slice()
}

function clearLogs() {
  logBuffer = []
}

function setStatus(patch) {
  const status = getStatus()
  send('dev-build:status', { ...status, ...patch })
}

function getStatus() {
  return {
    running: !!currentBuild,
    // 失败/取消时 finishBuild 传入的 stage 会经 setStatus 广播，但这里重算会退回 'done'；
    // 由上次结果的 ok 决定终态，前端才能区分「完成」与「失败」
    stage: currentBuild ? currentBuild.stage : lastResult ? (lastResult.ok ? 'done' : 'failed') : 'idle',
    version: currentBuild ? currentBuild.version : '',
    startedAt: currentBuild ? currentBuild.startedAt : 0,
    lastResult
  }
}

function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''))
  if (!m) return ''
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

function findPackedApp(projectDir) {
  const outDir = path.join(projectDir, 'app', 'dist-electron')
  if (!fs.existsSync(outDir)) return ''
  const stack = [outDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith('.app')) {
        if (fs.existsSync(path.join(full, 'Contents', 'Resources', 'app.asar'))) return full
        continue
      }
      if (path.dirname(full) === outDir) stack.push(full)
    }
  }
  return ''
}

function readProjectVersion(projectDir) {
  try {
    const pkg = fs.readJsonSync(path.join(projectDir, 'package.json'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

function writeProjectVersion(projectDir, version) {
  const pkgPath = path.join(projectDir, 'package.json')
  const pkg = fs.readJsonSync(pkgPath)
  pkg.version = version
  fs.writeJsonSync(pkgPath, pkg, { spaces: 2 })
}

function invalidateUpdateCache() {
  // 打包后主进程在 app/main 下，server 被映射到 app/server；
  // 开发态源码根目录下则是 server/。两条路径都试，避免缓存失效静默失败
  for (const spec of ['../server/update', '../../server/update']) {
    try {
      const update = require(spec)
      if (update && typeof update.invalidateCache === 'function') {
        update.invalidateCache()
        return
      }
    } catch {}
  }
}

function finishBuild(result) {
  lastResult = result
  if (currentBuild) currentBuild = null
  send('dev-build:status', { ...getStatus(), stage: result.ok ? 'done' : 'failed' })
  send('dev-build:done', result)
}

function cancelBuild() {
  if (!currentBuild || !currentBuild.child) return { ok: false, error: '当前没有进行中的构建' }
  try {
    currentBuild.child.kill('SIGTERM')
  } catch {}
  return { ok: true }
}

async function startBuild(event, opts) {
  if (currentBuild) return { ok: false, error: '已有构建正在进行' }

  const project = devConfig.getProjectReport()
  if (!project.exists) return { ok: false, error: '请先选择 AiRoute 项目目录' }
  if (!project.packageJson) return { ok: false, error: '项目目录缺少 package.json' }
  if (!project.buildScript) return { ok: false, error: '项目目录缺少 scripts/build.js' }
  if (!project.nodeModules) return { ok: false, error: '项目缺少 node_modules，请先在终端执行 npm install' }

  const nodes = await devConfig.detectNodes()
  if (!nodes.node22) return { ok: false, error: '未检测到 Node.js 22+，无法构建 Electron 42' }

  const bump = !opts || opts.bump !== false
  const oldVersion = readProjectVersion(project.dir)
  if (!oldVersion) return { ok: false, error: '无法读取项目版本号' }
  const version = bump ? bumpPatch(oldVersion) : oldVersion
  if (!version) return { ok: false, error: `版本号格式不支持自动递增: ${oldVersion}` }

  const startedAt = Date.now()
  clearLogs()
  currentBuild = {
    stage: 'prepare',
    version,
    oldVersion,
    bumped: bump,
    startedAt,
    projectDir: project.dir,
    child: null
  }
  setStatus({ stage: 'prepare' })

  if (bump) {
    try {
      writeProjectVersion(project.dir, version)
      log(`[dev] 版本号 ${oldVersion} → ${version}`)
    } catch (err) {
      finishBuild({ ok: false, error: `写入版本号失败: ${cleanMessage(err)}`, version: oldVersion, at: Date.now() })
      return { ok: false, error: cleanMessage(err) }
    }
  }

  const env = devConfig.terminalEnv(project.dir, nodes.node22.bin)
  env.AIROUTE_BUILD_NO_KILL = '1'
  env.AIROUTE_DEV_BUILD = '1'
  env.ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/'
  env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

  log(`[dev] 开始构建 v${version}（Node ${nodes.node22.version}）`)
  setStatus({ stage: 'build' })

  let child
  try {
    // 直接用检测到的 Node 22 执行构建，避免 Electron 内置 Node 与用户 npm 版本错配
    child = spawn(nodes.node22.bin, ['scripts/build.js', '--mac'], {
      cwd: project.dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    restoreVersion(project.dir, oldVersion, bump)
    finishBuild({ ok: false, error: `启动构建失败: ${cleanMessage(err)}`, version: oldVersion, at: Date.now() })
    return { ok: false, error: cleanMessage(err) }
  }

  currentBuild.child = child
  const timer = setTimeout(() => {
    if (!currentBuild || currentBuild.child !== child) return
    log('[dev] 构建超时，已终止')
    try {
      child.kill('SIGTERM')
    } catch {}
  }, BUILD_TIMEOUT)

  child.stdout.on('data', (buf) => log(buf.toString('utf8')))
  child.stderr.on('data', (buf) => log(buf.toString('utf8'), 'stderr'))
  child.on('error', (err) => {
    log(`[dev] 构建进程错误: ${cleanMessage(err)}`, 'stderr')
  })

  child.on('close', (code, signal) => {
    clearTimeout(timer)
    if (!currentBuild || currentBuild.child !== child) return

    if (code !== 0) {
      const canceled = signal === 'SIGTERM'
      restoreVersion(project.dir, oldVersion, bump)
      finishBuild({
        ok: false,
        canceled,
        error: canceled ? '构建已取消' : `构建失败（退出码 ${code}）`,
        version: oldVersion,
        at: Date.now()
      })
      return
    }

    setStatus({ stage: 'verify' })
    log('[dev] 构建完成，正在检查产物...')

    const appPath = findPackedApp(project.dir)
    const dmgPath = path.join(project.dir, 'app', 'dist-electron', `AiRoute-${version}-x64.dmg`)
    if (!appPath || !fs.existsSync(dmgPath)) {
      if (!appPath) restoreVersion(project.dir, oldVersion, bump)
      finishBuild({
        ok: false,
        error: appPath ? `未找到 dmg 产物: ${path.basename(dmgPath)}` : '未找到打包后的 .app',
        version: appPath ? version : oldVersion,
        at: Date.now()
      })
      return
    }

    const git = devConfig.gitInfo(project.dir)
    const state = {
      version,
      dmgPath,
      appPath,
      projectDir: project.dir,
      builtAt: new Date().toISOString(),
      gitCommit: git.commit,
      gitBranch: git.branch,
      gitDirty: git.dirty
    }
    try {
      writeBuildState(state)
    } catch (err) {
      log(`[dev] 写入构建记录失败: ${cleanMessage(err)}`, 'stderr')
    }
    invalidateUpdateCache()
    log(`[dev] 产物: ${path.join('app/dist-electron', path.basename(dmgPath))}`)
    log(`[dev] 已写入本地构建记录，可在「设置 → 关于与更新」检查更新并安装`)
    finishBuild({ ok: true, ...state, at: Date.now() })
  })

  return { ok: true, version, startedAt }
}

function restoreVersion(projectDir, oldVersion, bumped) {
  if (!bumped) return
  try {
    writeProjectVersion(projectDir, oldVersion)
    log(`[dev] 构建失败，版本号已还原为 ${oldVersion}`)
  } catch (err) {
    log(`[dev] 还原版本号失败: ${cleanMessage(err)}`, 'stderr')
  }
}

// ==================== 安装 ====================

function quoteArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

const INSTALL_HELPER = String.raw`#!/usr/bin/env node
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    out[key.slice(2)] = argv[i + 1]
    i++
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const target = args.target
const sourceApp = args['source-app']
const sourceDmg = args['source-dmg']
const waitPid = Number(args['wait-pid'] || 0)
const logFile = args.log
const dataDir = args['data-dir'] || ''

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line + '\n'
  try {
    if (dataDir) fs.mkdirSync(dataDir, { recursive: true })
    if (logFile) fs.appendFileSync(logFile, text)
  } catch {}
}

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function waitForExit(pid) {
  if (!pid) return
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    sleep(200)
  }
  log('等待旧进程退出超时，继续安装')
  return false
}

function run(cmd, args, options) {
  log('$ ' + cmd + ' ' + args.join(' '))
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...options })
}

// open 只接受绝对路径：Electron 打包后 PATH 常常不含 /usr/bin，
// 之前用裸 'open' 会直接抛错，表现为「装好了但没自动打开」
const OPEN_BIN = '/usr/bin/open'

function openApp(target) {
  let lastError = null
  // 给 LaunchServices 一点时间感知新 bundle，否则刚替换完立刻 open 可能命中旧记录
  sleep(500)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run(OPEN_BIN, [target], { stdio: 'ignore' })
      log('已打开应用: ' + target)
      return true
    } catch (err) {
      lastError = err
      log('打开应用失败（第 ' + attempt + ' 次）: ' + String((err && err.message) || err))
      sleep(800 * attempt)
    }
  }
  // 兜底：直接执行 bundle 内的可执行文件，绕过 LaunchServices
  try {
    const bin = path.join(target, 'Contents', 'MacOS', path.basename(target, '.app'))
    if (exists(bin)) {
      const { spawn } = require('child_process')
      spawn(bin, [], { detached: true, stdio: 'ignore' }).unref()
      log('已通过可执行文件启动: ' + bin)
      return true
    }
  } catch (err) {
    log('兜底启动失败: ' + String((err && err.message) || err))
  }
  log('自动打开应用失败: ' + String((lastError && lastError.message) || lastError))
  return false
}

function findAppInDmg(mountPoint) {
  const entries = fs.readdirSync(mountPoint, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) {
      return path.join(mountPoint, entry.name)
    }
  }
  return ''
}

function main() {
  if (!target || !target.endsWith('.app')) throw new Error('安装目标无效: ' + target)
  log('等待当前应用退出（pid ' + waitPid + '）')
  waitForExit(waitPid)

  let source = sourceApp
  let mounted = ''
  if (!source || !exists(source)) {
    if (!sourceDmg || !exists(sourceDmg)) throw new Error('构建产物不存在，无法安装')
    mounted = fs.mkdtempSync(path.join(os.tmpdir(), 'airoute-dmg-'))
    log('挂载 dmg: ' + sourceDmg)
    run('hdiutil', ['attach', sourceDmg, '-nobrowse', '-readonly', '-mountpoint', mounted])
    source = findAppInDmg(mounted)
    if (!source) throw new Error('dmg 内未找到 .app')
  }

  const stamp = Date.now()
  const staging = target + '.incoming-' + stamp
  const backup = target + '.backup-' + stamp
  let hadOld = exists(target)

  try {
    log('复制新版本到暂存目录: ' + staging)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.cpSync(source, staging, { recursive: true, force: true, verbatimSymlinks: true })

    if (hadOld) {
      log('备份旧版本: ' + backup)
      fs.rmSync(backup, { recursive: true, force: true })
      fs.renameSync(target, backup)
    }
    try {
      fs.renameSync(staging, target)
    } catch (err) {
      if (hadOld) {
        try { fs.renameSync(backup, target) } catch {}
      }
      throw err
    }
    log('已替换安装: ' + target)

    try {
      run('codesign', ['--force', '--deep', '--sign', '-', target])
    } catch (err) {
      log('ad-hoc 签名失败（继续）: ' + String(err.message || err))
    }
    try { run('xattr', ['-cr', target]) } catch (err) { log('清理扩展属性失败: ' + String(err.message || err)) }
    if (hadOld) fs.rmSync(backup, { recursive: true, force: true })
    log('安装完成，正在重新打开应用')
    // 打开失败不影响安装结果：应用已经替换成功，用户手动启动即可
    openApp(target)
  } catch (err) {
    log('安装失败: ' + String((err && err.stack) || err))
    if (exists(backup) && !exists(target)) {
      try {
        fs.renameSync(backup, target)
        log('已回滚到旧版本')
      } catch (rollbackErr) {
        log('回滚失败: ' + String(rollbackErr.message || rollbackErr))
      }
    }
    process.exitCode = 1
  } finally {
    if (mounted) {
      try { run('hdiutil', ['detach', mounted, '-quiet', '-force']) } catch {}
      try { fs.rmSync(mounted, { recursive: true, force: true }) } catch {}
    }
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch {}
  }
}

try {
  main()
} catch (err) {
  log('安装 helper 异常: ' + String((err && err.stack) || err))
  process.exitCode = 1
}
`

function ensureInstallHelper() {
  const dataDir = devConfig.getDataDir()
  fs.ensureDirSync(dataDir)
  const helperPath = path.join(dataDir, 'dev-install-helper.js')
  fs.writeFileSync(helperPath, INSTALL_HELPER, { mode: 0o755 })
  fs.chmodSync(helperPath, 0o755)
  return helperPath
}

function installFromState() {
  if (!isMac) return { ok: false, error: '仅 macOS 支持应用内安装' }
  if (!app.isPackaged) return { ok: false, error: '开发模式下不执行覆盖安装，请直接重启 npm run dev' }

  const state = readBuildState()
  if (!state) return { ok: false, error: '没有可安装的本地构建，请先构建' }
  const sourceApp = state.appPath && fs.existsSync(state.appPath) ? state.appPath : ''
  const sourceDmg = state.dmgPath && fs.existsSync(state.dmgPath) ? state.dmgPath : ''
  if (!sourceApp && !sourceDmg) return { ok: false, error: '构建产物已被删除，请重新构建' }

  // 安装到当前运行的应用自身位置（/Applications 或其他任意目录），
  // 不硬编码路径，避免把用户自定义安装位置的 App 复制到别处
  const target = resolveAppBundle()
  if (!target) return { ok: false, error: '无法定位当前应用，不能覆盖安装' }

  const helperPath = ensureInstallHelper()
  const logPath = path.join(devConfig.getDataDir(), 'dev-install.log')
  try {
    fs.writeFileSync(logPath, '', 'utf8')
  } catch {}

  const args = [
    helperPath,
    '--target', target,
    '--wait-pid', String(process.pid),
    '--log', logPath,
    '--data-dir', devConfig.getDataDir()
  ]
  if (sourceApp) args.push('--source-app', sourceApp)
  if (sourceDmg) args.push('--source-dmg', sourceDmg)

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  child.unref()

  const result = {
    ok: true,
    version: state.version,
    target,
    logPath,
    restarting: true
  }

  // 给渲染进程留出展示提示与收起窗口的时间，然后退出，让 helper 完成替换
  setTimeout(() => {
    log(`[dev] 即将退出应用并安装 v${state.version}（${target}）`)
    send('dev-build:installing', result)
    app.isQuitting = true
    setTimeout(() => {
      app.quit()
      setTimeout(() => app.exit(0), 1200)
    }, 400)
  }, 200)

  return result
}

function openProject() {
  const project = devConfig.getProjectReport()
  if (!project.exists) return { ok: false, error: '项目目录不存在' }
  return shell.openPath(project.dir).then(err => (err ? { ok: false, error: err } : { ok: true }))
}

function openDmg() {
  const state = readBuildState()
  if (!state || !state.dmgPath) return { ok: false, error: '没有本地构建产物' }
  if (!fs.existsSync(state.dmgPath)) return { ok: false, error: 'dmg 已被删除' }
  shell.showItemInFolder(state.dmgPath)
  return { ok: true }
}

function register() {
  ipcMain.handle('dev-build:check', async () => {
    return {
      env: await devConfig.getEnvReport(),
      state: readBuildState(),
      status: getStatus(),
      logs: getLogs()
    }
  })
  ipcMain.handle('dev-build:choose-project', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    try {
      const report = await devConfig.chooseProjectDir(win)
      if (!report) return { ok: false, canceled: true }
      return { ok: true, env: await devConfig.getEnvReport(), state: readBuildState() }
    } catch (err) {
      return { ok: false, error: cleanMessage(err) }
    }
  })
  ipcMain.handle('dev-build:start', (event, opts) => startBuild(event, opts))
  ipcMain.handle('dev-build:cancel', () => cancelBuild())
  ipcMain.handle('dev-build:install', () => {
    try {
      return installFromState()
    } catch (err) {
      return { ok: false, error: cleanMessage(err) }
    }
  })
  ipcMain.handle('dev-build:open-project', () => openProject())
  ipcMain.handle('dev-build:open-dmg', () => openDmg())
  ipcMain.handle('dev-build:status', () => getStatus())
}

function disposeAll() {
  if (currentBuild && currentBuild.child) {
    try {
      currentBuild.child.kill('SIGTERM')
    } catch {}
  }
  currentBuild = null
}

module.exports = {
  register,
  disposeAll,
  getStatus,
  readBuildState,
  invalidateUpdateCache
}
