<template>
  <div class="usage-chart">
    <div class="chart-head">
      <span class="chart-title">{{ title }}</span>
      <span class="chart-latest">{{ label }} <strong>{{ formatValue(latest) }}</strong></span>
    </div>
    <div v-if="points.length" class="chart-body">
      <svg viewBox="0 0 800 240" class="chart-svg" preserveAspectRatio="none" role="img" :aria-label="title">
        <g class="grid">
          <line v-for="i in 5" :key="i" x1="42" :y1="20 + (i - 1) * 45" x2="788" :y2="20 + (i - 1) * 45" />
        </g>
        <polyline :points="polyline" fill="none" :stroke="color" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        <circle v-for="(point, index) in dots" :key="index" :cx="point.x" :cy="point.y" r="3" :fill="color" />
        <g class="axis">
          <text v-for="item in labels" :key="item.label" :x="item.x" y="226" text-anchor="middle">{{ item.label }}</text>
        </g>
      </svg>
    </div>
    <div v-else class="chart-empty">暂无数据</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  title: { type: String, default: '趋势' },
  label: { type: String, default: '当前周期' },
  color: { type: String, default: 'var(--accent)' },
  points: { type: Array, default: () => [] }, // [{ label, value }]
  formatValue: { type: Function, default: value => String(value ?? 0) },
})

const values = computed(() => props.points.map(point => Number(point.value) || 0))
const max = computed(() => Math.max(1, ...values.value))
const latest = computed(() => values.value.length ? values.value[values.value.length - 1] : 0)

function xOf(index) {
  if (props.points.length <= 1) return 420
  return 42 + (index / (props.points.length - 1)) * 746
}

function yOf(value) {
  return 200 - (Number(value) || 0) / max.value * 180
}

const polyline = computed(() => props.points.map((point, index) => `${xOf(index)},${yOf(point.value)}`).join(' '))
const dots = computed(() => props.points.map((point, index) => ({ x: xOf(index), y: yOf(point.value) })))
const labels = computed(() => {
  const step = Math.max(1, Math.ceil(props.points.length / 8))
  return props.points
    .map((point, index) => ({ label: point.label, index }))
    .filter(item => item.index % step === 0 || item.index === props.points.length - 1)
    .map(item => ({ label: item.label, x: xOf(item.index) }))
})
</script>

<style scoped>
.usage-chart {
  padding: 18px 20px 12px;
}
.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.chart-title {
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.chart-latest {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.chart-latest strong {
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.chart-body {
  height: 240px;
}
.chart-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.grid line {
  stroke: var(--border-1);
  stroke-dasharray: 4 4;
  stroke-width: 1;
}
.axis text {
  fill: var(--text-3);
  font-size: 11px;
}
.chart-empty {
  padding: 48px 0;
  text-align: center;
  color: var(--text-3);
  font-size: var(--fs-sm);
}
</style>
