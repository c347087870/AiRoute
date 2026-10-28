import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'

// 页面数据的自动轮询（替代各页顶部栏的手动刷新）：
//   · 窗口隐藏（最小化 / 切走）时暂停，回到前台立即补一次，避免后台空转；
//   · 上一轮还没跑完就跳过本次，慢接口不会把请求越堆越多；
//   · 失败只进控制台：轮询没有用户手势，弹 toast 会变成周期性的干扰，
//     下一次轮询本来就会重试。
//
// 页面被 keep-alive 缓存后，切走不会卸载组件（onUnmounted 不触发），
// 所以「不在当前页」必须靠 onDeactivated 停表 —— 否则十个页面会一起在后台轮询。
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

  function start() {
    if (timer) return
    timer = setInterval(poll, interval)
  }

  function stop() {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  onMounted(() => {
    start()
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  // 切回这个页面：先立刻补一次，别让用户对着上一次离开时的旧数据。
  // 首次挂载时 onMounted 与 onActivated 都会触发，各页在 onMounted 里已经拉过一遍，
  // 这里跳过第一次，避免打开页面就发两遍同样的请求
  let activatedOnce = false
  onActivated(() => {
    start()
    if (!activatedOnce) {
      activatedOnce = true
      return
    }
    poll()
  })

  onDeactivated(stop)

  onUnmounted(() => {
    stop()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
}
