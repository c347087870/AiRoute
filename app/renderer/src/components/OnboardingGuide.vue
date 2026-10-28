<template>
  <!-- 全屏引导。不盖住侧边栏以外的任何东西都是白搭：这一步要讲的东西
       （端口、模型来源、客户端接入）分散在多个页面，浮层必须自带全部内容，
       不能靠「跳到某页再高亮某处」—— 那样一按跳转就把上下文弄丢了 -->
  <div class="ob-overlay" role="dialog" aria-modal="true" :aria-label="step.title">
    <div class="ob-panel">
      <header class="ob-head">
        <div class="ob-brand">
          <span class="ob-logo">AiRoute</span>
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
        <!-- 内容层：面板高度随内容走，超出视口时由 body 内部滚动 -->
        <div class="ob-measure">
          <h2 v-if="step.title" class="ob-title">{{ step.title }}</h2>
          <p v-if="step.desc" class="ob-desc">{{ step.desc }}</p>

        <!-- ==================== 设置渠道 ==================== -->
        <div v-if="step.key === 'channel'" class="ob-content">
          <!-- 渠道改成分段 Tab：一次只显示一家，登录区域随选中项切换 -->
          <!-- 外面裹一层 div：.ob-content 是列向 flex，分段控件作为直接子项会被
               stretch 拉满整行（灰底铺到面板左右边缘）。裹一层后它按内容宽度收缩，
               与它在行向工具条里的观感一致 -->
          <div class="ob-tabs">
            <SegmentedTabs
              v-model="activeChannel"
              :options="channelTabs"
              label="选择要登录的渠道"
            />
          </div>

          <div v-for="ch in channelList" v-show="ch.id === activeChannel" :key="ch.id" class="ob-channel">
            <div class="ob-channel-head">
              <div class="ob-channel-name">
                {{ ch.name }}
              </div>
            </div>

            <!-- 登录中：给出可操作的链接与状态，别让用户干等 -->
            <div v-if="isLogging(ch.id)" class="ob-channel-login">
              <!-- 授权区块与「渠道账号」「账号池」两页共用同一个组件：同一件事
                   不该在三处各写一套按钮与文案 -->
              <OauthAuthBlock
                :title="loginTitle(ch.id)"
                :url="loginUrl(ch.id)"
                :message="rawLoginMessage(ch.id)"
                cancel-text="取消授权"
                @cancel="cancelChannelLogin(ch.id)"
              />
            </div>

            <div class="ob-channel-actions">
              <!-- 未登录显示「登录」；已登录显示「添加账号」，点了继续走同一条登录链路
                   追加账号（这些渠道都支持多账号，账号池按条目累加） -->
              <AppButton variant="primary" :disabled="busyChannel === ch.id" @click="startChannelLogin(ch)">
                {{ busyChannel === ch.id ? '发起中…' : ch.logged ? '添加账号' : '登录' }}
              </AppButton>
              <span v-if="ch.logged" class="ob-channel-account-count">已登录 {{ ch.accountCount }} 个账号</span>
            </div>
          </div>
        </div>

        <!-- ==================== 选择模型 ==================== -->
        <div v-else-if="step.key === 'model'" class="ob-content">
          <!-- 目录是异步拉的：加载中不能落到「还没有可用模型」的警告上，
               否则每次进这一步都会先闪一下黄条再变成列表 -->
          <div v-if="modelLoading && !modelGroups.length" class="ob-loading">正在读取模型列表…</div>
          <div v-else-if="!modelGroups.length" class="ob-warn">
            还没有可用模型。先回上一步登录渠道，再来选。
          </div>
          <template v-else>
            <!-- 与「渠道账号 → 模型」页同一套：全量目录 + 开启实底 / 关闭虚线灰字。
                 写入口同一套（渠道包 disabledModels / WorkBuddy 启用清单），
                 不在这里另存一份状态 -->
            <div v-for="group in modelGroups" :key="group.id" class="ob-model-group">
              <div class="ob-model-group-head">
                <span class="ob-group-name">{{ group.name }}</span>
                <span class="ob-group-count">{{ group.models.length }} 个</span>
              </div>
              <div class="ob-models">
                <button
                  v-for="item in group.models"
                  :key="item.id"
                  class="ob-model"
                  :class="{ off: item.disabled }"
                  :title="item.disabled ? '点击打开' : '点击关闭'"
                  @click="toggleModel(item.ref)"
                >
                  <span class="ob-model-name">{{ item.name }}</span>
                </button>
              </div>
            </div>
            <div v-if="switchError" class="ob-warn">{{ switchError }}</div>
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

          <!-- 接入信息压成一行 + 一个复制按钮：地址与 Key 用户只需要抄一次，
               摆成三行表格再配两段代码，用户会以为每条都要单独处理 -->
          <div class="ob-card">
            <div class="ob-row">
              <span class="ob-k">地址</span>
              <span class="ob-v">
                <code class="ob-code">{{ localUrl }}</code>
              </span>
            </div>
            <div class="ob-row">
              <span class="ob-k">Key</span>
              <span class="ob-v">
                <code class="ob-code">{{ API_KEY }}</code>
              </span>
            </div>
          </div>

          <button class="ob-primary-copy" @click="copy(connectSnippet, 'connect')">
            {{ copied === 'connect' ? '已复制' : '复制接入信息' }}
          </button>

          </div>
      </div>
      </div>

      <footer class="ob-foot">
        <span class="ob-foot-hint">{{ stepIndex + 1 }} / {{ STEPS.length }}</span>
        <div class="ob-actions">
          <AppButton variant="secondary" v-if="stepIndex > 0" @click="prev">上一步</AppButton>
          <AppButton variant="primary" v-if="!isLast" @click="next">下一步</AppButton>
          <AppButton variant="primary" v-else @click="finish">开始使用</AppButton>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  getHealth,
  getServerConfig,
  getServerPort,
  getSystemStatus,
  channelsRpc,
  wbAccounts,
  wbModels,
  wbOauthStart,
  wbOauthPoll,
  wbEnabledModels,
  wbSaveEnabledModels
} from '../api.js'
import { useOnboarding } from '../composables/useOnboarding.js'
import { useModel } from '../composables/useModel.js'
import { showToast } from '../composables/useToast.js'

