const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs-extra')

// 二进制下载源：默认 npmmirror（国内快），可被 AIROUTE_ELECTRON_SOURCE 覆盖：
//   official      -> 清掉镜像变量，走 GitHub 官方源（CI / 海外环境用）
//   <https 地址>  -> 作为 ELECTRON_MIRROR 直连该地址
const electronSource = process.env.AIROUTE_ELECTRON_SOURCE || 'npmmirror'
if (electronSource === 'official') {
  delete process.env.ELECTRON_MIRROR
  delete process.env.ELECTRON_BUILDER_BINARIES_MIRROR
} else if (electronSource === 'npmmirror') {
  // 旧镜像路径 npmmirror.com/mirrors/electron/ 在 electron-builder 26 下重定向拼接会 404，改用 CDN 直连
  process.env.ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/'
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
} else {
  process.env.ELECTRON_MIRROR = electronSource
}
console.log(`[aiRoute] 二进制下载源: ${electronSource}`)
// 系统环境变量若残留 ELECTRON_CUSTOM_DIR，会把 Electron 下载路径指向错误版本目录导致 404，强制清掉
delete process.env.ELECTRON_CUSTOM_DIR

const root = path.resolve(__dirname, '..')
const appCwd = path.join(root, 'app')
const rendererCwd = path.join(appCwd, 'renderer')
const serverSrcDir = path.join(root, 'server')
const serverBldDir = path.join(appCwd, 'server')
const buildDepsDir = path.join(root, '.build-node_modules')
const buildOutputDir = path.join(appCwd, 'dist-electron')
const releaseDir = path.join(appCwd, 'release')

// 目标平台：默认跟随当前主机，可用 --mac / --win 显式指定（只为给出更清晰的报错）
const targetPlatform = process.argv.includes('--mac') ? 'darwin' : process.argv.includes('--win') ? 'win32' : process.platform
const isMac = targetPlatform === 'darwin'

if (targetPlatform !== process.platform) {
  console.error(`[aiRoute] ✖ 无法在 ${process.platform} 上构建 ${targetPlatform} 包：dmg 只能在 macOS 上构建，exe 只能在 Windows（或 Wine）上构建`)
  process.exit(1)
}
if (!isMac && targetPlatform !== 'win32') {
  console.error(`[aiRoute] ✖ 暂不支持的目标平台: ${targetPlatform}`)
  process.exit(1)
}

// macOS 产物命名（与 electron-builder.json 的 mac.artifactName 模板一致；当前只出 arm64）
const macDmgName = (version) => `AiRoute-${version}-arm64.dmg`
const macAppDir = path.join(buildOutputDir, 'mac-arm64', 'AiRoute.app')
const macInfoPlist = path.join(macAppDir, 'Contents', 'Info.plist')
const macAsarPath = path.join(macAppDir, 'Contents', 'Resources', 'app.asar')
const winExePath = path.join(buildOutputDir, 'AiRoute.exe')
const winAsarPath = path.join(buildOutputDir, 'win-unpacked', 'resources', 'app.asar')

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
  for (const name of names) {
    try { execSync(`taskkill /F /IM ${name} /T`, { stdio: 'pipe' }) } catch {}
  }
}

// 按平台结束残留进程：macOS 只匹配 app bundle 里的可执行文件，避免误杀构建进程本身
function killAppProcesses() {
  if (isMac) {
    try { execSync(`pkill -f "AiRoute.app/Contents/MacOS/"`, { stdio: 'pipe' }) } catch {}
  } else {
    killProcesses(['electron.exe', 'AiRoute.exe', 'aiRoute.exe'])
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

// 打包后版本自检：asar 内应用 package.json 与平台产物元数据必须与根 package.json 一致，
// 不一致直接失败，避免版本错误的产物被同步到 release
function verifyBuild(version) {
  const errors = []
  const asarPath = isMac ? macAsarPath : winAsarPath

  try {
    const raw = fs.readFileSync(asarPath).toString('latin1')
    const m = raw.match(/"name":\s*"aiRoute",\s*"version":\s*"([^"]+)"/)
    if (!m) errors.push('asar 内未找到应用 package.json 的版本号')
    else if (m[1] !== version) errors.push(`asar 内版本 ${m[1]} != package.json 的 ${version}`)
  } catch (err) {
    errors.push(`读取 asar 失败: ${err.message}`)
  }

  if (isMac) {
    try {
      const meta = execSync(`plutil -extract CFBundleShortVersionString raw -o - "${macInfoPlist}"`, { encoding: 'utf8' }).trim()
      if (meta !== version) errors.push(`Info.plist 版本 ${meta} != package.json 的 ${version}`)
    } catch (err) {
      errors.push(`读取 Info.plist 版本失败: ${err.message.split('\n')[0]}`)
    }

    // arm64 强制要求至少 ad-hoc 签名，签名缺失/失效会导致用户侧直接无法启动
    try {
      execSync(`codesign --verify --deep --strict "${macAppDir}"`, { stdio: 'pipe' })
      const info = execSync(`codesign -dv --verbose=2 "${macAppDir}" 2>&1`, { encoding: 'utf8' })
      if (!/Signature=adhoc/.test(info)) errors.push('未检测到 ad-hoc 签名（预期 identity: "-"）')
    } catch (err) {
      errors.push(`签名校验失败（app 将无法在 Apple Silicon 上启动）: ${err.message.split('\n')[0]}`)
    }

    const dmg = path.join(buildOutputDir, macDmgName(version))
    try {
      const size = fs.statSync(dmg).size
      if (size < 10 * 1024 * 1024) errors.push(`dmg 体积异常: ${(size / 1024 / 1024).toFixed(1)} MB`)
    } catch (err) {
      errors.push(`未找到 dmg 产物 ${macDmgName(version)}: ${err.message.split('\n')[0]}`)
    }
  } else {
    try {
      const meta = execSync(`powershell -NoProfile -Command "(Get-Item '${winExePath}').VersionInfo.ProductVersion"`, { encoding: 'utf8' }).trim()
      if (meta !== version) errors.push(`exe 元数据版本 ${meta} != package.json 的 ${version}`)
    } catch (err) {
      errors.push(`读取 exe 元数据失败: ${err.message.split('\n')[0]}`)
    }
  }

  if (errors.length) {
    console.error('[aiRoute] ✖ 版本自检未通过：')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(`[aiRoute] ✔ 版本自检通过：${isMac ? 'asar / Info.plist / ad-hoc 签名' : 'asar / exe 元数据'}均为 ${version}`)
}

// === 构建流程 ===

console.log(`[aiRoute] 正在清理构建环境...（目标平台: ${targetPlatform}）`)
killAppProcesses()
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

  killAppProcesses()
  cleanDir(buildOutputDir, 'dist-electron')

  // --publish never：electron-builder 检测到在 tag 上构建会隐式 publish（默认 onTagOrDraft），
  // CI 里没有 GH_TOKEN 会直接失败；发布统一交给 workflow 的 gh release，这里显式关掉
  const builderArgs = ['electron-builder', '--config', 'electron-builder.json', '--publish', 'never', isMac ? '--mac' : '--win']
  if (isMac) builderArgs.push('--arm64')

  const buildApp = spawn('npx', builderArgs, {
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
    console.log(isMac ? `[aiRoute] 输出: app/dist-electron/${macDmgName(version)}` : '[aiRoute] 输出: app/dist-electron/AiRoute.exe')
    verifyBuild(version)
    syncToRelease()
  })
})
