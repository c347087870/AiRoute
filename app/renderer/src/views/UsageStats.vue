<template>
  <div class="usage-stats">
    <div class="card stats-filter">
      <div class="filter-row">
        <SegmentedTabs v-model="days" :options="dayOptions" label="统计时间范围" />
        <span class="filter-sep"></span>
        <select v-model="channel" class="filter-select" title="按渠道筛选">
          <option value="">全部渠道</option>
          <option v-for="item in channelOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <select v-model="account" class="filter-select" :disabled="!channel" :title="channel ? '按账号筛选' : '先选渠道'">
          <option value="">全部账号</option>
          <option v-for="item in accountOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <select v-model="model" class="filter-select" :disabled="!account" :title="account ? '按模型筛选' : '先选账号'">
          <option value="">全部模型</option>
          <option v-for="item in modelOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
        <AppButton class="filter-clear" variant="danger" :disabled="clearing" @click="clearStats">清空</AppButton>
      </div>
      <div class="filter-hint">{{ groupHint }}</div>
    </div>

    <div class="summary-cards">
      <div class="card summary-card">
        <div class="summary-label">近 {{ days }} 天 Token</div>
        <div class="summary-value">{{ formatCnNumber(summary.tokens) }}</div>
        <div class="summary-sub">请求 {{ formatNumber(summary.count) }} 次</div>
      </div>
      <div class="card summary-card">
        <div class="summary-label">近 {{ days }} 天积分</div>
        <div class="summary-value text-orange">{{ formatCredit(summary.credits) }}</div>
        <div class="summary-sub">按渠道 · 账号逐次累加</div>
      </div>
      <div class="card summary-card">
        <div class="summary-label">缓存命中率</div>
        <div class="summary-value text-green">{{ formatPercent(summary.cacheHitRate) }}</div>
        <div class="summary-sub">缓存读 ÷（输入 + 缓存读）</div>
      </div>
      <div class="card summary-card">
        <div class="summary-label">100 积分 ≈ Token</div>
        <div class="summary-value text-purple">{{ summary.ratio }}</div>
        <div class="summary-sub">累计 Token ÷ 累计积分 × 100</div>
      </div>
    </div>

    <div class="chart-grid">
      <div class="card">
        <TrendChart
          :title="`${groupLabel}每日 Token`"
          :summary="`合计 ${formatCnNumber(summary.tokens)}`"
          :labels="dateLabels"
          :series="tokenSeries"
          :format-value="formatCnNumber"
          :format-axis="formatCnNumber"
        />
      </div>
      <div class="card">
        <TrendChart
          :title="`${groupLabel}每日缓存命中率`"
          :summary="`加权 ${formatPercent(summary.cacheHitRate)}`"
          :labels="dateLabels"
          :series="cacheSeries"
          :format-value="formatPercent"
          :format-axis="value => `${value.toFixed(0)}%`"
        />
      </div>
      <div class="card">
        <TrendChart
          :title="`${groupLabel}每日积分消耗`"
          :summary="`合计 ${formatCredit(summary.credits)}`"
          :labels="dateLabels"
          :series="creditSeries"
          :format-value="formatCredit"
          :format-axis="formatCredit"
        />
      </div>
      <div class="card">
        <TrendChart
          :title="`${groupLabel}每 100 积分 ≈ Token`"
          :summary="`综合 ${summary.ratio}`"
          :labels="dateLabels"
          :series="ratioSeries"
          :format-value="formatRatio"
          :format-axis="formatCnNumber"
        />
      </div>
    </div>

    <div v-if="groups.length > shownGroups.length" class="chart-note">
      共 {{ groups.length }} 条序列，图中只画 Token 最多的 {{ shownGroups.length }} 条；下方表格是全部
    </div>

    <div class="section">
      <h2 class="section-title">
        明细（近 {{ days }} 天合计）
        <span class="title-meta">{{ tableRows.length }} 组 渠道 · 账号 · 模型</span>
      </h2>
      <div class="card">
        <div v-if="tableRows.length" class="table-wrap">
          <table class="table data-table">
            <thead>
              <tr>
                <th>渠道</th>
                <th>账号</th>
                <th>模型</th>
                <th>请求</th>
                <th>Token</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读</th>
                <th>缓存写</th>
                <th>缓存命中率</th>
                <th>积分</th>
                <th title="累计 Token ÷ 累计积分 × 100；没有逐请求积分的渠道显示 -">100 积分 ≈ Token</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in tableRows" :key="row.key">
                <td class="nowrap">{{ row.channelName }}</td>
                <td class="nowrap">{{ row.accountName }}</td>
                <td class="nowrap" :title="row.model">{{ row.model }}</td>
                <td>{{ formatNumber(row.totals.count) }}</td>
                <td class="font-bold">{{ formatCnNumber(row.totals.total) }}</td>
                <td>{{ formatCnNumber(row.totals.input) }}</td>
                <td>{{ formatCnNumber(row.totals.output) }}</td>
                <td class="text-purple">{{ formatCnNumber(row.totals.cacheRead) }}</td>
                <td class="text-orange">{{ formatCnNumber(row.totals.cacheWrite) }}</td>
                <td>{{ formatPercent(hitRateOf(row.totals)) }}</td>
                <td class="text-orange">{{ creditText(row) }}</td>
                <td class="text-purple">{{ ratioOf(row.totals) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3">合计</td>
                <td>{{ formatNumber(summary.count) }}</td>
                <td>{{ formatCnNumber(summary.tokens) }}</td>
                <td>{{ formatCnNumber(summary.input) }}</td>
                <td>{{ formatCnNumber(summary.output) }}</td>
                <td>{{ formatCnNumber(summary.cacheRead) }}</td>
                <td>{{ formatCnNumber(summary.cacheWrite) }}</td>
                <td>{{ formatPercent(summary.cacheHitRate) }}</td>
                <td>{{ formatCredit(summary.credits) }}</td>
                <td>{{ summary.ratio }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div v-else class="empty">
          {{ loading ? '加载中…' : '暂无数据：统计只覆盖启用后的请求，请求日志保留 90 天、逐日明细保留 35 天' }}
        </div>
        <div v-if="tableRows.length" class="table-note">
          Trae 的积分按余额差分记录，只能到账号维度，模型行的积分与换算比显示 -
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { getTokenBreakdown, clearTokenStats } from '../api.js'
import { formatCnNumber, formatNumber, formatPercent } from '../utils/format.js'
import { showToast } from '../composables/useToast.js'
import { usePageActions } from '../composables/usePageActions.js'
import { usePolling } from '../composables/usePolling.js'
import AppButton from '../components/AppButton.vue'
import SegmentedTabs from '../components/SegmentedTabs.vue'
import TrendChart from '../components/TrendChart.vue'

const dayOptions = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
]

const PALETTE = ['#7c5cff', '#2f9d78', '#d98b32', '#3b82f6', '#e05252', '#8b5cf6', '#14b8a6', '#64748b', '#d946ef', '#0ea5e9']
const MAX_SERIES = 10

const days = ref('30')
const channel = ref('')
const account = ref('')
const model = ref('')
const loading = ref(false)
const clearing = ref(false)
const dates = ref([])
const entries = ref([])

const dateLabels = computed(() => dates.value.map(date => `${date.slice(5, 7)}/${date.slice(8, 10)}`))

const channelOptions = computed(() => {
  const seen = new Map()
  for (const entry of entries.value) {
    if (!seen.has(entry.channel)) seen.set(entry.channel, entry.channelName || entry.channel)
  }
  return [...seen].map(([value, label]) => ({ value, label }))
})

const channelEntries = computed(() => (channel.value ? entries.value.filter(entry => entry.channel === channel.value) : entries.value))

const accountOptions = computed(() => {
  const seen = new Map()
  for (const entry of channelEntries.value) {
    const key = `${entry.channel}:${entry.uid}`
    if (!seen.has(key)) seen.set(key, entry.accountName || entry.uid || '未记录账号')
  }
  return [...seen].map(([value, label]) => ({ value, label }))
})

const accountEntries = computed(() =>
  account.value ? channelEntries.value.filter(entry => `${entry.channel}:${entry.uid}` === account.value) : channelEntries.value)

const modelOptions = computed(() => {
  const seen = new Set()
  for (const entry of accountEntries.value) seen.add(entry.model)
  return [...seen].map(value => ({ value, label: value }))
})

const visibleEntries = computed(() => (model.value ? accountEntries.value.filter(entry => entry.model === model.value) : accountEntries.value))

// 折线的分组层级：筛到哪一级，就用下一级当线，逐级下钻到「渠道-账号-模型」
const groupMode = computed(() => {
  if (model.value) return 'single'
  if (account.value) return 'model'
  if (channel.value) return 'account'
  return 'channel'
})

const groupLabel = computed(() => {
  if (groupMode.value === 'single') return '该模型'
  if (groupMode.value === 'model') return '各模型'
  if (groupMode.value === 'account') return '各账号'
  return '各渠道'
})

const groupHint = computed(() => {
  if (groupMode.value === 'single') return '当前：单个模型明细'
  if (groupMode.value === 'model') return '当前：按模型对比'
  if (groupMode.value === 'account') return '当前：按账号对比'
  return '当前：按渠道对比（选渠道可下钻到账号与模型）'
})

// 把筛出来的「渠道·账号·模型」按当前层级合并成折线用的序列
const groups = computed(() => {
  const map = new Map()
  for (const entry of visibleEntries.value) {
    const key = groupMode.value === 'single' ? entry.key
      : groupMode.value === 'channel' ? entry.channel
        : groupMode.value === 'account' ? `${entry.channel}:${entry.uid}`
          : entry.model
    const label = groupMode.value === 'single' ? `${entry.channelName} · ${entry.accountName} · ${entry.model}`
      : groupMode.value === 'channel' ? entry.channelName || entry.channel
        : groupMode.value === 'account' ? entry.accountName || entry.uid || '未记录账号'
          : entry.model
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        label,
        tokens: new Array(dates.value.length).fill(0),
        input: new Array(dates.value.length).fill(0),
        cacheRead: new Array(dates.value.length).fill(0),
        cacheWrite: new Array(dates.value.length).fill(0),
        credits: new Array(dates.value.length).fill(0),
      }
      map.set(key, group)
    }
    entry.series.forEach((point, index) => {
      group.tokens[index] += point.tokens
      group.input[index] += point.input
      group.cacheRead[index] += point.cacheRead
      group.cacheWrite[index] += point.cacheWrite
      group.credits[index] += point.credits
    })
  }
  return [...map.values()].sort((a, b) => sum(b.tokens) - sum(a.tokens))
})

