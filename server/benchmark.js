const fs = require('fs-extra')
const path = require('path')
const axios = require('axios')
const paths = require('./paths')
const models = require('./models')
const upstream = require('./upstream')

// 内置种子题库随代码发布；运行时题库放在数据目录，用户可自由编辑，两者互不影响
const SEED_QUESTIONS_FILE = path.join(__dirname, 'questions.json')
const QUESTIONS_FILE = path.join(paths.getDataDir(), 'benchmark-questions.json')
const RUNS_FILE = path.join(paths.getDataDir(), 'benchmark-runs.json')

const SCORING_MODES = ['exact', 'contains', 'regex', 'json', 'llm']
const MAX_RUNS = 20 // 历史评测记录保留条数
const DEFAULT_MAX_TOKENS = 2048

// 当前正在执行的评测任务，同一时刻只允许一个
let currentRun = null

function pad2(value) {
  return String(value).padStart(2, '0')
}

function round2(value) {
  return Math.round(value * 100) / 100
}

// ==================== 题库读写 ====================

function emptyBank() {
  return { version: 1, name: '题库', questions: [] }
}

// 首次运行时从内置种子题库复制一份到数据目录
function loadQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    try {
      const seed = fs.readJsonSync(SEED_QUESTIONS_FILE)
      fs.writeJsonSync(QUESTIONS_FILE, seed, { spaces: 2 })
      return seed
    } catch {
      return emptyBank()
    }
  }
  try {
    const data = fs.readJsonSync(QUESTIONS_FILE)
    return {
      version: data?.version || 1,
      name: data?.name || '题库',
      description: data?.description || '',
      questions: Array.isArray(data?.questions) ? data.questions : []
    }
  } catch {
    return emptyBank()
  }
}

function saveQuestions(bank) {
  fs.writeJsonSync(QUESTIONS_FILE, bank, { spaces: 2 })
}

function clampScore(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 5
  return Math.min(100, Math.round(num))
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {}
  const allowed = ['string', 'number', 'boolean', 'object', 'array']
  const out = {}
  for (const [key, type] of Object.entries(schema)) {
    if (allowed.includes(type)) out[key] = type
  }
  return out
}

// 把外部传入的题目规范化，缺字段补默认、非法评分模式降级为 contains
function normalizeQuestion(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const prompt = String(raw.prompt || '').trim()
  if (!prompt) return null

  const scoring = raw.scoring && typeof raw.scoring === 'object' ? raw.scoring : {}
  const mode = SCORING_MODES.includes(scoring.mode) ? scoring.mode : 'contains'
  const maxScore = clampScore(scoring.maxScore)

  const item = {
    id: String(raw.id || `q-${index + 1}`).trim() || `q-${index + 1}`,
    category: String(raw.category || '未分类').trim() || '未分类',
    title: String(raw.title || '').trim(),
    prompt,
    scoring: { mode, maxScore }
  }

  if (mode === 'exact') {
    item.scoring.answer = String(scoring.answer ?? '')
  } else if (mode === 'contains') {
    item.scoring.keywords = Array.isArray(scoring.keywords)
      ? scoring.keywords.map(k => String(k)).filter(Boolean)
      : []
  } else if (mode === 'regex') {
    item.scoring.pattern = String(scoring.pattern || '')
    item.scoring.flags = String(scoring.flags || 'i')
  } else if (mode === 'json') {
    item.scoring.schema = normalizeSchema(scoring.schema)
  } else if (mode === 'llm') {
    item.scoring.rubric = String(scoring.rubric || '').trim()
  }

  if (Number.isFinite(Number(raw.maxTokens)) && Number(raw.maxTokens) > 0) {
    item.maxTokens = Math.floor(Number(raw.maxTokens))
  }

  return item
}

// 导入题库，mode 为 replace（整体替换）或 append（追加，ID 冲突自动改名）
function importQuestions(payload, mode = 'replace') {
  const incoming = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.questions) ? payload.questions : null)
  if (!incoming) throw new Error('题库格式不正确：需要数组或含 questions 字段的对象')

  const normalized = incoming.map(normalizeQuestion).filter(Boolean)
  if (!normalized.length) throw new Error('题库中没有有效的题目（每题至少要有 prompt）')

  const current = loadQuestions()
  const existing = Array.isArray(current.questions) ? current.questions : []
  let merged = []

  if (mode === 'append') {
    const usedIds = new Set(existing.map(q => q.id))
    merged = [...existing]
    for (const question of normalized) {
      let id = question.id
      let seq = 1
      while (usedIds.has(id)) id = `${question.id}-${seq++}`
      usedIds.add(id)
      merged.push({ ...question, id })
    }
  } else {
    merged = normalized
  }

  saveQuestions({ ...current, version: 1, questions: merged })
  return merged.length
}

