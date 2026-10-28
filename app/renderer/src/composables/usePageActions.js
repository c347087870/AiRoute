import { reactive, onActivated, onDeactivated, onUnmounted } from 'vue'

// 顶部栏右侧的「实时」角标：页面在 setup 里登记自己是否自动刷新，
// 位置和样式由布局统一管。页面卸载时自动清空，切页不会残留上一页的角标。
const state = reactive({
  live: false // 是否显示「实时」角标（跟着页面的自动轮询走）
})

// 新页面 setup 早于旧页面 unmount，用 token 判断「这份登记还是不是我的」，
// 否则旧页面的清理回调会把新页面刚登记的状态抹掉
let owner = null

export function usePageActions({ live = false } = {}) {
  const token = Symbol('page-actions')

  // 页面被 keep-alive 缓存后切走不会卸载：角标必须跟着「当前显示的是哪一页」走，
  // 所以激活时重新登记、失活时清掉，否则切到没有自动刷新的页面时角标会一直挂着
  const claim = () => {
    owner = token
    state.live = live
  }
  const release = () => {
    if (owner !== token) return
    owner = null
    state.live = false
  }

  claim()
  onActivated(claim)
  onDeactivated(release)
  onUnmounted(release)
}

// 布局（App.vue 顶部栏）读这份状态
export function getPageActions() {
  return state
}
