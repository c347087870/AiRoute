// 更新功能共享状态：侧边栏提示条与设置页「关于与更新」卡片使用同一份数据
// 一键升级链路：服务端下载 + SHA-256 校验 → 主进程备份 / 原子替换 / 回读 / 重启
// 任一步失败由主进程自动回滚，渲染进程只负责串流程与展示阶段
import { ref, computed } from 'vue'
import { checkUpdate, startUpdateDownload, getUpdateProgress } from '../api.js'
import { showToast } from './useToast.js'

const info = ref(null)          // 检查结果 { current, latest, hasUpdate, tag, notes, ... }
const checking = ref(false)     // 是否正在检查更新
const stage = ref('idle')       // idle | downloading | verifying | backing-up | replacing | readback | restarting | error
const percent = ref(0)          // 下载进度百分比
const savedPath = ref('')       // 手动下载完成后的保存路径
const error = ref('')           // 最近一次手动检查的错误信息
const installError = ref('')    // 一键升级失败原因
const rolledBack = ref(false)   // 上次升级失败后是否已自动回滚
const supported = ref(false)    // 当前环境是否支持一键升级（主进程判定）
const unsupportedReason = ref('') // 不支持一键升级的原因（界面直接展示）
const backup = ref(null)        // 可回滚的备份 { version, path }
const lastResult = ref(null)    // 上次升级结果（启动时从主进程 journal 恢复）

// 各阶段的展示文案；下载阶段额外带百分比
const STAGE_TEXT = {
  verifying: '校验 SHA-256…',
  'backing-up': '备份当前版本…',
  replacing: '原子替换应用…',
  readback: '回读校验新版本…',
  restarting: '升级完成，正在重启…'
}

const downloading = computed(() => stage.value === 'downloading')
const installing = computed(() => ['verifying', 'backing-up', 'replacing', 'readback'].includes(stage.value))
const restarting = computed(() => stage.value === 'restarting')
const busy = computed(() => downloading.value || installing.value || restarting.value)

const stageText = computed(() => {
  if (stage.value === 'downloading') return `下载安装包 ${percent.value}%`
  return STAGE_TEXT[stage.value] || ''
})

let inited = false        // 启动初始化只执行一次
let notified = false      // 上次升级结果每次启动只提示一次
let pollTimer = null      // 下载 / 安装进度轮询定时器

// 平台判定：以服务端 /api/update/check 返回的 platform 为准——真正决定下载哪个资产的是服务端，
// 前端只按它决定扩展名与安装提示，避免两处各判一次
function isMacPlatform() {
  return info.value?.platform === 'mac'
}

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

// 停止进度轮询
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 记录一次失败：didRollback 表示主进程是否已经把旧版本换回去了
function failInstall(message, didRollback = false) {
  // 系统命令的 stderr 可能很长，界面只展示首行
  const text = String(message || '升级失败').split('\n')[0].slice(0, 200)
  stage.value = 'error'
  installError.value = text
  rolledBack.value = !!didRollback
  showToast(`升级失败：${text}${rolledBack.value ? '（已自动回滚到上一版本）' : ''}`, 'error', 6000)
}

// 轮询服务端下载进度：done 返回下载状态（含 artifactPath / sha256），error 返回 null
function pollDownload() {
  return new Promise(resolve => {
    stopPoll()
    pollTimer = setInterval(async () => {
      try {
        const state = await getUpdateProgress()
        percent.value = state.percent || 0
        if (state.stage === 'verifying') stage.value = 'verifying'
        if (state.status === 'done') {
          stopPoll()
          if (state.mode === 'manual') {
            resolve(state)
            return
          }
          if (!state.artifactPath || !state.sha256) {
            failInstall('服务端未返回安装包校验信息，请重试')
            resolve(null)
            return
          }
          resolve(state)
        } else if (state.status === 'error') {
          stopPoll()
          failInstall(state.error || '下载失败')
          resolve(null)
        }
      } catch {}
    }, 600)
  })
}

