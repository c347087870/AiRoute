// 更新功能共享状态：侧边栏提示条与设置页「关于与更新」卡片使用同一份数据
import { ref } from 'vue'
import { checkUpdate, startUpdateDownload, getUpdateProgress } from '../api.js'
import { showToast } from './useToast.js'

const info = ref(null)         // 检查结果 { current, latest, hasUpdate, tag, notes, ... }
const checking = ref(false)    // 是否正在检查更新
const downloading = ref(false) // 是否正在下载新版本
const percent = ref(0)         // 下载进度百分比
const savedPath = ref('')      // 下载完成后的保存路径
const error = ref('')          // 最近一次手动检查的错误信息

let inited = false   // 启动初始化只执行一次
let pollTimer = null // 下载进度轮询定时器

// 检查更新：silent=true（启动自动检查）失败不打扰；手动检查成功/失败均有提示
async function runCheck(silent = false, force = false) {
  if (checking.value) return false
  checking.value = true
  error.value = ''
  try {
    info.value = await checkUpdate(force)
    if (!silent) {
      showToast(info.value.hasUpdate ? `发现新版本 v${info.value.latest}` : `已是最新版本 v${info.value.current}`)
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
        showToast('新版本已下载完成，可替换当前程序')
      } else if (state.status === 'error') {
        stopPoll()
        downloading.value = false
        showToast('下载失败: ' + (state.error || '未知错误'), 'error', 4000)
      }
    } catch {}
  }, 800)
}

// 开始下载：先弹“另存为”选保存路径，再请求服务端流式下载并轮询进度
async function startDownload() {
  if (!info.value?.hasUpdate || downloading.value) return
  let savePath = ''
  try {
    savePath = window.electronAPI ? await window.electronAPI.saveFileDialog(`AiRoute-v${info.value.latest}.exe`) : ''
  } catch {
    savePath = ''
  }
  if (!savePath) return // 用户取消保存
  savedPath.value = ''
  downloading.value = true
  percent.value = 0
  try {
    await startUpdateDownload(info.value.tag, savePath)
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
  return { info, checking, downloading, percent, savedPath, error, runCheck, startDownload, openFolder, openReleasePage, initUpdate }
}
