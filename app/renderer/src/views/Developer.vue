<template>
  <div class="developer">
    <header class="page-head">
      <div class="page-head-text">
        <h1 class="page-title">开发者选项</h1>
        <p class="page-sub">在应用内修改代码、构建并覆盖安装，不用再打开 IDE。</p>
      </div>
      <button v-if="isElectron" class="btn-ghost btn-sm" :disabled="refreshing" @click="refresh">
        {{ refreshing ? '检测中…' : '重新检测' }}
      </button>
    </header>

    <!-- 浏览器打开开发页时没有 Electron IPC，明确降级，避免误以为功能损坏 -->
    <div v-if="!isElectron" class="card fallback-card">
      <div class="fallback-title">请使用桌面客户端</div>
      <p class="fallback-text">
        开发者选项依赖 Electron 主进程的内嵌终端与本地构建能力，浏览器模式无法使用。
        请启动 AiRoute 桌面客户端后从左侧导航进入本页。
      </p>
    </div>

    <template v-else>
      <!-- ==================== 环境检查 ==================== -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">环境检查</h2>
          <button class="btn-ghost btn-sm" :disabled="choosing || refreshing" @click="chooseProject">
            {{ choosing ? '选择中…' : '重新选择项目' }}
          </button>
        </div>

        <div class="card env-card">
          <div v-if="loading" class="env-loading">正在检测项目与工具链…</div>
          <template v-else-if="env">
            <div v-for="item in checks" :key="item.key" class="env-row">
              <span class="env-dot" :class="item.ok ? 'ok' : 'bad'"></span>
              <span class="env-label">{{ item.label }}</span>
              <span class="env-value" :class="{ mono: item.mono }" :title="item.value">{{ item.value }}</span>
              <span class="env-detail" :title="item.detail">{{ item.detail }}</span>
            </div>
            <div class="env-foot">
              终端与构建只通过本机 Electron IPC 提供，不会暴露到 HTTP 网关。
            </div>
          </template>
        </div>
      </section>

      <!-- ==================== 内嵌终端 ==================== -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">Claude Code 终端</h2>
          <span class="state-pill" :class="terminalStateClass">{{ terminalStateText }}</span>
        </div>

        <div class="card terminal-card">
          <div class="terminal-toolbar">
            <div class="mode-group">
              <button
                class="mode-btn"
                :class="{ active: terminalVariant === 'new' }"
                :disabled="terminalStarting"
                @click="startTerminal({ variant: 'new' })"
              >新会话</button>
              <button
                class="mode-btn"
                :class="{ active: terminalVariant === 'continue' }"
                :disabled="terminalStarting"
                @click="startTerminal({ variant: 'continue' })"
              >继续上次</button>
              <button
                class="mode-btn"
                :class="{ active: terminalVariant === 'resume' }"
                :disabled="terminalStarting"
                @click="startTerminal({ variant: 'resume' })"
              >恢复会话</button>
              <button
                class="mode-btn"
                :class="{ active: terminalVariant === 'shell' }"
                :disabled="terminalStarting"
                @click="startTerminal({ variant: 'shell' })"
              >Shell</button>
            </div>
            <div class="toolbar-actions">
              <button class="tool-btn" :disabled="terminalStarting || !terminalRunning" @click="restartTerminal">重启</button>
              <button class="tool-btn" @click="clearTerminal">清空</button>
            </div>
          </div>

          <div ref="terminalWrap" class="terminal-wrap" :style="terminalHeight ? { height: terminalHeight + 'px' } : null">
            <div ref="terminalHost" class="terminal-host"></div>
            <div v-if="terminalEmpty" class="terminal-empty">
              <template v-if="!env?.project?.canBuild">
                先选择一个 AiRoute 项目目录，终端会自动连接 Claude Code
              </template>
              <template v-else-if="!env?.claude?.path">
                未检测到 claude 命令，可先用 Shell 模式执行 npm install -g @anthropic-ai/claude-code
              </template>
              <template v-else-if="!env?.pty?.ok">
                node-pty 不可用：{{ env?.pty?.error || '未知错误' }}
              </template>
              <template v-else>终端未启动，可点击上方「新会话」</template>
            </div>
          </div>

          <!-- 拖拽条：上下拖动调整终端高度，双击恢复默认 -->
          <div
            class="terminal-resizer"
            :class="{ dragging: resizing }"
            role="separator"
            aria-orientation="horizontal"
            aria-label="拖动调整终端高度，双击恢复默认"
            tabindex="0"
            title="拖动调整终端高度，双击恢复默认"
            @pointerdown.prevent="onResizerDown"
            @keydown.up.prevent="nudgeTerminalHeight(-40)"
            @keydown.down.prevent="nudgeTerminalHeight(40)"
          >
            <span class="resizer-grip"></span>
          </div>

          <div class="terminal-foot">
            <span class="foot-path" :title="env?.project?.dir || ''">{{ env?.project?.dir || '未选择项目目录' }}</span>
            <span v-if="terminalExit" class="foot-exit">
              进程已退出{{ terminalExit.exitCode === undefined || terminalExit.exitCode === null ? '' : `（${terminalExit.exitCode}）` }}
            </span>
            <span v-else class="foot-hint">⌘K 清屏 · 终端在切换页面后保持运行</span>
          </div>
        </div>
      </section>

      <!-- ==================== 构建 ==================== -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">构建与安装</h2>
          <div class="section-actions">
            <button
              v-if="status.running"
              class="btn-ghost btn-sm"
              @click="cancelBuild"
            >取消构建</button>
            <button
              v-else
              class="btn-ghost btn-sm"
              :disabled="!canBuildNow || buildStarting"
              @click="startBuild(false)"
            >{{ buildStarting ? '启动中…' : '构建 dmg' }}</button>
            <button
              v-if="!status.running"
              class="btn-primary btn-sm"
              :disabled="!canBuildNow || !canAutoInstall || buildStarting || installing"
              @click="startBuild(true)"
            >构建并安装</button>
          </div>
        </div>

        <div class="card build-card">
          <div class="build-meta">
            <div class="meta-item">
              <span class="meta-label">当前版本</span>
              <span class="meta-value">v{{ env?.project?.version || '—' }}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">将构建</span>
              <span class="meta-value mono">{{ nextVersion ? 'v' + nextVersion : '—' }}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">产物目录</span>
              <span class="meta-value mono">app/dist-electron</span>
            </div>
          </div>

          <div class="build-hint">
            构建前会自动把项目版本号递增一个 patch；构建失败或取消时自动还原。
            首次构建时间较长，实时日志见下方。
          </div>

          <div class="log-head">
            <span class="log-title">构建日志</span>
            <span class="stage-text" :class="'stage-' + status.stage">{{ stageText }}</span>
            <button class="log-clear" :disabled="!logs.length" @click="clearLogs">清空日志</button>
          </div>

          <div ref="logHost" class="log-host" @scroll="onLogScroll">
            <div v-if="!logs.length" class="log-empty">等待构建…</div>
            <div
              v-for="(entry, index) in logs"
              :key="index"
              class="log-line"
              :class="{ stderr: entry.stream === 'stderr' }"
            >{{ entry.line }}</div>
          </div>

          <div v-if="buildResult" class="result-banner" :class="buildResult.ok ? 'ok' : 'bad'">
            <template v-if="buildResult.ok">
              构建成功 v{{ buildResult.version }}
              <span class="result-sub">{{ formatTime(buildResult.builtAt) }}</span>
            </template>
            <template v-else>{{ buildResult.error || '构建失败' }}</template>
          </div>
        </div>
      </section>

      <!-- ==================== 本地构建 / 安装 ==================== -->
      <section class="section">
        <div class="section-head">
          <h2 class="section-title">本地构建</h2>
          <span v-if="buildState" class="state-pill ok">可安装 v{{ buildState.version }}</span>
        </div>

        <div class="card local-card">
          <template v-if="buildState">
            <div class="local-meta">
              <div class="meta-item">
                <span class="meta-label">版本</span>
                <span class="meta-value">v{{ buildState.version }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">构建时间</span>
                <span class="meta-value">{{ formatTime(buildState.builtAt) }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">提交</span>
                <span class="meta-value mono">
                  {{ buildState.gitCommit || '—' }}
                  <template v-if="buildState.gitBranch"> · {{ buildState.gitBranch }}</template>
                  <template v-if="buildState.gitDirty">（含未提交改动）</template>
                </span>
              </div>
            </div>

            <div class="local-actions">
              <button
                class="btn-primary"
                :disabled="!installAvailable || installing"
                @click="installBuild()"
              >{{ installing ? '正在安装…' : '安装并重启' }}</button>
              <button class="btn-ghost" :disabled="!buildState.dmgPath" @click="revealDmg">在 Finder 中显示 dmg</button>
              <button class="btn-ghost" @click="openProject">打开项目目录</button>
            </div>

            <div class="local-hint">
              安装会退出当前应用、替换正在运行的 .app 并重新打开，数据目录与账号池不受影响。
              也可以在「设置 → 关于与更新 → 检查更新」中看到这个本地版本。
              <template v-if="!canAutoInstall">当前为开发模式，覆盖安装仅在打包后的应用中可用。</template>
            </div>
          </template>

          <div v-else class="local-empty">
            还没有本地构建记录。完成一次构建后，这里会显示版本、提交信息与安装入口。
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import { showToast } from '../composables/useToast.js'
import { formatTime } from '../utils/format.js'

// KeepAlive 需要组件名，切换页面时终端不被销毁
defineOptions({ name: 'DeveloperView' })

const isElectron = !!window.electronAPI
const devTerminal = window.electronAPI?.devTerminal
const devBuild = window.electronAPI?.devBuild

const env = ref(null)
const buildState = ref(null)
const status = ref({ running: false, stage: 'idle', version: '', lastResult: null })
const logs = ref([])
const loading = ref(true)
const refreshing = ref(false)
const choosing = ref(false)
const buildStarting = ref(false)
const installing = ref(false)
const pendingInstall = ref(false)
const buildResult = ref(null)
const logFollow = ref(true)
const logHost = ref(null)
const terminalHost = ref(null)
const terminalWrap = ref(null)

let term = null
let fitAddon = null
let resizeObserver = null
let resizeFrame = 0
let unsubscribers = []
let autoStarted = false

// 终端高度：0 表示未手动调整，交给 CSS clamp 跟随窗口；调整后按像素保存
const TERMINAL_HEIGHT_KEY = 'airoute-dev-terminal-height'
const TERMINAL_MIN_HEIGHT = 200
const terminalHeight = ref(0)
const resizing = ref(false)
let dragStartY = 0
let dragStartHeight = 0
let dragMoved = false
let lastResizerDown = 0

function maxTerminalHeight() {
  return Math.max(TERMINAL_MIN_HEIGHT, Math.round(window.innerHeight * 0.85))
}

function saveTerminalHeight() {
  try {
    if (terminalHeight.value) localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight.value))
    else localStorage.removeItem(TERMINAL_HEIGHT_KEY)
  } catch {}
}

