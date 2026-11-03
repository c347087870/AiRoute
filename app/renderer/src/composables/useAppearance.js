// 个性化外观：背景图与主题色
// 状态与持久化都走 Electron 主进程（userData/appearance），渲染层只负责应用 CSS 变量。
// 浏览器模式下没有 IPC，全部降级为只读默认值。
import { reactive, computed } from 'vue'

const ACCENTS = {
  blue: { color: '#007AFF', hover: '#0069DB' },
  purple: { color: '#AF52DE', hover: '#9A3FCB' },
  green: { color: '#2FAE5A', hover: '#278F4A' },
  orange: { color: '#F08A00', hover: '#D77A00' },
  pink: { color: '#FF375F', hover: '#E62E53' }
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

const api = typeof window !== 'undefined' ? window.electronAPI?.appearance : null

const state = reactive({
  ready: false,
  settings: { ...DEFAULTS },
  image: ''
})

let initPromise = null
let saveTimer = 0

// 背景图的平均亮度：用于自动计算「淡化遮罩」强度。
// 全局统一浅色界面（不引入暗色主题）时，只有保证背景被一层浅色蒙住，
// 深色壁纸上的深色文字才不会看不清——这比按像素猜字色可靠得多。
let washCache = { image: '', luma: -1 }
let washToken = 0

const hasBackground = computed(() => !!(state.settings.enabled && state.image))
const accentList = Object.entries(ACCENTS).map(([key, value]) => ({ key, ...value }))

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// 32×32 采样足够判断整体明暗，又不会在大图上卡住首帧。
// 返回 15% 分位亮度而不是平均值：一张整体明亮、角落却很暗的图，用平均值会
// 判定「够亮」而跳过淡化，恰好让文字落在暗角上看不清。
function measureLuma(image) {
  return new Promise((resolve) => {
    if (!image || typeof Image === 'undefined') return resolve(0.55)
    const img = new Image()
    img.onload = () => {
      try {
        const size = 32
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)
        const values = []
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3] / 255
          const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
          // 透明像素按白色（系统底色）计算，避免 PNG 透明区域被误判成深色
          values.push(luma * alpha + (1 - alpha))
        }
        values.sort((a, b) => a - b)
        resolve(values[Math.floor(values.length * 0.15)] ?? 0.55)
      } catch {
        resolve(0.55)
      }
    }
    img.onerror = () => resolve(0.55)
    img.src = image
  })
}

// 目标：图片 + 白色蒙层后的整体亮度不低于 0.68（浅色界面下深色文字仍清晰）。
// 用户手动调高「背景淡化」时取两者较大值，永远不牺牲可读性。
const TARGET_LUMA = 0.68
function computeWash(luma, opacity, fade) {
  // 图片本身都看不见时不该再盖一层白：淡化强度跟着实际可见度一起衰减，
  // 否则把透明度调到 0 反而会被 80% 的白色蒙层洗成一片惨白
  const manual = Math.min(0.92, Math.max(0, fade)) * Math.min(1, Math.max(0, opacity))
  if (luma < 0) return manual
  // 图片以 opacity 叠在窗口的浅色底上，实际呈现亮度会被抬高一截，
  // 降过透明度的背景不需要再盖同样厚的白
  const effective = luma * opacity + (1 - opacity)
  if (effective >= TARGET_LUMA) return manual
  const need = (TARGET_LUMA - effective) / (1 - effective)
  return Math.min(0.92, Math.max(manual, need))
}

function ensureLuma(image) {
  if (!image) return -1
  if (washCache.image === image) return washCache.luma
  const token = ++washToken
  measureLuma(image).then((luma) => {
    // 图片已再次更换时丢弃旧结果
    if (token !== washToken) return
    washCache = { image, luma }
    apply()
  })
  return -1
}

