<template>
  <div class="dashboard">
    <!-- 时间维度：默认「当日」，切档后顶部两张卡与用量概览一起换口径 ——
         页面上的数字必须属于同一个区间，否则「请求数」和「用量」会各说各话 -->
    <div class="page-toolbar dashboard-toolbar">
      <SegmentedTabs
        v-model="selectedRange"
        :options="RANGE_TABS"
        label="状态面板时间维度"
      />
    </div>

    <div class="stats-grid">
      <div class="card stat-card">
        <div class="stat-label">Router 状态</div>
        <div class="stat-value" :class="isOnline ? 'green' : 'red'">
          {{ isOnline ? '运行中' : '离线' }}
        </div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">请求数</div>
        <div class="stat-value">
          {{ formatNumber(periodStats.requests) }}
        </div>
        <div
          class="stat-subtitle"
          :title="`${currentRange.label}成功 ${formatNumber(periodStats.count)} 次、失败 ${formatNumber(periodStats.failed)} 次；请求数 = 成功 + 失败，与用量统计同源`"
        >
          {{ currentRange.label }} · 失败 {{ formatNumber(periodStats.failed) }}
        </div>
      </div>
    </div>

    <!-- 用量概览：当前区间只展示一份，输入 / 命中缓存 / 输出 + 命中率，
         缓存写明细与趋势图在用量统计页 -->
    <div class="section">
      <div class="section-header">
        <h2 class="section-title">用量概览</h2>
        <router-link class="link-more" to="/token-stats">用量统计 →</router-link>
      </div>
      <div class="card usage-card">
        <div class="usage-group">
          <div class="usage-total">
            <span class="usage-total-value">{{ formatNumber(usageGroup.total) }}</span>
            <span class="usage-total-unit">Token</span>
          </div>
          <div class="usage-split">
            <span class="usage-part">
              <span class="usage-part-label">输入</span>
              <span class="usage-part-value input">{{ formatNumber(usageGroup.input) }}</span>
            </span>
            <span class="usage-part">
              <span class="usage-part-label">命中缓存</span>
              <span class="usage-part-value cacheRead">{{ formatNumber(usageGroup.cacheRead) }}</span>
            </span>
            <span class="usage-part">
              <span class="usage-part-label">输出</span>
              <span class="usage-part-value output">{{ formatNumber(usageGroup.output) }}</span>
            </span>
          </div>
          <div class="usage-rate" :title="usageGroup.rateTitle">
            缓存命中率 {{ formatPercent(usageGroup.hitRate) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 最近请求只留 5 条关键列，完整列表与筛选在日志页 -->
    <div class="section">
      <div class="section-header">
        <h2 class="section-title">最近请求</h2>
        <router-link class="link-more" to="/logs">查看全部 →</router-link>
      </div>
      <div class="card table-card">
        <table class="table" v-if="recentLogs.length">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th title="输入 + 缓存读 + 缓存写 + 输出，明细见日志查看">总计 Token</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(log, i) in recentLogs" :key="i">
              <td class="nowrap">{{ formatTime(log.timestamp) }}</td>
              <td>{{ log.model }}</td>
              <td>
                <span :class="log.status === 200 ? 'text-green' : 'text-red'">
                  {{ log.status }}
                </span>
              </td>
              <td class="nowrap">{{ log.responseTime }}ms</td>
              <td>{{ tokenCell(log.totalTokens) }}</td>
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
import SegmentedTabs from '../components/SegmentedTabs.vue'
import { usePageActions } from '../composables/usePageActions.js'
import { usePolling } from '../composables/usePolling.js'
import { getLogs, getHealth, getTokenStatsRange } from '../api.js'
import { formatNumber, formatPercent, formatTime, calcCacheHitRate } from '../utils/format.js'

// 总计单元格：上游未返回用量时服务端给 null，显示 '-'（与日志页口径一致），
// 直接 formatNumber(null) 会显示 0，容易被误读成「真实用量为 0」
function tokenCell(v) {
  return v === null || v === undefined ? '-' : formatNumber(v)
}

// 时间维度：day / month / quarter / year 由服务端 /api/token-stats/range 一次算好。
// 月维度走月汇总桶而不是把按日明细加起来 —— 按日只留 35 天，月初用日明细加会少一截。
// 区间细节只放在 title（悬停可见），不再在页面上常驻一行说明
const RANGE_TABS = [
  { value: 'day', label: '当日', title: '今天 0 点到现在' },
  { value: 'month', label: '本月', title: '本月 1 日到现在' },
  { value: 'quarter', label: '近三月', title: '本月与往前两个自然月（滚动三个月）' },
  { value: 'year', label: '本年', title: '今年 1 月 1 日到现在' }
]

const selectedRange = ref('day') // 默认当日
const recentLogs = ref([]) // 最近 5 条请求日志
const isOnline = ref(false) // Router 是否在线，只由健康检查决定

// 四个区间的 Token 统计，键与 RANGE_TABS 的 value 对应
const rangeStats = ref(emptyRangeStats())

function emptyStat() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, count: 0, failed: 0 }
}

