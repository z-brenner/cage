// Tests for the WhatsApp adapter, without WhatsApp: its rules (who may reach the agent), and the adapter itself run
// against stand-ins for cc-connect's bridge and Baileys.
//   node --test test/whatsapp.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accept, textOf, audioOf, digits, toWhatsApp, sinceOf, Backlog, linking } from '../guest/whatsapp.mjs'
import { fakeBridge, nodeFlags, until } from './fixtures/fake-bridge.mjs'

const me = { pn: '15550001111@s.whatsapp.net', lid: '987654321@lid' }
const base = { mode: 'spare', allow: ['15552223333'], me, sent: new Set(), since: 1000, mark: '[•|•] Claude:' }
const msg = (key, text = 'hi', ts = 2000) => ({ key: { id: 'M1', ...key }, message: { conversation: text }, messageTimestamp: ts })

test('spare number: only the allowed phone number gets through', () => {
  assert.deepEqual(accept(msg({ remoteJid: '15552223333@s.whatsapp.net' }), base), { chat: '15552223333@s.whatsapp.net', user: '15552223333' })
  assert.equal(accept(msg({ remoteJid: '15559999999@s.whatsapp.net' }), base), null)
})

test('spare number: privacy ids (LIDs) are matched through the phone-number alternative', () => {
  const m = msg({ remoteJid: '111222@lid', remoteJidAlt: '15552223333@s.whatsapp.net' })
  assert.deepEqual(accept(m, base), { chat: '111222@lid', user: '15552223333' })
  assert.equal(accept(msg({ remoteJid: '111222@lid' }), base), null)   // no phone number known: refused
})

test('spare number: ignores its own messages, groups, broadcasts, history and non-text', () => {
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net', fromMe: true }), base), null)
  assert.equal(accept(msg({ remoteJid: '123-456@g.us', participant: '15552223333@s.whatsapp.net' }), base), null)
  assert.equal(accept(msg({ remoteJid: 'status@broadcast' }), base), null)
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net' }, 'old', 10), base), null)
  assert.equal(accept({ key: { id: 'X', remoteJid: '15552223333@s.whatsapp.net' }, message: { stickerMessage: {} } }, base), null)
  const sent = new Set(['M1'])
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net' }), { ...base, sent }), null)
})

test('own number: only the "Message yourself" chat, only messages the owner sent', () => {
  const own = { ...base, mode: 'own', allow: [] }
  assert.deepEqual(accept(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }), own), { chat: '15550001111@s.whatsapp.net', user: 'me' })
  assert.deepEqual(accept(msg({ remoteJid: '987654321@lid', fromMe: true }), own), { chat: '987654321@lid', user: 'me' })
  assert.equal(accept(msg({ remoteJid: '15552223333@s.whatsapp.net', fromMe: true }), own), null)   // a chat with someone else
  assert.equal(accept(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: false }), own), null)
  assert.equal(accept(msg({ remoteJid: '15550001111@s.whatsapp.net', fromMe: true }, '[•|•] Claude: done'), own), null)
})

test('timestamps can be protobuf Longs', () => {
  const long = { low: 2000, high: 0, toNumber() { return 2000 } }
  assert.ok(accept({ ...msg({ remoteJid: '15552223333@s.whatsapp.net' }), messageTimestamp: long }, base))
})

test('helpers', () => {
  assert.equal(digits('15550001111:12@s.whatsapp.net'), '15550001111')
  assert.equal(textOf({ message: { extendedTextMessage: { text: 'x' } } }), 'x')
  assert.equal(textOf({ message: { imageMessage: { caption: 'look' } } }), 'look')
  assert.equal(toWhatsApp('**bold** and ~~gone~~\n## Title'), '*bold* and ~gone~\n*Title*')
})

test('voice notes get through from the same people text does, and nobody else', () => {
  const voice = (key) => ({ key: { id: 'V1', ...key }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 4, ptt: true } }, messageTimestamp: 2000 })
  assert.equal(audioOf(voice({ remoteJid: 'x' })).seconds, 4)
  assert.deepEqual(accept(voice({ remoteJid: '15552223333@s.whatsapp.net' }), base), { chat: '15552223333@s.whatsapp.net', user: '15552223333' })
  assert.equal(accept(voice({ remoteJid: '15559999999@s.whatsapp.net' }), base), null)
  assert.equal(audioOf(msg({ remoteJid: 'x' })), null)
})