function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const s = state.settings
  const accent = ACCENTS[s.accent] || ACCENTS.blue

  root.style.setProperty('--primary', accent.color)
  root.style.setProperty('--primary-hover', accent.hover)
  root.style.setProperty('--primary-bg', hexToRgba(accent.color, 0.1))

  if (hasBackground.value) {
    const surface = Math.min(1, Math.max(0, s.surfaceOpacity / 100))
    // 三类表面各留一个下限，但都压得比较低：
    // 背景图整体已被洗到足够亮（见 computeWash），文字可读性不靠表面遮罩兜底，
    // 这样侧栏和控件也能透出图片，「只有右半边有背景」的割裂感才消失。
    // 卡片面积最大，允许最透；控件与侧栏是交互元素，保留一层薄白。
    const cardAlpha = Math.min(0.85, 0.08 + 0.72 * surface)
    const controlAlpha = Math.min(0.92, 0.35 + 0.55 * surface)
    const sidebarAlpha = Math.min(0.70, 0.18 + 0.52 * surface)
    const luma = ensureLuma(state.image)
    // dim 作为「背景淡化」使用：数值越高，白色蒙层越强、图片越淡
    const opacity = s.imageOpacity / 100
    const wash = computeWash(luma, opacity, 0.08 + 0.72 * (s.dim / 100))

    root.classList.add('has-app-bg')
    root.style.setProperty('--app-bg-image', `url("${state.image}")`)
    root.style.setProperty('--app-bg-opacity', String(s.imageOpacity / 100))
    root.style.setProperty('--app-bg-blur', `${s.blur}px`)
    root.style.setProperty('--app-bg-dim', String(wash))
    root.style.setProperty('--bg-page', 'transparent')
    root.style.setProperty('--bg-card', `rgba(255, 255, 255, ${cardAlpha})`)
    root.style.setProperty('--bg-control', `rgba(255, 255, 255, ${controlAlpha})`)
    root.style.setProperty('--bg-solid', 'rgba(255, 255, 255, 0.96)')
    root.style.setProperty('--bg-sidebar', `rgba(250, 250, 252, ${sidebarAlpha})`)
    root.style.setProperty('--bg-hover', 'rgba(0, 0, 0, 0.06)')
    root.style.setProperty('--border-1', 'rgba(0, 0, 0, 0.08)')
    root.style.setProperty('--border-2', 'rgba(0, 0, 0, 0.07)')
    root.style.setProperty('--border-3', 'rgba(0, 0, 0, 0.16)')
    // 背景上的文字统一加深一级，解决灰底灰字
    root.style.setProperty('--text-1', '#111114')
    root.style.setProperty('--text-2', '#3A3A3E')
    root.style.setProperty('--text-3', '#5A5A60')
    root.style.setProperty('--text-4', '#7C7C84')
  } else {
    washCache = { image: '', luma: -1 }
    root.classList.remove('has-app-bg')
    root.style.removeProperty('--app-bg-image')
    root.style.removeProperty('--app-bg-opacity')
    root.style.removeProperty('--app-bg-blur')
    root.style.removeProperty('--app-bg-dim')
    root.style.removeProperty('--bg-page')
    root.style.removeProperty('--bg-card')
    root.style.removeProperty('--bg-control')
    root.style.removeProperty('--bg-solid')
    root.style.removeProperty('--bg-sidebar')
    root.style.removeProperty('--bg-hover')
    root.style.removeProperty('--border-1')
    root.style.removeProperty('--border-2')
    root.style.removeProperty('--border-3')
    root.style.removeProperty('--text-1')
    root.style.removeProperty('--text-2')
    root.style.removeProperty('--text-3')
    root.style.removeProperty('--text-4')
  }
}

function setLocal(patch, { persist = true } = {}) {
  state.settings = { ...state.settings, ...patch }
  apply()
  if (persist) scheduleSave()
}

// 滑块拖动时每帧都写 IPC 没有意义，合并成一次落盘
function scheduleSave() {
  if (!api) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await api.save({ ...state.settings })
    } catch {}
  }, 250)
}

async function init() {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (api) {
      try {
        const result = await api.get()
        if (result?.settings) state.settings = { ...DEFAULTS, ...result.settings }
        state.image = result?.image || ''
      } catch {}
    }
    state.ready = true
    apply()
  })()
  return initPromise
}

async function chooseBackground() {
  if (!api) return { ok: false, error: '仅桌面客户端支持更换背景' }
  const result = await api.chooseBackground()
  if (result?.canceled) return result
  if (!result?.ok) return result
  clearTimeout(saveTimer)
  state.settings = { ...DEFAULTS, ...result.settings }
  state.image = result.image || ''
  apply()
  return result
}

async function clearBackground() {
  if (!api) return
  clearTimeout(saveTimer)
  try {
    const result = await api.clearBackground()
    state.settings = { ...DEFAULTS, ...(result?.settings || {}), enabled: false }
    state.image = ''
    apply()
  } catch {}
}

function toggleBackground(enabled) {
  if (!state.image && enabled) return
  setLocal({ enabled: !!enabled })
}

export function useAppearance() {
  return {
    state,
    hasBackground,
    accentList,
    supported: !!api,
    init,
    setLocal,
    chooseBackground,
    clearBackground,
    toggleBackground
  }
}