function sum(list) {
  return list.reduce((acc, value) => acc + value, 0)
}

const shownGroups = computed(() => groups.value.slice(0, MAX_SERIES))

// 每条线的区间合计：图例上直接给出数字，不用悬停也能横向比较
function groupTotals(group) {
  return {
    tokens: sum(group.tokens),
    input: sum(group.input),
    cacheRead: sum(group.cacheRead),
    credits: sum(group.credits),
  }
}

function buildSeries(pick, summarize) {
  return shownGroups.value.map((group, index) => ({
    key: group.key,
    label: group.label,
    color: PALETTE[index % PALETTE.length],
    values: group.tokens.map((_, i) => pick(group, i)),
    summary: summarize(groupTotals(group)),
  }))
}

const tokenSeries = computed(() => buildSeries(
  (group, i) => group.tokens[i],
  totals => formatCnNumber(totals.tokens)
))

// 命中率按「读 ÷（未命中输入 + 读）」算，与概览卡片同一口径；没有输入的日期留空断线
const cacheSeries = computed(() => buildSeries(
  (group, i) => {
    const cacheable = group.input[i] + group.cacheRead[i]
    return cacheable > 0 ? (group.cacheRead[i] / cacheable) * 100 : null
  },
  totals => {
    const cacheable = totals.input + totals.cacheRead
    return formatPercent(cacheable > 0 ? (totals.cacheRead / cacheable) * 100 : null)
  }
))