import AppButton from '../components/AppButton.vue'
import OauthAuthBlock from '../components/OauthAuthBlock.vue'
import SegmentedTabs from '../components/SegmentedTabs.vue'
import { assetUrl } from '../utils/assets.js'
const emit = defineEmits(['close', 'finish'])

const { stepIndex, modelDefaultsApplied, markModelDefaultsApplied } = useOnboarding()
// 复用共享的 provider 状态：与「Provider 管理」页看到的保持一致，
// 自己再存一份必然会和别处对不上（渠道源里带的是启用清单口径的模型）
const { loadModelData } = useModel()

// 与教程页同一个约定：网关不鉴权，任意非空字符串均可（写真实 Key 反而会被客户端要求保密）
const API_KEY = 'sk-airroute'

// 步骤表：标题 / 说明都写在这里，模板只按 key 分支渲染。
// 三步：登录账号 → 选择模型 → 接入 Agent。标题即全部文案，不再配描述。
const STEPS = [
  {
    key: 'channel',
    tag: '登录账号',
    title: '登录账号',
    desc: ''
  },
  {
    key: 'model',
    tag: '选择模型',
    title: '选择模型',
    desc: ''
  },
  {
    key: 'agent',
    tag: '接入 Agent',
    title: '接入 Agent',
    desc: ''
  }
]

const step = computed(() => STEPS[stepIndex.value] || STEPS[0])
const isLast = computed(() => stepIndex.value >= STEPS.length - 1)

// ==================== body 布局 ====================

