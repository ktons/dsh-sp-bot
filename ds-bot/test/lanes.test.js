import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const textOf = content => content.map(block => block.text ?? '').join('\n')

let rt

// A team of one Main Bot and one Supervisor with a managed workspace. Services are
// the same stand-ins bot-messages.test.js uses: agents record their deliveries.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-lanes-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const scopedTools = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => [] },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() { return false } },
        ctx: { tools: { register(def) { scopedTools.set(def.name, def); return () => {} } } },
      })
    }
    return agents.get(sessionId)
  }
  let nextSession = 0
  const created = []
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async path => ({ id: 'w1', path }),
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async request => {
        const sessionId = `lane-${++nextSession}`
        created.push({ sessionId, request })
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      list: async () => ({ items: [{ sessionId: 'u1', cwd: '/proj' }] }),
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {}, get: () => ({ title: 'Picked title' }) },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => {
    const def = rt.teamTools.find(d => d.name === name) ?? scopedTools.get(name)
    return def.execute(args, { agent: { id: sessionId } })
  }
  // A lane turn's report is delivered fire-and-forget; let the delivery settle.
  const flush = () => delay(5)
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, emit, tool, created, scopedTools, flush, stop }
}

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    sp: { id: 'sp', name: 'Foreman', role: 'Watch', kind: 'supervisor', sessionId: 'sp', createdAt: 2, managed: [{ path: '/proj', alias: 'web' }] },
  },
  rooms: {},
  agents: {},
  lanes: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

const lastCall = (agent) => agent.calls.at(-1)

test('a Supervisor dispatches a lane into its managed workspace, and only it can', async (t) => {
  const { rt, agents, tool, created, stop } = await start(team())
  t.after(stop)

  assert.match(await tool('dispatch_lane', { workspace: 'nope', task: 'x' }, 'sp'), /manage no workspace/)
  assert.equal(await tool('dispatch_lane', { workspace: 'web', task: 'x' }, 'a'), 'Only a Supervisor Bot manages lanes.')

  const said = await tool('dispatch_lane', { workspace: 'web', task: 'Refactor the store module', title: 'refactor' }, 'sp')
  assert.match(said, /Lane "refactor" started in "web"/)
  const lane = rt.laneOf('lane-1')
  assert.equal(lane.status, 'working')
  assert.equal(lane.alias, 'web')
  assert.equal(lane.spBotId, 'sp')
  assert.deepEqual(created, [{ sessionId: 'lane-1', request: { workspaceId: 'w1' } }])
  // The task arrives as the lane's first message, headed as coming from the supervisor.
  const kickoff = lastCall(agents.get('lane-1'))
  assert.equal(kickoff[0], 'followup')
  assert.equal(kickoff[1].source.role, 'lane-task')
  assert.match(textOf(kickoff[1].content), /^\[Task from Foreman\]/)
  assert.match(textOf(kickoff[1].content), /Refactor the store module/)
  assert.match(textOf(kickoff[1].content), /lane_report/)

  const listed = await tool('list_lanes', {}, 'sp')
  assert.match(listed, /workspace "web": \/proj/)
  assert.match(listed, /lane "refactor" in "web" — working/)
})

test('a lane question reaches the supervisor, whose reply is routed back as the answer', async (t) => {
  const { rt, agents, emit, tool, flush, stop } = await start(team())
  t.after(stop)
  await tool('dispatch_lane', { workspace: 'web', task: 'Refactor the store module' }, 'sp')

  const said = await tool('lane_ask', { question: 'Which store version?', context: 'v1 or v2' }, 'lane-1')
  assert.match(said, /question is with Foreman/)
  const lane = rt.laneOf('lane-1')
  assert.equal(lane.status, 'asking')
  assert.equal(lane.ask.question, 'Which store version?')
  const question = lastCall(agents.get('sp'))
  assert.equal(question[0], 'followup')
  assert.equal(question[1].source.kind, SOURCE_KIND)
  assert.equal(question[1].source.role, 'request')
  assert.equal(question[1].source.senderSessionId, 'lane-1')
  assert.equal(question[1].source.senderName, 'web · Refactor the store module')
  assert.match(textOf(question[1].content), /^\[Message from web · Refactor the store module\]/)
  assert.match(textOf(question[1].content), /\[Question\] Which store version\?/)
  // A second ask while one waits is refused.
  assert.match(await tool('lane_ask', { question: 'Again?' }, 'lane-1'), /still waiting/)

  // The supervisor answers in the turn the question opened; delivery routes the
  // reply back to the lane, and the lane's open ask closes.
  emit('sp', 'user/message', { content: [{ type: 'text', text: '[Message from web · Refactor the store module]\nWhich store version?' }], source: question[1].source })
  emit('sp', 'turn/start', { turn: 1 })
  emit('sp', 'assistant/message', { message: { content: [{ type: 'text', text: 'Use store v2 and carry on.' }] } })
  emit('sp', 'turn/end', { reason: { kind: 'completed' } })
  await flush()
  const answer = lastCall(agents.get('lane-1'))
  assert.equal(answer[0], 'followup')
  assert.equal(answer[1].source.role, 'reply')
  assert.equal(answer[1].source.senderSessionId, 'sp')
  assert.match(textOf(answer[1].content), /^\[Reply from Foreman\]/)
  assert.match(textOf(answer[1].content), /Use store v2/)
  assert.equal(lane.ask, undefined)
  assert.equal(lane.status, 'working')
})

