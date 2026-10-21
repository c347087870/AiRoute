// 构建目标（平台 / 架构 / 产物命名）的单一事实来源，build.js 与 verify-release.js 共用：
// - 架构列表从 electron-builder.json 的 target.arch 读取，脚本与打包配置不会各写一份
// - 产物名对应 electron-builder.json 的 artifactName 模板 AiRoute-${version}-${arch}.${ext}
// 注意：server/update.js 的应用内更新按同一规则拼下载地址，改命名时两处必须同步
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const builderConfig = require(path.join(root, 'electron-builder.json'))

const platform = process.platform === 'darwin' ? 'mac' : 'win'
const isMac = platform === 'mac'
const ext = isMac ? 'dmg' : 'exe'

// electron-builder 的 target 既可以是字符串，也可以是 { target, arch } 对象
function configuredArches() {
  const section = builderConfig[platform] || {}
  const targets = Array.isArray(section.target) ? section.target : [section.target]
  const arches = []
  for (const target of targets) {
    for (const arch of (target && target.arch) || []) {
      if (!arches.includes(arch)) arches.push(arch)
    }
  }
  return arches
}

// 目标架构：始终取 electron-builder.json 里 target.arch 配置的全部架构。
// 注意不能在脚本里用 --x64 / --arm64 收窄——electron-builder 的 target.arch 优先级高于 CLI 架构参数，
// 传了也只会出一半产物却让人误以为只构建了一个架构（实测确认）
function targetArches() {
  const arches = configuredArches()
  return arches.length ? arches : [process.arch === 'arm64' ? 'arm64' : 'x64']
}

function artifactName(version, arch) {
  const v = String(version).replace(/^v/i, '')
  return `AiRoute-${v}-${arch}.${ext}`
}

// asar 路径（解包目录 → 应用包内 asar）
function asarPath(dir) {
  return isMac
    ? path.join(dir, 'AiRoute.app', 'Contents', 'Resources', 'app.asar')
    : path.join(dir, 'resources', 'app.asar')
}

// 解包目录：不写死 mac-arm64 / win-unpacked 这类 electron-builder 内部命名
// （x64 是默认架构，目录不带后缀；arm64 才带 -arm64），统一按「目录里有 app.asar」识别
function unpackedDirs(outDir) {
  if (!fs.existsSync(outDir)) return []
  return fs.readdirSync(outDir)
    .map(name => path.join(outDir, name))
    .filter(full => {
      try {
        if (!fs.statSync(full).isDirectory()) return false
      } catch {
        return false
      }
      return fs.existsSync(asarPath(full))
    })
}

module.exports = { root, platform, isMac, ext, configuredArches, targetArches, artifactName, asarPath, unpackedDirs }
