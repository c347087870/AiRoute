// 客户端 IP 解析：只在 TCP 对端位于可信代理网段时才采信转发头，
// 且 X-Forwarded-For 从右往左取（右侧才是最近一跳代理追加的地址），避免来源 IP 被伪造

// 可信代理网段（回环 + 私网 + 链路本地）：外层反向代理应落在此范围；
// 对端不在此范围（公网直连）时一律用对端地址，转发头完全不看。
// 如需支持自定义代理网段，在此维护
const TRUSTED_PROXY_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10'
]

// X-Forwarded-For 取右往左第 N 跳（1 = 最接近本服务的一跳）
const TRUSTED_PROXY_HOPS = 1

// IPv4 文本 → 32 位整数（非法返回 null）
function ipv4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

// IPv6 文本 → 16 字节数组（支持 :: 缩写与尾段 IPv4 形式；非法返回 null）
function ipv6ToBytes(ip) {
  let s = String(ip).toLowerCase().split('%')[0] // 去掉 zone id（fe80::1%eth0）
  if (s.includes('.')) {
    // 尾段 IPv4（::ffff:1.2.3.4）→ 转成两个 16 位组
    const idx = s.lastIndexOf(':')
    const v4 = ipv4ToInt(s.slice(idx + 1))
    if (v4 === null) return null
    s = `${s.slice(0, idx + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const headParts = head ? head.split(':').filter(Boolean) : []
  let groups
  if (tail === undefined) {
    groups = headParts
  } else {
    const tailParts = tail ? tail.split(':').filter(Boolean) : []
    const missing = 8 - headParts.length - tailParts.length
    if (missing < 0) return null
    groups = [...headParts, ...Array(missing).fill('0'), ...tailParts]
  }
  if (groups.length !== 8) return null
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i], 16)
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null
    bytes[i * 2] = v >> 8
    bytes[i * 2 + 1] = v & 0xff
  }
  return bytes
}

// 按位前缀比较两个字节数组
function matchBits(a, b, bits) {
  const full = Math.floor(bits / 8)
  for (let i = 0; i < full; i++) {
    if (a[i] !== b[i]) return false
  }
  const rest = bits % 8
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (a[full] & mask) === (b[full] & mask)
}

// 判断 IP 是否落在 CIDR 内（IPv4/IPv6 均按位比较；非法输入一律不匹配）
function inCidr(ip, cidr) {
  const slash = String(cidr).indexOf('/')
  const base = slash >= 0 ? String(cidr).slice(0, slash) : String(cidr)
  const bits = slash >= 0 ? Number(String(cidr).slice(slash + 1)) : null
  if (bits === null || !Number.isInteger(bits) || bits < 0) return false

  if (String(ip).includes(':')) {
    const ipBytes = ipv6ToBytes(ip)
    const baseBytes = ipv6ToBytes(base)
    if (!ipBytes || !baseBytes || bits > 128) return false
    if (bits === 0) return true
    return matchBits(ipBytes, baseBytes, bits)
  }
  const ipInt = ipv4ToInt(ip)
  const baseInt = ipv4ToInt(base)
  if (ipInt === null || baseInt === null || bits > 32) return false
  if (bits === 0) return true
  const mask = (~((1 << (32 - bits)) - 1)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

// 归一化 IP：去 IPv6 映射前缀（::ffff:1.2.3.4 → 1.2.3.4）、去端口（1.2.3.4:5678 / [::1]:3000）
function normalizeIP(raw) {
  let ip = String(raw || '').trim()
  if (!ip) return ''
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7)
  const bracket = ip.match(/^\[(.+)\]:\d+$/)
  if (bracket) return bracket[1]
  const withPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (withPort) return withPort[1]
  return ip
}

// 对端是否为可信代理（可直接采信其转发头）：回环 / 私网 / 链路本地
function isTrustedProxy(ip) {
  if (!ip) return false
  return TRUSTED_PROXY_CIDRS.some(cidr => inCidr(ip, cidr))
}

// 客户端真实 IP：
// 1) TCP 对端不可信（公网直连）→ 一律用对端地址，转发头可伪造不看；
// 2) 对端可信（本机 / 私网）→ 优先 X-Real-IP，其次 X-Forwarded-For 从右往左取第 N 跳，
//    都没有则用对端地址
function extractClientIP(req) {
  const headers = (req && req.headers) || {}
  const peer = normalizeIP((req && req.socket && req.socket.remoteAddress) || '')
  if (!peer) return ''
  if (!isTrustedProxy(peer)) return peer

  const real = normalizeIP(headers['x-real-ip'] || headers['X-Real-IP'] || '')
  if (real) return real

  const xff = String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '')
  const parts = xff
    .split(',')
    .map(s => normalizeIP(s))
    .filter(Boolean)
  if (!parts.length) return peer
  const idx = parts.length - TRUSTED_PROXY_HOPS
  return parts[idx >= 0 ? idx : 0] || peer
}

module.exports = {
  extractClientIP,
  isTrustedProxy,
  inCidr,
  normalizeIP
}
