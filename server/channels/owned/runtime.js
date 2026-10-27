// 账号渠道的聚合运行时（插件驱动）
//
// 渠道从哪来由**插件清单**决定（plugin-host.js / plugin-store.js），本文件只负责
// 把 N 个插件的差异收口成渲染层与 router 看到的那**一套**接口：
// 模型目录、补全、RPC（登录 / 账号 / 额度 / 模型开关）。
//
// 为什么要一层聚合而不是让 router 直接调各插件：面板是按「provider id」驱动的
// 一张通用表格，RPC 方法表也是它写死的；让每个插件各讲一套方言，
// 面板里就会出现 N 套分支。
//
// WorkBuddy 两区不在这里：它的账号池、会话、调度器都在 server/workbuddy/，
// 本模块只为它注册目录、补全直通（见 index.js）。它也不是插件 —— 那套逻辑
// 与「一个 provider 一组账号」的插件模型不同形，硬套进来只会多一层有损转换。

const fs = require('fs')
const path = require('path')

const { createPluginHost } = require('../plugin-host')

function createOwnedRuntime({ dataDir, logger = console, onChanged }) {
  const host = createPluginHost({ dataDir, logger })
  const loaded = host.load()

  // 模型目录缓存（refresh 后整表重算）
  let rows = []
  let refreshing = null
  let closed = false
  // 模型开关与失效台账：本模块自己持有（每家插件不必各写一份）
  const stateFile = path.join(dataDir, 'owned-channels-state.json')

  const providers = host.providers()

  const emitChanged = () => {
    rows = []
    try {
      onChanged?.()
    } catch (error) {
      logger.warn?.(`[channels] 变更回调失败：${error.message}`)
    }
  }
  // 插件在账号变化时回调：绑上统一的事件出口，宿主不按插件写分支
  for (const provider of providers) {
    const instance = host.instanceOf(provider)
    instance?.backend.setEvents?.({ onChanged: emitChanged })
  }
  if (loaded.failures.length > 0) {
    logger.warn?.(`[channels] ${loaded.failures.length} 个渠道插件未加载：${loaded.failures.map(f => `${f.id}（${f.error}）`).join('、')}`)
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return {
        disabledModels: parsed.disabledModels && typeof parsed.disabledModels === 'object' ? parsed.disabledModels : {},
        deadModels: parsed.deadModels && typeof parsed.deadModels === 'object' ? parsed.deadModels : {},
      }
    } catch {
      return { disabledModels: {}, deadModels: {} }
    }
  }

  function writeState(state) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${stateFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, stateFile)
  }

  // 某 provider 的模型清单。插件的方法表一律带 provider 作为第一参数，
  // 一个包多个 provider 时由插件自己分派。
  async function modelsOf(provider) {
    const instance = host.instanceOf(provider)
    if (!instance) return []
    return instance.backend.listModels(provider)
  }

  async function buildRows() {
    const state = readState()
    const out = []
    for (const provider of providers) {
      // 未登录任何账号时**不播报模型**：渠道包时代也是这个口径
      // （「没有账号的渠道应当不出现，而不是报错」）。少了这道判断，
      // 新装用户会在模型列表里看到一个发不出去的渠道。
      if (providerAccounts(provider).length === 0) continue
      let models = []
      try {
        models = await modelsOf(provider)
      } catch (error) {
        // 一个渠道读目录失败不该让整张目录消失
        logger.warn?.(`[channels] ${provider} 模型目录读取失败：${error.message}`)
        continue
      }
      for (const model of models) {
        // ⚠️ 本模块里所有调用都发**裸模型 id**，目录行才是 `<provider>/<model>`；
        // 路由层按 `channels/<provider>/<model>` 引用，所以 `owned_by` 必须对
        // 被关掉的模型不进目录：目录就是「客户端能选到的范围」，
        // 关掉即从 /v1/models 与路由候选里消失（WorkBuddy 那边由启用清单天然同口径）
        if (state.disabledModels[`${provider}/${model.id}`] === true) continue
        const row = {
          id: `${provider}/${model.id}`,
          name: model.name,
          owned_by: provider,
          context_window: model.maxContext,
          max_tokens: model.maxOutput,
          vision: model.vision === true,
        }
        // 模型自带的推理档位（Trae 的 reasoning.efforts）同步进 Provider 配置，
        // 面板才能在模型行里让用户选档位
        if (model.reasoning?.efforts?.length) row.reasoning = model.reasoning
        out.push(row)
      }
    }
    return out
  }

  function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      // 每个插件刷一次远端目录（失败保留旧值）。按**插件**而不是按 provider：
      // 一个包两个 provider 时按 provider 刷会把同一份目录拉两次
      const instances = new Set(providers.map(provider => host.instanceOf(provider)).filter(Boolean))
      await Promise.allSettled([...instances].map(instance => instance.backend.refresh?.()))
      rows = await buildRows()
      return rows
    })().finally(() => { refreshing = null })
    return refreshing
  }

  // ── 旧数据迁移 ──
  //
  // 渠道包把十个渠道的凭据存在同一个文件里（channel-credentials.json），
  // 插件的凭据读写用的是**同一个文件、同一套键**，所以库里已有的账号
  // 无需复制 —— 只需要补一份「账号清单」（注册表），面板才列得出来。
  //
  // 认领由各插件自己做（importLegacy）：键前缀是它自己的事，
  // 宿主去认领等于把「谁持有什么键」写死在宿主里。
  function importLegacyAccounts() {
    let imported = 0
    for (const provider of providers) {
      const instance = host.instanceOf(provider)
      if (!instance || typeof instance.backend.importLegacy !== 'function') continue
      const count = instance.backend.importLegacy(provider)
      imported += Number(count) || 0
    }
    if (imported > 0) logger.info?.(`[channels] 已认领 ${imported} 个现有账号`)
    return imported
  }

  // ── RPC：面板与 CLI 的唯一入口 ──

  function providerOf(payload) {
    const provider = typeof payload?.provider === 'string' ? payload.provider : ''
    return providers.includes(provider) ? provider : ''
  }

  // provider 不在清单里时，要说清是「没装/停用了」还是「装了但没起来」
  function providerError(provider) {
    const owner = host.ownerOf(provider)
    if (owner.kind === 'failed') return `渠道插件 ${owner.failure.id} 加载失败：${owner.failure.error}`
    return provider ? `未知的渠道：${provider}` : '缺少 provider'
  }

  async function status() {
    // 面板按 statuses[provider].accounts.{total,enabled} 渲染「N 个账号 / 未登录」，
    // 所以这里给的是统计而不是数组
    const statuses = {}
    // 声明只算一次：host.list() 会把每个插件都描述一遍，逐 provider 调是白做功
    const checkinProviders = new Set(host.list().flatMap(item => item.checkinProviders || []))
    for (const id of providers) {
      const list = providerAccounts(id)
      statuses[id] = {
        id,
        accounts: {
          total: list.length,
          enabled: list.filter(row => row.enabled !== false).length,
        },
        models: { total: list.length > 0 ? (await safeModelsOf(id)).length : 0 },
        // 这家支持哪些按账号的动作。面板据此决定画不画按钮 ——
        // 「点了必然报不支持」的按钮比没有按钮更让人困惑，而这正是插件 ABI
        // 里「没这个方法就是这家不支持」的本来意思
        capabilities: capabilitiesOf(id, checkinProviders),
      }
    }
    return {
      statuses,
      providers: [...providers],
      // 加载失败的插件也报出来：面板能显示「某家没起来」而不是当它不存在。
      // 注意是读现状（info），不是再 load 一次 —— 那是重建整个宿主
      failures: host.info().failures,
    }
  }

  // 这家支持哪些按账号的动作。判据取插件自己的**声明**，不是「方法存不存在」：
  // Qoder 的 checkin() 是存在的（统一 ABI 里它必须有），但它永远回「不支持」，
  // 用方法存在性判断会给 Qoder 画出一个必然失败的「领取积分」。
  //   · checkin：插件清单里的 checkinProviders；
  //   · balance：后端真的实现了 balance()；
  //   · test：后端真的实现了 testAccount()（当前三家都没有，account.test 是旧 RPC）。
  function capabilitiesOf(provider, checkinProviders) {
    const instance = host.instanceOf(provider)
    return {
      checkin: checkinProviders.has(provider),
      balance: typeof instance?.backend?.balance === 'function',
      test: typeof instance?.backend?.testAccount === 'function',
    }
  }

  async function safeModelsOf(provider) {
    try {
      return await modelsOf(provider)
    } catch {
      return []
    }
  }

  function providerAccounts(provider) {
    const instance = host.instanceOf(provider)
    if (!instance) return []
    try {
      return instance.backend.listAccounts(provider) || []
    } catch (error) {
      logger.warn?.(`[channels] ${provider} 账号清单读取失败：${error.message}`)
      return []
    }
  }

  // 插件可选的运维方法：没有这个方法就是「这家不支持」，返回统一的 unsupported，
  // 而不是让调用方自己 try/catch 一个 TypeError
  async function optional(provider, method, ...args) {
    const instance = host.instanceOf(provider)
    const fn = instance?.backend?.[method]
    if (typeof fn !== 'function') return { supported: false }
    return { supported: true, value: await fn.call(instance.backend, provider, ...args) }
  }

  async function rpc(body) {
    const method = body?.method
    const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {}
    const provider = providerOf(payload)

    switch (method) {
      case 'provider.status':
        return { ok: true, value: await status() }

      case 'plugin.list':
        // 插件管理：装了什么、开没开、哪家没起来（CLI 与面板共用）
        return { ok: true, value: host.info() }

      case 'account.list': {
        if (!provider) return { ok: false, error: providerError(payload?.provider) }
        return { ok: true, value: providerAccounts(provider) }
      }

      case 'account.create': {
        // 登录：回调式（Trae）与设备码轮询式（Qoder）都由插件自己实现，
        // 宿主只回它给的形状。两者的 accountId 都当登录会话键 ——
        // 面板轮询 login.poll 时只认这个字段。
        if (!provider) return { ok: false, error: providerError(payload?.provider) }
        const started = await optional(provider, 'startLogin')
        if (!started.supported) return { ok: false, error: `${provider} 不支持登录` }
        const value = started.value || {}
        return {
          ok: true,
          value: {
            status: 'pending',
            loginUrl: value.loginUrl,
            accountId: value.state,
            // 有 pollLogin 的是轮询式（设备码），否则等本地回调
            mode: host.instanceOf(provider)?.backend.pollLogin ? 'poll' : 'callback',
          },
        }
      }

      case 'login.poll': {
        if (!provider) return { ok: false, error: providerError(payload?.provider) }
        const session = String(payload.accountId || payload.state || '')
        const instance = host.instanceOf(provider)
        if (instance?.backend.pollLogin) {
          const result = await instance.backend.pollLogin(provider, session)
          if (result.status === 'pending') return { ok: true, value: { done: false } }
          if (result.status === 'done') return { ok: true, value: { done: true, success: true, accountId: result.uid } }
          return { ok: true, value: { done: true, success: false, error: result.message } }
        }
        // 回调式：完成与否由宿主持有的那台登录服务回答
        const status = host.login.statusOf(session)
        if (!status || !status.done) return { ok: true, value: { done: false } }
        return {
          ok: true,
          value: status.ok ? { done: true, success: true } : { done: true, success: false, error: status.error },
        }
      }

      case 'account.delete': {
        const uid = String(payload.accountId || payload.uid || '')
        if (!provider || !uid) return { ok: false, error: providerError(payload?.provider) || '缺少 accountId' }
        const removed = await optional(provider, 'removeAccount', uid)
        if (!removed.supported) return { ok: false, error: `${provider} 不支持删除账号` }
        return { ok: true }
      }

      case 'account.update': {
        // 面板的「启用/停用」与账号健康台账的自动停用都走这里
        const uid = String(payload.accountId || payload.uid || '')
        const accountId = payload.accountId
        if (!provider || !uid) return { ok: false, error: providerError(payload?.provider) || '缺少 accountId' }
        const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
        const updated = await optional(provider, 'updateAccount', uid, patch)
        if (!updated.supported) return { ok: false, error: `${provider} 不支持修改账号` }
        emitChanged()
        return { ok: true, accountId }
      }

      case 'account.refresh': {
        const uid = String(payload.accountId || payload.uid || '')
        if (!provider || !uid) return { ok: false, error: providerError(payload?.provider) || '缺少 accountId' }
        try {
          const res = await optional(provider, 'refreshAccount', uid)
          if (!res.supported) return { ok: false, error: `${provider} 不支持续期` }
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error.message }
        }
      }

      case 'model.list': {
        if (!provider) return { ok: false, error: providerError(payload?.provider) }
        const state = readState()
        return {
          ok: true,
          value: providerAccounts(provider).length === 0
            ? []
            : (await modelsOf(provider)).map(model => ({
              id: `${provider}/${model.id}`,
              name: model.name,
              disabled: state.disabledModels[`${provider}/${model.id}`] === true,
              dead: state.deadModels[`${provider}/${model.id}`] > Date.now(),
            })),
        }
      }

      case 'model.setEnabled': {
        // 引导页的「多选开启」：给出一份完整启用清单，其余全关。
        // 传完整清单而不是逐个开关，一次落盘一次广播。
        // 允许空清单：整组全关后渠道源里没有该渠道的模型，/v1/models 不再列它
        const modelIds = Array.isArray(payload.modelIds) ? payload.modelIds.filter(id => typeof id === 'string' && id) : []
        const ids = new Set(modelIds)
        const state = readState()
        const next = {}
        for (const model of await modelsOf(provider)) {
          const full = `${provider}/${model.id}`
          if (!ids.has(full) && !ids.has(model.id)) next[full] = true
        }
        state.disabledModels = next
        writeState(state)
        emitChanged()
        return { ok: true, enabled: [...ids] }
      }

      case 'model.setDisabled': {
        const modelId = String(payload.modelId || payload.model || '')
        if (!modelId) return { ok: false, error: '缺少 modelId' }
        const state = readState()
        if (payload.disabled === false) delete state.disabledModels[modelId]
        else state.disabledModels[modelId] = true
        writeState(state)
        emitChanged()
        return { ok: true }
      }

      case 'model.setDisabledMany': {
        // 面板的「全部开启 / 全部关闭」：一次 RPC 改一批，避免逐条往返
        const modelIds = Array.isArray(payload.modelIds) ? payload.modelIds.filter(id => typeof id === 'string' && id) : []
        if (modelIds.length === 0) return { ok: false, error: '缺少 modelIds' }
        const state = readState()
        for (const modelId of modelIds) {
          if (payload.disabled === false) delete state.disabledModels[modelId]
          else state.disabledModels[modelId] = true
        }
        writeState(state)
        emitChanged()
        return { ok: true }
      }

      case 'model.clearDead': {
        const state = readState()
        delete state.deadModels[String(payload.modelId || payload.model || '')]
        writeState(state)
        return { ok: true }
      }

      // 单个账号的签到 / 余额。面板的账号行按行给按钮（与 WorkBuddy 的行内
      // 「签到 / 余额」同构），而 credits.claimAll / credits.balances 是整渠道的
      // —— 一次只点一行却动全渠道，会误伤其它账号，也不给出「这一行」的结果。
      case 'account.checkin': {
        const uid = String(payload.accountId || payload.uid || '')
        if (!provider || !uid) return { ok: false, error: providerError(payload?.provider) || '缺少 accountId' }
        const entry = providerAccounts(provider).find(row => row.id === uid || row.uid === uid)
        if (!entry) return { ok: false, error: `账号 ${uid} 不存在` }
        const done = await optional(provider, 'checkin', entry.uid)
        if (!done.supported) return { ok: false, error: `${provider} 没有每日签到端点` }
        const outcome = done.value || {}
        return {
          ok: true,
          value: {
            accountId: entry.id,
            outcome: outcome.outcome === 'claimed' ? 'claimed' : outcome.outcome === 'done' ? 'done' : outcome.outcome || 'failed',
            credit: outcome.credit,
            message: outcome.message || '',
          },
        }
      }

      case 'account.balance': {
        const uid = String(payload.accountId || payload.uid || '')
        if (!provider || !uid) return { ok: false, error: providerError(payload?.provider) || '缺少 accountId' }
        const entry = providerAccounts(provider).find(row => row.id === uid || row.uid === uid)
        if (!entry) return { ok: false, error: `账号 ${uid} 不存在` }
        const done = await optional(provider, 'balance', entry.uid)
        if (!done.supported) return { ok: false, error: `${provider} 不提供余额查询端点` }
        const value = done.value || {}
        return { ok: true, value: { accountId: entry.id, balance: value.balance ?? value.total ?? null } }
      }

      case 'credits.claimAll': {
        if (!provider) return { ok: false, error: providerError(payload?.provider) }
        // 面板要的是 { summary, results }（summary 用来拼「领取 N，已领过 M」），
        // 所以这里把各账号的结果归并成那个形状，而不是直接回数组
        const results = []
        const instance = host.instanceOf(provider)
        const checkin = instance?.backend?.checkin
        for (const entry of providerAccounts(provider)) {
          if (typeof checkin !== 'function') {
            // 没有签到端点：如实说「未开通」，不留一条必然失败的记录
            results.push({ accountId: entry.id, nickname: entry.name, outcome: { kind: 'inactive', message: `${provider} 没有每日签到端点` } })
            continue
          }
          try {
            const outcome = await checkin.call(instance.backend, provider, entry.uid)
            results.push({
              accountId: entry.id,
              nickname: entry.name,
              outcome: outcome.outcome === 'claimed'
                ? { kind: 'claimed', credit: outcome.credit, unit: 'credit' }
                : outcome.outcome === 'done'
                  ? { kind: 'already-claimed', message: '今天已签过' }
                  : { kind: outcome.outcome === 'ineligible' ? 'inactive' : 'failed', message: outcome.message || '' },
            })
          } catch (error) {
            results.push({ accountId: entry.id, nickname: entry.name, outcome: { kind: 'failed', message: error.message } })
          }
        }
        const count = kind => results.filter(row => row.outcome.kind === kind).length
        const credit = results.reduce((sum, row) => sum + (row.outcome.kind === 'claimed' ? Number(row.outcome.credit) || 0 : 0), 0)
        return {
          ok: true,
          value: {
            summary: {
              claimed: count('claimed'),
              alreadyClaimed: count('already-claimed'),
              inactive: count('inactive'),
              failed: count('failed'),
              totalByUnit: { credit, token: 0 },
            },
            results,
          },
        }
      }

      case 'credits.balances': {
        if (!provider) return { ok: false, error: providerError(payload?.provider) }
        // 面板按 { accounts: [{ accountId, nickname, balance }] } 渲染
        const rows = []
        const instance = host.instanceOf(provider)
        const balance = instance?.backend?.balance
        for (const entry of providerAccounts(provider)) {
          if (typeof balance !== 'function') {
            rows.push({ accountId: entry.id, nickname: entry.name, error: `${provider} 不提供余额查询端点` })
            continue
          }
          try {
            const value = await balance.call(instance.backend, provider, entry.uid)
            rows.push({
              accountId: entry.id,
              nickname: entry.name,
              // Trae 回 { total, packages, expiredTotal }（余额 = Σ 各资源包剩余），
              // 没有 balance 字段；两个都认，取不到才是 null
              balance: {
                total: value.balance ?? value.total ?? null,
                expiredTotal: value.expiredTotal ?? 0,
              },
            })
          } catch (error) {
            rows.push({ accountId: entry.id, nickname: entry.name, error: error.message })
          }
        }
        return { ok: true, value: { accounts: rows } }
      }

      default:
        return { ok: false, error: `未支持的方法：${method}` }
    }
  }

  return {
    // 重建插件清单时要照原样再挂一次，所以把入参留在运行时上
    dataDir,
    onChanged,
    providers,
    plugins: () => host.list(),
    pluginFailures: () => host.info().failures,
    state: () => ({ state: 'ready', error: '' }),
    publicModelRows: () => rows,
    refresh,
    // 渠道包播报的是 `<provider>/<model>`，与 AiRoute 的引用格式一致
    handles: model => providers.some(provider => model.startsWith(`${provider}/`)),
    rpc,
    // 供 index.js 的路由层调用：entry.model.id 是 `channels/<provider>/<model>`
    complete: async (request, onChunk, signal) => {
      const ref = String(request.model || '')
      const slash = ref.indexOf('/')
      if (slash === -1) throw Object.assign(new Error(`无法识别的模型引用：${ref}`), { statusCode: 404 })
      const provider = ref.slice(0, slash)
      const model = ref.slice(slash + 1)
      const instance = host.instanceOf(provider)
      if (!instance) {
        throw Object.assign(new Error(providerError(provider)), { statusCode: 404 })
      }
      return instance.backend.complete(provider, { provider, model, openAi: request.openAi }, onChunk, signal)
    },
    importLegacyAccounts,
    // 插件管理动作：装 / 卸 / 启停之后要重建运行时（清单变了，provider 集合就变了）
    store: host.store,
    close: async () => {
      if (closed) return
      closed = true
      await host.shutdown()
    },
  }
}

module.exports = { createOwnedRuntime }
