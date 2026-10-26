// 账号渠道在 AiRoute 里的入口。
//
// 三条来路，互不耦合：
//   - WorkBuddy 两区：账号池、会话、模型目录都在主进程 server/workbuddy/，
//     本目录只为它注册目录、补全直通（见下面的 runtime facade）；
//   - TRAE / Qoder / Qoder 国内版：**以插件形式装进来**（server/channels/plugins/），
//     由 plugin-host 发现、加载，经 ./owned/runtime 聚合成与面板一致的那一套接口。
//     装了什么、开没开在 channels-plugins.json（见 plugin-store.js）；
//   - 渠道包（business.mjs）已整体移除 —— 那 2.6 MB 打包产物不可读也不可审，
//     无法核对一家渠道实际发了什么。
//
// 对外暴露：目录、RPC、补全、插件管理、关停。账号与黑名单状态一律由各渠道自己
// 持有并落盘到 dataDir —— AiRoute 不缓存副本，避免两份真相。

const path = require('path')
const fs = require('fs-extra')
const paths = require('../paths')
const workbuddy = require('../workbuddy/runtime')
const accountHealth = require('../account-health')
const { createOwnedRuntime } = require('./owned/runtime')
const { BUILTIN_PLUGINS } = require('./plugin-store')

// 渠道数据目录与代码目录分开：server/channels 是随包分发的代码，
// 账号凭据与状态绝不能写进去（dev 模式下两者同父目录，极易混淆）
function resolveDataDir() {
  return path.join(paths.getDataDir(), 'channels-data')
}

let runtime = null
let initializing = null
let owned = null

// WorkBuddy 作为渠道包里的两个 provider（workbuddy / workbuddy-global）接进来。
// 它的账号池与会话状态在主进程，worker 里的适配器只做代理 —— 这里就是被代理的
// 那一端。返回空数组而不是抛错：没有账号时渠道包应当「不出现」而不是「报错」。
function createHost() {
  return {
    'workbuddy.models'({ realm } = {}) {
      if (!workbuddy.getRuntime()) return []
      const scope = realm === 'global' ? 'global' : 'cn'
      return workbuddy.getEnabledModelsWithEfforts(scope).map(model => ({
        id: model.id,
        name: model.displayName || model.id,
        contextWindow: model.maxContext || undefined,
        maxTokens: model.maxOutput || undefined,
      }))
    },
  }
}

// 本模块对外暴露的运行时：WorkBuddy 两个区域的目录由主进程提供，
// 其余交给 owned runtime（TRAE / Qoder）。
//
// 为什么 WorkBuddy 不并进 owned：它的账号池、会话、调度器、任务体系都在
// server/workbuddy/（1.4 万行，40+ 个 /api/workbuddy/* 接口），本目录只提供
// 「目录 + 补全直通」这两件事，补全在 router 层直接交给 forwardChat。
function createRuntimeFacade(ownedRuntime) {
  let rows = []
  let refreshing = null

  const workbuddyRows = () => {
    if (!workbuddy.getRuntime()) return []
    const out = []
    for (const [provider, realm] of [['workbuddy', 'cn'], ['workbuddy-global', 'global']]) {
      const models = workbuddy.getEnabledModelsWithEfforts(realm)
      // 没有启用任何模型时整组不出现（与「没有账号的渠道不播报」同口径）
      if (models.length === 0) continue
      for (const model of models) {
        out.push({
          id: `${provider}/${model.id}`,
          name: model.displayName || model.id,
          owned_by: provider,
          context_window: model.maxContext || undefined,
          max_tokens: model.maxOutput || undefined,
          vision: true,
        })
      }
    }
    return out
  }

  // provider 清单 = 插件声明的那几家 + WorkBuddy 两区。顺序按清单来
  // （面板与目录都照这个先后），插件没装/停用的话这里自然就没有它。
  const providers = () => {
    const ids = [...ownedRuntime.providers]
    if (workbuddy.getRuntime()) ids.push('workbuddy', 'workbuddy-global')
    return ids
  }

  function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      await ownedRuntime.refresh()
      rows = [...workbuddyRows(), ...ownedRuntime.publicModelRows()]
      return rows
    })().finally(() => { refreshing = null })
    return refreshing
  }

  return {
    get providers() { return providers() },
    state: () => ({ state: 'ready', error: '' }),
    publicModelRows: () => rows,
    refresh,
    handles: model => providers().some(provider => model.startsWith(`${provider}/`)),
    rpc: (body, signal) => ownedRuntime.rpc(body, signal),
    complete: (request, onChunk, signal) => ownedRuntime.complete(request, onChunk, signal),
    // 插件现状与加载失败原因：面板 / CLI 都从这里读，不另存一份
    plugins: () => ownedRuntime.plugins(),
    pluginFailures: () => ownedRuntime.pluginFailures(),
    // 插件清单（装/卸/启停的执行者）：router 的 /api/channels/plugins 直接用它。
    // 少了这一条，POST 会一路拿到 503「运行时未初始化」而 GET 却是好的 ——
    // 面板里就表现为「看得到插件列表、但点不动」。
    store: ownedRuntime.store,
    close: () => ownedRuntime.close(),
  }
}

// WorkBuddy 的目录在每次账号/模型清单变化后要重算：它的清单不在插件里
// （插件只管自己声明的那几家），所以这里单独摆一个刷新入口给 router 用。
async function refreshWorkbuddyOnly() {
  if (!runtime) return
  await runtime.refresh()
}