function loadTerminalHeight() {
  try {
    const stored = Math.round(Number(localStorage.getItem(TERMINAL_HEIGHT_KEY)))
    if (Number.isFinite(stored) && stored >= TERMINAL_MIN_HEIGHT) {
      terminalHeight.value = Math.min(stored, maxTerminalHeight())
    }
  } catch {}
}

// 拖动时终端容器的尺寸变化会被 ResizeObserver 接到，自动重新 fit
function onResizeMove(event) {
  if (!resizing.value) return
  const delta = event.clientY - dragStartY
  // 只单击不拖动时保持自适应高度，不把 clamp 值固化成像素
  if (!dragMoved && Math.abs(delta) < 3) return
  dragMoved = true
  const next = dragStartHeight + delta
  terminalHeight.value = Math.min(maxTerminalHeight(), Math.max(TERMINAL_MIN_HEIGHT, Math.round(next)))
}

function stopResize() {
  if (!resizing.value) return
  resizing.value = false
  // 真正拖动过就不算双击；否则保留时间戳让下一次按下能触发双击复位
  if (dragMoved) lastResizerDown = 0
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  window.removeEventListener('pointercancel', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  saveTerminalHeight()
  fitTerminal()
}

function startResize(event) {
  if (!terminalWrap.value) return
  resizing.value = true
  dragMoved = false
  dragStartY = event.clientY
  dragStartHeight = terminalWrap.value.offsetHeight
  // 捕获指针：拖出窗口或划过终端时事件仍回到该元素，避免拖动中途丢失
  try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
  // 监听放在 window 上，鼠标移到控件外也继续跟手
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
  window.addEventListener('pointercancel', stopResize)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

// 指针捕获会让 dblclick 不可靠，这里用两次按下的间隔自行判定双击
function onResizerDown(event) {
  const now = Date.now()
  if (now - lastResizerDown < 320) {
    lastResizerDown = 0
    resetTerminalHeight()
    return
  }
  lastResizerDown = now
  startResize(event)
}

function nudgeTerminalHeight(delta) {
  const base = terminalHeight.value || terminalWrap.value?.offsetHeight || 0
  terminalHeight.value = Math.min(maxTerminalHeight(), Math.max(TERMINAL_MIN_HEIGHT, Math.round(base + delta)))
  saveTerminalHeight()
  // 高度是响应式设置，等 DOM 更新后 fit 才是新尺寸
  nextTick(fitTerminal)
}

// 双击恢复默认：清除手动高度，回到随窗口变化的 clamp 值
function resetTerminalHeight() {
  terminalHeight.value = 0
  saveTerminalHeight()
  nextTick(fitTerminal)
}

// 窗口变矮时，之前保存的高度可能超出可视范围
function onWindowResize() {
  if (!terminalHeight.value) return
  const max = maxTerminalHeight()
  if (terminalHeight.value > max) {
    terminalHeight.value = max
    saveTerminalHeight()
  }
}

// 在首次渲染前恢复上次拖动的高度，避免终端先按默认高度 fit 一次再跳变
loadTerminalHeight()

const terminalStarting = ref(false)
const terminalRunning = ref(false)
const terminalMode = ref('claude')
const terminalVariant = ref('new')
const terminalExit = ref(null)

const nextVersion = computed(() => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(env.value?.project?.version || '')
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : ''
})

// 构建只依赖项目与 Node 22；终端额外依赖 pty 与 claude，两者分开判断
const canBuildNow = computed(() => {
  const e = env.value
  return !!(e && e.project.valid && e.project.buildScript && e.project.nodeModules && e.node.build)
})

const canAutoInstall = computed(() => !!env.value?.install?.canInstall)

const installAvailable = computed(() => !!(canAutoInstall.value && buildState.value?.dmgPath))

const terminalEmpty = computed(() => !terminalRunning.value && !terminalStarting.value && !terminalExit.value)

const terminalStateText = computed(() => {
  if (terminalStarting.value) return '正在启动…'
  if (terminalRunning.value) return terminalMode.value === 'shell' ? 'Shell 运行中' : 'Claude Code 运行中'
  if (terminalExit.value) {
    const code = terminalExit.value.exitCode
    return code === undefined || code === null ? '进程已退出' : `已退出（${code}）`
  }
  return '未启动'
})

const terminalStateClass = computed(() => {
  if (terminalStarting.value) return 'warn'
  if (terminalRunning.value) return 'ok'
  if (terminalExit.value) return 'bad'
  return 'idle'
})

const STAGE_TEXT = {
  idle: '待构建',
  prepare: '准备中',
  build: '构建中',
  verify: '校验产物',
  done: '已完成',
  failed: '失败'
}
const stageText = computed(() => STAGE_TEXT[status.value?.stage] || '待构建')

const checks = computed(() => {
  const e = env.value
  if (!e) return []
  const projectOk = !!(e.project.valid && e.project.buildScript)
  return [
    {
      key: 'project',
      label: '项目目录',
      ok: projectOk,
      mono: true,
      value: e.project.dir || '未选择',
      detail: projectOk
        ? `v${e.project.version || '?'}${e.project.gitBranch ? ' · ' + e.project.gitBranch : ''}${e.project.nodeModules ? '' : ' · 缺少 node_modules'}`
        : e.project.error || '请选择 AiRoute 源码目录'
    },
    {
      key: 'node',
      label: 'Node.js（构建）',
      ok: !!e.node.build,
      value: e.node.build ? `v${e.node.build.version}` : '未检测到 22+',
      detail: e.node.build
        ? e.node.build.bin
        : '请安装 Node.js 22（nvm install 22）后再试'
    },
    {
      key: 'claude',
      label: 'Claude Code',
      ok: !!e.claude.path && !e.claude.error,
      value: e.claude.version || (e.claude.path ? '已安装' : '未找到'),
      detail: e.claude.path || e.claude.error || 'npm i -g @anthropic-ai/claude-code'
    },
    {
      key: 'git',
      label: 'Git',
      ok: !!e.git.path && !e.git.error,
      value: e.git.version || (e.git.path ? '已安装' : '未找到'),
      detail: e.git.path || e.git.error || '构建记录需要读取提交信息'
    },
    {
      key: 'xcode',
      label: 'Xcode 命令行工具',
      ok: !!e.xcode.ok,
      mono: true,
      value: e.xcode.ok ? e.xcode.version : '未安装',
      detail: e.xcode.ok ? '' : e.xcode.error || 'xcode-select --install'
    },
    {
      key: 'pty',
      label: '终端组件 node-pty',
      ok: !!e.pty.ok,
      value: e.pty.ok ? '可用' : '不可用',
      detail: e.pty.error || e.pty.helper || ''
    }
  ]
})

// 构建日志来自构建脚本，可能带 ANSI 颜色序列；<pre> 不解析颜色，直接剥离
function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

function appendLog(entry) {
  if (!entry) return
  const line = stripAnsi(entry.line)
  if (!line) return
  logs.value.push({ line, stream: entry.stream === 'stderr' ? 'stderr' : 'stdout' })
  if (logs.value.length > 1000) logs.value.splice(0, logs.value.length - 1000)
}

async function loadAll(notify = false) {
  if (!devBuild) return
  refreshing.value = true
  try {
    const result = await devBuild.check()
    env.value = result.env || env.value
    buildState.value = result.state || null
    status.value = result.status || status.value
    if (result.status?.lastResult) buildResult.value = result.status.lastResult
    // 只在用户没有主动清空时回放，避免「清空日志 → 重新检测」把旧日志又倒回来
    if (!logsCleared && !logs.value.length && Array.isArray(result.logs)) {
      for (const entry of result.logs.slice(-1000)) appendLog(entry)
    }
    if (notify) showToast('环境检测已刷新')
    return result
  } catch (err) {
    showToast('环境检测失败: ' + (err?.message || err), 'error', 5000)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function refresh() {
  return loadAll(true)
}

// ==================== 终端 ====================

function fitTerminal() {
  if (!term || !terminalHost.value) return
  try {
    fitAddon.fit()
    devTerminal?.resize({ cols: term.cols, rows: term.rows })
  } catch {}
}

function initTerminal() {
  if (!terminalHost.value || term) return
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    lineHeight: 1.25,
    scrollback: 6000,
    theme: {
      background: '#161618',
      foreground: '#E6E6E8',
      cursor: '#8AB4F8',
      cursorAccent: '#161618',
      selectionBackground: 'rgba(138, 180, 248, 0.30)',
      black: '#2C2C2E',
      red: '#FF6B60',
      green: '#4CD964',
      yellow: '#FFD60A',
      blue: '#64A8FF',
      magenta: '#D58BFF',
      cyan: '#63E6E2',
      white: '#E6E6E8',
      brightBlack: '#636366',
      brightRed: '#FF8A80',
      brightGreen: '#7BE88A',
      brightYellow: '#FFE066',
      brightBlue: '#8AB4F8',
      brightMagenta: '#E3B0FF',
      brightCyan: '#8CF0EC',
      brightWhite: '#FFFFFF'
    }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(terminalHost.value)
  fitTerminal()
  term.onData(data => devTerminal.write(data))
  term.onResize(size => devTerminal.resize(size))

  // ⌘K 清屏为终端惯例；xterm 默认不拦截，这里补上
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && event.metaKey && event.key.toLowerCase() === 'k') {
      term.clear()
      return false
    }
    return true
  })

  resizeObserver = new ResizeObserver(() => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      fitTerminal()
    })
  })
  resizeObserver.observe(terminalHost.value)

  if (devTerminal) {
    unsubscribers.push(devTerminal.onData(data => term?.write(data)))
    unsubscribers.push(devTerminal.onExit(info => {
      terminalRunning.value = false
      terminalStarting.value = false
      terminalExit.value = info || {}
      term?.write('\r\n\u001b[38;5;244m[进程已退出]\u001b[0m\r\n')
    }))
    unsubscribers.push(devTerminal.onState(state => {
      if (!state) return
      // 已经跑起来就不算「启动中」：主进程切换进程时可能先广播 starting:true，
      // 若无条件覆盖会让按钮一直 disabled（点不动）
      terminalRunning.value = !!state.running
      terminalStarting.value = !state.running && !!state.starting
      if (state.running) applyTerminalState(state)
    }))
  }
}

