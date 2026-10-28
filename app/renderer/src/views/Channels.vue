<template>
  <div class="ch-page">
    <!-- 页面工具条：视图切换在左、汇总统计与一键签到在右（数据自动刷新） -->
    <div class="page-toolbar between">
      <SegmentedTabs
        :model-value="tab"
        :options="VIEW_TABS"
        label="渠道账号页视图切换"
        @update:model-value="switchTab"
      />
      <div class="header-actions">
        <div class="ch-stats">
          <span class="stat">渠道 <b>{{ PROVIDERS.length }}</b></span>
          <span class="stat ok">账号 <b>{{ accounts.length + wbList.length }}</b></span>
          <span class="stat">模型 <b>{{ modelCount }}</b></span>
        </div>
        <!-- 添加账号：右上角的统一入口。没登录的渠道不再单独占一张卡，
             加账号就只能从这里走，所以入口必须显眼。
             按钮仍是「+ 添加账号」文字按钮；菜单项前放各渠道的品牌 logo，
             用户扫一眼就知道在给哪家加账号 -->
        <div ref="addWrapEl" class="ch-add-wrap">
          <AppButton
            variant="primary"
            class="ch-add-btn"
            :title="`添加账号：${ADD_ENTRIES.map(e => e.label).join('、')}`"
            @click="toggleAddMenu"
          >
            + 添加账号
          </AppButton>
          <div v-if="addMenuOpen" class="ch-add-menu">
            <button
              v-for="entry in ADD_ENTRIES"
              :key="entry.key"
              class="ch-add-item"
              @click="pickAdd(entry)"
            >
              <!-- logo：三家的官方品牌图都在 public/ 下（brand-*.png/svg），
                   没有官方图时退回品牌色字母标 -->
              <img v-if="entry.logo" class="ch-add-logo-img" :src="entry.logo" alt="" />
              <span v-else class="ch-add-logo" :style="{ background: entry.logoBg }">{{ entry.logoText }}</span>
              {{ entry.label }}
            </button>
          </div>
        </div>
        <!-- 已签后与账号行的「已签」同款描边样式（都置灰禁用），不再保持实心主按钮 -->
        <AppButton :variant="allChecked ? 'secondary' : 'primary'" :disabled="checkinAll.running || checkinPending === 0" :title="checkinPending === 0 ? (checkinTotal === 0 ? '没有可签到的账号' : '今天都已经签到过了，明天再来') : `依次对支持签到的 ${checkinPending} 处（渠道 + WorkBuddy 国内版）签到：逐渠道顺序执行，避免触发上游风控；没有签到端点的渠道自动跳过`" @click="runCheckinAll">
          {{ checkinAll.running ? `签到中… ${checkinAll.done}/${checkinAll.total}` : allChecked ? '已签' : '一键签到' }}
        </AppButton>
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
             那些低频页面留在 /workbuddy 子页面，不往卡片里塞。
             国内版 / 国际版拆成两张独立卡：两边本来就是两个站点、两套入口，
             行上的区域标签看不出「哪边的号多 / 哪边能签到」，卡片级别分开一眼就能对比 -->
        <div
          class="card ch-card"
          v-for="card in WB_CARDS"
          :key="card.id"
          v-show="wbAccountsOf(card.region).length || wbError || (wbLogin && wbLogin.realm === card.region)"
          :class="cardClass(card.id)"
          :style="{ order: cardOrderIndex(card.id) }"
          :data-card-id="card.id"
        >
          <div class="ch-card-head">
            <div class="ch-title">
              <span
                class="ch-grip"
                title="拖动排序（Esc 取消）"
                @pointerdown="onGripPointerDown(card.id, $event)"
              >
                <AppIcon name="gripVertical" />
              </span>
              <img class="ch-card-logo" src="/brand-workbuddy.svg" alt="" />
              <span class="ch-name">{{ card.name }}</span>
            </div>
            <div class="ch-head-right">
              <!-- 低频页面（积分构成 / 成长任务 / 定时任务）的入口收进「更多」，
                   不再单独占卡片底部一整行 -->
              <router-link to="/workbuddy" class="ch-more">更多 →</router-link>
            </div>
          </div>

          <div v-if="wbError" class="empty ch-bad">账号列表读取失败：{{ wbError }}</div>
          <div v-else class="ch-accounts">
            <div v-for="acct in wbAccountsOf(card.region)" :key="acct.uid" class="ch-account">
              <!-- 行内启停：和其它渠道同一个勾选框、同一个位置，点一下即生效。
                   冷却 / 熔断不算停用（那是上游暂时不可用），所以勾选框只看 disabled -->
              <label class="ch-check-wrap" :title="acct.disabled ? '已停用：不参与选号' : '启用中'">
                <input
                  type="checkbox"
                  class="ch-check"
                  :checked="!acct.disabled"
                  :disabled="wbBusy === acct.uid + ':enable'"
                  @change="wbToggleAccount(acct, $event)"
                />
              </label>
              <div class="ch-account-main">
                <div class="ch-account-name">
                  {{ acct.nickname || acct.uid.slice(0, 8) }}
                </div>
                <div class="ch-account-sub">
                  <span :class="wbStateClass(acct)">{{ wbStateLabel(acct) }}</span>
                  <span>积分 {{ acct.credits }}</span>
                  <span>今日 {{ formatToken(acct.tokenUsageToday) }} token</span>
                  <span v-if="acct.runningAction" class="text-muted">{{ wbRunningLabel(acct.runningAction) }}</span>
                </div>
              </div>
              <div class="ch-account-actions">
                <AppButton
                  variant="secondary"
                  class="ch-icon-btn"
                  :title="`用浏览器打开${card.region === 'global' ? '国际版' : '国内版'}个人中心看明细`"
                  @click="openConsole('workbuddy', card.region)"
                >
                  个人中心
                </AppButton>
                <AppButton variant="secondary" :disabled="wbBusy === acct.uid + ':checkin' || card.region === 'global' || acct.checkinDone || checkinAll.running" :title="card.region === 'global' ? '国际版没有签到端点' : acct.checkinDone ? '今天已签到，明天再来' : ''" @click="wbCheckin(acct)">
                  {{ wbBusy === acct.uid + ':checkin' ? '签到中…' : acct.checkinDone ? '已签' : '签到' }}
                </AppButton>
                <!-- 解冻与启停是两件事：冷却 / 熔断是上游暂时不可用，
                     仍算「启用」，所以它单列一个按钮，不塞进勾选框 -->
                <AppButton variant="secondary" v-if="acct.cooling" @click="wbRevive(acct)">解冻</AppButton>
                <AppButton
                  variant="danger"
                  icon="trash"
                  icon-only
                  class="ch-icon-btn"
                  :disabled="wbBusy === acct.uid + ':delete'"
                  title="删除账号"
                  @click="wbRemove(acct)"
                />
              </div>
            </div>
          </div>

          <!-- 登录入口已移除：添加账号改从页面右上角的「添加账号」菜单发起 -->
          <div v-if="wbLogin && wbLogin.realm === card.region" class="ch-login">
            <OauthAuthBlock
              :title="`在浏览器中完成 WorkBuddy（${card.region === 'global' ? '国际版' : '国内版'}）授权`"
              :url="wbLogin.url"
              :message="wbLogin.message"
              @cancel="wbCancelLogin"
            />
          </div>
        </div>

        <!-- 每张卡对应一个渠道区域：账号放进统一描边盒子，每行一个账号，右侧是明细 / 测试 / 删除。
             登录入口统一在页面右上角的「添加账号」菜单里。 -->
        <div
          v-for="group in visibleCardGroups"
          :key="group.id"
          class="card ch-card"
          :class="cardClass(group.id)"
          :style="{ order: cardOrderIndex(group.id) }"
          :data-card-id="group.id"
        >
          <div class="ch-card-head">
            <div class="ch-title">
              <span
                class="ch-grip"
                title="拖动排序（Esc 取消）"
                @pointerdown="onGripPointerDown(group.id, $event)"
              >
                <AppIcon name="gripVertical" />
              </span>
              <!-- 卡头渠道名前的品牌标：与「添加账号」菜单同一组图（public/brand-*.png/svg），
                   一眼认出这张卡是哪家渠道；缺图时退回品牌色字母标 -->
              <img v-if="cardLogo(group.id)" class="ch-card-logo" :src="cardLogo(group.id)" alt="" />
              <span v-else class="ch-card-logo-text" :style="{ background: cardLogoBg(group.id) }">{{ cardLogoText(group.id) }}</span>
              <span class="ch-name">{{ group.name }}</span>
            </div>
            <div class="ch-head-right">
              <!-- 卡头右侧原本还有「N 账号」徽标与渠道级总开关：徽标与账号行重复，
                   总开关做的事与账号行的勾选框一样（批量改同一个 enabled），
                   两处入口反而让人不确定该点哪个。账号的启停统一在账号行上操作 -->
            </div>
          </div>

          <!-- 账号列表：不分区域拆盒子。分区域拆开时每段都要自带标题、徽标、开关和
               一整行操作，同一张卡里出现两套一样的东西，反而不如直接标在行上。
               没账号的渠道整张卡都藏起来了（加账号走右上角入口），所以这里不再
               留「还没有账号」的空块 -->
          <div v-if="accountsOf(group).length" class="ch-accounts">
            <div v-for="acct in accountsOf(group)" :key="acct.id" class="ch-account">
              <label class="ch-check-wrap" :title="acct.enabled === false ? '已停用：不参与选号' : '启用中'">
                <input
                  type="checkbox"
                  class="ch-check"
                  :checked="acct.enabled !== false"
                  :disabled="busyKey === acct.id + ':enable' || busyKey === group.id + ':enable'"
                  @change="toggleAccount(acct, $event)"
                />
              </label>
              <div class="ch-account-main">
                <div class="ch-account-name">
                  {{ accountName(acct) }}
                  <span v-if="acct.accountName" class="ch-extra">{{ acct.accountName }}</span>
                  <span v-if="acct.phone" class="ch-extra mono">{{ acct.phone }}</span>
                </div>
                <div class="ch-account-sub">
                  <!-- 与 WorkBuddy 账号行同一个顺序：先说状态（可用 / 已停用），
                       再说标签。少了这一项，两张卡的第一行信息起点不同 -->
                  <span :class="acct.enabled === false ? 'text-muted' : 'ch-ok'">
                    {{ acct.enabled === false ? '已停用' : '可用' }}
                  </span>
                  <!-- 有余额端点的渠道显示积分：查不到时如实说「查询失败」，不显示 0 -->
                  <span v-if="balanceText(acct)" :class="{ 'ch-bad': balances[acct.id]?.error }">{{ balanceText(acct) }}</span>
                  <!-- 今日已用 token：账号级内存账本（WorkBuddy 池与插件各记各的）。
                       字段缺失就不显示 —— 与 WorkBuddy 行同一写法，不写 0 -->
                  <span v-if="Number.isFinite(acct.tokenUsageToday)">今日 {{ formatToken(acct.tokenUsageToday) }} token</span>
                  <span
                    v-if="accountTagMap[acct.id]"
                    class="ch-tag"
                    :class="{ bad: accountTagMap[acct.id].bad }"
                    :title="accountTagMap[acct.id].title"
                  >{{ accountTagMap[acct.id].text }}</span>
                  <span v-if="acct.refreshError" class="ch-tag bad" :title="acct.refreshError">刷新失败</span>
                </div>
              </div>
              <div class="ch-account-actions">
                <AppButton
                  variant="secondary"
                  class="ch-icon-btn"
                  :title="`用浏览器打开 ${providerNameOf(acct.provider)} 个人中心看明细`"
                  @click="openConsole(acct.provider, 'default')"
                >
                  个人中心
                </AppButton>
                <!-- 行内签到：与 WorkBuddy 账号行同一组按钮、同一顺序
                     （明细 → 签到 → 删除）。这家不支持的置灰并写明原因 ——
                     WorkBuddy 国际版那枚「签到」也是这样处理的，两张卡才同构。
                     今天已签过的同样置灰：再点只会回「今天已签过」，
                     留着可点等于把「已签」这个事实藏起来 -->
                <AppButton variant="secondary" :disabled="!supportsCheckinOf(acct) || busyKey === acct.id + ':checkin' || acct.checkinDone" :title="!supportsCheckinOf(acct) ? `${providerNameOf(acct.provider)} 没有每日签到端点` : acct.checkinDone ? `今天已签到${acct.lastCheckinAt ? '（' + formatTime(acct.lastCheckinAt) + '）' : ''}` : '只给这个账号签到'" @click="checkinAccount(acct)">
                  {{ busyKey === acct.id + ':checkin' ? '签到中…' : acct.checkinDone ? '已签' : '签到' }}
                </AppButton>
                                <AppButton variant="secondary" v-if="supportsAccountTest(acct)" :disabled="busyKey === acct.id + ':test'" @click="testAccount(acct)">
                  {{ busyKey === acct.id + ':test' ? '测试中…' : '测试' }}
                </AppButton>
                <AppButton variant="secondary" v-if="supportsOnboarding(acct)" :disabled="busyKey === acct.id + ':onboarding'" @click="claimOnboarding(acct)">
                  {{ busyKey === acct.id + ':onboarding' ? '领取中…' : '新手任务' }}
                </AppButton>
                <AppButton variant="danger" icon="trash" icon-only class="ch-icon-btn" :disabled="busyKey === acct.id + ':delete'" title="删除账号" @click="removeAccount(acct)" />
              </div>
            </div>
          </div>

          <!-- 登录中：授权链接 + 轮询状态（页内区块，不弹窗）。
               判据是「本卡有哪个区域正在登录」而不是下拉当前值 —— 用户在等授权时
               切了区域，这块不该跟着消失 -->
          <div v-if="login && group.providers.some(p => p.id === login.provider)" class="ch-login">
            <OauthAuthBlock
              :title="`在浏览器中完成 ${providerNameOf(login.provider)} 授权`"
              :url="login.url"
              :message="login.message"
              status-hint="等待浏览器完成授权，每 2.5 秒自动检测一次…"
              @cancel="cancelLogin"
            />
          </div>

          <!-- 登录入口已移除：添加账号改从页面右上角的「添加账号」菜单发起，
               合并卡不需要区域下拉（菜单里直接列了每一家） -->
        </div>
      </div>
    </template>

    <!-- ==================== Tab 2：模型 ==================== -->
    <template v-else>
      <!-- 三块内容是三个平级的问题，互不包含，所以做成三张同级的卡片：
           策略决定「怎么挑」，已开启模型是「现在能调到什么」，
           全量目录是「有哪些可选」。套在一起会让人以为下面的目录是上面那块的明细 -->
      <!-- 整张卡按「有没有选项」决定在不在：留着空卡片会被当成页面坏了 -->
      <div v-if="strategyTabs.length" class="card ch-strategy-card">
        <!-- Auto 策略：客户端只填 `auto` 时按哪一档口径挑模型。
             与页面顶部的视图切换同一个控件（SegmentedTabs）；
             说明文字进 title（悬停才看），不占版面。
             选项由服务端给 -->
        <div class="ch-strategy-bar">
          <span class="ch-strategy-title">Auto 策略</span>
          <SegmentedTabs
            :model-value="strategy"
            :options="strategyTabs"
            label="Auto 策略切换"
            size="sm"
            :disabled="strategySaving"
            @update:model-value="pickStrategy"
          />
        </div>
      </div>
      <div v-else class="ch-strategy-empty">
        策略选项读取失败：当前运行的服务可能是旧版本，重启 AiRoute 后再试
      </div>

      <div v-if="modelGroups.length" class="card ch-enabled-card">
        <!-- 已开启模型：跨渠道拍平的可调用清单。
             下面的分组是**全量目录**（cline 一家就 493 条，绝大多数是灰的），
             而用户真正要回答的问题只有一个：我的客户端现在能选到哪些模型。
             单列一张卡片，不受模型过滤影响 —— 过滤输入框在下一张卡里，
             让人一眼看出它没被筛（这张是完整清单，被截断会让人以为模型掉线） -->
        <div class="ch-enabled-block">
          <div class="ch-model-group-head">
            <span class="ch-name">已开启模型</span>
            <span class="text-muted">共 <span class="ch-ok">{{ enabledModels.length }}</span> 个</span>
            <!-- 这块自己的测试入口：只打这里列出的模型，也就是客户端现在真能调到的那些。
                 和下面的「测试」不是一回事 —— 那个按渠道铺开、且受过滤收窄；
                 这个不看过滤，关闭 / 已失效 / 已失活的本来就不在这张清单里 -->
            <span class="ch-group-actions">
              <!-- 测试中这个按钮变成「停止」：同一个位置点两次就是开始 / 取消，
                   不用扫到工具栏另一端去找「中止」，也不会被误当成「再开一轮」 -->
              <AppButton variant="secondary" :disabled="(!!testRun && !isTestRunning('enabled')) || !!busyKey || !enabledModels.length" :title="isTestRunning('enabled') ? `停止当前测试（已测 ${testRun.done}/${testRun.total}），在途的那次会立刻断开，不计失败` : `逐个真实调用这里列出的 ${enabledModels.length} 个已开启模型（渠道之间并发，同一渠道内串行 + 间隔，避免触发上游风控）；关闭的与已失效 / 已失活的本来就不在这张清单里`" @click="toggleModelTests('enabled')">
                {{ isTestRunning('enabled') ? `停止 ${testRun.done}/${testRun.total}` : '测试' }}
              </AppButton>
              <!-- 一键关闭清单里全部模型：清单本身就是范围，不需要过滤收窄 -->
              <AppButton variant="secondary" :disabled="!!busyKey || !enabledModels.length" @click="closeAllEnabled">全部关闭</AppButton>
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
      </div>

      <div class="card ch-models-card">
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
          <!-- 「清除标记」已移除：批量清空测试结论会把每一格「多早测的、因为什么挂的」
               一起抹掉，而重测本身就会覆盖对应那条 —— 要清掉某条的陈旧结论，重测它即可 -->
          <!-- 全渠道的「测试 / 全部开启 / 全部关闭」已移除：
               渠道组头保留了同一排按钮（作用范围是单家渠道），全渠道批量操作容易一次点错
               就把几十个模型关掉，且影响面不在同一行的上下文里 -->
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
              <AppButton variant="secondary" :disabled="(!!testRun && !isTestRunning(group.id)) || !!busyKey" :title="isTestRunning(group.id) ? `停止当前测试（已测 ${testRun.done}/${testRun.total}），在途的那次会立刻断开，不计失败` : modelFilterActive ? `只测本渠道里匹配当前过滤、且已启动的模型，通过的标绿点（串行 + 间隔，避免触发上游风控）` : `逐个真实调用这个渠道里已启动的模型，通过的标绿点（串行 + 间隔，避免触发上游风控）`" @click="toggleModelTests(group.id)">
                {{ isTestRunning(group.id) ? `停止 ${testRun.done}/${testRun.total}` : '测试' }}
              </AppButton>
              <AppButton variant="secondary" :disabled="!!busyKey" @click="setAllModels(group.id, false)">全部打开</AppButton>
              <AppButton variant="secondary" :disabled="!!busyKey" @click="setAllModels(group.id, true)">全部关闭</AppButton>
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
          <AppButton variant="secondary" @click="clearModelFilter">清除过滤</AppButton>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from '../composables/useToast.js'
