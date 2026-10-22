<template>
  <nav class="sidebar">
    <div class="sidebar-header">
      <div class="logo">AiRoute</div>
      <StatusBadge :online="isOnline" />
    </div>

    <div class="nav-items">
      <template v-for="item in navItems" :key="item.path || item.key">
        <!-- 一级分组：本身没有页面，点击只展开/收起二级项 -->
        <div v-if="item.children" class="nav-group">
          <button
            class="nav-item nav-parent"
            :class="{ active: isGroupActive(item) }"
            :aria-expanded="!!openGroups[item.key]"
            @click="toggleGroup(item.key)"
          >
            <span class="nav-icon"><AppIcon :name="item.icon" /></span>
            <span class="nav-label">{{ item.label }}</span>
            <span class="nav-arrow" :class="{ open: !!openGroups[item.key] }">
              <AppIcon name="chevronDown" />
            </span>
          </button>
          <div v-show="openGroups[item.key]" class="nav-children">
            <router-link
              v-for="child in item.children"
              :key="child.path"
              :to="child.path"
              class="nav-item nav-child"
              :class="{ active: $route.path === child.path }"
            >
              <span class="nav-label">{{ child.label }}</span>
            </router-link>
          </div>
        </div>

        <router-link
          v-else
          :to="item.path"
          class="nav-item"
          :class="{ active: isItemActive(item) }"
        >
          <span class="nav-icon"><AppIcon :name="item.icon" /></span>
          <span class="nav-label">{{ item.label }}</span>
        </router-link>
      </template>
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
    </div>
  </nav>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import StatusBadge from './StatusBadge.vue'
import AppIcon from './AppIcon.vue'
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
  { path: '/dashboard', label: '状态面板', icon: 'dashboard' },
  // 免费账号已经并进渠道账号页当第三个 Tab；/workbuddy 作为它的子页面保留，
  // 但侧边栏不再单独占一项，所以这里用 alsoActive 让子页面期间「渠道账号」保持高亮
  { path: '/channels', label: '渠道账号', icon: 'channels', alsoActive: ['/workbuddy'] },
  { path: '/settings', label: '系统设置', icon: 'settings' },
  { path: '/tutorial', label: '使用教程', icon: 'tutorial' },
  {
    // 一级分组放在最后：低频但需要保留入口的页面收进这里，避免侧边栏越来越长
    key: 'advanced',
    label: '高级',
    icon: 'advanced',
    children: [
      { path: '/routing', label: '路由规则' },
      { path: '/providers', label: '模型来源' },
      { path: '/logs', label: '日志查看' },
      { path: '/token-stats', label: '用量统计' },
      { path: '/benchmark', label: '模型测分' }
    ]
  }
]

// 分组展开状态：默认全收起，但当前路由落在某组内时必须展开 ——
// 否则用户直接进 /routing 会看不到自己所在的菜单项
const route = useRoute()
const openGroups = ref({})
const isGroupActive = group => group.children.some(child => child.path === route.path)

// 一级项除了自身路径，还可能「代表」几个子页面（例如 /workbuddy 挂在渠道账号下）
const isItemActive = item =>
  route.path === item.path || (item.alsoActive || []).includes(route.path)

function syncGroupWithRoute() {
  for (const item of navItems) {
    if (item.children && isGroupActive(item)) openGroups.value[item.key] = true
  }
}

function toggleGroup(key) {
  openGroups.value[key] = !openGroups.value[key]
}

watch(() => route.path, syncGroupWithRoute, { immediate: true })

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
  font-size: var(--fs-lg);
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
  border-radius: var(--radius-md);
  color: var(--text-2);
  text-decoration: none;
  font-size: var(--fs-base);
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
  width: 18px;
  height: 18px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 一级分组标题：是按钮而不是链接（本身没有页面），需要抹掉 button 默认样式 */
.nav-parent {
  width: 100%;
  background: transparent;
  font-family: inherit;
  text-align: left;
}

.nav-arrow {
  margin-left: auto;
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--text-3);
  transition: transform 0.15s;
}

.nav-arrow.open {
  transform: rotate(180deg);
}

/* 二级菜单：左侧竖线 + 缩进表示层级，子项不再带图标（220px 宽放不下） */
.nav-children {
  margin: 2px 0 2px 24px;
  padding-left: 8px;
  border-left: 1px solid var(--border-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-child {
  padding: 8px 12px;
  font-size: var(--fs-small);
}

/* 当前路由落在组内时，父项只变色不铺底色：底色留给真正所在的子项，
   否则父项和子项会同时高亮成两块 */
.nav-parent.active {
  background: transparent;
  color: var(--text-1);
  font-weight: 500;
}

.sidebar-footer {
  padding: 14px;
  border-top: 1px solid var(--border-2);
}

.update-bar {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--primary-bg);
  color: var(--primary);
  font-size: var(--fs-xs);
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
  padding: 2px;
  background: var(--bg-page);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
}

.theme-btn {
  flex: 1;
  padding: 4px 0;
  background: transparent;
  color: var(--text-3);
  font-size: var(--fs-small);
  line-height: 1.4;
  border-radius: var(--radius-sm);
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
