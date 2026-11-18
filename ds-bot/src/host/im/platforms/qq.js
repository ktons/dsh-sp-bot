// QQ open platform, rebuilt on the official @tencent-connect/qqbot-nodejs
// SDK (MIT, see NOTICE) following dsh-im's delivery model. The SDK owns the
// gateway (heartbeat, resume, reconnect) and the token lifecycle; sends keep
// ds-bot's contract: the reply is converted to the QQ markdown subset,
// chunked, sent as msg_type=2 against the last inbound msg_id with a
// climbing msg_seq, and a chunk the platform refuses for markdown
// permission falls back to plain text instead of dying (#40034090).
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { chunkMarkdown, toPlain } from '../format.js'
import { toQqMarkdown } from '../qq-markdown.js'
import { retryDelay } from './retry.js'

const TEXT_LIMIT = 2000
// GROUP_AND_C2C covers C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE.
const INTENTS = 1 << 25
const MARKDOWN_REJECTION_BIZ_CODE = 40_034_090

const loggerFor = env => ({
  info: (...args) => env.log?.info?.('ds-bot im qq: %s', args.join(' ')),
  warn: (...args) => env.log?.warn?.('ds-bot im qq: %s', args.join(' ')),
  error: (...args) => env.log?.warn?.('ds-bot im qq: %s', args.join(' ')),
  debug: () => undefined,
})

const botFor = (fields, env) => {
  // env.config.qqBot replaces the SDK class for the test bench.
  const Bot = env.config?.qqBot ?? QQBot
  return new Bot({
    appId: String(fields.appId ?? '').trim(),
    appSecret: String(fields.appSecret ?? '').trim(),
    accountId: String(fields.appId ?? '').trim(),
    markdownSupport: true,
    // The endpoint overrides exist for the test bench: a fake platform on localhost.
    baseUrl: env.config?.api === undefined ? undefined : String(env.config.api).replace(/\/+$/, ''),
    tokenBaseUrl: env.config?.token === undefined ? undefined : String(env.config.token).replace(/\/+$/, ''),
    intents: INTENTS,
    logger: loggerFor(env),
  })
}

// The host retries permanent send failures itself; surface the refusal
// window and quota reasons as permanent so a dead passive reply is not
// retried for half a minute first. ApiError fields are read by name so the
// classification also covers the SDK-shaped errors the test bench builds.
function classify(error) {
  const reason = String(error?.bizMessage ?? error?.message ?? error)
  const httpStatus = Number(error?.httpStatus)
  error.status = Number.isFinite(httpStatus) ? httpStatus : undefined
  error.permanent = (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429)
    || /reply.*window|quota|frequency|超过|过期/i.test(reason)
  return error
}

const startErrorPermanent = error => Number(error?.httpStatus) >= 400
  && Number(error?.httpStatus) < 500 && Number(error?.httpStatus) !== 429

export default {
  id: 'qq',

  async check(fields, env) {
    const bot = botFor(fields, env)
    try {
      const me = await bot.api.get('/users/@me')
      return { account: { id: String(fields.appId).trim(), name: me?.username ? `@${me.username}` : String(fields.appId).trim() } }
    } finally {
      bot.stop()
    }
  },

  connect(fields, env, handlers) {
    let stopped = false
    let retryTimer
    // A start that never reached READY failed; the error surfaces through the
    // start attempt instead of showing a live connection.
    let hasConnected = false
    let startFailure
    // Passive replies reuse the inbound msg_id with a msg_seq that climbs
    // per id — outside the reply window the platform refuses (permanent).
    const lastMsgId = new Map()
    const msgSeq = new Map()

    const wire = (bot) => {
      bot.on('ready', () => { if (!stopped) { hasConnected = true; handlers.onStatus({ state: 'ready' }) } })
      bot.on('resumed', () => { if (!stopped) { hasConnected = true; handlers.onStatus({ state: 'ready' }) } })
      bot.on('error', (error) => {
        if (stopped) return
        const message = String(error?.message ?? error)
        if (!hasConnected) startFailure = new Error(message)
        else handlers.onStatus({ state: 'retrying', error: message })
      })
      bot.on('message', async (_ctx, msg) => {
        if (stopped) return
        const direct = msg.kind === 'c2c'
        const key = String(direct ? msg.senderId : msg.groupOpenid ?? '')
        if (key === '') return
        lastMsgId.set(key, String(msg.messageId ?? ''))
        await handlers.onMessage({
          chat: { key, kind: direct ? 'direct' : 'group', title: '' },
          sender: { id: String(msg.senderId ?? ''), name: String(msg.senderId ?? '') },
          text: String(msg.content ?? '').trim(),
          images: [], files: [],
          mentioned: !direct, messageId: String(msg.messageId ?? ''),
        })
      })
    }

    let bot
    handlers.onStatus({ state: 'connecting' })
    // A refused credential (4xx token or gateway answer) is terminal; anything
    // else — including a start that ran ahead of the network — retries with a
    // bounded backoff so the connection comes up once the network is (#1119).
    // Each attempt gets a fresh SDK instance: a failed gateway start leaves
    // the previous one dead.
    const startAttempt = async (attempt) => {
      if (stopped) return
      bot = botFor(fields, env)
      wire(bot)
      try {
        await bot.start()
      } catch (error) {
        if (stopped) return
        const failure = startFailure ?? error
        const message = String(failure?.message ?? failure)
        if (startErrorPermanent(failure)) {
          handlers.onStatus({ state: 'error', error: message })
          return
        }
        handlers.onStatus({ state: 'retrying', error: message })
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => { void startAttempt(attempt + 1) }, retryDelay(attempt))
        retryTimer.unref?.()
      }
    }
    void startAttempt(0)

    const replyOf = (chat) => {
      const msgId = lastMsgId.get(chat.key)
      const target = { scope: chat.kind === 'direct' ? 'c2c' : 'group', targetId: chat.key, ...(msgId ? { msgId } : {}) }
      // One passive reply window spends seq numbers in order: claim the next
      // slot before sending so concurrent sends cannot reuse it.
      if (msgId !== undefined) {
        const seq = (msgSeq.get(msgId) ?? 0) + 1
        msgSeq.set(msgId, seq)
        return { target, extra: { msg_seq: seq } }
      }
      return { target }
    }

    return {
      send: async (chat, { text }) => {
        const chunks = chunkMarkdown(toQqMarkdown(String(text ?? '')), TEXT_LIMIT)
        let messageId
        for (const chunk of chunks) {
          const { target, extra } = replyOf(chat)
          let sent
          try {
            sent = await bot.send({ target, msgType: 2, markdown: { content: chunk }, extra })
          } catch (error) {
            // 40034090 is the platform refusing the markdown itself (no
            // permission for it). Any other refusal is about this reply.
            if (Number(error?.bizCode) !== MARKDOWN_REJECTION_BIZ_CODE) throw classify(error)
            sent = await bot.send({ target, msgType: 0, content: toPlain(chunk), extra })
          }
          messageId = String(sent?.id ?? messageId ?? '')
        }
        return { messageId }
      },
      stop: () => {
        stopped = true
        clearTimeout(retryTimer)
        bot?.stop()
      },
    }
  },
}
