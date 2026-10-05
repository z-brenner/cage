// Stand-in for Baileys in test/whatsapp.test.mjs, which runs the real adapter in a forked process and plays
// WhatsApp's side over its IPC channel. Every call the adapter makes is reported as {call, args}; the test sends
// {user} (who the socket is linked as), {creds} (merged into the saved login) or {emit, data} (an event).
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
export default function makeWASocket ({ auth }) {
  const ev = new EventEmitter()
  sock = {
    ev,
    auth,
    user: undefined,
    // like Baileys: the number the code is for is saved as the account, before anyone has entered the code
    requestPairingCode: async (phone) => {
      auth.creds.me = { id: `${phone}@s.whatsapp.net`, name: '~' }
      ev.emit('creds.update', auth.creds)
      const code = `CODE${++codes}`
      report('requestPairingCode', { phone, code })
      return code
    },
    readMessages: async (keys) => report('readMessages', keys.map((k) => k.id)),
    sendMessage: async (jid, content) => { report('sendMessage', { jid, text: content.text }); return { key: { id: `OUT${++sent}` } } },
    sendPresenceUpdate: async (state, jid) => report('presence', { state, jid }),
    updateMediaMessage: async (m) => m
  }
  report('socket', { creds: JSON.parse(JSON.stringify(auth.creds)) })
  return sock
}

process.on('message', (cmd) => {
  if (cmd.user) sock.user = cmd.user
  if (cmd.creds) Object.assign(sock.auth.creds, cmd.creds)
  if (cmd.emit) sock.ev.emit(cmd.emit, cmd.data)
})
