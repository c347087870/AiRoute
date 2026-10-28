<template>
  <span class="badge" :class="online ? 'ok' : 'bad'">
    {{ online ? '在线' : '离线' }}
  </span>
</template>

<script setup>
// 样式走 App.vue 的全局 .badge，这里不再维护一份 scoped 副本
defineProps({
  online: { type: Boolean, default: false }
})
</script>
