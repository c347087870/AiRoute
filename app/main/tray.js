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
  const providerLabel = sourceOfProvider(providerName, provider)
  const models = provider.models || []
  const model = modelId ? models.find(m => m.id === modelId) : models[0]
  if (!model) return providerLabel
  return `${providerLabel} / ${modelMenuLabel(providerName, provider, model)}`
}

// 渠道模型 id 自带渠道前缀（workbuddy/glm-5.3、trae/xxx），但托盘里只显示模型名
// 时看不出「这是哪家的」。这张表把前缀翻成人话；没登记的渠道按前缀原样显示，
// 至少还能分辨是不同来源。
const CHANNEL_SOURCE_NAMES = {
  workbuddy: 'WorkBuddy 国内版',
  'workbuddy-global': 'WorkBuddy 国际版',
  trae: 'Trae',
  qoder: 'Qoder 国际版',
  qodercn: 'Qoder 国内版'
}

// WorkBuddy 两区的固定中文来源名：displayName 没改过时用它，
// 否则托盘里会显示成「workbuddy」「workbuddy-global」这种内部 ID
const WORKBUDDY_SOURCE_NAMES = { cn: 'WorkBuddy 国内版', global: 'WorkBuddy 国际版' }

// Provider 的来源名：托盘里每个模型后面都要带上它，光看模型名分不出是哪家提供的
function sourceOfProvider(name, provider) {
  const base = provider.displayName || ''
  if (provider.type === 'workbuddy') {
    const region = provider.region === 'global' ? 'global' : 'cn'
    // displayName 与 Provider ID 相同 = 用户没改过名（建源时直接把 ID 抄了过来），
    // 这时用固定中文名；用户自己写过的名字一律保留
    if (!base || base === name) return WORKBUDDY_SOURCE_NAMES[region]
    // 国际版补区域后缀（与分组标题口径一致），避免同名时看不出切的是哪个源
    return region === 'global' && !base.includes('国际版') && !/global/i.test(base)
      ? `${base}（国际版）`
      : base
  }
  return base || name
}

// 模型在托盘菜单里的显示名：统一带上来源。
// 渠道源一个 Provider 里装着好几家的模型，来源要从模型 id 前缀取；
// 其余源整组就属于同一家，直接用 Provider 显示名。
function modelMenuLabel(name, provider, model) {
  const label = model.displayName || model.id
  const modelId = String(model.id)
  if (provider.type === 'channel') {
    const idx = modelId.indexOf('/')
    if (idx === -1) return label
    const prefix = modelId.slice(0, idx)
    return `${label} — ${CHANNEL_SOURCE_NAMES[prefix] || prefix}`
  }
  return `${label} — ${sourceOfProvider(name, provider)}`
}

// 托盘与窗口引用，供配置变化时从外部触发菜单重建
let trayRef = null
let mainWindowRef = null

// 托盘图标：任务栏/菜单栏都要按「点」缩到小尺寸，否则 1024px 原图
// 在 Windows 任务栏（16pt）会被系统硬缩发糊，macOS 菜单栏会撑满整条
function loadTrayIcon(iconPath) {
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return image
  if (process.platform === 'win32') {
    return image.resize({ width: 16, height: 16, quality: 'best' })
  }
  if (process.platform !== 'darwin') return image
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

  // 每个 Provider 一组，组内是该 Provider 的全部模型。
  // 组标题与组内每一项都带来源：渠道源一个 Provider 装着好几家的模型，
  // 光看模型名分不出这一路请求打到了哪一家
  const providerItems = Object.entries(providers).map(([name, provider]) => ({
    label: sourceOfProvider(name, provider),
    submenu: (provider.models || []).map(model => {
      const ref = `${name}/${model.id}`
      return {
        label: modelMenuLabel(name, provider, model),
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
