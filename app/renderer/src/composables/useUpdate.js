// 更新功能共享状态：侧边栏提示条与设置页「关于与更新」卡片使用同一份数据
import { ref } from 'vue'
import { checkUpdate, startUpdateDownload, getUpdateProgress } from '../api.js'
import { showToast } from './useToast.js'

const info = ref(null)         // 检查结果 { current, latest, hasUpdate, tag, notes, source, ... }
const checking = ref(false)    // 是否正在检查更新
const downloading = ref(false) // 是否正在下载新版本
const installing = ref(false)  // 是否正在安装本地构建
const percent = ref(0)         // 下载进度百分比
const savedPath = ref('')      // 下载完成后的保存路径
const error = ref('')          // 最近一次手动检查的错误信息

// 本地构建（开发者选项产出）：版本号在本机 dev-build.json 中，安装走主进程 helper
function isLocalBuild() {
  return info.value?.source === 'local'
}

let inited = false   // 启动初始化只执行一次
let pollTimer = null // 下载进度轮询定时器

// 打包平台：macOS 下载 dmg，Windows 下载 exe（浏览器开发模式按 exe 处理）
const platform = window.electronAPI?.platform === 'darwin' ? 'darwin' : 'win32'
const assetExt = platform === 'darwin' ? 'dmg' : 'exe'

// 服务端没有为当前平台发布资产（例如 Release 只有 exe）时只能跳发布页
function canDownload() {
  return info.value?.canDownload !== false
}

// 检查更新：silent=true（启动自动检查）失败不打扰；手动检查成功/失败均有提示
async function runCheck(silent = false, force = false) {
  if (checking.value) return false
  checking.value = true
  error.value = ''
  try {
    info.value = await checkUpdate(force)
    if (!silent) {
      if (!info.value.hasUpdate) showToast(`已是最新版本 v${info.value.current}`)
      else if (info.value.source === 'local') showToast(`发现本地构建 v${info.value.latest}，可直接安装`)
      else showToast(`发现新版本 v${info.value.latest}`)
    }
    return info.value.hasUpdate
  } catch (e) {
    // 静默检查失败不打扰：不记录错误、不弹提示
    if (!silent) {
      error.value = e?.response?.data?.error || e?.message || '检查失败'
      showToast('检查更新失败: ' + error.value, 'error', 4000)
    }
    return false
  } finally {
    checking.value = false
  }
}

// 停止下载进度轮询
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 轮询下载进度：done/error 时停止轮询并更新对应状态
function startPoll() {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    try {
      const state = await getUpdateProgress()
      percent.value = state.percent || 0
      if (state.status === 'done') {
        stopPoll()
        downloading.value = false
        savedPath.value = state.savePath
        showToast(platform === 'darwin' ? '新版本已下载完成，打开 dmg 拖入「应用程序」即可覆盖安装' : '新版本已下载完成，可替换当前程序')
      } else if (state.status === 'error') {
        stopPoll()
        downloading.value = false
        showToast('下载失败: ' + (state.error || '未知错误'), 'error', 4000)
      }
    } catch {}
  }, 800)
}

// 安装本地构建：主进程会替换当前 .app 并重启，调用前必须由界面二次确认
async function installLocalBuild() {
  if (!isLocalBuild() || installing.value) return
  const devBuild = window.electronAPI?.devBuild
  if (!devBuild) {
    showToast('当前为浏览器模式，无法自动安装本地构建', 'error', 4000)
    return
  }
  installing.value = true
  try {
    const result = await devBuild.install()
    if (!result?.ok) {
      installing.value = false
      showToast(result?.error || '安装失败', 'error', 5000)
      return
    }
    showToast(`正在安装 v${result.version}，应用将自动重启`)
    // 主进程会在安装 helper 就绪后退出应用；这里保持 installing 状态避免重复点击
  } catch (e) {
    installing.value = false
    showToast('安装失败: ' + (e?.message || e), 'error', 5000)
  }
}

// 开始下载：先弹“另存为”选保存路径，再请求服务端流式下载并轮询进度
async function startDownload() {
  if (!info.value?.hasUpdate || downloading.value) return
  if (isLocalBuild()) {
    await installLocalBuild()
    return
  }
  if (!canDownload()) {
    openReleasePage()
    return
  }
  let savePath = ''
  try {
    savePath = window.electronAPI
      ? await window.electronAPI.saveFileDialog(`${info.value.assetName || `AiRoute-v${info.value.latest}.${assetExt}`}`)
      : ''
  } catch {
    savePath = ''
  }
  if (!savePath) return // 用户取消保存
  savedPath.value = ''
  downloading.value = true
  percent.value = 0
  try {
    await startUpdateDownload(info.value.tag, savePath, info.value.assetName || '')
  } catch (e) {
    downloading.value = false
    showToast('下载失败: ' + (e?.response?.data?.error || e?.message), 'error', 4000)
    return
  }
  startPoll()
}

// 同步服务端已有下载状态（页面刷新/应用重启后恢复展示）
async function syncDownloadState() {
  try {
    const state = await getUpdateProgress()
    if (state.status === 'downloading') {
      downloading.value = true
      percent.value = state.percent || 0
      startPoll()
    } else if (state.status === 'done' && state.savePath) {
      savedPath.value = state.savePath
    }
  } catch {}
}

// 打开已下载文件所在文件夹并选中文件
function openFolder() {
  if (savedPath.value && window.electronAPI) window.electronAPI.showItemInFolder(savedPath.value)
}

// 用系统浏览器打开 Release 页面
function openReleasePage() {
  if (info.value?.pageUrl && window.electronAPI) window.electronAPI.openExternal(info.value.pageUrl)
}

// 应用启动初始化：同步下载状态 + 5 秒后静默检查一次（全局只执行一次）
function initUpdate() {
  if (inited) return
  inited = true
  syncDownloadState()
  setTimeout(() => {
    if (!info.value) runCheck(true)
  }, 5000)
}

export function useUpdate() {
  return {
    info,
    checking,
    downloading,
    installing,
    percent,
    savedPath,
    error,
    platform,
    isLocalBuild,
    canDownload,
    runCheck,
    startDownload,
    installLocalBuild,
    openFolder,
    openReleasePage,
    initUpdate
  }
}