// 轮询主进程安装进度：restarting 表示成功（随后应用自动重启），error 表示已回滚 / 失败
function pollInstall() {
  return new Promise(resolve => {
    stopPoll()
    const startedAt = Date.now()
    pollTimer = setInterval(async () => {
      try {
        const status = await window.electronAPI.getInstallStatus()
        if (status.stage && status.stage !== 'idle') stage.value = status.stage
        if (status.stage === 'restarting') {
          stopPoll()
          showToast('升级完成，应用即将重启…')
          // 兜底：若主进程重启失败（例如被系统阻止），不要把界面永久锁在「正在重启」
          setTimeout(() => { if (stage.value === 'restarting') stage.value = 'idle' }, 5000)
          resolve(true)
          return
        }
        if (status.stage === 'error') {
          stopPoll()
          failInstall(status.error || '升级失败', status.rolledBack)
          resolve(false)
          return
        }
        if (Date.now() - startedAt > 5 * 60 * 1000) {
          stopPoll()
          failInstall('升级超时，请重试')
          resolve(false)
        }
      } catch {}
    }, 500)
  })
}

// 读取主进程的安装状态：是否支持一键升级、可回滚备份、上次升级结果
async function refreshInstallStatus() {
  if (!window.electronAPI?.getInstallStatus) {
    supported.value = false
    unsupportedReason.value = '浏览器模式不支持一键升级，请使用「手动下载安装包」'
    return null
  }
  try {
    const status = await window.electronAPI.getInstallStatus()
    supported.value = !!status.supported
    unsupportedReason.value = status.reason || ''
    backup.value = status.backup || null
    if (status.lastResult && !notified) {
      notified = true
      lastResult.value = status.lastResult
      const result = status.lastResult
      if (result.ok) {
        showToast(result.rolledBack ? `已回滚到 v${result.to}` : `已升级到 v${result.to}`)
      } else {
        showToast(`上次升级失败：${result.error}${result.rolledBack ? '（已回滚到 v' + result.from + '）' : ''}`, 'error', 6000)
      }
    }
    // 主进程已有进行中的阶段（例如刷新页面后重新进入）：同步展示并继续轮询
    if (['verifying', 'backing-up', 'replacing', 'readback'].includes(status.stage)) {
      stage.value = status.stage
      installError.value = status.error || ''
      rolledBack.value = !!status.rolledBack
      pollInstall()
    }
    return status
  } catch (e) {
    supported.value = false
    unsupportedReason.value = e?.message || '无法读取升级状态'
    return null
  }
}

// 一键升级：下载 → 校验 → 备份 → 替换 → 回读 → 重启（失败由主进程回滚）
async function oneClickUpdate() {
  if (busy.value) return false
  await refreshInstallStatus()
  // 刷新后可能发现主进程已有进行中的升级（例如从设置页再次点击），此时不能再起一个
  if (busy.value) {
    showToast('已有升级任务进行中，请稍候', 'error', 4000)
    return false
  }
  if (!supported.value) {
    showToast(unsupportedReason.value || '当前环境不支持一键升级，请手动下载安装包', 'error', 5000)
    return false
  }
  if (!info.value) {
    const has = await runCheck(true, true)
    if (!has) {
      showToast('暂时无法检查更新，请稍后重试', 'error', 4000)
      return false
    }
  }
  if (!info.value?.hasUpdate) {
    showToast(`已是最新版本 v${info.value?.current || ''}`)
    return false
  }
  const target = `v${info.value.latest}`
  const confirmed = window.confirm(
    `一键升级到 ${target}：\n\n` +
    '自动下载 → SHA-256 校验 → 备份当前版本 → 原子替换 → 回读校验 → 重启应用。\n' +
    '任一步失败会自动回滚到当前版本。升级期间请勿退出应用，进行中的请求会中断。\n\n继续？'
  )
  if (!confirmed) return false

  installError.value = ''
  rolledBack.value = false
  savedPath.value = ''
  stage.value = 'downloading'
  percent.value = 0
  try {
    await startUpdateDownload(info.value.tag)
  } catch (e) {
    failInstall(e?.response?.data?.error || e?.message || '下载失败')
    return false
  }

  const download = await pollDownload()
  if (!download) return false

  stage.value = 'verifying'
  try {
    await window.electronAPI.installUpdate({
      tag: info.value.tag,
      version: info.value.latest,
      artifactPath: download.artifactPath,
      sha256: download.sha256
    })
  } catch (e) {
    failInstall(e?.message || '无法开始安装')
    return false
  }
  return pollInstall()
}

