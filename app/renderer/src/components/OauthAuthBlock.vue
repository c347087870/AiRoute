<template>
  <!-- OAuth 授权区块（页内区块，非弹窗）
       引导页、「渠道账号」页、「账号池」页三处共用同一个组件：
       授权链接 + 打开 / 复制 / 停止等待三个动作 + 轮询状态。
       同一件事在三处的写法与观感必须一致 —— 用户从引导页跳到渠道页时
       不该看到另一套按钮与文案。
       打开 / 复制这两个动作由组件自己完成（系统浏览器 + 剪贴板），
       调用方只管传链接与状态；「停止等待」交给调用方（各家取消语义不同）。 -->
  <div class="auth-block">
    <div class="auth-block-title">
      <slot name="title">{{ title }}</slot>
    </div>
    <div class="auth-block-url" :title="url">{{ url }}</div>
    <div class="auth-block-actions">
      <AppButton variant="primary" @click="openInBrowser">打开授权链接</AppButton>
      <AppButton variant="secondary" @click="copyUrl">复制链接</AppButton>
      <AppButton variant="secondary" @click="$emit('cancel')">{{ cancelText }}</AppButton>
    </div>
    <div class="auth-block-status">
      {{ friendlyLoginMessage(message) || statusHint }}
    </div>
  </div>
</template>

<script setup>
import AppButton from './AppButton.vue'
import { friendlyLoginMessage } from '../utils/login-messages.js'
import { showToast } from '../composables/useToast.js'

// title：区块标题（如「在浏览器中完成 WorkBuddy（国内版）授权」）；
//         带额外标记（区域徽标等）时用 title 插槽自己排。
// url：授权链接原文。
// message：上游轮询回包原话（展示层翻译成中文，原话仍保留在 message 里备查）。
// statusHint：上游还没回话时的默认等待文案。
// cancelText：第三个按钮的文案（引导页用「取消授权」，其余页用「停止等待」）。
const props = defineProps({
  title: { type: String, default: '在浏览器中完成授权' },
  url: { type: String, default: '' },
  message: { type: String, default: '' },
  statusHint: { type: String, default: '等待浏览器完成授权，每 3 秒自动检测一次…' },
  cancelText: { type: String, default: '停止等待' }
})

defineEmits(['cancel'])

// 授权页一律交给系统默认浏览器：Electron 的 window.open 会开一个内嵌窗口，
// 而 OAuth 提供方会拒绝带 Electron UA 的内嵌浏览器。
// 浏览器模式（vite dev）没有 electronAPI，退回 window.open
function openInBrowser() {
  if (!props.url) return
  if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(props.url)
  else window.open(props.url, '_blank')
}

async function copyUrl() {
  if (!props.url) return
  try {
    await navigator.clipboard.writeText(props.url)
    showToast('授权链接已复制')
  } catch {
    showToast('复制失败，请手动选中复制', 'error')
  }
}
</script>

<style scoped>
.auth-block {
  padding: 10px 12px;
  background: var(--primary-bg);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.auth-block-title {
  margin-bottom: 6px;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--text-1);
}

.auth-block-url {
  margin-bottom: 8px;
  font-size: var(--fs-mini);
  color: var(--primary);
  word-break: break-all;
  max-height: 48px;
  overflow: hidden;
}

.auth-block-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.auth-block-status {
  margin-top: 8px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}
</style>
