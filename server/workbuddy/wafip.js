// WAF IP 级拦截 fail-fast 状态机
// 翻译自参考项目 internal/server/wafip.go
//
// 背景：WAF 403 拦的是网关出口 IP 而非账号——轮转会把一次客户端请求放大 MaxRotate 倍，
// 同一出口 IP 继续打上游只会加重风控。判定：短窗内 ≥2 个**不同**账号接连命中 WAF 403
// 即判 IP 级拦截并快速失败；单号反复 403（账号级偶发）永不触发（只数不同号）。
// 激活期内新命中不续期（保守：不做主动探测，窗口自然解除）。进程内状态、重启清零。

const C = require('./constants')

// 创建 WAF IP 级门（窗口与阈值可注入，默认按 constants.WAF_IP）
function createWafIpGate(opts = {}) {
  const windowMs = opts.windowMs > 0 ? opts.windowMs : C.WAF_IP.windowMs
  const threshold = opts.threshold > 0 ? opts.threshold : C.WAF_IP.threshold
  const hits = new Map() // uid → 最近一次 WAF 403 时刻（判定窗内，惰性剪枝）
  let until = 0 // IP 级拦截激活截止；0 = 未激活

  // 记录一次某账号的 WAF 403，返回记账后 IP 级拦截是否激活（调用方据此 fail-fast）
  function noteWaf(uid) {
    const now = Date.now()
    if (now < until) return true // 激活期内：不续期、不记账（自然解除语义）
    hits.set(uid, now) // 同号重复命中覆盖不累计（判定口径是「不同号数」）
    for (const [u, t] of hits) {
      if (now - t > windowMs) hits.delete(u)
    }
    if (hits.size >= threshold) {
      until = now + windowMs
      hits.clear() // 解除后需全新命中重新判定，不叠旧账
      return true
    }
    return false
  }

  // 当前是否处于 IP 级拦截激活期
  function active() {
    return Date.now() < until
  }

  return { noteWaf, active }
}

module.exports = { createWafIpGate }