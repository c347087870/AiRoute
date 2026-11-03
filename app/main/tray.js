const { Tray, Menu, nativeImage, app, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const axios = require('axios')

const isMac = process.platform === 'darwin'

// 生产环境 server 与 main 同级（app/main、app/server）；开发环境 server 在项目根目录
let getServerPort
try {
  getServerPort = require('../server/paths').getServerPort
} catch {
  getServerPort = require('../../server/paths').getServerPort
}

// 端口从统一配置读取，兼容用户修改端口后托盘功能仍然正常；
// attach 模式下主进程会把实际端口写进环境变量，优先级最高
function getApiBase() {
  const port = process.env.AIROUTE_SERVER_PORT || getServerPort()
  return `http://localhost:${port}`
}

// 把模型引用转成可读名称：Provider 显示名 / 模型显示名
function refLabel(providers, ref) {
  if (!ref) return '未设置'
  if (ref === 'auto') return 'Auto (智能路由)'

  const idx = ref.indexOf('/')
  const providerName = idx === -1 ? ref : ref.slice(0, idx)
  const modelId = idx === -1 ? '' : ref.slice(idx + 1)
  const provider = providers[providerName]
  if (!provider) return ref

  // 国际版源补区域后缀（与分组标题口径一致），避免同名时看不出切的是哪个源
  const base = provider.displayName || providerName
  const providerLabel =
    provider.type === 'workbuddy' && provider.region === 'global' && !base.includes('国际版') && !/global/i.test(base)
      ? `${base}（国际版）`
      : base
  const models = provider.models || []
  const model = modelId ? models.find(m => m.id === modelId) : models[0]
  return model ? `${providerLabel} / ${model.displayName || model.id}` : providerLabel
}

// 托盘与窗口引用，供配置变化时从外部触发菜单重建
let trayRef = null
let mainWindowRef = null

// macOS 菜单栏图标必须是模板图（纯黑 + alpha，由系统随菜单栏明暗自动反色），
// 彩色应用图标直接缩小会变成一团看不清的色块。
// 1x / 2x 必须分别作为 representation 加入同一个 nativeImage：
// createFromPath 只会加载第一个命中的文件，Retina 屏上 @2x 就永远用不到，图标会糊
function getTrayIcon() {
  const dir = path.join(__dirname, '..', 'renderer', app.isPackaged ? 'dist' : 'public')
  if (!isMac) {
    const image = nativeImage.createFromPath(path.join(dir, 'icon.png'))
    return image.isEmpty() ? nativeImage.createEmpty() : image
  }

  const image = nativeImage.createEmpty()
  const representations = [
    { scaleFactor: 1, name: 'trayTemplate.png' },
    { scaleFactor: 2, name: 'trayTemplate@2x.png' }
  ]
  for (const { scaleFactor, name } of representations) {
    try {
      const buffer = fs.readFileSync(path.join(dir, name))
      if (buffer.length) image.addRepresentation({ scaleFactor, buffer })
    } catch {}
  }
  if (image.isEmpty()) return nativeImage.createEmpty()
  image.setTemplateImage(true)
  return image
}

function createTray(mainWindow) {
  // 已存在托盘时只更新窗口引用，避免 macOS 菜单栏出现多个图标
  if (trayRef) {
    mainWindowRef = mainWindow
    return
  }

  const icon = getTrayIcon()
  const tray = new Tray(icon)
  tray.setToolTip('AiRoute')
  trayRef = tray
  mainWindowRef = mainWindow

  updateMenu(tray, mainWindow)

  // 右键弹出菜单前异步重建，保证模型列表与选中态是最新的
  tray.on('right-click', () => {
    updateMenu(tray, mainWindow)
  })

  // macOS 菜单栏应用习惯：双击显示主窗口（单击默认展开菜单）
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// 渲染进程切换模型或修改 Provider 配置后，通过主进程调用此处刷新托盘菜单
function refreshTrayMenu() {
  if (trayRef && mainWindowRef) {
    updateMenu(trayRef, mainWindowRef)
  }
}

// 退出应用前移除托盘图标，避免应用已退出、菜单栏还残留幽灵图标
function destroyTray() {
  if (!trayRef) return
  try {
    trayRef.destroy()
  } catch {}
  trayRef = null
}

// 托盘退出：先移除托盘图标再优雅退出，并带强制兜底，确保进程不残留
function quitApp() {
  app.isQuitting = true
  destroyTray()
  app.quit()
  setTimeout(() => app.exit(0), 800)
}

async function updateMenu(tray, mainWindow) {
  let currentModel = 'unknown'
  let providers = {}

  try {
    const [stateRes, provRes] = await Promise.all([
      axios.get(`${getApiBase()}/api/state`, { timeout: 4000 }),
      axios.get(`${getApiBase()}/api/providers`, { timeout: 4000 })
    ])
    currentModel = stateRes.data.current
    providers = provRes.data
  } catch {
    providers = {}
  }

  // 切换模型：写入服务端后重建菜单，保证所有勾选项状态一致
  const switchTo = (ref) => async () => {
    try {
      await axios.post(`${getApiBase()}/api/state`, { current: ref }, { timeout: 4000 })
      mainWindow.webContents.send('tray-switch-model', ref)
      updateMenu(tray, mainWindow)
    } catch {}
  }

  // 每个 Provider 一组，组内是该 Provider 的全部模型
  // 国际版源补区域后缀：WorkBuddy 国内/国际是两个独立源，显示名可能相同
  const providerLabel = (name, provider) => {
    const base = provider.displayName || name
    if (provider.type !== 'workbuddy') return base
    if (provider.region !== 'global') return base
    if (base.includes('国际版') || /global/i.test(base)) return base
    return `${base}（国际版）`
  }
  const providerItems = Object.entries(providers).map(([name, provider]) => ({
    label: providerLabel(name, provider),
    submenu: (provider.models || []).map(model => {
      const ref = `${name}/${model.id}`
      return {
        label: model.displayName || model.id,
        type: 'checkbox',
        checked: currentModel === ref,
        click: switchTo(ref)
      }
    })
  }))

  const showWindow = () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: `AiRoute - 当前: ${refLabel(providers, currentModel)}`, enabled: false },
    { type: 'separator' },
    ...providerItems,
    {
      label: 'Auto (智能路由)',
      type: 'checkbox',
      checked: currentModel === 'auto',
      click: switchTo('auto')
    },
    { type: 'separator' },
    { label: isMac ? '打开主窗口' : '打开面板', click: showWindow },
    {
      label: isMac ? '在 Finder 中打开数据目录' : '打开数据目录',
      click: () => {
        const dir = process.env.AIROUTE_DATA_DIR
        if (dir) shell.openPath(dir)
      }
    },
    { type: 'separator' },
    { label: isMac ? '退出 AiRoute' : '退出', click: quitApp }
  ])

  tray.setContextMenu(contextMenu)
}

module.exports = { createTray, refreshTrayMenu, destroyTray }
