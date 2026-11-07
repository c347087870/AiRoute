// Windows 安装版一键升级的启动器：以系统自带 PowerShell 作为独立进程，
// 等应用退出后把新版本「覆盖」到安装目录，再把退出码写回 updateDir 供下次启动判定。
//
// 为什么不再让 NSIS 安装包来装（旧实现）：electron-builder 的安装器在升级路径上要先跑
// 旧卸载器——它把 $INSTDIR 里的文件逐个搬到 %TEMP%\old-install，任何一个文件被占用就
// Abort（退出码 2）；且安装器启动时还会 kill 掉 $INSTDIR 下所有 AiRoute.exe，
// 用 AiRoute.exe 当助手必被杀。实测在用户机上出现过「退出码 2」和「安装器跑了但一个
// 文件都没换、应用也没重启」两种表现。
//
// 现在的主路径是 zip 覆盖：CI 额外产出 AiRoute-<版本>-<架构>.zip（win-unpacked 整目录），
// 应用下载校验后由本启动器解压 → robocopy 覆盖安装目录 → 回读 exe 版本 → 拉起应用。
// 没有卸载步骤、不写注册表、不需要 UAC，失败点只有「解压」和「覆盖」两处，且都可回读验证。
// 旧版本没有 zip 资产时仍回落 -setup.exe：此时补上 /D=<安装目录>，避免注册表没有
// InstallLocation 时被装到默认目录。
//
// 脚本落到 .ps1 再 -File 执行，而不是 -Command 传一长串：长命令行经 spawn 传参容易被
// Windows 命令行转义吃掉（实测 PowerShell 直接退 0、一句都没执行）。.ps1 写成 UTF-8 BOM，
// 中文安装路径在 PowerShell 5.1 下才不会读成乱码。
//
// 只依赖 node 内置模块，便于离线单测断言脚本内容
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const EXIT_FILE = 'install-exit.txt' // 放在 updateDir 里：下次启动读一次即可，随托管目录一起清理
const SCRIPT_FILE = 'install-update.ps1'
const WAIT_SECONDS = 60
const EXIT_VERSION_MISMATCH = 9 // 覆盖完但回读版本不对：说明载荷不是这个架构 / 版本

