<template>
  <div class="usage-overview">
    <div class="summary-cards">
      <div class="card summary-card">
        <div class="summary-label">本月 Token</div>
        <div class="summary-value">{{ formatCnNumber(monthTokens) }}</div>
        <div class="summary-sub">请求 {{ formatNumber(monthRequests) }} 次</div>
      </div>
      <div class="card summary-card">
        <div class="summary-label">本月积分消耗</div>
        <div class="summary-value text-orange">{{ formatCredit(monthCredits) }}</div>
        <div class="summary-sub">按渠道 / 账号逐日累计</div>
      </div>
      <div class="card summary-card">
        <div class="summary-label">缓存命中率</div>
        <div class="summary-value text-green">{{ formatPercent(cacheHitRate) }}</div>
        <div class="summary-sub">命中 ÷（输入 + 命中）</div>
      </div>
      <div class="card summary-card">
        <div class="summary-label">100 积分≈Token</div>
        <div class="summary-value">{{ overallRatio }}</div>
        <div class="summary-sub">按本月全部渠道累计</div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="card">
        <UsageChart
          title="近 30 天 Token 趋势"
          label="今日"
          color="var(--accent)"
          :points="tokenPoints"
          :format-value="formatCnNumber"
        />
      </div>
      <div class="card">
        <UsageChart
          title="近 30 天积分消耗"
          label="今日"
          color="var(--warn-text)"
          :points="creditPoints"
          :format-value="formatCredit"
        />
      </div>
    </div>

    <div class="section chart-section">
      <h2 class="section-title">各渠道每日积分消耗</h2>
      <div class="card">
        <MultiLineChart title="各渠道每日积分消耗" :labels="trendLabels" :series="channelCreditSeries" :format-value="formatCredit" />
      </div>
    </div>

    <div class="section chart-section">
      <h2 class="section-title">各渠道 100 积分≈Token 趋势</h2>
      <div class="card">
        <MultiLineChart title="各渠道 100 积分≈Token" :labels="trendLabels" :series="channelRatioSeries" :format-value="formatNumber" />
      </div>
    </div>

    <div class="section chart-section">
      <h2 class="section-title">各账号每日积分消耗</h2>
      <div class="card">
        <MultiLineChart title="各账号每日积分消耗" :labels="trendLabels" :series="accountCreditSeries" :format-value="formatCredit" />
      </div>
    </div>

    <div class="section chart-section">
      <h2 class="section-title">各账号 100 积分≈Token 趋势</h2>
      <div class="card">
        <MultiLineChart title="各账号 100 积分≈Token" :labels="trendLabels" :series="accountRatioSeries" :format-value="formatNumber" />
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">渠道每日积分数据</h2>
      <div class="card table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>日期</th>
              <th v-for="row in channelRows" :key="row.id">{{ row.name || row.id }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in channelTrendRows" :key="item.date">
              <td>{{ item.label }}</td>
              <td v-for="(value, index) in item.values" :key="index" class="text-orange">{{ formatCredit(value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">账号每日积分数据</h2>
      <div class="card table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>日期</th>
              <th v-for="row in accountRows" :key="row.channel + ':' + row.uid">{{ row.channel }} · {{ row.name || String(row.uid).slice(0, 6) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in accountTrendRows" :key="item.date">
              <td>{{ item.label }}</td>
              <td v-for="(value, index) in item.values" :key="index" class="text-orange">{{ formatCredit(value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">本月各渠道</h2>
      <div class="card">
        <table class="data-table">
          <thead>
            <tr>
              <th>渠道</th>
              <th>本月积分</th>
              <th>本月 Token</th>
              <th>100 积分≈Token</th>
              <th>积分占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in topChannels" :key="row.id">
              <td>{{ row.name || row.id }}</td>
              <td class="text-orange">{{ formatCredit(row.periods.month.creditsUsed) }}</td>
              <td>{{ formatCnNumber(row.periods.month.total) }}</td>
              <td class="text-purple">{{ row.ratio.tokensPer100Credits == null ? '-' : formatNumber(row.ratio.tokensPer100Credits) }}</td>
              <td>{{ creditPercent(row.periods.month.creditsUsed) }}%</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!topChannels.length" class="empty">暂无渠道数据</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getTokenStatsRange, getTokenStatsByPeriod, getTokenScopes } from '../api.js'
import { formatNumber, formatPercent, calcCacheHitRate, formatCnNumber } from '../utils/format.js'
import { usePolling } from '../composables/usePolling.js'
import UsageChart from '../components/UsageChart.vue'
import MultiLineChart from '../components/MultiLineChart.vue'

const range = ref({})
const scopes = ref({ channels: [], accounts: [] })
const detail = ref([])

const monthTokens = computed(() => Number(range.value?.month?.total) || 0)
const monthRequests = computed(() => (Number(range.value?.month?.count) || 0) + (Number(range.value?.month?.failed) || 0))
const cacheHitRate = computed(() => calcCacheHitRate(range.value?.month || {}))
const topChannels = computed(() => {
  const rows = Array.isArray(scopes.value.channels) ? scopes.value.channels.slice() : []
  return rows.sort((a, b) => (b.periods?.month?.creditsUsed || 0) - (a.periods?.month?.creditsUsed || 0)).slice(0, 8)
})
const monthCredits = computed(() => topChannels.value.reduce((sum, row) => sum + (Number(row.periods?.month?.creditsUsed) || 0), 0))
const overallRatio = computed(() => {
  const credits = monthCredits.value
  if (credits <= 0) return '-'
  const tokens = topChannels.value.reduce((sum, row) => sum + (Number(row.periods?.month?.total) || 0), 0)
  return formatNumber(Math.round((tokens / credits) * 100))
})
const tokenPoints = computed(() => detail.value.map(item => ({ label: item.displayDate, value: item.total })))
const creditPoints = computed(() => detail.value.map(item => ({ label: item.displayDate, value: item.creditsUsed || item.credits || 0 })))

const COLORS = ['#7c5cff', '#2f9d78', '#d98b32', '#3b82f6', '#e05252', '#8b5cf6', '#14b8a6', '#64748b']
const channelRows = computed(() => {
  const rows = Array.isArray(scopes.value.channels) ? scopes.value.channels.slice() : []
  return rows.sort((a, b) => (b.periods?.month?.creditsUsed || 0) - (a.periods?.month?.creditsUsed || 0))
})
const accountRows = computed(() => {
  const rows = Array.isArray(scopes.value.accounts) ? scopes.value.accounts.slice() : []
  return rows
    .sort((a, b) => (b.periods?.month?.creditsUsed || 0) - (a.periods?.month?.creditsUsed || 0))
    .slice(0, 8)
})
const trendLabels = computed(() => channelRows.value[0]?.trend?.map(item => item.label) || [])
const channelCreditSeries = computed(() => channelRows.value.map((row, index) => ({
  key: row.id,
  label: row.name || row.id,
  color: COLORS[index % COLORS.length],
  values: (row.trend || []).map(item => item.credits),
})))
const channelRatioSeries = computed(() => channelRows.value.map((row, index) => ({
  key: row.id,
  label: row.name || row.id,
  color: COLORS[index % COLORS.length],
  values: (row.trend || []).map(item => item.tokenPer100Credits == null ? 0 : item.tokenPer100Credits),
})))
const accountCreditSeries = computed(() => accountRows.value.map((row, index) => ({
  key: `${row.channel}:${row.uid}`,
  label: `${row.channel} · ${row.name || String(row.uid).slice(0, 6)}`,
  color: COLORS[index % COLORS.length],
  values: (row.trend || []).map(item => item.credits),
})))
const accountRatioSeries = computed(() => accountRows.value.map((row, index) => ({
  key: `${row.channel}:${row.uid}`,
  label: `${row.channel} · ${row.name || String(row.uid).slice(0, 6)}`,
  color: COLORS[index % COLORS.length],
  values: (row.trend || []).map(item => item.tokenPer100Credits == null ? 0 : item.tokenPer100Credits),
})))
const channelTrendRows = computed(() => {
  const dates = channelRows.value[0]?.trend || []
  return dates.map((dateItem, dateIndex) => ({
    date: dateItem.date,
    label: dateItem.label,
    values: channelRows.value.map(row => row.trend?.[dateIndex]?.credits || 0),
  }))
})
const accountTrendRows = computed(() => {
  const dates = accountRows.value[0]?.trend || []
  return dates.map((dateItem, dateIndex) => ({
    date: dateItem.date,
    label: dateItem.label,
    values: accountRows.value.map(row => row.trend?.[dateIndex]?.credits || 0),
  }))
})

function formatCredit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return Number.isInteger(number) ? String(number) : number.toFixed(2)
}

function creditPercent(value) {
  if (monthCredits.value <= 0) return 0
  return Math.round(((Number(value) || 0) / monthCredits.value) * 100)
}

async function load() {
  try {
    const [rangeData, scopeData, period] = await Promise.all([
      getTokenStatsRange(),
      getTokenStatsScopes(),
      getTokenStatsByPeriod(30),
    ])
    range.value = rangeData || {}
    scopes.value = {
      channels: Array.isArray(scopeData?.channels) ? scopeData.channels : [],
      accounts: Array.isArray(scopeData?.accounts) ? scopeData.accounts : [],
    }
    detail.value = Array.isArray(period?.details) ? period.details : []
  } catch {
    /* 概览是只读展示，失败保留上一帧 */
  }
}

onMounted(load)
usePolling(load, 5000)
</script>

<style scoped>
.summary-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}
.summary-card {
  padding: 18px 20px;
}
.summary-label {
  font-size: var(--fs-xs);
  color: var(--text-2);
  margin-bottom: 8px;
}
.summary-value {
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.summary-sub {
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
}
.table-scroll {
  overflow-x: auto;
}
.data-table {
  min-width: 680px;
}
.data-table th,
.data-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-1);
  font-size: var(--fs-sm);
}
.data-table th {
  color: var(--text-2);
  font-weight: 500;
}
@media (max-width: 1100px) {
  .summary-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chart-grid { grid-template-columns: 1fr; }
}
</style>

