// 账号渠道的命令行登录（面板之外的另一条入口）
//
//     node scripts/channels-login.js trae
//     node scripts/channels-login.js --list
//
// 走的是**正在运行的服务**的 /api/channels/rpc，而不是自己起一份渠道运行时：
// 账号与凭据是按数据目录落盘的，两个进程同时写同一份目录会互相覆盖
//（服务进程里还有正在跑的登录会话与限流记录）。

const fs = require('fs')
const paths = require('../server/paths')

// 自有渠道（WorkBuddy 两区走 /api/workbuddy/*，不在这里）
const PROVIDERS = ['trae', 'qoder', 'qodercn']

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
  // account.list 按 provider 过滤（没有「列全部账号」的方法），逐个渠道取一遍
  const accounts = []
  for (const provider of PROVIDERS) {
    const list = await rpc('account.list', { provider })
    // 自有渠道直接返回数组（渠道包时代是 { accounts }），两种都容忍
    const rows = Array.isArray(list) ? list : list?.accounts ?? []
    for (const row of rows) accounts.push({ provider, ...row })
  }
  if (!accounts.length) {
    console.log('还没有登录任何渠道账号。')
    return
  }
  for (const account of accounts) {
    const state = account.enabled === false ? '已停用' : '启用'
    console.log(`${account.provider.padEnd(10)} ${String(account.name || account.nickname || account.id).padEnd(24)} ${state}`)
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
