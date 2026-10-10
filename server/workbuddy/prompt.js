// 系统提示词体系：出站前替换/追加网关自有 system 提示词，从源头消灭 system 来源的指纹误报

const fs = require('fs')

// 内置默认提示词（约 2KB）
const DEFAULT_PROMPT = `# 系统提示词

你是一名工程助手，帮助用户完成软件工程任务。以下原则指导你的行为。

## 核心立场
- 你的价值是让用户的工程目标更快达成，而非展示你自己的能力边界。
- 当用户的方向有更优解时，直接指出并给出替代方案；不必逢迎。
- 对不确定的事保持诚实：宁可说"我不确定，需要验证"，也不编造看似合理的答案。

## 语言与风格
- 跟随用户的提问语言：用户用中文则用中文，用英文则用英文。
- 简洁直接，不说废话；不用客套开场与总结，不重复用户已说过的内容。
- 技术术语精确，不为了通俗而牺牲准确性。

## 工程行为
- 先看代码再动手：理解上下文、既有模式与约定，避免破坏一致性。
- 最小改动：只改必要的部分，不做无关重构或风格统一。
- 改动后验证闭环：运行测试或构建确认结果，不假设"应该没问题"。
- 遇到不确定的边界，先确认再执行，不擅自扩大范围或假设需求。
- 修改共享代码前，先看它被谁依赖，避免连锁影响。

## 任务分解
- 复杂任务先拆步骤，按依赖顺序推进；每步可独立验证。
- 给出改动清单与影响面，让用户能判断是否继续。
- 失败时如实报告原因，给出下一步建议，不掩盖、不粉饰。

## 输出格式
- 用 Markdown 组织结构。
- 代码块标注语言（\`\`\`go / \`\`\`bash / \`\`\`json 等）。
- 复杂度与任务匹配：简单问题一句话答完，复杂问题分步骤说明。
- 关键决策给出依据，不堆砌理由；不写你已经知道答案却还要绕的解释。
- 引用代码时用 \`file:line\` 形式，便于用户跳转。

## 边界
- 不臆造未给定的 API、字段或行为；不确定时如实说明并给出验证路径。
- 安全敏感操作（删除、覆盖、发布）先确认，除非已被明确授权。
- 错误与失败如实报告，不为了让结果"好看"而省略或美化。
- 保留对方案的质疑空间：如果用户的方案有明显问题，指出并提供更优替代。`

// 降级中性提示词（误报处理专用，刻意极简中性）
const DEGRADED_PROMPT =
  "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise."

// 加载提示词文本：文件为空用内置默认；路径非空但不可读 → 抛错（启动 fail fast）
function loadPrompt(file) {
  if (!file) return DEFAULT_PROMPT
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`提示词文件不可读 ${file}: ${err.message}`)
  }
}

// 公共守卫：空 body / 空提示词 / 坏 JSON 一律原样返回，绝不阻塞转发
function parseBody(body, systemPrompt) {
  if (!body || !systemPrompt) return null
  try {
    const obj = JSON.parse(body)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    return obj
  } catch {
    return null
  }
}

// custom 模式（替换型）：删除所有 system/developer 消息，头部插入网关 system
function rewrite(body, systemPrompt) {
  const obj = parseBody(body, systemPrompt)
  if (!obj) return body

  if (!Array.isArray(obj.messages)) {
    obj.messages = [{ role: 'system', content: systemPrompt }]
    return JSON.stringify(obj)
  }

  const kept = []
  for (const m of obj.messages) {
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const role = typeof m.role === 'string' ? m.role : ''
      if (role === 'system' || role === 'developer') continue
    }
    kept.push(m)
  }
  obj.messages = [{ role: 'system', content: systemPrompt }, ...kept]
  return JSON.stringify(obj)
}

// append 模式（追加型）：扫描开头连续 system/developer 块，在其后插入网关 system，既有消息逐字不动
function append(body, systemPrompt) {
  const obj = parseBody(body, systemPrompt)
  if (!obj) return body

  if (!Array.isArray(obj.messages)) {
    obj.messages = [{ role: 'system', content: systemPrompt }]
    return JSON.stringify(obj)
  }

  let insertAt = 0
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) break
    const role = typeof m.role === 'string' ? m.role : ''
    if (role !== 'system' && role !== 'developer') break
    insertAt++
  }

  obj.messages = [
    ...obj.messages.slice(0, insertAt),
    { role: 'system', content: systemPrompt },
    ...obj.messages.slice(insertAt)
  ]
  return JSON.stringify(obj)
}

// 降级态门闩：内存态，触发后持续到次日 00:00 CST，不续期
let degradeUntil = 0

// 计算 now 之后最近的 CST（固定 +08:00）00:00
function nextMidnightCST(nowMs) {
  const CST_OFFSET_MS = 8 * 60 * 60 * 1000
  const cstNow = new Date(nowMs + CST_OFFSET_MS)
  const y = cstNow.getUTCFullYear()
  const m = cstNow.getUTCMonth()
  const d = cstNow.getUTCDate()
  let midnight = Date.UTC(y, m, d, 0, 0, 0, 0) - CST_OFFSET_MS
  while (midnight <= nowMs) midnight += 24 * 60 * 60 * 1000
  return midnight
}

// 当前是否处于降级期
function degradeActive() {
  return Date.now() < degradeUntil
}

// 触发降级（已在降级期内不续期）
function degradeTrigger() {
  if (!(Date.now() < degradeUntil)) degradeUntil = nextMidnightCST(Date.now())
}

// 按模式裁决出站 body 改写：custom 替换 / append 追加 / passthrough 透传；降级期 append 与 passthrough 均退化为替换
function applyPromptMode(body, mode, promptText) {
  let degradedApplied = false
  let out = body

  if (mode === 'custom' && promptText) {
    out = rewrite(body, promptText)
  } else if (mode === 'append' && promptText && !degradeActive()) {
    out = append(body, promptText)
  } else if ((mode === 'passthrough' || mode === 'append') && degradeActive()) {
    out = rewrite(body, DEGRADED_PROMPT)
    degradedApplied = true
  }

  return { body: out, degradedApplied }
}

module.exports = {
  DEFAULT_PROMPT,
  DEGRADED_PROMPT,
  loadPrompt,
  rewrite,
  append,
  applyPromptMode,
  degradeActive,
  degradeTrigger,
  nextMidnightCST
}