// 登录回调服务：给需要「浏览器授权后跳回本地」的渠道用
//
// TRAE 的授权页会把结果带在 `?userInfo=...&userJwt=...` 上跳到一个本地地址。
// AiRoute 在 `127.0.0.1` 上起一个**临时**监听，收到回调就交给渠道处理，
// 然后立刻关掉 —— 不为每个渠道常驻端口。
//
// 端口策略：优先 0（系统分配），因为固定端口撞上别的进程时，用户只会看到
// 「新建账号」按钮报 `EADDRINUSE`，看不出是端口问题。真实端口从 server.address() 取。
//
// ⚠️ `listen()` 的失败是**异步 error 事件**，不属于任何 Promise 链；
// 不预先注册处理器会变成进程级未捕获错误，把整个服务打崩。

const http = require('http')

class LoginSession {
  constructor({ server, port, state, provider, resolve, reject }) {
    this.server = server
    this.port = port
    this.state = state
    this.provider = provider
    this.resolve = resolve
    this.reject = reject
    this.settled = false
    this.timer = null
  }

  get callbackUrl() {
    return `http://127.0.0.1:${this.port}/authorize?state=${encodeURIComponent(this.state)}`
  }

  finish(error, value) {
    if (this.settled) return
    this.settled = true
    // 供面板轮询读取：不阻塞地告诉它「成了 / 失败原因」
    this.error = error ? error.message : ''
    this.value = value
    if (this.timer) clearTimeout(this.timer)
    if (error) this.reject(error)
    else this.resolve(value)
    // 回调已经拿到，端口没有保留的必要
    setTimeout(() => this.server.close(() => {}), 50).unref?.()
  }
}

function createLoginServer({ logger = console } = {}) {
  // 每个 state 一个会话；服务本身常驻一个（端口固定），按 state 分派
  const sessions = new Map()
  let server = null
  let port = 0
  let starting = null

  function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/authorize') {
      res.writeHead(404).end('not found')
      return
    }
    const state = url.searchParams.get('state') || ''
    const session = sessions.get(state)
    if (!session) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end('<p>这个登录链接已失效，请回到 AiRoute 重新发起登录。</p>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    // 先回页面再处理：上层可能要请求上游换令牌，让用户等半分钟不如直接给反馈
    Promise.resolve(session.onCallback(`/authorize?${url.searchParams.toString()}`))
      .then(message => {
        session.finish(null, message)
      })
      .catch(error => {
        session.finish(error)
        logger.warn?.(`[login] ${session.provider} 回调处理失败：${error.message}`)
      })
    res.end('<p>授权结果已收到，正在写入 AiRoute，可以关闭此页面。</p>')
  }

  function ensureServer() {
    if (server && port > 0) return Promise.resolve(port)
    if (starting) return starting
    starting = new Promise((resolve, reject) => {
      const created = http.createServer(handle)
      const onError = error => {
        // 启动失败：拒绝本次登录，但不让错误事件冒成进程级崩溃
        reject(error)
      }
      created.once('error', onError)
      created.listen(0, '127.0.0.1', () => {
        created.removeListener('error', onError)
        // 运行期仍可能出现 error（如 EMFILE）：必须有监听者
        created.on('error', error => logger.warn?.(`[login] 回调服务错误：${error.message}`))
        server = created
        port = created.address().port
        resolve(port)
      })
    }).finally(() => { starting = null })
    return starting
  }

  // 起一个登录：返回 { loginUrl（由调用方用 callbackUrl 拼）, wait() }
  //
  // `onCallback` 收到的是原始 URL（path + query），由渠道自己解析 ——
  // 各家的回调参数形态完全不同，公共层不该知道。
  async function start({ provider, state, onCallback }) {
    const listenPort = await ensureServer()
    let resolve
    let reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    const session = new LoginSession({ server, port: listenPort, state, provider, resolve, reject })
    session.onCallback = onCallback
    sessions.set(state, session)
    // 登录总时长上限：超过就清掉，避免内存里堆着永远不会完成的会话
    session.timer = setTimeout(() => {
      sessions.delete(state)
      session.finish(new Error('登录超时'))
    }, 10 * 60 * 1000)
    session.timer.unref?.()
    // 会话在 Promise 落定时不能立刻删：面板还在轮询 status()，
    // 删了会把「已完成」变成「会话不存在」。延迟清理由这里统一做。
    promise.then(() => {
      setTimeout(() => sessions.delete(state), 5 * 60 * 1000).unref?.()
    }, () => {
      setTimeout(() => sessions.delete(state), 5 * 60 * 1000).unref?.()
    })
    return {
      callbackUrl: session.callbackUrl,
      wait: () => promise,
      // 面板轮询用：返回 { done, ok, error }，不阻塞
      status: () => ({ done: session.settled, ok: session.settled && !session.error, error: session.error }),
    }
  }
  // 面板轮询用：拿某个 state 的登录结果（不存在返回 undefined）
  function statusOf(state) {
    const session = sessions.get(state)
    if (!session) return undefined
    return { provider: session.provider, done: session.settled, ok: session.settled && !session.error, error: session.error || '' }
  }

  function closeAll() {
    for (const session of sessions.values()) session.finish(new Error('服务正在停止'))
    sessions.clear()
    server?.close(() => {})
    server = null
    port = 0
  }

  return { start, statusOf, closeAll }
}

// 进程内共享一个实例：多个渠道各自起服务会各占一个端口
const loginServer = createLoginServer()

module.exports = { loginServer, createLoginServer }
