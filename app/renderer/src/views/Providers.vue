<template>
  <div class="providers">
    <div class="page-toolbar">
      <div class="header-actions">
        <AppButton variant="primary" @click="openAddModal()">+ 通用 Provider</AppButton>
      </div>
    </div>

    <div v-if="!providerCount" class="card empty">
      还没有配置任何 Provider，点击右上角「+ 通用 Provider」开始。
      免费账号（含 WorkBuddy）由「渠道账号」页登录后自动出现在渠道源里。
      <!-- 第一次启动就摸到这里的人多半是跳过了引导：给一条回到引导的路，
           比让他读两句说明再自己猜「渠道源」在哪要好 -->
      <div class="empty-actions">
        <AppButton variant="secondary" @click="startOnboarding(1)">用新手引导一步步配置</AppButton>
      </div>
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
            <span v-if="provider.type === 'channel'" class="badge-type">渠道</span>
            <span v-if="isCurrentProvider(name)" class="badge-current">当前</span>
            <span class="row-count">{{ provider.models?.length || 0 }} 个模型</span>
          </div>

          <div class="row-meta">
            <template v-if="provider.type === 'channel'">
              <span class="meta-item">
                <span class="meta-label">来源</span>
                <span class="meta-value">渠道包（10 家免费账号 + WorkBuddy 国内版 / 国际版）</span>
              </span>
              <span class="meta-item">
                <span class="meta-label">账号</span>
                <span class="meta-value">在「渠道账号」页登录与管理</span>
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
                :class="{ current: currentModel === `${name}/${model.id}`, offline: !!healthOf(name, model)?.offline }"
                :title="`${model.id}｜上下文 ${formatLimit(model.maxContext)}｜输出 ${formatLimit(model.maxOutput)}`"
              >
                <span class="chip-name">{{ modelLabel(provider, model) }}</span>
                <span class="chip-meta">
                  {{ formatLimit(model.maxContext) }} / {{ formatLimit(model.maxOutput) }}
                </span>
                <!-- 失活：网关不再把请求派给它；点标签恢复（不动配置） -->
                <span
                  v-if="healthOf(name, model)?.offline"
                  class="chip-offline"
                  :title="`已失活：${healthOf(name, model).detail || healthOf(name, model).reason || '原因未知'}；点击恢复`"
                  @click.stop="reviveHealth(name, model)"
                >失活</span>
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
          <AppButton variant="secondary" v-if="testingName === name" @click="stopTest">停止</AppButton>
          <AppButton variant="secondary" v-else @click="runTest(name)" :disabled="!!testingName">
            测试
          </AppButton>
          <AppButton variant="secondary" @click="editProvider(name, provider)">编辑</AppButton>
          <AppButton variant="primary" @click="setAsCurrent(name)">设为当前</AppButton>
          <AppButton variant="danger" @click="removeProvider(name)">删除</AppButton>
        </div>
      </div>
    </div>

    <div v-if="showAdd || editingName" class="modal-overlay">
      <div class="card modal">
        <div class="modal-header">
          <h2>{{ modalTitle }}</h2>
          <AppButton variant="ghost" iconOnly class="modal-close" @click="closeModal">×</AppButton>
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
            类型：{{ form.type === 'channel' ? '账号渠道（渠道包）' : '通用端点（OpenAI / Anthropic）' }}
          </div>

          <template v-if="form.type !== 'channel'">
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
              <AppButton variant="secondary" iconOnly class="key-eye-btn" @click="showKey = !showKey" :title="showKey ? '隐藏' : '显示'">
                {{ showKey ? '🙈' : '👁' }}
              </AppButton>
              <AppButton variant="secondary" iconOnly class="key-copy-btn" @click="copyKey" title="复制">📋</AppButton>
            </div>
          </label>
          </template>

          <div class="model-editor">
            <div class="model-editor-header">
              <span class="model-editor-title">模型列表</span>
              <div v-if="form.type !== 'channel'" class="model-editor-actions">
                <AppButton variant="secondary" :disabled="picker.loading" title="用上面的 URL 与 API Key 向上游查询 /models 接口" @click="openModelPicker">
                  {{ picker.loading ? '拉取中…' : '从接口拉取模型' }}
                </AppButton>
                <AppButton variant="secondary" @click="addModelRow">+ 添加模型</AppButton>
              </div>
            </div>
            <div class="model-editor-hint">
              <template v-if="form.type === 'channel'">
                渠道模型的清单由渠道包维护（登录/退出账号、账号池改启用清单后自动同步）。
                这里改<strong>显示名</strong>与<strong>推理档位</strong>会在下次同步时保留；
                模型 ID 与上下文/输出上限以目录为准，改了会被刷新覆盖。
              </template>
              <template v-else>
                第一个模型为默认模型。最大上下文与最大输出不填即为空，填写后会在请求未指定 max_tokens 时自动注入。
                推理档位逐模型配置（下拉可选 low / high / max / xhigh，或输入自定义值），选「默认」表示不干预客户端请求。
                填好 URL 与 Key 后点「从接口拉取模型」，可一次带出上游全部模型。
              </template>
            </div>

            <div v-for="(model, index) in form.models" :key="index" class="model-edit-row">
              <div class="model-edit-line">
                <input v-model="model.id" class="model-id-input" placeholder="模型 ID，如 glm-4.6" />
                <input v-model="model.displayName" class="model-name-input" placeholder="显示名称（可选）" />
                <AppButton variant="ghost" iconOnly class="model-remove-btn" @click="removeModelRow(index)" title="移除该模型">×</AppButton>
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
            <AppButton variant="secondary" @click="closeModal">取消</AppButton>
            <AppButton variant="primary" @click="saveProvider">保存</AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 模型清单选择层：放在 Provider 弹窗之外，避免被 .form 的输入框/label 样式影响 -->
    <div v-if="picker.open" class="modal-overlay picker-overlay">
      <div class="card modal picker-modal">
        <div class="modal-header">
          <h2>从接口拉取模型</h2>
          <AppButton variant="ghost" iconOnly class="modal-close" @click="closePicker">×</AppButton>
        </div>

        <div v-if="picker.loading" class="picker-state">正在向上游查询模型列表…</div>
        <div v-else-if="picker.error" class="picker-state picker-error">
          <div>{{ picker.error }}</div>
          <AppButton variant="secondary" @click="openModelPicker">重试</AppButton>
        </div>
        <template v-else>
          <div class="picker-meta">
            来源 {{ picker.sources.map(sourceLabel).join(' + ') || '未知' }} · 共
            {{ picker.all.length }} 个模型 · 已选 {{ picker.selected.size }} 个。
            应用后合并进表单：已存在的模型保留原有上限与推理档位，新模型自动带出命中的上下文/输出上限。
          </div>
          <div class="picker-toolbar">
            <input v-model="picker.keyword" class="picker-search" placeholder="搜索模型 ID" />
            <label class="picker-toggle">
              <input v-model="picker.showAll" type="checkbox" />
              显示全部（含 embedding / 语音 / 图像）
            </label>
            <AppButton variant="secondary" @click="selectAllVisible">全选</AppButton>
            <AppButton variant="secondary" @click="clearSelection">清空</AppButton>
          </div>
          <div class="picker-list">
            <label v-for="m in visiblePickerModels" :key="m.id" class="picker-row">
              <input type="checkbox" :checked="picker.selected.has(m.id)" @change="togglePick(m.id)" />
              <span class="picker-id">{{ m.id }}</span>
              <span v-if="!m.chat" class="picker-tag">非对话</span>
              <span v-if="m.maxContext" class="picker-limit">ctx {{ formatNumber(m.maxContext) }}</span>
              <span v-if="m.displayName" class="picker-name">{{ m.displayName }}</span>
            </label>
            <div v-if="!visiblePickerModels.length" class="picker-empty">没有匹配的模型</div>
          </div>
        </template>

        <div class="form-actions">
          <AppButton variant="secondary" @click="closePicker">取消</AppButton>
          <AppButton variant="primary" :disabled="picker.loading || !picker.selected.size" @click="applyPickedModels">
            应用（{{ picker.selected.size }}）
          </AppButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useModel } from '../composables/useModel.js'