import AppIcon from '../components/AppIcon.vue'
import SegmentedTabs from '../components/SegmentedTabs.vue'
import { slotsOf } from '../utils/channel-links.js'
import { usePageActions } from '../composables/usePageActions.js'
import { usePolling } from '../composables/usePolling.js'
import { channelsStatus, channelsRefresh, channelsRpc, channelsTest, getModelHealth, auditModelHealth, reviveModel, getAccountHealth, getAutoStrategy, updateAutoStrategy } from '../api.js'
import AppButton from '../components/AppButton.vue'
import OauthAuthBlock from '../components/OauthAuthBlock.vue'
// WorkBuddy 走独立的一组端点（/api/workbuddy/*），和渠道包 RPC 是两套账号体系。
// 函数名统一加 wb 前缀并与本页已有的 removeAccount / testAccount 等区分开。
import {
  wbAccounts as fetchWbAccounts,
  wbOauthStart,
  wbOauthPoll,
  wbCheckin as wbCheckinApi,
  wbRemoveAccount,
  wbDisable as wbDisableApi,
  wbEnable as wbEnableApi,
  wbRevive as wbReviveApi,
  wbSchedulerRun,
  wbModels as wbUpstreamModels,
  wbEnabledModels,
  wbSaveEnabledModels
} from '../api.js'

