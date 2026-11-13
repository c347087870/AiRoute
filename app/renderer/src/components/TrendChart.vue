<template>
  <div class="trend-chart">
    <div class="chart-head">
      <span class="chart-title">{{ title }}</span>
      <span v-if="summary" class="chart-summary">{{ summary }}</span>
      <span v-if="unit" class="chart-unit">{{ unit }}</span>
    </div>
    <div v-if="hasData" class="chart-body">
      <div class="legend">
        <span v-for="item in series" :key="item.key" class="legend-item" :title="`${item.label}：${item.summary || ''}`">
          <i :style="{ background: item.color }"></i>
          <span class="legend-label">{{ item.label }}</span>
          <b v-if="item.summary" class="legend-value">{{ item.summary }}</b>
        </span>
      </div>
      <div class="plot-grid">
        <div class="y-axis">
        <span
          v-for="tick in yTicks"
          :key="tick.ratio"
          class="y-tick"
          :style="{ bottom: `${tick.ratio * 100}%` }"
        >{{ tick.label }}</span>
      </div>
      <div class="plot" @mousemove="onMove" @mouseleave="hoverIndex = -1">
        <svg class="plot-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line
            v-for="tick in yTicks"
            :key="`grid-${tick.ratio}`"
            class="grid-line"
            x1="0"
            :y1="100 - tick.ratio * 100"
            x2="100"
            :y2="100 - tick.ratio * 100"
          />
          <polyline
            v-for="segment in segments"
            :key="segment.key"
            :points="segment.points"
            fill="none"
            :stroke="segment.color"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <line
            v-if="hoverIndex >= 0"
            class="hover-line"
            :x1="xPercent(hoverIndex)"
            y1="0"
            :x2="xPercent(hoverIndex)"
            y2="100"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <template v-if="hoverIndex >= 0">
          <span
            v-for="dot in hoverDots"
            :key="`dot-${dot.key}`"
            class="dot"
            :style="{ left: `${dot.x}%`, bottom: `${dot.y}%`, background: dot.color }"
          ></span>
          <div class="tooltip" :style="tooltipStyle">
            <div class="tooltip-date">{{ labels[hoverIndex] }}</div>
            <div v-for="row in tooltipRows" :key="row.key" class="tooltip-row">
              <i :style="{ background: row.color }"></i>
              <span class="tooltip-label">{{ row.label }}</span>
              <span class="tooltip-value">{{ row.value }}</span>
            </div>
            <div v-if="tooltipMore" class="tooltip-more">另有 {{ tooltipMore }} 条</div>
          </div>
        </template>
      </div>
      <div class="x-axis">
        <span
          v-for="label in xLabels"
          :key="label.index"
          class="x-tick"
          :style="{ left: `${label.percent}%` }"
        >{{ label.text }}</span>
      </div>
      </div>
    </div>
    <div v-else class="chart-empty">暂无数据</div>
  </div>
</template>

<script setup>
// 多序列折线图：鼠标移到图上时给出竖线 + 每个序列在该时间点的具体数值。
// 用绝对定位的 HTML 画坐标轴与提示框，只有折线交给 SVG ——
// SVG 里放文字要跟着 viewBox 拉伸变形，坐标轴与提示框用 DOM 才不会糊
import { computed, ref } from 'vue'

const props = defineProps({
  title: { type: String, default: '趋势' },
  // 卡片右上角的区间合计（如「合计 44.6亿」），没有就不显示
  summary: { type: String, default: '' },
  // X 轴刻度文案（如 10/15），长度与每条序列的 values 一致
  labels: { type: Array, default: () => [] },
  // [{ key, label, color, values: (number|null)[], summary? }]；null 表示该点无数据，折线断开
  series: { type: Array, default: () => [] },
  formatValue: { type: Function, default: value => String(value ?? 0) },
  // 坐标轴刻度用的紧凑格式，默认与提示框一致
  formatAxis: { type: Function, default: null },
  unit: { type: String, default: '' },
  maxTooltipRows: { type: Number, default: 8 },
})

const hoverIndex = ref(-1)

const flatValues = computed(() => {
  const out = []
  for (const item of props.series) {
    for (const value of item.values || []) {
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) out.push(Number(value))
    }
  }
  return out
})

const hasData = computed(() => props.labels.length > 0 && flatValues.value.length > 0)

// 上限取整到 1 / 2 / 5 × 10^n，刻度文字才不会出现 373,412,881 这种脏数字
const max = computed(() => {
  const peak = flatValues.value.reduce((acc, value) => Math.max(acc, value), 0)
  if (peak <= 0) return 1
  const exponent = Math.floor(Math.log10(peak))
  const base = Math.pow(10, exponent)
  const norm = peak / base
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * base
})

const axisFormatter = computed(() => props.formatAxis || props.formatValue)

