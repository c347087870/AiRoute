// 应用外观（自定义背景）：只通过 Electron IPC 暴露
// 图片选择后拷贝到 userData/appearance 下，设置写入同目录 settings.json，
// 渲染层通过 data URL 使用，避免 file:// 与 http:// 混用被 webSecurity 拦截。
const { app, dialog, ipcMain, nativeImage } = require('electron')
const fs = require('fs-extra')
const path = require('path')

const MAX_BYTES = 20 * 1024 * 1024 // 20MB，超出通常也不是桌面背景的合理体积
const MAX_GIF_BYTES = 8 * 1024 * 1024 // GIF 不做压缩（缩放会丢帧），base64 过 IPC 的成本更高
const MAX_DIM = 2560 // 桌面背景不需要 4K 以上分辨率，压到该边长内可显著减小 data URL
const FIT_VALUES = ['cover', 'contain', 'tile', 'stretch']
const ACCENTS = ['blue', 'purple', 'green', 'orange', 'pink']

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp'
}

const DEFAULTS = {
  enabled: false,
  fit: 'cover',
  imageOpacity: 100,
  blur: 0,
  dim: 30,
  surfaceOpacity: 60,
  accent: 'blue',
  imageName: ''
}

function getDir() {
  return path.join(app.getPath('userData'), 'appearance')
}

function getSettingsPath() {
  return path.join(getDir(), 'settings.json')
}

function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

// 只接受已知字段，避免渲染层写入任意内容；数值全部收敛到 UI 支持的区间
function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: input.enabled === true,
    fit: FIT_VALUES.includes(input.fit) ? input.fit : DEFAULTS.fit,
    // 三个滑块的区间都开到 0–100：用户要的是「能彻底透出背景图」，
    // 过去的 10 / 45 / 70 上限把最想要的通透档位整段砍掉了
    imageOpacity: clampInt(input.imageOpacity, 0, 100, DEFAULTS.imageOpacity),
    blur: clampInt(input.blur, 0, 30, DEFAULTS.blur),
    dim: clampInt(input.dim, 0, 100, DEFAULTS.dim),
    surfaceOpacity: clampInt(input.surfaceOpacity, 0, 100, DEFAULTS.surfaceOpacity),
    accent: ACCENTS.includes(input.accent) ? input.accent : DEFAULTS.accent,
    imageName: typeof input.imageName === 'string' ? input.imageName.slice(0, 200) : ''
  }
}

function readSettings() {
  try {
    const data = fs.readJsonSync(getSettingsPath())
    return normalize(data)
  } catch {
    return { ...DEFAULTS }
  }
}

function writeSettings(settings) {
  fs.ensureDirSync(getDir())
  fs.writeJsonSync(getSettingsPath(), settings, { spaces: 2 })
}

function findBackgroundFile() {
  const dir = getDir()
  if (!fs.existsSync(dir)) return ''
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('background.')) return path.join(dir, entry.name)
  }
  return ''
}

// 保存背景图：大图先缩到 MAX_DIM 内再落盘，避免每次启动都通过 IPC 传几十 MB 的 base64。
// GIF 保留原样（缩放会丢帧）；nativeImage 解不出的格式（如 WebP/AVIF）也原样拷贝。
function saveBackground(source) {
  const ext = path.extname(source).slice(1).toLowerCase()
  const dir = getDir()
  fs.ensureDirSync(dir)

  // 先写临时文件再改名，最后清理旧图：任何一步失败都不会丢掉上一张背景
  const tmp = path.join(dir, `.pending-${Date.now()}`)
  let finalName = ''

  if (ext === 'gif') {
    fs.copySync(source, `${tmp}.gif`)
    finalName = 'background.gif'
  } else {
    let converted = false
    try {
      let image = nativeImage.createFromPath(source)
      if (!image.isEmpty()) {
        const size = image.getSize()
        const longest = Math.max(size.width, size.height)
        if (longest > MAX_DIM) {
          const ratio = MAX_DIM / longest
          image = image.resize({
            width: Math.round(size.width * ratio),
            height: Math.round(size.height * ratio),
            quality: 'good'
          })
        }
        const png = ext === 'png'
        const buffer = png ? image.toPNG() : image.toJPEG(88)
        if (buffer && buffer.length) {
          fs.writeFileSync(`${tmp}.${png ? 'png' : 'jpg'}`, buffer)
          finalName = `background.${png ? 'png' : 'jpg'}`
          converted = true
        }
      }
    } catch {}
    if (!converted) {
      fs.copySync(source, `${tmp}.${ext}`)
      finalName = `background.${ext}`
    }
  }

  fs.renameSync(`${tmp}.${path.extname(finalName).slice(1)}`, path.join(dir, finalName))
  removeBackgroundFiles(finalName)
  return finalName
}

