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
          ⚠ 端口已保存，需要重启服务后生效。请点击下方「重启 Server」。
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
import { getServerConfig, updateServerConfig, restartServer, probeServer, setServerPort as setApiPort } from '../api.js'
import { showToast } from '../composables/useToast.js'

const serverPort = ref(3000) // 端口输入框的值
const portChanged = ref(false) // 端口已保存但尚未重启生效
const restarting = ref(false) // 是否正在重启服务
const autoLaunch = ref(false) // 开机自启开关状态

// 统一提取接口错误信息用于提示
function errorText(err) {
  return err?.response?.data?.error || err?.message || '无法连接服务'
}

// 等待指定毫秒
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 保存端口：只写配置，不切换前端 baseURL，避免服务还在旧端口时前端失联
async function saveServerPort() {
  const port = Number(serverPort.value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showToast('端口必须是 1-65535 的整数', 'error', 3000)
    return
  }
  try {
    const result = await updateServerConfig({ port })
    portChanged.value = result.portChanged
    if (result.portChanged) showToast('端口已保存，需要重启服务后生效', 'info', 4000)
    else showToast('端口已保存')
  } catch (err) {
    showToast('保存失败: ' + errorText(err), 'error', 4000)
  }
}

// 轮询探测目标端口，最多 10 次、每次间隔 1 秒
async function waitForPort(port) {
  for (let i = 0; i < 10; i++) {
    await delay(1000)
    if (await probeServer(port)) return true
  }
  return false
}

// 触发重启；服务端会关闭旧监听，连接被断开属于预期，只有服务端明确报错才抛出
async function triggerRestart() {
  try {
    await restartServer()
  } catch (err) {
    if (err?.response) throw err
  }
}

// 重启服务：按服务端配置里的端口探测，成功后才切换前端 baseURL
async function doRestart() {
  restarting.value = true
  try {
    const config = await getServerConfig()
    const targetPort = config.port || serverPort.value
    await triggerRestart()
    if (await waitForPort(targetPort)) {
      setApiPort(targetPort)
      serverPort.value = Number(targetPort)
      portChanged.value = false
      showToast('服务已重启，端口 ' + targetPort)
    } else {
      showToast('重启后未能连接端口 ' + targetPort + '，请手动检查服务状态', 'error', 4000)
    }
  } catch (err) {
    showToast('重启失败: ' + errorText(err), 'error', 4000)
  } finally {
    restarting.value = false
  }
}

// 切换开机自启
async function toggleAutoLaunch() {
  if (!window.electronAPI) return
  const next = !autoLaunch.value
  try {
    await window.electronAPI.setAutoLaunch(next)
    autoLaunch.value = next
    showToast(next ? '已开启开机自启' : '已关闭开机自启')
  } catch (err) {
    showToast('设置失败: ' + errorText(err), 'error', 4000)
  }
}

// 加载服务配置与开机自启状态
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
  color: var(--text-1);
}

.section {
  margin-bottom: 28px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-1);
}

.config-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-2);
}

.config-row:last-of-type {
  border-bottom: none;
}

.config-label {
  width: 200px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-1);
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
  border: 1px solid var(--warning);
  color: #B45309;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
  margin: 8px 0;
}

.config-hint {
  font-size: 12px;
  color: var(--text-3);
  padding: 4px 0 8px;
}

.toggle-btn {
  padding: 6px 20px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  background: var(--border-2);
  color: var(--text-3);
  border: 1px solid var(--border-3);
  cursor: pointer;
  transition: all 0.2s;
}

.toggle-btn.active {
  background: var(--primary-bg);
  color: var(--primary);
  border-color: var(--primary);
}
</style>