// 面板高度跟着内容走，不做高度过渡：翻步时整块面板直接变高，
// 免得内容被一段高度动画挤着上下抖。

// 步骤内的阻塞：前两步各自有一个「做完才算做完」的条件，没满足就不放行。
// 「跳过引导」仍然留着 —— 用户随时可以放弃引导去用界面，不必被流程困住；
// 但只要他还在引导里，就不能带着「没登录 / 没选模型」的状态进入下一步。
// 按钮不禁用：点了出一条轻提示，告诉他这一步要做什么，而不是对着一个点不动的按钮猜。
// 数据还没取回时也按「没做」提示：此刻确实没有登录态/启用模型可用，
// 说「正在读取」等于把内部状态抛给用户，而他此刻要做的动作没有区别。
const canAdvance = computed(() => {
  if (step.value.key === 'channel') return hasChannelAccount.value
  if (step.value.key === 'model') return hasEnabledModel.value
  return true
})

const blockHint = computed(() => {
  if (canAdvance.value) return ''
  if (step.value.key === 'channel') return '请先登录一个渠道账号'
  if (step.value.key === 'model') return '请先启用至少一个模型'
  return ''
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

// 引导只列这些登录即用、免 Key 的免费渠道，按产品 × 区域拆开：
// WorkBuddy 国内版 / 国际版、Trae、Qoder 国内版 / 国际版。
// provider 字段是服务端 RPC 用的渠道 id，与界面上显示的名字不是一回事。
// desc 之类的中文说明已去掉，Tab 标签只保留渠道名。
// logo 是 Tab 标签前的品牌图，与「渠道账号」页添加菜单用的是同一组文件
const BRAND_LOGOS = {
  workbuddy: assetUrl('brand-workbuddy.svg'),
  trae: assetUrl('brand-trae.png'),
  qoder: assetUrl('brand-qoder.svg'),
  qodercn: assetUrl('brand-qoder.svg')
}
const CHANNELS = [
  { id: 'wb-cn', name: 'WorkBuddy 国内版', type: 'workbuddy', realm: 'cn' },
  { id: 'wb-global', name: 'WorkBuddy 国际版', type: 'workbuddy', realm: 'global' },
  { id: 'trae', name: 'Trae', type: 'plugin', provider: 'trae' },
  { id: 'qoder-cn', name: 'Qoder 国内版', type: 'plugin', provider: 'qodercn' },
  { id: 'qoder-global', name: 'Qoder 国际版', type: 'plugin', provider: 'qoder' }
].map(ch => ({ ...ch, logo: ch.type === 'workbuddy' ? BRAND_LOGOS.workbuddy : BRAND_LOGOS[ch.provider] }))

// Tab 选项与当前选中的渠道；默认落在第一家
const channelTabs = CHANNELS.map(ch => ({ value: ch.id, label: ch.name, icon: ch.logo }))
const activeChannel = ref(CHANNELS[0].id)

// 每家的登录态：账号列表里拿到有凭据的账号就算已登录
const channelAccounts = ref({})
const busyChannel = ref('')
// 登录中的会话：{ provider, accountId, state, url, message }
// 渠道包（Trae/qoder）用 accountId 轮询，WorkBuddy 用设备码 state 轮询，两套并存
const logins = ref({})
// 每家的轮询定时器：取消授权时要能把它掐掉，否则定时器还会一直打服务端
const loginTimers = {}

// 已登录的渠道。账号数在每次登录成功后刷新，这里只做展示
const channelList = computed(() =>
  CHANNELS.map(ch => ({
    ...ch,
    accountCount: (channelAccounts.value[ch.id] || []).length,
    logged: (channelAccounts.value[ch.id] || []).length > 0
  }))
)

const hasChannelAccount = computed(() =>
  channelList.value.some(ch => ch.logged)
)

// 已登录后按钮变成「添加账号」，走同一条登录链路追加账号，不再有「重复登录」拦截

function isLogging(id) {
  return !!logins.value[id]
}
function loginUrl(id) {
  return logins.value[id]?.url || ''
}
// 授权区块的标题：与「渠道账号」页 WorkBuddy 卡 / 渠道包卡的写法一致
// （WorkBuddy 带区域限定，渠道包只写渠道名）
function loginTitle(id) {
  const name = channelList.value.find(ch => ch.id === id)?.name || id
  return `在浏览器中完成 ${name} 授权`
}

// 上游原话（code=… msg=…）：只在 title 里备查，正文走人话
function rawLoginMessage(id) {
  return logins.value[id]?.message || ''
}

// 读各家的账号状态。任一家失败只影响它自己那一格
async function loadChannelAccounts() {
  const results = await Promise.allSettled([
    channelsRpc('account.list', { provider: 'trae' }),
    channelsRpc('account.list', { provider: 'qoder' }),
    channelsRpc('account.list', { provider: 'qodercn' }),
    wbAccounts()
  ])
  const next = {}
  if (results[0].status === 'fulfilled') {
    next.trae = (results[0].value || []).filter(a => a.hasCredential !== false)
  }
  if (results[1].status === 'fulfilled') {
    next['qoder-global'] = (results[1].value || []).filter(a => a.hasCredential !== false)
  }
  if (results[2].status === 'fulfilled') {
    next['qoder-cn'] = (results[2].value || []).filter(a => a.hasCredential !== false)
  }
  if (results[3].status === 'fulfilled') {
    // WorkBuddy 国内版与国际版共用一个账号池，按 realm 拆成两格
    const list = results[3].value?.accounts || []
    next['wb-cn'] = list.filter(a => a.realm !== 'global')
    next['wb-global'] = list.filter(a => a.realm === 'global')
  }
  channelAccounts.value = next
}

// 发起登录：渠道包走 account.create 拿授权链接，WorkBuddy 走设备码
// （WorkBuddy 两区的域名 / OAuth 入口不同，由渠道项的 realm 决定）
async function startChannelLogin(ch) {
  if (busyChannel.value) return
  busyChannel.value = ch.id
  try {
    if (ch.type === 'workbuddy') {
      const data = await wbOauthStart(ch.realm === 'global' ? 'global' : 'cn')
      logins.value = { ...logins.value, [ch.id]: { state: data.state, url: data.url, message: '在浏览器里完成授权' } }
      openInBrowser(data.url)
      pollWorkbuddyLogin(ch.id, data.state)
    } else {
      const started = await channelsRpc('account.create', { provider: ch.provider })
      logins.value = {
        ...logins.value,
        [ch.id]: { accountId: started.accountId, url: started.loginUrl, message: '在浏览器里完成授权' }
      }
      openInBrowser(started.loginUrl)
      pollChannelLogin(ch.id, ch.provider, started.accountId)
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
// provider 与 id 分开：id 是界面上的渠道项（Tab），provider 是服务端认的渠道 id
function pollChannelLogin(id, provider, accountId) {
  const timer = setInterval(async () => {
    try {
      const state = await channelsRpc('login.poll', { accountId, provider })
      if (!state?.done) return
      clearInterval(timer)
      delete loginTimers[id]
      const next = { ...logins.value }
      delete next[id]
      logins.value = next
      await loadChannelAccounts()
    } catch {
      /* 单次轮询失败继续等 */
    }
  }, 2500)
  loginTimers[id] = timer
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
      delete loginTimers[id]
      const next = { ...logins.value }
      delete next[id]
      logins.value = next
      await loadChannelAccounts()
    } catch {
      /* 单次轮询失败继续等 */
    }
  }, 3000)
  loginTimers[id] = timer
  onUnmounted(() => clearInterval(timer))
}

// 取消授权：只停掉前端的等待。
//   · WorkBuddy 走设备码：账号要等轮询成功才落盘，取消后服务端没有占位账号；
//   · 渠道包在发起登录时就登记了占位账号，用户若之后仍在浏览器完成授权，
//     账号照样会写进去（刷新即可看到），没授权成功则要手工删掉那条占位账号。
// 两种情况都跟「渠道账号」「账号池」两页的「停止等待」同一口径。
function cancelChannelLogin(id) {
  const timer = loginTimers[id]
  if (timer) {
    clearInterval(timer)
    delete loginTimers[id]
  }
  const next = { ...logins.value }
  delete next[id]
  logins.value = next
}

// 授权页一律交给系统浏览器：Electron 的内嵌窗口会被 OAuth 提供方拒绝
function openInBrowser(url) {
  if (!url) return
  if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url)
  else window.open(url, '_blank')
}

// ==================== 选择模型（多选 = 决定哪些模型开启） ====================

const switchError = ref('')
const busyRef = ref('')
// 目录加载中：期间不判「没有可用模型」，避免警告条闪现
const modelLoading = ref(false)

// 具体模型的来源分组。与「渠道账号 → 模型」页同一套口径：全量目录 =
// 渠道包 model.list + WorkBuddy 上游清单，disabled 由启用清单相减得到 ——
// 渠道源配置里只装已开启的模型，靠它列不出被关掉的那些
const CHANNEL_GROUP_NAMES = {
  workbuddy: 'WorkBuddy 国内版',
  'workbuddy-global': 'WorkBuddy 国际版',
  trae: 'Trae',
  qoder: 'Qoder 国际版',
  qodercn: 'Qoder 国内版'
}

// 组顺序与渠道模型页一致：WorkBuddy 两区在前，其余按渠道 id
const CHANNEL_GROUP_ORDER = ['workbuddy', 'workbuddy-global', 'trae', 'qoder', 'qodercn']

// 全量目录（含已关闭的模型）。组内模型行 { id, name, disabled, ref }，
// ref 是完整引用 `channels/<provider>/<模型 id>`，写回时按它分组
const modelGroups = ref([])

// 第 2 步的完成条件：至少启用一个模型。目录行上的 disabled 就是启用状态的
// 唯一事实来源（不另存一份勾选集合，否则必然和后端对不上）
const hasEnabledModel = computed(() =>
  modelGroups.value.some(group => group.models.some(m => !m.disabled))
)

async function loadModelCatalog() {
  modelLoading.value = true
  try {
  const byChannel = new Map()
  const push = (channel, row) => {
    if (!byChannel.has(channel)) byChannel.set(channel, [])
    byChannel.get(channel).push(row)
  }

  // 渠道包：model.list 回的就是全量目录（含 disabled 标记）
  await Promise.allSettled(
    CHANNEL_PROVIDERS.map(async provider => {
      const models = await channelsRpc('model.list', { provider })
      for (const m of Array.isArray(models) ? models : []) {
        push(provider, {
          id: m.id,
          name: m.name || m.id,
          disabled: !!m.disabled,
          ref: `channels/${provider}/${m.id}`
        })
      }
    })
  )

  // WorkBuddy 两区：上游全量 + 启用清单相减（与渠道模型页的 loadWorkbuddyModels 同口径）
  const enabledIds = {}
  await Promise.allSettled(
    Object.entries(WB_REGION_OF_GROUP).map(async ([group, region]) => {
      const reply = await wbEnabledModels(region)
      enabledIds[group] = new Set((reply?.models || []).map(m => m.id))
      let all = []
      try {
        all = (await wbModels(false, region)).models || []
      } catch {
        /* 上游拉不到（无账号 / 网络）：只列已启用的那部分 */
      }
      const byId = new Map(all.map(m => [m.id, m]))
      for (const m of reply?.models || []) {
        if (!byId.has(m.id)) byId.set(m.id, m)
      }
      for (const m of byId.values()) {
        push(group, {
          id: m.id,
          name: m.displayName || m.name || m.id,
          disabled: !enabledIds[group].has(m.id),
          ref: `channels/${group}/${m.id}`
        })
      }
    })
  )

  modelGroups.value = CHANNEL_GROUP_ORDER
    .filter(id => (byChannel.get(id) || []).length > 0)
    .map(id => ({
      id,
      name: CHANNEL_GROUP_NAMES[id] || id,
      models: byChannel.get(id).sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name))
    }))

  // 首次进入引导时把模型全部置为关闭，让用户自己挑一遍。
  // 只在本次安装里做一次：每次打开引导都重置会清掉用户已有的启用配置
  if (!modelDefaultsApplied()) {
    const results = await Promise.allSettled(modelGroups.value.map(async group => {
      group.models.forEach(model => { model.disabled = true })
      await saveGroupOf(`channels/${group.id}/`, [])
    }))
    // 全部写成功才记「已应用」：写失败了下次进这一步还要重来
    if (results.every(result => result.status === 'fulfilled')) {
      markModelDefaultsApplied()
    } else {
      switchError.value = '关闭部分模型失败，请重新打开对应模型后再关闭。'
    }
  }
  } finally {
    modelLoading.value = false
  }
}

