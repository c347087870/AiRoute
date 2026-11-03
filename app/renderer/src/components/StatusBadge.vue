<template>
  <span class="badge" :class="{ online: online, offline: !online }">
    <span class="dot"></span>
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 9px 2px 7px;
  border-radius: 20px;
  font-weight: 500;
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.badge.online {
  background: rgba(52, 199, 89, 0.12);
  color: #248A3D;
}

.badge.offline {
  background: rgba(255, 59, 48, 0.1);
  color: var(--danger);
}
</style>
