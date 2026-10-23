---
name: channels
description: 用于 AiRoute 的「账号渠道」模块（server/channels/：LobsterAI / Qoder / Qoder 中国版 / TRAE / Cline / Loomy / Raccoon / MiniMax Code / ZCode / Gemini + WorkBuddy 国内/国际两区）——重生成渠道包产物、改协议帧与用量口径、新增渠道、排查「某渠道模型调不通 / 目录里没有 / 面板空」。当用户提到「渠道 / 渠道包 / channel-pack / 十个渠道 / 积分领取 / 换号 / 账号池 / 渠道面板」时使用。渠道实现本身是上游打包产物，认清改动落在哪一层再动手，改错层会白改。
---

# AiRoute 账号渠道

十个第三方渠道的登录、账号池、换号、积分、模型黑名单**不是本项目写的**：它们是
`dsh-our-free-model` 的渠道包产物 `business.mjs`（2.5 MB、61k 行，压缩后不可读）。
AiRoute 只提供宿主接口、协议转换、面板。来源与许可见 `server/channels/NOTICE.md`。

行号会漂移（本文档基线 v2.0.0-beta.2 / `cf46fa1`），**优先按符号名搜**：`grep -n "函数名" 文件`。

> **硬性标准：十个渠道必须与 `vendor/dsh-our-free-model` 提供的一致。**
> `npm run channels:verify`（= `node scripts/verify-channels.js`，已挂在 `npm test` 末尾）
> 逐字节比对产物、并核对面板 / 账号链接 / CLI / 源展示名计数与上游 product 表。
> 报红就是不一致：**重跑生成或补齐清单，不要改校验规则来让它变绿**。

## 0. 一页链路

```
请求 → server/router.js
  ├ /v1/{chat/completions,messages,responses}  → handleChannelRequest → rt.complete
  ├ /v1/messages/count_tokens                  → 同上（max_tokens:8 试探）
  ├ /api/channels/{status,models,refresh,test}  → 运行时状态 / 目录 / 连通性
  ├ /api/channels/rpc                          → channels.rpc → rt.rpc → 渠道包方法表
  └ /api/providers/:name/test                  → channelTestCompletion（试前 3 个模型）

server/channels/index.js（CJS 门面）
  └ runtime.js（主进程：Worker 生命周期 / 消息协议 / 目录缓存 / handles()）
      └ worker.mjs（worker 线程：造最小 cordis ctx → apply(ctx) → 转发 chunk）
          ├ business.mjs   渠道实现（生成产物）
          ├ contracts.mjs  @deepseek-ai/{cordis,dsh-llm,dsh-credentials} 的形状替身
          ├ credentials.mjs channel-credentials.json（0600 明文）
          └ images.mjs     ctx.attachments
      └ sse.js（主进程：chunk → OpenAI 帧 + 用量口径换算）
```

跑在 worker 线程的理由（`worker.mjs` 文件头）：渠道业务有大量模块级单例（账号池、
token 账本、串行队列、闸门），放主进程会让「重启渠道」与「重启服务」绑死，且任一
渠道的未捕获异常会打崩 HTTP 服务。

**模型引用有两套写法，别混**：

| 位置 | 值 |
| --- | --- |
| `models.json` 的 Provider id | `channels`（唯一一个源，`router.js` 的 `CHANNEL_PROVIDER_ID`） |
| `models.json` 里的模型 id | `<渠道>/<模型>`，如 `gemini/gemini-2.5-pro` |
| 完整引用（统计 / state.current / 日志） | `channels/gemini/gemini-2.5-pro` |
| `/v1/models` 播报的 id | `gemini/gemini-2.5-pro`（**不带** `channels/` 前缀，`owned_by` 恒为 `airoute`） |

## 1. 先判定改动落在哪一层

| 需求 / 症状 | 改这里 | 不能改这里 |
| --- | --- | --- |
| 登录流程、换号策略、限流退避、积分领取、模型清单 | 上游 `vendor/channel-pack/src/**.ts` → 重建 `pack.js` → **重跑 `scripts/build-channels.js`** | ❌ `business.mjs`（产物，下次生成会覆盖，且不可审） |
| 新增 / 删除一个渠道 | 上游源码 + 重生成 + 面板常量（见 §3） | — |
| chunk → OpenAI 帧、思考 / 工具调用 / 用量字段 | `server/channels/sse.js` | — |
| worker 缺宿主能力（`ctx.*` 少一个方法 / 抛「未实现」） | `server/channels/worker.mjs` 的 `ctx` | ❌ 用 Proxy 兜底（见 §7） |
| 超时、关停、目录刷新、Worker 崩溃 | `server/channels/runtime.js` | — |
| Provider 目录同步、路由分派、连通性测试 | `server/router.js`（`syncChannelProvider` / `handleChannelRequest` / `/api/channels/*`） | — |
| 面板（登录、账号池、积分、模型开关） | `app/renderer/src/views/Channels.vue` + `api.js` | — |
| WorkBuddy 两区的账号 / 模型 | `server/workbuddy/`（渠道里只有目录适配器，补全直通主进程） | ❌ 让 WorkBuddy 走渠道适配器 |

