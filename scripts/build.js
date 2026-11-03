const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs-extra')

// 旧镜像路径 npmmirror.com/mirrors/electron/ 在 electron-builder 26 下重定向拼接会 404，改用 CDN 直连
process.env.ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/'
// 系统环境变量若残留 ELECTRON_CUSTOM_DIR，会把 Electron 下载路径指向错误版本目录导致 404，强制清掉
delete process.env.ELECTRON_CUSTOM_DIR
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const root = path.resolve(__dirname, '..')
const appCwd = path.join(root, 'app')
const rendererCwd = path.join(appCwd, 'renderer')
const serverSrcDir = path.join(root, 'server')
const serverBldDir = path.join(appCwd, 'server')
const buildDepsDir = path.join(root, '.build-node_modules')
const buildOutputDir = path.join(appCwd, 'dist-electron')
const releaseDir = path.join(appCwd, 'release')

// 目标平台：macOS 默认打 dmg；Windows 传 --win 或直接在 Windows 上运行
const isMac = process.platform === 'darwin'
const target = process.argv.includes('--win') ? 'win' : process.argv.includes('--mac') ? 'mac' : isMac ? 'mac' : 'win'

// 渲染进程构建和 electron-builder 都依赖 Node 版本（Electron 42 要求 >= 22.12）
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) {
  console.warn(`[aiRoute] ⚠ 当前 Node ${process.versions.node} 偏低，建议使用 Node 22+（Electron 42 安装脚本要求）`)
}

// npx / electron-builder 通过 PATH 解析 node，若用户默认 node 较旧（如 v20），
// 打包时 app-builder-lib 的纯 ESM 依赖会因 require() 不支持而崩溃。
// 把当前 Node 的 bin 目录放到最前，保证整条子进程链使用同一个 Node
const nodeBinDir = path.dirname(process.execPath)
process.env.PATH = [nodeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter)

// 复制 server 文件到 app/server/ 供打包
// 排除：API Key、依赖、日志，以及 WorkBuddy 凭证与个人运行数据（避免随公开发布泄露）
function copyServerFiles() {
  fs.ensureDirSync(serverBldDir)
  // 运行时数据与个人配置一律不进产物：state/fallback/rules/server-config 属「用户自己的配置」，
  // 随包分发会让新用户首启就选中一个不存在的模型（且 server-config 可能带上作者机器指纹）
  const exclude = ['models.json', 'state.json', 'fallback.json', 'rules.json', 'server-config.json', 'node_modules', 'logs', 'cost.json', 'workbuddy-auths', 'workbuddy-state.json', 'usage.json', 'credit-history.json', 'token-stats.json', 'benchmark-questions.json', 'benchmark-runs.json', 'version-cache.json', '.npmrc']
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
  // App 内「开发者选项」触发的构建：宿主进程本身就是 AiRoute，
  // 杀掉它会中断构建日志与后续安装，必须由调用方跳过
  if (process.env.AIROUTE_BUILD_NO_KILL === '1') {
    console.log('[aiRoute] 应用内构建：跳过退出 AiRoute 进程')
    return
  }
  if (isMac) {
    // 只退出打包后的 AiRoute 应用，避免误杀用户用 npm run dev 起的 Electron/Node
    try { execSync('osascript -e \'quit app "AiRoute"\'', { stdio: 'pipe' }) } catch {}
    try { execSync('pkill -f "AiRoute.app/Contents/MacOS/AiRoute"', { stdio: 'pipe' }) } catch {}
    return
  }
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

// 将构建产物复制到 release：mac 只复制 dmg，避免把 .app 整包再拷一份
function syncToRelease(version) {
  cleanDir(releaseDir, 'release')
  try {
    fs.ensureDirSync(releaseDir)
    if (target === 'mac') {
      const dmgName = `AiRoute-${version}-x64.dmg`
      const dmgPath = path.join(buildOutputDir, dmgName)
      if (fs.existsSync(dmgPath)) {
        fs.copyFileSync(dmgPath, path.join(releaseDir, dmgName))
        console.log(`[aiRoute] 已同步 ${dmgName} 到 release 目录`)
      }
    } else {
      fs.copySync(buildOutputDir, releaseDir)
      console.log('[aiRoute] 已同步构建产物到 release 目录')
    }
  } catch (err) {
    console.warn(`[aiRoute] ⚠ 同步到 release 目录失败: ${err.message}`)
    console.log('[aiRoute] 构建产物位于: app/dist-electron/')
  }
}

// 找到打包后的 .app：electron-builder 会把 mac 产物放在 dist-electron/mac/AiRoute.app，
// 不同架构还可能是 mac-arm64 等目录，因此递归浅层查找而不是只看顶层
function findPackedApp() {
  if (!fs.existsSync(buildOutputDir)) return null
  const stack = [buildOutputDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith('.app')) {
        if (fs.existsSync(path.join(full, 'Contents', 'Resources', 'app.asar'))) return full
        continue
      }
      // 只向下找一层（mac/、mac-arm64/），避免扫描 .app 内部与无关目录
      if (path.dirname(full) === buildOutputDir) stack.push(full)
    }
  }
  return null
}

