const { Tray, Menu, nativeImage, app } = require('electron')
const path = require('path')
const fs = require('fs-extra')
const axios = require('axios')

// 动态读取服务端口，兼容用户修改端口后托盘功能正常
function getServerPort() {
  try {
    const dataDir = app.isPackaged
      ? path.join(app.getPath('userData'), 'data')
      : path.join(__dirname, '..', '..', 'server')
    const configPath = path.join(dataDir, 'server-config.json')
    if (fs.existsSync(configPath)) {
      return fs.readJsonSync(configPath).port || 3000
    }
  } catch {}
  return 3000
}

function getApiBase() {
  return `http://localhost:${getServerPort()}`
}

let tray = null

function createTray(mainWindow) {
  const iconPath = path.join(__dirname, '..', 'renderer', app.isPackaged ? 'dist' : 'public', 'icon.png')
  let icon
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) throw new Error('empty')
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('AiRoute')

  updateMenu(tray, mainWindow)

  tray.on('double-click', () => {
    mainWindow.show()
  })
}

async function updateMenu(tray, mainWindow) {
  let currentModel = 'unknown'
  let providers = {}

  try {
    const stateRes = await axios.get(`${getApiBase()}/api/state`)
    currentModel = stateRes.data.current
    const provRes = await axios.get(`${getApiBase()}/api/providers`)
    providers = provRes.data
  } catch {
    providers = {}
  }

  const modelItems = Object.keys(providers).map(name => ({
    label: `${providers[name].displayName || name}${name === currentModel ? ' ●' : ''}`,
    click: async () => {
      try {
        await axios.post(`${getApiBase()}/api/state`, { current: name })
        mainWindow.webContents.send('tray-switch-model', name)
        updateMenu(tray, mainWindow)
      } catch {}
    }
  }))

  modelItems.push({ label: 'Auto (智能路由)', type: 'radio', checked: currentModel === 'auto',
    click: async () => {
      try {
        await axios.post(`${getApiBase()}/api/state`, { current: 'auto' })
        mainWindow.webContents.send('tray-switch-model', 'auto')
        updateMenu(tray, mainWindow)
      } catch {}
    }
  })

  const contextMenu = Menu.buildFromTemplate([
    { label: `AiRoute - 当前: ${currentModel}`, enabled: false },
    { type: 'separator' },
    { label: '切换模型', submenu: modelItems },
    { type: 'separator' },
    { label: '打开面板', click: () => mainWindow.show() },
    { label: '退出', click: () => { app.exit(0) } }
  ])

  tray.setContextMenu(contextMenu)
}

module.exports = { createTray }