function applyTerminalState(state) {
  terminalMode.value = state.mode === 'shell' ? 'shell' : 'claude'
  terminalVariant.value = state.mode === 'shell'
    ? 'shell'
    : state.continueSession ? 'continue' : state.resume ? 'resume' : 'new'
}

async function startTerminal(opts = {}) {
  if (!devTerminal || terminalStarting.value) return
  if (!canBuildNow.value) {
    showToast('请先选择有效的 AiRoute 项目目录', 'error', 4000)
    return
  }
  if (!env.value?.pty?.ok) {
    showToast('node-pty 不可用：' + (env.value?.pty?.error || '未知错误'), 'error', 6000)
    return
  }
  const variant = opts.variant || terminalVariant.value
  const mode = variant === 'shell' ? 'shell' : 'claude'

  terminalStarting.value = true
  terminalExit.value = null
  term?.reset()
  await nextTick()
  fitTerminal()

  let result
  try {
    result = await devTerminal.start({
      mode,
      continueSession: variant === 'continue',
      resume: variant === 'resume',
      cols: term?.cols,
      rows: term?.rows
    })
  } catch (err) {
    result = { ok: false, error: err?.message || String(err) }
  }
  terminalStarting.value = false

  if (!result?.ok) {
    showToast(result?.error || '终端启动失败', 'error', 6000)
    return
  }
  terminalMode.value = mode
  terminalVariant.value = variant
  terminalRunning.value = true
  applyTerminalState(result)
  nextTick(() => term?.focus())
}

