// 开发者选项的公共能力：项目目录配置、Node / Claude / Git 等环境探测
// 说明：这些能力只通过 Electron IPC 暴露给本机渲染进程，不会注册到 HTTP 网关
const { app } = require('electron')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const { execFile, execFileSync } = require('child_process')

const isMac = process.platform === 'darwin'

function getDataDir() {
  return process.env.AIROUTE_DATA_DIR || path.join(app.getPath('userData'), 'data')
}

function getConfigPath() {
  return path.join(getDataDir(), 'dev-config.json')
}

// ==================== 项目目录 ====================

function expandHome(input) {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

function isValidDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// 只在开发态自动猜测源码目录；打包后用户可以在页面里选择任意目录
function defaultProjectCandidates() {
  const home = os.homedir()
  const list = []
  if (!app.isPackaged) list.push(path.resolve(__dirname, '..', '..'))
  list.push(
    path.join(home, 'IdeaProjects', 'AiRoute'),
    path.join(home, 'Projects', 'AiRoute'),
    path.join(home, 'Developer', 'AiRoute'),
    path.join(home, 'code', 'AiRoute'),
    path.join(home, 'Desktop', 'AiRoute'),
    path.join(home, 'Documents', 'AiRoute')
  )
  return [...new Set(list)]
}

function readSavedProjectDir() {
  try {
    const cfg = fs.readJsonSync(getConfigPath())
    return typeof cfg.projectDir === 'string' ? cfg.projectDir : ''
  } catch {
    return ''
  }
}

function inspectProject(inputDir) {
  const dir = inputDir ? path.resolve(expandHome(inputDir)) : ''
  const report = {
    dir,
    exists: false,
    packageJson: false,
    valid: false,
    buildScript: false,
    nodeModules: false,
    gitRepo: false,
    name: '',
    version: '',
    gitBranch: '',
    error: ''
  }
  if (!dir || !isValidDir(dir)) {
    report.error = '目录不存在'
    return report
  }
  report.exists = true
  const pkgPath = path.join(dir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = fs.readJsonSync(pkgPath)
      report.packageJson = true
      report.valid = true
      report.name = typeof pkg.name === 'string' ? pkg.name : ''
      report.version = typeof pkg.version === 'string' ? pkg.version : ''
    } catch (err) {
      report.error = `package.json 解析失败: ${err.message}`
    }
  } else {
    report.error = '未找到 package.json'
  }
  report.buildScript = fs.existsSync(path.join(dir, 'scripts', 'build.js'))
  report.nodeModules = isValidDir(path.join(dir, 'node_modules'))
  report.gitRepo = isValidDir(path.join(dir, '.git'))
  if (report.gitRepo) {
    try {
      report.gitBranch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {}
  }
  return report
}

function resolveProjectDir() {
  const saved = readSavedProjectDir()
  if (saved && isValidDir(expandHome(saved))) return path.resolve(expandHome(saved))
  for (const candidate of defaultProjectCandidates()) {
    if (!isValidDir(candidate)) continue
    const report = inspectProject(candidate)
    if (report.buildScript && (report.name || '').toLowerCase() === 'airoute') return candidate
  }
  return saved ? path.resolve(expandHome(saved)) : ''
}

function getProjectReport() {
  const dir = resolveProjectDir()
  const report = inspectProject(dir)
  return {
    ...report,
    canBuild: report.valid && report.buildScript,
    targetPath: isMac ? '/Applications/AiRoute.app' : ''
  }
}

function setProjectDir(inputDir) {
  const dir = path.resolve(expandHome(inputDir))
  if (!isValidDir(dir)) throw new Error('目录不存在: ' + dir)
  fs.ensureDirSync(getDataDir())
  const current = (() => {
    try {
      return fs.readJsonSync(getConfigPath())
    } catch {
      return {}
    }
  })()
  fs.writeJsonSync(getConfigPath(), { ...current, projectDir: dir }, { spaces: 2 })
  return getProjectReport()
}

async function chooseProjectDir(parentWindow) {
  const { dialog } = require('electron')
  const current = resolveProjectDir()
  const options = {
    title: '选择 AiRoute 项目目录',
    defaultPath: current || os.homedir(),
    properties: ['openDirectory', 'createDirectory']
  }
  const result = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null
  return setProjectDir(result.filePaths[0])
}

// ==================== 可执行文件探测 ====================

function versionSortDesc(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

function nvmBinDirs() {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
  try {
    return fs.readdirSync(nvmDir)
      .filter(name => /^v\d+\.\d+\.\d+$/.test(name))
      .sort(versionSortDesc)
      .map(name => path.join(nvmDir, name, 'bin'))
      .filter(isValidDir)
  } catch {
    return []
  }
}

// 从 Finder 启动的 App 只有极简 PATH，必须显式补齐 homebrew / nvm / volta 等常见位置
function getSearchDirs() {
  const home = os.homedir()
  const dirs = []
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) add(dir)
  add('/opt/homebrew/bin')
  add('/opt/homebrew/sbin')
  add('/usr/local/bin')
  add('/usr/bin')
  add('/bin')
  add('/usr/sbin')
  add('/sbin')
  for (const dir of nvmBinDirs()) add(dir)
  add(path.join(home, '.volta', 'bin'))
  add(path.join(home, '.local', 'bin'))
  add(path.join(home, 'Library', 'pnpm'))
  add(path.join(home, '.bun', 'bin'))
  add(path.join(home, '.cargo', 'bin'))
  return dirs
}

function findExecutable(name, extraDirs = []) {
  const dirs = [...extraDirs, ...getSearchDirs()]
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return ''
}

function runVersion(command, args, env, timeout = 3000) {
  return new Promise((resolve) => {
    if (!command) {
      resolve({ ok: false, version: '', error: '未找到命令' })
      return
    }
    execFile(command, args, { timeout, encoding: 'utf8', env: env || process.env }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, version: '', error: String(stderr || err.message || '').trim().split('\n')[0] })
        return
      }
      resolve({ ok: true, version: String(stdout || '').trim().split('\n')[0], error: '' })
    })
  })
}

