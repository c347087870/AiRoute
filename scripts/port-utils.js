const { execSync } = require('child_process')

function killPort(port) {
  try {
    const result = execSync(
      `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    )
    if (result.trim()) {
      console.log(`[port] 已释放端口 ${port}`)
    }
  } catch {}
}

function ensurePort(port) {
  killPort(port)
}

module.exports = { killPort, ensurePort }
