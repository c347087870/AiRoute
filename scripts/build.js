const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs-extra')

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const rendererCwd = path.join(__dirname, '..', 'app', 'renderer')
const appCwd = path.join(__dirname, '..', 'app')
const serverSrcDir = path.join(__dirname, '..', 'server')
const serverBldDir = path.join(appCwd, 'server')
const buildOutputDir = path.join(appCwd, 'dist-electron')
const releaseDir = path.join(appCwd, 'release')

// 复制 server 文件到 app/server/ 供打包
function copyServerFiles() {
  fs.ensureDirSync(serverBldDir)
  const exclude = ['models.json', 'node_modules', 'logs', 'cost.json']
  const entries = fs.readdirSync(serverSrcDir)
  for (const entry of entries) {
    if (exclude.includes(entry)) continue
    const src = path.join(serverSrcDir, entry)
    const dst = path.join(serverBldDir, entry)
    if (fs.statSync(src).isDirectory()) {
      fs.copySync(src, dst, { overwrite: true })
    } else {
      fs.copyFileSync(src, dst)
    }
  }
  console.log('[aiRoute] 已复制 server 文件到 app/server/')
}

// 清理临时 server 目录
function cleanServerDir() {
  try { fs.removeSync(serverBldDir) } catch {}
}

// 强制终止所有残留的 Electron/AiRoute 进程
function killProcesses(names) {
  for (const name of names) {
    try { execSync(`taskkill /F /IM ${name} /T`, { stdio: 'pipe' }) } catch {}
  }
}

// 清理构建输出目录
function cleanBuildOutput() {
  if (fs.existsSync(buildOutputDir)) {
    try { fs.removeSync(buildOutputDir); console.log('[aiRoute] 已清理 dist-electron 目录') } catch {
      console.warn('[aiRoute] ⚠ dist-electron 清理失败，继续尝试...')
    }
  }
}

// 将构建产物复制到 release，跳过锁定的旧文件
function syncToRelease() {
  try {
    if (fs.existsSync(releaseDir)) {
      try { fs.removeSync(releaseDir) } catch {
        const ts = Date.now()
        try { fs.renameSync(releaseDir, path.join(appCwd, `release.old.${ts}`)) } catch {}
      }
    }
  } catch {}

  try {
    fs.copySync(buildOutputDir, releaseDir)
    console.log('[aiRoute] 已同步构建产物到 release 目录')
  } catch (err) {
    console.warn(`[aiRoute] ⚠ 同步到 release 目录失败: ${err.message}`)
    console.log('[aiRoute] 构建产物位于: app/dist-electron/')
  }
}

// === 构建流程 ===

console.log('[aiRoute] 正在清理构建环境...')
killProcesses(['electron.exe', 'AiRoute.exe', 'aiRoute.exe'])
cleanBuildOutput()

console.log('[aiRoute] 正在构建渲染进程...')

const buildRenderer = spawn('npx', ['vite', 'build'], {
  cwd: rendererCwd,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env }
})

buildRenderer.on('close', (code) => {
  if (code !== 0) {
    console.error('[aiRoute] 渲染进程构建失败')
    process.exit(1)
  }

  console.log('[aiRoute] 渲染进程构建完成，正在打包 Electron 应用...')

  copyServerFiles()

  killProcesses(['electron.exe', 'AiRoute.exe', 'aiRoute.exe'])
  cleanBuildOutput()

  const buildApp = spawn('npx', ['electron-builder', '--win', 'portable'], {
    cwd: appCwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env }
  })

  buildApp.on('close', (code) => {
    if (code !== 0) {
      console.error('[aiRoute] Electron 打包失败')
      cleanServerDir()
      process.exit(1)
    }
    console.log('[aiRoute] 打包完成！')
    console.log('[aiRoute] 输出: app/dist-electron/AiRoute.exe')
    cleanServerDir()
    syncToRelease()
  })
})
