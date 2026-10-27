// 渠道一致性校验
//
//     node scripts/verify-channels.js
//
// 渠道已经不再来自 dsh 渠道包（那份 2.6 MB 打包产物已移除），并且从「宿主里的
// 代码」改成了「装进来的插件」（server/channels/plugins/）。所以这里校验的是
// **插件宿主这一侧是否自洽**：
//
//   1. 每个内置插件都有入口与实现文件（缺一个就是面板上「点了没反应」）；
//   2. 插件清单声明的 provider 与面板 / 账号链接 / CLI 登录 / 源展示名一致；
//   3. 插件包自带的关键文件（Qoder 的 WASM）真实存在；
//   4. 插件不许绕过宿主直接 require 宿主的存储与端口服务。
//
// 报红就是「清单与实现脱节」：补实现或补登记，**不要**放宽规则让它变绿。

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

// 运行时真正持有的 provider：WorkBuddy 两区由 server/workbuddy/ 直通，
// 其余来自内置插件（见 server/channels/plugin-store.js 的 BUILTIN_PLUGINS）
const BUILTIN_PROVIDERS = {
  trae: { file: 'server/channels/plugins/trae/index.js', impl: 'server/channels/plugins/trae/provider.js' },
  qoder: {
    file: 'server/channels/plugins/qoder/index.js',
    impl: 'server/channels/plugins/qoder/provider.js',
    providers: ['qoder', 'qodercn'],
  },
}
const RUNTIME_PROVIDERS = [
  'workbuddy',
  'workbuddy-global',
  ...Object.entries(BUILTIN_PROVIDERS).flatMap(([id, meta]) => meta.providers || [id]),
]

// 面板展示名：与各渠道自己的 displayName 一致；两区产品（WorkBuddy / Qoder）
// 名字必须带区域文案区分，Trae 只有一家、不带后缀
const DISPLAY_NAMES = {
  workbuddy: 'WorkBuddy 国内版',
  'workbuddy-global': 'WorkBuddy 国际版',
  trae: 'Trae',
  qoder: 'Qoder 国际版',
  qodercn: 'Qoder 国内版',
}

const failures = []
const checks = []

function check(name, fn) {
  try {
    const detail = fn()
    checks.push({ name, ok: true, detail })
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message })
    failures.push(`${name}：${error.message}`)
  }
}

function read(rel) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${rel}`)
  return fs.readFileSync(file, 'utf8')
}

// ① 每个内置插件都有入口与实现文件
check('渠道插件实现齐全', () => {
  for (const [id, meta] of Object.entries(BUILTIN_PROVIDERS)) {
    for (const file of [meta.file, meta.impl]) {
      if (!fs.existsSync(path.join(root, file))) throw new Error(`插件 ${id} 缺少 ${file}`)
    }
  }
  if (!fs.existsSync(path.join(root, 'server/workbuddy/runtime.js'))) throw new Error('WorkBuddy 缺少实现')
  return `${Object.keys(BUILTIN_PROVIDERS).length} 个插件 / ${RUNTIME_PROVIDERS.length} 家`
})

// ② 插件清单里登记的 provider 与这里一致（清单是唯一真相源）
check('插件清单与登记一致', () => {
  const store = read('server/channels/plugin-store.js')
  const match = store.match(/const BUILTIN_PLUGINS = \[([\s\S]*?)\]/)
  if (!match) throw new Error('plugin-store.js 里找不到 BUILTIN_PLUGINS')
  const declared = [...match[1].matchAll(/id:\s*['"]([^'"]+)['"]/g)].map(hit => hit[1])
  const expected = Object.keys(BUILTIN_PROVIDERS)
  const missing = expected.filter(id => !declared.includes(id))
  const extra = declared.filter(id => !expected.includes(id))
  if (missing.length > 0) throw new Error(`插件清单缺：${missing.join('、')}`)
  if (extra.length > 0) throw new Error(`插件清单多出未登记：${extra.join('、')}`)
  // 每个插件声明的 provider 必须覆盖登记表里的那些
  for (const [id, meta] of Object.entries(BUILTIN_PROVIDERS)) {
    const src = read(meta.file)
    for (const provider of meta.providers || [id]) {
      if (!src.includes(`${provider}:`)) throw new Error(`插件 ${id} 没有声明 provider ${provider}`)
    }
  }
  return declared.join('、')
})

// ③ 面板的渠道清单与展示名
check('面板渠道清单', () => {
  const vue = read('app/renderer/src/views/Channels.vue')
  const missing = []
  for (const [provider, name] of Object.entries(DISPLAY_NAMES)) {
    // WorkBuddy 两区在 WB_MODEL_PROVIDERS 里，其余在 PROVIDERS 里
    const pattern = new RegExp(`id:\\s*['"]${provider}['"][^}]*name:\\s*['"][^'"]*['"]`)
    const match = vue.match(pattern)
    if (!match) {
      missing.push(provider)
      continue
    }
    if (!match[0].includes(name)) missing.push(`${provider}（展示名应为 ${name}）`)
  }
  if (missing.length > 0) throw new Error(`缺：${missing.join('、')}`)
  return `${Object.keys(DISPLAY_NAMES).length} 家`
})

