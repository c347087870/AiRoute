---
name: channels
description: 用于 AiRoute 的「账号渠道」模块（server/channels/：TRAE / Qoder / Qoder 国内版以插件形式装进来，加 WorkBuddy 国内/国际两区）——改协议、加渠道、装/卸插件、排查「某渠道模型调不通 / 面板空 / 登录失败」。当用户提到「渠道 / 渠道插件 / 积分领取 / 换号 / 账号池 / 渠道面板」时使用。渠道是装进来的插件包（不再是打包产物），改行为直接改插件源码。
---

# AiRoute 账号渠道

五个 provider，两条来路：

| provider | 实现 | 说明 |
| --- | --- | --- |
| `trae` | `server/channels/plugins/trae/` | 插件（`trae` 一个包），SOLO 协议 + 自定义 SSE |
| `qoder` | `server/channels/plugins/qoder/` | 插件（`qoder` 包里两个 provider），WASM 加密推理 |
| `qodercn` | `server/channels/plugins/qoder/` | 同上，产品配置不同（`protocol.PRODUCTS`） |
| `workbuddy` | `server/workbuddy/` | 主进程直通，`server/channels` 只注册目录 |
| `workbuddy-global` | `server/workbuddy/` | 同上（国际版） |

行号会漂移，**优先按符号名搜**：`grep -n "函数名" 文件`。

> **一致性闸门**：`npm run channels:verify`（= `node scripts/verify-channels.js`，
> 已挂在 `npm test` 末尾）校验「插件入口与实现文件齐全 + 插件清单 / 面板 / CLI 三处对齐 +
> 插件不绕过宿主直连存储」。
> 报红就是清单与实现脱节：补实现或补登记，**不要**放宽校验规则来让它变绿。
>
> **插件宿主回归**：`node scripts/test-channel-plugins.js`（也挂在 `npm test`）覆盖
> 装/卸/启停、加载失败隔离、统一 ABI、内置插件不可删。

## 0. 一页链路

```
请求 → server/router.js
  ├ /v1/{chat/completions,messages,responses}  → handleChannelRequest → rt.complete
  ├ /v1/messages/count_tokens                  → 同上（max_tokens:8 试探）
  ├ /api/channels/{status,models,refresh,test}  → 运行时状态 / 目录 / 连通性
  ├ /api/channels/plugins                      → 插件列表 / 装 / 卸 / 启停（会重建运行时）
  └ /api/channels/rpc                          → channels.rpc → owned/runtime.js 的 rpc()

server/channels/index.js（CJS 门面）
  └ createRuntimeFacade(owned)  ← WorkBuddy 目录 + 插件目录合并
      └ owned/runtime.js                 ← 只做聚合：provider 清单由插件算出来
          └ plugin-host.js               ← 发现 / 加载 / provider 索引 / 生命周期
              ├ plugin-store.js          ← channels-plugins.json（装了什么、开没开）
              ├ plugin-api.js            ← 宿主交给插件的 ctx（dataDir/logger/credentials/loginServer）
              └ plugins/
                  ├ trae/index.js   ──► provider.js ──► protocol.js
                  └ qoder/index.js  ──► provider.js ──► protocol.js + wasm.js + qoder-auth-wasm.wasm
      └ sse.js（内部 chunk → OpenAI 帧 + 用量口径换算）
```

**插件包里没有 `require('../shared/...')`**：凭据与登录回调都由宿主注入
（`ctx.credentials` / `ctx.loginServer`）。`channels:verify` 有一条专门的断言盯着这件事 ——
插件直连宿主存储等于「换了个目录的宿主代码」，装进来的第三方包就能直接摸凭据文件。

**统一 ABI**：所有按 provider 分派的方法，第一个参数是 provider（一个包可能带多家）。
插件入口 `index.js` 负责把它适配到自家后端的签名（TRAE 的后端本来没有 provider 参数）。

**模型引用有两套写法，别混**：