// 渠道组 → 渠道包 provider id。WorkBuddy 两个区域走独立的启用清单接口，
// 其余走渠道包的 model.setEnabled
const CHANNEL_PROVIDERS = ['trae', 'qoder', 'qodercn']
const WB_REGION_OF_GROUP = { workbuddy: 'cn', 'workbuddy-global': 'global' }

// 某个组当前的启用清单：直接取自目录行的 disabled 标记（单一事实来源，
// 不再另存一份勾选集合 —— 另存必然和目录对不上）
function enabledIdsOf(group) {
  return group.models.filter(m => !m.disabled).map(m => m.id)
}

// 勾选 / 取消一个模型：先改本地目录行的 disabled（界面即时反馈），
// 再把这一组的完整启用清单写回后端
//（传完整清单，未勾的全部关闭 —— 与「渠道账号 → 模型」页的开关同一语义）
async function toggleModel(refKey) {
  if (busyRef.value) return
  busyRef.value = refKey
  switchError.value = ''
  const group = modelGroups.value.find(g => refKey.startsWith(`channels/${g.id}/`))
  const row = group?.models.find(m => m.ref === refKey)
  if (!row) return
  const previous = row.disabled
  row.disabled = !previous
  try {
    await saveGroupOf(refKey, enabledIdsOf(group))
  } catch (err) {
    // 写失败回滚开关态，别让界面显示一个后端并不认的状态
    row.disabled = previous
    switchError.value = '保存失败：' + (err?.message || err)
  } finally {
    busyRef.value = ''
  }
}

