<template>
  <div class="switcher">
    <div class="current-label">当前模型</div>
    <select v-model="currentModel" @change="switchModel(currentModel)" class="model-select">
      <option value="auto">Auto (智能路由)</option>
      <option v-for="(provider, name) in providers" :key="name" :value="name">
        {{ provider.displayName || name }}
      </option>
    </select>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useModel } from '../composables/useModel.js'

const { currentModel, providers, loadModelData, switchModel, updateModel } = useModel()

// 托盘菜单切换模型的回调
if (window.electronAPI) {
  window.electronAPI.onTraySwitchModel((model) => {
    updateModel(model)
  })
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
  color: #999999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.model-select {
  width: 100%;
  background: #F5F5F5;
  border: 1px solid #E0E0E0;
  color: #1A1A1A;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
}
</style>
