// 一键升级（macOS）离线测试：校验值解析 / 版本比较 / 安装链路 / 回滚
// 运行：node scripts/test-update.js
// 全部使用临时目录与假命令（hdiutil / ditto / plutil / codesign），不触碰真实应用包
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const updateServer = require(path.join(__dirname, '..', 'server', 'update.js'))
const core = require(path.join(__dirname, '..', 'app', 'main', 'updater-core.js'))

// ===== 迷你测试框架 =====
let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, err })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`      ${err.message}`)
  }
}

async function testAsync(name, fn) {
  // 串行执行：异步用例按注册顺序跑完再汇总，避免汇总先于用例输出
  asyncChain = asyncChain.then(async () => {
    try {
      await fn()
      passed++
      console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    } catch (err) {
      failed++
      failures.push({ name, err })
      console.log(`  \x1b[31m✗\x1b[0m ${name}`)
      console.log(`      ${err.message}`)
    }
  })
}

let asyncChain = Promise.resolve()

function group(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`)
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

group('校验值与版本比较')

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

test('assetCandidates 产物名带版本与架构', () => {
  const names = updateServer.assetCandidates('v1.7.2')
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ext = process.platform === 'darwin' ? 'dmg' : 'exe'
  assert.strictEqual(names[0], `AiRoute-1.7.2-${arch}.${ext}`)
  if (process.platform !== 'darwin') assert.ok(names.includes('AiRoute.exe'))
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
