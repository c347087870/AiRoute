<template>
  <span class="anim-number" :class="{ 'is-changing': animating }">{{ text }}</span>
</template>

<script setup>
// 数值变化动画：数字从旧值滚动到新值。
//
// 为什么要它：状态面板每 5 秒轮询一次，数字原本是「啪」地跳变，
// 眼睛很难注意到刚才那一刻涨了多少。滚动过渡把「变化」本身变成可视信号。
//
// 约定：
// - 只动数字，标签/颜色/布局都不动，避免干扰阅读
// - 值没变时不启动动画（轮询多数时候是同值）
// - 尊重 prefers-reduced-motion：关掉动画直接跳到新值
// - 无效值（null / NaN）显示 '-'，不做动画

import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { formatNumber } from '../utils/format.js'

const props = defineProps({
  // 目标数值；null / undefined / 非数字表示「无值」
  value: { type: [Number, String], default: 0 },
  // 动画时长（毫秒）
  duration: { type: Number, default: 100 },
  // 自定义格式化：拿到插值中的数值，返回要显示的文本
  // 不传就用千位分隔（整数，插值期间四舍五入）
  format: { type: Function, default: null }
})

const shown = ref(toNumber(props.value))
const animating = ref(false)
let raf = 0

function toNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function hasValue(v) {
  return toNumber(v) !== null
}

const text = computed(() => {
  const target = toNumber(props.value)
  if (target === null) return '-'
  if (props.format) return props.format(shown.value)
  return formatNumber(Math.round(shown.value))
})

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3)
}

function stop() {
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
  animating.value = false
}

function animateTo(target) {
  stop()
  const from = shown.value
  if (from === target || props.duration <= 0 || prefersReducedMotion()) {
    shown.value = target
    return
  }
  const start = performance.now()
  animating.value = true
  const step = now => {
    const progress = Math.min(1, (now - start) / props.duration)
    shown.value = from + (target - from) * easeOutCubic(progress)
    if (progress < 1) {
      raf = requestAnimationFrame(step)
    } else {
      shown.value = target
      raf = 0
      animating.value = false
    }
  }
  raf = requestAnimationFrame(step)
}

watch(
  () => props.value,
  next => {
    const target = toNumber(next)
    if (target === null) {
      stop()
      shown.value = 0
      return
    }
    animateTo(target)
  }
)

onBeforeUnmount(stop)
</script>

<style scoped>
/* 变化中给一点主色，让「刚刚动了」这件事本身被看见；
   动画结束后回到原色，不留下痕迹 */
.anim-number.is-changing {
  color: var(--primary-text);
}
</style>