test('where new messages start: the last time it was connected, at most a day back; a first link takes 30 s', () => {
  const now = 1_800_000_000_000
  assert.equal(sinceOf({ lastAlive: now - 3600e3 }, now), (now - 3600e3) / 1000)
  assert.equal(sinceOf({ lastAlive: now - 3 * 86400e3 }, now), (now - 86400e3) / 1000)
  assert.equal(sinceOf({}, now), (now - 30e3) / 1000)
  assert.equal(sinceOf({ lastAlive: 'junk' }, now), (now - 30e3) / 1000)
  assert.equal(sinceOf({ lastAlive: now + 3600e3 }, now), now / 1000)   // a clock that jumped back
})

test('messages waiting for a connection: at most 50, none older than 10 minutes, in order', () => {
  const q = new Backlog()
  for (let i = 0; i < 52; i++) q.push(i, 0)
  assert.equal(q.size, 50)
  assert.deepEqual(q.take(60e3).slice(0, 2), [2, 3])
  assert.equal(q.dropped, 2)
  q.push('old', 0)
  q.push('new', 9 * 60e3)
  assert.deepEqual(q.take(11 * 60e3), ['new'])
  assert.equal(q.size, 0)
})

test('messages waiting for a connection: at most 50 MB in all, the oldest going first', () => {
  const q = new Backlog(50, 600e3, 100)
  for (const x of ['a', 'b', 'c']) q.push(x, 0, 40)
  q.push('huge', 0, 500)   // bigger than all the room there is: only it goes
  assert.deepEqual(q.take(0), ['b', 'c'])
  assert.equal(q.dropped, 2)
  q.push('d', 0, 90)
  assert.deepEqual(q.take(0), ['d'], 'the room is all free again once the queue is emptied')
  assert.equal(new Backlog().maxBytes, 50 * 1024 * 1024)
})

test('linking codes are asked for only in the 10 minutes after `cage chat link` wrote the number', () => {
  const now = 1_800_000_000_000
  assert.ok(linking(now - 9 * 60e3, now))
  assert.ok(!linking(now - 10 * 60e3, now))
  assert.ok(!linking(now - 3 * 86400e3, now))
  assert.ok(linking(now + 30e3, now), 'a clock a little off')
  assert.ok(!linking(now + 3600e3, now), 'a file from the future: the clock moved')
})

// --- the adapter itself, against a stand-in for cc-connect's bridge and a stub Baileys ----------------------------
// It runs as whatsapp.sh runs it: a copy of guest/whatsapp.mjs next to node_modules (here the stubs in
// test/fixtures/whatsapp-modules). The test plays WhatsApp's side through the stub, over the fork's IPC channel.
const SPARE = '15552223333@s.whatsapp.net'
const nowS = () => Math.floor(Date.now() / 1000)
const wamsg = (id, text, ts = nowS(), jid = SPARE) => ({ key: { id, remoteJid: jid }, message: { conversation: text }, messageTimestamp: ts })

