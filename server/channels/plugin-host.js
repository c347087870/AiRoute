// 渠道插件宿主：发现 → 加载 → 建 provider 索引 → 生命周期
//
// 这个进程里「哪些渠道存在」完全由清单决定（见 plugin-store.js）。宿主自己
// 不认识任何一家渠道的协议 —— 协议在插件包里，宿主只按 plugin-api.js 的约定
// 调它的方法表。
//
// 加载失败不抛给调用方：一家插件的依赖坏了（比如 WASM 没随包分发）不该让
// 其余渠道和整个服务起不来。失败记在 `failures` 里，面板与 CLI 都读得到 ——
// 「渠道列表是空的」和「这个渠道为什么没起来」是两个问题，后者必须有答案。
//
// ⚠️ 「声明」与「可用」要分开记：插件可能 require 成功、create() 失败
// （缺 WASM、缺宿主服务）。只记可用的话，用户看到的现象是「这个渠道从列表里
// 消失了」，而真正的原因（加载失败）反而查不到。所以先读声明，再建后端。

const { createPluginStore } = require('./plugin-store')
const { createPluginContext, validateBackend } = require('./plugin-api')
const { createLoginServer } = require('./shared/login-server')
const { createVersionSync } = require('./version-sync')

function createPluginHost({ dataDir, logger = console, settings }) {
  const store = createPluginStore({ dataDir, logger })
  // 全局只有一份登录回调服务：端口是稀缺资源，多个插件各自起一个会撞端口，
  // 而回调里的 state 已经能区分是哪次登录
  const login = createLoginServer({ logger })
  // 版本号同步：Trae 登录页按客户端形态校验版本，Qoder 目录解析也依赖版本号。
  // 每天拉一次官网，插件经 ctx.versions 读当前值
  const versionSync = createVersionSync(dataDir, { logger })
  versionSync.start()
  const ctx = createPluginContext({ dataDir, logger, login, settings, versions: versionSync })

  // id → { item, plugin, backend, dir }（只有加载成功的在这里）
  const loaded = new Map()
  // id → { id, error, providers }（加载失败的也留下声明）
  const failures = new Map()
  // provider id → 插件实例。补全/账号/RPC 全靠它分派
  const byProvider = new Map()

  // 读插件包本身：require 入口，拿清单。这一步失败说明包坏了（路径不对、
  // 语法错误、依赖缺失），此时连它声明了哪几家都不知道。
  function readPlugin(item) {
    const { dir, entry } = store.resolveEntry(item)
    if (!entry) throw new Error(`插件文件缺失：${dir || item.source}`)
    // require 走绝对路径：插件可能装在数据目录里，与宿主不在同一棵树上。
    // 清缓存是为了「重装即生效」—— 否则同一进程里换掉的包还会跑旧代码。
    delete require.cache[require.resolve(entry)]
    // eslint-disable-next-line global-require
    const plugin = require(entry)
    if (!plugin || typeof plugin.create !== 'function') throw new Error(`插件 ${item.id} 没有导出 create()`)
    const declared = Object.keys(plugin.providers || {}).filter(Boolean)
    return { plugin, dir, entry, declared }
  }

  function instantiate(item, { plugin, dir }) {
    const backend = validateBackend(item.id, plugin.create({ ...ctx, pluginDir: dir, plugin }))
    return backend
  }

  function describe(instance) {
    const { plugin, backend, item } = instance
    return {
      id: item.id,
      name: plugin.name || item.name || item.id,
      builtin: item.builtin === true,
      enabled: item.enabled !== false,
      providers: [...backend.providers],
      // 有签到端点才报：面板据此决定画不画「领取积分」，而不是靠 id 猜
      checkinProviders: Array.isArray(plugin.checkinProviders) ? plugin.checkinProviders : [],
    }
  }

  function load() {
    loaded.clear()
    failures.clear()
    byProvider.clear()
    for (const item of store.enabled()) {
      let read
      try {
        read = readPlugin(item)
      } catch (error) {
        failures.set(item.id, { id: item.id, error: error.message, providers: [] })
        logger.warn?.(`[channels] 插件 ${item.id} 读取失败：${error.message}`)
        continue
      }
      let backend
      try {
        backend = instantiate(item, read)
      } catch (error) {
        failures.set(item.id, { id: item.id, error: error.message, providers: read.declared })
        logger.warn?.(`[channels] 插件 ${item.id} 初始化失败：${error.message}`)
        continue
      }
      const instance = { plugin: read.plugin, backend, item, dir: read.dir }
      loaded.set(item.id, instance)
      for (const provider of backend.providers) {
        if (byProvider.has(provider)) {
          logger.warn?.(`[channels] provider ${provider} 被多个插件声明，后装的 ${item.id} 覆盖前一个`)
        }
        byProvider.set(provider, instance)
      }
    }
    return info()
  }

  // 所有已加载插件声明的 provider（顺序 = 清单顺序，决定面板与目录的先后）
  function providers() {
    const out = []
    for (const instance of loaded.values()) out.push(...instance.backend.providers)
    return out
  }

  function instanceOf(provider) {
    return byProvider.get(provider) || null
  }

  // 插件加载失败时，调用方需要知道「这个 provider 本该存在」，才能把错误
  // 说成「插件没起来」而不是「没有这个渠道」
  function failedProviderOf(provider) {
    for (const failure of failures.values()) {
      if (failure.providers.includes(provider)) return failure
    }
    return null
  }

  // 这个 provider 归谁管：加载成功的给实例，失败的给失败记录，都没有就是未知
  function ownerOf(provider) {
    const instance = instanceOf(provider)
    if (instance) return { kind: 'ready', instance }
    const failure = failedProviderOf(provider)
    if (failure) return { kind: 'failed', failure }
    return { kind: 'unknown' }
  }

  function info() {
    return {
      plugins: [...loaded.values()].map(describe),
      failures: [...failures.values()],
    }
  }

  async function shutdown() {
    versionSync.stop()
    for (const instance of loaded.values()) {
      try {
        await instance.backend.shutdown?.()
      } catch (error) {
        logger.warn?.(`[channels] 插件 ${instance.item.id} 关停失败：${error.message}`)
      }
    }
    loaded.clear()
    byProvider.clear()
    failures.clear()
    login.closeAll()
  }

  return {
    store,
    login,
    load,
    info,
    providers,
    instanceOf,
    failedProviderOf,
    ownerOf,
    list: () => [...loaded.values()].map(describe),
    shutdown,
    // 供测试
    _ctx: ctx,
  }
}

module.exports = { createPluginHost }
