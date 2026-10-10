<template>
  <div class="providers">
    <div class="page-header">
      <h1 class="page-title">Provider 管理</h1>
      <div class="header-actions">
        <button class="btn-ghost" @click="openAddModal('')">+ 通用 Provider</button>
        <button
          class="btn-primary"
          :disabled="hasWorkbuddyProvider"
          :title="hasWorkbuddyProvider ? 'WorkBuddy 源只能有一个（账号池中的全部账号自动轮转）' : ''"
          @click="openAddModal('workbuddy')"
        >
          {{ hasWorkbuddyProvider ? '已有 WorkBuddy 源' : '+ 添加 WorkBuddy 账号池' }}
        </button>
      </div>
    </div>

    <div v-if="!providerCount" class="card empty-state">
      还没有配置任何 Provider，点击右上角「+ 通用 Provider」或「+ 添加 WorkBuddy 账号池」开始。
    </div>

    <div v-else class="provider-list">
      <div
        v-for="(provider, name) in providers"
        :key="name"
        class="provider-row"
        :class="{ active: isCurrentProvider(name) }"
      >
        <div class="row-main">
          <div class="row-head">
            <span class="row-name">{{ provider.displayName || name }}</span>
            <span class="row-id">{{ name }}</span>
            <span v-if="provider.type === 'workbuddy'" class="badge-type">账号池</span>
            <span v-if="isCurrentProvider(name)" class="badge-current">当前</span>
            <span class="row-count">{{ provider.models?.length || 0 }} 个模型</span>
          </div>

          <div class="row-meta">
            <template v-if="provider.type === 'workbuddy'">
              <span class="meta-item">
                <span class="meta-label">类型</span>
                <span class="meta-value">WorkBuddy 账号池（OAuth 登录 / 自动轮转）</span>
              </span>
            </template>
            <template v-else>
              <span class="meta-item">
                <span class="meta-label">Anthropic</span>
                <span class="meta-value" :title="provider.baseURL || ''">{{ provider.baseURL || '未配置' }}</span>
              </span>
              <span class="meta-item">
                <span class="meta-label">OpenAI</span>
                <span class="meta-value" :title="provider.openaiURL || ''">{{ provider.openaiURL || '未配置' }}</span>
              </span>
              <span class="meta-item">
                <span class="meta-label">Key</span>
                <span class="meta-value">{{ provider.apiKey || '未配置' }}</span>
              </span>
            </template>
          </div>

          <div class="row-models">
            <template v-if="provider.models?.length">
              <span
                v-for="model in visibleModels(provider, name)"
                :key="model.id"
                class="model-chip"
                :class="{ current: currentModel === `${name}/${model.id}` }"
                :title="`${model.id}｜上下文 ${formatLimit(model.maxContext)}｜输出 ${formatLimit(model.maxOutput)}`"
              >
                <span class="chip-name">{{ model.displayName || model.id }}</span>
                <span class="chip-meta">
                  {{ formatLimit(model.maxContext) }} / {{ formatLimit(model.maxOutput) }}
                </span>
                <button
                  class="chip-use"
                  :class="{ 'is-current': currentModel === `${name}/${model.id}` }"
                  @click="useModelRef(`${name}/${model.id}`)"
                >
                  {{ currentModel === `${name}/${model.id}` ? '使用中' : '切换' }}
                </button>
              </span>
              <button
                v-if="(provider.models?.length || 0) > MODEL_COLLAPSE_LIMIT"
                class="chip-more"
                @click="toggleExpand(name)"
              >
                {{ expanded.has(name) ? '收起' : `+${provider.models.length - MODEL_COLLAPSE_LIMIT}` }}
              </button>
            </template>
            <span v-else class="model-empty">未配置模型</span>
          </div>

          <div v-if="testResults[name]" class="row-test" :class="testResults[name].ok ? 'test-ok' : 'test-fail'">
            <span v-if="testResults[name].ok">
              ✓ {{ testResults[name].model }} 连接成功 · {{ testResults[name].latency }}ms · 本次用量 {{ formatNumber(testResults[name].totalTokens) }} tokens
            </span>
            <span v-else>✗ {{ testResults[name].error }} · {{ testResults[name].latency }}ms</span>
          </div>
        </div>

        <div class="row-actions">
          <button class="btn-ghost btn-sm" @click="runTest(name)" :disabled="testingName === name">
            {{ testingName === name ? '测试中' : '测试' }}
          </button>
          <button class="btn-ghost btn-sm" @click="editProvider(name, provider)">编辑</button>
          <button class="btn-primary btn-sm" @click="setAsCurrent(name)">设为当前</button>
          <button class="btn-danger btn-sm" @click="removeProvider(name)">删除</button>
        </div>
      </div>
    </div>

    <div v-if="showAdd || editingName" class="modal-overlay">
      <div class="card modal">
        <div class="modal-header">
          <h2>{{ modalTitle }}</h2>
          <button class="modal-close" @click="closeModal">×</button>
        </div>
        <div class="form">
          <label>
            名称 (ID)
            <input v-model="form.name" :disabled="!!editingName" placeholder="如: glm" />
          </label>
          <label>
            显示名称
            <input v-model="form.displayName" placeholder="如: 智谱 GLM" />
          </label>
          <!-- 类型由新增入口决定，编辑时只读展示 -->
          <div v-if="editingName" class="form-type-line">
            类型：{{ form.type === 'workbuddy' ? 'WorkBuddy 账号池' : '通用端点（OpenAI / Anthropic）' }}
          </div>

          <!-- WorkBuddy 类型：账号池中的全部账号自动轮转，这里只读展示 -->
          <div v-if="form.type === 'workbuddy'" class="wb-entry">
            <div class="wb-entry-header">
              <span class="wb-entry-title">账号（{{ wbAccounts.length }} 个，自动轮转）</span>
              <router-link to="/workbuddy" class="wb-entry-link">前往账号池页面管理 →</router-link>
            </div>
            <div class="wb-entry-hint">
              账号池中的全部账号都参与本源的请求轮转（自动换号、限流冷却、会话粘性），无需在此选择。
            </div>
            <div v-if="!wbAccounts.length" class="wb-entry-empty">
              账号池还没有账号，请先到「账号池」页面通过 OAuth 添加账号。
            </div>
            <div v-else class="wb-account-list">
              <div v-for="acct in wbAccounts" :key="acct.uid" class="wb-account-item">
                <span class="wb-account-name">{{ acct.nickname || acct.uid.slice(0, 12) }}</span>
                <span class="wb-account-state" :class="accountStateClass(acct)">{{ accountStateLabel(acct) }}</span>
              </div>
            </div>

            <div class="wb-entry-header">
              <span class="wb-entry-title">模型清单</span>
              <router-link to="/workbuddy" class="wb-entry-link">调整启用模型 →</router-link>
            </div>
            <div class="wb-entry-hint">
              {{ editingName ? '模型清单来自' : '已默认带出' }}账号池「模型和档位」中启用的全部模型（共
              {{ wbModelList.length }} 个）{{ editingName ? '，保存后自动同步。' : '，保存后生效。' }}
            </div>
            <div class="wb-model-chips">
              <div v-for="m in wbModelList" :key="m.id" class="wb-model-row">
                <div class="wb-model-line">
                  <span class="wb-model-chip">{{ m.id }}</span>
                  <select
                    class="effort-select-sm"
                    :value="effortSelectValue(m)"
                    @change="onEffortSelect(m, $event.target.value)"
                  >
                    <option value="">默认（不干预）</option>
                    <option v-for="e in m.efforts" :key="e" :value="e">{{ e }}</option>
                    <option value="__custom">自定义…</option>
                  </select>
                  <input v-if="m.custom" v-model="m.reasoningEffort" class="effort-input" placeholder="输入自定义档位" />
                </div>
                <div class="wb-model-line">
                  <div class="limit-field">
                    <span class="limit-label">最大上下文</span>
                    <input v-model="m.maxContext" type="number" min="1" placeholder="留空" />
                  </div>
                  <div class="limit-field">
                    <span class="limit-label">最大输出</span>
                    <input v-model="m.maxOutput" type="number" min="1" placeholder="留空" />
                  </div>
                </div>
              </div>
              <span v-if="!wbModelList.length" class="wb-entry-empty">尚未配置模型，请到账号池页面勾选要启用的模型。</span>
            </div>
            <div class="wb-entry-hint">
              推理档位逐模型独立配置（WorkBuddy 源不回落全局档位）：下拉列出该模型后台支持的全部档位，默认档已预选；选「默认」表示不改写客户端请求的档位，「自定义」可手填。最大上下文与最大输出取自后台拉取的值，可自行调整，留空表示不注入。
            </div>
          </div>

          <template v-else>
          <label>
            Anthropic URL
            <input v-model="form.baseURL" placeholder="https://api.example.com/anthropic" />
          </label>
          <label>
            OpenAI URL
            <input v-model="form.openaiURL" placeholder="https://api.example.com/v1" />
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
          </template>

          <div v-if="form.type !== 'workbuddy'" class="model-editor">
            <div class="model-editor-header">
              <span class="model-editor-title">模型列表</span>
              <button class="btn-ghost btn-sm" @click="addModelRow">+ 添加模型</button>
            </div>
            <div class="model-editor-hint">
              第一个模型为默认模型。最大上下文与最大输出不填即为空，填写后会在请求未指定 max_tokens 时自动注入。
              推理档位逐模型配置（下拉可选 low / high / max / xhigh，或输入自定义值），选「默认」表示不干预客户端请求。
            </div>

            <div v-for="(model, index) in form.models" :key="index" class="model-edit-row">
              <div class="model-edit-line">
                <input v-model="model.id" class="model-id-input" placeholder="模型 ID，如 glm-4.6" />
                <input v-model="model.displayName" class="model-name-input" placeholder="显示名称（可选）" />
                <button class="model-remove-btn" @click="removeModelRow(index)" title="移除该模型">×</button>
              </div>
              <div class="model-edit-line">
                <div class="limit-field">
                  <span class="limit-label">最大上下文</span>
                  <input v-model="model.maxContext" type="number" min="1" placeholder="留空" />
                </div>
                <div class="limit-field">
                  <span class="limit-label">最大输出</span>
                  <input v-model="model.maxOutput" type="number" min="1" placeholder="留空" />
                </div>
              </div>
              <div class="model-edit-line model-edit-effort">
                <span class="limit-label">推理档位</span>
                <select
                  class="effort-select-sm"
                  :value="effortSelectValue(model, EFFORT_PRESETS)"
                  @change="onEffortSelect(model, $event.target.value)"
                >
                  <option value="">默认（不干预）</option>
                  <option v-for="e in EFFORT_PRESETS" :key="e" :value="e">{{ e }}</option>
                  <option value="__custom">自定义…</option>
                </select>
                <input v-model="model.reasoningEffort" class="effort-input" placeholder="或输入自定义值" />
              </div>
            </div>

            <div v-if="!form.models.length" class="model-editor-empty">至少需要一个模型</div>
          </div>

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
import { ref, computed, onMounted } from 'vue'
import { useModel } from '../composables/useModel.js'
import { showToast } from '../composables/useToast.js'
import {
  getProviderFull,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  wbAccounts as fetchWbAccounts,
  wbEnabledModels
} from '../api.js'
import { formatNumber } from '../utils/format.js'

