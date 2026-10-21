// 上传前版本检查：校验 package.json / asar / 平台产物元数据 / CHANGELOG 版本一致
// 用法：node scripts/verify-release.js（退出码 0 = 全部通过；非 0 = 存在失败项）
//   Windows：校验每个架构的安装版（-setup.exe）与便携版 exe 元数据（powershell）
//   macOS  ：校验每个架构 Info.plist 版本、ad-hoc 签名、dmg 产物
// 目标与产物命名取自 scripts/targets.js（源头是 electron-builder.json 的 target / artifactName）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const { root, isMac, targetArches, artifacts, asarPath, unpackedDirs } = require('./targets')

const version = require(path.join(root, 'package.json')).version
const arches = targetArches()
const builds = artifacts(version)
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

function readMeta(rel) {
  const p = path.join(root, rel)
  try {
    const meta = execSync(`powershell -NoProfile -Command "(Get-Item '${p}').VersionInfo.ProductVersion"`, { encoding: 'utf8' }).trim()
    check(`${rel} 元数据版本`, meta === version, meta || '（空）')
  } catch (err) {
    check(`${rel} 元数据版本`, false, err.message.split('\n')[0])
  }
}

// macOS：读取 app bundle 的 Info.plist 版本
function readMacMeta(rel) {
  const plist = path.join(root, rel, 'Contents', 'Info.plist')
  try {
    const meta = execSync(`plutil -extract CFBundleShortVersionString raw -o - "${plist}"`, { encoding: 'utf8' }).trim()
    check(`${rel} Info.plist 版本`, meta === version, meta || '（空）')
  } catch (err) {
    check(`${rel} Info.plist 版本`, false, err.message.split('\n')[0])
  }
}

// macOS：ad-hoc 签名必须存在且有效（缺失会导致 Apple Silicon / Intel 上都无法启动）
function checkMacSignature(rel) {
  const appPath = path.join(root, rel)
  try {
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'pipe' })
    const info = execSync(`codesign -dv --verbose=2 "${appPath}" 2>&1`, { encoding: 'utf8' })
    check(`${rel} ad-hoc 签名`, /Signature=adhoc/.test(info), /Signature=adhoc/.test(info) ? 'adhoc' : '非 ad-hoc')
  } catch (err) {
    check(`${rel} ad-hoc 签名`, false, err.message.split('\n')[0])
  }
}

// ① asar 内应用 package.json 版本（打包输出 + release 同步目录，逐架构）
for (const outDir of ['app/dist-electron', 'app/release']) {
  const dirs = unpackedDirs(path.join(root, outDir))
  check(`${outDir} 解包目录数量`, dirs.length > 0, dirs.length ? dirs.map(d => path.basename(d)).join(' / ') : '未找到')
  for (const dir of dirs) {
    const rel = path.relative(root, dir)
    try {
      const raw = fs.readFileSync(asarPath(dir)).toString('latin1')
      const m = raw.match(/"name":\s*"aiRoute",\s*"version":\s*"([^"]+)"/)
      check(`${rel}/app.asar 内版本`, !!m && m[1] === version, m ? m[1] : '未找到')
    } catch (err) {
      check(`${rel}/app.asar 内版本`, false, err.message.split('\n')[0])
    }
  }
}

// ② 平台产物元数据（打包输出 + release 同步目录），逐架构
if (isMac) {
  for (const outDir of ['app/dist-electron', 'app/release']) {
    for (const dir of unpackedDirs(path.join(root, outDir))) {
      const rel = path.join(path.relative(root, dir), 'AiRoute.app')
      readMacMeta(rel)
      checkMacSignature(rel)
    }
  }
} else {
  for (const { name } of builds) {
    for (const outDir of ['app/dist-electron', 'app/release']) {
      readMeta(path.join(outDir, name))
    }
  }
}

// ③ CHANGELOG 顶部版本段落
try {
  const top = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n').find(l => l.startsWith('## ['))
  check('CHANGELOG 顶部版本', !!top && top.includes(`[${version}]`), top || '未找到')
} catch (err) {
  check('CHANGELOG 顶部版本', false, err.message)
}

// ④ release 产物大小与 SHA256（发布说明中需与上传资产一致），逐个产物
// 用 node 自带 crypto 计算：Windows 上 powershell 的 Get-FileHash 会因模块未自动加载而失败
const minSize = isMac ? 10 * 1024 * 1024 : 1024 * 1024
const shas = []
for (const { name } of builds) {
  const assetPath = path.join(root, 'app', 'release', name)
  try {
    const size = fs.statSync(assetPath).size
    check(`release/${name} 大小`, size > minSize, `${(size / 1024 / 1024).toFixed(1)} MB`)
    const sha = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex')
    shas.push(`${sha}  ${name}`)
  } catch (err) {
    check(`release/${name} 大小`, false, err.message.split('\n')[0])
  }
}

let failed = 0
console.log(`基线版本（package.json）: ${version}（平台 ${isMac ? 'macOS' : 'Windows'}，架构 ${arches.join(' / ')}，产物 ${builds.map(b => b.target).join(' / ')}）\n`)
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✖'} ${r.name}: ${r.detail}`)
  if (!r.ok) failed++
}
if (shas.length) console.log(`\nSHA256:\n${shas.join('\n')}`)
console.log(failed ? `\n共 ${failed} 项未通过，禁止上传` : '\n全部通过，可以上传')
process.exit(failed ? 1 : 0)
