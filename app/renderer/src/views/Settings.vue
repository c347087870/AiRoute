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
        <div class="config-hint">
          {{ isMac ? '开启后登录 macOS 时自动在后台启动，菜单栏会显示 AiRoute 图标' : '开启后系统启动时将自动打开 AiRoute 桌面客户端' }}
        </div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">外观与个性化</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">应用背景</label>
          <div class="config-control">
            <button class="btn-primary" :disabled="bgBusy || !appearanceSupported" @click="pickBackground">
              {{ bgBusy ? '选择中…' : (appearance.image ? '更换背景图片' : '选择背景图片') }}
            </button>
            <button v-if="appearance.image" class="btn-ghost btn-sm" :disabled="bgBusy || !appearanceSupported" @click="removeBackground">
              恢复默认背景
            </button>
            <span v-if="appearance.image" class="bg-name" :title="appearance.settings.imageName">
              {{ appearance.settings.imageName }}
            </span>
          </div>
        </div>
        <div class="config-hint">
          支持 PNG / JPG / WebP / GIF / AVIF / BMP，单张不超过 20MB。图片会复制到应用数据目录，原文件移动或删除不影响显示。
          <template v-if="!appearanceSupported">当前为浏览器模式，更换背景仅在桌面客户端可用。</template>
        </div>

        <template v-if="appearance.image">
          <div class="config-row">
            <label class="config-label">启用自定义背景</label>
            <div class="config-control">
              <button
                class="toggle-btn"
                :class="{ active: appearance.settings.enabled }"
                @click="toggleBg"
              >{{ appearance.settings.enabled ? '已开启' : '已关闭' }}</button>
            </div>
          </div>

          <div class="config-row">
            <label class="config-label">图片填充方式</label>
            <div class="config-control">
              <select :value="appearance.settings.fit" class="fit-select" @change="onFitChange">
                <option value="cover">铺满（裁切边缘）</option>
                <option value="contain">完整显示（留白）</option>
                <option value="stretch">拉伸铺满</option>
                <option value="tile">平铺</option>
              </select>
            </div>
          </div>

          <div class="config-row">
            <label class="config-label">背景透明度</label>
            <div class="config-control slider-control">
              <input
                type="range" min="0" max="100" step="1"
                :value="appearance.settings.imageOpacity"
                @input="onSlider('imageOpacity', $event)"
              />
              <span class="slider-value">{{ appearance.settings.imageOpacity }}%</span>
            </div>
          </div>

          <div class="config-row">
            <label class="config-label">背景模糊</label>
            <div class="config-control slider-control">
              <input
                type="range" min="0" max="30" step="1"
                :value="appearance.settings.blur"
                @input="onSlider('blur', $event)"
              />
              <span class="slider-value">{{ appearance.settings.blur }} px</span>
            </div>
          </div>

          <div class="config-row">
            <label class="config-label">背景淡化</label>
            <div class="config-control slider-control">
              <input
                type="range" min="0" max="100" step="1"
                :value="appearance.settings.dim"
                @input="onSlider('dim', $event)"
              />
              <span class="slider-value">{{ appearance.settings.dim }}%</span>
            </div>
          </div>

          <div class="config-row">
            <label class="config-label">卡片不透明度</label>
            <div class="config-control slider-control">
              <input
                type="range" min="0" max="100" step="1"
                :value="appearance.settings.surfaceOpacity"
                @input="onSlider('surfaceOpacity', $event)"
              />
              <span class="slider-value">{{ appearance.settings.surfaceOpacity }}%</span>
            </div>
          </div>
        </template>

        <div class="config-row">
          <label class="config-label">主题色</label>
          <div class="config-control accent-row">
            <button
              v-for="item in appearanceAccents"
              :key="item.key"
              class="accent-dot"
              :class="{ active: appearance.settings.accent === item.key }"
              :style="{ background: item.color }"
              :title="accentLabel(item.key)"
              @click="setAccent(item.key)"
            ></button>
            <span class="slider-value">{{ accentLabel(appearance.settings.accent) }}</span>
          </div>
        </div>
        <div class="config-hint">主题色会应用到按钮、选中态与侧栏高亮，默认是 macOS 系统蓝。</div>
        <div class="config-hint">
          背景透明度：0% 时背景完全不可见，100% 时图片最实。背景淡化：往图片上盖一层白色，数值越高图越淡、文字越清楚；
          深色图片会自动提高淡化值，避免出现灰底灰字。卡片不透明度：控制卡片、侧栏与控件的通透程度，0% 时最透，背景图会从整块界面透出来。
        </div>
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
        <div class="config-row">
          <label class="config-label">数据目录</label>
          <div class="config-control">
            <span class="sys-value data-path" :title="dataDir">{{ dataDir || '—' }}</span>
            <button v-if="dataDir" class="btn-ghost btn-sm" @click="openDataDir">{{ isMac ? '在 Finder 中打开' : '打开文件夹' }}</button>
          </div>
        </div>
        <div class="config-hint">模型、账号凭据、日志与统计数据都保存在此目录，备份或迁移时复制整个目录即可</div>
      </div>
    </div>

    <div class="section">
      <h2 class="section-title">关于与更新</h2>
      <div class="card">
        <div class="config-row">
          <label class="config-label">当前版本</label>
          <div class="config-control">
            <span class="version-text">v{{ info?.current || '未检查' }}</span>
            <button class="btn-ghost btn-sm" :disabled="checking" @click="runCheck(false, true)">
              {{ checking ? '检查中...' : '检查更新' }}
            </button>
          </div>
        </div>
        <div v-if="info" class="config-row">
          <label class="config-label">最新版本</label>
          <div class="config-control">
            <span class="version-text">v{{ info.latest }}</span>
            <span v-if="info.hasUpdate && isLocalBuild()" class="local-tag">本地构建</span>
            <span v-else-if="info.hasUpdate" class="update-tag">有新版本可用</span>
            <span v-else class="latest-tag">已是最新</span>
          </div>
        </div>
        <div v-if="error" class="warning-box">⚠ {{ error }}</div>

        <!-- 本地构建：版本就在本机，直接替换安装，不走下载 -->
        <div v-if="info && info.hasUpdate && isLocalBuild()" class="update-block">
          <div v-if="info.localBuild?.builtAt" class="config-hint">构建时间：{{ formatTime(info.localBuild.builtAt) }}</div>
          <div v-if="info.localBuild?.gitCommit" class="config-hint">
            提交：{{ info.localBuild.gitCommit }}
            <template v-if="info.localBuild.gitBranch"> · {{ info.localBuild.gitBranch }}</template>
            <template v-if="info.localBuild.gitDirty">（含未提交改动）</template>
          </div>
          <div class="config-control">
            <button class="btn-primary" :disabled="installing" @click="installLocal">
              {{ installing ? '正在安装…' : `安装并重启 v${info.latest}` }}
            </button>
          </div>
          <div class="config-hint">
            安装会退出应用、替换当前版本并自动重新打开，数据目录与账号池不受影响。
            该版本来自「开发者选项」的本地构建，不是 GitHub Release。
          </div>
        </div>

        <div v-else-if="info && info.hasUpdate" class="update-block">
          <div v-if="info.publishedAt" class="config-hint">发布时间：{{ formatTime(info.publishedAt) }}</div>
          <div class="config-control">
            <button v-if="!savedPath && canDownload()" class="btn-primary" :disabled="downloading" @click="startDownload">
              {{ downloading ? `下载中 ${percent}%` : `下载新版本 v${info.latest}` }}
            </button>
            <button v-else-if="savedPath" class="btn-primary" @click="openFolder">打开文件夹</button>
            <button class="btn-ghost" @click="openReleasePage">查看 Release 页面</button>
          </div>
          <div v-if="downloading" class="progress-track">
            <div class="progress-fill" :style="{ width: percent + '%' }"></div>
          </div>
          <div v-if="savedPath" class="config-hint">已保存到：{{ savedPath }}</div>
          <div v-if="!canDownload()" class="config-hint">当前平台暂未提供安装包下载，请前往 Release 页面查看</div>
          <div v-else-if="isMac" class="config-hint">下载完成后打开 dmg，把 AiRoute 拖入「应用程序」覆盖旧版本即可，数据目录不受影响</div>
          <div v-else class="config-hint">下载完成后请退出 AiRoute，用新文件替换当前 AiRoute.exe（不会自动替换）</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { getServerConfig, updateServerConfig, restartServer, probeServer, setServerPort as setApiPort, getSystemStatus, getLogsSize, clearLogs } from '../api.js'
