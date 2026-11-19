// Lanes: the plain Sessions a Supervisor Bot dispatches in the workspaces it manages.
// A lane is not a Bot — no team tools, no parts, no groups — but it is not left to dsh
// alone either: this module registers the lane tools on its Agent, routes every turn it
// ends back to its supervisor, and keeps the lane's status for the sidebar. The
// supervisor answers a lane's question in the turn the question opened (delivery's
// reply routing does that), and its reply after a report stays in its own chat for the
// user (the report carries audience "user", so nothing routes back).
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LANE_TITLE_MAX, SOURCE_KIND } from './constants.js'
import { headOf, normalize, textOf } from './text.js'

// A lane dispatched or adopted reads this with its first task; the ds-bot-lane preset
// carries the full protocol (prompt.js).
const LANE_BRIEF = 'You are this task\'s lane: work here in this workspace until it is done. Report with lane_report, ask with lane_ask; your supervisor reads and answers here. Never end a turn on plain text alone.'
const LANE_ADOPT_NOTE = 'From now on you are a supervised lane: end working turns with lane_report, ask with lane_ask; your supervisor reads and answers here. Never end a turn on plain text alone.'
const PLAYBOOK_DESCRIPTION = 'This Supervisor\'s playbook: the user\'s standing instructions for how it supervises. Load it before you answer a lane or report to the user.'
const REPORT_STATUS = ['progress', 'blocked', 'done']
// Tool results are plain strings, like the team tools' (tools.js output).
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function install(rt) {
  const { ctx, state } = rt

  // An answer to a lane's question closes the question the moment it goes out — not
  // when the lane's next turn opens, which would leave the lane shown as asking while
  // the answer already sits in it.
  const baseDeliver = rt.deliver
  rt.deliver = async (args) => {
    const exchangeId = await baseDeliver(args)
    if (args?.role === 'reply' && typeof args.replyTo === 'string') {
      const lane = Object.values(state.lanes).find(candidate => candidate.ask?.exchangeId === args.replyTo)
      if (lane !== undefined) {
        delete lane.ask
        lane.reminders = 0
        if (lane.status === 'asking') lane.status = 'working'
        void rt.save().catch(() => {})
      }
    }
    return exchangeId
  }

  const laneOf = id => (id === undefined ? undefined : rt.own(state.lanes, id))
  const lanesOf = spBotId => Object.values(state.lanes).filter(lane => lane.spBotId === spBotId)

  // The Supervisor a tool call comes from, or undefined when the caller is not one.
  const supervisorOf = exec => {
    const bot = rt.botOf(rt.selfOf(exec.agent?.id))
    return bot?.kind === 'supervisor' ? bot : undefined
  }

  const cleanAlias = (alias) => {
    const clean = String(alias ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
    if (clean === '') throw new Error('Give the workspace an alias')
    return clean
  }

  const managedOf = bot => bot.managed ?? []
  // A workspace ref is its alias, or its path as it was added.
  const findManaged = (bot, ref) => {
    const wanted = String(ref ?? '').trim().replace(/^@/, '')
    if (wanted === '') return undefined
    const managed = managedOf(bot)
    return managed.find(entry => normalize(entry.alias) === normalize(wanted))
      ?? managed.find(entry => entry.path === wanted)
  }

  const under = (path, root) => {
    const inner = resolve(path)
    const outer = resolve(root)
    return inner === outer || inner.startsWith(outer + sep)
  }

  // Adds a workspace to a Supervisor's management and registers it as a DSH workspace,
  // so lanes dispatched there join the user's own project session list.
  async function addManaged(bot, { path, alias } = {}) {
    const raw = String(path ?? '').trim()
    if (raw === '') throw new Error('Give the folder to manage')
    if (!isAbsolute(raw)) throw new Error('Give the folder as a full path')
    if (!await rt.isFolder(raw)) throw new Error(`Not a folder I can reach: ${raw}`)
    const canonical = resolve(raw)
    const name = cleanAlias(alias)
    const managed = bot.managed ??= []
    if (managed.some(entry => normalize(entry.alias) === normalize(name))) throw new Error(`Already managing a workspace called "${name}"`)
    const same = managed.find(entry => entry.path === canonical)
    if (same !== undefined) throw new Error(`That folder is already managed as "${same.alias}"`)
    const workspace = await ctx.workspaceRegistry.resolveByPath(canonical) ?? await ctx.workspaceRegistry.create(canonical, name)
    managed.push({ path: canonical, alias: name })
    await rt.save()
    return workspace
  }

  // The lanes of a removed workspace stay supervised — only the address goes.
  function removeManaged(bot, ref) {
    const entry = findManaged(bot, ref)
    if (entry === undefined) throw new Error(`No managed workspace matches "${ref ?? ''}"`)
    bot.managed = managedOf(bot).filter(other => other !== entry)
    if (bot.managed.length === 0) delete bot.managed
    return entry
  }

  // The lane preset is this plugin's own; a broken one falls back to standard, like a
  // Bot's does (roster.js botPreset).
  async function lanePreset() {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined) return {}
    const list = await presets.list()
    const usable = id => list.some(preset => preset.id === id && preset.broken === undefined)
    return usable('ds-bot-lane') ? { agentPreset: 'ds-bot-lane' } : usable('standard') ? { agentPreset: 'standard' } : {}
  }

  // Lanes work with changes inside their workspace, so they take the preset of that
  // level when DSH serves one; everything wider still asks the user.
  const lanePermission = () => {
    const catalog = rt.permissionCatalog?.()
    if (catalog === undefined) return undefined
    return (catalog.options ?? []).find(option => /workspace/i.test(String(option?.value ?? '')))?.value
  }

  async function applyLanePermission(sessionId) {
    const wanted = lanePermission()
    if (wanted === undefined) return undefined
    return rt.setPreset(sessionId, wanted)
      .catch(error => rt.warn('ds-bot: the lane permission for %s was not applied: %s', sessionId, error))
  }

  const headLine = (text) => {
    const line = String(text).split('\n').map(part => part.trim()).find(part => part !== '') ?? 'Lane task'
    return line.slice(0, LANE_TITLE_MAX)
  }

  const laneName = lane => `${lane.alias} · ${lane.title}`

  async function createLaneSession(title, entry) {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const known = await ctx.workspaceRegistry.resolveByPath(entry.path)
    const place = known !== undefined ? { workspaceId: known.id } : { cwd: entry.path }
    const { sessionId } = await ctx.sessionController.create({ ...place, ...await lanePreset() })
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent.session, String(title).slice(0, LANE_TITLE_MAX))
    return sessionId
  }

  // The lane tools join the Agent's own scope (never the global layer), like the team
  // tools do for Bots; agent/created re-scopes a lane whose Agent comes back.
  const laneScopes = new Map()
  const scopeLane = (agent) => {
    const id = agent?.session?.id
    if (id === undefined || typeof agent.ctx?.tools?.register !== 'function') return
    if (laneOf(id) === undefined || laneScopes.has(id)) return
    const disposers = []
    for (const def of LANE_TOOLS) {
      try {
        const dispose = agent.ctx.tools.register(def)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        if (!/already registered/i.test(String(error?.message ?? error))) rt.warn('ds-bot: lane tool %s not added to %s: %s', def.name, id, error)
      }
    }
    laneScopes.set(id, disposers)
  }
  const unscopeLane = (id) => {
    for (const dispose of laneScopes.get(id) ?? []) {
      try { dispose() } catch (error) { rt.warn('ds-bot: a lane tool of %s was not removed: %s', id, error) }
    }
    laneScopes.delete(id)
  }
  ctx.effect(() => () => { for (const id of [...laneScopes.keys()]) unscopeLane(id) }, 'ds-bot: scoped lane tools')

  // A Supervisor's instructions ride as a skill on every session it speaks from, so
  // the system prompt stays a pointer (prompt.js). Keyed by the instructions' hash, so
  // an update re-mounts and anything else does not.
  const playbooks = new Map()
  const dropPlaybook = (sessionId) => {
    const held = playbooks.get(sessionId)
    if (held === undefined) return
    playbooks.delete(sessionId)
    try { held.fiber.dispose() } catch { /* an Agent going away disposes its own */ }
  }
  const mountPlaybook = (agent) => {
    const sessionId = agent?.session?.id
    if (sessionId === undefined || typeof agent.ctx?.plugin !== 'function') return
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (bot?.kind !== 'supervisor' || bot.instructions === '') {
      dropPlaybook(sessionId)
      return
    }
    const key = createHash('sha256').update(bot.instructions).digest('hex')
    if (playbooks.get(sessionId)?.key === key) return
    dropPlaybook(sessionId)
    const fiber = agent.ctx.plugin({
      name: 'ds-bot-supervisor-playbook',
      inject: ['skills'],
      apply(c) {
        const instructions = rt.botOf(rt.selfOf(sessionId))?.instructions ?? ''
        c.effect(() => c.skills.register({ name: 'supervisor-playbook', description: PLAYBOOK_DESCRIPTION, source: 'runtime', content: instructions }))
      },
    })
    playbooks.set(sessionId, { key, fiber })
    void fiber.await?.().catch(error => rt.warn('ds-bot: the playbook skill for %s did not mount: %s', sessionId, error))
  }
  // The user's instruction change reaches the sessions the supervisor speaks from now.
  const refreshPlaybook = async (botId) => {
    const bot = rt.botOf(botId)
    if (bot?.kind !== 'supervisor') return
    const sessionIds = [rt.chatOf(botId), ...(bot.openParts ?? []).map(part => part.sessionId), ...rt.groupSessionsOf(botId)]
      .filter((sessionId, index, list) => sessionId !== undefined && list.indexOf(sessionId) === index)
    for (const sessionId of sessionIds) {
      try { mountPlaybook(await rt.resolveAgent(sessionId)) } catch (error) { rt.warn('ds-bot: the playbook for %s was not refreshed on %s: %s', bot.name, sessionId, error) }
    }
  }

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      const sessionId = agent?.session?.id
      if (sessionId === undefined) return
      if (laneOf(sessionId) !== undefined) scopeLane(agent)
      else mountPlaybook(agent)
    } catch (error) {
      rt.warn('ds-bot: lane/playbook scoping for a new Agent failed: %s', error)
    }
  })

  const splitRef = (ref) => {
    const at = ref.indexOf('/')
    return at <= 0 ? { provider: ref, model: ref } : { provider: ref.slice(0, at), model: ref.slice(at + 1) }
  }

  // A Supervisor starts a lane: a fresh plain Session in the workspace, on this
  // plugin's lane preset, with the task as its first message.
  async function dispatchLane(spBot, { workspace, task, title, model, effort } = {}) {
    const entry = findManaged(spBot, workspace)
    if (entry === undefined) throw new Error(`You manage no workspace matching "${workspace ?? ''}". list_lanes shows the aliases you manage.`)
    const cleanTask = String(task ?? '').trim()
    if (cleanTask === '') throw new Error('Write the task the lane should do')
    const modelRef = model === undefined || model === null || model === '' ? undefined : await rt.resolveModel(model)
    if (modelRef === undefined && model !== undefined && model !== null && model !== '') throw new Error(`No model matches "${model}"`)
    if (modelRef === undefined && effort !== undefined && effort !== '') throw new Error('Pick a model before choosing a thinking level')
    const effortId = modelRef === undefined || effort === undefined || effort === '' ? undefined : await rt.resolveEffort(modelRef, effort)
    const laneTitle = String(title ?? '').trim() || headLine(cleanTask)
    const id = await createLaneSession(laneTitle, entry)
    try {
      state.lanes[id] = {
        id,
        spBotId: spBot.id,
        workspacePath: entry.path,
        alias: entry.alias,
        title: laneTitle.slice(0, LANE_TITLE_MAX),
        status: 'working',
        task: headOf(cleanTask, 400),
        createdAt: Date.now(),
      }
      await rt.save()
      if (modelRef !== undefined) {
        await rt.selectSessionModel(id, { ...splitRef(modelRef), ...(effortId === undefined ? {} : { reasoningEffort: effortId }) })
          .catch(error => rt.warn('ds-bot: the model for lane %s was not applied: %s', id, error))
      }
      await applyLanePermission(id)
      scopeLane(await rt.resolveAgent(id))
      const exchangeId = await rt.deliver({ fromId: spBot.id, toId: id, text: `${cleanTask}\n\n${LANE_BRIEF}`, role: 'lane-task' })
      return { lane: state.lanes[id], exchangeId }
    } catch (error) {
      // The Session was already made: archive it instead of leaving an orphan.
      unscopeLane(id)
      delete state.lanes[id]
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the failed lane for %s failed: %s', laneTitle, archiveError))
      throw error
    }
  }

  // A Session the user already has in a managed workspace becomes a lane. It keeps its
  // history; the protocol note tells it how it is supervised from now.
  async function adoptLane(spBot, { workspace, session } = {}) {
    const entry = findManaged(spBot, workspace)
    if (entry === undefined) throw new Error(`You manage no workspace matching "${workspace ?? ''}". list_lanes shows the aliases you manage.`)
    const sessionId = String(session ?? '').trim()
    if (sessionId === '') throw new Error('Name the session to adopt by its session id')
    const owned = rt.selfOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined
      || rt.roomOf(sessionId) !== undefined || rt.agentOf?.(sessionId) !== undefined
    if (owned) throw new Error('That session already belongs to the team')
    if (laneOf(sessionId) !== undefined) throw new Error('That session is already a lane')
    await rt.resolveAgent(sessionId)
    const listed = await ctx.sessionController.list({}, AbortSignal.timeout(20_000))
    const item = listed.items?.find(candidate => candidate.sessionId === sessionId)
    if (item === undefined) throw new Error('That session is not visible here')
    if (item.cwd === undefined || !under(item.cwd, entry.path)) throw new Error(`That session does not live in "${entry.alias}" (${entry.path})`)
    const agent = await rt.resolveAgent(sessionId)
    state.lanes[sessionId] = {
      id: sessionId,
      spBotId: spBot.id,
      workspacePath: entry.path,
      alias: entry.alias,
      title: headLine((await laneTitleOf(agent)) ?? 'Adopted lane'),
      status: 'idle',
      adopted: true,
      createdAt: Date.now(),
    }
    await rt.save()
    await applyLanePermission(sessionId)
    scopeLane(agent)
    await rt.deliver({ fromId: spBot.id, toId: sessionId, text: LANE_ADOPT_NOTE, role: 'lane-note' })
    return state.lanes[sessionId]
  }

  // The session title service names a lane's session; a read failure keeps a plain one.
  async function laneTitleOf(agent) {
    try {
      const snapshot = ctx.sessionTitle.get?.(agent.session)
      const shown = typeof snapshot?.title === 'string' ? snapshot.title : undefined
      return shown !== undefined && shown.trim() !== '' ? shown.trim() : undefined
    } catch {
      return undefined
    }
  }

  // A Supervisor lets a lane go: its record and tools go, its Session stays in the
  // workspace. Also runs when the supervisor itself is deleted (roster.js).
  function releaseLane(laneId) {
    const lane = laneOf(laneId)
    if (lane === undefined) return
    unscopeLane(laneId)
    dropPlaybook(laneId)
    delete state.lanes[laneId]
  }
  const releaseLanesOf = (botId) => {
    for (const lane of lanesOf(botId)) releaseLane(lane.id)
    void rt.save().catch(() => {})
  }

  const findLane = (spBot, ref) => {
    const wanted = String(ref ?? '').trim()
    if (wanted === '') return undefined
    return lanesOf(spBot.id).find(lane => lane.id === wanted)
      ?? lanesOf(spBot.id).find(lane => normalize(lane.title) === normalize(wanted.replace(/^@/, '')))
  }

  // The lane tools, on a lane's own Agent scope only. `exec.concludeTurn` ends the
  // turn like ask_user does, so the question or report is the turn's last word.
  const LANE_TOOLS = [
    defineTool({
      name: 'lane_ask',
      description: 'Ask your supervisor a question. Calling it ends your turn; the answer arrives as your next message. Use it when the task, a decision it needs, or a fact you cannot find out blocks you.',
      parameters: {
        question: { type: 'string', required: true, description: 'One short question' },
        context: { type: 'string', description: 'What you tried, and the options you see' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const lane = laneOf(exec.agent?.id)
        if (lane === undefined) return 'Only lanes can use lane_ask.'
        if (lane.ask !== undefined) return 'Your earlier question is still waiting for an answer; wait for it before asking again.'
        const question = String(args.question ?? '').trim()
        if (question === '') return 'Write the question.'
        const spBot = rt.botOf(lane.spBotId)
        if (spBot === undefined) return 'Your supervisor is gone; no one answers here. End your turn and wait.'
        const context = String(args.context ?? '').trim()
        lane.ask = { question, askedAt: Date.now() }
        const before = lane.status
        lane.status = 'asking'
        await rt.save()
        try {
          const exchangeId = await rt.deliver({
            fromId: lane.id,
            fromName: laneName(lane),
            toId: spBot.id,
            text: `[Question] ${question}${context === '' ? '' : `\n${context}`}`,
            role: 'request',
          })
          lane.ask.exchangeId = exchangeId
          await rt.save()
        } catch (error) {
          lane.ask = undefined
          lane.status = before
          await rt.save()
          throw error
        }
        exec.concludeTurn?.()
        return `Your question is with ${spBot.name}; the answer arrives as your next message.`
      },
    }),
    defineTool({
      name: 'lane_report',
      description: 'Report to your supervisor. Calling it ends your turn. End every working turn with it: "progress" with what changed since your last report, "blocked" with what blocks you and what you tried, or "done" with the result and the evidence the task asked for.',
      parameters: {
        status: { type: 'string', required: true, enum: REPORT_STATUS, description: '"progress", "blocked", or "done"' },
        note: { type: 'string', required: true, description: 'What happened: facts and evidence, not intentions' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const lane = laneOf(exec.agent?.id)
        if (lane === undefined) return 'Only lanes can use lane_report.'
        if (!REPORT_STATUS.includes(args.status)) return `status must be one of ${REPORT_STATUS.join(', ')}.`
        const note = String(args.note ?? '').trim()
        if (note === '') return 'Write what happened.'
        const spBot = rt.botOf(lane.spBotId)
        if (spBot === undefined) return 'Your supervisor is gone; there is no one to report to.'
        // A progress report leaves the lane working; blocked and done stand on their own.
        lane.status = args.status === 'done' ? 'done' : args.status === 'blocked' ? 'blocked' : 'working'
        lane.report = { status: args.status, note: headOf(note, 400), at: Date.now() }
        await rt.save()
        await rt.deliver({
          fromId: lane.id,
          fromName: laneName(lane),
          toId: spBot.id,
          text: `[Report · ${args.status}] ${note}`,
          role: 'lane-report',
          audience: 'user',
        })
        exec.concludeTurn?.()
        return args.status === 'done'
          ? 'Report sent; your supervisor judges it from here.'
          : 'Report sent; your supervisor reads it and will send you on.'
      },
    }),
  ]

  // Routing. turns.js skips lanes (they are no Bot's session), so this listener owns
  // them: it keeps the per-turn text and sends what a turn ends with back to the
  // supervisor. A turn that ended through lane_ask or lane_report is already delivered
  // by the tool; a plain-text ending reports as "unreported" so the supervisor sees a
  // stalled lane instead of silence.
  const laneTurns = new Map()
  const laneEvent = (lane, id, event) => {
    switch (event.type) {
      case 'turn/start':
        laneTurns.set(id, { texts: [], reported: false })
        break
      case 'user/message': {
        const source = event.data?.source
        if (source?.kind !== SOURCE_KIND) break
        if (source.role === 'reply' && lane.ask !== undefined) {
          // The supervisor's answer reached the lane.
          delete lane.ask
          lane.reminders = 0
        }
        if (['reply', 'lane-task', 'lane-note'].includes(source.role) && lane.status !== 'working') lane.status = 'working'
        void rt.save().catch(() => {})
        break
      }
      case 'assistant/message': {
        const entry = laneTurns.get(id)
        if (entry !== undefined) {
          const text = textOf(event.data?.message?.content)
          if (text !== '') entry.texts.push(text)
        }
        break
      }
      case 'tool/call':
        if (['lane_ask', 'lane_report'].includes(event.data?.name)) {
          const entry = laneTurns.get(id)
          if (entry !== undefined) entry.reported = true
        }
        break
      case 'turn/end': {
        const entry = laneTurns.get(id)
        laneTurns.delete(id)
        // stop_lane told the story already; a steered turn continues under its next end.
        if (lane.status === 'stopped' || entry === undefined) break
        const reason = event.data?.reason
        const spBot = rt.botOf(lane.spBotId)
        if (spBot === undefined) break
        if (reason?.kind === 'error') {
          lane.status = 'idle'
          void rt.save().catch(() => {})
          void rt.deliver({
            fromId: id, fromName: laneName(lane), toId: spBot.id,
            role: 'lane-report', audience: 'user',
            text: '[Report · blocked] This lane\'s turn failed; it waits for your next message.',
          }).catch(error => rt.warn('ds-bot: lane failure report not delivered: %s', error))
          break
        }
        if (reason?.kind === 'aborted') break
        if (entry.reported === true) break
        const text = entry.texts.join('\n\n').trim()
        if (text === '') break
        lane.status = 'idle'
        void rt.save().catch(() => {})
        const prefix = reason?.kind === 'max-tokens' ? '[Report · cut off]' : '[Report · unreported]'
        void rt.deliver({
          fromId: id, fromName: laneName(lane), toId: spBot.id,
          role: 'lane-report', audience: 'user',
          text: `${prefix} ${text}`,
        }).catch(error => rt.warn('ds-bot: lane report not delivered: %s', error))
        break
      }
    }
  }

  // A supervisor whose turn was opened by a lane question owes the lane an answer in
  // that turn. delivery routes it when the turn says something; if it ends with none
  // (an ask_user card, an empty reply), the lane would sit waiting, so the question is
  // put back once, capped, until an answer goes out.
  const watchAsks = new Map()
  const supervisorEvent = (id, event) => {
    switch (event.type) {
      case 'user/message': {
        const source = event.data?.source
        if (source?.kind === SOURCE_KIND && source.role === 'request') {
          const lane = Object.values(state.lanes).find(candidate => candidate.spBotId === rt.selfOf(id) && candidate.ask?.exchangeId === source.exchangeId)
          if (lane !== undefined) watchAsks.set(id, lane.id)
        }
        break
      }
      case 'turn/end': {
        const laneId = watchAsks.get(id)
        watchAsks.delete(id)
        if (laneId === undefined || event.data?.reason?.kind !== 'completed') break
        const lane = laneOf(laneId)
        if (lane === undefined || lane.ask === undefined || (lane.reminders ?? 0) >= 3) break
        lane.reminders = (lane.reminders ?? 0) + 1
        void rt.save().catch(() => {})
        void rt.deliver({
          fromId: laneId, fromName: laneName(lane), toId: lane.spBotId,
          role: 'request',
          text: `[Question still open] ${lane.ask.question}\nYour last turn ended without an answer reaching the lane. Answer this message; the reply goes to the lane.`,
        }).catch(error => rt.warn('ds-bot: the open-question reminder was not delivered: %s', error))
        break
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    const lane = laneOf(id)
    if (lane !== undefined) return laneEvent(lane, id, event)
    if (rt.isBotSession(id)) supervisorEvent(id, event)
  })

  // ---- The Supervisor's own tools. Registered on every Bot session like the rest of
  // the team tools; each one refuses a caller that is not a Supervisor.

  const supervisorRefusal = 'Only a Supervisor Bot manages lanes.'

  rt.teamTools.push(defineTool({
    name: 'dispatch_lane',
    description: 'Start a lane: a fresh session in one of your managed workspaces, with a task it carries out and reports on. It reports and asks here; do not wait for it.',
    parameters: {
      workspace: { type: 'string', required: true, description: 'The alias (or path) of one of your managed workspaces' },
      task: { type: 'string', required: true, description: 'What the lane should find out or change, with the constraints it holds and the evidence its report must show' },
      title: { type: 'string', description: 'Short session title; defaults to the task\'s first line' },
      model: { type: 'string', description: 'A provider/model ref for the lane; defaults to the profile default' },
      effort: { type: 'string', description: 'A thinking level for the lane; needs model' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const spBot = supervisorOf(exec)
      if (spBot === undefined) return supervisorRefusal
      try {
        const { lane } = await dispatchLane(spBot, args)
        return `Lane "${lane.title}" started in "${lane.alias}". It reports here when it has something; do not wait or poll.`
      } catch (error) {
        return `Could not start the lane: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'adopt_lane',
    description: 'Make an existing session in one of your managed workspaces a lane of yours, so it reports and asks here from now on. Name it by its session id.',
    parameters: {
      workspace: { type: 'string', required: true, description: 'The alias (or path) of the managed workspace the session lives in' },
      session: { type: 'string', required: true, description: 'The session id of the session to adopt' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const spBot = supervisorOf(exec)
      if (spBot === undefined) return supervisorRefusal
      try {
        const lane = await adoptLane(spBot, args)
        return `Session "${lane.title}" is now your lane in "${lane.alias}". It reports here from now on.`
      } catch (error) {
        return `Could not adopt the session: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'message_lane',
    description: 'Send a lane a message: what to do next, a decision it asked for, or a correction. If it is working, it reads your message at its next step; otherwise it waits for its next turn. It answers once its work is done.',
    parameters: {
      lane: { type: 'string', required: true, description: 'The lane\'s session id or title' },
      message: { type: 'string', required: true, description: 'What the lane should do or know' },
      when: { type: 'string', enum: ['now', 'queue'], description: '"now" cuts into a working lane at its next step (the default); "queue" waits until its current work is done' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const spBot = supervisorOf(exec)
      if (spBot === undefined) return supervisorRefusal
      try {
        const lane = findLane(spBot, args.lane)
        if (lane === undefined) return `You have no lane matching "${args.lane ?? ''}". list_lanes shows your lanes.`
        const text = String(args.message ?? '').trim()
        if (text === '') return 'Write the message.'
        const busy = rt.live?.get(lane.id)?.turn !== undefined
        const exchangeId = await rt.deliver({
          fromId: spBot.id, toId: lane.id, text, role: 'lane-note',
          steer: busy && args.when !== 'queue',
        })
        return busy && args.when !== 'queue'
          ? 'Sent; it reads your message at its next step and answers when the work is done. Do not wait or poll.'
          : `Sent to "${lane.title}"; it answers when the work is done. Do not wait or poll. (exchange ${exchangeId})`
      } catch (error) {
        return `Could not message the lane: ${error.message}`
      }
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'list_lanes',
    description: 'List your managed workspaces and every lane you have running there, with where each stands. Call it when you need the current picture; do not rely on memory.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const spBot = supervisorOf(exec)
      if (spBot === undefined) return supervisorRefusal
      const managed = managedOf(spBot)
      const lines = managed.map(entry => `- workspace "${entry.alias}": ${entry.path}`)
      for (const lane of lanesOf(spBot.id)) {
        const standing = lane.ask !== undefined ? `${lane.status} — your answer to "${headOf(lane.ask.question, 80)}" is due` : lane.status
        lines.push(`- lane "${lane.title}" in "${lane.alias}" — ${standing}${lane.report?.status !== undefined ? ` (last report ${lane.report.status})` : ''}`)
      }
      return lines.length > 0 ? lines.join('\n') : 'You manage no workspaces yet, and you have no lanes. The user adds workspaces to your management in your settings.'
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'stop_lane',
    description: 'End a lane\'s turn at once and tell it why. Use it when a lane must not finish what it is doing, or when its work should stop.',
    parameters: {
      lane: { type: 'string', required: true, description: 'The lane\'s session id or title' },
      reason: { type: 'string', description: 'Why it must stop' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const spBot = supervisorOf(exec)
      if (spBot === undefined) return supervisorRefusal
      try {
        const lane = findLane(spBot, args.lane)
        if (lane === undefined) return `You have no lane matching "${args.lane ?? ''}". list_lanes shows your lanes.`
        const agent = await rt.resolveAgent(lane.id).catch(() => undefined)
        if (agent !== undefined) agent.cancel({ kind: 'user' })
        delete lane.ask
        lane.reminders = 0
        lane.status = 'stopped'
        await rt.save()
        const reason = String(args.reason ?? '').trim()
        await rt.deliver({ fromId: spBot.id, toId: lane.id, text: reason === '' ? 'Stop here.' : `Stop here: ${reason}`, role: 'lane-note' })
          .catch(error => rt.warn('ds-bot: the stop note for lane %s was not delivered: %s', lane.id, error))
        return `"${lane.title}" was stopped; it answers your message when it next runs.`
      } catch (error) {
        return `Could not stop the lane: ${error.message}`
      }
    },
  }))

  // A lane the user sends a message to from the client. Same core as the tool, minus
  // the supervisor check.
  async function userMessageLane({ laneId, message }) {
    const lane = laneOf(laneId)
    if (lane === undefined) throw new Error('Unknown lane')
    const spBot = rt.botOf(lane.spBotId)
    if (spBot === undefined) throw new Error('The lane\'s supervisor is gone')
    const text = String(message ?? '').trim()
    if (text === '') throw new Error('Write the message')
    const busy = rt.live?.get(lane.id)?.turn !== undefined
    await rt.deliver({ fromId: spBot.id, toId: lane.id, text: `${text}\n\n[A note from the user, passed by your supervisor.]`, role: 'lane-note', steer: busy })
    return true
  }

  async function userStopLane({ laneId }) {
    const lane = laneOf(laneId)
    if (lane === undefined) throw new Error('Unknown lane')
    const agent = await rt.resolveAgent(lane.id).catch(() => undefined)
    if (agent !== undefined) agent.cancel({ kind: 'user' })
    delete lane.ask
    lane.reminders = 0
    lane.status = 'stopped'
    await rt.save()
    return true
  }

  Object.assign(rt, {
    laneOf, lanesOf, supervisorOf, addManaged, removeManaged, findManaged,
    dispatchLane, adoptLane, releaseLane, releaseLanesOf, refreshPlaybook,
    userMessageLane, userStopLane,
  })
}
