# 渠道接线点明细（reference）

`SKILL.md` 的附录。行号基线 v2.0.0-beta.2 / `cf46fa1`，**按符号名搜**而不是照抄行号。

## 1. HTTP 端点

| 端点 | 位置 | 作用 |
| --- | --- | --- |
| `GET /api/channels/status` | `router.js` `app.get('/api/channels/status')` | `{state,error,providers,models}`；先 `await rt.ready`（面板首个请求常早于 worker 就绪） |
| `GET /api/channels/models` | 同上 `models` | `rt.refresh()` 的原始行；**渲染层没有消费者**，调试用 |
| `POST /api/channels/refresh` | 同上 `refresh` | 重采集目录 + 写 `models.json`，回模型数 |
| `POST /api/channels/rpc` | 同上 `rpc` | 正文 `{method,payload}`，原样透传；命中 `/^(?:account\|login\|provider\|model\|credits)\./` 时触发目录同步 |
| `POST /api/channels/test` | 同上 `test` | 正文 `{provider?,model?}`；无 model 时依次试前 3 个候选，失败候选进 `tried` |
| `POST /api/providers/:name/test` | `router.js` `app.post('/api/providers/:name/test')` | 通用源测试入口，渠道源走 `channelTestCompletion`（前 3 个模型） |
| `POST /v1/chat/completions` `/v1/messages` `/v1/responses` | `router.js` 的入口集合 | `models.isChannelProvider(provider)` 分支 → `handleChannelRequest`（WorkBuddy 两区先被 `channelWorkbuddyRealm` 摘走） |
| `POST /v1/messages/count_tokens` | `router.js` 同路径分支 | 渠道按「发一次 `max_tokens: 8` 的非流请求」估算 |

`/api/channel-pack` **不是** AiRoute 的 HTTP 端点：它只存在于 worker 内部
（`worker.mjs` 里用 `new Request('http://localhost/api/channel-pack')` 伪造一次请求，交给渠道
包自己注册的 `connection.fetch` 路由）。上游的 `/api/channel-pack/captcha-carrier` 在当前
宿主里**无人代理**，`captcha.*` 三个方法前端也从未调用。

## 2. RPC 方法表（渠道包契约）

权威来源是产物里的 `handleMethod` switch，用这条命令枚举（换上游版本后重跑，别抄文档）：

```bash
grep -o 'case "[a-zA-Z]*\.[a-zA-Z]*"' server/channels/business.mjs | sed 's/case //' | sort -u
```

面板已用（`Channels.vue` 的 `channelsRpc(...)` 调用点）：

| method | 用途 |
| --- | --- |
| `provider.status` | 每家 `{models:{total,disabled}, accounts:{total,enabled}, closed}`，一次拿全 |
| `account.list` | 账号池；**必须带 `provider`**，包里没有「列全部」 |
| `model.list` | 目录 + `disabled` / `dead` 标记 |
| `account.create` / `login.poll` | 发起登录（回 `accountId` + `loginUrl`）与轮询 |
| `account.update` / `account.delete` / `account.test` | 启停 / 删号 / 单账号连通性 |
| `provider.setEnabled` | 渠道级开关（关 = 关全部模型 + 停全部账号） |
| `onboarding.status` / `onboarding.claim` | 新手任务，只有 `loomy` / `raccoon` |
| `credits.claimAll` / `credits.balances` | 逐账号领积分 / 余额（`gemini` 无签到端点） |
| `model.setDisabledMany` / `model.clearDead` | 批量黑名单 / 复活失效模型 |

包里还有、AiRoute 面板未接的：`account.{refresh,reorder,reset,resetAll,retest,retestAll}`、
`provider.{getOrder,setOrder}`、`model.{setDisabled,setAllDisabled}`、`credits.status`、
`gateway.{getEnabled,setEnabled}`、`usage.{badge,tokenLedger,tokenLedgerHistory,badgePreference,autoCheckin}`、
`backup.{export,import,status}`、`cline.{quota,requestLog}`、`login.{sendSms,submitSms}`、
`captcha.{demand,carrierUrl,contribute}`、`opencode.*`（被 `apply(ctx,{disableOpencode:true})` 关掉）。

两层信封，前端与 CLI 都要剥两次：

```js
// ① worker → 渠道包：{ type:'client-request', rpcId:'airoute', method:'channel-pack', payload:{ method, payload } }
//    回包 reply.result = { ok:true, value } | { ok:false, error:{code,message} }
// ② router → 客户端：{ ok:true, result } ；失败是 HTTP 4xx/5xx + { ok:false, error }
```

