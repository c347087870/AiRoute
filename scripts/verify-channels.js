// 渠道一致性校验（硬性标准）：AiRoute 的渠道必须与上游 dsh-our-free-model 提供的一致
//
//     node scripts/verify-channels.js
//
// 校验两类东西：
//   1. **产物**：server/channels/business.mjs 必须逐字节等于「当前上游 pack.js 的
//      改写结果」。这一条同时抓两件事 —— 产物被手改过、上游换了产物但没重跑生成；
//   2. **清单**：面板 / 账号链接 / CLI 登录 / 源展示名计数，必须与上游 product 表
//      一一对上（上游上了新渠道而 AiRoute 没登记，面板就看不到它）。
//
// 上游检出缺失时（没 `git submodule update --init`、CI 浅检出）**跳过并以 0 退出**：
// 这条校验的价值是「有上游可比时把差异立刻打出来」，而不是让没带子模块的机器跑不了
// 测试。CI 里要真正生效，checkout 需要 submodules: true。

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { transform, sourceHash } = require('./channel-pack-transform')

const root = path.join(__dirname, '..')
const packPath = process.env.OFM_CHANNEL_PACK
  ? path.resolve(process.env.OFM_CHANNEL_PACK)
  : path.join(root, 'vendor', 'dsh-our-free-model', 'vendor', 'channel-pack', 'pack.js')
const outFile = path.join(root, 'server', 'channels', 'business.mjs')

// worker.mjs 用 apply(ctx, { disableOpencode: true }) 挂载渠道包：opencode 是上游包里的
// 第十一个 product，AiRoute 故意不启用它，所以它不属于「渠道清单」。
const DISABLED_PRODUCTS = new Set(['opencode'])

// 有意与上游 displayName 不同的渠道在这里登记（右值写 AiRoute 侧的名字）。
// 不改这一行就是硬失败：面板上的渠道名与上游不一致，用户会以为是两家。
const DISPLAY_NAME_EXCEPTIONS = {}

// 渠道清单解析不到这么多条时直接失败，而不是「看起来通过」
const MIN_PRODUCTS = 10

if (!fs.existsSync(packPath)) {
  const shown = packPath.startsWith(root + path.sep) ? path.relative(root, packPath) : packPath
  console.log(`跳过：未检出上游渠道包（${shown}）`)
  console.log('要对齐请先 `git submodule update --init`，或设 OFM_CHANNEL_PACK 指向 pack.js')
  process.exit(0)
}

const packSource = fs.readFileSync(packPath)
const packHash = sourceHash(packSource)

function upstreamProducts(source) {
  // 产物里的 product 是 `var NAME = { ... }` 字面量，`id` / `displayName` 各占一行；
  // 中间可能夹着上游的注释（qodercn / raccoon / zcode 都有），所以按整个块取。
  const blocks = [...source.matchAll(/^var ([A-Z][A-Z0-9_]*) = \{\n([\s\S]*?)\n\};$/gm)]
  const products = []
  for (const [, constName, body] of blocks) {
    const id = body.match(/^ {2}id: "([a-z0-9-]+)",$/m)
    if (!id) continue
    const name = body.match(/^ {2}displayName: "((?:[^"\\]|\\.)*)",$/m)
    products.push({
      id: id[1],
      name: name ? JSON.parse(`"${name[1]}"`) : null,
      constName,
    })
  }
  return products.filter(product => !DISABLED_PRODUCTS.has(product.id))
}

function readSource(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function vueProviders(source) {
  const block = source.match(/const PROVIDERS = \[([\s\S]*?)\n\]/)
  if (!block) return null
  return [...block[1].matchAll(/\{ id: '([a-z0-9-]+)', name: '([^']*)' \}/g)]
    .map(match => ({ id: match[1], name: match[2] }))
}

function linkSlots(source) {
  const block = source.match(/const SLOTS = \{([\s\S]*?)\n\}/)
  if (!block) return null
  return [...block[1].matchAll(/^ {2}([a-z0-9-]+): \[/gm)].map(match => match[1])
}

function cliProviders(source) {
  const block = source.match(/const PROVIDERS = \[([\s\S]*?)\]/)
  if (!block) return null
  return [...block[1].matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1])
}

function providerCount(source) {
  const matched = source.match(/const CHANNEL_PROVIDER_NAME = '账号渠道（(\d+) 家）'/)
  return matched ? Number(matched[1]) : null
}

function equalSets(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  return {
    missing: [...right].filter(item => !left.has(item)),
    extra: [...left].filter(item => !right.has(item)),
  }
}

function firstDiff(a, b) {
  const limit = Math.min(a.length, b.length)
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) return index
  }
  return limit
}

const upstream = upstreamProducts(packSource.toString('utf8'))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('上游渠道清单可解析', () => {
  if (upstream.length < MIN_PRODUCTS) {
    throw new Error(
      `只解析到 ${upstream.length} 个 product（${upstream.map(p => p.id).join(',') || '空'}）。` +
      '上游产物的形状可能变了，请更新本脚本的 upstreamProducts()'
    )
  }
  const nameless = upstream.filter(product => !product.name).map(product => product.constName)
  if (nameless.length) throw new Error(`这些 product 没有 displayName：${nameless.join(',')}`)
  return `${upstream.length} 家：${upstream.map(product => product.id).join(', ')}`
})

