// 一键升级离线测试：校验值解析 / 版本比较 / 产物命名 / macOS 安装链路与回滚 /
// Windows 安装版助手链路（安装包校验 → 独立助手等待退出 → 静默安装 → 重启）
// 运行：node scripts/test-update.js
// 全部使用临时目录与假命令 / 假 spawn，不触碰真实应用包，也不会真的运行安装包
const assert = require('assert')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const updateServer = require(path.join(__dirname, '..', 'server', 'update.js'))
const core = require(path.join(__dirname, '..', 'app', 'main', 'updater-core.js'))
const installKind = require(path.join(__dirname, '..', 'app', 'main', 'install-kind.js'))
const helper = require(path.join(__dirname, '..', 'app', 'main', 'win-update-helper.js'))

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

test('compareVersion 按三段数字比较，忽略 v 前缀与预发布后缀', () => {
  assert.strictEqual(updateServer.compareVersion('1.7.2', '1.7.1'), 1)
  assert.strictEqual(updateServer.compareVersion('v1.7.0', '1.7.0'), 0)
  assert.strictEqual(updateServer.compareVersion('1.7.0-beta.1', '1.7.0'), 0)
  assert.strictEqual(updateServer.compareVersion('1.6.9', '1.7.0'), -1)
  assert.strictEqual(updateServer.compareVersion('1.10.0', '1.9.9'), 1)
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

test('installAssetCandidates 让一键升级只认安装版安装包', () => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') {
    assert.deepStrictEqual(updateServer.installAssetCandidates('v1.7.2', 'mac'), [`AiRoute-1.7.2-${arch}.dmg`])
    return
  }
  // 安装版：便携包不参与（拿便携包「升级」只会解包并启动一个新实例）
  assert.deepStrictEqual(updateServer.installAssetCandidates('v1.7.2', 'installer'), [`AiRoute-1.7.2-${arch}-setup.exe`])
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

// 造一个「已安装」的目录：程序 exe + 托管目录里的安装包
function makeWinTarget(root, { artifactName = 'AiRoute-1.8.2-x64-setup.exe', artifact = 'setup-content' } = {}) {
  const installDir = path.join(root, 'Programs', 'AiRoute')
  fs.ensureDirSync(installDir)
  const target = path.join(installDir, 'AiRoute.exe')
  fs.writeFileSync(target, 'app-binary')
  const updateDir = path.join(root, 'updates')
  fs.ensureDirSync(updateDir)
  const artifactPath = path.join(updateDir, artifactName)
  fs.writeFileSync(artifactPath, artifact)
  return { target, updateDir, artifactPath, journalPath: path.join(updateDir, 'journal.json') }
}

testAsync('成功路径：校验通过后以助手参数拉起独立进程', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath, journalPath } = makeWinTarget(root)
    const expected = sha256(fs.readFileSync(artifactPath))
    let spawnedArgs = null
    const stages = []
    const result = await core.applyWindowsUpdate({
      target,
      artifactPath,
      sha256: expected,
      updateDir,
      journalPath,
      onStage: stage => stages.push(stage),
      spawnHelper: args => {
        spawnedArgs = args
        return { pid: 4242, unref() {} }
      }
    })

    assert.deepStrictEqual(stages, ['verifying', 'replacing'])
    assert.strictEqual(result.helperPid, 4242)
    assert.ok(spawnedArgs[0].endsWith('win-update-helper.js'))
    assert.deepStrictEqual(spawnedArgs.slice(1), [
      '--pid', String(process.pid),
      '--installer', artifactPath,
      '--exe', target,
      '--journal', journalPath
    ])
  } finally {
    cleanup()
  }
})

testAsync('SHA-256 不匹配：不拉起助手进程', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, artifactPath, journalPath } = makeWinTarget(root)
    let spawned = false
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath,
        sha256: 'a'.repeat(64),
        updateDir,
        journalPath,
        spawnHelper: () => { spawned = true; return { pid: 1 } }
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
    const { target, updateDir, artifactPath, journalPath } = makeWinTarget(root, { artifactName: 'AiRoute-1.8.2-x64.exe' })
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath,
        sha256: sha256(fs.readFileSync(artifactPath)),
        updateDir,
        journalPath,
        spawnHelper: () => ({ pid: 1 })
      }),
      /安装包不是安装版/
    )
  } finally {
    cleanup()
  }
})

testAsync('安装包不在托管目录内时直接拒绝', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, updateDir, journalPath } = makeWinTarget(root)
    const outside = path.join(root, 'AiRoute-1.8.2-x64-setup.exe')
    fs.writeFileSync(outside, 'setup-content')
    await assert.rejects(
      () => core.applyWindowsUpdate({
        target,
        artifactPath: outside,
        sha256: sha256(Buffer.from('setup-content')),
        updateDir,
        journalPath,
        spawnHelper: () => ({ pid: 1 })
      }),
      /安装包路径非法/
    )
  } finally {
    cleanup()
  }
})

