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
  <!-- 可见性必须绑到顶层的裸 ref（下面解构出来的 open）：
       useOnboarding() 返回的是普通对象，setupState 的 ref 解包只走第一层，
       onboarding.open 在模板里拿到的是 ref 对象本身 —— 恒 truthy，v-if 永远
       关不掉，点「跳过」只是把 localStorage 写了，浮层照样盖着 -->
  <OnboardingGuide v-if="open" @close="closeOnboarding" @finish="finishOnboarding" />
  <ToastHost />
</template>

<script setup>
import { useRoute, useRouter } from 'vue-router'
import Sidebar from './components/Sidebar.vue'
import BackButton from './components/BackButton.vue'
import ToastHost from './components/ToastHost.vue'
import OnboardingGuide from './components/OnboardingGuide.vue'
import { useTheme } from './composables/useTheme.js'
import { getPageActions } from './composables/usePageActions.js'
import { useOnboarding } from './composables/useOnboarding.js'

const route = useRoute()
const router = useRouter()
const actions = getPageActions()

// 尽早应用主题：index.html 的首屏脚本已先铺一次，这里接管后续的切换与系统变化监听
useTheme().initTheme()

// 启动引导：首次启动自动弹出一次；关掉（跳过）与走完的区别只有「记不记完成」，
// 由这里统一处理，引导组件本身只负责发事件。
// open 单独解构到顶层是为了让模板拿到的是解包后的布尔值（见模板注释）
const { open, launchIfFirstRun, closeOnboarding, finishOnboarding: markOnboardingDone } = useOnboarding()
launchIfFirstRun()

function finishOnboarding({ openSettings } = {}) {
  markOnboardingDone()
  if (openSettings) router.push('/settings')
}
</script>

<style>
/* ==================== 设计令牌（统一设计体系） ==================== */
/* 亮色是默认主题；暗色通过 <html data-theme="dark"> 覆盖同一批颜色令牌（见下方）。
   组件里一律引用变量，不要再写死色值，否则暗色下会残留浅色块。 */
