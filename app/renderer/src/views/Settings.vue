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

    <div class="section">
      <h2 class="section-title">外观</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">主题</label>
          <div class="config-control">
            <button
              v-for="item in themeOptions"
              :key="item.value"
              class="theme-opt"
              :class="{ active: themeMode === item.value }"
              :aria-pressed="themeMode === item.value"
              @click="setMode(item.value)"
            >
              <span class="theme-opt-icon">{{ item.icon }}</span>{{ item.label }}
            </button>
          </div>
        </div>
        <div class="config-hint">选择「跟随系统」时，界面会随系统外观设置自动在亮色 / 暗色间切换</div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">系统状态</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">服务端</label>
          <div class="config-control">
            <span v-if="sysStatus" class="sys-value">运行中 · v{{ sysStatus.version }} · 端口 {{ sysStatus.port }}</span>
            <span v-else class="config-hint">未连接</span>
          </div>
        </div>
        <div class="config-row">
          <label class="config-label">内存占用</label>
          <div class="config-control">
            <span v-if="appMemory" class="sys-value">
              合计 {{ formatBytes(appMemory.total) }}（主进程 {{ formatBytes(appMemory.main) }} · 界面 {{ formatBytes(appMemory.renderer) }} · GPU {{ formatBytes(appMemory.gpu) }}）
            </span>
            <span v-else class="config-hint">—</span>
          </div>
        </div>
        <div class="config-row">
          <label class="config-label">缓存（日志）</label>
          <div class="config-control">
            <span v-if="cacheSize" class="sys-value">{{ formatBytes(cacheSize.totalSize) }} · {{ cacheSize.fileCount }} 个文件</span>
            <span v-else class="config-hint">—</span>
            <button class="btn-ghost btn-sm" :disabled="clearing" @click="clearLogCache">
              {{ clearing ? '清空中…' : '清空缓存' }}
            </button>
          </div>
        </div>
        <div class="config-hint">缓存为本地请求日志文件；清空后立即释放空间，日志页历史将一并清空</div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">关于与更新</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">当前版本</label>
          <div class="config-control">
            <span class="version-text">v{{ info?.current || '未检查' }}</span>
            <button class="btn-ghost btn-sm" :disabled="checking || busy" @click="runCheck(false, true)">
              {{ checking ? '检查中...' : '检查更新' }}
            </button>
          </div>
        </div>
        <div v-if="info" class="config-row">
          <label class="config-label">最新版本</label>
          <div class="config-control">
            <span class="version-text">v{{ info.latest }}</span>
            <span v-if="info.hasUpdate" class="update-tag">有新版本可用</span>
            <span v-else class="latest-tag">已是最新</span>
          </div>
        </div>
        <div v-if="supported && backup" class="config-row">
          <label class="config-label">版本回滚</label>
          <div class="config-control">
            <span class="version-text">已备份 v{{ backup.version }}</span>
            <button class="btn-ghost btn-sm" :disabled="busy" @click="rollback">回滚到该版本</button>
          </div>
        </div>
        <div v-if="error" class="warning-box">⚠ {{ error }}</div>
        <div v-if="lastResult && !lastResult.ok" class="warning-box">
          ⚠ 上次升级失败：{{ lastResult.error }}{{ lastResult.rolledBack ? '（已回滚到 v' + lastResult.from + '）' : '' }}
        </div>
        <div v-if="info && info.hasUpdate" class="update-block">
          <div v-if="info.publishedAt" class="config-hint">发布时间：{{ formatTime(info.publishedAt) }}</div>
          <div class="config-control">
            <button class="btn-primary" :disabled="busy || !supported" @click="oneClickUpdate">
              {{ primaryLabel }}
            </button>
            <button class="btn-ghost btn-sm" :disabled="busy" @click="manualDownload">手动下载安装包</button>
            <button v-if="savedPath" class="btn-ghost btn-sm" @click="openFolder">打开文件夹</button>
            <button class="btn-ghost btn-sm" @click="openReleasePage">Release 页面</button>
          </div>
          <div v-if="busy" class="progress-track">
            <div class="progress-fill" :style="{ width: (downloading ? percent : 100) + '%' }"></div>
          </div>
          <div v-if="stageText" class="config-hint">{{ stageText }}</div>
          <div v-if="installError" class="warning-box">
            ⚠ {{ installError }}{{ rolledBack ? '（已自动回滚到上一版本）' : '' }}
          </div>
          <div v-if="savedPath" class="config-hint">安装包已保存到：{{ savedPath }}（可双击手动安装）</div>
          <div v-if="!supported" class="config-hint">{{ unsupportedReason }}</div>
          <div class="config-hint">{{ installHint }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getServerConfig, updateServerConfig, restartServer, probeServer, setServerPort as setApiPort, getSystemStatus, getLogsSize, clearLogs } from '../api.js'
import { showToast } from '../composables/useToast.js'
import { formatBytes, formatTime } from '../utils/format.js'
import { useUpdate } from '../composables/useUpdate.js'
import { useTheme } from '../composables/useTheme.js'

// 主题（与侧边栏快捷切换共享同一份状态）
const { mode: themeMode, setMode } = useTheme()

const themeOptions = [
  { value: 'system', icon: '◐', label: '跟随系统' },
  { value: 'light', icon: '☀', label: '亮色' },
  { value: 'dark', icon: '☾', label: '暗色' }
]

