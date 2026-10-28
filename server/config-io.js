// 配置导入导出：把「换台机器还能接着用」的东西打成一个 JSON 文件。
//
// 包含模型来源（含明文 apiKey）、路由规则、兜底与被激活模型、服务端设置，以及
// WorkBuddy 与免费渠道的账号凭据 —— 因此导出文件等价于一份完整备份，不能外传。
// 日志、Token 统计、积分历史、评测记录属于历史数据而非配置，不在其中。
//
// 导入是覆盖式的：写入前先把当前配置快照到 data/config-backups/，写坏了可以回滚。

const fs = require('fs-extra')
const path = require('path')
const paths = require('./paths')
const update = require('./update')

const FORMAT = 'airoute-config'
const VERSION = 1
const BACKUP_DIR = 'config-backups'
const BACKUP_KEEP = 5 // 只留最近几份，避免每导入一次就多一份带明文凭据的文件

// 单文件配置：key 与导出 JSON 里的字段同名，缺文件时用 fallback
const CONFIG_FILES = [
  { key: 'models', file: 'models.json', fallback: {} },
  { key: 'rules', file: 'rules.json', fallback: { rules: [], customRules: [] } },
  { key: 'fallback', file: 'fallback.json', fallback: { model: '' } },
  { key: 'state', file: 'state.json', fallback: { current: 'auto' } },
  { key: 'server', file: 'server-config.json', fallback: { port: 3000 } }
]

// 账号目录：整棵目录一起搬（凭据、冷却状态、签到与积分流水都落在里面）
const ACCOUNT_DIRS = [
  { key: 'workbuddy', dir: 'workbuddy-auths' },
  { key: 'channels', dir: 'channels-data' }
]

// 读文件：JSON 原样还原成对象，非 JSON（理论上没有）按文本带走
function readFileValue(file) {
  const text = fs.readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function readJsonOr(file, fallback) {
  try {
    return fs.readJsonSync(file)
  } catch {
    return fallback
  }
}

// 递归读目录成 { '相对路径': 内容 }，路径统一用 /，跨平台导入时不用关心分隔符
function readTree(dir) {
  const out = {}
  if (!fs.existsSync(dir)) return out
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) out[relative] = readFileValue(absolute)
    }
  }
  walk(dir, '')
  return out
}

// 校验相对路径不含 .. —— 导入文件可能被手工改过，不能让它写到数据目录之外
function assertSafeRelative(relative) {
  const normalized = path.normalize(String(relative)).replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`账号数据包含非法路径: ${relative}`)
  }
  return normalized
}

// 导出快照：config 是各配置文件内容，accounts 是账号目录整棵树
function exportAll() {
  const dataDir = paths.getDataDir()
  const config = {}
  for (const entry of CONFIG_FILES) {
    config[entry.key] = readJsonOr(path.join(dataDir, entry.file), entry.fallback)
  }
  const accounts = {}
  for (const entry of ACCOUNT_DIRS) {
    accounts[entry.key] = readTree(path.join(dataDir, entry.dir))
  }
  return {
    format: FORMAT,
    version: VERSION,
    appVersion: update.getLocalVersion(),
    exportedAt: new Date().toISOString(),
    config,
    accounts
  }
}

// 导入前快照：与导出同格式，出问题时可以直接回滚，也可以当普通导出文件再导入
function writeBackup(snapshot, dataDir) {
  const dir = path.join(dataDir, BACKUP_DIR)
  fs.ensureDirSync(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `config-backup-${stamp}.json`)
  fs.writeJsonSync(file, snapshot, { spaces: 2 })

  // 只保留最近 BACKUP_KEEP 份（文件名带时间戳，字典序即时间序）
  const backups = fs.readdirSync(dir)
    .filter(name => /^config-backup-.*\.json$/.test(name))
    .sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
    fs.removeSync(path.join(dir, name))
  }
  return file
}