// 渠道的 id 与展示名。WorkBuddy 两区在下面的 WB_MODEL_PROVIDERS 里，
// 其余三家来自 AiRoute 自己的实现（server/channels/plugins/{Trae,qoder}）。
// `option` 是「添加账号」菜单里的写法：只写产品与区域，域名不带进菜单。
// 同一产品的两个区域光写「国际版 / 国内版」看不出是哪个产品，所以名称里带上产品名。
// `logoBg` 是菜单项前字母标的底色：同一家用同一个色，两区靠名称区分。
// `logo` 是官方品牌图（public/brand-*.png/svg）。
const PROVIDERS = [
  { id: 'trae', name: 'Trae', option: 'Trae', region: '', logo: '/brand-trae.png', logoBg: '#00BFA6' },
  { id: 'qoder', name: 'Qoder 国际版', option: 'Qoder 国际版', region: '国际版', logo: '/brand-qoder.svg', logoBg: '#615CED' },
  { id: 'qodercn', name: 'Qoder 国内版', option: 'Qoder 国内版', region: '国内版', logo: '/brand-qoder.svg', logoBg: '#7A6CF0' }
]

// 有「新手任务 / 登录奖励」端点的渠道。当前三家都没有这种端点
const ONBOARDING_PROVIDERS = []
// 有签到端点的渠道。只有 Trae 有 checkin_credits；Qoder 没有签到端点，
// 给它一个必然失败的按钮只会让用户对着报错猜是哪家不支持。
const CLAIM_PROVIDERS = ['trae']

