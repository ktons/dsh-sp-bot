// QQ open platform, rebuilt on the official @tencent-connect/qqbot-nodejs
// SDK (MIT, see NOTICE) following dsh-im's delivery model. The SDK owns the
// gateway (heartbeat, resume, reconnect) and the token lifecycle — except that
// it never checks a heartbeat ack, so the watchdog below closes a gateway that
// stopped answering, which the SDK's reconnect then replaces. Sends keep
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
// The SDK sends heartbeats but never checks the gateway's acks, so a connection
// QQ stopped answering — after the computer slept or a NAT mapping quietly
// expired — stays 'ready' forever and every later message is lost. The watchdog
// watches the socket the SDK actually uses and closes it once no frame arrives
// in a few heartbeat periods, which lets the SDK's own reconnect take over; if
// that socket stays gone the SDK has given up, and a fresh connection replaces it.
const WATCHDOG_TICK_MS = 10_000
const WATCHDOG_RESET_MS = 5 * 60_000
const WATCHDOG_MIN_SILENCE_MS = 60_000
const WATCHDOG_MAX_SILENCE_MS = 120_000
const WATCHDOG_DEFAULT_BEAT_MS = 45_000

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
    // Watchdog tunables ride on the platform config; the test bench shortens them.
    const tick = Math.max(Number(env.config?.tick) || WATCHDOG_TICK_MS, 10)
    const resetAfter = Math.max(Number(env.config?.reset) || WATCHDOG_RESET_MS, tick * 2)
    let generation = 0
    let watchdogTimer
    let everSawSocket = false
    let lastSocketAt = 0
    let watchedSocket
    let watchedSeenAt = 0
    let watchedBeatMs = 0

    const wire = (bot, myGeneration) => {
      const alive = () => !stopped && myGeneration === generation
      bot.on('ready', () => { if (alive()) { hasConnected = true; handlers.onStatus({ state: 'ready' }) } })
      bot.on('resumed', () => { if (alive()) { hasConnected = true; handlers.onStatus({ state: 'ready' }) } })
      bot.on('error', (error) => {
        if (!alive()) return
        const message = String(error?.message ?? error)
        if (!hasConnected) startFailure = new Error(message)
        else handlers.onStatus({ state: 'retrying', error: message })
      })
      bot.on('message', async (_ctx, msg) => {
        if (!alive()) return
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
    // A frame from the socket — heartbeat ack, dispatch, anything — proves the
    // link answers. Stale sockets from replaced SDK instances must not refresh it.
    const watch = () => {
      const socket = bot?.gateway?.currentWs
      if (socket === undefined || socket === null || socket === watchedSocket) return
      watchedSocket = socket
      everSawSocket = true
      watchedSeenAt = Date.now()
      socket.on?.('message', (data) => {
        if (watchedSocket !== socket) return
        watchedSeenAt = Date.now()
        try {
          const frame = JSON.parse(String(data))
          if (frame?.op === 10 && Number(frame?.d?.heartbeat_interval) > 0) watchedBeatMs = Number(frame.d.heartbeat_interval)
        } catch { /* a frame we cannot parse still proves liveness */ }
      })
    }
    const silenceLimit = () => {
      const fixed = Number(env.config?.silent)
      if (Number.isFinite(fixed) && fixed > 0) return fixed
      const beat = watchedBeatMs > 0 ? watchedBeatMs : WATCHDOG_DEFAULT_BEAT_MS
      return Math.min(Math.max(beat * 2.5, WATCHDOG_MIN_SILENCE_MS), WATCHDOG_MAX_SILENCE_MS)
    }
    const rebuild = () => {
      if (stopped) return
      env.log?.warn?.('ds-bot im qq: gateway had no socket for %dms — starting a fresh connection', Date.now() - lastSocketAt)
      void startAttempt(0)
    }

    handlers.onStatus({ state: 'connecting' })
    // A refused credential (4xx token or gateway answer) is terminal; anything
    // else — including a start that ran ahead of the network — retries with a
    // bounded backoff so the connection comes up once the network is (#1119).
    // Each attempt gets a fresh SDK instance: a failed gateway start leaves
    // the previous one dead.
    const startAttempt = async (attempt) => {
      if (stopped) return
      const myGeneration = ++generation
      const previous = bot
      bot = botFor(fields, env)
      lastSocketAt = Date.now()
      watchedSocket = undefined
      watchedBeatMs = 0
      previous?.stop()
      wire(bot, myGeneration)
      try {
        await bot.start()
      } catch (error) {
        if (stopped || myGeneration !== generation) return
        const failure = startFailure ?? error
        const message = String(failure?.message ?? failure)
        if (startErrorPermanent(failure)) {
          handlers.onStatus({ state: 'error', error: message })
          return
        }
        handlers.onStatus({ state: 'retrying', error: message })
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          if (stopped || myGeneration !== generation) return
          void startAttempt(attempt + 1)
        }, retryDelay(attempt))
        retryTimer.unref?.()
      }
    }
    void startAttempt(0)
    watchdogTimer = setInterval(() => {
      if (stopped) return
      watch()
      const socket = bot?.gateway?.currentWs
      if (socket === undefined || socket === null) {
        // A gateway the SDK rebuilt itself leaves no gap long enough to get here;
        // a gap this long means its reconnect gave up (or it hangs pre-open).
        if (everSawSocket && Date.now() - lastSocketAt > resetAfter) rebuild()
        return
      }
      lastSocketAt = Date.now()
      if (socket.readyState !== 1) return
      if (Date.now() - watchedSeenAt <= silenceLimit()) return
      env.log?.warn?.('ds-bot im qq: no gateway frame for %dms — closing a dead websocket so it reconnects', Date.now() - watchedSeenAt)
      handlers.onStatus({ state: 'retrying', error: 'QQ gateway stopped answering; reconnecting' })
      socket.terminate()
    }, tick)
    watchdogTimer.unref?.()

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
        clearInterval(watchdogTimer)
        bot?.stop()
      },
    }
  },
}