// 把某个组（按模型 id 前缀判定）的启用清单写回后端
async function saveGroupOf(refKey, ids) {
  const providerName = refKey.split('/')[1] || '' // channels/workbuddy/xxx → workbuddy
  if (WB_REGION_OF_GROUP[providerName]) return saveWbGroup(providerName, ids)
  if (!CHANNEL_PROVIDERS.includes(providerName)) return
  await channelsRpc('model.setEnabled', { provider: providerName, modelIds: ids })
}

// WorkBuddy 的启用清单要带上游定义（displayName / 上下文 / 输出上限）。
// 定义从本组件拉的全量目录里取（loadWorkbuddyModels 同口径）；允许清空一整组，
// 该区域没有开启的模型时渠道源里就没有这个区
async function saveWbGroup(group, ids) {
  const byId = new Map(
    (modelGroups.value.find(g => g.id === group)?.models || []).map(m => [m.id, m])
  )
  const models = ids.map(id => {
    const def = byId.get(id) || {}
    return {
      id,
      displayName: def.name || id,
      ...(def.maxContext ? { maxContext: def.maxContext } : {}),
      ...(def.maxOutput ? { maxOutput: def.maxOutput } : {})
    }
  })
  await wbSaveEnabledModels(models, WB_REGION_OF_GROUP[group])
}

