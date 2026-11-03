// 内嵌终端：把 Claude Code 或登录 Shell 跑在 node-pty 里
// 只在 Electron IPC 中暴露，绝不注册到 HTTP 网关
const { ipcMain } = require('electron')
const fs = require('fs-extra')
const os = require('os')
const devConfig = require('./dev-config')

let ptyProcess = null
let ownerId = null
let session = null
let starting = false

function cleanMessage(err) {
  return String((err && err.message) || err || '')
    .split('\n')
    .filter(line => !/^\s*at\s/.test(line))
    .join(' ')
    .trim()
}

function resolveShell() {
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return '/bin/sh'
}

function isAlive() {
  return !!(ptyProcess && session)
}

function getStatus() {
  return {
    running: isAlive(),
    starting,
    mode: session ? session.mode : '',
    continueSession: session ? !!session.continueSession : false,
    resume: session ? !!session.resume : false,
    cwd: session ? session.cwd : '',
    pid: ptyProcess ? ptyProcess.pid : 0,
    startedAt: session ? session.startedAt : 0
  }
}

function sendToOwner(channel, payload) {
  // owner 可能已经随窗口销毁；发送失败直接忽略，避免主进程崩溃
  try {
    const { webContents } = require('electron')
    const wc = webContents.fromId(ownerId)
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  } catch {}
}

function disposeProcess() {
  if (!ptyProcess) {
    session = null
    ownerId = null
    return
  }
  const proc = ptyProcess
  ptyProcess = null
  session = null
  try {
    proc.kill()
  } catch {}
  try {
    const { webContents } = require('electron')
    const wc = webContents.fromId(ownerId)
    if (wc && !wc.isDestroyed()) wc.send('dev-terminal:state', getStatus())
  } catch {}
  ownerId = null
}

async function buildLaunchOptions(opts) {
  const project = devConfig.getProjectReport()
  if (!project.exists) throw new Error('请先选择 AiRoute 项目目录')
  if (!project.packageJson) throw new Error('项目目录缺少 package.json，请重新选择')
  if (!project.buildScript) throw new Error('项目目录缺少 scripts/build.js，不是可用的 AiRoute 源码目录')
  if (!project.nodeModules) throw new Error('项目目录缺少 node_modules，请先在终端执行 npm install')

  const mode = opts && opts.mode === 'shell' ? 'shell' : 'claude'
  const continueSession = !!(opts && opts.continueSession)
  const resume = !!(opts && opts.resume)
  const nodes = await devConfig.detectNodes()
  if (!nodes.node22) throw new Error('未检测到 Node.js 22+，请先安装（nvm install 22）')
  if (!nodes.nodeDefault) throw new Error('未检测到可用的 Node.js')
  const nodeBin = nodes.nodeDefault.bin

  const env = devConfig.terminalEnv(project.dir, nodeBin)
  env.AIROUTE_DEV_PAGE = '1'

  let shell = resolveShell()
  let file = ''
  let args = []
  if (mode === 'claude') {
    const claudePath = devConfig.findExecutable('claude')
    if (!claudePath) {
      throw new Error('未找到 claude 命令，请先安装 Claude Code（npm i -g @anthropic-ai/claude-code）')
    }
    file = claudePath
    args = continueSession ? ['--continue'] : resume ? ['--resume'] : []
    // Claude CLI 依赖 HOME 与配置文件，透传环境即可
  } else {
    file = shell
    // 登录 shell 会加载用户的 PATH / 别名，体验与 Terminal 一致
    args = ['-l']
  }

  return {
    file,
    args,
    cwd: project.dir,
    env,
    mode,
    continueSession,
    resume,
    shell,
    nodeVersion: nodes.nodeDefault.version,
    nodeBin
  }
}

