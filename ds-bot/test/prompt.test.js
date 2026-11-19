import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  const registered = new Map()
  let disposed = 0
  ctx.get = name => name === 'agentPresets'
    ? { register: async (definition) => { registered.set(definition.id, definition); disposed += 1; return () => { disposed -= 1 } } }
    : undefined
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
    warn() {},
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt, registered, disposed: () => disposed }
}

test('the team rules travel in the presets, not in the identity section', (t) => {
  const { ctx, prompt, registered } = start()
  t.after(() => ctx.dispose())
  assert.deepEqual([...registered.keys()].sort(), ['ds-bot-main', 'ds-bot-team'])
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
    '- Reply in the user\'s language.',
  ]
  for (const id of ['ds-bot-main', 'ds-bot-team']) {
    const prefix = registered.get(id).plugins.find(row => row.id === 'persona').config.prefix
    for (const rule of rules) {
      assert.ok(prefix.split('\n').includes(rule))
      assert.equal(prefix.split(rule).length - 1, 1)
    }
  }
  const main = registered.get('ds-bot-main').plugins.find(row => row.id === 'persona').config.prefix
  assert.match(main, /## You are the Main Bot \(Chief of Staff\)/)
  assert.ok(main.indexOf('## You are the Main Bot (Chief of Staff)') < main.indexOf('## How your Bot team works'))
  for (const id of ['main', 'worker']) {
    assert.doesNotMatch(prompt(id), /How your Bot team works|Main Bot \(Chief of Staff\)/)
  }
  // The preset rows mount only npm packages, never a service of this plugin: the
  // preset activates in the registry's own scope, before this plugin is up.
  for (const definition of registered.values()) {
    const names = definition.plugins.flatMap(row => [row, ...(Array.isArray(row.config) ? row.config : [])]).map(row => row.name)
    for (const name of names) assert.equal(name.startsWith('ds-bot'), false, `row ${name} must not wait on this plugin`)
  }
})

// 公开#1499: a Bot that is handed a saved path and finds `read` closed to a PDF has to know where to go next.
test('Bots are told how to open a PDF the user attached, once, in the shared preset', (t) => {
  const { ctx, registered } = start()
  t.after(() => ctx.dispose())
  const prefix = registered.get('ds-bot-team').plugins.find(row => row.id === 'persona').config.prefix
  const rule = prefix.split('\n').filter(line => line.startsWith('- A file the user attaches reaches you as a saved path'))
  assert.equal(rule.length, 1)
  assert.match(rule[0], /read tool opens text files only/)
  assert.match(rule[0], /scanned or not/)
  assert.match(rule[0], /office skill/)
  assert.match(rule[0], /office_render/)
  assert.match(rule[0], /never answer only that the file cannot be read/)
})

test('the identity section stays the Bot record alone, and the relay text is unchanged', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.equal(prompt('main'), '# Your identity\nYou are Chief, a Bot on the user\'s team in DS Bot.')
  assert.equal(prompt('worker'), '# Your identity\nYou are Dev, a Bot on the user\'s team in DS Bot.\n\nCheck files.')
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('dispose lets go of the preset registrations, also before activation settles', async () => {
  {
    const { ctx, disposed: count } = start()
    await Promise.resolve()
    assert.equal(count(), 2)
    await ctx.dispose()
    assert.equal(count(), 0)
  }
  {
    const { ctx, disposed: count } = start()
    await ctx.dispose()
    await Promise.resolve()
    assert.equal(count(), 0)
  }
})