// ==================== 一键接入信息 ====================

// 一键复制给 Agent 的完整接入信息：地址、Key、两种协议写法一次带走，
// 用户粘到对话框里就能用，不必自己拼
const connectSnippet = computed(
  () => `接入本机 AiRoute 网关（兼容 Anthropic 与 OpenAI）。
- Anthropic 地址：${localUrl.value}（ANTHROPIC_BASE_URL）
- OpenAI 兼容地址：${localUrl.value}/v1
- API Key：${API_KEY}
- 模型名随便填，实际用哪个由 AiRoute 决定
只改接入相关的键，然后跑一次
curl -s ${localUrl.value}/v1/models -H 'authorization: Bearer ${API_KEY}'
自检，并告诉我改了哪个文件。`
)

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
  // 没满足这一步的完成条件就不翻页：轻提示告诉他缺什么，不悄悄吞掉这次点击
  if (!canAdvance.value) {
    if (blockHint.value) showToast(blockHint.value, 'warn')
    return
  }
  if (stepIndex.value < STEPS.length - 1) stepIndex.value += 1
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
    // 全量目录依赖渠道登录结果：进这一步时重新拉一遍
    loadChannelAccounts()
    loadModelCatalog()
  } else if (key === 'agent') {
    // 地址与端口来自设置项，Agent 接入这一步必须先确认服务在线
    checkHealth()
    loadEnv()
    loadModelData()
  }
}

