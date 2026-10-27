<template>
  <div class="settings">
    <div class="section">
      <h2 class="section-title">服务</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">监听端口</label>
          <div class="config-control">
            <input v-model.number="serverPort" type="number" class="port-input" />
            <AppButton variant="primary" @click="saveServerPort">保存端口</AppButton>
            <AppButton variant="secondary" @click="doRestart" :disabled="restarting">
              {{ restarting ? '重启中…' : '重启 Server' }}
            </AppButton>
          </div>
        </div>
        <div v-if="portChanged" class="warning-box">⚠ 端口已保存，重启 Server 后生效</div>
        <div class="config-row">
          <label class="config-label">开机自启</label>
          <div class="config-control">
            <!-- key 绑定实际状态：设置失败时 autoLaunch 不变，靠重建把选中态拨回原位 -->
            <SegmentedTabs
              :key="String(autoLaunch)"
              :model-value="autoLaunch ? 'on' : 'off'"
              :options="autoLaunchOptions"
              label="开机自启"
              size="sm"
              @update:model-value="onAutoLaunchChange"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">状态与缓存</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">服务端</label>
          <div class="config-control">
            <span v-if="sysStatus" class="sys-value">运行中</span>
            <span v-else class="config-hint inline">未连接</span>
          </div>
        </div>
        <div class="config-row">
          <label class="config-label">内存占用</label>
          <div class="config-control">
            <span v-if="appMemory" class="sys-value">
              {{ formatBytes(appMemory.total) }}
              <span class="sys-detail">
                主进程 {{ formatBytes(appMemory.main) }} · 界面 {{ formatBytes(appMemory.renderer) }} · GPU {{ formatBytes(appMemory.gpu) }}
              </span>
            </span>
            <span v-else class="config-hint inline">—</span>
          </div>
        </div>
        <div class="config-row">
          <label class="config-label">日志缓存</label>
          <div class="config-control">
            <span v-if="cacheSize" class="sys-value">{{ formatBytes(cacheSize.totalSize) }} · {{ cacheSize.fileCount }} 个文件</span>
            <span v-else class="config-hint inline">—</span>
            <AppButton variant="secondary" :disabled="clearing" @click="clearLogCache">
              {{ clearing ? '清空中…' : '清空' }}
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">配置同步</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">配置文件</label>
          <div class="config-control">
            <input
              ref="importInput"
              type="file"
              accept=".json,application/json"
              class="file-input"
              @change="onImportFile"
            />
            <AppButton variant="secondary" :disabled="importing" @click="importInput?.click()">
              {{ importing ? '导入中…' : '导入' }}
            </AppButton>
            <AppButton variant="secondary" :disabled="exporting" @click="exportConfigFile">
              {{ exporting ? '导出中…' : '导出' }}
            </AppButton>
            <AppButton variant="danger" :disabled="clearingConfig" @click="clearConfigFile">
              {{ clearingConfig ? '清空中…' : '清空配置' }}
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">关于与更新</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">版本</label>
          <div class="config-control">
            <span class="version-text">{{ currentVersion ? 'v' + currentVersion : '—' }}</span>
            <span class="badge" :class="releaseLine === 'beta' ? 'warn' : 'ok'">{{ releaseLine === 'beta' ? 'beta 线' : '正式线' }}</span>
            <span v-if="info" class="badge" :class="info.hasUpdate ? 'info' : 'ok'">
              {{ info.hasUpdate ? '可升级到 v' + info.latest : '已是最新' }}
            </span>
            <!-- 更新自动检测（useUpdate 每分钟轮询），这里只展示结果，不设手动检查按钮 -->
            <span v-if="checking" class="config-hint inline">检查更新中…</span>
          </div>
        </div>
        <div v-if="supported && backup" class="config-row">
          <label class="config-label">版本回滚</label>
          <div class="config-control">
            <span class="sys-value">已备份 v{{ backup.version }}</span>
            <AppButton variant="secondary" :disabled="busy" @click="rollback">回滚到该版本</AppButton>
          </div>
        </div>
        <div v-if="error" class="warning-box">⚠ {{ error }}</div>
        <div v-if="lastResult && !lastResult.ok" class="warning-box">
          ⚠ 上次升级失败：{{ lastResult.error }}{{ lastResult.rolledBack ? '（已回滚到 v' + lastResult.from + '）' : '' }}
        </div>
        <div v-if="info && info.hasUpdate" class="update-block">
          <div class="config-control">
            <AppButton variant="primary" :disabled="busy || !supported" @click="oneClickUpdate">
              {{ primaryLabel }}
            </AppButton>
            <AppButton variant="secondary" :disabled="busy" @click="manualDownload">手动下载</AppButton>
            <AppButton variant="secondary" v-if="savedPath" @click="openFolder">打开文件夹</AppButton>
            <AppButton variant="secondary" @click="openReleasePage">Release 页面</AppButton>
            <span v-if="info.publishedAt" class="config-hint inline">发布于 {{ formatTime(info.publishedAt) }}</span>
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
import { getServerConfig, updateServerConfig, restartServer, probeServer, setServerPort as setApiPort, getSystemStatus, getLogsSize, clearLogs, exportConfig, importConfig, clearConfig, getServerPort } from '../api.js'
import { showToast } from '../composables/useToast.js'
import { formatBytes, formatTime } from '../utils/format.js'
import { useUpdate } from '../composables/useUpdate.js'
import { useModel } from '../composables/useModel.js'

