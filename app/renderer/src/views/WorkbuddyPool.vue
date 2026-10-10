<template>
  <div class="wb-page">
    <!-- 页面头部：标题 + 汇总统计 + 刷新 -->
    <div class="page-header">
      <h1 class="page-title">WorkBuddy 账号池</h1>
      <div class="header-right">
        <div class="wb-stats">
          <span class="stat">总计 <b>{{ counts.total }}</b></span>
          <span class="stat ok">可用 <b>{{ counts.healthy }}</b></span>
          <span class="stat warn">冷却 <b>{{ counts.cooling }}</b></span>
          <span class="stat bad">禁用 <b>{{ counts.disabled }}</b></span>
        </div>
        <button class="btn-ghost btn-sm" @click="refreshPage">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </div>

    <!-- 顶部 Tab 导航 -->
    <div class="wb-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="wb-tab"
        :class="{ active: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- ==================== Tab 1：账号池 ==================== -->
    <div v-if="tab === 'accounts'">
      <div class="card wb-card">
        <div class="wb-toolbar">
          <button class="btn-primary btn-sm" :disabled="!!oauth" @click="startAddAccount">+ 添加账号</button>
          <button class="btn-ghost btn-sm" :disabled="busyAll" @click="checkinAll">
            {{ busyAll === 'checkin' ? '执行中…' : '全部签到' }}
          </button>
          <button class="btn-ghost btn-sm" :disabled="!!busyAll" @click="refreshBalanceAll">
            {{ busyAll === 'balance' ? '刷新中…' : '刷新余额' }}
          </button>
        </div>

        <!-- OAuth 登录流程（页内区块，非弹窗） -->
        <div v-if="oauth" class="wb-oauth">
          <div class="wb-oauth-title">请在浏览器中完成 WorkBuddy 登录授权</div>
          <div class="wb-oauth-url" :title="oauth.url">{{ oauth.url }}</div>
          <div class="wb-oauth-actions">
            <button class="btn-primary btn-sm" @click="openAuthUrl">打开授权链接</button>
            <button class="btn-ghost btn-sm" @click="copyAuthUrl">复制链接</button>
            <button class="btn-ghost btn-sm" @click="cancelOauth">取消</button>
          </div>
          <div class="wb-oauth-status">{{ oauth.message || '等待浏览器完成登录，每 3 秒自动检测一次…' }}</div>
        </div>

        <div v-if="!accounts.length" class="wb-empty">
          还没有 WorkBuddy 账号，点击「+ 添加账号」通过 OAuth 登录（在浏览器打开授权链接完成登录）。
        </div>

        <div v-else class="table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>昵称</th>
                <th>状态</th>
                <th>积分</th>
                <th>今日签到</th>
                <th>今日 token</th>
                <th>累计 token</th>
                <th>最近签到</th>
                <th>最近保活</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="acct in accounts" :key="acct.uid">
                <td class="nowrap">{{ acct.nickname || '（未命名账号）' }}</td>
                <td class="nowrap">
                  <span class="wb-state" :class="stateClass(acct)">{{ stateLabel(acct) }}</span>
                  <span v-if="acct.runningAction" class="wb-running">{{ runningLabel(acct.runningAction) }}</span>
                </td>
                <td class="nowrap">{{ acct.credits }}</td>
                <td class="nowrap">{{ acct.checkinDone ? '已签到' : '-' }}</td>
                <td class="nowrap">{{ fmtNum(acct.tokenUsageToday) }}</td>
                <td class="nowrap">{{ fmtNum(acct.tokenUsageTotal) }}</td>
                <td class="nowrap">{{ acct.lastCheckinAt ? formatTime(acct.lastCheckinAt) : '-' }}</td>
                <td class="nowrap">
                  <template v-if="acct.lastKeepaliveAt">
                    {{ formatTime(acct.lastKeepaliveAt) }}
                    <span :class="acct.lastKeepaliveOk ? 'wb-ok' : 'wb-bad'">{{ acct.lastKeepaliveOk ? '成功' : '失败' }}</span>
                  </template>
                  <span v-else>-</span>
                </td>
                <td class="nowrap">
                  <button class="btn-ghost btn-sm" :disabled="busyUid === acct.uid" @click="doCheckin(acct)">签到</button>
                  <button class="btn-ghost btn-sm" :disabled="busyUid === acct.uid" @click="doBalance(acct)">余额</button>
                  <button class="btn-ghost btn-sm" :disabled="busyUid === acct.uid" @click="doKeepalive(acct)">保活</button>
                  <button class="btn-ghost btn-sm" @click="openDetail(acct)">详情</button>
                  <button v-if="acct.disabled" class="btn-ghost btn-sm" @click="doEnable(acct)">恢复</button>
                  <button v-else class="btn-ghost btn-sm" @click="doDisable(acct)">禁用</button>
                  <button class="btn-danger btn-sm" @click="doRemove(acct)">移除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 账号详情弹窗：列表不展示的明细（冷却/熔断/在途/模型受限/禁用原因等）都在这里 -->
    <div v-if="detailAcct" class="wb-modal-overlay" @click.self="closeDetail">
      <div class="card wb-modal">
        <div class="wb-modal-header">
          <h2>{{ detailAcct.nickname || '账号详情' }}</h2>
          <button class="wb-modal-close" @click="closeDetail">×</button>
        </div>
        <div class="wb-kv"><span class="wb-kv-label">uid</span><span class="wb-kv-value mono">{{ detailAcct.uid }}</span></div>
        <div class="wb-kv">
          <span class="wb-kv-label">当前状态</span>
          <span class="wb-kv-value">
            <span class="wb-state" :class="stateClass(detailAcct)">{{ stateLabel(detailAcct) }}</span>
            <span v-if="detailAcct.runningAction" class="wb-running">{{ runningLabel(detailAcct.runningAction) }}</span>
          </span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">冷却类型 / 剩余</span>
          <span class="wb-kv-value">
            {{ detailAcct.cooling ? coolKindLabel(detailAcct.coolKind) + ' / ' + formatRemain(detailAcct.coolRemaining) : '-' }}
          </span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">连续失败 / 熔断剩余</span>
          <span class="wb-kv-value">
            {{ detailAcct.consecutiveFails || 0 }} 次 / {{ detailAcct.breakerRemaining > 0 ? formatRemain(detailAcct.breakerRemaining) : '-' }}
          </span>
        </div>
        <div class="wb-kv"><span class="wb-kv-label">在途请求数</span><span class="wb-kv-value">{{ detailAcct.inFlight || 0 }}</span></div>
        <div class="wb-kv">
          <span class="wb-kv-label">禁用原因 / 时间</span>
          <span class="wb-kv-value">
            {{ detailAcct.disabled
              ? (detailAcct.disabledReason || '未知原因') + ' / ' + (detailAcct.disabledAt ? formatTime(detailAcct.disabledAt) : '-')
              : '-' }}
          </span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">积分（剩余 / 总额）</span>
          <span class="wb-kv-value">{{ detailAcct.credits }} / {{ detailAcct.creditsTotal }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">快过期积分</span>
          <span class="wb-kv-value">
            {{ detailAcct.creditsExpiring || 0 }}（最早批次剩余 {{ detailAcct.creditsEarliestRemaining || 0 }}，到期
            {{ detailAcct.creditsEarliestExpiry ? formatTime(detailAcct.creditsEarliestExpiry) : '-' }}）
          </span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">token（今日 / 累计）</span>
          <span class="wb-kv-value">{{ fmtNum(detailAcct.tokenUsageToday) }} / {{ fmtNum(detailAcct.tokenUsageTotal) }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">最近签到</span>
          <span class="wb-kv-value">
            {{ detailAcct.lastCheckinAt ? formatTime(detailAcct.lastCheckinAt) : '-' }}{{ detailAcct.checkinDone ? '（今日已签到）' : '' }}
          </span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">最近保活</span>
          <span class="wb-kv-value">
            {{ detailAcct.lastKeepaliveAt ? formatTime(detailAcct.lastKeepaliveAt) + (detailAcct.lastKeepaliveOk ? ' 成功' : ' 失败') : '-' }}
          </span>
        </div>
        <div class="wb-kv"><span class="wb-kv-label">累计错误次数</span><span class="wb-kv-value">{{ detailAcct.errTotal || 0 }}</span></div>
        <div class="wb-detail-models">
          <div class="wb-kv-label">模型受限明细</div>
          <div v-if="!(detailAcct.rateLimitedModels || []).length" class="wb-note">无</div>
          <div v-else class="wb-model-limited">
            <div v-for="m in detailAcct.rateLimitedModels" :key="m.model">
              {{ m.model }}｜{{ m.kind === 'model_unavailable' ? '该后端无此模型' : '模型级限流' }}｜解除 {{ formatTime(m.until) }}
            </div>
          </div>
        </div>
        <div class="wb-modal-actions">
          <button v-if="detailAcct.disabled" class="btn-ghost btn-sm" @click="doEnable(detailAcct)">恢复启用</button>
          <button v-else class="btn-ghost btn-sm" @click="doDisable(detailAcct)">禁用账号</button>
          <button
            v-if="detailAcct.disabled || detailAcct.cooling || (detailAcct.rateLimitedModels || []).length"
            class="btn-ghost btn-sm"
            @click="doRevive(detailAcct)"
          >
            解冻
          </button>
          <button class="btn-ghost btn-sm" @click="gotoCredits(detailAcct)">查看积分</button>
          <button class="btn-primary btn-sm" @click="closeDetail">关闭</button>
        </div>
      </div>
    </div>

    <!-- ==================== Tab 2：积分构成 ==================== -->
    <div v-if="tab === 'credits'">
      <div class="card wb-card">
        <div class="wb-toolbar">
          <select v-model="creditUid" class="wb-select" @change="loadCredits">
            <option v-for="acct in accounts" :key="acct.uid" :value="acct.uid">
              {{ acct.nickname || acct.uid.slice(0, 12) }}
            </option>
          </select>
          <button class="btn-ghost btn-sm" @click="loadCredits">{{ creditLoading ? '加载中…' : '刷新' }}</button>
        </div>

        <div class="wb-note">积分批次按「快过期优先、未用完在前」排序，与后端返回顺序一致。</div>

        <div v-if="!accounts.length" class="wb-empty">还没有账号，请先在「账号池」添加。</div>
        <div v-else-if="creditLoading" class="wb-empty">加载中…</div>
        <div v-else-if="!creditPackages.length" class="wb-empty">该账号暂无积分批次数据</div>
        <div v-else class="table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>批次名称</th>
                <th>剩余</th>
                <th>已用</th>
                <th>总额</th>
                <th>到期时间</th>
                <th>周期包</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in creditPackages" :key="p.code || p.name">
                <td class="nowrap">{{ p.name }}</td>
                <td class="nowrap">{{ p.remain }}</td>
                <td class="nowrap">{{ p.used }}</td>
                <td class="nowrap">{{ p.size }}</td>
                <td class="nowrap">{{ formatTime(p.expiry) }}</td>
                <td class="nowrap">{{ p.cycle ? '是' : '否' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== Tab 3：用量 ==================== -->
    <div v-if="tab === 'usage'">
      <div class="card wb-card">
        <div class="wb-toolbar">
          <select v-model="usageHours" class="wb-select" @change="loadUsage">
            <option v-for="opt in USAGE_WINDOWS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <button class="btn-ghost btn-sm" @click="loadUsage">{{ usageLoading ? '加载中…' : '刷新' }}</button>
          <button class="btn-ghost btn-sm" :disabled="usageSaving" @click="saveUsage">{{ usageSaving ? '保存中…' : '立即落盘' }}</button>
          <span
            class="wb-count"
            v-if="usageData && usageData.yesterday"
            :title="`${usageData.yesterday.day} 全天合计（与所选窗口无关）`"
          >
            昨天：{{ formatInt(usageData.yesterday.req) }} 次请求 · {{ formatInt(usageData.yesterday.tt) }} Token · {{ formatCredit(usageData.yesterday.cr) }} 积分
          </span>
          <span class="wb-count" v-if="usageData">
            数据起点 {{ sinceText(usageData.since) }} · {{ usageData.buckets }} 桶 · {{ formatBytes(usageData.file_bytes) }}
          </span>
        </div>

        <div v-if="usageLoading && !usageData" class="wb-empty">加载中…</div>
        <div v-else-if="!usageData || !usageData.totals || usageData.totals.req === 0" class="wb-empty">该窗口暂无用量数据</div>
        <template v-else>
          <!-- 汇总卡组 -->
          <div class="wb-cards">
            <div class="wb-card-item">
              <div class="wb-card-label">请求数</div>
              <div class="wb-card-value">{{ formatInt(usageData.totals.req) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">失败数</div>
              <div class="wb-card-value bad">{{ formatInt(usageData.totals.err) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">输入 Token</div>
              <div class="wb-card-value">{{ formatInt(usageData.totals.pt) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">输出 Token</div>
              <div class="wb-card-value">{{ formatInt(usageData.totals.ct) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">总 Token</div>
              <div class="wb-card-value">{{ formatInt(usageData.totals.tt) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">平均延迟</div>
              <div class="wb-card-value">{{ formatAvg(usageData.totals.lat_avg) }} ms</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">平均输出速度</div>
              <div class="wb-card-value">{{ formatAvg(usageData.totals.tps_avg) }}</div>
            </div>
          </div>

          <!-- 积分扣除卡组 -->
          <div class="wb-cards wb-credit-cards">
            <div class="wb-card-item">
              <div class="wb-card-label">扣除积分</div>
              <div class="wb-card-value credit">{{ formatCredit(usageData.totals.cr) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">匹配 Token</div>
              <div class="wb-card-value">{{ formatInt(usageData.totals.crt) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">平均积分每 1M</div>
              <div class="wb-card-value credit">{{ formatCredit(usageData.totals.avg_credit_per_1m) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">有效样本</div>
              <div class="wb-card-value">{{ formatInt(usageData.totals.crn) }}</div>
            </div>
            <div class="wb-card-item">
              <div class="wb-card-label">失败数</div>
              <div class="wb-card-value bad">{{ formatInt(usageData.totals.err) }}</div>
            </div>
          </div>

          <!-- 账号维度表 -->
          <div class="wb-section-title">账号维度（{{ usageWindowLabel }}）</div>
          <div class="table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>请求</th>
                  <th>失败</th>
                  <th>输入 Token</th>
                  <th>输出 Token</th>
                  <th>总 Token</th>
                  <th>平均延迟</th>
                  <th>平均输出速度</th>
                  <th>积分扣除</th>
                  <th>平均积分每 1M</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in usageData.by_account" :key="row.key">
                  <td class="nowrap" :title="row.key">{{ accountLabel(row.key) }}</td>
                  <td class="nowrap">{{ formatInt(row.req) }}</td>
                  <td class="nowrap">{{ formatInt(row.err) }}</td>
                  <td class="nowrap">{{ formatInt(row.pt) }}</td>
                  <td class="nowrap">{{ formatInt(row.ct) }}</td>
                  <td class="nowrap">{{ formatInt(row.tt) }}</td>
                  <td class="nowrap">{{ formatAvg(row.lat_avg) }}</td>
                  <td class="nowrap">{{ formatAvg(row.tps_avg) }}</td>
                  <td class="nowrap">{{ formatCredit(row.cr) }}</td>
                  <td class="nowrap">{{ formatCredit(row.avg_credit_per_1m) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 模型 × 倍率维度表 -->
          <div class="wb-section-title">模型 × 倍率维度（{{ usageWindowLabel }}）</div>
          <div class="table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>倍率</th>
                  <th>请求</th>
                  <th>失败</th>
                  <th>输入 Token</th>
                  <th>输出 Token</th>
                  <th>总 Token</th>
                  <th>平均延迟</th>
                  <th>平均输出速度</th>
                  <th>积分扣除</th>
                  <th>平均积分每 1M</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in usageModelRows" :key="row.key">
                  <td class="nowrap" :title="row.key">{{ row.key }}</td>
                  <td class="nowrap">{{ row.rate || '-' }}</td>
                  <td class="nowrap">{{ formatInt(row.req) }}</td>
                  <td class="nowrap">{{ formatInt(row.err) }}</td>
                  <td class="nowrap">{{ formatInt(row.pt) }}</td>
                  <td class="nowrap">{{ formatInt(row.ct) }}</td>
                  <td class="nowrap">{{ formatInt(row.tt) }}</td>
                  <td class="nowrap">{{ formatAvg(row.lat_avg) }}</td>
                  <td class="nowrap">{{ formatAvg(row.tps_avg) }}</td>
                  <td class="nowrap">{{ formatCredit(row.cr) }}</td>
                  <td class="nowrap">{{ formatCredit(row.avg_credit_per_1m) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <!-- ==================== Tab 4：模型和档位 ==================== -->
    <div v-if="tab === 'models'">
      <div class="card wb-card">
        <div class="wb-toolbar">
          <button class="btn-primary btn-sm" :disabled="modelsLoading" @click="loadModels(true)">
            {{ modelsLoading ? '拉取中…' : '拉取上游模型' }}
          </button>
          <button class="btn-ghost btn-sm" :disabled="modelsSaving || !upstreamModels.length" @click="saveEnabledModels">
            {{ modelsSaving ? '保存中…' : '保存启用模型' }}
          </button>
          <span class="wb-count">已勾选 {{ enabledModelIds.length }} / {{ upstreamModels.length }}</span>
        </div>

        <div class="wb-note">
          勾选后的清单是账号池统一维护的启用模型，保存时会自动同步写入所有 WorkBuddy 类型 Provider 的模型列表。
        </div>

        <div v-if="!upstreamModels.length" class="wb-empty">还没有模型数据，点击「拉取上游模型」获取。</div>
        <div v-else class="table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>启用</th>
                <th>模型 id</th>
                <th>显示名</th>
                <th>积分倍率</th>
                <th>上下文长度</th>
                <th>最大输出</th>
                <th>支持档位</th>
                <th>默认档位</th>
                <th>图片</th>
                <th>工具调用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in upstreamModels" :key="m.id">
                <td>
                  <input type="checkbox" :checked="enabledModelIds.includes(m.id)" @change="toggleModel(m.id)" />
                </td>
                <td class="nowrap mono">{{ m.id }}</td>
                <td class="nowrap">{{ m.name || '-' }}</td>
                <td class="nowrap">{{ m.credits === '' || m.credits === undefined ? '-' : m.credits }}</td>
                <td class="nowrap">{{ m.maxContext ? formatK(m.maxContext) : '-' }}</td>
                <td class="nowrap">{{ m.maxOutput ? formatK(m.maxOutput) : '-' }}</td>
                <td class="nowrap">{{ m.efforts && m.efforts.length ? m.efforts.join('/') : '-' }}</td>
                <td class="nowrap">{{ m.defaultEffort || '-' }}</td>
                <td class="nowrap">{{ m.supportsImages ? '支持' : '-' }}</td>
                <td class="nowrap">{{ m.supportsToolCall ? '支持' : '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== Tab 4：成长任务 ==================== -->
    <div v-if="tab === 'tasks'">
      <div class="card wb-card">
        <div class="wb-toolbar">
          <select v-model="taskUid" class="wb-select" @change="onTaskAccountChange">
            <option v-for="acct in accounts" :key="acct.uid" :value="acct.uid">
              {{ acct.nickname || acct.uid.slice(0, 12) }}
            </option>
          </select>
          <button class="btn-primary btn-sm" :disabled="!taskUid || taskRunning" @click="runAllTasks">
            {{ taskRunning ? '执行中…' : '一键完成全部' }}
          </button>
          <button class="btn-ghost btn-sm" :disabled="!taskUid || taskAccepting" @click="acceptTasks">
            {{ taskAccepting ? '接受中…' : '接受任务' }}
          </button>
          <button class="btn-ghost btn-sm" :disabled="taskScanning" @click="scanTasks">
            {{ taskScanning ? '扫描中…' : '全账号扫描' }}
          </button>
          <button class="btn-primary btn-sm" :disabled="queueStarting" @click="startQueue">
            {{ queueStarting ? '入队中…' : '全账号入队执行' }}
          </button>
          <span v-if="taskRunning" class="wb-count">进度 {{ taskProgressText }}</span>
          <span v-if="selectedTaskCodes.length" class="wb-count">已选 {{ selectedTaskCodes.length }} 项</span>
        </div>

        <!-- 全账号扫描结果 -->
        <div v-if="taskScanResult.length" class="wb-scan">
          <div class="wb-scan-title">
            全账号未完成任务扫描结果（待办合计 {{ taskPendingCount }} 项）
          </div>
          <div v-for="row in taskScanResult" :key="row.uid" class="wb-scan-row">
            <span class="wb-scan-name">{{ row.nickname || (row.uid || '').slice(0, 12) }}</span>
            <span v-if="row.error" class="wb-scan-error">{{ row.error }}</span>
            <span v-else class="wb-scan-count">未完成 {{ (row.pending || []).length }} 项</span>
            <span v-if="!row.error && (row.pending || []).length" class="wb-scan-detail">
              {{ row.pending.map(p => p.task_code).join('、') }}
            </span>
          </div>
        </div>

        <!-- 执行队列状态（3 秒轮询，执行中自动刷新） -->
        <div v-if="queueItems.length" class="wb-scan">
          <div class="wb-scan-title">
            执行队列（{{ queueRunning ? '执行中' : '已结束' }}，共 {{ queueItems.length }} 项）
          </div>
          <div class="table-wrap">
            <table class="wb-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>任务</th>
                  <th>状态</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(it, i) in queueItems" :key="i" :class="{ 'row-done': it.status === 'done' }">
                  <td class="nowrap">{{ it.nickname || (it.uid || '').slice(0, 12) }}</td>
                  <td class="nowrap mono">{{ it.taskCode }}</td>
                  <td class="nowrap">{{ queueStateLabel(it.status) }}</td>
                  <td>{{ it.message || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="!accounts.length" class="wb-empty">还没有账号，请先在「账号池」添加。</div>
        <div v-else-if="!taskList.length" class="wb-empty">该账号暂无可显示任务</div>
        <div v-else class="table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>任务码</th>
                <th>标题</th>
                <th>进度</th>
                <th>奖励</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in taskList" :key="t.task_code" :class="{ 'row-done': t.claimed }">
                <td class="nowrap"><input type="checkbox" :value="t.task_code" v-model="selectedTaskCodes" /></td>
                <td class="nowrap mono">{{ t.task_code }}</td>
                <td>{{ t.title || t.description || t.task_desc || '-' }}</td>
                <td class="nowrap">{{ t.target > 0 ? `${t.current}/${t.target}` : '-' }}</td>
                <td class="nowrap">
                  <span v-if="t.credit > 0" class="reward">+{{ t.credit }}c</span>
                  <span v-if="t.energy > 0" class="reward">+{{ t.energy }}e</span>
                  <span v-if="t.reward_buddy" class="reward">+Buddy</span>
                  <span v-if="!t.credit && !t.energy && !t.reward_buddy">-</span>
                </td>
                <td class="nowrap">{{ taskStateLabel(t) }}</td>
                <td class="nowrap">
                  <button
                    v-if="canClaim(t)"
                    class="btn-ghost btn-sm"
                    :disabled="claimingCode === t.task_code"
                    @click="claimOne(t)"
                  >
                    {{ claimingCode === t.task_code ? '领取中…' : '领奖' }}
                  </button>
                  <span v-else>-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== Tab 5：定时任务 ==================== -->
    <div v-if="tab === 'scheduler'">
      <div class="card wb-card">
        <div class="wb-toolbar">
          <button class="btn-ghost btn-sm" @click="loadScheduler">刷新</button>
          <button class="btn-primary btn-sm" :disabled="schedSaving" @click="saveScheduler">
            {{ schedSaving ? '保存中…' : '保存排程' }}
          </button>
        </div>

        <div class="wb-note">时点填小时（0-23），多个用英文逗号分隔，例如 9,21；留空将回落为默认时点。</div>

        <div class="table-wrap">
          <table class="wb-table">
            <thead>
              <tr>
                <th>启用</th>
                <th>任务</th>
                <th>时点</th>
                <th>最近执行</th>
                <th>结果摘要</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in SCHED_TASKS" :key="t.key">
                <td><input type="checkbox" v-model="schedForm[t.enabledKey]" /></td>
                <td>
                  <div class="wb-task-name">{{ t.label }}</div>
                  <div class="wb-desc">{{ t.desc }}</div>
                </td>
                <td><input v-model="schedForm[t.hoursKey]" class="wb-hours-input" placeholder="如 9,21" /></td>
                <td class="nowrap">{{ schedState[t.key] && schedState[t.key].at ? formatTime(schedState[t.key].at) : '-' }}</td>
                <td>{{ (schedState[t.key] && schedState[t.key].summary) || '-' }}</td>
                <td class="nowrap">
                  <button class="btn-ghost btn-sm" :disabled="runningTask === t.key" @click="runSchedulerTask(t.key)">
                    {{ runningTask === t.key ? '执行中…' : '立即执行' }}
                  </button>
                </td>
              </tr>
              <tr>
                <td><span class="wb-desc">按间隔</span></td>
                <td>
                  <div class="wb-task-name">余额刷新</div>
                  <div class="wb-desc">后台按分钟间隔刷新全部账号积分</div>
                </td>
                <td><input v-model.number="schedForm.balanceRefreshMinutes" class="wb-hours-input" placeholder="分钟" /></td>
                <td class="nowrap">{{ schedState.balance && schedState.balance.at ? formatTime(schedState.balance.at) : '-' }}</td>
                <td>{{ (schedState.balance && schedState.balance.summary) || '-' }}</td>
                <td class="nowrap">
                  <button class="btn-ghost btn-sm" :disabled="runningTask === 'balance'" @click="runSchedulerTask('balance')">
                    {{ runningTask === 'balance' ? '执行中…' : '立即执行' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ==================== Tab 6：高级配置 ==================== -->
    <div v-if="tab === 'advanced'">
      <div class="card wb-card">
        <div class="section-title">账号池概览（只读）</div>
        <div class="wb-kv">
          <span class="wb-kv-label">账号总数</span>
          <span class="wb-kv-value">{{ counts.total }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">可用账号</span>
          <span class="wb-kv-value">{{ counts.healthy }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">冷却中</span>
          <span class="wb-kv-value">{{ counts.cooling }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">已禁用</span>
          <span class="wb-kv-value">{{ counts.disabled }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">在途占满</span>
          <span class="wb-kv-value">{{ counts.inFlightFull }}</span>
        </div>
      </div>

      <div class="card wb-card">
        <div class="section-title">定时任务开关与时点（只读汇总）</div>
        <div v-for="t in SCHED_TASKS" :key="t.key" class="wb-kv">
          <span class="wb-kv-label">{{ t.label }}</span>
          <span class="wb-kv-value">
            {{ schedState.enabled && schedState.enabled[t.key] ? '已启用' : '已停用' }} ·
            {{ formatHours(schedState.hours && schedState.hours[t.key]) }}
          </span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">余额刷新间隔</span>
          <span class="wb-kv-value">{{ schedState.balanceRefreshMinutes || 0 }} 分钟</span>
        </div>
      </div>

      <div class="card wb-card">
        <div class="section-title">提示词模式、改写档位、使用端身份与指纹脱敏</div>
        <div class="wb-note">
          提示词模式决定出站前如何处理客户端 system 消息（防上游内容审核误杀）；指纹脱敏对用户/assistant
          消息里的客户端指纹串做剥离。两者互不替代，建议同时开启。
        </div>
        <div class="config-row">
          <span class="config-label">提示词模式</span>
          <select v-model="cfgForm.promptMode" class="wb-select">
            <option value="custom">custom（用网关自有提示词替换客户端 system）</option>
            <option value="append">append（保留客户端 system，额外插入网关提示词）</option>
            <option value="passthrough">passthrough（透传，仅拦截时自动降级重试）</option>
          </select>
        </div>
        <div class="config-row">
          <span class="config-label">指纹脱敏</span>
          <label class="wb-auto">
            <input type="checkbox" v-model="cfgForm.sanitizeFingerprints" />
            开启（推荐）
          </label>
        </div>
        <div class="config-row">
          <span class="config-label">改写档位</span>
          <select v-model="cfgForm.rewriteMode" class="wb-select">
            <option value="compat">compat（默认：参数修正 + 工具配对清理 + 上下文压缩 + 标记修复）</option>
            <option value="native">native（原生透传：工具定义/历史/响应帧保真直通）</option>
          </select>
        </div>
        <div class="wb-note">
          compat 会对请求参数与工具历史做主动修补（tool_choice 归一、schema 修正、配对清理、上下文压缩），
          并对响应流做帧重建与标记修复；native 只保留上游硬性的协议步骤（强制流式、档位降级、角色/图片映射），
          工具调用被改写导致异常时可切此档保真直通（若上游对原始参数报错，需切回 compat）。
        </div>
        <div class="config-row">
          <span class="config-label">使用端身份</span>
          <select v-model="cfgForm.clientIdentity" class="wb-select">
            <option value="workbuddy">WorkBuddy 桌面端（默认：官网「使用端」显示 WorkBuddy）</option>
            <option value="codebuddy">CodeBuddy IDE（官网「使用端」显示 CodeBuddy）</option>
          </select>
        </div>
        <div class="wb-note">
          切换出站请求的 User-Agent 与用量归属头（X-IDE-*）。官网积分记录的「使用端」列按出站 UA
          服务端归因：WorkBuddy 桌面端 = 官方桌面端指纹，CodeBuddy IDE = 官方 IDE 指纹。
          保存后即时热生效（下一次请求开始）。UA 与版本细节可在下方「客户端指纹与版本覆盖」卡片中逐项覆盖。
        </div>
        <div class="config-row">
          <span class="config-label">设备令牌文件</span>
          <input
            v-model="cfgForm.deviceTokenFile"
            class="wb-input"
            type="text"
            placeholder="可选：桌面端 device token 文件路径"
          />
        </div>
        <div class="wb-note">
          出站 X-Device-Token 的来源：留空则不注入；填写后每 5 分钟读一次文件（≤1KB），读取失败自动降级为不注入。
        </div>
        <div class="wb-actions-row">
          <button class="btn-primary btn-sm" :disabled="cfgSaving" @click="saveConfig">
            {{ cfgSaving ? '保存中…' : '保存配置' }}
          </button>
          <span class="wb-note">保存后立即生效（热更新），并写入 server-config.json 持久化。</span>
        </div>
      </div>

      <div class="card wb-card">
        <div class="section-title">客户端指纹与版本覆盖（高级）</div>
        <div class="wb-note">
          出站请求的版本号、User-Agent、事件体指纹、语言与域名的逐项配置，输入框已填入当前生效值（未配置过时为官方默认值）。
          保存时全部写入 server-config.json 固化（不允许留空），上游升版或活动变更时在此直接调整，无需改代码。
        </div>

        <!-- ===== WorkBuddy 大类：主链路 / 桌面事件链 / Web / 小程序 ===== -->
        <div class="fp-major-title">WorkBuddy<span class="fp-major-sub">主链路 / 桌面事件链 / Web / 小程序</span></div>

        <div class="fp-group-title">版本号<span class="fp-risk mid">中风险</span></div>
        <div class="fp-grid">
          <div class="fp-item">
            <span class="fp-label">WorkBuddy 主链路版本</span>
            <input v-model="cfgForm.identity.clientVersion" class="wb-input" placeholder="默认 5.5.4" />
            <span class="fp-hint">对话 / token 刷新 UA 两段与 X-IDE-Version（使用端 = WorkBuddy 时）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">CLI 版本段</span>
            <input v-model="cfgForm.identity.cliVersion" class="wb-input" placeholder="默认 2.137.1" />
            <span class="fp-hint">WorkBuddy 主链路 UA 与桌面事件链 UA 的 CLI 段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">桌面事件链版本</span>
            <input v-model="cfgForm.identity.desktopVersion" class="wb-input" placeholder="默认 5.5.6" />
            <span class="fp-hint">桌面 UA 两段 + 成长任务事件体 ideVersion / extVersion</span>
          </div>
        </div>

        <div class="fp-group-title">请求头 UA<span class="fp-risk high">高风险</span>（上游风控与归因判据，非必要勿改）</div>
        <div class="fp-grid">
          <div class="fp-item">
            <span class="fp-label">WorkBuddy 主链路 UA（整串）</span>
            <input v-model="cfgForm.identity.workbuddyUA" class="wb-input" placeholder="默认 WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1" />
            <span class="fp-hint">对话 / token 刷新等主链路请求的完整 UA 串</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">billing 域 UA（WorkBuddy）</span>
            <input v-model="cfgForm.identity.workbuddyBillingUA" class="wb-input" placeholder="默认 WorkBuddy/5.5.4" />
            <span class="fp-hint">签到 / 余额 / 礼包请求（使用端 = WorkBuddy 时）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">桌面事件链 UA（整串）</span>
            <input v-model="cfgForm.identity.desktopUA" class="wb-input" placeholder="默认 WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1" />
            <span class="fp-hint">成长任务上报 / 专家市场 / 专家对话链路</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">Web 事件体浏览器 UA</span>
            <input v-model="cfgForm.identity.webUA" class="wb-input" placeholder="默认 Chrome/152 Windows 桌面版" />
            <span class="fp-hint">web 域上报事件体的 userAgent 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">mp 小程序版本</span>
            <input v-model="cfgForm.identity.mpVersion" class="wb-input" placeholder="默认 2.4.0" />
            <span class="fp-hint">小程序上报头 X-Client-Version + mp 事件体 ideVersion / extVersion</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">mp 事件扩展版本</span>
            <input v-model="cfgForm.identity.mpExtVersion" class="wb-input" placeholder="默认 2.2.8" />
            <span class="fp-hint">mp 专家召唤 / 灵感事件 extVersion</span>
          </div>
        </div>

        <!-- ===== CodeBuddy 大类：IDE 主链路 / 模型探测 / 登录流程 ===== -->
        <div class="fp-major-title">CodeBuddy<span class="fp-major-sub">IDE 主链路 / 模型探测 / 登录流程</span></div>

        <div class="fp-group-title">版本号<span class="fp-risk mid">中风险</span></div>
        <div class="fp-grid">
          <div class="fp-item">
            <span class="fp-label">CodeBuddy 主链路版本</span>
            <input v-model="cfgForm.identity.ideVersion" class="wb-input" placeholder="默认 4.12.0" />
            <span class="fp-hint">对话 / 刷新 UA 两段与 X-IDE-Version（使用端 = CodeBuddy 时）</span>
          </div>
        </div>

        <div class="fp-group-title">请求头 UA<span class="fp-risk high">高风险</span>（上游风控与归因判据，非必要勿改）</div>
        <div class="fp-grid">
          <div class="fp-item">
            <span class="fp-label">CodeBuddy 主链路 UA（整串）</span>
            <input v-model="cfgForm.identity.codebuddyUA" class="wb-input" placeholder="默认 CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0" />
            <span class="fp-hint">使用端 = CodeBuddy 时的主链路完整 UA 串</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">billing 域 UA（CodeBuddy）</span>
            <input v-model="cfgForm.identity.codebuddyBillingUA" class="wb-input" placeholder="默认 CodeBuddy/4.12.0" />
            <span class="fp-hint">签到 / 余额 / 礼包请求（使用端 = CodeBuddy 时）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">/v3/config 探测 UA（整串）</span>
            <input v-model="cfgForm.identity.v3ConfigUA" class="wb-input" placeholder="默认 CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0" />
            <span class="fp-hint">官方 IDE 模型目录探测接口（缺失版本号会 400 code=12403）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">OAuth 登录 UA（整串）</span>
            <input v-model="cfgForm.identity.oauthUA" class="wb-input" placeholder="默认 CLI/2.63.2 CodeBuddy/2.63.2" />
            <span class="fp-hint">设备码登录授权流程（独立版本体系，不随版本号拼接）</span>
          </div>
        </div>

        <div class="fp-group-title">事件体指纹<span class="fp-risk mid">中风险</span>（成长任务判据字段，改错 = 任务不计分）</div>
        <div class="fp-grid">
          <div class="fp-item">
            <span class="fp-label">桌面 commit</span>
            <input v-model="cfgForm.identity.desktopCommit" class="wb-input" placeholder="默认 5f9692…（git hash）" />
            <span class="fp-hint">桌面事件体 commit 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">桌面 releaseDate</span>
            <input v-model="cfgForm.identity.desktopReleaseDate" class="wb-input" placeholder="默认 1789036585355" />
            <span class="fp-hint">桌面事件体 releaseDate（数字时间戳，仅数字）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">桌面 osVersion</span>
            <input v-model="cfgForm.identity.desktopOsVersion" class="wb-input" placeholder="默认 10.0.26220" />
            <span class="fp-hint">桌面事件体操作系统版本</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">桌面 cpuCores</span>
            <input v-model="cfgForm.identity.desktopCpuCores" class="wb-input" placeholder="默认 20" />
            <span class="fp-hint">桌面事件体 CPU 核数（仅数字）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">桌面 memorySize</span>
            <input v-model="cfgForm.identity.desktopMemorySize" class="wb-input" placeholder="默认 24" />
            <span class="fp-hint">桌面事件体内存（GB，仅数字）</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">Web os</span>
            <input v-model="cfgForm.identity.webOs" class="wb-input" placeholder="默认 Win32" />
            <span class="fp-hint">web 事件体 os 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">Web osVersion</span>
            <input v-model="cfgForm.identity.webOsVersion" class="wb-input" placeholder="默认 10.0" />
            <span class="fp-hint">web 事件体 osVersion 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">mp os</span>
            <input v-model="cfgForm.identity.mpOs" class="wb-input" placeholder="默认 windows" />
            <span class="fp-hint">mp 事件体 os 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">mp osVersion</span>
            <input v-model="cfgForm.identity.mpOsVersion" class="wb-input" placeholder="默认 11" />
            <span class="fp-hint">mp 事件体 osVersion 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">mp arch</span>
            <input v-model="cfgForm.identity.mpArch" class="wb-input" placeholder="默认 x64" />
            <span class="fp-hint">mp 事件体 arch 字段</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">mp machineId</span>
            <input v-model="cfgForm.identity.mpMachineId" class="wb-input" placeholder="默认 0655736a-…（固定 UUID）" />
            <span class="fp-hint">mp 事件体设备 ID（固定值，跨事件一致）</span>
          </div>
        </div>

        <div class="fp-group-title">语言与域名<span class="fp-risk high">高风险（域名）</span><span class="fp-risk safe">安全（语言）</span></div>
        <div class="fp-grid">
          <div class="fp-item">
            <span class="fp-label">Accept-Language</span>
            <input v-model="cfgForm.identity.acceptLanguage" class="wb-input" placeholder="默认 zh-CN" />
            <span class="fp-hint">所有出站请求的语言头</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">聊天域 chatBase</span>
            <input v-model="cfgForm.identity.chatBase" class="wb-input" placeholder="默认 https://copilot.tencent.com" />
            <span class="fp-hint">对话 / 桌面事件链 / growth 任务判据域名</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">计费域 billingBase</span>
            <input v-model="cfgForm.identity.billingBase" class="wb-input" placeholder="默认 https://www.codebuddy.cn" />
            <span class="fp-hint">签到 / 余额 / CLI 活跃上报 / mp 上报域名</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">官网域 webBase</span>
            <input v-model="cfgForm.identity.webBase" class="wb-input" placeholder="默认 https://www.workbuddy.cn" />
            <span class="fp-hint">web 域上报 / 领奖域名</span>
          </div>
          <div class="fp-item">
            <span class="fp-label">Origin / Referer 基础域</span>
            <input v-model="cfgForm.identity.originReferer" class="wb-input" placeholder="默认 https://www.codebuddy.cn" />
            <span class="fp-hint">出站 Origin/Referer 的基础域（须带 http:// 或 https://）</span>
          </div>
        </div>
        <div class="wb-note" style="margin-top: 8px">
          域名字段须以 http:// 或 https:// 开头；长度超过 256 字符或含换行/控制字符的输入会被后端拒绝（防请求头注入）。
        </div>

        <div class="fp-group-title">保持内置（非配置项）</div>
        <div class="wb-note">
          成长活动判据 ID（企鹅教师助手 / 和平精英主题 / 校园日 / 旅行点位 / 灵感案例与专家 ID 等）——
          上游更换活动时需随版本更新代码；机器指纹派生盐（wb2a:）——修改会导致全部账号设备 ID 重置，存在风控风险，故不开放。
        </div>

        <div class="wb-actions-row">
          <button class="btn-primary btn-sm" :disabled="cfgSaving" @click="saveConfig">
            {{ cfgSaving ? '保存中…' : '保存配置' }}
          </button>
          <span class="wb-note">与上方配置一并提交，保存后热更新并持久化。</span>
        </div>
      </div>

      <div class="card wb-card">
        <div class="section-title">账号池参数（只读）</div>
        <div class="wb-kv">
          <span class="wb-kv-label">软冷却基数</span>
          <span class="wb-kv-value">{{ formatDuration(cfg.pool && cfg.pool.softRateMs) }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">软冷却封顶</span>
          <span class="wb-kv-value">{{ formatDuration(cfg.pool && cfg.pool.softRateMaxMs) }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">熔断阈值 / 基础退避</span>
          <span class="wb-kv-value">{{ (cfg.pool && cfg.pool.breakerThreshold) || '-' }} 次 / {{ formatDuration(cfg.pool && cfg.pool.breakerCooldownMs) }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">单账号在途上限</span>
          <span class="wb-kv-value">{{ (cfg.pool && cfg.pool.maxInFlight) ?? '-' }}</span>
        </div>
        <div class="wb-kv">
          <span class="wb-kv-label">防惊群最短重选间隔</span>
          <span class="wb-kv-value">{{ formatDuration(cfg.pool && cfg.pool.minPickGapMs) }}</span>
        </div>
        <div class="wb-note">池参数如需调整，请编辑 server-config.json 的 workbuddy.pool 段后重启服务。</div>
      </div>
    </div>

    <!-- ==================== Tab 7：运行日志 ==================== -->
    <div v-if="tab === 'logs'">
      <div class="card wb-card">
        <div class="filter-bar">
          <select v-model="logChannel" class="wb-select" @change="loadLogs">
            <option v-for="c in LOG_CHANNELS" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
          <input v-model="logKeyword" class="wb-input" type="text" placeholder="搜索消息关键字" @keyup.enter="loadLogs" />
          <button class="btn-ghost btn-sm" @click="loadLogs">{{ logLoading ? '加载中…' : '刷新' }}</button>
          <label class="wb-auto">
            <input type="checkbox" v-model="logAuto" @change="toggleLogAuto" />
            自动刷新（3 秒）
          </label>
        </div>

        <div class="wb-note">只记录关键事件（对话结果 / 任务执行 / 系统告警），不含 token 明文。</div>

        <div v-if="!logs.length" class="wb-empty">暂无日志记录</div>
        <div v-else class="wb-logs">
          <div v-for="(log, i) in logs" :key="i" class="wb-log-row" :class="{ 'is-warn': log.level === 'warn' }">
            <span class="wb-log-time">{{ formatClock(log.ts) }}</span>
            <span class="wb-log-channel" :class="channelClass(log.channel)">{{ channelLabel(log.channel) }}</span>
            <span class="wb-log-level" :class="{ 'is-warn': log.level === 'warn' }">{{ levelLabel(log.level) }}</span>
            <span class="wb-log-msg">{{ log.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { showToast } from '../composables/useToast.js'
import {
  wbAccounts,
  wbOauthStart,
  wbOauthPoll,
  wbRemoveAccount,
  wbCheckin,
  wbRefreshBalance,
  wbKeepalive,
  wbRevive,
  wbDisable,
  wbEnable,
  wbRefreshAllBalances,
  wbModels,
  wbEnabledModels,
  wbSaveEnabledModels,
  wbTaskList,
  wbTaskRun,
  wbTaskProgress,
  wbTaskScanAll,
  wbTaskAccept,
  wbTaskClaim,
  wbTaskRunQueue,
  wbTaskQueue,
  wbCreditPackages,
  wbUsage,
  wbUsageSave,
  wbScheduler,
  wbSchedulerRun,
  wbSchedulerUpdate,
  wbLogs,
  wbStatus,
  wbConfig,
  wbUpdateConfig
} from '../api.js'

// ==================== 常量 ====================

// 顶部 Tab 定义（key 用于切换，label 为显示文案）
const TABS = [
  { key: 'accounts', label: '账号池' },
  { key: 'credits', label: '积分构成' },
  { key: 'usage', label: '用量' },
  { key: 'models', label: '模型和档位' },
  { key: 'tasks', label: '成长任务' },
  { key: 'scheduler', label: '定时任务' },
  { key: 'advanced', label: '高级配置' },
  { key: 'logs', label: '运行日志' }
]

// 定时任务分区元数据：key 为接口任务名，hoursKey / enabledKey 对应排程字段
const SCHED_TASKS = [
  { key: 'checkin', label: '签到', hoursKey: 'checkinHours', enabledKey: 'checkinEnabled', desc: '每日签到并执行连登管家' },
  { key: 'travel', label: '旅行', hoursKey: 'travelHours', enabledKey: 'travelEnabled', desc: '猫猫旅行巡检（派出 / 领奖 / 领养）' },
  { key: 'activity', label: '活跃', hoursKey: 'activityHours', enabledKey: 'activityEnabled', desc: '对话活跃上报，维持连登' },
  { key: 'keepalive', label: '保活', hoursKey: 'keepaliveHours', enabledKey: 'keepaliveEnabled', desc: '刷新 token，防止会话过期' },
  { key: 'blackcat', label: '夜猫子', hoursKey: 'blackcatHours', enabledKey: 'blackcatEnabled', desc: '23:00-08:00 夜间对话补足' },
  { key: 'growth', label: '成长任务', hoursKey: 'growthHours', enabledKey: 'growthEnabled', desc: '到点自动扫描全账号待办并入队执行（Sequential 族每日解锁一环）' }
]

// 运行日志频道筛选项
const LOG_CHANNELS = [
  { value: '', label: '全部频道' },
  { value: 'chat', label: '对话' },
  { value: 'task', label: '任务' },
  { value: 'system', label: '系统' }
]

// ==================== 页面基础状态 ====================

// 当前激活的 Tab
const tab = ref('accounts')
// 账号列表
const accounts = ref([])
// 汇总统计（总计 / 可用 / 冷却 / 禁用 / 在途占满）
const counts = ref({ total: 0, healthy: 0, cooling: 0, disabled: 0, inFlightFull: 0 })
// 账号列表加载中标记
const loading = ref(false)
// 批量操作标记：'' 空闲 / 'checkin' 全部签到 / 'balance' 刷新余额
const busyAll = ref('')
// 单号操作进行中的 uid（避免重复点击）
const busyUid = ref('')

// ==================== OAuth 登录状态 ====================

// OAuth 流程状态（null 表示未在登录中）
const oauth = ref(null)
// OAuth 轮询定时器句柄
let pollTimer = null
// ==================== 积分构成状态 ====================

// 积分页当前选中的账号 uid
const creditUid = ref('')
// 积分批次列表
const creditPackages = ref([])
// 积分批次加载中标记
const creditLoading = ref(false)

// ==================== 用量 / 积分消耗状态 ====================

// 用量窗口选项（value 为小时数或字符串窗口：today = 今天 0 点起 / yesterday = 昨天整段；0 = 全部历史）
const USAGE_WINDOWS = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 72, label: '72 小时' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
  { value: 0, label: '全部' }
]
// 当前选中的用量窗口（小时数或字符串：today = 今天 0 点起 / yesterday = 昨天整段；默认今天）
const usageHours = ref('today')
// 用量快照数据（totals / 各维度 / 文件占用）
const usageData = ref(null)
// 用量加载中标记
const usageLoading = ref(false)
// 用量落盘中标记
const usageSaving = ref(false)

// 当前用量窗口的中文标注（两张维度表标题用，如「今天」「近 72 小时」「全部历史」）
const usageWindowLabel = computed(() => {
  if (usageHours.value === 0) return '全部历史'
  if (usageHours.value === 'today') return '今天'
  if (usageHours.value === 'yesterday') return '昨天'
  const hit = USAGE_WINDOWS.find(opt => opt.value === usageHours.value)
  return hit ? `近 ${hit.label}` : `${usageHours.value} 小时`
})

// 模型维度表：合并 by_model 与 credit_by_model 的倍率
const usageModelRows = computed(() => {
  const data = usageData.value
  if (!data || !Array.isArray(data.by_model)) return []
  const rateByModel = new Map()
  for (const cm of data.credit_by_model || []) {
    if (!rateByModel.has(cm.key)) rateByModel.set(cm.key, cm.rate || '')
  }
  return data.by_model.map(row => ({ ...row, rate: rateByModel.get(row.key) || '' }))
})

// ==================== 模型和档位状态 ====================

// 上游模型列表
const upstreamModels = ref([])
// 已勾选的模型 id 列表
const enabledModelIds = ref([])
// 模型拉取中标记
const modelsLoading = ref(false)
// 模型保存中标记
const modelsSaving = ref(false)

// ==================== 成长任务状态 ====================

// 任务页当前选中的账号 uid
const taskUid = ref('')
// 当前账号的任务列表
const taskList = ref([])
// 一键完成执行中标记
const taskRunning = ref(false)
// 一键完成的进度文案
const taskProgressText = ref('')
// 任务进度轮询句柄
let taskTimer = null
// 全账号扫描结果
const taskScanResult = ref([])
// 全账号扫描进行中标记
const taskScanning = ref(false)
// 全账号待办任务计数（扫描汇总）
const taskPendingCount = ref(0)
// 表格中勾选的任务码（用于「接受任务」）
const selectedTaskCodes = ref([])
// 接受任务进行中标记
const taskAccepting = ref(false)
// 正在单独领奖的任务码（避免重复点击）
const claimingCode = ref('')
// 入队执行进行中标记
const queueStarting = ref(false)
// 队列条目（uid/任务/状态/结果）
const queueItems = ref([])
// 队列是否在执行中
const queueRunning = ref(false)
// 队列状态轮询句柄
let queueTimer = null

// ==================== 定时任务状态 ====================

// 排程原始状态（含各类任务最近执行时间与摘要）
const schedState = ref({})
// 排程可编辑表单（开关 / 时点 / 余额刷新间隔）
const schedForm = ref({
  checkinEnabled: true,
  checkinHours: '',
  travelEnabled: true,
  travelHours: '',
  activityEnabled: true,
  activityHours: '',
  keepaliveEnabled: true,
  keepaliveHours: '',
  blackcatEnabled: true,
  blackcatHours: '',
  growthEnabled: true,
  growthHours: '',
  balanceRefreshMinutes: 0
})
// 排程保存中标记
const schedSaving = ref(false)
// 正在手动执行的任务名（避免重复点击）
const runningTask = ref('')

// ==================== 高级配置状态 ====================

// 运行时配置快照（池参数只读展示）
const cfg = ref({ pool: {} })
// 指纹与版本覆盖表单的空白模板（键名与后端 identity.js 白名单一一对应；空串 = 使用官方默认值）
function emptyIdentity() {
  return {
    // 版本号
    clientVersion: '', ideVersion: '', cliVersion: '', desktopVersion: '',
    // WorkBuddy / CodeBuddy 请求头 UA 与 mp 版本
    workbuddyUA: '', codebuddyUA: '', workbuddyBillingUA: '', codebuddyBillingUA: '',
    desktopUA: '', v3ConfigUA: '', oauthUA: '', webUA: '', mpVersion: '', mpExtVersion: '',
    // 事件体指纹
    desktopCommit: '', desktopReleaseDate: '', desktopOsVersion: '', desktopCpuCores: '', desktopMemorySize: '',
    webOs: '', webOsVersion: '',
    mpOs: '', mpOsVersion: '', mpArch: '', mpMachineId: '',
    // 语言与域名
    acceptLanguage: '', chatBase: '', billingBase: '', webBase: '', originReferer: ''
  }
}

// 指纹与版本覆盖的字段中文名（保存前空值校验提示用；键序与表单展示顺序一致）
const IDENTITY_LABELS = {
  // WorkBuddy 大类（主链路 / 桌面事件链 / Web / 小程序）
  clientVersion: 'WorkBuddy 主链路版本',
  cliVersion: 'CLI 版本段',
  desktopVersion: '桌面事件链版本',
  workbuddyUA: 'WorkBuddy 主链路 UA',
  workbuddyBillingUA: 'billing 域 UA（WorkBuddy）',
  desktopUA: '桌面事件链 UA',
  webUA: 'Web 事件体浏览器 UA',
  mpVersion: 'mp 小程序版本',
  mpExtVersion: 'mp 事件扩展版本',
  // CodeBuddy 大类（IDE 主链路 / 模型探测 / 登录流程）
  ideVersion: 'CodeBuddy 主链路版本',
  codebuddyUA: 'CodeBuddy 主链路 UA',
  codebuddyBillingUA: 'billing 域 UA（CodeBuddy）',
  v3ConfigUA: '/v3/config 探测 UA',
  oauthUA: 'OAuth 登录 UA',
  desktopCommit: '桌面 commit',
  desktopReleaseDate: '桌面 releaseDate',
  desktopOsVersion: '桌面 osVersion',
  desktopCpuCores: '桌面 cpuCores',
  desktopMemorySize: '桌面 memorySize',
  webOs: 'Web os',
  webOsVersion: 'Web osVersion',
  mpOs: 'mp os',
  mpOsVersion: 'mp osVersion',
  mpArch: 'mp arch',
  mpMachineId: 'mp machineId',
  acceptLanguage: 'Accept-Language',
  chatBase: '聊天域 chatBase',
  billingBase: '计费域 billingBase',
  webBase: '官网域 webBase',
  originReferer: 'Origin / Referer 基础域'
}

// 可编辑的运行时配置表单（提示词模式 / 改写档位 / 使用端身份 / 指纹脱敏 / 设备令牌 / 指纹与版本覆盖）
const cfgForm = ref({
  promptMode: 'custom',
  rewriteMode: 'compat',
  clientIdentity: 'workbuddy',
  sanitizeFingerprints: true,
  deviceTokenFile: '',
  identity: emptyIdentity()
})
// 配置保存中标记
const cfgSaving = ref(false)

// ==================== 运行日志状态 ====================

// 日志列表
const logs = ref([])
// 日志频道筛选值（'' / chat / task / system）
const logChannel = ref('')
// 日志关键字筛选值
const logKeyword = ref('')
// 日志加载中标记
const logLoading = ref(false)
// 是否开启自动刷新
const logAuto = ref(false)
// 日志自动刷新定时器句柄
let logTimer = null

// ==================== 生命周期 ====================

onMounted(async () => {
  await reload()
  // 首屏默认预取定时任务状态，供「高级配置」只读汇总使用
  await loadScheduler()
})

onUnmounted(() => {
  stopOauthPolling()
  stopTaskPolling()
  stopQueuePolling()
  stopLogAuto()
})

// Tab 切换时按需加载该分区数据
watch(tab, key => {
  if (key === 'credits') loadCredits()
  else if (key === 'usage') loadUsage()
  else if (key === 'models' && !upstreamModels.value.length) loadModels(false)
  else if (key === 'tasks') {
    if (taskUid.value) loadTasks()
    refreshQueue()
  } else if (key === 'scheduler') loadScheduler()
  else if (key === 'logs') loadLogs()
  else if (key === 'advanced') loadAdvanced()
})

// ==================== 账号池 ====================

// 加载账号列表与汇总统计，并维护各分区默认选中账号
async function reload() {
  loading.value = true
  try {
    const data = await wbAccounts()
    accounts.value = data.accounts || []
    counts.value = data.counts || { total: 0, healthy: 0, cooling: 0, disabled: 0, inFlightFull: 0 }
    // 选中的账号被移除后回落为该列表第一个
    if (!accounts.value.some(a => a.uid === creditUid.value)) creditUid.value = accounts.value[0] ? accounts.value[0].uid : ''
    if (!accounts.value.some(a => a.uid === taskUid.value)) taskUid.value = accounts.value[0] ? accounts.value[0].uid : ''
  } catch (err) {
    showToast('账号列表加载失败: ' + errText(err), 'error')
  } finally {
    loading.value = false
  }
}

// 页面头部刷新：刷新账号列表并重载当前分区数据
async function refreshPage() {
  await reload()
  if (tab.value === 'credits') await loadCredits()
  else if (tab.value === 'usage') await loadUsage()
  else if (tab.value === 'models') await loadModels(false)
  else if (tab.value === 'tasks') await loadTasks()
  else if (tab.value === 'scheduler') await loadScheduler()
  else if (tab.value === 'logs') await loadLogs()
  else if (tab.value === 'advanced') await loadAdvanced()
}

// 发起 OAuth 设备授权并开始轮询
async function startAddAccount() {
  try {
    const data = await wbOauthStart()
    oauth.value = { state: data.state, url: data.url, message: '' }
    try {
      await navigator.clipboard.writeText(data.url)
      oauth.value.message = '授权链接已复制，请粘贴到浏览器打开'
    } catch {
      /* 剪贴板不可用则忽略 */
    }
    startOauthPolling()
  } catch (err) {
    showToast('发起登录失败: ' + errText(err), 'error')
  }
}

// 每 3 秒轮询一次登录结果
function startOauthPolling() {
  stopOauthPolling()
  pollTimer = setInterval(async () => {
    if (!oauth.value) return
    try {
      const data = await wbOauthPoll(oauth.value.state)
      if (data.done) {
        stopOauthPolling()
        oauth.value = null
        showToast(`账号 ${data.nickname || data.uid} 添加成功，积分 ${data.credits >= 0 ? data.credits : '未知'}`)
        await reload()
      } else if (data.message) {
        oauth.value.message = data.message
      }
    } catch {
      /* 单次轮询失败继续 */
    }
  }, 3000)
}

// 停止 OAuth 轮询
function stopOauthPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 取消登录流程
function cancelOauth() {
  stopOauthPolling()
  oauth.value = null
}

// 在系统默认浏览器打开授权链接
function openAuthUrl() {
  if (oauth.value && oauth.value.url) window.open(oauth.value.url, '_blank')
}

// 复制授权链接到剪贴板
async function copyAuthUrl() {
  if (!oauth.value || !oauth.value.url) return
  try {
    await navigator.clipboard.writeText(oauth.value.url)
    showToast('授权链接已复制')
  } catch {
    showToast('复制失败，请手动选中复制', 'error')
  }
}

// 单号签到
async function doCheckin(acct) {
  busyUid.value = acct.uid
  try {
    const res = await wbCheckin(acct.uid)
    showToast(`${acct.nickname || acct.uid.slice(0, 8)}: ${res.message || (res.ok ? '签到成功' : '签到失败')}`, res.ok ? 'success' : 'error')
    await reload()
  } catch (err) {
    showToast('签到失败: ' + errText(err), 'error')
  } finally {
    busyUid.value = ''
  }
}

// 单号余额刷新
async function doBalance(acct) {
  busyUid.value = acct.uid
  try {
    const res = await wbRefreshBalance(acct.uid)
    showToast(res.ok ? `积分 ${res.credits}（快过期 ${res.expiring}）` : `余额刷新失败: ${res.message || ''}`, res.ok ? 'success' : 'error')
    await reload()
  } catch (err) {
    showToast('余额刷新失败: ' + errText(err), 'error')
  } finally {
    busyUid.value = ''
  }
}

// 单号 token 保活
async function doKeepalive(acct) {
  busyUid.value = acct.uid
  try {
    const res = await wbKeepalive(acct.uid)
    showToast(res.ok ? 'token 保活成功' : `保活失败: ${res.error || ''}`, res.ok ? 'success' : 'error')
  } catch (err) {
    showToast('保活失败: ' + errText(err), 'error')
  } finally {
    busyUid.value = ''
  }
}

// 解冻账号（清除冷却 / 熔断 / 禁用状态）
async function doRevive(acct) {
  busyUid.value = acct.uid
  try {
    await wbRevive(acct.uid)
    showToast(`已解冻 ${acct.nickname || acct.uid.slice(0, 8)}`)
    await reload()
  } catch (err) {
    showToast('解冻失败: ' + errText(err), 'error')
  } finally {
    busyUid.value = ''
  }
}

// 移除账号（删除凭证并出池）
async function doRemove(acct) {
  const label = acct.nickname || acct.uid
  if (!window.confirm(`确定移除账号「${label}」吗？\n凭证文件会被删除，该账号将不再参与请求转发。`)) return
  try {
    await wbRemoveAccount(acct.uid)
    showToast(`已移除「${label}」`)
    await reload()
  } catch (err) {
    showToast('移除失败: ' + errText(err), 'error')
  }
}

// 跳转到积分 Tab 并查看该账号的积分构成
function gotoCredits(acct) {
  creditUid.value = acct.uid
  tab.value = 'credits'
}

// 全部签到：复用调度器的签到任务（全账号 800ms 限速签到 + 连登管家）
async function checkinAll() {
  busyAll.value = 'checkin'
  try {
    const res = await wbSchedulerRun('checkin')
    showToast(`全部签到完成：${(res && res.summary) || '已执行'}`)
    await reload()
  } catch (err) {
    showToast('全部签到失败: ' + errText(err), 'error', 5000)
  } finally {
    busyAll.value = ''
  }
}

// 全量余额刷新
async function refreshBalanceAll() {
  busyAll.value = 'balance'
  try {
    const res = await wbRefreshAllBalances()
    const list = res.results || []
    const okCount = list.filter(r => r.ok).length
    showToast(`余额刷新完成：成功 ${okCount}/${list.length}`)
    await reload()
  } catch (err) {
    showToast('刷新失败: ' + errText(err), 'error')
  } finally {
    busyAll.value = ''
  }
}

// 账号状态标签文案
function stateLabel(acct) {
  if (acct.disabled) return '已禁用'
  if (acct.cooling) {
    if (acct.coolKind === 'hard_credit') return '积分冷却'
    if (acct.coolKind === 'breaker') return '熔断'
    return '限流冷却'
  }
  return '可用'
}

// 账号状态标签样式类
function stateClass(acct) {
  if (acct.disabled) return 'is-bad'
  if (acct.cooling) return 'is-warn'
  return 'is-ok'
}

// 冷却类型文案（详情弹窗）
function coolKindLabel(kind) {
  if (kind === 'hard_credit') return '余额耗尽（至次日 04:00）'
  if (kind === 'breaker') return '熔断'
  if (kind === 'soft_rate') return '软限流'
  return kind || '-'
}

// 账号运行态动作文案（保活中 / 签到中 / 刷余额中）
function runningLabel(action) {
  const map = { keepalive: '保活中…', checkin: '签到中…', balance: '刷余额中…' }
  return map[action] || (action ? `${action}…` : '')
}

// 千分位数字（token 展示）
function fmtNum(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0'
}

// ==================== 账号详情弹窗 ====================

// 详情弹窗当前账号 uid（与列表同一份数据，随刷新实时更新）
const detailUid = ref('')
// 详情弹窗账号对象（找不到即关闭）
const detailAcct = computed(() => accounts.value.find(a => a.uid === detailUid.value) || null)

// 打开详情弹窗
function openDetail(acct) {
  detailUid.value = acct.uid
}

// 关闭详情弹窗
function closeDetail() {
  detailUid.value = ''
}

// 人工禁用账号（二次确认；保留凭证，仅退出轮转）
async function doDisable(acct) {
  const name = acct.nickname || `${acct.uid.slice(0, 8)}…`
  if (!window.confirm(`确定禁用账号「${name}」吗？\n禁用后该账号不参与请求轮转，可随时恢复。`)) return
  try {
    const res = await wbDisable(acct.uid, '人工禁用')
    showToast(res.ok ? '账号已禁用' : res.message || '禁用失败', res.ok ? 'success' : 'error')
    await reload()
  } catch (err) {
    showToast('禁用失败: ' + errText(err), 'error')
  }
}

// 人工恢复启用（只清禁用，不动冷却/熔断）
async function doEnable(acct) {
  try {
    const res = await wbEnable(acct.uid)
    showToast(res.ok ? '账号已恢复启用' : res.message || '恢复失败', res.ok ? 'success' : 'error')
    await reload()
  } catch (err) {
    showToast('恢复失败: ' + errText(err), 'error')
  }
}

// ==================== 积分构成 ====================

// 加载当前选中账号的积分批次明细
async function loadCredits() {
  if (!creditUid.value) {
    creditPackages.value = []
    return
  }
  creditLoading.value = true
  try {
    const data = await wbCreditPackages(creditUid.value)
    if (data.ok === false) throw new Error(data.message || '积分构成查询失败')
    creditPackages.value = data.packages || []
  } catch (err) {
    creditPackages.value = []
    showToast('积分构成加载失败: ' + errText(err), 'error')
  } finally {
    creditLoading.value = false
  }
}

// ==================== 用量 / 积分消耗 ====================

// 加载当前窗口的用量快照
async function loadUsage() {
  usageLoading.value = true
  try {
    const data = await wbUsage(usageHours.value)
    usageData.value = data && data.ok === false ? null : data
  } catch (err) {
    usageData.value = null
    showToast('用量加载失败: ' + errText(err), 'error')
  } finally {
    usageLoading.value = false
  }
}

// 立即落盘用量数据
async function saveUsage() {
  usageSaving.value = true
  try {
    await wbUsageSave()
    showToast('用量数据已落盘')
  } catch (err) {
    showToast('落盘失败: ' + errText(err), 'error')
  } finally {
    usageSaving.value = false
  }
}

// 账号显示名：优先昵称，否则 uid 前 12 位
function accountLabel(uid) {
  const hit = accounts.value.find(a => a.uid === uid)
  if (hit && hit.nickname) return hit.nickname
  return uid ? uid.slice(0, 12) : '-'
}

// ==================== 模型和档位 ====================

// 拉取上游模型列表与启用清单；force 为 true 时强制刷新上游缓存
async function loadModels(force) {
  modelsLoading.value = true
  try {
    const data = await wbModels(!!force)
    upstreamModels.value = data.models || []
    if (!upstreamModels.value.length) {
      showToast('上游未返回可用模型', 'error')
      return
    }
    const enabled = await wbEnabledModels()
    const ids = (enabled.models || []).map(m => m.id)
    // 未配置启用清单时默认全选
    enabledModelIds.value = ids.length ? ids : upstreamModels.value.map(m => m.id)
  } catch (err) {
    showToast('模型列表拉取失败: ' + errText(err), 'error', 4000)
  } finally {
    modelsLoading.value = false
  }
}

// 切换单个模型的勾选状态
function toggleModel(id) {
  const next = enabledModelIds.value.slice()
  const idx = next.indexOf(id)
  if (idx >= 0) next.splice(idx, 1)
  else next.push(id)
  enabledModelIds.value = next
}

// 保存启用模型清单（后端自动同步到所有 WorkBuddy Provider）
async function saveEnabledModels() {
  const picked = upstreamModels.value.filter(m => enabledModelIds.value.includes(m.id))
  if (!picked.length) {
    showToast('请至少勾选一个模型', 'error')
    return
  }
  modelsSaving.value = true
  try {
    const payload = picked.map(m => ({
      id: m.id,
      displayName: m.name || m.id,
      maxContext: m.maxContext,
      maxOutput: m.maxOutput
    }))
    const res = await wbSaveEnabledModels(payload)
    enabledModelIds.value = (res.models || []).map(m => m.id)
    showToast(`已保存 ${enabledModelIds.value.length} 个启用模型，已同步写入 ${res.synced || 0} 个 Provider`)
  } catch (err) {
    showToast('保存失败: ' + errText(err), 'error')
  } finally {
    modelsSaving.value = false
  }
}

// ==================== 成长任务 ====================

// 切换账号时重载任务并清空勾选
function onTaskAccountChange() {
  selectedTaskCodes.value = []
  loadTasks()
}

// 加载当前选中账号的任务列表
async function loadTasks() {
  if (!taskUid.value) {
    taskList.value = []
    return
  }
  try {
    const data = await wbTaskList(taskUid.value)
    taskList.value = data.tasks || []
    // 剔除已不在列表中的勾选项
    const codes = new Set(taskList.value.map(t => t.task_code))
    selectedTaskCodes.value = selectedTaskCodes.value.filter(c => codes.has(c))
  } catch (err) {
    taskList.value = []
    showToast('任务列表加载失败: ' + errText(err), 'error')
  }
}

// 一键完成全部可自动化任务（执行期间每 2 秒轮询进度）
async function runAllTasks() {
  if (!taskUid.value) return
  taskRunning.value = true
  taskProgressText.value = '准备中…'
  startTaskPolling()
  try {
    const items = await wbTaskRun(taskUid.value, '')
    const done = (items || []).filter(i => i.status === 'done').length
    const failed = (items || []).filter(i => i.status === 'error').length
    showToast(`一键完成结束：成功 ${done}，失败 ${failed}`)
    await loadTasks()
    await reload()
  } catch (err) {
    showToast('执行失败: ' + taskErrText(err), 'error', 5000)
  } finally {
    taskRunning.value = false
    taskProgressText.value = ''
    stopTaskPolling()
  }
}

// 接受任务：勾选了任务则接受选中项，否则接受该账号全部未接受任务
async function acceptTasks() {
  if (!taskUid.value) return
  taskAccepting.value = true
  try {
    const codes = selectedTaskCodes.value.slice()
    const res = await wbTaskAccept(taskUid.value, codes)
    showToast(`已接受 ${res.accepted || 0} 个任务`)
    selectedTaskCodes.value = []
    await loadTasks()
  } catch (err) {
    showToast('接受任务失败: ' + taskErrText(err), 'error', 4000)
  } finally {
    taskAccepting.value = false
  }
}

// 是否显示「领奖」按钮（未领取且进度达标/可领取）
function canClaim(t) {
  if (!t || t.claimed) return false
  return !!t.claimable || (t.target > 0 && t.current >= t.target)
}

// 单独领取某任务奖励
async function claimOne(t) {
  if (!t || !taskUid.value) return
  claimingCode.value = t.task_code
  try {
    const res = await wbTaskClaim(taskUid.value, t.task_code)
    if (res.already_claimed) showToast('该奖励此前已领取')
    else showToast(`已领取 +${res.credit || 0} 分 +${res.energy || 0} 能`)
    await loadTasks()
    await reload()
  } catch (err) {
    showToast('领奖失败: ' + taskErrText(err), 'error', 4000)
  } finally {
    claimingCode.value = ''
  }
}

// 全账号入队执行（未勾选任务则扫描全部待办）
async function startQueue() {
  queueStarting.value = true
  try {
    const taskCodes = selectedTaskCodes.value.slice()
    const res = await wbTaskRunQueue(taskCodes.length ? { taskCodes } : {})
    if (res.started === false && res.message) {
      showToast(res.message)
    } else {
      showToast(`已启动队列：${res.total || 0} 项`)
    }
    await refreshQueue()
    startQueuePolling()
  } catch (err) {
    showToast('入队失败: ' + taskErrText(err), 'error', 5000)
  } finally {
    queueStarting.value = false
  }
}

// 拉取队列状态快照
async function refreshQueue() {
  try {
    const data = await wbTaskQueue()
    queueItems.value = data.items || []
    queueRunning.value = !!data.running
  } catch {
    /* 单次失败忽略 */
  }
}

// 每 3 秒轮询队列状态（执行结束自动停止）
function startQueuePolling() {
  stopQueuePolling()
  queueTimer = setInterval(async () => {
    await refreshQueue()
    if (!queueRunning.value) stopQueuePolling()
  }, 3000)
}

// 停止队列轮询
function stopQueuePolling() {
  if (queueTimer) {
    clearInterval(queueTimer)
    queueTimer = null
  }
}

// 队列条目状态文案
function queueStateLabel(status) {
  if (status === 'running') return '执行中'
  if (status === 'done') return '完成'
  if (status === 'skipped') return '跳过'
  if (status === 'failed' || status === 'error') return '失败'
  return '排队中'
}

// 每 2 秒轮询任务执行进度
function startTaskPolling() {
  stopTaskPolling()
  taskTimer = setInterval(async () => {
    try {
      const p = await wbTaskProgress()
      if (p.running) taskProgressText.value = `${p.current || '执行中'}（${p.completed}/${p.total}）`
    } catch {
      /* 忽略单次轮询失败 */
    }
  }, 2000)
}

// 停止任务进度轮询
function stopTaskPolling() {
  if (taskTimer) {
    clearInterval(taskTimer)
    taskTimer = null
  }
}

// 全账号扫描未完成任务（含待办合计）
async function scanTasks() {
  taskScanning.value = true
  try {
    const data = await wbTaskScanAll()
    taskScanResult.value = Array.isArray(data.accounts) ? data.accounts : []
    taskPendingCount.value = data.pending_count || 0
    if (!taskScanResult.value.length) showToast('扫描完成：没有待处理账号')
  } catch (err) {
    taskScanResult.value = []
    taskPendingCount.value = 0
    showToast('扫描失败: ' + errText(err), 'error', 4000)
  } finally {
    taskScanning.value = false
  }
}

// 任务状态文案：已完成 / 未解锁 / 可领取
function taskStateLabel(t) {
  if (t.claimed) return '已完成'
  if (t.locked) return '未解锁'
  if (t.claimable) return '可领取'
  return '-'
}

// 任务接口错误文案（账号占用单独提示）
function taskErrText(err) {
  const d = err?.response?.data
  if (d && d.code === 'account_busy') return '该账号正在执行任务'
  if (d && d.code === 'queue_busy') return '队列正在执行中'
  return errText(err)
}

// ==================== 定时任务 ====================

// 加载排程状态并同步到可编辑表单
async function loadScheduler() {
  try {
    const data = await wbScheduler()
    schedState.value = data || {}
    const form = { ...schedForm.value }
    for (const t of SCHED_TASKS) {
      form[t.enabledKey] = !!(data.enabled && data.enabled[t.key])
      form[t.hoursKey] = ((data.hours && data.hours[t.key]) || []).join(',')
    }
    form.balanceRefreshMinutes = data.balanceRefreshMinutes || 0
    schedForm.value = form
  } catch (err) {
    showToast('排程加载失败: ' + errText(err), 'error')
  }
}

// 高级配置页：刷新只读汇总（账号池概览 + 排程）
async function loadAdvanced() {
  try {
    const data = await wbStatus()
    if (data.counts) counts.value = data.counts
  } catch {
    /* 只读概览失败不打断页面 */
  }
  await loadScheduler()
  await loadConfig()
}

// 加载运行时配置（提示词模式 / 指纹脱敏 / 设备令牌 / 池参数只读快照）
async function loadConfig() {
  try {
    const data = await wbConfig()
    cfg.value = { pool: data.pool || {} }
    cfgForm.value = {
      promptMode: data.promptMode || 'custom',
      rewriteMode: data.rewriteMode === 'native' ? 'native' : 'compat',
      clientIdentity: data.clientIdentity === 'codebuddy' ? 'codebuddy' : 'workbuddy',
      sanitizeFingerprints: data.sanitizeFingerprints !== false,
      deviceTokenFile: data.deviceTokenFile || '',
      // 后端返回「覆盖 > 官方默认」的完整生效值（30 项）；用空白模板打底防御字段缺失
      identity: { ...emptyIdentity(), ...(data.identity && typeof data.identity === 'object' ? data.identity : {}) }
    }
  } catch (err) {
    showToast('运行时配置加载失败: ' + errText(err), 'error')
  }
}

// 保存运行时配置（热生效，并持久化到 server-config.json）
async function saveConfig() {
  // 指纹与版本覆盖不允许空值：列出所有空项并提示保存失败（不提交）
  const emptyLabels = Object.keys(IDENTITY_LABELS)
    .filter(k => !String((cfgForm.value.identity || {})[k] ?? '').trim())
    .map(k => IDENTITY_LABELS[k])
  if (emptyLabels.length) {
    showToast('保存失败：以下项不能为空 —— ' + emptyLabels.join('、'), 'error', 6000)
    return
  }
  cfgSaving.value = true
  try {
    await wbUpdateConfig({ ...cfgForm.value })
    showToast('配置已保存并热生效')
    await loadConfig()
  } catch (err) {
    showToast('保存失败: ' + errText(err), 'error', 4000)
  } finally {
    cfgSaving.value = false
  }
}

// 毫秒时长格式化为可读文案
function formatDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '-'
  if (n >= 3600000) return `${Math.round((n / 3600000) * 10) / 10} 小时`
  if (n >= 60000) return `${Math.round(n / 60000)} 分钟`
  return `${Math.round(n / 1000)} 秒`
}

// 保存排程（时点 / 开关 / 余额刷新间隔）
async function saveScheduler() {
  schedSaving.value = true
  try {
    const form = schedForm.value
    const patch = {
      checkinEnabled: !!form.checkinEnabled,
      travelEnabled: !!form.travelEnabled,
      activityEnabled: !!form.activityEnabled,
      keepaliveEnabled: !!form.keepaliveEnabled,
      blackcatEnabled: !!form.blackcatEnabled,
      growthEnabled: !!form.growthEnabled,
      checkinHours: parseHours(form.checkinHours),
      travelHours: parseHours(form.travelHours),
      activityHours: parseHours(form.activityHours),
      keepaliveHours: parseHours(form.keepaliveHours),
      blackcatHours: parseHours(form.blackcatHours),
      growthHours: parseHours(form.growthHours),
      balanceRefreshMinutes: Number(form.balanceRefreshMinutes) || 0
    }
    await wbSchedulerUpdate(patch)
    showToast('排程已保存并热生效')
    await loadScheduler()
  } catch (err) {
    showToast('保存失败: ' + errText(err), 'error')
  } finally {
    schedSaving.value = false
  }
}

// 把逗号分隔的小时字符串解析为去重且升序的小时数组
function parseHours(text) {
  const out = []
  String(text || '')
    .split(',')
    .forEach(part => {
      const n = Number(part.trim())
      if (Number.isInteger(n) && n >= 0 && n <= 23 && !out.includes(n)) out.push(n)
    })
  return out.sort((a, b) => a - b)
}

// 小时数组格式化为展示文案
function formatHours(hours) {
  return Array.isArray(hours) && hours.length ? hours.join('、') + ' 点' : '-'
}

// 立即执行单类定时任务
async function runSchedulerTask(task) {
  runningTask.value = task
  try {
    const res = await wbSchedulerRun(task)
    showToast(`已执行 ${task}：${(res && res.summary) || '完成'}`)
    await loadScheduler()
    if (task === 'checkin' || task === 'balance') await reload()
  } catch (err) {
    showToast('执行失败: ' + errText(err), 'error', 5000)
  } finally {
    runningTask.value = ''
  }
}

// ==================== 运行日志 ====================

// 加载运行日志（按频道与关键字过滤）
async function loadLogs() {
  logLoading.value = true
  try {
    const data = await wbLogs({ channel: logChannel.value, keyword: logKeyword.value.trim(), limit: 200 })
    logs.value = data.logs || []
  } catch (err) {
    showToast('日志加载失败: ' + errText(err), 'error', 4000)
  } finally {
    logLoading.value = false
  }
}

// 切换日志自动刷新（每 3 秒）
function toggleLogAuto() {
  stopLogAuto()
  if (logAuto.value) {
    loadLogs()
    logTimer = setInterval(loadLogs, 3000)
  }
}

// 停止日志自动刷新
function stopLogAuto() {
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}

// 频道徽标文案
function channelLabel(channel) {
  if (channel === 'chat') return '对话'
  if (channel === 'task') return '任务'
  if (channel === 'system') return '系统'
  return channel || '其他'
}

// 级别徽标文案：服务端仅 info / warn 两种取值
function levelLabel(level) {
  if (level === 'warn') return '警告'
  return '信息'
}

// 频道徽标样式类
function channelClass(channel) {
  if (channel === 'chat') return 'ch-chat'
  if (channel === 'task') return 'ch-task'
  if (channel === 'system') return 'ch-system'
  return 'ch-other'
}

// ==================== 通用格式化 ====================

// 冷却剩余秒数格式化
function formatRemain(seconds) {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  return `${seconds}秒`
}

// 毫秒时间戳格式化为本地时间（YYYY-MM-DD HH:mm:ss）
function formatTime(ms) {
  if (!ms) return '-'
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '-'
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 毫秒时间戳仅取时分秒（日志行用）
function formatClock(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 大数字转 K / M 展示
function formatK(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

// 整数千分位展示
function formatInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return Math.round(n).toLocaleString('zh-CN')
}

// 均值保留一位小数
function formatAvg(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return String(Math.round(n * 10) / 10)
}

// 积分保留至多三位小数
function formatCredit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return String(Math.round(n * 1000) / 1000)
}

// 字节数人性化展示
function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n >= 1048576) return `${Math.round(n / 104857.6) / 10} MB`
  if (n >= 1024) return `${Math.round(n / 102.4) / 10} KB`
  return `${n} B`
}

// 数据起点格式化：小时桶键（YYYY-MM-DDTHH）转「YYYY-MM-DD HH 时」，日桶键（YYYY-MM-DD）原样
function sinceText(s) {
  if (!s) return '-'
  return String(s).includes('T') ? String(s).replace('T', ' ') + ' 时' : String(s)
}

// 统一提取接口错误文案
function errText(err) {
  return err?.response?.data?.error || err?.response?.data?.message || err?.message || '无法连接服务'
}
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.wb-stats {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--text-2);
}

.wb-stats .stat b {
  color: var(--text-1);
}

.wb-stats .ok b { color: #16A34A; }
.wb-stats .warn b { color: #D97706; }
.wb-stats .bad b { color: #DC2626; }

.wb-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.wb-tab {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-2);
  background: var(--bg-card);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-pill);
}

.wb-tab:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.wb-tab.active {
  color: #fff;
  background: var(--primary);
  border-color: var(--primary);
}

.wb-card {
  margin-bottom: 16px;
}

.wb-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.wb-count {
  font-size: 12px;
  color: var(--text-3);
}

.wb-note {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 12px;
  line-height: 1.6;
}

.wb-select {
  font-size: 13px;
  padding: 8px 12px;
  min-width: 200px;
}

.wb-input {
  font-size: 13px;
  padding: 8px 12px;
  flex: 1;
  min-width: 200px;
}

.filter-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.wb-auto {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-2);
}

.wb-empty {
  padding: 26px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px dashed var(--border-1);
  border-radius: var(--radius-md);
}

.table-wrap {
  overflow-x: auto;
}

.wb-table {
  width: 100%;
  border-collapse: collapse;
}

.wb-table th,
.wb-table td {
  text-align: left;
  padding: 10px 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-2);
  color: var(--text-1);
  vertical-align: top;
}

.wb-table th {
  color: var(--text-3);
  font-weight: 500;
  white-space: nowrap;
}

.wb-table tbody tr:hover {
  background: var(--bg-hover);
}

.wb-table .row-done {
  opacity: 0.55;
}

.nowrap {
  white-space: nowrap;
}

.mono {
  font-family: 'Courier New', Consolas, monospace;
  font-size: 12px;
}

.wb-state {
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}

.wb-state.is-ok { color: #16A34A; background: #ECFDF5; }
.wb-state.is-warn { color: #D97706; background: #FFFBEB; }
.wb-state.is-bad { color: #DC2626; background: #FEF2F2; }

.wb-reason-cell {
  max-width: 220px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 模型受限标记（11102 该后端无此模型 / 6004 限流） */
.wb-model-limited {
  margin-top: 2px;
  font-size: 11px;
  color: #D97706;
}

.wb-oauth {
  margin-bottom: 14px;
  padding: 14px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  background: var(--primary-bg);
}

.wb-oauth-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}

.wb-oauth-url {
  font-size: 12px;
  color: var(--primary);
  word-break: break-all;
  margin-bottom: 10px;
}

.wb-oauth-actions {
  display: flex;
  gap: 8px;
}

.wb-oauth-status {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
}

.reward {
  margin-right: 8px;
  font-size: 11px;
  color: #D97706;
}

.wb-scan {
  margin-bottom: 14px;
  padding: 12px;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.wb-scan-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}

.wb-scan-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  padding: 3px 0;
}

.wb-scan-name {
  color: var(--text-1);
  min-width: 140px;
}

.wb-scan-count {
  color: var(--primary);
}

.wb-scan-error {
  color: #DC2626;
}

.wb-scan-detail {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-task-name {
  font-size: 13px;
  color: var(--text-1);
}

.wb-desc {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}

.wb-hours-input {
  width: 130px;
  font-size: 13px;
  padding: 6px 10px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 10px;
}

.wb-kv {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border-2);
}

.wb-kv:last-child {
  border-bottom: none;
}

.wb-kv-label {
  color: var(--text-3);
  min-width: 120px;
}

.wb-kv-value {
  color: var(--text-1);
}

/* 高级配置页的编辑行（标签 + 控件） */
.config-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  font-size: 13px;
}

.config-label {
  color: var(--text-2);
  min-width: 120px;
}

/* 配置页底部操作行 */
.wb-actions-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 10px;
}

/* ===== 指纹与版本覆盖卡片 ===== */

/* 大类标题（WorkBuddy / CodeBuddy，与上方组以分隔线区隔） */
.fp-major-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  margin: 22px 0 0;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.fp-major-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
}

/* 分组标题（带风险色标） */
.fp-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  margin: 14px 0 8px;
}

/* 风险色标（安全 / 中风险 / 高风险） */
.fp-risk {
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  padding: 1px 6px;
  border-radius: 4px;
}

.fp-risk.safe {
  color: #4fb46e;
  background: rgba(79, 180, 110, 0.12);
}

.fp-risk.mid {
  color: #d8a657;
  background: rgba(216, 166, 87, 0.12);
}

.fp-risk.high {
  color: #e06c75;
  background: rgba(224, 108, 117, 0.12);
}

/* 覆盖项自适应双列网格 */
.fp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px 16px;
}

/* 单个覆盖项（标签 + 输入 + 说明） */
.fp-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 指纹输入框清空（placeholder 可见）时标红提示，保存将被拦截 */
.fp-grid .wb-input:placeholder-shown {
  border-color: #e06c75;
}

.fp-label {
  font-size: 12px;
  color: var(--text-2);
}

.fp-hint {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}

.wb-link {
  color: var(--primary);
  text-decoration: none;
}

.wb-logs {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  overflow-y: auto;
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
}

.wb-log-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--border-2);
}

.wb-log-row:last-child {
  border-bottom: none;
}

.wb-log-row.is-warn {
  background: #FEF2F2;
}

.wb-log-time {
  font-family: 'Courier New', Consolas, monospace;
  color: var(--text-3);
  flex-shrink: 0;
}

.wb-log-channel {
  flex-shrink: 0;
  font-size: 11px;
  border-radius: 4px;
  padding: 1px 6px;
}

.wb-log-channel.ch-chat { color: var(--primary); background: var(--primary-bg); }
.wb-log-channel.ch-task { color: var(--purple); background: #F6EEF8; }
.wb-log-channel.ch-system { color: var(--text-2); background: var(--bg-hover); }
.wb-log-channel.ch-other { color: var(--text-3); background: var(--bg-hover); }

.wb-log-level {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  min-width: 34px;
}

.wb-log-level.is-warn {
  color: #DC2626;
}

.wb-log-msg {
  color: var(--text-1);
  word-break: break-all;
}

/* ===== 账号详情弹窗与列表补充样式 ===== */

/* 运行态徽标（保活中 / 签到中 / 刷余额中） */
.wb-running {
  margin-left: 6px;
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-bg);
  border-radius: 4px;
  padding: 1px 6px;
}

/* 最近保活结果着色 */
.wb-ok {
  color: var(--success);
  font-size: 11px;
  margin-left: 4px;
}

.wb-bad {
  color: var(--danger);
  font-size: 11px;
  margin-left: 4px;
}

.mono {
  font-family: 'Courier New', Consolas, monospace;
}

.wb-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.wb-modal {
  width: 560px;
  max-height: 84vh;
  overflow-y: auto;
}

.wb-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.wb-modal-header h2 {
  font-size: 17px;
  margin: 0;
  color: var(--text-1);
}

.wb-modal-close {
  background: transparent;
  border: none;
  color: var(--text-3);
  font-size: 22px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.wb-modal-close:hover {
  color: var(--danger);
}

.wb-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.wb-detail-models {
  margin-top: 4px;
}

/* ===== 用量 / 积分消耗 ===== */
.wb-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 6px 0 14px;
}

.wb-cards.wb-credit-cards {
  padding-top: 12px;
  border-top: 1px dashed var(--border-1);
}

.wb-card-item {
  flex: 1 1 130px;
  min-width: 120px;
  padding: 10px 12px;
  border: 1px solid var(--border-1);
  border-radius: 8px;
  background: var(--bg-hover);
}

.wb-card-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 6px;
}

.wb-card-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-1);
}

.wb-card-value.bad { color: #DC2626; }
.wb-card-value.credit { color: #7C3AED; }

.wb-section-title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}
</style>