// 模型 chip 超过该数量时折叠，点击 +N 展开
const MODEL_COLLAPSE_LIMIT = 3

const { currentModel, providers, loadModelData, switchModel, notifyTray } = useModel()
const showAdd = ref(false) // 是否显示新增弹窗
const testingName = ref('') // 正在测试中的 provider 名
const testResults = ref({}) // 连通性测试结果
const editingName = ref('') // 正在编辑的 provider 名
const showKey = ref(false) // API Key 密码/明文切换
const expanded = ref(new Set()) // 已展开全部模型的 provider 名
const form = ref(emptyForm()) // 编辑表单数据
const wbAccounts = ref([]) // WorkBuddy 账号池的账号列表（只读展示自动轮转的账号）
const enabledModels = ref([]) // 账号池统一维护的启用模型清单（只读展示）
const wbModelList = ref([]) // WorkBuddy 表单的模型清单（由启用清单构建，档位可逐模型编辑）

const providerCount = computed(() => Object.keys(providers.value).length)

// 是否已存在 WorkBuddy 源（全局唯一，已存在时禁用新增入口）
const hasWorkbuddyProvider = computed(() => Object.values(providers.value).some(p => p.type === 'workbuddy'))

// 弹窗标题：编辑态显示「编辑 Provider」，新增态按入口类型区分
const modalTitle = computed(() => {
  if (editingName.value) return '编辑 Provider'
  return form.value.type === 'workbuddy' ? '添加 WorkBuddy 账号池' : '新增通用 Provider'
})

