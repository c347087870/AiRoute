// 十个账号渠道的运行时（worker 线程）
//
// 渠道实现本体是 vendor 进来的 `business.mjs`（由 scripts/build-channels.js 从
// dsh-our-free-model 的 pack.js 生成）。它是 DSH 插件的产物，按 cordis 插件的
// 形状编写：导入 `@deepseek-ai/dsh-llm` 的基类、接收一个带 credentials / llm /
// attachments 的 ctx。这里补的就是那份宿主接口（形状对齐上游 standalone）。
//
// 为什么放在 worker 线程：渠道业务有大量模块级单例（账号池、token 账本、串行
// 队列、ZCode 闸门）。放进主进程会让「重启渠道」与「重启服务」绑死，且任何一个
// 渠道的未捕获异常都会打崩 AiRoute 的 HTTP 服务。
//
// 协议：主线程 postMessage({ type, id, ... })，本线程回 result / chunk / error。

import { parentPort, workerData } from 'node:worker_threads'
import { createCredentials } from './credentials.mjs'
import { attachments } from './images.mjs'
import {
  apply, toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens, markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
} from './business.mjs'

const cleanups = []
const adapters = new Map()
const routes = new Map()
const controllers = new Map()
let closed = false

const send = message => parentPort.postMessage(message)
const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [
  level, message => send({ type: 'log', level, message: String(message) }),
]))

const credentials = createCredentials(workerData.dataDir)

// ---- 反向调用主进程 ----
// WorkBuddy 的账号池、会话、模型目录都在主进程（server/workbuddy/）。在 worker
// 里再建一份就会有两套账号池、两个定时任务，所以它的适配器只做代理，数据一律
// 向主进程要。走的是同一条 postMessage 通道，只是方向相反。
const hostCalls = new Map()
let hostSequence = 0

function callHost(op, payload = {}, timeoutMs = 30000) {
  const hid = ++hostSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostCalls.delete(hid)
      reject(new Error(`宿主操作超时：${op}`))
    }, timeoutMs)
    timer.unref?.()
    hostCalls.set(hid, {
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: error => { clearTimeout(timer); reject(error) },
    })
    send({ type: 'host', hid, op, payload })
  })
}

// 渠道包按 cordis 的 ctx 形状取用它需要的服务；这里只实现它真正调用到的部分。
// 少一个方法不会在挂载时报错，而是在某个渠道的某条路径上才炸 —— 所以刻意不用
// Proxy 兜底：宁可缺什么补什么，让缺口在测试里显形。
const ctx = {
  platform: { channelHome: workerData.dataDir },
  credentials,
  logger,
  attachments,
  connection: { fetch: { register(route) { routes.set(route.path, route) } } },
  get(name) { return this[name] },
  provide(name, value) {
    if (Object.hasOwn(this, name)) throw new Error(`服务重复注册：${name}`)
    this[name] = value
  },
  effect(body) {
    const cleanup = body()
    if (typeof cleanup === 'function') {
      if (closed) void cleanup()
      else cleanups.push(cleanup)
    }
    return cleanup
  },
  inject(names, body) { if (names.every(name => this[name] !== undefined)) return body(this) },
  emit() { send({ type: 'changed' }) },
  llm: {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) throw new Error(`渠道重复注册：${provider}`)
        adapters.set(provider, adapter)
      }
    },
    listProviders() { return [...adapters.keys()].map(id => ({ id })) },
    async listModels(provider) { return await adapters.get(provider)?.listModels(provider) ?? [] },
    async resolveModel(provider, model, signal) {
      const adapter = adapters.get(provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      return adapter.resolveModel(provider, model, signal)
    },
    async resolveModelInfo(provider, model, signal) { return this.resolveModel(provider, model, signal) },
    async *stream(options) {
      const adapter = adapters.get(options.provider)
      if (!adapter) throw Object.assign(new Error('渠道不存在'), { statusCode: 404 })
      const call = await adapter.prepareCall(options.provider, options.model, options.signal)
      yield* call.stream(options)
    },
  },
}

// 目录采集：逐个 provider 兜错（未登录的那家只是不出现在目录里，不是整体失败）
async function models() {
  const onError = (provider, error) => logger.warn(`${provider} 模型目录读取失败：${error.message}`)
  const groups = (await Promise.all([...adapters.keys()].map(provider => collectGatewayModels({
    listProviders: () => [{ id: provider }],
    listModels: id => ctx.llm.listModels(id),
  }, onError)))).flat()
  const infos = new Map()
  const views = await collectGatewayEffortViews({
    async resolveModelInfo(provider, model) {
      const info = await ctx.llm.resolveModel(provider, model)
      infos.set(`${provider}/${model}`, info)
      return info
    },
  }, groups, onError)
  return toOpenAiModels(groups, views).map(row => ({
    ...row,
    channel: row.owned_by,
    vision: row.input?.includes('image') === true,
    context_window: row.context_window ?? infos.get(row.id)?.context?.contextWindow,
    max_tokens: row.max_tokens ?? infos.get(row.id)?.defaultMaxTokens,
  }))
}

// 渠道管理 RPC（登录 / 账号池 / 积分 / 黑名单）：原样转发给渠道包自己注册的
// connection.fetch 路由。AiRoute 不做方法级白名单 —— 渠道包的方法表就是契约，
// 在这里再抄一份只会两边漂移。
async function rpc(call, signal) {
  const route = routes.get('/api/channel-pack')
  if (!route) throw new Error('渠道管理接口未注册')
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ type: 'client-request', rpcId: 'airoute', method: 'channel-pack', payload: call }),
  }))
  const reply = await response.json()
  return reply.result
}