async function start(event, opts) {
  if (starting) throw new Error('终端正在启动，请稍候')
  starting = true
  try {
    // 先做环境探测再停旧进程：参数不合法时保留用户当前正在跑的会话
    const launch = await buildLaunchOptions(opts)
    const ptyCheck = devConfig.checkPty()
    if (!ptyCheck.ok) throw new Error(ptyCheck.error)
    const pty = require('node-pty')

    const cols = Math.max(20, Math.min(400, Number(opts && opts.cols) || 100))
    const rows = Math.max(5, Math.min(200, Number(opts && opts.rows) || 28))

    disposeProcess()
    const proc = pty.spawn(launch.file, launch.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: launch.cwd,
      env: launch.env,
      encoding: 'utf8'
    })

    ptyProcess = proc
    ownerId = event.sender.id
    session = {
      mode: launch.mode,
      continueSession: launch.continueSession,
      resume: launch.resume,
      cwd: launch.cwd,
      shell: launch.shell,
      command: launch.file,
      nodeVersion: launch.nodeVersion,
      startedAt: Date.now()
    }

    proc.onData((data) => {
      // 切换模式时旧进程已被 disposeProcess 置空，但它的 onData 仍可能再触发几次；
      // 不判断身份会把旧会话的输出混进新终端
      if (ptyProcess !== proc || ownerId === null) return
      sendToOwner('dev-terminal:data', data)
    })

    proc.onExit(({ exitCode, signal }) => {
      // 旧进程被新会话替换后，它退出时的清理不能影响新 session（否则新会话状态会被清空）
      if (ptyProcess !== proc) return
      const finished = session
      ptyProcess = null
      session = null
      sendToOwner('dev-terminal:exit', {
        exitCode,
        signal,
        mode: finished ? finished.mode : '',
        cwd: finished ? finished.cwd : ''
      })
      sendToOwner('dev-terminal:state', getStatus())
      ownerId = null
    })

    // 必须先把 starting 复位再广播/返回：否则渲染层收到的状态是 starting:true，
    // 四个模式按钮会一直停留在 disabled，表现为「点了没反应」
    starting = false
    if (ownerId !== null) event.sender.send('dev-terminal:state', getStatus())
    return { ok: true, ...getStatus() }
  } catch (err) {
    return { ok: false, error: cleanMessage(err) }
  } finally {
    starting = false
  }
}

function write(_event, data) {
  if (!ptyProcess || typeof data !== 'string' || !data) return false
  try {
    ptyProcess.write(data)
    return true
  } catch {
    return false
  }
}

function resize(_event, size) {
  if (!ptyProcess || !size) return false
  const cols = Math.max(20, Math.min(400, Number(size.cols) || 0))
  const rows = Math.max(5, Math.min(200, Number(size.rows) || 0))
  if (!cols || !rows) return false
  try {
    ptyProcess.resize(cols, rows)
    return true
  } catch {
    return false
  }
}

async function restart(event, opts) {
  const previous = session
  const nextOpts = {
    mode: (opts && opts.mode) || (previous ? previous.mode : 'claude'),
    continueSession: opts && typeof opts.continueSession === 'boolean'
      ? opts.continueSession
      : !!(previous && previous.continueSession),
    resume: !!(previous && previous.resume) && !(opts && opts.resume === false),
    cols: opts && opts.cols,
    rows: opts && opts.rows
  }
  return start(event, nextOpts)
}

function stop() {
  disposeProcess()
  return { ok: true, ...getStatus() }
}

// 发送一个安全的控制序列：清屏（终端侧清空由渲染层负责，这里只通知状态）
function register(getMainWindow) {
  ipcMain.handle('dev-terminal:start', async (event, opts) => {
    const win = getMainWindow && getMainWindow()
    if (win && !win.isDestroyed() && event.sender.id !== win.webContents.id) {
      return { ok: false, error: '只能从主窗口启动终端' }
    }
    return start(event, opts)
  })
  ipcMain.handle('dev-terminal:write', (event, data) => {
    if (session && event.sender.id !== ownerId) return false
    return write(event, data)
  })
  ipcMain.handle('dev-terminal:resize', (event, size) => {
    if (session && event.sender.id !== ownerId) return false
    return resize(event, size)
  })
  ipcMain.handle('dev-terminal:restart', async (event, opts) => {
    if (session && event.sender.id !== ownerId) {
      return { ok: false, error: '终端已被其他窗口占用' }
    }
    return restart(event, opts)
  })
  ipcMain.handle('dev-terminal:stop', (event) => {
    if (session && event.sender.id !== ownerId) return { ok: false, error: '终端已被其他窗口占用' }
    return stop()
  })
  ipcMain.handle('dev-terminal:status', () => getStatus())
}

function disposeAll() {
  disposeProcess()
}

module.exports = {
  register,
  disposeAll,
  getStatus,
  stop
}
