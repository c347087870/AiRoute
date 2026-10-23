// 十个账号渠道（LobsterAI / Qoder / Qoder 中国版 / TRAE / Cline / Loomy /
// Raccoon / MiniMax Code / ZCode / Gemini）在 AiRoute 里的入口。
//
// 和 server/workbuddy/ 的关系：两者解决同一类问题（多账号、换号、额度），但
// 渠道这十个的登录流程与 wire 协议量级是 6 万行，重写不现实 —— 所以它们跑
// vendor 进来的渠道包（business.mjs），本目录只提供宿主接口与协议转换。
//
// 对外只暴露四件事：目录、RPC、补全、关停。渠道自己的状态（账号池、黑名单、
// 积分）一律由渠道包持有并落盘到 dataDir —— AiRoute 不缓存副本，避免两份真相。

const path = require('path')
const fs = require('fs-extra')
const paths = require('../paths')
const workbuddy = require('../workbuddy/runtime')
const accountHealth = require('../account-health')
const { createChannelRuntime } = require('./runtime')

// 渠道数据目录与代码目录分开：server/channels 是随包分发的代码，
// 账号凭据与状态绝不能写进去（dev 模式下两者同父目录，极易混淆）
function resolveDataDir() {
  return path.join(paths.getDataDir(), 'channels-data')
}

let runtime = null
let initializing = null

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

// 幂等初始化：服务启动时调一次；失败不抛给调用方（渠道不可用不该让
// AiRoute 起不来，与 WorkBuddy 的初始化口径一致）
function init(options = {}) {
  if (runtime) return runtime.ready
  if (initializing) return initializing
  const logger = options.logger || console
  initializing = (async () => {
    const dataDir = options.dataDir || resolveDataDir()
    // 凭据与状态由渠道包直接写文件：目录不存在时第一次登录会 ENOENT
    fs.ensureDirSync(dataDir)
    const created = createChannelRuntime({
      dataDir,
      logger,
      onChanged: options.onChanged,
      host: createHost(),
    })
    runtime = created
    await created.ready
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

module.exports = {
  init,
  getRuntime,
  refreshModels,
  rpc,
  shutdown,
  resolveDataDir,
}
