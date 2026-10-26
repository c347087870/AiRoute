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

      <!-- 新手引导：不是一个页面（没有路由），点了直接开全屏引导浮层。
          跳过或走完引导后它仍然留在这里 —— 用户下次想复习流程时不必去设置页找 -->
      <button class="nav-item nav-action" @click="startOnboarding(0)">
        <span class="nav-icon"><AppIcon name="onboarding" /></span>
        <span class="nav-label">新手引导</span>
      </button>
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
import { useOnboarding } from '../composables/useOnboarding.js'
import { isDevMode } from '../utils/dev-mode.js'

const isOnline = ref(false)

// 主题切换（唯一入口，设置页不再重复放一份）
const { mode: themeMode, setMode } = useTheme()

// 重新打开引导（首次启动时由 App.vue 自动拉起一次，这里管之后再打开）
const { startOnboarding } = useOnboarding()

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
  // 开发面板是一级页面而不是收进「高级功能」：它每天都要点开好几次（看端口、
  // 数据目录、失活原因），埋在两级菜单里要展开再找一次。正式版没有这条路由，
  // 所以只进开发模式的菜单 —— 否则点进去是空白页
  ...(isDevMode ? [{ path: '/dev', label: '开发面板', icon: 'dev' }] : []),
  {
    // 一级分组放在最后：低频但需要保留入口的页面收进这里，避免侧边栏越来越长
    key: 'advanced',
    label: '高级功能',
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
  width: 244px;
  min-width: 244px;
  background: var(--bg-card);
  border-right: 1px solid var(--border-1);
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.sidebar-header {
  min-height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-1);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-size: 17px;
  font-weight: 650;
  color: var(--text-1);
  letter-spacing: -0.035em;
}

/* 侧栏菜单是全站唯一的「大号菜单」：36px 高、13px 字，比紧凑的小号按钮大一档，
   扫视整列时不会挤成一片 */
.nav-items {
  flex: 1;
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  color: var(--text-2);
  text-decoration: none;
  font-size: 14px;
  font-weight: 450;
  transition: all 0.15s;
}

.nav-item:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

.nav-item.active {
  color: var(--text-1);
  background: var(--bg-hover);
  font-weight: 550;
}

.nav-icon {
  width: 20px;
  height: 20px;
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

/* 「新手引导」：动作按钮与导航项同一套外观。button 默认居中、
   自带字重与内边距，这里全部对齐 .nav-item 的链接，否则它比上面几项矮一截 */
.nav-action {
  width: 100%;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  text-align: left;
}

.nav-arrow {
  margin-left: auto;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--text-3);
  transition: transform 0.15s;
}

.nav-arrow.open {
  transform: rotate(180deg);
}

/* 二级菜单：左侧竖线 + 缩进表示层级，子项不再带图标（220px 宽放不下） */
.nav-children {
  margin: 2px 0 2px 26px;
  padding-left: 8px;
  border-left: 1px solid var(--border-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 二级项比一级略矮一档，字号同样取 13px */
.nav-child {
  height: 36px;
  padding: 0 12px;
  font-size: 13px;
}

/* 当前路由落在组内时，父项只变色不铺底色：底色留给真正所在的子项，
   否则父项和子项会同时高亮成两块 */
.nav-parent.active {
  background: transparent;
  color: var(--text-1);
  font-weight: 500;
}

.sidebar-footer {
  padding: 12px;
  border-top: 1px solid var(--border-1);
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
  padding: 3px;
  background: var(--bg-hover);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

/* 三格分段按钮与 SegmentedTabs 同一套观感：选中项浮起一层卡片色 */
.theme-btn {
  flex: 1;
  height: 24px;
  padding: 0;
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-small);
  line-height: 1;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.theme-btn:hover {
  color: var(--text-1);
}

.theme-btn.active {
  background: var(--bg-card);
  color: var(--text-1);
  border-color: var(--border-1);
  box-shadow: var(--shadow-card);
}
</style>
