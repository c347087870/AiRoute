<template>
  <div class="app-layout">
    <Sidebar />
    <main class="main-content">
      <!-- 页面标题由布局统一接管并常驻顶部：切页只换文字，不参与内容滚动 -->
      <header class="top-bar">
        <BackButton v-if="route.meta.back" />
        <h1 class="top-title">{{ route.meta.title }}</h1>
        <!-- 「实时」角标由页面登记（usePageActions），布局只负责摆在标题右侧 -->
        <div v-if="actions.live" class="top-actions">
          <span
            class="live-badge"
            title="数据自动刷新：窗口隐藏时暂停，回到前台立即刷新"
          >
            <span class="live-dot"></span>实时
          </span>
        </div>
      </header>
      <div class="main-scroll">
        <router-view />
      </div>
    </main>
  </div>
  <ToastHost />
</template>

<script setup>
import { useRoute } from 'vue-router'
import Sidebar from './components/Sidebar.vue'
import BackButton from './components/BackButton.vue'
import ToastHost from './components/ToastHost.vue'
import { useTheme } from './composables/useTheme.js'
import { getPageActions } from './composables/usePageActions.js'

const route = useRoute()
const actions = getPageActions()

// 尽早应用主题：index.html 的首屏脚本已先铺一次，这里接管后续的切换与系统变化监听
useTheme().initTheme()
</script>

<style>
/* ==================== 设计令牌（统一设计体系） ==================== */
/* 亮色是默认主题；暗色通过 <html data-theme="dark"> 覆盖同一批颜色令牌（见下方）。
   组件里一律引用变量，不要再写死色值，否则暗色下会残留浅色块。 */
:root {
  color-scheme: light;

  /* 品牌色 */
  --primary: #0082FC;
  --primary-hover: #006FDB;
  --primary-bg: rgba(0, 130, 252, 0.08);
  --primary-bg-hover: rgba(0, 130, 252, 0.14);
  --primary-text: #1976D2;

  /* 语义色 */
  --success: #00B578;
  --danger: #FF3B30;
  --danger-hover: #E0342B;
  --warning: #FF9500;
  --warning-text: #B45309;
  --purple: #9C27B0;
  --purple-text: #7B1FA2;
  --purple-border: #D6BCFA;

  /* 状态色（账号池 / 检测结果）：文字色与底色成对使用 */
  --ok-text: #16A34A;
  --ok-bg: #ECFDF5;
  --warn-text: #D97706;
  --warn-bg: #FFFBEB;
  --bad-text: #DC2626;
  --bad-bg: #FEF2F2;

  /* 文本色：由深到浅四级 + 场景补充（弱化说明 / 等宽值 / 正文） */
  --text-1: #1A1A1A;
  --text-2: #666666;
  --text-3: #999999;
  --text-4: #CCCCCC;
  --text-body: #444444;
  --text-strong: #555555;
  --text-weak: #B0B0B0;
  --text-faint: #C0C0C0;

  /* 背景与边框 */
  --bg-page: #F5F5F5;
  --bg-card: #FFFFFF;
  --bg-elevated: #FFFFFF;
  --bg-hover: #FAFAFA;
  --bg-subtle: #FAFCFF;
  --bg-inset: #F8F8F8;
  --bg-chip: #EEF3FA;
  --bg-code: #F0F4F8;
  --bg-note: #EEF6FF;
  --border-1: #EEEEEE;
  --border-2: #F0F0F0;
  --border-3: #E0E0E0;

  /* 浅色底：徽标 / 提示块 / 高亮行 */
  --tint-primary: #F0F7FF;
  --tint-primary-soft: #E3F2FD;
  --tint-success: #E6F7F0;
  --tint-success-soft: #F3FDF8;
  --tint-danger: #FFEBEA;
  --tint-warning: #FFF7ED;
  --tint-warning-soft: #FFF3E0;
  --tint-purple: #F3E5F5;
  --tint-purple-soft: #F6EEF8;
  --tint-neutral: rgba(0, 0, 0, 0.06);

  /* 遮罩与阴影 */
  --overlay: rgba(0, 0, 0, 0.35);
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.04);
  --shadow-hover: 0 2px 10px rgba(0, 0, 0, 0.05);
  --shadow-pop: 0 4px 16px rgba(0, 0, 0, 0.12);

  /* 滚动条 */
  --scrollbar-thumb: #D0D0D0;
  --scrollbar-thumb-hover: #B0B0B0;

  /* 图表 */
  --chart-grid: #E0E0E0;
  --chart-active: #FF5722;

  /* 圆角阶梯：4 标签/徽标 · 8 小控件 · 10 卡片与按钮 · 14 大面板 · pill 胶囊 */
  --radius-xs: 4px;
  --radius-lg: 14px;
  --radius-md: 10px;
  --radius-sm: 8px;
  --radius-pill: 20px;

  /* 字号阶梯：24 大数字 · 22 页面标题 · 18 面板标题 · 16 区块标题 ·
     14 正文 · 13 次要 · 12 辅助 · 11 标签 */
  --fs-display: 24px;
  --fs-title: 22px;
  --fs-lg: 18px;
  --fs-section: 16px;
  --fs-base: 14px;
  --fs-small: 13px;
  --fs-xs: 12px;
  --fs-mini: 11px;
}

