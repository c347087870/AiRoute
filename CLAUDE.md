# AiRoute 项目规则

## 改动应用后不要重启 AiRoute

- 本项目的 Claude Code 终端由 AiRoute 内嵌（开发者选项 → Claude Code 终端）运行，连接的是
  AiRoute 启动的 `localhost:3000` 网关。重启或退出 AiRoute 会直接断掉当前 Claude Code 会话。
- 修改代码后只改源码，不要执行任何会终止 AiRoute 或占用其端口的操作：
  - `npm run dev` / `npm run dev:web`（会占用 3000 端口）
  - `osascript -e 'quit app "AiRoute"'`、`pkill -f AiRoute`、`scripts/build.js` 中杀进程的路径
  - 手动退出/重启桌面客户端
- 验证方式：`node --check <file>` 检查主进程语法；`vite build --outDir /tmp/...` 构建到临时目录
  （不要覆盖 `app/renderer/dist`，也不要跑完整打包）。
- 需要让改动生效时，提示用户到「开发者选项 → 构建与安装」点击「构建并安装」，
  由构建脚本以 `AIROUTE_BUILD_NO_KILL=1` 完成打包、覆盖安装。构建期间不要重启 AiRoute，
  安装完成后的应用重开由脚本自行处理（用户点击按钮触发，不中断当前会话的构建日志）。
