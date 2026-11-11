// 一键升级离线测试：校验值解析 / 版本比较 / 产物命名 / macOS 安装链路与回滚 /
// Windows 安装版助手链路（安装包校验 → 独立助手等待退出 → 静默安装 → 重启）
// 运行：node scripts/test-update.js
// 全部使用临时目录与假命令 / 假 spawn，不触碰真实应用包，也不会真的运行安装包
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const updateServer = require(path.join(__dirname, '..', 'server', 'update.js'))
const core = require(path.join(__dirname, '..', 'app', 'main', 'updater-core.js'))
const installKind = require(path.join(__dirname, '..', 'app', 'main', 'install-kind.js'))
const helper = require(path.join(__dirname, '..', 'app', 'main', 'win-update-launcher.js'))

// ===== 迷你测试框架 =====
// 同步与异步用例统一排队串行执行：分组标题、用例输出、汇总严格按源码顺序出现
let passed = 0
let failed = 0
const failures = []
let asyncChain = Promise.resolve()

function record(name, err) {
  if (err) {
    failed++
    failures.push({ name, err })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${err.message}`)
    return
  }
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}`)
}

function test(name, fn) {
  asyncChain = asyncChain.then(() => {
    try {
      fn()
      record(name)
    } catch (err) {
      record(name, err)
    }
  })
}

function testAsync(name, fn) {
  asyncChain = asyncChain.then(async () => {
    try {
      await fn()
      record(name)
    } catch (err) {
      record(name, err)
    }
  })
}

function group(title) {
  asyncChain = asyncChain.then(() => console.log(`\n\x1b[36m${title}\x1b[0m`))
}

// 创建一次性临时目录，返回 { root, cleanup }
function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airoute-update-test-'))
  return { root, cleanup: () => { try { fs.removeSync(root) } catch {} } }
}

// 造一个假的 .app 包（版本号 + 可执行文件内容）
function makeBundle(dir, version, binary) {
  fs.ensureDirSync(path.join(dir, 'Contents', 'MacOS'))
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'AiRoute'), binary)
  fs.writeFileSync(
    path.join(dir, 'Contents', 'Info.plist'),
    JSON.stringify({ CFBundleShortVersionString: version })
  )
  return dir
}

// 假命令执行器：把 dmg 挂载成含新版本 .app 的目录，ditto 用真实复制，plutil 读 JSON plist
function makeFakeRun({ newVersion = '1.7.2', newBinary = 'new-binary', plistOverride = null } = {}) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'hdiutil' && args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1]
      const bundle = path.join(mount, 'AiRoute.app')
      makeBundle(bundle, plistOverride || newVersion, newBinary)
      return ''
    }
    if (cmd === 'hdiutil' && args[0] === 'detach') {
      fs.removeSync(args[1])
      return ''
    }
    if (cmd === 'ditto') {
      fs.copySync(args[0], args[1])
      return ''
    }
    if (cmd === 'plutil') {
      const plist = args[args.length - 1]
      const data = JSON.parse(fs.readFileSync(plist, 'utf8'))
      return `${data.CFBundleShortVersionString}\n`
    }
    if (cmd === 'codesign') return ''
    throw new Error(`未预期的命令: ${cmd} ${args.join(' ')}`)
  }
  return { run, calls }
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

// ===== 纯函数 =====

group('校验值、版本比较与产物命名')

test('parseChecksums 支持 sha256sum 两种分隔与 * 前缀', () => {
  const map = updateServer.parseChecksums([
    'a'.repeat(64) + '  AiRoute-1.7.2-arm64.dmg',
    'b'.repeat(64) + ' *AiRoute-1.7.2-x64.dmg',
    '# 注释不会命中',
    'not-a-hash  AiRoute.exe'
  ].join('\n'))
  assert.strictEqual(map['AiRoute-1.7.2-arm64.dmg'], 'a'.repeat(64))
  assert.strictEqual(map['AiRoute-1.7.2-x64.dmg'], 'b'.repeat(64))
  assert.deepStrictEqual(Object.keys(map).sort(), ['AiRoute-1.7.2-arm64.dmg', 'AiRoute-1.7.2-x64.dmg'])
})

test('normalizeSha 统一大小写与 sha256: 前缀', () => {
  const h = 'A'.repeat(64)
  assert.strictEqual(core.normalizeSha('sha256:' + h), 'a'.repeat(64))
  assert.strictEqual(core.normalizeSha('  ' + h + ' '), 'a'.repeat(64))
  assert.strictEqual(core.normalizeSha(''), '')
})