function parseSemver(output) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(output || ''))
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), version: `${m[1]}.${m[2]}.${m[3]}` } : null
}

async function detectNodes() {
  const candidates = []
  for (const dir of nvmBinDirs()) candidates.push(path.join(dir, 'node'))
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) candidates.push(path.join(dir, 'node'))
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, 'node'))
  const unique = [...new Set(candidates)].filter(p => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  const results = await Promise.all(unique.map(async (bin) => {
    const out = await runVersion(bin, ['-v'], process.env, 2000)
    const semver = out.ok ? parseSemver(out.version) : null
    return semver ? { bin, ...semver } : null
  }))
  const valid = results.filter(Boolean).sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch)
  const node22 = valid.find(n => n.major >= 22) || null
  // 默认 Node 跟随 PATH 首选，方便用户在终端中直接使用自己日常的版本
  let nodeDefault = null
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const found = valid.find(n => path.dirname(n.bin) === dir)
    if (found) {
      nodeDefault = found
      break
    }
  }
  if (!nodeDefault) nodeDefault = valid[0] || null
  return { all: valid, node22, nodeDefault }
}

function getPtyRoot() {
  try {
    let entry = require.resolve('node-pty')
    entry = entry.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    return path.resolve(path.dirname(entry), '..')
  } catch {
    return ''
  }
}

// node-pty 的 spawn-helper 在 npm 解包后可能丢失可执行位，打包后还会落到 app.asar.unpacked
function ensurePtyHelper() {
  const root = getPtyRoot()
  if (!root) return { ok: false, error: '未找到 node-pty' }
  const helpers = [
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(root, 'build', 'Release', 'spawn-helper'),
    path.join(root, 'build', 'Debug', 'spawn-helper')
  ].filter(p => fs.existsSync(p))
  if (!helpers.length) return { ok: false, error: '未找到 spawn-helper' }
  for (const helper of helpers) {
    try {
      const mode = fs.statSync(helper).mode
      if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, 0o755)
      fs.accessSync(helper, fs.constants.X_OK)
    } catch (err) {
      return { ok: false, error: `spawn-helper 不可执行: ${err.message}` }
    }
  }
  return { ok: true, error: '', helper: helpers[0] }
}

