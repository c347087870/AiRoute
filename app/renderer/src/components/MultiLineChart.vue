<template>
  <div class="multi-chart">
    <div class="chart-head">
      <span class="chart-title">{{ title }}</span>
      <div class="legend">
        <span v-for="item in series" :key="item.key" class="legend-item">
          <i :style="{ background: item.color }"></i>{{ item.label }}
        </span>
      </div>
    </div>
    <div v-if="labels.length" class="chart-body">
      <svg viewBox="0 0 900 300" class="chart-svg" preserveAspectRatio="none" role="img" :aria-label="title">
        <g class="grid">
          <line v-for="i in 5" :key="i" x1="50" :y1="20 + (i - 1) * 58" x2="880" :y2="20 + (i - 1) * 58" />
        </g>
        <polyline
          v-for="item in series"
          :key="item.key"
          :points="pointsOf(item)"
          fill="none"
          :stroke="item.color"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <g class="axis">
          <text v-for="item in xLabels" :key="item.label" :x="item.x" y="282" text-anchor="middle">{{ item.label }}</text>
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
  labels: { type: Array, default: () => [] },
  series: { type: Array, default: () => [] }, // [{ key, label, color, values: [] }]
  formatValue: { type: Function, default: value => String(value ?? 0) },
})

const max = computed(() => {
  let maxValue = 1
  for (const item of props.series) {
    for (const value of item.values || []) {
      const number = Number(value)
      if (Number.isFinite(number)) maxValue = Math.max(maxValue, number)
    }
  }
  return maxValue
})

function xOf(index) {
  if (props.labels.length <= 1) return 465
  return 50 + (index / (props.labels.length - 1)) * 830
}

function yOf(value) {
  return 250 - (Number(value) || 0) / max.value * 230
}

function pointsOf(item) {
  return (item.values || []).map((value, index) => `${xOf(index)},${yOf(value)}`).join(' ')
}

const xLabels = computed(() => {
  const step = Math.max(1, Math.ceil(props.labels.length / 10))
  return props.labels
    .map((label, index) => ({ label, index }))
    .filter(item => item.index % step === 0 || item.index === props.labels.length - 1)
    .map(item => ({ label: item.label, x: xOf(item.index) }))
})
</script>

<style scoped>
.multi-chart {
  padding: 18px 20px 12px;
}
.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.chart-title {
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend-item i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.chart-body {
  height: 280px;
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
