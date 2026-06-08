<template>
  <div class="logs">
    <div class="page-header">
      <h1 class="page-title">日志查看</h1>
      <div class="header-actions">
        <select v-model="limit" @change="loadLogs" class="limit-select">
          <option :value="20">最近 20 条</option>
          <option :value="50">最近 50 条</option>
          <option :value="100">最近 100 条</option>
          <option :value="200">最近 200 条</option>
        </select>
        <button class="btn-ghost" @click="loadLogs">刷新</button>
      </div>
    </div>

    <div class="card">
      <table class="log-table" v-if="logs.length">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>状态</th>
            <th>耗时</th>
            <th>输入 Token</th>
            <th>输出 Token</th>
            <th>总计</th>
            <th>Fallback</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(log, i) in logs" :key="i">
            <td>{{ formatTime(log.timestamp) }}</td>
            <td>{{ log.model }}</td>
            <td>
              <span :class="log.status === 200 ? 'text-green' : 'text-red'">
                {{ log.status }}
              </span>
            </td>
            <td>{{ log.responseTime }}ms</td>
            <td class="token-cell text-blue">{{ formatNumber(log.inputTokens) }}</td>
            <td class="token-cell text-green">{{ formatNumber(log.outputTokens) }}</td>
            <td class="token-cell text-purple font-bold">{{ formatNumber(log.totalTokens) }}</td>
            <td>
              <span v-if="log.fallback" class="text-yellow">
                {{ log.fallbackFrom }} → {{ log.model }}
              </span>
              <span v-else>-</span>
            </td>
            <td class="error-cell">{{ log.error || '-' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无日志记录</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getLogs } from '../api.js'

const logs = ref([]) // 日志列表
const limit = ref(50) // 显示条数

// 格式化时间为 MM-DD HH:MM:SS
function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

// 格式化数字（添加千位分隔符）
function formatNumber(num) {
  if (!num && num !== 0) return '-'
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// 加载日志
async function loadLogs() {
  try {
    logs.value = await getLogs(limit.value)
  } catch {}
}

onMounted(loadLogs)
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: #1A1A1A;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.limit-select {
  background: #FFFFFF;
  border: 1px solid #E0E0E0;
  color: #1A1A1A;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
}

.log-table {
  width: 100%;
  border-collapse: collapse;
}

.log-table th,
.log-table td {
  text-align: left;
  padding: 10px 12px;
  font-size: 13px;
  border-bottom: 1px solid #F0F0F0;
  color: #1A1A1A;
}

.log-table th {
  color: #999999;
  font-weight: 500;
  position: sticky;
  top: 0;
  background: #FFFFFF;
}

.text-green {
  color: #00B578;
}

.text-red {
  color: #FF3B30;
}

.text-yellow {
  color: #FF9500;
  font-size: 12px;
}

.error-cell {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  text-align: center;
  color: #999999;
  padding: 40px;
  font-size: 14px;
}

.token-cell {
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.text-blue {
  color: #0082FC;
}

.text-green {
  color: #00B578;
}

.text-purple {
  color: #9C27B0;
}

.font-bold {
  font-weight: 600;
}
</style>
