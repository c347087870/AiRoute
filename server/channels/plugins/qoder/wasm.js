// Qoder 加密推理：内嵌 WASM 的 wasm-bindgen 桥
//
// Qoder 的真实推理链路是加密的：
//
//     POST {encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1
//
// 请求体由 Qoder 客户端自带的 `qoder_auth_wasm` 加密，`Authorization` 也是它签的
// （`Bearer COSY.<载荷>.<签名>`）。那个 WASM 随 Qoder 桌面端分发，是不加密的纯算法
// 产物 —— 这里直接按 wasm-bindgen 约定把它接起来调用，**不是破解**：没有剥离
// 任何混淆，调用的是它自己导出的函数。
//
// ⚠️ 三个必须记住的点：
// 1. 加密端点与公开端点**不是同一个 host**（`api2.qoder.sh` vs `api2-v2.qoder.sh`），
//    混用会 404；
// 2. 加密端点只认**目录 key**（`qfmodel` / `dmodel`），公开端点只认通用名
//    （`qwen-flash`）—— 发错端点的症状是 `invalid_model_error`；
// 3. 响应**没有加密**，只是多一层信封（`{body:"<内层 JSON>"}`），见 envelope.js。
//
// 实例不是线程安全的：一个账号一个实例。

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const WASM_PATH = path.join(__dirname, 'qoder-auth-wasm.wasm')

// wasm-bindgen 生成的 import 对象名（WASM 里 embed 了这个模块路径）
const IMPORT_MODULE = './qoder_auth_wasm_bg.js'

// 影响 Cosy-Version 头与签名载荷的客户端版本
const COSY_VERSION = '1.0.0'

let gluePromise = null

function getGlue() {
  if (!gluePromise) gluePromise = createGlue()
  return gluePromise
}

