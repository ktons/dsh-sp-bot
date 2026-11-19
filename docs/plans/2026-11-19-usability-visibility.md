# 易用性迭代：信息可见化（提示词预设 / IM 断消息 / 思考卡片粒度）

- 日期：2026-11-19
- 分支：`ux/visibility-iteration`
- 状态：探查完成，待确认后实施

## 为什么

DS-Bot 的很多行为细节写死在代码里，用户不可见也不可配：

1. 提示词是 "standard 预设 + 一段写死的团队规则"，规则文本改不了也看不到。
2. IM（飞书 / QQ）在子智能体（subagent）返回、agent 继续回复时会丢消息。
3. 思考过程 / 工具调用细节的卡片是 DS-Bot 自己封装的极简渲染，没有沿用 DSH 自身的消息粒度，也没有配置项。

本文记录三路探查的结论与改法。三件事互相独立，可分别提交。

## 1. 提示词改为预设（main-bot / team-bot）

### 现状

- `ds-bot/src/host/prompt.js` 把团队规则写成常量 `TEAM_RULES` / `MAIN_RULES`，注册为 `bot-identity` systemPrompt.section（order 640，每 agent 动态渲染：`rt.isMain(self) ? MAIN_RULES + TEAM_RULES : TEAM_RULES`，prompt.js:54）。
- Bot 建 Session 时硬编码使用 `standard` 预设：`roster.js:74-81 botPreset()` 从 `ctx.get('agentPresets').list()` 里确认 `standard` 存在且未 broken，然后 `sessionController.create({ agentPreset: 'standard' })`（roster.js:96）。群成员 Session 走同一入口（groups.js:425），所以新群 Session 也是 standard。
- `tools.js:1062-1067 filterBotAssembly` 的注释与行为假设预设是 standard（standard 把 `subagent` 等注册在各 Agent 自己的 scope）。

### DSH 预设机制（证据来自 `ds-bot/dev/harness` 的 @deepseek-ai 0.2.2-rc.1 包）

- preset 结构 = 一组 Cordis 插件行（工具行、prompt section 行、隔离组），内置 standard 即 `dsh-web-app/presets/standard.patch.yml` 一个文件。
- 注册 API 两条路：声明式 `@deepseek-ai/dsh-agent-preset` 行（`{ id, name, plugins }`），或编程式 `agentPresets.register(definition)`（dsh-agent-preset-registry/lib/index.js:486-510，返回 disposer）。DS-Bot 已能通过 `ctx.get('agentPresets')` 拿到服务。
- preset 组合是挂载时静态的，没有 per-agent 钩子：**每个 Bot 不同的人设不可能进预设**，必须继续走动态的 systemPrompt.section。
- 预设按 Session 指定：创建时 `sessionController.create({ agentPreset })`；跑过 turn 的 Session 锁死（`agent-preset/locked`，registry index.js:769），已有 Session 不迁移。
- 权限与 agent preset 正交（`permissionPresets` 是另一个服务），MAIN/TEAM 的权限差异不靠预设解决。

### 改法

1. 注册 `ds-bot-main` / `ds-bot-team` 两个预设：复制 standard 的插件行清单，把 TEAM_RULES / MAIN_RULES 文本放进 `dsh-persona` 行的 prefix/suffix。预设行只引用 npm 包、不 inject DS-Bot 独有服务（避免激活期循环等待）。
2. `roster.js botPreset()` 改为按 `rt.isMain` 选预设 id，保留"预设缺失 / broken 时回退 standard"守卫（现有 broken 检查需扩展）。
3. `prompt.js` 删掉规则拼接；`bot-identity` section 只剩动态人设（name / role / instructions）。群 relay 文案（prompt.js:60-62）不进预设。
4. 复核 `tools.js` filterBotAssembly 的假设；确认 `parts.js:318` 的 `serviceFor('compaction')` 对自定义预设同样工作（registry 公开 API）。

### 风险

- **只对新建 Session 生效**：已有 Bot 的在用 Session、群 Session 不迁移（`agent-preset/locked`），升级后有新旧规则来源不一致的过渡期。
- 预设里某行激活失败会让整个预设 broken；回退逻辑必须覆盖。
- 防重复注册（`duplicate preset id` 会抛错）：DS-Bot 重复加载要幂等。