// 生成一份空白表单
function emptyForm() {
  return {
    name: '', // Provider ID
    displayName: '', // 显示名称
    type: '', // Provider 类型（空=通用端点，workbuddy=账号池）
    baseURL: '', // Anthropic 端点 URL
    openaiURL: '', // OpenAI 端点 URL
    apiKey: '', // API Key
    models: [emptyModel()] // 模型列表
  }
}

// 加载账号池数据（账号列表 + 启用模型清单），供 WorkBuddy 类型表单使用
// existingModels：编辑态传入当前 Provider 的模型列表，用于回填各模型已配置的推理档位
async function loadWorkbuddyData(existingModels) {
  try {
    const [acctRes, modelRes] = await Promise.all([fetchWbAccounts(), wbEnabledModels()])
    wbAccounts.value = acctRes.accounts || []
    enabledModels.value = modelRes.models || []
  } catch {
    // 账号池接口不可用时静默降级（表单仍可保存通用配置）
    wbAccounts.value = []
    enabledModels.value = []
  }
  wbModelList.value = buildWbModelList(existingModels)
}

// 由账号池启用清单构建 WorkBuddy 模型列表
// 档位候选来自后台拉取的 efforts；已配置过的档位优先回填，否则用后台默认档
// 上下文与最大输出优先用 Provider 侧已配置值，未配置时回填后台拉取到的值
function buildWbModelList(existingModels) {
  const configured = new Map((existingModels || []).map(m => [m.id, m]))
  return enabledModels.value.map(m => {
    const saved = configured.get(m.id)
    const efforts = Array.isArray(m.efforts) ? m.efforts.slice() : []
    const savedEffort = (saved?.reasoningEffort || '').trim()
    const defaultEffort = (m.defaultEffort || '').trim()
    const effort = savedEffort || (efforts.includes(defaultEffort) ? defaultEffort : '')
    return {
      id: m.id, // 模型 id
      displayName: m.displayName || '', // 显示名
      maxContext: saved?.maxContext ?? m.maxContext ?? null, // 最大上下文（Provider 侧优先）
      maxOutput: saved?.maxOutput ?? m.maxOutput ?? null, // 最大输出（Provider 侧优先）
      efforts, // 该模型后台支持的档位候选
      reasoningEffort: effort, // 当前档位（已配置优先，否则预选后台默认档）
      custom: !!effort && !efforts.includes(effort) // 当前档位是否为列表外的自定义值
    }
  })
}

