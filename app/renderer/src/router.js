import { createRouter, createWebHashHistory } from 'vue-router'
import Dashboard from './views/Dashboard.vue'
import RoutingRules from './views/RoutingRules.vue'
import Providers from './views/Providers.vue'
import Logs from './views/Logs.vue'
import TokenStats from './views/TokenStats.vue'
import Benchmark from './views/Benchmark.vue'
import Settings from './views/Settings.vue'
import Tutorial from './views/Tutorial.vue'

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'Dashboard', component: Dashboard },
  { path: '/routing', name: 'RoutingRules', component: RoutingRules },
  { path: '/providers', name: 'Providers', component: Providers },
  { path: '/logs', name: 'Logs', component: Logs },
  { path: '/token-stats', name: 'TokenStats', component: TokenStats },
  { path: '/benchmark', name: 'Benchmark', component: Benchmark },
  { path: '/settings', name: 'Settings', component: Settings },
  { path: '/tutorial', name: 'Tutorial', component: Tutorial }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
