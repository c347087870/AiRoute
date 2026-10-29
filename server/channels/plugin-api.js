// 渠道插件的宿主 API（插件作者唯一该依赖的东西）
//
// 为什么要有这一层：插件包是从「宿主代码」里搬出来的，它不该再去 require
// `server/channels/shared/*` —— 那等于绕过宿主直接读凭据文件与端口。
// 宿主在这里把能力**显式交出去**，插件只认这个对象：
//
//   ctx.dataDir      数据目录（账号注册表、状态都写这里，与宿主同源）
//   ctx.logger       { info, warn, error }
//   ctx.credentials  凭据读写（shared/accounts 的那一套，语义见下）
//   ctx.loginServer  本地登录回调服务（浏览器 302 回来的那个端口）
//   ctx.settings     渠道运行参数（冷却/并发/选号，面板内页可改；见 settings.js）
//   ctx.versions     官网版本号同步器（get() 返回 { trae:{appVersion,pluginVersion}, qoder:{appVersion} }）
//
// 插件拿到的是**函数**，不是路径：换存储实现时插件不用改。

const { createLoginServer } = require('./shared/login-server')
const accounts = require('./shared/accounts')

// 凭据服务：插件的账号凭据一律走这里落盘。
//
// 键名规则（与渠道包时代一致）是硬约束，不是实现细节：账号 id 的后缀取自
// 凭据键名，重算 hash 会让迁移过来的账号读不到凭据（见 NOTICE.md）。
const credentialsApi = accounts

function createPluginContext({ dataDir, logger = console, login = createLoginServer({ logger }), settings, versions } = {}) {
  if (!dataDir) throw new Error('插件上下文缺少 dataDir')
  const FALLBACK_VERSIONS = {
    updatedAt: 0,
    sources: {},
    trae: { appVersion: '3.4.9', pluginVersion: '2.3.97430' },
    qoder: { appVersion: '0.4.11' },
  }
  return {
    dataDir,
    logger,
    credentials: credentialsApi,
    loginServer: login,
    // 缺省给一份只读默认值：插件在测试里被单独实例化时不该因为少这个参数炸掉
    settings: settings || { get: () => ({}), update: () => ({}) },
    versions: versions || { get: () => FALLBACK_VERSIONS },
  }
}

// 插件后端必须实现的形状。宿主只按这张表调用，多出来的方法宿主不会去猜。
//
// 所有以 provider 开头的方法都带 `provider` 作为第一参数：一个插件可以同时提供
// 多个 provider（Qoder 国际版 / 国内版就是一个包两个 provider），
// 让插件自己按 provider 分派，比让宿主拼一张「provider → 插件」的转发表更少出错。
const REQUIRED_METHODS = ['listAccounts', 'listModels', 'complete']

// 可选方法：没有就是「这家不支持」，宿主据此给出「未开通」而不是必然失败的按钮
const OPTIONAL_METHODS = [
  'updateAccount', 'removeAccount', 'importLegacy',
  'startLogin', 'pollLogin', 'setEvents', 'shutdown',
  'checkin', 'balance', 'refresh', 'refreshAccount',
]

function validateBackend(id, backend) {
  if (!backend || typeof backend !== 'object') throw new Error(`插件 ${id} 的 create() 没有返回对象`)
  const providers = Array.isArray(backend.providers) ? backend.providers.filter(item => typeof item === 'string' && item) : []
  if (providers.length === 0) throw new Error(`插件 ${id} 没有声明 providers`)
  for (const method of REQUIRED_METHODS) {
    if (typeof backend[method] !== 'function') throw new Error(`插件 ${id} 缺少必需方法 ${method}()`)
  }
  return { ...backend, providers }
}

module.exports = {
  createPluginContext,
  validateBackend,
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
}
