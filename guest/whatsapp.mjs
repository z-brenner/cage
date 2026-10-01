// cage's WhatsApp adapter. It links to WhatsApp the way WhatsApp Web does (through Baileys, an unofficial
// open-source client) and relays one person's messages to cc-connect's bridge inside the same VM.
// Started by guest/whatsapp.sh as the agent user, with its settings in the environment:
//   WA_DIR           state: the WhatsApp session (auth/), and status.json for `cage chat link whatsapp`
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

// Who may reach the agent. Returns {chat, user} for a message to relay, or null.
//   me: {pn, lid} jids of the linked account; sent: ids of messages the adapter itself sent
export function accept(m, { mode, allow, me, sent, since, mark }) {
  const k = m?.key || {}
  const chat = k.remoteJid || ''
  if (!chat || isGroupish(chat) || !textOf(m)) return null
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

async function main() {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser } =
    await import('@whiskeysockets/baileys')
  const { default: WebSocket } = await import('ws')
  const { default: pino } = await import('pino')

  const DIR = process.env.WA_DIR
  const MODE = process.env.WA_MODE === 'own' ? 'own' : 'spare'
  const ALLOW = (process.env.WA_ALLOW || '').split(',').map(digits).filter(Boolean)
  const NAME = process.env.WA_NAME || 'agent'
  const MARK = `[•|•] ${NAME}:`
  const since = Math.floor(Date.now() / 1000) - 30
  const sent = new Set()
  const remember = (id) => { if (!id) return; sent.add(id); if (sent.size > 500) sent.delete(sent.values().next().value) }
  fs.mkdirSync(path.join(DIR, 'auth'), { recursive: true, mode: 0o700 })
  const status = (s) => fs.writeFileSync(path.join(DIR, 'status.json'), JSON.stringify({ ...s, at: Date.now() }))
  const log = (...a) => console.log('cage-whatsapp:', ...a)

  let sock = null
  let me = {}
  let pairRequested = false

  // --- cc-connect's bridge ------------------------------------------------------------------------------------
  let bridge = null
  const toBridge = (o) => { if (bridge?.readyState === WebSocket.OPEN) bridge.send(JSON.stringify(o)) }
  function connectBridge(delay = 1000) {
    const ws = new WebSocket(process.env.WA_BRIDGE_URL, { headers: { Authorization: `Bearer ${process.env.WA_BRIDGE_TOKEN}` } })
    ws.on('open', () => {
      bridge = ws
      ws.send(JSON.stringify({ type: 'register', platform: 'whatsapp', capabilities: ['text', 'typing'],
        metadata: { version: '1', description: 'cage WhatsApp adapter' } }))
    })
    ws.on('message', async (raw) => {
      let m
      try { m = JSON.parse(raw) } catch { return }
      if (m.type === 'register_ack') return log(m.ok ? 'bridge connected' : `bridge refused: ${m.error}`)
      if (!sock) return
      const jid = m.reply_ctx
      try {
        if (m.type === 'reply' && jid && m.content) {
          const text = MODE === 'own' ? `${MARK} ${toWhatsApp(m.content)}` : toWhatsApp(m.content)
          const r = await sock.sendMessage(jid, { text })
          remember(r?.key?.id)
        } else if (m.type === 'typing_start' && jid) {
          await sock.sendPresenceUpdate('composing', jid)
        } else if (m.type === 'typing_stop' && jid) {
          await sock.sendPresenceUpdate('paused', jid)
        }
      } catch (e) { log('send failed:', e?.message || e) }
    })
    ws.on('close', () => { if (bridge === ws) bridge = null; setTimeout(() => connectBridge(Math.min(delay * 2, 30000)), delay) })
    ws.on('error', () => {})
  }
  setInterval(() => toBridge({ type: 'ping', ts: Date.now() }), 30000)

  // --- WhatsApp -----------------------------------------------------------------------------------------------
  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, 'auth'))
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
        me = { pn: jidNormalizedUser(sock.user?.id), lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : '' }
        status({ state: 'linked', me: digits(me.pn), mode: MODE })
        log(`linked as +${digits(me.pn)} (${MODE} number)`)
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          log('logged out from the phone; link again with: cage chat link whatsapp')
          status({ state: 'logged-out' })
          fs.rmSync(path.join(DIR, 'auth'), { recursive: true, force: true })
          fs.rmSync(path.join(DIR, 'pair'), { force: true })
          process.exit(3)
        }
        setTimeout(connect, code === DisconnectReason.restartRequired ? 0 : 3000)
      }
    })
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        const ok = accept(m, { mode: MODE, allow: ALLOW, me, sent, since, mark: MARK })
        if (!ok) continue
        sock.readMessages([m.key]).catch(() => {})
        toBridge({ type: 'message', msg_id: m.key.id, session_key: `whatsapp:${digits(ok.chat)}:${ok.user}`,
          user_id: ok.user, user_name: m.pushName || ok.user, content: textOf(m), reply_ctx: ok.chat })
      }
    })
  }

  connectBridge()
  await connect()
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('cage-whatsapp:', e); process.exit(1) })