// ==================== 评分器 ====================

// 剥离 markdown 代码块后再取最外层 JSON
function extractJsonBlock(text) {
  const raw = String(text || '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return body
  return body.slice(start, end + 1)
}

// 按简化 schema 校验字段存在性与类型
function checkSchema(obj, schema) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const keys = Object.keys(schema || {})
  if (!keys.length) return true

  for (const key of keys) {
    const value = obj[key]
    const type = schema[key]
    if (value === undefined || value === null) return false
    if (type === 'array' && !Array.isArray(value)) return false
    if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) return false
    if (type === 'number' && typeof value !== 'number') return false
    if (type === 'string' && typeof value !== 'string') return false
    if (type === 'boolean' && typeof value !== 'boolean') return false
  }
  return true
}

// 客观题规则评分：exact 全等、contains 按关键词命中比例、regex 命中即满分、json 按 schema 校验
function scoreObjective(question, output) {
  const scoring = question?.scoring || {}
  const max = scoring.maxScore || 5
  const text = String(output || '').trim()

  switch (scoring.mode) {
    case 'exact':
      return text === String(scoring.answer || '').trim() ? max : 0

    case 'contains': {
      const keywords = scoring.keywords || []
      if (!keywords.length) return 0
      const hit = keywords.filter(keyword => text.includes(keyword)).length
      return round2((hit / keywords.length) * max)
    }

    case 'regex': {
      if (!scoring.pattern) return 0
      try {
        return new RegExp(scoring.pattern, scoring.flags || 'i').test(text) ? max : 0
      } catch {
        return 0
      }
    }

    case 'json': {
      try {
        const parsed = JSON.parse(extractJsonBlock(text))
        return checkSchema(parsed, scoring.schema) ? max : 0
      } catch {
        return 0
      }
    }

    default:
      return 0
  }
}

// ==================== 模型调用 ====================

// 直连 Provider 发起一次非流式对话，绕开路由与 fallback，确保测的是目标模型本身
async function callModel(config, ref, prompt, options = {}) {
  const resolved = models.resolveRef(config, ref)
  if (!resolved) throw new Error(`模型不存在或配置无效: ${ref}`)

  const provider = resolved.provider
  if (!provider.apiKey) throw new Error(`Provider「${resolved.providerName}」未配置 API Key`)

  const isAnthropic = !!provider.baseURL
  const url = upstream.resolveEndpoint(provider, isAnthropic)
  if (!url) throw new Error(`Provider「${resolved.providerName}」未配置可用端点`)

  const body = upstream.buildRequestBody({
    model: resolved.model.id,
    max_tokens: options.maxTokens || resolved.model.maxOutput || DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }]
  }, resolved.model, false, isAnthropic)

  const response = await axios.post(url, body, {
    headers: upstream.resolveHeaders(provider, isAnthropic),
    timeout: options.timeout || 120000,
    validateStatus: () => true
  })

  if (response.status !== 200) {
    const detail = typeof response.data === 'string'
      ? response.data.slice(0, 200)
      : JSON.stringify(response.data).slice(0, 200)
    throw new Error(`HTTP ${response.status} ${detail}`)
  }

  return {
    text: upstream.extractText(response.data, isAnthropic),
    usage: upstream.extractUsage(response.data, isAnthropic) || upstream.emptyUsage()
  }
}

// 主观题交给裁判模型按评分细则打分
async function scoreByJudge(config, question, output, judgeRef) {
  const scoring = question?.scoring || {}
  const max = scoring.maxScore || 5
  const rubric = scoring.rubric || '请根据回答的准确性、完整性和表达质量打分。'

  const prompt = [
    '你是一位严格的评分裁判。请根据题目、模型回答和评分细则，给出一个整数分数。',
    '',
    '【题目】',
    question.prompt,
    '',
    '【模型回答】',
    String(output || '').slice(0, 8000),
    '',
    '【评分细则】',
    rubric,
    '',
    `请只输出 1 到 ${max} 之间的一个整数分数，不要输出任何其他内容。`
  ].join('\n')

  const { text } = await callModel(config, judgeRef, prompt, { maxTokens: 32 })
  const match = String(text).match(/\d+/)
  if (!match) {
    return { score: 0, comment: `裁判未返回可解析的分数：${String(text).slice(0, 80)}` }
  }

  const score = Math.min(max, Math.max(0, parseInt(match[0], 10)))
  return { score, comment: String(text).trim().slice(0, 300) }
}

