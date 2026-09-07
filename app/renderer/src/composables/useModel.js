import { ref, computed } from 'vue'
import { getState, setState, getProviders } from '../api.js'
import { resolveRefLabel } from '../utils/models.js'

// 共享的响应式状态，所有组件引用同一份
const currentModel = ref('') // 当前激活的模型引用（provider/model）或 auto
const providers = ref({}) // 所有 provider 配置

// 当前模型的展示名，随 provider 列表变化自动重算
const currentModelLabel = computed(() => resolveRefLabel(providers.value, currentModel.value))

// 从服务端加载当前模型和 provider 列表
async function loadModelData() {
  try {
    const [state, provs] = await Promise.all([getState(), getProviders()])
    currentModel.value = state.current
    providers.value = provs
  } catch {}
}

// 通知主进程刷新托盘菜单（模型列表或选中态可能已变化）
function notifyTray() {
  if (typeof window !== 'undefined' && window.electronAPI?.notifyModelChanged) {
    window.electronAPI.notifyModelChanged()
  }
}

// 切换模型：同时更新服务端和共享状态，返回是否成功
async function switchModel(model) {
  try {
    await setState(model)
    currentModel.value = model
    notifyTray()
    return true
  } catch {
    return false
  }
}

// 供托盘菜单回调使用的模型更新（只更新前端状态，服务端已由托盘写入）
function updateModel(model) {
  currentModel.value = model
}

// 托盘菜单切换模型的回调
if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.onTraySwitchModel((model) => updateModel(model))
}

export function useModel() {
  return { currentModel, providers, currentModelLabel, loadModelData, switchModel, updateModel, notifyTray }
}
