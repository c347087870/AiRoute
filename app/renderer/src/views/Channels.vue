<template>
  <div class="ch-page">
    <!-- 页面工具条：视图切换在左、汇总统计与一键签到在右（数据自动刷新） -->
    <div class="page-toolbar between">
      <SegmentedTabs
        :model-value="tab"
        :options="VIEW_TABS"
        label="渠道账号页视图切换"
        size="sm"
        @update:model-value="switchTab"
      />
      <div class="header-actions">
        <div class="ch-stats">
          <span class="stat">渠道 <b>{{ PROVIDERS.length }}</b></span>
          <span class="stat ok">账号 <b>{{ accounts.length + wbList.length }}</b></span>
          <span class="stat">模型 <b>{{ modelCount }}</b></span>
        </div>
        <button
          class="btn-primary btn-sm"
          :disabled="checkinAll.running || creditBusy !== '' || wbBusyAll !== '' || checkinTotal === 0"
          :title="checkinTotal === 0
            ? '没有可签到的账号'
            : `依次对支持签到的 ${checkinTotal} 处（渠道 + WorkBuddy 国内版）签到：逐渠道顺序执行，避免触发上游风控；没有签到端点的渠道自动跳过`"
          @click="runCheckinAll"
        >
          {{ checkinAll.running ? `签到中… ${checkinAll.done}/${checkinAll.total}` : '一键签到' }}
        </button>
      </div>
    </div>

    <!-- 一键签到的汇总：明细在各卡片里（渠道是「领取结果」，WorkBuddy 在卡片底部） -->
    <div v-if="checkinSummary" class="ch-checkin-tip" :class="{ bad: checkinFailed }">
      {{ checkinSummary }}
    </div>

    <!-- 运行时没起来时所有 RPC 都会失败，先把原因摆出来，别让用户对着空列表猜 -->
    <div v-if="runtimeState !== 'ready'" class="ch-alert">
      渠道运行时未就绪（{{ runtimeState }}）{{ runtimeError ? '：' + runtimeError : '' }}
    </div>

    <!-- ==================== Tab 1：账号 ==================== -->
    <template v-if="tab === 'accounts'">
      <!-- 卡片拖拽是自绘的（指针事件 + 跟手浮层 + 虚线占位），不走 HTML5 原生拖拽：
           原生拖影只能是一张静态快照，配不上实时让位的卡片，看起来像两张卡在打架 -->
      <div ref="gridEl" class="ch-grid">
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
                title="拖动排序（Esc 取消）"
                @pointerdown="onGripPointerDown('workbuddy', $event)"
              >
                <AppIcon name="gripVertical" />
              </span>
              <span class="ch-name">WorkBuddy</span>
              <span class="ch-id mono">workbuddy</span>
            </div>
            <div class="ch-head-right">
              <span class="badge" :class="wbBadgeClass">{{ wbBadgeText }}</span>
              <!-- 渠道级开关：与其它卡片同一个位置、同一套语义。
                   WorkBuddy 走 /api/workbuddy/* 那套端点，没有批量接口，只能逐账号调，
                   所以这里直接改「参不参与轮转」，冷却 / 熔断与模型开关都不动 -->
              <label class="ch-switch" :title="wbSwitchTitle">
                <input
                  type="checkbox"
                  class="ch-check"
                  :checked="wbSwitchChecked"
                  :disabled="wbBusyAll !== '' || !wbList.length"
                  @change="wbToggleProvider($event)"
                />
                <span class="ch-switch-text">{{ !wbList.length ? '无账号' : wbAllDisabled ? '已停用' : '启用' }}</span>
              </label>
            </div>
          </div>

          <div v-if="wbError" class="empty ch-bad">账号列表读取失败：{{ wbError }}</div>
          <div v-else-if="!wbList.length" class="empty">还没有账号</div>
          <div v-else class="ch-accounts">
            <div v-for="acct in wbList" :key="acct.uid" class="ch-account">
              <!-- 行内启停：和其它渠道同一个勾选框、同一个位置，点一下即生效。
                   冷却 / 熔断不算停用（那是上游暂时不可用），所以勾选框只看 disabled -->
              <label class="ch-check-wrap" :title="acct.disabled ? '已停用：不参与选号' : '启用中'">
                <input
                  type="checkbox"
                  class="ch-check"
                  :checked="!acct.disabled"
                  :disabled="wbBusyAll !== '' || wbBusy === acct.uid + ':enable'"
                  @change="wbToggleAccount(acct, $event)"
                />
              </label>
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
                  :disabled="wbBusy === acct.uid + ':checkin' || acct.realm === 'global' || checkinAll.running"
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
                <!-- 解冻与启停是两件事：冷却 / 熔断是上游暂时不可用，
                     仍算「启用」，所以它单列一个按钮，不塞进勾选框 -->
                <button v-if="acct.cooling" class="btn-ghost btn-sm" @click="wbRevive(acct)">解冻</button>
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
              :disabled="wbBusyAll !== '' || !wbCnCount || checkinAll.running"
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

          <!-- 签到的结果只有一行汇总（调度器口径），逐账号明细在 /workbuddy -->
          <div v-if="wbCheckinSummary" class="ch-result">
            <div class="ch-result-line">{{ wbCheckinSummary }}</div>
          </div>
        </div>

        <div
          v-for="group in CARD_GROUPS"
          :key="group.id"
          class="card ch-card"
          :class="[cardClass(group.id), { 'ch-card-merged': group.providers.length > 1 }]"
          :style="{ order: cardOrderIndex(group.id) }"
          :data-card-id="group.id"
        >
          <!-- 卡头：产品名 + 卡 id。徽标与「渠道级开关」属于单个渠道而不是产品，
               所以它们跟着分段走：单渠道卡只有一段，就直接画在卡头里（不额外画段头），
               合并卡每段各有自己的段头 -->
          <div class="ch-card-head">
            <div class="ch-title">
              <span
                class="ch-grip"
                title="拖动排序（Esc 取消）"
                @pointerdown="onGripPointerDown(group.id, $event)"
              >
                <AppIcon name="gripVertical" />
              </span>
              <span class="ch-name">{{ group.name }}</span>
              <span class="ch-id mono">{{ group.providers.map(item => item.id).join(' / ') }}</span>
            </div>
            <!-- 单渠道卡：徽标 + 渠道级开关就在卡头，不额外画段头（合并卡见下面的段头） -->
            <div v-if="group.providers.length === 1" class="ch-head-right">
              <template v-for="p in group.providers" :key="p.id">
                <span class="badge" :class="badgeClass(p)">{{ badgeText(p) }}</span>
                <label class="ch-switch" :title="switchTitle(p)">
                  <input
                    type="checkbox"
                    class="ch-check"
                    :checked="hasAccounts(p) && !accountsAllDisabled(p)"
                    :disabled="busyKey === p.id + ':enable' || !hasAccounts(p)"
                    @change="toggleProvider(p, $event)"
                  />
                  <span class="ch-switch-text">{{ !hasAccounts(p) ? '无账号' : accountsAllDisabled(p) ? '已停用' : '启用' }}</span>
                </label>
              </template>
            </div>
          </div>

          <!-- 一个渠道一段。合并卡（Qoder / Qoder 中国版）里两段各自带段头：
               它们是同一个产品的两个区域，账号、登录、签到、余额各走各的 provider 端点，
               但并排放在一张卡里才能直接对比两边 —— 这正是合并的目的 -->
          <div v-for="p in group.providers" :key="p.id" class="ch-provider-seg">
            <div v-if="group.providers.length > 1" class="ch-provider-head">
              <div class="ch-title">
                <!-- 卡头已经列了两个 provider id，段头只说区域名（照抄渠道包的 displayName） -->
                <span class="ch-name">{{ p.name }}</span>
              </div>
              <div class="ch-head-right">
                <span class="badge" :class="badgeClass(p)">{{ badgeText(p) }}</span>
                <label class="ch-switch" :title="switchTitle(p)">
                  <input
                    type="checkbox"
                    class="ch-check"
                    :checked="hasAccounts(p) && !accountsAllDisabled(p)"
                    :disabled="busyKey === p.id + ':enable' || !hasAccounts(p)"
                    @change="toggleProvider(p, $event)"
                  />
                  <span class="ch-switch-text">{{ !hasAccounts(p) ? '无账号' : accountsAllDisabled(p) ? '已停用' : '启用' }}</span>
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
                    :disabled="busyKey === acct.id + ':enable' || busyKey === p.id + ':enable'"
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
                    <span
                      v-if="accountTagMap[acct.id]"
                      class="ch-tag"
                      :class="{ bad: accountTagMap[acct.id].bad }"
                      :title="accountTagMap[acct.id].title"
                    >{{ accountTagMap[acct.id].text }}</span>
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
                :disabled="creditBusy === p.id + ':claim' || checkinAll.running"
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
      </div>
    </template>

    <!-- ==================== Tab 2：模型 ==================== -->
    <template v-else>
      <div class="card ch-models-card">
        <!-- 已开启模型：跨渠道拍平的可调用清单，放在最上面。
             下面的分组是**全量目录**（cline 一家就 493 条，绝大多数是灰的），
             而用户真正要回答的问题只有一个：我的客户端现在能选到哪些模型。
             放在工具栏之上还有个作用：过滤输入框在它下面，能一眼看出它没被筛 ——
             这块是完整清单，被截断会让人以为模型掉线 -->
        <div v-if="modelGroups.length" class="ch-enabled-block">
          <div class="ch-model-group-head">
            <span class="ch-name">已开启模型</span>
            <span class="text-muted">共 <span class="ch-ok">{{ enabledModels.length }}</span> 个</span>
            <!-- 这块自己的测试入口：只打这里列出的模型，也就是客户端现在真能调到的那些。
                 和工具栏的「测试」不是一回事 —— 那个按渠道铺开、且受过滤收窄；
                 这个不看过滤，关闭 / 已失效 / 已失活的本来就不在这张清单里 -->
            <span class="ch-group-actions">
              <!-- 测试中这个按钮变成「停止」：同一个位置点两次就是开始 / 取消，
                   不用扫到工具栏另一端去找「中止」，也不会被误当成「再开一轮」 -->
              <button
                class="btn-ghost btn-sm"
                :disabled="(!!testRun && !isTestRunning('enabled')) || !!busyKey || !enabledModels.length"
                :title="isTestRunning('enabled')
                  ? `停止当前测试（已测 ${testRun.done}/${testRun.total}），在途的那次会立刻断开，不计失败`
                  : `逐个真实调用这里列出的 ${enabledModels.length} 个已开启模型（渠道之间并发，同一渠道内串行 + 间隔，避免触发上游风控）；关闭的与已失效 / 已失活的本来就不在这张清单里`"
                @click="toggleModelTests('enabled')"
              >
                {{ isTestRunning('enabled') ? `停止 ${testRun.done}/${testRun.total}` : '测试' }}
              </button>
            </span>
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

        <div class="ch-toolbar">
          <!-- 模型过滤：全量目录动辄几百条，只按名称 / id 的子串匹配（不区分大小写）。
               输入框留在工具栏里而不是每组头各放一个：过滤是页面级的视角，
               放在组里会让人以为只作用于那一家。 -->
          <span class="ch-model-filter" :class="{ active: modelFilterActive }">
            <input
              v-model="modelFilter"
              type="text"
              class="ch-model-filter-input"
              :placeholder="`过滤 ${modelTotal} 个模型（名称 / id）`"
              aria-label="按名称或 id 过滤模型"
              @keydown.esc="clearModelFilter"
            />
            <button
              v-if="modelFilterActive"
              type="button"
              class="ch-model-filter-clear"
              title="清除过滤（Esc）"
              @click="clearModelFilter"
            >×</button>
          </span>
          <span v-if="modelFilterActive" class="text-muted ch-model-filter-hit">
            匹配 <span class="ch-ok">{{ filteredModelTotal }}</span> / {{ modelTotal }} 个
          </span>
          <button
            v-if="!testRun && testedModelCount"
            class="btn-ghost btn-sm"
            :title="`清除全部 ${testedModelCount} 个模型的测试标记，让下一次测试从干净状态开始`"
            @click="clearTestResults"
          >
            清除标记（{{ testedModelCount }}）
          </button>
          <!-- 测试与批量开关同一侧、同一顺序（测试 / 全部开启 / 全部关闭），
               与每个渠道组头那一排对齐：它们是同一类操作，只是作用范围不同，
               位置一致才不会点错。测试按钮本身不受 testRun 禁用 ——
               测试中它就地变成「停止 x/y」 -->
          <span class="ch-toolbar-right">
            <button
              class="btn-ghost btn-sm"
              :disabled="(!!testRun && !isTestRunning('all')) || modelsLoading"
              :title="isTestRunning('all')
                ? `停止当前测试（已测 ${testRun.done}/${testRun.total}），在途的那次会立刻断开，不计失败`
                : modelFilterActive
                  ? `只把匹配当前过滤、且已启动的模型逐个真实调用一次（渠道之间并发，同一渠道内串行 + 间隔，避免触发上游风控）`
                  : `把每个渠道里已启动的模型逐个真实调用一次，通过的标绿点、失败的标红点（渠道之间并发，同一渠道内串行 + 间隔，避免触发上游风控）`"
              @click="toggleModelTests('all')"
            >
              {{ isTestRunning('all') ? `停止 ${testRun.done}/${testRun.total}` : '测试' }}
            </button>
            <button
              class="btn-ghost btn-sm"
              :disabled="modelsLoading || !!busyKey || !!testRun || !filteredModelGroups.length"
              :title="modelFilterActive
                ? `打开匹配当前过滤的 ${filteredModelTotal} 个模型（标「已失效」的不动，那是上游下线判定，要逐点点开才能复活）`
                : `打开所有渠道的全部模型（标「已失效」的不动，那是上游下线判定，要逐点点开才能复活）`"
              @click="setAllModelsEverywhere(false)"
            >
              {{ busyKey === 'all:on' ? '开启中…' : '全部开启' }}
            </button>
            <button
              class="btn-ghost btn-sm"
              :disabled="modelsLoading || !!busyKey || !!testRun || !filteredModelGroups.length"
              :title="modelFilterActive
                ? `关闭匹配当前过滤的 ${filteredModelTotal} 个模型：关掉的模型会从 /v1/models 和对话的模型选择里消失，但配置还在，随时能再开回来`
                : `关闭所有渠道的全部模型：关掉的模型会从 /v1/models 和对话的模型选择里消失，但配置还在，随时能再开回来`"
              @click="setAllModelsEverywhere(true)"
            >
              {{ busyKey === 'all:off' ? '关闭中…' : '全部关闭' }}
            </button>
          </span>
        </div>

        <!-- 按钮移除后没有别的读取中指示，这里补一句：否则空目录时会先闪一段「没读到」再出现列表 -->
        <div v-if="modelsLoading && !modelGroups.length" class="empty">
          正在读取渠道模型目录…
        </div>
        <div v-else-if="!modelGroups.length" class="empty">
          没有读到任何渠道模型目录 —— 切走再回到「模型」页会自动重新读取；长期为空说明渠道运行时没起来（见页头提示）。
        </div>

        <div v-for="group in filteredModelGroups" :key="group.id" class="ch-model-group">
          <div class="ch-model-group-head">
            <span class="ch-name">{{ group.name }}</span>
            <span class="text-muted">
              {{ group.models.length }} 个，已开启 <span class="ch-ok">{{ group.enabledCount }}</span>，已关闭 {{ group.disabledCount }}<template
                v-if="group.deadCount"
              >，已失效 {{ group.deadCount }}</template><template
                v-if="group.offlineCount"
              >，已失活 <span class="ch-bad">{{ group.offlineCount }}</span></template>
            </span>
            <span class="ch-group-actions">
              <!-- 这几个按钮作用于当前过滤命中的模型；把范围写在按钮旁边，
                   免得「筛出 3 条点全部关闭」时以为整家渠道都被关了（或反过来） -->
              <span v-if="modelFilterActive" class="text-muted ch-filter-scope">作用于匹配的 {{ group.models.length }} 个</span>
              <button
                class="btn-ghost btn-sm"
                :disabled="(!!testRun && !isTestRunning(group.id)) || !!busyKey"
                :title="isTestRunning(group.id)
                  ? `停止当前测试（已测 ${testRun.done}/${testRun.total}），在途的那次会立刻断开，不计失败`
                  : modelFilterActive
                    ? `只测本渠道里匹配当前过滤、且已启动的模型，通过的标绿点（串行 + 间隔，避免触发上游风控）`
                    : `逐个真实调用这个渠道里已启动的模型，通过的标绿点（串行 + 间隔，避免触发上游风控）`"
                @click="toggleModelTests(group.id)"
              >
                {{ isTestRunning(group.id) ? `停止 ${testRun.done}/${testRun.total}` : '测试' }}
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
              :class="{ off: m.disabled, dead: m.dead, offline: isOfflineModel(group.id, m) }"
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
              <!-- 失活：点标签恢复（外层按钮的点击是开关模型，必须 stop） -->
              <span
                v-if="isOfflineModel(group.id, m)"
                class="ch-tag bad ch-tag-action"
                :title="`已失活：${healthOf(group.id, m)?.detail || healthOf(group.id, m)?.reason}；点击恢复`"
                @click.stop="reviveHealth(group.id, m)"
              >失活</span>
            </button>
          </div>
        </div>

        <!-- 过滤没有命中任何模型：分组区会整块消失，不给一句话就成了白屏 -->
        <div v-if="modelGroups.length && modelFilterActive && !filteredModelGroups.length" class="empty">
          没有匹配「{{ modelFilter.trim() }}」的模型（全量目录共 {{ modelTotal }} 个）。
          <button class="btn-ghost btn-sm" @click="clearModelFilter">清除过滤</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { showToast } from '../composables/useToast.js'
import AppIcon from '../components/AppIcon.vue'
import SegmentedTabs from '../components/SegmentedTabs.vue'
import ChannelLinkEditor from '../components/ChannelLinkEditor.vue'
import { slotsOf, linkKeyOf, readCustomLinks, saveCustomLinks } from '../utils/channel-links.js'
import { usePageActions } from '../composables/usePageActions.js'
import { usePolling } from '../composables/usePolling.js'
import { channelsStatus, channelsRefresh, channelsRpc, channelsTest, getModelHealth, reviveModel, getAccountHealth } from '../api.js'
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
// 有签到端点的渠道：渠道包 credits.claimAll 里真正写了分支的这几家
// （qoder / qodercn 共用 Qoder 家族那一段，WorkBuddy 走调度器，不在这里）。
//
// 用白名单而不是「排除 Gemini」的黑名单：渠道包对 Cline、Raccoon 是**显式**返回
// 「不支持每日签到」，其余没写分支的一律 unsupported provider。黑名单得跟着上游一家家补，
// 漏一家就变成「一键签到里多一条必然失败的渠道」，用户只能对着报错猜是哪家不支持。
const CLAIM_PROVIDERS = ['lobsterai', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax', 'zcode']

// 同一产品的多个区域合成一张卡。Qoder 在渠道包里是两套独立凭据
// （`qoder` → qoder.com、`qodercn` → qoder.cn），但它们是同一个产品：
// 分成两张卡时用户要来回滚动才能对比两边的账号、余额和签到结果。
//
// 合并的只有**展示**：账号体系、启用开关、登录入口、签到/余额端点仍然按 provider 各自走，
// 所以卡片内部按渠道分段，每段自带徽标与渠道级开关。
// 卡 id 取第一个成员（`qoder`）：拖拽顺序是按卡 id 存在 localStorage 的，
// 沿用旧 id 用户排好的位置就不会丢。
const MERGED_CARDS = [
  { id: 'qoder', name: 'Qoder', members: ['qoder', 'qodercn'] }
]

// 账号页的卡片清单：一个分组一张卡。名称照抄渠道包的 displayName，
// 单成员分组的卡头与分段内标题都写这个名字，所以不另起叫法。
const CARD_GROUPS = (() => {
  const byId = new Map(PROVIDERS.map(provider => [provider.id, provider]))
  const groups = []
  for (const provider of PROVIDERS) {
    const merged = MERGED_CARDS.find(card => card.members.includes(provider.id))
    if (!merged) {
      groups.push({ id: provider.id, name: provider.name, providers: [provider] })
      continue
    }
    if (groups.some(group => group.id === merged.id)) continue
    groups.push({
      id: merged.id,
      name: merged.name,
      providers: merged.members.map(id => byId.get(id)).filter(Boolean)
    })
  }
  return groups
})()

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
// 顺序按**卡**存（不是按 provider）：合并卡的 id 是第一个成员的 provider id
const DEFAULT_ORDER = ['workbuddy', ...CARD_GROUPS.map(group => group.id)]

function loadSavedOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
    // 过滤掉已经不存在的 id：渠道包升级删了某个 provider 时旧顺序里会留着它；
    // Qoder 中国版并进 Qoder 卡之后，旧的 `qodercn` 也会在这里被丢掉
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

// 用 CSS 的 order 属性排版，而不是按顺序重排 DOM：拖拽时只改一次数组，
// 卡片节点不搬家，指针捕获、输入框焦点、滚动位置都不会被打断
function cardOrderIndex(id) {
  const i = cardOrder.value.indexOf(id)
  return i < 0 ? DEFAULT_ORDER.length : i
}

// ==================== 卡片拖拽排序 ====================
// 用指针事件自绘，而不是 HTML5 的 draggable：
//   · 原生拖影只是 dragstart 那一刻的静态快照，卡片实时让位时它会和页面对不上，
//     看起来像「手里一张、页面上还有一张」；
//   · 原生 dragover 只有落在卡片盒子里才算命中，卡片之间的间隙是死区；
//   · 拖出窗口松手时 drop / dragend 不保证回来，顺序会半途而废。
// 现在的做法：按住手柄超过阈值后浮起一张跟手的卡片快照，原位留虚线占位槽；
// 占位槽随指针越过其他卡片中线换位（其他卡片 FLIP 让位），松手落定、Esc 撤销。
const gridEl = ref(null)
const dragId = ref('')
let orderDirty = false
// 一次拖拽的会话状态：pending（只按下还没动）→ active（浮层已起）
let drag = null
let scrollRaf = 0

const DRAG_THRESHOLD = 4 // 小于这个位移当点击，避免按一下手柄就抖成拖拽
const SCROLL_EDGE = 72 // 指针距滚动容器上下边缘多近开始自动滚动
const SCROLL_MAX_STEP = 18 // 自动滚动每帧最多几像素

const cardClass = id => ({ dragging: dragId.value === id })

function findScrollParent(el) {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
  }
  return document.scrollingElement || document.documentElement
}

// 卡片在**布局**里的盒子（不受 FLIP 动画的 transform 影响）。
// `.ch-grid` 有 position: relative，卡片以网格为 offsetParent，offsetLeft/offsetTop
// 就是布局坐标；再加上网格自身在视口里的位置即可。这样页面滚动、卡片飞行动画
// 都不会让落点判定和看到的位置错开。
function layoutBoxOf(el) {
  const grid = gridEl.value
  if (!grid) return null
  const base = grid.getBoundingClientRect()
  const left = base.left + grid.clientLeft + el.offsetLeft
  const top = base.top + grid.clientTop + el.offsetTop
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight }
}

// FLIP：改 order 前先量一遍每张卡的位置，改完再量一遍，用差值做一次反向位移动画。
// CSS grid 的重排是瞬间跳变的，没有这一步就只剩「闪一下」。
//
// 量的是 offsetLeft/offsetTop（网格内布局坐标），不是 getBoundingClientRect()：
// 拖拽时自动滚动会在两次测量之间改变视口偏移，rect 会把这段滚动也算成位移，
// 卡片就会朝错误方向飞；布局坐标只反映真正的重排。
async function flipCards(mutate) {
  const grid = gridEl.value
  if (!grid) {
    mutate()
    return
  }
  const cards = [...grid.querySelectorAll('.ch-card')]
  const posOf = el => ({ left: el.offsetLeft, top: el.offsetTop })
  const before = new Map(cards.map(el => [el, posOf(el)]))
  mutate()
  await nextTick()
  for (const el of cards) {
    const from = before.get(el)
    if (!from) continue
    const to = posOf(el)
    const dx = from.left - to.left
    const dy = from.top - to.top
    if (!dx && !dy) continue
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: dragId.value ? 120 : 160, easing: 'ease-out' }
    )
  }
}

// 拖拽过程中只改内存顺序，松手时才写 localStorage —— 否则每划过一张卡就写一次盘
function persistOrder() {
  if (!orderDirty) return
  orderDirty = false
  localStorage.setItem(ORDER_KEY, JSON.stringify(cardOrder.value))
}

function onGripPointerDown(id, e) {
  if (e.button !== 0 || drag) return
  const grip = e.currentTarget
  const card = grip.closest('.ch-card')
  if (!card) return
  // 从按下起这次交互就归拖拽控制器：别让指针去选卡片里的文字
  e.preventDefault()
  // 捕获指针：拖到窗口外再松手也能收到 pointerup，不会留下一个卡住的浮层。
  // 个别环境会拒绝捕获（pointerId 已失效等），失败了不影响窗口监听
  try {
    grip.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  drag = {
    id,
    card,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    active: false,
    preview: null,
    scroller: null,
    savedAtStart: [...savedOrder.value]
  }
  window.addEventListener('pointermove', onGripPointerMove)
  window.addEventListener('pointerup', onGripPointerUp)
  window.addEventListener('pointercancel', onGripPointerCancel)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('keydown', onDragKeyDown)
}

function activateDrag() {
  const { card } = drag
  drag.active = true
  const rect = card.getBoundingClientRect()
  // 浮层是卡片节点的深克隆（事件监听不会被复制，天然只读）。尺寸锁死在起手那一刻，
  // 后面无论卡片内容怎么变，浮层都不会跟着抖。
  const preview = card.cloneNode(true)
  preview.classList.add('ch-drag-preview')
  preview.removeAttribute('data-card-id')
  preview.setAttribute('aria-hidden', 'true')
  // 克隆里有按钮/下拉，别让键盘 Tab 进到一个没有事件监听的影子节点里
  preview.inert = true
  preview.style.width = rect.width + 'px'
  preview.style.height = rect.height + 'px'
  preview.style.left = rect.left + 'px'
  preview.style.top = rect.top + 'px'
  document.body.appendChild(preview)
  drag.preview = preview
  drag.scroller = findScrollParent(card)
  orderDirty = false
  dragId.value = drag.id // 原卡片变成虚线占位槽
  document.body.classList.add('ch-drag-active')
  movePreview(drag.lastX, drag.lastY)
}

// 浮层始终跟着指针：起点是卡片原位 + 按下点到起手时的偏移，所以抓哪儿就一直在哪儿
function movePreview(x, y) {
  if (!drag?.preview) return
  drag.preview.style.transform = `translate3d(${x - drag.startX}px, ${y - drag.startY}px, 0)`
}

// 单列布局里只按「其他卡片的中线」决定插入位：指针越过了谁的中线，占位槽就排到谁前面。
// 和「指针落在哪张卡的盒子里」相比，中线判定没有卡片间隙的死区，也不会因为换位后
// 整列上下挪动而反复横跳（指针没动，越过的中线数量就不会变）。
function updateDropSlot(pointerY) {
  const grid = gridEl.value
  if (!grid || !drag) return
  const others = []
  for (const el of grid.querySelectorAll('.ch-card')) {
    if (el.dataset.cardId === drag.id) continue
    const box = layoutBoxOf(el)
    if (box) others.push(box)
  }
  others.sort((a, b) => a.top - b.top || a.left - b.left)
  let index = 0
  for (const box of others) {
    if (pointerY > (box.top + box.bottom) / 2) index += 1
    else break
  }
  if (cardOrder.value.indexOf(drag.id) === index) return
  const list = cardOrder.value.filter(id => id !== drag.id)
  list.splice(index, 0, drag.id)
  flipCards(() => {
    savedOrder.value = list
  })
  orderDirty = true
}

function autoScrollStep() {
  if (!drag?.active || !drag.scroller) return 0
  const rect = drag.scroller.getBoundingClientRect()
  if (drag.lastY < rect.top + SCROLL_EDGE) {
    const ramp = Math.min(1, (rect.top + SCROLL_EDGE - drag.lastY) / SCROLL_EDGE)
    return -Math.ceil(ramp * SCROLL_MAX_STEP)
  }
  if (drag.lastY > rect.bottom - SCROLL_EDGE) {
    const ramp = Math.min(1, (drag.lastY - (rect.bottom - SCROLL_EDGE)) / SCROLL_EDGE)
    return Math.ceil(ramp * SCROLL_MAX_STEP)
  }
  return 0
}

// 拖到列表上下边缘时自动滚动：很多用户的卡片顺序是跨屏调整的，
// 不然得先松手、滚页面、再重新拖一次
function pumpAutoScroll() {
  scrollRaf = 0
  if (!drag?.active) return
  const step = autoScrollStep()
  if (!step) return
  const el = drag.scroller
  const before = el.scrollTop
  el.scrollTop = before + step
  if (el.scrollTop === before) return // 已经到顶/到底，别空转 rAF
  // 内容在指针下方滚过去了，插入位要按新的布局重算
  updateDropSlot(drag.lastY)
  scrollRaf = requestAnimationFrame(pumpAutoScroll)
}

function ensureAutoScroll() {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(pumpAutoScroll)
}

function onGripPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return
  drag.lastX = e.clientX
  drag.lastY = e.clientY
  if (!drag.active) {
    if (
      Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
      Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD
    ) return
    activateDrag()
  }
  movePreview(e.clientX, e.clientY)
  updateDropSlot(e.clientY)
  ensureAutoScroll()
}

function onGripPointerUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return
  finishDrag()
}

// 指针被系统收走（切窗口、触控手势打断）时按当前顺序落定，别让浮层留在屏幕上
function onGripPointerCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return
  finishDrag()
}

function onWindowBlur() {
  if (drag) finishDrag()
}

function onDragKeyDown(e) {
  if (!drag || e.key !== 'Escape') return
  e.preventDefault()
  finishDrag({ cancel: true })
}

function finishDrag({ cancel = false } = {}) {
  if (!drag) return
  const { preview, active, savedAtStart } = drag
  window.removeEventListener('pointermove', onGripPointerMove)
  window.removeEventListener('pointerup', onGripPointerUp)
  window.removeEventListener('pointercancel', onGripPointerCancel)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('keydown', onDragKeyDown)
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = 0
  }
  preview?.remove()
  document.body.classList.remove('ch-drag-active')
  dragId.value = ''
  drag = null
  if (!active) return // 只是按了一下手柄，没有真正开始拖
  if (cancel) {
    // 还原到拖拽前的顺序。要用 savedOrder 的快照，不能拿 cardOrder 还原：
    // 用户从没排过序时 savedOrder 是空数组，cardOrder 却是完整的默认顺序。
    flipCards(() => {
      savedOrder.value = savedAtStart
    })
    orderDirty = false
    return
  }
  persistOrder()
}

const tab = ref('accounts')
// 视图切换的选项表放常量里：模板只需要绑一次，标签文案改动不必动结构
const VIEW_TABS = [
  { value: 'accounts', label: '账号' },
  { value: 'models', label: '模型' }
]
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
// 模型测试：testRun 非空即「正在跑」，null 表示空闲
//   { scope: 'all' | providerId, done, total }
const testRun = ref(null)
const testAbort = ref(false) // 「中止」标记：循环里只决定「还要不要开始下一个」
// 在途请求的中止句柄：「中止」除了不再开始下一个，还要真的断开当前这一次 ——
// 否则卡在上游的那一次要拖到 180s 超时才结束
const testController = ref(null)
// 键是 `provider/modelId` → { ok, latency, error, at }
// 落本机 localStorage：跑通过一次就一直绿（直到下一次失败），刷新/重启都还在。
// 它是「我这台机器上试过什么」的本地记录，不跟渠道包的数据目录走 ——
// 渠道状态是账号池的事实，测试结论只是观察结果，两者混在同一个文档里迟早互相干扰。
const modelTestResults = ref(readTestResults())
const testedModelCount = computed(() => Object.keys(modelTestResults.value).length)

// 失活台账：键是模型 id（gemini/gemini-2.5-pro）→ { ref, offline, reason, detail }
// 与配置引用一一对应（服务端用 resolveRef 补的 modelId），界面按 modelId 匹配。
// 失活是「网关不再把请求派给它」，与渠道包自己的 disabled / dead 是两件事。
const modelHealthMap = ref({})

// 读失败就当没有失活：这只是展示层，不能因为它挡住账号与目录的渲染
async function loadModelHealth() {
  try {
    const data = await getModelHealth()
    const map = {}
    for (const item of data.models || []) {
      if (item.modelId) map[item.modelId] = item
    }
    modelHealthMap.value = map
  } catch {
    /* 保留上一份：一次读取失败不该让「失活」标的显示跳变 */
  }
}

