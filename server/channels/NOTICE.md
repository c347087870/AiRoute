# server/channels — 十个账号渠道的来源与再生成

本目录让 AiRoute 具备 LobsterAI、Qoder、Qoder 中国版、TRAE、Cline、Loomy、
Raccoon、MiniMax Code、ZCode、Gemini 十个账号渠道的登录、账号池、积分领取、
模型黑名单与推理能力。**渠道实现本身不是本项目写的**，来源与许可如下。

- 上游作者：Jet（<https://gitee.com/iJetLi>）
- 许可证：MIT（见同目录 `LICENSE`，版权声明随代码一并保留）
- 本项目经 `dsh-our-free-model` 的再打包产物引入：
  该仓库吸收了上游实现（提交 `345f0a07b22713c0ae189ca7d8b97ec4f64626c6`，
  2026-10-06），并提供了脱离宿主运行的 shim（`packages/standalone/channels/`）。

## 目录内容

| 路径 | 来源 | 说明 |
| --- | --- | --- |
| `business.mjs` | **生成产物** | 由 `scripts/build-channels.js` 从 `dsh-our-free-model/vendor/channel-pack/pack.js` 转换而来（2.3 MB ESM）。改渠道行为要回上游改源码后重跑脚本，**不要手改** |
| `qoder-auth-wasm.wasm` | 上游 | Qoder 加密推理所需的 WASM，必须与 `business.mjs` 同目录（产物按 `import.meta.url` 定位它） |
| `contracts.mjs` | OFM standalone | `@deepseek-ai/{cordis,dsh-credentials,dsh-llm}` 的形状替身：`LlmAdapter` 基类、`LlmError`、`ReasoningEffortId` 等 |
| `credentials.mjs` | OFM standalone | `ctx.credentials` 的文件实现：`channel-credentials.json`（0600，明文，与 `server/workbuddy-auths/` 同口径） |
| `images.mjs` | OFM standalone | `ctx.attachments`：图片读取与尺寸上限 |
| `worker.mjs` | 本项目改自 OFM standalone | 渠道包的宿主 `ctx`（credentials / llm / attachments / effect / inject / emit / connection.fetch）与 `models`/`rpc`/`complete` 三个操作 |
| `runtime.js` | 本项目 | 主进程侧的 worker 宿主：调用转发、目录缓存、可重入关停 |
| `sse.js` | 本项目 | 渠道 chunk → OpenAI Chat 的帧映射与用量口径换算 |
| `index.js` | 本项目 | CJS 门面：`init` / `getRuntime` / `refreshModels` / `rpc` / `shutdown` |

## 与 OFM standalone 版的差异

转换脚本对上游产物做了 5 处改写，都是为了在 AiRoute 里当库用：

1. **去掉宿主自带网关与 loop 续跑**（`mountOpenAiGateway` / `installLoopResume`）：
   AiRoute 自己就是统一网关，多开一个监听端口只会多一把 key、多一段排查链路。
2. **数据目录由宿主注入**（`ctx.platform.channelHome`）：不读 DSH 的 home，
   落到 `<AIROUTE_DATA_DIR>/channels-data/`（已 gitignore，且不进安装包）。
3. **WASM 改成与产物同目录**：`server/` 是整目录复制的，同目录才能一起分发。
4. **删掉 schemastery schema**：那是宿主设置页用的，AiRoute 用自己的 Vue 面板。
5. **`@deepseek-ai/*` 改指 `./contracts.mjs`**：宿主服务在这里由 shim 提供。

`worker.mjs` 另有一处差异：不再依赖 OFM 的 `src/messages.js` —— AiRoute 的
请求体在 HTTP 层就收敛成 OpenAI Chat 形态（Anthropic / Responses 由
`server/workbuddy/{anthropic,responses}.js` 转换），worker 只做协议到
`GenerateOptions` 的映射。

## 再生成

```bash
# 需要本机有一份 dsh-our-free-model 检出（提供 pack.js）
OFM_CHANNEL_PACK=/path/to/dsh-our-free-model/vendor/channel-pack/pack.js \
  node scripts/build-channels.js
```

脚本对每处替换都要求「唯一命中」：上游改了产物形状会立刻失败，而不是静默
产出一个能加载、直到某个渠道登录时才炸的文件。产物头部记录了源 `pack.js`
的 SHA256，便于核对引入的是哪一版。

## 注意

- `business.mjs` 是压缩后的单文件产物，**不可读也不可审**。要判断某条行为，
  以上游 `src/*.ts` 为准（同一提交）；产物与源码不一致时以源码为准并重跑脚本。
- 渠道包会在启动后自动签到、按定时任务领取积分，属预期行为（日志前缀
  `[channel-pack]`）。
- 未登录任何账号时渠道包不播报模型，因此 `channels` Provider 会是空模型列表，
  这是设计而非故障。
