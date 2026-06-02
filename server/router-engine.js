const fs = require('fs-extra')
const path = require('path')

const DATA_DIR = process.env.AIROUTE_DATA_DIR || __dirname
const RULES_PATH = path.join(DATA_DIR, 'rules.json')

function getRules() {
  return fs.readJsonSync(RULES_PATH)
}

function saveRules(rules) {
  fs.writeJsonSync(RULES_PATH, rules, { spaces: 2 })
}

function getCustomRules() {
  const data = getRules()
  return data.customRules || []
}

function getServerConfig() {
  const configPath = path.join(DATA_DIR, 'server-config.json')
  if (!fs.existsSync(configPath)) return { port: 3000 }
  return fs.readJsonSync(configPath)
}

function saveServerConfig(config) {
  const configPath = path.join(DATA_DIR, 'server-config.json')
  fs.writeJsonSync(configPath, config, { spaces: 2 })
}

// 获取最后一条用户消息的纯文本，仅用于智能路由匹配
function getLastUserMessage(body) {
  const messages = body.messages || []
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

function detectCondition(body) {
  const content = getLastUserMessage(body)

  // 自定义规则优先匹配（只匹配最后一条用户消息）
  const customRules = getCustomRules()
  for (const rule of customRules) {
    if (rule.keyword && content.includes(rule.keyword)) {
      return `custom:${rule.keyword}`
    }
  }

  if (content.match(/```[\s\S]{20,}```/) || content.match(/\b(function|const|let|var|import|class|def|return|async|await)\b/)) {
    return 'contains_code'
  }

  if (content.match(/[\u4e00-\u9fff]{2,}/) && content.match(/\b(select|insert|update|delete|create|alter|drop|database|table)\b/i)) {
    return 'contains_sql'
  }

  const zhChars = (content.match(/[\u4e00-\u9fff]/g) || []).length
  if (zhChars > content.length * 0.15) {
    return 'lang_zh'
  }

  if (content.match(/\b(英语|英文|translate|翻[译]|English)\b/i)) {
    return 'lang_en_request'
  }

  if (content.match(/\b(explain|解释|说明|什么是|如何理解|帮我理解|tell me about)\b/i)) {
    return 'knowledge_query'
  }

  if (content.match(/\b(write|撰写|写一[篇个]|作文|essay|article|文章|blog|博客|小说|story)\b/i)) {
    return 'creative_writing'
  }

  if (content.match(/\b(math|数学|计算|公式|证明|proof|equation|积分|微分|概率|统计|代数)\b/i)) {
    return 'math_task'
  }

  if (content.match(/\b(summarize|总结|摘要|概括|归纳|简述)\b/i)) {
    return 'summarize'
  }

  if (content.match(/\b(translate|翻译|英译中|中译英|翻成)\b/i)) {
    return 'translate'
  }

  if (content.match(/\b(review|审查|code review|优化|重构|refactor|改进|bug|fix|修复|debug)\b/i)) {
    return 'code_review'
  }

  if (content.match(/\b(test|测试|单元测试|unit test|jest|mocha|pytest|写.*测试)\b/i)) {
    return 'write_test'
  }

  if (content.match(/\b(answ|问答|Q&A|FAQ|chatbot|机器人|对话|对话系统)\b/i)) {
    return 'chatbot_task'
  }

  return 'default'
}

function resolveModel(body) {
  const rules = getRules()
  const condition = detectCondition(body)

  if (condition.startsWith('custom:')) {
    const keyword = condition.slice(7)
    const customRules = getCustomRules()
    const customRule = customRules.find(r => r.keyword === keyword)
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
