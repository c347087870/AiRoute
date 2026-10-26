// 登录状态文案：把上游原话翻译成人话
//
// 上游的「还没登录完」是业务码回包，例如 WorkBuddy 的
//   code=11217 msg=login ing...
// 直接摆到界面上既看不懂也暴露内部码。这里只做展示层翻译，
// 原话仍保留在 title 里备查（排查时要看上游到底说了什么）。

// 上游「仍在等待授权」的两种形态：code=11217 与 msg 里带 login ing
const WAITING_CODES = ['11217', '11218']

function isWaitingMessage(raw) {
  const s = String(raw || '').trim()
  if (!s) return false
  if (WAITING_CODES.some(code => s.includes(`code=${code}`))) return true
  return /login\s*ing/i.test(s)
}

// 把上游原话换成中文提示；认不出来就原样返回（别把信息吞掉）
export function friendlyLoginMessage(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (isWaitingMessage(s)) return '等待你在浏览器里完成授权…'
  // code=xxxx msg=yyyy：保留 msg（多半是人话），去掉裸业务码前缀
  const m = s.match(/^code=\S+\s+msg=(.*)$/)
  if (m) {
    const msg = m[1].trim()
    if (!msg) return '授权未完成，请重试'
    return msg
  }
  return s
}
