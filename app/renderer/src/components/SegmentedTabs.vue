<template>
  <div
    class="seg"
    :class="[`seg-${size}`, { 'seg-disabled': disabled }]"
    role="tablist"
    :aria-label="label || undefined"
    :aria-disabled="disabled || undefined"
  >
    <button
      v-for="(item, index) in items"
      :key="item.value"
      ref="buttons"
      type="button"
      class="seg-item"
      :class="{ active: item.value === modelValue }"
      role="tab"
      :aria-selected="item.value === modelValue"
      :tabindex="item.value === modelValue ? 0 : -1"
      :title="item.title || undefined"
      :disabled="disabled || item.disabled"
      @click="select(item.value)"
      @keydown="onKeydown($event, index)"
    >
      <span class="seg-label">{{ item.label }}</span>
      <!-- 计数之类的附加信息：有值才渲染，0 也要显示（「0 条」本身是信息） -->
      <span v-if="item.badge !== undefined && item.badge !== null && item.badge !== ''" class="seg-badge">
        {{ item.badge }}
      </span>
    </button>
  </div>
</template>

<script setup>
// 分段控件（segmented control）：同一区域里互斥的几个视图 / 取值范围。
//
// 为什么做成组件而不是各页面各写一套 <div class="tabs"><button>：
// 视图切换的键盘与语义（左右方向键、Home/End、roving tabindex、aria-selected）
// 容易漏写漏改，分散到各页面就是「有的页面能用方向键、有的不能」。
// 视觉上它也和 App.vue 的 .tab（药丸式页签 + 主色实心激活态）刻意区分：
// 分段控件只是一排文字，选中项给一层主色浅底，不画容器、不用实心，
// 主色实心留给单个强调动作。
//
// 选项可以是字符串数组，也可以是 { value, label, badge?, title?, disabled? }：
// 后者给「账号 12」这类带计数的场景用。

import { computed, ref } from 'vue'

const props = defineProps({
  modelValue: { type: String, required: true },
  // [{ value, label, badge?, title?, disabled? }] 或 ['a', 'b']
  options: { type: Array, required: true },
  // 给读屏用的名字（如「渠道账号视图切换」）；不传就不加 aria-label
  label: { type: String, default: '' },
  size: { type: String, default: 'md' }, // 'md' | 'sm'
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])

const buttons = ref([])

const items = computed(() => props.options.map(option =>
  typeof option === 'string' ? { value: option, label: option } : option))

function select(value) {
  if (props.disabled || value === props.modelValue) return
  emit('update:modelValue', value)
}

// 方向键 / Home / End 在选项间移动：这是 tablist 的标准键盘行为，
// 只有点击可用的话键盘用户得按 Tab 逐个试。选中即生效（不需要再按回车），
// 焦点跟着选中项走，否则焦点会停在旧的按钮上。
function onKeydown(event, index) {
  const total = items.value.length
  if (!total) return
  let next = -1
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + total) % total
  else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % total
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = total - 1
  if (next < 0) return
  event.preventDefault()
  const target = items.value[next]
  if (!target || target.disabled) return
  select(target.value)
  buttons.value[next]?.focus()
}
</script>

<style scoped>
/* 分段控件延续 shadcn 的 muted 槽底与轻量选中态，仍由原生按钮实现。 */
.seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--bg-hover);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.seg-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--btn-h);
  padding: 0 12px;
  font-size: var(--btn-fs);
  font-weight: 500;
  line-height: 1.5;
  color: var(--text-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s;
}

.seg-item:hover:not(.active):not(:disabled) {
  color: var(--text-1);
}

/* 选中项：走主色的浅底 + 主色文字（与侧边栏 .nav-item.active 同一套配对）。
   之前用的是中性浅底 + 正文色，深色模式下和页面底色只差一档，扫一眼分不出选了哪个；
   这里仍不用主色实心 —— 主实心留给「一键签到」这类动作按钮，
   分段控件的选中只是「你在看哪一档」。
   文字用 --primary-text 而不是 --primary：11px 小字压在 8% 浅底上，
   纯主色（#0082FC）对比度只有 3:1 上下，深一层的主色文字才够看 */
.seg-item.active {
  color: var(--text-1);
  background: var(--bg-card);
  border-color: var(--border-1);
  box-shadow: var(--shadow-card);
}

/* 键盘焦点单独画：:focus-visible 才画，鼠标点击不出现描边 */
.seg-item:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}

.seg-item:disabled {
  color: var(--text-4);
  cursor: default;
}

.seg-badge {
  padding: 0 6px;
  font-size: var(--fs-mini);
  font-weight: 400;
  color: var(--text-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-pill);
}

.seg-item.active .seg-badge {
  color: var(--primary-text);
  background: var(--primary-bg-hover);
}

/* 小号：给工具条里的次级切换用（与旁边的 btn-ghost btn-sm 同高、同字号）。
   竖直内边距补上原容器内边距 + 描边占掉的那几像素，否则会比旁边的按钮矮一头 */
.seg-sm .seg-item {
  height: 24px;
  padding: 0 10px;
  font-size: var(--fs-xs);
}

.seg-disabled .seg-item {
  cursor: default;
}
</style>
