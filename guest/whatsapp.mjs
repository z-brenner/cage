// cage's WhatsApp adapter. It links to WhatsApp the way WhatsApp Web does (through Baileys, an unofficial
// open-source client) and relays one person's messages to cc-connect's bridge inside the same VM.
// Started by guest/whatsapp.sh as the agent user, with its settings in the environment:
//   WA_DIR           state: the WhatsApp session (auth/), status.json for `cage chat link whatsapp`, and
//                    state.json (when it was last connected, so messages sent while it was away still count)
//   WA_MODE          "spare": a number of its own; people in WA_ALLOW message it like anyone else
//                    "own":   linked to its owner's own number; it answers only in their "Message yourself" chat
//   WA_ALLOW         phone numbers (digits) that may talk to it in spare mode
//   WA_BRIDGE_URL    ws://127.0.0.1:<port>/bridge/ws ; WA_BRIDGE_TOKEN its token
//   WA_NAME          how replies are signed in own mode (they come from the owner's own account there)
import fs from 'node:fs'
import path from 'node:path'

export const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const isGroupish = (jid) => /@(g\.us|broadcast|newsletter)$/.test(jid || '') || jid === 'status@broadcast'

// The text of a message, or "" for anything cage doesn't relay (stickers, reactions, calls...).
export function textOf(m) {
  const c = m?.message || {}
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption ||
    c.documentMessage?.caption || c.ephemeralMessage?.message?.conversation ||
    c.ephemeralMessage?.message?.extendedTextMessage?.text || ''
}

// A voice note or audio file, or null.
export function audioOf(m) {
  const c = m?.message || {}
  return c.audioMessage || c.ephemeralMessage?.message?.audioMessage || null
}

// Who may reach the agent. Returns {chat, user} for a message to relay, or null.
//   me: {pn, lid} jids of the linked account; sent: ids of messages the adapter itself sent
export function accept(m, { mode, allow, me, sent, since, mark }) {
  const k = m?.key || {}
  const chat = k.remoteJid || ''
  if (!chat || isGroupish(chat) || !(textOf(m) || audioOf(m))) return null
  if (sent.has(k.id)) return null                                         // our own reply coming back
  const raw = m.messageTimestamp
  const ts = typeof raw === 'object' && raw ? Number(raw.toNumber?.() ?? raw.low ?? 0) : Number(raw || 0)
  if (ts && since && ts < since) return null                              // history, not a new message
  const alt = k.remoteJidAlt || ''
  if (mode === 'own') {
    const self = [me.pn, me.lid].filter(Boolean).map(digits)
    const isSelfChat = self.includes(digits(chat)) || (alt && self.includes(digits(alt)))
    if (!k.fromMe || !isSelfChat) return null
    if (mark && textOf(m).startsWith(mark)) return null                   // a reply from before a restart
    return { chat, user: 'me' }
  }
  if (k.fromMe) return null
  const phone = [chat, alt].map(digits).find((d, i) => d && ([chat, alt][i] || '').endsWith('@s.whatsapp.net')) || ''
  if (!phone || !allow.includes(phone)) return null
  return { chat, user: phone }
}

