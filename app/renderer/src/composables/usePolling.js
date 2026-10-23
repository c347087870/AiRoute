import { onMounted, onUnmounted } from 'vue'

// 页面数据的自动轮询（替代各页顶部栏的手动刷新）：
//   · 窗口隐藏（最小化 / 切走）时暂停，回到前台立即补一次，避免后台空转；
//   · 上一轮还没跑完就跳过本次，慢接口不会把请求越堆越多；
//   · 失败只进控制台：轮询没有用户手势，弹 toast 会变成周期性的干扰，
//     下一次轮询本来就会重试。
//
// 默认 5 秒：本地服务开销很小，足够让页面跟上正在跑的变化。
export function usePolling(task, interval = 5000) {
  let timer = null
  let busy = false

  async function poll() {
    if (document.hidden || busy) return
    busy = true
    try {
      await task()
    } catch (err) {
      console.error('[polling] 自动刷新失败:', err)
    } finally {
      busy = false
    }
  }

  function onVisibilityChange() {
    if (!document.hidden) poll()
  }

  onMounted(() => {
    timer = setInterval(poll, interval)
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
}
