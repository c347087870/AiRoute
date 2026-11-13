// 「渠道-账号-模型」三级明细的离线测试：只碰临时目录，不启动服务、不联网
//
//     node scripts/test-token-breakdown.js
//
// 重点验证用量页依赖的四件事：
//   1. 升级前只存在于请求日志里的历史，首次启动能回填进三级明细，且只回填一次；
//   2. 实时记录按「渠道|账号|模型」归并，新旧两种模型写法（channels/workbuddy/x 与
//      WorkBuddy/x）落到同一个渠道，不能把同一份历史拆成两条线；
//   3. 没有账号的请求进入 uid 为空的一档，不丢数据；
//   4. 逐日序列固定天数、按日期对齐，「清空统计」之后再启动不会把日志重新捞回来。

const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('node:os')
const path = require('node:path')

const dataDir = path.join(os.tmpdir(), 'airoute-token-breakdown-test')
fs.removeSync(dataDir)
fs.ensureDirSync(path.join(dataDir, 'logs'))
process.env.AIROUTE_DATA_DIR = dataDir

const today = new Date()
const pad2 = value => String(value).padStart(2, '0')
const dayKey = date => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
const todayKey = dayKey(today)
const yesterdayKey = dayKey(new Date(today.getTime() - 86400000))

// 昨天的日志：新写法 + 老写法的同一个渠道，应当合并成 workbuddy 一个渠道
const logLines = [
  { timestamp: new Date(Date.now() - 86400000).toISOString(), model: 'channels/workbuddy/deepseek-v4.1-flash', uid: 'u1', inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0, totalTokens: 1010, credits: 2 },
  { timestamp: new Date(Date.now() - 86400000).toISOString(), model: 'WorkBuddy/deepseek-v4.1-flash', uid: 'u1', inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 0, totalTokens: 2020, credits: 3 },
  { timestamp: new Date(Date.now() - 86400000).toISOString(), model: 'channels/trae/dfmodel', inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 55 },
  // 失败行没有 token 也没有积分，不该进统计
  { timestamp: new Date(Date.now() - 86400000).toISOString(), model: 'channels/workbuddy/deepseek-v4.1-flash', status: 400, error: 'boom' },
]
fs.writeFileSync(
  path.join(dataDir, 'logs', `usage-${yesterdayKey}.log`),
  logLines.map(line => JSON.stringify(line)).join('\n') + '\n'
)

const statsPath = path.join(__dirname, '..', 'server', 'token-stats.js')
const loggerPath = path.join(__dirname, '..', 'server', 'logger.js')
let tokenStats = require(statsPath)

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, err })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${err.message}`)
  }
}

function entryOf(breakdown, channel, uid, model) {
  return breakdown.entries.find(item => item.channel === channel && item.uid === uid && item.model === model)
}

console.log('\n三级明细（渠道 · 账号 · 模型）')

test('日志历史回填：新旧模型写法合并到同一个渠道', () => {
  const breakdown = tokenStats.getEntryBreakdown(30)
  const entry = entryOf(breakdown, 'workbuddy', 'u1', 'deepseek-v4.1-flash')
  assert.ok(entry, '应回填出 workbuddy|u1|deepseek-v4.1-flash')
  assert.equal(entry.totals.total, 1010 + 2020)
  assert.equal(entry.totals.input, 300)
  assert.equal(entry.totals.cacheRead, 2700)
  assert.equal(entry.totals.count, 2, '没有 token 的失败行不计入')
  assert.equal(Math.round(entry.totals.creditsUsed * 100) / 100, 5)
})

test('日志历史回填：没有账号的请求进 uid 为空的一档', () => {
  const breakdown = tokenStats.getEntryBreakdown(30)
  const entry = entryOf(breakdown, 'trae', '', 'dfmodel')
  assert.ok(entry, '应回填出 trae||dfmodel')
  assert.equal(entry.totals.total, 55)
})

test('逐日序列：长度=天数、末位是今天', () => {
  const breakdown = tokenStats.getEntryBreakdown(7)
  assert.equal(breakdown.dates.length, 7)
  assert.equal(breakdown.dates[6], todayKey)
  const entry = entryOf(breakdown, 'workbuddy', 'u1', 'deepseek-v4.1-flash')
  assert.equal(entry.series.length, 7)
  assert.equal(entry.series[5].date, yesterdayKey)
  assert.equal(entry.series[5].tokens, 3030)
  assert.equal(entry.series[6].tokens, 0, '没有数据的日期补 0')
})

test('实时记录：带 uid 的请求按渠道·账号·模型落桶', () => {
  tokenStats.recordTokens('channels/qodercn/dfmodel', { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, credits: 1.25, uid: 'q1' })
  const entry = entryOf(tokenStats.getEntryBreakdown(1), 'qodercn', 'q1', 'dfmodel')
  assert.ok(entry, '应记录出 qodercn|q1|dfmodel')
  assert.equal(entry.totals.total, 60)
  assert.equal(entry.totals.creditsUsed, 1.25)
  assert.equal(entry.series[0].date, todayKey)
})

test('实时记录：不带 uid 的请求不丢，进空账号档', () => {
  tokenStats.recordTokens('deepseek/deepseek-flash', { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 })
  const entry = entryOf(tokenStats.getEntryBreakdown(1), 'deepseek', '', 'deepseek-flash')
  assert.ok(entry, '应记录出 deepseek||deepseek-flash')
  assert.equal(entry.totals.total, 6)
})

test('回填只做一次：重新加载不会把日志再算一遍', () => {
  tokenStats.flush()
  delete require.cache[statsPath]
  delete require.cache[loggerPath]
  tokenStats = require(statsPath)
  const entry = entryOf(tokenStats.getEntryBreakdown(30), 'workbuddy', 'u1', 'deepseek-v4.1-flash')
  assert.equal(entry.totals.total, 3030, '重启后仍是 3030，没有翻倍')
})

test('清空统计：三级明细归零，且重启不会从日志捞回历史', () => {
  tokenStats.clearAllStats()
  assert.equal(tokenStats.getEntryBreakdown(30).entries.length, 0)
  delete require.cache[statsPath]
  delete require.cache[loggerPath]
  tokenStats = require(statsPath)
  assert.equal(tokenStats.getEntryBreakdown(30).entries.length, 0, '清空后重启仍是空的')
})

console.log('')
if (failed) {
  console.log(`\x1b[31m${failed} 个用例失败\x1b[0m，${passed} 个通过`)
  for (const item of failures) console.log(`\n${item.name}\n${item.err.stack}`)
  process.exit(1)
}
console.log(`\x1b[32m全部 ${passed} 个用例通过\x1b[0m`)
