<template>
  <nav class="sidebar" :class="{ 'is-mac': isMac }">
    <div class="sidebar-header">
      <div class="brand">
        <img class="brand-icon" :src="appIcon" alt="" />
        <span class="logo">AiRoute</span>
      </div>
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
        <AppIcon :name="item.icon" class="nav-icon" />
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
import { useRouter } from 'vue-router'

import StatusBadge from './StatusBadge.vue'
import ModelSwitcher from './ModelSwitcher.vue'
import AppIcon from './AppIcon.vue'
import appIcon from '../assets/app-icon.png'
import { getHealth } from '../api.js'
import { useUpdate } from '../composables/useUpdate.js'

const isMac = window.electronAPI?.platform === 'darwin'
const isOnline = ref(false)

const navItems = [
  { path: '/dashboard', label: '状态面板', icon: 'dashboard' },
  { path: '/routing', label: '路由规则', icon: 'routing' },
  { path: '/providers', label: 'Provider 管理', icon: 'providers' },
  { path: '/workbuddy', label: '账号池', icon: 'pool' },
  { path: '/logs', label: '日志查看', icon: 'logs' },
  { path: '/token-stats', label: 'Token 统计', icon: 'stats' },
  { path: '/benchmark', label: '模型测分', icon: 'benchmark' },
  { path: '/settings', label: '设置', icon: 'settings' },
  { path: '/developer', label: '开发者选项', icon: 'developer' },
  { path: '/tutorial', label: '使用教程', icon: 'tutorial' }
]

// 更新功能共享状态（发现新版本时底部显示提示条）
const {
  info,
  downloading,
  installing,
  percent,
  savedPath,
  canDownload,
  isLocalBuild,
  runCheck,
  startDownload,
  openFolder,
  openReleasePage,
  initUpdate
} = useUpdate()
const router = useRouter()

// 是否显示更新提示条（仅在发现新版本时可见）
const showUpdate = computed(() => !!info.value?.hasUpdate)

// 提示条文案：本地构建引导到设置页安装；远程版本未下载→发现新版本；
// 下载中→百分比；已下载→打开文件夹
const updateText = computed(() => {
  if (installing.value) return '正在安装并重启…'
  if (isLocalBuild()) return `本地构建 v${info.value.latest} · 去安装`
  if (downloading.value) return `下载中 ${percent.value}%`
  if (savedPath.value) return '下载完成，点击打开文件夹'
  if (!canDownload()) return `新版本 v${info.value.latest} · 查看发布页`
  return `发现新版本 v${info.value.latest}`
})

// 点击提示条：本地构建先跳到设置页确认安装；远程版本未下载则开始下载，已下载则打开文件夹
function onUpdateClick() {
  if (installing.value || downloading.value) return
  if (isLocalBuild()) {
    router.push('/settings')
    return
  }
  if (savedPath.value) openFolder()
  else if (!canDownload()) openReleasePage()
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
  // 构建完成后主进程会写本地构建记录；这里主动刷新一次，侧边栏无需等下一轮检查
  if (window.electronAPI?.devBuild?.onDone) {
    window.electronAPI.devBuild.onDone(result => {
      if (result?.ok) runCheck(true, true)
    })
  }
})
</script>

<style scoped>
.sidebar {
  width: 224px;
  min-width: 224px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  height: 100vh;
  -webkit-app-region: drag;
}

/* macOS：顶部让出交通灯高度，整条侧栏顶部可拖拽窗口 */
.sidebar.is-mac .sidebar-header {
  padding-top: 48px;
}

.sidebar-header {
  padding: 20px 16px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.brand-icon {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14);
}

.logo {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
  letter-spacing: -0.2px;
}

.nav-items {
  flex: 1;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  -webkit-app-region: no-drag;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text-2);
  text-decoration: none;
  font-size: var(--fs-base);
  transition: background 0.12s, color 0.12s;
}

.nav-item:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

.nav-item.active {
  color: var(--text-1);
  background: rgba(0, 0, 0, 0.07);
  font-weight: 500;
}

/* 侧栏在背景图模式下是半透明玻璃，用白色胶囊代替加深底色，
   选中项才不会和透出来的图片糊在一起 */
:global(.has-app-bg) .nav-item.active {
  background: rgba(255, 255, 255, 0.78);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.05);
}

:global(.has-app-bg) .nav-item:hover {
  background: rgba(255, 255, 255, 0.5);
}

.nav-icon {
  color: var(--text-3);
  transition: color 0.12s;
}

.nav-item:hover .nav-icon {
  color: var(--text-2);
}

.nav-item.active .nav-icon {
  color: var(--primary);
}

.sidebar-footer {
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border-1);
  -webkit-app-region: no-drag;
}

.update-bar {
  margin-bottom: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: var(--fs-xs);
  font-weight: 500;
  text-align: center;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.update-bar:hover {
  background: rgba(0, 122, 255, 0.16);
}

.update-bar.busy {
  color: var(--text-2);
  background: var(--bg-hover);
  cursor: default;
}
</style>
