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

// ===== 手动覆盖安装（Windows 稳定路径）=====
//
// 自动启动器依赖「应用退出后子进程还活着」这个前提；在某些机器/安全软件下不成立，
// 表现是升级包下载完了却什么都没发生。这里改成用户自己双击的脚本：
//   · 应用关闭后运行，不存在父子进程生命周期问题；
//   · 不跑 NSIS 安装器、不碰卸载器、不写 HKLM、不需要 UAC；
//   · 只解压 zip → robocopy 覆盖安装目录 → 回读 FileVersion → 拉起应用。
// zip 也可以从浏览器下载后直接拖到 install-update.cmd 上使用。
const MANUAL_CMD = 'install-update.cmd'
const MANUAL_AUTO_CMD = 'install-update-auto.cmd'
const MANUAL_PS1 = 'apply-update.ps1'
const MANUAL_README = 'README.txt'

function manualPs1({ artifact, installDir, exe, version, logFile }) {
  const zipName = path.basename(String(artifact || ''))
  const logPath = logFile || 'install-update.log'
  return [
    'param([Parameter(Position=0)][string]$Zip = "")',
    "$ErrorActionPreference = 'Stop'",
    '$here = Split-Path -Parent $MyInvocation.MyCommand.Path',
    `$targetExe = ${psQuote(exe)}`,
    `$installDir = ${psQuote(installDir)}`,
    `$expected = ${psQuote(version)}`,
    `$log = Join-Path $here ${psQuote(logPath)}`,
    `if ([string]::IsNullOrWhiteSpace($Zip)) { $Zip = Join-Path $here ${psQuote(zipName)} }`,
    'function Write-Log([string]$text) {',
    '  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $text',
    '  Write-Host $line',
    '  Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue',
    '}',
    'Write-Host ""',
    'Write-Host "AiRoute 覆盖安装" -ForegroundColor Cyan',
    'Write-Host ("目标目录：" + $installDir)',
    'Write-Host ("目标版本：" + $expected)',
    'Write-Host ""',
    'if (-not (Test-Path -LiteralPath $Zip)) { Write-Log ("找不到更新包：" + $Zip); exit 2 }',
    '# 等应用退出：用户可能直接双击脚本，也可能先关闭；两种都覆盖',
    '$deadline = (Get-Date).AddMinutes(3)',
    'while ($true) {',
    "  $running = @(Get-Process -Name 'AiRoute' -ErrorAction SilentlyContinue | Where-Object {",
    '    try { $_.Path -and $_.Path.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }',
    '  })',
    '  if ($running.Count -eq 0) { break }',
    '  Write-Host "检测到 AiRoute 正在运行，请从托盘图标退出（关闭窗口只是最小化）..." -ForegroundColor Yellow',
    '  Start-Sleep -Seconds 3',
    '  if ((Get-Date) -gt $deadline) { Write-Log "等待 AiRoute 退出超时"; exit 3 }',
    '}',
    'Start-Sleep -Seconds 2',
    "$stage = Join-Path $env:TEMP ('airoute-update-' + [guid]::NewGuid().ToString('N'))",
    'New-Item -ItemType Directory -Path $stage -Force | Out-Null',
    '$code = 0',
    'try {',
    '  Write-Log ("解压更新包：" + $Zip)',
    '  & tar.exe -xf $Zip -C $stage',
    '  if ($LASTEXITCODE -ne 0) { Write-Log "tar 解压失败，改用 Expand-Archive"; Expand-Archive -LiteralPath $Zip -DestinationPath $stage -Force }',
    "  $stagedExe = Join-Path $stage 'AiRoute.exe'",
    "  if (-not (Test-Path -LiteralPath $stagedExe)) { throw '更新包不完整：解压后找不到 AiRoute.exe' }",
    '  $stagedVersion = (Get-Item -LiteralPath $stagedExe).VersionInfo.FileVersion',
    '  if ($stagedVersion -ne $expected) { throw "更新包版本是 $stagedVersion，期望 $expected" }',
    '  Write-Log "覆盖安装目录：$installDir"',
    '  & robocopy $stage $installDir /E /R:5 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null',
    '  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）" }',
    '  $installedVersion = (Get-Item -LiteralPath $targetExe).VersionInfo.FileVersion',
    '  if ($installedVersion -ne $expected) { throw "覆盖后版本仍为 $installedVersion" }',
    '  # 同步「应用和功能」里的版本号与安装目录：zip 覆盖不会改注册表，不改会一直显示旧版本',
    "  $keys = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {",
    '    Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
    '  } | Where-Object { $_.DisplayIcon -and ($_.DisplayIcon -like ($installDir + "*")) })',
    '  foreach ($key in $keys) {',
    '    Set-ItemProperty -LiteralPath $key.PSPath -Name DisplayVersion -Value $expected -ErrorAction SilentlyContinue',
    '    Set-ItemProperty -LiteralPath $key.PSPath -Name DisplayName -Value ("AiRoute " + $expected) -ErrorAction SilentlyContinue',
    '    Set-ItemProperty -LiteralPath $key.PSPath -Name InstallLocation -Value $installDir -ErrorAction SilentlyContinue',
    '  }',
    '  Write-Log ("更新成功：v" + $expected)',
    '} catch {',
    '  $code = 4',
    '  Write-Log ("更新失败：" + $_.Exception.Message)',
    '  Write-Log ("更新包保留在：" + $Zip)',
    '} finally {',
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '}',
    'if ($code -eq 0) {',
    '  Write-Host "正在启动 AiRoute..." -ForegroundColor Green',
    '  try { Start-Process -FilePath $targetExe } catch { $code = 5; Write-Log ("启动失败：" + $_.Exception.Message) }',
    '}',
    'exit $code'
  ].join('\r\n') + '\r\n'
}

