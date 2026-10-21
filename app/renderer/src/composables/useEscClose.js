import { onMounted, onBeforeUnmount } from 'vue'

// 弹窗按 Esc 关闭。
// isOpen 传函数：调用方可以把多个弹窗状态合并成一个可见性判断，
// close 与点「取消」/「×」走同一套收尾逻辑，避免出现只置空部分状态的半关闭。
export function useEscClose(isOpen, close) {
  function onKeydown(event) {
    if (event.key !== 'Escape') return
    if (event.isComposing) return // 输入法组词中，Esc 只用于取消候选，不关弹窗
    if (!isOpen()) return
    event.preventDefault()
    close()
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
