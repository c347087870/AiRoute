<template>
  <div class="dashboard">
    <h1 class="page-title">状态面板</h1>

    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-label">当前模型</div>
        <div class="stat-value primary">{{ currentModelLabel }}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Router 状态</div>
        <div class="stat-value" :class="isOnline ? 'green' : 'red'">
          {{ isOnline ? '运行中' : '离线' }}
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">请求数</div>
        <div class="stat-value">{{ formatNumber(stats.todayRequests) }} / {{ formatNumber(stats.totalRequests) }}</div>
        <div class="stat-subtitle">今日 / {{ retentionLabel }}</div>
        <div
          class="stat-failed"
          :title="`今日失败 ${stats.todayFailed} 次，${retentionLabel}失败 ${stats.totalFailed} 次（与 Token 统计同源）`"
        >
          失败 {{ formatNumber(stats.todayFailed) }} / {{ formatNumber(stats.totalFailed) }}
        </div>
      </div>
    </div>

    <!-- Token 统计面板 -->
    <div class="section">
      <div class="section-header">
        <h2 class="section-title">Token 使用统计</h2>
        <button class="btn-ghost btn-sm" @click="refreshTokenStats" :disabled="tokenStatsRefreshing">
          {{ tokenStatsRefreshing ? '刷新中...' : '刷新' }}
        </button>
      </div>
      <div class="token-stats-grid">
        <div class="card token-stat-card">
          <div class="token-stat-header">
            <span class="token-stat-title">今日用量</span>
            <span class="token-badge today">今天</span>
          </div>
          <div class="token-stat-values">
            <div class="token-stat-item" v-for="item in todayUsage" :key="item.key">
              <div class="token-stat-label">{{ item.label }}</div>
              <div class="token-stat-number" :class="item.color">{{ formatNumber(item.value) }}</div>
            </div>
          </div>
        </div>

        <div class="card token-stat-card">
          <div class="token-stat-header">
            <span class="token-stat-title">本月用量</span>
            <span class="token-badge month">本月</span>
          </div>
          <div class="token-stat-values">
            <div class="token-stat-item" v-for="item in monthUsage" :key="item.key">
              <div class="token-stat-label">{{ item.label }}</div>
              <div class="token-stat-number" :class="item.color">{{ formatNumber(item.value) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 按模型统计 -->
      <div class="card table-card" v-if="Object.keys(tokenStatsByModel).length > 0">
        <h3 class="subsection-title">
          各模型用量
          <span class="subsection-hint" title="输入 Token 为未命中缓存的部分；缓存读/写单独计数，不与输入重复计算；总计 = 输入 + 缓存读 + 缓存写 + 输出">口径说明</span>
        </h3>
        <table class="model-token-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求次数</th>
              <th title="未命中缓存的输入 Token">输入 Token</th>
              <th title="从缓存读取的输入 Token">缓存读</th>
              <th title="写入缓存的输入 Token">缓存写</th>
              <th>输出 Token</th>
              <th title="输入 + 缓存读 + 缓存写 + 输出">总计</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(stat, model) in tokenStatsByModel" :key="model">
              <td>{{ model }}</td>
              <td>{{ formatNumber(stat.count) }}</td>
              <td class="text-blue">{{ formatNumber(stat.input) }}</td>
              <td class="text-purple">{{ formatNumber(stat.cacheRead) }}</td>
              <td class="text-orange">{{ formatNumber(stat.cacheWrite) }}</td>
              <td class="text-green">{{ formatNumber(stat.output) }}</td>
              <td class="font-bold">{{ formatNumber(stat.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">快速切换</h2>
      <div class="switch-groups">
        <div class="switch-group" v-for="group in quickSwitchGroups" :key="group.label">
          <div class="group-label">{{ group.label }}</div>
          <div class="model-chips">
            <button
              v-for="item in group.models"
              :key="item.ref"
              class="chip"
              :class="{ active: currentModel === item.ref }"
              :title="item.ref"
              @click="handleSwitch(item.ref)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
        <div class="switch-group">
          <div class="group-label">智能路由</div>
          <div class="model-chips">
            <button
              class="chip"
              :class="{ active: currentModel === AUTO_MODEL }"
              :title="AUTO_MODEL"
              @click="handleSwitch(AUTO_MODEL)"
            >
              Auto
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2 class="section-title">最近请求</h2>
        <button class="btn-ghost btn-sm" @click="refreshLogs" :disabled="logsRefreshing">
          {{ logsRefreshing ? '刷新中...' : '刷新' }}
        </button>
      </div>
      <div class="card table-card">
        <table class="log-table" v-if="recentLogs.length">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>输入</th>
              <th>缓存</th>
              <th>输出</th>
              <th>总计</th>
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
              <td>{{ formatNumber(log.inputTokens) }}</td>
              <td :class="{ 'text-purple': log.cacheReadTokens > 0 }">
                {{ log.cacheReadTokens ? formatNumber(log.cacheReadTokens) : '-' }}
              </td>
              <td>{{ formatNumber(log.outputTokens) }}</td>
              <td>{{ formatNumber(log.totalTokens) }}</td>
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
import { showToast } from '../composables/useToast.js'
import { getLogs, getStats, getHealth, getTokenStatsToday, getTokenStatsMonth, getTokenStats } from '../api.js'
import { listModels, AUTO_MODEL } from '../utils/models.js'
import { formatNumber, formatTime } from '../utils/format.js'

const { currentModel, providers, currentModelLabel, loadModelData, switchModel } = useModel()

const recentLogs = ref([]) // 最近 5 条请求日志
const isOnline = ref(false) // Router 是否在线，只由健康检查决定
const stats = ref({ todayRequests: 0, todayFailed: 0, totalRequests: 0, totalFailed: 0, retentionDays: 0 }) // 请求数统计
const logsRefreshing = ref(false) // 日志刷新中的 loading 状态

// Token 统计数据
const tokenStatsToday = ref(emptyTokenStats())
const tokenStatsMonth = ref(emptyTokenStats())
const tokenStatsByModel = ref({})
const tokenStatsRefreshing = ref(false) // Token 统计刷新状态

// 空的 Token 统计对象，用于初始化和接口失败兜底
function emptyTokenStats() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, count: 0, failed: 0 }
}

// 累计请求数的统计口径，避免与"今日"数字混淆
const retentionLabel = computed(() => {
  return stats.value.retentionDays ? `近 ${stats.value.retentionDays} 天` : '累计'
})

// 按 Provider 分组的模型列表，用于快速切换的 chip 分组
const quickSwitchGroups = computed(() => {
  const groups = []
  for (const item of listModels(providers.value)) {
    let group = groups.find(g => g.label === item.providerLabel)
    if (!group) {
      group = { label: item.providerLabel, models: [] }
      groups.push(group)
    }
    group.models.push({ ref: item.ref, label: item.model.displayName || item.model.id })
  }
  return groups
})

// 用量卡片统一拆成 输入/缓存读/缓存写/输出/总计 五格
function buildUsageItems(tokenStats) {
  return [
    { key: 'input', label: '输入', value: tokenStats.input, color: 'blue' },
    { key: 'cacheRead', label: '缓存读', value: tokenStats.cacheRead, color: 'purple' },
    { key: 'cacheWrite', label: '缓存写', value: tokenStats.cacheWrite, color: 'orange' },
    { key: 'output', label: '输出', value: tokenStats.output, color: 'green' },
    { key: 'total', label: '总计', value: tokenStats.total, color: 'total' }
  ]
}

// 今日用量的五格数据
const todayUsage = computed(() => buildUsageItems(tokenStatsToday.value))

// 本月用量的五格数据
const monthUsage = computed(() => buildUsageItems(tokenStatsMonth.value))

// 加载 Router 健康状态，只有这个接口的成败影响在线状态
async function loadHealth() {
  try {
    await getHealth()
    isOnline.value = true
  } catch {
    isOnline.value = false
  }
}

// 加载请求数统计，失败时保留上一次的数据
async function loadStats() {
  try {
    const data = await getStats()
    if (data) stats.value = data
  } catch (err) {
    console.error('加载请求统计失败:', err)
  }
}

// 加载最近 5 条请求日志
async function loadLogs() {
  try {
    recentLogs.value = (await getLogs({ limit: 5 })) || []
  } catch (err) {
    console.error('加载最近请求失败:', err)
  }
}

// 加载 Token 统计（今日、本月、各模型）
async function loadTokenStats() {
  try {
    const [today, month, all] = await Promise.all([
      getTokenStatsToday(),
      getTokenStatsMonth(),
      getTokenStats()
    ])
    tokenStatsToday.value = today || emptyTokenStats()
    tokenStatsMonth.value = month || emptyTokenStats()
    tokenStatsByModel.value = (all && all.byModel) || {}
  } catch (err) {
    console.error('加载 Token 统计失败:', err)
  }
}

// 手动刷新最近日志
async function refreshLogs() {
  logsRefreshing.value = true
  await loadLogs()
  logsRefreshing.value = false
}

// 手动刷新 Token 统计数据
async function refreshTokenStats() {
  tokenStatsRefreshing.value = true
  await loadTokenStats()
  tokenStatsRefreshing.value = false
}

// 加载所有 Dashboard 数据，各接口独立失败互不影响
async function loadData() {
  await Promise.all([loadHealth(), loadStats(), loadLogs(), loadTokenStats()])
}

// 切换当前模型，失败时给出错误提示
async function handleSwitch(ref) {
  const ok = await switchModel(ref)
  if (!ok) showToast('切换失败，请检查服务状态后重试', 'error')
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
  color: var(--text-1);
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
  color: var(--text-3);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-1);
}

.stat-value.primary {
  color: var(--primary);
}

.stat-value.green {
  color: var(--success);
}

.stat-value.red {
  color: var(--danger);
}

/* 请求数卡片的统计口径说明 */
.stat-subtitle {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 6px;
}

/* 失败数提示，鼠标悬停显示完整口径说明 */
.stat-failed {
  font-size: 11px;
  color: #B0B0B0;
  margin-top: 4px;
  cursor: help;
}

.section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-1);
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

/* 快速切换：按 Provider 分组，每组前带分组标题 */
.switch-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 6px;
}

