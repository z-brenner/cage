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
import { accept, textOf, audioOf, digits, toWhatsApp, sinceOf, Backlog } from '../guest/whatsapp.mjs'
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

// --- the adapter itself, against a stand-in for cc-connect's bridge and a stub Baileys ----------------------------
// It runs as whatsapp.sh runs it: a copy of guest/whatsapp.mjs next to node_modules (here the stubs in
// test/fixtures/whatsapp-modules). The test plays WhatsApp's side through the stub, over the fork's IPC channel.
const SPARE = '15552223333@s.whatsapp.net'
const nowS = () => Math.floor(Date.now() / 1000)
const wamsg = (id, text, ts = nowS(), jid = SPARE) => ({ key: { id, remoteJid: jid }, message: { conversation: text }, messageTimestamp: ts })

async function adapter (t, { ack = true, state, pair } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cage-wa-')))
  const app = path.join(tmp, 'app')
  const dir = path.join(tmp, 'wa')
  fs.mkdirSync(app)
  fs.mkdirSync(dir)
  fs.copyFileSync(fileURLToPath(new URL('../guest/whatsapp.mjs', import.meta.url)), path.join(app, 'adapter.mjs'))
  fs.symlinkSync(fileURLToPath(new URL('./fixtures/whatsapp-modules', import.meta.url)), path.join(app, 'node_modules'))
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  if (pair) fs.writeFileSync(path.join(dir, 'pair'), pair)
  const bridge = await fakeBridge({ ack })
  const child = fork(path.join(app, 'adapter.mjs'), [], {
    execArgv: nodeFlags,
    env: { PATH: process.env.PATH, WA_DIR: dir, WA_MODE: 'spare', WA_ALLOW: '15552223333', WA_NAME: 'Claude',
      WA_BRIDGE_URL: bridge.url, WA_BRIDGE_TOKEN: 'tok123' },
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
    open: async () => {
      await a.call('socket')
      a.wa({ user: { id: '15550001111:7@s.whatsapp.net' } })
      a.wa({ emit: 'connection.update', data: { connection: 'open' } })
      await until(() => /linked as/.test(output), 5000, 'the link')
    },
    upsert: (messages, type = 'notify') => a.wa({ emit: 'messages.upsert', data: { type, messages } }),
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
  await a.open()
  await until(() => a.called('sendMessage').length === 2, 3000, 'the replies')
  assert.deepEqual(a.called('sendMessage'), [{ jid: SPARE, text: '*one*' }, { jid: SPARE, text: 'two' }])
})

test('a linking code that ran out is replaced with a fresh one, and status.json is replaced whole', async (t) => {
  const a = await adapter(t, { pair: '15550001111' })
  await a.call('socket')
  a.wa({ emit: 'connection.update', data: { qr: 'ref-1' } })
  await until(() => a.status()?.code === 'CODE1', 3000, 'the first code')
  const first = fs.statSync(path.join(a.dir, 'status.json')).ino
  // WhatsApp gives up on the code: the connection closes and the adapter connects again
  a.wa({ emit: 'connection.update', data: { connection: 'close', lastDisconnect: { error: { message: 'QR refs attempts ended', output: { statusCode: 408 } } } } })
  const again = await a.call('socket', () => a.called('socket').length >= 2, 6000)
  assert.equal(again.creds.me, undefined, 'the half-made link is dropped, so WhatsApp is asked for a new code')
  a.wa({ emit: 'connection.update', data: { qr: 'ref-2' } })
  await until(() => a.status()?.code === 'CODE2', 3000, 'a fresh code')
  await a.call('requestPairingCode', (x) => x.code === 'CODE2')   // the stub's report can come after the file
  assert.deepEqual(a.called('requestPairingCode').map((c) => c.phone), ['15550001111', '15550001111'])
  assert.notEqual(fs.statSync(path.join(a.dir, 'status.json')).ino, first, 'written to a new file and renamed into place')
  assert.ok(!fs.existsSync(path.join(a.dir, 'status.json.tmp')))
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