import AppButton from '../components/AppButton.vue'
import SegmentedTabs from '../components/SegmentedTabs.vue'
const serverPort = ref(3000) // 端口输入框的值
const portChanged = ref(false) // 端口已保存但尚未重启生效
const restarting = ref(false) // 是否正在重启服务
const autoLaunch = ref(false) // 开机自启开关状态
const sysStatus = ref(null) // 系统状态：{ version, port }；null 表示服务端不可达
const appMemory = ref(null) // 应用内存占用（字节）：{ main, renderer, gpu, total }；浏览器模式为 null
const cacheSize = ref(null) // 日志缓存占用：{ totalSize, fileCount }
const clearing = ref(false) // 清空缓存进行中
const exporting = ref(false) // 导出配置进行中
const importing = ref(false) // 导入配置进行中
const clearingConfig = ref(false) // 清空配置进行中
const importInput = ref(null) // 隐藏的文件选择框（菜单里点不到原生按钮样式）

// 导入后同步侧边栏与托盘的模型列表，避免还显示旧配置里的激活模型
const { loadModelData, notifyTray } = useModel()

// 更新功能共享状态与方法（与侧边栏提示条同源）
const {
  info, checking, stage, stageText, percent, error, installError, rolledBack, savedPath,
  downloading, busy, supported, unsupportedReason, backup, lastResult,
  oneClickUpdate, manualDownload, rollback, openFolder, openReleasePage, refreshInstallStatus,
  isMacPlatform, isWinInstaller
} = useUpdate()

// 本地版本号：优先取服务端 /api/system/status（打开页面就有，不依赖联网），
// 再退回更新检查结果。原来只读 info.current，检查更新没成功（离线 / 静默检查失败）时
// 这一行会渲染成「v未检查」—— 版本是本地事实，不该等一次网络往返才敢说
const currentVersion = computed(() => sysStatus.value?.version || info.value?.current || '')

// 更新线路：服务端是唯一判定方（server/update.js 的 releaseLine），这里只在它还没回话时
// 按同一套规则本地预判一次，避免徽标先闪「正式线」再变「beta 线」。
// 判据与 releaseLine 一致：只认 beta / rc / alpha / next / dev 这类试跑标识，
// v1.6.1-macos.1 这种制品标记仍算正式线
const BETA_MARKER = /-(alpha|beta|rc|next|dev)([.\-]|$)/i
const releaseLine = computed(() => info.value?.line || sysStatus.value?.line || (BETA_MARKER.test(currentVersion.value) ? 'beta' : 'stable'))

// 一键升级按钮文案：按阶段展示当前动作，失败后变成重试
const primaryLabel = computed(() => {
  switch (stage.value) {
    case 'downloading': return `下载中 ${percent.value}%`
    case 'verifying': return '校验安装包…'
    case 'backing-up': return '备份中…'
    case 'replacing': return '安装中…'
    case 'readback': return '回读校验…'
    case 'restarting': return '正在重启…'
    case 'error': return `重试升级到 v${info.value?.latest || ''}`
    default: return `一键升级到 v${info.value?.latest || ''}`
  }
})

// 安装方式提示：macOS 走原子替换 + 自动回滚；Windows 安装版走静默安装（无自动回滚）；
// Windows 便携版不支持一键升级，只能手动下载替换
const installHint = computed(() => {
  if (isMacPlatform()) return '一键升级会下载 → SHA-256 校验 → 备份 → 原子替换 → 回读校验 → 重启；任一步失败自动回滚'
  if (isWinInstaller()) return '一键升级会下载安装包 → SHA-256 校验 → 退出应用 → 静默安装 → 自动重启；安装失败会重新启动当前版本（无自动回滚）'
  return '便携版不支持一键升级：下载安装包后手动替换 exe。改用安装版（文件名带 -setup，便携版是 -portable）即可一键升级'
})

// 统一提取接口错误信息：axios 的网络层失败没有 response，原始文案只有 "Network Error"，
// 对用户没有任何指向性 —— 换成「连不上哪个端口」「服务端没有这个接口」这类可行动的提示
function errorText(err) {
  const data = err?.response?.data
  if (data && typeof data === 'object' && data.error) return data.error
  if (err?.response?.status === 404) return '服务端没有这个接口，重启 AiRoute 后再试'
  if (err?.response) return `服务端返回 ${err.response.status}`
  if (err?.code === 'ECONNABORTED') return `请求超时（端口 ${getServerPort()}）`
  return `连不上 AiRoute 服务（端口 ${getServerPort()}），先确认服务在运行`
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

// 开机自启：tab 分段控件的两个取值（「已开启 / 已关闭」互斥选择）
const autoLaunchOptions = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' }
]

