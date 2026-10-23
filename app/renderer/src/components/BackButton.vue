<template>
  <button type="button" class="back-btn" title="返回" aria-label="返回" @click="goBack">
    <AppIcon name="arrowLeft" />
  </button>
</template>

<script setup>
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'

const router = useRouter()

// 二级页面都从侧边栏或页内链接进来，正常情况下后退即可回到来处。
// 直接手敲地址打开时没有上一条记录，此时 router.back() 会退到应用外面，
// 所以用状态面板兜底。
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/dashboard')
}
</script>

<style scoped>
/* 与 .btn-ghost 同一套观感，但只放一个图标，做成正方形按钮 */
.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  color: var(--text-2);
  background: var(--bg-card);
  border: 1px solid var(--border-3);
  border-radius: var(--radius-md);
}

.back-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.back-btn svg {
  width: 18px;
  height: 18px;
}

.back-btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
</style>