async function createGlue() {
  const bytes = fs.readFileSync(WASM_PATH)
  const module = await WebAssembly.compile(bytes)

  let exports = {}
  let cachedHeap = null
  let cachedView = null

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const encoder = new TextEncoder()

  const heap = () => {
    const buffer = exports.memory.buffer
    if (cachedHeap === null || cachedHeap.byteLength === 0 || cachedHeap.buffer !== buffer) {
      cachedHeap = new Uint8Array(buffer)
    }
    return cachedHeap
  }
  const view = () => {
    const buffer = exports.memory.buffer
    if (cachedView === null || cachedView.buffer !== buffer) cachedView = new DataView(buffer)
    return cachedView
  }
  const readString = (ptr, len) => decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len))

  // 对象堆：与官方 glue 一致，1024 个 undefined 槽 + 四个哨兵
  const objects = new Array(1024).fill(undefined)
  objects.push(undefined, null, true, false)
  let firstFree = objects.length
  const heapObject = index => objects[index]
  const pushObject = value => {
    if (firstFree === objects.length) objects.push(objects.length + 1)
    const index = firstFree
    firstFree = objects[index]
    objects[index] = value
    return index
  }
  const takeObject = index => {
    const value = heapObject(index)
    // 索引 < 1028 是哨兵（undefined / null / true / false），不可回收
    if (index >= 1028) {
      objects[index] = firstFree
      firstFree = index
    }
    return value
  }

  let lastLength = 0
  const writeString = text => {
    const encoded = encoder.encode(text)
    const ptr = exports.__wbindgen_export2(encoded.length, 1) >>> 0
    heap().subarray(ptr, ptr + encoded.length).set(encoded)
    lastLength = encoded.length
    return ptr
  }

  // 调用「返回字符串」型导出：栈上出 ptr/len/error 三个值
  const callString = invoke => {
    let ptr = 0
    let len = 0
    const stack = exports.__wbindgen_add_to_stack_pointer(-16)
    try {
      invoke(stack)
      ptr = view().getInt32(stack + 0, true)
      len = view().getInt32(stack + 4, true)
      if (view().getInt32(stack + 12, true)) throw takeObject(view().getInt32(stack + 8, true))
      return readString(ptr, len)
    } finally {
      exports.__wbindgen_add_to_stack_pointer(16)
      if (ptr) exports.__wbindgen_export4(ptr, len, 1)
    }
  }

  // 调用「返回对象指针」型导出
  const callPointer = invoke => {
    const stack = exports.__wbindgen_add_to_stack_pointer(-16)
    try {
      invoke(stack)
      if (view().getInt32(stack + 8, true)) throw takeObject(view().getInt32(stack + 4, true))
      return view().getInt32(stack + 0, true)
    } finally {
      exports.__wbindgen_add_to_stack_pointer(16)
    }
  }

  // wasm-bindgen 的「调用 JS 函数并捕获异常」包装
  const guard = (fn, args) => {
    try {
      fn(...args)
    } catch (error) {
      exports.__wbindgen_export(pushObject(error))
    }
  }

  const imports = {
    __wbindgen_object_drop_ref: a => takeObject(a),
    __wbindgen_object_clone_ref: a => pushObject(heapObject(a)),
    __wbindgen_cast_0000000000000001: (a, e) => pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
    __wbindgen_cast_0000000000000002: (a, e) => pushObject(readString(a, e)),
    __wbg_set_08463b1df38a7e29: (a, e, t) =>
      pushObject(heapObject(a).set(heapObject(e), heapObject(t))),
    // ⚠️ 这两个 getRandomValues 的签名**方向相反**：一个写 wasm 内存，一个调 JS 对象。
    // 写反会得到 Rust panic `unreachable`。
    __wbg_getRandomValues_d49329ff89a07af1: (...args) => guard((x, y) => {
      globalThis.crypto.getRandomValues(heap().subarray(x >>> 0, (x >>> 0) + y))
    }, args),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => guard((x, y) => {
      heapObject(x).getRandomValues(heapObject(y))
    }, args),
    __wbg_crypto_38df2bab126b63dc: a => pushObject(heapObject(a).crypto),
    __wbg_process_44c7a14e11e9f69e: a => pushObject(heapObject(a).process),
    __wbg_versions_276b2795b1c6a219: a => pushObject(heapObject(a).versions),
    __wbg_node_84ea875411254db1: a => pushObject(heapObject(a).node),
    __wbg_require_b4edbdcf3e2a1ef0: (...args) => guard(() => pushObject(module), args),
    __wbg_msCrypto_bd5a034af96bcba6: a => pushObject(heapObject(a).msCrypto),
    __wbg_randomFillSync_6c25eac9869eb53c: (...args) => guard((x, y) => {
      heapObject(x).randomFillSync(takeObject(y))
    }, args),
    __wbg_call_d578befcc3145dee: (...args) => guard((fn, self, arg) => {
      pushObject(heapObject(fn).call(heapObject(self), heapObject(arg)))
    }, args),
    __wbg_new_with_length_9cedd08484b73942: a => pushObject(new Uint8Array(a >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: a => heapObject(a).length,
    __wbg_prototypesetcall_3e05eb9545565046: (a, e, t) => {
      Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t))
    },
    __wbg_subarray_0f98d3fb634508ad: (a, e, t) => pushObject(heapObject(a).subarray(e >>> 0, t >>> 0)),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
      (globalThis.self === undefined ? 0 : pushObject(globalThis.self)),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
      (globalThis.window === undefined ? 0 : pushObject(globalThis.window)),
    __wbg___wbindgen_throw_81fc77679af83bc6: (p, l) => { throw new Error(readString(p, l)) },
    __wbg_Error_2e59b1b37a9a34c3: (p, l) => pushObject(new Error(readString(p, l))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: id => {
      const value = heapObject(id)
      return typeof value === 'object' && value !== null
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: id => typeof heapObject(id) === 'string',
    __wbg___wbindgen_is_function_49868bde5eb1e745: id => typeof heapObject(id) === 'function',
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: id => heapObject(id) === undefined,
  }

  const instance = await WebAssembly.instantiate(module, { [IMPORT_MODULE]: imports })
  exports = instance.exports

  return {
    exports,
    heap,
    view,
    readString,
    writeString,
    lastLength: () => lastLength,
    heapObject,
    pushObject,
    takeObject,
    callString,
    callPointer,
  }
}

// 运行时鉴权字段：服务端识别用户身份的依据，QoderContext 构造时要用
async function generateRuntimeAuthFields(user) {
  const g = await getGlue()
  const payload = JSON.stringify({
    uid: user.uid,
    security_oauth_token: user.securityOauthToken,
    organization_id: user.organizationId ?? '',
    organization_tags: user.organizationTags ?? [],
    data_policy_agreed: user.dataPolicyAgreed ?? false,
  })
  const raw = g.callString(stack => {
    const ptr = g.writeString(payload)
    g.exports.generate_runtime_auth_fields(stack, ptr, g.lastLength())
  })
  return JSON.parse(raw)
}

// 构造加密端点 `agent_chat_generation` 的**明文请求体**。
//
// 逐项复刻官方客户端：`chat_context` 不能传空对象，`business` 缺失会被路由到
// 故障节点（`qfmodel` 恒落到 oa_qwen-plus 并返回 Execution failed），`tools`
// 必须是**顶层**数组且无工具时传 `[]`（不是缺字段）。
function buildInferPayload(ask, requestId) {
  const isReasoning = ask.isReasoning ?? false
  const text = ask.userText
  const parameters = {}
  if (ask.maxTokens !== undefined) parameters.max_tokens = ask.maxTokens
  if (ask.reasoningEffort !== undefined) {
    parameters.reasoning_effort = ask.reasoningEffort
    parameters.enable_thinking = ask.reasoningEffort !== 'none'
  }
  if (ask.contextWindow !== undefined) parameters.context_length = ask.contextWindow

  // 逐字段搬运：只保留协议认识的三个键，不把宿主内部字段发给上游
  const messages = (ask.history ?? []).map(message => ({
    role: message.role,
    content: message.content,
    ...message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls },
    ...message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id },
  }))
  if (messages.length === 0) messages.push({ role: 'user', content: text })

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: ask.modelKey, is_reasoning: isReasoning },
        originalContent: text,
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: ask.sessionType ?? 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: ask.modelKey,
      display_name: ask.displayName ?? '',
      model: '',
      format: ask.format ?? 'openai',
      is_vl: ask.isVl ?? true,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: ask.source ?? 'system',
      max_input_tokens: ask.maxInputTokens ?? ask.contextWindow ?? 200000,
    },
    custom_model: null,
    system: ask.systemText ? [{ type: 'text', text: ask.systemText }] : [],
    messages,
    tools: ask.tools ?? [],
    parameters,
    ...ask.business === undefined ? {} : { business: ask.business },
  }
}

