<template>
  <div class="benchmark">
    <h1 class="page-title">模型测分</h1>

    <!-- 顶部 Tab：运行评测 / 评测结果 / 题库管理 -->
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="tab-btn"
        :class="{ active: activeTab === tab.value }"
        @click="activeTab = tab.value"
      >{{ tab.label }}</button>
    </div>

    <!-- ============ Tab 1：运行评测 ============ -->
    <div v-show="activeTab === 'run'" class="tab-panel">
      <div v-if="!hasModels" class="warning-box">
        尚未配置任何模型，请先在 Provider 管理中添加模型后再开始评测。
      </div>

      <!-- 选择模型：按 Provider 分组的多选列表 -->
      <div class="card block">
        <div class="block-head">
          <h2 class="block-title">选择模型</h2>
          <div class="block-actions">
            <span class="muted">已选 {{ selectedRefs.length }} 个</span>
            <button class="btn-ghost btn-sm" @click="selectAllModels">全选</button>
            <button class="btn-ghost btn-sm" @click="clearModels">清空</button>
          </div>
        </div>
        <div v-if="!modelGroupsByProvider.length" class="empty-hint">暂无可用模型</div>
        <div v-for="group in modelGroupsByProvider" :key="group.providerName" class="group">
          <div class="group-title">{{ group.providerLabel }}<span class="muted">（{{ group.models.length }}）</span></div>
          <div class="check-grid">
            <label v-for="m in group.models" :key="m.ref" class="check-item">
              <input type="checkbox" :value="m.ref" v-model="selectedRefs" />
              <span class="check-main">{{ m.label }}</span>
              <span class="check-sub">{{ group.providerLabel }}</span>
            </label>
          </div>
        </div>
      </div>

      <!-- 选择题目：按分类整组勾选 -->
      <div class="card block">
        <div class="block-head">
          <h2 class="block-title">选择题目</h2>
          <div class="block-actions">
            <span class="muted">已选 {{ selectedQuestionIds.length }} 题</span>
            <button class="btn-ghost btn-sm" @click="selectAllCategories">全选</button>
            <button class="btn-ghost btn-sm" @click="clearCategories">清空</button>
          </div>
        </div>
        <div v-if="!categoryGroups.length" class="empty-hint">题库为空，请到「题库管理」添加题目</div>
        <div v-else class="check-grid">
          <label v-for="group in categoryGroups" :key="group.category" class="check-item">
            <input type="checkbox" :value="group.category" v-model="selectedCategories" />
            <span class="check-main">{{ group.category }}</span>
            <span class="check-sub">{{ group.count }} 题</span>
          </label>
        </div>
      </div>

      <!-- 启动配置与进度 -->
      <div class="card block">
        <div class="block-head">
          <h2 class="block-title">开始评测</h2>
        </div>

        <!-- 选中主观题但未指定裁判模型时的醒目提示 -->
        <div v-if="needJudgeWarning" class="warning-box">
          已选题目中包含 {{ llmQuestionCount }} 道主观题（LLM 评分），但未选择裁判模型，这些题目将不计分。
        </div>

        <div class="start-row">
          <label class="field">
            <span class="field-label">裁判模型</span>
            <select v-model="judgeRef" class="judge-select">
              <option value="">不启用（主观题将不计分）</option>
              <optgroup v-for="(g, gi) in modelGroups" :key="gi" :label="g.label">
                <option v-for="opt in g.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </optgroup>
            </select>
          </label>
          <label class="field">
            <span class="field-label">并发数</span>
            <input
              type="number"
              min="1"
              max="10"
              class="num-input"
              v-model.number="concurrency"
              @change="clampConcurrency"
            />
          </label>
          <button class="btn-primary" :disabled="!canStart" @click="startRun">{{ startButtonText }}</button>
        </div>
        <div class="hint">
          预计请求数 {{ estimateRequests }} 次（{{ selectedRefs.length }} 模型 × {{ selectedQuestionIds.length }} 题）
        </div>

        <div v-if="running || progressTotal > 0" class="progress-block">
          <div class="progress-head">
            <span>评测进度</span>
            <span class="muted">{{ progressCompleted }} / {{ progressTotal }}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
          </div>
          <div class="hint">{{ running ? '评测进行中，每 1 秒刷新一次进度…' : '评测已结束' }}</div>
        </div>
      </div>
    </div>

    <!-- ============ Tab 2：评测结果 ============ -->
    <div v-show="activeTab === 'results'" class="tab-panel">
      <div class="card block">
        <div class="toolbar">
          <select v-model="selectedRunId" class="run-select" @change="loadRunDetail">
            <option v-for="run in runs" :key="run.id" :value="run.id">{{ runLabel(run) }}</option>
            <option v-if="!runs.length" value="">暂无评测记录</option>
          </select>
          <button class="btn-ghost btn-sm" @click="loadRuns()">刷新</button>
          <button class="btn-danger btn-sm" :disabled="!selectedRunId" @click="deleteRun">删除本条</button>
          <button class="btn-danger btn-sm" :disabled="!runs.length" @click="clearRuns">清空全部</button>
        </div>
        <div v-if="runDetail" class="run-meta">
          <span class="badge" :class="statusClass(runDetail.status)">{{ statusText(runDetail.status) }}</span>
          <span class="muted">裁判模型：{{ runDetail.judgeRef ? refLabel(runDetail.judgeRef) : '未启用' }}</span>
          <span class="muted">并发数：{{ runDetail.concurrency || '-' }}</span>
          <span class="muted">创建：{{ formatTime(runDetail.createdAt) }}</span>
          <span class="muted">结束：{{ formatTime(runDetail.finishedAt) }}</span>
          <span v-if="runDetail.error" class="run-error">错误：{{ runDetail.error }}</span>
        </div>
      </div>

      <div v-if="!runDetail" class="card block empty-hint">请选择一个评测记录查看结果</div>

      <template v-else>
        <!-- 排行榜 -->
        <div class="section">
          <h2 class="section-title">排行榜</h2>
          <div class="card">
            <table class="data-table">
              <thead>
                <tr>
                  <th>名次</th>
                  <th>模型</th>
                  <th>总分</th>
                  <th>得分率</th>
                  <th>成功·失败</th>
                  <th>平均延迟</th>
                  <th>Token 总计</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in rankedResults" :key="row.ref" :class="{ 'rank-first': index === 0 }">
                  <td>{{ index + 1 }}</td>
                  <td>{{ refLabel(row.ref) }}</td>
                  <td class="font-bold">{{ row.totalScore }} / {{ row.maxScore }}</td>
                  <td>
                    <div class="rate-bar">
                      <div class="rate-fill" :style="{ width: ratePercent(row.rate) + '%' }"></div>
                      <span class="rate-text">{{ ratePercent(row.rate) }}%</span>
                    </div>
                  </td>
                  <td><span class="ok">{{ row.successCount }}</span> · <span class="fail">{{ row.failCount }}</span></td>
                  <td>{{ formatLatency(row.avgLatency) }}</td>
                  <td class="text-purple">{{ formatNumber(row.usageTotal) }}</td>
                </tr>
                <tr v-if="!rankedResults.length">
                  <td colspan="7" class="empty-hint">暂无结果数据</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 分类维度对比 -->
        <div class="section">
          <h2 class="section-title">分类维度对比（得分率）</h2>
          <div class="card">
            <div class="table-scroll">
              <table class="data-table cat-table">
                <thead>
                  <tr>
                    <th class="sticky-col">模型</th>
                    <th v-for="category in categories" :key="category">{{ category }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in rankedResults" :key="row.ref">
                    <td class="sticky-col">{{ refLabel(row.ref) }}</td>
                    <td v-for="category in categories" :key="category">{{ cellRate(row, category) }}</td>
                  </tr>
                  <tr v-if="!rankedResults.length">
                    <td :colspan="categories.length + 1" class="empty-hint">暂无结果数据</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 每题明细 -->
        <div class="section">
          <h2 class="section-title">每题明细</h2>
          <div v-for="row in rankedResults" :key="row.ref" class="card detail-block">
            <div class="detail-head" @click="toggleModel(row.ref)">
              <span class="arrow">{{ expandedModels.includes(row.ref) ? '▼' : '▶' }}</span>
              <span class="detail-title">{{ refLabel(row.ref) }}</span>
              <span class="muted">{{ row.answers.length }} 题 · 得分 {{ row.totalScore }} / {{ row.maxScore }}</span>
            </div>
            <div v-if="expandedModels.includes(row.ref)" class="detail-body">
              <div v-for="answer in (row.answers || [])" :key="answer.questionId" class="answer-item">
                <div class="answer-head">
                  <span class="qid">{{ answer.questionId }}</span>
                  <span class="qtitle">{{ questionTitle(answer.questionId) }}</span>
                  <span class="score">{{ answer.score }} / {{ questionMax(answer.questionId) }}</span>
                  <span class="muted">{{ formatLatency(answer.latency) }}</span>
                </div>
                <details class="prompt-box">
                  <summary>题目原文</summary>
                  <pre class="prompt-text">{{ questionPrompt(answer.questionId) }}</pre>
                </details>
                <div
                  class="answer-output"
                  :class="{ clamped: !expandedOutputs.includes(answerKey(row.ref, answer.questionId)) }"
                  @click="toggleOutput(answerKey(row.ref, answer.questionId))"
                >{{ answer.output || '（无输出）' }}</div>
                <div v-if="answer.error" class="answer-error">错误：{{ answer.error }}</div>
                <div v-if="answer.comment" class="answer-comment">裁判评语：{{ answer.comment }}</div>
              </div>
              <div v-if="!row.answers.length" class="empty-hint">该模型没有回答记录</div>
            </div>
          </div>
          <div v-if="!rankedResults.length" class="card empty-hint">暂无结果数据</div>
        </div>
      </template>
    </div>

    <!-- ============ Tab 3：题库管理 ============ -->
    <div v-show="activeTab === 'questions'" class="tab-panel">
      <div class="card block">
        <div class="toolbar">
          <select v-model="filterCategory" class="filter-select">
            <option value="">全部分类</option>
            <option v-for="group in categoryGroups" :key="group.category" :value="group.category">{{ group.category }}</option>
          </select>
          <input v-model="keyword" class="search-input" placeholder="搜索 ID / 标题 / 分类 / 提示词" />
          <button class="btn-primary btn-sm" @click="openEdit(-1)">+ 新增题目</button>
          <button class="btn-ghost btn-sm" @click="triggerImport">导入 JSON</button>
          <button class="btn-ghost btn-sm" @click="exportQuestions">导出 JSON</button>
          <button class="btn-ghost btn-sm" @click="resetToBuiltin">恢复内置题库</button>
          <input
            ref="fileInput"
            type="file"
            accept=".json,application/json"
            class="hidden-file"
            @change="handleFileChange"
          />
        </div>
      </div>

      <div class="card block">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>分类</th>
              <th>标题</th>
              <th>评分方式</th>
              <th>满分</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in filteredQuestions" :key="item.id + '-' + index">
              <td>{{ item.id }}</td>
              <td>{{ item.category }}</td>
              <td>{{ item.title }}</td>
              <td>{{ scoringModeLabel(item.scoring && item.scoring.mode) }}</td>
              <td>{{ item.scoring ? item.scoring.maxScore : '-' }}</td>
              <td>
                <button class="btn-ghost btn-sm" @click="openEdit(questionIndex(item))">编辑</button>
                <button class="btn-danger btn-sm" @click="removeQuestion(item)">删除</button>
              </td>
            </tr>
            <tr v-if="!filteredQuestions.length">
              <td colspan="6" class="empty-hint">没有匹配的题目</td>
            </tr>
          </tbody>
        </table>
        <div class="hint">共 {{ questions.length }} 道题目，当前显示 {{ filteredQuestions.length }} 道</div>
      </div>
    </div>

    <!-- 题目编辑 / 新增弹窗 -->
    <div v-if="showEditDialog" class="modal-overlay">
      <div class="card modal">
        <div class="modal-header">
          <h2>{{ editingIndex === -1 ? '新增题目' : '编辑题目' }}</h2>
          <button class="modal-close" @click="showEditDialog = false">×</button>
        </div>
        <div class="form">
          <div class="form-row">
            <span class="form-label">ID</span>
            <input v-model="form.id" placeholder="例如 code-01" />
          </div>
          <div class="form-row">
            <span class="form-label">分类</span>
            <input v-model="form.category" placeholder="例如 代码生成" />
          </div>
          <div class="form-row">
            <span class="form-label">标题</span>
            <input v-model="form.title" placeholder="题目简短标题" />
          </div>
          <div class="form-row">
            <span class="form-label">评分方式</span>
            <select v-model="form.mode">
              <option v-for="mode in scoringModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
            </select>
          </div>
          <div class="form-row">
            <span class="form-label">满分</span>
            <input type="number" min="1" v-model.number="form.maxScore" class="num-input" />
          </div>

          <!-- 按评分方式动态展示对应的判分依据字段 -->
          <div v-if="form.mode === 'exact'" class="form-row">
            <span class="form-label">标准答案</span>
            <input v-model="form.answer" placeholder="模型输出需与此完全一致" />
          </div>
          <div v-if="form.mode === 'contains'" class="form-row">
            <span class="form-label">关键词列表</span>
            <textarea v-model="form.keywordsText" rows="5" placeholder="一行一个关键词"></textarea>
          </div>
          <div v-if="form.mode === 'regex'" class="form-row">
            <span class="form-label">正则表达式</span>
            <input v-model="form.pattern" placeholder="例如 \\b56088\\b" />
          </div>
          <div v-if="form.mode === 'regex'" class="form-row">
            <span class="form-label">匹配标志 flags</span>
            <input v-model="form.flags" placeholder="i" />
          </div>
          <div v-if="form.mode === 'json'" class="form-row">
            <span class="form-label">JSON Schema</span>
            <textarea v-model="form.schemaText" rows="5" placeholder='{"name":"string","age":"number"}'></textarea>
          </div>
          <div v-if="form.mode === 'llm'" class="form-row">
            <span class="form-label">评分细则</span>
            <textarea v-model="form.rubric" rows="5" placeholder="裁判模型打分时需要遵循的要点"></textarea>
          </div>

          <div class="form-row">
            <span class="form-label">提示词 prompt</span>
            <textarea v-model="form.prompt" rows="8" placeholder="发送给模型的题目内容"></textarea>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" @click="showEditDialog = false">取消</button>
          <button class="btn-primary" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- 导入方式选择弹窗 -->
    <div v-if="importDialog.visible" class="modal-overlay">
      <div class="card modal modal-sm">
        <div class="modal-header">
          <h2>导入题库</h2>
          <button class="modal-close" @click="importDialog.visible = false">×</button>
        </div>
        <p class="modal-text">文件解析成功，共 {{ importDialog.list.length }} 道题目，请选择导入方式：</p>
        <div class="modal-actions">
          <button class="btn-ghost" @click="doImport('append')">追加到现有题库</button>
          <button class="btn-primary" @click="doImport('replace')">替换现有题库</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  getQuestions, saveQuestions, importQuestions, resetQuestions,
  startBenchmark, getBenchmarkStatus,
  listBenchmarkRuns, getBenchmarkRun, deleteBenchmarkRun, clearBenchmarkRuns
} from '../api.js'
import { useModel } from '../composables/useModel.js'
import { showToast } from '../composables/useToast.js'
import { listModels, buildModelGroups, resolveRefLabel } from '../utils/models.js'
import { formatNumber, formatTime, toLocalDateKey } from '../utils/format.js'