function healthOf(providerId, m) {
  return modelHealthMap.value[`${providerId}/${m.id}`] || null
}

function isOfflineModel(providerId, m) {
  return !!healthOf(providerId, m)?.offline
}

// 点「失活」标签恢复：只清台账标记，不动配置与开关
async function reviveHealth(providerId, m) {
  const record = healthOf(providerId, m)
  if (!record?.ref) return
  try {
    await reviveModel(record.ref)
    await loadModelHealth()
    showToast(`已恢复 ${m.name || m.id}`)
  } catch (err) {
    showToast('恢复失败：' + err.message, 'error', 6000)
  }
}

// 账号停用原因：键是渠道账号 id → { accountId, reason, provider, since }。
// 上游明确说「账号已被禁用」（如 LobsterAI 的 code=40302）时，服务端会在池里
// 停用它，并把原话记在 AiRoute 自己的台账里 —— 渠道包的 account.update 只认
// enabled，没有地方存「为什么停了」。
const accountHealthMap = ref({})

// 读失败就当没记过原因：标签退化成「已停用」，账号本身的启停状态仍来自渠道包
async function loadAccountHealth() {
  try {
    const data = await getAccountHealth()
    const map = {}
    for (const item of data.accounts || []) map[item.accountId] = item
    accountHealthMap.value = map
  } catch {
    /* 保留上一份：一次读取失败不该让标签闪烁 */
  }
}

