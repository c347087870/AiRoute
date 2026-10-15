// 模型引用格式为 providerName/modelId
// 无斜杠的写法视为老配置，表示使用该 Provider 的默认模型（第一个）

export const AUTO_MODEL = 'auto'

// 解析引用字符串为 { providerName, modelId }，modelId 为空表示默认模型
export function parseModelRef(ref) {
  if (!ref || typeof ref !== 'string') return null
  const idx = ref.indexOf('/')
  if (idx === -1) return { providerName: ref, modelId: '' }
  return { providerName: ref.slice(0, idx), modelId: ref.slice(idx + 1) }
}

// 取引用对应的 Provider，找不到返回 null
export function findProvider(providers, ref) {
  const parsed = parseModelRef(ref)
  if (!parsed) return null
  return providers?.[parsed.providerName] || null
}

// 取引用对应的模型配置，找不到返回 null
export function findModel(providers, ref) {
  const parsed = parseModelRef(ref)
  const provider = findProvider(providers, ref)
  if (!parsed || !provider) return null
  const models = provider.models || []
  if (!parsed.modelId) return models[0] || null
  return models.find(m => m.id === parsed.modelId) || null
}

// 引用的展示名：Provider 显示名 / 模型显示名，解析不到时退回原始引用
export function resolveRefLabel(providers, ref) {
  if (!ref) return '-'
  if (ref === AUTO_MODEL) return 'Auto (智能路由)'

  const parsed = parseModelRef(ref)
  const provider = findProvider(providers, ref)
  if (!parsed) return ref
  if (!provider) return ref

  const providerLabel = providerLabelOf(providers, parsed.providerName)
  const model = findModel(providers, ref)
  if (!model) return parsed.modelId ? `${providerLabel} / ${parsed.modelId}` : providerLabel

  return `${providerLabel} / ${model.displayName || model.id}`
}

// Provider 的展示名（附带区域后缀）。
// WorkBuddy 国内版与国际版是两个独立源，用户可能给它们起同样的显示名
// （甚至都用默认的「WorkBuddy 账号池」），此时下拉/托盘会出现两个无法区分的分组。
// 这里给国际版补一个区域后缀；国内版是默认区域不加（避免噪音）。
// 显示名里已含区域字样时不重复追加。
export function providerRegionSuffix(provider) {
  if (!provider || provider.type !== 'workbuddy') return ''
  if (provider.region !== 'global') return ''
  const name = String(provider.displayName || '')
  if (name.includes('国际版') || /global/i.test(name)) return ''
  return '（国际版）'
}

// Provider 展示名 = displayName（或 name）+ 区域后缀
export function providerLabelOf(providers, name) {
  const provider = providers?.[name]
  const base = (provider && provider.displayName) || name
  return `${base}${providerRegionSuffix(provider)}`
}

// 按 Provider 分组的模型选项，供 select 的 optgroup 使用
export function buildModelGroups(providers) {
  const groups = []

  for (const [name, provider] of Object.entries(providers || {})) {
    const models = provider.models || []
    if (!models.length) continue
    groups.push({
      label: providerLabelOf(providers, name),
      options: models.map(model => ({
        value: `${name}/${model.id}`,
        label: model.displayName || model.id,
        maxContext: model.maxContext ?? null,
        maxOutput: model.maxOutput ?? null
      }))
    })
  }

  return groups
}

// 扁平化的模型列表，每项含完整上下文信息
export function listModels(providers) {
  const list = []

  for (const [name, provider] of Object.entries(providers || {})) {
    for (const model of provider.models || []) {
      list.push({
        ref: `${name}/${model.id}`,
        providerName: name,
        providerLabel: providerLabelOf(providers, name),
        model
      })
    }
  }

  return list
}

// 判断引用是否在配置中仍然有效
export function isValidRef(providers, ref) {
  if (!ref || ref === AUTO_MODEL) return true
  return !!findModel(providers, ref)
}
