import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import feishu from '../src/host/im/platforms/feishu.js'

// Fakes for the @larksuiteoapi/node-sdk surface the adapter uses: the OpenAPI
// client (message create/patch, resources, raw bot info) and the WSClient.
// The behaviors queue drives each start() attempt.
class FakeLark {
  constructor(opts) {
    this.opts = opts
    this.created = []
    this.patched = []
    this.resources = []
    FakeLark.instances.push(this)
  }

  im = {
    message: {
      create: async ({ data }) => {
        const self = FakeLark.instances.at(-1)
        self.created.push(data)
        if (FakeLark.createFailures.shift() !== undefined) throw new Error('send refused')
        return { data: { message_id: `om_${self.created.length}` } }
      },
      patch: async payload => { FakeLark.instances.at(-1).patched.push(payload); return {} },
    },
    messageResource: {
      get: async payload => {
        const self = FakeLark.instances.at(-1)
        self.resources.push(payload)
        return { getReadableStream: async function * () { yield Buffer.from(PNG_BYTES) } }
      },
    },
  }

  async request({ url }) {
    this.requests ??= []
    this.requests.push(url)
    return { bot: { open_id: 'ou_bot', app_name: 'Feishu Bot' } }
  }
}
FakeLark.instances = []
FakeLark.createFailures = []

class FakeEventDispatcher {
  static last = null
  constructor() { FakeEventDispatcher.last = this }
  register(map) { this.map = map; return map }
}

class FakeWSClient {
  constructor(opts) {
    this.opts = opts
    this.closed = 0
    FakeWSClient.instances.push(this)
  }

  async start({ eventDispatcher }) {
    // The real SDK wraps the registration; the fake keeps the plain map.
    this.registered = eventDispatcher.map ?? eventDispatcher
    const behavior = FakeWSClient.behaviors.shift()
    if (behavior !== undefined) return behavior(this)
    await this.opts.onReady?.()
  }

  close() { this.closed += 1 }

  async emit(event, payload) { await this.registered?.[event]?.(payload) }
}
FakeWSClient.instances = []
FakeWSClient.behaviors = []

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const connect = async (fields = { appId: 'cli_a', appSecret: 'sec', domain: 'feishu' }) => {
  FakeLark.instances.length = 0
  FakeWSClient.instances.length = 0
  FakeWSClient.behaviors.length = 0
  const statuses = []
  const inbound = []
  const actions = []
  const handle = feishu.connect(fields, { config: { larkSdk: { Client: FakeLark, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher } }, log: { warn: (...args) => console.error('[warn]', ...args) } }, {
    onStatus: next => statuses.push(next),
    onMessage: async msg => inbound.push(msg),
    onAction: async action => actions.push(action),
  })
  await delay(20)
  return { handle, statuses, inbound, actions, ws: FakeWSClient.instances.at(-1), lark: FakeLark.instances.at(-1) }
}

const ready = async (s) => { s.ws.opts.onReady(); await delay(5) }

const textEvent = overrides => ({
  message: {
    chat_type: 'p2p', chat_id: 'oc_1', message_id: 'om_1', message_type: 'text',
    content: JSON.stringify({ text: 'hello' }),
    ...overrides,
  },
  sender: { sender_id: { open_id: 'ou_u' } },
  ...overrides?.top,
})

test('check reads the bot identity', async () => {
  FakeLark.instances.length = 0
  const fields = { appId: 'cli_a', appSecret: 'sec', domain: 'feishu' }
  const account = await feishu.check(fields, { config: { larkSdk: { Client: FakeLark } } })
  assert.deepEqual(account, { account: { id: 'ou_bot', name: 'Feishu Bot' } })
})

test('p2p messages map to the adapter contract', async () => {
  const s = await connect()
  try {
    await ready(s)
    await s.ws.emit('im.message.receive_v1', textEvent({ content: JSON.stringify({ text: 'hi @_user_1' }) }))
    assert.deepEqual(s.inbound[0], {
      chat: { key: 'oc_1', kind: 'direct', title: 'oc_1' },
      sender: { id: 'ou_u', name: 'ou_u' },
      text: 'hi', images: [], files: [], mentioned: false, messageId: 'om_1',
    })
  } finally { s.handle.stop() }
})

test('group messages detect a bot mention by open id', async () => {
  const s = await connect()
  try {
    await ready(s)
    await delay(10) // the bot info call fills the mention check
    const group = {
      message: {
        chat_type: 'group', chat_id: 'oc_g', message_id: 'om_2', message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 do it' }),
        mentions: [{ id: { open_id: 'ou_bot' }, key: '@_user_1' }],
      },
      sender: { sender_id: { open_id: 'ou_m' } },
    }
    await s.ws.emit('im.message.receive_v1', group)
    assert.equal(s.inbound[0].mentioned, true)
    assert.equal(s.inbound[0].text, 'do it')
    await s.ws.emit('im.message.receive_v1', { ...group, message: { ...group.message, mentions: [] } })
    assert.equal(s.inbound[1].mentioned, false)
  } finally { s.handle.stop() }
})