check('产物 = 改写(上游 pack.js)', () => {
  if (!fs.existsSync(outFile)) {
    throw new Error(`${path.relative(root, outFile)} 不存在，先跑 node scripts/build-channels.js`)
  }
  const expected = transform(packSource)
  const actual = fs.readFileSync(outFile, 'utf8')
  if (expected === actual) return `SHA256 ${packHash.slice(0, 12)}…（${(actual.length / 1024 / 1024).toFixed(2)} MB）`

  const recorded = actual.match(/^\/\/ 原渠道包 SHA256: ([0-9a-f]{64})$/m)
  const offset = firstDiff(expected, actual)
  const hint = recorded && recorded[1] !== packHash
    ? `产物记录的上游是 ${recorded[1].slice(0, 12)}…，当前上游 pack.js 是 ${packHash.slice(0, 12)}…` +
      ' —— 上游换了产物，重跑 node scripts/build-channels.js'
    : `产物记录的上游与当前 pack.js 相同（${packHash.slice(0, 12)}…），但内容不同` +
      ' —— 产物被手改过，改渠道行为要回上游改源码'
  throw new Error(`${hint}\n     首处差异在第 ${offset} 字节（期望 ${expected.length} / 实际 ${actual.length}）：\n` +
    `     期望 …${JSON.stringify(expected.slice(Math.max(0, offset - 20), offset + 40))}\n` +
    `     实际 …${JSON.stringify(actual.slice(Math.max(0, offset - 20), offset + 40))}`)
})

check('渠道清单：面板 PROVIDERS', () => {
  const list = vueProviders(readSource('app/renderer/src/views/Channels.vue'))
  if (!list) throw new Error('Channels.vue 里没找到 const PROVIDERS = [...]')
  const { missing, extra } = equalSets(list.map(item => item.id), upstream.map(product => product.id))
  if (missing.length || extra.length) {
    throw new Error([
      missing.length ? `面板缺：${missing.join(', ')}` : '',
      extra.length ? `面板多：${extra.join(', ')}` : '',
    ].filter(Boolean).join('；'))
  }
  return `${list.length} 家`
})

check('渠道清单：账号链接 SLOTS', () => {
  const ids = linkSlots(readSource('app/renderer/src/utils/channel-links.js'))
  if (!ids) throw new Error('channel-links.js 里没找到 const SLOTS = {...}')
  // SLOTS 额外含 workbuddy（WorkBuddy 两区并进同一页），所以只要求「上游的都在」
  const { missing } = equalSets(ids, upstream.map(product => product.id))
  if (missing.length) throw new Error(`缺：${missing.join(', ')}`)
  return `${ids.length} 条（含 workbuddy）`
})

check('渠道清单：CLI 登录 scripts/channels-login.js', () => {
  const ids = cliProviders(readSource('scripts/channels-login.js'))
  if (!ids) throw new Error('channels-login.js 里没找到 const PROVIDERS = [...]')
  const { missing, extra } = equalSets(ids, upstream.map(product => product.id))
  if (missing.length || extra.length) {
    throw new Error([
      missing.length ? `缺：${missing.join(', ')}` : '',
      extra.length ? `多：${extra.join(', ')}` : '',
    ].filter(Boolean).join('；'))
  }
  return `${ids.length} 家`
})

check('渠道数量：CHANNEL_PROVIDER_NAME', () => {
  const count = providerCount(readSource('server/router.js'))
  if (count === null) throw new Error("router.js 里没找到 const CHANNEL_PROVIDER_NAME = '账号渠道（N 家）'")
  // 「N 家」= 上游渠道数 + WorkBuddy 一家（国内/国际两区在面板上算同一个来源）
  const expected = upstream.length + 1
  if (count !== expected) {
    throw new Error(`写的是「${count} 家」，应为「${expected} 家」（上游 ${upstream.length} 家 + WorkBuddy）`)
  }
  return `${count} 家`
})

check('面板展示名 = 上游 displayName', () => {
  const list = vueProviders(readSource('app/renderer/src/views/Channels.vue'))
  if (!list) throw new Error('Channels.vue 里没找到 const PROVIDERS = [...]')
  const byId = new Map(list.map(item => [item.id, item.name]))
  const differences = []
  for (const product of upstream) {
    const local = byId.get(product.id)
    if (local === undefined) continue // 缺项由「面板 PROVIDERS」那一项报
    const expected = Object.hasOwn(DISPLAY_NAME_EXCEPTIONS, product.id)
      ? DISPLAY_NAME_EXCEPTIONS[product.id]
      : product.name
    if (local !== expected) differences.push(`${product.id}：面板「${local}」/ 上游「${product.name}」`)
  }
  if (differences.length) {
    throw new Error(`${differences.join('；')}\n     有意改名请在 DISPLAY_NAME_EXCEPTIONS 登记`)
  }
  return `${upstream.length} 家一致`
})

function upstreamLabel() {
  const dir = path.dirname(path.dirname(path.dirname(packPath)))
  const shown = packPath.startsWith(root + path.sep) ? path.relative(root, packPath) : packPath
  try {
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return `${shown} @ ${commit}`
  } catch {
    return shown
  }
}

async function main() {
  console.log(`上游：${upstreamLabel()}`)
  let failed = 0
  for (const item of checks) {
    try {
      const detail = item.fn()
      console.log(`ok   ${item.name}${detail ? `（${detail}）` : ''}`)
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
