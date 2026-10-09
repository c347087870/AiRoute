# AiRoute

> 本地 LLM 多模型调度网关 — 好钢用在刀刃上，贵的模型做难事，便宜的做杂事。

[![Platform](https://img.shields.io/badge/platform-Windows-blue)](https://github.com/c347087870/AiRoute)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-10.20.0-orange)](https://pnpm.io)

---

## 界面预览

![Dashboard](assets/1.png)

![Providers](assets/2.png)

![路由规则](assets/3.png)

![模型测分](assets/4-benchmark.png)

![Token 统计](assets/5-tokenstats.png)

![设置](assets/7-settings.png)

![使用教程](assets/8-tutorial.png)

---

## 为什么选择 AiRoute

- **统一入口** — 所有 AI 客户端只需连接 `http://localhost:3000`，不再关心真实 API 地址
- **一键切换模型** — Electron 客户端面板点击切换，无需修改任何客户端配置
- **智能路由** — 中文走国产模型、代码走 Claude、自定义关键词匹配，按任务选最优
- **双协议支持** — 每个 Provider 可分别配置 Anthropic 和 OpenAI 端点，请求直接走对应协议，不做格式转换
- **故障自愈** — 主模型挂了自动 fallback，对客户端完全透明
- **可视化操作** — Electron 桌面应用，所有配置（Provider、规则、Fallback）均在界面完成
- **WorkBuddy 账号池** — 无需 API Key，OAuth 登录 WorkBuddy 账号池，多号轮转共享额度、失败自动换号重试
- **开箱即用** — 打包后为单个 exe 文件，内置 Express 服务无需额外安装部署，双击即用

---

## 架构

```
┌──────────────────────────────────────────┐
│          Claude Code / 任意 AI 客户端       │
│         ANTHROPIC_BASE_URL=localhost:3000 │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│            AiRoute Router (:3000)          │
│  请求代理 · 模型切换 · 智能路由 · Fallback   │
└──────┬──────────┬──────────┬─────────────┘
       │          │          │
       ▼          ▼          ▼
   ┌──────┐  ┌──────┐  ┌──────┐  ┌───────────────────────┐
   │ GLM  │  │ 小米 │  │Claude│  │WorkBuddy 账号池       │
   └──────┘  └──────┘  └──────┘  │多号轮转 · 失败换号    │
                                 └───────────────────────┘
```

---

## 功能

### 请求代理（核心）

- 同时兼容 **Anthropic Messages API** (`/v1/messages`) 和 **OpenAI Chat Completions API** (`/v1/chat/completions`)
- 自动替换 model、headers、endpoint，转发到当前激活的 Provider
- 支持流式（SSE）和非流式两种响应模式
- 推理档位：按设置页配置强制覆盖客户端请求中的 `reasoning_effort`（不使用 / low / medium / high / max，默认 max），避免非标档位被 OpenAI 协议上游拒绝

### 模型切换

在 Electron 客户端的 Dashboard 页面点击模型芯片即可实时切换，或通过系统托盘右键菜单（按 Provider 分组的二级菜单）快速切换。Providers 页面每个模型行也有独立的「切换」按钮。侧边栏下拉框、状态面板、托盘菜单、Providers 页面四处同步。

### Provider 管理

在客户端的 Providers 页面可视化增删改查 Provider，支持连通性测试。API Key 支持密码/明文切换和复制。

**一个 Provider 可以配置多个模型，每个模型可单独设置最大上下文与最大输出：**

```json
{
  "my-provider": {
    "baseURL": "https://your-api.com/anthropic",
    "openaiURL": "https://your-api.com/v1",
    "apiKey": "your-api-key",
    "displayName": "我的 Provider",
    "models": [
      { "id": "model-large", "displayName": "大杯", "maxContext": 200000, "maxOutput": 8192 },
      { "id": "model-small", "displayName": "小杯" }
    ]
  }
}
```

> - `baseURL` 用于 Anthropic 协议（`/v1/messages`），`openaiURL` 用于 OpenAI 协议（`/v1/chat/completions`），二者至少填一个。
> - `maxContext` / `maxOutput` **不填就是空**。`maxOutput` 会在请求未指定 `max_tokens` 时自动注入（Anthropic 协议要求该字段必填）。
> - 数组第一个模型是该 Provider 的默认模型。
> - 老配置里的单个 `"model": "xxx"` 字段会被自动识别为该 Provider 的唯一模型，**不会改写你的配置文件**。

### 模型引用

切换与路由的最小单位是**模型**，引用格式为 `Provider名/模型ID`：

```
my-provider/model-large     my-provider/model-small     auto
```

侧边栏下拉、状态面板快速切换、托盘菜单、路由规则目标、兜底模型，全部使用这个格式。老配置里只写了 Provider 名（如 `my-provider`）也能正常工作，解析时取其默认模型。

### Fallback 机制

主模型请求失败时，自动切换到备用模型。Fallback 配置在「路由规则」页面完成。

### 智能路由（auto 模式）

当激活模型设为 `auto` 时，根据请求内容自动选择最优模型。支持 13 种内置检测条件（代码、SQL、中文、翻译、代码审查等）+ 自定义关键词匹配。

> **自定义规则**：只匹配本次输入的最后一条用户消息，不受对话历史影响。如配置关键词 `123` → A 模型、`456` → B 模型，输入包含 `123` 就走 A 模型，与上下文无关。

路由规则在「路由规则」页面可视化编辑，所有 fallback 事件记录日志可追溯。

### 日志系统

- 记录：时间戳、模型、响应时间、状态码、输入/输出/缓存读/缓存写 Token、使用记录（输入文案）、积分消耗、fallback 信息
- 同一任务（一次输入及其后续工具调用）合并为一条记录，不再逐请求罗列
- 脱敏处理：API Key 相关字段自动隐藏
- 按天分文件存储（`logs/usage-YYYY-MM-DD.log`），在客户端「日志」页面可一键清空；页头显示日志目录占用体积与文件数
- 在客户端「日志」页面按模型/状态筛选、清空

### Token 统计

统计口径按四个维度分开记录，**缓存单独计数，不与输入重复计算**：

| 字段 | 含义 |
|---|---|
| `input` | 未命中缓存的输入 Token |
| `cacheRead` | 从缓存读取的输入 Token |
| `cacheWrite` | 写入缓存的输入 Token |
| `output` | 输出 Token |
| `total` | `input + cacheRead + cacheWrite + output` |

- Anthropic：`input_tokens` 本身不含缓存部分，直接取 `cache_read_input_tokens` / `cache_creation_input_tokens`
- OpenAI：`prompt_tokens` **包含**缓存部分，统计时从 `prompt_tokens_details.cached_tokens` 扣除后计入 `input`
- 所有时间维度（今日/本月/按小时）均使用**本机本地时间**
- 数据保留 35 天，按天清理

### 模型测分

内置题库跑一遍多个模型，出横向对比排行榜与各维度得分。

- **内置题库**：40 道题，覆盖代码生成、代码修复、SQL、数学计算、逻辑推理、翻译、指令遵循、结构化输出、长上下文九个维度，满分 200 分
- **两种评分方式**
  - 客观题用规则判定：`exact`（完全相等）、`contains`（按关键词命中比例）、`regex`（正则命中即满分）、`json`（按 schema 校验字段与类型）
  - 主观题（翻译、开放问答）交给**裁判模型**按评分细则打 1-5 分，裁判模型可以任选一个已配置的模型
- **题库可自行编辑**：增删改题目、按分类筛选、导入/导出 JSON、一键恢复内置题库
- **评测维度**：总分与得分率、各分类得分率、成功/失败数、平均延迟、Token 消耗
- 评测**直连 Provider**，不经过智能路由与 fallback，确保测的是目标模型本身

### WorkBuddy 账号池

内置的特殊 Provider：无需 API Key 和 URL，通过 OAuth 登录 WorkBuddy 账号，把账号池当作可轮转的模型来源使用。

- **多号轮转**：请求自动调度到可用账号，失败自动换号重试；同一会话保持粘性
- **维护自动化**：签到 / 保活 / 成长任务等由内置调度器定时执行
- **模型清单**：在「账号池 → 模型和档位」页签统一维护，启用后与其他模型一样参与智能路由与 Fallback，引用格式为 `workbuddy/模型ID`
- **账号池页签**：账号池、积分构成、用量、模型和档位、成长任务、定时任务、高级配置、运行日志

接入步骤见下方「WorkBuddy 账号池」章节。

### Electron 可视化客户端

| 页面 | 功能 |
|---|---|
| Dashboard | 当前模型、请求数统计、Token 用量（含缓存）、最近日志 |
| Providers | 增删改 Provider 与模型、连通性测试、单模型切换 |
| 账号池 | WorkBuddy 账号管理、多号轮转与积分用量、模型档位、定时任务、运行日志 |
| 路由规则 | 智能路由规则编辑、fallback 配置 |
| 日志 | 按任务合并、使用记录与积分消耗、目录占用提示、筛选、清空 |
| Token 统计 | 用量趋势图、各模型用量占比 |
| 模型测分 | 多模型跑分对比、题库编辑与导入导出 |
| 设置 | 端口配置、推理档位、服务重启、开机自启 |
| 使用教程 | 接入说明、功能概览 |

系统托盘驻留：右键快速切换模型、打开面板。

---

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org) >= 18
- [pnpm](https://pnpm.io) >= 10

### 安装

```bash
# 克隆项目
git clone https://github.com/c347087870/AiRoute.git
cd aiRoute

# 安装依赖（全部依赖集中在根 package.json，一次安装）
pnpm install
```

### 配置 Provider

```bash
# 复制配置模板
cp server/models.example.json server/models.json

# 编辑 models.json，填入你的 API 信息
```

编辑 `server/models.json`：

```json
{
  "my-model": {
    "baseURL": "https://your-api-endpoint.com/anthropic",
    "openaiURL": "https://your-api-endpoint.com/v1",
    "apiKey": "your-api-key",
    "displayName": "我的 Provider",
    "models": [
      { "id": "your-model-id", "displayName": "主力", "maxContext": 200000, "maxOutput": 8192 },
      { "id": "your-fast-id", "displayName": "轻量" }
    ]
  }
}
```

> Provider 名称不能包含斜杠 `/` 或空格。

> **注意**：`models.json` 包含 API Key，已加入 `.gitignore`，不会被提交到仓库。也可通过 Electron 客户端的 Providers 页面配置。

### 启动

```bash
# Electron 桌面应用（服务 + Vite + Electron 窗口）
pnpm dev

# 仅启动服务（配合任意客户端使用）
node server/router.js
```

服务默认运行在 `http://localhost:3000`。启动后打开 Electron 客户端即可管理所有配置。

---

## 接入 Claude Code

> **⚠️ 关键**：`ANTHROPIC_BASE_URL` 只需写到端口号，**不要**带 `/v1/messages` 路径。Claude Code 会自动拼接 `/v1/models`、`/v1/messages` 等路径。

### 1. 配置文件位置

Claude Code 的配置文件位于用户目录下：

```
~/.claude/settings.json          # macOS / Linux
C:\Users\<用户名>\.claude\settings.json  # Windows
```

### 2. 完整配置

打开配置文件，写入：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-airoute",
    "ANTHROPIC_BASE_URL": "http://localhost:3000"
  },
  "model": "claude-opus-4-7"
}
```

**字段说明：**

| 字段 | 值 | 说明 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `http://localhost:3000` | **不要带路径**，只写到端口 |
| `ANTHROPIC_AUTH_TOKEN` | `sk-airoute`（任意非空字符串） | AiRoute 不做认证，填任意值即可 |
| `model` | 从下方别名中任选一个 | 实际调用的是 AiRoute 当前激活的 Provider |

