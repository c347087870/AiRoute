// 开发面板的数据源：`GET /api/dev/info`，只在开发模式下回数据。
//
// ## 为什么要单独开一个端点
//
// 面板要显示的东西一半是进程级的（PID / Node 版本 / 内存 / 数据目录 / 运行时文件清单 /
// 在途计数），分散在各模块里，前端自己拼要打七八个接口还拿不到；另一半（渠道运行时、
// WorkBuddy 池、失活台账、日志占用）虽然已有接口，但开发时要的是「一屏之内看到现在
// 到底在跑什么」，逐个请求反而更慢。
//
// ## 为什么必须显式判开发模式
//
// 这里回的是绝对路径、环境变量与文件清单 —— 对开发者有用，对用户手中的正式版只是
// 泄漏面。打包后的应用在主进程里先把 NODE_ENV 设成 production 再 require server
// （见 app/main/main.js），router 因此对正式版直接回 404，而不是靠界面把入口藏起来。

const fs = require('fs-extra')
const path = require('path')
const paths = require('./paths')
const logger = require('./logger')
const tokenStats = require('./token-stats')
const models = require('./models')
const engine = require('./router-engine')
const update = require('./update')
const autoStrategy = require('./auto-strategy')
const modelHealth = require('./model-health')
const modelHealthAudit = require('./model-health-audit')
const channels = require('./channels')
const workbuddy = require('./workbuddy/runtime')

// 数据目录顶层的运行时文件：只看名字、大小与修改时间。
// 开发时最常见的问题是「这个 json 到底写没写、是不是还在用旧的那份」，
// 名字 + 时间戳就够回答；内容一律不回 —— 里面有明文凭据。
const FILE_LIST_LIMIT = 40

// 只回显与本项目相关的环境变量：整份 process.env 里可能有 PATH、云厂商密钥之类
// 跟开发面板无关的东西，回显它们没有收益，只有风险。
const ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'AIROUTE_DATA_DIR',
  'AIROUTE_UPDATE_DIR',
  'AIROUTE_INSTALL_KIND',
  'AIROUTE_ELECTRON_SOURCE',
  'AIROUTE_CHANNEL_FIRST_CHUNK_TIMEOUT_MS'
]

/**
 * 当前进程是不是开发模式。
 *
 * 只认 NODE_ENV：打包后的正式版由主进程显式设为 production，其余情况
 * （`node server/router.js`、`pnpm dev`、e2e 起的网关）都算开发。
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function isDevMode(env = process.env) {
  return String(env.NODE_ENV || '') !== 'production'
}

function pickEnv(env = process.env) {
  const out = {}
  for (const key of ENV_KEYS) {
    if (env[key] !== undefined) out[key] = String(env[key])
  }
  return out
}

function listDataFiles() {
  const dir = paths.getDataDir()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return [] // 数据目录还不存在（首次启动迁移前）：空列表比报错有用
  }
  const rows = []
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (!stat.isFile()) continue
      rows.push({ name, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      /* 并发消失的文件忽略 */
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, FILE_LIST_LIMIT)
}

// 在途请求只看配置里真实存在的引用：auto 伪模型不参与计数，
// 而已经删掉的引用即使有残留计数也没有排查价值
function inFlightRows() {
  const rows = []
  for (const item of models.listModelRefs(models.getConfig())) {
    const count = autoStrategy.getInFlight(item.ref)
    if (count > 0) rows.push({ ref: item.ref, count })
  }
  return rows.sort((a, b) => b.count - a.count)
}

function channelSnapshot() {
  const rt = channels.getRuntime()
  if (!rt) return { ready: false, state: 'unavailable', error: '', providers: [], models: 0, plugins: [], pluginFailures: [] }
  const state = rt.state()
  return {
    ready: state.state === 'ready',
    state: state.state,
    error: state.error || '',
    providers: rt.providers || [],
    models: rt.publicModelRows().length,
    plugins: typeof rt.plugins === 'function' ? rt.plugins() : [],
    pluginFailures: typeof rt.pluginFailures === 'function' ? rt.pluginFailures() : []
  }
}

function workbuddySnapshot() {
  const rt = workbuddy.getRuntime()
  if (!rt) return { ready: false, counts: null }
  return { ready: true, counts: rt.pool.counts() }
}

function modelHealthSnapshot() {
  const records = modelHealth.list()
  const offline = records.filter(item => item.offline)
  return {
    records: records.length,
    offline: offline.length,
    // 界面直接展示这几条：阈值与审计间隔是「现在生效的规则」，
    // 开发时常常改了代码忘了重启，一屏就能看出跑的是哪套
    offlineAfterFailures: modelHealth.OFFLINE_AFTER_FAILURES,
    auditIntervalMs: modelHealthAudit.AUDIT_INTERVAL_MS,
    items: offline.slice(0, 30).map(item => ({
      ref: item.ref,
      reason: item.reason,
      detail: item.detail,
      since: item.since,
      failures: item.failures
    }))
  }
}

/**
 * 采集一屏开发信息。任何一项失败都不该让整份数据读不出来 —— 开发时
 * 「部分不可用」本身就是信息。
 */
function collect() {
  const memory = process.memoryUsage()
  const addr = engine.getServerConfig()
  return {
    ok: true,
    devMode: isDevMode(),
    server: {
      version: update.getLocalVersion(),
      port: addr.port || 3000,
      cwd: process.cwd()
    },
    process: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external
      },
      env: pickEnv()
    },
    dataDir: paths.getDataDir(),
    files: listDataFiles(),
    inFlight: inFlightRows(),
    channels: channelSnapshot(),
    workbuddy: workbuddySnapshot(),
    modelHealth: modelHealthSnapshot(),
    logs: logger.getTotalSize(),
    tokens: tokenStats.getRequestSummary()
  }
}

module.exports = { isDevMode, collect, ENV_KEYS, FILE_LIST_LIMIT }
