// 十个账号渠道的命令行登录（面板做出来之前的临时入口）
//
//     node scripts/channels-login.js gemini
//     node scripts/channels-login.js --list
//
// 走的是**正在运行的服务**的 /api/channels/rpc，而不是自己起一个渠道运行时：
// 渠道包的账号池与凭据是按数据目录落盘的，两个进程同时写同一份目录会互相覆盖
//（服务端还有个正在跑的 worker 持有内存态）。

const fs = require('fs')
const paths = require('../server/paths')

const PROVIDERS = ['lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini']

function resolveBase() {
  if (process.env.AIROUTE_PORT) return `http://127.0.0.1:${process.env.AIROUTE_PORT}`
  const configPath = paths.getServerConfigPath()
  if (fs.existsSync(configPath)) {
    try {
      const port = JSON.parse(fs.readFileSync(configPath, 'utf8')).port
      if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`
    } catch {
      /* 配置损坏时回落默认端口 */
    }
  }
  return 'http://127.0.0.1:3000'
}

const base = resolveBase()

async function rpc(method, payload) {
  const res = await fetch(`${base}/api/channels/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload })
  })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`)
  const result = body.result
  if (!result?.ok) throw new Error(result?.error?.message || '渠道接口返回失败')
  return result.value
}

async function listAccounts() {
  // account.list 是按 provider 过滤的（payload 里缺 provider 会过滤成空数组，
  // 渠道包没有「列全部账号」的方法），所以逐个渠道取一遍
  const accounts = []
  for (const provider of PROVIDERS) {
    const list = await rpc('account.list', { provider })
    accounts.push(...list.accounts)
  }
  if (!accounts.length) {
    console.log('还没有登录任何渠道账号。')
    return
  }
  for (const account of accounts) {
    const state = account.enabled === false ? '已停用' : '启用'
    console.log(`${account.provider.padEnd(10)} ${String(account.nickname || account.id).padEnd(24)} ${state}`)
  }
}

async function login(provider) {
  if (!PROVIDERS.includes(provider)) {
    console.error(`未知渠道：${provider}\n可用：${PROVIDERS.join(', ')}`)
    process.exit(1)
  }
  const started = await rpc('account.create', { provider })
  console.log(`\n在浏览器里完成 ${provider} 登录：\n  ${started.loginUrl}\n`)
  console.log('等待登录结果（最长 5 分钟，Ctrl+C 取消）…')

  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const state = await rpc('login.poll', { accountId: started.accountId, provider })
    if (!state.done) continue
    if (!state.success) throw new Error(state.error || '登录失败')
    console.log('登录成功。')
    const { models } = await fetchModels()
    console.log(`渠道目录已更新：${models} 个模型（在 AiRoute 的 channels 源里可见）`)
    return
  }
  throw new Error('登录超时')
}

// 让服务端重新采集目录并写进 models.json（登录成功后调用，面板做出来后会由前端触发）
async function fetchModels() {
  const res = await fetch(`${base}/api/channels/refresh`, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!body.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

async function main() {
  const arg = process.argv[2]
  if (!arg || arg === '--list') {
    await listAccounts()
    if (!arg) console.log(`\n登录：node scripts/channels-login.js <${PROVIDERS.join('|')}>`)
    return
  }
  await login(arg)
}

main().catch(error => {
  console.error(`失败：${error.message}`)
  console.error(`（确认 AiRoute 服务在运行：${base}）`)
  process.exit(1)
})