/* 暗色主题：只覆盖颜色，圆角/字号/间距与亮色共用 */
html[data-theme='dark'] {
  color-scheme: dark;

  --primary: #0082FC;
  --primary-hover: #2A93FF;
  --primary-bg: rgba(0, 130, 252, 0.18);
  --primary-bg-hover: rgba(0, 130, 252, 0.28);
  --primary-text: #64B5F6;

  --success: #00B578;
  --danger: #FF453A;
  --danger-hover: #E0342B;
  --warning: #FF9500;
  --warning-text: #FBBF24;
  --purple: #C77DE0;
  --purple-text: #C79BE8;
  --purple-border: #6D4A9E;

  --ok-text: #4ADE80;
  --ok-bg: rgba(34, 197, 94, 0.16);
  --warn-text: #FBBF24;
  --warn-bg: rgba(217, 119, 6, 0.18);
  --bad-text: #F87171;
  --bad-bg: rgba(220, 38, 38, 0.18);

  --text-1: #E8EAED;
  --text-2: #A8ADB6;
  --text-3: #7D828C;
  --text-4: #5A5F68;
  --text-body: #C4C8D0;
  --text-strong: #B6BAC3;
  --text-weak: #8A8F99;
  --text-faint: #6E737D;

  --bg-page: #141518;
  --bg-card: #1C1D22;
  --bg-elevated: #26272E;
  --bg-hover: #22232A;
  --bg-subtle: #1F2128;
  --bg-inset: #17181C;
  --bg-chip: #2A2D36;
  --bg-code: #2A2D36;
  --bg-note: #1E2A3A;
  --border-1: #2A2C33;
  --border-2: #26282F;
  --border-3: #353841;

  --tint-primary: rgba(0, 130, 252, 0.16);
  --tint-primary-soft: rgba(0, 130, 252, 0.22);
  --tint-success: rgba(0, 181, 120, 0.16);
  --tint-success-soft: rgba(0, 181, 120, 0.1);
  --tint-danger: rgba(255, 69, 58, 0.16);
  --tint-warning: rgba(255, 149, 0, 0.14);
  --tint-warning-soft: rgba(255, 149, 0, 0.18);
  --tint-purple: rgba(199, 125, 224, 0.16);
  --tint-purple-soft: rgba(199, 125, 224, 0.12);
  --tint-neutral: rgba(255, 255, 255, 0.1);

  --overlay: rgba(0, 0, 0, 0.6);
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.5);
  --shadow-hover: 0 2px 10px rgba(0, 0, 0, 0.45);
  --shadow-pop: 0 6px 20px rgba(0, 0, 0, 0.55);

  --scrollbar-thumb: #3A3D45;
  --scrollbar-thumb-hover: #4A4E58;

  --chart-grid: #33363D;
  --chart-active: #FF7043;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'MiSans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  background: var(--bg-page);
  color: var(--text-1);
  overflow: hidden;
  height: 100vh;
}

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

