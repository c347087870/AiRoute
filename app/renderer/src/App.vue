<template>
  <div class="app-layout">
    <Sidebar />
    <main class="main-content">
      <router-view />
    </main>
  </div>
  <ToastHost />
</template>

<script setup>
import Sidebar from './components/Sidebar.vue'
import ToastHost from './components/ToastHost.vue'
import { useTheme } from './composables/useTheme.js'

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

  /* 圆角 */
  --radius-lg: 14px;
  --radius-md: 10px;
  --radius-sm: 8px;
  --radius-pill: 20px;

  /* 阴影 */
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.04);

  /* 字号 */
  --fs-title: 22px;
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
  overflow-y: auto;
  padding: 28px 32px;
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
</style>
