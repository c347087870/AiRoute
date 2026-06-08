<template>
  <div class="token-stats-page">
    <div class="page-header">
      <h1 class="page-title">Token 使用统计</h1>
      <button class="btn-ghost" @click="refreshData" :disabled="loading">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <!-- 时间维度选择 -->
    <div class="period-selector">
      <button
        v-for="period in periods"
        :key="period.value"
        class="period-btn"
        :class="{ active: selectedPeriod === period.value }"
        @click="selectPeriod(period.value)"
      >
        {{ period.label }}
      </button>
    </div>

    <!-- 汇总统计卡片 -->
    <div class="summary-cards">
      <div class="card summary-card">
        <div class="summary-icon purple">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M3 9h18"/>
            <path d="M9 21V9"/>
          </svg>
        </div>
        <div class="summary-content">
          <div class="summary-label">总计 Token</div>
          <div class="summary-value purple">{{ formatNumber(currentStats.total) }}</div>
        </div>
      </div>

      <div class="card summary-card">
        <div class="summary-icon orange">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <div class="summary-content">
          <div class="summary-label">请求次数</div>
          <div class="summary-value orange">{{ formatNumber(currentStats.count) }}</div>
        </div>
      </div>
    </div>

    <!-- 趋势图表 -->
    <div class="section">
      <h2 class="section-title">
        {{ chartTitle }}
      </h2>
      <div class="card chart-container" @mouseleave="hideTooltip">
        <div v-if="chartData.length > 0" class="line-chart">
          <!-- Tooltip -->
          <div 
            v-if="tooltip.visible"
            class="chart-tooltip"
            :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
          >
            <div class="tooltip-time">{{ tooltip.time }}</div>
            <div class="tooltip-divider"></div>
            <div class="tooltip-row">
              <span class="tooltip-label">Token:</span>
              <span class="tooltip-value">{{ formatNumber(tooltip.total) }}</span>
            </div>
            <div class="tooltip-row">
              <span class="tooltip-label">请求:</span>
              <span class="tooltip-value">{{ formatNumber(tooltip.count) }}</span>
            </div>
          </div>
          
          <svg 
            :viewBox="`0 0 ${svgWidth} ${svgHeight}`" 
            class="chart-svg"
            @mousemove="handleChartMouseMove"
          >
            <!-- 网格线 -->
            <g class="grid-lines">
              <line
                v-for="i in 5"
                :key="'h' + i"
                :x1="paddingLeft"
                :y1="getGridY(i)"
                :x2="svgWidth - paddingRight"
                :y2="getGridY(i)"
                stroke="#E0E0E0"
                stroke-width="1"
                stroke-dasharray="4,4"
              />
            </g>
            
            <!-- 垂直参考线 -->
            <line
              v-if="tooltip.visible && tooltip.index >= 0"
              :x1="getX(tooltip.index)"
              :y1="paddingTop"
              :x2="getX(tooltip.index)"
              :y2="svgHeight - paddingBottom"
              stroke="#0082FC"
              stroke-width="1.5"
              stroke-dasharray="5,5"
              opacity="0.6"
            />
            
            <!-- 折线 -->
            <polyline
              :points="linePoints"
              fill="none"
              stroke="#0082FC"
              stroke-width="2.5"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            
            <!-- 数据点 -->
            <circle
              v-for="(point, index) in chartData"
              :key="index"
              :cx="getX(index)"
              :cy="getY(point.total)"
              :r="tooltip.index === index ? 6 : 4"
              :fill="tooltip.index === index ? '#FF5722' : '#0082FC'"
              stroke="#FFFFFF"
              stroke-width="2"
              class="data-point"
            />
            
            <!-- X轴标签 -->
            <text
              v-for="(point, index) in filteredLabels"
              :key="'label-' + index"
              :x="getX(index)"
              :y="svgHeight - 10"
              text-anchor="middle"
              font-size="11"
              fill="#666666"
            >
              {{ point.label }}
            </text>
          </svg>
        </div>
        <div v-else class="empty-chart">
          暂无数据
        </div>
      </div>
    </div>

    <!-- 模型使用量表格 -->
    <div class="section">
      <h2 class="section-title">各模型使用量</h2>
      <div class="card">
        <table class="model-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求次数</th>
              <th>总 Token</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(stats, model) in modelStats" :key="model">
              <td>{{ model }}</td>
              <td>{{ formatNumber(stats.count) }}</td>
              <td class="text-purple font-bold">{{ formatNumber(stats.total) }}</td>
              <td>
                <div class="percentage-bar">
                  <div 
                    class="percentage-fill" 
                    :style="{ width: getPercentage(stats.total) + '%' }"
                  ></div>
                  <span class="percentage-text">{{ getPercentage(stats.total) }}%</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getTokenStatsByPeriod, getTokenStatsHourly, getTokenStats } from '../api.js'