// 一次补全：AiRoute 传进来的 `openAi` 已经是 OpenAI Chat 形态（Anthropic /
// Responses 客户端在 HTTP 层就转换完了），这里只负责换成渠道包认识的
// GenerateOptions 并驱动适配器。
async function complete(request, id, signal) {
  const slash = request.model.indexOf('/')
  const provider = request.model.slice(0, slash)
  const model = request.model.slice(slash + 1)
  if (!(await ctx.llm.listModels(provider)).some(row => row.id === model)) {
    throw Object.assign(new Error('模型不存在或已停用'), { statusCode: 404 })
  }
  const body = { ...(request.openAi ?? {}), model: request.model }
  const resolved = await ctx.llm.resolveModel(provider, model, signal)
  const effort = normalizeReasoningEffort(
    body.reasoning_effort, resolved, provider, model,
    notice => logger.info(`${request.model}：思考档位 ${notice.requested} ${notice.applied ? `映射为 ${notice.applied}` : '使用模型默认'}`)
  )
  const requested = body.max_completion_tokens ?? body.max_tokens
  const maxTokens = typeof requested === 'number' ? normalizeMaxTokens(requested, provider, model) : undefined
  const convert = body.__responses === true ? toResponsesGenerateOptions : toGenerateOptions
  const options = await convert(body, signal, effort, maxTokens, { bridge: attachments },
    dropped => logger.warn(`忽略无法表达的工具类型：${dropped.type}`))
  options.sessionId = `airoute:${String(body.user ?? body.conversation ?? 'shared')}`
  for await (const chunk of ctx.llm.stream(markGatewayChannel(options))) {
    if (signal.aborted) throw new Error('请求已取消')
    send({ type: 'chunk', id, chunk })
  }
}

parentPort.on('message', async message => {
  // 主进程对反向调用的回包：先于业务分支处理，否则会被当成未知操作
  if (message.type === 'host-result' || message.type === 'host-error') {
    const entry = hostCalls.get(message.hid)
    if (!entry) return
    hostCalls.delete(message.hid)
    if (message.type === 'host-result') entry.resolve(message.value)
    else entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    return
  }
  if (message.type === 'cancel') { controllers.get(message.id)?.abort(); return }
  if (message.type === 'close') {
    closed = true
    for (const controller of controllers.values()) controller.abort()
    credentials.dispose()
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch { /* 关闭路径不抛 */ } }
    send({ type: 'closed' })
    return
  }
  const { id, type } = message
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    if (closed) throw new Error('渠道已停止')
    if (type === 'models') send({ type: 'result', id, value: await models() })
    else if (type === 'rpc') send({ type: 'result', id, value: await rpc(message.call, controller.signal) })
    else if (type === 'complete') {
      await complete(message.request, id, controller.signal)
      send({ type: 'result', id })
    } else throw new Error('未知渠道操作')
  } catch (error) {
    send({ type: 'error', id, message: error.message, statusCode: error.statusCode ?? error.status })
  } finally { controllers.delete(id) }
})

apply(ctx, { disableOpencode: true })

// ---- WorkBuddy：渠道包里的第十一、十二个 provider（国内版 / 国际版）----
//
// 只注册**目录**能力。补全请求在 router 层直接交给主进程的 forwardChat ——
// 那边的 payload 管线已经把 OpenAI 请求体处理到「可直接发上游」的程度，若绕进
// 渠道包的 GenerateOptions 再转回 OpenAI，等于两次有损转换（工具调用、思考帧、
// 图片都会掉字段），换来的只是「走了一遍适配器」。
//
// 区域拆成两个 provider 而不是一个：模型 id 在两地的清单里会重名，而
// `provider/model` 是 AiRoute 的引用键 —— 合成一个就无法表达「国内版的 X」。
const WORKBUDDY_REALM = { workbuddy: 'cn', 'workbuddy-global': 'global' }

const workbuddyAdapter = {
  async listModels(provider) {
    const realm = WORKBUDDY_REALM[provider]
    if (!realm) return []
    // 没有登录账号时返回空数组而不是抛错：渠道包会据此把整组隐藏，
    // 抛错则会在目录里留下一条「provider 报错」
    return await callHost('workbuddy.models', { realm })
  },
  async resolveModel(provider, model) {
    const row = (await this.listModels(provider)).find(item => item.id === model)
    if (!row) throw Object.assign(new Error(`WorkBuddy 没有模型 ${model}`), { statusCode: 404 })
    return {
      provider,
      id: row.id,
      name: row.name || row.id,
      inputModalities: ['text', 'image'],
      ...row.contextWindow ? { context: { contextWindow: row.contextWindow } } : {},
      ...row.maxTokens ? { defaultMaxTokens: row.maxTokens } : {},
    }
  },
  prepareCall() {
    // 走到这里说明 router 的分派漏了 WorkBuddy 模型 —— 宁可报错，也不要
    // 悄悄走一条没人验证过的转换路径
    throw Object.assign(new Error('WorkBuddy 的补全由主进程直通执行，不应进入渠道适配器'), { statusCode: 500 })
  },
}

ctx.llm.registerAdapter(Object.keys(WORKBUDDY_REALM), workbuddyAdapter)

send({ type: 'ready', providers: [...adapters.keys()] })
