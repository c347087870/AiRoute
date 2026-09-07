const fs = require('fs-extra')
const paths = require('./paths')

const RULES_PATH = paths.getRulesPath()

// 长上下文判定阈值：按字符数粗估，中文约 1.5 字符/token，留给纯文本对话约 8k token 以上
const LONG_CONTEXT_CHARS = 12000

// 仅 ASCII 关键词才使用 \b 边界；中文不属于 \w，加 \b 会导致关键词永远匹配不上
const ASCII_KEYWORD_RE = /^[\x20-\x7E]+$/

function getRules() {
  if (!fs.existsSync(RULES_PATH)) return { rules: [], customRules: [] }
  try {
    const data = fs.readJsonSync(RULES_PATH)
    return {
      rules: Array.isArray(data.rules) ? data.rules : [],
      customRules: Array.isArray(data.customRules) ? data.customRules : []
    }
  } catch {
    return { rules: [], customRules: [] }
  }
}

function saveRules(rules) {
  fs.writeJsonSync(RULES_PATH, {
    rules: Array.isArray(rules?.rules) ? rules.rules : [],
    customRules: Array.isArray(rules?.customRules) ? rules.customRules : []
  }, { spaces: 2 })
}

function getCustomRules() {
  return getRules().customRules
}

function getServerConfig() {
  const configPath = paths.getServerConfigPath()
  if (!fs.existsSync(configPath)) return { port: 3000 }
  try {
    return fs.readJsonSync(configPath)
  } catch {
    return { port: 3000 }
  }
}

function saveServerConfig(config) {
  fs.writeJsonSync(paths.getServerConfigPath(), config, { spaces: 2 })
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 关键词匹配：英文关键词保留单词边界，中文关键词直接子串匹配
function containsKeyword(content, keyword) {
  if (!keyword) return false
  if (ASCII_KEYWORD_RE.test(keyword)) {
    return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i').test(content)
  }
  return content.includes(keyword)
}

function containsAny(content, keywords) {
  return keywords.some(keyword => containsKeyword(content, keyword))
}

function getLastUserMessage(body) {
  const messages = body?.messages || []
  // 从后往前找最后一条 role === 'user' 的消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join(' ')
    return ''
  }
  return ''
}

// 估算整轮对话的输入规模，用于长上下文判定
function estimateInputChars(body) {
  const messages = body?.messages || []
  let total = 0
  for (const m of messages) {
    if (typeof m.content === 'string') total += m.content.length
    else if (Array.isArray(m.content)) total += m.content.map(c => c.text || '').join('').length
  }
  return total
}

// 检测请求命中的条件类型
// 判断顺序为：具体任务优先于语种兜底，否则中文请求会被 lang_zh 提前吞掉
function detectCondition(body) {
  const content = getLastUserMessage(body)

  // 自定义规则优先匹配（只匹配最后一条用户消息）
  // 复用 containsKeyword，英文关键词带单词边界，避免 go 命中 google 之类的误匹配
  for (const rule of getCustomRules()) {
    if (rule.keyword && containsKeyword(content, rule.keyword)) {
      return `custom:${rule.keyword}`
    }
  }

  if (content.match(/```[\s\S]{20,}```/) || content.match(/\b(function|const|let|var|import|class|def|return|async|await)\b/)) {
    return 'contains_code'
  }

  if (content.match(/[\u4e00-\u9fff]{2,}/) && content.match(/\b(select|insert|update|delete|create|alter|drop|database|table)\b/i)) {
    return 'contains_sql'
  }

  if (containsAny(content, ['translate', '翻译', '英译中', '中译英', '翻成', '译成', '译文'])) {
    return 'translate'
  }

  if (containsAny(content, ['review', 'code review', '审查', '优化', '重构', 'refactor', '改进', 'bug', 'fix', '修复', 'debug'])) {
    return 'code_review'
  }

  if (containsAny(content, ['unit test', '单元测试', '写测试', '测试用例', 'jest', 'mocha', 'pytest'])) {
    return 'write_test'
  }

  if (containsAny(content, ['math', '数学', '计算', '公式', '证明', 'proof', 'equation', '积分', '微分', '概率', '统计', '代数'])) {
    return 'math_task'
  }

  if (containsAny(content, ['summarize', '总结', '摘要', '概括', '归纳', '简述'])) {
    return 'summarize'
  }

  if (containsAny(content, ['write', 'essay', 'article', 'story', '撰写', '写一', '作文', '文章', '博客', '小说'])) {
    return 'creative_writing'
  }

  if (containsAny(content, ['explain', '解释', '说明', '什么是', '如何理解', 'tell me about'])) {
    return 'knowledge_query'
  }

  // 长上下文放在语种兜底之前，避免被 lang_zh 抢走
  if (estimateInputChars(body) >= LONG_CONTEXT_CHARS) {
    return 'long_context'
  }

  // 语种意图比"内容是中文"更具体，需排在 lang_zh 之前，否则中文语境下永远不可达
  if (containsAny(content, ['english', '英语', '英文'])) {
    return 'lang_en_request'
  }

  const zhChars = (content.match(/[\u4e00-\u9fff]/g) || []).length
  if (zhChars > content.length * 0.15) {
    return 'lang_zh'
  }

  return 'default'
}

function resolveModel(body) {
  const rules = getRules()
  const condition = detectCondition(body)

  if (condition.startsWith('custom:')) {
    const keyword = condition.slice(7)
    const customRule = rules.customRules.find(r => r.keyword === keyword)
    if (customRule) return customRule.target
  }

  for (const rule of rules.rules) {
    if (rule.condition === condition) {
      return rule.target
    }
  }

  const defaultRule = rules.rules.find(r => r.condition === 'default')
  return defaultRule ? defaultRule.target : null
}

module.exports = { resolveModel, getRules, saveRules, detectCondition, getServerConfig, saveServerConfig, getCustomRules }