// 手动下载安装包（Windows / 一键升级不可用或失败时的兜底）：另存为后由用户手动安装
async function manualDownload() {
  if (busy.value) return false
  if (!info.value?.hasUpdate) {
    const has = await runCheck(false, true)
    if (!has) return false
  }
  const ext = isMacPlatform() ? 'dmg' : 'exe'
  let savePath = ''
  try {
    // 服务端已按平台/架构解析出实际资产名，优先用它，保证另存为的默认文件名与 Release 一致
    const defaultName = info.value.assetName || `AiRoute-v${info.value.latest}.${ext}`
    savePath = window.electronAPI ? await window.electronAPI.saveFileDialog(defaultName) : ''
  } catch {
    savePath = ''
  }
  if (!savePath) return false // 用户取消保存
  savedPath.value = ''
  stage.value = 'downloading'
  percent.value = 0
  try {
    await startUpdateDownload(info.value.tag, savePath)
  } catch (e) {
    failInstall(e?.response?.data?.error || e?.message || '下载失败')
    return false
  }
  const state = await pollDownload()
  if (!state) return false
  savedPath.value = state.savePath || savePath
  stage.value = 'idle'
  showToast(isMacPlatform() ? '安装包已下载完成，可双击 dmg 手动安装' : '安装包已下载完成，可退出 AiRoute 后替换程序')
  return true
}

// 回滚到上一版本（新版本启动异常时的人工兜底）
async function rollback() {
  if (busy.value) return false
  if (!window.electronAPI?.rollbackUpdate || !backup.value) {
    showToast('没有可回滚的备份', 'error', 4000)
    return false
  }
  if (!window.confirm(`回滚到 v${backup.value.version}？应用将重启。`)) return false
  try {
    await window.electronAPI.rollbackUpdate()
    stage.value = 'verifying'
    return pollInstall()
  } catch (e) {
    failInstall(e?.message || '回滚失败')
    return false
  }
}

// 同步服务端已有下载状态（页面刷新/应用重启后恢复展示）
async function syncDownloadState() {
  try {
    const state = await getUpdateProgress()
    if (state.status === 'downloading') {
      stage.value = 'downloading'
      percent.value = state.percent || 0
      pollDownload()
    } else if (state.mode === 'manual' && state.status === 'done' && state.savePath) {
      savedPath.value = state.savePath
    }
  } catch {}
}

// 打开已下载文件所在文件夹并选中文件（手动下载兜底）
function openFolder() {
  if (savedPath.value && window.electronAPI) window.electronAPI.showItemInFolder(savedPath.value)
}

// 用系统浏览器打开 Release 页面
function openReleasePage() {
  if (info.value?.pageUrl && window.electronAPI) window.electronAPI.openExternal(info.value.pageUrl)
}

// 应用启动初始化：同步升级状态 + 下载状态 + 5 秒后静默检查一次（全局只执行一次）
function initUpdate() {
  if (inited) return
  inited = true
  refreshInstallStatus()
  syncDownloadState()
  setTimeout(() => {
    if (!info.value) runCheck(true)
  }, 5000)
}

export function useUpdate() {
  return {
    info,
    checking,
    stage,
    stageText,
    percent,
    error,
    installError,
    rolledBack,
    savedPath,
    downloading,
    installing,
    restarting,
    busy,
    supported,
    unsupportedReason,
    backup,
    lastResult,
    runCheck,
    oneClickUpdate,
    manualDownload,
    rollback,
    openFolder,
    openReleasePage,
    initUpdate,
    refreshInstallStatus,
    isMacPlatform
  }
}