async function adapter (t, { ack = true, state, pair, pairAge = 0, env = {} } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cage-wa-')))
  const app = path.join(tmp, 'app')
  const dir = path.join(tmp, 'wa')
  fs.mkdirSync(app)
  fs.mkdirSync(dir)
  fs.copyFileSync(fileURLToPath(new URL('../guest/whatsapp.mjs', import.meta.url)), path.join(app, 'adapter.mjs'))
  fs.symlinkSync(fileURLToPath(new URL('./fixtures/whatsapp-modules', import.meta.url)), path.join(app, 'node_modules'))
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  if (pair) {
    fs.writeFileSync(path.join(dir, 'pair'), pair)
    const at = new Date(Date.now() - pairAge)
    fs.utimesSync(path.join(dir, 'pair'), at, at)
  }
  const bridge = await fakeBridge({ ack })
  const child = fork(path.join(app, 'adapter.mjs'), [], {
    execArgv: nodeFlags,
    env: { PATH: process.env.PATH, WA_DIR: dir, WA_MODE: 'spare', WA_ALLOW: '15552223333', WA_NAME: 'Claude',
      WA_BRIDGE_URL: bridge.url, WA_BRIDGE_TOKEN: 'tok123', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const calls = []
  child.on('message', (m) => calls.push(m))
  t.after(async () => {
    child.kill()
    await bridge.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const a = {
    dir, bridge, child, calls,
    output: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
    called: (name) => calls.filter((c) => c.call === name).map((c) => c.args),
    call: (name, pred = () => true, ms = 5000) => until(() => calls.find((c) => c.call === name && pred(c.args))?.args, ms, `a call to ${name}`),
    wa: (cmd) => child.send(cmd),   // WhatsApp's side
    open: async (n = 1) => { // the nth connection to WhatsApp opens, linked
      await until(() => a.called('socket')[n - 1], 6000, `connection ${n} to WhatsApp`)
      a.wa({ user: { id: '15550001111:7@s.whatsapp.net' } })
      a.wa({ emit: 'connection.update', data: { connection: 'open' } })
      await until(() => (output.match(/linked as/g) || []).length >= n, 5000, 'the link')
    },
    close: (statusCode = 408, message = 'Connection lost') =>
      a.wa({ emit: 'connection.update', data: { connection: 'close', lastDisconnect: { error: { message, output: { statusCode } } } } }),
    upsert: (messages, type = 'notify') => a.wa({ emit: 'messages.upsert', data: { type, messages } }),
    saved: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).lastAlive } catch { return 0 } },
    status: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')) } catch { return null } }
  }
  return a
}

test("cc-connect's bridge: it registers with its token, and after a drop it comes straight back", async (t) => {
  const a = await adapter(t)
  for (let n = 1; n <= 4; n++) {
    await until(() => a.bridge.conns.length >= n && a.bridge.conns[n - 1].frames.length, 8000, `connection ${n}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    a.bridge.conns[n - 1].close()
  }
  assert.equal(a.bridge.conns[0].headers.authorization, 'Bearer tok123')
  assert.equal(a.bridge.conns[0].frames[0].platform, 'whatsapp')
  const at = a.bridge.conns.map((c) => c.at)
  // about 1 s each time; a delay that kept doubling would make these 2 s and 4 s (slack for a busy test machine)
  for (let i = 2; i < 4; i++) assert.ok(at[i] - at[i - 1] < 2500, `reconnect ${i} took ${at[i] - at[i - 1]} ms`)
})

test('while nothing answers (cc-connect restarting), it keeps trying, and messages wait for it', async (t) => {
  const a = await adapter(t)
  await a.open()
  await until(() => /bridge connected/.test(a.output()), 5000, 'the bridge')
  await a.bridge.down()
  await new Promise((resolve) => setTimeout(resolve, 2500))   // its first tries find nothing there
  a.upsert([wamsg('M1', 'are you back?')])
  await a.bridge.up()
  const m = await a.bridge.frame((f) => f.type === 'message', 10000)
  assert.equal(m.msg_id, 'M1')
  await a.call('readMessages', (ids) => ids.includes('M1'))
})

test('messages wait while cc-connect is away, then go in order, and only then show as read', async (t) => {
  const a = await adapter(t, { ack: false })
  await a.open()
  await a.bridge.frame((m) => m.type === 'register')
  a.upsert([wamsg('M1', 'first')])
  a.upsert([wamsg('M2', 'second')])
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(a.called('readMessages'), [], 'no blue ticks for a message the agent hasn\'t got')
  assert.equal(a.bridge.frames().filter((m) => m.type === 'message').length, 0)

  a.bridge.last().ack()
  await a.bridge.frame((m) => m.type === 'message' && m.content === 'second')
  assert.deepEqual(a.bridge.frames().filter((m) => m.type === 'message').map((m) => m.msg_id), ['M1', 'M2'])
  const m1 = a.bridge.frames().find((m) => m.msg_id === 'M1')
  assert.equal(m1.session_key, 'whatsapp:15552223333:15552223333')
  assert.equal(m1.reply_ctx, SPARE)
  await until(() => a.called('readMessages').flat().includes('M2'), 3000, 'read receipts')
  assert.deepEqual(a.called('readMessages').flat(), ['M1', 'M2'])
})

test('messages sent while it was away still reach the agent; older ones and strangers do not', async (t) => {
  const a = await adapter(t, { state: { lastAlive: Date.now() - 2 * 3600e3 } })
  await a.open()
  await a.bridge.frame((m) => m.type === 'register')
  await until(() => /bridge connected/.test(a.output()), 5000, 'the bridge')
  a.upsert([wamsg('OLD', 'from before it went away', nowS() - 3 * 3600),
    wamsg('AWAY', 'sent while it slept', nowS() - 3600),
    wamsg('STRANGER', 'hi', nowS() - 60, '15559999999@s.whatsapp.net')], 'append')
  a.upsert([wamsg('NOW', 'and now')])
  await a.bridge.frame((m) => m.msg_id === 'NOW')
  assert.deepEqual(a.bridge.frames().filter((m) => m.type === 'message').map((m) => m.msg_id), ['AWAY', 'NOW'])
  const saved = JSON.parse(fs.readFileSync(path.join(a.dir, 'state.json'), 'utf8'))
  assert.ok(Date.now() - saved.lastAlive < 10e3, 'the time it connected is saved for next time')
})

test('the first link only takes messages from the last 30 seconds', async (t) => {
  const a = await adapter(t)
  await a.open()
  await until(() => /bridge connected/.test(a.output()), 5000, 'the bridge')
  a.upsert([wamsg('HOUR', 'an hour ago', nowS() - 3600)], 'append')
  a.upsert([wamsg('NOW', 'now')])
  await a.bridge.frame((m) => m.msg_id === 'NOW')
  assert.deepEqual(a.bridge.frames().filter((m) => m.type === 'message').map((m) => m.msg_id), ['NOW'])
})

test('replies wait while WhatsApp reconnects, then go out in order', async (t) => {
  const a = await adapter(t)
  await a.call('socket')
  await until(() => /bridge connected/.test(a.output()), 5000, 'the bridge')
  const c = a.bridge.last()
  c.send({ type: 'reply', session_key: 'whatsapp:15552223333:15552223333', reply_ctx: SPARE, content: '**one**' })
  c.send({ type: 'typing_start', session_key: 'whatsapp:15552223333:15552223333', reply_ctx: SPARE })
  c.send({ type: 'reply', session_key: 'whatsapp:15552223333:15552223333', reply_ctx: SPARE, content: 'two' })
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(a.called('sendMessage'), [], 'nothing is sent before WhatsApp is connected')
  assert.deepEqual(a.called('presence'), [], 'not even "typing…"')
  await a.open()
  await until(() => a.called('sendMessage').length === 2, 3000, 'the replies')
  assert.deepEqual(a.called('sendMessage'), [{ jid: SPARE, text: '*one*' }, { jid: SPARE, text: 'two' }])
  c.send({ type: 'typing_start', session_key: 'whatsapp:15552223333:15552223333', reply_ctx: SPARE })
  assert.deepEqual(await a.call('presence'), { state: 'composing', jid: SPARE })
})

test('a reply the connection drops under is sent again once WhatsApp is back', async (t) => {
  const a = await adapter(t)
  await a.open()
  await until(() => /bridge connected/.test(a.output()), 5000, 'the bridge')
  a.wa({ holdSends: true })
  await a.call('holding')   // the stub has it (the reply comes another way, over the bridge)
  a.bridge.last().send({ type: 'reply', session_key: 'whatsapp:15552223333:15552223333', reply_ctx: SPARE, content: 'one' })
  await a.call('sendHeld')
  a.close()
  a.wa({ failSends: 'Connection Closed' })
  await a.open(2)
  assert.deepEqual(await a.call('sendMessage'), { jid: SPARE, text: 'one' })
  assert.doesNotMatch(a.output(), /send failed/)
})

test('while someone is linking, a code that ran out is asked for again: the same code, so the one shown still works', async (t) => {
  const a = await adapter(t, { pair: '15550001111' })
  await a.call('socket')
  a.wa({ emit: 'connection.update', data: { qr: 'ref-1' } })
  await until(() => a.status()?.code === 'C0DE0001', 3000, 'the first code')
  const first = fs.statSync(path.join(a.dir, 'status.json')).ino
  // WhatsApp gives up on the code: the connection closes and the adapter connects again
  a.close(408, 'QR refs attempts ended')
  const again = await until(() => a.called('socket')[1], 6000, 'a second connection')
  assert.equal(again.creds.me, undefined, 'the half-made link is dropped, so WhatsApp lets it link again')
  a.wa({ emit: 'connection.update', data: { qr: 'ref-2' } })
  await until(() => a.called('requestPairingCode').length === 2, 3000, 'the code asked for again')
  assert.deepEqual(a.called('requestPairingCode'), [{ phone: '15550001111', code: 'C0DE0001' },
    { phone: '15550001111', custom: 'C0DE0001', code: 'C0DE0001' }])
  await until(() => fs.statSync(path.join(a.dir, 'status.json')).ino !== first, 3000, 'status.json written again')
  assert.deepEqual(a.status().code, 'C0DE0001')
  assert.ok(!fs.existsSync(path.join(a.dir, 'status.json.tmp')), 'written to a new file and renamed into place')
})

test('ten minutes after `cage chat link` wrote the number, no more codes (each one prompts the phone): the QR instead', async (t) => {
  const a = await adapter(t, { pair: '15550001111', pairAge: 9 * 60e3 })
  await a.call('socket')
  a.wa({ emit: 'connection.update', data: { qr: 'ref-1' } })
  await until(() => a.status()?.code === 'C0DE0001', 3000, 'the code')
  const old = new Date(Date.now() - 11 * 60e3)   // a minute or two later
  fs.utimesSync(path.join(a.dir, 'pair'), old, old)
  for (let n = 2; n <= 3; n++) {   // nobody linked: the connection closes and comes back, again and again
    a.close(408, 'QR refs attempts ended')
    await until(() => a.called('socket')[n - 1], 10000, `connection ${n}`)
    a.wa({ emit: 'connection.update', data: { qr: `ref-${n}` } })
    await until(() => a.status()?.qr === `ref-${n}`, 3000, `the QR, ref-${n}`)
  }
  assert.equal(a.called('requestPairingCode').length, 1)
  assert.deepEqual(a.called('noQr'), [])
})

test('an old pair file from an earlier try leaves the QR alone', async (t) => {
  const a = await adapter(t, { pair: '15550001111', pairAge: 3 * 86400e3 })
  await a.call('socket')
  a.wa({ emit: 'connection.update', data: { qr: 'ref-1' } })
  await until(() => a.status()?.qr === 'ref-1', 3000, 'the QR')
  assert.deepEqual(a.called('requestPairingCode'), [])
})

test('when it was last connected is saved every minute while connected, and when the connection drops', async (t) => {
  const a = await adapter(t, { env: { WA_ALIVE_MS: '200' } })
  await a.open()
  const opened = a.saved()
  assert.ok(opened, 'saved when it connects')
  await until(() => a.saved() > opened, 3000, 'state.json saved again while connected')
  const b = await adapter(t)   // the usual minute: only the drop saves it again here
  await b.open()
  const before = b.saved()
  await new Promise((resolve) => setTimeout(resolve, 20))
  b.close()
  await until(() => b.saved() > before, 3000, 'state.json saved when the connection drops')
})

test('logged out from the phone: it forgets the link and stops', async (t) => {
  const a = await adapter(t, { pair: '15550001111' })
  await a.open()
  fs.writeFileSync(path.join(a.dir, 'auth', 'creds.json'), '{}')
  a.close(401, 'Intentional Logout')
  await until(() => !a.alive(), 5000, 'the adapter to stop')
  assert.equal(a.child.exitCode, 3)
  assert.deepEqual(a.status().state, 'logged-out')
  for (const f of ['auth', 'pair', 'state.json']) assert.ok(!fs.existsSync(path.join(a.dir, f)), `${f} removed`)
})

test('a frame from the bridge that is not a message object does not stop it', async (t) => {
  const a = await adapter(t)
  await a.open()
  await until(() => /bridge connected/.test(a.output()), 5000, 'the bridge')
  a.bridge.last().send('null')
  a.bridge.last().send({ type: 'reply', reply_ctx: SPARE, content: 'still here' })
  await a.call('sendMessage', (x) => x.text === 'still here')
  assert.ok(a.alive())
})