### 3. 可选模型别名

`/v1/models` 会返回**你配置的所有真实模型 ID**，外加下列兼容别名，Claude Code 的 `model` 字段可从下列选择：

```
claude-opus-4-0-20250514    claude-opus-4-20250514
claude-sonnet-4-0-20250514  claude-sonnet-4-20250514
claude-3-7-sonnet-20250219  claude-3-5-sonnet-20241022
claude-3-5-haiku-20241022   claude-3-opus-20240229
gpt-4o                      gpt-4o-mini
gpt-4-turbo                 gpt-3.5-turbo
```

> 无论选哪个别名，实际调用的是 AiRoute 当前激活的 Provider。切换 Provider 在 Electron 客户端中完成，无需修改 Claude Code 配置。

### 4. 重启 Claude Code

修改配置后，**完全退出 Claude Code 再重新启动**，配置方可生效。

---

## WorkBuddy 账号池

WorkBuddy 是内置的特殊 Provider：**无需 API Key 和 URL**，通过 OAuth 登录 WorkBuddy 账号，把账号池当作模型来源使用。

### 1. 添加账号

在客户端「账号池」页面点击添加账号，按提示在浏览器中完成 OAuth 授权；支持添加多个账号。凭证仅保存在本地数据目录 `workbuddy-auths/` 中。

