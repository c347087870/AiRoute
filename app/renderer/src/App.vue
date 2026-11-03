<template>
  <div class="app-layout" :class="{ 'is-mac': isMac }">
    <!-- 自定义背景层：fixed 铺满窗口，与页面滚动无关 -->
    <div
      v-if="hasBackground"
      class="app-bg"
      :class="[`bg-fit-${bgFit}`, { 'is-blurred': bgBlurred }]"
      aria-hidden="true"
    ></div>
    <!-- macOS 隐藏标题栏后，顶部留一条可拖拽区域；交通灯由系统绘制在左上角 -->
    <div v-if="isMac" class="titlebar-drag"></div>
    <Sidebar />
    <main class="main-content">
      <!-- 开发者页缓存：离开页面时内嵌终端与构建日志不销毁，回来后继续可用 -->
      <router-view v-slot="{ Component }">
        <keep-alive include="DeveloperView">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
  </div>
  <ToastHost />
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ToastHost from './components/ToastHost.vue'
import { useAppearance } from './composables/useAppearance.js'

// 浏览器直接打开开发页时没有 electronAPI，按非 mac 处理
const isMac = ref(window.electronAPI?.platform === 'darwin')

const { state: appearance, hasBackground, init: initAppearance } = useAppearance()
const bgFit = computed(() => appearance.settings.fit || 'cover')
const bgBlurred = computed(() => (appearance.settings.blur || 0) > 0)

onMounted(() => {
  if (isMac.value) document.documentElement.classList.add('platform-mac')
  // 背景与主题色在首屏加载后立即生效；失败时保持默认样式
  initAppearance()
})
</script>

<style>
/* ==================== 设计令牌（统一设计体系） ==================== */
:root {
  /* 品牌色：macOS 系统蓝 */
  --primary: #007AFF;
  --primary-hover: #0069DB;
  --primary-bg: rgba(0, 122, 255, 0.1);

  /* 语义色：取自 macOS 系统色板 */
  --success: #34C759;
  --danger: #FF3B30;
  --danger-hover: #E0342B;
  --warning: #FF9F0A;
  --purple: #AF52DE;

  /* 文本色：由深到浅四级（接近系统 label / secondaryLabel） */
  --text-1: #1D1D1F;
  --text-2: #515154;
  --text-3: #86868B;
  --text-4: #AEAEB2;

  /* 背景与边框 */
  --bg-page: #F5F5F7;
  --bg-sidebar: #F0F0F2;
  --bg-card: #FFFFFF;
  /* 控件底色（chip / 下拉 / 分段按钮）：默认与页面同色的浅灰，开启背景图后变成半透明白 */
  --bg-control: #F5F5F7;
  /* 需要「盖住下方内容」的表面（表头吸顶、表格冻结列、浮层）：默认纯白，
     开启背景图后是接近不透明的白，避免透出滚动内容 */
  --bg-solid: #FFFFFF;
  --bg-hover: rgba(0, 0, 0, 0.035);
  --border-1: rgba(0, 0, 0, 0.06);
  --border-2: rgba(0, 0, 0, 0.05);
  --border-3: rgba(0, 0, 0, 0.12);

  /* 圆角：贴近 macOS 控件 */
  --radius-lg: 14px;
  --radius-md: 9px;
  --radius-sm: 7px;
  --radius-pill: 20px;

  /* 阴影：轻、低对比 */
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 16px rgba(0, 0, 0, 0.03);

  /* 字号 */
  --fs-title: 26px;
  --fs-section: 15px;
  --fs-base: 13.5px;
  --fs-small: 12.5px;
  --fs-xs: 12px;
  --fs-mini: 11px;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC',
    'Helvetica Neue', 'Microsoft YaHei', sans-serif;
  background: var(--bg-page);
  color: var(--text-1);
  overflow: hidden;
  height: 100vh;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.16);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: content-box;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.28);
  background-clip: content-box;
}

.app-layout {
  display: flex;
  height: 100vh;
  position: relative;
  background: var(--bg-page);
}

/* ==================== 自定义背景 ==================== */

.app-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

/* 图片单独一层：透明度只作用于图片本身，不影响压暗遮罩，
   而且调低透明度后能透出窗口底色，比单纯压低亮度自然 */
