<template>
  <div class="toast-host">
    <TransitionGroup name="toast">
      <div
        v-for="item in toasts"
        :key="item.id"
        class="toast"
        :class="`toast-${item.type}`"
        @click="dismissToast(item.id)"
      >
        <span class="toast-icon">{{ iconOf(item.type) }}</span>
        <span class="toast-message">{{ item.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { useToast } from '../composables/useToast.js'

const { toasts, dismissToast } = useToast()

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
  background: #FFFFFF;
  border: 1px solid var(--border-3);
  border-left: 4px solid var(--success);
  border-radius: 10px;
  padding: 10px 18px;
  font-size: 13px;
  color: var(--text-1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
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
  font-size: 13px;
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
  white-space: pre-wrap;
  word-break: break-all;
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