const serverPort = ref(3000) // 端口输入框的值
const portChanged = ref(false) // 端口已保存但尚未重启生效
const restarting = ref(false) // 是否正在重启服务
const autoLaunch = ref(false) // 开机自启开关状态
const sysStatus = ref(null) // 系统状态：{ version, port }；null 表示服务端不可达
const appMemory = ref(null) // 应用内存占用（字节）：{ main, renderer, gpu, total }；浏览器模式为 null
const cacheSize = ref(null) // 日志缓存占用：{ totalSize, fileCount }
const clearing = ref(false) // 清空缓存进行中

// 更新功能共享状态与方法（与侧边栏提示条同源）
const {
  info, checking, stage, stageText, percent, error, installError, rolledBack, savedPath,
  downloading, busy, supported, unsupportedReason, backup, lastResult,
  runCheck, oneClickUpdate, manualDownload, rollback, openFolder, openReleasePage, refreshInstallStatus
} = useUpdate()

// 一键升级按钮文案：按阶段展示当前动作，失败后变成重试
const primaryLabel = computed(() => {
  switch (stage.value) {
    case 'downloading': return `下载中 ${percent.value}%`
    case 'verifying': return '校验安装包…'
    case 'backing-up': return '备份中…'
    case 'replacing': return '替换中…'
    case 'readback': return '回读校验…'
    case 'restarting': return '正在重启…'
    case 'error': return `重试升级到 v${info.value?.latest || ''}`
    default: return `一键升级到 v${info.value?.latest || ''}`
  }
})

// 安装方式提示：macOS 自动替换失败时才需要手动拖拽；Windows 仍为手动替换
const installHint = computed(() => info.value?.platform === 'mac'
  ? '一键升级会下载 → SHA-256 校验 → 备份 → 原子替换 → 回读校验 → 重启；任一步失败自动回滚'
  : '下载完成后请退出 AiRoute，用新文件替换当前的 AiRoute-*.exe（不会自动替换）')

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
      await loadSystemStatus() // 系统状态面板同步显示新端口
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
  let savedPort = null
  try {
    const config = await getServerConfig()
    savedPort = Number(config.port) || 3000
    serverPort.value = savedPort
  } catch {}

  if (window.electronAPI) {
    try {
      autoLaunch.value = await window.electronAPI.getAutoLaunch()
    } catch {}
  }

  // 「待重启」提示按实际状态推导：已保存端口 ≠ 实际监听端口 → 需重启生效。
  // 只靠保存接口的返回值记一次状态的话，离开页面再回来提示就丢了，
  // 而服务其实仍监听旧端口（用户会以为已经生效）
  await loadSystemStatus()
  portChanged.value = !!(savedPort && sysStatus.value && Number(sysStatus.value.port) !== savedPort)
}

// 加载系统状态：服务端版本/端口、应用内存、日志缓存占用；三项独立降级，互不阻塞
async function loadSystemStatus() {
  try {
    sysStatus.value = await getSystemStatus()
  } catch {
    sysStatus.value = null
  }
  if (window.electronAPI?.getAppMemory) {
    try {
      appMemory.value = await window.electronAPI.getAppMemory()
    } catch {}
  }
  try {
    cacheSize.value = await getLogsSize()
  } catch {}
}

// 清空日志缓存：二次确认后执行并刷新占用显示
async function clearLogCache() {
  if (!window.confirm('确定清空日志缓存吗？\n\n所有请求日志文件将被永久删除（不影响账号池与 Token 统计）。')) return
  clearing.value = true
  try {
    await clearLogs()
    showToast('缓存已清空')
    await loadSystemStatus()
  } catch (err) {
    showToast('清空失败: ' + errorText(err), 'error', 4000)
  } finally {
    clearing.value = false
  }
}

onMounted(() => {
  // loadData 内部已包含 loadSystemStatus（用于推导「待重启」提示），不再重复调用
  loadData()
  // 升级状态：可回滚备份 / 上次升级结果（主进程已在启动时初始化）
  refreshInstallStatus()
})
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
  background: var(--tint-warning);
  border: 1px solid var(--warning);
  color: var(--warning-text);
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

.sys-value {
  font-size: 13px;
  color: var(--text-2);
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

.version-text {
  font-size: 14px;
  color: var(--text-1);
  font-weight: 500;
}

.update-tag {
  font-size: 12px;
  color: var(--primary);
  background: var(--primary-bg);
  padding: 2px 10px;
  border-radius: 20px;
}

.latest-tag {
  font-size: 12px;
  color: var(--success);
  background: var(--tint-success);
  padding: 2px 10px;
  border-radius: 20px;
}

/* 主题三选一（跟随系统 / 亮色 / 暗色） */
.theme-opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  background: var(--bg-page);
  border: 1px solid var(--border-3);
  color: var(--text-2);
}

.theme-opt:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.theme-opt.active {
  background: var(--primary-bg);
  border-color: var(--primary);
  color: var(--primary);
  font-weight: 500;
}

.theme-opt-icon {
  font-size: 14px;
  line-height: 1;
}

.update-block {
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.progress-track {
  height: 6px;
  background: var(--border-2);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 3px;
  transition: width 0.3s;
}
</style>