// 账号状态标签文案（与账号池页面保持同一口径）
function accountStateLabel(acct) {
  if (acct.disabled) return '已禁用'
  if (acct.cooling) return '冷却中'
  return '可用'
}

// 账号状态标签样式类
function accountStateClass(acct) {
  if (acct.disabled) return 'is-bad'
  if (acct.cooling) return 'is-warn'
  return 'is-ok'
}

// 通用 Provider 的档位候选（WorkBuddy 源改用后台拉取的候选，不用这里）
const EFFORT_PRESETS = ['low', 'high', 'max', 'xhigh']

// 档位下拉的当前显示值：空 = 默认（不干预）；命中候选档位原样返回；其余归入自定义
// fallback：模型没有后台候选时使用的兜底候选（通用 Provider 传固定档位表）
function effortSelectValue(model, fallback) {
  const v = (model.reasoningEffort || '').trim()
  if (!v) return ''
  const efforts = Array.isArray(model.efforts) && model.efforts.length ? model.efforts : fallback || []
  return efforts.includes(v) ? v : '__custom'
}

// 档位下拉变更：选候选档位即写入；选「默认」清空；选「自定义」进入手填
function onEffortSelect(model, value) {
  if (value === '__custom') {
    model.custom = true
    return
  }
  model.custom = false
  model.reasoningEffort = value
}

// 生成一行空白模型配置
function emptyModel() {
  return { id: '', displayName: '', maxContext: null, maxOutput: null, reasoningEffort: '' }
}

// 当前激活的 Provider 名（currentModel 形如 provider/model）
function isCurrentProvider(name) {
  return currentModel.value === name || currentModel.value.startsWith(`${name}/`)
}

// 限制值展示：未配置显示短横线
function formatLimit(value) {
  if (value === null || value === undefined || value === '') return '-'
  return formatNumber(value)
}

