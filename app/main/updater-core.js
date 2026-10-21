// macOS 一键升级的安装引擎：校验 → 备份 → 原子替换 → 回读 → 失败回滚
// 只做文件系统与系统命令（hdiutil / ditto / plutil / codesign）操作，不依赖 Electron，
// 便于用假命令在临时目录里离线单测；重启应用、journal 与 IPC 由 app/main/updater.js 负责
const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')

// 安装阶段（与渲染进程的阶段文案一一对应）
const STAGE = {
  VERIFY: 'verifying',   // 安装包 SHA-256 校验
  BACKUP: 'backing-up',  // 备份当前 .app
  REPLACE: 'replacing',  // 挂载 dmg + 原子替换
  READBACK: 'readback'   // 新版本回读校验
}

const APP_NAME = 'AiRoute.app'
const OLD_PREFIX = '.airoute-old-'
const STAGE_PREFIX = '.airoute-update-'

// 流式计算文件 SHA-256（大文件不整块读进内存）
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

// 统一 SHA-256 形态：小写、去掉 GitHub API 的 "sha256:" 前缀
function normalizeSha(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '')
}

// 目标路径是否位于指定目录内（防止接口传入任意路径替换任意文件）
function isInside(dir, target) {
  const base = path.resolve(dir)
  const file = path.resolve(target)
  return file === base || file.startsWith(base + path.sep)
}

// 临时目录后缀：同一毫秒内重复升级时避免改名冲突
function randomSuffix() {
  return crypto.randomBytes(3).toString('hex')
}

// 写入探针：/Applications 的权限位不可靠（ACL / 只读卷），直接试写一次更准确
function canWriteDir(dir) {
  try {
    const probe = path.join(dir, `.airoute-write-${process.pid}-${Date.now()}`)
    fs.writeFileSync(probe, '')
    fs.removeSync(probe)
    return true
  } catch {
    return false
  }
}

// 找到 .app 包内的可执行文件（Contents/MacOS 下通常只有一个，优先与包同名）
function findAppBinary(bundle) {
  const macosDir = path.join(bundle, 'Contents', 'MacOS')
  const names = fs.readdirSync(macosDir).filter(n => !n.startsWith('.'))
  if (!names.length) throw new Error('应用包内未找到可执行文件')
  const expected = path.basename(bundle, '.app')
  return path.join(macosDir, names.includes(expected) ? expected : names[0])
}

// 默认命令执行器：失败时把 stderr 拼进错误信息，方便界面直接展示
function defaultRun(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim() || err.message
        err.message = `${cmd} 执行失败：${detail}`
        reject(err)
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

// 读取 .app 的 CFBundleShortVersionString
async function readBundleVersion(run, bundle) {
  const plist = path.join(bundle, 'Contents', 'Info.plist')
  const version = String(await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])).trim()
  if (!version) throw new Error('无法读取应用包版本号')
  return version
}

// 包级校验：版本号 + 代码签名有效；expectedBinaryHash 传入时再校验可执行文件内容
async function verifyBundle({ run, bundle, version, expectedBinaryHash }) {
  const actualVersion = await readBundleVersion(run, bundle)
  if (version && actualVersion !== version) {
    throw new Error(`版本回读不一致：${actualVersion} ≠ ${version}`)
  }
  await run('codesign', ['--verify', '--deep', '--strict', bundle])
  if (expectedBinaryHash) {
    const actualHash = await sha256File(findAppBinary(bundle))
    if (actualHash !== expectedBinaryHash) throw new Error('可执行文件 SHA-256 回读不一致')
  }
  return actualVersion
}

// 挂载 dmg 并把它唯一的 .app 复制到暂存目录（暂存与目标同卷，随后 rename 才是原子的）
async function extractFromDmg({ run, dmg, stageRoot, log }) {
  const mount = path.join(stageRoot, 'mnt')
  fs.ensureDirSync(mount)
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
  try {
    const apps = fs.readdirSync(mount).filter(name => {
      if (name.startsWith('.') || !name.toLowerCase().endsWith('.app')) return false
      try { return fs.statSync(path.join(mount, name)).isDirectory() } catch { return false }
    })
    if (apps.length !== 1) throw new Error(`安装包内应包含唯一的 .app，实际找到 ${apps.length} 个`)
    const staged = path.join(stageRoot, APP_NAME)
    // ditto 保留符号链接、权限与扩展属性；用 fs.copy 复制 .app 会破坏框架内的链接
    await run('ditto', [path.join(mount, apps[0]), staged])
    log(`已从 dmg 解出 ${apps[0]}`)
    return staged
  } finally {
    try { await run('hdiutil', ['detach', mount]) } catch {}
  }
}

// 原子替换：先把旧包改名让开路径，再把暂存包改名到位；第二步失败时立即把旧包改回
async function swapBundles({ target, staged, hooks }) {
  const trash = path.join(path.dirname(target), `${OLD_PREFIX}${Date.now()}-${randomSuffix()}.app`)
  await fs.rename(target, trash)
  try {
    await fs.rename(staged, target)
  } catch (e) {
    try { await fs.rename(trash, target) } catch {}
    throw new Error('替换应用失败：' + e.message)
  }
  if (hooks && hooks.afterSwap) await hooks.afterSwap(target)
  return trash
}

// 回滚：删掉换上去的新包，再把旧包改名回原位
async function restoreBundle(target, trash) {
  await fs.remove(target)
  await fs.rename(trash, target)
}