`api.js` 的 `channelsRpc` 与 `scripts/channels-login.js` 的 `rpc()` 是两份参考实现。

## 3. 目录行：字段从哪来、在哪丢

```
渠道包 provider.listModels → collectGatewayModels / collectGatewayEffortViews / toOpenAiModels
  → worker.mjs 的 models()：补 channel(=owned_by) / vision / context_window / max_tokens
  → router.js 的 syncChannelProvider(rows)：只留 id / displayName / maxContext / maxOutput
  → models.sanitizeModels：白名单 id/displayName/maxContext/maxOutput/reasoningEffort
  → models.json 的 channels.models
```

含义与影响：

- `vision` / `channel` / `reasoning` **只活在 `/api/channels/models` 的原始行里**，不进配置；
  想让面板之外的层也用上能力信息，必须同时改上面两处白名单，否则静默丢失。
- `syncChannelProvider` 保留用户手改的 `displayName` 与 `reasoningEffort`，上下文/输出上限
  以目录为准；旧默认展示名（`账号渠道`、`账号渠道（10 家）`）会被升级成
  `CHANNEL_PROVIDER_NAME`，用户改过的保留。
- 目录为空且此前没有这个源 → 直接 return（不建空源）；用户把该源改成非 `channel` 类型 →
  不覆盖（视为显式选择）。
- 触发同步的四处：初始化完成、`changed` 事件去抖 400ms、`POST /api/channels/refresh`、
  RPC 的账号类方法、以及 WorkBuddy 启用清单变更。

## 4. 生命周期与超时

- `initChannels()` 在 `router.js` 模块加载时 fire-and-forget 调用，`listen()` **不等**它 →
  早期请求拿 503（`state: 'unavailable'`）；`channels.init` 幂等（就绪返 `runtime.ready`，
  在飞则复用同一个 promise）。
- 初始化失败会清掉句柄（`runtime = null`），让后续请求拿到 503 而不是 404。
- `runtime.ready` 自带 30s 超时；目录刷新放在后台（某渠道登录态异常不拖住服务启动）。
- 请求超时：`models` 60s、`rpc` 10min、`complete` 30min（`runtime.js` 顶部常量）。
- 关停：`runtime.close()` 可重入（`postMessage({type:'close'})` + 1.5s 兜底 + `worker.terminate()`）。
  `channels.shutdown()` **只在配置导入的 `reloadRuntimes()` 里调用**；`/api/restart` 只重开监听端口，
  不重建 worker；没有进程退出钩子（进程退出时 worker 随之带走）。要做「热重启渠道」，现成入口只有
  `reloadRuntimes()`。
- `index.js` 的 `refreshModels` 与 `resolveDataDir` 是**死导出**（无调用者）：刷新一律走
  `rt.refresh()`。找不到调用者不是漏读代码。

## 5. 数据与凭据

| 路径 | 内容 |
| --- | --- |
| `<dataDir>/channel-credentials.json` | 全部渠道凭据，0600 明文，原子写（临时文件 `wx` + rename）；键校验 `/^[A-Za-z0-9_.-]{1,200}$/` |
| `<dataDir>/channel-pack/state.json` | 账号池、`disabledModels`、`gatewayEnabled`、`providerOrder`、loomy 永久锁 |
| `<dataDir>/channel-pack/dead-models.json` | 失效模型（TTL 30 天，只能 `model.clearDead` 复活） |
| `<dataDir>/channel-pack/token-ledger.json` | 渠道侧 token 账本（按天） |
| `<dataDir>/channel-pack/auto-checkin.json` | 自动签到状态 |
| `<dataDir>/channel-pack/{permanent-locks,ui-preferences,gemini-sigs}.json` | 按需创建 |

`<dataDir>` = `<AIROUTE_DATA_DIR>/channels-data`（`paths.getDataDir()`）：

| 模式 | 实际路径 |
| --- | --- |
| 生产（Electron） | `<userData>/data/channels-data/`（主进程注入 `AIROUTE_DATA_DIR`） |
| `pnpm dev` / `dev:web` | 仓库内 `server/channels-data/`（已 gitignore） |
| `dev:isolated` | 同上（`--user-data-dir` 不影响服务端数据目录） |
| 测试脚本 | `<tmp>/airoute-channels-test/channels-data/` |