test('a lane report stands for the user, and a question left unanswered is put back', async (t) => {
  const { rt, agents, emit, tool, flush, stop } = await start(team())
  t.after(stop)
  await tool('dispatch_lane', { workspace: 'web', task: 'Refactor the store module' }, 'sp')

  await tool('lane_report', { status: 'done', note: 'Store refactored; tests pass.' }, 'lane-1')
  const report = lastCall(agents.get('sp'))
  assert.equal(report[1].source.role, 'lane-report')
  assert.equal(report[1].source.audience, 'user')
  assert.equal(report[1].source.senderName, 'web · Refactor the store module')
  assert.match(textOf(report[1].content), /\[Report · done\] Store refactored/)
  assert.equal(rt.laneOf('lane-1').status, 'done')

  // A turn the supervisor ends without an answer leaves the lane's question open:
  // the question is delivered again, capped, so the lane does not sit forever.
  await tool('lane_ask', { question: 'Keep the old export?' }, 'lane-1')
  const question = lastCall(agents.get('sp'))
  emit('sp', 'user/message', { content: [{ type: 'text', text: '[Message from web · Refactor the store module]\nKeep the old export?' }], source: question[1].source })
  emit('sp', 'turn/start', { turn: 1 })
  emit('sp', 'turn/end', { reason: { kind: 'completed' } })
  await flush()
  const reminder = lastCall(agents.get('sp'))
  assert.equal(reminder[1].source.role, 'request')
  assert.equal(reminder[1].source.senderSessionId, 'lane-1')
  assert.match(textOf(reminder[1].content), /\[Question still open\] Keep the old export\?/)
  assert.equal(rt.laneOf('lane-1').reminders, 1)
})

test('a lane turn that ends on plain text reports as unreported', async (t) => {
  const { rt, agents, emit, tool, flush, stop } = await start(team())
  t.after(stop)
  await tool('dispatch_lane', { workspace: 'web', task: 'Refactor the store module' }, 'sp')

  emit('lane-1', 'user/message', { content: [{ type: 'text', text: 'task' }], source: { kind: SOURCE_KIND, role: 'lane-task' } })
  emit('lane-1', 'turn/start', { turn: 1 })
  emit('lane-1', 'assistant/message', { message: { content: [{ type: 'text', text: 'Halfway through the refactor.' }] } })
  emit('lane-1', 'turn/end', { reason: { kind: 'completed' } })
  await flush()
  const report = lastCall(agents.get('sp'))
  assert.equal(report[1].source.role, 'lane-report')
  assert.equal(report[1].source.audience, 'user')
  assert.match(textOf(report[1].content), /\[Report · unreported\] Halfway through the refactor\./)
  assert.equal(rt.laneOf('lane-1').status, 'idle')
})

test('stop_lane cancels the lane and clears its open question', async (t) => {
  const { rt, agents, tool, stop } = await start(team())
  t.after(stop)
  await tool('dispatch_lane', { workspace: 'web', task: 'Refactor the store module' }, 'sp')
  await tool('lane_ask', { question: 'Which store version?' }, 'lane-1')

  const said = await tool('stop_lane', { lane: 'lane-1', reason: 'wrong approach' }, 'sp')
  assert.match(said, /was stopped/)
  const lane = rt.laneOf('lane-1')
  assert.equal(lane.status, 'stopped')
  assert.equal(lane.ask, undefined)
  // The turn is cancelled; the stop note follows it as the lane's next message.
  const kinds = agents.get('lane-1').calls.map(([kind]) => kind)
  assert.ok(kinds.includes('cancel'))
  assert.equal(kinds.at(-1), 'followup')
  assert.equal(agents.get('lane-1').calls.at(-1)[1].source.role, 'lane-note')
})

test('adopting refuses sessions that are not free, and takes one in the workspace', async (t) => {
  const { rt, agents, tool, stop } = await start(team())
  t.after(stop)

  // A Bot's own session is the team's, whatever id it carries.
  assert.match(await tool('adopt_lane', { workspace: 'web', session: 'a' }, 'sp'), /already belongs to the team/)
  assert.match(await tool('adopt_lane', { workspace: 'web', session: 'elsewhere' }, 'sp'), /not visible here/)

  const said = await tool('adopt_lane', { workspace: 'web', session: 'u1' }, 'sp')
  assert.match(said, /is now your lane in "web"/)
  const lane = rt.laneOf('u1')
  assert.equal(lane.adopted, true)
  assert.equal(lane.title, 'Picked title')
  // The protocol note tells the adopted session how it is supervised from now.
  const note = lastCall(agents.get('u1'))
  assert.equal(note[1].source.role, 'lane-note')
  assert.match(textOf(note[1].content), /supervised lane/)
})

test('a lane of a supervisor that is gone, or a bad status, is dropped by the store', async (t) => {
  const seed = team()
  seed.lanes = {
    keep: { id: 'keep', spBotId: 'sp', workspacePath: '/proj', alias: 'web', title: 'kept', status: 'asking', ask: { question: 'q' }, createdAt: 3 },
    orphan: { id: 'orphan', spBotId: 'a', workspacePath: '/proj', alias: 'web', title: 'orphan', status: 'working', createdAt: 4 },
    broken: { id: 'broken', spBotId: 'sp', workspacePath: '/proj', alias: 'web', title: '', status: 'progress', createdAt: 5 },
  }
  const { rt, stop } = await start(seed)
  t.after(stop)
  assert.equal(rt.laneOf('keep').title, 'kept')
  assert.equal(rt.laneOf('orphan'), undefined)
  // A status outside the set, and an empty title, are normalized.
  assert.equal(rt.laneOf('broken').status, 'idle')
  assert.equal(rt.laneOf('broken').title, 'Lane')
})
