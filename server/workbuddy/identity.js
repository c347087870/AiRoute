// WorkBuddy 客户端指纹与版本覆盖（identity）配置层
// 所有字段留空 = 使用官方默认值，行为与未配置化之前完全一致。
// 校验规则：白名单字段 + trim + 长度 ≤256 + 无控制字符（防头注入）；
// 数值字段仅接受纯数字；域名字段须 http(s):// 前缀（尾部斜杠自动去除）。
// DEFAULTS / effective() 供界面回填：输入框展示「当前生效值（覆盖 > 官方默认）」。
// 注意：DEFAULTS 为出站链路默认值的权威快照，修改 constants.js / 消费端默认时必须同步本表。

const C = require('./constants')

// 普通字符串字段（版本号 / UA 覆盖 / 事件体指纹文本 / 语言）
const STRING_FIELDS = [
  'clientVersion', // WorkBuddy 主链路版本（UA 两段 + X-IDE-Version）
  'cliVersion', // CLI 段版本（主链路 WorkBuddy UA / 桌面 UA）
  'ideVersion', // CodeBuddy 身份版本（UA + X-IDE-Version）
  'desktopVersion', // 桌面事件链版本（UA 两段 + 事件体 ideVersion/extVersion）
  'workbuddyUA', // WorkBuddy 身份 UA 整串覆盖
  'codebuddyUA', // CodeBuddy 身份 UA 整串覆盖
  'workbuddyBillingUA', // billing 域 UA 覆盖（workbuddy 身份）
  'codebuddyBillingUA', // billing 域 UA 覆盖（codebuddy 身份）
  'desktopUA', // 桌面事件链 UA 整串覆盖
  'v3ConfigUA', // /v3/config 探测 UA 整串覆盖
  'oauthUA', // OAuth 登录 UA 整串覆盖
  'webUA', // Web 事件体浏览器 UA 覆盖
  'mpVersion', // mp 小程序版本（上报头 X-Client-Version + 事件体）
  'mpExtVersion', // mp 专家/灵感事件 extVersion
  'desktopCommit', // 桌面事件体 git commit
  'desktopOsVersion', // 桌面事件体 osVersion
  'webOs', // Web 事件体 os
  'webOsVersion', // Web 事件体 osVersion
  'mpOs', // mp 事件体 os
  'mpOsVersion', // mp 事件体 osVersion
  'mpArch', // mp 事件体 arch
  'mpMachineId', // mp 事件体 machineId
  'acceptLanguage' // 出站 Accept-Language
]

// 纯数字字段（时间戳 / 核数 / 内存）
const NUMERIC_FIELDS = ['desktopReleaseDate', 'desktopCpuCores', 'desktopMemorySize']

// 域名字段（须 http(s):// 前缀）
const URL_FIELDS = ['chatBase', 'billingBase', 'webBase', 'originReferer']

// 通用字符串清洗：trim + 长度/控制字符校验，非法返回空串
function cleanString(v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (!s || s.length > 256) return ''
  if (/[\u0000-\u001f\u007f]/.test(s)) return ''
  return s
}

// 归一化 identity 配置：白名单提取 + 逐字段校验，非法字段直接丢弃（消费端回落默认值）
function normalize(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of STRING_FIELDS) {
    const s = cleanString(raw[k])
    if (s) out[k] = s
  }
  for (const k of NUMERIC_FIELDS) {
    const s = cleanString(raw[k])
    if (s && /^\d+$/.test(s)) out[k] = s
  }
  for (const k of URL_FIELDS) {
    const s = cleanString(raw[k])
    if (s && /^https?:\/\/\S+$/i.test(s)) out[k] = s.replace(/\/+$/, '')
  }
  return out
}

// 30 项官方默认值快照（键序与界面表单一致；数值字段以字符串存放）
const DEFAULTS = {
  // 版本号
  clientVersion: C.DEFAULT_CLIENT_VERSION,
  ideVersion: C.DEFAULT_IDE_VERSION,
  cliVersion: C.DEFAULT_CLI_VERSION,
  desktopVersion: C.DEFAULT_DESKTOP_VERSION,
  // 请求头 UA 覆盖与 mp 版本（默认按版本号拼接 / 官方固定串）
  workbuddyUA: `WorkBuddy/${C.DEFAULT_CLIENT_VERSION} WorkBuddy/${C.DEFAULT_CLIENT_VERSION} CLI/${C.DEFAULT_CLI_VERSION}`,
  codebuddyUA: `CodeBuddyIDE/${C.DEFAULT_IDE_VERSION} CodeBuddy/${C.DEFAULT_IDE_VERSION}`,
  workbuddyBillingUA: `WorkBuddy/${C.DEFAULT_CLIENT_VERSION}`,
  codebuddyBillingUA: `CodeBuddy/${C.DEFAULT_IDE_VERSION}`,
  desktopUA: `WorkBuddy/${C.DEFAULT_DESKTOP_VERSION} WorkBuddy/${C.DEFAULT_DESKTOP_VERSION} CLI/${C.DEFAULT_CLI_VERSION}`,
  v3ConfigUA: `CodeBuddyIDE/${C.DEFAULT_IDE_VERSION} CodeBuddy/${C.DEFAULT_IDE_VERSION}`,
  oauthUA: C.CODEBUDDY_CLI_UA,
  webUA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  mpVersion: '2.4.0',
  mpExtVersion: '2.2.8',
  // 事件体指纹
  desktopCommit: '5f9692923c93033111c51ad7b003eb80204a9b75',
  desktopReleaseDate: '1789036585355',
  desktopOsVersion: '10.0.26220',
  desktopCpuCores: '20',
  desktopMemorySize: '24',
  webOs: 'Win32',
  webOsVersion: '10.0',
  mpOs: 'windows',
  mpOsVersion: '11',
  mpArch: 'x64',
  mpMachineId: '0655736a-607f-4d9d-b430-58176ee9a090',
  // 语言与域名
  acceptLanguage: 'zh-CN',
  chatBase: C.CHAT_BASE_CN,
  billingBase: C.BILLING_BASE_CN,
  webBase: C.WEB_BASE_CN,
  originReferer: C.ORIGIN_REFERER_CN
}

// 合并「已保存覆盖 + 官方默认」为完整生效值（界面回填用）
function effective(saved) {
  return { ...DEFAULTS, ...(saved || {}) }
}

module.exports = { normalize, effective, DEFAULTS, STRING_FIELDS, NUMERIC_FIELDS, URL_FIELDS }
