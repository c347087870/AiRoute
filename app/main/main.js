const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron')
const path = require('path')
const { createTray, refreshTrayMenu } = require('./tray')

let mainWindow = null

Menu.setApplicationMenu(null)

function getServerEntry() {
  return path.join(__dirname, '..', 'server', 'router.js')
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

app.whenReady().then(() => {
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
