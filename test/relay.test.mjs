// The app's chat relay (guest/app.mjs), run for real against a stand-in for cc-connect's bridge
// (test/fixtures/fake-bridge.mjs), with its shared folder and the agent's work folder in a temp dir.
//   node --test test/relay.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeBridge, until } from './fixtures/fake-bridge.mjs'

const APP = fileURLToPath(new URL('../guest/app.mjs', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const closedPort = async () => { // a port nothing listens on: cc-connect's management API, while it's down
  const s = http.createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address()
  await new Promise((resolve) => s.close(resolve))
  return port
}

// Starts the relay. Returns helpers to look at what it did: the bridge, its log, its answers, its output.
async function relay (t, { ack = true, mgmt, before = () => {} } = {}) {
  mgmt = mgmt || `http://127.0.0.1:${await closedPort()}`
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cage-relay-')))
  const dir = path.join(tmp, 'app')
  const work = path.join(tmp, 'work')
  for (const d of [work, ...['in', 'out', 'files'].map((s) => path.join(dir, s))]) fs.mkdirSync(d, { recursive: true })
  before(dir, work)
  const bridge = await fakeBridge({ ack })
  const child = spawn(process.execPath, [APP], {
    env: { PATH: process.env.PATH, APP_DIR: dir, APP_WORK: work, APP_TOKEN: 'abc123', APP_BRIDGE_URL: bridge.url, APP_MGMT_URL: mgmt },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  t.after(async () => {
    child.kill()
    await bridge.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  let n = 0
  const r = {
    dir, work, bridge, child,
    output: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
    log: () => {
      try { return fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
    },
    // what the app does: a request in in/, written then renamed, as host/ui/server.py does
    request: (req) => {
      const id = `${String(++n).padStart(4, '0')}-test`
      const f = path.join(dir, 'in', `${id}.json`)
      fs.writeFileSync(path.join(dir, 'in', `.${id}.tmp`), JSON.stringify({ id, ...req }))
      fs.renameSync(path.join(dir, 'in', `.${id}.tmp`), f)
      return id
    },
    answer: (id, ms = 5000) => until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'out', `${id}.json`), 'utf8')) } catch { return null }
    }, ms, `the answer to ${id}`),
    logged: (pred, ms = 5000) => until(() => r.log().find(pred), ms, 'a line in the chat log')
  }
  return r
}

test('registers with every capability it handles, video included, and its token', async (t) => {
  const r = await relay(t)
  const reg = await r.bridge.frame((m) => m.type === 'register')
  assert.equal(reg.platform, 'app')
  for (const c of ['text', 'image', 'file', 'audio', 'video', 'card', 'buttons', 'typing', 'update_message', 'preview', 'delete_message']) {
    assert.ok(reg.capabilities.includes(c), `capability ${c}`)
  }
  assert.match(r.bridge.last().url, /^\/bridge\/ws\?token=abc123$/)
  await r.logged((e) => e.t === 'status' && e.connected === true)
})

test('a message with files reaches cc-connect, the files in base64', async (t) => {
  const r = await relay(t)
  await r.bridge.frame((m) => m.type === 'register')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  fs.writeFileSync(path.join(r.dir, 'files', '1700000000000-ab12-pic.png'), png)
  fs.writeFileSync(path.join(r.dir, 'files', '1700000000001-cd34-notes.txt'), 'hello')
  const id = r.request({ type: 'message', session: 'you', text: 'look at these', files: [
    { path: 'files/1700000000000-ab12-pic.png', name: 'pic.png', mime: 'image/png' },
    { path: 'files/1700000000001-cd34-notes.txt', name: 'notes.txt', mime: 'text/plain' }] })
  const m = await r.bridge.frame((f) => f.type === 'message')
  assert.equal(m.content, 'look at these')
  assert.equal(m.session_key, 'app:you:you')
  assert.equal(m.reply_ctx, id)
  assert.deepEqual(m.images, [{ mime_type: 'image/png', data: png.toString('base64'), file_name: 'pic.png' }])
  assert.deepEqual(m.files, [{ mime_type: 'text/plain', data: Buffer.from('hello').toString('base64'), file_name: 'notes.txt' }])
  const you = await r.logged((e) => e.t === 'you')
  assert.deepEqual(you.files.map((f) => f.name), ['pic.png', 'notes.txt'])
  assert.ok(!fs.existsSync(path.join(r.dir, 'in', `${id}.json`)), 'the request is removed once sent')
})

test('previews: acknowledged, updates written at most every 600 ms, and the last words come before the reply', async (t) => {
  const r = await relay(t)
  await r.bridge.frame((m) => m.type === 'register')
  const c = r.bridge.last()
  c.send({ type: 'preview_start', ref_id: 'r1', session_key: 'app:you:you', reply_ctx: 'c1', content: 'Thinking' })
  const ack = await r.bridge.frame((m) => m.type === 'preview_ack' && m.ref_id === 'r1')
  assert.ok(ack.preview_handle)
  const h = ack.preview_handle
  for (const n of [1, 2, 3, 4, 5]) c.send({ type: 'update_message', session_key: 'app:you:you', preview_handle: h, content: `u${n}` })
  c.send({ type: 'reply', session_key: 'app:you:you', reply_ctx: 'c1', content: 'Done.', format: 'markdown' })
  await r.logged((e) => e.t === 'reply')
  const seq = r.log().filter((e) => ['preview', 'update', 'reply'].includes(e.t)).map((e) => e.t === 'update' ? e.text : e.t)
  assert.deepEqual(seq, ['preview', 'u1', 'u5', 'reply'])

  c.send({ type: 'preview_start', ref_id: 'r2', session_key: 'app:you:you', reply_ctx: 'c2', content: '' })
  const h2 = (await r.bridge.frame((m) => m.type === 'preview_ack' && m.ref_id === 'r2')).preview_handle
  c.send({ type: 'update_message', session_key: 'app:you:you', preview_handle: h2, content: 'v1' })
  c.send({ type: 'update_message', session_key: 'app:you:you', preview_handle: h2, content: 'v2' })
  c.send({ type: 'delete_message', session_key: 'app:you:you', preview_handle: h2 })
  await r.logged((e) => e.t === 'delete')
  assert.deepEqual(r.log().filter((e) => e.handle === h2).map((e) => e.text ?? e.t), ['', 'v1', 'v2', 'delete'])
})

test('after cc-connect drops it, it reconnects within about a second each time', async (t) => {
  const r = await relay(t)
  for (let n = 1; n <= 4; n++) {
    await until(() => r.bridge.conns.length >= n && r.bridge.conns[n - 1].frames.length, 8000, `connection ${n}`)
    await sleep(50)
    r.bridge.conns[n - 1].close()
  }
  const at = r.bridge.conns.map((c) => c.at)
  // about 1 s each time; a delay that kept doubling would make these 2 s and 4 s (slack for a busy test machine)
  for (let i = 2; i < 4; i++) assert.ok(at[i] - at[i - 1] < 2500, `reconnect ${i} took ${at[i] - at[i - 1]} ms`)
  await r.logged((e) => e.t === 'status' && e.connected === false)
})

test("a frame that isn't a message object, or that breaks the handler, doesn't stop it", async (t) => {
  const r = await relay(t)
  await r.bridge.frame((m) => m.type === 'register')
  const c = r.bridge.last()
  for (const bad of ['null', '42', '"text"', '[]', 'not json']) c.send(bad)
  // a reply_ctx that can't be turned into text makes the handler throw
  c.send({ type: 'reply', session_key: 'app:you:you', reply_ctx: { toString: 1 }, content: 'x' })
  c.send({ type: 'reply', session_key: 'app:you:you', reply_ctx: 'c9', content: 'still here' })
  await r.logged((e) => e.t === 'reply' && e.text === 'still here')
  assert.ok(r.alive(), 'still running')
  assert.match(r.output(), /bad frame from cc-connect/)
  assert.equal(r.bridge.conns.length, 1, 'no reconnect: it never went down')
})

test("a write that fails is reported once, and the relay keeps going", async (t) => {
  // log.jsonl as a folder: every write to it fails, as on a full disk
  const r = await relay(t, { before: (dir) => fs.mkdirSync(path.join(dir, 'log.jsonl')) })
  await r.bridge.frame((m) => m.type === 'register')
  const c = r.bridge.last()
  for (const n of [1, 2, 3]) c.send({ type: 'reply', session_key: 'app:you:you', reply_ctx: 'c', content: `lost ${n}` })
  c.send({ type: 'file', session_key: 'app:you:you', file_name: 'a.txt', data: Buffer.from('a').toString('base64') })
  await until(() => /couldn't write the chat log/.test(r.output()), 3000, 'the write error')
  await sleep(300)
  assert.ok(r.alive(), 'still running')
  assert.equal(r.output().match(/couldn't write the chat log/g).length, 1, 'said once')
  fs.rmdirSync(path.join(r.dir, 'log.jsonl'))
  c.send({ type: 'reply', session_key: 'app:you:you', reply_ctx: 'c', content: 'back' })
  await r.logged((e) => e.t === 'reply' && e.text === 'back')
})

test('the work folder and scheduled tasks are answered while messages wait for cc-connect, and messages keep their order', async (t) => {
  const mgmt = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, path: req.url, auth: req.headers.authorization })))
  await new Promise((resolve) => mgmt.listen(0, '127.0.0.1', resolve))
  t.after(() => mgmt.close())
  const r = await relay(t, { ack: false, mgmt: `http://127.0.0.1:${mgmt.address().port}` })
  await r.bridge.frame((m) => m.type === 'register')   // registered, but cc-connect hasn't said yes yet
  fs.writeFileSync(path.join(r.work, 'report.txt'), 'q3')
  const first = r.request({ type: 'message', text: 'first' })
  const press = r.request({ type: 'action', action: 'perm:allow', label: 'Allow' })
  const ls = r.request({ type: 'ls', path: '' })
  const second = r.request({ type: 'message', text: 'second' })
  const api = r.request({ type: 'api', method: 'GET', path: '/api/v1/cron?project=claude' })
  const listing = await r.answer(ls)
  assert.deepEqual(listing.entries.map((e) => e.name), ['report.txt'])
  assert.deepEqual(await r.answer(api), { ok: true, path: '/api/v1/cron?project=claude', auth: 'Bearer abc123' })
  await sleep(400)
  for (const id of [first, press, second]) assert.ok(fs.existsSync(path.join(r.dir, 'in', `${id}.json`)), `${id} waits`)
  assert.equal(r.bridge.frames().filter((m) => ['message', 'card_action'].includes(m.type)).length, 0)

  r.bridge.last().ack()
  await r.bridge.frame((m) => m.type === 'message' && m.content === 'second')
  assert.deepEqual(r.bridge.frames().filter((m) => ['message', 'card_action'].includes(m.type)).map((m) => m.content ?? m.action),
    ['first', 'perm:allow', 'second'])
})

