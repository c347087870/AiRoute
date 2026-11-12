<template>
  <div class="usage-page">
    <div class="usage-toolbar">
      <SegmentedTabs v-model="tab" :options="tabs" label="日志与用量视图" />
      <slot name="toolbar" />
    </div>

    <UsageOverview v-if="tab === 'overview'" />
    <TokenStats v-else-if="tab === 'stats'" />
    <Logs v-else />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SegmentedTabs from '../components/SegmentedTabs.vue'
import UsageOverview from './UsageOverview.vue'
import TokenStats from './TokenStats.vue'
import Logs from './Logs.vue'

const route = useRoute()
const router = useRouter()
const tabs = [
  { value: 'overview', label: '概览' },
  { value: 'stats', label: '用量统计' },
  { value: 'logs', label: '请求日志' },
]
const valid = new Set(tabs.map(item => item.value))
const tab = ref(valid.has(String(route.query.tab || '')) ? String(route.query.tab) : 'overview')

watch(tab, value => {
  router.replace({ path: '/usage', query: { tab: value } })
})
watch(() => route.query.tab, value => {
  const next = valid.has(String(value || '')) ? String(value) : 'overview'
  if (next !== tab.value) tab.value = next
})
</script>

<style scoped>
.usage-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
</style>