## 2. IM 断消息（飞书 / QQ）：subagent 返回后回复丢失

### 根因（代码证据链）

不是"拆成多条"，而是**整段丢失**：

1. subagent 结束时 DSH 往父 Session 注入一条 `user/message`，`source.kind === 'subagent-settled'`（turns.js:1040-1059；`agent-message` 在 turns.js:921 也被识别）。
2. `im/index.js:1443-1473` 的 user/message 来源分类只认四种：`imOrigin`、`rpcId im:`、`REPLY_KIND`（'user-question-reply'）、`SOURCE_KIND==='bot' && role==='post'`。`subagent-settled` / `agent-message` 都不匹配，落入最后的 else（im/index.js:1469-1473）→ `dropOrigin(session.id)`。
3. `dropOrigin` 删除 origin 并把 session 加入 `mixed`（im/index.js:494-498）；mixed 后 `claimOrigin` 直接 return（:476），`originOf` 返回 undefined → 后续 assistant/message 在 :1492-1493 直接 return，**不再发往 IM**。

### 次级观感问题（即使 origin 不断也存在）

- 分片粒度：`displayItems` 对每个 text block 生成独立 'bot' 条目（parts.js:1736-1743），im/index.js:1494-1498 对每条单独 `sendTo` —— 同一 turn 的每个 step 天然就是多条平台消息，没有"续写"逻辑。
- 飞书有 `edit`（PATCH 卡片，feishu.js:218-223）但普通 bot 行从不调用（edit 只用于已回答卡片 settledEdits，im/index.js:960-975）；send 内部 chunkMarkdown 按 4000 字符分片（feishu.js:201-217），chunk 不断语义。
- QQ 没有 edit；每条 send 用最后 msg_id + 递增 msg_seq 被动回复（qq.js:136-167），被动回复窗口过期被 classify 为 permanent（qq.js:45-52），队列里的续文整条丢弃 —— bot 长思考时放大"后半段消失"。

### 改法

- 必改：im/index.js:1443 的 user/message 分类中，把 `source.kind === 'subagent-settled' || source.kind === 'agent-message'` 视为 turn 内部事件 —— 既不 claim 也不 drop，直接 continue（与 role==='post' 的处理一致）。最小且对症。
- 可选增强 A：同一 turn 内连续 assistant/message 的 'bot' 条目在发往 IM 前合并（缓冲到工具调用边界或 turn/end 再发）。
- 可选增强 B：飞书用已有 edit 能力续写上一条卡片；QQ 维持多条但至少不受 origin 丢失影响。
- 顺带：评估 QQ 被动回复窗口过期问题（对 bot 回复改主动消息或缩短缓冲）。

### 实施状态（2026-11-19 补）

- 回合内断链已修复：`im: keep the reply origin when a subagent settles inside the turn`（cfa0f776，main）。
- 第二种形态——**后台**子代理 settle 开启新回合：turn/start 无条件 resetOrigin，总结同样发不出（探针测试证实 `sent: []`）。已按群组 pendingReset 同款规则补齐：直聊回合结束时记住来路聊天，新回合开头无读者输入时恢复 origin，首条消息是 settle/relay 则保留、其余来源照旧撤销；连续多个 settle 回合逐轮续接。
- dsh-im 侧（普通会话经 dsh-im 桥接的场景，含本计划上午丢失汇总的那条 QQ 会话）的服务回合投递过滤与 QQ 主动消息配额问题，已在 dsh-im 插件仓库单独修复，不属于本仓库改动。

## 3. 思考 / 工具卡片沿用 DSH 原生渲染 + 配置开关

### 现状