function restartTerminal() {
  if (!terminalRunning.value) {
    startTerminal({ variant: terminalVariant.value })
    return
  }
  startTerminal({ variant: terminalVariant.value })
}

function clearTerminal() {
  term?.reset()
  terminalExit.value = null
  nextTick(() => term?.focus())
}

// 终端只自动连接一次：选完项目 / 首次进入页面；之后用户自己决定会话方式
async function maybeAutoStart() {
  if (autoStarted || !devTerminal || !env.value) return
  autoStarted = true
  try {
    const current = await devTerminal.status()
    if (current?.running) {
      terminalRunning.value = true
      applyTerminalState(current)
      return
    }
  } catch {}
  const e = env.value
  if (!e.project.canBuild || !e.node.build || !e.pty.ok || !e.claude.path) return
  await startTerminal({ variant: 'new' })
}

// ==================== 项目 ====================

async function chooseProject() {
  if (!devBuild || choosing.value) return
  choosing.value = true
  try {
    const result = await devBuild.chooseProject()
    if (result?.canceled) return
    if (!result?.ok) {
      showToast(result?.error || '选择项目目录失败', 'error', 5000)
      return
    }
    env.value = result.env || env.value
    buildState.value = result.state || null
    showToast('项目目录已更新')

    // 终端 cwd 绑定在旧目录上，换项目后重启一个新会话
    try { await devTerminal.stop() } catch {}
    terminalRunning.value = false
    terminalExit.value = null
    terminalVariant.value = 'new'
    term?.reset()
    autoStarted = false
    await maybeAutoStart()
  } catch (err) {
    showToast('选择项目目录失败: ' + (err?.message || err), 'error', 5000)
  } finally {
    choosing.value = false
  }
}

