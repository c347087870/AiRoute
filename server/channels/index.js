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
  return runtime.rpc(body, signal)
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