:root {
  color-scheme: light;

  /* 品牌色 */
  --primary: #18181b;
  --primary-hover: #27272a;
  --primary-bg: #f4f4f5;
  --primary-bg-hover: #e4e4e7;
  --primary-text: #27272a;

  /* 语义色 */
  --success: #16a34a;
  --danger: #dc2626;
  --danger-hover: #b91c1c;
  --warning: #d97706;
  --warning-text: #92400e;
  --purple: #7c3aed;
  --purple-text: #6d28d9;
  --purple-border: #ddd6fe;

  /* 状态色（账号池 / 检测结果）：文字色与底色成对使用 */
  --ok-text: #15803d;
  --ok-bg: #f0fdf4;
  --warn-text: #a16207;
  --warn-bg: #fefce8;
  --bad-text: #b91c1c;
  --bad-bg: #fef2f2;

  /* 文本色：由深到浅四级 + 场景补充（弱化说明 / 等宽值 / 正文） */
  --text-1: #09090b;
  --text-2: #52525b;
  --text-3: #71717a;
  --text-4: #a1a1aa;
  --text-body: #3f3f46;
  --text-strong: #3f3f46;
  --text-weak: #71717a;
  --text-faint: #a1a1aa;

  /* 背景与边框 */
  --bg-page: #fafafa;
  --bg-card: #ffffff;
  --bg-elevated: #ffffff;
  --bg-hover: #f4f4f5;
  --bg-subtle: #fafafa;
  --bg-inset: #f4f4f5;
  --bg-chip: #f4f4f5;
  --bg-code: #f4f4f5;
  --bg-note: #f4f4f5;
  --border-1: #e4e4e7;
  --border-2: #e4e4e7;
  --border-3: #d4d4d8;

  /* 浅色底：徽标 / 提示块 / 高亮行 */
  --tint-primary: #f4f4f5;
  --tint-primary-soft: #f4f4f5;
  --tint-success: #f0fdf4;
  --tint-success-soft: #f7fef8;
  --tint-danger: #fef2f2;
  --tint-warning: #fffbeb;
  --tint-warning-soft: #fefce8;
  --tint-purple: #f5f3ff;
  --tint-purple-soft: #faf8ff;
  --tint-neutral: rgba(24, 24, 27, 0.06);

  /* 遮罩与阴影 */
  --overlay: rgba(9, 9, 11, 0.5);
  --shadow-card: 0 1px 2px rgba(9, 9, 11, 0.04);
  --shadow-hover: 0 2px 6px rgba(9, 9, 11, 0.08);
  --shadow-pop: 0 8px 24px rgba(9, 9, 11, 0.12);

  /* 滚动条 */
  --scrollbar-thumb: #d4d4d8;
  --scrollbar-thumb-hover: #a1a1aa;

  /* 图表 */
  --chart-grid: #e4e4e7;
  --chart-active: #52525b;

  /* 圆角阶梯：4 标签/徽标 · 8 小控件 · 10 卡片与按钮 · 14 大面板 · pill 胶囊 */
  --radius-xs: 4px;
  --radius-lg: 8px;
  --radius-md: 6px;
  --radius-sm: 5px;
  --radius-pill: 999px;

  /* 字体栈：不打包字体文件，只用各平台自带字体拼回退顺序。
     西文先走 system-ui（macOS 出 SF、Windows 出 Segoe UI），中文紧跟 PingFang SC /
     Microsoft YaHei，避免一段文字里中英各挑一套字体。等宽只留这一份，
     表格里的时间与 Token 靠 tabular-nums 对齐，不靠字体本身的宽度凑齐。
     以前 body 上写的 'MiSans' 既没随包发布也没人安装，等于白写一层回退，
     这里去掉，让生效的栈和写出来的一致。 */
  --font-sans: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', 'Noto Sans CJK SC', 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono',
    'Courier New', monospace;

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

  --primary: #fafafa;
  --primary-hover: #e4e4e7;
  --primary-bg: #27272a;
  --primary-bg-hover: #3f3f46;
  --primary-text: #e4e4e7;

  --success: #4ade80;
  --danger: #f87171;
  --danger-hover: #ef4444;
  --warning: #fbbf24;
  --warning-text: #fcd34d;
  --purple: #c4b5fd;
  --purple-text: #c4b5fd;
  --purple-border: #5b4b85;

  --ok-text: #86efac;
  --ok-bg: rgba(34, 197, 94, 0.12);
  --warn-text: #fcd34d;
  --warn-bg: rgba(234, 179, 8, 0.12);
  --bad-text: #fca5a5;
  --bad-bg: rgba(239, 68, 68, 0.12);

  --text-1: #fafafa;
  --text-2: #a1a1aa;
  --text-3: #a1a1aa;
  --text-4: #71717a;
  --text-body: #d4d4d8;
  --text-strong: #e4e4e7;
  --text-weak: #a1a1aa;
  --text-faint: #71717a;

  --bg-page: #09090b;
  --bg-card: #09090b;
  --bg-elevated: #18181b;
  --bg-hover: #18181b;
  --bg-subtle: #18181b;
  --bg-inset: #18181b;
  --bg-chip: #27272a;
  --bg-code: #18181b;
  --bg-note: #18181b;
  --border-1: #27272a;
  --border-2: #27272a;
  --border-3: #3f3f46;

  --tint-primary: #27272a;
  --tint-primary-soft: #27272a;
  --tint-success: rgba(34, 197, 94, 0.12);
  --tint-success-soft: rgba(34, 197, 94, 0.08);
  --tint-danger: rgba(239, 68, 68, 0.12);
  --tint-warning: rgba(234, 179, 8, 0.12);
  --tint-warning-soft: rgba(234, 179, 8, 0.16);
  --tint-purple: rgba(139, 92, 246, 0.14);
  --tint-purple-soft: rgba(139, 92, 246, 0.1);
  --tint-neutral: rgba(250, 250, 250, 0.08);

  --overlay: rgba(0, 0, 0, 0.72);
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-hover: 0 2px 8px rgba(0, 0, 0, 0.35);
  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.45);

  --scrollbar-thumb: #3f3f46;
  --scrollbar-thumb-hover: #52525b;

  --chart-grid: #27272a;
  --chart-active: #d4d4d8;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-page);
  color: var(--text-1);
  overflow: hidden;
  height: 100vh;
}