const { providers, loadModelData } = useModel()

// 顶部 Tab 定义
const tabs = [
  { value: 'run', label: '运行评测' },
  { value: 'results', label: '评测结果' },
  { value: 'questions', label: '题库管理' }
]
const activeTab = ref('run') // 当前激活的 Tab

// 评分方式选项，编辑弹窗与列表展示共用
const scoringModes = [
  { value: 'exact', label: '精确匹配（exact）' },
  { value: 'contains', label: '关键词包含（contains）' },
  { value: 'regex', label: '正则匹配（regex）' },
  { value: 'json', label: 'JSON Schema（json）' },
  { value: 'llm', label: 'LLM 裁判（llm）' }
]

// 评测运行状态
const selectedRefs = ref([]) // 已选择的被测模型引用列表
const selectedCategories = ref([]) // 已选择的题目分类列表
const judgeRef = ref('') // 裁判模型引用，空字符串表示不启用
const concurrency = ref(3) // 并发请求数，范围 1-10
const starting = ref(false) // 是否正在提交启动请求
const running = ref(false) // 服务端是否有评测任务在执行
const progressTotal = ref(0) // 进度总数
const progressCompleted = ref(0) // 进度已完成数
let pollTimer = null // 进度轮询定时器

// 题库数据
const questions = ref([]) // 当前题库题目数组

