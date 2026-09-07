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

  const providerLabel = provider.displayName || parsed.providerName
  const model = findModel(providers, ref)
  if (!model) return parsed.modelId ? `${providerLabel} / ${parsed.modelId}` : providerLabel

  return `${providerLabel} / ${model.displayName || model.id}`
}

// 按 Provider 分组的模型选项，供 select 的 optgroup 使用
export function buildModelGroups(providers) {
  const groups = []

  for (const [name, provider] of Object.entries(providers || {})) {
    const models = provider.models || []
    if (!models.length) continue
    groups.push({
      label: provider.displayName || name,
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
        providerLabel: provider.displayName || name,
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
