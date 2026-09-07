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
</script>

<style>
/* ==================== 设计令牌（统一设计体系） ==================== */
:root {
  /* 品牌色 */
  --primary: #0082FC;
  --primary-hover: #006FDB;
  --primary-bg: rgba(0, 130, 252, 0.08);

  /* 语义色 */
  --success: #00B578;
  --danger: #FF3B30;
  --danger-hover: #E0342B;
  --warning: #FF9500;
  --purple: #9C27B0;

  /* 文本色：由深到浅四级 */
  --text-1: #1A1A1A;
  --text-2: #666666;
  --text-3: #999999;
  --text-4: #CCCCCC;

  /* 背景与边框 */
  --bg-page: #F5F5F5;
  --bg-card: #FFFFFF;
  --bg-hover: #FAFAFA;
  --border-1: #EEEEEE;
  --border-2: #F0F0F0;
  --border-3: #E0E0E0;

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
  background: #D0D0D0;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #B0B0B0;
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
