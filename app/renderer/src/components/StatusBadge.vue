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
  background: rgba(0, 181, 120, 0.08);
  color: var(--success);
}

.badge.offline {
  background: rgba(255, 59, 48, 0.08);
  color: var(--danger);
}
</style>