test("scheduled tasks get a plain answer at once when cc-connect isn't running", async (t) => {
  const r = await relay(t, { ack: false })
  const id = r.request({ type: 'api', method: 'GET', path: '/api/v1/cron' })
  const a = await r.answer(id, 3000)
  assert.equal(a.ok, false)
  assert.match(a.error, /isn't running right now/)
})

test('a file fetched from the work folder keeps its whole name', async (t) => {
  const r = await relay(t)
  fs.writeFileSync(path.join(r.work, 'q3-results.txt'), 'numbers')
  const a = await r.answer(r.request({ type: 'fetch', path: 'q3-results.txt' }))
  assert.equal(a.ok, true)
  assert.match(a.path, /^files\/\d{13}-[0-9a-f]{4}-q3-results\.txt$/)
  // the name the app shows: it strips one <ms>-<rand>- prefix (host/ui/server.py)
  assert.equal(a.path.slice(6).replace(/^\d+-[0-9a-z]{1,8}-/, ''), 'q3-results.txt')
  assert.equal(fs.readFileSync(path.join(r.dir, a.path), 'utf8'), 'numbers')
})

test('pictures, files and videos from the agent land in files/', async (t) => {
  const r = await relay(t)
  await r.bridge.frame((m) => m.type === 'register')
  r.bridge.last().send({ type: 'video', session_key: 'app:you:you', reply_ctx: 'c', data: Buffer.from('mp4').toString('base64'), format: 'mp4' })
  const e = await r.logged((x) => x.t === 'file')
  assert.equal(e.kind, 'video')
  assert.equal(e.name, 'video.mp4')
  assert.equal(fs.readFileSync(path.join(r.dir, e.path), 'utf8'), 'mp4')
})
