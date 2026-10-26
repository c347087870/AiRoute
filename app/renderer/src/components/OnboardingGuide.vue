<template>
  <!-- 全屏引导。不盖住侧边栏以外的任何东西都是白搭：这一步要讲的东西
       （端口、模型来源、客户端接入）分散在多个页面，浮层必须自带全部内容，
       不能靠「跳到某页再高亮某处」—— 那样一按跳转就把上下文弄丢了 -->
  <div class="ob-overlay" role="dialog" aria-modal="true" :aria-label="step.title">
    <div class="ob-panel">
      <header class="ob-head">
        <div class="ob-brand">
          <span class="ob-logo">AiRoute</span>
          <span class="ob-brand-sub">{{ step.tag }}</span>
        </div>
        <button class="ob-skip" @click="skip">跳过引导</button>
      </header>

      <!-- 进度：每一步一格，已完成的格点实心。步骤数固定，用户能预判还要点几次 -->
      <ol class="ob-progress" aria-label="引导进度">
        <li
          v-for="(item, i) in STEPS"
          :key="item.key"
          class="ob-pip"
          :class="{ done: i < stepIndex, current: i === stepIndex }"
          :title="item.tag"
        ></li>
      </ol>

      <div class="ob-body">
        <h2 class="ob-title">{{ step.title }}</h2>
        <p class="ob-desc">{{ step.desc }}</p>

        <!-- ==================== 欢迎 ==================== -->
        <div v-if="step.key === 'welcome'" class="ob-content">
          <ul class="ob-bullets">
            <li><b>一个地址</b><span>Claude Code、Cursor、Codex 都连同一个端口。</span></li>
            <li><b>上游只配一次</b><span>换模型不用改客户端。</span></li>
            <li><b>自动兜底</b><span>主模型挂了自动切备选。</span></li>
          </ul>
        </div>

        <!-- ==================== 设置渠道 ==================== -->
        <div v-else-if="step.key === 'channel'" class="ob-content">
          <!-- 已经配好：只报状态，不再摆登录按钮，免得用户重复登录 -->
          <div v-if="hasChannelAccount" class="ob-ready">已登录：{{ loggedChannelsText }}</div>

          <div class="ob-channels">
            <div v-for="ch in channelList" :key="ch.id" class="ob-channel">
              <div class="ob-channel-head">
                <div class="ob-channel-name">
                  {{ ch.name }}
                  <span class="ob-note">{{ ch.desc }}</span>
                </div>
                <span v-if="ch.logged" class="badge ok">已登录</span>
              </div>

              <!-- 登录中：给出可操作的链接与状态，别让用户干等 -->
              <div v-if="isLogging(ch.id)" class="ob-channel-login">
                <p class="ob-note">{{ loginMessage(ch.id) }}</p>
                <!-- 授权链接摆出来：系统浏览器没自动打开时，用户可以自己复制到地址栏 -->
                <code v-if="loginUrl(ch.id)" class="ob-code ob-login-url">{{ loginUrl(ch.id) }}</code>
                <div class="ob-channel-actions">
                  <button class="ob-mini" @click="openLoginUrl(ch.id)">打开授权页面</button>
                  <button class="ob-mini" @click="copy(loginUrl(ch.id), 'login-' + ch.id)">
                    {{ copied === 'login-' + ch.id ? '已复制' : '复制链接' }}
                  </button>
                </div>
              </div>

              <div v-else class="ob-channel-actions">
                <!-- 已登录的不再摆「登录」：重复登录会在账号池里堆出重复条目 -->
                <AppButton
                  v-if="!ch.logged"
                  variant="primary"
                  :disabled="busyChannel === ch.id"
                  @click="startChannelLogin(ch)"
                >
                  {{ busyChannel === ch.id ? '发起中…' : '登录' }}
                </AppButton>
                <span v-else class="ob-note">模型已可用</span>
                <button class="ob-mini" @click="gotoChannelPage(ch.id)">渠道账号页</button>
              </div>
            </div>
          </div>

          <p class="ob-hint">授权在浏览器里完成，登录后自动入库。</p>
        </div>

        <!-- ==================== 选择模型 ==================== -->
        <div v-else-if="step.key === 'model'" class="ob-content">
          <div v-if="!modelOptions.length" class="ob-warn">
            还没有可用模型。先回上一步登录渠道，再来选。
          </div>
          <template v-else>
            <!-- 分组与「渠道账号 → 模型」页一致：auto 单独一档，
                 渠道模型按 id 前缀（workbuddy / trae / qoder…）分组 -->
            <div v-for="group in modelGroups" :key="group.id" class="ob-model-group">
              <div class="ob-model-group-head">
                <span class="ob-group-name">{{ group.name }}</span>
                <span class="ob-group-count">{{ group.models.length }} 个</span>
              </div>
              <div class="ob-models">
                <button
                  v-for="item in group.models"
                  :key="item.ref"
                  class="ob-model"
                  :class="{ active: currentModel === item.ref }"
                  @click="pickModel(item.ref)"
                >
                  <span class="ob-model-name">{{ item.label }}</span>
                  <span v-if="item.note" class="ob-model-note">{{ item.note }}</span>
                </button>
              </div>
            </div>
            <div v-if="switchError" class="ob-warn">{{ switchError }}</div>
            <div v-else-if="currentModel" class="ob-ready">
              当前：<b>{{ currentModelLabel || currentModel }}</b>
            </div>
          </template>
        </div>

        <!-- ==================== 接入 Agent ==================== -->
        <div v-else-if="step.key === 'agent'" class="ob-content">
          <!-- 地址抄错就会白忙一场：服务不在线时先说清楚 -->
          <div v-if="health.state === 'fail'" class="ob-warn">
            连不上本机服务（{{ health.error }}）。<button class="ob-mini" @click="recheck">重新检测</button>
          </div>
          <div v-else-if="portMismatch" class="ob-warn">
            端口对不上：设置里是 {{ configuredPort }}，实际在 {{ health.port }}。
            <button class="ob-mini" @click="recheck">重新检测</button>
          </div>
          <div v-else-if="hasChannelAccount" class="ob-ready">
            渠道已就绪，<b>{{ modelCount }}</b> 个模型可用。
          </div>

          <div class="ob-card">
            <div class="ob-row">
              <span class="ob-k">Anthropic</span>
              <span class="ob-v">
                <code class="ob-code">{{ localUrl }}</code>
                <span class="ob-note">Claude Code</span>
              </span>
            </div>
            <div class="ob-row">
              <span class="ob-k">OpenAI 兼容</span>
              <span class="ob-v">
                <code class="ob-code">{{ localUrl }}/v1</code>
                <span class="ob-note">Cursor / Codex</span>
              </span>
            </div>
            <div class="ob-row">
              <span class="ob-k">API Key</span>
              <span class="ob-v">
                <code class="ob-code">{{ API_KEY }}</code>
                <span class="ob-note">任意非空字符串</span>
              </span>
            </div>
          </div>

          <div class="ob-cols">
            <div class="ob-col">
              <div class="ob-col-title">Claude Code</div>
              <pre class="ob-pre">ANTHROPIC_AUTH_TOKEN={{ API_KEY }}
