<template>
  <div class="routing">
    <h1 class="page-title">路由规则</h1>

    <div class="section">
      <h2 class="section-title">兜底模型</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">主模型失败时切换到</label>
          <div class="config-control">
            <select v-model="fallbackModel" class="fallback-select">
              <option value="">不启用兜底</option>
              <option v-for="(p, name) in providers" :key="name" :value="name">
                {{ p.displayName || name }}
              </option>
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
        <div class="rule-hint" v-if="rules.length <= 1">暂无自定义路由规则，所有请求将使用兜底模型。点击下方添加规则。</div>
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
            <option value="chatbot_task">聊天/问答</option>
            <option value="default">默认</option>
          </select>
          <span class="rule-arrow">→</span>
          <select v-model="rule.target" class="rule-target">
            <option v-for="(p, name) in providers" :key="name" :value="name">
              {{ p.displayName || name }}
            </option>
          </select>
          <button class="btn-danger" @click="removeRule(i)" v-if="rule.condition !== 'default'">删除</button>
        </div>
        <div class="section-actions">
          <button class="btn-ghost" @click="addRule">+ 添加规则</button>
          <button class="btn-primary" @click="saveRules">保存路由规则</button>
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
            <option v-for="(p, name) in providers" :key="name" :value="name">
              {{ p.displayName || name }}
            </option>
          </select>
          <button class="btn-danger" @click="removeCustomRule(i)">删除</button>
        </div>
        <div class="section-actions">
          <button class="btn-ghost" @click="addCustomRule">+ 添加匹配规则</button>
          <button class="btn-primary" @click="saveCustomRules">保存匹配规则</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getProviders, getRules, updateRules, getFallback, updateFallback } from '../api.js'

const providers = ref({})
const fallbackModel = ref('')
const rules = ref([])
const customRules = ref([])

async function saveFallback() {
  try {
    await updateFallback(fallbackModel.value)
  } catch {}
}

function addRule() {
  rules.value.splice(rules.value.length - 1, 0, { condition: 'contains_code', target: Object.keys(providers.value)[0] || '' })
}

function removeRule(index) {
  rules.value.splice(index, 1)
}

async function saveRules() {
  try {
    await updateRules({ rules: rules.value, customRules: customRules.value })
  } catch {}
}

function addCustomRule() {
  customRules.value.push({ keyword: '', target: Object.keys(providers.value)[0] || '' })
}

function removeCustomRule(index) {
  customRules.value.splice(index, 1)
}

async function saveCustomRules() {
  try {
    await updateRules({ rules: rules.value, customRules: customRules.value })
  } catch {}
}

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
  color: #1A1A1A;
}

.section {
  margin-bottom: 28px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #1A1A1A;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid #F0F0F0;
}

.config-row:last-of-type {
  border-bottom: none;
}

.config-label {
  width: 200px;
  font-size: 14px;
  font-weight: 500;
  color: #1A1A1A;
  flex-shrink: 0;
}

.config-control {
  display: flex;
  gap: 8px;
  align-items: center;
}

.config-hint {
  font-size: 12px;
  color: #999999;
  padding: 4px 0 8px;
}

.fallback-select {
  width: 220px;
}

.rule-hint {
  font-size: 13px;
  color: #999999;
  padding: 8px 0;
}

.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #F0F0F0;
}

.rule-row:last-of-type {
  border-bottom: none;
}

.rule-condition {
  width: 160px;
}

.rule-target {
  width: 140px;
}

.rule-arrow {
  color: #999999;
  font-size: 16px;
}

.custom-label {
  font-size: 13px;
  color: #666666;
  white-space: nowrap;
}

.custom-keyword {
  width: 160px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid #E0E0E0;
  font-size: 13px;
}

.section-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
</style>
