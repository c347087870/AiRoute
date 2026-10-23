<template>
  <div class="ch-page">
    <!-- 页面头部：标题 + 汇总统计 + 刷新 -->
    <div class="page-header">
      <div class="ch-heading">
        <h1 class="page-title">渠道账号</h1>
        <!-- 说明文字很长，收进问号里：页面主体留给卡片，需要时点开看 -->
        <button
          class="ch-help"
          :class="{ active: showNote }"
          :aria-expanded="showNote"
          title="页面说明"
          @click.stop="showNote = !showNote"
        >
          <AppIcon name="help" />
        </button>
        <div v-if="showNote" class="ch-note-pop">
          <ul class="ch-note-list">
            <li>
              登录后该渠道的模型会以 <code>provider/model</code> 的形式出现在 <code>channels</code> 源里
              （配置引用形如 <code>channels/gemini/gemini-2.5-pro</code>）。
            </li>
            <li>
              没登录账号的渠道不播报模型，所以登录完要在「状态面板」里选中它
              （或让路由规则指向 <code>channels/…</code>）才会真正转发。
            </li>
            <li>
              WorkBuddy 同样是这里的一家（两个 provider：<code>workbuddy</code> 国内版 /
              <code>workbuddy-global</code> 国际版），模型引用形如 <code>channels/workbuddy/auto</code>；
              它的账号与积分由主进程的账号池管理，所以卡片上的按钮走 <code>/api/workbuddy/*</code>。
            </li>
            <li>拖动卡片标题左侧的手柄可以调整顺序，顺序只存在本机。</li>
            <li>
              账号行左侧的外链图标会用系统浏览器打开该渠道的个人中心 / 用量明细页（没填过的渠道用内置默认，
              Raccoon 没有默认；点卡片上的齿轮可以改成任意地址，改过的链接也只存本机）。
            </li>
          </ul>
        </div>
      </div>
      <div class="header-actions">
        <div class="ch-stats">
          <span class="stat">渠道 <b>{{ PROVIDERS.length }}</b></span>
          <span class="stat ok">账号 <b>{{ accounts.length + wbList.length }}</b></span>
          <span class="stat">模型 <b>{{ modelCount }}</b></span>
        </div>
        <button v-if="isCustomOrder" class="btn-ghost btn-sm" title="回到渠道包自带的顺序" @click="resetCardOrder">
          恢复默认顺序
        </button>
        <button class="btn-ghost btn-sm" :disabled="loading" @click="reload">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 运行时没起来时所有 RPC 都会失败，先把原因摆出来，别让用户对着空列表猜 -->
    <div v-if="runtimeState !== 'ready'" class="ch-alert">
      渠道运行时未就绪（{{ runtimeState }}）{{ runtimeError ? '：' + runtimeError : '' }}
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'accounts' }" @click="switchTab('accounts')">账号</button>
      <button class="tab" :class="{ active: tab === 'models' }" @click="switchTab('models')">模型</button>
    </div>

    <!-- ==================== Tab 1：账号 ==================== -->
    <template v-if="tab === 'accounts'">
      <!-- 拖拽的命中判定挂在网格上（不是每张卡）：动画里的卡片视觉位置会偏移，
           按事件目标判定会丢步，见 onDragOver 的注释 -->
      <div ref="gridEl" class="ch-grid" @dragover="onDragOver" @drop.prevent="onDrop()">
        <!-- WorkBuddy：渠道包里的第 11 家（模型目录由 worker 里的适配器代理到主进程，
             补全由 router 直通主进程的 forwardChat）。积分构成 / 成长任务 / 定时任务
             那些低频页面留在 /workbuddy 子页面，不往卡片里塞。 -->
        <div
          class="card ch-card"
          :class="cardClass('workbuddy')"
          :style="{ order: cardOrderIndex('workbuddy') }"
          :data-card-id="'workbuddy'"
        >
          <div class="ch-card-head">
            <div class="ch-title">
              <span
                class="ch-grip"
                draggable="true"
                title="拖动排序"
                @dragstart="onDragStart('workbuddy', $event)"
                @dragend="onDragEnd"
              >
                <AppIcon name="gripVertical" />
              </span>
              <span class="ch-name">WorkBuddy</span>
              <span class="ch-id mono">workbuddy</span>
            </div>
            <div class="ch-head-right">
              <span class="badge" :class="wbBadgeClass">{{ wbBadgeText }}</span>
            </div>
          </div>

          <div v-if="wbError" class="empty ch-bad">账号列表读取失败：{{ wbError }}</div>
          <div v-else-if="!wbList.length" class="empty">还没有账号</div>
          <div v-else class="ch-accounts">
            <div v-for="acct in wbList" :key="acct.uid" class="ch-account">
              <div class="ch-account-main">
                <div class="ch-account-name">
                  {{ acct.nickname || acct.uid.slice(0, 8) }}
                  <span class="ch-extra">{{ acct.realm === 'global' ? '国际版' : '国内版' }}</span>
                </div>
                <div class="ch-account-sub">
                  <span :class="wbStateClass(acct)">{{ wbStateLabel(acct) }}</span>
                  <span>积分 {{ acct.credits }}</span>
                  <span>今日 {{ formatToken(acct.tokenUsageToday) }} token</span>
                  <span v-if="acct.runningAction" class="text-muted">{{ wbRunningLabel(acct.runningAction) }}</span>
                </div>
              </div>
              <div class="ch-account-actions">
                <button
                  class="ch-icon-btn"
                  :title="`用浏览器打开${acct.realm === 'global' ? '国际版' : '国内版'}个人中心看明细`"
                  @click="openConsole('workbuddy', slotKeyOf('workbuddy', acct))"
                >
                  <AppIcon name="externalLink" />
                </button>
                <button
                  class="btn-ghost btn-sm"
                  :disabled="wbBusy === acct.uid + ':checkin' || acct.realm === 'global'"
                  :title="acct.realm === 'global' ? '国际版没有签到端点' : ''"
                  @click="wbCheckin(acct)"
                >
                  {{ wbBusy === acct.uid + ':checkin' ? '签到中…' : '签到' }}
                </button>
                <button
                  class="btn-ghost btn-sm"
                  :disabled="wbBusy === acct.uid + ':balance'"
                  @click="wbBalance(acct)"
                >
                  {{ wbBusy === acct.uid + ':balance' ? '查询中…' : '余额' }}
                </button>
                <button v-if="acct.cooling" class="btn-ghost btn-sm" @click="wbRevive(acct)">解冻</button>
                <button v-else-if="acct.disabled" class="btn-ghost btn-sm" @click="wbEnable(acct)">恢复</button>
                <button v-else class="btn-ghost btn-sm" @click="wbDisable(acct)">禁用</button>
                <button
                  class="btn-ghost btn-sm ch-danger"
                  :disabled="wbBusy === acct.uid + ':delete'"
                  @click="wbRemove(acct)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>

          <!-- 个人中心链接：默认值只有官方域名，用户可以改成准确的明细页 -->
          <ChannelLinkEditor
            v-if="linkEditor === 'workbuddy'"
            :slots="slotsOf('workbuddy')"
            :values="linkValuesOf('workbuddy')"
            @submit="draft => saveLinks('workbuddy', draft)"
            @reset="resetLinks('workbuddy')"
            @close="linkEditor = ''"
          />

          <!-- 登录中：和渠道卡片一样走页内区块，不弹窗 -->
          <div v-if="wbLogin" class="ch-login">
            <div class="ch-login-title">
              在浏览器中完成 WorkBuddy（{{ wbLogin.realm === 'global' ? '国际版' : '国内版' }}）授权
            </div>
            <div class="ch-login-url" :title="wbLogin.url">{{ wbLogin.url }}</div>
            <div class="ch-login-actions">
              <button class="btn-primary btn-sm" @click="wbOpenLoginUrl">打开授权链接</button>
              <button class="btn-ghost btn-sm" @click="wbCopyLoginUrl">复制链接</button>
              <button class="btn-ghost btn-sm" @click="wbCancelLogin">停止等待</button>
            </div>
            <div class="ch-login-status">
              {{ wbLogin.message || '等待浏览器完成授权，每 3 秒自动检测一次…' }}
            </div>
          </div>

          <div class="ch-actions">
            <button class="btn-primary btn-sm" :disabled="!!wbLogin || wbBusy === ':login'" @click="wbStartLogin">
              + 登录账号
            </button>
            <!-- 两个区域的域名与 OAuth 入口不同，登录前必须先选（同 ZCode 的处理） -->
            <select v-model="wbRealm" class="ch-select" :disabled="!!wbLogin">
              <option value="cn">国内版（copilot.tencent.com）</option>
              <option value="global">国际版（workbuddy.ai）</option>
            </select>
            <button
              class="btn-ghost btn-sm"
              :disabled="wbBusyAll !== '' || !wbCnCount"
              :title="wbCnCount ? '逐账号顺序签到（并发易触发上游风控）' : '国际版账号不支持签到'"
              @click="wbCheckinAll"
            >
              {{ wbBusyAll === 'checkin' ? '签到中…' : '全部签到' }}
            </button>
            <button class="btn-ghost btn-sm" :disabled="wbBusyAll !== ''" @click="wbRefreshBalances">
              {{ wbBusyAll === 'balance' ? '查询中…' : '刷新余额' }}
            </button>
            <button class="ch-icon-btn" title="设置个人中心链接" @click="toggleLinkEditor('workbuddy')">
              <AppIcon name="settings" />
            </button>
            <router-link to="/workbuddy" class="ch-more">积分 / 成长任务 / 定时任务 →</router-link>
          </div>
        </div>

        <div
          v-for="p in PROVIDERS"
          :key="p.id"
          class="card ch-card"
          :class="cardClass(p.id)"
          :style="{ order: cardOrderIndex(p.id) }"
          :data-card-id="p.id"
        >
          <!-- 卡头：渠道名 + 状态徽标 + 渠道级开关 -->
          <div class="ch-card-head">
            <div class="ch-title">
              <span
                class="ch-grip"
                draggable="true"
                title="拖动排序"
                @dragstart="onDragStart(p.id, $event)"
                @dragend="onDragEnd"
              >
                <AppIcon name="gripVertical" />
              </span>
              <span class="ch-name">{{ p.name }}</span>
              <span class="ch-id mono">{{ p.id }}</span>
            </div>
            <div class="ch-head-right">
              <span class="badge" :class="badgeClass(p)">{{ badgeText(p) }}</span>
              <label class="ch-switch" :title="switchTitle(p)">
                <input
                  type="checkbox"
                  class="ch-check"
                  :checked="!isClosed(p)"
                  :disabled="busyKey === p.id + ':enable'"
                  @change="toggleProvider(p, $event)"
                />
                <span class="ch-switch-text">{{ isClosed(p) ? '已关闭' : '启用' }}</span>
              </label>
            </div>
          </div>

          <!-- 账号列表 -->
          <div v-if="!accountsOf(p).length" class="empty">还没有账号</div>
          <div v-else class="ch-accounts">
            <div v-for="acct in accountsOf(p)" :key="acct.id" class="ch-account">
              <label class="ch-check-wrap" :title="acct.enabled === false ? '已停用：不参与选号' : '启用中'">
                <input
                  type="checkbox"
                  class="ch-check"
                  :checked="acct.enabled !== false"
                  :disabled="busyKey === acct.id + ':enable'"
                  @change="toggleAccount(acct, $event)"
                />
              </label>
              <div class="ch-account-main">
                <div class="ch-account-name">
                  {{ acct.nickname || acct.id }}
                  <span v-if="acct.accountName" class="ch-extra">{{ acct.accountName }}</span>
                  <span v-if="acct.phone" class="ch-extra mono">{{ acct.phone }}</span>
                </div>
                <div class="ch-account-sub">
                  <span>{{ expiryText(acct) }}</span>
                  <span v-if="acct.refreshable" class="ch-tag">可续期</span>
                  <span v-if="acct.refreshError" class="ch-tag bad" :title="acct.refreshError">刷新失败</span>
                </div>
              </div>
              <div class="ch-account-actions">
                <button class="ch-icon-btn" :title="`用浏览器打开 ${p.name} 个人中心看明细`" @click="openConsole(p.id, 'default')">
                  <AppIcon name="externalLink" />
                </button>
                <button class="btn-ghost btn-sm" :disabled="busyKey === acct.id + ':test'" @click="testAccount(acct)">
                  {{ busyKey === acct.id + ':test' ? '测试中…' : '测试' }}
                </button>
                <button
                  v-if="supportsOnboarding(p)"
                  class="btn-ghost btn-sm"
                  :disabled="busyKey === acct.id + ':onboarding'"
                  :title="p.id === 'loomy' ? 'Loomy 新手任务（一次性）' : 'Raccoon 桌面端登录奖励'"
                  @click="claimOnboarding(p, acct)"
                >
                  {{ busyKey === acct.id + ':onboarding' ? '领取中…' : '新手任务' }}
                </button>
                <button class="btn-ghost btn-sm ch-danger" :disabled="busyKey === acct.id + ':delete'" @click="removeAccount(acct)">
                  删除
                </button>
              </div>
            </div>
          </div>

          <!-- 个人中心链接：默认值只有官方域名，用户可以改成准确的明细页 -->
          <ChannelLinkEditor
            v-if="linkEditor === p.id"
            :slots="slotsOf(p.id)"
            :values="linkValuesOf(p.id)"
            @submit="draft => saveLinks(p.id, draft)"
            @reset="resetLinks(p.id)"
            @close="linkEditor = ''"
          />

          <!-- 登录中：授权链接 + 轮询状态（页内区块，不弹窗） -->
          <div v-if="login && login.provider === p.id" class="ch-login">
            <div class="ch-login-title">在浏览器中完成 {{ p.name }} 授权</div>
            <div class="ch-login-url" :title="login.url">{{ login.url }}</div>
            <div class="ch-login-actions">
              <button class="btn-primary btn-sm" @click="openLoginUrl">打开授权链接</button>
              <button class="btn-ghost btn-sm" @click="copyLoginUrl">复制链接</button>
              <button class="btn-ghost btn-sm" @click="cancelLogin">停止等待</button>
            </div>
            <div class="ch-login-status">
              {{ login.message || '等待浏览器完成授权，每 2.5 秒自动检测一次…' }}
            </div>
          </div>

          <!-- 操作行 -->
          <div class="ch-actions">
            <button
              class="btn-primary btn-sm"
              :disabled="!!login || busyKey === p.id + ':login'"
              @click="startLogin(p)"
            >
              + 登录账号
            </button>
            <!-- ZCode 有两个 OAuth 入口，凭据落点不同，登录前必须先选 -->
            <select v-if="p.id === 'zcode'" v-model="zcodeRealm" class="ch-select" :disabled="!!login">
              <option value="bigmodel">智谱开放平台（bigmodel.cn）</option>
              <option value="zai">z.ai 国际版（chat.z.ai）</option>
            </select>
            <button
              v-if="canClaim(p)"
              class="btn-ghost btn-sm"
              :disabled="creditBusy === p.id + ':claim'"
              title="逐账号顺序领取（并发易触发上游风控）"
              @click="claimCredits(p)"
            >
              {{ creditBusy === p.id + ':claim' ? '领取中…' : '领取积分' }}
            </button>
            <button
              class="btn-ghost btn-sm"
              :disabled="creditBusy === p.id + ':balance'"
              @click="loadBalances(p)"
            >
              {{ creditBusy === p.id + ':balance' ? '查询中…' : '余额' }}
            </button>
            <button class="ch-icon-btn" title="设置个人中心链接" @click="toggleLinkEditor(p.id)">
              <AppIcon name="settings" />
            </button>
          </div>

          <!-- 领取结果 -->
          <div v-if="claimResults[p.id]" class="ch-result">
            <div class="ch-result-line">{{ claimSummaryText(p, claimResults[p.id].summary) }}</div>
            <div v-for="row in claimResults[p.id].results" :key="row.accountId" class="ch-result-row">
              <span class="ch-result-name">{{ row.nickname }}</span>
              <span :class="outcomeClass(row.outcome)">{{ outcomeText(row.outcome) }}</span>
            </div>
          </div>

          <!-- 积分余额 -->
          <div v-if="balances[p.id]" class="ch-result">
            <div v-for="row in balances[p.id].accounts" :key="row.accountId" class="ch-result-row">
              <span class="ch-result-name">
                {{ row.nickname }}
                <span v-if="row.extra && row.extra.accountTier" class="ch-tag" :title="row.extra.accountTier.title">
                  {{ row.extra.accountTier.label }}
                </span>
              </span>
              <span v-if="row.balance">
                {{ formatCredit(row.balance.total) }}
                <span v-if="row.balance.expiredTotal > 0" class="text-muted">
                  （另有 {{ formatCredit(row.balance.expiredTotal) }} 已失效）
                </span>
              </span>
              <span v-else class="ch-bad">{{ row.error || '查询失败' }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== Tab 2：模型 ==================== -->
    <template v-else>
      <div class="card ch-models-card">
        <div class="ch-toolbar">
          <!-- 开关与测试的规则收进问号里：那几条只在第一次用时读一遍，
               常驻在页面上等于每次都在跟模型方块抢版面。
               浮层挂在按钮自己的定位上下文里，所以按钮外面套一层 span。 -->
          <span class="ch-help-wrap">
            <button
              class="ch-help"
              :class="{ active: showModelNote }"
              :aria-expanded="showModelNote"
              title="模型开关与测试说明"
              @click.stop="showModelNote = !showModelNote"
            >
              <AppIcon name="help" />
            </button>
            <div v-if="showModelNote" class="ch-note-pop">
              <ul class="ch-note-list">
                <li>
                  关掉的模型不会出现在 <code>/v1/models</code> 与对话的模型选择里，但配置还在，随时能开回来。
                  标「已失效」的是上游下线的系统推断，与你自己关掉是两回事 —— 点一下会清掉这条记录让它重新显示，
                  上游真下线的话请求仍会 404。
                </li>
                <li>
                  顶部「已开启模型」是拍平后的可调用清单（带渠道前缀），它们就是 <code>/v1/models</code>
                  与对话模型选择里的全部，点一下即可关闭；下面的分组则是全量目录 ——
                  一家渠道有几百条模型时，后者绝大多数是灰的。
                </li>
                <li>
                  工具栏的「全部开启 / 全部关闭」作用于所有渠道，每个渠道组头右侧那一对只作用于本渠道；
                  「快速开启」按模型家族一次打开被关掉的 Flash。
                </li>
                <li>
                  测试是逐个真实调用（渠道之间并发，同一渠道内串行 + 间隔，避免触发上游风控），绿点通过、红点失败，
                  悬停看延迟、错误与测试时间；传输层抖动会重试一次，业务错误和超时不重试。
                  结论存在本机，刷新和重启都还在，「清除标记」可以清空。
                </li>
              </ul>
            </div>
          </span>
          <button class="btn-ghost btn-sm" :disabled="modelsLoading" @click="loadModels">
            {{ modelsLoading ? '读取中…' : '重新读取目录' }}
          </button>
          <button
            class="btn-ghost btn-sm"
            :disabled="!!testRun || modelsLoading"
            :title="`把每个渠道里已启动的模型逐个真实调用一次，通过的标绿点、失败的标红点（渠道之间并发，同一渠道内串行 + 间隔，避免触发上游风控）`"
            @click="runModelTests('all')"
          >
            {{ testRun && testRun.scope === 'all' ? `测试中 ${testRun.done}/${testRun.total}` : '测试全部' }}
          </button>
          <button v-if="testRun" class="btn-ghost btn-sm" @click="testAbort = true">中止</button>
          <button
            v-else-if="testedModelCount"
            class="btn-ghost btn-sm"
            :title="`清除全部 ${testedModelCount} 个模型的测试标记，让下一次测试从干净状态开始`"
            @click="clearTestResults"
          >
            清除标记（{{ testedModelCount }}）
          </button>
          <!-- 批量开关靠右，和每个渠道组头那一排（测试/全部打开/全部关闭）对齐：
               它们是同一类操作，只是作用范围不同，位置一致才不会点错 -->
          <span class="ch-toolbar-right">
            <button
              class="btn-ghost btn-sm"
              :disabled="modelsLoading || !!busyKey || !!testRun || !modelGroups.length"
              :title="`打开所有渠道的全部模型（标「已失效」的不动，那是上游下线判定，要逐点点开才能复活）`"
              @click="setAllModelsEverywhere(false)"
            >
              {{ busyKey === 'all:on' ? '开启中…' : '全部开启' }}
            </button>
            <div class="ch-dd">
              <button
                class="btn-ghost btn-sm"
                :disabled="modelsLoading || !!busyKey"
                :aria-expanded="flashMenuOpen"
                :title="flashOffModels.length
                  ? `按家族一次打开被关掉的 Flash 模型（当前共 ${flashOffModels.length} 个待开启）；标「已失效」的不动，那种是上游下线判定，点模型本身才能重新显示`
                  : '当前没有处于关闭状态的 Flash 模型'"
                @click="flashMenuOpen = !flashMenuOpen"
              >
                {{ busyKey === 'flash' ? '开启中…' : '快速开启' }}
                <span class="ch-dd-caret" :class="{ open: flashMenuOpen }">▾</span>
              </button>
              <div v-if="flashMenuOpen" class="ch-dd-menu">
                <button
                  v-for="item in flashMenu"
                  :key="item.key"
                  class="ch-dd-item"
                  :disabled="!item.off"
                  @click="enableFlashFamily(item.key)"
                >
                  <span>{{ item.label }}</span>
                  <span class="ch-dd-note">{{ item.off ? `${item.off} / ${item.total}` : `已全开（${item.total}）` }}</span>
                </button>
                <span v-if="!flashMenu.length" class="ch-dd-empty">目录里没有名字带 Flash 的模型</span>
              </div>
            </div>
            <button
              class="btn-ghost btn-sm"
              :disabled="modelsLoading || !!busyKey || !!testRun || !modelGroups.length"
              :title="`关闭所有渠道的全部模型：关掉的模型会从 /v1/models 和对话的模型选择里消失，但配置还在，随时能再开回来`"
              @click="setAllModelsEverywhere(true)"
            >
              {{ busyKey === 'all:off' ? '关闭中…' : '全部关闭' }}
            </button>
          </span>
        </div>

        <div v-if="!modelGroups.length" class="empty">
          没有读到任何渠道模型目录 —— 点「重新读取目录」重试；长期为空说明渠道运行时没起来（见页头提示）。
        </div>

        <!-- 已开启模型：跨渠道拍平的好模型清单。
             下面的分组是**全量目录**（cline 一家就 493 条，绝大多数是灰的），
             而用户真正要回答的问题只有一个：我的客户端现在能选到哪些模型。
             这一块就是那个问题的答案，所以放在全量目录之前。 -->
        <div v-if="modelGroups.length" class="ch-enabled-block">
          <div class="ch-model-group-head">
            <span class="ch-name">已开启模型</span>
            <span class="text-muted">共 <span class="ch-ok">{{ enabledModels.length }}</span> 个</span>
          </div>
          <div v-if="enabledModels.length" class="ch-models">
            <button
              v-for="row in enabledModels"
              :key="row.provider + '/' + row.model.id"
              class="ch-model"
              :title="modelTitle(row.provider, row.model)"
              @click="toggleModel(row.provider, row.model)"
            >
              <span class="ch-model-src">{{ row.provider }}</span>
              <span class="ch-model-name">{{ row.model.name || row.model.id }}</span>
              <span
                v-if="modelTestResults[row.provider + '/' + row.model.id]"
                class="ch-dot"
                :class="modelTestResults[row.provider + '/' + row.model.id].ok ? 'ok' : 'bad'"
              ></span>
              <span v-if="row.model.isFree" class="ch-tag free">免费</span>
            </button>
          </div>
          <div v-else class="text-muted ch-enabled-empty">
            当前没有任何模型处于开启状态 —— 用下面各渠道的「全部打开」，或工具栏的「全部开启」。
          </div>
        </div>

        <div v-for="group in modelGroups" :key="group.id" class="ch-model-group">
          <div class="ch-model-group-head">
            <span class="ch-name">{{ group.name }}</span>
            <span class="text-muted">
              {{ group.models.length }} 个，已开启 <span class="ch-ok">{{ group.enabledCount }}</span>，已关闭 {{ group.disabledCount }}<template
                v-if="group.deadCount"
              >，已失效 {{ group.deadCount }}</template>
            </span>
            <span class="ch-group-actions">
              <button
                class="btn-ghost btn-sm"
                :disabled="!!testRun || !!busyKey"
                :title="`逐个真实调用这个渠道里已启动的模型，通过的标绿点（串行 + 间隔，避免触发上游风控）`"
                @click="runModelTests(group.id)"
              >
                {{ testRun && testRun.scope === group.id ? `测试中 ${testRun.done}/${testRun.total}` : '测试' }}
              </button>
              <button class="btn-ghost btn-sm" :disabled="!!busyKey" @click="setAllModels(group.id, false)">全部打开</button>
              <button class="btn-ghost btn-sm" :disabled="!!busyKey" @click="setAllModels(group.id, true)">全部关闭</button>
            </span>
          </div>
          <div class="ch-models">
            <button
              v-for="m in group.models"
              :key="m.id"
              class="ch-model"
              :class="{ off: m.disabled, dead: m.dead }"
              :title="modelTitle(group.id, m)"
              @click="toggleModel(group.id, m)"
            >
              <span class="ch-model-name">{{ m.name || m.id }}</span>
              <!-- 测试结论：绿点=通过、红点=失败；细节（延迟/错误）在按钮的 title 里 -->
              <span
                v-if="modelTestResults[group.id + '/' + m.id]"
                class="ch-dot"
                :class="modelTestResults[group.id + '/' + m.id].ok ? 'ok' : 'bad'"
              ></span>
              <span v-if="m.isFree" class="ch-tag free">免费</span>
              <span v-if="m.dead" class="ch-tag bad">已失效</span>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { showToast } from '../composables/useToast.js'
import AppIcon from '../components/AppIcon.vue'
import ChannelLinkEditor from '../components/ChannelLinkEditor.vue'
import { slotsOf, linkKeyOf, readCustomLinks, saveCustomLinks } from '../utils/channel-links.js'
import { channelsStatus, channelsRefresh, channelsRpc, channelsTest } from '../api.js'
// WorkBuddy 走独立的一组端点（/api/workbuddy/*），和渠道包 RPC 是两套账号体系。
// 函数名统一加 wb 前缀并与本页已有的 removeAccount / testAccount 等区分开。
import {
  wbAccounts as fetchWbAccounts,
  wbOauthStart,
  wbOauthPoll,
  wbCheckin as wbCheckinApi,
  wbRefreshBalance,
  wbRefreshAllBalances,
  wbRemoveAccount,
  wbDisable as wbDisableApi,
  wbEnable as wbEnableApi,
  wbRevive as wbReviveApi,
  wbSchedulerRun,
  wbModels as wbUpstreamModels,
  wbEnabledModels,
  wbSaveEnabledModels
} from '../api.js'

// 十个渠道的 id 与展示名（id 取自渠道包各 product 配置，展示名照抄 displayName）
const PROVIDERS = [
  { id: 'lobsterai', name: 'LobsterAI (有道)' },
  { id: 'qoder', name: 'Qoder' },
  { id: 'qodercn', name: 'Qoder (中国版)' },
  { id: 'trae', name: 'TRAE (字节)' },
  { id: 'cline', name: 'Cline' },
  { id: 'loomy', name: 'Loomy (讯飞)' },
  { id: 'raccoon', name: 'Raccoon (商汤)' },
  { id: 'minimax', name: 'MiniMax Code' },
  { id: 'zcode', name: 'ZCode (智谱)' },
  { id: 'gemini', name: 'Gemini Code Assist' }
]

// 只有这两家有「新手任务 / 登录奖励」端点（onboarding.status 只认这两个 provider）
const ONBOARDING_PROVIDERS = ['loomy', 'raccoon']
// Gemini 没有签到端点（credits.claimAll 里没有它的分支），别给它一个必然失败的按钮
const NO_CLAIM_PROVIDERS = ['gemini']

// WorkBuddy 在渠道包里是「只提供目录」的适配器（见 server/channels/worker.mjs），
// 而那份目录就是它的**启用清单** —— 已关掉的模型根本没进渠道目录，所以模型页不能
// 靠 model.list 拿它（对 workbuddy 调 model.list 会回 provider-unsupported），
// 只能单独走 /api/workbuddy/*：上游全量算出「有哪些可选」，启用清单算出「现在开着哪些」。
const WB_MODEL_PROVIDERS = [
  { id: 'workbuddy', name: 'WorkBuddy（国内版）', region: 'cn' },
  { id: 'workbuddy-global', name: 'WorkBuddy（国际版）', region: 'global' }
]
const WB_REGION_OF = Object.fromEntries(WB_MODEL_PROVIDERS.map(item => [item.id, item.region]))

// 模型页的组顺序：WorkBuddy 两个区域在最前（与账号卡片的第一张一致），其余按 PROVIDERS
const MODEL_GROUP_PROVIDERS = [
  ...WB_MODEL_PROVIDERS,
  ...PROVIDERS.map(provider => ({ id: provider.id, name: provider.name, region: '' }))
]

// ==================== 卡片排序 ====================
// 「先看哪个来源」纯粹是这个用户的使用习惯，跟转发逻辑无关，所以存 localStorage
// 而不是后端 state.json —— 那份是全局配置，换个客户端就被别人的顺序覆盖了。
const ORDER_KEY = 'airoute.channels-card-order'
const DEFAULT_ORDER = ['workbuddy', ...PROVIDERS.map(p => p.id)]

function loadSavedOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
    // 过滤掉已经不存在的 id（渠道包升级删了某个 provider 时，旧顺序里会留着它）
    if (Array.isArray(raw)) return raw.filter(id => DEFAULT_ORDER.includes(id))
  } catch {
    /* 存坏了就当没存过，不值得为一条排序偏好报错 */
  }
  return []
}

