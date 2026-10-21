# AGENTS.md

给在本仓库工作的 AI 助手的约定。人也可以读。

## 项目

Electron 桌面应用 + 本地 Node 服务：把多家上游统一成一个 OpenAI 兼容端点（默认 `http://localhost:3000`，端口在设置里可改），界面在 `app/renderer`（Vue 3 + Vite）。

## 命令

```bash
pnpm dev          # 服务 + 渲染层 + Electron
pnpm dev:web      # 只起服务与前端（浏览器访问 5173）
pnpm build        # 按当前平台打包（Windows 出 4 个 exe，macOS 出 2 个 dmg）
pnpm test         # WorkBuddy 模块 + 一键升级（校验 / 替换 / 回滚 / Windows 静默安装助手）
pnpm test:e2e     # 端到端冒烟（本地 mock 上游，覆盖三条协议链路）
node scripts/verify-release.js   # 发布前自检：版本一致性、产物元数据、大小、SHA256
```

依赖以 `package-lock.json` 为准（CI 用 `npm ci`）；`pnpm-lock.yaml` 在 `.gitignore` 里，pnpm 不读 `package-lock.json`，版本可能与 CI 装出来的不一致——本地全绿而 CI 挂时先查这里。

## 代码约定

- 主进程 / `server/` / `scripts/` 是 CommonJS；`app/renderer` 是 ESM（Vite + Vue SFC）。全仓库无 TypeScript，也没有 lint / 格式化配置；跟随周边文件风格，不要引入新工具链
- 注释与文档用中文，注释解释「为什么」，不复述代码
- 产物命名以 `electron-builder.json` 的 `artifactName` 为唯一事实来源，`scripts/targets.js` 从它推导；不要在脚本里另写一份文件名
- 以下内容被 `.gitignore` 忽略，**绝不能提交**：`docs/`、`app/release/`、`app/dist-electron/`、`.claude/`；`server/` 下的运行数据与凭证同样不入库——`workbuddy-auths/`（明文 accessToken）、`state.json`、`server-config.json`、`models.json`、`token-stats.json`、`workbuddy-state.json`、`usage.json`、`credit-history.json` 等。注意 `server/models.example.json` 与 `server/questions.json` 是正常跟踪的文件，别一起排除

## 改动后必须验证

```bash
npm test
npm run test:e2e
```

涉及打包或更新链路时再跑：`npm run build -- --win` → `node scripts/verify-release.js`。

## 不要做

- 不要按进程名结束进程：`scripts/build.js` 只结束从 `app/dist-electron` / `app/release` 启动的实例，避免顶掉用户正在用的 AiRoute
- 调整 Windows 产物命名时，必须同步 `server/update.js` 的 `PORTABLE_SUFFIX` / `SETUP_SUFFIX`——`scripts/test-workbuddy.js` 有「产物名 ↔ 应用内更新拼名」一致性断言，不同步会红
- 不要给 `nsis` / `portable` 开 `buildUniversalInstaller`：会多出丢掉 `${arch}` 的 `AiRoute-<版本>-setup.exe`，与更新拼名对不上
- 不要复用已推送的 git tag，也不要删除已发布 Release 的资产
- 未经明确授权不要 commit / push / 打 tag / 创建 Release

## 发版

流程见 [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md)（Agent Skills 标准格式，按需自动加载）。

## 目录

```
app/main/        Electron 主进程（窗口、托盘、更新、安装形态判定）
app/renderer/    Vue 渲染层
server/          本地 HTTP 服务与上游适配（router / upstream / workbuddy）
scripts/         构建、产物推导、发布自检与测试
.agents/skills/  Agent Skills
```
