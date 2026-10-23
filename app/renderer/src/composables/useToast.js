import { ref } from 'vue'

// 全局轻量提示，所有页面共用同一份状态
const toasts = ref([])
let seq = 0
// 每条提示的自动消失计时器：记录剩余时长，鼠标停留时暂停，方便读完整错误或点「复制」
const timers = new Map() // id -> { timeoutId, startedAt, remaining }

// 显示一条提示，type 支持 success / error / info
export function showToast(message, type = 'success', duration = 2600) {
  const id = ++seq
  toasts.value.push({ id, message, type })
  scheduleDismiss(id, duration)
  return id
}

function scheduleDismiss(id, duration) {
  const state = { timeoutId: 0, startedAt: Date.now(), remaining: duration }
  state.timeoutId = setTimeout(() => dismissToast(id), duration)
  timers.set(id, state)
}

// 暂停自动消失（鼠标移入提示条时调用）
export function pauseToast(id) {
  const state = timers.get(id)
  if (!state || !state.timeoutId) return
  clearTimeout(state.timeoutId)
  state.remaining = Math.max(0, state.remaining - (Date.now() - state.startedAt))
  state.timeoutId = 0
}

// 继续自动消失（鼠标移出提示条时调用），剩余时长已在暂停时扣减
export function resumeToast(id) {
  const state = timers.get(id)
  if (!state || state.timeoutId) return
  if (state.remaining <= 0) {
    dismissToast(id)
    return
  }
  state.startedAt = Date.now()
  state.timeoutId = setTimeout(() => dismissToast(id), state.remaining)
}

export function dismissToast(id) {
  const state = timers.get(id)
  if (state && state.timeoutId) clearTimeout(state.timeoutId)
  timers.delete(id)
  toasts.value = toasts.value.filter(item => item.id !== id)
}

export function useToast() {
  return { toasts, showToast, dismissToast, pauseToast, resumeToast }
}