const savedOrder = ref(loadSavedOrder())

// 保存的顺序可能缺项（新版本多了一个 provider），所以按「已保存的在前、
// 没提到的按默认顺序补在末尾」合并，别让新渠道因为没被排过就消失
const cardOrder = computed(() => {
  const seen = new Set(savedOrder.value)
  return [...savedOrder.value, ...DEFAULT_ORDER.filter(id => !seen.has(id))]
})

const isCustomOrder = computed(() => savedOrder.value.length > 0)

// 用 CSS 的 order 属性排版，而不是把 11 张卡重构成一个 v-for：
// 渠道卡片模板里引用了大量 provider 字段，重排 DOM 结构收益不大、风险不小
function cardOrderIndex(id) {
  const i = cardOrder.value.indexOf(id)
  return i < 0 ? DEFAULT_ORDER.length : i
}

// 拖动时实时重排（不是等放手才变）：划到哪张卡上，那张卡立刻让位。
// 拖拽期间不做 FLIP 动画（原因见 flipCards），卡片瞬时落位，命中判定才和看到的一致。
const gridEl = ref(null)
const dragId = ref('')
let orderDirty = false
// 上一次真正换位时指针的位置：卡片高度不一致时，换位会让整列上下挪，
// 指针原地不动也会落到另一张卡上 —— 不设这道闸就会自己往下窜好几格
let lastSwapPoint = null

