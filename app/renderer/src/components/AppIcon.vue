<template>
  <svg
    class="app-icon"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    v-html="body"
  />
</template>

<script setup>
import { computed } from 'vue'
import { ICONS } from '../icons.js'

const props = defineProps({
  name: { type: String, required: true }
})

// 内容来自本地常量表（构建期确定），不是用户输入，v-html 在这里是安全的；
// 用它而不是逐个子元素渲染，是为了让换图标只需改 icons.js 一处。
const body = computed(() => ICONS[props.name] || '')
</script>

<style scoped>
/* 尺寸交给父容器（侧边栏 .nav-icon 定 18px），stroke 是 currentColor，
   所以激活态变色不需要给图标单独写样式 */
.app-icon {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
