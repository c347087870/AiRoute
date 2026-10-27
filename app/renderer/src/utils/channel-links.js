// 渠道的「个人中心 / 明细」链接
//
// 渠道只定义了 API 与 OAuth 端点，**没有**控制台地址这一概念 —— 所以这里只写
// 确证过的官方地址，不猜深层路径：拼错的路径会打开一个 404 页面，比没有按钮
// 更让人困惑。三条深层路径（Trae 的 /dashboard、Qoder 双版的 /account/usage）
// 都是人工在浏览器里确认过的。
//
// 这张表是**只读**的：页面上的「明细」按钮直接取默认值打开浏览器。
// 曾经允许用户改并存在 localStorage，但那需要一个编辑入口（齿轮 → 编辑弹层）
// 和一套「这条链接存在哪」的解释，而大多数人从来不点。

// 每个渠道一到多个入口。WorkBuddy 国内版与国际版是两个独立站点（与模型
// 前缀 workbuddy / workbuddy-global 对应），所以按 realm 分成两条。
const SLOTS = {
  qoder: [{ key: 'default', label: 'Qoder', url: 'https://qoder.com/account/usage' }],
  qodercn: [{ key: 'default', label: 'Qoder 国内版', url: 'https://qoder.cn/account/usage' }],
  trae: [{ key: 'default', label: 'Trae', url: 'https://www.trae.cn/dashboard' }],
  workbuddy: [
    { key: 'cn', label: '国内版', url: 'https://www.workbuddy.cn/profile' },
    { key: 'global', label: '国际版', url: 'https://www.workbuddy.ai/profile/plans-usage' }
  ]
}

const FALLBACK_SLOT = { key: 'default', label: '个人中心', url: '' }

export function slotsOf(providerId) {
  const slots = SLOTS[providerId]
  return slots && slots.length ? slots : [FALLBACK_SLOT]
}
