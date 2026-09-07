const fs = require('fs-extra')
const paths = require('./paths')

const CONFIG_PATH = paths.getConfigPath()

// 模型引用格式：providerName/modelId，斜杠为分隔符
const REF_SEP = '/'

// Provider 允许写入的字段白名单，防止任意字段落盘
const PROVIDER_TEXT_FIELDS = ['displayName', 'baseURL', 'openaiURL']

function getConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  try {
    const data = fs.readJsonSync(CONFIG_PATH)
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function saveConfig(config) {
  fs.writeJsonSync(CONFIG_PATH, config, { spaces: 2 })
}

// 空值或非正数一律视为"未配置"，返回 null
function toPositiveIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.floor(num)
}

function toModelView(raw) {
  if (typeof raw === 'string') {
    return { id: raw.trim(), displayName: '', maxContext: null, maxOutput: null }
  }
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) return null
  return {
    id,
    displayName: typeof raw.displayName === 'string' ? raw.displayName.trim() : '',
    maxContext: toPositiveIntOrNull(raw.maxContext),
    maxOutput: toPositiveIntOrNull(raw.maxOutput)
  }
}

// 归一化单个 Provider：老配置的顶层 model 字符串自动包装成 models 数组，读写不改写源文件
function toProviderView(raw) {
  if (!raw || typeof raw !== 'object') return null
  const view = { ...raw }
  delete view.model

  const rawModels = Array.isArray(raw.models) && raw.models.length
    ? raw.models
    : (typeof raw.model === 'string' && raw.model.trim() ? [{ id: raw.model }] : [])

  view.models = rawModels.map(toModelView).filter(Boolean)
  return view
}

// 解析引用字符串："glm/glm-4.6" → { providerName: 'glm', modelId: 'glm-4.6' }
// 无斜杠时视为老格式，modelId 为空表示"使用该 Provider 的默认模型"
function parseRef(ref) {
  if (!ref || typeof ref !== 'string') return null
  const trimmed = ref.trim()
  if (!trimmed) return null
  const idx = trimmed.indexOf(REF_SEP)
  if (idx === -1) return { providerName: trimmed, modelId: '' }
  return {
    providerName: trimmed.slice(0, idx),
    modelId: trimmed.slice(idx + 1)
  }
}

function makeRef(providerName, modelId) {
  return `${providerName}${REF_SEP}${modelId}`
}

// 把引用解析成可直接发起请求的对象，解析失败返回 null
function resolveRef(config, ref) {
  const parsed = parseRef(ref)
  if (!parsed) return null
  const raw = config[parsed.providerName]
  if (!raw) return null
  const provider = toProviderView(raw)
  if (!provider || !provider.models.length) return null

  const model = parsed.modelId
    ? provider.models.find(m => m.id === parsed.modelId) || null
    : provider.models[0]
  if (!model) return null

  return {
    ref: makeRef(parsed.providerName, model.id),
    providerName: parsed.providerName,
    modelId: model.id,
    provider: raw,
    model
  }
}

// 列出配置中所有可用模型引用，按 Provider 顺序展开
function listModelRefs(config) {
  const refs = []
  for (const [name, raw] of Object.entries(config)) {
    const provider = toProviderView(raw)
    if (!provider) continue
    for (const model of provider.models) {
      refs.push({
        ref: makeRef(name, model.id),
        providerName: name,
        providerDisplayName: provider.displayName || name,
        model
      })
    }
  }
  return refs
}

// 配置中第一个可用引用，用于清理悬空引用时兜底
function firstAvailableRef(config) {
  const refs = listModelRefs(config)
  return refs.length ? refs[0].ref : null
}

// 引用是否指向指定 Provider（无论是否带模型 ID）
function isRefOfProvider(ref, providerName) {
  const parsed = parseRef(ref)
  return !!parsed && parsed.providerName === providerName
}

// 清理路由规则中指向已删除 Provider 的引用，返回 { rules, customRules, changed }
function cleanupRuleRefs(rulesData, providerName) {
  const source = rulesData && typeof rulesData === 'object' ? rulesData : {}
  const rules = Array.isArray(source.rules) ? source.rules : []
  const customRules = Array.isArray(source.customRules) ? source.customRules : []
  let changed = false

  const keptRules = rules.filter(rule => {
    if (isRefOfProvider(rule?.target, providerName)) {
      changed = true
      return false
    }
    return true
  })

  const keptCustomRules = customRules.filter(rule => {
    if (isRefOfProvider(rule?.target, providerName)) {
      changed = true
      return false
    }
    return true
  })

  return { rules: keptRules, customRules: keptCustomRules, changed }
}

// 新增/更新 Provider 时过滤输入，只保留白名单字段
function sanitizeProviderInput(input) {
  const source = input && typeof input === 'object' ? input : {}
  const out = {}

  for (const field of PROVIDER_TEXT_FIELDS) {
    if (typeof source[field] === 'string') out[field] = source[field].trim()
  }
  // apiKey 为空表示保留原值，交由调用方处理
  if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
    out.apiKey = source.apiKey.trim()
  }
  if (Object.prototype.hasOwnProperty.call(source, 'models')) {
    out.models = sanitizeModels(source.models)
  }
  return out
}

// 模型列表整体替换，maxContext / maxOutput 未填写时不写入字段
function sanitizeModels(models) {
  if (!Array.isArray(models)) return []
  return models
    .map(raw => {
      const view = toModelView(raw)
      if (!view) return null
      const item = { id: view.id, displayName: view.displayName }
      if (view.maxContext !== null) item.maxContext = view.maxContext
      if (view.maxOutput !== null) item.maxOutput = view.maxOutput
      return item
    })
    .filter(Boolean)
}

// /api/providers 返回的安全副本，apiKey 脱敏
function toSafeConfig(config) {
  const safe = {}
  for (const [name, raw] of Object.entries(config)) {
    const view = toProviderView(raw)
    if (!view) continue
    view.apiKey = view.apiKey ? '••••••••' : ''
    safe[name] = view
  }
  return safe
}

module.exports = {
  getConfig,
  saveConfig,
  toProviderView,
  toModelView,
  parseRef,
  makeRef,
  resolveRef,
  listModelRefs,
  firstAvailableRef,
  isRefOfProvider,
  cleanupRuleRefs,
  sanitizeProviderInput,
  sanitizeModels,
  toSafeConfig,
  toPositiveIntOrNull
}