| 位置 | 值 |
| --- | --- |
| `models.json` 的 Provider id | `channels`（唯一一个源，`router.js` 的 `CHANNEL_PROVIDER_ID`） |
| `models.json` 里的模型 id | `<渠道>/<模型>`，如 `trae/glm-5.2` |
| 完整引用（统计 / state.current / 日志） | `channels/trae/glm-5.2` |
| `/v1/models` 播报的 id | `trae/glm-5.2`（**不带** `channels/` 前缀，`owned_by` 恒为 `airoute`） |

## 1. 先判定改动落在哪一层

| 需求 / 症状 | 改这里 | 不能改这里 |
| --- | --- | --- |
| 登录流程、刷新、请求头、请求体转换、目录解析 | `plugins/<id>/protocol.js`（纯函数） | — |
| 选号、续期时机、失败重试、签到、额度 | `plugins/<id>/provider.js` | — |
| Qoder 加密请求体 / 签名头 | `plugins/qoder/wasm.js` + `qoder-auth-wasm.wasm` | 不要改 WASM 产物 |
| 「这家有哪些方法、要不要申报签到」 | `plugins/<id>/index.js`（清单 + ABI 适配） | — |
| 插件怎么被发现 / 装 / 卸 / 启停 | `plugin-host.js` / `plugin-store.js` | 不要在各插件里各写一份清单逻辑 |
| 宿主交给插件的东西（凭据、登录回调） | `plugin-api.js` | ❌ 让插件 `require('../shared/...')` |
| 面板会调的 RPC 方法 | `owned/runtime.js` 的 `rpc()` | 不要在 `router.js` 里另抄一份方法表 |
| chunk → OpenAI 帧、思考 / 工具调用 / 用量字段 | `sse.js` | — |
| WorkBuddy 两区的账号 / 模型 | `server/workbuddy/` | ❌ 让 WorkBuddy 走 owned 运行时（也不是插件） |

## 2. 改协议

直接改源码，没有生成步骤：

```bash
# 改完跑
node scripts/verify-channels.js      # 清单自洽
node scripts/test-channels.js        # 转帧 / 路由（离线，用假运行时）
npm test                             # 全链路
```

协议细节的权威来源是 `vendor/dsh-our-free-model/vendor/channel-pack/src/` 下的
`trae*.ts` / `qoder*.ts`（可读的 TypeScript，注释里每条 ⚠️ 都是实测踩过的坑）。
移植到 `protocol.js` 时**不要简化掉**那些判据，它们各自对应一类真实故障。

## 3. 新增一个渠道（同步点清单，漏一个就是半成品）

渠道是**插件**，所以第一步不再是往 `OWNED_PROVIDERS` 里加名字：

1. 新建 `server/channels/plugins/<name>/{index.js, protocol.js, provider.js}`（照抄 `trae/` 的结构）。
   `index.js` 是清单 + ABI 适配：`id` / `name` / `providers` / `checkinProviders` / `create(ctx)`，
   所有按 provider 分派的方法第一个参数是 provider；
2. `plugin-store.js` 的 `BUILTIN_PLUGINS` 加一项（内置插件默认启用）。
   **不登记就是没装**：宿主按清单加载，不按目录扫描 —— 目录里多放一个包不会自动生效；
3. `app/renderer/src/views/Channels.vue` 的 `PROVIDERS`（id + 展示名），必要时
   `CLAIM_PROVIDERS`（有签到端点才加）；
4. `app/renderer/src/utils/channel-links.js` 的 `SLOTS`（个人中心链接）；
5. `scripts/channels-login.js` 的 `PROVIDERS`；
6. `scripts/verify-channels.js` 的 `BUILTIN_PROVIDERS`（校验的可执行版本就是这张表）。

`server/router.js` **不用改**：源展示名（「账号渠道（N 家）」）由
`channelProviderName()` 按运行时 providers 算出来，加一家自动跟着变。

改完跑 `npm run channels:verify`：漏登记的渠道会在对应那一项报「缺：<id>」。

