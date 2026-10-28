// Trae 签到 / 积分响应的离线回归：不联网、不需要真实账号。
//
//     node scripts/test-trae-credits.js
//
// 守的是「上游响应的字段路径」。这三条响应都是**平铺**的，没有 data 那一层，
// 而早期实现按 `body.data.checked_in` / `body.data.credits` / `body.data.total_credits`
// 去读，于是三个症状同时出现（用户报障，2026-10-26）：
//
//   · 已签到的账号判不出来 → 重复发 claim。Trae 的 claim 对已签到是幂等的，
//     照样回 `{"code":0}`，与真正领到无法区分；
//   · 领取金额恒为 undefined → 面板显示「+? 积分」（formatCredit(NaN) = '?'）；
//   · 余额恒为 null → 面板显示「上游未返回积分余额」。
//
// 下面的固定用例全部来自对 api.trae.cn 的真实抓包（账号 132******33），
// 不要为了让实现变绿去改这些字面量 —— 它们就是上游现在的样子。

const assert = require('node:assert/strict')
const path = require('node:path')

const root = path.join(__dirname, '..')
const protocol = require(path.join(root, 'server/channels/plugins/trae/protocol.js'))

const checks = []
const check = (name, fn) => checks.push({ name, fn })

// ── 真实响应样本 ──

// POST /trae/api/v2/ug/checkin_credits/status —— 今天已签过
const STATUS_CHECKED_IN = {
  checked_in: true,
  code: 0,
  credits: 100,
  did_checked_in: true,
  enable: true,
  extra_credits: 100,
  message: 'success',
}

// 同上，还没签
const STATUS_NOT_CHECKED_IN = {
  checked_in: false,
  code: 0,
  credits: 100,
  did_checked_in: false,
  enable: true,
  extra_credits: 100,
  message: 'success',
}

// 活动未开启（免费 / 企业套餐）：code 仍是 0，靠 enable 区分
const STATUS_DISABLED = { checked_in: false, code: 0, enable: false, message: 'success' }

// 鉴权失效
const STATUS_AUTH_FAILED = {
  checked_in: false,
  code: 1001,
  enable: false,
  message: "We're sorry, but we are not able to authenticate you.",
}

// POST /trae/api/v2/ug/checkin_credits/claim —— 成功，**不含任何积分数**
const CLAIM_OK = { code: 0, message: 'success' }

// 9074「签到人数过多」
const CLAIM_BUSY = { code: 9074, message: '签到人数过多，请稍后再试' }

// 1005 套餐不参与
const CLAIM_PLAN_LIMIT = { code: 1005, message: 'plan limit' }

// POST /trae/api/v2/pay/ide_user_ent_usage —— 5 个资源包
const BALANCE = {
  is_credits_billing: true,
  usage_summary: { consumed_amount: 12.26, consumption_ratio: 0.015325, total_amount: 800 },
  user_entitlement_pack_list: [
    // 「免费」是占位包，没有 quota.credits_limit
    { display_desc: '免费', entitlement_base_info: { display_desc: '免费' }, expire_time: 1793462399 },
    {
      display_desc: '每月登录赠送',
      entitlement_base_info: { display_desc: '每月登录赠送', quota: { credits_limit: 500 } },
      usage: { credits_amount: 12.2644 },
      expire_time: 1793462399,
    },
    {
      display_desc: '签到奖励',
      entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 100 } },
      expire_time: 1795328840,
    },
    {
      display_desc: '签到奖励',
      entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 100 } },
      expire_time: 1795399104,
    },
    {
      display_desc: '签到奖励',
      entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 100 } },
      expire_time: 1795656426,
    },
  ],
}

// ── 状态解析 ──

check('状态：已签到能被认出来（判据是平铺的 checked_in）', () => {
  const parsed = protocol.parseCheckinStatus(STATUS_CHECKED_IN)
  assert.equal(parsed.checkedIn, true, 'checked_in 不在 data 下面')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.credits, 100, '金额只在 status 端点里')
})

check('状态：未签到', () => {
  const parsed = protocol.parseCheckinStatus(STATUS_NOT_CHECKED_IN)
  assert.equal(parsed.checkedIn, false)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.credits, 100)
})

check('状态：活动未开启与「没签到」是两件事', () => {
  const parsed = protocol.parseCheckinStatus(STATUS_DISABLED)
  assert.equal(parsed.ok, true, 'code 0 仍是成功响应')
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.checkedIn, false)
})

check('状态：1001 鉴权失效要能识别', () => {
  const parsed = protocol.parseCheckinStatus(STATUS_AUTH_FAILED)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, protocol.CHECKIN_CODE_AUTH)
  // 1001 的响应里 checked_in 也是 false —— 不能靠它判「没签过」就去 claim
  assert.equal(parsed.checkedIn, false)
})

check('状态：缺字段不抛栈，按「没签过 + 金额 0」处理', () => {
  const parsed = protocol.parseCheckinStatus({})
  assert.equal(parsed.checkedIn, false)
  assert.equal(parsed.credits, 0)
  // 没给 enable 不等于关闭（只有明确 false 才算关闭）
  assert.equal(parsed.enabled, true)
})

