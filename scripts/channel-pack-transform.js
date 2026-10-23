// 渠道包产物 → server/channels/business.mjs 的改写管线
//
// 单独成模块，是因为它有两个使用者：scripts/build-channels.js（生成）与
// scripts/verify-channels.js（校验）。校验脚本必须跑**同一条**管线，才能把
// 「磁盘上的产物」与「当前上游 pack.js 的改写结果」逐字节比出来 —— 这样它能同时
// 抓住两件事：产物被人手改过、上游换了产物但没重跑生成。
//
// 为什么要改写而不能直接 require 原包：`pack.js` 是 DSH 插件的 ESM 打包产物，
// 它导入的 `@deepseek-ai/*` 由宿主提供（cordis 上下文、llm 注册表、凭据服务）。
// AiRoute 没有这些服务，于是走「contracts.mjs 提供同形状替身 + worker 里造一个
// 最小 ctx」的路线（与上游 packages/standalone 的做法一致）：
//
//   1. 删掉仅供宿主设置页使用的 schema（schemastery 不在依赖里）；
//   2. 把 `@deepseek-ai/*` 的导入改指到 ./contracts.mjs；
//   3. 渠道数据目录改由宿主注入（ctx.platform.channelHome）；
//   4. 去掉宿主自带的 OpenAI 网关与 Agent 续跑：AiRoute 自己就是网关；
//   5. Qoder 的 WASM 改成与 business.mjs 同目录（随 server/channels 一起打包）；
//   6. 补导出 worker 需要的协议转换函数。
//
// 生成结果是**产物**：改渠道行为要回到上游改源码后重跑生成，不要手改产物。

const crypto = require('crypto')

function sourceHash(source) {
  return crypto.createHash('sha256').update(source).digest('hex')
}

// 每处替换都要求「唯一命中」：上游改了产物形状时要立刻失败，而不是静默产出
// 一个半改写的文件（那种文件通常能加载，然后在某个渠道登录时才炸）。
function replaceOnce(output, from, to) {
  const parts = output.split(from)
  if (parts.length !== 2) {
    throw new Error(`build-channels: 替换位置不唯一或已改变：${String(from).slice(0, 90)}`)
  }
  return to === undefined ? parts[0] + parts[1] : parts[0] + to + parts[1]
}

function replaceMatch(output, pattern, to) {
  const matched = output.match(pattern)
  if (!matched) throw new Error(`build-channels: 未匹配到 ${pattern}`)
  return replaceOnce(output, matched[0], to)
}

// source 可以是 Buffer 或字符串。传 Buffer 更保险：头部的 SHA256 与原产物逐字节对应。
function transform(source) {
  const hash = sourceHash(source)
  let output = Buffer.isBuffer(source) ? source.toString('utf8') : String(source)

  // 1. 宿主设置表单的 schema（AiRoute 直接用自己的 Vue 页面，不需要它）
  output = output.replace(/^import Schema2? from "@deepseek-ai\/schemastery";\r?\n/gm, '')
  output = replaceMatch(output, /var channelPackSchema = Schema\.object\(\{[\s\S]*?\n\}\);/, 'var channelPackSchema;')
  output = replaceMatch(output, /var Config = Schema2\.object\(\{[\s\S]*?\n\}\);/, 'var Config;')

  // 2. 宿主服务 → 本地替身（形状见 server/channels/contracts.mjs）
  output = output.replace(/from "@deepseek-ai\/(?:cordis|dsh-credentials|dsh-llm|dsh-agent)"/g, 'from "./contracts.mjs"')

  // 3. 数据目录由 worker 注入，不读 DSH 的 home
  output = replaceMatch(
    output,
    /function resolveChannelPackHome\(ctx\) \{[\s\S]*?\n\}/,
    'function resolveChannelPackHome(ctx) {\n  if (typeof ctx.platform?.channelHome !== "string") throw new Error("渠道缺少数据目录");\n  return ctx.platform.channelHome;\n}'
  )

  // 4. 网关与续跑由 AiRoute 提供
  output = replaceOnce(
    output,
    '  mountOpenAiGateway(ctx, pool);\n  installLoopResume(ctx);',
    '  // AiRoute 自己就是统一网关，宿主的 loop 续跑也没有对应服务。'
  )

  // 5. WASM 与产物同目录（build.js 整目录复制 server/）
  output = replaceOnce(
    output,
    'resolve(dirname(fileURLToPath(import.meta.url)), "qoder-auth-wasm.wasm")',
    'fileURLToPath(new URL("./qoder-auth-wasm.wasm", import.meta.url))'
  )

  // 6. 导出 worker 需要的协议转换与目录采集函数（原产物的内部实现）
  output = replaceOnce(
    output,
    'export {\n  Config,',
    `export {
  toGenerateOptions, toResponsesGenerateOptions, normalizeReasoningEffort,
  responsesReasoningEffort, normalizeMaxTokens, responsesMaxOutputTokens,
  markGatewayChannel,
  collectGatewayModels, collectGatewayEffortViews, toOpenAiModels,
  Config,`
  )

  if (/@deepseek-ai\/.*["'];/.test(output)) {
    throw new Error('build-channels: 产物仍引用宿主模块')
  }

  return `// 由 scripts/build-channels.js 生成，请勿手改。
// 原渠道包 SHA256: ${hash}
` + output
}

module.exports = { transform, sourceHash }