## 2. 改渠道行为：改上游 → 重建 pack → 重生成产物

上游源码就在本仓库的子模块 `vendor/dsh-our-free-model/`（只作参考与再生成源，
AiRoute 的构建不依赖它）。

```bash
# ① 改上游实现：vendor/channel-pack/src/**.ts
cd vendor/dsh-our-free-model
pnpm channel-pack        # = node scripts/build-channel-pack.mjs，重写 vendor/channel-pack/pack.js

# ② 回 AiRoute 重生成产物（这一步才是改到 AiRoute 的地方）
cd ../..
OFM_CHANNEL_PACK=vendor/dsh-our-free-model/vendor/channel-pack/pack.js \
  node scripts/build-channels.js
# 输出：[aiRoute] 已生成 server/channels/business.mjs（xx.xx MB）

# ③ 验证
npm run channels:verify   # 必须 7/7：产物与上游逐字节一致 + 渠道清单四处对齐
npm test                  # 含上者与 scripts/test-channels.js 的 11 项
```

**一致性闸门**：`scripts/channel-pack-transform.js` 是生成与校验共用的那条改写管线，
`scripts/verify-channels.js` 用它重跑一遍、与磁盘上的 `business.mjs` 逐字节比对，所以下面
两种情况都会被它抓住并给出不同的提示：

| 报错提示 | 含义 | 处置 |
| --- | --- | --- |
| 「上游换了产物，重跑 node scripts/build-channels.js」 | 产物头记录的 SHA ≠ 当前 `pack.js` 的 SHA | 重跑生成（上游变了，行为可能也变了，看 §2 上文） |
| 「产物被手改过，改渠道行为要回上游改源码」 | 两者 SHA 相同但内容不同 | 丢弃手改，回上游改源码 |

它同时核对渠道清单：面板 `PROVIDERS`、`channel-links.js` 的 `SLOTS`、CLI 的 `PROVIDERS`、
`CHANNEL_PROVIDER_NAME` 的「N 家」，以及面板展示名是否等于上游 `displayName`（有意改名要在
脚本的 `DISPLAY_NAME_EXCEPTIONS` 登记）。CI 的「测试与版本校验」job 已带
`submodules: true`，那里跑的是真校验；本地若没检出子模块，它会打印「跳过」并以 0 退出
——**跳过不等于通过**，改渠道前后各跑一次 `git submodule update --init` +
`npm run channels:verify`。

`scripts/build-channels.js` 对上游产物做 6 处改写（`NOTICE.md` 归纳为 5 类）：删
schemastery schema、`@deepseek-ai/*` 改指 `./contracts.mjs`、数据目录改由
`ctx.platform.channelHome` 注入、去掉宿主自带网关与 loop 续跑、WASM 改成与产物同目
录、补导出 worker 需要的协议转换函数。

**每处替换都要求唯一命中**：`替换位置不唯一或已改变` / `未匹配到 …` 报错 = 上游产物
形状变了，去读上游对应源码后更新规则，**不要**把替换改成宽松匹配——宽松匹配会静默
产出一个能加载、直到某个渠道登录时才炸的文件。产物头记录源 `pack.js` 的 SHA256，
引入新版本时一并更新 `NOTICE.md` 的版本说明。

## 3. 新增一个渠道（同步点清单，漏一个就是半成品）

渠道的**行为**全部来自上游产物；AiRoute 只需跟着改这几处：

1. 上游 `vendor/channel-pack/src/` 里的 provider 实现 → 重建 pack → 重生成 `business.mjs`；
2. `app/renderer/src/views/Channels.vue`：`PROVIDERS`（id + 展示名）、必要时
   `ONBOARDING_PROVIDERS`（只有 loomy / raccoon 有新手任务）与 `NO_CLAIM_PROVIDERS`
   （Gemini 没有签到端点，别给它一个必然失败的按钮）；
3. `app/renderer/src/utils/channel-links.js` 的 `SLOTS`（个人中心链接）；
4. `scripts/channels-login.js` 的 `PROVIDERS`（CLI 登录）；
5. `server/router.js` 的 `CHANNEL_PROVIDER_NAME`（「账号渠道（11 家）」的计数，含 WorkBuddy 两区）与
   `LEGACY_CHANNEL_NAMES`（旧展示名自动升级用）；
