// 渠道插件宿主的离线回归：不联网、不需要真实账号
//
//     node scripts/test-channel-plugins.js
//
// 验证的是「宿主这一侧」的约定，而不是任何一家的上游协议：
//   1. 内置插件默认全部加载，provider 索引对得上；
//   2. 停用一个插件后它的 provider 立刻消失（清单是唯一真相源）；
//   3. 插件包坏掉时只影响它自己，且失败原因查得到；
//   4. 外部插件能按路径装进来（这是「以插件方式安装」的核心）；
//   5. 后端方法表被适配成统一 ABI（第一个参数是 provider）；
//   6. 内置插件不允许被删，只允许停用。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const { createPluginHost } = require(path.join(root, 'server', 'channels', 'plugin-host'))
const { createPluginStore, BUILTIN_PLUGINS } = require(path.join(root, 'server', 'channels', 'plugin-store'))

// 每个用例一套独立 dataDir：插件清单是按目录落盘的，共用会互相污染
function freshDir(name) {
  const dir = path.join(os.tmpdir(), `airoute-plugins-${name}-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 本地日期键：与插件里判定「今天签过」用的是同一口径（自然日，非 24 小时）
function localDay(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const silent = { info() {}, warn() {}, error() {} }
let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    console.error(`     ${error.message}`)
    process.exitCode = 1
  }
}

async function main() {
  // ① 默认全新目录：内置插件全部装上并加载
  await test('内置插件默认全部加载', async () => {
    const dir = freshDir('default')
    const host = createPluginHost({ dataDir: dir, logger: silent })
    const info = host.load()
    assert.equal(info.failures.length, 0, `不该有加载失败：${JSON.stringify(info.failures)}`)
    assert.deepEqual(host.providers().sort(), ['qoder', 'qodercn', 'trae'])
    for (const plugin of info.plugins) assert.equal(plugin.builtin, true)
    const Trae = info.plugins.find(p => p.id === 'trae')
    assert.deepEqual(Trae.providers, ['trae'])
    assert.deepEqual(Trae.checkinProviders, ['trae'], 'Trae 有签到端点')
    const qoder = info.plugins.find(p => p.id === 'qoder')
    assert.deepEqual(qoder.providers.sort(), ['qoder', 'qodercn'], '一个包两个 provider')
    assert.deepEqual(qoder.checkinProviders, [], 'Qoder 没有签到端点')
    await host.shutdown()
  })

  // ② 停用：provider 从索引里消失，别家不受影响
  await test('停用插件后它的 provider 立刻消失', async () => {
    const dir = freshDir('disable')
    const host = createPluginHost({ dataDir: dir, logger: silent })
    host.load()
    host.store.setEnabled('trae', false)
    host.load()
    assert.deepEqual(host.providers().sort(), ['qoder', 'qodercn'])
    // 停用不是「损坏」：ownerOf 应当回落成 unknown，而不是报加载失败
    assert.equal(host.ownerOf('trae').kind, 'unknown')
    assert.equal(host.ownerOf('qoder').kind, 'ready')
    await host.shutdown()
  })

  // ③ 坏插件只影响自己，且失败原因带着声明
  await test('插件初始化失败不拖垮其它插件', async () => {
    const dir = freshDir('broken')
    // 一个只有声明、create() 必炸的插件
    const brokenDir = path.join(dir, 'broken-plugin')
    fs.mkdirSync(brokenDir, { recursive: true })
    fs.writeFileSync(path.join(brokenDir, 'index.js'), `
      module.exports = {
        id: 'broken',
        name: 'Broken',
        providers: { broken: { name: 'Broken' } },
        create() { throw new Error('缺 WASM') },
      }
    `)
    const store = createPluginStore({ dataDir: dir, logger: silent })
    store.add({ id: 'broken', source: brokenDir })
    const host = createPluginHost({ dataDir: dir, logger: silent })
    const info = host.load()
    assert.equal(info.failures.length, 1)
    assert.equal(info.failures[0].id, 'broken')
    assert.match(info.failures[0].error, /缺 WASM/)
    // 失败记录的 providers 来自**声明**：只记「可用」的话，用户会以为这家没装
    assert.deepEqual(info.failures[0].providers, ['broken'])
    // 内置的仍然在
    assert.ok(host.providers().includes('trae'))
    // ownerOf 能说清「这个 provider 装了但没起来」
    const owner = host.ownerOf('broken')
    assert.equal(owner.kind, 'failed')
    assert.match(owner.failure.error, /缺 WASM/)
    await host.shutdown()
  })

  // ④ 外部插件按路径装入（这是「以插件方式安装」的核心路径）
  await test('外部插件可以按路径装进来', async () => {
    const dir = freshDir('external')
    const pluginDir = path.join(dir, 'ext-plugin')
    fs.mkdirSync(pluginDir, { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
      module.exports = {
        id: 'ext',
        name: 'External',
        providers: { ext: { name: 'External' } },
        checkinProviders: ['ext'],
        create(ctx) {
          return {
            providers: ['ext'],
            listAccounts: () => [{ id: 'ext-1', name: 'a', enabled: true }],
            listModels: () => [{ id: 'm1', name: 'M1', maxContext: 1000 }],
            complete: async (provider, request, onChunk) => {
              onChunk({ type: 'text-delta', text: 'ok' })
              return { emitted: true }
            },
            // 记录宿主递进来的东西，验证上下文是显式注入的
            _seen: { dataDir: ctx.dataDir, hasCredentials: !!ctx.credentials, hasLogin: !!ctx.loginServer },
          }
        },
      }
    `)
    const store = createPluginStore({ dataDir: dir, logger: silent })
    store.add({ id: 'ext', source: pluginDir })
    const host = createPluginHost({ dataDir: dir, logger: silent })
    const info = host.load()
    assert.equal(info.failures.length, 0, JSON.stringify(info.failures))
    assert.ok(host.providers().includes('ext'))
    const instance = host.instanceOf('ext')
    assert.deepEqual(instance.backend.listAccounts('ext'), [{ id: 'ext-1', name: 'a', enabled: true }])
    // 宿主 API 是**递进去的**，不是插件自己 require 出来的
    assert.deepEqual(instance.backend._seen, { dataDir: dir, hasCredentials: true, hasLogin: true })
    await host.shutdown()
  })

  // ⑤ 统一 ABI：内置插件的后端方法第一个参数是 provider
  await test('内置插件遵守统一 ABI', async () => {
    const dir = freshDir('abi')
    const host = createPluginHost({ dataDir: dir, logger: silent })
    host.load()
    const qoder = host.instanceOf('qoder')
    // 两个 provider 分别问：qodercn 的账号清单不能混进 qoder 的
    const qoderAccounts = qoder.backend.listAccounts('qoder')
    const cnAccounts = qoder.backend.listAccounts('qodercn')
    assert.ok(Array.isArray(qoderAccounts) && Array.isArray(cnAccounts))
    // 账号 id 带 provider 前缀，两家的账号不会互相覆盖
    for (const row of qoderAccounts) assert.ok(row.id.startsWith('qoder-'), `意外的账号 id：${row.id}`)
    for (const row of cnAccounts) assert.ok(row.id.startsWith('qodercn-'), `意外的账号 id：${row.id}`)
    const Trae = host.instanceOf('trae')
    assert.ok(Array.isArray(Trae.backend.listAccounts('trae')))
    // 「有没有这个能力」靠方法在不在判断，而不是靠 provider 名写死分支：
    // Trae 与 Qoder 都实现了余额端点（宿主据此回「未开通」，不留必然失败的按钮）
    assert.equal(typeof Trae.backend.balance, 'function', 'Trae 有余额端点')
    assert.equal(typeof qoder.backend.balance, 'function', 'Qoder 有余额端点')
    assert.equal(typeof Trae.backend.checkin, 'function')
    assert.equal(typeof qoder.backend.checkin, 'function', 'Qoder 的 checkin 返回 ineligible，不是缺方法')
    await host.shutdown()
  })

  // ⑥ 内置插件只允许停用，不允许删除
  await test('内置插件不允许删除', async () => {
    const dir = freshDir('builtin-rm')
    const store = createPluginStore({ dataDir: dir, logger: silent })
    assert.equal(store.list().length, BUILTIN_PLUGINS.length)
    assert.throws(() => store.remove('trae'), /只能停用/)
    // 停用是允许的，且重启后仍然是停用
    store.setEnabled('trae', false)
    const again = createPluginStore({ dataDir: dir, logger: silent })
    assert.equal(again.get('trae').enabled, false)
    // 但内置项必须还在清单里：丢掉记录 = 下次启动又补回来，用户会以为没生效
    assert.ok(again.get('trae'))
  })

  // ⑦ 插件文件缺失时，报因而不是抛栈
  await test('插件文件缺失时给出可读原因', async () => {
    const dir = freshDir('missing')
    const store = createPluginStore({ dataDir: dir, logger: silent })
    store.add({ id: 'ghost', source: path.join(dir, 'no-such-dir') })
    const host = createPluginHost({ dataDir: dir, logger: silent })
    const info = host.load()
    const failure = info.failures.find(item => item.id === 'ghost')
    assert.ok(failure, '缺失的插件要在失败清单里')
    assert.match(failure.error, /插件文件缺失/)
    await host.shutdown()
  })

  // ⑧ 清单兼容：老清单（只有 Trae）升级后 qoder 自动补回来
  await test('老清单缺少内置插件时自动补齐', async () => {
    const dir = freshDir('legacy')
    fs.writeFileSync(path.join(dir, 'channels-plugins.json'), JSON.stringify({
      plugins: [{ id: 'trae', spec: 'builtin:trae', builtin: true, enabled: false, source: 'plugins/trae' }],
    }))
    const store = createPluginStore({ dataDir: dir, logger: silent })
    const ids = store.list().map(item => item.id).sort()
    assert.deepEqual(ids, ['qoder', 'trae'])
    // 补齐的那家不该顺手把用户对 Trae 的停用改回来
    assert.equal(store.get('trae').enabled, false)
    assert.equal(store.get('qoder').enabled, true)
  })

  // ⑨ 签到状态：Trae 的账号行要报出「今天签过没」
  //
  // 面板靠这个字段把「签到」按钮置灰。判据是**自然日**而不是「上次签到时刻」，
  // 所以跨零点必须自动失效 —— 否则第二天按钮还是灰的，用户再也点不动。
  await test('Trae 报出今日签到状态（跨零点失效）', async () => {
    const dir = freshDir('checkin-state')
    const host = createPluginHost({ dataDir: dir, logger: silent })
    host.load()
    const today = localDay(Date.now())
    const yesterday = localDay(Date.now() - 24 * 60 * 60 * 1000)
    fs.writeFileSync(path.join(dir, 'trae-accounts.json'), JSON.stringify({
      accounts: [
        { uid: 'signed-today', id: 'trae-aaaaaaaa', name: '今天签过', enabled: true, lastCheckinDay: today, lastCheckinAt: 1700000000000 },
        { uid: 'signed-yesterday', id: 'trae-bbbbbbbb', name: '昨天签过', enabled: true, lastCheckinDay: yesterday, lastCheckinAt: 1699000000000 },
        { uid: 'never', id: 'trae-cccccccc', name: '没签过', enabled: true },
      ],
    }))
    const rows = host.instanceOf('trae').backend.listAccounts('trae')
    const byUid = new Map(rows.map(row => [row.uid, row]))
    assert.equal(byUid.get('signed-today').checkinDone, true, '今天签过要报 true')
    assert.equal(byUid.get('signed-today').lastCheckinAt, 1700000000000, '最近签到时刻要透出来')
    assert.equal(byUid.get('signed-yesterday').checkinDone, false, '昨天签的不算今天签过')
    assert.equal(byUid.get('never').checkinDone, false, '从没签过不该报 true')
    assert.equal(byUid.get('never').lastCheckinAt, 0, '没签过时时刻为 0，不是 undefined')
    await host.shutdown()
  })

  // ⑩ 签到落盘：成功的路径才记「今天签过」，失败不能记
  //
  // 这条是按钮置灰的数据来源。记早了（失败也记）按钮会灰一整天，用户明明
  // 没签成却点不动；记漏了（上游说已签过却不记）按钮永远可点，点下去只回
  // 一句「今天已签过」。
  await test('Trae 签到落盘：成功 / 已签过才记，失败不记', async () => {
    const dir = freshDir('checkin-persist')
    // 只写凭据文件、不写注册表：顺带覆盖「账号只在凭据里」这条迁移路径 ——
    // 补写注册表时 id 必须沿用凭据键名，不能重算 hash
    const uid = 'legacy-uid-001'
    const key = `TRAE_ACCOUNT_${'DEADBEEF'}`
    fs.writeFileSync(path.join(dir, 'channel-credentials.json'), JSON.stringify({
      [key]: JSON.stringify({ uid, access_token: 'token-x', refresh_token: '', phone: '138****0001' }),
    }))

    const host = createPluginHost({ dataDir: dir, logger: silent })
    host.load()
    const backend = host.instanceOf('trae').backend

    // 上游替身：按顺序回 status / claim / status 三帧
    const realFetch = global.fetch
    function stub(frames) {
      let index = 0
      global.fetch = async () => {
        const frame = frames[Math.min(index++, frames.length - 1)]
        return { ok: true, status: 200, json: async () => frame }
      }
    }
    try {
      // ① 今天还没签 → claim 成功 → 应记下
      stub([
        { code: 0, checked_in: false, enable: true },
        { code: 0 },
        { code: 0, checked_in: true, credits: 42 },
      ])
      const first = await backend.checkin('trae', uid)
      assert.equal(first.outcome, 'claimed')
      let row = backend.listAccounts('trae').find(item => item.uid === uid)
      assert.equal(row.checkinDone, true, '签到成功后要报「今天签过」')
      assert.ok(row.lastCheckinAt > 0, '成功路径要记下签到时刻')
      assert.equal(row.id, `trae-${'deadbeef'}`, 'id 必须沿用凭据键名，不能重算 hash')

      // ② 上游说今天已签过 → 也该记（且不把时刻写成此刻）
      fs.rmSync(path.join(dir, 'trae-accounts.json'))
      stub([{ code: 0, checked_in: true, enable: true }])
      const second = await backend.checkin('trae', uid)
      assert.equal(second.outcome, 'done')
      row = backend.listAccounts('trae').find(item => item.uid === uid)
      assert.equal(row.checkinDone, true, '上游说已签过也要记下来')
      assert.equal(row.lastCheckinAt, 0, '只知道日期、不知道时刻，不能编一个 now')

      // ③ 领取失败（9074 人数过多）→ 不能记，否则按钮灰一整天
      fs.rmSync(path.join(dir, 'trae-accounts.json'))
      stub([{ code: 0, checked_in: false, enable: true }, { code: 9074, msg: '签到人数过多' }])
      const third = await backend.checkin('trae', uid)
      assert.equal(third.outcome, 'failed')
      row = backend.listAccounts('trae').find(item => item.uid === uid)
      assert.equal(row.checkinDone, false, '失败不该记成已签到')
    } finally {
      global.fetch = realFetch
      await host.shutdown()
    }
  })

  if (process.exitCode) {
    console.error('\n插件宿主回归失败。')
  } else {
    console.log(`\n${passed} 项通过`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
