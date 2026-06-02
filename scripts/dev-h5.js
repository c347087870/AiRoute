const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs-extra')
const { ensurePort } = require('./port-utils')

const serverCwd = path.join(__dirname, '..', 'server')
const rendererCwd = path.join(__dirname, '..', 'app', 'renderer')

function readServerPort() {
  try {
    const cfg = fs.readJsonSync(path.join(serverCwd, 'server-config.json'))
    return String(cfg.port || 3000)
  } catch { return '3000' }
}

let SERVER_PORT = process.env.SERVER_PORT || readServerPort()
let VITE_PORT = process.env.VITE_PORT || '5173'

ensurePort(SERVER_PORT)
ensurePort(VITE_PORT)

console.log('[aiRoute] 正在启动 H5 模式...')
console.log(`[aiRoute] Server 端口: ${SERVER_PORT}`)
console.log(`[aiRoute] Vite   端口: ${VITE_PORT}`)

let server = null
let vite = null
let serverReady = false

function startServer() {
  SERVER_PORT = readServerPort()
  ensurePort(SERVER_PORT)

  server = spawn('node', ['router.js'], {
    cwd: serverCwd,
    stdio: 'pipe',
    env: { ...process.env, PORT: SERVER_PORT }
  })

  server.stdout.on('data', (data) => {
    const msg = data.toString()
    process.stdout.write(`[server] ${msg}`)
    if (msg.includes('AiRoute running') && !serverReady) {
      serverReady = true
      if (!vite) {
        startVite()
      }
    }
  })

  server.stderr.on('data', (data) => {
    process.stderr.write(`[server] ${data}`)
  })

  server.on('close', (code) => {
    if (code === 0) {
      serverReady = false
      console.log('[aiRoute] Server 正在重启...')
      startServer()
    }
  })
}

function startVite() {
  console.log('[aiRoute] Server 就绪，正在启动 Vite...')

  vite = spawn('npx', ['vite', '--port', VITE_PORT, '--open'], {
    cwd: rendererCwd,
    stdio: 'pipe',
    shell: true,
    env: { ...process.env }
  })

  vite.stdout.on('data', (data) => {
    process.stdout.write(`[vite]   ${data}`)
  })

  vite.stderr.on('data', (data) => {
    process.stderr.write(`[vite]   ${data}`)
  })
}

startServer()

process.on('SIGINT', () => {
  if (server) server.kill()
  if (vite) vite.kill()
  process.exit()
})