6. `server/channels/NOTICE.md`、`server/channels/index.js` 与 `worker.mjs` 文件头注释里的「十个」；
7. 凭据键是渠道包按 `` `${provider.toUpperCase()}_ACCOUNT_<suffix>` `` 生成的，不用手写。

删渠道时同样走这张表（上游删实现后目录里自然不再播报）。

改完跑 `npm run channels:verify`：它把上游 product 表与上面第 2~5 项逐个核对，漏登记的
渠道会在对应那一项报「缺：<id>」——这就是这张清单的可执行版本，别靠肉眼对。

## 4. 改协议帧 / 用量口径

`sse.js` 是**唯一**的映射点，三个端点共用（Anthropic / Responses 客户端在 HTTP 层就
转成 OpenAI Chat）：`createCollector`（非流式的聚合出口与流式共用同一状态机）、
`createStreamWriter`、`toOpenAiUsage`（DSH 口径 → OpenAI）、`toStatUsage`（OpenAI 口径
→ AiRoute 统计口径）。

三条不能破的口径：

- **`input` 恒为「未命中缓存」**：`toStatUsage` 必须减 `prompt_tokens_details.cached_tokens`，
  否则命中部分被算两遍；
- **`total_tokens` 取 `max(上游报的, prompt+completion)`**：上游口径不一致时宁多勿少，
  少算会让客户端误判上下文占用、永不触发自动压缩；
- **`aborted` / `error` 映射成 `finish_reason: 'error'`**，不要伪造成 `stop`——那会让客户端
  把一次失败当成正常收尾。

`block-end` 携带的是拼好的工具参数，增量帧已逐段发过，**不要**再映射一次（参数会拼两遍，
`test-channels.js` 有断言）。流已发 200 后上游失败，由 `router.js` 补错误帧 + `[DONE]`，
不换源。

## 5. 排查：某渠道模型调不通 / 面板空

按顺序查，别一上来读 `business.mjs`（端口默认 3000，改过就看 `server/server-config.json`
或 `$AIROUTE_PORT`）：

```bash
# ① 运行时是否就绪（ready / failed / unavailable；unavailable = 还没初始化完）
curl -s localhost:3000/api/channels/status | jq '{state,error,providers}'

# ② 哪家没有账号 / 多少模型被关
curl -s -XPOST localhost:3000/api/channels/rpc -H 'content-type: application/json' \
  -d '{"method":"provider.status","payload":{}}' | jq '.result.value'

# ③ 账号池（account.list 必须带 provider，渠道包没有「列全部」）
curl -s -XPOST localhost:3000/api/channels/rpc -H 'content-type: application/json' \
  -d '{"method":"account.list","payload":{"provider":"gemini"}}' | jq '.result.value'

# ④ 目录原始行（channel / vision 在这里，但不会写进 models.json）
curl -s localhost:3000/api/channels/models | jq '.models[0]'

# ⑤ 真发一次短对话（provider 过滤只试那一家的模型）
curl -s -XPOST localhost:3000/api/channels/test -H 'content-type: application/json' \
  -d '{"provider":"gemini"}' | jq '{ok,model,tried}'
```

判读要点：

- **`channels` 源里没有这个模型** → 目录同步问题：`syncChannelProvider` 只在目录非空
  时建源，且**只保留 `id/displayName/maxContext/maxOutput` 四个字段**
  （`channel`/`vision`/`reasoning` 被丢弃）；想加字段要同时改 `syncChannelProvider`、
  `models.sanitizeModels` 与面板，否则静默丢失。
- **404「渠道未提供模型」** → `rt.handles()` 按 `provider/` 前缀判定失败：models.json 里
  的 id 写成了 `channels/…`（多套了一层）或该渠道这一版没注册这个 provider。
- **404「模型不存在或已停用」** → 走到了 worker，但 `ctx.llm.listModels(provider)` 里没有
  它：渠道侧被禁用（单点 `model.setDisabled` / 面板走 `model.setDisabledMany`）或失效
  （`dead-models.json`，TTL 30 天，只能 `model.clearDead` 复活）。
- **503** → 运行时还没起来（启动不 `await` 渠道）或初始化失败，看日志
  `[aiRoute] 渠道初始化失败:`。
- **未登录任何账号时目录为空、`channels` 源是空列表或不存在，这是设计不是故障**
  （`index.js` 注释：没有账号时渠道包应当「不出现」而不是「报错」）。同理
  `smoke-e2e` 全程没有渠道断言，但它确实拉起了渠道 worker——绿灯同时说明「无账号启动不崩、不建空源」。

日志：渠道包自身输出统一加 `[channel-pack]` 前缀，宿主再套一层 `[channels]`；目录刷新
失败是 `[aiRoute] 渠道目录刷新失败:`。