### 装一个外部插件（不改进仓库）

插件包只要导出 `{ id, name, providers, create(ctx) }`，放在本机任意目录：

```bash
node scripts/channels-plugin.js add mychannel /path/to/plugin   # 装（立刻重建运行时）
node scripts/channels-plugin.js list                           # 装了什么、哪家没起来
node scripts/channels-plugin.js disable mychannel              # 停用（provider 立刻消失）
node scripts/channels-plugin.js remove mychannel               # 卸载（内置插件不允许，只能停用）
```

对应 HTTP：`GET /api/channels/plugins`、`POST /api/channels/plugins`（`{action,id,source}`）。
**刻意不做在线从 npm 拉包**：装一个插件等于让它读本机账号凭据，来源必须是用户显式给的本地路径。

排查装没装上，看 `provider.status` 返回的 `failures`：那是**声明了但没起来**的插件，
与「根本没装」是两个不同的状态（底层是 `plugin-host.js` 的 `ownerOf(provider)`）。

## 4. 改协议帧 / 用量口径

`sse.js` 是**唯一**的映射点，三个端点共用。三条不能破的口径：

- **`input` 恒为「未命中缓存」**：`toStatUsage` 必须减 `prompt_tokens_details.cached_tokens`；
- **`total_tokens` 取 `max(上游报的, prompt+completion)`**：宁多勿少，否则客户端永远不会自动压缩；
- **`aborted` / `error` 映射成 `finish_reason: 'error'`**，不要伪造成 `stop`。

各 provider 吐出的 chunk 类型（`text-delta` / `reasoning-delta` / `tool-call-delta` /
`usage` / `finish`）由各自的 `consume*` 函数负责，`sse.js` 不认识上游方言。

## 5. 排查

```bash
curl -s localhost:3000/api/channels/status | jq '{state,error}'

# 哪家没有账号 / 多少模型
curl -s -XPOST localhost:3000/api/channels/rpc -H 'content-type: application/json' \
  -d '{"method":"account.list","payload":{"provider":"trae"}}' | jq '.result.value'

# 真发一次短对话
curl -s -XPOST localhost:3000/api/channels/test -H 'content-type: application/json' \
  -d '{"provider":"trae"}' | jq '{ok,model,tried}'
```

判读要点：

- **`channels` 源里没有这个模型** → 目录同步问题；**未登录任何账号时目录为空是设计**。
- **404「渠道未提供模型」** → `rt.handles()` 按 `provider/` 前缀判定失败。
- **503** → 运行时还没起来，看日志 `[aiRoute] 渠道初始化失败:`。
- **TRAE 一直「认证中」** → 登录 URL 少参数（必须是 17 个，回调参数名是 `auth_callback_url`）。
- **Qoder 报排队（10605）** → 正常，服务端限流；本实现按 `retryAfterSeconds` 等待重发。
- **Qoder 403 Signature invalid** → `prepared.headers` 被覆盖了（必须原样透传 WASM 签的头）。
- **Qoder 提示「没有可领取的活动」** → 先看是不是机器身份头的问题：活动平台要求只发
  `UA: Qoder` + `cosy-clienttype: 10` + `cosy-version`，**任何 `cosy-machine*` 派生头都会让
  CLAIMABLE 活动被整条静默过滤**（HTTP 200 + 只剩 VIEW_DETAILS）。六个头一个都别发。
- **首字很慢（40~70 秒）但最后成功** → 别急着调小首帧上限：默认 120 秒就是为思考型模型留的，
  客户端先超时的问题由 `earlyHeadersMs`（先发 200 + `: ping`）解决，见「渠道设置」。
- **TRAE 工具调用变成两条** → 没按 `index` 合并增量帧（已修，见 `provider.js` 的 `consumeSolo`）。

数据落盘（`<AIROUTE_DATA_DIR>/channels-data/`，dev 模式 = 仓库内 `server/channels-data/`）：