// 历史评测记录
const runs = ref([]) // 历史列表（不含每题回答）
const selectedRunId = ref('') // 当前查看的评测记录 ID
const runDetail = ref(null) // 当前评测记录详情（含每题回答）
const expandedModels = ref([]) // 展开明细的模型引用列表
const expandedOutputs = ref([]) // 展开完整输出的答案键列表

// 题库管理筛选与编辑状态
const filterCategory = ref('') // 列表分类筛选值
const keyword = ref('') // 列表关键词搜索值
const showEditDialog = ref(false) // 是否显示题目编辑弹窗
const editingIndex = ref(-1) // 正在编辑的题目下标，-1 表示新增
const form = ref(createEmptyForm()) // 编辑弹窗的表单数据
const fileInput = ref(null) // 导入文件选择框元素引用
const importDialog = ref({ visible: false, list: [] }) // 导入方式选择弹窗状态

// 评测状态文案映射
const STATUS_TEXT = { running: '进行中', completed: '已完成', failed: '失败', error: '失败', cancelled: '已取消' }

// 按 Provider 分组的模型列表（复选框用），每项含分组展示名
const modelGroupsByProvider = computed(() => {
  const map = new Map()
  for (const item of listModels(providers.value)) {
    if (!map.has(item.providerName)) {
      map.set(item.providerName, { providerName: item.providerName, providerLabel: item.providerLabel, models: [] })
    }
    map.get(item.providerName).models.push({
      ref: item.ref,
      label: item.model.displayName || item.model.id
    })
  }
  return [...map.values()]
})