import { showToast } from '../composables/useToast.js'
import { formatBytes, formatTime } from '../utils/format.js'
import { useUpdate } from '../composables/useUpdate.js'
import { useAppearance } from '../composables/useAppearance.js'

const serverPort = ref(3000) // 端口输入框的值
const portChanged = ref(false) // 端口已保存但尚未重启生效
const restarting = ref(false) // 是否正在重启服务
const autoLaunch = ref(false) // 开机自启开关状态
const sysStatus = ref(null) // 系统状态：{ version, port }；null 表示服务端不可达
const appMemory = ref(null) // 应用内存占用（字节）：{ main, renderer, gpu, total }；浏览器模式为 null
const cacheSize = ref(null) // 日志缓存占用：{ totalSize, fileCount }
const clearing = ref(false) // 清空缓存进行中
const isMac = window.electronAPI?.platform === 'darwin' // 是否运行在 macOS 打包客户端
const dataDir = ref('') // 打包版用户数据目录；浏览器开发模式为空

// 更新功能共享状态与方法（与侧边栏提示条同源）
const {
  info, checking, downloading, installing, percent, savedPath, error,
  canDownload, isLocalBuild, runCheck, startDownload, openFolder, openReleasePage, installLocalBuild
} = useUpdate()

// 个性化外观：背景图与主题色（数据存主进程 userData，渲染层只应用样式）
const {
  state: appearance, accentList: appearanceAccents, supported: appearanceSupported,
  chooseBackground, clearBackground, toggleBackground, setLocal: setAppearance,
  init: initAppearance
} = useAppearance()
const bgBusy = ref(false)