.app-layout {
  display: flex;
  height: 100vh;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* 顶部标题栏：常驻，不随页面内容滚动。
   高度与侧边栏 header 对齐（实测 62.5px），两条分隔线连成一条；
   底色跟侧边栏一致用 --bg-card，否则左侧白、上方灰会割成两块 */
.top-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 62px;
  flex: none;
  padding: 0 32px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-2);
}

.top-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-1);
}

/* 标题栏右侧动作：刷新 / 实时。margin-left:auto 把它顶到最右，
   页面里不再各自放一份，切页时随登记状态出现或消失 */
.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

/* 实时刷新提示：绿点带一圈柔光和呼吸动画，静止时也能看出「在跑」 */
.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--tint-success);
  animation: live-pulse 2s ease-in-out infinite;
}

@keyframes live-pulse {
  0%,
  100% {
    opacity: 0.4;
  }

  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot {
    animation: none;
  }
}

/* 页面内容滚动区：标题栏之外的部分独立滚动 */
.main-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px 28px;
}

input, select, textarea {
  background: var(--bg-card);
  border: 1px solid var(--border-3);
  color: var(--text-1);
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: var(--fs-base);
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

input:focus, select:focus, textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(0, 130, 252, 0.1);
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
  transition: all 0.2s;
}

.btn-primary {
  background: var(--primary);
  color: #fff;
  padding: 8px 20px;
  font-weight: 500;
}

.btn-primary:hover {
  background: var(--primary-hover);
}

.btn-danger {
  background: var(--danger);
  color: #fff;
  padding: 8px 20px;
  font-weight: 500;
}

.btn-danger:hover {
  background: var(--danger-hover);
}

.btn-ghost {
  background: var(--bg-card);
  color: var(--text-2);
  padding: 8px 16px;
  border: 1px solid var(--border-3);
}

.btn-ghost:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.btn-sm {
  padding: 4px 12px;
  font-size: var(--fs-xs);
  border-radius: var(--radius-sm);
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--shadow-card);
}

/* ==================== 共享版式 ==================== */
/* 下面这批类是各页面原本各自复制一份的东西（.page-title 在 10 个文件里出现过，
   边距从 16px 到 32px 不等）。统一收在这里，页面里不要再定义同名类 ——
   scoped 样式的优先级高于全局，留着旧定义就等于没改。
   页面标题已由 App.vue 的顶部栏接管，页面内不再写 <h1 class="page-title">。 */

/* 页内工具条：只放本页操作（标题在顶部栏），默认右对齐。
   relative 让工具条内的绝对定位弹层以整条为锚点，而不是被左侧按钮带偏 */
.page-toolbar {
  position: relative;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 设置类表单：一行一个配置项（标签 + 控件 + 说明）。路由规则、系统设置共用 */
.config-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-2);
}

.config-row:last-of-type {
  border-bottom: none;
}

.config-label {
  width: 200px;
  flex-shrink: 0;
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text-1);
}

.config-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.config-hint {
  padding: 4px 0 8px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* 页签：胶囊样式。原来 Channels/WorkBuddy 用 .ch-tab/.wb-tab，Benchmark 用
   .tab-btn 下划线样式，TokenStats 用 .period-btn，同一交互四种外观，统一到这里 */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
}

.tab {
  padding: 8px 16px;
  font-size: var(--fs-small);
  color: var(--text-2);
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-pill);
}

.tab:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.tab.active {
  color: #fff;
  background: var(--primary);
  border-color: var(--primary);
}

/* 徽标：状态标签（在线/离线、评测状态、渠道可用性、版本提示）。
   颜色一律走「状态色」成对令牌，不要再各页面自定义一套 */
.badge {
  display: inline-block;
  padding: 2px 10px;
  font-size: var(--fs-mini);
  font-weight: 500;
  white-space: nowrap;
  border-radius: var(--radius-pill);
}

.badge.ok {
  color: var(--ok-text);
  background: var(--ok-bg);
}