.model-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip {
  background: var(--bg-page);
  border: 1px solid var(--border-3);
  color: var(--text-2);
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.chip.active {
  background: var(--primary-bg);
  border-color: var(--primary);
  color: var(--primary);
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
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
}

.log-table th {
  color: var(--text-3);
  font-weight: 500;
}

.text-green {
  color: var(--success);
}

.text-red {
  color: var(--danger);
}

.empty {
  text-align: center;
  color: var(--text-3);
  padding: 24px;
  font-size: 14px;
}

/* Token 统计样式 */
.token-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

.token-stat-card {
  padding: 20px;
}

.token-stat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.token-stat-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

.token-badge {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
}

.token-badge.today {
  background: #E3F2FD;
  color: #1976D2;
}

.token-badge.month {
  background: #F3E5F5;
  color: #7B1FA2;
}

.token-stat-values {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}

.token-stat-item {
  text-align: center;
  min-width: 0;
}

.token-stat-label {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.token-stat-number {
  font-size: 18px;
  font-weight: 700;
}

.token-stat-number.blue {
  color: var(--primary);
}

.token-stat-number.green {
  color: var(--success);
}

.token-stat-number.purple {
  color: var(--purple);
}

.token-stat-number.orange {
  color: var(--warning);
}

.token-stat-number.total {
  color: var(--text-1);
}

.subsection-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-1);
}

/* 统计口径说明入口，悬停查看完整口径 */
.subsection-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
  border: 1px solid var(--border-3);
  border-radius: 10px;
  padding: 1px 8px;
  margin-left: 8px;
  cursor: help;
  vertical-align: 1px;
}

.model-token-table {
  width: 100%;
  border-collapse: collapse;
}

.model-token-table th,
.model-token-table td {
  text-align: left;
  padding: 10px 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
}

.model-token-table th {
  color: var(--text-3);
  font-weight: 500;
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

/* 表格列较多，窄屏时允许卡片内横向滚动 */
.table-card {
  overflow-x: auto;
}

/* 窄屏下用量卡片改为三列，避免数字挤在一起 */
@media (max-width: 1200px) {
  .token-stat-values {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
