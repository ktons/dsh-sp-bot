import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import qq from '../src/host/im/platforms/qq.js'

// A fake @tencent-connect/qqbot-nodejs surface: the events the adapter wires,
// the send/api calls it makes. Static queues drive per-instance behavior.
class FakeQQBot {
  static startFailures = []
  static sendFailures = []
  static instances = []

  constructor(opts) {
    this.opts = opts
    this.handlers = {}
    this.sent = []
    this.stopped = 0
    this.starts = 0
    FakeQQBot.instances.push(this)
    this.api = { get: async path => path === '/users/@me' ? { username: 'qqbot' } : {} }
  }

  on(event, fn) { (this.handlers[event] ??= []).push(fn) }
  async emit(event, ...args) { for (const fn of this.handlers[event] ?? []) await fn(...args) }

  async start() {
    this.starts += 1
    const failure = FakeQQBot.startFailures.shift()
    if (failure !== undefined) throw failure
    await this.emit('ready')
  }

  async send(opts) {
    this.sent.push(opts)
    const failure = FakeQQBot.sendFailures.shift()
    if (failure !== undefined) throw failure
    return { id: `out_${this.sent.length}` }
  }

  stop() { this.stopped += 1 }
}

const instance = () => FakeQQBot.instances.at(-1)

const connect = async (env = {}) => {
  FakeQQBot.instances.length = 0
  FakeQQBot.startFailures.length = 0
  FakeQQBot.sendFailures.length = 0
  const statuses = []
  const inbound = []
  const handle = qq.connect({ appId: 'app-1', appSecret: 'sec-1' }, { config: { qqBot: FakeQQBot }, ...env }, {
    onStatus: next => statuses.push(next),
    onMessage: async msg => inbound.push(msg),
    onAction: async () => {},
  })
  await delay(20)
  return { handle, statuses, inbound }
}

const inboundMessage = overrides => ({
  kind: 'c2c', senderId: 'u1', groupOpenid: undefined,
  content: ' hello ', messageId: 'in_1', ...overrides,
})

test('check reads the account name from the platform', async () => {
  FakeQQBot.instances.length = 0
  const account = await qq.check({ appId: 'app-1', appSecret: 'sec-1' }, { config: { qqBot: FakeQQBot } })
  assert.deepEqual(account, { account: { id: 'app-1', name: '@qqbot' } })
})

test('replies send QQ markdown against the inbound message with climbing msg_seq', async () => {
  const s = await connect()
  try {
    await instance().emit('message', {}, inboundMessage())
    assert.deepEqual(s.inbound[0], {
      chat: { key: 'u1', kind: 'direct', title: '' },
      sender: { id: 'u1', name: 'u1' },
      text: 'hello', images: [], files: [], mentioned: false, messageId: 'in_1',
    })
    await s.handle.send({ key: 'u1', kind: 'direct' }, { text: 'first' })
    await s.handle.send({ key: 'u1', kind: 'direct' }, { text: 'second' })
    assert.deepEqual(instance().sent[0], {
      target: { scope: 'c2c', targetId: 'u1', msgId: 'in_1' },
      msgType: 2, markdown: { content: 'first' }, extra: { msg_seq: 1 },
    })
    assert.equal(instance().sent[1].extra.msg_seq, 2)
  } finally { s.handle.stop() }
})

test('group messages key by group openid and arrive mentioned', async () => {
  const s = await connect()
  try {
    await instance().emit('message', {}, inboundMessage({ kind: 'group', senderId: 'm1', groupOpenid: 'g1', messageId: 'in_2' }))
    assert.deepEqual(s.inbound[0].chat, { key: 'g1', kind: 'group', title: '' })
    assert.equal(s.inbound[0].mentioned, true)
  } finally { s.handle.stop() }
})

test('a markdown-permission refusal falls back to plain text for that chunk', async () => {
  const s = await connect()
  try {
    await instance().emit('message', {}, inboundMessage())
    FakeQQBot.sendFailures.push({ bizCode: 40_034_090, httpStatus: 400, bizMessage: 'markdown not allowed', message: 'markdown not allowed' })
    await s.handle.send({ key: 'u1', kind: 'direct' }, { text: '**hi**' })
    assert.equal(instance().sent.length, 2)
    assert.equal(instance().sent[0].msgType, 2)
    assert.deepEqual(instance().sent[1], {
      target: { scope: 'c2c', targetId: 'u1', msgId: 'in_1' },
      msgType: 0, content: 'hi', extra: { msg_seq: 1 },
    })
  } finally { s.handle.stop() }
})

test('a dead passive reply window is permanent, another refusal is not', async () => {
  const s = await connect()
  try {
    await instance().emit('message', {}, inboundMessage())
    FakeQQBot.sendFailures.push({ httpStatus: 400, bizMessage: 'reply window expired', message: 'reply window expired' })
    await assert.rejects(s.handle.send({ key: 'u1', kind: 'direct' }, { text: 'x' }), error => error.permanent === true)
    FakeQQBot.sendFailures.push({ httpStatus: 500, message: 'server error' })
    await assert.rejects(s.handle.send({ key: 'u1', kind: 'direct' }, { text: 'x' }), error => error.permanent === false)
  } finally { s.handle.stop() }
})

test('a start that ran ahead of the network retries until it connects', async () => {
  const s = await connect()
  s.handle.stop()
  FakeQQBot.instances.length = 0
  FakeQQBot.startFailures.length = 0
  FakeQQBot.startFailures.push(Object.assign(new Error('socket hang up'), { httpStatus: 0 }))
  const statuses = []
  const handle = qq.connect({ appId: 'app-1', appSecret: 'sec-1' }, { config: { qqBot: FakeQQBot } }, {
    onStatus: next => statuses.push(next),
    onMessage: async () => {},
    onAction: async () => {},
  })
  try {
    await delay(400)
    assert.deepEqual(statuses, [
      { state: 'connecting' },
      { state: 'retrying', error: 'socket hang up' },
      { state: 'ready' },
    ])
  } finally { handle.stop() }
})

test('a refused credential is terminal', async () => {
  const s = await connect()
  s.handle.stop()
  FakeQQBot.instances.length = 0
  FakeQQBot.startFailures.length = 0
  FakeQQBot.startFailures.push(Object.assign(new Error('invalid app secret'), { httpStatus: 400 }))
  const statuses = []
  const handle = qq.connect({ appId: 'app-1', appSecret: 'sec-1' }, { config: { qqBot: FakeQQBot } }, {
    onStatus: next => statuses.push(next),
    onMessage: async () => {},
    onAction: async () => {},
  })
  try {
    await delay(400)
    assert.deepEqual(statuses, [{ state: 'connecting' }, { state: 'error', error: 'invalid app secret' }])
    assert.equal(FakeQQBot.instances.length, 1)
  } finally { handle.stop() }
})
