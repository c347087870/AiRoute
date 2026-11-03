const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron')
const path = require('path')
const net = require('net')
const http = require('http')
const fs = require('fs-extra')
const { createTray, refreshTrayMenu, destroyTray } = require('./tray')
const devTerminal = require('./dev-terminal')
const devBuild = require('./dev-build')
const appearance = require('./appearance')

const isMac = process.platform === 'darwin'

// 固定应用名：macOS 的 userData 目录随应用名走，必须在读取任何路径前设置，
// 否则会落到 package.json 的 name（aiRoute）上，与 electron-builder 的 productName 不一致
app.setName('AiRoute')

// 单实例：重复启动时聚焦已有窗口并退出本次，避免多托盘实例与端口争用
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

let mainWindow = null
let serverPort = 3000
let uiBaseUrl = '' // 渲染层实际加载的地址（网关同源，或 attach 模式下主进程的临时静态服务）
let attaching = false // 端口已被另一个 AiRoute 占用：只开窗口，不再启动第二套网关
let uiServer = null // attach 模式下托管前端资源的临时 HTTP 服务

// macOS 需要标准菜单保留 Cmd+Q / Cmd+C / Cmd+V 等系统快捷键；
// Windows 保持无菜单栏，避免占用窗口高度
if (!isMac) {
  Menu.setApplicationMenu(null)
}

function buildMenu() {
  if (!isMac) return
  const template = [
    {
      label: 'AiRoute',
      submenu: [
        { role: 'about', label: '关于 AiRoute' },
        { type: 'separator' },
        { role: 'services', label: '服务', submenu: [] },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 AiRoute' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 AiRoute' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: 'GitHub 项目主页',
          click: () => shell.openExternal('https://github.com/c347087870/AiRoute')
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function getServerEntry() {
  return path.join(__dirname, '..', 'server', 'router.js')
}

function getRendererDir() {
  return path.join(__dirname, '..', 'renderer', 'dist')
}

// 读取已配置端口（与 server 侧一致：无配置时默认 3000）
function readConfiguredPort(dataDir) {
  try {
    const cfg = fs.readJsonSync(path.join(dataDir, 'server-config.json'))
    const port = Number(cfg && cfg.port)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
  } catch {}
  return 3000
}

// 端口预检：能绑定视为空闲；被占用时尝试读取占用者的服务版本（供提示信息使用）
function checkPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false)
      else {
        console.warn('[aiRoute] 端口预检异常:', err.message)
        resolve(true)
      }
    })
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port)
  })
}

function fetchJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1500 }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.on('error', () => resolve(null))
  })
}

// 判断占用端口的是不是 AiRoute（/api/system/status 会返回 version）
async function probeAiRoute(port) {
  const data = await fetchJson(port, '/api/system/status')
  return !!(data && data.version)
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeAiRoute(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

// attach 模式下由主进程托管打包好的前端资源：窗口仍加载本应用的新界面，
// API 则指向已经在运行的旧网关，避免旧版网关没有静态页面时窗口空白
function startUiServer(distDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
      reject(new Error('前端资源缺失: ' + distDir))
      return
    }
    const srv = http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent((req.url || '/').split('?')[0])
        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
        let file = path.resolve(distDir, rel)
        if (file !== distDir && !file.startsWith(distDir + path.sep)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          file = path.join(distDir, 'index.html')
        }
        const stat = fs.statSync(file)
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache'
        })
        fs.createReadStream(file).pipe(res)
      } catch (err) {
        res.writeHead(404)
        res.end('Not Found')
      }
    })
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, port: srv.address().port })
    })
  })
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  const options = {
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: 'AiRoute',
    backgroundColor: '#F5F5F7',
    show: false,
    icon: path.join(__dirname, '..', 'renderer', app.isPackaged ? 'dist' : 'public', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  }

  // macOS：隐藏标题栏但保留交通灯，页面顶部留出 28px 拖拽区（见 App.vue）
  if (isMac) {
    options.titleBarStyle = 'hiddenInset'
    options.trafficLightPosition = { x: 18, y: 20 }
  }

  mainWindow = new BrowserWindow(options)

  if (process.env.NODE_ENV === 'development') {
    const port = process.env.VITE_PORT || '5173'
    mainWindow.loadURL(`http://localhost:${port}`)
  } else if (uiBaseUrl) {
    mainWindow.loadURL(`${uiBaseUrl}/?port=${serverPort}`)
  } else {
    // 兜底：未启动网关时仍能打开界面查看错误信息
    mainWindow.loadFile(path.join(getRendererDir(), 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show()
  })

  // 页面里的外链一律交给系统浏览器，不在应用窗口内新开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('close', (e) => {
    // 仅在「退出应用」流程中放行关闭；普通关窗仍然最小化到托盘 / 菜单栏
    if (app.isQuitting) return
    e.preventDefault()
    mainWindow.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 窗口真正销毁时结束内嵌终端，避免 pty 进程在后台残留
    try {
      devTerminal.stop()
    } catch {}
  })

  createTray(mainWindow)
}