// 幂等初始化：服务启动时调一次；失败不抛给调用方（渠道不可用不该让
// AiRoute 起不来，与 WorkBuddy 的初始化口径一致）
function init(options = {}) {
  if (runtime) return runtime.ready
  if (initializing) return initializing
  const logger = options.logger || console
  initializing = (async () => {
    const dataDir = options.dataDir || resolveDataDir()
    // 凭据与状态要写文件：目录不存在时第一次登录会 ENOENT
    fs.ensureDirSync(dataDir)
    owned = createOwnedRuntime({ dataDir, logger, onChanged: options.onChanged })
    // 认领渠道包时代留下的账号：同一份凭据文件、同一套键名，
    // 这里只补账号清单，所以用户不需要重新登录
    try {
      owned.importLegacyAccounts()
    } catch (error) {
      // 认领失败不该让渠道整个起不来：新用户本来就没有旧账号
      logger.warn?.(`[channels] 旧账号认领失败：${error.message}`)
    }
    const created = createRuntimeFacade(owned)
    // 调用方（route）会 await runtime.ready：这里就是一个已完成的 Promise，
    // 目录刷新刻意**不**并进 ready（不可用的渠道不该拖住服务启动）
    created.ready = Promise.resolve(created)
    runtime = created
    // 目录刷新放在后台：某个渠道登录态异常不该拖住服务启动
    created.refresh().catch(error => logger.warn?.(`[channels] 模型目录刷新失败：${error.message}`))
    return created
  })().catch(error => {
    // 初始化失败就把句柄清掉：留着一个已关闭的运行时会让请求拿到 404
    // 而不是「渠道未就绪」的 503，排查时容易误判成模型配置问题
    runtime = null
    initializing = null
    console.error('[aiRoute] 渠道初始化失败:', error.message)
    throw error
  })
  return initializing
}

function getRuntime() {
  return runtime
}

// 立即刷新的模型目录（登录/登出后用，避免等下一次启动）
async function refreshModels() {
  if (!runtime) throw new Error('渠道运行时未初始化')
  return runtime.refresh()
}

async function rpc(body, signal) {
  if (!runtime) throw new Error('渠道运行时未初始化')
  const result = await runtime.rpc(body, signal)
  // 等证据落定（最多一次池写入）再返回：界面测完账号立刻 reload，才看得到
  // 「已停用」的新状态，而不是要等下一次轮询
  await afterRpc(body, result)
  return result
}

// 一次 RPC 之后顺手处理「账号被上游禁用」的证据。
//
// 为什么收口在这里：渠道包的调用方有好几处（界面上的测试、余额审计、账号列表），
// 而证据只随其中几个方法的返回出现 —— 分散到各调用方去判，漏一处就等于
// 「某种情况下不标记」。
async function afterRpc(body, result) {
  const method = typeof body?.method === 'string' ? body.method : ''
  const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {}
  // 用户重新启用账号：清掉旧的禁用原因，否则标签会一直挂在他刚打开的那个号上
  if (method === 'account.update' && payload.patch && payload.patch.enabled === true) {
    accountHealth.clear(payload.accountId)
    return
  }
  // 账号被删掉：台账里那条原因已经没有归属对象了
  if (method === 'account.delete' && result && result.ok === true) {
    accountHealth.clear(payload.accountId)
    return
  }
  for (const { accountId, reason } of accountHealth.evidenceOf(method, payload, result)) {
    try {
      await markAccountDisabled(accountId, reason)
    } catch (error) {
      // 标记是补救动作：失败只记日志，不能把这次 RPC 的结果推翻
      console.error(`[aiRoute] 自动停用账号 ${accountId} 失败:`, error.message)
    }
  }
}

// 在池里停用账号，并把原因记进 AiRoute 的台账（渠道包的 patch 没有原因字段）。
// 用 runtime.rpc 直连而不走上面的 rpc：走 rpc 会让这次「停用」再触发一遍证据检查。
// 先停用、后记账：停用失败就什么都不记，界面上不能出现「已禁用」但勾选框还开着。
const pendingDisable = new Set()

async function markAccountDisabled(accountId, reason) {
  // 已经记过原因 / 正在停用就不重复做：账号列表、余额查询会被反复调用
  if (accountHealth.reasonOf(accountId) || pendingDisable.has(accountId)) return
  pendingDisable.add(accountId)
  try {
    await runtime.rpc({ method: 'account.update', payload: { accountId, patch: { enabled: false } } })
    accountHealth.record(accountId, reason)
  } finally {
    pendingDisable.delete(accountId)
  }
}

// 插件管理动作（装 / 卸 / 启停）之后必须重建运行时：
// provider 集合是由清单算出来的，不重建的话界面会显示新清单、请求还在按旧的走。
//
// 重建期间要先把旧的关掉（停掉在途登录会话与目录缓存），否则两个宿主
// 会同时持有同一份 dataDir 的注册表，后写的覆盖前写的。
async function reloadPlugins() {
  const dataDir = owned?.dataDir || resolveDataDir()
  if (!runtime) return init({ dataDir })
  const onChanged = owned?.onChanged
  const closing = runtime.close()
  runtime = null
  initializing = null
  await closing
  owned = null
  return init({ dataDir, onChanged })
}

async function shutdown() {
  // 初始化可能还在飞：先等它落定，否则关掉之后旧 promise 会把 runtime 又设回来
  if (initializing) {
    try {
      await initializing
    } catch {}
  }
  if (!runtime) return
  const closing = runtime.close()
  runtime = null
  initializing = null
  await closing
}

// 内置插件清单（随包分发的那几家）：给面板/CLI 判断「这一家是内置的还是外部装的」
function listBuiltinPlugins() {
  return BUILTIN_PLUGINS.map(item => ({ id: item.id, builtin: true, source: item.path }))
}

module.exports = {
  init,
  listBuiltinPlugins,
  getRuntime,
  refreshModels,
  refreshWorkbuddyOnly,
  rpc,
  reloadPlugins,
  shutdown,
  resolveDataDir,
}
