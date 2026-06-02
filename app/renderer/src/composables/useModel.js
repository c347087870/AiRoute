import { ref } from 'vue'
import { getState, setState, getProviders } from '../api.js'

// 共享的响应式状态，所有组件引用同一份
const currentModel = ref('') // 当前激活的模型名
const providers = ref({}) // 所有 provider 配置

// 从服务端加载当前模型和 provider 列表
async function loadModelData() {
  try {
    const [state, provs] = await Promise.all([getState(), getProviders()])
    currentModel.value = state.current
    providers.value = provs
  } catch {}
}

// 切换模型：同时更新服务端和共享状态
async function switchModel(model) {
  try {
    await setState(model)
    currentModel.value = model
  } catch {}
}

// 供托盘菜单回调使用的模型更新（只更新前端状态）
function updateModel(model) {
  currentModel.value = model
}

export function useModel() {
  return { currentModel, providers, loadModelData, switchModel, updateModel }
}