app.whenReady().then(async () => {
  if (!gotTheLock) return // 未获得单实例锁：进程正在退出

  buildMenu()

  // 生产模式：在主进程中直接启动 Express server（非阻塞，秒启动）
  if (app.isPackaged) {
    const dataDir = process.env.AIROUTE_DATA_DIR || path.join(app.getPath('userData'), 'data')
    process.env.AIROUTE_DATA_DIR = dataDir
    fs.ensureDirSync(dataDir)
    // 首次启动：从 ASAR 中拷贝初始配置文件到可写目录
    const copyFiles = ['state.json', 'fallback.json', 'rules.json', 'server-config.json']
    for (const f of copyFiles) {
      const src = path.join(__dirname, '..', 'server', f)
      const dst = path.join(dataDir, f)
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.copySync(src, dst)
      }
    }
    // models.json 从 ASAR 中不存在，首次创建空文件让用户通过 UI 配置
    const modelsPath = path.join(dataDir, 'models.json')
    if (!fs.existsSync(modelsPath)) {
      fs.writeJsonSync(modelsPath, {}, { spaces: 2 })
    }

    const port = readConfiguredPort(dataDir)
    if (await checkPortFree(port)) {
      // 生产模式：让 Express 走 production 分支，默认错误处理器不再把堆栈与
      // 绝对路径回给客户端（否则任何未捕获异常都会泄漏安装路径与源码结构）
      process.env.NODE_ENV = 'production'
      process.env.AIROUTE_RENDERER_DIR = getRendererDir()
      try {
        require(getServerEntry())
      } catch (err) {
        dialog.showErrorBox('AiRoute 启动失败', `本地服务启动失败：${err.message || err}`)
        app.quit()
        return
      }
      if (!(await waitForServer(port))) {
        dialog.showErrorBox('AiRoute 启动失败', `本地服务未能在端口 ${port} 上就绪。\n\n请检查端口是否被占用，或查看系统日志后重试。`)
        app.quit()
        return
      }
      serverPort = port
      uiBaseUrl = `http://localhost:${port}`
      console.log(`[aiRoute] Server 已启动，端口 ${port}`)
    } else {
      // 端口被占用：只有确认对方也是 AiRoute 才 attach，否则明确报错退出，
      // 避免界面连到一个完全无关的服务
      if (!(await probeAiRoute(port))) {
        dialog.showErrorBox(
          'AiRoute 启动失败',
          `端口 ${port} 已被其他程序占用。\n\n` +
          '请关闭占用该端口的程序，或在「设置」中把 AiRoute 的监听端口改为其他值后重试。'
        )
        app.quit()
        return
      }
      attaching = true
      serverPort = port
      try {
        uiServer = await startUiServer(getRendererDir())
        uiBaseUrl = `http://127.0.0.1:${uiServer.port}`
      } catch (err) {
        dialog.showErrorBox('AiRoute 启动失败', `无法加载界面资源：${err.message || err}`)
        app.quit()
        return
      }
      console.warn(`[aiRoute] 端口 ${port} 已有 AiRoute 服务，窗口将连接现有服务`)
    }
    // 托盘查询当前模型时优先用实际端口（attach 模式下可能与本地配置不同）
    process.env.AIROUTE_SERVER_PORT = String(serverPort)
  }

  createWindow()
})

// 任何退出路径（托盘退出 / 系统关机 / Cmd+Q 等）都先标记状态，确保窗口 close 不再被拦截
app.on('before-quit', () => {
  app.isQuitting = true
  destroyTray()
})

