const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron')
const path = require('path')
const net = require('net')
const http = require('http')
const { createTray, refreshTrayMenu } = require('./tray')

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

Menu.setApplicationMenu(null)

function getServerEntry() {
  return path.join(__dirname, '..', 'server', 'router.js')
}

// 读取已配置端口（与 server 侧一致：无配置时默认 3000）
function readConfiguredPort(dataDir) {
  try {
    const cfg = require('fs-extra').readJsonSync(path.join(dataDir, 'server-config.json'))
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

function fetchBusyServerVersion(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/system/status', timeout: 1200 }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try { resolve(JSON.parse(body).version || '') } catch { resolve('') }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.on('error', () => resolve(''))
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'AiRoute',
    icon: path.join(__dirname, '..', 'renderer', app.isPackaged ? 'dist' : 'public', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.NODE_ENV === 'development') {
    const port = process.env.VITE_PORT || '5173'
    mainWindow.loadURL(`http://localhost:${port}`)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'))
  }

  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow.hide()
  })

  createTray(mainWindow)
}

app.whenReady().then(async () => {
  if (!gotTheLock) return // 未获得单实例锁：进程正在退出

  // 生产模式：在主进程中直接启动 Express server（非阻塞，秒启动）
  if (app.isPackaged) {
    const dataDir = path.join(app.getPath('userData'), 'data')
    process.env.AIROUTE_DATA_DIR = dataDir
    // 首次启动：从 ASAR 中拷贝初始配置文件到可写目录
    const fs = require('fs-extra')
    fs.ensureDirSync(dataDir)
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
    // 端口预检：旧版实例仍在运行时（占用端口）给出明确提示并退出，
    // 避免新界面连到旧服务，出现「功能是新的、版本号是旧的」混合状态
    const port = readConfiguredPort(dataDir)
    if (!(await checkPortFree(port))) {
      const busyVersion = await fetchBusyServerVersion(port)
      dialog.showErrorBox(
        'AiRoute 启动失败',
        `端口 ${port} 已被占用${busyVersion ? `（占用者服务版本为 v${busyVersion}）` : ''}。\n\n` +
        '可能仍有旧版 AiRoute 在运行（含系统托盘图标），请完全退出旧版后重新启动本程序。\n' +
        '若确认并非 AiRoute，请检查该端口是否被其他程序占用。'
      )
      app.quit()
      return
    }
    // Express 使用事件循环，不会阻塞 Electron 窗口
    require(getServerEntry())
    console.log('[aiRoute] Server 已启动')
  }

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow) mainWindow.show()
})

ipcMain.handle('get-app-path', () => {
  return app.getAppPath()
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
  if (mainWindow) mainWindow.show()
})

// 渲染进程切换模型或修改 Provider 配置后，重建托盘菜单保证选中态与模型列表最新
ipcMain.on('model-data-changed', () => {
  refreshTrayMenu()
})

ipcMain.handle('get-auto-launch', () => {
  const settings = app.getLoginItemSettings()
  return settings.openAtLogin
})

ipcMain.handle('set-auto-launch', (_, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe')
  })
  return true
})

// 更新功能：选择新版本安装包的保存位置（默认落到系统下载目录）
ipcMain.handle('save-file-dialog', async (_, defaultName) => {
  const options = {
    title: '保存新版本安装包',
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'AiRoute.exe'),
    filters: [{ name: '可执行文件', extensions: ['exe'] }]
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