// 下拉用的模型分组（裁判模型选择框）
const modelGroups = computed(() => buildModelGroups(providers.value))
// 是否已配置至少一个模型
const hasModels = computed(() => modelGroupsByProvider.value.length > 0)

// 按分类聚合的题目分组，含每类题目数与题目 ID
const categoryGroups = computed(() => {
  const map = new Map()
  for (const question of questions.value) {
    const key = question.category || '未分类'
    if (!map.has(key)) map.set(key, { category: key, count: 0, ids: [] })
    const group = map.get(key)
    group.count += 1
    group.ids.push(question.id)
  }
  return [...map.values()]
})

// 已选分类下的全部题目 ID
const selectedQuestionIds = computed(() =>
  questions.value
    .filter(question => selectedCategories.value.includes(question.category || '未分类'))
    .map(question => question.id)
)

// 已选题目中主观题（LLM 评分）的数量
const llmQuestionCount = computed(() =>
  questions.value.filter(
    question =>
      selectedCategories.value.includes(question.category || '未分类') &&
      question.scoring && question.scoring.mode === 'llm'
  ).length
)

// 是否需要提示补充裁判模型
const needJudgeWarning = computed(() => llmQuestionCount.value > 0 && !judgeRef.value)
// 预计请求数 = 模型数 × 题目数
const estimateRequests = computed(() => selectedRefs.value.length * selectedQuestionIds.value.length)
// 满足启动条件：至少一个模型、至少一道题，且当前没有任务在跑
const canStart = computed(
  () => selectedRefs.value.length > 0 && selectedQuestionIds.value.length > 0 && !running.value && !starting.value
)
// 开始按钮文案，随状态变化
const startButtonText = computed(() => {
  if (running.value) return '评测进行中…'
  if (starting.value) return '启动中…'
  return '开始评测'
})
// 进度百分比
const progressPercent = computed(() => {
  if (!progressTotal.value) return 0
  return Math.min(100, Math.round((progressCompleted.value / progressTotal.value) * 100))
})

