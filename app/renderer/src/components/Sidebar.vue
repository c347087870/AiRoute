<template>
  <nav class="sidebar">
    <div class="sidebar-header">
      <div class="logo">AiRoute</div>
      <StatusBadge :online="isOnline" />
    </div>

    <div class="nav-items">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ active: $route.path === item.path }"
      >
        <span class="nav-icon">{{ item.icon }}</span>
        <span class="nav-label">{{ item.label }}</span>
      </router-link>
    </div>

    <div class="sidebar-footer">
      <ModelSwitcher />
    </div>
  </nav>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import StatusBadge from './StatusBadge.vue'
import ModelSwitcher from './ModelSwitcher.vue'
import { getHealth } from '../api.js'

const isOnline = ref(false)

const navItems = [
  { path: '/dashboard', label: '状态面板', icon: '◈' },
  { path: '/routing', label: '路由规则', icon: '◎' },
  { path: '/providers', label: 'Provider 管理', icon: '◇' },
  { path: '/logs', label: '日志查看', icon: '▤' },
  { path: '/settings', label: '设置', icon: '⚙' },
  { path: '/tutorial', label: '使用教程', icon: '✎' }
]

async function checkHealth() {
  try {
    await getHealth()
    isOnline.value = true
  } catch {
    isOnline.value = false
  }
}

onMounted(() => {
  checkHealth()
  setInterval(checkHealth, 5000)
})
</script>

<style scoped>
.sidebar {
  width: 220px;
  min-width: 220px;
  background: #FFFFFF;
  border-right: 1px solid #EEEEEE;
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.sidebar-header {
  padding: 24px 16px 16px;
  border-bottom: 1px solid #F0F0F0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-size: 19px;
  font-weight: 700;
  color: #0082FC;
  letter-spacing: 0.5px;
}

.nav-items {
  flex: 1;
  padding: 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-radius: 10px;
  color: #666666;
  text-decoration: none;
  font-size: 14px;
  transition: all 0.15s;
}

.nav-item:hover {
  color: #1A1A1A;
  background: #F5F5F5;
}

.nav-item.active {
  color: #0082FC;
  background: #0082FC0D;
  font-weight: 500;
}

.nav-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.sidebar-footer {
  padding: 14px;
  border-top: 1px solid #F0F0F0;
}
</style>