group('安装助手（win-update-helper）')

test('parseArgs 解析 --key value 参数', () => {
  assert.deepStrictEqual(helper.parseArgs(['--pid', '12', '--installer', 'C:\\a.exe']), { pid: '12', installer: 'C:\\a.exe' })
})

testAsync('waitForExit 轮询到进程消失为止，超时返回 false', async () => {
  let calls = 0
  const aliveSeq = [true, true, false]
  const exited = await helper.waitForExit(1, {
    aliveFn: () => aliveSeq[calls++],
    sleepFn: async () => {}
  })
  assert.strictEqual(exited, true)
  assert.strictEqual(calls, 3)

  let now = 0
  const timedOut = await helper.waitForExit(1, {
    aliveFn: () => true,
    sleepFn: async () => { now += helper.POLL_MS },
    now: () => now
  })
  assert.strictEqual(timedOut, false)
})

testAsync('runInstaller 以 /S --updated 静默执行安装包', async () => {
  let seen = null
  const result = await helper.runInstaller('C:\\AiRoute-1.8.2-x64-setup.exe', {
    spawnFn: (file, args) => {
      seen = [file, ...args]
      const child = new EventEmitter()
      child.kill = () => {}
      process.nextTick(() => child.emit('exit', 0))
      return child
    }
  })
  assert.strictEqual(result.code, 0)
  assert.deepStrictEqual(seen, ['C:\\AiRoute-1.8.2-x64-setup.exe', '/S', '--updated'])
})

testAsync('助手成功路径：等应用退出 → 安装 → 拉起新版本并回写 journal', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, artifactPath, journalPath } = makeWinTarget(root)
    fs.writeJsonSync(journalPath, { status: 'installing', from: '1.8.1', to: '1.8.2', artifactPath })
    const calls = []
    const code = await helper.main(['--pid', '9999', '--installer', artifactPath, '--exe', target, '--journal', journalPath], {
      waitForExitFn: async pid => { calls.push(['wait', String(pid)]); return true },
      runInstallerFn: async installer => { calls.push(['install', installer]); return { code: 0 } },
      launchFn: exe => { calls.push(['launch', exe]); return true },
      log: () => {}
    })
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls, [['wait', '9999'], ['install', artifactPath], ['launch', target]])
    const journal = fs.readJsonSync(journalPath)
    assert.strictEqual(journal.status, 'installed')
    // 主进程写入的字段不能被助手覆盖
    assert.strictEqual(journal.to, '1.8.2')
  } finally {
    cleanup()
  }
})

testAsync('助手安装失败：记录原因并拉起旧版本', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, artifactPath, journalPath } = makeWinTarget(root)
    fs.writeJsonSync(journalPath, { status: 'installing', from: '1.8.1', to: '1.8.2' })
    const calls = []
    const code = await helper.main(['--pid', '9999', '--installer', artifactPath, '--exe', target, '--journal', journalPath], {
      waitForExitFn: async () => true,
      runInstallerFn: async () => ({ code: 5 }),
      launchFn: exe => { calls.push(exe); return true },
      log: () => {}
    })
    assert.strictEqual(code, 1)
    assert.deepStrictEqual(calls, [target])
    const journal = fs.readJsonSync(journalPath)
    assert.strictEqual(journal.status, 'error')
    assert.match(journal.error, /退出码 5/)
  } finally {
    cleanup()
  }
})

testAsync('助手等待退出超时：不运行安装包，仍然拉起当前版本', async () => {
  const { root, cleanup } = tempDir()
  try {
    const { target, artifactPath, journalPath } = makeWinTarget(root)
    fs.writeJsonSync(journalPath, { status: 'installing', from: '1.8.1', to: '1.8.2' })
    let installed = false
    const code = await helper.main(['--pid', '9999', '--installer', artifactPath, '--exe', target, '--journal', journalPath], {
      waitForExitFn: async () => false,
      runInstallerFn: async () => { installed = true; return { code: 0 } },
      launchFn: () => true,
      log: () => {}
    })
    assert.strictEqual(code, 1)
    assert.strictEqual(installed, false)
    assert.strictEqual(fs.readJsonSync(journalPath).status, 'error')
  } finally {
    cleanup()
  }
})

testAsync('助手缺少安装包：直接放弃（退出码 2）', async () => {
  const code = await helper.main(['--pid', '9999', '--installer', path.join(os.tmpdir(), 'no-such-setup.exe')], {
    runInstallerFn: async () => { throw new Error('不该运行安装包') },
    launchFn: () => true,
    log: () => {}
  })
  assert.strictEqual(code, 2)
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