数据落盘（`<AIROUTE_DATA_DIR>/channels-data/`，dev 模式 = 仓库内 `server/channels-data/`，
已 gitignore）：

```
channel-credentials.json          全部渠道凭据（0600 明文，键 <PROVIDER>_ACCOUNT_<suffix>）
channel-pack/state.json           账号池 / disabledModels / gatewayEnabled / providerOrder
channel-pack/dead-models.json     失效模型（30 天）
channel-pack/token-ledger.json    渠道侧 token 账本      auto-checkin.json 自动签到
```

**渠道的账号池、黑名单、积分只有这一份真相**：AiRoute 不缓存副本（`index.js` 文件头）。
需要账号信息一律走 RPC，别在 `models.json` 或主进程里再存一份。

CLI 登录（面板之外的另一条入口，走的是**正在运行的服务**，不要自己起运行时）：

```bash
node scripts/channels-login.js            # = --list，列已登录账号
node scripts/channels-login.js gemini     # 起登录 → 打印 loginUrl → 轮询 → 刷新目录
```

## 6. 验证

```bash
npm run channels:verify         # 7 项：产物逐字节一致 + 渠道清单四处对齐 + 展示名
node scripts/test-channels.js   # 11 项：目录 / 三端点转帧 / RPC 透传 / 连通性测试 / 404 / 断流
npm test                        # 全链路（含以上两者）
npm run test:e2e                # 冒烟的绿灯同时验证「无账号启动不崩、不建空源」
```

`test-channels.js` 的手法值得复用：**在 `require server/router.js` 之前替换渠道模块**
（`channels.getRuntime/init/rpc`），用假运行时回放固定 chunk 序列，因此离线、无需账号，
测的是「AiRoute 接上去的那一层」。改 `sse.js` / 路由分派 / 用量记账时先在这里加断言。

真实账号相关的改动（登录、换号、积分、限流）在这里测不出来，必须装账号手测：
`pnpm dev` → 渠道页 → 登录 → 看目录是否出现模型 → `/api/channels/test`。

## 7. 硬约束

- **与上游一致是硬性标准**：`npm run channels:verify` 报红时必须让产物与清单对齐
  （重跑生成 / 补齐登记），**不要**放宽校验规则、也不要删掉某一项检查来换取全绿。
  它跳过（没检出子模块）不等于通过。
- **不要手改 `server/channels/business.mjs`**：它是产物，下次生成即覆盖；判断行为一律
  以上游 `vendor/channel-pack/src/*.ts`（同一提交）为准。手改会被 `channels:verify` 的
  逐字节比对抓出来（提示「产物被手改过」）。
- **不要在 `router.js` 重抄渠道包的 RPC 方法表**：`/api/channels/rpc` 原样透传，方法表
  以渠道包为准；抄一份只会随上游版本漂移。
- **不要在 worker 里再建一套 WorkBuddy 账号池**：WorkBuddy 的账号、会话、模型目录都在
  主进程，`worker.mjs` 只经反向调用（`host` 消息）代理 `workbuddy.models`；它的补全由
  router 直通主进程，`prepareCall` 故意抛错——不要「顺手」让它走一遍适配器（两次有损转换，
  工具调用、思考帧、图片都会掉字段）。
- **不要用 Proxy 兜底 `ctx`**：缺的方法应当报错并在测试里显形，而不是在某条冷路径上
  返回 `undefined` 后静默失败。
- **不要把 `channels-data/` 提交或打进包**：`.gitignore` 与 `scripts/build.js` 的 `exclude`
  各有一份排除；`channel-credentials.json` 是明文凭据，导出配置等价于完整备份、不能外传。
- **不要把 `input` 改成含缓存口径**，也不要给 `usage` 补 0——缺字段表示「没有数据」，
  给 0 会被统计当成「真实用量为零」。
- **不要在启动路径上 `await` 渠道初始化**：`initChannels()` 是 fire-and-forget，渠道不可用
  不该让 AiRoute 起不来；要等就等 `rt.ready`（自带 30s 超时）。
- **面板上「测试」按钮的并发规则不要改**：渠道间并发、渠道内串行 + 间隔 + 抖动 + 限流熔断
  （`Channels.vue` 的 `runModelTests`），改成全并发会被上游当成刷接口。
- 打包后 `worker.mjs` 是用 `new Worker(path.join(__dirname,'worker.mjs'))` 从 `app.asar`
  内加载的；`scripts/verify-release.js` 不检查这条路径，改 worker 加载方式或 `files` /
  `asarUnpack` 配置后必须在打包产物里手测一次渠道页。

更细的接线点（端点表、RPC 方法表、字段来源、日志前缀、测试项清单、前端文件）见
[`reference.md`](reference.md)。