import { useOnboarding } from '../composables/useOnboarding.js'
import { showToast } from '../composables/useToast.js'
import { useEscClose } from '../composables/useEscClose.js'
import {
  getProviderFull,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  fetchProviderModels,
  getModelHealth,
  reviveModel
} from '../api.js'
import { formatNumber } from '../utils/format.js'
import { modelLabel } from '../utils/models.js'

import AppButton from '../components/AppButton.vue'
const route = useRoute()
const router = useRouter()
const { startOnboarding } = useOnboarding()

// 模型 chip 超过该数量时折叠，点击 +N 展开
const MODEL_COLLAPSE_LIMIT = 3

const { currentModel, providers, loadModelData, switchModel, notifyTray } = useModel()
const showAdd = ref(false) // 是否显示新增弹窗
const testingName = ref('') // 正在测试中的 provider 名
const testResults = ref({}) // 连通性测试结果
// 「停止」用的中止句柄：只置标志的话，卡在上游的测试还要拖到超时才结束
const testController = ref(null)
// 失活台账：键是引用（provider/model）→ { ref, offline, reason, detail }
const modelHealth = ref({})
const editingName = ref('') // 正在编辑的 provider 名
const showKey = ref(false) // API Key 密码/明文切换
const expanded = ref(new Set()) // 已展开全部模型的 provider 名
const form = ref(emptyForm()) // 编辑表单数据