test('images download as typed attachments', async () => {
  const s = await connect()
  try {
    await ready(s)
    await s.ws.emit('im.message.receive_v1', textEvent({
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_v2_1' }),
      message_id: 'om_3',
    }))
    await delay(10)
    assert.deepEqual(s.lark.resources[0], { params: { type: 'image' }, path: { message_id: 'om_3', file_key: 'img_v2_1' } })
    assert.equal(s.inbound[0].images[0].mediaType, 'image/png')
    assert.equal(Buffer.from(s.inbound[0].images[0].data, 'base64').equals(PNG_BYTES), true)
  } finally { s.handle.stop() }
})

test('card actions unpack the { v } button value', async () => {
  const s = await connect()
  try {
    await ready(s)
    await s.ws.emit('card.action.trigger', {
      action: { value: { v: 'allow:7' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_9' },
      operator: { open_id: 'ou_u' },
    })
    assert.deepEqual(s.actions[0], {
      chat: { key: 'oc_1', kind: 'direct', title: '' },
      sender: { id: 'ou_u', name: '' },
      data: 'allow:7', messageId: 'om_9',
    })
  } finally { s.handle.stop() }
})

test('long replies chunk as text and carry the card on the last chunk', async () => {
  const s = await connect()
  try {
    await ready(s)
    const buttons = [{ label: 'Allow', data: 'allow:1' }, { label: 'Reject', data: 'reject:1' }]
    await s.handle.send({ key: 'oc_1' }, { text: 'a'.repeat(5500), buttons })
    assert.equal(s.lark.created.length, 2)
    assert.equal(s.lark.created[0].msg_type, 'text')
    assert.equal(s.lark.created[0].receive_id, 'oc_1')
    const cardBody = JSON.parse(s.lark.created[1].content).body
    assert.equal(s.lark.created[1].msg_type, 'interactive')
    const columns = cardBody.elements.find(el => el.tag === 'column_set').columns
    assert.equal(columns.length, 2)
    assert.deepEqual(columns[0].elements[0].behaviors[0].value, { v: 'allow:1' })
    assert.deepEqual(JSON.parse(s.lark.created[1].content).body.elements.find(el => el.tag === 'markdown'), { tag: 'markdown', content: 'a'.repeat(1500) })
  } finally { s.handle.stop() }
})

test('edits patch the card in place', async () => {
  const s = await connect()
  try {
    await ready(s)
    await s.handle.edit({ key: 'oc_1' }, 'om_5', { text: 'answered', buttons: [{ label: 'Done', data: 'done' }] })
    assert.deepEqual(s.lark.patched[0].path, { message_id: 'om_5' })
    const content = JSON.parse(s.lark.patched[0].data.content)
    assert.equal(content.body.elements[0].content, 'answered')
    assert.deepEqual(content.body.elements[1].columns[0].elements[0].behaviors[0].value, { v: 'done' })
  } finally { s.handle.stop() }
})

test('connection states follow the SDK lifecycle', async () => {
  const s = await connect()
  try {
    assert.deepEqual(s.statuses, [{ state: 'connecting' }, { state: 'ready' }])
    s.ws.opts.onReconnecting()
    s.ws.opts.onReconnected()
    assert.deepEqual(s.statuses, [
      { state: 'connecting' },
      { state: 'ready' },
      { state: 'retrying', error: 'Feishu is reconnecting' },
      { state: 'ready' },
    ])
  } finally { s.handle.stop() }
})

test('a failed handshake retries with a fresh client and connects', async () => {
  const s = await connect()
  s.handle.stop()
  FakeWSClient.instances.length = 0
  FakeWSClient.behaviors.length = 0
  FakeWSClient.behaviors.push(() => { throw new Error('ECONNREFUSED') })
  const statuses = []
  const handle = feishu.connect({ appId: 'cli_a', appSecret: 'sec', domain: 'feishu' }, { config: { larkSdk: { Client: FakeLark, WSClient: FakeWSClient, EventDispatcher: FakeEventDispatcher } } }, {
    onStatus: next => statuses.push(next),
    onMessage: async () => {},
    onAction: async () => {},
  })
  try {
    await delay(500)
    assert.deepEqual(statuses, [
      { state: 'connecting' },
      { state: 'retrying', error: 'ECONNREFUSED' },
      { state: 'ready' },
    ])
    assert.equal(FakeWSClient.instances.length, 2)
  } finally { handle.stop() }
})