// keep：保留刚写入的文件名，避免先改名后清理时把新图一起删掉
function removeBackgroundFiles(keep = '') {
  const dir = getDir()
  if (!fs.existsSync(dir)) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('background.') || entry.name === keep) continue
    try {
      fs.removeSync(path.join(dir, entry.name))
    } catch {}
  }
}

// 上次保存中途失败可能留下 .pending-* 临时文件，启动时清掉
function cleanPendingFiles() {
  const dir = getDir()
  if (!fs.existsSync(dir)) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('.pending-')) continue
    try {
      fs.removeSync(path.join(dir, entry.name))
    } catch {}
  }
}

// data URL 只在启动与更换背景时传一次；常见图片已被压到 2560px 内
function toDataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const mime = MIME[ext] || 'application/octet-stream'
  const buffer = fs.readFileSync(file)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

// image 只在渲染层需要重绘背景时返回；普通设置保存不重复回传大字符串
function snapshot(withImage = true) {
  const settings = readSettings()
  const file = findBackgroundFile()
  if (!file) {
    // 文件被手动删除时不要让界面停留在「已启用但无图」的半坏状态
    settings.enabled = false
    settings.imageName = ''
  }
  return {
    ok: true,
    settings,
    image: withImage && file ? toDataUrl(file) : ''
  }
}

function isValidImage(file) {
  const ext = path.extname(file).slice(1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(MIME, ext)
}

function register(getWindow) {
  // 注意：register 在模块加载时执行，此时 app 尚未 ready、app.setName 也未必生效，
  // 因此清理临时文件放到首次取值时做，确保 userData 路径已经确定
  let pendingCleaned = false
  const ensureCleaned = () => {
    if (pendingCleaned) return
    pendingCleaned = true
    cleanPendingFiles()
  }

  ipcMain.handle('appearance:get', () => {
    ensureCleaned()
    return snapshot(true)
  })

  ipcMain.handle('appearance:save', (_, patch) => {
    const settings = normalize({ ...readSettings(), ...(patch || {}) })
    writeSettings(settings)
    return { ok: true, settings }
  })

  ipcMain.handle('appearance:choose-background', async () => {
    const win = typeof getWindow === 'function' ? getWindow() : null
    const options = {
      title: '选择应用背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: Object.keys(MIME) }]
    }
    const result = win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true }

    const source = result.filePaths[0]
    if (!isValidImage(source)) return { ok: false, error: '不支持的图片格式，请选择 PNG / JPG / WebP / GIF / AVIF / BMP' }

    let stat
    try {
      stat = fs.statSync(source)
    } catch (err) {
      return { ok: false, error: `无法读取图片：${err.message || err}` }
    }
    if (!stat.isFile()) return { ok: false, error: '请选择图片文件' }
    if (stat.size > MAX_BYTES) return { ok: false, error: '图片超过 20MB，请换一张更小的图片' }
    const ext = path.extname(source).slice(1).toLowerCase()
    if (ext === 'gif' && stat.size > MAX_GIF_BYTES) {
      return { ok: false, error: 'GIF 背景需小于 8MB（不做压缩以保留动画），建议改用 JPG / PNG' }
    }

    const previous = readSettings()
    try {
      saveBackground(source)
    } catch (err) {
      return { ok: false, error: `保存背景图片失败：${err.message || err}` }
    }

    const settings = normalize({
      ...previous,
      enabled: true,
      // 首次选择时给一个能铺满窗口的默认值；之后保留用户选过的填充方式
      fit: previous.imageName ? previous.fit : 'cover',
      imageName: path.basename(source)
    })
    writeSettings(settings)
    return snapshot(true)
  })

  ipcMain.handle('appearance:clear-background', () => {
    removeBackgroundFiles()
    const settings = normalize({ ...readSettings(), enabled: false, imageName: '' })
    writeSettings(settings)
    return { ok: true, settings, image: '' }
  })
}

module.exports = { register }