// 上游模型探测结果（选择层）：只存在于表单内，不落盘
// all：探测到的全部模型（含 chat 标记与命中的上下限）；selected：勾选的模型 ID
const picker = ref({
  open: false, // 选择层是否可见
  loading: false, // 正在探测上游
  error: '', // 探测失败文案
  sources: [], // 命中的协议来源（openai / anthropic）
  all: [], // 探测到的模型
  selected: new Set(), // 已勾选的模型 ID
  keyword: '', // 搜索关键字
  showAll: false // 是否显示非对话模型
})

const providerCount = computed(() => Object.keys(providers.value).length)

// 选择层当前可见的模型：默认隐藏非对话模型，关键字按 ID 与展示名匹配
const visiblePickerModels = computed(() => {
  const keyword = picker.value.keyword.trim().toLowerCase()
  return picker.value.all.filter(m => {
    if (!picker.value.showAll && !m.chat) return false
    if (!keyword) return true
    const name = (m.displayName || '').toLowerCase()
    return m.id.toLowerCase().includes(keyword) || name.includes(keyword)
  })
})

// 弹窗标题：编辑态显示「编辑 Provider」，新增态只有通用端点一种
const modalTitle = computed(() => (editingName.value ? '编辑 Provider' : '新增通用 Provider'))

// 生成一份空白表单
function emptyForm() {
  return {
    name: '', // Provider ID
    displayName: '', // 显示名称
    type: '', // Provider 类型（空=通用端点；channel=账号渠道，只读由渠道包维护）
    baseURL: '', // Anthropic 端点 URL
    openaiURL: '', // OpenAI 端点 URL
    apiKey: '', // API Key
    models: [emptyModel()] // 模型列表
  }
}

// 通用 Provider 的档位候选
const EFFORT_PRESETS = ['low', 'high', 'max', 'xhigh']

// 档位下拉的当前显示值：空 = 默认（不干预）；命中候选档位原样返回；其余归入自定义
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
  resetPicker()
}

// 关闭弹窗
function closeModal() {
  showAdd.value = false
  editingName.value = ''
  showKey.value = false
  resetForm()
}

// 新增与编辑共用同一个弹窗，Esc 关闭走 closeModal（含表单重置）
useEscClose(() => showAdd.value || !!editingName.value, closeModal)

function addModelRow() {
  form.value.models.push(emptyModel())
}

function removeModelRow(index) {
  form.value.models.splice(index, 1)
}

// 探测来源的展示文案
function sourceLabel(protocol) {
  if (protocol === 'openai') return 'OpenAI /models'
  if (protocol === 'anthropic') return 'Anthropic /v1/models'
  return protocol
}

// 清空选择层状态（关闭时调用，避免下次打开闪出上次的结果）
function resetPicker() {
  picker.value = {
    open: false,
    loading: false,
    error: '',
    sources: [],
    all: [],
    selected: new Set(),
    keyword: '',
    showAll: false
  }
}

// 关闭选择层
function closePicker() {
  resetPicker()
}

// 用表单当前的 URL 与 Key 探测上游模型清单
async function openModelPicker() {
  const baseURL = form.value.baseURL.trim()
  const openaiURL = form.value.openaiURL.trim()
  const apiKey = form.value.apiKey.trim()
  if (!baseURL && !openaiURL) {
    showToast('请先填写 Anthropic 或 OpenAI 端点 URL', 'error')
    return
  }
  if (!apiKey) {
    showToast('请先填写 API Key', 'error')
    return
  }

  picker.value.open = true
  picker.value.loading = true
  picker.value.error = ''
  picker.value.keyword = ''
  try {
    const res = await fetchProviderModels({ baseURL, openaiURL, apiKey })
    if (!res || !res.ok) {
      picker.value.error = (res && res.error) || '拉取失败'
      picker.value.all = []
      picker.value.sources = []
      picker.value.selected = new Set()
      return
    }
    picker.value.all = Array.isArray(res.models) ? res.models : []
    picker.value.sources = Array.isArray(res.sources) ? res.sources : []
    // 默认勾选：表单里已有的模型必选（保住手填配置），其余对话模型一并带上；
    // 非对话模型不默认勾选，需要切到「显示全部」再手动选
    const existing = new Set(form.value.models.map(m => (m.id || '').trim()).filter(Boolean))
    picker.value.selected = new Set(
      picker.value.all.filter(m => existing.has(m.id) || m.chat).map(m => m.id)
    )
  } catch (err) {
    picker.value.error = err?.response?.data?.error || err?.message || '无法连接本地服务'
  } finally {
    picker.value.loading = false
  }
}