ANTHROPIC_BASE_URL={{ localUrl }}</pre>
              <button class="ob-mini" @click="copy(claudeSnippet, 'claude')">
                {{ copied === 'claude' ? '已复制' : '复制' }}
              </button>
            </div>
            <div class="ob-col">
              <div class="ob-col-title">让 AI 自己改配置</div>
              <p class="ob-note">复制给 Claude Code / Cursor，它会自己写好并自检。</p>
              <button class="ob-small" @click="copy(promptFallback, 'prompt')">
                {{ copied === 'prompt' ? '已复制' : '复制提示词' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <footer class="ob-foot">
        <span class="ob-foot-hint">{{ stepIndex + 1 }} / {{ STEPS.length }}</span>
        <div class="ob-actions">
          <AppButton variant="secondary" v-if="stepIndex > 0" @click="prev">上一步</AppButton>
          <AppButton variant="primary" v-if="!isLast" @click="next">{{ nextLabel }}</AppButton>
          <AppButton variant="primary" v-else @click="finish">开始使用</AppButton>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  getHealth,
  getServerConfig,
  getServerPort,
  getSystemStatus,
  channelsRpc,
  wbAccounts,
  wbOauthStart,
  wbOauthPoll
} from '../api.js'
import { useOnboarding } from '../composables/useOnboarding.js'
import { useModel } from '../composables/useModel.js'
import { listModels } from '../utils/models.js'

import AppButton from '../components/AppButton.vue'
const emit = defineEmits(['close', 'finish'])

const router = useRouter()
const { stepIndex } = useOnboarding()
// 复用共享的 provider / 模型状态：与「Provider 管理」页看到的保持一致，
// 自己再存一份必然会和别处对不上
const { providers, currentModel, currentModelLabel, switchModel, loadModelData } = useModel()

// 与教程页同一个约定：网关不鉴权，任意非空字符串均可（写真实 Key 反而会被客户端要求保密）
const API_KEY = 'sk-airroute'

// 步骤表：标题 / 说明都写在这里，模板只按 key 分支渲染。
// 三步：欢迎 → 配渠道 → 接 Agent。以前拆成六步（环境自检 / 模型来源 /
// 客户端接入 / 选择模型 / 完成），每步都短得像凑数，用户连点五次「下一步」
// 也没配好一个渠道 —— 现在每一步对应一件真正要做完的事。
const STEPS = [
  {
    key: 'welcome',
    tag: '欢迎',
    title: '欢迎使用 AiRoute',
    desc: '本机起一个 OpenAI / Anthropic 兼容网关，把多家上游收成同一个地址。'
  },
  {
    key: 'channel',
    tag: '设置渠道',
    title: '选一家渠道，登录一个账号',
    desc: '登录后它的模型就能直接用。'
  },
  {
    key: 'model',
    tag: '选择模型',
    title: '决定默认用哪个模型',
    desc: '客户端传什么模型名都行，实际用哪个由这里决定。'
  },
  {
    key: 'agent',
    tag: '接入 Agent',
    title: '把 Agent 指过来',
    desc: '填同一个地址和 Key，Claude Code、Cursor、Codex 都能用。'
  }
]

const step = computed(() => STEPS[stepIndex.value] || STEPS[0])
const isLast = computed(() => stepIndex.value >= STEPS.length - 1)

// 下一步按钮的文案跟随「这一步还没做完」的状态：渠道没配好时说清楚，
// 不然用户会以为「下一步」=「已经配好了」
const nextLabel = computed(() => {
  if (step.value.key === 'channel' && !hasChannelAccount.value) return '先跳过，稍后配置'
  return '下一步'
})

// ==================== 环境自检 ====================

const health = ref({ state: 'checking', version: '', port: 0, latency: 0, error: '' })
const healthOk = computed(() => health.value.state === 'ok')
// 「连上了，但连的不是这个窗口该连的那一个」：dev:web 下 vite 的 5173 端口上
// 也挂着一个 /api/health 代理，误把端口填成本页地址时会全部绿，直到发请求才报错
const portMismatch = computed(
  () => healthOk.value && health.value.port && String(health.value.port) !== String(configuredPort.value)
)
const configuredPort = computed(() => getServerPort())
const localUrl = computed(() => `http://localhost:${configuredPort.value}`)
const lanIPs = ref([])
const lanUrl = computed(() => (lanIPs.value.length ? `http://${lanIPs.value[0]}:${getServerPort()}` : ''))

// 一次健康检查同时拿到实际监听端口与往返耗时：这两个数就是「在跑」最直接的证据，
// 比只画一个绿点更能让用户相信服务真的连上了。/api/health 不带版本号，
// 版本从 /api/system/status 补（它失败不影响「在线」这个结论）
async function checkHealth() {
  health.value = { ...health.value, state: 'checking', error: '' }
  const started = Date.now()
  try {
    const [data, status] = await Promise.all([
      getHealth(),
      getSystemStatus().catch(() => null)
    ])
    health.value = {
      state: 'ok',
      version: status?.version || '',
      port: data?.port || 0,
      latency: Date.now() - started,
      error: ''
    }
  } catch (err) {
    health.value = {
      state: 'fail',
      version: '',
      port: 0,
      latency: 0,
      error: `连不上端口 ${getServerPort()}${err?.response ? `（HTTP ${err.response.status}）` : ''}`
    }
  }
}

function recheck() {
  checkHealth()
  loadEnv()
}

// 端口与局域网 IP：失败就不显示局域网那一行，不让整步因一个可选信息卡住
async function loadEnv() {
  try {
    const config = await getServerConfig()
    lanIPs.value = Array.isArray(config?.localIPs) ? config.localIPs : []
  } catch {
    lanIPs.value = []
  }
}

// ==================== 渠道 ====================

// 引导只列这三家：都是登录即用、免 Key 的免费渠道。
// provider 字段是服务端 RPC 用的渠道 id，与界面上显示的名字不是一回事
const CHANNELS = [
  { id: 'workbuddy', name: 'WorkBuddy', desc: '腾讯 · 国内版 / 国际版' },
  { id: 'trae', name: 'TRAE', desc: '字节跳动' },
  { id: 'qoder', name: 'Qoder', desc: '阿里 · 国际版 / 国内版' }
]

// 每家的登录态：账号列表里拿到有凭据的账号就算已登录
const channelAccounts = ref({})
const busyChannel = ref('')
// 登录中的会话：{ provider, accountId, state, url, message }
// 渠道包（trae/qoder）用 accountId 轮询，WorkBuddy 用设备码 state 轮询，两套并存
const logins = ref({})

// 已登录的渠道。账号数在每次登录成功后刷新，这里只做展示
const channelList = computed(() =>
  CHANNELS.map(ch => ({
    ...ch,
    logged: (channelAccounts.value[ch.id] || []).length > 0
  }))
)

const hasChannelAccount = computed(() =>
  channelList.value.some(ch => ch.logged)
)
const loggedChannelsText = computed(() =>
  channelList.value.filter(ch => ch.logged).map(ch => ch.name).join('、')
)

function isLogging(id) {
  return !!logins.value[id]
}
function loginUrl(id) {
  return logins.value[id]?.url || ''
}
function loginMessage(id) {
  return logins.value[id]?.message || '在浏览器里完成授权'
}

// 浏览器没自动打开时的手动入口：授权链接就在下面那行文字里，可选中复制
function openLoginUrl(id) {
  openInBrowser(loginUrl(id))
}

// 读三家的账号状态。任一家失败只影响它自己那一格
async function loadChannelAccounts() {
  const results = await Promise.allSettled([
    channelsRpc('account.list', { provider: 'trae' }),
    channelsRpc('account.list', { provider: 'qoder' }),
    wbAccounts()
  ])
  const next = {}
  if (results[0].status === 'fulfilled') {
    next.trae = (results[0].value || []).filter(a => a.hasCredential !== false)
  }
  if (results[1].status === 'fulfilled') {
    next.qoder = (results[1].value || []).filter(a => a.hasCredential !== false)
  }
  if (results[2].status === 'fulfilled') {
    const list = results[2].value?.accounts || []
    // WorkBuddy 国内版与国际版共用一个池子，展示时合成一家
    next.workbuddy = list
  }
  channelAccounts.value = next
}

// 发起登录：渠道包走 account.create 拿授权链接，WorkBuddy 走设备码
async function startChannelLogin(ch) {
  if (busyChannel.value) return
  busyChannel.value = ch.id
  try {
    if (ch.id === 'workbuddy') {
      const data = await wbOauthStart('cn')
      logins.value = { ...logins.value, [ch.id]: { state: data.state, url: data.url, message: '在浏览器里完成授权' } }
      openInBrowser(data.url)
      pollWorkbuddyLogin(ch.id, data.state)
    } else {
      const started = await channelsRpc('account.create', { provider: ch.id })
      logins.value = {
        ...logins.value,
        [ch.id]: { accountId: started.accountId, url: started.loginUrl, message: '在浏览器里完成授权' }
      }
      openInBrowser(started.loginUrl)
      pollChannelLogin(ch.id, started.accountId)
    }
  } catch (err) {
    logins.value = { ...logins.value, [ch.id]: { message: '发起登录失败：' + (err?.message || err) } }
    // 失败不留在「登录中」状态：否则用户看到的是一条点不动的等待
    setTimeout(() => {
      const cur = logins.value[ch.id]
      if (cur && !cur.accountId && !cur.state) {
        const next = { ...logins.value }
        delete next[ch.id]
        logins.value = next
      }
    }, 4000)
  } finally {
    busyChannel.value = ''
  }
}

// 轮询渠道包登录结果。成功后刷新账号状态，浮层里直接变成「已登录」
function pollChannelLogin(id, accountId) {
  const timer = setInterval(async () => {
    try {
      const state = await channelsRpc('login.poll', { accountId, provider: id })
      if (!state?.done) return
      clearInterval(timer)
      const next = { ...logins.value }
      delete next[id]
      logins.value = next
      await loadChannelAccounts()
    } catch {
      /* 单次轮询失败继续等 */
    }
  }, 2500)
  // 组件被卸载时把定时器收掉，避免回调打到已销毁的组件上
  onUnmounted(() => clearInterval(timer))
}

// 轮询 WorkBuddy 设备码登录结果
function pollWorkbuddyLogin(id, state) {
  const timer = setInterval(async () => {
    try {
      const data = await wbOauthPoll(state)
      if (!data?.done) {
        if (data?.message) {
          logins.value = { ...logins.value, [id]: { ...logins.value[id], message: data.message } }
        }
        return
      }
      clearInterval(timer)
      const next = { ...logins.value }
      delete next[id]
      logins.value = next
      await loadChannelAccounts()
    } catch {
      /* 单次轮询失败继续等 */
    }
  }, 3000)
  onUnmounted(() => clearInterval(timer))
}

// 授权页一律交给系统浏览器：Electron 的内嵌窗口会被 OAuth 提供方拒绝
function openInBrowser(url) {
  if (!url) return
  if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url)
  else window.open(url, '_blank')
}

