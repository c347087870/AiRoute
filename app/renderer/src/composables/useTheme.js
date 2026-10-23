// 主题共享状态：唯一入口是侧边栏底部的三格按钮（设置页不再重复放一份）
// mode 为用户选择（system / light / dark），resolved 为实际生效的亮暗
import { computed, ref } from 'vue'

// 与 index.html 里的首屏预置脚本共用同一个 key，改这里要同步改那边
const STORAGE_KEY = 'airoute-theme'
const MODES = ['system', 'light', 'dark']
const DEFAULT_MODE = 'system' // 默认跟随系统

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const systemDark = ref(!!media?.matches)

// 读取用户选择：无记录 / 值非法时回落到跟随系统
function readMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return MODES.includes(saved) ? saved : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

const mode = ref(readMode())

const resolved = computed(() => {
  if (mode.value === 'system') return systemDark.value ? 'dark' : 'light'
  return mode.value
})

// 把生效主题写到 <html data-theme>（CSS 令牌按它切换），并同步 Electron 原生主题
function apply() {
  const root = document.documentElement
  root.dataset.theme = resolved.value
  root.style.colorScheme = resolved.value
  // 桌面端：让菜单/原生对话框/托盘弹窗跟随用户选择，而不是只跟随系统
  window.electronAPI?.setNativeTheme?.(mode.value)
}

let inited = false

// 启动初始化：应用当前主题并监听系统亮暗变化（跟随系统时实时生效）
function initTheme() {
  if (inited) return
  inited = true
  apply()
  media?.addEventListener('change', (event) => {
    systemDark.value = event.matches
    apply()
  })
}

// 设置主题：system 不写存储，保持「未选择即跟随系统」的语义
function setMode(next) {
  if (!MODES.includes(next) || next === mode.value) return
  mode.value = next
  try {
    if (next === DEFAULT_MODE) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {}
  apply()
}

// 循环切换：跟随系统 → 亮色 → 暗色（侧边栏图标按钮用）
function cycleMode() {
  setMode(MODES[(MODES.indexOf(mode.value) + 1) % MODES.length])
}

export function useTheme() {
  return { mode, resolved, setMode, cycleMode, initTheme }
}
