<template>
  <div class="providers">
    <div class="page-header">
      <h1 class="page-title">Provider 管理</h1>
      <button class="btn-primary" @click="showAdd = true">+ 新增 Provider</button>
    </div>

    <div class="provider-grid">
      <div v-for="(provider, name) in providers" :key="name" class="card provider-card">
        <div class="provider-header">
          <div>
            <div class="provider-name">{{ provider.displayName || name }}</div>
            <div class="provider-id">{{ name }}</div>
          </div>
          <span v-if="currentModel === name" class="active-badge">当前</span>
        </div>

        <div class="provider-info">
          <div class="info-row">
            <span class="info-label">端点</span>
            <span class="info-value">{{ provider.baseURL }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">模型</span>
            <span class="info-value">{{ provider.model }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">API Key</span>
            <span class="info-value">{{ provider.apiKey || '(未配置)' }}</span>
          </div>
        </div>

        <div v-if="testResults[name]" class="test-result" :class="testResults[name].ok ? 'test-ok' : 'test-fail'">
          <span v-if="testResults[name].ok">✓ 连接成功 · {{ testResults[name].latency }}ms</span>
          <span v-else>✗ {{ testResults[name].error }} · {{ testResults[name].latency }}ms</span>
        </div>

        <div class="provider-actions">
          <button class="btn-ghost" @click="runTest(name)" :disabled="testingName === name">
            {{ testingName === name ? '测试中...' : '测试' }}
          </button>
          <button class="btn-ghost" @click="editProvider(name, provider)">编辑</button>
          <button class="btn-primary" @click="setAsCurrent(name)">设为当前</button>
          <button class="btn-danger" @click="removeProvider(name)">删除</button>
        </div>
      </div>
    </div>

    <div v-if="showAdd || editingName" class="modal-overlay">
      <div class="card modal">
        <div class="modal-header">
          <h2>{{ editingName ? '编辑 Provider' : '新增 Provider' }}</h2>
          <button class="modal-close" @click="closeModal">×</button>
        </div>
        <div class="form">
          <label>
            名称 (ID)
            <input v-model="form.name" :disabled="!!editingName" placeholder="如: glm" />
          </label>
          <label>
            显示名称
            <input v-model="form.displayName" placeholder="如: GLM-4" />
          </label>
          <label>
            端点 URL
            <input v-model="form.baseURL" placeholder="https://api.example.com" />
          </label>
          <label>
            模型 ID
            <input v-model="form.model" placeholder="如: glm-4" />
          </label>
          <label>
            API Key
            <div class="key-input-wrap">
              <input v-model="form.apiKey" :type="showKey ? 'text' : 'password'" placeholder="sk-..." />
              <button class="key-eye-btn" @click="showKey = !showKey" :title="showKey ? '隐藏' : '显示'">
                {{ showKey ? '🙈' : '👁' }}
              </button>
              <button class="key-copy-btn" @click="copyKey" title="复制">📋</button>
            </div>
          </label>
          <div class="form-actions">
            <button class="btn-ghost" @click="closeModal">取消</button>
            <button class="btn-primary" @click="saveProvider">保存</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useModel } from '../composables/useModel.js'
import { getProviderFull, addProvider, updateProvider, deleteProvider, testProvider } from '../api.js'

const { currentModel, providers, loadModelData, switchModel } = useModel()
const showAdd = ref(false) // 是否显示新增弹窗
const testingName = ref('') // 正在测试中的 provider 名
const testResults = ref({}) // 连通性测试结果
const editingName = ref('') // 正在编辑的 provider 名
const showKey = ref(false) // API Key 密码/明文切换
const form = ref({
  name: '', // Provider ID
  displayName: '', // 显示名称
  baseURL: '', // 端点 URL
  model: '', // 模型 ID
  apiKey: '' // API Key
})

// 重置表单
function resetForm() {
  form.value = { name: '', displayName: '', baseURL: '', model: '', apiKey: '' }
  showKey.value = false
}

// 关闭弹窗
function closeModal() {
  showAdd.value = false
  editingName.value = ''
  showKey.value = false
  resetForm()
}

// 打开编辑弹窗，加载完整的 apiKey
async function editProvider(name, provider) {
  editingName.value = name
  form.value = {
    name,
    displayName: provider.displayName || '',
    baseURL: provider.baseURL || '',
    model: provider.model || '',
    apiKey: '' // 先置空
  }
  showKey.value = false
  // 异步加载完整 apiKey
  try {
    const full = await getProviderFull(name)
    form.value.apiKey = full.apiKey || ''
  } catch {}
}

// 复制 apiKey 到剪贴板
async function copyKey() {
  try {
    await navigator.clipboard.writeText(form.value.apiKey)
  } catch {
    // 降级方案
    const el = document.createElement('textarea')
    el.value = form.value.apiKey
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  }
}

// 保存 provider
async function saveProvider() {
  const data = {
    displayName: form.value.displayName,
    baseURL: form.value.baseURL,
    model: form.value.model,
    apiKey: form.value.apiKey
  }
  try {
    if (editingName.value) {
      await updateProvider(editingName.value, data)
    } else {
      await addProvider(form.value.name, data)
    }
    closeModal()
    await loadModelData()
  } catch (err) {
    alert('保存失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'))
  }
}

// 删除 provider
async function removeProvider(name) {
  try {
    await deleteProvider(name)
    await loadModelData()
  } catch {}
}

// 设为当前模型
async function setAsCurrent(name) {
  await switchModel(name)
}

// 测试联通性
async function runTest(name) {
  testingName.value = name
  testResults.value[name] = null
  try {
    const result = await testProvider(name)
    testResults.value[name] = result
  } catch (err) {
    testResults.value[name] = { ok: false, error: '请求失败', latency: 0 }
  }
  testingName.value = ''
}


onMounted(() => {
  loadModelData()
})
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: #1A1A1A;
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}

.provider-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.provider-name {
  font-size: 16px;
  font-weight: 600;
  color: #1A1A1A;
}

.provider-id {
  font-size: 12px;
  color: #999999;
  margin-top: 2px;
}

.active-badge {
  font-size: 11px;
  background: #00B57814;
  color: #00B578;
  padding: 2px 8px;
  border-radius: 10px;
}

.provider-info {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-row {
  display: flex;
  font-size: 13px;
}

.info-label {
  width: 70px;
  color: #999999;
  flex-shrink: 0;
}

.info-value {
  color: #1A1A1A;
  word-break: break-all;
}

.provider-actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  width: 440px;
  max-height: 80vh;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.modal-header h2 {
  font-size: 18px;
  margin: 0;
  color: #1A1A1A;
}

.modal-close {
  background: transparent;
  border: none;
  color: #999999;
  font-size: 22px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.modal-close:hover {
  color: #FF3B30;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: #666666;
}

.form input {
  width: 100%;
}

/* API Key 输入框 + 小眼睛 + 复制按钮 */
.key-input-wrap {
  display: flex;
  gap: 4px;
  align-items: center;
}

.key-input-wrap input {
  flex: 1;
}

.key-eye-btn,
.key-copy-btn {
  background: transparent;
  border: 1px solid #E0E0E0;
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}

.key-eye-btn:hover,
.key-copy-btn:hover {
  background: #F5F5F5;
  border-color: #0082FC;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.test-result {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 8px;
}

.test-ok {
  background: #00B57814;
  color: #00B578;
}

.test-fail {
  background: #FF3B3014;
  color: #FF3B30;
}
</style>
