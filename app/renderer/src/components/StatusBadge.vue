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
  background: var(--tint-success);
  color: var(--success);
}

.badge.offline {
  background: var(--tint-danger);
  color: var(--danger);
}
</style>