- ds-bot 通过 slot shadow（优先级 -100）整体抢占 DSH 聊天流各类节点的渲染（client/index.js installConversation，约 :1240-1310）：`assistant-step` / `tool-call` / `turn-process` / `turn-error`。"极简"就是这些自绘 cell；思考卡片是 `ThinkingRow`（cells.js:204-239，`<details class="bt-think">`，收起只显示时长），另有 `isHiddenTurn` 过滤（cells.js:277、:790）隐藏 Bot↔Bot 交换、btw、learning 等内部 turn，`compaction`/`context` 节点被刻意隐藏（index.js:1270-1274）。
- DSH 自身有 4 档消息粒度：`transcriptView: compact / standard / detailed / verbose`（dsh-client-ui-chat，`TRANSCRIPT_VIEW_MODES`），配合 `ChatPresentationPolicy`（foldCompletedTurns、stepGrouping、liveProcessDetail、settledReasoningPreview）。
- **"不装 shadow = DSH 原生渲染"这条路今天就在跑**：`surface.js:4-7 groupsFor()` 的 `plain` 模式（打开 DSH 自己的 Agent Session 时）只撤掉 conversation 组的替换、保留 shell。每个 shadow 是独立 step，`surfaceGroups` 可整体装 / 撤并原子回滚（surface.js:86-97）。

### 硬约束

shadow 是整类抢占，`conversation.chat.node` 的 seat 按 priority 只取一个渲染器，没有"低优先级回落到宿主默认"的组合方式；DSH 也未从公共入口导出 AssistantNodeView / ReasoningRow 组件，且没有 per-node 过滤 slot。所以：

- "DSH 默认"只能靠**不装 shadow** 实现，不能在自绘 cell 里调 DSH 组件。
- `isHiddenTurn` 的内部 turn 过滤在撤 shadow 后无处安放：DSH 侧目前没有 per-node 过滤点，内部内容（Bot↔Bot 交换、btw、learning）会泄漏进用户聊天。

### 改法

1. prefs 加 `transcript: 'minimal' | 'dsh'`（默认 minimal）：host 端 `channel.js setPrefs()`（:197-246，照抄现有字段模式）+ client 端 `themes.js:130` 读取器 + `settings.js:151` 旁一行设置项。不复用 DSH 的 `ui-chat.transcriptView`（那是 DSH 设置页的属，且 ds-bot 只需二值开关；DSH 四档留给 DSH 设置页自己管）。
2. `installConversation()` 按 pref 分支：`dsh` 档不装 `assistant-step` / `tool-call` / `turn-process` / `turn-error` 四个 shadow；其余挂别的 slot 的替换（TurnTailCell 时间分隔、btw/learning 卡、deliverables Save、composer dock）保留。
3. pref 变化时对 conversation 组 `surfaceGroups.remount('conversation')`。

### 内部 turn 泄漏的取舍（待定）

- a) native 档仅对无隐藏 turn 的会话提供；
- b) 保留 `context`/`compaction` 的 CellEmpty shadow（DSH 本来也视为次要行），assistant-step 的隐藏 turn 问题升给 DSH 加 slot；
- c) 接受泄漏。

### 其他退化（native 档可接受或需补偿）

- 群聊：GroupMessage 气泡、事件线、Bot 彩色标识弱化，回到 DSH 普通助手行。
- Bot 专属工具卡（secret / connector / mail / handoff）不再有界面；activity-row 与 DSH 原生过程行可能视觉重叠，native 档或需停用。
- turn-error 回到 DSH 原生失败样式（有 message.failure.* 文案，可接受）。

## 实施顺序与验收

1. **#2 断消息修复**（根因明确、改动最小，先做先验）→ smoke test + IM 手测：bot 内调 subagent 后确认后续回复到达平台。
2. **#1 预设化**（结构改动）→ 新建 Bot / 群走新预设；旧 Session 行为不回退；预设 broken 回退 standard 生效。
3. **#3 卡片配置**（先定上面 a/b/c）→ 设置切换后重挂生效；plain 模式回归不受影响。

每条独立提交；`npm test`、`node scripts/build-client.mjs --check`、`npm run lint` 过；改 `src/host/` 的还需 smoke test。设置项与文档进 locales（en/zh 同步）与 README、docs/design/ui-standard.md。

## 附注：本地 dsh-im 的同类丢消息

本会话即通过 dsh-im 通道投递，同样触发了"汇总消息丢失"（多子代理回合中，最后一条汇总未送达）。dsh-im 是本地 DSH checkout（`plugins/dsh-im/`）里的独立插件，出站管线与 ds-bot 的 im/ 不同，是否同类根因尚未探查完；待本计划确认后单独排查其 turn 触发 / 投递过滤逻辑（重点：由 subagent-settled 触发的回合，其最终回复是否被投递过滤掉）。
