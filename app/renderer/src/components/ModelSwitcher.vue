<template>
  <div class="switcher">
    <div class="current-label">当前模型</div>
    <select v-model="currentModel" @change="handleSwitch($event.target.value)" class="model-select">
      <option :value="AUTO_MODEL">Auto (智能路由)</option>
      <optgroup v-for="group in modelGroups" :key="group.label" :label="group.label">
        <option v-for="option in group.options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </optgroup>
      <!-- 当前模型已不在配置中时补一个兜底选项，避免下拉显示空白 -->
      <option v-if="!hasCurrentOption" :value="currentModel">{{ currentModelLabel }}（已失效）</option>
    </select>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useModel } from '../composables/useModel.js'
import { showToast } from '../composables/useToast.js'
import { buildModelGroups, AUTO_MODEL } from '../utils/models.js'

const { currentModel, providers, currentModelLabel, loadModelData, switchModel } = useModel()

// 按 Provider 分组的下拉选项
const modelGroups = computed(() => buildModelGroups(providers.value))

// 当前模型是否能在下拉选项中找到
const hasCurrentOption = computed(() => {
  if (!currentModel.value || currentModel.value === AUTO_MODEL) return true
  return modelGroups.value.some(group => group.options.some(option => option.value === currentModel.value))
})

// 切换模型：失败时回滚下拉选中项并提示
async function handleSwitch(nextRef) {
  const previous = currentModel.value
  const ok = await switchModel(nextRef)
  if (!ok) {
    currentModel.value = previous
    showToast('切换模型失败，请检查服务状态后重试', 'error')
  }
}

onMounted(() => {
  loadModelData()
})
</script>

<style scoped>
.switcher {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.current-label {
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.model-select {
  width: 100%;
  background: var(--bg-page);
  border: 1px solid var(--border-3);
  color: var(--text-1);
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
}
</style>
