// 上传前版本检查：校验 package.json / asar / exe 元数据 / CHANGELOG 版本一致
// 用法：node scripts/verify-release.js（退出码 0 = 全部通过；非 0 = 存在失败项）
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.join(__dirname, '..')
const version = require(path.join(root, 'package.json')).version
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

// ① asar 内应用 package.json 版本
try {
  const asarPath = path.join(root, 'app', 'dist-electron', 'win-unpacked', 'resources', 'app.asar')
  const raw = fs.readFileSync(asarPath).toString('latin1')
  const m = raw.match(/"name":\s*"aiRoute",\s*"version":\s*"([^"]+)"/)
  check('asar 内 package.json 版本', !!m && m[1] === version, m ? m[1] : '未找到')
} catch (err) {
  check('asar 内 package.json 版本', false, err.message)
}

// ② exe 元数据（打包输出 + release 同步目录）
readMeta('app\\dist-electron\\AiRoute.exe')
readMeta('app\\release\\AiRoute.exe')

// ③ CHANGELOG 顶部版本段落
try {
  const top = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split('\n').find(l => l.startsWith('## ['))
  check('CHANGELOG 顶部版本', !!top && top.includes(`[${version}]`), top || '未找到')
} catch (err) {
  check('CHANGELOG 顶部版本', false, err.message)
}

// ④ release/AiRoute.exe 大小与 SHA256（发布说明中需与上传资产一致）
let sha = ''
try {
  const relExe = path.join(root, 'app', 'release', 'AiRoute.exe')
  const size = fs.statSync(relExe).size
  check('release/AiRoute.exe 大小', size > 1024 * 1024, `${(size / 1024 / 1024).toFixed(1)} MB`)
  sha = execSync(`powershell -NoProfile -Command "(Get-FileHash '${relExe}' -Algorithm SHA256).Hash"`, { encoding: 'utf8' }).trim()
} catch (err) {
  check('release/AiRoute.exe 大小', false, err.message.split('\n')[0])
}

let failed = 0
console.log(`基线版本（package.json）: ${version}\n`)
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✖'} ${r.name}: ${r.detail}`)
  if (!r.ok) failed++
}
if (sha) console.log(`\nSHA256: ${sha}`)
console.log(failed ? `\n共 ${failed} 项未通过，禁止上传` : '\n全部通过，可以上传')
process.exit(failed ? 1 : 0)