// 「去渠道账号页」：直接落到那家的卡片上，比让用户自己在页里找省事
function gotoChannelPage(id) {
  emit('close')
  router.push({ path: '/channels', query: { add: id } })
}

// ==================== 模型来源 ====================

// 引导里没有「添加 Provider」这一步：自己带 Key 的 Provider 属于进阶用法，
// 放在「Provider 管理」页自己加。providers 来自 useModel 的共享状态，
// 不在这里另存一份 —— 另存必然和别处对不上
const modelCount = computed(() => {
  let n = 0
  for (const provider of Object.values(providers.value || {})) {
    n += Array.isArray(provider?.models) ? provider.models.length : 0
  }
  return n
})

// ==================== 选择模型 ====================

const switchError = ref('')

// 具体模型的来源分组。渠道源把 11 家的模型装进同一个 Provider，
// 靠模型 id 的前缀（workbuddy/…、trae/…）区分是哪家 —— 与「渠道账号 → 模型」
// 页按 provider 分组是同一套维度，只是那边从接口拿、这边从 id 前缀切。
const CHANNEL_GROUP_NAMES = {
  workbuddy: 'WorkBuddy（国内版）',
  'workbuddy-global': 'WorkBuddy（国际版）',
  trae: 'TRAE（字节）',
  qoder: 'Qoder（国际版）',
  qodercn: 'Qoder（国内版）'
}

