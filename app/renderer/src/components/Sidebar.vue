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
      <div v-if="showUpdate" class="update-bar" :class="{ busy }" @click="onUpdateClick">
        {{ updateText }}
      </div>
      <div class="theme-switch" role="group" aria-label="主题">
        <button
          v-for="item in themeOptions"
          :key="item.value"
          class="theme-btn"
          :class="{ active: themeMode === item.value }"
          :title="item.label"
          :aria-pressed="themeMode === item.value"
          @click="setMode(item.value)"
        >
          {{ item.icon }}
        </button>
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
import { useTheme } from '../composables/useTheme.js'

const isOnline = ref(false)

// 主题切换（与设置页「外观」共享同一份状态）
const { mode: themeMode, setMode } = useTheme()

// 三种主题模式：图标 + 悬停说明
const themeOptions = [
  { value: 'system', icon: '◐', label: '跟随系统' },
  { value: 'light', icon: '☀', label: '亮色' },
  { value: 'dark', icon: '☾', label: '暗色' }
]

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

// 更新功能共享状态（发现新版本时底部显示一键升级提示条）
const { info, busy, stageText, installError, supported, initUpdate, oneClickUpdate } = useUpdate()

// 是否显示更新提示条（仅在发现新版本时可见）
const showUpdate = computed(() => !!info.value?.hasUpdate)

// 提示条文案：升级中显示当前阶段，失败可点击重试；
// 不支持一键升级（便携版 / 浏览器模式）时只提示新版本，点击会给出原因与手动下载指引
const updateText = computed(() => {
  if (busy.value) return stageText.value || '升级中…'
  if (installError.value) return '升级失败，点击重试'
  if (!supported.value) return `发现新版本 v${info.value.latest} · 手动下载`
  return `发现新版本 v${info.value.latest} · 一键升级`
})

// 点击提示条：直接走一键升级（下载 → 校验 → 备份 / 安装 → 重启）
function onUpdateClick() {
  if (busy.value) return
  oneClickUpdate()
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
  background: var(--bg-card);
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
  background: var(--primary-bg-hover);
}

.update-bar.busy {
  color: var(--text-2);
  background: var(--bg-page);
  cursor: default;
}

/* 主题切换：三格分段按钮（跟随系统 / 亮色 / 暗色） */
.theme-switch {
  display: flex;
  gap: 2px;
  margin-bottom: 10px;
  padding: 2px;
  background: var(--bg-page);
  border: 1px solid var(--border-2);
  border-radius: 9px;
}

.theme-btn {
  flex: 1;
  padding: 4px 0;
  background: transparent;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.4;
  border-radius: 7px;
}

.theme-btn:hover {
  color: var(--text-1);
}

.theme-btn.active {
  background: var(--bg-card);
  color: var(--primary);
  box-shadow: var(--shadow-card);
}
</style>
