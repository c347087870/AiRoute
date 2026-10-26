---
name: release
description: 用于 AiRoute 发版收尾——建 PR → 合并 → 打 tag 触发 CI 打包并创建 GitHub Release 草稿（草稿需手动发布）。当用户说「发版 / 发布 / release / create pr && merge && release」时使用。前提：改动已在分支上、本地构建与测试已通过。构建、测试、产物命名规则见 README 的「开发与打包」与 CHANGELOG。
---

# AiRoute 发版（PR → 合并 → 发布）

仓库：`c347087870/AiRoute`，默认分支 `main`。CI 定义在 `.github/workflows/release.yml`——**动手前读一遍实际文件**，job 名与步骤可能已变。

以下代码块假设在**同一个 shell 会话**里连续执行：`VERSION` / `BRANCH` / `TOKEN` / `PR` 在块之间复用。若工具每条命令都新开 shell，请在每个块开头重新导出所需变量（`TOKEN` 与 `VERSION` 那两行可重复执行，无副作用）。

## 0. 前置核对（缺一项就不要开始）

```bash
VERSION=$(node -p "require('./package.json').version"); echo "目标版本：$VERSION"
grep -m1 '^## \[' CHANGELOG.md                     # 顶部必须是 ## [$VERSION]
```

- `package.json` 的 `version` 与 `CHANGELOG.md` 顶部段落**必须同值**：`scripts/verify-release.js` 校验它，CI 的构建 job 会跑，不一致就不出包。不同值时先补 `CHANGELOG.md` 顶部段落并一并提交，**不要跳过这一步直接推 tag**（那时 CI 已经跑了一半才发现，tag 还得删）。
- 本地验证已过：`npm run build -- --win`（或 `--mac`）→ `node scripts/verify-release.js` → `npm test` → `npm run test:e2e`。
- 工作区除临时文件外干净：`git status --short`。

## 1. 提交并推分支

临时文件（提交信息、PR body、API 响应）**一律写到仓库外**，否则 `git add -A` 会把它们带进提交。

```bash
BRANCH="feat/<改动名>"
MSG="/tmp/release-msg.txt"          # 内容自备，conventional commits 风格

git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"   # 分支已存在则复用，便于失败重试
git add -A
git commit -F "$MSG"
GIT_TERMINAL_PROMPT=0 git push -u origin "$BRANCH"
```

## 2. 取证：无 gh CLI 时用 GCM 的 token

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')
[ -n "$TOKEN" ] || { echo "未取到 GitHub 凭据"; exit 1; }
```

token 只在 shell 变量里用，不写文件、不打印、不进提交。有 `gh` CLI 时可跳过本步与步骤 3/4 的 curl，直接用 `gh pr create` / `gh pr merge`。

## 3. 建 PR

```bash
BODY="/tmp/release-pr-body.md"
node -e "const fs=require('fs');const [b,o,t,h]=process.argv.slice(1);fs.writeFileSync(o,JSON.stringify({title:t,head:h,base:'main',body:fs.readFileSync(b,'utf8')}))" \
  "$BODY" /tmp/release-pr.json "<PR 标题>" "$BRANCH"

curl -s -o /tmp/release-pr-resp.json -w "http=%{http_code}\n" \
  -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/c347087870/AiRoute/pulls --data-binary @/tmp/release-pr.json

# 路径必须走参数：MSYS 只转换命令行参数，JS 字符串里的 /tmp 会被 Node 解析成 C:\tmp
node -e "const r=require(process.argv[1]);console.log(r.number ?? r.message)" /tmp/release-pr-resp.json
```

期望 `http=201`。

## 4. 合并

仓库历史是 merge commit 风格，`merge_method` 用 `merge`：

```bash
PR=123        # 上一步返回的 PR 号