// 停用的账号在行上打标：有上游原话 → 红色「已禁用」，否则灰色「已停用」
// （用户自己关的也是 enabled=false，两者要能分辨，否则「被禁用」会被当成「我关的」）
const accountTagMap = computed(() => {
  const map = {}
  for (const acct of accounts.value) {
    if (!acct || acct.enabled !== false) continue
    const record = accountHealthMap.value[acct.id]
    map[acct.id] = record
      ? { text: '已禁用', bad: true, title: `上游已禁用该账号，AiRoute 已自动停用：${record.reason || '未记录原因'}` }
      : { text: '已停用', bad: false, title: '该账号已停用，不参与选号' }
  }
  return map
})

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
// 最近一次「全部签到 / 一键签到」里 WorkBuddy 那一段的汇总（调度器只回一行文字）
const wbCheckinSummary = ref('')
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

async function reload({ silent = false } = {}) {
  try {
    await loadStatus()
    await loadModelHealth()
    await loadAccountHealth()
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
    if (failed.length && !silent) showToast(`部分渠道账号读取失败：${failed.join('、')}`, 'error', 6000)
    // WorkBuddy 是另一套后端，失败自己兜（见 loadWorkbuddy），不能连带整页报错
    await loadWorkbuddy()
    // 目录是服务启动时在后台采集的，首屏可能还没采完（此时 channels 源里的模型数还是 0）。
    // 已有账号却报 0，说明采集没跟上 —— 补一次同步，让头部统计与 Provider 配置立刻对上。
    // 轮询不触发：否则目录真为空时会每 5 秒重新采集一次。
    if (!silent && accounts.value.length > 0 && modelCount.value === 0) await syncCatalog()
  } catch (err) {
    if (!silent) showToast('读取渠道状态失败：' + err.message, 'error', 6000)
  }
}