// 时间维度选项
const periods = [
  { value: 'today', label: '今天（24小时）' },
  { value: '3', label: '近三天' },
  { value: '7', label: '近七天' },
  { value: '15', label: '近半个月' },
  { value: '30', label: '近一个月' }
]

const selectedPeriod = ref('today') // 默认显示今天的小时数据
const periodData = ref({ summary: {}, details: [] })
const modelStatsData = ref({})
const loading = ref(false)

// Tooltip 状态
const tooltip = ref({
  visible: false,
  x: 0,
  y: 0,
  time: '',
  total: 0,
  count: 0,
  index: -1
})

// 当前统计数据
const currentStats = computed(() => periodData.value.summary || {})

// 图表数据
const chartData = computed(() => {
  if (selectedPeriod.value === 'today') {
    // 今天：按小时显示
    return periodData.value.details?.map(d => ({
      label: d.displayLabel,
      total: d.total,
      count: d.count || 0
    })) || []
  } else {
    // 多天：按天显示
    return periodData.value.details?.map(d => ({
      label: d.displayDate,
      total: d.total,
      count: d.count || 0
    })) || []
  }
})

// 模型统计数据
const modelStats = computed(() => modelStatsData.value.byModel || {})

// 图表标题
const chartTitle = computed(() => {
  if (selectedPeriod.value === 'today') {
    return '今日每小时使用趋势'
  } else {
    const days = selectedPeriod.value
    return `近${days}天使用趋势`
  }
})

// SVG 图表配置
const svgWidth = 800
const svgHeight = 300
const paddingLeft = 60
const paddingRight = 30
const paddingTop = 20
const paddingBottom = 40
const chartWidth = svgWidth - paddingLeft - paddingRight
const chartHeight = svgHeight - paddingTop - paddingBottom

// 计算最大值
const maxValue = computed(() => {
  if (chartData.value.length === 0) return 1
  return Math.max(...chartData.value.map(d => d.total), 1)
})

// 过滤标签（避免太密集）
const filteredLabels = computed(() => {
  const data = chartData.value
  if (data.length <= 10) return data
  
  // 如果数据点太多，每隔几个显示一个
  const step = Math.ceil(data.length / 10)
  return data.filter((_, index) => index % step === 0)
})

// 计算折线路径
const linePoints = computed(() => {
  return chartData.value.map((point, index) => {
    const x = getX(index)
    const y = getY(point.total)
    return `${x},${y}`
  }).join(' ')
})

// 获取X坐标
function getX(index) {
  const data = chartData.value
  if (data.length <= 1) return paddingLeft + chartWidth / 2
  return paddingLeft + (index / (data.length - 1)) * chartWidth
}

// 获取Y坐标
function getY(value) {
  return paddingTop + chartHeight - (value / maxValue.value) * chartHeight
}

// 获取网格线Y坐标
function getGridY(level) {
  return paddingTop + (chartHeight / 5) * level
}

// 计算百分比
function getPercentage(total) {
  const grandTotal = Object.values(modelStats.value).reduce((sum, s) => sum + (s.total || 0), 0)
  if (grandTotal === 0) return 0
  return Math.round((total / grandTotal) * 100)
}