function openProject() {
  devBuild?.openProject().then(result => {
    if (result && result.ok === false) showToast(result.error || '无法打开项目目录', 'error', 4000)
  })
}

// ==================== 构建 ====================

async function startBuild(installAfter = false) {
  if (!devBuild || status.value.running || buildStarting.value) return
  if (!canBuildNow.value) {
    showToast('环境未就绪：请确认已选择项目、安装依赖并具备 Node.js 22', 'error', 5000)
    return
  }
  if (installAfter) {
    if (!canAutoInstall.value) {
      showToast('当前环境不支持自动安装，请先构建 dmg 后手动安装', 'error', 5000)
      return
    }
    const confirmed = window.confirm(
      `构建完成后将退出 AiRoute，覆盖安装 v${nextVersion.value || '新版本'} 并自动重新打开。\n\n` +
      '构建期间请保持应用运行，是否继续？'
    )
    if (!confirmed) return
  }

  pendingInstall.value = installAfter
  logs.value = []
  logsCleared = false // 主进程在新构建开始时已清空自己的缓冲，这里解除本地的抑制
  buildResult.value = null
  buildStarting.value = true
  try {
    const result = await devBuild.start({ bump: true })
    if (!result?.ok) {
      pendingInstall.value = false
      showToast(result?.error || '无法启动构建', 'error', 6000)
      return
    }
    status.value = { ...status.value, running: true, stage: 'prepare', version: result.version }
    showToast(`开始构建 v${result.version}`)
  } catch (err) {
    pendingInstall.value = false
    showToast('启动构建失败: ' + (err?.message || err), 'error', 6000)
  } finally {
    buildStarting.value = false
  }
}

