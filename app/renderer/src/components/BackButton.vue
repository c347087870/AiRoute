<template>
  <AppButton variant="secondary" iconOnly class="back-btn" title="返回" aria-label="返回" @click="goBack">
    <AppIcon name="arrowLeft" />
  </AppButton>
</template>

<script setup>
import { useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import AppButton from './AppButton.vue'

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
/* 尺寸与描边沿用 AppButton 的 md 图标按钮，这里只调整图标大小：
   全局默认 14px，标题栏里的返回箭头稍大一点更醒目 */
.back-btn {
  flex: none;
}

.back-btn :deep(svg) {
  width: 16px;
  height: 16px;
}
</style>