test('compareSemver 按三段数字比较，忽略 v 前缀', () => {
  assert.strictEqual(updateServer.compareSemver('1.7.2', '1.7.1'), 1)
  assert.strictEqual(updateServer.compareSemver('v1.7.0', '1.7.0'), 0)
  assert.strictEqual(updateServer.compareSemver('1.6.9', '1.7.0'), -1)
  assert.strictEqual(updateServer.compareSemver('1.10.0', '1.9.9'), 1)
  // 预发布不再是「相等」：旧 compareVersion 砍掉后缀，beta.3 与 beta.2 被判成同一个版本，
  // beta 线永远发现不了更新（beta 线的比较规则见下面的「更新线路」分组）
  assert.strictEqual(updateServer.compareSemver('1.7.0-beta.1', '1.7.0'), -1)
})

test('assetCandidates 按运行形态选择产物名', () => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') {
    assert.deepStrictEqual(updateServer.assetCandidates('v1.7.2'), [`AiRoute-1.7.2-${arch}.dmg`])
    return
  }
  const installer = updateServer.assetCandidates('v1.7.2', 'installer')
  const portable = updateServer.assetCandidates('v1.7.2', 'portable')
  assert.strictEqual(installer[0], `AiRoute-1.7.2-${arch}-setup.exe`)
  assert.strictEqual(portable[0], `AiRoute-1.7.2-${arch}-portable.exe`)
  assert.strictEqual(installer[1], `AiRoute-1.7.2-${arch}-portable.exe`)
  assert.strictEqual(portable[1], `AiRoute-1.7.2-${arch}-setup.exe`)
  // 旧版本只发过 AiRoute.exe，两类形态都保留兜底
  assert.ok(installer.includes('AiRoute.exe'))
  assert.ok(portable.includes('AiRoute.exe'))
})

test('installAssetCandidates：一键升级优先 zip 覆盖包，便携包永不参与', () => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') {
    assert.deepStrictEqual(updateServer.installAssetCandidates('v1.7.2', 'mac'), [`AiRoute-1.7.2-${arch}.dmg`])
    return
  }
  // 安装版：zip（应用自己解压覆盖）在前，-setup.exe 作为没有 zip 资产的旧版本回落
  assert.deepStrictEqual(updateServer.installAssetCandidates('v1.7.2', 'installer'), [
    `AiRoute-1.7.2-${arch}.zip`,
    `AiRoute-1.7.2-${arch}-setup.exe`
  ])
  // 便携包不参与（拿便携包「升级」只会解包并启动一个新实例）
  assert.strictEqual(updateServer.installAssetCandidates('v1.7.2', 'installer').some(n => n.includes('-portable')), false)
})

test('normalizeInstallKind / canOneClick：只有安装版与 macOS 支持一键升级', () => {
  assert.strictEqual(updateServer.normalizeInstallKind('portable', 'win32'), 'portable')
  assert.strictEqual(updateServer.normalizeInstallKind('installer', 'win32'), 'installer')
  assert.strictEqual(updateServer.normalizeInstallKind('', 'win32'), 'installer')
  assert.strictEqual(updateServer.normalizeInstallKind('portable', 'darwin'), 'mac')
  assert.strictEqual(updateServer.canOneClick('installer'), true)
  assert.strictEqual(updateServer.canOneClick('portable'), false)
  assert.strictEqual(updateServer.canOneClick('mac'), true)
})