async function cancelBuild() {
  if (!devBuild) return
  const result = await devBuild.cancel()
  if (!result?.ok) showToast(result?.error || '取消失败', 'error', 4000)
}

// 用户手动清空后，重新检测/切回页面不再回放主进程缓冲，否则清空形同虚设
let logsCleared = false

function clearLogs() {
  logs.value = []
  logsCleared = true
  logFollow.value = true
}

function onLogScroll() {
  const el = logHost.value
  if (!el) return
  logFollow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

watch(() => logs.value.length, () => {
  if (!logFollow.value) return
  nextTick(() => {
    const el = logHost.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

// ==================== 安装 ====================

// skipConfirm：构建并安装流程在开始前已确认过一次，构建成功后直接进入安装，
// 避免用户连续点两次「继续」的打断感；手动点按钮时仍保留二次确认。
async function installBuild(skipConfirm = false) {
  if (!devBuild || installing.value) return
  if (!installAvailable.value) {
    showToast('没有可安装的本地构建，请先构建', 'error', 4000)
    return
  }
  if (!skipConfirm) {
    const confirmed = window.confirm(
      `将退出 AiRoute，把当前应用替换为本地构建 v${buildState.value.version} 并重新打开。\n\n` +
      '数据目录、账号池与配置都会保留。是否继续？'
    )
    if (!confirmed) return
  }

  installing.value = true
  try {
    const result = await devBuild.install()
    if (!result?.ok) {
      installing.value = false
      showToast(result?.error || '安装失败', 'error', 6000)
      return
    }
    showToast(`正在安装 v${result.version}，应用将自动重启`)
  } catch (err) {
    installing.value = false
    showToast('安装失败: ' + (err?.message || err), 'error', 6000)
  }
}

function revealDmg() {
  devBuild?.openDmg().then(result => {
    if (result && result.ok === false) showToast(result.error || '无法定位 dmg', 'error', 4000)
  })
}

// ==================== 生命周期 ====================

function bindBuildEvents() {
  if (!devBuild) return
  unsubscribers.push(devBuild.onLog(entry => appendLog(entry)))
  unsubscribers.push(devBuild.onStatus(next => {
    if (!next) return
    status.value = { ...status.value, ...next }
  }))
  unsubscribers.push(devBuild.onDone(result => {
    if (!result) return
    buildResult.value = result
    status.value = {
      ...status.value,
      running: false,
      stage: result.ok ? 'done' : 'failed',
      version: result.version || status.value.version
    }
    if (result.ok) {
      buildState.value = {
        version: result.version,
        dmgPath: result.dmgPath,
        appPath: result.appPath,
        projectDir: result.projectDir,
        builtAt: result.builtAt,
        gitCommit: result.gitCommit,
        gitBranch: result.gitBranch,
        gitDirty: result.gitDirty
      }
      if (env.value?.project) env.value.project.version = result.version
      showToast(`构建完成 v${result.version}`)
      if (pendingInstall.value) {
        pendingInstall.value = false
        installBuild(true)
      }
    } else {
      pendingInstall.value = false
      showToast(result.error || '构建失败', 'error', 6000)
    }
  }))
  unsubscribers.push(devBuild.onInstalling(() => {
    installing.value = true
  }))
}

onMounted(async () => {
  if (!isElectron) {
    loading.value = false
    return
  }
  initTerminal()
  bindBuildEvents()
  window.addEventListener('resize', onWindowResize)
  await loadAll()
  await maybeAutoStart()
})

// KeepAlive 切回时容器尺寸可能已变化，需要重新 fit 并把焦点还给终端
onActivated(() => {
  nextTick(() => {
    fitTerminal()
    if (terminalRunning.value) term?.focus()
  })
})

onBeforeUnmount(() => {
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  resizeFrame = 0
  stopResize()
  window.removeEventListener('resize', onWindowResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  for (const off of unsubscribers) {
    try { off() } catch {}
  }
  unsubscribers = []
  try { devTerminal?.stop() } catch {}
  term?.dispose()
  term = null
  fitAddon = null
})
</script>

<style scoped>
/* 与其它页面一致：宽度完全跟随窗口，拉宽拉窄都自适应。
   原先的 max-width: 1080px 是窗口放大后不再伸展的原因 */
.developer {
  width: 100%;
  max-width: none;
  min-width: 0;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.page-head-text {
  min-width: 0;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}

.page-sub {
  margin-top: 6px;
  font-size: var(--fs-small);
  color: var(--text-3);
}

.section {
  margin-bottom: 28px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  min-height: 26px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-1);
}

.section-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.fallback-card {
  padding: 28px;
}

.fallback-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.fallback-text {
  font-size: var(--fs-base);
  color: var(--text-2);
  line-height: 1.6;
}

/* ==================== 环境 ==================== */

.env-card {
  padding: 6px 20px 12px;
}

.env-loading {
  padding: 18px 0;
  font-size: var(--fs-base);
  color: var(--text-3);
}

.env-row {
  display: grid;
  grid-template-columns: 14px 132px minmax(0, 1fr) minmax(0, 1.1fr);
  align-items: center;
  gap: 10px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border-2);
  font-size: var(--fs-base);
}

.env-row:last-of-type {
  border-bottom: none;
}

.env-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  justify-self: center;
}

.env-dot.ok {
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(52, 199, 89, 0.14);
}

.env-dot.bad {
  background: var(--danger);
  box-shadow: 0 0 0 3px rgba(255, 59, 48, 0.12);
}

.env-label {
  color: var(--text-1);
  font-weight: 500;
}

.env-value,
.env-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-value {
  color: var(--text-2);
}

.env-detail {
  color: var(--text-3);
  font-size: var(--fs-small);
}

.env-foot {
  padding-top: 10px;
  font-size: var(--fs-xs);
  color: var(--text-4);
}

.mono {
  font-family: 'SF Mono', Menlo, Monaco, monospace;
  font-size: var(--fs-small);
}

/* ==================== 终端 ==================== */

.state-pill {
  font-size: var(--fs-xs);
  font-weight: 500;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
}

.state-pill.ok {
  color: #1F7A3D;
  background: rgba(52, 199, 89, 0.14);
}

.state-pill.bad {
  color: var(--danger);
  background: rgba(255, 59, 48, 0.10);
}

.state-pill.warn {
  color: #9A5B00;
  background: rgba(255, 159, 10, 0.14);
}

.state-pill.idle {
  color: var(--text-3);
  background: var(--bg-hover);
}

.terminal-card {
  padding: 0;
  overflow: hidden;
  background: #161618;
  border-color: rgba(0, 0, 0, 0.4);
}

.terminal-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  background: #232326;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.mode-group {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}

.mode-btn {
  padding: 4px 11px;
  border-radius: 6px;
  font-size: var(--fs-xs);
  color: #B9B9BE;
  background: transparent;
  white-space: nowrap;
}

.mode-btn:hover:not(:disabled) {
  color: #FFFFFF;
  background: rgba(255, 255, 255, 0.08);
}

.mode-btn.active {
  color: #FFFFFF;
  background: rgba(255, 255, 255, 0.16);
}

.mode-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.toolbar-actions {
  display: flex;
  gap: 4px;
}

.tool-btn {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: var(--fs-xs);
  color: #B9B9BE;
  background: transparent;
}

.tool-btn:hover:not(:disabled) {
  color: #FFFFFF;
  background: rgba(255, 255, 255, 0.08);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.terminal-wrap {
  position: relative;
  /* 高度随窗口变化：窗口拉大时终端同步变高，而不是固定 420px 留出大片空白。
     手动拖动后由内联 height 覆盖该值 */
  height: clamp(320px, 42vh, 760px);
}

.terminal-host {
  height: 100%;
  padding: 10px 12px 8px;
  background: #161618;
}

/* 可拖动的高度调节条：9px 命中区域，视觉上是一条分隔线 + 短握把 */
.terminal-resizer {
  height: 9px;
  position: relative;
  z-index: 2;
  cursor: row-resize;
  touch-action: none;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #161618;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  transition: background 0.15s;
}

.terminal-resizer:hover,
.terminal-resizer.dragging {
  background: #26262A;
}

.terminal-resizer:focus-visible {
  box-shadow: inset 0 0 0 1px var(--primary);
}

.resizer-grip {
  width: 46px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.18);
  transition: background 0.15s, width 0.15s;
}

.terminal-resizer:hover .resizer-grip,
.terminal-resizer:focus-visible .resizer-grip,
.terminal-resizer.dragging .resizer-grip {
  width: 72px;
  background: rgba(255, 255, 255, 0.42);
}

/* 拖动过程中不要让鼠标划过的内容触发 hover/选中 */
.terminal-resizer.dragging {
  cursor: row-resize;
}

.terminal-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 40px;
  text-align: center;
  color: #84848C;
  font-size: var(--fs-small);
  line-height: 1.7;
  pointer-events: none;
}

.terminal-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: #1C1C1F;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: var(--fs-mini);
  color: #77777E;
}

.foot-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', Menlo, Monaco, monospace;
}

.foot-hint {
  margin-left: auto;
  white-space: nowrap;
}

.foot-exit {
  margin-left: auto;
  color: #D08A82;
  white-space: nowrap;
}

/* ==================== 构建 ==================== */

.build-card {
  padding: 16px 20px 18px;
}

.build-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 34px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-2);
}