// 具体模型清单。分组标题已经写明是哪家渠道，组内的模型名就不再带
// 渠道前缀 —— 与「渠道账号 → 模型」页的组内写法一致（那里也是分组标题
// 带渠道、组内只写模型名）。
const AUTO_OPTIONS = [
  { ref: 'auto', label: 'auto', note: '按内容自动挑' },
  { ref: 'auto-fast', label: 'auto-fast', note: '延迟优先' },
  { ref: 'auto-cheap', label: 'auto-cheap', note: '成本优先' },
  { ref: 'auto-least-conn', label: 'auto-least-conn', note: '并发优先' }
]

const modelOptions = computed(() => [
  ...AUTO_OPTIONS,
  ...listModels(providers.value).map(item => ({
    ref: item.ref,
    label: item.label,
    model: item.model,
    note: providers.value?.[item.providerName]?.type === 'channel' ? '' : item.providerLabel
  }))
])

// 分组后的模型：auto 一组，渠道按前缀分，通用 Provider 按 Provider 分
const modelGroups = computed(() => {
  const groups = new Map()
  const push = (id, name, model) => {
    if (!groups.has(id)) groups.set(id, { id, name, models: [] })
    groups.get(id).models.push(model)
  }

  for (const option of modelOptions.value) {
    if (option.ref === 'auto' || option.ref.startsWith('auto-')) {
      push('auto', '自动路由', option)
      continue
    }
    const providerName = option.ref.split('/')[0]
    const provider = providers.value?.[providerName]
    if (provider?.type === 'channel') {
      // 渠道源：按模型 id 的第二段分（channels/workbuddy/xxx → workbuddy）
      const channel = option.ref.split('/')[1] || providerName
      // 分组标题已经写了渠道名，组内只留模型名。
      // 直接用 displayName：它本身就不含渠道前缀（TRAE 的前缀来自模型 id
      // 里的斜杠，displayName 已经剥掉了），而 id 段是接口内部名
      // （qoder/smodel → Sonus），直接摆出来用户认不出来。
      // 也不能按「 · 」切 —— displayName 里本来就有这种分隔
      // （qoder 的「GLM-5.3-Flash · x0.1」是档位，不是渠道前缀）。
      const display = option.model?.displayName || option.model?.name || ''
      push(channel, CHANNEL_GROUP_NAMES[channel] || channel, {
        ...option,
        label: display || option.label
      })
    } else {
      push(providerName, provider?.displayName || providerName, option)
    }
  }

  // auto 排最前，其余按模型数从多到少（多的渠道排前面，和账号卡片顺序一致）
  const list = [...groups.values()]
  return list.sort((a, b) => {
    if (a.id === 'auto') return -1
    if (b.id === 'auto') return 1
    return b.models.length - a.models.length
  })
})

