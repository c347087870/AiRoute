<template>
  <div class="switcher">
    <div class="current-label">当前模型</div>
    <select :value="currentModel" @change="handleSwitch($event)" class="model-select">
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

// 切换模型：失败时把下拉框回滚到旧值并提示
// 刻意不用 v-model：v-model 的赋值监听先于 @change 执行，会导致这里读到的
// currentModel 已经是新值，「回滚」变成空操作（下拉显示与服务端状态不一致）
async function handleSwitch(event) {
  const el = event.target
  const nextRef = el.value
  const previous = currentModel.value
  if (nextRef === previous) return
  const ok = await switchModel(nextRef)
  if (!ok) {
    el.value = previous // 回滚下拉显示（currentModel 在失败路径未被改动）
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