/* 滚动条：竖向与横向同一套规格。
   之前只写了 width，横向滚动条走了浏览器默认的 16px 厚直角条，
   表格底部那道灰杠就是它 —— 和右侧 6px 细条完全不是一个东西。
   height 必须显式给，否则横向仍是默认厚度 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

/* 滑块留出 2px 外边距，看起来是悬在轨道里的细条而不是贴边的一块 */
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
  background-clip: padding-box;
}

/* 两端按钮：Firefox 不画，Chromium 会画成小方块，这里去掉 */
::-webkit-scrollbar-corner {
  background: transparent;
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

/* 表单控件默认不继承字体：浏览器会给 input/select/button 各塞一套自己的默认字族
   （Chrome 里是 Arial），于是同一行里「筛选下拉」和「表格文字」长得不一样。
   这里统一显式继承，字号仍然按各控件自己的尺寸来，避免 dropdown 被撑大。 */
input, select, textarea {
  background: var(--bg-card);
  border: 1px solid var(--border-3);
  color: var(--text-1);
  padding: 0 11px;
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: var(--field-fs);
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

button {
  cursor: pointer;
  border: none;
  border-radius: var(--radius-md);
  font-family: inherit;
  font-size: var(--fs-base);
  transition: all 0.2s;
}

/* ==================== 按钮：全站唯一的尺寸规格 ==================== */
/* 全站只有一档按钮高度（28px，小号）：页头、表单、表格行内、弹窗底部都一样。
   以前每页各自写 padding，同一行里既有 26px 也有 38px 的按钮，视觉上互相打架。
   新代码请直接用 components/AppButton.vue；下面这组 .btn-* 类保留给尚未迁移的
   调用点，取值与 AppButton 完全一致。 */
:root {
  --btn-h: 28px;
  --btn-px: 10px;
  --btn-fs: 12px;

  /* 表单控件与下拉菜单是大号：输入框、select、菜单项统一 36px。
     按钮走小号（28px），两者刻意不是一个量级 —— 操作要紧凑，填写要宽松 */
  --field-h: 36px;
  --field-fs: 13px;
}

.btn-primary,
.btn-danger,
.btn-ghost,
.app-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: var(--btn-h);
  padding: 0 var(--btn-px);
  font-size: var(--btn-fs);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.btn-primary,
.app-btn-primary {
  background: var(--primary);
  color: var(--bg-card);
  border-color: var(--primary);
  box-shadow: 0 1px 2px rgba(9, 9, 11, 0.08);
}

.btn-primary:hover,
.app-btn-primary:hover {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

.btn-danger,
.app-btn-danger {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}

.btn-danger:hover,
.app-btn-danger:hover {
  background: var(--danger-hover);
  border-color: var(--danger-hover);
}

.btn-ghost,
.app-btn-secondary {
  background: var(--bg-card);
  color: var(--text-1);
  border-color: var(--border-1);
  box-shadow: 0 1px 2px rgba(9, 9, 11, 0.04);
}

.btn-ghost:hover,
.app-btn-secondary:hover {
  color: var(--text-1);
  border-color: var(--border-3);
  background: var(--bg-hover);
}

.app-btn-ghost {
  background: transparent;
  color: var(--text-2);
  border-color: transparent;
}

.app-btn-ghost:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

/* 纯图标按钮：正方形，边长等于按钮高度 */
.app-btn-icon {
  width: var(--btn-h);
  padding: 0;
}

.app-btn-block {
  width: 100%;
}

.app-btn-glyph,
.app-btn-spinner {
  width: 13px;
  height: 13px;
  flex: none;
}

.app-btn-spinner {
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: app-btn-spin 0.7s linear infinite;
}

@keyframes app-btn-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-btn-spinner {
    animation-duration: 2.4s;
  }
}

/* 禁用态：浏览器默认只是把光标变回箭头，视觉上和可点的按钮一模一样。
   渠道页把「这家不支持这个端点」的按钮画成禁用（而不是不画），所以必须让
   「点不动」看得出来 —— 否则用户会以为是点歪了，反复去点 */
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 禁用的按钮不该再有 hover 反馈：那会让人觉得它是可点的 */
button:disabled:hover {
  color: inherit;
  border-color: inherit;
  background: inherit;
}

.btn-primary:disabled:hover {
  background: var(--primary);
}

.btn-ghost:disabled:hover {
  color: var(--text-1);
  border-color: var(--border-1);
  background: var(--bg-card);
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
  gap: 4px;
  margin-bottom: 16px;
}

/* 页签与按钮同高（sm 档），视觉权重比按钮低一档：中性描边 + 浅底高亮，
   不再用蓝色实心胶囊 —— 主色已经是中性色，实心留给真正的主动作 */
.tab {
  display: inline-flex;
  align-items: center;
  height: var(--btn-h);
  padding: 0 var(--btn-px);
  font-size: var(--btn-fs);
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}

.tab:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

.tab.active {
  color: var(--text-1);
  background: var(--bg-hover);
  border-color: var(--border-3);
  font-weight: 500;
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

/* 等宽数字加在整张表上：时间、耗时、Token 这类列每行位数会变，
   比例数字会让整列左右抖；一处声明覆盖所有用 .table 的页面 */
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
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
  font-family: var(--font-mono);
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

/* 关闭按钮：与 AppButton 的 md 图标按钮同尺寸，右对齐在标题行里 */
.modal-close {
  width: var(--btn-h);
  height: var(--btn-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
}

.modal-close:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
/* ==================== 版式增量 ==================== */
/* 令牌换肤之后，这里只补「原来没有、需要新增」的观感规则；
   凡是与上方共享版式重名的规则都不要再写第二遍 —— 靠后声明会悄悄覆盖，
   调一处以为只改一行，实际改的是整站。 */
body {
  font-size: 14px;
  letter-spacing: -0.01em;
}

.top-bar {
  height: 56px;
  padding: 0 24px;
}

.top-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.main-scroll {
  padding: 24px;
}

/* 表单控件：36px 高与 6px 圆角对齐 shadcn 的 input；聚焦用中性 ring，
   不用蓝色光圈 —— 主色已经从中性色来，蓝光圈会引入第二种强调色 */
input,
select,
textarea {
  min-height: var(--field-h);
  padding: 0 11px;
  font-size: var(--field-fs);
  box-shadow: 0 1px 2px rgba(9, 9, 11, 0.025);
}

/* 下拉框：高度按大号统一，箭头改由自己画。
   原生箭头紧贴右内边距（Chromium 只会留几像素），看起来像压在边框上；
   这里换成内联 SVG 背景图，右边距由 padding-right 决定，与边框拉开呼吸。
   SVG 用 currentColor 画不了，所以按明暗两套主题各给一张（见下方 dark 覆盖） */
select {
  height: var(--field-h);
  padding: 0 30px 0 11px;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 12px;
  cursor: pointer;
}

/* 暗色下把描边换成亮灰：同一张深灰箭头在暗底上看不清 */
html[data-theme='dark'] select {
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
}

select:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

input:focus,
select:focus,
textarea:focus {
  border-color: var(--text-weak);
  box-shadow: 0 0 0 3px rgba(161, 161, 170, 0.24);
}

button,
a {
  -webkit-tap-highlight-color: transparent;
}

button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--text-weak);
  outline-offset: 2px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

.modal-overlay {
  backdrop-filter: blur(3px);
}

@media (max-width: 900px) {
  .main-scroll {
    padding: 18px;
  }

  .top-bar {
    padding: 0 18px;
  }
}
</style>