test('detectInstallKind：portable 目标注入的环境变量是唯一可靠信号', () => {
  const base = { platform: 'win32', env: {} }
  assert.strictEqual(installKind.detectInstallKind(base), 'installer')
  assert.strictEqual(installKind.detectInstallKind({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\AiRoute.exe' } }), 'portable')
  assert.strictEqual(installKind.detectInstallKind({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\' } }), 'portable')
  assert.strictEqual(installKind.detectInstallKind({ platform: 'darwin', env: {} }), 'mac')
  assert.strictEqual(installKind.supportsOneClick('installer', 'win32'), true)
  assert.strictEqual(installKind.supportsOneClick('portable', 'win32'), false)
})

test('isWindowsSetupArtifact 只认 -setup.exe', () => {
  assert.strictEqual(core.isWindowsSetupArtifact('AiRoute-1.8.2-x64-setup.exe'), true)
  assert.strictEqual(core.isWindowsSetupArtifact('C:\\updates\\AiRoute-1.8.2-arm64-setup.exe'), true)
  assert.strictEqual(core.isWindowsSetupArtifact('AiRoute-1.8.2-x64-portable.exe'), false)
  assert.strictEqual(core.isWindowsSetupArtifact('AiRoute-1.8.2-x64.exe'), false)
  assert.strictEqual(core.isWindowsSetupArtifact('AiRoute-1.8.2-x64.dmg'), false)
  assert.strictEqual(core.isWindowsSetupArtifact(''), false)
})

test('isInside 拒绝目录外的路径', () => {
  const base = path.join(os.tmpdir(), 'airoute-updates')
  assert.strictEqual(core.isInside(base, path.join(base, 'v1.7.2', 'a.dmg')), true)
  assert.strictEqual(core.isInside(base, base), true)
  assert.strictEqual(core.isInside(base, path.join(base, '..', 'evil.dmg')), false)
  assert.strictEqual(core.isInside(base, '/tmp/other/a.dmg'), false)
})

// ===== 更新线路（beta / 正式隔离）=====

group('更新线路：beta 与正式隔离')

test('compareSemver 能分辨预发布，旧的三段比较做不到', () => {
  // 三条必须在 beta 线上成立，否则 beta.2 → beta.3 会被判成「已是最新」
  assert.strictEqual(updateServer.compareSemver('2.0.0-beta.3', '2.0.0-beta.2'), 1)
  assert.strictEqual(updateServer.compareSemver('2.0.0-beta.2', '2.0.0-beta.10'), -1)
  assert.strictEqual(updateServer.compareSemver('2.0.0', '2.0.0-beta.3'), 1, '正式版高于同号预发布')
  // 跨大版本：beta 构建也应该看到「正式版已发布」，但那属于正式线的判断
  assert.strictEqual(updateServer.compareSemver('2.0.0', '1.9.0'), 1)
  assert.strictEqual(updateServer.compareSemver('1.9.0', '1.9.0'), 0)
  assert.strictEqual(updateServer.compareSemver('v1.9.0', '1.8.1'), 1)
})

test('parseSemver / isPrerelease 拆出预发布标识', () => {
  assert.deepStrictEqual(updateServer.parseSemver('v2.0.0-beta.3'), { nums: [2, 0, 0], pre: 'beta.3' })
  assert.deepStrictEqual(updateServer.parseSemver('1.9'), { nums: [1, 9, 0], pre: '' })
  assert.strictEqual(updateServer.isPrerelease('2.0.0-beta.3'), true)
  assert.strictEqual(updateServer.isPrerelease('1.9.0'), false)
  assert.strictEqual(updateServer.isPrerelease('v1.6.1-macos.1'), true)
})

test('releaseLine：beta 构建走 beta 线，正式构建走正式线', () => {
  assert.strictEqual(updateServer.releaseLine('2.0.0-beta.3'), 'beta')
  assert.strictEqual(updateServer.releaseLine('2.0.0-rc.1'), 'beta')
  assert.strictEqual(updateServer.releaseLine('1.9.0'), 'stable')
  // 制品标记（v1.6.1-macos.1）当年是按正式版发的，不能因为带后缀就被打去 beta 线
  assert.strictEqual(updateServer.releaseLine('1.6.1-macos.1'), 'stable')
  // 强制覆盖供排障
  assert.strictEqual(updateServer.releaseLine('1.9.0', 'beta'), 'beta')
  assert.strictEqual(updateServer.releaseLine('2.0.0-beta.3', 'stable'), 'stable')
})

// 造一批贴近真实仓库的 Release（含草稿、prerelease、只发另一平台的版本）
function releaseFixture() {
  return [
    { tag_name: 'v1.9.0', draft: false, prerelease: false, assets: [{ name: 'AiRoute-1.9.0-arm64.dmg' }] },
    { tag_name: 'v2.0.0-beta.3', draft: true, prerelease: true, assets: [{ name: 'AiRoute-2.0.0-beta.3-arm64.dmg' }] },
    { tag_name: 'v2.0.0-beta.2', draft: false, prerelease: true, assets: [{ name: 'AiRoute-2.0.0-beta.2-arm64.dmg' }] },
    { tag_name: 'v2.0.0-beta.1', draft: false, prerelease: true, assets: [] },
    { tag_name: 'v1.7.0-beta.2', draft: false, prerelease: true, assets: [{ name: 'AiRoute-1.7.0-beta.2-arm64.dmg' }] }
  ]
}

test('beta 线排除草稿：草稿资产对外 404，选中它等于让用户下不动', () => {
  const picked = updateServer.pickRelease(releaseFixture(), 'beta')
  assert.strictEqual(picked.tag_name, 'v2.0.0-beta.2', 'beta.3 是草稿，必须跳过')
})

test('beta 线优先挑带资产的版本，全都空才退回最高版', () => {
  const withAsset = updateServer.pickRelease(releaseFixture(), 'beta', r => (r.assets || []).length > 0)
  assert.strictEqual(withAsset.tag_name, 'v2.0.0-beta.2')

  // 连资产都没有：仍然给出最高版本（而不是假装没有更新），由下载环节报明确错误
  const bare = releaseFixture().map(r => ({ ...r, assets: [] }))
  assert.strictEqual(updateServer.pickRelease(bare, 'beta').tag_name, 'v2.0.0-beta.2')
})

test('正式线看不到任何 pre-release，哪怕它的版本号更高', () => {
  const picks = updateServer.pickRelease(releaseFixture(), 'stable')
  assert.strictEqual(picks.tag_name, 'v1.9.0', '2.0.0-beta.2 版本号更高，但属于 beta 线')
})

test('两条线路各自取到自己的最高版本，互不串线', () => {
  const beta = updateServer.pickRelease(releaseFixture(), 'beta')
  const stable = updateServer.pickRelease(releaseFixture(), 'stable')
  assert.notStrictEqual(beta.tag_name, stable.tag_name)
  assert.ok(/beta/.test(beta.tag_name))
  assert.ok(!/beta/.test(stable.tag_name))
})

test('没有符合线路的版本时返回 null，不抛错也不过期', () => {
  const onlyDrafts = releaseFixture().filter(r => r.draft)
  assert.strictEqual(updateServer.pickRelease(onlyDrafts, 'beta'), null)
  assert.strictEqual(updateServer.pickRelease([], 'stable'), null)
  assert.strictEqual(updateServer.pickRelease(null, 'beta'), null)
})

// ===== 安装链路 =====

group('安装链路（macOS）')

testAsync('成功路径：校验 → 备份 → 替换 → 回读，旧包留作 trash', async () => {
  const { root, cleanup } = tempDir()
  try {
    const appDir = path.join(root, 'Applications')
    const target = makeBundle(path.join(appDir, 'AiRoute.app'), '1.7.1', 'old-binary')
    const updateDir = path.join(root, 'updates')
    fs.ensureDirSync(updateDir)
    const artifactPath = path.join(updateDir, 'AiRoute-1.7.2-arm64.dmg')
    fs.writeFileSync(artifactPath, 'dmg-content')
    const expected = sha256(fs.readFileSync(artifactPath))

    const { run } = makeFakeRun()
    const stages = []
    const result = await core.applyUpdate({
      target,
      artifactPath,
      sha256: expected,
      version: '1.7.2',
      fromVersion: '1.7.1',
      updateDir,
      run,
      onStage: stage => stages.push(stage)
    })

    assert.deepStrictEqual(stages, ['verifying', 'backing-up', 'replacing', 'readback'])
    assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'AiRoute'), 'utf8'), 'new-binary')
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '1.7.2')

    // 备份保留旧版本内容
    const backupBin = path.join(updateDir, 'backup', 'AiRoute-1.7.1.app', 'Contents', 'MacOS', 'AiRoute')
    assert.strictEqual(fs.readFileSync(backupBin, 'utf8'), 'old-binary')
    assert.strictEqual(result.backup, path.join(updateDir, 'backup', 'AiRoute-1.7.1.app'))

    // 旧包改名留在目标目录（等下次启动清理），暂存目录已清理
    assert.ok(fs.existsSync(result.trash))
    assert.strictEqual(fs.readFileSync(path.join(result.trash, 'Contents', 'MacOS', 'AiRoute'), 'utf8'), 'old-binary')
    const leftovers = fs.readdirSync(appDir).filter(n => n.startsWith(core.STAGE_PREFIX))
    assert.deepStrictEqual(leftovers, [])
  } finally {
    cleanup()
  }
})

testAsync('SHA-256 不匹配：不做任何替换，也不产生备份', async () => {
  const { root, cleanup } = tempDir()
  try {
    const target = makeBundle(path.join(root, 'Applications', 'AiRoute.app'), '1.7.1', 'old-binary')
    const updateDir = path.join(root, 'updates')
    fs.ensureDirSync(updateDir)
    const artifactPath = path.join(updateDir, 'AiRoute-1.7.2-arm64.dmg')
    fs.writeFileSync(artifactPath, 'tampered')

    const { run, calls } = makeFakeRun()
    await assert.rejects(
      () => core.applyUpdate({
        target,
        artifactPath,
        sha256: 'a'.repeat(64),
        version: '1.7.2',
        fromVersion: '1.7.1',
        updateDir,
        run
      }),
      /SHA-256 校验失败/
    )
    assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'AiRoute'), 'utf8'), 'old-binary')
    assert.strictEqual(fs.existsSync(path.join(updateDir, 'backup')), false)
    assert.deepStrictEqual(calls, []) // 连 dmg 都不该挂载
  } finally {
    cleanup()
  }
})