// 走 useModel 的 switchModel：服务端与侧边栏 / 托盘的显示一起更新
async function pickModel(ref) {
  if (ref === currentModel.value) return
  switchError.value = ''
  const ok = await switchModel(ref)
  if (!ok) switchError.value = '切换失败，稍后重试'
}

// ==================== 一键接入提示词 ====================

// Claude Code 的环境变量片段。端口取自当前设置，改过端口也不会指错
const claudeSnippet = computed(
  () => `ANTHROPIC_AUTH_TOKEN=${API_KEY}\nANTHROPIC_BASE_URL=${localUrl.value}`
)

// 与「使用教程」页的提示词同源（那边是完整版）。引导里只放最短可执行的一段：
// 太长的话用户会直接跳过这一步
const promptFallback = computed(() => `把你自己接入本机的 AiRoute 网关（兼容 Anthropic 与 OpenAI）。
- 地址：${localUrl.value}（Anthropic 只写到端口；OpenAI 兼容用 ${localUrl.value}/v1）
- API Key：${API_KEY}
- 模型名随便填，实际用哪个由 AiRoute 决定
先备份配置，只动接入相关的键，然后跑一次
curl -s ${localUrl.value}/v1/models -H 'authorization: Bearer ${API_KEY}'
自检，并告诉我改了哪个文件。`)