// 详情结果按总分降序，用于排行榜与各对比表
const rankedResults = computed(() => {
  const list = (runDetail.value && runDetail.value.results) || []
  return [...list].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
})

// 详情中出现过的所有分类，作为分类对比表的列
const categories = computed(() => {
  const set = new Set()
  for (const row of rankedResults.value) {
    for (const key of Object.keys(row.byCategory || {})) set.add(key)
  }
  return [...set]
})

// 题目 ID 到题目的映射，用于明细里回显题目原文
const questionMap = computed(() => {
  const map = new Map()
  for (const question of questions.value) map.set(question.id, question)
  return map
})

// 题库列表按分类与关键词过滤后的结果
const filteredQuestions = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return questions.value.filter(question => {
    if (filterCategory.value && (question.category || '未分类') !== filterCategory.value) return false
    if (!key) return true
    const text = [question.id, question.category, question.title, question.prompt]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return text.includes(key)
  })
})

// 统一的接口错误信息提取
function errorText(err) {
  return err?.response?.data?.error || err?.message || '无法连接服务'
}

// 创建一份空的表单数据
function createEmptyForm() {
  return {
    id: '',
    category: '',
    title: '',
    prompt: '',
    mode: 'contains',
    maxScore: 5,
    answer: '',
    keywordsText: '',
    pattern: '',
    flags: 'i',
    schemaText: '',
    rubric: ''
  }
}

// 模型引用的展示名
function refLabel(modelRef) {
  return resolveRefLabel(providers.value, modelRef)
}

// 得分率（0~1）转保留一位小数的百分比字符串
function ratePercent(rate) {
  return ((Number(rate) || 0) * 100).toFixed(1)
}

