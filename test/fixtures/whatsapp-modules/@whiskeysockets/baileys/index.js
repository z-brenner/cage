// Stand-in for Baileys in test/whatsapp.test.mjs, which runs the real adapter in a forked process and plays
// WhatsApp's side over its IPC channel. Every call the adapter makes is reported as {call, args}; the test sends
// {user} (who the socket is linked as), {creds} (merged into the saved login), {emit, data} (an event), or
// {holdSends: true} then {failSends: message} (sending hangs, then fails, as when the connection drops under it).
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

export const DisconnectReason = { connectionClosed: 428, connectionLost: 408, timedOut: 408, loggedOut: 401, restartRequired: 515 }
export const Browsers = { ubuntu: (name) => ['Ubuntu', 'Chrome', name] }
export const jidNormalizedUser = (jid) => String(jid || '').replace(/:\d+@/, '@')
export const downloadMediaMessage = async () => Buffer.from('a voice note')
const report = (call, args) => process.send?.({ call, args })

export async function useMultiFileAuthState (dir) {
  let creds = {}
  try { creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')) } catch {}
  return { state: { creds }, saveCreds: async () => fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds)) }
}

let sock = null
let codes = 0
let sent = 0
let held = null   // while sends hang: how to fail them
export default function makeWASocket ({ auth }) {
  const ev = new EventEmitter()
  sock = {
    ev,
    auth,
    user: undefined,
    // Like WhatsApp: a socket that starts with an account number but no keys (a code asked for and never entered)
    // tries to log in with them instead of linking, so it never gets a QR
    noQr: !!(auth.creds.me && !auth.creds.registered),
    // like Baileys: an 8-character code, or the one asked for; the number it's for is saved as the account, before
    // anyone has entered the code
    requestPairingCode: async (phone, custom) => {
      if (custom && custom.length !== 8) throw new Error('Custom pairing code must be exactly 8 chars')
      auth.creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' }
      const code = custom ?? `C0DE${String(++codes).padStart(4, '0')}`
      auth.creds.pairingCode = code
      ev.emit('creds.update', auth.creds)
      report('requestPairingCode', { phone, custom, code })
      return code
    },
    readMessages: async (keys) => report('readMessages', keys.map((k) => k.id)),
    sendMessage: async (jid, content) => {
      if (held) {
        report('sendHeld', { jid, text: content.text })
        await new Promise((resolve, reject) => held.push(reject))
      }
      report('sendMessage', { jid, text: content.text })
      return { key: { id: `OUT${++sent}` } }
    },
    sendPresenceUpdate: async (state, jid) => report('presence', { state, jid }),
    updateMediaMessage: async (m) => m
  }
  report('socket', { creds: JSON.parse(JSON.stringify(auth.creds)) })
  return sock
}

process.on('message', (cmd) => {
  if (cmd.user) sock.user = cmd.user
  if (cmd.creds) Object.assign(sock.auth.creds, cmd.creds)
  if (cmd.holdSends) { held = []; report('holding', {}) }
  if (cmd.failSends) { for (const reject of held || []) reject(new Error(cmd.failSends)); held = null }
  if (cmd.emit === 'connection.update' && cmd.data?.qr && sock.noQr) return report('noQr', {})
  if (cmd.emit) sock.ev.emit(cmd.emit, cmd.data)
})
