<template>
  <div class="logs">
    <div class="page-header">
      <h1 class="page-title">日志查看</h1>
      <div class="header-actions">
        <span v-if="logSize" class="log-size text-muted">
          日志已占用 {{ formatBytes(logSize.totalSize) }} · {{ logSize.fileCount }} 个文件
        </span>
        <button class="btn-danger btn-sm" @click="clearAllLogs">清空</button>
        <button class="btn-ghost btn-sm" @click="refreshAll">刷新</button>
      </div>
    </div>

    <!-- 筛选栏：模型 / 状态 / 条数，任一变化都会重新加载 -->
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
              <th>使用记录</th>
              <th>模型</th>
              <th>账号</th>
              <th>状态</th>
              <th>耗时</th>
              <th>积分消耗</th>
              <th>首字节延迟</th>
              <th>输入 Token</th>
              <th>输出 Token</th>
              <th>缓存读</th>
              <th>缓存写</th>
              <th>总计</th>
              <th>token/秒</th>
              <th>Fallback</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(log, i) in logs" :key="i">
              <td class="nowrap">{{ formatTime(log.timestamp) }}</td>
              <td class="input-cell" :title="log.input || ''">{{ formatInput(log.input) }}</td>
              <td class="nowrap">{{ log.model }}</td>
              <td class="nowrap token-cell text-muted">{{ accountLabel(log.uid) }}</td>
              <td>
                <span :class="log.status === 200 ? 'text-green' : 'text-red'">
                  {{ log.status }}
                </span>
              </td>
              <td>{{ log.responseTime }}ms</td>
              <td class="token-cell text-orange">{{ formatCredits(log.credits) }}</td>
              <td>{{ log.ttfbMs ? `${log.ttfbMs}ms` : '-' }}</td>
              <td class="token-cell text-blue">{{ formatNumber(log.inputTokens) }}</td>
              <td class="token-cell text-green">{{ formatNumber(log.outputTokens) }}</td>
              <td class="token-cell" :class="log.cacheReadTokens ? 'text-purple' : 'text-muted'">
                {{ formatCacheTokens(log.cacheReadTokens) }}
              </td>
              <td class="token-cell" :class="log.cacheWriteTokens ? 'text-orange' : 'text-muted'">
                {{ formatCacheTokens(log.cacheWriteTokens) }}
              </td>
              <td class="token-cell text-purple font-bold">{{ formatNumber(log.totalTokens) }}</td>
              <td class="token-cell text-muted">{{ log.tokensPerSec || '-' }}</td>
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
import { getLogs, getLogModels, clearLogs, getLogsSize, wbAccounts } from '../api.js'
import { showToast } from '../composables/useToast.js'
import { formatNumber, formatTime, formatBytes } from '../utils/format.js'

const logs = ref([]) // 当前加载出来的日志列表（服务端已按任务合并，一条 = 一个任务）
const logSize = ref(null) // 日志目录占用 { totalSize, fileCount }
const limit = ref(50) // 显示条数
const modelFilter = ref('') // 模型筛选，空表示全部
const statusFilter = ref('') // 状态筛选：'' / success / failed
const modelOptions = ref([]) // 模型下拉选项，来自日志中出现过的模型引用
const accounts = ref([]) // 账号池账号列表，供「账号」列把 uid 映射为昵称

// 是否存在生效中的筛选条件，用于区分两种空状态文案
const hasActiveFilter = computed(() => {
  return !!modelFilter.value || !!statusFilter.value
})

// 缓存 Token 为 0 时显示占位符，非 0 时显示千分位数字
function formatCacheTokens(value) {
  return value ? formatNumber(value) : '-'
}

// 使用记录列：最多显示前 30 字，完整内容通过 title 悬停查看
const INPUT_DISPLAY_MAX = 30
function formatInput(input) {
  if (!input) return '-'
  return input.length > INPUT_DISPLAY_MAX ? `${input.slice(0, INPUT_DISPLAY_MAX)}…` : input
}

// 积分消耗列：保留至多 3 位小数（抑制浮点尾数，如 5.8500000000000005 → 5.85），无消耗显示 -
function formatCredits(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return '-'
  return String(Math.round(n * 1000) / 1000)
}

// 账号列显示名：优先账号池昵称，未命中（账号已删或昵称为空）回退 uid 前 8 位，无 uid 显示 -
function accountLabel(uid) {
  if (!uid) return '-'
  const hit = accounts.value.find(a => a.uid === uid)
  if (hit && hit.nickname) return hit.nickname
  return String(uid).slice(0, 8)
}

// 加载日志；服务端已按任务合并（一次输入 + 其工具循环 = 一条记录）
async function loadLogs() {
  try {
    logs.value = (await getLogs({
      limit: limit.value,
      model: modelFilter.value,
      status: statusFilter.value
    })) || []
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

// 加载日志目录占用（存储体积提示）
async function loadSize() {
  try {
    logSize.value = await getLogsSize()
  } catch {
    /* 占用展示失败不影响日志主流程 */
  }
}

// 加载账号池列表；失败静默降级（账号列自动回退为 uid 前 8 位，不打断日志加载）
async function loadAccounts() {
  try {
    accounts.value = (await wbAccounts()).accounts || []
  } catch {
    /* 账号池不可用时保持空列表，账号列回退 uid 前 8 位 */
  }
}

// 全量刷新：日志 + 模型选项 + 目录占用 + 账号池昵称
async function refreshAll() {
  await Promise.all([loadLogs(), loadModels(), loadSize(), loadAccounts()])
}

// 重置筛选条件，条数属于展示设置不参与重置
function resetFilters() {
  modelFilter.value = ''
  statusFilter.value = ''
}

// 清空全部日志，二次确认后执行
async function clearAllLogs() {
  const confirmed = window.confirm('确定要清空全部日志吗？\n\n此操作不可恢复，所有请求记录将被永久删除。')
  if (!confirmed) return

  try {
    await clearLogs()
    await refreshAll()
    showToast('日志已清空')
  } catch (err) {
    showToast('清空日志失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  }
}

// 模型 / 状态 / 条数变化后立即重新加载
watch([modelFilter, statusFilter, limit], loadLogs)

onMounted(refreshAll)
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

.log-size {
  font-size: 12px;
  margin-right: 4px;
}

.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.filter-select {
  font-size: 13px;
  padding: 8px 12px;
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

.input-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
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
  min-width: 320px;
  word-break: break-word;
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
