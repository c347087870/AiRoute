// 安装构建好的 AiRoute.app 到 /Applications（覆盖旧版本但保留用户数据）
// 用法：npm run install:mac [-- --dmg path/to/AiRoute.dmg]
// 数据目录在 ~/Library/Application Support/AiRoute/data，替换应用不会影响它
const { execFileSync, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const root = path.resolve(__dirname, '..')
const buildOutputDir = path.join(root, 'app', 'dist-electron')
const targetPath = '/Applications/AiRoute.app'

function log(msg) {
  console.log(`[install] ${msg}`)
}

function fail(msg) {
  console.error(`[install] ✖ ${msg}`)
  process.exit(1)
}

// 在 dist-electron 下递归查找 .app（electron-builder 输出在 mac/ 子目录）
function findApp() {
  const stack = [buildOutputDir]
  while (stack.length) {
    const dir = stack.pop()
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith('.app')) {
        if (fs.existsSync(path.join(full, 'Contents', 'MacOS'))) return full
        continue
      }
      if (dir === buildOutputDir) stack.push(full)
    }
  }
  return null
}

// 只结束正在运行的 AiRoute，不碰用户其它 Electron 进程
function quitRunningApp() {
  try {
    execSync('osascript -e \'quit app "AiRoute"\'', { stdio: 'pipe' })
  } catch {}
  // 等待进程真正退出，最多 5 秒
  for (let i = 0; i < 50; i++) {
    try {
      execSync('pgrep -f "AiRoute.app/Contents/MacOS/AiRoute"', { stdio: 'pipe' })
      execSync('sleep 0.1')
    } catch {
      return
    }
  }
  try {
    execSync('pkill -f "AiRoute.app/Contents/MacOS/AiRoute"', { stdio: 'pipe' })
  } catch {}
}

function installApp(appPath) {
  quitRunningApp()
  log(`正在安装到 ${targetPath}`)
  try {
    fs.rmSync(targetPath, { recursive: true, force: true })
    fs.cpSync(appPath, targetPath, { recursive: true, verbatimSymlinks: true })
  } catch (err) {
    fail(`复制失败: ${err.message}\n如果是权限问题，请改用：sudo cp -R "${appPath}" /Applications/`)
  }

  // 无开发者签名：做 ad-hoc 签名，避免 macOS 把应用当作损坏文件
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', targetPath], { stdio: 'pipe' })
    log('已完成 ad-hoc 签名')
  } catch (err) {
    console.warn('[install] ⚠ ad-hoc 签名失败（不影响通过右键打开方式启动）:', err.message.split('\n')[0])
  }

  // 构建产物是本机生成的，一般没有 quarantine；从网络下载的 dmg 才会有
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', targetPath], { stdio: 'pipe' })
    log('已清除 quarantine 标记')
  } catch {}
}

function main() {
  if (process.platform !== 'darwin') fail('该脚本仅适用于 macOS')

  const dmgArg = process.argv.indexOf('--dmg')
  if (dmgArg !== -1) {
    const dmg = process.argv[dmgArg + 1]
    if (!dmg || !fs.existsSync(dmg)) fail('指定的 dmg 不存在')
    fail(`请先手动打开 dmg 并把 AiRoute 拖入「应用程序」。本脚本用于安装已解包的 .app（${dmg}）`)
  }

  const appPath = findApp()
  if (!appPath) {
    fail('未找到打包后的 .app，请先运行：npm run build:mac')
  }
  log(`找到应用: ${appPath}`)
  installApp(appPath)
  log(`安装完成，正在打开 ${targetPath}`)
  try {
    // 用绝对路径：脚本被 Electron 主进程以 ELECTRON_RUN_AS_NODE 调起时 PATH 可能不含 /usr/bin
    execFileSync('/usr/bin/open', [targetPath], { stdio: 'ignore' })
  } catch (err) {
    console.warn('[install] ⚠ 自动打开失败，请手动启动：', err.message.split('\n')[0])
  }
  log('用户数据保留在 ~/Library/Application Support/AiRoute/data')
}

main()