const ACCENT_LABELS = { blue: '系统蓝', purple: '紫罗兰', green: '森林绿', orange: '暖橙', pink: '玫瑰红' }
function accentLabel(key) {
  return ACCENT_LABELS[key] || key
}

async function pickBackground() {
  if (bgBusy.value) return
  bgBusy.value = true
  try {
    const result = await chooseBackground()
    if (result?.canceled) return
    if (!result?.ok) {
      showToast(result?.error || '设置背景失败', 'error', 5000)
      return
    }
    showToast('背景已更新')
  } catch (err) {
    showToast('设置背景失败: ' + errorText(err), 'error', 5000)
  } finally {
    bgBusy.value = false
  }
}

function removeBackground() {
  if (bgBusy.value) return
  if (!window.confirm('恢复默认背景？已复制的背景图片会从应用数据目录删除。')) return
  clearBackground()
  showToast('已恢复默认背景')
}

function toggleBg() {
  toggleBackground(!appearance.settings.enabled)
}

function onFitChange(event) {
  setAppearance({ fit: event.target.value })
}

// 滑块实时预览，落盘由 composable 合并防抖
function onSlider(key, event) {
  setAppearance({ [key]: Number(event.target.value) })
}

function setAccent(accent) {
  setAppearance({ accent })
}

// 本地构建安装：版本就在本机，先确认再交给主进程替换当前 .app
async function installLocal() {
  if (!isLocalBuild() || installing.value) return
  const oldVersion = info.value?.current
  const newVersion = info.value?.latest
  const confirmed = window.confirm(
    `将退出 AiRoute，把当前应用（v${oldVersion}）替换为本地构建 v${newVersion} 并重新打开。\n\n数据目录、账号池与配置都会保留。是否继续？`
  )
  if (!confirmed) return
  await installLocalBuild()
}

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
      // 打包客户端主进程需要同步端口：窗口地址与托盘查询都依赖它
      window.electronAPI?.notifyServerPortChanged?.(Number(targetPort))
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

// 在 Finder 中打开数据目录，便于备份与迁移
function openDataDir() {
  if (dataDir.value) window.electronAPI?.openPath?.(dataDir.value)
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
    try {
      dataDir.value = await window.electronAPI.getDataDir()
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
  // App.vue 已初始化过，这里重复调用会命中同一 promise，只为浏览器直接打开设置页时兜底
  initAppearance()
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

/* ==================== 外观与个性化 ==================== */

.bg-name {
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
}

.fit-select {
  min-width: 190px;
}

.slider-control {
  gap: 12px;
}

.slider-control input[type='range'] {
  width: 220px;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--primary);
}

.slider-control input[type='range']:focus {
  border: none;
  box-shadow: none;
}

.slider-value {
  min-width: 52px;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.accent-row {
  gap: 10px;
}

.accent-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  box-shadow: 0 0 0 1px var(--border-3);
  transition: transform 0.15s, box-shadow 0.15s;
}

.accent-dot:hover {
  transform: scale(1.12);
}

.accent-dot.active {
  box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 4px var(--text-3);
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

.sys-value {
  font-size: 13px;
  color: var(--text-2);
}

/* 数据目录可能很长，限制宽度并用省略号，悬停 title 查看完整路径 */
.data-path {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Menlo', monospace;
  font-size: 12px;
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

/* 本地构建标记：与远程更新区分开，用紫色避免误解为正式发布 */
.local-tag {
  font-size: 12px;
  color: var(--purple);
  background: rgba(175, 82, 222, 0.1);
  padding: 2px 10px;
  border-radius: 20px;
}

.latest-tag {
  font-size: 12px;
  color: var(--success);
  background: rgba(0, 181, 120, 0.08);
  padding: 2px 10px;
  border-radius: 20px;
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