// macOS 关闭窗口后应用继续驻留菜单栏；Windows 保持原有退出行为
app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('activate', () => {
  showMainWindow()
})

app.on('will-quit', () => {
  try {
    devTerminal.disposeAll()
  } catch {}
  try {
    devBuild.disposeAll()
  } catch {}
  try {
    if (uiServer) uiServer.server.close()
  } catch {}
})

// 开发者选项：终端与构建能力只走 Electron IPC，且仅绑定主窗口
devTerminal.register(() => mainWindow)
devBuild.register()
// 外观设置：自定义背景图与个性化参数，存 userData/appearance
appearance.register(() => mainWindow)

ipcMain.handle('get-app-path', () => {
  return app.getAppPath()
})

// 应用实际数据目录（models.json、账号凭据、日志等都在这里）
ipcMain.handle('get-data-dir', () => {
  return process.env.AIROUTE_DATA_DIR || path.join(app.getAppPath(), 'server')
})

// 用系统文件管理器打开数据目录（设置页备份入口）
ipcMain.handle('open-path', (_, target) => {
  if (typeof target === 'string' && target) return shell.openPath(target)
  return '无效路径'
})

// 系统状态：应用各进程内存占用（字节）：main 主进程 / renderer 渲染进程 / gpu 图形进程 / total 合计
ipcMain.handle('get-app-memory', () => {
  let main = 0
  let renderer = 0
  let gpu = 0
  let total = 0
  for (const metric of app.getAppMetrics()) {
    const bytes = (metric.memory?.workingSetSize || 0) * 1024 // Electron 返回 KB
    total += bytes
    if (metric.type === 'Browser') main += bytes
    else if (metric.type === 'Tab' || metric.type === 'Renderer') renderer += bytes
    else if (metric.type === 'GPU') gpu += bytes
  }
  return { main, renderer, gpu, total }
})

// 供渲染进程把隐藏到托盘的窗口重新唤出
ipcMain.on('show-window', () => {
  showMainWindow()
})

// 渲染进程切换模型或修改 Provider 配置后，重建托盘菜单保证选中态与模型列表最新
ipcMain.on('model-data-changed', () => {
  refreshTrayMenu()
})

// 设置页修改端口并重启服务后，窗口需要跟着切到新端口；否则刷新会回到已关闭的旧端口
ipcMain.on('server-port-changed', (_, nextPort) => {
  const next = Number(nextPort)
  if (!Number.isInteger(next) || next < 1 || next > 65535) return
  serverPort = next
  process.env.AIROUTE_SERVER_PORT = String(next)
  if (!app.isPackaged || !uiBaseUrl || !mainWindow) return
  // attach 模式的前端仍由主进程托管，只更新 API 端口；自启动模式则网关本身换了端口
  if (!attaching) uiBaseUrl = `http://localhost:${next}`
  let hash = ''
  try {
    hash = new URL(mainWindow.webContents.getURL()).hash
  } catch {}
  mainWindow.loadURL(`${uiBaseUrl}/?port=${next}${hash}`)
})

ipcMain.handle('get-auto-launch', () => {
  const settings = app.getLoginItemSettings()
  return settings.openAtLogin
})

ipcMain.handle('set-auto-launch', (_, enabled) => {
  if (isMac) {
    // macOS 由系统登录项管理，不能传 Windows 的 path 参数
    app.setLoginItemSettings({ openAtLogin: !!enabled })
  } else {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: app.getPath('exe')
    })
  }
  return true
})

// 更新功能：选择新版本安装包的保存位置（默认落到系统下载目录）
ipcMain.handle('save-file-dialog', async (_, defaultName) => {
  const name = defaultName || (isMac ? 'AiRoute.dmg' : 'AiRoute.exe')
  const options = {
    title: isMac ? '保存新版本安装包' : '保存新版本安装包',
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: isMac
      ? [{ name: '磁盘映像', extensions: ['dmg'] }]
      : [{ name: '可执行文件', extensions: ['exe'] }]
  }
  const result = mainWindow && mainWindow.isVisible()
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options)
  return result.canceled ? '' : result.filePath
})

// 更新功能：用系统默认浏览器打开外链（Release 页面）
ipcMain.handle('open-external', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url)
})

// 更新功能：打开已下载文件所在文件夹并选中它
ipcMain.handle('show-item-in-folder', (_, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath)
})
