import { ref } from 'vue'

// 全局轻量提示，所有页面共用同一份状态
const toasts = ref([])
let seq = 0

// 显示一条提示，type 支持 success / error / info
export function showToast(message, type = 'success', duration = 2600) {
  const id = ++seq
  toasts.value.push({ id, message, type })
  setTimeout(() => dismissToast(id), duration)
  return id
}

export function dismissToast(id) {
  toasts.value = toasts.value.filter(item => item.id !== id)
}

export function useToast() {
  return { toasts, showToast, dismissToast }
}
