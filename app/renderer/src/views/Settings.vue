<template>
  <div class="settings">
    <h1 class="page-title">设置</h1>

    <div class="section">
      <h2 class="section-title">Server 配置</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">监听端口</label>
          <div class="config-control">
            <input v-model.number="serverPort" type="number" class="port-input" />
            <button class="btn-primary" @click="saveServerPort">保存端口</button>
          </div>
        </div>
        <div v-if="portChanged" class="warning-box">
          ⚠ 端口已修改，请重启服务使新端口生效。
        </div>
        <div class="config-row">
          <label class="config-label">重启服务</label>
          <div class="config-control">
            <button class="btn-ghost" @click="doRestart" :disabled="restarting">
              {{ restarting ? '重启中...' : '重启 Server' }}
            </button>
          </div>
        </div>

      </div>
    </div>

    <div class="section">
      <h2 class="section-title">开机自启</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">开机自动启动 AiRoute</label>
          <div class="config-control">
            <button
              class="toggle-btn"
              :class="{ active: autoLaunch }"
              @click="toggleAutoLaunch"
            >
              {{ autoLaunch ? '已开启' : '已关闭' }}
            </button>
          </div>
        </div>
        <div class="config-hint">开启后系统启动时将自动打开 AiRoute 桌面客户端</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getServerConfig, updateServerConfig, restartServer, setServerPort as setApiPort } from '../api.js'

const serverPort = ref(3000)
const portChanged = ref(false)
const restarting = ref(false)
const autoLaunch = ref(false)

async function saveServerPort() {
  try {
    const result = await updateServerConfig({ port: serverPort.value })
    setApiPort(serverPort.value)
    portChanged.value = result.portChanged
  } catch {}
}

async function doRestart() {
  restarting.value = true
  try {
    await restartServer()
  } catch {}
  setTimeout(() => {
    restarting.value = false
  }, 3000)
}

async function toggleAutoLaunch() {
  if (!window.electronAPI) return
  const next = !autoLaunch.value
  await window.electronAPI.setAutoLaunch(next)
  autoLaunch.value = next
}

async function loadData() {
  try {
    const config = await getServerConfig()
    serverPort.value = config.port || 3000
  } catch {}

  if (window.electronAPI) {
    try {
      autoLaunch.value = await window.electronAPI.getAutoLaunch()
    } catch {}
  }
}

onMounted(loadData)
</script>

<style scoped>
.page-title {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 24px;
  color: #1A1A1A;
}

.section {
  margin-bottom: 28px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #1A1A1A;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid #F0F0F0;
}

.config-row:last-of-type {
  border-bottom: none;
}

.config-label {
  width: 200px;
  font-size: 14px;
  font-weight: 500;
  color: #1A1A1A;
  flex-shrink: 0;
}

.config-control {
  display: flex;
  gap: 8px;
  align-items: center;
}

.port-input {
  width: 120px;
}

.warning-box {
  background: #FFF7ED;
  border: 1px solid #FF9500;
  color: #B45309;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  margin: 8px 0;
}

.config-hint {
  font-size: 12px;
  color: #999999;
  padding: 4px 0 8px;
}

.toggle-btn {
  padding: 6px 20px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  background: #F0F0F0;
  color: #999999;
  border: 1px solid #E0E0E0;
  cursor: pointer;
  transition: all 0.2s;
}

.toggle-btn.active {
  background: #0082FC14;
  color: #0082FC;
  border-color: #0082FC;
}
</style>