const cardClass = id => ({ dragging: dragId.value === id })

// FLIP：改 order 前先量一遍每张卡的位置，改完再量一遍，用差值做一次反向位移动画。
// CSS grid 的重排是瞬间跳变的，没有这一步就只剩「闪一下」。
//
// 动画期间卡片的视觉位置与布局位置会短暂不一致，所以命中判定不能用事件目标或
// getBoundingClientRect()（见 layoutBoxOf）；拖拽时动画短一点，跟手比好看重要。
async function flipCards(mutate) {
  const grid = gridEl.value
  if (!grid) {
    mutate()
    return
  }
  const cards = [...grid.querySelectorAll('.ch-card')]
  const before = new Map(cards.map(el => [el, el.getBoundingClientRect()]))
  mutate()
  await nextTick()
  for (const el of cards) {
    const from = before.get(el)
    if (!from) continue
    const to = el.getBoundingClientRect()
    const dx = from.left - to.left
    const dy = from.top - to.top
    if (!dx && !dy) continue
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: dragId.value ? 120 : 160, easing: 'ease-out' }
    )
  }
}

// 拖拽过程中只改内存顺序，落手时才写 localStorage —— 否则每划过一张卡就写一次盘。
// 但落手事件不保证到来（拖出窗口/Electron 标题栏时 dragover/dragend 可能都不发），
// 所以换位后再补一次去抖落盘：拖拽被系统打断也不会丢顺序。
function persistOrder() {
  if (!orderDirty) return
  orderDirty = false
  clearTimeout(persistTimer)
  localStorage.setItem(ORDER_KEY, JSON.stringify(cardOrder.value))
}

let persistTimer = null
function schedulePersist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(persistOrder, 300)
}

function resetCardOrder() {
  flipCards(() => {
    savedOrder.value = []
  })
  orderDirty = false
  localStorage.removeItem(ORDER_KEY)
}

function onDragStart(id, e) {
  dragId.value = id
  orderDirty = false
  lastSwapPoint = null
  e.dataTransfer.effectAllowed = 'move'
  // Firefox 不 setData 就不认这次拖拽
  e.dataTransfer.setData('text/plain', id)
  // 手柄只有十几像素，不换拖影的话用户拖动时看到的是一个小图标而不是卡片
  const card = e.currentTarget.closest('.ch-card')
  if (card) e.dataTransfer.setDragImage(card, 24, 24)
}

// 卡片在**布局**里的盒子（不受 FLIP 动画的 transform 影响）。
// 用 offsetLeft/offsetTop 而不是 getBoundingClientRect()：动画期间 rect 是
// 「飞行中」的位置，拿它算落点会丢步，或者在两张卡之间反复横跳。
function layoutBoxOf(el) {
  const parent = el.offsetParent || gridEl.value
  if (!parent) return null
  const base = parent.getBoundingClientRect()
  const left = base.left + el.offsetLeft - parent.scrollLeft
  const top = base.top + el.offsetTop - parent.scrollTop
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight }
}

// 命中判定挂在网格上而不是每张卡上：卡片在动画中会跑到指针下面，事件目标不可信；
// 这里只认「指针的布局坐标落在哪张卡的布局盒子里」。
function onDragOver(e) {
  if (!dragId.value) return
  e.preventDefault() // 不拦截就没有 drop 事件
  e.dataTransfer.dropEffect = 'move'
  const grid = gridEl.value
  if (!grid) return
  // 指针没动过就不换位：只可能是上一步换位把整列挪了，不是用户的操作
  if (lastSwapPoint) {
    if (Math.abs(e.clientX - lastSwapPoint.x) < 4 && Math.abs(e.clientY - lastSwapPoint.y) < 4) return
  }
  let targetId = ''
  for (const el of grid.querySelectorAll('.ch-card')) {
    const id = el.dataset.cardId
    // 落在被拖的卡片自己的槽位上 = 回到原位，不用动
    if (!id || id === dragId.value) continue
    const box = layoutBoxOf(el)
    if (!box) continue
    if (e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom) {
      targetId = id
      break
    }
  }
  if (!targetId) return
  const list = [...cardOrder.value]
  const from = list.indexOf(dragId.value)
  const to = list.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return
  // 换位后把被拖的卡片放到目标的槽位，指针下面立刻变成被拖的卡片自己 ——
  // 下一次 dragover 命中它就被上面那行挡掉，所以不需要额外的「防抖目标」记录；
  // 反过来，那个记录会让「划回去」失效（目标 id 还没变），拖拽忽灵忽不灵就是这么来的
  list.splice(to, 0, list.splice(from, 1)[0])
  lastSwapPoint = { x: e.clientX, y: e.clientY }
  flipCards(() => {
    savedOrder.value = list
  })
  orderDirty = true
  schedulePersist()
}