```
channel-credentials.json      凭据（0600 明文，键 <PROVIDER>_ACCOUNT_<8 位大写 hex>）
trae-accounts.json            账号清单（展示顺序 / 停用标记 / 昵称）
qoder-accounts.json           同上（qodercn 是 qodercn-accounts.json）
qoder-machine.json            Qoder 设备标识的安装盐（machine_id 由 (盐, uid) 派生，换机即换设备）
qoder-max-output.json         从 400 学到的各模型输出上限（7 天有效）
channel-settings.json         渠道运行参数（面板「渠道设置」内页读写）
owned-channels-state.json     模型开关与失效台账
```

**渠道设置**（`server/channels/settings.js`，面板「渠道设置」内页，`GET/PUT /api/channels/settings`）：
首帧上限、先发响应头、空闲心跳、限流冷却、单号并发、同号间隔、会话亲和、账号轮转。
默认值刻意等于改造前的行为 —— 排查时先看这个文件，别先怀疑代码。

CLI 登录（走**正在运行的服务**，不要自己起运行时）：

```bash
node scripts/channels-login.js            # 列已登录账号
node scripts/channels-login.js trae       # 起登录 → 打印 loginUrl → 轮询 → 刷新目录
```

## 6. 验证

```bash
npm run channels:verify              # 8 项：插件实现齐全 + 清单对齐 + WASM + 产物已移除 + 不直连存储
node scripts/test-channel-plugins.js # 8 项：装/卸/启停、失败隔离、统一 ABI、内置不可删
node scripts/test-channels.js        # 11 项：目录 / 三端点转帧 / RPC 透传 / 404 / 断流
npm test
npm run test:e2e
```

`test-channels.js` 在 `require server/router.js` 之前替换渠道模块（`channels.getRuntime`），
用假运行时回放固定 chunk，因此离线可跑。真实账号相关的改动用 `pnpm dev` 手测。

## 7. 硬约束

- **不要把渠道实现重新打包成产物**：上一版是 2.6 MB 的 `business.mjs`，不可读也不可审，
  判断行为只能回上游源码。现在的实现就是源码。

- **不要让插件绕过宿主注入的 `ctx`**：插件 `require('../shared/accounts')` 等于换了个目录的
  宿主代码 —— 装进来的第三方包就能直接摸凭据文件。`channels:verify` 有断言盯着。

- **不要在插件里写死 provider 清单**：清单在 `index.js` 的 `providers`，
  `plugin-host.js` 据此建索引；`owned/runtime.js` 全文没有 provider 名字。

- **不要在 `router.js` 重抄 RPC 方法表**：`/api/channels/rpc` 原样透传。
- **不要让 WorkBuddy 走 owned 运行时**：两次有损转换会掉工具调用、思考帧、图片。
- **不要重算账号 id 的 hash 后缀**：后缀来自凭据键名（旧文件与重算结果不同），
  重算会让迁移过来的账号读不到凭据。
- **不要用 Proxy 兜底**：缺什么补什么，让缺口在测试里显形。
- **不要把 `channels-data/` 提交或打进包**：`.gitignore` 与 `scripts/build.js` 的 `exclude`
  各有一份排除；`channel-credentials.json` 是明文凭据。
- **不要让 Qoder 的排队当普通错误快退避重试**：服务端要求等 30 秒左右，快退避永远等不到。
- **不要覆盖 WASM 签好的请求头**：`Authorization` 是 `Bearer COSY.<载荷>.<签名>`。
- **不要在启动路径上 `await` 渠道初始化**：`initChannels()` 是 fire-and-forget。
- 打包后 `server/` 整目录复制，`qoder-auth-wasm.wasm` 必须与 `wasm.js` 同目录
  （`wasm.js` 按 `__dirname` 定位它）；改 `files` / `asarUnpack` 后要在打包产物里手测渠道页。

- **装/卸/启停插件后必须重建运行时**：provider 集合由清单算出来，不重建的话
  界面显示新清单、请求还按旧的走（`channels.reloadPlugins()`）。
