# spbot：瘦监督 Bot 与 lane 协议

- 日期：2026-11-19
- 分支：`feat/spbot-lanes`
- 状态：设计确认，实施中

## 为什么

用户同时推进多个项目时，要逐个项目盯进度、回答"是否按 xxx 继续"这类问题，判断成本高。新增一种瘦监督 Bot 类型 **spbot**：

- 它管理一组工作区（可设别名），向工作区**派发 lane**——普通 DSH 会话——去做调研、设计与实现；
- 它与用户讨论设计，但自己不读工作区实现：需要了解就派 lane 去看并汇总；
- 设计定稿后它不写代码：派 lane 去做，也不跑验收，**一切在 lane 闭环**；
- 它的主要工作情景：lane 干活中提问，它直接回复并要求继续，而不是让"是否按 xxx 继续"落到用户头上；
- 它从 lane 的汇报判断项目是否完成，让用户不用逐个项目去盯。

## 概念

- **spbot（supervisor）**：一种 Bot `kind`。仍是团队一员（可被 `message_bot`、可入群），但没有 Main Bot 权力；它多出的是 lane 协议工具。
- **lane**：一条普通 DSH 会话，跑在 spbot 托管的工作区里，带 `ds-bot-lane` 预设与 lane 协议工具。不进 `state.bots`，不是 Bot；用户可以在 DSH 里直接打开它（plain 会话表面）。
- **托管工作区（managed workspace）**：spbot record 上的 `{ path, alias }` 列表。path 经 `workspaceRegistry.resolveByPath`（必要时 `create`）成为 DSH 工作区，lane 因此挂进用户的项目会话列表。alias 在该 spbot 内唯一，是 spbot 派发/汇报时对工作区的称呼。

## 已定的行为

四个决定已与用户确认：

1. **instructions 注册成 skill，不进提示词**。给 spbot 写的指令不注入 `bot-identity` section（prompt.js:130-149），改为按 agent scope 注册成 skill（模式同 capabilities.js:322 的 `skills.register`），提示词只留身份行与指针（"Your playbook is the skill …; load it before answering lanes or reporting."）。`update_bot` 改指令时重挂。
2. **lane 可新派，也可接管**。派发走 `sessionController.create({ workspaceId, agentPreset: 'ds-bot-lane' })`（roster.js:95-108 同款）；接管走 adopt 校验（agents.js:49-60 同款：拒绝已属于团队/已有 lane 的会话，要求 cwd 在托管工作区内）。
3. **界面**：把现有"原始会话"展示区（`sidebar.js` 的 DSH Agent 行 + `bt-agent-sub-*` 子行）拓展为**多工作区分组**：团队工作区组（现状不变）+ 每个 spbot 的托管工作区组（alias 作组标题），lane 子行（标题 + 状态点 + 所属 spbot 标记）列在其下，点开走 plain 表面（`isAgentSessionId` 覆盖 lane）。组内提供「新建 lane」「接管会话」；会话右键菜单提供「Make lane」。
4. **权限**：lane 应用「工作区内修改」permission preset（permissions.js `setPreset` 同款机制，preset id 以 `rt.permissionCatalog()` 为准）；越界审批仍走默认 waterfall 弹给用户，spbot 不代批。

### 类型与预设

- bot record 新增 `kind: 'supervisor'`（缺省即普通 Bot）。**只在创建时定，不可后改**（预设按 Session 锁死，见 2026-11-19-usability-visibility.md §1）。
- `roster.js botPreset()` 按 kind 分支选 `ds-bot-sp`；lanes 模块创建 lane 时选 `ds-bot-lane`。两者都走"缺失/broken 回退 standard"守卫。
- `prompt.js` 注册四个预设（同 prompt.js:115 的循环）：
  - `ds-bot-sp` = `SP_RULES + TEAM_RULES`。SP_RULES：监督守则——果断回答 lane、不把决定抛回给 lane 或用户、按汇报判完成、未完成就要求继续、完成且有证据才向用户报、需要用户拍板时用 ask_user 一次性问清。
  - `ds-bot-lane` = `LANE_RULES`（复用 `presetRows()` 行集）。LANE_RULES：lane 协议——只用 lane_ask/lane_report 与监督者通信、不向最终用户直接发问、每回合结束前必须要么 lane_report 要么 lane_ask、答案/指示到达后继续干活。
- `create_bot` / `createBot` 增加 `type: 'supervisor'` 参数（Main Bot 经工具也可建 spbot）；`update_bot` 不接受改 kind。

### lane 协议（回合闭环）

lane 只在 spbot 给它输入时运转（派发任务、追问指示、问题答案），所以**每个 lane 回合结束都回到 spbot**：