// ── 领取解析 ──

check('领取：成功响应里没有金额（这正是「+? 积分」的源头）', () => {
  const parsed = protocol.parseClaimResponse(CLAIM_OK)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.code, 0)
  assert.equal(parsed.credits, undefined, 'claim 响应不该被当成有金额')
  // 真实响应就这三个键：任何 credits 都是实现编出来的
  assert.deepEqual(Object.keys(CLAIM_OK).sort(), ['code', 'message'])
})

check('领取：9074「人数过多」是失败，不是成功', () => {
  const parsed = protocol.parseClaimResponse(CLAIM_BUSY)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, protocol.CHECKIN_CODE_BUSY)
  assert.match(parsed.message, /人数过多/)
})

check('领取：1005 套餐不参与', () => {
  const parsed = protocol.parseClaimResponse(CLAIM_PLAN_LIMIT)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, protocol.CHECKIN_CODE_PLAN_LIMIT)
})

check('领取：业务码是字符串形态也要认（网关会回 "9074"）', () => {
  assert.equal(protocol.parseClaimResponse({ code: '9074' }).code, 9074)
  assert.equal(protocol.parseClaimResponse({ code: '0' }).ok, true)
})

check('领取：缺 code 视为成功（上游没给码），非数字视为失败', () => {
  assert.equal(protocol.parseClaimResponse({}).ok, true)
  assert.equal(protocol.parseClaimResponse({ code: 'oops' }).ok, false)
})

// ── 余额解析 ──

check('余额：Σ(credits_limit - credits_amount)，跳过无额度的占位包', () => {
  const parsed = protocol.parseCreditBalance(BALANCE)
  // 500-12.2644 = 487.7356，三个签到包各 100，合计 787.7356 → 787.74
  assert.equal(parsed.total, 787.74)
  assert.equal(parsed.packages.length, 4, '「免费」包不含额度，不参与合计')
  assert.equal(parsed.packages[0].name, '每月登录赠送')
  assert.equal(parsed.packages[0].remaining, 487.74)
})

check('余额：包名取 display_desc（base.name 实测恒 undefined）', () => {
  const parsed = protocol.parseCreditBalance(BALANCE)
  assert.deepEqual(parsed.packages.map(pkg => pkg.name), ['每月登录赠送', '签到奖励', '签到奖励', '签到奖励'])
  for (const pkg of parsed.packages) assert.notEqual(pkg.name, '资源包')
})

check('余额：expire_time 是秒级，要 ×1000 转毫秒', () => {
  const parsed = protocol.parseCreditBalance(BALANCE)
  // 1793462399 = 2026-10-31 前后，不乘 1000 会落到 1970 年
  assert.equal(parsed.packages[0].expireAt, 1793462399 * 1000)
  assert.ok(new Date(parsed.packages[0].expireAt).getFullYear() >= 2026)
})

check('余额：已用超过上限时剩余钳到 0，不出现负数', () => {
  const parsed = protocol.parseCreditBalance({
    user_entitlement_pack_list: [{
      entitlement_base_info: { display_desc: '超额包', quota: { credits_limit: 100 } },
      usage: { credits_amount: 250 },
    }],
  })
  assert.equal(parsed.total, 0)
  assert.equal(parsed.packages[0].remaining, 0)
})

check('余额：响应缺 pack_list 时回 0 而不是抛栈', () => {
  const parsed = protocol.parseCreditBalance({})
  assert.equal(parsed.total, 0)
  assert.deepEqual(parsed.packages, [])
})

// ── 端到端口径：面板最终显示什么 ──

check('端到端：已签到的账号不该被再 claim 一次', () => {
  // 复刻 provider.checkin 的前两步判据
  const status = protocol.parseCheckinStatus(STATUS_CHECKED_IN)
  const shouldClaim = status.ok && status.enabled && !status.checkedIn
  assert.equal(shouldClaim, false, '已签到还去 claim，会拿到幂等的 code 0 被误报成「领取成功」')
})

check('端到端：领取成功后的金额来自 status，不是 claim', () => {
  // claim 只有 code/message；金额回查 status
  const claim = protocol.parseClaimResponse(CLAIM_OK)
  assert.equal(claim.ok, true)
  const status = protocol.parseCheckinStatus(STATUS_CHECKED_IN)
  assert.equal(status.credits, 100, '「+100 积分」的 100 只能来自这里')
})

check('端到端：金额取不到时按「未返回」处理，不伪造 0', () => {
  const status = protocol.parseCheckinStatus({ code: 0 })
  assert.equal(status.credits, 0)
  // provider 的写法是 `...credit > 0 ? { credit } : {}`，0 就不带 credit
  const outcome = { outcome: 'claimed', ...(status.credits > 0 ? { credit: status.credits } : {}) }
  assert.equal('credit' in outcome, false, '带 0 会让面板显示「+0 积分」')
})

async function main() {
  let failed = 0
  for (const item of checks) {
    try {
      await item.fn()
      console.log(`ok   ${item.name}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL ${item.name}\n     ${error.message}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} 项通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