// ==================== 复制 ====================

const copied = ref('')
let copyTimer = 0

// 剪贴板被拒（窗口无焦点）时不弹错：地址本身就在界面上可选中
async function copy(text, key) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = key
  } catch {
    copied.value = ''
  }
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = ''
  }, 2000)
}

// ==================== 导航 ====================

function prev() {
  if (stepIndex.value > 0) stepIndex.value -= 1
}

function next() {
  // 往后翻一步就顺手把该步的数据取回来：懒加载让首屏不背四个接口，
  // 也不会出现「翻到渠道页停两秒才跳出列表」
  if (stepIndex.value < STEPS.length - 1) stepIndex.value += 1
  loadStepData()
}

// 跳过要记完成：交给 App.vue 统一落盘，否则下次启动又会拦一次
function skip() {
  emit('finish', { openSettings: false })
}

function finish() {
  emit('finish', { openSettings: false })
}

// 回到第一步时重新取一遍：用户可能刚在别的页面加过 Provider
function loadStepData() {
  const key = step.value.key
  if (key === 'channel') {
    loadChannelAccounts()
  } else if (key === 'model') {
    // 模型清单依赖渠道登录结果：进这一步时重新拉一遍
    loadChannelAccounts()
    loadModelData()
  } else if (key === 'agent') {
    // 地址与端口来自设置项，Agent 接入这一步必须先确认服务在线
    checkHealth()
    loadEnv()
    loadModelData()
  }
}