1. **派发**：`dispatch_lane { workspace, task, title?, model?, effort? }` → 建 lane 会话 → 注册 lane 工具 → 应用权限 preset → kickoff（`[Lane task]` 头 + 任务 + 工作区 alias + 协议要点，仿 sendKickoff）→ lane 回合开始。
2. **回合结束路由**：`turns.js` 的回信路由对 lane 会话让位给 lanes.js（`rt.laneOf` 分支）。lane 回合结束时，lanes.js 把最终文本（若有）连同 `lane_report` 记下的状态（若有）作为一条 `[Lane report · <alias>/<title>]` 投进 spbot 会话（role 'request'），唤醒 spbot。
3. **提问**：`lane_ask { question, context? }`（仿 ask_user：写 lane 记录的 `ask` + `exec.concludeTurn()`）→ 问题作为 `[Lane question · …]` 投进 spbot；spbot 该回合的最终文本由 lanes.js 送回 lane（结构化 followup，仿 answerQuestion 的认领-回填），lane 以此为下一回合的输入继续。问题未答前再次 lane_ask 拒绝。
4. **汇报**：`lane_report { status: 'progress'|'done'|'blocked', note }` 记状态并结束回合（note 随回合文本一起到 spbot）。spbot 判未完成 → 回合文本或 `message_lane` 要求继续；判完成且汇报带证据 → 标记完成并在自己聊天里告知用户（spbot 在 report 触发的回合里，最终文本落在自己聊天、面向用户；lane_ask 触发的回合，最终文本作为答案回 lane）。
5. **其余工具**：`message_lane { lane, message, when }`（steer/followup，仿 message_bot）、`list_lanes`（每 lane 一行：alias · 标题 · 状态 · 停留在哪，仿 botLine）、`stop_lane { lane, reason }`（`agent.cancel` + 状态 stopped，清掉挂起的问题）。
6. **接管**：`adopt_lane { workspace, session }`（spbot 工具）或界面「Make lane」/组内「接管会话」→ 校验后登记 `{ adopted: true }` → 补投一条协议说明（followup），lane 照协议行事。

### 状态与投递

- `state.lanes[sessionId] = { id, spBotId, workspacePath, alias, title, status, adopted, createdAt, ask?, task }`；status ∈ `working | asking | idle | done | stopped`。store.js 建表 + migration + sessionId→lane 索引（indexSessions 同款）。
- `delivery.js deliver()` 增加 lane 感知：`to`/`from` 解析不到 Bot 时查 lanes（session id + 标题作 fromName），bot↔bot 的认领/记账路径不变。
- lane 事件在 spbot 聊天里以现有 exchange 形式可见（client 端名称解析补充 lanes 来源）。

## 不做什么

- spbot 不实现、不验收、不代批权限；它对工作区的了解只来自 lane 的汇总与汇报。
- lane 不进 `state.bots`，不是 Bot：没有团队工具、不进群、不可被 `message_bot`。
- 不做 IM（飞书/QQ）侧的 lane 动态转发（v1）；phone/remote 因共享 state payload 自动可见，不做专门界面。
- 不做 lane 的定时巡检/cron；监督由"每个 lane 回合结束必回 spbot"驱动。
- 已有 Bot 不能就地转成 spbot（预设锁死）；要监督就新建。
- 不做 lane 历史的专门检索界面（lane 就是普通会话，DSH 自带历史）。

## 已知限制

- lane 卡在权限审批时状态停留 working：审批卡片在 DSH 侧，用户打开该 lane 会话处理；ds-bot 审批视图 v1 不覆盖 lane。
- lane 回合若被崩溃/重启打断，重启续跑消息（delivery.js resumed）照走 lanes.js 路由，spbot 会看到续跑说明。
- lane 用派发时指定的 model/effort，缺省 profile 默认；运行中不换模型。
- 托管工作区目录被删/移动后派发失败并在工具结果里说明，alias 不自动清理。
- lane 问题没有超时：挂着等 spbot（或用户经 `stop_lane`/界面停止）。

## 变更

- `docs/plans/2026-11-19-spbot-lanes.md`（本文）
- `ds-bot/src/host/prompt.js`：SP_RULES / LANE_RULES、四个预设注册、身份节 supervisor 分支
- `ds-bot/src/host/roster.js`：kind、botPreset 分支、createBot 的 type 参数
- `ds-bot/src/host/lanes.js`（新）：托管工作区、派发/接管、lane 工具、回合路由、状态
- `ds-bot/src/host/store.js`：lanes 表、migration、索引
- `ds-bot/src/host/delivery.js`：lane 感知
- `ds-bot/src/host/permissions.js`：lane 权限 preset 应用
- `ds-bot/src/host/tools.js`：create_bot 的 type；spbot 侧工具的 scope 注册
- `ds-bot/src/host/channel.js`：`lanes`、`lane-stop`、`lane-adopt`、`sp-workspace-add`、`sp-workspace-remove`
- `ds-bot/src/client/`：sidebar/sources/index 多工作区 plain 表面与 lane 行；create-bot/bot-settings 类型与托管工作区编辑器；context-menu「Make lane」；i18n（en/zh）；`npm run build` 重新生成 client.js
- `ds-bot/test/`：lanes.test.js（新）、prompt.test.js / agent-preset.test.js 补断言、store migration 用例
- `README.md` / `README.zh.md`：功能一节
