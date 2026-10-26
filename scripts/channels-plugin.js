// 渠道插件的管理入口（面板之外的另一条路）
//
//     node scripts/channels-plugin.js                    # 列出插件
//     node scripts/channels-plugin.js list
//     node scripts/channels-plugin.js add <id> <source>  # 装一个本地插件包
//     node scripts/channels-plugin.js remove <id>
//     node scripts/channels-plugin.js enable|disable <id>
//
// 与 channels-login.js 同理，走的是**正在运行的服务**的 HTTP 接口，而不是
// 自己起一份插件宿主：插件状态是按数据目录落盘的，两个进程同时改会互相覆盖。

const fs = require('fs')
const paths = require('../server/paths')

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

async function request(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

function printPlugins(info) {
  const plugins = info.plugins || []
  if (plugins.length === 0) {
    console.log('还没有加载任何渠道插件。')
  }
  for (const plugin of plugins) {
    const mark = plugin.enabled ? 'on ' : 'off'
    const origin = plugin.builtin ? '内置' : '外部'
    console.log(`${mark} ${plugin.id.padEnd(10)} ${plugin.name.padEnd(12)} ${origin}  ${plugin.providers.join(', ')}`)
  }
  for (const failure of info.failures || info.pluginFailures || []) {
    console.log(`!! ${failure.id.padEnd(10)} 加载失败：${failure.error}`)
  }
}

async function main() {
  const [action = 'list', id, source] = process.argv.slice(2)
  if (action === 'list') {
    printPlugins(await request('GET', '/api/channels/plugins'))
    return
  }
  if (!['add', 'remove', 'enable', 'disable'].includes(action)) {
    console.error(`未知动作：${action}\n可用：list / add <id> <source> / remove <id> / enable <id> / disable <id>`)
    process.exit(1)
  }
  const info = await request('POST', '/api/channels/plugins', { action, id, source })
  printPlugins(info)
  console.log(`\n已${action}：${id}`)
  console.log('模型目录已重同步；在建的会话下一条请求即生效。')
}

main().catch(error => {
  console.error(`失败：${error.message}`)
  console.error(`（确认 AiRoute 服务在运行：${base}）`)
  process.exit(1)
})
