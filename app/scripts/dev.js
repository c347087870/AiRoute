const { spawn } = require('child_process')
const path = require('path')
const { ensurePort } = require('../../scripts/port-utils')

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

const VITE_PORT = process.env.VITE_PORT || '5173'
ensurePort(VITE_PORT)

const rendererDir = path.join(__dirname, '..', 'renderer')
let electronStarted = false

const vite = spawn('npx', ['vite', '--port', VITE_PORT], {
  cwd: rendererDir,
  stdio: 'pipe',
  shell: true,
  env: { ...process.env }
})

vite.stdout.on('data', (data) => {
  const msg = data.toString()
  process.stdout.write(`[vite] ${msg}`)

  const portMatch = msg.match(/localhost:(\d+)/)
  if (portMatch && !electronStarted) {
    electronStarted = true
    const port = portMatch[1]
    const electron = spawn('npx', ['electron', '.'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_ENV: 'development', VITE_PORT: port }
    })
    electron.on('close', () => {
      vite.kill()
      process.exit()
    })
  }
})

vite.stderr.on('data', (data) => {
  process.stderr.write(`[vite] ${data}`)
})

process.on('SIGINT', () => {
  vite.kill()
  process.exit()
})
