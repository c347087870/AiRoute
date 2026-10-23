// 「这次失败算谁的」判定：只有**明确**是客户端取消的，才不能计入模型的连续失败。
//
// ## 为什么单独抽一个模块
//
// 这条规则错一次的代价很高：坏模型永远进不了失活，于是每次新会话都先撞它一次，
// 而它的表现恰恰是「卡住不返回」—— 用户看到的就是 loading 假死。
// 它的触发条件又是高延迟 + 客户端断开，手工点不出来，只能靠离线回归守住。
//
// ## 原来的判据为什么错
//
// 旧实现按错误文案里的 `abort` 一刀切。可 undici 与我们自己的 abort() 都会抛
// `This operation was aborted`，其中既有「用户点了停止」，也有「上游卡死到超时」。
// 后者被当成取消，连续失败计数就永远停在 0。现在改成只认三种显式信号：
// 499 状态码、调用方挂上的 clientCancelled 标记、以及文案里带 cancel / 取消。

// 渠道转发的首帧上限：从发请求到收到第一段内容之间的静默最伤人 —— 客户端没有任何
// 反馈，只能等它自己的超时，用户看到的就是「loading 假死」。
//
// 渠道包自己只保证 120 秒的 first-token 超时（DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS），
// 而客户端往往在那之前就放弃：于是这次请求既没换成兜底模型，也没被记成失败，
// 下一轮还是它先上，永远卡在同一个模型上。这里提前收手，把机会让给链上的下一个候选。
// 60 秒：这些渠道实测首帧多在 1~15 秒，思考型模型也极少静默过一分钟。
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 60000

function resolveFirstChunkTimeoutMs(env = process.env) {
  const raw = Number.parseInt(env.AIROUTE_CHANNEL_FIRST_CHUNK_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FIRST_CHUNK_TIMEOUT_MS
}

const CHANNEL_FIRST_CHUNK_TIMEOUT_MS = resolveFirstChunkTimeoutMs()

function stallMessage(timeoutMs) {
  return `渠道 ${Math.round(timeoutMs / 1000)} 秒内没有返回任何内容（上游卡住，已放弃这一次）`
}

/**
 * 失败条目是否属于「用户主动取消」（关页面、点停止）。是则不计入连续失败。
 *
 * @param {{ status?: number, error?: string, clientCancelled?: boolean }} entry
 */
function isAbortFailure(entry = {}) {
  if (entry.status === 499) return true
  if (entry.clientCancelled === true) return true
  const text = String(entry.error || '')
  return /cancel|取消|已断开|断开连接/i.test(text)
}

/**
 * 一次渠道转发失败的归属与状态码（纯函数）。
 *
 * @param {object} input
 * @param {boolean} input.started 是否已经对客户端写出过帧（承诺过 200）
 * @param {boolean} input.stalled 首帧看门狗是否已经掐了这一次
 * @param {boolean} input.clientClosed 客户端是否在等待期内断开
 * @param {number} input.elapsedMs 本次尝试已耗时
 * @param {number} [input.timeoutMs] 首帧上限（省略则用默认值）
 * @param {Error} [input.error] 原始错误（取上游状态码用）
 * @returns {{ status: number, kind?: string, clientCancelled?: boolean, message?: string }}
 *          message 为空表示沿用原始错误文案
 */
function classifyChannelFailure({
  started = false,
  stalled = false,
  clientClosed = false,
  elapsedMs = 0,
  timeoutMs = CHANNEL_FIRST_CHUNK_TIMEOUT_MS,
  error
} = {}) {
  // 已经写过帧：状态码只用于日志（调用方会补错误帧收尾，不换源）
  if (started) return { status: 502 }
  if (stalled) return { status: 504, kind: 'stall', message: stallMessage(timeoutMs) }
  if (clientClosed && elapsedMs < timeoutMs) return { status: 499, clientCancelled: true }
  // 等过了首帧上限才被客户端放弃：仍然是「卡住」，不能算用户取消
  if (clientClosed) return { status: 504, kind: 'stall', message: stallMessage(timeoutMs) }
  // 渠道包把上游状态码放在 statusCode 上（模型不存在 404、无可用账号 503 等）；
  // 一律压成 500 会让「换个模型就行」看起来像网关故障
  return { status: error?.status || error?.statusCode || 502 }
}

module.exports = {
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  CHANNEL_FIRST_CHUNK_TIMEOUT_MS,
  resolveFirstChunkTimeoutMs,
  stallMessage,
  isAbortFailure,
  classifyChannelFailure
}
