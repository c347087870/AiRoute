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

---

## 为什么选择 AiRoute

- **统一入口** — 所有 AI 客户端只需连接 `http://localhost:3000`，不再关心真实 API 地址
- **一键切换模型** — Electron 客户端面板点击切换，无需修改任何客户端配置
- **智能路由** — 中文走国产模型、代码走 Claude、自定义关键词匹配，按任务选最优
- **故障自愈** — 主模型挂了自动 fallback，对客户端完全透明
- **可视化操作** — Electron 桌面应用，所有配置（Provider、规则、Fallback）均在界面完成
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
   ┌──────┐  ┌──────┐  ┌──────┐
   │ GLM  │  │ 小米 │  │Claude│  ···
   └──────┘  └──────┘  └──────┘
```

---

## 功能

### 请求代理（核心）

- 同时兼容 **Anthropic Messages API** (`/v1/messages`) 和 **OpenAI Chat Completions API** (`/v1/chat/completions`)
- 自动替换 model、headers、endpoint，转发到当前激活的 Provider
- 支持流式（SSE）和非流式两种响应模式

### 模型切换

在 Electron 客户端的 Dashboard 页面点击模型芯片即可实时切换，或通过系统托盘右键菜单快速切换。侧边栏下拉框、状态面板、托盘菜单三处同步。

### Provider 管理

在客户端的 Providers 页面可视化增删改查 Provider，支持连通性测试。API Key 支持密码/明文切换和复制：

```json
{
  "my-provider": {
    "baseURL": "https://your-api.com/anthropic",
    "apiKey": "your-api-key",
    "model": "your-model",
    "displayName": "我的模型"
  }
}
```

### Fallback 机制

主模型请求失败时，自动切换到备用模型。Fallback 配置在「路由规则」页面完成。

### 智能路由（auto 模式）

当激活模型设为 `auto` 时，根据请求内容自动选择最优模型。支持 14 种内置检测条件（代码、SQL、中文、翻译、代码审查等）+ 自定义关键词匹配。

> **自定义规则**：只匹配本次输入的最后一条用户消息，不受对话历史影响。如配置关键词 `123` → A 模型、`456` → B 模型，输入包含 `123` 就走 A 模型，与上下文无关。

路由规则在「路由规则」页面可视化编辑，所有 fallback 事件记录日志可追溯。

### 日志系统

- 记录：时间戳、模型、响应时间、状态码、fallback 信息
- 脱敏处理：API Key 相关字段自动隐藏
- 在客户端「日志」页面分页查看

### Electron 可视化客户端

| 页面 | 功能 |
|---|---|
| Dashboard | 当前模型、请求数统计、最近日志 |
| Providers | 增删改 Provider、连通性测试 |
| 路由规则 | 智能路由规则编辑、fallback 配置 |
| 日志 | 分页查看、实时刷新 |
| 设置 | 端口配置、服务重启、开机自启 |
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

# 安装依赖（所有子目录）
pnpm install
cd server && pnpm install && cd ..
cd app && pnpm install && cd ..
cd app/renderer && pnpm install && cd ../..
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
    "apiKey": "your-api-key",
    "model": "your-model-id",
    "displayName": "我的模型"
  }
}
```

> **注意**：`models.json` 包含 API Key，已加入 `.gitignore`，不会被提交到仓库。也可通过 Electron 客户端的 Providers 页面配置。

### 启动

```bash
# Electron 桌面应用（推荐）
pnpm dev:app

# 仅启动服务（配合任意客户端使用）
cd server && node router.js

# H5 模式（服务 + 浏览器预览）
pnpm dev:h5
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

`/v1/models` 返回以下别名，Claude Code 的 `model` 字段可从下列选择：

```
claude-opus-4-7            claude-opus-4-0-20250514
claude-sonnet-4-7          claude-sonnet-4-0-20250514
claude-3-7-sonnet-20250219 claude-3-5-sonnet-20241022
claude-3-5-haiku-20241022  claude-3-opus-20240229
gpt-4o                     gpt-4o-mini
gpt-4-turbo                gpt-3.5-turbo
```

> 无论选哪个别名，实际调用的是 AiRoute 当前激活的 Provider。切换 Provider 在 Electron 客户端中完成，无需修改 Claude Code 配置。

### 4. 重启 Claude Code

修改配置后，**完全退出 Claude Code 再重新启动**，配置方可生效。

---

## API 参考

### 核心代理

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/messages` | Anthropic 协议代理 |
| `POST` | `/v1/chat/completions` | OpenAI 协议代理 |
| `GET` | `/v1/models` | 返回兼容的模型列表（含别名） |