// 顶部栏的「实时」角标由布局渲染；数据靠 5 秒轮询保持最新
usePageActions({ live: true })
usePolling(() => reload({ silent: true }))

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

// 账号开关与模型开关是两回事：没有账号也能在「模型」页开启模型（转发时才失败，
// 测试会标红点）。所以卡片右上角的开关只看账号状态，不读 provider.status 的 closed ——
// 那是「模型是否全关」的判据。
function hasAccounts(p) {
  return accountsOf(p).length > 0
}

// 判据与账号行的勾选框一致：enabled !== false 视为启用（老账号可能没有该字段）
function accountsAllDisabled(p) {
  const rows = accountsOf(p)
  return rows.length > 0 && rows.every(a => a.enabled === false)
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
  if (st.accounts.enabled === 0) return 'bad'
  return 'ok'
}

function switchTitle(p) {
  const rows = accountsOf(p)
  if (!rows.length) return '还没有账号：登录后这里控制该渠道全部账号的启用/停用；模型开关在「模型」页独立设置'
  const enabled = rows.filter(a => a.enabled !== false).length
  return `渠道级开关：停用/启用该渠道全部账号（当前 ${enabled}/${rows.length} 个启用）；`
    + '模型开关在「模型」页独立设置，不受这里影响'
}