testAsync('回读校验失败：自动回滚到旧版本并标记 rolledBack', async () => {
  const { root, cleanup } = tempDir()
  try {
    const appDir = path.join(root, 'Applications')
    const target = makeBundle(path.join(appDir, 'AiRoute.app'), '1.7.1', 'old-binary')
    const updateDir = path.join(root, 'updates')
    fs.ensureDirSync(updateDir)
    const artifactPath = path.join(updateDir, 'AiRoute-1.7.2-arm64.dmg')
    fs.writeFileSync(artifactPath, 'dmg-content')
    const expected = sha256(fs.readFileSync(artifactPath))

    const { run } = makeFakeRun()
    let err = null
    try {
      await core.applyUpdate({
        target,
        artifactPath,
        sha256: expected,
        version: '1.7.2',
        fromVersion: '1.7.1',
        updateDir,
        run,
        // 替换完成后篡改版本号，模拟「换上的包内容不对」
        hooks: {
          afterSwap: swapped => {
            fs.writeFileSync(path.join(swapped, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleShortVersionString: '1.7.0' }))
          }
        }
      })
    } catch (e) {
      err = e
    }
    assert.ok(err, '应当抛出回读失败')
    assert.match(err.message, /版本回读不一致/)
    assert.strictEqual(err.rolledBack, true)

    // 目标恢复到旧版本
    assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'AiRoute'), 'utf8'), 'old-binary')
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '1.7.1')
    // 没有遗留暂存目录 / 旧包
    assert.deepStrictEqual(fs.readdirSync(appDir).filter(n => n.startsWith('.')) , [])
    // 备份仍在（可用于人工回滚 / 排查）
    assert.ok(fs.existsSync(path.join(updateDir, 'backup', 'AiRoute-1.7.1.app')))
  } finally {
    cleanup()
  }
})

