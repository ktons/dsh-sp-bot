# SKILL.md — ds-bot 插件开发与热重载迭代

对 `plugins/ds-bot/`（DS Bot 插件，独立 git 仓库，远端 `spbot` → `git@github.com:ktons/dsh-sp-bot.git`）做开发迭代时使用。

## 热重载迭代流程

ds-bot 是 DSH 插件。**在 DSH 里关闭再开启这个插件，插件代码就会重新加载**——不需要重启 DSH，也不需要重启会话。因此每次改完代码：

1. 改 `plugins/ds-bot/ds-bot/` 下的代码。改了 `src/client/` 要先 `npm run build`（`client.js` 是生成物，不能手改）。
2. 在 DSH 中把 ds-bot 插件**关闭再开启**，新代码即生效。
3. 在受影响的会话里验证行为；改了消息投递/平台对接时，用真实 QQ/飞书会话各验一条收发。
4. 通过后提交：`git add -A && git commit`，推送到 `spbot` 分支用 `git push spbot HEAD:main`（推标签用显式 refspec `git push spbot refs/tags/<tag>`，因为本地同名分支和标签并存）。

不要为了「生效」去重启 DSH 进程或重装插件；开关插件已覆盖热重载。

## 环境事实

- 本仓库是上游 `Fei2411/DS-Bot` 的 fork 基准（v0.3.8，commit `5e9b7da8`），保留完整上游历史便于追上游变更。
- 单元测试在 `ds-bot/` 目录跑：`npm test`（首次需 `npm ci && npm run harness`）；lint 用 `npm run lint`；`node scripts/build-client.mjs --check` 校验 client.js 未过期。
- 仓库根 AGENTS.md 的硬规则继续适用：不碰 `~/.dsh` 用户数据、不提交密钥、测试用 `dev/mock-llm.mjs`。
- 本仓库被外层 DSH 仓库 `.gitignore` 的 `/plugins/` 排除，外层提交不会带上它。