const yTicks = computed(() => [0, 0.25, 0.5, 0.75, 1].map(ratio => ({
  ratio,
  label: axisFormatter.value(max.value * ratio),
})))

function xPercent(index) {
  if (props.labels.length <= 1) return 50
  return (index / (props.labels.length - 1)) * 100
}

function yPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(100, Math.max(0, (number / max.value) * 100))
}

// 空值处断开：一段连续的有点区间画一条 polyline，避免把缺口直接连成直线
const segments = computed(() => {
  const out = []
  for (const item of props.series) {
    let current = []
    const flush = () => {
      if (current.length >= 2) out.push({ key: `${item.key}-${out.length}`, color: item.color, points: current.join(' ') })
      current = []
    }
    ;(item.values || []).forEach((value, index) => {
      const y = yPercent(value)
      if (y === null) {
        flush()
        return
      }
      current.push(`${xPercent(index)},${100 - y}`)
    })
    flush()
  }
  return out
})

const hoverDots = computed(() => {
  if (hoverIndex.value < 0) return []
  const out = []
  for (const item of props.series) {
    const y = yPercent(item.values?.[hoverIndex.value])
    if (y === null) continue
    out.push({ key: item.key, color: item.color, x: xPercent(hoverIndex.value), y })
  }
  return out
})

// 提示框按数值从大到小排，扫一眼就知道这一刻谁在花钱
const hoverRows = computed(() => {
  if (hoverIndex.value < 0) return []
  return props.series
    .map(item => {
      const raw = item.values?.[hoverIndex.value]
      const value = raw === null || raw === undefined ? null : Number(raw)
      return { key: item.key, label: item.label, color: item.color, value }
    })
    .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
})

const tooltipRows = computed(() => hoverRows.value.slice(0, props.maxTooltipRows).map(row => ({
  ...row,
  value: row.value === null || !Number.isFinite(row.value) ? '—' : props.formatValue(row.value),
})))

const tooltipMore = computed(() => Math.max(0, hoverRows.value.length - props.maxTooltipRows))

const tooltipStyle = computed(() => {
  const x = xPercent(Math.max(0, hoverIndex.value))
  const anchor = x > 62 ? 'translateX(-103%)' : x < 12 ? 'translateX(-3%)' : 'translateX(-50%)'
  return { left: `${x}%`, transform: anchor }
})

const xLabels = computed(() => {
  const total = props.labels.length
  if (!total) return []
  const step = Math.max(1, Math.ceil(total / 6))
  return props.labels
    .map((text, index) => ({ text, index }))
    .filter(item => item.index % step === 0 || item.index === total - 1)
    .map(item => ({ ...item, percent: xPercent(item.index) }))
})

function onMove(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  if (!rect.width || props.labels.length === 0) return
  const ratio = (event.clientX - rect.left) / rect.width
  const index = Math.round(ratio * (props.labels.length - 1))
  hoverIndex.value = Math.min(props.labels.length - 1, Math.max(0, index))
}
</script>

<style scoped>
.trend-chart {
  padding: 16px 18px 10px;
}
.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.chart-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-1);
}
.chart-summary {
  margin-left: auto;
  padding-left: 10px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.chart-unit {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.chart-body {
  display: block;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin-bottom: 8px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
}
.legend-label {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend-value {
  color: var(--text-1);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.legend-item i {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.plot-grid {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  grid-template-rows: 240px 18px;
  column-gap: 6px;
}
.y-axis {
  position: relative;
}
.y-tick {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  font-size: var(--fs-mini);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.plot {
  position: relative;
  border-left: 1px solid var(--border-1);
  border-bottom: 1px solid var(--border-1);
}
.plot-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.grid-line {
  stroke: var(--border-1);
  stroke-dasharray: 4 4;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.hover-line {
  stroke: var(--text-4);
  stroke-dasharray: 4 3;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.dot {
  position: absolute;
  width: 7px;
  height: 7px;
  margin: 0 0 -3.5px -3.5px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--bg-card);
  pointer-events: none;
}
.x-axis {
  position: relative;
  grid-column: 2;
}
.x-tick {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  font-size: var(--fs-mini);
  color: var(--text-3);
  white-space: nowrap;
}
.tooltip {
  position: absolute;
  top: 6px;
  z-index: 5;
  min-width: 150px;
  max-width: 260px;
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop, 0 8px 24px rgba(0, 0, 0, 0.16));
  pointer-events: none;
}
.tooltip-date {
  font-size: var(--fs-xs);
  color: var(--text-2);
  margin-bottom: 6px;
  font-weight: 600;
}
.tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  line-height: 1.7;
}
.tooltip-row i {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.tooltip-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
.tooltip-value {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  font-weight: 600;
}
.tooltip-more {
  margin-top: 4px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}
.chart-empty {
  padding: 56px 0;
  text-align: center;
  color: var(--text-3);
  font-size: var(--fs-sm);
}
</style>
