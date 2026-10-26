# server/channels — 渠道的来源与实现

本目录让 AiRoute 具备 **Trae**、**Qoder**、**Qoder 国内版** 三个账号渠道的登录、
账号池、模型目录与推理。这三个渠道是**插件**（`plugins/` 下各一个包），
由宿主发现并加载；WorkBuddy 两区不走这里（见下文「与 WorkBuddy 的分工」）。

实现都在本仓库内，**没有打包产物**：

| 路径 | 来源 | 说明 |
| --- | --- | --- |
| `plugins/trae/index.js` | 本项目 | Trae 插件清单 + ABI 适配 + 旧账号认领 |
| `plugins/trae/protocol.js` | 本项目 | Trae 协议常量、凭据、请求头、OpenAI → SOLO 请求体、目录解析（纯函数，可离线单测） |
| `plugins/trae/provider.js` | 本项目 | Trae 的登录回调控件、续期、选号、补全、签到、积分 |
| `plugins/qoder/index.js` | 本项目 | Qoder 插件清单（一个包两个 provider）+ ABI 适配 |
| `plugins/qoder/protocol.js` | 本项目 | Qoder 产品配置、PKCE 设备码登录、续期、信封剥离 |
| `plugins/qoder/wasm.js` | 上游 WASM + 本项目桥 | `qoder-auth-wasm.wasm` 的 wasm-bindgen 桥：构造加密请求 |
| `plugins/qoder/qoder-auth-wasm.wasm` | Qoder 桌面端 | 加密推理所需的算法产物，必须与 `wasm.js` 同目录 |
| `plugins/qoder/provider.js` | 本项目 | Qoder 的设备码轮询登录、选号、加密补全 |
| `plugin-host.js` | 本项目 | 发现 / 加载插件、建 provider 索引、生命周期与失败隔离 |
| `plugin-store.js` | 本项目 | 插件清单（`channels-plugins.json`）：装了什么、开没开 |
| `plugin-api.js` | 本项目 | 宿主交给插件的 `ctx`（dataDir / logger / 凭据 / 登录回调）与 ABI 校验 |
| `owned/runtime.js` | 本项目 | 把插件聚合为面板认识的那一套接口（目录 / RPC / 补全），**不含任何 provider 名字** |
| `shared/accounts.js` | 本项目 | 凭据读写（`channel-credentials.json`）与账号标识 |
| `shared/login-server.js` | 本项目 | 登录回调用的临时本地监听（Trae 用） |
| `sse.js` | 本项目 | 内部 chunk → OpenAI Chat 的帧映射与用量口径换算 |
| `index.js` | 本项目 | CJS 门面：`init` / `getRuntime` / `refreshModels` / `rpc` / `reloadPlugins` / `shutdown` |

## 插件约定

- **清单在代码里**：`plugins/<id>/index.js` 导出 `{ id, name, providers, checkinProviders, create(ctx) }`。
  没有单独的 `plugin.json` —— 多一份 JSON 就多一种「清单与代码不同步」的状态。
- **能力靠方法存在与否判断**：没有 `balance` 就是「这家不提供余额」，宿主回「未开通」，
  而不是按 provider 名写死分支。
- **统一 ABI**：按 provider 分派的方法第一个参数是 provider（一个包可以带多家，
  Qoder 就是 `qoder` + `qodercn`）。插件入口负责适配到自家后端的签名。
- **凭据与登录回调由宿主注入**（`ctx.credentials` / `ctx.loginServer`）。插件里
  **不许** `require('../shared/...')` —— 那等于换了个目录的宿主代码，装进来的第三方包
  就能直接摸明文凭据。`scripts/verify-channels.js` 有一条断言盯着这件事。
- **内置插件不可删、只可停用**：删掉记录下次启动会补回来，用户会以为没生效；
  而删掉 `qoder` 的包会让已登录账号直接读不到目录。
- **装/卸/启停之后重建运行时**：provider 集合由清单算出来（`channels.reloadPlugins()`）。

## 协议来源

- **Trae**：Trae2api / Traework2api 的逆向分析；与 `dsh-our-free-model` 的
  `vendor/channel-pack/src/Trae*.ts` 逐条对齐（那份实现经过大量实测修正）。
- **Qoder**：Qoder 0.3.4 桌面端逆向；与 `dsh-our-free-model` 的
  `vendor/channel-pack/src/qoder*.ts` 对齐。加密推理调用的是 Qoder 自带的
  `qoder_auth_wasm` —— 按 wasm-bindgen 约定接起来直接调用，没有剥离任何混淆。
- 两家的授权许可见同目录 `LICENSE`。

## 与渠道包的关系（已移除）

之前的实现把十个渠道打成一个 2.6 MB 的 `business.mjs`，由 worker 线程跑一套
模拟的 cordis 宿主。那份产物**不可读也不可审**，判断「某家到底发了什么请求」
只能回上游源码。现在每个渠道就是一个普通模块，`scripts/verify-channels.js`
校验清单与实现是否自洽，测试直接调协议函数，不需要 mock 宿主。

旧数据不需要迁移操作：账号凭据仍在 `<AIROUTE_DATA_DIR>/channels-data/channel-credentials.json`，
键名与格式都没变（`TRAE_ACCOUNT_<8 位>` / `QODER_ACCOUNT_<8 位>` / `QODERCN_ACCOUNT_<8 位>`）。
启动时 `owned/runtime.js` 的 `importLegacyAccounts()` 会调各插件的 `importLegacy()`
按凭据文件补出账号清单，所以升级后账号与登录态原样都在，不需要重新登录。

> ⚠️ 账号 id 的后缀来自**凭据键名**，不是按 uid 重新 hash —— 两者可能不同
> （实测旧文件里 `TRAE_ACCOUNT_45AB04E0` 的 uid 是 `15814148757308`）。
> 重算会让迁移过来的账号读不到凭据，表现就是「登录态全丢」。

## 与 WorkBuddy 的分工

WorkBuddy 的账号池、会话、调度器、任务体系都在 `server/workbuddy/`（主进程），
它有 40+ 个专用接口 `/api/workbuddy/*`。本目录只为它注册**目录**，补全在
`router.js` 里直接交给 `forwardChat`：

> 若绕进渠道适配器再转回 OpenAI，等于两次有损转换（工具调用、思考帧、图片都会
> 掉字段），换来的只是「走了一遍适配器」。

## 注意

- Qoder 的推理端点有**排队**（业务码 `10605`）：服务端会给出
  `retryAfterSeconds`，本实现按它等待后重发。按普通错误快退避重试是等不到的。
- Qoder 的加密端点只认**目录 key**（`qfmodel` / `dmodel`），公开端点只认通用名，
  两者不能互换；两个端点的 host 也不同。
- 未登录任何账号时渠道不播报模型，因此 `channels` Provider 在全新环境下是空列表，
  这是设计而不是故障。
- Trae 的 `machine_id` / `device_id` 必须持久化：前者是设备身份（每次换可能触发
  风控），后者是签到设备号（同一天两个账号共用会被判「该设备已签到」）。