.meta-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-base);
  min-width: 0;
}

.meta-label {
  color: var(--text-3);
  font-size: var(--fs-small);
}

.meta-value {
  color: var(--text-1);
  font-weight: 500;
}

.build-hint {
  padding: 10px 0 12px;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.6;
}

.log-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.log-title {
  font-size: var(--fs-small);
  font-weight: 500;
  color: var(--text-2);
}

.stage-text {
  font-size: var(--fs-mini);
  color: var(--text-3);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
}

.stage-text.stage-build,
.stage-text.stage-prepare,
.stage-text.stage-verify {
  color: var(--primary);
  background: var(--primary-bg);
}

.stage-text.stage-done {
  color: #1F7A3D;
  background: rgba(52, 199, 89, 0.14);
}

.stage-text.stage-failed {
  color: var(--danger);
  background: rgba(255, 59, 48, 0.10);
}

.log-clear {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: var(--fs-mini);
  color: var(--text-3);
  background: transparent;
}

.log-clear:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--bg-hover);
}

.log-clear:disabled {
  opacity: 0.4;
  cursor: default;
}

.log-host {
  height: clamp(180px, 24vh, 420px);
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: #1B1B1D;
  color: #D5D5D9;
  font-family: 'SF Mono', Menlo, Monaco, monospace;
  font-size: 11.5px;
  line-height: 1.55;
}

