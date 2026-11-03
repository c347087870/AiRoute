// Windows 安装版一键升级的启动器：以系统自带 PowerShell 作为独立进程，
// 等应用退出后静默运行安装包，再把退出码写回 updateDir 供下次启动判定。
//
// 为什么不用 Electron 当助手（旧实现）：electron-builder 的 NSIS 安装器启动时会 kill 掉
// $INSTDIR 下所有 AiRoute.exe（allowOnlyOneInstallerInstance.nsh 的 CHECK_APP_RUNNING 按
// 安装目录路径前缀匹配）。用 AiRoute.exe 以 ELECTRON_RUN_AS_NODE 跑助手，必然被安装器杀掉：
// 实测会留下「exe 仍是旧版本、其余文件已是新版」的半升级状态，或让安装器拿不到卸载结果
// 而以退出码 2 收场。powershell.exe 在系统目录，不在 $INSTDIR 内，不会被这条规则波及。
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

// PowerShell 单引号字符串：内部单引号写成两个，避免路径里的引号截断脚本
function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`
}

// 系统 PowerShell 全路径：不依赖 PATH，用户改坏环境变量也不影响
function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// 启动器脚本：
//   1. 轮询主进程 PID 直到消失（应用自己退出才不会被安装器打断在写盘中途）；
//   2. 超时仍存活就写 -1 并且不碰安装包——此时强装会把应用杀在半路；
//   3. 再等 2 秒收句柄（卸载器要逐文件搬走 $INSTDIR，任一文件被占用就整轮 Abort）；
//   4. 跑 安装包 /S --updated，把退出码写盘；
//   5. 无论成功失败都拉起应用：静默安装不会执行 runAfterFinish，不拉就是「升级完窗口没了」。
function buildScript({ pid, installer, exe, exitFile, waitSeconds = WAIT_SECONDS }) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$appPid = ${Number(pid) || 0}`,
    `$deadline = (Get-Date).AddSeconds(${Number(waitSeconds) || WAIT_SECONDS})`,
    'while ((Get-Process -Id $appPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }',
    `if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) { Set-Content -LiteralPath ${psQuote(exitFile)} -Value -1 -Encoding ascii; exit }`,
    'Start-Sleep -Seconds 2',
    `$r = Start-Process -FilePath ${psQuote(installer)} -ArgumentList '/S','--updated' -Wait -PassThru`,
    '$code = if ($r -and $null -ne $r.ExitCode) { $r.ExitCode } else { -1 }',
    `Set-Content -LiteralPath ${psQuote(exitFile)} -Value $code -Encoding ascii`,
    `Start-Process -FilePath ${psQuote(exe)}`
  ].join('\r\n') + '\r\n'
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

module.exports = { EXIT_FILE, SCRIPT_FILE, WAIT_SECONDS, psQuote, powershellPath, buildScript, writeScript, spawnLauncher }