// 一键升级主流程。返回 { target, backup, trash, version }；旧包暂留在 trash，
// 由下次启动清理（运行中的 .app 不适合当场删除）
async function applyUpdate(options) {
  const {
    target,
    artifactPath,
    sha256,
    version,
    fromVersion,
    updateDir,
    run = defaultRun,
    onStage = () => {},
    hooks = {},
    log = () => {}
  } = options

  const expected = normalizeSha(sha256)
  if (!expected) throw new Error('缺少 SHA-256 校验值，已停止升级')
  if (!isInside(updateDir, artifactPath)) throw new Error('安装包路径非法')
  if (!fs.existsSync(artifactPath)) throw new Error('安装包不存在，请重新下载')
  if (!fs.existsSync(target)) throw new Error('未找到当前应用包：' + target)
  if (!canWriteDir(path.dirname(target))) throw new Error(`没有写入 ${path.dirname(target)} 的权限，请手动下载安装包`)

  // ① 安装包 SHA-256 校验：下载阶段已校验一次，替换前再读盘校验，防止落盘后被改动
  onStage(STAGE.VERIFY)
  const actual = await sha256File(artifactPath)
  if (actual !== expected) throw new Error('安装包 SHA-256 校验失败')
  log(`安装包校验通过 ${expected.slice(0, 12)}…`)

  // ② 备份当前版本：ditto 复制到托管目录，并回读校验旧可执行文件哈希
  onStage(STAGE.BACKUP)
  const backupDir = path.join(updateDir, 'backup')
  fs.ensureDirSync(backupDir)
  const backup = path.join(backupDir, `AiRoute-${fromVersion}.app`)
  const oldBinaryHash = await sha256File(findAppBinary(target))
  await fs.remove(backup)
  await run('ditto', [target, backup])
  const backupHash = await sha256File(findAppBinary(backup))
  if (backupHash !== oldBinaryHash) {
    await fs.remove(backup)
    throw new Error('备份回读校验失败，已停止升级')
  }
  log(`已备份 v${fromVersion} → ${backup}`)

  // ③ 原子替换 + ④ 回读校验
  const stageRoot = path.join(path.dirname(target), `${STAGE_PREFIX}${Date.now()}-${randomSuffix()}`)
  fs.ensureDirSync(stageRoot)
  let trash = ''
  try {
    onStage(STAGE.REPLACE)
    const staged = await extractFromDmg({ run, dmg: artifactPath, stageRoot, log })
    await verifyBundle({ run, bundle: staged, version })
    const stagedHash = await sha256File(findAppBinary(staged))
    log(`暂存包校验通过 v${version}`)

    trash = await swapBundles({ target, staged, hooks })

    onStage(STAGE.READBACK)
    await verifyBundle({ run, bundle: target, version, expectedBinaryHash: stagedHash })
    log('新版本回读校验通过')
  } catch (e) {
    if (trash) {
      try {
        await restoreBundle(target, trash)
        e.rolledBack = true
        log('已自动回滚到上一版本')
      } catch (rollbackError) {
        e.rolledBack = false
        e.message = `${e.message}；自动回滚失败：${rollbackError.message}（备份：${backup}）`
      }
    }
    throw e
  } finally {
    try { await fs.remove(stageRoot) } catch {}
  }

  return { target, backup, trash, version }
}

// 手动回滚到备份版本（用于新版本启动异常时的人工兜底）
async function rollbackToBackup(options) {
  const {
    target,
    backup,
    updateDir,
    run = defaultRun,
    onStage = () => {},
    hooks = {},
    log = () => {}
  } = options

  if (!backup || !fs.existsSync(backup) || !isInside(updateDir, backup)) throw new Error('没有可用的备份')
  if (!fs.existsSync(target)) throw new Error('未找到当前应用包：' + target)
  if (!canWriteDir(path.dirname(target))) throw new Error(`没有写入 ${path.dirname(target)} 的权限`)

  onStage(STAGE.VERIFY)
  const backupVersion = await verifyBundle({ run, bundle: backup })
  const backupHash = await sha256File(findAppBinary(backup))

  const stageRoot = path.join(path.dirname(target), `${STAGE_PREFIX}${Date.now()}-${randomSuffix()}`)
  fs.ensureDirSync(stageRoot)
  let trash = ''
  try {
    onStage(STAGE.REPLACE)
    const staged = path.join(stageRoot, APP_NAME)
    await run('ditto', [backup, staged])
    await verifyBundle({ run, bundle: staged, version: backupVersion, expectedBinaryHash: backupHash })

    trash = await swapBundles({ target, staged, hooks })

    onStage(STAGE.READBACK)
    await verifyBundle({ run, bundle: target, version: backupVersion, expectedBinaryHash: backupHash })
    log(`已回滚到 v${backupVersion}`)
  } catch (e) {
    if (trash) {
      try {
        await restoreBundle(target, trash)
        e.rolledBack = true
      } catch (rollbackError) {
        e.rolledBack = false
        e.message = `${e.message}；回滚失败：${rollbackError.message}`
      }
    }
    throw e
  } finally {
    try { await fs.remove(stageRoot) } catch {}
  }

  return { target, trash, version: backupVersion }
}

module.exports = {
  STAGE,
  APP_NAME,
  OLD_PREFIX,
  STAGE_PREFIX,
  sha256File,
  normalizeSha,
  isInside,
  canWriteDir,
  findAppBinary,
  readBundleVersion,
  verifyBundle,
  defaultRun,
  applyUpdate,
  rollbackToBackup
}
