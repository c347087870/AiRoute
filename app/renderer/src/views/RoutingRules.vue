<template>
  <div class="routing">
    <h1 class="page-title">路由规则</h1>

    <div v-if="!hasModels" class="warning-box">
      请先在 Provider 管理中配置至少一个模型，否则无法选择路由目标。
    </div>

    <div class="section">
      <h2 class="section-title">兜底模型</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">主模型失败时切换到</label>
          <div class="config-control">
            <select v-model="fallbackModel" class="fallback-select">
              <option value="">不启用兜底</option>
              <option v-if="staleLabel(fallbackModel)" :value="fallbackModel">{{ staleLabel(fallbackModel) }}</option>
              <optgroup v-for="(group, gi) in modelGroups" :key="gi" :label="group.label">
                <option v-for="opt in group.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </optgroup>
            </select>
            <button class="btn-primary" @click="saveFallback">保存</button>
          </div>
        </div>
        <div class="config-hint">
          当前模型请求失败时，自动切换到该模型。如果兜底模型也失败，则直接返回错误。
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">智能路由规则</h2>
      <div class="card">
        <div class="rule-hint" v-if="!hasEditableRule">暂无自定义路由规则，所有请求将使用兜底模型。点击下方添加规则。</div>
        <div v-for="(rule, i) in rules" :key="i" class="rule-row">
          <select v-model="rule.condition" class="rule-condition">
            <option value="contains_code">包含代码</option>
            <option value="contains_sql">包含 SQL</option>
            <option value="lang_zh">中文任务</option>
            <option value="lang_en_request">英语请求</option>
            <option value="knowledge_query">知识问答</option>
            <option value="creative_writing">创意写作</option>
            <option value="math_task">数学计算</option>
            <option value="summarize">文本摘要</option>
            <option value="translate">翻译任务</option>
            <option value="code_review">代码审查/优化</option>
            <option value="write_test">编写测试</option>
            <option value="long_context">长上下文</option>
            <option value="default" :disabled="rule.condition !== 'default' && hasDefaultRule">默认</option>
          </select>
          <span class="rule-arrow">→</span>
          <select v-model="rule.target" class="rule-target">
            <option v-if="staleLabel(rule.target)" :value="rule.target">{{ staleLabel(rule.target) }}</option>
            <optgroup v-for="(group, gi) in modelGroups" :key="gi" :label="group.label">
              <option v-for="opt in group.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </optgroup>
          </select>
          <button class="btn-danger" @click="removeRule(i)" v-if="rule.condition !== 'default'">删除</button>
        </div>
        <div class="section-actions">
          <button class="btn-ghost" @click="addRule">+ 添加规则</button>
          <button class="btn-primary" @click="saveAll('路由规则已保存')">保存路由规则</button>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">自定义匹配规则</h2>
      <div class="card">
        <div class="rule-hint" v-if="!customRules.length">暂无自定义匹配规则。输入特定字符串时自动路由到指定模型（优先级最高）。</div>
        <div v-for="(rule, i) in customRules" :key="i" class="rule-row">
          <span class="custom-label">当请求包含</span>
          <input v-model="rule.keyword" class="custom-keyword" placeholder="匹配字符串" />
          <span class="rule-arrow">→</span>
          <select v-model="rule.target" class="rule-target">
            <option v-if="staleLabel(rule.target)" :value="rule.target">{{ staleLabel(rule.target) }}</option>
            <optgroup v-for="(group, gi) in modelGroups" :key="gi" :label="group.label">
              <option v-for="opt in group.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </optgroup>
          </select>
          <button class="btn-danger" @click="removeCustomRule(i)">删除</button>
        </div>
        <div class="section-actions">
          <button class="btn-ghost" @click="addCustomRule">+ 添加匹配规则</button>
          <button class="btn-primary" @click="saveAll('匹配规则已保存')">保存匹配规则</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getProviders, getRules, updateRules, getFallback, updateFallback } from '../api.js'
import { showToast } from '../composables/useToast.js'
import { buildModelGroups, listModels, resolveRefLabel } from '../utils/models.js'

const providers = ref({}) // Provider 配置表，键为 provider 名
const fallbackModel = ref('') // 兜底模型引用（provider/model），空字符串表示不启用兜底
const rules = ref([]) // 智能路由规则列表
const customRules = ref([]) // 自定义匹配规则列表