// Tooltip 估算宽度和高度
const tooltipWidth = 160
const tooltipHeight = 90
const tipOffsetX = 15
const tipOffsetY = 10

// 鼠标在图表上滑动时，根据鼠标 X 位置找最近的数据点并显示 Tooltip
function handleChartMouseMove(event) {
  const svgEl = event.currentTarget
  const lineChartEl = svgEl.closest('.line-chart')
  if (!lineChartEl || chartData.value.length === 0) return

  // 获取 SVG 在页面中的位置和尺寸
  const svgRect = svgEl.getBoundingClientRect()

  // 计算鼠标在 SVG 坐标系中的 X 位置
  const scaleX = svgWidth / svgRect.width
  const mouseXInSvg = (event.clientX - svgRect.left) * scaleX

  // 找到离鼠标最近的数据点
  const dataLen = chartData.value.length
  if (dataLen <= 1) {
    updateTooltipPosition(event, lineChartEl, 0)
  } else {
    // 将 mouseXInSvg 映射到数据索引
    const ratio = (mouseXInSvg - paddingLeft) / chartWidth
    const nearestIndex = Math.round(ratio * (dataLen - 1))
    const clampedIndex = Math.max(0, Math.min(dataLen - 1, nearestIndex))

    const point = chartData.value[clampedIndex]
    if (!point) { hideTooltip(); return }

    updateTooltipPosition(event, lineChartEl, clampedIndex)
  }
}

// 计算 Tooltip 位置并设置状态（智能翻转方向）
function updateTooltipPosition(event, lineChartEl, dataIndex) {
  const point = chartData.value[dataIndex]
  if (!point) { hideTooltip(); return }

  const lineChartRect = lineChartEl.getBoundingClientRect()

  // 鼠标相对于 .line-chart 容器的位置
  const mouseX = event.clientX - lineChartRect.left
  const mouseY = event.clientY - lineChartRect.top

  // 容器尺寸
  const containerW = lineChartRect.width
  const containerH = lineChartRect.height

  // 默认：鼠标右侧上方
  let tipX = mouseX + tipOffsetX
  let tipY = mouseY - tooltipHeight - tipOffsetY

  // 右边不够 → 翻到鼠标左侧
  if (tipX + tooltipWidth > containerW) {
    tipX = mouseX - tooltipWidth - tipOffsetX
  }

  // 上边不够 → 翻到鼠标下方
  if (tipY < 0) {
    tipY = mouseY + tipOffsetY
  }

  // 左边不够（极端情况）→ 钳制到容器左边界
  if (tipX < 0) {
    tipX = tipOffsetX
  }

  // 下边不够（极端情况）→ 钳制到容器下边界
  if (tipY + tooltipHeight > containerH) {
    tipY = containerH - tooltipHeight - tipOffsetY
  }

  tooltip.value = {
    visible: true,
    x: tipX,
    y: tipY,
    time: point.label,
    total: point.total,
    count: point.count || 0,
    index: dataIndex
  }
}

// 隐藏 Tooltip
function hideTooltip() {
  tooltip.value.visible = false
  tooltip.value.index = -1
}