// 只逐号改 enabled，不用 provider.setEnabled：那个端点会连带关掉/打开全部模型，
// 与「账号与模型相互独立」的约定冲突。
async function toggleProvider(p, event) {
  const enabled = event.target.checked
  const rows = accountsOf(p)
  if (!rows.length) {
    event.target.checked = !enabled
    showToast(`${p.name} 还没有账号，先登录后再试`, 'error', 5000)
    return
  }
  busyKey.value = p.id + ':enable'
  const failed = []
  let changed = 0
  try {
    for (const acct of rows) {
      try {
        await channelsRpc('account.update', { accountId: acct.id, patch: { enabled } })
        changed++
      } catch (err) {
        failed.push(`${acct.nickname || acct.id}：${err.message}`)
      }
    }
    if (failed.length) {
      showToast(
        `${p.name} ${enabled ? '启用' : '停用'} ${changed}/${rows.length} 个账号失败 ${failed.length} 个：${failed[0]}`,
        'error',
        6000
      )
    } else {
      showToast(`${p.name} 已${enabled ? '启用' : '停用'} ${changed} 个账号`)
    }
    // 逐号改可能部分失败：以重新读取的结果为准，别让开关停在「看起来全生效」的猜测上
    await reload()
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
    // 服务端拿到「账号已被禁用」的证据时会在池里停用它，所以这里重新读一遍：
    // 勾选框和「已禁用」标签要立刻对上，否则界面还显示可用，用户会再点一次
    await reload({ silent: true })
    const record = accountHealthMap.value[acct.id]
    if (record) showToast(`${label} 已被上游禁用，已自动停用：${record.reason || '原因未知'}`, 'error', 10000)
    else if (value.ok) showToast(`${label} 可用（${value.modelId}）`)
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
  return CLAIM_PROVIDERS.includes(p.id)
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

// 分组计数。抽成函数是因为过滤后要按**命中的那部分模型**重算一遍：
// 筛出 3 条却显示「共 493 个，已开启 0」会让人以为筛错了。
//
// 「已开启」是这个页面唯一要回答的问题（关掉的模型既不在 /v1/models，
// 也不在对话的模型选择里），所以单独给出计数而不是让用户拿总数减已关闭：
// cline 的目录有 493 条，一眼看不出「现在到底开着几个」。
// 已失效既不算开启也不算关闭：它既可能带着 disabled 标记，也可能是上游
// 下线后残留的条目，混进任何一边都会让三个数字对不上总数。
// 失活（网关判定余额/账号/连续失败）同样不算开启 —— 它此刻不参与路由，
// 与 /v1/models 的口径必须一致
function groupCounts(providerId, models) {
  return {
    enabledCount: models.filter(m => !m.disabled && !m.dead && !isOfflineModel(providerId, m)).length,
    disabledCount: models.filter(m => m.disabled && !m.dead).length,
    deadCount: models.filter(m => m.dead).length,
    offlineCount: models.filter(m => isOfflineModel(providerId, m)).length
  }
}

const modelGroups = computed(() => MODEL_GROUP_PROVIDERS
  .map(p => {
    const models = modelsByProvider.value[p.id] || []
    return {
      id: p.id,
      name: p.name,
      models,
      ...groupCounts(p.id, models)
    }
  })
  .filter(group => group.models.length > 0))

// 「已开启模型」板块的数据源：跨渠道拍平，只留 !disabled && !dead && !失活。
// 判据与 /v1/models 的过滤完全一致，否则这块会和客户端里能选到的列表对不上。
const enabledModels = computed(() => modelGroups.value.flatMap(group =>
  group.models
    .filter(m => !m.disabled && !m.dead && !isOfflineModel(group.id, m))
    .map(m => ({ provider: group.id, model: m }))))

// ==================== 模型过滤 ====================

// 全量目录动辄几百条（cline 一家 493 条），靠肉眼在里头找模型不现实。
// 只做不区分大小写的纯子串匹配（id 与显示名都算）：用户手里有的是「知道名字的
// 一部分」这个信息，正则/模糊语法只会多一条要学的东西，不会更准。
//
// 范围只到下面的全量目录：上面「已开启模型」不过滤 —— 它回答的是「客户端现在能
// 选到什么」，是一份完整清单，缺几条反而会让人以为模型掉线了。
const modelFilter = ref('')

const modelFilterActive = computed(() => modelFilter.value.trim() !== '')

function matchModelFilter(m) {
  const keyword = modelFilter.value.trim().toLowerCase()
  if (!keyword) return true
  return String(m.id || '').toLowerCase().includes(keyword)
    || String(m.name || '').toLowerCase().includes(keyword)
}

// 过滤后的分组：计数按命中的模型重算，空组直接不显示
const filteredModelGroups = computed(() => {
  if (!modelFilterActive.value) return modelGroups.value
  return modelGroups.value
    .map(group => {
      const models = group.models.filter(matchModelFilter)
      return { ...group, models, ...groupCounts(group.id, models) }
    })
    .filter(group => group.models.length > 0)
})

// 命中总数：过滤时显示「匹配 N 个」，空结果时用它和总数区分「没读到目录」
const filteredModelTotal = computed(() =>
  filteredModelGroups.value.reduce((sum, group) => sum + group.models.length, 0))

const modelTotal = computed(() =>
  modelGroups.value.reduce((sum, group) => sum + group.models.length, 0))

// 动作（测试 / 全部打开 / 全部关闭）作用于哪些模型：
// 过滤生效时只碰命中的那些 —— 筛出 3 条再点「全部关闭」，用户要的是关掉这 3 条，
// 而不是把整家渠道的几百条一起关掉。统一从 filteredModelGroups 取，
// 动作范围与界面上看得见的集合永远是同一份（没有过滤时它就是全量）。
function actionModelsOf(providerId) {
  const group = filteredModelGroups.value.find(item => item.id === providerId)
  return group ? group.models : []
}

function clearModelFilter() {
  modelFilter.value = ''
}

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
  // 失活优先说明：它此刻不参与路由，比「开关/上游失效」更影响用户判断
  const health = healthOf(providerId, m)
  if (health?.offline) return `已失活：${health.detail || health.reason || '原因未知'}（点「失活」标签恢复）${tested}`
  if (m.dead) return `已判定为上游下线（${m.id}），点击让它重新显示${tested}`
  const action = m.disabled ? '点击打开' : '点击关闭'
  return `${action}｜配置引用：channels/${providerId}/${m.id}${tested}`
}

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
  // 模型的元信息一起写丢 —— 宁可报错让人先把目录拉回来
  const missing = [...enabled].filter(id => !byId.has(id))
  if (missing.length) {
    throw new Error(`拿不到 ${missing.join('、')} 的上游定义（该区域的账号未登录或目录没拉到），切走再回到「模型」页会自动重新读取`)
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

// 某个渠道自己的「全部打开 / 全部关闭」。过滤生效时只作用于命中的模型
async function setAllModels(providerId, disabled) {
  const models = actionModelsOf(providerId)
  if (!models.length) {
    showToast('这个渠道里没有匹配当前过滤的模型', 'error', 5000)
    return
  }
  busyKey.value = providerId + ':models'
  try {
    const ids = models.map(m => m.id)
    await setModelsDisabled(providerId, ids, disabled)
    showToast(modelFilterActive.value
      ? `已${disabled ? '关闭' : '打开'}匹配的 ${ids.length} 个模型`
      : `已${disabled ? '关闭' : '打开'}该渠道全部模型`)
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
//
// 过滤生效时只作用于命中的模型（没有命中的渠道整批跳过，不为它发一次空写入）
async function setAllModelsEverywhere(disabled) {
  if (busyKey.value) return
  const batches = filteredModelGroups.value.map(group => ({
    provider: group.id,
    modelIds: group.models.map(m => m.id)
  }))
  if (!batches.length) return
  const total = batches.reduce((sum, batch) => sum + batch.modelIds.length, 0)
  busyKey.value = disabled ? 'all:off' : 'all:on'
  try {
    const results = await Promise.allSettled(batches.map(batch =>
      setModelsDisabled(batch.provider, batch.modelIds, disabled)))
    const failed = results
      .map((result, i) => (result.status === 'rejected' ? { provider: batches[i].provider, error: result.reason } : null))
      .filter(Boolean)

    await loadModels()
    await loadStatus()

    const action = disabled ? '关闭' : '打开'
    const scope = modelFilterActive.value ? `匹配的 ${total} 个模型（${batches.length} 个渠道）` : `全部 ${batches.length} 个渠道的所有模型`
    if (!failed.length) {
      showToast(`已${action}${scope}`)
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
// 过滤生效时只测命中的模型（筛出 3 条却打了整渠道几百个请求，既慢又容易触发风控）。
// 带上 provider：节奏控制要按渠道分组（组内串行、组间并发）
function testTargetsOf(providerIds) {
  const targets = []
  for (const group of filteredModelGroups.value) {
    if (providerIds && !providerIds.includes(group.id)) continue
    for (const m of group.models) {
      if (m.disabled || m.dead) continue
      targets.push({ provider: group.id, key: group.id + '/' + m.id })
    }
  }
  return targets
}

// 「已开启模型」那块的测试范围：清单本身就是范围 —— enabledModels 已经排除了
// 关闭 / 已失效 / 已失活，不必再筛一遍。
// 刻意不跟过滤走：那块的展示不受过滤影响，它旁边的按钮也就该测这份完整清单
function testTargetsOfEnabled() {
  return enabledModels.value.map(row =>
    ({ provider: row.provider, key: row.provider + '/' + row.model.id }))
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

// 「中止」：既让循环不再开始下一个，也断开当前在途请求
function stopModelTests() {
  testAbort.value = true
  testController.value?.abort()
}

// 某一份范围是不是正在跑。测试中的按钮就地变成「停止」，所以要知道点的是自己还是别人
function isTestRunning(scope) {
  return !!testRun.value && testRun.value.scope === scope
}

// 测试中的按钮自己就是停止键：不用再去工具栏另一端找「中止」，
// 也不至于让人以为「再点一次会重开一轮」
function toggleModelTests(scope) {
  if (isTestRunning(scope)) stopModelTests()
  else runModelTests(scope)
}

// scope：'all' = 所有渠道；'enabled' = 「已开启模型」那张清单；否则是单个 provider id
async function runModelTests(scope) {
  if (testRun.value) return
  const targets = scope === 'enabled'
    ? testTargetsOfEnabled()
    : testTargetsOf(scope === 'all' ? null : [scope])
  if (!targets.length) {
    showToast(scope === 'enabled'
      ? '没有可测的模型：当前没有任何已开启的模型'
      : modelFilterActive.value
        ? '没有可测的模型：匹配的模型里没有已启动的（关掉的与已失效的都不测）'
        : '没有可测的模型：这个范围里已启动的模型是空的', 'error', 5000)
    return
  }

  testAbort.value = false
  testRun.value = { scope, done: 0, total: targets.length }
  // 本轮的在途请求句柄：每轮一个，上一轮的 abort 不该影响这一轮
  const controller = new AbortController()
  testController.value = controller
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
          res = await channelsTest({ model: target.key }, controller.signal)
        } catch (err) {
          // 用户点了中止：这次不算模型的失败，也不写测试标记
          if (controller.signal.aborted) { userAborted = true; return }
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
    testController.value = null
  }

  // 测试通过会让服务端清掉「连续失败」的失活标记，这里同步一次标签
  await loadModelHealth()

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

// 渠道级开关的口径与其它渠道卡片一致：只看「是否参与请求轮转」。
// 冷却 / 熔断中的账号仍算「启用」—— 那是上游暂时不可用，不是用户关掉的；
// 混进来会让开关自己跳来跳去
const wbEnabledCount = computed(() => wbList.value.filter(acct => !acct.disabled).length)
const wbAllDisabled = computed(() => wbList.value.length > 0 && wbEnabledCount.value === 0)
const wbSwitchChecked = computed(() => wbList.value.length > 0 && !wbAllDisabled.value)

const wbSwitchTitle = computed(() => {
  if (!wbList.value.length) return '还没有账号：登录后这里控制 WorkBuddy 全部账号的启用 / 停用'
  return `渠道级开关：停用 / 启用 WorkBuddy 全部账号（当前 ${wbEnabledCount.value}/${wbList.value.length} 个启用）；`
    + '只改「参不参与请求轮转」，冷却 / 熔断与模型开关都不受影响'
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
  // 「已停用」而不是「已禁用」：渠道卡片里「已禁用」专指上游封号（红标、带原话），
  // 这里的停用都是人自己点的（行内勾选框 / 渠道级开关），两者不能混用一个词
  if (acct.disabled) return '已停用'
  if (acct.cooling) {
    if (acct.coolKind === 'hard_credit') return '积分冷却'
    if (acct.coolKind === 'breaker') return '熔断'
    return '限流冷却'
  }
  return '可用'
}

function wbStateClass(acct) {
  // 自己关掉的账号用灰字，不用红字：红色留给「上游说这个号不能用了」
  if (acct.disabled) return 'text-muted'
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

// 行内勾选框：与其它渠道的 toggleAccount 对齐 —— 点一下即生效，不弹确认框，
// 失败时把勾选框拨回去（界面不能停在一个没生效的状态上）。
//
// 与渠道包的区别：WorkBuddy 走 /api/workbuddy/enable|disable，且用 { ok:false, message }
// 表达业务失败 —— axios 不会抛错，得自己看 ok。
// 停用原因写「人工禁用」：渠道级开关写的是「渠道级停用」，两者在账号详情里能分辨是谁关的
async function wbToggleAccount(acct, event) {
  const enabled = event.target.checked
  const name = acct.nickname || acct.uid.slice(0, 8)
  wbBusy.value = acct.uid + ':enable'
  try {
    const res = enabled
      ? await wbEnableApi(acct.uid)
      : await wbDisableApi(acct.uid, '人工禁用')
    if (res && res.ok === false) throw new Error(res.message || '操作失败')
    await loadWorkbuddy()
    showToast(`${name} 已${enabled ? '恢复启用' : '停用'}`)
  } catch (err) {
    event.target.checked = !enabled
    showToast('切换账号状态失败：' + wbErrText(err), 'error', 6000)
  } finally {
    wbBusy.value = ''
  }
}

// 渠道级开关：逐账号调用 WorkBuddy 自己的端点（/api/workbuddy/* 没有批量接口）。
//
// 只动真正需要改的那部分账号：对已启用的账号调 enable 会被服务端拒（「未被禁用」），
// 对已禁用的账号重复 disable 只会把原来的停用原因覆盖成「渠道级停用」——
// 那个原因可能正是自动标记写下的故障原文，覆盖掉就查不出当初为什么停的
async function wbToggleProvider(event) {
  const enabled = event.target.checked
  if (!wbList.value.length) {
    event.target.checked = !enabled
    showToast('WorkBuddy 还没有账号，先登录后再试', 'error', 5000)
    return
  }
  const rows = enabled
    ? wbList.value.filter(acct => acct.disabled)
    : wbList.value.filter(acct => !acct.disabled)
  if (!rows.length) return // 已经是目标状态，没必要发一轮必然失败的请求

  wbBusyAll.value = 'toggle'
  const failed = []
  let changed = 0
  try {
    for (const acct of rows) {
      try {
        const res = enabled
          ? await wbEnableApi(acct.uid)
          : await wbDisableApi(acct.uid, '渠道级停用')
        // 服务端用 { ok:false, message } 表达业务失败，axios 不会抛错，得自己看
        if (res && res.ok === false) throw new Error(res.message || '操作失败')
        changed++
      } catch (err) {
        failed.push(`${acct.nickname || acct.uid.slice(0, 8)}：${wbErrText(err)}`)
      }
    }
    if (failed.length) {
      showToast(
        `WorkBuddy ${enabled ? '启用' : '停用'} ${changed}/${rows.length} 个账号失败 ${failed.length} 个：${failed[0]}`,
        'error',
        7000
      )
    } else {
      showToast(`WorkBuddy 已${enabled ? '启用' : '停用'} ${changed} 个账号`)
    }
    // 逐号改可能部分失败：以重新读取的结果为准，别让开关停在「看起来全生效」的猜测上
    await loadWorkbuddy()
  } finally {
    wbBusyAll.value = ''
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
    wbCheckinSummary.value = `WorkBuddy 全部签到：${(res && res.summary) || '已执行'}`
    showToast(`全部签到完成：${(res && res.summary) || '已执行'}`)
    await loadWorkbuddy()
  } catch (err) {
    showToast('全部签到失败：' + wbErrText(err), 'error', 5000)
  } finally {
    wbBusyAll.value = ''
  }
}

// ==================== 一键签到 ====================
// 覆盖渠道包里能领积分的九个渠道 + WorkBuddy 国内版账号，逐渠道顺序执行：
//   · 渠道包的 credits.claimAll 内部已经是逐账号顺序领取，这里再并发只会一起撞上游风控；
//   · WorkBuddy 复用调度器的签到任务（自带全账号限速与连登管家），不另写一遍循环。
// 单渠道失败不中断后面的渠道，原因写进该卡片的「领取结果」，顶部只汇总。
const checkinAll = ref({ running: false, done: 0, total: 0 })
const checkinSummary = ref('')
const checkinFailed = ref(false)

const claimableProviders = computed(() => PROVIDERS.filter(p => canClaim(p) && accountsOf(p).length > 0))
const checkinTotal = computed(() => claimableProviders.value.length + (wbCnCount.value > 0 ? 1 : 0))

function checkinSummaryText(totals, errors) {
  const gains = []
  if (totals.token > 0) gains.push(`+${formatToken(totals.token)} Token`)
  if (totals.credit > 0) gains.push(`+${formatCredit(totals.credit)} 积分`)
  const gained = gains.length ? `（${gains.join('，')}）` : ''
  const parts = [`领取 ${totals.claimed}${gained}`]
  if (totals.alreadyClaimed > 0) parts.push(`已领过 ${totals.alreadyClaimed}`)
  if (totals.inactive > 0) parts.push(`未开通 ${totals.inactive}`)
  if (totals.failed > 0) parts.push(`失败 ${totals.failed}`)
  const failedTail = errors.length ? `；${errors.length} 个渠道出错：${errors.join('、')}` : ''
  return `一键签到完成：${parts.join('，')}${failedTail}`
}

async function runCheckinAll() {
  if (checkinAll.value.running || checkinTotal.value === 0) return
  const targets = claimableProviders.value.map(p => ({ kind: 'channel', provider: p }))
  if (wbCnCount.value > 0) targets.push({ kind: 'workbuddy' })
  checkinAll.value = { running: true, done: 0, total: targets.length }
  checkinSummary.value = ''
  checkinFailed.value = false
  wbCheckinSummary.value = ''
  const totals = { claimed: 0, alreadyClaimed: 0, inactive: 0, failed: 0, token: 0, credit: 0 }
  const errors = []
  try {
    for (const target of targets) {
      if (target.kind === 'channel') {
        const p = target.provider
        try {
          const value = await channelsRpc('credits.claimAll', { provider: p.id }, 600000)
          claimResults.value = { ...claimResults.value, [p.id]: value }
          const s = value.summary || {}
          totals.claimed += Number(s.claimed) || 0
          totals.alreadyClaimed += Number(s.alreadyClaimed) || 0
          totals.inactive += Number(s.inactive) || 0
          totals.failed += Number(s.failed) || 0
          const byUnit = s.totalByUnit || { credit: s.totalCredit, token: 0 }
          totals.credit += Number(byUnit.credit) || 0
          totals.token += Number(byUnit.token) || 0
        } catch (err) {
          errors.push(p.name)
          // 失败的渠道也占一张卡片的结果区：顶部只有渠道名，原因得留在这里
          claimResults.value = {
            ...claimResults.value,
            [p.id]: {
              summary: { claimed: 0, alreadyClaimed: 0, inactive: 0, failed: 1, totalByUnit: {} },
              results: [{ accountId: '', nickname: p.name, outcome: { kind: 'failed', message: err.message } }]
            }
          }
        }
      } else {
        try {
          const res = await wbSchedulerRun('checkin')
          wbCheckinSummary.value = `WorkBuddy 全部签到：${(res && res.summary) || '已执行'}`
        } catch (err) {
          errors.push('WorkBuddy')
          wbCheckinSummary.value = 'WorkBuddy 全部签到失败：' + wbErrText(err)
        }
      }
      checkinAll.value = { ...checkinAll.value, done: checkinAll.value.done + 1 }
    }
    checkinSummary.value = checkinSummaryText(totals, errors)
    checkinFailed.value = errors.length > 0 || totals.failed > 0
    showToast(checkinSummary.value, checkinFailed.value ? 'error' : 'success', 8000)
    // 签到会改积分与账号状态，重读一次让卡片上的数字跟得上
    await loadWorkbuddy()
  } catch (err) {
    checkinFailed.value = true
    checkinSummary.value = '一键签到中断：' + (err?.message || '未知错误')
    showToast(checkinSummary.value, 'error', 8000)
  } finally {
    checkinAll.value = { ...checkinAll.value, running: false }
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

onMounted(() => {
  reload()
})
onUnmounted(() => {
  stopPolling()
  wbStopPolling()
  // 拖拽中切走页面时把拖拽状态一并收掉，否则落点监听会留在 document 上
  finishDrag({ cancel: true })
  // 离开页面时把正在跑的模型测试也停掉：否则它会继续对着上游一个个打，
  // 用户已经在别的页面了，连「停止」按钮都看不见
  stopModelTests()
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

/* 一键签到的汇总行：成功后保持中性色，只有出错时才转红（与上面的运行时警报同一口径） */
.ch-checkin-tip {
  margin-bottom: 14px;
  padding: 10px 14px;
  font-size: var(--fs-small);
  color: var(--text-2);
  background: var(--bg-subtle);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.ch-checkin-tip.bad {
  color: var(--bad-text);
  background: var(--bad-bg);
  border-color: var(--danger);
}

/* 工具条：全局 .page-toolbar 是整条右对齐，而「账号 / 模型」是视图切换、
   属于页面左侧的位置，右侧才留给本页操作（统计 + 一键签到）。
   切换控件自身的外观（浅底激活项、键盘焦点）由 SegmentedTabs 负责，
   这里不再覆盖它的按钮样式 */
.page-toolbar {
  justify-content: space-between;
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
  /* 卡片以网格为 offsetParent：拖拽落点用 offsetLeft/offsetTop 算布局坐标，
     不受滚动与 FLIP 动画影响（见 layoutBoxOf） */
  position: relative;
}

.ch-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 拖拽排序手柄：只有这一小块接手拖拽，卡片里的按钮/下拉/文本选中都不受影响 */
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
  /* 指针事件拖拽：别让浏览器把这次拖动解释成滚动/触控手势 */
  touch-action: none;
  /* 图标只有 16px，抓起来太考手。用一层透明伪元素把命中区扩到 28px，
     不占布局、不影响标题行的对齐 */
  position: relative;
}

.ch-grip::after {
  content: '';
  position: absolute;
  inset: -6px;
}

.ch-grip:hover {
  color: var(--text-1);
  background: var(--bg-chip);
}

.ch-grip:active {
  cursor: grabbing;
}

/* 拖拽中的原卡片变成占位槽：内容隐去、只留虚线框，明确告诉用户「松手就落这里」。
   之前是整张卡半透明留在原地，和跟手的浮层叠在一起，看起来像两张卡在打架 */
.ch-card.dragging {
  background: var(--bg-hover);
  border: 1px dashed var(--border-3);
  box-shadow: none;
}

.ch-card.dragging > * {
  visibility: hidden;
}

/* 跟手的拖拽浮层：卡片节点的克隆，固定定位、直接跟 translate 走，不参与布局。
   起手后就贴在指针下方，和占位槽分工明确 —— 浮层表示「拿着的卡」，占位槽表示「落点」 */
.ch-drag-preview {
  position: fixed;
  z-index: 1000;
  margin: 0;
  overflow: hidden;
  pointer-events: none;
  cursor: grabbing;
  border-color: var(--primary);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  opacity: 0.96;
  will-change: transform;
}

/* 拖拽期间整页光标都是「抓着」，并禁止选中文字（防止拖太快选中页面内容） */
body.ch-drag-active {
  cursor: grabbing;
  user-select: none;
}

body.ch-drag-active * {
  cursor: grabbing;
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

/* ===== 合并卡里的「渠道分段」 ===== */
/* 一段 = 一个渠道。单渠道卡只有一段，段内间距与原来的卡片间距一致（10px），
   所以合并与否都不改变单渠道卡的样子 */
.ch-provider-seg {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 段与段之间加一条分割线：两段各有账号列表和操作行，只靠间距会连成一片，
   看起来像同一个渠道的两组账号 */
.ch-card-merged .ch-provider-seg + .ch-provider-seg {
  padding-top: 10px;
  border-top: 1px solid var(--border-1);
}

/* 段头：卡头已经写了产品名，这里写 region 名（照抄渠道包的 displayName），
   字号比卡头小一号，层级分明 */
.ch-provider-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.ch-provider-head .ch-name {
  font-size: var(--fs-small);
  font-weight: 500;
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

/* 模型过滤输入框：工具栏里唯一的文本控件。
   宽度固定而不 flex:1 —— 拉满会把右侧那组动作（测试 / 全部开启 / 全部关闭）
   推到最边上，和过滤的「作用范围」拉开距离，反而看不清筛完之后在操作什么 */
.ch-model-filter {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.ch-model-filter-input {
  width: 200px;
  padding: 5px 24px 5px 10px;
  font-size: var(--fs-small);
}

/* 有过滤条件时给个可见的边界：几百个模型被筛掉之后，
   输入框本身要保持「现在是过滤状态」这个信号 */
.ch-model-filter.active .ch-model-filter-input {
  border-color: var(--primary);
}

/* 清除按钮压在输入框右侧，不额外占一格工具栏 */
.ch-model-filter-clear {
  position: absolute;
  right: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.ch-model-filter-clear:hover {
  color: var(--text-1);
}

.ch-model-filter-hit {
  white-space: nowrap;
}

/* 过滤时标注组内按钮的作用范围（作用于匹配的 N 个）：小字，不抢按钮的注意力 */
.ch-filter-scope {
  font-size: var(--fs-mini);
}

.ch-model-group {
  padding-top: 12px;
  border-top: 1px solid var(--border-2);
}

/* 「已开启模型」板块：排在卡片最上方，给一层底色 + 外框把它和下面的
   工具栏、全量目录分开 —— 它是结论，后面那两段是产生结论的材料 */
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

/* 失活：网关不再把请求派给它（余额/账号/连续失败）。用描边区分于「关闭」的
   虚线，避免用户以为是自己关掉了它 */
.ch-model.offline {
  border-color: var(--bad-text);
}

.ch-tag-action {
  cursor: pointer;
}

.ch-tag-action:hover {
  text-decoration: underline;
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
