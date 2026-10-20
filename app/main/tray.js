const { Tray, Menu, nativeImage, app } = require('electron')
const path = require('path')
const axios = require('axios')

// 生产环境 server 与 main 同级（app/main、app/server）；开发环境 server 在项目根目录
let getServerPort
try {
  getServerPort = require('../server/paths').getServerPort
} catch {
  getServerPort = require('../../server/paths').getServerPort
}

// 端口从统一配置读取，兼容用户修改端口后托盘功能仍然正常
function getApiBase() {
  return `http://localhost:${getServerPort()}`
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

// 托盘图标：Windows 直接用原图；macOS 菜单栏图标按「点」计算，
// 需要把 1024px 原图缩到 18pt（并提供 2x 位图给 retina），否则图标会撑满整个菜单栏
function loadTrayIcon(iconPath) {
  const image = nativeImage.createFromPath(iconPath)
  if (process.platform !== 'darwin' || image.isEmpty()) return image
  const trayImage = nativeImage.createEmpty()
  trayImage.addRepresentation({ scaleFactor: 1, buffer: image.resize({ width: 18, height: 18, quality: 'best' }).toPNG() })
  trayImage.addRepresentation({ scaleFactor: 2, buffer: image.resize({ width: 36, height: 36, quality: 'best' }).toPNG() })
  return trayImage
}

function createTray(mainWindow) {
  const iconPath = path.join(__dirname, '..', 'renderer', app.isPackaged ? 'dist' : 'public', 'icon.png')
  let icon
  try {
    icon = loadTrayIcon(iconPath)
    if (icon.isEmpty()) throw new Error('empty')
  } catch {
    icon = nativeImage.createEmpty()
  }

  const tray = new Tray(icon)
  tray.setToolTip('AiRoute')
  trayRef = tray
  mainWindowRef = mainWindow

  updateMenu(tray, mainWindow)

  // 右键弹出菜单前异步重建，保证模型列表与选中态是最新的
  tray.on('right-click', () => {
    updateMenu(tray, mainWindow)
  })

  tray.on('double-click', () => {
    mainWindow.show()
  })
}

// 渲染进程切换模型或修改 Provider 配置后，通过主进程调用此处刷新托盘菜单
function refreshTrayMenu() {
  if (trayRef && mainWindowRef) {
    updateMenu(trayRef, mainWindowRef)
  }
}

// 托盘退出：先移除托盘图标再优雅退出，并带强制兜底，确保进程不残留、无托盘幽灵图标
function quitApp() {
  try {
    if (trayRef) trayRef.destroy()
  } catch {}
  trayRef = null
  app.isQuitting = true
  app.quit()
  setTimeout(() => app.exit(0), 800)
}

async function updateMenu(tray, mainWindow) {
  let currentModel = 'unknown'
  let providers = {}

  try {
    const [stateRes, provRes] = await Promise.all([
      axios.get(`${getApiBase()}/api/state`),
      axios.get(`${getApiBase()}/api/providers`)
    ])
    currentModel = stateRes.data.current
    providers = provRes.data
  } catch {
    providers = {}
  }

  // 切换模型：写入服务端后重建菜单，保证所有勾选项状态一致
  const switchTo = (ref) => async () => {
    try {
      await axios.post(`${getApiBase()}/api/state`, { current: ref })
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
    { label: '打开面板', click: () => mainWindow.show() },
    { label: '退出', click: quitApp }
  ])

  tray.setContextMenu(contextMenu)
}

module.exports = { createTray, refreshTrayMenu }