curl -s -o /tmp/release-merge-resp.json -w "http=%{http_code}\n" \
  -X PUT -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/c347087870/AiRoute/pulls/$PR/merge" \
  -d "{\"merge_method\":\"merge\",\"commit_title\":\"Merge pull request #$PR from c347087870/$BRANCH\"}"

node -e "const r=require(process.argv[1]);console.log(r.merged)" /tmp/release-merge-resp.json   # 期望 true
```

## 5. 打 tag 发布

```bash
git checkout main && git pull --ff-only \
  && git log -1 --format=%s | grep -q "^Merge pull request #$PR" \
  && git tag -a "v$VERSION" -m "v$VERSION: <一句话>" \
  && git push origin "v$VERSION"        # 触发 release.yml
```

这四步必须串联执行：`git pull --ff-only` 失败（本地 `main` 分叉、离线）时若继续打 tag，tag 会落在**不含本次 merge 的旧 commit** 上，CI 仍会构建发布，产出的包却没有这次的功能，而 tag 又不能重打。`git log -1` 不是 `Merge pull request #<PR>` 时同样停下。

**已推送的 tag 不要删了重打**：会让已有下载与 Release 资产失配。有问题就发下一个 patch。

## 6. CI 会做什么（`release.yml`）

| job | 内容 |
| --- | --- |
| `测试与版本校验` | `npm test` + `npm run test:e2e` + tag ↔ `package.json` 校验（允许 tag 带 `-` 后缀，如 `-beta.1`） |
| `构建 (mac)` / `构建 (win)` | `npm run build` → `verify-release.js` → 收集 `app/release` 的产物 |
| `创建 Release（正式版草稿 / beta 直接发 pre-release）` | 用 `AiRoute-<版本>-x64-portable.exe` 复制 `AiRoute.exe`（旧名兼容）→ `sha256sum *` 生成 `SHA256SUMS.txt` → 正式版 `gh release create --generate-notes --draft`（人工 Publish）；带 `-` 后缀的 beta 版 `gh release create --generate-notes --prerelease`，**直接发布、不建草稿** |

草稿同样能按 tag 查到（gh 走 GraphQL 查 draft），重跑 workflow 时改为 `gh release upload --clobber` 覆盖资产，**草稿状态不变**。草稿不会出现在 `/releases/latest` 与公开列表中，所以已发布的旧客户端检测不到它——这正是正式版要人工确认后再发布的原因。

**beta 版为什么不建草稿**：客户端按版本号分两条更新线路（正式版只看正式发布，预发布版只看 pre-release，见 `server/update.js` 的 `releaseLine`）。草稿对匿名调用**完全不可见**——资产下载一律 404，`/releases` 列表里也不出现；beta 客户端因此永远查不到它。beta 版必须直接发布成 pre-release 才走得到线上。

`workflow_dispatch` 用**分支** ref 触发只构建；用 **tag** ref 触发仍会走 `创建 Release`。

## 7. 跟踪与收尾

```bash
curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/c347087870/AiRoute/actions/runs?per_page=3"

curl -s -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/c347087870/AiRoute/actions/runs/<run_id>/jobs"
```

完成判据：`创建 Release` 成功，Release 上有 8 个资产（4 个 Windows exe、2 个 dmg、`AiRoute.exe`、`SHA256SUMS.txt`），且 `SHA256SUMS.txt` 与其余资产一一对应。

**正式版发布是人工的一步**：核对资产与 SHA256 后执行 `gh release edit "v$VERSION" --draft=false`（或网页点 Publish）。在此之前正式线客户端不会看到新版本；不要为了「让更新生效」绕开草稿直接改发布状态，也不要重复上传。

**beta 版不需要人工发布**：CI 已经把 pre-release 发出来了，beta 客户端立刻能查到。要撤回就 `gh release edit "v$VERSION" --prerelease=false --draft=true` 改回草稿（草稿对客户端重新不可见）。

**校验一律以 Release 的 `SHA256SUMS.txt` 为准**——CI 会重新打包，本地 `verify-release.js` 算出的 SHA256 与线上必然不同。本地 SHA 只能证明配置正确，不能写进发布说明当线上值。

收尾：`rm -f /tmp/release-*`，确认 `git status --short` 没有残留。

## 硬约束（违反会直接坏发布）

- 便携版命名规则是 `AiRoute-<版本>-<arch>-portable.exe`、安装版 `-setup.exe`。改名必须同步 `server/update.js` 的 `PORTABLE_SUFFIX` / `SETUP_SUFFIX`，`scripts/test-workbuddy.js` 有「产物名 ↔ 更新拼名」一致性断言，不同步会红。
- **beta 版不要建草稿**：客户端按版本号分两条线路（正式版只看正式发布，预发布版只看 pre-release）。草稿对匿名调用不可见，beta 客户端永远查不到。正式版保持草稿 + 人工 Publish。
- 不要把 `nsis` / `portable` 的 `buildUniversalInstaller` 改成 `true`：会多出丢掉 `${arch}` 的 `AiRoute-<版本>-setup.exe`，与更新拼名对不上。
- 不要改回按进程名 `taskkill`：`scripts/build.js` 只结束 `app/dist-electron` / `app/release` 下的实例，避免顶掉用户正在运行的 AiRoute。
- 不要复用已发布的 tag；不要用本地 SHA256 当线上校验值；不要把 `/tmp` 之外的一次性文件（PR body、API 响应）提交进仓库。
- Windows 一键升级依赖安装版（`-setup.exe`）+ 免 UAC（`oneClick:false` / `perMachine:false` / `allowElevation:false`）；便携包静默运行只会解包启动新实例，因此被排除在升级链路外。改这些配置前先看 `app/main/updater-core.js` 与 `app/main/install-kind.js`。
