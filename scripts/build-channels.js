// 从 dsh-our-free-model 的渠道包产物生成 AiRoute 自用的渠道业务模块
//
//     OFM_CHANNEL_PACK=/path/to/dsh-our-free-model/vendor/channel-pack/pack.js \
//       node scripts/build-channels.js
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
//   5. Qoder 的 WASM 改成与 business.mjs 同目录（随 server/channels 一起打包）。
//
// 生成结果是 `server/channels/business.mjs`，属于**产物**：改渠道行为要回到
// 上游改源码后重跑本脚本，不要手改产物。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = path.join(__dirname, '..')
const source = process.env.OFM_CHANNEL_PACK || ''
const outFile = path.join(root, 'server', 'channels', 'business.mjs')

if (!source || !fs.existsSync(source)) {
  console.error('build-channels: 需要 OFM_CHANNEL_PACK 指向 dsh-our-free-model/vendor/channel-pack/pack.js')
  process.exit(1)
}

let output = fs.readFileSync(source, 'utf8')

// 每处替换都要求「唯一命中」：上游改了产物形状时要立刻失败，而不是静默产出
// 一个半改写的文件（那种文件通常能加载，然后在某个渠道登录时才炸）。
function replaceOnce(from, to) {
  const parts = output.split(from)
  if (parts.length !== 2) {
    throw new Error(`build-channels: 替换位置不唯一或已改变：${String(from).slice(0, 90)}`)
  }
  output = to === undefined ? parts[0] + parts[1] : parts[0] + to + parts[1]
}

function replaceMatch(pattern, to) {
  const matched = output.match(pattern)
  if (!matched) throw new Error(`build-channels: 未匹配到 ${pattern}`)
  replaceOnce(matched[0], to)
}

// 1. 宿主设置表单的 schema（AiRoute 直接用自己的 Vue 页面，不需要它）
output = output.replace(/^import Schema2? from "@deepseek-ai\/schemastery";\r?\n/gm, '')
replaceMatch(/var channelPackSchema = Schema\.object\(\{[\s\S]*?\n\}\);/, 'var channelPackSchema;')
replaceMatch(/var Config = Schema2\.object\(\{[\s\S]*?\n\}\);/, 'var Config;')

// 2. 宿主服务 → 本地替身（形状见 server/channels/contracts.mjs）
output = output.replace(/from "@deepseek-ai\/(?:cordis|dsh-credentials|dsh-llm|dsh-agent)"/g, 'from "./contracts.mjs"')

// 3. 数据目录由 worker 注入，不读 DSH 的 home
replaceMatch(
  /function resolveChannelPackHome\(ctx\) \{[\s\S]*?\n\}/,
  'function resolveChannelPackHome(ctx) {\n  if (typeof ctx.platform?.channelHome !== "string") throw new Error("渠道缺少数据目录");\n  return ctx.platform.channelHome;\n}'
)

// 4. 网关与续跑由 AiRoute 提供
replaceOnce(
  '  mountOpenAiGateway(ctx, pool);\n  installLoopResume(ctx);',
  '  // AiRoute 自己就是统一网关，宿主的 loop 续跑也没有对应服务。'
)

// 5. WASM 与产物同目录（build.js 整目录复制 server/）
replaceOnce(
  'resolve(dirname(fileURLToPath(import.meta.url)), "qoder-auth-wasm.wasm")',
  'fileURLToPath(new URL("./qoder-auth-wasm.wasm", import.meta.url))'
)

// 6. 导出 worker 需要的协议转换与目录采集函数（原产物的内部实现）
replaceOnce(
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

const header = `// 由 scripts/build-channels.js 生成，请勿手改。
// 原渠道包 SHA256: ${crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')}
`
fs.writeFileSync(outFile, header + output)
console.log(`[aiRoute] 已生成 ${path.relative(root, outFile)}（${(output.length / 1024 / 1024).toFixed(2)} MB）`)
