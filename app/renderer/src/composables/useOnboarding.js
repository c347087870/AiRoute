// 启动引导的共享状态：首次启动自动拉起，任意页面都能重新打开
//
// 为什么不是「第一屏某个页面里的一段 HTML」：引导要横跨三个地方 ——
// 全屏浮层（本组合式函数驱动的 OnboardingGuide）、侧边栏的重新打开入口、
// 设置页的重播按钮。状态放在模块级 ref 里，三处读到的是同一份。
//
// 完成状态只存 localStorage，不落服务端：
//   · 它描述的是「这台机器上的界面是否已经介绍过」，不是账号或网关的事实；
//   · 重启服务、换端口、恢复配置备份都不该把引导再弹一遍。
// 存储值是版本号而不是布尔值：流程大改时提升 VERSION，老用户也会看到新的引导。
import { ref } from 'vue'

// 与 useTheme 同一个 key 前缀；改这里不需要动 index.html（首屏脚本不碰它）
const STORAGE_KEY = 'airoute-onboarding'
const VERSION = 1

// 「进入引导时把模型全部置为关闭」只应用一次。
// 引导可以从侧边栏随时重开，若每次重开都清空用户已启用的模型，配合第 2 步
// 「至少启用一个模型」的阻塞，重开一次就得从头重选一遍。
const MODEL_DEFAULTS_KEY = 'airoute-onboarding-model-defaults'

function modelDefaultsApplied() {
  try {
    return localStorage.getItem(MODEL_DEFAULTS_KEY) === '1'
  } catch {
    // 存储不可用：当成已应用。宁可保留用户已有配置，也不要反复清空
    return true
  }
}

function markModelDefaultsApplied() {
  try {
    localStorage.setItem(MODEL_DEFAULTS_KEY, '1')
  } catch {}
}

// 当前版本是否已经完成（或主动跳过）
function readDone() {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) >= VERSION
  } catch {
    // 存储不可用（隐私模式 / 磁盘满）：宁可每次都引导，也不要把用户卡在没介绍的界面上
    return false
  }
}

function writeDone() {
  try {
    localStorage.setItem(STORAGE_KEY, String(VERSION))
  } catch {}
}

// 浮层是否可见 / 当前停在第几步（由 OnboardingGuide 维护）
const open = ref(false)
const stepIndex = ref(0)

// 跳出引导去配置、配置完要接回来的那一步（没有则为空）。
// 引导的「添加模型来源 / 登录免费账号」会跳到别的页面，用户在那边配完之后
// 浮层应该自己接回下一步，而不是让他再从侧边栏点一次。
const resumeStep = ref(null)

// 本次会话是否已经自动拉起过一个引导：跨页面切走又切回来时不再拉第二次
let autoLaunched = false

// 首次启动自动打开。调用方（App.vue）在挂载时调一次即可
function launchIfFirstRun() {
  if (autoLaunched) return
  autoLaunched = true
  if (!readDone()) startOnboarding(0)
}

// 打开引导。fromStep 用于「设置页 -> 回顾某一步」之类的入口
function startOnboarding(fromStep = 0) {
  stepIndex.value = Math.max(0, fromStep | 0)
  open.value = true
}

function closeOnboarding() {
  open.value = false
}

// 引导走完：记下版本，下次启动不再自动弹
function finishOnboarding() {
  writeDone()
  open.value = false
}

// 主动跳过：与走完同等对待 —— 用户明确说了不需要，下次启动就别再拦一次
function skipOnboarding() {
  finishOnboarding()
}

// 让下一次启动重新出现引导（设置页的「重新观看」用）
function resetOnboarding() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
  autoLaunched = true // 重置后不要立刻自己弹出来，等用户点
}

// 记下「配完之后要接回第几步」。用户跳到别的页面配置时，引导先关掉，
// 配置完成的那一页调 resumeOnboarding() 把浮层接回来
function markResume(step) {
  resumeStep.value = step
}

// 接回引导：没有记过要接回就什么都不做，返回是否接回成功
function resumeOnboarding() {
  if (resumeStep.value === null) return false
  stepIndex.value = resumeStep.value
  resumeStep.value = null
  open.value = true
  return true
}

function isDone() {
  return readDone()
}

export function useOnboarding() {
  return {
    VERSION,
    open,
    stepIndex,
    isDone,
    launchIfFirstRun,
    startOnboarding,
    closeOnboarding,
    finishOnboarding,
    skipOnboarding,
    resetOnboarding,
    markResume,
    resumeOnboarding,
    modelDefaultsApplied,
    markModelDefaultsApplied
  }
}
