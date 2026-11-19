// Feishu / Lark, rebuilt on the official @larksuiteoapi/node-sdk (MIT, see
// NOTICE) following dsh-im's runtime model. The SDK's WSClient owns the
// long connection: handshake timeout, liveness watchdog, and the
// reconnect loop are its, and the connection state surfaces through
// onReady / onReconnecting / onReconnected / onError instead of frame
// inspection. Sends go through the SDK's OpenAPI client with the same
// delivery contract as before: text is chunked, the last chunk carries the
// interactive card (schema 2.0, markdown element, full-width callback
// buttons), and edits PATCH the card in place.
import { Client as LarkClient, EventDispatcher as LarkEventDispatcher, LoggerLevel, WSClient as LarkWSClient } from '@larksuiteoapi/node-sdk'
import { chunkMarkdown } from '../format.js'
import { retryDelay } from './retry.js'

const SOCKET_TIMEOUT_MS = 30_000
const TEXT_LIMIT = 4000
const PING_TIMEOUT_SEC = 90

const domainOf = (fields, env) => String(env.config?.api
  ?? (fields.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn')).replace(/\/+$/, '')

// env.config.larkSdk replaces the SDK classes for the test bench.
const sdkFor = env => env.config?.larkSdk ?? {}

const clientFor = (fields, env) => {
  return new (sdkFor(env).Client ?? LarkClient)({
    appId: String(fields.appId ?? '').trim(),
    appSecret: String(fields.appSecret ?? '').trim(),
    domain: domainOf(fields, env),
  })
}

const safeJson = (text) => { try { return JSON.parse(text ?? '{}') } catch { return {} } }

// The SDK types cover only versioned OpenAPI paths; /bot/v3/info has none,
// so it goes through the client's raw request, which signs it the same way.
const botInfo = async (client) => client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })

export default {
  id: 'feishu',

  async check(fields, env) {
    const me = await botInfo(clientFor(fields, env))
    const bot = me?.bot ?? me ?? {}
    return { account: { id: String(bot.open_id ?? bot.app_id ?? fields.appId), name: String(bot.app_name ?? fields.appId) } }
  },

  connect(fields, env, handlers) {
    const client = clientFor(fields, env)
    let stopped = false
    let wsClient
    // One generation per start attempt: events and status reports from a
    // replaced attempt are dropped, the same guard dsh-im's runtime puts
    // around its start loop.
    let generation = 0
    let retryTimer
    let botOpenId = ''

    const isCurrent = () => !stopped
    const status = (next) => { if (isCurrent()) handlers.onStatus(next) }

    const resourceBuffer = async (messageId, fileKey) => {
      const resource = await client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: fileKey },
      })
      const chunks = []
      for await (const chunk of resource.getReadableStream()) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    }

    const onMessageEvent = async (event) => {
      const message = event?.message ?? {}
      const direct = message.chat_type === 'p2p'
      const mentioned = !direct && (message.mentions ?? []).some(m => m.id?.open_id === botOpenId || m.key === '@_user_1')
      const content = safeJson(message.content)
      const text = String(content.text ?? '').replace(/@_user_\d+/g, '').trim()
      const images = []
      if (message.message_type === 'image' && content.image_key !== undefined) {
        try {
          const buffer = await resourceBuffer(String(message.message_id ?? ''), String(content.image_key))
          images.push({ mediaType: imageMediaType(buffer), data: buffer.toString('base64') })
        } catch (error) {
          env.log?.warn?.('ds-bot im: feishu image download failed for %s: %s', String(message.message_id ?? ''), error?.message ?? error)
        }
      }
      const sender = event?.sender?.sender_id?.open_id ?? event?.sender?.user_id ?? ''
      await handlers.onMessage({
        chat: { key: String(message.chat_id ?? ''), kind: direct ? 'direct' : 'group', title: String(message.chat_id ?? '') },
        sender: { id: String(sender), name: String(sender) },
        text, images, files: [],
        mentioned, messageId: String(message.message_id ?? ''),
      })
    }

    const onCardActionEvent = async (event) => {
      const action = event?.action ?? event?.actions?.[0] ?? {}
      const data = action.value ?? action.action_data?.value ?? action.action_data ?? {}
      await handlers.onAction({
        chat: { key: String(event?.context?.open_chat_id ?? event?.message?.chat_id ?? ''), kind: 'direct', title: '' },
        sender: { id: String(event?.operator?.open_id ?? event?.user_id ?? ''), name: '' },
        data: String(typeof data === 'object' ? (data.v ?? JSON.stringify(data)) : data),
        messageId: String(event?.message_id ?? event?.context?.open_message_id ?? ''),
      })
    }

    // Cards follow dsh-im's card builders: schema 2.0, a markdown body, and
    // each button laid out full-width through a one-column column_set. The
    // callback value stays `{ v: data }` — that is what onAction unpacks.
    const card = (text, buttons) => JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
          ...(buttons?.length > 0 ? [{
            tag: 'column_set',
            flex_mode: 'none',
            columns: buttons.slice(0, 5).map(button => ({
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: button.label.slice(0, 20) },
                type: 'primary',
                width: 'fill',
                behaviors: [{ type: 'callback', value: { v: button.data } }],
              }],
            })),
          }] : []),
        ],
      },
    })

    // A failed attempt — refused endpoint, handshake timeout, terminal
    // onError — retries here with a bounded backoff, so a start that ran
    // ahead of the network connects once it is (#1119).
    const open = async (attempt) => {
      if (stopped) return
      const gen = ++generation
      const dispatcher = new (sdkFor(env).EventDispatcher ?? LarkEventDispatcher)({}).register({
        'im.message.receive_v1': (event) => {
          if (generation !== gen || stopped) return
          void onMessageEvent(event).catch(error => env.log?.warn?.('ds-bot im: feishu event failed: %s', error?.message ?? error))
        },
        'im.message.reaction.created_v1': () => undefined,
        'im.message.reaction.deleted_v1': () => undefined,
        // Only delivered when the app subscribes card.action.trigger; the
        // number-reply fallback covers apps that do not.
        'card.action.trigger': (event) => {
          if (generation !== gen || stopped) return
          void onCardActionEvent(event).catch(error => env.log?.warn?.('ds-bot im: feishu card action failed: %s', error?.message ?? error))
        },
      })
      let wsReady
      let wsFail
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Feishu WebSocket handshake timed out after ${SOCKET_TIMEOUT_MS}ms`)), SOCKET_TIMEOUT_MS)
        timer.unref?.()
        wsReady = () => { clearTimeout(timer); wsReady = undefined; resolve() }
        wsFail = (error) => { clearTimeout(timer); wsReady = undefined; reject(error) }
      })
      const next = new (sdkFor(env).WSClient ?? LarkWSClient)({
        appId: String(fields.appId ?? '').trim(),
        appSecret: String(fields.appSecret ?? '').trim(),
        domain: domainOf(fields, env),
        loggerLevel: LoggerLevel.info,
        autoReconnect: true,
        handshakeTimeoutMs: SOCKET_TIMEOUT_MS,
        pingTimeoutSec: PING_TIMEOUT_SEC,
        onReady: () => { if (generation === gen && !stopped) { wsReady?.(); status({ state: 'ready' }) } },
        onReconnecting: () => { if (generation === gen && !stopped) status({ state: 'retrying', error: 'Feishu is reconnecting' }) },
        onReconnected: () => { if (generation === gen && !stopped) status({ state: 'ready' }) },
        onError: (error) => { if (generation === gen && !stopped) wsFail?.(error instanceof Error ? error : new Error(String(error))) },
      })
      wsClient = next
      try {
        await Promise.all([next.start({ eventDispatcher: dispatcher }), ready])
      } catch (error) {
        // This attempt is over. If the stop raced it, the stop owns the
        // state; otherwise surface the failure and let the host retry.
        try { next.close({ force: true }) } catch { /* not open */ }
        if (wsClient === next) wsClient = undefined
        generation += 1
        if (stopped) return
        status({ state: 'retrying', error: String(error?.message ?? error) })
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => { void open(attempt + 1) }, retryDelay(attempt))
        retryTimer.unref?.()
      }
    }

    handlers.onStatus({ state: 'connecting' })
    // The bot identity fills the mention check; a failure here does not hold
    // the connection — group @-messages just fall back to the @_user_1 key.
    void botInfo(client)
      .then(me => { botOpenId = String(me?.bot?.open_id ?? me?.open_id ?? '') })
      .catch(error => env.log?.warn?.('ds-bot im: feishu bot info failed: %s', error?.message ?? error))
    void open(0)

    return {
      send: async (chat, { text, buttons }) => {
        const chunks = chunkMarkdown(String(text ?? ''), TEXT_LIMIT)
        let messageId
        for (const [index, chunk] of chunks.entries()) {
          const interactive = buttons !== undefined && index === chunks.length - 1
          const sent = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chat.key,
              msg_type: interactive ? 'interactive' : 'text',
              content: interactive ? card(chunk, buttons) : JSON.stringify({ text: chunk }),
            },
          })
          messageId = String(sent?.data?.message_id ?? sent?.message_id ?? messageId ?? '')
        }
        return { messageId }
      },
      edit: async (chat, messageId, { text, buttons }) => {
        await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: card(String(text ?? '').slice(0, TEXT_LIMIT), buttons) },
        })
      },
      stop: () => {
        stopped = true
        generation += 1
        clearTimeout(retryTimer)
        const previous = wsClient
        wsClient = undefined
        try { previous?.close({ force: true }) } catch { /* not open */ }
      },
    }
  },
}

function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const header = bytes.toString('latin1', 0, 6)
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('Feishu returned an unsupported image format')
}