// 延迟格式化，超过 1 秒用秒显示
function formatLatency(ms) {
  const value = Number(ms)
  if (!value) return '-'
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.round(value)}ms`
}

// 评测状态文案
function statusText(status) {
  return STATUS_TEXT[status] || status || '未知'
}

// 评测状态徽章的样式类
function statusClass(status) {
  if (status === 'completed') return 'badge-ok'
  if (status === 'running') return 'badge-running'
  if (status === 'failed' || status === 'error') return 'badge-fail'
  return ''
}

// 历史记录下拉的展示文案：ID + 创建时间 + 状态
function runLabel(run) {
  const id = String(run.id || '')
  return `${id.length > 16 ? id.slice(0, 16) + '…' : id} · ${formatTime(run.createdAt)} · ${statusText(run.status)}`
}

// 结果行的 Token 总计，usage 为可选字段
function usageTotal(row) {
  return row.usage ? row.usage.total : 0
}

// 结果行的回答条数，answers 为可选字段
function answerCount(row) {
  return Array.isArray(row.answers) ? row.answers.length : 0
}

// 分类对比表单元格文案
function cellRate(row, category) {
  const item = (row.byCategory || {})[category]
  if (!item) return '-'
  return `${ratePercent(item.rate)}%`
}

// 明细中题目标题
function questionTitle(questionId) {
  const question = questionMap.value.get(questionId)
  return question ? question.title || questionId : questionId
}

// 明细中题目满分
function questionMax(questionId) {
  const question = questionMap.value.get(questionId)
  if (!question || !question.scoring) return '-'
  return question.scoring.maxScore ?? '-'
}

// 明细中题目原文
function questionPrompt(questionId) {
  const question = questionMap.value.get(questionId)
  return question ? question.prompt || '' : ''
}

// 答案在输出展开集合中的唯一键
function answerKey(modelRef, questionId) {
  return `${modelRef}:${questionId}`
}

// 全选所有模型
function selectAllModels() {
  selectedRefs.value = listModels(providers.value).map(item => item.ref)
}

// 清空已选模型
function clearModels() {
  selectedRefs.value = []
}

// 全选所有题目分类
function selectAllCategories() {
  selectedCategories.value = categoryGroups.value.map(group => group.category)
}

// 清空已选题目分类
function clearCategories() {
  selectedCategories.value = []
}

// 并发数输入越界时钳制回 1-10
function clampConcurrency() {
  const value = Math.round(Number(concurrency.value) || 3)
  concurrency.value = Math.min(10, Math.max(1, value))
}

// 加载题库，并在首次或分类失效时补齐默认勾选
async function loadQuestions() {
  try {
    const data = await getQuestions()
    questions.value = Array.isArray(data.questions) ? data.questions : []
    const valid = new Set(categoryGroups.value.map(group => group.category))
    const kept = selectedCategories.value.filter(category => valid.has(category))
    selectedCategories.value = kept.length ? kept : [...valid]
  } catch (err) {
    showToast('题库加载失败: ' + errorText(err), 'error', 4000)
  }
}

// 加载历史评测列表，可指定加载后选中的记录 ID
async function loadRuns(preferredId = '') {
  try {
    runs.value = await listBenchmarkRuns() || []
    const target = preferredId && runs.value.some(run => run.id === preferredId)
      ? preferredId
      : (runs.value[0] ? runs.value[0].id : '')
    selectedRunId.value = target
    if (target) await loadRunDetail()
    else runDetail.value = null
  } catch (err) {
    showToast('历史记录加载失败: ' + errorText(err), 'error', 4000)
  }
}

// 加载当前选中评测记录的详情
async function loadRunDetail() {
  if (!selectedRunId.value) {
    runDetail.value = null
    return
  }
  try {
    runDetail.value = await getBenchmarkRun(selectedRunId.value)
    expandedModels.value = []
    expandedOutputs.value = []
  } catch (err) {
    runDetail.value = null
    showToast('详情加载失败: ' + errorText(err), 'error', 4000)
  }
}

// 删除当前选中的评测记录
async function deleteRun() {
  if (!selectedRunId.value) return
  if (!window.confirm('确定删除这条评测记录吗？该操作不可恢复。')) return
  try {
    await deleteBenchmarkRun(selectedRunId.value)
    showToast('已删除该评测记录')
    selectedRunId.value = ''
    await loadRuns()
  } catch (err) {
    showToast('删除失败: ' + errorText(err), 'error', 4000)
  }
}

// 清空全部评测记录
async function clearRuns() {
  if (!runs.value.length) return
  if (!window.confirm('确定清空全部评测记录吗？该操作不可恢复。')) return
  try {
    await clearBenchmarkRuns()
    showToast('已清空全部评测记录')
    selectedRunId.value = ''
    runDetail.value = null
    await loadRuns()
  } catch (err) {
    showToast('清空失败: ' + errorText(err), 'error', 4000)
  }
}

// 启动评测
async function startRun() {
  if (!canStart.value) return
  starting.value = true
  try {
    const res = await startBenchmark({
      refs: selectedRefs.value,
      questionIds: selectedQuestionIds.value,
      judgeRef: judgeRef.value,
      concurrency: concurrency.value
    })
    progressTotal.value = res.total || estimateRequests.value
    progressCompleted.value = 0
    running.value = true
    showToast(`评测已启动，共 ${progressTotal.value} 项`)
    startPolling()
  } catch (err) {
    showToast('启动失败: ' + errorText(err), 'error', 4000)
  } finally {
    starting.value = false
  }
}

// 启动每秒一次的进度轮询
function startPolling() {
  stopPolling()
  pollTimer = setInterval(pollStatus, 1000)
}

// 停止进度轮询
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 拉取一次进度，任务结束后停止轮询并跳转到结果页
async function pollStatus() {
  try {
    const status = await getBenchmarkStatus()
    progressTotal.value = status.total || progressTotal.value
    progressCompleted.value = status.completed || 0
    if (!status.running) {
      stopPolling()
      running.value = false
      progressCompleted.value = progressTotal.value
      showToast('评测完成')
      activeTab.value = 'results'
      await loadRuns(status.runId)
    }
  } catch {}
}

// 展开或收起某个模型的每题明细
function toggleModel(modelRef) {
  const index = expandedModels.value.indexOf(modelRef)
  if (index === -1) expandedModels.value.push(modelRef)
  else expandedModels.value.splice(index, 1)
}

// 展开或收起某条答案的完整输出
function toggleOutput(key) {
  const index = expandedOutputs.value.indexOf(key)
  if (index === -1) expandedOutputs.value.push(key)
  else expandedOutputs.value.splice(index, 1)
}

// 评分方式值的中文展示
function scoringModeLabel(mode) {
  const hit = scoringModes.find(item => item.value === mode)
  return hit ? hit.label : (mode || '-')
}

// 关键词数组转 textarea 文本
function keywordsToText(list) {
  return Array.isArray(list) ? list.join('\n') : ''
}

// textarea 文本转关键词数组，按行拆分并过滤空行
function textToKeywords(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

// 取题目在题库中的真实下标，供编辑定位
function questionIndex(target) {
  return questions.value.indexOf(target)
}

// 打开编辑弹窗，index 为 -1 时表示新增
function openEdit(index) {
  editingIndex.value = index
  if (index === -1) {
    form.value = createEmptyForm()
    form.value.category = categoryGroups.value.length ? categoryGroups.value[0].category : ''
  } else {
    const question = questions.value[index]
    const scoring = question.scoring || {}
    form.value = {
      id: question.id || '',
      category: question.category || '',
      title: question.title || '',
      prompt: question.prompt || '',
      mode: scoring.mode || 'contains',
      maxScore: Number(scoring.maxScore) || 5,
      answer: scoring.answer || '',
      keywordsText: keywordsToText(scoring.keywords),
      pattern: scoring.pattern || '',
      flags: scoring.flags || 'i',
      schemaText: scoring.schema ? JSON.stringify(scoring.schema, null, 2) : '',
      rubric: scoring.rubric || ''
    }
  }
  showEditDialog.value = true
}

// 保存编辑弹窗：按评分方式组装 scoring，然后整体提交题库
async function saveEdit() {
  const data = form.value
  if (!data.id.trim()) {
    showToast('请填写题目 ID', 'error')
    return
  }
  if (!data.category.trim()) {
    showToast('请填写题目分类', 'error')
    return
  }

  const scoring = { mode: data.mode, maxScore: Number(data.maxScore) || 0 }
  if (data.mode === 'exact') {
    scoring.answer = data.answer
  } else if (data.mode === 'contains') {
    scoring.keywords = textToKeywords(data.keywordsText)
  } else if (data.mode === 'regex') {
    scoring.pattern = data.pattern
    scoring.flags = data.flags || 'i'
  } else if (data.mode === 'json') {
    try {
      scoring.schema = JSON.parse(data.schemaText)
    } catch {
      showToast('Schema 不是合法的 JSON，请修正后再保存', 'error', 4000)
      return
    }
  } else if (data.mode === 'llm') {
    scoring.rubric = data.rubric
  }

  const prev = editingIndex.value >= 0 ? questions.value[editingIndex.value] : null
  const question = {
    id: data.id.trim(),
    category: data.category.trim(),
    title: data.title.trim(),
    prompt: data.prompt,
    scoring
  }
  // maxTokens 不在表单里编辑，编辑已有题目时原样保留
  if (prev && prev.maxTokens) question.maxTokens = prev.maxTokens

  const draft = [...questions.value]
  if (editingIndex.value === -1) draft.push(question)
  else draft.splice(editingIndex.value, 1, question)

  questions.value = draft
  const ok = await persistQuestions('题库已保存')
  if (ok) {
    showEditDialog.value = false
    await loadQuestions()
  }
}

// 删除题目，二次确认后整体提交题库
async function removeQuestion(question) {
  if (!window.confirm(`确定删除题目「${question.title || question.id}」吗？`)) return
  const index = questionIndex(question)
  if (index === -1) return
  const draft = [...questions.value]
  draft.splice(index, 1)
  questions.value = draft
  await persistQuestions('题目已删除')
}

// 把当前题库整体提交到服务端
async function persistQuestions(successMessage) {
  try {
    const res = await saveQuestions(questions.value)
    showToast(successMessage)
    return res && res.ok !== false
  } catch (err) {
    showToast('保存失败: ' + errorText(err), 'error', 4000)
    await loadQuestions()
    return false
  }
}

// 触发文件选择框
function triggerImport() {
  if (fileInput.value) fileInput.value.click()
}

// 读取选中的 JSON 文件，解析成功后弹出导入方式选择
function handleFileChange(event) {
  const file = event.target.files && event.target.files[0]
  event.target.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const list = JSON.parse(String(reader.result))
      if (!Array.isArray(list)) {
        showToast('文件内容必须是题目数组', 'error', 4000)
        return
      }
      importDialog.value = { visible: true, list }
    } catch {
      showToast('文件不是合法的 JSON', 'error', 4000)
    }
  }
  reader.onerror = () => showToast('文件读取失败', 'error')
  reader.readAsText(file)
}

// 按指定方式执行导入
async function doImport(mode) {
  const list = importDialog.value.list
  try {
    const res = await importQuestions(list, mode)
    importDialog.value = { visible: false, list: [] }
    showToast(`已导入 ${res.count ?? list.length} 道题目`)
    await loadQuestions()
  } catch (err) {
    showToast('导入失败: ' + errorText(err), 'error', 4000)
  }
}

// 导出当前题库为 JSON 文件，加 BOM 避免中文乱码
function exportQuestions() {
  const content = '\uFEFF' + JSON.stringify(questions.value, null, 2)
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `airoute-questions-${toLocalDateKey()}.json`
  link.click()
  URL.revokeObjectURL(url)
  showToast('题库已导出')
}

// 恢复内置题库
async function resetToBuiltin() {
  if (!window.confirm('确定恢复为内置题库吗？当前题库将被覆盖。')) return
  try {
    const res = await resetQuestions()
    showToast(`已恢复内置题库，共 ${res.count ?? questions.value.length} 道题目`)
    await loadQuestions()
  } catch (err) {
    showToast('恢复失败: ' + errorText(err), 'error', 4000)
  }
}

onMounted(async () => {
  await loadModelData()
  await loadQuestions()
  await loadRuns()
  // 若进入页面时服务端已有任务在跑，接管进度显示
  try {
    const status = await getBenchmarkStatus()
    if (status.running) {
      running.value = true
      progressTotal.value = status.total || 0
      progressCompleted.value = status.completed || 0
      startPolling()
    }
  } catch {}
})

onUnmounted(stopPolling)
</script>

<style scoped>
.page-title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 20px;
  color: var(--text-1);
}

/* 顶部 Tab */
.tabs {
  display: flex;
  gap: 8px;
  border-bottom: 1px solid var(--border-2);
  margin-bottom: 20px;
}

.tab-btn {
  background: transparent;
  color: var(--text-2);
  padding: 10px 18px;
  border-radius: 10px 10px 0 0;
  font-size: 14px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
}

.tab-btn:hover {
  color: var(--primary);
}

.tab-btn.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  background: #F0F7FF;
}

.tab-panel {
  padding-bottom: 40px;
}

.block {
  margin-bottom: 16px;
}

.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.block-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  color: var(--text-1);
}

.block-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.section {
  margin-bottom: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-1);
}

.muted {
  color: var(--text-3);
  font-size: 12px;
}

.hint {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 10px;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-3);
  padding: 16px 0;
  text-align: center;
}

.warning-box {
  background: #FFF7ED;
  border: 1px solid var(--warning);
  color: #B45309;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  margin-bottom: 14px;
}

/* 复选框分组 */
.group {
  margin-bottom: 14px;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}

.check-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}

.check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-1);
  border-radius: 10px;
  background: var(--bg-hover);
  cursor: pointer;
  min-width: 0;
}

.check-item:hover {
  border-color: var(--primary);
}

.check-main {
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-left: auto;
  white-space: nowrap;
}

/* 启动区 */
.start-row {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  color: var(--text-3);
}

.judge-select {
  width: 280px;
}

.num-input {
  width: 100px;
}

/* 进度条 */
.progress-block {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border-2);
}

.progress-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 8px;
}

.progress-bar {
  height: 10px;
  background: var(--border-2);
  border-radius: 5px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), #4DA6FF);
  transition: width 0.3s ease;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.run-select {
  min-width: 320px;
  flex: 1;
}

.filter-select {
  width: 160px;
}

.search-input {
  width: 240px;
}

.hidden-file {
  display: none;
}

.run-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 12px;
  font-size: 12px;
}

.run-error {
  color: var(--danger);
}

.badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
}

.badge-ok {
  background: #E6F7F0;
  color: var(--success);
}

.badge-running {
  background: #E3F2FD;
  color: var(--primary);
}

.badge-fail {
  background: #FFEBEA;
  color: var(--danger);
}

/* 表格 */
.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  text-align: left;
  padding: 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
  white-space: nowrap;
}

.data-table th {
  color: var(--text-3);
  font-weight: 500;
  background: var(--bg-hover);
}

.data-table tbody tr:hover {
  background: var(--bg-page);
}

.rank-first {
  background: #F0F7FF;
}

.rank-first td {
  font-weight: 600;
}

.rate-bar {
  position: relative;
  height: 22px;
  min-width: 120px;
  background: var(--border-2);
  border-radius: 4px;
  overflow: hidden;
}

.rate-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), #4DA6FF);
  transition: width 0.3s ease;
}

.rate-text {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}

.ok {
  color: var(--success);
}

.fail {
  color: var(--danger);
}

.font-bold {
  font-weight: 600;
}

.text-purple {
  color: var(--purple);
}

/* 分类对比表横向滚动，首列固定 */
.table-scroll {
  overflow-x: auto;
}

.cat-table .sticky-col {
  position: sticky;
  left: 0;
  background: #FFFFFF;
  z-index: 1;
}

.cat-table th.sticky-col {
  background: var(--bg-hover);
}

.cat-table tbody tr:hover .sticky-col {
  background: var(--bg-page);
}

/* 每题明细 */
.detail-block {
  margin-bottom: 12px;
  padding: 0;
  overflow: hidden;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  cursor: pointer;
}

.detail-head:hover {
  background: var(--bg-hover);
}

.arrow {
  color: var(--text-3);
  font-size: 12px;
  width: 12px;
}

.detail-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

.detail-body {
  padding: 0 20px 16px;
  border-top: 1px solid var(--border-2);
}

.answer-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--bg-page);
}

.answer-item:last-child {
  border-bottom: none;
}

.answer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.qid {
  font-size: 12px;
  color: var(--purple);
  font-weight: 600;
}

.qtitle {
  font-size: 13px;
  color: var(--text-1);
}

.score {
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
}

.prompt-box {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.prompt-box summary {
  cursor: pointer;
  color: var(--primary);
}

.prompt-text {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 10px;
  margin-top: 6px;
  font-family: inherit;
  font-size: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.answer-output {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-hover);
  border: 1px solid var(--border-2);
  border-radius: 8px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}

.answer-output.clamped {
  max-height: 120px;
  overflow-y: auto;
}

.answer-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--danger);
}

.answer-comment {
  margin-top: 8px;
  font-size: 12px;
  color: var(--purple);
  background: #F3E5F5;
  border-radius: 8px;
  padding: 8px 10px;
}

/* 弹窗 */
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

.modal-sm {
  width: 420px;
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
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
}

.modal-close:hover {
  color: var(--danger);
}

.modal-text {
  font-size: 14px;
  color: var(--text-1);
  margin-bottom: 20px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.form-label {
  font-size: 12px;
  color: var(--text-3);
}

.form-row textarea {
  resize: vertical;
  font-family: inherit;
  line-height: 1.6;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
