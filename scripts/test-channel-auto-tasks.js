// 渠道自动任务（自动签到 / 积分刷新）的离线回归：不联网、不需要真实账号
//
//     node scripts/test-channel-auto-tasks.js
//
// 守住的是「什么时候跑」这件事：
//   · 到点才签，且同一家每天只签一次（进程重启也不重复签）；
//   · 失败按 30 分钟重试、最多 3 次（不成功也不无限打上游）；
//   · 积分按设置的分钟间隔刷新，0 = 关；
//   · 没有账号 / 渠道没装 / 没有该能力 时一律不发请求。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const { createAutoTasks, _internal } = require(path.join(root, 'server', 'channels', 'auto-tasks'))
const qoderProtocol = require(path.join(root, 'server', 'channels', 'plugins', 'qoder', 'protocol'))

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

function freshDir(name) {
  const dir = path.join(os.tmpdir(), `airoute-auto-tasks-${name}-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// UTC+8 构造：排程按 UTC+8 的日/时判断（Qoder 活动窗口与 Trae 的北京 dayKey），
// 测试不能依赖运行机器的时区
function localAt(hour, minute = 0, day = 11) {
  return Date.parse(`2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
}

function fakeRpc({ accounts = 1, checkinDone = false, summary = { claimed: 1, alreadyClaimed: 0, inactive: 0, failed: 0 }, statuses } = {}) {
  const calls = []
  const rpc = async body => {
    calls.push(body)
    if (body.method === 'provider.status') {
      const value = statuses || {
        trae: { accounts: { total: accounts, enabled: accounts }, capabilities: { checkin: true, balance: true } },
        qodercn: { accounts: { total: accounts, enabled: accounts }, capabilities: { checkin: true, balance: true } },
        qoder: { accounts: { total: accounts, enabled: accounts }, capabilities: { checkin: true, balance: true } },
      }
      return { ok: true, value: { statuses: value } }
    }
    if (body.method === 'account.list') {
      return { ok: true, value: Array.from({ length: accounts }, (_, index) => ({ uid: `u${index}`, checkinDone })) }
    }
    if (body.method === 'credits.claimAll') return { ok: true, value: { summary } }
    if (body.method === 'credits.balances') return { ok: true, value: { accounts: [] } }
    return { ok: false, error: `未支持：${body.method}` }
  }
  return { rpc, calls }
}

function makeTasks({ dir, rpc, nowRef, settings }) {
  return createAutoTasks({
    dataDir: dir,
    rpc,
    settings: settings || { forProvider: () => ({}) },
    providers: () => ['trae', 'qoder', 'qodercn'],
    logger: silent,
    now: () => nowRef.value,
  })
}

const countOf = (calls, method, provider) =>
  calls.filter(call => call.method === method && (!provider || call.payload?.provider === provider)).length

async function main() {
  await test('到点前不签到；积分首次到期会刷一次', async () => {
    const dir = freshDir('before-hour')
    const nowRef = { value: localAt(9, 30) }
    const { rpc, calls } = fakeRpc()
    const tasks = makeTasks({ dir, rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll'), 0, '09:30 还没到签到时点')
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 1, '余额首次查询没有节流')
    assert.equal(countOf(calls, 'credits.balances', 'qodercn'), 1)
    // 同一天再跑不重复查余额（默认 30 分钟）
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 1, '30 分钟内不该重复刷新余额')
  })

  await test('到点后给 Trae / Qoder 国内版各签一次，同一天不重复', async () => {
    const dir = freshDir('on-hour')
    const nowRef = { value: localAt(10, 5) }
    const { rpc, calls } = fakeRpc()
    const tasks = makeTasks({ dir, rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 1)
    assert.equal(countOf(calls, 'credits.claimAll', 'qodercn'), 1)
    assert.equal(countOf(calls, 'credits.claimAll', 'qoder'), 0, '国际版不在自动签到范围')
    assert.equal(tasks.state().checkin.trae.done, true)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 1, '当天第二次 tick 不该再签')
    assert.equal(countOf(calls, 'credits.claimAll', 'qodercn'), 1)
  })

  await test('10:00 整点不抢跑（Qoder 窗口刚切换，等 5 分钟）', async () => {
    const dir = freshDir('exact-hour')
    const nowRef = { value: localAt(10, 0) }
    const { rpc, calls } = fakeRpc()
    const tasks = makeTasks({ dir, rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll'), 0, '10:00:00 服务端可能还没发布新活动')
    nowRef.value = localAt(10, 4)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll'), 0, '10:04 仍不签')
    nowRef.value = localAt(10, 5)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 1, '10:05 开始签')
  })

  await test('重启后沿用落盘状态：同一天不重复签', async () => {
    const dir = freshDir('restart')
    const nowRef = { value: localAt(10, 5) }
    const first = fakeRpc()
    const tasks = makeTasks({ dir, rpc: first.rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(first.calls, 'credits.claimAll', 'trae'), 1)

    // 新进程 / 新实例读同一个 dataDir
    const second = fakeRpc()
    const restarted = makeTasks({ dir, rpc: second.rpc, nowRef })
    await restarted.tick()
    assert.equal(countOf(second.calls, 'credits.claimAll', 'trae'), 0, '重启后不该重新签一次')
  })

  await test('失败 30 分钟后重试，最多 3 次', async () => {
    const dir = freshDir('retry')
    const nowRef = { value: localAt(10, 5) }
    const { rpc, calls } = fakeRpc({ summary: { claimed: 0, alreadyClaimed: 0, inactive: 0, failed: 1 } })
    const tasks = makeTasks({ dir, rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 1)
    assert.equal(tasks.state().checkin.trae.done, false, '有失败不能记成已完成')

    nowRef.value = localAt(10, 15)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 1, '10 分钟内不重试')

    nowRef.value = localAt(10, 36)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 2, '30 分钟后重试第二次')

    nowRef.value = localAt(11, 7)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 3, '第三次')

    nowRef.value = localAt(12, 0)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 3, '3 次用完当天不再试')
  })

  await test('今天都签过了就不再打上游（claimAll 不调用）', async () => {
    const dir = freshDir('all-done')
    const nowRef = { value: localAt(11, 0) }
    const { rpc, calls } = fakeRpc({ checkinDone: true })
    const tasks = makeTasks({ dir, rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll'), 0, '账号都报 checkinDone 时不该再签')
    assert.equal(tasks.state().checkin.trae.done, true)
    assert.equal(tasks.state().checkin.qodercn.done, true)
    // 余额查询仍照常（它和签到是两件事）
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 1)
  })

  await test('关掉自动签到时一家都不签', async () => {
    const dir = freshDir('disabled')
    const nowRef = { value: localAt(23, 0) }
    const { rpc, calls } = fakeRpc()
    const settings = { forProvider: () => ({ autoCheckin: false }) }
    const tasks = makeTasks({ dir, rpc, nowRef, settings })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll'), 0)
    // 余额刷新仍按自己的配置跑
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 1)
  })

  await test('积分刷新间隔可配：0 = 关，超过间隔才再查', async () => {
    const dir = freshDir('balance-interval')
    const nowRef = { value: localAt(10, 0) }
    const { rpc, calls } = fakeRpc()
    const settings = { forProvider: () => ({ autoCheckin: false, balanceRefreshMinutes: 10 }) }
    const tasks = makeTasks({ dir, rpc, nowRef, settings })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 1)
    nowRef.value = localAt(10, 9)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 1, '未到 10 分钟')
    nowRef.value = localAt(10, 10)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.balances', 'trae'), 2, '到间隔要再查')

    const dir2 = freshDir('balance-off')
    const nowRef2 = { value: localAt(10, 0) }
    const second = fakeRpc()
    const off = makeTasks({
      dir: dir2,
      rpc: second.rpc,
      nowRef: nowRef2,
      settings: { forProvider: () => ({ balanceRefreshMinutes: 0 }) },
    })
    await off.tick()
    assert.equal(countOf(second.calls, 'credits.balances'), 0, '0 表示关闭余额刷新')
  })

  await test('没有账号 / 渠道没装时不发请求', async () => {
    const dir = freshDir('no-accounts')
    const nowRef = { value: localAt(10, 0) }
    const { rpc, calls } = fakeRpc({ accounts: 0 })
    const tasks = makeTasks({ dir, rpc, nowRef })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll'), 0, '没有账号不签')
    assert.equal(countOf(calls, 'credits.balances'), 0, '没有账号不查余额')

    const dir2 = freshDir('uninstalled')
    const second = fakeRpc({ statuses: {} })
    const absent = createAutoTasks({
      dataDir: dir2,
      rpc: second.rpc,
      settings: { forProvider: () => ({}) },
      providers: () => [],
      logger: silent,
      now: () => nowRef.value,
    })
    await absent.tick()
    assert.equal(second.calls.length, 1, '只查一次渠道状态，不碰账号')
  })

  await test('Qoder 在 10 点前启动会补上一窗口，10 点窗口换新后再签一次', async () => {
    const dir = freshDir('qoder-early-hour')
    const nowRef = { value: localAt(0, 5) }
    const { rpc, calls } = fakeRpc()
    const tasks = makeTasks({ dir, rpc, nowRef, settings: { forProvider: () => ({ autoCheckinHour: 0 }) } })
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'trae'), 1, 'Trae 按日历日，凌晨已算新的一天')
    assert.equal(countOf(calls, 'credits.claimAll', 'qodercn'), 1, 'Qoder 的当前窗口还是昨天 10 点那个：可以补签')
    nowRef.value = localAt(10, 5)
    await tasks.tick()
    assert.equal(countOf(calls, 'credits.claimAll', 'qodercn'), 2, '10 点窗口换了要再签一次')
  })

  await test('活动日键：UTC+8 10:00 换窗口', () => {
    const at = iso => qoderProtocol.checkinDayKey(Date.parse(iso))
    assert.equal(at('2026-11-11T10:05:00+08:00'), '2026-11-11')
    assert.equal(at('2026-11-11T09:59:00+08:00'), '2026-11-10', '10 点前仍算前一个窗口')
    assert.equal(at('2026-11-12T01:00:00+08:00'), '2026-11-11', '凌晨还是前一天的窗口')
    // 与系统时区无关：同一时刻在任何机器上都给出同一个键
    assert.equal(at('2026-11-12T10:00:00+08:00'), '2026-11-12')
    // 自动任务的排程键与插件里判「今天领过没」的键必须一致
    assert.equal(_internal.qoderDayKeyOf(Date.parse('2026-11-12T01:00:00+08:00')), '2026-11-11')
    assert.equal(_internal.qoderDayKeyOf(Date.parse('2026-11-12T10:00:00+08:00')), '2026-11-12')
  })

  await test('配置夹紧：时点 0-23、间隔 0-1440', () => {
    assert.equal(_internal.checkinHourOf({ autoCheckinHour: -3 }), 0)
    assert.equal(_internal.checkinHourOf({ autoCheckinHour: 99 }), 23)
    assert.equal(_internal.checkinHourOf({}), 10)
    assert.equal(_internal.balanceMinutesOf({ balanceRefreshMinutes: -1 }), 0)
    assert.equal(_internal.balanceMinutesOf({ balanceRefreshMinutes: 9999 }), 1440)
    assert.equal(_internal.balanceMinutesOf({}), 30)
  })

  console.log(`\n${passed} 项通过`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