// ==================== 并发执行 ====================

// 固定并发数执行任务，保持输入顺序对应的结果顺序
async function runWithConcurrency(items, worker, limit) {
  const results = new Array(items.length)
  let cursor = 0

  const runnerCount = Math.max(1, Math.min(limit, items.length))
  const runners = []
  for (let i = 0; i < runnerCount; i++) {
    runners.push((async () => {
      while (true) {
        const index = cursor++
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })())
  }

  await Promise.all(runners)
  return results
}

function makeRunId() {
  const now = new Date()
  return `run-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

// 把单题结果汇总成每个模型的得分、分类得分率与客观指标
function summarize(questions, refs, items) {
  const questionMap = new Map(questions.map(q => [q.id, q]))

  return refs.map(ref => {
    const own = items.filter(item => item.ref === ref)
    const byCategory = {}
    let totalScore = 0
    let maxScore = 0
    let successCount = 0
    let failCount = 0
    let latencySum = 0
    let latencyCount = 0
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

    for (const item of own) {
      const question = questionMap.get(item.questionId)
      const max = question?.scoring?.maxScore || 5
      maxScore += max
      totalScore += item.score || 0

      if (item.error) failCount++
      else {
        successCount++
        latencySum += item.latency || 0
        latencyCount++
      }

      usage.input += item.usage?.input || 0
      usage.output += item.usage?.output || 0
      usage.cacheRead += item.usage?.cacheRead || 0
      usage.cacheWrite += item.usage?.cacheWrite || 0

      const category = question?.category || '未分类'
      if (!byCategory[category]) byCategory[category] = { score: 0, maxScore: 0, count: 0, rate: 0 }
      byCategory[category].score += item.score || 0
      byCategory[category].maxScore += max
      byCategory[category].count++
    }

    for (const stat of Object.values(byCategory)) {
      stat.score = round2(stat.score)
      stat.rate = stat.maxScore ? Math.round((stat.score / stat.maxScore) * 1000) / 1000 : 0
    }

    return {
      ref,
      totalScore: round2(totalScore),
      maxScore,
      rate: maxScore ? Math.round((totalScore / maxScore) * 1000) / 1000 : 0,
      successCount,
      failCount,
      avgLatency: latencyCount ? Math.round(latencySum / latencyCount) : 0,
      usage: { ...usage, total: usage.input + usage.cacheRead + usage.cacheWrite + usage.output },
      byCategory,
      answers: own
    }
  })
}

// ==================== 结果存储 ====================

function loadRuns() {
  if (!fs.existsSync(RUNS_FILE)) return []
  try {
    const data = fs.readJsonSync(RUNS_FILE)
    return Array.isArray(data?.runs) ? data.runs : []
  } catch {
    return []
  }
}

function persistRun(run) {
  const runs = loadRuns()
  const index = runs.findIndex(item => item.id === run.id)
  if (index >= 0) runs[index] = run
  else runs.unshift(run)
  fs.writeJsonSync(RUNS_FILE, { runs: runs.slice(0, MAX_RUNS) }, { spaces: 2 })
}

// ==================== 评测主流程 ====================

async function executeRun(run, config, questions, refs, judgeRef, concurrency) {
  const tasks = []
  for (const ref of refs) {
    for (const question of questions) {
      tasks.push({ ref, question })
    }
  }

  const items = await runWithConcurrency(tasks, async ({ ref, question }) => {
    const item = { questionId: question.id, ref, score: 0, output: '', error: '', comment: '' }

    try {
      const startedAt = Date.now()
      const { text, usage } = await callModel(config, ref, question.prompt, { maxTokens: question.maxTokens })
      item.latency = Date.now() - startedAt
      item.output = text
      item.usage = usage

      if (question.scoring?.mode === 'llm') {
        if (judgeRef) {
          const judged = await scoreByJudge(config, question, text, judgeRef)
          item.score = judged.score
          item.comment = judged.comment
        } else {
          item.error = '主观题未指定裁判模型，无法评分'
        }
      } else {
        item.score = scoreObjective(question, text)
      }
    } catch (err) {
      item.error = err.message
      item.latency = 0
      item.usage = upstream.emptyUsage()
    }

    run.completed++
    return item
  }, concurrency)

  run.results = summarize(questions, refs, items)
  run.status = 'completed'
  run.finishedAt = new Date().toISOString()
  persistRun(run)
  currentRun = null
}

// 启动一次评测，立即返回 runId，执行过程在后台进行
function startRun(options = {}) {
  if (currentRun && currentRun.status === 'running') {
    throw new Error('已有评测任务正在运行，请等待其结束')
  }

  const config = models.getConfig()
  const refs = Array.isArray(options.refs) ? options.refs.filter(Boolean) : []
  const questionIds = Array.isArray(options.questionIds) ? options.questionIds : []
  const judgeRef = typeof options.judgeRef === 'string' ? options.judgeRef : ''
  const concurrency = Math.max(1, Math.min(10, Number(options.concurrency) || 3))

  if (!refs.length) throw new Error('请至少选择一个要评测的模型')

  const bank = loadQuestions()
  const questions = (bank.questions || []).filter(q => !questionIds.length || questionIds.includes(q.id))
  if (!questions.length) throw new Error('没有可评测的题目，请检查题库或题目筛选')

  const run = {
    id: makeRunId(),
    createdAt: new Date().toISOString(),
    status: 'running',
    questionCount: questions.length,
    modelRefs: refs,
    judgeRef,
    concurrency,
    total: refs.length * questions.length,
    completed: 0,
    results: []
  }

  currentRun = run
  persistRun(run)

  executeRun(run, config, questions, refs, judgeRef, concurrency).catch(err => {
    run.status = 'failed'
    run.error = err.message
    run.finishedAt = new Date().toISOString()
    persistRun(run)
    currentRun = null
  })

  return { runId: run.id, total: run.total }
}

// 空闲时也返回完整字段，避免前端拿到 undefined
function getStatus() {
  if (!currentRun) {
    return { running: false, runId: '', total: 0, completed: 0 }
  }
  return {
    running: currentRun.status === 'running',
    runId: currentRun.id,
    total: currentRun.total,
    completed: currentRun.completed
  }
}

// 列表不含每题的完整回答，避免响应过大
function listRuns() {
  return loadRuns().map(run => ({
    id: run.id,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt || '',
    status: run.status,
    questionCount: run.questionCount,
    modelRefs: run.modelRefs || [],
    judgeRef: run.judgeRef || '',
    error: run.error || '',
    summary: (run.results || []).map(item => ({
      ref: item.ref,
      totalScore: item.totalScore,
      maxScore: item.maxScore,
      rate: item.rate,
      successCount: item.successCount,
      failCount: item.failCount,
      avgLatency: item.avgLatency,
      usage: item.usage
    }))
  }))
}

function getRun(runId) {
  return loadRuns().find(run => run.id === runId) || null
}

function deleteRun(runId) {
  const runs = loadRuns()
  const remaining = runs.filter(run => run.id !== runId)
  if (remaining.length === runs.length) return false
  fs.writeJsonSync(RUNS_FILE, { runs: remaining }, { spaces: 2 })
  return true
}

function clearRuns() {
  fs.writeJsonSync(RUNS_FILE, { runs: [] }, { spaces: 2 })
}

// 重置为内置题库
function resetQuestions() {
  const seed = fs.readJsonSync(SEED_QUESTIONS_FILE)
  saveQuestions(seed)
  return (seed.questions || []).length
}

// 服务重启后，文件中残留的 running 记录对应的执行已随进程消失，
// 启动时统一标记为失败，避免历史列表里永远显示"进行中"
function markInterruptedRuns() {
  const runs = loadRuns()
  let changed = false
  for (const run of runs) {
    if (run.status === 'running') {
      run.status = 'failed'
      run.error = '服务重启，评测被中断'
      run.finishedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) fs.writeJsonSync(RUNS_FILE, { runs: runs.slice(0, MAX_RUNS) }, { spaces: 2 })
}

markInterruptedRuns()

module.exports = {
  loadQuestions,
  saveQuestions,
  importQuestions,
  resetQuestions,
  normalizeQuestion,
  scoreObjective,
  scoreByJudge,
  extractJsonBlock,
  checkSchema,
  callModel,
  startRun,
  getStatus,
  listRuns,
  getRun,
  deleteRun,
  clearRuns,
  SCORING_MODES
}