// WhatsApp's own formatting: *bold*, _italic_, ~strike~, ```mono```.
export const toWhatsApp = (s) => String(s || '')
  .replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '_$1_').replace(/~~(.+?)~~/g, '~$1~')
  .replace(/^#{1,6} +(.+)$/gm, '*$1*')

// Where new messages start, in WhatsApp's seconds. Messages sent while the adapter was away (the VM asleep, a
// restart) arrive late, with their own times, so anything after the last time it was connected is new, but never
// more than a day back. The first time it links, there's no such time: only the last 30 seconds count.
export function sinceOf(state, now = Date.now()) {
  const last = Number(state?.lastAlive) || 0
  return Math.floor((last ? Math.max(Math.min(last, now), now - 24 * 3600 * 1000) : now - 30 * 1000) / 1000)
}

// Messages that can't go anywhere yet (cc-connect or WhatsApp is reconnecting) wait here: at most 50, and none for
// longer than 10 minutes, so a long outage doesn't end in a flood of stale messages.
export class Backlog {
  constructor(max = 50, ttl = 10 * 60 * 1000) { this.max = max; this.ttl = ttl; this.items = []; this.dropped = 0 }
  get size() { return this.items.length }
  push(item, now = Date.now()) {
    this.items.push({ item, at: now })
    while (this.items.length > this.max) { this.items.shift(); this.dropped++ }
  }
  take(now = Date.now()) { // everything still fresh, oldest first; the queue is then empty
    const fresh = this.items.filter((x) => now - x.at <= this.ttl)
    this.dropped += this.items.length - fresh.length
    this.items = []
    return fresh.map((x) => x.item)
  }
}

async function main() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser, downloadMediaMessage } =
    await import('@whiskeysockets/baileys')
  const { default: WebSocket } = await import('ws')
  const { default: pino } = await import('pino')

  const DIR = process.env.WA_DIR
  const MODE = process.env.WA_MODE === 'own' ? 'own' : 'spare'
  const ALLOW = (process.env.WA_ALLOW || '').split(',').map(digits).filter(Boolean)
  const NAME = process.env.WA_NAME || 'agent'
  const MARK = `[•|•] ${NAME}:`
  const sent = new Set()
  const remember = (id) => { if (!id) return; sent.add(id); if (sent.size > 500) sent.delete(sent.values().next().value) }
  fs.mkdirSync(path.join(DIR, 'auth'), { recursive: true, mode: 0o700 })
  // Written whole, then renamed into place: `cage chat link whatsapp` reads status.json while this writes it.
  const save = (name, data) => {
    const f = path.join(DIR, name)
    fs.writeFileSync(f + '.tmp', JSON.stringify(data))
    fs.renameSync(f + '.tmp', f)
  }
  const status = (s) => save('status.json', { ...s, at: Date.now() })
  const log = (...a) => console.log('cage-whatsapp:', ...a)
  const since = sinceOf((() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8')) } catch { return {} } })())
  const alive = () => { try { save('state.json', { lastAlive: Date.now() }) } catch (e) { log('couldn\'t save state.json:', e?.message) } }

  let sock = null
  let open = false          // WhatsApp's connection
  let me = {}
  let pairRequested = false
  let retry = 2000
  const dropped = (q, what) => { if (q.dropped) { log(`${q.dropped} ${what} waited too long and were dropped`); q.dropped = 0 } }

  // --- cc-connect's bridge ------------------------------------------------------------------------------------
  let bridge = null
  let registered = false    // cc-connect said yes to this connection: what's sent now gets to the agent
  let bridgeDelay = 1000
  const inbox = new Backlog()
  const toBridge = (o) => { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(o)) }
  // A message from WhatsApp goes to the agent, and only then is it marked read: blue ticks mean it got there.
  const handOff = (msg, key) => {
    if (!registered || bridge?.readyState !== WebSocket.OPEN) return inbox.push({ msg, key })
    bridge.send(JSON.stringify(msg))
    sock?.readMessages([key]).catch(() => {})
  }

  // Replies wait while WhatsApp is reconnecting, and go out in order once it's back.
  const outbox = new Backlog()
  let replies = Promise.resolve()
  const reply = (m) => { replies = replies.then(() => sendReply(m)) }
  async function sendReply(m) {
    if (!open || !sock) return outbox.push(m)
    try {
      const text = MODE === 'own' ? `${MARK} ${toWhatsApp(m.content)}` : toWhatsApp(m.content)
      const r = await sock.sendMessage(m.reply_ctx, { text })
      remember(r?.key?.id)
    } catch (e) {
      if (!open) return outbox.push(m)   // the connection dropped under it: try again when it's back
      log('send failed:', e?.message || e)
    }
  }

  function connectBridge() {
    const ws = new WebSocket(process.env.WA_BRIDGE_URL, { headers: { Authorization: `Bearer ${process.env.WA_BRIDGE_TOKEN}` } })
    ws.on('open', () => {
      bridge = ws
      registered = false
      ws.send(JSON.stringify({ type: 'register', platform: 'whatsapp', capabilities: ['text', 'typing'],
        metadata: { version: '1', description: 'cage WhatsApp adapter' } }))
    })
    ws.on('message', async (raw) => {
      let m
      try { m = JSON.parse(raw) } catch { return }
      if (!m || typeof m !== 'object') return
      if (m.type === 'register_ack') {
        if (!m.ok) return log(`bridge refused: ${m.error}`)
        registered = true
        bridgeDelay = 1000   // a working connection: if it drops, come straight back
        log('bridge connected')
        for (const { msg, key } of inbox.take()) handOff(msg, key)
        return dropped(inbox, 'messages for the agent')
      }
      const jid = m.reply_ctx
      try {
        if (m.type === 'reply' && jid && m.content) {
          reply(m)
        } else if (open && sock && m.type === 'typing_start' && jid) {
          await sock.sendPresenceUpdate('composing', jid)
        } else if (open && sock && m.type === 'typing_stop' && jid) {
          await sock.sendPresenceUpdate('paused', jid)
        }
      } catch (e) { log('send failed:', e?.message || e) }
    })
    ws.on('close', () => {
      if (bridge === ws) { bridge = null; registered = false }
      setTimeout(connectBridge, bridgeDelay)
      bridgeDelay = Math.min(bridgeDelay * 2, 30000)
    })
    ws.on('error', () => {})
  }
  setInterval(() => toBridge({ type: 'ping', ts: Date.now() }), 30000)
  setInterval(() => { if (open) alive() }, 60000)

  // --- WhatsApp -----------------------------------------------------------------------------------------------
  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, 'auth'))
    // A pairing code that was never entered leaves a half-made link (an account number, nothing else) that WhatsApp
    // won't log in with. Start that over, so WhatsApp gives a fresh code.
    if (state.creds.me && !state.creds.registered && !state.creds.account) {
      delete state.creds.me
      delete state.creds.pairingCode
    }
    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('cage'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        const pair = fs.existsSync(path.join(DIR, 'pair')) ? digits(fs.readFileSync(path.join(DIR, 'pair'), 'utf8')) : ''
        if (pair && !pairRequested && !state.creds.registered) {
          pairRequested = true
          try { status({ state: 'code', code: await sock.requestPairingCode(pair) }) } catch (e) { log('pairing code failed:', e?.message) }
        } else if (!pairRequested) {
          status({ state: 'qr', qr: u.qr })
        }
      }
      if (u.connection === 'open') {
        retry = 2000
        open = true
        alive()
        me = { pn: jidNormalizedUser(sock.user?.id), lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : '' }
        status({ state: 'linked', me: digits(me.pn), mode: MODE })
        log(`linked as +${digits(me.pn)} (${MODE} number)`)
        for (const m of outbox.take()) reply(m)
        dropped(outbox, 'replies')
      }
      if (u.connection === 'close') {
        if (open) alive()
        open = false
        // Not linked yet: the code (or QR) has run out. The next connection asks WhatsApp for a new one.
        if (!state.creds.registered) pairRequested = false
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          log('logged out from the phone; link again with: cage chat link whatsapp')
          status({ state: 'logged-out' })
          fs.rmSync(path.join(DIR, 'auth'), { recursive: true, force: true })
          fs.rmSync(path.join(DIR, 'pair'), { force: true })
          fs.rmSync(path.join(DIR, 'state.json'), { force: true })
          process.exit(3)
        }
        if (code === DisconnectReason.restartRequired) return setTimeout(connect, 0)
        log(`connection closed (${code ?? 'no code'}: ${u.lastDisconnect?.error?.message || 'unknown'}); retrying in ${retry / 1000}s`)
        setTimeout(connect, retry)
        retry = Math.min(retry * 2, 120000)
      }
    })
    // New messages ('notify'), and those WhatsApp held while the adapter was away ('append', with their own times):
    // accept() keeps the ones after `since`.
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        const ok = accept(m, { mode: MODE, allow: ALLOW, me, sent, since, mark: MARK })
        if (!ok) continue
        const msg = { type: 'message', msg_id: m.key.id, session_key: `whatsapp:${digits(ok.chat)}:${ok.user}`,
          user_id: ok.user, user_name: m.pushName || ok.user, content: textOf(m), reply_ctx: ok.chat }
        const a = audioOf(m)
        if (a) {   // a voice note: cc-connect turns it into text (cage voice on)
          try {
            const buf = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage })
            const mime = String(a.mimetype || 'audio/ogg').split(';')[0]
            msg.audio = { mime_type: mime, data: Buffer.from(buf).toString('base64'),
              format: (mime.split('/')[1] || 'ogg').replace('mpeg', 'mp3'), duration: Number(a.seconds || 0) }
          } catch (e) { log('couldn\'t download a voice note:', e?.message || e); continue }
        }
        handOff(msg, m.key)
      }
    })
  }

  connectBridge()
  await connect()
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('cage-whatsapp:', e); process.exit(1) })