function onDrop() {
  persistOrder()
}

function onDragEnd() {
  // 拖到卡片外面松手也算数：预览出来的顺序就是最终顺序，不再回滚。
  // （没有「按 Esc 撤销」：原生拖拽期间拿不到 keydown，硬做只会半吊子）
  persistOrder()
  dragId.value = ''
  lastSwapPoint = null
}

const tab = ref('accounts')
const loading = ref(false)
// 页面说明收在标题旁的问号后面：那段文字只有一个用途（第一次用时读一遍），
// 常驻在页面上等于每次都在跟卡片抢地方
const showNote = ref(false)
// 模型页的问号另开一个：两个浮层说明的是不同的东西（这个页面/模型页的开关与测试），
// 共用一个 ref 会出现「点开模型页的说明，页头那段也一起弹出来」
const showModelNote = ref(false)
const runtimeState = ref('ready')
const runtimeError = ref('')
const modelCount = ref(0)
// provider id → { models:{total,disabled}, accounts:{total,enabled}, closed }
const statuses = ref({})
// 全部渠道账号摊平后的一份（按 provider 分组展示，但只发一轮请求）
const accounts = ref([])

const login = ref(null) // { provider, accountId, url, message }
const zcodeRealm = ref('bigmodel') // ZCode 的 OAuth 入口：bigmodel（国内）/ zai（国际）
const busyKey = ref('') // 行内/卡内按钮的互斥键，形如 `${id}:${action}`
const creditBusy = ref('')
const claimResults = ref({}) // provider → { results, summary }
const balances = ref({}) // provider → { accounts, windowDays }
const modelsByProvider = ref({}) // provider → RpcModelListEntry[]
// WorkBuddy 的模型行与「上游全量」分开存：行用于渲染（和渠道包同结构），
// 上游全量用于保存启用清单时补齐 displayName / maxContext 等字段
const wbModelRows = ref({}) // provider id → RpcModelListEntry[]
const wbUpstreamByRegion = ref({}) // region → 上游模型全量
const modelsLoading = ref(false)
const flashMenuOpen = ref(false) // 「快速开启」下拉的展开态
// 模型测试：testRun 非空即「正在跑」，null 表示空闲
//   { scope: 'all' | providerId, done, total }
const testRun = ref(null)
const testAbort = ref(false) // 「中止」标记：循环里只决定「还要不要开始下一个」
// 键是 `provider/modelId` → { ok, latency, error, at }
// 落本机 localStorage：跑通过一次就一直绿（直到下一次失败），刷新/重启都还在。
// 它是「我这台机器上试过什么」的本地记录，不跟渠道包的数据目录走 ——
// 渠道状态是账号池的事实，测试结论只是观察结果，两者混在同一个文档里迟早互相干扰。
const modelTestResults = ref(readTestResults())
const testedModelCount = computed(() => Object.keys(modelTestResults.value).length)

let loginTimer = null
let loginDeadline = 0

// ==================== WorkBuddy 免费账号 ====================
// 和上面的渠道账号是两套后端：渠道走 worker 里的渠道包 RPC，WorkBuddy 走本地
// /api/workbuddy/* 的账号池。放在同一张卡片网格里只是 UI 并列，数据不要混。
const wbList = ref([])
const wbCounts = ref({ total: 0, healthy: 0, cooling: 0, disabled: 0 })
const wbRealm = ref('cn') // 国内版 / 国际版：域名与 OAuth 入口不同
const wbLogin = ref(null) // { state, url, realm, message }
const wbBusy = ref('') // `${uid}:${action}`
const wbBusyAll = ref('') // '' | 'checkin' | 'balance'
const wbError = ref('')
let wbLoginTimer = null

// ==================== 读取 ====================

// 渠道包没有「列全部账号」的方法：account.list 按 provider 过滤，payload 里
// 缺 provider 时会过滤成空数组。所以先拿 provider.status 的账号计数，
// 只对有账号的渠道发 account.list —— 没账号的渠道本来也没有行要渲染。
async function loadStatus() {
  const status = await channelsStatus()
  runtimeState.value = status.state || 'unavailable'
  runtimeError.value = status.error || ''
  modelCount.value = status.models || 0
  // provider.status 只读账号池的进程内副本，不联网，10 个渠道一次拿全
  const { statuses: list } = await channelsRpc('provider.status', { providers: PROVIDERS.map(p => p.id) })
  statuses.value = list || {}
}

async function reload() {
  loading.value = true
  try {
    await loadStatus()
    const targets = PROVIDERS.filter(p => (statuses.value[p.id]?.accounts?.total || 0) > 0)
    const failed = []
    const lists = await Promise.all(targets.map(async p => {
      try {
        const { accounts: rows } = await channelsRpc('account.list', { provider: p.id })
        return rows || []
      } catch (err) {
        failed.push(p.id)
        return []
      }
    }))
    accounts.value = lists.flat()
    if (failed.length) showToast(`部分渠道账号读取失败：${failed.join('、')}`, 'error', 6000)
    // WorkBuddy 是另一套后端，失败自己兜（见 loadWorkbuddy），不能连带整页报错
    await loadWorkbuddy()
    // 目录是服务启动时在后台采集的，首屏可能还没采完（此时 channels 源里的模型数还是 0）。
    // 已有账号却报 0，说明采集没跟上 —— 补一次同步，让头部统计与 Provider 配置立刻对上
    if (accounts.value.length > 0 && modelCount.value === 0) await syncCatalog()
  } catch (err) {
    showToast('读取渠道状态失败：' + err.message, 'error', 6000)
  } finally {
    loading.value = false
  }
}

// 重新采集目录并同步进 channels 源。失败只在控制台留痕：这是页面自己发起的
// 补同步，用户没点任何按钮，弹 toast 只会变成一条莫名其妙的报错
async function syncCatalog() {
  try {
    await channelsRefresh()
    await loadStatus()
  } catch (err) {
    console.warn('[channels] 目录同步失败：', err.message)
  }
}

async function loadModels() {
  modelsLoading.value = true
  try {
    // 只为「目录里有模型」的渠道读明细：provider.status 的 models.total 是内存计数，
    // 未登录的渠道恒为 0，读它只会白等一次远端目录采集
    const targets = PROVIDERS.filter(p => (statuses.value[p.id]?.models?.total || 0) > 0)
    const failed = []
    const entries = await Promise.all(targets.map(async p => {
      try {
        const { models } = await channelsRpc('model.list', { provider: p.id })
        return [p.id, models || []]
      } catch (err) {
        failed.push(p.id)
        return [p.id, []]
      }
    }))
    modelsByProvider.value = Object.fromEntries(entries)
    if (failed.length) showToast(`部分渠道模型目录读取失败：${failed.join('、')}`, 'error', 6000)
    // WorkBuddy 不在渠道包目录里，要单独拉一次再并进来（见下面的注释）
    await loadWorkbuddyModels()
    modelsByProvider.value = { ...modelsByProvider.value, ...wbModelRows.value }
  } finally {
    modelsLoading.value = false
  }
}

// 拉 WorkBuddy 两个区域的模型：上游全量（有哪些可选）+ 启用清单（现在开着哪些），
// 相减得到 disabled。没有账号的区域后端回 503 —— 那种「这个源还不存在」的情况
// 不占一个空组，直接不显示。
async function loadWorkbuddyModels() {
  const rows = {}
  const upstream = {}
  await Promise.all(WB_MODEL_PROVIDERS.map(async ({ id, region }) => {
    try {
      const enabledReply = await wbEnabledModels(region)
      const enabledIds = new Set((enabledReply.models || []).map(m => m.id))
      let all = []
      try {
        all = (await wbUpstreamModels(false, region)).models || []
      } catch {
        // 上游拉取失败（该区域没账号 / 网络）：只能列出已启用的那部分，
        // 界面上表现为「看不到被关掉的模型」，不影响开关现有模型
      }
      // 两份清单合并：上游漏掉的（静态兜底表与上游有出入）也补进来，
      // 否则一个正在启用的模型会在列表里凭空消失
      const byId = new Map(all.map(model => [model.id, model]))
      for (const model of enabledReply.models || []) {
        if (!byId.has(model.id)) byId.set(model.id, model)
      }
      const list = [...byId.values()]
      if (!list.length) {
        // 启用清单被清空、上游又拉不到（该区域没账号）：界面上没有任何可列的模型。
        // 不弹 toast —— 每次进模型页都会响一次，代价比收益大
        console.warn(`[channels] ${region} 区域读不到 WorkBuddy 模型清单（无可用账号？）`)
        return
      }
      upstream[region] = list
      rows[id] = list.map(model => ({
        id: model.id,
        name: model.displayName || model.name || model.id,
        disabled: !enabledIds.has(model.id),
        dead: false
      }))
    } catch {
      /* 该区域没有账号：不显示这个组 */
    }
  }))
  wbUpstreamByRegion.value = upstream
  wbModelRows.value = rows
}

async function switchTab(next) {
  tab.value = next
  flashMenuOpen.value = false
  if (next === 'models') await loadModels()
}

// ==================== 登录 ====================

// 授权页一律交给系统默认浏览器：Electron 的 window.open 会开一个内嵌窗口，
// 而 Google 等 OAuth 提供方会拒绝带 Electron UA 的内嵌浏览器。
// 浏览器模式（vite dev）没有 electronAPI，退回 window.open
function openInBrowser(url) {
  if (!url) return
  if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url)
  else window.open(url, '_blank')
}

// ==================== 个人中心 / 明细 ====================
// 链接来自 utils/channel-links.js：默认值只放能确证的官方域名，用户可以改，
// 覆盖值存在本机。放在这里而不是子组件里，是因为卡片上的按钮也读它，
// 保存后要立刻反映到「明细」按钮的可用状态上。

const customLinks = ref(readCustomLinks())
const linkEditor = ref('') // 正在编辑链接的 provider id，空表示没展开

// WorkBuddy 的国内版 / 国际版是两个站点，别的渠道只有一个入口
function slotKeyOf(providerId, acct) {
  if (providerId === 'workbuddy') return acct?.realm === 'global' ? 'global' : 'cn'
  return 'default'
}

function consoleUrlOf(providerId, slotKey) {
  const slot = slotsOf(providerId).find(item => item.key === slotKey)
  const custom = (customLinks.value[linkKeyOf(providerId, slotKey)] || '').trim()
  return custom || slot?.url || ''
}

// 已保存的覆盖值，传给编辑器当回填
function linkValuesOf(providerId) {
  const out = {}
  for (const slot of slotsOf(providerId)) {
    const value = customLinks.value[linkKeyOf(providerId, slot.key)]
    if (value) out[slot.key] = value
  }
  return out
}

function toggleLinkEditor(providerId) {
  linkEditor.value = linkEditor.value === providerId ? '' : providerId
}

function openConsole(providerId, slotKey) {
  const url = consoleUrlOf(providerId, slotKey)
  if (!url) {
    // 没有默认值的渠道（目前只有 Raccoon）：直接把编辑框打开，别让用户猜
    linkEditor.value = providerId
    showToast('这家还没有内置链接，先填一个个人中心地址', 'error', 3500)
    return
  }
  openInBrowser(url)
}

function saveLinks(providerId, draft) {
  const next = { ...customLinks.value }
  for (const slot of slotsOf(providerId)) {
    const value = String(draft[slot.key] || '').trim()
    if (value) next[linkKeyOf(providerId, slot.key)] = value
    else delete next[linkKeyOf(providerId, slot.key)]
  }
  customLinks.value = next
  saveCustomLinks(next)
  linkEditor.value = ''
  showToast('个人中心链接已保存')
}

function resetLinks(providerId) {
  const next = { ...customLinks.value }
  for (const slot of slotsOf(providerId)) delete next[linkKeyOf(providerId, slot.key)]
  customLinks.value = next
  saveCustomLinks(next)
  showToast('已恢复内置默认链接')
}