// ④ CLI 登录清单
check('CLI 登录清单', () => {
  const cli = read('scripts/channels-login.js')
  const match = cli.match(/const PROVIDERS = \[([^\]]+)\]/)
  if (!match) throw new Error('channels-login.js 里找不到 PROVIDERS')
  const declared = match[1].split(',').map(item => item.trim().replace(/['"]/g, '')).filter(Boolean)
  const expected = ['trae', 'qoder', 'qodercn']
  const missing = expected.filter(provider => !declared.includes(provider))
  if (missing.length > 0) throw new Error(`缺：${missing.join('、')}`)
  const stale = declared.filter(provider => !RUNTIME_PROVIDERS.includes(provider))
  if (stale.length > 0) throw new Error(`已删除的渠道仍在列：${stale.join('、')}`)
  return declared.join('、')
})

// ⑤ 源展示名是算出来的，不是写死的数字
check('源展示名按运行时计算', () => {
  const router = read('server/router.js')
  if (!/function channelProviderName\(\)/.test(router)) {
    throw new Error('router.js 里找不到 channelProviderName()：渠道数应当是算出来的')
  }
  if (/CHANNEL_PROVIDER_NAME = '账号渠道（\d+ 家）'/.test(router)) {
    throw new Error('router.js 里仍有写死的渠道数：插件可装可卸，数字会过期')
  }
  // 算出来的值必须来自运行时，而不是另一份常量
  if (!/channels\.getRuntime\(\)\?\.providers\.length/.test(router)) {
    throw new Error('channelProviderName() 没有读运行时 providers')
  }
  return '动态'
})

// ⑥ Qoder 的 WASM 必须随插件一起分发（wasm.js 按 __dirname 定位它）
check('Qoder WASM 就位', () => {
  const file = 'server/channels/plugins/qoder/qoder-auth-wasm.wasm'
  const stat = fs.statSync(path.join(root, file))
  if (stat.size < 100_000) throw new Error(`${file} 体积异常（${stat.size} 字节）`)
  return `${(stat.size / 1024).toFixed(0)} KB`
})

// ⑦ 渠道包产物必须已经不在（回退到打包产物会重新引入不可审的那一层）
check('渠道包产物已移除', () => {
  const leftovers = ['server/channels/business.mjs', 'server/channels/worker.mjs', 'server/channels/contracts.mjs']
    .filter(file => fs.existsSync(path.join(root, file)))
  if (leftovers.length > 0) throw new Error(`仍存在：${leftovers.join('、')}`)
  return '已移除'
})

// ⑧ 插件不许绕过宿主直接 require 宿主的存储与端口服务
//
// 这一条是这次改造的意义所在：插件的凭据读写与登录回调必须由宿主递进来
// （plugin-api.js 的 ctx），否则「插件」只是换了目录的宿主代码 ——
// 装进来的第三方包也能直接摸凭据文件。
check('插件不直连宿主存储', () => {
  const offenders = []
  for (const [id, meta] of Object.entries(BUILTIN_PROVIDERS)) {
    for (const file of [meta.file, meta.impl]) {
      const src = read(file)
      if (/require\(['"]\.\.\/shared\/accounts/.test(src)) offenders.push(`${id}: accounts`)
      if (/require\(['"]\.\.\/shared\/login-server/.test(src)) offenders.push(`${id}: login-server`)
    }
  }
  if (offenders.length > 0) throw new Error(`插件直连了宿主服务：${offenders.join('、')}`)
  return '均经宿主注入'
})

for (const item of checks) {
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项不一致：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('\n渠道清单与实现脱节：补实现或补登记，不要放宽校验规则。')
  process.exit(1)
}

console.log(`\n${checks.length}/${checks.length} 项通过`)
