// auto 策略排序的离线回归：不联网、不需要真实账号
//
//     node scripts/test-auto-strategy.js
//
// 四档策略的价值全在「排序对不对」上，而排序是纯函数 + 一份日志采样，
// 所以这里直接给合成数据断言顺序。真正的延迟/倍率来自真实日志，
// 那部分用一条合成日志验证「解析口径」（credits=0 是免费、缺字段才是没数据）。
// 并发优先不吃日志，只吃实时在途数，那块单独造计数验证。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const dataDir = path.join(os.tmpdir(), 'airoute-auto-strategy-test')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
// paths 在调用时读环境变量，所以要赶在第一次 readStats 之前设好
process.env.AIROUTE_DATA_DIR = dataDir

const auto = require(path.join(root, 'server/auto-strategy.js'))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

// 造一条「模型 + 采样」的候选：entry 形状与 models.listModelRefs 一致
function refOf(id, displayName) {
  return { ref: `channels/${id}`, providerName: 'channels', model: { id, displayName: displayName || '' } }
}

function statOf(ok, fail, latencies, credits, tokens, costSamples) {
  return { ok, fail, latencies: latencies || [], credits: credits || 0, tokens: tokens || 0, costSamples: costSamples || 0 }
}

check('伪模型 id 判定：只剩 auto', () => {
  assert.equal(auto.isAutoId('auto'), true)
  assert.equal(auto.isAutoId(' AUTO '), true, '大小写与空白都不该影响判定')
  // 旧的三档伪模型已移除：策略改在「渠道-模型」页统一选，模型名里不该再有它们
  assert.equal(auto.isAutoId('auto-fast'), false)
  assert.equal(auto.isAutoId('auto-cheap'), false)
  assert.equal(auto.isAutoId('auto-least-conn'), false)
  assert.equal(auto.isAutoId('auto-slow'), false)
  assert.equal(auto.isAutoId('claude-opus-4-20250514'), false)
  assert.equal(auto.isAutoId(''), false)
  assert.equal(auto.isAutoId(undefined), false)
})

check('伪模型清单形状', () => {
  const list = auto.listAutoModels()
  assert.equal(list.length, 1)
  assert.deepEqual(list.map(item => item.id), ['auto'])
  for (const item of list) {
    assert.equal(item.object, 'model')
    assert.equal(item.owned_by, 'airoute')
    assert.ok(item.name && item.name.length > 0, '要带中文说明，能读到 name 的客户端才看得懂')
  }
})

check('策略档位：四档齐全，非法值退回默认', () => {
  const list = auto.listStrategies()
  assert.deepEqual(list.map(item => item.id), ['balanced', 'latency', 'cost', 'connections'])
  assert.equal(auto.normalizeStrategy('cost'), 'cost')
  assert.equal(auto.normalizeStrategy('nonsense'), 'balanced', '不认识的 id 退回默认档')
  assert.equal(auto.normalizeStrategy(undefined), 'balanced')
  assert.equal(auto.normalizeStrategy(''), 'balanced')
})

check('策略读写：落盘在 server-config.json，非法值不落盘', () => {
  assert.equal(auto.getStrategy(), 'balanced', '没配置时是默认档')
  assert.equal(auto.saveStrategy('cost'), 'cost')
  assert.equal(auto.getStrategy(), 'cost')
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-config.json'), 'utf8'))
  assert.equal(raw.autoStrategy, 'cost')
  // 非法值在读的时候就被挡掉，不会把排序逻辑带进空档
  fs.writeFileSync(path.join(dataDir, 'server-config.json'), JSON.stringify({ autoStrategy: '不存在' }))
  assert.equal(auto.getStrategy(), 'balanced')
  assert.equal(auto.saveStrategy('connections'), 'connections')
  assert.equal(auto.getStrategy(), 'connections')
})

check('中位数', () => {
  assert.equal(auto.median([5]), 5)
  assert.equal(auto.median([1, 3]), 2)
  assert.equal(auto.median([300, 100, 200]), 200)
  assert.equal(auto.median([]), null)
  assert.equal(auto.median([900, 100, 200, 300]), 250)
})

check('成本估算：免费与倍率', () => {
  assert.equal(auto.costOf({ displayName: 'DeepSeek-V4.1-Flash-1017 · 免费' }), 0)
  assert.equal(auto.costOf({ displayName: 'GLM-5.3-Flash · x0.06' }), 0.06)
  assert.equal(auto.costOf({ displayName: 'GLM-5.3 · x1.08' }), 1.08)
  assert.equal(auto.costOf({ displayName: '没有标记的模型' }), 1, '没有倍率按 x1.0 兜底')
  // 实测口径优先于配置里的倍率：真实花了多少比标价准
  const measured = statOf(5, 0, [], 2, 4000, 5)
  assert.equal(auto.costOf({ displayName: 'GLM-5.3-Flash · x0.06' }, measured), 0.5)
})

