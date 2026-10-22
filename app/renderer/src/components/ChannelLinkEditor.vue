<template>
  <div class="link-editor">
    <div class="link-title">个人中心链接</div>
    <label v-for="slot in slots" :key="slot.key" class="link-row">
      <span class="link-label">{{ slot.label }}</span>
      <input
        v-model="draft[slot.key]"
        class="link-input mono"
        :placeholder="slot.url || 'https://…（这家没有内置默认，需自己填）'"
        spellcheck="false"
      />
    </label>
    <div class="link-hint">
      留空即用内置默认（灰色占位就是默认值）。地址只存本机，不进全局配置。
    </div>
    <div class="link-actions">
      <button class="btn-primary btn-sm" @click="emit('submit', draft)">保存</button>
      <button class="btn-ghost btn-sm" @click="emit('reset')">恢复默认</button>
      <button class="btn-ghost btn-sm" @click="emit('close')">取消</button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  slots: { type: Array, required: true }, // [{ key, label, url }]，url 是内置默认
  values: { type: Object, default: () => ({}) } // 已保存的覆盖值，键为 slot.key
})

const emit = defineEmits(['submit', 'reset', 'close'])

// 草稿独立于 props：编辑中途点取消不能污染已保存的值
const draft = ref(Object.fromEntries(props.slots.map(slot => [slot.key, props.values[slot.key] || ''])))
</script>

<style scoped>
.link-editor {
  padding: 10px 12px;
  background: var(--primary-bg);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.link-title {
  margin-bottom: 8px;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--text-1);
}

.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.link-label {
  width: 88px;
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.link-input {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
}

.link-hint {
  margin: 6px 0 8px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.link-actions {
  display: flex;
  gap: 8px;
}
</style>
