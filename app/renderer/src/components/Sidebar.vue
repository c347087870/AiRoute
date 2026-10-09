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
      <div v-if="showUpdate" class="update-bar" :class="{ busy: downloading }" @click="onUpdateClick">
        {{ updateText }}
      </div>
      <ModelSwitcher />
    </div>
  </nav>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import StatusBadge from './StatusBadge.vue'
import ModelSwitcher from './ModelSwitcher.vue'
import { getHealth } from '../api.js'
import { useUpdate } from '../composables/useUpdate.js'

const isOnline = ref(false)

const navItems = [
  { path: '/dashboard', label: '状态面板', icon: '◈' },
  { path: '/routing', label: '路由规则', icon: '◎' },
  { path: '/providers', label: 'Provider 管理', icon: '◇' },
  { path: '/workbuddy', label: '账号池', icon: '⬢' },
  { path: '/logs', label: '日志查看', icon: '▤' },
  { path: '/token-stats', label: 'Token 统计', icon: '◉' },
  { path: '/benchmark', label: '模型测分', icon: '★' },
  { path: '/settings', label: '设置', icon: '⚙' },
  { path: '/tutorial', label: '使用教程', icon: '✎' }
]

// 更新功能共享状态（发现新版本时底部显示提示条）
const { info, downloading, percent, savedPath, startDownload, openFolder, initUpdate } = useUpdate()

// 是否显示更新提示条（仅在发现新版本时可见）
const showUpdate = computed(() => !!info.value?.hasUpdate)

// 提示条文案：未下载→发现新版本；下载中→百分比；已下载→打开文件夹
const updateText = computed(() => {
  if (downloading.value) return `下载中 ${percent.value}%`
  if (savedPath.value) return '下载完成，点击打开文件夹'
  return `发现新版本 v${info.value.latest}`
})

// 点击提示条：未下载则开始下载，已下载则打开文件夹
function onUpdateClick() {
  if (downloading.value) return
  if (savedPath.value) openFolder()
  else startDownload()
}

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
  initUpdate()
})
</script>

<style scoped>
.sidebar {
  width: 220px;
  min-width: 220px;
  background: #FFFFFF;
  border-right: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.sidebar-header {
  padding: 24px 16px 16px;
  border-bottom: 1px solid var(--border-2);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-size: 19px;
  font-weight: 700;
  color: var(--primary);
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
  color: var(--text-2);
  text-decoration: none;
  font-size: 14px;
  transition: all 0.15s;
}

.nav-item:hover {
  color: var(--text-1);
  background: var(--bg-page);
}

.nav-item.active {
  color: var(--primary);
  background: var(--primary-bg);
  font-weight: 500;
}

.nav-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.sidebar-footer {
  padding: 14px;
  border-top: 1px solid var(--border-2);
}

.update-bar {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 12px;
  font-weight: 500;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.update-bar:hover {
  background: rgba(0, 130, 252, 0.14);
}

.update-bar.busy {
  color: var(--text-2);
  background: var(--bg-page);
  cursor: default;
}
</style>