// 账号页每个 provider 独立成卡，Qoder 国际版 / 国内版分别展示。
const CARD_GROUPS = PROVIDERS.map(provider => ({
  id: provider.id,
  name: provider.name,
  providers: [provider]
}))

// WorkBuddy 的目录由主进程直通提供（server/channels/index.js 的运行时门面），
// 而那份目录就是它的**启用清单** —— 已关掉的模型根本没进渠道目录，所以模型页不能
// 靠 model.list 拿它（owned runtime 只管 Trae / Qoder），
// 只能单独走 /api/workbuddy/*：上游全量算出「有哪些可选」，启用清单算出「现在开着哪些」。
const WB_MODEL_PROVIDERS = [
  { id: 'workbuddy', name: 'WorkBuddy 国内版', region: 'cn' },
  { id: 'workbuddy-global', name: 'WorkBuddy 国际版', region: 'global' }
]
const WB_REGION_OF = Object.fromEntries(WB_MODEL_PROVIDERS.map(item => [item.id, item.region]))

// WorkBuddy 两区各一张独立卡：账号按 realm 分流到对应卡上。
// 卡 id 取 `workbuddy` / `workbuddy-global`（与模型页的两个区域 id 一致）；
// 旧版合并卡用的 id 也是 `workbuddy`，国内版卡沿用它，用户排过的位置不丢
const WB_CARDS = [
  { id: 'workbuddy', name: 'WorkBuddy 国内版', region: 'cn' },
  { id: 'workbuddy-global', name: 'WorkBuddy 国际版', region: 'global' }
]

// 模型页的组顺序：WorkBuddy 两个区域在最前（与账号卡片的前两张一致），其余按 PROVIDERS
const MODEL_GROUP_PROVIDERS = [
  ...WB_MODEL_PROVIDERS,
  ...PROVIDERS.map(provider => ({ id: provider.id, name: provider.name, region: '' }))
]

// ==================== 卡片排序 ====================
// 「先看哪个来源」纯粹是这个用户的使用习惯，跟转发逻辑无关，所以存 localStorage
// 而不是后端 state.json —— 那份是全局配置，换个客户端就被别人的顺序覆盖了。
const ORDER_KEY = 'airoute.channels-card-order'
// 顺序按**卡**存（不是按 provider）：合并卡的 id 是第一个成员的 provider id
const DEFAULT_ORDER = [...WB_CARDS.map(card => card.id), ...CARD_GROUPS.map(group => group.id)]

function loadSavedOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
    // 过滤掉已经不存在的 id：渠道包升级删了某个 provider 时旧顺序里会留着它。
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

const route = useRoute()
const router = useRouter()
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
const busyKey = ref('') // 行内/卡内按钮的互斥键，形如 `${id}:${action}`
// 账号 id → 余额查询结果 { total, error }。
// 不放进 accounts 里：余额是**按需**查的（要打上游），与账号清单（本地读盘）不同源，
// 混在一起会让 5 秒轮询把每次轮询都变成一轮余额请求。
const balances = ref({})
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

// ==================== Auto 策略 ====================
//
// 策略是全局一档：客户端请求里的模型名只填 `auto`，由这里选定的口径决定怎么
// 从候选里挑。策略存在服务端（server-config.json），换台机器导入配置就带走。
const strategies = ref([])
const strategy = ref('balanced')
const strategySaving = ref(false)

// SegmentedTabs 的选项表：note 进 title（悬停提示），不占版面
const strategyTabs = computed(() =>
  strategies.value.map(item => ({ value: item.id, label: item.label, title: item.note })))

async function loadStrategy() {
  try {
    const data = await getAutoStrategy()
    strategies.value = data.strategies || []
    strategy.value = data.strategy || 'balanced'
  } catch {
    /* 读不到就按默认档显示，不挡住模型清单的渲染 */
  }
}