### 模型管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/state` | 获取当前激活模型 |
| `POST` | `/api/state` | 切换当前模型 `{"current": "my-model"}` |

### Provider 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/providers` | 列出所有 Provider（Key 脱敏） |
| `GET` | `/api/providers/:name/full` | 获取单个 Provider 完整信息 |
| `POST` | `/api/providers/:name` | 新增 Provider |
| `PUT` | `/api/providers/:name` | 更新 Provider（apiKey 为空保留原值） |
| `DELETE` | `/api/providers/:name` | 删除 Provider |
| `POST` | `/api/providers/:name/test` | 连通性测试 |

### Fallback

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/fallback` | 获取 fallback 配置 |
| `PUT` | `/api/fallback` | 设置 fallback 模型 `{"model": "my-model"}` |

### 路由规则

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/rules` | 获取智能路由规则 |
| `PUT` | `/api/rules` | 更新路由规则（含 customRules） |

### 日志与统计

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/logs?limit=50` | 获取最近 N 条日志 |
| `GET` | `/api/stats` | 获取请求数统计（今日/总计） |

### 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/server-config` | 获取服务配置 |
| `PUT` | `/api/server-config` | 更新服务配置（如端口） |
| `POST` | `/api/restart` | 重启服务 |

---

## 项目结构

```
aiRoute/
├── server/                      # Router 核心服务
│   ├── package.json              # 服务端依赖（Express、axios、cors 等）
│   ├── .npmrc                    # pnpm 配置
│   ├── router.js                # 请求代理入口（Express）
│   ├── router-engine.js         # 智能路由引擎
│   ├── logger.js                # 日志模块
│   ├── test-endpoints.js        # 端点测试脚本
│   ├── models.example.json      # Provider 配置模板
│   ├── models.json              # Provider 配置（gitignore）
│   ├── state.json               # 当前模型状态
│   ├── fallback.json            # Fallback 配置
│   ├── rules.json               # 智能路由规则
│   ├── server-config.json       # 服务配置（端口等）
│   └── logs/                    # 日志目录（gitignore）
│
├── app/                         # Electron 可视化客户端
│   ├── main/                    # 主进程
│   │   ├── main.js              # 窗口管理 + 生产模式内置启动 Express
│   │   ├── tray.js              # 系统托盘
│   │   ├── preload.js           # IPC 桥接
│   │   └── icon.ico             # 应用图标
│   ├── renderer/                # 渲染进程（Vue 3）
│   │   ├── src/
│   │   │   ├── App.vue          # 根组件
│   │   │   ├── views/           # 6 个页面
│   │   │   ├── components/      # 通用组件
│   │   │   ├── composables/     # 共享状态
│   │   │   ├── api.js           # HTTP API 封装
│   │   │   └── router.js        # 前端路由
│   │   └── vite.config.js
│   ├── scripts/
│   │   └── dev.js              # Electron 开发启动（Vite + Electron）
│   └── electron-builder.yml     # 打包配置
│
├── scripts/                     # 启动/构建脚本
│   ├── dev-app.js               # Electron 开发模式
│   ├── dev-h5.js                # H5 开发模式
│   ├── build.js                 # 构建打包（输出单个 exe）
│   └── port-utils.js            # 端口管理（Windows）
│
├── assets/                      # 文档截图
│
├── README.md                    # 本文件
├── .gitignore
├── .npmrc                       # pnpm 配置
└── package.json                 # 根包描述
```

---

## 开发

```bash
# H5 开发（浏览器预览）
pnpm dev:h5

# Electron 开发（桌面应用）
pnpm dev:app

# 构建 Electron 应用（输出单个 AiRoute.exe）
pnpm build
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

**A:** 日志存储在 `server/logs/usage.log`，可通过 `GET /api/logs` 查询，或在 Electron 客户端的「日志」页面查看。
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

构建产物为单个免安装文件 `app/dist-electron/AiRoute.exe`，约 230MB。

> 国内用户如需加速下载 Electron 二进制包，构建前设置镜像：
> ```powershell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
> $env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```

---

## 许可

MIT License
