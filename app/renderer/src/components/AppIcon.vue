<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      v-for="(d, index) in paths"
      :key="index"
      :d="d"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup>
import { computed } from 'vue'

// 侧边栏图标：统一 20×20 线性图标，颜色跟随 currentColor，避免各系统字体对符号字形渲染不一致
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 17 }
})

const ICONS = {
  dashboard: [
    'M3 4.5A1.5 1.5 0 0 1 4.5 3h4A1.5 1.5 0 0 1 10 4.5v4A1.5 1.5 0 0 1 8.5 10h-4A1.5 1.5 0 0 1 3 8.5v-4Z',
    'M12 4.5A1.5 1.5 0 0 1 13.5 3h2A1.5 1.5 0 0 1 17 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 12 11.5v-7Z',
    'M3 13.5A1.5 1.5 0 0 1 4.5 12h4A1.5 1.5 0 0 1 10 13.5v2A1.5 1.5 0 0 1 8.5 17h-4A1.5 1.5 0 0 1 3 15.5v-2Z',
    'M12 15.5A1.5 1.5 0 0 1 13.5 14h2a1.5 1.5 0 0 1 1.5 1.5v.5a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-.5Z'
  ],
  routing: [
    'M4 5h4.5a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3H16',
    'M14 12.5 16.5 15 14 17.5',
    'M4 15h3',
    'M4 5v10'
  ],
  providers: [
    'M3.5 5.5 10 2.5l6.5 3L10 8.5l-6.5-3Z',
    'M3.5 10 10 13l6.5-3',
    'M3.5 14.5 10 17.5l6.5-3'
  ],
  pool: [
    'M7.2 9.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
    'M2.5 16.5c0-2.3 2.1-3.9 4.7-3.9s4.7 1.6 4.7 3.9',
    'M13.2 9.4a2.2 2.2 0 1 0 0-4.4',
    'M13.6 12.8c2.2.2 3.9 1.6 3.9 3.7'
  ],
  logs: [
    'M5 2.8h6.2L15.5 7v10.2H5V2.8Z',
    'M11 2.8V7h4.3',
    'M7.5 10.5h5.5',
    'M7.5 13.5h5.5'
  ],
  stats: [
    'M3 16.5h14',
    'M5.5 14V9.5',
    'M10 14V5.5',
    'M14.5 14v-3'
  ],
  benchmark: [
    'm10 2.8 2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8l5-.7L10 2.8Z'
  ],
  settings: [
    'M8.6 2.6h2.8l.4 2a5.7 5.7 0 0 1 1.5.9l1.9-.8 1.4 2.4-1.5 1.4a5.9 5.9 0 0 1 0 1.7l1.5 1.4-1.4 2.4-1.9-.8c-.45.37-.95.67-1.5.9l-.4 2H8.6l-.4-2a5.7 5.7 0 0 1-1.5-.9l-1.9.8-1.4-2.4 1.5-1.4a5.9 5.9 0 0 1 0-1.7L3.4 7.1l1.4-2.4 1.9.8c.45-.37.95-.67 1.5-.9l.4-2Z',
    'M10 12.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z'
  ],
  tutorial: [
    'M3 4.2c1.9-.7 4.1-.7 6 .4v12c-1.9-1.1-4.1-1.1-6-.4v-12Z',
    'M17 4.2c-1.9-.7-4.1-.7-6 .4v12c1.9-1.1 4.1-1.1 6-.4v-12Z'
  ],
  developer: [
    'M3.5 4.5h13A1.5 1.5 0 0 1 18 6v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14V6a1.5 1.5 0 0 1 1.5-1.5Z',
    'M5.6 8.4 7.6 10l-2 1.6',
    'M9.4 11.9h4.4'
  ]
}

const paths = computed(() => ICONS[props.name] || ICONS.dashboard)
</script>

<style scoped>
.app-icon {
  display: block;
  flex-shrink: 0;
}
</style>