function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('文件内容不是有效的配置对象')
  }
  if (payload.format !== FORMAT) {
    throw new Error('不是 AiRoute 配置文件')
  }
  const version = Number(payload.version)
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('配置文件版本无效')
  }
  if (version > VERSION) {
    throw new Error(`配置文件来自更新的版本（v${version}），请先升级 AiRoute`)
  }

  const config = payload.config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('配置文件缺少 config 字段')
  }
  // 没有模型来源的配置导入后整个服务都不可用，直接拒绝而不是留个空壳
  if (!config.models || typeof config.models !== 'object' || Array.isArray(config.models)) {
    throw new Error('配置文件缺少模型来源（config.models）')
  }
  const port = config.server?.port
  if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('配置里的端口必须是 1-65535 的整数')
  }
  // 激活模型引用落盘后每次请求都要解析，写进非法值会让整个网关 500
  const current = config.state?.current
  if (current !== undefined && (typeof current !== 'string' || !current.trim())) {
    throw new Error('配置里的当前模型（config.state.current）格式不正确')
  }
  const fallbackModel = config.fallback?.model
  if (fallbackModel !== undefined && typeof fallbackModel !== 'string') {
    throw new Error('配置里的兜底模型（config.fallback.model）格式不正确')
  }

  const accounts = payload.accounts
  if (accounts !== undefined && (!accounts || typeof accounts !== 'object' || Array.isArray(accounts))) {
    throw new Error('配置文件里的 accounts 字段格式不正确')
  }
  for (const entry of ACCOUNT_DIRS) {
    const files = accounts?.[entry.key]
    if (!files || typeof files !== 'object' || Array.isArray(files)) continue
    // 路径先全部校验一遍：写了一半才发现非法路径，回滚代价更大
    for (const relative of Object.keys(files)) assertSafeRelative(relative)
  }
}

// 把快照写回数据目录：导入中途失败时整体回滚，避免一半新一半旧
function restoreSnapshot(snapshot) {
  const dataDir = paths.getDataDir()
  for (const entry of CONFIG_FILES) {
    const value = snapshot.config?.[entry.key]
    if (value === undefined) continue
    fs.writeJsonSync(path.join(dataDir, entry.file), value, { spaces: 2 })
  }
  for (const entry of ACCOUNT_DIRS) {
    const files = snapshot.accounts?.[entry.key]
    if (!files || typeof files !== 'object') continue
    const dir = path.join(dataDir, entry.dir)
    fs.removeSync(dir)
    writeTree(dir, files)
  }
}

function writeTree(dir, files) {
  fs.ensureDirSync(dir)
  for (const [relative, value] of Object.entries(files)) {
    const target = path.join(dir, assertSafeRelative(relative))
    fs.ensureDirSync(path.dirname(target))
    if (typeof value === 'string') fs.writeFileSync(target, value)
    else fs.writeJsonSync(target, value, { spaces: 2 })
  }
}

// 导入：整体覆盖。accounts 里没出现的账号目录保持原样（老版本导出文件没有账号部分）
function importAll(payload) {
  validate(payload)
  const dataDir = paths.getDataDir()
  const snapshot = exportAll()
  const backupFile = writeBackup(snapshot, dataDir)

  const replaced = []
  try {
    for (const entry of CONFIG_FILES) {
      const value = payload.config[entry.key]
      if (value === undefined) continue
      fs.writeJsonSync(path.join(dataDir, entry.file), value, { spaces: 2 })
      replaced.push(entry.file)
    }
    for (const entry of ACCOUNT_DIRS) {
      const files = payload.accounts?.[entry.key]
      if (!files || typeof files !== 'object') continue
      const dir = path.join(dataDir, entry.dir)
      fs.removeSync(dir)
      writeTree(dir, files)
      replaced.push(entry.dir)
    }
  } catch (err) {
    try {
      restoreSnapshot(snapshot)
    } catch (rollbackError) {
      // 回滚也失败时把两份错误都带出去，至少备份文件还在
      throw new Error(`导入失败（${err.message}），回滚也失败（${rollbackError.message}），`
        + `当前配置快照：${backupFile}`)
    }
    throw new Error(`导入失败（${err.message}），已回滚到导入前的配置`)
  }

  return { ok: true, backupFile, replaced }
}

// 清空配置：抹掉模型来源、路由规则、兜底、激活模型与全部账号凭据，
// 服务端设置（端口等）保留。清空前先打一份快照，可再导入回来。
function clearAll() {
  const dataDir = paths.getDataDir()
  const backupFile = writeBackup(exportAll(), dataDir)

  for (const entry of CONFIG_FILES) {
    if (entry.key === 'server') continue
    fs.writeJsonSync(path.join(dataDir, entry.file), entry.fallback, { spaces: 2 })
  }
  for (const entry of ACCOUNT_DIRS) {
    fs.removeSync(path.join(dataDir, entry.dir))
  }
  return { ok: true, backupFile }
}

module.exports = {
  FORMAT,
  VERSION,
  exportAll,
  importAll,
  clearAll
}