// 每一步进入时同步一次：next/prev 已经调过 loadStepData，
// 这里负责「直接打开到第 N 步」的入口（侧边栏 / 设置页）
watch(stepIndex, () => loadStepData(), { immediate: true })
</script>

<style scoped>
.ob-overlay {
  position: fixed;
  inset: 0;
  z-index: 200; /* 高于页面弹窗（100）与 toast：引导期间它说了算 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--overlay);
  backdrop-filter: blur(2px);
}

.ob-panel {
  display: flex;
  flex-direction: column;
  width: 600px;
  max-width: 100%;
  max-height: calc(100vh - 48px);
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}

.ob-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px 10px;
}

.ob-brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.ob-logo {
  font-size: var(--fs-section);
  font-weight: 700;
  color: var(--primary);
  letter-spacing: 0.3px;
}

.ob-brand-sub {
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.ob-skip {
  padding: 4px 10px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: transparent;
}

.ob-skip:hover {
  color: var(--primary);
}

.ob-progress {
  display: flex;
  gap: 6px;
  padding: 0 24px 14px;
  list-style: none;
}

.ob-pip {
  flex: 1;
  height: 4px;
  border-radius: var(--radius-xs);
  background: var(--border-2);
  transition: background 0.2s;
}

.ob-pip.done {
  background: var(--primary);
}

.ob-pip.current {
  background: var(--primary);
  opacity: 0.55;
}

.ob-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px 8px;
}

.ob-title {
  margin-bottom: 6px;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-1);
}

.ob-desc {
  margin-bottom: 16px;
  font-size: var(--fs-small);
  line-height: 1.7;
  color: var(--text-2);
}

.ob-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ob-card {
  padding: 4px 16px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}

.ob-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-2);
}

.ob-row:last-child {
  border-bottom: none;
}

.ob-k {
  width: 110px;
  flex: none;
  font-size: var(--fs-small);
  color: var(--text-2);
}

.ob-v {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--fs-small);
  color: var(--text-1);
}

.ob-code {
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--primary);
  background: var(--bg-code);
  border-radius: var(--radius-xs);
  user-select: all;
}

.ob-note {
  font-size: var(--fs-mini);
  color: var(--text-2);
}

.ob-mini {
  padding: 2px 10px;
  font-size: var(--fs-mini);
  color: var(--primary);
  background: var(--tint-primary);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
}

.ob-mini:hover {
  border-color: var(--primary);
}

.ob-small {
  align-self: flex-start;
  padding: 6px 14px;
  font-size: var(--fs-xs);
  color: #fff;
  background: var(--primary);
  border-radius: var(--radius-sm);
}

.ob-small:hover {
  background: var(--primary-hover);
}

/* 欢迎页的三条卖点：横排一行一条，比竖排卡片省地方 */
.ob-bullets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  list-style: none;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}

