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
          {{ copyLabel(item) }}
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useToast } from '../composables/useToast.js'

const { toasts, dismissToast, pauseToast, resumeToast } = useToast()

const copyState = ref({ id: 0, state: '' }) // 最近一次复制结果：'' | 'ok' | 'fail'
let copyTimer = 0

// 按钮文案兼作悬停提示：复制成功 / 失败在 1.6 秒后回到「复制」
function copyLabel(item) {
  if (copyState.value.id !== item.id) return '复制'
  if (copyState.value.state === 'ok') return '已复制'
  if (copyState.value.state === 'fail') return '复制失败'
  return '复制'
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

.toast-copy {
  flex: none;
  align-self: flex-start;
  margin-left: 6px;
  padding: 3px 8px;
  border: 1px solid var(--border-3);
  border-radius: var(--radius-xs);
  background: var(--bg-card);
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.3;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}

.toast:hover .toast-copy,
.toast-copy:focus-visible {
  opacity: 1;
}

.toast-copy:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.toast-copy.ok {
  opacity: 1;
  color: var(--success);
  border-color: var(--success);
}

.toast-copy.fail {
  opacity: 1;
  color: var(--danger);
  border-color: var(--danger);
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