function manualCmd(zipName, { auto = false } = {}) {
  const lines = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'if "%~1"=="" (set "ZIP=%~dp0' + String(zipName || '').replace(/"/g, '') + '") else (set "ZIP=%~1")',
    'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0' + MANUAL_PS1 + '" "%ZIP%"',
    'echo.'
  ]
  if (auto) {
    // App 内的「立即安装」走这个：成功时直接退出（脚本会把新版本拉起来），
    // 失败时停住窗口，用户能看到原因 / install-update.log
    lines.push('if errorlevel 1 (echo Update failed. See install-update.log. & pause)')
  } else {
    lines.push('echo Update finished. Press any key to close this window.')
    lines.push('pause >nul')
  }
  return lines.join('\r\n') + '\r\n'
}

function manualReadme({ version, installDir }) {
  return [
    'AiRoute 覆盖安装',
    '',
    `目标版本：${version}`,
    `安装目录：${installDir}`,
    '',
    '使用步骤：',
    '1. 退出 AiRoute（托盘图标右键 → 退出；直接关窗口只会最小化）；',
    `2. 双击本文件夹里的 ${MANUAL_CMD}；`,
    '3. 脚本会等待 AiRoute 退出，然后解压更新包、覆盖安装目录并重新启动；',
    '4. 看到「更新成功」即完成，失败时把 install-update.log 发给开发者。',
    '',
    '如果更新包是通过浏览器下载的：把 zip 文件拖到 install-update.cmd 上也可以，',
    '脚本会自动使用拖入的文件并核对版本。',
    ''
  ].join('\r\n')
}

function writeManualUpdater({ artifact, installDir, exe, version }) {
  const folder = path.dirname(artifact)
  const ps1Path = path.join(folder, MANUAL_PS1)
  const cmdPath = path.join(folder, MANUAL_CMD)
  const autoCmdPath = path.join(folder, MANUAL_AUTO_CMD)
  const readmePath = path.join(folder, MANUAL_README)
  fs.mkdirSync(folder, { recursive: true })
  // PS1 带 BOM：PowerShell 5.1 才按 UTF-8 解析中文（安装目录可能含中文）
  fs.writeFileSync(ps1Path, '\ufeff' + manualPs1({ artifact, installDir, exe, version }), 'utf8')
  // CMD 内容全 ASCII：cmd.exe 按系统 OEM 代码页解析，中文写进去容易乱码
  fs.writeFileSync(cmdPath, manualCmd(path.basename(artifact)), 'ascii')
  fs.writeFileSync(autoCmdPath, manualCmd(path.basename(artifact), { auto: true }), 'ascii')
  fs.writeFileSync(readmePath, manualReadme({ version, installDir }), 'utf8')
  return { folder, ps1Path, cmdPath, autoCmdPath, readmePath }
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

// App 内「立即安装」的启动器：直接拉起 cmd.exe，由它执行 install-update-auto.cmd。
// 必须是 detached：cmd.exe 是原生进程，创建独立进程组后不会被 Electron 退出回收
// （直接 spawn powershell.exe 时实测会被回收，这也是旧一键升级失败的主因）。
// windowsHide=false：覆盖安装期间保留一个控制台窗口显示进度；失败时窗口不会自动关。
function spawnAutoUpdater({ cmdPath, spawnFn = spawn, env = process.env }) {
  const comspec = env.ComSpec || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  const child = spawnFn(comspec, ['/d', '/c', cmdPath], {
    cwd: path.dirname(cmdPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
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
  MANUAL_CMD,
  MANUAL_AUTO_CMD,
  MANUAL_PS1,
  MANUAL_README,
  psQuote,
  powershellPath,
  payloadKind,
  buildScript,
  manualPs1,
  manualCmd,
  manualReadme,
  writeManualUpdater,
  writeScript,
  spawnLauncher,
  spawnAutoUpdater
}