.ob-bullets li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-small);
  line-height: 1.5;
  color: var(--text-2);
}

.ob-bullets b {
  flex: none;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--text-1);
}

.ob-bullets code {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  background: var(--bg-code);
  border-radius: var(--radius-xs);
}

.ob-hint {
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-2);
}

.ob-hint code {
  padding: 1px 5px;
  font-family: var(--font-mono);
  background: var(--bg-code);
  border-radius: var(--radius-xs);
}

.ob-warn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--warning-text);
  background: var(--tint-warning);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
}

.ob-ready {
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--ok-text);
  background: var(--ok-bg);
  border-radius: var(--radius-md);
}

/* 渠道列表：三张卡竖排，每张一行「名字 + 登录按钮」 */
.ob-channels {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ob-channel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.ob-channel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ob-channel-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-1);
}

.ob-channel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ob-channel-login {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
}

/* 授权链接可能很长：允许换行，别让它把卡片撑破 */
.ob-login-url {
  word-break: break-all;
  line-height: 1.5;
}

.ob-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.ob-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.ob-col-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-1);
}

.ob-pre {
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-mini);
  line-height: 1.6;
  color: var(--text-1);
  background: var(--bg-code);
  border-radius: var(--radius-sm);
  user-select: all;
}

/* 模型选择：分组与「渠道账号 → 模型」页同一套样式 —— pill 标签 + 流式换行。
   那边是一排一排的小胶囊，这里保持一致，用户的眼动不用换。 */
.ob-model-group {
  padding-top: 10px;
  border-top: 1px solid var(--border-2);
}

.ob-model-group:first-of-type {
  padding-top: 0;
  border-top: none;
}

.ob-model-group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
  font-size: var(--fs-xs);
}

.ob-group-name {
  font-weight: 600;
  color: var(--text-1);
}

.ob-group-count {
  color: var(--text-3);
}

.ob-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  padding: 2px;
}

.ob-model {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
  padding: 4px 10px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-1);
  background: var(--primary-bg-hover);
  border: 1px solid var(--border-3);
  border-radius: var(--radius-pill);
}

.ob-model:hover {
  border-color: var(--primary);
}

.ob-model.active {
  color: var(--bg-card);
  background: var(--primary);
  border-color: var(--primary);
}

.ob-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* auto 四档的用途说明（延迟优先 / 成本优先…）：选中的那档才显出来，
   没选时不必占地方 */
.ob-model-note {
  font-weight: 400;
  opacity: 0.7;
}

.ob-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px 18px;
  border-top: 1px solid var(--border-2);
}

.ob-foot-hint {
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.ob-actions {
  display: flex;
  gap: 8px;
}

/* 窄窗口下双栏退成单栏：Electron 主窗口允许拖到 800px 以下 */
@media (max-width: 820px) {
  .ob-cols {
    grid-template-columns: 1fr;
  }
}
</style>