### 2. 启用模型

在「模型和档位」页签维护 WorkBuddy 的模型清单，启用后的模型会出现在 Dashboard、Providers 等所有模型列表中，可参与智能路由与 Fallback，引用格式为 `workbuddy/模型ID`。

### 3. 多号轮转

请求自动调度到可用账号，失败自动换号重试且对客户端透明；同一会话保持粘性。

### 4. 定时任务

签到 / 保活 / 成长任务等维护任务由内置调度器自动执行，在「定时任务」页签可查看开关状态与执行记录。

### 5. 运行日志

账号池后台运行情况记录在「运行日志」页签，出现异常先在这里排查。

---

## 开发

```bash
# Electron 开发（服务 + Vite + Electron 窗口）
pnpm dev

# 构建 Electron 应用（输出单个 AiRoute.exe）
pnpm build

# 运行测试（WorkBuddy 模块离线断言，不发网络请求）
pnpm test
```

---

## 常见问题

<details>
<summary><strong>Q: 为什么修改 Claude Code 配置后不生效？</strong></summary>

**A:** 修改 `settings.json` 后需要完全退出 Claude Code 重新启动，仅在终端内重启无效。
</details>

<details>
<summary><strong>Q: Claude Code 配置中 ANTHROPIC_BASE_URL 带 /v1/messages 可以吗？</strong></summary>