testAsync('手动回滚：用备份覆盖当前版本并回读通过', async () => {
  const { root, cleanup } = tempDir()
  try {
    const appDir = path.join(root, 'Applications')
    const target = makeBundle(path.join(appDir, 'AiRoute.app'), '1.7.1', 'old-binary')
    const updateDir = path.join(root, 'updates')
    fs.ensureDirSync(updateDir)
    const artifactPath = path.join(updateDir, 'AiRoute-1.7.2-arm64.dmg')
    fs.writeFileSync(artifactPath, 'dmg-content')
    const expected = sha256(fs.readFileSync(artifactPath))

    const { run } = makeFakeRun()
    const installed = await core.applyUpdate({
      target,
      artifactPath,
      sha256: expected,
      version: '1.7.2',
      fromVersion: '1.7.1',
      updateDir,
      run
    })
    assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'AiRoute'), 'utf8'), 'new-binary')

    const result = await core.rollbackToBackup({
      target,
      backup: installed.backup,
      updateDir,
      run
    })
    assert.strictEqual(result.version, '1.7.1')
    assert.strictEqual(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'AiRoute'), 'utf8'), 'old-binary')
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString, '1.7.1')
  } finally {
    cleanup()
  }
})

testAsync('安装包路径不在托管目录内时直接拒绝', async () => {
  const { root, cleanup } = tempDir()
  try {
    const target = makeBundle(path.join(root, 'Applications', 'AiRoute.app'), '1.7.1', 'old-binary')
    const updateDir = path.join(root, 'updates')
    fs.ensureDirSync(updateDir)
    const outside = path.join(root, 'evil.dmg')
    fs.writeFileSync(outside, 'x')
    await assert.rejects(
      () => core.applyUpdate({
        target,
        artifactPath: outside,
        sha256: sha256(Buffer.from('x')),
        version: '1.7.2',
        fromVersion: '1.7.1',
        updateDir
      }),
      /安装包路径非法/
    )
  } finally {
    cleanup()
  }
})

// ===== Windows 安装版一键升级 =====

group('安装版一键升级（Windows）')

// 造一个「已安装」的目录：程序 exe + 托管目录里的载荷（默认 zip 覆盖包）
function makeWinTarget(root, { artifactName = 'AiRoute-1.8.2-x64.zip', artifact = 'zip-content' } = {}) {
  const installDir = path.join(root, 'Programs', 'AiRoute')
  fs.ensureDirSync(installDir)
  const target = path.join(installDir, 'AiRoute.exe')
  fs.writeFileSync(target, 'app-binary')
  const updateDir = path.join(root, 'updates')
  fs.ensureDirSync(updateDir)
  const artifactPath = path.join(updateDir, artifactName)
  fs.writeFileSync(artifactPath, artifact)
  return { target, updateDir, artifactPath }
}