// 勾选/取消单个模型（替换 Set 实例以触发响应式更新）
function togglePick(id) {
  const next = new Set(picker.value.selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  picker.value.selected = next
}

// 全选当前可见（受搜索与「显示全部」过滤）的模型
function selectAllVisible() {
  const next = new Set(picker.value.selected)
  for (const m of visiblePickerModels.value) next.add(m.id)
  picker.value.selected = next
}

// 清空勾选
function clearSelection() {
  picker.value.selected = new Set()
}

// 把勾选的模型合并进表单：
// 已存在的行保留原对象（上限/档位/顺序都不动）；上游有但被取消勾选的移除；上游没返回的手填模型保留；
// 新勾选的模型追加在后（上下限命中 models.dev 时已预填）
function applyPickedModels() {
  const selectedIds = picker.value.selected
  if (!selectedIds.size) {
    showToast('请至少勾选一个模型', 'error')
    return
  }

  const existing = new Map()
  for (const row of form.value.models) {
    const id = (row.id || '').trim()
    if (id && !existing.has(id)) existing.set(id, row)
  }

  const next = []
  const fetched = new Set(picker.value.all.map(m => m.id))
  for (const [id, row] of existing) {
    // 上游列表里有的按勾选结果决定去留；上游没返回的（手填模型）原样保留，避免被静默删掉
    if (fetched.has(id) && !selectedIds.has(id)) continue
    next.push(row)
  }

  for (const m of picker.value.all) {
    if (!selectedIds.has(m.id) || existing.has(m.id)) continue
    next.push({
      id: m.id,
      displayName: m.displayName || '',
      maxContext: m.maxContext ?? null,
      maxOutput: m.maxOutput ?? null,
      reasoningEffort: ''
    })
  }

  if (!next.length) {
    showToast('至少需要一个模型，且模型 ID 不能为空', 'error')
    return
  }

  const added = next.filter(row => !existing.has(row.id)).length
  form.value.models = next
  closePicker()
  showToast(added ? `已合并 ${next.length} 个模型（新增 ${added} 个）` : `已同步 ${next.length} 个模型`)
}

// 打开编辑弹窗，加载完整的 apiKey
async function editProvider(name, provider) {
  editingName.value = name
  resetPicker()
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
          maxOutput: m.maxOutput ?? null,
          // 必须回填：否则保存时以空值覆盖，用户配过的档位会静默丢失
          reasoningEffort: m.reasoningEffort || ''
        }))
      : [emptyModel()]
  }
  showKey.value = false
  try {
    const full = await getProviderFull(name)
    form.value.apiKey = full.apiKey || ''
  } catch {}
}

