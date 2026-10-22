// 渠道运行时宿主（主进程侧）
//
// 一个 AiRoute 实例对应一个 worker（见 worker.mjs 的文件头）。这里只做四件事：
// 转发调用、把 chunk 交给调用方、把目录缓存起来、可重入地关停。
//
// 与 WorkBuddy 的 runtime 不同，渠道业务不在本进程，所以这里没有账号池状态可
// 读取；需要账号信息一律走 rpc（渠道包自己的状态才是权威，缓存一份只会漂移）。

const path = require('path')
const { Worker } = require('worker_threads')

const MODELS_TIMEOUT_MS = 60000
const RPC_TIMEOUT_MS = 10 * 60000
const COMPLETE_TIMEOUT_MS = 30 * 60000

function createChannelRuntime({ dataDir, logger = console, onChanged, host }) {
  const worker = new Worker(path.join(__dirname, 'worker.mjs'), {
    workerData: { dataDir },
    // 父进程的 --input-type 会被 worker 继承，而本 worker 是真实文件
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
  })

  const pending = new Map()
  let sequence = 0
  let closed = false
  let closing = null
  let failed = null
  let finishClose = null
  let rows = []
  let providers = []
  let refreshing = null
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })

  const rejectAll = error => {
    failed = error
    readyReject(error)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  worker.on('error', rejectAll)
  worker.on('exit', code => {
    if (!closed) rejectAll(new Error(`渠道进程已退出（${code}）`))
    finishClose?.()
  })
  worker.on('message', message => {
    if (message.type === 'ready') {
      providers = message.providers
      readyResolve()
      return
    }
    // 反向调用：worker 里的适配器需要主进程的数据（WorkBuddy 的账号池与模型
    // 目录都在主进程，worker 里再建一份就会有两套真相）
    if (message.type === 'host') {
      const handler = host?.[message.op]
      if (typeof handler !== 'function') {
        worker.postMessage({ type: 'host-error', hid: message.hid, message: `宿主未实现渠道操作：${message.op}` })
        return
      }
      Promise.resolve()
        .then(() => handler(message.payload ?? {}))
        .then(
          value => worker.postMessage({ type: 'host-result', hid: message.hid, value }),
          error => worker.postMessage({
            type: 'host-error',
            hid: message.hid,
            message: error?.message || String(error),
            statusCode: error?.statusCode ?? error?.status,
          }),
        )
      return
    }
    if (message.type === 'log') {
      logger[message.level]?.(message.message)
      return
    }
    if (message.type === 'closed') {
      finishClose?.()
      return
    }
    // 渠道包在账号变更后会 emit：目录随之失效（登录完就能看到新模型）
    if (message.type === 'changed') {
      if (closed) return
      rows = []
      try {
        onChanged?.()
      } catch (error) {
        logger.warn?.(`渠道变更回调失败：${error.message}`)
      }
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'chunk') {
      try {
        entry.onChunk?.(message.chunk)
      } catch (error) {
        entry.reject(error)
        worker.postMessage({ type: 'cancel', id: message.id })
      }
    } else if (message.type === 'error') {
      entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    } else {
      entry.resolve(message.value)
    }
  })

  function call(type, payload = {}, signal, onChunk, timeoutMs = MODELS_TIMEOUT_MS) {
    if (closed || failed) return Promise.reject(failed ?? new Error('渠道已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const finish = fn => value => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        pending.delete(id)
        fn(value)
      }
      const abort = () => {
        worker.postMessage({ type: 'cancel', id })
        entry.reject(signal?.reason ?? new Error('渠道请求超时或已取消'))
      }
      const timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }

  function refresh() {
    if (refreshing) return refreshing
    refreshing = call('models', {}, undefined, undefined, MODELS_TIMEOUT_MS)
      .then(value => { rows = value; return rows })
      .finally(() => { refreshing = null })
    return refreshing
  }

  const runtime = {
    get providers() { return providers },
    state() { return { state: failed ? 'failed' : 'ready', error: failed ? failed.message : '' } },
    publicModelRows: () => rows,
    refresh,
    // 渠道包播报的是 `provider/model`，这与 AiRoute 的引用格式一致（第一段是
    // Provider，其余整段是模型 id），所以这里只做前缀判断，不解析。
    handles: model => !failed && providers.some(provider => model.startsWith(`${provider}/`)),
    rpc: (body, signal) => {
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) {
        return Promise.reject(Object.assign(new Error('渠道请求缺少 method 或 payload'), { statusCode: 400 }))
      }
      return call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, RPC_TIMEOUT_MS)
    },
    complete: (request, onChunk, signal) =>
      call('complete', { request }, signal, onChunk, COMPLETE_TIMEOUT_MS),
    close() {
      if (closing) return closing
      closed = true
      rejectAll(new Error('渠道正在停止'))
      closing = (async () => {
        let timer
        await new Promise(resolve => {
          finishClose = resolve
          worker.postMessage({ type: 'close' })
          timer = setTimeout(resolve, 1500)
        })
        clearTimeout(timer)
        await worker.terminate()
      })()
      return closing
    },
  }

  runtime.ready = (async () => {
    const timeout = setTimeout(() => {
      failed = new Error('渠道初始化超时')
      readyReject(failed)
    }, 30000)
    try {
      await ready
    } finally {
      clearTimeout(timeout)
    }
    // 目录刷新放在后台：某个渠道登录态异常不该拖住服务启动
    runtime.refresh().catch(error => { if (!closed) logger.warn?.(`渠道模型目录刷新失败：${error.message}`) })
    return runtime
  })().catch(async error => {
    await runtime.close()
    throw error
  })

  return runtime
}

module.exports = { createChannelRuntime }