testAsync('成功路径（zip 覆盖）：写出解压+覆盖脚本并拉起启动器', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath } = makeWinTarget(root)
    const expected = sha256(fs.readFileSync(artifactPath))
    const stages = []
    const result = await core.applyWindowsUpdate({
      target,
      artifactPath,
      sha256: expected,
      version: '1.8.2',
      updateDir,
      onStage: stage => stages.push(stage),
      spawnLauncher: () => ({ pid: 4242, unref() {} })
    })

    assert.deepStrictEqual(stages, ['verifying', 'replacing'])
    assert.strictEqual(result.launcherPid, 4242)
    assert.strictEqual(result.exitFile, path.join(updateDir, helper.EXIT_FILE))
    assert.strictEqual(result.scriptPath, path.join(updateDir, helper.SCRIPT_FILE))
    const script = fs.readFileSync(result.scriptPath, 'utf8')
    // 覆盖安装：解压 → robocopy 覆盖安装目录 → 回读版本；全程不跑 NSIS
    assert.ok(script.includes(`tar.exe -xf '${artifactPath}'`))
    assert.ok(script.includes(`robocopy $stage '${path.dirname(target)}'`))
    assert.ok(script.includes("VersionInfo.FileVersion"))
    assert.ok(script.includes("'1.8.2'"))
    assert.ok(script.includes(target))
    assert.ok(script.includes(result.exitFile))
    assert.strictEqual(script.includes("'/S','--updated'"), false)
    // 上一轮遗留的退出码要先清掉，否则失败会被读成上次的 0
    assert.strictEqual(fs.existsSync(result.exitFile), false)
  } finally {
    cleanup()
  }
})

testAsync('旧版本回落（-setup.exe）：脚本补 /D=安装目录，避免装到默认目录', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath } = makeWinTarget(root, { artifactName: 'AiRoute-1.8.2-x64-setup.exe' })
    const result = await core.applyWindowsUpdate({
      target,
      artifactPath,
      sha256: sha256(fs.readFileSync(artifactPath)),
      version: '1.8.2',
      updateDir,
      spawnLauncher: () => ({ pid: 4243, unref() {} })
    })
    const script = fs.readFileSync(result.scriptPath, 'utf8')
    assert.ok(script.includes("'/S','--updated'"))
    assert.ok(script.includes(`'/D=${path.dirname(target)}'`))
  } finally {
    cleanup()
  }
})

testAsync('缺少目标版本号时拒绝（覆盖后无法回读校验）', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath } = makeWinTarget(root)
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath,
        sha256: sha256(fs.readFileSync(artifactPath)),
        updateDir,
        spawnLauncher: () => ({ pid: 1 })
      }),
      /缺少目标版本号/
    )
  } finally {
    cleanup()
  }
})

testAsync('SHA-256 不匹配：不拉起启动器', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath } = makeWinTarget(root)
    let spawned = false
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath,
        sha256: 'a'.repeat(64),
        version: '1.8.2',
        updateDir,
        spawnLauncher: () => { spawned = true; return { pid: 1 } }
      }),
      /SHA-256 校验失败/
    )
    assert.strictEqual(spawned, false)
  } finally {
    cleanup()
  }
})

testAsync('便携版安装包：拒绝一键升级（它不会覆盖已安装的文件）', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath } = makeWinTarget(root, { artifactName: 'AiRoute-1.8.2-x64.exe' })
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath,
        sha256: sha256(fs.readFileSync(artifactPath)),
        version: '1.8.2',
        updateDir,
        spawnLauncher: () => ({ pid: 1 })
      }),
      /更新包格式不正确/
    )
  } finally {
    cleanup()
  }
})

testAsync('安装包不在托管目录内时直接拒绝', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir } = makeWinTarget(root)
    const outside = path.join(root, 'AiRoute-1.8.2-x64-setup.exe')
    fs.writeFileSync(outside, 'setup-content')
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath: outside,
        sha256: sha256(Buffer.from('setup-content')),
        updateDir,
        spawnLauncher: () => ({ pid: 1 })
      }),
      /安装包路径非法/
    )
  } finally {
    cleanup()
  }
})

group('安装启动器（win-update-launcher）')