async function startLogin(p) {
  if (login.value) return
  busyKey.value = p.id + ':login'
  try {
    const payload = { provider: p.id }
    // ZCode 有两个 OAuth 入口，凭据落点不同，必须由用户选（缺省是智谱开放平台）
    if (p.id === 'zcode') payload.zcodeProvider = zcodeRealm.value
    const started = await channelsRpc('account.create', payload)
    login.value = { provider: p.id, accountId: started.accountId, url: started.loginUrl, message: '' }
    // 渠道包已经起好本地回调页/授权页，这里直接交给系统浏览器；
    // 没打开的话用户还能用下面那块里的「打开授权链接」按钮
    openInBrowser(started.loginUrl)
    try {
      await navigator.clipboard.writeText(started.loginUrl)
      login.value.message = '授权链接已复制，浏览器没自动打开时可手动粘贴'
    } catch {
      /* 剪贴板不可用就忽略，URL 在下面一块里可选中复制 */
    }
    startPolling()
    // 渠道包在发起登录时就登记了占位账号，刷新一下让用户看到「这一行在等授权」
    await reload()
  } catch (err) {
    showToast(`发起 ${p.name} 登录失败：` + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

function startPolling() {
  stopPolling()
  loginDeadline = Date.now() + 5 * 60 * 1000
  loginTimer = setInterval(pollLogin, 2500)
}

function stopPolling() {
  if (loginTimer) {
    clearInterval(loginTimer)
    loginTimer = null
  }
}

async function pollLogin() {
  const cur = login.value
  if (!cur) return stopPolling()
  if (Date.now() > loginDeadline) {
    stopPolling()
    login.value = null
    showToast('等待授权超时：浏览器里没有完成登录（占位账号可用「删除」清掉）', 'error', 8000)
    await reload()
    return
  }
  try {
    // provider 在类型上是必填的（服务端只用 accountId，但别依赖这个实现细节）
    const state = await channelsRpc('login.poll', { accountId: cur.accountId, provider: cur.provider })
    if (!state.done) return
    stopPolling()
    login.value = null
    if (state.success) {
      showToast('登录成功，正在同步模型目录…')
      // 服务端在 login.* 之后也会排一次目录同步，这里显式刷一次让界面立刻更新
      try {
        await channelsRefresh()
      } catch (err) {
        // 不吞掉：目录没同步上，用户会以为登录白做了（reload 里还会再补一次）
        showToast('目录同步失败，点「刷新」重试：' + err.message, 'error', 6000)
      }
      await reload()
      if (tab.value === 'models') await loadModels()
    } else {
      showToast('登录失败：' + (state.error || '浏览器端未完成授权'), 'error', 6000)
      await reload()
    }
  } catch {
    /* 单次轮询失败（服务重启等）继续等，超时兜底 */
  }
}

function cancelLogin() {
  // 只能停止前端等待：渠道包在 worker 里的登录流程会继续，
  // 用户若之后仍在浏览器完成授权，账号照样会写进去（刷新即可看到）。
  // 没授权成功的话，渠道包会留下那条「无凭据的占位账号」，只能手工删掉
  stopPolling()
  login.value = null
  showToast('已停止等待：浏览器里完成授权后点「刷新」即可看到账号，否则请删掉那条占位账号')
}

function openLoginUrl() {
  if (login.value) openInBrowser(login.value.url)
}

async function copyLoginUrl() {
  if (!login.value || !login.value.url) return
  try {
    await navigator.clipboard.writeText(login.value.url)
    showToast('授权链接已复制')
  } catch {
    showToast('复制失败，请手动选中复制', 'error')
  }
}

// ==================== 账号 ====================

function accountsOf(p) {
  return accounts.value.filter(a => a.provider === p.id)
}

function isClosed(p) {
  return statuses.value[p.id]?.closed === true
}

function badgeText(p) {
  const st = statuses.value[p.id]
  if (!st || !st.accounts || st.accounts.total === 0) return '未登录'
  if (st.accounts.enabled === 0) return `${st.accounts.total} 个（全停用）`
  return `${st.accounts.enabled}/${st.accounts.total} 账号`
}

function badgeClass(p) {
  const st = statuses.value[p.id]
  if (!st || !st.accounts || st.accounts.total === 0) return 'warn'
  if (isClosed(p)) return 'bad'
  return 'ok'
}

function switchTitle(p) {
  const st = statuses.value[p.id]
  const models = st ? st.models.total : 0
  // 语义照渠道包：关闭 = 关掉全部模型 + 停用全部账号；打开 = 清空黑名单 + 启用全部账号
  return `渠道级开关：关闭会关掉该渠道全部模型（当前 ${models} 个）并停用全部账号；`
    + '打开会清空模型黑名单并启用全部账号'
}

async function toggleProvider(p, event) {
  const enabled = event.target.checked
  busyKey.value = p.id + ':enable'
  try {
    const value = await channelsRpc('provider.setEnabled', { provider: p.id, enabled })
    showToast(
      `${p.name} 已${enabled ? '启用' : '关闭'}：`
      + `${enabled ? '打开' : '关闭'} ${value.models} 个模型、`
      + `${enabled ? '启用' : '停用'} ${value.accounts} 个账号`
    )
    await reload()
    if (tab.value === 'models') await loadModels()
  } catch (err) {
    // 失败要把开关拨回去，否则界面会停在「看起来已生效」的状态
    event.target.checked = !enabled
    showToast(`${p.name} ${enabled ? '启用' : '关闭'}失败：` + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

async function toggleAccount(acct, event) {
  const enabled = event.target.checked
  busyKey.value = acct.id + ':enable'
  try {
    await channelsRpc('account.update', { accountId: acct.id, patch: { enabled } })
    await reload()
  } catch (err) {
    event.target.checked = !enabled
    showToast('切换账号状态失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

async function testAccount(acct) {
  busyKey.value = acct.id + ':test'
  try {
    const value = await channelsRpc('account.test', { accountId: acct.id }, 180000)
    const label = acct.nickname || acct.id
    if (value.ok) showToast(`${label} 可用（${value.modelId}）`)
    else showToast(`${label} 不可用：${value.message || '未知原因'}`, 'error', 8000)
  } catch (err) {
    showToast('账号测试失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

async function removeAccount(acct) {
  const label = acct.nickname || acct.id
  if (!window.confirm(`确定删除账号「${label}」吗？\n凭据文件会一并删除，该账号不再参与请求。`)) return
  busyKey.value = acct.id + ':delete'
  try {
    await channelsRpc('account.delete', { accountId: acct.id })
    showToast(`已删除「${label}」`)
    await reload()
    if (tab.value === 'models') await loadModels()
  } catch (err) {
    showToast('删除失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

async function claimOnboarding(p, acct) {
  busyKey.value = acct.id + ':onboarding'
  try {
    const before = await channelsRpc('onboarding.status', { provider: p.id, accountId: acct.id })
    if (before.earned >= before.total && before.total > 0) {
      showToast(`${acct.nickname || acct.id} 的新手任务已全部领取（${before.earned}/${before.total}）`)
      return
    }
    const value = await channelsRpc('onboarding.claim', { provider: p.id, accountId: acct.id }, 300000)
    showToast(
      `${acct.nickname || acct.id} 领取 ${value.claimed.length} 项、跳过 ${value.skipped.length} 项，`
      + `累计 ${value.earned}/${value.total}`
    )
  } catch (err) {
    showToast('领取新手任务失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// ==================== 积分 ====================

function canClaim(p) {
  return !NO_CLAIM_PROVIDERS.includes(p.id)
}

function supportsOnboarding(p) {
  return ONBOARDING_PROVIDERS.includes(p.id)
}

async function claimCredits(p) {
  creditBusy.value = p.id + ':claim'
  try {
    // 逐账号顺序领取，10 个账号可能要几分钟，超时给足
    const value = await channelsRpc('credits.claimAll', { provider: p.id }, 600000)
    claimResults.value = { ...claimResults.value, [p.id]: value }
    showToast(claimSummaryText(p, value.summary), 'success', 6000)
  } catch (err) {
    showToast(`${p.name} 领取积分失败：` + err.message, 'error', 6000)
  } finally {
    creditBusy.value = ''
  }
}

async function loadBalances(p) {
  creditBusy.value = p.id + ':balance'
  try {
    const value = await channelsRpc('credits.balances', { provider: p.id }, 300000)
    balances.value = { ...balances.value, [p.id]: value }
  } catch (err) {
    showToast(`${p.name} 余额查询失败：` + err.message, 'error', 6000)
  } finally {
    creditBusy.value = ''
  }
}

// 合计按单位分组：token 与积分不同量纲，渠道包刻意分开给（见 credits.ts），
// 加在一起会得出「1 亿 token + 100 积分 = 100000100 积分」这种错读数
function claimSummaryText(p, summary) {
  if (!summary) return `${p.name}：已执行`
  const byUnit = summary.totalByUnit || {}
  const gains = []
  if (Number(byUnit.token) > 0) gains.push(`+${formatToken(Number(byUnit.token))} Token`)
  if (Number(byUnit.credit) > 0) gains.push(`+${formatCredit(Number(byUnit.credit))} 积分`)
  const gained = gains.length ? gains.join('，') : '无新增'
  return `${p.name}：领取 ${summary.claimed}（${gained}），已领过 ${summary.alreadyClaimed}，`
    + `未开通 ${summary.inactive}，失败 ${summary.failed}`
}

function outcomeText(outcome) {
  if (!outcome) return '—'
  if (outcome.kind === 'claimed') {
    const unit = outcome.unit === 'token' ? 'Token' : '积分'
    const amount = outcome.unit === 'token' ? formatToken(outcome.credit) : formatCredit(outcome.credit)
    return `+${amount} ${unit}`
  }
  if (outcome.kind === 'already-claimed') return outcome.message || '今天已领过'
  if (outcome.kind === 'inactive') return outcome.message || '活动未开通'
  return outcome.message || '失败'
}

function outcomeClass(outcome) {
  if (!outcome) return 'text-muted'
  if (outcome.kind === 'claimed') return 'ch-ok'
  if (outcome.kind === 'already-claimed') return 'text-muted'
  if (outcome.kind === 'inactive') return 'ch-warn'
  return 'ch-bad'
}

// ==================== 模型 ====================

const modelGroups = computed(() => MODEL_GROUP_PROVIDERS
  .map(p => {
    const models = modelsByProvider.value[p.id] || []
    return {
      id: p.id,
      name: p.name,
      models,
      // 「已开启」是这个页面唯一要回答的问题（关掉的模型既不在 /v1/models，
      // 也不在对话的模型选择里），所以单独给出计数而不是让用户拿总数减已关闭：
      // cline 的目录有 493 条，一眼看不出「现在到底开着几个」。
      // 已失效既不算开启也不算关闭：它既可能带着 disabled 标记，也可能是上游
      // 下线后残留的条目，混进任何一边都会让三个数字对不上总数。
      enabledCount: models.filter(m => !m.disabled && !m.dead).length,
      disabledCount: models.filter(m => m.disabled && !m.dead).length,
      deadCount: models.filter(m => m.dead).length
    }
  })
  .filter(group => group.models.length > 0))

// 「已开启模型」板块的数据源：跨渠道拍平，只留 !disabled && !dead。
// 判据与 /v1/models 的过滤完全一致，否则这块会和客户端里能选到的列表对不上。
const enabledModels = computed(() => modelGroups.value.flatMap(group =>
  group.models
    .filter(m => !m.disabled && !m.dead)
    .map(m => ({ provider: group.id, model: m }))))

// ==================== 模型测试结论的落盘 ====================

const TEST_RESULTS_KEY = 'airoute.channels-model-tests'
// 上游错误文案可能很长（带整段响应体），存下来只为悬停时看原因，没必要全文
const TEST_ERROR_MAX = 200

// 读取时逐项校验：这份数据在 localStorage 里能被手工改坏，也能是旧格式。
// 一条坏记录就整份丢弃太粗暴，这里只跳过坏的那几条。
function readTestResults() {
  try {
    const raw = JSON.parse(localStorage.getItem(TEST_RESULTS_KEY) || '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') continue
      out[key] = {
        ok: value.ok,
        latency: Number.isFinite(value.latency) ? value.latency : null,
        error: typeof value.error === 'string' ? value.error : '',
        at: Number.isFinite(value.at) ? value.at : 0
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveTestResults() {
  try {
    localStorage.setItem(TEST_RESULTS_KEY, JSON.stringify(modelTestResults.value))
  } catch {
    // 隐私模式/配额满：标记丢了下一次重测就是，不能让整个页面跟着报错
  }
}

function recordTestResult(key, result) {
  modelTestResults.value[key] = {
    ...result,
    error: (result.error || '').slice(0, TEST_ERROR_MAX),
    at: Date.now()
  }
  saveTestResults()
}

function clearTestResults() {
  modelTestResults.value = {}
  saveTestResults()
  showToast('已清除全部测试标记')
}

// 绿点要长期挂着，就得让人看出来「这是多久以前的结论」——
// 只显示绿点不显示年龄，三天前的通过和刚才的通过长得一模一样
function testedAtText(at) {
  if (!at) return ''
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function modelTitle(providerId, m) {
  const result = modelTestResults.value[providerId + '/' + m.id]
  // 延迟/错误只放在 title 里：模型方块就那么点宽，塞进去会把名字挤成省略号
  let tested = ''
  if (result) {
    const age = testedAtText(result.at)
    tested = result.ok
      ? `｜测试通过（${result.latency ?? '-'}ms${age ? `，${age}` : ''}）`
      : `｜测试失败（${result.error || '未知原因'}${age ? `，${age}` : ''}）`
  }
  if (m.dead) return `已判定为上游下线（${m.id}），点击让它重新显示${tested}`
  const action = m.disabled ? '点击打开' : '点击关闭'
  return `${action}｜配置引用：channels/${providerId}/${m.id}${tested}`
}

// 「Flash」只能按名字判定：渠道包各家命名完全不统一（Qwen3.8-Flash、
// deepseek-v4-flash、DeepSeek V4 Flash Official、GLM-5.3-Flash…），
// 没有统一的档位字段可读，但都带这个词。
//
// 只收「被用户关掉」的：已失效（dead）是上游下线的系统推断，与用户开关是
// 两回事（渠道包自己也刻意分开存），复活要走单点 model.clearDead。
// 把这些混进来会让「快速开启」顺手把上游已经没有的模型塞回目录。
const flashOffModels = computed(() => modelGroups.value.flatMap(group =>
  group.models
    .filter(m => !m.dead && m.disabled && isFlashModel(m))
    .map(m => ({ provider: group.id, id: m.id, model: m }))))

// Flash 的家族分组。渠道包各家对同一族模型的写法差得很远
// （deepseek-v4-flash / DeepSeek-V4-Flash-Official / deepseek-v4.1-flash-free…），
// 所以先把 id+name 拍平成「只含小写字母数字」再匹配，大小写、连字符、点、空格
// 都不再影响结果。顺序有意义：DeepSeek V4 必须排在「其它 DeepSeek」之前，
// 否则 v4 会被不带版本号的那条吞掉。
//
// 4.1 必须排在 V4 之前：拍平之后 `deepseek-v4.1-flash` 就是 `deepseekv41flash`，
// 它同时命中 V4 那条的 `deepseekv4\d?flash`（`\d?` 正好吃掉这个 1），排后面就
// 永远分不出来。反过来 `deepseekv41flash` 不会命中 V4 的写法之外的东西，故安全的。
// 拍平还有个副作用正好帮我们：Raccoon 把版本写成 `sn-deepseek-v4-1-flash`
// （用连字符不用点），拍平后同样是 `...v41flash`，与点号写法殊途同归。
const FLASH_FAMILIES = [
  { key: 'deepseek-v4.1', label: 'DeepSeek V4.1 Flash', re: /deepseekv41flash/ },
  { key: 'deepseek-v4', label: 'DeepSeek V4 Flash', re: /deepseekv4\d?flash/ },
  { key: 'deepseek', label: 'DeepSeek Flash', re: /deepseek.*flash/ },
  { key: 'minimax', label: 'MiniMax Flash', re: /minimax.*flash|m3\d?flash/ },
  { key: 'qwen', label: 'Qwen Flash', re: /qwen.*flash/ },
  { key: 'glm', label: 'GLM Flash', re: /glm.*flash/ },
  { key: 'gemini', label: 'Gemini Flash', re: /gemini.*flash/ },
  { key: 'mimo', label: 'MiMo Flash', re: /mimo.*flash/ },
  { key: 'sensenova', label: 'SenseNova Flash', re: /sensenova.*flash/ },
  { key: 'other', label: '其它 Flash', re: /flash/ }
]

function isFlashModel(m) {
  return /flash/i.test(`${m.id} ${m.name || ''}`)
}

function flashFamilyOf(m) {
  const text = `${m.id} ${m.name || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '')
  return FLASH_FAMILIES.find(family => family.re.test(text)) || FLASH_FAMILIES[FLASH_FAMILIES.length - 1]
}

// 下拉里的家族清单：只列当前目录里真有的（没登录的渠道不占位），
// 每项带「待开启 / 总数」，全开的禁用但仍显示 —— 菜单项忽隐忽现比灰着更难用
const flashMenu = computed(() => {
  const stats = new Map()
  for (const group of modelGroups.value) {
    for (const m of group.models) {
      if (m.dead || !isFlashModel(m)) continue
      const family = flashFamilyOf(m)
      const entry = stats.get(family.key) || { key: family.key, label: family.label, total: 0, off: 0 }
      entry.total += 1
      if (m.disabled) entry.off += 1
      stats.set(family.key, entry)
    }
  }
  return FLASH_FAMILIES.map(family => stats.get(family.key)).filter(Boolean)
})

// 统一的模型开关写入口：两个渠道体系的存储语义不同。
//   · 渠道包：每个 provider 一份「禁用 id 集合」，有 model.setDisabledMany
//     （一次调用一次落盘一次广播；逐模型调 setDisabled 会写 N 次文档、广播 N 次）
//   · WorkBuddy：存的是一份「启用清单」，没有 disabled 字段，只能整份提交，
//     所以「禁用这几个 id」得翻译成「新的启用清单」再保存
async function setModelsDisabled(provider, modelIds, disabled) {
  if (!modelIds.length) return
  const region = WB_REGION_OF[provider]
  if (!region) {
    return channelsRpc('model.setDisabledMany', { provider, modelIds, disabled })
  }
  const enabled = new Set(
    (wbModelRows.value[provider] || []).filter(model => !model.disabled).map(model => model.id)
  )
  for (const id of modelIds) {
    if (disabled) enabled.delete(id)
    else enabled.add(id)
  }
  const upstream = wbUpstreamByRegion.value[region] || []
  const byId = new Map(upstream.map(model => [model.id, model]))
  // 保存时要带上游的 displayName / 上下文长度，所以「打开」必须能查到上游定义。
  // 上游清单没拉到（该区域没账号、网络失败）时 byId 是空的，照原样保存会把这些
  // 模型的元信息一起写丢 —— 宁可报错让人先刷新目录
  const missing = [...enabled].filter(id => !byId.has(id))
  if (missing.length) {
    throw new Error(`拿不到 ${missing.join('、')} 的上游定义，先点「重新读取目录」再试`)
  }
  // 空清单是合法的：全部关闭就是这个结果。恢复不靠后端「空=默认全开」的兜底
  // （后端并没有这个兜底），而是靠页面手里还留着上游全量 —— 再点「全部开启」即可
  const picked = upstream
    .filter(model => enabled.has(model.id))
    .map(model => ({
      id: model.id,
      displayName: model.displayName || model.name || model.id,
      maxContext: model.maxContext,
      maxOutput: model.maxOutput
    }))
  await wbSaveEnabledModels(picked, region)
}

// 一次性打开一批 Flash 模型（targets 里每项带 provider / id）
async function enableFlashTargets(targets, label) {
  if (!targets.length) return
  // 按渠道分组：一个渠道一次写入
  const byProvider = new Map()
  for (const item of targets) {
    if (!byProvider.has(item.provider)) byProvider.set(item.provider, [])
    byProvider.get(item.provider).push(item.id)
  }
  const batches = [...byProvider].map(([provider, modelIds]) => ({ provider, modelIds }))

  busyKey.value = 'flash'
  flashMenuOpen.value = false
  try {
    const results = await Promise.allSettled(batches.map(batch =>
      setModelsDisabled(batch.provider, batch.modelIds, false)))
    const failed = results
      .map((result, i) => (result.status === 'rejected' ? { batch: batches[i], error: result.reason } : null))
      .filter(Boolean)
    const failedCount = failed.reduce((sum, item) => sum + item.batch.modelIds.length, 0)

    await loadModels()
    await loadStatus()

    if (!failed.length) {
      showToast(`已开启 ${targets.length} 个 ${label}`)
    } else {
      showToast(
        `已开启 ${targets.length - failedCount} 个 ${label}，${failedCount} 个失败（${failed[0].batch.provider}：${failed[0].error?.message || '未知错误'}）`,
        'error',
        8000
      )
    }
  } catch (err) {
    showToast('批量开启 Flash 失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// 只按家族开，没有「一次全开」—— 一键把所有 Flash 打开会把几十个模型一起塞进
// /v1/models，用户回头还得逐个关；家族级是「够快又可控」的那一档
function enableFlashFamily(key) {
  const family = FLASH_FAMILIES.find(item => item.key === key)
  if (!family) return
  const targets = flashOffModels.value.filter(item => flashFamilyOf(item.model).key === key)
  return enableFlashTargets(targets, family.label)
}

async function toggleModel(providerId, m) {
  busyKey.value = providerId + ':model'
  try {
    if (m.dead) {
      // 失效模型的唯一自愈路径：清掉 dead 记录让它回到目录（上游真下线的话请求仍会 404）
      await channelsRpc('model.clearDead', { provider: providerId, modelId: m.id })
      showToast(`已重新显示 ${m.id}`)
    } else {
      await setModelsDisabled(providerId, [m.id], !m.disabled)
    }
    await loadModels()
    await loadStatus()
  } catch (err) {
    showToast('模型开关失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// 某个渠道自己的「全部打开 / 全部关闭」
async function setAllModels(providerId, disabled) {
  busyKey.value = providerId + ':models'
  try {
    const ids = (modelsByProvider.value[providerId] || []).map(m => m.id)
    await setModelsDisabled(providerId, ids, disabled)
    showToast(`${disabled ? '已关闭' : '已打开'}该渠道全部模型`)
    await loadModels()
    await loadStatus()
  } catch (err) {
    showToast('批量开关失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// 所有渠道一起开关。逐渠道并发：每个渠道一次写入（渠道包一个 provider 一次落盘，
// WorkBuddy 一个区域整份清单一次保存），比按模型逐个写少几百次。
//
// 注意：开启不动 dead。dead 是上游下线的系统推断，只有逐点模型本身（clearDead）
// 才能清掉，批量接口没有这个语义 —— 顺手开回来会把上游已经没有的模型塞回目录。
async function setAllModelsEverywhere(disabled) {
  if (busyKey.value) return
  const batches = modelGroups.value.map(group => ({
    provider: group.id,
    modelIds: group.models.map(m => m.id)
  }))
  if (!batches.length) return
  busyKey.value = disabled ? 'all:off' : 'all:on'
  flashMenuOpen.value = false
  try {
    const results = await Promise.allSettled(batches.map(batch =>
      setModelsDisabled(batch.provider, batch.modelIds, disabled)))
    const failed = results
      .map((result, i) => (result.status === 'rejected' ? { provider: batches[i].provider, error: result.reason } : null))
      .filter(Boolean)

    await loadModels()
    await loadStatus()

    const action = disabled ? '关闭' : '打开'
    if (!failed.length) {
      showToast(`已${action}全部 ${batches.length} 个渠道的所有模型`)
    } else {
      showToast(
        `${batches.length - failed.length} 个渠道已${action}，${failed.length} 个失败（${failed[0].provider}：${failed[0].error?.message || '未知错误'}）`,
        'error', 8000
      )
    }
  } catch (err) {
    showToast(`全部${disabled ? '关闭' : '开启'}失败：` + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// ==================== 模型测试（逐个真实调用，通过的标绿点） ====================
//
// 风控是这段代码的主要约束：每一条测试都是真实打到上游的请求，同一个账号短时间内
// 连着几十次调用，轻则限流冷却、重则把渠道账号打进风控（要等几小时）。
// 但风控是按上游/按账号池算的：A 家被打爆不影响 B 家。所以节奏按渠道分组，而非全局一刀切：
//   · 组间并发：各渠道同时测，互不等待（一家在退避 8s，别家照常推进）；
//   · 组内串行：同一渠道并发恒为 1，绝不同时打两个请求；
//   · 组内每个之间留 400ms 基础间隔 + 0~300ms 随机抖动 —— 固定节奏本身就是特征；
//   · 组内命中限流/风控文案后退避 8s 再继续；「池中无号 / 账号冷却」按同一类处理
//     —— 上游 429 之后账号池会把号冷却，紧接着的请求只会拿到 no healthy account，
//     只认 429 文案会让后面的模型继续硬打一个正在冷却的池子；
//   · 组内连续 3 次命中就停下这个渠道，别的渠道继续跑：宁可漏测，也不为了跑完把账号打爆。
const TEST_GAP_MS = 400
const TEST_JITTER_MS = 300
const TEST_BACKOFF_MS = 8000
const TEST_MAX_THROTTLE_STREAK = 3
const TEST_THROTTLE_RE = /(429|rate.?limit|too.?many|限流|请求过[于快]|频繁|风控|流控|no healthy account|账号池中|冷却)/i

// 只测「已启动」的模型：关闭的本来就没在跑；标「已失效」的是上游下线判定，
// 打过去必然失败，一排红点只会把真正的坏消息淹掉。
// 带上 provider：节奏控制要按渠道分组（组内串行、组间并发）
function testTargetsOf(providerIds) {
  const targets = []
  for (const group of modelGroups.value) {
    if (providerIds && !providerIds.includes(group.id)) continue
    for (const m of group.models) {
      if (m.disabled || m.dead) continue
      targets.push({ provider: group.id, key: group.id + '/' + m.id })
    }
  }
  return targets
}

// 可被「中止」打断的等待：切成 100ms 一跳，否则点中止后还要干等满退避时间
function testSleep(ms) {
  return new Promise(resolve => {
    const startedAt = Date.now()
    const tick = () => {
      if (testAbort.value || Date.now() - startedAt >= ms) resolve()
      else setTimeout(tick, 100)
    }
    setTimeout(tick, 100)
  })
}

// scope：'all' = 所有渠道；否则是单个 provider id
async function runModelTests(scope) {
  if (testRun.value) return
  const targets = testTargetsOf(scope === 'all' ? null : [scope])
  if (!targets.length) {
    showToast('没有可测的模型：这个范围里已启动的模型是空的', 'error', 5000)
    return
  }

  testAbort.value = false
  testRun.value = { scope, done: 0, total: targets.length }
  // 本次真正测到的 key。历史绿点不算进这一轮的汇总，否则「通过 8」会把
  // 上一轮留下、这一轮根本没碰的模型也数进去
  const tested = []
  // 被限流打断的渠道（每家各自判定，互不牵连）
  const throttled = []
  let userAborted = false

  // 按渠道分组后并发跑：每组内部是严格的串行循环，退避/间隔/连续命中断路都在组内算
  const byProvider = new Map()
  for (const target of targets) {
    if (!byProvider.has(target.provider)) byProvider.set(target.provider, [])
    byProvider.get(target.provider).push(target)
  }

  try {
    await Promise.all([...byProvider].map(async ([provider, list]) => {
      let throttleStreak = 0
      for (const target of list) {
        if (testAbort.value) { userAborted = true; return }
        let res
        try {
          res = await channelsTest({ model: target.key })
        } catch (err) {
          res = { ok: false, error: err.message }
        }
        // 只覆盖这个模型自己的旧结论，不动别的渠道/别的模型的绿点
        recordTestResult(target.key, {
          ok: res.ok === true,
          latency: res.latency,
          error: res.ok === true ? '' : (res.error || '未知原因')
        })
        tested.push(target.key)
        testRun.value = { ...testRun.value, done: testRun.value.done + 1 }

        if (res.ok !== true && TEST_THROTTLE_RE.test(res.error || '')) {
          throttleStreak += 1
          if (throttleStreak >= TEST_MAX_THROTTLE_STREAK) { throttled.push(provider); return }
          await testSleep(TEST_BACKOFF_MS)
          continue
        }
        throttleStreak = 0
        await testSleep(TEST_GAP_MS + Math.random() * TEST_JITTER_MS)
      }
    }))
  } finally {
    testRun.value = null
    testAbort.value = false
  }

  const passed = tested.filter(key => modelTestResults.value[key]?.ok).length
  const failed = tested.length - passed
  if (userAborted) {
    showToast(`已中止：测了 ${tested.length}/${targets.length}，通过 ${passed}，失败 ${failed}`, 'error', 8000)
  } else if (throttled.length) {
    showToast(
      `${throttled.join('、')} 连续 ${TEST_MAX_THROTTLE_STREAK} 次被限流，已停下这些渠道`
      + `（已测 ${tested.length}/${targets.length}，通过 ${passed}）；等一会儿再测，别继续硬打`,
      'error', 12000
    )
  } else if (failed === 0) {
    showToast(`全部通过：${passed} 个模型`, 'success', 6000)
  } else {
    showToast(`测完 ${tested.length} 个：通过 ${passed}，失败 ${failed}（红点上看原因）`, 'error', 10000)
  }
}

// ==================== 格式化 ====================

function expiryText(acct) {
  if (!acct.expiresAt) return '有效期未知'
  const left = acct.expiresAt - Date.now()
  if (left <= 0) return '凭据已过期'
  return `到期 ${formatTime(acct.expiresAt)}`
}

function formatTime(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ==================== WorkBuddy：读取 / 登录 / 操作 ====================

const wbCnCount = computed(() => wbList.value.filter(a => a.realm !== 'global').length)

const wbBadgeText = computed(() => {
  if (wbError.value) return '读取失败'
  const c = wbCounts.value
  if (!c.total) return '未登录'
  if (c.healthy === c.total) return `${c.total} 账号`
  return `${c.healthy}/${c.total} 可用`
})

const wbBadgeClass = computed(() => {
  if (wbError.value) return 'bad'
  const c = wbCounts.value
  if (!c.total) return 'warn'
  if (c.healthy === c.total) return 'ok'
  return c.healthy === 0 ? 'bad' : 'warn'
})

// 失败不弹 toast：整页读取失败时 reload() 已经弹过一次，这里再弹就是两条重复提示。
// 改用卡片上的 wbError 兜底，避免接口挂了却显示成「还没有账号」。
async function loadWorkbuddy() {
  try {
    const data = await fetchWbAccounts()
    wbList.value = data.accounts || []
    wbCounts.value = data.counts || { total: 0, healthy: 0, cooling: 0, disabled: 0 }
    wbError.value = ''
  } catch (err) {
    wbError.value = err?.response?.data?.error || err?.message || '无法连接服务'
  }
}

function wbErrText(err) {
  return err?.response?.data?.error || err?.response?.data?.message || err?.message || '无法连接服务'
}

function wbStateLabel(acct) {
  if (acct.disabled) return '已禁用'
  if (acct.cooling) {
    if (acct.coolKind === 'hard_credit') return '积分冷却'
    if (acct.coolKind === 'breaker') return '熔断'
    return '限流冷却'
  }
  return '可用'
}

function wbStateClass(acct) {
  if (acct.disabled) return 'ch-bad'
  if (acct.cooling) return 'ch-warn'
  return 'ch-ok'
}

function wbRunningLabel(action) {
  const map = { keepalive: '保活中…', checkin: '签到中…', balance: '刷余额中…' }
  return map[action] || (action ? `${action}…` : '')
}

async function wbStartLogin() {
  wbBusy.value = ':login'
  try {
    const realm = wbRealm.value === 'global' ? 'global' : 'cn'
    const data = await wbOauthStart(realm)
    wbLogin.value = { state: data.state, url: data.url, message: '', realm: data.realm || realm }
    try {
      await navigator.clipboard.writeText(data.url)
      wbLogin.value.message = '授权链接已复制，请粘贴到浏览器打开'
    } catch {
      /* 剪贴板不可用则忽略 */
    }
    wbStartPolling()
  } catch (err) {
    showToast('发起 WorkBuddy 登录失败：' + wbErrText(err), 'error')
  } finally {
    wbBusy.value = ''
  }
}

function wbStartPolling() {
  wbStopPolling()
  wbLoginTimer = setInterval(async () => {
    if (!wbLogin.value) return
    try {
      const data = await wbOauthPoll(wbLogin.value.state)
      if (data.done) {
        wbStopPolling()
        const realmLabel = data.realm === 'global' ? '国际版' : '国内版'
        const extra = data.realm === 'global' ? '（国际版无签到与成长任务）' : ''
        wbLogin.value = null
        showToast(`WorkBuddy 账号 ${data.nickname || data.uid} 添加成功（${realmLabel}）${extra}`)
        await loadWorkbuddy()
      } else if (data.message) {
        wbLogin.value.message = data.message
      }
    } catch {
      /* 单次轮询失败继续 */
    }
  }, 3000)
}

function wbStopPolling() {
  if (wbLoginTimer) {
    clearInterval(wbLoginTimer)
    wbLoginTimer = null
  }
}

function wbCancelLogin() {
  wbStopPolling()
  wbLogin.value = null
}

function wbOpenLoginUrl() {
  openInBrowser(wbLogin.value && wbLogin.value.url)
}

async function wbCopyLoginUrl() {
  if (!wbLogin.value || !wbLogin.value.url) return
  try {
    await navigator.clipboard.writeText(wbLogin.value.url)
    showToast('授权链接已复制')
  } catch {
    showToast('复制失败，请手动选中复制', 'error')
  }
}

async function wbCheckin(acct) {
  wbBusy.value = acct.uid + ':checkin'
  try {
    const res = await wbCheckinApi(acct.uid)
    showToast(
      `${acct.nickname || acct.uid.slice(0, 8)}：${res.message || (res.ok ? '签到成功' : '签到失败')}`,
      res.ok ? 'success' : 'error'
    )
    await loadWorkbuddy()
  } catch (err) {
    showToast('签到失败：' + wbErrText(err), 'error')
  } finally {
    wbBusy.value = ''
  }
}

async function wbBalance(acct) {
  wbBusy.value = acct.uid + ':balance'
  try {
    const res = await wbRefreshBalance(acct.uid)
    showToast(
      res.ok ? `积分 ${res.credits}（快过期 ${res.expiring}）` : `余额刷新失败：${res.message || ''}`,
      res.ok ? 'success' : 'error'
    )
    await loadWorkbuddy()
  } catch (err) {
    showToast('余额刷新失败：' + wbErrText(err), 'error')
  } finally {
    wbBusy.value = ''
  }
}

async function wbRevive(acct) {
  try {
    await wbReviveApi(acct.uid)
    showToast(`已解冻 ${acct.nickname || acct.uid.slice(0, 8)}`)
    await loadWorkbuddy()
  } catch (err) {
    showToast('解冻失败：' + wbErrText(err), 'error')
  }
}

async function wbDisable(acct) {
  const name = acct.nickname || acct.uid.slice(0, 8)
  if (!window.confirm(`确定禁用账号「${name}」吗？\n禁用后该账号不参与请求轮转，可随时恢复。`)) return
  try {
    const res = await wbDisableApi(acct.uid, '人工禁用')
    showToast(res.ok ? '账号已禁用' : res.message || '禁用失败', res.ok ? 'success' : 'error')
    await loadWorkbuddy()
  } catch (err) {
    showToast('禁用失败：' + wbErrText(err), 'error')
  }
}

async function wbEnable(acct) {
  try {
    const res = await wbEnableApi(acct.uid)
    showToast(res.ok ? '账号已恢复启用' : res.message || '恢复失败', res.ok ? 'success' : 'error')
    await loadWorkbuddy()
  } catch (err) {
    showToast('恢复失败：' + wbErrText(err), 'error')
  }
}

async function wbRemove(acct) {
  const label = acct.nickname || acct.uid
  if (!window.confirm(`确定移除账号「${label}」吗？\n凭证文件会被删除，该账号将不再参与请求转发。`)) return
  wbBusy.value = acct.uid + ':delete'
  try {
    await wbRemoveAccount(acct.uid)
    showToast(`已移除「${label}」`)
    await loadWorkbuddy()
  } catch (err) {
    showToast('移除失败：' + wbErrText(err), 'error')
  } finally {
    wbBusy.value = ''
  }
}

// 全部签到复用调度器里的签到任务：它自带全账号限速与连登管家，比这里循环调用稳妥
async function wbCheckinAll() {
  wbBusyAll.value = 'checkin'
  try {
    const res = await wbSchedulerRun('checkin')
    showToast(`全部签到完成：${(res && res.summary) || '已执行'}`)
    await loadWorkbuddy()
  } catch (err) {
    showToast('全部签到失败：' + wbErrText(err), 'error', 5000)
  } finally {
    wbBusyAll.value = ''
  }
}

async function wbRefreshBalances() {
  wbBusyAll.value = 'balance'
  try {
    const res = await wbRefreshAllBalances()
    const list = res.results || []
    showToast(`余额刷新完成：成功 ${list.filter(r => r.ok).length}/${list.length}`)
    await loadWorkbuddy()
  } catch (err) {
    showToast('刷新失败：' + wbErrText(err), 'error')
  } finally {
    wbBusyAll.value = ''
  }
}

// 与渠道包 formatCreditAmount 同口径：整数原样，小数两位
function formatCredit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '?'
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// 与渠道包 formatTokenAmount 同口径：>=1e6 → 94.54M，>=1e3 → 945.39K
function formatToken(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '?'
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return String(Math.round(n))
}

// 说明浮层与 Flash 下拉都点外部任意处关闭。用 pointerdown 而不是 click：
// 卡片上的按钮用 click，这里先于它触发才能做到「点哪儿都收起」，
// 不会出现浮层挡住内容又关不掉的死角
function onDocPointerDown(event) {
  const target = event.target instanceof Element ? event.target : null
  if (showNote.value && !(target && target.closest('.ch-heading'))) showNote.value = false
  if (showModelNote.value && !(target && target.closest('.ch-help-wrap'))) showModelNote.value = false
  // 用 closest('.ch-dd') 而不是只判按钮：菜单本身也在 .ch-dd 里，
  // 否则点菜单项的那一下会先把菜单关掉（pointerdown 早于 click）
  if (flashMenuOpen.value && !(target && target.closest('.ch-dd'))) flashMenuOpen.value = false
}

onMounted(() => {
  reload()
  document.addEventListener('pointerdown', onDocPointerDown)
})
onUnmounted(() => {
  stopPolling()
  wbStopPolling()
  document.removeEventListener('pointerdown', onDocPointerDown)
  // 离开页面时把正在跑的模型测试也停掉：否则它会继续对着上游一个个打，
  // 用户已经在别的页面了，连「中止」按钮都看不见
  testAbort.value = true
})
</script>

<style scoped>



.ch-stats {
  display: flex;
  gap: 16px;
  font-size: var(--fs-small);
  color: var(--text-2);
}

.ch-stats .stat b {
  color: var(--text-1);
}

.ch-stats .ok b {
  color: var(--ok-text);
}

.ch-alert {
  margin-bottom: 14px;
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--bad-text);
  background: var(--bad-bg);
  border: 1px solid var(--danger);
  border-radius: var(--radius-md);
}





.ch-heading {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 标题旁的问号：说明文字收在它后面，不占版面 */
.ch-help {
  width: 20px;
  height: 20px;
  padding: 2px;
  flex: none;
  border: 1px solid var(--border-2);
  border-radius: 50%;
  background: none;
  color: var(--text-3);
  cursor: pointer;
}

.ch-help:hover,
.ch-help.active {
  color: var(--primary);
  border-color: var(--primary);
}

.ch-note-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  width: min(680px, calc(100vw - 64px));
  max-height: 60vh;
  overflow: auto;
  padding: 12px 16px;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-2);
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.ch-note-list {
  margin: 0;
  padding-left: 18px;
}

.ch-note-list li + li {
  margin-top: 6px;
}

.ch-note-pop code {
  padding: 1px 5px;
  font-family: 'Courier New', Consolas, monospace;
  font-size: var(--fs-mini);
  color: var(--primary-text);
  background: var(--bg-code);
  border-radius: var(--radius-xs);
}

/* ===== 渠道卡片 ===== */
/* 一家渠道一行。原来是 auto-fill / minmax(430px) 的多列瀑布，
   但每张卡的内容量差得很远（WorkBuddy 两个区、ZCode 两个号 + 平台下拉，
   而 LobsterAI / Cline 只有一个号），多列时卡片高度参差不齐，同一行的
   空白只能由旁边那张卡承担；单列之后宽度统一，账号行、按钮行的对齐
   才在同一基准线上，扫一眼能直接横向比对。 */
.ch-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

.ch-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 拖拽排序手柄：只有这一小块是 draggable，卡片里的按钮/下拉/文本选中都不受影响 */
.ch-grip {
  width: 16px;
  height: 16px;
  flex: none;
  align-self: center;
  padding: 1px;
  border-radius: var(--radius-xs);
  color: var(--text-3);
  cursor: grab;
  user-select: none;
}

.ch-grip:hover {
  color: var(--text-1);
  background: var(--bg-chip);
}

.ch-grip:active {
  cursor: grabbing;
}

/* 正在拖的卡片留个虚影，让用户知道哪张在动；落点靠其他卡片即时让位表达，
   不再额外描边（实时重排之后描边反而会和让位动作打架）。
   拖拽期间不加过渡/动画：视觉位置必须等于布局位置，否则命中判定会落在飞行中的卡片上 */
.ch-card.dragging {
  opacity: 0.45;
}

.ch-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}

.ch-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.ch-name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-1);
}

.ch-id {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.ch-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}





.ch-switch {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-mini);
  color: var(--text-3);
  cursor: pointer;
}

.ch-check {
  width: 14px;
  height: 14px;
  padding: 0;
  margin: 0;
  accent-color: var(--primary);
  cursor: pointer;
}

.ch-switch-text {
  white-space: nowrap;
}

.ch-select {
  font-size: var(--fs-xs);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}

/* ===== 账号行 ===== */

.ch-accounts {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.ch-account {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-2);
}

.ch-account:last-child {
  border-bottom: none;
}

.ch-check-wrap {
  display: flex;
  align-items: center;
  padding-top: 2px;
  cursor: pointer;
}

.ch-account-main {
  flex: 1;
  min-width: 0;
}

.ch-account-name {
  font-size: var(--fs-small);
  color: var(--text-1);
  word-break: break-all;
}

.ch-extra {
  margin-left: 6px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.ch-account-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.ch-account-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 图标按钮：账号行与操作行的文字按钮已经不少，「明细」和「设置链接」用图标省地方 */
.ch-icon-btn {
  width: 22px;
  height: 22px;
  padding: 3px;
  flex: none;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-3);
  cursor: pointer;
}

.ch-icon-btn:hover {
  color: var(--primary);
  background: var(--primary-bg);
}

.ch-danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.ch-tag {
  padding: 0 5px;
  font-size: var(--fs-mini);
  border-radius: var(--radius-xs);
  color: var(--text-2);
  background: var(--bg-chip);
  white-space: nowrap;
}

.ch-tag.bad {
  color: var(--bad-text);
  background: var(--bad-bg);
}

.ch-tag.free {
  color: var(--ok-text);
  background: var(--ok-bg);
}

/* ===== 登录区块 ===== */
.ch-login {
  padding: 10px 12px;
  background: var(--primary-bg);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.ch-login-title {
  margin-bottom: 6px;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--text-1);
}

.ch-login-url {
  margin-bottom: 8px;
  font-size: var(--fs-mini);
  color: var(--primary);
  word-break: break-all;
  max-height: 48px;
  overflow: hidden;
}

.ch-login-actions {
  display: flex;
  gap: 8px;
}

.ch-login-status {
  margin-top: 8px;
  font-size: var(--fs-mini);
  color: var(--text-3);
}

/* ===== 操作行 / 结果 ===== */
.ch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 卡片右下角的「去子页面」入口：低频功能不在卡片里展开 */
.ch-more {
  margin-left: auto;
  align-self: center;
  font-size: var(--fs-mini);
  color: var(--primary);
  text-decoration: none;
}

.ch-more:hover {
  text-decoration: underline;
}

.ch-result {
  padding: 8px 10px;
  font-size: var(--fs-mini);
  border: 1px dashed var(--border-1);
  border-radius: var(--radius-md);
}

.ch-result-line {
  margin-bottom: 4px;
  color: var(--text-1);
}

.ch-result-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
}

.ch-result-name {
  color: var(--text-2);
  word-break: break-all;
}


.ch-ok {
  color: var(--ok-text);
}

.ch-warn {
  color: var(--warn-text);
}

.ch-bad {
  color: var(--bad-text);
}

/* ===== 模型 ===== */
.ch-models-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ch-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: var(--fs-xs);
}

/* 批量开关推到工具栏右端：和每个渠道组头那一排按钮同一侧、同一顺序，
   区别只在作用范围（全渠道 vs 单渠道） */
.ch-toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

/* 模型页问号的外层：给浮层提供定位上下文（.ch-help 本身是圆形按钮，
   不设 position，浮层才能稳定挂在它正下方） */
.ch-help-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

/* 「快速开启」下拉：按钮与菜单共用定位上下文，菜单挂在按钮下方 */
.ch-dd {
  position: relative;
}

.ch-dd-caret {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.6;
}

.ch-dd-caret.open {
  opacity: 1;
}

.ch-dd-menu {
  position: absolute;
  top: calc(100% + 6px);
  /* 按钮在工具栏右端，菜单向左展开：用 left: 0 会顶出卡片右边 */
  right: 0;
  z-index: 20;
  min-width: 236px;
  padding: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.ch-dd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 6px 8px;
  font-size: var(--fs-xs);
  color: var(--text-1);
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--radius-xs);
  cursor: pointer;
}

.ch-dd-item:hover:not(:disabled) {
  background: var(--bg-subtle);
}

.ch-dd-item:disabled {
  color: var(--text-3);
  cursor: default;
}

.ch-dd-note {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

/* 一条 Flash 模型都没有时的兜底文案（菜单不能空着弹出来） */
.ch-dd-empty {
  display: block;
  padding: 6px 8px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.ch-model-group {
  padding-top: 12px;
  border-top: 1px solid var(--border-2);
}

/* 「已开启模型」板块：它是全量目录的一个视图，结论却完全不同，
   所以给一层底色 + 外框，滚到下面那一片灰里也不会看混 */
.ch-enabled-block {
  padding: 10px 12px 12px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  background: var(--bg-chip);
}

.ch-enabled-empty {
  font-size: var(--fs-xs);
}

/* 板块里的模型来自不同渠道，必须带来源前缀 —— 全量目录里那是分组标题，
   拍平之后就没了，不标的话 `GLM-5.3-Flash` 有三四个同名同姓的 */
.ch-model-src {
  padding-right: 6px;
  margin-right: 1px;
  border-right: 1px solid var(--border-2);
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.ch-model-group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: var(--fs-xs);
}

.ch-group-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.ch-models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ch-model {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: var(--fs-xs);
  color: var(--text-1);
  background: var(--bg-hover);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-pill);
}

.ch-model:hover {
  border-color: var(--primary);
}

.ch-model.off {
  color: var(--text-4);
  background: transparent;
  border-style: dashed;
}

.ch-model.dead {
  color: var(--text-4);
  text-decoration: line-through;
}

/* 测试结论的小圆点：绿=通过、红=失败。用圆点而不是给整块改色——
   方块本身已经用「虚线/删除线」表达开关与失效，再叠一层颜色会三种状态打架 */
.ch-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--bad-text);
}

.ch-dot.ok {
  background: var(--ok-text);
}

</style>