const creditSeries = computed(() => buildSeries(
  (group, i) => group.credits[i],
  totals => formatCredit(totals.credits)
))

// 换算比：当天没有积分消耗就留空，避免把 0 画成一条贴底直线
const ratioSeries = computed(() => buildSeries(
  (group, i) => (group.credits[i] > 0 ? (group.tokens[i] / group.credits[i]) * 100 : null),
  totals => (totals.credits > 0 ? formatRatio((totals.tokens / totals.credits) * 100) : '-')
))

const summary = computed(() => {
  let tokens = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let credits = 0
  let count = 0
  for (const entry of visibleEntries.value) {
    tokens += entry.totals.total
    input += entry.totals.input
    output += entry.totals.output
    cacheRead += entry.totals.cacheRead
    cacheWrite += entry.totals.cacheWrite
    credits += entry.totals.creditsUsed
    count += entry.totals.count
  }
  const cacheable = input + cacheRead
  return {
    tokens,
    input,
    output,
    cacheRead,
    cacheWrite,
    credits,
    count,
    cacheHitRate: cacheable > 0 ? (cacheRead / cacheable) * 100 : null,
    ratio: credits > 0 ? formatNumber(Math.round((tokens / credits) * 100)) : '-',
  }
})

const tableRows = computed(() =>
  visibleEntries.value
    .slice()
    .sort((a, b) => b.totals.total - a.totals.total))