function checkPty() {
  const helper = ensurePtyHelper()
  if (!helper.ok) return { ok: false, error: helper.error, helper: '' }
  try {
    require('node-pty')
    return { ok: true, error: '', helper: helper.helper }
  } catch (err) {
    return { ok: false, error: `node-pty 加载失败: ${String(err.message || err).split('\n')[0]}`, helper: helper.helper }
  }
}

// ==================== 环境报告 ====================

async function getEnvReport() {
  const project = getProjectReport()
  const nodes = await detectNodes()
  const claudePath = findExecutable('claude')
  const gitPath = findExecutable('git')
  const pty = checkPty()

  const [claudeVersion, gitVersion, xcode] = await Promise.all([
    runVersion(claudePath, ['--version'], terminalEnv(project.dir), 6000),
    runVersion(gitPath, ['--version'], process.env, 3000),
    new Promise((resolve) => {
      if (!isMac) {
        resolve({ ok: false, version: '', error: '仅 macOS 需要' })
        return
      }
      execFile('xcode-select', ['-p'], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
        if (err) resolve({ ok: false, version: '', error: '未安装命令行工具' })
        else resolve({ ok: true, version: String(stdout || '').trim(), error: '' })
      })
    })
  ])

  let appVersion = ''
  try {
    appVersion = require(path.join(__dirname, '..', '..', 'package.json')).version || ''
  } catch {}

  return {
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    appVersion,
    dataDir: getDataDir(),
    project,
    node: {
      default: nodes.nodeDefault,
      build: nodes.node22,
      all: nodes.all.map(n => ({ bin: n.bin, version: n.version }))
    },
    claude: {
      path: claudePath,
      version: claudeVersion.ok ? claudeVersion.version : '',
      error: claudeVersion.ok ? '' : claudeVersion.error || (claudePath ? '' : '未找到 claude 命令')
    },
    git: {
      path: gitPath,
      version: gitVersion.ok ? gitVersion.version : '',
      error: gitVersion.ok ? '' : gitVersion.error
    },
    xcode,
    pty,
    install: {
      targetPath: isMac ? '/Applications/AiRoute.app' : '',
      canInstall: isMac && app.isPackaged
    },
    canBuild: !!(project.canBuild && nodes.node22 && project.nodeModules && pty.ok)
  }
}

// 终端 / 构建共用的环境：补齐 PATH、UTF-8 与颜色支持
function terminalEnv(projectDir, extraBin) {
  const dirs = []
  if (extraBin) dirs.push(extraBin)
  for (const dir of getSearchDirs()) {
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  const env = {
    ...process.env,
    PATH: dirs.join(path.delimiter),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    AIROUTE_DEV_PROJECT: projectDir || ''
  }
  if (!env.LC_ALL) delete env.LC_ALL
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  // 若 AiRoute 本身是从 Claude Code 会话（或它的子进程）里启动的，会话标记会被
  // 内嵌终端继承，导致新开的 claude 认为自己是子会话（不保存 transcript、无法恢复）。
  // 保留 ANTHROPIC_* 凭证，只清掉会话级标记
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID']) {
    delete env[key]
  }
  return env
}

function gitInfo(projectDir) {
  const info = { commit: '', branch: '', dirty: false }
  if (!projectDir || !isValidDir(path.join(projectDir, '.git'))) return info
  try {
    info.commit = execFileSync('git', ['-C', projectDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    info.branch = execFileSync('git', ['-C', projectDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    info.dirty = !!execFileSync('git', ['-C', projectDir, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {}
  return info
}

module.exports = {
  getDataDir,
  getConfigPath,
  expandHome,
  resolveProjectDir,
  inspectProject,
  getProjectReport,
  setProjectDir,
  chooseProjectDir,
  defaultProjectCandidates,
  getSearchDirs,
  findExecutable,
  detectNodes,
  checkPty,
  ensurePtyHelper,
  getPtyRoot,
  getEnvReport,
  terminalEnv,
  gitInfo
}
