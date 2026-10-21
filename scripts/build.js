const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs-extra')
const { targetArches, artifacts, asarPath, unpackedDirs } = require('./targets')

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

// 目标架构：electron-builder.json 的 target.arch（x64 + arm64），脚本不另写一份
const arches = targetArches()

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

// 结束「从构建输出目录启动」的实例：构建要覆盖 dist-electron / release 里的文件，
// 被占用的 exe 会让 electron-builder 报 EBUSY/EPERM。
// 只按可执行文件路径匹配，绝不按进程名全局杀——用户自己安装的 AiRoute（%LOCALAPPDATA%\Programs、
// Program Files、或拷到别处跑的副本）不在构建范围里，构建不该把它顶掉。
// 想彻底不碰任何进程：加 --no-kill（CI 里目录是干净的，通常也无需杀）
function killBuildOutputProcesses() {
  if (process.argv.includes('--no-kill') || process.env.AIROUTE_BUILD_NO_KILL === '1') {
    console.log('[aiRoute] 已跳过结束残留进程（--no-kill）')
    return
  }
  const dirs = [buildOutputDir, releaseDir]
  if (isMac) {
    for (const dir of dirs) {
      // pkill -f 用 ERE 匹配完整命令行，路径里的正则元字符需转义
      const pattern = `${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*AiRoute\\.app/Contents/MacOS/`
      try { execSync(`pkill -f "${pattern}"`, { stdio: 'pipe' }) } catch {}
    }
    return
  }
  // Windows：用 CIM 查可执行文件路径（Get-Process 读 .Path 对部分进程会抛访问拒绝）
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$dirs = [Environment]::GetEnvironmentVariable('AIROUTE_BUILD_OUT_DIRS').Split('|')",
    "Get-CimInstance Win32_Process -Filter \"Name='AiRoute.exe' OR Name='aiRoute.exe'\" | ForEach-Object {",
    '  $exe = $_.ExecutablePath',
    '  if (-not $exe) { return }',
    '  foreach ($dir in $dirs) {',
    '    if ($exe.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) {',
    "      Stop-Process -Id $_.ProcessId -Force",
    "      Write-Output ('[aiRoute] 已结束占用构建产物的实例: ' + $exe)",
    '      break',
    '    }',
    '  }',
    '}'
  ].join('\n')
  try {
    execSync('powershell -NoProfile -Command -', {
      input: script,
      stdio: ['pipe', 'inherit', 'pipe'],
      env: { ...process.env, AIROUTE_BUILD_OUT_DIRS: dirs.join('|') }
    })
  } catch {}
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

// 打包后版本自检：每个架构的 asar 内应用 package.json 与平台产物元数据必须与根 package.json 一致，
// 任一产物缺失或版本不一致直接失败，避免版本错误的产物被同步到 release。
// Windows 每个架构有两类产物（安装版 -setup.exe + 便携版），两类都要校验
function verifyBuild(version) {
  const errors = []
  const dirs = unpackedDirs(buildOutputDir)
  const builds = artifacts(version)

  if (!dirs.length) errors.push('未找到解包目录（没有任何目录包含 app.asar）')

  for (const dir of dirs) {
    const label = path.basename(dir)
    try {
      const raw = fs.readFileSync(asarPath(dir)).toString('latin1')
      const m = raw.match(/"name":\s*"aiRoute",\s*"version":\s*"([^"]+)"/)
      if (!m) errors.push(`${label}: asar 内未找到应用 package.json 的版本号`)
      else if (m[1] !== version) errors.push(`${label}: asar 内版本 ${m[1]} != package.json 的 ${version}`)
    } catch (err) {
      errors.push(`${label}: 读取 asar 失败: ${err.message.split('\n')[0]}`)
    }
  }

  if (isMac) {
    for (const dir of dirs) {
      const label = path.basename(dir)
      const appDir = path.join(dir, 'AiRoute.app')
      const plist = path.join(appDir, 'Contents', 'Info.plist')

      try {
        const meta = execSync(`plutil -extract CFBundleShortVersionString raw -o - "${plist}"`, { encoding: 'utf8' }).trim()
        if (meta !== version) errors.push(`${label}: Info.plist 版本 ${meta} != package.json 的 ${version}`)
      } catch (err) {
        errors.push(`${label}: 读取 Info.plist 版本失败: ${err.message.split('\n')[0]}`)
      }

      // 未公证包至少要有 ad-hoc 签名，签名缺失/失效会导致用户侧直接无法启动
      try {
        execSync(`codesign --verify --deep --strict "${appDir}"`, { stdio: 'pipe' })
        const info = execSync(`codesign -dv --verbose=2 "${appDir}" 2>&1`, { encoding: 'utf8' })
        if (!/Signature=adhoc/.test(info)) errors.push(`${label}: 未检测到 ad-hoc 签名（预期 identity: "-"）`)
      } catch (err) {
        errors.push(`${label}: 签名校验失败（app 将无法启动）: ${err.message.split('\n')[0]}`)
      }
    }

    for (const { name } of builds) {
      const artifact = path.join(buildOutputDir, name)
      try {
        const size = fs.statSync(artifact).size
        if (size < 10 * 1024 * 1024) errors.push(`${name} 体积异常: ${(size / 1024 / 1024).toFixed(1)} MB`)
      } catch (err) {
        errors.push(`未找到 dmg 产物 ${name}: ${err.message.split('\n')[0]}`)
      }
    }
  } else {
    for (const { name } of builds) {
      const exe = path.join(buildOutputDir, name)
      try {
        const meta = execSync(`powershell -NoProfile -Command "(Get-Item '${exe}').VersionInfo.ProductVersion"`, { encoding: 'utf8' }).trim()
        if (meta !== version) errors.push(`${name}: exe 元数据版本 ${meta} != package.json 的 ${version}`)
      } catch (err) {
        errors.push(`${name}: 读取 exe 元数据失败或产物缺失: ${err.message.split('\n')[0]}`)
      }
    }
  }

  if (errors.length) {
    console.error('[aiRoute] ✖ 版本自检未通过：')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(`[aiRoute] ✔ 版本自检通过：${arches.join(' / ')} 的 ${isMac ? 'asar / Info.plist / ad-hoc 签名 / dmg' : 'asar / exe 元数据（安装版与便携版）'}均为 ${version}`)
}

// === 构建流程 ===

console.log(`[aiRoute] 正在清理构建环境...（目标平台: ${targetPlatform}，架构: ${arches.join(' / ')}）`)
killBuildOutputProcesses()
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

  killBuildOutputProcesses()
  cleanDir(buildOutputDir, 'dist-electron')

  // --publish never：electron-builder 检测到在 tag 上构建会隐式 publish（默认 onTagOrDraft），
  // CI 里没有 GH_TOKEN 会直接失败；发布统一交给 workflow 的 gh release，这里显式关掉
  // 架构显式传给 electron-builder：多架构时产物名里的 ${arch} 才能各自展开成独立文件
  const builderArgs = ['electron-builder', '--config', 'electron-builder.json', '--publish', 'never', isMac ? '--mac' : '--win', ...arches.map(arch => `--${arch}`)]

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
    console.log(`[aiRoute] 输出: ${artifacts(version).map(a => `app/dist-electron/${a.name}`).join('、')}`)
    verifyBuild(version)
    syncToRelease()
  })
})