test('psQuote 把单引号转义成两个，路径不会被截断', () => {
  assert.strictEqual(helper.psQuote("C:\\a'b\\c"), "'C:\\a''b\\c'")
})

test('powershellPath 走 SystemRoot 下的 WindowsPowerShell，不依赖 PATH', () => {
  assert.strictEqual(
    helper.powershellPath({ SystemRoot: 'C:\\Windows' }),
    path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  )
})

test('payloadKind：.zip 走覆盖安装，-setup.exe 走回落安装', () => {
  assert.strictEqual(helper.payloadKind('C:\\u\\AiRoute-2.0.6-x64.zip'), 'zip')
  assert.strictEqual(helper.payloadKind('C:\\u\\AiRoute-2.0.6-x64-setup.exe'), 'setup')
})

test('buildScript（zip）：等 PID 退出 → 解压 → robocopy 覆盖 → 回读版本 → 拉起应用', () => {
  const script = helper.buildScript({
    pid: 1234,
    artifact: 'C:\\u\\AiRoute-2.0.6-x64.zip',
    installDir: 'C:\\p',
    exe: 'C:\\p\\AiRoute.exe',
    exitFile: 'C:\\u\\install-exit.txt',
    version: '2.0.6',
    waitSeconds: 30
  })
  assert.match(script, /\$appPid = 1234/)
  assert.match(script, /AddSeconds\(30\)/)
  assert.match(script, /Get-Process -Id \$appPid/)
  assert.match(script, /tar\.exe -xf 'C:\\u\\AiRoute-2\.0\.6-x64\.zip' -C \$stage/)
  assert.match(script, /Expand-Archive -LiteralPath 'C:\\u\\AiRoute-2\.0\.6-x64\.zip'/)
  assert.match(script, /robocopy \$stage 'C:\\p' \/E \/R:3/)
  assert.match(script, /VersionInfo\.FileVersion/)
  assert.match(script, /-ne '2\.0\.6'/)
  assert.match(script, /Set-Content -LiteralPath 'C:\\u\\install-exit\.txt' -Value 0 -Encoding ascii/)
  assert.match(script, /Start-Process -FilePath 'C:\\p\\AiRoute\.exe'/)
  // 覆盖安装不该再碰 NSIS
  assert.strictEqual(script.includes('--updated'), false)
})

test('buildScript（setup 回落）：/S --updated 且带上 /D=安装目录', () => {
  const script = helper.buildScript({
    pid: 1,
    artifact: 'C:\\u\\AiRoute-2.0.6-x64-setup.exe',
    installDir: 'C:\\p',
    exe: 'C:\\p\\AiRoute.exe',
    exitFile: 'x.txt'
  })
  assert.match(script, /-ArgumentList '\/S','--updated','\/D=C:\\p' -Wait -PassThru/)
  assert.match(script, /Set-Content -LiteralPath 'x\.txt' -Value \$code -Encoding ascii/)
})

test('buildScript：等待超时先写 -1 并退出，不动安装目录', () => {
  const script = helper.buildScript({ pid: 7, artifact: 'u.zip', installDir: 'C:\\p', exe: 'e.exe', exitFile: 'x.txt', version: '1.0.0' })
  assert.ok(/\{ Set-Content -LiteralPath 'x\.txt' -Value -1 -Encoding ascii; exit \}/.test(script), '缺少超时守卫')
  // 守卫必须在解压/安装之前，否则会把还在写盘的应用杀掉
  assert.ok(script.indexOf('exit }') < script.indexOf('tar.exe'))
})

test('buildScript：等应用退出后多留 2 秒收句柄', () => {
  const script = helper.buildScript({ pid: 1, artifact: 'u.zip', installDir: 'C:\\p', exe: 'e.exe', exitFile: 'x.txt', version: '1.0.0' })
  const guard = script.indexOf('-Value -1')
  assert.ok(script.indexOf('Start-Sleep -Seconds 2') > guard)
  assert.ok(script.indexOf('Start-Sleep -Seconds 2') < script.indexOf('tar.exe'))
})

test('writeScript 写成 UTF-8 BOM，PowerShell 5.1 才不会把中文路径读成乱码', () => {
  const file = path.join(os.tmpdir(), `airoute-ps-${process.pid}.ps1`)
  helper.writeScript(file, "# 中文注释\r\necho 1\r\n")
  const raw = fs.readFileSync(file)
  assert.deepStrictEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf])
  assert.ok(raw.toString('utf8').includes('中文注释'))
  fs.removeSync(file)
})