// 每一步进入时加载数据；也处理「直接打开到第 N 步」的入口。
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
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 24px 8px;
}

/* 内容层：按内容自然撑开，面板高度随之变化 */
.ob-measure {
  display: flex;
  flex-direction: column;
  gap: 0;
  height: max-content;
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

/* 目录加载中：中性一行字，不用警告样式（不是出了问题，只是还没回来） */
.ob-loading {
  min-height: 108px;
  display: flex;
  align-items: flex-start;
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--text-3);
  background: var(--bg-subtle);
  border-radius: var(--radius-md);
}

/* 分段控件的包裹层：只负责让控件按内容宽度收缩，不改变控件本身的观感 */
.ob-tabs {
  align-self: flex-start;
  max-width: 100%;
}

/* 五个渠道一排放不下时换行，而不是把面板撑宽或让标签被裁掉 */
.ob-tabs :deep(.seg) {
  flex-wrap: wrap;
  max-width: 100%;
}

/* 当前选中渠道的面板：随 SegmentedTabs 切换 */
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
  /* 固定行高：中英混排时行盒高度随字体回退而变（中文 20px / 拉丁 16.5px），
     切换 Tab 会让面板高度差几像素，垂直居中下看着就是抖动 */
  line-height: 20px;
}

.ob-channel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 「已登录」徽标与登录按钮占同一高度，登录态切换时行高不跳 */
  min-height: var(--btn-h);
}

/* 授权区块自己带边框与底色（OauthAuthBlock），这里只负责摆放：
   再套一层内边距与底色会变成「框里套框」 */
.ob-channel-login {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 主复制按钮：这一步只有一个动作要做，做大做显眼 */
.ob-primary-copy {
  align-self: stretch;
  padding: 10px 16px;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--bg-card);
  background: var(--primary);
  border-radius: var(--radius-sm);
}

.ob-primary-copy:hover {
  background: var(--primary-hover);
}

/* 模型选择：与「渠道账号 → 模型」页同一套样式 —— 开启实底实线、关闭虚线灰字，
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

/* 开启中：实底实线（与渠道模型页 .ch-model 一致）；
   关闭：透明底 + 虚线 + 灰字（与 .ch-model.off 一致），一眼能数出开着几个 */
.ob-model.off {
  font-weight: 400;
  color: var(--text-4);
  background: transparent;
  border-color: var(--border-2);
  border-style: dashed;
}

.ob-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
</style>