// 打开新增弹窗：只有通用端点一种入口（账号渠道由渠道包自动建，不在这里加）
function openAddModal() {
  resetForm()
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
  const models = form.value.models
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
    showToast('至少需要一个模型，且模型 ID 不能为空', 'error')
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
  const p = providers.value[name]
  const label = (p && p.displayName) || name
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

// 失活台账只是展示层：读不到就按健康显示，不影响设置本身
async function loadModelHealth() {
  try {
    const data = await getModelHealth()
    const map = {}
    for (const item of data.models || []) {
      if (item.ref) map[item.ref] = item
    }
    modelHealth.value = map
  } catch {
    /* 保留上一份 */
  }
}

function healthOf(name, model) {
  return modelHealth.value[`${name}/${model.id}`] || null
}

async function reviveHealth(name, model) {
  const record = healthOf(name, model)
  if (!record) return
  try {
    await reviveModel(record.ref)
    await loadModelHealth()
    showToast(`已恢复 ${model.displayName || model.id}`)
  } catch (err) {
    showToast('恢复失败：' + err.message, 'error', 6000)
  }
}

// 测试连通性：优先使用当前选中的模型（未选中该 Provider 的模型时回落第一个模型）
async function runTest(name) {
  if (testingName.value) return
  const controller = new AbortController()
  testController.value = controller
  testingName.value = name
  testResults.value[name] = null
  const ref = currentModel.value || ''
  const modelId = ref.startsWith(`${name}/`) ? ref.slice(name.length + 1) : ''
  try {
    const result = await testProvider(name, modelId, controller.signal)
    testResults.value[name] = result
    // 测试通过会让服务端清掉「连续失败」的失活标记，tag 跟着更新
    if (result?.ok) await loadModelHealth()
  } catch (err) {
    if (controller.signal.aborted) {
      testResults.value[name] = null
      showToast('已停止测试')
    } else {
      testResults.value[name] = { ok: false, error: '请求失败', latency: 0 }
    }
  } finally {
    testingName.value = ''
    testController.value = null
  }
}

// 「停止」：断开在途请求，而不是等它自己超时
function stopTest() {
  testController.value?.abort()
}

onMounted(() => {
  loadModelData()
  loadModelHealth()
  openForOnboarding()
})

// 启动引导的「添加模型来源」直接落到新增弹窗上（?onboarding=add）。
// 参数用完就 replace 掉：刷新页面不该又弹出一个空表单
function openForOnboarding() {
  if (route.query.onboarding !== 'add') return
  router.replace({ path: route.path, query: {} })
  openAddModal()
}
</script>

<style scoped>

/* 空态里的引导入口：跟说明文字隔开一行，别和正文挤成一段 */
.empty-actions {
  margin-top: 14px;
}


/* 右上角新增入口按钮组（通用 Provider / WorkBuddy 账号池） */

/* 编辑弹窗中的只读类型行 */
.form-type-line {
  font-size: var(--fs-xs);
  color: var(--text-3);
  padding: 2px 0;
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
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-left: 3px solid transparent;
  border-radius: var(--radius-lg);
  padding: 14px 18px;
  transition: box-shadow 0.15s, border-color 0.15s, background 0.15s;
}

.provider-row:hover {
  border-color: var(--border-3);
  box-shadow: var(--shadow-hover);
}

.provider-row.active {
  border-left-color: var(--primary);
  background: var(--bg-subtle);
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
  font-size: var(--fs-section);
  font-weight: 600;
  color: var(--text-1);
}

.row-id {
  font-size: var(--fs-mini);
  color: var(--text-3);
  background: var(--bg-page);
  border-radius: var(--radius-xs);
  padding: 2px 7px;
  font-family: var(--font-mono);
}

.badge-current {
  font-size: var(--fs-mini);
  background: var(--tint-success);
  color: var(--success);
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-weight: 500;
}

/* WorkBuddy 账号池类型徽标 */
.badge-type {
  font-size: var(--fs-mini);
  background: var(--tint-primary-soft);
  color: var(--primary-text);
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-weight: 500;
}

/* 推理档位快捷选择（与右侧自定义输入框配合使用） */
.effort-select-sm {
  width: 130px;
  font-size: var(--field-fs);
  padding: 0 24px 0 8px;
  background-position: right 7px center;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-xs);
  background: var(--bg-card);
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
  font-size: var(--fs-xs);
  padding: 0 6px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-xs);
  background: var(--bg-card);
  color: var(--text-1);
}

.effort-input:focus {
  outline: none;
  border-color: var(--primary);
}

.row-count {
  font-size: var(--fs-xs);
  color: var(--text-weak);
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
  font-size: var(--fs-mini);
  color: var(--text-weak);
  flex-shrink: 0;
}

.meta-value {
  font-size: var(--fs-xs);
  color: var(--text-strong);
  font-family: var(--font-mono);
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
  border-radius: var(--radius-sm);
  padding: 2px 4px 2px 10px;
  font-size: var(--fs-xs);
  max-width: 360px;
}

.model-chip.current {
  border-color: var(--success);
  background: var(--tint-success-soft);
}

/* 失活：网关判定它此刻不能用（余额/账号/连续失败）。只改描边，不用灰度——
   它可能仍是「当前模型」，用户需要一眼看出「当前选中的这个已经调不通了」 */
.model-chip.offline {
  border-color: var(--bad-text);
}

.chip-offline {
  flex: none;
  padding: 0 5px;
  font-size: var(--fs-mini);
  color: var(--bad-text);
  background: var(--bad-bg);
  border-radius: var(--radius-xs);
  cursor: pointer;
  white-space: nowrap;
}

