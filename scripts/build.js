const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs-extra')

process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const root = path.resolve(__dirname, '..')
const appCwd = path.join(root, 'app')
const rendererCwd = path.join(appCwd, 'renderer')
const serverSrcDir = path.join(root, 'server')
const serverBldDir = path.join(appCwd, 'server')
const buildDepsDir = path.join(root, '.build-node_modules')
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

// 独立安装生产依赖到 .build-node_modules（解决 pnpm 符号链接导致打包缺依赖）
function installProductionDeps() {
  const pkg = require(path.join(root, 'package.json'))
  const deps = pkg.dependencies || {}
  if (Object.keys(deps).length === 0) {
    console.log('[aiRoute] 无生产依赖，跳过独立安装')
    return
  }
  fs.ensureDirSync(buildDepsDir)
  const depPkg = {
    name: 'aiRoute-build-deps',
    version: '1.0.0',
    private: true,
    dependencies: deps
  }
  fs.writeJsonSync(path.join(buildDepsDir, 'package.json'), depPkg, { spaces: 2 })
  console.log('[aiRoute] 正在独立安装生产依赖...')
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: buildDepsDir, stdio: 'inherit' })
}

// 清理目录：删不掉则重命名（Windows 文件占用兼容）
function cleanDir(dir, label) {
  if (!fs.existsSync(dir)) return
  try {
    fs.removeSync(dir)
    console.log(`[aiRoute] 已清理 ${label} 目录`)
  } catch {
    const ts = Date.now()
    const renamed = `${dir}.old.${ts}`
    try {
      fs.renameSync(dir, renamed)
      console.log(`[aiRoute] ${label} 目录被占用，已重命名为 ${path.basename(renamed)}`)
    } catch {
      console.warn(`[aiRoute] ⚠ ${label} 目录清理失败，请手动删除: ${dir}`)
    }
  }
}

// 将构建产物复制到 release，跳过锁定的旧文件
function syncToRelease() {
  cleanDir(releaseDir, 'release')

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
cleanDir(buildOutputDir, 'dist-electron')

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

  console.log('[aiRoute] 渲染进程构建完成，正在准备打包...')

  copyServerFiles()
  installProductionDeps()

  killProcesses(['electron.exe', 'AiRoute.exe', 'aiRoute.exe'])
  cleanDir(buildOutputDir, 'dist-electron')

  const buildApp = spawn('npx', ['electron-builder', '--config', 'electron-builder.json'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env }
  })

  buildApp.on('close', (code) => {
    cleanDir(buildDepsDir, '构建依赖')
    cleanServerDir()
    if (code !== 0) {
      console.error('[aiRoute] Electron 打包失败')
      process.exit(1)
    }
    console.log('[aiRoute] 打包完成！')
    console.log('[aiRoute] 输出: app/dist-electron/AiRoute.exe')
    syncToRelease()
  })
})