.badge.warn {
  color: var(--warn-text);
  background: var(--warn-bg);
}

.badge.bad {
  color: var(--bad-text);
  background: var(--bad-bg);
}

.badge.info {
  color: var(--primary);
  background: var(--tint-primary-soft);
}

/* 进度条：下载安装、批量评测共用 */
.progress-track {
  height: 6px;
  overflow: hidden;
  background: var(--border-2);
  border-radius: var(--radius-xs);
}

.progress-fill {
  height: 100%;
  background: var(--primary);
  border-radius: var(--radius-xs);
  transition: width 0.3s ease;
}

/* 筛选条：日志、WorkBuddy 等列表页顶部的一排筛选控件 */.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}

/* 警示条：数据可能不准 / 操作有风险时的提示 */
.warning-box {
  margin-bottom: 16px;
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--warning-text);
  background: var(--tint-warning);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
}

/* 区域选择（国内版 / 国际版）：WorkBuddy 账号池与 Provider 表单共用同一套 */
.realm-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.realm-option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--text-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.realm-option.active {
  border-color: var(--primary);
  background: var(--primary-bg);
}

.realm-name {
  font-weight: 600;
}

.realm-host {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

/* 区域标签：账号行 / OAuth 标题上标「国内」「国际」 */
.realm-tag {
  display: inline-block;
  padding: 1px 7px;
  font-size: var(--fs-mini);
  line-height: 18px;
  vertical-align: middle;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
}

.realm-tag.cn {
  color: var(--text-2);
  background: var(--tint-neutral);
  border-color: var(--border-1);
}

.realm-tag.global {
  color: var(--purple-text);
  background: var(--tint-purple);
  border-color: var(--purple-border);
}

/* 页面分区：一个分区一块内容，统一 24px 间距 */
.section {
  margin-bottom: 24px;
}

.section-title {
  margin-bottom: 12px;
  font-size: var(--fs-section);
  font-weight: 600;
  color: var(--text-1);
}

/* 空状态：表格/列表没有数据时统一用这一块，别每个页面自己写 padding */
.empty {
  padding: 32px 16px;
  text-align: center;
  font-size: var(--fs-base);
  color: var(--text-3);
}

/* 表格：横向滚动容器 + 统一表头字号；边框交给外层卡片，避免和 .card 叠出双线 */
.table-wrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-small);
}

.table th {
  padding: 10px 12px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-3);
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-1);
}

.table td {
  padding: 10px 12px;
  color: var(--text-1);
  vertical-align: top;
  border-bottom: 1px solid var(--border-2);
}

.table tbody tr:hover {
  background: var(--bg-hover);
}

.table tr:last-child td {
  border-bottom: none;
}

/* ==================== 工具类 ==================== */
/* 语义文字色 / 等宽 / 加粗这类小工具原本在 4~5 个页面里各抄了一份，统一到这里 */
.text-red {
  color: var(--danger);
}

.text-green {
  color: var(--success);
}

.text-orange {
  color: var(--warning);
}

.text-blue {
  color: var(--primary);
}

.text-purple {
  color: var(--purple);
}

.text-muted {
  color: var(--text-3);
}

.font-bold {
  font-weight: 600;
}

.mono {
  font-family: 'Courier New', Consolas, monospace;
}

.nowrap {
  white-space: nowrap;
}

/* ==================== 共享弹窗 ==================== */
/* 弹窗骨架统一在这里；页面里只保留自己特有的宽度修饰（.modal-sm / .picker-modal） */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay);
}

.modal {
  width: 560px;
  /* 窗口拉窄时不要顶到边上：Electron 主窗口允许拖到 800px 以下 */
  max-width: calc(100vw - 32px);
  max-height: 84vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.modal-header h2 {
  margin: 0;
  font-size: var(--fs-lg);
  color: var(--text-1);
}

.modal-close {
  padding: 0 4px;
  font-size: var(--fs-title);
  line-height: 1;
  color: var(--text-3);
  background: transparent;
  border: none;
}

.modal-close:hover {
  color: var(--danger);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