// 展开状态下显示全部模型，否则只显示前 N 个
function visibleModels(provider, name) {
  const models = provider.models || []
  return expanded.value.has(name) ? models : models.slice(0, MODEL_COLLAPSE_LIMIT)
}

// 切换某个 Provider 的模型展开状态
function toggleExpand(name) {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

// 重置表单
function resetForm() {
  form.value = emptyForm()
  showKey.value = false
}

// 关闭弹窗
function closeModal() {
  showAdd.value = false
  editingName.value = ''
  showKey.value = false
  resetForm()
}

function addModelRow() {
  form.value.models.push(emptyModel())
}

function removeModelRow(index) {
  form.value.models.splice(index, 1)
}

// 打开编辑弹窗，加载完整的 apiKey 与账号池数据
async function editProvider(name, provider) {
  editingName.value = name
  form.value = {
    name,
    displayName: provider.displayName || '',
    type: provider.type || '',
    baseURL: provider.baseURL || '',
    openaiURL: provider.openaiURL || '',
    apiKey: '', // 先置空，下面异步回填
    models: (provider.models || []).length
      ? provider.models.map(m => ({
          id: m.id || '',
          displayName: m.displayName || '',
          maxContext: m.maxContext ?? null,
          maxOutput: m.maxOutput ?? null
        }))
      : [emptyModel()]
  }
  showKey.value = false
  if (form.value.type === 'workbuddy') loadWorkbuddyData(provider.models)
  try {
    const full = await getProviderFull(name)
    form.value.apiKey = full.apiKey || ''
  } catch {}
}

// 打开新增弹窗：type 为空 = 通用 Provider，'workbuddy' = WorkBuddy 账号池（由入口按钮决定类型）
function openAddModal(type = '') {
  resetForm()
  form.value.type = type
  if (type === 'workbuddy') loadWorkbuddyData()
  showAdd.value = true
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

// 空值与非法值统一转成 null，未配置即不写入
function toLimitOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

// 保存 provider
async function saveProvider() {
  const isWorkbuddy = form.value.type === 'workbuddy'
  // WorkBuddy 类型的模型清单来自账号池统一配置（档位在 Provider 侧逐模型独立配置）；通用类型用表单里的模型编辑区
  const models = isWorkbuddy
    ? wbModelList.value
        .map(m => ({
          id: (m.id || '').trim(),
          displayName: (m.displayName || '').trim(),
          maxContext: toLimitOrNull(m.maxContext),
          maxOutput: toLimitOrNull(m.maxOutput),
          reasoningEffort: (m.reasoningEffort || '').trim()
        }))
        .filter(m => m.id)
    : form.value.models
        .map(m => ({
          id: (m.id || '').trim(),
          displayName: (m.displayName || '').trim(),
          maxContext: toLimitOrNull(m.maxContext),
          maxOutput: toLimitOrNull(m.maxOutput),
          reasoningEffort: (m.reasoningEffort || '').trim()
        }))
        .filter(m => m.id)

  if (!form.value.name.trim()) {
    showToast('请填写 Provider 名称', 'error')
    return
  }
  if (!models.length) {
    showToast(
      isWorkbuddy
        ? '账号池尚未配置模型，请先到「账号池」页面的「模型和档位」勾选要启用的模型'
        : '至少需要一个模型，且模型 ID 不能为空',
      'error'
    )
    return
  }

  const data = {
    displayName: form.value.displayName.trim(),
    type: form.value.type,
    baseURL: form.value.baseURL.trim(),
    openaiURL: form.value.openaiURL.trim(),
    apiKey: form.value.apiKey,
    models
  }

  try {
    if (editingName.value) {
      await updateProvider(editingName.value, data)
      showToast(`已保存 Provider「${editingName.value}」`)
    } else {
      await addProvider(form.value.name.trim(), data)
      showToast(`已新增 Provider「${form.value.name.trim()}」`)
    }
    closeModal()
    await loadModelData()
    notifyTray() // 模型列表可能变化，刷新托盘菜单
  } catch (err) {
    showToast('保存失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  }
}

// 删除 provider，服务端会同步清理相关引用
async function removeProvider(name) {
  const label = providers.value[name]?.displayName || name
  if (!window.confirm(`确定删除 Provider「${label}」吗？\n指向它的路由规则、兜底配置和当前模型引用会一并清理。`)) {
    return
  }
  try {
    const result = await deleteProvider(name)
    await loadModelData()
    notifyTray() // 模型列表与当前选中可能变化，刷新托盘菜单
    const cleaned = result?.cleaned || []
    showToast(cleaned.length ? `已删除「${label}」，并清理了 ${cleaned.length} 处引用` : `已删除「${label}」`)
  } catch (err) {
    showToast('删除失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  }
}

// 切换到指定模型引用
async function useModelRef(ref) {
  if (currentModel.value === ref) return
  const ok = await switchModel(ref)
  showToast(ok ? `已切换到 ${ref}` : '切换失败，请检查服务是否在线', ok ? 'success' : 'error')
}

// 设为当前：使用该 Provider 的默认模型
async function setAsCurrent(name) {
  const first = providers.value[name]?.models?.[0]
  if (!first) {
    showToast('该 Provider 还没有配置模型', 'error')
    return
  }
  await useModelRef(`${name}/${first.id}`)
}

// 测试连通性：优先使用当前选中的模型（未选中该 Provider 的模型时回落第一个模型）
async function runTest(name) {
  testingName.value = name
  testResults.value[name] = null
  const ref = currentModel.value || ''
  const modelId = ref.startsWith(`${name}/`) ? ref.slice(name.length + 1) : ''
  try {
    testResults.value[name] = await testProvider(name, modelId)
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
  margin-bottom: 20px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}

/* 右上角新增入口按钮组（通用 Provider / WorkBuddy 账号池） */
.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 编辑弹窗中的只读类型行 */
.form-type-line {
  font-size: 12px;
  color: var(--text-3);
  padding: 2px 0;
}

.empty-state {
  text-align: center;
  color: var(--text-3);
  padding: 40px;
  font-size: 14px;
}

/* 每行一个 Provider */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.provider-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  background: #FFFFFF;
  border: 1px solid var(--border-1);
  border-left: 3px solid transparent;
  border-radius: 12px;
  padding: 14px 18px;
  transition: box-shadow 0.15s, border-color 0.15s, background 0.15s;
}

.provider-row:hover {
  border-color: #DCDCDC;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
}

.provider-row.active {
  border-left-color: var(--primary);
  background: #FAFCFF;
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.row-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}

.row-id {
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-page);
  border-radius: 6px;
  padding: 2px 7px;
  font-family: 'Courier New', Consolas, monospace;
}

.badge-current {
  font-size: 11px;
  background: rgba(0, 181, 120, 0.08);
  color: var(--success);
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

/* WorkBuddy 账号池类型徽标 */
.badge-type {
  font-size: 11px;
  background: rgba(59, 130, 246, 0.08);
  color: #2563EB;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

/* WorkBuddy 类型在表单中的账号管理入口 */
.wb-entry {
  border: 1px solid var(--border-1);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #FAFCFF;
}

/* 区块标题行（标题 + 右侧跳转链接） */
.wb-entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.wb-entry-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.wb-entry-link {
  font-size: 12px;
  color: var(--primary);
  text-decoration: none;
}

.wb-entry-link:hover {
  text-decoration: underline;
}

.wb-entry-hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.wb-entry-empty {
  font-size: 12px;
  color: var(--text-3);
}

/* 账号只读列表（最多高度内滚动） */
.wb-account-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}

.wb-account-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  font-size: 12px;
}

.wb-account-name {
  flex: 1;
  color: var(--text-1);
}

.wb-account-state {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
}

.wb-account-state.is-ok { color: #16A34A; background: #ECFDF5; }
.wb-account-state.is-warn { color: #D97706; background: #FFFBEB; }
.wb-account-state.is-bad { color: #DC2626; background: #FEF2F2; }

/* 模型清单列表（每行：模型 id + 推理档位 + 上下文/输出上限） */
.wb-model-chips {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 300px;
  overflow-y: auto;
}

/* 单个模型块（两行：id + 档位；上下文 + 输出上限） */
.wb-model-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-1);
}

/* 模型块内的一行 */
.wb-model-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 模型块内的上下限输入行（两个字段等宽平分） */
.wb-model-line .limit-field {
  flex: 1;
  min-width: 0;
}

/* 推理档位快捷选择（与右侧自定义输入框配合使用） */
.effort-select-sm {
  width: 130px;
  font-size: 12px;
  padding: 3px 4px;
  border: 1px solid var(--border-1);
  border-radius: 6px;
  background: #FFFFFF;
  color: var(--text-1);
  cursor: pointer;
}

.effort-select-sm:focus {
  outline: none;
  border-color: var(--primary);
}

/* 推理档位自定义输入框 */
.effort-input {
  width: 130px;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--border-1);
  border-radius: 6px;
  background: #FFFFFF;
  color: var(--text-1);
}

.effort-input:focus {
  outline: none;
  border-color: var(--primary);
}

.wb-model-chip {
  font-size: 11px;
  font-family: 'Courier New', Consolas, monospace;
  color: var(--text-2);
  background: #EEF3FA;
  border-radius: 4px;
  padding: 2px 6px;
}

.row-count {
  font-size: 12px;
  color: #B0B0B0;
}

/* 端点信息：等宽字体 + 超长截断，避免撑破行 */
.row-meta {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.meta-label {
  font-size: 11px;
  color: #B0B0B0;
  flex-shrink: 0;
}

.meta-value {
  font-size: 12px;
  color: #555555;
  font-family: 'Courier New', Consolas, monospace;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 模型 chip */
.row-models {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--bg-hover);
  border: 1px solid var(--border-2);
  border-radius: 8px;
  padding: 4px 6px 4px 10px;
  font-size: 12px;
  max-width: 320px;
}

.model-chip.current {
  border-color: var(--success);
  background: #F3FDF8;
}

.chip-name {
  color: var(--text-1);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-meta {
  color: #B0B0B0;
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

.chip-use {
  background: #FFFFFF;
  border: 1px solid var(--border-3);
  color: #888888;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  flex-shrink: 0;
  transition: all 0.15s;
}

.chip-use:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.chip-use.is-current {
  background: rgba(0, 181, 120, 0.08);
  border-color: var(--success);
  color: var(--success);
}

.chip-more {
  background: transparent;
  border: 1px dashed #D8D8D8;
  color: var(--text-3);
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 8px;
}

.chip-more:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.model-empty {
  font-size: 12px;
  color: #C0C0C0;
}

/* 测试结果内联展示 */
.row-test {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  align-self: flex-start;
  max-width: 100%;
  word-break: break-all;
}

.test-ok {
  background: rgba(0, 181, 120, 0.08);
  color: var(--success);
}

.test-fail {
  background: rgba(255, 59, 48, 0.08);
  color: var(--danger);
}

.row-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

/* 窄屏时操作按钮换行到下方 */
@media (max-width: 1000px) {
  .provider-row {
    flex-direction: column;
  }

  .row-actions {
    width: 100%;
    justify-content: flex-end;
    padding-top: 4px;
    border-top: 1px solid var(--bg-page);
  }

  .meta-value {
    max-width: 220px;
  }
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
  width: 560px;
  max-height: 84vh;
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
  color: var(--text-1);
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--text-3);
  font-size: 22px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.modal-close:hover {
  color: var(--danger);
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
  color: var(--text-2);
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
  border: 1px solid var(--border-3);
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}

.key-eye-btn:hover,
.key-copy-btn:hover {
  background: var(--bg-page);
  border-color: var(--primary);
}

.model-editor {
  border: 1px solid var(--border-1);
  border-radius: 10px;
  padding: 12px;
  background: var(--bg-hover);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.model-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.model-editor-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.model-editor-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}

.model-edit-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #FFFFFF;
  border: 1px solid var(--border-1);
  border-radius: 10px;
  padding: 10px;
}

.model-edit-line {
  display: flex;
  gap: 6px;
  align-items: center;
}

.model-id-input {
  flex: 2;
}

.model-name-input {
  flex: 1.4;
}

.model-remove-btn {
  background: transparent;
  border: 1px solid var(--border-3);
  color: var(--text-3);
  width: 30px;
  height: 30px;
  border-radius: 8px;
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}

.model-remove-btn:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.limit-field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}

.limit-label {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

.limit-field input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
}

/* 推理档位行：下拉固定宽，自定义输入占满剩余空间，与上下限输入同高 */
.model-edit-effort .effort-select-sm {
  width: 140px;
  flex-shrink: 0;
}

.model-edit-effort .effort-input {
  flex: 1;
  width: auto;
  min-width: 0;
}

.model-edit-row .effort-select-sm,
.model-edit-row .effort-input {
  padding: 6px 10px;
  font-size: 13px;
}

.model-editor-empty {
  font-size: 12px;
  color: #B0B0B0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