// 一个账号一个实例：持有 WASM 里的 QoderContext（有状态，不跨账号复用）
class QoderEncryptedInfer {
  constructor(glue, context, host) {
    this.glue = glue
    this.context = context
    this.host = host
  }

  static async create({ user, machineId, metadata, host, clientVersion }) {
    const g = await getGlue()
    const fields = await generateRuntimeAuthFields(user)
    const version = clientVersion ?? COSY_VERSION
    const userInfoJson = JSON.stringify({
      uid: user.uid,
      encrypt_user_info: fields.encrypt_user_info,
      key: fields.key,
      organization_id: user.organizationId ?? '',
      organization_tags: user.organizationTags ?? [],
      data_policy_agreed: user.dataPolicyAgreed ?? false,
    })
    const context = g.callPointer(stack => {
      const machine = g.writeString(machineId)
      const machineLen = g.lastLength()
      const ver = g.writeString(version)
      const verLen = g.lastLength()
      const info = g.writeString(userInfoJson)
      const infoLen = g.lastLength()
      const meta = g.writeString(JSON.stringify(metadata))
      const metaLen = g.lastLength()
      // 参数顺序：(sp, machineId, len, version, len, userInfo, len, clientMeta, len)
      g.exports.qodercontext_new(stack, machine, machineLen, ver, verLen, info, infoLen, meta, metaLen)
    })
    return new QoderEncryptedInfer(g, context, host)
  }

  // 构造一次加密请求（url / headers / body）。
  //
  // ⚠️ 返回的 headers 必须**原样透传**：里面的 Authorization 是 WASM 签的
  // `Bearer COSY.<载荷>.<签名>`，换成普通 Bearer 会 403 Signature invalid。
  prepareInfer(ask) {
    const g = this.glue
    const payload = buildInferPayload(ask, crypto.randomUUID())
    const result = g.callPointer(stack => {
      const host = g.writeString(this.host)
      const hostLen = g.lastLength()
      const body = g.writeString(JSON.stringify(payload))
      const bodyLen = g.lastLength()
      const key = g.writeString(ask.modelKey)
      const keyLen = g.lastLength()
      const source = g.writeString(ask.source ?? 'system')
      const sourceLen = g.lastLength()
      g.exports.qodercontext_prepareInferRequest(
        stack, this.context, host, hostLen, body, bodyLen, key, keyLen, source, sourceLen,
      )
    })

    const headerMap = g.takeObject(g.exports.requestresult_headers(result))
    const headers = {}
    if (headerMap instanceof Map) {
      for (const [key, value] of headerMap) headers[String(key)] = String(value)
    }

    const readResultString = invoke => {
      const stack = g.exports.__wbindgen_add_to_stack_pointer(-16)
      try {
        invoke(stack, result)
        const ptr = g.view().getInt32(stack + 0, true)
        const len = g.view().getInt32(stack + 4, true)
        return ptr ? g.readString(ptr, len) : ''
      } finally {
        g.exports.__wbindgen_add_to_stack_pointer(16)
      }
    }

    return {
      // ⚠️ 参数顺序是 (栈指针, ptr)，与直觉相反
      url: readResultString((stack, ptr) => g.exports.requestresult_url(stack, ptr)),
      headers,
      body: readResultString((stack, ptr) => g.exports.requestresult_body(stack, ptr)),
    }
  }
}

module.exports = {
  QoderEncryptedInfer,
  generateRuntimeAuthFields,
  buildInferPayload,
  COSY_VERSION,
  WASM_PATH,
}