async function pickStrategy(id) {
  if (id === strategy.value || strategySaving.value) return
  strategySaving.value = true
  const previous = strategy.value
  strategy.value = id // 先切：界面立刻反映选择，服务端失败再回滚
  try {
    const data = await updateAutoStrategy(id)
    strategy.value = data.strategy || id
    showToast('Auto 策略已切换')
  } catch (err) {
    strategy.value = previous
    showToast('切换策略失败：' + err.message, 'error', 6000)
  } finally {
    strategySaving.value = false
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
const wbLogin = ref(null) // { state, url, realm, message }
const wbBusy = ref('') // `${uid}:${action}`
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
    await auditModelHealth().catch(() => null)
    await loadModelHealth()
    await loadAccountHealth()
    const targets = PROVIDERS.filter(p => (statuses.value[p.id]?.accounts?.total || 0) > 0)
    const failed = []
    const lists = await Promise.all(targets.map(async p => {
      try {
        // 自有实现的 account.list 直接回数组（渠道包时代是 { accounts }），两种都认；
        // 行里不带 provider 字段，而模板是按 provider 分卡的（accountsOf），
        // 所以在这里补上 —— 漏了它每张卡都会显示成「还没有账号」，
        // 徽标却是「1/1 账号」，自相矛盾
        const value = await channelsRpc('account.list', { provider: p.id })
        const rows = Array.isArray(value) ? value : (value?.accounts || [])
        return rows.map(row => ({ provider: p.id, ...row }))
      } catch (err) {
        failed.push(p.id)
        return []
      }
    }))
    accounts.value = lists.flat()
    if (failed.length && !silent) showToast(`部分渠道账号读取失败：${failed.join('、')}`, 'error', 6000)
    // WorkBuddy 是另一套后端，失败自己兜（见 loadWorkbuddy），不能连带整页报错
    await loadWorkbuddy()
    // 余额按 5 分钟节流自动拉（loadBalancesAll 内部判），不用等用户手点
    await loadBalancesAll()
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
        // model.list 的 value 就是模型数组本身（不是 { models }）：按对象解构只会
        // 拿到 undefined，三家插件渠道于是在模型页整组消失，只剩 WorkBuddy 两区
        const models = await channelsRpc('model.list', { provider: p.id })
        return [p.id, Array.isArray(models) ? models : []]
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
  if (next === 'models') {
    // 策略是这一页的总开关，跟模型清单一起读；读失败不挡清单
    await loadStrategy()
    await loadModels()
  }
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
// 链接一律用 utils/channel-links.js 里的内置默认值（只放能确证的官方域名）。
// 这里是**只读**的：卡片上的「明细」按钮直接取默认值打开浏览器，
// 页面不再提供改链接的入口 —— 少了一个要解释「这条链接存在哪」的地方。

// WorkBuddy 的国内版 / 国际版是两个站点，别的渠道只有一个入口。
// 调用方直接传卡的区域（'cn' / 'global'），不再需要账号对象换算 slot
function consoleUrlOf(providerId, slotKey) {
  const slot = slotsOf(providerId).find(item => item.key === slotKey)
  return slot?.url || ''
}

function openConsole(providerId, slotKey) {
  const url = consoleUrlOf(providerId, slotKey)
  if (!url) {
    // 没有默认值的渠道（目前只有 Raccoon）：如实说没有，别弹一个填不了的编辑器
    showToast('这家还没有内置的个人中心链接', 'error', 3500)
    return
  }
  openInBrowser(url)
}

// ==================== 添加账号（右上角入口） ====================
//
// 没登录的渠道不再单独占一张卡：空卡里只有一句「还没有账号」和一个登录按钮，
// 三家排下来大半是空卡。要加账号只能走这一个入口，所以它列全所有可登录的目标，
// 用户不必先找到对应的那张卡。
const addMenuOpen = ref(false)
const addWrapEl = ref(null)

// 目标清单：WorkBuddy 两个区域各算一项（域名与 OAuth 入口不同），
// 其余渠道按 provider 列 —— Qoder 国际版 / 国内版是两家独立凭据，分开列清楚。
// logo 是菜单项前的品牌标：三家都有官方图（public/brand-*.png/svg），
// 没有官方图时才退回品牌色字母标。
const ADD_ENTRIES = [
  { key: 'workbuddy:cn', label: 'WorkBuddy 国内版', kind: 'workbuddy', realm: 'cn', logo: '/brand-workbuddy.svg', logoText: 'W', logoBg: '#0e7a4a' },
  { key: 'workbuddy:global', label: 'WorkBuddy 国际版', kind: 'workbuddy', realm: 'global', logo: '/brand-workbuddy.svg', logoText: 'W', logoBg: '#0e7a4a' },
  ...PROVIDERS.map(p => ({
    key: p.id,
    label: p.option,
    kind: 'channel',
    provider: p.id,
    logo: p.logo || null,
    logoText: (p.option || p.name)[0],
    logoBg: p.logoBg || '#3b82f6',
  }))
]

// 卡头品牌标：按卡 id 找对应渠道的官方图；找不出图时退回品牌色字母标。
// WorkBuddy 两张卡共用一张图，其余渠道按 provider 配置取
function cardLogo(cardId) {
  if (cardId === 'workbuddy' || cardId === 'workbuddy-global') return '/brand-workbuddy.svg'
  return PROVIDERS.find(p => p.id === cardId)?.logo || null
}
function cardLogoBg(cardId) {
  return PROVIDERS.find(p => p.id === cardId)?.logoBg || '#3b82f6'
}
function cardLogoText(cardId) {
  return (PROVIDERS.find(p => p.id === cardId)?.name || '?')[0]
}

function toggleAddMenu() {
  addMenuOpen.value = !addMenuOpen.value
}

// 点外面收起菜单：手写的下拉没有组件库那套 popover，点击别处必须能关掉
function onDocPointerDown(e) {
  if (!addMenuOpen.value) return
  if (addWrapEl.value && addWrapEl.value.contains(e.target)) return
  addMenuOpen.value = false
}

// 从右上角菜单发起登录：渠道走 account.create，WorkBuddy 走它自己的设备授权
async function pickAdd(entry) {
  addMenuOpen.value = false
  if (entry.kind === 'workbuddy') {
    if (wbLogin.value) return
    // 区域跟着菜单项走：卡上已经没有下拉，区域只能由菜单这一处决定
    await wbStartLogin(entry.realm)
    return
  }
  const provider = PROVIDERS.find(p => p.id === entry.provider)
  if (!provider) return
  await startLogin(provider)
}

async function startLogin(p) {
  if (login.value) return
  busyKey.value = p.id + ':login'
  try {
    const payload = { provider: p.id }
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

// ==================== 账号 ====================
//
// 账号卡按 provider 展示。登录入口统一走页面右上角的「添加账号」菜单。

// 分组内某个区域的信息
function providerOfId(id) {
  return PROVIDERS.find(p => p.id === id) || { id, name: id, option: id }
}

function providerNameOf(id) {
  return providerOfId(id).name
}

function accountsOf(group) {
  const ids = new Set(group.providers.map(p => p.id))
  return accounts.value.filter(a => ids.has(a.provider))
}

// 真正登录成功的账号：发起登录时渠道会先登记一条**占位账号**（还没有凭据，
// 浏览器授权完成后才补上）。占位账号不算「登录成功」—— 拿它判「这家登录过吗」
// 会让一张空卡冒出来，用户只看到「未登录 / 无账号」。
// hasCredential 缺失按「有」处理：老账号没有这个字段，别因为缺字段就藏掉卡片。
function loggedInAccountsOf(group) {
  return accountsOf(group).filter(a => a.hasCredential !== false)
}

// 空卡被藏起来后，正在等授权的那张卡必须仍然露出来 ——
// 否则用户在右上角点了「添加账号」却看不到任何反应
function isLoggingIn(group) {
  return !!login.value && group.providers.some(p => p.id === login.value.provider)
}

// 要渲染的卡：只有**登录成功**的渠道才占位（加账号走右上角入口）。
// 过滤放在计算属性里而不是模板的 v-if 上 —— v-if 与 v-for 同元素时，
// v-if 先于 v-for 求值，拿不到循环变量。
const visibleCardGroups = computed(() =>
  CARD_GROUPS.filter(group => loggedInAccountsOf(group).length || isLoggingIn(group)))

// 账号行标题：自有渠道的行字段是 name，WorkBuddy 是 nickname；都没有才退回 id。
// 直接写 `nickname || id` 会让 Trae / Qoder 显示成 Trae-45ab04e0 这种内部 id
function accountName(acct) {
  return acct.nickname || acct.name || acct.uid || acct.id
}

async function toggleAccount(acct, event) {
  const enabled = event.target.checked
  busyKey.value = acct.id + ':enable'
  try {
    await channelsRpc('account.update', { accountId: acct.id, provider: acct.provider, patch: { enabled } })
    await reload()
  } catch (err) {
    event.target.checked = !enabled
    showToast('切换账号状态失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// 单个账号的签到：回执走 toast。卡片里不再留结果块 ——
// 那块要占一整行、跨账号累加，而用户点的是某一行，回执就该在点的地方出现
async function checkinAccount(acct) {
  busyKey.value = acct.id + ':checkin'
  try {
    const value = await channelsRpc('account.checkin', { provider: acct.provider, accountId: acct.id }, 180000)
    const outcome = value.outcome === 'claimed'
      ? { kind: 'claimed', credit: value.credit, unit: 'credit' }
      : value.outcome === 'done'
        ? { kind: 'already-claimed', message: '今天已签过' }
        : value.outcome === 'ineligible'
          ? { kind: 'inactive', message: value.message || '未开通' }
          : { kind: 'failed', message: value.message || '签到失败' }
    showToast(`${accountName(acct)}：${outcomeText(outcome)}`, outcome.kind === 'failed' ? 'error' : undefined)
    // 签到会写下「今天签过」与积分，重读一次让按钮立刻置灰、积分立刻更新。
    // 不重读的话要等下一轮 5 秒轮询，用户会以为没生效又点一次
    await reload({ silent: true })
  } catch (err) {
    showToast('签到失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// 行上显示的余额文案。查不到就说查不到，不能显示 0 ——
// 「余额 0」会被理解成「额度被清空了」，而真实原因往往是上游没给这个端点。
function balanceText(acct) {
  const record = balances.value[acct.id]
  if (!record) return ''
  if (record.error) return '余额查询失败'
  return `积分 ${formatCredit(record.total)}`
}

// 余额自动刷新：有 balance 端点的渠道，整渠道一次拉齐（credits.balances 内部
// 已逐账号顺序查，比行上逐个 account.balance 少 N-1 次往返）。
// 余额是分钟级的慢变量（失活审计也是 10 分钟一轮），按 5 分钟节流，
// 不跟随 5 秒的页面轮询 —— 那只会替上游制造压力。
let balancesRefreshedAt = 0
let balancesLoading = false
const BALANCE_REFRESH_MS = 5 * 60 * 1000

async function loadBalancesAll({ force = false } = {}) {
  if (balancesLoading) return
  if (!force && Date.now() - balancesRefreshedAt < BALANCE_REFRESH_MS) return
  const targets = PROVIDERS.filter(p => statuses.value[p.id]?.capabilities?.balance === true
    && accounts.value.some(a => a.provider === p.id))
  if (!targets.length) return
  balancesLoading = true
  const patch = {}
  try {
    const results = await Promise.all(targets.map(async p => {
      try {
        const value = await channelsRpc('credits.balances', { provider: p.id }, 120000)
        return value?.accounts || []
      } catch {
        return []
      }
    }))
    for (const rows of results) {
      for (const row of rows) {
        if (!row?.accountId) continue
        const total = row?.balance?.total
        patch[row.accountId] = Number.isFinite(total)
          ? { total, error: '' }
          : { total: null, error: row?.error || '查询失败' }
      }
    }
    balances.value = { ...balances.value, ...patch }
    balancesRefreshedAt = Date.now()
  } finally {
    balancesLoading = false
  }
}
async function testAccount(acct) {
  busyKey.value = acct.id + ':test'
  try {
    const value = await channelsRpc('account.test', { accountId: acct.id, provider: acct.provider }, 180000)
    const label = accountName(acct)
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
  const label = accountName(acct)
  if (!window.confirm(`确定删除账号「${label}」吗？\n凭据文件会一并删除，该账号不再参与请求。`)) return
  busyKey.value = acct.id + ':delete'
  try {
    await channelsRpc('account.delete', { accountId: acct.id, provider: acct.provider })
    showToast(`已删除「${label}」`)
    await reload()
    if (tab.value === 'models') await loadModels()
  } catch (err) {
    showToast('删除失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

async function claimOnboarding(acct) {
  busyKey.value = acct.id + ':onboarding'
  try {
    const before = await channelsRpc('onboarding.status', { provider: acct.provider, accountId: acct.id })
    if (before.earned >= before.total && before.total > 0) {
      showToast(`${accountName(acct)} 的新手任务已全部领取（${before.earned}/${before.total}）`)
      return
    }
    const value = await channelsRpc('onboarding.claim', { provider: acct.provider, accountId: acct.id }, 300000)
    showToast(
      `${accountName(acct)} 领取 ${value.claimed.length} 项、跳过 ${value.skipped.length} 项，`
      + `累计 ${value.earned}/${value.total}`
    )
  } catch (err) {
    showToast('领取新手任务失败：' + err.message, 'error', 6000)
  } finally {
    busyKey.value = ''
  }
}

// ==================== 积分 ====================

// 端点支持与否由后端的 provider.status.capabilities 回答（插件没实现那个方法
// 就是这家不支持，见 plugin-api.js 的可选方法表）。面板不再靠「按钮点了报错」
// 让用户自己发现这件事：
//   · 签到：只有 Trae 有 checkin_credits；
//   · 账号测试：account.test 还留在旧 RPC 表里，当前插件没实现。
// 读不到 capabilities 时按「支持」处理（宁可显示也不突然消失），
// 只有明确为 false 才隐藏。
function capabilityOf(providerId, key) {
  const caps = statuses.value[providerId]?.capabilities
  return !caps || caps[key] !== false
}

function supportsCheckinOf(acct) {
  return capabilityOf(acct.provider, 'checkin')
}

function supportsAccountTest(acct) {
  const caps = statuses.value[acct.provider]?.capabilities
  return caps ? caps.test === true : false
}

function canClaim(p) {
  return CLAIM_PROVIDERS.includes(p.id)
}

// 传 provider（操作行按区域判断）或账号行（行上的「新手任务」按钮）都行
function supportsOnboarding(target) {
  return ONBOARDING_PROVIDERS.includes(target?.id || target?.provider)
}

// 单条签到结果的文案：只用于行内 toast（卡片里的结果块已移除）
function outcomeText(outcome) {
  if (!outcome) return '—'
  if (outcome.kind === 'claimed') {
    // 上游没回报金额时只说「领取成功」：不写「+?」（像算错了），
    // 也不写「未返回金额」（把内部细节摊给用户看）
    if (outcome.credit === undefined || outcome.credit === null) return '领取成功'
    const unit = outcome.unit === 'token' ? 'Token' : '积分'
    const amount = outcome.unit === 'token' ? formatToken(outcome.credit) : formatCredit(outcome.credit)
    return `+${amount} ${unit}`
  }
  if (outcome.kind === 'already-claimed') return outcome.message || '今天已领过'
  if (outcome.kind === 'inactive') return outcome.message || '活动未开通'
  return outcome.message || '失败'
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

// 关掉「已开启模型」清单里的全部模型：清单本身就是范围，逐个关掉即可
async function closeAllEnabled() {
  const count = enabledModels.value.length
  busyKey.value = 'enabled:models'
  try {
    for (const row of enabledModels.value) {
      await setModelsDisabled(row.provider, [row.model.id], true)
    }
    showToast(`已关闭 ${count} 个模型`)
    await loadModels()
    await loadStatus()
  } catch (err) {
    showToast('批量关闭失败：' + err.message, 'error', 6000)
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
    // 部分通过不是全错：标黄（warn），别用红色吓人一跳
    showToast(`测完 ${tested.length} 个：通过 ${passed}，失败 ${failed}（红点上看原因）`, 'warn', 10000)
  }
}

// ==================== 格式化 ====================

function formatTime(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ==================== WorkBuddy：读取 / 登录 / 操作 ====================

const wbCnCount = computed(() => wbList.value.filter(a => a.realm !== 'global').length)

// 按 realm 分流到对应卡上的账号：realm === 'global' 是国际版，其余都算国内版
function wbAccountsOf(region) {
  return wbList.value.filter(a => (a.realm === 'global') === (region === 'global'))
}

// 失败不弹 toast：整页读取失败时 reload() 已经弹过一次，这里再弹就是两条重复提示。
// 改用卡片上的 wbError 兜底，避免接口挂了却显示成「还没有账号」。
async function loadWorkbuddy() {
  try {
    const data = await fetchWbAccounts()
    wbList.value = data.accounts || []
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

async function wbStartLogin(realm = 'cn') {
  wbBusy.value = ':login'
  try {
    const target = realm === 'global' ? 'global' : 'cn'
    const data = await wbOauthStart(target)
    wbLogin.value = { state: data.state, url: data.url, message: '', realm: data.realm || target }
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
  // WorkBuddy 走的是设备授权：账号要等轮询成功才落盘，取消时服务端没有占位账号
  // 可删（不像渠道包那样会先登记一条空账号），所以这里只停掉前端的等待
  wbStopPolling()
  wbLogin.value = null
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

// ==================== 一键签到 ====================
// 覆盖渠道包里能领积分的九个渠道 + WorkBuddy 国内版账号，逐渠道顺序执行：
//   · 渠道包的 credits.claimAll 内部已经是逐账号顺序领取，这里再并发只会一起撞上游风控；
//   · WorkBuddy 复用调度器的签到任务（自带全账号限速与连登管家），不另写一遍循环。
// 单渠道失败不中断后面的渠道，原因写进该卡片的「领取结果」，顶部只汇总。
const checkinAll = ref({ running: false, done: 0, total: 0 })
const checkinSummary = ref('')
const checkinFailed = ref(false)

const accountsOfProvider = computed(() => {
  const map = new Map(PROVIDERS.map(p => [p.id, []]))
  for (const acct of accounts.value) map.get(acct.provider)?.push(acct)
  return map
})
const claimableProviders = computed(() => PROVIDERS.filter(p => canClaim(p) && (accountsOfProvider.value.get(p.id) || []).length > 0))
const checkinTotal = computed(() => claimableProviders.value.length + (wbCnCount.value > 0 ? 1 : 0))

// 「今天还剩谁没签」：一键签到按「渠道」为单位（一个渠道一次 claimAll），
// 所以一个渠道算不算已签，看它名下所有支持签到的账号是不是都已经签过；
// WorkBuddy 那边同理，看国内版账号是不是全签过。
// 混着「有的签了有的没签」的渠道仍然算待签 —— 只签剩下的那几个才是对的。
function providerPending(p) {
  const list = (accountsOfProvider.value.get(p.id) || []).filter(supportsCheckinOf)
  if (!list.length) return false
  return list.some(a => !a.checkinDone)
}

const pendingProviders = computed(() => claimableProviders.value.filter(providerPending))
const wbPending = computed(() => wbList.value.some(a => a.realm !== 'global' && !a.checkinDone))
const checkinPending = computed(() => pendingProviders.value.length + (wbPending.value ? 1 : 0))
// 全部签过：按钮置灰成「已签」，别再让人点一个必然回「今天已签过」的动作
const allChecked = computed(() => checkinTotal.value > 0 && checkinPending.value === 0)

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
  if (checkinAll.value.running || checkinPending.value === 0) return
  // 已经全签过的目标不进名单：省掉一次必然返回「今天已签过」的请求，
  // 顺带让进度里的分母等于真正还要签的处数
  const targets = pendingProviders.value.map(p => ({ kind: 'channel', provider: p }))
  if (wbPending.value) targets.push({ kind: 'workbuddy' })
  checkinAll.value = { running: true, done: 0, total: targets.length }
  checkinSummary.value = ''
  checkinFailed.value = false
  const totals = { claimed: 0, alreadyClaimed: 0, inactive: 0, failed: 0, token: 0, credit: 0 }
  const errors = []
  try {
    for (const target of targets) {
      if (target.kind === 'channel') {
        const p = target.provider
        try {
          const value = await channelsRpc('credits.claimAll', { provider: p.id }, 600000)
          const s = value.summary || {}
          totals.claimed += Number(s.claimed) || 0
          totals.alreadyClaimed += Number(s.alreadyClaimed) || 0
          totals.inactive += Number(s.inactive) || 0
          totals.failed += Number(s.failed) || 0
          const byUnit = s.totalByUnit || { credit: s.totalCredit, token: 0 }
          totals.credit += Number(byUnit.credit) || 0
          totals.token += Number(byUnit.token) || 0
        } catch (err) {
          // 失败原因并进顶部汇总：卡片里不再有结果块，这里不记就彻底没地方看了
          errors.push(`${p.name}（${err.message}）`)
        }
      } else {
        try {
          await wbSchedulerRun('checkin')
        } catch (err) {
          errors.push(`WorkBuddy（${wbErrText(err)}）`)
        }
      }
      checkinAll.value = { ...checkinAll.value, done: checkinAll.value.done + 1 }
    }
    checkinSummary.value = checkinSummaryText(totals, errors)
    checkinFailed.value = errors.length > 0 || totals.failed > 0
    showToast(checkinSummary.value, checkinFailed.value ? 'error' : 'success', 8000)
    // 签到会改积分与「今天签过」的状态，重读一次让卡片上的数字与按钮跟得上
    await reload({ silent: true })
  } catch (err) {
    checkinFailed.value = true
    checkinSummary.value = '一键签到中断：' + (err?.message || '未知错误')
    showToast(checkinSummary.value, 'error', 8000)
  } finally {
    checkinAll.value = { ...checkinAll.value, running: false }
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

// ==================== 启动引导跳转 ====================

// 引导的「登录免费账号」直接落到 WorkBuddy 卡上并把登录点下去：让用户来这里只为
// 找一次按钮的话，这一步就白讲了。?add=workbuddy 是契约，别的取值忽略。
// 参数处理完立刻 replace 掉 —— 刷新页面不该再自动发起一次登录
function runOnboardingRequest() {
  if (route.query.add !== 'workbuddy') return
  router.replace({ path: route.path, query: {} })
  if (wbBusy.value || wbLogin.value) return
  wbStartLogin()
}

onMounted(() => {
  reload()
  runOnboardingRequest()
  document.addEventListener('pointerdown', onDocPointerDown)
})
onUnmounted(() => {
  stopPolling()
  wbStopPolling()
  document.removeEventListener('pointerdown', onDocPointerDown)
  // 拖拽中切走页面时把拖拽状态一并收掉，否则落点监听会留在 document 上
  finishDrag({ cancel: true })
  // 离开页面时把正在跑的模型测试也停掉：否则它会继续对着上游一个个打，
  // 用户已经在别的页面了，连「停止」按钮都看不见
  stopModelTests()
})
</script>

<style scoped>



/* Auto 策略：独立一张卡，标题 + 分段控件（SegmentedTabs，与页面顶部视图切换同款）。
   卡片间距走页面的统一节奏（与 .ch-grid 的 gap 一致） */
.ch-strategy-card {
  margin-bottom: 14px;
}

.ch-strategy-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ch-strategy-title {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
}

/* 读不到策略档位时的说明行：说清「为什么空着」和「怎么办」，
   免得只剩一张空卡片让人以为页面坏了 */
.ch-strategy-empty {
  font-size: var(--fs-small);
  color: var(--text-3);
}

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

/* 添加账号：按钮 + 自绘下拉。仓库里没引入 popover 组件，
   为一个菜单引一整套依赖不值当 */
.ch-add-wrap {
  position: relative;
}

.ch-add-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  min-width: 260px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--bg-elevated, var(--bg-card));
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

/* 菜单项：品牌标 + 名称 */
.ch-add-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  text-align: left;
  font-size: var(--fs-small);
  color: var(--text-1);
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
}

/* 官方品牌图（Qoder）：原图是黑标透明底，深色主题下会看不见，
   所以垫一块白底方块 —— 两种主题都清楚 */
.ch-add-logo-img {
  flex: none;
  width: 20px;
  height: 20px;
  object-fit: contain;
  padding: 2px;
  background: #fff;
  border-radius: var(--radius-xs);
}

/* 字母标：没有官方图的那几家用它占位，底色取品牌色 */
.ch-add-logo {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-mini);
  font-weight: 600;
  color: #fff;
  border-radius: var(--radius-xs);
}

.ch-add-item:hover {
  background: var(--bg-chip);
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

/* 卡头渠道名前的品牌标：与「添加账号」菜单同一规格（20px 方块垫白底），
   两种主题下都清楚 */
.ch-card-logo {
  flex: none;
  align-self: center;
  width: 20px;
  height: 20px;
  object-fit: contain;
  padding: 2px;
  background: #fff;
  border-radius: var(--radius-xs);
}

.ch-card-logo-text {
  flex: none;
  align-self: center;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-mini);
  font-weight: 600;
  color: #fff;
  border-radius: var(--radius-xs);
}

.ch-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* 合并卡（Qoder 国际版 / 国内版）不再有自己的骨架：它和 WorkBuddy 一样是
   卡头 + 一个账号盒 + 一行操作，区域只体现在账号行的标签与操作行的下拉上。
   所以这里没有「分段」样式 —— 上一版的 ch-provider-seg / ch-provider-head
   随模板一起去掉了，留着只会是没人再命中的死规则。 */

.ch-check {
  width: 14px;
  height: 14px;
  padding: 0;
  margin: 0;
  accent-color: var(--primary);
  cursor: pointer;
}

/* ===== 账号行 ===== */

.ch-accounts {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

/* 账号行：名字与状态/积分并排一行 —— 拆卡后每卡只有一个区域，信息量变短，
   两行排版让每张卡都多出一截高度，一行排下来扫读更快 */
.ch-account {
  display: flex;
  align-items: center;
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
  cursor: pointer;
}

.ch-account-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.ch-account-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--fs-small);
  color: var(--text-1);
  word-break: break-all;
}

.ch-extra {
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.ch-account-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: var(--fs-mini);
  color: var(--text-3);
}

.ch-account-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 「个人中心」按钮：账号行与操作行的文字按钮已经不少，用文字按钮占位省地方 */
/* 尺寸与外观由 AppButton 提供，这里只让它不参与 flex 压缩 */
.ch-icon-btn {
  flex: none;
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
/* 区块本身（边框 / 底色 / 标题 / 链接 / 按钮 / 状态）都在共用组件
   OauthAuthBlock 里，卡片里只留一个无边距的挂点，不再套一层框 */

/* ===== 操作行 / 结果 ===== */

/* 卡头右侧的「更多」入口：低频功能（积分 / 任务）不在卡片里展开。
   在卡头里不再是行尾（margin-left:auto 会顶到最右），就顺着徽标排 */
.ch-more {
  font-size: var(--fs-xs);
  color: var(--text-2);
  text-decoration: none;
  white-space: nowrap;
}

.ch-more:hover {
  text-decoration: underline;
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
.ch-enabled-card {
  margin-bottom: 14px;
}

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

/* 模型过滤输入框：工具栏里唯一的文本控件。
   宽度固定而不 flex:1 —— 拉满会把它和右侧那点留白拉开距离，
   反而看不清筛完之后在操作什么 */
.ch-model-filter {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.ch-model-filter-input {
  width: 200px;
  padding: 0 24px 0 10px;
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

.ch-model-group {
  padding-top: 12px;
  border-top: 1px solid var(--border-2);
}

/* 「已开启模型」板块：独立成一张卡片（.ch-enabled-card），底色用全局卡片的；
   .ch-enabled-block 只剩卡内的组头 + 清单布局 */
.ch-enabled-block {
  padding: 0;
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

/* 开启中的模型是这张清单的主角：实心底 + 实线边框 + 加重字重，
   和「关闭」（透明底 + 虚线 + 灰字）拉开一档，一眼能数出开着几个 */
.ch-model {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-1);
  background: var(--primary-bg-hover);
  border: 1px solid var(--border-3);
  border-radius: var(--radius-pill);
}

.ch-model:hover {
  border-color: var(--primary);
}

/* 关闭态：透明底 + 虚线 + 灰字 —— 看起来「不在列表里」 */
.ch-model.off {
  font-weight: 400;
  color: var(--text-4);
  background: transparent;
  border-color: var(--border-2);
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

