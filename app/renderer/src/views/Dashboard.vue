<template>
  <div class="dashboard">
    <h1 class="page-title">状态面板</h1>

    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-label">当前模型</div>
        <div class="stat-value primary">{{ currentDisplay }}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Router 状态</div>
        <div class="stat-value" :class="isOnline ? 'green' : 'red'">
          {{ isOnline ? '运行中' : '离线' }}
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">请求数 (今日/总计)</div>
        <div class="stat-value">{{ stats.todayRequests }} / {{ stats.totalRequests }}</div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">快速切换</h2>
      <div class="model-chips">
        <button
          v-for="(provider, name) in providers"
          :key="name"
          class="chip"
          :class="{ active: currentModel === name }"
          @click="switchModel(name)"
        >
          {{ provider.displayName || name }}
        </button>
        <button
          class="chip"
          :class="{ active: currentModel === 'auto' }"
          @click="switchModel('auto')"
        >
          Auto
        </button>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2 class="section-title">最近请求</h2>
        <button class="btn-ghost btn-sm" @click="refreshLogs" :disabled="logsRefreshing">
          {{ logsRefreshing ? '刷新中...' : '刷新' }}
        </button>
      </div>
      <div class="card">
        <table class="log-table" v-if="recentLogs.length">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>Fallback</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(log, i) in recentLogs" :key="i">
              <td>{{ formatTime(log.timestamp) }}</td>
              <td>{{ log.model }}</td>
              <td>
                <span :class="log.status === 200 ? 'text-green' : 'text-red'">
                  {{ log.status }}
                </span>
              </td>
              <td>{{ log.responseTime }}ms</td>
              <td>{{ log.fallback ? '是' : '-' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无请求记录</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useModel } from '../composables/useModel.js'
import { getLogs, getStats, getHealth } from '../api.js'

const { currentModel, providers, loadModelData, switchModel } = useModel()

const recentLogs = ref([]) // 最近 5 条请求日志
const isOnline = ref(false) // Router 是否在线
const stats = ref({ todayRequests: 0, totalRequests: 0 }) // 请求数统计
const logsRefreshing = ref(false) // 日志刷新中的 loading 状态

// 计算当前模型显示名称
const currentDisplay = computed(() => {
  if (currentModel.value === 'auto') return 'Auto (智能路由)'
  const p = providers.value[currentModel.value]
  return p ? p.displayName || currentModel.value : currentModel.value
})

// 格式化请求时间为 MM-DD HH:MM:SS
function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}:${ss}`
}

// 手动刷新最近日志
async function refreshLogs() {
  logsRefreshing.value = true
  try {
    recentLogs.value = await getLogs(5)
  } catch {}
  logsRefreshing.value = false
}

// 加载所有 Dashboard 数据
async function loadData() {
  try {
    const [logs, statsData, health] = await Promise.all([
      getLogs(5), getStats(), getHealth()
    ])
    recentLogs.value = logs
    isOnline.value = true
    stats.value = statsData
  } catch {
    isOnline.value = false
  }
}

onMounted(async () => {
  await loadModelData()
  loadData()
})
</script>

<style scoped>
.page-title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 24px;
  color: #1A1A1A;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 28px;
}

.stat-card {
  text-align: center;
}

.stat-label {
  font-size: 12px;
  color: #999999;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: #1A1A1A;
}

.stat-value.primary {
  color: #0082FC;
}

.stat-value.green {
  color: #00B578;
}

.stat-value.red {
  color: #FF3B30;
}

.section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #1A1A1A;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-header .section-title {
  margin-bottom: 0;
}

.model-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip {
  background: #F5F5F5;
  border: 1px solid #E0E0E0;
  color: #666666;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.chip:hover {
  border-color: #0082FC;
  color: #0082FC;
}

.chip.active {
  background: #0082FC14;
  border-color: #0082FC;
  color: #0082FC;
}

.log-table {
  width: 100%;
  border-collapse: collapse;
}

.log-table th,
.log-table td {
  text-align: left;
  padding: 8px 12px;
  font-size: 13px;
  border-bottom: 1px solid #F0F0F0;
  color: #1A1A1A;
}

.log-table th {
  color: #999999;
  font-weight: 500;
}

.text-green {
  color: #00B578;
}

.text-red {
  color: #FF3B30;
}

.empty {
  text-align: center;
  color: #999999;
  padding: 24px;
  font-size: 14px;
}
</style>
