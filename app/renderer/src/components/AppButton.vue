<template>
  <button
    :type="type"
    class="app-btn"
    :class="[`app-btn-${variant}`, { 'app-btn-block': block, 'app-btn-icon': iconOnly }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    :title="title"
  >
    <!-- 载入态沿用原来的「文案换成进行中文案」写法，这里只加一个转圈，
         避免同一按钮在请求中被连点两次 -->
    <span v-if="loading" class="app-btn-spinner" aria-hidden="true"></span>
    <span v-if="icon" class="app-btn-glyph"><AppIcon :name="icon" /></span>
    <slot />
  </button>
</template>

<script setup>
import AppIcon from './AppIcon.vue'

// 全站按钮的唯一实现：尺寸与观感只在这里定义一次（高度见 App.vue 的 .app-btn）。
// 页面里不要再写裸 <button> + 自建样式，否则「有的按钮 28px、有的 40px」的老问题
// 会随新页面重新长出来。
//
// variant：primary（主操作，实心）/ secondary（默认，描边）/ ghost（无边框）/ danger（危险操作）
// iconOnly：只放图标的方形按钮（返回、关闭、复制），宽高与按钮等高
//
// 刻意不提供尺寸档位：全站按钮只有 28px 这一档（见 App.vue 的 --btn-h）。
defineProps({
  variant: {
    type: String,
    default: 'secondary',
    validator: v => ['primary', 'secondary', 'ghost', 'danger'].includes(v)
  },
  type: { type: String, default: 'button' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  // 图标名取自 icons.js；文字按钮可与图标并排
  icon: { type: String, default: '' },
  iconOnly: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
  title: { type: String, default: undefined }
})
</script>
