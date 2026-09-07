<template>
  <div class="logs">
    <div class="page-header">
      <h1 class="page-title">日志查看</h1>
      <div class="header-actions">
        <button class="btn-ghost btn-sm" @click="exportCsv">导出 CSV</button>
        <button class="btn-danger btn-sm" @click="clearAllLogs">清空</button>
        <button class="btn-ghost btn-sm" @click="loadLogs">刷新</button>
      </div>
    </div>

    <!-- 筛选栏：模型 / 状态 / 关键词 / 条数，任一变化都会重新加载 -->
    <div class="filter-bar">
      <select v-model="modelFilter" class="filter-select" title="按模型筛选">
        <option value="">全部模型</option>
        <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
      </select>

      <select v-model="statusFilter" class="filter-select" title="按状态筛选">
        <option value="">全部状态</option>
        <option value="success">成功</option>
        <option value="failed">失败</option>
      </select>

      <input
        v-model="keyword"
        class="filter-input"
        type="text"
        placeholder="搜索模型 / 错误信息 / 来源模型"
      />

      <select v-model="limit" class="filter-select" title="显示条数">
        <option :value="20">最近 20 条</option>
        <option :value="50">最近 50 条</option>
        <option :value="100">最近 100 条</option>
        <option :value="200">最近 200 条</option>
      </select>

      <button class="btn-ghost btn-sm" @click="resetFilters">重置</button>
    </div>

    <div class="card">
      <div class="table-wrap" v-if="logs.length">
        <table class="log-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>输入 Token</th>
              <th>输出 Token</th>
              <th>缓存读</th>
              <th>缓存写</th>
              <th>总计</th>
              <th>Fallback</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(log, i) in logs" :key="i">
              <td class="nowrap">{{ formatTime(log.timestamp) }}</td>
              <td class="nowrap">{{ log.model }}</td>
              <td>
                <span :class="log.status === 200 ? 'text-green' : 'text-red'">
                  {{ log.status }}
                </span>
              </td>
              <td>{{ log.responseTime }}ms</td>
              <td class="token-cell text-blue">{{ formatNumber(log.inputTokens) }}</td>
              <td class="token-cell text-green">{{ formatNumber(log.outputTokens) }}</td>
              <td class="token-cell" :class="log.cacheReadTokens ? 'text-purple' : 'text-muted'">
                {{ formatCacheTokens(log.cacheReadTokens) }}
              </td>
              <td class="token-cell" :class="log.cacheWriteTokens ? 'text-orange' : 'text-muted'">
                {{ formatCacheTokens(log.cacheWriteTokens) }}
              </td>
              <td class="token-cell text-purple font-bold">{{ formatNumber(log.totalTokens) }}</td>
              <td>
                <span v-if="log.fallback" class="text-yellow">
                  {{ log.fallbackFrom }} → {{ log.model }}
                </span>
                <span v-else>-</span>
              </td>
              <td class="error-cell">{{ log.error || '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">
        {{ hasActiveFilter ? '没有符合当前筛选条件的日志，可调整条件或点击「重置」' : '暂无日志记录' }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getLogs, getLogModels, clearLogs } from '../api.js'
import { showToast } from '../composables/useToast.js'
import { formatNumber, formatTime, toLocalDateKey } from '../utils/format.js'

const logs = ref([]) // 当前加载出来的日志列表（导出即导出这份数据）
const limit = ref(50) // 显示条数
const modelFilter = ref('') // 模型筛选，空表示全部
const statusFilter = ref('') // 状态筛选：'' / success / failed
const keyword = ref('') // 关键词，服务端在 model、error、fallbackFrom 中匹配
const modelOptions = ref([]) // 模型下拉选项，来自日志中出现过的模型引用

// 是否存在生效中的筛选条件，用于区分两种空状态文案
const hasActiveFilter = computed(() => {
  return !!modelFilter.value || !!statusFilter.value || !!keyword.value.trim()
})

// 缓存 Token 为 0 时显示占位符，非 0 时显示千分位数字
function formatCacheTokens(value) {
  return value ? formatNumber(value) : '-'
}

// 加载日志，服务端负责按筛选条件过滤
async function loadLogs() {
  try {
    logs.value = await getLogs({
      limit: limit.value,
      model: modelFilter.value,
      status: statusFilter.value,
      keyword: keyword.value.trim()
    })
  } catch (err) {
    showToast('日志加载失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  }
}

// 加载模型下拉选项
async function loadModels() {
  try {
    modelOptions.value = await getLogModels()
  } catch (err) {
    showToast('模型列表加载失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  }
}

// 重置筛选条件，条数属于展示设置不参与重置
function resetFilters() {
  modelFilter.value = ''
  statusFilter.value = ''
  keyword.value = ''
}

// CSV 单元格转义：含逗号、双引号或换行时用双引号包裹，内部双引号写成两个
function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

// 把当前筛选结果导出为 CSV，开头加 UTF-8 BOM 避免 Excel 中文乱码
function exportCsv() {
  if (!logs.value.length) {
    showToast('当前没有可导出的日志', 'info')
    return
  }

  const header = ['时间', '模型', '状态', '耗时ms', '输入Token', '输出Token', '缓存读', '缓存写', '总计', 'Fallback', '错误']
  const rows = logs.value.map(log => [
    formatTime(log.timestamp),
    log.model,
    log.status,
    log.responseTime,
    log.inputTokens || 0,
    log.outputTokens || 0,
    log.cacheReadTokens || 0,
    log.cacheWriteTokens || 0,
    log.totalTokens || 0,
    log.fallback ? `${log.fallbackFrom || ''} → ${log.model || ''}` : '',
    log.error || ''
  ])

  const csv = [header, ...rows].map(row => row.map(escapeCsvCell).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `airoute-logs-${toLocalDateKey()}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)

  showToast(`已导出 ${logs.value.length} 条日志`)
}

// 清空全部日志，二次确认后执行
async function clearAllLogs() {
  const confirmed = window.confirm('确定要清空全部日志吗？\n\n此操作不可恢复，所有请求记录将被永久删除。')
  if (!confirmed) return

  try {
    await clearLogs()
    await loadLogs()
    await loadModels()
    showToast('日志已清空')
  } catch (err) {
    showToast('清空日志失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  }
}

// 模型 / 状态 / 条数变化后立即重新加载
watch([modelFilter, statusFilter, limit], loadLogs)

// 关键词输入防抖 300ms，避免每敲一个字就发一次请求
let keywordTimer = null
watch(keyword, () => {
  clearTimeout(keywordTimer)
  keywordTimer = setTimeout(loadLogs, 300)
})

onMounted(() => {
  loadLogs()
  loadModels()
})
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.filter-select,
.filter-input {
  font-size: 13px;
  padding: 8px 12px;
}

.filter-input {
  flex: 1;
  min-width: 200px;
}

.table-wrap {
  overflow-x: auto;
}

.log-table {
  width: 100%;
  border-collapse: collapse;
}

.log-table th,
.log-table td {
  text-align: left;
  padding: 10px 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
}

.log-table th {
  color: var(--text-3);
  font-weight: 500;
  position: sticky;
  top: 0;
  background: #FFFFFF;
  white-space: nowrap;
}

.nowrap {
  white-space: nowrap;
}

.text-green {
  color: var(--success);
}

.text-red {
  color: var(--danger);
}

.text-yellow {
  color: var(--warning);
  font-size: 12px;
}

.text-muted {
  color: var(--text-4);
}

.error-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  text-align: center;
  color: var(--text-3);
  padding: 40px;
  font-size: 14px;
}

.token-cell {
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.text-blue {
  color: var(--primary);
}

.text-green {
  color: var(--success);
}

.text-purple {
  color: var(--purple);
}

.text-orange {
  color: var(--warning);
}

.font-bold {
  font-weight: 600;
}
</style>
