// 构建目标（平台 / 架构 / 产物命名）的单一事实来源，build.js 与 verify-release.js 共用：
// - 架构列表从 electron-builder.json 的 target.arch 读取，脚本与打包配置不会各写一份
// - 产物名从 electron-builder.json 的 artifactName 模板展开（Windows 有安装版与便携版两类产物，
//   分别由 nsis / portable 的 artifactName 指定），改命名时只改打包配置，再同步 server/update.js
//   的应用内更新拼名规则（离线测试 test-update.js 会锁死这条约定）
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const builderConfig = require(path.join(root, 'electron-builder.json'))

const platform = process.platform === 'darwin' ? 'mac' : 'win'
const isMac = platform === 'mac'
const ext = isMac ? 'dmg' : 'exe'

// electron-builder 的 target 既可以是字符串，也可以是 { target, arch } 对象
function platformTargets() {
  const section = builderConfig[platform] || {}
  const targets = Array.isArray(section.target) ? section.target : [section.target]
  return targets.filter(Boolean)
}

function configuredArches() {
  const arches = []
  for (const target of platformTargets()) {
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

// 目标 × 架构：每个 target 取自己的 arch 列表，缺省时回落到全部架构
function targetArchs() {
  const list = []
  for (const target of platformTargets()) {
    const name = typeof target === 'string' ? target : target.target
    if (!name) continue
    const arches = typeof target === 'string' || !Array.isArray(target.arch) || !target.arch.length ? targetArches() : target.arch
    for (const arch of arches) list.push({ target: name, arch })
  }
  if (!list.length) for (const arch of targetArches()) list.push({ target: platform === 'mac' ? 'dmg' : 'portable', arch })
  return list
}

// nsis / portable 是「目标专属配置」，electron-builder 允许写在顶层（所有平台共用）或平台段下
function targetOptions(name) {
  const section = builderConfig[platform] || {}
  return { ...(builderConfig[name] || {}), ...(section[name] || {}) }
}

// 产物名模板优先级与 electron-builder 一致：目标专属 > 平台 > 全局
function artifactPattern(target) {
  const section = builderConfig[platform] || {}
  return targetOptions(target).artifactName || section.artifactName || builderConfig.artifactName
}

// electron-builder 支持 ${version} / ${arch} / ${ext} 等宏；这里只需要用到这三个，
// 出现其他宏说明命名规则变了，直接报错而不是静默产出错名字
function expandTemplate(template, version, arch) {
  const v = String(version).replace(/^v/i, '')
  const values = { version: v, arch, ext }
  const name = String(template).replace(/\$\{(\w+)\}/g, (matched, key) => (key in values ? values[key] : matched))
  if (/\$\{\w+\}/.test(name)) throw new Error(`artifactName 模板里有未支持的宏：${template}`)
  return name
}

// 全部产物：Windows 为每个架构的安装版 + 便携版，macOS 为每个架构的 dmg
function artifacts(version) {
  return targetArchs().map(({ target, arch }) => ({
    target,
    arch,
    name: expandTemplate(artifactPattern(target), version, arch)
  }))
}

function artifactsFor(version, arch) {
  return artifacts(version).filter(artifact => artifact.arch === arch)
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

module.exports = { root, platform, isMac, ext, configuredArches, targetArches, targetArchs, artifacts, artifactsFor, asarPath, unpackedDirs }
