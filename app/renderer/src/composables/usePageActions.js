import { reactive, onUnmounted } from 'vue'

// 顶部栏右侧动作（刷新 / 实时角标）：这些操作只跟当前页有关，但位置和样式由布局统一管，
// 所以页面在 setup 里登记自己的刷新函数与 loading，布局只读这份状态。
// 页面卸载时自动清空，切页不会残留上一页的按钮。
const state = reactive({
  refresh: null, // 当前页的刷新函数；null 表示本页没有刷新动作
  loading: false, // 刷新中（页面传入的 ref 会被 reactive 解包，模板里直接 actions.loading）
  live: false // 是否显示「实时」角标（跟着轮询走，目前只有状态面板有）
})

// 新页面 setup 早于旧页面 unmount，用 token 判断「这份登记还是不是我的」，
// 否则旧页面的清理回调会把新页面刚登记的动作抹掉
let owner = null

export function usePageActions({ refresh, loading, live = false }) {
  const token = Symbol('page-actions')
  owner = token
  state.refresh = refresh
  state.loading = loading || false
  state.live = live

  onUnmounted(() => {
    if (owner !== token) return
    owner = null
    state.refresh = null
    state.loading = false
    state.live = false
  })
}

// 布局（App.vue 顶部栏）读这份状态
export function getPageActions() {
  return state
}
