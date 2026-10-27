import { createRouter, createWebHashHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import RoutingRules from './views/RoutingRules.vue'
import Providers from './views/Providers.vue'
import WorkbuddyPool from './views/WorkbuddyPool.vue'
import Channels from './views/Channels.vue'
import Logs from './views/Logs.vue'
import TokenStats from './views/TokenStats.vue'
import Benchmark from './views/Benchmark.vue'
import Settings from './views/Settings.vue'
import Tutorial from './views/Tutorial.vue'

// 页面标题与返回按钮由布局（App.vue）统一渲染，页面内不再写 <h1>；
// back 表示二级页面，顶部栏左侧显示返回按钮
const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'Dashboard', component: Dashboard, meta: { title: '状态面板' } },
  { path: '/routing', name: 'RoutingRules', component: RoutingRules, meta: { title: '路由规则', back: true } },
  { path: '/providers', name: 'Providers', component: Providers, meta: { title: 'Provider 管理', back: true } },
  { path: '/workbuddy', name: 'WorkbuddyPool', component: WorkbuddyPool, meta: { title: 'WorkBuddy 账号池', back: true } },
  { path: '/channels', name: 'Channels', component: Channels, meta: { title: '渠道账号' } },
  { path: '/logs', name: 'Logs', component: Logs, meta: { title: '日志查看', back: true } },
  { path: '/token-stats', name: 'TokenStats', component: TokenStats, meta: { title: 'Token 使用统计', back: true } },
  { path: '/benchmark', name: 'Benchmark', component: Benchmark, meta: { title: '模型测分', back: true } },
  { path: '/settings', name: 'Settings', component: Settings, meta: { title: '系统设置' } },
  { path: '/tutorial', name: 'Tutorial', component: Tutorial, meta: { title: '使用教程' } }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