function emptyRangeStats() {
  return { day: emptyStat(), month: emptyStat(), quarter: emptyStat(), year: emptyStat() }
}

const currentRange = computed(
  () => RANGE_TABS.find(r => r.value === selectedRange.value) || RANGE_TABS[0]
)

const selectedStats = computed(() => rangeStats.value[selectedRange.value] || emptyStat())

// 请求次数口径 = 有 token 的请求（count）+ 失败请求（failed），与用量统计页一致
const periodStats = computed(() => {
  const stats = selectedStats.value
  const count = Number(stats.count) || 0
  const failed = Number(stats.failed) || 0
  return { count, failed, requests: count + failed }
})

// 用量概览只保留总计 / 输入 / 输出与缓存命中；缓存写明细与趋势图在用量统计页
const usageGroup = computed(() => {
  const stats = selectedStats.value
  return {
    total: stats.total,
    input: stats.input,
    cacheRead: stats.cacheRead,
    output: stats.output,
    hitRate: calcCacheHitRate(stats),
    rateTitle: '缓存命中率 = 命中缓存 ÷（输入 + 命中缓存），缓存写不计入分母'
  }
})

// 加载 Router 健康状态，只有这个接口的成败影响在线状态
async function loadHealth() {
  try {
    await getHealth()
    isOnline.value = true
  } catch {
    isOnline.value = false
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

// 加载四个区间的 Token 汇总。失败时保留上一次的数据，
// 轮询每 5 秒重试，没必要为一次抖动把数字清零
async function loadTokenStats() {
  try {
    const data = await getTokenStatsRange()
    if (data) rangeStats.value = { ...emptyRangeStats(), ...data }
  } catch (err) {
    console.error('加载 Token 统计失败:', err)
  }
}

// 加载所有 Dashboard 数据，各接口独立失败互不影响
async function loadData() {
  await Promise.all([loadHealth(), loadLogs(), loadTokenStats()])
}

// 顶部栏的「实时」角标由布局渲染，5 秒轮询由 usePolling 统一负责
usePageActions({ live: true })
usePolling(loadData)

onMounted(() => { loadData() })
</script>

<style scoped>
/* 工具条：全局 .page-toolbar 是整条右对齐，而这里是页面唯一的时间维度切换，
   放在左侧与下方卡片的左边缘对齐 */
.dashboard-toolbar {
  justify-content: flex-start;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 28px;
}

.stat-card {
  text-align: center;
}

.stat-label {
  font-size: var(--fs-xs);
  color: var(--text-3);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-value {
  font-size: var(--fs-display);
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.stat-value.green {
  color: var(--success);
}

.stat-value.red {
  color: var(--danger);
}

/* 请求数卡片的统计口径说明，悬停显示完整口径 */
.stat-subtitle {
  font-size: var(--fs-mini);
  color: var(--text-3);
  margin-top: 6px;
  cursor: help;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.section-header .section-title {
  margin-bottom: 0;
}

/* 实时刷新提示的样式已随「实时」角标搬到 App.vue 的顶部栏（全局样式） */

/* 二级页面入口：右对齐的轻量链接 */
.link-more {
  font-size: var(--fs-xs);
  color: var(--primary);
  text-decoration: none;
  white-space: nowrap;
}

.link-more:hover {
  text-decoration: underline;
}

/* 用量概览：一档一份，靠字号层级区分主次，不用底色块。
   原来这里是「今天 / 本月」左右两栏，两栏还要用 subgrid 对齐行轨道；
   改成按档切换后只剩一份，subgrid 与中间分隔线一起删掉 */
.usage-card {
  padding: 18px 24px;
}

.usage-group {
  min-width: 0;
}

/* 卡内不再重复当前时间维度：顶部的分段控件已经标出选中的是哪一档，
   再来一行「当日 / 本月」只是把同一件事说两遍 */
.usage-total {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 10px;
}

/* 等宽数字：切档时位数不跳动 */
.usage-total-value {
  font-size: var(--fs-display);
  font-weight: 700;
  line-height: 1.15;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.3px;
}

.usage-total-unit {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.usage-split {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 18px;
}

.usage-part {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.usage-part-label {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.usage-part-value {
  font-size: var(--fs-small);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.usage-part-value.input {
  color: var(--primary);
}

.usage-part-value.cacheRead {
  color: var(--purple);
}

.usage-part-value.output {
  color: var(--success);
}

/* 命中率：弱化到辅助信息层级，数字与上方统计保持同一行内基线 */
.usage-rate {
  margin-top: 8px;
  font-size: var(--fs-mini);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  cursor: help;
}

/* 窄屏下两张卡改成上下两段 */
@media (max-width: 900px) {
  .usage-card {
    padding: 16px 18px;
  }

  .stats-grid {
    grid-template-columns: 1fr;
  }
}

</style>