// 打包后版本自检：asar 内应用 package.json 与安装包元数据必须与根 package.json 一致
function verifyBuild(version) {
  const errors = []
  let asarPath = ''

  if (target === 'mac') {
    const appPath = findPackedApp()
    if (!appPath) errors.push('未找到打包后的 .app')
    else {
      asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
      try {
        const plist = path.join(appPath, 'Contents', 'Info.plist')
        const meta = execSync(`plutil -extract CFBundleShortVersionString raw "${plist}"`, { encoding: 'utf8' }).trim()
        if (meta !== version) errors.push(`Info.plist 版本 ${meta} != package.json 的 ${version}`)
      } catch (err) {
        errors.push(`读取 Info.plist 失败: ${err.message.split('\n')[0]}`)
      }
      const dmgPath = path.join(buildOutputDir, `AiRoute-${version}-x64.dmg`)
      if (!fs.existsSync(dmgPath)) errors.push(`未找到 dmg 产物 ${path.basename(dmgPath)}`)
    }
  } else {
    asarPath = path.join(buildOutputDir, 'win-unpacked', 'resources', 'app.asar')
    const exePath = path.join(buildOutputDir, 'AiRoute.exe')
    try {
      const meta = execSync(`powershell -NoProfile -Command "(Get-Item '${exePath}').VersionInfo.ProductVersion"`, { encoding: 'utf8' }).trim()
      if (meta !== version) errors.push(`exe 元数据版本 ${meta} != package.json 的 ${version}`)
    } catch (err) {
      errors.push(`读取 exe 元数据失败: ${err.message.split('\n')[0]}`)
    }
  }

  try {
    // 用 @electron/asar 直接解析头部并读取包内 package.json，避免依赖 npx 联网/本地 bin
    const asar = require('@electron/asar')
    const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    if (pkg.version !== version) errors.push(`asar 内版本 ${pkg.version} != package.json 的 ${version}`)
    const asarFiles = asar.listPackage(asarPath, {})
    for (const forbidden of ['workbuddy-auths', 'workbuddy-state.json', 'models.json', 'server-config.json']) {
      if (asarFiles.some(f => f.includes(forbidden))) errors.push(`产物包含敏感/个人文件: ${forbidden}`)
    }
  } catch (err) {
    errors.push(`检查 asar 内容失败: ${err.message.split('\n')[0]}`)
  }

  if (errors.length) {
    console.error('[aiRoute] ✖ 版本自检未通过：')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(`[aiRoute] ✔ 版本自检通过：asar 与安装包元数据均为 ${version}`)
}

// === 构建流程 ===

console.log(`[aiRoute] 目标平台: ${target === 'mac' ? 'macOS (dmg)' : 'Windows (portable)'}`)
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

  const args = ['electron-builder', '--config', 'electron-builder.json']
  if (target === 'mac') args.push('--mac', 'dmg', '--x64')
  else args.push('--win', 'portable')

  const buildApp = spawn('npx', args, {
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
    const version = require(path.join(root, 'package.json')).version
    console.log('[aiRoute] 打包完成！')
    console.log(target === 'mac'
      ? `[aiRoute] 输出: app/dist-electron/AiRoute-${version}-x64.dmg`
      : '[aiRoute] 输出: app/dist-electron/AiRoute.exe')
    verifyBuild(version)
    syncToRelease(version)
  })
})