// 切换开机自启；value 来自 SegmentedTabs 的 update:modelValue（'on' | 'off'）
async function onAutoLaunchChange(value) {
  if (!window.electronAPI) return
  const next = value === 'on'
  if (next === autoLaunch.value) return
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

// 导出文件名带本地时间，连续导出不会互相覆盖
function exportFileName() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `airoute-config-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`
}

// 走浏览器下载（Electron 渲染进程同样交给系统下载），不为一次性备份再加 IPC
function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // 立刻 revoke 有概率让下载拿不到内容，留一拍
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportConfigFile() {
  exporting.value = true
  try {
    const data = await exportConfig()
    downloadJson(exportFileName(), data)
    showToast('配置已导出（含账号凭据，注意保管）', 'info', 5000)
  } catch (err) {
    showToast('导出失败: ' + errorText(err), 'error', 4000)
  } finally {
    exporting.value = false
  }
}

// 确认框要说清覆盖范围：模型来源会被换掉，账号也会被替换
function describeImport(payload) {
  const providers = Object.keys(payload.config?.models || {}).length
  const rules = (payload.config?.rules?.rules?.length || 0) + (payload.config?.rules?.customRules?.length || 0)
  const workbuddy = Object.keys(payload.accounts?.workbuddy || {}).length
  const channels = Object.keys(payload.accounts?.channels || {}).length
  return '将覆盖现有配置：\n'
    + `· 模型来源 ${providers} 个\n`
    + `· 路由规则 ${rules} 条\n`
    + `· WorkBuddy 账号 ${workbuddy} 个 · 渠道数据 ${channels} 项\n\n`
    + '导入前会自动备份当前配置。继续吗？'
}

async function onImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = '' // 清掉选择，同一个文件也能再次选
  if (!file) return

  let payload
  try {
    payload = JSON.parse(await file.text())
  } catch {
    showToast('文件不是有效的 JSON', 'error', 4000)
    return
  }
  if (payload?.format !== 'airoute-config') {
    showToast('不是 AiRoute 配置文件', 'error', 4000)
    return
  }
  if (!window.confirm(describeImport(payload))) return

  importing.value = true
  try {
    await importConfig(payload)
    await loadData() // 端口变了会在卡片里显示待重启提示
    await loadModelData()
    notifyTray()
    showToast(
      portChanged.value ? '配置已导入，端口已变，重启 Server 后生效' : '配置已导入，账号与渠道已重新加载',
      'info', 6000
    )
  } catch (err) {
    showToast('导入失败: ' + errorText(err), 'error', 8000)
  } finally {
    importing.value = false
  }
}

async function clearConfigFile() {
  if (!window.confirm('将清空模型来源、路由规则与全部账号凭据。\n\n清空前会自动快照，可再导入回来。继续吗？')) return
  clearingConfig.value = true
  try {
    await clearConfig()
    await loadData()
    await loadModelData()
    notifyTray()
    showToast('配置已清空', 'info', 4000)
  } catch (err) {
    showToast('清空失败: ' + errorText(err), 'error', 8000)
  } finally {
    clearingConfig.value = false
  }
}

onMounted(() => {  // loadData 内部已包含 loadSystemStatus（用于推导「待重启」提示），不再重复调用
  loadData()
  // 升级状态：可回滚备份 / 上次升级结果（主进程已在启动时初始化）
  refreshInstallStatus()
})
</script>

<style scoped>
/* 设置页竖向密度：通用版式的卡片内边距 20px + 行内边距 10px，
   在这种一行一项的表单里会在卡片上下留出两指宽的空白。
   这里整体收一档：卡片只留 12px，行距 6px，末尾提示不再额外撑高 */
.settings .card {
  padding: 12px 20px;
}

.settings .config-row {
  padding: 6px 0;
  /* 每行高度统一：有按钮的行本来就高，纯文字行会被拉低，
     同一张卡片里几行错开看着不齐 */
  min-height: 40px;
}

.settings .config-hint {
  padding: 2px 0 0;
}

/* 标题与卡片之间同样收一档：分区标题下方的间距和卡片内边距叠加，
   在只有三四行的卡片上方显得格外空 */
.settings .section-title {
  margin-bottom: 8px;
}

.port-input {
  width: 120px;
}

.sys-value {
  font-size: var(--fs-small);
  color: var(--text-2);
}

/* 内存明细跟在总量后面，弱一档，避免一行里两段同等重量的数字 */
.sys-detail {
  margin-left: 6px;
  color: var(--text-3);
}

/* 行内说明：夹在控件中间时去掉 .config-hint 的纵向内边距 */
.config-hint.inline {
  padding: 0;
}

/* 导入用原生文件选择，触发按钮自己画 */
.file-input {
  display: none;
}

.version-text {
  font-size: var(--fs-base);
  color: var(--text-1);
  font-weight: 500;
}

.update-block {
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 更新区块里的提示都紧跟在按钮/进度条下面，交给 gap 控距 */
.update-block .config-hint {
  padding: 0;
}
</style>