// 按 Provider 分组的模型选项，供 target 下拉渲染 optgroup
const modelGroups = computed(() => buildModelGroups(providers.value))
// 是否已配置至少一个模型，无模型时页面顶部给出提示
const hasModels = computed(() => modelGroups.value.length > 0)
// 是否已存在默认规则，用于阻止在界面上添加出第二个 default
const hasDefaultRule = computed(() => rules.value.some(r => r.condition === 'default'))
// 是否存在非默认的路由规则，用于空状态提示
const hasEditableRule = computed(() => rules.value.some(r => r.condition !== 'default'))
// 所有可选模型引用的集合，用于判断已保存的引用是否仍然对得上
const allModelRefs = computed(() => {
  const set = new Set()
  for (const group of modelGroups.value) {
    for (const option of group.options) set.add(option.value)
  }
  return set
})

// 统一提取接口错误信息用于提示
function errorText(err) {
  return err?.response?.data?.error || err?.message || '无法连接服务'
}

// 已保存的引用在下拉里找不到对应项时（例如老配置里的纯 Provider 名 glm），
// 返回它的实际解析结果作为占位标签，避免下拉显示成第一项但实际值没变
function staleLabel(value) {
  if (!value || allModelRefs.value.has(value)) return null
  return `${resolveRefLabel(providers.value, value)}（引用待更新）`
}

// 第一个可用模型引用，作为新增规则的默认目标
function firstModelRef() {
  return listModels(providers.value)[0]?.ref || ''
}

// 保存兜底模型
async function saveFallback() {
  try {
    await updateFallback(fallbackModel.value)
    showToast('兜底模型已保存')
  } catch (err) {
    showToast('保存失败: ' + errorText(err), 'error', 4000)
  }
}

// 新增路由规则：插到默认规则之前，没有默认规则则追加到末尾
function addRule() {
  const rule = { condition: 'contains_code', target: firstModelRef() }
  const defaultIndex = rules.value.findIndex(r => r.condition === 'default')
  if (defaultIndex === -1) rules.value.push(rule)
  else rules.value.splice(defaultIndex, 0, rule)
}

// 删除路由规则，默认规则由模板隐藏删除按钮保护
function removeRule(index) {
  rules.value.splice(index, 1)
}

// 新增自定义匹配规则
function addCustomRule() {
  customRules.value.push({ keyword: '', target: firstModelRef() })
}

// 删除自定义匹配规则
function removeCustomRule(index) {
  customRules.value.splice(index, 1)
}

// 保存路由规则与匹配规则，message 用于区分两个入口的成功提示
async function saveAll(message) {
  try {
    await updateRules({ rules: rules.value, customRules: customRules.value })
    showToast(message)
  } catch (err) {
    showToast('保存失败: ' + errorText(err), 'error', 4000)
  }
}

// 加载 Provider、路由规则与兜底配置
async function loadData() {
  try {
    const [provs, rulesData, fb] = await Promise.all([
      getProviders(), getRules(), getFallback()
    ])
    providers.value = provs
    rules.value = rulesData.rules || []
    customRules.value = rulesData.customRules || []
    fallbackModel.value = fb.model || ''
  } catch {}
}

onMounted(loadData)
</script>

<style scoped>
.page-title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 24px;
  color: var(--text-1);
}

.section {
  margin-bottom: 28px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-1);
}

.config-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-2);
}

.config-row:last-of-type {
  border-bottom: none;
}

.config-label {
  width: 200px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
  flex-shrink: 0;
}

.config-control {
  display: flex;
  gap: 8px;
  align-items: center;
}

.config-hint {
  font-size: 12px;
  color: var(--text-3);
  padding: 4px 0 8px;
}

.warning-box {
  background: #FFF7ED;
  border: 1px solid var(--warning);
  color: #B45309;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  margin-bottom: 16px;
}

.fallback-select {
  width: 260px;
}

.rule-hint {
  font-size: 13px;
  color: var(--text-3);
  padding: 8px 0;
}

.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-2);
}

.rule-row:last-of-type {
  border-bottom: none;
}

.rule-condition {
  width: 160px;
}

.rule-target {
  width: 200px;
}

.rule-arrow {
  color: var(--text-3);
  font-size: 16px;
}

.custom-label {
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
}

.custom-keyword {
  width: 160px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-3);
  font-size: 13px;
}

.section-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