check('体验优先：按中位延迟排，失败率高的沉底', () => {
  const refs = [refOf('slow'), refOf('fast'), refOf('unknown'), refOf('flaky')]
  const stats = new Map([
    ['channels/slow', statOf(5, 0, [1800, 2000, 2200])],
    ['channels/fast', statOf(5, 0, [120, 130, 140])],
    ['channels/flaky', statOf(0, 5, [50, 60])]
  ])
  const order = auto.rankCandidates(refs, 'latency', stats).map(item => item.entry.model.id)
  assert.equal(order[0], 'fast')
  // flaky 延迟最低但近期全失败：hopeless 先沉底，排在「未知」后面
  assert.deepEqual(order, ['fast', 'slow', 'unknown', 'flaky'])
})

check('性价比优先：免费 → 低倍率 → 高倍率', () => {
  const refs = [
    refOf('pricey', 'X · x1.08'),
    refOf('free', 'Y · 免费'),
    refOf('cheap', 'Z · x0.06'),
    refOf('unknown')
  ]
  const order = auto.rankCandidates(refs, 'cost', new Map()).map(item => item.entry.model.id)
  assert.deepEqual(order, ['free', 'cheap', 'unknown', 'pricey'])
})

check('综合：不是纯延迟也不是纯成本的复制品', () => {
  const refs = [
    refOf('a', 'A · x1.0'),
    refOf('b', 'B · x0.5'),
    refOf('c', 'C · 免费')
  ]
  const stats = new Map([
    ['channels/a', statOf(3, 0, [100])],
    ['channels/b', statOf(3, 0, [500])],
    ['channels/c', statOf(3, 0, [1000])]
  ])
  const order = auto.rankCandidates(refs, 'balanced', stats).map(item => item.entry.model.id)
  // 延迟归一化 a0 b0.44 c1；成本归一化 a1 b0.5 c0 → 合计 .5 / .47 / .5
  assert.deepEqual(order, ['b', 'a', 'c'])
})

check('并发优先：在途最少的先试，都很闲时按延迟排', () => {
  const refs = [refOf('fast'), refOf('mid'), refOf('slow')]
  const stats = new Map([
    ['channels/fast', statOf(5, 0, [100])],
    ['channels/mid', statOf(5, 0, [500])],
    ['channels/slow', statOf(5, 0, [2000])]
  ])
  auto.resetInFlight()
  const idle = auto.rankCandidates(refs, 'connections', stats).map(item => item.entry.model.id)
  assert.deepEqual(idle, ['fast', 'mid', 'slow'], '人人空闲时应退化成延迟序，而不是配置顺序')

  // mid 正被两个请求占着：即使它比 slow 快，也该排到 slow 后面
  const releaseA = auto.beginAttempt('channels/mid')
  const releaseB = auto.beginAttempt('channels/mid')
  const busy = auto.rankCandidates(refs, 'connections', stats).map(item => item.entry.model.id)
  assert.deepEqual(busy, ['fast', 'slow', 'mid'])
  releaseA()
  releaseB()
  assert.deepEqual(auto.rankCandidates(refs, 'connections', stats).map(item => item.entry.model.id), idle)
})

check('并发优先：近期全失败的候选即使最闲也沉底', () => {
  const refs = [refOf('dead'), refOf('alive')]
  const stats = new Map([
    ['channels/dead', statOf(0, 5, [50])],
    ['channels/alive', statOf(5, 0, [900])]
  ])
  auto.resetInFlight()
  const releaseA = auto.beginAttempt('channels/alive')
  const releaseB = auto.beginAttempt('channels/alive')
  // 闲着不等于能用：刚被限流的候选哪怕在途 0，也排在正在忙但健康的候选后面
  assert.deepEqual(auto.rankCandidates(refs, 'connections', stats).map(item => item.entry.model.id), ['alive', 'dead'])
  releaseA()
  releaseB()
  assert.deepEqual(auto.rankCandidates(refs, 'connections', stats).map(item => item.entry.model.id), ['alive', 'dead'])
})

