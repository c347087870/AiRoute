import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue'

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

  // keep-alive 下切走的页面不会被卸载，监听要跟着「当前是不是这一页」挂/摘：
  // 否则被缓存的页面会继续响应 Esc，关闭一个用户根本看不见的弹窗。
  // onMounted 也挂一次：同一个函数重复 add 是无操作，但页面若不在 keep-alive 里
  // 就只有 onMounted 会触发
  function bind() {
    window.addEventListener('keydown', onKeydown)
  }
  function unbind() {
    window.removeEventListener('keydown', onKeydown)
  }

  onMounted(bind)
  onActivated(bind)
  onDeactivated(unbind)
  onBeforeUnmount(unbind)
}