.chip-offline:hover {
  text-decoration: underline;
}

.chip-name {
  color: var(--text-1);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-meta {
  color: var(--text-weak);
  font-size: var(--fs-mini);
  white-space: nowrap;
  flex-shrink: 0;
}

/* 嵌在模型标签里的动作按钮：高度仍走全站小号按钮，只把左右内边距收窄，
   免得一个「切换」按钮把标签撑到 320px 以外 */
.chip-use {
  display: inline-flex;
  align-items: center;
  height: var(--btn-h);
  padding: 0 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-3);
  color: var(--text-2);
  font-size: var(--btn-fs);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  transition: all 0.15s;
}

.chip-use:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.chip-use.is-current {
  background: var(--tint-success);
  border-color: var(--success);
  color: var(--success);
}

.chip-more {
  display: inline-flex;
  align-items: center;
  height: var(--btn-h);
  padding: 0 10px;
  background: transparent;
  border: 1px dashed var(--border-3);
  color: var(--text-2);
  font-size: var(--btn-fs);
  border-radius: var(--radius-sm);
}

.chip-more:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.model-empty {
  font-size: var(--fs-xs);
  color: var(--text-faint);
}

/* 测试结果内联展示 */
.row-test {
  font-size: var(--fs-xs);
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  align-self: flex-start;
  max-width: 100%;
  word-break: break-all;
}

.test-ok {
  background: var(--tint-success);
  color: var(--success);
}

.test-fail {
  background: var(--tint-danger);
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







.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-small);
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
  flex-shrink: 0;
  font-size: var(--fs-base);
}

.model-editor {
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
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
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--text-1);
}

.model-editor-hint {
  font-size: var(--fs-mini);
  color: var(--text-3);
  line-height: 1.5;
}

.model-edit-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
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

/* 尺寸由 AppButton 的 sm 图标按钮统一提供，这里只管悬停时的危险色 */
.model-remove-btn {
  flex-shrink: 0;
  font-size: var(--fs-section);
}

.model-remove-btn:hover {
  color: var(--danger);
}

.limit-field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
}

.limit-label {
  font-size: var(--fs-xs);
  color: var(--text-3);
  white-space: nowrap;
}

.limit-field input {
  flex: 1;
  min-width: 0;
  padding: 0 10px;
  font-size: var(--fs-small);
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
  padding: 0 10px;
  font-size: var(--fs-small);
}

.model-editor-empty {
  font-size: var(--fs-xs);
  color: var(--text-weak);
}

/* 模型编辑区标题栏右侧的操作按钮组（拉取 / 添加） */
.model-editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ===== 模型拉取选择层 ===== */

/* 叠在 Provider 弹窗之上 */
.picker-overlay {
  z-index: 200;
}

.modal.picker-modal {
  width: 680px;
}

.picker-state {
  padding: 28px 12px;
  text-align: center;
  font-size: var(--fs-small);
  color: var(--text-3);
}

.picker-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: var(--danger);
}

.picker-meta {
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.6;
  margin-bottom: 10px;
}

.picker-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.picker-search {
  flex: 1;
  min-width: 160px;
  padding: 0 10px;
  font-size: var(--fs-small);
}

/* 复选框统一小而紧凑：覆盖全局 input 的大内边距 */
.picker-toolbar input[type='checkbox'],
.picker-row input[type='checkbox'] {
  width: auto;
  flex-shrink: 0;
  padding: 0;
  margin: 0;
  accent-color: var(--primary);
}

.picker-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-xs);
  color: var(--text-3);
  white-space: nowrap;
}

.picker-list {
  max-height: 46vh;
  overflow-y: auto;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  background: var(--bg-card);
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: var(--fs-small);
  cursor: pointer;
  border-bottom: 1px solid var(--bg-page);
}

.picker-row:last-child {
  border-bottom: none;
}

.picker-row:hover {
  background: var(--bg-hover);
}

.picker-id {
  color: var(--text-1);
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.picker-name {
  font-size: var(--fs-mini);
  color: var(--text-3);
  max-width: 38%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-limit {
  font-size: var(--fs-mini);
  color: var(--text-3);
  white-space: nowrap;
}

.picker-tag {
  font-size: var(--fs-mini);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-page);
  color: var(--text-3);
  white-space: nowrap;
}

.picker-empty {
  padding: 22px 12px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-weak);
}

/* 未勾选任何模型时「应用」按钮置灰，避免看起来可点 */
.picker-modal .btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>

