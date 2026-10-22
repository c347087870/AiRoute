// 渠道的「个人中心 / 明细」链接
//
// 渠道包只定义了各家的 API 与 OAuth 端点，**没有**控制台地址这一概念 —— 所以
// 默认值优先用确证过的明细页，其次才是能从渠道包源码里确证的官方域名（登录页 /
// 账号中心那一批）。不猜深层路径：拼错的路径会打开一个 404 页面，比没有按钮更
// 让人困惑。用户可以在卡片上继续改，覆盖值只存本机 localStorage，
// 与卡片顺序同口径 —— 这是这台机器的偏好，不该进全局配置。
//
// Raccoon 留空：它是桌面端渠道，渠道包里除了入口页静态资源（o.alicdn.com）
// 没有任何网页域名。与其填一个错的首页，不如让用户自己填。

const STORAGE_KEY = 'airoute.channels-console-links'

// 每个渠道一到多个入口。WorkBuddy 国内版与国际版是两个独立站点（与模型
// 前缀 workbuddy / workbuddy-global 对应），所以按 realm 分成两条。
const SLOTS = {
  lobsterai: [{ key: 'default', label: 'LobsterAI', url: 'https://lobsterai.youdao.com/portal#/profile/detail' }],
  qoder: [{ key: 'default', label: 'Qoder', url: 'https://qoder.com' }],
  qodercn: [{ key: 'default', label: 'Qoder 中国版', url: 'https://qoder.cn' }],
  trae: [{ key: 'default', label: 'TRAE', url: 'https://www.trae.cn' }],
  cline: [{ key: 'default', label: 'Cline', url: 'https://app.cline.bot' }],
  loomy: [{ key: 'default', label: 'Loomy', url: 'https://loomy.xunfei.cn' }],
  raccoon: [{ key: 'default', label: 'Raccoon', url: '' }],
  minimax: [{ key: 'default', label: 'MiniMax', url: 'https://account.minimax.cn' }],
  zcode: [{ key: 'default', label: 'ZCode', url: 'https://bigmodel.cn' }],
  gemini: [{ key: 'default', label: 'Gemini', url: 'https://aistudio.google.com' }],
  workbuddy: [
    { key: 'cn', label: '国内版', url: 'https://copilot.tencent.com' },
    { key: 'global', label: '国际版', url: 'https://www.workbuddy.ai/profile/plans-usage' }
  ]
}

const FALLBACK_SLOT = { key: 'default', label: '个人中心', url: '' }

export function slotsOf(providerId) {
  const slots = SLOTS[providerId]
  return slots && slots.length ? slots : [FALLBACK_SLOT]
}

export function linkKeyOf(providerId, slotKey) {
  return `${providerId}:${slotKey}`
}

// 读覆盖值。JSON 坏掉就当没有 —— 一条自定链接不值得让页面白屏
export function readCustomLinks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    const out = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim()
    }
    return out
  } catch {
    return {}
  }
}

export function saveCustomLinks(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 隐私模式下 localStorage 可能不可写；链接退化成默认值，不该影响其它功能 */
  }
}