check('在途计数：重复释放不会把计数塌成负数', () => {
  auto.resetInFlight()
  const release = auto.beginAttempt('channels/x')
  assert.equal(auto.getInFlight('channels/x'), 1)
  release()
  release() // 换候选与 res close 都会调，第二次必须是无操作
  assert.equal(auto.getInFlight('channels/x'), 0)
  assert.equal(auto.getInFlight('channels/never-seen'), 0)
  assert.equal(typeof auto.beginAttempt(''), 'function', '空引用也要给一个能调的释放函数')
})

check('日志采样：credits=0 是免费，缺字段才是没数据', () => {
  const lines = [
    { model: 'channels/x', status: 200, responseTime: 100, credits: 0, totalTokens: 1000 },
    { model: 'channels/x', status: 200, responseTime: 300, credits: 0, totalTokens: 1000 },
    { model: 'channels/y', status: 200, responseTime: 900, credits: 2, totalTokens: 4000 },
    { model: 'channels/y', status: 500, error: '上游炸了', responseTime: 40 },
    { model: 'channels/z', status: 200, responseTime: 700 }
  ]
  fs.writeFileSync(path.join(dataDir, 'logs', 'usage-2026-10-22.log'), lines.map(item => JSON.stringify(item)).join('\n'))

  auto.resetStatsCache()
  const stats = auto.readStats()
  assert.deepEqual(stats.get('channels/x').latencies.length, 2)
  assert.equal(auto.median(stats.get('channels/x').latencies), 200)
  assert.equal(stats.get('channels/y').fail, 1)
  assert.equal(stats.get('channels/y').ok, 1)
  // x 有 credits 样本且为 0 → 免费；z 没有 credits 字段 → 没有样本
  assert.equal(stats.get('channels/x').costSamples, 2)
  assert.equal(auto.costOf({ displayName: '随便 · x1.0' }, stats.get('channels/x')), 0)
  assert.equal(stats.get('channels/z').costSamples, 0)
  assert.equal(auto.costOf({ displayName: '随便 · x1.0' }, stats.get('channels/z')), 1)
})

check('尝试链：最多 4 个候选，兜底模型补在末尾', () => {
  const config = {
    channels: {
      type: 'channel',
      models: [
        { id: 'a', displayName: 'A · x1.0' },
        { id: 'b', displayName: 'B · 免费' },
        { id: 'c', displayName: 'C · x0.2' },
        { id: 'd', displayName: 'D · x0.3' },
        { id: 'e', displayName: 'E · x0.4' },
        { id: 'fb', displayName: 'FB · x0.9' }
      ]
    }
  }
  auto.resetStatsCache()
  const chain = auto.buildChain(config, 'cost', 'channels/fb')
  assert.ok(chain.length <= 5, `候选不该无限长：${chain.length}`)
  assert.equal(chain[0].ref, 'channels/b', '免费模型应排第一')
  assert.equal(chain[chain.length - 1].ref, 'channels/fb', '兜底模型必须在末尾')
  for (const entry of chain) {
    assert.ok(entry.provider, '链上每一项都要能直接发起请求')
    assert.ok(entry.model && entry.model.id)
  }
})

check('尝试链：兜底与候选重复时不重复追加', () => {
  const config = { channels: { type: 'channel', models: [{ id: 'only', displayName: 'Only · 免费' }] } }
  auto.resetStatsCache()
  const chain = auto.buildChain(config, 'balanced', 'channels/only')
  assert.deepEqual(chain.map(item => item.ref), ['channels/only'])
})

check('尝试链：并发优先把最闲的排在第一位', () => {
  const config = {
    channels: {
      type: 'channel',
      models: [{ id: 'a', displayName: 'A · x1.0' }, { id: 'b', displayName: 'B · x1.0' }]
    }
  }
  auto.resetStatsCache()
  auto.resetInFlight()
  // a 比 b 快（日志里 a 有延迟样本）但正忙：最闲的 b 才该排第一
  fs.writeFileSync(
    path.join(dataDir, 'logs', 'usage-2026-10-23.log'),
    JSON.stringify({ model: 'channels/a', status: 200, responseTime: 100 }) + '\n'
  )
  auto.resetStatsCache()
  const release = auto.beginAttempt('channels/a')
  const chain = auto.buildChain(config, 'connections', '')
  assert.equal(chain[0].ref, 'channels/b')
  release()
  assert.equal(auto.buildChain(config, 'connections', '')[0].ref, 'channels/a', 'a 闲下来就靠延迟胜出')
})

async function main() {
  let failed = 0
  for (const item of checks) {
    try {
      await item.fn()
      console.log(`ok   ${item.name}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL ${item.name}\n     ${error.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