打包：`scripts/build.js` 整目录复制 `server/` → `app/server/`，`exclude` 列表里有
`channels-data`（凭据不进包），`server/channels/`（含 `business.mjs` 与
`qoder-auth-wasm.wasm`）会进包；WASM 必须与产物同目录，因为产物按 `import.meta.url` 定位它。
导出配置（`config-io.js` 的 `ACCOUNT_DIRS`）会把 `channels-data/` 整棵带走——导出文件等价于
完整备份，不能外传。

## 6. 日志前缀

| 前缀 | 出处 |
| --- | --- |
| `[channel-pack] …` | 渠道包自身（产物内），经 worker → runtime 打到宿主 logger |
| `[channels] …` | `initChannels()` 给渠道包输出的统一前缀 |
| `[aiRoute] 渠道初始化失败:` | `index.js` + `router.js` 两处 |
| `[aiRoute] 渠道目录刷新失败:` / `渠道模型目录同步失败:` | 手动刷新 / 去抖同步 / `syncChannelProvider` 内部 |
| `[aiRoute] 渠道关停失败:` | `reloadRuntimes()` |
| `宿主未实现渠道操作：` / `宿主操作超时：` / `渠道进程已退出（code）` / `渠道初始化超时` | `runtime.js` / `worker.mjs` 的宿主侧错误 |
| `<provider> 模型目录读取失败：` | `worker.mjs` 的 `models()`（逐 provider 兜错，未登录不建议报错） |

## 7. 渲染层文件

| 文件 | 作用 |
| --- | --- |
| `app/renderer/src/views/Channels.vue` | 全部渠道 UI（账号 / 模型两个 Tab）；`PROVIDERS`、`ONBOARDING_PROVIDERS`、`NO_CLAIM_PROVIDERS`、`WB_*`、`MODEL_GROUP_PROVIDERS`、`FLASH_FAMILIES` 都在这里 |
| `app/renderer/src/api.js` | `channelsStatus` / `channelsRefresh` / `channelsRpc` / `channelsTest`（剥两层信封、把 400 当结果返回） |
| `app/renderer/src/utils/channel-links.js` | 11 个渠道的个人中心/用量页链接 + localStorage 覆盖（`SLOTS`） |
| `app/renderer/src/components/ChannelLinkEditor.vue` | 上述链接的编辑弹层 |
| `app/renderer/src/views/Providers.vue` | `type === 'channel'` 只读展示：只允许改显示名与推理档位 |
| `app/renderer/src/utils/models.js` | 渠道模型的展示名带渠道前缀（`provider · name`） |

面板的模型测试调度（别改成全并发）：渠道之间并发、渠道内串行 + `TEST_GAP_MS` 间隔 +
`TEST_JITTER_MS` 抖动 + 限流熔断（`TEST_MAX_THROTTLE_STREAK` 次后整体退避
`TEST_BACKOFF_MS`）。卡顺序与测试结论只存 localStorage（`airoute.channels-card-order`、
`airoute.channels-model-tests`），不进 `state.json`。

WorkBuddy 在渠道页里与十家并列，但账号/积分/启用清单走 `/api/workbuddy/*`：渠道里那两个
provider 只提供目录，`model.list` 对它们会回 `provider-unsupported`。

## 8. `scripts/test-channels.js` 覆盖的 11 项

1. 渠道运行时状态可读（`/api/channels/status` → `ready` + providers）
2. 渠道模型出现在 `/v1/models`（**`gemini/…` 不带 `channels/` 前缀**）
3. 非流式：正文、思考、工具调用、用量都转对（`prompt=未命中10+缓存2=12`、`total=max(上游15, 17)=17`）
4. 流式：逐帧增量 + 收尾 `[DONE]`（增量 arguments 拼起来 == 整份参数）
5. Anthropic 客户端：请求转成 OpenAI、回程转回 message（`stop_reason: tool_use`）
6. 渠道 RPC 透传（方法表不在本层重抄）
7. Provider 连通性测试走渠道包
8. 连通性测试：首个模型调不通时自动换下一个（`tried` 记录失败候选）
9. 按渠道测试：只在指定渠道的模型里挑候选（`tried` 为空 = 没试别家）
10. 运行时没有的模型：透出 404（`渠道未提供模型`）而不是 500
11. 流式断流：补错误帧 + `[DONE]`，不换源也不崩

写法可复用：`require server/router.js` **之前**把 `server/channels` 的 `getRuntime/init/rpc`
换成假运行时，之后照常打 HTTP。所以它离线、无需账号，验证的是 AiRoute 这一层；
登录、换号、积分、限流这些上游行为它测不到，只能装账号手测。

