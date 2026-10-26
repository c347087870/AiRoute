<template>
  <div class="dev-panel">
    <!-- 数据自己每 5 秒刷一次，不放手动刷新按钮：面板上的东西（进程、在途、文件时间戳）
         本来就在变，手点只会让人以为「是不是要刷一下才准」 -->
    <div class="page-toolbar">
      <span class="muted-note">每 5 秒自动刷新</span>
    </div>
    <!-- 正式版的服务端不注册这个端点：前端若还跑在 dev server 上而服务端是打包版，
         这里会 404。把话说清楚，比显示一屏横线有用 -->
    <div v-if="error" class="warning-box">
      ⚠ 读取失败：{{ error }}
    </div>

    <template v-if="info">
      <div class="stat-grid">
        <div class="card stat-card">
          <div class="stat-label">运行时长</div>
          <div class="stat-value">{{ formatDuration(info.process.uptimeSec) }}</div>
          <div class="stat-sub">PID {{ info.process.pid }}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">内存占用</div>
          <div class="stat-value">{{ formatBytes(info.process.memory.rss) }}</div>
          <div class="stat-sub">
            堆 {{ formatBytes(info.process.memory.heapUsed) }} / {{ formatBytes(info.process.memory.heapTotal) }}
          </div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">在途请求</div>
          <div class="stat-value">{{ inFlightTotal }}</div>
          <div class="stat-sub">模型 {{ info.inFlight.length }} 个</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">失活模型</div>
          <div class="stat-value" :class="info.modelHealth.offline ? 'text-orange' : ''">
            {{ info.modelHealth.offline }}
          </div>
          <div class="stat-sub">
            连续 {{ info.modelHealth.offlineAfterFailures }} 次失败即下线 · 审计 {{ auditMinutes }} 分钟
          </div>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">进程与路径</h2>
        <div class="card">
          <div class="config-row">
            <label class="config-label">版本 / 端口</label>
            <div class="config-control">
              <span class="mono">v{{ info.server.version }}</span> · 端口
              <span class="mono">{{ info.server.port }}</span>
              <span class="badge" :class="info.devMode ? 'ok' : 'warn'">
                {{ info.devMode ? '开发模式' : '非开发模式' }}
              </span>
            </div>
          </div>
          <div class="config-row">
            <label class="config-label">Node / 平台</label>
            <div class="config-control">
              <span class="mono">{{ info.process.node }}</span> ·
              <span class="mono">{{ info.process.platform }}-{{ info.process.arch }}</span>
            </div>
          </div>
          <div class="config-row">
            <label class="config-label">数据目录</label>
            <div class="config-control">
              <span class="path mono" :title="info.dataDir">{{ info.dataDir }}</span>
              <AppButton variant="secondary" @click="copy(info.dataDir)">复制</AppButton>
            </div>
          </div>
          <div class="config-row">
            <label class="config-label">工作目录</label>
            <div class="config-control">
              <span class="path mono" :title="info.server.cwd">{{ info.server.cwd }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">运行时</h2>
        <div class="card">
          <div class="config-row">
            <label class="config-label">渠道运行时</label>
            <div class="config-control">
              <span class="badge" :class="info.channels.state === 'ready' ? 'ok' : 'bad'">
                {{ info.channels.state }}
              </span>
              <span>{{ info.channels.providers.length }} 家 / {{ info.channels.models }} 个模型</span>
              <span v-if="info.channels.error" class="text-red">{{ info.channels.error }}</span>
            </div>
          </div>
          <div class="config-row">
            <label class="config-label">渠道插件</label>
            <div class="config-control wrap">
              <span v-for="plugin in info.channels.plugins" :key="plugin.id" class="chip">
                {{ plugin.name }}
                <span v-if="!plugin.enabled" class="chip-sub">已停用</span>
              </span>
              <span v-if="!info.channels.plugins.length" class="text-muted">无</span>
            </div>
          </div>
          <!-- provider 索引单独一行：引用里的第一段就是它（channels/qoder/xxx），
               排查「这个模型为什么解析不到」时最常要看的就是这份名单 -->
          <div class="config-row">
            <label class="config-label">provider 索引</label>
            <div class="config-control wrap">
              <span v-for="id in info.channels.providers" :key="id" class="chip mono">{{ id }}</span>
              <span v-if="!info.channels.providers.length" class="text-muted">无</span>
            </div>
          </div>
          <div v-if="info.channels.pluginFailures.length" class="config-row">
            <label class="config-label">插件异常</label>
            <div class="config-control wrap">
              <span v-for="f in info.channels.pluginFailures" :key="f.id" class="text-red">
                <span class="mono">{{ f.id }}</span>：{{ f.error }}
              </span>
            </div>
          </div>
          <div class="config-row">
            <label class="config-label">WorkBuddy 账号池</label>
            <div class="config-control">
              <template v-if="info.workbuddy.counts">
                <span>
                  总 {{ info.workbuddy.counts.total }} · 可用 {{ info.workbuddy.counts.healthy }} ·
                  冷却 {{ info.workbuddy.counts.cooling }} · 停用 {{ info.workbuddy.counts.disabled }} ·
                  占满 {{ info.workbuddy.counts.inFlightFull }}
                </span>
              </template>
              <span v-else class="text-muted">运行时未初始化</span>
            </div>
          </div>
          <div class="config-row">
            <label class="config-label">日志 / 请求</label>
            <div class="config-control">
              <span>{{ formatBytes(info.logs.totalSize) }}</span> ·
              <span>{{ info.logs.fileCount }} 个文件</span> ·
              <span>今日 {{ formatNumber(info.tokens.todayRequests) }} 次（失败 {{ formatNumber(info.tokens.todayFailed) }}）</span>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">在途与失活</h2>
        <div class="card">
          <!-- 在途请求大多数时候是空的：用一行提示而不是整块空态，
               否则这块空卡片会占掉半屏，把下面的失活明细挤出视野 -->
          <div v-if="!info.inFlight.length" class="inline-empty">当前没有在途请求</div>
          <table v-else class="table">
            <thead>
              <tr><th>模型引用</th><th>在途</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.inFlight" :key="row.ref">
                <td class="mono">{{ row.ref }}</td>
                <td>{{ row.count }}</td>
              </tr>
            </tbody>
          </table>

          <template v-if="info.modelHealth.items.length">
            <div class="sub-title">失活明细</div>
            <table class="table">
              <thead>
                <tr><th>模型引用</th><th>原因</th><th>说明</th><th>自</th></tr>
              </thead>
              <tbody>
                <tr v-for="item in info.modelHealth.items" :key="item.ref">
                  <td class="mono">{{ item.ref }}</td>
                  <td><span class="badge bad">{{ reasonText(item.reason) }}</span></td>
                  <td class="detail">{{ item.detail || '-' }}</td>
                  <td class="nowrap">{{ formatTime(item.since) }}</td>
                </tr>
              </tbody>
            </table>
          </template>
          <div v-else class="inline-empty">没有失活的模型</div>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">数据目录文件</h2>
        <div class="card">
          <table v-if="info.files.length" class="table">
            <thead>
              <tr><th>文件</th><th>大小</th><th>最后修改</th></tr>
            </thead>
            <tbody>
              <tr v-for="file in info.files" :key="file.name">
                <td class="mono">{{ file.name }}</td>
                <td class="nowrap">{{ formatBytes(file.size) }}</td>
                <td class="nowrap">{{ formatTime(file.mtime) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">数据目录为空</div>
        </div>
      </div>

      <div class="section">
        <h2 class="section-title">环境变量</h2>
        <div class="card">
          <table v-if="envRows.length" class="table">
            <thead>
              <tr><th>键</th><th>值</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in envRows" :key="row.key">
                <td class="mono">{{ row.key }}</td>
                <td class="mono detail">{{ row.value }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">没有本项目的环境变量</div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import AppButton from '../components/AppButton.vue'
// 开发面板：只在开发模式出现（路由与侧边栏入口都由 utils/dev-mode.js 把关）。
//
// 显示的是「此刻这个进程在跑什么」—— 版本 / 端口 / 数据目录 / 运行时状态 /
// 在途与失活 / 数据目录里落盘的文件。这些信息分散在七八个接口和文件系统里，
// 开发时排查「改完没重启」「这份 json 到底写到哪了」全靠它们。
//
// 它不是给用户的功能页：打包产物里连这个组件都不会进（见 router.js 的
// import.meta.env.DEV 判断），所以这里可以不讲究「用户看着会不会困惑」，
// 但仍按项目同一套设计令牌与版式写，省得开发时眼睛来回适应。
import { ref, computed, onMounted } from 'vue'
import { getDevInfo } from '../api.js'
import { usePageActions } from '../composables/usePageActions.js'
import { usePolling } from '../composables/usePolling.js'
import { showToast } from '../composables/useToast.js'
import { formatBytes, formatTime, formatNumber } from '../utils/format.js'

const info = ref(null)
const error = ref('')

const inFlightTotal = computed(() =>
  (info.value?.inFlight || []).reduce((sum, row) => sum + row.count, 0))

const auditMinutes = computed(() =>
  Math.round((info.value?.modelHealth.auditIntervalMs || 0) / 60000))

// 服务端只回本项目的环境变量，键名保持服务端给的顺序（常看的放前面）
const envRows = computed(() => {
  const env = info.value?.process.env || {}
  return Object.entries(env).map(([key, value]) => ({ key, value }))
})

// 失活原因的展示文案：与渠道页 / 模型页的说法保持一致
function reasonText(reason) {
  if (reason === 'errors') return '连续失败'
  if (reason === 'balance') return '余额不足'
  if (reason === 'account') return '无可用账号'
  return reason || '未知'
}

// 秒级运行时长：天/时/分，够用又不占宽度
function formatDuration(seconds) {
  const total = Number(seconds) || 0
  if (total < 60) return `${Math.round(total)} 秒`
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 时`
  if (hours > 0) return `${hours} 时 ${minutes} 分`
  return `${minutes} 分`
}

async function reload() {
  try {
    info.value = await getDevInfo()
    error.value = ''
  } catch (err) {
    error.value = describeError(err)
  }
}

// 404 有两种截然不同的原因，靠响应体区分 —— 少了这个判断，开发时最常踩的
// 那一脚（改完没重启服务端）会被说成「不是开发模式启动的」，越查越偏：
//   · 服务端认这个路由、只是判了 NODE_ENV → 回我们自己的 JSON { error }
//   · 服务端进程里根本没有这条路由（改动后没重启）→ Express 默认 404，回 HTML
function describeError(err) {
  if (err.response?.status !== 404) return err.response?.data?.error || err.message
  if (err.response.data?.error) return `服务端拒绝了开发面板：${err.response.data.error}`
  return '服务端进程里还没有开发面板接口 —— 改完代码要重启服务端（只重启前端不够）'
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制')
  } catch {
    showToast('复制失败：剪贴板不可用', 'error', 4000)
  }
}

// 顶栏「实时」角标：面板确实在自动刷新
usePageActions({ live: true })
usePolling(reload)

onMounted(reload)
</script>

<style scoped>
.muted-note {
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* 四张统计卡：与状态面板同版式，只是数字更小一档（开发面板信息密度更高） */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

.stat-card {
  padding: 16px 18px;
}

.stat-label {
  margin-bottom: 6px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.stat-value {
  font-size: var(--fs-display);
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-1);
}

.stat-sub {
  margin-top: 4px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.path {
  max-width: 560px;
  overflow: hidden;
  color: var(--text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-control.wrap {
  flex-wrap: wrap;
  row-gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 10px;
  font-size: var(--fs-xs);
  color: var(--text-1);
  background: var(--bg-chip);
  border-radius: var(--radius-pill);
}

.chip-sub {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.sub-title {
  margin: 18px 0 4px;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--text-2);
}

/* 单行空状态：这张卡里可能同时有在途表和失活表，任一为空都不该撑出整块留白 */
.inline-empty {
  padding: 6px 0;
  font-size: var(--fs-small);
  color: var(--text-3);
}

.detail {
  color: var(--text-2);
  word-break: break-word;
}
</style>