.app-bg::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: var(--app-bg-image);
  background-repeat: no-repeat;
  background-position: center;
  opacity: var(--app-bg-opacity, 1);
}

/* 模糊时略微放大，避免边缘出现透明缝；不模糊时保持原尺寸 */
.is-blurred::before {
  filter: blur(var(--app-bg-blur));
  transform: scale(1.04);
}

.bg-fit-cover::before {
  background-size: cover;
}

.bg-fit-contain::before {
  background-size: contain;
}

.bg-fit-stretch::before {
  background-size: 100% 100%;
}

.bg-fit-tile::before {
  background-repeat: repeat;
  background-size: auto;
}

/* 淡化层盖在图片上：应用整体是浅色界面，用白色蒙层把背景提亮，
   深色壁纸上的深色文字才不会糊成一片。强度由 useAppearance 按图片亮度自动兜底 */
.app-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, var(--app-bg-dim));
}

/* 内容层压在背景层之上；titlebar-drag 本身是 fixed，不能再改 position */
.app-layout > .sidebar,
.app-layout > .main-content {
  position: relative;
  z-index: 1;
}

.app-layout > .titlebar-drag {
  z-index: 2;
}

/* 仅 mac 窗口使用：覆盖顶部 36px 作为拖拽条，页面内容已在下方留白 */
.titlebar-drag {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 36px;
  z-index: 1000;
  -webkit-app-region: drag;
}

.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px 36px;
}

.is-mac .main-content {
  padding-top: 46px;
}

input, select, textarea {
  background: var(--bg-card);
  border: 1px solid var(--border-3);
  color: var(--text-1);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  font-size: var(--fs-base);
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

input:focus, select:focus, textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3.5px rgba(0, 122, 255, 0.18);
}

input::placeholder, textarea::placeholder {
  color: var(--text-4);
}

select option {
  background: var(--bg-card);
  color: var(--text-1);
}

select {
  appearance: auto;
}

button {
  cursor: pointer;
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--fs-base);
  font-family: inherit;
  transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.btn-primary {
  background: var(--primary);
  color: #fff;
  padding: 7px 18px;
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 122, 255, 0.25);
}

.btn-primary:hover {
  background: var(--primary-hover);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-danger {
  background: var(--danger);
  color: #fff;
  padding: 7px 18px;
  font-weight: 500;
}

.btn-danger:hover {
  background: var(--danger-hover);
}

.btn-ghost {
  background: var(--bg-card);
  color: var(--text-2);
  padding: 7px 15px;
  border: 1px solid var(--border-3);
}

.btn-ghost:hover {
  color: var(--text-1);
  background: #FAFAFC;
}

.btn-sm {
  padding: 4px 11px;
  font-size: var(--fs-xs);
  border-radius: var(--radius-sm);
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
  box-shadow: var(--shadow-card);
}

/* 自定义背景开启后：卡片、侧栏、控件统一为「白色玻璃」，
   不再出现灰蒙层 / 白底混用的情况 */
.has-app-bg .card {
  backdrop-filter: blur(20px) saturate(1.7);
  -webkit-backdrop-filter: blur(20px) saturate(1.7);
  border-color: rgba(255, 255, 255, 0.55);
}

.has-app-bg .sidebar {
  backdrop-filter: blur(30px) saturate(1.8);
  -webkit-backdrop-filter: blur(30px) saturate(1.8);
  border-right-color: rgba(255, 255, 255, 0.4);
}

/* 输入框不做半透明：用户要能看清正在输入的内容 */
.has-app-bg input,
.has-app-bg select,
.has-app-bg textarea {
  background: rgba(255, 255, 255, 0.95);
}

/* 幽灵按钮 / 芯片 / 分段按钮统一走控件表面色，避免「全透明压图」 */
.has-app-bg .btn-ghost {
  background: var(--bg-control);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.has-app-bg .btn-ghost:hover {
  background: rgba(255, 255, 255, 0.95);
}

/* 页面标题统一为 macOS 大标题风格 */
.page-title {
  font-size: var(--fs-title);
  font-weight: 700;
  letter-spacing: -0.4px;
  color: var(--text-1);
}
</style>