`scripts/smoke-e2e.js` 没有渠道断言，但它 spawn 的服务会拉起渠道 worker——绿灯同时说明
「无账号启动不崩、不建空 `channels` 源」。

## 9. 常见误判

- `/v1/models` 里的 `gemini/x` ≠ 配置里的引用 `channels/gemini/x`；请求按「当前模型」路由，
  请求体里的 `model` 不参与选源（`test-channels.js` 第 10 项就是靠改 `state.current` 触发的）。
- 「目录里有、但配置里没有」是两类问题：没跑同步（`/api/channels/refresh`）vs 该模型被面板
  开关或 `dead-models.json` 挡住（后者在 `/api/channels/models` 原始行里才有 `dead` 标记）。
- `/api/channels/models` 没有前端消费者；面板看模型走 `model.list`（带 `disabled`/`dead`）。
- 渠道请求**不计 credits**：`credits` 字段只属于 WorkBuddy 的用量记录；渠道积分来自
  `credits.balances`。
- `worker.mjs` 里 `ctx` 是手写的、只实现渠道包真正调用到的部分（`platform` / `credentials` /
  `logger` / `attachments` / `connection.fetch` / `get` / `provide` / `effect` / `inject` /
  `emit` / `llm`）。渠道包新增了对 `ctx.*` 的调用时，缺口会在冷路径上炸——不要用 Proxy 兜底，
  在 `ctx` 里补显式实现并加断言。

## 10. 一致性校验的实现（`scripts/verify-channels.js`）

「每个渠道与上游一致」的可执行定义，7 项检查：

| 检查 | 判据 |
| --- | --- |
| 上游渠道清单可解析 | 从 `pack.js` 的 product 字面量提取到 ≥ `MIN_PRODUCTS`(10) 家且都有 `displayName`，否则说明产物形状变了、提取规则要更新（宁可报红也不要假通过） |
| 产物 = 改写(上游 pack.js) | `transform(pack.js)` 与 `server/channels/business.mjs` 逐字节相等 |
| 渠道清单：面板 `PROVIDERS` | 集合相等（缺 / 多都报） |
| 渠道清单：`channel-links.js` 的 `SLOTS` | 上游的每家都要有槽位（允许额外有 `workbuddy`） |
| 渠道清单：`channels-login.js` 的 `PROVIDERS` | 集合相等 |
| 渠道数量：`CHANNEL_PROVIDER_NAME` | 「N 家」== 上游渠道数 + 1（WorkBuddy 两区算一家） |
| 面板展示名 | `Channels.vue` 的 `name` == 上游 `displayName`（例外登记在 `DISPLAY_NAME_EXCEPTIONS`） |

提取规则（上游形状变了先看这里）：

- product = 顶层 `var NAME = {` … `};` 块，块内取 `  id: "x",` 与 `  displayName: "…",`
  各占一行的写法，允许中间夹注释——`qodercn` / `raccoon` / `zcode` 都有注释。
- `displayName` 里是 JSON 转义（`\u6709\u9053`），按 JSON 解码后再比。
- `opencode` 在 `DISABLED_PRODUCTS` 里：它对应 `worker.mjs` 的
  `apply(ctx, { disableOpencode: true })`，不属于 AiRoute 的渠道清单。上游新增「默认不启用」
  的 product 时，照此登记并说明原因。

三种报红的处置：

| 提示 | 处置 |
| --- | --- |
| 「上游换了产物，重跑 node scripts/build-channels.js」 | 产物头 SHA ≠ 当前 `pack.js` SHA → 重跑生成，再跑 `npm test` |
| 「产物被手改过」 | SHA 相同但内容不同 → 丢弃手改，回上游改源码 |
| 「面板缺 / 缺：<id>」「N 家 应为 M 家」 | 按 SKILL.md §3 的同步点补齐，**不要**改校验规则 |

跳过语义：`vendor/dsh-our-free-model/vendor/channel-pack/pack.js` 不存在时打印「跳过」并
`exit 0`（没带子模块的本地机器不该因此跑不了测试）。CI 的「测试与版本校验」job 已在
`actions/checkout` 上加了 `submodules: true`，那里是真校验；构建 job 没加也不需要——
它不跑本脚本。

两个脚本的分工：`scripts/channel-pack-transform.js` 是唯一的改写实现（`transform()` 返回
含两行头的完整文件内容），`scripts/build-channels.js` 只负责读文件 / 写文件 / 打印，
`scripts/verify-channels.js` 只负责比对。改改写规则只动 transform 这一个文件。