.log-line {
  white-space: pre-wrap;
  word-break: break-word;
}

.log-line.stderr {
  color: #FF9F8E;
}

.log-empty {
  color: #6E6E75;
}

.result-banner {
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  font-size: var(--fs-small);
}

.result-banner.ok {
  color: #1F7A3D;
  background: rgba(52, 199, 89, 0.10);
}

.result-banner.bad {
  color: #B42318;
  background: rgba(255, 59, 48, 0.08);
}

.result-sub {
  margin-left: 8px;
  color: var(--text-3);
}

/* ==================== 本地构建 ==================== */

.local-card {
  padding: 16px 20px 18px;
}

.local-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 34px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-2);
}

.local-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 14px;
}

.local-hint {
  padding-top: 12px;
  font-size: var(--fs-xs);
  color: var(--text-3);
  line-height: 1.7;
}

.local-empty {
  padding: 6px 0;
  font-size: var(--fs-base);
  color: var(--text-3);
}

/* 窄窗口：环境检查由四列收为三列，隐藏次要说明列 */
@media (max-width: 900px) {
  .env-row {
    grid-template-columns: 14px 116px minmax(0, 1fr);
  }

  .env-detail {
    display: none;
  }
}

/* 超窄窗口：再收一列，值换行显示，避免横向溢出 */
@media (max-width: 640px) {
  .env-row {
    grid-template-columns: 14px minmax(0, 1fr);
    row-gap: 2px;
  }

  .env-value {
    grid-column: 2;
    white-space: normal;
    word-break: break-all;
  }

  .section-head {
    flex-wrap: wrap;
  }

  .terminal-foot {
    flex-wrap: wrap;
    row-gap: 2px;
  }

  .foot-hint {
    margin-left: 0;
    white-space: normal;
  }
}
</style>
