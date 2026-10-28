import { reactive, onUnmounted } from 'vue'

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
  owner = token
  state.live = live

  onUnmounted(() => {
    if (owner !== token) return
    owner = null
    state.live = false
  })
}

// 布局（App.vue 顶部栏）读这份状态
export function getPageActions() {
  return state
}
