// electron-builder afterPack 钩子：
// 1. 修复 node-pty 的 spawn-helper 可执行位（npm 解包后常是 644，PTY 会启动失败）
// 2. macOS 无 Developer ID 时做 ad-hoc 签名
// 背景：identity 设为 null 会完全跳过签名，未签名的 .app 在别的 Mac 上
// （尤其 Apple Silicon）通过 dmg 安装后常被 Gatekeeper 判为「已损坏」。
// ad-hoc 签名不能通过公证，但至少保留可执行完整性，配合右键打开即可运行。
// 注意：electron-builder 在 afterPack 之后才会翻转 electronFuses，本项目未启用
// fuses，因此签名不会被后续步骤破坏；若将来启用 fuses，需要把签名移到 afterSign。
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// node-pty 被打包进 app.asar.unpacked；development 依赖也放在 node_modules 下
function chmodPtyHelpers(resourcesDir) {
  const root = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty')
  if (!fs.existsSync(root)) {
    console.warn('[aiRoute] ⚠ 未找到解包后的 node-pty，终端功能在产物中可能不可用')
    return
  }
  const stack = [root]
  let count = 0
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.name !== 'spawn-helper') continue
      try {
        fs.chmodSync(full, 0o755)
        count++
      } catch (err) {
        console.warn(`[aiRoute] ⚠ 无法修改 ${full} 权限: ${err.message}`)
      }
    }
  }
  if (count) console.log(`[aiRoute] 已修复 ${count} 个 node-pty spawn-helper 可执行位`)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  // 先改权限再签名，否则签名后修改文件属性会使签名失效
  chmodPtyHelpers(path.join(appPath, 'Contents', 'Resources'))
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' })
    console.log(`[aiRoute] 已对 ${appName}.app 做 ad-hoc 签名`)
  } catch (err) {
    // 签名失败不阻断打包：用户仍可通过右键打开运行
    console.warn(`[aiRoute] ⚠ ad-hoc 签名失败: ${String(err.message).split('\n')[0]}`)
  }
}