test('spawnLauncher：不 detach（detach 会让 PowerShell 直接退出），用 -File 跑脚本', () => {
  let seen = null
  const result = helper.spawnLauncher({
    scriptPath: 'C:\\u\\install-update.ps1',
    psPath: 'C:\\PS\\powershell.exe',
    env: {},
    spawnFn: (file, args, opts) => {
      seen = { file, args, opts }
      return { pid: 1, unref() { seen.unrefed = true } }
    }
  })
  assert.strictEqual(result.pid, 1)
  assert.strictEqual(seen.unrefed, true)
  assert.strictEqual(seen.file, 'C:\\PS\\powershell.exe')
  assert.deepStrictEqual(seen.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\u\\install-update.ps1'])
  assert.strictEqual(seen.opts.detached, undefined)
  assert.strictEqual(seen.opts.windowsHide, true)
  assert.strictEqual(seen.opts.stdio, 'ignore')
})

test('describeInstallExit：0 / -1 / 8 / 9 / 其它退出码各有明确文案', () => {
  assert.match(core.describeInstallExit(0, '2.0.1'), /更新包已应用，但当前版本仍为 v2\.0\.1/)
  assert.match(core.describeInstallExit(-1, '2.0.1'), /等待应用退出超时/)
  assert.match(core.describeInstallExit(8, '2.0.1'), /解压失败/)
  assert.match(core.describeInstallExit(9, '2.0.1'), /版本校验未通过/)
  assert.match(core.describeInstallExit(16, '2.0.1'), /覆盖安装失败（退出码 16）/)
})

group('手动覆盖安装（Windows 稳定路径）')

test('manualPs1：等进程退出 → 解压 → 覆盖 → 回读版本 → 同步卸载信息 → 启动', () => {
  const script = helper.manualPs1({
    artifact: 'C:\\u\\AiRoute-2.1.0-x64.zip',
    installDir: 'D:\\软件\\airoute',
    exe: 'D:\\软件\\airoute\\AiRoute.exe',
    version: '2.1.0'
  })
  assert.match(script, /Get-Process -Name 'AiRoute'/)
  assert.match(script, /StartsWith\(\$installDir/)
  assert.match(script, /tar\.exe -xf \$Zip -C \$stage/)
  assert.match(script, /robocopy \$stage \$installDir \/E/)
  assert.match(script, /VersionInfo\.FileVersion/)
  assert.match(script, /DisplayVersion/)
  assert.match(script, /Start-Process -FilePath \$targetExe/)
  assert.match(script, /exit \$code/)
  // 版本必须来自参数并做回读，不能写死一个「成功」
  assert.match(script, /-ne \$expected/)
})

test('manualCmd：调用同目录 apply-update.ps1，支持把 zip 拖到脚本上', () => {
  const cmd = helper.manualCmd('AiRoute-2.1.0-x64.zip')
  assert.match(cmd, /apply-update\.ps1/)
  assert.match(cmd, /%~dp0AiRoute-2\.1\.0-x64\.zip/)
  assert.match(cmd, /%~1/)
})

test('writeManualUpdater：生成 ps1（BOM）/ cmd（ASCII）/ README', () => {
  const { root, cleanup } = tempDir()
  try {
    const folder = path.join(root, 'updates')
    fs.ensureDirSync(folder)
    const artifact = path.join(folder, 'AiRoute-2.1.0-x64.zip')
    fs.writeFileSync(artifact, 'zip')
    const result = helper.writeManualUpdater({
      artifact,
      installDir: 'D:\\p',
      exe: 'D:\\p\\AiRoute.exe',
      version: '2.1.0'
    })
    assert.ok(fs.existsSync(result.cmdPath))
    assert.ok(fs.existsSync(result.ps1Path))
    assert.ok(fs.existsSync(result.readmePath))
    const raw = fs.readFileSync(result.ps1Path)
    assert.deepStrictEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'ps1 必须带 BOM')
    assert.ok(raw.toString('utf8').includes('D:\\p'))
    const cmd = fs.readFileSync(result.cmdPath, 'utf8')
    assert.ok(/^[\x00-\x7F]*$/.test(cmd), 'cmd 内容必须是 ASCII（cmd.exe 按 OEM 代码页解析）')
    assert.ok(fs.readFileSync(result.readmePath, 'utf8').includes('install-update.cmd'))
  } finally {
    cleanup()
  }
})

// ===== 汇总 =====
asyncChain.then(() => {
  console.log('')
  if (failures.length) {
    console.log(`\x1b[31m${failed} 项失败\x1b[0m，通过 ${passed} 项`)
    for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err.stack || f.err.message}`)
    process.exit(1)
  }
  console.log(`\x1b[32m全部通过\x1b[0m：${passed} 项`)
})