// PowerShell 单引号字符串：内部单引号写成两个，避免路径里的引号截断脚本
function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`
}

// 系统 PowerShell 全路径：不依赖 PATH，用户改坏环境变量也不影响
function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// 等主进程退出：应用自己退出才不会被覆盖动作打断在写盘中途
function waitBlock(pid, waitSeconds, exitFile) {
  return [
    `$appPid = ${Number(pid) || 0}`,
    `$deadline = (Get-Date).AddSeconds(${Number(waitSeconds) || WAIT_SECONDS})`,
    'while ((Get-Process -Id $appPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }',
    // 超时仍存活就不动安装目录：此时覆盖会把应用杀在半路
    `if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) { Set-Content -LiteralPath ${psQuote(exitFile)} -Value -1 -Encoding ascii; exit }`,
    // 主进程消失后再留 2 秒，等 Electron 的渲染/GPU 子进程与文件句柄收干净
    'Start-Sleep -Seconds 2'
  ]
}

// zip 覆盖安装：解压到 %TEMP% 的暂存目录 → robocopy 覆盖 → 回读 exe 版本 → 拉起应用
function zipScript({ pid, artifact, installDir, exe, exitFile, version, waitSeconds = WAIT_SECONDS }) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    ...waitBlock(pid, waitSeconds, exitFile),
    "$stage = Join-Path $env:TEMP 'airoute-update-stage'",
    'Remove-Item -LiteralPath $stage -Recurse -Force',
    'New-Item -ItemType Directory -Path $stage -Force | Out-Null',
    // 系统 tar（bsdtar，Win10 1803+ 自带）比 Expand-Archive 快一个数量级，失败再回落
    `& tar.exe -xf ${psQuote(artifact)} -C $stage`,
    '$tarCode = $LASTEXITCODE',
    `if ($tarCode -ne 0) { Expand-Archive -LiteralPath ${psQuote(artifact)} -DestinationPath $stage -Force }`,
    "$hasExe = Test-Path -LiteralPath (Join-Path $stage 'AiRoute.exe')",
    `if (-not $hasExe) { Set-Content -LiteralPath ${psQuote(exitFile)} -Value 8 -Encoding ascii; Start-Process -FilePath ${psQuote(exe)}; exit }`,
    `& robocopy $stage ${psQuote(installDir)} /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null`,
    '$copyCode = $LASTEXITCODE',
    `if ($copyCode -ge 8) { Set-Content -LiteralPath ${psQuote(exitFile)} -Value $copyCode -Encoding ascii; Start-Process -FilePath ${psQuote(exe)}; exit }`,
    // 回读版本：覆盖完 exe 的 FileVersion 必须等于目标版本，否则宁可报错也不假装成功
    `$version = (Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo.FileVersion`,
    `if ($version -ne ${psQuote(version)}) { Set-Content -LiteralPath ${psQuote(exitFile)} -Value ${EXIT_VERSION_MISMATCH} -Encoding ascii; Start-Process -FilePath ${psQuote(exe)}; exit }`,
    `Set-Content -LiteralPath ${psQuote(exitFile)} -Value 0 -Encoding ascii`,
    'Remove-Item -LiteralPath $stage -Recurse -Force',
    `Start-Process -FilePath ${psQuote(exe)}`
  ].join('\r\n') + '\r\n'
}

// 旧版本没有 zip 资产时回落：静默跑安装包。/D= 必须放最后且不加引号，否则 NSIS 忽略它
function setupScript({ pid, artifact, installDir, exe, exitFile, waitSeconds = WAIT_SECONDS }) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    ...waitBlock(pid, waitSeconds, exitFile),
    `$r = Start-Process -FilePath ${psQuote(artifact)} -ArgumentList '/S','--updated',${psQuote(`/D=${installDir}`)} -Wait -PassThru`,
    '$code = if ($r -and $null -ne $r.ExitCode) { $r.ExitCode } else { -1 }',
    `Set-Content -LiteralPath ${psQuote(exitFile)} -Value $code -Encoding ascii`,
    `Start-Process -FilePath ${psQuote(exe)}`
  ].join('\r\n') + '\r\n'
}

// 按载荷类型选脚本：.zip = 覆盖安装（主路径），-setup.exe = 老版本回落
function buildScript(options) {
  const kind = String(options.kind || payloadKind(options.artifact || options.installer))
  const installDir = options.installDir || path.dirname(String(options.exe || ''))
  if (kind === 'zip') {
    return zipScript({ ...options, installDir })
  }
  return setupScript({ ...options, artifact: options.artifact || options.installer, installDir })
}

// 载荷类型：zip 覆盖 / setup 安装包
function payloadKind(filePath) {
  return /\.zip$/i.test(String(filePath || '')) ? 'zip' : 'setup'
}

// 写脚本文件：带 BOM，PowerShell 5.1 才按 UTF-8 解析（否则中文路径变乱码）
function writeScript(file, content) {
  fs.writeFileSync(file, '\ufeff' + content, 'utf8')
  return file
}

// 不 detach、只 unref：Windows 上子进程不会随父进程退出，应用退出后启动器照常跑。
// 反过来 detach（DETACHED_PROCESS）会让 PowerShell 5.1 在没有控制台时直接退出、脚本一句都不执行
// （实测：detached 下 Set-Content 从未落盘），所以这里必须用普通子进程。
function spawnLauncher({ scriptPath, spawnFn = spawn, psPath = powershellPath(), env = process.env }) {
  const child = spawnFn(psPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    stdio: 'ignore',
    windowsHide: true,
    env
  })
  if (child && typeof child.unref === 'function') child.unref()
  return child
}

module.exports = {
  EXIT_FILE,
  SCRIPT_FILE,
  WAIT_SECONDS,
  EXIT_VERSION_MISMATCH,
  psQuote,
  powershellPath,
  payloadKind,
  buildScript,
  writeScript,
  spawnLauncher
}