// 格式化数字
function formatNumber(num) {
  if (!num && num !== 0) return '0'
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 选择时间维度
async function selectPeriod(period) {
  selectedPeriod.value = period
  await loadPeriodData(period)
}

// 加载时间段数据
async function loadPeriodData(period) {
  loading.value = true
  try {
    if (period === 'today') {
      // 今天：获取按小时的数据
      const today = new Date().toISOString().split('T')[0]
      const hourlyData = await getTokenStatsHourly(today)
      periodData.value = {
        summary: {
          total: hourlyData.details.reduce((sum, d) => sum + (d.total || 0), 0),
          count: hourlyData.details.reduce((sum, d) => sum + (d.count || 0), 0)
        },
        details: hourlyData.details
      }
    } else {
      // 多天：获取按天的数据
      const days = parseInt(period)
      periodData.value = await getTokenStatsByPeriod(days)
    }
    
    // 同时加载模型统计
    const allStats = await getTokenStats()
    modelStatsData.value = allStats
  } catch (err) {
    console.error('Failed to load token stats:', err)
  }
  loading.value = false
}

// 刷新数据
async function refreshData() {
  await loadPeriodData(selectedPeriod.value)
}

onMounted(() => {
  loadPeriodData(selectedPeriod.value)
})
</script>

<style scoped>
.token-stats-page {
  padding-bottom: 40px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0;
  color: #1A1A1A;
}

/* 时间维度选择器 */
.period-selector {
  display: flex;
  gap: 10px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.period-btn {
  background: #F5F5F5;
  border: 1px solid #E0E0E0;
  color: #666666;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}

.period-btn:hover {
  border-color: #0082FC;
  color: #0082FC;
  background: #F0F7FF;
}

.period-btn.active {
  background: #0082FC;
  border-color: #0082FC;
  color: #FFFFFF;
}

/* 汇总卡片 */
.summary-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 28px;
}

.summary-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
}

.summary-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.summary-icon.purple {
  background: #F3E5F5;
  color: #9C27B0;
}

.summary-icon.orange {
  background: #FFF3E0;
  color: #FF9500;
}

.summary-content {
  flex: 1;
}

.summary-label {
  font-size: 12px;
  color: #999999;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.summary-value {
  font-size: 24px;
  font-weight: 700;
}

.summary-value.purple {
  color: #9C27B0;
}

.summary-value.orange {
  color: #FF9500;
}

/* 图表区域 */
.section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #1A1A1A;
}

.chart-container {
  padding: 24px;
  min-height: 350px;
}

.line-chart {
  width: 100%;
  height: 300px;
  position: relative;
}

.chart-svg {
  width: 100%;
  height: 100%;
}

.data-point {
  cursor: pointer;
  transition: r 0.2s;
}

.data-point:hover {
  r: 6;
}

.empty-chart {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 250px;
  color: #999999;
  font-size: 14px;
}

/* Tooltip 样式 */
.chart-tooltip {
  position: absolute;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid #E0E0E0;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  pointer-events: none;
  z-index: 1000;
  min-width: 150px;
}

.tooltip-time {
  font-size: 13px;
  font-weight: 600;
  color: #1A1A1A;
  margin-bottom: 8px;
}

.tooltip-divider {
  height: 1px;
  background: #E0E0E0;
  margin: 8px 0;
}

.tooltip-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 12px;
}

.tooltip-row:last-child {
  margin-bottom: 0;
}

.tooltip-label {
  color: #666666;
  margin-right: 12px;
}

.tooltip-value {
  color: #1A1A1A;
  font-weight: 600;
}

/* 模型表格 */
.model-table {
  width: 100%;
  border-collapse: collapse;
}

.model-table th,
.model-table td {
  text-align: left;
  padding: 12px;
  font-size: 13px;
  border-bottom: 1px solid #F0F0F0;
  color: #1A1A1A;
}

.model-table th {
  color: #999999;
  font-weight: 500;
  background: #FAFAFA;
}

.model-table tbody tr:hover {
  background: #F5F5F5;
}

.percentage-bar {
  position: relative;
  height: 24px;
  background: #F0F0F0;
  border-radius: 4px;
  overflow: hidden;
}

.percentage-fill {
  height: 100%;
  background: linear-gradient(90deg, #0082FC, #4DA6FF);
  transition: width 0.3s ease;
}

.percentage-text {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  font-weight: 600;
  color: #1A1A1A;
}

.text-purple {
  color: #9C27B0;
}

.font-bold {
  font-weight: 600;
}

/* 响应式 */
@media (max-width: 768px) {
  .summary-cards {
    grid-template-columns: 1fr;
  }
  
  .chart-container {
    padding: 16px;
  }
}
</style>
