<template>
  <span class="badge" :class="{ online: online, offline: !online }">
    {{ online ? '在线' : '离线' }}
  </span>
</template>

<script setup>
defineProps({
  online: { type: Boolean, default: false }
})
</script>

<style scoped>
.badge {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 20px;
  font-weight: 500;
}

.badge.online {
  background: #00B57814;
  color: #00B578;
}

.badge.offline {
  background: #FF3B3014;
  color: #FF3B30;
}
</style>