function hitRateOf(totals) {
  const cacheable = Number(totals.input) + Number(totals.cacheRead)
  return cacheable > 0 ? (Number(totals.cacheRead) / cacheable) * 100 : null
}

function ratioOf(totals) {
  const credits = Number(totals.creditsUsed)
  if (!(credits > 0)) return '-'
  return formatNumber(Math.round((Number(totals.total) / credits) * 100))
}

function formatCredit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return Number.isInteger(number) ? String(number) : number.toFixed(2)
}

// 换算比取整：这是「每 100 积分大约多少 token」，小数点后几位没有意义
function formatRatio(value) {
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(Math.round(number)) : '-'
}

// Trae 没有逐请求积分（只有账号级的余额差分），模型行显示 - 而不是 0，避免看起来「不花钱」
function creditText(row) {
  const credits = Number(row.totals.creditsUsed) || 0
  if (credits > 0) return formatCredit(credits)
  return row.channel === 'trae' ? '-' : '0'
}

async function load() {
  loading.value = true
  try {
    const data = await getTokenBreakdown(Number(days.value))
    dates.value = Array.isArray(data?.dates) ? data.dates : []
    entries.value = Array.isArray(data?.entries) ? data.entries : []
  } finally {
    loading.value = false
  }
}

// 改了上层筛选就把下层归位，否则会留下一个已经不存在的账号/模型
watch(channel, () => {
  account.value = ''
  model.value = ''
})
watch(account, () => {
  model.value = ''
})
watch(days, load)
onMounted(load)
usePageActions({ live: true })
usePolling(load, 10000)

// 清空不可恢复：连同渠道/账号/模型三级明细一起归零
async function clearStats() {
  const confirmed = window.confirm('确定清空全部 Token 统计吗？\n\n此操作不可恢复：按日/月/时/模型/渠道/账号的统计与三级明细都会永久删除，状态面板的请求数也会同步归零。')
  if (!confirmed) return
  clearing.value = true
  try {
    await clearTokenStats()
    await load()
    showToast('Token 统计已清空')
  } catch (err) {
    showToast('清空 Token 统计失败: ' + (err?.response?.data?.error || err?.message || '无法连接服务'), 'error', 4000)
  } finally {
    clearing.value = false
  }
}
</script>

<style scoped>
.summary-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
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
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.summary-sub {
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.stats-filter {
  padding: 14px 16px;
  margin-bottom: 16px;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.filter-sep {
  width: 1px;
  height: 22px;
  margin: 0 2px;
  background: var(--border-1);
}
.filter-select {
  min-width: 152px;
}
.filter-clear {
  margin-left: auto;
}
.filter-hint {
  margin-top: 9px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 8px;
}
.data-table {
  min-width: 900px;
}
.data-table tfoot td {
  font-weight: 600;
  color: var(--text-1);
  background: var(--bg-subtle);
}
.empty {
  padding: 48px 0;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-3);
}
.table-note {
  padding: 10px 14px 14px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.chart-note {
  margin: -4px 0 12px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
@media (max-width: 1200px) {
  .summary-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chart-grid { grid-template-columns: 1fr; }
}
</style>
