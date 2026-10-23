<template>
  <div class="toast-host">
    <TransitionGroup name="toast">
      <div
        v-for="item in toasts"
        :key="item.id"
        class="toast"
        :class="`toast-${item.type}`"
        @click="dismissToast(item.id)"
        @mouseenter="pauseToast(item.id)"
        @mouseleave="resumeToast(item.id)"
      >
        <span class="toast-icon">{{ iconOf(item.type) }}</span>
        <span class="toast-message">{{ item.message }}</span>
        <button
          class="toast-copy"
          :class="{ ok: copyState.id === item.id && copyState.state === 'ok', fail: copyState.id === item.id && copyState.state === 'fail' }"
          type="button"
          :title="copyLabel(item)"
          :aria-label="copyLabel(item)"
          @click.stop="copyToast(item)"
        >
          <!-- 只用图标：提示条上本来就只有一行字，再挤一个「复制」两个字会把长错误
               压成两三行。状态由图标本身承担（复制 → 对勾 / 叉号），文案留给 title 与 aria-label -->
          <AppIcon :name="copyIconOf(item)" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useToast } from '../composables/useToast.js'
import AppIcon from './AppIcon.vue'

const { toasts, dismissToast, pauseToast, resumeToast } = useToast()

const copyState = ref({ id: 0, state: '' }) // 最近一次复制结果：'' | 'ok' | 'fail'
let copyTimer = 0

// 文案同时是悬停提示与读屏标签（按钮上只有图标，没有可见文字可读）
function copyLabel(item) {
  if (copyState.value.id !== item.id) return '复制'
  if (copyState.value.state === 'ok') return '已复制'
  if (copyState.value.state === 'fail') return '复制失败'
  return '复制'
}

// 图标承担状态：复制 → 对勾 / 叉号，1.6 秒后回到复制图标（与 copyLabel 同步）
function copyIconOf(item) {
  if (copyState.value.id !== item.id) return 'copy'
  if (copyState.value.state === 'ok') return 'check'
  if (copyState.value.state === 'fail') return 'x'
  return 'copy'
}

function setCopyState(id, state) {
  copyState.value = { id, state }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copyState.value = { id: 0, state: '' }
  }, 1600)
}

// 复制提示全文：错误信息常常太长，光靠眼睛抄不下来
async function copyToast(item) {
  try {
    await navigator.clipboard.writeText(item.message)
    setCopyState(item.id, 'ok')
  } catch {
    // 窗口无焦点或缺少剪贴板权限时 Clipboard API 会拒绝，降级到临时 textarea
    const el = document.createElement('textarea')
    el.value = item.message
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(el)
    setCopyState(item.id, ok ? 'ok' : 'fail')
  }
}

// 根据提示类型返回对应图标
function iconOf(type) {
  if (type === 'error') return '✕'
  if (type === 'info') return 'ℹ'
  return '✓'
}
</script>

<style scoped>
.toast-host {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-3);
  border-left: 4px solid var(--success);
  border-radius: var(--radius-md);
  padding: 10px 18px;
  font-size: var(--fs-small);
  color: var(--text-1);
  box-shadow: var(--shadow-pop);
  cursor: pointer;
  pointer-events: auto;
  min-width: 220px;
  max-width: 520px;
}

.toast-error {
  border-left-color: var(--danger);
}

.toast-info {
  border-left-color: var(--primary);
}

.toast-icon {
  font-size: var(--fs-small);
  line-height: 1;
  color: var(--success);
}

.toast-error .toast-icon {
  color: var(--danger);
}

.toast-info .toast-icon {
  color: var(--primary);
}

.toast-message {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 复制按钮：图标按钮，没有边框与底色 —— 它挂在提示条右侧，加一层框会像另一个
   操作按钮而不像提示条的一部分。默认半透明，指针进入提示条才显出来；
   复制成功 / 失败时颜色换成状态色，图标同时变成对勾 / 叉号 */
.toast-copy {
  flex: none;
  align-self: flex-start;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 3px;
  margin-left: 6px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.15s, color 0.15s, background-color 0.15s;
}

.toast:hover .toast-copy,
.toast-copy:focus-visible {
  opacity: 1;
}

.toast-copy:hover {
  color: var(--primary);
  background: var(--bg-chip);
}

.toast-copy.ok {
  opacity: 1;
  color: var(--success);
}

.toast-copy.fail {
  opacity: 1;
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s, transform 0.22s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
