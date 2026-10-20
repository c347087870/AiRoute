// 上传前版本检查：校验 package.json / asar / 平台产物元数据 / CHANGELOG 版本一致
// 用法：node scripts/verify-release.js（退出码 0 = 全部通过；非 0 = 存在失败项）
//   Windows：校验 exe 元数据（powershell）
//   macOS  ：校验 Info.plist 版本、ad-hoc 签名、dmg 产物
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
const isMac = process.platform === 'darwin'
const macAppRel = 'app/dist-electron/mac-arm64/AiRoute.app'
const macAssetName = `AiRoute-${version}-arm64.dmg`
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

// macOS：ad-hoc 签名必须存在且有效（缺失会导致 Apple Silicon 上无法启动）
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

// ① asar 内应用 package.json 版本
const asarRel = isMac ? `${macAppRel}/Contents/Resources/app.asar` : path.join('app', 'dist-electron', 'win-unpacked', 'resources', 'app.asar')
try {
  const raw = fs.readFileSync(path.join(root, asarRel)).toString('latin1')
  const m = raw.match(/"name":\s*"aiRoute",\s*"version":\s*"([^"]+)"/)
  check('asar 内 package.json 版本', !!m && m[1] === version, m ? m[1] : '未找到')
} catch (err) {
  check('asar 内 package.json 版本', false, err.message)
}

// ② 平台产物元数据（打包输出 + release 同步目录）
if (isMac) {
  readMacMeta(macAppRel)
  readMacMeta('app/release/mac-arm64/AiRoute.app')
  checkMacSignature(macAppRel)
} else {
  readMeta(path.join('app', 'dist-electron', 'AiRoute.exe'))
  readMeta(path.join('app', 'release', 'AiRoute.exe'))
}

// ③ CHANGELOG 顶部版本段落
try {
  const top = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n').find(l => l.startsWith('## ['))
  check('CHANGELOG 顶部版本', !!top && top.includes(`[${version}]`), top || '未找到')
} catch (err) {
  check('CHANGELOG 顶部版本', false, err.message)
}

// ④ release 产物大小与 SHA256（发布说明中需与上传资产一致）
const assetName = isMac ? macAssetName : 'AiRoute.exe'
const assetPath = path.join(root, 'app', 'release', assetName)
let sha = ''
try {
  const size = fs.statSync(assetPath).size
  const minSize = isMac ? 10 * 1024 * 1024 : 1024 * 1024
  check(`release/${assetName} 大小`, size > minSize, `${(size / 1024 / 1024).toFixed(1)} MB`)
  sha = execSync(isMac ? `shasum -a 256 "${assetPath}"` : `powershell -NoProfile -Command "(Get-FileHash '${assetPath}' -Algorithm SHA256).Hash"`, { encoding: 'utf8' }).trim()
  if (isMac) sha = sha.split(/\s+/)[0]
} catch (err) {
  check(`release/${assetName} 大小`, false, err.message.split('\n')[0])
}

let failed = 0
console.log(`基线版本（package.json）: ${version}（平台 ${isMac ? 'macOS/arm64' : 'Windows'}）\n`)
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✖'} ${r.name}: ${r.detail}`)
  if (!r.ok) failed++
}
if (sha) console.log(`\nSHA256: ${sha}`)
console.log(failed ? `\n共 ${failed} 项未通过，禁止上传` : '\n全部通过，可以上传')
process.exit(failed ? 1 : 0)