**A:** 不可以。Claude Code 会自动在 BASE_URL 后拼接 `/v1/models`、`/v1/messages` 等路径。如果写成 `http://localhost:3000/v1/messages`，实际会访问 `http://localhost:3000/v1/messages/v1/messages`，导致 404。务必只写到 `http://localhost:3000`。
</details>

<details>
<summary><strong>Q: 如何添加新的 Provider？</strong></summary>

**A:** 推荐在 Electron 客户端的「Providers」页面通过表单添加，也支持连通性测试。也可直接编辑 `server/models.json` 添加配置。
</details>

<details>
<summary><strong>Q: Claude Code 输入 /model 看到的模型列表不对？</strong></summary>

**A:** 这说明 Claude Code 没有连上 AiRoute。
- 检查 `ANTHROPIC_BASE_URL` 是否只写到端口号
- 确认 AiRoute 服务已启动（访问 `http://localhost:3000/api/health`）
- 确认 Claude Code 已完全重启
</details>

<details>
<summary><strong>Q: 如何查看请求日志？</strong></summary>

**A:** 日志按天存储在 `server/logs/usage-YYYY-MM-DD.log`，可通过 `GET /api/logs` 查询，或在 Electron 客户端的「日志」页面查看（同一任务的多次请求合并为一条记录，支持筛选与清空，页头显示目录占用体积）。
</details>

<details>
<summary><strong>Q: AiRoute 会存储我的 API Key 吗？</strong></summary>

**A:** API Key 存储在 `server/models.json` 本地文件中，不出网。日志模块对 API Key 相关字段进行脱敏处理。`models.json` 已加入 `.gitignore`，不会被提交到仓库。
</details>

<details>
<summary><strong>Q: Auto 模式下没有配置路由规则会怎样？</strong></summary>

**A:** 会兜底使用第一个可用的 Provider，不会报错。推荐至少配置一条默认规则。
</details>

---

## 打包

```bash
pnpm build
```

构建产物为单个免安装文件 `app/dist-electron/AiRoute.exe`，约 85MB。

> 国内用户如需加速下载 Electron 二进制包，构建前设置镜像：
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```

---

## 许可

MIT License
